import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseSections, buildYahooLeagueContext, createYahooLeagueBuilder, MAX_CONTEXT_BYTES, MAX_SECTIONS } from './yahooLeagueContext.js';
import { makeYahooWorkspace, SENTINELS } from './yahooLeagueFixture.js';

const build = (question, overrides, forbiddenValues) => buildYahooLeagueContext({ workspace: makeYahooWorkspace(overrides), question, forbiddenValues });
const allKeys = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => allKeys(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); } return out; };

test('context preserves real freshness, labels unknown times and exposes partial projection caveats without inventing confidence', () => {
  const ws = makeYahooWorkspace();
  ws.myTeam.roster[0].projectedPoints = null;
  ws.externalData.freshness = { fetchedAt: '2026-01-02T03:04:05.000Z', stale: true };
  ws.lineup.currentMissingDataCount = 1;
  const r = buildYahooLeagueContext({ workspace: ws, question: 'lineup and roster', cacheInfo: { fetchedAt: '2026-01-02T04:00:00.000Z', stale: false } });
  assert.equal(r.ok, true);
  const q = r.context.overview.dataQuality;
  assert.equal(q.workspaceCachedAt, '2026-01-02T04:00:00.000Z');
  assert.equal(q.providerFetchedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(q.stale, true);
  assert.equal(q.rosterPlayersWithoutProjection, 1);
  assert.equal(q.lineupStartersWithoutProjection, 1);
  assert.match(q.notes.join(' '), /stale|partial/);
  assert.match(q.notes.join(' '), /overstated/);
  assert.equal(r.context.roster.players[0].proj, null);
  assert.equal(r.context.roster.players[0].confidence, undefined);
  assert.match(q.notes.join(' '), /estimates, not observed/);
  assert.ok(r.bytes <= MAX_CONTEXT_BYTES); assert.equal(r.sections.length, 3);
  const unknown = buildYahooLeagueContext({ workspace: makeYahooWorkspace(), question: 'roster', cacheInfo: { fetchedAt: 'bad time' } }).context.overview.dataQuality;
  assert.equal(unknown.workspaceCachedAt, null); assert.equal(unknown.providerFetchedAt, null); assert.equal(unknown.stale, null);
  assert.match(unknown.notes.join(' '), /freshness is unknown/);
});

test('only actual estimate flags and confidence values are included; absent flags are not turned into facts', () => {
  const ws = makeYahooWorkspace();
  ws.myTeam.roster[0].estimate = true; ws.myTeam.roster[0].projectionConfidence = 0.3;
  ws.draftBoard.board[0].estimate = true;
  const r = buildYahooLeagueContext({ workspace: ws, question: 'roster and draft' });
  assert.equal(r.context.roster.players[0].estimate, true); assert.equal(r.context.roster.players[0].confidence, 0.3);
  assert.equal(r.context.roster.players[1].estimate, undefined); assert.equal(r.context.roster.players[1].confidence, undefined);
  assert.equal(r.context.draft.board[0].estimate, true);
});

test('sections are chosen by the server from the question: overview always, at most three in total', () => {
  assert.deepEqual(chooseSections('Who should I start tonight?'), ['overview', 'lineup']);
  assert.deepEqual(chooseSections('Who should I pick up?'), ['overview', 'waivers'], '"pick up" is a waiver question, not a draft one');
  assert.deepEqual(chooseSections('Any good trade ideas?'), ['overview', 'trades']);
  assert.deepEqual(chooseSections('Where am I in the standings?'), ['overview', 'standings']);
  assert.deepEqual(chooseSections('Who is my weakest position?'), ['overview', 'roster']);
  assert.deepEqual(chooseSections('Tell me a joke about basketball'), ['overview'], 'a question that needs no league data gets only the overview');
  const many = chooseSections('start sit waivers trades standings draft roster all at once');
  assert.equal(many.length, MAX_SECTIONS);
  assert.equal(many[0], 'overview');
  assert.deepEqual(chooseSections(undefined), ['overview']);
});

test('minimization: only the chosen sections are present, with only allowlisted fields', () => {
  const r = build('Who should I start tonight?');
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.context), ['overview', 'lineup']);
  assert.deepEqual(r.sections, ['overview', 'lineup']);
  assert.ok(r.bytes <= MAX_CONTEXT_BYTES);
  assert.deepEqual(Object.keys(r.context.lineup), ['projectedNow', 'projectedBest', 'gain', 'swaps', 'startSit']);
  assert.deepEqual(Object.keys(r.context.lineup.swaps[0]), ['start', 'bench', 'gain', 'why']);
  assert.equal(r.context.overview.scoring, 'H2H Points');
  assert.deepEqual(r.context.overview.stats, ['PTS 1', 'REB 1.2'], 'disabled stat categories are not sent');
  assert.equal(r.context.roster, undefined, 'the roster section is not sent for a lineup question');
  const roster = build('Who is my weakest position?').context.roster.players;
  assert.deepEqual(Object.keys(roster[0]), ['name', 'pos', 'team', 'proj', 'starting']);
  assert.deepEqual(roster.find((p) => p.name === 'Charlie Big').status, 'INJ');
});

test('never included: tokens, e-mail, username, GUID, Yahoo keys, league/team/manager names, images, ownership, ADP, Yahoo rank', () => {
  for (const question of ['start sit', 'waiver pickup', 'trade ideas', 'standings', 'draft board', 'roster weakness', 'what should I do']) {
    const r = build(question);
    assert.equal(r.ok, true, question);
    const body = JSON.stringify(r.context);
    for (const [name, value] of Object.entries(SENTINELS)) assert.ok(!body.includes(value), `${name} leaked for "${question}"`);
    for (const word of ['playerKey', 'percentOwned', 'yahooAdp', 'yahooOverallRank', 'image', 'guid', 'accessToken', 'refreshToken', 'userEmail', 'manager', 'ownerTeam', 'priorityNote']) assert.ok(!body.includes(word), `${word} present for "${question}"`);
  }
});

test('other teams are pseudonyms, your team is "Your team", and names inside ProGM reasons are scrubbed', () => {
  const trades = build('trade ideas').context.trades.ideas[0];
  assert.equal(trades.with, 'Team A');
  assert.equal(trades.why.includes('ZZ'), false);
  assert.match(trades.why, /someone/);
  const standings = build('standings').context.standings.table;
  assert.deepEqual(standings.map((t) => t.team), ['Team A', 'Your team', 'Team B']);
  assert.deepEqual(Object.keys(standings[0]), ['team', 'rank', 'w', 'l', 't']);
  const lineup = build('start sit').context.lineup;
  assert.match(lineup.startSit[0].why, /faces Team A/);
});

test('waivers and draft carry no ownership percentage, ADP or Yahoo rank', () => {
  const w = build('waiver pickup').context.waivers;
  assert.deepEqual(Object.keys(w), ['best', 'fit', 'addDrop']);
  assert.deepEqual(Object.keys(w.best[0]), ['name', 'pos', 'team', 'proj', 'starting']);
  assert.equal(w.fit[0].fit, 33.1);
  const d = build('draft board').context.draft.board[0];
  assert.deepEqual(Object.keys(d), ['name', 'progmRank', 'tier', 'fit', 'availability', 'estimate']);
});

test('the leak guard withholds the whole context instead of sending a suspicious value', () => {
  const withName = (name) => makeYahooWorkspace({ myTeam: { id: SENTINELS.teamKey, name: SENTINELS.myTeam, roster: [{ name, eligiblePositions: ['PG'], teamAbbr: 'AAA', projectedPoints: 1 }] } });
  for (const bad of ['mallory@example.com', 'https://evil.example/x', 'Bearer abcdef', 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.sig', 'a'.repeat(40), '466.p.1234']) {
    const r = buildYahooLeagueContext({ workspace: withName(bad), question: 'roster weakness' });
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /^leak_guard:value:/);
  }
  const named = buildYahooLeagueContext({ workspace: withName('zzuser_name'), question: 'roster weakness', forbiddenValues: ['zzuser_name', 'zz.user@example.com'] });
  assert.equal(named.reason, 'leak_guard:exact_value', "the user's own username may not appear in the context");
});

test('the size cap holds even when every list is full of maximum-length values', () => {
  const big = (i) => ({ name: `P${i} ${'abcd '.repeat(11)}`, eligiblePositions: ['PG', 'SG', 'SF', 'PF', 'C'], teamAbbr: 'AAAAA', projectedPoints: 20.5, injuryStatus: 'Day-To-Day-Long-Status', isStarting: true });
  const roster = Array.from({ length: 40 }, (_, i) => big(i));
  const pool = Array.from({ length: 20 }, (_, i) => big(100 + i));
  const waivers = { projectionsAvailable: true, bestAvailable: pool, bestFit: pool.map((p) => ({ ...p, fitScore: 30.123 })), addDrop: [] };
  const r = buildYahooLeagueContext({ workspace: makeYahooWorkspace({ myTeam: { id: SENTINELS.teamKey, name: 'x', roster }, waivers }), question: 'roster and waiver pickup help' });
  assert.equal(r.ok, true);
  assert.ok(r.bytes <= MAX_CONTEXT_BYTES, `${r.bytes} bytes`);
  assert.equal(r.bytes, Buffer.byteLength(JSON.stringify(r.context), 'utf8'), 'the reported size is the real size');
  assert.equal(r.sections.length, 3);
});

test('a workspace that is not a Yahoo workspace is refused', () => {
  assert.equal(buildYahooLeagueContext({ workspace: null, question: 'x' }).reason, 'no_workspace');
  assert.equal(buildYahooLeagueContext({ workspace: { provider: 'espn' }, question: 'x' }).reason, 'no_workspace');
});

// ---- the production builder ---------------------------------------------------------------------------------------------
function harness({ consented = true, connected = true, workspaces = { '1': makeYahooWorkspace() } } = {}) {
  const calls = { consent: 0, connection: 0, read: 0, identity: 0 };
  const builder = createYahooLeagueBuilder({
    consent: { hasActiveConsent: async () => { calls.consent += 1; return consented; } },
    hasYahooConnection: async () => { calls.connection += 1; return connected; },
    readWorkspace: ({ userId, leagueKey, teamKey }) => { calls.read += 1; const v = workspaces[String(userId)]; return v && v.connection.leagueKey === leagueKey ? { value: v } : null; },
    loadIdentity: async () => { calls.identity += 1; return { username: 'zzuser_name', email: 'zz.user@example.com' }; },
  });
  return { builder, calls };
}
const SEL = { leagueKey: SENTINELS.leagueKey, teamKey: SENTINELS.teamKey };

test('builder: no consent means nothing is read (no connection lookup, no cache read)', async () => {
  const { builder, calls } = harness({ consented: false });
  const r = await builder({ userId: 1, question: 'start sit', selectors: SEL });
  assert.equal(r.unavailable, 'no_consent');
  assert.deepEqual([calls.connection, calls.read, calls.identity], [0, 0, 0]);
});

test('builder: no Yahoo connection, malformed or foreign selectors, cold cache and mismatched workspace all refuse', async () => {
  assert.equal((await harness({ connected: false }).builder({ userId: 1, question: 'x', selectors: SEL })).unavailable, 'no_yahoo_connection');
  for (const selectors of [{}, { leagueKey: 'x', teamKey: 'y' }, { leagueKey: SENTINELS.leagueKey, teamKey: '466.l.99999.t.3' }, { leagueKey: ['a'], teamKey: {} }, { leagueKey: '__proto__', teamKey: '__proto__' }, { leagueKey: `${SENTINELS.leagueKey}; DROP TABLE users`, teamKey: SENTINELS.teamKey }]) {
    const { builder, calls } = harness();
    assert.equal((await builder({ userId: 1, question: 'x', selectors })).unavailable, 'bad_selection', JSON.stringify(selectors));
    assert.equal(calls.read, 0, 'a malformed selector never reaches the cache');
  }
  assert.equal((await harness({ workspaces: {} }).builder({ userId: 1, question: 'x', selectors: SEL })).unavailable, 'cold_cache');
  const other = makeYahooWorkspace(); other.connection.teamKey = '466.l.12345.t.9';
  assert.equal((await harness({ workspaces: { 1: other } }).builder({ userId: 1, question: 'x', selectors: SEL })).unavailable, 'bad_selection');
});

test("builder: a user can only reach the cache entry stored for their own id (user 2 cannot read user 1's league)", async () => {
  const { builder } = harness({ workspaces: { 1: makeYahooWorkspace() } });
  assert.equal((await builder({ userId: 2, question: 'roster', selectors: SEL })).unavailable, 'cold_cache');
  assert.equal((await builder({ userId: null, question: 'roster', selectors: SEL })).unavailable, 'no_user');
  assert.equal((await builder({ userId: 1, question: 'roster', selectors: SEL })).sections[0], 'overview');
});

test('the context module makes no network call and does not import the database or the Yahoo module', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./yahooLeagueContext.js', import.meta.url)), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /\bfetch\b|\baxios\b|^import\b/m);
});
