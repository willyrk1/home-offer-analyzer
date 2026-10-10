"""Write compact county files the browser comps engine reads.

site/data/counties/<county>/
  meta.json            county summary, column lists, ZIP list, export date
  streets.json         street name -> ZIPs (to find which parcel file to load)
  addresses.json       every street's house numbers by ZIP, for address autocomplete
  neighbors.json       ZIP -> nearby ZIPs whose sales can be comps
  tindex.json          ZIP -> monthly home value index (time adjustment)
  model.json           regression coefficients (written by county_build)
  parcels/<zip>.json   residential parcels: features, address, location
  sales/<zip>.json     residential sales, last SALES_MONTHS months, all classes
Each table is {"cols": [...], "rows": [[...], ...]} to keep files small.
No owner names or mailing addresses are included.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

SALES_MONTHS = 24
NEIGHBOR_MILES = 5.0

PARCEL_COLS = ["parcel_id", "address", "address_key", "city", "zip", "property_type", "sqft",
               "year_built", "baths", "stories", "quality", "pool", "lot_acres", "nbhd", "nbhd_name",
               "subdivision", "lat", "lon", "just_value"]
SALE_COLS = ["parcel_id", "address", "zip", "date", "price", "sale_class", "reason", "property_type",
             "sqft", "year_built", "baths", "stories", "quality", "pool", "lot_acres", "nbhd",
             "subdivision", "lat", "lon"]


def _val(v):
    if v is None:
        return None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, pd.Timestamp):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        if math.isnan(v):
            return None
        return round(float(v), 6) if abs(v) < 1000 else round(float(v), 1)
    return v


def _table(df: pd.DataFrame, cols: list[str]) -> dict:
    sub = df[cols]
    return {"cols": cols, "rows": [[_val(v) for v in row] for row in sub.itertuples(index=False, name=None)]}


def _write(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"))
    path.write_text(text)
    return len(text)


def zip_neighbors(parcels: pd.DataFrame, miles: float = NEIGHBOR_MILES) -> dict[str, list[str]]:
    """ZIPs whose parcel bounding boxes come within `miles` of each other."""
    located = parcels.dropna(subset=["lat", "lon", "zip"])
    box = located.groupby("zip").agg(lat0=("lat", "min"), lat1=("lat", "max"),
                                      lon0=("lon", "min"), lon1=("lon", "max"))
    lat_mi, lon_mi = 69.0, 69.0 * math.cos(math.radians(28.3))
    out = {}
    for z, a in box.iterrows():
        near = []
        for z2, b in box.iterrows():
            dy = max(0.0, b.lat0 - a.lat1, a.lat0 - b.lat1) * lat_mi
            dx = max(0.0, b.lon0 - a.lon1, a.lon0 - b.lon1) * lon_mi
            if math.hypot(dx, dy) <= miles:
                near.append(z2)
        out[z] = sorted(near)
    return out


def address_index(p: pd.DataFrame) -> dict:
    """{"cities": {zip: city}, "streets": [[street, {zip: "12 14 101"}], ...]}: compact for autocomplete."""
    cities = p.groupby("zip")["city"].agg(lambda c: c.mode().iat[0] if c.notna().any() else "").to_dict()
    nums: dict[str, dict[str, set]] = {}
    for key, z in zip(p["address_key"], p["zip"]):
        num, _, street = key.partition(" ")
        if street and num.isdigit():
            nums.setdefault(street, {}).setdefault(z, set()).add(int(num))
    return {"cities": {z: str(c).title() for z, c in sorted(cities.items())},
            "streets": [[st, {z: " ".join(map(str, sorted(n))) for z, n in sorted(by_zip.items())}]
                        for st, by_zip in sorted(nums.items())]}


def export_county(name: str, parcels: pd.DataFrame, sales_all: pd.DataFrame, model: dict,
                  summary: dict, site_dir: Path, zip_series: dict[str, list]) -> dict:
    out = site_dir / "counties" / name
    p = parcels[parcels["zip"].notna() & parcels["address_key"].notna()].copy()
    usable = sales_all["sale_class"].isin(["market", "distressed"])
    end = sales_all.loc[usable, "date"].max()   # "as of" date: same as the Python engine uses
    s = sales_all[sales_all["date"] > end - pd.DateOffset(months=SALES_MONTHS)].copy()
    s = s[s["zip"].notna()]

    sizes = {"parcels": 0, "sales": 0}
    zips = sorted(p["zip"].unique())
    for z in zips:
        sizes["parcels"] += _write(out / "parcels" / f"{z}.json", _table(p[p["zip"] == z], PARCEL_COLS))
        sizes["sales"] += _write(out / "sales" / f"{z}.json", _table(s[s["zip"] == z], SALE_COLS))

    streets: dict[str, set] = {}
    for key, z in zip(p["address_key"], p["zip"]):
        parts = key.split(" ", 1)
        if len(parts) == 2:
            streets.setdefault(parts[1], set()).add(z)
    _write(out / "streets.json", {k: sorted(v) for k, v in sorted(streets.items())})
    _write(out / "addresses.json", address_index(p))
    _write(out / "neighbors.json", zip_neighbors(p))
    _write(out / "tindex.json", {z: zip_series[z] for z in sorted(zip_series) if zip_series[z]})
    _write(out / "model.json", model)
    meta = {
        "county": name, "zips": zips, "sales_months": SALES_MONTHS,
        "latest_sale": end.strftime("%Y-%m-%d"),
        "parcel_cols": PARCEL_COLS, "sale_cols": SALE_COLS, "summary": summary,
        "bytes": sizes,
    }
    _write(out / "meta.json", meta)
    return meta
