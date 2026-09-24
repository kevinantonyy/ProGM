import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toYmd, resolvePeriodWindow, expectedGamesInPeriod, playerPeriodValue } from './scheduleValue.js';

const SCHEDULES = {
  BOS: [
    { gameDate: '20251103', completed: true },
    { gameDate: '20251105', completed: false },
    { gameDate: '20251107', completed: false },
    { gameDate: '20251110', completed: false }, // outside a Mon-Sun window ending 11/09
  ],
  LAL: [
    { gameDate: '20251104', completed: false },
    { gameDate: '20251109', completed: false }, // boundary (inclusive end)
  ],
};

test('toYmd parses both formats', () => {
  assert.equal(toYmd('20251103'), 20251103);
  assert.equal(toYmd('2025-11-03'), 20251103);
  assert.equal(toYmd('bad'), null);
  assert.equal(toYmd(null), null);
});

test('resolvePeriodWindow from settings.period dates', () => {
  assert.deepEqual(resolvePeriodWindow({ period: { startDate: '2025-11-03', endDate: '2025-11-09' } }), { startYmd: 20251103, endYmd: 20251109 });
  assert.equal(resolvePeriodWindow({ period: {} }), null);
  assert.equal(resolvePeriodWindow(null), null);
  assert.equal(resolvePeriodWindow({ period: { startDate: '2025-11-09', endDate: '2025-11-03' } }), null); // end<start
});

test('expectedGamesInPeriod counts in-window, excludes completed + out-of-window', () => {
  // Window Mon 11/03 - Sun 11/09. BOS: 11/03 completed(skip), 11/05, 11/07 in-window, 11/10 out. => 2
  assert.equal(expectedGamesInPeriod('BOS', SCHEDULES, 20251103, 20251109), 2);
  // LAL: 11/04 + 11/09(inclusive boundary) => 2
  assert.equal(expectedGamesInPeriod('LAL', SCHEDULES, 20251103, 20251109), 2);
});

test('expectedGamesInPeriod returns null for unknown team', () => {
  assert.equal(expectedGamesInPeriod('XXX', SCHEDULES, 20251103, 20251109), null);
});

test('expectedGamesInPeriod respects team aliases (PHX/PHO)', () => {
  const s = { PHO: [{ gameDate: '20251105', completed: false }] };
  assert.equal(expectedGamesInPeriod('PHX', s, 20251103, 20251109), 1);
});

test('playerPeriodValue = perGame * expectedGames when data present', () => {
  const r = playerPeriodValue({ projectedPerGame: 40, teamAbbr: 'BOS', schedules: SCHEDULES, periodWindow: { startYmd: 20251103, endYmd: 20251109 } });
  assert.equal(r.expectedGames, 2);
  assert.equal(r.periodProjectedPoints, 80);
  assert.equal(r.scheduleAware, true);
});

test('playerPeriodValue falls back (not fabricated) when no schedule/period', () => {
  assert.deepEqual(playerPeriodValue({ projectedPerGame: 40, teamAbbr: 'BOS', schedules: null, periodWindow: null }), { expectedGames: null, periodProjectedPoints: null, scheduleAware: false });
  // Unknown team -> expectedGames null, no period points.
  const r = playerPeriodValue({ projectedPerGame: 40, teamAbbr: 'XXX', schedules: SCHEDULES, periodWindow: { startYmd: 20251103, endYmd: 20251109 } });
  assert.equal(r.expectedGames, null);
  assert.equal(r.periodProjectedPoints, null);
  assert.equal(r.scheduleAware, false);
});

test('playerPeriodValue with null projection stays null (missing != 0)', () => {
  const r = playerPeriodValue({ projectedPerGame: null, teamAbbr: 'BOS', schedules: SCHEDULES, periodWindow: { startYmd: 20251103, endYmd: 20251109 } });
  assert.equal(r.periodProjectedPoints, null);
  assert.equal(r.scheduleAware, false);
});
