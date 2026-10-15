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
import { normalizeName } from '../identity/playerIdentity.js';
import { SCENARIOS, effectiveSeasonPoints } from './replacementAware.js';

const EXPECTED_SEASON_GAMES = 82;

function competitionRanks(values) {
  const sorted = [...values].sort((a, b) => b - a);
  return values.map((v) => 1 + sorted.filter((o) => o > v).length);
}
const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));

export function replayPipeline(clean, { model = 'legacy', rookieEstimates = false, rookieOverrides = null, replacement: repl = null } = {}) {
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
      const games = rookieOverrides?.games ?? Number((EXPECTED_SEASON_GAMES * globalRate).toFixed(1)); // production: no history -> league-wide availability
      const row = { name: n.name, eligiblePositions: n.eligiblePositions, perGame: pg, expectedSeasonGames: games, seasonPoints: pg * games, confidence: rookieOverrides?.confidence ?? ESTIMATE_CONFIDENCE, estimate: true, legacySnapshotRank: null, yahooAdp: n.yahooAdp, statusNote: verdict.statusNote ?? null };
      rows.push(row); rookieInfo.push(row);
    }
  }
  // Optional prototype: value rows on the slot's effective output (missed games partly covered by a replacement).
  if (repl && repl.rho > 0) {
    const eff = effectiveSeasonPoints(rows, settings, repl);
    rows.forEach((r, i) => { r.seasonPointsPlain = r.seasonPoints; r.seasonPoints = eff[i]; });
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

/**
 * Compare the replay of the production setting with the ranks the app actually displayed.
 * Mismatches are explained: the snapshot stores per-game points to 2 decimals, games to 1 and the confidence factor to 3,
 * so the replayed value can differ slightly from the unrounded value the app used. A mismatch is "explained by rounding"
 * when its nearest rival in value is closer than the largest value change those roundings can cause.
 */
export function fidelity(clean) {
  const base = replayPipeline(clean, { model: 'legacy', rookieEstimates: false });
  const settings = { teamCount: clean.league.teamCount || 12, rosterSlots: clean.league.rosterSlots };
  const weights = scarcityWeights(settings, base.rows);
  const poolMax = base.rows.reduce((m, r) => Math.max(m, r.seasonPoints), 0);
  const val = (r, d = {}) => computeDraftValue({
    seasonPoints: (r.perGame + (d.pg || 0)) * (r.expectedSeasonGames + (d.g || 0)), perGame: r.perGame + (d.pg || 0), expectedGames: r.expectedSeasonGames + (d.g || 0),
    confidence: Math.max(0, Math.min(1, r.confidence + (d.c || 0))), eligiblePositions: r.eligiblePositions, weights, poolMaxSeasonPoints: poolMax, replacement: base.replacement, rosterFitScore: 0.5, rankingModel: 'legacy',
  }).value;
  const shown = base.rows.filter((r) => r.legacySnapshotRank != null);
  const mismatches = shown.filter((r) => r.rank !== r.legacySnapshotRank);
  const details = mismatches.map((r) => {
    let bound = 0;
    for (const pg of [-0.005, 0.005]) for (const g of [-0.05, 0.05]) for (const c of [-0.005, 0.005]) bound = Math.max(bound, Math.abs(val(r, { pg, g, c }) - r.value));
    const gap = Math.min(...base.rows.filter((o) => o !== r).map((o) => Math.abs(o.value - r.value)));
    return { name: r.name, shownRank: r.legacySnapshotRank, replayRank: r.rank, rankDifference: r.rank - r.legacySnapshotRank, nearestRivalValueGap: Number(gap.toFixed(3)), maxRoundingValueChange: Number(bound.toFixed(3)), explainedByRounding: gap <= 2 * bound };
  });
  const diffs = shown.map((r) => Math.abs(r.rank - r.legacySnapshotRank));
  const n = diffs.length;
  return {
    players: n, exactRankMatches: diffs.filter((d) => d === 0).length, nonExact: mismatches.length, within2Ranks: diffs.filter((d) => d <= 2).length,
    maxAbsRankDifference: Math.max(0, ...diffs), meanAbsRankDifference: Number((diffs.reduce((s, d) => s + d, 0) / (n || 1)).toFixed(2)),
    nonExactExplainedByRounding: details.filter((d) => d.explainedByRounding).length, nonExactDetails: details.sort((a, b) => Math.abs(b.rankDifference) - Math.abs(a.rankDifference)),
  };
}

const byName = (rows) => new Map(rows.map((r) => [r.name, r]));

/**
 * Replacement-aware prototype: the experimental board (v2 + rookie estimates) valued under several replacement-availability
 * scenarios, compared with the same board where missed games are worth zero (and with production legacy).
 */
export function compareReplacementScenarios(clean, { highlight = [], model = 'v2', rookieEstimates = true } = {}) {
  const production = replayPipeline(clean, { model: 'legacy', rookieEstimates: false });
  const runs = SCENARIOS.map((sc) => ({ sc, run: replayPipeline(clean, { model, rookieEstimates, replacement: { rho: sc.rho, fill: sc.fill, depth: sc.depth } }) }));
  const base = runs[0].run, baseBy = byName(base.rows), prodBy = byName(production.rows);
  const topSet = (rows, n) => new Set(rows.filter((r) => r.rank <= n).map((r) => r.name));
  const wanted = highlight.map((h) => normalizeName(h));
  const scenarios = runs.map(({ sc, run }) => {
    const by = byName(run.rows);
    const bands = {};
    for (const n of [25, 50, 100]) {
      const a = topSet(base.rows, n), b = topSet(run.rows, n), c = topSet(production.rows, n);
      bands[`top${n}`] = { overlapWithCurrentModel: [...b].filter((x) => a.has(x)).length, overlapWithProductionLegacy: [...b].filter((x) => c.has(x)).length,
        entering: [...b].filter((x) => !a.has(x)).map((x) => `${x} (#${baseBy.get(x).rank} -> #${by.get(x).rank})`), leaving: [...a].filter((x) => !b.has(x)).map((x) => `${x} (#${baseBy.get(x).rank} -> #${by.get(x).rank})`) };
    }
    const movers = run.rows.filter((r) => baseBy.has(r.name) && (baseBy.get(r.name).rank <= 100 || r.rank <= 100))
      .map((r) => ({ name: r.name, positions: r.eligiblePositions.filter((p) => p !== 'UTIL').join('/'), games: r.expectedSeasonGames, perGame: r1(r.perGame), current: baseBy.get(r.name).rank, scenario: r.rank, change: baseBy.get(r.name).rank - r.rank }))
      .filter((m) => Math.abs(m.change) >= 8).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 20);
    const highlighted = run.rows.filter((r) => wanted.includes(normalizeName(r.name))).map((r) => ({ name: r.name, games: r.expectedSeasonGames, perGame: r1(r.perGame), production: prodBy.get(r.name)?.rank ?? null, current: baseBy.get(r.name).rank, scenario: r.rank }));
    // Do the moves favour injury-prone stars specifically? Mean rank change by projected-games tercile among the top 100.
    const top = run.rows.filter((r) => baseBy.get(r.name)?.rank <= 100 || r.rank <= 100);
    const games = top.map((r) => r.expectedSeasonGames).sort((x, y) => x - y);
    const lo = games[Math.floor(games.length / 3)], hi = games[Math.floor((2 * games.length) / 3)];
    const mean = (a) => (a.length ? Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)) : null);
    const delta = (r) => baseBy.get(r.name).rank - r.rank;
    return { ...sc, bands, majorMovers: movers, highlighted,
      meanRankGainByProjectedGames: { fewestGames: mean(top.filter((r) => r.expectedSeasonGames <= lo).map(delta)), middle: mean(top.filter((r) => r.expectedSeasonGames > lo && r.expectedSeasonGames < hi).map(delta)), mostGames: mean(top.filter((r) => r.expectedSeasonGames >= hi).map(delta)) } };
  });
  return { baseline: `${model}${rookieEstimates ? ' + rookie estimates' : ''}, missed games worth 0`, assumptions: 'Replacement per-game production is taken from the snapshot pool at the league\'s own slots and team count; coverage (rho) is an assumption, not measured.', scenarios };
}

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
    const k = [...prodBy.keys()].find((x) => normalizeName(x) === normalizeName(name));
    return k ? { name: k, legacy: prodBy.get(k).rank, v2: v2By.get(k).rank, experimental: fullBy.get(k).rank, perGame: r1(prodBy.get(k).perGame), expectedGames: prodBy.get(k).expectedSeasonGames } : { name, found: false };
  });
  // Why is a rookie where he is? Re-rank with the rookie-only assumptions relaxed one at a time.
  const vetGames = [...v2.rows].map((r) => r.expectedSeasonGames).sort((a, b) => a - b);
  const medianVetGames = vetGames.length ? vetGames[Math.floor(vetGames.length / 2)] : null;
  const rankIn = (opts) => new Map(replayPipeline(clean, { model: 'v2', rookieEstimates: true, rookieOverrides: opts }).rows.filter((r) => r.estimate).map((r) => [r.name, r.rank]));
  const gamesOnly = rankIn({ games: medianVetGames }), confOnly = rankIn({ confidence: 0.9 }), both = rankIn({ games: medianVetGames, confidence: 0.9 });
  const rookieSensitivity = rookies.map((r) => ({ name: r.name, yahooAdp: r.yahooAdp, asEstimated: r.proGMRank, ifVeteranMedianGames: gamesOnly.get(r.name), ifFullConfidence: confOnly.get(r.name), ifBoth: both.get(r.name), medianVeteranGames: medianVetGames, rookieGames: r.expectedGames }));
  return { rookieSensitivity, poolSizes: { production: production.rows.length, experimental: full.rows.length }, bands, rookies, majorMovers: movers, veteransDisplacedByRookies: displaced, highlighted };
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
  const allNumbered = clean.board.filter((r) => Number.isFinite(r.yahooPlayerNumber));
  const highest = [...allNumbered].sort((a, b) => b.yahooPlayerNumber - a.yahooPlayerNumber).slice(0, 25).map((r) => ({ name: r.name, yahooPlayerNumber: r.yahooPlayerNumber, debutYear: r.debutYear ?? null }));
  const newest = [...withBoth].sort((a, b) => b.yahooPlayerNumber - a.yahooPlayerNumber).slice(0, 8).map((r) => ({ name: r.name, debutYear: r.debutYear, yahooPlayerNumber: r.yahooPlayerNumber }));
  const minLatestDebut = years.length ? Math.max(...years) : null;
  const veteransAboveLatestCohortMin = minLatestDebut == null ? null : withBoth.filter((r) => r.debutYear < minLatestDebut && r.yahooPlayerNumber > cohorts[minLatestDebut].min).map((r) => ({ name: r.name, debutYear: r.debutYear, yahooPlayerNumber: r.yahooPlayerNumber }));
  return {
    playersWithNumberAndDebutYear: withBoth.length, spearmanNumberVsDebutYear: Number((den ? num / den : NaN).toFixed(3)),
    debutYearCoverage: { stats: allNumbered.length, withDebutYear: withBoth.length, missingDebutYear: allNumbered.length - withBoth.length, missingAmongTop25Numbers: highest.filter((h) => h.debutYear == null).length },
    allDebutYearCohorts: years.map((y) => ({ debutYear: y, players: cohorts[y].n, minNumber: cohorts[y].min, maxNumber: cohorts[y].max })),
    newestCohorts: latest, highestNumbersWithStats: highest, highestWithDebutYear: newest,
    veteransNumberedAboveTheNewestStatCohort: veteransAboveLatestCohortMin,
    reading: 'A reliable ordering shows a high correlation and no player with an older debut year numbered above the newest stat-bearing cohort.',
  };
}
