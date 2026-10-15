import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { compareRankingModels } from './rankingCompare.js';

const SETTINGS = { teamCount: 4, rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 2, isStarting: true }, { position: 'UTIL', count: 1, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 75, gameTotal: 82 }));
const mk = (key, pos, pts) => ({ playerKey: key, name: `Player ${key}`, teamAbbr: 'AAA', eligiblePositions: [...pos, 'UTIL'], percentOwned: 0, status: null, _pts: pts });
const pool = [mk('G1', ['PG'], 50), mk('G2', ['PG'], 46), mk('G3', ['PG'], 44), mk('G4', ['PG'], 40), mk('C1', ['C'], 45), mk('C2', ['C'], 43), mk('C3', ['C'], 41), mk('C4', ['C'], 36)];
const provider = { getProjection: (p) => ({ projectedPoints: p._pts, confidence: 0.9, history }) };
const rows = (rankingModel) => buildDraftBoard({ players: pool, settings: SETTINGS, projectionProvider: provider, rankingModel, poolComplete: true }).board;

test('comparison is identical whichever model built the cached board (both values come from components)', () => {
  const a = compareRankingModels(rows('legacy'), { top: 5 });
  const b = compareRankingModels(rows('v2'), { top: 5 });
  assert.deepEqual(a.topByLegacy.map((r) => [r.name, r.legacyRank, r.v2Rank, r.valueLegacy, r.valueV2]), b.topByLegacy.map((r) => [r.name, r.legacyRank, r.v2Rank, r.valueLegacy, r.valueV2]));
});

test('legacy ranks equal the production board ranks; v2 removes the scarcity points', () => {
  const board = rows('legacy');
  const cmp = compareRankingModels(board, { top: 8 });
  for (const r of cmp.topByLegacy) assert.equal(r.legacyRank, board.find((b) => b.name === r.name).overallRank);
  const c1 = cmp.topByLegacy.find((r) => r.name === 'Player C1'); const g1 = cmp.topByLegacy.find((r) => r.name === 'Player G1');
  assert.ok(c1.factors.scarcityPtsLegacy > g1.factors.scarcityPtsLegacy);
  assert.equal(c1.factors.scarcityPtsV2, 0);
  assert.ok(c1.v2Rank >= c1.legacyRank); // centers cannot gain from removing their own bonus
});

test('highlight lookup is by supplied name only, shows factors, and reports the shift summary', () => {
  const cmp = compareRankingModels(rows('legacy'), { top: 3, highlight: ['player c2', 'Nobody Here'] });
  assert.equal(cmp.highlighted.length, 1);
  assert.equal(cmp.highlighted[0].name, 'Player C2');
  assert.ok('productionPts' in cmp.highlighted[0].factors && 'replacementPts' in cmp.highlighted[0].factors);
  assert.ok(cmp.summary.meanRankShiftV2.cEligible >= cmp.summary.meanRankShiftV2.otherPositions);
  assert.ok(cmp.summary.topOverlap <= 3);
  assert.equal(compareRankingModels(rows('legacy'), { top: 3 }).highlighted.length, 0);
});

test('output carries no identifiers beyond player names and numbers', () => {
  const dirty = rows('legacy').map((r) => ({ ...r, leagueKey: '466.l.123', teamKey: '466.l.123.t.1', accessToken: 'secret-token', rosterOwner: 'Someone' }));
  const text = JSON.stringify(compareRankingModels(dirty, { top: 8 }));
  for (const bad of ['466.l', 'secret-token', 'Someone', 'leagueKey', 'teamKey']) assert.equal(text.includes(bad), false, bad);
});

test('estimate rows are flagged and rows without components are skipped, never invented', () => {
  const board = rows('legacy');
  const withEst = [{ ...board[0], estimate: true, projectionMethod: 'market_prior_estimate' }, { name: 'No Components' }, ...board.slice(1)];
  const cmp = compareRankingModels(withEst, { top: 8 });
  assert.equal(cmp.players, board.length);
  assert.equal(cmp.summary.estimateRows, 1);
  assert.equal(cmp.topByLegacy.some((r) => r.name === 'No Components'), false);
});

test('highlight lookup ignores accents so a Yahoo name with diacritics is found', () => {
  const board = rows('legacy').map((r, i) => (i === 0 ? { ...r, name: 'Alperen Şengün' } : r));
  const cmp = compareRankingModels(board, { top: 5, highlight: ['Alperen Sengun'] });
  assert.equal(cmp.highlighted.length, 1);
  assert.equal(cmp.highlighted[0].name, 'Alperen Şengün');
});
