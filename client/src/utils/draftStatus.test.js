import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDraftCompleted, resolveDraftPhase } from './draftStatus.js';
import { shouldStopDraftPolling } from './draftPolling.js';

test('pre-draft, active, completed and unknown states resolve from Yahoo draft_status only', () => {
  assert.equal(resolveDraftPhase({ yahooDraftStatus: 'predraft' }), 'predraft');
  assert.equal(resolveDraftPhase({ yahooDraftStatus: 'drafting' }), 'active');
  assert.equal(resolveDraftPhase({ yahooDraftStatus: 'postdraft' }), 'completed');
  assert.equal(resolveDraftPhase({ yahooDraftStatus: ' PostDraft ' }), 'completed'); // tolerant of case and whitespace
  for (const unknown of [undefined, null, '', 'unknown', 'complete', 'done', 0, {}, [], 'postdraft2']) {
    assert.equal(resolveDraftPhase({ yahooDraftStatus: unknown }), 'unknown', String(unknown));
  }
  assert.equal(resolveDraftPhase(), 'unknown');
  assert.equal(resolveDraftPhase({}), 'unknown');
});

test('completion is never inferred from dates, empty pools or pick counts', () => {
  const hints = {
    draftTime: '2020-01-01T00:00:00Z', // long in the past
    availablePlayers: [], // empty pool
    totalPicks: 156, expectedPicks: 156, // all picks made
    draftState: 'complete', // heuristic state from the live sync
  };
  assert.equal(isDraftCompleted({ ...hints }), false); // no draft_status -> unknown
  assert.equal(isDraftCompleted({ ...hints, yahooDraftStatus: 'drafting' }), false);
  assert.equal(isDraftCompleted({ ...hints, yahooDraftStatus: 'predraft' }), false);
  assert.equal(isDraftCompleted({ yahooDraftStatus: 'postdraft' }), true);
});

test('the completed screen adds no polling: completed and pre-draft already stop the sync', () => {
  assert.equal(shouldStopDraftPolling('complete'), true);
  assert.equal(shouldStopDraftPolling('predraft'), true);
  assert.equal(shouldStopDraftPolling('live'), false);
});
