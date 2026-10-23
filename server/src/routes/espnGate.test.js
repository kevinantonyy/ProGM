/**
 * ESPN routes behind the data-source gate (services/dataSources/policy.js). With ESPN off (the default) every /api/espn route answers 503
 * before authentication, before any database call and before any request to ESPN, including the unauthenticated /preview.
 * Real express app and router; ESPN is a counting fetch stub; the database is a counting stub on the pool. No network.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pool from '../db/connection.js';
import espnRoutes from './espn.js';
import { DATA_SOURCES } from '../services/dataSources/policy.js';

const realFetch = globalThis.fetch;
const realExecute = pool.execute;
let server; let base; let espnRequests; let dbCalls; const savedEnv = {};

before(async () => {
  for (const { env } of Object.values(DATA_SOURCES)) { savedEnv[env] = process.env[env]; delete process.env[env]; }
  const app = express();
  app.use(express.json());
  app.use('/api/espn', espnRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/espn`;
});
after(async () => {
  globalThis.fetch = realFetch; pool.execute = realExecute;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  espnRequests = []; dbCalls = 0;
  delete process.env.PROGM_DATA_ESPN;
  pool.execute = async () => { dbCalls += 1; return [[]]; };
  globalThis.fetch = async (url, init) => {
    if (/espn\.com|espncdn\.com/.test(String(url))) { espnRequests.push(String(url)); return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; }
    return realFetch(url, init); // our own local test server
  };
});

const call = (method, path, { body, token } = {}) => realFetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('ESPN OFF by default: the unauthenticated preview answers 503 and makes NO ESPN request and NO database call', async () => {
  const r = await call('POST', '/preview', { body: { leagueId: '123456', season: 2026, sport: 'football' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'espn_data_unavailable');
  assert.match(r.json.error, /ESPN data is not available/);
  assert.deepEqual(espnRequests, []);
  assert.equal(dbCalls, 0);
});

test('ESPN OFF by default: every other route is shut too, with or without credentials, before auth, DB or any ESPN request', async () => {
  const routes = [
    ['POST', '/connect', { leagueId: '123456', season: 2026, sport: 'football', teamId: 1 }],
    ['GET', '/status'], ['GET', '/news/football'], ['GET', '/news/basketball'], ['GET', '/workspace/football'], ['GET', '/workspace/basketball?refresh=true'],
    ['GET', '/anything-else'], ['POST', '/manual-import', { playerNames: 'a' }],
  ];
  for (const token of [undefined, 'not-a-real-token']) {
    for (const [method, path, body] of routes) {
      const r = await call(method, path, { body, token });
      assert.equal(r.status, 503, `${method} ${path} token=${Boolean(token)}`); // 503, not 401: the gate runs before authentication
      assert.equal(r.json.code, 'espn_data_unavailable');
    }
  }
  assert.deepEqual(espnRequests, [], 'no request to ESPN');
  assert.equal(dbCalls, 0, 'no database call: stored ESPN connections are neither read nor changed');
});

test('the availability endpoint is static: it explains the shutoff without touching ESPN or the database', async () => {
  const r = await call('GET', '/availability');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, false);
  assert.match(r.json.message, /ESPN has declined/);
  assert.match(r.json.message, /Yahoo basketball league is not affected/);
  assert.deepEqual(espnRequests, []);
  assert.equal(dbCalls, 0);
});

test('values other than the exact word "allow" keep ESPN off', async () => {
  for (const v of ['true', '1', 'on', 'yes', 'enabled']) {
    process.env.PROGM_DATA_ESPN = v;
    const r = await call('POST', '/preview', { body: { leagueId: '123456', season: 2026, sport: 'football' } });
    assert.equal(r.status, 503, v);
  }
  assert.deepEqual(espnRequests, []);
});

test('reversible: with PROGM_DATA_ESPN=allow the routes work again (the guard is the only thing standing in the way)', async () => {
  process.env.PROGM_DATA_ESPN = 'allow';
  assert.deepEqual((await call('GET', '/availability')).json, { available: true });
  const r = await call('POST', '/preview', { body: { leagueId: '123456', season: 2026, sport: 'football' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /ESPN league not found/); // the stub answered 404
  assert.equal(espnRequests.length, 1, 'exactly one request, and only because ESPN was explicitly allowed');
  assert.match(espnRequests[0], /lm-api-reads\.fantasy\.espn\.com/);
});
