import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevelopmentCandidate } from './developmentModel.js';
import { importHistoricalExport, normalizeBalldontlieGameStats } from './datasetAdapter.js';
import { runWalkForwardBacktest } from './runner.js';

const PROVENANCE = {
  name: 'synthetic-provider-fixture', datasetVersion: '1',
  permission: 'Repository-generated synthetic fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z', authorized: true, synthetic: true,
};

function bdlGame({ id, season, date, pts, reb, ast = 2, playerId = 7, missing = null }) {
  const row = {
    id: id * 10 + playerId, min: '30:30', fgm: 5, fga: 10, fg3m: 2, ftm: 3, fta: 4,
    oreb: 2, dreb: reb - 2, reb, ast, stl: 1, blk: 1, turnover: 2, pf: 3, pts,
    player: { id: playerId, first_name: 'Fixture', last_name: 'Player', position: 'F' },
    team: { abbreviation: 'TST' }, game: { id, season, date, postseason: false },
  };
  if (missing) delete row[missing];
  return row;
}

test('CSV adapter maps common aliases, quoted fields, and preserves missing values', () => {
  const csv = 'season,player_id,player_name,team,pos,gp,min,pts,ast,reb,oreb,dreb\n2024,p1,"Fixture, One",TST,G,70,31.5,20,6,8,,6';
  const imported = importHistoricalExport({ input: csv, format: 'csv', provenance: PROVENANCE });
  const row = imported.snapshots[0];
  assert.equal(row.player.name, 'Fixture, One');
  assert.equal(row.stats.offRebounds, null);
  assert.equal(row.stats.defRebounds, 6);
  assert.equal(imported.provenance.synthetic, true);
});

test('BALLDONTLIE bulk game adapter aggregates seasons and legitimately derives DD/TD rates', () => {
  const rows = normalizeBalldontlieGameStats({ pages: [{ data: [
    bdlGame({ id: 1, season: 2023, date: '2023-10-20', pts: 20, reb: 11, ast: 10 }),
    bdlGame({ id: 2, season: 2023, date: '2023-10-22', pts: 10, reb: 8, ast: 3 }),
  ] }] });
  assert.equal(rows[0].playerId, 'balldontlie:7');
  assert.equal(rows[0].gamesPlayed, 2);
  assert.equal(rows[0].stats.points, 15);
  assert.equal(rows[0].stats.doubleDoubles, 0.5);
  assert.equal(rows[0].stats.tripleDoubles, 0.5);
  assert.equal(rows[0].age, null);
});

test('BALLDONTLIE adapter preserves incomplete categories and rejects duplicate game rows', () => {
  const incomplete = normalizeBalldontlieGameStats({ data: [bdlGame({ id: 1, season: 2024, date: '2024-10-20', pts: 20, reb: 8, missing: 'oreb' })] });
  assert.equal(incomplete[0].stats.offRebounds, null);
  assert.throws(() => normalizeBalldontlieGameStats({ data: [
    bdlGame({ id: 1, season: 2024, date: '2024-10-20', pts: 20, reb: 8 }),
    bdlGame({ id: 1, season: 2024, date: '2024-10-20', pts: 20, reb: 8 }),
  ] }), /duplicate/i);
});

test('authorized provider-shaped seasons feed the existing candidate backtester', () => {
  const data = [];
  for (const season of [2022, 2023, 2024]) {
    data.push(bdlGame({ id: season * 10, season, date: `${season}-10-20`, pts: 15 + (season - 2022), reb: 8 }));
  }
  const imported = importHistoricalExport({ input: { data }, format: 'balldontlie-stats', provenance: PROVENANCE });
  const scoring = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }];
  const report = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: scoring, predictor: createDevelopmentCandidate() });
  assert.ok(report.coverage.targets > 0);
  assert.ok(report.foldModels.every((fold) => fold.trainingMaxSeason < fold.targetSeason));
});
