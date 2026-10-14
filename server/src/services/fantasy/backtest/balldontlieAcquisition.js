import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Offline-research acquisition of BALLDONTLIE per-game player stats into the
 * saved-response format read by `--format balldontlie-stats`. Never imported by
 * production code. Nothing is fetched without an API key AND an explicit,
 * human-attested acquisition authorization; every run is page-capped and
 * rate-limited.
 *
 * Unverified against the live API (docs were unreachable when this was
 * written): the NBA stats path (`/v1/stats` vs `/nba/v1/stats`) and whether
 * `seasons[]` filters the stats endpoint. Both are configurable; verify with a
 * one-page `--max-pages 1` run before any larger acquisition.
 */

export const BALLDONTLIE_TERMS_URL = 'https://www.balldontlie.io/terms.html';
export const BALLDONTLIE_DOCS_URL = 'https://docs.balldontlie.io/';
export const DEFAULT_STATS_URL = 'https://api.balldontlie.io/v1/stats';
export const DEFAULT_REQUESTS_PER_MINUTE = 5; // Free tier limit; paid tiers are higher.
export const MAX_PAGES_HARD_LIMIT = 500;
const MAX_RETRIES = 3;

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`BALLDONTLIE acquisition requires ${label}.`);
  return text;
}

/** Validate the human attestation required before any network request. */
export function validateAcquisitionAuthorization(authorization) {
  if (authorization?.acquisitionAuthorized !== true) {
    throw new Error('BALLDONTLIE acquisition refused: acquisitionAuthorized must be explicitly true after reviewing the provider terms.');
  }
  const termsReviewedAt = authorization.termsReviewedAt && !Number.isNaN(Date.parse(authorization.termsReviewedAt))
    ? new Date(authorization.termsReviewedAt).toISOString() : null;
  if (!termsReviewedAt) throw new Error('BALLDONTLIE acquisition requires termsReviewedAt (ISO date the terms were reviewed).');
  return {
    name: requireText(authorization.name, 'a source name'),
    permission: requireText(authorization.permission, 'permission/license evidence'),
    subscriptionTier: requireText(authorization.subscriptionTier, 'the subscription tier in use'),
    termsReviewedAt,
  };
}

function validateSeasons(seasons) {
  const list = [...new Set((seasons || []).map(Number))].sort((a, b) => a - b);
  if (!list.length || list.some((season) => !Number.isInteger(season) || season < 1946 || season > 2100)) {
    throw new Error('BALLDONTLIE acquisition requires explicit integer season start years.');
  }
  return list;
}

function buildUrl(baseUrl, { seasons, perPage, cursor }) {
  const url = new URL(baseUrl);
  for (const season of seasons) url.searchParams.append('seasons[]', String(season));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('postseason', 'false');
  if (cursor != null) url.searchParams.set('cursor', String(cursor));
  return url;
}

function retryDelayMs(response, attempt) {
  const header = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * (2 ** attempt);
}

/**
 * Fetch per-game stats pages. `fetchImpl` and `sleep` are injectable so tests
 * never touch the network. The API key is sent only in the Authorization
 * header and is never included in the returned object or error messages.
 */
export async function acquireBalldontlieStats({
  apiKey,
  authorization,
  seasons,
  maxPages = 1,
  perPage = 100,
  requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE,
  baseUrl = DEFAULT_STATS_URL,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = () => new Date(),
}) {
  const attestation = validateAcquisitionAuthorization(authorization);
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('BALLDONTLIE acquisition requires an API key (BALLDONTLIE_API_KEY).');
  const seasonList = validateSeasons(seasons);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_HARD_LIMIT) {
    throw new Error(`maxPages must be an integer from 1 to ${MAX_PAGES_HARD_LIMIT}.`);
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('perPage must be an integer from 1 to 100.');
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) throw new Error('requestsPerMinute must be positive.');
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');

  const intervalMs = Math.ceil(60000 / requestsPerMinute);
  const pages = [];
  let cursor = null;
  let requests = 0;
  let complete = false;
  while (pages.length < maxPages) {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      if (requests > 0) await sleep(intervalMs);
      requests += 1;
      response = await fetchImpl(buildUrl(baseUrl, { seasons: seasonList, perPage, cursor }).toString(), {
        headers: { Authorization: key, Accept: 'application/json' },
      });
      if (response.status !== 429 || attempt >= MAX_RETRIES) break;
      await sleep(retryDelayMs(response, attempt));
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`BALLDONTLIE returned HTTP ${response.status}: the key is invalid or the subscription tier does not include this endpoint.`);
    }
    if (!response.ok) throw new Error(`BALLDONTLIE returned HTTP ${response.status}; acquisition stopped after ${pages.length} page(s).`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error('Unexpected BALLDONTLIE response: missing data array.');
    pages.push({ data: body.data, meta: body.meta ?? null });
    const next = body.meta?.next_cursor;
    if (next == null || next === '') { complete = true; break; }
    if (next === cursor) throw new Error('BALLDONTLIE pagination did not advance; stopping to avoid a request loop.');
    cursor = next;
  }

  const acquiredAt = now().toISOString();
  return {
    provenance: {
      name: attestation.name,
      provider: 'BALLDONTLIE',
      permission: attestation.permission,
      authorized: true,
      acquiredAt,
      sourceUrl: baseUrl,
      licenseUrl: BALLDONTLIE_TERMS_URL,
      datasetVersion: `stats seasons=${seasonList.join(',')} pages=${pages.length}${complete ? '' : ' (incomplete)'}`,
      subscriptionTier: attestation.subscriptionTier,
      termsReviewedAt: attestation.termsReviewedAt,
    },
    acquisition: {
      endpoint: baseUrl,
      seasons: seasonList,
      perPage,
      pagesFetched: pages.length,
      requests,
      rows: pages.reduce((sum, page) => sum + page.data.length, 0),
      complete,
      nextCursor: complete ? null : cursor,
    },
    pages,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export async function runAcquisitionCli({ env = process.env } = {}) {
  const authorizationPath = argument('--authorization');
  const outPath = argument('--out');
  const seasons = String(argument('--seasons') || '').split(',').filter(Boolean).map(Number);
  if (!authorizationPath || !outPath || !seasons.length) {
    throw new Error('Usage: node balldontlieAcquisition.js --authorization authorization.json --seasons 2023 --out export.json [--max-pages 1] [--rpm 5] [--base-url URL]  (requires BALLDONTLIE_API_KEY)');
  }
  if (fs.existsSync(path.resolve(outPath))) throw new Error(`Refusing to overwrite existing file: ${outPath}`);
  const result = await acquireBalldontlieStats({
    apiKey: env.BALLDONTLIE_API_KEY,
    authorization: JSON.parse(fs.readFileSync(path.resolve(authorizationPath), 'utf8')),
    seasons,
    maxPages: Number(argument('--max-pages') || 1),
    requestsPerMinute: Number(argument('--rpm') || DEFAULT_REQUESTS_PER_MINUTE),
    baseUrl: argument('--base-url') || DEFAULT_STATS_URL,
  });
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result.acquisition, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcquisitionCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
