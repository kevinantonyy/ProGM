import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStatLine } from '../../providers/types.js';
import { importHistoricalDataset, importNormalizedProviderSeason } from './importer.js';
import { HISTORICAL_SNAPSHOT_VERSION, snapshotToStatLine } from './snapshot.js';
import { runWalkForwardBacktest } from './runner.js';

const PROVENANCE = {
  name: 'synthetic-test-fixture',
  datasetVersion: '1',
  permission: 'Repository test fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z',
  authorized: true,
};
const SCORING = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1.5, enabled: true },
  { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
];

function row(playerId, season, points, rebounds, turnovers, gamesPlayed = 70, extra = {}) {
  return {
    season, playerId, name: `Fixture ${playerId}`, teamAbbr: extra.teamAbbr || 'AAA',
    position: 'G', age: extra.age ?? 25, experience: extra.experience ?? 3,
    gamesPlayed, minutesPerGame: 30,
    stats: { points, rebounds, turnovers },
  };
}

test('imports a versioned snapshot with explicit nulls and derived total minutes', () => {
  const imported = importHistoricalDataset({ rows: [row('p1', 2024, 20, 8, 3)], provenance: PROVENANCE });
  const snapshot = imported.snapshots[0];
  assert.equal(snapshot.schemaVersion, HISTORICAL_SNAPSHOT_VERSION);
  assert.equal(snapshot.minutesTotal, 2100);
  assert.equal(snapshot.derived.minutesTotal, true);
  assert.equal(snapshot.stats.assists, null);
  assert.equal(snapshot.provenance.authorized, true);
});

test('rejects unauthorized sources, name-only identities, duplicates, and season mismatches', () => {
  assert.throws(() => importHistoricalDataset({ rows: [], provenance: { ...PROVENANCE, authorized: false } }), /authorization/i);
  assert.throws(() => importHistoricalDataset({ rows: [{ season: 2024, name: 'No Id' }], provenance: PROVENANCE }), /stable player id/i);
  assert.throws(() => importHistoricalDataset({ rows: [row('p1', 2024, 1, 1, 1), row('p1', 2024, 2, 2, 2)], provenance: PROVENANCE }), /duplicate/i);
  assert.throws(() => importHistoricalDataset({ rows: [{ ...row('p1', 2024, 1, 1, 1), statSeason: 2023 }], provenance: PROVENANCE }), /alignment/i);
});

test('normalized provider adapter reuses provider stat lines without fetching', () => {
  const line = { ...emptyStatLine(), gamesPlayed: 60, minutes: 28, points: 17, rebounds: 6, turnovers: 2 };
  const imported = importNormalizedProviderSeason({
    season: 2024,
    playerIndex: [{ externalId: '9', name: 'Fixture Nine', teamAbbr: 'BBB', age: 24, debutYear: 2022 }],
    playerStats: [{ externalId: '9', season: line }],
    provenance: PROVENANCE,
  });
  assert.equal(imported.snapshots[0].experience, 2);
  assert.equal(snapshotToStatLine(imported.snapshots[0]).points, 17);
});

test('walk-forward predictor cannot see target or future seasons', () => {
  const imported = importHistoricalDataset({
    rows: [row('p1', 2023, 10, 5, 2), row('p1', 2024, 12, 6, 2), row('p1', 2025, 30, 9, 4)],
    provenance: PROVENANCE,
  });
  const seen = [];
  function guardedPredictor({ targetSeason, training, history }) {
    seen.push({ targetSeason, seasons: training.map((item) => item.season) });
    assert.ok(training.every((item) => item.season < targetSeason));
    assert.ok(history.every((item) => item.season < targetSeason));
    const prior = history[0];
    return prior ? { statLine: snapshotToStatLine(prior), expectedGames: prior.gamesPlayed } : null;
  }
  runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: SCORING, predictor: guardedPredictor });
  assert.deepEqual(seen[0], { targetSeason: 2024, seasons: [2023] });
  assert.deepEqual(seen[1], { targetSeason: 2025, seasons: [2023, 2024] });
});

test('baseline scores league settings consistently and reports errors, ranks, coverage, and cohorts', () => {
  const imported = importHistoricalDataset({
    rows: [
      row('p1', 2024, 20, 8, 3, 70, { teamAbbr: 'AAA', age: 24, experience: 2 }),
      row('p2', 2024, 10, 4, 1, 60, { teamAbbr: 'BBB', age: 31, experience: 9 }),
      row('p1', 2025, 22, 9, 3, 72, { teamAbbr: 'AAA', age: 25, experience: 3 }),
      row('p2', 2025, 9, 5, 2, 55, { teamAbbr: 'CCC', age: 32, experience: 10 }),
    ],
    provenance: PROVENANCE,
  });
  const report = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: SCORING });
  // p1 predicted 20 + 8*1.5 - 3 = 29; actual 22 + 9*1.5 - 3 = 32.5.
  assert.equal(report.fantasy.perGame.count, 2);
  assert.equal(report.fantasy.perGame.mae, 2);
  assert.equal(report.coverage.predictionRate, 1);
  assert.equal(report.rankCorrelation.fantasyPerGame.correlation, 1);
  assert.equal(report.cohorts.same_team.sampleCount, 1);
  assert.equal(report.cohorts.changed_team.sampleCount, 1);
  assert.equal(report.nbaStats.perGame.points.count, 2);
  assert.ok(report.fantasy.seasonTotal.rmse > 0);
});

test('missing weighted categories exclude fantasy comparisons without inventing zero', () => {
  const imported = importHistoricalDataset({
    rows: [
      row('p1', 2024, 20, null, 3),
      row('p1', 2025, 22, 9, 3),
    ],
    provenance: PROVENANCE,
  });
  const report = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: SCORING });
  assert.equal(report.coverage.predictions, 1);
  assert.equal(report.coverage.fantasyComparable, 0);
  assert.equal(report.fantasy.perGame.count, 0);
  assert.equal(report.nbaStats.perGame.points.count, 1);
});
