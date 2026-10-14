import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard, describePriorityDifference, rankAmong } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { loadBaselineReference, referenceKey, saveBaselineReference } from './baselineReference.js';
import { projectPlayer } from './projection.js';
import { emptyStatLine } from '../providers/types.js';

// Synthetic players only.
const SETTINGS = {
  teamCount: 2,
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};
const history = [{ season: 2025, gamesPlayed: 75, gameTotal: 82 }, { season: 2024, gamesPlayed: 75, gameTotal: 82 }, { season: 2023, gamesPlayed: 75, gameTotal: 82 }];
const player = (key, pos) => ({ playerKey: key, name: key, teamAbbr: 'AAA', eligiblePositions: [pos], percentOwned: 0, status: null });
const SPEC = { G1: ['PG', 45], G2: ['PG', 40], G3: ['PG', 30], G4: ['PG', 22], C1: ['C', 42], C2: ['C', 29], C3: ['C', 25], C4: ['C', 18] };
const players = (keys = Object.keys(SPEC)) => keys.map((k) => player(k, SPEC[k][0]));
const provider = (override = {}) => ({
  getProjection: (p) => ({ projectedPoints: override[p.playerKey] ?? SPEC[p.playerKey][1], confidence: 0.9, history }),
});
const analysis = (size, thin = []) => ({ counts: { rosterSize: size }, positions: { thinPositions: thin.map((position) => ({ position })), overloadedPositions: [] } });
const board = (opts = {}) => buildDraftBoard({ players: players(), settings: SETTINGS, projectionProvider: provider(), ...opts });
const ranks = (b) => Object.fromEntries(b.board.map((r) => [r.playerKey, r.overallRank]));

test('empty roster: Overall Rank and Draft Priority are identical in valuation and ordering', () => {
  const b = board({ rosterAnalysis: analysis(0, ['PG']) });
  assert.equal(b.rosterPersonalized, false);
  for (const row of b.board) {
    assert.equal(row.value, row.baselineValue);
    assert.equal(row.overallRank, row.draftPriority);
    assert.equal(row.priorityNote, null); // no roster yet: recommendations follow ProGM Rank
  }
  // Same without any roster analysis at all.
  const none = board();
  assert.deepEqual(none.board.map((r) => r.playerKey), b.board.map((r) => r.playerKey));
});

test('roster composition changes Draft Priority but never Overall Rank', () => {
  const empty = board({ rosterAnalysis: analysis(0, ['PG']) });
  const needPg = board({ rosterAnalysis: analysis(3, ['PG']) });
  const needC = board({ rosterAnalysis: analysis(3, ['C']) });
  assert.deepEqual(ranks(needPg), ranks(empty));
  assert.deepEqual(ranks(needC), ranks(empty));
  const order = (b) => b.board.map((r) => r.playerKey).join();
  assert.notEqual(order(needPg), order(needC)); // priority order is roster-aware
  assert.equal(needPg.rosterPersonalized, true);
  // A player is moved only by fit, and the board says why.
  const moved = needPg.board.find((r) => r.priorityNote);
  assert.ok(moved);
  assert.match(moved.priorityNote, /^Roster fit: .*(higher|lower) than ProGM Rank alone\.$/);
  assert.doesNotMatch(moved.priorityNote, /#|\d/); // explanation in words only: never a second rank
  assert.ok(needPg.board.every((r) => r.overallRank != null));
  // Fit stays secondary: the clearly best player is still first in both orders.
  assert.equal(needC.board[0].playerKey, 'G1');
});

test('other teams drafting players does not change baseline Overall Rank when a frozen reference is used', () => {
  const full = board({ poolComplete: true });
  assert.equal(full.rankScope, 'full_pool');
  const reference = full.baselineReference;
  const drafted = ['G1', 'C1', 'G2'];
  const remaining = players(Object.keys(SPEC).filter((k) => !drafted.includes(k)));
  const live = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider(), baselineReference: reference, availabilityOf: () => true });
  assert.equal(live.rankScope, 'full_pool');
  for (const row of live.board) assert.equal(row.overallRank, ranks(full)[row.playerKey], row.playerKey);
  // Draft Priority is position among those still available.
  assert.deepEqual(live.board.map((r) => r.draftPriority), live.board.map((_, i) => i + 1));
  // Without the reference the same players' ranks shift and are labelled relative to available players.
  const unfrozen = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider() });
  assert.equal(unfrozen.rankScope, 'available_players');
  assert.notDeepEqual(unfrozen.board.map((r) => r.overallRank), live.board.map((r) => r.overallRank));
});

test('Rankings and Draft Helper agree on Overall Rank for the same pool', () => {
  const pool = players();
  const draft = buildDraftBoard({ players: pool, settings: SETTINGS, projectionProvider: provider(), rosterAnalysis: analysis(2, ['C']) });
  const overallRanks = new Map(draft.board.map((r) => [r.playerKey, r.overallRank]));
  const rankings = buildRankings({ players: pool, projectionProvider: provider(), overallRanks, rankScope: draft.rankScope, sortBy: 'overall' });
  assert.equal(rankings.sortBy, 'overall');
  for (const row of rankings.players) assert.equal(row.overallRank, draft.board.find((r) => r.playerKey === row.playerKey).overallRank);
  assert.deepEqual(rankings.players.map((r) => r.overallRank), [...rankings.players.map((r) => r.overallRank)].sort((a, b) => a - b));
  assert.equal(rankings.rankScope, 'available_players');
});

test('availability filters apply after ranking and affect both tabs consistently', () => {
  const pool = players();
  const withOut = pool.map((p) => (p.playerKey === 'G2' ? { ...p, status: 'OUT' } : p));
  const draft = buildDraftBoard({ players: withOut, settings: SETTINGS, projectionProvider: provider() });
  const overallRanks = new Map(draft.board.map((r) => [r.playerKey, r.overallRank]));
  const baseOrder = Object.keys(ranks(draft));
  assert.ok(baseOrder.includes('G2')); // still ranked on the board (flagged OUT)
  const rankings = buildRankings({ players: withOut, projectionProvider: provider(), overallRanks, sortBy: 'overall' });
  assert.ok(!rankings.players.some((r) => r.playerKey === 'G2')); // hidden by the OUT filter
  // Hiding G2 leaves everybody else's Overall Rank untouched.
  for (const row of rankings.players) assert.equal(row.overallRank, ranks(draft)[row.playerKey]);
  const included = buildRankings({ players: withOut, projectionProvider: provider(), overallRanks, sortBy: 'overall', includeOut: true });
  assert.equal(included.players.find((r) => r.playerKey === 'G2').overallRank, ranks(draft).G2);
  // A real availability difference (fewer expected games) changes the rank in both views alike.
  const injured = buildDraftBoard({ players: players(), settings: SETTINGS, projectionProvider: { getProjection: (p) => ({ projectedPoints: SPEC[p.playerKey][1], confidence: 0.9, history: p.playerKey === 'G2' ? [{ season: 2025, gamesPlayed: 20, gameTotal: 82 }, { season: 2024, gamesPlayed: 25, gameTotal: 82 }, { season: 2023, gamesPlayed: 22, gameTotal: 82 }] : history }) } });
  assert.ok(ranks(injured).G2 > ranks(board()).G2);
});

test('league scoring changes Overall Rank appropriately', () => {
  const line = (points, rebounds) => ({ ...emptyStatLine(), gamesPlayed: 70, points, rebounds, assists: 3 });
  const stats = { Scorer: line(30, 4), Rebounder: line(16, 14) };
  const run = (scoring) => {
    const map = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...projectPlayer({ stats: { season: v }, statCategories: scoring }), history }]));
    const pool = [player('Scorer', 'PG'), player('Rebounder', 'C')];
    return buildDraftBoard({ players: pool, settings: SETTINGS, projectionProvider: { getProjection: (p) => map[p.playerKey] } });
  };
  const pts = [{ statId: 12, pointValue: 1, enabled: true }, { statId: 15, pointValue: 0.5, enabled: true }];
  const boards = [{ statId: 12, pointValue: 0.5, enabled: true }, { statId: 15, pointValue: 2, enabled: true }];
  assert.deepEqual(run(pts).board.map((r) => [r.playerKey, r.overallRank]), [['Scorer', 1], ['Rebounder', 2]]);
  assert.deepEqual(run(boards).board.map((r) => [r.playerKey, r.overallRank]), [['Rebounder', 1], ['Scorer', 2]]);
});

test('existing per-game and period sorts still work', () => {
  const periodProvider = {
    ...provider(),
    getPeriodValue: (p) => ({ scheduleAware: true, periodProjectedPoints: { G1: 10, G2: 99, G3: 50, G4: 5, C1: 20, C2: 30, C3: 40, C4: 1 }[p.playerKey], expectedGames: 3 }),
  };
  const overallRanks = new Map([['G1', 1], ['C1', 2]]);
  const byProjected = buildRankings({ players: players(), projectionProvider: periodProvider, overallRanks, sortBy: 'projected' });
  assert.deepEqual(byProjected.players.slice(0, 3).map((r) => r.playerKey), ['G1', 'C1', 'G2']);
  const byPeriod = buildRankings({ players: players(), projectionProvider: periodProvider, overallRanks, sortBy: 'period' });
  assert.deepEqual(byPeriod.players.slice(0, 2).map((r) => r.playerKey), ['G2', 'G3']);
  const byOverall = buildRankings({ players: players(), projectionProvider: periodProvider, overallRanks, sortBy: 'overall' });
  assert.deepEqual(byOverall.players.slice(0, 2).map((r) => r.playerKey), ['G1', 'C1']);
  // Without overall ranks the default behaviour is unchanged.
  assert.equal(buildRankings({ players: players(), projectionProvider: periodProvider }).players[0].overallRank, null);
});

test('rank helper, priority note and reference cache behave', () => {
  assert.equal(rankAmong([50, 40, 40, 10], 40), 2);
  assert.equal(rankAmong([50, 40, 40, 10], 45), 2);
  assert.equal(rankAmong([50, 40, 40, 10], 5), 5);
  assert.equal(rankAmong([50], null), null);
  assert.equal(describePriorityDifference({ personalized: true, poolPosition: 5, draftPriority: 3, fit: 'need' }), 'Roster fit: fills a thin position on your roster, so draft recommendations rate this player slightly higher than ProGM Rank alone.');
  assert.equal(describePriorityDifference({ personalized: false, poolPosition: 5, draftPriority: 3, fit: 'need' }), null);
  assert.equal(describePriorityDifference({ personalized: true, poolPosition: 3, draftPriority: 3, fit: 'need' }), null);

  const store = new Map();
  const cache = { get: (k) => (store.has(k) ? { value: store.get(k), meta: { stale: false } } : null), set: (k, v) => store.set(k, v) };
  const key = referenceKey({ leagueKey: '1.l.1', season: 2026, statCategories: [{ statId: 12, pointValue: 1 }] });
  assert.notEqual(key, referenceKey({ leagueKey: '1.l.1', season: 2026, statCategories: [{ statId: 12, pointValue: 2 }] }));
  saveBaselineReference(cache, key, { complete: false, values: [1] }); // partial pools are never frozen
  assert.equal(loadBaselineReference(cache, key), null);
  saveBaselineReference(cache, key, { complete: true, values: [3] });
  saveBaselineReference(cache, key, { complete: true, values: [9] }); // first complete capture wins
  assert.deepEqual(loadBaselineReference(cache, key).values, [3]);
});

test('live draft with an empty roster: Draft Priority order equals Overall order, even after others draft', () => {
  const full = board({ poolComplete: true });
  const drafted = ['C1', 'G3', 'C4'];
  const remaining = players(Object.keys(SPEC).filter((k) => !drafted.includes(k)));
  const common = { players: remaining, settings: SETTINGS, projectionProvider: provider(), rosterAnalysis: analysis(0, ['PG', 'C']), availabilityOf: () => true };
  for (const baselineReference of [full.baselineReference, null]) {
    const live = buildDraftBoard({ ...common, baselineReference });
    assert.equal(live.rosterPersonalized, false);
    // Same valuation and ordering.
    assert.ok(live.board.every((r) => r.value === r.baselineValue));
    const byPriority = live.board.map((r) => r.playerKey);
    const byOverall = [...live.board].sort((a, b) => a.overallRank - b.overallRank || a.draftPriority - b.draftPriority).map((r) => r.playerKey);
    assert.deepEqual(byPriority, byOverall);
    assert.ok(live.board.every((r, i) => i === 0 || live.board[i - 1].overallRank <= r.overallRank));
    // Displayed numbers may differ (stable reference rank vs position among available), never the order.
    assert.deepEqual(live.board.map((r) => r.draftPriority), live.board.map((_, i) => i + 1));
  }
  // The frozen reference gives the stable full-pool numbers; the unfrozen one is labelled relative.
  const frozen = buildDraftBoard({ ...common, baselineReference: full.baselineReference });
  assert.equal(frozen.rankScope, 'full_pool');
  assert.ok(frozen.board.some((r) => r.overallRank !== r.draftPriority));
  assert.equal(buildDraftBoard({ ...common }).rankScope, 'available_players');
});

test('recommendations, market labels and rank gaps use the displayed ProGM Rank, with roster fit explained in words', () => {
  const full = board({ poolComplete: true });
  const withYahoo = (rows) => rows.map((p) => ({ ...p, yahooAdp: 6, yahooOverallRank: 6 }));
  const drafted = ['G1', 'C1'];
  const remaining = withYahoo(players(Object.keys(SPEC).filter((k) => !drafted.includes(k))));
  const live = buildDraftBoard({ players: remaining, settings: SETTINGS, projectionProvider: provider(), baselineReference: full.baselineReference, rosterAnalysis: analysis(3, ['PG']), availabilityOf: () => true });
  for (const row of live.board) {
    assert.equal(row.overallRank, ranks(full)[row.playerKey]); // the number shown as ProGM Rank
    const quoted = row.recommendation.match(/ProGM Rank #(\d+)/);
    if (quoted) assert.equal(Number(quoted[1]), row.overallRank); // never the board position
    if (row.marketReason && /ProGM #/.test(row.marketReason)) assert.match(row.marketReason, new RegExp(`ProGM #${row.overallRank}\\b`));
    assert.equal(row.rankGap, 6 - row.overallRank); // Yahoo rank is compared with the same ProGM Rank
  }
  // Roster fit is explained in words and the personalized order never replaces the rank.
  assert.ok(live.board.some((r) => r.priorityNote && !/\d/.test(r.priorityNote)));
  const stripped = live.board.map((r) => r.overallRank);
  assert.deepEqual([...stripped].sort((a, b) => a - b), [...new Set(stripped)].sort((a, b) => a - b));
});

test('board: DRAFT NOW/WAIT follow roster-aware draft priority while ProGM Rank stays fixed', () => {
  const withAdp = (adp) => players().map((p) => ({ ...p, yahooAdp: adp[p.playerKey] ?? null }));
  const adp = { G1: 1, G2: 2, G3: 14, G4: 20, C1: 3, C2: 12, C3: 22, C4: 30 };
  const run = (rosterAnalysis) => buildDraftBoard({ players: withAdp(adp), settings: SETTINGS, projectionProvider: provider(), rosterAnalysis, availabilityOf: () => true, currentPick: 1, nextPick: 12 });
  const empty = run(analysis(0));
  const needC = run(analysis(3, ['C']));
  const needPg = run(analysis(3, ['PG']));
  // ProGM Rank and the market VALUE gap (adpVsProgm) never depend on the roster.
  assert.deepEqual(ranks(needC), ranks(empty));
  assert.deepEqual(needC.board.map((r) => [r.playerKey, r.adpVsProgm]).sort(), empty.board.map((r) => [r.playerKey, r.adpVsProgm]).sort());
  // Actionable labels respond to roster context: C2 is priority #4 when C is thin, #5 when PG is.
  const c2 = (b) => b.board.find((r) => r.playerKey === 'C2');
  assert.equal(c2(needC).overallRank, c2(needPg).overallRank);
  assert.equal(c2(needC).adpVsProgm, c2(needPg).adpVsProgm);
  assert.equal(c2(needC).marketLabel, 'WAIT');
  assert.notEqual(c2(needPg).marketLabel, 'WAIT');
});
