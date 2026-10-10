"""Backtest the comps engine on past sales.

For each market sale in the last `months` months, value the home as of the day
before it sold, using only what was known then:
  - comps: sales recorded on or before that day, the home's own sales excluded
  - county model: refit each month on sales before that month
  - time index: ZIP home value index through the month before (Zillow publishes
    each month's value in the middle of the next month)
then compare the fair value with the price it actually sold for.

    python -m pipeline.backtest                 # last 12 months of Pasco market sales
    python -m pipeline.backtest --sample 500    # quicker, random subset

Writes work/<county>/backtest.parquet (one row per sale) and
site/data/counties/<county>/backtest.json (summary only).

Known limits: home features are the appraiser's current record, not as of the
sale (a pool added later counts as there at the time); Zillow revises past
index values, so the index used is today's version of the history.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pandas as pd

from . import comps, comps_report, valuation
from .build import _clean

ROOT = Path(__file__).resolve().parent.parent
PRICE_BANDS = [0, 250_000, 350_000, 450_000, 600_000, 800_000, math.inf]
RANGE_LEVELS = ("50", "80", "90")   # % of sales a range should hold
POOL_MONTHS = 19      # longest search window (18 months) plus slack
BOX_MILES = 5.2       # widest search radius (5 mi) plus slack


def _band(price: float) -> str:
    for lo, hi in zip(PRICE_BANDS, PRICE_BANDS[1:]):
        if lo <= price < hi:
            if lo == 0:
                return f"Under ${hi / 1000:.0f}K"
            return f"${lo / 1000:.0f}K+" if hi == math.inf else f"${lo / 1000:.0f}K–{hi / 1000:.0f}K"
    return "?"


def _nearby(pool: pd.DataFrame, subject: pd.Series) -> pd.DataFrame:
    """Rough lat/lon box around the subject, so each valuation scans a few hundred sales, not 100K."""
    if pd.isna(subject["lat"]):
        return pool
    dlat = BOX_MILES / 69.0
    dlon = BOX_MILES / (69.0 * math.cos(math.radians(subject["lat"])))
    near = pool["lat"].between(subject["lat"] - dlat, subject["lat"] + dlat) & \
        pool["lon"].between(subject["lon"] - dlon, subject["lon"] + dlon)
    return pool[near]


@contextmanager
def settings(config: dict | None):
    """Temporarily override comps-engine settings: SIM weights by name, plus MIN_COMPS,
    MAX_COMPS, DISTRESSED_WEIGHT and search_scale (multiplies every search radius)."""
    config = config or {}
    saved = (dict(comps.SIM), comps.MIN_COMPS, comps.MAX_COMPS, comps.DISTRESSED_WEIGHT, list(comps.SEARCH))
    try:
        for k, v in config.items():
            if k in comps.SIM:
                comps.SIM[k] = v
            elif k in ("MIN_COMPS", "MAX_COMPS", "DISTRESSED_WEIGHT"):
                setattr(comps, k, v)
            elif k == "search_scale":
                comps.SEARCH = [(round(r * v, 3), m) for r, m in saved[4]]
            else:
                raise KeyError(f"unknown setting {k!r}")
        yield
    finally:
        comps.SIM.clear(); comps.SIM.update(saved[0])
        comps.MIN_COMPS, comps.MAX_COMPS, comps.DISTRESSED_WEIGHT, comps.SEARCH = saved[1:]


def subjects_for(parcels: pd.DataFrame, sales: pd.DataFrame, months: int = 12,
                 sample: int | None = None, seed: int = 1) -> pd.DataFrame:
    """Market sales from the last `months` months whose parcel is on file."""
    end = sales["date"].max()
    subjects = sales[(sales["sale_class"] == "market")
                     & (sales["date"] > end - pd.DateOffset(months=months))]
    subjects = subjects[subjects["parcel_id"].isin(parcels["parcel_id"])]
    if sample and sample < len(subjects):
        subjects = subjects.sample(sample, random_state=seed)
    return subjects


def month_context(sales: pd.DataFrame, tindex: comps.TimeIndex, month: pd.Period, cache: dict | None = None):
    """Model, time index and candidate sales as they stood at the start of `month`."""
    if cache is not None and month in cache:
        return cache[month]
    first = month.start_time
    model = valuation.fit(sales[sales["date"] < first], effects=True)
    t_month = (first - pd.DateOffset(months=1)).strftime("%Y-%m")
    window = sales[(sales["date"] > first - pd.DateOffset(months=POOL_MONTHS)) & (sales["date"] <= month.end_time)]
    ctx = (model, tindex.through(t_month), t_month, window)
    if cache is not None:
        cache[month] = ctx
    return ctx


def run(parcels: pd.DataFrame, sales: pd.DataFrame, tindex: comps.TimeIndex, months: int = 12,
        sample: int | None = None, seed: int = 1, progress: bool = False,
        subjects: pd.DataFrame | None = None, cache: dict | None = None,
        config: dict | None = None) -> pd.DataFrame:
    """One row per backtested sale. `sales` is market + distressed sales (sales.parquet).
    Pass `subjects` to choose the sales, `cache` (a dict) to reuse monthly models across
    runs, and `config` to try different engine settings (see `settings`)."""
    if subjects is None:
        subjects = subjects_for(parcels, sales, months, sample, seed)
    parcel_by_id = parcels.drop_duplicates("parcel_id").set_index("parcel_id")

    rows, t0 = [], time.time()
    with settings(config):
        for month, group in subjects.groupby(subjects["date"].dt.to_period("M")):
            model, ti, t_month, window = month_context(sales, tindex, month, cache)
            for _, sale in group.iterrows():
                as_of = sale["date"] - pd.Timedelta(days=1)
                subject = parcel_by_id.loc[sale["parcel_id"]].copy()
                subject["parcel_id"] = sale["parcel_id"]
                r = comps.value_subject(subject, _nearby(window, subject), model, ti, as_of=as_of)
                fair = r["fair_value"]
                year_now = as_of.year + as_of.dayofyear / 366
                regression = valuation.predict(model, pd.DataFrame([{
                    **comps._subject_frame(subject).iloc[0].to_dict(),
                    "nbhd": subject["nbhd"], "property_type": subject["property_type"]}]), year_now)
                rows.append({
                    "parcel_id": sale["parcel_id"], "address": sale["address"], "zip": sale["zip"],
                    "property_type": sale["property_type"], "sale_date": sale["date"], "price": sale["price"],
                    "new_build": bool(pd.notna(sale["year_built"]) and sale["date"].year - sale["year_built"] <= 1),
                    "fair_value": fair, "regression_value": regression,
                    "low": r["range"][0] if fair else None, "high": r["range"][1] if fair else None,
                    **{f"{m}_{k}": (v["fair_value"] if k == "value" else v["range"][0 if k == "low" else 1])
                       if v["fair_value"] is not None else None
                       for m, v in r["methods"].items() for k in ("value", "low", "high")},
                    "n_comps": len(r["comps"]), "search_area": r["search"]["area"],
                    "search_months": r["search"]["months"], "thin": bool(r["search"].get("thin", False)),
                    "index_month": t_month,
                })
            if progress:
                print(f"  {month}: {len(group)} sales, {len(rows)} done, {time.time() - t0:.0f}s", flush=True)

    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["error_pct"] = (out["fair_value"] / out["price"] - 1) * 100
    out["regression_error_pct"] = (out["regression_value"] / out["price"] - 1) * 100
    out["in_range"] = (out["price"] >= out["low"]) & (out["price"] <= out["high"])
    for m in comps.METHODS:
        v = pd.to_numeric(out[f"{m}_value"])
        out[f"{m}_error_pct"] = (v / out["price"] - 1) * 100
        out[f"{m}_in_range"] = (out["price"] >= pd.to_numeric(out[f"{m}_low"])) & (out["price"] <= pd.to_numeric(out[f"{m}_high"]))
    out["price_band"] = out["price"].map(_band)
    return out


def summarize(df: pd.DataFrame, method: str = "comps") -> dict:
    """Accuracy stats for a set of backtest rows (those that got a value by `method`)."""
    if f"{method}_value" not in df:            # results saved before methods existed
        if method != "comps":
            return {"n": int(len(df)), "valued": 0}
        df = df.assign(comps_value=df["fair_value"], comps_error_pct=df["error_pct"], comps_in_range=df["in_range"])
    v = df[pd.to_numeric(df[f"{method}_value"]).notna()]
    e = v[f"{method}_error_pct"]
    if v.empty:
        return {"n": int(len(df)), "valued": 0}
    return {
        "n": int(len(df)), "valued": int(len(v)),
        "median_abs_error_pct": float(e.abs().median()),
        "bias_pct": float(e.median()),               # + = we valued above the sale price
        "within_5_pct": float((e.abs() <= 5).mean() * 100),
        "within_10_pct": float((e.abs() <= 10).mean() * 100),
        "within_20_pct": float((e.abs() <= 20).mean() * 100),
        "in_range_pct": float(v[f"{method}_in_range"].mean() * 100),
        "thin_pct": float(v["thin"].mean() * 100),
        # The county regression alone, same sales, same no-look-ahead rules: what the comps add.
        "regression_only": {
            "median_abs_error_pct": float(v["regression_error_pct"].abs().median()),
            "bias_pct": float(v["regression_error_pct"].median()),
            "within_10_pct": float((v["regression_error_pct"].abs() <= 10).mean() * 100),
        },
    }


def _report(df: pd.DataFrame, method: str, min_n: int) -> dict:
    # Price bands by OUR value, not the sale price: grouping by the outcome makes any noisy
    # estimate look high on cheap sales and low on dear ones, and the page only knows our value.
    value = pd.to_numeric(df[f"{method}_value"] if f"{method}_value" in df else df["fair_value"])
    df = df.assign(price_band=value.map(lambda x: _band(x) if pd.notna(x) else None))
    groups = {}
    for col in ["property_type", "price_band", "zip", "new_build", "search_area"]:
        g = {str(k): summarize(sub, method) for k, sub in df.groupby(col)}
        groups[col] = {k: s for k, s in g.items() if s["n"] >= min_n}
    return {"overall": summarize(df, method), "by": groups}


def _fit_range(lr: pd.Series, s: pd.Series, z: pd.Series, target: float) -> tuple[float, float]:
    """Narrowest (a, k) whose range h = sqrt((a z)^2 + (k s)^2) holds >= target of the sales."""
    best = None
    for a in np.linspace(0.0, 4.0, 41):
        for k in np.linspace(0.0, 4.0, 21):
            h = np.sqrt((a * z) ** 2 + (k * s) ** 2)
            if (lr.abs() <= h).mean() >= target and (best is None or h.mean() < best[2]):
                best = (float(a), float(k), float(h.mean()))
    return (best[0], best[1]) if best else (4.0, 4.0)


def calibrate(df: pd.DataFrame, method: str, min_zip: int = 30) -> dict | None:
    """Range calibration for a method. Fitted on odd months and checked on even months
    (reported as check_coverage_pct), then refitted on all months for use."""
    v = pd.to_numeric(df.get(f"{method}_value"))
    if v is None:
        return None
    d = df[v.notna()].assign(value=v[v.notna()])
    if len(d) < 200:
        return None
    d = d.assign(lr=np.log(d["price"] / d["value"]),
                 s=((pd.to_numeric(d[f"{method}_high"]) - pd.to_numeric(d[f"{method}_low"])) / 2 / d["value"]).clip(lower=0.005))

    def scales(rows):
        g = rows.groupby("zip")["lr"]
        per = g.apply(lambda x: x.abs().median())[g.size() >= min_zip]
        return {str(k): float(x) for k, x in per.items()}, float(rows["lr"].abs().median())

    odd = d["sale_date"].dt.to_period("M").map(lambda m: m.ordinal % 2 == 1)
    train, test = d[odd], d[~odd]
    zs, overall = scales(train)
    z_of = lambda rows, zs, o: rows["zip"].map(zs).fillna(o)
    zs_all, overall_all = scales(d)
    levels = {}
    for lvl in RANGE_LEVELS:
        a, k = _fit_range(train["lr"], train["s"], z_of(train, zs, overall), int(lvl) / 100)
        h = np.sqrt((a * z_of(test, zs, overall)) ** 2 + (k * test["s"]) ** 2)
        a2, k2 = _fit_range(d["lr"], d["s"], z_of(d, zs_all, overall_all), int(lvl) / 100)
        levels[lvl] = {"a": a2, "k": k2, "check_coverage_pct": float((test["lr"].abs() <= h).mean() * 100),
                       "check_median_half_width_pct": float(np.expm1(h).median() * 100)}
    return {"zip_scale": zs_all, "overall_scale": overall_all, "levels": levels, "n": int(len(d))}


def report(df: pd.DataFrame, min_n: int = 30) -> dict:
    """Comps method on every sale, plus all methods compared on sales since January 1 of the
    latest year: appraiser just values are set as of January 1 from earlier sales, so only
    later sales are a fair test of the assessed and blend methods."""
    roll_start = pd.Timestamp(year=df["sale_date"].max().year, month=1, day=1)
    fair = df[df["sale_date"] >= roll_start]
    by_method = {m: _report(fair, m, min_n) for m in comps.METHODS}
    # A method must value nearly every sale to be the default (assessed skips some homes).
    scored = {m: r["overall"]["median_abs_error_pct"] for m, r in by_method.items()
              if r["overall"].get("valued", 0) >= 0.9 * max(len(fair), 1)}
    main = _report(df, "comps", min_n)
    return {
        "overall": main["overall"],
        "sales_from": df["sale_date"].min().strftime("%Y-%m-%d"),
        "sales_to": df["sale_date"].max().strftime("%Y-%m-%d"),
        "price_bands": [[lo, None if hi == math.inf else hi, _band(lo)] for lo, hi in zip(PRICE_BANDS, PRICE_BANDS[1:])],
        "by": main["by"],
        "methods": {"sales_from": roll_start.strftime("%Y-%m-%d"), "n": int(len(fair)),
                    "best": min(scored, key=scored.get) if scored else "comps", "by_method": by_method,
                    "ranges": {m: calibrate(fair, m) for m in comps.METHODS}},
    }


def render(rep: dict) -> str:
    def line(name, s):
        if not s.get("valued"):
            return f"  {name:<22} n={s['n']}  (no values)"
        return (f"  {name:<22} n={s['valued']:>5}  med abs {s['median_abs_error_pct']:5.1f}%  "
                f"bias {s['bias_pct']:+5.1f}%  <=5% {s['within_5_pct']:4.0f}%  <=10% {s['within_10_pct']:4.0f}%  "
                f"<=20% {s['within_20_pct']:4.0f}%  in range {s['in_range_pct']:4.0f}%  thin {s['thin_pct']:3.0f}%" +
                f"  | regression alone {s['regression_only']['median_abs_error_pct']:5.1f}%")
    out = [f"BACKTEST  market sales {rep['sales_from']} .. {rep['sales_to']}",
           "  each valued as of the day before it sold, with only data known then", "",
           line("ALL", rep["overall"])]
    for col, g in rep["by"].items():
        out += ["", f"by {col}"] + [line(k, s) for k, s in sorted(g.items(), key=lambda kv: -kv[1]["n"])]
    m = rep.get("methods")
    if m:
        out += ["", f"METHODS  sales since {m['sales_from']} (after the appraiser's January 1 values); "
                    f"default: {m['best']}"]
        for name, r in m["by_method"].items():
            out.append(line(name, r["overall"]))
            cal = m.get("ranges", {}).get(name)
            if cal:
                out.append("    calibrated ranges (checked on held-back months): " + ", ".join(
                    f"{lv}% -> held {c['check_coverage_pct']:.0f}%, median ±{c['check_median_half_width_pct']:.0f}%"
                    for lv, c in cal["levels"].items()))
            for band, s in sorted(r["by"]["price_band"].items(), key=lambda kv: -kv[1]["n"]):
                out.append(line("  " + band, s))
    return "\n".join(out)


def market_signals(df: pd.DataFrame, raw_dir: Path) -> dict:
    """Run the leverage check if the Realtor.com file from the market build is on disk (optional)."""
    from . import leverage, load
    from .build import _raw_path
    path = _raw_path(raw_dir, "realtor_zip")
    if not path.exists():
        return {"helps": False, "note": f"Realtor.com file not found ({path.name}); not tested"}
    try:
        return leverage.check(df, load.realtor_zip(path, set(df["zip"].dropna())))
    except Exception as e:                       # optional source: never fail the backtest
        return {"helps": False, "note": f"check failed: {e}"}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--county", default="pasco")
    p.add_argument("--months", type=int, default=12)
    p.add_argument("--sample", type=int)
    p.add_argument("--work-dir", type=Path)
    p.add_argument("--raw-dir", type=Path, default=ROOT / "raw", help="market build downloads (Realtor.com)")
    p.add_argument("--site-dir", type=Path, default=ROOT / "site" / "data")
    a = p.parse_args(argv)
    work = a.work_dir or ROOT / "work" / a.county
    parcels = pd.read_parquet(work / "parcels.parquet")
    sales = pd.read_parquet(work / "sales.parquet")
    df = run(parcels, sales, comps_report.load_time_index(a.site_dir), months=a.months,
             sample=a.sample, progress=True)
    df.to_parquet(work / "backtest.parquet", index=False)
    rep = report(df)
    rep.update({"county": a.county, "months": a.months, "sample": a.sample})
    rep["market_signals"] = market_signals(df, a.raw_dir)
    out = a.site_dir / "counties" / a.county / "backtest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(_clean(rep), indent=1))
    print(render(rep))


if __name__ == "__main__":
    main()
