/**
 * Append-only JSONL status log + point-in-time reader.
 *
 * Guarantees:
 *  - Records are only ever appended; this module has no update or delete.
 *  - `observedAt` is stamped here from an injected clock at write time. Callers cannot supply or alter it, and a clock
 *    that is earlier than the newest record in the log refuses the write (no backdating).
 *  - Readers must pass an explicit `asOf`; records observed after it are invisible. Publication time claimed by a
 *    source is stored as evidence but never decides availability.
 *  - Failures return {ok:false} and write nothing; a corrupt or tampered line is skipped and reported, never trusted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildRecord, stateKeyOf, validateStoredRecord } from './record.js';

export const LOG_FILE = 'status-log.jsonl';
export const PRIVATE_DIR_NAME = '.progm-private';

function fail(code, message) { return { ok: false, error: { code, message } }; }

/** Walk up from `start` to the directory holding `.git`; null when not inside a work tree. */
export function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The log may live anywhere outside a Git work tree, or inside `<repo>/.progm-private/` (gitignored). Any other
 * location inside a work tree is refused so a status log can never be committed by accident.
 */
export function checkLogDir(dir) {
  const resolved = path.resolve(dir);
  const root = findRepoRoot(resolved);
  if (!root) return { ok: true, dir: resolved };
  const rel = path.relative(root, resolved);
  const first = rel.split(path.sep)[0];
  if (first === PRIVATE_DIR_NAME) return { ok: true, dir: resolved };
  return { ok: false, error: { code: 'unsafe-directory', message: `Refusing to store the log inside a Git work tree (${root}). Use a directory outside it, or ${PRIVATE_DIR_NAME}/ which is gitignored.` } };
}

/** @returns {{records:object[], invalid:{line:number, reason:string}[]}} valid records in file order. Missing file => empty. */
export function readLog(dir) {
  const file = path.join(dir, LOG_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { records: [], invalid: [] }; throw e; }
  const records = []; const invalid = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch { invalid.push({ line: i + 1, reason: 'unparseable-json' }); return; }
    const problem = validateStoredRecord(parsed);
    if (problem) invalid.push({ line: i + 1, reason: problem }); else records.push(parsed);
  });
  return { records, invalid };
}

const keyOf = (r) => r.playerId; // playerId is source-namespaced (e.g. "espn:123"), so it already identifies the source

/**
 * Observe a batch. Every written record gets the same `observedAt` = clock() at the time of this call.
 * @param {string} dir
 * @param {object[]} observations see buildRecord
 * @param {{clock?:()=>Date|number|string, keepExcerpt?:boolean, dryRun?:boolean}} [opts]
 */
export function appendObservations(dir, observations, { clock = () => new Date(), keepExcerpt = false, dryRun = false } = {}) {
  try {
    const safe = checkLogDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    if (!Array.isArray(observations)) return fail('invalid-input', 'observations must be an array');
    const nowMs = new Date(clock()).getTime();
    if (!Number.isFinite(nowMs)) return fail('invalid-clock', 'The clock did not return a valid time.');
    const observedAt = new Date(nowMs).toISOString();

    const { records, invalid } = readLog(safe.dir);
    const newest = records.reduce((m, r) => Math.max(m, Date.parse(r.observedAt)), -Infinity);
    if (nowMs < newest) return fail('clock-behind-log', `The clock (${observedAt}) is earlier than the newest record in the log (${new Date(newest).toISOString()}). Refusing to write backdated observations.`);

    const latest = new Map();
    for (const r of records) latest.set(keyOf(r), r);
    const batchSeen = new Set();
    const toWrite = []; const rejected = []; const warnings = []; let duplicates = 0;
    observations.forEach((obs, index) => {
      const built = buildRecord(obs, { observedAt, keepExcerpt });
      if (built.reject) { rejected.push({ index, reason: built.reject }); return; }
      const { record } = built;
      for (const w of built.warnings) warnings.push({ index, warning: w });
      if (batchSeen.has(keyOf(record))) {
        const earlier = toWrite.find((r) => keyOf(r) === keyOf(record));
        if (earlier && stateKeyOf(earlier) === stateKeyOf(record)) duplicates += 1;
        else rejected.push({ index, reason: 'conflicting-observation-in-batch' });
        return;
      }
      batchSeen.add(keyOf(record));
      const prev = latest.get(keyOf(record));
      if (prev && stateKeyOf(prev) === stateKeyOf(record)) { duplicates += 1; return; }
      toWrite.push(record);
    });

    if (toWrite.length && !dryRun) {
      fs.mkdirSync(safe.dir, { recursive: true, mode: 0o700 });
      const file = path.join(safe.dir, LOG_FILE);
      let prefix = '';
      try {
        const size = fs.statSync(file).size;
        if (size > 0) { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); fs.closeSync(fd); if (b[0] !== 0x0a) prefix = '\n'; }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeSync(fd, prefix + toWrite.map((r) => `${JSON.stringify(r)}\n`).join('')); } finally { fs.closeSync(fd); }
    }
    return { ok: true, observedAt, dryRun, written: toWrite.length, duplicates, rejected, warnings, invalidLinesInLog: invalid.length, records: toWrite };
  } catch (e) {
    return fail('io-error', String(e && e.message ? e.message : e));
  }
}

function asOfMs(asOf) {
  const ms = asOf == null ? NaN : new Date(asOf).getTime();
  if (!Number.isFinite(ms)) throw new TypeError('A valid asOf timestamp is required; there is no default.');
  return ms;
}

/** Records observed at or before `asOf`, deep-frozen copies, file order. */
export function recordsAsOf(records, asOf) {
  const cut = asOfMs(asOf);
  return records.filter((r) => Date.parse(r.observedAt) <= cut).map((r) => Object.freeze(structuredClone(r)));
}

/** Latest record for one player visible at `asOf`, or null when nothing had been observed by then. */
export function statusAsOf(records, playerId, asOf) {
  const cut = asOfMs(asOf);
  let best = null;
  for (const r of records) {
    if (r.playerId !== playerId || Date.parse(r.observedAt) > cut) continue;
    if (!best || Date.parse(r.observedAt) >= Date.parse(best.observedAt)) best = r;
  }
  return best ? Object.freeze(structuredClone(best)) : null;
}

/** Map playerId -> latest visible record at `asOf`. */
export function snapshotAsOf(records, asOf) {
  const out = new Map();
  for (const r of recordsAsOf(records, asOf)) {
    const cur = out.get(r.playerId);
    if (!cur || Date.parse(r.observedAt) >= Date.parse(cur.observedAt)) out.set(r.playerId, r);
  }
  return out;
}

/** Integrity report for the whole log. */
export function verifyLog(dir) {
  try {
    const safe = checkLogDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    const { records, invalid } = readLog(safe.dir);
    let nonMonotonic = 0;
    for (let i = 1; i < records.length; i += 1) if (Date.parse(records[i].observedAt) < Date.parse(records[i - 1].observedAt)) nonMonotonic += 1;
    return { ok: invalid.length === 0 && nonMonotonic === 0, records: records.length, invalid, nonMonotonic };
  } catch (e) { return fail('io-error', String(e && e.message ? e.message : e)); }
}
