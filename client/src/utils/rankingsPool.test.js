import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRankings, availabilityLabel, poolCounts, unrankedLabel, AVAILABILITY_FILTERS } from './rankingsPool.js';

const ROWS = [
  { playerKey: 'p1', name: 'Nikola Jokic', teamAbbr: 'DEN', availability: 'mine', ownerTeam: 'My Team', overallRank: 1, rankStatus: 'ranked' },
  { playerKey: 'p2', name: 'Luka Doncic', teamAbbr: 'LAL', availability: 'rostered', ownerTeam: 'Team Two', overallRank: 2, rankStatus: 'ranked' },
  { playerKey: 'p3', name: 'Free Agent Vet', teamAbbr: 'BOS', availability: 'available', ownerTeam: null, overallRank: 3, rankStatus: 'ranked' },
  { playerKey: 'p4', name: 'Rookie Nobody', teamAbbr: 'BOS', availability: 'available', ownerTeam: null, overallRank: null, rankStatus: 'unranked' },
  { playerKey: 'p5', name: 'Injured Star', teamAbbr: 'NYK', availability: 'rostered', ownerTeam: 'Team Three', overallRank: 4, rankStatus: 'ranked', status: 'INJ' },
];
const names = (rows) => rows.map((r) => r.name);

test('the four filters: All, Available, Rostered (other teams) and My Team', () => {
  assert.deepEqual(AVAILABILITY_FILTERS.map(([value]) => value), ['ALL', 'available', 'rostered', 'mine']);
  assert.equal(filterRankings(ROWS, { availability: 'ALL' }).length, 5);
  assert.deepEqual(names(filterRankings(ROWS, { availability: 'available' })), ['Free Agent Vet', 'Rookie Nobody']);
  assert.deepEqual(names(filterRankings(ROWS, { availability: 'rostered' })), ['Luka Doncic', 'Injured Star']);
  assert.deepEqual(names(filterRankings(ROWS, { availability: 'mine' })), ['Nikola Jokic']);
});

test('search matches player, NBA team and owner team, case-insensitively, and combines with the filter', () => {
  assert.deepEqual(names(filterRankings(ROWS, { query: ' LUKA ' })), ['Luka Doncic']);
  assert.deepEqual(names(filterRankings(ROWS, { query: 'bos' })), ['Free Agent Vet', 'Rookie Nobody']);
  assert.deepEqual(names(filterRankings(ROWS, { query: 'team three' })), ['Injured Star']);
  assert.deepEqual(names(filterRankings(ROWS, { query: 'bos', availability: 'available' })), ['Free Agent Vet', 'Rookie Nobody']);
  assert.deepEqual(filterRankings(ROWS, { query: 'zzz' }), []);
});

test('RANK IMMUTABILITY: filtering and searching return the SAME row objects, so no rank can change', () => {
  const frozen = ROWS.map((r) => Object.freeze({ ...r }));
  const before = JSON.stringify(frozen);
  for (const availability of ['ALL', 'available', 'rostered', 'mine']) {
    for (const query of ['', 'a', 'bos', 'team']) {
      const out = filterRankings(frozen, { availability, query });
      for (const row of out) {
        const original = frozen.find((r) => r.playerKey === row.playerKey);
        assert.equal(row, original, 'same object');
        assert.equal(row.overallRank, original.overallRank);
      }
    }
  }
  assert.equal(JSON.stringify(frozen), before);
  // A filtered list is a subset and its ranks are not renumbered (rank 3 stays 3 even when it is the first row shown).
  assert.deepEqual(filterRankings(ROWS, { availability: 'available' }).map((r) => r.overallRank), [3, null]);
});

test('bad input is safe', () => {
  assert.deepEqual(filterRankings(undefined), []);
  assert.deepEqual(filterRankings(null, { availability: 'mine', query: 'x' }), []);
});

test('availability labels are about ownership only; the unranked label is about stats only', () => {
  assert.equal(availabilityLabel(ROWS[0]), 'Your team');
  assert.equal(availabilityLabel(ROWS[1]), 'Rostered · Team Two');
  assert.equal(availabilityLabel({ availability: 'rostered' }), 'Rostered · another team');
  assert.equal(availabilityLabel(ROWS[2]), 'Available');
  assert.equal(availabilityLabel({}), 'Availability unknown');
  // An AVAILABLE player can be unranked and a ROSTERED player can be ranked: the two facts are independent.
  assert.equal(unrankedLabel(ROWS[3]), 'Unranked'); assert.equal(ROWS[3].availability, 'available');
  assert.equal(unrankedLabel(ROWS[1]), null); assert.equal(ROWS[1].availability, 'rostered');
  assert.equal(unrankedLabel(ROWS[4]), null); assert.equal(ROWS[4].status, 'INJ', 'injury status is untouched by ownership');
});

test('pool counts', () => {
  assert.deepEqual(poolCounts(ROWS), { total: 5, available: 2, rostered: 2, mine: 1, unranked: 1 });
  assert.deepEqual(poolCounts(undefined), { total: 0, available: 0, rostered: 0, mine: 0, unranked: 0 });
});
