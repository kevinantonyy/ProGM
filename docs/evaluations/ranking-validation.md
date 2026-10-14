# Ranking model validation: variants A / B / C (2026-10-14)

**Status: no real-data results yet.** The historical game logs used in earlier phases were deleted after each run (by design, with the scratch databases), and no league scoring configuration other than the assumed Yahoo default is stored locally. Downloading them again needs your approval, so no real metrics are reported here. Everything below is from SYNTHETIC pools and shows harness mechanics and model behaviour only. It is not evidence about real players.

## Variants (`rankingValidation.js`, offline; production formulas unchanged)
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
