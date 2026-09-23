import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankWaivers } from './waiverEngine.js';

function fa(key, elig, proj, pctOwned = 0, status = null) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: pctOwned, status, statusFull: status, _proj: proj };
}

function provider(players) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return { getProjection: (p) => (map.get(p.playerKey) != null ? { projectedPoints: map.get(p.playerKey), confidence: 0.8 } : null) };
}

test('bestAvailable ranks purely by projected points', () => {
  const players = [fa('A', ['PG'], 20), fa('B', ['C'], 35), fa('C', ['SG'], 28)];
  const res = rankWaivers({ availablePlayers: players, projectionProvider: provider(players) });
  assert.deepEqual(res.bestAvailable.map((p) => p.playerKey), ['B', 'C', 'A']);
});

test('bestFit boosts players at thin positions above raw value', () => {
  const players = [fa('HighButDeep', ['SG'], 30), fa('LowButNeeded', ['C'], 26)];
  const analysis = { positions: { thinPositions: [{ position: 'C' }], overloadedPositions: [{ position: 'SG' }] } };
  const res = rankWaivers({ availablePlayers: players, projectionProvider: provider(players), rosterAnalysis: analysis });
  // C is thin (x1.25 => 32.5), SG overloaded (x0.9 => 27). Fit should rank the C player first.
  assert.equal(res.bestFit[0].playerKey, 'LowButNeeded');
  // But best available (raw) still ranks the higher projection first.
  assert.equal(res.bestAvailable[0].playerKey, 'HighButDeep');
});

test('ownership percentage never affects ranking', () => {
  const players = [fa('Owned', ['PG'], 15, 95), fa('Unowned', ['PG'], 25, 1)];
  const res = rankWaivers({ availablePlayers: players, projectionProvider: provider(players) });
  // Higher projection wins despite lower ownership.
  assert.equal(res.bestAvailable[0].playerKey, 'Unowned');
});

test('OUT players are excluded from rankings', () => {
  const players = [fa('Hurt', ['PG'], 40, 50, 'O'), fa('Healthy', ['PG'], 20)];
  const res = rankWaivers({ availablePlayers: players, projectionProvider: provider(players) });
  assert.equal(res.bestAvailable.length, 1);
  assert.equal(res.bestAvailable[0].playerKey, 'Healthy');
});

test('degrades gracefully without projections (facts only)', () => {
  const players = [fa('A', ['PG'], 20, 40)];
  const res = rankWaivers({ availablePlayers: players, projectionProvider: null });
  assert.equal(res.projectionsAvailable, false);
  assert.equal(res.bestAvailable.length, 0);
  assert.equal(res.players[0].percentOwned, 40); // ownership fact still shown
});
