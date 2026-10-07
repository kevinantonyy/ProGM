/**
 * Tests for evidence-based durability (historical availability).
 * Covers: 3-season recency-weighted availability, >=2-season sample guard,
 * missing/thin history neutral (no penalty), and penalty derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDurability, DURABILITY_RECENCY_WEIGHTS, MIN_USABLE_SEASONS } from './durability.js';
import { durabilityPenaltyFrom, DURABILITY_MAX_PENALTY } from './draftHelper.js';

const h = (season, gamesPlayed, gameTotal = 82) => ({ season, gamesPlayed, gameTotal });

test('3-season recency-weighted availability (0.5/0.3/0.2)', () => {
  // availability: N-1 82/82=1.0, N-2 41/82=0.5, N-3 0/82... use 0.6 -> 49.2
  const hist = [h(2024, 82), h(2023, 41), h(2022, 66)]; // 1.0, 0.5, ~0.805
  const r = computeDurability(hist);
  const expected = 0.5 * 1.0 + 0.3 * 0.5 + 0.2 * (66 / 82); // weights sum to 1
  assert.equal(r.usableSeasons, 3);
  assert.ok(Math.abs(r.durabilityScore - Number(expected.toFixed(4))) < 1e-3);
  assert.ok(r.durabilityScore > 0 && r.durabilityScore <= 1);
});

test('recency weights renormalize over only the usable seasons (2 present)', () => {
  // Only 2 seasons: weights 0.5 and 0.3 renormalize to 0.625 / 0.375.
  const r = computeDurability([h(2024, 82), h(2023, 41)]); // 1.0, 0.5
  const expected = (0.5 * 1.0 + 0.3 * 0.5) / (0.5 + 0.3);
  assert.equal(r.usableSeasons, 2);
  assert.ok(Math.abs(r.durabilityScore - Number(expected.toFixed(4))) < 1e-3);
});

test('>=2-season guard: a single season is NEUTRAL (null), not scored', () => {
  const r = computeDurability([h(2024, 20)]);
  assert.equal(r.durabilityScore, null);
  assert.equal(r.usableSeasons, 1);
});

test('missing / empty history is neutral (null), never a penalty', () => {
  assert.equal(computeDurability(null).durabilityScore, null);
  assert.equal(computeDurability([]).durabilityScore, null);
  // Rows with missing GP or zero game total are not usable.
  assert.equal(computeDurability([h(2024, null), h(2023, null)]).durabilityScore, null);
  assert.equal(computeDurability([h(2024, 50, 0), h(2023, 50, 0)]).durabilityScore, null);
});

test('availability is clamped to [0,1] (never >1 even on data quirks)', () => {
  const r = computeDurability([h(2024, 90, 82), h(2023, 82, 82)]); // 90/82 -> clamp 1.0
  assert.ok(r.durabilityScore <= 1);
  assert.equal(r.perSeason[0].availability, 1);
});

test('durabilityPenaltyFrom is downside-only and capped', () => {
  assert.equal(durabilityPenaltyFrom(1), 0);          // fully available -> no penalty
  assert.equal(durabilityPenaltyFrom(null), 0);       // neutral -> no penalty
  assert.equal(durabilityPenaltyFrom(0), DURABILITY_MAX_PENALTY); // worst -> cap
  assert.equal(durabilityPenaltyFrom(0.5), Number((DURABILITY_MAX_PENALTY * 0.5).toFixed(4)));
  // Never boosts (no negative penalty) and never exceeds the cap.
  assert.ok(durabilityPenaltyFrom(0.1) <= DURABILITY_MAX_PENALTY);
});

test('constants are the documented, tunable values', () => {
  assert.deepEqual([...DURABILITY_RECENCY_WEIGHTS], [0.5, 0.3, 0.2]);
  assert.equal(MIN_USABLE_SEASONS, 2);
  assert.equal(DURABILITY_MAX_PENALTY, 0.10);
});
