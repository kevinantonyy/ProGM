/**
 * GET /api/basketball/draft-preview with mocked Yahoo/projection I/O. No listener, OAuth, database or network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBasketballRouter } from './basketball.js';
import * as cache from '../services/providers/cache.js';
import { buildDraftBoard } from '../services/fantasy/draftHelper.js';
import { normalizeLeagueSettings } from '../services/fantasy/normalize.js';
import { referenceKey } from '../services/fantasy/baselineReference.js';
import { rankingProfileForUser } from '../services/fantasy/rankingModel.js';

const LEAGUE = '466.l.1';
const AT = '2026-10-16T07:00:00.000Z';
const mk = (id, poolSource, status = null) => ({
  playerKey: `466.p.${id}`, name: `Fixture ${id}`, status, eligiblePositions: id % 2 ? ['PG'] : ['C'], teamAbbr: 'TST',
  poolSource, yahooStatusFetchedAt: AT, yahooAdp: id, percentOwned: 50,
});
// 5 drafted (taken) + 3 undrafted (free agents)
const POOL = [mk(1, 'T'), mk(2, 'T', 'INJ'), mk(3, 'T'), mk(4, 'T', 'Q'), mk(5, 'T'), mk(6, 'A', 'O'), mk(7, 'A'), mk(8, 'A', 'NA')];
const COMPLETE = { complete: true, reasons: [], counts: { total: 8, available: 3, taken: 5, draftedPicks: 5, fromDraftResultsFallback: 0, fallbackFailedBatches: 0, stillMissing: 0, skippedWithoutKey: 0, duplicatesRemoved: 0 } };
const INCOMPLETE = { complete: false, reasons: ['1 drafted player is missing from the player pool even after fetching them by player key.'], counts: { ...COMPLETE.counts, stillMissing: 1 } };

const settingsResponse = (draftStatus = 'postdraft', pointValue = 1) => ({ fantasy_content: { league: [
  { league_key: LEAGUE, season: '2026', num_teams: 2, draft_status: draftStatus },
  { settings: {
    scoring_type: 'headpoint',
    roster_positions: [{ roster_position: { position: 'PG', count: 2, is_starting_position: 1 } }, { roster_position: { position: 'C', count: 1, is_starting_position: 1 } }],
    stat_categories: { stats: [{ stat: { stat_id: 12, abbr: 'PTS', enabled: 1 } }] },
    stat_modifiers: { stats: [{ stat: { stat_id: 12, value: pointValue } }] },
  } },
] } });
const draftResults = (ids) => {
  const draft_results = { count: ids.length };
  ids.forEach((id, i) => { draft_results[String(i)] = { draft_result: [{ pick: i + 1 }, { round: 1 }, { team_key: `${LEAGUE}.t.1` }, { player_key: `466.p.${id}` }] }; });
  return { fantasy_content: { league: [{}, { draft_results }] } };
};
const projection = (points) => ({
  projectedPoints: points, confidence: 0.9,
  history: [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 70, gameTotal: 82 })),
});

function withEnv(t, vars) {
  const saved = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value == null) delete process.env[name]; else process.env[name] = value;
  }
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value == null) delete process.env[name]; else process.env[name] = value; } });
}

function fixture(overrides = {}) {
  cache.clearAll();
  const seen = { yahoo: [], pool: 0, poolDraftedKeys: null, projectionArgs: [] };
  const router = createBasketballRouter({
    cache,
    authenticate: (req, res, next) => next(),
    accessTokenFor: async () => 'synthetic-test-token',
    yahooFantasy: async (url) => {
      seen.yahoo.push(url);
      assert.equal(url, `/league/${LEAGUE}/settings`, 'the preview route itself only reads league settings');
      return structuredClone(overrides.settings || settingsResponse());
    },
    peekYahooDraftResults: () => null,
    fetchYahooDraftResults: async () => ({ value: draftResults([1, 2, 3, 4, 5]), meta: { fetchedAt: AT, stale: false } }),
    fetchDraftPreviewPool: async (_yahoo, _token, _league, { draftedKeys }) => {
      seen.pool += 1; seen.poolDraftedKeys = draftedKeys;
      return { players: structuredClone(overrides.pool || POOL), completeness: structuredClone(overrides.completeness || COMPLETE) };
    },
    buildProjectionContext: async (args) => {
      seen.projectionArgs.push(args);
      return {
        externalAvailable: true,
        projectionProvider: {},
        projectionByCanonicalId: new Map(overrides.emptyProjections ? [] : POOL.filter((p) => !overrides.noProjection?.includes(p.playerKey)).map((p, i) => [p.playerKey, projection(60 - i * 5)])),
        reason: overrides.ctxReason ?? null,
        estimateByCanonicalId: overrides.estimates || new Map(),
        injuryReports: { applicable: true, available: true, count: 0, provider: 'free_nba', fetchedAt: AT, stale: false },
      };
    },
    ...(overrides.deps || {}),
  });
  return { router, seen };
}

async function call(router, query = {}, userId = 1) {
  const layers = router.stack.find((layer) => layer.route?.path === '/draft-preview').route.stack.map((layer) => layer.handle);
  const req = { userId, query: { leagueKey: LEAGUE, ...query } };
  const res = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  for (const handler of layers) {
    let advanced = false;
    await handler(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

test('PROGM_DRAFT_PREVIEW unset/off: the endpoint is a plain 404 that touches nothing', async (t) => {
  for (const value of [undefined, '', 'off', 'false', '0']) {
    withEnv(t, { PROGM_DRAFT_PREVIEW: value });
    const f = fixture();
    const res = await call(f.router);
    assert.equal(res.statusCode, 404, String(value));
    assert.deepEqual(res.body, { error: 'Not found' });
    assert.deepEqual(f.seen.yahoo, []);
    assert.equal(f.seen.pool, 0);
    assert.equal(cache.has(`bball:preview:v1:settings:${LEAGUE}`), false);
  }
});

test('flag on: invalid league keys are rejected and only completed drafts are previewable', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  assert.equal((await call(fixture().router, { leagueKey: 'nope' })).statusCode, 400);
  for (const status of ['predraft', 'drafting']) {
    const f = fixture({ settings: settingsResponse(status) });
    const res = await call(f.router);
    assert.equal(res.statusCode, 409, status);
    assert.equal(res.body.yahooDraftStatus, status);
    assert.equal(f.seen.pool, 0, 'no pool is fetched for a draft that is not complete');
  }
});

test('flag on, completed draft: full-pool board over drafted AND undrafted players, labelled as a preview', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture();
  const res = await call(f.router);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.preview, true);
  assert.equal(res.body.completeness.complete, true);
  assert.equal(res.body.draftBoard.available, true);
  assert.equal(res.body.draftBoard.rankScope, 'full_pool');
  const rows = [...res.body.draftBoard.board, ...res.body.draftBoard.noData];
  assert.equal(rows.length, POOL.length);
  const availability = Object.fromEntries(rows.map((r) => [r.playerKey, r.availability]));
  assert.equal(availability['466.p.1'], 'rostered'); // drafted
  assert.equal(availability['466.p.7'], 'available'); // never drafted
  assert.deepEqual([...f.seen.poolDraftedKeys].sort(), POOL.slice(0, 5).map((p) => p.playerKey));
});

test('ranking consistency: identical to buildDraftBoard over the same pool, with no roster influence and a clean baseline', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on', PROGM_DRAFT_STATUS: 'off' });
  const f = fixture();
  const res = await call(f.router);
  const league = normalizeLeagueSettings(settingsResponse());
  const ctxProjection = new Map(POOL.map((p, i) => [p.playerKey, projection(60 - i * 5)]));
  const direct = buildDraftBoard({
    players: structuredClone(POOL), settings: league.settings,
    projectionProvider: { getProjection: (p) => ctxProjection.get(p.playerKey) || null, getProjectedValue: (p) => ctxProjection.get(p.playerKey)?.projectedPoints ?? null },
    poolComplete: true, baselineReference: null, rosterAnalysis: null,
    availabilityOf: (p) => p.poolSource === 'A', currentSeason: league.season, rankingModel: 'legacy', rookieEstimates: false,
  });
  const project = (board) => board.board.map((r) => [r.playerKey, r.overallRank, r.value, r.projectedSeasonPoints, r.availability]);
  assert.deepEqual(project(res.body.draftBoard), project(direct));
  assert.equal(res.body.draftBoard.baselineReference, undefined, 'internal normalization data is never sent to the client');
});

test('uses the league\'s real scoring settings: different point values reach the projection engine and change nothing else', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const one = fixture({ settings: settingsResponse('postdraft', 1) });
  await call(one.router);
  const two = fixture({ settings: settingsResponse('postdraft', 2) });
  await call(two.router);
  const cats = (f) => f.seen.projectionArgs[0].statCategories;
  assert.notDeepEqual(cats(one), cats(two));
  assert.equal(one.seen.projectionArgs[0].season, '2026');
  assert.equal(one.seen.projectionArgs[0].scoringSupported, true);
  assert.equal(one.seen.projectionArgs[0].players.length, POOL.length, 'every pool player is projected, drafted or not');
});

test('incomplete pool: explicit reasons, no full-pool claim, players still shown', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const res = await call(fixture({ completeness: INCOMPLETE }).router);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.completeness.complete, false);
  assert.match(res.body.completeness.reasons[0], /missing from the player pool/);
  assert.notEqual(res.body.draftBoard.rankScope, 'full_pool');
  assert.equal(res.body.draftBoard.rankScope, 'available_players');
  assert.ok(res.body.draftBoard.board.length > 0);
});

test('PROGM_DRAFT_STATUS keeps working: badges added, ranks/order/values unchanged, separate cache identity', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on', PROGM_DRAFT_STATUS: 'off' });
  const off = (await call(fixture().router)).body;
  assert.equal(off.draftBoard.statusData, undefined);
  assert.equal(off.draftBoard.board[0].playerStatus, undefined);
  withEnv(t, { PROGM_DRAFT_STATUS: 'on' });
  const on = (await call(fixture().router)).body;
  const byKey = (b) => Object.fromEntries([...b.draftBoard.board, ...b.draftBoard.noData].map((r) => [r.playerKey, r]));
  assert.equal(byKey(on)['466.p.2'].playerStatus.code, 'INJ');
  assert.equal(byKey(on)['466.p.6'].playerStatus.code, 'O');
  assert.equal(byKey(on)['466.p.8'].playerStatus.code, 'NA');
  assert.equal(byKey(on)['466.p.2'].leagueAvailability, 'rostered');
  assert.equal(byKey(on)['466.p.7'].leagueAvailability, 'available');
  assert.ok(on.draftBoard.statusData);
  const strip = ({ playerStatus, leagueAvailability, ...row }) => row;
  assert.deepEqual(on.draftBoard.board.map(strip), off.draftBoard.board);
  assert.equal(cache.has(`bball:preview:v1:${rankingProfileForUser(1)}.status:1:${LEAGUE}`), true);
});

test('rookie estimates and projections are preserved: estimates fill only players without a real projection', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on', PROGM_ROOKIE_ESTIMATES: 'on' });
  const estimate = { ...projection(35), estimate: true, estimateBasis: 'yahoo_adp' };
  const f = fixture({ noProjection: ['466.p.7'], estimates: new Map([['466.p.7', estimate], ['466.p.1', { ...projection(1), estimate: true }]]) });
  const res = await call(f.router);
  assert.equal(f.seen.projectionArgs[0].rookieEstimates, true);
  const rows = Object.fromEntries([...res.body.draftBoard.board, ...res.body.draftBoard.noData].map((r) => [r.playerKey, r]));
  assert.equal(rows['466.p.7'].estimate, true);
  assert.equal(rows['466.p.7'].estimateBasis, 'yahoo_adp');
  assert.equal(rows['466.p.1'].estimate, false, 'a real projection always wins over an estimate');
  assert.ok(rows['466.p.1'].projectedSeasonPoints > 0);
});

test('with rookie estimates off the engine is told so', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on', PROGM_ROOKIE_ESTIMATES: undefined });
  const f = fixture();
  await call(f.router);
  assert.equal(f.seen.projectionArgs[0].rookieEstimates, false);
});

test('cache: preview results live under bball:preview: only, never the live-draft, workspace or baseline keys', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on', PROGM_DRAFT_STATUS: 'off' });
  const f = fixture();
  await call(f.router);
  const league = normalizeLeagueSettings(settingsResponse());
  assert.equal(cache.has(`bball:preview:v1:${rankingProfileForUser(1)}:1:${LEAGUE}`), true);
  assert.equal(cache.has(`bball:preview:v1:pool:${LEAGUE}`), true);
  for (const foreign of [
    `bball:draftSettings:${LEAGUE}`,
    `bball:availDraftMetadata:v3:${LEAGUE}`,
    `bball:workspace:${rankingProfileForUser(1)}:1:${LEAGUE}:${LEAGUE}.t.1`,
    referenceKey({ leagueKey: LEAGUE, season: league.season, statCategories: league.settings.statCategories, profile: rankingProfileForUser(1) }),
  ]) assert.equal(cache.has(foreign), false, foreign);
});

test('cache: second request is served from the preview cache; refresh=true rebuilds; users are separate', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture();
  const first = await call(f.router);
  assert.equal(first.body.cache.hit, false);
  const second = await call(f.router);
  assert.equal(second.body.cache.hit, true);
  assert.equal(f.seen.pool, 1);
  assert.equal(f.seen.projectionArgs.length, 1);
  assert.deepEqual(second.body.draftBoard, first.body.draftBoard);
  const refreshed = await call(f.router, { refresh: 'true' });
  assert.equal(refreshed.body.cache.hit, false, 'refresh rebuilds the ranked board');
  assert.equal(f.seen.pool, 1, 'but a refresh within a minute of the last Yahoo pool fetch is served from the pool cache (no new Yahoo burst)');
  const other = await call(f.router, {}, 2);
  assert.equal(other.body.cache.hit, false, 'another account never reads this account\'s cached preview');
});

test('draft results unavailable: the pool is still requested and the verdict comes from the pool checker', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture({ completeness: { ...INCOMPLETE, reasons: ['Yahoo draft results were unavailable, so the pool could not be checked against the players who were drafted.'] } });
  const router = createBasketballRouter({ cache, authenticate: (q, s, n) => n(), accessTokenFor: async () => 't', yahooFantasy: async () => structuredClone(settingsResponse()),
    peekYahooDraftResults: () => null, fetchYahooDraftResults: async () => ({ value: null, meta: { temporaryUnavailable: true } }),
    fetchDraftPreviewPool: async (_y, _t, _l, { draftedKeys }) => { f.seen.poolDraftedKeys = draftedKeys; return { players: structuredClone(POOL), completeness: structuredClone(INCOMPLETE) }; },
    buildProjectionContext: async () => ({ externalAvailable: false, projectionProvider: {}, projectionByCanonicalId: new Map(POOL.map((p, i) => [p.playerKey, projection(50 - i)])) }) });
  cache.clearAll();
  const res = await call(router);
  assert.equal(res.statusCode, 200);
  assert.equal(f.seen.poolDraftedKeys, null);
  assert.equal(res.body.completeness.complete, false);
});

test('unsupported scoring returns an unavailable board without fetching the pool', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const unsupported = settingsResponse();
  unsupported.fantasy_content.league[1].settings.scoring_type = 'head'; // category league
  const f = fixture({ settings: unsupported });
  const res = await call(f.router);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.draftBoard.available, false);
  assert.equal(res.body.completeness.complete, false);
  assert.equal(f.seen.pool, 0);
});

test('the endpoint is GET-only: no write verbs are registered for it', () => {
  const route = fixture().router.stack.find((layer) => layer.route?.path === '/draft-preview').route;
  assert.deepEqual(Object.keys(route.methods), ['get']);
});

function clock(t) {
  const start = Date.now(); let offset = 0;
  t.mock.method(Date, 'now', () => start + offset);
  return (ms) => { offset += ms; };
}

test('refresh=true re-reads Yahoo at most once a minute', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const advance = clock(t);
  const f = fixture();
  await call(f.router);
  for (let i = 0; i < 5; i += 1) await call(f.router, { refresh: 'true' });
  assert.equal(f.seen.pool, 1, 'spamming refresh never multiplies Yahoo pool fetches');
  advance(61 * 1000);
  await call(f.router, { refresh: 'true' });
  assert.equal(f.seen.pool, 2);
});

test('a verified pool is cached for the full window; an unverified one is retried after a minute', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const advance = clock(t);
  const ok = fixture();
  await call(ok.router);
  advance(5 * 60 * 1000);
  assert.equal((await call(ok.router)).body.cache.hit, true);
  const bad = fixture({ completeness: INCOMPLETE });
  await call(bad.router);
  advance(30 * 1000);
  assert.equal((await call(bad.router)).body.cache.hit, true);
  advance(31 * 1000);
  const after = await call(bad.router);
  assert.equal(after.body.cache.hit, false, 'degraded result expired after ~60s');
  assert.equal(bad.seen.pool, 2);
});

test('optional-metadata warnings reach the client and also shorten the cache', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const advance = clock(t);
  const f = fixture({ completeness: { ...COMPLETE, warnings: ['Some Yahoo ADP or rank pages could not be loaded.'] } });
  const res = await call(f.router);
  assert.equal(res.body.completeness.complete, true);
  assert.deepEqual(res.body.completeness.warnings, ['Some Yahoo ADP or rank pages could not be loaded.']);
  advance(61 * 1000);
  assert.equal((await call(f.router)).body.cache.hit, false);
});

test('the shared Yahoo HTTP 999 pause becomes a retryable 503 and leaves no cached preview behind', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const error = Object.assign(new Error('Yahoo requests are temporarily paused'), { httpStatus: 999, yahooCode: 'CIRCUIT_OPEN', retryAfterMs: 42000 });
  const f = fixture({ deps: { fetchDraftPreviewPool: async () => { throw error; } } });
  const res = await call(f.router);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.retryAfterMs, 42000);
  assert.match(res.body.error, /try the Draft Preview again/);
  assert.equal(cache.has(`bball:preview:v1:pool:${LEAGUE}`), false);
  assert.equal(cache.has(`bball:preview:v1:${rankingProfileForUser(1)}:1:${LEAGUE}`), false);
});

test('any other preview failure is a contained 502 for that request only', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture({ deps: { buildProjectionContext: async () => { throw new Error('projection provider exploded'); } } });
  const res = await call(f.router);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /exploded/);
});

test('a pool build that timed out is a contained 502 and does not wedge the next request (no stuck in-flight cache entry)', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  let attempts = 0;
  const f = fixture({ deps: { fetchDraftPreviewPool: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Draft Preview stopped: Yahoo did not respond in time.');
    return { players: structuredClone(POOL), completeness: structuredClone(COMPLETE) };
  } } });
  const failed = await call(f.router);
  assert.equal(failed.statusCode, 502);
  assert.match(failed.body.error, /did not respond in time/);
  assert.equal(cache.inFlightCount(), 0);
  assert.equal(cache.has(`bball:preview:v1:pool:${LEAGUE}`), false, 'a failed build is never cached');
  const retry = await call(f.router);
  assert.equal(retry.statusCode, 200);
  assert.equal(attempts, 2);
});

test('Draft Preview asks for bulk-only projections (no per-player provider fan-out for a ~700-player pool)', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture();
  await call(f.router);
  assert.equal(f.seen.projectionArgs[0].bulkOnly, true);
});

test('normal case reports projections present and no reason', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const res = await call(fixture().router);
  assert.deepEqual(res.body.projection, { externalAvailable: true, projectedCount: POOL.length, totalPlayers: POOL.length, reason: null });
});

test('zero projections: 200 with projection.projectedCount 0 and the provider reason, pool verdict untouched, retried after a minute', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const advance = clock(t);
  const reason = 'NBA stats from ESPN are unavailable: Unrecognized or empty ESPN player directory feed';
  const f = fixture({ emptyProjections: true, ctxReason: reason });
  const res = await call(f.router);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.projection, { externalAvailable: true, projectedCount: 0, totalPlayers: POOL.length, reason });
  assert.equal(res.body.completeness.complete, true, 'Yahoo pool completeness is independent of projection availability');
  assert.equal(res.body.draftBoard.board.length, 0);
  assert.equal(res.body.draftBoard.noData.length, POOL.length);
  assert.ok(res.body.draftBoard.noData.every((row) => row.overallRank === undefined));
  assert.equal((await call(f.router)).body.cache.hit, true);
  advance(61 * 1000);
  assert.equal((await call(f.router)).body.cache.hit, false, 'an all-unprojected result is not held for the full 10 minutes');
  assert.equal(f.seen.pool, 1, 'but the verified Yahoo pool is not re-fetched');
});

test('projection provider entirely unavailable: the board is unavailable and the reason is passed through', async (t) => {
  withEnv(t, { PROGM_DRAFT_PREVIEW: 'on' });
  const f = fixture({ deps: { buildProjectionContext: async () => ({ externalAvailable: false, projectionProvider: null, projectionByCanonicalId: new Map(), estimateByCanonicalId: new Map(), reason: 'NBA stats from ESPN are unavailable: Unrecognized or empty ESPN player directory feed' }) } });
  const res = await call(f.router);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.draftBoard.available, false);
  assert.equal(res.body.projection.projectedCount, 0);
  assert.equal(res.body.projection.externalAvailable, false);
  assert.match(res.body.projection.reason, /ESPN are unavailable/);
});
