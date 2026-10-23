import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCachedWorkspace } from './basketball.js';

const SEL = { leagueKey: '466.l.12345', teamKey: '466.l.12345.t.3' };

test('readCachedWorkspace is a cache-only, per-user read (never writes, never calls anything else)', () => {
  const asked = [];
  const store = { get: (key) => { asked.push(key); return key.includes(':1:466.l.12345:') ? { value: { provider: 'yahoo' }, meta: { fetchedAt: 'T', stale: false } } : null; } };
  const mine = readCachedWorkspace({ userId: 1, ...SEL }, store);
  assert.deepEqual(mine, { value: { provider: 'yahoo' }, fetchedAt: 'T', stale: false });
  assert.equal(readCachedWorkspace({ userId: 2, ...SEL }, store), null, "another user's id yields a different key, so nothing is found");
  assert.equal(asked.length, 2);
  for (const [i, uid] of [[0, 1], [1, 2]]) assert.match(asked[i], new RegExp(`^bball:workspace:.*:${uid}:466\\.l\\.12345:466\\.l\\.12345\\.t\\.3$`));
  assert.deepEqual(Object.keys(store), ['get'], 'the store exposes only get; a write would throw');
});

test('a stale (but not yet purged) entry is returned with its stale flag so the caller can decide', () => {
  const store = { get: () => ({ value: { provider: 'yahoo' }, meta: { fetchedAt: 'T', stale: true } }) };
  assert.equal(readCachedWorkspace({ userId: 1, ...SEL }, store).stale, true);
});
