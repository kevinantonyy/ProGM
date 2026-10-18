/**
 * Security tests for the ranking diagnostics endpoints (ranking-compare, ranking-shadow).
 * No network: results are seeded straight into the in-memory cache. Synthetic keys and names only.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import basketballRoutes from './basketball.js';
import { cache } from '../services/providers/index.js';
import { rankingProfile } from '../services/fantasy/rankingModel.js';

const SECRET = 'test-secret-ranking-diag';
const LEAGUE = '428.l.111111'; const TEAM = '428.l.111111.t.3';
let server; let baseUrl; const saved = {};
const ENV = ['PROGM_RANKING_V2_USER_IDS', 'PROGM_RANKING_DIAGNOSTIC', 'PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION', 'NODE_ENV', 'PROGM_RANKING_SHADOW', 'PROGM_DRAFT_STATUS'];

before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.JWT_SECRET = SECRET;
  const app = express();
  app.use('/api/basketball', basketballRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  process.env.PROGM_RANKING_DIAGNOSTIC = 'on'; delete process.env.NODE_ENV; delete process.env.PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION; delete process.env.PROGM_RANKING_V2_USER_IDS;
  process.env.PROGM_DRAFT_STATUS = 'off'; // seeded keys below are the flag-off keys; the flag-on key is covered by its own test
});

const tok = (userId) => jwt.sign({ userId }, SECRET, { expiresIn: '5m' });
const row = (n, i) => ({ name: n, playerKey: `nba.p.${i}`, eligiblePositions: ['PG'], overallRank: i, components: { production: 0.5, replacement: 0.1, scarcity: 0.5, confidenceFactor: 0.9, perGame: 40, expectedGames: 70, seasonPoints: 2800, confidence: 0.9 } });
function seed(userId) {
  cache.set(`bball:ranking-shadow:${userId}:${LEAGUE}:${TEAM}`, { ok: true, ms: 3, comparison: { players: 2 } }, { provider: 'progm', ttl: 60000 });
  cache.set(`bball:workspace:${rankingProfile()}:${userId}:${LEAGUE}:${TEAM}`, { draftBoard: { rankingModel: 'legacy', board: [row('A', 1), row('B', 2)] } }, { provider: 'yahoo', ttl: 60000 });
}
async function get(path, { token = null, query = `leagueKey=${LEAGUE}&teamKey=${TEAM}` } = {}) {
  const res = await fetch(`${baseUrl}/api/basketball/diagnostics/${path}?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

for (const path of ['ranking-shadow', 'ranking-compare']) {
  test(`${path}: requires authentication`, async () => {
    seed(1);
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, { token: 'garbage' })).status, 401);
  });

  test(`${path}: closed (404, nothing revealed) unless the flag is exactly on`, async () => {
    seed(1);
    for (const v of [undefined, '', 'off', 'true', '1']) {
      if (v === undefined) delete process.env.PROGM_RANKING_DIAGNOSTIC; else process.env.PROGM_RANKING_DIAGNOSTIC = v;
      const r = await get(path, { token: tok(1) });
      assert.equal(r.status, 404); assert.ok(!r.text.includes('428'));
    }
  });

  test(`${path}: stays closed in NODE_ENV=production unless explicitly allowed`, async () => {
    seed(1);
    process.env.NODE_ENV = 'production';
    assert.equal((await get(path, { token: tok(1) })).status, 404);
    process.env.PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION = 'yes';
    assert.equal((await get(path, { token: tok(1) })).status, 200);
  });

  test(`${path}: a different user can never read someone else's cached data`, async () => {
    seed(1);
    const other = await get(path, { token: tok(2) });
    assert.equal(other.status, 409);
    assert.ok(!other.text.includes('"A"'));
    assert.equal((await get(path, { token: tok(1) })).status, 200);
  });

  test(`${path}: validates keys, including that the team belongs to the league`, async () => {
    seed(1);
    for (const query of ['', `leagueKey=${LEAGUE}`, `leagueKey=${LEAGUE}&teamKey=428.l.222222.t.3`, 'leagueKey=x&teamKey=y', `leagueKey[]=${LEAGUE}&teamKey=${TEAM}`]) {
      const r = await get(path, { token: tok(1), query });
      assert.equal(r.status, 400, query);
    }
  });

  test(`${path}: responses are no-store and carry no identifiers, tokens or team names`, async () => {
    seed(1);
    const r = await get(path, { token: tok(1) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-store/);
    for (const banned of [LEAGUE, TEAM, 'leagueKey', 'teamKey', 'token', 'accessToken', 'refresh', String(SECRET)]) assert.ok(!r.text.includes(banned), banned);
  });
}

test('account-scoped v2: workspace cache entries are separated per account and per model', async () => {
  process.env.PROGM_RANKING_V2_USER_IDS = '71';
  const put = (profile, userId, model) => cache.set(`bball:workspace:${profile}:${userId}:${LEAGUE}:${TEAM}`, { draftBoard: { rankingModel: model, board: [row('A', 1), row('B', 2)] } }, { provider: 'yahoo', ttl: 60000 });
  put('v2.noest', 71, 'v2'); put('legacy.noest', 72, 'legacy');
  const mine = await get('ranking-compare', { token: tok(71) });
  assert.equal(mine.status, 200); assert.equal(JSON.parse(mine.text).activeRankingModel, 'v2');
  const other = await get('ranking-compare', { token: tok(72) });
  assert.equal(other.status, 200); assert.equal(JSON.parse(other.text).activeRankingModel, 'legacy');
  // A legacy-profile entry for the listed account is never served as its v2 view, and nobody can read a v2 entry from another account.
  cache.set(`bball:workspace:legacy.noest:73:${LEAGUE}:${TEAM}`, { draftBoard: { rankingModel: 'legacy', board: [row('A', 1)] } }, { provider: 'yahoo', ttl: 60000 });
  process.env.PROGM_RANKING_V2_USER_IDS = '73';
  assert.equal((await get('ranking-compare', { token: tok(73) })).status, 409);
  assert.equal((await get('ranking-compare', { token: tok(74) })).status, 409);
});

test('draft-status flag on: ranking-compare reads the separate .status workspace entry, never the flag-off one', async () => {
  seed(1); // flag-off key only
  process.env.PROGM_DRAFT_STATUS = 'on';
  assert.equal((await get('ranking-compare', { token: tok(1) })).status, 409);
  cache.set(`bball:workspace:${rankingProfile()}.status:1:${LEAGUE}:${TEAM}`, { draftBoard: { rankingModel: 'legacy', board: [row('A', 1), row('B', 2)] } }, { provider: 'yahoo', ttl: 60000 });
  assert.equal((await get('ranking-compare', { token: tok(1) })).status, 200);
});
