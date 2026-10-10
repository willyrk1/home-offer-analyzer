"""Tune comps-engine settings on the backtest, without fooling ourselves.

The last 12 months of sales are split by month: odd months are for searching,
even months are held back to check the result. (Alternating months keeps both
halves spread over the same seasons and market conditions.)

Search: coordinate descent. Each round tries every single-setting change from
the current best (in parallel); every change that beats the current best by
more than MIN_GAIN is combined, and the combination is kept only if it is still
better. Two rounds, the second with finer steps. The held-back months are then
scored once for the old and new settings.

    python -m pipeline.tune                  # ~2,500 sales from search months
    python -m pipeline.tune --sample 1000    # quicker

Prints the old and new settings with search- and check-month accuracy, and
writes work/<county>/tune.json. It does not change the engine: copy settings you
accept into SIM etc. in pipeline/comps.py AND site/comps.js (tests check they match).
"""
from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd

from . import backtest, comps, comps_report

ROOT = Path(__file__).resolve().parent.parent
MIN_GAIN = 0.05            # percentage points of median abs error; smaller is noise
INT_SETTINGS = {"MIN_COMPS", "MAX_COMPS"}
STEPS = {                  # round 1 multipliers / round 2 multipliers
    1: [0.0, 0.5, 2.0],
    2: [0.7, 1.4],
}

_W: dict = {}              # per-worker data, loaded once


def _init(work: str, site: str, subjects_path: str):
    _W["parcels"] = pd.read_parquet(Path(work) / "parcels.parquet")
    _W["sales"] = pd.read_parquet(Path(work) / "sales.parquet")
    _W["tindex"] = comps_report.load_time_index(Path(site))
    _W["subjects"] = pd.read_pickle(subjects_path)
    _W["cache"] = {}


def _score(config: dict) -> tuple[dict, dict]:
    df = backtest.run(_W["parcels"], _W["sales"], _W["tindex"], subjects=_W["subjects"],
                      cache=_W["cache"], config=config)
    return config, backtest.summarize(df)


def defaults() -> dict:
    return {**comps.SIM, "MIN_COMPS": comps.MIN_COMPS, "MAX_COMPS": comps.MAX_COMPS,
            "DISTRESSED_WEIGHT": comps.DISTRESSED_WEIGHT, "search_scale": 1.0}


def candidates(best: dict, base: dict, rnd: int) -> list[dict]:
    """Single-setting changes from `best`, scaled from the default value."""
    out = []
    for k in best:
        if k in INT_SETTINGS:
            vals = [best[k] - 2, best[k] - 1, best[k] + 2] if rnd == 1 else [best[k] - 1, best[k] + 1]
        elif k == "search_scale":
            vals = [0.6, 1.5] if rnd == 1 else [best[k] * 0.8, best[k] * 1.25]
        else:
            ref = best[k] if best[k] else base[k]
            vals = [ref * m for m in STEPS[rnd]] if best[k] else [base[k] * 0.5, base[k]]
        for v in vals:
            v = int(v) if k in INT_SETTINGS else round(v, 4)
            c = {**best, k: v}
            if c == best or c["MIN_COMPS"] < 3 or c["MAX_COMPS"] < c["MIN_COMPS"]:
                continue
            if c not in out:
                out.append(c)
    return out


def _objective(s: dict) -> float:
    return s["median_abs_error_pct"]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--county", default="pasco")
    p.add_argument("--sample", type=int, default=2500, help="sales from the search months")
    p.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    p.add_argument("--work-dir", type=Path)
    p.add_argument("--site-dir", type=Path, default=ROOT / "site" / "data")
    a = p.parse_args(argv)
    work = a.work_dir or ROOT / "work" / a.county

    parcels = pd.read_parquet(work / "parcels.parquet")
    sales = pd.read_parquet(work / "sales.parquet")
    subjects = backtest.subjects_for(parcels, sales)
    odd = subjects["date"].dt.to_period("M").map(lambda m: m.ordinal % 2 == 1)
    search, check = subjects[odd], subjects[~odd]
    if a.sample < len(search):
        search = search.sample(a.sample, random_state=1)
    paths = {}
    for name, df in (("search", search), ("check", check)):
        paths[name] = str(work / f"tune_{name}.pkl")
        df.to_pickle(paths[name])
    print(f"search months: {len(search)} sales; check months: {len(check)} sales; {a.workers} workers", flush=True)

    base = defaults()
    t0 = time.time()
    with ProcessPoolExecutor(a.workers, initializer=_init,
                             initargs=(str(work), str(a.site_dir), paths["search"])) as pool:
        best, best_s = list(pool.map(_score, [base]))[0]
        print(f"defaults: {_objective(best_s):.2f}% median abs error", flush=True)
        history = [{"round": 0, "config": base, "summary": best_s}]
        for rnd in (1, 2):
            cands = candidates(best, base, rnd)
            results = list(pool.map(_score, cands))
            history += [{"round": rnd, "config": c, "summary": s} for c, s in results]
            gains = {}
            for c, s in results:
                k = next(k for k in c if c[k] != best[k])
                gain = _objective(best_s) - _objective(s)
                if gain > MIN_GAIN and gain > gains.get(k, (0, None))[0]:
                    gains[k] = (gain, c[k])
            for k, (g, v) in sorted(gains.items(), key=lambda kv: -kv[1][0]):
                print(f"  round {rnd}: {k} {best[k]} -> {v}  (-{g:.2f} pts)", flush=True)
            if not gains:
                print(f"  round {rnd}: no change beats the current settings by {MIN_GAIN} pts", flush=True)
                continue
            combo = {**best, **{k: v for k, (g, v) in gains.items()}}
            if combo["MAX_COMPS"] < combo["MIN_COMPS"]:
                combo["MAX_COMPS"] = combo["MIN_COMPS"]
            single = max(gains.items(), key=lambda kv: kv[1][0])
            single_cfg = {**best, single[0]: single[1][1]}
            (c1, s1), (c2, s2) = pool.map(_score, [combo, single_cfg])
            cand, cand_s = (c1, s1) if _objective(s1) <= _objective(s2) else (c2, s2)
            if _objective(cand_s) < _objective(best_s):
                best, best_s = cand, cand_s
            print(f"  round {rnd} result: {_objective(best_s):.2f}%  ({time.time() - t0:.0f}s)", flush=True)

    with ProcessPoolExecutor(2, initializer=_init, initargs=(str(work), str(a.site_dir), paths["check"])) as pool:
        (_, base_check), (_, best_check) = pool.map(_score, [base, best])

    changed = {k: [base[k], best[k]] for k in base if base[k] != best[k]}
    out = {"defaults": base, "tuned": best, "changed": changed,
           "search": {"n": len(search), "defaults": history[0]["summary"], "tuned": best_s},
           "check": {"n": len(check), "defaults": base_check, "tuned": best_check},
           "history": history}
    (work / "tune.json").write_text(json.dumps(out, indent=1, default=float))
    print("\nchanged settings:", json.dumps(changed) if changed else "none")
    for name in ("search", "check"):
        d, t = out[name]["defaults"], out[name]["tuned"]
        print(f"{name:>6} months ({out[name]['n']} sales): median abs {d['median_abs_error_pct']:.2f}% -> "
              f"{t['median_abs_error_pct']:.2f}%, within 10% {d['within_10_pct']:.1f}% -> {t['within_10_pct']:.1f}%, "
              f"in range {d['in_range_pct']:.1f}% -> {t['in_range_pct']:.1f}%")


if __name__ == "__main__":
    main()
