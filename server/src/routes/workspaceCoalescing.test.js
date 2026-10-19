/**
 * /workspace request coalescing: identical simultaneous builds (same user, league, team and payload-changing flags) share one build;
 * anything else never does. Failures reject every waiter, are not cached, and leave nothing in flight. The workspace builder is
 * replaced by a controllable fake, so there is no Yahoo, network or credential involved.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBasketballRouter } from './basketball.js';
import * as cache from '../services/providers/cache.js';
import { rankingProfileForUser } from '../services/fantasy/rankingModel.js';

const LEAGUE = '466.l.1';
const TEAM = `${LEAGUE}.t.1`;
const ENV = ['PROGM_RANKINGS_FULL_POOL', 'PROGM_DRAFT_STATUS', 'PROGM_DRAFT_PREVIEW'];
const SAVED = {};
let builds; let gates;

beforeEach(() => { for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; } cache.clearAll(); builds = []; gates = []; });
afterEach(() => { for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

/** Router whose builder records every build and only finishes when the test releases it (or fails when told to). */
function setup() {
  return createBasketballRouter({
    cache,
    authenticate: (req, res, next) => next(),
    accessTokenFor: async (userId) => `token-for-${userId}`,
    yahooFantasy: async () => { throw new Error('the route must not call Yahoo itself when teamKey is supplied'); },
    buildBasketballWorkspace: ({ leagueKey, teamKey, userId, accessToken }) => new Promise((resolve, reject) => {
      builds.push({ leagueKey, teamKey, userId, accessToken });
      gates.push({ resolve: () => resolve({ privateFor: userId, leagueKey, teamKey, accessToken, builtAt: builds.length }), fail: (error) => reject(error) });
    }),
  });
}
function request(router, { userId = 1, leagueKey = LEAGUE, teamKey = TEAM, refresh = false } = {}) {
  const handler = router.stack.find((layer) => layer.route?.path === '/workspace').route.stack.at(-1).handle;
  const req = { userId, query: { leagueKey, teamKey, ...(refresh ? { refresh: 'true' } : {}) } };
  const res = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return handler(req, res).then(() => res);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test('simultaneous identical requests share ONE build, and every caller gets the result', async () => {
  const router = setup();
  const first = request(router); const second = request(router); const third = request(router);
  await tick();
  assert.equal(builds.length, 1, 'only one build started');
  gates[0].resolve();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([a.statusCode, b.statusCode, c.statusCode], [200, 200, 200]);
  for (const r of [a, b, c]) { assert.equal(r.body.privateFor, 1); assert.equal(r.body.leagueKey, LEAGUE); }
  assert.equal(a.body.cache.coalesced, undefined, 'the builder\'s own response is not marked');
  assert.equal(b.body.cache.coalesced, true);
  assert.equal(c.body.cache.coalesced, true);
  assert.equal(builds.length, 1);
});

test('after the build the result is cached (freshness preserved) and nothing stays in flight', async () => {
  const router = setup();
  const first = request(router); await tick(); gates[0].resolve(); await first;
  const cached = await request(router);
  assert.equal(builds.length, 1, 'served from cache, no new build');
  assert.equal(cached.body.cache.hit, true);
  assert.equal(cache.has(`bball:workspace:${rankingProfileForUser(1)}:1:${LEAGUE}:${TEAM}`), true);
  // refresh=true with nothing in flight builds again.
  const refresh = request(router, { refresh: true }); await tick();
  assert.equal(builds.length, 2);
  gates[1].resolve(); assert.equal((await refresh).body.cache.hit, false);
});

test('a refresh that arrives while an identical build is in flight joins it instead of starting another', async () => {
  const router = setup();
  const building = request(router); await tick();
  const refresh = request(router, { refresh: true }); await tick();
  assert.equal(builds.length, 1);
  gates[0].resolve();
  const [a, b] = await Promise.all([building, refresh]);
  assert.equal(b.body.cache.coalesced, true);
  assert.equal(a.statusCode, 200);
});

test('DIFFERENT USERS never share a build or a response: each gets its own data and token', async () => {
  const router = setup();
  const alice = request(router, { userId: 1 }); const bob = request(router, { userId: 2 });
  await tick();
  assert.equal(builds.length, 2, 'two users, two builds');
  assert.deepEqual(builds.map((b) => [b.userId, b.accessToken]).sort(), [[1, 'token-for-1'], [2, 'token-for-2']]);
  gates[1].resolve(); gates[0].resolve();
  const [a, b] = await Promise.all([alice, bob]);
  assert.equal(a.body.privateFor, 1); assert.equal(a.body.accessToken, 'token-for-1');
  assert.equal(b.body.privateFor, 2); assert.equal(b.body.accessToken, 'token-for-2');
  assert.equal(a.body.cache.coalesced, undefined); assert.equal(b.body.cache.coalesced, undefined);
  // And a later request by each user is served from that user's own cache entry.
  const again = await request(router, { userId: 2 });
  assert.equal(again.body.privateFor, 2);
  assert.equal(builds.length, 2);
});

test('different leagues, teams or payload-changing flags never share a build', async () => {
  const router = setup();
  const base = request(router);
  const otherLeague = request(router, { leagueKey: '467.l.9', teamKey: '467.l.9.t.2' });
  const otherTeam = request(router, { teamKey: `${LEAGUE}.t.7` });
  await tick();
  assert.equal(builds.length, 3);
  // A flag that changes the payload changes the key: flip it while the first build is still in flight.
  process.env.PROGM_RANKINGS_FULL_POOL = 'on';
  const flagged = request(router); await tick();
  assert.equal(builds.length, 4, 'full-pool flag on => separate build');
  process.env.PROGM_DRAFT_STATUS = 'on';
  const flagged2 = request(router); await tick();
  assert.equal(builds.length, 5, 'status flag on => separate build');
  delete process.env.PROGM_RANKINGS_FULL_POOL; delete process.env.PROGM_DRAFT_STATUS;
  process.env.PROGM_DRAFT_PREVIEW = 'on';
  const flagged3 = request(router); await tick();
  assert.equal(builds.length, 6, 'draft-preview capability flag on => separate build');
  gates.forEach((g) => g.resolve());
  await Promise.all([base, otherLeague, otherTeam, flagged, flagged2, flagged3]);
});

test('a failed build rejects EVERY waiter with the same error, is not cached, and the next request starts a fresh build', async () => {
  const router = setup();
  const first = request(router); const second = request(router);
  await tick();
  assert.equal(builds.length, 1);
  gates[0].fail(Object.assign(new Error('Yahoo requests are temporarily paused'), { httpStatus: 999, yahooCode: 'CIRCUIT_OPEN' }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.statusCode, b.statusCode], [502, 502]);
  assert.match(a.body.error, /temporarily paused/); assert.match(b.body.error, /temporarily paused/);
  assert.equal(a.body.yahooStatus, 999);
  assert.equal(cache.has(`bball:workspace:${rankingProfileForUser(1)}:1:${LEAGUE}:${TEAM}`), false, 'failure is never cached');
  const retry = request(router); await tick();
  assert.equal(builds.length, 2, 'in-flight entry was cleaned up, so a new build starts');
  gates[1].resolve();
  assert.equal((await retry).statusCode, 200);
});

test('a build that throws synchronously-ish (rejects immediately) still cleans up and cannot wedge the key', async () => {
  const router = createBasketballRouter({
    cache, authenticate: (q, s, n) => n(), accessTokenFor: async () => 'tok', yahooFantasy: async () => ({}),
    buildBasketballWorkspace: async () => { builds.push(1); throw new Error('boom'); },
  });
  assert.equal((await request(router)).statusCode, 502);
  assert.equal((await request(router)).statusCode, 502);
  assert.equal(builds.length, 2, 'each request after a failure builds again (nothing stuck in flight)');
});

test('the coalescing key carries the per-account ranking profile, so the v2 allowlist cannot cross accounts', async () => {
  process.env.PROGM_RANKING_V2_USER_IDS = '2';
  try {
    const router = setup();
    const legacyUser = request(router, { userId: 1 }); const v2User = request(router, { userId: 2 });
    await tick();
    assert.equal(builds.length, 2);
    gates.forEach((g) => g.resolve());
    await Promise.all([legacyUser, v2User]);
    assert.equal(cache.has(`bball:workspace:${rankingProfileForUser(1)}:1:${LEAGUE}:${TEAM}`), true);
    assert.equal(cache.has(`bball:workspace:${rankingProfileForUser(2)}:2:${LEAGUE}:${TEAM}`), true);
    assert.notEqual(rankingProfileForUser(1), rankingProfileForUser(2));
  } finally {
    delete process.env.PROGM_RANKING_V2_USER_IDS;
  }
});
