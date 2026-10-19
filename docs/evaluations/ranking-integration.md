# Ranking integration: feature flags, rookie input audit, diagnostic

Branch `feature/ranking-integration` (from `main` 2814601). Everything below is **off by default**; with no
environment variables set the app ranks exactly as production does today. Not merged, not deployed.

## 1. Flags (server-side only, no UI toggle)
| Variable | Values | Effect |
|---|---|---|
| `PROGM_RANKING_MODEL` | `v2` (anything else, unset or a typo = legacy) | v2 = draft value without the separate scarcity bonus (0.75 production, 0.20 replacement, 0 scarcity, 0.05 roster fit). Legacy = 0.70 / 0.20 / 0.05 / 0.05 |
| `PROGM_ROOKIE_ESTIMATES` | `on`, `true` or `1` (anything else = off) | Adds flagged, low-confidence, Yahoo-ADP-implied estimates for players with no NBA stat line |
| `PROGM_RANKING_DIAGNOSTIC` | `on` (else the route returns 404) | Enables the read-only comparison route in section 4 |
| `PROGM_DRAFT_STATUS` | `on`, `true` or `1` (anything else = off) | Experimental, display only: Yahoo designations and league availability on Draft Helper rows (see "Draft-board status display" below). Never changes rank or value |
| `PROGM_DRAFT_PREVIEW` | `on`, `true` or `1` (anything else = off, endpoint returns 404) | Read-only Draft Preview of a completed Yahoo draft: `GET /api/basketball/draft-preview` ranks the whole league pool (Yahoo status A + T, cross-checked against the draft results) with the existing Draft Helper engine. Uses its own `bball:preview:` cache namespace. If the pool cannot be verified as complete the page says so and does not claim full-pool ranks |
| `PROGM_TANK01_ENABLED` | `on`, `true` or `1` (anything else, including unset, = **off**) | Master switch for Tank01 (a paid RapidAPI service). **Off by default: with it unset or false NO request is ever sent to Tank01 from any code path** (player list, injury list, team schedules, per-player stats), even if `RAPIDAPI_KEY` is set; a key alone never enables it. ProGM then uses ESPN, the NBA CDN and cached data only. Enforced in two places: the provider is not selected, and the single Tank01 HTTP function refuses to send. It does not affect ESPN, the NBA CDN or cached data. Turning it on can spend paid quota; ProGM cannot see your RapidAPI plan, billing or overage settings, so this is a request switch, not a spending guarantee |
| `PROGM_TANK01_PLAYER_BUDGET` / `PROGM_TANK01_PLAYER_DAILY_BUDGET` | non-negative integers per hour / per 24h. **Default 0/0 = per-player Tank01 fallback DISABLED**; unset, blank or invalid also means 0; both must be set to enable | Only relevant when `PROGM_TANK01_ENABLED` is on. Caps UNCACHED per-player stats lookups to Tank01, used only when ESPN's league-wide feed fails. Set them only to limits you have verified against your RapidAPI plan and overage settings. Cached players are always free and still served (even expired); ESPN bulk data is unaffected. Draft Preview never uses this fallback. When Tank01 is enabled, its other calls (player list, injury list, 30 team schedules) are NOT covered by this budget; they run only as a fallback when ESPN/NBA CDN fail |

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

## 7. "Estimated" badge (client)
- `EstimateBadge` (shared, `client/src/components/EstimateBadge.js`) renders a small "Estimated" badge with tooltip
  "Estimate based on Yahoo ADP. Low confidence, and not an independent statistical projection. Value/Reach and
  Draft Now/Wait comparisons are not shown for it." It appears next to the player name in **both** the Draft
  Helper table and the Rankings tab, only when the server sends `estimate === true` (strict check).
- For estimated players the Draft Helper recommendation cell shows "—" (tooltip explains) instead of "Fair Value";
  the server already forces `marketLabel: neutral`, `adpVsProgm: null` and Yahoo-rank agreement `unknown`.
- Verified: unit tests (render-to-markup; only `true` shows it), a server test that board and Rankings flag the
  same players, and a headless-Chromium run of the built client with the API mocked by real server output
  (72 players, 2 estimates): badges on exactly the 2 estimated rows in both tabs, none on the other 70, count
  stayed 2 -> 2 -> 2 across Rankings -> Draft Helper -> Rankings, no page errors. With the flags off no row has
  `estimate`, so no badge renders.

## 8. Diagnostic on real cached Yahoo data
**Not possible here.** No server process, database or Yahoo tokens exist in this environment, and the
workspace cache is in-memory in the running server, so there was no real cached league to read. No Yahoo or
provider request was made. The diagnostic route was exercised only with synthetic cached payloads. As a stand-in,
the same comparison code was run on the offline 2025-26 stat pool (assumed default Yahoo scoring, simplified
lineup, coarse G/F/C eligibility; it is not any user's league):

| Player | Positions | Legacy | v2 | Per game | Exp. games | Season pts |
|---|---|---|---|---|---|---|
| Alperen Sengun | SF/PF/F/C | #5 | #8 | 43.9 | 60.1 | 2639 |
| Cade Cunningham | PG/SG/G | #9 | #7 | 48.6 | 58.6 | 2847 |
| Bam Adebayo | SF/PF/F/C | #10 | #15 | 40.8 | 60.3 | 2461 |

Factors (value points): Sengun and Bam lose 4.9 scarcity points under legacy removal and gain ~3.5 production
points from the moved weight; Cade loses 0.2 and gains 3.8. Top-50 overlap 47 of 50. In the legacy top 50
(n=50): C-eligible players move -8.5 ranks on average (n=17), others +3.8 (n=33). Entering the top 50: Bane,
Daniels, Castle; leaving: Gobert, Sarr, Vucevic. (Across all 418 pool players C-eligible players average -34 and others +14, inflated by
the coarse labels that make 29% of the pool "C-eligible".)
Exact steps to run it on the real league are in section 5.

## 9. Real-league validation from a saved workspace response (no database, no tokens, no new requests)
Supersedes the local-server procedure. `node server/scripts/snapshotCompare.mjs <saved-response.json> [outDir]`
reads ONE local file and touches nothing else: no database, no environment variables, no network, no Yahoo.

**Is an existing snapshot enough?** The `/basketball/workspace` response your browser already receives contains,
for every player in the Draft Helper pool, the components both models need (production, replacement, VORP,
scarcity, per-game points, expected games, season points, confidence factor), eligible positions and ranks, plus
the unprojected players with their ADP and the Rankings tab list. So **legacy vs v2, the top 50, positional
shifts and Rankings/Draft Helper parity can be reproduced exactly** from it, with identical scoring, pool,
eligibility and projections for both models by construction.
**Not reproducible from a flags-off production response:** the exact rank/value an estimated rookie would get
inside the board (that needs the raw projection inputs) and the badge on real rows. The script instead reports,
from the same file, which unprojected players the fallback would estimate, the implied points per game and an
approximate position by projected season points (labelled approximate). Exact rookie placement and the badge on
real names would need one flagged run later (separate decision).

**Capture (about 2 minutes, zero extra requests):**
1. Open the production app normally and load Fantasy Basketball > Rankings once (the request you would make anyway).
2. DevTools > Network > click the `workspace` request > Response tab > select all and copy (or right-click >
   Copy > Copy response). Copy the **response body only**; do not use "Save all as HAR" or "Copy as cURL",
   which include the Authorization header.
3. Paste into a local file, e.g. `~/workspace-response.json`. It contains private data (roster, league name):
   keep it local and delete it afterwards.

**Run (needs only Node 20 and this branch, no .env):**
```
git checkout feature/ranking-integration && cd server
node scripts/snapshotCompare.mjs ~/workspace-response.json ~/progm-out
```
It prints a summary and writes `progm-sanitized-snapshot.json` and `progm-ranking-comparison.json`.

**What the sanitizer keeps / drops:** keeps only per-player public numbers (name, eligible positions, ranks, ADP,
component numbers, projection flags, draft status). Drops team and league names, ids and keys, tokens, roster,
standings, ownership and availability, and does not write the Rankings list to disk (board minus Rankings would
reveal your roster; the parity check is done in memory and reports counts only). Open both output files and
read them before sharing.

**Share:** the two output files, plus any note on things that looked wrong. Do not share the raw response, the
HAR, or any URL containing league or team keys.

## 7. Account-scoped v2 (`PROGM_RANKING_V2_USER_IDS`)
- Comma/space separated numeric ProGM user ids (see `GET /api/auth/me`). Listed accounts get the v2 model; all others get the global
  model, which is legacy unless `PROGM_RANKING_MODEL` is set (keep it unset). Non-numeric entries, `*`, `all` etc. are ignored (never a wildcard).
- Applies per request to: the workspace (Draft Helper, Rankings tab), the live-draft route, the workspace cache key, the frozen
  baseline reference key, and the diagnostics cache keys (`rankingProfileForUser`). Rookie estimates are unaffected (still off unless `PROGM_ROOKIE_ESTIMATES`).
- Shadow mode only runs for accounts whose visible model is legacy.
- Rollback: delete the variable and let Render restart. Nothing is persisted; caches are in memory.

## Draft-board status display (`PROGM_DRAFT_STATUS`, experimental, default off)
- Display only. `withPlayerStatus()` (`playerStatus.js`) runs after the draft board, shadow comparison and Rankings tab are built and
  only adds fields; row order, ranks, values and recommendations are byte-identical (tested on a fixture and on a saved real board).
  The draft board does not use Yahoo status at all today, and this change adds no status multiplier.
- Each row gains `leagueAvailability` (`available` / `rostered` / `unknown`: rostered in this Yahoo league or not, nothing about
  health) and `playerStatus` `{ code, state, label, note, source: 'yahoo', observedAt }`. `code` is Yahoo's raw code. `state` is
  `inactive` (NA), `out` (O, OUT, INJ, IL, IL+, IR, OFS), `doubtful`, `questionable` (Q, GTD, DTD, P), `suspended`, `none` (Yahoo shows no
  designation; not a confirmation of health) or `unknown` (a code ProGM does not recognise). No reason is inferred for NA.
- Both the workspace and live-draft recommendation boards receive the same fields, including rows without projections. Annotations
  run after valuation and drafted-player exclusion. Flag off preserves the original board shape and existing OUT badge.
- `observedAt` preserves receipt time of the status-bearing Yahoo ownership page or roster response. Cached live pools retain those
  per-player times; older entries without them use their existing cache fetch time, never the current poll time. Unknown times stay null.
  The board shows its oldest known player time (null if any is unknown), and explicitly marks stale-cache fallback even within the six-hour window.
  Yahoo gives no timestamp for when a designation was set, so this is fetch freshness only.
- `statusData.injuryReports` distinguishes a successful empty feed (`available: true, count: 0`) from unavailable, malformed, stale or
  historical-inapplicable data. Warnings explain the difference without claiming that an empty list confirms health. This metadata does
  not change scoring, projections or expected games.
- Flag-on workspaces use a `.status` cache-profile suffix; flag-off keys remain unchanged. The ranking diagnostic reads the matching
  key. Ranking/baseline reference keys are unchanged because this feature never changes rank.
- Badge and warning text use semantic light/dark colors; scoped badge backgrounds keep small text above 4.5:1 contrast. Endpoint,
  provider, cache and client tests use synthetic data only. No extra Yahoo requests or polling are added.

## Diagnosing missing projections: ESPN season-stats probe

`GET /api/diagnostics/free-nba?probe=espn-stats[&season=2026]` (authenticated, and only when `ENABLE_FREE_NBA_DIAG=true`) makes exactly one request to the same ESPN season-stats endpoint the projection provider uses and returns aggregates only: HTTP status, content type, bytes, elapsed ms, whether the JSON is valid, athlete count, usable-stat count, process memory, and an error category (`timeout`, `network_error`, `forbidden`, `rate_limited`, `server_error`, `http_error`, `response_too_large`, `not_json`, `unrecognized_shape`, `no_athletes`, `no_usable_stats`). `season` is the Yahoo league season (default: the current one); the probe requests the previous season's stats, exactly as the projection pipeline does.

It never calls Yahoo or Tank01, does not touch provider caches, breakers or counters, has a 12 s timeout and a 12 MB response cap (the real response is about 7.7 MB), is single-flight, and refuses a repeat within 15 s. Without `probe=` the route behaves as before (three lightweight reachability checks).

## Yahoo stat ids used for points projections

`YAHOO_STAT_TO_STATLINE` (`server/src/services/fantasy/scoring.js`) maps a league's weighted Yahoo stat ids to the per-game stat line. Ids **3 = FGA, 4 = FGM, 6 = FTA, 7 = FTM, 10 = 3PTM, 12 = PTS, 15 = REB, 16 = AST, 17 = ST, 18 = BLK, 19 = TO** are confirmed by a real Yahoo H2H points league's settings. Ids 13, 14, 21, 27, 28 (OREB, DREB, PF, DD, TD) are not confirmed by that league. Ids 5 and 8 were once mapped to FGA/FTA by mistake and are deliberately **unmapped**: a league weighting an unmapped id gets an explicit incomplete projection that names the stat, never a guess and never a zero. A single missing weighted stat makes that player's projection unavailable by design.
