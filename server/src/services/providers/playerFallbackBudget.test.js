/**
 * Per-player stats fallback budget. Mocked fetch only: ESPN's league-wide feed is "down" (bot-wall HTML) and Tank01 answers
 * (or fails) per player. Nothing here touches the network, Yahoo or any credential.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as providers from './index.js';
import { cache, health } from './index.js';
import { takePlayerFallbackBudget, playerFallbackBudgetStatus, resetPlayerFallbackBudget } from './playerFallbackBudget.js';
import { buildProjectionContext } from '../fantasy/insights.js';

const originalFetch = global.fetch;
const SAVED = {};
const ENV = ['PROGM_TANK01_PLAYER_BUDGET', 'PROGM_TANK01_PLAYER_DAILY_BUDGET', 'RAPIDAPI_KEY', 'FREE_NBA_PRIMARY'];
let tankIds; let tankCalls;

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => '' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => ({ statusCode: status, body }) });
const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

function espnDown() { return reply('<html>Access check</html>'); }
function espnHealthy(n) {
  return reply({
    categories: [{ name: 'general', names: ['gamesPlayed', 'avgMinutes'] }, { name: 'offensive', names: ['avgPoints'] }],
    athletes: Array.from({ length: n }, (_, i) => ({ athlete: { id: String(i + 1), displayName: `Player ${i + 1}`, teamShortName: 'BOS' }, categories: [{ name: 'general', values: [70, 30] }, { name: 'offensive', values: [20] }] })),
  });
}
/** @param {{espn?: Function, tank?: Function}} handlers */
function stub({ espn = espnDown, tank = () => reply({ g1: { gameID: '20251101_A@B', pts: '20', reb: '5', ast: '5', mins: '30' } }) } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('rapidapi.com')) {
      const id = /playerID=([^&]+)/.exec(u)?.[1];
      if (id) { tankIds.push(id); tankCalls += 1; return tank(id); }
      tankCalls += 1; // non-player Tank01 endpoints (lists) are counted too
      return reply([]);
    }
    if (u.includes('byathlete')) return espn();
    if (u.includes('/injuries')) return reply({ injuries: [] });
    return reply({});
  };
}

beforeEach(() => {
  for (const k of ENV) SAVED[k] = process.env[k];
  cache.clearAll(); health.reset('free_nba'); health.reset('tank01'); resetPlayerFallbackBudget();
  tankIds = []; tankCalls = 0;
  process.env.FREE_NBA_PRIMARY = 'true';
  process.env.RAPIDAPI_KEY = 'test-key';
  delete process.env.PROGM_TANK01_PLAYER_BUDGET; delete process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET;
  stub();
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  resetPlayerFallbackBudget();
});

test('budget: defaults are conservative, grants are partial, and windows reset on their own', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(takePlayerFallbackBudget(30, { now: t0, env: {} }), 30);
  assert.equal(takePlayerFallbackBudget(30, { now: t0 + 1000, env: {} }), 20, 'only 20 of the hourly 50 remain');
  assert.equal(takePlayerFallbackBudget(5, { now: t0 + 2000, env: {} }), 0, 'hourly window exhausted');
  const status = playerFallbackBudgetStatus({ now: t0 + 3000, env: {} });
  assert.deepEqual([status.hourly.limit, status.hourly.used, status.daily.limit, status.daily.used, status.exhausted], [50, 50, 200, 50, true]);
  assert.equal(takePlayerFallbackBudget(10, { now: t0 + 61 * 60 * 1000, env: {} }), 10, 'new hour, new budget');
  assert.equal(playerFallbackBudgetStatus({ now: t0 + 61 * 60 * 1000, env: {} }).daily.used, 60, 'the daily cap keeps counting across hours');
});

test('budget: the daily cap binds even when the hourly window has room; env is configurable and junk falls back', () => {
  const t0 = 2_000_000_000_000; const env = { PROGM_TANK01_PLAYER_BUDGET: '100', PROGM_TANK01_PLAYER_DAILY_BUDGET: '120' };
  assert.equal(takePlayerFallbackBudget(100, { now: t0, env }), 100);
  assert.equal(takePlayerFallbackBudget(100, { now: t0 + 61 * 60 * 1000, env }), 20, 'only 20 left of the daily 120');
  for (const bad of ['', ' ', 'abc', '-5', '1.5', 'Infinity']) {
    resetPlayerFallbackBudget();
    assert.equal(takePlayerFallbackBudget(500, { now: t0, env: { PROGM_TANK01_PLAYER_BUDGET: bad } }), 50, `"${bad}" falls back to the default`);
  }
  resetPlayerFallbackBudget();
  assert.equal(takePlayerFallbackBudget(10, { now: t0, env: { PROGM_TANK01_PLAYER_BUDGET: '0' } }), 0, '0 disables the fallback');
});

test('small requests keep working: a handful of uncached players are fetched individually', async () => {
  const result = await providers.getSeasonStats('2025', ids(5));
  assert.equal(result.value.length, 5);
  assert.equal(tankIds.length, 5);
  assert.equal(result.meta.budgetLimited, false);
  assert.equal(playerFallbackBudgetStatus().hourly.used, 5);
});

test('large requests are capped at the budget: 200 uncached players cost exactly 20 Tank01 requests', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '20';
  const result = await providers.getSeasonStats('2025', ids(200));
  assert.equal(tankIds.length, 20);
  assert.equal(new Set(tankIds).size, 20, 'no player is requested twice');
  assert.equal(result.value.length, 20);
  assert.equal(result.meta.budgetLimited, true);
  assert.equal(result.meta.skippedForBudget, 180);
});

test('cache reuse: fetched players are free forever after, even once the budget is exhausted', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '20';
  await providers.getSeasonStats('2025', ids(200));
  const used = playerFallbackBudgetStatus().hourly.used;
  const again = await providers.getSeasonStats('2025', ids(200));
  assert.equal(tankIds.length, 20, 'no new Tank01 requests');
  assert.equal(again.value.length, 20, 'the 20 cached players are still served');
  const cachedOnly = await providers.getSeasonStats('2025', ids(20));
  assert.equal(cachedOnly.value.length, 20);
  assert.equal(cachedOnly.meta.budgetLimited, false);
  assert.equal(playerFallbackBudgetStatus().hourly.used, used, 'cached lookups never spend budget');
});

test('an expired cached value is still served (stale) when the budget is exhausted, with no provider request', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '3';
  await providers.getSeasonStats('2025', ids(3));
  cache.set('seasonStats:2025:2', cache.get('seasonStats:2025:2').value, { provider: 'tank01', ttl: -1 }); // expired
  const result = await providers.getSeasonStats('2025', ids(3));
  assert.equal(tankIds.length, 3, 'no refetch of the expired player');
  assert.equal(result.value.length, 3);
});

test('recovery: when the window resets the fallback fills in more players, one budget at a time', async (t) => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '20';
  const start = Date.now(); let offset = 0;
  t.mock.method(Date, 'now', () => start + offset);
  await providers.getSeasonStats('2025', ids(60));
  assert.equal(tankIds.length, 20);
  offset += 61 * 60 * 1000;
  const next = await providers.getSeasonStats('2025', ids(60));
  assert.equal(tankIds.length, 40, 'a fresh hour buys 20 more lookups');
  assert.equal(next.value.length, 40, 'earlier players come from cache, new ones from Tank01');
  assert.equal(new Set(tankIds).size, 40);
});

test('recovery: once ESPN is healthy again the bulk feed serves everyone and Tank01 is not touched', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '20';
  await providers.getSeasonStats('2025', ids(60));
  const callsDuringOutage = tankCalls;
  health.reset('free_nba');
  stub({ espn: () => espnHealthy(60) });
  const result = await providers.getSeasonStats('2025', ids(60));
  assert.equal(result.value.length, 60);
  assert.equal(tankCalls, callsDuringOutage, 'no further Tank01 requests');
  assert.notEqual(result.meta.budgetLimited, true);
});

test('circuit breaker: a failing Tank01 (quota exhausted) stops after a few attempts instead of firing the whole budget', async () => {
  stub({ tank: () => reply('quota', 429) });
  const result = await providers.getSeasonStats('2025', ids(200));
  assert.equal(result.value.length, 0);
  assert.ok(tankIds.length <= 3 + 4, `breaker should trip after 3 failures plus at most the in-flight workers, saw ${tankIds.length}`);
  const before = tankIds.length;
  await providers.getSeasonStats('2025', ids(200, 500));
  assert.equal(tankIds.length, before, 'while the breaker is open nothing is sent');
});

test('kill switch: a budget of 0 disables the per-player fallback entirely without errors', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '0';
  const result = await providers.getSeasonStats('2025', ids(50));
  assert.deepEqual(result.value, []);
  assert.equal(tankIds.length, 0);
  assert.equal(result.meta.budgetLimited, true);
});

test('no per-player provider configured: nothing is requested and no budget is spent', async () => {
  delete process.env.RAPIDAPI_KEY;
  const result = await providers.getSeasonStats('2025', ids(30));
  assert.deepEqual(result.value, []);
  assert.equal(tankCalls, 0);
  assert.equal(playerFallbackBudgetStatus().hourly.used, 0);
});

test('Draft Preview (bulkOnly) never makes or budgets per-player requests, however large the pool', async () => {
  const pool = Array.from({ length: 300 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${i + 1}`, teamAbbr: 'BOS' }));
  stub({ espn: espnDown });
  const down = await buildProjectionContext({ season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true, bulkOnly: true });
  assert.equal(down.externalAvailable, false);
  assert.equal(tankIds.length, 0);
  assert.equal(playerFallbackBudgetStatus().hourly.used, 0);
  // Index healthy, stats feed down: still no per-player lookups.
  let n = 0; stub({ espn: () => (++n === 1 ? espnHealthy(300) : espnDown()) });
  health.reset('free_nba'); cache.clearAll();
  const partial = await buildProjectionContext({ season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true, bulkOnly: true });
  assert.equal(tankIds.length, 0, 'no /getNBAGamesForPlayer requests');
  assert.equal(playerFallbackBudgetStatus().hourly.used, 0);
  assert.match(partial.reason, /does not use slower per-player lookups/);
});

test('the normal path reports when the budget limited it, so the UI/diagnostics can say why', async () => {
  process.env.PROGM_TANK01_PLAYER_BUDGET = '2';
  let n = 0; stub({ espn: () => (++n === 1 ? espnHealthy(10) : espnDown()) });
  const pool = Array.from({ length: 10 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${i + 1}`, teamAbbr: 'BOS' }));
  const ctx = await buildProjectionContext({ season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true });
  assert.equal(tankIds.length, 2);
  assert.equal(ctx.diagnostic.sources.statsBudgetLimited, true);
  assert.equal([...ctx.projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length, 2);
});

test('provider status exposes the budget (limits and usage only, no keys)', () => {
  const status = providers.providerStatus();
  assert.deepEqual(Object.keys(status.tank01.playerBudget).sort(), ['daily', 'exhausted', 'hourly']);
  assert.equal(status.tank01.playerBudget.hourly.limit, 50);
  assert.ok(!JSON.stringify(status).includes('test-key'));
});
