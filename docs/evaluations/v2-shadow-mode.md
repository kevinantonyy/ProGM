# v2 shadow mode (diagnostics only)

`PROGM_RANKING_SHADOW=on` makes the server build the v2 draft board (no separate center scarcity bonus) next to the
legacy board from the **same in-memory data of the same workspace build**, then compare them. Users keep receiving
the legacy board and every downstream view (Rankings tab, waivers, trades, lineup, start/sit) is built exactly as before.

## What it does
- Runs once per workspace build, after the legacy Draft Helper board exists, inside `buildBasketballWorkspace`.
  Inputs are the same `draftPool`, projections, availability and league settings; no Yahoo or provider call is added.
- Active only if `PROGM_RANKING_SHADOW` is `on`/`true`/`1` **and** the visible model is legacy **and** rookie estimates
  are off. Otherwise it does nothing. `rankingProfile()` (cache identity) is unchanged by the flag.
- Result goes to the in-memory cache under a per-user key (5 min TTL), never into the workspace response.
  Read it with `GET /api/basketball/diagnostics/ranking-shadow?leagueKey=&teamKey=` (needs `PROGM_RANKING_DIAGNOSTIC=on`;
  authenticated; no Yahoo call; no cache write).
- v2 uses its own frozen-baseline cache key (`v2.noest`), so it never reads or replaces the legacy reference.
- Any error is caught inside `runRankingShadow` and reported as `{ok:false, error:<ErrorClass>}`. The legacy path
  has already finished, so it cannot be affected. The sink call is also wrapped.
- Log line (counts and timing only): `[ranking-shadow] ok players=N top50=X/50 anomalies=K ms=T`.

## Comparison fields
`topOverlap` (25/50/100), `movers` (|change| >= 8, up/down), `byPosition` (per eligible position: mean/abs rank change,
top-50 counts, change by legacy rank band), `highlighted` (Cade Cunningham, Jalen Johnson, Bam Adebayo, Alperen Sengun, looked up by
name only), `crossCheck` (real v2 ranks vs the algebraic re-derivation used by `ranking-compare`; tolerance 2 ranks for
3-decimal rounding of published components), `anomalies` (pool-size difference, missing players, non-finite values,
duplicates, legacy top-50 players moving 25+ ranks). Player names and numbers only.

## Local test with your authenticated Yahoo league
Use a local server with local or throwaway storage (never the production `DATABASE_URL`), as in the earlier safe-validation steps.
```
cd server
PROGM_RANKING_SHADOW=on PROGM_RANKING_DIAGNOSTIC=on npm start
```
Leave `PROGM_RANKING_MODEL` and `PROGM_ROOKIE_ESTIMATES` unset. Sign in, open the Draft Helper once (a single workspace load).
Then, signed in as the same user (browser address bar works with the app's session; or use your auth header):
```
/api/basketball/diagnostics/ranking-shadow?leagueKey=<your league key>&teamKey=<your team key>
```
The server log shows the `[ranking-shadow]` line. If the workspace was already cached, add `refresh=true` to the normal
workspace request once (one normal Yahoo load, the same as any refresh).

Check: the visible Draft Helper board and Rankings tab are the legacy ranks you saw before; `visibleRankingModel` is `legacy`;
`ok: true`; `anomalies` is empty or explained; `crossCheck.mismatched` is 0.

Disable: stop the server and restart without the two variables (or set `PROGM_RANKING_SHADOW=off`). No data cleanup is needed;
the cached result is in memory and expires in 5 minutes.
Before sharing results, read the JSON: it holds player names and numbers only, but do not paste league or team keys.

## Not covered
The live-draft recommendations route (`/api/basketball/draft`) has no shadow; it still uses legacy only.
