/**
 * External data-source policy. Which third-party DATA sources this server may contact or serve cached data from.
 *
 * Default-deny: a source is on only when its switch is exactly "allow". Switches are read at call time, so one process always behaves
 * consistently, and a changed value takes effect when the service restarts (Render restarts on any environment change).
 *
 *   espn     OFF. ESPN wrote: "We are not interested in licensing data at this time and decline to permit the use of any of our API
 *            data." Covers espn.com / espncdn.com hosts: NBA stats, injuries, fantasy leagues, news, images, probes.
 *   nba_com  OFF. cdn.nba.com / stats.nba.com are reached with browser-style headers and no written authorization for fantasy use.
 *   tank01   OFF. Paid RapidAPI provider. It also needs its existing PROGM_TANK01_ENABLED flag and RAPIDAPI_KEY; the origin of its
 *            data and its terms are not yet confirmed, so it is never a silent fallback for a disabled source.
 *
 * Enforcement points (see policy.test.js, which scans for bypasses): guardedFetch() at every outbound call, the route gate in
 * routes/espn.js, the provider orchestrator's candidate list, and the cache, which never stores or serves a disabled source's entries.
 * Yahoo and Gemini are governed elsewhere (consent, aiDataPolicy) and are unaffected.
 */
export const DATA_SOURCES = Object.freeze({
  espn: Object.freeze({ env: 'PROGM_DATA_ESPN', label: 'ESPN' }),
  nba_com: Object.freeze({ env: 'PROGM_DATA_NBA_COM', label: 'NBA.com' }),
  tank01: Object.freeze({ env: 'PROGM_DATA_TANK01', label: 'Tank01' }),
});

// Hostname -> source. Suffix match on a label boundary, so "notespn.com" and "espn.com.example.test" never match.
const HOST_SOURCES = [
  { source: 'espn', match: /(^|\.)(espn\.com|espncdn\.com|espnstatic\.com)$/ },
  { source: 'nba_com', match: /(^|\.)nba\.com$/ },
  { source: 'tank01', match: /(^|\.)rapidapi\.com$/ },
];

// Provider names used by the orchestrator and cache entries -> source.
const PROVIDER_SOURCES = Object.freeze({ free_nba: 'espn', espn: 'espn', nba_stats: 'nba_com', tank01: 'tank01' });

export function sourceAllowed(source, env = process.env) {
  const entry = DATA_SOURCES[source];
  return Boolean(entry) && String(env?.[entry.env] ?? '').trim().toLowerCase() === 'allow';
}

export function sourceForHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return HOST_SOURCES.find((h) => h.match.test(host))?.source ?? null;
}

export function sourceForUrl(url) {
  try { return sourceForHost(new URL(String(url)).hostname); } catch { return null; }
}

export class SourceDisabledError extends Error {
  constructor(source) {
    super(`${DATA_SOURCES[source]?.label ?? source} data is disabled`);
    this.name = 'SourceDisabledError';
    this.code = 'SOURCE_DISABLED';
    this.source = source;
  }
}
export const isSourceDisabledError = (error) => error?.code === 'SOURCE_DISABLED';

/** Throws, before any request, counter or timer, if the URL's host belongs to a disabled source. Unlisted hosts are not this policy's concern. */
export function assertUrlAllowed(url, env = process.env) {
  const source = sourceForUrl(url);
  if (source && !sourceAllowed(source, env)) throw new SourceDisabledError(source);
}

/** The only way server code reaches ESPN, NBA.com or RapidAPI hosts. `fetchImpl` resolves global fetch at call time (tests stub it). */
export async function guardedFetch(url, init, { env = process.env, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  assertUrlAllowed(url, env);
  return fetchImpl(url, init);
}

export function providerSource(name) { return PROVIDER_SOURCES[name] ?? null; }
export function providerAllowed(name, env = process.env) {
  const source = providerSource(name);
  return source == null || sourceAllowed(source, env);
}

/** A cache entry may be stored or served only if neither its provider nor its upstream (`derivedFrom`) is a disabled source. */
export function cacheEntryServable(entry, env = process.env) {
  return providerAllowed(entry?.provider, env) && providerAllowed(entry?.derivedFrom, env);
}

/** What the client is told about ESPN-backed features. Static: no database, no external request. */
export function espnAvailability(env = process.env) {
  const available = sourceAllowed('espn', env);
  return available
    ? { available: true }
    : { available: false, message: 'ESPN data is not available in ProGM. ESPN has declined to permit use of its data, so ESPN league sync, Fantasy Football, ESPN news and ESPN projections are switched off. Your Yahoo basketball league is not affected.' };
}
