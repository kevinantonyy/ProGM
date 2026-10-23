/**
 * PROGM_TANK01_ENABLED: Tank01 is a paid API and is OFF unless the flag is exactly on/true/1. A RAPIDAPI_KEY alone must never
 * cause a single Tank01 HTTP request, from ANY path. Every test below configures the key AND generous per-player budgets, so
 * it is the switch (not the budget) that is being proven. Mocked fetch only; no network, Yahoo or real credential.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../dataSources/allowAllSourcesForTest.js'; // these tests prove Tank01's own flag with the sources opted in; the policy gate is asserted with explicit env objects below
import * as providers from './index.js';
import { cache, health } from './index.js';
import * as tank from './tank01Provider.js';
import { resetPlayerFallbackBudget } from './playerFallbackBudget.js';
import { buildProjectionContext } from '../fantasy/insights.js';

const originalFetch = global.fetch;
const ENV = ['PROGM_TANK01_ENABLED', 'RAPIDAPI_KEY', 'PROGM_TANK01_PLAYER_BUDGET', 'PROGM_TANK01_PLAYER_DAILY_BUDGET', 'FREE_NBA_PRIMARY', 'NBA_STATS_FALLBACK'];
const SAVED = {};
let hosts; let tankUrls;

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => '' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => ({ statusCode: status, body }) });
const espnPayload = (n) => ({
  categories: [{ name: 'general', names: ['gamesPlayed', 'avgMinutes'] }, { name: 'offensive', names: ['avgPoints'] }],
  athletes: Array.from({ length: n }, (_, i) => ({ athlete: { id: String(i + 1), displayName: `Player ${i + 1}`, teamShortName: 'BOS' }, categories: [{ name: 'general', values: [70, 30] }, { name: 'offensive', values: [20] }] })),
});
const schedulePayload = { leagueSchedule: { seasonYear: '2025-26', gameDates: [{ games: [{ gameDateEst: '2025-10-22T00:00:00Z', gameStatus: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' } }] }] } };
const ids = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

/** @param {{espn?:'ok'|'down', nba?:'ok'|'down', tank?:'ok'|'down'}} mode */
function stub({ espn = 'down', nba = 'down', tankMode = 'ok' } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('rapidapi.com')) { hosts.tank = (hosts.tank || 0) + 1; tankUrls.push(u); return tankMode === 'ok' ? reply([]) : reply('x', 500); }
    if (u.includes('espn.com')) {
      hosts.espn = (hosts.espn || 0) + 1;
      if (espn === 'down') return u.includes('/injuries') ? reply('boom', 500) : reply('<html>blocked</html>');
      return u.includes('/injuries') ? reply({ injuries: [] }) : reply(espnPayload(40));
    }
    if (u.includes('cdn.nba.com')) { hosts.cdn = (hosts.cdn || 0) + 1; return nba === 'down' ? reply('boom', 503) : reply(schedulePayload); }
    hosts.other = (hosts.other || 0) + 1;
    return reply({});
  };
}

beforeEach(() => {
  for (const k of ENV) SAVED[k] = process.env[k];
  cache.clearAll(); health.reset('free_nba'); health.reset('tank01'); resetPlayerFallbackBudget();
  hosts = {}; tankUrls = [];
  // Worst case for the switch: key present AND generous budgets AND the flag unset.
  process.env.RAPIDAPI_KEY = 'test-key';
  process.env.PROGM_TANK01_PLAYER_BUDGET = '1000'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '1000';
  delete process.env.PROGM_TANK01_ENABLED; delete process.env.NBA_STATS_FALLBACK;
  process.env.FREE_NBA_PRIMARY = 'true';
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

test('flag parsing: only on / true / 1 (any case, trimmed) enable Tank01; everything else, including unset, is off', () => {
  for (const v of ['true', 'TRUE', ' on ', '1', 'On']) assert.equal(tank.isEnabled({ PROGM_TANK01_ENABLED: v, PROGM_DATA_TANK01: 'allow' }), true, v);
  for (const v of [undefined, '', ' ', 'false', '0', 'off', 'no', 'yes', 'enabled', 'tru', '2']) assert.equal(tank.isEnabled({ PROGM_TANK01_ENABLED: v, PROGM_DATA_TANK01: 'allow' }), false, String(v));
  assert.equal(tank.isEnabled({}), false);
  assert.equal(tank.isEnabled({ RAPIDAPI_KEY: 'x' }), false, 'a key alone is not consent');
  assert.equal(tank.isEnabled({ PROGM_TANK01_ENABLED: 'true' }), false, 'the flag alone is not enough: the data-source policy must also allow Tank01');
  assert.equal(tank.isEnabled({ PROGM_TANK01_ENABLED: 'true', PROGM_DATA_TANK01: 'true' }), false, 'only the exact value allow counts');
});

test('DEFAULT: the provider is not configured even though a key is present, and status says so', () => {
  assert.equal(tank.isConfigured(), false);
  const status = providers.providerStatus();
  assert.equal(status.tank01.enabled, false);
  assert.equal(status.tank01.configured, false);
  assert.ok(!JSON.stringify(status).includes('test-key'));
});

test('DEFAULT: every Tank01 module function refuses to send anything (the single HTTP choke point)', async () => {
  stub();
  const before = tank.getRequestCount();
  await assert.rejects(tank.getPlayerIndex(), /Tank01 is disabled/);
  await assert.rejects(tank.getSeasonStatsForPlayer('2025', '1'), /Tank01 is disabled/);
  await assert.rejects(tank.getSeasonStats('2025', ['1', '2']).then((r) => { if (r.length === 0) throw new Error('Tank01 is disabled (swallowed per player)'); }), /Tank01 is disabled/);
  await assert.rejects(tank.getInjuries(), /Tank01 is disabled/);
  assert.deepEqual(await tank.getSchedule('2025'), {}, 'schedule swallows per-team errors; it must still send nothing');
  assert.equal(hosts.tank || 0, 0, 'no HTTP request reached the Tank01 host');
  assert.equal(tank.getRequestCount(), before, 'and the request counter did not move');
});

test('DEFAULT: every orchestrated path makes zero Tank01 requests while ESPN and the NBA CDN are DOWN (the fallback situation)', async () => {
  stub({ espn: 'down', nba: 'down' });
  assert.equal(await providers.getPlayerIndex('2025'), null);
  assert.equal(await providers.getInjuries(), null);
  assert.equal(await providers.getSchedule('2025'), null);
  const stats = await providers.getSeasonStats('2025', ids(200));
  assert.deepEqual(stats.value, []);
  assert.equal(await providers.getSeasonStatsBulkOnly('2025', ids(50)), null);
  assert.equal(hosts.tank || 0, 0, `Tank01 URLs hit: ${tankUrls}`);
  assert.ok((hosts.espn || 0) > 0 && (hosts.cdn || 0) > 0, 'the free sources were still tried');
});

test('DEFAULT: the whole projection pipeline (normal and Draft Preview bulk-only) makes zero Tank01 requests', async () => {
  stub({ espn: 'down', nba: 'down' });
  const pool = Array.from({ length: 60 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${i + 1}`, teamAbbr: 'BOS' }));
  const params = { season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true };
  const normal = await buildProjectionContext(params);
  const preview = await buildProjectionContext({ ...params, bulkOnly: true });
  assert.equal(normal.externalAvailable, false);
  assert.equal(preview.externalAvailable, false);
  assert.match(normal.reason, /Tank01 is disabled|ESPN/);
  assert.equal(hosts.tank || 0, 0);
});

test('DEFAULT: even the Tank01-first configuration (FREE_NBA_PRIMARY=false) cannot reach Tank01', async () => {
  process.env.FREE_NBA_PRIMARY = 'false';
  stub({ espn: 'ok', nba: 'ok' });
  assert.ok((await providers.getPlayerIndex('2025')).value.length > 0, 'ESPN is still used (as the last resort)');
  assert.ok(await providers.getInjuries());
  assert.ok(await providers.getSchedule('2025'));
  assert.equal((await providers.getSeasonStats('2025', ids(10))).value.length, 10);
  assert.equal(hosts.tank || 0, 0);
});

test('free sources are NOT affected by the switch: ESPN and the NBA CDN serve everything, Tank01 untouched', async () => {
  stub({ espn: 'ok', nba: 'ok' });
  assert.equal((await providers.getPlayerIndex('2025')).value.length, 40);
  assert.equal((await providers.getSeasonStats('2025', ids(40))).value.length, 40);
  assert.ok(await providers.getInjuries());
  assert.ok(await providers.getSchedule('2025'));
  const pool = Array.from({ length: 40 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${i + 1}`, teamAbbr: 'BOS' }));
  const ctx = await buildProjectionContext({ season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true });
  assert.equal([...ctx.projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length, 40);
  assert.ok((hosts.espn || 0) > 0 && (hosts.cdn || 0) > 0);
  assert.equal(hosts.tank || 0, 0);
});

test('cached free-provider data stays available when the free sources later fail, still with zero Tank01 requests', async () => {
  stub({ espn: 'ok', nba: 'ok' });
  await providers.getPlayerIndex('2025'); await providers.getSeasonStats('2025', ids(40)); await providers.getSchedule('2025');
  stub({ espn: 'down', nba: 'down' });
  assert.equal((await providers.getPlayerIndex('2025')).value.length, 40);
  assert.equal((await providers.getSeasonStats('2025', ids(40))).value.length, 40);
  assert.ok(await providers.getSchedule('2025'));
  // Even after the entries expire, the last good values are served (stale) rather than anything being sent to Tank01.
  for (const key of ['playerIndex:2025', 'seasonStatsAll:2025:free_nba', 'schedule:2025']) {
    const hit = cache.get(key); cache.set(key, hit.value, { provider: hit.meta.provider, ttl: -1 });
  }
  assert.equal((await providers.getPlayerIndex('2025')).value.length, 40);
  assert.equal((await providers.getSeasonStats('2025', ids(40))).value.length, 40);
  assert.equal(hosts.tank || 0, 0);
});

test('the flag set to a non-true value keeps it OFF across the same paths (false, 0, off, junk)', async () => {
  for (const value of ['false', '0', 'off', 'yes', 'enabled']) {
    process.env.PROGM_TANK01_ENABLED = value;
    cache.clearAll(); health.reset('free_nba'); health.reset('tank01');
    stub({ espn: 'down', nba: 'down' });
    await providers.getPlayerIndex('2025'); await providers.getInjuries(); await providers.getSchedule('2025'); await providers.getSeasonStats('2025', ids(20));
    assert.equal(hosts.tank || 0, 0, value);
  }
});

test('ENABLED: Tank01 becomes reachable as a fallback (index, injuries, schedule)', async () => {
  process.env.PROGM_TANK01_ENABLED = 'true';
  assert.equal(tank.isConfigured(), true);
  assert.equal(providers.providerStatus().tank01.enabled, true);
  stub({ espn: 'down', nba: 'down' });
  await providers.getPlayerIndex('2025'); await providers.getInjuries(); await providers.getSchedule('2025');
  const paths = tankUrls.map((u) => new URL(u).pathname);
  assert.ok(paths.includes('/getNBAPlayerList') && paths.includes('/getNBAInjuryList') && paths.some((p) => p === '/getNBATeamSchedule'), `saw ${paths}`);
});

test('ENABLED but key missing: still no request', async () => {
  process.env.PROGM_TANK01_ENABLED = 'true'; delete process.env.RAPIDAPI_KEY;
  assert.equal(tank.isConfigured(), false);
  stub({ espn: 'down', nba: 'down' });
  await providers.getPlayerIndex('2025');
  assert.equal(hosts.tank || 0, 0);
});

test('ENABLED: the per-player budget still applies (default 0 sends no per-player requests; a set limit caps them)', async () => {
  process.env.PROGM_TANK01_ENABLED = 'true';
  const playerPaths = () => tankUrls.filter((u) => u.includes('getNBAGamesForPlayer')).length;
  stub({ espn: 'down', nba: 'down' });
  delete process.env.PROGM_TANK01_PLAYER_BUDGET; delete process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET; resetPlayerFallbackBudget();
  await providers.getSeasonStats('2025', ids(100));
  assert.equal(playerPaths(), 0, 'enabled without budgets = no per-player requests');
  process.env.PROGM_TANK01_PLAYER_BUDGET = '7'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '7'; resetPlayerFallbackBudget();
  await providers.getSeasonStats('2025', ids(100));
  assert.equal(playerPaths(), 7, 'exactly the configured limit');
});

test('ENABLED: Draft Preview (bulkOnly) still never makes per-player requests', async () => {
  process.env.PROGM_TANK01_ENABLED = 'true';
  stub({ espn: 'down', nba: 'down' });
  const pool = Array.from({ length: 80 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Player ${i + 1}`, teamAbbr: 'BOS' }));
  await buildProjectionContext({ season: '2026', players: pool, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true, bulkOnly: true });
  assert.equal(tankUrls.filter((u) => u.includes('getNBAGamesForPlayer')).length, 0);
});

// Tripwire: the claim "the switch covers every Tank01 request path" holds only while Tank01's host is referenced from exactly one
// file and that file has exactly one fetch() call (inside tankFetch, which checks the switch). Add a new Tank01 caller and this fails.
test('tripwire: only tank01Provider.js references the Tank01 host, and it has a single guarded fetch()', () => {
  const serverRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs)$/.test(name) && !/\.test\.(js|mjs)$/.test(name)) files.push(full);
    }
  };
  walk(serverRoot);
  const hostRefs = files.filter((file) => /rapidapi\.com/i.test(readFileSync(file, 'utf8'))).map((file) => relative(serverRoot, file).split(sep).join('/'));
  assert.deepEqual(hostRefs, ['src/services/providers/tank01Provider.js']);
  const source = readFileSync(join(serverRoot, 'src/services/providers/tank01Provider.js'), 'utf8');
  assert.equal((source.match(/(?<![\w.])fetch\(/g) || []).length, 0, 'no raw fetch(): every request goes through the data-source guard');
  assert.equal((source.match(/guardedFetch\(/g) || []).length, 1, 'exactly one outbound HTTP call');
  assert.ok(source.indexOf('if (!isEnabled()) throw') < source.indexOf('guardedFetch('), 'the switch is checked before the request is built');
});
