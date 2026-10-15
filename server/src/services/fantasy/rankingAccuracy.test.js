import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';

// Synthetic players only. Documents the positional adjustments' size so a future change cannot silently inflate them.
const SETTINGS = {
  teamCount: 4,
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true }, { position: 'SG', count: 1, isStarting: true },
    { position: 'C', count: 2, isStarting: true }, { position: 'UTIL', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 75, gameTotal: 82 }));
const mk = (key, pos, pts) => ({ playerKey: key, name: key, teamAbbr: 'AAA', eligiblePositions: [...pos, 'UTIL'], percentOwned: 0, status: null, _pts: pts });
const pool = [
  mk('G1', ['PG'], 50), mk('G2', ['PG'], 44), mk('G3', ['SG'], 40), mk('G4', ['SG'], 36), mk('G5', ['PG'], 30), mk('G6', ['SG'], 28),
  mk('C1', ['C'], 50), mk('C2', ['C'], 40), mk('C3', ['C'], 34), mk('C4', ['C'], 30),
];
const provider = { getProjection: (p) => (p._pts == null ? null : { projectedPoints: p._pts, confidence: 0.9, history }) };
const board = (players = pool) => buildDraftBoard({ players, settings: SETTINGS, projectionProvider: provider, poolComplete: true });
const row = (b, key) => b.board.find((r) => r.playerKey === key);

test('positional bias: equal projections differ only by the bounded replacement + scarcity terms', () => {
  const b = board();
  const g = row(b, 'G1'); const c = row(b, 'C1');
  assert.equal(g.perGame, c.perGame);
  const gap = c.value - g.value;
  // 0.20*replacement + 0.05*scarcity can move a player by at most 25 raw points of 100 scale; require far less here.
  assert.ok(gap >= 0 && gap <= 12, `positional advantage ${gap.toFixed(2)} must stay bounded`);
  assert.ok(c.components.scarcity <= 1 && c.components.replacement <= 1);
});

test('positional bias: a clearly better player is never outranked by a thin-position player', () => {
  const players = pool.map((p) => (p.playerKey === 'G1' ? { ...p, _pts: 58 } : p)); // G1 is far better than C1 now
  const b = board(players);
  assert.ok(row(b, 'G1').overallRank < row(b, 'C1').overallRank);
});

test('missing data: players without a projection are listed as no-data, never ranked or zero-valued', () => {
  const b = board([...pool, mk('X1', ['PG'], null)]);
  assert.equal(b.board.some((r) => r.playerKey === 'X1'), false);
  const x = b.noData.find((r) => r.playerKey === 'X1');
  assert.ok(x && x.value == null && x.overallRank == null);
  assert.equal(b.board.length, pool.length);
});

test('ranking consistency: every ranked player has a unique, contiguous baseline order that matches value order', () => {
  const b = board();
  const byRank = [...b.board].sort((a, c) => a.overallRank - c.overallRank);
  for (let i = 1; i < byRank.length; i += 1) assert.ok(byRank[i].baselineValue <= byRank[i - 1].baselineValue);
  assert.equal(new Set(b.board.map((r) => r.overallRank)).size, b.board.length);
});
