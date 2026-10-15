import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard, computeDraftValue, DRAFT_WEIGHTS, explainNoData } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { loadBaselineReference, referenceKey, saveBaselineReference } from './baselineReference.js';
import { RANKING_MODELS, normalizeRankingModel, rankingProfile, resolveRankingModel, resolveRookieEstimates } from './rankingModel.js';
import { withEstimates, canonicalIdOf } from './insights.js';
import { makeProjectionProvider, projectPlayer } from './projection.js';
import { applyMarketPriors } from './marketPrior.js';
import { emptyStatLine } from '../providers/types.js';

// Synthetic players only.
const SETTINGS = { teamCount: 2, rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 75, gameTotal: 82 }));
const player = (key, pos, extra = {}) => ({ playerKey: key, name: key, teamAbbr: 'AAA', eligiblePositions: [pos], percentOwned: 0, status: null, ...extra });
const SPEC = { G1: ['PG', 45], G2: ['PG', 40], G3: ['PG', 30], G4: ['PG', 22], G5: ['PG', 15], C1: ['C', 42], C2: ['C', 29], C3: ['C', 25] };
const players = () => Object.keys(SPEC).map((k) => player(k, SPEC[k][0]));
const provider = () => ({ getProjection: (p) => (SPEC[p.playerKey] ? { projectedPoints: SPEC[p.playerKey][1], confidence: 0.9, history } : null) });
const analysis = (size) => ({ counts: { rosterSize: size }, positions: { thinPositions: [{ position: 'PG' }], overloadedPositions: [] } });
const board = (opts = {}) => buildDraftBoard({ players: players(), settings: SETTINGS, projectionProvider: provider(), ...opts });
const byKey = (b) => Object.fromEntries(b.board.map((r) => [r.playerKey, r]));

test('flags default OFF and only exact documented values enable them', () => {
  assert.equal(resolveRankingModel({}), 'legacy');
  for (const bad of ['', 'V2x', 'B', 'on', 'true', undefined]) assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: bad }), 'legacy');
  assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: ' V2 ' }), 'v2');
  assert.equal(normalizeRankingModel('__proto__'), 'legacy');
  assert.equal(resolveRookieEstimates({}), false);
  for (const v of ['off', '', 'no', 'maybe']) assert.equal(resolveRookieEstimates({ PROGM_ROOKIE_ESTIMATES: v }), false);
  for (const v of ['on', 'TRUE', '1']) assert.equal(resolveRookieEstimates({ PROGM_ROOKIE_ESTIMATES: v }), true);
  assert.equal(rankingProfile({}), 'legacy.noest');
  assert.equal(rankingProfile({ PROGM_RANKING_MODEL: 'v2', PROGM_ROOKIE_ESTIMATES: 'on' }), 'v2.est');
});

test('legacy stays the production model: default equals explicit legacy and the documented weights', () => {
  assert.deepEqual({ ...DRAFT_WEIGHTS }, { production: 0.70, replacement: 0.20, scarcity: 0.05, rosterFit: 0.05 });
  const d = board(), l = board({ rankingModel: 'legacy' });
  assert.deepEqual(d.board.map((r) => [r.playerKey, r.value, r.overallRank]), l.board.map((r) => [r.playerKey, r.value, r.overallRank]));
  assert.equal(d.rankingModel, 'legacy');
  for (const r of d.board) {
    const c = r.components;
    assert.ok(Math.abs(r.value - (0.70 * c.production + 0.20 * c.replacement + 0.05 * c.scarcity + 0.05 * 0.5) * c.confidenceFactor * 100) < 0.2);
  }
  assert.ok(d.board.some((r) => r.components.scarcity > 0));
});

test('v2 removes only the scarcity term and moves its weight to production', () => {
  assert.deepEqual({ ...RANKING_MODELS.v2.weights }, { production: 0.75, replacement: 0.20, scarcity: 0, rosterFit: 0.05 });
  assert.ok(Math.abs(Object.values(RANKING_MODELS.v2.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const v2 = board({ rankingModel: 'v2' });
  assert.equal(v2.rankingModel, 'v2');
  for (const r of v2.board) {
    const c = r.components;
    assert.ok(Math.abs(r.value - (0.75 * c.production + 0.20 * c.replacement + 0.05 * 0.5) * c.confidenceFactor * 100) < 0.2);
  }
  const base = { seasonPoints: 3000, perGame: 40, expectedGames: 75, confidence: 0.9, eligiblePositions: ['C'], poolMaxSeasonPoints: 3500, replacement: { baselineByPos: { C: 2000 }, spread: 1500 } };
  const lo = computeDraftValue({ ...base, rankingModel: 'v2', weights: { C: 1.0, PG: 1.2 } });
  const hi = computeDraftValue({ ...base, rankingModel: 'v2', weights: { C: 1.2, PG: 1.0 } });
  assert.equal(lo.value, hi.value);
  assert.ok(computeDraftValue({ ...base, weights: { C: 1.2, PG: 1.0 } }).value > computeDraftValue({ ...base, weights: { C: 1.0, PG: 1.2 } }).value);
});

test('empty roster: ProGM Rank equals Draft Priority in both models; roster changes only priority', () => {
  for (const rankingModel of ['legacy', 'v2']) {
    const empty = board({ rankingModel, rosterAnalysis: analysis(0) });
    assert.equal(empty.rosterPersonalized, false);
    for (const r of empty.board) { assert.equal(r.value, r.baselineValue); assert.equal(r.overallRank, r.draftPriority); }
    const rostered = board({ rankingModel, rosterAnalysis: analysis(3) });
    assert.deepEqual(rostered.board.map((r) => [r.playerKey, r.overallRank]).sort(), empty.board.map((r) => [r.playerKey, r.overallRank]).sort());
  }
});

test('Rankings tab and Draft Helper share the same baseline ProGM Rank (both models, frozen and unfrozen)', () => {
  for (const rankingModel of ['legacy', 'v2']) {
    const full = board({ rankingModel, poolComplete: true });
    const remaining = players().slice(2);
    for (const baselineReference of [null, full.baselineReference]) {
      const draft = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider(), rankingModel, baselineReference, availabilityOf: () => true });
      const overallRanks = new Map(draft.board.map((r) => [r.playerKey, r.overallRank]));
      const rankings = buildRankings({ players: remaining, projectionProvider: provider(), overallRanks, rankScope: draft.rankScope, rankingModel: draft.rankingModel, sortBy: 'overall' });
      assert.equal(rankings.rankingModel, rankingModel);
      assert.equal(rankings.rankScope, draft.rankScope);
      for (const row of rankings.players) assert.equal(row.overallRank, byKey(draft)[row.playerKey].overallRank);
    }
  }
});

test('fallback rank labelling is unchanged under v2', () => {
  const full = board({ rankingModel: 'v2', poolComplete: true });
  assert.equal(full.rankScope, 'full_pool');
  assert.equal(full.baselineReference.model, 'v2');
  assert.equal(buildDraftBoard({ players: players().slice(2), settings: SETTINGS, projectionProvider: provider(), rankingModel: 'v2' }).rankScope, 'available_players');
});

test('league scoring still drives v2', () => {
  const history2 = history; const line = (points, rebounds) => ({ ...emptyStatLine(), gamesPlayed: 70, points, rebounds, assists: 3 });
  const stats = { Scorer: line(30, 4), Rebounder: line(16, 14) };
  const run = (scoring) => {
    const map = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...projectPlayer({ stats: { season: v }, statCategories: scoring }), history: history2 }]));
    return buildDraftBoard({ players: [player('Scorer', 'PG'), player('Rebounder', 'C')], settings: SETTINGS, rankingModel: 'v2', projectionProvider: { getProjection: (p) => map[p.playerKey] } });
  };
  assert.deepEqual(run([{ statId: 12, pointValue: 1, enabled: true }, { statId: 15, pointValue: 0.5, enabled: true }]).board.map((r) => r.playerKey), ['Scorer', 'Rebounder']);
  assert.deepEqual(run([{ statId: 12, pointValue: 0.5, enabled: true }, { statId: 15, pointValue: 2, enabled: true }]).board.map((r) => r.playerKey), ['Rebounder', 'Scorer']);
});

test('cache identity: profile is part of the reference key and a mismatched reference is ignored', () => {
  const sc = [{ statId: 12, pointValue: 1, enabled: true }];
  const key = (profile) => referenceKey({ leagueKey: 'L', season: '2025', statCategories: sc, profile });
  assert.notEqual(key('legacy.noest'), key('v2.noest'));
  assert.notEqual(key('legacy.noest'), key('legacy.est'));
  const store = new Map();
  const cache = { get: (k) => (store.has(k) ? { value: store.get(k), meta: {} } : undefined), set: (k, v) => store.set(k, v) };
  saveBaselineReference(cache, key('legacy.noest'), board({ poolComplete: true }).baselineReference);
  assert.equal(loadBaselineReference(cache, key('v2.noest')), null);
  const refLegacy = board({ rankingModel: 'legacy', poolComplete: true }).baselineReference;
  const viaV2 = board({ rankingModel: 'v2', baselineReference: refLegacy });
  assert.equal(viaV2.rankScope, 'available_players');
  assert.deepEqual(viaV2.board.map((r) => [r.playerKey, r.overallRank]), board({ rankingModel: 'v2' }).board.map((r) => [r.playerKey, r.overallRank]));
});

test('no-data reasons are explicit and honest about missing draft position', () => {
  const noStats = { method: 'no_data' };
  assert.match(explainNoData(noStats, { yahooAdp: null }, { rookieEstimates: false }), /no draft position or historical data.*turned off/is);
  assert.match(explainNoData(noStats, { yahooAdp: null }, { rookieEstimates: true }), /No Yahoo ADP/);
  assert.match(explainNoData(noStats, { yahooAdp: 700 }, { rookieEstimates: true }), /outside the range/);
  assert.match(explainNoData({ method: 'incomplete_scoring_data' }, {}), /league scoring/i);
  const b = buildDraftBoard({ players: [...players(), player('X1', 'PG')], settings: SETTINGS, projectionProvider: provider(), rookieEstimates: false });
  assert.equal(b.noData.find((r) => r.playerKey === 'X1').noDataReason.includes('turned off'), true);
});

test('estimates are isolated: stats-only consumers never see them, draft views do, flags stay explicit', () => {
  const vets = Array.from({ length: 60 }, (_, i) => ({ key: `V${i + 1}`, adp: i + 1, pg: 60 - 8 * Math.log(i + 1) }));
  const statProj = (v) => ({ projectedPoints: v.pg, perGame: v.pg, confidence: 0.9, method: 'season_only', lastSeason: { season: 2025, stats: { gamesPlayed: 70 } } });
  const roster = [...vets.map((v) => player(v.key, 'PG', { yahooAdp: v.adp })), player('R1', 'PG', { yahooAdp: 20 })];
  const map = new Map(vets.map((v) => [v.key, statProj(v)])); map.set('R1', { projectedPoints: null, method: 'no_data' });
  const canonical = roster.map((p) => ({ canonicalId: p.playerKey, matched: map.get(p.playerKey).projectedPoints != null, matchMethod: null }));
  const withEst = new Map(map); applyMarketPriors({ canonical, players: roster, projectionByCanonicalId: withEst, canonicalIdOf, seasonYear: 2026 });
  const estimates = new Map([...withEst].filter(([, p]) => p.estimate === true));
  assert.equal(map.get('R1').projectedPoints, null, 'stats map untouched');
  const base = makeProjectionProvider({ projectionByCanonicalId: map, canonicalIdOf });
  const draft = withEstimates(base, estimates);
  const r1 = roster.find((p) => p.playerKey === 'R1');
  assert.equal(base.getProjectedValue(r1), null);
  assert.equal(draft.getProjectedValue(r1), null);                    // waivers/trades/lineups stay stats-only
  assert.equal(draft.getProjection(r1).estimate, true);
  assert.ok(draft.getProjection(r1).confidence <= 0.3);
  assert.equal(withEstimates(base, new Map()), base);                  // flag off: provider returned untouched
});
