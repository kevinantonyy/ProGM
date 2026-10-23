# Consent/chat/Yahoo hardening verification

2026-10-20; branch `research/projection-v2-data-rights`. Code commit **`cc27934767e1bac130c6f6e4d756165889b3462a`**, based on `8db9a88d44c1153615aa6387768283163383bdd1`. Documentation changes follow separately. No push, merge, deployment, production DB, Render settings, credentials, snapshots or private injury records were touched. No Yahoo API/Gemini call was made; official public attribution documentation was researched.

## Root causes and fixes

| Defect | Cause | Fix and regression evidence |
|---|---|---|
| Authenticated malformed chat could reject outside Express 4 error handling | Nested text access/coercion and payload building happened before the handler's try/catch; historical entries were unvalidated | Validate every message structure/role/string/length and final question before access; 400 for invalid structures; generic JSON parse error middleware; wrap policy/payload/provider operations. Real Express + JWT adversarial HTTP tests include null entries, wrong types/roles, oversized fields, malformed JSON, server survival and zero provider calls. |
| Revocation/kill-switch history replay | Earlier personalized assistant text travelled in browser-supplied `messages`, independently of fresh-context consent checks | Ignore ALL browser historical turns server-side, including forged provenance and relabelled old user turns. Only the latest question is new input. Optional AES-GCM receipts preserve server-verified GENERAL follow-ups, bound to authenticated user/process, ten-minute TTL, ten-turn/byte limits. Personalized responses receive no receipt. Context requests ignore receipts even if denied. Test revocation, stale tabs, switch-off, tamper, expiry, cross-user/process replay and minimization. |
| ESPN identifiers re-entered through greetings/history | Initial greeting interpolated the synced team name; league-keyed localStorage conversations were restored and sent | Generic greeting, no legacy storage restore/write, no browser transcript egress. Old saved chats are left untouched; visible current-session history remains in memory. General football chat and verified general follow-ups remain functional. Client and HTTP fixtures cover old identifying greetings/replies. |
| HTTP 999 escalation reset / expired picks retained | Cleanup removed denial state at the retry deadline, but skipped expired raw results during backoff/in-flight work | Retain denial counters through retry deadlines; success resets them, or expire retry-only metadata after 24h inactivity and no active retry/in-flight request. Independently release raw picks after the existing two-hour window, on access/minute sweep, even in flight. Single-flight/backoff/jitter/circuit thresholds unchanged; tests verify repeated denials, no extra loader calls, expiry and in-flight cleanup. |
| Unbounded preview repetition | Preview had no route quota | Separate authenticated per-user 20/10-minute preview quota, ahead of DB/cache work; 429 on excess; strict question validation. Preview remains cache-only and never calls Gemini or Yahoo. HTTP tests cover quota, expiry, user isolation, cold cache and unchanged chat quota. |
| Consent keyboard/mobile accessibility | Focus entered/restored but was not constrained to dialog; busy Escape could dismiss | Dynamic focus trap, forward/reverse wrap, outside-focus containment, restoration, scroll lock/cleanup, Escape/backdrop decline except while saving. DOM behavior tests plus actual Chrome checks. Browser screenshots exposed low-contrast light-mode Google warning; theme-aware warning surface and body text fixed it, with regression assertions and measured >=4.5:1 warning contrast in both themes. Enabled notice uses semantic green. |
| Missing freshness/partial context | Summary omitted real cache/provider metadata and missing-projection warnings | Include actual workspace/provider times when available, otherwise null; tri-state stale flag; observed missing counts; notices for partial lineup/roster and uncertain freshness. Explicitly label calculated projections/gains as estimates versus observed standings. Only existing estimate/confidence values are emitted; no confidence/timestamps invented. Golden fields, caps and preview/provider equality remain tested. |
| Attribution destination incomplete | Logo linked to general Yahoo but required sentence had no Fantasy backlink | Keep official logo URL, proportions/colors and existing general logo destination unchanged; link the exact required sentence to Yahoo Fantasy. Both destinations are regression-tested. |
| Deployment/rollback guidance predated consent table | Earlier guide incorrectly said nothing persisted and suggested dropping consent table | Current [deployment-readiness.md](deployment-readiness.md) includes additive table, isolated rehearsal, startup's other DDL, consent-preserving rollback, global OFF switch, tested candidate SHA and explicit production verification/approval gates. |

The [official Fantasy requirements](https://sports.yahoo.com/developer/) specify the required attribution sentence, a Fantasy backlink and unmodified branding. The [general Yahoo API guidelines](https://developer.yahoo.com/attribution/) specify the general logo destination. Verified from official search-indexed pages on 2026-10-20; direct page fetches later returned 429, without bypass attempts. This is not a grant of data-processing/commercial rights.

## Exact files changed

Client:

- `client/src/components/AIManager.jsx`
- `client/src/components/AiConsent.test.js`
- `client/src/components/AiConsentDialog.js`
- `client/src/components/AskProGMChat.jsx`
- `client/src/components/PersonalizationBar.js`
- `client/src/components/YahooAttribution.js`
- `client/src/components/YahooAttribution.test.js`
- `client/src/utils/aiSharing.js`
- `client/src/utils/aiSharing.test.js`
- `client/src/utils/consentFocus.js` (new)
- `client/src/utils/consentFocus.test.js` (new)

Server:

- `server/src/index.js`
- `server/src/routes/gm.js`
- `server/src/routes/gm.http.test.js`
- `server/src/services/ai/aiDataPolicy.test.js`
- `server/src/services/ai/generalChatHistory.js` (new)
- `server/src/services/ai/generalChatHistory.test.js` (new)
- `server/src/services/ai/yahooLeagueContext.js`
- `server/src/services/ai/yahooLeagueContext.test.js`
- `server/src/services/fantasy/yahooDraftPolling.js`
- `server/src/services/fantasy/yahooDraftPolling.retention.test.js`

Documentation:

- `docs/evaluations/consent-based-gemini-hardening.md` (this report, new)
- `docs/evaluations/consent-based-gemini-implementation.md`
- `docs/evaluations/data-handling-final-review.md`
- `docs/evaluations/deployment-readiness.md`

## Verification

| Check | Final result |
|---|---|
| Full server suite, `node --test --test-concurrency=4` | **719 passed, 0 failed/skipped** (+13) |
| Full client suite, `node --test` | **69 passed, 0 failed/skipped** (+5) |
| `node --test research/projection-v2-data-rights/yahoo_probe.test.mjs` | **17 passed, 0 failed/skipped**, mocked networking only |
| `cd client; npm.cmd run build` | **Passed**, 125 modules |
| `git diff --check` | **Passed** |
| Isolated Chrome, actual React components + real GM router, synthetic services | **40 checks passed**, desktop 1440x1000/mobile 390x844, light/dark |

Tests ran with synthetic credentials, localhost-only DB guard and an external-fetch deny guard; no real DB connection. Initial server run found one outdated source-allowlist assertion, corrected to recognize the new body validator; final full suites were rerun. Build and Chrome needed execution outside the filesystem sandbox for esbuild's installed linked dependencies; no dependencies/configuration changed.

Browser checks cover initial focus, Tab/Shift-Tab wrapping, outside-focus capture, Escape restoration, scroll lock, viewport fit, 44px targets, Google warning contrast, successful consent/personalized mock response, revocation, local visible-history preservation and no personalized transcript replay. Provider requests were captured in memory; two synthetic responses, zero external API calls. External browser page requests were blocked. Temporary harness/evidence (not repository artifacts): `%TEMP%/progm-hardening-browser.mjs`, `%TEMP%/progm-browser-hardening-GNuAEQ/consent-{390,1440}-{light,dark}.png`. Full suite logs: `%TEMP%/progm-hardening-tests-InlcLw/`.

## Remaining risks / readiness

- **Conditionally ready for a controlled hardening rollout with personalization OFF**, after isolated migration rehearsal, release-base review and explicit deployment approval. Not production-verified; no deployment health or authenticated provider test was performed.
- Yahoo permission for third-party AI sharing remains unresolved; free Gemini processing risks remain. Consent is necessary but does not establish provider rights. Do not enable personalization under this milestone.
- Receipt/history and rate limits are per process. Restart, expiry or routing to another instance loses general follow-up context safely. Personalized follow-ups rebuild context from the current question, never replay prior personalized answers. No new transcript DB/cache was introduced.
- A user can deliberately paste sensitive text as a new question; the server cannot prove human typing or infer its origin. Historical turns and provenance labels cannot bypass the boundary, but this is not a semantic DLP filter. Avoid entering private information in general chat.
- Revocation prevents subsequent context-sharing decisions; requests already authorized/dispatched cannot be recalled. Existing saved local ESPN conversations remain on disk, unmodified but no longer restored/transmitted. Current visible chats are not persisted by these components and disappear on reload.
- Freshness and confidence describe only available source metadata, not guarantees of accuracy; preview can differ from a later send if the underlying cache changes between requests. Same inputs use the same bounded builder.
- No real-device/screen-reader or authenticated Yahoo/Gemini validation, no SQL migration rehearsal or production cache inspection in this task. Retention sweeps can physically lag the cutoff by up to one minute; expired picks are unavailable immediately on access. Retry metadata retains a league key/counter but no picks for up to 24h inactivity.

No rankings, projections, expected games, recommendation order, Yahoo OAuth credentials or research engine wiring changed. Await approval before any push, merge, production database work, Render change, deployment or authenticated API smoke test.
