import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';

const settings = {
  rosterSlots: [
    { position: 'PG', count: 1, isStarting: true },
    { position: 'SG', count: 1, isStarting: true },
    { position: 'C', count: 1, isStarting: true },
    { position: 'BN', count: 3, isStarting: false },
  ],
};

function pl(key, elig, proj, { owned = 0, status = null } = {}) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: owned, status, _proj: proj };
}

function provider(players) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return { getProjection: (p) => (map.get(p.playerKey) != null ? { projectedPoints: map.get(p.playerKey), confidence: 0.8 } : null) };
}

test('ranks players by ProGM value descending with overall ranks', () => {
  const players = [pl('Low', ['PG'], 15), pl('High', ['C'], 40), pl('Mid', ['SG'], 25)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.available, true);
  assert.equal(res.board[0].name, 'High');
  assert.equal(res.board[0].overallRank, 1);
});

test('players without projection go to noData, never valued', () => {
  const players = [pl('Known', ['PG'], 20), pl('Unknown', ['PG'], null)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board.length, 1);
  assert.equal(res.noData.length, 1);
  assert.equal(res.noData[0].playerKey, 'Unknown');
  assert.equal(res.noData[0].value, null);
});

test('assigns tiers so a big value gap starts a new tier', () => {
  const players = [pl('A', ['C'], 50), pl('B', ['C'], 48), pl('C', ['C'], 20)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  const tiers = res.board.map((p) => p.tier);
  assert.ok(tiers[2] > tiers[0]); // the big drop to C bumps the tier
});

test('position filter narrows the board', () => {
  const players = [pl('Guard', ['PG'], 20), pl('Center', ['C'], 30)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players), position: 'C' });
  assert.equal(res.board.length, 1);
  assert.equal(res.board[0].name, 'Center');
});

test('degrades without projections to a plain player list', () => {
  const players = [pl('A', ['PG'], 20)];
  const res = buildDraftBoard({ players, settings, projectionProvider: null });
  assert.equal(res.available, false);
  assert.equal(res.noData.length, 1);
});

test('availability is a fact when known (available vs rostered), unknown otherwise', () => {
  const players = [pl('Free', ['PG'], 20), pl('Mine', ['C'], 30)];
  const availableKeys = new Set(['Free']);
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players), availabilityOf: (p) => availableKeys.has(p.playerKey) });
  assert.equal(res.availabilityKnown, true);
  const byName = Object.fromEntries(res.board.map((p) => [p.name, p]));
  assert.equal(byName.Free.availability, 'available');
  assert.equal(byName.Mine.availability, 'rostered');

  const res2 = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res2.availabilityKnown, false);
  assert.equal(res2.board[0].availability, 'unknown'); // never fabricated as available
});

test('roster fit flags thin-position players as a need', () => {
  const players = [pl('Center', ['C'], 25)];
  const analysis = { positions: { thinPositions: [{ position: 'C' }], overloadedPositions: [] } };
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players), rosterAnalysis: analysis });
  assert.equal(res.board[0].rosterFit, 'need');
});

test('confidence (data quality) is surfaced from the projection', () => {
  const players = [pl('A', ['PG'], 20)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board[0].confidence, 0.8);
});
