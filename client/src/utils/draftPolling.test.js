import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftPollBackoffMs, shouldStopDraftPolling } from './draftPolling.js';

test('inactive draft states stop polling while live/unavailable states can retry', () => {
  assert.equal(shouldStopDraftPolling('predraft'), true);
  assert.equal(shouldStopDraftPolling('complete'), true);
  assert.equal(shouldStopDraftPolling('live'), false);
  assert.equal(shouldStopDraftPolling('unavailable'), false);
});

test('client backoff is exponential, honors server delay, and remains bounded', () => {
  assert.equal(draftPollBackoffMs({ failureCount: 1, random: () => 0.5 }), 5_000);
  assert.equal(draftPollBackoffMs({ failureCount: 2, random: () => 0.5 }), 10_000);
  assert.equal(draftPollBackoffMs({ failureCount: 1, retryAfterMs: 60_000, random: () => 0.5 }), 60_000);
  assert.equal(draftPollBackoffMs({ failureCount: 20, retryAfterMs: 900_000, random: () => 0.5 }), 300_000);
});
