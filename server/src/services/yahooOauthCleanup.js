/**
 * Scheduled removal of EXPIRED short-lived Yahoo OAuth rows. Previously these were deleted only when someone started another sign-in
 * (routes/yahoo.js), so an idle server kept them past their 10 / 15 minute lifetimes.
 *
 * Touches only yahoo_oauth_states (state, 10 min) and yahoo_pending_connections (pre-account tokens, 15 min), and only rows already past
 * their own expiry. It never touches yahoo_connections (the active credentials) and makes no request to Yahoo.
 */
export const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const STATEMENTS = [
  ['oauthStates', 'DELETE FROM yahoo_oauth_states WHERE expires_at < NOW()'],
  ['pendingConnections', 'DELETE FROM yahoo_pending_connections WHERE claim_expires_at < NOW()'],
];

export async function cleanupExpiredYahooOAuthRows(execute) {
  const removed = {};
  for (const [name, sql] of STATEMENTS) {
    try { const [result] = await execute(sql); removed[name] = result?.affectedRows ?? 0; }
    catch (error) { removed[name] = 0; console.error(`Yahoo OAuth cleanup (${name}) failed:`, error.message); }
  }
  return removed;
}

/** Runs once now, then every `intervalMs`. The timer is unref'd so it never keeps the process alive. Returns a stop function. */
export function startYahooOAuthCleanup(execute, { intervalMs = CLEANUP_INTERVAL_MS } = {}) {
  const run = () => cleanupExpiredYahooOAuthRows(execute);
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
