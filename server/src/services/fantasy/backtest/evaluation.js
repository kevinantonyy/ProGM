import { createHash } from 'node:crypto';
import { regressionMetrics, spearmanCorrelation } from './metrics.js';
import { runWalkForwardBacktest } from './runner.js';
import { validateHistoricalSnapshots } from './snapshot.js';
import { assertSnapshotsTrainable } from './sourcePolicy.js';

export const EVALUATION_VERSION = 'progm.chronological-evaluation.v1';

/**
 * Split seasons chronologically: every train season precedes every validation
 * season, which precedes every test season. Seasons are never shuffled.
 */
export function chronologicalSplit(seasons, { validationSeasons = 1, testSeasons = 1, minTrainSeasons = 2 } = {}) {
  const ordered = [...new Set((seasons || []).map(Number))].sort((a, b) => a - b);
  if (ordered.some((season) => !Number.isInteger(season))) throw new Error('Chronological split requires integer seasons.');
  for (const [name, value, minimum] of [['validationSeasons', validationSeasons, 1], ['testSeasons', testSeasons, 1], ['minTrainSeasons', minTrainSeasons, 1]]) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  const needed = minTrainSeasons + validationSeasons + testSeasons;
  if (ordered.length < needed) {
    throw new Error(`Chronological split needs at least ${needed} seasons (${minTrainSeasons} train, ${validationSeasons} validation, ${testSeasons} test); found ${ordered.length}.`);
  }
  const testStart = ordered.length - testSeasons;
  const validationStart = testStart - validationSeasons;
  return {
    train: ordered.slice(0, validationStart),
    validation: ordered.slice(validationStart, testStart),
    test: ordered.slice(testStart),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Order-independent SHA-256 of the evaluated snapshots, for reproducibility checks. */
export function datasetFingerprint(snapshots) {
  const rows = (snapshots || []).map(canonicalJson).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

function finitePairs(pairs) {
  return pairs.filter(([predicted, actual]) => Number.isFinite(predicted) && Number.isFinite(actual));
}

function errorSummary(pairs) {
  const usable = finitePairs(pairs);
  const bias = usable.length ? usable.reduce((sum, [predicted, actual]) => sum + (predicted - actual), 0) / usable.length : null;
  return { ...regressionMetrics(usable), bias: bias == null ? null : Number(bias.toFixed(4)) };
}

function recordKey(record) {
  return `${record.targetSeason}|${record.playerId}`;
}

function comparable(record) {
  return Number.isFinite(record.predictedFppg) && Number.isFinite(record.actualFppg);
}

function summarizeRecords(records, seasons) {
  const summary = (rows) => ({
    sampleCount: rows.length,
    fantasyPerGame: errorSummary(rows.map((row) => [row.predictedFppg, row.actualFppg])),
    fantasySeasonTotal: errorSummary(rows.map((row) => [row.predictedFantasyTotal, row.actualFantasyTotal])),
    minutesPerGame: errorSummary(rows.map((row) => [row.predictedStatLine.minutes, row.actualStatLine.minutes])),
    fantasyPerGameRankCorrelation: spearmanCorrelation(rows.map((row) => [row.predictedFppg, row.actualFppg])),
  });
  return {
    ...summary(records),
    bySeason: seasons.map((season) => ({ season, ...summary(records.filter((row) => row.targetSeason === season)) })),
  };
}

function evaluatePhase({ snapshots, statCategories, models, seasons }) {
  const reports = {};
  for (const [key, predictor] of Object.entries(models)) {
    reports[key] = runWalkForwardBacktest({ snapshots, statCategories, predictor, targetSeasons: seasons, includeRecords: true });
  }
  // Compare models only on player-seasons every model could score, so that a
  // model cannot look better by abstaining on hard cases.
  const keySets = Object.values(reports).map((report) => new Set(report.records.filter(comparable).map(recordKey)));
  const common = keySets.length ? [...keySets[0]].filter((key) => keySets.every((set) => set.has(key))) : [];
  const commonKeys = new Set(common);
  const targets = snapshots.filter((row) => seasons.includes(row.season)).length;
  const phase = { seasons, targets, commonSampleCount: commonKeys.size, models: {} };
  for (const [key, report] of Object.entries(reports)) {
    phase.models[key] = {
      model: report.model,
      coverage: report.coverage,
      common: summarizeRecords(report.records.filter((row) => commonKeys.has(recordKey(row))), seasons),
    };
  }
  return phase;
}

function relativeChange(candidate, baseline) {
  return candidate == null || baseline == null || baseline === 0 ? null : Number(((candidate - baseline) / baseline).toFixed(4));
}

/**
 * Reproducible offline evaluation with a chronological train/validation/test
 * split. Each target season is predicted by a fold fit only on earlier seasons
 * (rolling origin). The model is selected on validation seasons BEFORE test
 * seasons are evaluated, and test results never feed back into selection.
 */
export function runChronologicalEvaluation({
  snapshots,
  statCategories,
  models,
  baselineKey = 'baseline',
  validationSeasons = 1,
  testSeasons = 1,
  minTrainSeasons = 2,
}) {
  const validation = validateHistoricalSnapshots(snapshots);
  if (!validation.valid) throw new Error(`Invalid historical snapshots: ${validation.errors.join(' ')}`);
  assertSnapshotsTrainable(snapshots);
  if (!models || !Object.hasOwn(models, baselineKey)) throw new Error(`Evaluation requires a "${baselineKey}" model for comparison.`);

  const split = chronologicalSplit(snapshots.map((row) => row.season), { validationSeasons, testSeasons, minTrainSeasons });
  const validationPhase = evaluatePhase({ snapshots, statCategories, models, seasons: split.validation });

  const scores = Object.entries(validationPhase.models).map(([key, result]) => ({ key, mae: result.common.fantasyPerGame.mae }));
  const ranked = scores.filter((row) => row.mae != null).sort((a, b) => a.mae - b.mae);
  const selection = {
    metric: 'validation.common.fantasyPerGame.mae',
    selectedModel: ranked[0]?.key ?? null,
    validationScores: Object.fromEntries(scores.map((row) => [row.key, row.mae])),
  };

  const testPhase = evaluatePhase({ snapshots, statCategories, models, seasons: split.test });
  const testOf = (key) => testPhase.models[key]?.common;
  const selected = selection.selectedModel ? testOf(selection.selectedModel) : null;
  const baseline = testOf(baselineKey);
  const testComparison = {
    selectedModel: selection.selectedModel,
    baselineModel: baselineKey,
    sampleCount: testPhase.commonSampleCount,
    fantasyPerGameMae: {
      selected: selected?.fantasyPerGame.mae ?? null,
      baseline: baseline.fantasyPerGame.mae,
      relativeChange: relativeChange(selected?.fantasyPerGame.mae, baseline.fantasyPerGame.mae),
    },
    seasonsImproved: selected
      ? selected.bySeason.filter((row, index) => row.fantasyPerGame.mae != null && baseline.bySeason[index].fantasyPerGame.mae != null
        && row.fantasyPerGame.mae < baseline.bySeason[index].fantasyPerGame.mae).length
      : 0,
    seasonsCompared: baseline.bySeason.filter((row) => row.fantasyPerGame.mae != null).length,
  };

  const provenance = snapshots[0]?.provenance || {};
  const synthetic = snapshots.some((row) => row.provenance?.synthetic === true);
  return {
    evaluationVersion: EVALUATION_VERSION,
    dataFingerprint: datasetFingerprint(snapshots),
    source: { name: provenance.name ?? null, datasetVersion: provenance.datasetVersion ?? null, synthetic },
    split,
    sampleSizes: {
      snapshots: snapshots.length,
      players: new Set(snapshots.map((row) => row.player.id)).size,
      validationCommon: validationPhase.commonSampleCount,
      testCommon: testPhase.commonSampleCount,
    },
    selection,
    validation: validationPhase,
    test: testPhase,
    testComparison,
    accuracyStatus: synthetic ? 'synthetic_only_unvalidated' : 'historical_evaluation_not_production_approved',
  };
}
