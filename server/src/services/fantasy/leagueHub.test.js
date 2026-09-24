import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeagueHub } from './leagueHub.js';

function row(teamKey, rank, wins, losses, pf, opts = {}) {
  return { teamKey, name: teamKey, rank, wins, losses, ties: 0, pointsFor: pf, managerName: 'M', ...opts };
}

test('empty standings returns unavailable hub', () => {
  const hub = buildLeagueHub({ standings: [] });
  assert.equal(hub.available, false);
  assert.deepEqual(hub.powerRankings, []);
});

test('standings pass through in rank order with facts intact', () => {
  const hub = buildLeagueHub({ standings: [row('B', 2, 5, 5, 900), row('A', 1, 8, 2, 1100)] });
  assert.deepEqual(hub.standings.map((s) => s.teamKey), ['A', 'B']);
  assert.equal(hub.standings[0].wins, 8);
});

test('power ranking blends record and points-for (65/35)', () => {
  // A: 8-2 winPct .8, PF 1100 (max => norm 1) -> .65*.8 + .35*1 = .87
  // B: 5-5 winPct .5, PF 900 norm .818 -> .65*.5 + .35*.818 = .611
  const hub = buildLeagueHub({ standings: [row('A', 1, 8, 2, 1100), row('B', 2, 5, 5, 900)] });
  assert.equal(hub.powerRankings[0].teamKey, 'A');
  assert.equal(hub.powerRankings[0].powerRank, 1);
  assert.ok(hub.powerRankings[0].powerScore > hub.powerRankings[1].powerScore);
});

test('power ranking omitted when no games played yet', () => {
  const hub = buildLeagueHub({ standings: [row('A', 1, 0, 0, 0), row('B', 2, 0, 0, 0)] });
  assert.equal(hub.available, true);
  assert.deepEqual(hub.powerRankings, []);
  assert.match(hub.note, /No games/);
});

test('marks my team', () => {
  const hub = buildLeagueHub({ standings: [row('A', 1, 8, 2, 1100), row('B', 2, 5, 5, 900)], myTeamKey: 'B' });
  assert.equal(hub.standings.find((s) => s.teamKey === 'B').isMine, true);
});
