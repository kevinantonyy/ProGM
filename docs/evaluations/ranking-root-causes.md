# Ranking root causes: real-league results (578-player pool)

Branch `feature/ranking-integration`. Investigation only: **no ranking formula was changed**; no flags, merge or
deploy. The sanitized snapshot from your run was not available in this environment, so findings use (a) the
numbers you reported, (b) the ranking code, (c) the historical NBA table already acquired for the prototype and
(d) the offline replica pool. What the real snapshot can still confirm is listed under "Needs the trace".

## Your results, decoded
| | Legacy | v2 | Yahoo ADP | Per game | Exp. games | Season pts (per game x games) |
|---|---|---|---|---|---|---|
| Cade Cunningham | 19 | 18 | 6 | 92.3 | 60.7 | **5,603** |
| Bam Adebayo | 6 | 7 | 26.5 | 83.3 | 70 | **5,831** |
| Alperen Sengun | 7 | 11 | 18.5 | n/a | n/a | n/a |

Bam's projected **season** total is 4.1% above Cade's (Cade's 10.8% per-game edge is cancelled by a 13.3%
games deficit), so Bam ranking above Cade is arithmetically consistent *before* any positional term. ADP is not
evidence of error (it is a market view, and a different quantity from projected season production).

## RC1 - Why v2 drops center-eligible players ~40 ranks on average (explained; not a defect in v2)
- Legacy gives every C-eligible player the **maximum** scarcity component: `scarcityWeights` min-max normalises
  pressure (`playerValue.js:47-70`), `scarcityComponent` maps the top weight to 1.0 and `bestScarcity` takes the
  best eligible position (`draftHelper.js` helper functions above `computeDraftValue`). Result: a **flat +4.9 value
  points** for any C-eligible player of any quality, ~0.2 points for everyone else.
- A flat bonus moves ranks in proportion to how tightly packed values are. In the replica pool the value gap per
  rank step is 3.2 pts (ranks 1-10), 0.38 (11-50), 0.12 (51-150), 0.07 (151-300). 4.9 points therefore equals
  ~1.5 ranks at the very top, ~13 in the 11-50 band, ~42 in 51-150 and ~70 in 151-300. Mean v2 rank change of
  C-eligible players by legacy rank band (replica): 1-25: +5, 26-50: +14, 51-100: +28, 101-200: +36,
  201-300: +50 (down). Your 40.4 full-pool average is the deep tail dominating the mean; Bam (6 -> 7) and
  Sengun (7 -> 11) match the top-band behaviour. **Report shifts by rank band, not as a full-pool mean.**
- Conclusion: the large average is legacy's saturated bonus being removed. It supports v2; it is not a sign
  v2 over-corrects. Not evidence for any weight change.

## RC2 - Expected games (Cade 60.7, Bam 70, Sengun): no evidence of over-reaction to last season
Reproduced with the production availability model (`durability.js`, `AVAILABILITY_MODEL`: history weight 0.75,
baseline 0.25, recency decay 0.6) on real game logs for 2027 (histories 2021-2025; the model's cohort baseline
built from the 327-player pool; the live pool differs, so values are within ~2 games of production's):

| Player | Games by season (oldest..latest) | Raw 3-yr rate | Model availability | Expected games (mine / yours) |
|---|---|---|---|---|
| Cade | 64, 12, 62, 70, 64 | 0.80 | 0.765 | 62.8 / 60.7 |
| Bam | 56, 75, 71, 78, 73 | 0.90 | 0.866 | 71.5 / 70 |
| Sengun | 72, 75, 63, 76, 72 | 0.87 | 0.844 | 69.2 / n/a |

- **Sensitivity to the previous season:** +10 games last season -> about +3 (Cade 3.1, Bam 2.7, Sengun 3.1)
  expected games, i.e. 0.31 per game. Empirically (2,251 player-seasons 2016-2026), +10 games last season is
  followed by **+3.6** games next season (players who play; 4.9 including those who do not). The model is, if
  anything, slightly *under*-reactive to last season, not over-reactive.
- **Cade specifically:** two things pull him below his own recent average: the 12-game 2022-23 season
  (flagged "isolated absence" and half-weighted, but still in the older-career component) and the cohort baseline
  (0.76) which carries 25% weight. Replacing that season with an 85% one moves him 62.8 -> 64.9. His last season
  (64) and the one before (70) are not harsh. This is a modelled injury-history signal, not a bug.
- **Unexplained:** your 60.7 vs my 62.8. Production sees ESPN's history and the live pool baseline. The trace
  prints `perSeason` as production saw it.
- **Prototype comparison:** the empirical-Bayes variant has slightly lower error than production (15.5 vs 15.9
  games MAE dev, 16.8 vs 17.2 holdout). A small gain, not a fix for Cade.

## RC3 - Projected per-game points (92.3 / 83.3) cannot be judged without the scoring breakdown
- On Yahoo's default points weights Cade projects ~48.6 and Bam ~40.8 (last season's lines). Your figures are
  ~1.9x and ~2.0x that scale, and their ratio (1.11) differs from the default ratio (1.19). So the league scoring
  is almost certainly a heavier custom set (extra FGM/FTM/3PM/rebound-split weights, etc.) or counts stats more
  than once. `scoreStatLine` (`scoring.js`) applies **every** enabled category with a `pointValue`, and maps
  stat ids 13 (OREB), 14 (DREB) and 15 (REB) separately, so a league that weights both REB and the splits counts
  rebounds twice, exactly as its rules say. The code applies the league's own weights faithfully; whether the
  *weights themselves* are what you expect is the open question.
- **Stale data risk:** the projection season is `Yahoo season - 1` (`insights.js` `projectionSeason`). Check the
  trace `lastSeasonNba.season` equals 2025 for a 2026 league.
- **Early-season blending risk:** `blendStatLines` uses a fixed 35% recent-form weight regardless of sample size
  (`projection.js` `RECENT_WEIGHT`), and `getRecentForm` takes the last 10 completed games per team from the
  schedule file regardless of season type. If the snapshot was taken after games began, a one- or two-game sample
  carries 35% weight. Check `projectionMethod`: `season_only` is clean, `blended_recent_season` needs a look.

## RC4 - Positional replacement: a real but unvalidated centre advantage
- `computeReplacementBaselines` sets each position's baseline to the (starters x teams)-th best eligible player by
  season points; `computeDraftValue` then uses the **lowest** baseline among a player's eligible positions
  (`draftHelper.js`, the `bestBaseline` loop) and normalises by the pool's max-min season points. Thin supply at C
  gives a low C baseline, so every C-eligible player gets more VORP credit (in the replica: C baseline 1,753
  vs ~2,429 season points for guards, worth ~2.3 value points between Sengun and Cade). That is a genuine
  lineup effect only if your league requires C slots; the code uses your actual slots.
- Evidence for changing it: none. In the backtest, replacing `min` with `max`, `mean` or a flat UTIL baseline left
  accuracy unchanged (Spearman 0.608 for all) and positional bias identical. Leave it unless the trace shows an
  outlier baseline for your league.
- Pool caveat: baselines come from the board pool (available players + your roster). Before the draft that is
  everyone; mid- or post-draft it is the waiver pool, which lowers every baseline. Check `draftStatus` in the
  snapshot meta.

## RC5 - Unprojected players: rookies, injured veterans and identity failures are lumped together
- `applyMarketPriors` (`marketPrior.js`) estimates **any** player without a projection that has a usable ADP
  (only skips scoring gaps). That includes veterans who missed last season and players the identity layer failed
  to match. Yahoo ADP is a market price that already discounts expected missed games; converting it to a per-game
  figure and then applying default availability both mislabels the quantity and loses the injury information.
- Distinguishing signals already in the payload: prior-season Yahoo ranks (`yahooPriorSeasonRanks`,
  `lastSeasonYahooRank`), injury `status`, identity `matchMethod`. A player with a Yahoo rank from an earlier
  season is not a rookie. The snapshot tool now classifies unprojected players this way (diagnostic only):
  `rookie_or_new_candidate`, `veteran_missing_stats`, `injured_no_history`, `scoring_gap`.
- 162 unprojected / 14 with ADP is consistent with deep free agents having no ADP; the 14 are the real question.

## Needs the trace (re-run on the raw file you already saved; no new requests)
`node scripts/snapshotCompare.mjs ~/workspace-response.json ~/progm-out` now also writes, for the three
players, the league scoring weights and roster slots, last-season stat line and fantasy-point breakdown,
projection method, the full availability breakdown with per-season games, the replacement baselines by
position, the pool maximum, and the 14 ADP-eligible unprojected players with their class, injury status,
prior-season rank count and identity match. Share the new `progm-ranking-comparison.json`.

## Prioritised plan (nothing implemented)
1. **P0 - Restrict ADP estimates to rookie candidates** (no prior-season Yahoo rank, no injury status, no
   provider match). Veterans and injured players stay "no projection" with an explicit reason; add tests. Small,
   removes the injury/ADP conflation. Depends only on fields already fetched.
2. **P1 - Read the trace:** confirm scoring weights (RC3), projection season and method, the 60.7 history, and the
   replacement baselines; decide from numbers whether any of RC2-RC4 need code.
3. **P2 - Report ranks by band** (top 25/50/100) in the diagnostic and tests; retire full-pool mean shift.
4. **P3 - Early-season guard for recent form** (sample-size-aware weight and regular-season-only games) if
   `projectionMethod` shows blending; backtest first.
5. **P4 - Games model:** keep. Revisit the empirical-Bayes variant only via a flagged A/B (gain is ~0.4 games).
6. **P5 - Replacement rule and C advantage:** no change without evidence; if the trace shows a degenerate C
   baseline, test a lineup-aware replacement offline first.
7. Do not tune any weight toward Yahoo ADP.

---
## Follow-up fixes (real-league trace: all 14 ADP-eligible unprojected players, rookies included, came out "veteran")

**Why rookies were labelled veterans.** The label came from the snapshot tool's own heuristic, which treated
any prior-season Yahoo rank (`yahooPriorSeasonRanks`, `lastSeasonYahooRank`) as proof of a veteran. The real data
refuted that assumption: incoming rookies such as Boozer, Dybantsa, Wilson and Peterson carry such ranks, so the
field cannot separate rookies from veterans. It is now informational only. (Production never used it: the earlier
estimator estimated *any* unprojected player with an ADP, which is the second problem.)

**New rule (`unprojectedClass.js`), shared by production estimates and the diagnostic.** Rookie status is not
inferred from a missing projection or an unmatched identity. The independent signal is Yahoo's own player number:
a player whose number exceeds that of every player with a real last-season stat line was added to Yahoo after
that season's players, so cannot have played in it. Anyone at or below the cutoff (veterans, injured veterans,
earlier draft stashes) is never estimated. Further blocks: any Yahoo status flag, a provider-matched player,
missing number or no cutoff (all "unknown"), and scoring gaps. `applyMarketPriors` now **requires** a classifier;
without one nobody is estimated. Skipped players keep "no projection" with a plain-language reason in
`noDataReason` and an `unprojectedClass` field.
*Unverified assumption:* Yahoo player numbers are monotonic in creation time. It fails safe: a wrong cutoff can
only be higher, which removes estimates, never adds them. The new trace prints the cutoff and each unprojected
player's Yahoo number so you can check Boozer, Dybantsa, Wilson and Peterson sit above it.

**Why replacement baselines and `projectionMethod` were empty.**
- `projectionMethod`: the flags-off production payload predates that field, so it is simply absent (null).
  The trace now derives it: if per-game equals the last-season fantasy score the projection is `season_only`,
  otherwise recent form was blended; if the last-season score is missing it says `unavailable`. The source
  ("payload" or "derived") is printed.
- `replacementBaselineByPosition`: the old derivation looked for players with a single non-UTIL position, but
  Yahoo lists overlapping positions (PG also lists G), so no row isolates one position. The payload does not
  publish baselines. Each traced player now gets his **exact** baseline (`seasonPoints - vorp`); the pool section
  lists the distinct baselines with the positions common to all players sharing each, and only names a position
  when exactly one is shared (marked inferred); otherwise it states "unavailable" with the reason.

No weights, expected-games formulas or scoring were changed.
