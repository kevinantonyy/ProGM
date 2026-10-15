# Expected games: root-cause audit and recency-weight backtest

Branch `feature/ranking-integration`. **Diagnosis only: no ranking weights, availability formulas or flags were
changed and nothing is deployed.** Backtests use the NBA table acquired earlier for the research prototype
(2014-2026 player seasons; licensing unresolved, raw data not in Git). The production availability code
(`durability.js`) was run unmodified; a Python replica with swappable season weights matches it to within
rounding (max difference 0.05 games over 2,743 predictions).

## 1. Full trace (target 2026-27, production model, league-wide baseline from the 582-player pool)
Reproduces your live numbers closely: Cade 61.1 (live 60.7), Jalen 57.1 (live 56.5), Bam 70.0 (live 70.0). The
earlier 2-game gap I reported came from using a 327-player baseline pool; with the full pool the baseline matches.

| | Cade Cunningham | Jalen Johnson | Bam Adebayo |
|---|---|---|---|
| Age / debut | 25 / 2021 | 25 / 2021 | 29 / 2017 |
| Games by season, oldest..latest | 64, 12, 62, 70, 64 | 22, 70, 56, 36, 72 | 69, 82, 72/72, 64/72, 56, 75, 71, 78, 73 |
| Availability by season, newest first | .78, .85, .76, .15, .78 | .88, .44, .68, .85, .27 | .89, .95, .87, .92, .68, .89, 1.0, 1.0, .84 |
| Season weights, newest first (0.6^i, normalised) | .43 .26 .16 .09 .06 | .43 .26 .16 .09 .06 | .40 .24 .15 .09 .05 .03 .. |
| Pattern / isolated-absence rule | isolated low (12-game season, half-discounted) | **recurring low** (22- and 36-game seasons), no discount | mixed, none |
| Recency-weighted history rate | .767 | .697 | .896 |
| Evidence shrink toward baseline | 4.8% | 4.8% | 2.8% |
| Cohort baseline (age cohort / experience cohort / pool-wide) | .694 (.652 / .735 / .678) | .694 (same) | .739 (.731 / .746 / .678) |
| History rate mixed with baseline (75% / 25%) | .746 | .696 | .853 |
| Injury cap | none | none | none |
| **Expected games (x82)** | **61.1** | **57.1** | **70.0** |

Cade is not penalized by his last season (64 games = .78, above his own 5-season rate .66); his result sits below
his last-three-season average (.80) because the 12-game season is partly kept and the baseline pulls 25% toward .69.

### Why Jalen is 56.5-57 despite 72 games last season
Last season is only 43% of the weight. His 2024-25 season (36 games, .44) carries **26%**, 2023-24 (56 games) 16%,
and his 22-game rookie year 6%. The weighted history rate is .70, and the pattern is "recurring low", so the
isolated-absence discount does not apply. That is the model doing what it was built to do: a player with 2 of 5
seasons below 45% availability has a .62 career rate. It is **not** a missing-season, denominator, stale-injury or
age artifact. Under your 50/30/15/5 schedule his 2024-25 season would still carry 30% (rate .705 -> 57.5 games).

## 2. Checks requested
| Check | Result |
|---|---|
| Stale injury information | The injury input only acts on explicit "out for season"-type text (cap 0). All three have no cap, and a cap would produce 0, not 57. The feed is cached 30 minutes and applied only for the current season. Cannot verify the live feed from here; the trace now prints `injuryType/cap/reason`. |
| Season denominators | Production uses the observed league maximum games per completed season (`min(82, max observed)`), so 2019-20 and 2020-21 use 72, not 82. Bam's 64/72 and 56/82 are correct. Pre-debut and failed seasons are omitted, never counted as zero. |
| Missing historical seasons | My reproduction with all seasons gets within 0.6 games of production for all three, so production saw essentially the full history. Your trace's `perSeason` list settles it exactly. |
| Age adjustment | Age enters only through the 25% baseline: age cohort (+-2 years) and experience cohort (+-2 years), each shrunk to the pool rate. For 25-year-olds the age cohort is .652, below the pool .678 (the pool includes many fringe players). No age bonus/penalty is hard-coded. |
| Isolated-injury penalty | Cade's 12-game season is half-discounted. Evidence (below) says this discount is, if anything, **too generous**, not too harsh. |

## 3. Backtest: availability prediction (games), time-ordered
Universe: players with >= 800 minutes the season before, **including those who then played 0 games**, 2018-2026
(history reaches back only to 2014, so 4+ season tails are thin before 2021). Baseline: production's cohort baseline built
from the full prior-season pool. Development folds 2018-2024 (n=2,138); holdout 2025-26 (n=605), which has been looked at
before, so it is not independent. Isolated-injury subset: one season below 50% in the last three, others >= 75%
(n=161 dev, 34 holdout). Short history: <= 2 prior seasons (n=439 dev, 113 holdout).

| Model | Dev MAE | Dev bias | Hold MAE | Hold bias | Isolated-injury bias dev / hold | Short-history MAE dev / hold |
|---|---|---|---|---|---|---|
| **Production** (decay 0.6, half-discount) | 16.04 | +6.5 | 17.12 | +7.1 | +3.6 / +2.2 | 15.99 / 15.06 |
| Production without isolated discount | 15.99 | +6.0 | 17.17 | +6.7 | +1.2 / +0.5 | 15.99 / 15.06 |
| **50 / 30 / 15 / 5+** (your schedule) | 15.98 | +6.6 | 17.11 | +7.3 | +3.7 / +2.3 | 15.89 / 15.00 |
| 60 / 30 / 10 / 0 | 15.94 | +6.9 | 17.09 | +7.7 | +4.2 / +2.9 | 15.68 / 14.93 |
| 70 / 20 / 10 / 0 | **15.92** | +7.1 | 17.09 | +7.9 | +4.7 / +3.1 | 15.52 / 14.89 |
| 40 / 30 / 20 / 10 | 16.07 | +6.3 | 17.17 | +7.0 | +3.1 / +1.8 | 16.12 / 15.15 |
| Equal weight, last 3 seasons | 16.16 | +6.1 | 17.33 | +6.8 | +2.4 / +1.1 | 16.29 / 15.25 |
| Last season only | 16.14 | +7.9 | 17.23 | +8.7 | +6.3 / +4.3 | 15.28 / 14.91 |
| Cohort baseline only | 17.11 | +3.0 | 17.79 | +3.7 | +1.1 / +0.1 | 17.38 / 16.27 |

MAE difference versus production (games; negative = better), paired bootstrap 95% interval:

| | Dev | Holdout (not independent) |
|---|---|---|
| 50/30/15/5 | -0.05 (-0.09, -0.02) | -0.01 (-0.10, +0.08) |
| 60/30/10/0 | -0.09 (-0.17, -0.02) | -0.04 (-0.20, +0.12) |
| 70/20/10/0 | -0.11 (-0.21, -0.02) | -0.03 (-0.24, +0.18) |
| Equal 3 seasons | +0.12 (+0.04, +0.21) | +0.21 (+0.04, +0.39) |

Data-driven weights: a grid search over all four-bucket schedules (step 0.1) on development folds ranks 70/20/10/0
(15.92) first, then 60/20/20/0, 70/10/20/0, 60/30/10/0; **no top schedule puts any weight on seasons 4+**. Choosing weights
on past folds only (expanding window, folds 2021-2026) picks 60-70 / 20-30 / 10-20 / 0 every time; its out-of-sample MAE
beats production in five of six folds (by 0.02-0.23 games; 0.03 worse in 2026) and your 50/30/15/5 in every fold (by 0.01-0.12).

What this says:
- **More recency helps, but only slightly**: 0.05-0.11 games of 16 (under 1%). Statistically detectable on development
  folds, not on the small holdout.
- **The 5% tail is not supported**: the data prefers zero on seasons 4+ (seasons that old add noise).
- **Equal weighting is clearly worse**; last-season-only has the highest bias and is only best for short histories.
- **Bias**: every model over-predicts games (about +6 to +8 for all players; +3 to +5 even among players who played), mainly
  because players who retire, are cut or sit out entirely score 0 and nothing predicts that. More recency raises this
  over-prediction slightly. This is a calibration problem separate from the weights.
- **Isolated injuries**: the half-discount makes predictions for players with one bad season about 2.4 games too high
  (+3.6 vs +1.2 bias); MAE is a wash. No evidence supports softening it further.
- **Short histories** gain the most from recency (15.99 -> 15.52 MAE with 70/20/10).
- The 2026 fold is hardest for every model (MAE ~18).

### Effect on the three players (target 2026-27, games)
| Model | Cade | Jalen | Bam |
|---|---|---|---|
| Production | 61.1 | 57.1 | 70.0 |
| 50/30/15/5 (yours) | 62.5 | 57.5 | 70.4 |
| 60/30/10/0 | 63.1 | 58.8 | 70.6 |
| 70/20/10/0 | 62.7 | 61.4 | 70.2 |
| Equal 3 seasons | 62.9 | 55.3 | 70.4 |
| Last season only | 62.0 | 67.7 | 69.6 |
| Cohort baseline | 56.9 | 56.9 | 60.6 |
Moves are 1-4 games (Jalen the most). No schedule that the backtest supports moves Jalen above ~61 games, because 2024-25
(36 games) is a genuine signal of recurring missed time; the only schedule that gives him 68 (last season only) is also the
worst on accuracy and bias.

## 4. Sample-size and handling notes
- **Shortened seasons**: denominators already use the observed league maximum; tested with 72-game seasons in 2019-20 and
  2020-21. Keep.
- **Incomplete current season**: not in the sample (preseason). Proposal for in-season use, untested: add the current
  season as a row with its team games played so far, weighted by the share of the season completed.
- **Current injuries**: cannot be backtested (no historical injury feed). Keep the verified season-ending cap; require a
  fresh timestamp from the injury source before applying it.
- **Limited history**: already shrunk toward the baseline by evidence games; the backtest shows recency-heavy weights help
  most here.
- **Not validated**: any claim about 4+ season tails beyond what 2014-2026 can show; early folds have <= 4 seasons.

## 5. Should draft valuation account for replacement production when a player misses games?
Today `seasonPoints = perGame x expectedGames`, and the 20% VORP term subtracts a replacement player's own season
total. Missed games therefore count as zero production, although a manager normally fills the slot with a
replacement. The slot's value over replacement is `games x (perGame - replacementPerGame)`.
Offline test (default Yahoo points, replacement = per-game average of players ranked 121-150, predictions from the
existing projection x production games, realised value = games played x (realised per game - realised replacement)):

| | Dev | Holdout (not independent) |
|---|---|---|
| Spearman vs value over replacement: current / replacement-aware | .739 / .758 | .763 / .781 |
| Top-50 overlap with that value: current / replacement-aware | .754 / .766 | .670 / .680 |
| Spearman vs raw season points: current / replacement-aware | .675 / .656 | .629 / .602 |
| Mean rank shift of the lowest-games quartile | -26 ranks (better) | -28 |

It is a valuation-philosophy choice: the replacement-aware form predicts the "fill-in" value better and the raw season
total worse. It would move injury-prone players up by ~25 ranks, which is large. Recommendation: evaluate it as an
**optional, flagged** valuation with league-specific replacement and a cap (leagues differ in IL slots and waiver depth),
not a silent change.

## 6. Recommendations (general, evidence-based; nothing implemented)
1. **Availability weights (low priority):** if changed, use a three-bucket recency schedule near 60-70 / 20-30 / 10 with
   no tail, chosen on past folds only. Gain ~0.1 games MAE; it will not materially change rankings and does not fix
   Jalen or Cade.
2. **Isolated-injury discount:** leave or tighten; no evidence for loosening.
3. **Calibration:** add a bias correction or an explicit exit probability (players who do not play) rather than
   changing weights; this is the dominant error.
4. **Replacement-aware valuation:** prototype behind a flag (section 5).
5. **Baseline pool:** the baseline uses every pool player, including fringe players; a minutes-weighted pool would be a
   small, testable change, but the backtest shows the current baseline is not too low (over-predicts, not under).
6. Do not tune any availability setting toward Yahoo ADP or a preferred board.

## 7. Other items you raised
- **All nine rookies get the same 56 games.** With no history, the model returns the pool-wide availability (about .68-.70
  x 82). It is neither wrong on average (past first-round picks averaged 49-69 games in their first season, picks 31-60 far
  fewer) nor differentiated. Better inputs (draft slot) are unavailable at runtime; ADP could proxy slot bands but would
  mix market and availability, so it is left as a documented limitation.
- **Boozer #104 with ADP 55.3.** In a mechanism demo where ADP equals ProGM's own rank (so no systematic disagreement
  exists), an ADP-55 rookie still lands #89: full confidence would give #66, veteran-median games #83. The 0.3
  confidence factor (a ~7% value cut, ~25 ranks in the dense mid-pool) outweighs the games assumption (~6 ranks); the
  regression compresses ADP toward the mean on top. The replay output now reports this decomposition per rookie
  (`rookieSensitivity`) on your real snapshot.
- **Yahoo ID/debut correlation only through 2020.** The evidence block only used players with an ESPN `debutYear`;
  it now reports how many stat-bearing players lack one and lists the 25 highest Yahoo numbers regardless, so you can
  check the 2025-26 boundary by name (2025 draftees should sit just below the 2026 rookies).
- **Sengun matching.** Yahoo spells "Alperen Şengün"; highlight lookup was exact-lowercase. It now uses the shared
  accent- and suffix-insensitive `normalizeName` in the compare, replay and trace paths (tested).
- **The 19 non-exact replay matches.** The snapshot stores per-game points to 2 decimals, games to 1 and the confidence
  factor to 3, so replayed values differ slightly from the unrounded ones the app used and near-ties swap. The replay
  now lists each mismatch with its nearest rival's value gap and the largest change rounding can cause, and flags it
  "explained by rounding" when the gap is smaller. Re-run on your file to see which of the 19 qualify.
