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
