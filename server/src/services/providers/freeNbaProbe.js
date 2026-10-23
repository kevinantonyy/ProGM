/**
 * EXPERIMENTAL read-only reachability probe for the free NBA data sources.
 *
 * ⚠️ NOT wired into provider selection or any route by default. Its purpose is
 * to answer one question from a given environment (esp. Render): can we reach
 * ESPN public JSON and cdn.nba.com without 403 / 429 / timeout / bot-blocking?
 *
 * It makes at most ONE lightweight request per source and returns a sanitized
 * summary. No keys, no bodies, no secrets. Safe to expose behind an authed
 * admin route later, or to run once via `node -e` on Render.
 */
import { assertUrlAllowed, guardedFetch, isSourceDisabledError } from '../dataSources/policy.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ESPN_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };
const NBA_CDN_HEADERS = { 'User-Agent': UA, Accept: '*/*', Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' };

const TARGETS = [
  { key: 'espn_byathlete', url: 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1&season=2025&seasontype=2', headers: ESPN_HEADERS },
  { key: 'espn_injuries', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', headers: ESPN_HEADERS },
  { key: 'nba_cdn_schedule', url: 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', headers: NBA_CDN_HEADERS },
];

function classify(status) {
  if (status === 200) return 'ok';
  if (status === 403) return 'forbidden_or_bot_block';
  if (status === 429) return 'rate_limited';
  if (status != null && status >= 500) return 'provider_error';
  if (status == null) return 'network_or_timeout';
  return 'http_error';
}

/** Probe one target once. Returns a sanitized result (no body, no headers). */
async function probeOne({ key, url, headers }, timeoutMs = 10000) {
  const t0 = Date.now();
  // A disabled source (ESPN / NBA.com) is reported as such WITHOUT any request.
  try { assertUrlAllowed(url); } catch (e) { if (isSourceDisabledError(e)) return { source: key, status: null, ok: false, kind: 'source_disabled', ms: 0 }; throw e; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await guardedFetch(url, { headers, signal: controller.signal });
    // Drain a little to confirm it's real JSON without holding the whole body.
    const ct = res.headers.get('content-type') || '';
    return { source: key, status: res.status, ok: res.ok, kind: classify(res.status), contentType: ct.slice(0, 40), ms: Date.now() - t0 };
  } catch (e) {
    return { source: key, status: null, ok: false, kind: e.name === 'AbortError' ? 'network_or_timeout' : classify(null), error: e.name, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe all free-data sources once each (sequential to stay gentle).
 * @returns {Promise<{ reachable: boolean, results: Array }>}
 */
export async function probeFreeNbaSources() {
  const results = [];
  for (const t of TARGETS) results.push(await probeOne(t));
  const reachable = results.every((r) => r.ok);
  return { reachable, results, checkedAt: new Date().toISOString() };
}

export default probeFreeNbaSources;
