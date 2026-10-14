# ProGM

Fantasy sports assistant: Yahoo Fantasy Basketball (OAuth) plus existing fantasy football. Production runs at https://progm.onrender.com on Render (free plan). `render.yaml` sets `autoDeployTrigger: commit`, so every push to `main` deploys.

## Layout
- `server.js`: root entry point (`npm start`). The root `postinstall` installs `server/` and `client/` and builds the client.
- `server/src/`: Express API (ESM, Node >= 20). Routes are in `routes/` (`yahoo.js`, `basketball.js`, `auth.js`, `diagnostics.js`). Data providers are in `services/providers/` (Tank01, free NBA, nba stats, cache).
- `server/src/services/fantasy/`: the production basketball engine (`projection.js`, `playerValue.js`, `rankings.js`, `scoring.js`, `draftHelper.js`, `waiverEngine.js`, `tradeRecommender.js`, `startSit.js`, `lineupOptimizer.js`, `adpMarket.js`, …).
- `server/src/services/fantasy/backtest/`: the OFFLINE experimental prediction engine (see below).
- `server/src/services/sportsData/`: internal provider-independent data store (Postgres `sd_*` tables, created lazily) and ingestion with source-permission gating; internal admin-only GET routes at `/api/internal/sports-data`, 404 unless `ENABLE_SPORTS_DATA_API=true`. See its README.
- `server/src/services/predictionTracking/`: append-only record of ProGM's own predictions (`pt_predictions`, created lazily) and offline MAE/RMSE/bias; not wired into production. No raw provider data, no outcomes collected. See its README.
- Projection horizons (`projectPlayer({ horizon })`): `season` (default; draft value, season rankings, trades, team rating) always uses the existing model; `next_game` (start/sit, lineup, waivers) uses the recency hybrid only when `PROGM_PROJECTION_MODEL=recency_hybrid_v1` (`services/fantasy/projectionModel.js`); unset = existing model everywhere (default, rollback). The Yahoo draft board adds an informational `nextGamePoints` only when the flag is on; it never affects rank, value or recommendations. API responses carry `projectionModels` labels. `PROGM_PREDICTION_TRACKING=true` records ProGM's own projections to `pt_predictions`. Both are off by default; evaluations are in `docs/evaluations/`.
- `client/`: React 18, Vite and Tailwind. Basketball UI is in `client/src/pages/BasketballWorkspace.jsx`; football is in `pages/FantasyFootball.jsx`.

## Yahoo HTTP 999 warning
Yahoo has returned HTTP 999 before because of excessive draft-results polling. These files hold the protections: `server/src/services/fantasy/yahooRequestGuard.js` (single-flight, cache, backoff, circuit breaker), `yahooDraftPolling.js`, and `client/src/utils/draftPolling.js` (backoff, stopping polling on inactive pages). **Do not change Yahoo polling or these protections** unless the user explicitly asks.

## Offline models (not production)
- `backtest/` holds walk-forward backtesting (`runner.js`, `metrics.js`), the age-development model (`developmentModel.js`), historical importers (`importer.js`, `datasetAdapter.js`), and the team-context model (`teamContextModel.js`). Chronological train/validation/test evaluation is in `evaluation.js` (`--evaluate`). The CLI is `npm run backtest:historical` (in `server/`).
- So far these models are validated only on synthetic fixtures. They must not be imported by production code, deployed, or presented as proven improvements.
- Imports need an authorized provenance block (`authorized: true`). Brescou/NBA-dataset-stats-player-team is MIT-licensed, but commercial rights to its upstream data are **unverified** (the publisher has been contacted). Do not train on it, or ship anything derived from it, until those rights are confirmed. `sourcePolicy.js` enforces this whatever the import format; do not weaken it.

## Constraints
- $0 extra spend. Add no new dependencies unless needed. Keep diffs minimal and avoid rewrites.
- Preserve existing UI, features, and football functionality.
- Never fabricate data or accuracy claims. Do not change live rankings without backtest evidence.
- Never commit or log credentials (Yahoo, RapidAPI, Gemini, JWT, and DATABASE_URL live only in Render env vars).
- FantasyPros and Fantasy Nerds are product inspiration only. Do not scrape them, copy their rankings or algorithms, or use their data.

## Checks (run before committing)
```sh
npm install --prefix server && npm ci --include=dev --prefix client
cd server && npm test                       # node --test, all server tests
node --test client/src/utils/draftPolling.test.js client/src/components/basketballPlayerAvatar.test.js
npm run build --prefix client
git diff --check
# optional: SPORTS_DATA_TEST_DATABASE_URL=postgres://... runs sportsData Postgres integration tests
```
