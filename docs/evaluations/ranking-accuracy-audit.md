# Draft board ranking accuracy and rookie coverage

Branch `feature/ranking-accuracy-rookies` (from `main` 2814601). Nothing here is deployed or merged.

## Evidence limits (read first)
- No live league, Yahoo or ESPN data was reachable from the sandbox, so the user-reported board
  (Cade ~#19, missing rookies) could not be reproduced directly.
- Offline numbers below use derived 2025-26 per-game lines (llimllib/nba_data, used earlier under
  the recorded permission), **assumed default Yahoo scoring and lineup**, coarse G/F/C labels, and a
  single season of availability history. Expected games therefore sit near 59-61 for everyone, which
  differs from production's multi-season history. Treat ranks as illustrative, not as the live board.
- Rookie estimates cannot be validated offline: there is no preseason ADP for them in this data.

## Findings
1. **Cade ~#19 vs ~#6.** Offline, with assumed scoring, Cade ranks **#9 (A)** / **#7 (B)**, not #19. The
   gap to the live board must come from inputs not available here. Candidates, in likely order:
   (a) expected games from his real multi-season availability history (the model shrinks missed games),
   (b) the league's actual turnover/other weights (his 3.7 TO/game cost ~3.7 pts at -1),
   (c) Yahoo positional eligibility and pool contents. Structural cause that is certain: ProGM projects
   2026-27 from **2025-26 per-game stats only** (plus in-season recent form once games exist). It has no
   age/trajectory or role-change term, which expert rankings do include, so any player expected to
   improve (or whose role changed) will sit lower than experts put them. Every board row already carries
   its `components` (production, replacement, scarcity, expected games, confidence); capturing Cade's
   row from the live payload would pin (a)-(c) down in minutes.
2. **Bam / Sengun inflation: yes, from two positional terms.** C-eligible players get scarcity = 1.0
   (min-max saturates: the C supply gap is large relative to other positions) = +4.8 pts, and a lower
   replacement baseline (C 1753 vs guards ~2429 season pts) = roughly +4 to +5 pts for Sengun/Bam vs
   about +2.6 for Cade. Together ~9 of their ~57-61 points. Under the harness's Variant B Sengun
   5 -> 8, Bam 10 -> 14, Cade 9 -> 7.
3. **Variant B is not clearly "right".** On the 2024-25 -> 2025-26 backtest B cuts center bias
   (-40 -> -4 ranks) but moves guard bias from -5 to -18, and its Spearman gain (+0.015) is not
   significant. Replacing the min-over-eligible-positions replacement baseline with max, mean or a flat
   UTIL baseline changes nothing measurable (Spearman 0.608, same bias): the replacement term is
   accuracy-neutral and the scarcity bonus is the only positional term with a visible effect. A pure
   production ranking scores the same as B. **No formula change is made in this branch.**
4. **Why rookies are missing.** The player index and season stats come from the *projection season*
   (last completed season, 2025-26). A 2026 rookie has no 2025-26 row, so identity matching fails
   (unmatched, no stat line), the projection is `null`, and the board lists the player under "no data".
5. **Inputs check.** League scoring: yes, Yahoo `statCategories` drive `scoreStatLine`; category leagues
   are intentionally unsupported (`scoringIsSupported` requires points). Season: last completed season
   plus recent form. Identity: Yahoo id (when the provider has it), else name+team, else unique name;
   ambiguous names are left unmatched rather than guessed.

## Change in this branch
`marketPrior.js` (+ wiring in `insights.js`, provenance fields in `draftHelper.js`/`rankings.js`):
- For players with **no projection** and a Yahoo ADP, estimate per-game league points as
  `a + b*ln(ADP)`, fitted by OLS on the same pool's players that have real stats (>= 20 GP, >= 40 points,
  slope < 0, R^2 >= 0.25). The target is already league-scored, so scoring is preserved.
- Guard rails: only inside the calibrated ADP range, never negative, capped at the best calibration
  projection, fixed confidence 0.3, flagged `estimate: true` / `projectionMethod: market_prior_estimate`.
  Real projections, scoring-gap players and players without ADP are never touched.
- Because the estimate is built from ADP, VALUE/REACH/DRAFT NOW/WAIT and the Yahoo-rank agreement are
  forced neutral for these rows (otherwise they would be circular). Baseline ProGM Rank is still the
  single `overallRank`; roster-aware Draft Now/Wait logic is unchanged.
- Estimates enter the same baseline reference and rank order as every other player; no manual overrides.

Tradeoffs: this is a market-implied prior, not a role/minutes model (no minutes, draft slot or depth
chart is available to ProGM today). It cannot tell a rookie from a veteran who missed last season; both
are labelled as estimates. It is only as good as Yahoo's preseason ADP and the veteran calibration.

## Before / after (veterans)
The veteran ranking output is **byte-identical** to `main` on the offline pool (checked by diffing the
full ranked list). Only the new rookie/no-stats path and additive row fields differ.
Column note: points columns are scaled by the confidence factor; value also includes a 2.4-pt neutral
roster-fit constant. "B rank" is the harness's analytic Variant B (no scarcity).

### Top 30 (current model; identical before and after this branch)
| A rank | Player | Pos (coarse) | Proj FPts/game | Proj season pts | Production pts | Replacement pts | Scarcity pts | Value (A) | B rank |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Nikola Jokić | C | 62.1 | 3654 | 67.9 | 10.5 | 4.8 | 85.7 | 1 |
| 2 | Victor Wembanyama | C | 53.4 | 3128 | 58.1 | 7.6 | 4.8 | 73.0 | 3 |
| 3 | Luka Dončić | PG/SG/G | 57.7 | 3381 | 62.8 | 5.5 | 0.2 | 71.0 | 2 |
| 4 | Shai Gilgeous-Alexander | PG/SG/G | 50.4 | 2988 | 55.5 | 3.4 | 0.2 | 61.6 | 4 |
| 5 | Alperen Sengun | SF/PF/F/C | 43.9 | 2639 | 49.0 | 4.9 | 4.8 | 61.2 | 8 |
| 6 | Scottie Barnes | C/SF/PF/F | 42.0 | 2591 | 48.1 | 4.6 | 4.8 | 60.0 | 9 |
| 7 | Tyrese Maxey | PG/SG/G | 48.6 | 2901 | 53.9 | 2.9 | 0.2 | 59.5 | 5 |
| 8 | Jalen Johnson | SF/PF/F | 48.3 | 2900 | 53.9 | 2.9 | 0.2 | 59.4 | 6 |
| 9 | Cade Cunningham | PG/SG/G | 48.6 | 2847 | 52.9 | 2.6 | 0.2 | 58.2 | 7 |
| 10 | Bam Adebayo | SF/PF/F/C | 40.8 | 2461 | 45.7 | 3.9 | 4.8 | 56.9 | 14 |
| 11 | Karl-Anthony Towns | C/SF/PF/F | 40.5 | 2458 | 45.7 | 3.9 | 4.8 | 56.9 | 15 |
| 12 | Joel Embiid | C | 44.5 | 2374 | 44.2 | 3.4 | 4.9 | 54.9 | 21 |
| 13 | Jaylen Brown | PG/SG/G/SF/PF/F | 45.2 | 2708 | 50.3 | 1.8 | 0.2 | 54.8 | 10 |
| 14 | Kawhi Leonard | SF/PF/F | 45.7 | 2687 | 49.9 | 1.7 | 0.2 | 54.3 | 11 |
| 15 | Evan Mobley | C/SF/PF/F | 39.9 | 2348 | 43.6 | 3.3 | 4.8 | 54.2 | 22 |
| 16 | Pascal Siakam | C/SF/PF/F | 39.9 | 2325 | 43.2 | 3.2 | 4.8 | 53.6 | 23 |
| 17 | Donovan Mitchell | SF/PF/F/PG/SG/G | 44.3 | 2646 | 49.2 | 1.5 | 0.2 | 53.3 | 12 |
| 18 | Jalen Duren | C | 38.2 | 2281 | 42.4 | 2.9 | 4.8 | 52.6 | 27 |
| 19 | Jamal Murray | PG/SG/G | 42.9 | 2604 | 48.4 | 1.2 | 0.2 | 52.3 | 13 |
| 20 | Giannis Antetokounmpo | SF/PF/F | 49.1 | 2603 | 48.3 | 1.2 | 0.2 | 52.3 | 16 |
| 21 | Kevin Durant | PG/SG/G/SF/PF/F | 41.6 | 2553 | 47.4 | 1.0 | 0.2 | 51.0 | 17 |
| 22 | Anthony Edwards | SF/PF/F/PG/SG/G | 43.9 | 2549 | 47.3 | 0.9 | 0.2 | 51.0 | 18 |
| 23 | Anthony Davis | SF/PF/F/C | 44.0 | 2196 | 40.8 | 2.4 | 4.8 | 50.5 | 33 |
| 24 | James Harden | PG/SG/G | 42.4 | 2530 | 47.0 | 0.8 | 0.2 | 50.5 | 19 |
| 25 | Deni Avdija | PG/SG/G/SF/PF/F | 42.9 | 2526 | 46.9 | 0.8 | 0.2 | 50.4 | 20 |
| 26 | Chet Holmgren | C/SF/PF/F | 36.3 | 2162 | 40.2 | 2.3 | 4.8 | 49.7 | 35 |
| 27 | Donovan Clingan | C | 34.7 | 2122 | 39.4 | 2.0 | 4.8 | 48.7 | 37 |
| 28 | Jalen Brunson | PG/SG/G | 40.5 | 2451 | 45.6 | 0.4 | 0.2 | 48.6 | 24 |
| 29 | Paolo Banchero | SF/PF/F | 40.8 | 2449 | 45.5 | 0.4 | 0.2 | 48.6 | 25 |
| 30 | Amen Thompson | SF/PF/F/PG/SG/G | 39.5 | 2429 | 45.2 | 0.3 | 0.2 | 48.1 | 26 |

### Cade / Bam / Sengun
| A rank | Player | Pos (coarse) | Proj FPts/game | Proj season pts | Production pts | Replacement pts | Scarcity pts | Value (A) | B rank |
|---|---|---|---|---|---|---|---|---|---|
| 5 | Alperen Sengun | SF/PF/F/C | 43.9 | 2639 | 49.0 | 4.9 | 4.8 | 61.2 | 8 |
| 9 | Cade Cunningham | PG/SG/G | 48.6 | 2847 | 52.9 | 2.6 | 0.2 | 58.2 | 7 |
| 10 | Bam Adebayo | SF/PF/F/C | 40.8 | 2461 | 45.7 | 3.9 | 4.8 | 56.9 | 14 |

## Proposed next steps (for review)
1. Capture the live payload row for Cade (and one rookie) to settle finding 1 with real inputs.
2. Run the read-only A/B comparison on the real cached workspace before deciding on Variant B.
3. If trajectory matters: add an age/experience adjustment fitted on historical season-to-season
   changes (needs the historical data; not done here).
4. If rookies matter more: ingest draft slot / preseason role data (free sources) to replace the ADP prior.
