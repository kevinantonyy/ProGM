# Ranking integration: feature flags, rookie input audit, diagnostic

Branch `feature/ranking-integration` (from `main` 2814601). Everything below is **off by default**; with no
environment variables set the app ranks exactly as production does today. Not merged, not deployed.

## 1. Flags (server-side only, no UI toggle)
| Variable | Values | Effect |
|---|---|---|
| `PROGM_RANKING_MODEL` | `v2` (anything else, unset or a typo = legacy) | v2 = draft value without the separate scarcity bonus (0.75 production, 0.20 replacement, 0 scarcity, 0.05 roster fit). Legacy = 0.70 / 0.20 / 0.05 / 0.05 |
| `PROGM_ROOKIE_ESTIMATES` | `on`, `true` or `1` (anything else = off) | Adds flagged, low-confidence, Yahoo-ADP-implied estimates for players with no NBA stat line |
| `PROGM_RANKING_DIAGNOSTIC` | `on` (else the route returns 404) | Enables the read-only comparison route in section 4 |

**Cache identity:** `rankingProfile()` (`<model>.<est|noest>`, e.g. `v2.noest`) is part of the frozen
baseline-reference key and of the workspace cache key, and a reference built under another model is ignored.
Switching a flag can therefore never serve one configuration's cached ranks to another.

## 2. Rookie inputs: what ProGM actually has at runtime
| Input needed by the researched draft-pick model | Available? | Source / evidence |
|---|---|---|
| NBA draft pick number / round | **No** | Not parsed from Yahoo (`normalize.js` keeps ADP, average round, ranks, position, team, status, uniform number) and not in the ESPN fields ProGM reads (`id`, name, team, position, headshot, `age`, `debutYear`). No draft field is in any fixture. |
| Historical rookie outcomes to fit/apply the pick curve | **No** | Would need the research dataset, whose licensing is unresolved; not available in production. |
| Height / weight | **No** | Not read from either source. |
| College statistics | **No** | Not read from either source. |
| ESPN `age`, `debutYear` | Only for players in the ESPN season-stats list, which has a 2025-26 stat line for veterans | A 2026 rookie has no 2025-26 row, so he is typically absent from that list. |
| Yahoo ADP (`average_pick`), average round, % drafted, Yahoo ranks | **Yes** | `draft_analysis` and `ranks` sub-resources already fetched for the draft pool (no extra requests). |
| Team, positions, injury status | **Yes** | Yahoo player resource. |

**Conclusion:** the draft-pick model **cannot be implemented honestly** today: its key input is not in any
existing integration. Nothing was added that assumes it. Only the ADP-implied fallback can run, and it is
treated as an estimate, not as a projection:
- inputs: Yahoo ADP only; calibrated, per request, on players who do have stat-based projections in the same
  pool (>= 40 players with >= 20 games, ADP-to-points slope must be negative, R^2 >= 0.25); no extrapolation
  beyond the calibrated ADP range; never negative; capped at the best calibration projection;
- output flagged `estimate: true`, `projectionMethod: market_prior_estimate`, confidence 0.3,
  `estimateBasis` = ADP and fit quality;
- **market comparisons are neutral** for estimates (VALUE/REACH, DRAFT NOW/WAIT, Yahoo-rank agreement),
  because the estimate is built from ADP;
- estimates are held in a **separate map** and are visible only to the Draft Helper and Rankings. Waivers,
  trades, lineup, start/sit and team rating keep using stat-based projections only;
- unrankable players keep an explicit `noDataReason` (including that ProGM has no draft position or
  historical data for such players, whether estimates are off, or why the ADP cannot be used).

## 3. Separation of baseline rank, projection and recommendations
Unchanged and tested: baseline `overallRank` (neutral roster fit, frozen full-pool reference) is separate from
projected fantasy points (`perGame`, `expectedGames`, `seasonPoints`) and from roster-aware
`draftPriority` and Draft Now / Wait (which use the board position). Empty roster keeps ProGM Rank equal to
Draft Priority in both models. The Rankings tab takes its `overallRank` from the same board rows
(`rankingModel` is also returned on both).

## 4. Read-only diagnostic
`GET /api/basketball/diagnostics/ranking-compare?leagueKey=&teamKey=&highlight=Name,Name`
(authenticated, needs `PROGM_RANKING_DIAGNOSTIC=on`).
- Reads only the workspace payload already in the in-memory cache for **the same user, league, team and
  current flags**; returns 409 if none is cached. It makes **no Yahoo or provider request** and writes nothing.
- Recomputes legacy and v2 value and rank from each row's own components, so both models see the same pool,
  projections and eligibility. Reports, for the top 50 by legacy rank: legacy rank, v2 rank, change, projected
  fantasy points per game, expected games, projected season points, eligible positions, and the production /
  replacement / scarcity points behind the value, plus players entering or leaving the top 50 and a
  C-eligible vs other mean rank shift. `highlight` looks up supplied names (for example Cade Cunningham,
  Bam Adebayo, Alperen Sengun) in the cached rows; nothing is hard-coded or preferred.
- Output has player names and numbers only: no league key, team name, roster or tokens (unit-tested).

## 5. Safe testing steps before merging
1. **Local, no Yahoo:** `cd server && npm test`; `node --test client/src/utils/*.test.js client/src/components/*.test.js`;
   `npm run build --prefix client`. (Tests cover flags, both models, cache identity, rookie isolation, diagnostic.)
2. **Flags off = production:** run the branch with no new variables; confirm the board and ranks match `main`
   (default tests pin legacy weights; the cache profile is `legacy.noest`).
3. **Diagnostic first (no ranking change):** on a non-production instance set only `PROGM_RANKING_DIAGNOSTIC=on`,
   sign in, open the Draft Helper **once** (the normal single workspace load), then call the diagnostic URL
   with `highlight=Cade Cunningham,Bam Adebayo,Alperen Sengun`. Review top-50 shifts and factors. Request
   counts to Yahoo do not change; the diagnostic adds none.
4. **Enable v2:** set `PROGM_RANKING_MODEL=v2`, restart (clears in-memory caches; keys are also model-specific),
   reload the Draft Helper once. Check the Rankings tab "ProGM Rank" equals the Draft Helper rank for the same
   players, that the data-basis text says "model v2", and that the diagnostic's v2 column matches the board.
5. **Rookie estimates (only after a UI label exists):** set `PROGM_ROOKIE_ESTIMATES=on`. Check estimated rows have
   `estimate: true`, confidence <= 0.3, neutral market labels, and that waivers/trades are unchanged.
6. **Rollback:** unset the variable(s) and restart; no data migration, no cache cleanup needed.

## 6. Blockers and decisions
- **Draft-pick rookie model: blocked** (no draft position, height or history at runtime; fitting data licence
  unresolved). Needs a sanctioned source of draft position first.
- **Rookie estimates are not user-visible as estimates yet.** The payload carries the flags but the UI does not
  show them (no UI change was made, as instructed). Do not enable `PROGM_ROOKIE_ESTIMATES` in production until
  a minimal "estimate" label is added.
- **v2 evidence:** supported by two independent backtests (height and position labels) and by the double-counting
  argument; it still needs your review of the diagnostic on a real league before merging.
- ADP-derived estimates make rookie placement partly market-driven; that is why market comparisons are neutral.
