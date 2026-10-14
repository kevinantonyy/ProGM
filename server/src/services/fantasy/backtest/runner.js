import { scoreStatLine } from '../scoring.js';
import { HISTORICAL_STAT_KEYS, snapshotToStatLine, validateHistoricalSnapshots } from './snapshot.js';
import { regressionMetrics, spearmanCorrelation } from './metrics.js';

function strictScore(statLine, statCategories) {
  const scored = scoreStatLine(statLine, statCategories);
  return scored.points != null && scored.unsupportedStats.length === 0 ? scored.points : null;
}

/** Current production preseason baseline: copy the immediately prior season line. */
export function lastSeasonStatLineBaseline({ history, targetSeason }) {
  const prior = history.find((row) => row.season === targetSeason - 1);
  if (!prior) return null;
  return {
    statLine: snapshotToStatLine(prior),
    expectedGames: prior.gamesPlayed,
    method: 'last_season_stat_line',
    sourceSeasons: [prior.season],
  };
}

function cohortKeys(target, prior) {
  const keys = [];
  if (target.experience != null) {
    if (target.experience <= 1) keys.push('early_career');
    else if (target.experience >= 8) keys.push('experienced');
    else keys.push('mid_career');
  }
  if (target.age != null) {
    if (target.age <= 24) keys.push('age_24_or_younger');
    else if (target.age >= 30) keys.push('age_30_or_older');
    else keys.push('age_25_to_29');
  }
  if (target.teamAbbr && prior?.teamAbbr) keys.push(target.teamAbbr === prior.teamAbbr ? 'same_team' : 'changed_team');
  return keys;
}

function summarize(records) {
  const perGameByStat = {};
  const seasonTotalByStat = {};
  for (const key of HISTORICAL_STAT_KEYS) {
    perGameByStat[key] = regressionMetrics(records.map((row) => [row.predictedStatLine[key], row.actualStatLine[key]]));
    seasonTotalByStat[key] = regressionMetrics(records.map((row) => [
      row.predictedStatLine[key] == null || row.predictedGames == null ? null : row.predictedStatLine[key] * row.predictedGames,
      row.actualStatLine[key] == null || row.actualGames == null ? null : row.actualStatLine[key] * row.actualGames,
    ]));
  }
  return {
    sampleCount: records.length,
    nbaStats: {
      minutesPerGame: regressionMetrics(records.map((row) => [row.predictedStatLine.minutes, row.actualStatLine.minutes])),
      perGame: perGameByStat,
      seasonTotal: seasonTotalByStat,
    },
    fantasy: {
      perGame: regressionMetrics(records.map((row) => [row.predictedFppg, row.actualFppg])),
      seasonTotal: regressionMetrics(records.map((row) => [row.predictedFantasyTotal, row.actualFantasyTotal])),
    },
  };
}

/**
 * Pure walk-forward evaluation. A predictor receives only rows whose season is
 * strictly earlier than its target; the target's actual stat line is withheld.
 */
export function runWalkForwardBacktest({ snapshots, statCategories, predictor = lastSeasonStatLineBaseline, targetSeasons = null }) {
  const validation = validateHistoricalSnapshots(snapshots);
  if (!validation.valid) throw new Error(`Invalid historical snapshots: ${validation.errors.join(' ')}`);

  const ordered = [...snapshots].sort((a, b) => a.season - b.season || a.player.id.localeCompare(b.player.id));
  const allSeasons = [...new Set(ordered.map((row) => row.season))].sort((a, b) => a - b);
  const selectedSeasons = targetSeasons == null ? allSeasons.slice(1) : [...new Set(targetSeasons.map(Number))].sort((a, b) => a - b);
  const records = [];
  const seasonReports = [];
  const foldModels = [];
  let targetCount = 0;
  let scoringCompleteTargets = 0;

  for (const targetSeason of selectedSeasons) {
    const training = ordered.filter((row) => row.season < targetSeason);
    const targets = ordered.filter((row) => row.season === targetSeason);
    const foldPredictor = predictor && typeof predictor.fit === 'function'
      ? predictor.fit({ training, targetSeason, statCategories })
      : predictor;
    if (foldPredictor?.diagnostics) foldModels.push(foldPredictor.diagnostics);
    targetCount += targets.length;
    const seasonRecords = [];
    for (const target of targets) {
      const actualStatLine = snapshotToStatLine(target);
      const actualFppg = strictScore(actualStatLine, statCategories);
      if (actualFppg != null) scoringCompleteTargets += 1;
      const history = training.filter((row) => row.player.id === target.player.id).sort((a, b) => b.season - a.season);
      const prediction = foldPredictor({
        targetSeason,
        player: { ...target.player },
        history,
        training,
        statCategories,
      });
      if (!prediction?.statLine) continue;
      const predictedFppg = strictScore(prediction.statLine, statCategories);
      const predictedGames = prediction.expectedGames ?? null;
      const actualGames = target.gamesPlayed ?? null;
      const record = {
        targetSeason,
        playerId: target.player.id,
        predictedStatLine: prediction.statLine,
        actualStatLine,
        predictedGames,
        actualGames,
        predictedFppg,
        actualFppg,
        predictedFantasyTotal: predictedFppg == null || predictedGames == null ? null : predictedFppg * predictedGames,
        actualFantasyTotal: actualFppg == null || actualGames == null ? null : actualFppg * actualGames,
        cohorts: cohortKeys(target, history[0]),
      };
      records.push(record);
      seasonRecords.push(record);
    }
    const fppgPairs = seasonRecords.map((row) => [row.predictedFppg, row.actualFppg]);
    const totalPairs = seasonRecords.map((row) => [row.predictedFantasyTotal, row.actualFantasyTotal]);
    seasonReports.push({
      season: targetSeason,
      targets: targets.length,
      predictions: seasonRecords.length,
      fppgRankCorrelation: spearmanCorrelation(fppgPairs),
      seasonTotalRankCorrelation: spearmanCorrelation(totalPairs),
    });
  }

  const summary = summarize(records);
  const cohortNames = [...new Set(records.flatMap((row) => row.cohorts))].sort();
  const cohorts = Object.fromEntries(cohortNames.map((name) => [name, summarize(records.filter((row) => row.cohorts.includes(name)))]));
  const comparable = records.filter((row) => row.predictedFppg != null && row.actualFppg != null).length;
  const weightedRank = (field) => {
    const usable = seasonReports.map((row) => row[field]).filter((value) => value.correlation != null);
    const count = usable.reduce((sum, value) => sum + value.count, 0);
    return {
      count,
      correlation: count ? Number((usable.reduce((sum, value) => sum + value.correlation * value.count, 0) / count).toFixed(4)) : null,
    };
  };

  return {
    model: predictor === lastSeasonStatLineBaseline ? 'last_season_stat_line' : (predictor.name || 'custom'),
    targetSeasons: selectedSeasons,
    coverage: {
      targets: targetCount,
      predictions: records.length,
      predictionRate: targetCount ? Number((records.length / targetCount).toFixed(4)) : null,
      scoringCompleteTargets,
      fantasyComparable: comparable,
      fantasyCoverageRate: targetCount ? Number((comparable / targetCount).toFixed(4)) : null,
    },
    ...summary,
    rankCorrelation: {
      fantasyPerGame: weightedRank('fppgRankCorrelation'),
      fantasySeasonTotal: weightedRank('seasonTotalRankCorrelation'),
      bySeason: seasonReports,
    },
    cohorts,
    foldModels,
  };
}
