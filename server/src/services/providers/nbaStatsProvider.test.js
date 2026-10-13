import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLeagueDashPlayerStats, nbaSeason } from './nbaStatsProvider.js';

test('Yahoo/NBA season start year maps to the matching NBA season label', () => {
  assert.equal(nbaSeason(2025), '2025-26');
  assert.equal(nbaSeason('2026'), '2026-27');
});

test('official NBA rebound totals are divided by games played', () => {
  const data = { resultSets: [{
    headers: ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ABBREVIATION', 'GP', 'REB', 'OREB', 'DREB', 'PTS'],
    rowSet: [[203999, 'Nikola Jokic', 'DEN', 65, 836, 173, 663, 1799]],
  }] };
  const [row] = mapLeagueDashPlayerStats(data);
  assert.equal(row.season.gamesPlayed, 65);
  assert.equal(row.season.rebounds, 836 / 65);
  assert.equal(row.season.offRebounds, 173 / 65);
  assert.equal(row.season.defRebounds, 663 / 65);
});

