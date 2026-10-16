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

## Run it on Windows (PowerShell)
Node 20+ is required (the repo already needs it). No `npm install` step is needed for the logger itself.

1. Save the data ProGM already fetched. For Yahoo, use the same saved workspace response you used for
   `snapshotCompare.mjs` (the response of the `/basketball/workspace` request). The logger reads only each draft-board
   row's `playerKey`, `name` and `status`; league/team data, rosters and owner names in the file are ignored. A plain JSON array of
   players (`playerKey`/`editorialPlayerKey`/`playerId`, `status`, `statusFull`, `injuryNote`) also works.
2. Record an observation (from the repo's `server` folder):

       cd C:\path\to\ProGM\server
       node scripts\injuryLog.mjs record --yahoo $HOME\workspace-response.json

   Optional: `--espn <file.json>` (the ESPN league injuries payload or the list produced by `mapEspnInjuries`),
   `--dry-run` (show counts, write nothing), `--note-excerpt`, `--dir <path>`.
3. Where the data goes (by default, `%LOCALAPPDATA%\ProGM\injury-log\status-log.jsonl`, i.e. `C:\Users\<you>\AppData\Local\ProGM\injury-log`). Override with `--dir` or the `PROGM_INJURY_LOG_DIR` environment variable.
4. Run it once a day through the preseason, and again right before the season opens. Re-running with nothing changed is safe and writes nothing.
5. Check integrity and query it:

       node scripts\injuryLog.mjs verify
       node scripts\injuryLog.mjs summary --as-of 2026-10-20T00:00:00Z
       node scripts\injuryLog.mjs status --player yahoo:5352 --as-of 2026-10-20T00:00:00Z

   `--as-of` is mandatory. Exit codes: 0 ok, 1 failure (nothing written), 2 usage error.

Run the tests: `cd server; node --test src/injuryLog/injuryLog.test.js` (or `node --test` for the whole suite).

## Limits you should know about
* **The app does not save the ESPN feed.** The injuries feed is fetched and cached in memory only, so there is no existing
  file for the logger to read. Making ProGM write one would change production code and is out of scope. Until you decide
  that, ESPN records exist only if you supply a file. The Yahoo path works today from the saved workspace response.
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
