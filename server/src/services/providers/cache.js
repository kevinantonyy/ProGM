/**
 * In-memory TTL cache with freshness metadata.
 *
 * External NBA data is fetched centrally and cached server-side so ProGM never
 * calls providers on every React render, tab switch, or recalculation. Shared
 * datasets (player index, injuries, per-season stats) are cached once and
 * reused across all users/leagues.
 *
 * Each entry records provider, fetchedAt, and expiresAt so the API can expose
 * data-freshness metadata to the frontend.
 *
 * This is a single-process cache (fine for one Render web service). If ProGM
 * later scales to multiple instances, swap this module for Redis behind the
 * same get/set interface.
 */

const store = new Map(); // key -> { value, provider, fetchedAt, expiresAt }

// Per-dataset TTLs (ms), tuned to how fast each dataset changes.
export const TTL = {
  playerIndex: 24 * 60 * 60 * 1000, // player list / cross-refs: ~daily
  seasonStats: 12 * 60 * 60 * 1000, // season averages: twice daily
  recentGames: 6 * 60 * 60 * 1000, // recent game logs: a few times daily
  injuries: 30 * 60 * 1000, // injury/status: every 30 min
  schedule: 12 * 60 * 60 * 1000, // schedule: twice daily
  projections: 6 * 60 * 60 * 1000, // provider projections: a few times daily
};

/** Read a cache entry. Returns { value, meta } or null if absent. Expired entries are returned as stale. */
export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  return {
    value: entry.value,
    meta: {
      provider: entry.provider,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      stale: now > entry.expiresAt,
      cacheHit: true,
    },
  };
}

export function set(key, value, { provider, ttl }) {
  const now = Date.now();
  store.set(key, { value, provider, fetchedAt: now, expiresAt: now + ttl });
}

export function has(key) {
  return store.has(key);
}

/** True if a fresh (non-expired) entry exists. */
export function isFresh(key) {
  const entry = store.get(key);
  return Boolean(entry && Date.now() <= entry.expiresAt);
}

export function del(key) {
  store.delete(key);
}

export function clearAll() {
  store.clear();
}

/**
 * Cache-aware fetch wrapper.
 *   - If a fresh entry exists, return it (cacheHit).
 *   - Otherwise run loader(). On success, cache and return it.
 *   - On loader failure, fall back to a STALE cached value if present
 *     (better slightly-old real data than none), marked stale.
 *   - If nothing cached and loader fails, rethrow so the caller can degrade.
 *
 * @param {string} key
 * @param {{ ttl:number, provider:string }} opts
 * @param {() => Promise<any>} loader
 */
export async function remember(key, opts, loader) {
  if (isFresh(key)) return get(key);

  try {
    const value = await loader();
    set(key, value, opts);
    return { value, meta: { provider: opts.provider, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + opts.ttl).toISOString(), stale: false, cacheHit: false } };
  } catch (error) {
    const stale = get(key);
    if (stale) return stale; // serve stale data rather than nothing
    throw error;
  }
}

/** Freshness metadata for a computed/analysis result that layered on cached inputs. */
export function freshnessFrom(...metas) {
  const valid = metas.filter(Boolean);
  if (!valid.length) return null;
  const oldestFetched = valid.reduce((min, m) => (m.fetchedAt < min ? m.fetchedAt : min), valid[0].fetchedAt);
  return {
    providers: [...new Set(valid.map((m) => m.provider))],
    fetchedAt: oldestFetched,
    stale: valid.some((m) => m.stale),
    cacheHit: valid.every((m) => m.cacheHit),
  };
}
