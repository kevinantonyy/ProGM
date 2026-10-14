import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStatLine } from '../scoring.js';
import { importHistoricalDataset } from './importer.js';
import { createDevelopmentCandidate, fitDevelopmentModel } from './developmentModel.js';
import { runWalkForwardBacktest } from './runner.js';

const PROVENANCE = {
  name: 'synthetic-development-fixture',
  datasetVersion: '1',
  permission: 'Repository test fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z',
  authorized: true,
  synthetic: true,
};

const FULL_SCORING = [
  { statId: 4, abbr: 'FGM', pointValue: 2, enabled: true },
  { statId: 5, abbr: 'FGA', pointValue: -0.5, enabled: true },
  { statId: 7, abbr: 'FTM', pointValue: 1, enabled: true },
  { statId: 8, abbr: 'FTA', pointValue: -0.25, enabled: true },
  { statId: 10, abbr: '3PM', pointValue: 2, enabled: true },
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 13, abbr: 'OREB', pointValue: 1.5, enabled: true },
  { statId: 14, abbr: 'DREB', pointValue: 1.2, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true },
  { statId: 17, abbr: 'ST', pointValue: 3, enabled: true },
  { statId: 18, abbr: 'BLK', pointValue: 3, enabled: true },
  { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
  { statId: 21, abbr: 'PF', pointValue: -0.5, enabled: true },
  { statId: 27, abbr: 'DD', pointValue: 3, enabled: true },
  { statId: 28, abbr: 'TD', pointValue: 5, enabled: true },
];

function stats(minutes, multiplier = 1, { assistsRate = 0.16, missing = [] } = {}) {
  const fgAtt = minutes * 0.5 * multiplier;
  const fgMade = fgAtt * 0.46;
  const ftAtt = minutes * 0.18 * multiplier;
  const ftMade = ftAtt * 0.8;
  const threesMade = Math.min(fgMade, minutes * 0.07 * multiplier);
  const values = {
    fgAtt, fgMade, ftAtt, ftMade, threesMade,
    points: 2 * fgMade + threesMade + ftMade,
    offRebounds: minutes * 0.05 * multiplier,
    defRebounds: minutes * 0.14 * multiplier,
    rebounds: minutes * 0.19 * multiplier,
    assists: minutes * assistsRate,
    steals: minutes * 0.035,
    blocks: minutes * 0.02,
    turnovers: minutes * 0.075,
    personalFouls: minutes * 0.065,
    doubleDoubles: minutes * 0.008,
    tripleDoubles: minutes * 0.001,
  };
  for (const key of missing) values[key] = null;
  return values;
}

function row(id, season, age, experience, minutes, multiplier = 1, options = {}) {
  return {
    season,
    playerId: id,
    name: `Fixture ${id}`,
    teamAbbr: options.teamAbbr || 'AAA',
    position: options.position || 'G',
    age,
    experience,
    gamesPlayed: options.gamesPlayed ?? 70,
    minutesPerGame: minutes,
    stats: stats(minutes, multiplier, options),
  };
}

function developmentTraining() {
  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    rows.push(row(`young${index}`, 2021, 20, 0, 20, 1, { assistsRate: 0.10 }));
    rows.push(row(`young${index}`, 2022, 21, 1, 22, 1.08, { assistsRate: 0.115 }));
    rows.push(row(`old${index}`, 2021, 32, 10, 32, 1, { assistsRate: 0.20 }));
    rows.push(row(`old${index}`, 2022, 33, 11, 30, 0.94, { assistsRate: 0.18 }));
  }
  return importHistoricalDataset({ rows, provenance: PROVENANCE }).snapshots;
}

test('learned fold curves reflect synthetic young improvement and veteran decline without hardcoded age bonuses', () => {
  const training = developmentTraining();
  const artifact = fitDevelopmentModel(training, 2023);
  const young = artifact.predict({ history: training.filter((item) => item.player.id === 'young0').sort((a, b) => b.season - a.season) });
  const veteran = artifact.predict({ history: training.filter((item) => item.player.id === 'old0').sort((a, b) => b.season - a.season) });
  assert.ok(young.diagnostics.minutesDevelopmentDelta > 0);
  assert.ok(veteran.diagnostics.minutesDevelopmentDelta < 0);
  assert.ok(young.diagnostics.stats.assists.developmentDelta > 0);
  assert.ok(veteran.diagnostics.stats.assists.developmentDelta < 0);
  assert.equal(artifact.diagnostics.accuracyValidated, false);
});

test('candidate uses multiple seasons and does not copy the latest stat line', () => {
  const training = developmentTraining();
  training.push(...importHistoricalDataset({
    rows: [row('trend', 2020, 21, 1, 20, 0.7), row('trend', 2021, 22, 2, 24, 0.85), row('trend', 2022, 23, 3, 28, 1)],
    provenance: PROVENANCE,
  }).snapshots);
  const artifact = fitDevelopmentModel(training, 2023);
  const history = training.filter((item) => item.player.id === 'trend').sort((a, b) => b.season - a.season);
  const prediction = artifact.predict({ history });
  assert.ok(prediction.sourceSeasons.length >= 3);
  assert.notEqual(prediction.statLine.assists, history[0].stats.assists);
  assert.equal(prediction.method, 'multiseason_age_development_candidate');
});

test('missing age is neutral while missing minutes or a player stat stays unavailable', () => {
  const training = developmentTraining();
  const missingAge = importHistoricalDataset({
    rows: [row('unknown-age', 2022, null, null, 26, 1)], provenance: PROVENANCE,
  }).snapshots[0];
  const missingMinutes = importHistoricalDataset({
    rows: [{ ...row('missing-minutes', 2022, 25, 3, 26, 1), minutesPerGame: null }], provenance: PROVENANCE,
  }).snapshots[0];
  const missingAssists = importHistoricalDataset({
    rows: [row('missing-assists', 2022, 25, 3, 26, 1, { missing: ['assists'] })], provenance: PROVENANCE,
  }).snapshots[0];
  training.push(missingAge, missingMinutes, missingAssists);
  const artifact = fitDevelopmentModel(training, 2023);
  const agePrediction = artifact.predict({ history: [missingAge] });
  assert.ok(agePrediction);
  assert.equal(agePrediction.diagnostics.minutesDevelopmentDelta, 0);
  assert.equal(artifact.predict({ history: [missingMinutes] }), null);
  assert.equal(artifact.predict({ history: [missingAssists] }).statLine.assists, null);
});

test('candidate preserves stat relationships and exact league scoring including negatives', () => {
  const training = developmentTraining();
  const artifact = fitDevelopmentModel(training, 2023);
  const history = training.filter((item) => item.player.id === 'young0').sort((a, b) => b.season - a.season);
  const line = artifact.predict({ history }).statLine;
  assert.ok(line.fgMade <= line.fgAtt);
  assert.ok(line.ftMade <= line.ftAtt);
  assert.ok(line.threesMade <= line.fgMade);
  assert.equal(line.rebounds, Number((line.offRebounds + line.defRebounds).toFixed(4)));
  assert.equal(line.points, Number((2 * line.fgMade + line.threesMade + line.ftMade).toFixed(4)));
  assert.ok(line.tripleDoubles <= line.doubleDoubles);
  const scored = scoreStatLine(line, FULL_SCORING);
  assert.deepEqual(scored.unsupportedStats, []);
  const turnoverContribution = scored.breakdown.find((item) => item.abbr === 'TO');
  assert.ok(turnoverContribution.points < 0);
});

test('walk-forward candidate fits a fresh artifact per season with no future leakage', () => {
  const rows = [];
  for (let season = 2020; season <= 2024; season += 1) {
    for (let player = 0; player < 8; player += 1) rows.push(row(`p${player}`, season, 20 + player + season - 2020, season - 2020, 20 + player + season - 2020, 1 + 0.02 * (season - 2020)));
  }
  const snapshots = importHistoricalDataset({ rows, provenance: PROVENANCE }).snapshots;
  const report = runWalkForwardBacktest({ snapshots, statCategories: FULL_SCORING, predictor: createDevelopmentCandidate() });
  assert.equal(report.model, 'multiseason_age_development_candidate');
  assert.ok(report.foldModels.length > 0);
  for (const fold of report.foldModels) {
    assert.ok(fold.trainingMaxSeason == null || fold.trainingMaxSeason < fold.targetSeason);
    assert.equal(fold.accuracyValidated, false);
  }
  assert.ok(report.nbaStats.minutesPerGame.count > 0);
  assert.ok(report.rankCorrelation.fantasyPerGame.count > 0);
});
