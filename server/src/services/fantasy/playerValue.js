/**
 * Transparent basketball player-value model.
 *
 * Produces a single comparable value per player from REAL inputs only:
 *   - projected league fantasy points (per game, or period-aware when schedule
 *     data exists),
 *   - availability (injury/status) as a multiplier,
 *   - positional scarcity (how rare a player's eligible positions are in the
 *     league's starting requirements).
 *
 * There is no fabricated data: a player with no projection has value null
 * (callers treat null as "unknown", never 0). The model is intentionally
 * simple and documented so trade/waiver decisions are explainable.
 *
 * VALUE FORMULA (documented):
 *   base       = periodProjectedPoints (if schedule-aware) else projectedPerGame
 *   healthMult = 1.0 healthy | 0.85 day-to-day/questionable | 0.5 out/IL
 *   scarcity   = 1 + 0.06 × (scarcityRank)  where scarcer eligible positions
 *                (fewer league starters can fill them) get a small premium,
 *                capped so scarcity never dominates real production.
 *   value      = base × healthMult × scarcity
 *
 * scarcity is league-specific: it reflects the actual starting-slot demand for
 * each position in THIS league's settings, not a hardcoded assumption.
 */

const DTD_STATUSES = new Set(['GTD', 'DTD', 'DAY_TO_DAY', 'Q', 'QUESTIONABLE', 'PROBABLE']);
const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'IL+', 'INJ', 'NA', 'SUSP', 'IR', 'DOUBTFUL', 'D']);

export function healthMultiplier(status) {
  if (!status) return 1;
  const s = String(status).toUpperCase();
  if (OUT_STATUSES.has(s)) return 0.5;
  if (DTD_STATUSES.has(s)) return 0.85;
  return 1;
}

/**
 * Positional scarcity weights from league settings. When the caller supplies
 * a player pool, scarcity is lineup demand relative to eligible supply.
 * Without a pool, the legacy demand-only calculation remains available to
 * existing trade/waiver callers. Returns a small multiplier in [1.0, 1.18].
 *
 * @param {Object} settings normalized league settings (rosterSlots)
 * @param {Array|null} playerPool optional eligible supply for demand/supply scarcity
 */
export function scarcityWeights(settings, playerPool = null) {
  const slots = (settings?.rosterSlots || []).filter((s) => s.isStarting);
  const demand = {}; // position -> total starting slots that accept it directly
  for (const slot of slots) demand[slot.position] = (demand[slot.position] || 0) + slot.count;
  const positions = Object.keys(demand);
  if (!positions.length) return {};

  // Slot count alone inverted scarcity (one required PG was always deemed
  // scarcer than two required Cs, regardless of the eligible player supply).
  if (Array.isArray(playerPool) && playerPool.length) {
    const teamCount = settings?.teamCount || settings?.numTeams || settings?.raw?.maxTeams || 12;
    const pressure = {};
    for (const position of positions) {
      const supply = playerPool.filter((p) => (p.eligiblePositions || []).includes(position)).length;
      pressure[position] = supply > 0 ? (demand[position] * teamCount) / supply : 0;
    }
    const values = Object.values(pressure);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return Object.fromEntries(positions.map((position) => {
      const normalized = max > min ? (pressure[position] - min) / (max - min) : 0;
      return [position, Number((1 + 0.18 * normalized).toFixed(3))];
    }));
  }

  const maxDemand = Math.max(...positions.map((p) => demand[p]));
  const weights = {};
  for (const p of positions) {
    // Fewer slots => higher scarcity. Scale gently: rarest gets ~+18%.
    const rarity = 1 - demand[p] / (maxDemand || 1); // 0 (most common) .. ~1 (rarest)
    weights[p] = Number((1 + 0.18 * rarity).toFixed(3));
  }
  return weights;
}

/** Best (max) scarcity weight among a player's eligible positions. */
function bestScarcity(eligiblePositions, weights) {
  let best = 1;
  for (const pos of eligiblePositions || []) if (weights[pos] != null) best = Math.max(best, weights[pos]);
  return best;
}

/**
 * Compute a comparable value for one player.
 *
 * @param {Object} params
 * @param {number|null} params.projectedPerGame
 * @param {number|null} [params.periodProjectedPoints]  schedule-aware total (preferred when present)
 * @param {string|null} params.status
 * @param {string[]} params.eligiblePositions
 * @param {Object} params.weights  scarcityWeights(settings)
 * @returns {{ value:number|null, base:number|null, healthMult:number, scarcity:number, usesSchedule:boolean }}
 */
export function playerValue({ projectedPerGame, periodProjectedPoints = null, status, eligiblePositions, weights }) {
  const usesSchedule = periodProjectedPoints != null;
  const base = usesSchedule ? periodProjectedPoints : (projectedPerGame ?? null);
  if (base == null) return { value: null, base: null, healthMult: 1, scarcity: 1, usesSchedule };
  const hm = healthMultiplier(status);
  const sc = bestScarcity(eligiblePositions, weights);
  return {
    value: Number((base * hm * sc).toFixed(2)),
    base: Number(base.toFixed(2)),
    healthMult: hm,
    scarcity: sc,
    usesSchedule,
  };
}
