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
import { takePlayerFallbackBudget, playerFallbackBudgetStatus } from './playerFallbackBudget.js';
import tank01Provider, { isEnabled as tank01Enabled, getRequestCount, resetRequestCount, getRequestBreakdown, getLastError } from './tank01Provider.js';
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
    tank01: { enabled: tank01Enabled(), playerBudget: playerFallbackBudgetStatus(), configured: tank01Provider.isConfigured(), requestCount: getRequestCount(), requestBreakdown: getRequestBreakdown(), lastError: getLastError(), ...health.status('tank01') },
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
/** Empty array/object = "provider said nothing", never a value worth keeping for hours or days. */
const isEmptyValue = (value) => value == null || (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.keys(value).length === 0);

/** Drop a cached empty result (e.g. one stored before payload validation existed) so a healthy provider response can replace it. */
function dropEmptyCacheEntry(key) {
  const hit = cache.get(key);
  if (hit && isEmptyValue(hit.value)) cache.del(key);
}

async function withProvider(cacheKey, ttl, op, supports = () => true, usable = () => true) {
  // Serve fresh cache immediately without touching any provider, unless it is a value the caller considers unusable.
  if (cache.isFresh(cacheKey)) {
    const hit = cache.get(cacheKey);
    if (usable(hit.value)) return hit;
    cache.del(cacheKey);
  }

  const candidates = candidateProviders().filter(supports);
  for (const provider of candidates) {
    try {
      const result = await cache.remember(cacheKey, { provider: provider.name, ttl }, () => op(provider));
      if (!usable(result.value)) { cache.del(cacheKey); throw new Error(`Unusable ${cacheKey} value from ${provider.name}`); }
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
  return stale && usable(stale.value) ? stale : null;
}

/** Player cross-reference index (bulk, cached daily). */
export function getPlayerIndex(season) {
  return withProvider(
    `playerIndex:${season}`,
    cache.TTL.playerIndex,
    (p) => p.getPlayerIndex(season),
    (p) => typeof p.getPlayerIndex === 'function',
    (value) => Array.isArray(value) && value.length > 0, // an empty directory is a failed fetch, not a day-long answer
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
      dropEmptyCacheEntry(`seasonStatsAll:${season}:${provider.name}`);
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
  // Only providers that DON'T have bulk (bulk was already tried above).
  const perPlayerCapable = (p) => typeof p.getSeasonStatsBulk !== 'function' && (typeof p.getSeasonStatsForPlayer === 'function' || typeof p.getSeasonStats === 'function');
  const statsKey = (externalId) => `seasonStats:${season}:${externalId}`;
  // Each UNCACHED player costs one provider request, so spend a bounded budget (see playerFallbackBudget.js). Cached players
  // are free. Players beyond the budget get their last cached value if any, otherwise no stats (never fabricated); later
  // requests fill the rest in as the budget window resets, because every fetched player is cached.
  const uncached = ids.filter((externalId) => !cache.isFresh(statsKey(externalId)));
  // Only Tank01 (paid) is budgeted; a free per-player provider such as nba.com is never blocked by it.
  const tankReachable = candidateProviders().some((p) => p.name === 'tank01' && perPlayerCapable(p));
  const granted = tankReachable ? takePlayerFallbackBudget(uncached.length) : uncached.length;
  const allowed = new Set(uncached.slice(0, granted));
  const skippedForBudget = tankReachable ? uncached.length - allowed.size : 0;
  if (skippedForBudget > 0) logBudgetLimited(skippedForBudget, uncached.length);
  // Bounded concurrency (not all at once) so the provider circuit breaker can stop a failing provider mid-flight.
  const results = await mapWithConcurrency(ids, PER_PLAYER_CONCURRENCY, (externalId) => {
    return withProvider(
      statsKey(externalId),
      cache.TTL.seasonStats,
      async (p) => {
        if (typeof p.getSeasonStatsForPlayer === 'function') {
          return p.getSeasonStatsForPlayer(season, externalId);
        }
        const arr = await p.getSeasonStats(season, [externalId]);
        return Array.isArray(arr) ? (arr[0] || null) : null;
      },
      // Over budget: Tank01 is excluded, so the player gets a free provider, else the last cached value, else nothing.
      (p) => perPlayerCapable(p) && (p.name !== 'tank01' || allowed.has(externalId)),
    );
  });

  const value = [];
  for (const r of results) {
    if (!r) continue;
    metas.push(r.meta);
    if (r.value) value.push(r.value); // null => player had no game data; omit (never fabricate)
  }

  const merged = cache.freshnessFrom(...metas) || { provider: 'none', fetchedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), stale: false, cacheHit: true };
  return { value, meta: { ...merged, cacheHit: metas.length > 0 && metas.every((m) => m.cacheHit), budgetLimited: skippedForBudget > 0, skippedForBudget } };
}

const PER_PLAYER_CONCURRENCY = 4;
let lastBudgetLogAt = 0;
function logBudgetLimited(skipped, total) {
  if (Date.now() - lastBudgetLogAt < 60 * 1000) return; // one line a minute, no player data
  lastBudgetLogAt = Date.now();
  console.warn('[providers] Per-player stats fallback limited by request budget', { skipped, total, budget: playerFallbackBudgetStatus() });
}

/**
 * Best-effort league-wide season stats without any per-player fallback.
 * Intended for optional historical context where a missing bulk dataset is
 * preferable to multiplying outbound requests by the draft-board size.
 */
export async function getSeasonStatsBulkOnly(season, externalIds) {
  const ids = Array.isArray(externalIds) ? [...new Set(externalIds.map(String))] : [];
  if (!ids.length) {
    return { value: [], meta: { provider: 'cache', fetchedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), stale: false, cacheHit: true } };
  }

  const candidates = candidateProviders().filter((p) => typeof p.getSeasonStatsBulk === 'function');
  for (const provider of candidates) {
    try {
      dropEmptyCacheEntry(`seasonStatsAll:${season}:${provider.name}`);
      const result = await cache.remember(
        `seasonStatsAll:${season}:${provider.name}`,
        { provider: provider.name, ttl: cache.TTL.seasonStats },
        () => provider.getSeasonStatsBulk(season),
      );
      if (!result.meta.cacheHit) health.recordSuccess(provider.name);
      const all = Array.isArray(result.value) ? result.value : [];
      if (all.length) {
        const wanted = new Set(ids);
        return { value: all.filter((s) => wanted.has(String(s.externalId))), meta: result.meta };
      }
    } catch (error) {
      health.recordFailure(provider.name, error);
    }
  }
  return null;
}

/**
 * Official NBA league-wide OREB/DREB totals, normalized to per-game values.
 * This is a single cached request per completed season and is independent of
 * the general nba.com fallback flag because ESPN's bulk feed omits the splits.
 */
export async function getSeasonReboundSplits(season) {
  const cacheKey = `seasonReboundSplits:${season}:nba_stats`;
  if (cache.isFresh(cacheKey)) return cache.get(cacheKey);
  if (!health.canAttempt('nba_stats')) return cache.get(cacheKey) || null;
  try {
    const result = await cache.remember(
      cacheKey,
      { provider: 'nba_stats', ttl: cache.TTL.seasonStats },
      () => nbaStatsProvider.getSeasonReboundSplits(season),
    );
    if (!result.meta.cacheHit) health.recordSuccess('nba_stats');
    return result;
  } catch (error) {
    health.recordFailure('nba_stats', error);
    return cache.get(cacheKey) || null;
  }
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

/**
 * Historical availability (games played) for the last `count` COMPLETED NBA
 * regular seasons. ONE league-wide request per completed season, each cached
 * long-term (completed seasons are immutable) and shared across all users —
 * NEVER per player. Returns a map keyed by externalId:
 *   { externalId -> [{ season, gamesPlayed, gameTotal }] }  (newest season first)
 *
 * Entirely optional and best-effort: any season that fails to fetch is simply
 * omitted, and a total failure returns {} so projections are never broken and
 * no player is penalized for missing history.
 *
 * @param {string|number} currentSeason  active ESPN season start-year
 * @param {number} [count]
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getHistoricalAvailability(currentSeason, count = 3) {
  const provider = candidateProviders().find((p) => typeof p.getSeasonGamesPlayed === 'function' && typeof p.completedSeasons === 'function');
  if (!provider) return { value: {}, meta: { provider: 'none', cacheHit: true } };

  const seasons = provider.completedSeasons(currentSeason, count);
  const standardGameTotal = provider.REGULAR_SEASON_GAMES || 82;
  const byPlayer = {}; // externalId -> [{ season, gamesPlayed, gameTotal }]

  const seasonResults = await mapWithConcurrency(seasons, 4, async (season) => {
    try {
      // One cached, league-wide request per completed season (immutable TTL).
      dropEmptyCacheEntry(`gamesPlayed:${season}:${provider.name}`);
      const result = await cache.remember(
        `gamesPlayed:${season}:${provider.name}`,
        { provider: provider.name, ttl: cache.TTL.history },
        () => provider.getSeasonGamesPlayed(season),
      );
      if (!result.meta.cacheHit) health.recordSuccess(provider.name);
      const observedGames = Object.values(result.value || {}).filter((games) => Number.isFinite(games) && games > 0);
      // Completed shortened seasons are normalized against their observed
      // league maximum, never hardcoded to an 82-game denominator.
      const gameTotal = observedGames.length ? Math.min(standardGameTotal, Math.max(...observedGames)) : standardGameTotal;
      return { season, gameTotal, gamesByPlayer: result.value || {} };
    } catch (error) {
      // A failed season is omitted; never breaks projections or penalizes.
      health.recordFailure(provider.name, error);
      return null;
    }
  });

  for (const seasonResult of seasonResults) {
    if (!seasonResult) continue;
    for (const [externalId, gamesPlayed] of Object.entries(seasonResult.gamesByPlayer)) {
      if (!byPlayer[externalId]) byPlayer[externalId] = [];
      byPlayer[externalId].push({ season: seasonResult.season, gamesPlayed, gameTotal: seasonResult.gameTotal });
    }
  }

  // Keep newest season first for recency weighting downstream.
  for (const id of Object.keys(byPlayer)) byPlayer[id].sort((a, b) => b.season - a.season);
  return { value: byPlayer, meta: { provider: provider.name, cacheHit: false } };
}

export { cache, health };
