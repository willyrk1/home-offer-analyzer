import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from pipeline import build, indicators, load
from tests import fixtures

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def built(tmp_path):
    raw = fixtures.write_all(tmp_path / "raw")
    out, archive = tmp_path / "site", tmp_path / "archive"
    result = build.build(raw, out, archive, ROOT / "coverage.yaml", today=date(2026, 10, 7))
    return result, out, archive


def test_only_covered_zips_are_built(built):
    result, out, _ = built
    index = json.loads((out / "index.json").read_text())
    zips = {z["zip"] for z in index["zips"]}
    assert zips == {"33543", "33544", "37323", "37919"}  # 90210 is not covered
    assert result["zips"] == 4
    assert not (out / "zips" / "90210.json").exists()


def test_zip_record_contents(built):
    _, out, _ = built
    rec = json.loads((out / "zips" / "33543.json").read_text())
    ind = rec["indicators"]
    assert rec["county"] == "Pasco County" and rec["city"] == "Wesley Chapel"
    assert ind["zhvi_date"] == "2026-08" and ind["redfin_date"] == "2026-08"
    # The fixture declines 0.3%/month over the last 12 months.
    assert ind["zhvi_yoy_pct"] == pytest.approx((0.997 ** 12 - 1) * 100, abs=0.01)
    # Price cuts are compared with the same month a year earlier (both non-seasonal months).
    assert ind["price_drops_pct"] == pytest.approx(27.0)
    assert ind["price_drops_yoy_pts"] == pytest.approx(27.0 - 18.0)
    assert ind["median_dom_yoy_days"] == pytest.approx(20)
    assert ind["inventory_vs_2019_pct"] > 0
    assert rec["zillow_forecast"]["forecast_12m_pct"] == pytest.approx(-1.5)
    assert rec["signal"]["verdict"] == "Buyer leverage rising"
    assert rec["series"]["zhvi"][0][0] == "2018-01"
    assert rec["indicators_single_family"]["median_sale_price"] > ind["median_sale_price"]


def test_forecast_archived_once_per_base_month(built, tmp_path):
    result, _, archive = built
    saved = Path(result["archived"])
    assert saved.name == "zillow_forecast_2026-08.csv"
    assert len(pd.read_csv(saved)) == 4
    raw = tmp_path / "raw"
    again = build.build(raw, tmp_path / "site2", archive, ROOT / "coverage.yaml")
    assert again["archived"] is None  # same base month: not overwritten


def test_extra_zips_are_included(tmp_path):
    raw = fixtures.write_all(tmp_path / "raw")
    cov = tmp_path / "cov.yaml"
    cov.write_text("counties: []\nextra_zips: [90210]\n")
    result = build.build(raw, tmp_path / "out", tmp_path / "arch", cov)
    assert result["zips"] == 1


def test_seasonal_months_compare_against_same_month():
    # Same seasonal bump in both years -> no year-over-year change in price cuts.
    dates = pd.to_datetime(["2025-10-01", "2026-10-01"])
    rf = pd.DataFrame({"date": dates, "price_drops": [0.30, 0.30], "inventory": [100, 100],
                       "median_dom": [40, 40], "avg_sale_to_list": [0.97, 0.97]})
    ind = indicators.redfin_indicators(rf)
    assert ind["price_drops_yoy_pts"] == pytest.approx(0)
    assert indicators.market_signal(ind)["verdict"] == "Mixed / balanced"


def test_signal_handles_missing_data():
    assert indicators.market_signal({})["verdict"] == "Not enough data"


def test_zip5_pads_leading_zeros():
    assert load.zip5(2134) == "02134"
    assert load.zip5("02134") == "02134"
