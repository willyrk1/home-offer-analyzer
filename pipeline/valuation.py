"""County hedonic regression: what each feature is worth, fitted on local sales.

    ln(price) = neighborhood effect + month effect
                + b1 ln(sqft) + b2 age + b3 new + b4 ln(lot) + b5 baths
                + b6 pool + b7 two-story + b8 quality + property-type effects

Comp adjustments use b1..b8: for a difference d in a feature, the comp's price
is multiplied by exp(b * d). Neighborhood and month effects only keep the
feature estimates clean; time is handled separately with the ZIP index.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

FEATURES = ["ln_sqft", "age", "new", "ln_lot", "baths", "pool", "two_story", "quality"]
LABELS = {
    "ln_sqft": "Size (log sq ft)", "age": "Age (per year)", "new": "Built within 2 years",
    "ln_lot": "Lot (log acres)", "baths": "Bathrooms (each)", "pool": "Pool",
    "two_story": "Two-story", "quality": "Quality grade (per step)",
}


def design(df: pd.DataFrame, as_of_year: float | None = None) -> pd.DataFrame:
    """Model features for sales (age at sale date) or for a subject (age as of a year)."""
    year = df["date"].dt.year if as_of_year is None else as_of_year
    age = (year - df["year_built"]).clip(lower=0, upper=100)
    return pd.DataFrame({
        "ln_sqft": np.log(df["sqft"].clip(lower=300)),
        "age": age,
        "new": (age <= 2).astype(float),
        "ln_lot": np.log(df["lot_acres"].fillna(0.15).clip(0.02, 5.0)),
        "baths": df["baths"].fillna(df["baths"].median() if len(df) else 2).clip(0.5, 8),
        "pool": df["pool"].astype(float),
        "two_story": (df["stories"].fillna(1) >= 2).astype(float),
        "quality": df["quality"].fillna(4).clip(1, 6),
    }, index=df.index)


def fit(sales: pd.DataFrame, months: int = 24, min_group: int = 15, effects: bool = False) -> dict:
    """Fit on market sales from the last `months` months. Returns coefficients and fit stats.

    effects=True also returns the intercept and the neighborhood, month and property-type
    effects, so `predict` can value a home from the regression alone (a backtest baseline).
    """
    if sales.empty:
        raise ValueError("no sales to fit")
    end = sales["date"].max()
    df = sales[(sales["sale_class"] == "market")
               & (sales["date"] > end - pd.DateOffset(months=months))].dropna(subset=["sqft", "year_built"])
    if len(df) < 200:
        raise ValueError(f"only {len(df)} market sales in the window; need 200+")

    X = design(df)
    nb = df["nbhd"].fillna("other")
    counts = nb.value_counts()
    nb = nb.where(nb.map(counts) >= min_group, "other")
    month = df["date"].dt.strftime("%Y-%m")
    dummies = pd.concat([
        pd.get_dummies(nb, prefix="nb", drop_first=True, dtype=float),
        pd.get_dummies(month, prefix="m", drop_first=True, dtype=float),
        pd.get_dummies(df["property_type"], prefix="pt", drop_first=True, dtype=float),
    ], axis=1)
    A = np.column_stack([np.ones(len(df)), X.values, dummies.values])
    y = np.log(df["price"].values)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ coef
    ss_tot = ((y - y.mean()) ** 2).sum()

    # Standard errors for the feature coefficients (homoskedastic approximation).
    dof = max(len(y) - A.shape[1], 1)
    sigma2 = (resid ** 2).sum() / dof
    try:
        cov = sigma2 * np.linalg.pinv(A.T @ A)
        se = np.sqrt(np.clip(np.diag(cov), 0, None))
    except np.linalg.LinAlgError:
        se = np.full(A.shape[1], np.nan)

    feats = {f: {"coef": float(coef[i + 1]), "se": float(se[i + 1]), "label": LABELS[f]}
             for i, f in enumerate(FEATURES)}
    out = {
        "features": feats,
        "n_sales": int(len(df)),
        "n_neighborhoods": int(nb.nunique()),
        "window": [df["date"].min().strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")],
        "r2": float(1 - (resid ** 2).sum() / ss_tot) if ss_tot else None,
        "rmse_log": float(np.sqrt((resid ** 2).mean())),
        "median_abs_pct_error": float(np.median(np.abs(np.expm1(resid))) * 100),
    }
    if effects:
        named = dict(zip(dummies.columns, coef[1 + len(FEATURES):]))
        groups = {k[3:]: float(v) for k, v in named.items() if k.startswith("nb_")}
        out["effects"] = {
            "intercept": float(coef[0]),
            "nbhd": groups, "nbhd_kept": sorted(set(nb)),
            "type": {k[3:]: float(v) for k, v in named.items() if k.startswith("pt_")},
            "last_month": float(named.get(f"m_{month.max()}", 0.0)),
        }
    return out


def predict(model: dict, subject: pd.DataFrame, as_of_year: float) -> float:
    """Regression-only value for one home (`subject`: one row with features, nbhd, property_type),
    at the price level of the model's last month. Needs a model fitted with effects=True."""
    e = model["effects"]
    x = design(subject, as_of_year=as_of_year).iloc[0]
    nb = subject["nbhd"].iat[0]
    nb = nb if nb in e["nbhd_kept"] else "other"
    ln = (e["intercept"] + sum(model["features"][f]["coef"] * x[f] for f in FEATURES)
          + e["nbhd"].get(nb, 0.0) + e["type"].get(subject["property_type"].iat[0], 0.0) + e["last_month"])
    return float(np.exp(ln))
