import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importHistoricalDataset } from './importer.js';
import { DEFAULT_BASELINES, productionModel, ageMinutesModel } from './evalModels.js';
import { PREDICTION_SCHEMA, assertAuthorized, leakageCanary, predictForTarget, runChronologicalEvaluation, toPredictionLog, validatePredictionRecord } from './chronoEval.js';
import { createPointInTimeView, forecastAsOf, seasonFinalAt } from './pointInTime.js';
import { errorStats, pairedFolds, spearman, topN } from './evalMetrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE = { name: 'synthetic-chrono-fixture', datasetVersion: '1', permission: 'Repository-generated synthetic data; no real players.', acquiredAt: '2026-10-14T00:00:00Z', authorized: true, synthetic: true, coverage: 'complete' };
const SCORING = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }, { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true }, { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true }];
const growth = (age) => (age <= 23 ? 0.06 : age <= 27 ? 0.01 : age <= 31 ? -0.025 : -0.07);

let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
function synthetic({ players = 260, from = 2016, to = 2024 } = {}) {
  seed = 99; const rows = [];
  for (let i = 0; i < players; i += 1) {
    let age = 20 + Math.floor(rnd() * 14) - Math.floor((rnd() * 3)); let fpm = 0.5 + rnd() * 0.9; let mpg = 17 + rnd() * 17; const fragile = rnd() < 0.25;
    for (let y = from; y <= to; y += 1) {
      const gp = Math.max(8, Math.min(82, Math.round((fragile ? 52 : 72) + (rnd() - 0.5) * 30)));
      if (!(rnd() < 0.06 && y > from + 1)) { // random absence = missing season row
        const fp = fpm * mpg; rows.push({ season: y, playerId: `p${i}`, name: `Player ${i}`, age, experience: Math.max(0, age - 19), gamesPlayed: gp, minutesPerGame: mpg,
          stats: { points: fp * 0.62, rebounds: fp * 0.2 / 1.2, assists: fp * 0.18 / 1.5 } });
      }
      fpm = Math.max(0.25, fpm + growth(age) + (rnd() - 0.5) * 0.05); mpg = Math.min(38, Math.max(10, mpg + (28 - mpg) * 0.1 + (rnd() - 0.5) * 3)); age += 1;
    }
  }
  return importHistoricalDataset({ rows, provenance: PROVENANCE });
}
const DATA = synthetic();
const TARGETS = [2020, 2021, 2022, 2023, 2024];

test('point-in-time view: only rows final before the forecast date, deep-frozen, future availability respected', () => {
  const rows = [...DATA.snapshots, { ...structuredClone(DATA.snapshots[0]), player: { id: 'late', name: 'Late' }, season: 2019, availableAt: '2021-03-01T00:00:00.000Z' }];
  const v = createPointInTimeView(rows, forecastAsOf(2020));
  assert.ok(v.rows.every((r) => r.season <= 2019)); assert.equal(v.cutoffSeason, 2019);
  assert.ok(!v.rows.some((r) => r.player.id === 'late'), 'a 2019 row published in 2021 must not be visible in 2020');
  assert.equal(createPointInTimeView(rows, forecastAsOf(2022)).rows.some((r) => r.player.id === 'late'), true);
  assert.ok(seasonFinalAt(2019) < forecastAsOf(2020));
  assert.throws(() => { v.rows[0].gamesPlayed = 1; }, TypeError);
  assert.throws(() => { v.rows.push({}); }, TypeError);
});

test('future information cannot influence historical forecasts: replacing target and later seasons with garbage changes nothing', () => {
  const canary = leakageCanary({ snapshots: DATA.snapshots, models: DEFAULT_BASELINES(), statCategories: SCORING, targetSeasons: TARGETS });
  assert.equal(canary.ok, true, JSON.stringify(canary.leaked)); assert.equal(canary.checks, 3 * TARGETS.length);
});

test('the canary has teeth: a deliberately broken point-in-time filter is caught', () => {
  const broken = (snapshots, asOf) => ({ ...createPointInTimeView(snapshots, '2100-01-01T00:00:00.000Z'), asOf });   // returns future rows
  assert.throws(() => predictForTarget({ snapshots: DATA.snapshots, model: productionModel(), targetSeason: 2022, statCategories: SCORING, options: { createView: broken } }), /Leakage/);
  const sneaky = (snapshots, asOf) => { const v = createPointInTimeView(snapshots, '2100-01-01T00:00:00.000Z'); return { ...v, asOf, rows: v.rows }; };
  // asOf is stamped honestly but rows are not filtered: the view assertion above rejects it, and so would any such regression
  assert.throws(() => predictForTarget({ snapshots: DATA.snapshots, model: productionModel(), targetSeason: 2022, statCategories: SCORING, options: { createView: sneaky } }), /Leakage/);
});

test('the data-perturbation canary itself has teeth: a leak that forges availability stamps is still caught', () => {
  const forge = (snapshots, asOf) => createPointInTimeView(snapshots.map((r) => ({ ...r, availableAt: '2000-01-01T00:00:00.000Z' })), asOf);   // every row looks "already published"
  const c = leakageCanary({ snapshots: DATA.snapshots, models: [productionModel()], statCategories: SCORING, targetSeasons: [2022, 2023], options: { createView: forge } });
  assert.equal(c.ok, false); assert.ok(c.leaked.length >= 1, 'perturbing target-season rows must change a model that can see them');
});

test('every baseline is evaluated with games, minutes, fantasy points and totals scored separately, plus rank and top-25/50 accuracy', () => {
  const rep = runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, models: DEFAULT_BASELINES(), targetSeasons: TARGETS, now: () => '2026-10-16T00:00:00.000Z' });
  assert.deepEqual(rep.models.map((m) => m.id), ['production', 'age_minutes', 'naive_games']); assert.equal(rep.reference, 'production');
  const f = rep.folds.production[2022];
  for (const k of ['games', 'minutes', 'fppg', 'seasonTotal']) assert.ok(f[k].n > 50 && f[k].mae > 0, k);
  assert.ok(f.rank.totalSpearman > 0.3); assert.ok(f.topN[25].total.overlap >= 0 && f.topN[50].total.capture > 0.5);
  for (const m of ['production', 'age_minutes']) for (const k of ['gamesMae', 'minutesMae', 'fppgMae', 'totalSpearman', 'top25TotalOverlap', 'top50TotalCapture']) assert.ok(Number.isFinite(rep.summary[m][k]), `${m}.${k}`);
  assert.equal(rep.summary.naive_games.fppgMae, null);               // games-only model is not scored on other targets
  assert.ok(rep.paired.age_minutes.fppgMae.folds === TARGETS.length && Number.isFinite(rep.paired.age_minutes.fppgMae.lo));
  assert.ok(rep.warnings.some((w) => /Synthetic dataset/.test(w)));
  // the age + minutes experiment shares the production games model, so the games target must match exactly
  assert.equal(rep.summary.age_minutes.gamesMae, rep.summary.production.gamesMae);
  // on data with real aging structure, the experiment improves per-game accuracy
  assert.ok(rep.summary.age_minutes.fppgMae < rep.summary.production.fppgMae, `${rep.summary.age_minutes.fppgMae} vs ${rep.summary.production.fppgMae}`);
});

test('evaluation is deterministic', () => {
  const run = () => { const r = runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, models: DEFAULT_BASELINES(), targetSeasons: [2022, 2023], now: () => 'T' }); return JSON.stringify({ s: r.summary, p: r.paired, c: r.records.length }); };
  assert.equal(run(), run());
});

test('prediction records carry model version, forecast time, data cutoff, fingerprint, provenance and uncertainty', () => {
  const rep = runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, models: [productionModel(), ageMinutesModel()], targetSeasons: TARGETS, now: () => '2026-10-16T00:00:00.000Z' });
  assert.ok(rep.records.length > 500);
  for (const r of rep.records) {
    assert.equal(r.schemaVersion, PREDICTION_SCHEMA); assert.ok(r.modelVersion && r.dataFingerprint && r.provenanceHash && r.provenanceName === 'synthetic-chrono-fixture');
    assert.equal(r.asOf, forecastAsOf(r.targetSeason)); assert.ok(r.dataCutoffSeason < r.targetSeason); assert.ok(Date.parse(r.dataLatestAvailableAt) <= Date.parse(r.asOf));
    assert.ok(!('actual' in r) && !('aFppg' in r), 'the log must never contain outcomes');
  }
  const first = rep.records.filter((r) => r.targetSeason === 2020).every((r) => r.intervals.fppg === null);
  assert.equal(first, true, 'no interval before enough earlier-season residuals exist');
  const withIv = rep.records.filter((r) => r.intervals.fppg);
  assert.ok(withIv.length > 100);
  for (const r of withIv) { assert.ok(r.intervals.fppg.lo < r.predicted.fppg && r.intervals.fppg.hi > r.predicted.fppg); assert.ok(r.intervals.fppg.basisSeasons.every((s) => s < r.targetSeason && Date.parse(seasonFinalAt(s)) <= Date.parse(r.asOf))); }
  const cov = rep.summary.production.intervalCoverage.fppg; assert.ok(cov > 0.6 && cov < 0.95, `coverage ${cov}`);
  const lines = toPredictionLog(rep.records).trim().split('\n'); assert.equal(lines.length, rep.records.length); assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test('records that use their own target season or later data are rejected', () => {
  const ok = { schemaVersion: PREDICTION_SCHEMA, modelId: 'm', modelVersion: '1', targetSeason: 2022, playerId: 'p', asOf: 'a', generatedAt: 'g', dataCutoffSeason: 2021, dataFingerprint: 'f', provenanceHash: 'h', predicted: {} };
  assert.doesNotThrow(() => validatePredictionRecord(ok));
  assert.throws(() => validatePredictionRecord({ ...ok, dataCutoffSeason: 2022 }), /own target season/);
  assert.throws(() => validatePredictionRecord({ ...ok, modelVersion: undefined }), /missing modelVersion/);
});

test('only authorized, license-resolved datasets are accepted', () => {
  assert.throws(() => assertAuthorized({ authorized: false }), /authorized/);
  assert.throws(() => assertAuthorized({ authorized: true, licenseStatus: 'unresolved' }), /unresolved/);
  assert.equal(assertAuthorized({ authorized: true, licenseStatus: 'licensed' }), true);
  assert.throws(() => importHistoricalDataset({ rows: [], provenance: { ...PROVENANCE, authorized: false } }), /authorization/);
  assert.throws(() => runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: { ...DATA.provenance, licenseStatus: 'unresolved' }, statCategories: SCORING, models: DEFAULT_BASELINES() }), /unresolved/);
});

test('a league weight with no matching statistic yields no fantasy comparison (never zero)', () => {
  const rep = runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: [...SCORING, { statId: 4, abbr: 'FGM', pointValue: 2, enabled: true }], models: [productionModel()], targetSeasons: [2022] });
  assert.equal(rep.folds.production[2022].fppg.n, 0); assert.equal(rep.summary.production.fppgMae, null); assert.ok(rep.folds.production[2022].games.n > 50);
});

test('metric primitives', () => {
  assert.deepEqual(errorStats([[1, 3], [5, 3], [NaN, 1]]), { n: 2, mae: 2, rmse: 2, bias: 0 });
  assert.equal(spearman([[1, 10], [2, 20], [3, 30]]), 1); assert.equal(spearman([[1, 30], [2, 20], [3, 10]]), -1);
  const rows = Array.from({ length: 10 }, (_, i) => ({ playerId: `p${i}`, a: 10 - i, b: 10 - i, c: i + 1 }));
  assert.deepEqual(topN(rows, 5, 'a', 'b'), { overlap: 1, capture: 1 });
  assert.equal(topN(rows, 5, 'a', 'c').overlap, 0); assert.ok(topN(rows, 5, 'a', 'c').capture < 0.4);
  const p = pairedFolds({ 1: 9, 2: 8, 3: 9.5 }, { 1: 10, 2: 10, 3: 10 }, { lowerIsBetter: true }); assert.equal(p.foldsImproved, 3); assert.ok(p.lo < p.meanDifference && p.meanDifference < p.hi);
});

test('CLI writes a report and an outcome-free prediction log, and refuses unauthorized data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-')); const data = path.join(dir, 'd.json'); const scoring = path.join(dir, 's.json');
  const rows = DATA.snapshots.map((s) => ({ season: s.season, playerId: s.player.id, name: s.player.name, age: s.age, experience: s.experience, gamesPlayed: s.gamesPlayed, minutesPerGame: s.minutesPerGame, stats: s.stats }));
  fs.writeFileSync(data, JSON.stringify({ provenance: PROVENANCE, rows })); fs.writeFileSync(scoring, JSON.stringify(SCORING));
  const script = path.join(here, 'chronoEval.cli.js'); const out = path.join(dir, 'out');
  const ok = spawnSync(process.execPath, [script, '--data', data, '--scoring', scoring, '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'chrono-eval-report.json'), 'utf8')); assert.equal(report.canary.ok, true); assert.ok(!('records' in report));
  assert.ok(fs.readFileSync(path.join(out, 'chrono-eval-predictions.jsonl'), 'utf8').split('\n').length > 100);
  fs.writeFileSync(data, JSON.stringify({ provenance: { ...PROVENANCE, authorized: false }, rows }));
  assert.notEqual(spawnSync(process.execPath, [script, '--data', data, '--scoring', scoring, '--out', out], { encoding: 'utf8' }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- offline (precomputed) ML predictions ----
import { blendModel, hybridModel, precomputedModel } from './evalModels.js';
const mlDoc = (over = {}) => ({
  schema: 'progm.ml-predictions.v1', model: { id: 'ml_test', version: 't1', featureHash: 'x' }, provenanceHash: 'h',
  predictions: DATA.snapshots.filter((r) => r.season === 2021 && (r.minutesTotal ?? 0) >= 800).map((r) => ({
    targetSeason: 2022, playerId: r.player.id, asOf: forecastAsOf(2022), trainedThroughSeason: 2021, dataCutoffSeason: 2021, games: 60, minutes: 30,
    statLine: { points: 20, rebounds: 5, assists: 4, minutes: 30 }, ...over,
  })),
});

test('precomputed ML predictions are scored with the league weights here, and leaky metadata is refused', () => {
  const rep = runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, models: [productionModel(), precomputedModel(mlDoc())], targetSeasons: [2022] });
  const r = rep.records.find((x) => x.modelId === 'ml_test');
  assert.equal(r.predicted.fppg, 20 + 1.2 * 5 + 1.5 * 4); assert.equal(r.predicted.games, 60); assert.equal(r.predicted.total, 60 * r.predicted.fppg);
  for (const bad of [{ trainedThroughSeason: 2022 }, { dataCutoffSeason: 2022 }, { asOf: '2022-12-01T00:00:00.000Z' }]) {
    assert.throws(() => runChronologicalEvaluation({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, models: [precomputedModel(mlDoc(bad))], targetSeasons: [2022] }), /Leakage/);
  }
  assert.throws(() => precomputedModel({ schema: 'other' }), /Unsupported/);
});

test('hybrid swaps only games; blend averages the named components', () => {
  const ml = precomputedModel(mlDoc());
  const ctx = { statCategories: SCORING, targetSeason: 2022, asOf: forecastAsOf(2022) }; const view = createPointInTimeView(DATA.snapshots, ctx.asOf);
  const pid = mlDoc().predictions[0].playerId;
  const prod = productionModel().fit(view, ctx).predict(pid);
  const h = hybridModel({ id: 'h', production: productionModel(), games: precomputedModel(mlDoc()) }).fit(view, ctx).predict(pid);
  assert.equal(h.fppg, prod.fppg); assert.equal(h.games, 60);
  const b = blendModel({ id: 'b', perGame: [productionModel()], games: [productionModel(), ml] }).fit(view, ctx).predict(pid);
  assert.equal(b.fppg, prod.fppg); assert.ok(Math.abs(b.games - (prod.games + 60) / 2) < 1e-9);
});

// ---- tier shrinkage and frozen prospective snapshot ----
import { tierShrinkGamesModel } from './evalModels.js';
import { buildSnapshot } from './prospectiveSnapshot.js';

test('tier shrinkage uses the reference games for the top tier and the given ML weight for the rest; no player-specific inputs', () => {
  const ctx = { statCategories: SCORING, targetSeason: 2022, asOf: forecastAsOf(2022) }; const view = createPointInTimeView(DATA.snapshots, ctx.asOf);
  const m = tierShrinkGamesModel({ id: 't', perGame: productionModel(), reference: productionModel(), ml: precomputedModel(mlDoc()), topN: 10, weights: { top: 0, rest: 0.6 } }).fit(view, ctx);
  const prod = productionModel().fit(view, ctx);
  const ids = mlDoc().predictions.map((p) => p.playerId);
  const ranked = ids.map((id) => [id, prod.predict(id).fppg * prod.predict(id).games]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0][0]; const rest = ranked[ranked.length - 1][0];
  assert.equal(m.predict(top).games, prod.predict(top).games);
  assert.ok(Math.abs(m.predict(rest).games - (0.6 * 60 + 0.4 * prod.predict(rest).games)) < 1e-9);
});

test('prospective snapshot uses only pre-season data and records versions, cutoff and fingerprint for every model', () => {
  const snap = buildSnapshot({ snapshots: DATA.snapshots, provenance: DATA.provenance, statCategories: SCORING, registered: [{ role: 'reference', model: productionModel() }], targetSeason: 2025, commit: 'abc', generatedAt: 'g' });
  const m = snap.models[0];
  assert.equal(m.dataCutoffSeason, 2024); assert.equal(m.asOf, forecastAsOf(2025)); assert.ok(m.dataFingerprint && m.version);
  assert.ok(m.predictions.length > 50 && m.predictions.every((p) => !('aTotal' in p)));
  assert.equal(snap.scoringHash.length, 16);
});
