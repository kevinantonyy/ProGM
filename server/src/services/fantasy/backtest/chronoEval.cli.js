import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHistoricalExport } from './datasetAdapter.js';
import { DEFAULT_BASELINES, ageMinutesModel, blendModel, hybridModel, precomputedModel, productionModel } from './evalModels.js';
import { leakageCanary, runChronologicalEvaluation, toPredictionLog } from './chronoEval.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const load = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));

export function runEvaluationCli() {
  const dataPath = arg('--data'); const scoringPath = arg('--scoring'); const outDir = arg('--out') || '.';
  if (!dataPath || !scoringPath) throw new Error('Usage: npm run evaluate:chronological -- --data authorized.json --scoring league-scoring.json [--format json|csv|balldontlie-stats] [--provenance p.json] [--out folder]');
  const format = arg('--format') || (path.extname(dataPath).toLowerCase() === '.csv' ? 'csv' : 'json');
  const data = format === 'csv' ? fs.readFileSync(path.resolve(dataPath), 'utf8') : load(dataPath);
  const provenance = arg('--provenance') ? load(arg('--provenance')) : data?.provenance;
  const imported = importHistoricalExport({ input: data, format, provenance, fieldMap: data?.fieldMap });
  const scoring = load(scoringPath); const statCategories = scoring.statCategories || scoring;
  const models = DEFAULT_BASELINES();
  if (process.argv.includes('--fidelity')) models.push(productionModel({ profilePool: 'active', id: 'production_active_pool' }));
  // Offline ML predictions: --ml file.json (repeatable). Pre-specified hybrids swap in ML games only.
  const mlFiles = process.argv.flatMap((v, i) => (v === '--ml' ? [process.argv[i + 1]] : []));
  for (const f of mlFiles) {
    const ml = precomputedModel(load(f)); models.push(ml);
    models.push(hybridModel({ id: `production+${ml.id}_games`, production: productionModel(), games: precomputedModel(load(f)) }));
    models.push(hybridModel({ id: `age_minutes+${ml.id}_games`, production: ageMinutesModel(), games: precomputedModel(load(f)) }));
    if (process.argv.includes('--ensembles')) {
      models.push(blendModel({ id: `ens_games(production,${ml.id})+age_minutes`, perGame: [ageMinutesModel()], games: [productionModel(), precomputedModel(load(f))] }));
      models.push(blendModel({ id: `ens_all(age_minutes,${ml.id})`, perGame: [ageMinutesModel(), precomputedModel(load(f))], games: [productionModel(), precomputedModel(load(f))] }));
    }
  }
  const allTargets = [...new Set(imported.snapshots.map((r) => r.season))].sort((a, b) => a - b).slice(1);
  const targets = arg('--targets') ? (() => { const [lo, hi] = arg('--targets').split('-').map(Number); return allTargets.filter((t) => t >= lo && t <= hi); })() : allTargets;
  const canary = leakageCanary({ snapshots: imported.snapshots, models, statCategories, targetSeasons: targets.slice(-2) });
  if (!canary.ok) throw new Error(`Leakage canary failed for ${JSON.stringify(canary.leaked)}; report withheld.`);
  const report = runChronologicalEvaluation({ snapshots: imported.snapshots, provenance: imported.provenance, statCategories, models, targetSeasons: targets });
  const { records, ...rest } = report;
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(outDir), 'chrono-eval-report.json'), JSON.stringify({ canary, ...rest }, null, 2));
  fs.writeFileSync(path.join(path.resolve(outDir), 'chrono-eval-predictions.jsonl'), toPredictionLog(records));
  process.stdout.write(`Wrote chrono-eval-report.json and chrono-eval-predictions.jsonl (${records.length} predictions) to ${path.resolve(outDir)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { runEvaluationCli(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; } }
