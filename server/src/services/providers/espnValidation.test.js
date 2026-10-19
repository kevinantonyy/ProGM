/**
 * ESPN byathlete payload validation: an HTTP 200 that is not a usable feed (bot-wall HTML, null, {}, no athletes, athletes
 * with no usable data) must be a provider FAILURE: never cached, last-good preserved, recoverable on the next healthy call,
 * and never reported to the projection layer as "available but empty". Mocked fetch only.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as providers from './index.js';
import { cache, health } from './index.js';
import * as free from './freeNbaProvider.js';
import { buildProjectionContext } from '../fantasy/insights.js';

const originalFetch = global.fetch;
let calls;

function payload(n = 3) {
  return {
    categories: [
      { name: 'general', names: ['gamesPlayed', 'avgMinutes', 'rebounds', 'avgRebounds'] },
      { name: 'offensive', names: ['avgPoints', 'avgAssists', 'avgTurnovers'] },
      { name: 'defensive', names: ['avgSteals', 'avgBlocks'] },
    ],
    athletes: Array.from({ length: n }, (_, i) => ({
      athlete: { id: String(100 + i), displayName: `Player ${100 + i}`, teamShortName: 'BOS' },
      categories: [
        { name: 'general', values: [70, 32, 350, 5 + i] },
        { name: 'offensive', values: [20 + i, 5, 2] },
        { name: 'defensive', values: [1, 0.5] },
      ],
    })),
  };
}
const res = (body, { contentType = 'application/json' } = {}) => ({ ok: true, status: 200, headers: { get: () => contentType }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });

/** Mock fetch whose byathlete answer comes from `answer()`; everything else is a healthy empty answer. */
function stub(answer) {
  global.fetch = async (url) => {
    const u = String(url);
    const host = u.includes('rapidapi.com') ? 'tank01' : u.includes('espn.com') ? 'espn' : 'other';
    calls[host] = (calls[host] || 0) + 1;
    if (host === 'tank01') (calls.tankPaths ||= []).push(new URL(u).pathname);
    if (u.includes('/statistics/byathlete')) { calls.byathlete = (calls.byathlete || 0) + 1; return answer(calls.byathlete); }
    if (u.includes('/injuries')) return res({ injuries: [] });
    if (u.includes('scheduleLeagueV2')) return res({ leagueSchedule: { seasonYear: '2025-26', gameDates: [] } });
    return res({});
  };
}

const MALFORMED = {
  'bot-wall HTML': () => res('<html>Access check</html>', { contentType: 'text/html' }),
  'JSON null': () => res('null'),
  'empty object {}': () => res('{}'),
  'empty array []': () => res('[]'),
  'athletes missing': () => res({ categories: [] }),
  'athletes not an array': () => res({ athletes: 'nope' }),
  'zero athletes': () => res({ categories: payload().categories, athletes: [] }),
  'athletes without ids/names': () => res({ categories: payload().categories, athletes: [{ athlete: {}, categories: [] }, {}] }),
};

beforeEach(() => {
  cache.clearAll();
  health.reset('free_nba'); health.reset('tank01');
  calls = {};
  process.env.FREE_NBA_PRIMARY = 'true';
  delete process.env.RAPIDAPI_KEY;
});
afterEach(() => { global.fetch = originalFetch; delete process.env.PROGM_TANK01_PLAYER_BUDGET; delete process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET; });

test('player index: every malformed/empty shape is a failure (throws), never an empty directory', async () => {
  for (const [label, answer] of Object.entries(MALFORMED)) {
    stub(answer);
    await assert.rejects(free.getPlayerIndex(2025), /ESPN/, label);
  }
});

test('season stats bulk: malformed/empty shapes and athletes with no usable stat line all throw', async () => {
  for (const [label, answer] of Object.entries(MALFORMED)) {
    stub(answer);
    await assert.rejects(free.getSeasonStatsBulk(2025), /ESPN/, label);
  }
  stub(() => res({ categories: payload().categories, athletes: [{ athlete: { id: '1', displayName: 'No Stats', teamShortName: 'BOS' }, categories: [] }] }));
  await assert.rejects(free.getSeasonStatsBulk(2025), /no usable stat lines/);
});

test('games-played history feed: malformed shapes throw so an empty {} is never cached for 30 days', async () => {
  for (const [label, answer] of Object.entries(MALFORMED)) {
    stub(answer);
    await assert.rejects(free.getSeasonGamesPlayed(2024), /ESPN/, label);
  }
  stub(() => res({ ...payload(), athletes: [{ athlete: { id: '9', displayName: 'X', teamShortName: 'BOS' }, categories: [] }] }));
  await assert.rejects(free.getSeasonGamesPlayed(2024), /no usable rows/);
  stub((n) => res(payload(2)));
  assert.deepEqual(await free.getSeasonGamesPlayed(2024), { 100: 70, 101: 70 });
});

test('a valid feed still maps exactly as before', async () => {
  stub(() => res(payload(3)));
  assert.equal((await free.getPlayerIndex(2025)).length, 3);
  const stats = await free.getSeasonStatsBulk(2025);
  assert.equal(stats.length, 3);
  assert.equal(stats[0].season.points, 20);
});

test('orchestrator: malformed index is a provider failure, nothing is cached, and the failure is recorded', async () => {
  stub(MALFORMED['bot-wall HTML']);
  assert.equal(await providers.getPlayerIndex('2025'), null);
  assert.equal(cache.has('playerIndex:2025'), false);
  assert.equal(health.status('free_nba').failures, 1);
  assert.match(health.status('free_nba').lastErrorType, /Unrecognized or empty ESPN/);
});

test('recovery: the very next healthy response replaces a failed attempt (no waiting on a poisoned cache)', async () => {
  stub(MALFORMED['empty object {}']);
  assert.equal(await providers.getPlayerIndex('2025'), null);
  assert.equal(await providers.getSeasonStats('2025', ['100']).then((r) => r.value.length), 0);
  stub(() => res(payload(3)));
  const index = await providers.getPlayerIndex('2025');
  assert.equal(index.value.length, 3);
  const stats = await providers.getSeasonStats('2025', ['100', '101', '102']);
  assert.equal(stats.value.length, 3);
});

test('an entry ALREADY poisoned with an empty value (stored before this fix) is bypassed immediately', async () => {
  cache.set('playerIndex:2025', [], { provider: 'free_nba', ttl: 24 * 60 * 60 * 1000 });
  cache.set('seasonStatsAll:2025:free_nba', [], { provider: 'free_nba', ttl: 12 * 60 * 60 * 1000 });
  cache.set('gamesPlayed:2024:free_nba', {}, { provider: 'free_nba', ttl: 30 * 24 * 60 * 60 * 1000 });
  stub(() => res(payload(3)));
  assert.equal((await providers.getPlayerIndex('2025')).value.length, 3);
  assert.equal((await providers.getSeasonStats('2025', ['100'])).value.length, 1);
  const history = await providers.getHistoricalAvailability('2026', 3);
  assert.ok(Object.keys(history.value).length > 0, 'history was refetched instead of serving the poisoned {}');
});

test('last known good value is preserved when a later response is malformed', async () => {
  stub(() => res(payload(3)));
  assert.equal((await providers.getPlayerIndex('2025')).value.length, 3);
  // Age the good entry past its TTL, then let ESPN return garbage.
  cache.set('playerIndex:2025', cache.get('playerIndex:2025').value, { provider: 'free_nba', ttl: -1 });
  stub(MALFORMED['bot-wall HTML']);
  const served = await providers.getPlayerIndex('2025');
  assert.equal(served.value.length, 3);
  assert.equal(served.meta.stale, true);
  assert.equal(cache.get('playerIndex:2025').value.length, 3, 'the good value is still what is stored');
});

test('buildProjectionContext: a malformed feed means projections are UNAVAILABLE with a meaningful reason (not "available, zero matched")', async () => {
  stub(MALFORMED['bot-wall HTML']);
  const ctx = await buildProjectionContext({
    season: '2026', players: [{ playerKey: '466.p.1', name: 'Player 100', teamAbbr: 'BOS' }],
    statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true,
  });
  assert.equal(ctx.externalAvailable, false);
  assert.equal(ctx.projectionProvider, null);
  assert.match(ctx.reason, /ESPN are unavailable: Unrecognized or empty ESPN player directory/);
  assert.equal(ctx.diagnostic.freeNba.failures, 1);
});

test('buildProjectionContext: a stale-poisoned empty directory is also treated as unavailable, then recovers when ESPN is healthy', async () => {
  cache.set('playerIndex:2025', [], { provider: 'free_nba', ttl: 24 * 60 * 60 * 1000 });
  stub(MALFORMED['empty object {}']);
  const params = { season: '2026', players: [{ playerKey: '466.p.1', name: 'Player 100', teamAbbr: 'BOS' }], statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true };
  assert.equal((await buildProjectionContext(params)).externalAvailable, false);
  stub(() => res(payload(3)));
  const healthy = await buildProjectionContext(params);
  assert.equal(healthy.externalAvailable, true);
  assert.equal(healthy.projectionByCanonicalId.size, 1);
  assert.ok([...healthy.projectionByCanonicalId.values()][0].projectedPoints > 0);
});

const pool = (n) => Array.from({ length: n }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${100 + i}`, teamAbbr: 'BOS' }));
const cats = [{ statId: 12, enabled: true, pointValue: 1 }];
// ESPN serves a healthy directory the first time (index) and a malformed answer for the stats request.
const indexOkStatsBad = (n) => (count) => (count === 1 ? res(payload(n)) : res('<html>blocked</html>', { contentType: 'text/html' }));

test('fallback limits: bulkOnly (Draft Preview) never makes per-player Tank01 requests and says why nothing was projected', async () => {
  process.env.RAPIDAPI_KEY = 'test-key'; // Tank01 configured, so the fallback WOULD be reachable
  stub(indexOkStatsBad(40));
  const ctx = await buildProjectionContext({ season: '2026', players: pool(40), statCategories: cats, scoringSupported: true, bulkOnly: true });
  // At most the single league-wide injury list (the ESPN breaker opens after repeated failures); never per-player requests.
  assert.ok((calls.tank01 || 0) <= 1, `Tank01 requests must not scale with the pool, saw ${calls.tankPaths}`);
  assert.ok((calls.tankPaths || []).every((path) => /InjuryList$/.test(path)), `unexpected Tank01 endpoints: ${calls.tankPaths}`);
  assert.equal([...ctx.projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length, 0);
  assert.match(ctx.reason, /does not use slower per-player lookups/);
});

test('fallback limits: with limits explicitly configured, the normal workspace path still uses the Tank01 per-player fallback', async () => {
  process.env.RAPIDAPI_KEY = 'test-key';
  process.env.PROGM_TANK01_PLAYER_BUDGET = '50'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '200';
  stub(indexOkStatsBad(5));
  await buildProjectionContext({ season: '2026', players: pool(5), statCategories: cats, scoringSupported: true });
  assert.ok((calls.tank01 || 0) >= 5, `expected per-player Tank01 requests, saw ${calls.tank01 || 0}`);
  assert.ok(calls.tankPaths.some((path) => !/InjuryList$/.test(path)), 'per-player stats lookups are still used by the normal path');
});

test('bulkOnly still projects normally when the bulk feed is healthy', async () => {
  process.env.RAPIDAPI_KEY = 'test-key';
  stub(() => res(payload(10)));
  const ctx = await buildProjectionContext({ season: '2026', players: pool(10), statCategories: cats, scoringSupported: true, bulkOnly: true });
  assert.equal([...ctx.projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length, 10);
  assert.equal(calls.tank01 || 0, 0, 'a healthy bulk feed needs no Tank01 at all');
  assert.equal(ctx.reason, null);
});

test('fallback limits: by DEFAULT (no budget configured) the normal path makes no per-player Tank01 requests either', async () => {
  process.env.RAPIDAPI_KEY = 'test-key';
  delete process.env.PROGM_TANK01_PLAYER_BUDGET; delete process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET;
  stub(indexOkStatsBad(20));
  const ctx = await buildProjectionContext({ season: '2026', players: pool(20), statCategories: cats, scoringSupported: true });
  assert.ok((calls.tankPaths || []).every((path) => /InjuryList$/.test(path)), `unexpected Tank01 endpoints: ${calls.tankPaths}`);
  assert.match(ctx.reason, /fallback is disabled \(its budget is 0\)/);
});
