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
    for m, v in py["methods"].items():
        if v["fair_value"] is None:
            assert js["methods"][m]["fair_value"] is None
        else:
            assert js["methods"][m]["fair_value"] == pytest.approx(v["fair_value"], rel=1e-9)
            assert js["methods"][m]["range"] == pytest.approx(v["range"], rel=1e-9)
    assert py["methods"]["assessed"]["fair_value"] is not None   # fixture has just values
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


def run_addr(site, queries):
    script = ("const fs=require('fs'),Addr=require(process.argv[1]);"
              "const idx=Addr.prepare(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));"
              "console.log(JSON.stringify(JSON.parse(process.argv[3]).map(q=>Addr.search(q,idx,5))));")
    args = ["node", "-e", script, str(ROOT / "site" / "addr.js"),
            str(site / "counties" / "pasco" / "addresses.json"), json.dumps(queries)]
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)


def test_address_index_and_autocomplete(built):
    _, site = built
    idx = json.loads((site / "counties" / "pasco" / "addresses.json").read_text())
    assert idx["cities"]["33544"] == "Wesley Chapel"
    streets = dict(idx["streets"])
    assert "1295" in streets["MONTGOMERY BELL ROAD"]["33544"].split()
    exact, swapped, typo, nearest, street, ambiguous = run_addr(site, [
        "1295 Montgomery Bell Rd, Wesley Chapel, FL 33544",   # full address with city and ZIP
        "montgomery bell 1295",                              # street first
        "1295 montgomry bel",                                # typos, last word still being typed
        "1297 Montgomery Bell Rd",                           # no such number: nearest ones
        "watga",                                             # street only
        "9999 b",                                            # no such number, street unclear: streets
    ])
    for r in (exact, swapped, typo):
        assert r[0]["value"] == "1295 Montgomery Bell Road, Wesley Chapel, FL 33544"
    assert nearest[0]["near"] and nearest[0]["key"].endswith("MONTGOMERY BELL ROAD")
    assert street[0]["kind"] == "street" and street[0]["label"] == "Watoga Loop"
    assert all(r["kind"] == "street" for r in ambiguous)


def test_calibrated_range_matches_python():
    cal = {"zip_scale": {"33543": 0.06}, "overall_scale": 0.09,
           "levels": {"80": {"a": 2.2, "k": 0.4}, "50": {"a": 1.0, "k": 0.2}}}
    cases = [[449397.0, 427233.0, 471561.0, "33543", "80"], [300000.0, 250000.0, 350000.0, "34652", "50"],
             [500000.0, 499999.0, 500001.0, "33543", "80"]]
    script = ("const C=require(process.argv[1]);const cal=JSON.parse(process.argv[2]);"
              "console.log(JSON.stringify(JSON.parse(process.argv[3]).map(a=>C.calibratedRange(a[0],a[1],a[2],a[3],cal,a[4]))));")
    out = json.loads(subprocess.run(["node", "-e", script, str(ROOT / "site" / "comps.js"), json.dumps(cal),
                                     json.dumps(cases)], capture_output=True, text=True, check=True).stdout)
    for js, args in zip(out, cases):
        assert js == pytest.approx(comps.calibrated_range(*args[:4], cal, args[4]), rel=1e-12)


def test_builder_closings_low_matches_python(built):
    from pipeline import builder
    tmp, site = built
    sales = pd.read_parquet(tmp / "work" / "sales.parquet")
    parcels = pd.read_parquet(tmp / "work" / "parcels.parquet")
    meta = json.loads((site / "counties" / "pasco" / "meta.json").read_text())
    # The fixture's builder sales are 2024-25 (inside the exported 24 months), so value as of then.
    as_of = pd.Timestamp("2025-03-31")
    assert meta["summary"]["builder_floor_check"]["n"] > 0
    b = builder.builder_sales(sales)
    has = parcels.apply(lambda s: builder.closings_low(s, b, as_of) is not None, axis=1)
    subjects = pd.concat([parcels[has].head(3), parcels[~has].head(1)])
    rows = []
    for z in ["33543", "33544"]:
        t = json.loads((site / "counties" / "pasco" / "sales" / f"{z}.json").read_text())
        rows += [dict(zip(t["cols"], r)) for r in t["rows"]]
    script = ("const C=require(process.argv[1]);"
              "const [subs,sales,asOf]=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              "console.log(JSON.stringify(subs.map(s=>C.builderClosingsLow(s,sales,asOf))));")
    subs = [{k: (None if pd.isna(v) else v) for k, v in s.items()} for s in subjects.to_dict("records")]
    stdin = json.dumps([subs, rows, "2025-03-31"], default=float)   # too long for a command line
    out = json.loads(subprocess.run(["node", "-e", script, str(ROOT / "site" / "comps.js")], input=stdin,
                                    capture_output=True, text=True, check=True).stdout)
    found = 0
    for js, (_, s) in zip(out, subjects.iterrows()):
        py = builder.closings_low(s, b, as_of)
        assert (js is None) == (py is None)
        if py:
            found += 1
            assert js["value"] == pytest.approx(py["value"], rel=1e-9) and js["n"] == py["n"]
    assert found >= 1


def test_autocomplete_number_with_partial_street_word():
    """"4250 W": many streets match "W" equally; the ones that have a 4250 must come first,
    and a street's own name beats its suffix (Warwick before ... Way)."""
    streets = [[f"{n} WAY", {"33543": "100 102"}] for n in ["ACRE", "ARYA", "BRAE", "COLT", "FAWN", "GULF", "HATZ",
                                                           "SKI", "ZULU", "ECHO", "ALFA", "OSLO", "KILO", "LIMA"]]
    streets += [["WARWICK HILLS DRIVE", {"33543": "4248 4250"}], ["RUDDER WAY", {"33543": "4250"}],
                ["WOOD TRAIL BOULEVARD", {"33544": "4250 4252"}]]
    idx = {"cities": {"33543": "Wesley Chapel", "33544": "Wesley Chapel"}, "streets": sorted(streets)}
    script = ("const A=require(process.argv[1]);const ix=A.prepare(JSON.parse(process.argv[2]));"
              "console.log(JSON.stringify(JSON.parse(process.argv[3]).map(q=>A.search(q,ix,8).map(x=>x.label))));")
    w, alone = json.loads(subprocess.run(["node", "-e", script, str(ROOT / "site" / "addr.js"), json.dumps(idx),
                                          json.dumps(["4250 W", "4250"])], capture_output=True, text=True, check=True).stdout)
    assert w[:2] == ["4250 Wood Trail Boulevard", "4250 Warwick Hills Drive"] or \
        set(w[:2]) == {"4250 Wood Trail Boulevard", "4250 Warwick Hills Drive"}
    assert w[2] == "4250 Rudder Way" and len(w) == 3                 # suffix match last; no numberless streets
    assert set(alone) == {"4250 Warwick Hills Drive", "4250 Rudder Way", "4250 Wood Trail Boulevard"}
