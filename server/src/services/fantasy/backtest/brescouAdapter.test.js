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

// Header rows copied from the published Brescou files (player/player_stats_traditionnal_rs.csv
// and player/player_index.csv, checked 2026-10-14). Headers only: no player data is committed.
const REAL_STATS_HEADER = 'PLAYER_ID,PLAYER_NAME,NICKNAME,TEAM_ID,TEAM_ABBREVIATION,AGE,GP,W,L,W_PCT,MIN,FGM,FGA,FG_PCT,FG3M,FG3A,FG3_PCT,FTM,FTA,FT_PCT,OREB,DREB,REB,AST,TOV,STL,BLK,BLKA,PF,PFD,PTS,PLUS_MINUS,NBA_FANTASY_PTS,DD2,TD3,WNBA_FANTASY_PTS,GP_RANK,W_RANK,L_RANK,W_PCT_RANK,MIN_RANK,FGM_RANK,FGA_RANK,FG_PCT_RANK,FG3M_RANK,FG3A_RANK,FG3_PCT_RANK,FTM_RANK,FTA_RANK,FT_PCT_RANK,OREB_RANK,DREB_RANK,REB_RANK,AST_RANK,TOV_RANK,STL_RANK,BLK_RANK,BLKA_RANK,PF_RANK,PFD_RANK,PTS_RANK,PLUS_MINUS_RANK,NBA_FANTASY_PTS_RANK,DD2_RANK,TD3_RANK,WNBA_FANTASY_PTS_RANK,SEASON';
const REAL_INDEX_HEADER = ',PERSON_ID,PLAYER_LAST_NAME,PLAYER_FIRST_NAME,PLAYER_SLUG,TEAM_ID,TEAM_SLUG,IS_DEFUNCT,TEAM_CITY,TEAM_NAME,TEAM_ABBREVIATION,JERSEY_NUMBER,POSITION,HEIGHT,WEIGHT,COLLEGE,COUNTRY,DRAFT_YEAR,DRAFT_ROUND,DRAFT_NUMBER,ROSTER_STATUS,PTS,REB,AST,STATS_TIMEFRAME,FROM_YEAR,TO_YEAR';

function realLayoutRow(header, values) {
  return header.split(',').map((column) => values[column] ?? (column.endsWith('_RANK') ? 1 : '')).join(',');
}

function realLayoutFixture({ players = 6, seasons = ['2017-18', '2018-19', '2019-20', '2020-21', '2021-22', '2022-23'] } = {}) {
  const index = [REAL_INDEX_HEADER];
  const stats = [REAL_STATS_HEADER];
  for (let p = 1; p <= players; p += 1) {
    index.push(realLayoutRow(REAL_INDEX_HEADER, { '': p - 1, PERSON_ID: 100 + p, PLAYER_LAST_NAME: `Player${p}`, PLAYER_FIRST_NAME: 'Synthetic', POSITION: p % 2 ? 'G' : 'F-C', FROM_YEAR: 2016 }));
    seasons.forEach((season, s) => {
      const reb = 4 + p;
      stats.push(realLayoutRow(REAL_STATS_HEADER, {
        PLAYER_ID: 100 + p, PLAYER_NAME: `Synthetic Player${p}`, TEAM_ID: 1610612700 + p, TEAM_ABBREVIATION: `T${p}`,
        AGE: 21 + p + s, GP: 60 + s, MIN: 24 + p, FGM: 5, FGA: 11, FG3M: 1.5, FG3A: 4, FTM: 2, FTA: 2.5,
        OREB: 1, DREB: reb - 1, REB: reb, AST: 2 + (p % 3), TOV: 1.8, STL: 0.9, BLK: 0.5, PF: 2,
        PTS: 10 + p * 1.5 + s * (p % 3), DD2: p, TD3: 0, SEASON: season,
      }));
    });
  }
  return { indexCsv: index.join('\n'), statsCsv: stats.join('\n') };
}

test('importer accepts the real Brescou column layout, including rank columns', () => {
  const { indexCsv: realIndex, statsCsv } = realLayoutFixture({ players: 2, seasons: ['2021-22', '2022-23'] });
  const imported = importBrescouHistoricalCsv({ playerIndexCsv: realIndex, traditionalStatsCsv: statsCsv, provenance: PROVENANCE });
  assert.equal(imported.snapshots.length, 4);
  assert.equal(imported.provenance.restrictedSource, 'brescou');
  const row = imported.snapshots.find((item) => item.player.id === 'brescou:101' && item.season === 2022);
  assert.equal(row.stats.threesMade, 1.5);
  assert.equal(row.stats.turnovers, 1.8);
  assert.equal(row.experience, 6);
  assert.deepEqual(imported.diagnostics.seasonCoverage, { firstSeason: 2021, lastSeason: 2022, seasonCount: 2, gaps: [] });
});

test('CLI chronological evaluation runs on Brescou-format input only once rights are documented', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'progm-brescou-eval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { indexCsv: realIndex, statsCsv } = realLayoutFixture();
  const files = {
    stats: path.join(directory, 'player_stats_traditionnal_rs.csv'),
    index: path.join(directory, 'player_index.csv'),
    blocked: path.join(directory, 'provenance.json'),
    rights: path.join(directory, 'provenance-with-rights.json'),
    scoring: path.join(directory, 'scoring.json'),
  };
  writeFileSync(files.stats, statsCsv);
  writeFileSync(files.index, realIndex);
  writeFileSync(files.blocked, JSON.stringify(PROVENANCE));
  writeFileSync(files.rights, JSON.stringify({ ...PROVENANCE, commercialModelTrainingAuthorized: true, rightsEvidenceUrl: 'https://example.test/synthetic-rights' }));
  writeFileSync(files.scoring, JSON.stringify([
    { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
    { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
    { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true },
    { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
  ]));
  const run = (provenancePath) => spawnSync(process.execPath, [
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    '--format', 'brescou', '--data', files.stats, '--player-index', files.index,
    '--provenance', provenancePath, '--scoring', files.scoring, '--evaluate', '--min-train-seasons', '3',
  ], { encoding: 'utf8' });

  const blocked = run(files.blocked);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /training is blocked/i);

  const allowed = run(files.rights);
  assert.equal(allowed.status, 0, allowed.stderr);
  const { evaluation } = JSON.parse(allowed.stdout);
  assert.deepEqual(evaluation.split, { train: [2017, 2018, 2019, 2020], validation: [2021], test: [2022] });
  assert.deepEqual(Object.keys(evaluation.test.models), ['baseline', 'candidate']);
  assert.equal(evaluation.sampleSizes.testCommon, 6);
  assert.equal(evaluation.test.models.baseline.common.sampleCount, evaluation.test.models.candidate.common.sampleCount);
  assert.equal(evaluation.accuracyStatus, 'synthetic_only_unvalidated');
});
