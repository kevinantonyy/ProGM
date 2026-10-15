/**
 * Local-database guard. Shared by db/connection.js (hard stop) and scripts/shadowPreflight.mjs (report).
 * Returns hosts only: never passwords, usernames, or full URLs.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export function databaseHost(url) {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return '(unparseable)'; }
}

export function isLocalHost(host) { return LOCAL_HOSTS.has(host); }

/** The URL the pool actually uses is DATABASE_URL_UNPOOLED first, then DATABASE_URL: both are checked. */
export function databaseProblems(env = process.env) {
  const problems = [];
  const notes = [];
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const host = databaseHost(env[name]);
    if (host == null) { if (name === 'DATABASE_URL') problems.push('DATABASE_URL is not set.'); continue; }
    if (isLocalHost(host)) notes.push(`${name}: local host (${host}) - OK`);
    else problems.push(`${name} points to a NON-LOCAL host (${host}). This may be your production database.`);
  }
  if (!env.DATABASE_URL_UNPOOLED && !env.DATABASE_URL) problems.push('No database URL is set.');
  return { problems, notes };
}

export function requireLocalDatabase(env = process.env) {
  return ['on', 'true', '1'].includes(String(env.PROGM_REQUIRE_LOCAL_DB ?? '').trim().toLowerCase());
}

/** Throws (before any pool exists) when PROGM_REQUIRE_LOCAL_DB is on and any configured database is not local. */
export function assertLocalDatabaseIfRequired(env = process.env) {
  if (!requireLocalDatabase(env)) return;
  const { problems } = databaseProblems(env);
  if (problems.length) throw new Error(`PROGM_REQUIRE_LOCAL_DB is on, refusing to connect: ${problems.join(' ')}`);
}
