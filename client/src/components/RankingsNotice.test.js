import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import RankingsNotice from './RankingsNotice.js';

const html = (props) => renderToStaticMarkup(createElement(RankingsNotice, props));

test('no player projected: an alert shows the exact reason (e.g. the unsupported scoring stats)', () => {
  const out = html({ players: [{ projected: null }, { projected: null }], reason: 'Your league scores FGA, FTA, which ProGM cannot get from its free NBA data, so no player could be projected.' });
  assert.match(out, /data-testid="rankings-no-projections"/);
  assert.match(out, /role="alert"/);
  assert.match(out, /No player has a projection/);
  assert.match(out, /Your league scores FGA, FTA/);
});

test('no player projected and no reason supplied: a generic but honest fallback', () => {
  assert.match(html({ players: [{ projected: null }], reason: null }), /data needed for projections is unavailable/);
});

test('any projected player, an empty list, or bad input: no notice', () => {
  assert.equal(html({ players: [{ projected: null }, { projected: 31.2 }], reason: 'x' }), '');
  assert.equal(html({ players: [{ projected: 0 }], reason: 'x' }), '', 'a real 0 is a projection, not a gap');
  assert.equal(html({ players: [], reason: 'x' }), '');
  assert.equal(html({ players: undefined, reason: 'x' }), '');
});
