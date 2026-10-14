import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { accuracyMetrics, computeAccuracy } from './accuracy.js';
import { predictionHash, recordPredictions, scoringConfigId } from './predictions.js';
import { MemoryPredictionStore, PostgresPredictionStore } from './stores.js';

// Synthetic ids and values only; nothing here is evidence of real accuracy.
const SCORING = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
  { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
];
const NOW = '2026-10-14T12:00:00.000Z';
const clock = (iso = NOW) => ({ now: () => iso });

function prediction(overrides = {}) {
  return {
    playerId: 'prog:p1', targetDate: '2026-10-20', targetGameId: 'g1', predictedFppg: 31.5,
    modelVersion: 'progm.projection.v1', scoringConfigId: scoringConfigId(SCORING), ...overrides,
  };
}

test('scoring configuration id is stable, one-way, and ignores display fields and order', () => {
  const id = scoringConfigId(SCORING);
  assert.match(id, /^sc1_[0-9a-f]{32}$/);
  assert.equal(scoringConfigId([...SCORING].reverse().map((c) => ({ ...c, abbr: 'X', displayName: 'League 42' }))), id);
  assert.equal(scoringConfigId([...SCORING, { statId: 99, pointValue: 5, enabled: false }, { statId: 98, pointValue: null }]), id);
  assert.notEqual(scoringConfigId(SCORING.map((c) => (c.statId === 12 ? { ...c, pointValue: 1.5 } : c))), id);
  assert.ok(!id.includes('1.2') && !/league/i.test(id));
  assert.throws(() => scoringConfigId([]), /non-empty/);
  assert.throws(() => scoringConfigId([{ statId: 1, pointValue: 'x' }]), /finite/);
});

test('predictions get a server timestamp and must precede their target', async () => {
  const store = new MemoryPredictionStore();
  assert.deepEqual(await recordPredictions(store, [prediction({ createdAt: '2000-01-01T00:00:00Z' })], clock()), { recorded: 1, unchanged: 0 });
  const [stored] = await store.list();
  assert.equal(stored.createdAt, NOW); // caller-supplied createdAt is ignored
  assert.equal(stored.targetKey, 'g1');
  assert.deepEqual(Object.keys(stored).sort().includes('name'), false);

  for (const [overrides, pattern] of [
    [{ targetDate: '2026-10-14' }, /not recorded before its target date/], // same UTC day, no start time
    [{ targetDate: '2026-10-13' }, /not recorded before its target date/],
    [{ targetDate: '2026-10-14', targetStartsAt: '2026-10-14T11:59:59Z' }, /before its target start/],
    [{ targetDate: '2026-10-14', targetStartsAt: NOW }, /before its target start/],
    [{ targetStartsAt: '2026-10-20T19:00:00' }, /timezone/],
    [{ targetDate: '2026-10-20', targetStartsAt: '2026-12-31T19:00:00Z' }, /inconsistent/],
  ]) {
    await assert.rejects(recordPredictions(new MemoryPredictionStore(), [prediction(overrides)], clock()), pattern);
  }
  // Same-day tip-off later today is allowed when the start time is known.
  await recordPredictions(store, [prediction({ playerId: 'prog:p2', targetDate: '2026-10-14', targetGameId: 'g9', targetStartsAt: '2026-10-14T23:30:00Z' })], clock());
});

test('records reject malformed, identifying, or out-of-range input', async () => {
  for (const [overrides, pattern] of [
    [{ playerId: 'LeBron James' }, /opaque identifier/],
    [{ playerId: '' }, /opaque identifier/],
    [{ predictedFppg: '30' }, /finite number/],
    [{ predictedFppg: NaN }, /finite number/],
    [{ predictedFppg: 500 }, /between/],
    [{ modelVersion: '' }, /modelVersion/],
    [{ scoringConfigId: 'my-league-42' }, /scoringConfigId/],
    [{ targetDate: '10/20/2026' }, /YYYY-MM-DD/],
    [{ targetGameId: 'bad id!' }, /opaque identifier/],
  ]) {
    await assert.rejects(recordPredictions(new MemoryPredictionStore(), [prediction(overrides)], clock()), pattern);
  }
  await assert.rejects(recordPredictions(new MemoryPredictionStore(), [], clock()), /non-empty/);
});

test('duplicates: identical is a no-op, different is rejected, nothing is overwritten', async () => {
  const store = new MemoryPredictionStore();
  await recordPredictions(store, [prediction()], clock());
  const [original] = await store.list();

  assert.deepEqual(await recordPredictions(store, [prediction()], clock('2026-10-15T08:00:00Z')), { recorded: 0, unchanged: 1 });
  assert.equal((await store.list())[0].createdAt, original.createdAt); // timestamp not refreshed

  await assert.rejects(recordPredictions(store, [prediction({ predictedFppg: 40 })], clock('2026-10-15T08:00:00Z')), /cannot be overwritten/);
  assert.equal((await store.list())[0].predictedFppg, 31.5);

  // A different model version or scoring config is a distinct prediction.
  await recordPredictions(store, [prediction({ modelVersion: 'progm.projection.v2', predictedFppg: 40 })], clock());
  await recordPredictions(store, [prediction({ scoringConfigId: scoringConfigId([{ statId: 12, pointValue: 1 }]) })], clock());
  assert.equal((await store.list()).length, 3);

  // In-batch duplicates collapse when identical and conflict otherwise.
  const batchStore = new MemoryPredictionStore();
  assert.deepEqual(await recordPredictions(batchStore, [prediction(), prediction()], clock()), { recorded: 1, unchanged: 0 });
  await assert.rejects(recordPredictions(new MemoryPredictionStore(), [prediction(), prediction({ predictedFppg: 1 })], clock()), /Conflicting duplicate/);
});

test('a failing batch records nothing', async () => {
  const store = new MemoryPredictionStore();
  await recordPredictions(store, [prediction()], clock());
  await assert.rejects(recordPredictions(store, [prediction({ playerId: 'prog:p3' }), prediction({ predictedFppg: 99 })], clock()), /cannot be overwritten/);
  assert.deepEqual((await store.list()).map((row) => row.playerId), ['prog:p1']);
});

test('stored records are immutable in memory', async () => {
  const store = new MemoryPredictionStore();
  await recordPredictions(store, [prediction()], clock());
  const row = [...store.rows.values()][0];
  assert.throws(() => { 'use strict'; row.predictedFppg = 1; }, TypeError);
  assert.equal(predictionHash(row), predictionHash({ ...row, createdAt: 'ignored', key: 'x' }));
});

test('accuracy metrics match hand-computed MAE, RMSE and bias', () => {
  // errors (pred - actual): +2, -4, +6, 0 -> MAE 3, RMSE sqrt((4+16+36+0)/4)=3.7417, bias 1
  assert.deepEqual(accuracyMetrics([[12, 10], [16, 20], [26, 20], [5, 5]]), { count: 4, mae: 3, rmse: 3.7417, bias: 1 });
  assert.deepEqual(accuracyMetrics([[1, 2], [null, 3], [4, NaN]]), { count: 1, mae: 1, rmse: 1, bias: -1 });
  assert.deepEqual(accuracyMetrics([]), { count: 0, mae: null, rmse: null, bias: null });
});

test('computeAccuracy matches by player, target and scoring config, and reports exclusions', async () => {
  const store = new MemoryPredictionStore();
  const other = scoringConfigId([{ statId: 12, pointValue: 1 }]);
  await recordPredictions(store, [
    prediction({ playerId: 'prog:a', targetGameId: 'g1', predictedFppg: 30 }),
    prediction({ playerId: 'prog:b', targetGameId: 'g2', predictedFppg: 20, targetDate: '2026-11-02' }),
    prediction({ playerId: 'prog:c', targetGameId: 'g3', predictedFppg: 25 }),
    prediction({ playerId: 'prog:a', targetGameId: 'g1', predictedFppg: 10, scoringConfigId: other }),
  ], clock());
  const cfg = scoringConfigId(SCORING);
  const result = computeAccuracy({
    predictions: await store.list(),
    outcomes: [
      { playerId: 'prog:a', targetKey: 'g1', scoringConfigId: cfg, actualFppg: 28 },
      { playerId: 'prog:b', targetKey: 'g2', scoringConfigId: cfg, actualFppg: 26 },
      { playerId: 'prog:z', targetKey: 'g9', scoringConfigId: cfg, actualFppg: 5 }, // no prediction
    ],
  });
  const group = result.groups.find((item) => item.scoringConfigId === cfg);
  assert.deepEqual([group.count, group.mae, group.rmse, group.bias], [2, 4, 4.4721, -2]); // errors +2, -6
  assert.deepEqual(group.byMonth.map((m) => [m.month, m.count, m.bias]), [['2026-10', 1, 2], ['2026-11', 1, -6]]);
  assert.equal(result.groups.length, 1); // other scoring config has no outcome
  assert.equal(result.excluded.noOutcome, 2);
  assert.equal(result.unmatchedOutcomes, 1);

  assert.throws(() => computeAccuracy({ predictions: [], outcomes: [{ playerId: 'x', targetKey: 'g', scoringConfigId: cfg, actualFppg: 1 }, { playerId: 'x', targetKey: 'g', scoringConfigId: cfg, actualFppg: 2 }] }), /Conflicting outcomes/);
  assert.throws(() => computeAccuracy({ predictions: [], outcomes: [{ playerId: 'x', targetKey: 'g', scoringConfigId: cfg, actualFppg: null }] }), /finite/);
});

test('computeAccuracy excludes predictions that do not pre-date their target (tampered or imported)', () => {
  const cfg = scoringConfigId(SCORING);
  const base = { schemaVersion: 'progm.prediction.v1', playerId: 'prog:a', targetKey: 'g1', targetGameId: 'g1', modelVersion: 'm', scoringConfigId: cfg, predictedFppg: 10 };
  const outcomes = [{ playerId: 'prog:a', targetKey: 'g1', scoringConfigId: cfg, actualFppg: 12 }];
  const late = { ...base, targetDate: '2026-10-20', targetStartsAt: '2026-10-20T19:00:00.000Z', createdAt: '2026-10-20T19:00:00.000Z' };
  const afterDate = { ...base, targetDate: '2026-10-20', targetStartsAt: null, createdAt: '2026-10-20T01:00:00.000Z' };
  const good = { ...base, targetDate: '2026-10-20', targetStartsAt: null, createdAt: '2026-10-19T01:00:00.000Z' };
  assert.equal(computeAccuracy({ predictions: [late, afterDate], outcomes }).excluded.predictedAfterStart, 2);
  assert.equal(computeAccuracy({ predictions: [late, afterDate, good], outcomes }).groups[0].count, 1);
});

const DATABASE_URL = process.env.SPORTS_DATA_TEST_DATABASE_URL;
describe('PostgresPredictionStore (integration)', { skip: DATABASE_URL ? false : 'SPORTS_DATA_TEST_DATABASE_URL not set' }, () => {
  const schema = `pt_test_${process.pid}_${Date.now()}`;
  let admin; let pool; let store;
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
    store = new PostgresPredictionStore(pool);
    await store.ensureSchema();
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  test('records with a database-assigned timestamp, is idempotent, and matches the memory store', async () => {
    const real = () => new Date().toISOString();
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const batch = [prediction({ targetDate: future }), prediction({ playerId: 'prog:p2', targetDate: future, targetGameId: 'g2' })];
    assert.deepEqual(await recordPredictions(store, batch, { now: real }), { recorded: 2, unchanged: 0 });
    assert.deepEqual(await recordPredictions(store, batch, { now: real }), { recorded: 0, unchanged: 2 });
    const memory = new MemoryPredictionStore();
    await recordPredictions(memory, batch, { now: real });
    const strip = (rows) => rows.map(({ createdAt: _c, ...row }) => row);
    assert.deepEqual(strip(await store.list()), strip(await memory.list()));
    assert.ok(Math.abs(Date.parse((await store.list())[0].createdAt) - Date.now()) < 60000);
    await assert.rejects(recordPredictions(store, [{ ...batch[0], predictedFppg: 1 }], { now: real }), /cannot be overwritten/);
  });

  test('database rejects update, delete, truncate, and late or out-of-range inserts on its own', async () => {
    await assert.rejects(pool.query('UPDATE pt_predictions SET predicted_fppg = 0'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM pt_predictions'), /append-only/);
    await assert.rejects(pool.query('TRUNCATE pt_predictions'), /append-only/);
    const insert = (startsAt, date, fppg = 10) => pool.query(
      `INSERT INTO pt_predictions (prediction_key, sport, player_id, target_key, target_date, target_starts_at, predicted_fppg, model_version, scoring_config_id, content_hash)
       VALUES ($1, 'basketball', 'p', 't', $2, $3, $4, 'm', $5, $6)`,
      [`k${Math.random()}`, date, startsAt, fppg, scoringConfigId(SCORING), 'h'.repeat(64)],
    );
    await assert.rejects(insert('2000-01-01T00:00:00Z', '2000-01-01'), /check constraint/i); // started in the past
    await assert.rejects(insert(null, '2000-01-01'), /check constraint/i); // date already passed
    await assert.rejects(insert(null, '2099-01-01', 5000), /check constraint/i);
  });
});
