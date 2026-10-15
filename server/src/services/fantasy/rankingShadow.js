/**
 * Shadow comparison of the legacy and v2 draft boards. Flag-gated (PROGM_RANKING_SHADOW), diagnostics only.
 *
 * Contract:
 *  - Read-only over the legacy board, players, settings and projections; the caller keeps returning legacy.
 *  - No network, no Yahoo calls: v2 is built by the caller from the data it already holds.
 *  - Any error is caught and reported as { ok:false, error } so legacy output is never affected.
 *  - Output holds player names and numbers only: no league/team keys, team names, tokens or roster contents.
 */
import { compareRankingModels } from './rankingCompare.js';
import { normalizeName } from '../identity/playerIdentity.js';

export const SHADOW_HIGHLIGHT = ['Cade Cunningham', 'Jalen Johnson', 'Bam Adebayo', 'Alperen Sengun'];
const POSITIONS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'];
const BANDS = [[1, 25], [26, 50], [51, 100], [101, 200], [201, Infinity]];
const MOVER_MIN = 8;
const CROSSCHECK_TOLERANCE = 2;
const UNEXPECTED_TOP_SHIFT = 25; // a legacy top-50 player moving this far is unusual for a 5-point weight move
const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function rankedRows(board) {
  return (board || []).filter((r) => r && r.playerKey != null && Number.isFinite(r.overallRank));
}

/** Pure comparison of two already-built boards (legacy visible, v2 shadow). */
export function compareBoards(legacyBoard, v2Board, { highlight = SHADOW_HIGHLIGHT } = {}) {
  const L = rankedRows(legacyBoard); const V = rankedRows(v2Board);
  const v2ByKey = new Map(V.map((r) => [r.playerKey, r]));
  const anomalies = [];
  if (L.length !== (legacyBoard || []).length) anomalies.push({ code: 'legacy_rows_without_rank', count: (legacyBoard || []).length - L.length });
  if (V.length !== (v2Board || []).length) anomalies.push({ code: 'v2_rows_without_rank', count: (v2Board || []).length - V.length });
  if (L.length !== V.length) anomalies.push({ code: 'pool_size_differs', legacy: L.length, v2: V.length });
  if (new Set(L.map((r) => r.playerKey)).size !== L.length) anomalies.push({ code: 'duplicate_player_keys' });
  const paired = [];
  let missingInV2 = 0;
  for (const l of L) {
    const v = v2ByKey.get(l.playerKey);
    if (!v) { missingInV2 += 1; continue; }
    const vals = [l.baselineValue ?? l.draftValue, v.baselineValue ?? v.draftValue];
    if (vals.some((x) => x != null && !Number.isFinite(x))) { anomalies.push({ code: 'non_finite_value', name: l.name }); continue; }
    paired.push({ l, v, legacyRank: l.overallRank, v2Rank: v.overallRank, change: l.overallRank - v.overallRank }); // + = up under v2
  }
  if (missingInV2) anomalies.push({ code: 'players_missing_in_v2', count: missingInV2 });

  const topSets = (n) => {
    const lt = new Set(paired.filter((p) => p.legacyRank <= n).map((p) => p.l.playerKey));
    const vt = paired.filter((p) => p.v2Rank <= n);
    return { n, legacyCount: lt.size, overlap: vt.filter((p) => lt.has(p.l.playerKey)).length };
  };
  const topOverlap = [25, 50, 100].map(topSets);
  const shape = (p) => ({
    name: p.l.name, eligiblePositions: (p.l.eligiblePositions || []).filter((x) => x !== 'UTIL'),
    legacyRank: p.legacyRank, v2Rank: p.v2Rank, rankChange: p.change,
  });
  const movers = {
    threshold: MOVER_MIN,
    up: paired.filter((p) => p.change >= MOVER_MIN).sort((a, b) => b.change - a.change).slice(0, 15).map(shape),
    down: paired.filter((p) => p.change <= -MOVER_MIN).sort((a, b) => a.change - b.change).slice(0, 15).map(shape),
    countUp: paired.filter((p) => p.change >= MOVER_MIN).length,
    countDown: paired.filter((p) => p.change <= -MOVER_MIN).length,
  };
  const byPosition = Object.fromEntries(POSITIONS.map((pos) => {
    const g = paired.filter((p) => (p.l.eligiblePositions || []).includes(pos));
    const topL = g.filter((p) => p.legacyRank <= 50).length; const topV = g.filter((p) => p.v2Rank <= 50).length;
    return [pos, {
      players: g.length, meanRankChange: round(mean(g.map((p) => p.change))), meanAbsRankChange: round(mean(g.map((p) => Math.abs(p.change)))),
      top50Legacy: topL, top50V2: topV,
      byLegacyBand: BANDS.map(([lo, hi]) => {
        const b = g.filter((p) => p.legacyRank >= lo && p.legacyRank <= hi);
        return { band: hi === Infinity ? `${lo}+` : `${lo}-${hi}`, players: b.length, meanRankChange: round(mean(b.map((p) => p.change))) };
      }),
    }];
  }));
  const wanted = new Set((highlight || []).map((n) => normalizeName(n)));
  const highlighted = paired.filter((p) => wanted.has(normalizeName(p.l.name))).map(shape);
  for (const p of paired) {
    if (p.legacyRank <= 50 && Math.abs(p.change) >= UNEXPECTED_TOP_SHIFT) anomalies.push({ code: 'large_shift_in_legacy_top50', name: p.l.name, rankChange: p.change });
  }

  // Calculation cross-check: the algebraic re-derivation used by the read-only diagnostic must agree with the real v2 board.
  let crossCheck = null;
  try {
    const alg = compareRankingModels(legacyBoard, { top: 100, highlight: [] });
    const algByName = new Map([...alg.topByLegacy, ...alg.enteringTopUnderV2].map((r) => [r.name, r.v2Rank]));
    // Published components are rounded to 3 decimals, so near-ties can swap by a rank or two: tolerate that, flag more.
    let compared = 0; let mismatched = 0; let maxAbsDiff = 0;
    for (const p of paired) {
      const a = algByName.get(p.l.name);
      if (a == null || p.legacyRank > 100) continue;
      compared += 1; const d = Math.abs(a - p.v2Rank); maxAbsDiff = Math.max(maxAbsDiff, d);
      if (d > CROSSCHECK_TOLERANCE && p.v2Rank <= 100) mismatched += 1;
    }
    crossCheck = { compared, mismatched, maxAbsDiff, tolerance: CROSSCHECK_TOLERANCE };
    if (mismatched) anomalies.push({ code: 'v2_board_disagrees_with_rederived_v2', count: mismatched });
  } catch { crossCheck = { error: true }; }

  return {
    players: paired.length, topOverlap, movers, byPosition, highlighted, crossCheck, anomalies,
  };
}

/**
 * Run the shadow. `buildV2` is a closure over data the caller already has; it returns a v2 draft board.
 * Never throws. `legacyBoard` is only read.
 */
export function runRankingShadow({ legacyBoard, buildV2, now = () => Date.now() }) {
  const t0 = now();
  try {
    if (!legacyBoard?.board?.length) return { ok: true, skipped: 'no_legacy_board', ms: now() - t0 };
    const v2 = buildV2();
    if (!v2?.board?.length) return { ok: false, error: 'v2_returned_no_board', ms: now() - t0 };
    if (v2.rankingModel !== 'v2') return { ok: false, error: 'v2_model_mismatch', ms: now() - t0 };
    const comparison = compareBoards(legacyBoard.board, v2.board);
    return { ok: true, ms: now() - t0, generatedAt: new Date().toISOString(), comparison };
  } catch (error) {
    return { ok: false, error: `${error?.name || 'Error'}`, ms: now() - t0 }; // class only: never log messages that could embed data
  }
}

/** Safe one-line log: counts and timing only. */
export function shadowLogLine(result) {
  if (!result) return null;
  if (!result.ok) return `[ranking-shadow] failed error=${result.error} ms=${result.ms}`;
  if (result.skipped) return `[ranking-shadow] skipped reason=${result.skipped}`;
  const c = result.comparison;
  return `[ranking-shadow] ok players=${c.players} top50=${c.topOverlap[1].overlap}/${c.topOverlap[1].legacyCount} anomalies=${c.anomalies.length} ms=${result.ms}`;
}
