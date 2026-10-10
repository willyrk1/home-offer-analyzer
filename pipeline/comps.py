"""Comp selection, adjustment and fair value for one subject property.

Steps (matching the project spec):
  1. candidates: market/distressed sales of the same property type, recent, nearby;
     widen radius then time window until there are at least MIN_COMPS
  2. similarity score on distance, neighborhood, size, age, lot, baths, pool, recency
  3. adjust each comp: time (ZIP home value index) + features (county regression)
  4. weight = similarity x 1/(1 + gross adjustment), distressed sales discounted
  5. fair value = weighted average; range = weighted spread

Three ways to turn the comps into a value (all returned under "methods"):
  comps     step 5 above
  assessed  each comp's time-adjusted price / its appraiser just value gives a
            market-to-assessment ratio; the subject's just value x the weighted
            ratio. The appraiser's model sees land and location detail we don't.
  blend     the average of the two
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import valuation

MIN_COMPS, MAX_COMPS = 6, 8
SEARCH = [  # (radius in miles, months back)
    (0.5, 6), (1.0, 6), (1.0, 9), (2.0, 9), (2.0, 12), (3.0, 12), (5.0, 18),
]
DISTRESSED_WEIGHT = 0.5
NET_LIMIT, GROSS_LIMIT = 0.15, 0.25
METHODS = ["comps", "assessed", "blend"]
JV_MIN_COMPS = 3        # comps with a usable just value needed for the assessed method
JV_RATIO_BAND = 1.5     # drop comps whose ratio is beyond x/÷ this of the median ratio
JV_SUBJECT_MIN = 0.6    # subject just value per sq ft must be >= this x the comps' (else
                        # it is likely a partial assessment, e.g. a home finished after Jan 1)
# Similarity penalty per unit of difference (see _similarity); site/comps.js has the same table.
SIM = {"size": 1.0, "age": 0.6, "lot": 0.3, "baths": 0.4, "pool": 1.0, "dist": 0.8, "months": 0.5,
       "same_nbhd": 0.3, "same_subdivision": 0.4}


def haversine_miles(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * np.arcsin(np.sqrt(a))


def find_subject(parcels: pd.DataFrame, address: str, normalize) -> pd.Series:
    key = normalize(address.split(",")[0])
    hits = parcels[parcels["address_key"] == key]
    if hits.empty:
        num = key.split()[0] if key else ""
        near = parcels[parcels["address_key"].fillna("").str.startswith(num + " ")]["address"].head(5).tolist()
        raise LookupError(f"No parcel found for {address!r} (normalized {key!r}). Similar: {near}")
    return hits.iloc[0]


class TimeIndex:
    """Monthly ZIP home value index (Zillow) used to bring comp prices to today."""

    def __init__(self, series_by_zip: dict[str, list]):
        self.idx = {z: dict(points) for z, points in series_by_zip.items() if points}
        self.latest = {z: points[-1] for z, points in series_by_zip.items() if points}

    def factor(self, zip_code: str, when: pd.Timestamp) -> tuple[float, str]:
        s = self.idx.get(zip_code)
        if not s:
            return 1.0, "no index for ZIP"
        month = when.strftime("%Y-%m")
        then = s.get(month)
        if then is None:
            earlier = [m for m in s if m <= month]
            then = s[max(earlier)] if earlier else None
        if not then:
            return 1.0, "no index for month"
        latest_month, latest_val = self.latest[zip_code]
        return latest_val / then, f"{month} -> {latest_month}"

    def through(self, last_month: str) -> "TimeIndex":
        """The index as it stood when `last_month` (YYYY-MM) was the newest month published."""
        return TimeIndex({z: [p for p in pts if p[0] <= last_month] for z, pts in
                          ((z, sorted(s.items())) for z, s in self.idx.items())})


def _f(v, default=np.nan) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) else f


def _subject_frame(subject: pd.Series) -> pd.DataFrame:
    return pd.DataFrame([{
        "sqft": _f(subject["sqft"]), "year_built": _f(subject["year_built"]),
        "lot_acres": _f(subject["lot_acres"]), "baths": _f(subject["baths"], 2.0),
        "stories": _f(subject["stories"], 1.0), "quality": _f(subject["quality"], 4.0),
        "pool": bool(subject["pool"]) if pd.notna(subject["pool"]) else False,
    }])


def _similarity(c: pd.DataFrame, subj: pd.Series, as_of: pd.Timestamp) -> pd.Series:
    """Higher is more similar (0..1). Each term is a scaled difference."""
    size = np.abs(np.log(c["sqft"] / subj["sqft"])) / 0.15          # 15% size gap = 1 unit
    age = np.abs(c["year_built"].fillna(subj["year_built"]) - subj["year_built"]) / 10
    subj_lot = _f(subj["lot_acres"], 0.15)
    lot = np.abs(np.log(c["lot_acres"].fillna(subj_lot).clip(lower=0.02) / max(subj_lot, 0.02))) / 0.5
    baths = np.abs(c["baths"].fillna(_f(subj["baths"], 2.0)) - _f(subj["baths"], 2.0)) / 1.0
    pool = (c["pool"] != bool(subj["pool"])).astype(float) * 0.5
    dist = c["distance_mi"] / 1.0
    months = (as_of - c["date"]).dt.days / 30.4 / 6
    same_nb = (c["nbhd"] == subj["nbhd"]).astype(float)
    same_sub = (c["subdivision"] == subj["subdivision"]).astype(float)
    penalty = (SIM["size"] * size + SIM["age"] * age + SIM["lot"] * lot + SIM["baths"] * baths
               + SIM["pool"] * pool + SIM["dist"] * dist + SIM["months"] * months)
    penalty -= SIM["same_nbhd"] * same_nb + SIM["same_subdivision"] * same_sub
    return 1 / (1 + penalty.clip(lower=0))


def _median(xs: list[float]) -> float:
    v = sorted(xs)
    k = len(v) // 2
    return v[k] if len(v) % 2 else (v[k - 1] + v[k]) / 2


def assessed_value(subject: pd.Series, comps: list[dict]) -> dict:
    """Subject just value x the comps' weighted market-to-just-value ratio (see module doc)."""
    jv, sqft = _f(subject.get("just_value")), _f(subject.get("sqft"))
    usable = [c for c in comps if c["just_value"] is not None and c["just_value"] > 0]
    if not (jv > 0) or len(usable) < JV_MIN_COMPS:
        return {"fair_value": None, "range": None, "reason": "not enough comps with an appraiser value"}
    med = _median([c["time_adjusted"] / c["just_value"] for c in usable])
    kept = [c for c in usable if med / JV_RATIO_BAND <= c["time_adjusted"] / c["just_value"] <= med * JV_RATIO_BAND]
    if len(kept) < JV_MIN_COMPS:
        return {"fair_value": None, "range": None, "reason": "comps' ratios disagree too much"}
    jv_psf = _median([c["just_value"] / c["sqft"] for c in kept])
    if sqft > 0 and jv / sqft < JV_SUBJECT_MIN * jv_psf:
        return {"fair_value": None, "range": None,
                "reason": "the appraiser value looks partial (new or changed since January 1)"}
    w = np.array([c["similarity"] * (DISTRESSED_WEIGHT if c["sale_class"] == "distressed" else 1.0) for c in kept])
    r = np.array([c["time_adjusted"] / c["just_value"] for c in kept])
    if w.sum() == 0:
        return {"fair_value": None, "range": None, "reason": "no weight"}
    ratio = float((w * r).sum() / w.sum())
    fair = jv * ratio
    spread = float(np.sqrt((w * (jv * r - fair) ** 2).sum() / w.sum()))
    return {"fair_value": fair, "range": [fair - spread, fair + spread], "ratio": ratio, "just_value": jv,
            "used": [c["parcel_id"] for c in kept]}


def calibrated_range(fair, low, high, zip_code, cal: dict | None, level: str = "80"):
    """Range that held the sale price `level`% of the time in the backtest (see backtest.calibrate):
    fair x exp(+/-h), h = sqrt((a x ZIP's typical log miss)^2 + (k x comps' relative spread)^2)."""
    if fair is None or low is None or not cal or str(level) not in cal["levels"]:
        return None
    lv = cal["levels"][str(level)]
    s = max((high - low) / 2 / fair, 0.005)
    z = cal["zip_scale"].get(zip_code, cal["overall_scale"])
    h = math.sqrt((lv["a"] * z) ** 2 + (lv["k"] * s) ** 2)
    return [fair * math.exp(-h), fair * math.exp(h)]


def combine_methods(subject: pd.Series, comps: list[dict], fair, spread) -> dict:
    m = {"comps": {"fair_value": fair, "range": None if fair is None else [fair - spread, fair + spread]}}
    m["assessed"] = assessed_value(subject, comps) if comps else {"fair_value": None, "range": None}
    a = m["assessed"]
    if fair is not None and a["fair_value"] is not None:
        m["blend"] = {"fair_value": (fair + a["fair_value"]) / 2,
                      "range": [(m["comps"]["range"][i] + a["range"][i]) / 2 for i in (0, 1)]}
    else:
        m["blend"] = {"fair_value": None, "range": None, "reason": "needs both comps and assessed values"}
    return m


def adjust(comp: pd.Series, subj_x: pd.Series, comp_x: pd.Series, model: dict,
           tindex: TimeIndex) -> dict:
    t_factor, t_note = tindex.factor(comp["zip"], comp["date"])
    base = comp["price"] * t_factor
    lines, log_sum, gross = [], 0.0, 0.0
    for f in valuation.FEATURES:
        b = model["features"][f]["coef"]
        d = float(subj_x[f] - comp_x[f])
        if abs(d) < 1e-9 or not math.isfinite(b):
            continue
        pct = math.expm1(b * d)
        log_sum += b * d
        gross += abs(pct)
        lines.append({"feature": f, "label": model["features"][f]["label"], "coef": b,
                      "difference": d, "pct": pct * 100, "dollars": base * pct})
    adjusted = base * math.exp(log_sum)
    net = math.expm1(log_sum)
    return {
        "time_factor": t_factor, "time_note": t_note, "time_adjusted": base,
        "adjustments": lines, "adjusted_price": adjusted,
        "net_pct": net * 100, "gross_pct": gross * 100,
    }


def value_subject(subject: pd.Series, sales: pd.DataFrame, model: dict, tindex: TimeIndex,
                  as_of: pd.Timestamp | None = None, exclude_parcel: bool = True) -> dict:
    as_of = as_of or sales["date"].max()
    pool = sales[sales["property_type"] == subject["property_type"]]
    if exclude_parcel:
        pool = pool[pool["parcel_id"] != subject["parcel_id"]]
    pool = pool[pool["date"] <= as_of]   # no-op live (as_of = latest sale); matters in backtests
    # Most recent sale per parcel only.
    pool = pool.sort_values("date").drop_duplicates("parcel_id", keep="last")
    located = pd.notna(subject.get("lat")) and pool["lat"].notna().any()

    if located:
        pool = pool[pool["lat"].notna()]
        pool = pool.assign(distance_mi=haversine_miles(subject["lat"], subject["lon"], pool["lat"], pool["lon"]))
        steps = [(f"within {r} mi", pool["distance_mi"] <= r, m) for r, m in SEARCH]
    else:
        # No coordinates: same subdivision, then appraiser neighborhood, then ZIP.
        pool = pool.assign(distance_mi=np.where(pool["subdivision"] == subject["subdivision"], 0.25,
                                                np.where(pool["nbhd"] == subject["nbhd"], 0.75, 1.5)))
        steps = [(f"same {label}", mask, m)
                 for label, mask in [("subdivision", pool["subdivision"] == subject["subdivision"]),
                                     ("neighborhood", pool["nbhd"] == subject["nbhd"]),
                                     ("ZIP", pool["zip"] == subject["zip"])]
                 for m in (6, 12, 18)]

    chosen, reach = None, None
    for label, mask, months in steps:
        cand = pool[mask & (pool["date"] > as_of - pd.DateOffset(months=months))]
        # Keep size within +/-35% so adjustments stay reasonable.
        cand = cand[np.abs(np.log(cand["sqft"] / subject["sqft"])) <= 0.35]
        if len(cand) >= MIN_COMPS:
            chosen, reach = cand, {"area": label, "months": months, "located": bool(located)}
            break
    if chosen is None:
        chosen, reach = cand, {"area": label, "months": months, "located": bool(located), "thin": True}

    chosen = chosen.assign(similarity=_similarity(chosen, subject, as_of))
    chosen = chosen.sort_values("similarity", ascending=False).head(MAX_COMPS)

    year_now = as_of.year + (as_of.dayofyear / 366)
    subj_x = valuation.design(_subject_frame(subject), as_of_year=year_now).iloc[0]
    comp_x = valuation.design(chosen)

    comps = []
    for i, c in chosen.iterrows():
        adj = adjust(c, subj_x, comp_x.loc[i], model, tindex)
        weight = c["similarity"] / (1 + adj["gross_pct"] / 100)
        if c["sale_class"] == "distressed":
            weight *= DISTRESSED_WEIGHT
        flags = []
        if abs(adj["net_pct"]) > NET_LIMIT * 100:
            flags.append("net adjustment over 15%")
        if adj["gross_pct"] > GROSS_LIMIT * 100:
            flags.append("gross adjustment over 25%")
        if c["sale_class"] == "distressed":
            flags.append("distressed sale")
        comps.append({
            "parcel_id": c["parcel_id"], "address": c["address"], "zip": c["zip"],
            "sale_date": c["date"].strftime("%Y-%m-%d"), "sale_price": float(c["price"]),
            "sale_class": c["sale_class"], "distance_mi": float(c["distance_mi"]),
            "sqft": float(c["sqft"]), "year_built": c["year_built"], "lot_acres": c["lot_acres"],
            "baths": c["baths"], "pool": bool(c["pool"]), "stories": c["stories"],
            "same_neighborhood": bool(c["nbhd"] == subject["nbhd"]),
            "just_value": (None if not (_f(c.get("just_value")) > 0) else float(c["just_value"])),
            "similarity": float(c["similarity"]), "weight": float(weight), "flags": flags, **adj,
        })

    w = np.array([c["weight"] for c in comps])
    v = np.array([c["adjusted_price"] for c in comps])
    if len(comps) == 0 or w.sum() == 0:
        fair, spread = None, None
    else:
        fair = float((w * v).sum() / w.sum())
        spread = float(np.sqrt((w * (v - fair) ** 2).sum() / w.sum()))
    return {
        "subject": {k: (None if (isinstance(subject[k], float) and math.isnan(subject[k])) else subject[k])
                    for k in ["parcel_id", "address", "zip", "city", "property_type", "sqft", "year_built",
                              "lot_acres", "baths", "stories", "pool", "quality", "nbhd", "nbhd_name",
                              "just_value", "lat", "lon"]},
        "as_of": as_of.strftime("%Y-%m-%d"),
        "search": reach,
        "fair_value": fair,
        "range": None if fair is None else [fair - spread, fair + spread],
        "methods": combine_methods(subject, comps, fair, spread),
        "comps": comps,
        "model": {k: model[k] for k in ["n_sales", "window", "r2", "median_abs_pct_error"]},
    }
