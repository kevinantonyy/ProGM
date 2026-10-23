/**
 * Orchestrator tests for historical availability (durability source data).
 * Verifies league-wide fetch ONLY (never per-player), one cached request per
 * completed season, and graceful degradation on failure. global.fetch stubbed.
 */
import { test, beforeEach, afterEach } from 'node:test';
import '../dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import * as providers from './index.js';
import { cache, health } from './index.js';

const originalFetch = global.fetch;
let byathleteCalls;
let seasonsRequested;

function byathletePayload() {
  return {
    categories: [{ name: 'general', names: ['gamesPlayed', 'avgMinutes'] }],
    athletes: [
      { athlete: { id: '111', displayName: 'A', teamShortName: 'BOS' }, categories: [{ name: 'general', values: [70, 32] }] },
      { athlete: { id: '222', displayName: 'B', teamShortName: 'LAL' }, categories: [{ name: 'general', values: [55, 30] }] },
      { athlete: { id: '333', displayName: 'Full Season', teamShortName: 'NY' }, categories: [{ name: 'general', values: [82, 20] }] },
    ],
  };
}

beforeEach(() => {
  cache.clearAll();
  health.reset('free_nba');
  health.reset('tank01');
  byathleteCalls = 0;
  seasonsRequested = [];
  process.env.FREE_NBA_PRIMARY = 'true';
  delete process.env.RAPIDAPI_KEY; // free_nba only
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/statistics/byathlete')) {
      byathleteCalls += 1;
      const m = /season=(\d+)/.exec(u);
      if (m) seasonsRequested.push(Number(m[1]));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(byathletePayload()) };
    }
    throw new Error('unexpected non-byathlete fetch: ' + u);
  };
});

afterEach(() => { global.fetch = originalFetch; });

test('fetches last 3 COMPLETED seasons league-wide with ESPN end-year mapping', async () => {
  const res = await providers.getHistoricalAvailability(2025, 3);
  // Yahoo start-years 2024/2023/2022 map to ESPN end-years 2025/2024/2023.
  assert.deepEqual([...seasonsRequested].sort(), [2023, 2024, 2025]);
  assert.equal(byathleteCalls, 3); // exactly one league-wide request per season
  // Keyed by externalId with newest-season-first history rows.
  assert.ok(res.value['111']);
  assert.equal(res.value['111'].length, 3);
  assert.equal(res.value['111'][0].season, 2024);
  assert.equal(res.value['111'][0].gamesPlayed, 70);
  assert.equal(res.value['111'][0].gameTotal, 82);
});

test('warm cache: a second call makes ZERO new requests (completed seasons immutable)', async () => {
  await providers.getHistoricalAvailability(2025, 3);
  const after = byathleteCalls;
  assert.equal(after, 3);
  byathleteCalls = 0;
  await providers.getHistoricalAvailability(2025, 3);
  assert.equal(byathleteCalls, 0); // served from long-lived cache
});

test('request count is independent of player count (never per-player)', async () => {
  // The pool size is irrelevant — history is league-wide. 3 seasons => 3 calls.
  await providers.getHistoricalAvailability(2025, 3);
  assert.equal(byathleteCalls, 3);
});

test('career depth remains one cached bulk request per completed season', async () => {
  await providers.getHistoricalAvailability(2026, 5);
  assert.equal(byathleteCalls, 5);
  assert.deepEqual([...seasonsRequested].sort(), [2022, 2023, 2024, 2025, 2026]);
});

test('graceful: a failing season is omitted, others still returned, never throws', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    byathleteCalls += 1;
    if (u.includes('season=2024')) return { ok: false, status: 500, headers: { get: () => '' }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(byathletePayload()) };
  };
  const res = await providers.getHistoricalAvailability(2025, 3);
  // 2023 failed; 2024 + 2022 survive -> 2 usable seasons for each player.
  assert.equal(res.value['111'].length, 2);
  assert.deepEqual(res.value['111'].map((r) => r.season).sort(), [2022, 2024]);
});

test('2026-27 Wembanyama history maps to verified 2025-26 / 2024-25 / 2023-24 games', async () => {
  global.fetch = async (url) => {
    const endYear = Number(new URL(String(url)).searchParams.get('season'));
    const gamesByEspnYear = { 2026: 64, 2025: 46, 2024: 71 };
    const payload = {
      categories: [{ name: 'general', names: ['gamesPlayed'] }],
      athletes: [
        { athlete: { id: '6580', displayName: 'Victor Wembanyama', teamShortName: 'SA' }, categories: [{ name: 'general', values: [gamesByEspnYear[endYear]] }] },
        { athlete: { id: 'full', displayName: 'Full Season', teamShortName: 'NY' }, categories: [{ name: 'general', values: [82] }] },
      ],
    };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload) };
  };
  const res = await providers.getHistoricalAvailability(2026, 3);
  assert.deepEqual(res.value['6580'], [
    { season: 2025, gamesPlayed: 64, gameTotal: 82 },
    { season: 2024, gamesPlayed: 46, gameTotal: 82 },
    { season: 2023, gamesPlayed: 71, gameTotal: 82 },
  ]);
});

test('total failure returns an empty map (never breaks, never penalizes)', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const res = await providers.getHistoricalAvailability(2025, 3);
  assert.deepEqual(res.value, {});
});
