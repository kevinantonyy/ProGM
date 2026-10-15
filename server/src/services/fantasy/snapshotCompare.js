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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const COMPONENT_KEYS = ['production', 'replacement', 'vorp', 'scarcity', 'perGame', 'expectedGames', 'seasonPoints', 'confidence', 'confidenceFactor'];

export function sanitizeWorkspace(raw) {
  const board = raw?.draftBoard?.board;
  if (!Array.isArray(board) || !board.length) throw new Error('This file has no draftBoard.board. Save the response of the /basketball/workspace request.');
  const pick = (c) => Object.fromEntries(COMPONENT_KEYS.map((k) => [k, num(c?.[k])]));
  return {
    kind: 'progm-sanitized-snapshot', version: 1,
    meta: {
      rankScope: raw.draftBoard.rankScope ?? null, rankingModel: raw.draftBoard.rankingModel ?? 'legacy',
      draftStatus: typeof raw.connection?.draftStatus === 'string' ? raw.connection.draftStatus : null,
    },
    board: board.map((r) => ({
      name: String(r.name ?? ''), eligiblePositions: Array.isArray(r.eligiblePositions) ? r.eligiblePositions.map(String) : [],
      overallRank: num(r.overallRank), draftPriority: num(r.draftPriority), yahooAdp: num(r.yahooAdp),
      lastSeasonGamesPlayed: num(r.lastSeasonNba?.gamesPlayed), estimate: r.estimate === true,
      projectionMethod: typeof r.projectionMethod === 'string' ? r.projectionMethod : null, marketLabel: typeof r.marketLabel === 'string' ? r.marketLabel : null,
      components: pick(r.components),
    })),
    noData: (Array.isArray(raw.draftBoard.noData) ? raw.draftBoard.noData : []).map((r) => ({
      name: String(r.name ?? ''), eligiblePositions: Array.isArray(r.eligiblePositions) ? r.eligiblePositions.map(String) : [],
      yahooAdp: num(r.yahooAdp), noDataReason: typeof r.noDataReason === 'string' ? r.noDataReason : null,
    })),
    // Only used in memory for the parity check; names are NOT kept (board minus rankings would reveal your roster).
    rankingsParity: (raw.rankings?.players || []).map((p) => [String(p.name ?? ''), num(p.overallRank)]),
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
  const candidates = clean.noData.map((r) => {
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
  return { snapshot: clean.meta, comparison: cmp, rankingsVsDraftHelper: parity, rookieEstimateCoverage: coverage };
}
