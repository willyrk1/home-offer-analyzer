"""Plain-text comps report for one address, from a finished county build.

    python -m pipeline.comps_report "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543"
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from . import comps
from .counties import pasco

ROOT = Path(__file__).resolve().parent.parent


def load_time_index(site_dir: Path) -> comps.TimeIndex:
    series = {}
    for f in (site_dir / "zips").glob("*.json"):
        rec = json.loads(f.read_text())
        series[rec["zip"]] = rec["series"]["zhvi"]
    return comps.TimeIndex(series)


def money(v):
    return "—" if v is None else f"${v:,.0f}"


def render(r: dict) -> str:
    s = r["subject"]
    lines = [
        f"SUBJECT  {s['address']}, {s['city']} {s['zip']}   (parcel {s['parcel_id']})",
        f"  {s['property_type']}, {s['sqft']:.0f} sq ft, built {s['year_built']:.0f}, "
        f"{s['baths']} baths, {s['stories']} stories, lot {s['lot_acres']} ac, pool: {s['pool']}, "
        f"quality {s['quality']}, neighborhood {s['nbhd']} ({s['nbhd_name']})",
        f"  appraiser just value: {money(s['just_value'])}",
        "",
        f"FAIR VALUE  {money(r['fair_value'])}   range {money(r['range'][0])} – {money(r['range'][1])}"
        if r["fair_value"] else "FAIR VALUE  (no comps found)",
        f"  as of {r['as_of']}; comps {r['search']['area']}, last {r['search']['months']} months"
        + ("" if r["search"]["located"] else "  [no parcel coordinates: matched by area]")
        + ("  [THIN: widest search used]" if r["search"].get("thin") else ""),
        f"  county model: {r['model']['n_sales']} sales {r['model']['window'][0]}..{r['model']['window'][1]}, "
        f"R2 {r['model']['r2']:.3f}, median abs error {r['model']['median_abs_pct_error']:.1f}%",
        "",
        "COMPS",
    ]
    for c in sorted(r["comps"], key=lambda c: -c["weight"]):
        lines.append(
            f"- {c['address']} ({c['zip']})  sold {c['sale_date']} {money(c['sale_price'])} [{c['sale_class']}]  "
            f"{c['distance_mi']:.2f} mi{'  same nbhd' if c['same_neighborhood'] else ''}")
        lines.append(
            f"    {c['sqft']:.0f} sf, built {c['year_built']:.0f}, {c['baths']} ba, lot {c['lot_acres']} ac, "
            f"pool {c['pool']}  | similarity {c['similarity']:.2f}, weight {c['weight']:.2f}")
        lines.append(f"    time x{c['time_factor']:.3f} ({c['time_note']}) -> {money(c['time_adjusted'])}")
        for a in c["adjustments"]:
            lines.append(f"      {a['label']:<26} diff {a['difference']:+.3f}  {a['pct']:+.1f}%  {money(a['dollars'])}")
        lines.append(f"    ADJUSTED {money(c['adjusted_price'])}  (net {c['net_pct']:+.1f}%, gross {c['gross_pct']:.1f}%)"
                     + (f"  flags: {', '.join(c['flags'])}" if c["flags"] else ""))
    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("address", nargs="+")
    p.add_argument("--county", default="pasco")
    p.add_argument("--work-dir", type=Path)
    p.add_argument("--site-dir", type=Path, default=ROOT / "site" / "data")
    a = p.parse_args(argv)
    work = a.work_dir or ROOT / "work" / a.county
    parcels = pd.read_parquet(work / "parcels.parquet")
    sales = pd.read_parquet(work / "sales.parquet")
    model = json.loads((a.site_dir / "counties" / a.county / "model.json").read_text())
    tindex = load_time_index(a.site_dir)
    for addr in a.address:
        print("=" * 100)
        try:
            subj = comps.find_subject(parcels, addr, pasco.normalize_address)
            print(render(comps.value_subject(subj, sales, model, tindex)))
        except LookupError as e:
            print(e)


if __name__ == "__main__":
    main()
