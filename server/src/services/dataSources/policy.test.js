/**
 * External data-source policy: default-deny, host classification, the guarded fetch, the cache, and a scan that no server file can
 * reach an ESPN / NBA.com / RapidAPI host except through the guard. Mocked fetch only; no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_SOURCES, sourceAllowed, sourceForHost, sourceForUrl, guardedFetch, assertUrlAllowed, SourceDisabledError, isSourceDisabledError,
  providerAllowed, cacheEntryServable, espnAvailability,
} from './policy.js';
import * as cache from '../providers/cache.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_OFF = {};
const ALL_ON = { PROGM_DATA_ESPN: 'allow', PROGM_DATA_NBA_COM: 'allow', PROGM_DATA_TANK01: 'allow' };

// Every URL the server code can build for these hosts (read from the code, not invented).
const ESPN_URLS = [
  'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?limit=1000&season=2025',
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=30',
  'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1?view=mTeam',
  'https://a.espncdn.com/i/headshots/nba/players/full/1.png',
];
const NBA_URLS = ['https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', 'https://cdn.nba.com/static/json/liveData/boxscore/boxscore_1.json', 'https://stats.nba.com/stats/leaguedashplayerstats'];
const TANK_URLS = ['https://tank01-fantasy-stats.p.rapidapi.com/getNBAPlayerList'];
const UNRELATED = ['https://fantasysports.yahooapis.com/fantasy/v2/league/1', 'https://api.login.yahoo.com/oauth2/get_token', 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent'];

const withEnv = async (vars, fn) => {
  const names = Object.values(DATA_SOURCES).map((s) => s.env);
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } }
};
afterEach(() => cache.clearAll());

test('every source is OFF by default and only the value "allow" turns it on', () => {
  for (const source of Object.keys(DATA_SOURCES)) {
    assert.equal(sourceAllowed(source, ALL_OFF), false, `${source} default`);
    for (const v of [undefined, null, '', ' ', 'true', '1', 'on', 'yes', 'enabled', 'allowed', 'deny', 'false', true]) {
      assert.equal(sourceAllowed(source, { [DATA_SOURCES[source].env]: v }), false, `${source}=${String(v)}`);
    }
    assert.equal(sourceAllowed(source, { [DATA_SOURCES[source].env]: 'allow' }), true, `${source}=allow`);
  }
  assert.equal(sourceAllowed('unknown_source', { PROGM_DATA_UNKNOWN_SOURCE: 'allow' }), false, 'unknown sources are never allowed');
  assert.equal(sourceAllowed('espn', undefined) === sourceAllowed('espn', process.env), true, 'defaults to process.env');
});

test('hosts are classified on a label boundary: real ESPN, NBA.com and RapidAPI hosts match, lookalikes and Yahoo/Gemini do not', () => {
  for (const url of ESPN_URLS) assert.equal(sourceForUrl(url), 'espn', url);
  for (const url of NBA_URLS) assert.equal(sourceForUrl(url), 'nba_com', url);
  for (const url of TANK_URLS) assert.equal(sourceForUrl(url), 'tank01', url);
  for (const url of UNRELATED) assert.equal(sourceForUrl(url), null, `${url} is outside this policy`);
  for (const host of ['notespn.com', 'espn.com.example.test', 'myespncdn.com', 'espn.co', 'notnba.com', 'nba.com.evil.test', 'rapidapi.com.evil.test']) assert.equal(sourceForHost(host), null, host);
  assert.equal(sourceForHost('SITE.API.ESPN.COM'), 'espn', 'case-insensitive');
  assert.equal(sourceForHost('site.api.espn.com.'), 'espn', 'trailing dot');
  assert.equal(sourceForUrl('not a url'), null);
});

test('guardedFetch makes ZERO requests for any disabled source, and an explicit allow lets exactly that source through', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true }; };
  for (const url of [...ESPN_URLS, ...NBA_URLS, ...TANK_URLS]) {
    await assert.rejects(() => guardedFetch(url, {}, { env: ALL_OFF, fetchImpl }), (e) => isSourceDisabledError(e) && e instanceof SourceDisabledError && e.code === 'SOURCE_DISABLED', url);
    assert.throws(() => assertUrlAllowed(url, ALL_OFF), SourceDisabledError);
  }
  assert.equal(calls, 0, 'no request left the process');

  await guardedFetch(ESPN_URLS[0], {}, { env: { PROGM_DATA_ESPN: 'allow' }, fetchImpl });
  assert.equal(calls, 1);
  await assert.rejects(() => guardedFetch(NBA_URLS[0], {}, { env: { PROGM_DATA_ESPN: 'allow' }, fetchImpl }), SourceDisabledError, 'allowing ESPN does not allow NBA.com');
  await assert.rejects(() => guardedFetch(TANK_URLS[0], {}, { env: { PROGM_DATA_ESPN: 'allow', PROGM_DATA_NBA_COM: 'allow' }, fetchImpl }), SourceDisabledError, 'nor Tank01');
  assert.equal(calls, 1);
});

test('Yahoo and Gemini calls are not affected by the data-source policy', async () => {
  let calls = 0;
  for (const url of UNRELATED) await guardedFetch(url, {}, { env: ALL_OFF, fetchImpl: async () => { calls += 1; return {}; } });
  assert.equal(calls, UNRELATED.length);
});

test('the default fetch resolves global fetch at call time (so a stub is honored and a disabled source never reaches it)', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true }; };
  try {
    await withEnv({}, async () => { await assert.rejects(() => guardedFetch(ESPN_URLS[0]), SourceDisabledError); });
    assert.equal(calls, 0);
    await withEnv({ PROGM_DATA_ESPN: 'allow' }, async () => { await guardedFetch(ESPN_URLS[0]); });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('providers map to their source; an unrelated provider label is unaffected', () => {
  assert.equal(providerAllowed('free_nba', ALL_OFF), false);
  assert.equal(providerAllowed('espn', ALL_OFF), false);
  assert.equal(providerAllowed('nba_stats', ALL_OFF), false);
  assert.equal(providerAllowed('tank01', ALL_OFF), false);
  assert.equal(providerAllowed('yahoo', ALL_OFF), true);
  assert.equal(providerAllowed('progm', ALL_OFF), true);
  assert.equal(providerAllowed(undefined, ALL_OFF), true);
  assert.equal(providerAllowed('free_nba', ALL_ON), true);
  assert.equal(cacheEntryServable({ provider: 'progm', derivedFrom: 'espn' }, ALL_OFF), false, 'data derived from a disabled source is not servable either');
  assert.equal(cacheEntryServable({ provider: 'progm', derivedFrom: 'yahoo' }, ALL_OFF), true);
});

test('the cache never STORES a disabled source and never SERVES one that was cached while it was allowed', async () => {
  await withEnv({}, async () => {
    cache.set('k:espn', { a: 1 }, { provider: 'free_nba', ttl: 60_000 });
    assert.equal(cache.size(), 0, 'not stored while disabled');
  });
  await withEnv(ALL_ON, async () => {
    cache.set('k:espn', { a: 1 }, { provider: 'free_nba', ttl: 60_000 });
    cache.set('k:nba', { a: 2 }, { provider: 'nba_stats', ttl: 60_000 });
    cache.set('k:tank', { a: 3 }, { provider: 'tank01', ttl: 60_000 });
    cache.set('k:derived', { a: 4 }, { provider: 'progm', derivedFrom: 'espn', ttl: 60_000 });
    cache.set('k:yahoo', { a: 5 }, { provider: 'yahoo', ttl: 60_000 });
    assert.equal(cache.size(), 5);
    assert.equal(cache.isFresh('k:espn'), true);
  });
  await withEnv({}, async () => {
    let loaderCalls = 0;
    for (const key of ['k:espn', 'k:nba', 'k:tank', 'k:derived']) {
      assert.equal(cache.isFresh(key), false, `${key} isFresh`);
      assert.equal(cache.has(key), false, `${key} has`);
      assert.equal(cache.get(key), null, `${key} get`);
    }
    // remember() must neither serve it as fresh nor as the stale fallback when its loader fails.
    cache.set('k:espn2', 1, { provider: 'free_nba', ttl: 60_000 }); // refused while disabled
    await assert.rejects(() => cache.remember('k:espn', { provider: 'free_nba', ttl: 60_000 }, async () => { loaderCalls += 1; throw new SourceDisabledError('espn'); }), SourceDisabledError);
    assert.equal(loaderCalls, 1, 'the loader ran (and failed) instead of the cached value being served');
    assert.equal(cache.get('k:yahoo').value.a, 5, 'unrelated entries are untouched');
  });
  await withEnv(ALL_ON, async () => {
    cache.set('k:espn', { a: 1 }, { provider: 'free_nba', ttl: 60_000 });
    assert.equal(cache.size() >= 1, true);
  });
  await withEnv({}, async () => {
    assert.ok(cache.purgeExpired() >= 1, 'the periodic sweep also releases disabled-source entries');
    assert.equal(cache.get('k:espn'), null);
  });
});

test('the availability message the client shows is static and explains the shutoff', () => {
  assert.deepEqual(espnAvailability(ALL_ON), { available: true });
  const off = espnAvailability(ALL_OFF);
  assert.equal(off.available, false);
  assert.match(off.message, /ESPN data is not available/);
  assert.match(off.message, /Yahoo basketball league is not affected/);
});

// ---- tripwire: no way around the guard -----------------------------------------------------------------------------------------------
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
// Block comments only where they start a line (a string such as '*/*' must not open one); line comments only after whitespace (https:// is safe).
const stripComments = (code) => code.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const HOST = /espn\.com|espncdn\.com|espnstatic\.com|nba\.com|rapidapi\.com/i;
const RAW_FETCH = /(?<![\w.])fetch\(|globalThis\.fetch\(|\bfetchImpl\(/;

test('tripwire: every server file that names an ESPN, NBA.com or RapidAPI host routes through the guard and has no raw fetch()', () => {
  const offenders = [];
  const named = [];
  for (const file of walk(SRC).filter((f) => /\.(js|mjs|cjs)$/.test(f) && !/\.test\.(js|mjs)$/.test(f))) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === 'services/dataSources/policy.js' || rel === 'services/dataSources/allowAllSourcesForTest.js') continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (!HOST.test(code)) continue;
    named.push(rel);
    if (!/guardedFetch|assertUrlAllowed/.test(code) || RAW_FETCH.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these files can reach a gated host without the guard');
  // Pin the known list so a NEW file that talks to these hosts is a deliberate, reviewed change.
  assert.deepEqual(named.sort(), [
    'routes/espn.js',
    'services/providers/freeNbaProbe.js',
    'services/providers/freeNbaProvider.js',
    'services/providers/nbaStatsProvider.js',
    'services/providers/tank01Provider.js',
  ]);
});

test('tripwire: no client code calls an ESPN host directly (the browser must not hotlink or fetch ESPN data)', () => {
  const clientSrc = path.resolve(SRC, '..', '..', 'client', 'src');
  const hits = walk(clientSrc)
    .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f))
    .filter((f) => /(site(\.web)?\.api\.espn\.com|lm-api-reads\.fantasy\.espn\.com|a\.espncdn\.com)/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(clientSrc, f).split(path.sep).join('/'));
  assert.deepEqual(hits, []);
});
