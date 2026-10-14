import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvailabilityBaseline,
  computeDurability,
  DEFAULT_AVAILABILITY_BASELINE,
  DURABILITY_RECENCY_WEIGHTS,
  estimateExpectedGames,
  EXPECTED_SEASON_GAMES,
  MIN_USABLE_SEASONS,
  seasonEndingInjury,
} from './durability.js';

const h = (season, gamesPlayed, gameTotal = 82) => ({ season, gamesPlayed, gameTotal });

test('3-season recency-weighted availability drives expected games', () => {
  const hist = [h(2025, 82), h(2024, 41), h(2023, 66)];
  const expectedAvailability = 0.5 * 1 + 0.3 * 0.5 + 0.2 * (66 / 82);
  const durability = computeDurability(hist);
  const expected = estimateExpectedGames(hist, { baselineAvailability: 0.85 });
  assert.equal(durability.usableSeasons, 3);
  assert.ok(Math.abs(durability.durabilityScore - Number(expectedAvailability.toFixed(4))) < 1e-3);
  assert.equal(expected.expectedGames, Number((82 * expectedAvailability).toFixed(1)));
  assert.equal(expected.historyReliability, 1);
});

test('shortened seasons use their actual game totals', () => {
  const hist = [h(2020, 60, 72), h(2019, 70, 72), h(2018, 66, 82)];
  const expectedAvailability = 0.5 * (60 / 72) + 0.3 * (70 / 72) + 0.2 * (66 / 82);
  const result = estimateExpectedGames(hist);
  assert.equal(result.expectedGames, Number((82 * expectedAvailability).toFixed(1)));
});

test('two seasons are recency weighted and regressed one-third toward baseline', () => {
  const hist = [h(2025, 82), h(2024, 41)];
  const raw = (0.5 * 1 + 0.3 * 0.5) / 0.8;
  const expectedAvailability = raw * (2 / 3) + 0.85 * (1 / 3);
  const result = estimateExpectedGames(hist, { baselineAvailability: 0.85 });
  assert.equal(result.historyReliability, 0.6667);
  assert.equal(result.expectedGames, Number((82 * expectedAvailability).toFixed(1)));
});

test('one-season rookies regress toward baseline rather than treating missing seasons as zero', () => {
  const result = estimateExpectedGames([h(2025, 30)], { baselineAvailability: 0.85 });
  assert.equal(result.historyReliability, 0.3333);
  assert.ok(result.expectedGames > 30);
  assert.ok(result.expectedGames < 82 * 0.85);
});

test('missing history uses the baseline and never zero', () => {
  const result = estimateExpectedGames(null);
  assert.equal(result.expectedGames, Number((82 * DEFAULT_AVAILABILITY_BASELINE).toFixed(1)));
  assert.equal(result.rawAvailability, null);
});

test('pool baseline is median, bounded, and ignores thin histories', () => {
  const histories = [
    [h(2025, 82), h(2024, 82), h(2023, 82)],
    [h(2025, 70), h(2024, 70), h(2023, 70)],
    [h(2025, 5)],
  ];
  const baseline = computeAvailabilityBaseline(histories);
  assert.ok(baseline >= 0.75 && baseline <= 0.90);
  assert.equal(baseline, 0.9);
});

test('only explicit season-ending injury language caps expected games', () => {
  const history = [h(2025, 82), h(2024, 80), h(2023, 81)];
  const question = estimateExpectedGames(history, { injury: { designation: 'Questionable', description: 'Day to day' } });
  const ended = estimateExpectedGames(history, { injury: { designation: 'Out', description: 'Will miss the rest of the season' } });
  assert.ok(question.expectedGames > 79);
  assert.equal(ended.expectedGames, 0);
  assert.match(ended.injuryReason, /rest of the season/i);
  assert.equal(seasonEndingInjury({ designation: 'Q' }), null);
});

test('malformed history is ignored and availability stays in range', () => {
  const result = estimateExpectedGames([h(2025, 90, 82), h(2024, null), h(2023, 50, 0)]);
  assert.ok(result.availability >= 0 && result.availability <= 1);
  assert.equal(result.usableSeasons, 1);
});

test('constants document the model', () => {
  assert.deepEqual([...DURABILITY_RECENCY_WEIGHTS], [0.5, 0.3, 0.2]);
  assert.equal(MIN_USABLE_SEASONS, 2);
  assert.equal(EXPECTED_SEASON_GAMES, 82);
});
