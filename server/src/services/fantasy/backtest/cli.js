import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHistoricalExport } from './datasetAdapter.js';
import { assertBrescouTrainingAuthorized, importBrescouHistoricalCsv } from './brescouAdapter.js';
import { createDevelopmentCandidate } from './developmentModel.js';
import { runChronologicalEvaluation } from './evaluation.js';
import { normalizeTeamRosterDataset } from './rosterSnapshot.js';
import { lastSeasonStatLineBaseline, runWalkForwardBacktest } from './runner.js';
import { createTeamContextCandidate } from './teamContextModel.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function flag(name) {
  return process.argv.includes(name);
}

function integerArgument(name, fallback) {
  const value = argument(name);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

export function runCli() {
  const dataPath = argument('--data');
  const scoringPath = argument('--scoring');
  const validateOnly = flag('--validate-only');
  if (!dataPath || (!scoringPath && !validateOnly)) {
    throw new Error('Usage: npm run backtest:historical -- --data history.json [--player-index player_index.csv] --scoring league-scoring.json [--format json|tabular-json|csv|balldontlie-stats|brescou] [--provenance provenance.json] [--validate-only | --evaluate [--validation-seasons 1] [--test-seasons 1] [--min-train-seasons 2]]');
  }
  const requestedFormat = argument('--format') || (path.extname(dataPath).toLowerCase() === '.csv' ? 'csv' : 'json');
  const data = ['csv', 'brescou'].includes(requestedFormat) ? fs.readFileSync(path.resolve(dataPath), 'utf8') : loadJson(dataPath);
  const provenancePath = argument('--provenance');
  const provenance = provenancePath ? loadJson(provenancePath) : data?.provenance;
  let imported;
  if (requestedFormat === 'brescou') {
    const playerIndexPath = argument('--player-index');
    if (!playerIndexPath) throw new Error('Brescou imports require --player-index player_index.csv.');
    if (!validateOnly) assertBrescouTrainingAuthorized(provenance);
    imported = importBrescouHistoricalCsv({
      playerIndexCsv: fs.readFileSync(path.resolve(playerIndexPath), 'utf8'),
      traditionalStatsCsv: data,
      provenance,
    });
  } else {
    imported = importHistoricalExport({ input: data, format: requestedFormat, provenance, fieldMap: data?.fieldMap });
  }
  if (validateOnly) {
    process.stdout.write(`${JSON.stringify({
      import: imported.diagnostics,
      accuracyStatus: 'import_validation_only_no_model_training',
      trainingBlocked: requestedFormat === 'brescou',
    }, null, 2)}\n`);
    return;
  }
  const scoring = loadJson(scoringPath);
  const statCategories = scoring.statCategories || scoring;
  const requestedModel = argument('--model') || 'all';
  if (!['baseline', 'candidate', 'team-context', 'both', 'all'].includes(requestedModel)) throw new Error('--model must be baseline, candidate, team-context, both, or all.');
  const rosterPath = argument('--rosters');
  const rosterData = rosterPath ? loadJson(rosterPath) : null;
  const rosterDataset = rosterData ? normalizeTeamRosterDataset(rosterData) : null;
  if (flag('--evaluate')) {
    const models = { baseline: lastSeasonStatLineBaseline, candidate: createDevelopmentCandidate() };
    if (rosterDataset) models.teamContext = createTeamContextCandidate({ rosterDataset });
    const evaluation = runChronologicalEvaluation({
      snapshots: imported.snapshots,
      statCategories,
      models,
      validationSeasons: integerArgument('--validation-seasons', 1),
      testSeasons: integerArgument('--test-seasons', 1),
      minTrainSeasons: integerArgument('--min-train-seasons', 2),
    });
    process.stdout.write(`${JSON.stringify({ import: imported.diagnostics, rosterImport: rosterDataset?.diagnostics || null, evaluation }, null, 2)}\n`);
    return;
  }
  const reports = {};
  if (['baseline', 'both', 'all'].includes(requestedModel)) {
    reports.baseline = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories, predictor: lastSeasonStatLineBaseline });
  }
  if (['candidate', 'both', 'all'].includes(requestedModel)) {
    reports.candidate = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories, predictor: createDevelopmentCandidate() });
  }
  if (['team-context', 'all'].includes(requestedModel)) {
    reports.teamContext = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories, predictor: createTeamContextCandidate({ rosterDataset }) });
  }
  process.stdout.write(`${JSON.stringify({
    import: imported.diagnostics,
    rosterImport: rosterDataset?.diagnostics || null,
    accuracyStatus: imported.provenance.synthetic ? 'synthetic_only_unvalidated' : 'historical_backtest_not_production_approved',
    reports,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
