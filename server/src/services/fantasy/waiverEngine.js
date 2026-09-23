/**
 * Waiver recommendation engine.
 *
 * Ranks players Yahoo confirms are AVAILABLE in the league in two distinct ways:
 *
 *   BEST AVAILABLE — strongest projected league fantasy value, regardless of
 *                    the user's roster.
 *   BEST FIT       — projected value adjusted for the user's positional needs,
 *                    so a slightly-lower projection at a thin position can rank
 *                    above a higher projection at an overloaded position.
 *
 * percent_owned (from Yahoo) is displayed for context but is NEVER used as a
 * proxy for player quality.
 *
 * Requires projections (projectionProvider). Without them the engine returns
 * availability + ownership facts only and marks recommendations unavailable.
 */

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/**
 * Compute a positional-need multiplier per starting position from the user's
 * roster analysis. Thin positions get a boost (>1), overloaded get a slight
 * discount (<1). This is a ProGM calculation, clearly separated from raw value.
 */
function needMultipliers(rosterAnalysis) {
  const mult = {};
  if (!rosterAnalysis?.positions) return mult;
  for (const t of rosterAnalysis.positions.thinPositions || []) mult[t.position] = 1.25;
  for (const o of rosterAnalysis.positions.overloadedPositions || []) mult[o.position] = 0.9;
  return mult;
}

/** Best positional-need multiplier that applies to a player's eligible positions. */
function bestNeedMultiplier(player, mult) {
  let best = 1;
  for (const pos of player.eligiblePositions || []) {
    if (mult[pos] != null) best = Math.max(best, mult[pos]);
  }
  // If a player is only eligible for overloaded spots, apply the discount.
  if (best === 1) {
    const discounts = (player.eligiblePositions || []).map((p) => mult[p]).filter((v) => v != null && v < 1);
    if (discounts.length && (player.eligiblePositions || []).every((p) => (mult[p] ?? 1) < 1)) {
      best = Math.min(...discounts);
    }
  }
  return best;
}

/**
 * @param {Object} params
 * @param {Array} params.availablePlayers   normalized Yahoo players (available pool)
 * @param {Object} params.projectionProvider {getProjection(player)} or null
 * @param {Object} [params.rosterAnalysis]   analyzeRoster() result for the user's team
 * @param {number} [params.limit]
 */
export function rankWaivers({ availablePlayers, projectionProvider, rosterAnalysis = null, limit = 25 }) {
  const projectionsAvailable = Boolean(projectionProvider?.getProjection);
  const mult = needMultipliers(rosterAnalysis);

  const decorated = (availablePlayers || []).map((p) => {
    const proj = projectionsAvailable ? projectionProvider.getProjection(p) : null;
    const projected = proj?.projectedPoints ?? null;
    const needMult = bestNeedMultiplier(p, mult);
    const out = Boolean(p.status && OUT_STATUSES.has(p.status));
    return {
      playerKey: p.playerKey,
      name: p.name,
      teamAbbr: p.teamAbbr,
      eligiblePositions: p.eligiblePositions,
      status: p.status,
      statusFull: p.statusFull,
      percentOwned: p.percentOwned ?? null,
      projectedPoints: projected,
      confidence: proj?.confidence ?? 0,
      out,
      // Fit score: projected value scaled by positional need. Null if no projection.
      fitScore: projected != null ? Number((projected * needMult).toFixed(2)) : null,
      needMultiplier: needMult,
    };
  });

  if (!projectionsAvailable) {
    return {
      projectionsAvailable: false,
      bestAvailable: [],
      bestFit: [],
      players: decorated, // still expose availability + ownership facts
      note: 'Projection data is unavailable, so players are shown with availability and ownership only (no ranking).',
    };
  }

  const rankable = decorated.filter((p) => p.projectedPoints != null && !p.out);

  const bestAvailable = [...rankable]
    .sort((a, b) => b.projectedPoints - a.projectedPoints)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  const bestFit = [...rankable]
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      ...p,
      fitReason: p.needMultiplier > 1
        ? `Boosted for a thin position you can start (${p.eligiblePositions.join('/')}).`
        : p.needMultiplier < 1
          ? 'Slightly discounted — you already have depth at this player\'s positions.'
          : 'Neutral positional fit.',
    }));

  return {
    projectionsAvailable: true,
    bestAvailable,
    bestFit,
    note: 'BEST AVAILABLE ranks by projected league fantasy points. BEST FIT adjusts for your roster\'s positional needs. Ownership % is context only, not a quality signal.',
  };
}
