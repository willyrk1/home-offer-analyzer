"""ZIP-level market indicators.

Every comparison is against the same month a year earlier (or the same month
in 2019), so seasonal swings such as the usual autumn rise in price cuts don't
read as market weakness.
"""
from __future__ import annotations

import math

import pandas as pd


def _num(x):
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def _at(series: pd.Series, date: pd.Timestamp):
    return _num(series.get(date))


def _pct_change(new, old):
    if new is None or old in (None, 0):
        return None
    return (new / old - 1) * 100


def _diff(new, old):
    if new is None or old is None:
        return None
    return new - old


def zhvi_indicators(zhvi: pd.DataFrame) -> dict:
    """zhvi: rows for one ZIP with columns date, zhvi."""
    if zhvi.empty:
        return {}
    s = zhvi.set_index("date")["zhvi"]
    last = s.index.max()
    now = _at(s, last)
    return {
        "zhvi_date": last.strftime("%Y-%m"),
        "zhvi": now,
        "zhvi_yoy_pct": _pct_change(now, _at(s, last - pd.DateOffset(years=1))),
        "zhvi_3m_pct": _pct_change(now, _at(s, last - pd.DateOffset(months=3))),
        "zhvi_6m_pct": _pct_change(now, _at(s, last - pd.DateOffset(months=6))),
        "zhvi_vs_2019_pct": _pct_change(now, _at(s, last.replace(year=2019))),
    }


def redfin_indicators(rf: pd.DataFrame) -> dict:
    """rf: rows for one ZIP and one property type, indexed by monthly date."""
    if rf.empty:
        return {}
    df = rf.set_index("date").sort_index()
    last = df.index.max()
    year_ago = last - pd.DateOffset(years=1)
    same_2019 = last.replace(year=2019)

    def col(name, when):
        return _num(df[name].get(when)) if name in df else None

    out = {"redfin_date": last.strftime("%Y-%m")}
    for name in ["median_sale_price", "median_ppsf", "inventory", "new_listings",
                 "homes_sold", "pending_sales", "months_of_supply", "median_dom"]:
        out[name] = col(name, last)

    # Redfin reports these as fractions; show them as percentages.
    for name in ["price_drops", "avg_sale_to_list", "sold_above_list"]:
        v = col(name, last)
        out[f"{name}_pct"] = None if v is None else v * 100

    out["median_sale_price_yoy_pct"] = _pct_change(out["median_sale_price"], col("median_sale_price", year_ago))
    out["inventory_yoy_pct"] = _pct_change(out["inventory"], col("inventory", year_ago))
    out["inventory_vs_2019_pct"] = _pct_change(out["inventory"], col("inventory", same_2019))
    out["median_dom_yoy_days"] = _diff(out["median_dom"], col("median_dom", year_ago))

    pd_year_ago = col("price_drops", year_ago)
    out["price_drops_yoy_pts"] = _diff(out["price_drops_pct"],
                                       None if pd_year_ago is None else pd_year_ago * 100)
    stl_year_ago = col("avg_sale_to_list", year_ago)
    out["sale_to_list_yoy_pts"] = _diff(out["avg_sale_to_list_pct"],
                                        None if stl_year_ago is None else stl_year_ago * 100)
    return out


def market_signal(ind: dict) -> dict:
    """A plain-language read of buyer leverage from the leading indicators.

    Each signal scores +1 (favors buyers), -1 (favors sellers) or 0. This is a
    transparent placeholder until the trained forecast model exists.
    """
    # (label, value, threshold, unit, direction): direction +1 means a rise favors
    # buyers; -1 means a fall favors buyers (sale-to-list).
    checks = [
        ("Price cuts vs a year ago", ind.get("price_drops_yoy_pts"), 2.0, "pts", 1),
        ("Inventory vs a year ago", ind.get("inventory_yoy_pct"), 10.0, "%", 1),
        ("Days on market vs a year ago", ind.get("median_dom_yoy_days"), 7.0, "days", 1),
        ("Sale-to-list vs a year ago", ind.get("sale_to_list_yoy_pts"), 0.5, "pts", -1),
    ]
    detail, score, counted = [], 0, 0
    for label, value, threshold, unit, direction in checks:
        if value is None:
            continue
        counted += 1
        v = value * direction
        s = 1 if v >= threshold else -1 if v <= -threshold else 0
        score += s
        detail.append({"label": label, "value": value, "unit": unit, "score": s})
    if counted == 0:
        verdict = "Not enough data"
    elif score >= 2:
        verdict = "Buyer leverage rising"
    elif score <= -2:
        verdict = "Seller leverage rising"
    else:
        verdict = "Mixed / balanced"
    return {"score": score, "counted": counted, "verdict": verdict, "checks": detail}
