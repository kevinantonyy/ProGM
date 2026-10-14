# Internal sports data store

The groundwork for ProGM's own provider-independent NBA data, and later a public API. Nothing here is used by production projections, Yahoo features, or the UI. The HTTP surface is internal, read-only, admin-only, and disabled by default.

## Architecture

```
authorized source batch ──► ingest.js ──► store (Postgres | memory) ──► routes/sportsData.js (internal GET)
   (adapter output)          │                                     └─► exportHistoricalSnapshots ──► backtest/evaluation.js (Phase 8)
                             ├─ sourcePermissions.js  (documented rights required; restricted providers refused)
                             └─ schema.js             (normalization, validation, content hashes)
```

- `schema.js`: normalized records for `teams`, `players`, `games`, and `playerGameStats`. Records are keyed by `(sport, sourceKey, externalId)`. Basketball is implemented; `football` is reserved (it is refused with "not implemented", and the routes return 501). Stat keys reuse the provider `StatLine` vocabulary. Missing values stay `null`.
- `sourcePermissions.js`: a source must be registered with `licenseName`, an https `licenseUrl`, `termsReviewedAt`, `reviewedBy`, and explicit booleans for `storage`, `commercialUse`, `modelTraining`, `redistribution`, and `publicApi`. Ingestion needs `storage` and `commercialUse` both set to true. Sports Reference, NBA.com/`nba_api`, ESPN, Yahoo, and Brescou-derived data are refused unless a `writtenPermissionUrl` is recorded. The stored registration is re-validated on every ingestion. Exporting data for model evaluation also needs `modelTraining`.
- `ingest.js`: `registerSource`, `ingestBatch`, and `exportHistoricalSnapshots`.
  - Each batch is normalized, deduplicated in-batch (identical duplicates collapse, conflicting ones fail), checked for references (games→teams, stats→games/players/teams, and the stat's team must have played in that game), then upserted in one transaction.
  - Content hashes make re-ingestion idempotent and incremental: rows are inserted, updated, or left unchanged.
  - Every run, including failures, is logged in `sd_ingestion_runs`.
  - Batches are capped at 50,000 records.
- `postgresStore.js`: tables `sd_sources`, `sd_teams`, `sd_players`, `sd_games`, `sd_player_game_stats`, and `sd_ingestion_runs`. Key columns are typed and indexed, with the full record in JSONB. Foreign keys enforce integrity at the database level. The schema is created lazily on first authorized use, never at app startup. All queries are parameterized and use byte-order (`COLLATE "C"`) sorting for deterministic pagination.
- `memoryStore.js`: the reference implementation of the same interface, used by tests and offline tooling. An integration test checks that it matches Postgres exactly.

## Internal endpoints

Mounted at `/api/internal/sports-data`. All of them return **404 unless `ENABLE_SPORTS_DATA_API=true`**. Every request then needs a valid ProGM JWT **and** a user id listed in `SPORTS_DATA_ADMIN_USER_IDS` (comma-separated; an empty list denies everyone). Only GET is allowed; other methods get 405. Responses are sent with `Cache-Control: no-store`.

| GET | Filters |
|---|---|
| `/sources` | none |
| `/ingestion-runs` | `limit` |
| `/:sport/teams` | `sourceKey` |
| `/:sport/players` | `sourceKey`, `search` |
| `/:sport/games` | `sourceKey`, `season`, `seasonType`, `teamId` |
| `/:sport/players/:playerId/games` | `sourceKey`, `season`, `seasonType` |
| `/:sport/games/:gameId/stats` | `sourceKey` |

Paginate with `limit` (1–200, default 50) and `offset`. Ingestion is not exposed over HTTP.

## Connecting a future authorized source

1. **Verify rights first.** Read the provider's official terms. Confirm storage, commercial use, and (for evaluation) model training. Record the review in a source registration. Do not register a source because its data is publicly accessible.
2. **Write an adapter** that turns saved provider responses into a batch: `{ sourceKey, sport, teams, players, games, playerGameStats }`. It should use the provider's own stable IDs, keep missing values as null, and do no network access in tests. Acquisition stays separate, gated and rate-limited, like `backtest/balldontlieAcquisition.js`.
3. **Ingest** with `registerSource` and then `ingestBatch`. **Evaluate** with `exportHistoricalSnapshots`, then `runChronologicalEvaluation`.

Candidates still awaiting verification (not integrated):
- **Wikipedia + Wikidata.** Wikipedia text is CC BY-SA 4.0 (commercial use allowed with attribution, under the same licence). Wikidata is believed to be CC0. Player-season tables have per-game PTS, REB, AST, STL and BLK and shooting percentages, but no turnovers, 3PM, made/attempted counts, or game-level rows. They would need a season-level path (Phase 8 CSV import) rather than `playerGameStats`, plus legal sign-off on share-alike. Wikidata can supply `birthDate` and stable player IDs.
- **API-NBA (API-Sports) free plan.** It has game-level player stats that fit `playerGameStats` directly, but its commercial terms and card requirements are unverified, and 100 requests/day makes historical backfill slow.
- **BALLDONTLIE.** Its terms appear to allow commercial and ML use, but game stats need a paid plan, which is not allowed under the $0 budget. The saved-response adapter could be extended to emit batches if a free grant is ever obtained.

Cross-provider identity linking (one canonical player across sources) is deliberately deferred. It needs a reviewed mapping table, not name matching.

## Historical game logs (Phase 12B)

- `gameLogAdapter.js`: turns a player game-log export (CSV, or JSON rows in NBA-style lowercase columns or with a `fieldMap`) into one `ingestBatch` batch per season.
  - The caller must say how the file labels seasons (`seasonLabel: 'end' | 'start'`), and each label is checked against the game dates.
  - Only regular-season games are kept, by game type or NBA game-id prefix `002`.
  - Rows with no player name and games with only one team's players are skipped and counted.
  - Identical duplicate rows collapse; conflicting duplicates fail.
  - Total rebounds are filled in from offensive + defensive rebounds when missing.
- `gameLogImport.js`: `importGameLogRows(store, { rows, source, seasonLabel })` registers the source (permission-gated), then ingests season by season. Each season is one atomic, idempotent batch, so re-running only adds or updates what changed. CLI: `node src/services/sportsData/gameLogImport.js --data logs.csv --source source.json --season-label end`, then `--evaluate --source-key <key> --scoring scoring.json`. Parquet files must be converted to CSV first (for example with the DuckDB CLI); no Parquet dependency is added.
- `gameLogEvaluation.js`: game-level fantasy-point evaluation of stored logs.
  - Each game is predicted only from the player's games on earlier dates; same-day games are not visible.
  - Seasons are split chronologically. Train seasons only supply history, the recency-blend settings are chosen on validation seasons, and test seasons are scored once.
  - The baseline is the player's previous-season mean, as in the production preseason projection.
  - Models are compared on identical games, with MAE, RMSE and bias overall and per season.
  - It refuses sources without the `modelTraining` permission.
- Team records are per source, not per season, so the latest ingested abbreviation wins.

Source status (2026-10-14): no source of historical NBA game logs has verified permission for storage and commercial ML use. Nothing real has been imported.
- `llimllib/nba_data` has no licence and republishes stats.nba.com, ESPN and basketball-reference data.
- Brescou is season-level only and NBA.com-derived.
- NBA.com's terms reserve its basketball content, statistics included, against reproduction or reuse without written permission.

The registry refuses all three without a `writtenPermissionUrl`. Keeping the database private does not remove those upstream restrictions.

## Maintainer consent log (Phase 13)

**Maintainer permissions (recorded 2026-10-14, confirmed by the ProGM owner):** the maintainers of both repositories approved using their datasets for ProGM's private historical database and for machine-learning model training.

| Repository | Maintainer permission | Scope |
|---|---|---|
| github.com/Brescou/NBA-dataset-stats-player-team | Approved | Private database storage; ML model training |
| github.com/llimllib/nba_data | Approved | Private database storage; ML model training |

Verbatim replies as supplied by the owner. Which repository sent which reply was not specified:
- "Yes, Kevin this repo is open for use and you can store the data in your own database if needed"
- "Hi Kevin, Yes you can use this repo for your app to store the historical statistics in a private database and using them to train a machine-learning model for player performance predictions"

Not covered by these permissions: redistribution or a public API, and rights held upstream (NBA.com for both datasets' statistics; ESPN and basketball-reference for other llimllib tables). **Upstream status: unresolved.** The ingestion and training gates remain closed.

To record a reply, add the verbatim text, its date, the sender's account or address, and a link or archived copy. Do not paraphrase or widen its scope.

Maintainer consent covers what the maintainer owns: their compilation, code and publication. It does not grant rights held upstream. The relevant upstream holders are:
- **NBA.com / stats.nba.com:** the source of Brescou's tables and of llimllib's player game logs. NBA.com's terms (partial excerpt) say its basketball content, statistics included, may not be reproduced or used without written permission.
- **ESPN and basketball-reference:** these appear in llimllib's other tables, which ProGM does not need. Sports Reference explicitly bans AI training.

Therefore:
- Record maintainer consent in the source's `permission` text only.
- Set `writtenPermissionUrl` (sportsData), or `commercialModelTrainingAuthorized` plus `rightsEvidenceUrl` (backtest), **only** for evidence that covers the upstream data. That means a grant from the NBA or a licensed distributor, or a written legal determination by ProGM's owner and counsel that the intended use of these statistics is permitted.
