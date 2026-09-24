/**
 * Waiver add/drop SANITY checks.
 *
 * Verifies, on a realistic full roster + free-agent pool, that every paired
 * add/drop the engine surfaces makes roster-construction sense:
 *   1. the ADD player is actually in the available (free-agent) pool
 *   2. the DROP player is actually on MY roster
 *   3. the resulting roster is legal (dropping never leaves a required slot unfillable)
 *   4. IL/stashed players are dropped LAST (not ahead of a healthy bench player)
 *   5. a no-projection drop candidate is flagged, never valued as 0
 *   6. a paired move on a FULL roster is a genuine net improvement (>= threshold)
 *   7. an open slot yields an add with NO forced drop
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankWaivers } from './waiverEngine.js';

// A required lineup: PG, SG, C + Util + bench. Legality = each required slot fillable.
const REQUIRED = { PG: 1, SG: 1, C: 1, Util: 1 };

function isLegal(roster) {
  for (const [pos, need] of Object.entries(REQUIRED)) {
    const eligible = roster.filter((p) => (p.eligiblePositions || []).includes(pos)).length;
    if (eligible < need) return false;
  }
  return true;
}

function fa(key, elig, proj, { owned = 0, status = null } = {}) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: owned, status, statusFull: status, _proj: proj };
}
function rp(key, elig, proj, { slot = 'BN', isStarting = false, status = null } = {}) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, selectedPosition: slot, isStarting, status, statusFull: status, _proj: proj };
}

function provider(players) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return { getProjection: (p) => (map.get(p.playerKey) != null ? { projectedPoints: map.get(p.playerKey), confidence: 0.8 } : null) };
}

// A full 8-man roster (roster full => any add must be paired with a drop).
function fullRoster() {
  return [
    rp('R_pg', ['PG', 'Util'], 30, { slot: 'PG', isStarting: true }),
    rp('R_sg', ['SG', 'Util'], 28, { slot: 'SG', isStarting: true }),
    rp('R_c', ['C', 'Util'], 26, { slot: 'C', isStarting: true }),
    rp('R_u', ['SF', 'Util'], 24, { slot: 'Util', isStarting: true }),
    rp('R_bench_weak', ['PG', 'Util'], 8, { slot: 'BN' }),   // clear worst healthy player
    rp('R_bench_mid', ['SG', 'Util'], 18, { slot: 'BN' }),
    rp('R_il', ['C', 'Util'], 5, { slot: 'IL', status: 'O' }), // stashed, low value
    rp('R_noproj', ['SF', 'Util'], null, { slot: 'BN' }),      // no projection
  ];
}

const ANALYSIS_FULL = { counts: { openSlots: 0 } };
const ANALYSIS_OPEN = { counts: { openSlots: 1 } };

test('sanity: engine surfaces at least one add/drop on a full roster with a strong free agent', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40, { owned: 20 })];
  const roster = fullRoster();
  const all = [...available, ...roster];
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider(all), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  assert.ok(res.addDrop.length > 0);
});

test('sanity #1 + #2: add is available, drop is on my roster', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40), fa('FA_ok', ['SG', 'Util'], 32)];
  const roster = fullRoster();
  const availKeys = new Set(available.map((p) => p.playerKey));
  const rosterKeys = new Set(roster.map((p) => p.playerKey));
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  for (const m of res.addDrop) {
    assert.ok(availKeys.has(m.add.playerKey), `${m.add.playerKey} not in available pool`);
    if (m.drop) assert.ok(rosterKeys.has(m.drop.playerKey), `${m.drop.playerKey} not on my roster`);
  }
});

test('sanity #3: resulting roster is legal after each add/drop', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40)];
  const roster = fullRoster();
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  for (const m of res.addDrop) {
    if (!m.drop) continue;
    const after = roster.filter((p) => p.playerKey !== m.drop.playerKey)
      .concat([{ playerKey: m.add.playerKey, eligiblePositions: m.add.eligiblePositions }]);
    assert.ok(isLegal(after), `illegal roster after add ${m.add.playerKey} / drop ${m.drop.playerKey}`);
  }
});

test('sanity #4: IL-stashed player is not dropped ahead of a healthy weaker bench slot', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40)];
  const roster = fullRoster(); // R_bench_weak (8) is worst healthy; R_il is stashed
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  const top = res.addDrop[0];
  assert.ok(top.drop);
  assert.notEqual(top.drop.playerKey, 'R_il'); // stash preserved over a healthy drop
});

test('sanity #5: no-projection drop candidate is flagged, not valued as 0', () => {
  // Only the no-projection player is available to drop (everyone else is a star),
  // so the engine must flag it rather than invent a value.
  const available = [fa('FA_star', ['SF', 'Util'], 40)];
  const roster = [
    rp('R_pg', ['PG', 'Util'], 50, { slot: 'PG', isStarting: true }),
    rp('R_sg', ['SG', 'Util'], 50, { slot: 'SG', isStarting: true }),
    rp('R_c', ['C', 'Util'], 50, { slot: 'C', isStarting: true }),
    rp('R_u', ['SF', 'Util'], 50, { slot: 'Util', isStarting: true }),
    rp('R_noproj', ['SF', 'Util'], null, { slot: 'BN' }),
  ];
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  const m = res.addDrop.find((x) => x.drop?.playerKey === 'R_noproj');
  assert.ok(m, 'expected a pairing that considers the no-projection player');
  assert.equal(m.drop.projectionKnown, false);
  assert.equal(m.netImprovement, null); // never fabricated to 0 or a number
});

test('sanity #6: paired move on a full roster is a genuine net improvement', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40)];
  const roster = fullRoster();
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  for (const m of res.addDrop) {
    if (m.netImprovement != null) assert.ok(m.netImprovement >= 1.0, `net ${m.netImprovement} below threshold`);
  }
});

test('sanity #7: an open roster slot yields an add with NO forced drop', () => {
  const available = [fa('FA_star', ['PG', 'Util'], 40)];
  const roster = fullRoster();
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_OPEN });
  assert.ok(res.addDrop.length > 0);
  assert.equal(res.addDrop[0].drop, null);
  assert.equal(res.addDrop[0].openSlotUsed, true);
});

test('sanity #3b: never drops the ONLY player eligible for a required slot', () => {
  // Roster has exactly one C-eligible player. A strong PG-only free agent must
  // NOT be paired with dropping that lone C (would make C unfillable), even
  // though the C is the lowest-value player.
  const SETTINGS = { rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'SG', count: 1, isStarting: true },
    { position: 'C', count: 1, isStarting: true },
    { position: 'BN', count: 1, isStarting: false },
  ] };
  const available = [fa('FA_pg', ['PG'], 40)]; // PG only — cannot fill C
  const roster = [
    rp('R_pg', ['PG'], 30, { slot: 'PG', isStarting: true }),
    rp('R_sg', ['SG'], 28, { slot: 'SG', isStarting: true }),
    rp('R_onlyC', ['C'], 6, { slot: 'C', isStarting: true }), // lowest value but ONLY C
    rp('R_bn', ['PG', 'SG'], 20, { slot: 'BN' }),
  ];
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: { counts: { openSlots: 0 } }, settings: SETTINGS });
  const dropsOnlyC = res.addDrop.some((m) => m.drop?.playerKey === 'R_onlyC');
  assert.equal(dropsOnlyC, false, 'must not drop the only C-eligible player for a PG-only add');
});

test('sanity: does not churn when no free agent beats a rostered player', () => {
  const available = [fa('FA_weak', ['PG', 'Util'], 5)];
  const roster = fullRoster(); // worst healthy is 8 > 5
  const res = rankWaivers({ availablePlayers: available, projectionProvider: provider([...available, ...roster]), myRoster: roster, rosterAnalysis: ANALYSIS_FULL });
  // Weak FA (5) does not beat the weakest healthy bench (8) by the threshold.
  assert.equal(res.addDrop.filter((m) => m.drop && m.drop.playerKey !== 'R_noproj').length, 0);
});
