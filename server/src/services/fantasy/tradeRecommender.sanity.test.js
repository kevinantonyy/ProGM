/**
 * Trade recommender SANITY checks.
 *
 * Verifies, on a realistic multi-opponent fixture, that every recommendation
 * the engine surfaces satisfies the roster-construction guarantees — not just
 * mathematical fairness:
 *   1. both players are actually on the reported teams
 *   2. roster is legal after the trade (both sides)
 *   3. projections exist for every player in the package (missing => excluded)
 *   4. the trade improves MY roster under the model (net > 0)
 *   5. the other side receives plausible value (never "favors your side")
 *   6. no duplicate equivalent trades
 *   7. no injured/OUT player is silently valued as healthy
 *   8. 2-for-1 / 1-for-2 packages keep roster size within ±1 and stay legal
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTrades } from './tradeRecommender.js';
import { playerValue, scarcityWeights } from './playerValue.js';

const SETTINGS = {
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'SG', count: 1, isStarting: true },
    { position: 'SF', count: 1, isStarting: true },
    { position: 'PF', count: 1, isStarting: true },
    { position: 'C', count: 1, isStarting: true },
    { position: 'Util', count: 2, isStarting: true },
    { position: 'BN', count: 4, isStarting: false },
  ],
};

function P(id, pos, proj, { status = null, elig = null, team = 'BOS' } = {}) {
  return { id, name: id, position: pos, eligiblePositions: elig || [pos, 'Util'], projectedPoints: proj, weeklyProjectedPoints: null, injuryStatus: status, teamAbbr: team };
}

// A realistic-ish 13-man roster with a clear weakness at C.
function myTeam() {
  return [
    P('me_pg1', 'PG', 42), P('me_pg2', 'PG', 26),
    P('me_sg1', 'SG', 40), P('me_sg2', 'SG', 24),
    P('me_sf1', 'SF', 38), P('me_sf2', 'SF', 22),
    P('me_pf1', 'PF', 37), P('me_pf2', 'PF', 21),
    P('me_c1', 'C', 18), P('me_c2', 'C', 12), // weak at C
    P('me_u1', 'Util', 30), P('me_u2', 'Util', 20), P('me_u3', 'Util', 19),
  ];
}

function opponents() {
  return [
    { teamKey: '466.l.1.t.2', name: 'Bigs', roster: [
      P('op1_c1', 'C', 46, { team: 'DEN' }), P('op1_c2', 'C', 30, { team: 'PHI' }),
      P('op1_pg', 'PG', 20), P('op1_sg', 'SG', 19), P('op1_sf', 'SF', 18), P('op1_pf', 'PF', 17), P('op1_u', 'Util', 16),
    ] },
    { teamKey: '466.l.1.t.3', name: 'Guards', roster: [
      P('op2_pg', 'PG', 44), P('op2_sg', 'SG', 43), P('op2_c', 'C', 15), P('op2_sf', 'SF', 14), P('op2_pf', 'PF', 13),
    ] },
    { teamKey: '466.l.1.t.4', name: 'Hurt', roster: [
      P('op3_c', 'C', 48, { status: 'OUT', team: 'MIA' }), // stud but OUT
      P('op3_pg', 'PG', 25), P('op3_sg', 'SG', 24), P('op3_sf', 'SF', 23), P('op3_pf', 'PF', 22),
    ] },
  ];
}

const ANALYSIS = { positions: { thinPositions: [{ position: 'C' }], overloadedPositions: [] } };

function run() {
  return recommendTrades({ settings: SETTINGS, myRoster: myTeam(), opponents: opponents(), analysis: ANALYSIS });
}

// Legality checker mirroring the engine's contract (independent re-derivation).
function isLegal(roster) {
  const required = { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 2 };
  for (const [pos, need] of Object.entries(required)) {
    const eligible = roster.filter((p) => (p.eligiblePositions || []).includes(pos)).length;
    if (eligible < need) return false;
  }
  return true;
}

test('sanity: engine produces recommendations for this fixture', () => {
  const res = run();
  assert.equal(res.available, true);
  assert.ok(res.recommendations.length > 0, 'expected at least one recommendation');
});

test('sanity #1: every player in a package is actually on the reported team', () => {
  const res = run();
  const myIds = new Set(myTeam().map((p) => p.id));
  const oppById = new Map(opponents().map((o) => [o.name, new Set(o.roster.map((p) => p.id))]));
  for (const rec of res.recommendations) {
    assert.ok(rec.send.every((p) => myIds.has(p.id)), `send has off-roster player in ${JSON.stringify(rec.send.map((x) => x.id))}`);
    const oppIds = oppById.get(rec.withTeam);
    assert.ok(oppIds, `unknown opponent ${rec.withTeam}`);
    assert.ok(rec.receive.every((p) => oppIds.has(p.id)), 'receive has a player not on that opponent');
  }
});

test('sanity #2 + #8: roster is legal after the trade on both sides (incl. 2-for-1/1-for-2)', () => {
  const res = run();
  const mine = myTeam();
  const oppByName = new Map(opponents().map((o) => [o.name, o.roster]));
  for (const rec of res.recommendations) {
    // Package size difference within ±1 (roster spot implication).
    assert.ok(Math.abs(rec.send.length - rec.receive.length) <= 1);
    const sendIds = new Set(rec.send.map((p) => p.id));
    const recvIds = new Set(rec.receive.map((p) => p.id));
    const oppRoster = oppByName.get(rec.withTeam);
    const myAfter = mine.filter((p) => !sendIds.has(p.id)).concat(rec.receive.map((r) => ({ ...r, eligiblePositions: r.eligiblePositions })));
    const oppAfter = oppRoster.filter((p) => !recvIds.has(p.id)).concat(rec.send.map((s) => ({ ...s, eligiblePositions: s.eligiblePositions })));
    assert.ok(isLegal(myAfter), 'my roster illegal after trade');
    assert.ok(isLegal(oppAfter), 'opponent roster illegal after trade');
  }
});

test('sanity #3: every player in a package has a projection (missing data excluded)', () => {
  const res = run();
  for (const rec of res.recommendations) {
    for (const p of [...rec.send, ...rec.receive]) {
      assert.notEqual(p.projectedPoints, null, `${p.name} has no projection but is in a package`);
    }
  }
});

test('sanity #4: every recommendation improves my roster (net > 0, >= MIN_IMPROVEMENT)', () => {
  const res = run();
  for (const rec of res.recommendations) {
    assert.ok(rec.production.net >= 1.0, `net ${rec.production.net} below improvement threshold`);
    assert.equal(rec.improvement, 'improves');
  }
});

test('sanity #5: never surfaces a trade that favors my side (must be plausible for them)', () => {
  const res = run();
  for (const rec of res.recommendations) {
    assert.notEqual(rec.fairness, 'favors your side');
    assert.ok(['balanced', 'plausible starting point', 'favors their side'].includes(rec.fairness));
  }
});

test('sanity #6: no duplicate equivalent trades (same opponent + same player sets)', () => {
  const res = run();
  const seen = new Set();
  for (const rec of res.recommendations) {
    const sig = `${rec.withTeamKey}|S:${[...rec.send.map((p) => p.id)].sort().join(',')}|R:${[...rec.receive.map((p) => p.id)].sort().join(',')}`;
    assert.ok(!seen.has(sig), `duplicate equivalent trade: ${sig}`);
    seen.add(sig);
  }
});

test('sanity #7: an OUT player is valued at reduced (not healthy) value', () => {
  const w = scarcityWeights(SETTINGS);
  const healthy = playerValue({ projectedPerGame: 48, status: null, eligiblePositions: ['C'], weights: w }).value;
  const out = playerValue({ projectedPerGame: 48, status: 'OUT', eligiblePositions: ['C'], weights: w }).value;
  assert.ok(out < healthy, 'OUT player must be worth less than the same healthy player');
  assert.ok(Math.abs(out - healthy * 0.5) < 0.001, 'OUT multiplier should be 0.5');

  // If the OUT stud (op3_c, 48) is ever received, it must be flagged as a risk.
  const res = run();
  for (const rec of res.recommendations) {
    if (rec.receive.some((p) => p.id === 'op3_c')) {
      assert.ok((rec.risks || []).some((r) => /op3_c|OUT|status/i.test(r)), 'incoming OUT player not flagged as risk');
    }
  }
});

test('sanity: the headline recommendation addresses my thin position (C)', () => {
  const res = run();
  // At least one recommendation should bring back a C-eligible player, since C is my thin spot.
  const addressesC = res.recommendations.some((rec) => rec.receive.some((p) => (p.eligiblePositions || []).includes('C')));
  assert.ok(addressesC, 'expected a recommendation that helps the thin C position');
});
