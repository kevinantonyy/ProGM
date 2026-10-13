import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeasonYear, gameIdOf, seasonLabel, dedupeLeagues,
  sortLeaguesNewestFirst, orderLeaguesForDisplay, chooseDefaultLeague,
} from './leagueOrdering.js';

const L = (key, season, name = 'League') => ({ leagueKey: key, season, name });

test('parseSeasonYear reads Yahoo metadata, not the name', () => {
  assert.equal(parseSeasonYear({ season: '2025', name: '2010 Throwback' }), 2025);
  assert.equal(parseSeasonYear({ season: 2024 }), 2024);
  assert.equal(parseSeasonYear({ season: '' }), null);
  assert.equal(parseSeasonYear({ season: 'abc' }), null);
  assert.equal(parseSeasonYear({}), null);
});

test('gameIdOf + seasonLabel', () => {
  assert.equal(gameIdOf({ leagueKey: '466.l.103029' }), 466);
  assert.equal(gameIdOf({ leagueKey: 'bad' }), null);
  assert.equal(seasonLabel(2025), '2025-26');
  assert.equal(seasonLabel(2019), '2019-20');
  assert.equal(seasonLabel(null), null);
});

test('sorts newest season first (multiple seasons)', () => {
  const leagues = [L('454.l.1', '2024'), L('466.l.2', '2025'), L('428.l.3', '2023')];
  const sorted = sortLeaguesNewestFirst(leagues).map((l) => l.leagueKey);
  assert.deepEqual(sorted, ['466.l.2', '454.l.1', '428.l.3']);
});

test('multiple leagues in one season: deterministic order (by gameId then key)', () => {
  const leagues = [L('466.l.300', '2025'), L('466.l.100', '2025'), L('466.l.200', '2025')];
  const sorted = sortLeaguesNewestFirst(leagues).map((l) => l.leagueKey);
  // Same season + same gameId -> tiebreak by leagueKey asc, stable regardless of input order.
  assert.deepEqual(sorted, ['466.l.100', '466.l.200', '466.l.300']);
  // Re-run with shuffled input to confirm determinism.
  const shuffled = sortLeaguesNewestFirst([leagues[1], leagues[2], leagues[0]]).map((l) => l.leagueKey);
  assert.deepEqual(shuffled, sorted);
});

test('missing/odd season metadata: known seasons rank above unknown; gameId breaks ties', () => {
  const leagues = [L('400.l.9', ''), L('466.l.1', '2025'), L('454.l.2', null)];
  const sorted = sortLeaguesNewestFirst(leagues).map((l) => l.leagueKey);
  // 2025 known first; then unknown-season leagues ordered by gameId desc (454 > 400).
  assert.deepEqual(sorted, ['466.l.1', '454.l.2', '400.l.9']);
});

test('duplicate league records are deduped by stable key, not name', () => {
  const leagues = [L('466.l.1', '2025', 'Real league'), L('466.l.1', '2025', 'Real league'), L('466.l.2', '2025', 'Real league')];
  // Two distinct keys survive despite identical names; the dupe key collapses to one.
  const deduped = dedupeLeagues(leagues);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((l) => l.leagueKey).sort(), ['466.l.1', '466.l.2']);
});

test('dedupe prefers the record that has a season', () => {
  const leagues = [L('466.l.1', ''), L('466.l.1', '2025')];
  const deduped = dedupeLeagues(leagues);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].season, '2025');
});

test('default selection = newest when no manual pick', () => {
  const leagues = [L('454.l.1', '2024'), L('466.l.2', '2025')];
  const r = chooseDefaultLeague(leagues, null);
  assert.equal(r.selectedLeagueKey, '466.l.2');
  assert.equal(r.reason, 'default_newest');
});

test('honors an in-session manual pick when it is not an older season', () => {
  const leagues = [L('466.l.a', '2025'), L('466.l.b', '2025')];
  const r = chooseDefaultLeague(leagues, '466.l.b');
  assert.equal(r.selectedLeagueKey, '466.l.b');
  assert.equal(r.reason, 'honored_manual_selection');
});

test('historical manual selection remains selected', () => {
  const leagues = [L('454.l.old', '2024'), L('466.l.new', '2025')];
  const r = chooseDefaultLeague(leagues, '454.l.old');
  assert.equal(r.selectedLeagueKey, '454.l.old');
  assert.equal(r.reason, 'honored_manual_selection');
});

test('newer seasons sort first without overriding a persisted historical selection', () => {
  // Before: newest is 2025; user is on 2025.
  const before = [L('466.l.cur', '2025'), L('454.l.old', '2024')];
  assert.equal(chooseDefaultLeague(before, '466.l.cur').selectedLeagueKey, '466.l.cur');
  // Later: Yahoo exposes the 2026 league. The explicit persisted pick remains.
  const after = [L('478.l.future', '2026'), L('466.l.cur', '2025'), L('454.l.old', '2024')];
  const r = chooseDefaultLeague(after, '466.l.cur');
  assert.equal(r.selectedLeagueKey, '466.l.cur');
  assert.equal(r.reason, 'honored_manual_selection');
  // The newest league is still first in the ordered list.
  assert.equal(r.leagues[0].leagueKey, '478.l.future');
  assert.equal(r.leagues[0].seasonLabel, '2026-27');
});

test('future-proof across many seasons (2026-27, 2027-28, 2028-29) — no hardcoding', () => {
  // Arbitrary future seasons must sort newest-first purely from metadata.
  const leagues = [
    L('466.l.a', '2025'),
    L('490.l.d', '2028'),
    L('478.l.b', '2026'),
    L('484.l.c', '2027'),
  ];
  const ordered = orderLeaguesForDisplay(leagues);
  assert.deepEqual(ordered.map((l) => l.seasonYear), [2028, 2027, 2026, 2025]);
  assert.deepEqual(ordered.map((l) => l.seasonLabel), ['2028-29', '2027-28', '2026-27', '2025-26']);
  // Default is always the newest, regardless of which year it is.
  assert.equal(chooseDefaultLeague(leagues, null).selectedLeagueKey, '490.l.d');
});

test('upcoming pre-games league (season set, zero games) is eligible as newest/default', () => {
  // A brand-new upcoming league Yahoo exposes before tip-off still has a season
  // in metadata, so it must be able to become the newest/default immediately.
  const leagues = [
    { leagueKey: '466.l.cur', season: '2025', name: 'Current', numTeams: 12 },
    { leagueKey: '478.l.upcoming', season: '2026', name: 'Preseason League', numTeams: 0 }, // no games yet
  ];
  const r = chooseDefaultLeague(leagues, null);
  assert.equal(r.selectedLeagueKey, '478.l.upcoming');
  assert.equal(r.reason, 'default_newest');
  assert.equal(r.leagues[0].seasonLabel, '2026-27');
});

test('persisted key that no longer exists falls back to newest', () => {
  const leagues = [L('466.l.1', '2025')];
  const r = chooseDefaultLeague(leagues, '999.l.gone');
  assert.equal(r.selectedLeagueKey, '466.l.1');
  assert.equal(r.reason, 'persisted_not_found');
});

test('orderLeaguesForDisplay adds seasonYear + seasonLabel', () => {
  const out = orderLeaguesForDisplay([L('466.l.1', '2025')]);
  assert.equal(out[0].seasonYear, 2025);
  assert.equal(out[0].seasonLabel, '2025-26');
});
