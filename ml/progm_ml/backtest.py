"""
Walk-forward (expanding window) training and prediction. For target season t the model is trained ONLY on target seasons s < t,
whose features come from seasons < s and whose outcomes (season s) were final before the forecast date for t (1 Oct t).
Predictions for t use features from seasons < t. Output is a predictions document the server's chronological evaluation consumes.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .features import build_features, feature_columns, labels
from .models import LGB_PARAMS, StatProjector

MODEL_VERSIONS = {"lgbm": "progm.ml-v1.lgbm.1", "ridge": "progm.ml-v1.ridge.1"}


def forecast_as_of(t: int) -> str:
    return f"{t}-10-01T00:00:00.000Z"


def training_frame(df: pd.DataFrame, target_season: int, first_training_target: int):
    Xs, Ys = [], []
    for s in range(first_training_target, target_season):
        hist = df[df.season < s]                       # features: strictly before s
        F = build_features(hist, s)
        if F.empty:
            continue
        Xs.append(F); Ys.append(labels(df[df.season == s], F.player_id))
    X = pd.concat(Xs, ignore_index=True); Y = pd.concat(Ys, ignore_index=True)
    return X, Y


def fold_predictions(df: pd.DataFrame, target_season: int, kind: str, first_training_target: int) -> tuple[pd.DataFrame, dict]:
    known = df[df.season < target_season]               # the ONLY data this fold may touch
    X, Y = training_frame(known, target_season, first_training_target)
    cols = feature_columns(X)
    model = StatProjector(kind).fit(X[cols], Y)
    F = build_features(known, target_season)
    P = model.predict(F[cols])
    P.insert(0, "player_id", F.player_id.values)
    meta = {"trainingTargetSeasons": sorted(int(x) for x in X.target_season.unique()), "trainedThroughSeason": int(X.target_season.max()),
            "dataCutoffSeason": int(known.season.max()), "trainingRows": model.training_rows, "features": cols}
    return P, meta


def run(df: pd.DataFrame, targets: list[int], kind: str, provenance_hash: str, first_training_target: int = 2014) -> dict:
    preds, folds = [], {}
    for t in targets:
        P, meta = fold_predictions(df, t, kind, first_training_target)
        folds[t] = {k: v for k, v in meta.items() if k != "features"}
        for r in P.itertuples(index=False):
            iv = {}
            if hasattr(r, "games_lo"):
                iv = {"games": {"lo": float(r.games_lo), "hi": float(r.games_hi)}, "minutes": {"lo": float(r.minutes_lo), "hi": float(r.minutes_hi)}}
            preds.append({
                "targetSeason": t, "playerId": str(int(r.player_id)), "asOf": forecast_as_of(t), "trainedThroughSeason": meta["trainedThroughSeason"],
                "dataCutoffSeason": meta["dataCutoffSeason"], "games": float(r.games), "minutes": float(r.minutes),
                "statLine": {"minutes": float(r.minutes), "points": float(r.pts), "offRebounds": float(r.oreb), "defRebounds": float(r.dreb), "rebounds": float(r.reb),
                             "assists": float(r.ast), "steals": float(r.stl), "blocks": float(r.blk), "turnovers": float(r.tov), "personalFouls": float(r.pf),
                             "fgMade": float(r.fgm), "ftMade": float(r.ftm), "threesMade": float(r.fg3m), "doubleDoubles": float(r.dd_rate), "tripleDoubles": float(r.td_rate)},
                "intervals": iv, "nominalIntervalCoverage": 0.8,
            })
    feature_hash = hashlib.sha256(json.dumps(meta["features"]).encode()).hexdigest()[:12]
    return {
        "schema": "progm.ml-predictions.v1", "model": {"id": f"ml_{kind}", "version": MODEL_VERSIONS[kind], "featureHash": feature_hash,
                                                      "params": LGB_PARAMS if kind == "lgbm" else {"ridge_alpha": 10.0}, "features": meta["features"]},
        "provenanceHash": provenance_hash, "generatedAt": datetime.now(timezone.utc).isoformat(), "folds": folds, "predictions": preds,
    }
