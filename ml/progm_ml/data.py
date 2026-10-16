"""
Historical dataset builder.

Sources (both from the GitHub repository llimllib/nba_data, authorized by the owner for experimental development):
  data/playerstats.parquet        stats.nba.com regular-season player-season TOTALS, 2013-14 .. 2025-26 (column `year` = season end year)
  data/espn/player_box.parquet    ESPN player-game box scores, 2018-19 .. 2025-26 (column `season` = end year; game_id prefix 002 = regular season)

Output: one row per player-season (season = START year, ProGM's convention) with totals, per-game statistics, age, draft info,
usage, and, where complete game logs exist, statistics DERIVED from games: double-doubles, triple-doubles, late-season availability,
longest absence and starter share. Nothing is invented: a missing value stays NaN; game-derived fields are NaN for seasons without
game logs, and seasons whose game logs are incomplete are flagged.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd

STATS = ["pts", "oreb", "dreb", "reb", "ast", "stl", "blk", "tov", "fgm", "ftm", "fg3m", "pf"]
DATASET_VERSION = "progm.ml-player-seasons.v1"
DD_CATS = ["pts", "reb", "ast", "stl", "blk"]


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def source_manifest(data_dir: str) -> dict:
    files = {"playerstats": os.path.join(data_dir, "playerstats.parquet"), "espn_player_box": os.path.join(data_dir, "espn", "player_box.parquet")}
    repo = os.path.dirname(os.path.abspath(data_dir))
    try:
        commit = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30).stdout.strip() or None
    except Exception:  # pragma: no cover - provenance is best effort when the clone is absent
        commit = None
    return {
        "name": "llimllib/nba_data (playerstats + espn player_box)",
        "provider": "github.com/llimllib/nba_data",
        "sourceUrl": "https://github.com/llimllib/nba_data",
        "repoCommit": commit,
        "files": {k: {"path": os.path.relpath(v, repo), "sha256": _sha256(v)} for k, v in files.items() if os.path.exists(v)},
        "permission": "Owner authorized use of these free GitHub datasets for experimental development on 2026-10-16 (not production-licensed).",
        "licenseStatus": "owner-authorized-experimental",
        "authorized": True,
        "synthetic": False,
        "coverage": "complete",
        "acquiredAt": datetime.now(timezone.utc).isoformat(),
        "datasetVersion": DATASET_VERSION,
    }


def load_season_totals(data_dir: str) -> pd.DataFrame:
    p = os.path.join(data_dir, "playerstats.parquet")
    df = duckdb.connect().sql(f"""
        SELECT CAST(player_id AS BIGINT) AS player_id, player_name AS name, year, age, gp, min AS minutes_total,
               pts, oreb, dreb, reb, ast, stl, blk, tov, fgm, ftm, fg3m, pf, dd2, td3, usg_pct, pace,
               team_abbreviation AS team, TRY_CAST(NULLIF(draft_year, 'Undrafted') AS INTEGER) AS draft_year,
               TRY_CAST(draft_number AS INTEGER) AS draft_number, player_height_inches AS height
        FROM '{p}'""").df()
    df = df[df.gp > 0].copy()
    if df.duplicated(["player_id", "year"]).any():
        raise ValueError("playerstats has duplicate player-season rows; refusing to guess which is correct")
    df["season"] = df.year - 1  # start-year convention
    return df.drop(columns=["year"])


def load_game_logs(data_dir: str) -> pd.DataFrame:
    p = os.path.join(data_dir, "espn", "player_box.parquet")
    g = duckdb.connect().sql(f"""
        SELECT season - 1 AS season, game_id, player_id, team, starter, pts, rebounder AS reb, assister AS ast, stlr AS stl, blockplyr AS blk,
               CAST(split_part(minutes_played, ':', 1) AS DOUBLE) + CAST(split_part(minutes_played, ':', 2) AS DOUBLE) / 60 AS minutes
        FROM '{p}' WHERE substr(game_id, 1, 3) = '002' AND played = 1""").df()
    return g


def derive_from_games(g: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per player-season statistics derived from game rows, plus per-season completeness."""
    tens = sum((g[c] >= 10).astype(int) for c in DD_CATS)
    g = g.assign(dd=(tens >= 2).astype(int), td=(tens >= 3).astype(int))
    agg = g.groupby(["season", "player_id"]).agg(games_logged=("game_id", "nunique"), dd_games=("dd", "sum"), td_games=("td", "sum"), starts=("starter", "sum")).reset_index()

    # Availability inside the season, relative to the games of the player's LAST team (game_id order is chronological within a season).
    last_team = g.sort_values("game_id").groupby(["season", "player_id"]).team.last().rename("last_team").reset_index()
    team_games = g.groupby(["season", "team"]).game_id.apply(lambda s: sorted(set(s))).to_dict()
    played = g.groupby(["season", "player_id", "team"]).game_id.apply(set).to_dict()
    late, streak = [], []
    for r in last_team.itertuples(index=False):
        tg = team_games[(r.season, r.last_team)]
        mine = played.get((r.season, r.player_id, r.last_team), set())
        last20 = tg[-20:]
        late.append(sum(1 for x in last20 if x in mine) / len(last20))
        first = next((i for i, x in enumerate(tg) if x in mine), len(tg))   # only count absences after joining the team
        best = cur = 0
        for x in tg[first:]:
            cur = 0 if x in mine else cur + 1
            best = max(best, cur)
        streak.append(best)
    last_team["late20_share"] = late
    last_team["longest_absence"] = streak
    out = agg.merge(last_team[["season", "player_id", "late20_share", "longest_absence"]], on=["season", "player_id"])
    out["starter_share"] = out.starts / out.games_logged
    completeness = g.groupby("season").game_id.nunique().rename("regular_season_games_logged").reset_index()
    return out, completeness


# Regular-season games actually scheduled (league-wide): 1230 normally; 2019-20 was cut to 1059, 2020-21 to 1080.
EXPECTED_GAMES = {2019: 1059, 2020: 1080}


def build_dataset(data_dir: str) -> tuple[pd.DataFrame, dict]:
    s = load_season_totals(data_dir)
    g = load_game_logs(data_dir)
    derived, completeness = derive_from_games(g)
    completeness["expected_games"] = completeness.season.map(lambda x: EXPECTED_GAMES.get(x, 1230))
    completeness["complete"] = completeness.regular_season_games_logged >= completeness.expected_games - 2
    df = s.merge(derived, on=["season", "player_id"], how="left")
    complete = set(completeness.loc[completeness.complete, "season"])
    df["game_logs"] = np.where(df.season.isin(complete), "complete", np.where(df.season.isin(completeness.season), "partial", "none"))
    # DD/TD: derived from game logs where they are complete; otherwise the source's own game-based counts, flagged.
    use_logs = df.game_logs.eq("complete") & df.dd_games.notna()
    df["dd_count"] = np.where(use_logs, df.dd_games, df.dd2)
    df["td_count"] = np.where(use_logs, df.td_games, df.td3)
    df["dd_source"] = np.where(use_logs, "derived_from_game_logs", "source_season_count")
    for c in ["late20_share", "longest_absence", "starter_share"]:  # in-season availability only where every game is present
        df.loc[~df.game_logs.eq("complete"), c] = np.nan
    df["season_games"] = df.groupby("season").gp.transform("max").clip(upper=82)
    df["mpg"] = df.minutes_total / df.gp
    for c in STATS:
        df[f"{c}_pg"] = df[c] / df.gp
    df["dd_rate"] = df.dd_count / df.gp
    df["td_rate"] = df.td_count / df.gp
    manifest = source_manifest(data_dir)
    manifest["seasons"] = sorted(int(x) for x in df.season.unique())
    manifest["gameLogCompleteness"] = completeness.assign(season=completeness.season.astype(int)).to_dict("records")
    ddcheck = df[use_logs]
    manifest["ddDerivationCheck"] = {"rows": int(len(ddcheck)), "meanAbsDiffDDvsSource": float((ddcheck.dd_games - ddcheck.dd2).abs().mean()), "meanAbsDiffTDvsSource": float((ddcheck.td_games - ddcheck.td3).abs().mean())}
    return df.sort_values(["season", "player_id"]).reset_index(drop=True), manifest


def to_progm_rows(df: pd.DataFrame) -> list[dict]:
    """Rows in the server's historical-snapshot contract (tabular-json); NaN -> null, never zero."""
    def n(x):
        return None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)
    rows = []
    for r in df.itertuples(index=False):
        exp = None if pd.isna(r.draft_year) else max(0, int(r.season) - int(r.draft_year))
        rows.append({
            "season": int(r.season), "playerId": str(int(r.player_id)), "name": r.name, "teamAbbr": r.team, "age": n(r.age), "experience": exp,
            "gamesPlayed": int(r.gp), "minutesPerGame": n(r.mpg), "minutesTotal": n(r.minutes_total),
            "stats": {"points": n(r.pts_pg), "rebounds": n(r.reb_pg), "offRebounds": n(r.oreb_pg), "defRebounds": n(r.dreb_pg), "assists": n(r.ast_pg),
                      "steals": n(r.stl_pg), "blocks": n(r.blk_pg), "turnovers": n(r.tov_pg), "personalFouls": n(r.pf_pg), "fgMade": n(r.fgm_pg),
                      "ftMade": n(r.ftm_pg), "threesMade": n(r.fg3m_pg), "doubleDoubles": n(r.dd_rate), "tripleDoubles": n(r.td_rate)},
        })
    return rows


def write_dataset(data_dir: str, out_dir: str) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    df, manifest = build_dataset(data_dir)
    df.to_parquet(os.path.join(out_dir, "player_seasons.parquet"), index=False)
    prov = {k: manifest[k] for k in ["name", "provider", "sourceUrl", "permission", "licenseStatus", "authorized", "synthetic", "coverage", "acquiredAt", "datasetVersion"]}
    prov["exportId"] = (manifest.get("repoCommit") or "unknown")[:12]
    with open(os.path.join(out_dir, "player_seasons.progm.json"), "w") as f:
        json.dump({"provenance": prov, "rows": to_progm_rows(df)}, f)
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, default=str)
    return manifest
