/**
 * Focused tests for Yahoo draft_analysis (ADP) normalization in normalizePlayer.
 * "-" / missing => null (never 0); preseason_* used as fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlayer } from './normalize.js';

// Build a Yahoo player tuple: [ [props...], {draft_analysis:[...]} ].
function playerWithDraftAnalysis(da) {
  return [
    [
      { player_key: '466.p.1' },
      { player_id: '1' },
      { name: { full: 'Test Player' } },
      { editorial_team_abbr: 'BOS' },
      { eligible_positions: [{ position: 'PG' }] },
    ],
    { draft_analysis: da },
  ];
}

test('parses average_pick / average_round / percent_drafted', () => {
  const p = normalizePlayer(playerWithDraftAnalysis([
    { average_pick: '126.3' }, { average_round: '12.7' }, { average_cost: '1.2' }, { percent_drafted: '0.13' },
  ]));
  assert.equal(p.yahooAdp, 126.3);
  assert.equal(p.yahooAvgRound, 12.7);
  assert.equal(p.yahooPercentDrafted, 0.13);
});

test('"-" (missing) becomes null, never 0', () => {
  const p = normalizePlayer(playerWithDraftAnalysis([
    { average_pick: '-' }, { average_round: '-' }, { average_cost: '-' }, { percent_drafted: '-' },
  ]));
  assert.equal(p.yahooAdp, null);
  assert.equal(p.yahooAvgRound, null);
  assert.equal(p.yahooPercentDrafted, null);
});

test('falls back to preseason_* when live values are missing', () => {
  const p = normalizePlayer(playerWithDraftAnalysis([
    { average_pick: '-' }, { average_round: '-' }, { average_cost: '-' }, { percent_drafted: '-' },
    { preseason_average_pick: '130.9' }, { preseason_average_round: '13.0' }, { preseason_average_cost: '1.2' }, { preseason_percent_drafted: '0.1' },
  ]));
  assert.equal(p.yahooAdp, 130.9);
  assert.equal(p.yahooAvgRound, 13.0);
  assert.equal(p.yahooPercentDrafted, 0.1);
});

test('absent draft_analysis sub-resource leaves ADP fields null', () => {
  const p = normalizePlayer([[{ player_key: '466.p.2' }, { name: { full: 'No ADP' } }, { eligible_positions: [{ position: 'SG' }] }]]);
  assert.equal(p.yahooAdp, null);
  assert.equal(p.yahooAvgRound, null);
  assert.equal(p.yahooPercentDrafted, null);
});
