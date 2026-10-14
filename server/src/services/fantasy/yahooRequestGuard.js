const DEFAULTS = Object.freeze({
  baseBackoffMs: 5_000,
  maxBackoffMs: 5 * 60 * 1000,
  circuitThreshold: 3,
  circuitOpenMs: 60_000,
});

let state = { consecutiveDenied: 0, nextAllowedAt: 0 };

function retryAfterFromHeader(value, nowMs) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function calculatedDelay(count, random, config) {
  const exponential = Math.min(config.maxBackoffMs, config.baseBackoffMs * (2 ** Math.max(0, count - 1)));
  const jitter = 0.75 + Math.max(0, Math.min(1, Number(random?.()) || 0)) * 0.5;
  const delayed = Math.round(exponential * jitter);
  return count >= config.circuitThreshold ? Math.max(config.circuitOpenMs, delayed) : delayed;
}

/** Fail fast while Yahoo's process-wide HTTP 999 circuit is open. */
export function assertYahooRequestAllowed({ now = Date.now } = {}) {
  const nowMs = Number(now());
  if (nowMs >= state.nextAllowedAt) return;
  const error = new Error('Yahoo requests are temporarily paused after repeated request denials.');
  error.httpStatus = 999;
  error.yahooCode = 'CIRCUIT_OPEN';
  error.retryAfterMs = state.nextAllowedAt - nowMs;
  error.synthetic = true;
  throw error;
}

/** Record an actual Yahoo response; only 999 opens the shared circuit. */
export function recordYahooResponse(status, headers, {
  now = Date.now,
  random = Math.random,
  options = {},
} = {}) {
  const code = Number(status);
  if (code >= 200 && code < 300) {
    state = { consecutiveDenied: 0, nextAllowedAt: 0 };
    return { retryAfterMs: 0, circuitOpen: false };
  }
  if (code !== 999) return { retryAfterMs: 0, circuitOpen: state.nextAllowedAt > Number(now()) };

  const config = { ...DEFAULTS, ...options };
  const nowMs = Number(now());
  state.consecutiveDenied += 1;
  const headerDelay = retryAfterFromHeader(headers?.['retry-after'], nowMs);
  const delay = Math.max(headerDelay || 0, calculatedDelay(state.consecutiveDenied, random, config));
  state.nextAllowedAt = nowMs + delay;
  return {
    retryAfterMs: delay,
    circuitOpen: state.consecutiveDenied >= config.circuitThreshold,
    consecutiveDenied: state.consecutiveDenied,
  };
}

export function resetYahooRequestGuard() {
  state = { consecutiveDenied: 0, nextAllowedAt: 0 };
}

export { DEFAULTS as YAHOO_REQUEST_GUARD_DEFAULTS };
