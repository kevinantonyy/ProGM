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
