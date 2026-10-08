"""Write small synthetic files in the same layout as the real Zillow/Redfin downloads.

The numbers are invented; only the file formats match the providers. Used by the
tests and for previewing the site without downloading the real (large) files:

    python -m tests.fixtures raw-sample
    python -m pipeline.build --raw-dir raw-sample --offline
"""
from __future__ import annotations

import csv
import gzip
import sys
from pathlib import Path

import pandas as pd

from pipeline.sources import SOURCES

ZIPS = [
    # zip, state, county, city, metro, start value, monthly growth
    ("33543", "FL", "Pasco County", "Wesley Chapel", "Tampa-St. Petersburg-Clearwater, FL", 250_000, 0.0045),
    ("33544", "FL", "Pasco County", "Wesley Chapel", "Tampa-St. Petersburg-Clearwater, FL", 240_000, 0.0040),
    ("37323", "TN", "Bradley County", "Cleveland", "Cleveland, TN", 180_000, 0.0050),
    ("37919", "TN", "Knox County", "Knoxville", "Knoxville, TN", 220_000, 0.0055),
    ("90210", "CA", "Los Angeles County", "Beverly Hills", "Los Angeles, CA", 2_500_000, 0.0030),
]
MONTHS = pd.date_range("2018-01-31", "2026-08-31", freq="ME")


def _name(key: str) -> str:
    return Path(SOURCES[key]).name


def write_all(dest: Path, redfin_live: bool = True) -> Path:
    """redfin_live=True mimics the real Redfin ZIP file as of Oct 2026: price drops
    and months of supply empty, last window ending May 2026, plus some 30-day
    windows that must be ignored. False writes a complete Redfin file."""
    dest.mkdir(parents=True, exist_ok=True)

    # Zillow ZHVI: one row per ZIP, one column per month-end date.
    rows = []
    for i, (z, st, county, city, metro, v0, g) in enumerate(ZIPS):
        row = {"RegionID": 1000 + i, "SizeRank": i, "RegionName": int(z), "RegionType": "zip",
               "StateName": st, "State": st, "City": city, "Metro": metro, "CountyName": county}
        v = v0
        for k, m in enumerate(MONTHS):
            # Rise through mid-2022, then a mild decline in the last year.
            step = g if m <= pd.Timestamp("2025-08-31") else -0.003
            v *= 1 + step
            row[m.strftime("%Y-%m-%d")] = round(v)
        rows.append(row)
    pd.DataFrame(rows).to_csv(dest / _name("zillow_zhvi"), index=False)

    # Zillow forecast: base date plus three horizon columns.
    fc = []
    for i, (z, st, county, city, metro, *_rest) in enumerate(ZIPS):
        fc.append({"RegionID": 1000 + i, "SizeRank": i, "RegionName": int(z), "RegionType": "zip",
                   "StateName": st, "State": st, "City": city, "Metro": metro, "CountyName": county,
                   "BaseDate": "2026-08-31", "2026-09-30": -0.2, "2026-11-30": -0.5,
                   "2027-08-31": -1.5 + i * 0.4})
    pd.DataFrame(fc).to_csv(dest / _name("zillow_forecast"), index=False)

    # Redfin ZIP tracker: tab-separated, gzipped, uppercase columns, 90-day windows.
    cols = ["PERIOD_BEGIN", "PERIOD_END", "PERIOD_DURATION", "REGION_TYPE", "REGION",
            "STATE_CODE", "PROPERTY_TYPE", "MEDIAN_SALE_PRICE", "MEDIAN_LIST_PRICE",
            "MEDIAN_PPSF", "HOMES_SOLD", "PENDING_SALES", "NEW_LISTINGS", "INVENTORY",
            "MONTHS_OF_SUPPLY", "MEDIAN_DOM", "AVG_SALE_TO_LIST", "SOLD_ABOVE_LIST", "PRICE_DROPS"]
    with gzip.open(dest / _name("redfin_zip"), "wt", newline="") as fh:
        w = csv.writer(fh, delimiter="\t")
        w.writerow(cols)
        for z, st, _county, _city, _metro, v0, g in ZIPS:
            for ptype, mult in [("All Residential", 1.0), ("Single Family Residential", 1.1)]:
                v = v0
                for k, m in enumerate(MONTHS):
                    late = m > pd.Timestamp("2025-08-31")
                    v *= 1 + (g if not late else -0.003)
                    if redfin_live and m > pd.Timestamp("2026-05-31"):
                        break
                    begin = (m - pd.Timedelta(days=89)).strftime("%Y-%m-%d")
                    season = 1.15 if m.month in (9, 10, 11) else 1.0
                    w.writerow([
                        begin, m.strftime("%Y-%m-%d"), 90, "zip code", f"Zip Code: {z}", st, ptype,
                        round(v * mult * 1.05), round(v * mult * 1.08), round(v * mult / 2000, 1),
                        60, 25, 70,
                        round((150 if not late else 150 + (k - 91) * 4) * season),
                        "" if redfin_live else (2.5 if not late else 3.4),
                        35 if not late else 55,
                        0.985 if not late else 0.968,
                        0.25 if not late else 0.12,
                        "" if redfin_live else round((0.18 if not late else 0.27) * season, 3),
                    ])
                    if redfin_live and k % 12 == 0:
                        # A 30-day window with nonsense values: must be filtered out.
                        w.writerow([m.strftime("%Y-%m-01"), m.strftime("%Y-%m-%d"), 30, "zip code",
                                    f"Zip Code: {z}", st, ptype, 1, 1, 1, 1, 1, 1, 1, "", 1, 9.9, 1, ""])

    # Realtor.com ZIP listing metrics: monthly through Sep 2026, ends with a footnote row.
    rt_months = pd.date_range("2017-01-01", "2026-09-01", freq="MS")
    rows = []
    for z, *_rest in ZIPS:
        for m in rt_months:
            late = m > pd.Timestamp("2025-09-01")
            season = 1.15 if m.month in (9, 10, 11) else 1.0
            active = round((100 if not late else 130) * season)
            rows.append({
                "month_date_yyyymm": m.strftime("%Y%m"), "postal_code": int(z), "zip_name": "x",
                "median_listing_price": 400000, "active_listing_count": active,
                "median_days_on_market": 40 if not late else 52,
                "new_listing_count": 30, "price_increased_count": 2,
                "price_reduced_count": round(active * (0.20 if not late else 0.30)),
                "pending_listing_count": 20, "median_listing_price_per_square_foot": 190,
                "quality_flag": 0,
            })
    rt = pd.DataFrame(rows)
    rt.to_csv(dest / _name("realtor_zip"), index=False)
    with open(dest / _name("realtor_zip"), "a") as fh:
        fh.write("quality_flag = 1: Note: Data for this ZIP may be incomplete\n")
    return dest


if __name__ == "__main__":
    out = write_all(Path(sys.argv[1] if len(sys.argv) > 1 else "raw-sample"))
    print(f"wrote sample files to {out}")
