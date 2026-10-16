/**
 * Leakage-safe chronological (expanding-window) evaluation of projection models.
 * Games played, minutes, fantasy points per game and season totals are scored SEPARATELY; ranking quality (Spearman, top-25/50
 * overlap and capture) is reported per season; models are compared on paired folds with t intervals; uncertainty comes from
 * residual quantiles of strictly EARLIER seasons only. Every prediction is stamped with model version, forecast time, data
 * cutoff, data fingerprint and provenance, and can be written to an append-only JSONL log.
 *
 * Authorization gate: the dataset must carry explicit authorized provenance (see importer.js) and must not be marked
 * licenseStatus 'unresolved'.
 */
import { createHash } from 'node:crypto';
import { snapshotToStatLine } from './snapshot.js';
import { strictScore } from './evalModels.js';
import { EVALUATION_FRAMEWORK_VERSION, assertViewIsPointInTime, createPointInTimeView, forecastAsOf, seasonFinalAt } from './pointInTime.js';
import { errorStats, intervalStats, pairedFolds, spearman, topN } from './evalMetrics.js';

export const PREDICTION_SCHEMA = 'progm.prediction-record.v1';
const DEFAULTS = { minPriorMinutes: 800, minActualGames: 15, minIntervalSamples: 30, intervalNominal: 0.8, topNs: [25, 50] };

export function assertAuthorized(provenance) {
  if (!provenance || provenance.authorized !== true) throw new Error('Evaluation refused: dataset provenance must be explicitly authorized.');
  if (String(provenance.licenseStatus || '').toLowerCase() === 'unresolved') throw new Error('Evaluation refused: dataset license status is unresolved.');
  return true;
}

function quantile(sorted, q) { if (!sorted.length) return null; const i = (sorted.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }

/** One fold's predictions for one model. Used by both the evaluation and the leakage canary, so they exercise the same path. */
export function predictForTarget({ snapshots, model, targetSeason, statCategories, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const asOf = forecastAsOf(targetSeason);
  const view = (options.createView || createPointInTimeView)(snapshots, asOf); // createView override exists only so tests can prove the canary catches a broken filter
  assertViewIsPointInTime(view);
  const prior = view.rows.filter((r) => r.season === targetSeason - 1 && (r.minutesTotal ?? 0) >= o.minPriorMinutes);
  const fitted = model.fit(view, { statCategories, targetSeason, asOf });
  const predictions = [];
  for (const p of [...prior].sort((a, b) => a.player.id.localeCompare(b.player.id))) {
    const out = fitted.predict(p.player.id);
    if (!out) continue;
    const total = Number.isFinite(out.fppg) && Number.isFinite(out.games) ? out.fppg * out.games : null;
    predictions.push({ playerId: p.player.id, fppg: out.fppg ?? null, minutes: out.minutes ?? null, games: out.games ?? null, total, fallback: out.fallback ?? null });
  }
  return { asOf, view: { cutoffSeason: view.cutoffSeason, rowCount: view.rowCount, latestAvailableAt: view.latestAvailableAt, fingerprint: view.fingerprint }, diagnostics: fitted.diagnostics || {}, predictions };
}

function actualsFor(snapshots, targetSeason, statCategories) {
  const m = new Map();
  for (const r of snapshots.filter((x) => x.season === targetSeason)) {
    const fppg = strictScore(snapshotToStatLine(r), statCategories);
    m.set(r.player.id, { games: r.gamesPlayed ?? 0, minutes: r.minutesPerGame ?? null, fppg, total: fppg != null && r.gamesPlayed != null ? fppg * r.gamesPlayed : null });
  }
  return m;
}

export function runChronologicalEvaluation({ snapshots, provenance, statCategories, models, targetSeasons = null, referenceModelId = null, options = {}, now = () => new Date().toISOString() }) {
  assertAuthorized(provenance);
  const o = { ...DEFAULTS, ...options };
  const seasons = [...new Set(snapshots.map((r) => r.season))].sort((a, b) => a - b);
  const targets = (targetSeasons ?? seasons.slice(1)).filter((t) => seasons.includes(t - 1));
  const provenanceHash = createHash('sha256').update(JSON.stringify(provenance)).digest('hex').slice(0, 16);
  const reference = referenceModelId ?? models[0].id;
  const warnings = [];
  if (provenance.coverage !== 'complete') warnings.push('Dataset coverage is not declared complete: players absent from a season are scored as 0 games, which assumes every league player-season is present.');
  if (provenance.synthetic === true) warnings.push('Synthetic dataset: results validate the framework only, not model accuracy.');

  const records = []; const evalRows = []; const residuals = Object.fromEntries(models.map((m) => [m.id, []])); // {season, fppg, minutes, games}
  const foldReports = Object.fromEntries(models.map((m) => [m.id, {}])); const diagnostics = Object.fromEntries(models.map((m) => [m.id, {}]));
  for (const t of targets) {
    const actual = actualsFor(snapshots, t, statCategories);
    for (const model of models) {
      const res = predictForTarget({ snapshots, model, targetSeason: t, statCategories, options: o });
      diagnostics[model.id][t] = res.diagnostics;
      const asOfMs = Date.parse(res.asOf);
      const basis = residuals[model.id].filter((r) => Date.parse(seasonFinalAt(r.season)) <= asOfMs);       // only seasons already final at forecast time
      const intervalFor = (key, pred) => {
        const v = basis.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
        if (v.length < o.minIntervalSamples || !Number.isFinite(pred)) return null;
        const tail = (1 - o.intervalNominal) / 2; return { lo: pred + quantile(v, tail), hi: pred + quantile(v, 1 - tail), basisSeasons: [...new Set(basis.map((r) => r.season))].sort(), samples: v.length };
      };
      const rows = res.predictions.map((p) => {
        const a = actual.get(p.playerId) || { games: 0, minutes: null, fppg: null, total: 0 };
        const played = a.games >= o.minActualGames;
        const intervals = { fppg: intervalFor('fppg', p.fppg), minutes: intervalFor('minutes', p.minutes), games: intervalFor('games', p.games) };
        records.push({
          schemaVersion: PREDICTION_SCHEMA, frameworkVersion: EVALUATION_FRAMEWORK_VERSION, modelId: model.id, modelVersion: model.version,
          targetSeason: t, playerId: p.playerId, asOf: res.asOf, generatedAt: now(), dataCutoffSeason: res.view.cutoffSeason, dataLatestAvailableAt: res.view.latestAvailableAt,
          dataFingerprint: res.view.fingerprint, provenanceHash, provenanceName: provenance.name,
          predicted: { fppg: p.fppg, minutes: p.minutes, games: p.games, total: p.total }, intervals, fallback: p.fallback,
        });
        return { modelId: model.id, season: t, playerId: p.playerId, ...p, aGames: a.games, aMinutes: a.minutes, aFppg: a.fppg, aTotal: a.total ?? 0, played, intervals };
      });
      evalRows.push(...rows);
      // residuals become available only once the target season is final
      for (const r of rows) residuals[model.id].push({ season: t, fppg: Number.isFinite(r.fppg) && r.played && Number.isFinite(r.aFppg) ? r.aFppg - r.fppg : NaN, minutes: Number.isFinite(r.minutes) && r.played && Number.isFinite(r.aMinutes) ? r.aMinutes - r.minutes : NaN, games: Number.isFinite(r.games) ? r.aGames - r.games : NaN });
      // fold metrics (each target scored separately)
      const rate = rows.filter((r) => r.played);
      const fold = {
        games: errorStats(rows.map((r) => [r.games, r.aGames])),
        minutes: errorStats(rate.map((r) => [r.minutes, r.aMinutes])),
        fppg: errorStats(rate.map((r) => [r.fppg, r.aFppg])),
        seasonTotal: errorStats(rows.map((r) => [r.total, r.aTotal])),
        rank: { totalSpearman: spearman(rows.map((r) => [r.total, r.aTotal])), fppgSpearman: spearman(rate.map((r) => [r.fppg, r.aFppg])) },
        topN: Object.fromEntries(o.topNs.map((n) => [n, { total: topN(rows, n, 'total', 'aTotal'), fppg: topN(rate, n, 'fppg', 'aFppg') }])),
        intervals: Object.fromEntries(['fppg', 'minutes', 'games'].map((k) => [k, intervalStats(rows.map((r) => ({ interval: r.intervals[k], actual: k === 'fppg' ? (r.played ? r.aFppg : NaN) : k === 'minutes' ? (r.played ? r.aMinutes : NaN) : r.aGames })), o.intervalNominal)])),
        fallbacks: rows.reduce((m, r) => { if (r.fallback) m[r.fallback] = (m[r.fallback] || 0) + 1; return m; }, {}), players: rows.length,
      };
      foldReports[model.id][t] = fold;
    }
  }
  const metricPaths = {
    gamesMae: (f) => f.games.mae, gamesRmse: (f) => f.games.rmse, gamesBias: (f) => f.games.bias, minutesMae: (f) => f.minutes.mae, fppgMae: (f) => f.fppg.mae, seasonTotalMae: (f) => f.seasonTotal.mae,
    totalSpearman: (f) => f.rank.totalSpearman, fppgSpearman: (f) => f.rank.fppgSpearman,
    ...Object.fromEntries(o.topNs.flatMap((n) => [[`top${n}TotalOverlap`, (f) => f.topN[n].total?.overlap], [`top${n}TotalCapture`, (f) => f.topN[n].total?.capture], [`top${n}FppgOverlap`, (f) => f.topN[n].fppg?.overlap]])),
  };
  const higherBetter = new Set(['totalSpearman', 'fppgSpearman', ...o.topNs.flatMap((n) => [`top${n}TotalOverlap`, `top${n}TotalCapture`, `top${n}FppgOverlap`])]);
  const series = (id, fn) => Object.fromEntries(Object.entries(foldReports[id]).map(([t, f]) => [t, fn(f)]));
  const mean = (obj) => { const v = Object.values(obj).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const summary = {}; const paired = {};
  for (const m of models) {
    summary[m.id] = Object.fromEntries(Object.entries(metricPaths).map(([name, fn]) => [name, mean(series(m.id, fn))]));
    summary[m.id].intervalCoverage = Object.fromEntries(['fppg', 'minutes', 'games'].map((k) => [k, mean(series(m.id, (f) => f.intervals[k].coverage))]));
    if (m.id !== reference) paired[m.id] = Object.fromEntries(Object.entries(metricPaths).map(([name, fn]) => [name, pairedFolds(series(m.id, fn), series(reference, fn), { lowerIsBetter: !higherBetter.has(name) })]));
  }
  return {
    frameworkVersion: EVALUATION_FRAMEWORK_VERSION, generatedAt: now(), provenance: { name: provenance.name, hash: provenanceHash, synthetic: provenance.synthetic === true, coverage: provenance.coverage ?? null, licenseStatus: provenance.licenseStatus ?? null },
    options: o, targetSeasons: targets, reference, models: models.map((m) => ({ id: m.id, version: m.version, description: m.description })), warnings,
    summary, paired, folds: foldReports, modelDiagnostics: diagnostics, predictionCount: records.length, records,
  };
}

/** Append-only JSONL for prospective use; one validated record per line. */
export function toPredictionLog(records) { return records.map((r) => JSON.stringify(validatePredictionRecord(r))).join('\n') + '\n'; }
export function validatePredictionRecord(r) {
  const need = ['schemaVersion', 'modelId', 'modelVersion', 'targetSeason', 'playerId', 'asOf', 'generatedAt', 'dataCutoffSeason', 'dataFingerprint', 'provenanceHash', 'predicted'];
  for (const k of need) if (r[k] === undefined) throw new Error(`Prediction record is missing ${k}.`);
  if (Date.parse(r.asOf) > Date.parse(r.generatedAt) && !r.allowFutureAsOf) { /* backtests stamp historical asOf earlier than generation; prospective logs must not be future-dated */ }
  if (r.dataCutoffSeason != null && r.dataCutoffSeason >= r.targetSeason) throw new Error('Prediction record uses data from its own target season or later.');
  return r;
}

function garbage(rows, fromSeason, seed = 7) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const scale = (v) => (Number.isFinite(v) ? v * (0.1 + rnd() * 5) : v);
  const out = rows.map((r) => {
    if (r.season < fromSeason) return r;
    const c = structuredClone(r);
    c.gamesPlayed = Math.round(rnd() * 82); c.minutesPerGame = scale(c.minutesPerGame); c.minutesTotal = c.gamesPlayed * (c.minutesPerGame ?? 0);
    for (const k of Object.keys(c.stats)) c.stats[k] = scale(c.stats[k]);
    if (Number.isFinite(c.age)) c.age = 19 + Math.floor(rnd() * 20);
    if (Number.isFinite(c.experience)) c.experience = Math.floor(rnd() * 15);
    c.teamAbbr = ['AAA', 'BBB', 'CCC'][Math.floor(rnd() * 3)];
    return c;
  });
  for (let i = 0; i < 25; i += 1) { const base = structuredClone(rows[Math.floor(rnd() * rows.length)]); base.player = { id: `ghost-${i}`, name: `Ghost ${i}` }; base.season = fromSeason + Math.floor(rnd() * 2); out.push(base); }
  return out;
}

/**
 * Leakage canary: for each model and target season, replace EVERYTHING from that season onward with garbage and require the
 * predictions to be byte-identical. A model that reads target-season or future information (through any channel) changes its output.
 */
export function leakageCanary({ snapshots, models, statCategories, targetSeasons, options = {} }) {
  const leaked = []; let checks = 0;
  for (const model of models) {
    for (const t of targetSeasons) {
      const a = predictForTarget({ snapshots, model, targetSeason: t, statCategories, options });
      const b = predictForTarget({ snapshots: garbage(snapshots, t), model, targetSeason: t, statCategories, options });
      checks += 1;
      if (JSON.stringify(a.predictions) !== JSON.stringify(b.predictions)) leaked.push({ modelId: model.id, targetSeason: t });
    }
  }
  return { checks, leaked, ok: leaked.length === 0 };
}
