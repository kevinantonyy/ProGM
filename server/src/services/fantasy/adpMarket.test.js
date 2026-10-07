/**
 * Tests for Yahoo ADP market-context logic (pure, deterministic).
 * VALUE / REACH / DRAFT NOW / WAIT / neutral + next-pick gating + null safety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMarketContext, ADP_THRESHOLDS } from './adpMarket.js';

test('neutral when ProGM rank or ADP is missing (never fabricated)', () => {
  assert.equal(computeMarketContext({ progmRank: 5, yahooAdp: null }).label, 'neutral');
  assert.equal(computeMarketContext({ progmRank: null, yahooAdp: 20 }).label, 'neutral');
  assert.equal(computeMarketContext({ progmRank: 5, yahooAdp: null }).adpVsProgm, null);
});

test('VALUE: ProGM ranks the player materially earlier than Yahoo ADP', () => {
  // ProGM #10, ADP 25 => adpVsProgm +15 >= VALUE_GAP.
  const r = computeMarketContext({ progmRank: 10, yahooAdp: 25 });
  assert.equal(r.label, 'VALUE');
  assert.equal(r.adpVsProgm, 15);
});

test('REACH: ADP materially later than the current pick', () => {
  // ProGM and ADP aligned (no VALUE), but ADP 30 is well after current pick 15.
  const r = computeMarketContext({ progmRank: 29, yahooAdp: 30, currentPick: 15 });
  assert.equal(r.label, 'REACH');
});

test('neutral when ProGM rank and ADP are closely aligned', () => {
  const r = computeMarketContext({ progmRank: 20, yahooAdp: 22, currentPick: 20 });
  assert.equal(r.label, 'neutral');
});

test('DRAFT NOW: strong value AND unlikely to survive to next pick (next pick known)', () => {
  // ProGM #6, ADP 18 (strong value +12), next pick 24 -> 18 <= 24-3=21 => won't survive.
  const r = computeMarketContext({ progmRank: 6, yahooAdp: 18, currentPick: 10, nextPick: 24 });
  assert.equal(r.label, 'DRAFT NOW');
});

test('WAIT: ProGM likes him but ADP suggests he survives to next pick', () => {
  // ProGM #10, ADP 20 (value +10), next pick 20 -> adp >= nextPick => likely survives.
  const r = computeMarketContext({ progmRank: 10, yahooAdp: 20, currentPick: 12, nextPick: 20 });
  assert.equal(r.label, 'WAIT');
});

test('DRAFT NOW / WAIT are OMITTED when next pick is unknown (fall back to VALUE/REACH)', () => {
  // Same strong-value inputs as the DRAFT NOW case but WITHOUT nextPick.
  const r = computeMarketContext({ progmRank: 8, yahooAdp: 22, currentPick: 10, nextPick: null });
  assert.equal(r.label, 'VALUE'); // not DRAFT NOW
  assert.notEqual(r.label, 'DRAFT NOW');
  assert.notEqual(r.label, 'WAIT');
});

test('thresholds are the documented, tunable constants', () => {
  assert.equal(ADP_THRESHOLDS.VALUE_GAP, 8);
  assert.equal(ADP_THRESHOLDS.REACH_GAP, 10);
  assert.equal(ADP_THRESHOLDS.STRONG_VALUE_GAP, 12);
  assert.equal(ADP_THRESHOLDS.SURVIVE_MARGIN, 3);
});
