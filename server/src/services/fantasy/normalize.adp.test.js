/**
 * Focused tests for Yahoo draft_analysis (ADP) normalization in normalizePlayer.
 * "-" / missing => null (never 0); preseason_* used as fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlayer, parseYahooRanks, yahooDraftPlayersPath, yahooRosterPlayersPath } from './normalize.js';

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

// --- Yahoo `ranks` (OR + season S) normalization ----------------------------

const RANKS = [
  { player_rank: { rank_type: 'OR', rank_value: '65' } },
  { player_rank: { rank_type: 'S', rank_value: '97', rank_season: '2025' } },
  { player_rank: { rank_type: 'S', rank_value: '65', rank_season: '2024' } },
  { player_rank: { rank_type: 'S', rank_value: '70', rank_season: '2023' } },
];

test('parseYahooRanks extracts OR (overall) and per-season S ranks', () => {
  const r = parseYahooRanks(RANKS);
  assert.equal(r.overall, 65);
  assert.deepEqual(r.bySeason, { 2025: 97, 2024: 65, 2023: 70 });
});

test('parseYahooRanks: missing/"-"/non-numeric values are omitted (never 0)', () => {
  const r = parseYahooRanks([
    { player_rank: { rank_type: 'OR', rank_value: '-' } },
    { player_rank: { rank_type: 'S', rank_value: '', rank_season: '2025' } },
    { player_rank: { rank_type: 'S', rank_value: 'abc', rank_season: '2024' } },
    { player_rank: { rank_type: 'S', rank_value: '0', rank_season: '2023' } },
    { player_rank: { rank_type: 'S', rank_value: '   ', rank_season: '2022' } },
  ]);
  assert.equal(r, null); // nothing usable -> null, not { overall: 0 }
});

test('parseYahooRanks tolerates absent / non-array input', () => {
  assert.equal(parseYahooRanks(undefined), null);
  assert.equal(parseYahooRanks(null), null);
  assert.equal(parseYahooRanks([]), null);
});

test('normalizePlayer surfaces yahooRanks { overall, bySeason } via the ranks sub-resource', () => {
  const p = normalizePlayer([
    [{ player_key: '466.p.3' }, { name: { full: 'Ranked Player' } }, { eligible_positions: [{ position: 'C' }] }],
    { player_ranks: RANKS },
  ]);
  assert.equal(p.yahooRanks.overall, 65);
  assert.equal(p.yahooRanks.bySeason['2025'], 97);
  assert.equal(p.yahooOverallRank, 65);
  assert.equal(p.yahooSeasonRanks['2025'], 97);
});

test('normalizePlayer leaves yahooRanks null when the ranks sub-resource is absent', () => {
  const p = normalizePlayer([[{ player_key: '466.p.4' }, { name: { full: 'No Ranks' } }, { eligible_positions: [{ position: 'PG' }] }]]);
  assert.equal(p.yahooRanks, null);
  assert.equal(p.yahooOverallRank, null);
  assert.deepEqual(p.yahooSeasonRanks, {});
});

test('roster tuple preserves position and surfaces valid Yahoo draft metadata', () => {
  const p = normalizePlayer([
    [{ player_key: '466.p.5' }, { name: { full: 'Rostered Player' } }, { eligible_positions: [{ position: 'PG' }] }],
    { selected_position: [{ position: 'PG' }] },
    { draft_analysis: [{ average_pick: '4.2' }, { average_round: '1.0' }, { percent_drafted: '99.8' }] },
    { player_ranks: RANKS },
  ]);
  assert.equal(p.selectedPosition, 'PG');
  assert.equal(p.yahooAdp, 4.2);
  assert.equal(p.yahooOverallRank, 65);
  assert.equal(p.yahooSeasonRanks['2025'], 97);
});

test('roster tuple keeps missing and malformed Yahoo draft metadata null', () => {
  const p = normalizePlayer([
    [{ player_key: '466.p.6' }, { name: { full: 'Unranked Player' } }],
    { selected_position: [{ position: 'BN' }] },
    { draft_analysis: [{ average_pick: 'bad' }, { preseason_average_pick: '0' }] },
    { player_ranks: [{ player_rank: { rank_type: 'OR', rank_value: 'NaN' } }] },
  ]);
  assert.equal(p.yahooAdp, null);
  assert.equal(p.yahooOverallRank, null);
  assert.deepEqual(p.yahooSeasonRanks, {});
});

test('Draft Helper batches ownership, ADP, and ranks in one players request', () => {
  const path = yahooDraftPlayersPath('466.l.123');
  assert.equal(path, '/league/466.l.123/players;status=A;sort=OR;start=0;count=50/percent_owned;draft_analysis;ranks');
  assert.equal((path.match(/\/players/g) || []).length, 1);
  assert.match(path, /[;/]ranks$/);
  assert.doesNotMatch(path, /player_ranks/);
});

test('rostered Draft Helper players request ADP and ranks in one team request', () => {
  const path = yahooRosterPlayersPath('466.l.123.t.7');
  assert.equal(path, '/team/466.l.123.t.7/roster/players/draft_analysis;ranks');
  assert.equal((path.match(/\/players/g) || []).length, 1);
  assert.match(path, /\/draft_analysis;ranks$/);
  assert.doesNotMatch(path, /status=A/);
});
