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

test('non-blocking warnings (e.g. missing ADP pages) are shown even when the pool is verified', () => {
  const out = html({ complete: true, reasons: [], warnings: ['Some Yahoo ADP or rank pages could not be loaded.'], counts: { total: 3, taken: 2, available: 1 } });
  assert.match(out, /Full player pool verified/);
  assert.match(out, /data-testid="preview-warnings"/);
  assert.match(out, /ADP or rank pages/);
  assert.doesNotMatch(html({ complete: true, reasons: [], warnings: [], counts: null }), /preview-warnings/);
});

test('zero projections: a clear alert with the reason, shown even when the Yahoo pool is verified', () => {
  const out = renderToStaticMarkup(createElement(DraftPreviewBanner, {
    completeness: { complete: true, reasons: [], counts: { total: 743, taken: 150, available: 593 } },
    projection: { externalAvailable: true, projectedCount: 0, totalPlayers: 743, reason: 'NBA stats from ESPN are unavailable: Unrecognized or empty ESPN player directory feed' },
  }));
  assert.match(out, /data-testid="preview-no-projections"/);
  assert.match(out, /none of the 743 players received a projection/);
  assert.match(out, /Unrecognized or empty ESPN player directory feed/);
  assert.match(out, /not a problem with Yahoo or your league settings/);
  assert.match(out, /Full player pool verified/, 'the pool verdict is independent of the projection verdict');
});

test('projections present, or no projection info at all: no zero-projection alert', () => {
  const completeness = { complete: true, reasons: [], counts: { total: 3, taken: 2, available: 1 } };
  for (const projection of [{ externalAvailable: true, projectedCount: 120, totalPlayers: 743, reason: null }, undefined, null]) {
    assert.doesNotMatch(renderToStaticMarkup(createElement(DraftPreviewBanner, { completeness, projection })), /preview-no-projections/);
  }
});
