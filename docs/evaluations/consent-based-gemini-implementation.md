# Consent-based personalized Ask ProGM (basketball): implementation report

**2026-10-20 hardening update:** [consent-based-gemini-hardening.md](consent-based-gemini-hardening.md) and [deployment-readiness.md](deployment-readiness.md) supersede earlier safety/deployment conclusions. Tested hardening code: `cc27934767e1bac130c6f6e4d756165889b3462a`. The original `8db9a88` implementation alone is not a safe release candidate.

Branch `research/projection-v2-data-rights`. **Built and tested locally. Not pushed, merged, deployed or enabled.** No production variable, database or credential was touched. Projection Engine V2 is untouched and disabled. No paid service; free Gemini quota only. ESPN football data stays blocked.

## 1. What was built

**Gates, in order (any failure gives a general answer plus a notice; the question is still answered):** authenticated user, existing 20-per-10-minute limit, server switch `PROGM_AI_YAHOO_DATA` exactly `allow` (**unset by default; nothing in the repository sets it**), an active database consent record for the current disclosure version (checked on every request), a Yahoo connection, the user's **own cached workspace** (cache read only, no Yahoo request; a cold cache says "Reload your league, then ask again"), then the builder and its leak guard.

| Piece | File |
|---|---|
| Server-recorded consent (store, versioned disclosure text served to the browser) | `server/src/services/ai/consent.js`, table `ai_data_consents` in `db/connection.js` |
| Context builder: allowlisted fields, pseudonyms, section selection, size cap, leak guard | `server/src/services/ai/yahooLeagueContext.js` |
| Policy: builder contract, switch, strict string-only `contextRequest` | `server/src/services/ai/aiDataPolicy.js` |
| Routes: `GET/POST/DELETE /api/gm/consent`, `POST /api/gm/context-preview`, chat metadata | `server/src/routes/gm.js` |
| Cache-only read helper (`readCachedWorkspace`) | `server/src/routes/basketball.js` |
| Production wiring | `server/src/index.js` |
| UI: consent dialog, on/off control, chat with answer tags, "See what was sent", preview | `client/src/components/{AiConsentDialog.js, PersonalizationBar.js, AskProGMChat.jsx}`, `client/src/utils/aiSharing.js`, `pages/BasketballWorkspace.jsx` |

**Data minimization.** The server chooses sections from the latest question (`overview` always, plus up to two of roster, lineup, waivers, trades, standings, draft; three in total including overview), at most 6,144 bytes. Fields are built one by one; your team is "Your team", others "Team A, B...", and names inside ProGM's own reason strings are scrubbed. **Never sent:** OAuth tokens or secrets, passwords, e-mail, username, GUID, Yahoo player/team/league keys, league, team and manager names, image URLs, ownership percentages, ADP, Yahoo ranks. The leak guard refuses the whole context (general answer, "could not prepare a safe summary") if any key looks like a credential or identifier, any value looks like an e-mail, bearer token, JWT, URL, long token or Yahoo key, or the user's own username/e-mail or any team/league/manager name appears.

**Consent.** Off by default; the dialog (from server text) says what is sent, what never is, that Google's free service may use content to improve its products and that human reviewers may read it, that sharing is optional, revocable, that Yahoo's rules are still being clarified, and that turning it off does not remove what Google already received. Agreeing records the user's id, scope, text version and time; turning off sets a revoked time, effective for the next request. A new text version (bump `DISCLOSURE_VERSION`) asks everyone again. Mobile: bottom sheet that scrolls, 44 px buttons, labelled dialog, Escape/"Not now", focus handling. Consent is not stored in the browser.

**Transparency.** Each answer is tagged "General advice · no league data sent" or "Used your league: lineup, waivers · sent to Google Gemini". "See what was sent" shows, under that answer, the exact text the provider received; "Preview what would be sent" shows what the current question would send, using the same code path. A test proves preview, response and provider body are identical strings.

## 2. Tests

| Suite | Result |
|---|---|
| Server | **719 passed, 0 failed** (706 before hardening; +13) |
| Client | **69 passed, 0 failed** (64 before hardening; +5) |
| Yahoo probe (fake network) | 17 passed, 0 failed |
| Client production build | compiles |
| Local-PostgreSQL check of the new SQL (consent grant, upsert, revoke, version mismatch) and the OAuth cleanup (removes only expired rows, keeps live rows and active connections) | all passed against the **local** database; temporary rows removed (script lives only in the session scratch folder) |

New coverage, mapped to your list: **missing consent**, **revoked consent** (next request general), **disabled server switch** (including `true/1/yes/on/ALLOWED/empty`), **unauthorized league access** (user 2 cannot read user 1's cache entry; no Yahoo connection; forged keys), **malicious client payloads** (league objects with tokens, `sections`, `source`, `provenance`, array/object/`__proto__` contextRequest, SQL-looking and malformed keys, forged consent claims), **credential and identifier leakage** (workspace seeded with tokens, e-mail, GUID, Yahoo keys, URLs, names; value that looks like a token; error logs), **minimization** (golden field lists, section caps, 6 KB, no ownership/ADP/rank), **cold cache** (notice, one cache lookup, nothing else), **preview accuracy**, **free-tier disclosure** (server text and the rendered dialog, using the real server text), authentication on every route, consent per user, mobile/accessibility markup. The HTTP-level chat test (a gap I listed earlier) now exists: real express, JSON parsing and JWT authentication.

## 3. Yahoo request volume, and what is preserved
No Yahoo request is added: the chat endpoint only calls `cache.get`; a test and a source scan confirm the builder has no network or database import. Cache cleanup, OAuth cleanup, the 2-hour draft fallback, HTTP 999 protections, scoring and rankings, Yahoo attribution, general chat and the football restrictions are unchanged (their tests pass).

## 4. Outstanding risks (please read)
1. **Yahoo permission is unconfirmed.** Yahoo's terms bar disclosing Yahoo user data to third parties. Consent protects the user's choice, not ProGM's standing with Yahoo; the consequence could be revoked API access. Email v5 asks directly.
2. **Free-tier training and human review.** Content sent may be used by Google to improve products. Disclosed, but it is the weakest point against Yahoo's rules. The paid tier avoids it; you declined paid services.
3. **Pseudonyms are not anonymity.** "Team A" with a win-loss record and a roster is not identifiable to Google by itself, but the summary still describes a real league.
4. **Section selection is keyword-based.** An unusual phrasing gets only the overview (the model says so); a question mentioning several topics gets the first two matched. Wrong guesses reduce quality, not privacy.
5. **Cache dependency.** Personalization works only while the workspace is cached (5 min fresh plus 15 min stale). After a longer idle the user is asked to reload the league.
6. **Fail-closed false positives.** A player whose name equals a team or manager name, or a team named like a credential, makes the server withhold the league (general answer). Rare, safe.
7. **Mocked browser validation only.** 40 Chrome checks cover actual dialog/chat/router, focus trapping/restoration, mobile/desktop, light/dark contrast and consent revocation. Providers, consent DB and workspace were synthetic. Real-account, real-phone and screen-reader smoke checks remain before enabling.
8. **Typed text is the user's.** If a user types league details into the message, they are forwarded (as before).
9. **Rate limit** is in memory per server instance, as before.
10. **Production schema change:** startup creates additive `ai_data_consents`. Rehearse initialization/upgrade locally before production approval. Preserve the table and consent records during rollback; never drop/reset it as routine rollback.
11. **Old browser tabs:** valid legacy transcripts are accepted but historical turns discarded server-side. Malformed histories get 400. Only the current question and optional encrypted, user-bound general-only receipt can supply conversation; personalized responses never receive replayable receipts. General receipts expire after ten minutes or restart. Old saved ESPN chats are not restored or deleted. Personalization requests start fresh, including when denied/revoked/switched off.

## 5. Exact production activation steps (you perform them; I will not)
**Preconditions:** use the current OFF-rollout plan in `deployment-readiness.md`. Yahoo personalization activation is separate and blocked on a rights/permission decision and authenticated smoke-test approval. No email or snapshot deletion is authorized by this checklist.
1. Merge the branch by pull request and deploy **with `PROGM_AI_YAHOO_DATA` unset.** Startup creates the table.
2. Verify the feature is off: signed in, `GET /api/gm/consent` returns `{"available":false,"granted":false}`; Ask ProGM shows "Personalized answers are not available right now"; general chat answers.
3. Confirm `GEMINI_API_KEY` is present (Render Environment tab, names only; or Render Shell `[ -n "$GEMINI_API_KEY" ] && echo present || echo absent`).
4. When you separately authorize: Render, the service, Environment, add `PROGM_AI_YAHOO_DATA` = `allow` (exact lowercase), save (Render redeploys). `PROGM_AI_ESPN_DATA` stays unset.
5. Smoke test with your own account: open the basketball workspace, open Ask ProGM, confirm "Personalize with my Yahoo league: Off"; Turn on, read the dialog, agree; ask "Who should I start?"; check the tag says "Used your league: lineup" and open "See what was sent" (no names of your league or team, no keys, no tokens); try "Preview what would be sent"; Turn off, ask again, confirm "General advice · no league data sent". Optional: `SELECT user_id, disclosure_version, granted_at, revoked_at FROM ai_data_consents;` shows your grant and revoke.
6. Watch for a day: server logs (no errors), Gemini free-quota messages, Yahoo request counts per page load (unchanged).

**Rollback:** with approval, remove/change `PROGM_AI_YAHOO_DATA`; verify general-only behavior after restart/redeploy. Preserve all consent rows and retain hardened history validation. Do not deploy an older vulnerable chat implementation or drop/reset the table. Already-dispatched provider requests cannot be recalled. See the current deployment guide for safe code rollback gates.
