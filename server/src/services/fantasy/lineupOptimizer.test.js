import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeLineup } from './lineupOptimizer.js';

// Simple 2-slot league: 1 PG, 1 Util. Bench holds extras.
const SETTINGS = {
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'Util', count: 1, isStarting: true },
    { position: 'BN', count: 2, isStarting: false },
  ],
};

function player(key, elig, slot, proj, status = null) {
  return {
    playerKey: key, name: key, eligiblePositions: elig,
    selectedPosition: slot, isStarting: slot !== 'BN' && slot !== 'IL', status, statusFull: status,
  };
}

function providerFrom(map) {
  return { getProjection: (p) => (map[p.playerKey] != null ? { projectedPoints: map[p.playerKey], confidence: 0.9 } : null) };
}

test('optimizer benches a lower projection for a higher one in a legal lineup', () => {
  const players = [
    player('A', ['PG', 'G', 'Util'], 'PG', 10),
    player('B', ['PG', 'G', 'Util'], 'Util', 15),
    player('C', ['PG', 'G', 'Util'], 'BN', 30), // best, currently benched
  ];
  const res = optimizeLineup({ players, settings: SETTINGS, projectionProvider: providerFrom({ A: 10, B: 15, C: 30 }) });
  assert.equal(res.projectionsAvailable, true);
  // Optimal should start C (30) and B (15) = 45; current A+B = 25.
  assert.equal(res.projectedCurrentPoints, 25);
  assert.equal(res.projectedOptimizedPoints, 45);
  assert.equal(res.projectedDifference, 20);
  assert.ok(res.swaps.some((s) => s.in.playerKey === 'C'));
});

test('optimizer respects positional eligibility (illegal lineups impossible)', () => {
  // Only A is PG-eligible; the optimizer must keep A at PG even if B projects higher.
  const players = [
    player('A', ['PG'], 'PG', 10),
    player('B', ['Util'], 'Util', 40),
    player('C', ['Util'], 'BN', 35),
  ];
  const res = optimizeLineup({ players, settings: SETTINGS, projectionProvider: providerFrom({ A: 10, B: 40, C: 35 }) });
  const pgSlot = res.recommendedLineup.find((s) => s.slot === 'PG');
  assert.equal(pgSlot.playerKey, 'A'); // only legal PG
  // Util should be the higher of B/C = B (40).
  const utilSlot = res.recommendedLineup.find((s) => s.slot === 'Util');
  assert.equal(utilSlot.playerKey, 'B');
});

test('optimizer excludes OUT players from recommended lineup', () => {
  const players = [
    player('A', ['PG', 'Util'], 'PG', 30, 'O'), // out, currently starting
    player('B', ['PG', 'Util'], 'Util', 12),
    player('C', ['PG', 'Util'], 'BN', 20),
  ];
  const res = optimizeLineup({ players, settings: SETTINGS, projectionProvider: providerFrom({ A: 30, B: 12, C: 20 }) });
  const keys = res.recommendedLineup.map((s) => s.playerKey);
  assert.ok(!keys.includes('A')); // out player benched despite high projection
  assert.ok(keys.includes('B') && keys.includes('C'));
});

test('optimizer degrades gracefully with no projections', () => {
  const players = [player('A', ['PG'], 'PG', null), player('B', ['Util'], 'Util', null)];
  const res = optimizeLineup({ players, settings: SETTINGS, projectionProvider: { getProjection: () => null } });
  assert.equal(res.projectionsAvailable, false);
  assert.equal(res.projectedDifference, null);
  assert.equal(res.swaps.length, 0);
});
