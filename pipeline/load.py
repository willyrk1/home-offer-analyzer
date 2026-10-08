"""Parse the raw provider files into tidy tables, keeping only covered ZIPs."""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd
import yaml

from .sources import open_text

DATE_COL = re.compile(r"^\d{4}-\d{2}-\d{2}$")

REDFIN_KEEP = [
    "median_sale_price", "median_list_price", "median_ppsf", "homes_sold",
    "pending_sales", "new_listings", "inventory", "months_of_supply",
    "median_dom", "avg_sale_to_list", "sold_above_list", "price_drops",
]
REDFIN_PROPERTY_TYPES = {"All Residential", "Single Family Residential"}


def zip5(value) -> str:
    return str(int(value)).zfill(5)


def load_coverage(path: Path) -> dict:
    with open(path) as fh:
        cfg = yaml.safe_load(fh)
    cfg.setdefault("counties", [])
    cfg["extra_zips"] = [zip5(z) for z in (cfg.get("extra_zips") or [])]
    return cfg


def read_zillow_wide(path: Path) -> pd.DataFrame:
    with open_text(path) as fh:
        df = pd.read_csv(fh, dtype={"RegionName": str}).copy()
    df["zip"] = df["RegionName"].map(zip5)
    return df


def covered_zips(zhvi_wide: pd.DataFrame, coverage: dict) -> pd.DataFrame:
    """ZIPs (with county/state/city) that fall in covered counties or extra_zips."""
    meta = zhvi_wide[["zip", "State", "CountyName", "City", "Metro"]].copy()
    keep = pd.Series(False, index=meta.index)
    for c in coverage["counties"]:
        keep |= (meta["State"] == c["state"]) & (meta["CountyName"] == c["name"])
    keep |= meta["zip"].isin(coverage["extra_zips"])
    out = meta[keep].rename(columns={"State": "state", "CountyName": "county",
                                     "City": "city", "Metro": "metro"})
    return out.drop_duplicates("zip").sort_values("zip").reset_index(drop=True)


def zhvi_long(zhvi_wide: pd.DataFrame, zips: set[str]) -> pd.DataFrame:
    date_cols = [c for c in zhvi_wide.columns if DATE_COL.match(c)]
    df = zhvi_wide[zhvi_wide["zip"].isin(zips)][["zip", *date_cols]]
    long = df.melt(id_vars="zip", var_name="date", value_name="zhvi").dropna()
    long["date"] = pd.to_datetime(long["date"]).dt.to_period("M").dt.to_timestamp()
    return long.sort_values(["zip", "date"]).reset_index(drop=True)


def zillow_forecast(path: Path, zips: set[str]) -> pd.DataFrame:
    """One row per ZIP: base date plus 1m / 3m / 12m forecast growth (%)."""
    wide = read_zillow_wide(path)
    date_cols = sorted(c for c in wide.columns if DATE_COL.match(c))
    if len(date_cols) < 3:
        raise ValueError(f"Unexpected Zillow forecast layout: {date_cols}")
    h1, h3, h12 = date_cols[-3:]
    df = wide[wide["zip"].isin(zips)]
    return pd.DataFrame({
        "zip": df["zip"],
        "base_date": df.get("BaseDate"),
        "forecast_1m_pct": df[h1],
        "forecast_3m_pct": df[h3],
        "forecast_12m_pct": df[h12],
        "target_date_12m": h12,
    }).reset_index(drop=True)


def redfin_zip(path: Path, zips: set[str], chunksize: int = 250_000,
               info: dict | None = None) -> pd.DataFrame:
    """Stream Redfin's ZIP tracker and keep covered ZIPs, monthly 90-day windows.

    If `info` is given, it is filled with what the real file contains (columns,
    window lengths, latest period, non-empty counts for covered ZIPs) so format
    changes are visible without downloading the file by hand.
    """
    parts = []
    seen = {"columns": None, "durations": set(), "property_types": set(),
            "latest_period_end_all": None, "rows_all": 0}
    with open_text(path) as fh:
        for chunk in pd.read_csv(fh, sep="\t", chunksize=chunksize, low_memory=False):
            chunk.columns = [c.lower() for c in chunk.columns]
            if seen["columns"] is None:
                seen["columns"] = list(chunk.columns)
            seen["rows_all"] += len(chunk)
            if "period_duration" in chunk:
                seen["durations"].update(pd.to_numeric(chunk["period_duration"], errors="coerce").dropna().astype(int).tolist())
                chunk = chunk[pd.to_numeric(chunk["period_duration"], errors="coerce").isin([90])]
            seen["property_types"].update(chunk["property_type"].dropna().unique().tolist())
            latest = chunk["period_end"].max() if len(chunk) else None
            if latest and (seen["latest_period_end_all"] is None or latest > seen["latest_period_end_all"]):
                seen["latest_period_end_all"] = latest
            chunk["zip"] = chunk["region"].astype(str).str.extract(r"(\d{5})")[0]
            chunk = chunk[chunk["zip"].isin(zips)
                          & chunk["property_type"].isin(REDFIN_PROPERTY_TYPES)]
            if not chunk.empty:
                cols = ["zip", "property_type", "period_begin", "period_end",
                        *[c for c in REDFIN_KEEP if c in chunk.columns]]
                parts.append(chunk[cols])
    if info is not None:
        info.update({
            "columns": seen["columns"],
            "period_durations": sorted(seen["durations"]),
            "property_types": sorted(seen["property_types"]),
            "latest_period_end_all_zips": seen["latest_period_end_all"],
            "rows_all": seen["rows_all"],
        })
    if not parts:
        return pd.DataFrame(columns=["zip", "property_type", "date", *REDFIN_KEEP])
    df = pd.concat(parts, ignore_index=True)
    for c in REDFIN_KEEP:
        if c not in df.columns:
            df[c] = pd.NA
        df[c] = pd.to_numeric(df[c], errors="coerce")
    # Each row is a 90-day window; label it by the month it ends in.
    df["date"] = pd.to_datetime(df["period_end"]).dt.to_period("M").dt.to_timestamp()
    df = df.drop(columns=["period_begin", "period_end"])
    df = df.sort_values(["zip", "property_type", "date"])
    return df.drop_duplicates(["zip", "property_type", "date"], keep="last").reset_index(drop=True)
