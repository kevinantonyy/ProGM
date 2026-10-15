/**
 * Offline, read-only validation from a SAVED workspace response (the JSON the browser already received).
 * No network, no database, no tokens. Two steps:
 *   sanitizeWorkspace(raw)  -> whitelist of public player numbers only (drops roster, league/team names, ids, ownership)
 *   analyzeSnapshot(clean)  -> legacy vs v2 comparison, Rankings/Draft Helper parity, rookie-estimate coverage
 * Both models are computed from the SAME rows (same pool, scoring, eligibility and projections), because each
 * row carries its own production / replacement / scarcity components.
 */
import { compareRankingModels } from './rankingCompare.js';
import { fitMarketPrior, marketPriorPerGame, MIN_CALIBRATION_GAMES, MIN_POINTS } from './marketPrior.js';
import { classifyUnprojected, lastSeasonCutoff, yahooPlayerNumber } from './unprojectedClass.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const COMPONENT_KEYS = ['production', 'replacement', 'vorp', 'scarcity', 'perGame', 'expectedGames', 'seasonPoints', 'confidence', 'confidenceFactor'];

export function sanitizeWorkspace(raw, { trace = [] } = {}) {
  const traced = new Set(trace.map((n) => String(n).trim().toLowerCase()));
  const board = raw?.draftBoard?.board;
  if (!Array.isArray(board) || !board.length) throw new Error('This file has no draftBoard.board. Save the response of the /basketball/workspace request.');
  const pick = (c) => Object.fromEntries(COMPONENT_KEYS.map((k) => [k, num(c?.[k])]));
  return {
    kind: 'progm-sanitized-snapshot', version: 1,
    meta: {
      rankScope: raw.draftBoard.rankScope ?? null, rankingModel: raw.draftBoard.rankingModel ?? 'legacy',
      draftStatus: typeof raw.connection?.draftStatus === 'string' ? raw.connection.draftStatus : null,
      // League-wide availability rate the production model gives a player with no history (identical on every row).
      noHistoryGamesRate: board.map((r) => num(r.components?.availability?.baselineContext?.globalRate)).find((v) => v != null) ?? null,
    },
    league: raw.settings ? {
      scoringFormat: raw.settings.scoringFormat ?? null, teamCount: num(raw.settings.teamCount),
      statCategories: (raw.settings.statCategories || []).map((c) => ({ statId: num(c.statId), abbr: String(c.abbr ?? ''), pointValue: num(c.pointValue), enabled: c.enabled !== false })),
      rosterSlots: (raw.settings.rosterSlots || []).map((c) => ({ position: String(c.position ?? ''), count: num(c.count), isStarting: c.isStarting === true })),
    } : null,
    board: board.map((r) => ({
      name: String(r.name ?? ''), yahooPlayerNumber: yahooPlayerNumber(r), eligiblePositions: Array.isArray(r.eligiblePositions) ? r.eligiblePositions.map(String) : [],
      overallRank: num(r.overallRank), draftPriority: num(r.draftPriority), yahooAdp: num(r.yahooAdp),
      lastSeasonGamesPlayed: num(r.lastSeasonNba?.gamesPlayed), debutYear: num(r.debutYear), estimate: r.estimate === true,
      projectionMethod: typeof r.projectionMethod === 'string' ? r.projectionMethod : null, marketLabel: typeof r.marketLabel === 'string' ? r.marketLabel : null,
      components: pick(r.components),
      ...(traced.has(String(r.name ?? '').toLowerCase()) ? { trace: traceRow(r) } : {}),
    })),
    noData: (Array.isArray(raw.draftBoard.noData) ? raw.draftBoard.noData : []).map((r) => ({
      name: String(r.name ?? ''), yahooPlayerNumber: yahooPlayerNumber(r), eligiblePositions: Array.isArray(r.eligiblePositions) ? r.eligiblePositions.map(String) : [],
      yahooAdp: num(r.yahooAdp), noDataReason: typeof r.noDataReason === 'string' ? r.noDataReason : null,
      injuryStatus: typeof r.status === 'string' ? r.status : null, priorSeasonRanks: Array.isArray(r.yahooPriorSeasonRanks) ? r.yahooPriorSeasonRanks.length : 0,
      lastSeasonYahooRank: num(r.lastSeasonYahooRank), identityMatch: typeof r.identityMatch === 'string' ? r.identityMatch : null,
    })),
    // Only used in memory for the parity check; names are NOT kept (board minus rankings would reveal your roster).
    rankingsParity: (raw.rankings?.players || []).map((p) => [String(p.name ?? ''), num(p.overallRank)]),
  };
}

/** Public per-player numbers behind one row's projection (only for explicitly traced names). */
function traceRow(r) {
  const a = r.components?.availability || {};
  const keep = (o, keys) => Object.fromEntries(keys.map((k) => [k, typeof o?.[k] === 'number' || typeof o?.[k] === 'string' ? o[k] : null]));
  return {
    age: num(r.age), debutYear: num(r.debutYear), identityMatch: typeof r.identityMatch === 'string' ? r.identityMatch : null,
    projectionMethod: typeof r.projectionMethod === 'string' ? r.projectionMethod : null, injuryStatus: typeof r.status === 'string' ? r.status : null,
    lastSeasonNba: r.lastSeasonNba ? keep(r.lastSeasonNba, ['season', 'points', 'rebounds', 'assists', 'gamesPlayed']) : null,
    lastSeasonFantasy: r.lastSeasonFantasy ? { season: r.lastSeasonFantasy.season ?? null, points: num(r.lastSeasonFantasy.points), breakdown: (r.lastSeasonFantasy.breakdown || []).map((b) => keep(b, ['abbr', 'perGame', 'weight', 'points'])) } : null,
    availability: {
      ...keep(a, ['expectedGames', 'availability', 'careerRate', 'independentCareerRate', 'recentRate', 'weightedRate', 'posteriorRate', 'baselineAvailability', 'historyCoverage', 'shrinkageFactor', 'evidenceGames', 'seasonsObserved', 'historicalPattern']),
      isolatedAbsenceAdjusted: Array.isArray(a.isolatedAbsenceAdjusted) ? a.isolatedAbsenceAdjusted : [],
      perSeason: (a.perSeason || []).map((x) => keep(x, ['season', 'gamesPlayed', 'gameTotal', 'availability'])),
    },
  };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }

export function analyzeSnapshot(clean, { highlight = ['Cade Cunningham', 'Bam Adebayo', 'Alperen Sengun'], top = 50 } = {}) {
  const rows = clean.board.map((r) => ({ name: r.name, eligiblePositions: r.eligiblePositions, components: r.components, estimate: r.estimate, projectionMethod: r.projectionMethod }));
  const cmp = compareRankingModels(rows, { top, highlight });

  // Rankings tab vs Draft Helper: same baseline rank for every player present in both (counts only, no names).
  const boardRank = new Map(clean.board.map((r) => [r.name, r.overallRank]));
  let compared = 0; const mismatches = [];
  for (const [name, rank] of clean.rankingsParity) {
    if (!boardRank.has(name)) continue;
    compared += 1; if (boardRank.get(name) !== rank) mismatches.push(mismatches.length < 5 ? name : null);
  }
  const parity = { playersCompared: compared, mismatches: mismatches.length, firstMismatches: mismatches.filter(Boolean) };

  // Rookie-estimate coverage: what the flagged fallback WOULD do for players with no projection (approximate placement).
  const calibration = clean.board
    .filter((r) => !r.estimate && r.yahooAdp != null && (r.lastSeasonGamesPlayed ?? 0) >= MIN_CALIBRATION_GAMES && r.components.perGame != null)
    .map((r) => ({ adp: r.yahooAdp, perGame: r.components.perGame }));
  const model = fitMarketPrior(calibration);
  const medianGames = median(clean.board.map((r) => r.components.expectedGames).filter((g) => g != null));
  const seasonPts = clean.board.map((r) => r.components.seasonPoints).filter((x) => x != null).sort((a, b) => b - a);
  const cutoff = lastSeasonCutoff(clean.board.map((r) => ({ playerNumber: r.yahooPlayerNumber, hasRealStats: !r.estimate && r.components.perGame != null })));
  const verdictOf = (r) => classifyUnprojected({ playerNumber: r.yahooPlayerNumber, cutoff, matched: false, status: r.injuryStatus, scoringGap: /league scoring/i.test(r.noDataReason || '') });
  const candidates = clean.noData.map((r) => {
    const verdict = verdictOf(r);
    if (verdict.class !== 'rookie_or_new_entrant') return { status: `not_estimated_${verdict.class}`, name: r.name, adp: r.yahooAdp };
    if (r.yahooAdp == null) return { status: 'no_adp', name: r.name, reason: r.noDataReason };
    if (!model) return { status: 'calibration_unavailable', name: r.name };
    const pg = marketPriorPerGame(model, r.yahooAdp);
    if (pg == null) return { status: 'adp_out_of_range', name: r.name, adp: r.yahooAdp };
    const sp = pg * (medianGames ?? 60);
    return { status: 'would_be_estimated', name: r.name, adp: r.yahooAdp, impliedFantasyPointsPerGame: Number(pg.toFixed(1)), approxSeasonPoints: Math.round(sp),
      approxPositionBySeasonPoints: 1 + seasonPts.filter((x) => x > sp).length, note: 'approximate: median expected games, no value normalisation' };
  });
  const count = (s) => candidates.filter((c) => c.status === s).length;
  const coverage = {
    flagsInSnapshot: { rankingModel: clean.meta.rankingModel, estimateRowsAlreadyInBoard: clean.board.filter((r) => r.estimate).length },
    unprojectedPlayers: candidates.length, wouldBeEstimated: count('would_be_estimated'), noAdp: count('no_adp'), adpOutOfRange: count('adp_out_of_range'),
    calibration: model ? { players: model.n, r2: model.r2, slope: Number(model.slope.toFixed(2)), adpRange: [model.minAdp, model.maxAdp], minRequired: MIN_POINTS } : { players: calibration.length, usable: false },
    players: candidates.filter((c) => c.status === 'would_be_estimated').slice(0, 25),
  };
  // Unprojected players: classified with the SAME function production uses for estimate eligibility.
  // Cutoff = highest Yahoo player number among players that have a real stat-based projection (every board row).
  const byClass = {};
  for (const r of clean.noData) {
    const k = verdictOf(r).class; (byClass[k] ||= { total: 0, withAdp: 0, namesWithAdp: [] }); byClass[k].total += 1;
    if (r.yahooAdp != null) { byClass[k].withAdp += 1; byClass[k].namesWithAdp.push({ name: r.name, adp: r.yahooAdp, yahooPlayerNumber: r.yahooPlayerNumber, status: r.injuryStatus, priorSeasonRankCount: r.priorSeasonRanks }); }
  }
  coverage.unprojectedByClass = byClass;
  coverage.classification = {
    cutoffPlayerNumber: cutoff, rule: 'incoming player = Yahoo player number above every player with a real last-season stat line, no status flag',
    note: 'Prior-season Yahoo ranks are shown for information only; they are NOT used (they were present for incoming rookies).',
    wouldReceiveEstimate: (byClass.rookie_or_new_entrant?.namesWithAdp || []).filter((n) => candidates.some((c) => c.name === n.name && c.status === 'would_be_estimated')).map((n) => n.name),
  };

  // Replacement baselines. The payload does not publish them, but every row implies its own exactly:
  //   baseline = seasonPoints - vorp,   and the row's baseline is the LOWEST baseline among its eligible positions.
  // Positions are therefore only reported when the rows pin them down; otherwise they are explicitly unavailable.
  const byBaseline = new Map();
  const spreads = [];
  for (const r of clean.board) {
    const c = r.components; if (c.seasonPoints == null || c.vorp == null) continue;
    const key = Math.round(c.seasonPoints - c.vorp);
    const positions = r.eligiblePositions.filter((p) => p !== 'UTIL');
    const g = byBaseline.get(key) || { baseline: key, rows: 0, common: null };
    g.rows += 1; g.common = g.common == null ? new Set(positions) : new Set([...g.common].filter((p) => positions.includes(p)));
    byBaseline.set(key, g);
    if (c.replacement != null && c.replacement > 0.02 && c.replacement < 0.98 && c.vorp > 0) spreads.push(c.vorp / c.replacement);
  }
  const groups = [...byBaseline.values()].filter((g) => g.rows >= 3).sort((x, y) => y.rows - x.rows).slice(0, 8)
    .map((g) => ({ baselineSeasonPoints: g.baseline, players: g.rows, positionsCommonToAllThesePlayers: [...g.common] }));
  const resolved = Object.fromEntries(groups.filter((g) => g.positionsCommonToAllThesePlayers.length === 1).map((g) => [g.positionsCommonToAllThesePlayers[0], g.baselineSeasonPoints]));
  const spread = median(spreads);
  const poolMax = median(clean.board.filter((r) => r.components.production > 0.2).map((r) => r.components.seasonPoints / r.components.production));
  const poolDiag = {
    replacementBaselineByPosition: resolved,
    replacementBaselineByPositionNote: Object.keys(resolved).length ? 'inferred: the only position shared by every player with that baseline (not published by the payload)' : 'unavailable: eligible-position lists overlap (e.g. PG also lists G), so rows do not isolate a single position',
    distinctReplacementBaselines: groups,
    spread: spread == null ? null : Math.round(spread), poolMaxSeasonPoints: poolMax == null ? null : Math.round(poolMax),
  };

  const traces = clean.board.filter((r) => r.trace).map((r) => {
    const c = r.components; const last = r.trace?.lastSeasonFantasy?.points;
    // Production payloads from before this branch carry no projectionMethod. If per-game equals the last-season score
    // (same weights, no recent-form blend) the projection is season-only; otherwise recent form was blended in.
    const derived = last == null || c.perGame == null ? 'unavailable' : (Math.abs(c.perGame - last) < 0.011 ? 'season_only (derived)' : 'blended_recent_season (derived)');
    return { name: r.name, eligiblePositions: r.eligiblePositions, components: r.components, ...r.trace,
      projectionMethod: r.trace?.projectionMethod ?? derived, projectionMethodSource: r.trace?.projectionMethod ? 'payload' : 'derived from perGame vs last-season fantasy points',
      replacementBaselineSeasonPoints: c.seasonPoints != null && c.vorp != null ? Math.round(c.seasonPoints - c.vorp) : null };
  });
  return { snapshot: clean.meta, league: clean.league, comparison: cmp, rankingsVsDraftHelper: parity, rookieEstimateCoverage: coverage, pool: poolDiag, traces };
}
