import { emptyStatLine } from '../../providers/types.js';
import { HISTORICAL_STAT_KEYS } from './snapshot.js';

export const DEVELOPMENT_MODEL_VERSION = 'progm.age-development.v1';

export const DEFAULT_DEVELOPMENT_CONFIG = Object.freeze({
  recencyDecay: 0.72,
  minutesPriorGames: 24,
  ratePriorMinutes: 1200,
  gamesPriorSeasons: 1.5,
  ridgePenalty: 1,
  minimumCurveSamples: 6,
});

function finite(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positionOf(row) {
  return row?.position || 'ALL';
}

function exposureMinutes(row) {
  const total = finite(row?.minutesTotal);
  if (total != null && total > 0) return total;
  const games = finite(row?.gamesPlayed);
  const mpg = finite(row?.minutesPerGame);
  return games != null && games > 0 && mpg != null && mpg > 0 ? games * mpg : null;
}

function perMinute(row, key) {
  const value = finite(row?.stats?.[key]);
  const minutes = finite(row?.minutesPerGame);
  return value != null && minutes != null && minutes > 0 ? value / minutes : null;
}

function weightedMean(rows, valueOf, weightOf) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const value = finite(valueOf(row));
    const weight = finite(weightOf(row));
    if (value == null || weight == null || weight <= 0) continue;
    numerator += value * weight;
    denominator += weight;
  }
  return denominator ? numerator / denominator : null;
}

function populationPrior(training, position, valueOf, weightOf) {
  const positional = training.filter((row) => positionOf(row) === position);
  return weightedMean(positional, valueOf, weightOf) ?? weightedMean(training, valueOf, weightOf);
}

function recencyEstimate({ history, targetSeason, valueOf, exposureOf, prior, priorExposure, decay }) {
  let numerator = prior == null ? 0 : prior * priorExposure;
  let denominator = prior == null ? 0 : priorExposure;
  let observations = 0;
  const sourceSeasons = [];
  for (const row of history) {
    const value = finite(valueOf(row));
    const exposure = finite(exposureOf(row));
    if (value == null || exposure == null || exposure <= 0) continue;
    const lag = Math.max(0, targetSeason - 1 - row.season);
    const weight = Math.pow(decay, lag) * exposure;
    numerator += value * weight;
    denominator += weight;
    observations += 1;
    sourceSeasons.push(row.season);
  }
  return {
    value: observations && denominator ? numerator / denominator : null,
    observations,
    sourceSeasons,
  };
}

function solveLinear(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

function meanAndScale(values) {
  const usable = values.filter((value) => value != null);
  if (!usable.length) return { mean: 0, scale: 1, min: null, max: null };
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const variance = usable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / usable.length;
  return { mean, scale: Math.sqrt(variance) || 1, min: Math.min(...usable), max: Math.max(...usable) };
}

function curveFeatures(age, experience, context) {
  const boundedAge = age == null || context.age.min == null ? null : clamp(age, context.age.min, context.age.max);
  const boundedExperience = experience == null || context.experience.min == null
    ? null
    : clamp(experience, context.experience.min, context.experience.max);
  const ageZ = boundedAge == null ? 0 : (boundedAge - context.age.mean) / context.age.scale;
  const experienceZ = boundedExperience == null ? 0 : (boundedExperience - context.experience.mean) / context.experience.scale;
  return [1, ageZ, ageZ ** 2, experienceZ, experienceZ ** 2, boundedAge == null ? 1 : 0, boundedExperience == null ? 1 : 0];
}

/** Fit a regularized age/experience curve to observed year-over-year changes. */
export function fitDevelopmentCurve(samples, config = DEFAULT_DEVELOPMENT_CONFIG) {
  const usable = (samples || []).filter((sample) => finite(sample.delta) != null && finite(sample.weight) > 0);
  if (usable.length < config.minimumCurveSamples) return null;
  const context = {
    age: meanAndScale(usable.map((sample) => finite(sample.age))),
    experience: meanAndScale(usable.map((sample) => finite(sample.experience))),
  };
  const width = 7;
  const matrix = Array.from({ length: width }, () => Array(width).fill(0));
  const vector = Array(width).fill(0);
  const meanWeight = usable.reduce((sum, sample) => sum + sample.weight, 0) / usable.length;
  for (const sample of usable) {
    const features = curveFeatures(finite(sample.age), finite(sample.experience), context);
    const weight = sample.weight / (meanWeight || 1);
    for (let row = 0; row < width; row += 1) {
      vector[row] += weight * features[row] * sample.delta;
      for (let column = 0; column < width; column += 1) matrix[row][column] += weight * features[row] * features[column];
    }
  }
  for (let index = 1; index < width; index += 1) matrix[index][index] += config.ridgePenalty;
  const coefficients = solveLinear(matrix, vector);
  if (!coefficients) return null;
  const deltas = usable.map((sample) => sample.delta).sort((a, b) => a - b);
  return {
    sampleCount: usable.length,
    coefficients,
    context,
    predict(age, experience) {
      if (age == null && experience == null) return 0;
      const features = curveFeatures(finite(age), finite(experience), context);
      const estimate = coefficients.reduce((sum, coefficient, index) => sum + coefficient * features[index], 0);
      return clamp(estimate, deltas[0], deltas[deltas.length - 1]);
    },
  };
}

function playerTransitions(training) {
  const byPlayer = new Map();
  for (const row of training) {
    if (!byPlayer.has(row.player.id)) byPlayer.set(row.player.id, []);
    byPlayer.get(row.player.id).push(row);
  }
  const transitions = [];
  for (const rows of byPlayer.values()) {
    rows.sort((a, b) => a.season - b.season);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (current.season !== previous.season + 1) continue;
      transitions.push({ previous, current });
    }
  }
  return transitions;
}

function changeSamples(transitions, valueOf, weightOf) {
  const samples = [];
  for (const { previous, current } of transitions) {
    const before = finite(valueOf(previous));
    const after = finite(valueOf(current));
    const weight = Math.min(finite(weightOf(previous)) || 0, finite(weightOf(current)) || 0);
    if (before == null || after == null || weight <= 0) continue;
    samples.push({ age: current.age, experience: current.experience, delta: after - before, weight });
  }
  return samples;
}

function bounds(training, valueOf) {
  const values = training.map(valueOf).filter((value) => finite(value) != null).map(Number);
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: null, max: null };
}

function projectAge(latest, targetSeason, field) {
  const value = finite(latest?.[field]);
  return value == null ? null : value + Math.max(0, targetSeason - latest.season);
}

/** Train one fold using only player-seasons supplied by the walk-forward runner. */
export function fitDevelopmentModel(training, targetSeason, options = {}) {
  const config = { ...DEFAULT_DEVELOPMENT_CONFIG, ...options };
  const rows = [...training].filter((row) => row.season < targetSeason);
  const transitions = playerTransitions(rows);
  const minutesCurve = fitDevelopmentCurve(changeSamples(
    transitions,
    (row) => row.minutesPerGame,
    (row) => row.gamesPlayed,
  ), config);
  const rateCurves = Object.fromEntries(HISTORICAL_STAT_KEYS.map((key) => [key, fitDevelopmentCurve(changeSamples(
    transitions,
    (row) => perMinute(row, key),
    exposureMinutes,
  ), config)]));
  const minutesBounds = bounds(rows, (row) => row.minutesPerGame);
  const rateBounds = Object.fromEntries(HISTORICAL_STAT_KEYS.map((key) => [key, bounds(rows, (row) => perMinute(row, key))]));
  const maxGames = Math.max(...rows.map((row) => finite(row.gamesPlayed) || 0), 0) || null;

  return {
    modelVersion: DEVELOPMENT_MODEL_VERSION,
    targetSeason,
    config,
    diagnostics: {
      modelVersion: DEVELOPMENT_MODEL_VERSION,
      targetSeason,
      trainingRows: rows.length,
      trainingPlayers: new Set(rows.map((row) => row.player.id)).size,
      trainingMaxSeason: rows.length ? Math.max(...rows.map((row) => row.season)) : null,
      transitionCount: transitions.length,
      minutesCurveSamples: minutesCurve?.sampleCount || 0,
      rateCurveSamples: Object.fromEntries(HISTORICAL_STAT_KEYS.map((key) => [key, rateCurves[key]?.sampleCount || 0])),
      accuracyValidated: false,
    },
    predict({ history }) {
      const usableHistory = [...(history || [])]
        .filter((row) => row.season < targetSeason)
        .sort((a, b) => b.season - a.season);
      const latest = usableHistory[0];
      if (!latest) return null;
      const position = positionOf(latest);
      const targetAge = projectAge(latest, targetSeason, 'age');
      const targetExperience = projectAge(latest, targetSeason, 'experience');

      const minutesPrior = populationPrior(rows, position, (row) => row.minutesPerGame, (row) => row.gamesPlayed);
      const minutesBase = recencyEstimate({
        history: usableHistory,
        targetSeason,
        valueOf: (row) => row.minutesPerGame,
        exposureOf: (row) => row.gamesPlayed,
        prior: minutesPrior,
        priorExposure: config.minutesPriorGames,
        decay: config.recencyDecay,
      });
      if (minutesBase.value == null) return null;
      const minutesDelta = minutesCurve?.predict(targetAge, targetExperience) || 0;
      const projectedMinutes = minutesBounds.min == null
        ? Math.max(0, minutesBase.value + minutesDelta)
        : clamp(minutesBase.value + minutesDelta, Math.max(0, minutesBounds.min), minutesBounds.max);
      if (!(projectedMinutes > 0)) return null;

      const line = emptyStatLine();
      line.minutes = Number(projectedMinutes.toFixed(4));
      const statDiagnostics = {};
      const sourceSeasons = new Set(minutesBase.sourceSeasons);
      for (const key of HISTORICAL_STAT_KEYS) {
        const prior = populationPrior(rows, position, (row) => perMinute(row, key), exposureMinutes);
        const estimate = recencyEstimate({
          history: usableHistory,
          targetSeason,
          valueOf: (row) => perMinute(row, key),
          exposureOf: exposureMinutes,
          prior,
          priorExposure: config.ratePriorMinutes,
          decay: config.recencyDecay,
        });
        if (estimate.value == null) {
          line[key] = null;
          statDiagnostics[key] = { observations: 0, developmentDelta: null };
          continue;
        }
        estimate.sourceSeasons.forEach((season) => sourceSeasons.add(season));
        const developmentDelta = rateCurves[key]?.predict(targetAge, targetExperience) || 0;
        const rawRate = estimate.value + developmentDelta;
        const boundary = rateBounds[key];
        const projectedRate = boundary.min == null ? Math.max(0, rawRate) : clamp(rawRate, Math.max(0, boundary.min), boundary.max);
        line[key] = Number((projectedRate * projectedMinutes).toFixed(4));
        statDiagnostics[key] = { observations: estimate.observations, developmentDelta: Number(developmentDelta.toFixed(6)) };
      }

      // Preserve deterministic box-score relationships when their components exist.
      if (line.fgAtt != null && line.fgMade != null) line.fgMade = Math.min(line.fgMade, line.fgAtt);
      if (line.ftAtt != null && line.ftMade != null) line.ftMade = Math.min(line.ftMade, line.ftAtt);
      if (line.threesMade != null && line.fgMade != null) line.threesMade = Math.min(line.threesMade, line.fgMade);
      if (line.offRebounds != null && line.defRebounds != null) line.rebounds = Number((line.offRebounds + line.defRebounds).toFixed(4));
      if (line.fgMade != null && line.threesMade != null && line.ftMade != null) {
        line.points = Number((2 * line.fgMade + line.threesMade + line.ftMade).toFixed(4));
      }
      if (line.doubleDoubles != null && line.tripleDoubles != null) line.tripleDoubles = Math.min(line.tripleDoubles, line.doubleDoubles);

      const gamesPrior = populationPrior(rows, position, (row) => row.gamesPlayed, () => 1);
      const gamesEstimate = recencyEstimate({
        history: usableHistory,
        targetSeason,
        valueOf: (row) => row.gamesPlayed,
        exposureOf: () => 1,
        prior: gamesPrior,
        priorExposure: config.gamesPriorSeasons,
        decay: config.recencyDecay,
      });
      const expectedGames = gamesEstimate.value == null
        ? null
        : Number(clamp(gamesEstimate.value, 0, maxGames || gamesEstimate.value).toFixed(1));
      line.gamesPlayed = expectedGames;

      return {
        statLine: line,
        expectedGames,
        method: 'multiseason_age_development_candidate',
        modelVersion: DEVELOPMENT_MODEL_VERSION,
        sourceSeasons: [...sourceSeasons].sort((a, b) => b - a),
        diagnostics: {
          targetAge,
          targetExperience,
          minutesBase: Number(minutesBase.value.toFixed(4)),
          minutesDevelopmentDelta: Number(minutesDelta.toFixed(4)),
          minutesObservations: minutesBase.observations,
          stats: statDiagnostics,
          accuracyValidated: false,
        },
      };
    },
  };
}

/** Factory consumed by runWalkForwardBacktest; every target season gets a new fit. */
export function createDevelopmentCandidate(options = {}) {
  return {
    name: 'multiseason_age_development_candidate',
    modelVersion: DEVELOPMENT_MODEL_VERSION,
    fit({ training, targetSeason }) {
      const artifact = fitDevelopmentModel(training, targetSeason, options);
      const predictor = ({ history }) => artifact.predict({ history });
      predictor.diagnostics = artifact.diagnostics;
      return predictor;
    },
  };
}
