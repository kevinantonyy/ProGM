/**
 * Draft Helper (research / rankings tool) for Fantasy Basketball.
 *
 * Yahoo leagues in-season are already drafted, so this is NOT a live-draft
 * autopick engine. It is a research tool that ranks players by ProGM value
 * (projection × health × league scarcity) and groups them into value tiers so a
 * manager can study relative worth for keeper/dynasty planning or next season's
 * draft. Every value comes from real projections; players without a projection
 * are listed separately as "no data", never assigned a fabricated value.
 *
 * Value reuses the same transparent model as trades/waivers (playerValue.js) so
 * a player's worth is consistent across the whole product.
 */
import { scarcityWeights, healthMultiplier } from './playerValue.js';

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/**
 * Draft-value model (distinct from the trade/waiver playerValue model).
 *
 * DRAFT VALUE answers "who is worth more to draft", which is driven by expected
 * PER-GAME production under this league's scoring — NOT by a games-in-window
 * total. (Using a period total made players on teams with more games this week
 * outrank clearly better per-game stars; that is a weekly-streaming concern,
 * not draft value.) Components are each normalized to a comparable 0..1 scale
 * BEFORE combining, so no single raw scale (e.g. raw fantasy points) can
 * dominate, then blended with fixed weights:
 *
 *   production   (0..1)  per-game league fantasy points vs the pool max
 *   replacement  (0..1)  per-game value ABOVE the positional replacement
 *                        baseline (VORP-style): rewards players who clear the
 *                        bar at a scarce position, computed from the pool itself
 *   scarcity     (0..1)  league positional scarcity (rarer eligible slots)
 *   confidence   (0..1)  data-quality confidence (missing/thin data penalized,
 *                        never treated as zero production)
 *   healthMult   (mult)  injury availability multiplier (1 / 0.85 / 0.5)
 *
 *   rawScore = 0.55*production + 0.30*replacement + 0.15*scarcity
 *   draftValue = rawScore
 *                * (CONF_FLOOR + (1-CONF_FLOOR)*confidence)   // confidence penalty
 *                * healthMult                                  // injury penalty
 *
 * Everything is derived from existing normalized data (projection per-game,
 * league rosterSlots, Yahoo injury status). No player-specific hardcoding.
 */
export const DRAFT_WEIGHTS = Object.freeze({ production: 0.55, replacement: 0.30, scarcity: 0.15 });
const CONF_FLOOR = 0.6; // a no-confidence player keeps 60% of value, never 0 from data gaps

/** Max scarcity weight among a player's eligible positions (>=1). */
function bestScarcity(eligiblePositions, weights) {
  let best = 1;
  for (const pos of eligiblePositions || []) if (weights[pos] != null) best = Math.max(best, weights[pos]);
  return best;
}

/** Normalize scarcity weight (~1.0..1.2) into a 0..1 component. */
function scarcityComponent(scarcity, weights) {
  const vals = Object.values(weights || {});
  const maxW = vals.length ? Math.max(1, ...vals) : 1;
  if (maxW <= 1) return 0; // no positional differentiation in this league
  return Math.max(0, Math.min(1, (scarcity - 1) / (maxW - 1)));
}

/**
 * Positional replacement baselines (VORP-style) from the pool itself.
 * For each starting position, the baseline is the per-game production of a
 * "replacement" starter: the player ranked at (teamCount × slotsForPos). A
 * player's replacement component is how far their per-game value exceeds the
 * best (lowest) baseline among the positions they're eligible for, normalized
 * by the pool's spread. Entirely data-derived; no hardcoded player/position.
 *
 * @param {Array<{perGame:number|null, eligiblePositions:string[]}>} rows
 * @param {Object} settings  normalized league settings
 * @returns {{ baselineByPos:Object, spread:number }}
 */
export function computeReplacementBaselines(rows, settings) {
  const startingSlots = (settings?.rosterSlots || []).filter((s) => s.isStarting);
  const teamCount = settings?.teamCount || settings?.numTeams || settings?.raw?.maxTeams || 12;
  const demand = {};
  for (const slot of startingSlots) demand[slot.position] = (demand[slot.position] || 0) + (slot.count || 0);

  const valued = rows.filter((r) => r.perGame != null);
  const allVals = valued.map((r) => r.perGame).sort((a, b) => b - a);
  const spread = allVals.length ? Math.max(1e-6, allVals[0] - allVals[allVals.length - 1]) : 1;

  const baselineByPos = {};
  for (const pos of Object.keys(demand)) {
    // Players eligible at this position, best-first.
    const eligible = valued
      .filter((r) => (r.eligiblePositions || []).includes(pos))
      .map((r) => r.perGame)
      .sort((a, b) => b - a);
    const starters = Math.max(1, Math.round((demand[pos] || 0) * teamCount));
    // Replacement = the starter just past the last startable slot (next man up).
    const idx = Math.min(eligible.length - 1, starters);
    baselineByPos[pos] = eligible.length ? eligible[Math.max(0, idx)] : 0;
  }
  return { baselineByPos, spread };
}

/**
 * Compute a draft value + explainable component breakdown for one player.
 * PER-GAME anchored: never uses a games-in-window period total.
 *
 * @param {Object} params
 * @param {number|null} params.perGame        per-game league fantasy points
 * @param {number|null} params.confidence     data-quality confidence 0..1
 * @param {string|null} params.status         Yahoo injury status
 * @param {string[]} params.eligiblePositions
 * @param {Object} params.weights             scarcityWeights(settings)
 * @param {number} params.poolMaxPerGame      max per-game in the pool (for production norm)
 * @param {{baselineByPos:Object, spread:number}} params.replacement
 * @returns {{ value:number|null, components:Object }|{ value:null, components:Object }}
 */
export function computeDraftValue({ perGame, confidence, status, eligiblePositions, weights, poolMaxPerGame, replacement }) {
  if (perGame == null) {
    return { value: null, components: { reason: 'no_projection' } };
  }
  // 1. Production: per-game vs pool max (0..1).
  const production = poolMaxPerGame > 0 ? Math.max(0, Math.min(1, perGame / poolMaxPerGame)) : 0;

  // 2. Replacement (VORP): per-game above the best baseline among eligible
  //    positions, normalized by pool spread (0..1, clamped).
  let bestBaseline = Infinity;
  for (const pos of eligiblePositions || []) {
    const b = replacement?.baselineByPos?.[pos];
    if (b != null && b < bestBaseline) bestBaseline = b;
  }
  if (!Number.isFinite(bestBaseline)) bestBaseline = 0;
  const vorp = perGame - bestBaseline;
  const replacementComp = Math.max(0, Math.min(1, vorp / (replacement?.spread || 1)));

  // 3. Scarcity (0..1).
  const scarcityW = bestScarcity(eligiblePositions, weights);
  const scarcityComp = scarcityComponent(scarcityW, weights);

  // 4. Confidence penalty (never zeroes real production).
  const conf = confidence == null ? 0 : Math.max(0, Math.min(1, confidence));
  const confFactor = CONF_FLOOR + (1 - CONF_FLOOR) * conf;

  // 5. Injury availability multiplier.
  const healthMult = healthMultiplier(status);

  const rawScore = DRAFT_WEIGHTS.production * production
    + DRAFT_WEIGHTS.replacement * replacementComp
    + DRAFT_WEIGHTS.scarcity * scarcityComp;

  // Scale to a readable 0..100 draft score (relative within pool).
  const value = Number((rawScore * confFactor * healthMult * 100).toFixed(2));

  return {
    value,
    components: {
      perGame: Number(perGame.toFixed(2)),
      production: Number(production.toFixed(3)),
      replacement: Number(replacementComp.toFixed(3)),
      vorp: Number(vorp.toFixed(2)),
      scarcity: Number(scarcityComp.toFixed(3)),
      scarcityWeight: scarcityW,
      confidence: Number(conf.toFixed(2)),
      confidenceFactor: Number(confFactor.toFixed(3)),
      healthMult,
      rawScore: Number(rawScore.toFixed(4)),
    },
  };
}

/**
 * Assign value tiers by natural gaps in the sorted value list. A new tier
 * starts when the drop from the previous player exceeds `gapFactor` × the
 * running average gap. Purely descriptive grouping of real values.
 */
function assignTiers(sortedValued, gapFactor = 1.8) {
  if (sortedValued.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < sortedValued.length; i += 1) gaps.push(sortedValued[i - 1].value - sortedValued[i].value);
  const avgGap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
  let tier = 1;
  return sortedValued.map((p, i) => {
    if (i > 0) {
      const gap = sortedValued[i - 1].value - p.value;
      if (avgGap > 0 && gap > gapFactor * avgGap) tier += 1;
    }
    return { ...p, tier };
  });
}

/** Roster-fit label for a player against the user's thin/overloaded positions. */
function rosterFit(eligiblePositions, thinSet, overloadedSet) {
  const elig = eligiblePositions || [];
  if (elig.some((pos) => thinSet.has(pos))) return { fit: 'need', label: 'Fills a thin position on your roster' };
  if (elig.length && elig.every((pos) => overloadedSet.has(pos))) return { fit: 'surplus', label: 'You already have depth here' };
  return { fit: 'neutral', label: 'Neutral fit' };
}

/**
 * @param {Object} params
 * @param {Array} params.players             candidate pool (normalized)
 * @param {Object} params.settings           normalized league settings (for scarcity)
 * @param {Object} params.projectionProvider {getProjection, getPeriodValue?}
 * @param {Object} [params.rosterAnalysis]   analyzeRoster() result (for roster fit/need)
 * @param {(player)=>boolean} [params.availabilityOf]  returns true if the player is
 *        actually available to acquire in Yahoo. When omitted, availability is
 *        treated as UNKNOWN (never fabricated as available).
 * @param {string} [params.position]         filter to a position
 * @param {number} [params.limit]
 */
export function buildDraftBoard({ players, settings, projectionProvider, rosterAnalysis = null, availabilityOf = null, position = null, limit = 150 }) {
  const hasProjections = Boolean(projectionProvider?.getProjection);
  const weights = scarcityWeights(settings);
  const thinSet = new Set((rosterAnalysis?.positions?.thinPositions || []).map((t) => t.position));
  const overloadedSet = new Set((rosterAnalysis?.positions?.overloadedPositions || []).map((o) => o.position));
  const availabilityKnown = typeof availabilityOf === 'function';

  let pool = Array.isArray(players) ? players : [];
  if (position) pool = pool.filter((p) => (p.eligiblePositions || []).includes(position));

  const decorate = (p, extra) => {
    const fit = rosterFit(p.eligiblePositions, thinSet, overloadedSet);
    return {
      playerKey: p.playerKey,
      name: p.name,
      teamAbbr: p.teamAbbr || null,
      eligiblePositions: p.eligiblePositions || [],
      status: p.status || null,
      out: Boolean(p.status && OUT_STATUSES.has(p.status)),
      percentOwned: p.percentOwned ?? null, // context only
      // Availability is a Yahoo FACT when known, otherwise explicitly unknown.
      availability: availabilityKnown ? (availabilityOf(p) ? 'available' : 'rostered') : 'unknown',
      rosterFit: fit.fit,
      rosterFitLabel: fit.label,
      ...extra,
    };
  };

  if (!hasProjections) {
    return {
      available: false,
      availabilityKnown,
      board: [],
      noData: pool.map((p) => decorate(p, {})),
      note: 'Draft research needs projection data (connect an NBA stats provider). Showing player list only.',
    };
  }

  // Pass 1: gather per-game projection + metadata for every pooled player.
  // DRAFT VALUE is PER-GAME anchored — the schedule-aware period total is NOT
  // used here (that is a weekly-streaming signal, not draft value). We still
  // surface periodProjected/expectedGames for display only.
  const prelim = [];
  const noData = [];
  for (const p of pool) {
    const proj = projectionProvider.getProjection(p);
    const period = typeof projectionProvider.getPeriodValue === 'function' ? projectionProvider.getPeriodValue(p) : null;
    const scheduleAware = Boolean(period?.scheduleAware);
    const perGame = proj?.projectedPoints ?? null;
    const base = decorate(p, {
      projected: perGame,
      periodProjected: scheduleAware ? (period.periodProjectedPoints ?? null) : null, // display only
      expectedGames: scheduleAware ? (period.expectedGames ?? null) : null, // display only
      confidence: proj?.confidence ?? null,
    });
    if (perGame == null) { noData.push({ ...base, value: null }); continue; }
    prelim.push({ ...base, perGame });
  }

  // Pool-wide references for normalization (computed from the pool itself).
  const poolMaxPerGame = prelim.reduce((m, r) => Math.max(m, r.perGame), 0);
  const replacement = computeReplacementBaselines(prelim, settings);

  // Pass 2: compute normalized, per-game-anchored draft value + explainability.
  const valued = prelim.map((r) => {
    const dv = computeDraftValue({
      perGame: r.perGame,
      confidence: r.confidence,
      status: r.status,
      eligiblePositions: r.eligiblePositions,
      weights,
      poolMaxPerGame,
      replacement,
    });
    return {
      ...r,
      value: dv.value,
      scarcity: dv.components.scarcityWeight,
      components: dv.components, // explainability: why this player ranks here
    };
  });

  // Global BEST AVAILABLE order: by draft value only. Roster fit is attached
  // for the UI but MUST NOT influence this global ordering (fit affects the
  // separate "Best Fit" view, not Best Available).
  const sorted = valued.sort((a, b) => b.value - a.value).slice(0, limit);
  const board = assignTiers(sorted).map((p, i) => ({ overallRank: i + 1, ...p }));

  return {
    available: true,
    availabilityKnown,
    position: position || null,
    board,
    noData, // players with no projection, listed honestly (not ranked)
    dataBasis: {
      facts: ['player eligibility, team, injury status, ownership, availability (Yahoo)'],
      calculations: [
        'draft value = normalized blend of per-game league production (55%), positional replacement/VORP (30%), and scarcity (15%)',
        'confidence/injury penalties applied as multipliers (missing data penalized, never zeroed)',
        'PER-GAME anchored — games-in-window totals do NOT drive draft value',
        'value tiers from natural gaps; roster fit shown but does NOT reorder Best Available',
      ],
    },
    note: availabilityKnown
      ? 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability reflects Yahoo — "available" means free to acquire now; "rostered" means owned. Players without projections are listed under "no data", never given a fake value.'
      : 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability is not confirmed here, so treat this as rankings/research, not a claim that every player is draftable. Players without projections are listed under "no data", never given a fake value.',
  };
}
