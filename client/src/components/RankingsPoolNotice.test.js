import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import RankingsPoolNotice from './RankingsPoolNotice.js';

const html = (props) => renderToStaticMarkup(createElement(RankingsPoolNotice, props));
const LIMITATION = 'This pool is every player Yahoo lists as available plus every player on every team in this league. It cannot prove that no other Yahoo-eligible player exists.';
const COMPLETE = { complete: true, reasons: [], warnings: [], limitations: [LIMITATION], counts: { total: 744, available: 594, rostered: 138, mine: 12, teamsExpected: 12, teamsLoaded: 12 } };

test('a verified pool states its counts AND its scope limitation (never a bare "complete")', () => {
  const out = html({ pool: COMPLETE, total: 744 });
  assert.match(out, /data-testid="rankings-pool-complete"/);
  assert.match(out, /Full league pool: 744 players \(594 available, 138 on other teams, 12 on your team\)/);
  assert.match(out, /Every team(&#x27;|')s roster loaded \(12 of 12\)/);
  assert.match(out, /cannot prove that no other Yahoo-eligible player exists/);
  assert.doesNotMatch(out, /role="alert"/);
  assert.doesNotMatch(out, /Partial player pool/);
});

test('a partial pool is an alert that says the ranks are NOT full-league and lists every reason', () => {
  const out = html({ pool: { ...COMPLETE, complete: false, reasons: ['The roster could not be loaded for Team Three; their players are missing.', '1 player appears on more than one team roster, so ownership is ambiguous.'] }, total: 700 });
  assert.match(out, /role="alert"/);
  assert.match(out, /data-testid="rankings-pool-partial"/);
  assert.match(out, /NOT full-league ranks/);
  assert.match(out, /Team Three/);
  assert.match(out, /more than one team roster/);
  assert.doesNotMatch(out, /Full league pool:/);
  assert.match(out, /cannot prove that no other Yahoo-eligible player exists/);
});

test('warnings are shown even for a verified pool; an incomplete pool with no reasons still says so', () => {
  const out = html({ pool: { ...COMPLETE, warnings: ['1 player was listed as available and on a roster (the league changed while loading); treated as rostered.'] }, total: 744 });
  assert.match(out, /data-testid="rankings-pool-warnings"/);
  assert.match(out, /league changed while loading/);
  const noReasons = html({ pool: { complete: false }, total: 5 });
  assert.match(noReasons, /No completeness information was returned/);
  assert.match(noReasons, /NOT full-league ranks/);
});

test('flag off (no pool object): nothing is rendered', () => {
  assert.equal(html({ pool: undefined, total: 5 }), '');
  assert.equal(html({ pool: null, total: 5 }), '');
});
