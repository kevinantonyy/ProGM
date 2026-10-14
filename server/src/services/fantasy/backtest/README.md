# Historical backtest imports

This directory is offline-only. Imports never call a provider. Only use exports whose provenance explicitly confirms that ProGM is authorized to retain and use the data for commercial model development.

Supported formats:

- `json`: existing ProGM snapshot rows.
- `tabular-json`: flat rows using canonical field names or common NBA aliases.
- `csv`: the same flat contract. Empty cells remain `null`.
- `balldontlie-stats`: saved, paginated responses from BALLDONTLIE `GET /v1/stats`; regular-season game rows are aggregated into player seasons. DD/TD rates are derived from complete game stat lines. Age and experience remain `null` because this response does not document them.
- `brescou`: local `player/player_stats_traditionnal_rs.csv` plus `player/player_index.csv` from Brescou/NBA-dataset-stats-player-team. The adapter joins stable NBA player IDs, converts `SEASON` to its start year, preserves missing cells, and prevents traded-player aggregate/team rows from being counted twice.

Required provenance fields are `name`, `permission`, `acquiredAt`, and `authorized: true`. Recommended fields are `provider`, `datasetVersion`, `licenseUrl`, `sourceUrl`, and `exportId`. Put provenance inside JSON input or provide it separately with `--provenance` (required for CSV).

```powershell
cd server
npm run backtest:historical -- --data authorized-history.csv --format csv --provenance provenance.json --scoring league-scoring.json --model both
npm run backtest:historical -- --data balldontlie-export.json --format balldontlie-stats --provenance provenance.json --scoring league-scoring.json --model both
npm run backtest:historical -- --data authorized-history.json --rosters authorized-rosters.json --scoring league-scoring.json --model all
npm run backtest:historical -- --format brescou --data C:\data\player_stats_traditionnal_rs.csv --player-index C:\data\player_index.csv --provenance brescou-provenance.json --validate-only
```

Brescou imports are validation-only until upstream commercial-use and model-training rights are documented. The repository's MIT notice is not treated as proof that upstream NBA statistics may be used commercially. A future backtest requires both `commercialModelTrainingAuthorized: true` and a non-empty `rightsEvidenceUrl` in provenance; do not set these without verified permission. The source has per-game traditional stats and season totals for DD2/TD3. Static position and debut year come from `player_index.csv`; it does not provide historical position changes.

For custom flat columns, JSON input may include a `fieldMap` from ProGM canonical names to source column names. No adapter converts a missing statistic to zero.

Team-context roster files contain `rows`, explicit `teamSeasons` completeness declarations, and the same required provenance block as historical imports. Every target-season row must attest `knownBeforeSeason: true`; otherwise that fold receives a neutral adjustment to prevent later transactions leaking into a preseason backtest. Target-season games/minutes are never used as features. Teams not explicitly marked `complete: true`, missing positions, missing prior minutes, or folds without enough historical transitions also receive a neutral team-context adjustment.

## Chronological evaluation

`--evaluate` runs `evaluation.js`. Seasons are split chronologically into train, validation, and test (defaults: the last season is test, the one before it is validation, and at least 2 seasons are train; override with `--validation-seasons`, `--test-seasons`, `--min-train-seasons`). Each target season is predicted by a fold fit only on earlier seasons (rolling origin). The model with the lowest validation fantasy-points-per-game MAE is selected before test seasons are scored, and test results never feed back into selection. Every model, including `last_season_stat_line` (the production preseason baseline), is scored on the same player-seasons that all models predicted. The report includes MAE, RMSE, bias (predicted minus actual), Spearman rank correlation, sample sizes, per-season results, and an order-independent SHA-256 `dataFingerprint` of the input.

```powershell
npm run backtest:historical -- --data authorized-history.json --scoring league-scoring.json --evaluate
```

Licensing gate: `sourcePolicy.js` marks an import as restricted when the provenance names Brescou, player IDs carry the `brescou:` prefix, or the raw rows keep Brescou/NBA.com stats column signatures, whatever `--format` was used. Restricted snapshots can only be imported with `--validate-only`; `runWalkForwardBacktest` and `runChronologicalEvaluation` refuse them unless provenance has `commercialModelTrainingAuthorized: true` and a `rightsEvidenceUrl`. A deliberately relabelled export cannot be detected, so provenance must stay truthful.

## BALLDONTLIE acquisition (offline research only)

`balldontlieAcquisition.js` fetches per-game rows from the stats endpoint into the saved-response format that `--format balldontlie-stats` imports. Before any request it requires `BALLDONTLIE_API_KEY` in the environment and an authorization file with `acquisitionAuthorized: true`, `name`, `permission`, `subscriptionTier`, and `termsReviewedAt`. Runs are capped by page count (default 1, at most 500) and rate-limited (default 5 requests/min), back off on HTTP 429, never overwrite an existing output file, and never write the key to output. An export cut off by the page cap is marked `complete: false`, and the importer refuses it. When aggregating to seasons, the importer drops postseason rows and did-not-play rows (0 minutes).

```powershell
$env:BALLDONTLIE_API_KEY = "<key>"
node src/services/fantasy/backtest/balldontlieAcquisition.js --authorization bdl-authorization.json --seasons 2023 --out bdl-2023.json --max-pages 1 --rpm 5
```

Provider facts as of 2026-10-14. The docs and terms pages could not be loaded from the development sandbox, so these come from search excerpts; re-check them before relying on them:
- Tiers: Free (5 requests/min, $0), ALL-STAR (60 requests/min, $9.99/mo), and GOAT (600 requests/min, $39.99/mo), per sport. Game player stats require ALL-STAR or higher. Season averages are GOAT-only, which is why this adapter aggregates per-game rows instead.
- Pagination: cursor-based (`meta.next_cursor`); `per_page` defaults to 25, maximum 100.
- Unverified: whether the NBA stats path is `/v1/stats` or `/nba/v1/stats` (use `--base-url`), whether `seasons[]` filters the stats endpoint, and how far back historical coverage really goes. Check all three with a one-page run.
- Terms summary: commercial use, storage and caching, and AI/model training appear to be permitted. Building a competing product and reselling unmodified data are prohibited. Data is provided "as is" with no accuracy guarantee. The docs also say "We do not store historical data", which is unclear next to the terms. These permissions do not raise tier or rate limits. Have a person review the full terms and record that review in the authorization file; this summary is not legal advice.
- Season lines from this source have no age or experience, so the age-development model's age curve has no effect on this data.

## Brescou licensing assessment (2026-10-14)

Status: **unverified; no import or training.** The gate stays on.

- Coverage: regular-season traditional stats for 1996-97 to 2022-23 (27 seasons; `player/player_stats_traditionnal_rs.csv`, about 3.7 MB) plus `player/player_index.csv`. These are season-level per-game lines per player and team, not game logs.
- Fantasy fields present: GP, MIN, PTS, REB/OREB/DREB, AST, STL, BLK, TOV, PF, FGM/FGA, FTM/FTA, FG3M/FG3A, and DD2/TD3 season totals; AGE; FROM_YEAR (gives experience); static POSITION. Missing: game-level rows (dates, back-to-backs, injuries, rest), historical positions, and any projections.
- Provenance evidence: the README says only "drawn from NBA game statistics" and names no source. The headers exactly match NBA.com stats endpoints (`leaguedashplayerstats`, with its `*_RANK`, `NBA_FANTASY_PTS` and `WNBA_FANTASY_PTS` columns, and `playerindex`, with `PLAYER_SLUG`, `STATS_TIMEFRAME` and `ROSTER_STATUS`). The upstream source is therefore almost certainly stats.nba.com.
- Why MIT is not enough: the repository's MIT licence can only grant rights the publisher holds. It does not show that NBA.com's terms permit storing the statistics or using them for commercial model training. NBA.com's terms could not be loaded or verified.
- Evidence needed to proceed (either is enough): written permission from the NBA (or a licensed distributor) for commercial storage and ML use; or a reply from the Brescou publisher showing an upstream licence that covers it. Record it as `commercialModelTrainingAuthorized: true` plus `rightsEvidenceUrl` in the provenance file.
- Ready once rights exist: `npm run backtest:historical -- --format brescou --data <stats.csv> --player-index <index.csv> --provenance <provenance.json> --scoring <scoring.json> --evaluate`. Tests run this exact path on synthetic data in the real column layout.
