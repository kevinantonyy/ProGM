import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBasketballRouter } from './basketball.js';
import * as cache from '../services/providers/cache.js';
import { resolveDraftStatusDisplay } from '../services/fantasy/playerStatus.js';
import { rankingProfileForUser } from '../services/fantasy/rankingModel.js';

const LEAGUE = '466.l.1';
const TEAM = `${LEAGUE}.t.1`;
const AT = '2026-10-16T07:00:00.000Z';
const players = [null, 'NA', 'O', 'INJ', 'Q', 'XYZ'].map((status, i) => ({
  playerKey: `466.p.${i + 1}`, name: `Fixture ${i + 1}`, status,
  eligiblePositions: ['PG'], teamAbbr: 'TST',
}));
const settingsResponse = { fantasy_content: { league: [
  { league_key: LEAGUE, season: '2026', num_teams: 2, draft_status: 'drafting' },
  { settings: {
    scoring_type: 'headpoint',
    roster_positions: [{ roster_position: { position: 'PG', count: 2, is_starting_position: 1 } }],
    stat_categories: { stats: [{ stat: { stat_id: 12, abbr: 'PTS', enabled: 1 } }] },
    stat_modifiers: { stats: [{ stat: { stat_id: 12, value: 1 } }] },
  } },
] } };

function fixture(overrides = {}) {
  cache.clearAll();
  let projectionCalls = 0;
  const router = createBasketballRouter({
    cache,
    authenticate: (req, res, next) => next(),
    accessTokenFor: async () => 'synthetic-test-token',
    yahooFantasy: async (url) => {
      assert.equal(url, `/league/${LEAGUE}/settings`);
      return structuredClone(settingsResponse);
    },
    fetchYahooDraftResults: async () => ({
      value: { fantasy_content: { league: [{}, { draft_results: { count: 0 } }] } },
      meta: { fetchedAt: AT, stale: false },
    }),
    fetchYahooDraftPool: async () => structuredClone(players),
    buildProjectionContext: async ({ rookieEstimates }) => {
      projectionCalls += 1;
      assert.equal(typeof rookieEstimates, 'boolean');
      return {
        externalAvailable: true,
        projectionProvider: {},
        projectionByCanonicalId: new Map(players.map((p, i) => [p.playerKey, {
          projectedPoints: 50 - i, confidence: 0.9,
          history: [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 70, gameTotal: 82 })),
        }])),
      };
    },
    ...overrides,
  });
  return { router, projectionCalls: () => projectionCalls };
}

// Invoke the registered Express endpoint with mocked I/O; no listener, OAuth or provider requests.
async function call(router, endpoint = '/draft', extraQuery = {}) {
  const handler = router.stack.find((layer) => layer.route?.path === endpoint).route.stack.at(-1).handle;
  const req = { userId: 1, query: { leagueKey: LEAGUE, teamKey: TEAM, ...extraQuery } };
  const res = { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res);
  return res;
}

test('supported-points live draft initializes rookie estimates before building real recommendations', async () => {
  const f = fixture();
  const res = await call(f.router);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(f.projectionCalls(), 1);
  assert.equal(res.body.draftState, 'live');
  assert.equal(res.body.recommendations.available, true);
  assert.equal(res.body.recommendations.board.length, players.length);
});

function statusFlag(t, value) {
  const previous = process.env.PROGM_DRAFT_STATUS;
  t.after(() => {
    if (previous == null) delete process.env.PROGM_DRAFT_STATUS;
    else process.env.PROGM_DRAFT_STATUS = previous;
  });
  process.env.PROGM_DRAFT_STATUS = value;
}

test('live draft status flag adds display fields only, preserves ranks and ordering, and uses cached Yahoo times', async (t) => {
  statusFlag(t, 'off');
  let poolCalls = 0;
  const f = fixture({ fetchYahooDraftPool: async () => {
    poolCalls += 1;
    return players.map((player) => ({ ...player, yahooStatusFetchedAt: AT }));
  } });
  const before = (await call(f.router)).body;
  process.env.PROGM_DRAFT_STATUS = 'on';
  const after = (await call(f.router)).body;
  const { statusData, ...annotated } = after.recommendations;
  const strip = ({ playerStatus, leagueAvailability, ...row }) => row;
  assert.deepEqual({ ...annotated, board: annotated.board.map(strip), noData: annotated.noData.map(strip) }, before.recommendations);
  assert.equal(before.recommendations.statusData, undefined);
  assert.equal(poolCalls, 1, 'a second poll reuses metadata without a Yahoo fetch');
  assert.equal(statusData.observedAt, AT, 'cache access must not replace the original fetch time');
  assert.deepEqual(after.recommendations.board.map((row) => row.playerStatus.state), ['none', 'inactive', 'out', 'out', 'questionable', 'unknown']);
  assert.ok(after.recommendations.board.every((row) => row.leagueAvailability === 'available' && row.playerStatus.observedAt === AT));
});

test('stale cached player metadata retains original times and exposes stale status', async (t) => {
  statusFlag(t, 'on');
  const f = fixture({ fetchYahooDraftPool: async () => { throw new Error('synthetic Yahoo denial'); } });
  cache.set(`bball:availDraftMetadata:v3:${LEAGUE}`, players, { provider: 'yahoo', ttl: -1 });
  const original = cache.get(`bball:availDraftMetadata:v3:${LEAGUE}`).meta.fetchedAt;
  const res = await call(f.router);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recommendations.statusData.observedAt, original);
  assert.equal(res.body.recommendations.statusData.stale, true);
  assert.ok(res.body.recommendations.board.every((row) => row.playerStatus.stale === true));
});

test('live annotation includes missing-projection players and never restores drafted players', async (t) => {
  statusFlag(t, 'on');
  const f = fixture({
    fetchYahooDraftResults: async () => ({ value: { fantasy_content: { league: [{}, { draft_results: {
      count: 1, 0: { draft_result: { pick: 1, round: 1, team_key: `${LEAGUE}.t.2`, player_key: players[0].playerKey } },
    } }] } }, meta: { fetchedAt: AT } }),
    buildProjectionContext: async () => ({ externalAvailable: false, projectionProvider: null, projectionByCanonicalId: new Map() }),
  });
  const res = await call(f.router);
  assert.equal(res.statusCode, 200);
  const rows = [...res.body.recommendations.board, ...res.body.recommendations.noData];
  assert.equal(rows.length, players.length - 1);
  assert.ok(rows.every((row) => row.playerKey !== players[0].playerKey && row.playerStatus && row.leagueAvailability === 'available'));
});

test('workspace and ranking diagnostic cache identity track the display flag independently of ranking profile', async (t) => {
  statusFlag(t, 'off');
  let builds = 0;
  const f = fixture({ buildBasketballWorkspace: async () => ({
    draftBoard: { board: [{ playerKey: 'fixture', value: 1, components: {} }] },
    displayEnabled: resolveDraftStatusDisplay(), build: ++builds,
  }) });
  const off = (await call(f.router, '/workspace')).body;
  process.env.PROGM_DRAFT_STATUS = 'on';
  const on = (await call(f.router, '/workspace')).body;
  assert.equal(builds, 2);
  assert.equal(off.displayEnabled, false);
  assert.equal(on.displayEnabled, true);
  process.env.PROGM_DRAFT_STATUS = 'off';
  const again = (await call(f.router, '/workspace')).body;
  assert.equal(again.build, off.build);
  assert.equal(again.cache.hit, true);
  // Leave only the flag-on entry: the diagnostic must follow the same key as the workspace.
  cache.del(`bball:workspace:${rankingProfileForUser(1)}:1:${LEAGUE}:${TEAM}`);
  process.env.PROGM_DRAFT_STATUS = 'on';
  const previousDiagnostic = process.env.PROGM_RANKING_DIAGNOSTIC;
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousDiagnostic == null) delete process.env.PROGM_RANKING_DIAGNOSTIC;
    else process.env.PROGM_RANKING_DIAGNOSTIC = previousDiagnostic;
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  process.env.PROGM_RANKING_DIAGNOSTIC = 'on';
  process.env.NODE_ENV = 'test';
  const diagnostic = await call(f.router, '/diagnostics/ranking-compare');
  assert.equal(diagnostic.statusCode, 200, JSON.stringify(diagnostic.body));
});
