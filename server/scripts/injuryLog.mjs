// Experimental, read-only preseason injury/suspension logger.
// Reads status data ProGM has ALREADY fetched (saved local JSON files). Makes no network request, no database access,
// and imports nothing from projections or rankings. Writes only to a private local directory.
//
//   node scripts/injuryLog.mjs record [--yahoo <file.json>] [--espn <file.json>] [--dir <path>] [--note-excerpt] [--dry-run]
//   node scripts/injuryLog.mjs verify [--dir <path>]
//   node scripts/injuryLog.mjs status --player <yahoo:ID|espn:ID> --as-of <ISO time> [--dir <path>]
//   node scripts/injuryLog.mjs summary --as-of <ISO time> [--by-raw-status] [--list-raw <CODE>] [--dir <path>]
import fs from 'node:fs';
import { appendObservations, readLog, snapshotAsOf, statusAsOf, verifyLog } from '../src/injuryLog/store.js';
import { fromEspnInjuries, fromYahooPlayers, yahooRowsFromFile } from '../src/injuryLog/ingest.js';
import { defaultLogDir } from '../src/injuryLog/paths.js';

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const [command, ...rest] = process.argv.slice(2);
const flags = {}; const bools = new Set(['--note-excerpt', '--dry-run', '--by-raw-status']);
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (!a.startsWith('--')) { console.error(`Unexpected argument: ${a}`); process.exit(2); }
  if (bools.has(a)) flags[a] = true;
  else { if (i + 1 >= rest.length) { console.error(`Missing value for ${a}`); process.exit(2); } flags[a] = rest[++i]; }
}
const dir = flags['--dir'] || defaultLogDir();
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

function loadJson(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_INPUT_BYTES) throw new Error(`${file} is larger than ${MAX_INPUT_BYTES} bytes`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (command === 'record') {
  if (!flags['--yahoo'] && !flags['--espn']) die('Give at least one of --yahoo <file.json> or --espn <file.json>.', 2);
  const observations = []; const skipped = {};
  try {
    if (flags['--yahoo']) {
      const rows = yahooRowsFromFile(loadJson(flags['--yahoo']));
      if (!rows) die('The --yahoo file is not a player array, {players}, or a saved workspace response with draftBoard.board.');
      const r = fromYahooPlayers(rows); observations.push(...r.observations); skipped.yahoo = r.skipped.length;
    }
    if (flags['--espn']) {
      const r = fromEspnInjuries(loadJson(flags['--espn']));
      observations.push(...r.observations); skipped.espn = r.skipped.length;
      if (!r.observations.length && r.skipped.length) die(`The --espn file was not recognised (${r.skipped[0].reason}).`);
    }
  } catch (e) { die(`Could not read input: ${e.message}`); }
  const res = appendObservations(dir, observations, { keepExcerpt: Boolean(flags['--note-excerpt']), dryRun: Boolean(flags['--dry-run']) });
  if (!res.ok) die(`Nothing was written. ${res.error.code}: ${res.error.message}`);
  const rejectedByReason = {};
  for (const r of res.rejected) rejectedByReason[r.reason] = (rejectedByReason[r.reason] || 0) + 1;
  console.log(JSON.stringify({ observedAt: res.observedAt, dryRun: res.dryRun, read: observations.length, written: res.written, duplicates: res.duplicates, rejected: rejectedByReason, skippedInputRows: skipped, warnings: res.warnings.length, invalidLinesInLog: res.invalidLinesInLog, logDirectory: dir }, null, 2));
} else if (command === 'verify') {
  const v = verifyLog(dir);
  if (v.error) die(`${v.error.code}: ${v.error.message}`);
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.ok ? 0 : 1);
} else if (command === 'status' || command === 'summary') {
  const asOf = flags['--as-of'];
  if (!asOf || !Number.isFinite(Date.parse(asOf))) die('--as-of <ISO time> is required (the log has no default view of "now" so forecasts cannot read later data by accident).', 2);
  let records;
  try { records = readLog(dir).records; } catch (e) { die(`Could not read the log: ${e.message}`); }
  if (command === 'status') {
    if (!flags['--player']) die('--player <yahoo:ID|espn:ID> is required.', 2);
    const r = statusAsOf(records, flags['--player'], asOf);
    console.log(JSON.stringify(r ? { asOf, status: r.status, rawStatus: r.rawStatus, reason: r.reason, source: r.source, observedAt: r.observedAt, sourceUrl: r.sourceUrl, contentHash: r.contentHash } : { asOf, status: null, note: 'No observation had been recorded by this time.' }, null, 2));
  } else {
    const snap = [...snapshotAsOf(records, asOf).values()];
    const counts = {}; for (const r of snap) counts[r.status] = (counts[r.status] || 0) + 1;
    const out = { asOf, players: snap.length, byStatus: counts };
    // Read-only diagnostics: how each normalized status breaks down by the source's raw code (null raw = absent Yahoo status).
    if (flags['--by-raw-status']) {
      out.byRawStatus = {};
      for (const r of snap) { const k = `${r.status} <- ${r.rawStatus ?? '(none: absent status)'}`; out.byRawStatus[k] = (out.byRawStatus[k] || 0) + 1; }
    }
    if (flags['--list-raw']) {
      const want = flags['--list-raw'].trim().toUpperCase();
      out.listRaw = { rawStatus: want, players: snap.filter((r) => (r.rawStatus ?? '').toUpperCase() === want).map((r) => ({ playerId: r.playerId, name: r.playerName, status: r.status })).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
    }
    console.log(JSON.stringify(out, null, 2));
  }
} else die('Usage: node scripts/injuryLog.mjs <record|verify|status|summary> [options]. See docs/evaluations/injury-logger.md', 2);
