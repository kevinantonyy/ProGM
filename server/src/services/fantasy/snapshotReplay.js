/**
 * Offline replay of the draft-value stage on a sanitized league snapshot, with the experimental options applied:
 * the model (legacy | v2) and ADP-implied estimates for classified incoming rookies.
 *
 * Replayed exactly: replacement baselines, scarcity weights, pool maximum and computeDraftValue, all called from
 * production code on the league's own roster slots and the snapshot's pool. Taken from the snapshot, not recomputed:
 * each veteran's per-game points, expected games and confidence (their upstream inputs are not in a saved response).
 * A self-check replays the legacy model without rookies and compares it with the ranks the app actually showed.
 */
import { computeDraftValue, computeReplacementBaselines } from './draftHelper.js';
import { scarcityWeights } from './playerValue.js';
import { ESTIMATE_CONFIDENCE, MIN_CALIBRATION_GAMES, fitMarketPrior, marketPriorPerGame } from './marketPrior.js';
import { classifyUnprojected, lastSeasonCutoff } from './unprojectedClass.js';

const EXPECTED_SEASON_GAMES = 82;

function competitionRanks(values) {
  const sorted = [...values].sort((a, b) => b - a);
  return values.map((v) => 1 + sorted.filter((o) => o > v).length);
}
const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export function replayPipeline(clean, { model = 'legacy', rookieEstimates = false } = {}) {
  if (!clean.league?.rosterSlots?.length) throw new Error('The snapshot has no league roster settings, so the value stage cannot be replayed.');
  const settings = { teamCount: clean.league.teamCount || 12, rosterSlots: clean.league.rosterSlots };
  const rows = clean.board.filter((r) => r.components.perGame != null && r.components.expectedGames != null).map((r) => ({
    name: r.name, eligiblePositions: r.eligiblePositions, perGame: r.components.perGame, expectedSeasonGames: r.components.expectedGames,
    seasonPoints: r.components.perGame * r.components.expectedGames, confidence: Math.max(0, Math.min(1, (r.components.confidenceFactor - 0.9) / 0.1)),
    estimate: false, legacySnapshotRank: r.overallRank, yahooAdp: r.yahooAdp,
  }));
  const rookieInfo = [];
  if (rookieEstimates) {
    const calibration = clean.board.filter((r) => !r.estimate && r.yahooAdp != null && (r.lastSeasonGamesPlayed ?? 0) >= MIN_CALIBRATION_GAMES && r.components.perGame != null).map((r) => ({ adp: r.yahooAdp, perGame: r.components.perGame }));
    const fit = fitMarketPrior(calibration);
    const cutoff = lastSeasonCutoff(clean.board.map((r) => ({ playerNumber: r.yahooPlayerNumber, hasRealStats: !r.estimate && r.components.perGame != null })));
    const globalRate = clean.meta.noHistoryGamesRate;
    for (const n of clean.noData) {
      const verdict = classifyUnprojected({ playerNumber: n.yahooPlayerNumber, cutoff, matched: false, status: n.injuryStatus, scoringGap: /league scoring/i.test(n.noDataReason || '') });
      if (verdict.class !== 'rookie_or_new_entrant' || !fit || n.yahooAdp == null || globalRate == null) continue;
      const pg = marketPriorPerGame(fit, n.yahooAdp);
      if (pg == null) continue;
      const games = Number((EXPECTED_SEASON_GAMES * globalRate).toFixed(1)); // production: no history -> league-wide availability
      const row = { name: n.name, eligiblePositions: n.eligiblePositions, perGame: pg, expectedSeasonGames: games, seasonPoints: pg * games, confidence: ESTIMATE_CONFIDENCE, estimate: true, legacySnapshotRank: null, yahooAdp: n.yahooAdp, statusNote: verdict.statusNote ?? null };
      rows.push(row); rookieInfo.push(row);
    }
  }
  const replacement = computeReplacementBaselines(rows, settings);
  const weights = scarcityWeights(settings, rows);
  const poolMax = rows.reduce((m, r) => Math.max(m, r.seasonPoints), 0);
  const values = rows.map((r) => computeDraftValue({
    seasonPoints: r.seasonPoints, perGame: r.perGame, expectedGames: r.expectedSeasonGames, confidence: r.confidence, eligiblePositions: r.eligiblePositions,
    weights, poolMaxSeasonPoints: poolMax, replacement, rosterFitScore: 0.5, rankingModel: model,
  }).value);
  const ranks = competitionRanks(values);
  return { model, rookieEstimates, replacement, rows: rows.map((r, i) => ({ ...r, value: values[i], rank: ranks[i] })) };
}

/** Compare the replay of the production setting with the ranks the app actually displayed (fidelity of the replay). */
export function fidelity(clean) {
  const base = replayPipeline(clean, { model: 'legacy', rookieEstimates: false });
  const diffs = base.rows.filter((r) => r.legacySnapshotRank != null).map((r) => Math.abs(r.rank - r.legacySnapshotRank));
  const n = diffs.length;
  return { players: n, exactRankMatches: diffs.filter((d) => d === 0).length, within2Ranks: diffs.filter((d) => d <= 2).length, maxAbsRankDifference: Math.max(0, ...diffs), meanAbsRankDifference: Number((diffs.reduce((s, d) => s + d, 0) / (n || 1)).toFixed(2)) };
}

const byName = (rows) => new Map(rows.map((r) => [r.name, r]));

export function compareScenarios(clean, { highlight = [] } = {}) {
  const production = replayPipeline(clean, { model: 'legacy', rookieEstimates: false });
  const v2 = replayPipeline(clean, { model: 'v2', rookieEstimates: false });
  const full = replayPipeline(clean, { model: 'v2', rookieEstimates: true });
  const prodBy = byName(production.rows), v2By = byName(v2.rows), fullBy = byName(full.rows);
  const bands = {};
  for (const n of [25, 50, 100]) {
    const topSet = (rows) => new Set(rows.filter((r) => r.rank <= n).map((r) => r.name));
    const a = topSet(production.rows), b = topSet(full.rows);
    bands[`top${n}`] = {
      overlap: [...a].filter((x) => b.has(x)).length, size: { legacy: a.size, experimental: b.size },
      entering: [...b].filter((x) => !a.has(x)).map((x) => `${x} (legacy #${prodBy.get(x)?.rank ?? 'n/a'} -> #${fullBy.get(x).rank})`),
      leaving: [...a].filter((x) => !b.has(x)).map((x) => `${x} (legacy #${prodBy.get(x).rank} -> #${fullBy.get(x).rank})`),
    };
  }
  const movers = full.rows.filter((r) => !r.estimate && prodBy.has(r.name) && (prodBy.get(r.name).rank <= 100 || r.rank <= 100))
    .map((r) => ({ name: r.name, positions: r.eligiblePositions.filter((p) => p !== 'UTIL').join('/'), legacy: prodBy.get(r.name).rank, v2: v2By.get(r.name).rank, experimental: r.rank, change: prodBy.get(r.name).rank - r.rank }))
    .filter((m) => Math.abs(m.change) >= 10).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 25);
  const rookies = full.rows.filter((r) => r.estimate).sort((a, b) => a.rank - b.rank).map((r) => ({
    name: r.name, positions: r.eligiblePositions.filter((p) => p !== 'UTIL').join('/'), yahooAdp: r.yahooAdp, impliedFantasyPointsPerGame: r1(r.perGame), expectedGames: r.expectedSeasonGames,
    projectedSeasonPoints: Math.round(r.seasonPoints), confidence: r.confidence, proGMRank: r.rank, value: r1(r.value), poolSize: full.rows.length, statusNote: r.statusNote,
  }));
  // Veterans pushed down only because rookies joined the pool (same model, with vs without rookies).
  const displaced = v2.rows.filter((r) => fullBy.get(r.name).rank > r.rank).length;
  const highlighted = highlight.map((name) => {
    const k = [...prodBy.keys()].find((x) => x.toLowerCase() === String(name).toLowerCase());
    return k ? { name: k, legacy: prodBy.get(k).rank, v2: v2By.get(k).rank, experimental: fullBy.get(k).rank, perGame: r1(prodBy.get(k).perGame), expectedGames: prodBy.get(k).expectedSeasonGames } : { name, found: false };
  });
  return { poolSizes: { production: production.rows.length, experimental: full.rows.length }, bands, rookies, majorMovers: movers, veteransDisplacedByRookies: displaced, highlighted };
}

/** Evidence on whether Yahoo player numbers behave like creation order, using ESPN debut years already in the payload. */
export function playerNumberEvidence(clean) {
  const withBoth = clean.board.filter((r) => Number.isFinite(r.yahooPlayerNumber) && Number.isFinite(r.debutYear));
  const cohorts = {};
  for (const r of withBoth) { const c = (cohorts[r.debutYear] ||= { n: 0, min: Infinity, max: -Infinity }); c.n += 1; c.min = Math.min(c.min, r.yahooPlayerNumber); c.max = Math.max(c.max, r.yahooPlayerNumber); }
  const years = Object.keys(cohorts).map(Number).sort((a, b) => a - b);
  const latest = years.slice(-4).map((y) => ({ debutYear: y, players: cohorts[y].n, minNumber: cohorts[y].min, maxNumber: cohorts[y].max }));
  // rank correlation between number and debut year
  const rank = (a) => { const s = [...a].sort((x, y) => x - y); return a.map((v) => s.indexOf(v) + 0.5 * (s.lastIndexOf(v) - s.indexOf(v))); };
  const rx = rank(withBoth.map((r) => r.yahooPlayerNumber)), ry = rank(withBoth.map((r) => r.debutYear));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  const num = rx.reduce((s, v, i) => s + (v - mx) * (ry[i] - my), 0);
  const den = Math.sqrt(rx.reduce((s, v) => s + (v - mx) ** 2, 0) * ry.reduce((s, v) => s + (v - my) ** 2, 0));
  const newest = [...withBoth].sort((a, b) => b.yahooPlayerNumber - a.yahooPlayerNumber).slice(0, 8).map((r) => ({ name: r.name, debutYear: r.debutYear, yahooPlayerNumber: r.yahooPlayerNumber }));
  const minLatestDebut = years.length ? Math.max(...years) : null;
  const veteransAboveLatestCohortMin = minLatestDebut == null ? null : withBoth.filter((r) => r.debutYear < minLatestDebut && r.yahooPlayerNumber > cohorts[minLatestDebut].min).map((r) => ({ name: r.name, debutYear: r.debutYear, yahooPlayerNumber: r.yahooPlayerNumber }));
  return {
    playersWithNumberAndDebutYear: withBoth.length, spearmanNumberVsDebutYear: Number((den ? num / den : NaN).toFixed(3)),
    newestCohorts: latest, highestNumbersWithStats: newest,
    veteransNumberedAboveTheNewestStatCohort: veteransAboveLatestCohortMin,
    reading: 'A reliable ordering shows a high correlation and no player with an older debut year numbered above the newest stat-bearing cohort.',
  };
}
