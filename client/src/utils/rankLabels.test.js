import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftSortButtons, rankLabel, rankTitle, rankingsRankColumn } from './rankLabels.js';

test('stable scopes read "ProGM Rank"; relative scope reads "Rank (avail.)"', () => {
  for (const scope of ['full_pool', null, undefined]) {
    assert.equal(rankLabel(scope), 'ProGM Rank');
    assert.match(rankTitle(scope), /stable as other teams draft/);
  }
  assert.equal(rankLabel('available_players'), 'Rank (avail.)');
  assert.match(rankTitle('available_players'), /currently available/);
  assert.doesNotMatch(rankTitle('available_players'), /stable as other teams draft/);
  assert.doesNotMatch(rankLabel('available_players'), /ProGM Rank/);
});

test('Draft Helper sorts by ProGM Rank first and exposes no second rank sort', () => {
  const [first, ...rest] = draftSortButtons('full_pool');
  assert.deepEqual(first.slice(0, 2), ['progm', 'ProGM Rank']);
  assert.equal(rest.length, 0);
  assert.equal(draftSortButtons('available_players')[0][1], 'Rank (avail.)');
  for (const scope of ['full_pool', 'available_players']) {
    assert.ok(!JSON.stringify(draftSortButtons(scope)).match(/Priority|Overall/));
  }
});

test('Rankings column is named ProGM Rank (not ProGM Overall) and only shown with ranks', () => {
  assert.deepEqual(rankingsRankColumn('full_pool', true), ['overall', 'ProGM Rank']);
  assert.deepEqual(rankingsRankColumn('available_players', true), ['overall', 'Rank (avail.)']);
  assert.equal(rankingsRankColumn('full_pool', false), null);
  assert.ok(!JSON.stringify(rankingsRankColumn('full_pool', true)).includes('Overall'.concat(' ')));
});
