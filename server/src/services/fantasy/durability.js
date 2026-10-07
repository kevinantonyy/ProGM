/**
 * Evidence-based season durability (availability) from historical games played.
 *
 * durabilityScore summarizes how AVAILABLE a player has been across the last
 * completed regular seasons — recency-weighted, sample-size guarded, 0..1.
 * It is intentionally separate from CURRENT injury status (that is handled by
 * the injury multiplier in the draft model). This module is pure + data-driven;
 * there are NO player-specific values and NO subjective "injury prone" labels.
 *
 *   availability[season] = gamesPlayed / gameTotal            (clamped 0..1)
 *   durabilityScore      = Σ (weight[season] × availability)  / Σ weight[season]
 *
 * Recency weights (documented constants, tunable for later backtesting):
 *   N-1 (most recent completed season) = 0.50
 *   N-2                                = 0.30
 *   N-3                                = 0.20
 * Weights are RENORMALIZED over the seasons actually present, so a player with
 * only 2 usable seasons is scored fairly on those two.
 *
 * SAMPLE-SIZE GUARD: at least MIN_USABLE_SEASONS seasons of real data are
 * required. With fewer, durabilityScore is null (NEUTRAL) — the caller must
 * apply NO penalty rather than guessing from thin history.
 */

// Tunable constants (kept together so durability can be backtested/retuned
// without touching logic). Order is newest-first (N-1, N-2, N-3).
export const DURABILITY_RECENCY_WEIGHTS = Object.freeze([0.50, 0.30, 0.20]);
export const MIN_USABLE_SEASONS = 2;

/**
 * Compute durability from a player's historical availability.
 *
 * @param {Array<{season:number, gamesPlayed:number|null, gameTotal:number|null}>|null} history
 *        newest season first (as produced by getHistoricalAvailability).
 * @returns {{ durabilityScore:number|null, usableSeasons:number, perSeason:Array }}
 *          durabilityScore is null when there is insufficient usable history.
 */
export function computeDurability(history) {
  const rows = Array.isArray(history) ? history : [];

  // A usable season needs a real GP and a positive game total.
  const usable = rows
    .filter((h) => h && h.gamesPlayed != null && Number.isFinite(h.gamesPlayed) && h.gameTotal > 0)
    .slice(0, DURABILITY_RECENCY_WEIGHTS.length); // only the most-recent N count

  const perSeason = usable.map((h, i) => ({
    season: h.season,
    gamesPlayed: h.gamesPlayed,
    gameTotal: h.gameTotal,
    availability: Math.max(0, Math.min(1, h.gamesPlayed / h.gameTotal)),
    weight: DURABILITY_RECENCY_WEIGHTS[i],
  }));

  if (perSeason.length < MIN_USABLE_SEASONS) {
    // Insufficient history -> neutral; caller applies NO penalty.
    return { durabilityScore: null, usableSeasons: perSeason.length, perSeason };
  }

  const weightSum = perSeason.reduce((s, p) => s + p.weight, 0);
  const weighted = perSeason.reduce((s, p) => s + p.weight * p.availability, 0);
  const durabilityScore = Number((weighted / weightSum).toFixed(4));

  return { durabilityScore, usableSeasons: perSeason.length, perSeason };
}
