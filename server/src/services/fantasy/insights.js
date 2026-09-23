/**
 * Insights orchestration — the bridge between Yahoo data, the external stats
 * providers, and the analysis engines.
 *
 * Pipeline:
 *   normalized Yahoo players
 *     -> provider player index (cross-reference)
 *     -> canonical players (identity layer)
 *     -> provider season/recent stats for matched players
 *     -> ProGM projection per player (league-specific scoring)
 *     -> projectionProvider consumed by Start/Sit, Trades, Waivers, Roster
 *
 * If no external provider is available (no RAPIDAPI_KEY and fallback disabled,
 * or all providers unhealthy), this returns a context with externalAvailable
 * = false and a null projectionProvider, so every engine degrades cleanly to
 * Yahoo-only deterministic behavior. Nothing is fabricated.
 */
import * as providers from '../providers/index.js';
import { buildCanonicalPlayers, yahooIdFromKeys } from '../identity/playerIdentity.js';
import { projectPlayer, makeProjectionProvider } from './projection.js';

/** canonicalId used across the app for a normalized Yahoo player. */
export function canonicalIdOf(player) {
  return player?.playerKey || player?.playerId || null;
}

/** Map a normalized Yahoo player into the identity layer's source shape. */
function toSource(player) {
  return {
    playerKey: player.playerKey,
    playerId: player.playerId,
    name: player.name,
    teamAbbr: player.teamAbbr,
    yahooPlayerId: yahooIdFromKeys({
      editorialPlayerKey: player.editorialPlayerKey,
      playerKey: player.playerKey,
      playerId: player.playerId,
    }),
  };
}

/**
 * Build a projection context for a set of normalized Yahoo players.
 *
 * @param {Object} params
 * @param {string|number} params.season          Yahoo season (e.g. "2025")
 * @param {Array} params.players                 normalized Yahoo players to project
 * @param {Array} params.statCategories          league settings.statCategories
 * @param {boolean} [params.scoringSupported]    whether league scoring can be applied
 * @returns {Promise<Object>} projection context
 */
export async function buildProjectionContext({ season, players, statCategories, scoringSupported = true }) {
  const base = {
    externalAvailable: false,
    projectionProvider: null,
    projectionByCanonicalId: new Map(),
    identityDiagnostics: null,
    freshness: null,
    providerStatus: providers.providerStatus(),
    reason: null,
  };

  if (!scoringSupported) {
    return { ...base, reason: 'League scoring format is not supported for points projections.' };
  }
  if (!players?.length) {
    return { ...base, reason: 'No players to project.' };
  }

  // 1. Provider player index (cross-reference). Null => Yahoo-only mode.
  let indexResult;
  try {
    indexResult = await providers.getPlayerIndex(season);
  } catch {
    indexResult = null;
  }
  if (!indexResult?.value) {
    return { ...base, reason: 'External NBA data provider is not available; running in Yahoo-only mode.' };
  }

  // 2. Canonical identity mapping + diagnostics.
  const source = players.map(toSource);
  const { players: canonical, diagnostics } = buildCanonicalPlayers(source, indexResult.value);
  const matched = canonical.filter((c) => c.matched && c.externalId);
  const externalIds = matched.map((c) => c.externalId);

  // 3. Stats for matched players only (budget-conscious).
  let statsResult = null;
  if (externalIds.length) {
    try {
      statsResult = await providers.getSeasonStats(season, externalIds);
    } catch {
      statsResult = null;
    }
  }
  const statsByExternalId = new Map();
  if (statsResult?.value) {
    for (const s of statsResult.value) statsByExternalId.set(String(s.externalId), s);
  }

  // 4. Project each canonical player using the league's actual scoring.
  const projectionByCanonicalId = new Map();
  for (const c of canonical) {
    const stats = c.externalId ? statsByExternalId.get(String(c.externalId)) || null : null;
    const projection = projectPlayer({ stats, statCategories });
    projection.matchMethod = c.matchMethod;
    projection.matched = c.matched;
    projectionByCanonicalId.set(c.canonicalId, projection);
  }

  const projectionProvider = makeProjectionProvider({ projectionByCanonicalId, canonicalIdOf });
  const freshness = providers.cache.freshnessFrom(indexResult.meta, statsResult?.meta);
  const projectedCount = [...projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length;

  return {
    externalAvailable: true,
    projectionProvider,
    projectionByCanonicalId,
    identityDiagnostics: { ...diagnostics, projectedCount },
    freshness,
    providerStatus: providers.providerStatus(),
    reason: projectedCount > 0 ? null : 'Provider returned no usable stats for these players yet.',
  };
}

/** Attach a projection summary to a normalized player (for UI display). */
export function withProjection(player, ctx) {
  const proj = ctx?.projectionByCanonicalId?.get(canonicalIdOf(player)) || null;
  return {
    ...player,
    projection: proj
      ? {
          projectedPoints: proj.projectedPoints,
          confidence: proj.confidence,
          method: proj.method,
          unsupportedStats: proj.unsupportedStats,
          breakdown: proj.breakdown,
        }
      : null,
  };
}
