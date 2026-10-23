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

const store = new Map(); // key -> { value, provider, derivedFrom, fetchedAt, expiresAt, purgeAt }
const inFlight = new Map(); // key -> Promise<{ value, meta }>  (single-flight de-dup)

/**
 * Retention. `expiresAt` is when an entry stops being FRESH; it may still be served as a stale fallback when its loader fails
 * (better slightly-old real data than none), but only until `purgeAt`, after which it is deleted and the memory is released.
 *
 * Yahoo-derived entries (provider 'yahoo', or any entry tagged derivedFrom: 'yahoo' even though another component computed it)
 * get a SHORT stale grace and a 24-hour hard cap, in line with Yahoo's documented rule that data not listed as storable
 * indefinitely must be deleted within 24 hours. Everything else keeps a 24-hour grace so independent providers still serve a
 * stale fallback through a long outage, but is no longer retained forever.
 *
 * The grace is a trade-off, not just a safety margin: during an HTTP 999 block (backoff 5 s to 5 min, circuit open for at least
 * 60 s) a stale workspace is served instead of an error, which avoids extra Yahoo requests. 15 minutes covers that comfortably.
 */
export const RETENTION = Object.freeze({
  yahooStaleGraceMs: 15 * 60 * 1000,
  defaultStaleGraceMs: 24 * 60 * 60 * 1000,
  yahooHardCapMs: 24 * 60 * 60 * 1000,
  sweepIntervalMs: 60 * 1000,
});

const isYahooEntry = (provider, derivedFrom) => provider === 'yahoo' || derivedFrom === 'yahoo';

// Per-dataset TTLs (ms), tuned to how fast each dataset changes.
export const TTL = {
  playerIndex: 24 * 60 * 60 * 1000, // player list / cross-refs: ~daily
  seasonStats: 12 * 60 * 60 * 1000, // season averages: twice daily
  recentGames: 6 * 60 * 60 * 1000, // recent game logs: a few times daily
  injuries: 30 * 60 * 1000, // injury/status: every 30 min
  schedule: 12 * 60 * 60 * 1000, // schedule: twice daily
  projections: 6 * 60 * 60 * 1000, // provider projections: a few times daily
  boxscore: 7 * 24 * 60 * 60 * 1000, // completed box scores are immutable once final: 7 days
  history: 30 * 24 * 60 * 60 * 1000, // completed-season games-played is immutable: 30 days
};

/** Read a cache entry. Returns { value, meta } or null if absent. Expired entries are returned as stale. */
export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now > entry.purgeAt) { store.delete(key); return null; } // past the stale-fallback window: gone
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

export function set(key, value, { provider, ttl, derivedFrom = null, staleGraceMs } = {}) {
  const now = Date.now();
  const yahoo = isYahooEntry(provider, derivedFrom);
  const grace = staleGraceMs ?? (yahoo ? RETENTION.yahooStaleGraceMs : RETENTION.defaultStaleGraceMs);
  let purgeAt = now + ttl + grace;
  if (yahoo) purgeAt = Math.min(purgeAt, now + RETENTION.yahooHardCapMs); // never beyond 24 h, whatever the caller asked
  store.set(key, { value, provider, derivedFrom, fetchedAt: now, expiresAt: now + ttl, purgeAt });
  maybeSweep(now);
}

export function has(key) {
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() > entry.purgeAt) { store.delete(key); return false; }
  return true;
}

/** True if a fresh (non-expired) entry exists. */
export function isFresh(key) {
  const entry = store.get(key);
  return Boolean(entry && Date.now() <= entry.expiresAt && Date.now() <= entry.purgeAt);
}

/** Delete every entry past its purge deadline. Returns how many were removed. `now` is injectable for tests. */
export function purgeExpired(now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of store) {
    if (now > entry.purgeAt) { store.delete(key); removed += 1; }
  }
  return removed;
}

let lastSweepAt = Date.now();
function maybeSweep(now) {
  if (now - lastSweepAt < RETENTION.sweepIntervalMs) return;
  lastSweepAt = now;
  purgeExpired(now);
}

/** Number of entries currently held (fresh or within their stale window). */
export function size() {
  return store.size;
}

// Idle servers get swept too (no traffic means no opportunistic sweeps). unref(): never keeps the process alive.
const sweeper = setInterval(() => purgeExpired(), RETENTION.sweepIntervalMs);
sweeper.unref?.();
export function stopSweeper() {
  clearInterval(sweeper);
}

export function del(key) {
  store.delete(key);
}

export function clearAll() {
  store.clear();
}

/**
 * Cache-aware fetch wrapper with single-flight de-duplication.
 *   - If a fresh entry exists, return it (cacheHit) without touching a provider.
 *   - If an identical fetch is already in flight, AWAIT that one instead of
 *     starting a second — so N concurrent misses for the same key trigger a
 *     single provider request, not N.
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

  // Single-flight: coalesce concurrent misses for the same key onto one promise.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await loader();
      set(key, value, opts);
      return { value, meta: { provider: opts.provider, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + opts.ttl).toISOString(), stale: false, cacheHit: false } };
    } catch (error) {
      const stale = get(key);
      if (stale) return stale; // serve stale data rather than nothing
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/** Number of in-flight loads (for tests/diagnostics). */
export function inFlightCount() {
  return inFlight.size;
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
