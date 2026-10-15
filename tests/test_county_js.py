"""site/county.js: the value page's settings travel in the link to math.html, and both pick the same method and range."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def js(expr, data=None):
    script = (f"const C=require({json.dumps(str(ROOT / 'site' / 'county.js'))});"
              "const D=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              f"console.log(JSON.stringify({expr}));")
    out = subprocess.run(["node", "-e", script], input=json.dumps(data), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_plain_address_link_still_works():
    s = js('C.decodeSettings("#a=1295%20Montgomery%20Bell%20Rd%2C%20Wesley%20Chapel")')
    assert s == {"a": "1295 Montgomery Bell Rd, Wesley Chapel", "method": None, "level": "80", "time": "zip",
                 "includeDistressed": True, "excluded": [], "forced": [], "focus": None}
    # defaults stay out of the link
    assert js('C.encodeSettings(C.decodeSettings("#a=12%20Main%20St"))') == "#a=12%20Main%20St"


def test_every_setting_round_trips():
    s = {"a": "32101 Goddard Dr, Wesley Chapel, FL 33543", "method": "comps", "level": "50", "time": "nbhd",
         "includeDistressed": False, "excluded": ["35-26-20-0090-00000-1380", "35-26-20-0020-00100-0090"],
         "forced": [{"parcel_id": "23-26-20-0140-00000-3300", "date": "2026-05-01"}], "focus": "35-26-20-0240-00800-0010"}
    assert js("C.decodeSettings(C.encodeSettings(D))", s) == s


def test_added_comps_found_by_parcel_and_date():
    sales = [{"parcel_id": "p1", "date": "2025-01-02", "price": 1}, {"parcel_id": "p1", "date": "2026-05-01", "price": 2},
             {"parcel_id": "p2", "date": "2026-05-01", "price": 3}]
    got = js('C.findForced([{parcel_id:"p1",date:"2026-05-01"},{parcel_id:"gone",date:"2026-01-01"}], D)', sales)
    assert [g["price"] for g in got] == [2]          # the right sale; one no longer in the data is dropped


def test_method_and_range_choice():
    bt = {"methods": {"best": "blend", "ranges": {"comps": {"levels": {"50": {}, "80": {}, "90": {}}}}}}
    r = {"methods": {"comps": {"fair_value": 1}, "assessed": {"fair_value": None}, "blend": {"fair_value": None}}}
    d = {"bt": bt, "r": r}
    assert js('C.pickMethod(D.r, "assessed", D.bt)', d) == "comps"     # picked and best unavailable -> comps
    d["r"]["methods"]["blend"]["fair_value"] = 2
    assert js("C.pickMethod(D.r, null, D.bt)", d) == "blend"           # no pick -> the backtest's best
    assert js('C.pickMethod(D.r, "comps", D.bt)', d) == "comps"        # your pick wins
    assert js('C.calibration(D.bt, "comps", "95").level', d) == "80"   # unfitted level falls back to 80%
    assert js('C.calibration(D.bt, "blend", "50")', d) == {"cal": None, "level": "50"}
