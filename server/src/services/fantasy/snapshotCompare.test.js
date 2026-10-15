import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { sanitizeWorkspace, analyzeSnapshot } from './snapshotCompare.js';

// Tool test only (synthetic input); the real comparison always runs on the user's saved response.
const SETTINGS = { teamCount: 4, rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 2, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 75, gameTotal: 82 }));
const players = [
  ...Array.from({ length: 60 }, (_, i) => ({ playerKey: `466.p.${i}`, name: `Vet ${i}`, teamAbbr: 'AAA', eligiblePositions: [i % 2 ? 'PG' : 'C'], percentOwned: 50, status: null, yahooAdp: i + 1, _pts: 60 - 8 * Math.log(i + 1) })),
  { playerKey: '466.p.900', name: 'Rookie X', teamAbbr: 'BBB', eligiblePositions: ['PG'], percentOwned: 5, status: null, yahooAdp: 20, _pts: null },
  { playerKey: '466.p.901', name: 'Rookie NoAdp', teamAbbr: 'BBB', eligiblePositions: ['C'], percentOwned: 5, status: null, yahooAdp: null, _pts: null },
];
const provider = { getProjection: (p) => (p._pts == null ? null : { projectedPoints: p._pts, confidence: 0.9, history, lastSeason: { season: 2025, stats: { gamesPlayed: 70 } } }) };
const draftBoard = buildDraftBoard({ players, settings: SETTINGS, projectionProvider: provider, currentSeason: 2026, availabilityOf: () => true, poolComplete: true });
const overallRanks = new Map(draftBoard.board.map((r) => [r.playerKey, r.overallRank]));
const rankings = buildRankings({ players: players.slice(0, 50), projectionProvider: provider, overallRanks, rankScope: draftBoard.rankScope, sortBy: 'overall' });
const raw = { connection: { teamName: 'SECRET TEAM', leagueName: 'SECRET LEAGUE', leagueId: '12345', teamKey: '466.l.99.t.1', draftStatus: 'predraft', accessToken: 'tok-123' },
  roster: { players: [{ name: 'MY ROSTER GUY', playerKey: '466.p.7' }] }, leagueHub: { standings: [{ name: 'Rival Team' }] },
  draftBoard: { ...draftBoard, baselineReference: undefined }, rankings };

test('sanitized snapshot keeps only public numbers and drops identity, roster and ownership data', () => {
  const clean = sanitizeWorkspace(raw);
  const text = JSON.stringify({ ...clean, rankingsParity: undefined });
  for (const bad of ['SECRET', 'tok-123', '466.l', '466.p', 'MY ROSTER', 'Rival', 'availability', 'playerKey', 'percentOwned', 'rosterFit', 'teamAbbr']) assert.equal(text.includes(bad), false, bad);
  assert.ok(clean.board.length === 60 && clean.noData.length === 2);
  assert.ok(clean.board[0].components.production != null);
  assert.throws(() => sanitizeWorkspace({ draftBoard: { board: [] } }), /no draftBoard.board/);
});

test('both models are computed from the same rows; ranks and highlights come out consistent', () => {
  const out = analyzeSnapshot(sanitizeWorkspace(raw), { highlight: ['vet 3'], top: 10 });
  assert.equal(out.comparison.players, 60);
  assert.equal(out.comparison.highlighted.length, 1);
  for (const r of out.comparison.topByLegacy) assert.equal(r.legacyRank, draftBoard.board.find((b) => b.name === r.name).overallRank);
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
});

test('Rankings vs Draft Helper parity is checked and reports mismatches without names of your roster', () => {
  const ok = analyzeSnapshot(sanitizeWorkspace(raw)).rankingsVsDraftHelper;
  assert.equal(ok.mismatches, 0); assert.equal(ok.playersCompared, 50);
  const bad = sanitizeWorkspace({ ...raw, rankings: { players: [{ name: 'Vet 1', overallRank: 999 }] } });
  assert.equal(analyzeSnapshot(bad).rankingsVsDraftHelper.mismatches, 1);
});

test('rookie coverage: unprojected players are classified honestly (estimated / no ADP / out of range)', () => {
  const out = analyzeSnapshot(sanitizeWorkspace(raw)).rookieEstimateCoverage;
  assert.equal(out.unprojectedPlayers, 2);
  assert.equal(out.wouldBeEstimated, 1);
  assert.equal(out.noAdp, 1);
  assert.ok(out.calibration.r2 > 0.8);
  assert.equal(out.players[0].name, 'Rookie X');
  assert.ok(out.players[0].impliedFantasyPointsPerGame > 0);
});

test('trace option adds public availability/scoring detail for named players only, still without identity data', () => {
  const clean = sanitizeWorkspace({ ...raw, settings: { scoringFormat: 'points', teamCount: 4, statCategories: [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }], rosterSlots: [{ position: 'C', count: 2, isStarting: true }] } }, { trace: ['vet 3'] });
  const traced = clean.board.filter((r) => r.trace);
  assert.equal(traced.length, 1); assert.equal(traced[0].name, 'Vet 3');
  assert.ok(Array.isArray(traced[0].trace.availability.perSeason) && traced[0].trace.availability.perSeason.length >= 1);
  assert.equal(clean.league.statCategories[0].pointValue, 1);
  const text = JSON.stringify({ ...clean, rankingsParity: undefined });
  for (const bad of ['SECRET', 'tok-123', '466.l', '466.p', 'MY ROSTER', 'Rival']) assert.equal(text.includes(bad), false, bad);
  const out = analyzeSnapshot(clean, { highlight: ['vet 3'] });
  assert.equal(out.traces.length, 1);
  assert.ok(out.pool.replacementBaselineByPosition.PG != null || out.pool.replacementBaselineByPosition.C != null);
});

test('classification ignores prior-season Yahoo ranks: incoming rookies stay rookies, injured veterans and unknowns are never estimated', () => {
  const base = sanitizeWorkspace(raw);               // board players have Yahoo numbers 0..59 => cutoff 59
  const row = (name, n, extra = {}) => ({ name, yahooPlayerNumber: n, eligiblePositions: ['PG'], yahooAdp: 30, noDataReason: 'x', injuryStatus: null, priorSeasonRanks: 0, lastSeasonYahooRank: null, identityMatch: null, ...extra });
  base.noData = [
    row('Incoming Rookie', 7000, { priorSeasonRanks: 3, lastSeasonYahooRank: 40 }),   // Yahoo ranks present, as seen in the real league
    row('Injured Veteran', 20, { injuryStatus: 'INJ', priorSeasonRanks: 5 }),
    row('Healthy Veteran Without Stats', 25),
    row('Injured Newcomer', 7001, { injuryStatus: 'O' }),
    row('No Id', null),
    row('Scoring Gap', 7002, { noDataReason: 'League scoring uses a stat the data provider does not supply', yahooAdp: null }),
  ];
  const cov = analyzeSnapshot(base).rookieEstimateCoverage;
  const c = cov.unprojectedByClass;
  assert.equal(cov.classification.cutoffPlayerNumber, 59);
  assert.equal(c.rookie_or_new_entrant.total, 1);
  assert.equal(c.earlier_player_no_recent_stats.total, 2);
  assert.equal(c.new_entrant_injured.total, 1);
  assert.equal(c.unknown.total, 1);
  assert.equal(c.scoring_gap.total, 1);
  assert.deepEqual(cov.classification.wouldReceiveEstimate, ['Incoming Rookie']);
  assert.equal(cov.wouldBeEstimated, 1);          // veterans, injured and unknown players are not counted as estimable
  assert.equal(cov.players.length, 1);
});

test('replacement baselines: exact per player, positions only when the rows isolate them, otherwise explicitly unavailable', () => {
  const mk = (name, positions, sp, vorp) => ({ name, yahooPlayerNumber: 1, eligiblePositions: positions, overallRank: 1, draftPriority: 1, yahooAdp: null, lastSeasonGamesPlayed: 70, estimate: false, projectionMethod: null, marketLabel: null,
    components: { production: 0.7, replacement: vorp / 3000, vorp, scarcity: 0.5, perGame: sp / 70, expectedGames: 70, seasonPoints: sp, confidence: 0.9, confidenceFactor: 0.99 } });
  const overlapping = { meta: {}, league: null, noData: [], rankingsParity: [], board: [
    ...Array.from({ length: 3 }, (_, i) => mk(`G${i}`, ['PG', 'G', 'UTIL'], 4000 - i, 2000 - i)), ...Array.from({ length: 3 }, (_, i) => mk(`H${i}`, ['SG', 'G', 'UTIL'], 3900 - i, 2100 - i)) ] };
  const a = analyzeSnapshot(overlapping).pool;
  assert.deepEqual(a.replacementBaselineByPosition, {});
  assert.match(a.replacementBaselineByPositionNote, /unavailable/);
  assert.ok(a.distinctReplacementBaselines.length >= 1);
  const isolating = { meta: {}, league: null, noData: [], rankingsParity: [], board: Array.from({ length: 4 }, (_, i) => mk(`C${i}`, ['C', 'UTIL'], 4000, 2000)) };
  assert.deepEqual(analyzeSnapshot(isolating).pool.replacementBaselineByPosition, { C: 2000 });
  // exact per-player baseline in the trace
  const traced = sanitizeWorkspace({ ...raw }, { trace: ['vet 3'] });
  const t = analyzeSnapshot(traced, { highlight: ['vet 3'] }).traces[0];
  assert.equal(t.replacementBaselineSeasonPoints, Math.round(t.components.seasonPoints - t.components.vorp));
});

test('projection method: uses the payload value when present, otherwise derives season-only vs blended honestly', () => {
  const withFantasy = (perGame, last, method) => {
    const clean = sanitizeWorkspace(raw, { trace: ['vet 3'] });
    const row = clean.board.find((r) => r.name === 'Vet 3');
    row.components.perGame = perGame; row.trace.lastSeasonFantasy = { season: 2025, points: last, breakdown: [] }; row.trace.projectionMethod = method;
    return analyzeSnapshot(clean, { highlight: ['vet 3'] }).traces[0];
  };
  assert.equal(withFantasy(50, 50, null).projectionMethod, 'season_only (derived)');
  assert.equal(withFantasy(53, 50, null).projectionMethod, 'blended_recent_season (derived)');
  assert.equal(withFantasy(50, null, null).projectionMethod, 'unavailable');
  const given = withFantasy(53, 50, 'season_only');
  assert.equal(given.projectionMethod, 'season_only'); assert.equal(given.projectionMethodSource, 'payload');
});
