import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supplementReboundSplits } from './insights.js';

test('rebound supplement fills splits without changing or summing total rebounds', () => {
  const stats = { season: { gamesPlayed: 65, rebounds: 12.86, offRebounds: null, defRebounds: null } };
  const result = supplementReboundSplits(stats, { offRebounds: 2.66, defRebounds: 10.2 });
  assert.equal(result.season.rebounds, 12.86);
  assert.equal(result.season.offRebounds, 2.66);
  assert.equal(result.season.defRebounds, 10.2);
});

test('rebound supplement never overwrites existing provider splits', () => {
  const stats = { season: { rebounds: 10, offRebounds: 3, defRebounds: 7 } };
  const result = supplementReboundSplits(stats, { offRebounds: 1, defRebounds: 9 });
  assert.deepEqual(result.season, stats.season);
});

