# Historical backtest imports

This directory is offline-only. Imports never call a provider. Only use exports whose provenance explicitly confirms that ProGM is authorized to retain and use the data for commercial model development.

Supported formats:

- `json`: existing ProGM snapshot rows.
- `tabular-json`: flat rows using canonical field names or common NBA aliases.
- `csv`: the same flat contract. Empty cells remain `null`.
- `balldontlie-stats`: saved, paginated responses from BALLDONTLIE `GET /v1/stats`; regular-season game rows are aggregated into player seasons. DD/TD rates are derived from complete game stat lines. Age and experience remain `null` because this response does not document them.

Required provenance fields are `name`, `permission`, `acquiredAt`, and `authorized: true`. Recommended fields are `provider`, `datasetVersion`, `licenseUrl`, `sourceUrl`, and `exportId`. Put provenance inside JSON input or provide it separately with `--provenance` (required for CSV).

```powershell
cd server
npm run backtest:historical -- --data authorized-history.csv --format csv --provenance provenance.json --scoring league-scoring.json --model both
npm run backtest:historical -- --data balldontlie-export.json --format balldontlie-stats --provenance provenance.json --scoring league-scoring.json --model both
```

For custom flat columns, JSON input may include a `fieldMap` from ProGM canonical names to source column names. No adapter converts a missing statistic to zero.
