import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearYahooDraftPollingState,
  fetchYahooDraftResults,
} from './yahooDraftPolling.js';

beforeEach(() => clearYahooDraftPollingState());

test('coalesces overlapping requests and serves the bounded fresh cache', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const loader = async () => { calls += 1; await pending; return { picks: [1] }; };
  const a = fetchYahooDraftResults({ leagueKey: '1.l.1', loader, now: () => 1_000 });
  const b = fetchYahooDraftResults({ leagueKey: '1.l.1', loader, now: () => 1_000 });
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);

  const cached = await fetchYahooDraftResults({ leagueKey: '1.l.1', loader, now: () => 5_000 });
  assert.equal(cached.meta.cacheHit, true);
  assert.equal(calls, 1);
});

test('HTTP 999 preserves the last successful response and supplies backoff', async () => {
  let now = 1_000;
  await fetchYahooDraftResults({ leagueKey: '1.l.2', loader: async () => ({ picks: [1, 2] }), now: () => now });
  now = 10_000;
  const denied = Object.assign(new Error('Request denied'), { httpStatus: 999 });
  const result = await fetchYahooDraftResults({
    leagueKey: '1.l.2',
    loader: async () => { throw denied; },
    now: () => now,
    random: () => 0.5,
  });
  assert.deepEqual(result.value, { picks: [1, 2] });
  assert.equal(result.meta.stale, true);
  assert.equal(result.meta.temporaryUnavailable, true);
  assert.equal(result.meta.retryAfterMs, 5_000);
});

test('backoff blocks retry loops and opens the circuit after repeated 999s', async () => {
  let now = 0;
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw Object.assign(new Error('Request denied'), { httpStatus: 999 });
  };
  const opts = { leagueKey: '1.l.3', loader, now: () => now, random: () => 0.5 };

  const first = await fetchYahooDraftResults(opts);
  assert.equal(first.meta.retryAfterMs, 5_000);
  now = 1_000;
  const blocked = await fetchYahooDraftResults(opts);
  assert.equal(blocked.meta.temporaryUnavailable, true);
  assert.equal(calls, 1);

  now = 5_000;
  const second = await fetchYahooDraftResults(opts);
  assert.equal(second.meta.retryAfterMs, 10_000);
  now = 15_000;
  const third = await fetchYahooDraftResults(opts);
  assert.equal(third.meta.circuitOpen, true);
  assert.equal(third.meta.retryAfterMs, 60_000);
  now = 20_000;
  await fetchYahooDraftResults(opts);
  assert.equal(calls, 3);
});

test('non-999 failures are not hidden by the circuit breaker', async () => {
  await assert.rejects(
    fetchYahooDraftResults({
      leagueKey: '1.l.4',
      loader: async () => { throw Object.assign(new Error('Unauthorized'), { httpStatus: 401 }); },
    }),
    /Unauthorized/,
  );
});

test('expired stale success is not returned indefinitely', async () => {
  let now = 0;
  await fetchYahooDraftResults({ leagueKey: '1.l.5', loader: async () => ({ picks: [1] }), now: () => now });
  now = 101;
  const result = await fetchYahooDraftResults({
    leagueKey: '1.l.5',
    loader: async () => { throw Object.assign(new Error('Request denied'), { httpStatus: 999 }); },
    now: () => now,
    options: { freshTtlMs: 10, staleTtlMs: 100 },
  });
  assert.equal(result.value, null);
  assert.equal(result.meta.cacheHit, false);
});
