import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard, computeDraftValue, computeReplacementBaselines, DRAFT_WEIGHTS } from './draftHelper.js';

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

// --- Draft-value model: per-game anchoring, normalization, penalties --------

// Provider that ALSO reports a schedule-aware period total (games-in-window).
// Draft value must ignore the period total and rank on per-game production.
function providerWithPeriod(players, periodByKey) {
  const base = provider(players);
  return {
    ...base,
    getPeriodValue: (p) => {
      const pp = periodByKey[p.playerKey];
      return pp ? { scheduleAware: true, periodProjectedPoints: pp.total, expectedGames: pp.games } : null;
    },
  };
}

test('PER-GAME anchored: a player on a 4-game week does NOT outrank a better per-game star on a 2-game week', () => {
  // Giddey-like: lower per-game (30) but 4 games -> period total 120.
  // Jokic-like: higher per-game (55) but 2 games -> period total 110.
  // Old (period-total) model ranked the 4-game player first; new model must not.
  const players = [pl('FourGameGuy', ['PG'], 30), pl('TwoGameStar', ['C'], 55)];
  const period = { FourGameGuy: { total: 120, games: 4 }, TwoGameStar: { total: 110, games: 2 } };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithPeriod(players, period) });
  assert.equal(res.board[0].name, 'TwoGameStar'); // higher per-game wins draft value
  assert.ok(res.board[0].value > res.board[1].value);
  // Period total is still surfaced for display, but did not drive the ranking.
  assert.equal(res.board.find((p) => p.name === 'FourGameGuy').periodProjected, 120);
});

test('missing-data confidence is penalized (not zeroed) and ranks below equal-production high-confidence', () => {
  const players = [pl('HighConf', ['PG'], 40), pl('LowConf', ['PG'], 40)];
  const map = new Map([['HighConf', { projectedPoints: 40, confidence: 0.9 }], ['LowConf', { projectedPoints: 40, confidence: 0.1 }]]);
  const prov = { getProjection: (p) => map.get(p.playerKey) || null };
  const res = buildDraftBoard({ players, settings, projectionProvider: prov });
  const hi = res.board.find((p) => p.name === 'HighConf');
  const lo = res.board.find((p) => p.name === 'LowConf');
  assert.ok(hi.value > lo.value);          // confidence penalty applies
  assert.ok(lo.value > 0);                  // but low confidence is NOT treated as zero
  assert.ok(lo.components.confidenceFactor >= 0.6); // floor keeps >=60%
});

test('injury status applies an availability multiplier to draft value', () => {
  const players = [pl('Healthy', ['PG'], 40), pl('Hurt', ['PG'], 40, { status: 'O' })];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  const healthy = res.board.find((p) => p.name === 'Healthy');
  const hurt = res.board.find((p) => p.name === 'Hurt');
  assert.ok(healthy.value > hurt.value);
  assert.equal(hurt.components.healthMult, 0.5);
});

test('components are normalized so no single raw scale dominates (bounded 0..1)', () => {
  const players = [pl('A', ['C'], 50), pl('B', ['PG'], 30), pl('C', ['SG'], 10)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  for (const p of res.board) {
    assert.ok(p.components.production >= 0 && p.components.production <= 1);
    assert.ok(p.components.replacement >= 0 && p.components.replacement <= 1);
    assert.ok(p.components.scarcity >= 0 && p.components.scarcity <= 1);
  }
  // Weights are the documented blend.
  assert.equal(DRAFT_WEIGHTS.production + DRAFT_WEIGHTS.replacement + DRAFT_WEIGHTS.scarcity, 1);
});

test('roster fit does NOT reorder the global Best Available board', () => {
  const players = [pl('BigValue', ['SG'], 45), pl('ThinPosFit', ['C'], 30)];
  // C is thin on my roster; fit should NOT lift the lower-value C above the SG.
  const analysis = { positions: { thinPositions: [{ position: 'C' }], overloadedPositions: [{ position: 'SG' }] } };
  const withFit = buildDraftBoard({ players, settings, projectionProvider: provider(players), rosterAnalysis: analysis });
  const withoutFit = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.deepEqual(withFit.board.map((p) => p.name), withoutFit.board.map((p) => p.name));
  assert.equal(withFit.board[0].name, 'BigValue'); // value, not fit, leads
  // Fit is still annotated for the Best Fit view.
  assert.equal(withFit.board.find((p) => p.name === 'ThinPosFit').rosterFit, 'need');
});

test('computeReplacementBaselines rewards value above the positional replacement bar', () => {
  const rows = [
    { perGame: 50, eligiblePositions: ['C'] },
    { perGame: 20, eligiblePositions: ['C'] },
    { perGame: 10, eligiblePositions: ['C'] },
  ];
  const { baselineByPos, spread } = computeReplacementBaselines(rows, settings);
  assert.ok(baselineByPos.C != null);
  assert.ok(spread > 0);
  // The elite C clears the baseline => high replacement component.
  const elite = computeDraftValue({ perGame: 50, confidence: 0.9, status: null, eligiblePositions: ['C'], weights: {}, poolMaxPerGame: 50, replacement: { baselineByPos, spread } });
  assert.ok(elite.components.replacement > 0.5);
});

test('explainability: every board row carries component scores + perGame', () => {
  const players = [pl('A', ['PG'], 25)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  const c = res.board[0].components;
  for (const k of ['perGame', 'production', 'replacement', 'scarcity', 'confidence', 'healthMult', 'rawScore']) {
    assert.ok(k in c, `missing component ${k}`);
  }
});
