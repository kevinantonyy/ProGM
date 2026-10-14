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

test('passes through Yahoo headshots and keeps missing images null', () => {
  const pictured = { ...pl('Pictured', ['PG'], 20), headshotUrl: 'https://example.test/player.png' };
  const missing = pl('Missing', ['C'], 10);
  const res = buildDraftBoard({ players: [pictured, missing], settings, projectionProvider: provider([pictured, missing]) });
  assert.equal(res.board.find((p) => p.playerKey === 'Pictured').image, pictured.headshotUrl);
  assert.equal(res.board.find((p) => p.playerKey === 'Missing').image, null);
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

test('season model ignores current-period game count', () => {
  // Giddey-like: lower per-game (30) but 4 games -> period total 120.
  // Jokic-like: higher per-game (55) but 2 games -> period total 110.
  // Old (period-total) model ranked the 4-game player first; new model must not.
  const players = [pl('FourGameGuy', ['PG'], 30), pl('TwoGameStar', ['C'], 55)];
  const period = { FourGameGuy: { total: 120, games: 4 }, TwoGameStar: { total: 110, games: 2 } };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithPeriod(players, period) });
  assert.equal(res.board[0].name, 'TwoGameStar');
  assert.ok(res.board[0].value > res.board[1].value);
  // Period total is still surfaced for display, but did not drive the ranking.
  assert.equal(res.board.find((p) => p.name === 'FourGameGuy').periodProjected, 120);
});

test('projected season total can rank a healthier lower-FPPG player first', () => {
  const players = [pl('PerGameStar', ['PG'], 50), pl('HealthyVolume', ['PG'], 40)];
  const history = {
    PerGameStar: [hh(2025, 10), hh(2024, 10), hh(2023, 10)],
    HealthyVolume: [hh(2025, 82), hh(2024, 82), hh(2023, 82)],
  };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history) });
  assert.equal(res.board[0].name, 'HealthyVolume');
  assert.ok(res.board[0].projectedSeasonPoints > res.board[1].projectedSeasonPoints);
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
  assert.ok(lo.components.confidenceFactor >= 0.9); // confidence stays secondary
});

test('temporary Yahoo OUT status alone does not become a season-long penalty', () => {
  const players = [pl('Healthy', ['PG'], 40), pl('Hurt', ['PG'], 40, { status: 'O' })];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  const healthy = res.board.find((p) => p.name === 'Healthy');
  const hurt = res.board.find((p) => p.name === 'Hurt');
  assert.equal(healthy.value, hurt.value);
  assert.equal(hurt.components.availabilityPenaltyAppliedAgain, false);
});

test('transient questionable status does not discount a season-long draft rank', () => {
  const players = [pl('Healthy', ['C'], 40), pl('Questionable', ['C'], 40, { status: 'Q' })];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board[0].value, res.board[1].value);
});

test('complete projected pool is not truncated at the old 150-player limit', () => {
  const players = Array.from({ length: 220 }, (_, i) => pl(`P${i}`, ['PG'], 300 - i));
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board.length, 220);
  assert.equal(res.totalEligible, 220);
  assert.equal(res.totalProjected, 220);
});

test('components are normalized so no single raw scale dominates (bounded 0..1)', () => {
  const players = [pl('A', ['C'], 50), pl('B', ['PG'], 30), pl('C', ['SG'], 10)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  for (const p of res.board) {
    assert.ok(p.components.production >= 0 && p.components.production <= 1);
    assert.ok(p.components.replacement >= 0 && p.components.replacement <= 1);
    assert.ok(p.components.scarcity >= 0 && p.components.scarcity <= 1);
  }
  // Weights are the documented blend (float-safe sum check).
  assert.ok(Math.abs(Object.values(DRAFT_WEIGHTS).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.equal(DRAFT_WEIGHTS.production, 0.70);
  assert.equal(DRAFT_WEIGHTS.replacement, 0.20);
});

test('draft scarcity reflects lineup demand relative to eligible player supply', () => {
  const league = { ...settings, teamCount: 10 };
  const players = [
    pl('CenterStar', ['C'], 40),
    ...Array.from({ length: 8 }, (_, i) => pl(`Guard${i}`, ['PG'], 20 + i)),
  ];
  const res = buildDraftBoard({ players, settings: league, projectionProvider: provider(players) });
  const center = res.board.find((p) => p.name === 'CenterStar');
  const guard = res.board.find((p) => p.name === 'Guard7');
  assert.ok(center.components.scarcity > guard.components.scarcity);
});

test('roster fit remains secondary and cannot overwhelm a large production gap', () => {
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
    { seasonPoints: 4000, eligiblePositions: ['C'] },
    { seasonPoints: 1600, eligiblePositions: ['C'] },
    { seasonPoints: 800, eligiblePositions: ['C'] },
  ];
  const { baselineByPos, spread } = computeReplacementBaselines(rows, settings);
  assert.ok(baselineByPos.C != null);
  assert.ok(spread > 0);
  // The elite C clears the baseline => high replacement component.
  const elite = computeDraftValue({ seasonPoints: 4000, perGame: 50, expectedGames: 80, confidence: 0.9, eligiblePositions: ['C'], weights: {}, poolMaxSeasonPoints: 4000, replacement: { baselineByPos, spread } });
  assert.ok(elite.components.replacement > 0.5);
});

test('explainability includes season volume and confirms availability is applied once', () => {
  const players = [pl('A', ['PG'], 25)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  const c = res.board[0].components;
  for (const k of ['perGame', 'expectedGames', 'seasonPoints', 'production', 'replacement', 'scarcity', 'confidence', 'rosterFit', 'availability', 'availabilityPenaltyAppliedAgain', 'rawScore']) {
    assert.ok(k in c, `missing component ${k}`);
  }
  assert.equal(c.availabilityPenaltyAppliedAgain, false);
});

// --- Historical durability adjustment ---------------------------------------

// Provider that also attaches per-player historical availability.
function providerWithHistory(players, historyByKey, injuryByKey = {}) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return {
    getProjection: (p) => (map.get(p.playerKey) != null
      ? { projectedPoints: map.get(p.playerKey), confidence: 0.8, history: historyByKey[p.playerKey] || null, injury: injuryByKey[p.playerKey] || null }
      : null),
  };
}
const hh = (season, gp, total = 82) => ({ season, gamesPlayed: gp, gameTotal: total });

test('same FPPG + lower historical availability => fewer games and lower season value', () => {
  const players = [pl('Durable', ['PG'], 40), pl('Fragile', ['PG'], 40)];
  const history = {
    Durable: [hh(2024, 80), hh(2023, 78), hh(2022, 82)],  // ~0.97 availability
    Fragile: [hh(2024, 40), hh(2023, 35), hh(2022, 50)],  // ~0.50 availability
  };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history) });
  const durable = res.board.find((p) => p.name === 'Durable');
  const fragile = res.board.find((p) => p.name === 'Fragile');
  assert.ok(durable.value > fragile.value); // lower availability ranks lower
  assert.ok(durable.expectedSeasonGames > fragile.expectedSeasonGames);
  assert.equal(durable.projectedSeasonPoints, Number((40 * durable.expectedSeasonGames).toFixed(1)));
  assert.equal(fragile.projectedSeasonPoints, Number((40 * fragile.expectedSeasonGames).toFixed(1)));
  assert.equal(fragile.components.availabilityPenaltyAppliedAgain, false);
});

test('one-season rookie history regresses toward the pool baseline rather than zero', () => {
  const players = [pl('Veteran', ['PG'], 40), pl('Rookie', ['PG'], 40)];
  const history = {
    Veteran: [hh(2024, 70), hh(2023, 70), hh(2022, 70)],
    Rookie: [hh(2024, 20)],
  };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history) });
  const rookie = res.board.find((p) => p.name === 'Rookie');
  assert.equal(rookie.availabilityModel.seasonsObserved, 1);
  assert.ok(rookie.availabilityModel.recentDataWeight < 0.6);
  assert.ok(rookie.expectedSeasonGames > 20);
  assert.ok(rookie.expectedSeasonGames < 70);
});

test('missing history uses the league baseline, never zero games', () => {
  const players = [pl('NoHistory', ['PG'], 40)];
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board[0].expectedSeasonGames, 69.7);
  assert.equal(res.board[0].availabilityModel.seasonsObserved, 0);
  assert.equal(res.board[0].availabilityModel.recentDataWeight, 0);
});

test('verified season-ending injury caps expected games without a second penalty', () => {
  const players = [pl('HurtButDurable', ['PG'], 40, { status: 'O' })];
  const history = { HurtButDurable: [hh(2024, 82), hh(2023, 80), hh(2022, 81)] };
  const injuries = { HurtButDurable: { designation: 'Out', description: 'Will miss the rest of the season' } };
  const row = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history, injuries) }).board[0];
  assert.equal(row.expectedSeasonGames, 0);
  assert.equal(row.projectedSeasonPoints, 0);
  assert.equal(row.components.availabilityPenaltyAppliedAgain, false);
  assert.match(row.recommendation, /verified injury report/i);
});

// --- Yahoo ADP market context -----------------------------------------------

function providerPlain(players) {
  const map = new Map(players.map((p) => [p.playerKey, p._proj]));
  return { getProjection: (p) => (map.get(p.playerKey) != null ? { projectedPoints: map.get(p.playerKey), confidence: 0.8 } : null) };
}
// Players carry Yahoo ADP fields (as normalize.js would produce them).
function plAdp(key, elig, proj, adp) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: 0, status: null, _proj: proj, yahooAdp: adp };
}

test('ADP fields + market label are exposed per board row', () => {
  const players = [plAdp('A', ['PG'], 40, 15), plAdp('B', ['C'], 30, 40)];
  // B: ProGM ~#2 but ADP 40 => big VALUE lean.
  const res = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players) });
  const b = res.board.find((p) => p.name === 'B');
  assert.equal(b.yahooAdp, 40);
  assert.ok('adpVsProgm' in b);
  assert.ok('marketLabel' in b);
  assert.ok('marketReason' in b);
  assert.equal(b.marketLabel, 'VALUE'); // ADP much later than ProGM rank
});

test('Yahoo ADP does NOT reorder the ProGM Best Available board', () => {
  // A has higher production (ranks #1) but a LATE ADP; B lower production, early ADP.
  const players = [plAdp('A', ['PG'], 45, 60), plAdp('B', ['SG'], 20, 1)];
  const withAdp = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players) });
  const noAdp = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  // Same ProGM order regardless of ADP — ADP is context only.
  assert.deepEqual(withAdp.board.map((p) => p.name), noAdp.board.map((p) => p.name));
  assert.equal(withAdp.board[0].name, 'A');
});

test('missing ADP yields a neutral market label (null-safe, never 0)', () => {
  const players = [pl('NoAdp', ['PG'], 30)]; // pl() has no yahooAdp
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board[0].yahooAdp, null);
  assert.equal(res.board[0].marketLabel, 'neutral');
  assert.equal(res.board[0].adpVsProgm, null);
});

test('DRAFT NOW/WAIT only appear when a next pick is supplied', () => {
  // Strong value: ProGM #1, ADP 13. currentPick 10.
  const players = [plAdp('Star', ['PG'], 50, 13), plAdp('Filler', ['SG'], 10, 90)];
  const withoutNext = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players), currentPick: 10 });
  const star1 = withoutNext.board.find((p) => p.name === 'Star');
  assert.ok(star1.marketLabel !== 'DRAFT NOW' && star1.marketLabel !== 'WAIT'); // omitted w/o nextPick
  const withNext = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players), currentPick: 10, nextPick: 24 });
  const star2 = withNext.board.find((p) => p.name === 'Star');
  assert.equal(star2.marketLabel, 'DRAFT NOW'); // strong value + won't survive to #24
});

// --- Yahoo Rank (external signal) -------------------------------------------

function plRank(key, elig, proj, yahooRanks) {
  return { playerKey: key, name: key, teamAbbr: 'BOS', eligiblePositions: elig, percentOwned: 0, status: null, _proj: proj, yahooRanks };
}

test('Yahoo Rank (overall + current-season S) is exposed per board row', () => {
  const players = [plRank('A', ['PG'], 40, { overall: 5, bySeason: { 2025: 8, 2024: 5 } })];
  const res = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players), currentSeason: 2025 });
  const row = res.board[0];
  assert.equal(row.yahooOverallRank, 5);
  assert.equal(row.yahooSeasonRank, 8); // current season (2025) S rank
  assert.deepEqual(row.yahooPriorSeasonRanks, [{ season: '2024', rank: 5 }]);
});

test('human recommendation uses available-player comparison, roster need, and verified last-season data', () => {
  const players = [
    { ...plRank('Star', ['PG'], 50, { overall: 3, bySeason: { 2026: 3, 2025: 2 } }), yahooAdp: 3.4 },
    plRank('Other', ['C'], 30, { overall: 20, bySeason: { 2026: 18, 2025: 22 } }),
  ];
  const projections = new Map([
    ['Star', { projectedPoints: 50, confidence: 0.9, lastSeason: { season: 2025, stats: { points: 28.2, rebounds: 8.1, assists: 7.4, gamesPlayed: 65 } }, lastSeasonFantasy: { points: 61.7, complete: true, missingCategories: [], breakdown: [] } }],
    ['Other', { projectedPoints: 30, confidence: 0.8 }],
  ]);
  const res = buildDraftBoard({
    players,
    settings,
    projectionProvider: { getProjection: (p) => projections.get(p.playerKey) || null },
    rosterAnalysis: { positions: { thinPositions: [{ position: 'PG' }], overloadedPositions: [] } },
    availabilityOf: () => true,
    currentSeason: 2026,
  });
  const star = res.board.find((p) => p.name === 'Star');
  assert.equal(star.lastSeasonYahooRank, 2);
  assert.equal(star.yahooSeasonRank, 3); // current rank remains distinct
  assert.deepEqual(star.lastSeasonNba, { season: 2025, points: 28.2, rebounds: 8.1, assists: 7.4, gamesPlayed: 65 });
  assert.equal(star.lastSeasonFantasy.points, 61.7);
  assert.equal(star.lastSeasonFantasy.season, 2025);
  assert.match(star.recommendation, /highest projected regular-season fantasy-point total among 2 available players/i);
  assert.match(star.recommendation, /fills a roster need at PG/i);
  assert.match(star.recommendation, /28.2 NBA points, 8.1 rebounds, and 7.4 assists/i);
});

test('recommendation never presents a rostered player as available', () => {
  const players = [plRank('Rostered Star', ['PG'], 50, { overall: 3, bySeason: { 2026: 3 } })];
  const row = buildDraftBoard({
    players,
    settings,
    projectionProvider: providerPlain(players),
    availabilityOf: () => false,
    currentSeason: 2026,
  }).board[0];
  assert.match(row.recommendation, /already rostered/i);
  assert.doesNotMatch(row.recommendation, /highest projected.*available/i);
});

test('season rank is null when Yahoo has no rank for the current league season', () => {
  const players = [plRank('A', ['PG'], 40, { overall: 5, bySeason: { 2024: 8 } })];
  const row = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players), currentSeason: 2025 }).board[0];
  assert.equal(row.yahooSeasonRank, null);
  assert.deepEqual(row.yahooPriorSeasonRanks, [{ season: '2024', rank: 8 }]);
});

test('rank comparison is attached (ProGM rank vs Yahoo overall)', () => {
  // Two players; A clearly #1 by ProGM but Yahoo ranks him #40 => ProGM higher.
  const players = [plRank('A', ['PG'], 45, { overall: 40, bySeason: {} }), plRank('B', ['SG'], 20, { overall: 2, bySeason: {} })];
  const res = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players) });
  const a = res.board.find((p) => p.name === 'A');
  assert.equal(a.overallRank, 1);
  assert.equal(a.yahooOverallRank, 40);
  assert.equal(a.rankGap, 39); // 40 - 1
  assert.equal(a.rankAgreement, 'progm_higher');
  assert.ok('rankReason' in a);
});

test('Yahoo Rank NEVER reorders the ProGM Best Available board', () => {
  // A: higher production (ProGM #1) but WORSE Yahoo rank; B: lower production, elite Yahoo rank.
  const players = [plRank('A', ['PG'], 45, { overall: 120, bySeason: {} }), plRank('B', ['SG'], 20, { overall: 1, bySeason: {} })];
  const withRanks = buildDraftBoard({ players, settings, projectionProvider: providerPlain(players) });
  const noRanks = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.deepEqual(withRanks.board.map((p) => p.name), noRanks.board.map((p) => p.name));
  assert.equal(withRanks.board[0].name, 'A'); // ProGM value leads, not Yahoo rank
});

test('missing Yahoo Rank yields null fields + unknown agreement (null-safe)', () => {
  const players = [pl('NoRank', ['PG'], 30)]; // pl() has no yahooRanks
  const res = buildDraftBoard({ players, settings, projectionProvider: provider(players) });
  assert.equal(res.board[0].yahooOverallRank, null);
  assert.equal(res.board[0].yahooSeasonRank, null);
  assert.equal(res.board[0].rankGap, null);
  assert.equal(res.board[0].rankAgreement, 'unknown');
});

test('elite FPPG can remain first when its availability-adjusted season total is still higher', () => {
  const players = [pl('EliteFragile', ['SG'], 60), pl('MedDurableScarce', ['C'], 25)];
  const history = {
    EliteFragile: [hh(2024, 40), hh(2023, 30), hh(2022, 35)], // low availability
    MedDurableScarce: [hh(2024, 82), hh(2023, 82), hh(2022, 82)], // perfect
  };
  const res = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history) });
  assert.equal(res.board[0].name, 'EliteFragile');
  assert.ok(res.board[0].expectedSeasonGames < res.board[1].expectedSeasonGames);
  assert.ok(res.board[0].projectedSeasonPoints > res.board[1].projectedSeasonPoints);
});

test('Jokic, Wembanyama, Embiid, and a healthy mid-tier player rank consistently with season totals', () => {
  const players = [
    pl('Jokic', ['C'], 124.73),
    pl('Wembanyama', ['C'], 105.82),
    pl('Embiid', ['C'], 93.2),
    pl('HealthyMid', ['C'], 70),
  ];
  const history = {
    Jokic: [hh(2025, 65), hh(2024, 70), hh(2023, 79)],
    Wembanyama: [hh(2025, 64), hh(2024, 46), hh(2023, 71)],
    Embiid: [hh(2025, 38), hh(2024, 19), hh(2023, 39)],
    HealthyMid: [hh(2025, 78), hh(2024, 78), hh(2023, 78)],
  };
  const board = buildDraftBoard({ players, settings, projectionProvider: providerWithHistory(players, history) }).board;
  assert.equal(board[0].name, 'Jokic');
  for (const player of board) {
    assert.equal(player.projectedSeasonPoints, Number((player.projected * player.expectedSeasonGames).toFixed(1)));
    assert.equal(player.components.availabilityPenaltyAppliedAgain, false);
  }
  for (let i = 1; i < board.length; i += 1) assert.ok(board[i - 1].projectedSeasonPoints >= board[i].projectedSeasonPoints);
});
