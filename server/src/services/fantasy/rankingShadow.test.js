import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { rankingProfile, resolveRankingShadow } from './rankingModel.js';
import { compareBoards, runRankingShadow, shadowLogLine } from './rankingShadow.js';

// Synthetic players only.
const SETTINGS = { teamCount: 4, rosterSlots: [
  { position: 'PG', count: 1, isStarting: true }, { position: 'SF', count: 1, isStarting: true },
  { position: 'C', count: 1, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 74, gameTotal: 82 }));
const POS = ['PG', 'SF', 'C'];
const specs = Array.from({ length: 36 }, (_, i) => ({ key: `P${i}`, pos: POS[i % 3], pts: 50 - i * 0.9 - (i % 3 === 2 ? 2 : 0) }));
const mk = () => specs.map((s) => ({ playerKey: s.key, name: `Player ${s.key}`, teamAbbr: 'AAA', eligiblePositions: [s.pos], percentOwned: 0, status: null }));
const proj = { getProjection: (p) => { const s = specs.find((x) => x.key === p.playerKey); return s ? { projectedPoints: s.pts, confidence: 0.9, history } : null; } };
const analysis = { counts: { rosterSize: 0 }, positions: { thinPositions: [], overloadedPositions: [] } };
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const args = (extra = {}) => ({ players: mk(), settings: SETTINGS, projectionProvider: proj, rosterAnalysis: analysis, poolComplete: true, ...extra });
const legacy = (extra) => buildDraftBoard({ ...args(extra), rankingModel: 'legacy' });
const v2 = (extra) => buildDraftBoard({ ...args(extra), rankingModel: 'v2' });

test('shadow flag is off by default and only applies to legacy without rookie estimates; cache identity unchanged', () => {
  assert.equal(resolveRankingShadow({}), false);
  for (const v of ['', 'no', 'off', 'maybe', undefined]) assert.equal(resolveRankingShadow({ PROGM_RANKING_SHADOW: v }), false);
  for (const v of ['on', 'TRUE', '1']) assert.equal(resolveRankingShadow({ PROGM_RANKING_SHADOW: v }), true);
  assert.equal(resolveRankingShadow({ PROGM_RANKING_SHADOW: 'on', PROGM_RANKING_MODEL: 'v2' }), false);
  assert.equal(resolveRankingShadow({ PROGM_RANKING_SHADOW: 'on', PROGM_ROOKIE_ESTIMATES: 'on' }), false);
  assert.equal(rankingProfile({ PROGM_RANKING_SHADOW: 'on' }), rankingProfile({}));
});

test('legacy board and downstream Rankings are byte-identical with shadow run vs not run, and inputs are never mutated', () => {
  const plain = JSON.stringify(legacy());
  const plainRankings = JSON.stringify(buildRankings({ players: mk(), projectionProvider: proj, overallRanks: new Map(legacy().board.map((r) => [r.playerKey, r.overallRank])), sortBy: 'overall' }));
  // Frozen inputs: any mutation by the shadow path would throw in strict mode and surface as ok:false.
  const frozen = deepFreeze(args());
  const legacyBoard = buildDraftBoard({ ...frozen, rankingModel: 'legacy' });
  const result = runRankingShadow({ legacyBoard, buildV2: () => buildDraftBoard({ ...frozen, rankingModel: 'v2' }) });
  assert.equal(result.ok, true, result.error);
  assert.equal(JSON.stringify(legacyBoard), plain);
  const after = JSON.stringify(buildRankings({ players: mk(), projectionProvider: proj, overallRanks: new Map(legacyBoard.board.map((r) => [r.playerKey, r.overallRank])), sortBy: 'overall' }));
  assert.equal(after, plainRankings);
  assert.equal(legacyBoard.rankingModel, 'legacy');
});

test('shadow failure falls back safely: error class only, legacy untouched', () => {
  const legacyBoard = legacy(); const before = JSON.stringify(legacyBoard);
  const boom = runRankingShadow({ legacyBoard, buildV2: () => { throw new RangeError('secret league_key 428.l.99999 should not leak'); } });
  assert.deepEqual({ ok: boom.ok, error: boom.error }, { ok: false, error: 'RangeError' });
  assert.ok(!JSON.stringify(boom).includes('428.l'));
  assert.ok(!shadowLogLine(boom).includes('428.l'));
  assert.equal(runRankingShadow({ legacyBoard, buildV2: () => ({ board: [] }) }).ok, false);
  assert.equal(runRankingShadow({ legacyBoard, buildV2: () => legacy() }).error, 'v2_model_mismatch'); // would-be silent legacy-as-v2
  assert.equal(runRankingShadow({ legacyBoard: { board: [] }, buildV2: () => assert.fail('must not run') }).skipped, 'no_legacy_board');
  assert.equal(JSON.stringify(legacyBoard), before);
});

test('comparison: overlap, movers, per-position changes, highlights, and agreement with the re-derived v2', () => {
  const L = legacy(); const V = v2();
  const c = compareBoards(L.board, V.board, { highlight: ['Player P2', 'player p5'] });
  assert.equal(c.players, 36);
  assert.deepEqual(c.topOverlap.map((t) => t.n), [25, 50, 100]);
  for (const t of c.topOverlap) assert.ok(t.overlap <= Math.min(t.n, t.legacyCount));
  assert.deepEqual(Object.keys(c.byPosition), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']);
  assert.equal(c.byPosition.C.players, 12);
  assert.ok(c.byPosition.C.meanRankChange <= 0, 'removing the C scarcity bonus must not lift centers on average');
  assert.equal(c.byPosition.SG.players, 0);
  assert.equal(c.highlighted.length, 2);
  assert.equal(c.crossCheck.mismatched, 0);
  assert.deepEqual(c.anomalies, []);
  // identical boards: no movement
  const same = compareBoards(L.board, L.board);
  assert.equal(same.movers.countUp + same.movers.countDown, 0);
  assert.equal(same.topOverlap[1].overlap, same.topOverlap[1].legacyCount);
});

test('anomalies are reported, not hidden', () => {
  const L = legacy().board; const V = v2().board;
  const a = compareBoards(L, V.slice(1));
  assert.ok(a.anomalies.some((x) => x.code === 'pool_size_differs'));
  assert.ok(a.anomalies.some((x) => x.code === 'players_missing_in_v2'));
  const bad = V.map((r, i) => (i === 0 ? { ...r, baselineValue: NaN } : r));
  assert.ok(compareBoards(L, bad).anomalies.some((x) => x.code === 'non_finite_value'));
});

test('result carries names and numbers only (no league/team identifiers)', () => {
  const r = runRankingShadow({ legacyBoard: legacy(), buildV2: () => v2() });
  const text = JSON.stringify(r);
  for (const banned of ['leagueKey', 'teamKey', 'token', 'playerKey', 'teamName', '.l.', '.t.']) assert.ok(!text.includes(banned), banned);
  assert.match(shadowLogLine(r), /^\[ranking-shadow\] ok players=36 top50=\d+\/\d+ anomalies=0 ms=\d+$/);
});
