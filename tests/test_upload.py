"""site/upload.js: a Redfin "recently sold" CSV becomes extra comps (browser only)."""
import json
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from pipeline import county_build
from tests import pasco_fixtures as fx

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

# Redfin's export header (Download All under search results).
HEADER = ('SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,'
          'LOCATION,SQUARE FEET,LOT SIZE,YEAR BUILT,DAYS ON MARKET,$/SQUARE FEET,HOA/MONTH,STATUS,'
          'NEXT OPEN HOUSE START TIME,NEXT OPEN HOUSE END TIME,'
          '"URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)",'
          'SOURCE,MLS#,FAVORITE,INTERESTED,LATITUDE,LONGITUDE')


def row(sold, address, zip_code, price, sqft, sale_type="PAST SALE"):
    return (f'{sale_type},{sold},Single Family Residential,"{address}",Wesley Chapel,FL,{zip_code},{price},4,3,'
            f'Union Park,{sqft},6098,2018,,175,90,Sold,,,https://www.redfin.com/FL/x,Stellar MLS,TB1,N,Y,28.18,-82.28')


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("up")
    raw = fx.write_all(tmp / "raw")
    site = tmp / "site"
    (site / "zips").mkdir(parents=True)
    for z in ["33543", "33544"]:
        (site / "zips" / f"{z}.json").write_text(json.dumps({"zip": z, "series": {"zhvi": fx.zhvi_series()}}))
    county_build.build_county("pasco", raw, tmp / "work", site, offline=True)
    return tmp, site


def run(site, csv_text, subject_address):
    """Parse the CSV, match it, then value the subject with county + uploaded sales (as value.js does)."""
    script = r"""
const fs = require("fs"), path = require("path");
const Comps = require(process.argv[1]); global.Comps = Comps;
const Upload = require(process.argv[2]);
const base = path.join(process.argv[3], "counties", "pasco");
const read = (f) => JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
const meta = read("meta.json"), model = read("model.json"), tindex = read("tindex.json");
const csv = fs.readFileSync(0, "utf8");
const parsed = Upload.parseRedfin(csv);
const zips = meta.zips;
const parcels = Object.fromEntries(zips.map((z) => [z, Comps.fromTable(read(`parcels/${z}.json`))]));
const county = zips.flatMap((z) => Comps.fromTable(read(`sales/${z}.json`)));
const out = Upload.toComps(parsed, Upload.indexParcels(parcels), county);
const subj = Object.values(parcels).flat().find((p) => p.address_key === Comps.normalizeAddress(process.argv[4]));
let asOf = meta.latest_sale;
for (const s of out.added) if (s.date > asOf) asOf = s.date;
const all = county.concat(out.added);
const r = Comps.valueSubject(subj, all, model, tindex, { asOf });
const why = out.added.length ? Comps.explain(Comps.normalizeAddress(out.added[0].address), subj, all, model, tindex, r) : null;
console.log(JSON.stringify({ parsed: parsed.sales.length, added: out.added, skipped: out.skipped, as_of: r.as_of,
  why: why && { verdict: why.verdict, reasons: why.reasons, sale_source: why.sale && why.sale.source || null },
  latest_county: meta.latest_sale, comps: r.comps.map((c) => ({ parcel_id: c.parcel_id, source: c.source || null })) }));
"""
    args = ["node", "-e", script, str(ROOT / "site" / "comps.js"), str(ROOT / "site" / "upload.js"), str(site), subject_address]
    return json.loads(subprocess.run(args, input=csv_text, capture_output=True, text=True, check=True).stdout)


def test_redfin_rows_matched_deduped_and_used(built):
    tmp, site = built
    sales = pd.read_parquet(tmp / "work" / "sales.parquet")
    recorded = sales[sales["sale_class"] == "market"].iloc[-1]          # a sale the county already has
    parcels = pd.read_parquet(tmp / "work" / "parcels.parquet")
    near = parcels[(parcels["subdivision"] == "35-26-20-0080") & (parcels["address_key"] != "1295 MONTGOMERY BELL ROAD")
                   & (parcels["property_type"] == "single_family")
                   & ~parcels["parcel_id"].isin(sales.loc[sales["date"] > "2026-07-01", "parcel_id"])]
    # A near-twin of the subject (same size) sold after the county's last recorded sale.
    twin = near.iloc[(near["sqft"] - 2571).abs().argsort()].iloc[0]
    csv = "\r\n".join([
        HEADER,
        '"In accordance with local MLS rules, some MLS listings are not included in the download",,,,,,,,,,,,,,,,,,,,,,,,,,',
        row("October-6-2026", twin["address"], twin["zip"], 455000, int(twin["sqft"])),
        row(pd.Timestamp(recorded["date"]).strftime("%B-%d-%Y"), recorded["address"], recorded["zip"], int(recorded["price"]), 2000),
        row("October-2-2026", "9 Nowhere Lane", "33543", 400000, 2000),
        row("", "1010 Watoga Loop", "33543", 425000, 2000, sale_type="MLS Listing"),
        row("Sep-30-2026", "77 Elsewhere Rd", "32801", 300000, 1800),
    ]) + "\r\n"
    out = run(site, csv, "1295 Montgomery Bell Road")
    assert len(out["added"]) == 1 and out["added"][0]["parcel_id"] == twin["parcel_id"]
    added = out["added"][0]
    assert added["sqft"] == twin["sqft"] and added["source"] == "redfin_upload" and added["date"] == "2026-10-06"
    reasons = " | ".join(s["reason"] for s in out["skipped"])
    assert "already in county records" in reasons and "no county parcel" in reasons
    assert "not a sale" in reasons and "isn't in this county" in reasons
    assert all(s["line"] != 2 for s in out["skipped"]) and len(out["skipped"]) == 4   # footnote ignored silently
    # As-of moves to the newest sale, and the near-twin is used as a comp.
    assert out["as_of"] == "2026-10-06" > out["latest_county"]
    # The uploaded sale is a real candidate: a comp, or ranked lower only on similarity (never
    # excluded for its date, class or property type).
    why = out["why"]
    assert why["sale_source"] == "redfin_upload"
    in_comps = {"parcel_id": twin["parcel_id"], "source": "redfin_upload"} in out["comps"]
    assert in_comps or all(r.startswith("Less similar") or "away" in r for r in why["reasons"]), why


def test_dates_and_csv_quoting():
    script = ("const U=require(process.argv[1]);console.log(JSON.stringify([U.isoDate('September-15-2026'),"
              "U.isoDate('Sep-5-2026'),U.isoDate('9/5/2026'),U.isoDate('2026-09-05'),U.isoDate(''),"
              "U.parseCSV('a,\"b, \"\"c\"\"\",d\\r\\n1,2,3')]))")
    out = json.loads(subprocess.run(["node", "-e", script, str(ROOT / "site" / "upload.js")],
                                    capture_output=True, text=True, check=True).stdout)
    assert out[:5] == ["2026-09-15", "2026-09-05", "2026-09-05", "2026-09-05", None]
    assert out[5] == [["a", 'b, "c"', "d"], ["1", "2", "3"]]


def test_upload_never_leaves_the_browser():
    """No network calls in the upload module (MLS data must not be sent or published)."""
    src = (ROOT / "site" / "upload.js").read_text(encoding="utf-8")
    assert not any(w in src for w in ("fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket"))
