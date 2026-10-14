import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importHistoricalDataset } from './importer.js';
import { normalizeTeamRosterDataset, rosterRowsFromPlayerSeasons } from './rosterSnapshot.js';
import { runWalkForwardBacktest } from './runner.js';
import { buildTeamContextFeatures, createTeamContextCandidate, fitTeamContextModel } from './teamContextModel.js';

const PROVENANCE = {
  name: 'synthetic-team-context-fixture', datasetVersion: '1',
  permission: 'Repository-generated synthetic fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z', authorized: true, synthetic: true,
};

function row(playerId, season, teamAbbr, minutesPerGame, position = 'G') {
  return {
    season, playerId, name: `Fixture ${playerId}`, teamAbbr, position,
    age: 22 + Number(playerId.replace(/\D/g, '') || 0) % 10,
    experience: season - 2020, gamesPlayed: 82, minutesPerGame,
    stats: {
      points: minutesPerGame / 2, rebounds: minutesPerGame / 6,
      offRebounds: minutesPerGame / 18, defRebounds: minutesPerGame / 9,
      assists: minutesPerGame / 8, steals: 1, blocks: 0.5, turnovers: 2,
      personalFouls: 2, fgMade: minutesPerGame / 6, fgAtt: minutesPerGame / 3,
      ftMade: minutesPerGame / 12, ftAtt: minutesPerGame / 10,
      threesMade: minutesPerGame / 12, doubleDoubles: 0, tripleDoubles: 0,
    },
  };
}

function fixture() {
  const rows = [];
  const players = Array.from({ length: 14 }, (_, index) => `${index < 7 ? 'a' : 'b'}${index}`);
  for (const season of [2021, 2022, 2023, 2024]) {
    for (let index = 0; index < players.length; index += 1) {
      const id = players[index];
      let team = index < 7 ? 'AAA' : 'BBB';
      if (season >= 2023 && id === 'a1') team = 'BBB';
      if (season >= 2023 && id === 'b8') team = 'AAA';
      if (season === 2024 && id === 'b9') team = 'AAA';
      rows.push(row(id, season, team, 36 + (index % 3), index % 3 === 0 ? 'F' : 'G'));
    }
  }
  const imported = importHistoricalDataset({ rows, provenance: PROVENANCE });
  const teamSeasons = [];
  for (const season of [2021, 2022, 2023, 2024]) {
    for (const teamAbbr of ['AAA', 'BBB']) teamSeasons.push({ season, teamAbbr, complete: true });
  }
  const rosterDataset = normalizeTeamRosterDataset({
    rows: rosterRowsFromPlayerSeasons(imported.snapshots).map((item) => ({ ...item, knownBeforeSeason: true })), teamSeasons, provenance: PROVENANCE,
  });
  return { snapshots: imported.snapshots, rosterDataset };
}

test('roster snapshots preserve trades, minutes, provenance, and explicit completeness only', () => {
  const { rosterDataset } = fixture();
  const traded = rosterDataset.snapshots.find((item) => item.season === 2023 && item.player.id === 'a1');
  assert.equal(traded.teamAbbr, 'BBB');
  assert.ok(traded.minutesTotal > 0);
  assert.equal(traded.teamRosterComplete, true);
  const partial = normalizeTeamRosterDataset({ rows: [{ season: 2024, playerId: 'p1', name: 'P One', teamAbbr: 'CCC' }], provenance: PROVENANCE });
  assert.equal(partial.snapshots[0].teamRosterComplete, false);
  assert.equal(partial.snapshots[0].knownBeforeSeason, false);
  assert.equal(partial.snapshots[0].gamesPlayed, null);
});

test('target roster affiliations not verified before the season are rejected to prevent lookahead', () => {
  const { snapshots, rosterDataset } = fixture();
  rosterDataset.snapshots.find((item) => item.season === 2024 && item.player.id === 'a0').knownBeforeSeason = false;
  const context = buildTeamContextFeatures({ playerId: 'a0', targetSeason: 2024, training: snapshots.filter((item) => item.season < 2024), rosters: rosterDataset.snapshots });
  assert.equal(context.available, false);
  assert.equal(context.reason, 'roster_not_preseason_verified');
});

test('features quantify departures, incoming competition, continuity, and team changes from prior data', () => {
  const { snapshots, rosterDataset } = fixture();
  const training = snapshots.filter((item) => item.season < 2023);
  const returning = buildTeamContextFeatures({ playerId: 'a0', targetSeason: 2023, training, rosters: rosterDataset.snapshots });
  const incoming = buildTeamContextFeatures({ playerId: 'b8', targetSeason: 2023, training, rosters: rosterDataset.snapshots });
  assert.equal(returning.available, true);
  assert.ok(returning.values.departedMinutesShare > 0);
  assert.ok(returning.values.incomingMinutesShare > 0);
  assert.ok(returning.values.positionCompetitionShare > 0);
  assert.equal(incoming.values.teamChanged, 1);
});

test('incomplete rosters and missing competitor data produce neutral context instead of assumptions', () => {
  const { snapshots, rosterDataset } = fixture();
  rosterDataset.snapshots.find((item) => item.season === 2024 && item.teamAbbr === 'AAA').teamRosterComplete = false;
  const context = buildTeamContextFeatures({ playerId: 'a0', targetSeason: 2024, training: snapshots.filter((item) => item.season < 2024), rosters: rosterDataset.snapshots });
  assert.equal(context.available, false);
  assert.equal(context.reason, 'incomplete_roster');
});

test('untrained team model is exactly neutral for projected minutes', () => {
  const { snapshots, rosterDataset } = fixture();
  const training = snapshots.filter((item) => item.season < 2022);
  const artifact = fitTeamContextModel(training, 2022, rosterDataset, { minimumTrainingSamples: 999 });
  const history = training.filter((item) => item.player.id === 'a0');
  const prediction = artifact.predict({ player: { id: 'a0' }, history });
  assert.equal(artifact.diagnostics.trained, false);
  assert.equal(prediction.diagnostics.teamContext.applied, false);
  assert.equal(prediction.diagnostics.teamContext.learnedMinutesDelta, 0);
  assert.equal(prediction.statLine.minutes, prediction.diagnostics.minutesBase + prediction.diagnostics.minutesDevelopmentDelta);
});

test('trained allocation constrains complete team season minutes and exposes replacement bucket', () => {
  const { snapshots, rosterDataset } = fixture();
  const training = snapshots.filter((item) => item.season < 2024);
  const artifact = fitTeamContextModel(training, 2024, rosterDataset, { minimumTrainingSamples: 4 });
  assert.equal(artifact.diagnostics.trained, true);
  const targetTeam = rosterDataset.snapshots.filter((item) => item.season === 2024 && item.teamAbbr === 'AAA');
  const predictions = targetTeam.map((item) => artifact.predict({
    player: item.player,
    history: training.filter((rowItem) => rowItem.player.id === item.player.id).sort((a, b) => b.season - a.season),
  })).filter(Boolean);
  const allocated = predictions.reduce((sum, prediction) => sum + prediction.statLine.minutes * prediction.expectedGames, 0);
  assert.ok(allocated <= 240 * 82 + 0.1);
  assert.ok(predictions.some((prediction) => prediction.diagnostics.teamContext.constraintScale < 1));
  assert.ok(predictions.every((prediction) => prediction.diagnostics.teamContext.unallocatedReplacementMinutes >= 0));
});

test('walk-forward fit prevents lookahead and reports team-context cohorts and errors', () => {
  const { snapshots, rosterDataset } = fixture();
  const scoring = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }];
  const report = runWalkForwardBacktest({
    snapshots, statCategories: scoring,
    predictor: createTeamContextCandidate({ rosterDataset, minimumTrainingSamples: 4 }),
    targetSeasons: [2024],
  });
  assert.ok(report.foldModels.every((fold) => fold.trainingMaxSeason < fold.targetSeason));
  assert.ok(report.nbaStats.minutesPerGame.count > 0);
  assert.ok(report.fantasy.perGame.count > 0);
  assert.ok(report.fantasy.seasonTotal.count > 0);
  assert.ok(report.cohorts.team_context_changed_team.sampleCount > 0);
});
