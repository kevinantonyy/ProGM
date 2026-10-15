import { buildDraftBoard } from './draftHelper.js';
import { spearmanCorrelation } from './backtest/metrics.js';

/**
 * OFFLINE validation harness for the draft-value ranking. Nothing here is used
 * by production ranking, and it fetches nothing: callers pass the player pool,
 * projections and (when available) realized season results.
 *
 * Variants (all keep the 70% production and 20% replacement terms; neutral
 * roster fit, same confidence factor):
 *   A  legacy v1 (reconstructed; production ranking no longer uses it): production + replacement + min-max-normalized scarcity (5%)
 *   B  production + replacement, no scarcity
 *   C  production + replacement + absolute supply/demand scarcity (5%), where
 *      a position is only "scarce" in proportion to how much its pressure
 *      exceeds the average pressure (no stretching to the full range)
 */
export const VARIANTS = Object.freeze(['A', 'B', 'C']);
const W = Object.freeze({ production: 0.70, replacement: 0.20, scarcity: 0.05 });

function demandByPosition(settings) {
  const demand = {};
  for (const slot of (settings?.rosterSlots || []).filter((s) => s.isStarting)) demand[slot.position] = (demand[slot.position] || 0) + (slot.count || 0);
  return demand;
}

/** Absolute (non min-max) scarcity per position in [0,1]; 0 at or below average pressure. */
export function absoluteScarcity(settings, pool) {
  const demand = demandByPosition(settings);
  const teams = settings?.teamCount || settings?.numTeams || 12;
  const pressure = {};
  for (const position of Object.keys(demand)) {
    const supply = pool.filter((p) => (p.eligiblePositions || []).includes(position)).length;
    pressure[position] = supply > 0 ? (demand[position] * teams) / supply : 0;
  }
  const values = Object.values(pressure).filter((v) => v > 0);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return Object.fromEntries(Object.entries(pressure).map(([pos, v]) => [pos, mean > 0 ? Math.max(0, Math.min(1, v / mean - 1)) : 0]));
}

/** Rank every pool player under variants A, B and C. Returns { A:[keys best-first], ... , rows }. */
export function rankVariants({ players, projectionProvider, settings, currentSeason = null }) {
  const board = buildDraftBoard({ players, settings, projectionProvider, currentSeason, limit: 100000 });
  const scarcityC = absoluteScarcity(settings, players);
  const rows = board.board.map((r) => {
    const c = r.components;
    const base = W.production * c.production + W.replacement * c.replacement;
    const sC = Math.max(0, ...(r.eligiblePositions || []).map((pos) => scarcityC[pos] ?? 0));
    return {
      playerKey: r.playerKey, positions: r.eligiblePositions, perGame: r.perGame, seasonPoints: r.seasonPoints,
      // A is reconstructed as the LEGACY (v1) formula so the harness keeps a fixed reference now
      // that production runs the scarcity-free v2 model (r.baselineValue).
      A: (base + W.scarcity * c.scarcity + 0.05 * 0.5) * c.confidenceFactor * 100,
      PROD_V2: r.baselineValue,
      B: base * c.confidenceFactor * 100,
      C: (base + W.scarcity * sC) * c.confidenceFactor * 100,
    };
  });
  const order = (v) => [...rows].sort((a, b) => b[v] - a[v] || (a.playerKey < b.playerKey ? -1 : 1)).map((r) => r.playerKey);
  return { A: order('A'), B: order('B'), C: order('C'), rows };
}

const rankMap = (keys) => new Map(keys.map((k, i) => [k, i + 1]));

/** Spearman between two key orderings over their common keys. */
export function orderingCorrelation(a, b) {
  const ra = rankMap(a);
  const rb = rankMap(b);
  return spearmanCorrelation([...ra.keys()].filter((k) => rb.has(k)).map((k) => [-ra.get(k), -rb.get(k)])).correlation;
}

/**
 * Compare variants with realized results. `realized`: Map(playerKey -> season total fantasy points).
 * Targets: realized total, and realized value above replacement (total minus the
 * realized total of the starters-th best player at the player's primary position).
 */
export function evaluateVariants({ ranking, realized, settings, topN = 24, primaryOf = null, depthOf = null }) {
  const demand = demandByPosition(settings);
  const teams = settings?.teamCount || settings?.numTeams || 12;
  const primary = primaryOf || ((r) => r.positions?.[0] ?? 'NA');
  const depth = depthOf || ((pos) => Math.round((demand[pos] || 1) * teams));
  const known = ranking.rows.filter((r) => realized.has(r.playerKey));
  const byPos = new Map();
  for (const r of known) byPos.set(primary(r), [...(byPos.get(primary(r)) || []), realized.get(r.playerKey)].sort((a, b) => b - a));
  const replacementLevel = (pos) => {
    const list = byPos.get(pos) || [];
    return list.length ? list[Math.min(list.length - 1, Math.max(1, depth(pos)))] : 0;
  };
  const target = { total: new Map(), vorp: new Map() };
  for (const r of known) {
    target.total.set(r.playerKey, realized.get(r.playerKey));
    target.vorp.set(r.playerKey, realized.get(r.playerKey) - replacementLevel(primary(r)));
  }
  const result = {};
  for (const v of VARIANTS) {
    const order = ranking[v].filter((k) => realized.has(k));
    const predicted = rankMap(order);
    const entry = {};
    for (const [name, t] of Object.entries(target)) {
      const truth = rankMap([...t.keys()].sort((a, b) => t.get(b) - t.get(a)));
      entry[name] = {
        spearman: spearmanCorrelation(order.map((k) => [-predicted.get(k), -truth.get(k)])).correlation,
        topNOverlap: order.slice(0, topN).filter((k) => truth.get(k) <= topN).length / Math.min(topN, order.length),
      };
    }
    // Positional bias: mean (predicted rank - realized-total rank) by primary position; negative = overvalued.
    const truthTotal = rankMap([...target.total.keys()].sort((a, b) => target.total.get(b) - target.total.get(a)));
    const bias = {};
    for (const pos of new Set(known.map(primary))) {
      const ks = known.filter((r) => primary(r) === pos).map((r) => r.playerKey);
      bias[pos] = Number((ks.reduce((s, k) => s + (predicted.get(k) - truthTotal.get(k)), 0) / ks.length).toFixed(2));
    }
    entry.positionalBias = bias;
    result[v] = entry;
  }
  return { n: known.length, variants: result };
}

/** Sensitivity to the player pool: drop a seeded fraction of players, re-rank, compare common players. */
export function poolSensitivity({ players, projectionProvider, settings, dropFraction = 0.2, trials = 5, seed = 1 }) {
  const full = rankVariants({ players, projectionProvider, settings });
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const out = Object.fromEntries(VARIANTS.map((v) => [v, { spearman: 0, meanAbsRankChange: 0 }]));
  for (let t = 0; t < trials; t += 1) {
    const kept = players.filter(() => random() >= dropFraction);
    const reduced = rankVariants({ players: kept, projectionProvider, settings });
    for (const v of VARIANTS) {
      const before = rankMap(full[v]);
      const after = rankMap(reduced[v]);
      // Compare the order among kept players only (drop removed players from the full ranking).
      const keptOrder = full[v].filter((k) => after.has(k));
      const keptRank = rankMap(keptOrder);
      out[v].spearman += orderingCorrelation(keptOrder, reduced[v]) / trials;
      out[v].meanAbsRankChange += (reduced[v].reduce((s, k) => s + Math.abs(after.get(k) - keptRank.get(k)), 0) / reduced[v].length) / trials;
      void before;
    }
  }
  for (const v of VARIANTS) for (const k of Object.keys(out[v])) out[v][k] = Number(out[v][k].toFixed(4));
  return out;
}
