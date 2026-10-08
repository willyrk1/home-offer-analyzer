"""Synthetic Pasco Property Appraiser files in the real column layouts.

Prices follow a known formula so tests can check that the regression recovers
the feature values. A parcel at "1295 MONTGOMERY BELL ROAD" serves as the
subject. All names, numbers and locations are invented.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

TRUE = {"ln_sqft": 0.70, "age": -0.004, "pool": 0.08, "baths": 0.03, "ln_lot": 0.06}
STREETS = [("MONTGOMERY BELL", "ROAD"), ("WATOGA", "LOOP"), ("BANNACK", "LANE"),
           ("TONKA", "TERRACE"), ("BERING", "ROAD"), ("ANSLEY BLOOM", "LANE")]


def _zip_csv(path: Path, member: str, df: pd.DataFrame) -> None:
    buf = io.StringIO()
    df.to_csv(buf, index=False, quoting=1)  # quote all, like the county files
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(member, buf.getvalue())


def write_all(dest: Path, n_parcels: int = 700, seed: int = 7) -> Path:
    import geopandas as gpd
    from shapely.geometry import box

    rng = np.random.default_rng(seed)
    dest.mkdir(parents=True, exist_ok=True)

    ids = [f"35-26-20-{'0080' if i % 2 == 0 else '0090'}-00000-{i:04d}" for i in range(n_parcels)]
    nbhd = np.where(np.arange(n_parcels) % 2 == 0, "UNPK", "MDPT")
    sqft = rng.integers(1400, 3200, n_parcels)
    year = rng.integers(2005, 2025, n_parcels)
    baths = rng.choice([2.0, 2.5, 3.0, 3.5], n_parcels)
    acres = np.round(rng.uniform(0.10, 0.40, n_parcels), 4)
    pool = rng.random(n_parcels) < 0.3
    stories = rng.choice([1.0, 2.0], n_parcels)
    use = np.where(rng.random(n_parcels) < 0.85, "0100", "0700")
    lat = 28.17 + rng.uniform(0, 0.03, n_parcels)
    lon = -82.30 + rng.uniform(0, 0.03, n_parcels)

    # The subject: parcel 0, a 2018 2-story home with no pool.
    sqft[0], year[0], baths[0], acres[0], pool[0], stories[0], use[0] = 2571, 2018, 3.0, 0.14, False, 2.0, "0100"

    building = pd.DataFrame({
        "Parcel_Num": ids, "Bldg_Num": "1", "Bldg_Section": "1", "Bldg_Style": "01",
        "Bldg_Style_Desc": "Single Family", "Bldg_EffYrBlt": year, "Bldg_ActYrBlt": year,
        "Bldg_Bathrooms": baths, "Bldg_Use_Code": use, "Bldg_Use_Desc": "x", "Bldg_Quality": "4",
        "Bldg_Quality_Desc": "Above Average", "Bldg_Stories": stories, "Bldg_Total_Sqft": sqft + 500,
        "Bldg_Heated_Sqft": sqft, "Bldg_Value": "1",
    })
    # A commercial building that must be ignored.
    building.loc[len(building)] = {**building.iloc[1].to_dict(), "Parcel_Num": "99-99-99-9999-99999-9999",
                                   "Bldg_Use_Code": "1100"}
    _zip_csv(dest / "building.zip", "building.csv", building)

    xf_rows = [{"Parcel_Num": pid, "XF_Line_Num": "1", "XF_Code": "RPOOLGUN", "XF_Desc": "RESIDENTIAL POOL GUNITE",
                "XF_Unit_Type": "UNITS", "XF_Units": "1", "XF_Value": "1", "Bldg_Num": "1", "XF_Year": "2020"}
               for pid, p in zip(ids, pool) if p]
    xf_rows += [{"Parcel_Num": pid, "XF_Line_Num": "2", "XF_Code": "RDWSWC", "XF_Desc": "DRVWAY",
                 "XF_Unit_Type": "UNITS", "XF_Units": "1", "XF_Value": "1", "Bldg_Num": "1", "XF_Year": "2020"}
                for pid in ids[:50]]
    _zip_csv(dest / "extrafeatures.zip", "extrafeatures.csv", pd.DataFrame(xf_rows))

    _zip_csv(dest / "parcel.zip", "parcel.csv", pd.DataFrame({
        "Parcel_Num": ids, "Tax_Area": "UF", "Prop_Use_Code": "00100", "Prop_Use_Desc": "Single Family",
        "NBHD_Code": nbhd, "Hmstd": "YES", "TotSqFt": sqft, "HstSqFt": sqft, "Acres": acres,
        "Just_Value": (sqft * 180).astype(int), "County_Assessed": "1", "County_Exemptions": "0",
        "County_Taxable": "1", "School_Assessed": "1", "School_Exemptions": "0", "School_Taxable": "1",
        "NBHD_Desc": np.where(nbhd == "UNPK", "UNION PARK", "MEADOW POINTE"),
    }))

    streets = [STREETS[i % len(STREETS)] for i in range(n_parcels)]
    numbers = [1295] + [1000 + 2 * i for i in range(1, n_parcels)]
    _zip_csv(dest / "site_addresses.zip", "site_addresses.csv", pd.DataFrame({
        "PARCEL": ids, "ADDRESS_NUMBER": numbers, "STREET_NAME": [s[0] for s in streets],
        "STREET_SUFFIX": [s[1] for s in streets], "CITY": "WESLEY CHAPEL",
        "ZIP_CODE": np.where(np.arange(n_parcels) % 3 == 0, "33544", "33543"),
        "UNIT_TYPE": "", "UNIT_IDENTIFIER": "",
    }))

    # Sales: known formula + noise, spread over 2024-01..2026-09.
    rows = []
    dates = pd.to_datetime("2024-01-01") + pd.to_timedelta(rng.integers(0, 1000, n_parcels * 2), unit="D")
    for k, d in enumerate(dates):
        i = k % n_parcels
        if i == 0:
            continue  # subject has no recent sale
        age = d.year - year[i]
        lnp = (8.1 + TRUE["ln_sqft"] * np.log(sqft[i]) + TRUE["age"] * age + TRUE["pool"] * pool[i]
               + TRUE["baths"] * baths[i] + TRUE["ln_lot"] * np.log(acres[i])
               + (0.05 if nbhd[i] == "UNPK" else 0.0) + rng.normal(0, 0.04))
        price = round(float(np.exp(lnp)), -2)
        roll = rng.random()
        if roll < 0.08:
            q, code, deed, price = "U", "11", "QC", 0          # family quit-claim
        elif roll < 0.12:
            q, code, deed = "U", "12", "WD"                   # bank-owned resale
            price = round(price * 0.85, -2)
        elif roll < 0.14:
            q, code, deed = "U", "37", "WD"                   # not exposed to market
        else:
            q, code, deed = "Q", "01", "WD"
        rows.append({"Parcel_Num": ids[i], "Sale_Line_Num": "1", "Sale_Date": d.strftime("%m/%d/%Y"),
                     "Sale_Price": price, "Sale_VacImp": "I", "Sale_Qalified_Code": code,
                     "Sale_Qualified": q, "Sale_Book": str(10000 + k), "Sale_Page": "1",
                     "Sale_Deed_Type": deed})
    # A two-parcel deed: same book/page, must be excluded even though qualified.
    for pid in ids[5:7]:
        rows.append({"Parcel_Num": pid, "Sale_Line_Num": "9", "Sale_Date": "06/15/2026",
                     "Sale_Price": 900000, "Sale_VacImp": "I", "Sale_Qalified_Code": "05",
                     "Sale_Qualified": "Q", "Sale_Book": "77777", "Sale_Page": "7", "Sale_Deed_Type": "WD"})
    # A vacant-land sale: must be ignored.
    rows.append({"Parcel_Num": ids[9], "Sale_Line_Num": "8", "Sale_Date": "05/01/2026", "Sale_Price": 80000,
                 "Sale_VacImp": "V", "Sale_Qalified_Code": "01", "Sale_Qualified": "Q",
                 "Sale_Book": "88888", "Sale_Page": "8", "Sale_Deed_Type": "WD"})
    sales = pd.DataFrame(rows)
    with zipfile.ZipFile(dest / "sales.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.TXT", "sales_late_10years.csv \r\nListing of current sales.\r\n")
        z.writestr("sales_last_10years.csv", sales.to_csv(index=False, quoting=1))
        z.writestr("sales_all.csv", sales.to_csv(index=False, quoting=1))

    # Parcel shapefile: small squares around each point, in Florida West state plane.
    gdf = gpd.GeoDataFrame({"PARCELNO": ids, "ACRES": acres},
                           geometry=[box(x - 1e-4, y - 1e-4, x + 1e-4, y + 1e-4) for x, y in zip(lon, lat)],
                           crs=4326).to_crs(2882)
    shp_dir = dest / "_shp"
    shp_dir.mkdir(exist_ok=True)
    gdf.to_file(shp_dir / "pasco_parcels.shp")
    with zipfile.ZipFile(dest / "pasco_parcels.zip", "w") as z:
        for f in shp_dir.iterdir():
            z.write(f, f.name)
    return dest


def zhvi_series(start="2015-01", end="2026-09", monthly=0.002) -> list:
    months = pd.period_range(start, end, freq="M")
    return [[str(m), 300000 * (1 + monthly) ** k] for k, m in enumerate(months)]
