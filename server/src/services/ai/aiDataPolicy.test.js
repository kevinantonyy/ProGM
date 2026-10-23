import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_SOURCES, DEFAULT_BUILDERS, findYahooMarkers, sourceEnabled, resolveAiContext, BLOCKED_NOTICE } from './aiDataPolicy.js';

test('allowlist: only the user message is allowed; ESPN and Yahoo league sources are registered but blocked by default', () => {
  assert.deepEqual(Object.keys(AI_SOURCES).sort(), ['espn_football_league', 'user_message', 'yahoo_league']);
  assert.equal(AI_SOURCES.user_message.allowed, true);
  assert.equal(AI_SOURCES.espn_football_league.allowed, false);
  assert.equal(AI_SOURCES.yahoo_league.allowed, false);
  assert.deepEqual(Object.keys(DEFAULT_BUILDERS), [], 'no server-side league-context builder exists today');
  assert.ok(Object.isFrozen(AI_SOURCES) && Object.isFrozen(DEFAULT_BUILDERS));
});

test('marker search finds Yahoo-shaped keys at any depth, in arrays, and is bounded', () => {
  const found = findYahooMarkers({ a: [{ b: { percentOwned: 1 } }], c: { yahooAdp: 2, league_key: 'x' } });
  assert.deepEqual(found.sort(), ['a[0].b.percentOwned', 'c.league_key', 'c.yahooAdp']);
  assert.equal(findYahooMarkers({ ok: 1, name: 'player' }).length, 0);
  const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`yahooField${i}`, i]));
  assert.equal(findYahooMarkers(wide, { limit: 5 }).length, 5);
  const large = { x: Array.from({ length: 1000 }, (_, i) => ({ i })) };
  assert.equal(findYahooMarkers(large).length, 0);
});

test('a source is enabled only by the exact server-side value "allow"; user_message and unknown names are not league sources', () => {
  assert.equal(sourceEnabled('yahoo_league', { PROGM_AI_YAHOO_DATA: 'allow' }), true);
  assert.equal(sourceEnabled('yahoo_league', { PROGM_AI_YAHOO_DATA: ' Allow ' }), true);
  assert.equal(sourceEnabled('espn_football_league', { PROGM_AI_ESPN_DATA: 'allow' }), true);
  assert.equal(sourceEnabled('espn_football_league', { PROGM_AI_YAHOO_DATA: 'allow' }), false, 'settings are per source');
  for (const v of [undefined, '', 'true', '1', 'on', 'yes']) {
    assert.equal(sourceEnabled('yahoo_league', { PROGM_AI_YAHOO_DATA: v }), false);
    assert.equal(sourceEnabled('espn_football_league', { PROGM_AI_ESPN_DATA: v }), false);
  }
  assert.equal(sourceEnabled('nope', { nope: 'allow' }), false);
  assert.equal(sourceEnabled('user_message', {}), false);
});

test('resolveAiContext: nothing requested is not an error; everything else is blocked unless allowlisted, enabled and server-built', async () => {
  for (const none of [undefined, null, '']) {
    const r = await resolveAiContext({ userId: 1, contextRequest: none, env: {} });
    assert.deepEqual([r.context, r.shared, r.blocked, r.notice], [null, false, false, null]);
  }
  for (const request of ['espn_football_league', 'yahoo_league', 'user_message', 'espn', 'yahoo', '__proto__', 'hasOwnProperty', 'x'.repeat(5000)]) {
    const r = await resolveAiContext({ userId: 1, contextRequest: request, env: { PROGM_AI_ESPN_DATA: 'allow', PROGM_AI_YAHOO_DATA: 'allow' } });
    assert.equal(r.context, null, `request ${request.slice(0, 20)}`);
    assert.equal(r.blocked, true);
    assert.equal(r.notice, BLOCKED_NOTICE);
  }
  const ok = await resolveAiContext({ userId: 5, contextRequest: 'espn_football_league', env: { PROGM_AI_ESPN_DATA: 'allow' }, builders: { espn_football_league: async ({ userId, question, selectors }) => ({ context: { built: 'by-server', userId, question, selectors }, sections: ['overview'], bytes: 10 }) }, question: 'q', selectors: { a: 1 } });
  assert.deepEqual(ok.context, { built: 'by-server', userId: 5, question: 'q', selectors: { a: 1 } });
  assert.deepEqual(ok.sections, ['overview']);
  assert.equal(ok.shared, true);
  const smuggle = await resolveAiContext({ userId: 5, contextRequest: 'espn_football_league', env: { PROGM_AI_ESPN_DATA: 'allow' }, builders: { espn_football_league: async () => ({ context: { a: { percentOwned: 3 } } }) } });
  assert.equal(smuggle.reason, 'yahoo_markers_in_server_context');
  const empty = await resolveAiContext({ userId: 5, contextRequest: 'espn_football_league', env: { PROGM_AI_ESPN_DATA: 'allow' }, builders: { espn_football_league: async () => null } });
  assert.equal(empty.blocked, true);
});

// ---- egress inventory: any NEW outbound call site must be reviewed against this list -------------------------------------
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(p);
    return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [p] : [];
  });
}
const stripComments = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const OUTBOUND = /\bfetch\(|\bfetchImpl\(|https?\.request\(|axios/;

test('egress allowlist: every outbound HTTP call site in server code is a known, reviewed one', () => {
  const sites = sourceFiles(SRC)
    .filter((file) => OUTBOUND.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();
  // A new entry here means new data can leave the server: review what it sends before adding it to this list.
  assert.deepEqual(sites, [
    'routes/gm.js',                            // Gemini: the ONLY outbound path that carries user text; league context is gated by aiDataPolicy
    'routes/yahoo.js',                         // Yahoo OAuth token endpoint and Fantasy API (read-only GET)
    'services/dataSources/policy.js',          // guardedFetch(): the ONLY route to ESPN, NBA.com and RapidAPI hosts, default-deny (inbound data)
    'services/providers/espnStatsProbe.js',    // takes an injectable fetchImpl (defaults to guardedFetch); asserts the ESPN switch before any request
  ]);
});

test('only gm.js talks to the AI provider, and it never reads the client league payload', () => {
  const holders = sourceFiles(SRC).filter((file) => /generativelanguage\.googleapis\.com/.test(fs.readFileSync(file, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
  assert.deepEqual(holders, ['routes/gm.js']);
  const gm = stripComments(fs.readFileSync(path.join(SRC, 'routes/gm.js'), 'utf8'));
  assert.doesNotMatch(gm, /req\.body\.league\b/, 'client-supplied league data must never be read');
  const stripped = gm.replace(/selectorsFrom\(req\.body\)/g, '').replace(/(?:validChatBody|objectBody)\(req\.body\)/g, '').replace(/req\.body\??\.(messages|contextRequest|question|version|historyToken)\b/g, '');
  assert.doesNotMatch(stripped, /req\.body/, 'only validated messages, question, version, contextRequest, encrypted general history receipts and league/team selectors are read');
  assert.match(gm, /const selectorsFrom = \(body\) => \(\{ leagueKey: typeof body\?\.leagueKey === 'string' \? body\.leagueKey : null, teamKey: typeof body\?\.teamKey === 'string' \? body\.teamKey : null \}\);/, 'selectors are exactly two strings');
  assert.match(gm, /resolveAiContext\(/);
  // the only context handed to the request builder comes from the policy decision
  assert.match(gm, /leagueContext:\s*decision\.context/);
});

test('no server code outside the policy file builds an AI context from request input', () => {
  const offenders = sourceFiles(SRC).filter((f) => /resolveAiContext|DEFAULT_BUILDERS/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/')).sort();
  assert.deepEqual(offenders, ['routes/gm.js', 'services/ai/aiDataPolicy.js']);
});
