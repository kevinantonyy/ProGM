import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import DraftCompleted, { previewOpener } from './DraftCompleted.js';

const render = (props) => renderToStaticMarkup(createElement(DraftCompleted, { leagueName: 'Mock League', onOpenRoster: () => {}, ...props }));

test('workspace without the draftPreview capability (server flag off): no Draft Preview button, roster button unchanged', () => {
  for (const data of [{}, { draftPreview: undefined }, { draftPreview: { enabled: false } }, { draftPreview: true }, { draftPreview: { enabled: 'true' } }, null, undefined]) {
    const out = render({ onOpenPreview: previewOpener(data, () => {}) });
    assert.doesNotMatch(out, /Draft Preview/, JSON.stringify(data));
    assert.doesNotMatch(out, /draft-preview-button/);
    assert.match(out, /View My Roster/);
    assert.match(out, /Your League Has Finished Drafting!/);
  }
});

test('workspace with draftPreview.enabled === true: the Draft Preview button and read-only note appear next to View My Roster', () => {
  const out = render({ onOpenPreview: previewOpener({ draftPreview: { enabled: true } }, () => {}) });
  assert.match(out, /data-testid="draft-preview-button"[^>]*>Draft Preview</);
  assert.match(out, /View My Roster/);
  assert.match(out, /not a live draft/);
});

test('previewOpener hands back the handler only for an explicit enabled capability', () => {
  const open = () => {};
  assert.equal(previewOpener({ draftPreview: { enabled: true } }, open), open);
  assert.equal(previewOpener({ draftPreview: { enabled: false } }, open), undefined);
  assert.equal(previewOpener({}, open), undefined);
});
