# Data-handling hardening: AI transfers, cache retention, snapshots and deployment risk

Branch `research/projection-v2-data-rights` (worktree `ProGM-projection-v2`). **Nothing was pushed, merged or deployed, no production environment variable was read or changed, and no production token or database was accessed.** The Yahoo probe is still waiting for your local sign-in.

## 1. Summary

| Item | Result |
|---|---|
| 1. Yahoo data to external AI | **Blocked, default-deny**, enforced on the server and the client, with tests. General chat and the football (ESPN) chat keep working. |
| 2. Expired cache entries kept forever | **Fixed.** Every cache entry now has a purge deadline; an automatic sweeper runs; Yahoo-derived entries have a 15-minute stale window and a 24-hour hard cap. Draft-polling state is purged too. Tests added. |
| 3. 6-hour and 12-hour caches | **Audited.** The 12-hour ranking reference is derived aggregate numbers, not raw Yahoo data; keep it. The 6-hour draft-results fallback is raw Yahoo data; recommend 2 hours. Neither change adds Yahoo requests. Section 5. |
| 4. Local snapshots | **Five locations found** (section 6); **nothing deleted.** |
| 5. Permission email | Rewritten against the code: `yahoo-permission-request-final.md`. |
| 6. Probe | Not run. No production access. |
| 7. Tests | Server 670, client 57, probe 17: **all pass, no regressions**; client build compiles. Risk assessment in section 8. |
| Logo | `TRIM_EMPTY_MARGIN = false` as approved: the full official canvas, uniformly scaled, remotely hosted at Yahoo's published URL. |

## 2. Outbound data audit

Every place server code makes an outbound HTTP call (comments excluded), verified by a test that fails if a new one appears:

| Call site | Destination | Direction | Carries user or league data? |
|---|---|---|---|
| `routes/yahoo.js` | Yahoo OAuth and Fantasy API | GET (and the OAuth token POST) | Sends the app credentials and the user's token to Yahoo; receives Yahoo data |
| `routes/gm.js` | Google Gemini | POST | **Yes: the user's typed chat; and, before this change, a copy of the synced league.** Now gated. |
| `routes/espn.js`, `services/providers/*` | ESPN, NBA CDN, stats.nba.com (off by default), Tank01 (off by default) | GET | No user data sent |

Chat callers: the basketball Ask ProGM tab (Yahoo league), the football AI manager and the football trade commentary (ESPN league, both inside the football workspace only).

## 3. Gemini and Yahoo data

**Policy** (`server/src/services/ai/aiDataPolicy.js`, applied in `routes/gm.js`):
- League context is forwarded **only if** the client labels it `source: 'espn'` **and** no Yahoo-shaped key (`yahoo*`, `playerKey`, `leagueKey`, `teamKey`, `percentOwned`, `ownedPct`, `draft_analysis`) appears anywhere inside it.
- Anything labelled Yahoo, any `sport: 'basketball'` context, anything unlabelled, and anything ambiguous is **dropped**. The chat then answers in general-advice mode with a system prompt that forbids pretending to know the roster, and the response carries `leagueDataShared: false` and a notice.
- The user's own typed messages are not league data and are unaffected.
- **Old browser tabs are safe:** a stale client that still posts the old basketball context is blocked by the server because it recognises basketball and the Yahoo keys.
- **Re-enabling later** (only after Yahoo permits it): set `PROGM_AI_YAHOO_DATA=allow` (exact value). It re-allows only context explicitly labelled `source: 'yahoo'`. **No environment variable was set or changed.**

**Client:** the basketball chat now sends only the conversation (`basketballChatPayload`); its header says "General fantasy basketball help. Your Yahoo league data is not shared with the AI provider." The unused `basketballContext` builder is labelled `source: 'yahoo'` so any future reuse is auto-blocked. The football context builder is labelled `source: 'espn'`.

**Preserved:** the chat itself (general fantasy basketball advice from what the user types), the football AI manager and trade commentary with their ESPN league context, rate limiting (20 per 10 minutes per user), validation and error handling (unchanged, tested).

**What the basketball chat can no longer do:** explain ProGM's recommendations for your Yahoo roster, because that required your league data. The recommendations themselves (rankings, start/sit, waivers, trades) are unaffected and displayed in their own tabs. Restoring the explanations needs either Yahoo's permission or a local, non-AI explanation feature.

**Tests (17 server tests for this part):** Yahoo-labelled data never appears in the body sent to the provider (names, roster, standings, team and league names, keys checked as sentinels); unlabelled and basketball-only contexts blocked; an ESPN-labelled context that hides a Yahoo key is blocked; football context still forwarded; no-context chat works and is not reported as blocked; the override works only with the exact value and the explicit label; error logs never include league context; 503, 400, 429 (per user) and provider-error mapping unchanged; **egress inventory** (a new outbound call site fails the test until reviewed); only `gm.js` may reference the Gemini host. Client: the chat payload has no `league`; the basketball chat call does not use the context builder; every `/gm/chat` caller is a known one.

**Not covered here (flagged):** ESPN football context still goes to Gemini. ESPN's terms (Disney) have their own restrictions on automated use and AI; that is outside the Yahoo question you asked me to close, but it is the same kind of transfer.

## 4. Cache cleanup

**Root cause:** `services/providers/cache.js` had no eviction. Expired entries stayed until overwritten, were served as a stale fallback indefinitely, and the draft-polling store kept per-league raw draft results forever.

**Fix:**
- Each entry has `expiresAt` (fresh) and `purgeAt` (deleted). `get`, `has` and `isFresh` honour it and delete lazily; `purgeExpired()` removes everything past due; a write triggers a sweep at most once a minute; an `unref`'d timer sweeps idle servers too.
- **Yahoo-derived entries** (provider `yahoo`, or any entry tagged `derivedFrom: 'yahoo'`): stale fallback **15 minutes** after expiry, **hard cap 24 hours** whatever TTL or grace a caller asks for. The 15 minutes covers a typical HTTP 999 block (backoff 5 s to 5 min, circuit 60 s or more), so users still get stale data instead of an error during a block, without extra Yahoo requests.
- **Everything else** (ESPN and other independent providers): 24-hour stale window (previously unbounded).
- **Tagging:** the three places that store Yahoo-derived data under a ProGM label (ranking-shadow diagnostic, draft-preview result, baseline reference) are now tagged; a test fails if a new `provider: 'progm'` write in those files lacks the tag.
- **Draft polling state** (`yahooDraftPolling.js`): deleted once its last successful response is older than the stale window and the league is not in flight or backing off; purged on every fetch and by an `unref`'d timer.
- 11 new tests with a mocked clock (stale then purged, tag inheritance, 24-hour cap, independent data window, count returned, opportunistic sweep, draft-state purge including during a 999 backoff).

## 5. Retention audit and recommendations

Yahoo's published rule: data not documented as storable indefinitely must be deleted within 24 hours (some wording applies to "Yahoo user data", which makes player-level statistics ambiguous). Only the token and GUID are listed as storable indefinitely. I applied the conservative reading to everything Yahoo-derived but did **not** force five minutes: lifetimes are chosen to avoid extra Yahoo requests.

| Store | Contents | Yahoo-derived? | Before | Now | Recommended | Effect on Yahoo requests |
|---|---|---|---|---|---|---|
| Workspace cache (`bball:…`) | Assembled league view: roster, standings, pool, ProGM calculations | **Yes** (raw-ish plus derived) | 5 min fresh, kept forever | 5 min + 15 min stale, then deleted | Keep | None; a rebuild is a burst of requests, so 5 min stays |
| Draft settings / ADP / preview settings | League settings; ADP table | Yes | 1 to 2 min, forever | same fresh, 15 min stale | Keep | None |
| Draft-preview pool | Player pool with ownership | Yes | 10 min (1 min if degraded), forever | + 15 min stale | Keep | None |
| Draft-preview result, ranking-shadow | ProGM ranks computed on the pool | **Derived** from Yahoo data | 10 min / 5 min, forever | now tagged, same deletion | Keep | None |
| **Draft-results state (live draft)** | Raw picks and teams | **Yes (raw)** | fresh 8 s, **stale fallback 6 h, never deleted** | deleted after 6 h without a success | **Reduce fallback to 2 hours** | None: stale data is only shown while Yahoo is blocking; polling keeps its existing backoff. After 2 h the user sees "unavailable" instead of old picks, which is the honest state. |
| **Baseline reference (rank normalization)** | Pool maximum, replacement baselines per position, scarcity weights, sorted baseline numbers, pool size, completeness, model id | **ProGM-derived aggregate numbers** from independent projections under a Yahoo league's scoring, slots and pool membership. No player, team or user identifiers; not Yahoo responses | 12 h, forever | 12 h + 15 min, then deleted (tagged) | **Keep 12 hours** | Shortening it forces the full league pool to be re-fetched mid-draft (many paged requests) and shifts ranks; staying under 24 h keeps it inside Yahoo's ceiling. |
| Independent provider caches | ESPN season stats, schedules, injuries, box scores, history | No (their own terms apply) | up to 30 days, forever | + 24 h, then deleted | Keep | None |
| Database `yahoo_connections` | OAuth tokens and Yahoo GUID | Credentials | indefinite | unchanged | Keep; Yahoo's guidelines list token and GUID as storable | n/a |
| Database `yahoo_oauth_states`, `yahoo_pending_connections` | State hashes (10 min) and tokens held before account linking (15 min) | Credentials | expired rows deleted **only when someone starts a new sign-in** | unchanged | **Add a scheduled delete** (not done) | None |
| Browser | React state; `sessionStorage` claim id; football chat transcripts in `localStorage` (ESPN) | Not Yahoo data | n/a | unchanged | Keep | n/a |
| Logs | Safe diagnostics only (no tokens or league payloads by code review) | No | provider-managed | unchanged | Confirm Render log retention | n/a |

**Recommendation in one line:** keep fresh windows as they are; 15 minutes of stale fallback for Yahoo-derived entries; draft-results fallback 2 hours (a one-constant change, `staleTtlMs`, deliberately **not** applied so you can decide); keep the 12-hour derived reference; hard 24-hour cap on anything Yahoo-derived (implemented). If Yahoo later confirms player statistics are not user data, nothing here needs to get stricter.

## 6. Locally saved Yahoo-derived data (paths only; contents not shown; **nothing deleted**)

| Location | Size | Modified | What it is (from marker counts only) | Sensitivity |
|---|---|---|---|---|
| `C:\Users\Kevin\Desktop\workspace-response.json` | 10.1 MB | 2026-10-15 | A **raw saved `/api/basketball/workspace` response**: about 1,015 player records with Yahoo player keys, ownership percentages and, for about 740, Yahoo ADP, plus league data | **Highest.** Raw Yahoo-derived league data, retained about 5 days. |
| `C:\Users\Kevin\Desktop\progm-out\progm-sanitized-snapshot.json` | 399 KB | 2026-10-15 | "Sanitized" derivative of the above; still holds Yahoo ADP for about 740 players | High |
| `C:\Users\Kevin\Desktop\progm-out\progm-offline-pipeline.json` | 49 KB | 2026-10-15 | Replay output; Yahoo ADP for about 18 players | Medium |
| `C:\Users\Kevin\Desktop\progm-out\progm-ranking-comparison.json` | 62 KB | 2026-10-15 | ProGM rank comparison on that league's pool; no Yahoo field names found | Medium (derived) |
| `C:\Users\Kevin\Desktop\progmOauthflow.txt` | 2.8 KB | 2026-10-19 | **Not read.** Contains the words `refresh_token`, `Bearer` and `client_secret` once each; **no token-like strings (40+ characters) were found**, so it looks like notes, but please check it yourself. | Check manually |
| `C:\Users\Kevin\AppData\Local\Temp\progm-injury-*\` (about 200 folders) | 54 bytes per `yahoo.json` | 2026-10-16 | Tiny synthetic test fixtures from the injury-logger tests | Negligible |
| Local PostgreSQL (`progm_draft_status`) | n/a | n/a | 0 users, 0 Yahoo rows | none |

Also: committed documents in the (private) GitHub repository `kevinantonyy/ProGM` quote derived Yahoo ADP/rank numbers for a few named players (about 15 lines across `ranking-root-causes.md`, `ranking-integration.md`, `expected-games-audit.md`, `ranking-research-consolidation.md`; they are on `main` and several feature branches). The repo is private. They are summaries, not raw responses.

**Suggested handling (needs your approval):** delete `workspace-response.json` and `progm-sanitized-snapshot.json` first (the raw copy and its richest derivative); keep or delete the other two derived files as you prefer; check `progmOauthflow.txt`; and either keep or redact the few numbers in the docs. Whether keeping them for your own analysis is acceptable depends on Yahoo's answer to the retention question, so the safe default is to delete the raw one now.

## 7. Test results

| Suite | Result |
|---|---|
| Server (`node --test`) | **670 / 670** (642 before; 28 new: cache retention 8, draft-state retention 3, chat route 11, AI policy and egress 6) |
| Client (`node --test`) | **57 / 57** (47 before; attribution component 6, AI sharing 4) |
| Yahoo probe | **17 / 17** (fake network only; not run against Yahoo) |
| Client production build | compiles |
| Smoke test | the refactored chat router mounts and returns 401 without a token |
| Regressions | **none**; two existing test files (cache, draft polling) pass unmodified |

Two test-authoring mistakes were found and fixed during this work (a rate-limit count, and a regex that a shell had mangled); no product bugs were found by the new tests.

## 8. Deployment risk assessment

**Overall: low technical risk, moderate product impact. Not deployed; recommend deploying only after the decisions at the end.**

| Change | What can go wrong | Likelihood / impact | Mitigation |
|---|---|---|---|
| Cache purge applies to every provider | Entries disappear earlier than before (up to 24 h after expiry for independent data, 15 min for Yahoo-derived) so an outage longer than that shows an error instead of stale data | Low / medium: only during long upstream outages; Yahoo blocks beyond about 20 minutes will now show "unavailable" | Windows are constants in one place; does not raise request rate, because the existing backoff and circuit breaker still gate every Yahoo call |
| Two `unref`'d sweep timers | Negligible CPU; cannot keep the process alive | Very low | Covered by tests |
| Draft-state purge | A league state removed while a draft pauses more than 6 h | Very low | Backoff states and in-flight loads are never purged |
| AI chat no longer receives Yahoo data | Basketball Ask ProGM gives general answers; users may notice reduced specificity | **Certain** / medium (product) | Notice shown in the tab; football chat unchanged; override documented for when Yahoo agrees |
| Stale browser tabs after deploy | Old client posts old context: blocked by the server (safe); old football client lacks the new label so its context is dropped until refresh | Low / low | Resolved by a page reload |
| Attribution component | The logo is loaded from Yahoo's S3 URL; if Yahoo moves or removes it, the image breaks but the sentence remains; third-party image request on each page that shows it | Low / low | One constant to change; bundling awaits Yahoo's written answer |
| Client bundle | Adds one small component and a utility | Very low | Build and tests pass |
| Database, environment, Render settings, OAuth, scoring, Yahoo request volume | **No change** | n/a | n/a |

**Rollback:** revert the commit; nothing is persisted by these changes, so there is nothing to migrate or clean.

**Before deploying, decide:** (1) whether to send the Yahoo email first or in parallel (the email now describes the safeguards as built but not yet live); (2) whether you accept the product change to the basketball chat; (3) the draft-results fallback (6 h now; 2 h recommended); (4) what to do with the saved files in section 6; (5) the out-of-scope ESPN-to-Gemini question; (6) check in the Render dashboard whether `GEMINI_API_KEY` is set (I did not look).

**Post-deploy checks:** the basketball chat answers with the notice and `leagueDataShared: false`; the football chat still shows `leagueDataShared: true`; server logs show no new errors; Yahoo request counts per page load unchanged; memory stays flat over a day.

## 9. Not done
No deletions; no environment variable changes; no push, merge or deploy; no production access; no Yahoo requests; no GitHub posts.
