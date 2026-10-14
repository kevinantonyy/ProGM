import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertYahooRequestAllowed,
  recordYahooResponse,
  resetYahooRequestGuard,
} from './yahooRequestGuard.js';

beforeEach(() => resetYahooRequestGuard());

test('HTTP 999 opens bounded exponential backoff and blocks outbound retries', () => {
  let now = 1_000;
  const first = recordYahooResponse(999, {}, { now: () => now, random: () => 0.5 });
  assert.equal(first.retryAfterMs, 5_000);
  assert.throws(() => assertYahooRequestAllowed({ now: () => now + 1_000 }), (error) => {
    assert.equal(error.httpStatus, 999);
    assert.equal(error.yahooCode, 'CIRCUIT_OPEN');
    assert.equal(error.synthetic, true);
    return true;
  });
  assert.doesNotThrow(() => assertYahooRequestAllowed({ now: () => now + 5_000 }));
});

test('Retry-After is honored when Yahoo supplies it', () => {
  const result = recordYahooResponse(999, { 'retry-after': '30' }, { now: () => 0, random: () => 0.5 });
  assert.equal(result.retryAfterMs, 30_000);
});

test('three denials open the one-minute circuit and success resets it', () => {
  let now = 0;
  recordYahooResponse(999, {}, { now: () => now, random: () => 0.5 });
  now = 5_000;
  recordYahooResponse(999, {}, { now: () => now, random: () => 0.5 });
  now = 15_000;
  const third = recordYahooResponse(999, {}, { now: () => now, random: () => 0.5 });
  assert.equal(third.circuitOpen, true);
  assert.equal(third.retryAfterMs, 60_000);
  recordYahooResponse(200, {}, { now: () => now });
  assert.doesNotThrow(() => assertYahooRequestAllowed({ now: () => now }));
});

test('ordinary authentication failures do not masquerade as rate blocking', () => {
  recordYahooResponse(401, {}, { now: () => 0 });
  assert.doesNotThrow(() => assertYahooRequestAllowed({ now: () => 0 }));
});
