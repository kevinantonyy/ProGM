/**
 * Career-adjusted NBA availability model.
 *
 * Historical records are provider facts (games played / eligible team games).
 * The model keeps recent and older-career samples disjoint, shrinks both toward
 * a data-derived age/experience baseline, and applies verified future injury
 * information once. Missing and pre-debut seasons are never treated as zero.
 */

export const DURABILITY_RECENCY_WEIGHTS = Object.freeze([0.50, 0.30, 0.20]);
export const MIN_USABLE_SEASONS = 2;
export const EXPECTED_SEASON_GAMES = 82;
export const DEFAULT_AVAILABILITY_BASELINE = 0.85;

// Experimental, configurable defaults. These are not claimed as scientific
// constants; rolling backtests expose their out-of-sample performance.
export const AVAILABILITY_MODEL = Object.freeze({
  careerWeight: 0.35,
  recentWeight: 0.40,
  baselineWeight: 0.25,
  // Selected from rolling MAE over the available cached history grid
  // (20.5/41/82/164); re-evaluate as historical coverage improves.
  playerPriorGames: 20.5,
  cohortPriorGames: 820,
  cohortAgeWindow: 2,
  cohortExperienceWindow: 2,
  lowAvailabilityThreshold: 0.65,
});

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Valid, unique, completed post-debut seasons, newest first. */
export function normalizeAvailabilityHistory(history, { debutYear = null, targetSeason = null } = {}) {
  const debut = finite(debutYear);
  const target = finite(targetSeason);
  const seen = new Set();
  return (Array.isArray(history) ? history : [])
    .filter((row) => {
      const season = finite(row?.season);
      const gamesPlayed = finite(row?.gamesPlayed);
      const gameTotal = finite(row?.gameTotal);
      if (season == null || gamesPlayed == null || gameTotal == null || gameTotal <= 0) return false;
      if (debut != null && season < debut) return false;
      if (target != null && season >= target) return false;
      if (seen.has(season)) return false;
      seen.add(season);
      return true;
    })
    .map((row) => ({
      season: Number(row.season),
      gamesPlayed: Math.max(0, Math.min(Number(row.gamesPlayed), Number(row.gameTotal))),
      gameTotal: Number(row.gameTotal),
      availability: Math.max(0, Math.min(1, Number(row.gamesPlayed) / Number(row.gameTotal))),
    }))
    .sort((a, b) => b.season - a.season);
}

function aggregateRate(rows) {
  const eligibleGames = rows.reduce((sum, row) => sum + row.gameTotal, 0);
  const gamesPlayed = rows.reduce((sum, row) => sum + row.gamesPlayed, 0);
  return {
    rate: eligibleGames > 0 ? gamesPlayed / eligibleGames : null,
    gamesPlayed,
    eligibleGames,
    seasons: rows.length,
  };
}

function recentRate(rows) {
  const weighted = rows.slice(0, 3).map((row, index) => ({ ...row, weight: DURABILITY_RECENCY_WEIGHTS[index] }));
  const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0);
  return weightSum
    ? weighted.reduce((sum, row) => sum + row.availability * row.weight, 0) / weightSum
    : null;
}

function independentEvidenceGames(rows) {
  const total = rows.reduce((sum, row) => sum + row.gameTotal, 0);
  // A single season supplies less independent durability evidence than three
  // separate seasons even when both contain many eligible games.
  return total * Math.min(1, rows.length / 3);
}

function shrinkRate(rawRate, rows, baseline, priorGames = AVAILABILITY_MODEL.playerPriorGames) {
  const evidenceGames = independentEvidenceGames(rows);
  if (rawRate == null || evidenceGames <= 0) {
    return { rate: baseline, dataWeight: 0, evidenceGames: 0 };
  }
  const dataWeight = evidenceGames / (evidenceGames + priorGames);
  return {
    rate: rawRate * dataWeight + baseline * (1 - dataWeight),
    dataWeight,
    evidenceGames,
  };
}

/** Legacy three-season summary retained for diagnostics and comparison. */
export function computeDurability(history) {
  const rows = normalizeAvailabilityHistory(history).slice(0, 3);
  const rate = recentRate(rows);
  return {
    durabilityScore: rows.length >= MIN_USABLE_SEASONS && rate != null ? Number(rate.toFixed(4)) : null,
    usableSeasons: rows.length,
    perSeason: rows.map((row, index) => ({ ...row, weight: DURABILITY_RECENCY_WEIGHTS[index] })),
  };
}

function seasonAge(profile, season, currentSeason) {
  const age = finite(profile?.age);
  const referenceSeason = finite(profile?.ageReferenceSeason) ?? finite(currentSeason);
  return age == null || referenceSeason == null ? null : age - (referenceSeason - season);
}

function cohortRate(observations, predicate, globalRate, cohortPriorGames) {
  const rows = observations.filter(predicate);
  const totals = aggregateRate(rows);
  if (totals.rate == null) return { rate: globalRate, seasons: 0, eligibleGames: 0 };
  const dataWeight = totals.eligibleGames / (totals.eligibleGames + cohortPriorGames);
  return {
    rate: totals.rate * dataWeight + globalRate * (1 - dataWeight),
    seasons: rows.length,
    eligibleGames: totals.eligibleGames,
  };
}

/**
 * Data-derived age/experience baseline. No age receives a hard-coded bonus or
 * penalty; nearby historical observations are conservatively shrunk to the
 * league-wide availability rate when cohort data is thin.
 */
export function buildAvailabilityBaselineModel(profiles, currentSeason, model = AVAILABILITY_MODEL) {
  const config = { ...AVAILABILITY_MODEL, ...model };
  const observations = [];
  for (const profile of profiles || []) {
    const rows = normalizeAvailabilityHistory(profile?.history, {
      debutYear: profile?.debutYear,
      targetSeason: currentSeason,
    });
    for (const row of rows) {
      observations.push({
        ...row,
        age: seasonAge(profile, row.season, currentSeason),
        experience: finite(profile?.debutYear) == null ? null : row.season - Number(profile.debutYear),
      });
    }
  }
  const global = aggregateRate(observations);
  const globalRate = global.rate ?? DEFAULT_AVAILABILITY_BASELINE;

  return {
    globalRate: Number(globalRate.toFixed(4)),
    observationSeasons: observations.length,
    forPlayer(profile = {}) {
      const targetSeason = finite(profile.targetSeason) ?? finite(currentSeason);
      const targetAge = seasonAge(profile, targetSeason, currentSeason);
      const experience = finite(profile.debutYear) == null || targetSeason == null
        ? null
        : Math.max(0, targetSeason - Number(profile.debutYear));
      const ageCohort = targetAge == null
        ? { rate: globalRate, seasons: 0, eligibleGames: 0 }
        : cohortRate(observations, (row) => row.age != null && Math.abs(row.age - targetAge) <= config.cohortAgeWindow, globalRate, config.cohortPriorGames);
      const experienceCohort = experience == null
        ? { rate: globalRate, seasons: 0, eligibleGames: 0 }
        : cohortRate(observations, (row) => row.experience != null && Math.abs(row.experience - experience) <= config.cohortExperienceWindow, globalRate, config.cohortPriorGames);
      const baseline = (ageCohort.rate + experienceCohort.rate) / 2;
      return {
        rate: Number(Math.max(0, Math.min(1, baseline)).toFixed(4)),
        globalRate: Number(globalRate.toFixed(4)),
        targetAge,
        experience,
        ageCohort: { ...ageCohort, rate: Number(ageCohort.rate.toFixed(4)) },
        experienceCohort: { ...experienceCohort, rate: Number(experienceCohort.rate.toFixed(4)) },
      };
    },
  };
}

/** Backward-compatible scalar pool baseline. */
export function computeAvailabilityBaseline(histories) {
  return buildAvailabilityBaselineModel((histories || []).map((history) => ({ history })), null).globalRate;
}

export function classifyVerifiedInjury(injury) {
  const text = `${injury?.designation || ''} ${injury?.description || ''}`.trim().toLowerCase();
  if (!text) return { type: 'none', availabilityCap: null, reason: null };
  if (/season[- ]ending|out for (?:the )?season|miss (?:the )?(?:rest|remainder) of (?:the )?season|will not return this season/.test(text)) {
    return { type: 'verified_season_ending', availabilityCap: 0, reason: injury.description || injury.designation };
  }
  if (/indefinite|long[- ]term/.test(text)) {
    return { type: 'verified_long_term_unquantified', availabilityCap: null, reason: injury.description || injury.designation };
  }
  if (/rest|maintenance/.test(text)) {
    return { type: 'routine_rest', availabilityCap: null, reason: injury.description || injury.designation };
  }
  if (/questionable|game[- ]time|day[- ]to[- ]day|gtd|dtd|probable/.test(text)) {
    return { type: 'temporary_status', availabilityCap: null, reason: injury.description || injury.designation };
  }
  return { type: 'current_unquantified', availabilityCap: null, reason: injury.description || injury.designation };
}

export function seasonEndingInjury(injury) {
  const classified = classifyVerifiedInjury(injury);
  return classified.availabilityCap === 0
    ? { availabilityCap: 0, reason: classified.reason || 'Season-ending injury' }
    : null;
}

function historicalAvailabilityPattern(rows, threshold = AVAILABILITY_MODEL.lowAvailabilityThreshold) {
  if (!rows.length) return 'no_history';
  const low = rows.filter((row) => row.availability < threshold).length;
  if (low >= 2) return 'recurring_low_availability';
  if (low === 1) return 'isolated_low_availability';
  if (rows.every((row) => row.availability >= 0.85)) return 'consistently_high_availability';
  return 'mixed_availability';
}

/** Career-adjusted, recency-aware expected regular-season games. */
export function estimateExpectedGames(history, {
  baselineAvailability = DEFAULT_AVAILABILITY_BASELINE,
  baselineContext = null,
  age = null,
  debutYear = null,
  targetSeason = null,
  injury = null,
  model = AVAILABILITY_MODEL,
} = {}) {
  const config = { ...AVAILABILITY_MODEL, ...model };
  const rows = normalizeAvailabilityHistory(history, { debutYear, targetSeason });
  const recentRows = rows.slice(0, 3);
  const olderCareerRows = rows.slice(3); // disjoint: no season is counted in both components
  const career = aggregateRate(rows);
  const olderCareer = aggregateRate(olderCareerRows);
  const rawRecentRate = recentRate(recentRows);
  const baseline = Math.max(0, Math.min(1, Number(baselineContext?.rate ?? baselineAvailability) || DEFAULT_AVAILABILITY_BASELINE));
  const careerPosterior = shrinkRate(olderCareer.rate, olderCareerRows, baseline, config.playerPriorGames);
  const recentPosterior = shrinkRate(rawRecentRate, recentRows, baseline, config.playerPriorGames);
  let availability = config.careerWeight * careerPosterior.rate
    + config.recentWeight * recentPosterior.rate
    + config.baselineWeight * baseline;

  const verifiedInjury = classifyVerifiedInjury(injury);
  const preInjuryGames = EXPECTED_SEASON_GAMES * availability;
  if (verifiedInjury.availabilityCap != null) availability = Math.min(availability, verifiedInjury.availabilityCap);
  availability = Math.max(0, Math.min(1, availability));
  const expectedGames = Number((EXPECTED_SEASON_GAMES * availability).toFixed(1));
  const dataInfluence = (config.careerWeight * careerPosterior.dataWeight
    + config.recentWeight * recentPosterior.dataWeight)
    / (config.careerWeight + config.recentWeight);

  return {
    expectedGames,
    availability: Number(availability.toFixed(4)),
    careerRate: career.rate == null ? null : Number(career.rate.toFixed(4)),
    independentCareerRate: olderCareer.rate == null ? null : Number(olderCareer.rate.toFixed(4)),
    recentRate: rawRecentRate == null ? null : Number(rawRecentRate.toFixed(4)),
    careerPosteriorRate: Number(careerPosterior.rate.toFixed(4)),
    recentPosteriorRate: Number(recentPosterior.rate.toFixed(4)),
    baselineAvailability: Number(baseline.toFixed(4)),
    baselineContext,
    shrinkageFactor: Number((1 - dataInfluence).toFixed(4)),
    careerDataWeight: Number(careerPosterior.dataWeight.toFixed(4)),
    recentDataWeight: Number(recentPosterior.dataWeight.toFixed(4)),
    careerEvidenceGames: Number(careerPosterior.evidenceGames.toFixed(1)),
    recentEvidenceGames: Number(recentPosterior.evidenceGames.toFixed(1)),
    seasonsObserved: rows.length,
    recentSeasonsObserved: recentRows.length,
    independentCareerSeasonsObserved: olderCareerRows.length,
    age: finite(age),
    debutYear: finite(debutYear),
    perSeason: rows,
    historicalPattern: historicalAvailabilityPattern(rows, config.lowAvailabilityThreshold),
    injuryType: verifiedInjury.type,
    injuryCap: verifiedInjury.availabilityCap,
    injuryReason: verifiedInjury.reason,
    injuryAdjustmentGames: Number((expectedGames - preInjuryGames).toFixed(1)),
    availabilityPenaltyAppliedAgain: false,
  };
}

function legacyExpectedGames(history, baseline, options) {
  const rows = normalizeAvailabilityHistory(history, options).slice(0, 3);
  const rate = recentRate(rows) ?? baseline;
  return EXPECTED_SEASON_GAMES * rate;
}

function summarizeErrors(records) {
  const methods = ['careerAdjusted', 'legacyThreeSeason', 'careerOnly', 'leagueBaseline'];
  const result = { count: records.length };
  for (const method of methods) {
    result[method] = records.length
      ? Number((records.reduce((sum, row) => sum + Math.abs(row[method] - row.actual), 0) / records.length).toFixed(2))
      : null;
  }
  return result;
}

/** Rolling, no-lookahead MAE evaluation over supplied historical rows. */
export function backtestAvailabilityModels(profiles, currentSeason, { model = AVAILABILITY_MODEL } = {}) {
  const config = { ...AVAILABILITY_MODEL, ...model };
  const normalizedProfiles = (profiles || []).map((profile) => ({
    ...profile,
    history: normalizeAvailabilityHistory(profile.history, { debutYear: profile.debutYear, targetSeason: currentSeason }),
  }));
  const baselineByTarget = new Map();
  const records = [];
  for (const profile of normalizedProfiles) {
    for (const target of [...profile.history].sort((a, b) => a.season - b.season)) {
      const training = profile.history.filter((row) => row.season < target.season);
      if (!baselineByTarget.has(target.season)) {
        const trainingProfiles = normalizedProfiles.map((candidate) => ({
          ...candidate,
          history: candidate.history.filter((row) => row.season < target.season),
        }));
        baselineByTarget.set(target.season, buildAvailabilityBaselineModel(trainingProfiles, currentSeason, config));
      }
      const baselineModel = baselineByTarget.get(target.season);
      const profileAtTarget = { ...profile, targetSeason: target.season };
      const baselineContext = baselineModel.forPlayer(profileAtTarget);
      const prediction = estimateExpectedGames(training, {
        baselineContext,
        age: profile.age,
        debutYear: profile.debutYear,
        targetSeason: target.season,
        model: config,
      });
      const career = aggregateRate(training);
      const actual = EXPECTED_SEASON_GAMES * target.availability;
      const priorSeasonCount = training.length;
      records.push({
        actual,
        careerAdjusted: prediction.expectedGames,
        legacyThreeSeason: legacyExpectedGames(training, baselineContext.rate, { debutYear: profile.debutYear, targetSeason: target.season }),
        careerOnly: EXPECTED_SEASON_GAMES * (career.rate ?? baselineContext.rate),
        leagueBaseline: EXPECTED_SEASON_GAMES * baselineContext.rate,
        group: priorSeasonCount === 0 ? 'rookies' : priorSeasonCount === 1 ? 'secondYear' : 'veterans',
        lowPriorAvailability: career.rate != null && career.rate < config.lowAvailabilityThreshold,
      });
    }
  }
  return {
    overall: summarizeErrors(records),
    rookies: summarizeErrors(records.filter((row) => row.group === 'rookies')),
    secondYear: summarizeErrors(records.filter((row) => row.group === 'secondYear')),
    veterans: summarizeErrors(records.filter((row) => row.group === 'veterans')),
    lowPriorAvailability: summarizeErrors(records.filter((row) => row.lowPriorAvailability)),
  };
}
