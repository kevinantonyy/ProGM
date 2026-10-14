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
