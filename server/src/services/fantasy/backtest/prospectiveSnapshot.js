/**
 * Frozen prospective snapshot: forecasts for one future target season from every registered model, written once with hashes.
 *   node prospectiveSnapshot.js --data dataset.json --scoring league.json --ml-lgbm p.json --ml-ridge p.json --params params.json --target 2026 --commit <sha> --out dir
 * Uses only data final before the forecast date (same point-in-time path as the backtests). Never overwrites an existing snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importHistoricalExport } from './datasetAdapter.js';
import { ageMinutesModel, blendModel, precomputedModel, productionModel, tierShrinkGamesModel } from './evalModels.js';
import { predictForTarget } from './chronoEval.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const load = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function registeredModels({ lgbmDoc, ridgeDoc, params }) {
  return [
    { role: 'reference', model: productionModel() },
    { role: 'reference', model: ageMinutesModel() },
    { role: 'secondary', model: precomputedModel(lgbmDoc) },
    { role: 'secondary', model: precomputedModel(ridgeDoc) },
    { role: 'secondary', model: blendModel({ id: 'ens_all(age_minutes,ml_ridge)', perGame: [ageMinutesModel(), precomputedModel(ridgeDoc)], games: [productionModel(), precomputedModel(ridgeDoc)] }) },
    { role: 'primary', model: tierShrinkGamesModel({ id: 'candidate_tier_shrink', perGame: ageMinutesModel(), reference: productionModel(), ml: precomputedModel(lgbmDoc), topN: params.topTierSize, weights: { top: Number(params.mlGamesWeight.top.toFixed(2)), rest: Number(params.mlGamesWeight.rest.toFixed(2)) } }) },
  ];
}

export function buildSnapshot({ snapshots, provenance, statCategories, registered, targetSeason, commit, generatedAt }) {
  const names = new Map(snapshots.map((r) => [r.player.id, r.player.name]));
  const models = registered.map(({ role, model }) => {
    const res = predictForTarget({ snapshots, model, targetSeason, statCategories });
    return { id: model.id, version: model.version, role, asOf: res.asOf, dataCutoffSeason: res.view.cutoffSeason, dataFingerprint: res.view.fingerprint,
      predictions: res.predictions.map((p) => ({ ...p, name: names.get(p.playerId) ?? null })) };
  });
  return { schema: 'progm.prospective-snapshot.v1', targetSeason, generatedAt, codeCommit: commit, provenance: { name: provenance.name, exportId: provenance.exportId ?? null, licenseStatus: provenance.licenseStatus ?? null },
    scoringHash: sha(JSON.stringify(statCategories)).slice(0, 16), statCategories, universe: 'players with 800+ minutes in the previous regular season', models };
}

function main() {
  const out = path.resolve(arg('--out')); const target = Number(arg('--target'));
  const file = path.join(out, `snapshot-${target}.json`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists; a frozen snapshot is never overwritten.`);
  const data = load(arg('--data')); const imported = importHistoricalExport({ input: data, format: 'json', provenance: data.provenance });
  const scoring = load(arg('--scoring')); const statCategories = scoring.statCategories || scoring;
  const registered = registeredModels({ lgbmDoc: load(arg('--ml-lgbm')), ridgeDoc: load(arg('--ml-ridge')), params: load(arg('--params')) });
  const snap = buildSnapshot({ snapshots: imported.snapshots, provenance: imported.provenance, statCategories, registered, targetSeason: target, commit: arg('--commit'), generatedAt: new Date().toISOString() });
  fs.mkdirSync(out, { recursive: true });
  const text = JSON.stringify(snap, null, 1); fs.writeFileSync(file, text);
  const manifest = { schema: 'progm.prospective-manifest.v1', file: path.basename(file), sha256: sha(text), generatedAt: snap.generatedAt, codeCommit: snap.codeCommit, targetSeason: target,
    models: snap.models.map((m) => ({ id: m.id, version: m.version, role: m.role, predictions: m.predictions.length, dataCutoffSeason: m.dataCutoffSeason, dataFingerprint: m.dataFingerprint })),
    inputs: { dataset: sha(fs.readFileSync(path.resolve(arg('--data')))), mlLgbm: sha(fs.readFileSync(path.resolve(arg('--ml-lgbm')))), mlRidge: sha(fs.readFileSync(path.resolve(arg('--ml-ridge')))), params: load(arg('--params')) } };
  fs.writeFileSync(path.join(out, `manifest-${target}.json`), JSON.stringify(manifest, null, 2));
  process.stdout.write(`Frozen ${file} sha256=${manifest.sha256}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; } }
