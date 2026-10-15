import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import EstimateBadge from '../components/EstimateBadge.js';
import { ESTIMATE_LABEL, ESTIMATE_TOOLTIP, isEstimated } from './estimateBadge.js';

const html = (player) => renderToStaticMarkup(createElement(EstimateBadge, { player }));

test('only an explicit estimate:true shows the badge', () => {
  assert.equal(isEstimated({ estimate: true }), true);
  for (const p of [{}, { estimate: false }, { estimate: 'true' }, { estimate: 1 }, null, undefined, { projectionMethod: 'market_prior_estimate' }]) {
    assert.equal(isEstimated(p), false);
    assert.equal(html(p), '');
  }
});

test('badge text and tooltip say: Yahoo ADP, low confidence, not an independent projection', () => {
  const out = html({ estimate: true });
  assert.ok(out.includes(`>${ESTIMATE_LABEL}<`));
  assert.ok(out.includes('data-testid="estimate-badge"'));
  assert.match(ESTIMATE_TOOLTIP, /Yahoo ADP/);
  assert.match(ESTIMATE_TOOLTIP, /Low confidence/);
  assert.match(ESTIMATE_TOOLTIP, /not an independent statistical projection/);
  assert.ok(ESTIMATE_TOOLTIP.length < 220); // short
});

test('the same player data gives the same badge in both tabs (Draft Helper and Rankings share the helper)', () => {
  const boardRow = { playerKey: 'p1', name: 'R', estimate: true };
  const rankingsRow = { playerKey: 'p1', name: 'R', estimate: true };
  const normal = { playerKey: 'p2', name: 'V', estimate: false };
  assert.equal(html(boardRow), html(rankingsRow));
  assert.equal(html(normal), '');
});
