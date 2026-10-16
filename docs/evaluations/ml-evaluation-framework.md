# Chronological ML evaluation framework (Stage 1)

Branch `feature/ml-eval-framework` (from `feature/projection-age-minutes`). Evaluation only: no model is trained for production, nothing is deployed, no ranking behavior changes.

## What it does
`runChronologicalEvaluation` walks forward through target seasons. For target season `t` it forecasts as of 1 October `t` using a **point-in-time view** that contains only rows final before that date (season `s` is final on 1 July of `s+1`, or an explicit `availableAt`). The view is deep-frozen; target-season rows are not present at all.

Baselines (`evalModels.js`), all fed only by the view:
- `production`: last-season stat line scored with the league's exact weights, last-season minutes, production durability model (`durability.js`) for games.
- `age_minutes`: the experimental age + minutes adjustment, same durability games; per-player fallback to `production` with the reason counted.
- `naive_games`: last-season games (games target only).
New models plug in as `{ id, version, fit(view, ctx) -> { predict(playerId) } }`.

Scored separately per season, then averaged across folds: **games** (MAE, RMSE, bias; zero-game players included), **minutes** and **fantasy points per game** (players with at least 15 actual games), **season totals**. Ranking: Spearman and **top-25/50 overlap and value capture** for totals and for per-game points. Models are compared with the reference (`production`) on paired folds: mean difference, t interval, folds improved. **Uncertainty**: 80% intervals from residual quantiles of earlier, already-final seasons only (needs 30+ residuals); coverage and width are reported.

## Provenance and tracking
Every prediction record (`progm.prediction-record.v1`) stores model id and version, target season, forecast time (`asOf`), generation time, data cutoff season, latest data availability time, data fingerprint, provenance hash and name, predicted values, intervals (with their basis seasons) and any fallback reason. The JSONL log never contains outcomes, so it can double as a prospective log later. Datasets must carry authorized provenance; `licenseStatus: unresolved` is refused; incomplete coverage produces a warning because absent players are scored as 0 games.

## Leakage controls and tests
1. Point-in-time views (tests: future rows and future `availableAt` invisible, view frozen).
2. `assertViewIsPointInTime` on every fold.
3. Leakage canary: target and all later seasons are replaced with garbage (plus ghost players); every model must produce byte-identical predictions. The CLI refuses to report if it fails. Tests prove the canary catches a broken filter and a view with forged availability stamps.
4. Interval residuals are limited to seasons final at forecast time (tested).
5. Records with a data cutoff at or after their target season are rejected.
Limitation: a model that smuggles data through a closure or file read outside the supplied view cannot be detected by data perturbation; new models need review.

## Running
`npm run evaluate:chronological -- --data authorized.json --scoring league-scoring.json --out folder` (formats as in the historical backtest README). Writes `chrono-eval-report.json` and `chrono-eval-predictions.jsonl`.
Tests use synthetic data only; the synthetic result (age + minutes beating production on per-game MAE) validates the framework, not real accuracy.

## Is there enough data to begin ML v1?
No. No authorized historical dataset is available in the repository or environment. The only large dataset used so far has unresolved licensing and is refused by the framework. ML v1 needs: an authorized source with complete league coverage for 8+ seasons (so at least 6 chronological folds), minutes, games, every stat in the league scoring (including OREB/DREB and DD/TD), and age or birth date (the BALLDONTLIE adapter provides none). See `data-sources-licensing.md`.

## Stage 0 status
- Yahoo ranking comparison: script delivered (branch `feature/yahoo-rank-compare`); it needs your saved workspace response and has not been run, so the best-matching Yahoo field is still undetermined.
- Age + minutes experiment: hardened, 445 tests passing on its branch, pushed; no PR opened.
- Licensing: inventory above; nothing verified from vendor terms.
