import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooDraftResults, peekYahooDraftResults, purgeExpiredDraftStates, clearYahooDraftPollingState, draftPollingCacheStats, YAHOO_DRAFT_POLLING_DEFAULTS as DEFAULTS } from './yahooDraftPolling.js';

test('production defaults: raw draft-results fallback is 2 hours; the request cadence (8 s fresh, backoff, circuit) is unchanged', () => {
  assert.equal(DEFAULTS.staleTtlMs, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULTS.freshTtlMs, 8_000);
  assert.deepEqual([DEFAULTS.baseBackoffMs, DEFAULTS.maxBackoffMs, DEFAULTS.circuitThreshold, DEFAULTS.circuitOpenMs], [5_000, 300_000, 3, 60_000]);
});

beforeEach(() => clearYahooDraftPollingState());
const OPTIONS = { freshTtlMs: 10, staleTtlMs: 1_000 };
const ok = (leagueKey, value, at) => fetchYahooDraftResults({ leagueKey, loader: async () => value, now: () => at, options: OPTIONS });

test('a league whose last response is older than the stale window is deleted, not kept forever', async () => {
  await ok('466.l.1', { picks: [1] }, 0);
  assert.ok(peekYahooDraftResults('466.l.1', { now: () => 500, options: OPTIONS }));
  assert.equal(purgeExpiredDraftStates({ now: () => 500, options: OPTIONS }), 0, 'still inside the window');
  assert.equal(purgeExpiredDraftStates({ now: () => 1_500, options: OPTIONS }), 1);
  assert.equal(peekYahooDraftResults('466.l.1', { now: () => 1_500, options: OPTIONS }), null);
});

test('backoff control survives its deadline, but raw picks expire independently while backing off', async () => {
  await ok('466.l.2', { picks: [1] }, 0);
  const err = Object.assign(new Error('denied'), { httpStatus: 999 });
  await fetchYahooDraftResults({ leagueKey: '466.l.2', loader: async () => { throw err; }, now: () => 100, random: () => 0.5, options: { ...OPTIONS, baseBackoffMs: 10_000 } });
  assert.equal(purgeExpiredDraftStates({ now: () => 5_000, options: OPTIONS }), 0, 'in backoff: not purged even though the data is past the stale window');
  assert.deepEqual(draftPollingCacheStats(), { states: 1, cachedResults: 0 }, 'raw picks were physically released');
  assert.equal(purgeExpiredDraftStates({ now: () => 60_000, options: OPTIONS }), 0, 'retry deadline is not a reason to forget denial history');
  assert.equal(purgeExpiredDraftStates({ now: () => DEFAULTS.controlIdleTtlMs + 101, options: OPTIONS }), 1, 'inactive control metadata is bounded too');
});

test('repeated HTTP 999s preserve escalation through minute sweeps and success alone resets active backoff', async () => {
  let at = 1_000_000; let calls = 0;
  const denied = async () => { calls++; throw Object.assign(new Error('synthetic denied'), { httpStatus: 999 }); };
  const counts = []; const delays = [];
  for (const step of [0, 5_000, 10_000, 60_000, 60_000, 80_000]) {
    at += step;
    purgeExpiredDraftStates({ now: () => at });
    const r = await fetchYahooDraftResults({ leagueKey: '466.l.denied', loader: denied, now: () => at, random: () => 0.5 });
    counts.push(r.meta.consecutiveDenied); delays.push(r.meta.retryAfterMs);
    await fetchYahooDraftResults({ leagueKey: '466.l.denied', loader: denied, now: () => at + 1 });
  }
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(delays, [5000, 10000, 60000, 60000, 80000, 160000]);
  assert.equal(calls, 6, 'extra clients inside backoff do not make more requests');
  at += 160_000;
  const recovered = await fetchYahooDraftResults({ leagueKey: '466.l.denied', loader: async () => ({ picks: [] }), now: () => at });
  assert.equal(recovered.meta.consecutiveDenied, 0);
});

test('expired raw picks are released during an in-flight refresh, without deleting its single-flight state', async () => {
  let at = 0;
  await ok('466.l.flight', { picks: ['old private pick'] }, at);
  let finish; let calls = 0;
  const loader = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  at = 100;
  const pending = fetchYahooDraftResults({ leagueKey: '466.l.flight', loader, now: () => at, options: OPTIONS });
  at = 2000;
  purgeExpiredDraftStates({ now: () => at, options: OPTIONS });
  assert.deepEqual(draftPollingCacheStats(), { states: 1, cachedResults: 0 });
  const joined = fetchYahooDraftResults({ leagueKey: '466.l.flight', loader, now: () => at, options: OPTIONS });
  assert.equal(calls, 1);
  finish({ picks: ['new pick'] });
  assert.deepEqual((await pending).value, (await joined).value);
  assert.deepEqual(draftPollingCacheStats(), { states: 1, cachedResults: 1 });
  assert.equal(peekYahooDraftResults('466.l.flight', { now: () => at, options: OPTIONS }).fetchedAt, new Date(at).toISOString());
});

test('fetching one league lazily purges other leagues that have expired', async () => {
  await ok('466.l.3', { picks: [1] }, 0);
  await ok('466.l.4', { picks: [2] }, 5_000_000); // a much later request for a different league triggers the purge
  assert.equal(peekYahooDraftResults('466.l.3', { now: () => 5_000_000, options: OPTIONS }), null);
  assert.ok(peekYahooDraftResults('466.l.4', { now: () => 5_000_000, options: OPTIONS }));
});
