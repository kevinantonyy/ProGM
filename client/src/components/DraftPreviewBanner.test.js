import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import DraftPreviewBanner, { PREVIEW_DISCLAIMER } from './DraftPreviewBanner.js';

const html = (completeness) => renderToStaticMarkup(createElement(DraftPreviewBanner, { completeness }));

test('a verified pool says so and is always labelled as a preview, not a live draft', () => {
  const out = html({ complete: true, reasons: [], counts: { total: 90, taken: 60, available: 30 } });
  assert.match(out, /not a live draft/);
  assert.ok(out.includes(PREVIEW_DISCLAIMER.replace(/'/g, '&#x27;')));
  assert.match(out, /Full player pool verified: 90 players/);
  assert.doesNotMatch(out, /NOT full-pool rankings/);
  assert.doesNotMatch(out, /role="alert"/);
});

test('an unverified pool shows an alert with every reason and never claims full-pool ranks', () => {
  const out = html({ complete: false, reasons: ['1 drafted player is missing from the player pool.', 'Yahoo returned no taken players.'], counts: null });
  assert.match(out, /role="alert"/);
  assert.match(out, /NOT full-pool rankings/);
  assert.match(out, /1 drafted player is missing/);
  assert.match(out, /Yahoo returned no taken players/);
  assert.doesNotMatch(out, /Full player pool verified/);
  assert.doesNotMatch(out, /Ranks are full-pool ranks/);
});

test('missing or malformed completeness data is treated as unverified', () => {
  for (const value of [undefined, null, {}, { complete: 'true' }]) {
    const out = html(value);
    assert.match(out, /NOT full-pool rankings/);
    assert.doesNotMatch(out, /Full player pool verified/);
  }
});
