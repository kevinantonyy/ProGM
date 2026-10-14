import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard, computeDraftValue, DRAFT_WEIGHTS } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { loadBaselineReference, referenceKey, saveBaselineReference } from './baselineReference.js';
import { RANKING_MODELS, normalizeRankingModel, resolveRankingModel } from './rankingModel.js';
import { projectPlayer } from './projection.js';
import { emptyStatLine } from '../providers/types.js';

// Synthetic players only. Uneven positional supply so scarcity differs by position.
const SETTINGS = {
  teamCount: 2,
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};
const history = [{ season: 2025, gamesPlayed: 75, gameTotal: 82 }, { season: 2024, gamesPlayed: 75, gameTotal: 82 }, { season: 2023, gamesPlayed: 75, gameTotal: 82 }];
const player = (key, pos) => ({ playerKey: key, name: key, teamAbbr: 'AAA', eligiblePositions: [pos], percentOwned: 0, status: null });
const SPEC = { G1: ['PG', 45], G2: ['PG', 40], G3: ['PG', 30], G4: ['PG', 22], G5: ['PG', 15], C1: ['C', 42], C2: ['C', 29], C3: ['C', 25] };
const players = (keys = Object.keys(SPEC)) => keys.map((k) => player(k, SPEC[k][0]));
const provider = () => ({ getProjection: (p) => ({ projectedPoints: SPEC[p.playerKey][1], confidence: 0.9, history }) });
const analysis = (size) => ({ counts: { rosterSize: size }, positions: { thinPositions: [{ position: 'PG' }], overloadedPositions: [] } });
const board = (opts = {}) => buildDraftBoard({ players: players(), settings: SETTINGS, projectionProvider: provider(), ...opts });
const byKey = (b) => Object.fromEntries(b.board.map((r) => [r.playerKey, r]));

test('flag resolution: default A, B selectable, junk falls back to A', () => {
  assert.equal(resolveRankingModel({}), 'A');
  assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: '' }), 'A');
  assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: 'b' }), 'B');
  assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: ' B ' }), 'B');
  assert.equal(resolveRankingModel({ PROGM_RANKING_MODEL: 'C' }), 'A');
  assert.equal(normalizeRankingModel('__proto__'), 'A');
});

test('Variant A is unchanged: default equals explicit A and uses the production weights', () => {
  assert.deepEqual({ ...DRAFT_WEIGHTS }, { production: 0.70, replacement: 0.20, scarcity: 0.05, rosterFit: 0.05 });
  assert.deepEqual({ ...RANKING_MODELS.A.weights }, { ...DRAFT_WEIGHTS });
  const def = board();
  const a = board({ rankingModel: 'A' });
  assert.deepEqual(def.board.map((r) => [r.playerKey, r.value, r.baselineValue, r.overallRank]), a.board.map((r) => [r.playerKey, r.value, r.baselineValue, r.overallRank]));
  assert.equal(def.rankingModel, 'A');
  // Value equals the documented formula exactly.
  for (const r of def.board) {
    const c = r.components;
    const expected = (0.70 * c.production + 0.20 * c.replacement + 0.05 * c.scarcity + 0.05 * 0.5) * c.confidenceFactor * 100;
    assert.ok(Math.abs(r.value - expected) < 0.2, `${r.playerKey} ${r.value} vs ${expected}`);
  }
  assert.ok(def.board.some((r) => r.components.scarcity > 0), 'fixture must exercise scarcity');
});

test('Variant B removes only the scarcity contribution (no redistribution)', () => {
  const a = byKey(board({ rankingModel: 'A' }));
  const b = byKey(board({ rankingModel: 'B' }));
  assert.deepEqual({ ...RANKING_MODELS.B.weights }, { production: 0.70, replacement: 0.20, scarcity: 0, rosterFit: 0.05 });
  for (const k of Object.keys(SPEC)) {
    assert.equal(b[k].components.production, a[k].components.production);
    assert.equal(b[k].components.replacement, a[k].components.replacement);
    assert.equal(b[k].components.confidenceFactor, a[k].components.confidenceFactor);
    assert.equal(b[k].components.seasonPoints, a[k].components.seasonPoints);
    const expected = a[k].value - 5 * a[k].components.scarcity * a[k].components.confidenceFactor;
    assert.ok(Math.abs(b[k].value - expected) < 0.03, `${k}: B ${b[k].value} vs A-5*s*cf ${expected}`);
    assert.ok(b[k].value <= a[k].value + 1e-9);
  }
  // Directly: scarcity input cannot change B.
  const base = { seasonPoints: 3000, perGame: 40, expectedGames: 75, confidence: 0.9, eligiblePositions: ['C'], poolMaxSeasonPoints: 3500, replacement: { baselineByPos: { C: 2000 }, spread: 1500 }, rankingModel: 'B' };
  const lo = computeDraftValue({ ...base, weights: { C: 1.0, PG: 1.2 } });
  const hi = computeDraftValue({ ...base, weights: { C: 1.2, PG: 1.0 } });
  assert.equal(lo.value, hi.value);
  const aHi = computeDraftValue({ ...base, rankingModel: 'A', weights: { C: 1.2, PG: 1.0 } });
  const aLo = computeDraftValue({ ...base, rankingModel: 'A', weights: { C: 1.0, PG: 1.2 } });
  assert.ok(aHi.value > aLo.value);
});

test('empty roster keeps ProGM Rank equal to Draft Priority in both models; roster changes only priority', () => {
  for (const rankingModel of ['A', 'B']) {
    const empty = board({ rankingModel, rosterAnalysis: analysis(0) });
    assert.equal(empty.rosterPersonalized, false);
    for (const r of empty.board) {
      assert.equal(r.value, r.baselineValue);
      assert.equal(r.overallRank, r.draftPriority);
    }
    const rostered = board({ rankingModel, rosterAnalysis: analysis(3) });
    assert.deepEqual(byKey(rostered) && rostered.board.map((r) => [r.playerKey, r.overallRank]).sort(), empty.board.map((r) => [r.playerKey, r.overallRank]).sort());
  }
});

test('Rankings and Draft Helper share the selected model and overall ranks', () => {
  for (const rankingModel of ['A', 'B']) {
    const draft = board({ rankingModel });
    const overallRanks = new Map(draft.board.map((r) => [r.playerKey, r.overallRank]));
    const rankings = buildRankings({ players: players(), projectionProvider: provider(), overallRanks, rankScope: draft.rankScope, rankingModel: draft.rankingModel, sortBy: 'overall' });
    assert.equal(rankings.rankingModel, rankingModel);
    assert.equal(draft.rankingModel, rankingModel);
    for (const row of rankings.players) assert.equal(row.overallRank, byKey(draft)[row.playerKey].overallRank);
  }
  assert.equal(buildRankings({ players: players(), projectionProvider: provider() }).rankingModel, null);
});

test('league scoring still drives Variant B', () => {
  const line = (points, rebounds) => ({ ...emptyStatLine(), gamesPlayed: 70, points, rebounds, assists: 3 });
  const stats = { Scorer: line(30, 4), Rebounder: line(16, 14) };
  const run = (scoring) => {
    const map = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...projectPlayer({ stats: { season: v }, statCategories: scoring }), history }]));
    return buildDraftBoard({ players: [player('Scorer', 'PG'), player('Rebounder', 'C')], settings: SETTINGS, rankingModel: 'B', projectionProvider: { getProjection: (p) => map[p.playerKey] } });
  };
  const pts = [{ statId: 12, pointValue: 1, enabled: true }, { statId: 15, pointValue: 0.5, enabled: true }];
  const boards = [{ statId: 12, pointValue: 0.5, enabled: true }, { statId: 15, pointValue: 2, enabled: true }];
  assert.deepEqual(run(pts).board.map((r) => r.playerKey), ['Scorer', 'Rebounder']);
  assert.deepEqual(run(boards).board.map((r) => r.playerKey), ['Rebounder', 'Scorer']);
});

test('fallback rank labeling is unchanged under B (frozen vs available_players)', () => {
  const full = board({ rankingModel: 'B', poolComplete: true });
  assert.equal(full.rankScope, 'full_pool');
  assert.equal(full.baselineReference.model, 'B');
  const remaining = players(Object.keys(SPEC).slice(2));
  const live = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider(), rankingModel: 'B', baselineReference: full.baselineReference, availabilityOf: () => true });
  assert.equal(live.rankScope, 'full_pool');
  const unfrozen = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider(), rankingModel: 'B' });
  assert.equal(unfrozen.rankScope, 'available_players');
});

test('cache identity: A and B references never mix', () => {
  const sc = [{ statId: 12, pointValue: 1, enabled: true }];
  const ka = referenceKey({ leagueKey: 'L', season: '2025', statCategories: sc });
  const kaExplicit = referenceKey({ leagueKey: 'L', season: '2025', statCategories: sc, rankingModel: 'A' });
  const kb = referenceKey({ leagueKey: 'L', season: '2025', statCategories: sc, rankingModel: 'B' });
  assert.equal(ka, kaExplicit);
  assert.notEqual(ka, kb);
  const store = new Map();
  const cache = { get: (k) => (store.has(k) ? { value: store.get(k), meta: {} } : undefined), set: (k, v) => store.set(k, v) };
  saveBaselineReference(cache, ka, board({ rankingModel: 'A', poolComplete: true }).baselineReference);
  assert.equal(loadBaselineReference(cache, kb), null);
  // Defence in depth: a mismatched reference handed in directly is ignored.
  const refA = board({ rankingModel: 'A', poolComplete: true }).baselineReference;
  const viaB = board({ rankingModel: 'B', baselineReference: refA });
  const pure = board({ rankingModel: 'B' });
  assert.deepEqual(viaB.board.map((r) => [r.playerKey, r.overallRank]), pure.board.map((r) => [r.playerKey, r.overallRank]));
  assert.equal(viaB.rankScope, 'available_players');
});

test('production Variant B ordering equals the offline harness B ordering', async () => {
  const { rankVariants } = await import('./rankingValidation.js');
  const v = rankVariants({ players: players(), projectionProvider: provider(), settings: SETTINGS });
  const prod = board({ rankingModel: 'B' });
  assert.deepEqual(prod.board.map((r) => r.playerKey), v.B);
  const prodA = board({ rankingModel: 'A' });
  assert.deepEqual(prodA.board.map((r) => r.playerKey), v.A);
});
