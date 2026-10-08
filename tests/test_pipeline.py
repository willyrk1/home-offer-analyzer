import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from pipeline import build, indicators, load, sources
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
    """Live-like files: Redfin has no price cuts and stops in May; Realtor.com fills in."""
    _, out, _ = built
    rec = json.loads((out / "zips" / "33543.json").read_text())
    ind = rec["indicators"]
    assert rec["county"] == "Pasco County" and rec["city"] == "Wesley Chapel"
    assert ind["zhvi_date"] == "2026-08"
    # The fixture declines 0.3%/month over the last 12 months.
    assert ind["zhvi_yoy_pct"] == pytest.approx((0.997 ** 12 - 1) * 100, abs=0.01)
    # Redfin: 90-day windows only (the 30-day junk rows are ignored), ending May 2026.
    assert ind["redfin_date"] == "2026-05"
    assert ind["avg_sale_to_list_pct"] == pytest.approx(96.8)
    assert ind["sale_to_list_yoy_pts"] == pytest.approx(-1.7)
    assert ind["price_drops_pct"] is None
    assert ind["months_of_supply"] == pytest.approx(ind["inventory"] / 20)
    # Price cuts, inventory and DOM come from Realtor.com, which is newer.
    assert ind["cuts_source"] == "Realtor.com" and ind["cuts_date"] == "2026-09"
    assert ind["cuts_pct"] == pytest.approx(30.0)
    assert ind["cuts_yoy_pts"] == pytest.approx(30.0 - 20.0)
    assert ind["inv_source"] == "Realtor.com"
    assert ind["inv_yoy_pct"] == pytest.approx((150 / 115 - 1) * 100)
    assert ind["dom_yoy_days"] == pytest.approx(12)
    assert rec["zillow_forecast"]["forecast_12m_pct"] == pytest.approx(-1.5)
    assert rec["signal"]["verdict"] == "Buyer leverage rising"
    assert rec["series"]["zhvi"][0][0] == "2018-01"
    assert rec["series"]["price_drops_pct"][-1] == ["2026-09", pytest.approx(30.0)]
    assert rec["series"]["active_listings"][-1][0] == "2026-09"


def test_complete_redfin_file_uses_redfin_price_cuts(tmp_path):
    raw = fixtures.write_all(tmp_path / "raw", redfin_live=False)
    build.build(raw, tmp_path / "out", tmp_path / "arch", ROOT / "coverage.yaml")
    ind = json.loads((tmp_path / "out" / "zips" / "33543.json").read_text())["indicators"]
    assert ind["redfin_date"] == "2026-08"
    assert ind["cuts_source"] == "Redfin"
    assert ind["cuts_pct"] == pytest.approx(27.0)
    assert ind["cuts_yoy_pts"] == pytest.approx(9.0)
    assert ind["months_of_supply"] == pytest.approx(3.4)


def test_build_without_realtor_file(tmp_path):
    raw = fixtures.write_all(tmp_path / "raw")
    (raw / Path(sources.SOURCES["realtor_zip"]).name).unlink()
    result = build.build(raw, tmp_path / "out", tmp_path / "arch", ROOT / "coverage.yaml")
    assert result["realtor"] is False
    rec = json.loads((tmp_path / "out" / "zips" / "33543.json").read_text())
    assert rec["indicators"]["cuts_pct"] is None
    assert rec["indicators"]["inv_source"] == "Redfin"
    # Without price-cut data the read still scores what it has.
    assert rec["signal"]["counted"] == 3


def test_optional_download_failure_does_not_stop_build(tmp_path, monkeypatch):
    sample = fixtures.write_all(tmp_path / "sample")

    def fake_download(name, dest_dir):
        if name == "realtor_zip":
            raise OSError("403 Forbidden")
        target = dest_dir / Path(sources.SOURCES[name]).name
        dest_dir.mkdir(parents=True, exist_ok=True)
        target.write_bytes((sample / target.name).read_bytes())
        return target

    monkeypatch.setattr(sources, "download", fake_download)
    out = tmp_path / "out"
    build.main(["--raw-dir", str(tmp_path / "raw"), "--out-dir", str(out),
                "--archive-dir", str(tmp_path / "arch")])
    diag = json.loads((out / "diagnostics.json").read_text())
    assert "403" in diag["download_errors"]["realtor_zip"]
    assert diag["realtor"] is None


def test_required_download_failure_stops_build(tmp_path, monkeypatch):
    def fail(name, dest_dir):
        raise OSError("down")
    monkeypatch.setattr(sources, "download", fail)
    with pytest.raises(OSError):
        build.main(["--raw-dir", str(tmp_path / "raw"), "--out-dir", str(tmp_path / "o")])


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


def test_diagnostics_written(built):
    _, out, _ = built
    d = json.loads((out / "diagnostics.json").read_text())
    rf = d["redfin"]
    assert rf["period_durations"] == [30, 90]
    assert "price_drops" in rf["columns"]
    assert rf["latest_covered"] == "2026-05"
    assert rf["non_empty_any_date"]["price_drops"] == 0
    assert d["realtor"]["latest_covered"] == "2026-09"
    assert d["realtor"]["covered_zips_with_data"] == 4
    assert d["zillow"]["zips_with_forecast"] == 4
