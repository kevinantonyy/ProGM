"""Builds the ML v1 evaluation report from the server's chronological evaluation output (no model fitting here)."""
from __future__ import annotations

import json
import math
import sys

import numpy as np
import pandas as pd

METRICS = [("gamesMae", "Games MAE", "low"), ("gamesRmse", "Games RMSE", "low"), ("gamesBias", "Games bias", None), ("minutesMae", "Minutes MAE", "low"),
           ("fppgMae", "FP/G MAE", "low"), ("seasonTotalMae", "Season FP MAE", "low"), ("totalSpearman", "Spearman (season FP)", "high"),
           ("fppgSpearman", "Spearman (FP/G)", "high"), ("top25TotalOverlap", "Top-25 overlap", "high"), ("top50TotalOverlap", "Top-50 overlap", "high"),
           ("top25TotalCapture", "Top-25 capture", "high"), ("top50TotalCapture", "Top-50 capture", "high")]
PATH = {"gamesMae": ("games", "mae"), "gamesRmse": ("games", "rmse"), "gamesBias": ("games", "bias"), "minutesMae": ("minutes", "mae"), "fppgMae": ("fppg", "mae"),
        "seasonTotalMae": ("seasonTotal", "mae"), "totalSpearman": ("rank", "totalSpearman"), "fppgSpearman": ("rank", "fppgSpearman")}
T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306}


def fold_value(fold, key):
    if key in PATH:
        a, b = PATH[key]
        return fold[a][b]
    n = 25 if "25" in key else 50
    kind = "overlap" if "Overlap" in key else "capture"
    return (fold["topN"][str(n)]["total"] or {}).get(kind)


def table(report, seasons):
    rows = {}
    for m, folds in report["folds"].items():
        rows[m] = {k: np.nanmean([fold_value(folds[str(t)], k) if fold_value(folds[str(t)], k) is not None else np.nan for t in seasons]) for k, _, _ in METRICS}
    return pd.DataFrame(rows).T


def paired(report, model, ref, key, seasons, lower):
    d = [fold_value(report["folds"][model][str(t)], key) - fold_value(report["folds"][ref][str(t)], key) for t in seasons
         if fold_value(report["folds"][model][str(t)], key) is not None and fold_value(report["folds"][ref][str(t)], key) is not None]
    n = len(d)
    if n < 2:
        return None
    mean = float(np.mean(d)); half = T975.get(n - 1, 2.0) * float(np.std(d, ddof=1)) / math.sqrt(n)
    better = sum(1 for x in d if (x < 0 if lower else x > 0))
    return mean, mean - half, mean + half, better, n


def native_coverage(pred_path, dataset_path):
    P = pd.DataFrame(json.load(open(pred_path))["predictions"])
    if not P.intervals.map(bool).all():
        return None
    D = pd.read_parquet(dataset_path); D["playerId"] = D.player_id.astype(str)
    A = D[["season", "playerId", "gp", "mpg"]].rename(columns={"season": "targetSeason"})
    M = P.merge(A, on=["targetSeason", "playerId"], how="left"); M["gp"] = M.gp.fillna(0)
    g = M.apply(lambda r: r.intervals["games"]["lo"] <= r.gp <= r.intervals["games"]["hi"], axis=1)
    played = M.gp >= 15
    mi = M[played].apply(lambda r: r.intervals["minutes"]["lo"] <= r.mpg <= r.intervals["minutes"]["hi"], axis=1)
    return {"games": float(g.mean()), "minutes": float(mi.mean()), "gamesWidth": float(M.apply(lambda r: r.intervals["games"]["hi"] - r.intervals["games"]["lo"], axis=1).mean())}


def main(report_path, out_md, ref="production", extra=()):
    r = json.load(open(report_path))
    seasons = r["targetSeasons"]; dev = [t for t in seasons if t <= 2022]; confirm = [t for t in seasons if t > 2022]
    lines = ["# ML v1 evaluation (chronological, identical pools and league scoring)", "", f"Folds: {seasons} (season start year). Development folds {dev}; confirmation folds {confirm}.", ""]
    for label, ss in [("All folds", seasons), ("Development folds", dev), ("Confirmation folds", confirm)]:
        t = table(r, ss)
        lines += [f"## {label}", "", "| model | " + " | ".join(n for _, n, _ in METRICS) + " |", "|---" * (len(METRICS) + 1) + "|"]
        for m, row in t.iterrows():
            lines.append(f"| {m} | " + " | ".join("-" if pd.isna(row[k]) else f"{row[k]:.3f}" for k, _, _ in METRICS) + " |")
        lines.append("")
    lines += [f"## Paired difference vs {ref}, all folds (mean [95% t interval], folds better / folds)", ""]
    for m in r["folds"]:
        if m == ref:
            continue
        cells = []
        for k, n, d in METRICS:
            if d is None:
                continue
            p = paired(r, m, ref, k, seasons, d == "low")
            cells.append(f"{n}: {p[0]:+.3f} [{p[1]:+.3f}, {p[2]:+.3f}] {p[3]}/{p[4]}" if p else f"{n}: -")
        lines.append(f"- **{m}**: " + "; ".join(cells))
    lines += ["", "## Per-fold values", ""]
    for k, n, _ in METRICS:
        lines += [f"### {n}", "", "| model | " + " | ".join(str(t) for t in seasons) + " |", "|---" * (len(seasons) + 1) + "|"]
        for m, folds in r["folds"].items():
            vals = [fold_value(folds[str(t)], k) for t in seasons]
            lines.append(f"| {m} | " + " | ".join("-" if v is None else f"{v:.3f}" for v in vals) + " |")
        lines.append("")
    for name, path, ds in extra:
        cov = native_coverage(path, ds)
        if cov is None:
            lines += [f"{name}: no native intervals (residual-based intervals from the server framework only).", ""]
            continue
        lines += [f"Native 80% quantile intervals ({name}): games coverage {cov['games']:.3f} (mean width {cov['gamesWidth']:.1f} games), minutes coverage {cov['minutes']:.3f}.", ""]
    open(out_md, "w").write("\n".join(lines))
    return r


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], extra=[("ml_lgbm", "artifacts/predictions_lgbm.json", "artifacts/dataset/player_seasons.parquet"), ("ml_ridge", "artifacts/predictions_ridge.json", "artifacts/dataset/player_seasons.parquet")])
