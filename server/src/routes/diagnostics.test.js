/**
 * Tests for the TEMPORARY protected free-NBA connectivity diagnostic route.
 * No live network: global.fetch is stubbed. Verifies auth is required, the
 * enable-flag gate, the safe response shape, and that nothing sensitive leaks.
 */
import { test, before, after, beforeEach } from 'node:test';
import '../services/dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import diagnosticsRoutes from './diagnostics.js';

const SECRET = 'test-secret-for-diag';
let server; let baseUrl; const originalFetch = global.fetch;

before(async () => {
  process.env.JWT_SECRET = SECRET;
  process.env.ENABLE_FREE_NBA_DIAG = 'true';
  const app = express();
  app.use('/api/diagnostics', diagnosticsRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = originalFetch;
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  // Stub ONLY the outbound probe requests (ESPN / NBA CDN). Requests to our own
  // local test server must use the real fetch so the route is actually hit.
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('espn.com') || u.includes('cdn.nba.com')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) };
    }
    return originalFetch(url, opts);
  };
});

function token() { return jwt.sign({ userId: 1 }, SECRET, { expiresIn: '5m' }); }
async function call(headers = {}) {
  const res = await fetch(`${baseUrl}/api/diagnostics/free-nba`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('requires authentication (401 without a token)', async () => {
  const { status, body } = await call();
  assert.equal(status, 401);
  assert.match(body.error, /token/i);
});

test('rejects an invalid token', async () => {
  const { status } = await call({ Authorization: 'Bearer not-a-real-token' });
  assert.equal(status, 401);
});

test('authenticated request returns the safe per-source shape', async () => {
  const { status, body } = await call({ Authorization: `Bearer ${token()}` });
  assert.equal(status, 200);
  for (const field of ['espnSeasonStats', 'espnInjuries', 'nbaSchedule']) {
    assert.ok(body[field], `missing ${field}`);
    // ONLY status, kind, ms are allowed per source.
    assert.deepEqual(Object.keys(body[field]).sort(), ['kind', 'ms', 'status']);
    assert.equal(body[field].status, 200);
    assert.equal(body[field].kind, 'ok');
    assert.equal(typeof body[field].ms, 'number');
  }
});

test('response exposes NO sensitive fields', async () => {
  const { body } = await call({ Authorization: `Bearer ${token()}` });
  // Structural guarantee: top-level keys are limited to the three sources +
  // checkedAt, and each source carries ONLY status/kind/ms. This proves no
  // headers, keys, env, payloads, or player/injury/schedule data can appear.
  assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'espnInjuries', 'espnSeasonStats', 'nbaSchedule']);
  for (const field of ['espnSeasonStats', 'espnInjuries', 'nbaSchedule']) {
    assert.deepEqual(Object.keys(body[field]).sort(), ['kind', 'ms', 'status']);
  }
  // Value-level: forbidden sensitive tokens must not appear anywhere in VALUES.
  const values = JSON.stringify(Object.values(body)).toLowerCase();
  for (const forbidden of ['authorization', 'cookie', 'bearer', 'apikey', 'api_key', 'rapidapi', 'secret', 'user-agent', 'referer', 'password', 'personid']) {
    assert.ok(!values.includes(forbidden), `response leaked "${forbidden}"`);
  }
});

test('is disabled (404) when ENABLE_FREE_NBA_DIAG is not "true"', async () => {
  process.env.ENABLE_FREE_NBA_DIAG = 'false';
  const { status, body } = await call({ Authorization: `Bearer ${token()}` });
  assert.equal(status, 404);
  assert.match(body.error, /disabled/i);
  process.env.ENABLE_FREE_NBA_DIAG = 'true'; // restore for any later tests
});
