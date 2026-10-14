/** Internal sports data route: feature flag, auth, admin allowlist, read-only behaviour. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createSportsDataRouter } from './sportsData.js';
import { ingestBatch, registerSource } from '../services/sportsData/ingest.js';
import { MemorySportsDataStore } from '../services/sportsData/memoryStore.js';
import { syntheticBatch, syntheticSource } from '../services/sportsData/syntheticFixture.js';

const SECRET = 'test-secret-for-sports-data';
const env = { ENABLE_SPORTS_DATA_API: 'true', SPORTS_DATA_ADMIN_USER_IDS: '7, 9' };
let server; let baseUrl; let store; let failing = false;

before(async () => {
  process.env.JWT_SECRET = SECRET;
  store = new MemorySportsDataStore();
  await registerSource(store, syntheticSource());
  await ingestBatch(store, syntheticBatch());
  const app = express();
  app.use(express.json());
  app.use('/api/internal/sports-data', createSportsDataRouter({
    env,
    getStore: () => (failing ? { ensureSchema: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'); } } : store),
  }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/internal/sports-data`;
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

const token = (userId) => jwt.sign({ userId }, SECRET, { expiresIn: '5m' });
async function call(path, { userId = 7, method = 'GET', headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers ?? (userId == null ? {} : { Authorization: `Bearer ${token(userId)}` }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('disabled flag hides the API entirely, even for admins', async () => {
  env.ENABLE_SPORTS_DATA_API = 'false';
  try {
    assert.equal((await call('/sources')).status, 404);
    assert.equal((await call('/sources', { userId: null })).status, 404);
  } finally {
    env.ENABLE_SPORTS_DATA_API = 'true';
  }
});

test('requires a valid token and an allowlisted admin user', async () => {
  assert.equal((await call('/sources', { userId: null })).status, 401);
  assert.equal((await call('/sources', { headers: { Authorization: 'Bearer not-a-jwt' } })).status, 401);
  const forged = jwt.sign({ userId: 7 }, 'wrong-secret');
  assert.equal((await call('/sources', { headers: { Authorization: `Bearer ${forged}` } })).status, 401);
  assert.equal((await call('/sources', { userId: 8 })).status, 403);
  assert.equal((await call('/basketball/players', { userId: 70 })).status, 403);
  const ok = await call('/sources', { userId: 9 });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('an empty admin allowlist denies everyone', async () => {
  const saved = env.SPORTS_DATA_ADMIN_USER_IDS;
  env.SPORTS_DATA_ADMIN_USER_IDS = '';
  try {
    assert.equal((await call('/sources')).status, 403);
  } finally {
    env.SPORTS_DATA_ADMIN_USER_IDS = saved;
  }
});

test('is read-only: write methods are rejected without changing data', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await call('/basketball/players', { method });
    assert.equal(response.status, 405);
  }
  assert.equal((await store.query('players', 'basketball')).length, 2);
});

test('admins can read stored, attributed data with filters and pagination', async () => {
  const sources = await call('/sources');
  assert.equal(sources.body.sources[0].sourceKey, 'synthetic-fixture');
  assert.equal(sources.body.sources[0].permissions.storage, true);
  const players = await call('/basketball/players?search=guard');
  assert.deepEqual(players.body.data.map((row) => row.fullName), ['Fixture Guard']);
  const games = await call('/basketball/games?season=2023&teamId=T1&limit=1&offset=1');
  assert.equal(games.body.data.length, 1);
  assert.equal(games.body.data[0].externalId, 'g2');
  const log = await call('/basketball/players/P1/games?season=2023');
  assert.deepEqual(log.body.data.map((row) => row.stats.points), [20, 30]);
  assert.ok(log.body.data.every((row) => row.sourceKey === 'synthetic-fixture' && !('contentHash' in row)));
  const boxScore = await call('/basketball/games/g1/stats');
  assert.equal(boxScore.body.data.length, 2);
  const runs = await call('/ingestion-runs');
  assert.equal(runs.body.runs[0].status, 'succeeded');
});

test('validates parameters and sports', async () => {
  for (const path of ['/basketball/games?limit=0', '/basketball/games?limit=1000', '/basketball/games?season=abc',
    '/basketball/games?seasonType=exhibition', '/basketball/games?offset=-1', `/basketball/players?search=${'x'.repeat(61)}`,
    '/basketball/games?sourceKey=%27%3B%20DROP%20TABLE']) {
    assert.equal((await call(path)).status, 400, path);
  }
  assert.equal((await call('/football/players')).status, 501);
  assert.equal((await call('/cricket/players')).status, 404);
  assert.equal((await call('/basketball/unknown')).status, 404);
});

test('store failures return a generic error without internals', async () => {
  failing = true;
  try {
    const response = await call('/sources');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'internal_error' });
  } finally {
    failing = false;
  }
});
