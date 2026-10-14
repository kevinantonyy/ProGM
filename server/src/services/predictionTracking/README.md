# Prediction tracking (foundation)

Records ProGM's own fantasy-point predictions so accuracy can be measured later. It is **not wired into any recommendation path**; nothing calls it yet. It stores no provider data and collects no outcomes.

## Record

| Field | Notes |
|---|---|
| `playerId` | Opaque ProGM identifier (letters, digits, `: . _ -`). Names and provider payloads are rejected by validation. |
| `targetDate`, `targetGameId?`, `targetStartsAt?` | One prediction target. `targetKey` is the game id when present, otherwise the date. |
| `predictedFppg` | Predicted fantasy points per game, finite, -100 to 200. |
| `modelVersion` | Required, e.g. `progm.projection.v1`. |
| `scoringConfigId` | `sc1_` + a truncated SHA-256 of the sorted `(statId, pointValue)` pairs of enabled categories. It carries no league name, id, or settings. A common scoring set can still be recognized by hashing the same set, so treat it as an opaque label, not a secret. |
| `createdAt` | Assigned by the server clock (Postgres `clock_timestamp()` in production); callers cannot set it. |

One record exists per `(playerId, targetKey, modelVersion, scoringConfigId)`.

## Integrity rules

- **Before the target.** With `targetStartsAt`, `createdAt` must be earlier. With only a date, the date must be after today (UTC), because tip-off time is unknown. The application checks this and Postgres `CHECK` constraints repeat it.
- **Append-only.** Re-submitting an identical prediction changes nothing (the original timestamp is kept). A different value for an existing key is rejected with "cannot be overwritten". In Postgres, triggers block `UPDATE`, `DELETE` and `TRUNCATE`.
- **Atomic batches** (up to 1,000). One bad record rejects the whole batch.
- **Accuracy guard.** `computeAccuracy` excludes any record that does not pre-date its target, in case records were imported or tampered with.

## Use

```js
import { recordPredictions, scoringConfigId } from './predictions.js';
import { PostgresPredictionStore } from './stores.js';   // table pt_predictions, created lazily on first use
import { computeAccuracy } from './accuracy.js';          // pure: predictions + caller-supplied outcomes
```

`computeAccuracy({ predictions, outcomes })` matches on `(playerId, targetKey, scoringConfigId)` and reports MAE, RMSE and bias (`mean(predicted - actual)`, positive means over-prediction), overall and by model version, scoring configuration and month. It also reports exclusions and unmatched outcomes.

## Attaching actual results later (not implemented)

1. Pick a source whose terms permit storage and commercial use. Register it with `sportsData/sourcePermissions.js`; the registry refuses NBA.com, ESPN, Yahoo and Sports Reference without written permission.
2. Get actual game stats from that source and score them with `scoreStatLine` and the league's own categories. The `scoringConfigId` of the outcome must equal the prediction's.
3. Keep outcomes in a separate, authorized store (for example `sd_player_game_stats` in `sportsData`), never inside `pt_predictions`, which stays append-only. Map each outcome to `{ playerId, targetKey, scoringConfigId, actualFppg }`, using the same opaque player ids.
4. Run `computeAccuracy`. Compare model versions on the same matched targets and keep sample sizes in view; small samples are not evidence of accuracy.

Player identity needs a reviewed mapping between ProGM's opaque ids and the outcome source's ids (no name matching).

## Retention review: ESPN league snapshots (report only, nothing deleted)

`espn_connections.league_data` (JSONB, `routes/espn.js`) stores the full processed result of `fetchLeague` for each user and sport. It is rewritten on `/connect` and again whenever `/workspace/:sport` refreshes a stale copy.

Contents: every team's roster; the available player pool; per-player ESPN projections, actual points, ownership and start percentages, rank, injury status and headshot URLs; the schedule and matchups; transactions; draft picks; and league settings.

Concerns:
1. **Long-term storage of ESPN-derived data.** The snapshot has no TTL and no deletion path (`espn_connections` has no DELETE route; rows are only removed if the user row is deleted, via `ON DELETE CASCADE`). The ESPN endpoints are undocumented public ones and ESPN has granted no storage licence. Storage and commercial use are unverified. The Phase 9 registry treats ESPN as restricted for this reason.
2. **Other people's data.** Snapshots hold other teams' rosters and transactions from leagues the user can see, including team names and logos. That is personal-ish league data for users who never agreed to ProGM storing it.
3. **Projections as a training set.** The snapshot contains ESPN's own projections. Keeping them over time (or training on them) would be building a dataset from ESPN's proprietary predictions; do not do that without permission.
4. **No disconnect or erasure path.** Users cannot delete their snapshot without deleting the account.
5. **Mitigations to consider (not done here):** prefer keeping only the settings and roster names ProGM needs; add a retention window and a disconnect endpoint; and confirm ESPN's terms. Prediction tracking is designed so it never needs this data.

## Not covered here

Production hooks that call `recordPredictions`, any scheduler, outcome collection, a public API and football.
