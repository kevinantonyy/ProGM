/**
 * Request budget for the per-player Tank01 stats fallback (Tank01 has no league-wide stats endpoint, so each uncached
 * player costs one paid-API request). Cached players are free and never counted; only uncached lookups spend budget.
 *
 * DEFAULT IS 0 = DISABLED. Tank01 may bill per request, so nothing is spent until you set BOTH limits to numbers you have
 * verified against your RapidAPI plan and its overage settings:
 *
 *   PROGM_TANK01_PLAYER_BUDGET        max uncached per-player lookups per hour  (default 0)
 *   PROGM_TANK01_PLAYER_DAILY_BUDGET  max per 24 hours                          (default 0)
 *
 * Unset, blank or invalid values mean 0 (fail closed). Windows are fixed-length and start at first use.
 */
const WINDOWS = [
  { name: 'hourly', ms: 60 * 60 * 1000, envKey: 'PROGM_TANK01_PLAYER_BUDGET', fallback: 0 },
  { name: 'daily', ms: 24 * 60 * 60 * 1000, envKey: 'PROGM_TANK01_PLAYER_DAILY_BUDGET', fallback: 0 },
];

const state = new Map(); // window name -> { start, used }

/** Non-negative integer from env; anything else (unset, blank, negative, fractional, junk) falls back to the default. */
function limitFor(window, env) {
  const raw = env?.[window.envKey];
  if (raw == null || String(raw).trim() === '') return window.fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : window.fallback;
}

function current(window, now) {
  const existing = state.get(window.name);
  if (existing && now - existing.start < window.ms) return existing;
  const fresh = { start: now, used: 0 };
  state.set(window.name, fresh);
  return fresh;
}

/** Reserve up to `requested` lookups. Returns how many are granted (possibly fewer, possibly 0). */
export function takePlayerFallbackBudget(requested, { now = Date.now(), env = process.env } = {}) {
  let granted = Math.max(0, Math.floor(Number(requested) || 0));
  const windows = WINDOWS.map((window) => ({ limit: limitFor(window, env), usage: current(window, now) }));
  for (const { limit, usage } of windows) granted = Math.min(granted, Math.max(0, limit - usage.used));
  for (const { usage } of windows) usage.used += granted;
  return granted;
}

/** Sanitized view for diagnostics (no secrets): limits, usage and when each window resets. */
export function playerFallbackBudgetStatus({ now = Date.now(), env = process.env } = {}) {
  const out = { exhausted: false };
  for (const window of WINDOWS) {
    const limit = limitFor(window, env);
    const usage = current(window, now);
    const remaining = Math.max(0, limit - usage.used);
    out[window.name] = { limit, used: usage.used, remaining, resetsAt: new Date(usage.start + window.ms).toISOString() };
    if (remaining === 0) out.exhausted = true;
  }
  return out;
}

export function resetPlayerFallbackBudget() {
  state.clear();
}
