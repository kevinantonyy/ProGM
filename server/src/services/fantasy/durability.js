/**
 * Evidence-based season durability (availability) from historical games played.
 *
 * durabilityScore summarizes how AVAILABLE a player has been across the last
 * completed regular seasons — recency-weighted, sample-size guarded, 0..1.
 * Expected-games projection uses this evidence plus regression for incomplete
 * history and only explicit verified season-ending injury context. This module
 * has no player-specific values or subjective "injury prone" labels.
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
 * required for durabilityScore. Expected games can still use one season at
 * one-third reliability, regressing the rest toward a league/pool baseline.
 */

// Tunable constants (kept together so durability can be backtested/retuned
// without touching logic). Order is newest-first (N-1, N-2, N-3).
export const DURABILITY_RECENCY_WEIGHTS = Object.freeze([0.50, 0.30, 0.20]);
export const MIN_USABLE_SEASONS = 2;
export const EXPECTED_SEASON_GAMES = 82;
export const DEFAULT_AVAILABILITY_BASELINE = 0.85;

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

/** Median league baseline, bounded so fringe-player histories do not punish rookies. */
export function computeAvailabilityBaseline(histories) {
  const scores = (histories || [])
    .map((history) => computeDurability(history).durabilityScore)
    .filter((score) => score != null)
    .sort((a, b) => a - b);
  if (!scores.length) return DEFAULT_AVAILABILITY_BASELINE;
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  return Number(Math.max(0.75, Math.min(0.90, median)).toFixed(4));
}

/** Only explicit season-ending language is strong enough to cap a season projection. */
export function seasonEndingInjury(injury) {
  const text = `${injury?.designation || ''} ${injury?.description || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (/season[- ]ending|out for (?:the )?season|miss (?:the )?(?:rest|remainder) of (?:the )?season|will not return this season/.test(text)) {
    return { availabilityCap: 0, reason: injury.description || injury.designation || 'Season-ending injury' };
  }
  return null;
}

/**
 * Expected upcoming regular-season games from recency-weighted availability.
 * Incomplete histories regress toward the league baseline instead of treating
 * absent seasons as zero: 1/3 evidence for one season, 2/3 for two, full weight
 * for three. Shortened seasons are normalized by each row's real gameTotal.
 */
export function estimateExpectedGames(history, { baselineAvailability = DEFAULT_AVAILABILITY_BASELINE, injury = null } = {}) {
  const durability = computeDurability(history);
  const rows = durability.perSeason;
  const weightSum = rows.reduce((sum, row) => sum + row.weight, 0);
  const rawAvailability = weightSum
    ? rows.reduce((sum, row) => sum + row.weight * row.availability, 0) / weightSum
    : null;
  const historyReliability = Math.min(1, rows.length / DURABILITY_RECENCY_WEIGHTS.length);
  const baseline = Math.max(0, Math.min(1, Number(baselineAvailability) || DEFAULT_AVAILABILITY_BASELINE));
  let availability = rawAvailability == null
    ? baseline
    : rawAvailability * historyReliability + baseline * (1 - historyReliability);
  const longTerm = seasonEndingInjury(injury);
  if (longTerm) availability = Math.min(availability, longTerm.availabilityCap);
  availability = Math.max(0, Math.min(1, availability));
  return {
    expectedGames: Number((EXPECTED_SEASON_GAMES * availability).toFixed(1)),
    availability: Number(availability.toFixed(4)),
    rawAvailability: rawAvailability == null ? null : Number(rawAvailability.toFixed(4)),
    baselineAvailability: baseline,
    historyReliability: Number(historyReliability.toFixed(4)),
    usableSeasons: rows.length,
    perSeason: rows,
    injuryCap: longTerm?.availabilityCap ?? null,
    injuryReason: longTerm?.reason ?? null,
  };
}
