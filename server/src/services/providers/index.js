/**
 * Provider orchestrator — the single entry point analysis engines use to get
 * external NBA data. Handles provider selection, caching, health/circuit
 * breaking, and graceful degradation to Yahoo-only.
 *
 * Selection order per capability:
 *   1. Tank01 (if RAPIDAPI_KEY configured AND breaker closed)
 *   2. fresh/stale cached Tank01 data (handled inside cache.remember)
 *   3. stats.nba.com fallback (only if enabled AND breaker closed)
 *   4. null  -> caller runs in Yahoo-only mode (never fabricated)
 *
 * Enable the nba.com fallback explicitly via NBA_STATS_FALLBACK=true (off by
 * default in production because it commonly blocks datacenter IPs). It is handy
 * for local development where RAPIDAPI_KEY may be absent.
 */
import * as cache from './cache.js';
import * as health from './health.js';
import tank01Provider from './tank01Provider.js';
import nbaStatsProvider from './nbaStatsProvider.js';

const FALLBACK_ENABLED = () => process.env.NBA_STATS_FALLBACK === 'true';

/** Ordered list of candidate providers that are currently usable. */
function candidateProviders() {
  const list = [];
  if (tank01Provider.isConfigured() && health.canAttempt('tank01')) list.push(tank01Provider);
  if (FALLBACK_ENABLED() && health.canAttempt('nba_stats')) list.push(nbaStatsProvider);
  return list;
}

/** Whether ANY external provider is currently available (for status reporting). */
export function externalDataAvailable() {
  return candidateProviders().length > 0 || tank01Provider.isConfigured();
}

export function providerStatus() {
  return {
    tank01: { configured: tank01Provider.isConfigured(), ...health.status('tank01') },
    nba_stats: { enabled: FALLBACK_ENABLED(), ...health.status('nba_stats') },
  };
}

/**
 * Run an operation against the best available provider, recording health and
 * caching the result. Returns { value, meta } or null when no provider can
 * serve it (Yahoo-only degradation).
 *
 * @param {string} cacheKey
 * @param {number} ttl
 * @param {(provider) => Promise<any>} op   receives the chosen provider
 * @param {(provider) => boolean} [supports] capability check per provider
 */
async function withProvider(cacheKey, ttl, op, supports = () => true) {
  // Serve fresh cache immediately without touching any provider.
  if (cache.isFresh(cacheKey)) return cache.get(cacheKey);

  const candidates = candidateProviders().filter(supports);
  for (const provider of candidates) {
    try {
      const result = await cache.remember(cacheKey, { provider: provider.name, ttl }, () => op(provider));
      // remember() may have served stale cache from a prior provider on failure;
      // only count a genuine fresh fetch as success.
      if (!result.meta.cacheHit) health.recordSuccess(provider.name);
      return result;
    } catch (error) {
      health.recordFailure(provider.name, error);
      // Try the next candidate provider.
    }
  }

  // Last resort: any stale cached value beats nothing.
  const stale = cache.get(cacheKey);
  return stale || null;
}

/** Player cross-reference index (bulk, cached daily). */
export function getPlayerIndex(season) {
  return withProvider(
    `playerIndex:${season}`,
    cache.TTL.playerIndex,
    (p) => p.getPlayerIndex(season),
    (p) => typeof p.getPlayerIndex === 'function'
  );
}

/** Season (+recent) stats for a specific set of external ids, cached. */
export function getSeasonStats(season, externalIds) {
  // Cache key is derived from the sorted id set so identical requests share cache.
  const idKey = Array.isArray(externalIds) && externalIds.length ? `:${[...externalIds].sort().join(',').slice(0, 200)}` : ':all';
  return withProvider(
    `seasonStats:${season}${idKey}`,
    cache.TTL.seasonStats,
    (p) => p.getSeasonStats(season, externalIds),
    (p) => typeof p.getSeasonStats === 'function'
  );
}

/** League-wide injuries (bulk, cached ~30min). */
export function getInjuries() {
  return withProvider(
    'injuries:nba',
    cache.TTL.injuries,
    (p) => p.getInjuries(),
    (p) => typeof p.getInjuries === 'function'
  );
}

export { cache, health };
