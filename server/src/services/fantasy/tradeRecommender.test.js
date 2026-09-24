import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTrades } from './tradeRecommender.js';
import { playerValue, scarcityWeights, healthMultiplier } from './playerValue.js';

// League: 1 PG, 1 SG, 1 C starting + bench. Enough that swaps stay legal.
const SETTINGS = {
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'SG', count: 1, isStarting: true },
    { position: 'C', count: 1, isStarting: true },
    { position: 'Util', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};

function P(id, pos, proj, status = null, elig = null) {
  return { id, name: id, position: pos, eligiblePositions: elig || [pos, 'Util'], projectedPoints: proj, weeklyProjectedPoints: null, injuryStatus: status, teamAbbr: 'BOS' };
}

// --- playerValue model ---
test('healthMultiplier reflects availability', () => {
  assert.equal(healthMultiplier(null), 1);
  assert.equal(healthMultiplier('GTD'), 0.85);
  assert.equal(healthMultiplier('OUT'), 0.5);
});

test('scarcityWeights: rarer positions get a small premium', () => {
  const w = scarcityWeights(SETTINGS); // PG/SG/C each 1 slot, Util 1 -> all equal demand
  // Add a league with 2 Util to make Util the most common (least scarce).
  const w2 = scarcityWeights({ rosterSlots: [{ position: 'C', count: 1, isStarting: true }, { position: 'Util', count: 3, isStarting: true }] });
  assert.ok(w2.C > w2.Util); // C scarcer than Util
});

test('playerValue null projection stays null (never 0)', () => {
  const w = scarcityWeights(SETTINGS);
  assert.equal(playerValue({ projectedPerGame: null, status: null, eligiblePositions: ['PG'], weights: w }).value, null);
});

test('playerValue prefers schedule-aware period points when present', () => {
  const w = scarcityWeights(SETTINGS);
  const v = playerValue({ projectedPerGame: 30, periodProjectedPoints: 90, status: null, eligiblePositions: ['C'], weights: w });
  assert.equal(v.usesSchedule, true);
  assert.ok(v.value >= 90); // 90 × health(1) × scarcity(>=1)
});

// --- recommendTrades ---
test('recommends a trade that improves my team and is not lopsided in my favor', () => {
  const myRoster = [P('meC', 'C', 20), P('mePG', 'PG', 40), P('meSG', 'SG', 38), P('meU', 'Util', 30), P('meB1', 'PG', 25), P('meB2', 'SG', 24)];
  const opp = { teamKey: '466.l.1.t.2', name: 'Rivals', roster: [P('opC', 'C', 45), P('opPG', 'PG', 22), P('opSG', 'SG', 21), P('opU', 'Util', 20), P('opB', 'C', 26)] };
  const res = recommendTrades({ settings: SETTINGS, myRoster, opponents: [opp], analysis: { positions: { thinPositions: [{ position: 'C' }] } } });
  assert.equal(res.available, true);
  assert.ok(res.recommendations.length > 0);
  const top = res.recommendations[0];
  // Should net positive value for me and never be labeled 'favors your side'.
  assert.ok(top.production.net > 0);
  assert.notEqual(top.fairness, 'favors your side');
  // Only real players from the indicated rosters appear.
  const myIds = new Set(myRoster.map((p) => p.id));
  const oppIds = new Set(opp.roster.map((p) => p.id));
  assert.ok(top.send.every((p) => myIds.has(p.id)));
  assert.ok(top.receive.every((p) => oppIds.has(p.id)));
});

test('never recommends when projections are entirely unavailable', () => {
  const myRoster = [P('a', 'C', null), P('b', 'PG', null)];
  const opp = { teamKey: 't', name: 'X', roster: [P('c', 'C', null)] };
  const res = recommendTrades({ settings: SETTINGS, myRoster, opponents: [opp] });
  assert.equal(res.available, false);
  assert.equal(res.recommendations.length, 0);
});

test('excludes packages that would leave an illegal roster', () => {
  // I have exactly one C-eligible player; trading him away for a PG is illegal
  // (C starting slot unfillable). Engine must not surface such a trade.
  const myRoster = [P('onlyC', 'C', 50, null, ['C', 'Util']), P('pg', 'PG', 20), P('sg', 'SG', 20), P('u', 'Util', 20)];
  const opp = { teamKey: 't', name: 'X', roster: [P('theirPG', 'PG', 80, null, ['PG', 'Util'])] };
  const res = recommendTrades({ settings: SETTINGS, myRoster, opponents: [opp] });
  const involvesOnlyC = res.recommendations.some((r) => r.send.some((p) => p.id === 'onlyC'));
  assert.equal(involvesOnlyC, false);
});

test('does not include off-roster or unvalued-only packages', () => {
  const myRoster = [P('m1', 'PG', 40), P('m2', 'SG', 38), P('m3', 'C', 36), P('m4', 'Util', 34)];
  const opp = { teamKey: 't', name: 'X', roster: [P('o1', 'PG', 42), P('o2', 'C', 41), P('o3', 'SG', 39), P('o4', 'Util', 5)] };
  const res = recommendTrades({ settings: SETTINGS, myRoster, opponents: [opp] });
  for (const rec of res.recommendations) {
    assert.ok(rec.send.length && rec.receive.length);
    assert.ok(rec.confidence > 0);
  }
});
