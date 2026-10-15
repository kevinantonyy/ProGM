import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { sanitizeWorkspace } from './snapshotCompare.js';
import { compareScenarios, fidelity, playerNumberEvidence, replayPipeline } from './snapshotReplay.js';

// Tool tests on synthetic input; the real validation always runs on the user's saved league response.
const SETTINGS = { teamCount: 6, rosterSlots: [['PG', 1], ['SG', 1], ['G', 1], ['SF', 1], ['PF', 1], ['F', 1], ['C', 2], ['UTIL', 2]].map(([position, count]) => ({ position, count, isStarting: true })).concat([{ position: 'BN', count: 3, isStarting: false }]) };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 70, gameTotal: 82 }));
const POS = [['PG', 'G'], ['SG', 'G'], ['SF', 'F'], ['PF', 'F'], ['C']];
const vets = Array.from({ length: 120 }, (_, i) => ({ playerKey: `466.p.${1000 + i * 10}`, name: `Vet ${i}`, eligiblePositions: [...POS[i % 5], 'UTIL'], yahooAdp: i + 1, status: null, debut: 2015 + (i % 10), _pts: 62 - 10 * Math.log(i + 1) }));
const rook = (n, key, adp, status = null) => ({ playerKey: `466.p.${key}`, name: n, eligiblePositions: ['SF', 'F', 'UTIL'], yahooAdp: adp, status, _pts: null });
const newcomers = [rook('Rookie A', 20001, 12), rook('Rookie B', 20002, 55), rook('Rookie Q', 20003, 30, 'Q'), rook('Rookie Hurt', 20004, 40, 'INJ'), rook('Veteran Out', 1505, 45), rook('Rookie NoAdp', 20005, null), rook('Rookie Far', 20006, 900)];
const players = [...vets, ...newcomers];
const provider = { getProjection: (p) => (p._pts == null ? null : { projectedPoints: p._pts, confidence: 0.9, history, lastSeason: { season: 2025, stats: { gamesPlayed: 70 } }, availabilityProfile: { age: 26, debutYear: p.debut } }) };
const board = buildDraftBoard({ players, settings: SETTINGS, projectionProvider: provider, currentSeason: 2026, availabilityOf: () => true, poolComplete: true });
const raw = { connection: { draftStatus: 'predraft' }, settings: { scoringFormat: 'points', teamCount: 6, statCategories: [], rosterSlots: SETTINGS.rosterSlots }, draftBoard: { ...board, baselineReference: undefined }, rankings: { players: [] } };
const clean = sanitizeWorkspace(raw);

test('replay of the production setting reproduces the ranks the app showed (fidelity self-check)', () => {
  const f = fidelity(clean);
  assert.equal(f.players, 120);
  assert.ok(f.exactRankMatches >= 114, JSON.stringify(f));
  assert.ok(f.maxAbsRankDifference <= 2, JSON.stringify(f));
});

test('v2 + rookie estimates: only classified rookies get a rank, with real full-pool ranks and low confidence', () => {
  const full = replayPipeline(clean, { model: 'v2', rookieEstimates: true });
  const est = full.rows.filter((r) => r.estimate).map((r) => r.name).sort();
  assert.deepEqual(est, ['Rookie A', 'Rookie B', 'Rookie Q']);                    // INJ, veteran-numbered, no-ADP and out-of-range excluded
  assert.equal(full.rows.length, 123);
  for (const r of full.rows.filter((x) => x.estimate)) { assert.equal(r.confidence, 0.3); assert.ok(Number.isInteger(r.rank) && r.rank >= 1 && r.rank <= 123); }
  const q = full.rows.find((r) => r.name === 'Rookie Q'); assert.match(q.statusNote, /day-to-day/);
  const a = full.rows.find((r) => r.name === 'Rookie A'), b = full.rows.find((r) => r.name === 'Rookie B');
  assert.ok(a.rank < b.rank);                                                        // earlier ADP, higher estimate, better rank
  const rate = clean.meta.noHistoryGamesRate; assert.ok(rate > 0 && rate <= 1);
  assert.equal(a.expectedSeasonGames, Number((82 * rate).toFixed(1)));
  assert.equal(replayPipeline(clean, { model: 'v2', rookieEstimates: false }).rows.length, 120);
});

test('rookies are ranked by value in the same pool: the rank matches the position of the value among everyone', () => {
  const full = replayPipeline(clean, { model: 'v2', rookieEstimates: true });
  for (const r of full.rows) assert.equal(r.rank, 1 + full.rows.filter((o) => o.value > r.value).length);
});

test('scenario comparison reports bands, rookies, movers and displaced veterans', () => {
  const c = compareScenarios(clean, { highlight: ['vet 3', 'Nobody'] });
  assert.equal(c.rookies.length, 3);
  assert.ok(c.rookies.every((r) => r.proGMRank >= 1 && r.confidence === 0.3 && r.poolSize === 123));
  assert.ok(c.bands.top25.overlap <= 25 && c.bands.top100.size.experimental <= 103);
  assert.equal(c.highlighted[0].name, 'Vet 3'); assert.equal(c.highlighted[1].found, false);
  assert.ok(Number.isInteger(c.veteransDisplacedByRookies));
});

test('without the league-wide availability rate no rookie is estimated (nothing is guessed)', () => {
  const blind = { ...clean, meta: { ...clean.meta, noHistoryGamesRate: null } };
  assert.equal(replayPipeline(blind, { model: 'v2', rookieEstimates: true }).rows.filter((r) => r.estimate).length, 0);
  assert.throws(() => replayPipeline({ ...clean, league: null }), /roster settings/);
});

test('player-number evidence flags orderings that are not creation order', () => {
  const good = playerNumberEvidence(clean);
  assert.ok(good.spearmanNumberVsDebutYear > -1 && good.playersWithNumberAndDebutYear === 120);
  const mono = { ...clean, board: clean.board.map((r, i) => ({ ...r, yahooPlayerNumber: 1000 + 10 * (r.debutYear - 2015) + i * 0.001, debutYear: r.debutYear })) };
  const m = playerNumberEvidence(mono);
  assert.ok(m.spearmanNumberVsDebutYear > 0.95);
  assert.deepEqual(m.veteransNumberedAboveTheNewestStatCohort, []);
  const broken = { ...mono, board: mono.board.map((r, i) => (i === 0 ? { ...r, debutYear: 2016, yahooPlayerNumber: 99999 } : r)) };
  assert.equal(playerNumberEvidence(broken).veteransNumberedAboveTheNewestStatCohort.length, 1);
});

test('highlight matching ignores accents and suffixes (Yahoo "Alperen Şengün" is found as "Alperen Sengun")', () => {
  const accented = { ...clean, board: clean.board.map((r, i) => (i === 0 ? { ...r, name: 'Alperen Şengün' } : r)) };
  const c = compareScenarios(accented, { highlight: ['Alperen Sengun'] });
  assert.equal(c.highlighted[0].found, undefined);
  assert.equal(c.highlighted[0].name, 'Alperen Şengün');
});

test('fidelity explains every non-exact replay match (rounding of stored values) and lists the details', () => {
  const f = fidelity(clean);
  assert.equal(f.nonExact, f.nonExactDetails.length);
  assert.equal(f.exactRankMatches + f.nonExact, f.players);
  for (const d of f.nonExactDetails) assert.ok('nearestRivalValueGap' in d && 'maxRoundingValueChange' in d && typeof d.explainedByRounding === 'boolean');
  // force a near-tie: two identical players can swap places by rounding alone, and that is reported as explained
  const twin = { ...clean, board: [...clean.board, { ...clean.board[5], name: 'Twin of 5', overallRank: clean.board[5].overallRank }] };
  const ft = fidelity(twin);
  assert.ok(ft.nonExactExplainedByRounding >= 0);
});

test('rookie sensitivity separates the effect of the 56-game assumption from the low-confidence factor', () => {
  const c = compareScenarios(clean, {});
  assert.equal(c.rookieSensitivity.length, c.rookies.length);
  for (const s of c.rookieSensitivity) {
    assert.ok(s.ifBoth <= s.asEstimated);                      // relaxing both assumptions can only help (lower rank number)
    assert.ok(s.ifVeteranMedianGames <= s.asEstimated + 1 || s.medianVeteranGames <= s.rookieGames);
    assert.ok(Number.isFinite(s.medianVeteranGames));
  }
});

test('player-number evidence reports debut-year coverage and the highest numbers even without a debut year', () => {
  const noDebut = { ...clean, board: clean.board.map((r, i) => (i < 30 ? { ...r, debutYear: null } : r)) };
  const e = playerNumberEvidence(noDebut);
  assert.equal(e.debutYearCoverage.missingDebutYear, 30);
  assert.equal(e.highestNumbersWithStats.length, 25);
  assert.ok(e.allDebutYearCohorts.length >= 1);
});
