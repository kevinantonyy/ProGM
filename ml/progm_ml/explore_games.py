"""
EXPLORATORY games-played variants aimed at top rotation players. These folds were already used to build ML v1, so nothing here
can establish superiority; results only decide what to pre-register for the 2026-27 prospective test.

Variants (games only; per-game production is held fixed when evaluated):
  g_role      ML games + team-relative role features from the previous season (minutes rank/share and usage rank within team)
  g_weighted  ML games trained with sample weight = previous-season minutes (emphasises rotation players)
  g_shrink_wf ML games shrunk toward production games; the weight is chosen walk-forward, using ONLY earlier folds' outcomes,
              separately for the predicted top tier (top 75 by production season total) and the rest
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from .backtest import forecast_as_of, training_frame
from .features import build_features, feature_columns, labels
from .models import TargetModel

TOP_TIER = 75


def role_features(history: pd.DataFrame, target_season: int, F: pd.DataFrame) -> pd.DataFrame:
    last = history[history.season == target_season - 1].copy()
    last["team_min_rank"] = last.groupby("team").minutes_total.rank(ascending=False)
    last["team_min_share"] = last.minutes_total / last.groupby("team").minutes_total.transform("sum")
    last["team_usg_rank"] = last.groupby("team").usg_pct.rank(ascending=False)
    s = last.set_index("player_id")
    F = F.copy()
    for c in ("team_min_rank", "team_min_share", "team_usg_rank"):
        F[f"{c}_1"] = F.player_id.map(s[c])
    return F


def games_fold(df, t, variant, first=2014):
    known = df[df.season < t]
    Xs, Ys = [], []
    for s in range(first, t):
        F = build_features(known[known.season < s], s)
        if variant == "g_role":
            F = role_features(known[known.season < s], s, F)
        Xs.append(F); Ys.append(labels(known[known.season == s], F.player_id))
    X = pd.concat(Xs, ignore_index=True); Y = pd.concat(Ys, ignore_index=True); cols = feature_columns(X)
    w = X.minutes_total_1.fillna(0).values / 1000 if variant == "g_weighted" else None
    m = TargetModel("lgbm").fit(X[cols], Y.gp_frac, w=w)
    F = build_features(known, t)
    if variant == "g_role":
        F = role_features(known, t, F)
    return pd.DataFrame({"player_id": F.player_id.values, "games": np.clip(m.predict(F[cols])["mean"], 0, 1) * 82})


def doc(kind, rows, base_doc):
    stat = {(p["targetSeason"], p["playerId"]): p for p in base_doc["predictions"]}
    preds = []
    for t, pid, g in rows:
        b = stat[(t, pid)]
        preds.append({**b, "games": float(g), "intervals": {}})
    return {"schema": "progm.ml-predictions.v1", "model": {"id": kind, "version": f"progm.explore.{kind}.1", "featureHash": "explore"}, "provenanceHash": base_doc["provenanceHash"], "predictions": preds, "folds": {}}


def main(dataset, base_lgbm, records, outdir, targets="2017-2025"):
    df = pd.read_parquet(dataset); base = json.load(open(base_lgbm)); lo, hi = map(int, targets.split("-")); T = list(range(lo, hi + 1))
    for v in ("g_role", "g_weighted"):
        rows = []
        for t in T:
            P = games_fold(df, t, v)
            rows += [(t, str(int(r.player_id)), r.games) for r in P.itertuples()]
        json.dump(doc(v, rows, base), open(f"{outdir}/predictions_{v}.json", "w"))
        print(v, "done")
    # walk-forward shrinkage toward production
    R = pd.DataFrame([{**{k: r[k] for k in ("modelId", "targetSeason", "playerId")}, **r["predicted"]} for r in map(json.loads, open(records)) if r["modelId"] in ("production", "ml_lgbm")])
    W = R.pivot_table(index=["targetSeason", "playerId"], columns="modelId", values=["games", "total"]).reset_index()
    W.columns = ["_".join(c for c in col if c) for col in W.columns]
    A = df[["season", "player_id", "gp"]].assign(playerId=df.player_id.astype(str)).rename(columns={"season": "targetSeason"})[["targetSeason", "playerId", "gp"]]
    W = W.merge(A, on=["targetSeason", "playerId"], how="left"); W["gp"] = W.gp.fillna(0)
    W["top"] = W.groupby("targetSeason").total_production.rank(ascending=False) <= TOP_TIER
    grid = np.linspace(0, 1, 11); chosen = {}; rows = []
    for t in T:
        past = W[W.targetSeason < t]
        for tier in (True, False):
            p = past[past.top == tier]
            chosen[(t, tier)] = 0.5 if p.empty else float(min(grid, key=lambda w: ((w * p.games_ml_lgbm + (1 - w) * p.games_production) - p.gp).abs().mean()))
        cur = W[W.targetSeason == t]
        for r in cur.itertuples():
            w = chosen[(t, bool(r.top))]
            rows.append((t, r.playerId, w * r.games_ml_lgbm + (1 - w) * r.games_production))
    json.dump(doc("g_shrink_wf", rows, base), open(f"{outdir}/predictions_g_shrink_wf.json", "w"))
    print("walk-forward weights (top tier, rest):", {t: (chosen[(t, True)], chosen[(t, False)]) for t in T})


if __name__ == "__main__":
    main(*sys.argv[1:5])
