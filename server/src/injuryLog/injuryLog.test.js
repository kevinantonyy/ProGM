import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAPPING_VERSION, STATUSES, mapStatus, reasonCategory } from './statusMap.js';
import { buildRecord, canonicalJson, contentHashOf, validateStoredRecord } from './record.js';
import { LOG_FILE, appendObservations, checkLogDir, readLog, recordsAsOf, snapshotAsOf, statusAsOf, verifyLog } from './store.js';
import { ESPN_FEED_URL, fromEspnInjuries, fromYahooPlayers, yahooRowsFromFile } from './ingest.js';
import { defaultLogDir } from './paths.js';
import { findPrivateData } from './privacy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const scriptPath = path.join(repoRoot, 'server/scripts/injuryLog.mjs');
const T = (iso) => () => new Date(iso);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'progm-injury-'));
const logText = (dir) => fs.readFileSync(path.join(dir, LOG_FILE), 'utf8');
const obs = (over = {}) => ({ source: 'espn', playerId: 'espn:1001', playerName: 'Test Player', rawStatus: 'Out', note: 'Left ankle sprain, re-evaluated next week.', basis: 'reported', ...over });

// ---------- deterministic mapping ----------
test('status mapping: fixed table, case/spacing insensitive, unknown is never guessed', () => {
  const cases = { O: 'out', Out: 'out', INJ: 'out', 'IL+': 'out', NA: 'out', 'Out For Season': 'out', D: 'doubtful', Doubtful: 'doubtful', Q: 'questionable', GTD: 'questionable', 'Day-To-Day': 'questionable', 'game time decision': 'questionable', Probable: 'questionable', Healthy: 'available', SUSP: 'suspended', Suspension: 'suspended', 'Rest Of Season Maybe': 'unknown', '': 'unknown', '  ': 'unknown' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(mapStatus(raw), want, raw);
  assert.equal(mapStatus(null), 'unknown'); assert.equal(mapStatus(42), 'unknown');
  for (const s of Object.values(cases)) assert.ok(STATUSES.includes(s));
  assert.equal(mapStatus('Out', 'Suspended two games for conduct'), 'suspended');
  assert.equal(mapStatus('Out', 'Ankle sprain'), 'out');
  assert.equal(mapStatus('Questionable', 'suspended'), 'questionable', 'the note rule only upgrades Out');
  assert.equal(mapStatus('Out'), mapStatus('Out'), 'deterministic');
});

test('reason category is coarse; free text and body parts are not part of it', () => {
  assert.equal(reasonCategory('Left knee soreness', 'out'), 'injury');
  assert.equal(reasonCategory('Illness', 'questionable'), 'illness');
  assert.equal(reasonCategory('Rest', 'out'), 'rest');
  assert.equal(reasonCategory('Personal reasons', 'out'), 'personal');
  assert.equal(reasonCategory('anything', 'suspended'), 'suspension');
  assert.equal(reasonCategory(null, 'out'), 'unspecified');
  assert.equal(reasonCategory('Will be back Friday', 'questionable'), 'other');
});

// ---------- record construction ----------
test('record: required evidence fields, content hash, and no medical free text by default', () => {
  const { record } = buildRecord(obs({ sourceUrl: ESPN_FEED_URL, sourcePublishedAt: '2026-10-01T12:00:00Z' }), { observedAt: '2026-10-05T00:00:00.000Z' });
  for (const k of ['schema', 'observedAt', 'source', 'playerId', 'status', 'rawStatus', 'sourceUrl', 'sourcePublishedAt', 'contentHash', 'recordId', 'mappingVersion', 'noteSha256', 'reason']) assert.ok(k in record && record[k] !== undefined, k);
  assert.equal(record.status, 'out'); assert.equal(record.reason, 'injury'); assert.equal(record.mappingVersion, MAPPING_VERSION);
  assert.match(record.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(record).toLowerCase().includes('ankle'), 'note text must not be stored by default');
  assert.equal('noteExcerpt' in record, false);
  assert.equal(record.contentHash, contentHashOf(record));
  assert.equal(validateStoredRecord(record), null);
});

test('record: content hash ignores observation time and changes when the evidence changes', () => {
  const a = buildRecord(obs(), { observedAt: '2026-10-05T00:00:00Z' }).record;
  const b = buildRecord(obs(), { observedAt: '2026-10-09T00:00:00Z' }).record;
  const c = buildRecord(obs({ rawStatus: 'Doubtful' }), { observedAt: '2026-10-05T00:00:00Z' }).record;
  assert.equal(a.contentHash, b.contentHash); assert.notEqual(a.recordId, b.recordId); assert.notEqual(a.contentHash, c.contentHash);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('record: excerpt is opt-in and capped', () => {
  const long = `Knee soreness ${'x'.repeat(400)}`;
  const { record } = buildRecord(obs({ note: long }), { observedAt: '2026-10-05T00:00:00Z', keepExcerpt: true });
  assert.equal(record.noteExcerpt.length, 120); assert.equal(record.noteLength, long.length);
});

test('missing or invalid fields are rejected with a reason, never defaulted', () => {
  const at = '2026-10-05T00:00:00Z';
  const reason = (o) => buildRecord(o, { observedAt: at }).reject;
  assert.equal(reason(obs({ rawStatus: null })), 'missing-status');
  assert.equal(reason(obs({ rawStatus: 7 })), 'invalid-status');
  assert.equal(reason(obs({ playerId: undefined })), 'invalid-player-id');
  assert.equal(reason(obs({ playerId: 'espn:abc' })), 'invalid-player-id');
  assert.equal(reason(obs({ playerId: 'yahoo:1001' })), 'invalid-player-id', 'source and id namespace must agree');
  assert.equal(reason(obs({ source: 'nba' })), 'unknown-source');
  assert.equal(reason(null), 'observation-not-an-object');
  assert.equal(reason([]), 'observation-not-an-object');
  assert.equal(reason(obs({ basis: 'guess' })), 'invalid-basis');
  assert.equal(reason(obs({ basis: 'absent-status' })), 'basis-conflicts-with-status');
  assert.equal(buildRecord(obs({ source: 'yahoo', playerId: 'yahoo:5', rawStatus: null, note: null, basis: 'absent-status' }), { observedAt: at }).record.status, 'available');
  assert.equal(buildRecord(obs({ rawStatus: 'Something New' }), { observedAt: at }).record.status, 'unknown');
  assert.equal(buildRecord(obs({ playerName: undefined, note: undefined }), { observedAt: at }).record.noteSha256, null);
});

test('optional evidence fields degrade safely: bad URL / future or invalid publish time are dropped with a warning', () => {
  const at = '2026-10-05T00:00:00Z';
  const r1 = buildRecord(obs({ sourceUrl: 'http://example.com/x', sourcePublishedAt: '2026-12-01T00:00:00Z' }), { observedAt: at });
  assert.equal(r1.record.sourceUrl, null); assert.equal(r1.record.sourcePublishedAt, null);
  assert.deepEqual(r1.warnings.sort(), ['source-published-at-in-future', 'source-url-not-https']);
  const r2 = buildRecord(obs({ sourceUrl: 'not a url', sourcePublishedAt: 'yesterday-ish' }), { observedAt: at });
  assert.deepEqual(r2.warnings.sort(), ['source-published-at-invalid', 'source-url-invalid']);
  const r3 = buildRecord(obs({ sourceUrl: 'https://user:pw@example.com/feed?league=12&x=1#frag' }), { observedAt: at });
  assert.equal(r3.record.sourceUrl, 'https://example.com/feed', 'credentials, query string and fragment are stripped');
});

// ---------- duplicates, changes, append-only ----------
test('duplicates: an identical re-run writes nothing; the same player twice in one batch is one record', () => {
  const dir = tmp();
  const first = appendObservations(dir, [obs(), obs({ playerId: 'espn:1002' })], { clock: T('2026-10-05T00:00:00Z') });
  assert.equal(first.written, 2);
  const again = appendObservations(dir, [obs(), obs({ playerId: 'espn:1002' })], { clock: T('2026-10-06T00:00:00Z') });
  assert.deepEqual([again.written, again.duplicates], [0, 2]);
  assert.equal(logText(dir).trim().split('\n').length, 2);
  const inBatch = appendObservations(dir, [obs({ playerId: 'espn:2000' }), obs({ playerId: 'espn:2000' })], { clock: T('2026-10-07T00:00:00Z') });
  assert.deepEqual([inBatch.written, inBatch.duplicates], [1, 1]);
});

test('a note-only change is a duplicate state; a conflicting double report in one batch is rejected', () => {
  const dir = tmp();
  appendObservations(dir, [obs()], { clock: T('2026-10-05T00:00:00Z') });
  const noteOnly = appendObservations(dir, [obs({ note: 'Ankle sprain, now day to day.' })], { clock: T('2026-10-06T00:00:00Z') });
  assert.equal(noteOnly.written, 0);
  const conflict = appendObservations(dir, [obs({ playerId: 'espn:3', rawStatus: 'Out' }), obs({ playerId: 'espn:3', rawStatus: 'Questionable' })], { clock: T('2026-10-07T00:00:00Z') });
  assert.equal(conflict.written, 1); assert.deepEqual(conflict.rejected, [{ index: 1, reason: 'conflicting-observation-in-batch' }]);
});

test('status changes append new records; earlier lines are never modified', () => {
  const dir = tmp();
  appendObservations(dir, [obs({ rawStatus: 'Out' })], { clock: T('2026-10-05T00:00:00Z') });
  const before = logText(dir);
  const r = appendObservations(dir, [obs({ rawStatus: 'Questionable' })], { clock: T('2026-10-08T00:00:00Z') });
  assert.equal(r.written, 1);
  const after = logText(dir);
  assert.ok(after.startsWith(before), 'existing bytes unchanged');
  const { records } = readLog(dir);
  assert.deepEqual(records.map((x) => [x.status, x.observedAt]), [['out', '2026-10-05T00:00:00.000Z'], ['questionable', '2026-10-08T00:00:00.000Z']]);
  const back = appendObservations(dir, [obs({ rawStatus: 'Out' })], { clock: T('2026-10-09T00:00:00Z') });
  assert.equal(back.written, 1, 'returning to an earlier state is a change relative to the latest record');
});

test('the store exposes no update or delete API', async () => {
  const mod = await import('./store.js');
  assert.deepEqual(Object.keys(mod).filter((k) => /update|delete|remove|overwrite|rewrite/i.test(k)), []);
  const src = fs.readFileSync(path.join(here, 'store.js'), 'utf8');
  assert.ok(!/writeFileSync|unlinkSync|rmSync|renameSync|truncateSync/.test(src), 'only appends via an append-mode descriptor');
});

// ---------- timestamps / no backdating ----------
test('observedAt is stamped from the clock at write time, identical for a batch, and not accepted from input', () => {
  const dir = tmp();
  const r = appendObservations(dir, [obs(), obs({ playerId: 'espn:9' }), obs({ playerId: 'espn:10', observedAt: '2020-01-01T00:00:00Z' }), obs({ playerId: 'espn:11', availableAt: '2020-01-01T00:00:00Z' })], { clock: T('2026-10-05T08:30:00Z') });
  assert.equal(r.written, 2);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['caller-supplied-observation-time', 'caller-supplied-observation-time']);
  assert.ok(readLog(dir).records.every((x) => x.observedAt === '2026-10-05T08:30:00.000Z'));
});

test('a clock earlier than the newest record refuses the write and changes nothing', () => {
  const dir = tmp();
  appendObservations(dir, [obs()], { clock: T('2026-10-10T00:00:00Z') });
  const before = logText(dir);
  const r = appendObservations(dir, [obs({ rawStatus: 'Doubtful' })], { clock: T('2026-10-01T00:00:00Z') });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'clock-behind-log');
  assert.equal(logText(dir), before);
  assert.equal(appendObservations(dir, [obs({ rawStatus: 'Doubtful' })], { clock: T('2026-10-10T00:00:00Z') }).written, 1, 'equal time is allowed');
});

test('an invalid clock fails safely', () => {
  const dir = tmp();
  const r = appendObservations(dir, [obs()], { clock: () => 'not a time' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid-clock'); assert.equal(fs.existsSync(path.join(dir, LOG_FILE)), false);
});

test('a late-ingested old report is stamped with the ingestion time, not its source publish time', () => {
  const dir = tmp();
  appendObservations(dir, [obs({ sourcePublishedAt: '2026-09-01T00:00:00Z' })], { clock: T('2026-10-20T00:00:00Z') });
  const [rec] = readLog(dir).records;
  assert.equal(rec.observedAt, '2026-10-20T00:00:00.000Z'); assert.equal(rec.sourcePublishedAt, '2026-09-01T00:00:00.000Z');
});

// ---------- leakage prevention ----------
test('leakage: forecasts as of T never see records observed after T, even when the source published earlier', () => {
  const dir = tmp();
  appendObservations(dir, [obs({ rawStatus: 'Questionable', sourcePublishedAt: '2026-09-15T00:00:00Z' })], { clock: T('2026-10-02T00:00:00Z') });
  appendObservations(dir, [obs({ rawStatus: 'Out', sourcePublishedAt: '2026-09-20T00:00:00Z' })], { clock: T('2026-10-20T00:00:00Z') });
  const { records } = readLog(dir);
  const id = 'espn:1001';
  assert.equal(statusAsOf(records, id, '2026-10-01T23:59:59Z'), null, 'before first observation: nothing, despite earlier publish dates');
  assert.equal(statusAsOf(records, id, '2026-10-02T00:00:00Z').status, 'questionable', 'boundary is inclusive');
  assert.equal(statusAsOf(records, id, '2026-10-19T00:00:00Z').status, 'questionable', 'the later change is invisible');
  assert.equal(statusAsOf(records, id, '2026-10-20T00:00:00Z').status, 'out');
  assert.equal(recordsAsOf(records, '2026-10-10T00:00:00Z').length, 1);
  assert.deepEqual([...snapshotAsOf(records, '2026-10-10T00:00:00Z').values()].map((r) => r.status), ['questionable']);
  assert.equal(snapshotAsOf(records, '2026-09-30T00:00:00Z').size, 0);
});

test('leakage: asOf is mandatory and a missing or invalid one throws rather than returning everything', () => {
  const dir = tmp(); appendObservations(dir, [obs()], { clock: T('2026-10-02T00:00:00Z') });
  const { records } = readLog(dir);
  for (const bad of [undefined, null, '', 'soon', NaN]) {
    assert.throws(() => statusAsOf(records, 'espn:1001', bad), TypeError);
    assert.throws(() => recordsAsOf(records, bad), TypeError);
    assert.throws(() => snapshotAsOf(records, bad), TypeError);
  }
});

test('leakage: results are frozen copies, so a consumer cannot alter the log through them', () => {
  const dir = tmp(); appendObservations(dir, [obs()], { clock: T('2026-10-02T00:00:00Z') });
  const { records } = readLog(dir);
  const r = statusAsOf(records, 'espn:1001', '2026-11-01T00:00:00Z');
  assert.throws(() => { 'use strict'; r.status = 'available'; }, TypeError);
  assert.equal(records[0].status, 'out');
});

test('leakage: a record with a tampered observedAt is rejected by the integrity check, so it cannot be moved earlier', () => {
  const dir = tmp(); appendObservations(dir, [obs()], { clock: T('2026-10-20T00:00:00Z') });
  const file = path.join(dir, LOG_FILE);
  fs.writeFileSync(file, logText(dir).replace('2026-10-20T00:00:00.000Z', '2026-09-01T00:00:00.000Z'));
  const { records, invalid } = readLog(dir);
  assert.equal(records.length, 0); assert.deepEqual(invalid.map((x) => x.reason), ['record-id-mismatch']);
  assert.equal(statusAsOf(records, 'espn:1001', '2026-09-15T00:00:00Z'), null);
  assert.equal(verifyLog(dir).ok, false);
});

// ---------- safe failure ----------
test('safe failure: a truncated trailing line is skipped, reported, and the next append starts on a fresh line', () => {
  const dir = tmp(); appendObservations(dir, [obs()], { clock: T('2026-10-02T00:00:00Z') });
  fs.appendFileSync(path.join(dir, LOG_FILE), '{"schema":"progm.injury-log.v1","observedAt":"2026-10-0');
  assert.equal(readLog(dir).invalid.length, 1);
  const r = appendObservations(dir, [obs({ rawStatus: 'Doubtful' })], { clock: T('2026-10-03T00:00:00Z') });
  assert.equal(r.ok, true); assert.equal(r.written, 1); assert.equal(r.invalidLinesInLog, 1);
  const { records, invalid } = readLog(dir);
  assert.deepEqual(records.map((x) => x.status), ['out', 'doubtful']); assert.equal(invalid.length, 1);
});

test('safe failure: bad input shapes return structured errors without throwing or writing', () => {
  const dir = tmp();
  for (const bad of [null, undefined, 'x', {}, 5]) {
    const r = appendObservations(dir, bad, { clock: T('2026-10-02T00:00:00Z') });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid-input');
  }
  const mixed = appendObservations(dir, [null, 'x', 7, obs()], { clock: T('2026-10-02T00:00:00Z') });
  assert.equal(mixed.written, 1); assert.equal(mixed.rejected.length, 3);
});

test('safe failure: an unwritable location returns {ok:false} instead of throwing', () => {
  const dir = tmp(); const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
  const r = appendObservations(path.join(blocker, 'sub'), [obs()], { clock: T('2026-10-02T00:00:00Z') });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'io-error');
});

test('safe failure: dry run writes nothing', () => {
  const dir = tmp();
  const r = appendObservations(dir, [obs()], { clock: T('2026-10-02T00:00:00Z'), dryRun: true });
  assert.equal(r.written, 1); assert.equal(fs.existsSync(path.join(dir, LOG_FILE)), false);
});

test('the log must be outside any Git work tree, or inside the gitignored .progm-private directory', () => {
  assert.equal(checkLogDir(path.join(repoRoot, 'server', 'logs')).ok, false);
  assert.equal(checkLogDir(path.join(repoRoot, 'docs')).ok, false);
  assert.equal(checkLogDir(path.join(repoRoot, '.progm-private', 'injury-log')).ok, true);
  assert.equal(checkLogDir(tmp()).ok, true);
  const r = appendObservations(path.join(repoRoot, 'server', 'logs'), [obs()], { clock: T('2026-10-02T00:00:00Z') });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'unsafe-directory');
  assert.equal(fs.existsSync(path.join(repoRoot, 'server', 'logs')), false);
  assert.ok(fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split('\n').includes('.progm-private/'), '.gitignore lists the private directory');
});

// ---------- privacy ----------
test('privacy: league/team keys, credentials and e-mail addresses are refused wherever they appear', () => {
  const at = '2026-10-05T00:00:00Z';
  assert.match(buildRecord(obs({ playerName: 'Test 466.l.12345' }), { observedAt: at }).reject, /^private-data:yahoo-league-key/);
  assert.match(buildRecord(obs({ rawStatus: 'Out 466.l.1.t.3' }), { observedAt: at }).reject, /^private-data/);
  assert.match(buildRecord(obs({ note: 'contact me@example.com', playerName: 'ok' }), { observedAt: at, keepExcerpt: true }).reject, /email/);
  assert.equal(buildRecord(obs({ note: 'contact me@example.com' }), { observedAt: at }).record.noteLength > 0, true, 'without an excerpt the note is only hashed');
  assert.deepEqual(findPrivateData('Bearer abcdefghijklmnop'), ['credential']);
  assert.deepEqual(findPrivateData('plain injury report text'), []);
  assert.deepEqual(findPrivateData('nba.p.5352'), []);
});

test('privacy: a written log contains no note text, league keys, or tokens', () => {
  const dir = tmp();
  appendObservations(dir, fromYahooPlayers([{ playerKey: '466.p.5352', name: 'A Player', status: 'O', injuryNote: 'Torn meniscus, surgery scheduled', ownerTeam: 'My Private Team', leagueKey: '466.l.99999' }]).observations, { clock: T('2026-10-02T00:00:00Z') });
  const text = logText(dir).toLowerCase();
  for (const bad of ['meniscus', 'surgery', 'private team', '99999', 'leaguekey']) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(findPrivateData(logText(dir)), []);
});

// ---------- adapters ----------
test('yahoo adapter: reads only the named fields; healthy rows become absent-status; league/team keys are not ids', () => {
  const { observations, skipped } = fromYahooPlayers([
    { playerKey: '466.p.5352', name: 'Hurt Guy', status: 'INJ', statusFull: 'Injured', injuryNote: 'Foot', percentOwned: 80, ownerTeam: 'Secret' },
    { editorialPlayerKey: 'nba.p.6000', name: 'Well Guy', status: null },
    { playerId: '7000', name: 'Num Only', status: 'GTD' },
    { id: '466.p.8000', name: 'Board Row', injuryStatus: 'Healthy' },
    { playerKey: '466.l.12345.t.3', name: 'Team Key' },
    { name: 'No Id' }, null, 'x',
  ]);
  assert.deepEqual(observations.map((o) => [o.playerId, o.rawStatus, o.basis]), [['yahoo:5352', 'INJ', 'reported'], ['yahoo:6000', null, 'absent-status'], ['yahoo:7000', 'GTD', 'reported'], ['yahoo:8000', null, 'absent-status']]);
  assert.equal(skipped.length, 4);
  assert.ok(!JSON.stringify(observations).includes('Secret'));
  assert.deepEqual(fromYahooPlayers('nope').skipped, [{ index: 0, reason: 'input-not-an-array' }]);
});

test('espn adapter: raw payload and mapped list; absence from the feed is never recorded', () => {
  const raw = { injuries: [{ injuries: [{ athlete: { id: '4278073', displayName: 'Raw Player' }, status: 'Day-To-Day', shortComment: 'Hip', date: '2026-10-01T10:00:00Z' }, { athlete: {}, status: 'Out' }, { athlete: { id: '99' }, type: { description: 'Suspension' } }] }] };
  const a = fromEspnInjuries(raw);
  assert.deepEqual(a.observations.map((o) => [o.playerId, o.rawStatus, o.sourceUrl]), [['espn:4278073', 'Day-To-Day', ESPN_FEED_URL], ['espn:99', 'Suspension', ESPN_FEED_URL]]);
  assert.equal(a.observations[0].sourcePublishedAt, '2026-10-01T10:00:00Z'); assert.equal(a.skipped.length, 1);
  const b = fromEspnInjuries([{ externalId: '12', designation: 'Out', description: 'Suspended 2 games' }, { externalId: null, designation: 'Out' }]);
  assert.equal(b.observations.length, 1); assert.equal(b.skipped.length, 1);
  assert.equal(buildRecord(b.observations[0], { observedAt: '2026-10-05T00:00:00Z' }).record.status, 'suspended');
  assert.deepEqual(fromEspnInjuries({ nothing: 1 }).skipped, [{ index: 0, reason: 'unrecognised-espn-input' }]);
  assert.deepEqual(fromEspnInjuries(null).observations, []);
});

test('yahoo file shapes: array, {players}, saved workspace response; anything else is null', () => {
  assert.deepEqual(yahooRowsFromFile([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(yahooRowsFromFile({ players: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(yahooRowsFromFile({ draftBoard: { board: [{ a: 1 }], noData: [{ b: 2 }] } }), [{ a: 1 }, { b: 2 }]);
  assert.equal(yahooRowsFromFile({ foo: 1 }), null); assert.equal(yahooRowsFromFile(null), null);
});

test('default log directory is per-user and outside the repository', () => {
  assert.equal(defaultLogDir({ env: { LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\k' }), 'C:\\Users\\k\\AppData\\Local\\ProGM\\injury-log');
  assert.equal(defaultLogDir({ env: {}, platform: 'win32', home: 'C:\\Users\\k' }), 'C:\\Users\\k\\AppData\\Local\\ProGM\\injury-log');
  assert.equal(defaultLogDir({ env: {}, platform: 'linux', home: '/home/k' }), '/home/k/.progm/injury-log');
  assert.equal(defaultLogDir({ env: { PROGM_INJURY_LOG_DIR: '/x/y' }, platform: 'linux', home: '/home/k' }), path.resolve('/x/y'));
});

// ---------- independence from production ----------
const listFiles = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());
test('independence: the logger imports only node built-ins and its own files, and makes no network or database calls', () => {
  const files = [...fs.readdirSync(here).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(here, f)), scriptPath];
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).concat([...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
    for (const s of specs) assert.ok(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../src/injuryLog/'), `${path.basename(f)} imports ${s}`);
    assert.ok(!/\bfetch\s*\(|node:https?|node:net|node:dgram|node:tls|XMLHttpRequest|from\s+['"]pg['"]|process\.env\.(DATABASE|YAHOO|JWT)/.test(src), `${path.basename(f)} must not use network, database or credentials`);
  }
});

test('independence: no production code imports the logger', () => {
  const serverRoot = path.join(repoRoot, 'server');
  for (const f of [...listFiles(path.join(serverRoot, 'src')), ...listFiles(path.join(serverRoot, 'scripts'))]) {
    if (!/\.(m?js)$/.test(f) || f.startsWith(here) || f === scriptPath || f.includes('node_modules')) continue;
    assert.ok(!/injuryLog/.test(fs.readFileSync(f, 'utf8')), `${path.relative(repoRoot, f)} references the injury logger`);
  }
  assert.ok(!listFiles(path.join(repoRoot, 'client', 'src')).some((f) => /\.(jsx?|tsx?)$/.test(f) && /injuryLog/.test(fs.readFileSync(f, 'utf8'))));
});

// ---------- CLI ----------
const run = (args, env = {}) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
test('CLI: record -> duplicate re-run -> change -> as-of queries -> verify (end to end, real clock)', () => {
  const dir = tmp(); const work = tmp();
  const yahoo = path.join(work, 'yahoo.json'); const espn = path.join(work, 'espn.json');
  fs.writeFileSync(yahoo, JSON.stringify({ draftBoard: { board: [{ playerKey: '466.p.5352', name: 'A', status: 'O' }, { playerKey: '466.p.5353', name: 'B' }] } }));
  fs.writeFileSync(espn, JSON.stringify({ injuries: [{ injuries: [{ athlete: { id: '77' }, status: 'Questionable', shortComment: 'Knee' }] }] }));
  const before = new Date().toISOString();
  const r1 = run(['record', '--yahoo', yahoo, '--espn', espn, '--dir', dir]);
  assert.equal(r1.status, 0, r1.stderr); const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.written, 3); assert.ok(j1.observedAt >= before && j1.observedAt <= new Date().toISOString());
  assert.ok(!r1.stdout.includes('Knee'));
  const r2 = JSON.parse(run(['record', '--yahoo', yahoo, '--espn', espn, '--dir', dir]).stdout);
  assert.deepEqual([r2.written, r2.duplicates], [0, 3]);
  fs.writeFileSync(yahoo, JSON.stringify([{ playerKey: '466.p.5352', name: 'A', status: 'GTD' }]));
  assert.equal(JSON.parse(run(['record', '--yahoo', yahoo, '--dir', dir]).stdout).written, 1);
  const early = JSON.parse(run(['status', '--player', 'yahoo:5352', '--as-of', '2000-01-01T00:00:00Z', '--dir', dir]).stdout);
  assert.equal(early.status, null);
  const now = JSON.parse(run(['status', '--player', 'yahoo:5352', '--as-of', '2999-01-01T00:00:00Z', '--dir', dir]).stdout);
  assert.equal(now.status, 'questionable');
  const sum = JSON.parse(run(['summary', '--as-of', '2999-01-01T00:00:00Z', '--dir', dir]).stdout);
  assert.deepEqual(sum.byStatus, { questionable: 2, available: 1 });
  const v = run(['verify', '--dir', dir]); assert.equal(v.status, 0); assert.equal(JSON.parse(v.stdout).records, 4);
});

test('CLI: usage errors exit 2, bad inputs exit 1 and write nothing, repo directories are refused', () => {
  const dir = tmp(); const work = tmp();
  assert.equal(run([]).status, 2);
  assert.equal(run(['record', '--dir', dir]).status, 2);
  assert.equal(run(['status', '--player', 'espn:1', '--dir', dir]).status, 2, '--as-of is mandatory');
  assert.equal(run(['status', '--player', 'espn:1', '--as-of', 'later', '--dir', dir]).status, 2);
  const bad = path.join(work, 'bad.json'); fs.writeFileSync(bad, '{not json');
  assert.equal(run(['record', '--yahoo', bad, '--dir', dir]).status, 1);
  assert.equal(run(['record', '--yahoo', path.join(work, 'missing.json'), '--dir', dir]).status, 1);
  const odd = path.join(work, 'odd.json'); fs.writeFileSync(odd, JSON.stringify({ hello: 1 }));
  assert.equal(run(['record', '--yahoo', odd, '--dir', dir]).status, 1);
  assert.equal(run(['record', '--espn', odd, '--dir', dir]).status, 1);
  assert.equal(fs.existsSync(path.join(dir, LOG_FILE)), false);
  const ok = path.join(work, 'ok.json'); fs.writeFileSync(ok, JSON.stringify([{ playerKey: 'nba.p.1', status: 'O' }]));
  const unsafe = run(['record', '--yahoo', ok, '--dir', path.join(repoRoot, 'docs', 'oops')]);
  assert.equal(unsafe.status, 1); assert.match(unsafe.stderr, /unsafe-directory/); assert.equal(fs.existsSync(path.join(repoRoot, 'docs', 'oops')), false);
  fs.writeFileSync(path.join(dir, LOG_FILE), 'garbage\n');
  assert.equal(run(['verify', '--dir', dir]).status, 1);
});
