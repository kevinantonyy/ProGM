# Controlled hardening rollout — personalization OFF

Updated 2026-10-22. Branch: `release/progm-hardening` (minimal production release cut from `origin/main`; this guide was written on `research/projection-v2-data-rights`, which keeps the research history). See [release-progm-hardening.md](release-progm-hardening.md) for exactly what this branch contains.
**Planning only: no push, merge, deployment, production database access, Render changes, emails or snapshot deletion performed.**
This replaces the earlier rollout/deletion checklist. Historical snapshot inventory remains in [data-handling-final-review.md](data-handling-final-review.md); leave those files alone pending separate approval.

## Verified candidate and release boundary

- Tested hardening code: research commits `cc27934` (hardening) and `e091731` (test fix), carried into this branch with one change (the football negotiator gate, below). Release the head of this branch, not `8db9a88` alone: that consent implementation still has the crash/history-replay defects.
- This is a **locally verified candidate**, not a production-verified deployment. The current Render deployment and its health were not inspected. Record the operator-confirmed healthy deployment SHA before release; do not invent a rollback SHA.
- This branch contains only the production changes (attribution, cache/OAuth cleanup, draft polling, consent schema/UI, chat validation/privacy). Projection Engine V2 and all research material are excluded. Review the entire diff against the actual release base.
- Keep `PROGM_AI_YAHOO_DATA` unset or non-`allow`; keep `PROGM_AI_ESPN_DATA` unset. The Yahoo switch is **global**, not account-scoped; individual consent is an additional gate, not an account rollout allowlist. Build the client with `VITE_PROGM_TRADE_NEGOTIATOR` **unset**: that keeps the football AI trade negotiator paused (it would otherwise put the selected ESPN players and trade partner into the question sent to Gemini).
- Projection Engine V2 stays disconnected. Do not enable research/ranking flags. No ranking, projection, expected-games or recommendation formula changed.

## Database migration and rehearsal — required before production approval

`server/src/db/connection.js:initDatabase()` already includes this additive, idempotent table:

```sql
CREATE TABLE IF NOT EXISTS ai_data_consents (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope VARCHAR(40) NOT NULL,
  disclosure_version INTEGER NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, scope)
);
```

Scope: `yahoo_league_gemini`; current disclosure version: 1. Grant/upsert replaces the version/time and clears revocation; revoke sets `revoked_at`. This is one current-choice row per user/scope, **not an append-only audit log**. No transcript/provider payload is stored in this table.

1. Obtain approval for an isolated local PostgreSQL rehearsal database and credentials. Use synthetic users, no production dump or connection. Explicitly set **both** `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to that verified local database; credentials belong in ignored configuration or a secure prompt, never terminal output/history. Set `PROGM_REQUIRE_LOCAL_DB=on` and verify the guard.
2. Rehearse an empty database and an authorized schema-only fixture matching the deployed schema. Startup also runs existing Yahoo/ESPN CREATE/ALTER/index statements, **not just the consent CREATE**; review compatibility and privileges. The whole startup sequence is not transactional.
3. From `server`, in the isolated environment, initialize twice to check idempotence:

   ```powershell
   node --input-type=module -e "const {default:db,initDatabase}=await import('./src/db/connection.js');try{await initDatabase();await initDatabase()}finally{await db.end()}"
   ```

4. Verify columns, composite key, foreign key and scoped permissions. Exercise grant, repeat grant, wrong-version denial and revoke using a synthetic user and real `createConsentStore`. Reinitialize and verify that choice survives. Rehearse rollback without deleting consent records.
5. Locally only, verify OAuth cleanup removes expired synthetic state/pending rows but preserves live rows and connections. Boot the app, check `/api/health`, test general chat with mocked Gemini, stop cleanly. No Yahoo/Gemini calls are required.
6. Record evidence; separately approve production backup/recovery and migration window. On 2026-10-22 a local rehearsal on a throwaway PostgreSQL 18 cluster (127.0.0.1, scratch data directory, no production access) passed 23 checks: upgrade from main's schema adds only `ai_data_consents`, repeat initialization is idempotent, key/foreign-key shape, grant/repeat/wrong-version/revoke/re-grant, survival across re-initialization, OAuth cleanup removing only expired rows, cascade on user delete, and main's code starting cleanly with the table present. It did **not** cover the production role's privileges or a schema-only copy of the deployed database; both remain required.

## Approval-gated rollout

1. Review the tested SHA, entire release diff and isolated rehearsal. Capture the currently healthy Render SHA and recovery point through authorized operator checks.
2. Operator checks masked variable presence only: Yahoo/ESPN sharing OFF, credentials unchanged, research flags unchanged/off. Do not send chat from unreviewed old production code merely to inspect Gemini configuration.
3. With explicit approval, merge/push the reviewed candidate and deploy outside a live draft. Production DB access and Render changes need separate approval.
4. Confirm Render's deployed SHA equals the approved artifact and status is Live. Check `GET /api/health` returns 200; inspect startup/migration/cleanup errors without exposing secrets or row contents. Health alone does not prove chat or migration correctness.
5. Authenticated smoke: `/api/gm/consent` returns `available:false,granted:false`; UI offers general chat only. Malformed authenticated chat returns 400, then valid chat still works. Basketball/football replies report no league context shared. Check attribution and existing rankings/draft UI without increasing polling. Actual Gemini/Yahoo smoke calls need separate approval and existing free quota; otherwise use mocks.
6. Watch existing logs/request counts for 30 minutes. Verify HTTP 999 backoff persists, cached picks are labelled stale and expire, OAuth cleanup has no new errors. Do not replay calls simply to generate traffic.

## Rollback — preserve privacy fixes and consent

- For personalization trouble, unset/change the Yahoo switch away from `allow`, **only with operator approval**; restart/redeploy, verify `available:false` and general-only replies. Revocation stays available while disabled. Already-dispatched requests and data Google received cannot be recalled.
- Prefer retaining hardened code with sharing OFF and rolling forward. Do **not** revert to a version that shares ESPN/Yahoo history automatically or trusts browser assistant turns.
- For code rollback use the recorded, reviewed privacy-safe artifact with sharing OFF. If none is established, do not label an older commit safe; choose controlled recovery/maintenance.
- **Keep `ai_data_consents` and every consent record. Never DROP, truncate, reset or restore an older copy as routine rollback.** Older compatible code may leave the additive table unused. Re-enabling must honor current version/revocation, never blanket regrant.
- Expired cache/OAuth cleanup is irreversible, not undone on rollback. Active Yahoo connections and consent records are not cleanup deletion targets. Local research snapshots remain untouched.

## Verification and remaining gates

On this branch: 699/699 server tests (the research branch's 719 includes 20 Projection V2 tests), 70/70 client tests, production client build and `git diff --check` pass. The 17 mocked Yahoo probe tests live with the research tooling and pass on the research branch; the probe is not part of this release. 40 Chrome checks use actual chat/dialog/router with synthetic consent/cache/provider data, desktop/mobile and light/dark. No authenticated Yahoo, real Gemini, database or Render test was performed.

See [consent-based-gemini-hardening.md](consent-based-gemini-hardening.md). Ready for **isolated rehearsal and controlled OFF-rollout review**, not unconditional production deployment. Enabling personalization needs a separate rights/permission decision; user consent does not establish Yahoo's permission.
