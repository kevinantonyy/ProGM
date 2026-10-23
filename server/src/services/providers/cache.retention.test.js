import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { set, get, has, isFresh, remember, clearAll, purgeExpired, size, RETENTION } from './cache.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const withClock = (t, fn) => { t.mock.timers.enable({ apis: ['Date'], now: T0 }); return fn((ms) => t.mock.timers.tick(ms)); };

test('a Yahoo entry is served stale for a short grace after it expires, then deleted from memory', (t) => withClock(t, async (advance) => {
  clearAll();
  set('y:ws', { league: 'x' }, { provider: 'yahoo', ttl: 5 * MIN });
  advance(5 * MIN + 10 * MIN); // 10 minutes past expiry: still inside the 15-minute grace
  assert.equal(get('y:ws').meta.stale, true);
  const served = await remember('y:ws', { provider: 'yahoo', ttl: 5 * MIN }, async () => { throw new Error('yahoo 999'); });
  assert.equal(served.meta.stale, true, 'stale fallback still works during a short block');
  advance(6 * MIN); // 16 minutes past expiry: gone
  assert.equal(get('y:ws'), null);
  assert.equal(has('y:ws'), false);
  assert.equal(size(), 0, 'memory is released, not just hidden');
  await assert.rejects(() => remember('y:ws', { provider: 'yahoo', ttl: 5 * MIN }, async () => { throw new Error('yahoo 999'); }), /999/);
}));

test('entries computed by ProGM from Yahoo data get the same retention when tagged derivedFrom: yahoo', (t) => withClock(t, (advance) => {
  clearAll();
  set('derived', { ranks: [1] }, { provider: 'progm', derivedFrom: 'yahoo', ttl: 10 * MIN });
  set('independent', { stats: [1] }, { provider: 'espn', ttl: 10 * MIN });
  advance(10 * MIN + RETENTION.yahooStaleGraceMs + MIN);
  assert.equal(get('derived'), null, 'Yahoo-derived entry is purged even though its provider label is progm');
  assert.ok(get('independent'), 'independent data keeps its longer stale window');
}));

test('no Yahoo-derived entry can outlive 24 hours, whatever TTL or grace is requested', (t) => withClock(t, (advance) => {
  clearAll();
  set('long', 1, { provider: 'yahoo', ttl: 48 * HOUR });
  set('graced', 1, { provider: 'progm', derivedFrom: 'yahoo', ttl: 20 * HOUR, staleGraceMs: 30 * HOUR });
  advance(24 * HOUR + MIN);
  assert.equal(get('long'), null);
  assert.equal(get('graced'), null);
}));

test('independent provider data is no longer kept forever: purged after the default 24 h stale window', (t) => withClock(t, (advance) => {
  clearAll();
  set('stats', 1, { provider: 'espn', ttl: HOUR });
  advance(HOUR + 23 * HOUR);
  assert.ok(get('stats'));
  advance(2 * HOUR);
  assert.equal(get('stats'), null);
}));

test('purgeExpired removes only expired entries and reports the count; fresh entries are untouched', (t) => withClock(t, (advance) => {
  clearAll();
  set('old1', 1, { provider: 'yahoo', ttl: MIN });
  set('old2', 1, { provider: 'yahoo', ttl: MIN });
  advance(40 * MIN);
  assert.equal(purgeExpired(), 2);
  set('fresh', 1, { provider: 'yahoo', ttl: 5 * MIN });
  assert.equal(purgeExpired(), 0, 'nothing else is expired');
  assert.equal(size(), 1);
  assert.equal(isFresh('fresh'), true);
}));

test('an idle-then-busy server sweeps on write without an explicit purge call', (t) => withClock(t, async (advance) => {
  // The module records its last sweep time at import. Load a fresh instance under the mocked clock so that state starts at T0,
  // whatever the real calendar date is (the shared instance above was imported with the real clock).
  const fresh = await import('./cache.js?sweep-under-mocked-clock');
  try {
    for (let i = 0; i < 50; i += 1) fresh.set(`k${i}`, i, { provider: 'yahoo', ttl: MIN });
    advance(2 * HOUR);
    fresh.set('trigger', 1, { provider: 'yahoo', ttl: MIN });
    assert.equal(fresh.size(), 1, 'the 50 expired Yahoo entries were removed by the opportunistic sweep');
  } finally { fresh.stopSweeper(); }
}));

test('retention constants match the documented policy', () => {
  assert.equal(RETENTION.yahooStaleGraceMs, 15 * MIN);
  assert.equal(RETENTION.yahooHardCapMs, 24 * HOUR);
});

test('every ProGM-labelled cache write that holds Yahoo-derived data is tagged derivedFrom: yahoo', () => {
  const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
  for (const file of ['../../routes/basketball.js', '../fantasy/baselineReference.js']) {
    const lines = fs.readFileSync(here(file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/cache\.set\(/.test(line) && /provider: 'progm'/.test(line)) assert.match(line, /derivedFrom: 'yahoo'/, `${file}:${i + 1} stores Yahoo-derived data under provider 'progm' without a tag`);
    });
  }
});
