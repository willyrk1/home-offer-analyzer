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

    # Redfin leaves months of supply empty at ZIP level; derive it from the
    # 90-day window: inventory / (homes sold per month).
    if out["months_of_supply"] is None and out["inventory"] is not None and out["homes_sold"]:
        out["months_of_supply"] = out["inventory"] / (out["homes_sold"] / 3)

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


def realtor_indicators(rt: pd.DataFrame) -> dict:
    """rt: Realtor.com monthly rows for one ZIP (listing-side data)."""
    if rt.empty:
        return {}
    df = rt.set_index("date").sort_index()
    last = df.index.max()
    year_ago = last - pd.DateOffset(years=1)
    same_2019 = last.replace(year=2019)

    def col(name, when):
        return _num(df[name].get(when)) if name in df else None

    share = col("price_reduced_share", last)
    share_ya = col("price_reduced_share", year_ago)
    active = col("active_listing_count", last)
    dom = col("median_days_on_market", last)
    return {
        "realtor_date": last.strftime("%Y-%m"),
        "price_cut_share_pct": None if share is None else share * 100,
        "price_cut_share_yoy_pts": _diff(None if share is None else share * 100,
                                         None if share_ya is None else share_ya * 100),
        "active_listings": active,
        "active_listings_yoy_pct": _pct_change(active, col("active_listing_count", year_ago)),
        "active_listings_vs_2019_pct": _pct_change(active, col("active_listing_count", same_2019)),
        "listing_dom": dom,
        "listing_dom_yoy_days": _diff(dom, col("median_days_on_market", year_ago)),
        "median_listing_price": col("median_listing_price", last),
    }


def combine(ind: dict) -> dict:
    """Pick the freshest source for each leading indicator the read uses.

    Price cuts come from Redfin when it has them, otherwise Realtor.com.
    Inventory and days on market use Realtor.com when its month is newer.
    Each pick records its source so the site can label it.
    """
    rd, rt = ind.get("redfin_date"), ind.get("realtor_date")
    realtor_newer = rt is not None and (rd is None or rt > rd)

    if ind.get("price_drops_pct") is not None:
        cuts = (ind["price_drops_pct"], ind.get("price_drops_yoy_pts"), "Redfin", rd)
    else:
        cuts = (ind.get("price_cut_share_pct"), ind.get("price_cut_share_yoy_pts"), "Realtor.com", rt)

    if realtor_newer and ind.get("active_listings") is not None:
        inv = (ind["active_listings"], ind.get("active_listings_yoy_pct"),
               ind.get("active_listings_vs_2019_pct"), "Realtor.com", rt)
        dom = (ind.get("listing_dom"), ind.get("listing_dom_yoy_days"), "Realtor.com", rt)
    else:
        inv = (ind.get("inventory"), ind.get("inventory_yoy_pct"),
               ind.get("inventory_vs_2019_pct"), "Redfin", rd)
        dom = (ind.get("median_dom"), ind.get("median_dom_yoy_days"), "Redfin", rd)

    return {
        **ind,
        "cuts_pct": cuts[0], "cuts_yoy_pts": cuts[1], "cuts_source": cuts[2], "cuts_date": cuts[3],
        "inv": inv[0], "inv_yoy_pct": inv[1], "inv_vs_2019_pct": inv[2],
        "inv_source": inv[3], "inv_date": inv[4],
        "dom": dom[0], "dom_yoy_days": dom[1], "dom_source": dom[2], "dom_date": dom[3],
    }


def market_signal(ind: dict) -> dict:
    """A plain-language read of buyer leverage from the leading indicators.

    Each signal scores +1 (favors buyers), -1 (favors sellers) or 0. This is a
    transparent placeholder until the trained forecast model exists.
    """
    # (label, value, threshold, unit, direction): direction +1 means a rise favors
    # buyers; -1 means a fall favors buyers (sale-to-list).
    checks = [
        ("Price cuts vs a year ago", ind.get("cuts_yoy_pts", ind.get("price_drops_yoy_pts")), 2.0, "pts", 1),
        ("Inventory vs a year ago", ind.get("inv_yoy_pct", ind.get("inventory_yoy_pct")), 10.0, "%", 1),
        ("Days on market vs a year ago", ind.get("dom_yoy_days", ind.get("median_dom_yoy_days")), 7.0, "days", 1),
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
