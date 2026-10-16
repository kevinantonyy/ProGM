import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooDraftPool, fetchYahooPlayerDataset } from './yahooPlayerPool.js';

function playerEntry(id) {
  return { player: [[{ player_key: `466.p.${id}` }, { player_id: String(id) }, { name: { full: `Player ${id}` } }, { editorial_team_abbr: 'BOS' }, { eligible_positions: [{ position: 'PG' }] }]] };
}

function response(ids) {
  const players = { count: ids.length };
  ids.forEach((id, i) => { players[String(i)] = playerEntry(id); });
  return { fantasy_content: { league: [{ league_key: '466.l.1' }, { players }] } };
}

test('fetches every Yahoo 25-player page and preserves the complete pool', async () => {
  const starts = [];
  const yahooFantasy = async (path) => {
    const start = Number(/start=(\d+)/.exec(path)?.[1] || 0);
    starts.push(start);
    const ids = Array.from({ length: Math.min(25, Math.max(0, 63 - start)) }, (_, i) => start + i + 1);
    return response(ids);
  };
  const players = await fetchYahooPlayerDataset(yahooFantasy, 'token', '466.l.1', 'ranks');
  assert.equal(players.length, 63);
  assert.deepEqual(starts, [0, 25, 50]);
  assert.equal(new Set(players.map((p) => p.playerKey)).size, 63);
});

test('deduplicates stable player keys across malformed overlapping pages', async () => {
  const pages = [[1, 2, ...Array.from({ length: 23 }, (_, i) => i + 3)], [25, 26]];
  let call = 0;
  const players = await fetchYahooPlayerDataset(async () => response(pages[call++] || []), 'token', '466.l.1', 'ranks');
  assert.equal(players.length, 26);
  assert.equal(new Set(players.map((p) => p.playerKey)).size, 26);
});

test('optional metadata preserves completed pages when a later page fails', async () => {
  let call = 0;
  const players = await fetchYahooPlayerDataset(async () => {
    call += 1;
    if (call === 2) throw new Error('temporary Yahoo failure');
    return response(Array.from({ length: 25 }, (_, i) => i + 1));
  }, 'token', '466.l.1', 'ranks', { bestEffort: true });
  assert.equal(players.length, 25);
});

test('status timestamps come from the ownership page, not later rank or ADP requests', async () => {
  const before = Date.now();
  let ownershipReceivedAt;
  const pool = await fetchYahooDraftPool(async (path) => {
    if (!path.endsWith('/percent_owned')) ownershipReceivedAt ??= Date.now();
    return response([1]);
  }, 'synthetic', '466.l.1');
  const observed = Date.parse(pool[0].yahooStatusFetchedAt);
  assert.ok(observed >= before && observed <= ownershipReceivedAt);
});
