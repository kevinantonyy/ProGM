import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBasketballRouter } from './basketball.js';
import * as cache from '../services/providers/cache.js';

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
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
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
