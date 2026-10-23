/**
 * ESPN season-stats diagnostic probe: one request, aggregate-only output, strict timeout and size cap, no side effects.
 * Mocked fetch only; nothing here touches the network, Yahoo, Tank01 or any credential.
 */
import { test, beforeEach, afterEach } from 'node:test';
import '../dataSources/allowAllSourcesForTest.js'; // these tests run provider logic against mocked HTTP, so the sources are opted in
import assert from 'node:assert/strict';
import { probeEspnSeasonStats, currentLeagueSeason, PROBE_MAX_BYTES, PROBE_TIMEOUT_MS } from './espnStatsProbe.js';
import * as free from './freeNbaProvider.js';
import * as providers from './index.js';
import { cache, health } from './index.js';

const originalFetch = global.fetch;
const SAVED = {};
const ENV = ['RAPIDAPI_KEY', 'PROGM_TANK01_ENABLED', 'PROGM_TANK01_PLAYER_BUDGET', 'PROGM_TANK01_PLAYER_DAILY_BUDGET'];
let calls;

const payload = (n, { stats = true } = {}) => ({
  categories: [{ name: 'general', names: ['gamesPlayed', 'avgMinutes'] }, { name: 'offensive', names: ['avgPoints'] }],
  athletes: Array.from({ length: n }, (_, i) => ({
    athlete: { id: String(100 + i), displayName: `Secret Player ${i}`, teamShortName: 'BOS' },
    categories: stats ? [{ name: 'general', values: [70, 30] }, { name: 'offensive', values: [20] }] : [],
  })),
});
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

/** fetch double that records every call and answers with `answer(url, opts)`. */
function fetcher(answer) {
  const fn = async (url, opts) => { calls.push({ url: String(url), opts }); return answer(String(url), opts); };
  return fn;
}
const aborts = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

beforeEach(() => { calls = []; for (const k of ENV) SAVED[k] = process.env[k]; cache.clearAll(); health.reset('free_nba'); health.reset('tank01'); });
afterEach(() => { global.fetch = originalFetch; for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

test('healthy feed: exactly one request, correct aggregates, ok verdict', async () => {
  const body = JSON.stringify(payload(5));
  const result = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(body)) });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, 'application/json;charset=utf-8');
  assert.equal(result.bytes, Buffer.byteLength(body));
  assert.equal(result.jsonValid, true);
  assert.equal(result.athleteCount, 5);
  assert.equal(result.usableStatCount, 5);
  assert.equal(result.errorCategory, null);
  assert.equal(result.verdict, 'ok');
  assert.equal(typeof result.elapsedMs, 'number');
  assert.deepEqual(Object.keys(result.memoryMB).sort(), ['heapUsedAfter', 'heapUsedBefore', 'rssAfter', 'rssBefore']);
});

test('same endpoint and parameters as the projection provider (URL and headers identical)', async () => {
  // What the provider itself requests for league season 2026 (projection season 2025)...
  const seen = [];
  global.fetch = async (url, opts) => { seen.push({ url: String(url), headers: opts.headers }); return json(payload(3)); };
  await free.getSeasonStatsBulk(2025);
  // ...must be byte-identical to the probe's request.
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(payload(3))) });
  assert.equal(calls[0].url, seen[0].url);
  assert.deepEqual(calls[0].opts.headers, seen[0].headers);
  assert.match(calls[0].url, /statistics\/byathlete\?.*limit=1000.*season=2026.*seasontype=2/);
});

test('default league season follows the app: season starts in August (UTC)', () => {
  assert.equal(currentLeagueSeason(new Date('2026-10-19T12:00:00Z')), 2026);
  assert.equal(currentLeagueSeason(new Date('2027-03-01T12:00:00Z')), 2026);
  assert.equal(currentLeagueSeason(new Date('2026-07-31T12:00:00Z')), 2025);
  assert.equal(currentLeagueSeason(new Date('2026-08-01T00:00:00Z')), 2026);
});

test('malformed or unusable bodies are detected, each with exactly one request', async () => {
  const cases = {
    'bot-wall HTML': ['<html>Access check</html>', 'not_json', false],
    'JSON null': ['null', 'unrecognized_shape', true],
    'empty object {}': ['{}', 'unrecognized_shape', true],
    'athletes not an array': ['{"athletes":"nope"}', 'unrecognized_shape', true],
    'zero athletes': [JSON.stringify({ athletes: [] }), 'no_athletes', true],
    'athletes without any stat line': [JSON.stringify(payload(4, { stats: false })), 'no_usable_stats', true],
  };
  for (const [label, [body, category, jsonValid]] of Object.entries(cases)) {
    calls = [];
    const result = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(body)) });
    assert.equal(calls.length, 1, label);
    assert.equal(result.errorCategory, category, label);
    assert.equal(result.jsonValid, jsonValid, label);
    assert.equal(result.verdict, 'unusable', label);
    assert.equal(result.status, 200, label);
  }
});

test('HTTP failures are categorised and the body is never read', async () => {
  for (const [status, category] of [[403, 'forbidden'], [429, 'rate_limited'], [500, 'server_error'], [503, 'server_error'], [404, 'http_error']]) {
    calls = [];
    const result = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => new Response('secret body', { status })) });
    assert.equal(calls.length, 1);
    assert.deepEqual([result.status, result.errorCategory, result.bytes, result.jsonValid], [status, category, 0, false]);
  }
});

test('timeout: a request that never answers is abandoned at the strict timeout', async () => {
  const started = Date.now();
  const hung = await probeEspnSeasonStats({ leagueSeason: 2026, timeoutMs: 40, fetchImpl: fetcher((_, opts) => aborts(opts.signal)) });
  assert.equal(hung.errorCategory, 'timeout');
  assert.ok(Date.now() - started < 1500, 'returned promptly');
  // Even a fetch that ignores the abort signal cannot hang the probe.
  const ignoring = await probeEspnSeasonStats({ leagueSeason: 2026, timeoutMs: 40, fetchImpl: fetcher(() => new Promise(() => {})) });
  assert.equal(ignoring.errorCategory, 'timeout');
  assert.equal(calls.length, 2, 'one request each, no retries');
});

test('timeout: headers arrive but the body stalls mid-stream', async () => {
  let cancelled = false;
  const stalled = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1000)); }, cancel() { cancelled = true; } });
  const result = await probeEspnSeasonStats({ leagueSeason: 2026, timeoutMs: 40, fetchImpl: fetcher(() => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.equal(result.errorCategory, 'timeout');
  assert.equal(result.status, 200);
  assert.equal(result.bytes, 1000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, true, 'the stalled stream was cancelled');
});

test('response-size cap: reading stops at the cap, the stream is cancelled and nothing is parsed', async () => {
  let cancelled = false; let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const result = await probeEspnSeasonStats({ leagueSeason: 2026, maxBytes: 3 * 1024 * 1024, fetchImpl: fetcher(() => new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.equal(result.errorCategory, 'response_too_large');
  assert.ok(result.bytes > 3 * 1024 * 1024 && result.bytes <= 4 * 1024 * 1024 + 1, `bytes=${result.bytes}`);
  assert.equal(result.jsonValid, false);
  assert.equal(result.athleteCount, null);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, true);
  assert.ok(pulled < 20, 'did not keep pulling the endless stream');
});

test('limits are strict by default (12 s timeout, 12 MB cap; the real response is ~7.7 MB)', () => {
  assert.equal(PROBE_TIMEOUT_MS, 12000);
  assert.equal(PROBE_MAX_BYTES, 12 * 1024 * 1024);
});

test('network failure: only a category leaves the probe, never the error text', async () => {
  const result = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => { throw new Error('connect ECONNREFUSED 10.0.0.9 token=SECRET123'); }) });
  assert.equal(result.errorCategory, 'network_error');
  assert.ok(!JSON.stringify(result).includes('SECRET123'));
  assert.ok(!JSON.stringify(result).includes('10.0.0.9'));
});

test('privacy: output is a fixed aggregate shape with no player data, URL, headers or body text', async () => {
  const result = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(payload(8))) });
  assert.deepEqual(Object.keys(result).sort(), ['athleteCount', 'bytes', 'checkedAt', 'contentType', 'elapsedMs', 'errorCategory', 'espnSeasonEndYear', 'jsonValid', 'leagueSeason', 'memoryMB', 'projectionSeason', 'status', 'usableStatCount', 'verdict']);
  const text = JSON.stringify(result);
  for (const banned of ['Secret Player', 'espn.com', 'http', 'Mozilla', 'User-Agent', 'Bearer', 'displayName', 'BOS']) assert.ok(!text.includes(banned), banned);
  const unsafeType = await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(payload(1), { headers: { 'content-type': 'text/html<script>alert(1)</script>' } })) });
  assert.ok(!/[<>()]/.test(unsafeType.contentType), 'content type is sanitised');
});

test('no side effects: provider caches, circuit breaker, counters and status are untouched (success and failure)', async () => {
  const snapshot = () => JSON.stringify({ status: providers.providerStatus(), health: health.status('free_nba'), freeCount: free.getRequestCount?.(), keys: ['playerIndex:2025', 'seasonStatsAll:2025:free_nba', 'gamesPlayed:2025:free_nba'].map((k) => cache.has(k)) });
  const before = snapshot();
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(payload(5))) });
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json('<html>blocked</html>')) });
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => new Response('x', { status: 429 })) });
  await probeEspnSeasonStats({ leagueSeason: 2026, timeoutMs: 20, fetchImpl: fetcher(() => new Promise(() => {})) });
  assert.equal(snapshot(), before);
  assert.equal(health.status('free_nba').failures, 0);
});

test('only the ESPN season-stats host is contacted, even with a Tank01 key configured and enabled', async () => {
  process.env.RAPIDAPI_KEY = 'test-key'; process.env.PROGM_TANK01_ENABLED = 'true'; process.env.PROGM_TANK01_PLAYER_BUDGET = '1000'; process.env.PROGM_TANK01_PLAYER_DAILY_BUDGET = '1000';
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json(payload(3))) });
  await probeEspnSeasonStats({ leagueSeason: 2026, fetchImpl: fetcher(() => json('<html></html>')) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => new URL(c.url).host === 'site.web.api.espn.com'));
  assert.ok(calls.every((c) => !JSON.stringify(c.opts.headers).toLowerCase().includes('rapidapi')));
});
