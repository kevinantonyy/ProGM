/**
 * Regression tests for the Yahoo stat-id mapping bug (FGA is id 3 and FTA is id 6; ids 5 and 8 were wrongly mapped to them),
 * using the exact 11-category Yahoo H2H points scoring of the production league (season 2026):
 *   FGM(4) +1 | FGA(3) -0.45 | FTM(7) +1 | FTA(6) -0.75 | 3PTM(10) +3 | PTS(12) +0.5 | REB(15) +1.5 | AST(16) +2 |
 *   ST(17) +3 | BLK(18) +3 | TO(19) -2
 * Mocked ESPN/Yahoo shapes only: no network, no credentials.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { YAHOO_STAT_TO_STATLINE, scoreStatLine, scoringIsSupported } from './scoring.js';
import { projectPlayer } from './projection.js';
import { normalizeLeagueSettings } from './normalize.js';
import { buildProjectionContext } from './insights.js';
import { buildDraftBoard, explainNoData } from './draftHelper.js';
import * as providers from '../providers/index.js';
import { emptyStatLine } from '../providers/types.js';

const YAHOO_STATS = [
  [4, 'FGM', 1], [3, 'FGA', -0.45], [7, 'FTM', 1], [6, 'FTA', -0.75], [10, '3PTM', 3], [12, 'PTS', 0.5],
  [15, 'REB', 1.5], [16, 'AST', 2], [17, 'ST', 3], [18, 'BLK', 3], [19, 'TO', -2],
];
/** The league's settings exactly as Yahoo returns them (ids and values as strings). */
const yahooSettings = (extra = []) => ({ fantasy_content: { league: [
  { league_key: '466.l.12345', season: '2026', num_teams: 12, draft_status: 'postdraft' },
  { settings: {
    scoring_type: 'headpoint',
    roster_positions: [{ roster_position: { position: 'PG', count: 1, is_starting_position: 1 } }, { roster_position: { position: 'C', count: 1, is_starting_position: 1 } }, { roster_position: { position: 'BN', count: 3, is_starting_position: 0 } }],
    stat_categories: { stats: [...YAHOO_STATS, ...extra].map(([id, abbr]) => ({ stat: { stat_id: String(id), name: abbr, abbr, enabled: '1' } })) },
    stat_modifiers: { stats: [...YAHOO_STATS, ...extra].map(([id, , value]) => ({ stat: { stat_id: String(id), value: String(value) } })) },
  } },
] } });
const LEAGUE = normalizeLeagueSettings(yahooSettings());
const CATS = LEAGUE.settings.statCategories;
const W = Object.fromEntries(YAHOO_STATS.map(([id, , value]) => [id, value]));

// A complete per-game line and its hand-calculated fantasy value under the weights above.
const LINE = { ...emptyStatLine(), gamesPlayed: 70, minutes: 34, fgMade: 8, fgAtt: 17, ftMade: 5, ftAtt: 6.5, threesMade: 2, points: 24, rebounds: 7, assists: 6, steals: 1.2, blocks: 0.8, turnovers: 3 };
const HAND = 8 * 1 + 17 * -0.45 + 5 * 1 + 6.5 * -0.75 + 2 * 3 + 24 * 0.5 + 7 * 1.5 + 6 * 2 + 1.2 * 3 + 0.8 * 3 + 3 * -2; // 40.975
const close = (actual, expected, tolerance = 0.011) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

test('the production league settings parse as a points league with all 11 weighted categories (ids as numbers)', () => {
  assert.equal(LEAGUE.settings.scoringFormat, 'points');
  const weighted = CATS.filter((c) => c.pointValue != null);
  assert.equal(weighted.length, 11);
  assert.deepEqual(Object.fromEntries(weighted.map((c) => [c.statId, c.pointValue])), W);
  assert.equal(CATS.find((c) => c.statId === 3).abbr, 'FGA');
  assert.equal(CATS.find((c) => c.statId === 6).abbr, 'FTA');
  assert.equal(scoringIsSupported(LEAGUE.settings), true);
});

test('stat map: FGA is id 3 and FTA is id 6; the old ids 5 and 8 are UNMAPPED; every other mapping is unchanged', () => {
  assert.equal(YAHOO_STAT_TO_STATLINE[3], 'fgAtt');
  assert.equal(YAHOO_STAT_TO_STATLINE[6], 'ftAtt');
  assert.equal(YAHOO_STAT_TO_STATLINE[5], undefined);
  assert.equal(YAHOO_STAT_TO_STATLINE[8], undefined);
  assert.deepEqual(YAHOO_STAT_TO_STATLINE, {
    3: 'fgAtt', 4: 'fgMade', 6: 'ftAtt', 7: 'ftMade', 10: 'threesMade', 12: 'points', 13: 'offRebounds', 14: 'defRebounds',
    15: 'rebounds', 16: 'assists', 17: 'steals', 18: 'blocks', 19: 'turnovers', 21: 'personalFouls', 27: 'doubleDoubles', 28: 'tripleDoubles',
  });
});

test('complete data: finite projected points equal the hand calculation, with the FGA and FTA contributions NEGATIVE', () => {
  const scored = scoreStatLine(LINE, CATS);
  assert.deepEqual(scored.unsupportedStats, []);
  close(scored.points, HAND);
  const fga = scored.breakdown.find((b) => b.statId === 3);
  const fta = scored.breakdown.find((b) => b.statId === 6);
  assert.equal(fga.abbr, 'FGA'); assert.equal(fga.weight, -0.45); close(fga.points, 17 * -0.45); assert.ok(fga.points < 0);
  assert.equal(fta.abbr, 'FTA'); assert.equal(fta.weight, -0.75); close(fta.points, 6.5 * -0.75); assert.ok(fta.points < 0);
  assert.equal(scored.breakdown.length, 11, 'every weighted category contributes');

  const projection = projectPlayer({ stats: { externalId: 'x', season: LINE, recent: null }, statCategories: CATS });
  assert.ok(Number.isFinite(projection.projectedPoints));
  close(projection.projectedPoints, HAND);
  assert.equal(projection.method, 'season_only');
  assert.deepEqual(projection.unsupportedStats, []);
  assert.equal(projection.lastSeasonFantasy.complete, true);
  assert.deepEqual(projection.lastSeasonFantasy.missingCategories, []);
});

test('weights are untouched: more attempts at the same makes lowers the projection by exactly the FGA and FTA weights', () => {
  const base = projectPlayer({ stats: { externalId: 'x', season: LINE, recent: null }, statCategories: CATS }).projectedPoints;
  const wasteful = projectPlayer({ stats: { externalId: 'x', season: { ...LINE, fgAtt: LINE.fgAtt + 4, ftAtt: LINE.ftAtt + 2 }, recent: null }, statCategories: CATS }).projectedPoints;
  close(base - wasteful, 4 * 0.45 + 2 * 0.75); // within the projector's 2-decimal rounding
});

test('a missing FGA or FTA value is an explicit incomplete projection, never zero and never partial', () => {
  for (const [field, abbr] of [['fgAtt', 'FGA'], ['ftAtt', 'FTA']]) {
    const projection = projectPlayer({ stats: { externalId: 'x', season: { ...LINE, [field]: null }, recent: null }, statCategories: CATS });
    assert.equal(projection.projectedPoints, null);
    assert.equal(projection.method, 'incomplete_scoring_data');
    assert.deepEqual(projection.unsupportedStats, [abbr]);
    assert.equal(projection.lastSeasonFantasy.points, null);
    assert.deepEqual(projection.lastSeasonFantasy.missingCategories, [abbr]);
  }
});

test('a genuinely unsupported weighted stat still gives an explicit incomplete projection that names it', () => {
  const league = normalizeLeagueSettings(yahooSettings([[9, '3PA', -0.25]]));
  assert.equal(scoringIsSupported(league.settings), true, 'other supported stats keep the league supported');
  const projection = projectPlayer({ stats: { externalId: 'x', season: LINE, recent: null }, statCategories: league.settings.statCategories });
  assert.equal(projection.projectedPoints, null);
  assert.equal(projection.method, 'incomplete_scoring_data');
  assert.deepEqual(projection.unsupportedStats, ['3PA']);
});

test('the former ids 5 and 8 are no longer silently scored as FGA/FTA: weighting them is explicit and incomplete', () => {
  for (const id of [5, 8]) {
    const scored = scoreStatLine(LINE, [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }, { statId: id, abbr: `id${id}`, pointValue: -1, enabled: true }]);
    assert.deepEqual(scored.unsupportedStats, [`id${id}`]);
    assert.equal(scored.points, 24, 'no guess was added to the supported part');
  }
});

// ---- end to end through the real projection pipeline with a mocked ESPN feed ----
const originalFetch = global.fetch;
const NAMES = {
  general: ['gamesPlayed', 'avgMinutes', 'avgFouls', 'flagrantFouls', 'technicalFouls', 'ejections', 'doubleDouble', 'tripleDouble', 'minutes', 'rebounds', 'fouls', 'avgRebounds'],
  offensive: ['avgPoints', 'avgFieldGoalsMade', 'avgFieldGoalsAttempted', 'fieldGoalPct', 'avgThreePointFieldGoalsMade', 'avgThreePointFieldGoalsAttempted', 'threePointFieldGoalPct', 'avgFreeThrowsMade', 'avgFreeThrowsAttempted', 'freeThrowPct', 'avgAssists', 'avgTurnovers', 'points', 'fieldGoalsMade', 'fieldGoalsAttempted', 'threePointFieldGoalsMade', 'threePointFieldGoalsAttempted', 'freeThrowsMade', 'freeThrowsAttempted', 'assists', 'turnovers'],
  defensive: ['avgSteals', 'avgBlocks', 'steals', 'blocks'],
};
const BASE = { gamesPlayed: 70, avgMinutes: 34, avgFouls: 2, avgRebounds: 7, avgPoints: 24, avgFieldGoalsMade: 8, avgFieldGoalsAttempted: 17, avgThreePointFieldGoalsMade: 2, avgFreeThrowsMade: 5, avgFreeThrowsAttempted: 6.5, avgAssists: 6, avgTurnovers: 3, avgSteals: 1.2, avgBlocks: 0.8 };
const espnPayload = (athletes) => ({
  categories: Object.entries(NAMES).map(([name, names]) => ({ name, names })),
  athletes: athletes.map(({ id, name, overrides = {} }) => {
    const values = { ...BASE, ...overrides };
    return { athlete: { id: String(id), displayName: name, teamShortName: 'BOS' }, categories: Object.entries(NAMES).map(([cat, names]) => ({ name: cat, values: names.map((n) => values[n] ?? 0) })) };
  }),
});
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const yahooPlayers = [
  { playerKey: '466.p.1', name: 'Alpha Guard', teamAbbr: 'Bos', eligiblePositions: ['PG'] },
  { playerKey: '466.p.2', name: 'Bravo Center', teamAbbr: 'Bos', eligiblePositions: ['C'] },
  { playerKey: '466.p.3', name: 'Charlie Wing', teamAbbr: 'Bos', eligiblePositions: ['PG'] },
  { playerKey: '466.p.4', name: 'Rookie Nobody', teamAbbr: 'Bos', eligiblePositions: ['PG'] }, // no ESPN record: legitimately unmatched
];
let savedTank;
beforeEach(() => {
  savedTank = process.env.PROGM_TANK01_ENABLED; delete process.env.PROGM_TANK01_ENABLED;
  providers.cache.clearAll(); providers.health.reset('free_nba');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/statistics/byathlete')) {
      return reply(espnPayload([{ id: 1, name: 'Alpha Guard' }, { id: 2, name: 'Bravo Center', overrides: { avgFieldGoalsAttempted: 22 } }, { id: 3, name: 'Charlie Wing', overrides: { avgFreeThrowsAttempted: 9 } }]));
    }
    if (u.includes('/injuries')) return reply({ injuries: [] });
    return reply({});
  };
});
afterEach(() => { global.fetch = originalFetch; if (savedTank === undefined) delete process.env.PROGM_TANK01_ENABLED; else process.env.PROGM_TANK01_ENABLED = savedTank; });

test('end to end: matched players get finite projections (before the fix: none), unmatched players stay "no data", never zero', async () => {
  const ctx = await buildProjectionContext({ season: '2026', players: yahooPlayers, statCategories: CATS, scoringSupported: scoringIsSupported(LEAGUE.settings) });
  assert.equal(ctx.externalAvailable, true);
  assert.equal(ctx.reason, null);
  assert.deepEqual(ctx.diagnostic.unsupportedScoringStats, []);
  const get = (key) => ctx.projectionByCanonicalId.get(key);
  close(get('466.p.1').projectedPoints, HAND);
  close(get('466.p.2').projectedPoints, HAND - 5 * 0.45, 0.02); // 22 FGA instead of 17
  close(get('466.p.3').projectedPoints, HAND - 2.5 * 0.75, 0.02); // 9 FTA instead of 6.5
  for (const key of ['466.p.1', '466.p.2', '466.p.3']) {
    assert.ok(Number.isFinite(get(key).projectedPoints));
    assert.equal(get(key).breakdown.length, 11);
    assert.ok(get(key).breakdown.find((b) => b.statId === 3).points < 0);
    assert.ok(get(key).breakdown.find((b) => b.statId === 6).points < 0);
  }
  const nobody = get('466.p.4');
  assert.equal(nobody.projectedPoints, null);
  assert.equal(nobody.method, 'no_data');
  assert.deepEqual(nobody.unsupportedStats, []);
});

test('end to end: the projections produce a RANKED draft board, with the unmatched player listed honestly as unprojected', async () => {
  const ctx = await buildProjectionContext({ season: '2026', players: yahooPlayers, statCategories: CATS, scoringSupported: true });
  const board = buildDraftBoard({ players: yahooPlayers, settings: LEAGUE.settings, projectionProvider: ctx.projectionProvider, poolComplete: true });
  assert.equal(board.available, true);
  assert.equal(board.board.length, 3);
  assert.deepEqual(board.board.map((r) => r.overallRank).sort(), [1, 2, 3]);
  assert.equal(board.board[0].playerKey, '466.p.1', 'the best FGA/FTA efficiency ranks first');
  assert.equal(board.noData.length, 1);
  assert.equal(board.noData[0].playerKey, '466.p.4');
  assert.match(board.noData[0].noDataReason, /No NBA stat line/);
});

test('message: a scoring stat the data cannot supply is NAMED in the reason, not reported as "no usable stats"', async () => {
  const league = normalizeLeagueSettings(yahooSettings([[9, '3PA', -0.25], [5, 'FG%', 1]]));
  const ctx = await buildProjectionContext({ season: '2026', players: yahooPlayers, statCategories: league.settings.statCategories, scoringSupported: true });
  assert.equal([...ctx.projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length, 0);
  assert.match(ctx.reason, /^Your league scores .*3PA/);
  assert.match(ctx.reason, /FG%/);
  assert.match(ctx.reason, /Nothing was estimated or set to zero/);
  assert.doesNotMatch(ctx.reason, /no usable stats/i);
  assert.deepEqual(ctx.diagnostic.unsupportedScoringStats.sort(), ['3PA', 'FG%']);
  // A weighted stat with no abbreviation is still identified (by id), never dropped.
  const noAbbr = await buildProjectionContext({ season: '2026', players: yahooPlayers, statCategories: [...CATS, { statId: 9, abbr: '', pointValue: -1, enabled: true }], scoringSupported: true });
  assert.match(noAbbr.reason, /stat #9/);
});

test('message: the per-player explanation lists the missing scoring stats', () => {
  assert.match(explainNoData({ method: 'incomplete_scoring_data', unsupportedStats: ['FGA', 'FTA'] }, {}), /does not supply \(FGA, FTA\), so points cannot be projected/);
  assert.match(explainNoData({ method: 'incomplete_scoring_data', unsupportedStats: ['9'] }, {}), /\(stat #9\)/);
  assert.match(explainNoData({ method: 'incomplete_scoring_data' }, {}), /league scoring uses a stat the data provider does not supply, so points/i);
});

test('Tank01 stays off throughout (no request to the paid API on any path)', async () => {
  process.env.RAPIDAPI_KEY = 'test-key';
  const hosts = [];
  const inner = global.fetch;
  global.fetch = async (url) => { hosts.push(new URL(String(url)).host); return inner(url); };
  try {
    await buildProjectionContext({ season: '2026', players: yahooPlayers, statCategories: CATS, scoringSupported: true });
  } finally { delete process.env.RAPIDAPI_KEY; }
  assert.ok(hosts.every((h) => !h.includes('rapidapi')), hosts.join(','));
});
