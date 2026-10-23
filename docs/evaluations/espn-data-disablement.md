# ESPN data disablement and the external data-source policy

Branch `release/espn-disable`, built on PR #8's head (`874c7cd`). Local only: not pushed, merged or deployed. No Render setting, environment variable, database row or user account was touched or deleted.

**Why:** ESPN wrote: "We are not interested in licensing data at this time and decline to permit the use of any of our API data." Until that changes, ProGM must not call ESPN, serve data cached from it, or fall back to another source on its behalf.

## The policy (default-deny, reversible)

`server/src/services/dataSources/policy.js`. A source is on only when its switch is exactly `allow` (case and surrounding spaces ignored). Switches are read when used; a changed value takes effect when the service restarts, which Render does on any environment change.

| Source | Switch | Hosts | Default |
|---|---|---|---|
| ESPN | `PROGM_DATA_ESPN` | `espn.com`, `espncdn.com`, `espnstatic.com` (every subdomain) | **off** |
| NBA.com | `PROGM_DATA_NBA_COM` | `nba.com` (`cdn.nba.com`, `stats.nba.com`) | **off** |
| Tank01 | `PROGM_DATA_TANK01` | `rapidapi.com` | **off**; also still needs `PROGM_TANK01_ENABLED` and `RAPIDAPI_KEY` |

Yahoo and Gemini are not part of this policy (consent and `aiDataPolicy` govern them). Nothing was deleted, so re-enabling a source later is one environment value (and a restart), with no code change.

## Where it is enforced

1. **Every outbound request.** `guardedFetch()` is the only route to those hosts. It throws `SourceDisabledError` before any request, counter or timer. All seven former raw `fetch` call sites use it (ESPN league and news routes, the two probes, the ESPN/NBA CDN provider, the stats.nba.com provider, Tank01).
2. **ESPN routes.** `/api/espn/*` answers 503 before authentication, database access or any request, including the previously unauthenticated `POST /preview`. `GET /api/espn/availability` is a static answer (no database, no request) for the client.
3. **Orchestrator.** `candidateProviders()` lists a provider only if its source is allowed. A policy refusal is not a provider failure (no circuit breaker trips). Nothing replaces a disabled source: Tank01 needs its own switch, NBA.com is separate, and `FREE_NBA_PRIMARY=false` no longer keeps ESPN as a "last resort".
4. **Cache.** An entry from a disabled provider (or derived from one) is never stored, never served as fresh or stale, and is released by the periodic sweep.
5. **Diagnostics.** `/api/diagnostics/free-nba` is 404 unless `ENABLE_FREE_NBA_DIAG=true` **and** ESPN or NBA.com is allowed; the ESPN probe also needs ESPN allowed. Each probe skips a disabled source without a request.
6. **Client.** The server's availability answer decides. Football, the ESPN sync page, the ESPN login form, and the home page's football card show a plain explanation instead of controls, and make no ESPN data request. A half-finished ESPN connect from an earlier visit is discarded instead of run.
7. **Tripwires (tests).** No server file may name an ESPN, NBA.com or RapidAPI host without using the guard or contain a raw `fetch()`; no client file may name an ESPN API host; the list of files is pinned so a new one is a reviewed change.

## What keeps working

Yahoo sign-in and connection, leagues, rosters, standings, matchups, ownership percentages, Yahoo ADP and draft results polling (with the HTTP 999 protections), the Yahoo attribution, the general Gemini chat, the consent infrastructure (personalization still off), and every PR #8 security and privacy fix. The projection engine code is unchanged and keeps its provider interface, so an authorized statistics provider can be added later.

## What is unavailable for now

- Fantasy Football, ESPN league sync, ESPN news and the ESPN login form (no other source exists for them).
- Basketball projections and everything built on them (ProGM rank, lineup optimizer, start/sit, waiver "best available", trade recommendations, draft value, durability). With no permitted statistics source, basketball runs in its existing "Yahoo-only mode", which says so plainly. Player headshots fall back to Yahoo's image.
- Schedule-aware "games this week" values (NBA.com, see below).

## NBA.com, audited separately

Before this change these were reachable by default, with browser-style `Origin`/`Referer` headers:

| Request | Used for |
|---|---|
| `cdn.nba.com/.../scheduleLeagueV2.json` | team schedules, games per week |
| `cdn.nba.com/.../boxscore_<id>.json` (one per completed game) | recent form |
| `stats.nba.com/stats/...` | rebound splits (this call ignored the `NBA_STATS_FALLBACK` flag) and the optional fallback provider |

Earlier research on the research branch read NBA.com's terms as barring use of its statistics "in connection with any fantasy game or other commercial product or service" (summarised page; confirm on the live page). **Recommendation, implemented: default-deny `PROGM_DATA_NBA_COM` until there is written authorization.** No replacement source was introduced. Without the ESPN player directory these calls could not feed projections anyway.

## Remaining requests

With default settings the server makes **no request to ESPN, NBA.com or RapidAPI**. It still contacts Yahoo (OAuth and Fantasy API, read only) and Gemini (general chat only). The browser loads the Yahoo logo from Yahoo's published asset host. Gated football pages still contain plain links to fantasy.espn.com that the user would click; those pages are not reachable while ESPN is off.

## Stored data

Untouched by design: `espn_connections` rows (including stored league JSON) stay in the database and are neither read nor served while ESPN is off. Scrubbing them is a separate, irreversible step that needs its own approval, a decision about the connection rows, and a backup taken with `--exclude-table-data=espn_connections` (Neon's restore history keeps older copies until it expires).

## Recommended deployment sequence

1. Merge PR #8 first (removes ESPN data from Gemini prompts), per [production-deployment-checklist.md](production-deployment-checklist.md).
2. Open a pull request for this branch against `main` once PR #8 is merged (its diff then shows only the ESPN commits).
3. In Render, confirm `PROGM_DATA_ESPN`, `PROGM_DATA_NBA_COM` and `PROGM_DATA_TANK01` are **not** set, and remove `ENABLE_FREE_NBA_DIAG` (the route is already dead).
4. After deploying, verify: startup log line `External data sources: espn=disabled nba_com=disabled tank01=disabled`; `GET /api/espn/availability` returns `available:false`; `POST /api/espn/preview` returns 503; `/api/health` 200; Yahoo login and the basketball workspace load (Yahoo-only message); Fantasy Football shows the notice.
5. Later, separately: purge stored ESPN data, and choose a licensed statistics source.

## Unresolved permissions

ESPN: declined. NBA.com: no authorization on record. Tank01: terms and the origin of its data unconfirmed, so it stays behind two switches. Yahoo: written confirmation of commercial use, retention and any statistics use is still pending (see the research branch's data-rights report).
