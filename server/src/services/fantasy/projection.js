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
import { EXISTING_MODEL_VERSION, resolveProjectionModel } from './projectionModel.js';
import { scoreStatLine } from './scoring.js';
import { emptyStatLine } from '../providers/types.js';

export const RECENT_WEIGHT = 0.35;
export const SEASON_WEIGHT = 0.65;

const BLENDED_KEYS = [
  'minutes', 'points', 'rebounds', 'offRebounds', 'defRebounds', 'assists',
  'steals', 'blocks', 'turnovers', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade',
  'personalFouls', 'doubleDoubles', 'tripleDoubles',
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
/**
 * Recency hybrid (feature-flagged, see projectionModel.js). Uses the per-game
 * lines already fetched for recent form (stats.recentGames: the player's games
 * in each team's last completed games, oldest first). An exponentially
 * weighted recent line is blended into the existing expected line with
 * weight min(1, games / rampGames); with no last-season line the weighted
 * recent line is used alone. Stats missing from every game stay as they were.
 */
export function applyRecencyHybrid(base, stats, { halfLife, rampGames }) {
  const games = (stats?.recentGames || []).filter((game) => game?.line)
    .sort((a, b) => String(a.gameDate || '').localeCompare(String(b.gameDate || '')));
  if (!games.length) return { expected: base, recencyWeight: 0, windowGames: 0 };
  const newestFirst = games.slice().reverse();
  const hasSeason = stats?.season && Object.values(stats.season).some((value) => value != null);
  const recencyWeight = hasSeason && base ? Math.min(1, games.length / rampGames) : 1;
  const out = emptyStatLine();
  for (const key of BLENDED_KEYS) {
    let sum = 0;
    let weightSum = 0;
    newestFirst.forEach((game, age) => {
      const value = game.line[key];
      if (value == null) return;
      const weight = 0.5 ** (age / halfLife);
      sum += weight * value;
      weightSum += weight;
    });
    const recent = weightSum ? sum / weightSum : null;
    const prior = base?.[key] ?? null;
    const value = recent == null ? prior : prior == null ? recent : recencyWeight * recent + (1 - recencyWeight) * prior;
    out[key] = value == null ? null : Number(value.toFixed(2));
  }
  out.gamesPlayed = base?.gamesPlayed ?? null;
  return { expected: out, recencyWeight: Number(recencyWeight.toFixed(3)), windowGames: games.length };
}

export const PROJECTION_HORIZONS = Object.freeze({ SEASON: 'season', NEXT_GAME: 'next_game' });

/**
 * @param {'season'|'next_game'} [params.horizon]
 *   'season' (default): season-long projection used by draft value and rankings;
 *     always the existing model, whatever the feature flag says.
 *   'next_game': short-horizon projection for in-season tools; uses the
 *     recency hybrid only when `model` (the feature flag) selects it.
 */
export function projectPlayer({ stats, statCategories, availability = null, horizon = PROJECTION_HORIZONS.SEASON, model = resolveProjectionModel() }) {
  if (horizon !== PROJECTION_HORIZONS.SEASON && horizon !== PROJECTION_HORIZONS.NEXT_GAME) throw new Error(`Unknown projection horizon: ${horizon}.`);
  const active = horizon === PROJECTION_HORIZONS.NEXT_GAME ? model : { kind: 'existing', version: EXISTING_MODEL_VERSION };
  const noData = { projectedPoints: null, perGame: null, confidence: 0, expected: null, breakdown: [], unsupportedStats: [], availability, method: 'no_data', horizon, modelVersion: active.version, hybrid: null };
  if (!stats) return noData;

  const base = blendStatLines(stats.season, stats.recent);
  let expected = base;
  let hybrid = null;
  if (active.kind === 'recency_hybrid') {
    const result = applyRecencyHybrid(base, stats, active);
    expected = result.expected;
    hybrid = { recencyWeight: result.recencyWeight, windowGames: result.windowGames, halfLife: active.halfLife, rampGames: active.rampGames };
  }
  if (!expected) return noData;

  const scored = scoreStatLine(expected, statCategories);
  const historical = scoreStatLine(stats.season, statCategories);
  const weightedCount = (statCategories || []).filter((c) => c && c.enabled !== false && c.pointValue != null).length;

  const confidence = computeConfidence({
    season: stats.season,
    recent: stats.recent,
    recentGameCount: stats.recentGameCount,
    unsupportedCount: scored.unsupportedStats.length,
    weightedCount,
  });

  // The confidence sample term (games played / 40) partly reflects missed
  // games. Season-long draft value already prices availability through
  // expected games, so it can add this shortfall back to avoid a second
  // injury penalty.
  const gp = stats.season?.gamesPlayed;
  const confidenceGamesPlayedShortfall = gp == null ? 0 : Number((0.5 * (1 - Math.min(1, gp / 40))).toFixed(3));

  return {
    projectedPoints: scored.unsupportedStats.length ? null : scored.points,
    perGame: scored.unsupportedStats.length ? null : scored.points,
    confidence,
    expected,
    breakdown: scored.breakdown,
    unsupportedStats: scored.unsupportedStats,
    availability,
    method: scored.unsupportedStats.length ? 'incomplete_scoring_data' : stats.recent ? 'blended_recent_season' : 'season_only',
    horizon,
    modelVersion: active.version,
    hybrid,
    confidenceGamesPlayedShortfall,
    lastSeasonFantasy: {
      points: historical.unsupportedStats.length ? null : historical.points,
      complete: historical.unsupportedStats.length === 0 && historical.points != null,
      missingCategories: historical.unsupportedStats,
      breakdown: historical.breakdown,
    },
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
export function makeProjectionProvider({ projectionByCanonicalId, imageByCanonicalId = new Map(), canonicalIdOf }) {
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
    getHeadshotUrl(player) {
      const id = canonicalIdOf(player);
      return (id ? imageByCanonicalId.get(id) : null) || null;
    },
  };
}
