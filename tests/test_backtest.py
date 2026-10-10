import pandas as pd
import pytest

from pipeline import backtest, comps, county_build
from tests import pasco_fixtures as fx


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("bt")
    raw = fx.write_all(tmp / "raw")
    site = tmp / "site"
    (site / "zips").mkdir(parents=True)
    county_build.build_county("pasco", raw, tmp / "work", site, offline=True)
    parcels = pd.read_parquet(tmp / "work" / "parcels.parquet")
    sales = pd.read_parquet(tmp / "work" / "sales.parquet")
    tindex = comps.TimeIndex({z: fx.zhvi_series() for z in ["33543", "33544"]})
    return parcels, sales, tindex


def test_backtest_values_recent_market_sales(built):
    parcels, sales, tindex = built
    df = backtest.run(parcels, sales, tindex, months=6)
    end = sales["date"].max()
    recent = sales[(sales["sale_class"] == "market") & (sales["date"] > end - pd.DateOffset(months=6))]
    assert len(df) == len(recent)
    assert df["fair_value"].notna().all()
    rep = backtest.report(df)
    # Fixture prices are a known formula + 4% noise, so the engine should land close.
    assert rep["overall"]["median_abs_error_pct"] < 8
    assert set(rep["by"]["property_type"]) <= {"single_family", "townhome"}
    assert "ALL" in backtest.render(rep)


def test_backtest_uses_no_later_data(built):
    """Inflating every price after a cutoff must not change valuations of sales up to the cutoff."""
    parcels, sales, tindex = built
    cutoff = sales["date"].max() - pd.DateOffset(months=2)
    base = backtest.run(parcels, sales, tindex, months=6)
    future = sales.copy()
    future.loc[future["date"] > cutoff, "price"] *= 10
    later_index = comps.TimeIndex({z: [[m, v * (10 if m > cutoff.strftime("%Y-%m") else 1)]
                                       for m, v in fx.zhvi_series()] for z in ["33543", "33544"]})
    moved = backtest.run(parcels, future, later_index, months=6)
    before = base["sale_date"] <= cutoff
    assert before.sum() > 20
    pd.testing.assert_series_equal(base.loc[before, "fair_value"], moved.loc[before, "fair_value"])


def test_time_index_through():
    ti = comps.TimeIndex({"33543": [["2026-01", 100.0], ["2026-02", 110.0], ["2026-03", 121.0]]})
    f, note = ti.through("2026-02").factor("33543", pd.Timestamp("2026-01-15"))
    assert f == pytest.approx(1.10) and note == "2026-01 -> 2026-02"


def test_regression_baseline_and_settings(built):
    parcels, sales, tindex = built
    before = (dict(comps.SIM), comps.MIN_COMPS, list(comps.SEARCH))
    df = backtest.run(parcels, sales, tindex, months=3, config={"size": 2.0, "MIN_COMPS": 4, "search_scale": 2})
    assert (dict(comps.SIM), comps.MIN_COMPS, list(comps.SEARCH)) == before   # restored afterwards
    base = backtest.summarize(df)["regression_only"]
    # The fixture's prices are the regression's own functional form, so it alone should be close.
    assert base["median_abs_error_pct"] < 6
    with pytest.raises(KeyError):
        with backtest.settings({"nonsense": 1}):
            pass


def test_calibrated_ranges_hold_their_share(built):
    parcels, sales, tindex = built
    df = backtest.run(parcels, sales, tindex, months=9)
    rep = backtest.report(df)
    cal = rep["methods"]["ranges"]["blend"]
    assert cal is not None and set(cal["levels"]) == {"50", "80", "90"}
    held = [cal["levels"][lv]["check_coverage_pct"] for lv in ("50", "80", "90")]
    assert held == sorted(held) and 30 < held[0] < 75 and held[2] > 75   # wider levels hold more
    lo, hi = comps.calibrated_range(400_000, 380_000, 420_000, "33543", cal, "80")
    assert lo < 400_000 < hi and hi / 400_000 == pytest.approx(400_000 / lo)
    assert comps.calibrated_range(None, None, None, "33543", cal) is None
    # Price bands come from our value, so every valued sale has one.
    assert sum(s["n"] for s in rep["methods"]["by_method"]["blend"]["by"]["price_band"].values()) >= \
        rep["methods"]["by_method"]["blend"]["overall"]["valued"] - 30 * 6
