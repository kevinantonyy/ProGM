import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptGameLogs, parseGameLogCsv } from './gameLogAdapter.js';
import { loadPlayerGameLogs, runEnsembleEvaluation, runGameLogEvaluation } from './gameLogEvaluation.js';
import { ingestBatch, registerSource } from './ingest.js';

/**
 * Register an authorized source and ingest its game logs season by season.
 * Each season is one atomic, idempotent batch, so re-running is incremental.
 * Permission checks happen in registerSource/ingestBatch before anything is stored.
 */
export async function importGameLogRows(store, { rows, source, seasonLabel, fieldMap, seasons }) {
  const registered = await registerSource(store, source);
  const { batches, diagnostics } = adaptGameLogs(rows, { sourceKey: registered.sourceKey, seasonLabel, fieldMap, seasons });
  const results = [];
  for (const { season, ...batch } of batches) {
    const result = await ingestBatch(store, batch);
    results.push({ season, runId: result.runId, counts: result.counts });
  }
  return { sourceKey: registered.sourceKey, diagnostics, seasons: results };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readRows(filePath) {
  const text = fs.readFileSync(path.resolve(filePath), 'utf8');
  if (filePath.toLowerCase().endsWith('.csv')) return parseGameLogCsv(text);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

async function main() {
  const { postgresPool } = await import('../../db/connection.js');
  const { PostgresSportsDataStore } = await import('./postgresStore.js');
  const store = new PostgresSportsDataStore(postgresPool);
  try {
    await store.ensureSchema();
    if (process.argv.includes('--evaluate')) {
      const sourceKey = argument('--source-key');
      const scoringPath = argument('--scoring');
      if (!sourceKey || !scoringPath) throw new Error('Usage: --evaluate --source-key <key> --scoring scoring.json [--split-season 2025 --test-from 2026-02-01] [--ensemble]');
      const scoring = JSON.parse(fs.readFileSync(path.resolve(scoringPath), 'utf8'));
      const logs = await loadPlayerGameLogs(store, { sourceKey, statCategories: scoring.statCategories || scoring });
      const testFrom = argument('--test-from');
      const dateSplit = testFrom ? { season: Number(argument('--split-season')), testFrom } : null;
      const evaluate = process.argv.includes('--ensemble') ? runEnsembleEvaluation : runGameLogEvaluation;
      process.stdout.write(`${JSON.stringify(evaluate({ logs, dateSplit }), null, 2)}\n`);
      return;
    }
    const dataPath = argument('--data');
    const sourcePath = argument('--source');
    const seasonLabel = argument('--season-label');
    if (!dataPath || !sourcePath || !seasonLabel) throw new Error('Usage: --data logs.csv|json --source source.json --season-label end|start [--seasons 2015,2016]');
    const seasons = argument('--seasons') ? argument('--seasons').split(',').map(Number) : null;
    const result = await importGameLogRows(store, {
      rows: readRows(dataPath),
      source: JSON.parse(fs.readFileSync(path.resolve(sourcePath), 'utf8')),
      seasonLabel,
      seasons,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await postgresPool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
