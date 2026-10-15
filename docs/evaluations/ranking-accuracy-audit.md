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
   production ranking scores the same as B. (The first commit on this branch made no formula change; the model v2 section below does.)
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

## Before / after, first commit (veterans)
The veteran ranking output was byte-identical to `main` at that commit. The tables below are the
first-commit (v1) values; the v2 section further down has the final before/after.
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


---

# Model v2 (this milestone)

## Change
- **Scarcity bonus removed** (`DRAFT_WEIGHTS`: production 0.75, replacement 0.20, scarcity 0, roster fit 0.05).
  The min-max scarcity term and the replacement baseline both derive from the same eligible-supply
  count, so positional supply was counted twice, and the min-max form saturates at the maximum for every
  center regardless of how large the supply gap is. Replacement stays: it is league-specific (slot counts,
  team count, pool depth). The freed 0.05 went to the position-neutral production term, which keeps the
  score scale comparable; on the 2024-25 -> 2025-26 backtest that move changes nothing material
  (Spearman 0.6081 -> 0.6082, same positional bias; Variant B 0.6081 for reference).
- **Cache refresh:** `RANKING_MODEL_VERSION = 'v2-no-scarcity'` is now part of the baseline-reference key
  (`bball:overall-ref:<version>:...`) and the workspace key (`bball:workspace:<version>:...`), so no frozen
  or cached v1 ranking can be served; a restart already clears the in-memory caches.
- **Explicit no-rank reasons:** a draftable player that cannot be ranked is listed under `noData` with a
  `noDataReason` (no stats and no ADP, ADP outside the estimable range, unsupported league scoring).
- The offline harness now reconstructs the legacy v1 formula as its "A" so historical comparisons stay valid.

## Not done, and why
- **Trajectory (age/role).** No reliable, validated data is available in the repo or reachable from the
  sandbox to fit an age curve (the provider gives current age and debut year but no historical per-game
  series, and I did not re-download datasets without approval). Inventing a curve would be an arbitrary
  override. Per-game stats already reflect last season's role; the recent-form blend picks up
  in-season role changes once games exist.
- **Live inputs.** Live Yahoo/ESPN data and the production cache were not reachable, so the actual live
  row for Cade could not be inspected.

## Expected-games check (the likely driver of Cade's live placement)
Production's availability model on illustrative histories (2025-26 games from the data; earlier seasons
**from memory, unverified**):

| Player | Expected games | Note |
|---|---|---|
| Cade (64, 70, 62, 12, 64) | 64.8 | 12-game 2022-23 treated as an isolated absence |
| Bam (73, 74, 71, 75, 56) | 71.5 | |
| Sengun (72, 63, 75, 72, 65) | 69.7 | |
| Cade with a normal 2022-23 | 66.9 | |

A ~7-game gap against Bam is worth about 300 projected season points (~6-7 value points), more than
the whole scarcity adjustment, and it is why live ranks can be lower than the flat-availability offline
pool suggests. It is a defensible injury-history signal, not a bug, but it is the first thing to check
on the live row (`components.expectedGames`, `availability`).

## Before / after (offline pool, assumed default Yahoo scoring; coarse position labels)
Coarse labels make 122 of 418 players "C-eligible" (real Yahoo eligibility is much stricter), so the
C-eligible shift below overstates the live effect.

### Three diagnostic players
| Rank before → after | Player | Pos | FPts/g | Season pts | Production pts | Replacement pts | Scarcity pts | Value |
|---|---|---|---|---|---|---|---|---|
| 9 → 7 | Cade Cunningham | PG/SG/G | 48.6 | 2847 | 56.7 | 2.6 | 0.2 → 0 | 58.2 → 61.7 |
| 5 → 8 | Alperen Sengun | SF/PF/F/C | 43.9 | 2639 | 52.5 | 4.9 | 4.8 → 0 | 61.2 → 59.9 |
| 10 → 15 | Bam Adebayo | SF/PF/F/C | 40.8 | 2461 | 49.0 | 3.9 | 4.8 → 0 | 56.9 → 55.3 |

### Top 30 after (before-rank shown)
| Rank before → after | Player | Pos | FPts/g | Season pts | Production pts | Replacement pts | Scarcity pts | Value |
|---|---|---|---|---|---|---|---|---|
| 1 → 1 | Nikola Jokić | C | 62.1 | 3654 | 72.8 | 10.5 | 4.8 → 0 | 85.7 → 85.7 |
| 3 → 2 | Luka Dončić | PG/SG/G | 57.7 | 3381 | 67.3 | 5.5 | 0.2 → 0 | 71.0 → 75.3 |
| 2 → 3 | Victor Wembanyama | C | 53.4 | 3128 | 62.3 | 7.6 | 4.8 → 0 | 73.0 → 72.3 |
| 4 → 4 | Shai Gilgeous-Alexander | PG/SG/G | 50.4 | 2988 | 59.5 | 3.4 | 0.2 → 0 | 61.6 → 65.3 |
| 7 → 5 | Tyrese Maxey | PG/SG/G | 48.6 | 2901 | 57.8 | 2.9 | 0.2 → 0 | 59.5 → 63.1 |
| 8 → 6 | Jalen Johnson | SF/PF/F | 48.3 | 2900 | 57.8 | 2.9 | 0.2 → 0 | 59.4 → 63.0 |
| 9 → 7 | Cade Cunningham | PG/SG/G | 48.6 | 2847 | 56.7 | 2.6 | 0.2 → 0 | 58.2 → 61.7 |
| 5 → 8 | Alperen Sengun | SF/PF/F/C | 43.9 | 2639 | 52.5 | 4.9 | 4.8 → 0 | 61.2 → 59.9 |
| 6 → 9 | Scottie Barnes | C/SF/PF/F | 42.0 | 2591 | 51.6 | 4.6 | 4.8 → 0 | 60.0 → 58.6 |
| 13 → 10 | Jaylen Brown | PG/SG/G/SF/PF/F | 45.2 | 2708 | 53.9 | 1.8 | 0.2 → 0 | 54.8 → 58.1 |
| 14 → 11 | Kawhi Leonard | SF/PF/F | 45.7 | 2687 | 53.5 | 1.7 | 0.2 → 0 | 54.3 → 57.6 |
| 17 → 12 | Donovan Mitchell | SF/PF/F/PG/SG/G | 44.3 | 2646 | 52.7 | 1.5 | 0.2 → 0 | 53.3 → 56.6 |
| 19 → 13 | Jamal Murray | PG/SG/G | 42.9 | 2604 | 51.9 | 1.2 | 0.2 → 0 | 52.3 → 55.5 |
| 20 → 14 | Giannis Antetokounmpo | SF/PF/F | 49.1 | 2603 | 51.8 | 1.2 | 0.2 → 0 | 52.3 → 55.5 |
| 10 → 15 | Bam Adebayo | SF/PF/F/C | 40.8 | 2461 | 49.0 | 3.9 | 4.8 → 0 | 56.9 → 55.3 |
| 11 → 16 | Karl-Anthony Towns | C/SF/PF/F | 40.5 | 2458 | 49.0 | 3.9 | 4.8 → 0 | 56.9 → 55.3 |
| 21 → 17 | Kevin Durant | PG/SG/G/SF/PF/F | 41.6 | 2553 | 50.8 | 1.0 | 0.2 → 0 | 51.0 → 54.2 |
| 22 → 18 | Anthony Edwards | SF/PF/F/PG/SG/G | 43.9 | 2549 | 50.7 | 0.9 | 0.2 → 0 | 51.0 → 54.1 |
| 24 → 19 | James Harden | PG/SG/G | 42.4 | 2530 | 50.3 | 0.8 | 0.2 → 0 | 50.5 → 53.6 |
| 25 → 20 | Deni Avdija | PG/SG/G/SF/PF/F | 42.9 | 2526 | 50.3 | 0.8 | 0.2 → 0 | 50.4 → 53.5 |
| 12 → 21 | Joel Embiid | C | 44.5 | 2374 | 47.3 | 3.4 | 4.9 → 0 | 54.9 → 53.1 |
| 15 → 22 | Evan Mobley | C/SF/PF/F | 39.9 | 2348 | 46.7 | 3.3 | 4.8 → 0 | 54.2 → 52.5 |
| 16 → 23 | Pascal Siakam | C/SF/PF/F | 39.9 | 2325 | 46.3 | 3.2 | 4.8 → 0 | 53.6 → 51.9 |
| 28 → 24 | Jalen Brunson | PG/SG/G | 40.5 | 2451 | 48.8 | 0.4 | 0.2 → 0 | 48.6 → 51.6 |
| 29 → 25 | Paolo Banchero | SF/PF/F | 40.8 | 2449 | 48.7 | 0.4 | 0.2 → 0 | 48.6 → 51.6 |
| 30 → 26 | Amen Thompson | SF/PF/F/PG/SG/G | 39.5 | 2429 | 48.4 | 0.3 | 0.2 → 0 | 48.1 → 51.1 |
| 18 → 27 | Jalen Duren | C | 38.2 | 2281 | 45.4 | 2.9 | 4.8 → 0 | 52.6 → 50.8 |
| 31 → 28 | LeBron James | SF/PF/F | 41.4 | 2392 | 47.6 | 0.1 | 0.2 → 0 | 47.2 → 50.1 |
| 32 → 29 | Cooper Flagg | PG/SG/G/SF/PF/F | 39.9 | 2379 | 47.4 | 0.0 | 0.2 → 0 | 46.9 → 49.8 |
| 34 → 30 | Josh Giddey | PG/SG/G | 41.6 | 2355 | 46.9 | 0.0 | 0.2 → 0 | 46.4 → 49.3 |

Broad check over 418 players: mean |rank change| 19.87, max 57, 336 players moved >=10. Mean rank shift: C-eligible 34.1 (n=122), other -14.0 (n=296).
Top-30 overlap before/after: 27/30. Top-10 order: Jokić, Dončić, Wembanyama, Gilgeous-Alexander, Maxey, Johnson, Cunningham, Sengun, Barnes, Brown.

## Rookies (mechanical demonstration only)
No real 2026 rookie, ADP or draft data is available offline. The demo gives veterans a *circular*
pseudo-ADP (their own ProGM rank) and adds hypothetical rookies; it proves the pipeline, not accuracy.
Calibration R^2 0.92 over 418 players.

| Player | ADP | FPts/g | Season pts | Exp. games | Confidence | Value | ProGM Rank | Market label |
|---|---|---|---|---|---|---|---|---|
| Hypothetical rookie @ADP 12 | 12 | 48.6 | 2778 | 57.2 | 0.3 | 57.4 | 12 | neutral |
| Hypothetical rookie @ADP 40 | 40 | 36.2 | 2068 | 57.2 | 0.3 | 41.8 | 60 | neutral |
| Hypothetical rookie @ADP 90 | 90 | 27.8 | 1591 | 57.2 | 0.3 | 32.7 | 134 | neutral |
| Hypothetical rookie @ADP 700 | 700 | no rank: ADP outside the estimable range | | | | | | |
| Hypothetical rookie, no ADP | none | no rank: no stats and no ADP | | | | | | |

## Remaining surprising placements
- Sengun (#8) and Bam (#15) still sit above guards of similar per-game value because the replacement
  baseline for centers is lower (a real effect when 2 C slots are required, but not validated; the
  replacement term is accuracy-neutral in the backtest).
- Guards are the group the backtest still shows as under-ranked (-18 ranks, in every variant including
  pure production), so a residual guard penalty may remain; it could be a labelling artifact of the test.
- Rookie estimates trust the market: an early-ADP rookie projects near veteran levels (rookie playing-time
  risk is only reflected through the 0.3 confidence factor and default availability).
