/**
 * Full-pool Rankings (PROGM_RANKINGS_FULL_POOL) through the REAL workspace builder with Yahoo-shaped mocked responses and a mocked
 * ESPN feed. No network, no credentials, no Tank01. Covers: ownership, injured and unranked players, one global rank that ownership
 * cannot move, partial-pool honesty, waiver isolation, request count, flag-off compatibility, and non-postdraft behaviour.
 */
import { test, beforeEach, afterEach } from 'node:test';
import '../dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import { buildBasketballWorkspace } from './basketballWorkspace.js';
import { assembleLeaguePool } from './leaguePool.js';
import { buildDraftBoard } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { normalizeLeagueSettings } from './normalize.js';
import * as providers from '../providers/index.js';

const LK = '466.l.12345';
const T1 = `${LK}.t.1`; const T2 = `${LK}.t.2`; const T3 = `${LK}.t.3`;
const NAMES = { [T1]: 'My Team', [T2]: 'Team Two', [T3]: 'Team Three' };

const STATS = [[4, 'FGM', 1], [3, 'FGA', -0.45], [7, 'FTM', 1], [6, 'FTA', -0.75], [10, '3PTM', 3], [12, 'PTS', 0.5], [15, 'REB', 1.5], [16, 'AST', 2], [17, 'ST', 3], [18, 'BLK', 3], [19, 'TO', -2]];
const settingsResponse = (draftStatus = 'postdraft', numTeams = 3) => ({ fantasy_content: { league: [
  { league_key: LK, season: '2026', num_teams: numTeams, draft_status: draftStatus },
  { settings: {
    scoring_type: 'headpoint',
    roster_positions: [{ roster_position: { position: 'PG', count: 2, is_starting_position: 1 } }, { roster_position: { position: 'C', count: 1, is_starting_position: 1 } }, { roster_position: { position: 'BN', count: 3, is_starting_position: 0 } }],
    stat_categories: { stats: STATS.map(([id, abbr]) => ({ stat: { stat_id: String(id), name: abbr, abbr, enabled: '1' } })) },
    stat_modifiers: { stats: STATS.map(([id, , value]) => ({ stat: { stat_id: String(id), value: String(value) } })) },
  } },
] } });
const standingsResponse = () => ({ fantasy_content: { league: [{ league_key: LK }, { standings: { teams: Object.fromEntries([[T1, 1], [T2, 2], [T3, 3]].map(([key, rank], i) => [String(i), { team: [[{ team_key: key }, { team_id: String(rank) }, { name: NAMES[key] }, ...(key === T1 ? [{ is_owned_by_current_login: 1 }] : [])], { team_standings: { rank, outcome_totals: { wins: 5, losses: 3, ties: 0 } } }] }])) } }] } });
const props = (id, name, status = null) => [{ player_key: `466.p.${id}` }, { player_id: String(id) }, { name: { full: name } }, { editorial_team_abbr: 'Bos' }, { eligible_positions: [{ position: 'PG' }] }, ...(status ? [{ status }] : [])];
const rosterResponse = (players) => ({ fantasy_content: { team: [[{ team_key: 'x' }], { roster: { 0: { players: Object.fromEntries([['count', players.length], ...players.map((p, i) => [String(i), { player: [props(p.id, p.name, p.status), { selected_position: [{ coverage_type: 'date' }, { position: 'BN' }] }] }])]) } } }] } });
const playersPage = (players) => ({ fantasy_content: { league: [{ league_key: LK }, { players: Object.fromEntries([['count', players.length], ...players.map((p, i) => [String(i), { player: [props(p.id, p.name, p.status)] }])]) }] } });

// ESPN knows Player 1..12 (distinct, decreasing production). "Rookie Nobody" and "Two Way Guy" have no NBA stat line.
const CATS = {
  general: ['gamesPlayed', 'avgMinutes', 'avgFouls', 'flagrantFouls', 'technicalFouls', 'ejections', 'doubleDouble', 'tripleDouble', 'minutes', 'rebounds', 'fouls', 'avgRebounds'],
  offensive: ['avgPoints', 'avgFieldGoalsMade', 'avgFieldGoalsAttempted', 'fieldGoalPct', 'avgThreePointFieldGoalsMade', 'avgThreePointFieldGoalsAttempted', 'threePointFieldGoalPct', 'avgFreeThrowsMade', 'avgFreeThrowsAttempted', 'freeThrowPct', 'avgAssists', 'avgTurnovers', 'points', 'fieldGoalsMade', 'fieldGoalsAttempted', 'threePointFieldGoalsMade', 'threePointFieldGoalsAttempted', 'freeThrowsMade', 'freeThrowsAttempted', 'assists', 'turnovers'],
  defensive: ['avgSteals', 'avgBlocks', 'steals', 'blocks'],
};
const espnPayload = () => ({
  categories: Object.entries(CATS).map(([name, names]) => ({ name, names })),
  athletes: Array.from({ length: 12 }, (_, i) => {
    const v = { gamesPlayed: 70, avgMinutes: 30, avgFouls: 2, avgRebounds: 8 - i * 0.4, avgPoints: 26 - i * 1.5, avgFieldGoalsMade: 9 - i * 0.4, avgFieldGoalsAttempted: 18 - i * 0.5, avgThreePointFieldGoalsMade: 2, avgFreeThrowsMade: 5, avgFreeThrowsAttempted: 6, avgAssists: 6 - i * 0.3, avgTurnovers: 2.5, avgSteals: 1.1, avgBlocks: 0.7 };
    return { athlete: { id: String(100 + i), displayName: `Player ${i + 1}`, teamShortName: 'BOS' }, categories: Object.entries(CATS).map(([cat, names]) => ({ name: cat, values: names.map((n) => v[n] ?? 0) })) };
  }),
});

// Default world: mine = 1,2,3 | Team Two = 4,5(INJ),6 | Team Three = 7,8 + Two Way Guy | available = 9,10(O),11,12 + Rookie Nobody
const world = (o = {}) => ({
  mine: [{ id: 1, name: 'Player 1' }, { id: 2, name: 'Player 2' }, { id: 3, name: 'Player 3' }],
  [T2]: [{ id: 4, name: 'Player 4' }, { id: 5, name: 'Player 5', status: 'INJ' }, { id: 6, name: 'Player 6' }],
  [T3]: [{ id: 7, name: 'Player 7' }, { id: 8, name: 'Player 8' }, { id: 90, name: 'Two Way Guy' }],
  available: [{ id: 9, name: 'Player 9' }, { id: 10, name: 'Player 10', status: 'O' }, { id: 11, name: 'Player 11' }, { id: 12, name: 'Player 12' }, { id: 91, name: 'Rookie Nobody' }],
  ...o,
});

const originalFetch = global.fetch;
const SAVED = {};
const ENV = ['PROGM_RANKINGS_FULL_POOL', 'PROGM_DRAFT_STATUS', 'PROGM_TANK01_ENABLED', 'RAPIDAPI_KEY'];
let paths; let hosts;
beforeEach(() => {
  for (const k of ENV) SAVED[k] = process.env[k];
  delete process.env.PROGM_RANKINGS_FULL_POOL; delete process.env.PROGM_DRAFT_STATUS; delete process.env.PROGM_TANK01_ENABLED;
  providers.cache.clearAll(); providers.health.reset('free_nba');
  paths = []; hosts = [];
  global.fetch = async (url) => {
    const u = String(url); hosts.push(new URL(u).host);
    const reply = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/statistics/byathlete')) return reply(espnPayload());
    if (u.includes('/injuries')) return reply({ injuries: [] });
    return reply({});
  };
});
afterEach(() => { global.fetch = originalFetch; for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

/** Run the real builder against the mocked league. */
async function run({ flag = false, status = 'postdraft', w = world(), failRoster = null, availableFails = false, endlessAvailable = false, numTeams = 3 } = {}) {
  if (flag) process.env.PROGM_RANKINGS_FULL_POOL = 'on';
  providers.cache.clearAll(); providers.health.reset('free_nba'); paths = [];
  const yahooFantasy = async (path) => {
    paths.push(path);
    if (path === `/league/${LK}/settings`) return settingsResponse(status, numTeams);
    if (path === `/league/${LK}/standings`) return standingsResponse();
    const roster = /^\/team\/(.+)\/roster\/players$/.exec(path);
    if (roster) {
      if (roster[1] === failRoster) throw new Error('Yahoo roster failure');
      return rosterResponse(roster[1] === T1 ? w.mine : w[roster[1]]);
    }
    if (path.includes('players;status=A')) {
      if (availableFails) throw new Error('Yahoo players failure');
      const start = Number(/start=(\d+)/.exec(path)[1]);
      if (endlessAvailable) return playersPage(Array.from({ length: 25 }, (_, i) => ({ id: 1000 + start + i, name: `Filler ${start + i}` })));
      return playersPage(w.available.slice(start, start + 25));
    }
    if (path.includes('player_keys=')) return playersPage([]);
    return { fantasy_content: {} };
  };
  return buildBasketballWorkspace({ yahooFantasy, accessToken: 'synthetic', leagueKey: LK, teamKey: T1, userId: 1 });
}
const rowsByName = (ws) => Object.fromEntries(ws.rankings.players.map((p) => [p.name, p]));
const AVAILABLE_NAMES = ['Player 9', 'Player 10', 'Player 11', 'Player 12', 'Rookie Nobody'];

test('FLAG OFF: Rankings is exactly the old available-only list (injured hidden, no pool, no ownership fields), draft pool unchanged', async () => {
  const ws = await run({ flag: false });
  const names = ws.rankings.players.map((p) => p.name).sort();
  assert.deepEqual(names, ['Player 11', 'Player 12', 'Player 9', 'Rookie Nobody'], 'owned players absent and injured Player 10 hidden, as before');
  assert.equal(ws.rankings.pool, undefined);
  for (const row of ws.rankings.players) for (const field of ['availability', 'ownerTeam', 'ownerTeamKey', 'ownedByMe', 'rankStatus', 'unrankedReason']) assert.equal(field in row, false, field);
  assert.equal(ws.rankings.rankScope, 'available_players');
});

test('FLAG ON but the draft is not completed (predraft / drafting): behaviour is unchanged', async () => {
  for (const status of ['predraft', 'drafting']) {
    const ws = await run({ flag: true, status });
    assert.equal(ws.rankings.pool, undefined, status);
    assert.deepEqual(ws.rankings.players.map((p) => p.name).sort(), ['Player 11', 'Player 12', 'Player 9', 'Rookie Nobody'], status);
  }
});

test('FLAG ON, completed draft: every available, owned (mine and other teams), injured and unranked player is listed, once each', async () => {
  const ws = await run({ flag: true });
  assert.equal(ws.rankings.players.length, 14);
  assert.equal(new Set(ws.rankings.players.map((p) => p.playerKey)).size, 14);
  const r = rowsByName(ws);
  assert.deepEqual([r['Player 1'].availability, r['Player 1'].ownedByMe, r['Player 1'].ownerTeam], ['mine', true, 'My Team']);
  assert.deepEqual([r['Player 4'].availability, r['Player 4'].ownedByMe, r['Player 4'].ownerTeam, r['Player 4'].ownerTeamKey], ['rostered', false, 'Team Two', T2]);
  assert.deepEqual([r['Player 7'].availability, r['Player 7'].ownerTeam], ['rostered', 'Team Three']);
  assert.deepEqual([r['Player 9'].availability, r['Player 9'].ownedByMe, r['Player 9'].ownerTeam], ['available', false, null]);
  // Injury is Yahoo's status field, separate from availability/ownership.
  assert.deepEqual([r['Player 5'].status, r['Player 5'].availability], ['INJ', 'rostered']);
  assert.deepEqual([r['Player 10'].status, r['Player 10'].availability], ['O', 'available']);
  assert.equal(ws.rankings.pool.complete, true);
  assert.equal(ws.rankings.rankScope, 'full_pool');
  assert.deepEqual(ws.rankings.pool.counts, { total: 14, available: 5, rostered: 6, mine: 3, teamsExpected: 3, teamsLoaded: 3, failedRosters: 0, duplicateOwnership: 0, availableAlsoRostered: 0 });
  assert.match(ws.rankings.pool.limitations[0], /cannot prove that no other Yahoo-eligible player exists/);
});

test('unranked players stay visible with a reason and NO invented projection; ranked players have one unique global rank', async () => {
  const ws = await run({ flag: true });
  const r = rowsByName(ws);
  for (const name of ['Rookie Nobody', 'Two Way Guy']) {
    assert.equal(r[name].rankStatus, 'unranked', name);
    assert.equal(r[name].projected, null, name);
    assert.equal(r[name].projectionKnown, false, name);
    assert.ok(r[name].overallRank == null, name);
    assert.match(r[name].unrankedReason, /No NBA stat line/, name);
  }
  const ranked = ws.rankings.players.filter((p) => p.rankStatus === 'ranked');
  assert.equal(ranked.length, 12);
  assert.deepEqual(ranked.map((p) => p.overallRank).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(ranked.every((p) => Number.isFinite(p.projected) && p.unrankedReason === null));
  // Unranked rows come after every ranked row in the default order.
  const order = ws.rankings.players.map((p) => p.rankStatus);
  assert.equal(order.lastIndexOf('ranked') < order.indexOf('unranked'), true);
});

test('the global rank follows production only: it matches the stat ordering and is not moved by who owns a player', async () => {
  const ws = await run({ flag: true });
  const r = rowsByName(ws);
  // Player 1 is the most productive ... Player 12 the least (ESPN fixture), regardless of owner or availability.
  for (let i = 1; i < 12; i += 1) assert.ok(r[`Player ${i}`].overallRank < r[`Player ${i + 1}`].overallRank, `Player ${i} outranks Player ${i + 1}`);
  // Re-own everyone differently: every player's rank is identical.
  const shuffled = world({ mine: [{ id: 12, name: 'Player 12' }, { id: 2, name: 'Player 2' }, { id: 5, name: 'Player 5', status: 'INJ' }], [T2]: [{ id: 1, name: 'Player 1' }, { id: 4, name: 'Player 4' }, { id: 6, name: 'Player 6' }], [T3]: [{ id: 9, name: 'Player 9' }, { id: 8, name: 'Player 8' }, { id: 90, name: 'Two Way Guy' }], available: [{ id: 3, name: 'Player 3' }, { id: 7, name: 'Player 7' }, { id: 10, name: 'Player 10', status: 'O' }, { id: 11, name: 'Player 11' }, { id: 91, name: 'Rookie Nobody' }] });
  const ws2 = await run({ flag: true, w: shuffled });
  const ranks = (x) => Object.fromEntries(x.rankings.players.map((p) => [p.name, p.overallRank ?? null]));
  assert.deepEqual(ranks(ws2), ranks(ws));
  assert.equal(rowsByName(ws2)['Player 12'].availability, 'mine');
  assert.equal(rowsByName(ws2)['Player 1'].availability, 'rostered');
});

test('WAIVERS stay strictly available-only: no owned player (mine or another team) appears in any waiver list', async () => {
  for (const flag of [false, true]) {
    const ws = await run({ flag });
    const w = ws.waivers;
    assert.equal(w.projectionsAvailable, true);
    const keys = new Set([...(w.bestAvailable || []), ...(w.bestFit || []), ...(w.players || []), ...(w.addDrop || []).map((m) => m.add)].filter(Boolean).map((p) => p.playerKey));
    assert.ok(keys.size > 0, `waivers produced results (flag ${flag})`);
    const owned = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '90'].map((id) => `466.p.${id}`));
    for (const key of keys) assert.equal(owned.has(key), false, `owned ${key} leaked into waivers (flag ${flag})`);
    const availableKeys = new Set(['9', '10', '11', '12', '91'].map((id) => `466.p.${id}`));
    for (const key of keys) assert.ok(availableKeys.has(key), `${key} is not an available player (flag ${flag})`);
  }
  // Waivers are identical with the flag on and off.
  const off = await run({ flag: false }); const on = await run({ flag: true });
  const sig = (ws) => JSON.stringify([(ws.waivers.bestAvailable || []).map((p) => [p.playerKey, p.projected]), (ws.waivers.bestFit || []).map((p) => p.playerKey)]);
  assert.equal(sig(on), sig(off));
});

test('PARTIAL POOL: a failed roster request is reported (not treated as empty), the rank is labelled partial, and the rest is still listed', async () => {
  const ws = await run({ flag: true, failRoster: T3 });
  assert.equal(ws.rankings.pool.complete, false);
  assert.match(ws.rankings.pool.reasons.join(' '), /roster could not be loaded for Team Three/);
  assert.equal(ws.rankings.pool.counts.failedRosters, 1);
  assert.equal(ws.rankings.rankScope, 'partial_pool');
  const names = ws.rankings.players.map((p) => p.name);
  assert.ok(!names.includes('Player 7') && names.includes('Player 4') && names.includes('Player 9'));
});

test('PARTIAL POOL: a roster that loads but is empty is a different, also-reported problem', async () => {
  const ws = await run({ flag: true, w: world({ [T3]: [] }) });
  assert.equal(ws.rankings.pool.complete, false);
  assert.match(ws.rankings.pool.reasons.join(' '), /roster for Team Three came back with no players/);
  assert.equal(ws.rankings.pool.counts.failedRosters, 0);
  assert.equal(ws.rankings.rankScope, 'partial_pool');
});

test('PARTIAL POOL: the available-player list failing, or being capped, is reported and never labelled full', async () => {
  const down = await run({ flag: true, availableFails: true });
  assert.equal(down.rankings.pool.complete, false);
  assert.match(down.rankings.pool.reasons.join(' '), /available players could not be loaded/);
  assert.equal(down.rankings.rankScope, 'partial_pool');
  assert.ok(down.rankings.players.some((p) => p.name === 'Player 4'), 'owned players are still ranked');
  const capped = await run({ flag: true, endlessAvailable: true });
  assert.equal(capped.rankings.pool.complete, false);
  assert.match(capped.rankings.pool.reasons.join(' '), /reached the 1000-player limit/);
  assert.equal(capped.rankings.rankScope, 'partial_pool');
  assert.ok(capped.rankings.players.length > 200, 'no silent top-200 cap in full-pool mode');
});

test('PARTIAL POOL: duplicate ownership is detected, one row is kept, and the pool is not complete', async () => {
  const ws = await run({ flag: true, w: world({ [T3]: [{ id: 7, name: 'Player 7' }, { id: 4, name: 'Player 4' }, { id: 90, name: 'Two Way Guy' }] }) });
  assert.equal(ws.rankings.pool.complete, false);
  assert.match(ws.rankings.pool.reasons.join(' '), /appears on more than one team roster/);
  assert.equal(ws.rankings.players.filter((p) => p.name === 'Player 4').length, 1);
  assert.equal(rowsByName(ws)['Player 4'].ownerTeam, 'Team Two');
});

test('league size mismatch (standings vs Yahoo settings) makes the pool partial', async () => {
  const ws = await run({ flag: true, numTeams: 4 });
  assert.equal(ws.rankings.pool.complete, false);
  assert.match(ws.rankings.pool.reasons.join(' '), /standings listed 3 of 4 teams/);
});

test('Yahoo request cost: full-pool mode adds exactly ONE request (the end-of-list probe); rosters are reused, not refetched', async () => {
  await run({ flag: false });
  const off = [...paths];
  await run({ flag: true });
  const on = [...paths];
  assert.equal(on.length - off.length, 1, `off=${off.length} on=${on.length}`);
  const rosterCalls = (list) => list.filter((p) => /\/roster\/players$/.test(p)).length;
  assert.equal(rosterCalls(on), rosterCalls(off), 'no extra roster requests');
  assert.equal(rosterCalls(on), 3);
  const extra = on.filter((p) => !off.includes(p) || on.filter((x) => x === p).length > off.filter((x) => x === p).length);
  assert.ok(extra.every((p) => p.includes('players;status=A') && p.includes('start=25')), `the extra request is the available-list probe: ${extra}`);
});

test('rankings rows can carry the Yahoo injury badge when the status feature is on, independent of ownership', async () => {
  process.env.PROGM_DRAFT_STATUS = 'on';
  const ws = await run({ flag: true });
  const r = rowsByName(ws);
  assert.equal(r['Player 5'].playerStatus.code, 'INJ');
  assert.equal(r['Player 5'].availability, 'rostered');
  assert.equal(r['Player 10'].playerStatus.code, 'O');
  assert.equal(r['Player 1'].playerStatus.state, 'none');
});

test('Tank01 and every paid API are untouched in full-pool mode', async () => {
  process.env.RAPIDAPI_KEY = 'test-key';
  await run({ flag: true });
  assert.ok(hosts.every((h) => !h.includes('rapidapi')), hosts.join(','));
});

// ---- pure ranking invariance (no builder) ----
const SETTINGS = normalizeLeagueSettings(settingsResponse()).settings;
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 70, gameTotal: 82 }));
const pts = (id) => 60 - id * 2.5;
const proj = { getProjection: (p) => (/\.p\.(\d+)$/.exec(p.playerKey) && Number(/\.p\.(\d+)$/.exec(p.playerKey)[1]) <= 12 ? { projectedPoints: pts(Number(/\.p\.(\d+)$/.exec(p.playerKey)[1])), confidence: 0.9, history } : null) };
const P = (id) => ({ playerKey: `466.p.${id}`, name: `Player ${id}`, teamAbbr: 'BOS', eligiblePositions: ['PG'], status: null });
const poolFrom = (mine, t2, avail) => assembleLeaguePool({
  available: { players: avail.map(P), ok: true, report: {} }, myTeam: { teamKey: T1, name: 'My Team' }, myRoster: { players: mine.map(P), ok: true },
  opponents: [{ teamKey: T2, name: 'Team Two', players: t2.map(P), ok: true }, { teamKey: T3, name: 'Team Three', players: [], ok: true }], expectedTeams: 3,
});
const ranksOf = (pool, extra = {}) => {
  const board = buildDraftBoard({ players: pool.players, settings: SETTINGS, projectionProvider: proj, poolComplete: pool.completeness.complete, baselineReference: null, availabilityOf: (p) => p.availability === 'available', ...extra });
  return Object.fromEntries(board.board.map((r) => [r.playerKey, r.overallRank]));
};

test('ranking invariance: ownership, availability, input order and roster-fit personalization never change a player\'s overall rank', () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const base = ranksOf(poolFrom([1, 2, 3], [4, 5, 6], [7, 8, 9, 10, 11, 12]));
  const allAvailable = ranksOf(poolFrom([], [], ids));
  const reOwned = ranksOf(poolFrom([12, 11, 10], [9, 8, 7], [1, 2, 3, 4, 5, 6]));
  const reversed = ranksOf(poolFrom([3, 2, 1], [6, 5, 4], [12, 11, 10, 9, 8, 7]));
  assert.deepEqual(allAvailable, base);
  assert.deepEqual(reOwned, base);
  assert.deepEqual(reversed, base);
  // Roster-fit personalization (which affects Draft Priority only) leaves overallRank alone.
  const personalized = ranksOf(poolFrom([1, 2, 3], [4, 5, 6], [7, 8, 9, 10, 11, 12]), { rosterAnalysis: { counts: { rosterSize: 3 }, positions: { thinPositions: [{ position: 'PG' }], overloadedPositions: [] } } });
  assert.deepEqual(personalized, base);
});

test('UI-style filtering and slicing of rankings rows cannot change a rank: the rank is a stored field, never recomputed', () => {
  const pool = poolFrom([1, 2, 3], [4, 5, 6], [7, 8, 9, 10, 11, 12]);
  const board = buildDraftBoard({ players: pool.players, settings: SETTINGS, projectionProvider: proj, poolComplete: true, baselineReference: null, availabilityOf: (p) => p.availability === 'available' });
  const overallRanks = new Map(board.board.map((r) => [r.playerKey, r.overallRank]));
  const rankings = buildRankings({ players: pool.players, projectionProvider: proj, overallRanks, rankScope: 'full_pool', sortBy: 'overall', includeOut: true, limit: pool.players.length, rowExtras: (p) => ({ availability: p.availability }) });
  const full = Object.fromEntries(rankings.players.map((p) => [p.playerKey, p.overallRank]));
  for (const subset of [rankings.players.filter((p) => p.availability === 'available'), rankings.players.filter((p) => p.availability === 'mine'), rankings.players.slice(3, 6), rankings.players.filter((p) => p.name.includes('9'))]) {
    for (const row of subset) assert.equal(row.overallRank, full[row.playerKey]);
  }
  assert.deepEqual(rankings.players.map((p) => p.overallRank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('buildRankings without the new options is unchanged: default cap of 200 and OUT players still hidden', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ playerKey: `466.p.${i + 1}`, name: `P${i + 1}`, teamAbbr: 'BOS', eligiblePositions: ['PG'], status: i === 0 ? 'INJ' : null }));
  const rankings = buildRankings({ players: many, projectionProvider: proj, sortBy: 'projected' });
  assert.equal(rankings.players.length, 200);
  assert.equal(rankings.players.some((p) => p.playerKey === '466.p.1'), false, 'INJ hidden by default');
  assert.equal('availability' in rankings.players[0], false);
});
