"""site/offer.js: offer positions and the concessions converter."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def js(expr):
    script = f"const O=require({json.dumps(str(ROOT / 'site' / 'offer.js'))});console.log(JSON.stringify({expr}));"
    return json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)


def test_offer_positions_and_list_price_caps():
    rng = "[424284, 479613]"
    p = js(f"O.plan(451101, {rng}, null)")
    assert (p["opening"], p["target"], p["walkaway"]) == (424000, 451000, 479000) and p["notes"] == []
    assert p["appraisal_gap"]["walkaway"] == pytest.approx(479000 - 451101)
    high = js(f"O.plan(451101, {rng}, 485000)")
    assert high["notes"] == ["listed_high"] and high["walkaway"] == 479000
    capped = js(f"O.plan(451101, {rng}, 460000)")
    assert capped["walkaway"] == 460000 and capped["target"] == 451000          # never above list
    low = js(f"O.plan(451101, {rng}, 420000)")
    assert low["notes"] == ["listed_low"] and low["opening"] == low["target"] == 420000
    assert js("O.plan(null, null, 1)") is None


def test_concessions_math():
    # 30-year payment on $360,800 at 6.5%: standard amortization formula.
    r = 0.065 / 12
    expected = 360800 * r / (1 - (1 + r) ** -360)
    c = js("O.concessions({price: 451000, credit: 10000, downPct: 20, ratePct: 6.5, dropPerPoint: 0.25})")
    assert c["loan"] == pytest.approx(360800) and c["payment"] == pytest.approx(expected)
    assert c["buydown"]["points"] == pytest.approx(10000 / 3608)
    assert c["buydown"]["new_rate"] == pytest.approx(6.5 - 0.25 * 10000 / 3608)
    assert c["price_cut"]["cash_saved"] == pytest.approx(2000)
    # Price-cut equivalent of the buydown gives the same monthly saving as that price cut would.
    per = expected / 360800
    assert c["buydown"]["price_cut_equivalent"] * 0.8 * per == pytest.approx(c["buydown"]["monthly_saving"])


def test_builder_floor_is_cost_plus_margin():
    # The spec's example: $60K lot + 2,314 sq ft x $140 = $383,960; x 1.15 = $441,554.
    f = js("O.builderFloor({lot: 60000, costPerSqft: 140, sqft: 2314})")
    assert f["cost"] == pytest.approx(383960) and f["floor"] == pytest.approx(441554)
    carry = js("O.builderFloor({lot: 60000, costPerSqft: 140, sqft: 2314, marginPct: 18, carryMonthly: 2500, carryMonths: 4})")
    assert carry["carry"] == 10000 and carry["floor"] == pytest.approx(393960 * 1.18)
    assert js("O.builderFloor({lot: 60000, costPerSqft: 0, sqft: 2314})") is None     # nothing invented
    assert js("O.builderFloor({lot: NaN, costPerSqft: 140, sqft: 2314})") is None
    # The offer prices never depend on it.
    assert js("O.plan(451101, [424284, 479613], 485000)")["opening"] == 424000
