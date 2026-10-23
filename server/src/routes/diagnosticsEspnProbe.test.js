/**
 * /api/diagnostics/free-nba?probe=espn-stats through a real local HTTP server. Outbound ESPN calls are stubbed; requests to our
 * own test server use the real fetch. Verifies auth, the feature flag, the one-request limit, privacy and abuse guards.
 */
import { test, before, after, beforeEach } from 'node:test';
import '../services/dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import diagnosticsRoutes, { resetEspnProbeGuard } from './diagnostics.js';

const SECRET = 'test-secret-espn-probe';
const originalFetch = global.fetch;
let server; let baseUrl; let outbound; let gate; let savedFlag;

const payload = (n) => ({
  categories: [{ name: 'general', names: ['gamesPlayed', 'avgMinutes'] }, { name: 'offensive', names: ['avgPoints'] }],
  athletes: Array.from({ length: n }, (_, i) => ({ athlete: { id: String(i), displayName: `Secret Player ${i}`, teamShortName: 'BOS' }, categories: [{ name: 'general', values: [70, 30] }, { name: 'offensive', values: [20] }] })),
});

before(async () => {
  process.env.JWT_SECRET = SECRET;
  savedFlag = process.env.ENABLE_FREE_NBA_DIAG;
  const app = express();
  app.use('/api/diagnostics', diagnosticsRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  global.fetch = originalFetch;
  if (savedFlag === undefined) delete process.env.ENABLE_FREE_NBA_DIAG; else process.env.ENABLE_FREE_NBA_DIAG = savedFlag;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  process.env.ENABLE_FREE_NBA_DIAG = 'true';
  resetEspnProbeGuard();
  outbound = []; gate = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return originalFetch(url, opts);
    outbound.push(u);
    if (gate) await gate;
    if (u.includes('/statistics/byathlete') && u.includes('limit=1000')) return new Response(JSON.stringify(payload(6)), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

const token = () => jwt.sign({ userId: 1 }, SECRET, { expiresIn: '5m' });
async function get(query, { auth = true } = {}) {
  const res = await originalFetch(`${baseUrl}/api/diagnostics/free-nba${query}`, { headers: auth ? { Authorization: `Bearer ${token()}` } : {} });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

test('probe requires authentication, like the rest of the route', async () => {
  const r = await get('?probe=espn-stats', { auth: false });
  assert.equal(r.status, 401);
  assert.equal(outbound.length, 0);
});

test('probe stays behind the existing feature flag (404 when disabled, nothing sent)', async () => {
  for (const value of [undefined, 'false', '1', 'TRUE']) {
    if (value === undefined) delete process.env.ENABLE_FREE_NBA_DIAG; else process.env.ENABLE_FREE_NBA_DIAG = value;
    const r = await get('?probe=espn-stats');
    assert.equal(r.status, 404, String(value));
  }
  assert.equal(outbound.length, 0);
});

test('authenticated probe: exactly ONE outbound request, to the ESPN season-stats endpoint only, aggregate-only response', async () => {
  const r = await get('?probe=espn-stats&season=2026');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(outbound.length, 1);
  assert.match(outbound[0], /^https:\/\/site\.web\.api\.espn\.com\/apis\/common\/v3\/sports\/basketball\/nba\/statistics\/byathlete\?.*limit=1000.*season=2026&seasontype=2$/);
  assert.deepEqual([r.body.status, r.body.athleteCount, r.body.usableStatCount, r.body.verdict, r.body.leagueSeason, r.body.projectionSeason], [200, 6, 6, 'ok', 2026, 2025]);
  const text = JSON.stringify(r.body);
  for (const banned of ['Secret Player', 'espn.com', 'http', 'Bearer', SECRET]) assert.ok(!text.includes(banned), banned);
});

test('default season matches the app\'s current league season', async () => {
  const r = await get('?probe=espn-stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.projectionSeason, r.body.leagueSeason - 1);
  assert.equal(outbound.length, 1);
});

test('the existing three-source connectivity check is unchanged when no probe is requested', async () => {
  const r = await get('');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['checkedAt', 'espnInjuries', 'espnSeasonStats', 'nbaSchedule']);
  assert.equal(outbound.length, 3);
});

test('unknown probe names and bad seasons are rejected before any outbound request', async () => {
  assert.equal((await get('?probe=everything')).status, 400);
  assert.equal((await get('?probe=')).status, 400);
  for (const season of ['abc', '1999', '2101', '20260', '2026.5', '-2026']) assert.equal((await get(`?probe=espn-stats&season=${season}`)).status, 400, season);
  assert.equal(outbound.length, 0);
});

test('abuse guard: a second probe right away is refused without any outbound request, and recovers after the cooldown resets', async () => {
  assert.equal((await get('?probe=espn-stats')).status, 200);
  const again = await get('?probe=espn-stats');
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'probe_cooldown');
  assert.ok(again.body.retryAfterMs > 0);
  assert.equal(outbound.length, 1);
  resetEspnProbeGuard();
  assert.equal((await get('?probe=espn-stats')).status, 200);
  assert.equal(outbound.length, 2);
});

test('abuse guard: concurrent probes are single-flight (second gets 429 while the first is running)', async () => {
  let release; gate = new Promise((r) => { release = r; });
  const first = get('?probe=espn-stats');
  await new Promise((r) => setTimeout(r, 50));
  const second = await get('?probe=espn-stats');
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'probe_in_progress');
  release();
  assert.equal((await first).status, 200);
  assert.equal(outbound.length, 1, 'only one outbound request in total');
});

test('a failing ESPN is reported as a category with HTTP 200 from our route and no leak of upstream detail', async () => {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    outbound.push(String(url));
    return new Response('upstream secret detail', { status: 403 });
  };
  const r = await get('?probe=espn-stats');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.status, r.body.errorCategory, r.body.verdict], [403, 'forbidden', 'unusable']);
  assert.ok(!JSON.stringify(r.body).includes('upstream secret detail'));
  assert.equal(outbound.length, 1);
});
