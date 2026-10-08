"""The browser engine (site/comps.js) must agree with the Python engine."""
import json
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from pipeline import comps, comps_report, county_build
from pipeline.counties import pasco
from tests import pasco_fixtures as fx

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("js")
    raw = fx.write_all(tmp / "raw")
    site = tmp / "site"
    (site / "zips").mkdir(parents=True)
    for z in ["33543", "33544"]:
        (site / "zips" / f"{z}.json").write_text(json.dumps({"zip": z, "series": {"zhvi": fx.zhvi_series()}}))
    county_build.build_county("pasco", raw, tmp / "work", site, offline=True)
    return tmp, site


def run_js(site, address, explain=None):
    args = ["node", str(ROOT / "tests" / "run_comps.js"), str(site), "pasco", address]
    if explain:
        args.append(explain)
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)


def python_value(tmp, site, address):
    parcels = pd.read_parquet(tmp / "work" / "parcels.parquet")
    sales = pd.read_parquet(tmp / "work" / "sales.parquet")
    model = json.loads((site / "counties" / "pasco" / "model.json").read_text())
    subj = comps.find_subject(parcels, address, pasco.normalize_address)
    return comps.value_subject(subj, sales, model, comps_report.load_time_index(site))


@pytest.mark.parametrize("address", ["1295 Montgomery Bell Rd, Wesley Chapel, FL 33543",
                                     "1002 Watoga Loop", "1006 Tonka Terrace"])
def test_js_matches_python(built, address):
    tmp, site = built
    py = python_value(tmp, site, address)
    js = run_js(site, address)
    assert js["as_of"] == py["as_of"]
    assert js["search"]["area"] == py["search"]["area"] or "mi" in js["search"]["area"]
    assert [c["parcel_id"] for c in js["comps"]] == [c["parcel_id"] for c in py["comps"]]
    assert js["fair_value"] == pytest.approx(py["fair_value"], rel=1e-9)
    for a, b in zip(js["comps"], py["comps"]):
        assert a["adjusted_price"] == pytest.approx(b["adjusted_price"], rel=1e-9)
        assert a["weight"] == pytest.approx(b["weight"], rel=1e-9)


def test_export_files_and_privacy(built):
    _, site = built
    base = site / "counties" / "pasco"
    meta = json.loads((base / "meta.json").read_text())
    assert set(meta["zips"]) == {"33543", "33544"}
    assert "owner" not in json.dumps(meta).lower()
    sales = json.loads((base / "sales" / "33543.json").read_text())
    assert "reason" in sales["cols"] and "owner" not in " ".join(sales["cols"]).lower()
    classes = {r[sales["cols"].index("sale_class")] for r in sales["rows"]}
    assert classes == {"market", "distressed", "non_market"}   # excluded sales kept, with reasons
    streets = json.loads((base / "streets.json").read_text())
    assert "33544" in streets["MONTGOMERY BELL ROAD"]   # the subject's ZIP in the sample data
    assert json.loads((base / "neighbors.json").read_text())["33543"] == ["33543", "33544"]


def test_explain_non_market_sale(built):
    _, site = built
    base = site / "counties" / "pasco"
    rows = []
    for z in ["33543", "33544"]:
        t = json.loads((base / "sales" / f"{z}.json").read_text())
        rows += [dict(zip(t["cols"], r)) for r in t["rows"]]
    latest = {}
    for r in sorted(rows, key=lambda r: r["date"]):
        latest[r["address"]] = r
    qc = next(r for r in latest.values() if r["sale_class"] == "non_market" and "nominal" in (r["reason"] or ""))
    out = run_js(site, "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543", explain=qc["address"])
    assert out["explain"]["verdict"].startswith("Not used")
    assert any("isn't a market sale" in x for x in out["explain"]["reasons"])
    assert out["explain"]["what_if"] is not None


def test_explain_unknown_address(built):
    _, site = built
    out = run_js(site, "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543", explain="1 Nowhere Lane")
    assert out["explain"]["verdict"].startswith("No recorded sale")
