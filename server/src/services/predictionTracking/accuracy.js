import { regressionMetrics } from '../fantasy/backtest/metrics.js';

/**
 * Offline accuracy calculation. Pure: it never reads provider data and never
 * fetches outcomes; the caller supplies actuals from an authorized source.
 * Outcomes are matched on (playerId, targetKey, scoringConfigId) because
 * fantasy points are only comparable under the same scoring configuration.
 */
function outcomeKey(item) {
  return [item.playerId, item.targetKey, item.scoringConfigId].join('|');
}

function bias(pairs) {
  return pairs.length ? Number((pairs.reduce((sum, [predicted, actual]) => sum + (predicted - actual), 0) / pairs.length).toFixed(4)) : null;
}

export function accuracyMetrics(pairs) {
  const usable = (pairs || []).filter(([predicted, actual]) => Number.isFinite(predicted) && Number.isFinite(actual));
  return { ...regressionMetrics(usable), bias: bias(usable) };
}

/**
 * @param {object[]} predictions  stored prediction records
 * @param {object[]} outcomes     { playerId, targetKey, scoringConfigId, actualFppg } supplied offline
 */
export function computeAccuracy({ predictions, outcomes }) {
  const actuals = new Map();
  for (const outcome of outcomes || []) {
    if (!Number.isFinite(outcome?.actualFppg)) throw new Error(`Outcome for ${outcome?.playerId}/${outcome?.targetKey} has no finite actualFppg.`);
    const key = outcomeKey(outcome);
    if (actuals.has(key) && actuals.get(key) !== outcome.actualFppg) throw new Error(`Conflicting outcomes for ${key}.`);
    actuals.set(key, outcome.actualFppg);
  }

  const excluded = { predictedAfterStart: 0, noOutcome: 0 };
  const matchedOutcomeKeys = new Set();
  const groups = new Map();
  for (const prediction of predictions || []) {
    // Integrity guard: a prediction must pre-date its target. Stores enforce this
    // on insert; imported or tampered records are excluded rather than trusted.
    const lead = prediction.targetStartsAt
      ? Date.parse(prediction.targetStartsAt) - Date.parse(prediction.createdAt)
      : Date.parse(`${prediction.targetDate}T00:00:00Z`) - Date.parse(prediction.createdAt);
    if (!(lead > 0)) { excluded.predictedAfterStart += 1; continue; }
    const key = outcomeKey(prediction);
    if (!actuals.has(key)) { excluded.noOutcome += 1; continue; }
    matchedOutcomeKeys.add(key);
    const group = `${prediction.modelVersion}|${prediction.scoringConfigId}`;
    const entry = groups.get(group) || { modelVersion: prediction.modelVersion, scoringConfigId: prediction.scoringConfigId, pairs: [], byMonth: new Map() };
    const pair = [prediction.predictedFppg, actuals.get(key)];
    entry.pairs.push(pair);
    const month = prediction.targetDate.slice(0, 7);
    entry.byMonth.set(month, [...(entry.byMonth.get(month) || []), pair]);
    groups.set(group, entry);
  }

  return {
    groups: [...groups.values()]
      .sort((a, b) => (`${a.modelVersion}|${a.scoringConfigId}` < `${b.modelVersion}|${b.scoringConfigId}` ? -1 : 1))
      .map((entry) => ({
        modelVersion: entry.modelVersion,
        scoringConfigId: entry.scoringConfigId,
        ...accuracyMetrics(entry.pairs),
        byMonth: [...entry.byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, pairs]) => ({ month, ...accuracyMetrics(pairs) })),
      })),
    excluded,
    unmatchedOutcomes: [...actuals.keys()].filter((key) => !matchedOutcomeKeys.has(key)).length,
    note: 'bias = mean(predicted - actual); positive means over-prediction. Small samples are not evidence of accuracy.',
  };
}
