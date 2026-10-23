import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanupExpiredYahooOAuthRows, startYahooOAuthCleanup } from './yahooOauthCleanup.js';

test('deletes only expired state and pending rows, never the active connections table, and reports counts', async () => {
  const sql = [];
  const execute = async (q) => { sql.push(q); return [{ affectedRows: 2 }]; };
  const removed = await cleanupExpiredYahooOAuthRows(execute);
  assert.deepEqual(removed, { oauthStates: 2, pendingConnections: 2 });
  assert.equal(sql.length, 2);
  for (const q of sql) {
    assert.match(q, /^DELETE FROM (yahoo_oauth_states|yahoo_pending_connections) WHERE (claim_)?expires_at < NOW\(\)$/);
    assert.doesNotMatch(q, /yahoo_connections/);
  }
});

test('one failing statement does not stop the other and never throws', async (t) => {
  t.mock.method(console, 'error', () => {});
  let n = 0;
  const execute = async () => { n += 1; if (n === 1) throw new Error('db down'); return [{ affectedRows: 3 }]; };
  assert.deepEqual(await cleanupExpiredYahooOAuthRows(execute), { oauthStates: 0, pendingConnections: 3 });
});

test('runs at startup and on a timer, and the timer can be stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = startYahooOAuthCleanup(async () => { calls += 1; return [{ affectedRows: 0 }]; }, { intervalMs: 1000 });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(calls, 2, 'one run (two statements) immediately');
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls, 2 + 3 * 2);
  stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 8);
});

test('the cleanup module makes no Yahoo request', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./yahooOauthCleanup.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'), /fetch|axios|https?:/);
});
