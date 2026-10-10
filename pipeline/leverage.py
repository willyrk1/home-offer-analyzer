"""Do ZIP market signals predict where a sale lands relative to our fair value?

Buyer leverage should only move an offer if it shows up in the numbers. For each
backtested sale this joins the Realtor.com ZIP signals published before it sold
(month before the sale) and asks whether they explain log(sale price / our value),
which is exactly what comps + the ZIP index missed. Fitted on odd months, checked
on even months, like the other backtest checks. Signals are year-over-year changes
(same month a year earlier, for seasonality):
  price-cut share (points), active listings (%), listing days on market (days),
  median list price (%).

Result goes in backtest.json "market_signals"; the value page cites it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

FEATURES = {
    "price_cut_share_yoy_pts": "Share of listings with a price cut, vs a year ago (points)",
    "active_listings_yoy_pct": "Active listings vs a year ago (%)",
    "listing_dom_yoy_days": "Listing days on market vs a year ago (days)",
    "list_price_yoy_pct": "Median list price vs a year ago (%)",
}


def signals(rt: pd.DataFrame) -> pd.DataFrame:
    """Per ZIP and month: year-over-year changes from Realtor.com rows (load.realtor_zip)."""
    rt = rt.sort_values(["zip", "date"]).copy()
    rt["month"] = rt["date"].dt.to_period("M")
    ago = rt[["zip", "month", "price_reduced_share", "active_listing_count", "median_days_on_market",
              "median_listing_price"]].copy()
    ago["month"] = ago["month"] + 12
    m = rt.merge(ago, on=["zip", "month"], suffixes=("", "_ya"))
    return pd.DataFrame({
        "zip": m["zip"], "month": m["month"],
        "price_cut_share_yoy_pts": (m["price_reduced_share"] - m["price_reduced_share_ya"]) * 100,
        "active_listings_yoy_pct": (m["active_listing_count"] / m["active_listing_count_ya"] - 1) * 100,
        "listing_dom_yoy_days": m["median_days_on_market"] - m["median_days_on_market_ya"],
        "list_price_yoy_pct": (m["median_listing_price"] / m["median_listing_price_ya"] - 1) * 100,
    })


def check(bt: pd.DataFrame, rt: pd.DataFrame, method: str = "blend") -> dict:
    """bt: backtest rows (backtest.run); rt: Realtor.com rows. Returns the measured effect."""
    col = f"{method}_value" if f"{method}_value" in bt else "fair_value"
    d = bt[pd.to_numeric(bt[col]).notna()].copy()
    d["lr"] = np.log(d["price"] / pd.to_numeric(d[col]))
    d["month"] = d["sale_date"].dt.to_period("M") - 1          # published before the sale
    d = d.merge(signals(rt), on=["zip", "month"], how="inner").dropna(subset=list(FEATURES))
    if len(d) < 500:
        return {"n": int(len(d)), "helps": False, "note": "too few sales with signals to test"}
    odd = d["sale_date"].dt.to_period("M").map(lambda m: m.ordinal % 2 == 1)
    train, test = d[odd], d[~odd]
    X = lambda x: np.column_stack([np.ones(len(x))] + [x[f] for f in FEATURES])
    y = train["lr"].clip(train["lr"].quantile(0.05), train["lr"].quantile(0.95))
    coef, *_ = np.linalg.lstsq(X(train), y, rcond=None)
    base = float(np.expm1(test["lr"].abs().median()) * 100)
    with_signals = float(np.expm1((test["lr"] - X(test) @ coef).abs().median()) * 100)
    pred = pd.Series(X(test) @ coef, index=test.index)
    thirds = pd.qcut(pred, 3, labels=["seller_leaning", "middle", "buyer_leaning"])
    by_third = {str(k): float(np.expm1(g.median()) * 100) for k, g in test["lr"].groupby(thirds, observed=True)}
    return {
        "method": method, "n": int(len(d)), "check_n": int(len(test)),
        "sales_from": d["sale_date"].min().strftime("%Y-%m-%d"), "sales_to": d["sale_date"].max().strftime("%Y-%m-%d"),
        "correlation": {f: float(d[f].corr(d["lr"])) for f in FEATURES},
        "labels": FEATURES,
        "check_median_abs_error_pct": {"without_signals": base, "with_signals": with_signals},
        # Median sold-vs-our-value (%) in held-back months, by what the signals predicted.
        "check_sold_vs_value_by_prediction_pct": by_third,
        "helps": bool(with_signals < base - 0.1),
    }
