/**
 * The free-NBA diagnostics route when ESPN and NBA.com are off (the default): it does not exist, even for an authenticated user and even
 * with ENABLE_FREE_NBA_DIAG=true (the value render.yaml sets), and it makes no request. Deliberately does not opt the sources in.
 * Real express app and router, real JWT; fetch is a counting stub. No network.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import diagnosticsRoutes, { resetEspnProbeGuard } from './diagnostics.js';
import { DATA_SOURCES } from '../services/dataSources/policy.js';

const SECRET = 'test-secret-for-diag-gate';
const realFetch = globalThis.fetch;
const savedEnv = {};
let server; let base; let outbound;

before(async () => {
  for (const name of ['JWT_SECRET', 'ENABLE_FREE_NBA_DIAG', ...Object.values(DATA_SOURCES).map((s) => s.env)]) savedEnv[name] = process.env[name];
  process.env.JWT_SECRET = SECRET;
  process.env.ENABLE_FREE_NBA_DIAG = 'true';
  const app = express();
  app.use('/api/diagnostics', diagnosticsRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/diagnostics`;
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  outbound = []; resetEspnProbeGuard();
  for (const { env } of Object.values(DATA_SOURCES)) delete process.env[env];
  globalThis.fetch = async (url, init) => {
    if (/espn|nba\.com|rapidapi/.test(String(url))) { outbound.push(String(url)); return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}', json: async () => ({}) }; }
    return realFetch(url, init);
  };
});

const get = (path) => realFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: 1 }, SECRET)}` } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('with ESPN and NBA.com off, the diagnostics route is 404 and makes no request (ENABLE_FREE_NBA_DIAG=true does not revive it)', async () => {
  for (const p of ['/free-nba', '/free-nba?probe=espn-stats', '/free-nba?probe=espn-stats&season=2026']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.json.error, /disabled/i);
  }
  assert.deepEqual(outbound, []);
});

test('allowing only NBA.com does not enable the ESPN probe, and the ESPN source is reported as disabled without a request', async () => {
  process.env.PROGM_DATA_NBA_COM = 'allow';
  assert.equal((await get('/free-nba?probe=espn-stats')).status, 404);
  const summary = await get('/free-nba');
  assert.equal(summary.status, 200);
  assert.equal(summary.json.espnSeasonStats?.kind, 'source_disabled');
  assert.equal(summary.json.espnInjuries?.kind, 'source_disabled');
  assert.ok(outbound.every((u) => /cdn\.nba\.com/.test(u)), `only NBA.com was contacted: ${outbound.join(' ')}`);
  assert.equal(outbound.some((u) => /espn/.test(u)), false);
});
