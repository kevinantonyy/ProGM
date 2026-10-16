# Experimental preseason injury and suspension logger

Status: **experimental, read-only, not wired into anything.** No production projection, ranking, route, database table or
Render setting uses it or was changed for it. Nothing in `server/src` or `client/src` imports it (a test enforces this).
Code: `server/src/injuryLog/`, CLI: `server/scripts/injuryLog.mjs`.

## What it does
It turns status data ProGM has **already fetched** into an append-only, timestamped log, so that later evaluations can ask
"what did we know about this player on date T?" without using anything learned afterwards.

* Input: local JSON files you already have. It makes **no network request**, uses **no database**, reads **no credentials**.
* Output: one JSON line per observed *change*, in a private directory outside the repository.
* Not used by projections or rankings. It is not a feature in any model. The earliest sensible use is descriptive (2026-27:
  did preseason "out" statuses explain the largest top-25 busts?); using it as a model input requires a full season of logs.

## Record (one line of `status-log.jsonl`)
| Field | Meaning |
|---|---|
| `schema` | `progm.injury-log.v1` |
| `observedAt` | When **we** recorded it. Stamped by the logger from the system clock at write time. Never supplied by input, never backdated |
| `source`, `playerId` | `yahoo` / `espn`, and a source-namespaced id such as `yahoo:5352` or `espn:4278073`. No league, team or user ids |
| `playerName` | Public name, for human verification only |
| `rawStatus` | The source's status code/text, verbatim (max 40 chars): `O`, `GTD`, `Day-To-Day`, ... |
| `status` | Normalized: `out`, `doubtful`, `questionable`, `available`, `suspended`, `unknown` |
| `reason` | Coarse category only: `injury`, `illness`, `rest`, `personal`, `suspension`, `other`, `unspecified` |
| `basis` | `reported`, or `absent-status` (Yahoo omits the status of a healthy player who is in the pool) |
| `sourceUrl` | https URL without credentials, query or fragment (ESPN: the feed URL). `null` when the source gives none (Yahoo) |
| `sourcePublishedAt` | Publish time the source claims, **evidence only**; dropped if invalid or later than `observedAt`. Never decides availability |
| `noteSha256`, `noteLength` | SHA-256 and length of the source note. The note text itself is **not stored** (see below) |
| `contentHash` | SHA-256 of the source evidence (excludes `observedAt`, so identical evidence hashes identically) |
| `recordId` | SHA-256 of the whole record; `verify` and the reader reject any line that was edited |
| `mappingVersion` | Version of the status table used (`progm.injury-status-map.v1`) |

### Deterministic status mapping (v1)
A fixed table in `statusMap.js`; no model, no scoring. Case, spaces, `-` and `_` are ignored.

| normalized | source values |
|---|---|
| out | O, OUT, INJ, IL, IL+, IR, OFS, NA, Out For Season, Out Indefinitely, Not Active, Inactive, Injured (Reserve/List) |
| doubtful | D, Doubtful |
| questionable | Q, Questionable, GTD, Game Time Decision, DTD, Day-To-Day, P, Probable |
| available | Healthy, Active, Available (and Yahoo's absent status, `basis: absent-status`) |
| suspended | SUSP, Suspended, Suspension; also a status that maps to `out` whose note contains suspend/suspended/suspension |
| unknown | everything else (never guessed) |

Probable and day-to-day are deliberately *questionable*, not *available*. Changing the table requires a new `mappingVersion`.

### What is deliberately not stored
Free-text notes (they carry diagnoses and body parts) are hashed, not stored. The `reason` category and the hash are
the only trace. `--note-excerpt` stores the first 120 characters if you decide you need verifiable text; it is off by default.
Every record is scanned before writing and refused if it contains a Yahoo league or team key, a credential, a cookie or an
e-mail address.

## Rules the code enforces
1. **Append-only.** The module has no update or delete function; writes use an append-mode file handle.
2. **Change-only.** A record is written only if (source, raw status, normalized status, reason, mapping version) differs from
   that player's latest record. An identical re-run writes nothing. A note-only change is not a change.
3. **No backdating.** `observedAt` comes from the clock when the batch is written. Input that carries `observedAt` or
   `availableAt` is rejected. If the clock is earlier than the newest record in the log, nothing is written.
4. **No leakage.** The readers (`statusAsOf`, `snapshotAsOf`, `recordsAsOf`) require an explicit `asOf` and return only records
   with `observedAt <= asOf` (same convention as `availableAt` in `backtest/pointInTime.js`). A report published on
   1 Sep but logged on 20 Oct is invisible to a forecast made on 10 Oct. Missing or invalid `asOf` throws. There is no
   default of "now". Results are frozen copies.
5. **Safe failure.** Malformed rows are rejected individually with a reason; a corrupt, truncated or hand-edited line is
   skipped and counted; I/O errors return `{ok:false}`; the CLI exits non-zero and writes nothing on a bad input file.
6. **Private location.** The log directory must be outside any Git work tree, or inside `<repo>/.progm-private/`
   (listed in `.gitignore`). Any other location inside the repository is refused.

## Manual Yahoo logging routine (Windows PowerShell)
This is the agreed collection method: **you run it by hand, using Yahoo data ProGM has already loaded.** Nothing is scheduled,
nothing is fetched automatically, and no extra request is made to Yahoo or anyone else.

### What this routine does and does not collect
* **Yahoo only.** ESPN is **not** collected under this routine. The app keeps the ESPN feed in memory and never saves it, and
  this routine adds no fetching. (The logger can read an ESPN file with `--espn`, but nothing here produces one.)
* **Yahoo draft-board rows contain a status but no injury note.** Each saved row gives `playerKey`, `name` and `status`
  (for example `O`, `GTD`, `INJ`). There is no `injuryNote` or `statusFull`, so every record's `reason` is `unspecified`.
  The status and when it was observed are what the log preserves.
* **Missed runs cannot be reconstructed.** A record's time is when the logger ran. If you skip a day, nothing from that day
  exists, and a later run cannot be backdated to fill it. A status that changed and changed back between two runs is never seen.
  A later run only records what Yahoo shows at that moment.

### Schedule
| Period | Runs |
|---|---|
| Preseason (from now until opening night) | Once a day, plus one extra run on the day before and the morning of opening night |
| Regular season, game days | Twice: midday and early evening ET (after injury designations are updated) |
| Regular season, off days | Once |
| Weekly | `verify` (see below) |
| Monthly | Private backup (see below) |

Skipped runs are harmless to the log's integrity. They only mean gaps.

### One-time setup (separate worktree; your current branch is not touched)
Node 20+ is required. No `npm install` is needed for the logger. Replace `C:\path\to\ProGM` with your clone.

```powershell
cd C:\path\to\ProGM
git fetch origin feature/injury-logger
git worktree add --detach ..\ProGM-injury-logger origin/feature/injury-logger
cd ..\ProGM-injury-logger\server
node --test src\injuryLog\injuryLog.test.js
```

To pick up a later version of the branch, run `git fetch origin feature/injury-logger`, then
`git -C ..\ProGM-injury-logger checkout --detach origin/feature/injury-logger`. To remove the worktree:
`git worktree remove ..\ProGM-injury-logger` (your log is stored elsewhere and is not deleted).

### Each run
1. Sign in to ProGM and load the Basketball workspace page.
2. In the browser DevTools **Network** tab, find the request whose URL ends in `/basketball/workspace`. Open **Response**, copy
   the whole response (**Copy response**; do not use "copy as cURL" or "copy URL", which can contain league keys or cookies).
3. Save it as valid UTF-8 JSON **without a byte-order mark**. The most reliable way from PowerShell is:

```powershell
[System.IO.File]::WriteAllText("$HOME\workspace-response.json", (Get-Clipboard -Raw), (New-Object System.Text.UTF8Encoding $false))
```

   Avoid `>`, `Out-File` and `Set-Content` in Windows PowerShell 5.1: they write UTF-16 or add a BOM, and the file is then rejected.
4. Check the file is valid JSON and has a draft board (nothing is written by these checks):

```powershell
cd C:\path\to\ProGM-injury-logger\server
node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('valid JSON; draft-board rows:',(j.draftBoard&&j.draftBoard.board||[]).length)" $HOME\workspace-response.json
node scripts\injuryLog.mjs record --yahoo $HOME\workspace-response.json --dry-run
```

5. Record it:

```powershell
node scripts\injuryLog.mjs record --yahoo $HOME\workspace-response.json
```

   Read the output: `written` is the number of new status changes, `duplicates` the players unchanged since their last record.
   The first run writes one baseline record per player in the board (740 on the first real run); later runs usually write few or none. `written: 0` is normal.
6. Do not commit, share or upload `workspace-response.json`: it contains your league data. Delete it when you are done if you
   prefer; the logger keeps only player keys, names and statuses.

The log is written to `%LOCALAPPDATA%\ProGM\injury-log\status-log.jsonl` (override with `--dir` or `PROGM_INJURY_LOG_DIR`).

### What "out" means in the summary
`summary` counts **normalized** statuses. `out` is not only injuries: under the v1 table it includes every Yahoo code that
maps to `out`, notably **`NA` (Not Active)**, which Yahoo uses for players who are inactive for non-injury reasons (for example
unsigned, waived, two-way or G League assignments), as well as `O`, `INJ`, `IL`, `IL+`. The mapping follows the app's existing
`OUT_STATUSES`. The raw code is always stored in `rawStatus`, so nothing is lost. To see what is behind the `out` count:

```powershell
cd C:\path\to\ProGM-injury-logger\server
node scripts\injuryLog.mjs summary --as-of 2099-01-01T00:00:00Z --by-raw-status
node scripts\injuryLog.mjs summary --as-of 2099-01-01T00:00:00Z --list-raw NA
```
`--by-raw-status` shows lines such as `out <- NA` and `out <- INJ`; `--list-raw <CODE>` lists the players with that raw code.
Both are read-only. The mapping is changed only with evidence from these breakdowns, and any change gets a new `mappingVersion`
(old records keep the version they were written with).

### Weekly verification
```powershell
cd C:\path\to\ProGM-injury-logger\server
node scripts\injuryLog.mjs verify
node scripts\injuryLog.mjs summary --as-of 2099-01-01T00:00:00Z
```
`verify` must print `"ok": true` with no entries under `invalid` and `nonMonotonic: 0` (exit code 0). `summary` shows the current
count of players by status. `--as-of` is mandatory; the far-future date means "everything recorded so far". Look up one player
at a past date with `node scripts\injuryLog.mjs status --player yahoo:5352 --as-of <ISO time>`.

### Monthly private backup
Copy the log to a location that is **not** inside the repository, such as an external drive or a private cloud folder
(the file is a private player log; do not put it in Git or a public share).

```powershell
$src = "$env:LOCALAPPDATA\ProGM\injury-log\status-log.jsonl"
$dst = "D:\ProGM-backups"          # change to your private backup folder
New-Item -ItemType Directory -Force $dst | Out-Null
$copy = Join-Path $dst ("status-log-" + (Get-Date -Format "yyyy-MM-dd") + ".jsonl")
Copy-Item $src $copy
(Get-FileHash $src).Hash -eq (Get-FileHash $copy).Hash      # must print True
```
To verify a backup, copy it into an otherwise empty folder under the name `status-log.jsonl` and run
`node scripts\injuryLog.mjs verify --dir <that folder>`. Keep at least the last three monthly copies. Never edit the log by hand:
`verify` rejects altered lines.

### Troubleshooting
| Symptom | Cause and fix |
|---|---|
| `Could not read input: Unexpected token ... is not valid JSON` | The file is not plain UTF-8 JSON: a BOM or UTF-16 from `>`/`Out-File`, a truncated copy, or an HTML error page. Re-save with the `WriteAllText` command above and run the validity check in step 4 |
| `The --yahoo file is not a player array, {players}, or a saved workspace response with draftBoard.board` | You copied the wrong request or an empty response. Use the `/basketball/workspace` response. Step 4 should print a non-zero row count |
| `read` is much lower than expected, or `skippedInputRows.yahoo` is large | Rows without a Yahoo player id are skipped (never guessed). Check the response is the full workspace one |
| `written: 0, duplicates: N` | Nothing changed since the last run. This is normal |
| `Nothing was written. clock-behind-log` | The PC clock is earlier than the newest record (clock changed or reset). Fix the system time, then re-run. The logger will not write backdated records, and the log is never altered to make room |
| `Nothing was written. unsafe-directory` | `--dir` or `PROGM_INJURY_LOG_DIR` points inside a Git work tree. Use a folder outside the repo (the default is fine) |
| `Nothing was written. io-error` | The folder is not writable, the disk is full, or the path is under a file. Check permissions and free space |
| `verify` shows `invalid` lines | A line is unparseable, was edited, or a write was cut short (for example power loss). Those lines are ignored by readers and are reported, not repaired. Restore the last good backup and compare. A truncated final line is harmless; the next run starts on a fresh line |
| `verify` shows `nonMonotonic` greater than 0 | Records are out of time order, which a normal run cannot produce. Treat the log as suspect and compare with the latest backup |
| `node` is not recognised | Install Node 20+ and open a new PowerShell window |
| `git worktree add` says the path already exists | The worktree is already set up. `cd` into it and use `git -C` to update it as above, or choose a different folder name |
| `git worktree add` fails after you deleted the folder by hand | Run `git worktree prune`, then add it again |
| Tests fail on Windows | Send the output. Two Windows-only failures found in the first run (CRLF `.gitignore` check and path separators in the default-directory test) were fixed; the suite is otherwise developed on Linux |

## Limits you should know about
* **ESPN is not collected.** The app fetches the ESPN injuries feed and caches it in memory only, so there is no existing
  file for the logger to read. Making ProGM write one would change production code, and the manual routine adds no fetching.
  ESPN records exist only if you supply a file yourself.
* **The saved Yahoo draft-board rows carry `status` but not `injuryNote`/`statusFull`**, so `reason` is `unspecified` for
  them. The status and its timing are what matter for the planned analysis.
* **Healthy is only inferred for Yahoo pool rows** (Yahoo omits `status` when healthy). ESPN lists only injured players, so a
  player disappearing from that feed is not recorded as recovered; a stale ESPN `out` stays until a new report replaces it.
  Consumers should check `observedAt` age on the record they get back.
* **Observation time is when the logger ran, not when the news broke.** News that reached ProGM late is stamped late. This
  is conservative for leakage and means the log cannot reconstruct what was knowable earlier.
* **Concurrency:** two logger runs at the same instant could each write the same change. This costs a duplicate line, not
  corrupted history. Run one at a time.
* **Terms of use not verified.** Whether Yahoo, ESPN or NBA.com terms allow retaining status history is unresolved (see
  `data-sources-licensing.md`). The log is local and private; do not publish it.
* Name matching between Yahoo and ESPN ids is not attempted, so a player can appear under both `yahoo:` and `espn:` ids.
