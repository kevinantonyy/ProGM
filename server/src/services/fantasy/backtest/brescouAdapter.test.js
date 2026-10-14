import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBrescouTrainingAuthorized,
  importBrescouHistoricalCsv,
  parseBrescouSeason,
} from './brescouAdapter.js';

const PROVENANCE = {
  name: 'synthetic-brescou-shaped-fixture',
  permission: 'Repository-generated synthetic fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z',
  authorized: true,
  synthetic: true,
};

const INDEX_HEADER = ',PERSON_ID,PLAYER_LAST_NAME,PLAYER_FIRST_NAME,PLAYER_SLUG,TEAM_ID,TEAM_SLUG,IS_DEFUNCT,TEAM_CITY,TEAM_NAME,TEAM_ABBREVIATION,JERSEY_NUMBER,POSITION,HEIGHT,WEIGHT,COLLEGE,COUNTRY,DRAFT_YEAR,DRAFT_ROUND,DRAFT_NUMBER,ROSTER_STATUS,PTS,REB,AST,STATS_TIMEFRAME,FROM_YEAR,TO_YEAR';
const STATS_HEADER = 'PLAYER_ID,PLAYER_NAME,NICKNAME,TEAM_ID,TEAM_ABBREVIATION,AGE,GP,W,L,W_PCT,MIN,FGM,FGA,FG_PCT,FG3M,FG3A,FG3_PCT,FTM,FTA,FT_PCT,OREB,DREB,REB,AST,TOV,STL,BLK,BLKA,PF,PFD,PTS,PLUS_MINUS,NBA_FANTASY_PTS,DD2,TD3,WNBA_FANTASY_PTS,SEASON';

function indexCsv(players = [{ id: 7, first: 'Fixture', last: 'Player', position: 'G-F', from: 2020 }]) {
  return [INDEX_HEADER, ...players.map((player, index) => `${index},${player.id},${player.last},${player.first},fixture-player,1,test,0,Test,Testers,TST,1,${player.position},6-6,200,Test,USA,2020,1,1,Active,0,0,0,Season,${player.from},2023`)].join('\n');
}

function statsRow({ id = 7, name = 'Fixture Player', teamId = 1, team = 'TST', gp = 50, min = 30, pts = 20, oreb = 2, dreb = 6, reb = 8, dd = 10, td = 2, season = '2022-23' } = {}) {
  return `${id},${name},Fixture,${teamId},${team},24,${gp},30,20,.6,${min},7,15,.467,2,6,.333,4,5,.8,${oreb},${dreb},${reb},6,3,1.2,.8,.5,2.5,4,${pts},2,40,${dd},${td},38,${season}`;
}

function importRows(rows, players) {
  return importBrescouHistoricalCsv({
    playerIndexCsv: indexCsv(players),
    traditionalStatsCsv: [STATS_HEADER, ...rows].join('\n'),
    provenance: PROVENANCE,
  });
}

test('Brescou importer joins player index, normalizes seasons, and maps supported stats', () => {
  const imported = importRows([statsRow()]);
  const row = imported.snapshots[0];
  assert.equal(row.player.id, 'brescou:7');
  assert.equal(row.position, 'G-F');
  assert.equal(row.season, 2022);
  assert.equal(row.experience, 2);
  assert.equal(row.minutesTotal, 1500);
  assert.equal(row.stats.offRebounds, 2);
  assert.equal(row.stats.defRebounds, 6);
  assert.equal(row.stats.doubleDoubles, 0.2);
  assert.equal(row.stats.tripleDoubles, 0.04);
  assert.deepEqual(imported.diagnostics.seasonCoverage, { firstSeason: 2022, lastSeason: 2022, seasonCount: 1, gaps: [] });
});

test('Brescou importer preserves missing values instead of fabricating zeroes', () => {
  const imported = importRows([statsRow({ oreb: '', dreb: '', reb: '' })]);
  assert.equal(imported.snapshots[0].stats.offRebounds, null);
  assert.equal(imported.snapshots[0].stats.defRebounds, null);
  assert.equal(imported.snapshots[0].stats.rebounds, null);
});

test('Brescou importer prefers aggregate traded-player rows without double counting', () => {
  const imported = importRows([
    statsRow({ teamId: 0, team: 'TOT', gp: 60, pts: 24 }),
    statsRow({ teamId: 1, team: 'AAA', gp: 40, pts: 22, dd: 6, td: 1 }),
    statsRow({ teamId: 2, team: 'BBB', gp: 20, pts: 28, dd: 4, td: 1 }),
  ]);
  assert.equal(imported.snapshots.length, 1);
  assert.equal(imported.snapshots[0].gamesPlayed, 60);
  assert.equal(imported.snapshots[0].stats.points, 24);
  assert.equal(imported.diagnostics.aggregateRowsUsed, 1);
  assert.equal(imported.diagnostics.componentRowsDropped, 2);
});

test('Brescou importer safely combines team rows when no aggregate row exists', () => {
  const imported = importRows([
    statsRow({ teamId: 1, team: 'AAA', gp: 30, pts: 10, dd: 3, td: 0 }),
    statsRow({ teamId: 2, team: 'BBB', gp: 20, pts: 20, dd: 2, td: 1 }),
  ]);
  const row = imported.snapshots[0];
  assert.equal(row.teamAbbr, 'TOT');
  assert.equal(row.gamesPlayed, 50);
  assert.equal(row.stats.points, 14);
  assert.equal(row.stats.doubleDoubles, 0.1);
  assert.equal(row.stats.tripleDoubles, 0.02);
  assert.equal(imported.diagnostics.teamRowsAggregated, 2);
});

test('Brescou importer validates identity, duplicates, seasons, and stat consistency', () => {
  assert.throws(() => importRows([statsRow({ id: 99 })]), /missing from player_index/i);
  assert.throws(() => importRows([statsRow(), statsRow()]), /duplicate Brescou player-season-team/i);
  assert.throws(() => importRows([statsRow({ season: '2022-24' })]), /misaligned/i);
  assert.throws(() => importRows([statsRow({ reb: 9 })]), /rebound split/i);
  assert.equal(parseBrescouSeason('1999-00'), 1999);
});

test('Brescou training remains blocked without explicit upstream rights evidence', () => {
  assert.throws(() => assertBrescouTrainingAuthorized(PROVENANCE), /training is blocked/i);
  assert.doesNotThrow(() => assertBrescouTrainingAuthorized({
    ...PROVENANCE,
    commercialModelTrainingAuthorized: true,
    rightsEvidenceUrl: 'https://example.test/permission',
  }));
});

test('historical CLI supports Brescou validation without starting model training', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'progm-brescou-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statsPath = path.join(directory, 'player_stats_traditionnal_rs.csv');
  const indexPath = path.join(directory, 'player_index.csv');
  const provenancePath = path.join(directory, 'provenance.json');
  writeFileSync(statsPath, [STATS_HEADER, statsRow()].join('\n'));
  writeFileSync(indexPath, indexCsv());
  writeFileSync(provenancePath, JSON.stringify(PROVENANCE));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    '--format', 'brescou', '--data', statsPath, '--player-index', indexPath,
    '--provenance', provenancePath, '--validate-only',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.import.rows, 1);
  assert.equal(output.trainingBlocked, true);
  assert.equal(output.accuracyStatus, 'import_validation_only_no_model_training');
});

test('historical CLI refuses a Brescou backtest without upstream rights evidence', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'progm-brescou-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statsPath = path.join(directory, 'player_stats_traditionnal_rs.csv');
  const indexPath = path.join(directory, 'player_index.csv');
  const provenancePath = path.join(directory, 'provenance.json');
  writeFileSync(statsPath, [STATS_HEADER, statsRow()].join('\n'));
  writeFileSync(indexPath, indexCsv());
  writeFileSync(provenancePath, JSON.stringify(PROVENANCE));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    '--format', 'brescou', '--data', statsPath, '--player-index', indexPath,
    '--provenance', provenancePath, '--scoring', path.join(directory, 'unused-scoring.json'),
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /training is blocked/i);
});
