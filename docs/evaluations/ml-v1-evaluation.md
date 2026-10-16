# ML v1 evaluation

Branch `feature/ml-v1` (from `feature/ml-eval-framework`). Experimental only: no production behavior, ranking, flag or deployment changed.

## Data (owner-authorized GitHub datasets: llimllib/nba_data @ 2b4de94)
- `data/playerstats.parquet`: stats.nba.com regular-season player-season totals, 2013-14 to 2025-26 (13 seasons, 6,908 player-seasons), with age, draft year/number, height, usage.
- `data/espn/player_box.parquet`: ESPN player-game box scores, 2018-19 to 2025-26. Complete except 2019-20 (971 of 1,059 regular-season games).
- Season statistics come from the season totals (complete for every season). From the game logs: double-doubles and triple-doubles (derived per game: 10+ in 2 or 3 of points, rebounds, assists, steals, blocks), share of the last 20 team games played, longest absence, starter share. Seasons without complete game logs keep the source's own DD/TD counts (flagged `dd_source`) and leave game-derived features missing. Check: derived DD differs from the source count by 0.001 per player-season on average, TD by 0.
- Cross-check of game-log aggregates against season totals: per-game stats agree to rounding (about 0.02), personal fouls = defensive + offensive fouls, turnovers = `tov1`.
- Nothing is imputed into the data; models handle missing features (LightGBM natively, ridge with median plus a missing indicator). Provenance (repo, commit, file SHA-256, owner authorization) is in the dataset manifest and every prediction record.

## Models (Python, fixed hyperparameters chosen before evaluation)
Separate models for: games (share of season played; absent = 0) with 10%/90% quantile models, minutes per game with quantiles, per-minute rates for points, OREB, DREB, assists, steals, blocks, turnovers, FGM, FTM, 3PM, PF, and per-game double/triple-double rates. Per-game statistics = rate x minutes. Two learners: LightGBM (`ml_lgbm`) and ridge (`ml_ridge`) on the same 50 point-in-time features (three seasons of availability, minutes, usage; last-season rates; three-season rates; age, experience, draft, height; game-log availability features).
Walk-forward: for target season t, trained only on target seasons 2014..t-1 with features from seasons before each training target. Nine evaluation folds: 2017-18 to 2025-26.

## Evaluation setup
The server's chronological framework scores every model with identical pools (players with 800+ minutes in the prior season, 2,743 player-seasons) and the owner's league scoring (FGM 2, FTM 2, 3PM 2, PTS 1, OREB 1.75, DREB 1.25, REB 1.2, AST 2, STL 3.25, BLK 3.75, TO -1, PF -0.75, DD 3, TD 5). Baselines: `production` (last-season line + durability games) and `age_minutes`. Ensembles (`ens_*`, equal weights) were added AFTER seeing the first ML results, so they are reported with development (2017-2022) and confirmation (2023-2025) folds separately; they are not pre-registered.

## Results, all nine folds (mean of folds)
| model | games MAE | games RMSE | games bias | minutes MAE | FP/G MAE | season FP MAE | Spearman | top-25 | top-50 | top-50 capture |
|---|---|---|---|---|---|---|---|---|---|---|
| production | 16.74 | 22.93 | +6.18 | 3.75 | 8.70 | 991 | 0.660 | 0.631 | 0.687 | 0.883 |
| age_minutes | 16.74 | 22.93 | +6.18 | 3.62 | 8.18 | 947 | 0.691 | 0.627 | 0.673 | 0.880 |
| ml_lgbm | 16.44 | 21.45 | +2.31 | 3.54 | 8.27 | 950 | 0.691 | 0.551 | 0.667 | 0.867 |
| ml_ridge | 16.76 | 21.37 | +1.61 | 3.57 | 8.26 | 961 | 0.695 | 0.569 | 0.667 | 0.867 |
| ens_all(age_minutes, ml_lgbm) * | 16.05 | 21.51 | +4.25 | 3.50 | 8.08 | 929 | 0.703 | 0.600 | 0.678 | 0.882 |
| ens_all(age_minutes, ml_ridge) * | 16.19 | 21.46 | +3.90 | 3.53 | 8.10 | 933 | 0.704 | 0.618 | 0.687 | 0.885 |
\* post-hoc. Per-fold values for every model and metric: `ml-v1-fold-results.md`.

Paired vs production (mean, 95% t interval, folds better of 9):
- ml_lgbm: games RMSE -1.49 [-2.08, -0.90] 9/9; games MAE -0.30 [-0.79, +0.19] 5/9; minutes MAE -0.22 [-0.32, -0.12] 9/9; FP/G MAE -0.44 [-0.71, -0.17] 8/9; season FP MAE -41 [-70, -12] 8/9; Spearman +0.031 [+0.017, +0.045] 8/9; **top-25 overlap -0.080 [-0.131, -0.029] 0/9**; top-50 overlap -0.020 [-0.045, +0.005] 2/9; top-50 capture -0.016 [-0.029, -0.003] 2/9.
- ens_all(age_minutes, ml_lgbm): games MAE -0.69 [-1.00, -0.37] 9/9; FP/G MAE -0.62 [-0.77, -0.47] 9/9; season FP MAE -62 [-86, -39] 9/9; Spearman +0.043 [+0.031, +0.054] 9/9; top-25 -0.031 [-0.077, +0.014]; top-50 -0.009 [-0.026, +0.008].
- ens_all(age_minutes, ml_ridge): Spearman +0.044 [+0.030, +0.059] 9/9; season FP MAE -58 9/9; top-25 -0.013 [-0.057, +0.030]; top-50 +0.000 [-0.022, +0.022].
Against age_minutes (the better existing projection), stand-alone ML is not better on FP/G (8.27 vs 8.18) and is better only on minutes and games RMSE/bias.

Confirmation folds (2023-2025): the ensembles keep their lead on MAE and Spearman (ens_all lgbm: FP/G MAE 8.04 vs production 8.79; Spearman 0.705 vs 0.673), and stay at or below production on top-N (top-25 0.587 vs 0.587; top-50 0.640 vs 0.653).

## What improved and what worsened
- Improved: every per-game statistic except 3PM (per-game MAE vs last season: points -4%, OREB -6%, DREB -5%, assists -3%, steals -8%, blocks -7%, turnovers -6%, FGM -4%, FTM -3%, PF -6%, DD -3%, minutes -6%); games RMSE and bias; season-total MAE; overall rank correlation.
- Worsened: triple-double rate (+26% relative, 0.006 -> 0.007 per game); top-25 overlap and top-50 capture for stand-alone ML.
- Why ML hurts the top of the board: its games gains come from low-production players (bottom quartile games bias +11.6 -> +3.0, MAE 22.1 -> 19.9). For the top two quartiles it is worse (MAE 14.6 -> 15.2 and 13.4 -> 14.5): among production's top 60 it spreads games predictions far more (SD 8.3 vs 5.0 games) while tracking actual games less well (correlation 0.17 vs 0.23). The draft cares about exactly those players.
- Intervals: the framework's residual intervals cover close to nominal for all models (0.80-0.81). LightGBM's native 80% quantile intervals under-cover (games 0.68, minutes 0.69) and need calibration before use.

## Does ML improve draft-ranking accuracy?
No. It improves the numbers (games, minutes, per-game stats, season totals) and overall rank correlation, but not top-25/50 accuracy; stand-alone LightGBM is significantly worse on top-25 overlap (0 of 9 folds better). The best blends match production on top-N within the confidence interval while improving everything else, but they were chosen after seeing the results.

## Leakage controls
Python: `build_features` refuses history containing the target season; each fold sees only `df[season < t]`; tests replace target-and-later seasons with garbage (plus ghost players) and require identical predictions (synthetic test, and a one-off check on the real data for fold 2023: identical). Server: precomputed predictions must declare `trainedThroughSeason` and `dataCutoffSeason` before the target and an `asOf` no later than the forecast time, or the fold is refused; the server-side canary passes for all models.

## Recommendation
Not ready for account-scoped shadow testing as a ranking change: it does not improve top-25/50 accuracy. Next steps, in order:
1. Pre-register `ens_all(age_minutes, ml_ridge)` (best top-N and MAE among blends) and a value-weighted games model aimed at rotation players, then evaluate them on the 2026-27 season prospectively (a genuinely untouched fold).
2. Calibrate the quantile intervals (conformal adjustment on earlier folds) before showing ranges.
3. Only if a pre-registered model is at least equal on top-N with intervals excluding a loss would shadow testing make sense.

## Integration plan (when a model qualifies; not implemented)
- Python trains offline (local or a scheduled job) and writes a projections file per season: player id, model version, `asOf`, data cutoff, statistics, intervals, provenance hash.
- The Node server loads that file read-only into a projections map; league scoring stays the existing deterministic `scoring.js` code; missing, stale (older than an agreed age) or malformed entries fall back per player to the existing projection engine.
- Account-scoped like the existing flags (allowlist of user ids, separate cache profile); off for everyone else.
- The draft board keeps consuming projections through the same provider interface; no ranking-formula change. Yahoo-anchored ranking waits for the Yahoo comparison.

## Limitations
One data source family; seasons before 2018-19 have no game logs; 2019-20 game logs incomplete and 2019-20/2020-21 were shortened (all models forecast 82-game seasons); preseason team changes, injuries and rookies are not modeled; the universe excludes players under 800 prior minutes; nine folds; the ensembles are post-hoc; LightGBM hyperparameters were not tuned (by design).
