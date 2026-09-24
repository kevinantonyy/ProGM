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
import { playerValue, scarcityWeights } from './playerValue.js';

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

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

  const valued = [];
  const noData = [];
  for (const p of pool) {
    const proj = projectionProvider.getProjection(p);
    const period = typeof projectionProvider.getPeriodValue === 'function' ? projectionProvider.getPeriodValue(p) : null;
    const scheduleAware = Boolean(period?.scheduleAware);
    const v = playerValue({
      projectedPerGame: proj?.projectedPoints ?? null,
      periodProjectedPoints: scheduleAware ? (period.periodProjectedPoints ?? null) : null,
      status: p.status,
      eligiblePositions: p.eligiblePositions,
      weights,
    });
    const record = decorate(p, {
      projected: proj?.projectedPoints ?? null,
      periodProjected: scheduleAware ? (period.periodProjectedPoints ?? null) : null,
      expectedGames: scheduleAware ? (period.expectedGames ?? null) : null,
      confidence: proj?.confidence ?? null, // data-quality confidence (0-1)
      value: v.value,
      scarcity: v.scarcity,
    });
    if (v.value == null) noData.push(record);
    else valued.push(record);
  }

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
      calculations: ['ProGM value = projection × health × league positional scarcity', 'value tiers from natural gaps', 'roster fit vs your thin/overloaded positions'],
    },
    note: availabilityKnown
      ? 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability reflects Yahoo — "available" means free to acquire now; "rostered" means owned. Players without projections are listed under "no data", never given a fake value.'
      : 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability is not confirmed here, so treat this as rankings/research, not a claim that every player is draftable. Players without projections are listed under "no data", never given a fake value.',
  };
}
