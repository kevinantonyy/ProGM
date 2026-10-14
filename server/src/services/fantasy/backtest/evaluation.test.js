import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHistoricalExport } from './datasetAdapter.js';
import { createDevelopmentCandidate } from './developmentModel.js';
import { chronologicalSplit, datasetFingerprint, runChronologicalEvaluation } from './evaluation.js';
import { importHistoricalDataset } from './importer.js';
import { lastSeasonStatLineBaseline, runWalkForwardBacktest } from './runner.js';
import { snapshotToStatLine } from './snapshot.js';

// Synthetic fixtures verify evaluation mechanics only; they are not evidence of real-world accuracy.
const PROVENANCE = {
  name: 'synthetic-evaluation-fixture',
  permission: 'Repository test fixture; no real player data.',
  acquiredAt: '2026-10-14T00:00:00Z',
  authorized: true,
  synthetic: true,
};
const POINTS_ONLY = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }];

function row(playerId, season, points, extra = {}) {
  return {
    season, playerId, name: `Fixture ${playerId}`, teamAbbr: 'AAA', position: 'G',
    age: 25, experience: 3, gamesPlayed: 70, minutesPerGame: 30, stats: { points }, ...extra,
  };
}

function snapshotsFrom(rows, provenance = PROVENANCE) {
  return importHistoricalDataset({ rows, provenance }).snapshots;
}

// p1: 10, 12, 14, 16 / p2: 20, 20, 18, 22 for seasons 2019-2022.
const HAND_ROWS = [
  row('p1', 2019, 10), row('p1', 2020, 12), row('p1', 2021, 14), row('p1', 2022, 16),
  row('p2', 2019, 20), row('p2', 2020, 20), row('p2', 2021, 18), row('p2', 2022, 22),
];

function trend({ history }) {
  if (history.length < 2) return null;
  const line = snapshotToStatLine(history[0]);
  line.points = history[0].stats.points + (history[0].stats.points - history[1].stats.points);
  return { statLine: line, expectedGames: history[0].gamesPlayed };
}

function evaluate(rows, models = { baseline: lastSeasonStatLineBaseline, trend }) {
  return runChronologicalEvaluation({ snapshots: snapshotsFrom(rows), statCategories: POINTS_ONLY, models });
}

test('chronological split keeps train < validation < test and rejects short histories', () => {
  assert.deepEqual(chronologicalSplit([2022, 2019, 2021, 2020, 2021]), { train: [2019, 2020], validation: [2021], test: [2022] });
  assert.deepEqual(chronologicalSplit([2015, 2016, 2017, 2018, 2019, 2020], { validationSeasons: 2, testSeasons: 2 }),
    { train: [2015, 2016], validation: [2017, 2018], test: [2019, 2020] });
  assert.throws(() => chronologicalSplit([2020, 2021, 2022]), /at least 4 seasons/);
  assert.throws(() => chronologicalSplit([2019, 2020, 2021, 2022], { testSeasons: 0 }), /testSeasons/);
});

test('evaluation metrics match hand-computed MAE, RMSE, bias, and selection', () => {
  const report = evaluate(HAND_ROWS);
  assert.deepEqual(report.split, { train: [2019, 2020], validation: [2021], test: [2022] });
  const validationBaseline = report.validation.models.baseline.common.fantasyPerGame;
  assert.deepEqual(validationBaseline, { count: 2, mae: 2, rmse: 2, bias: 0 });
  assert.deepEqual(report.validation.models.trend.common.fantasyPerGame, { count: 2, mae: 1, rmse: 1.4142, bias: 1 });
  assert.equal(report.selection.selectedModel, 'trend');
  // Test season: baseline errors -2/-4, trend errors 0/-6. Equal MAE, so no claimed improvement.
  assert.deepEqual(report.test.models.baseline.common.fantasyPerGame, { count: 2, mae: 3, rmse: 3.1623, bias: -3 });
  assert.deepEqual(report.test.models.trend.common.fantasyPerGame, { count: 2, mae: 3, rmse: 4.2426, bias: -3 });
  assert.deepEqual(report.testComparison.fantasyPerGameMae, { selected: 3, baseline: 3, relativeChange: 0 });
  assert.equal(report.testComparison.seasonsImproved, 0);
  assert.equal(report.testComparison.seasonsCompared, 1);
  assert.equal(report.test.models.baseline.common.fantasySeasonTotal.mae, 210);
  assert.equal(report.test.models.baseline.common.bySeason[0].season, 2022);
  assert.equal(report.sampleSizes.testCommon, 2);
  assert.equal(report.accuracyStatus, 'synthetic_only_unvalidated');
});

test('models are compared only on player-seasons every model predicted', () => {
  const abstainsOnP2 = ({ history }) => (history[0]?.player.id === 'p2' ? null : lastSeasonStatLineBaseline({ history, targetSeason: history[0].season + 1 }));
  const report = evaluate(HAND_ROWS, { baseline: lastSeasonStatLineBaseline, abstainsOnP2 });
  assert.equal(report.test.commonSampleCount, 1);
  assert.equal(report.test.models.baseline.common.sampleCount, 1);
  assert.equal(report.test.models.baseline.coverage.predictions, 2);
  assert.equal(report.test.models.abstainsOnP2.coverage.predictions, 1);
});

test('predictors never receive target-season or future rows', () => {
  const seen = [];
  const spy = {
    name: 'spy',
    fit({ training, targetSeason }) {
      assert.ok(training.every((item) => item.season < targetSeason));
      return ({ targetSeason: target, player, history, training: foldTraining }) => {
        assert.deepEqual(Object.keys(player).sort(), ['id', 'name']);
        assert.ok(history.every((item) => item.season < target));
        assert.ok(foldTraining.every((item) => item.season < target));
        seen.push(target);
        return lastSeasonStatLineBaseline({ history, targetSeason: target });
      };
    },
  };
  evaluate(HAND_ROWS, { baseline: lastSeasonStatLineBaseline, spy });
  assert.deepEqual([...new Set(seen)], [2021, 2022]);
});

test('test-season outcomes cannot change validation results or model selection', () => {
  const original = evaluate(HAND_ROWS);
  const alteredTest = HAND_ROWS.map((item) => (item.season === 2022 ? { ...item, stats: { points: item.stats.points * 5 } } : item));
  const altered = evaluate(alteredTest);
  assert.deepEqual(altered.validation, original.validation);
  assert.deepEqual(altered.selection, original.selection);
  assert.notDeepEqual(altered.test, original.test);

  // Future seasons do not change earlier-season predictions in the walk-forward runner.
  const earlier = runWalkForwardBacktest({ snapshots: snapshotsFrom(HAND_ROWS), statCategories: POINTS_ONLY, targetSeasons: [2021], includeRecords: true });
  const earlierAltered = runWalkForwardBacktest({ snapshots: snapshotsFrom(alteredTest), statCategories: POINTS_ONLY, targetSeasons: [2021], includeRecords: true });
  assert.deepEqual(earlierAltered.records, earlier.records);
});

test('evaluation is reproducible regardless of input order', () => {
  const shuffled = [HAND_ROWS[5], HAND_ROWS[2], HAND_ROWS[7], HAND_ROWS[0], HAND_ROWS[4], HAND_ROWS[1], HAND_ROWS[6], HAND_ROWS[3]];
  const first = evaluate(HAND_ROWS);
  assert.deepEqual(evaluate(shuffled), first);
  assert.deepEqual(evaluate(HAND_ROWS), first);
  assert.match(first.dataFingerprint, /^[0-9a-f]{64}$/);
  const changed = HAND_ROWS.map((item, index) => (index === 0 ? { ...item, stats: { points: 11 } } : item));
  assert.notEqual(datasetFingerprint(snapshotsFrom(changed)), first.dataFingerprint);
});

test('existing development candidate runs through the evaluation workflow', () => {
  const rows = [];
  for (let player = 1; player <= 8; player += 1) {
    for (let season = 2016; season <= 2021; season += 1) {
      rows.push(row(`d${player}`, season, 8 + player + (season - 2016) * (player % 3), { age: 20 + player + (season - 2016), experience: season - 2015 }));
    }
  }
  const report = evaluate(rows, { baseline: lastSeasonStatLineBaseline, candidate: createDevelopmentCandidate() });
  assert.deepEqual(report.split.test, [2021]);
  assert.ok(report.sampleSizes.testCommon > 0);
  assert.ok(['baseline', 'candidate'].includes(report.selection.selectedModel));
  assert.equal(report.accuracyStatus, 'synthetic_only_unvalidated');
});

const BRESCOU_SHAPED = {
  rows: [2019, 2020, 2021, 2022].map((season, index) => ({
    PLAYER_ID: '7', PLAYER_NAME: 'Fixture Player', SEASON: season, PTS: 10 + index, GP: 60,
    NBA_FANTASY_PTS: 1, WNBA_FANTASY_PTS: 1, DD2: 0, TD3: 0,
  })),
  fieldMap: { season: 'SEASON', playerId: 'PLAYER_ID', name: 'PLAYER_NAME', points: 'PTS', gamesPlayed: 'GP' },
};
const NEUTRAL_PROVENANCE = { ...PROVENANCE, name: 'renamed-export' };

test('Brescou data is restricted whatever import format or source name is used', () => {
  const viaTabular = importHistoricalExport({ input: BRESCOU_SHAPED.rows, format: 'tabular-json', provenance: NEUTRAL_PROVENANCE, fieldMap: BRESCOU_SHAPED.fieldMap });
  assert.equal(viaTabular.provenance.restrictedSource, 'brescou');
  const csv = [Object.keys(BRESCOU_SHAPED.rows[0]).join(','), ...BRESCOU_SHAPED.rows.map((item) => Object.values(item).join(','))].join('\n');
  const viaCsv = importHistoricalExport({ input: csv, format: 'csv', provenance: NEUTRAL_PROVENANCE, fieldMap: BRESCOU_SHAPED.fieldMap });
  assert.equal(viaCsv.provenance.restrictedSource, 'brescou');
  const viaJsonIds = importHistoricalExport({ input: { rows: HAND_ROWS.map((item) => ({ ...item, playerId: `brescou:${item.playerId}` })) }, format: 'json', provenance: NEUTRAL_PROVENANCE });
  assert.equal(viaJsonIds.provenance.restrictedSource, 'brescou');
  const viaName = importHistoricalExport({ input: { rows: HAND_ROWS }, format: 'json', provenance: { ...PROVENANCE, sourceUrl: 'https://github.com/Brescou/NBA-dataset-stats-player-team' } });
  assert.equal(viaName.provenance.restrictedSource, 'brescou');
  const viaSavedSnapshots = importHistoricalExport({ input: { snapshots: viaCsv.snapshots.map((item) => ({ ...item, playerId: item.player.id, name: item.player.name })) }, format: 'json', provenance: NEUTRAL_PROVENANCE });
  assert.equal(viaSavedSnapshots.provenance.restrictedSource, 'brescou');

  for (const imported of [viaTabular, viaCsv, viaJsonIds, viaName, viaSavedSnapshots]) {
    assert.throws(() => runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: POINTS_ONLY }), /training is blocked/i);
    assert.throws(() => runChronologicalEvaluation({ snapshots: imported.snapshots, statCategories: POINTS_ONLY, models: { baseline: lastSeasonStatLineBaseline } }), /training is blocked/i);
  }
  const clean = importHistoricalExport({ input: { rows: HAND_ROWS }, format: 'json', provenance: PROVENANCE });
  assert.equal(clean.provenance.restrictedSource, null);
});

test('restricted data becomes usable only with documented training rights', () => {
  const imported = importHistoricalExport({
    input: { rows: HAND_ROWS.map((item) => ({ ...item, playerId: `brescou:${item.playerId}` })) },
    format: 'json',
    provenance: { ...PROVENANCE, commercialModelTrainingAuthorized: true, rightsEvidenceUrl: 'https://example.test/permission' },
  });
  assert.equal(imported.provenance.restrictedSource, 'brescou');
  assert.doesNotThrow(() => runChronologicalEvaluation({ snapshots: imported.snapshots, statCategories: POINTS_ONLY, models: { baseline: lastSeasonStatLineBaseline } }));
});

function runCliWith(t, files, args) {
  const directory = mkdtempSync(path.join(tmpdir(), 'progm-eval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, name), content);
  return spawnSync(process.execPath, [
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    ...args.map((item) => (Object.hasOwn(files, item) ? path.join(directory, item) : item)),
  ], { encoding: 'utf8' });
}

test('CLI --evaluate produces a reproducible chronological report', (t) => {
  const files = { 'history.json': JSON.stringify({ rows: HAND_ROWS, provenance: PROVENANCE }), 'scoring.json': JSON.stringify(POINTS_ONLY) };
  const args = ['--data', 'history.json', '--scoring', 'scoring.json', '--evaluate'];
  const first = runCliWith(t, files, args);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.deepEqual(output.evaluation.split, { train: [2019, 2020], validation: [2021], test: [2022] });
  assert.deepEqual(Object.keys(output.evaluation.test.models), ['baseline', 'candidate']);
  assert.equal(output.evaluation.accuracyStatus, 'synthetic_only_unvalidated');
  assert.equal(runCliWith(t, files, args).stdout, first.stdout);
});

test('CLI refuses evaluation of Brescou-shaped CSV imported with --format csv', (t) => {
  // Generic aliases make the rows importable; the retained Brescou columns must still trigger the gate.
  const header = 'player_id,player_name,season,pts,gp,NBA_FANTASY_PTS,WNBA_FANTASY_PTS,DD2,TD3';
  const csv = [header, ...[2019, 2020, 2021, 2022].map((season, index) => `7,Fixture Player,${season},${10 + index},60,1,1,0,0`)].join('\n');
  const files = { 'renamed.csv': csv, 'provenance.json': JSON.stringify(NEUTRAL_PROVENANCE), 'scoring.json': JSON.stringify(POINTS_ONLY) };
  const validated = runCliWith(t, files, ['--data', 'renamed.csv', '--format', 'csv', '--provenance', 'provenance.json', '--validate-only']);
  assert.equal(validated.status, 0, validated.stderr);
  const result = runCliWith(t, files, ['--data', 'renamed.csv', '--format', 'csv', '--provenance', 'provenance.json', '--scoring', 'scoring.json', '--evaluate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /training is blocked/i);
  const backtest = runCliWith(t, files, ['--data', 'renamed.csv', '--format', 'csv', '--provenance', 'provenance.json', '--scoring', 'scoring.json', '--model', 'baseline']);
  assert.notEqual(backtest.status, 0);
  assert.match(backtest.stderr, /training is blocked/i);
});
