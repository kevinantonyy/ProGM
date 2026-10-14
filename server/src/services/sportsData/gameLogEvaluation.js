import { chronologicalSplit } from '../fantasy/backtest/evaluation.js';
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
    list.push({ gameId: row.gameId, date: game.gameDate, season: row.season, fantasyPoints });
    players.set(row.playerId, list);
  }
  for (const list of players.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.gameId < b.gameId ? -1 : 1));
  return { players, provenance };
}

function predictPhase(players, models, seasons) {
  const wanted = new Set(seasons);
  const records = Object.fromEntries(Object.keys(models).map((key) => [key, new Map()]));
  const actuals = new Map();
  for (const [playerId, games] of players) {
    let earlier = 0; // games strictly before the current date
    for (let index = 0; index < games.length; index += 1) {
      const game = games[index];
      while (earlier < index && games[earlier].date < game.date) earlier += 1;
      if (!wanted.has(game.season)) continue;
      const history = games.slice(0, earlier);
      const target = { playerId, season: game.season, date: game.date };
      const key = `${playerId}|${game.gameId}`;
      actuals.set(key, { season: game.season, actual: game.fantasyPoints });
      for (const [name, model] of Object.entries(models)) {
        const predicted = model({ history, target });
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
    };
  }
  return { seasons, targetGames: actuals.size, commonSampleCount: common.length, models: summary };
}

/**
 * @param {{players:Map, provenance:object}} logs  from loadPlayerGameLogs
 */
export function runGameLogEvaluation({ logs, candidates = defaultCandidates(), validationSeasons = 1, testSeasons = 1, minTrainSeasons = 1 }) {
  const seasons = [...new Set([...logs.players.values()].flatMap((games) => games.map((game) => game.season)))];
  const split = chronologicalSplit(seasons, { validationSeasons, testSeasons, minTrainSeasons });
  const models = { baseline: previousSeasonBaseline, ...candidates };

  const validation = predictPhase(logs.players, models, split.validation);
  const ranked = Object.keys(candidates).filter((key) => validation.models[key].overall.mae != null)
    .sort((a, b) => validation.models[a].overall.mae - validation.models[b].overall.mae || (a < b ? -1 : 1));
  const selected = ranked[0] ?? null;

  const testModels = selected ? { baseline: previousSeasonBaseline, [selected]: candidates[selected] } : { baseline: previousSeasonBaseline };
  const test = predictPhase(logs.players, testModels, split.test);
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
