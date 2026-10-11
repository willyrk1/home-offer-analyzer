"""site/trend.js: local price trend by 3-month window, and year-over-year on the same months."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def js(expr, data):
    script = (f"const T=require({json.dumps(str(ROOT / 'site' / 'trend.js'))});"
              "const D=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              f"console.log(JSON.stringify({expr}));")
    out = subprocess.run(["node", "-e", script], input=json.dumps(data), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def sale(date, price, sqft=2000, jv=300000, nbhd="LXOK", sale_class="market", zip_code="33544"):
    return {"parcel_id": f"p{date}{price}", "date": date, "price": price, "sqft": sqft, "just_value": jv,
            "nbhd": nbhd, "subdivision": "10-26-19-0110", "zip": zip_code, "sale_class": sale_class}


SUBJECT = {"nbhd": "LXOK", "subdivision": "10-26-19-0110", "zip": "33544"}


def test_windows_and_year_over_year():
    sales = ([sale(f"2026-0{m}-15", 330000) for m in range(4, 10) for _ in range(2)]          # 12 recent, ratio 1.10
             + [sale(f"2025-0{m}-15", 360000) for m in range(4, 10) for _ in range(2)]        # 12 a year ago, 1.20
             + [sale("2026-09-01", 1, sale_class="distressed"), sale("2026-09-01", 999999, nbhd="OTHR")])
    t = js("T.local(D.subject, D.sales, '2026-09-29', 'nbhd', D.tindex)",
           {"subject": SUBJECT, "sales": sales, "tindex": {"33544": [["2025-09", 100], ["2026-09", 95]]}})
    w = t["windows"]
    assert len(w) == 8 and (w[0]["from"], w[0]["to"]) == ("2026-06-29", "2026-09-29")
    assert w[0]["n"] == 6 and w[0]["ratio"] == pytest.approx(1.1) and w[0]["ppsf"] == pytest.approx(165)
    y = t["yoy"]
    assert y["enough"] and (y["now"]["n"], y["before"]["n"]) == (12, 12)
    assert y["ratio_pct"] == pytest.approx((1.1 / 1.2 - 1) * 100)
    assert t["zhvi"]["pct"] == pytest.approx(-5) and t["zhvi"]["month"] == "2026-09"


def test_too_few_sales_and_other_groups():
    sales = [sale("2026-08-01", 300000), sale("2025-08-01", 300000, nbhd="OTHR")]
    t = js("[T.local(D.subject, D.sales, '2026-09-29', 'nbhd'), T.local(D.subject, D.sales, '2026-09-29', 'zip')]",
           {"subject": SUBJECT, "sales": sales})
    assert not t[0]["yoy"]["enough"] and t[0]["yoy"]["now"]["n"] == 1 and t[0]["yoy"]["before"]["n"] == 0
    assert t[1]["yoy"]["before"]["n"] == 1 and t[1]["label"] == "ZIP"
