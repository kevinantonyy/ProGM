import { test } from 'node:test';
import assert from 'node:assert/strict';
import { set, get, isFresh, remember, clearAll, freshnessFrom, inFlightCount } from './cache.js';

test('set/get returns value with cacheHit metadata', () => {
  clearAll();
  set('k1', { a: 1 }, { provider: 'sample_provider', ttl: 10000 });
  const hit = get('k1');
  assert.deepEqual(hit.value, { a: 1 });
  assert.equal(hit.meta.provider, 'sample_provider');
  assert.equal(hit.meta.cacheHit, true);
  assert.equal(hit.meta.stale, false);
});

test('isFresh reflects TTL expiry', () => {
  clearAll();
  set('k2', 1, { provider: 'p', ttl: 10000 });
  assert.equal(isFresh('k2'), true);
  set('k3', 1, { provider: 'p', ttl: -1 }); // already expired
  assert.equal(isFresh('k3'), false);
  assert.equal(get('k3').meta.stale, true);
});

test('remember returns cached fresh value without calling loader', async () => {
  clearAll();
  set('k4', 'cached', { provider: 'p', ttl: 10000 });
  let called = false;
  const res = await remember('k4', { provider: 'p', ttl: 10000 }, async () => { called = true; return 'new'; });
  assert.equal(res.value, 'cached');
  assert.equal(called, false);
});

test('remember runs loader on miss and caches result', async () => {
  clearAll();
  const res = await remember('k5', { provider: 'p', ttl: 10000 }, async () => 'fresh');
  assert.equal(res.value, 'fresh');
  assert.equal(res.meta.cacheHit, false);
  assert.equal(get('k5').value, 'fresh');
});

test('remember serves STALE cache when loader fails (never throws away real data)', async () => {
  clearAll();
  set('k6', 'stale-real', { provider: 'p', ttl: -1 }); // expired
  const res = await remember('k6', { provider: 'p', ttl: 10000 }, async () => { throw new Error('provider down'); });
  assert.equal(res.value, 'stale-real');
  assert.equal(res.meta.stale, true);
});

test('remember rethrows when loader fails and nothing cached', async () => {
  clearAll();
  await assert.rejects(
    () => remember('k7', { provider: 'p', ttl: 10000 }, async () => { throw new Error('down'); }),
    /down/
  );
});

test('single-flight: concurrent misses for the same key trigger ONE loader call', async () => {
  clearAll();
  let calls = 0;
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return 'value'; };
  // Fire 10 concurrent requests for the same uncached key.
  const results = await Promise.all(Array.from({ length: 10 }, () => remember('dedup', { provider: 'p', ttl: 10000 }, loader)));
  assert.equal(calls, 1); // only one provider fetch despite 10 concurrent callers
  assert.ok(results.every((r) => r.value === 'value'));
  assert.equal(inFlightCount(), 0); // in-flight map cleaned up
});

test('single-flight: different keys are NOT coalesced', async () => {
  clearAll();
  let calls = 0;
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return 'v'; };
  await Promise.all([
    remember('a', { provider: 'p', ttl: 10000 }, loader),
    remember('b', { provider: 'p', ttl: 10000 }, loader),
  ]);
  assert.equal(calls, 2);
});

test('freshnessFrom aggregates provider metas', () => {
  const meta = freshnessFrom(
    { provider: 'tank01', fetchedAt: '2026-01-01T00:00:00.000Z', stale: false, cacheHit: true },
    { provider: 'tank01', fetchedAt: '2026-01-02T00:00:00.000Z', stale: true, cacheHit: false }
  );
  assert.deepEqual(meta.providers, ['tank01']);
  assert.equal(meta.fetchedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(meta.stale, true);
  assert.equal(meta.cacheHit, false);
});
