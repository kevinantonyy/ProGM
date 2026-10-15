/**
 * PROTOTYPE (offline, not used by production rankings): replacement-aware season value.
 *
 * Today a player's value uses seasonPoints = perGame x expectedGames, i.e. every missed game is worth zero. A manager
 * usually fills the slot, so the slot's output is
 *     effectiveSeasonPoints = g * perGame + (82 - g) * rho * r
 * where r is the per-game production of the replacement who can fill that slot and rho is the share of missed
 * games that replacement actually covers. rho = 0 reproduces today's numbers exactly.
 *
 * Realism controls (none assumes perfect, free replacement):
 *  - rho < 1: waiver delays, lineup locks, bench limits, short absences nobody can cover;
 *  - fill = 'min' (default): the replacement is the WORST of the player's eligible slot types (lineup constraint);
 *    'max' lets the manager pick the best-fitting slot (flexible lineup);
 *  - depth = 'waiver': replacement level is the player left after starters AND bench are rostered (a free agent), instead
 *    of the last startable player.
 * Positions and lineup come from the league's own roster slots and team count.
 */
export const GAMES = 82;

/** Replacement player at each starting slot type: the player at the league's own depth, ranked by season points like the draft board's baselines. */
export function replacementLevel(rows, settings, { depth = 'starter' } = {}) {
  const slots = (settings.rosterSlots || []).filter((s) => s.isStarting && s.count > 0);
  const bench = (settings.rosterSlots || []).filter((s) => !s.isStarting && /^(BN|BENCH)$/i.test(s.position)).reduce((n, s) => n + s.count, 0);
  const teams = settings.teamCount || 12;
  const startersTotal = slots.reduce((n, s) => n + s.count, 0) || 1;
  const out = {};
  for (const s of slots) {
    const eligible = rows.filter((r) => (r.eligiblePositions || []).includes(s.position)).sort((a, b) => b.seasonPoints - a.seasonPoints);
    if (!eligible.length) continue;
    const extra = depth === 'waiver' ? Math.round((bench * teams * s.count) / startersTotal) : 0; // this slot's share of rostered bench players
    const idx = Math.min(eligible.length - 1, Math.round(s.count * teams) + extra);
    out[s.position] = { index: idx, perGame: eligible[idx].perGame, seasonPoints: eligible[idx].seasonPoints };
  }
  return out;
}

export function replacementPerGame(rows, settings, opts = {}) {
  return Object.fromEntries(Object.entries(replacementLevel(rows, settings, opts)).map(([k, v]) => [k, v.perGame]));
}

export function effectiveSeasonPoints(rows, settings, { rho = 0, fill = 'min', depth = 'starter' } = {}) {
  if (!(rho > 0)) return rows.map((r) => r.seasonPoints);
  const rpos = replacementPerGame(rows, settings, { depth });
  const pick = fill === 'max' ? Math.max : Math.min;
  return rows.map((r) => {
    const rs = (r.eligiblePositions || []).map((p) => rpos[p]).filter((x) => Number.isFinite(x));
    if (!rs.length) return r.seasonPoints;                              // no slot information: leave untouched
    const rep = pick(...rs);
    const g = Math.min(GAMES, Math.max(0, r.expectedSeasonGames));
    return g * r.perGame + (GAMES - g) * rho * rep;
  });
}

export const SCENARIOS = Object.freeze([
  { id: 'current', label: 'Current (missed games worth 0)', rho: 0, fill: 'min', depth: 'starter' },
  { id: 'constrained_low', label: 'Low coverage: 25% of missed games, waiver-level replacement, lineup-constrained', rho: 0.25, fill: 'min', depth: 'waiver' },
  { id: 'constrained_mid', label: 'Mid coverage: 50%, waiver-level replacement, lineup-constrained', rho: 0.5, fill: 'min', depth: 'waiver' },
  { id: 'flexible_high', label: 'High coverage: 75%, starter-level replacement, flexible lineup', rho: 0.75, fill: 'max', depth: 'starter' },
  { id: 'perfect_bound', label: 'Upper bound: every missed game perfectly replaced (not realistic)', rho: 1, fill: 'max', depth: 'starter' },
]);
