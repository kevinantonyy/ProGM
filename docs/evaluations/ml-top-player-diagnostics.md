# Top-player accuracy: diagnostics and exploratory variants

Branch `feature/ml-diagnostics` (from `feature/ml-v1`). Offline only. **Everything below uses folds already used to build ML v1, so it is exploratory: it explains behaviour and decides what to pre-register, it does not show that any model is better.** Detail tables: `ml-top-player-diagnostics-detail.md`.

## 1. Why ML games is worse for top players although overall RMSE improves
Top tier = top 60 by production's predicted season total in each fold (prediction-time definition), 540 player-seasons.

| | games MAE prod / ML | bias prod / ML | SD of predictions prod / ML | corr with actual prod / ML |
|---|---|---|---|---|
| top tier | 12.60 / 13.77 | +4.8 / +2.8 | 5.0 / 8.3 | 0.23 / 0.17 |
| everyone else | 17.76 / 17.11 | +6.5 / +2.1 | 7.1 / 11.3 | 0.17 / 0.35 |

Mechanism: ML learns how strongly games follow past availability from the whole pool, where the relationship is steep, and applies it to stars, where it is flat. Games per unit of last-season availability share: actual 41 for the rest of the pool but only 27.6 for the top tier; production reacts with 25.7 (about right), ML with 39.8 (too much). Same for the worst prior season (actual 9.7, ML 14.4). So ML's games predictions for stars spread widely on signals that, for stars, carry little information. Its overall gains come from exits and role players (bias +11.6 -> +3.0 in the bottom quartile). Within the top tier the descriptively best mix of the two games predictions is 0% ML.

## 2. Largest top-25/top-50 mistakes (prediction-time information only)
- Production placed 45 players in its top 25 who finished outside the top 50; **games explain 88% of their shortfall** (27 of them played under 40 games). Misses the other way (finished top 25, ranked outside top 50): 32, where games explain only 39%: those are mostly per-game breakouts of young players (e.g. Bam Adebayo 2019-20, LaMelo Ball 2021-22, Tyrese Maxey 2023-24, Brandon Ingram 2019-20).
- The same pattern holds for every model (age + minutes 46/33, ML LightGBM 49/43, ML ridge 57/46).
- At prediction time, production's top-25 busts look almost like its hits: age 29.3 vs 28.6, last-season share of games 0.85 vs 0.86, worst prior season 0.60 vs 0.66, last-20-games share 0.75 vs 0.76. The biggest busts were long absences (0-15 games). Several followed injuries or absences that were public before the season (e.g. Kevin Durant 2019-20, Kawhi Leonard 2021-22, Miles Bridges 2022-23, Damian Lillard 2025-26), information this dataset does not contain. In real use, production's verified season-ending-injury cap would have caught some of these, so the backtest overstates production's top-25 busts somewhat.
- Conclusion: the top-of-board errors are dominated by (a) absences that history-based features cannot see and (b) young players' per-game jumps. More ML on availability history cannot fix (a); preseason injury/status information can, and needs to be logged prospectively because it is not in the historical data.

## 3. Exploratory variants (games only; per-game production held at age + minutes)
| games model | games MAE | season FP MAE | Spearman | top-25 | top-50 | top-25 capture |
|---|---|---|---|---|---|---|
| production (reference: production per-game) | 16.74 | 991 | 0.660 | 0.631 | 0.687 | 0.866 |
| age + minutes with production games | 16.74 | 947 | 0.691 | 0.627 | 0.673 | 0.867 |
| + ML games | 16.44 | 943 | 0.696 | 0.564 | 0.669 | 0.846 |
| + ML games with team-role features (minutes/usage rank and minutes share within team) | 16.42 | 943 | 0.697 | 0.582 | 0.667 | 0.855 |
| + ML games weighted toward rotation players (previous-season minutes) | 16.51 | 944 | 0.698 | 0.560 | 0.662 | 0.848 |
| + ML games shrunk toward production, weight chosen walk-forward from earlier folds only, separately for the top 75 and the rest | 15.97 | 925 | 0.703 | 0.622 | 0.680 | 0.868 |

- Role features and value weighting do not fix the top tier.
- Walk-forward tier shrinkage: using only past outcomes, the ML weight for the top tier fell from 0.5 (first two folds, little history) to 0.3, 0.2 and finally 0.0 by 2025-26; for the rest it settled at 0.6. Versus production: games MAE -0.77 [-1.11, -0.43] 9/9, season FP MAE -66 [-91, -41] 9/9, Spearman +0.043 [+0.029, +0.058] 9/9, top-25 overlap -0.009 [-0.039, +0.021], top-50 overlap -0.007 [-0.027, +0.014], top-25 capture +0.002 [-0.016, +0.020]. In short: better numbers, top-of-board accuracy unchanged. The variant was designed on these folds (tier size, grid), so this is not evidence of superiority.

## 4. Feature leakage and baseline fidelity
- No target-season information in features: every feature is computed from rows of earlier seasons only (`build_features` refuses otherwise); per-season columns checked: age increases by exactly the season gap in 99.9% of consecutive rows (5 rounding/birthday exceptions); draft year and number never change; height is recorded per season; `season_games` uses the previous season. Garbage-future canaries pass in Python (synthetic test and the real data, fold 2023) and in the server framework.
- The evaluation's "production" is close to, but not exactly, what ProGM ships:
  - Same: last completed season's stat line scored with the league weights; `durability.js` expected games; no recent-form blend before games are played.
  - Different: (a) history starts in 2013-14 instead of each player's debut; (b) experience from draft year instead of ESPN debut year; (c) the availability baseline pool: production builds it from players currently in the Yahoo pool. A closer replica (players active last season) is slightly *worse*: games bias +8.4 vs +6.2, top-25 0.622 vs 0.631. So the backtest is, if anything, a little generous to production; (d) no verified season-ending-injury caps (no historical injury feed); (e) universe is 800+ prior minutes, not the Yahoo pool; (f) still unverified: whether production's recent-form window counts preseason games once they are played (it would then blend preseason box scores at draft time; see `ranking-root-causes.md`).

## 5. Proposed changes (not implemented)
1. Do not use ML games for top players; if ML games is used at all, shrink it toward production by tier (the frozen candidate below).
2. Build a structured preseason availability signal (official injury and suspension status logged with timestamps), since unseen absences are the dominant top-25 error; it must be logged prospectively to be testable.
3. Focus per-game work on young players' development (the dominant cause of top-25 misses); the age + minutes adjustment already moves in that direction.
4. Keep the Yahoo-anchored ranking work separate: none of this changes ranking formulas.

## 6. Frozen 2026-27 prospective evaluation
See `ml-prospective-2026-27-plan.md`.
