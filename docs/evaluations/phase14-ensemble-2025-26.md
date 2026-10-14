# Phase 14: existing ProGM model vs recency vs ensemble (2026-10-14)

**Status:** historical, game level, not production-approved. Data basis is the same as Phase 13: maintainer permissions plus the owner's risk acceptance, **not** verified NBA permission. Raw data was held only in a temporary local Postgres (deleted). It was rebuilt with `docs/data-provenance/llimllib-to-gamelog-csv.sql`: 2,460 games and 64,695 player-game rows (2024-25 and 2025-26 regular seasons), identical to Phase 13.

## Existing ProGM model as reproduced
From `services/fantasy/insights.js` and `projection.js`:
- Prediction = 0.65 × the player's **last completed season** per-game line + 0.35 × **recent form**.
- Recent form is the player's games among the union of every team's last 10 completed current-season games (`getRecentForm`). Offline, the window uses only games dated before the target game.
- No recent games gives last season only; no last-season line gives no projection.
- Blending is done on fantasy points. That equals production's blend-the-stat-line-then-score, because the assumed scoring is linear.

Inputs missing or approximated offline:
- Production's last-season line comes from ESPN season averages; offline it is the mean of the stats.nba.com game logs (same games, possibly different rounding).
- Production refreshes recent form on a 6-hour cache; offline it is the exact state before each game.
- Rebound-split filling and the availability/expected-games adjustments do not affect points per game and are not modelled.
- DD/TD bonuses are absent from the assumed scoring.

## Method
- Scoring: **assumed Yahoo default points scoring** (PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1). This is not any ProGM user's league.
- Split, same as Phase 13 and fixed in advance:
  - 2024-25 is history only;
  - validation is 2025-26 games before 2026-02-01;
  - test is 2025-26 games from 2026-02-01 to 2026-04-12.
- Each game is predicted only from the player's earlier-dated games, and the league-wide recent window uses only earlier games.
- Tuning, on validation only:
  - stage 1 picks recency settings from 25 combinations (half-life 2/3/5/10/20 × prior weight 0/1/2/4/8);
  - stage 2 picks the ensemble weight on the existing model from 0% to 100% in steps of 10%.
- Test: all four models scored once on the same 9,092 games, i.e. games where every model has a prediction (players need a 2024-25 line).

## Selection (validation, 13,831 games)
- Recency: **half-life 5, prior weight 0** (no shrinkage toward last season), MAE 7.800. Next best: h3 k1 7.801, h5 k1 7.806.
- Ensemble validation MAE by existing-model weight:

| Weight | 0% | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MAE | 7.800 | 7.788 | **7.786** | 7.796 | 7.816 | 7.848 | 7.891 | 7.943 | 8.007 | 8.080 | 8.163 |

Selected weight: **20% existing + 80% recency**.

## Test results (2026-02-01 to 2026-04-12, 9,092 identical games)

| Model | MAE | RMSE | Bias | MAE vs existing |
|---|---|---|---|---|
| Previous-season baseline | 9.684 | 12.284 | −1.088 | −11.88% (worse) |
| **Existing ProGM model** | 8.656 | 11.035 | −0.842 | reference |
| Recency (h5, k0) | 7.968 | 10.243 | −0.320 | **+7.94%** |
| Ensemble (20% existing) | 7.966 | 10.232 | −0.424 | **+7.97%** |

Coverage over 10,821 test games: recency predicts 10,780, because it does not need a last-season line. The others predict 9,092.

### By month (MAE / bias)

| Month | Games | Baseline | Existing | Recency | Ensemble |
|---|---|---|---|---|---|
| 2026-02 | 3,076 | 9.552 / −0.99 | 8.629 / −0.75 | 8.058 / −0.23 | 8.051 / −0.33 |
| 2026-03 | 4,383 | 9.422 / −0.81 | 8.378 / −0.56 | 7.657 / −0.03 | 7.653 / −0.13 |
| 2026-04 | 1,633 | 10.634 / −2.02 | 9.453 / −1.78 | 8.634 / −1.28 | 8.644 / −1.38 |

### By tier (player's 2024-25 FPPG; MAE / bias)

| Tier | Games | Baseline | Existing | Recency | Ensemble |
|---|---|---|---|---|---|
| under 15 | 2,926 | 10.058 / −6.37 | 8.478 / −4.50 | 7.400 / −1.25 | 7.408 / −1.90 |
| 15–25 | 3,287 | 9.268 / +0.72 | 8.317 / +0.41 | 7.689 / −0.02 | 7.690 / +0.07 |
| 25–35 | 1,605 | 9.572 / +1.87 | 9.084 / +1.23 | 8.763 / +0.21 | 8.734 / +0.42 |
| 35+ | 1,274 | 10.040 / +2.67 | 9.399 / +1.73 | 8.991 / +0.37 | 8.989 / +0.64 |

## Conclusion
- Both recency-based models clearly beat the existing ProGM model: about 8% lower MAE and 7% lower RMSE, with lower error in every month and every tier and smaller bias.
- **The ensemble does not genuinely improve on recency alone.** Its test MAE is 0.003 lower (0.03%) and its RMSE 0.011 lower, which is negligible over 9,092 games. Its bias is larger, and it covers fewer games because it needs last season.
- The existing model's main weakness shows in the low tier. Players under 15 FPPG last season are under-predicted by about 4.5 points per game, because last season's line dominates the blend and misses role changes.
- Recommended for feature-flagged integration: **standalone recency, half-life 5 games over the last 30, no prior shrinkage**. It is simpler, ties the ensemble, has the smallest bias, and keeps covering players with no previous season.

## Limits
- One season of history and one partial test season under one assumed scoring system.
- Opening weeks of a season are not in the test period. A pure-recency model has only a handful of games there, so a fallback (for example, the existing model until a player has about 5 games) should be checked in that period before launch.
- Prior weight 0 is at the edge of the grid.
- No significance test was run.
