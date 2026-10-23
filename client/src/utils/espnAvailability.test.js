import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ESPN_UNAVAILABLE, parseEspnAvailability, loadEspnAvailability, resetEspnAvailability } from './espnAvailability.js';

beforeEach(() => resetEspnAvailability());

test('ESPN is unavailable unless the server says exactly available: true (fails closed)', () => {
  for (const bad of [undefined, null, {}, [], 'yes', { available: 'true' }, { available: 1 }, { available: false }, { availableX: true }]) {
    const r = parseEspnAvailability(bad);
    assert.equal(r.available, false, JSON.stringify(bad));
    assert.ok(r.message.length > 20, 'always carries an explanation');
  }
  assert.deepEqual(parseEspnAvailability({ available: true }), { available: true });
});

test('the server message is shown when it sends one; otherwise the built-in explanation', () => {
  assert.equal(parseEspnAvailability({ available: false, message: 'Custom text.' }).message, 'Custom text.');
  assert.equal(parseEspnAvailability({ available: false, message: '   ' }).message, ESPN_UNAVAILABLE.message);
  assert.match(ESPN_UNAVAILABLE.message, /ESPN has declined to permit use of its data/);
  assert.match(ESPN_UNAVAILABLE.message, /Yahoo basketball league is not affected/);
});

test('one request is shared by every component; a failed request means "not available"', async () => {
  let calls = 0;
  const get = async () => { calls += 1; return { available: false, message: 'm' }; };
  const [a, b, c] = await Promise.all([loadEspnAvailability(get), loadEspnAvailability(get), loadEspnAvailability(get)]);
  assert.equal(calls, 1);
  assert.deepEqual([a.available, b.available, c.available], [false, false, false]);

  resetEspnAvailability();
  const failing = await loadEspnAvailability(async () => { throw new Error('network'); });
  assert.equal(failing.available, false);
  assert.equal(failing.message, ESPN_UNAVAILABLE.message);

  resetEspnAvailability();
  assert.deepEqual(await loadEspnAvailability(async () => ({ available: true })), { available: true });
});
