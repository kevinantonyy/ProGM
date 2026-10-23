/**
 * Disabled data sources make ZERO external requests: not from any provider function, not from the orchestrator (even with Tank01's own
 * flag, a RapidAPI key and the NBA.com fallback flag all set), not when cached data exists, and not in a freshly started process.
 * Deliberately does NOT import allowAllSourcesForTest.js: this file proves the default. Mocked fetch only; no network.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as providers from './index.js';
import { cache } from './index.js';
import * as free from './freeNbaProvider.js';
import nbaStats from './nbaStatsProvider.js';
import tank, { getRequestCount as tankRequestCount } from './tank01Provider.js';
import { probeFreeNbaSources } from './freeNbaProbe.js';
import { probeEspnSeasonStats } from './espnStatsProbe.js';
import { DATA_SOURCES, isSourceDisabledError } from '../dataSources/policy.js';

const SOURCE_ENVS = Object.values(DATA_SOURCES).map((s) => s.env);
const OTHER_ENVS = ['PROGM_TANK01_ENABLED', 'RAPIDAPI_KEY', 'NBA_STATS_FALLBACK', 'FREE_NBA_PRIMARY', 'PROGM_TANK01_PLAYER_BUDGET', 'PROGM_TANK01_PLAYER_DAILY_BUDGET'];
const ALL_ENVS = [...SOURCE_ENVS, ...OTHER_ENVS];
const originalFetch = globalThis.fetch;
const saved = {};
let requests;

const ok = (body = {}) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });
function stubFetch() {
  requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return ok({ athletes: [], categories: [], injuries: [], leagueSchedule: { gameDates: [] }, body: [] }); };
}
const hostsOf = () => [...new Set(requests.map((u) => new URL(u).hostname))];

beforeEach(() => {
  for (const k of ALL_ENVS) saved[k] = process.env[k];
  for (const k of ALL_ENVS) delete process.env[k];
  cache.clearAll();
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ALL_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  cache.clearAll();
});

// Worst case for "silent fallback": every other opt-in is set, only the data-source policy stands in the way.
const setEveryOtherFlag = () => {
  process.env.PROGM_TANK01_ENABLED = 'true';
  process.env.RAPIDAPI_KEY = 'test-key';
  process.env.NBA_STATS_FALLBACK = 'true';
  process.env.PROGM_TANK01_PLAYER_BUDGET = '1000'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '1000';
};

async function callEveryOrchestratorFunction() {
  const out = {};
  out.index = await providers.getPlayerIndex(2025);
  out.stats = await providers.getSeasonStats(2025, ['1', '2', '3']);
  out.statsBulkOnly = await providers.getSeasonStatsBulkOnly(2025, ['1', '2']);
  out.rebounds = await providers.getSeasonReboundSplits(2025);
  out.recent = await providers.getRecentForm(2025);
  out.injuries = await providers.getInjuries();
  out.schedule = await providers.getSchedule(2025);
  out.history = await providers.getHistoricalAvailability(2026, 3);
  return out;
}

test('DEFAULT: no orchestrator function makes a request, with Tank01 flag + key and the NBA.com fallback flag all set', async () => {
  setEveryOtherFlag();
  for (const primary of [undefined, 'true', 'false']) {
    if (primary === undefined) delete process.env.FREE_NBA_PRIMARY; else process.env.FREE_NBA_PRIMARY = primary;
    const out = await callEveryOrchestratorFunction();
    assert.deepEqual(requests, [], `FREE_NBA_PRIMARY=${primary}: no request to anyone`);
    assert.equal(out.index, null); assert.equal(out.injuries, null); assert.equal(out.schedule, null); assert.equal(out.recent, null);
    assert.equal(out.rebounds, null); assert.equal(out.statsBulkOnly, null);
    assert.deepEqual(out.stats.value, [], 'no stats, nothing invented');
    assert.deepEqual(out.history.value, {});
  }
  assert.equal(providers.externalDataAvailable(), false);
  const status = providers.providerStatus();
  assert.deepEqual(status.dataSources, { espn: { allowed: false }, nba_com: { allowed: false }, tank01: { allowed: false } });
  assert.equal(status.free_nba.configured, false);
  assert.equal(status.tank01.configured, false);
});

test('no silent substitution: ESPN off never falls back to NBA.com or Tank01, whatever else is configured', async () => {
  setEveryOtherFlag();
  await callEveryOrchestratorFunction();
  assert.deepEqual(hostsOf(), []);
  // Allowing ONE source only ever contacts that source's hosts.
  process.env.PROGM_DATA_TANK01 = 'allow';
  await providers.getPlayerIndex(2025);
  await providers.getInjuries();
  assert.ok(requests.length > 0, 'Tank01 is reachable once explicitly allowed (it also needs its own flag and key)');
  assert.deepEqual(hostsOf(), ['tank01-fantasy-stats.p.rapidapi.com'], 'and nothing else: no ESPN, no NBA.com');
});

test('cached data exists: entries stored while a source was allowed are not served after it is disabled, and no request is made', async () => {
  process.env.PROGM_DATA_ESPN = 'allow'; process.env.PROGM_DATA_NBA_COM = 'allow'; process.env.PROGM_DATA_TANK01 = 'allow';
  const entries = [
    ['playerIndex:2025', [{ externalId: '1', name: 'A' }], 'free_nba'],
    ['injuries:nba', [{ externalId: '1', designation: 'Out' }], 'free_nba'],
    ['schedule:2025', { BOS: [{ gameDate: '20251022', completed: false }] }, 'free_nba'],
    ['seasonStatsAll:2025:free_nba', [{ externalId: '1', season: {} }], 'free_nba'],
    ['seasonReboundSplits:2025:nba_stats', { 1: {} }, 'nba_stats'],
    ['seasonStats:2025:1', { externalId: '1', season: {} }, 'tank01'],
    ['recentForm:2025:free_nba', { 1: {} }, 'free_nba'],
    ['gamesPlayed:2025:free_nba', { 1: 70 }, 'free_nba'],
  ];
  for (const [key, value, provider] of entries) cache.set(key, value, { provider, ttl: 60 * 60 * 1000 });
  assert.equal(cache.size(), entries.length, 'precondition: cached while allowed');
  assert.equal((await providers.getInjuries())?.meta?.cacheHit, true, 'served from cache while allowed');
  requests.length = 0;

  for (const k of SOURCE_ENVS) delete process.env[k]; // the sources are now disabled
  setEveryOtherFlag();
  const out = await callEveryOrchestratorFunction();
  assert.deepEqual(requests, [], 'no request');
  assert.equal(out.index, null); assert.equal(out.injuries, null); assert.equal(out.schedule, null); assert.equal(out.recent, null); assert.equal(out.rebounds, null);
  assert.deepEqual(out.stats.value, []); assert.deepEqual(out.history.value, {});
  for (const [key] of entries) assert.equal(cache.get(key), null, `${key} is not served`);
  assert.equal(cache.size(), 0, 'and the entries were released from memory');
});

test('every provider network function throws SourceDisabledError BEFORE any request or counter when its source is off', async () => {
  setEveryOtherFlag();
  const before = free.getRequestCount();
  const tankBefore = tankRequestCount();
  const freeCalls = [
    () => free.getPlayerIndex(2025), () => free.getSeasonStatsBulk(2025), () => free.getSeasonStats(2025), () => free.getSeasonGamesPlayed(2025),
    () => free.getSchedule(2025), () => free.getScheduleWithIds(2025), () => free.getInjuries(), () => free.getBoxscore('0022500001'), () => free.getRecentForm(2025),
  ];
  for (const call of freeCalls) await assert.rejects(call, (e) => isSourceDisabledError(e), String(call));
  assert.equal(free.getRequestCount(), before, 'request counters untouched: nothing was attempted');
  await assert.rejects(() => nbaStats.getPlayerIndex(2025), isSourceDisabledError);
  await assert.rejects(() => nbaStats.getSeasonReboundSplits(2025), isSourceDisabledError);
  await assert.rejects(() => tank.getPlayerIndex(), /disabled/);
  await assert.rejects(() => tank.getInjuries(), /disabled/);
  assert.equal(tankRequestCount(), tankBefore, 'Tank01 counter untouched');
  assert.deepEqual(requests, []);
  assert.equal(free.isConfigured(), false);
  assert.equal(tank.isConfigured(), false);
  assert.equal(nbaStats.isConfigured(), false);
});

test('diagnostic probes report "source_disabled" and make no request', async () => {
  const probed = await probeFreeNbaSources();
  assert.equal(probed.results.length, 3);
  for (const r of probed.results) { assert.equal(r.kind, 'source_disabled'); assert.equal(r.ok, false); assert.equal(r.status, null); }
  await assert.rejects(() => probeEspnSeasonStats({ leagueSeason: 2026 }), isSourceDisabledError);
  const injected = []; // even an injected fetch must not be used
  await assert.rejects(() => probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: async (u) => { injected.push(u); return ok(); } }), isSourceDisabledError);
  assert.deepEqual(injected, []);
  assert.deepEqual(requests, []);
});

test('Yahoo-only mode: the projection context reports no source, plainly, and makes no request', async () => {
  setEveryOtherFlag();
  const { buildProjectionContext } = await import('../fantasy/insights.js');
  const players = [{ playerKey: '466.p.1', name: 'Some Player', teamAbbr: 'BOS', eligiblePositions: ['PG'], yahooId: '1' }];
  const ctx = await buildProjectionContext({ season: '2026', players, statCategories: [{ statId: 12, enabled: true, pointValue: 1 }], scoringSupported: true });
  assert.equal(ctx.externalAvailable, false);
  assert.equal(ctx.projectionByCanonicalId.size, 0, 'no projections are invented');
  assert.match(ctx.reason, /no permitted player-statistics source/i);
  assert.match(ctx.reason, /Yahoo league, roster, standings and ownership information is still shown/);
  assert.deepEqual(requests, []);
});

test('AFTER STARTUP: a freshly started process with default settings makes zero external requests from every path', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const url = (rel) => pathToFileURL(path.join(here, rel)).href;
  const script = `
    const requests = [];
    globalThis.fetch = async (u) => { requests.push(String(u)); throw new Error('unexpected request ' + u); };
    const providers = await import(${JSON.stringify(url('./index.js'))});
    const probe = await import(${JSON.stringify(url('./freeNbaProbe.js'))});
    const { buildProjectionContext } = await import(${JSON.stringify(url('../fantasy/insights.js'))});
    await providers.getPlayerIndex(2025); await providers.getSeasonStats(2025, ['1']); await providers.getSeasonStatsBulkOnly(2025, ['1']);
    await providers.getSeasonReboundSplits(2025); await providers.getRecentForm(2025); await providers.getInjuries(); await providers.getSchedule(2025);
    await providers.getHistoricalAvailability(2026, 3); await probe.probeFreeNbaSources();
    const ctx = await buildProjectionContext({ season: '2026', players: [{ playerKey: '466.p.1', name: 'X', teamAbbr: 'BOS', eligiblePositions: ['PG'] }], statCategories: [], scoringSupported: true });
    console.log(JSON.stringify({ requests, available: providers.externalDataAvailable(), ctxAvailable: ctx.externalAvailable }));
    process.exit(0);`;
  const env = { ...process.env, PROGM_TANK01_ENABLED: 'true', RAPIDAPI_KEY: 'test-key', NBA_STATS_FALLBACK: 'true' };
  for (const k of SOURCE_ENVS) delete env[k];
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { requests: [], available: false, ctxAvailable: false });
});
