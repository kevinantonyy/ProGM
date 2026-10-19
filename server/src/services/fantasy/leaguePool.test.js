/**
 * leaguePool assembler: dedupe by player_key, ownership annotation, and an honest completeness verdict. Pure; no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLeaguePool, resolveRankingsFullPool, POOL_SCOPE } from './leaguePool.js';

const P = (id, extra = {}) => ({ playerKey: `466.p.${id}`, name: `Player ${id}`, teamAbbr: 'BOS', eligiblePositions: ['PG'], status: null, ...extra });
const roster = (ids, extra = {}) => ({ ok: true, players: ids.map((id) => P(id)), fetchedAt: '2026-10-19T08:00:00.000Z', ...extra });
const ME = { teamKey: '466.l.1.t.1', name: 'My Team' };
const T2 = { teamKey: '466.l.1.t.2', name: 'Team Two' };
const T3 = { teamKey: '466.l.1.t.3', name: 'Team Three' };

function input(overrides = {}) {
  return {
    available: { players: [P(9), P(10), P(11)], ok: true, report: { failed: false, hitCap: false, noKey: 0, gapPages: 0 } },
    myTeam: ME,
    myRoster: roster([1, 2]),
    opponents: [{ ...T2, ...roster([3, 4, 5]) }, { ...T3, ...roster([6, 7, 8]) }],
    expectedTeams: 3,
    ...overrides,
  };
}
const byKey = (pool) => Object.fromEntries(pool.players.map((p) => [p.playerKey, p]));

test('flag: only on / true / 1 enable full-pool Rankings; everything else (including unset) is off', () => {
  for (const v of ['on', 'TRUE', ' 1 ']) assert.equal(resolveRankingsFullPool({ PROGM_RANKINGS_FULL_POOL: v }), true, v);
  for (const v of [undefined, '', 'off', 'false', '0', 'yes', 'enabled']) assert.equal(resolveRankingsFullPool({ PROGM_RANKINGS_FULL_POOL: v }), false, String(v));
  assert.equal(resolveRankingsFullPool({}), false);
});

test('complete pool: available + my roster + every roster, each player annotated with availability and owner', () => {
  const pool = assembleLeaguePool(input());
  assert.equal(pool.completeness.complete, true);
  assert.deepEqual(pool.completeness.reasons, []);
  assert.equal(pool.players.length, 11);
  const m = byKey(pool);
  assert.deepEqual([m['466.p.1'].availability, m['466.p.1'].ownedByMe, m['466.p.1'].ownerTeam, m['466.p.1'].ownerTeamKey], ['mine', true, 'My Team', ME.teamKey]);
  assert.deepEqual([m['466.p.4'].availability, m['466.p.4'].ownedByMe, m['466.p.4'].ownerTeam, m['466.p.4'].ownerTeamKey], ['rostered', false, 'Team Two', T2.teamKey]);
  assert.deepEqual([m['466.p.7'].availability, m['466.p.7'].ownerTeam], ['rostered', 'Team Three']);
  assert.deepEqual([m['466.p.9'].availability, m['466.p.9'].ownedByMe, m['466.p.9'].ownerTeam, m['466.p.9'].ownerTeamKey], ['available', false, null, null]);
  assert.deepEqual(pool.completeness.counts, { total: 11, available: 3, rostered: 6, mine: 2, teamsExpected: 3, teamsLoaded: 3, failedRosters: 0, duplicateOwnership: 0, availableAlsoRostered: 0 });
});

test('the scope and its limitation are ALWAYS reported: available + rosters is not proof of every Yahoo-eligible player', () => {
  for (const pool of [assembleLeaguePool(input()), assembleLeaguePool(input({ expectedTeams: null }))]) {
    assert.equal(pool.completeness.scope, POOL_SCOPE);
    assert.equal(pool.completeness.limitations.length, 1);
    assert.match(pool.completeness.limitations[0], /cannot prove that no other Yahoo-eligible player exists/);
  }
});

test('injury status is independent of ownership: injured players stay, with their Yahoo status untouched', () => {
  const pool = assembleLeaguePool(input({ opponents: [{ ...T2, ok: true, players: [P(3, { status: 'INJ' }), P(4, { status: 'O' })] }, { ...T3, ...roster([6, 7, 8]) }], available: { players: [P(9, { status: 'NA' })], ok: true, report: {} } }));
  const m = byKey(pool);
  assert.deepEqual([m['466.p.3'].status, m['466.p.3'].availability], ['INJ', 'rostered']);
  assert.deepEqual([m['466.p.4'].status, m['466.p.4'].availability], ['O', 'rostered']);
  assert.deepEqual([m['466.p.9'].status, m['466.p.9'].availability], ['NA', 'available']);
});

test('input players are not mutated and the status timestamp comes from the roster fetch', () => {
  const given = input();
  const snapshot = JSON.stringify(given);
  const pool = assembleLeaguePool(given);
  assert.equal(JSON.stringify(given), snapshot);
  assert.equal(byKey(pool)['466.p.3'].yahooStatusFetchedAt, '2026-10-19T08:00:00.000Z');
});

test('order does not matter: shuffled inputs give the same players and annotations', () => {
  const a = assembleLeaguePool(input());
  const b = assembleLeaguePool(input({ available: { players: [P(11), P(9), P(10)], ok: true, report: {} }, opponents: [{ ...T3, ...roster([8, 7, 6]) }, { ...T2, ...roster([5, 4, 3]) }] }));
  const norm = (pool) => JSON.stringify(pool.players.map((p) => [p.playerKey, p.availability, p.ownerTeam]).sort());
  assert.equal(norm(a), norm(b));
});

test('a player on two rosters is duplicate ownership: first owner kept, conflict flagged, pool NOT complete', () => {
  const pool = assembleLeaguePool(input({ opponents: [{ ...T2, ...roster([3, 4, 5]) }, { ...T3, ...roster([5, 7, 8]) }] }));
  assert.equal(pool.completeness.complete, false);
  assert.equal(pool.completeness.counts.duplicateOwnership, 1);
  assert.match(pool.completeness.reasons.join(' '), /1 player appears on more than one team roster/);
  assert.equal(byKey(pool)['466.p.5'].ownerTeam, 'Team Two');
  assert.equal(byKey(pool)['466.p.5'].ownershipConflict, true);
  assert.equal(pool.players.filter((p) => p.playerKey === '466.p.5').length, 1);
});

test('available AND rostered (the league changed while loading): the roster wins, it is warned about, and it does not make the pool partial', () => {
  const pool = assembleLeaguePool(input({ available: { players: [P(3), P(9)], ok: true, report: {} } }));
  assert.equal(byKey(pool)['466.p.3'].availability, 'rostered');
  assert.equal(pool.completeness.complete, true);
  assert.match(pool.completeness.warnings.join(' '), /1 player was listed as available and on a roster/);
  assert.equal(pool.completeness.counts.availableAlsoRostered, 1);
});

test('a FAILED roster request is distinguishable from a genuinely EMPTY roster, and both make the pool partial', () => {
  const failed = assembleLeaguePool(input({ opponents: [{ ...T2, ok: false, players: [], fetchedAt: null }, { ...T3, ...roster([6, 7, 8]) }] }));
  assert.equal(failed.completeness.complete, false);
  assert.match(failed.completeness.reasons.join(' '), /roster could not be loaded for Team Two/);
  assert.doesNotMatch(failed.completeness.reasons.join(' '), /no players/);
  assert.equal(failed.completeness.counts.failedRosters, 1);
  assert.equal(failed.completeness.counts.teamsLoaded, 2);

  const empty = assembleLeaguePool(input({ opponents: [{ ...T2, ok: true, players: [], fetchedAt: 'x' }, { ...T3, ...roster([6, 7, 8]) }] }));
  assert.equal(empty.completeness.complete, false);
  assert.match(empty.completeness.reasons.join(' '), /roster for Team Two came back with no players/);
  assert.doesNotMatch(empty.completeness.reasons.join(' '), /could not be loaded/);
  assert.equal(empty.completeness.counts.failedRosters, 0);
});

test('missing teams are detected: standings with fewer teams than the league, or an unknown league size', () => {
  const short = assembleLeaguePool(input({ opponents: [{ ...T2, ...roster([3, 4, 5]) }], expectedTeams: 3 }));
  assert.equal(short.completeness.complete, false);
  assert.match(short.completeness.reasons.join(' '), /standings listed 2 of 3 teams/);
  const unknown = assembleLeaguePool(input({ expectedTeams: null }));
  assert.equal(unknown.completeness.complete, false);
  assert.match(unknown.completeness.reasons.join(' '), /number of teams in this league is unknown/);
});

test('available-list problems make the pool partial: failed fetch, failed page, cap, keyless entries', () => {
  const reasonsFor = (available) => assembleLeaguePool(input({ available })).completeness;
  const down = reasonsFor({ players: [], ok: false, report: null });
  assert.equal(down.complete, false); assert.match(down.reasons.join(' '), /available players could not be loaded/);
  const page = reasonsFor({ players: [P(9)], ok: true, report: { failed: true } });
  assert.equal(page.complete, false); assert.match(page.reasons.join(' '), /page of the available-player list failed/);
  const cap = reasonsFor({ players: [P(9)], ok: true, report: { hitCap: true } });
  assert.equal(cap.complete, false); assert.match(cap.reasons.join(' '), /reached the 1000-player limit/);
  const noKey = reasonsFor({ players: [P(9)], ok: true, report: { noKey: 3 } });
  assert.equal(noKey.complete, false); assert.match(noKey.reasons.join(' '), /3 available-player entries had no player key/);
  const keyless = assembleLeaguePool(input({ available: { players: [{ name: 'No Key' }, P(9)], ok: true, report: {} } }));
  assert.equal(keyless.completeness.complete, false);
  assert.equal(keyless.players.some((p) => p.name === 'No Key'), false, 'a keyless entry is never ranked');
});

test('irregular paging that was fully read is only a warning', () => {
  const pool = assembleLeaguePool(input({ available: { players: [P(9)], ok: true, report: { gapPages: 2 } } }));
  assert.equal(pool.completeness.complete, true);
  assert.match(pool.completeness.warnings.join(' '), /irregular paging/);
});

test('roster entries without a player key cannot be ranked and make the pool partial', () => {
  const pool = assembleLeaguePool(input({ opponents: [{ ...T2, ok: true, players: [P(3), { name: 'Ghost' }], fetchedAt: 'x' }, { ...T3, ...roster([6, 7, 8]) }] }));
  assert.equal(pool.completeness.complete, false);
  assert.match(pool.completeness.reasons.join(' '), /1 roster entries had no player key/);
  assert.equal(pool.players.some((p) => p.name === 'Ghost'), false);
});
