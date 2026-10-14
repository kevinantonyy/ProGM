import { fitDevelopmentModel, DEFAULT_DEVELOPMENT_CONFIG } from './developmentModel.js';

export const TEAM_CONTEXT_MODEL_VERSION = 'progm.team-context.v1';

export const DEFAULT_TEAM_CONTEXT_CONFIG = Object.freeze({
  minimumTrainingSamples: 8,
  ridgePenalty: 1,
});

function finite(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function totalMinutes(row) {
  const explicit = finite(row?.minutesTotal);
  if (explicit != null) return explicit;
  const games = finite(row?.gamesPlayed);
  const minutes = finite(row?.minutesPerGame);
  return games == null || minutes == null ? null : games * minutes;
}

function positionTokens(position) {
  if (!position) return null;
  const tokens = String(position).toUpperCase().match(/[GFC]/g);
  return tokens?.length ? new Set(tokens) : null;
}

function overlaps(first, second) {
  const left = positionTokens(first);
  const right = positionTokens(second);
  if (!left || !right) return null;
  return [...left].some((token) => right.has(token));
}

function rosterIndex(rosters) {
  const bySeason = new Map();
  for (const row of rosters || []) {
    if (!bySeason.has(row.season)) bySeason.set(row.season, []);
    bySeason.get(row.season).push(row);
  }
  return bySeason;
}

function seasonPlayerIndex(rows, season) {
  return new Map(rows.filter((row) => row.season === season).map((row) => [row.player.id, row]));
}

function teamRows(rows, season, teamAbbr) {
  return rows.filter((row) => row.season === season && row.teamAbbr === teamAbbr);
}

/** Build strictly prior-minute roster-change features for one target player. */
export function buildTeamContextFeatures({ playerId, targetSeason, training, rosters }) {
  const targetRoster = (rosters || []).find((row) => row.season === targetSeason && row.player.id === playerId);
  if (!targetRoster) return { available: false, reason: 'missing_target_roster' };
  const targetTeamRows = teamRows(rosters, targetSeason, targetRoster.teamAbbr);
  if (!targetRoster.knownBeforeSeason || targetTeamRows.some((row) => !row.knownBeforeSeason)) {
    return { available: false, reason: 'roster_not_preseason_verified' };
  }
  const priorSeason = targetSeason - 1;
  const priorStats = seasonPlayerIndex(training, priorSeason);
  const priorTeamRows = teamRows(rosters, priorSeason, targetRoster.teamAbbr);
  const priorComplete = priorTeamRows.length > 0 && priorTeamRows.every((row) => row.teamRosterComplete === true);
  const targetComplete = targetTeamRows.length > 0 && targetTeamRows.every((row) => row.teamRosterComplete === true);
  if (!priorComplete || !targetComplete) return { available: false, reason: 'incomplete_roster' };

  const targetIds = new Set(targetTeamRows.map((row) => row.player.id));
  const priorIds = new Set(priorTeamRows.map((row) => row.player.id));
  const priorTeamMinutes = priorTeamRows.map((row) => totalMinutes(priorStats.get(row.player.id))).filter((value) => value != null);
  if (priorTeamMinutes.length !== priorTeamRows.length) return { available: false, reason: 'missing_prior_minutes' };
  const denominator = priorTeamMinutes.reduce((sum, value) => sum + value, 0);
  if (!(denominator > 0)) return { available: false, reason: 'missing_prior_minutes' };

  let returning = 0;
  let departed = 0;
  for (const row of priorTeamRows) {
    const minutes = totalMinutes(priorStats.get(row.player.id));
    if (targetIds.has(row.player.id)) returning += minutes;
    else departed += minutes;
  }
  let incoming = 0;
  let overlapCompetition = 0;
  for (const teammate of targetTeamRows) {
    if (teammate.player.id === playerId) continue;
    const previous = priorStats.get(teammate.player.id);
    const minutes = totalMinutes(previous);
    if (minutes == null) return { available: false, reason: 'missing_competitor_minutes' };
    if (!priorIds.has(teammate.player.id)) incoming += minutes;
    const overlap = overlaps(targetRoster.position, teammate.position);
    if (overlap == null) return { available: false, reason: 'missing_position' };
    if (overlap) overlapCompetition += minutes;
  }
  const playerPrior = priorStats.get(playerId);
  const teamChanged = playerPrior?.teamAbbr != null && playerPrior.teamAbbr !== targetRoster.teamAbbr ? 1 : 0;
  return {
    available: true,
    teamAbbr: targetRoster.teamAbbr,
    values: {
      continuity: returning / denominator,
      departedMinutesShare: departed / denominator,
      incomingMinutesShare: incoming / denominator,
      positionCompetitionShare: overlapCompetition / denominator,
      teamChanged,
      availableOpportunityShare: (departed - incoming) / denominator,
    },
    raw: { priorTeamMinutes: denominator, returningMinutes: returning, departedMinutes: departed, incomingMinutes: incoming, overlapCompetitionMinutes: overlapCompetition },
  };
}

const FEATURE_KEYS = Object.freeze([
  'continuity', 'departedMinutesShare', 'incomingMinutesShare',
  'positionCompetitionShare', 'teamChanged', 'availableOpportunityShare',
]);

function solveLinear(matrix, vector) {
  const size = vector.length;
  const work = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    if (Math.abs(work[pivot][column]) < 1e-10) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const divisor = work[column][column];
    for (let index = column; index <= size; index += 1) work[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];
      for (let index = column; index <= size; index += 1) work[row][index] -= factor * work[column][index];
    }
  }
  return work.map((row) => row[size]);
}

function fitRegression(samples, config) {
  if (samples.length < config.minimumTrainingSamples) return null;
  const means = Object.fromEntries(FEATURE_KEYS.map((key) => [key, samples.reduce((sum, sample) => sum + sample.features[key], 0) / samples.length]));
  const scales = Object.fromEntries(FEATURE_KEYS.map((key) => {
    const variance = samples.reduce((sum, sample) => sum + (sample.features[key] - means[key]) ** 2, 0) / samples.length;
    return [key, Math.sqrt(variance) || 1];
  }));
  const vectors = samples.map((sample) => [1, ...FEATURE_KEYS.map((key) => (sample.features[key] - means[key]) / scales[key])]);
  const width = vectors[0].length;
  const matrix = Array.from({ length: width }, () => Array(width).fill(0));
  const target = Array(width).fill(0);
  vectors.forEach((features, sampleIndex) => {
    for (let row = 0; row < width; row += 1) {
      target[row] += features[row] * samples[sampleIndex].delta;
      for (let column = 0; column < width; column += 1) matrix[row][column] += features[row] * features[column];
    }
  });
  for (let index = 1; index < width; index += 1) matrix[index][index] += config.ridgePenalty;
  const coefficients = solveLinear(matrix, target);
  if (!coefficients) return null;
  const deltas = samples.map((sample) => sample.delta);
  return {
    coefficients, means, scales, sampleCount: samples.length,
    minDelta: Math.min(...deltas), maxDelta: Math.max(...deltas),
    predict(features) {
      const vector = [1, ...FEATURE_KEYS.map((key) => (features[key] - means[key]) / scales[key])];
      return clamp(coefficients.reduce((sum, coefficient, index) => sum + coefficient * vector[index], 0), this.minDelta, this.maxDelta);
    },
  };
}

function trainingSamples(training, targetSeason, rosters, developmentOptions) {
  const seasons = [...new Set(training.map((row) => row.season))].filter((season) => season < targetSeason).sort((a, b) => a - b);
  const samples = [];
  for (const season of seasons.slice(1)) {
    const priorTraining = training.filter((row) => row.season < season);
    const development = fitDevelopmentModel(priorTraining, season, developmentOptions);
    for (const actual of training.filter((row) => row.season === season)) {
      const history = priorTraining.filter((row) => row.player.id === actual.player.id).sort((a, b) => b.season - a.season);
      const base = development.predict({ history });
      const context = buildTeamContextFeatures({ playerId: actual.player.id, targetSeason: season, training: priorTraining, rosters });
      const actualMinutes = finite(actual.minutesPerGame);
      if (!base?.statLine || !context.available || actualMinutes == null) continue;
      samples.push({ features: context.values, delta: actualMinutes - base.statLine.minutes });
    }
  }
  return samples;
}

function scaleProjection(base, adjustedMinutes, diagnostics) {
  const originalMinutes = finite(base?.statLine?.minutes);
  if (!base?.statLine || !(originalMinutes > 0) || !(adjustedMinutes > 0)) return base;
  const ratio = adjustedMinutes / originalMinutes;
  const statLine = { ...base.statLine, minutes: Number(adjustedMinutes.toFixed(4)) };
  for (const [key, value] of Object.entries(statLine)) {
    if (key === 'minutes' || key === 'gamesPlayed' || value == null || !Number.isFinite(Number(value))) continue;
    statLine[key] = Number((Number(value) * ratio).toFixed(4));
  }
  return { ...base, statLine, method: 'age_development_plus_team_context', modelVersion: TEAM_CONTEXT_MODEL_VERSION, diagnostics: { ...base.diagnostics, teamContext: diagnostics } };
}

export function fitTeamContextModel(training, targetSeason, rosterDataset, options = {}) {
  const config = { ...DEFAULT_TEAM_CONTEXT_CONFIG, ...options };
  const rosters = rosterDataset?.snapshots || [];
  const developmentOptions = options.development || DEFAULT_DEVELOPMENT_CONFIG;
  const development = fitDevelopmentModel(training, targetSeason, developmentOptions);
  const samples = trainingSamples(training, targetSeason, rosters, developmentOptions);
  const regression = fitRegression(samples, config);
  const targetRosterRows = rosters.filter((row) => row.season === targetSeason);
  const baseByPlayer = new Map();
  for (const roster of targetRosterRows) {
    const history = training.filter((row) => row.player.id === roster.player.id).sort((a, b) => b.season - a.season);
    const base = development.predict({ history });
    const context = buildTeamContextFeatures({ playerId: roster.player.id, targetSeason, training, rosters });
    const delta = regression && context.available ? regression.predict(context.values) : 0;
    baseByPlayer.set(roster.player.id, { base, context, learnedDelta: delta, adjustedMinutes: base?.statLine ? clamp(base.statLine.minutes + delta, 0, 48) : null, constraintScale: 1, unallocatedReplacementMinutes: null });
  }
  if (regression) {
    const teams = [...new Set(targetRosterRows.map((row) => row.teamAbbr))];
    const latestSeasonGames = training.filter((row) => row.season === targetSeason - 1).map((row) => finite(row.gamesPlayed) || 0);
    const maxGames = Math.max(...latestSeasonGames, 0) || Math.max(...training.map((row) => finite(row.gamesPlayed) || 0), 0) || 82;
    for (const team of teams) {
      const teamRoster = targetRosterRows.filter((row) => row.teamAbbr === team);
      if (!teamRoster.length || !teamRoster.every((row) => row.teamRosterComplete === true)) continue;
      const entries = teamRoster.map((row) => baseByPlayer.get(row.player.id)).filter((entry) => entry?.base && entry.adjustedMinutes != null && entry.base.expectedGames != null);
      const cap = 240 * maxGames;
      const total = entries.reduce((sum, entry) => sum + entry.adjustedMinutes * entry.base.expectedGames, 0);
      const scale = total > cap ? cap / total : 1;
      const allocated = entries.reduce((sum, entry) => sum + entry.adjustedMinutes * scale * entry.base.expectedGames, 0);
      for (const entry of entries) {
        entry.adjustedMinutes *= scale;
        entry.constraintScale = scale;
        entry.unallocatedReplacementMinutes = Math.max(0, cap - allocated);
      }
    }
  }
  return {
    diagnostics: {
      modelVersion: TEAM_CONTEXT_MODEL_VERSION,
      targetSeason,
      trainingMaxSeason: training.length ? Math.max(...training.map((row) => row.season)) : null,
      trainingSamples: samples.length,
      trained: regression != null,
      accuracyValidated: false,
    },
    predict({ player, history }) {
      const entry = baseByPlayer.get(player.id);
      const base = entry?.base || development.predict({ history });
      if (!base?.statLine) return base;
      if (!regression || !entry?.context.available) {
        return { ...base, diagnostics: { ...base.diagnostics, teamContext: { applied: false, reason: !regression ? 'untrained' : entry?.context.reason || 'missing_roster', learnedMinutesDelta: 0 } } };
      }
      const continuity = entry.context.values.continuity;
      const cohorts = [continuity >= 0.75 ? 'high_roster_continuity' : continuity <= 0.5 ? 'low_roster_continuity' : 'medium_roster_continuity'];
      if (entry.context.values.teamChanged) cohorts.push('team_context_changed_team');
      return {
        ...scaleProjection(base, entry.adjustedMinutes, {
          applied: true,
          features: entry.context.values,
          raw: entry.context.raw,
          learnedMinutesDelta: Number(entry.learnedDelta.toFixed(4)),
          constraintScale: Number(entry.constraintScale.toFixed(6)),
          unallocatedReplacementMinutes: entry.unallocatedReplacementMinutes == null ? null : Number(entry.unallocatedReplacementMinutes.toFixed(2)),
        }),
        cohorts,
      };
    },
  };
}

export function createTeamContextCandidate({ rosterDataset = null, ...options } = {}) {
  return {
    name: 'age_development_plus_team_context',
    modelVersion: TEAM_CONTEXT_MODEL_VERSION,
    fit({ training, targetSeason }) {
      const artifact = fitTeamContextModel(training, targetSeason, rosterDataset, options);
      const predictor = ({ player, history }) => artifact.predict({ player, history });
      predictor.diagnostics = artifact.diagnostics;
      return predictor;
    },
  };
}
