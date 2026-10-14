# Phase 13: first real game-level evaluation (2026-10-14)

**Status:** historical, game level, not production-approved. Data basis: maintainer permissions plus the owner's risk acceptance (`docs/data-provenance/`). This is **not** verified NBA permission. Raw data was stored only in a temporary local Postgres in the development sandbox, deleted after the run, and is not in this repository.

## Data
- Source: `llimllib-nba-player-game-logs` (llimllib/nba_data v1 `player_game_logs.parquet`, stats.nba.com-derived). Game dates and home/away came from the same repository's team logs (`gamelogs.parquet`). Converted with DuckDB, regular season (game id prefix `002`) only.
- Imported: **2024-25 and 2025-26**, with 2,460 games (1,230 per season, 82 per team), 64,695 player-game rows (11,747 of them did-not-play), and 697 players.
- **Not imported: 2015-16 to 2023-24.** In llimllib's v1 player logs, both the per-season and all-seasons files hold only the last 4–15 regular-season games of each of those seasons, for example 15 of 1,230 games in 2023-24. llimllib's v2 hosted dataset, which should be complete, was not reachable from the sandbox.
- Integrity:
  - no duplicate player-games and no orphan rows;
  - every game has both teams;
  - no played row is missing minutes or points;
  - re-import changed nothing (idempotent).
- Checked against team box scores:
  - points, rebounds, assists and threes match in at least 99.8% of 4,920 team-games;
  - turnovers differ because team turnovers are not charged to players (team total higher in 2,605, lower in 5);
  - player points exceed team points in 4 games (0022400798, 0022500720, 0022500876, 0022501030; 1 to 31 points), kept as-is and flagged.

## Method
- Scoring: **assumed Yahoo default points scoring** (PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1). This is not any ProGM user's league.
- Each played game is predicted from the player's games on earlier dates only.
- Split: 2024-25 is history only. Validation is 2025-26 games before 2026-02-01; test is 2025-26 games from 2026-02-01 to 2026-04-12. The cutoff was fixed before results were seen.
- Baseline: the player's previous-season mean fantasy points per game.
- Candidates: recency blends (exponential half-life of 5/10/20 games over the last 30, shrunk toward the previous-season mean with weight 2/8). The best one was chosen on validation MAE, then scored once on test.
- All models are scored on identical games where every model has a prediction. Players need a 2024-25 history.

## Results (fantasy points per game)

| Phase | Model | Games | MAE | RMSE | Bias (pred − actual) |
|---|---|---|---|---|---|
| Validation (to 2026-01-31) | Previous-season baseline | 13,831 | 8.967 | 11.362 | −0.343 |
| Validation | Recency h5 k2 (selected) | 13,831 | 7.837 | 9.949 | +0.190 |
| **Test (2026-02-01 on)** | **Previous-season baseline** | **9,092** | **9.684** | **12.284** | **−1.088** |
| **Test** | **Recency h5 k2** | **9,092** | **8.009** | **10.273** | **−0.481** |

Other validation candidates had MAE 7.894 (h10 k2), 7.960 (h20 k2), 8.056 (h10 k8), 8.068 (h20 k8) and 8.096 (h5 k8).

On test, the recency blend lowers MAE by **17.3%**. It is one test season, part of one season (2025-26 February to April), under one assumed scoring system. The selected setting is at the edge of the grid (shortest half-life, lowest prior weight), so the best setting may lie beyond it.

## Caveats
- One season of history and one partial test season. Late-season effects (rest, tanking, injuries) may favour recency more than a full season would.
- The baseline is the preseason-style projection. ProGM's in-season production blend (65% season averages and 35% recent form) was not evaluated here.
- Availability (DNP and rest) is not predicted; only games actually played are scored.
