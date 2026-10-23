# Data-handling final review (version 2): server-controlled AI boundary, retention, cleanup, snapshots

**Historical report:** the consent implementation added a gated Yahoo builder after this review. Current chat-history controls, independent draft-pick expiry, backoff retention, test results and rollout/rollback guidance are in [consent-based-gemini-hardening.md](consent-based-gemini-hardening.md) and [deployment-readiness.md](deployment-readiness.md). Those supersede conflicting claims below. The snapshot inventory is retained for reference only: no deletion is approved or performed.

Branch `research/projection-v2-data-rights`. **Nothing was pushed, merged or deployed; no production variable, database or credential was touched; no Yahoo request was made; nothing was deleted.** This document supersedes the parts of `data-handling-hardening.md` it contradicts (that file's test counts, its "client labels" description of the AI policy, and its 6-hour draft fallback are out of date).

## 1. Gemini boundary (items 1 and 2)

**Previous design:** the server forwarded league data the browser sent if the browser labelled it `source: 'espn'`. A label is just text, so that was trust in the client.

**Now:** `routes/gm.js` never reads `req.body.league`. League data can reach Gemini only through a **server-side builder** that is (1) registered in code, (2) on the explicit allowlist in `services/ai/aiDataPolicy.js`, and (3) switched on by a server-side environment value. All three are required.

| Source | Allowed | Builder in code | Notes |
|---|---|---|---|
| `user_message` | yes | n/a | What the user typed. Not league data. Always forwarded. |
| `espn_football_league` | **no** | **none** | ESPN/Disney terms restrict automated access, commercial use and AI tooling; no permission. Env `PROGM_AI_ESPN_DATA=allow` alone does nothing without a builder. |
| `yahoo_league` | **no** | **none** | Yahoo terms bar disclosing Yahoo user data to third parties. Env `PROGM_AI_YAHOO_DATA=allow` alone does nothing without a builder. |
| anything else, unknown name, malformed value, `__proto__`, objects, arrays | **no** | n/a | Ambiguous means restricted. |

The only thing the browser may send besides messages is an optional `contextRequest` string: a request for a kind of context, never data and never proof of origin. Today every request is refused and the user sees a notice; the chat still answers in general mode. Server-built context for a non-Yahoo source is additionally scanned for Yahoo-shaped keys and refused if any are found.

**Football data audit (same principle):** two callers sent ESPN roster, standings, projections and ownership: the football "Ask ProGM" tab (`AIManager.jsx`) and the trade negotiator in `TradeBuilder.jsx`. The negotiator also **embedded ESPN player names and ProGM grades in the message text itself**, a channel the server cannot classify. Result: AIManager now sends the conversation only (new intro, subtitle, privacy line and general-advice quick prompts); the negotiator is **paused** with an on-screen notice (its textarea, state and request were removed; the trade grade, values and "Send to ESPN" link are unchanged).

**Residual limit (cannot be closed in code):** the server cannot verify that message text was typed by a person. A client that pastes league data into a message would be forwarded. The first-party client no longer does that (tests below); a third-party client calling the API with the user's token is the user's own action.

**General chat is not disabled:** both chats still work, with the same rate limit (20 per 10 min per user), validation and error mapping.

**Tests proving restricted data cannot reach the external call** (server `gm.test.js` 8, `aiDataPolicy.test.js` 7; client `aiSharing.test.js` 5):
- Yahoo, ESPN, mislabelled (Yahoo data wearing an ESPN label) and unlabelled client payloads, each with sentinel names, keys and rosters, never appear in the body sent to the provider.
- Turning on either override variable, alone or together, does not make client data trusted.
- Eleven kinds of `contextRequest` (including `__proto__`, objects, arrays, numbers) are blocked; an enabled source without a builder is blocked; a builder for a disabled source is never called.
- Only an enabled, server-built context is forwarded; the client payload is ignored; a builder that returns Yahoo-shaped data or throws is refused.
- Source scan: `gm.js` does not contain `req.body.league`, reads only `messages` and `contextRequest` from the body, and passes the provider only `decision.context`; only `gm.js` mentions the Gemini host; the egress allowlist of eight outbound call sites is unchanged; only `gm.js` and the policy file reference the builder registry.
- Client: every `/gm/chat` caller is known (now two: football AIManager, basketball workspace); neither sends `league`, `source` or `context`; TradeBuilder no longer calls the chat.

## 2. Retention: actual maxima (items 3, 4, 5)

Memory is also cleared by any restart (Render restarts idle services). **The 24-hour cap is provisional** until Yahoo answers the retention question; it is the conservative reading of "delete within 24 hours", and nothing in use comes close to it.

| Store (Yahoo-derived, in memory) | Fresh | Stale fallback | **Maximum before it is unusable** | Physically removed |
|---|---|---|---|---|
| Workspace | 5 min | 15 min | **20 min** | at next read, write or minute sweep |
| Draft settings | 2 min | 15 min | **17 min** | same |
| ADP table | 1 min | 15 min | **16 min** | same |
| Draft-preview pool | 10 min (1 min if degraded) | 15 min | **25 min** | same |
| Draft-preview result | 10 min | 15 min | **25 min** | same |
| Ranking-shadow | 5 min | 15 min | **20 min** | same |
| **Draft results (raw picks), live draft** | 8 s | **2 h (was 6 h, reduced now)** | **about 2 h after the last successful Yahoo response** | within about one minute after that |
| Baseline reference (rank scale) | 12 h | 15 min | **12 h 15 min** | same |
| Global hard cap on any Yahoo-derived cache entry | | | **24 h** (provisional) | |

| Store (database) | Lifetime | **Maximum after expiry** | Note |
|---|---|---|---|
| `yahoo_oauth_states` | 10 min | removed within **10 min** of expiry (cleanup runs every 10 min, and at startup) | previously removed only when someone started another sign-in |
| `yahoo_pending_connections` | 15 min | removed within **10 min** of expiry | same |
| `yahoo_connections` (active OAuth credentials) | until disconnect | **never touched by cleanup** | tokens and GUID are what Yahoo lists as storable |

**Draft-results change (item 5):** `staleTtlMs` 6 h to 2 h. This does not add a request: the cache only serves the old picks while Yahoo is blocking, and the existing 8-second share, exponential backoff and circuit breaker are unchanged (a test pins all five values). After two hours without a success a blocked league shows "unavailable" instead of old picks.

**999 protections preserved:** `yahooRequestGuard.js` and the polling coordinator are untouched apart from that constant; the 15-minute Yahoo stale window continues to cover the typical block.

**12-hour ranking reference (item 4): confirmed to hold no user-identifiable Yahoo information.** By code review of what is stored (`draftHelper.js`, `baselineReference.js`): scarcity weights, pool maximum season points, per-position replacement baselines and spread, the sorted list of baseline numbers, pool size, a completeness flag and a model id. No player, team, manager, league name or Yahoo response. One note: its **cache key** contains the Yahoo league key (for example `466.l.12345`) and a hash of the scoring settings. The key is an identifier of a league, not of a person, and it exists only in memory for at most 12 h 15 min. If you want zero identifiers, hash the league key in the key; not done (it would change nothing functionally, and you did not ask for it).

## 3. OAuth state cleanup (item 6)

New `services/yahooOauthCleanup.js`, started once from `index.js` after the database initialises. Two statements, each limited to rows past their own expiry:

- `DELETE FROM yahoo_oauth_states WHERE expires_at < NOW()`
- `DELETE FROM yahoo_pending_connections WHERE claim_expires_at < NOW()`

It cannot touch `yahoo_connections`, makes no Yahoo request, runs at startup and every 10 minutes, uses an `unref`'d timer, and a failing statement is logged (message only, no row data) without stopping the other. Four tests, including one that the statements match only the two short-lived tables and that the module has no network call. The existing delete-on-sign-in lines in `routes/yahoo.js` are unchanged.

**Not run against any real database.** The two statements are the same SQL the sign-in handler already runs.

## 4. Local snapshot audit (item 7): nothing deleted, no content printed

How they are used: `server/scripts/snapshotCompare.mjs <saved-workspace-response.json> [outDir]` reads the raw response and **regenerates** the three `progm-out` files. Therefore the derived files are reproducible from the raw one; the raw one is reproducible only by calling the Yahoo-backed workspace endpoint again.

| File | Still needed for debugging? | Safe to remove? |
|---|---|---|
| `Desktop\workspace-response.json` (10.1 MB raw Yahoo-derived workspace response) | Only to re-run `snapshotCompare.mjs` or replay a ranking issue against the 2026-10-15 pool. All earlier ranking investigations are written up in `docs/evaluations/`. | **Yes, once you accept that re-running needs a fresh capture.** Highest sensitivity; recommended first. |
| `progm-out\progm-sanitized-snapshot.json` (399 KB, Yahoo ADP for about 740 players) | Regenerable from the raw file; replay input for the offline pipeline | **Yes** (still Yahoo-derived) |
| `progm-out\progm-offline-pipeline.json` (49 KB, ADP for about 18 players) | Regenerable | **Yes** |
| `progm-out\progm-ranking-comparison.json` (62 KB, ProGM ranks, no Yahoo field names) | Output only; its findings are in the docs | **Yes**, lowest risk |
| `Desktop\progmOauthflow.txt` (2.8 KB, not opened by me) | Unknown; contains the words `refresh_token`, `Bearer`, `client_secret` once each, no token-like strings | **You must open and check it yourself**; delete it if it contains any secret |
| `AppData\Local\Temp\progm-injury-*\yahoo.json` (about 200 folders, 54 bytes each) | Synthetic test fixtures | Yes; negligible |
| Local PostgreSQL `progm_draft_status` | 0 users, 0 Yahoo rows | nothing to remove |

If you want to keep one for debugging, keep the **comparison** file (no Yahoo fields) and delete the other three. Committed docs quote a small number of derived Yahoo ADP/rank values for named players in the private repository; deleting local files does not remove those.

## 5. Production Gemini key (item 8): not determined

I cannot tell you whether `GEMINI_API_KEY` is set in production: that requires opening the Render service or its environment, which you have barred, and no production access is configured here. Locally it is unset; `render.yaml` declares it (`sync: false`, so Render keeps whatever you entered). A safe way for you: Render dashboard, service, **Environment** tab; the list shows variable names and hides values (do not click reveal). You may also tell me "present" or "absent". I did not change any variable.

## 6. Attribution re-verified (item 9)

`YahooAttribution.js` still uses the official `Yahoo_Fantasy.svg` at Yahoo's published URL (not bundled), `TRIM_EMPTY_MARGIN = false` (untrimmed square), the text "Fantasy data provided by Yahoo Fantasy", the link `https://www.yahoo.com/?ilc=401`, no filter, recolor, rotation or stretch; white plate and ring are the only surround. The six component tests (exact wording, URL, link attributes, no CSS filters or inline SVG, equal height and width, logo-only mode) pass. Placements unchanged: workspace (once), player profile, Sync, Login and Home (basketball section only). The chat-tab copy now says general help; the logo strip is not affected.

## 7. Yahoo request-volume impact

**None increased.** The cleanup job and the AI changes make no Yahoo request; the draft fallback reduction only shortens how long old picks may be shown during a block; cadence, backoff and circuit constants are pinned by a test. The one indirect effect: after a block lasts more than 2 h (previously 6 h) the draft view shows "unavailable" rather than old picks; recovery requests are still governed by the same backoff.
