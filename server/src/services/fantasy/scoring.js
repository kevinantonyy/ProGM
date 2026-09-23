/**
 * League-specific fantasy-point scoring.
 *
 *   expected NBA stat line  ×  the CURRENT Yahoo league's stat modifiers
 *   =========================================================================
 *   league-specific projected fantasy points
 *
 * Scoring weights are read dynamically from the league's normalized settings
 * (settings.statCategories[].pointValue) — nothing is hardcoded from any one
 * league. The same function works for any Yahoo points league.
 *
 * This module maps Yahoo NBA stat_ids to the provider-independent StatLine
 * keys produced by the stats providers. Stats we cannot derive from a per-game
 * average statline (e.g. double/triple-doubles, or percentage categories) are
 * reported as `unsupportedStats` so the UI can be transparent rather than
 * silently dropping or fabricating them.
 */

/**
 * Yahoo NBA stat_id -> StatLine key (or a special handler tag).
 * Confirmed from live league settings. Extendable without touching callers.
 */
export const YAHOO_STAT_TO_STATLINE = {
  4: 'fgMade',        // FGM
  5: 'fgAtt',         // FGA
  7: 'ftMade',        // FTM
  8: 'ftAtt',         // FTA
  10: 'threesMade',   // 3PTM
  12: 'points',       // PTS
  13: 'offRebounds',  // OREB
  14: 'defRebounds',  // DREB
  15: 'rebounds',     // REB
  16: 'assists',      // AST
  17: 'steals',       // ST
  18: 'blocks',       // BLK
  19: 'turnovers',    // TO
  // Contingent/derived stats we cannot average from a per-game statline:
  27: '__double_double__',
  28: '__triple_double__',
};

// Stat ids that represent contingent counting achievements, not raw box stats.
const CONTINGENT = new Set(['__double_double__', '__triple_double__']);

/**
 * Compute league-specific projected fantasy points for a per-game statline.
 *
 * @param {import('../providers/types.js').StatLine} statLine
 * @param {Array<{statId:number, abbr:string, pointValue:number|null, enabled:boolean}>} statCategories
 * @returns {{ points: number|null, breakdown: Array, unsupportedStats: string[], supported: boolean }}
 */
export function scoreStatLine(statLine, statCategories = []) {
  if (!statLine) return { points: null, breakdown: [], unsupportedStats: [], supported: false };

  const breakdown = [];
  const unsupportedStats = [];
  let total = 0;
  let anyScored = false;

  for (const cat of statCategories) {
    if (!cat || cat.enabled === false) continue;
    if (cat.pointValue == null) continue; // category league or no modifier -> not a points weight

    const key = YAHOO_STAT_TO_STATLINE[cat.statId];

    if (!key) {
      // Weighted stat we don't have a mapping for.
      unsupportedStats.push(cat.abbr || String(cat.statId));
      continue;
    }

    if (CONTINGENT.has(key)) {
      // Double/triple-doubles can't be reliably derived from per-game averages
      // without game-by-game data. Report as unsupported for projection rather
      // than fabricate a frequency.
      unsupportedStats.push(cat.abbr || key);
      continue;
    }

    const value = statLine[key];
    if (value == null) {
      // We have the weight but not the stat value for this player.
      unsupportedStats.push(cat.abbr || key);
      continue;
    }

    const contribution = value * cat.pointValue;
    total += contribution;
    anyScored = true;
    breakdown.push({
      statId: cat.statId,
      abbr: cat.abbr || key,
      perGame: Number(value.toFixed(2)),
      weight: cat.pointValue,
      points: Number(contribution.toFixed(2)),
    });
  }

  return {
    points: anyScored ? Number(total.toFixed(2)) : null,
    breakdown: breakdown.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    unsupportedStats: [...new Set(unsupportedStats)],
    supported: anyScored,
  };
}

/**
 * True if the league's scoring can be meaningfully applied to statlines (i.e.
 * it is a points league with at least one mappable weighted stat).
 */
export function scoringIsSupported(settings) {
  if (!settings || settings.scoringFormat !== 'points') return false;
  return (settings.statCategories || []).some(
    (c) => c.enabled !== false && c.pointValue != null && YAHOO_STAT_TO_STATLINE[c.statId] && !CONTINGENT.has(YAHOO_STAT_TO_STATLINE[c.statId])
  );
}
