import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStatLine, scoringIsSupported, YAHOO_STAT_TO_STATLINE } from './scoring.js';
import { emptyStatLine } from '../providers/types.js';

// Real weights from the connected league (Fantasy BBall points league).
const LEAGUE_CATS = [
  { statId: 4, abbr: 'FGM', pointValue: 1, enabled: true },
  { statId: 7, abbr: 'FTM', pointValue: 1, enabled: true },
  { statId: 10, abbr: '3PTM', pointValue: 2, enabled: true },
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 13, abbr: 'OREB', pointValue: 1.5, enabled: true },
  { statId: 14, abbr: 'DREB', pointValue: 1.2, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true },
  { statId: 17, abbr: 'ST', pointValue: 3, enabled: true },
  { statId: 18, abbr: 'BLK', pointValue: 3, enabled: true },
  { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
  { statId: 27, abbr: 'DD', pointValue: 3, enabled: true },
  { statId: 28, abbr: 'TD', pointValue: 5, enabled: true },
];

function line(overrides) {
  return { ...emptyStatLine(), ...overrides };
}

test('scoreStatLine applies league weights dynamically', () => {
  const statLine = line({
    points: 20, threesMade: 2, fgMade: 8, ftMade: 2,
    rebounds: 10, offRebounds: 3, defRebounds: 7,
    assists: 5, steals: 1.5, blocks: 1, turnovers: 3,
  });
  const res = scoreStatLine(statLine, LEAGUE_CATS);
  // Expected: PTS 20*1=20, 3PTM 2*2=4, FGM 8*1=8, FTM 2*1=2, REB 10*1=10,
  // OREB 3*1.5=4.5, DREB 7*1.2=8.4, AST 5*1.5=7.5, ST 1.5*3=4.5, BLK 1*3=3, TO 3*-1=-3
  // DD/TD unsupported. Sum = 20+4+8+2+10+4.5+8.4+7.5+4.5+3-3 = 68.9
  assert.equal(res.points, 68.9);
  assert.ok(res.supported);
  assert.deepEqual(res.unsupportedStats.sort(), ['DD', 'TD']);
});

test('scoreStatLine breakdown is sorted by absolute contribution', () => {
  const res = scoreStatLine(line({ points: 30, steals: 0.1, turnovers: 5 }), LEAGUE_CATS);
  assert.equal(res.breakdown[0].abbr, 'PTS'); // 30 is the biggest contributor
});

test('scoreStatLine reports weighted-but-missing stats as unsupported, not zero', () => {
  const statLine = line({ points: 10 }); // only points present
  const res = scoreStatLine(statLine, LEAGUE_CATS);
  assert.equal(res.points, 10);
  // Every other weighted stat should be flagged unsupported (value was null).
  assert.ok(res.unsupportedStats.includes('AST'));
  assert.ok(res.unsupportedStats.includes('REB'));
});

test('scoreStatLine handles negative weights (turnovers)', () => {
  const res = scoreStatLine(line({ turnovers: 4 }), [{ statId: 19, abbr: 'TO', pointValue: -1, enabled: true }]);
  assert.equal(res.points, -4);
});

test('scoreStatLine returns null points when nothing scorable', () => {
  const res = scoreStatLine(emptyStatLine(), LEAGUE_CATS);
  assert.equal(res.points, null);
  assert.equal(res.supported, false);
});

test('scoreStatLine ignores categories without a point value (category league)', () => {
  const catLeague = [{ statId: 12, abbr: 'PTS', pointValue: null, enabled: true }];
  const res = scoreStatLine(line({ points: 20 }), catLeague);
  assert.equal(res.points, null);
});

test('scoringIsSupported true for points league with mappable weighted stats', () => {
  assert.equal(scoringIsSupported({ scoringFormat: 'points', statCategories: LEAGUE_CATS }), true);
  assert.equal(scoringIsSupported({ scoringFormat: 'category', statCategories: LEAGUE_CATS }), false);
  assert.equal(scoringIsSupported({ scoringFormat: 'points', statCategories: [{ statId: 27, pointValue: 3, enabled: true }] }), true);
});

test('stat map covers the core Yahoo NBA counting stats', () => {
  assert.equal(YAHOO_STAT_TO_STATLINE[12], 'points');
  assert.equal(YAHOO_STAT_TO_STATLINE[16], 'assists');
  assert.equal(YAHOO_STAT_TO_STATLINE[17], 'steals');
  assert.equal(YAHOO_STAT_TO_STATLINE[21], 'personalFouls');
});
