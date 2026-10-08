"""Weekly build: download sources, compute ZIP indicators, write site data files.

Usage:
    python -m pipeline.build                       # download everything, then build
    python -m pipeline.build --raw-dir tests/fixtures --offline   # build from local files
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from . import indicators, load, sources

ROOT = Path(__file__).resolve().parent.parent
SERIES_START = pd.Timestamp("2015-01-01")


def _clean(obj):
    """Make values JSON-safe: NaN -> None, numpy types -> Python, round floats."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if hasattr(obj, "item"):
        obj = obj.item()
    if isinstance(obj, float):
        return None if math.isnan(obj) else round(obj, 4)
    return obj


def _raw_path(raw_dir: Path, name: str) -> Path:
    return raw_dir / Path(sources.SOURCES[name]).name


def archive_forecast(fc: pd.DataFrame, archive_dir: Path, today: date) -> Path | None:
    """Save this run's Zillow forecast once per base month, for later backtesting."""
    if fc.empty:
        return None
    base = str(fc["base_date"].dropna().iloc[0])[:7] if fc["base_date"].notna().any() \
        else today.strftime("%Y-%m")
    archive_dir.mkdir(parents=True, exist_ok=True)
    dest = archive_dir / f"zillow_forecast_{base}.csv"
    if not dest.exists():
        fc.to_csv(dest, index=False)
        return dest
    return None


def diagnostics(rf: pd.DataFrame, rf_info: dict, rt: pd.DataFrame | None, zhvi: pd.DataFrame,
                fc: pd.DataFrame, zip_set: set[str], download_errors: dict) -> dict:
    """What the real downloads contained, published so format changes are visible."""
    latest = rf["date"].max() if not rf.empty else None
    at_latest = rf[rf["date"] == latest] if latest is not None else rf
    rt_latest = rt["date"].max() if rt is not None and not rt.empty else None
    return {
        "covered_zips": len(zip_set),
        "download_errors": download_errors,
        "zillow": {
            "zips_with_zhvi": int(zhvi["zip"].nunique()),
            "latest_zhvi": zhvi["date"].max().strftime("%Y-%m") if not zhvi.empty else None,
            "zips_with_forecast": int(fc["zip"].nunique()),
        },
        "redfin": {
            **rf_info,
            "covered_rows": int(len(rf)),
            "covered_zips_with_data": int(rf["zip"].nunique()) if not rf.empty else 0,
            "latest_covered": latest.strftime("%Y-%m") if latest is not None else None,
            "non_empty_at_latest": {c: int(at_latest[c].notna().sum())
                                    for c in load.REDFIN_KEEP if c in at_latest},
            "non_empty_any_date": {c: int(rf[c].notna().sum())
                                   for c in load.REDFIN_KEEP if c in rf},
        },
        "realtor": None if rt is None else {
            "covered_rows": int(len(rt)),
            "covered_zips_with_data": int(rt["zip"].nunique()) if not rt.empty else 0,
            "latest_covered": rt_latest.strftime("%Y-%m") if rt_latest is not None else None,
            "non_empty_at_latest": {c: int(rt[rt["date"] == rt_latest][c].notna().sum())
                                    for c in load.REALTOR_KEEP} if rt_latest is not None else {},
        },
    }


def series_points(df: pd.DataFrame, value_col: str, scale: float = 1.0) -> list:
    if df is None or df.empty or value_col not in df:
        return []
    df = df[df["date"] >= SERIES_START].dropna(subset=[value_col])
    return [[d.strftime("%Y-%m"), float(v) * scale] for d, v in zip(df["date"], df[value_col])]


def build(raw_dir: Path, out_dir: Path, archive_dir: Path, coverage_path: Path,
          today: date | None = None, download_errors: dict | None = None) -> dict:
    today = today or date.today()
    coverage = load.load_coverage(coverage_path)

    zhvi_wide = load.read_zillow_wide(_raw_path(raw_dir, "zillow_zhvi"))
    zips_meta = load.covered_zips(zhvi_wide, coverage)
    zip_set = set(zips_meta["zip"])

    zhvi = load.zhvi_long(zhvi_wide, zip_set)
    fc = load.zillow_forecast(_raw_path(raw_dir, "zillow_forecast"), zip_set)
    rf_info: dict = {}
    rf = load.redfin_zip(_raw_path(raw_dir, "redfin_zip"), zip_set, info=rf_info)
    rt_path = _raw_path(raw_dir, "realtor_zip")
    rt = load.realtor_zip(rt_path, zip_set) if rt_path.exists() else None
    archived = archive_forecast(fc, archive_dir, today)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "diagnostics.json").write_text(json.dumps(_clean(
        diagnostics(rf, rf_info, rt, zhvi, fc, zip_set, download_errors or {})), indent=1, default=str))

    zips_dir = out_dir / "zips"
    zips_dir.mkdir(parents=True, exist_ok=True)
    index_rows = []

    for meta in zips_meta.to_dict("records"):
        z = meta["zip"]
        z_zhvi = zhvi[zhvi["zip"] == z]
        z_rf = rf[rf["zip"] == z]
        rf_all = z_rf[z_rf["property_type"] == "All Residential"]
        rf_sfr = z_rf[z_rf["property_type"] == "Single Family Residential"]
        z_rt = rt[rt["zip"] == z] if rt is not None else pd.DataFrame()
        z_fc = fc[fc["zip"] == z]
        forecast = z_fc.iloc[0].drop("zip").to_dict() if not z_fc.empty else None

        ind_all = indicators.combine({
            **indicators.zhvi_indicators(z_zhvi),
            **indicators.redfin_indicators(rf_all),
            **indicators.realtor_indicators(z_rt),
        })
        ind_sfr = indicators.redfin_indicators(rf_sfr)
        signal = indicators.market_signal(ind_all)

        cuts_series = series_points(rf_all, "price_drops", 100) \
            or series_points(z_rt, "price_reduced_share", 100)

        record = {
            "zip": z, **meta,
            "indicators": ind_all,
            "indicators_single_family": ind_sfr,
            "signal": signal,
            "zillow_forecast": forecast,
            "series": {
                "zhvi": series_points(z_zhvi, "zhvi"),
                "median_sale_price": series_points(rf_all, "median_sale_price"),
                "inventory": series_points(rf_all, "inventory"),
                "active_listings": series_points(z_rt, "active_listing_count"),
                "price_drops_pct": cuts_series,
                "median_dom": series_points(rf_all, "median_dom"),
                "sale_to_list_pct": series_points(rf_all, "avg_sale_to_list", 100),
            },
        }
        (zips_dir / f"{z}.json").write_text(json.dumps(_clean(record), separators=(",", ":")))
        index_rows.append({
            "zip": z, "city": meta["city"], "county": meta["county"], "state": meta["state"],
            "zhvi": ind_all.get("zhvi"), "zhvi_yoy_pct": ind_all.get("zhvi_yoy_pct"),
            "forecast_12m_pct": forecast["forecast_12m_pct"] if forecast else None,
            "price_drops_pct": ind_all.get("cuts_pct"),
            "inventory_yoy_pct": ind_all.get("inv_yoy_pct"),
            "verdict": signal["verdict"],
        })

    index = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "sources": {
            "zillow": "Zillow Research (ZHVI and Home Value Forecast)",
            "redfin": "Redfin Data Center (ZIP market tracker)",
            "realtor": "Realtor.com Research (ZIP listing metrics)" if rt is not None else None,
        },
        "counties": [{k: c[k] for k in ("name", "state", "level")} for c in coverage["counties"]],
        "zips": index_rows,
    }
    (out_dir / "index.json").write_text(json.dumps(_clean(index), separators=(",", ":")))
    return {"zips": len(index_rows), "archived": str(archived) if archived else None,
            "realtor": rt is not None}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--raw-dir", type=Path, default=ROOT / "raw")
    p.add_argument("--out-dir", type=Path, default=ROOT / "site" / "data")
    p.add_argument("--archive-dir", type=Path, default=ROOT / "data" / "archive")
    p.add_argument("--coverage", type=Path, default=ROOT / "coverage.yaml")
    p.add_argument("--offline", action="store_true", help="use files already in --raw-dir")
    args = p.parse_args(argv)

    errors: dict = {}
    if not args.offline:
        for name in sources.SOURCES:
            print(f"downloading {name} ...", flush=True)
            try:
                sources.download(name, args.raw_dir)
            except Exception as exc:  # noqa: BLE001
                if name not in sources.OPTIONAL:
                    raise
                errors[name] = f"{type(exc).__name__}: {exc}"
                print(f"  optional source {name} failed: {errors[name]}", flush=True)
                (args.raw_dir / Path(sources.SOURCES[name]).name).unlink(missing_ok=True)

    result = build(args.raw_dir, args.out_dir, args.archive_dir, args.coverage, download_errors=errors)
    print(f"built {result['zips']} ZIPs; realtor data: {result['realtor']}; "
          f"archived forecast: {result['archived']}")


if __name__ == "__main__":
    main()
