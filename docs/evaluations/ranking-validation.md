# Ranking model validation: variants A / B / C (2026-10-14)

**Status:** synthetic mechanics (section 1) plus a real-data backtest (section 2) run after the owner approved re-downloading the two llimllib files. Maintainer permissions plus owner risk acceptance apply, not verified NBA permission. Raw data stays in scratch and is not committed.

## 1. Synthetic mechanics

### Variants (`rankingValidation.js`, offline; production formulas unchanged)
- **A** current: 0.70 production + 0.20 replacement + 0.05 scarcity, where scarcity is rescaled so the scarcest position always gets the full bonus.
- **B** production + replacement, no scarcity term.
- **C** production + replacement + 0.05 × an absolute supply/demand scarcity: the position's pressure relative to the average pressure (0 at or below average, 1 at twice average).
- All use the same confidence factor and neutral roster fit.

## Do replacement and scarcity double-count positional supply?
Yes, by construction. The replacement level of a position is the starters-th best eligible player in the pool, and scarcity is starters ÷ eligible supply. Both are functions of the same eligible-player count at the position.

## Synthetic results
Every position has the *same* talent curve (45 down to 15 points per game), so ideal positional bias is about zero. "Center bias" is the mean of (predicted rank − realized-total rank) for centers; negative means centers are overvalued.

| Center supply (others 60) | A: spearman vs realized total / center bias | B | C |
|---|---|---|---|
| 60 (equal) | 0.9995 / −4.0 | 0.9995 / −4.0 | 0.9995 / −4.0 |
| 40 | 0.9922 / **−23.8** | 0.9996 / −2.1 | 0.9985 / −9.6 |
| 25 | 0.9924 / **−27.4** | 0.9985 / −7.4 | 0.9935 / −25.0 |

- Top-24 overlap with the realized top 24 at C=40: A 0.875, B 1.000, C 0.958.
- Against realized value above replacement the ordering reverses: A 0.9997, B 0.9936, C 0.9972 at C=40. The synthetic realized replacement level also depends on the same positional supply, so VORP rewards A's tilt. Which target is right is a modelling choice: for a points league, total points is what you actually score, and positional supply matters only through lineup slots.
- Pool sensitivity (drop 20% of players at random, 5 seeded trials, C=40): mean absolute rank change among kept players A 2.04, B 0.71, C 0.83. A is the most sensitive to which players are in the fetched pool.

## Limitations of what can be concluded
- Synthetic equal-talent pools isolate the model's positional tilt but say nothing about how large it is for real players or real pool sizes.
- Real validation needs: prior-season projections (from the 2024-25 logs), realized 2025-26 season totals, positions (the NBA position field is not Yahoo eligibility) and the league's scoring. With only two seasons, there is a single chronological holdout (train/project on 2024-25, evaluate on 2025-26).

## Recommendation (pending real-data confirmation)
Variant **B**, or **C** if a positional scarcity signal is still wanted: drop or replace the min-max scarcity, because replacement already carries positional supply. Do not change production until the real-data run agrees.


## 2. Real-data backtest (2024-25 preseason information -> 2025-26 outcomes)

**Scoring is ASSUMED Yahoo default points (PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1). No actual league scoring was available locally.**
Lineup assumed (not any user's league): PG SG G SF PF F C C UTIL UTIL + 3 bench, 12 teams.

Inputs and leakage controls:
- Rankings use only 2024-25 data: per-game line (existing projection model: last season only, as in a preseason draft), expected games from the existing availability model with one season of history (2024-25 games played) and the pool's own 2024-25 cohort rate, confidence from the same projection, replacement levels and scarcity from the preseason pool.
- Position labels (G/F/C) are the starter labels in the 2024-25 logs; they are coarse and not Yahoo eligibility (G -> PG/SG/G, F -> SF/PF/F, C -> C, all -> UTIL). Players with no starter label that season (bench-only) and fewer than 15 games are excluded: 414 players. This is not a full draft pool.
- Outcomes (2025-26 regular-season fantasy totals, 0 for players with no games) are used only for scoring. A test confirms scrambling them leaves every ranking unchanged.
- Availability history is one season (the multi-season history production uses was not available), so expected games are shrunk toward the pool rate.
- Realized value above replacement: total minus the total of the (slots per team x 12)-th best realized player at the player's most common starter label.

### Results (n = 414)
| Ordering | Spearman vs realized total | vs realized VORP | Top-24 overlap | Top-50 overlap |
|---|---|---|---|---|
| A current | 0.594 | 0.603 | 0.458 | 0.52 |
| B no scarcity | 0.608 | 0.603 | 0.458 | 0.58 |
| C absolute scarcity | 0.593 | 0.603 | 0.458 | 0.50 |
| D pure projected PPG | 0.590 | 0.585 | 0.542 | 0.56 |
| E projected season points (PPG x expected games) | 0.608 | 0.603 | 0.500 | 0.58 |

Bootstrap (1,000 resamples) of the Spearman difference vs A: B +0.015 (95% CI -0.001 to +0.030), C -0.001 (-0.003 to +0.000), E +0.015 (-0.002 to +0.031), D -0.003 (-0.027 to +0.014). **None of the accuracy differences is statistically distinguishable from zero.** Top-N differences are within the noise of 24-50 players.

Positional bias (mean of predicted rank minus realized-total rank; negative = overvalued), by most common starter label:
| | Centers | Forwards | Guards |
|---|---|---|---|
| A current | **-40.3** | +24.5 | -5.0 |
| B no scarcity | -3.8 | +17.0 | -17.7 |
| C absolute scarcity | **-42.1** | +24.8 | -4.4 |
| D pure PPG | -4.8 | +16.2 | -16.2 |
| E season points | -3.0 | +16.9 | -18.1 |

A and C overvalue centers by about 40 ranks; B, D and E do not. B's remaining forward and guard bias matches the pure production orderings, so it comes from the projection inputs, not from the positional terms.

Stability (drop 20% of the pool, 5 seeded trials): mean absolute rank change among the rest A 0.87, B 0.48, C 0.90. All Spearman >= 0.9998.

### Cade Cunningham, Bam Adebayo, Alperen Sengun
Backtest (2024-25 information, assumed scoring), rank among 414 / realized 2025-26 rank:
| Player | PPG rank | A | B | C | realized total (rank) |
|---|---|---|---|---|---|
| Cade Cunningham | 8 | 11 | 9 | 11 | 3,110 (13) |
| Bam Adebayo | 34 | 14 | 17 | 14 | 2,979 (18) |
| Alperen Sengun | 23 | 9 | 14 | 9 | 3,162 (11) |

Forward look for the 2026-27 draft (2025-26 information, assumed scoring, same method; no outcomes exist): PPG rank / A / B / C: Cade 7 / 9 / 7 / 9, Bam 25 / 10 / 14 / 10, Sengun 16 / 5 / 8 / 5.
Under A, Bam moves 15 places and Sengun 11 places up from their points-per-game rank; B removes most of that lift. This reproduces the direction of the gap you see (centers above Cade) but not its size: your board uses your league's real scoring and longer availability history, which are not available here.

### Limitations
One season pair (single holdout), assumed scoring and lineup, coarse position labels, starters-only pool, one season of availability history. Valid scoring differences cannot be separated from calculation effects for your league without your settings.

### GO / NO-GO for changing the ranking formula
- **Conditional GO (small change): remove the separate min-max scarcity bonus (variant B).** It removes a ~36-rank center overvaluation, has the lowest rank churn, and costs no accuracy (point estimate better, difference not significant). Ship behind a flag and compare in shadow first.
- **NO-GO on anything larger** (redefining replacement level, new scarcity formulas) until multi-season validation with real eligibility and league scoring.
- Variant C (as defined) does not fix the bias: a center gap this size exceeds twice the average pressure, so the bonus saturates.
