# Experimental age + minutes projection (account-scoped, default off)

Branch `feature/projection-age-minutes` (from `feature/ranking-integration`). Not merged, not deployed, nothing pushed.

## Flag
`PROGM_PROJECTION_ADJ_USER_IDS` = comma/space separated numeric ProGM user ids. Only listed accounts get it; there is no global switch.
Unset, empty, `*`, `all`, `on` or any non-numeric entry = off. Listed accounts get the cache profile suffix `.pam` (e.g. `legacy.noest.pam`,
`v2.noest.pam`) so their workspace and frozen-baseline caches never mix with other accounts. Everyone else keeps their exact current keys and output.
Independent of `PROGM_RANKING_V2_USER_IDS` and `PROGM_ROOKIE_ESTIMATES` (rookie estimates untouched). Rollback: delete the variable.

## What changes (and what does not)
- Draft Helper board, Rankings tab and the live-draft recommendations only. Waivers, trades, lineup optimizer and start/sit keep the base projection.
- Scoring (`scoring.js`), positional valuation (`draftHelper.js`), expected games and rookie estimates are untouched.
- `adjusted per game = existing per game + delta`, `delta = lastPPM * ageFactor * predictedMinutes - lastPPG`, capped at +-35% of the existing figure.
  The existing 35% recent-form tilt is therefore preserved; with no recent form it equals the backtested model.
- ageFactor: per-minute production changes with age (points-per-minute change from age a to a+1, pooled +-1 year, shrunk toward 0 with W0 = 5,000 minutes).
  Fitted on a proxy score (the league's weights on stats every season feed carries; OREB/DREB left out because prior-season feeds omit them), applied as a ratio to the real league-scoring per-minute production.
- predictedMinutes: ridge regression (lambda 1) on [1, last mpg, prior mpg (last if missing), age, (age-26)^2, last availability].
- Fallback to the existing projection, per player, when: no model (fewer than 150 aging pairs or minutes rows, or missing last-season feed), age unknown, no proxy row,
  last-season minutes < 800, last-season league-scoring points unavailable/incomplete, estimate rows, or no base projection. Reasons are counted in `adjustmentDiagnostics`.
- No individual player is referenced anywhere in the code; identical inputs give identical adjustments (tested).

## Data requirements (no licensed or research data in the repo)
Fitted at runtime from the same cached league-wide ESPN season feeds the app already uses (`seasonStatsAll:{season}`): last completed season (already fetched) plus the three before it
(up to 3 additional cached league-wide requests per 12 hours when the flag is on, none per player, no Yahoo calls, no database writes). Needs minutes, games played and the weighted stats
(except OREB/DREB) per season, and ESPN `age` from the player directory (age during season s = directory age + (s - current NBA season)). The research dataset used for the backtest is
not in the repository and no coefficients derived from it are shipped.
Fit cost measured at 20-60 ms per workspace build (about 800 aging pairs, 780 minutes rows).

## Offline comparison (research data, your league's scoring, identical pools; scratch only)
The comparison runs the repository code (`projectPlayer`, `computeAdjustedProjections`) on the research tables, with prior-season OREB/DREB removed and the fit limited to four seasons and to players
present in the last season, i.e. production's information. Nine rolling folds (2018-2026), each fitted only on earlier seasons. "Existing" = last-season per-game points (the production recent-form blend cannot be reproduced offline).

| | per-game MAE | Spearman vs realized totals | top-25 overlap | top-50 overlap |
|---|---|---|---|---|
| existing | 8.70 | 0.664 | 0.618 | 0.684 |
| **experiment (production code path)** | **8.20** | **0.692** | 0.618 | 0.678 |
| research all-history fit (reference) | 8.19 | 0.694 | 0.618 | 0.676 |

Paired over 9 folds: per-game MAE -0.50 +-0.11 (9/9 folds better); season-total MAE -37 +-15 (9/9); Spearman +0.027 +-0.007 (9/9); top-25 +0.000 +-0.041; top-50 -0.007 +-0.019 (not better).
Last two folds (2025, 2026): MAE 9.07 -> 8.57, Spearman 0.635 -> 0.659.
By group (MAE improvement, 95% bootstrap): guards +0.54 [0.30, 0.76]; forwards +0.38 [0.13, 0.62]; centers +0.57 [0.30, 0.83]; age <=22 +0.80 [0.45, 1.15]; 23-24 -0.08 [-0.26, 0.11]; 25-27 +0.16 [-0.01, 0.32]; 28-30 +0.42 [0.08, 0.73]; 31+ +1.31 [0.81, 1.77].
Rank bias by age (predicted minus realized rank, negative = overvalued): <=22 +35.6 -> +15.3; 23-24 +12.8 -> +4.2; 28-30 -16.2 -> -9.4; 31+ -27.2 -> -7.1. Position bias unchanged within noise.
Players moving 15+ ranks (937 across folds): 62% moved toward their realized rank; mean absolute rank error 59.7 -> 53.3. Top-50 turnover about 3.4 players a season.

2026-27 projection (descriptive only, v2 values, same pool and scoring; not used for selection): top-25 overlap 23/25, top-50 43/50, top-100 97/100. Age is the driver of every notable move:
younger players rise (Kon Knueppel 67 -> 38, VJ Edgecombe 77 -> 44, Kel'el Ware 94 -> 61), older players fall (Jimmy Butler 50 -> 91, Stephen Curry 34 -> 64, Joel Embiid 53 -> 81).
Cade 16 -> 12, Jalen Johnson 18 -> 15, Sengun 10 -> 6, Bam 9 -> 10 are by-products of age and predicted minutes, not targets.

## Limitations
- Does not improve top-25/50 overlap; the gain is in the accuracy of the numbers and overall rank correlation.
- Never run against live ESPN feeds in this environment (network blocked). The unit tests use synthetic data. First account-scoped run must check `adjustmentDiagnostics` (applied count, fallbacks, pairs, triples).
- Age convention (ESPN directory age vs season age) is assumed to differ by exactly the season offset; a one-year offset would shift the age curve (fit and application share the convention, so mainly harmless).
- Fit uses players still in the directory (survivors); the offline replication of that restriction cost about 0.01 MAE, but live data may differ.
- Minutes model has no role/depth-chart/trade information; the 23-24 age group did not improve; players below 800 last-season minutes and rookies are not adjusted.
- Position results rely on height buckets, not Yahoo eligibility.
