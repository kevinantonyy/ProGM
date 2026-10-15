import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RookieClass, classifyUnprojected, lastSeasonCutoff, yahooPlayerNumber } from './unprojectedClass.js';

test('Yahoo player numbers are read from keys and ids, and never invented', () => {
  assert.equal(yahooPlayerNumber({ playerKey: '466.p.6014' }), 6014);
  assert.equal(yahooPlayerNumber({ editorialPlayerKey: 'nba.p.10290' }), 10290);
  assert.equal(yahooPlayerNumber({ playerId: '777' }), 777);
  assert.equal(yahooPlayerNumber({ playerKey: 'weird' }), null);
  assert.equal(yahooPlayerNumber({}), null);
});

test('cutoff is the highest number among players with real stats only', () => {
  assert.equal(lastSeasonCutoff([{ playerNumber: 5, hasRealStats: true }, { playerNumber: 90, hasRealStats: true }, { playerNumber: 500, hasRealStats: false }]), 90);
  assert.equal(lastSeasonCutoff([{ playerNumber: 5, hasRealStats: false }]), null);
  assert.equal(lastSeasonCutoff([]), null);
});

test('only a healthy, unmatched player newer than every stat-bearing player is an incoming rookie', () => {
  const base = { playerNumber: 7000, cutoff: 6000, matched: false, status: null };
  assert.equal(classifyUnprojected(base).class, RookieClass.ROOKIE);
  assert.equal(classifyUnprojected({ ...base, playerNumber: 5000 }).class, RookieClass.EARLIER_PLAYER);   // veteran / injured veteran
  assert.equal(classifyUnprojected({ ...base, playerNumber: 6000 }).class, RookieClass.EARLIER_PLAYER);   // boundary is excluded
  assert.equal(classifyUnprojected({ ...base, status: 'INJ' }).class, RookieClass.NEW_ENTRANT_INJURED);
  for (const s of ['O', 'OUT', 'INJ', 'IL', 'NA', 'SUSP']) assert.equal(classifyUnprojected({ ...base, status: s }).class, RookieClass.NEW_ENTRANT_INJURED, s);
  for (const s of ['Q', 'GTD', 'DTD', 'q']) {                                                             // day-to-day tags do not block
    const v = classifyUnprojected({ ...base, status: s });
    assert.equal(v.class, RookieClass.ROOKIE, s); assert.match(v.statusNote, /day-to-day/);
  }
  assert.equal(classifyUnprojected({ ...base, status: 'Q', playerNumber: 5000 }).class, RookieClass.EARLIER_PLAYER); // a Q veteran is still never estimated
  assert.equal(classifyUnprojected({ ...base, matched: true }).class, RookieClass.UNKNOWN);              // provider knows him: do not guess
  assert.equal(classifyUnprojected({ ...base, playerNumber: null }).class, RookieClass.UNKNOWN);
  assert.equal(classifyUnprojected({ ...base, cutoff: null }).class, RookieClass.UNKNOWN);
  assert.equal(classifyUnprojected({ ...base, scoringGap: true }).class, RookieClass.SCORING_GAP);
});

test('missing projection or unmatched identity alone never produces a rookie', () => {
  // The same facts that describe a rookie also describe an injured veteran: only the player number separates them.
  const injuredVeteran = classifyUnprojected({ playerNumber: 3000, cutoff: 6000, matched: false, status: 'INJ' });
  assert.notEqual(injuredVeteran.class, RookieClass.ROOKIE);
  assert.match(injuredVeteran.reason, /veteran|earlier/i);
});
