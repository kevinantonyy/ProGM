import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { exportHistoricalSnapshots, ingestBatch, registerSource } from './ingest.js';
import { MemorySportsDataStore } from './memoryStore.js';
import { PostgresSportsDataStore, SCHEMA_STATEMENTS } from './postgresStore.js';
import { syntheticBatch, syntheticSource } from './syntheticFixture.js';

test('transactions roll back and release the client on failure; values are always parameterized', async () => {
  const log = [];
  let released = 0;
  const client = {
    query: async (sql, params = []) => {
      log.push({ sql, params });
      if (/INSERT INTO sd_teams/.test(sql)) throw new Error('boom');
      return { rows: [] };
    },
    release: () => { released += 1; },
  };
  const store = new PostgresSportsDataStore({ connect: async () => client, query: client.query });
  await assert.rejects(store.transaction((tx) => tx.upsertRecords('teams', 'basketball', 'src', [{ externalId: "x'; DROP TABLE sd_teams; --", name: 'n', contentHash: 'h' }])), /boom/);
  assert.deepEqual(log.map((entry) => entry.sql.split(/\s/)[0]), ['BEGIN', 'INSERT', 'ROLLBACK']);
  assert.equal(released, 1);
  assert.ok(!log[1].sql.includes('DROP TABLE'));
  assert.ok(log[1].params.includes("x'; DROP TABLE sd_teams; --"));
  assert.ok(SCHEMA_STATEMENTS.every((statement) => /IF NOT EXISTS/.test(statement)));
});

// Real-database integration tests. Run with SPORTS_DATA_TEST_DATABASE_URL pointing
// at a disposable database; each run uses (and drops) its own schema.
const DATABASE_URL = process.env.SPORTS_DATA_TEST_DATABASE_URL;
describe('PostgresSportsDataStore (integration)', { skip: DATABASE_URL ? false : 'SPORTS_DATA_TEST_DATABASE_URL not set' }, () => {
  const schema = `sd_test_${process.pid}_${Date.now()}`;
  let admin; let pool; let store;

  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
    store = new PostgresSportsDataStore(pool);
    await store.ensureSchema();
    await new PostgresSportsDataStore(pool).ensureSchema(); // idempotent
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const strip = (rows) => rows.map(({ firstSeenAt: _f, updatedAt: _u, ...row }) => row);

  test('ingestion behaves identically to the in-memory reference store', async () => {
    const memory = new MemorySportsDataStore();
    for (const target of [store, memory]) await registerSource(target, syntheticSource());
    const sequence = [
      syntheticBatch(),
      syntheticBatch(),
      (() => { const batch = syntheticBatch(); batch.playerGameStats[0].stats.points = 21; return batch; })(),
      syntheticBatch({ season: 2024, gameOffset: 10 }),
    ];
    for (const batch of sequence) {
      const [fromPg, fromMemory] = [await ingestBatch(store, structuredClone(batch)), await ingestBatch(memory, structuredClone(batch))];
      assert.deepEqual(fromPg.counts, fromMemory.counts);
    }
    for (const [kind, filters] of [
      ['teams', {}], ['players', { search: 'cent' }], ['games', { season: 2024, teamId: 'T2' }],
      ['playerGameStats', { playerId: 'P1' }], ['playerGameStats', { gameId: 'g1' }],
    ]) {
      assert.deepEqual(strip(await store.query(kind, 'basketball', filters)), strip(await memory.query(kind, 'basketball', filters)), kind);
    }
    assert.deepEqual((await store.listRuns()).map((run) => run.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const exported = await exportHistoricalSnapshots(store, { sport: 'basketball', sourceKey: 'synthetic-fixture' });
    const fromMemory = await exportHistoricalSnapshots(memory, { sport: 'basketball', sourceKey: 'synthetic-fixture' });
    assert.deepEqual(exported.snapshots.map((row) => [row.player.id, row.season, row.stats.points]),
      fromMemory.snapshots.map((row) => [row.player.id, row.season, row.stats.points]));
  });

  test('database constraints enforce referential integrity independently of the app layer', async () => {
    await assert.rejects(store.transaction((tx) => tx.upsertRecords('playerGameStats', 'basketball', 'synthetic-fixture', [{
      externalId: 'g404:P1', gameId: 'g404', playerId: 'P1', teamId: 'T1', season: 2023, seasonType: 'regular', stats: {}, contentHash: 'x'.repeat(64),
    }])), /foreign key/i);
    await assert.rejects(store.transaction((tx) => tx.upsertRecords('teams', 'basketball', 'unregistered', [{ externalId: 'T1', name: 'n', contentHash: 'x'.repeat(64) }])), /foreign key/i);
  });

  test('a failed batch leaves no partial rows and is logged', async () => {
    const before = (await store.query('players', 'basketball')).length;
    const batch = syntheticBatch();
    batch.players.push({ externalId: 'P3', fullName: 'Fixture New' });
    batch.playerGameStats[0].playerId = 'P404';
    await assert.rejects(ingestBatch(store, batch), /unknown players/);
    assert.equal((await store.query('players', 'basketball')).length, before);
    assert.equal((await store.listRuns({ limit: 1 }))[0].status, 'failed');
  });

  test('search treats LIKE wildcards literally', async () => {
    assert.equal((await store.query('players', 'basketball', { search: '%' })).length, 0);
    assert.equal((await store.query('players', 'basketball', { search: 'Fixture' })).length, 2);
  });
});
