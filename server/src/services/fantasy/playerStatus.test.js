import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { PLAYER_STATUS_STATES, classifyYahooStatus, resolveDraftStatusDisplay, withPlayerStatus } from './playerStatus.js';

const AT = '2026-10-16T07:00:00.000Z';

test('flag is opt-in: unset, empty or junk values stay off', () => {
  for (const v of [undefined, '', 'off', 'no', 'yes', 'enabled', '0']) assert.equal(resolveDraftStatusDisplay({ PROGM_DRAFT_STATUS: v }), false, String(v));
  for (const v of ['on', 'ON', ' true ', '1']) assert.equal(resolveDraftStatusDisplay({ PROGM_DRAFT_STATUS: v }), true, v);
  assert.equal(resolveDraftStatusDisplay({}), false);
});

test('classifier: raw code, label and note preserved; inactive, out, none and unknown kept apart', () => {
  const cases = [
    [{ status: 'NA' }, 'inactive', 'Not active'], [{ status: 'na' }, 'inactive', 'Not active'],
    [{ status: 'O' }, 'out', 'Out'], [{ status: 'INJ' }, 'out', 'Injured'], [{ status: 'OFS' }, 'out', 'Out for season'],
    [{ status: 'Q' }, 'questionable', 'Questionable'], [{ status: 'GTD' }, 'questionable', 'Game-time decision'], [{ status: 'D' }, 'doubtful', 'Doubtful'],
    [{ status: 'SUSP' }, 'suspended', 'Suspended'],
    [{ status: null }, 'none', null], [{}, 'none', null], [{ status: '  ' }, 'none', null],
    [{ status: 'XYZ' }, 'unknown', 'XYZ'],
  ];
  for (const [p, state, label] of cases) {
    const s = classifyYahooStatus(p);
    assert.equal(s.state, state, JSON.stringify(p)); assert.equal(s.label, label, JSON.stringify(p));
    assert.ok(PLAYER_STATUS_STATES.includes(s.state));
  }
  assert.equal(classifyYahooStatus({ status: 'na' }).code, 'na', 'raw code is kept as Yahoo sent it');
  const full = classifyYahooStatus({ status: 'O', statusFull: 'Out', injuryNote: 'Knee' }, { observedAt: AT });
  assert.deepEqual(full, { code: 'O', state: 'out', label: 'Out', note: 'Knee', source: 'yahoo', observedAt: AT });
  assert.notEqual(classifyYahooStatus({}).state, 'healthy', 'no designation is never reported as healthy');
});

test('observation time is never invented: missing or invalid stays null', () => {
  assert.equal(classifyYahooStatus({ status: 'O' }).observedAt, null);
  assert.equal(classifyYahooStatus({ status: 'O' }, { observedAt: 'yesterday' }).observedAt, null);
  assert.equal(withPlayerStatus({ board: [], noData: [] }, new Map()).statusData.observedAt, null);
  assert.equal(classifyYahooStatus({ status: 'O' }, { observedAt: AT }).observedAt, AT);
});

test('ambiguous NA: stays "inactive" with no inferred reason, injury or suspension', () => {
  for (const p of [{ status: 'NA' }, { status: 'NA', statusFull: 'Not Active' }]) {
    const s = classifyYahooStatus(p);
    assert.equal(s.state, 'inactive'); assert.equal(s.note, null);
    assert.equal('reason' in s, false);
    assert.ok(!/injur|waiv|unsign|two-way|suspen/i.test(JSON.stringify(s)));
  }
  assert.equal(classifyYahooStatus({ status: 'NA', statusFull: 'Not Active' }).label, 'Not Active', "Yahoo's own label wins");
});

test('missing injury data: warning shown when the external injury source is unavailable or unreported', () => {
  const b = { available: true, board: [], noData: [] };
  for (const meta of [undefined, {}, { injuryReports: { available: false, provider: 'free_nba' } }, { injuryReports: { available: 'true' } }]) {
    const sd = withPlayerStatus(b, new Map(), meta).statusData;
    assert.equal(sd.injuryReports.available, false); assert.match(sd.warning, /injury reports are unavailable/); assert.match(sd.warning, /not confirmed healthy/);
  }
  const ok = withPlayerStatus(b, new Map(), { injuryReports: { available: true, provider: 'tank01' } }).statusData;
  assert.deepEqual(ok.injuryReports, { available: true, provider: 'tank01' }); assert.equal(ok.warning, null);
});

// ---------- the real draft board ----------
const SETTINGS = { teamCount: 4, rosterSlots: [
  { position: 'PG', count: 1, isStarting: true }, { position: 'SF', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true },
  { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 70, gameTotal: 82 }));
const POS = ['PG', 'SF', 'C']; const STATUS = [null, 'NA', 'O', 'INJ', 'Q', null, 'GTD', 'SUSP', 'XYZ'];
const specs = Array.from({ length: 36 }, (_, i) => ({ key: `P${i}`, pos: POS[i % 3], pts: i === 35 ? null : 50 - i * 0.9, status: STATUS[i % STATUS.length] }));
const pool = (withStatus = true) => specs.map((s) => ({ playerKey: s.key, name: s.key, teamAbbr: 'AAA', eligiblePositions: [s.pos], percentOwned: 0, status: withStatus ? s.status : null, statusFull: null, injuryNote: null }));
const proj = { getProjection: (p) => { const s = specs.find((x) => x.key === p.playerKey); return s.pts == null ? null : { projectedPoints: s.pts, confidence: 0.9, history }; } };
const rostered = new Set(['P1', 'P2', 'P5', 'P9']); // mixes NA, O, none and no designation with rostered/available
const board = (players) => buildDraftBoard({ players, settings: SETTINGS, projectionProvider: proj, poolComplete: true, availabilityOf: (p) => !rostered.has(p.playerKey), currentSeason: '2026' });
const strip = (b) => { const { statusData, ...rest } = b; const s = ({ leagueAvailability, playerStatus, ...row }) => row; return { ...rest, board: rest.board.map(s), noData: rest.noData.map(s) }; };

test('league availability is independent of player status', () => {
  const players = pool(); const out = withPlayerStatus(board(players), new Map(players.map((p) => [p.playerKey, p])), { observedAt: AT });
  const rows = new Map([...out.board, ...out.noData].map((r) => [r.playerKey, r]));
  assert.deepEqual([rows.get('P1'), rows.get('P2'), rows.get('P5')].map((r) => [r.leagueAvailability, r.playerStatus.state]), [['rostered', 'inactive'], ['rostered', 'out'], ['rostered', 'none']]);
  assert.deepEqual([rows.get('P10'), rows.get('P11'), rows.get('P0')].map((r) => [r.leagueAvailability, r.playerStatus.state]), [['available', 'inactive'], ['available', 'out'], ['available', 'none']]);
  for (const r of rows.values()) {
    assert.equal(r.leagueAvailability, r.availability, 'copied from the Yahoo roster fact');
    assert.equal(r.leagueAvailability, rostered.has(r.playerKey) ? 'rostered' : 'available', 'never derived from status');
    assert.equal(r.playerStatus.observedAt, AT, 'stale-data checks on the client have the fetch time');
  }
  assert.ok(out.noData.length > 0 && out.noData.every((r) => r.playerStatus), 'rows without projections are annotated too');
});

test('ranking unchanged: annotation adds fields only, and the board ignores status entirely', () => {
  const players = pool(); const before = board(players); const snapshot = JSON.stringify(before);
  const after = withPlayerStatus(before, new Map(players.map((p) => [p.playerKey, p])), { observedAt: AT });
  assert.equal(JSON.stringify(before), snapshot, 'input board is not mutated');
  assert.equal(JSON.stringify(strip(after)), snapshot, 'every existing field, value and row order is byte-identical');
  assert.deepEqual(after.board.map((r) => [r.playerKey, r.overallRank, r.draftPriority, r.value, r.tier]), before.board.map((r) => [r.playerKey, r.overallRank, r.draftPriority, r.value, r.tier]));
  // No status-based multiplier exists: the same pool with every designation removed ranks identically.
  const noStatus = board(pool(false));
  assert.deepEqual(before.board.map((r) => [r.playerKey, r.overallRank, r.value, r.recommendation]), noStatus.board.map((r) => [r.playerKey, r.overallRank, r.value, r.recommendation]));
});
