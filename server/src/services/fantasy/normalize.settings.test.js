import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeagueSettings } from './normalize.js';

function settingsResponse(turnoverWeight) {
  return { fantasy_content: { league: [
    [{ league_key: '478.l.1' }, { league_id: '1' }, { name: 'Test' }, { season: '2026' }, { scoring_type: 'headpoint' }],
    { settings: [
      { scoring_type: 'headpoint' },
      { stat_categories: { stats: [
        { stat: { stat_id: '12', name: 'Points Scored', abbr: 'PTS', enabled: '1' } },
        { stat: { stat_id: '19', name: 'Turnovers', abbr: 'TO', enabled: '1' } },
      ] } },
      { stat_modifiers: { stats: [
        { stat: { stat_id: '12', value: '1' } },
        { stat: { stat_id: '19', value: String(turnoverWeight) } },
      ] } },
    ] },
  ] } };
}

test('Yahoo points settings preserve selected-league weights including negatives', () => {
  const league = normalizeLeagueSettings(settingsResponse(-2));
  assert.equal(league.settings.scoringFormat, 'points');
  assert.deepEqual(league.settings.statCategories.map(({ statId, pointValue }) => ({ statId, pointValue })), [
    { statId: 12, pointValue: 1 },
    { statId: 19, pointValue: -2 },
  ]);
});
