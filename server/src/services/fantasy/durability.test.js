import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVAILABILITY_MODEL,
  backtestAvailabilityModels,
  buildAvailabilityBaselineModel,
  classifyVerifiedInjury,
  computeDurability,
  DEFAULT_AVAILABILITY_BASELINE,
  DURABILITY_RECENCY_WEIGHTS,
  estimateExpectedGames,
  EXPECTED_SEASON_GAMES,
  normalizeAvailabilityHistory,
} from './durability.js';

const h = (season, gamesPlayed, gameTotal = 82) => ({ season, gamesPlayed, gameTotal });

test('normalization excludes pre-debut/current seasons and never turns missing records into zero', () => {
  const rows = normalizeAvailabilityHistory([
    h(2026, 10), h(2025, 60), h(2024, null), h(2023, 50), h(2022, 40),
  ], { debutYear: 2023, targetSeason: 2026 });
  assert.deepEqual(rows.map((row) => row.season), [2025, 2023]);
  assert.equal(rows.length, 2);
});

test('shortened seasons use eligible team games rather than an 82-game denominator', () => {
  const result = estimateExpectedGames([h(2020, 60, 72), h(2019, 70, 72), h(2018, 66, 82)], {
    debutYear: 2018,
    targetSeason: 2021,
    baselineAvailability: 0.85,
  });
  assert.ok(Math.abs(result.recentRate - (0.5 * (60 / 72) + 0.3 * (70 / 72) + 0.2 * (66 / 82))) < 0.001);
});

test('age/experience baselines are estimated from historical observations, not fixed bonuses', () => {
  const profiles = [
    { age: 23, debutYear: 2022, history: [h(2025, 80), h(2024, 78), h(2023, 79)] },
    { age: 24, debutYear: 2021, history: [h(2025, 76), h(2024, 75), h(2023, 74)] },
    { age: 35, debutYear: 2012, history: [h(2025, 45), h(2024, 50), h(2023, 48)] },
    { age: 36, debutYear: 2011, history: [h(2025, 42), h(2024, 44), h(2023, 46)] },
  ];
  const model = buildAvailabilityBaselineModel(profiles, 2026);
  const young = model.forPlayer({ age: 23, debutYear: 2022, targetSeason: 2026 });
  const older = model.forPlayer({ age: 35, debutYear: 2012, targetSeason: 2026 });
  assert.ok(young.rate > older.rate);
  assert.ok(young.ageCohort.seasons > 0);
  assert.ok(older.ageCohort.seasons > 0);
});

test('historical target seasons adjust provider current age using its reference season', () => {
  const model = buildAvailabilityBaselineModel([
    { age: 30, ageReferenceSeason: 2026, debutYear: 2018, history: [h(2025, 70), h(2024, 70)] },
  ], 2020);
  const context = model.forPlayer({ age: 30, ageReferenceSeason: 2026, debutYear: 2018, targetSeason: 2020 });
  assert.equal(context.targetAge, 24);
});

test('rookies with no history use the cohort baseline, never assumed durable', () => {
  const result = estimateExpectedGames(null, { baselineAvailability: 0.83, age: 20, debutYear: 2026, targetSeason: 2026 });
  assert.equal(result.expectedGames, Number((82 * 0.83).toFixed(1)));
  assert.equal(result.seasonsObserved, 0);
  assert.equal(result.shrinkageFactor, 1);
});

test('one isolated low-availability season is strongly shrunk toward baseline', () => {
  const result = estimateExpectedGames([h(2025, 20)], { baselineAvailability: 0.85, debutYear: 2025, targetSeason: 2026 });
  assert.equal(result.historicalPattern, 'isolated_low_availability');
  assert.equal(result.recentSeasonsObserved, 1);
  assert.ok(result.expectedGames > 55);
  assert.ok(result.expectedGames < 70);
  assert.ok(result.recentDataWeight < 0.6);
  assert.ok(result.shrinkageFactor > 0.4);
});

test('more independent seasons progressively reduce shrinkage', () => {
  const one = estimateExpectedGames([h(2025, 60)], { baselineAvailability: 0.85, targetSeason: 2026 });
  const two = estimateExpectedGames([h(2025, 60), h(2024, 60)], { baselineAvailability: 0.85, targetSeason: 2026 });
  const three = estimateExpectedGames([h(2025, 60), h(2024, 60), h(2023, 60)], { baselineAvailability: 0.85, targetSeason: 2026 });
  assert.ok(one.recentDataWeight < two.recentDataWeight);
  assert.ok(two.recentDataWeight < three.recentDataWeight);
  assert.ok(one.shrinkageFactor > two.shrinkageFactor);
  assert.ok(two.shrinkageFactor > three.shrinkageFactor);
});

test('recent and older-career components use disjoint seasons', () => {
  const result = estimateExpectedGames([
    h(2025, 70), h(2024, 65), h(2023, 60), h(2022, 80), h(2021, 78),
  ], { baselineAvailability: 0.85, debutYear: 2021, targetSeason: 2026 });
  assert.equal(result.seasonsObserved, 5);
  assert.equal(result.recentSeasonsObserved, 3);
  assert.equal(result.independentCareerSeasonsObserved, 2);
  assert.equal(result.perSeason.length, 5);
});

test('recurring low-availability seasons remain more concerning than one isolated season', () => {
  const isolated = estimateExpectedGames([h(2025, 30), h(2024, 78), h(2023, 78)], { baselineAvailability: 0.85, targetSeason: 2026 });
  const recurring = estimateExpectedGames([h(2025, 30), h(2024, 35), h(2023, 78)], { baselineAvailability: 0.85, targetSeason: 2026 });
  assert.equal(isolated.historicalPattern, 'isolated_low_availability');
  assert.equal(recurring.historicalPattern, 'recurring_low_availability');
  assert.ok(isolated.expectedGames > recurring.expectedGames);
});

test('verified future absences apply once; Q/GTD and unquantified long-term notes do not invent timelines', () => {
  const history = [h(2025, 75), h(2024, 75), h(2023, 75)];
  const question = estimateExpectedGames(history, { injury: { designation: 'Questionable', description: 'Game-time decision' } });
  const indefinite = estimateExpectedGames(history, { injury: { designation: 'Out', description: 'Out indefinitely' } });
  const ended = estimateExpectedGames(history, { injury: { designation: 'Out', description: 'Will miss the rest of the season' } });
  assert.equal(question.injuryType, 'temporary_status');
  assert.ok(question.expectedGames > 0);
  assert.equal(indefinite.injuryType, 'verified_long_term_unquantified');
  assert.equal(indefinite.expectedGames, question.expectedGames);
  assert.equal(ended.injuryType, 'verified_season_ending');
  assert.equal(ended.expectedGames, 0);
  assert.equal(ended.availabilityPenaltyAppliedAgain, false);
  assert.ok(ended.injuryAdjustmentGames < 0);
});

test('routine rest is distinguished without a season-long penalty', () => {
  const injury = classifyVerifiedInjury({ designation: 'Out', description: 'Rest/maintenance' });
  assert.equal(injury.type, 'routine_rest');
  assert.equal(injury.availabilityCap, null);
});

test('legacy three-season calculation remains available only for backtest comparison', () => {
  const result = computeDurability([h(2025, 82), h(2024, 41), h(2023, 66)]);
  const expected = 0.5 * 1 + 0.3 * 0.5 + 0.2 * (66 / 82);
  assert.equal(result.usableSeasons, 3);
  assert.ok(Math.abs(result.durabilityScore - expected) < 0.001);
});

test('rolling backtest returns MAE by career stage and low-prior-availability cohort', () => {
  const profiles = [
    { age: 25, debutYear: 2022, history: [h(2025, 75), h(2024, 70), h(2023, 65), h(2022, 60)] },
    { age: 31, debutYear: 2018, history: [h(2025, 40), h(2024, 35), h(2023, 50), h(2022, 45), h(2021, 55), h(2020, 50)] },
  ];
  const report = backtestAvailabilityModels(profiles, 2026);
  assert.ok(report.overall.count > 0);
  assert.ok(report.rookies.count > 0);
  assert.ok(report.secondYear.count > 0);
  assert.ok(report.veterans.count > 0);
  assert.ok(report.lowPriorAvailability.count > 0);
  for (const cohort of Object.values(report)) assert.ok(cohort.careerAdjusted == null || cohort.careerAdjusted >= 0);
});

test('model parameters are explicit experimental defaults', () => {
  assert.equal(AVAILABILITY_MODEL.historyWeight, 0.75);
  assert.equal(AVAILABILITY_MODEL.baselineWeight, 0.25);
  assert.equal(AVAILABILITY_MODEL.historyWeight + AVAILABILITY_MODEL.baselineWeight, 1);
  assert.equal(AVAILABILITY_MODEL.recencyDecay, 0.6);
  assert.equal(AVAILABILITY_MODEL.fullCoverageSeasons, 4);
  assert.equal(AVAILABILITY_MODEL.isolatedAbsenceWeight, 0.5);
  assert.deepEqual([...DURABILITY_RECENCY_WEIGHTS], [0.5, 0.3, 0.2]);
  assert.equal(EXPECTED_SEASON_GAMES, 82);
  assert.equal(DEFAULT_AVAILABILITY_BASELINE, 0.85);
});
