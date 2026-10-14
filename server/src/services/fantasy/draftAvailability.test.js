import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateExpectedGames } from './durability.js';
import { buildDraftBoard, describeRankingFactors } from './draftHelper.js';
import { projectPlayer } from './projection.js';
import { emptyStatLine } from '../providers/types.js';

// Synthetic histories only; they model shapes (isolated / recurring / recent), not real players.
const season = (s, gp, total = 82) => ({ season: s, gamesPlayed: gp, gameTotal: total });
const ctx = { baselineContext: { rate: 0.85 }, targetSeason: 2026 };

test('an old isolated injury season costs far less than before and less than a recent one', () => {
  const healthy = estimateExpectedGames([season(2025, 70), season(2024, 70), season(2023, 62), season(2022, 70), season(2021, 64)], { ...ctx, debutYear: 2021 });
  const oldInjury = estimateExpectedGames([season(2025, 70), season(2024, 70), season(2023, 62), season(2022, 12), season(2021, 64)], { ...ctx, debutYear: 2021 });
  const recentInjury = estimateExpectedGames([season(2025, 12), season(2024, 70), season(2023, 62), season(2022, 70), season(2021, 64)], { ...ctx, debutYear: 2021 });
  // Previously the old 12-game season cost 8.5 games; now it costs under 3.
  assert.ok(healthy.expectedGames - oldInjury.expectedGames < 3, `${healthy.expectedGames} vs ${oldInjury.expectedGames}`);
  assert.ok(oldInjury.expectedGames > recentInjury.expectedGames);
  assert.deepEqual(oldInjury.isolatedAbsenceAdjusted, [2022]);
  assert.equal(oldInjury.historicalPattern, 'isolated_low_availability');
});

test('season weights strictly decrease with age (no pooled old-season block)', () => {
  const result = estimateExpectedGames([season(2025, 70), season(2024, 70), season(2023, 70), season(2022, 70), season(2021, 70), season(2020, 60, 72)], { ...ctx, debutYear: 2020 });
  for (let i = 1; i < result.seasonWeights.length; i += 1) assert.ok(result.seasonWeights[i] < result.seasonWeights[i - 1]);
  assert.ok(Math.abs(result.seasonWeights.reduce((sum, w) => sum + w, 0) - 1) < 1e-3);
});

test('recurring absences are not discounted; shortened league seasons use eligible games', () => {
  const recurring = estimateExpectedGames([season(2025, 40), season(2024, 35), season(2023, 70), season(2022, 72)], { ...ctx, debutYear: 2022 });
  assert.equal(recurring.historicalPattern, 'recurring_low_availability');
  assert.deepEqual(recurring.isolatedAbsenceAdjusted, []);
  // 2019-20 style shortened season: 72 of 72 eligible is full availability, not 72/82.
  const shortened = estimateExpectedGames([season(2025, 82), season(2024, 82), season(2023, 82), season(2019, 72, 72)], { ...ctx, debutYear: 2019 });
  assert.equal(shortened.perSeason.find((row) => row.season === 2019).availability, 1);
});

const SETTINGS = { rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const player = (key) => ({ playerKey: key, name: key, teamAbbr: 'DET', eligiblePositions: ['PG'], percentOwned: 0, status: null });
const history = [season(2025, 72), season(2024, 72), season(2023, 72)];

test('a shortened last season does not lower draft value a second time through confidence', () => {
  // Same per-game projection and the same availability history; only the
  // projection's games-played confidence differs (60 vs 20 games last season).
  const proj = (gp) => ({ projectedPoints: 40, confidence: 0.5 * Math.min(1, gp / 40) + 0.2, confidenceGamesPlayedShortfall: 0.5 * (1 - Math.min(1, gp / 40)), history });
  const map = { Full: proj(60), Short: proj(20), Filler: { projectedPoints: 10, confidence: 0.7, confidenceGamesPlayedShortfall: 0, history } };
  const board = buildDraftBoard({ players: [player('Full'), player('Short'), player('Filler')], settings: SETTINGS, projectionProvider: { getProjection: (p) => map[p.playerKey] } });
  const byName = Object.fromEntries(board.board.map((row) => [row.name, row]));
  assert.equal(byName.Full.value, byName.Short.value);
  assert.equal(byName.Full.components.confidenceFactor, byName.Short.components.confidenceFactor);
});

test('board order follows draft value, season points drive value, and factors are explained', () => {
  const map = {
    A: { projectedPoints: 45, confidence: 0.9, history },
    B: { projectedPoints: 40, confidence: 0.9, history: [season(2025, 40), season(2024, 35), season(2023, 38)] },
    C: { projectedPoints: 30, confidence: 0.9, history },
  };
  const board = buildDraftBoard({ players: ['A', 'B', 'C'].map(player), settings: SETTINGS, projectionProvider: { getProjection: (p) => map[p.playerKey] } });
  const values = board.board.map((row) => row.value);
  assert.deepEqual([...values].sort((a, b) => b - a), values);
  assert.deepEqual(board.board.map((row) => row.overallRank), [1, 2, 3]);
  for (const row of board.board) {
    assert.equal(row.projectedSeasonPoints, Number((row.perGame * row.expectedSeasonGames).toFixed(1)));
    assert.match(row.rankingFactors, /FPPG × .* expected games = .* projected season points/);
    assert.match(row.rankingFactors, /Availability: /);
  }
  const b = board.board.find((row) => row.name === 'B');
  assert.match(b.rankingFactors, /recurring missed time/);
  assert.equal(describeRankingFactors({ components: {} }, null, 0), null);
});

test('league-specific scoring changes projected points and can reorder the board', () => {
  const line = (points, rebounds, assists) => ({ ...emptyStatLine(), gamesPlayed: 70, points, rebounds, assists });
  const scorer = { season: line(30, 4, 3) };
  const rebounder = { season: line(16, 14, 3) };
  const pointsLeague = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }, { statId: 15, abbr: 'REB', pointValue: 0.5, enabled: true }, { statId: 16, abbr: 'AST', pointValue: 1, enabled: true }];
  const boardsLeague = [{ statId: 12, abbr: 'PTS', pointValue: 0.5, enabled: true }, { statId: 15, abbr: 'REB', pointValue: 2, enabled: true }, { statId: 16, abbr: 'AST', pointValue: 1, enabled: true }];
  const order = (scoring) => {
    const map = {
      Scorer: { ...projectPlayer({ stats: scorer, statCategories: scoring }), history },
      Rebounder: { ...projectPlayer({ stats: rebounder, statCategories: scoring }), history },
    };
    const players = [player('Scorer'), { ...player('Rebounder'), eligiblePositions: ['C'] }];
    return buildDraftBoard({ players, settings: SETTINGS, projectionProvider: { getProjection: (p) => map[p.playerKey] } }).board.map((row) => row.name);
  };
  assert.deepEqual(order(pointsLeague), ['Scorer', 'Rebounder']);
  assert.deepEqual(order(boardsLeague), ['Rebounder', 'Scorer']);
});
