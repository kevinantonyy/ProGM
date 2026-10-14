const DEFAULTS = Object.freeze({
  freshTtlMs: 8_000,
  staleTtlMs: 6 * 60 * 60 * 1000,
  baseBackoffMs: 5_000,
  maxBackoffMs: 5 * 60 * 1000,
  circuitThreshold: 3,
  circuitOpenMs: 60_000,
});

const states = new Map();

function stateFor(leagueKey) {
  if (!states.has(leagueKey)) {
    states.set(leagueKey, {
      inFlight: null,
      lastSuccess: null,
      consecutiveDenied: 0,
      nextAllowedAt: 0,
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
  if (!state.lastSuccess || nowMs - state.lastSuccess.fetchedAt > config.staleTtlMs) return null;
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
  const state = stateFor(leagueKey);
  const nowMs = safeNow(now);
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
}

export { DEFAULTS as YAHOO_DRAFT_POLLING_DEFAULTS };
