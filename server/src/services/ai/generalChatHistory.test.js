import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralChatHistory, MAX_HISTORY_TOKEN_LENGTH } from './generalChatHistory.js';

test('general receipts are bounded, encrypted, expire, and fail closed across users and server restarts', () => {
  let now = 100;
  const codec = createGeneralChatHistory({ now: () => now });
  const messages = [{ role: 'user', text: 'General question' }, { role: 'gm', text: 'General answer' }];
  const token = codec.issue(messages, 1);
  assert.deepEqual(codec.read(token, 1), messages);
  assert.ok(!token.includes('General'));
  assert.deepEqual(codec.read(token, 2), []);
  assert.deepEqual(createGeneralChatHistory().read(token, 1), []);
  for (const bad of [null, {}, '', 'g1.a.b.c', token + '.extra', 'x'.repeat(MAX_HISTORY_TOKEN_LENGTH + 1)]) assert.deepEqual(codec.read(bad, 1), []);
  now = 0; assert.deepEqual(codec.read(token, 1), [], 'future receipts are not trusted');
  now = 600_100; assert.deepEqual(codec.read(token, 1), []);
});

test('Unicode general histories fit the receipt budget, contain only role/text and never exceed ten entries', () => {
  const codec = createGeneralChatHistory();
  const input = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'gm' : 'user', text: '🏀'.repeat(600), meta: { old: 'not serialized' } }));
  const token = codec.issue(input, 1);
  assert.ok(token.length <= MAX_HISTORY_TOKEN_LENGTH);
  const history = codec.read(token, 1);
  assert.ok(history.length > 0 && history.length <= 10);
  assert.ok(history.every((m) => Object.keys(m).join(',') === 'role,text'));
  assert.equal(codec.issue([{ role: 'system', text: 'unsupported' }], 1), null);
  assert.equal(codec.issue([null], 1), null);
  assert.equal(codec.issue(input, null), null);
});
