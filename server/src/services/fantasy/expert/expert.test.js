/**
 * Tests for the expert intelligence framework.
 * Covers: signal normalization, aggregation/consensus, conflicting opinions,
 * freshness decay, missing/invalid data, safeguards, and DISABLED behavior
 * (the layer must not change recommendations by default).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSignal } from './types.js';
import { aggregateSignals, freshnessWeight, DEFAULT_AGG_OPTIONS } from './aggregator.js';
import {
  getExpertConsensus, applyExpertSignal, isExpertEnabled,
  registerProvider, _resetProvidersForTest,
} from './index.js';

const NOW = Date.parse('2026-01-10T00:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

function sig(over = {}) {
  return {
    name: 'Test Player', source: 'src-a', type: 'start', sentiment: 0.8, confidence: 0.9,
    publishedAt: hoursAgo(1), sourceUrl: 'https://example.com/x', expiresAt: null, ...over,
  };
}

afterEach(() => {
  delete process.env.EXPERT_SIGNALS_ENABLED;
  _resetProvidersForTest();
});

// --- normalization / missing data -------------------------------------------

test('normalizeSignal drops records with missing/invalid fields (never fabricates)', () => {
  assert.equal(normalizeSignal(null), null);
  assert.equal(normalizeSignal({ name: '', type: 'start', source: 's', sentiment: 1, confidence: 1, publishedAt: hoursAgo(1) }), null);
  assert.equal(normalizeSignal({ name: 'A', type: 'bogus', source: 's', sentiment: 1, confidence: 1, publishedAt: hoursAgo(1) }), null);
  assert.equal(normalizeSignal({ name: 'A', type: 'start', source: 's', sentiment: 1, confidence: 1, publishedAt: 'not-a-date' }), null);
  assert.equal(normalizeSignal({ name: 'A', type: 'start', source: 's', sentiment: null, confidence: 1, publishedAt: hoursAgo(1) }), null);
  const ok = normalizeSignal(sig());
  assert.equal(ok.name, 'Test Player');
  assert.equal(ok.sentiment, 0.8);
});

test('normalizeSignal clamps out-of-range sentiment/confidence', () => {
  const s = normalizeSignal(sig({ sentiment: 5, confidence: 2 }));
  assert.equal(s.sentiment, 1);
  assert.equal(s.confidence, 1);
});

// --- aggregation / consensus ------------------------------------------------

test('aggregates agreeing sources into a positive consensus that meets threshold', () => {
  const signals = [
    sig({ source: 'a', sentiment: 0.8 }),
    sig({ source: 'b', sentiment: 0.6 }),
    sig({ source: 'c', sentiment: 0.9 }),
  ];
  const [c] = aggregateSignals(signals, { now: NOW });
  assert.ok(c.score > 0.5);
  assert.equal(c.sourceCount, 3);
  assert.equal(c.conflicted, false);
  assert.equal(c.meetsThreshold, true);
  assert.equal(c.type, 'start');
  assert.equal(c.citations.length, 3);
});

test('deduplicates same source+player+type, newest wins (no double counting)', () => {
  const signals = [
    sig({ source: 'a', sentiment: 0.2, publishedAt: hoursAgo(50) }),
    sig({ source: 'a', sentiment: 0.9, publishedAt: hoursAgo(1) }), // newer from same source
    sig({ source: 'b', sentiment: 0.8 }),
  ];
  const [c] = aggregateSignals(signals, { now: NOW });
  assert.equal(c.sourceCount, 2); // 'a' counted once
  assert.ok(c.score > 0.5);       // newer, stronger 'a' opinion dominates
});

// --- conflicting opinions ---------------------------------------------------

test('flags conflict when sources materially disagree and does NOT meet threshold', () => {
  const signals = [
    sig({ source: 'a', type: 'start', sentiment: 0.9 }),
    sig({ source: 'b', type: 'sit', sentiment: 0.9 }), // sit => negative direction
    sig({ source: 'c', type: 'start', sentiment: 0.8 }),
    sig({ source: 'd', type: 'sit', sentiment: 0.85 }),
  ];
  const [c] = aggregateSignals(signals, { now: NOW });
  assert.equal(c.conflicted, true);
  assert.equal(c.type, null);          // no dominant type when conflicted
  assert.equal(c.meetsThreshold, false);
});

test('sit/drop/sell carry negative direction regardless of positive sentiment magnitude', () => {
  const [c] = aggregateSignals([
    sig({ source: 'a', type: 'sell', sentiment: 0.9 }),
    sig({ source: 'b', type: 'sell', sentiment: 0.7 }),
  ], { now: NOW });
  assert.ok(c.score < 0);
  assert.equal(c.type, 'sell');
});

// --- freshness decay --------------------------------------------------------

test('freshnessWeight decays by half-life and voids expired/too-old signals', () => {
  const opts = DEFAULT_AGG_OPTIONS;
  const fresh = freshnessWeight(normalizeSignal(sig({ publishedAt: hoursAgo(0) })), NOW, opts);
  const half = freshnessWeight(normalizeSignal(sig({ publishedAt: hoursAgo(48) })), NOW, opts);
  const old = freshnessWeight(normalizeSignal(sig({ publishedAt: hoursAgo(1000) })), NOW, opts);
  const expired = freshnessWeight(normalizeSignal(sig({ publishedAt: hoursAgo(1), expiresAt: hoursAgo(0.5) })), NOW, opts);
  assert.ok(fresh > 0.95);
  assert.ok(Math.abs(half - 0.5) < 0.05);
  assert.equal(old, 0);     // beyond maxAgeHours
  assert.equal(expired, 0); // past expiresAt
});

test('fresher signal outweighs an older opposing one', () => {
  const [c] = aggregateSignals([
    sig({ source: 'a', type: 'start', sentiment: 0.9, publishedAt: hoursAgo(1) }),
    sig({ source: 'b', type: 'sit', sentiment: 0.9, publishedAt: hoursAgo(140) }),
  ], { now: NOW });
  assert.ok(c.score > 0); // fresh start outweighs stale sit
});

test('all-expired player yields a zero, below-threshold consensus (not dropped silently)', () => {
  const [c] = aggregateSignals([
    sig({ source: 'a', publishedAt: hoursAgo(1), expiresAt: hoursAgo(0.5) }),
  ], { now: NOW });
  assert.equal(c.meetsThreshold, false);
  assert.equal(c.score, 0);
  assert.equal(c.sourceCount, 0);
});

// --- safeguards -------------------------------------------------------------

test('single source does NOT meet the minimum-source safeguard', () => {
  const [c] = aggregateSignals([sig({ source: 'only' })], { now: NOW });
  assert.equal(c.sourceCount, 1);
  assert.equal(c.meetsThreshold, false);
});

test('low aggregate confidence does NOT meet the safeguard', () => {
  const [c] = aggregateSignals([
    sig({ source: 'a', confidence: 0.2 }),
    sig({ source: 'b', confidence: 0.2 }),
  ], { now: NOW });
  assert.ok(c.confidence < 0.5);
  assert.equal(c.meetsThreshold, false);
});

// --- disabled-by-default behavior -------------------------------------------

test('isExpertEnabled is false by default', () => {
  assert.equal(isExpertEnabled(), false);
});

test('getExpertConsensus is disabled and empty by default', async () => {
  const res = await getExpertConsensus({ playerNames: ['Test Player'] });
  assert.equal(res.enabled, false);
  assert.deepEqual(res.consensus, []);
  assert.match(res.reason, /disabled/i);
});

test('even with the flag on, the default (null) provider yields no signals', async () => {
  process.env.EXPERT_SIGNALS_ENABLED = 'true';
  const res = await getExpertConsensus({ playerNames: ['Test Player'] });
  // null provider is always disabled -> no active providers.
  assert.equal(res.enabled, false);
  assert.deepEqual(res.consensus, []);
});

test('a registered enabled provider flows through only when the flag is on', async () => {
  // getExpertConsensus aggregates with the REAL current time, so use fresh
  // (now-relative) timestamps here rather than the fixed NOW fixture.
  const freshNow = new Date().toISOString();
  const fakeSig = (source) => sig({ source, publishedAt: freshNow, expiresAt: null });
  const fake = {
    name: 'fake',
    isEnabled: () => true,
    getSignals: async () => [fakeSig('a'), fakeSig('b')],
  };
  registerProvider(fake);
  // Flag OFF -> still disabled.
  const off = await getExpertConsensus({ playerNames: ['Test Player'] });
  assert.equal(off.enabled, false);
  // Flag ON -> provider contributes.
  process.env.EXPERT_SIGNALS_ENABLED = 'true';
  const on = await getExpertConsensus({ playerNames: ['Test Player'] });
  assert.equal(on.enabled, true);
  assert.equal(on.consensus.length, 1);
  assert.equal(on.consensus[0].sourceCount, 2);
});

// --- applyExpertSignal (optional recommendation nudge) ----------------------

test('applyExpertSignal is a pure pass-through when disabled (recommendations unchanged)', () => {
  const r = applyExpertSignal(30, { meetsThreshold: true, score: 1, type: 'start' });
  assert.equal(r.value, 30);        // unchanged
  assert.equal(r.adjusted, false);
  assert.equal(r.reason, 'disabled');
});

test('applyExpertSignal nudges within bounds only when enabled + threshold met', () => {
  process.env.EXPERT_SIGNALS_ENABLED = 'true';
  const up = applyExpertSignal(100, { meetsThreshold: true, score: 1, type: 'start' }, { maxAdjustment: 0.1 });
  assert.equal(up.value, 110); // +10% cap
  assert.equal(up.adjusted, true);
  const down = applyExpertSignal(100, { meetsThreshold: true, score: -1, type: 'sell' }, { maxAdjustment: 0.1 });
  assert.equal(down.value, 90);
  // Below threshold -> unchanged.
  const none = applyExpertSignal(100, { meetsThreshold: false, score: 1 });
  assert.equal(none.value, 100);
  assert.equal(none.adjusted, false);
  // Null base stays null (never fabricated).
  assert.equal(applyExpertSignal(null, { meetsThreshold: true, score: 1 }).value, null);
});
