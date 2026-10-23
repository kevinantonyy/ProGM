const DEFAULTS = Object.freeze({
  freshTtlMs: 8_000,
  staleTtlMs: 2 * 60 * 60 * 1000, // raw draft-results fallback; was 6 h (provisional until Yahoo clarifies retention)
  baseBackoffMs: 5_000,
  maxBackoffMs: 5 * 60 * 1000,
  circuitThreshold: 3,
  circuitOpenMs: 60_000,
  controlIdleTtlMs: 24 * 60 * 60 * 1000, // retry metadata only, never raw picks
});

const states = new Map();

/**
 * Expire raw picks independently of retry control state, even during backoff or an in-flight request.
 * Consecutive denials survive the retry deadline: only success (or 24 hours of inactivity) resets them.
 */
export function purgeExpiredDraftStates({ now = Date.now, options = {} } = {}) {
  const config = { ...DEFAULTS, ...options };
  const nowMs = safeNow(now);
  let removed = 0;
  for (const [leagueKey, state] of states) {
    staleSuccess(state, nowMs, { staleTtlMs: options.staleTtlMs ?? state.staleTtlMs });
    if (state.inFlight || nowMs < state.nextAllowedAt) continue;
    if (!state.lastSuccess && (state.consecutiveDenied === 0 || nowMs - state.lastActivityAt >= config.controlIdleTtlMs)) {
      states.delete(leagueKey); removed += 1;
    }
  }
  return removed;
}

let lastPurgeAt = 0;
function maybePurge(nowMs, config) {
  if (nowMs - lastPurgeAt < 60_000) return;
  lastPurgeAt = nowMs;
  purgeExpiredDraftStates({ now: () => nowMs, options: config });
}

const draftStateSweeper = setInterval(() => purgeExpiredDraftStates(), 60_000);
draftStateSweeper.unref?.();

function stateFor(leagueKey, nowMs, config) {
  if (!states.has(leagueKey)) {
    states.set(leagueKey, {
      inFlight: null,
      lastSuccess: null,
      consecutiveDenied: 0,
      nextAllowedAt: 0,
      lastActivityAt: nowMs,
      staleTtlMs: config.staleTtlMs,
    });
  }
  return states.get(leagueKey);
}

function safeNow(now) {
  return typeof now === 'function' ? Number(now()) : Date.now();
}

function retryDelay(failureCount, random, config) {
  const exponential = Math.min(config.maxBackoffMs, config.baseBackoffMs * (2 ** Math.max(0, failureCount - 1)));
  const jitter = 0.75 + Math.max(0, Math.min(1, Number(random?.()) || 0)) * 0.5;
  const jittered = Math.round(exponential * jitter);
  return failureCount >= config.circuitThreshold
    ? Math.max(config.circuitOpenMs, jittered)
    : jittered;
}

function staleSuccess(state, nowMs, config) {
  if (state.lastSuccess && nowMs - state.lastSuccess.fetchedAt > config.staleTtlMs) state.lastSuccess = null;
  return state.lastSuccess;
}

function unavailableResult(state, nowMs, config, reason = 'Yahoo draft results are temporarily unavailable.') {
  const stale = staleSuccess(state, nowMs, config);
  return {
    value: stale?.value ?? null,
    meta: {
      cacheHit: Boolean(stale),
      stale: Boolean(stale),
      temporaryUnavailable: true,
      message: reason,
      fetchedAt: stale ? new Date(stale.fetchedAt).toISOString() : null,
      retryAfterMs: Math.max(1_000, state.nextAllowedAt - nowMs),
      consecutiveDenied: state.consecutiveDenied,
      circuitOpen: state.consecutiveDenied >= config.circuitThreshold,
    },
  };
}

/**
 * League-scoped Yahoo draft-results coordinator.
 *
 * - one upstream request at a time per league, regardless of users/tabs
 * - an 8s bounded fresh window so 5s client polls do not all reach Yahoo
 * - exponential backoff + jitter and a circuit after repeated HTTP 999s
 * - last successful real response remains available during a temporary block
 */
export async function fetchYahooDraftResults({
  leagueKey,
  loader,
  now = Date.now,
  random = Math.random,
  options = {},
}) {
  const config = { ...DEFAULTS, ...options };
  const nowMs = safeNow(now);
  maybePurge(nowMs, config);
  const state = stateFor(leagueKey, nowMs, config);
  state.lastActivityAt = nowMs;
  state.staleTtlMs = config.staleTtlMs;
  const stale = staleSuccess(state, nowMs, config);

  if (stale && nowMs - stale.fetchedAt <= config.freshTtlMs) {
    return {
      value: stale.value,
      meta: {
        cacheHit: true,
        stale: false,
        temporaryUnavailable: false,
        fetchedAt: new Date(stale.fetchedAt).toISOString(),
        retryAfterMs: 0,
        consecutiveDenied: 0,
        circuitOpen: false,
      },
    };
  }
  if (nowMs < state.nextAllowedAt) return unavailableResult(state, nowMs, config);
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      const value = await loader();
      const fetchedAt = safeNow(now);
      state.lastSuccess = { value, fetchedAt };
      state.lastActivityAt = fetchedAt;
      state.consecutiveDenied = 0;
      state.nextAllowedAt = 0;
      return {
        value,
        meta: {
          cacheHit: false,
          stale: false,
          temporaryUnavailable: false,
          fetchedAt: new Date(fetchedAt).toISOString(),
          retryAfterMs: 0,
          consecutiveDenied: 0,
          circuitOpen: false,
        },
      };
    } catch (error) {
      if (Number(error?.httpStatus) !== 999) throw error;
      const failedAt = safeNow(now);
      state.lastActivityAt = failedAt;
      state.consecutiveDenied += 1;
      state.nextAllowedAt = failedAt + retryDelay(state.consecutiveDenied, random, config);
      return unavailableResult(state, failedAt, config, 'Yahoo temporarily denied draft-results access. Showing the last successful draft state when available.');
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

export function peekYahooDraftResults(leagueKey, { now = Date.now, options = {} } = {}) {
  const state = states.get(leagueKey);
  if (!state) return null;
  const config = { ...DEFAULTS, ...options };
  const nowMs = safeNow(now);
  const stale = staleSuccess(state, nowMs, config);
  return stale ? { value: stale.value, fetchedAt: new Date(stale.fetchedAt).toISOString() } : null;
}

export function clearYahooDraftPollingState() {
  states.clear();
  lastPurgeAt = 0;
}

/** Non-identifying counts for retention regression tests; never exposes league keys or picks. */
export function draftPollingCacheStats() {
  return { states: states.size, cachedResults: [...states.values()].filter((s) => s.lastSuccess != null).length };
}

export { DEFAULTS as YAHOO_DRAFT_POLLING_DEFAULTS };
