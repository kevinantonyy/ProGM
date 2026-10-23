import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmRouter, buildGeminiRequest } from './gm.js';

const SENTINEL = 'ZZ-SENTINEL-LEAGUE-NAME';
const ROSTER_SENTINEL = 'ZZ-SENTINEL-PLAYER';
const KEY_SENTINEL = '466.p.99999';

// Every shape a client could send as "league data", with every label it could claim. None of it may reach the provider.
const yahooContext = () => ({ sport: 'basketball', source: 'yahoo', league: SENTINEL, myTeam: 'ZZ-SENTINEL-TEAM', roster: [{ name: ROSTER_SENTINEL, ownedPct: 55 }], standings: [{ name: 'ZZ-SENTINEL-RIVAL', wins: 3 }] });
const espnContext = () => ({ sport: 'football', source: 'espn', league: SENTINEL, myTeam: 'ZZ-SENTINEL-TEAM', roster: [{ name: ROSTER_SENTINEL, nflTeam: 'XYZ', projected: 12 }] });
const mislabelled = () => ({ ...yahooContext(), source: 'espn', sport: 'football' }); // Yahoo data wearing an ESPN label
const unlabelled = () => ({ league: SENTINEL, roster: [{ name: ROSTER_SENTINEL, playerKey: KEY_SENTINEL }] });
const FORBIDDEN = [SENTINEL, ROSTER_SENTINEL, 'ZZ-SENTINEL-TEAM', 'ZZ-SENTINEL-RIVAL', KEY_SENTINEL, 'USER-APPROVED LEAGUE SUMMARY'];

function setup(env = {}, geminiBody = { candidates: [{ content: { parts: [{ text: 'general answer' }] } }] }, status = 200, extra = {}) {
  const sent = [];
  const router = createGmRouter({
    authenticate: (req, res, next) => next(),
    env: { GEMINI_API_KEY: 'test-key-not-real', ...env },
    fetchImpl: async (url, init) => { sent.push({ url, init, body: init.body }); return { ok: status < 400, status, json: async () => geminiBody }; },
    ...extra,
  });
  const handler = router.stack.find((layer) => layer.route?.path === '/chat').route.stack.at(-1).handle;
  const call = async (body, userId = 1) => {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    await handler({ userId, body }, res);
    return res;
  };
  return { call, sent };
}
const chat = (league, text = 'Should I start Player A or Player B?', extra = {}) => ({ messages: [{ role: 'user', text }], league, ...extra });
const assertNothingLeaked = (sent) => { for (const secret of FORBIDDEN) assert.ok(!sent[0].body.includes(secret), `${secret} leaked to the provider`); };

test('client-supplied league data is never sent, whatever it is labelled (yahoo, espn, mislabelled, unlabelled)', async () => {
  for (const league of [yahooContext(), espnContext(), mislabelled(), unlabelled()]) {
    const { call, sent } = setup();
    const res = await call(chat(league));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'general answer');
    assert.equal(res.body.leagueDataShared, false);
    assert.equal(sent.length, 1);
    assertNothingLeaked(sent);
    assert.ok(sent[0].body.includes('Should I start Player A or Player B?'), "the user's own message is still forwarded");
    assert.match(sent[0].body, /No league, roster or standings data has been shared/);
  }
});

test('the exact override values do not make the server trust client data, even with a server-side setting turned on', async () => {
  for (const env of [{ PROGM_AI_YAHOO_DATA: 'allow' }, { PROGM_AI_ESPN_DATA: 'allow' }, { PROGM_AI_YAHOO_DATA: 'allow', PROGM_AI_ESPN_DATA: 'allow' }]) {
    for (const league of [yahooContext(), espnContext()]) {
      const { call, sent } = setup(env);
      await call(chat(league, 'hi', { contextRequest: league.source === 'yahoo' ? 'yahoo_league' : 'espn_football_league' }));
      assertNothingLeaked(sent);
    }
  }
});

test('a requested context is blocked unless a server-side builder exists AND the source is enabled; unknown kinds are blocked', async () => {
  for (const contextRequest of ['espn_football_league', 'yahoo_league', 'espn', 'yahoo', 'basketball', 'user_message', '__proto__', 'constructor', {}, ['yahoo_league'], 7]) {
    const { call, sent } = setup();
    const res = await call(chat(yahooContext(), 'hi', { contextRequest }));
    assert.equal(res.body.leagueDataShared, false, `request ${JSON.stringify(contextRequest)}`);
    assert.ok(res.body.leagueDataNotice, 'the user is told why');
    assertNothingLeaked(sent);
  }
  // enabled in the environment but no builder registered (today's state): still blocked
  const noBuilder = setup({ PROGM_AI_ESPN_DATA: 'allow' });
  assert.equal((await noBuilder.call(chat(null, 'hi', { contextRequest: 'espn_football_league' }))).body.leagueDataShared, false);
  // builder registered but the source is not enabled: still blocked and the builder is never called
  let called = 0;
  const off = setup({}, undefined, 200, { builders: { espn_football_league: async () => { called += 1; return { context: { league: SENTINEL } }; } } });
  assert.equal((await off.call(chat(null, 'hi', { contextRequest: 'espn_football_league' }))).body.leagueDataShared, false);
  assert.equal(called, 0);
  assertNothingLeaked(off.sent);
});

test('only an enabled, server-built context is forwarded; the client payload is still ignored; Yahoo-shaped server context is refused for ESPN', async () => {
  const builders = { espn_football_league: async () => ({ context: { source: 'server', league: 'SERVER-BUILT-LEAGUE' }, sections: ['overview'], bytes: 40 }) };
  const on = setup({ PROGM_AI_ESPN_DATA: 'allow' }, undefined, 200, { builders });
  const res = await on.call(chat(yahooContext(), 'hi', { contextRequest: 'espn_football_league' }));
  assert.equal(res.body.leagueDataShared, true);
  assert.ok(on.sent[0].body.includes('SERVER-BUILT-LEAGUE'));
  for (const secret of FORBIDDEN.filter((s) => s !== 'USER-APPROVED LEAGUE SUMMARY')) assert.ok(!on.sent[0].body.includes(secret), `${secret} leaked`);

  const smuggling = { espn_football_league: async () => ({ context: { roster: [{ playerKey: KEY_SENTINEL }] } }) };
  const bad = setup({ PROGM_AI_ESPN_DATA: 'allow' }, undefined, 200, { builders: smuggling });
  assert.equal((await bad.call(chat(null, 'hi', { contextRequest: 'espn_football_league' }))).body.leagueDataShared, false);
  assert.ok(!bad.sent[0].body.includes(KEY_SENTINEL));

  const throwing = setup({ PROGM_AI_ESPN_DATA: 'allow' }, undefined, 200, { builders: { espn_football_league: async () => { throw new Error('db down'); } } });
  assert.equal((await throwing.call(chat(null, 'hi', { contextRequest: 'espn_football_league' }))).body.leagueDataShared, false);
});

test('a chat with no league context at all works and is not reported as blocked', async () => {
  const { call, sent } = setup();
  const res = await call({ messages: [{ role: 'user', text: 'Explain points leagues' }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.leagueDataShared, false);
  assert.equal(res.body.leagueDataNotice, null);
  assert.equal(sent.length, 1);
});

test('unchanged behaviour: 503 when unconfigured, 400 on bad messages, 429 after 20 requests, provider errors mapped', async () => {
  const noKey = setup({ GEMINI_API_KEY: '' });
  assert.equal((await noKey.call(chat(espnContext()))).statusCode, 503);
  assert.equal(noKey.sent.length, 0);

  const { call, sent } = setup();
  assert.equal((await call({ messages: [] })).statusCode, 400);
  assert.equal((await call({ messages: [{ role: 'user', text: 'x'.repeat(801) }] })).statusCode, 400);
  assert.equal(sent.length, 0);
  for (let i = 0; i < 20; i += 1) assert.equal((await call(chat(null, 'hi'), 7)).statusCode, 200);
  assert.equal((await call(chat(null, 'hi'), 7)).statusCode, 429, 'the 21st request inside the window is rejected');
  assert.equal((await call(chat(null, 'hi'), 8)).statusCode, 200, 'the limit is per user');

  const quota = setup({}, { error: { message: 'quota' } }, 429);
  assert.equal((await quota.call(chat(null, 'hi'))).statusCode, 429);
  const broken = setup({}, { error: { message: 'boom' } }, 500);
  assert.equal((await broken.call(chat(null, 'hi'))).statusCode, 502);
});

test('error logging never contains league context', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const router = createGmRouter({ authenticate: (q, s, n) => n(), env: { GEMINI_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('network down'); } });
  const handler = router.stack.find((layer) => layer.route?.path === '/chat').route.stack.at(-1).handle;
  const res = { status() { return this; }, json() { return this; } };
  await handler({ userId: 1, body: chat(yahooContext()) }, res);
  assert.ok(logged.length > 0);
  assert.ok(!logged.join('\n').includes(SENTINEL));
});

test('buildGeminiRequest never embeds a context that was not passed to it', () => {
  const body = JSON.stringify(buildGeminiRequest({ messages: [{ role: 'user', text: 'hi' }], leagueContext: null }));
  assert.ok(!body.includes('USER-APPROVED LEAGUE SUMMARY'));
});
