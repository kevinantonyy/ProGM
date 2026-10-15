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

## Diagnostics security (audited)
- Both ranking diagnostics (`ranking-compare`, `ranking-shadow`) share one guard: 404 unless `PROGM_RANKING_DIAGNOSTIC=on` exactly;
  closed in `NODE_ENV=production` unless `PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION=yes` is also set; JWT required (401);
  `leagueKey`/`teamKey` must be well formed and the team must belong to the league (400); `Cache-Control: no-store`.
- Ownership: data is read only from cache keys containing the authenticated user's id. An entry exists only if that user's
  own Yahoo token built the workspace for that league, so another user always gets 409 with no data.
- Responses carry player names and numbers only (tested: no league key, team key, token, or team name).
- Shadow is only computed when shadow AND diagnostics are both enabled.
- Known, unchanged behavior outside this scope: `/workspace` accepts any well-formed `teamKey` the caller supplies (Yahoo still enforces league access).

## Local test with your authenticated Yahoo league (Windows PowerShell)

### 0. WARNING: production database
The server runs `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` on startup and writes or refreshes your Yahoo tokens in the
database named by `DATABASE_URL` (and deletes the saved Yahoo connection if a refresh is rejected). If `server\.env`
(or your shell) points `DATABASE_URL` at Render/Neon/any hosted database, **do not start the server**. Use a local Postgres.
`node scripts\shadowPreflight.mjs` checks this and refuses (exit 1) on any non-local host. It prints hosts only.
Also: `YAHOO_REDIRECT_URI` must be a localhost callback registered on a Yahoo app you control; the production callback
(`https://progm.onrender.com/...`) would send sign-in to production. If you have no localhost redirect registered, stop here.

### 1. Preflight and start the server (terminal 1)
```powershell
cd <repo>\server
# Optional local Postgres if you have none (Docker Desktop):
#   docker run --name progm-local-pg -e POSTGRES_PASSWORD=local -e POSTGRES_DB=progm -p 5432:5432 -d postgres:16
#   then in .env: DATABASE_URL=postgres://postgres:local@localhost:5432/progm
Remove-Item Env:PROGM_RANKING_MODEL, Env:PROGM_ROOKIE_ESTIMATES -ErrorAction SilentlyContinue
node scripts\shadowPreflight.mjs          # must print "Preflight OK"; otherwise STOP
$env:PORT = "3005"                         # the Vite dev proxy expects 3005
$env:PROGM_RANKING_SHADOW = "on"
$env:PROGM_RANKING_DIAGNOSTIC = "on"
npm start
```
### 2. Start the client (terminal 2)
```powershell
cd <repo>\client
npm run dev
```
### 3. Sign in and trigger one shadow calculation
1. Open http://localhost:5173 and log in (register a local account if the local database is new).
2. Settings -> connect Yahoo and approve. Pick your NBA league.
3. Open the Draft Helper once. That single normal workspace load triggers the shadow; it adds no Yahoo request.
4. Terminal 1 shows `[ranking-shadow] ok players=... top50=../50 anomalies=0 ms=..`.
5. Browser DevTools -> Network: click the `workspace?leagueKey=...&teamKey=...` request and copy its **Request URL**.

### 4. Retrieve and save sanitized diagnostics to your Desktop (terminal 3)
```powershell
Add-Type -AssemblyName System.Web
$workspaceUrl = Read-Host "Paste the workspace Request URL"
$q = [System.Web.HttpUtility]::ParseQueryString(([uri]$workspaceUrl).Query)
$league = $q["leagueKey"]; $team = $q["teamKey"]
$cred = Get-Credential -Message "Your LOCAL ProGM login (not Yahoo)"
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3005/api/auth/login -ContentType "application/json" -Body (@{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.token)" }
$out = Invoke-RestMethod -Headers $h -Uri "http://localhost:3005/api/basketball/diagnostics/ranking-shadow?leagueKey=$league&teamKey=$team"
$json = $out | ConvertTo-Json -Depth 20
if ($json -match '\d+\.l\.\d+|Bearer|eyJ|token') { throw "Output contains an identifier or token pattern - not saving." }
$json | Set-Content -Encoding UTF8 "$env:USERPROFILE\Desktop\progm-shadow-diagnostics.json"
Remove-Variable cred, login, h, workspaceUrl, league, team
```
(If your Desktop is redirected to OneDrive use `[Environment]::GetFolderPath("Desktop")` in place of `$env:USERPROFILE\Desktop`.)
If the endpoint answers 409 the workspace was cached before shadow was on: reload the Draft Helper with Refresh once and repeat step 4.

### 5. Disable afterward
```powershell
# Ctrl+C in terminal 1 and 2, then:
Remove-Item Env:PROGM_RANKING_SHADOW, Env:PROGM_RANKING_DIAGNOSTIC, Env:PORT -ErrorAction SilentlyContinue
```
The result lives only in server memory (5 minute TTL). Disconnect Yahoo in Settings if you want the local tokens removed.

### Check before sharing the file
`ok: true`; `visibleRankingModel: "legacy"`; `anomalies` empty or explained; `crossCheck.mismatched: 0`; `topOverlap`;
`movers`; `byPosition`; `highlighted`. Open the file and read it first.

## Not covered
The live-draft recommendations route (`/api/basketball/draft`) has no shadow; it still uses legacy only.
