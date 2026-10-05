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
import tank01Provider, { getRequestCount, resetRequestCount, getRequestBreakdown, getLastError } from './tank01Provider.js';
import nbaStatsProvider from './nbaStatsProvider.js';
import freeNbaProvider, {
  getRequestCount as freeRequestCount,
  resetRequestCount as resetFreeRequestCount,
  getRequestBreakdown as freeRequestBreakdown,
  getLastError as freeLastError,
} from './freeNbaProvider.js';

// free_nba is the PRIMARY external NBA data source (ESPN + NBA CDN, $0, no key).
// It can be disabled via FREE_NBA_PRIMARY=false to fall back to Tank01-first.
const FREE_PRIMARY = () => process.env.FREE_NBA_PRIMARY !== 'false';
const FALLBACK_ENABLED = () => process.env.NBA_STATS_FALLBACK === 'true';

/**
 * Ordered list of candidate providers that are currently usable.
 * Order defines priority: the first provider that satisfies a capability wins,
 * and later providers are only attempted when earlier ones FAIL. Tank01 is only
 * reached when free_nba fails or cannot serve the dataset.
 */
function candidateProviders() {
  const list = [];
  if (FREE_PRIMARY() && freeNbaProvider.isConfigured() && health.canAttempt('free_nba')) list.push(freeNbaProvider);
  if (tank01Provider.isConfigured() && health.canAttempt('tank01')) list.push(tank01Provider);
  if (FALLBACK_ENABLED() && health.canAttempt('nba_stats')) list.push(nbaStatsProvider);
  // If free_nba is explicitly de-prioritized, still allow it as a last resort.
  if (!FREE_PRIMARY() && freeNbaProvider.isConfigured() && health.canAttempt('free_nba')) list.push(freeNbaProvider);
  return list;
}

/** Whether ANY external provider is currently available (for status reporting). */
export function externalDataAvailable() {
  return candidateProviders().length > 0 || freeNbaProvider.isConfigured() || tank01Provider.isConfigured();
}

export function providerStatus() {
  return {
    free_nba: { primary: FREE_PRIMARY(), configured: freeNbaProvider.isConfigured(), requestCount: freeRequestCount(), requestBreakdown: freeRequestBreakdown(), lastError: freeLastError(), ...health.status('free_nba') },
    tank01: { configured: tank01Provider.isConfigured(), requestCount: getRequestCount(), requestBreakdown: getRequestBreakdown(), lastError: getLastError(), ...health.status('tank01') },
    nba_stats: { enabled: FALLBACK_ENABLED(), ...health.status('nba_stats') },
  };
}

// Request instrumentation, re-exported for API-budget visibility.
export { getRequestCount as tank01RequestCount, resetRequestCount as resetTank01RequestCount, getRequestBreakdown as tank01RequestBreakdown };
export { freeRequestCount as freeNbaRequestCount, resetFreeRequestCount as resetFreeNbaRequestCount, freeRequestBreakdown as freeNbaRequestBreakdown };

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

/**
 * Season (+recent) stats for a specific set of external ids.
 *
 * Cached PER PLAYER (`seasonStats:{season}:{externalId}`) rather than per id-set
 * blob, so:
 *   - a player fetched by one user/league is reused by every other user/league
 *     (NBA player stats are global, not per-user),
 *   - only players NOT already cached trigger a provider call, and
 *   - concurrent identical player requests are coalesced by cache single-flight
 *     (one Tank01 call in flight per player, others await it).
 *
 * Returns { value: PlayerStats[], meta } shaped like the old batch call so the
 * insights layer is unchanged. meta.cacheHit is true only when EVERY requested
 * player came from cache (no provider call happened).
 *
 * @param {string} season
 * @param {string[]} externalIds
 */
export async function getSeasonStats(season, externalIds) {
  const ids = Array.isArray(externalIds) ? [...new Set(externalIds.map(String))] : [];
  if (!ids.length) {
    return { value: [], meta: { provider: 'cache', fetchedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), stale: false, cacheHit: true } };
  }

  // Preferred path: a provider that exposes a LEAGUE-WIDE bulk method (free_nba
  // via ESPN byathlete) returns the entire league in ONE request, cached once
  // globally (`seasonStatsAll:{season}`) and filtered per id. This eliminates
  // the per-player request explosion — N players cost ONE outbound request.
  const bulkCandidates = candidateProviders().filter((p) => typeof p.getSeasonStatsBulk === 'function');
  for (const provider of bulkCandidates) {
    try {
      const result = await cache.remember(
        `seasonStatsAll:${season}:${provider.name}`,
        { provider: provider.name, ttl: cache.TTL.seasonStats },
        () => provider.getSeasonStatsBulk(season),
      );
      if (!result.meta.cacheHit) health.recordSuccess(provider.name);
      const all = Array.isArray(result.value) ? result.value : [];
      if (all.length) {
        const wanted = new Set(ids);
        const value = all.filter((s) => wanted.has(String(s.externalId)));
        return { value, meta: result.meta };
      }
      // Empty bulk result -> fall through to the next provider / per-player path.
    } catch (error) {
      health.recordFailure(provider.name, error);
      // Fall through to per-player path (e.g. Tank01).
    }
  }

  // Fallback path: providers WITHOUT a bulk method (Tank01, nba.com) are fetched
  // per player, each cached individually and shared across users/leagues.
  const metas = [];
  const results = await Promise.all(ids.map((externalId) =>
    withProvider(
      `seasonStats:${season}:${externalId}`,
      cache.TTL.seasonStats,
      async (p) => {
        if (typeof p.getSeasonStatsForPlayer === 'function') {
          return p.getSeasonStatsForPlayer(season, externalId);
        }
        const arr = await p.getSeasonStats(season, [externalId]);
        return Array.isArray(arr) ? (arr[0] || null) : null;
      },
      // Only providers that DON'T have bulk (bulk was already tried above).
      (p) => typeof p.getSeasonStatsBulk !== 'function' && (typeof p.getSeasonStatsForPlayer === 'function' || typeof p.getSeasonStats === 'function'),
    ),
  ));

  const value = [];
  for (const r of results) {
    if (!r) continue;
    metas.push(r.meta);
    if (r.value) value.push(r.value); // null => player had no game data; omit (never fabricate)
  }

  const merged = cache.freshnessFrom(...metas) || { provider: 'none', fetchedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), stale: false, cacheHit: true };
  return { value, meta: { ...merged, cacheHit: metas.length > 0 && metas.every((m) => m.cacheHit) } };
}

/**
 * League-wide recent-form map (externalId -> { recent StatLine, recentGameCount }),
 * built from NBA CDN box scores of recently completed games. One request per
 * completed game, shared across all players/users. Only providers exposing
 * getRecentForm (free_nba) support this; others return null (projection then
 * uses season-only, which the model already handles).
 *
 * The individual box-score fetches are cached as immutable (a final box score
 * never changes), so warm loads cost zero outbound requests.
 */
export async function getRecentForm(season) {
  const candidates = candidateProviders().filter((p) => typeof p.getRecentForm === 'function');
  for (const provider of candidates) {
    try {
      const result = await cache.remember(
        `recentForm:${season}:${provider.name}`,
        { provider: provider.name, ttl: cache.TTL.recentGames },
        async () => {
          // Reuse the cached schedule-with-ids (shared with getSchedule's data)
          // so recent-form does NOT issue a duplicate schedule request.
          let scheduleWithIds = null;
          if (typeof provider.getScheduleWithIds === 'function') {
            const sched = await cache.remember(
              `scheduleIds:${season}:${provider.name}`,
              { provider: provider.name, ttl: cache.TTL.schedule },
              () => provider.getScheduleWithIds(season),
            );
            scheduleWithIds = sched.value;
          }
          // Wrap the provider's per-game box-score fetch so each gameId is cached
          // immutably and shared (never refetched once final).
          const cachedFetchBox = (gameId) => cache.remember(
            `boxscore:${gameId}`,
            { provider: provider.name, ttl: cache.TTL.boxscore },
            () => provider.getBoxscore(gameId),
          ).then((r) => r.value);
          const map = await provider.getRecentForm(season, { fetchBox: cachedFetchBox, scheduleWithIds });
          // Store as a plain object (Map isn't JSON/structured-clone friendly in cache).
          return Object.fromEntries(map);
        },
      );
      if (!result.meta.cacheHit) health.recordSuccess(provider.name);
      return result; // { value: { externalId -> {recent, recentGameCount} }, meta }
    } catch (error) {
      health.recordFailure(provider.name, error);
    }
  }
  return null;
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

/**
 * League-wide team schedules for a season (bulk, cached). Shared across all
 * users/leagues since NBA schedules are global — one build serves everyone.
 */
export function getSchedule(season) {
  return withProvider(
    `schedule:${season}`,
    cache.TTL.schedule,
    (p) => p.getSchedule(season),
    (p) => typeof p.getSchedule === 'function'
  );
}

export { cache, health };
