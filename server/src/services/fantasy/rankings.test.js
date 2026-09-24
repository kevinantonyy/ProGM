import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRankings } from './rankings.js';

function pl(key, elig, proj, { owned = 0, status = null } = {}) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: owned, status, _proj: proj };
}

function provider(players, periodMap = {}) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return {
    getProjection: (p) => (map.get(p.playerKey) != null ? { projectedPoints: map.get(p.playerKey), confidence: 0.8 } : null),
    getPeriodValue: (p) => periodMap[p.playerKey] || null,
  };
}

test('sorts by projected points descending', () => {
  const players = [pl('A', ['PG'], 20), pl('B', ['C'], 35), pl('C', ['SG'], 28)];
  const res = buildRankings({ players, projectionProvider: provider(players) });
  assert.deepEqual(res.players.map((p) => p.playerKey), ['B', 'C', 'A']);
});

test('players without projection are listed last and flagged, never zeroed', () => {
  const players = [pl('Known', ['PG'], 20), pl('Unknown', ['PG'], null)];
  const res = buildRankings({ players, projectionProvider: provider(players) });
  assert.equal(res.players[0].playerKey, 'Known');
  assert.equal(res.players[1].playerKey, 'Unknown');
  assert.equal(res.players[1].projected, null); // not 0
  assert.equal(res.players[1].projectionKnown, false);
});

test('ownership never affects the projected ranking', () => {
  const players = [pl('Owned', ['PG'], 10, { owned: 99 }), pl('Better', ['PG'], 25, { owned: 1 })];
  const res = buildRankings({ players, projectionProvider: provider(players) });
  assert.equal(res.players[0].playerKey, 'Better');
});

test('position filter narrows the pool', () => {
  const players = [pl('Guard', ['PG'], 20), pl('Center', ['C'], 30)];
  const res = buildRankings({ players, projectionProvider: provider(players), position: 'C' });
  assert.equal(res.players.length, 1);
  assert.equal(res.players[0].playerKey, 'Center');
});

test('OUT players excluded by default, included on request', () => {
  const players = [pl('Hurt', ['PG'], 40, { status: 'O' }), pl('Healthy', ['PG'], 20)];
  assert.equal(buildRankings({ players, projectionProvider: provider(players) }).players.length, 1);
  assert.equal(buildRankings({ players, projectionProvider: provider(players), includeOut: true }).players.length, 2);
});

test('sort by period value uses schedule-aware projection', () => {
  const players = [pl('Few', ['PG'], 30), pl('Many', ['PG'], 25)];
  const period = { Few: { scheduleAware: true, periodProjectedPoints: 60, expectedGames: 2 }, Many: { scheduleAware: true, periodProjectedPoints: 100, expectedGames: 4 } };
  const res = buildRankings({ players, projectionProvider: provider(players, period), sortBy: 'period' });
  assert.equal(res.players[0].playerKey, 'Many');
});

test('degrades without projections (facts only)', () => {
  const players = [pl('A', ['PG'], 20, { owned: 40 })];
  const res = buildRankings({ players, projectionProvider: null });
  assert.equal(res.projectionsAvailable, false);
  assert.equal(res.players[0].percentOwned, 40);
});
