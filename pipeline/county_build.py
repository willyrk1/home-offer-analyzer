"""Build comps data for counties with a sales adapter (currently Pasco).

    python -m pipeline.county_build                    # download + build
    python -m pipeline.county_build --offline --raw-dir raw-sample/pasco

Writes:
  work/<county>/parcels.parquet, sales.parquet   full tables for the comps engine
  site/data/counties/<county>/model.json         regression coefficients and fit stats
  site/data/counties/<county>/summary.json       sale-class counts, coverage, data dates
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from . import valuation
from .build import _clean
from .counties import pasco

ROOT = Path(__file__).resolve().parent.parent
ADAPTERS = {"pasco": pasco}


def build_county(name: str, raw_dir: Path, work_dir: Path, site_dir: Path,
                 offline: bool = False) -> dict:
    adapter = ADAPTERS[name]
    if offline:
        paths = {k: raw_dir / Path(u).name for k, u in adapter.FILES.items()}
    else:
        paths = adapter.download(raw_dir)

    parcels = adapter.build_parcels(paths)
    all_sales = adapter.load_sales(paths["sales"])
    sales = adapter.build_sales(paths, parcels)
    model = valuation.fit(sales)

    work_dir.mkdir(parents=True, exist_ok=True)
    parcels.to_parquet(work_dir / "parcels.parquet", index=False)
    sales.to_parquet(work_dir / "sales.parquet", index=False)

    out = site_dir / "counties" / name
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.json").write_text(json.dumps(_clean(model), indent=1))
    summary = {
        "county": name,
        "parcels_residential": int(len(parcels)),
        "parcels_with_location": int(parcels["lat"].notna().sum()),
        "parcels_with_address": int(parcels["address_key"].notna().sum()),
        "property_types": parcels["property_type"].value_counts().to_dict(),
        "sales_since_2016_by_class": all_sales["sale_class"].value_counts().to_dict(),
        "residential_sales_used": int(len(sales)),
        "latest_sale": sales["date"].max().strftime("%Y-%m-%d") if not sales.empty else None,
        "market_sales_last_90_days": int(((sales["sale_class"] == "market")
                                          & (sales["date"] > sales["date"].max() - pd.Timedelta(days=90))).sum()),
    }
    (out / "summary.json").write_text(json.dumps(_clean(summary), indent=1))
    return {"summary": summary, "model": model}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--county", default="pasco", choices=sorted(ADAPTERS))
    p.add_argument("--raw-dir", type=Path)
    p.add_argument("--work-dir", type=Path)
    p.add_argument("--site-dir", type=Path, default=ROOT / "site" / "data")
    p.add_argument("--offline", action="store_true")
    a = p.parse_args(argv)
    raw = a.raw_dir or ROOT / "raw" / a.county
    work = a.work_dir or ROOT / "work" / a.county
    r = build_county(a.county, raw, work, a.site_dir, offline=a.offline)
    s, m = r["summary"], r["model"]
    print(json.dumps(_clean(s), indent=1))
    print(f"model: {m['n_sales']} sales, R2 {m['r2']:.3f}, median abs error {m['median_abs_pct_error']:.1f}%")
    for f, v in m["features"].items():
        print(f"  {v['label']:<28} {v['coef']:+.4f}  (se {v['se']:.4f})")


if __name__ == "__main__":
    main()
