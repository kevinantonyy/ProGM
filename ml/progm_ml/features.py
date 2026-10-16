"""
Point-in-time features. `build_features(history, target_season)` receives a frame that must contain ONLY seasons before the target
(it raises otherwise) and describes each player in the target-season universe from that history alone.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

RATE_STATS = ["pts", "oreb", "dreb", "ast", "stl", "blk", "tov", "fgm", "ftm", "fg3m", "pf"]
MIN_PRIOR_MINUTES = 800  # same universe rule as the server's chronological evaluation


def universe(history: pd.DataFrame, target_season: int, min_prior_minutes: float = MIN_PRIOR_MINUTES) -> pd.DataFrame:
    last = history[(history.season == target_season - 1) & (history.minutes_total >= min_prior_minutes)]
    return last[["player_id"]].drop_duplicates().sort_values("player_id")


def build_features(history: pd.DataFrame, target_season: int, min_prior_minutes: float = MIN_PRIOR_MINUTES) -> pd.DataFrame:
    if len(history) and history.season.max() >= target_season:
        raise ValueError(f"Leakage guard: history contains season {history.season.max()} for target {target_season}.")
    ids = universe(history, target_season, min_prior_minutes).player_id
    h = history[history.player_id.isin(ids)].copy()
    h["gp_frac"] = h.gp / h.season_games
    for c in RATE_STATS:
        h[f"{c}_pm"] = h[c] / h.minutes_total
    feats = pd.DataFrame({"player_id": ids.values})
    for k in (1, 2, 3):
        lag = h[h.season == target_season - k].set_index("player_id")
        f = feats.player_id.map
        feats[f"present_{k}"] = feats.player_id.isin(lag.index).astype(float)
        for col in ["gp_frac", "mpg", "minutes_total", "usg_pct"]:
            feats[f"{col}_{k}"] = f(lag[col])
        if k == 1:
            for col in [f"{c}_pm" for c in RATE_STATS] + ["dd_rate", "td_rate", "late20_share", "longest_absence", "starter_share", "pace"]:
                feats[f"{col}_1"] = f(lag[col])
            feats["age_t"] = f(lag["age"]) + 1
            feats["draft_number"] = f(lag["draft_number"])
            feats["experience_t"] = target_season - f(lag["draft_year"])
            feats["undrafted"] = f(lag["draft_year"]).isna().astype(float)
            feats["height"] = f(lag["height"])
    # minutes-weighted three-season rates (only seasons that exist)
    w3 = h[h.season >= target_season - 3]
    tot = w3.groupby("player_id").minutes_total.sum()
    for c in RATE_STATS + ["dd2", "td3"]:
        num = w3.groupby("player_id")[c].sum()
        feats[f"{c}_pm3"] = feats.player_id.map(num / tot)
    career = h.groupby("player_id").agg(seasons_seen=("season", "nunique"), career_gp_frac=("gp_frac", "mean"), worst_gp_frac=("gp_frac", "min"))
    for c in career.columns:
        feats[c] = feats.player_id.map(career[c])
    feats["mpg_trend"] = feats.mpg_1 - feats.mpg_2
    feats["gp_frac_trend"] = feats.gp_frac_1 - feats.gp_frac_2
    feats["target_season"] = target_season
    return feats


def labels(season_rows: pd.DataFrame, player_ids: pd.Series) -> pd.DataFrame:
    """Outcomes for a season that is already final. Absent players played 0 games (dataset coverage is complete)."""
    s = season_rows.set_index("player_id")
    out = pd.DataFrame({"player_id": player_ids.values})
    m = out.player_id.map
    out["gp"] = m(s.gp).fillna(0)
    season_games = float(season_rows.season_games.max()) if len(season_rows) else 82.0
    out["gp_frac"] = out.gp / season_games
    out["mpg"] = m(s.mpg)
    out["minutes_total"] = m(s.minutes_total)
    for c in RATE_STATS:
        out[f"{c}_pm"] = m(s[c] / s.minutes_total)
    out["dd_rate"] = m(s.dd_rate)
    out["td_rate"] = m(s.td_rate)
    return out


FEATURE_COLUMNS = None  # resolved lazily from build_features output (everything except ids)


def feature_columns(frame: pd.DataFrame) -> list[str]:
    return [c for c in frame.columns if c not in ("player_id", "target_season")]
