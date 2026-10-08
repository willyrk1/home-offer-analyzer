import json
import math

import numpy as np
import pandas as pd
import pytest

from pipeline import comps, comps_report, county_build, valuation
from pipeline.counties import pasco
from tests import pasco_fixtures as fx


@pytest.fixture(scope="module")
def raw(tmp_path_factory):
    return fx.write_all(tmp_path_factory.mktemp("pasco"))


@pytest.fixture(scope="module")
def paths(raw):
    return {k: raw / pd.io.common.os.path.basename(u) for k, u in pasco.FILES.items()}


@pytest.fixture(scope="module")
def parcels(paths):
    return pasco.build_parcels(paths)


@pytest.fixture(scope="module")
def sales(paths, parcels):
    return pasco.build_sales(paths, parcels)


def test_address_normalization():
    assert pasco.normalize_address("1295 Montgomery Bell Rd NE") == "1295 MONTGOMERY BELL ROAD"
    assert pasco.normalize_address("32237 Watoga Loop, Wesley Chapel") == "32237 WATOGA LOOP WESLEY CHAPEL"
    assert pasco.normalize_address("1755 Tonka Ter.") == "1755 TONKA TERRACE"
    assert pasco.normalize_address("10 Main St Unit 4") == "10 MAIN STREET"


def test_parcels_residential_only_with_features(parcels):
    assert len(parcels) == 700                      # the commercial building is dropped
    assert set(parcels["property_type"]) <= {"single_family", "townhome", "condo"}
    subj = parcels[parcels["address_key"] == "1295 MONTGOMERY BELL ROAD"].iloc[0]
    assert subj["sqft"] == 2571 and subj["year_built"] == 2018 and not subj["pool"]
    assert subj["nbhd"] == "UNPK" and subj["subdivision"] == "35-26-20-0080"
    assert parcels["pool"].sum() > 100              # RPOOL* codes detected
    # Shapefile parcel column found automatically and projected to lat/lon.
    assert parcels["lat"].between(28.16, 28.21).all() and parcels["lon"].between(-82.31, -82.26).all()


def test_sale_classification(paths):
    s = pasco.load_sales(paths["sales"])
    assert (s.loc[s["deed_type"] == "QC", "sale_class"] == "non_market").all()
    assert (s.loc[pd.to_numeric(s["qual_code"]) == 12, "sale_class"] == "distressed").all()
    assert (s.loc[pd.to_numeric(s["qual_code"]) == 37, "sale_class"] == "non_market").all()
    multi = s[s["book_page"] == "77777/7"]
    assert len(multi) == 2 and (multi["sale_class"] == "non_market").all()
    assert "88888/8" not in set(s["book_page"])     # vacant-land sale ignored
    assert (s["sale_class"] == "market").mean() > 0.8


def test_classify_handles_codes_with_and_without_leading_zero():
    df = pd.DataFrame({"qual_code": ["12", "012", "19", "01", "38"], "qualified": ["U", "U", "U", "Q", "U"],
                       "deed_type": ["WD"] * 5, "price": [200000] * 5, "multi_parcel": [False] * 5})
    assert pasco.classify_sales(df).tolist() == ["distressed", "distressed", "distressed", "market", "distressed"]


def test_regression_recovers_feature_values(sales):
    m = valuation.fit(sales)
    f = m["features"]
    assert f["ln_sqft"]["coef"] == pytest.approx(fx.TRUE["ln_sqft"], abs=0.05)
    assert f["pool"]["coef"] == pytest.approx(fx.TRUE["pool"], abs=0.02)
    assert f["age"]["coef"] == pytest.approx(fx.TRUE["age"], abs=0.003)
    assert m["r2"] > 0.8 and m["median_abs_pct_error"] < 5


def test_regression_needs_enough_sales(sales):
    with pytest.raises(ValueError):
        valuation.fit(sales.head(50))


def test_comps_value_close_to_formula(parcels, sales):
    model = valuation.fit(sales)
    flat = comps.TimeIndex({"33543": fx.zhvi_series(monthly=0.0), "33544": fx.zhvi_series(monthly=0.0)})
    subj = comps.find_subject(parcels, "1295 Montgomery Bell Rd, Wesley Chapel, FL 33543",
                              pasco.normalize_address)
    r = comps.value_subject(subj, sales, model, flat)
    as_of = pd.Timestamp(r["as_of"])
    age = as_of.year - 2018
    truth = math.exp(8.1 + 0.7 * math.log(2571) - 0.004 * age + 0.03 * 3.0 + 0.06 * math.log(0.14) + 0.05)
    assert r["fair_value"] == pytest.approx(truth, rel=0.06)
    assert 6 <= len(r["comps"]) <= 8
    assert all(c["parcel_id"] != subj["parcel_id"] for c in r["comps"])
    assert r["range"][0] < r["fair_value"] < r["range"][1]
    # Every comp shows its work.
    c = r["comps"][0]
    assert {"time_factor", "adjustments", "adjusted_price", "net_pct", "gross_pct", "weight"} <= c.keys()


def test_time_adjustment_uses_zip_index(parcels, sales):
    model = valuation.fit(sales)
    rising = comps.TimeIndex({"33543": fx.zhvi_series(monthly=0.01), "33544": fx.zhvi_series(monthly=0.01)})
    flat = comps.TimeIndex({"33543": fx.zhvi_series(monthly=0.0), "33544": fx.zhvi_series(monthly=0.0)})
    subj = comps.find_subject(parcels, "1295 Montgomery Bell Rd", pasco.normalize_address)
    up = comps.value_subject(subj, sales, model, rising)
    level = comps.value_subject(subj, sales, model, flat)
    assert up["fair_value"] > level["fair_value"]
    assert all(c["time_factor"] >= 1.0 for c in up["comps"])


def test_unknown_address_suggests_matches(parcels):
    with pytest.raises(LookupError, match="Similar"):
        comps.find_subject(parcels, "1295 Nowhere Rd", pasco.normalize_address)


def test_county_build_and_report(raw, tmp_path, capsys):
    site = tmp_path / "site"
    (site / "zips").mkdir(parents=True)
    for z in ["33543", "33544"]:
        (site / "zips" / f"{z}.json").write_text(json.dumps({"zip": z, "series": {"zhvi": fx.zhvi_series()}}))
    r = county_build.build_county("pasco", raw, tmp_path / "work", site, offline=True)
    assert r["summary"]["parcels_with_location"] == 700
    assert (site / "counties" / "pasco" / "model.json").exists()
    comps_report.main(["1295 Montgomery Bell Rd", "--work-dir", str(tmp_path / "work"),
                       "--site-dir", str(site)])
    out = capsys.readouterr().out
    assert "FAIR VALUE" in out and "ADJUSTED" in out and "1295 Montgomery Bell Road" in out
