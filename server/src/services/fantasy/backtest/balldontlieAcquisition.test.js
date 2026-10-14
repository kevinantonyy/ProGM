import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALLDONTLIE_TERMS_URL,
  acquireBalldontlieStats,
  validateAcquisitionAuthorization,
} from './balldontlieAcquisition.js';
import { importHistoricalExport } from './datasetAdapter.js';

// All responses are mocked; no test performs network access.
const AUTHORIZATION = {
  name: 'balldontlie-mock-fixture',
  permission: 'Mocked response fixture for adapter tests; no real data.',
  acquisitionAuthorized: true,
  subscriptionTier: 'ALL-STAR (mock)',
  termsReviewedAt: '2026-10-14',
};
const KEY = 'test-key-never-logged';

function game(id, playerId, { min = '30:00', pts = 20, postseason = false, season = 2023 } = {}) {
  return {
    id: id * 100 + playerId, min, pts, reb: 8, oreb: 2, dreb: 6, ast: 5, stl: 1, blk: 1, turnover: 2, pf: 2,
    fgm: 8, fga: 16, ftm: 2, fta: 3, fg3m: 2,
    player: { id: playerId, first_name: 'Mock', last_name: `Player${playerId}`, position: 'G' },
    team: { abbreviation: 'MCK' },
    game: { id, season, postseason, date: `2023-11-${String(id).padStart(2, '0')}` },
  };
}

function mockFetch(pages, { statusSequence = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const status = statusSequence.shift() ?? 200;
    if (status !== 200) return { status, ok: false, headers: { get: () => null }, json: async () => ({}) };
    const cursor = new URL(url).searchParams.get('cursor');
    const index = cursor == null ? 0 : Number(cursor);
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => pages[index] };
  };
  return { fetchImpl, calls };
}

const TWO_PAGES = [
  { data: [game(1, 7), game(1, 8, { min: '00', pts: 0 }), game(2, 7, { pts: 30 })], meta: { next_cursor: 1 } },
  { data: [game(3, 7, { pts: 10 }), game(4, 7, { postseason: true, pts: 50 })], meta: { next_cursor: null } },
];

function run(overrides = {}, pages = TWO_PAGES, fetchOptions = {}) {
  const { fetchImpl, calls } = mockFetch(structuredClone(pages), fetchOptions);
  const sleeps = [];
  const promise = acquireBalldontlieStats({
    apiKey: KEY,
    authorization: AUTHORIZATION,
    seasons: [2023],
    maxPages: 5,
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => new Date('2026-10-14T12:00:00Z'),
    ...overrides,
  });
  return { promise, calls, sleeps };
}

test('acquisition refuses without explicit authorization or an API key, before any request', async () => {
  for (const [overrides, pattern] of [
    [{ authorization: { ...AUTHORIZATION, acquisitionAuthorized: undefined } }, /acquisitionAuthorized/],
    [{ authorization: { ...AUTHORIZATION, termsReviewedAt: 'not a date' } }, /termsReviewedAt/],
    [{ authorization: { ...AUTHORIZATION, subscriptionTier: '' } }, /subscription tier/],
    [{ apiKey: '' }, /API key/],
    [{ seasons: [] }, /season/],
    [{ maxPages: 0 }, /maxPages/],
    [{ maxPages: 10000 }, /maxPages/],
  ]) {
    const { promise, calls } = run(overrides);
    await assert.rejects(promise, pattern);
    assert.equal(calls.length, 0);
  }
  assert.throws(() => validateAcquisitionAuthorization(null), /acquisitionAuthorized/);
});

test('acquisition paginates by cursor, rate-limits, and records provenance without the key', async () => {
  const { promise, calls, sleeps } = run();
  const result = await promise;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, KEY);
  assert.deepEqual(calls[0].url.searchParams.getAll('seasons[]'), ['2023']);
  assert.equal(calls[0].url.searchParams.get('per_page'), '100');
  assert.equal(calls[0].url.searchParams.get('cursor'), null);
  assert.equal(calls[1].url.searchParams.get('cursor'), '1');
  assert.deepEqual(sleeps, [12000]); // 5 requests/minute
  assert.equal(result.acquisition.complete, true);
  assert.equal(result.acquisition.rows, 5);
  assert.equal(result.provenance.provider, 'BALLDONTLIE');
  assert.equal(result.provenance.licenseUrl, BALLDONTLIE_TERMS_URL);
  assert.equal(result.provenance.acquiredAt, '2026-10-14T12:00:00.000Z');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('acquired pages aggregate into Phase 8 player seasons, excluding DNP and postseason rows', async () => {
  const exported = await run().promise;
  const imported = importHistoricalExport({ input: exported, format: 'balldontlie-stats' });
  assert.equal(imported.snapshots.length, 1); // player 8 only had a DNP row
  const [season] = imported.snapshots;
  assert.equal(season.player.id, 'balldontlie:7');
  assert.equal(season.season, 2023);
  assert.equal(season.gamesPlayed, 3);
  assert.equal(season.stats.points, 20);
  assert.equal(season.age, null); // not provided by this endpoint
  assert.equal(season.provenance.provider, 'BALLDONTLIE');
  assert.equal(season.provenance.restrictedSource, null);
});

test('page cap yields an incomplete export that cannot be imported for evaluation', async () => {
  const exported = await run({ maxPages: 1 }).promise;
  assert.equal(exported.acquisition.complete, false);
  assert.equal(exported.acquisition.nextCursor, 1);
  assert.match(exported.provenance.datasetVersion, /incomplete/);
  assert.throws(() => importHistoricalExport({ input: exported, format: 'balldontlie-stats' }), /incomplete/);
});

test('429 responses back off and retry; auth failures stop without leaking the key', async () => {
  const retried = run({}, TWO_PAGES, { statusSequence: [429, 200, 200] });
  const result = await retried.promise;
  assert.equal(retried.calls.length, 3);
  assert.ok(retried.sleeps.includes(2000));
  assert.equal(result.acquisition.complete, true);

  const denied = run({}, TWO_PAGES, { statusSequence: [403] });
  await assert.rejects(denied.promise, (error) => /HTTP 403/.test(error.message) && !error.message.includes(KEY));
  assert.equal(denied.calls.length, 1);

  const exhausted = run({}, TWO_PAGES, { statusSequence: [429, 429, 429, 429] });
  await assert.rejects(exhausted.promise, /HTTP 429/);
  assert.equal(exhausted.calls.length, 4);
});

test('a non-advancing cursor stops instead of looping', async () => {
  const looping = [{ data: [game(1, 7)], meta: { next_cursor: 0 } }];
  const { fetchImpl } = mockFetch(looping);
  let calls = 0;
  const counting = async (url, options) => { calls += 1; return fetchImpl(url, options); };
  await assert.rejects(acquireBalldontlieStats({
    apiKey: KEY, authorization: AUTHORIZATION, seasons: [2023], maxPages: 5, fetchImpl: counting, sleep: async () => {},
  }), /did not advance/);
  assert.equal(calls, 2);
});
