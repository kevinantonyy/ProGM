import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMarketPriors, fitMarketPrior, marketPriorPerGame, marketPriorProjection, ESTIMATE_CONFIDENCE, MIN_POINTS } from './marketPrior.js';
import { buildDraftBoard } from './draftHelper.js';
import { buildRankings } from './rankings.js';
import { makeProjectionProvider } from './projection.js';
import { canonicalIdOf } from './insights.js';

// Synthetic only. Veterans: ADP k -> perGame 60 - 8*ln(k) plus a small deterministic wobble.
const vets = Array.from({ length: 80 }, (_, i) => {
  const adp = i + 1;
  return { key: `V${adp}`, adp, perGame: Number((60 - 8 * Math.log(adp) + ((i * 7) % 5 - 2) * 0.3).toFixed(2)) };
});
const vetProj = (v) => ({ projectedPoints: v.perGame, perGame: v.perGame, confidence: 0.9, method: 'season_only', lastSeason: { season: 2025, stats: { gamesPlayed: 70 } } });
const yahooPlayer = (key, adp, pos = 'PG') => ({ playerKey: key, name: key, teamAbbr: 'AAA', eligiblePositions: [pos], yahooAdp: adp, percentOwned: 0 });
const setup = (extra = []) => {
  const players = [...vets.map((v) => yahooPlayer(v.key, v.adp, v.adp % 2 ? 'PG' : 'C')), ...extra];
  const map = new Map(vets.map((v) => [v.key, vetProj(v)]));
  const canonical = players.map((p) => ({ canonicalId: p.playerKey, matched: map.has(p.playerKey), matchMethod: map.has(p.playerKey) ? 'name_team' : null }));
  for (const p of extra) map.set(p.playerKey, { projectedPoints: null, perGame: null, confidence: 0, method: 'no_data', matched: false });
  return { players, map, canonical };
};

test('fit recovers a monotone ADP curve and refuses weak or tiny samples', () => {
  const model = fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: v.perGame })));
  assert.ok(model.slope < 0 && model.r2 > 0.9 && model.n === 80);
  assert.equal(fitMarketPrior(vets.slice(0, MIN_POINTS - 1).map((v) => ({ adp: v.adp, perGame: v.perGame }))), null);
  assert.equal(fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: 30 + (v.adp % 3) }))), null); // no relationship
  assert.equal(fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: v.adp }))), null); // wrong sign
});

test('estimates stay inside the calibrated range, are non-negative and capped', () => {
  const model = fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: v.perGame })));
  assert.equal(marketPriorPerGame(model, 500), null); // beyond calibrated ADP: no extrapolation
  assert.equal(marketPriorPerGame(model, null), null);
  assert.ok(marketPriorPerGame(model, 1) <= model.maxPerGame);
  assert.ok(marketPriorPerGame(model, 40) > marketPriorPerGame(model, 70)); // earlier pick => more points
  const proj = marketPriorProjection(model, 30);
  assert.equal(proj.estimate, true);
  assert.equal(proj.confidence, ESTIMATE_CONFIDENCE);
  assert.equal(proj.method, 'market_prior_estimate');
  assert.equal(proj.history, null);
});

test('rookie coverage: players with no stats but an ADP receive a labelled estimate; veterans are untouched', () => {
  const rookie = yahooPlayer('R1', 25);
  const noAdp = yahooPlayer('R2', null);
  const far = yahooPlayer('R3', 400);
  const { players, map, canonical } = setup([rookie, noAdp, far]);
  const before = new Map([...map].filter(([k]) => k.startsWith('V')).map(([k, v]) => [k, v.projectedPoints]));
  const { estimateCount } = applyMarketPriors({ canonical, players, projectionByCanonicalId: map, canonicalIdOf, seasonYear: 2026 });
  assert.equal(estimateCount, 1);
  assert.equal(map.get('R1').estimate, true);
  assert.ok(map.get('R1').projectedPoints > 0);
  assert.equal(map.get('R2').projectedPoints, null); // no ADP: honest no-data, never invented
  assert.equal(map.get('R3').projectedPoints, null); // outside calibrated range
  for (const [k, v] of before) assert.equal(map.get(k).projectedPoints, v); // veterans unchanged
});

test('missing data: no calibration (or scoring gap) means no estimates at all', () => {
  const rookie = yahooPlayer('R1', 25);
  const { players, map, canonical } = setup([rookie]);
  for (const k of [...map.keys()].filter((x) => x.startsWith('V'))) map.get(k).lastSeason = null; // no real sample
  assert.equal(applyMarketPriors({ canonical, players, projectionByCanonicalId: map, canonicalIdOf, seasonYear: 2026 }).estimateCount, 0);
  const s2 = setup([rookie]);
  s2.map.set('R1', { projectedPoints: null, method: 'incomplete_scoring_data' });
  assert.equal(applyMarketPriors({ canonical: s2.canonical, players: s2.players, projectionByCanonicalId: s2.map, canonicalIdOf, seasonYear: 2026 }).estimateCount, 0);
});

test('player identity: ambiguous or unmatched provider identity still keys the estimate by Yahoo player_key', () => {
  const twinA = yahooPlayer('nba.p.9001', 20);
  const twinB = yahooPlayer('nba.p.9002', 55); // same display name, different Yahoo key
  twinA.name = twinB.name = 'Same Name';
  const { players, map, canonical } = setup([twinA, twinB]);
  applyMarketPriors({ canonical, players, projectionByCanonicalId: map, canonicalIdOf, seasonYear: 2026 });
  assert.ok(map.get('nba.p.9001').projectedPoints > map.get('nba.p.9002').projectedPoints);
  assert.equal(map.get('nba.p.9001').estimate, true);
});

const SETTINGS = { teamCount: 4, rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true }, { position: 'BN', count: 2, isStarting: false }] };

test('draft board ranks estimates, flags them, and keeps market comparisons neutral (no circular VALUE)', () => {
  const rookie = yahooPlayer('R1', 6);
  const { players, map, canonical } = setup([rookie]);
  applyMarketPriors({ canonical, players, projectionByCanonicalId: map, canonicalIdOf, seasonYear: 2026 });
  const provider = makeProjectionProvider({ projectionByCanonicalId: map, canonicalIdOf });
  const board = buildDraftBoard({ players, settings: SETTINGS, projectionProvider: provider, currentSeason: 2026, availabilityOf: () => true, currentPick: 1, nextPick: 20 });
  const row = board.board.find((r) => r.playerKey === 'R1');
  assert.ok(row, 'rookie is ranked');
  assert.ok(Number.isInteger(row.overallRank));
  assert.equal(row.estimate, true);
  assert.equal(row.projectionMethod, 'market_prior_estimate');
  assert.equal(row.marketLabel, 'neutral');
  assert.equal(row.adpVsProgm, null);
  assert.ok(row.confidence <= ESTIMATE_CONFIDENCE);
  // Veteran rows keep their market context.
  assert.equal(board.board.find((r) => r.playerKey === 'V10').estimate, false);
  assert.equal(board.noData.some((r) => r.playerKey === 'R1'), false);
  // Lower confidence only trims value modestly relative to an identical-projection stat player.
  assert.equal(board.board.length, 81);
});

test('ranking consistency: Rankings tab shows the same overall rank and estimate flag as the board', () => {
  const rookie = yahooPlayer('R1', 12);
  const { players, map, canonical } = setup([rookie]);
  applyMarketPriors({ canonical, players, projectionByCanonicalId: map, canonicalIdOf, seasonYear: 2026 });
  const provider = makeProjectionProvider({ projectionByCanonicalId: map, canonicalIdOf });
  const board = buildDraftBoard({ players, settings: SETTINGS, projectionProvider: provider, currentSeason: 2026 });
  const overallRanks = new Map(board.board.map((r) => [r.playerKey, r.overallRank]));
  const rankings = buildRankings({ players, projectionProvider: provider, overallRanks, rankScope: board.rankScope, sortBy: 'overall', limit: 500 });
  const rr = rankings.players.find((r) => r.playerKey === 'R1');
  assert.equal(rr.overallRank, board.board.find((r) => r.playerKey === 'R1').overallRank);
  assert.equal(rr.estimate, true);
  assert.equal(rr.projectionKnown, true);
});

test('league scoring is preserved: the same ADP maps to different points under different calibration scales', () => {
  const a = fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: v.perGame })));
  const b = fitMarketPrior(vets.map((v) => ({ adp: v.adp, perGame: v.perGame * 0.6 })));
  assert.ok(Math.abs(marketPriorPerGame(b, 30) - marketPriorPerGame(a, 30) * 0.6) < 0.05);
});
