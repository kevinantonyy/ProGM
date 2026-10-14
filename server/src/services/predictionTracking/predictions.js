import { createHash } from 'node:crypto';

/**
 * Append-only record of ProGM's OWN fantasy-point predictions, kept so accuracy
 * can be measured later. A record holds only ProGM-generated values and opaque
 * identifiers: no provider payloads, names, stat lines, or league data. It is
 * not wired into any production recommendation path.
 */
export const PREDICTION_SCHEMA_VERSION = 'progm.prediction.v1';
export const SCORING_ID_PREFIX = 'sc1_';
export const MAX_BATCH = 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._+-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Non-reversible identifier for a league scoring configuration. Only the fields
 * that affect points (statId, pointValue) of enabled categories are hashed, in
 * canonical order, so the id is stable across key order and display fields, and
 * does not reveal league names, ids, or settings. SHA-256 is one-way, but a
 * configuration drawn from a tiny space (for example a default scoring set)
 * can be recognized by someone who hashes the same set.
 */
export function scoringConfigId(statCategories) {
  if (!Array.isArray(statCategories) || !statCategories.length) throw new Error('scoringConfigId requires a non-empty statCategories array.');
  const weighted = statCategories
    .filter((category) => category && category.enabled !== false && category.pointValue != null)
    .map((category) => {
      const pointValue = Number(category.pointValue);
      if (!Number.isFinite(pointValue) || category.statId == null) throw new Error('Scoring categories need statId and a finite pointValue.');
      return [String(category.statId), pointValue];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!weighted.length) throw new Error('scoringConfigId requires at least one weighted category.');
  return SCORING_ID_PREFIX + createHash('sha256').update(canonicalJson(weighted)).digest('hex').slice(0, 32);
}

function requiredId(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!ID_PATTERN.test(text)) throw new Error(`${label} must be an opaque identifier (letters, digits, : . _ -).`);
  return text;
}

function utcDay(iso) {
  return iso.slice(0, 10);
}

/**
 * Validate one prediction against the SERVER clock. The caller never supplies
 * createdAt. A prediction must exist strictly before its target: with a
 * targetStartsAt it must be in the future; with only a date, that date must be
 * after today (UTC), because tip-off time is unknown.
 */
export function normalizePrediction(raw, nowIso) {
  const playerId = requiredId(raw?.playerId, 'playerId');
  const modelVersion = typeof raw?.modelVersion === 'string' && MODEL_PATTERN.test(raw.modelVersion.trim()) ? raw.modelVersion.trim() : null;
  if (!modelVersion) throw new Error('modelVersion is required (e.g. "progm.projection.v1").');
  const configId = typeof raw?.scoringConfigId === 'string' ? raw.scoringConfigId : '';
  if (!new RegExp(`^${SCORING_ID_PREFIX}[0-9a-f]{32}$`).test(configId)) throw new Error('scoringConfigId must come from scoringConfigId().');
  const targetDate = typeof raw?.targetDate === 'string' && DAY.test(raw.targetDate) && !Number.isNaN(Date.parse(raw.targetDate)) ? raw.targetDate : null;
  if (!targetDate) throw new Error('targetDate must be a YYYY-MM-DD date.');
  const targetGameId = raw.targetGameId == null || raw.targetGameId === '' ? null : requiredId(raw.targetGameId, 'targetGameId');
  const predictedFppg = typeof raw?.predictedFppg === 'number' ? raw.predictedFppg : NaN;
  if (!Number.isFinite(predictedFppg) || predictedFppg < -100 || predictedFppg > 200) throw new Error('predictedFppg must be a finite number between -100 and 200.');

  let targetStartsAt = null;
  if (raw.targetStartsAt != null) {
    const parsed = Date.parse(raw.targetStartsAt);
    if (Number.isNaN(parsed) || typeof raw.targetStartsAt !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(raw.targetStartsAt)) throw new Error('targetStartsAt must be an ISO timestamp with a timezone.');
    targetStartsAt = new Date(parsed).toISOString();
    if (utcDay(targetStartsAt) !== targetDate && Math.abs(Date.parse(targetStartsAt) - Date.parse(`${targetDate}T12:00:00Z`)) > 36 * 3600 * 1000) {
      throw new Error('targetStartsAt is inconsistent with targetDate.');
    }
    if (Date.parse(targetStartsAt) <= Date.parse(nowIso)) throw new Error(`Prediction for ${playerId} was not recorded before its target start.`);
  } else if (targetDate <= utcDay(nowIso)) {
    throw new Error(`Prediction for ${playerId} was not recorded before its target date (targetDate must be after ${utcDay(nowIso)} UTC, or supply targetStartsAt).`);
  }

  const targetKey = targetGameId || targetDate;
  return {
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    sport: 'basketball',
    playerId,
    targetKey,
    targetGameId,
    targetDate,
    targetStartsAt,
    predictedFppg,
    modelVersion,
    scoringConfigId: configId,
    createdAt: nowIso,
  };
}

/** Uniqueness: one prediction per player, target, model version and scoring configuration. */
export function predictionKey(prediction) {
  return [prediction.playerId, prediction.targetKey, prediction.modelVersion, prediction.scoringConfigId].join('|');
}

const HASH_FIELDS = ['schemaVersion', 'sport', 'playerId', 'targetKey', 'targetGameId', 'targetDate', 'targetStartsAt', 'predictedFppg', 'modelVersion', 'scoringConfigId'];

/** Hash of the prediction's content, excluding createdAt and any storage-only fields. */
export function predictionHash(prediction) {
  return createHash('sha256').update(canonicalJson(Object.fromEntries(HASH_FIELDS.map((field) => [field, prediction[field] ?? null])))).digest('hex');
}

/**
 * Record predictions atomically (all or nothing). Stored predictions are never
 * overwritten: re-submitting an identical prediction is a no-op, and any
 * different value for an existing key is rejected rather than replaced.
 */
export async function recordPredictions(store, batch, { now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(batch) || !batch.length) throw new Error('recordPredictions requires a non-empty array.');
  if (batch.length > MAX_BATCH) throw new Error(`recordPredictions accepts at most ${MAX_BATCH} predictions per call.`);
  await store.ensureSchema();
  const nowIso = now();
  if (Number.isNaN(Date.parse(nowIso))) throw new Error('Invalid server clock value.');
  const normalized = new Map();
  for (const raw of batch) {
    const prediction = normalizePrediction(raw, nowIso);
    const key = predictionKey(prediction);
    const seen = normalized.get(key);
    if (seen) {
      if (predictionHash(seen) !== predictionHash(prediction)) throw new Error(`Conflicting duplicate prediction in batch: ${key}.`);
      continue;
    }
    normalized.set(key, prediction);
  }
  return store.transaction(async (tx) => {
    const existing = await tx.getByKeys([...normalized.keys()]);
    const counts = { recorded: 0, unchanged: 0 };
    const fresh = [];
    for (const [key, prediction] of normalized) {
      const stored = existing.get(key);
      if (!stored) { fresh.push(prediction); continue; }
      if (predictionHash(stored) !== predictionHash(prediction)) {
        throw new Error(`Prediction already recorded and cannot be overwritten: ${key}.`);
      }
      counts.unchanged += 1;
    }
    await tx.insertPredictions(fresh.map((prediction) => ({ ...prediction, key: predictionKey(prediction), hash: predictionHash(prediction) })));
    counts.recorded = fresh.length;
    return counts;
  });
}
