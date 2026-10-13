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
    imageByCanonicalId: new Map(),
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
    // Distinguish WHY the provider is unavailable so production can report a
    // precise, sanitized diagnostic instead of a generic message. This reads
    // the provider's recorded last error (status + classified kind) — it does
    // NOT make another provider request.
    const status = providers.providerStatus();
    const tank = status?.tank01 || {};
    const diag = tank.lastError || null;
    let reason = 'External NBA data provider is not available; running in Yahoo-only mode.';
    if (!tank.configured) {
      reason = 'NBA stats provider is not configured on the server (RAPIDAPI_KEY missing).';
    } else if (diag?.kind === 'quota_exceeded') {
      reason = 'NBA stats provider quota/rate limit reached; projections will return when it resets.';
    } else if (diag?.kind === 'invalid_key') {
      reason = 'NBA stats provider rejected the API key (check RAPIDAPI_KEY).';
    } else if (diag?.kind === 'access_forbidden') {
      reason = 'NBA stats provider denied access (subscription/plan issue).';
    } else if (diag?.kind === 'provider_error') {
      reason = 'NBA stats provider is having a temporary outage; retrying later.';
    } else if (diag?.kind === 'network_error') {
      reason = 'Could not reach the NBA stats provider from the server (network).';
    }
    return {
      ...base,
      reason,
      // Structured, sanitized diagnostic for the UI/report (no keys/bodies).
      diagnostic: {
        provider: 'tank01',
        available: false,
        configured: Boolean(tank.configured),
        reason: diag?.kind || (tank.configured ? 'unavailable' : 'not_configured'),
        status: diag?.status ?? null,
        rateLimit: diag?.rateLimit || null,
        breakerState: tank.state || null,
      },
    };
  }

  // 2. Canonical identity mapping + diagnostics.
  const source = players.map(toSource);
  const { players: canonical, diagnostics } = buildCanonicalPlayers(source, indexResult.value);
  const matched = canonical.filter((c) => c.matched && c.externalId);
  const externalIds = matched.map((c) => c.externalId);
  // Only identity-safe matches may supply images. The identity layer deliberately
  // drops images for name-only matches, so no headshot is guessed from a name.
  const imageByCanonicalId = new Map(canonical.filter((c) => c.imageUrl).map((c) => [c.canonicalId, c.imageUrl]));

  // 3. Season stats for matched players (ONE league-wide request via the free
  //    provider's bulk path; filtered to our ids). Budget-conscious + shared.
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

  // 3b. Recent form (OPTIONAL). Built from box scores of recently completed
  //     games (one request per game, shared). A failure here must NOT break
  //     season-stat projections — the model falls back to season-only cleanly.
  let recentResult = null;
  try {
    recentResult = await providers.getRecentForm(season);
  } catch {
    recentResult = null;
  }
  const recentByExternalId = recentResult?.value || {};

  // 3c. Historical availability (OPTIONAL): games played across the last 3
  //     completed seasons for durability. Best-effort — any failure yields no
  //     history, which the draft model treats as NEUTRAL (no penalty). Never
  //     breaks projections.
  let historyResult = null;
  try {
    historyResult = await providers.getHistoricalAvailability(season);
  } catch {
    historyResult = null;
  }
  const historyByExternalId = historyResult?.value || {};

  // 4. Project each canonical player using the league's actual scoring. Merge
  //    recent form into the season stats so the EXISTING projection model
  //    (season+recent blend) uses it with no weight changes. Historical
  //    availability is attached as projection.history for the draft durability
  //    adjustment — it does NOT affect the projected points themselves.
  const projectionByCanonicalId = new Map();
  for (const c of canonical) {
    const base = c.externalId ? statsByExternalId.get(String(c.externalId)) || null : null;
    let stats = base;
    if (base && c.externalId) {
      const rec = recentByExternalId[String(c.externalId)];
      if (rec && rec.recent) {
        stats = { ...base, recent: rec.recent, recentGameCount: rec.recentGameCount ?? null };
      }
    }
    const projection = projectPlayer({ stats, statCategories });
    projection.matchMethod = c.matchMethod;
    projection.matched = c.matched;
    projection.history = (c.externalId && historyByExternalId[String(c.externalId)]) || null;
    projectionByCanonicalId.set(c.canonicalId, projection);
  }

  const projectionProvider = makeProjectionProvider({ projectionByCanonicalId, imageByCanonicalId, canonicalIdOf });
  const freshness = providers.cache.freshnessFrom(indexResult.meta, statsResult?.meta, recentResult?.meta);
  const projectedCount = [...projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length;
  const recentCount = Object.keys(recentByExternalId).length;
  const historyCount = Object.keys(historyByExternalId).length;

  return {
    externalAvailable: true,
    projectionProvider,
    projectionByCanonicalId,
    imageByCanonicalId,
    identityDiagnostics: { ...diagnostics, projectedCount, recentFormPlayers: recentCount, historyPlayers: historyCount },
    freshness,
    providerStatus: providers.providerStatus(),
    // Per-source availability so the UI/report can see what the primary served.
    diagnostic: {
      provider: statsResult?.meta?.provider || indexResult?.meta?.provider || 'free_nba',
      available: true,
      sources: {
        seasonStats: Boolean(statsResult?.value?.length),
        recentForm: recentCount > 0,
        playerIndex: Boolean(indexResult?.value?.length),
        history: historyCount > 0,
      },
    },
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
