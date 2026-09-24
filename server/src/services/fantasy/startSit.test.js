import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStartSit, resolveStartValue } from './startSit.js';

function player(key, elig, { slot = 'BN', isStarting = false, status = null } = {}) {
  return {
    playerKey: key,
    name: key,
    teamAbbr: 'BOS',
    eligiblePositions: elig,
    primaryPosition: elig[0],
    selectedPosition: slot,
    isStarting,
    status,
    statusFull: status,
  };
}

const settings = {
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'SG', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};

// --- resolveStartValue --------------------------------------------------------

test('resolveStartValue prefers schedule-aware period value when available', () => {
  const provider = {
    getPeriodValue: () => ({ scheduleAware: true, periodProjectedPoints: 120, expectedGames: 4 }),
    getProjectedValue: () => 30,
  };
  const r = resolveStartValue(player('A', ['PG']), provider);
  assert.equal(r.basis, 'period');
  assert.equal(r.value, 120);
  assert.equal(r.expectedGames, 4);
});

test('resolveStartValue falls back to per-game when schedule not available', () => {
  const provider = {
    getPeriodValue: () => ({ scheduleAware: false, periodProjectedPoints: null }),
    getProjectedValue: () => 30,
  };
  const r = resolveStartValue(player('A', ['PG']), provider);
  assert.equal(r.basis, 'perGame');
  assert.equal(r.value, 30);
});

test('resolveStartValue returns null (not 0) when no projection exists', () => {
  const provider = { getProjectedValue: () => null };
  const r = resolveStartValue(player('A', ['PG']), provider);
  assert.equal(r.basis, 'none');
  assert.equal(r.value, null);
});

// --- analyzeStartSit ----------------------------------------------------------

test('recommends starting a higher bench player over a beatable starter', () => {
  const players = [
    player('StarterLow', ['PG'], { slot: 'PG', isStarting: true }),
    player('BenchHigh', ['PG'], { slot: 'BN', isStarting: false }),
  ];
  const vals = { StarterLow: 20, BenchHigh: 30 };
  const provider = { getProjectedValue: (p) => vals[p.playerKey] ?? null };
  const res = analyzeStartSit({ players, settings, projectionProvider: provider });
  assert.equal(res.benchOverStarter.length, 1);
  assert.equal(res.benchOverStarter[0].start.playerKey, 'BenchHigh');
  assert.equal(res.benchOverStarter[0].sit.playerKey, 'StarterLow');
  assert.equal(res.benchOverStarter[0].gain, 10);
});

test('schedule-aware value can flip a start/sit vs per-game', () => {
  const players = [
    player('FewGames', ['PG'], { slot: 'PG', isStarting: true }),
    player('ManyGames', ['PG'], { slot: 'BN', isStarting: false }),
  ];
  // FewGames is better per-game but has fewer games this period.
  const period = { FewGames: { scheduleAware: true, periodProjectedPoints: 60, expectedGames: 2 }, ManyGames: { scheduleAware: true, periodProjectedPoints: 100, expectedGames: 4 } };
  const provider = { getPeriodValue: (p) => period[p.playerKey], getProjectedValue: () => 30 };
  const res = analyzeStartSit({ players, settings, projectionProvider: provider });
  assert.equal(res.scheduleAware, true);
  assert.equal(res.benchOverStarter[0].start.playerKey, 'ManyGames');
});

test('never recommends starting an OUT player', () => {
  const players = [
    player('StarterLow', ['PG'], { slot: 'PG', isStarting: true }),
    player('BenchHighButOut', ['PG'], { slot: 'BN', isStarting: false, status: 'O' }),
  ];
  const vals = { StarterLow: 20, BenchHighButOut: 40 };
  const provider = { getProjectedValue: (p) => vals[p.playerKey] ?? null };
  const res = analyzeStartSit({ players, settings, projectionProvider: provider });
  assert.equal(res.benchOverStarter.length, 0);
});

test('degrades without projections but still reports deterministic issues', () => {
  const players = [player('Hurt', ['PG'], { slot: 'PG', isStarting: true, status: 'O' })];
  const res = analyzeStartSit({ players, settings, projectionProvider: null });
  assert.equal(res.startCandidates, null);
  assert.ok(res.issues.some((i) => i.type === 'injured_in_lineup'));
});
