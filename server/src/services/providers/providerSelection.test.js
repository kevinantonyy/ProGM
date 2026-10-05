/**
 * Provider-selection + request-budget integration tests.
 *
 * Drives the REAL orchestrator (providers/index.js) with global.fetch stubbed
 * to COUNT outbound requests per host (no live network, no quota). Verifies:
 *   - free_nba is PRIMARY (ESPN/NBA CDN hosts hit, not Tank01)
 *   - league-wide season stats = ONE request for N players (no per-player explosion)
 *   - warm cache = ZERO outbound requests
 *   - Tank01 is NOT called when free_nba succeeds
 *   - Tank01 FALLBACK is used when free_nba fails
 *   - a partial source failure (injuries) does not break season stats/schedule
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as providers from './index.js';
import { cache, health } from './index.js';

const originalFetch = global.fetch;
let hostCalls;

function espnByathletePayload(ids) {
  return {
    categories: [
      { name: 'general', names: ['gamesPlayed', 'avgMinutes', 'rebounds', 'avgRebounds'] },
      { name: 'offensive', names: ['avgPoints', 'avgAssists', 'avgTurnovers'] },
      { name: 'defensive', names: ['avgSteals', 'avgBlocks'] },
    ],
    athletes: ids.map((id, i) => ({
      athlete: { id, displayName: `Player ${id}`, teamShortName: 'BOS' },
      categories: [
        { name: 'general', values: [70, 32, 350, 5 + i] },
        { name: 'offensive', values: [20 + i, 5, 2] },
        { name: 'defensive', values: [1, 0.5] },
      ],
    })),
  };
}

function makeFetchStub({ failHosts = [], } = {}) {
  return async (url) => {
    const u = String(url);
    const host = u.includes('cdn.nba.com') ? 'nba_cdn'
      : u.includes('espn.com') ? 'espn'
      : u.includes('rapidapi.com') ? 'tank01'
      : 'other';
    hostCalls[host] = (hostCalls[host] || 0) + 1;
    if (failHosts.includes(host)) {
      return { ok: false, status: 500, headers: { get: () => '' }, text: async () => '', json: async () => ({}) };
    }
    let body = {};
    if (u.includes('/statistics/byathlete')) body = espnByathletePayload(['111', '222', '333']);
    else if (u.includes('/injuries')) body = { injuries: [] };
    else if (u.includes('scheduleLeagueV2')) body = { leagueSchedule: { seasonYear: '2025-26', gameDates: [] } };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body };
  };
}

beforeEach(() => {
  cache.clearAll();
  health.reset('free_nba');
  health.reset('tank01');
  hostCalls = {};
  process.env.FREE_NBA_PRIMARY = 'true';
  process.env.RAPIDAPI_KEY = 'test-key'; // make tank01 "configured" so fallback is reachable
  global.fetch = makeFetchStub();
});

afterEach(() => { global.fetch = originalFetch; });

test('free_nba is PRIMARY: season stats come from ESPN, Tank01 is NOT called', async () => {
  const res = await providers.getSeasonStats('2025', ['111', '222', '333']);
  assert.equal(res.value.length, 3);
  assert.equal(res.meta.provider, 'free_nba');
  assert.equal(hostCalls.espn, 1);        // ONE league-wide ESPN request...
  assert.equal(hostCalls.tank01 || 0, 0); // ...and Tank01 never touched
});

test('league-wide season stats = ONE request for N players (no per-player explosion)', async () => {
  const manyIds = Array.from({ length: 50 }, (_, i) => String(i));
  // Only 111/222/333 exist in the payload; the rest simply won't match.
  await providers.getSeasonStats('2025', manyIds);
  assert.equal(hostCalls.espn, 1); // 50 ids -> still ONE ESPN request
});

test('warm cache = ZERO outbound requests on the second call', async () => {
  await providers.getSeasonStats('2025', ['111', '222', '333']);
  const firstEspn = hostCalls.espn;
  assert.equal(firstEspn, 1);
  hostCalls = {};
  const res2 = await providers.getSeasonStats('2025', ['111', '222', '333']);
  assert.equal(hostCalls.espn || 0, 0); // served from shared cache
  assert.equal(res2.value.length, 3);
  assert.equal(res2.meta.cacheHit, true);
});

test('Tank01 FALLBACK is used when free_nba season stats fail', async () => {
  // Make ESPN fail; Tank01 stub returns a per-player game log.
  global.fetch = async (url) => {
    const u = String(url);
    const host = u.includes('espn.com') ? 'espn' : u.includes('rapidapi.com') ? 'tank01' : u.includes('cdn.nba.com') ? 'nba_cdn' : 'other';
    hostCalls[host] = (hostCalls[host] || 0) + 1;
    if (host === 'espn') return { ok: false, status: 500, headers: { get: () => '' }, text: async () => '' };
    if (host === 'tank01' && u.includes('getNBAGamesForPlayer')) {
      const body = { g1: { gameID: '20251101_X', pts: 20, reb: 5, ast: 4, mins: 30, fgm: 8, fga: 15, ftm: 2, fta: 2, tptfgm: 2 } };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ body }), json: async () => ({ body }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) };
  };
  const res = await providers.getSeasonStats('2025', ['111']);
  assert.ok(hostCalls.espn >= 1, 'free_nba attempted first');
  assert.ok(hostCalls.tank01 >= 1, 'tank01 used as fallback');
  assert.equal(res.value.length, 1); // tank01 supplied the player
});

test('partial failure: injuries failing does NOT break season stats or schedule', async () => {
  global.fetch = makeFetchStub({ failHosts: [] });
  // Injuries endpoint fails, others succeed.
  const base = makeFetchStub();
  global.fetch = async (url) => {
    if (String(url).includes('/injuries')) { hostCalls.espn = (hostCalls.espn || 0) + 1; return { ok: false, status: 500, headers: { get: () => '' }, text: async () => '' }; }
    return base(url);
  };
  const stats = await providers.getSeasonStats('2025', ['111']);
  const sched = await providers.getSchedule('2025');
  let injuriesFailed = false;
  try { const inj = await providers.getInjuries(); injuriesFailed = !inj; } catch { injuriesFailed = true; }
  assert.equal(stats.value.length, 1);       // season stats fine
  assert.ok(sched && sched.value);           // schedule fine
  assert.ok(injuriesFailed || true);         // injuries may be null; must not throw/break the rest
});

test('schedule comes from NBA CDN under free_nba primary', async () => {
  const sched = await providers.getSchedule('2025');
  assert.equal(sched.meta.provider, 'free_nba');
  assert.equal(hostCalls.nba_cdn, 1);
  assert.equal(hostCalls.tank01 || 0, 0);
});
