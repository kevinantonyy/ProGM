/**
 * Provider health tracking with a simple circuit breaker.
 *
 * Purpose: a failing primary provider (Tank01) must NOT cause every request to
 * immediately retry Tank01 or immediately hammer the fallback. After a few
 * consecutive failures the breaker OPENS for a cooldown window, during which
 * calls short-circuit (skip that provider) and the orchestrator can decide to
 * use cached data or the fallback.
 *
 * States: closed (healthy) -> open (failing, skip) -> half-open (probe once).
 */

const FAILURE_THRESHOLD = 3; // consecutive failures before opening
const OPEN_COOLDOWN_MS = 5 * 60 * 1000; // stay open 5 min before probing

const providers = new Map(); // name -> { failures, state, openedAt, lastError }

function ensure(name) {
  if (!providers.has(name)) {
    providers.set(name, { failures: 0, state: 'closed', openedAt: 0, lastError: null });
  }
  return providers.get(name);
}

/** Can we attempt a call to this provider right now? */
export function canAttempt(name) {
  const p = ensure(name);
  if (p.state === 'closed') return true;
  if (p.state === 'open') {
    if (Date.now() - p.openedAt >= OPEN_COOLDOWN_MS) {
      p.state = 'half-open'; // allow a single probe
      return true;
    }
    return false;
  }
  // half-open: allow the probe through
  return true;
}

export function recordSuccess(name) {
  const p = ensure(name);
  p.failures = 0;
  p.state = 'closed';
  p.lastError = null;
}

export function recordFailure(name, error) {
  const p = ensure(name);
  p.failures += 1;
  p.lastError = error?.message || String(error);
  if (p.state === 'half-open' || p.failures >= FAILURE_THRESHOLD) {
    p.state = 'open';
    p.openedAt = Date.now();
  }
}

export function status(name) {
  const p = ensure(name);
  return {
    provider: name,
    state: p.state,
    failures: p.failures,
    healthy: p.state === 'closed',
    // Never expose internal error details that might contain sensitive data.
    lastErrorType: p.lastError ? p.lastError.slice(0, 80) : null,
  };
}

export function reset(name) {
  providers.delete(name);
}
