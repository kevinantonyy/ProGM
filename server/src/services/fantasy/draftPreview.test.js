/**
 * Draft Preview pool: mocked Yahoo only (no network, no credentials). Covers pagination, duplicates, missing keys,
 * the draft-results fallback and every way completeness can fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDraftPreviewPool, resolveDraftPreview } from './draftPreview.js';
import { yahooDraftPlayersPath } from './normalize.js';

const LEAGUE = '466.l.1';
const key = (id) => `466.p.${id}`;

function entry(id, extra = {}) {
  const props = [{ player_key: id == null ? undefined : key(id) }, { player_id: String(id) }, { name: { full: `Player ${id}` } }, { editorial_team_abbr: 'BOS' }, { eligible_positions: [{ position: 'PG' }] }];
  if (extra.status) props.push({ status: extra.status });
  if (id == null) props.shift();
  return { player: [props] };
}
function response(ids, extras = {}) {
  const players = { count: ids.length };
  ids.forEach((id, i) => { players[String(i)] = entry(id, extras[id]); });
  return { fantasy_content: { league: [{ league_key: LEAGUE }, { players }] } };
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Mock Yahoo: pages the A / T lists by start+count and serves player_keys lookups from `byKey`. */
function mockYahoo({ A = [], T = [], byKey = [], extras = {}, failFor = null, infiniteT = false } = {}) {
  const calls = [];
  const fn = async (path) => {
    calls.push(path);
    if (failFor && failFor(path)) throw new Error('mock Yahoo failure');
    if (path.includes('player_keys=')) {
      const asked = decodeURIComponent(/player_keys=([^/]+)/.exec(path)[1]).split(',');
      return response(byKey.filter((id) => asked.includes(key(id))), extras);
    }
    const status = /status=([AT])/.exec(path)[1];
    const start = Number(/start=(\d+)/.exec(path)[1]);
    const count = Number(/count=(\d+)/.exec(path)[1]);
    if (status === 'T' && infiniteT) return response(range(start + 1, start + count));
    const list = status === 'A' ? A : T;
    return response(list.slice(start, start + count), extras);
  };
  fn.calls = calls;
  return fn;
}
const picks = (ids) => new Set(ids.map(key));

test('flag is off unless exactly on/true/1', () => {
  for (const v of [undefined, '', 'off', 'no', '0', 'enabled']) assert.equal(resolveDraftPreview({ PROGM_DRAFT_PREVIEW: v }), false, String(v));
  for (const v of ['on', 'ON', ' true ', '1']) assert.equal(resolveDraftPreview({ PROGM_DRAFT_PREVIEW: v }), true, v);
  assert.equal(resolveDraftPreview({}), false);
});

test('the T status filter is opt-in; the live-draft path is unchanged', () => {
  assert.equal(yahooDraftPlayersPath(LEAGUE, 'percent_owned'), `/league/${LEAGUE}/players;status=A;sort=OR;start=0;count=25/percent_owned`);
  assert.equal(yahooDraftPlayersPath(LEAGUE, 'ranks', 50, 25, 'T'), `/league/${LEAGUE}/players;status=T;sort=OR;start=50;count=25/ranks`);
  assert.match(yahooDraftPlayersPath(LEAGUE, 'ranks', 0, 25, 'bogus'), /status=A/, 'unknown filters can never widen the query');
});

test('complete pool: pages A and T fully, labels the source, and verifies every drafted player is present', async () => {
  const yahoo = mockYahoo({ A: range(101, 130), T: range(1, 60) }); // 2 A pages, 3 T pages
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks(range(1, 60)) });
  assert.equal(completeness.complete, true);
  assert.deepEqual(completeness.reasons, []);
  assert.equal(players.length, 90);
  assert.equal(new Set(players.map((p) => p.playerKey)).size, 90);
  assert.equal(players.filter((p) => p.poolSource === 'T').length, 60);
  assert.equal(players.filter((p) => p.poolSource === 'A').length, 30);
  assert.deepEqual(
    { available: completeness.counts.available, taken: completeness.counts.taken, fallback: completeness.counts.fromDraftResultsFallback, missing: completeness.counts.stillMissing },
    { available: 30, taken: 60, fallback: 0, missing: 0 },
  );
  const tStarts = yahoo.calls.filter((c) => c.includes('status=T') && c.endsWith('/percent_owned')).map((c) => Number(/start=(\d+)/.exec(c)[1]));
  assert.deepEqual(tStarts, [0, 25, 50, 75], 'paging stops only at an empty page (the last one is a probe)');
  assert.deepEqual(completeness.warnings, []);
  assert.ok(yahoo.calls.every((c) => !c.includes('/draftresults')), 'pool fetch itself only reads player resources');
});

test('every pool player carries the Yahoo status page fetch time and designation', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1, 2], extras: { 2: { status: 'INJ' } } });
  const { players } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2]) });
  assert.ok(players.every((p) => Number.isFinite(Date.parse(p.yahooStatusFetchedAt))));
  assert.equal(players.find((p) => p.playerKey === key(2)).status, 'INJ');
});

test('a player listed on both the A and T pages (paging while teams add/drop) appears once, as taken', async () => {
  const yahoo = mockYahoo({ A: [1, 101], T: [1, 2] });
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2]) });
  assert.equal(players.length, 3);
  assert.equal(players.find((p) => p.playerKey === key(1)).poolSource, 'T');
  assert.equal(completeness.counts.duplicatesRemoved, 1);
  assert.equal(completeness.complete, true);
});

test('duplicate keys within overlapping pages are removed and counted', async () => {
  const dupT = [...range(1, 25), 3, 4, 26]; // page 2 repeats players 3 and 4
  const { players, completeness } = await fetchDraftPreviewPool(mockYahoo({ A: [101], T: dupT }), 'tok', LEAGUE, { draftedKeys: picks(range(1, 26)) });
  assert.equal(players.filter((p) => p.poolSource === 'T').length, 26);
  assert.equal(completeness.counts.duplicatesRemoved, 2);
  assert.equal(completeness.complete, true);
});

test('drafted players missing from A and T are fetched by player_key and the pool still verifies', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1, 2], byKey: [3, 4] });
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2, 3, 4]) });
  assert.equal(completeness.complete, true);
  assert.equal(completeness.counts.fromDraftResultsFallback, 2);
  assert.deepEqual(players.filter((p) => p.poolSource === 'draftResults').map((p) => p.playerKey).sort(), [key(3), key(4)]);
  assert.ok(players.find((p) => p.playerKey === key(3)).yahooStatusFetchedAt);
  assert.equal(yahoo.calls.filter((c) => c.includes('player_keys=')).length, 1);
});

test('fallback lookups are batched at 25 player keys', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], byKey: range(2, 31) });
  const { completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks(range(1, 31)) });
  assert.equal(yahoo.calls.filter((c) => c.includes('player_keys=')).length, 2);
  assert.equal(completeness.counts.fromDraftResultsFallback, 30);
  assert.equal(completeness.complete, true);
});

test('a drafted player Yahoo cannot supply makes the pool INCOMPLETE and says so', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1, 2], byKey: [3] }); // player 4 is nowhere
  const { completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2, 3, 4]) });
  assert.equal(completeness.complete, false);
  assert.equal(completeness.counts.stillMissing, 1);
  assert.match(completeness.reasons.join(' '), /1 drafted player is missing/);
});

test('a failed fallback request is counted and the pool is INCOMPLETE (never silently complete)', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], byKey: [2], failFor: (p) => p.includes('player_keys=') });
  const { completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2]) });
  assert.equal(completeness.complete, false);
  assert.equal(completeness.counts.fallbackFailedBatches, 1);
});

test('unavailable or empty draft results cannot establish completeness', async () => {
  for (const draftedKeys of [null, new Set()]) {
    const { completeness, players } = await fetchDraftPreviewPool(mockYahoo({ A: [101], T: [1, 2] }), 'tok', LEAGUE, { draftedKeys });
    assert.equal(completeness.complete, false);
    assert.match(completeness.reasons.join(' '), /draft results/i);
    assert.equal(players.length, 3, 'players that were fetched are still returned for display');
  }
});

test('entries without a player key are skipped, counted and make the pool INCOMPLETE', async () => {
  const yahoo = mockYahoo({ A: [101, null], T: [1, null, 2] });
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2]) });
  assert.equal(players.length, 3);
  assert.ok(players.every((p) => p.playerKey));
  assert.equal(completeness.counts.skippedWithoutKey, 2);
  assert.equal(completeness.complete, false);
  assert.match(completeness.reasons.join(' '), /no player key/);
});

test('hitting the 1000-player ceiling is treated as possibly truncated, never complete', async () => {
  const yahoo = mockYahoo({ A: [101], infiniteT: true });
  const { completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2]) });
  assert.equal(completeness.complete, false);
  assert.match(completeness.reasons.join(' '), /taken-player list reached the 1000-player limit/);
});

test('no taken players at all is not a complete post-draft pool', async () => {
  const { completeness } = await fetchDraftPreviewPool(mockYahoo({ A: range(101, 110), T: [] }), 'tok', LEAGUE, { draftedKeys: picks([1]) });
  assert.equal(completeness.complete, false);
  assert.match(completeness.reasons.join(' '), /no taken players/);
});

test('a failed required player page rejects (no partial pool is returned as if it were whole)', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], failFor: (p) => p.includes('status=T') && p.endsWith('/percent_owned') });
  await assert.rejects(fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1]) }), /mock Yahoo failure/);
});

test('optional draft_analysis/ranks failures do not fail the pool; required data and keys still verify', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], failFor: (p) => p.endsWith('/draft_analysis') || p.endsWith('/ranks') });
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1]) });
  assert.equal(players.length, 2);
  assert.equal(completeness.complete, true);
});

test('only read-only GET resource paths are requested', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1, 2], byKey: [3] });
  await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1, 2, 3]) });
  for (const path of yahoo.calls) assert.match(path, new RegExp(`^/league/${LEAGUE.replaceAll('.', '\\.')}/players;`));
});

test('a short page in the MIDDLE of a list does not end the pool: later pages are still read and counted', async () => {
  const T = range(1, 70);
  const pages = new Map([[0, T.slice(0, 25)], [25, T.slice(25, 35)], [50, T.slice(35, 60)], [75, T.slice(60)]]); // page 25 is irregularly short
  const yahoo = async (path) => {
    if (path.includes('status=A') || !path.endsWith('/percent_owned')) return response(path.includes('status=A') && path.endsWith('/percent_owned') && /start=0;/.test(path) ? [101] : []);
    return response(pages.get(Number(/start=(\d+)/.exec(path)[1])) || []);
  };
  const { players, completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks(range(1, 70)) });
  assert.equal(players.filter((p) => p.poolSource === 'T').length, 70);
  assert.ok(completeness.counts.irregularPages >= 1);
  assert.equal(completeness.complete, true);
});

test('failed optional ADP/rank pages are disclosed as a warning without faking an incomplete pool', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], failFor: (p) => p.endsWith('/draft_analysis') });
  const { completeness } = await fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1]) });
  assert.equal(completeness.complete, true);
  assert.equal(completeness.warnings.length, 1);
  assert.match(completeness.warnings[0], /ADP or rank pages/);
});

test('request budget and deadline stop a runaway build before it reaches Yahoo again', async () => {
  const yahoo = mockYahoo({ A: range(101, 300), T: range(1, 200) });
  await assert.rejects(fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1]), maxRequests: 5 }), /more Yahoo requests than allowed/);
  assert.equal(yahoo.calls.length, 5, 'exactly the budget was spent');
  const late = mockYahoo({ A: [101], T: [1] });
  await assert.rejects(fetchDraftPreviewPool(late, 'tok', LEAGUE, { draftedKeys: picks([1]), deadlineMs: -1 }), /took too long/);
  assert.equal(late.calls.length, 0);
});

test('a Yahoo HTTP 999 (shared circuit) from a required page aborts the preview instead of returning a partial pool', async () => {
  const yahoo = mockYahoo({ A: [101], T: [1], failFor: (p) => p.includes('status=T') && p.endsWith('/percent_owned') });
  const failing = async (path, token) => { try { return await yahoo(path, token); } catch (error) { error.httpStatus = 999; throw error; } };
  await assert.rejects(fetchDraftPreviewPool(failing, 'tok', LEAGUE, { draftedKeys: picks([1]) }), (error) => error.httpStatus === 999);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a Yahoo request that never answers is abandoned after the per-request timeout, and nothing further is requested', async () => {
  let calls = 0;
  const hang = () => { calls += 1; return new Promise(() => {}); };
  const started = Date.now();
  await assert.rejects(fetchDraftPreviewPool(hang, 'tok', LEAGUE, { draftedKeys: picks([1]), requestTimeoutMs: 30 }), /did not respond in time/);
  assert.ok(Date.now() - started < 1000, 'returned promptly instead of waiting on the hung request');
  assert.equal(calls, 1, 'no second request is attempted after a timeout');
});

test('the overall deadline also interrupts an in-flight request (not only the start of the next one)', async () => {
  const hang = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(fetchDraftPreviewPool(hang, 'tok', LEAGUE, { draftedKeys: picks([1]), deadlineMs: 40, requestTimeoutMs: 5000 }), /took too long/);
  assert.ok(Date.now() - started < 1000);
});

test('a slow but timely response still succeeds', async () => {
  const base = mockYahoo({ A: [101], T: [1] });
  const slow = async (path, token) => { await sleep(5); return base(path, token); };
  const { completeness } = await fetchDraftPreviewPool(slow, 'tok', LEAGUE, { draftedKeys: picks([1]), requestTimeoutMs: 500 });
  assert.equal(completeness.complete, true);
});

test('a timeout on an OPTIONAL page aborts the build instead of silently returning a partial pool', async () => {
  const base = mockYahoo({ A: [101], T: [1] });
  let afterHang = 0; let hung = false;
  const yahoo = (path, token) => {
    if (hung) afterHang += 1;
    if (path.endsWith('/draft_analysis')) { hung = true; return new Promise(() => {}); }
    return base(path, token);
  };
  await assert.rejects(fetchDraftPreviewPool(yahoo, 'tok', LEAGUE, { draftedKeys: picks([1]), requestTimeoutMs: 30 }), /did not respond in time/);
  assert.equal(afterHang, 0, 'after the hung request, every later call is refused locally and never reaches Yahoo');
});

test('an abandoned request that fails later does not raise an unhandled rejection', async () => {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const lateFail = () => new Promise((_, reject) => setTimeout(() => reject(new Error('socket reset after we gave up')), 60));
    await assert.rejects(fetchDraftPreviewPool(lateFail, 'tok', LEAGUE, { draftedKeys: picks([1]), requestTimeoutMs: 10 }), /did not respond in time/);
    await sleep(150);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});
