/**
 * Transparent ProGM projection model.
 *
 * ProGM does NOT use a third party's opaque fantasy-point number as the
 * authoritative projection, because that assumes a generic scoring system.
 * Instead it builds an EXPECTED per-game stat line from real statistics, then
 * applies the current Yahoo league's actual scoring weights (see scoring.js).
 *
 * ------------------------------------------------------------------------
 * EXPECTED STAT LINE FORMULA (documented, intentionally simple)
 * ------------------------------------------------------------------------
 * For each box-score stat s:
 *
 *   expected[s] = RECENT_WEIGHT * recentAvg[s] + SEASON_WEIGHT * seasonAvg[s]
 *
 *   RECENT_WEIGHT = 0.35, SEASON_WEIGHT = 0.65   (season-weighted, recent-aware)
 *
 * If recent data is missing, expected[s] = seasonAvg[s] (weights collapse to
 * season only). If season data is missing but recent exists, the reverse.
 *
 * The expected stat line is then converted to league points via
 * scoreStatLine(expected, leagueStatCategories).
 *
 * AVAILABILITY: the projection is a PER-GAME expectation. Whether a player is
 * expected to play (injury status, games scheduled) is surfaced separately as
 * `availability` so callers (Start/Sit) can decide, rather than silently
 * zeroing a projection. We never invent an injury; we only reflect provider /
 * Yahoo status.
 *
 * CONFIDENCE (0-1) reflects DATA QUALITY, not certainty of outcome:
 *   +0.50  season sample present (scaled by games played, capped at ~40 GP)
 *   +0.30  recent sample present (scaled by recent game count, capped at 10)
 *   +0.20  scoring fully supported (no weighted stats missing from our data)
 * Confidence is clamped to [0,1]. A player with no stats -> confidence 0 and a
 * null projection (never a fabricated number).
 */
import { scoreStatLine } from './scoring.js';
import { emptyStatLine } from '../providers/types.js';

export const RECENT_WEIGHT = 0.35;
export const SEASON_WEIGHT = 0.65;

const BLENDED_KEYS = [
  'minutes', 'points', 'rebounds', 'offRebounds', 'defRebounds', 'assists',
  'steals', 'blocks', 'turnovers', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade',
];

/** Blend recent + season per-game stat lines into an expected stat line. */
export function blendStatLines(season, recent) {
  const hasSeason = season && Object.values(season).some((v) => v != null);
  const hasRecent = recent && Object.values(recent).some((v) => v != null);
  if (!hasSeason && !hasRecent) return null;

  const expected = emptyStatLine();
  for (const key of BLENDED_KEYS) {
    const s = season?.[key];
    const r = recent?.[key];
    if (s != null && r != null) {
      expected[key] = Number((RECENT_WEIGHT * r + SEASON_WEIGHT * s).toFixed(2));
    } else if (s != null) {
      expected[key] = s;
    } else if (r != null) {
      expected[key] = r;
    }
  }
  expected.gamesPlayed = season?.gamesPlayed ?? recent?.gamesPlayed ?? null;
  return expected;
}

function computeConfidence({ season, recent, recentGameCount, unsupportedCount, weightedCount }) {
  let confidence = 0;
  const gp = season?.gamesPlayed;
  if (gp != null) confidence += 0.5 * Math.min(1, gp / 40);
  if (recent && recentGameCount) confidence += 0.3 * Math.min(1, recentGameCount / 10);
  if (weightedCount > 0) confidence += 0.2 * (1 - Math.min(1, unsupportedCount / weightedCount));
  return Number(Math.max(0, Math.min(1, confidence)).toFixed(2));
}

/**
 * Project a single player's league fantasy points from their stats.
 *
 * @param {Object} params
 * @param {import('../providers/types.js').PlayerStats|null} params.stats
 * @param {Array} params.statCategories        league settings stat categories
 * @param {{available:boolean, status:string|null}} [params.availability]
 * @returns {Object} projection result (null projectedPoints when no data)
 */
export function projectPlayer({ stats, statCategories, availability = null }) {
  if (!stats) {
    return {
      projectedPoints: null,
      perGame: null,
      confidence: 0,
      expected: null,
      breakdown: [],
      unsupportedStats: [],
      availability,
      method: 'no_data',
    };
  }

  const expected = blendStatLines(stats.season, stats.recent);
  if (!expected) {
    return { projectedPoints: null, perGame: null, confidence: 0, expected: null, breakdown: [], unsupportedStats: [], availability, method: 'no_data' };
  }

  const scored = scoreStatLine(expected, statCategories);
  const weightedCount = (statCategories || []).filter((c) => c && c.enabled !== false && c.pointValue != null).length;

  const confidence = computeConfidence({
    season: stats.season,
    recent: stats.recent,
    recentGameCount: stats.recentGameCount,
    unsupportedCount: scored.unsupportedStats.length,
    weightedCount,
  });

  return {
    projectedPoints: scored.points, // per-game league fantasy points
    perGame: scored.points,
    confidence,
    expected,
    breakdown: scored.breakdown,
    unsupportedStats: scored.unsupportedStats,
    availability,
    method: stats.recent ? 'blended_recent_season' : 'season_only',
  };
}

/**
 * Build a projectionProvider compatible with the existing analysis seams
 * (startSit.js / tradeAnalyzer.js expect getProjectedValue(player)).
 *
 * @param {Object} params
 * @param {Map<string, Object>} params.projectionByCanonicalId  canonicalId -> projectPlayer() result
 * @param {(player) => string} params.canonicalIdOf              maps a Yahoo player to its canonicalId
 */
export function makeProjectionProvider({ projectionByCanonicalId, canonicalIdOf }) {
  return {
    getProjectedValue(player) {
      const id = canonicalIdOf(player);
      const proj = id ? projectionByCanonicalId.get(id) : null;
      return proj?.projectedPoints ?? null;
    },
    getProjection(player) {
      const id = canonicalIdOf(player);
      return (id ? projectionByCanonicalId.get(id) : null) || null;
    },
  };
}
