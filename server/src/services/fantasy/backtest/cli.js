import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHistoricalDataset } from './importer.js';
import { createDevelopmentCandidate } from './developmentModel.js';
import { lastSeasonStatLineBaseline, runWalkForwardBacktest } from './runner.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

export function runCli() {
  const dataPath = argument('--data');
  const scoringPath = argument('--scoring');
  if (!dataPath || !scoringPath) {
    throw new Error('Usage: npm run backtest:historical -- --data authorized-history.json --scoring league-scoring.json');
  }
  const data = loadJson(dataPath);
  const scoring = loadJson(scoringPath);
  const imported = importHistoricalDataset({ rows: data.snapshots || data.rows, provenance: data.provenance });
  const statCategories = scoring.statCategories || scoring;
  const requestedModel = argument('--model') || 'both';
  if (!['baseline', 'candidate', 'both'].includes(requestedModel)) throw new Error('--model must be baseline, candidate, or both.');
  const reports = {};
  if (requestedModel !== 'candidate') {
    reports.baseline = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories, predictor: lastSeasonStatLineBaseline });
  }
  if (requestedModel !== 'baseline') {
    reports.candidate = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories, predictor: createDevelopmentCandidate() });
  }
  process.stdout.write(`${JSON.stringify({
    import: imported.diagnostics,
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
