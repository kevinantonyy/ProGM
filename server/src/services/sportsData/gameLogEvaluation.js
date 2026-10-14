import { chronologicalSplit } from '../fantasy/backtest/evaluation.js';
import { RECENT_WEIGHT, SEASON_WEIGHT } from '../fantasy/projection.js';
import { scoreStatLine } from '../fantasy/scoring.js';
import { emptyStatLine } from '../providers/types.js';
import { accuracyMetrics } from '../predictionTracking/accuracy.js';
import { evaluationProvenance, ingestionBlockers, normalizeSource } from './sourcePermissions.js';

/**
 * Game-level fantasy-point evaluation over stored, authorized player game logs.
 * Every prediction for a game uses only that player's games on EARLIER dates.
 * Seasons are split chronologically: train seasons only supply history,
 * hyperparameters are chosen on validation seasons, and test seasons are scored
 * once with the selection frozen. Models are compared on identical games.
 */
export const GAME_EVALUATION_VERSION = 'progm.game-log-evaluation.v1';

function gameStatLine(stats) {
  const line = emptyStatLine();
  line.gamesPlayed = 1;
  for (const key of Object.keys(line)) if (key in stats) line[key] = stats[key];
  const counting = ['points', 'rebounds', 'assists', 'steals', 'blocks'].map((key) => stats[key]);
  if (counting.every((value) => value != null)) {
    const tens = counting.filter((value) => value >= 10).length;
    line.doubleDoubles = tens >= 2 ? 1 : 0;
    line.tripleDoubles = tens >= 3 ? 1 : 0;
  }
  return line;
}

/** Fantasy points for one game under league scoring; null when a scored category is missing. */
export function gameFantasyPoints(stats, statCategories) {
  const scored = scoreStatLine(gameStatLine(stats), statCategories);
  return scored.points != null && scored.unsupportedStats.length === 0 ? scored.points : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function priorSeasonMean(history, season) {
  return mean(history.filter((game) => game.season === season - 1).map((game) => game.fantasyPoints));
}

/** Baseline: the player's mean fantasy points over the previous season. */
export function previousSeasonBaseline({ history, target }) {
  return priorSeasonMean(history, target.season);
}

/**
 * Recency model: exponentially weighted mean of the last `window` games (any
 * season), shrunk toward the previous-season mean with weight `priorWeight`.
 */
export function recencyBlend({ halfLife, priorWeight, window = 30 }) {
  const model = ({ history, target }) => {
    if (!history.length) return null;
    const recent = history.slice(-window).reverse();
    let weightSum = 0;
    let weighted = 0;
    recent.forEach((game, age) => {
      const weight = 0.5 ** (age / halfLife);
      weightSum += weight;
      weighted += weight * game.fantasyPoints;
    });
    const prior = priorSeasonMean(history, target.season);
    return prior == null ? weighted / weightSum : (weighted + priorWeight * prior) / (weightSum + priorWeight);
  };
  model.config = { halfLife, priorWeight, window };
  return model;
}

export function defaultCandidates() {
  const candidates = {};
  for (const halfLife of [5, 10, 20]) for (const priorWeight of [2, 8]) candidates[`recency_h${halfLife}_k${priorWeight}`] = recencyBlend({ halfLife, priorWeight });
  return candidates;
}

// Mirrors freeNbaProvider RECENT_GAMES_PER_TEAM (production recent-form window).
export const PRODUCTION_RECENT_GAMES_PER_TEAM = 10;

/**
 * Offline reproduction of ProGM's in-season projection (insights.js and
 * projection.js): last completed season per-game line blended with recent form,
 * SEASON_WEIGHT/RECENT_WEIGHT. Recent form is the player's games among the union
 * of every team's last 10 completed games of the current season (getRecentForm),
 * before the target date. No last-season line gives no projection; no recent
 * games gives last season only. Blending fantasy points equals blending stat
 * lines and then scoring, because points scoring is linear in the stats.
 */
export function existingProgmModel({ history, target, context }) {
  const prior = priorSeasonMean(history, target.season);
  if (prior == null) return null;
  const window = context?.recentGameIds?.(target.season, target.date);
  const recent = window ? history.filter((game) => game.season === target.season && window.has(game.gameId)) : [];
  return recent.length ? SEASON_WEIGHT * prior + RECENT_WEIGHT * mean(recent.map((game) => game.fantasyPoints)) : prior;
}

export function ensembleModel(existingWeight, recencyModel) {
  const model = (input) => {
    const existing = existingProgmModel(input);
    const recency = recencyModel(input);
    if (!Number.isFinite(existing) || !Number.isFinite(recency)) return null;
    return existingWeight * existing + (1 - existingWeight) * recency;
  };
  model.config = { existingWeight, recency: recencyModel.config ?? null };
  return model;
}

/** League-wide recent-game window per (season, date), built only from games before that date. */
export function createRecentWindowContext(teamGames, perTeam = PRODUCTION_RECENT_GAMES_PER_TEAM) {
  const cache = new Map();
  return {
    recentGameIds(season, date) {
      const key = `${season}|${date}`;
      if (!cache.has(key)) {
        const ids = new Set();
        for (const games of teamGames.values()) {
          const before = games.filter((game) => game.season === season && game.date < date);
          for (const game of before.slice(-perTeam)) ids.add(game.gameId);
        }
        cache.set(key, ids);
      }
      return cache.get(key);
    },
  };
}

export function performanceTier(priorSeasonFppg) {
  if (priorSeasonFppg == null) return 'no_prior_season';
  if (priorSeasonFppg < 15) return 'under_15';
  if (priorSeasonFppg < 25) return '15_to_25';
  if (priorSeasonFppg < 35) return '25_to_35';
  return '35_plus';
}

async function queryAll(store, kind, sport, filters) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await store.query(kind, sport, filters, { limit: 1000, offset });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Build per-player chronological logs of played regular-season games. */
export async function loadPlayerGameLogs(store, { sourceKey, statCategories }) {
  const stored = await store.getSource(sourceKey);
  if (!stored) throw new Error(`Source ${sourceKey} is not registered.`);
  const source = normalizeSource(stored);
  const blockers = ingestionBlockers(source, 'basketball');
  if (blockers.length) throw new Error(`Evaluation refused for source ${sourceKey}: ${blockers.join('; ')}.`);
  const provenance = evaluationProvenance(source, stored.updatedAt); // requires modelTraining
  const games = new Map((await queryAll(store, 'games', 'basketball', { sourceKey, seasonType: 'regular' })).map((game) => [game.externalId, game]));
  const players = new Map();
  for (const row of await queryAll(store, 'playerGameStats', 'basketball', { sourceKey, seasonType: 'regular' })) {
    const game = games.get(row.gameId);
    if (!game?.gameDate || row.didNotPlay || !(row.stats.minutes > 0)) continue;
    const fantasyPoints = gameFantasyPoints(row.stats, statCategories);
    if (fantasyPoints == null) continue;
    const list = players.get(row.playerId) || [];
    list.push({ gameId: row.gameId, date: game.gameDate, season: row.season, teamId: row.teamId, fantasyPoints });
    players.set(row.playerId, list);
  }
  for (const list of players.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId < b.gameId ? -1 : 1));
  const teamGames = new Map();
  for (const game of games.values()) {
    if (!game.gameDate) continue;
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      const list = teamGames.get(teamId) || [];
      list.push({ gameId: game.externalId, date: game.gameDate, season: game.season });
      teamGames.set(teamId, list);
    }
  }
  for (const list of teamGames.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId < b.gameId ? -1 : 1));
  return { players, teamGames, context: createRecentWindowContext(teamGames), provenance };
}

function groupBy(keys, actuals, field) {
  return [...new Set(keys.map((key) => actuals.get(key)[field]))].sort();
}

function predictPhase(players, models, seasons, include = null, context = null) {
  const wanted = new Set(seasons);
  const inPhase = include || ((game) => wanted.has(game.season));
  const records = Object.fromEntries(Object.keys(models).map((key) => [key, new Map()]));
  const actuals = new Map();
  for (const [playerId, games] of players) {
    let earlier = 0; // games strictly before the current date
    for (let index = 0; index < games.length; index += 1) {
      const game = games[index];
      while (earlier < index && games[earlier].date < game.date) earlier += 1;
      if (!inPhase(game)) continue;
      const history = games.slice(0, earlier);
      const target = { playerId, season: game.season, date: game.date, teamId: game.teamId ?? null };
      const key = `${playerId}|${game.gameId}`;
      actuals.set(key, { season: game.season, actual: game.fantasyPoints, month: game.date.slice(0, 7), tier: performanceTier(priorSeasonMean(history, game.season)) });
      for (const [name, model] of Object.entries(models)) {
        const predicted = model({ history, target, context });
        if (Number.isFinite(predicted)) records[name].set(key, predicted);
      }
    }
  }
  const common = [...actuals.keys()].filter((key) => Object.values(records).every((map) => map.has(key)));
  const summary = {};
  for (const name of Object.keys(models)) {
    const pairs = (filter) => common.filter(filter).map((key) => [records[name].get(key), actuals.get(key).actual]);
    summary[name] = {
      coverage: records[name].size,
      overall: accuracyMetrics(pairs(() => true)),
      bySeason: seasons.map((season) => ({ season, ...accuracyMetrics(pairs((key) => actuals.get(key).season === season)) })),
      byMonth: groupBy(common, actuals, 'month').map((month) => ({ month, ...accuracyMetrics(pairs((key) => actuals.get(key).month === month)) })),
      byTier: groupBy(common, actuals, 'tier').map((tier) => ({ tier, ...accuracyMetrics(pairs((key) => actuals.get(key).tier === tier)) })),
    };
  }
  return { seasons, targetGames: actuals.size, commonSampleCount: common.length, models: summary };
}

/**
 * @param {{players:Map, provenance:object}} logs  from loadPlayerGameLogs
 */
function resolveSplit(logs, { validationSeasons = 1, testSeasons = 1, minTrainSeasons = 1, dateSplit = null }) {
  const seasons = [...new Set([...logs.players.values()].flatMap((games) => games.map((game) => game.season)))];
  if (dateSplit) {
    const { season, testFrom } = dateSplit;
    if (!seasons.includes(season) || !/^\d{4}-\d{2}-\d{2}$/.test(String(testFrom))) throw new Error('dateSplit needs a stored season and a YYYY-MM-DD testFrom.');
    return {
      split: { train: seasons.filter((value) => value < season).sort((a, b) => a - b), validation: [season], test: [season], testFrom },
      validationFilter: (game) => game.season === season && game.date < testFrom,
      testFilter: (game) => game.season === season && game.date >= testFrom,
    };
  }
  return { split: chronologicalSplit(seasons, { validationSeasons, testSeasons, minTrainSeasons }), validationFilter: null, testFilter: null };
}

/**
 * `dateSplit: { season, testFrom }` splits ONE season by date when too few complete
 * seasons exist: earlier seasons are history only, games before `testFrom`
 * validate, games on or after it test. Otherwise whole seasons are split.
 */
export function runGameLogEvaluation({ logs, candidates = defaultCandidates(), validationSeasons = 1, testSeasons = 1, minTrainSeasons = 1, dateSplit = null }) {
  const { split, validationFilter, testFilter } = resolveSplit(logs, { validationSeasons, testSeasons, minTrainSeasons, dateSplit });
  const models = { baseline: previousSeasonBaseline, ...candidates };

  const validation = predictPhase(logs.players, models, split.validation, validationFilter, logs.context);
  const ranked = Object.keys(candidates).filter((key) => validation.models[key].overall.mae != null)
    .sort((a, b) => validation.models[a].overall.mae - validation.models[b].overall.mae || (a < b ? -1 : 1));
  const selected = ranked[0] ?? null;

  const testModels = selected ? { baseline: previousSeasonBaseline, [selected]: candidates[selected] } : { baseline: previousSeasonBaseline };
  const test = predictPhase(logs.players, testModels, split.test, testFilter, logs.context);
  const base = test.models.baseline;
  const chosen = selected ? test.models[selected] : null;
  return {
    evaluationVersion: GAME_EVALUATION_VERSION,
    level: 'game',
    source: { name: logs.provenance.name, synthetic: logs.provenance.synthetic === true },
    split,
    selection: { metric: 'validation common-game MAE', selectedModel: selected, config: selected ? candidates[selected].config ?? null : null },
    validation,
    test,
    testComparison: {
      selectedModel: selected,
      sampleCount: test.commonSampleCount,
      mae: { baseline: base.overall.mae, selected: chosen?.overall.mae ?? null },
      maeChange: chosen && base.overall.mae ? Number(((chosen.overall.mae - base.overall.mae) / base.overall.mae).toFixed(4)) : null,
      seasonsImproved: chosen ? chosen.bySeason.filter((row, i) => row.mae != null && base.bySeason[i].mae != null && row.mae < base.bySeason[i].mae).length : 0,
      seasonsCompared: base.bySeason.filter((row) => row.mae != null).length,
    },
    accuracyStatus: logs.provenance.synthetic === true ? 'synthetic_only_unvalidated' : 'historical_game_level_not_production_approved',
  };
}

export function recencyGrid(halfLives = [2, 3, 5, 10, 20], priorWeights = [0, 1, 2, 4, 8]) {
  const grid = {};
  for (const halfLife of halfLives) for (const priorWeight of priorWeights) grid[`recency_h${halfLife}_k${priorWeight}`] = recencyBlend({ halfLife, priorWeight });
  return grid;
}

function rankByMae(phase, keys) {
  return keys.filter((key) => phase.models[key].overall.mae != null)
    .sort((a, b) => phase.models[a].overall.mae - phase.models[b].overall.mae || (a < b ? -1 : 1));
}

function improvement(value, reference) {
  return value == null || !reference ? null : Number((((reference - value) / reference) * 100).toFixed(2));
}

/**
 * Four-way comparison: previous-season baseline, the existing ProGM model,
 * the recency model and an existing+recency ensemble. Recency settings
 * (stage 1) and the ensemble weight (stage 2) are chosen on validation only;
 * the test phase then scores all four once, on identical games.
 */
export function runEnsembleEvaluation({ logs, dateSplit = null, validationSeasons = 1, testSeasons = 1, minTrainSeasons = 1, grid = recencyGrid(), weights = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] }) {
  const { split, validationFilter, testFilter } = resolveSplit(logs, { validationSeasons, testSeasons, minTrainSeasons, dateSplit });
  const fixed = { baseline: previousSeasonBaseline, existing: existingProgmModel };

  const stage1 = predictPhase(logs.players, { ...fixed, ...grid }, split.validation, validationFilter, logs.context);
  const recencyKey = rankByMae(stage1, Object.keys(grid))[0];
  const recency = grid[recencyKey];

  const ensembles = Object.fromEntries(weights.map((weight) => [`ensemble_w${Math.round(weight * 100)}`, ensembleModel(weight, recency)]));
  const stage2 = predictPhase(logs.players, { ...fixed, recency, ...ensembles }, split.validation, validationFilter, logs.context);
  const ensembleKey = rankByMae(stage2, Object.keys(ensembles))[0];

  const test = predictPhase(logs.players, { ...fixed, recency, ensemble: ensembles[ensembleKey] }, split.test, testFilter, logs.context);
  const existingMae = test.models.existing.overall.mae;
  const summary = Object.fromEntries(Object.entries(test.models).map(([key, value]) => [key, { ...value.overall, maeImprovementVsExistingPct: improvement(value.overall.mae, existingMae) }]));
  const best = rankByMae(test, Object.keys(test.models))[0];
  return {
    evaluationVersion: GAME_EVALUATION_VERSION,
    level: 'game',
    source: { name: logs.provenance.name, synthetic: logs.provenance.synthetic === true },
    split,
    selection: {
      recency: { model: recencyKey, config: recency.config, validationMae: stage1.models[recencyKey].overall.mae },
      ensemble: { model: ensembleKey, existingWeight: ensembles[ensembleKey].config.existingWeight, validationMae: stage2.models[ensembleKey].overall.mae },
      recencyGridValidationMae: Object.fromEntries(Object.keys(grid).map((key) => [key, stage1.models[key].overall.mae])),
      ensembleWeightValidationMae: Object.fromEntries(Object.keys(ensembles).map((key) => [key, stage2.models[key].overall.mae])),
    },
    validation: { commonSampleCount: stage2.commonSampleCount, models: Object.fromEntries(['baseline', 'existing', 'recency', ensembleKey].map((key) => [key, stage2.models[key].overall])) },
    test,
    testSummary: summary,
    bestTestModel: best,
    accuracyStatus: logs.provenance.synthetic === true ? 'synthetic_only_unvalidated' : 'historical_game_level_not_production_approved',
  };
}
