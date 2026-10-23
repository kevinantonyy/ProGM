/**
 * Read-only ESPN season-stats probe for the protected diagnostics route.
 *
 * Makes EXACTLY ONE request: the same URL and headers the projection provider uses for league-wide season stats, then reports
 * AGGREGATE facts only (status, content type, bytes, elapsed time, JSON validity, athlete / usable-stat counts, process memory,
 * error category). It never returns or logs the body, any player data, the URL, headers or error text.
 *
 * It deliberately does NOT use the provider's jsonFetch: that helper bumps request counters and records lastError, and this
 * diagnostic must not change provider caches, circuit breakers or any other application state. It also never calls Yahoo,
 * Tank01 or any other provider.
 */
import { BYATHLETE_URL, ESPN_HEADERS, mapEspnSeasonStats, hasUsableLine, espnSeasonEndYear } from './freeNbaProvider.js';
import { assertUrlAllowed, guardedFetch } from '../dataSources/policy.js';

export const PROBE_TIMEOUT_MS = 12000; // same per-request budget the provider uses
export const PROBE_MAX_BYTES = 12 * 1024 * 1024; // the real response is ~7.7 MB; stop reading (and never parse) beyond this

const MB = 1024 * 1024;
const mb = (bytes) => Math.round((bytes / MB) * 10) / 10;

/** The Yahoo league season for "now": the season whose stats the projection provider will request is this minus one. */
export function currentLeagueSeason(now = new Date()) {
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

const categoryForStatus = (status) => (status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'http_error');
const safeContentType = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9/+.;=\- ]/g, '').slice(0, 60) || null;

/**
 * @param {{leagueSeason?: number, fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, memory?: () => NodeJS.MemoryUsage}} [options]
 */
export async function probeEspnSeasonStats({ leagueSeason = currentLeagueSeason(), fetchImpl = (url, init) => guardedFetch(url, init), timeoutMs = PROBE_TIMEOUT_MS, maxBytes = PROBE_MAX_BYTES, memory = process.memoryUsage } = {}) {
  const projectionSeason = leagueSeason - 1; // exactly how buildProjectionContext chooses the stats season
  assertUrlAllowed(BYATHLETE_URL(projectionSeason)); // ESPN disabled: throw before any timer or request, whichever fetchImpl is used
  const before = memory();
  const started = Date.now();
  const out = {
    checkedAt: new Date(started).toISOString(),
    leagueSeason,
    projectionSeason,
    espnSeasonEndYear: espnSeasonEndYear(projectionSeason),
    status: null,
    contentType: null,
    bytes: 0,
    elapsedMs: null,
    jsonValid: false,
    athleteCount: null,
    usableStatCount: null,
    memoryMB: null,
    errorCategory: null,
    verdict: 'unusable',
  };

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('probe-timeout')); }, timeoutMs); });
  deadline.catch(() => {}); // a late rejection must never become an unhandled one
  let reader = null;

  try {
    const response = await Promise.race([fetchImpl(BYATHLETE_URL(projectionSeason), { headers: ESPN_HEADERS, signal: controller.signal }), deadline]);
    out.status = response.status;
    out.contentType = safeContentType(response.headers?.get?.('content-type'));
    if (!response.ok) {
      out.errorCategory = categoryForStatus(response.status);
      response.body?.cancel?.().catch?.(() => {});
      return out;
    }

    // Read with a hard size cap; never buffer more than maxBytes (+ one chunk).
    const chunks = [];
    if (response.body?.getReader) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        out.bytes += value.byteLength;
        if (out.bytes > maxBytes) { out.errorCategory = 'response_too_large'; reader.cancel().catch(() => {}); return out; }
        chunks.push(value);
      }
    } else {
      const text = await Promise.race([response.text(), deadline]); // non-streaming test doubles only
      out.bytes = Buffer.byteLength(text);
      if (out.bytes > maxBytes) { out.errorCategory = 'response_too_large'; return out; }
      chunks.push(Buffer.from(text));
    }

    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); out.jsonValid = true; } catch { out.errorCategory = 'not_json'; return out; }
    chunks.length = 0;

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.athletes)) { out.errorCategory = 'unrecognized_shape'; return out; }
    out.athleteCount = payload.athletes.length;
    if (out.athleteCount === 0) { out.errorCategory = 'no_athletes'; out.usableStatCount = 0; return out; }
    out.usableStatCount = mapEspnSeasonStats(payload).filter((row) => hasUsableLine(row.season)).length;
    if (out.usableStatCount === 0) { out.errorCategory = 'no_usable_stats'; return out; }
    out.verdict = 'ok';
    return out;
  } catch (error) {
    out.errorCategory = error?.message === 'probe-timeout' || error?.name === 'AbortError' ? 'timeout' : 'network_error';
    reader?.cancel?.().catch?.(() => {});
    return out; // the error text is intentionally dropped: only the category leaves this function
  } finally {
    clearTimeout(timer);
    out.elapsedMs = Date.now() - started;
    const after = memory();
    out.memoryMB = { rssBefore: mb(before.rss), rssAfter: mb(after.rss), heapUsedBefore: mb(before.heapUsed), heapUsedAfter: mb(after.heapUsed) };
  }
}
