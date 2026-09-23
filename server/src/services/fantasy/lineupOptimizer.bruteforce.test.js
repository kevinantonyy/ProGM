import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeLineup } from './lineupOptimizer.js';

/**
 * Correctness check: the recommended lineup's projected total must equal the
 * TRUE optimal legal assignment, verified by brute force on synthetic rosters.
 *
 * We construct random NBA-like rosters/slot configs, compute the optimizer's
 * projectedOptimizedPoints, and compare against an exhaustive maximum-weight
 * bipartite assignment (players -> starting slots respecting eligibility).
 */

// Exhaustive optimal: try every assignment of players to the expanded starting
// slots, respecting eligibility, maximizing summed projection. Small sizes only.
function bruteForceOptimal(players, slotPositions) {
  const playable = players.filter((p) => p.playable);
  let best = 0;
  const used = new Array(playable.length).fill(false);

  function recurse(slotIdx, total) {
    if (slotIdx === slotPositions.length) { best = Math.max(best, total); return; }
    const pos = slotPositions[slotIdx];
    // Option: leave slot empty (contributes 0).
    recurse(slotIdx + 1, total);
    // Option: fill with each eligible unused player.
    for (let i = 0; i < playable.length; i += 1) {
      if (used[i]) continue;
      if (!playable[i].eligiblePositions.includes(pos)) continue;
      used[i] = true;
      recurse(slotIdx + 1, total + (playable[i].proj || 0));
      used[i] = false;
    }
  }
  recurse(0, 0);
  return Number(best.toFixed(2));
}

function expandStartingSlots(rosterSlots) {
  const slots = [];
  for (const s of rosterSlots.filter((x) => x.isStarting)) for (let i = 0; i < s.count; i += 1) slots.push(s.position);
  return slots;
}

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const FLEX = { G: ['PG', 'SG'], F: ['SF', 'PF'], Util: ['PG', 'SG', 'SF', 'PF', 'C'] };

function randomEligibility(rng) {
  // 1-2 base positions + implied flex eligibility.
  const base = POSITIONS[Math.floor(rng() * POSITIONS.length)];
  const set = new Set([base, 'Util']);
  if (rng() > 0.5) set.add(POSITIONS[Math.floor(rng() * POSITIONS.length)]);
  if (['PG', 'SG'].some((p) => set.has(p))) set.add('G');
  if (['SF', 'PF'].some((p) => set.has(p))) set.add('F');
  return [...set];
}

// Deterministic PRNG for reproducibility.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('greedy optimizer matches brute-force optimal across randomized rosters', () => {
  const settings = {
    rosterSlots: [
      { position: 'PG', count: 1, isStarting: true },
      { position: 'SG', count: 1, isStarting: true },
      { position: 'G', count: 1, isStarting: true },
      { position: 'SF', count: 1, isStarting: true },
      { position: 'PF', count: 1, isStarting: true },
      { position: 'F', count: 1, isStarting: true },
      { position: 'C', count: 2, isStarting: true },
      { position: 'Util', count: 2, isStarting: true },
      { position: 'BN', count: 3, isStarting: false },
    ],
  };
  const slotPositions = expandStartingSlots(settings.rosterSlots);

  let mismatches = 0;
  const trials = 120;
  for (let trial = 0; trial < trials; trial += 1) {
    const rng = mulberry32(trial + 1);
    const count = 11 + Math.floor(rng() * 3); // 11-13 players (brute force is exponential)
    const players = [];
    for (let i = 0; i < count; i += 1) {
      const hasProj = rng() > 0.15; // ~15% have unknown projection
      players.push({
        playerKey: `p${i}`,
        name: `P${i}`,
        eligiblePositions: randomEligibility(rng),
        selectedPosition: 'BN',
        isStarting: false,
        status: null,
        // Missing projection stays null (never 0).
        _proj: hasProj ? Math.round(rng() * 600) / 10 : null,
      });
    }
    const provider = { getProjection: (p) => (p._proj != null ? { projectedPoints: p._proj, confidence: 0.8 } : null) };
    const result = optimizeLineup({ players, settings, projectionProvider: provider });

    // Brute-force optimal on the same decorated inputs.
    const decorated = players.map((p) => ({ eligiblePositions: p.eligiblePositions, proj: p._proj, playable: true }));
    const optimal = bruteForceOptimal(decorated, slotPositions);

    const got = result.projectedOptimizedPoints ?? 0;
    if (Math.abs(got - optimal) > 0.011) {
      mismatches += 1;
      if (mismatches <= 3) {
        // eslint-disable-next-line no-console
        console.error(`Trial ${trial}: greedy=${got} optimal=${optimal} (players=${count})`);
      }
    }
  }
  assert.equal(mismatches, 0, `${mismatches}/${trials} lineups were suboptimal vs brute force`);
});
