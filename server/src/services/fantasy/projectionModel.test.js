import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRecencyHybrid, projectPlayer } from './projection.js';
import { EXISTING_MODEL_VERSION, HYBRID_MODEL_VERSION, resolveProjectionModel } from './projectionModel.js';
import { emptyStatLine } from '../providers/types.js';
import { MemoryPredictionStore } from '../predictionTracking/stores.js';
import { buildPredictionRecords, configurePredictionRecorder, trackProjections, trackingEnabled } from '../predictionTracking/liveRecorder.js';
import { recordNewPredictions, scoringConfigId } from '../predictionTracking/predictions.js';

const SCORING = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
];
const line = (points, rebounds) => ({ ...emptyStatLine(), gamesPlayed: 1, points, rebounds });
const season = { ...line(20, 10), gamesPlayed: 70 };
const recentGames = [
  { gameDate: '2026-01-01', line: line(30, 10) },
  { gameDate: '2026-01-03', line: line(40, 10) },
];
const recent = { ...line(35, 10), gamesPlayed: 2 };
const HYBRID = resolveProjectionModel({ PROGM_PROJECTION_MODEL: 'recency_hybrid_v1' });

test('flag defaults to the existing model; unknown values roll back to it', () => {
  assert.deepEqual(resolveProjectionModel({}), { kind: 'existing', version: EXISTING_MODEL_VERSION });
  assert.equal(resolveProjectionModel({ PROGM_PROJECTION_MODEL: 'recency_hybrid' }).kind, 'existing');
  assert.deepEqual(HYBRID, { kind: 'recency_hybrid', version: HYBRID_MODEL_VERSION, halfLife: 5, rampGames: 10 });
  const tuned = resolveProjectionModel({ PROGM_PROJECTION_MODEL: 'recency_hybrid_v1', PROGM_HYBRID_RAMP_GAMES: '4', PROGM_HYBRID_HALF_LIFE: 'abc' });
  assert.deepEqual([tuned.rampGames, tuned.halfLife], [4, 5]);
  assert.equal(resolveProjectionModel({ PROGM_PROJECTION_MODEL: 'recency_hybrid_v1', PROGM_HYBRID_RAMP_GAMES: '0' }).rampGames, 10);
});

test('existing model output is unchanged by the new recentGames input (rollback path)', () => {
  const existing = projectPlayer({ stats: { season, recent }, statCategories: SCORING, model: resolveProjectionModel({}) });
  const withGames = projectPlayer({ stats: { season, recent, recentGames }, statCategories: SCORING, model: resolveProjectionModel({}) });
  assert.equal(existing.projectedPoints, 0.65 * (20 + 12) + 0.35 * (35 + 12));
  assert.deepEqual({ ...withGames }, { ...existing });
  assert.equal(existing.modelVersion, EXISTING_MODEL_VERSION);
  assert.equal(existing.hybrid, null);
});

test('hybrid blends weighted recent games into the existing line by sample size', () => {
  const model = { ...HYBRID, halfLife: 1, rampGames: 4 };
  const result = projectPlayer({ stats: { season, recent, recentGames }, statCategories: SCORING, model });
  // Existing points line: 0.65*20 + 0.35*35 = 25.25. Weighted recent points (newest 40 w=1, 30 w=0.5) = 36.67. Weight 2/4.
  const points = Number((0.5 * (55 / 1.5) + 0.5 * 25.25).toFixed(2));
  assert.equal(result.expected.points, points);
  assert.equal(result.expected.rebounds, 10);
  assert.equal(result.projectedPoints, points + 12);
  assert.deepEqual(result.hybrid, { recencyWeight: 0.5, windowGames: 2, halfLife: 1, rampGames: 4 });
  assert.equal(result.modelVersion, HYBRID_MODEL_VERSION);
});

test('hybrid falls back safely when data is missing', () => {
  const existing = projectPlayer({ stats: { season, recent }, statCategories: SCORING, model: resolveProjectionModel({}) });
  // No recent games -> identical points to the existing model.
  const noGames = projectPlayer({ stats: { season, recent }, statCategories: SCORING, model: HYBRID });
  assert.equal(noGames.projectedPoints, existing.projectedPoints);
  assert.deepEqual(noGames.hybrid, { recencyWeight: 0, windowGames: 0, halfLife: 5, rampGames: 10 });
  // No last season (rookie path): weighted recent line alone.
  const rookie = projectPlayer({ stats: { season: null, recent, recentGames }, statCategories: SCORING, model: { ...HYBRID, halfLife: 1 } });
  assert.equal(rookie.expected.points, Number((55 / 1.5).toFixed(2)));
  assert.equal(rookie.hybrid.recencyWeight, 1);
  // No data at all.
  assert.equal(projectPlayer({ stats: null, statCategories: SCORING, model: HYBRID }).projectedPoints, null);
  // A scored category with no data anywhere keeps the projection null (league scoring respected).
  const withSteals = [...SCORING, { statId: 17, abbr: 'ST', pointValue: 3, enabled: true }];
  assert.equal(projectPlayer({ stats: { season, recent, recentGames }, statCategories: withSteals, model: HYBRID }).projectedPoints, null);
  // Stats missing in some games use only the games that have them.
  const partial = applyRecencyHybrid(null, { season: null, recentGames: [{ gameDate: '1', line: line(10, null) }, { gameDate: '2', line: line(20, 8) }] }, { halfLife: 1, rampGames: 4 });
  assert.equal(partial.expected.rebounds, 8);
});

test('prediction tracking is off by default and never overwrites stored predictions', async () => {
  assert.equal(trackingEnabled({}), false);
  assert.equal(trackProjections([{ externalId: '1', projection: { perGame: 30, modelVersion: 'm' } }], { statCategories: SCORING }, { PROGM_PREDICTION_TRACKING: 'true' }), null);

  const now = Date.parse('2026-01-10T12:00:00Z');
  const records = buildPredictionRecords([
    { externalId: '203999', projection: { perGame: 41.234567, modelVersion: HYBRID_MODEL_VERSION } },
    { externalId: null, projection: { perGame: 30, modelVersion: HYBRID_MODEL_VERSION } },
    { externalId: '1', projection: { perGame: null, modelVersion: HYBRID_MODEL_VERSION } },
  ], { statCategories: SCORING, now });
  assert.deepEqual(records, [{ playerId: 'nba:203999', targetDate: '2026-01-11', predictedFppg: 41.235, modelVersion: HYBRID_MODEL_VERSION, scoringConfigId: scoringConfigId(SCORING) }]);

  const store = new MemoryPredictionStore();
  const clock = { now: () => '2026-01-10T12:00:00.000Z' };
  assert.deepEqual(await recordNewPredictions(store, records, clock), { recorded: 1, skippedExisting: 0 });
  assert.deepEqual(await recordNewPredictions(store, [{ ...records[0], predictedFppg: 50 }], clock), { recorded: 0, skippedExisting: 1 });
  assert.equal((await store.list())[0].predictedFppg, 41.235);

  configurePredictionRecorder(store);
  try {
    const env = { PROGM_PREDICTION_TRACKING: 'true' };
    const pending = trackProjections([{ externalId: '77', projection: { perGame: 20, modelVersion: EXISTING_MODEL_VERSION } }], { statCategories: SCORING }, env);
    assert.ok(pending);
    await pending;
    assert.ok((await store.list()).some((row) => row.playerId === 'nba:77' && row.modelVersion === EXISTING_MODEL_VERSION));
  } finally {
    configurePredictionRecorder(null);
  }
});
