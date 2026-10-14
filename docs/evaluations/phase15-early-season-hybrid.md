# Phase 15: early-season study and the live-data hybrid (2026-10-14)

**Status:** historical, game level, not production-approved. The data basis is unchanged: maintainer permissions plus the owner's risk acceptance, **not** verified NBA permission. Data: llimllib 2024-25 and 2025-26 regular-season player game logs (2,460 games; 64,695 rows), rebuilt with `docs/data-provenance/llimllib-to-gamelog-csv.sql` into a temporary local Postgres and deleted afterwards. Scoring is the **assumed Yahoo default points system** (PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1), not any user's league.

## Why a different model than Phase 14
Production has no per-player 30-game history. Its live inputs are:
- last-season per-game averages (ESPN);
- box scores of each team's last 10 completed games (NBA CDN), used for recent form.

The Phase 14 "recency over the last 30 games" therefore cannot run live without new data requests. The model evaluated here, and integrated, uses only the live inputs. It takes an exponentially weighted mean (half-life 5) of the player's games inside the league-wide 10-game window, blended into the existing model with weight `min(1, n / ramp)`, where `n` is the player's games in the window. With no window games it is the existing model. With no last season it uses the window alone (this applies only under the hybrid flag).

## Design and its limits
- The only early-season period that has a prior season is 2025-26 October to January, which is the validation period used in Phase 14. **A chronological out-of-sample early-season test is not possible with this data.**
- Instead, players were split deterministically by a hash of the player id into tune and holdout halves within that period. The schedule was chosen on tune players only and reported on holdout players. This is a player holdout over the same dates, so it shares season-wide effects; it is not a chronological test.
- The February–April 2026 test period was **not** used for any choice. It is reported for reference only.
- Every prediction uses only earlier-dated games, and the 10-game window uses only games before the target date.

## Selection (tune players, Oct 21 – Jan 31, 6,824 games)
Schedules tried: window recency alone; ramps of 2, 3, 5, 8 and 10 games; hard thresholds of 2, 3, 5 and 8 games.

Tune MAE:

| Schedule | MAE |
|---|---|
| **ramp 10** | **7.778** |
| ramp 8 | 7.779 |
| ramp 5 | 7.794 |
| threshold 3 | 7.805 |
| threshold 5 | 7.810 |
| ramp 3 | 7.821 |
| threshold 2 | 7.842 |
| ramp 2 | 7.848 |
| window recency alone | 7.887 |
| threshold 8 | 7.905 |

The existing model scored 8.223 on these games. Selected: **ramp 10** (with the window capped at 10 games, full recency weight needs all 10 games played). It sits at the edge of the grid; ramp 8 is essentially tied.

## Holdout players (Oct 21 – Jan 31, 7,007 identical games)

| Model | MAE | RMSE | Bias |
|---|---|---|---|
| Existing ProGM | 8.106 | 10.365 | −0.125 |
| Recency, 30 games (Phase 14, not live-feasible) | 7.800 | 9.936 | +0.396 |
| **Hybrid (ramp 10), live-feasible** | **7.756** | 9.936 | +0.236 |

By games already played this season (MAE / bias):

| Games played | Games | Existing | Recency 30 | Hybrid |
|---|---|---|---|---|
| 0 | 223 | 7.877 / +2.42 | 8.905 / +3.37 | 7.877 / +2.42 (falls back to existing) |
| 1–5 | 1,058 | 7.793 / +0.80 | 8.029 / +1.50 | **7.615** / +0.45 |
| 6–10 | 973 | 7.802 / −0.51 | 7.441 / −0.36 | **7.371** / −0.62 |
| 11–20 | 1,818 | 8.151 / −0.29 | **7.749** / −0.01 | 7.808 / +0.27 |
| 21+ | 2,935 | 8.308 / −0.42 | **7.783** / +0.27 | 7.893 / +0.25 |

Early in the season, pure 30-game recency is worse than the existing model, because it leans on last season's final games. The hybrid falls back to the existing model at 0 games and is best for players with 1–10 games.

## February–April 2026 (reference only; not used for tuning; 9,092 games)

| Model | MAE | RMSE | Bias |
|---|---|---|---|
| Existing ProGM | 8.656 | 11.035 | −0.842 |
| Recency, 30 games | **7.968** | **10.243** | −0.320 |
| Hybrid (ramp 10) | 8.092 | 10.379 | **−0.092** |

Later in the season the hybrid beats the existing model by 6.5% but trails 30-game recency by 1.5%, because the live window holds at most 10 games.

## Conclusion
- The integrated live-feasible hybrid is better than the existing model in both periods: −4.3% MAE on holdout players and −6.5% on February–April. It never does worse than the existing model for players with no current-season games.
- Matching Phase 14's 30-game recency in production would require per-player game logs beyond the 10-game window, which means new provider requests. That was out of scope.
- Integrated behind `PROGM_PROJECTION_MODEL=recency_hybrid_v1`, **disabled by default**. Leaving it unset keeps the existing model (immediate rollback).
