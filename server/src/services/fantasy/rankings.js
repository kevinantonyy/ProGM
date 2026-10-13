/**
 * Player Rankings for Fantasy Basketball.
 *
 * Produces a sortable ranking of players from REAL ProGM projections (which are
 * computed from Tank01 stats under the league's own scoring settings). Players
 * without a projection are included but flagged (projected === null) and always
 * sorted to the bottom — we never substitute 0 or a made-up value to rank them.
 *
 * Ownership % (Yahoo) is shown for context only and is never used as a quality
 * signal. Sorting is explicit and league-relative.
 */

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

const SORT_KEYS = new Set(['projected', 'period', 'owned', 'name']);

/**
 * @param {Object} params
 * @param {Array} params.players            normalized players to rank
 * @param {Object} params.projectionProvider {getProjection(player), getPeriodValue?(player)}
 * @param {string} [params.sortBy]          'projected' | 'period' | 'owned' | 'name'
 * @param {string} [params.position]        filter to players eligible at this position
 * @param {boolean}[params.includeOut]      include OUT players (default false)
 * @param {number} [params.limit]
 */
export function buildRankings({ players, projectionProvider, sortBy = 'projected', position = null, includeOut = false, limit = 200 }) {
  const hasProjections = Boolean(projectionProvider?.getProjection);
  const key = SORT_KEYS.has(sortBy) ? sortBy : 'projected';

  let pool = Array.isArray(players) ? players : [];
  if (position) pool = pool.filter((p) => (p.eligiblePositions || []).includes(position));
  if (!includeOut) pool = pool.filter((p) => !(p.status && OUT_STATUSES.has(p.status)));

  const decorated = pool.map((p) => {
    const proj = hasProjections ? projectionProvider.getProjection(p) : null;
    const period = hasProjections && typeof projectionProvider.getPeriodValue === 'function'
      ? projectionProvider.getPeriodValue(p)
      : null;
    return {
      playerKey: p.playerKey,
      name: p.name,
      image: p.headshotUrl || null,
      teamAbbr: p.teamAbbr || null,
      eligiblePositions: p.eligiblePositions || [],
      status: p.status || null,
      percentOwned: p.percentOwned ?? null, // context only
      projected: proj?.projectedPoints ?? null,
      confidence: proj?.confidence ?? null,
      periodProjected: period?.scheduleAware ? (period.periodProjectedPoints ?? null) : null,
      expectedGames: period?.scheduleAware ? (period.expectedGames ?? null) : null,
      projectionKnown: proj?.projectedPoints != null,
    };
  });

  // Comparator: known values first, then by the requested key. Name is A-Z.
  const cmp = {
    projected: (a, b) => nullsLast(b.projected, a.projected),
    period: (a, b) => nullsLast(b.periodProjected, a.periodProjected),
    owned: (a, b) => nullsLast(b.percentOwned, a.percentOwned),
    name: (a, b) => a.name.localeCompare(b.name),
  }[key];

  const sorted = [...decorated].sort(cmp).slice(0, limit).map((p, i) => ({ rank: i + 1, ...p }));

  return {
    projectionsAvailable: hasProjections,
    sortBy: key,
    position: position || null,
    count: sorted.length,
    players: sorted,
    note: hasProjections
      ? 'Rankings use ProGM projections computed under this league\'s scoring. Players without data are listed last (never zeroed). Ownership % is context only.'
      : 'Projection data is unavailable, so players are listed by availability/ownership facts only (no quality ranking).',
  };
}

/** Sort descending but push null/undefined to the bottom regardless of order. */
function nullsLast(a, b) {
  const av = a == null ? -Infinity : a;
  const bv = b == null ? -Infinity : b;
  return av - bv;
}
