"""Pasco County, FL adapter: Property Appraiser bulk files -> parcels and sales.

Source: https://downloads.pascopa.com/ (free, updated weekly). Files used:
  sales.zip           sales_last_10years.csv  - recorded sales with DOR qualification codes
  building.zip        building.csv            - heated sq ft, year built, baths, stories, use
  extrafeatures.zip   extrafeatures.csv       - pools and spas
  parcel.zip          parcel.csv              - acres, just value, neighborhood, homestead
  site_addresses.zip  site_addresses.csv      - street addresses
  pasco_parcels.zip   (shapefile)             - parcel shapes, reduced to center points
Owner files are never downloaded.
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from ..sources import USER_AGENT

BASE = "https://ftp01.pascopa.com/real_estate/"
GIS_URL = "https://ftp01.pascopa.com/gis/pasco_parcels.zip"
FILES = {
    "sales": BASE + "sales.zip",
    "building": BASE + "building.zip",
    "extrafeatures": BASE + "extrafeatures.zip",
    "parcel": BASE + "parcel.zip",
    "site_addresses": BASE + "site_addresses.zip",
    "gis": GIS_URL,
}

# Building use codes kept for residential comps, mapped to a property type.
RES_USE = {"0100": "single_family", "0700": "townhome", "0400": "condo"}

# DOR sale qualification codes (Code_Descriptions.xlsx, "Sale Qualification Codes").
DISTRESSED_CODES = {12, 19, 38}          # financial institution deed, bankruptcy, prevent foreclosure
DISTRESSED_DEEDS = {"CT", "SD", "TX", "FJ", "RD", "MD"}  # certificate of title, sheriff, tax, judgment...
PARCEL_ID = re.compile(r"^\d{2}-\d{2}-\d{2}-\d{4}-\d{5}-\d{4}$")

SUFFIX_ABBR = {
    "RD": "ROAD", "DR": "DRIVE", "LN": "LANE", "AVE": "AVENUE", "AV": "AVENUE", "ST": "STREET",
    "CT": "COURT", "WAY": "WAY", "LOOP": "LOOP", "BLVD": "BOULEVARD", "CIR": "CIRCLE",
    "PL": "PLACE", "TRL": "TRAIL", "TER": "TERRACE", "PKWY": "PARKWAY", "PT": "POINT",
    "CV": "COVE", "SQ": "SQUARE", "HWY": "HIGHWAY", "PATH": "PATH", "RUN": "RUN", "BND": "BEND",
    "PASS": "PASS", "TRCE": "TRACE", "XING": "CROSSING", "RDG": "RIDGE", "HTS": "HEIGHTS",
}


# ---------------------------------------------------------------- download

def download(raw_dir: Path) -> dict[str, Path]:
    import shutil
    import urllib.request

    raw_dir.mkdir(parents=True, exist_ok=True)
    out = {}
    for key, url in FILES.items():
        dest = raw_dir / Path(url).name
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as fh:
            shutil.copyfileobj(r, fh, length=1 << 20)
        out[key] = dest
    return out


def _read_member(zip_path: Path, member_pattern: str, usecols=None) -> pd.DataFrame:
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if re.search(member_pattern, n, re.I)]
        if not names:
            raise FileNotFoundError(f"{member_pattern} not in {zip_path.name}: {z.namelist()}")
        with z.open(names[0]) as fh:
            return pd.read_csv(io.BytesIO(fh.read()), dtype=str, usecols=usecols,
                               encoding="latin-1", low_memory=False)


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.replace(",", "").str.strip(), errors="coerce")


# ---------------------------------------------------------------- addresses

def normalize_address(text: str) -> str:
    """'1295 Montgomery Bell Rd NE' -> '1295 MONTGOMERY BELL ROAD'."""
    t = re.sub(r"[^\w\s]", " ", str(text).upper())
    t = re.sub(r"\b(APT|UNIT|STE|SUITE|#)\b.*$", "", t)
    words = t.split()
    if words and words[-1] in {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}:
        words = words[:-1]
    if words and words[-1] in SUFFIX_ABBR:
        words[-1] = SUFFIX_ABBR[words[-1]]
    return " ".join(words)


def load_addresses(zip_path: Path) -> pd.DataFrame:
    df = _read_member(zip_path, r"site_addresses\.csv$")
    df.columns = [c.upper() for c in df.columns]
    df = df[df["UNIT_IDENTIFIER"].isna() | (df["UNIT_IDENTIFIER"].astype(str).str.strip() == "")] \
        if "UNIT_IDENTIFIER" in df else df
    full = (df["ADDRESS_NUMBER"].fillna("").str.strip() + " " + df["STREET_NAME"].fillna("").str.strip()
            + " " + df["STREET_SUFFIX"].fillna("").str.strip())
    out = pd.DataFrame({
        "parcel_id": df["PARCEL"].str.strip(),
        "address": full.str.replace(r"\s+", " ", regex=True).str.strip().str.title(),
        "address_key": full.map(normalize_address),
        "city": df["CITY"].str.strip().str.title(),
        "zip": df["ZIP_CODE"].str.strip().str[:5],
    })
    return out.drop_duplicates("parcel_id")


# ---------------------------------------------------------------- parcels

def load_buildings(zip_path: Path) -> pd.DataFrame:
    cols = ["Parcel_Num", "Bldg_Num", "Bldg_ActYrBlt", "Bldg_EffYrBlt", "Bldg_Bathrooms",
            "Bldg_Use_Code", "Bldg_Quality", "Bldg_Stories", "Bldg_Heated_Sqft", "Bldg_Total_Sqft"]
    b = _read_member(zip_path, r"building\.csv$", usecols=cols)
    b["Bldg_Use_Code"] = b["Bldg_Use_Code"].str.strip().str.zfill(4)
    b = b[b["Bldg_Use_Code"].isin(RES_USE)]
    for c in ["Bldg_ActYrBlt", "Bldg_EffYrBlt", "Bldg_Bathrooms", "Bldg_Quality",
              "Bldg_Stories", "Bldg_Heated_Sqft", "Bldg_Total_Sqft"]:
        b[c] = _num(b[c])
    # One home per parcel: keep the largest residential building.
    b = b.sort_values("Bldg_Heated_Sqft", ascending=False).drop_duplicates("Parcel_Num")
    return pd.DataFrame({
        "parcel_id": b["Parcel_Num"].str.strip(),
        "property_type": b["Bldg_Use_Code"].map(RES_USE),
        "sqft": b["Bldg_Heated_Sqft"],
        "year_built": b["Bldg_ActYrBlt"].where(b["Bldg_ActYrBlt"] > 1800),
        "eff_year": b["Bldg_EffYrBlt"].where(b["Bldg_EffYrBlt"] > 1800),
        "baths": b["Bldg_Bathrooms"],
        "stories": b["Bldg_Stories"],
        "quality": b["Bldg_Quality"],
    })


def load_features(zip_path: Path) -> pd.DataFrame:
    xf = _read_member(zip_path, r"extrafeatures\.csv$", usecols=["Parcel_Num", "XF_Code"])
    code = xf["XF_Code"].str.strip().str.upper()
    flags = pd.DataFrame({
        "parcel_id": xf["Parcel_Num"].str.strip(),
        "pool": code.str.startswith("RPOOL"),
        "spa": code.eq("RSPA"),
    })
    return flags.groupby("parcel_id", as_index=False).any()


def load_parcel_info(zip_path: Path) -> pd.DataFrame:
    cols = ["Parcel_Num", "Prop_Use_Code", "NBHD_Code", "NBHD_Desc", "Hmstd", "Acres", "Just_Value"]
    p = _read_member(zip_path, r"parcel\.csv$", usecols=cols)
    return pd.DataFrame({
        "parcel_id": p["Parcel_Num"].str.strip(),
        "nbhd": p["NBHD_Code"].str.strip(),
        "nbhd_name": p["NBHD_Desc"].str.strip().str.title(),
        "homestead": p["Hmstd"].str.strip().eq("YES"),
        "lot_acres": _num(p["Acres"]),
        "just_value": _num(p["Just_Value"]),
    })


def parcel_centroids(gis_zip: Path) -> pd.DataFrame:
    """Center point (lat/lon) of each parcel from the county parcel shapefile."""
    import geopandas as gpd

    gdf = gpd.read_file(f"zip://{gis_zip}")
    id_col = None
    for c in gdf.columns:
        if c == "geometry":
            continue
        sample = gdf[c].dropna().astype(str).head(200)
        if len(sample) and sample.str.match(PARCEL_ID.pattern).mean() > 0.8:
            id_col = c
            break
    if id_col is None:
        raise ValueError(f"No parcel-number column found in shapefile: {list(gdf.columns)}")
    if gdf.crs is None:
        gdf = gdf.set_crs(2882)  # NAD83 / Florida West (ftUS), used by Pasco
    pts = gdf.geometry.representative_point().to_crs(4326)
    return pd.DataFrame({"parcel_id": gdf[id_col].astype(str).str.strip(),
                         "lat": pts.y.round(6), "lon": pts.x.round(6)}).drop_duplicates("parcel_id")


def build_parcels(paths: dict[str, Path]) -> pd.DataFrame:
    """Residential parcels with features, address and location."""
    p = load_buildings(paths["building"])
    p = p.merge(load_parcel_info(paths["parcel"]), on="parcel_id", how="left")
    p = p.merge(load_features(paths["extrafeatures"]), on="parcel_id", how="left")
    p[["pool", "spa"]] = p[["pool", "spa"]].fillna(False).astype(bool)
    p = p.merge(load_addresses(paths["site_addresses"]), on="parcel_id", how="left")
    if "gis" in paths and paths["gis"] and Path(paths["gis"]).exists():
        p = p.merge(parcel_centroids(paths["gis"]), on="parcel_id", how="left")
    else:
        p["lat"] = np.nan
        p["lon"] = np.nan
    # Subdivision key: the first four parts of the parcel number (S-T-R-subdivision).
    p["subdivision"] = p["parcel_id"].str.rsplit("-", n=2).str[0]
    return p.reset_index(drop=True)


# ---------------------------------------------------------------- sales

def classify_sales(s: pd.DataFrame) -> pd.Series:
    """'market', 'distressed' or 'non_market' for each sale row.

    Qualified (Q) sales are market sales. Unqualified sales by banks, through
    foreclosure-type deeds, short sales and bankruptcies are kept as distressed
    (the comps engine down-weights them). Everything else is excluded.
    """
    code = pd.to_numeric(s["qual_code"], errors="coerce")
    deed = s["deed_type"].fillna("").str.upper()
    qualified = s["qualified"].fillna("").str.upper().eq("Q")
    distressed = ~qualified & (code.isin(DISTRESSED_CODES) | deed.isin(DISTRESSED_DEEDS))
    out = pd.Series("non_market", index=s.index)
    out[qualified] = "market"
    out[distressed] = "distressed"
    out[s["price"].fillna(0) < 10_000] = "non_market"
    out[s["multi_parcel"]] = "non_market"
    return out


def load_sales(zip_path: Path, since: str = "2016-01-01") -> pd.DataFrame:
    raw = _read_member(zip_path, r"sales_last_10years\.csv$")
    s = pd.DataFrame({
        "parcel_id": raw["Parcel_Num"].str.strip(),
        "date": pd.to_datetime(raw["Sale_Date"], format="%m/%d/%Y", errors="coerce"),
        "price": _num(raw["Sale_Price"]),
        "improved": raw["Sale_VacImp"].str.strip().eq("I"),
        "qual_code": raw["Sale_Qalified_Code"].str.strip(),  # (sic) column name in the source
        "qualified": raw["Sale_Qualified"].str.strip(),
        "deed_type": raw["Sale_Deed_Type"].str.strip(),
        "book_page": raw["Sale_Book"].str.strip() + "/" + raw["Sale_Page"].str.strip(),
    })
    s = s[s["date"].notna() & (s["date"] >= since) & s["improved"]].copy()
    # One deed covering several parcels: the price is for all of them together.
    n = s.groupby(["book_page", "date"])["parcel_id"].transform("nunique")
    s["multi_parcel"] = (n > 1) | pd.to_numeric(s["qual_code"], errors="coerce").eq(5)
    s["sale_class"] = classify_sales(s)
    return s.drop(columns=["improved"]).reset_index(drop=True)


def build_sales(paths: dict[str, Path], parcels: pd.DataFrame) -> pd.DataFrame:
    """Market and distressed residential sales joined to parcel features."""
    s = load_sales(paths["sales"])
    s = s[s["sale_class"].isin(["market", "distressed"])]
    s = s.merge(parcels, on="parcel_id", how="inner")
    s = s[s["sqft"].fillna(0) >= 400]
    s["ppsf"] = s["price"] / s["sqft"]
    # Drop extreme $/sf outliers within each property type (data errors, partial interests).
    q = s.groupby("property_type")["ppsf"].transform(lambda x: x.quantile(0.005))
    r = s.groupby("property_type")["ppsf"].transform(lambda x: x.quantile(0.995))
    s = s[(s["ppsf"] >= q) & (s["ppsf"] <= r)]
    return s.sort_values("date").reset_index(drop=True)
