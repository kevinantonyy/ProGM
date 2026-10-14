import { recordNewPredictions, scoringConfigId } from './predictions.js';

/**
 * Optional live recording of ProGM's own projections (Phase 10 store).
 * Disabled unless PROGM_PREDICTION_TRACKING=true AND a store was configured at
 * startup. Recording is fire-and-forget: it never blocks or fails a request.
 * Each record is the per-game projection for the next UTC day. A player who
 * does not play that day simply gets no outcome when accuracy is computed.
 * Only ProGM's own projected FPPG and an opaque `nba:<personId>` id are stored.
 */
let store = null;
const recordedKeys = new Set();

export function configurePredictionRecorder(predictionStore) {
  store = predictionStore;
}

export function trackingEnabled(env = process.env) {
  return env.PROGM_PREDICTION_TRACKING === 'true' && store != null;
}

function nextUtcDay(now) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Build prediction records; skips players without an external id or a finite projection. */
export function buildPredictionRecords(entries, { statCategories, now = Date.now() }) {
  let configId;
  try { configId = scoringConfigId(statCategories); } catch { return []; }
  const targetDate = nextUtcDay(now);
  return entries
    .filter(({ externalId, projection }) => externalId && Number.isFinite(projection?.perGame) && projection.perGame >= -100 && projection.perGame <= 200)
    .map(({ externalId, projection }) => ({
      playerId: `nba:${externalId}`,
      targetDate,
      predictedFppg: Number(projection.perGame.toFixed(3)),
      modelVersion: projection.modelVersion,
      scoringConfigId: configId,
    }));
}

export function trackProjections(entries, options, env = process.env) {
  if (!trackingEnabled(env)) return null;
  const records = buildPredictionRecords(entries, options).filter((record) => {
    const key = `${record.playerId}|${record.targetDate}|${record.modelVersion}|${record.scoringConfigId}`;
    if (recordedKeys.has(key)) return false;
    recordedKeys.add(key);
    return true;
  });
  if (recordedKeys.size > 200000) recordedKeys.clear();
  if (!records.length) return null;
  return recordNewPredictions(store, records).catch((error) => {
    console.warn(`[prediction-tracking] skipped batch: ${error.message}`);
    return null;
  });
}
