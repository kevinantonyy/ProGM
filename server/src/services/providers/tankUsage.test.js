/**
 * Quota-independent integration test for Tank01 API-usage optimization.
 *
 * Stubs global.fetch to COUNT outbound Tank01 requests per endpoint (no real
 * network / no quota consumed), then drives the REAL provider orchestrator
 * (providers/index.js) + REAL cache + REAL single-flight to prove:
 *   - per-player season stats are cached individually and reused across
 *     different id sets / users / leagues,
 *   - concurrent identical misses coalesce to ONE outbound call,
 *   - a warm cache costs zero outbound calls,
 *   - schedule + player index are fetched once and shared.
 */
import { test, beforeEach } from 'node:test';
import '../dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import * as providers from './index.js';
import { cache, health } from './index.js';
import { resetPlayerFallbackBudget } from './playerFallbackBudget.js';

// --- fetch stub ---------------------------------------------------------------
const calls = { playerList: 0, gamesForPlayer: 0, injuryList: 0, teamSchedule: 0, other: 0 };
function resetCalls() { for (const k of Object.keys(calls)) calls[k] = 0; }

function fakeGameLog(playerId) {
  // Two games so season + recent aggregate to a real per-game line.
  return {
    g1: { gameID: '20251101_BOS@NY', playerID: playerId, pts: 20, reb: 5, ast: 4, stl: 1, blk: 1, TOV: 2, mins: 32, fgm: 8, fga: 15, ftm: 2, fta: 2, tptfgm: 2 },
    g2: { gameID: '20251103_BOS@PHI', playerID: playerId, pts: 24, reb: 7, ast: 6, stl: 2, blk: 0, TOV: 3, mins: 34, fgm: 9, fga: 17, ftm: 4, fta: 5, tptfgm: 2 },
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => ({ statusCode: 200, body }) };
}

const originalFetch = global.fetch;

beforeEach(() => {
  cache.clearAll();
  health.reset('tank01');
  resetPlayerFallbackBudget();
  process.env.PROGM_TANK01_PLAYER_BUDGET = '500'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '500'; // the per-player fallback is OFF by default; these tests exercise it enabled
  resetCalls();
  process.env.RAPIDAPI_KEY = 'test-key'; // make tank01 "configured"
  process.env.PROGM_TANK01_ENABLED = 'true'; // Tank01 is OFF by default; these tests exercise it enabled
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/getNBAPlayerList')) {
      calls.playerList += 1;
      return jsonResponse([{ playerID: '1', longName: 'Player One', team: 'BOS', yahooPlayerID: '111' }, { playerID: '2', longName: 'Player Two', team: 'LAL', yahooPlayerID: '222' }, { playerID: '3', longName: 'Player Three', team: 'NY', yahooPlayerID: '333' }]);
    }
    if (u.includes('/getNBAGamesForPlayer')) {
      calls.gamesForPlayer += 1;
      const id = new URL(u).searchParams.get('playerID');
      return jsonResponse(fakeGameLog(id));
    }
    if (u.includes('/getNBATeamSchedule')) {
      calls.teamSchedule += 1;
      return jsonResponse({ team: 'BOS', schedule: [{ gameID: 'g', gameDate: '20251103', gameStatus: 'scheduled' }] });
    }
    if (u.includes('/getNBAInjuryList')) { calls.injuryList += 1; return jsonResponse([]); }
    calls.other += 1;
    return jsonResponse({});
  };
});

test('per-player season stats: cold fetches each player once', async () => {
  const r = await providers.getSeasonStats('2025', ['1', '2', '3']);
  assert.equal(calls.gamesForPlayer, 3);
  assert.equal(r.value.length, 3);
  assert.equal(r.meta.cacheHit, false);
});

test('warm cache: same players cost ZERO outbound calls', async () => {
  await providers.getSeasonStats('2025', ['1', '2', '3']);
  resetCalls();
  const r = await providers.getSeasonStats('2025', ['1', '2', '3']);
  assert.equal(calls.gamesForPlayer, 0);
  assert.equal(r.value.length, 3);
  assert.equal(r.meta.cacheHit, true);
});

test('overlapping id set (different league/user): only NEW players are fetched', async () => {
  await providers.getSeasonStats('2025', ['1', '2']); // user A / league A
  resetCalls();
  // user B / league B shares players 1,2 and adds 3 -> only player 3 is fetched.
  const r = await providers.getSeasonStats('2025', ['2', '3', '1']);
  assert.equal(calls.gamesForPlayer, 1);
  assert.equal(r.value.length, 3);
});

test('single-flight: concurrent identical player requests coalesce to one call', async () => {
  const [a, b, c] = await Promise.all([
    providers.getSeasonStats('2025', ['1']),
    providers.getSeasonStats('2025', ['1']),
    providers.getSeasonStats('2025', ['1']),
  ]);
  assert.equal(calls.gamesForPlayer, 1); // 3 concurrent callers, ONE Tank01 call
  assert.equal(a.value.length, 1);
  assert.equal(b.value.length, 1);
  assert.equal(c.value.length, 1);
});

test('schedule is fetched once per season and shared (warm = 0)', async () => {
  await providers.getSchedule('2025');
  const firstCalls = calls.teamSchedule;
  assert.ok(firstCalls > 0);
  resetCalls();
  await providers.getSchedule('2025'); // different user, same season
  assert.equal(calls.teamSchedule, 0);
});

test('player index fetched once and shared across seasons-of-same-key', async () => {
  await providers.getPlayerIndex('2025');
  assert.equal(calls.playerList, 1);
  resetCalls();
  await providers.getPlayerIndex('2025');
  assert.equal(calls.playerList, 0);
});

test('no-data player is cached as no-data (not refetched, not fabricated)', async () => {
  // Player with an empty game log returns null; the null result is cached.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/getNBAGamesForPlayer')) { calls.gamesForPlayer += 1; return jsonResponse({}); }
    return jsonResponse([]);
  };
  const r1 = await providers.getSeasonStats('2025', ['99']);
  assert.equal(r1.value.length, 0); // no fabricated stats
  const firstCalls = calls.gamesForPlayer;
  const r2 = await providers.getSeasonStats('2025', ['99']);
  assert.equal(calls.gamesForPlayer, firstCalls); // cached no-data, not refetched
  assert.equal(r2.value.length, 0);
});

test.after(() => { global.fetch = originalFetch; });
