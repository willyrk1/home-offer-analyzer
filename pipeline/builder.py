"""Recent builder closings: context for the builder floor on the value page.

The builder floor itself is cost-based and user-entered (site/offer.js builderFloor:
lot + build cost x sq ft (+ carrying cost), x (1 + minimum margin)). This adds what the
data can say: the lowest price per sq ft among at least MIN_SALES builder closings
(market sales within a year of the build year) in the same subdivision and property
type over the last MONTHS months, times the subject's sq ft, and `check`: how often
builder closings came in at or above that level set by earlier ones. Prices aren't
time-adjusted over the short window. site/comps.js builderClosingsLow mirrors closings_low.
Neither changes comps, fair value or offers.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MONTHS, MIN_SALES = 6, 3


def builder_sales(sales: pd.DataFrame) -> pd.DataFrame:
    s = sales[(sales["sale_class"] == "market") & sales["year_built"].notna() & (sales["sqft"] > 0)]
    return s[(s["date"].dt.year - s["year_built"]) <= 1]


def closings_low(subject: pd.Series, builders: pd.DataFrame, as_of: pd.Timestamp) -> dict | None:
    """Lowest recent builder $/sq ft in the subject's subdivision x its sq ft (needs subdivision,
    property_type, sqft, parcel_id)."""
    b = builders[(builders["subdivision"] == subject["subdivision"])
                 & (builders["property_type"] == subject["property_type"])
                 & (builders["parcel_id"] != subject["parcel_id"])
                 & (builders["date"] <= as_of) & (builders["date"] > as_of - pd.DateOffset(months=MONTHS))]
    if len(b) < MIN_SALES:
        return None
    ppsf = b["price"] / b["sqft"]
    low = b.loc[ppsf.idxmin()]
    return {"value": float(ppsf.min() * subject["sqft"]), "ppsf": float(ppsf.min()), "n": int(len(b)),
            "lowest": {"address": low["address"], "date": low["date"].strftime("%Y-%m-%d"),
                       "price": float(low["price"]), "sqft": float(low["sqft"])}}


def check(sales: pd.DataFrame, months: int = 24) -> dict:
    """How often builder closings came in at or above the low set by earlier builder closings."""
    b = builder_sales(sales)
    b = b[b["date"] > sales["date"].max() - pd.DateOffset(months=months)].sort_values("date")
    vs = []
    for _, x in b.iterrows():
        f = closings_low(x, b, x["date"] - pd.Timedelta(days=1))
        if f:
            vs.append(x["price"] / f["value"] - 1)
    if not vs:
        return {"n": 0}
    vs = np.array(vs)
    return {"n": int(len(vs)), "sales_from": b["date"].min().strftime("%Y-%m-%d"),
            "at_or_above_pct": float((vs >= 0).mean() * 100),
            "median_above_pct": float(np.median(vs) * 100)}
