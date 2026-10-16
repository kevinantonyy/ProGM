"""
Experimental ML v1. Each target is a separate model; hyperparameters are fixed in advance (no tuning on evaluation folds).
  games      : share of the season's games played (absent = 0)  -> x 82
  minutes    : minutes per game (players with 10+ games)
  rates      : per-minute pts, oreb, dreb, ast, stl, blk, tov, fgm, ftm, fg3m, pf (players with 10+ games and 200+ minutes)
  dd / td    : double-double and triple-double rate per game
Per-game statistics = predicted per-minute rate x predicted minutes. League fantasy points are NOT predicted here.
"""
from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import RATE_STATS

LGB_PARAMS = dict(n_estimators=400, learning_rate=0.03, num_leaves=15, min_child_samples=25, subsample=0.8, subsample_freq=1,
                  colsample_bytree=0.8, reg_lambda=2.0, random_state=7, verbose=-1, n_jobs=2, deterministic=True, force_row_wise=True)
QUANTILES = (0.1, 0.9)


def _lgb(objective="regression", alpha=None):
    p = dict(LGB_PARAMS, objective=objective)
    if alpha is not None:
        p["alpha"] = alpha
    return lgb.LGBMRegressor(**p)


def _ridge():
    return make_pipeline(SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True), StandardScaler(), Ridge(alpha=10.0))


class TargetModel:
    def __init__(self, kind: str, quantiles: bool = False):
        self.kind, self.quantiles, self.models = kind, quantiles, {}

    def fit(self, X: pd.DataFrame, y: pd.Series, w=None):
        ok = y.notna()
        X, y = X[ok], y[ok]
        w = None if w is None else np.asarray(w)[ok.values]
        self.models["mean"] = (_lgb() if self.kind == "lgbm" else _ridge()).fit(X, y, **({"sample_weight": w} if w is not None and self.kind == "lgbm" else ({"ridge__sample_weight": w} if w is not None else {})))
        if self.quantiles and self.kind == "lgbm":
            for q in QUANTILES:
                self.models[q] = _lgb("quantile", q).fit(X, y)
        self.n = int(len(y))
        return self

    def predict(self, X):
        return {k: m.predict(X) for k, m in self.models.items()}


class StatProjector:
    """All targets for one fold. `kind` = 'lgbm' or 'ridge'."""

    def __init__(self, kind: str):
        self.kind = kind

    def fit(self, X: pd.DataFrame, Y: pd.DataFrame):
        played = Y.gp >= 10
        rate_ok = played & (Y.minutes_total >= 200)
        self.games = TargetModel(self.kind, quantiles=True).fit(X, Y.gp_frac)
        self.minutes = TargetModel(self.kind, quantiles=True).fit(X[played], Y.mpg[played], w=Y.gp[played])
        self.rates = {c: TargetModel(self.kind).fit(X[rate_ok], Y[f"{c}_pm"][rate_ok], w=Y.minutes_total[rate_ok]) for c in RATE_STATS}
        self.dd = TargetModel(self.kind).fit(X[played], Y.dd_rate[played], w=Y.gp[played])
        self.td = TargetModel(self.kind).fit(X[played], Y.td_rate[played], w=Y.gp[played])
        self.training_rows = {"games": self.games.n, "minutes": self.minutes.n, "rates": self.rates["pts"].n}
        return self

    def predict(self, X: pd.DataFrame) -> pd.DataFrame:
        g = self.games.predict(X); m = self.minutes.predict(X)
        out = pd.DataFrame(index=X.index)
        out["games"] = np.clip(g["mean"], 0, 1) * 82
        out["minutes"] = np.clip(m["mean"], 0, 48)
        if 0.1 in g:
            out["games_lo"] = np.clip(np.minimum(g[0.1], g["mean"]), 0, 1) * 82
            out["games_hi"] = np.clip(np.maximum(g[0.9], g["mean"]), 0, 1) * 82
            out["minutes_lo"] = np.clip(np.minimum(m[0.1], m["mean"]), 0, 48)
            out["minutes_hi"] = np.clip(np.maximum(m[0.9], m["mean"]), 0, 48)
        for c in RATE_STATS:
            out[c] = np.clip(self.rates[c].predict(X)["mean"], 0, None) * out.minutes
        out["reb"] = out.oreb + out.dreb
        out["dd_rate"] = np.clip(self.dd.predict(X)["mean"], 0, 1)
        out["td_rate"] = np.clip(self.td.predict(X)["mean"], 0, 1)
        return out
