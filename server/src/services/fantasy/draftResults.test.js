/**
 * Tests for live-draft helpers: pick extraction, new-pick detection, duplicate
 * prevention (refresh/reconnect), availability removal, draft-state lifecycle,
 * and per-team roster derivation. All pure — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDraftResults, dedupePicks, detectNewPicks, draftedPlayerKeys,
  removeDrafted, deriveDraftState, picksForTeam,
} from './draftResults.js';

// Build a Yahoo-shaped draftresults response from simple pick tuples.
function yahooDraft(picks) {
  const coll = { count: picks.length };
  picks.forEach((p, i) => {
    coll[String(i)] = { draft_result: { pick: p.pick, round: p.round, team_key: p.teamKey, player_key: p.playerKey } };
  });
  return { fantasy_content: { league: [{ league_key: '466.l.1' }, { draft_results: coll }] } };
}

test('extractDraftResults normalizes + sorts by pick, drops unassigned picks', () => {
  const resp = yahooDraft([
    { pick: 2, round: 1, teamKey: '466.l.1.t.2', playerKey: '466.p.20' },
    { pick: 1, round: 1, teamKey: '466.l.1.t.1', playerKey: '466.p.10' },
    { pick: 3, round: 1, teamKey: '466.l.1.t.3', playerKey: '' }, // not yet made
  ]);
  const picks = extractDraftResults(resp);
  assert.equal(picks.length, 2);
  assert.deepEqual(picks.map((p) => p.pick), [1, 2]);
  assert.equal(picks[0].playerKey, '466.p.10');
  assert.equal(picks[0].teamKey, '466.l.1.t.1');
});

test('extractDraftResults handles an empty/predraft board', () => {
  assert.deepEqual(extractDraftResults(yahooDraft([])), []);
  assert.deepEqual(extractDraftResults({}), []);
  assert.deepEqual(extractDraftResults(null), []);
});

test('dedupePicks collapses a player re-delivered on reconnect (lowest pick wins)', () => {
  const picks = [
    { pick: 5, round: 1, teamKey: 't1', playerKey: 'p.A' },
    { pick: 5, round: 1, teamKey: 't1', playerKey: 'p.A' }, // duplicate from refresh
    { pick: 6, round: 1, teamKey: 't2', playerKey: 'p.B' },
  ];
  const deduped = dedupePicks(picks);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((p) => p.playerKey), ['p.A', 'p.B']);
});

test('detectNewPicks returns only picks not already seen (idempotent across polls)', () => {
  const prev = [{ playerKey: 'p.A' }, { playerKey: 'p.B' }];
  const current = [
    { pick: 1, playerKey: 'p.A' }, { pick: 2, playerKey: 'p.B' }, { pick: 3, playerKey: 'p.C' },
  ];
  const { newPicks, totalPicks } = detectNewPicks(prev, current);
  assert.equal(totalPicks, 3);
  assert.deepEqual(newPicks.map((p) => p.playerKey), ['p.C']);
});

test('detectNewPicks produces NO duplicates when the same board is re-polled', () => {
  const current = [{ pick: 1, playerKey: 'p.A' }, { pick: 2, playerKey: 'p.B' }];
  const first = detectNewPicks([], current);
  assert.equal(first.newPicks.length, 2);
  // Second poll with the first result as "previous" => nothing new.
  const second = detectNewPicks(first.allPicks, current);
  assert.equal(second.newPicks.length, 0);
  assert.equal(second.totalPicks, 2);
});

test('removeDrafted strips drafted players from the available pool immediately', () => {
  const available = [
    { playerKey: 'p.A', name: 'A' }, { playerKey: 'p.B', name: 'B' }, { playerKey: 'p.C', name: 'C' },
  ];
  const drafted = draftedPlayerKeys([{ playerKey: 'p.A' }, { playerKey: 'p.C' }]);
  const remaining = removeDrafted(available, drafted);
  assert.deepEqual(remaining.map((p) => p.playerKey), ['p.B']);
  // No drafted set -> pool unchanged.
  assert.equal(removeDrafted(available, new Set()).length, 3);
});

test('deriveDraftState: predraft / live / complete', () => {
  assert.equal(deriveDraftState({ yahooDraftStatus: 'predraft', totalPicks: 0, expectedPicks: 120 }), 'predraft');
  assert.equal(deriveDraftState({ yahooDraftStatus: null, totalPicks: 0, expectedPicks: 120 }), 'predraft');
  assert.equal(deriveDraftState({ yahooDraftStatus: 'drafting', totalPicks: 10, expectedPicks: 120 }), 'live');
  assert.equal(deriveDraftState({ yahooDraftStatus: null, totalPicks: 5, expectedPicks: 120 }), 'live');
  assert.equal(deriveDraftState({ yahooDraftStatus: 'postdraft', totalPicks: 120, expectedPicks: 120 }), 'complete');
  // All slots filled implies complete even if Yahoo status lags.
  assert.equal(deriveDraftState({ yahooDraftStatus: 'drafting', totalPicks: 120, expectedPicks: 120 }), 'complete');
});

test('picksForTeam returns the drafting team\'s roster-so-far', () => {
  const picks = [
    { pick: 1, teamKey: 't1', playerKey: 'p.A' },
    { pick: 2, teamKey: 't2', playerKey: 'p.B' },
    { pick: 3, teamKey: 't1', playerKey: 'p.C' },
  ];
  const mine = picksForTeam(picks, 't1');
  assert.deepEqual(mine.map((p) => p.playerKey), ['p.A', 'p.C']);
});

test('full flow: extract -> detect -> remove drafted (no duplicates on re-sync)', () => {
  const board = yahooDraft([
    { pick: 1, round: 1, teamKey: 't1', playerKey: 'p.A' },
    { pick: 2, round: 1, teamKey: 't2', playerKey: 'p.B' },
  ]);
  const picks = extractDraftResults(board);
  const { allPicks } = detectNewPicks([], picks);
  const available = [{ playerKey: 'p.A' }, { playerKey: 'p.B' }, { playerKey: 'p.C' }];
  const remaining = removeDrafted(available, draftedPlayerKeys(allPicks));
  assert.deepEqual(remaining.map((p) => p.playerKey), ['p.C']);
  // Re-sync same board: still no new picks, pool identical.
  const resync = detectNewPicks(allPicks, extractDraftResults(board));
  assert.equal(resync.newPicks.length, 0);
});
