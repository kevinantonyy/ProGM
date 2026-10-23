import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeNegotiatorEnabled } from './tradeNegotiator.js';

test('the football trade negotiator is OFF by default and only the exact value "allow" turns it on', () => {
  assert.equal(tradeNegotiatorEnabled(), false, 'no build env at all (node, tests)');
  for (const v of [undefined, null, '', 'true', '1', 'on', 'ALLOW', ' allow', 'allow ', 'yes', true]) assert.equal(tradeNegotiatorEnabled({ VITE_PROGM_TRADE_NEGOTIATOR: v }), false, String(v));
  assert.equal(tradeNegotiatorEnabled({}), false);
  assert.equal(tradeNegotiatorEnabled({ VITE_PROGM_TRADE_NEGOTIATOR: 'allow' }), true);
});
