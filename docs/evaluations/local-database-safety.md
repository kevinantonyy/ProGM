# Local database safety for shadow-mode testing

## What server startup executes (`server/src/db/connection.js` `initDatabase`, unchanged vs main)
Only DDL, no DML (no INSERT/UPDATE/DELETE, no TRUNCATE/DROP TABLE), and no background jobs or timers start with the server:
1. `CREATE TABLE IF NOT EXISTS` x5 (users, yahoo_connections, yahoo_oauth_states, yahoo_pending_connections, espn_connections) - no-op if present.
2. `ALTER TABLE yahoo_oauth_states ALTER COLUMN user_id DROP NOT NULL` - idempotent, brief exclusive lock, no data change.
3. `ALTER TABLE espn_connections ADD COLUMN IF NOT EXISTS sport ...` and `... league_data ...` - no-op if present; otherwise adds a defaulted column (existing rows get the default).
4. `DO $$ ... DROP CONSTRAINT espn_connections_pkey ... $$` - runs only if that primary key still exists on a single column. This is the one statement that can change an existing table's constraints (rows untouched).
5. `CREATE UNIQUE INDEX IF NOT EXISTS espn_connections_user_sport_idx ON espn_connections(user_id, sport)` - no-op if present; would fail (not alter data) if duplicates existed.
The same code runs on every Render deploy, so a production database that has been deployed with this code is already in the end state and every statement above is a no-op. Without requests, nothing reads or writes Yahoo tokens. Neon's own dashboard (branch history / monitoring) is the only way to prove nothing differed.

## Guards added
- `PROGM_REQUIRE_LOCAL_DB=on` makes `db/connection.js` throw before a pool is created if `DATABASE_URL` or `DATABASE_URL_UNPOOLED` has a non-local host. Default off, so production is unaffected.
- `npm run shadow:local` (`scripts/shadowStart.mjs`) sets the guard and the shadow/diagnostic flags and PORT=3005, runs the preflight, and only then starts the server in the same process.
- The pool uses `DATABASE_URL_UNPOOLED` first, then `DATABASE_URL`: override BOTH.
- dotenv never overrides variables already set in the process, so `$env:` values beat `server\.env` without editing it.
