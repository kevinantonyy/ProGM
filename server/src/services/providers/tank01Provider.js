/**
 * Tank01 provider (PRIMARY).
 *
 * Implements the StatsProvider interface using the Tank01 Fantasy Stats API on
 * RapidAPI. Reads RAPIDAPI_KEY from the server environment ONLY — the key is
 * never sent to the client and never logged.
 *
 * The free tier is ~1000 calls/month, so this provider favors BULK endpoints
 * (one player-list call, one injury call, batched season stats) and relies on
 * the cache layer above it to avoid repeat calls.
 *
 * All responses are validated defensively; missing fields become null.
 */
import { num, emptyStatLine } from './types.js';

const HOST = 'tank01-fantasy-stats.p.rapidapi.com';
const BASE = `https://${HOST}`;
const DEFAULT_TIMEOUT_MS = 8000;

function apiKey() {
  return process.env.RAPIDAPI_KEY || null;
}

/** Tank01 is a paid API, so it is OFF unless PROGM_TANK01_ENABLED is exactly on/true/1. Having RAPIDAPI_KEY never enables it. */
export function isEnabled(env = process.env) {
  return ['on', 'true', '1'].includes(String(env?.PROGM_TANK01_ENABLED ?? '').trim().toLowerCase());
}

export function isConfigured() {
  return isEnabled() && Boolean(apiKey());
}

// --- Request instrumentation (for API-budget visibility, no secrets logged) ---
let requestCount = 0;
// Per-endpoint breakdown so we can attribute every outbound Tank01 request.
const endpointCounts = { playerList: 0, gamesForPlayer: 0, injuryList: 0, teamSchedule: 0, other: 0 };

/**
 * Last outbound error, SANITIZED for diagnostics (never contains the API key,
 * headers, or response body). Classifies the HTTP status into an actionable
 * kind so the UI/report can say "quota_exceeded" vs "invalid_key" etc.
 */
let lastError = null; // { status:number|null, kind:string, at:string }

/** Map an HTTP status (or network failure) to an actionable diagnostic kind. */
function classifyStatus(status) {
  if (status === 401) return 'invalid_key';
  if (status === 403) return 'access_forbidden'; // subscription/plan/permission
  if (status === 429) return 'quota_exceeded';   // rate limit or monthly quota
  if (status != null && status >= 500) return 'provider_error';
  if (status == null) return 'network_error';
  return 'http_error';
}

export function getLastError() {
  return lastError;
}

function classifyEndpoint(path) {
  if (path.startsWith('/getNBAPlayerList')) return 'playerList';
  if (path.startsWith('/getNBAGamesForPlayer')) return 'gamesForPlayer';
  if (path.startsWith('/getNBAInjuryList')) return 'injuryList';
  if (path.startsWith('/getNBATeamSchedule')) return 'teamSchedule';
  return 'other';
}

export function getRequestCount() {
  return requestCount;
}
export function getRequestBreakdown() {
  return { ...endpointCounts, total: requestCount };
}
export function resetRequestCount() {
  requestCount = 0;
  for (const k of Object.keys(endpointCounts)) endpointCounts[k] = 0;
}

async function tankFetch(path, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  // The only place that talks to Tank01: if it is disabled nothing can leave the process, whoever calls this.
  if (!isEnabled()) throw new Error('Tank01 is disabled (set PROGM_TANK01_ENABLED=true to enable it)');
  const key = apiKey();
  if (!key) throw new Error('Tank01 not configured');

  requestCount += 1; // count every actual outbound Tank01 request (cache misses only)
  endpointCounts[classifyEndpoint(path)] += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Record a SANITIZED diagnostic. RapidAPI exposes rate-limit metadata via
      // x-ratelimit-* headers (limit / remaining / reset); capture them so the
      // report can say whether it's a rate window or a monthly plan quota, and
      // when it resets. No key, no body, no other headers are stored.
      const rateLimit = {
        limit: res.headers.get('x-ratelimit-requests-limit'),
        remaining: res.headers.get('x-ratelimit-requests-remaining'),
        reset: res.headers.get('x-ratelimit-requests-reset'),
        retryAfter: res.headers.get('retry-after'),
      };
      lastError = { status: res.status, kind: classifyStatus(res.status), at: new Date().toISOString(), rateLimit };
      const err = new Error(`Tank01 HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    lastError = null; // clear on a successful call
    const json = await res.json();
    // Tank01 wraps payloads in { statusCode, body }.
    return json?.body ?? json;
  } catch (error) {
    // Network/DNS/timeout (no HTTP status) — record as a sanitized network error.
    if (error.httpStatus == null) {
      lastError = { status: null, kind: 'network_error', at: new Date().toISOString(), rateLimit: null };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Convert a Tank01 season season-string. Tank01 uses a single year (e.g. "2025"). */
function tankSeason(season) {
  return String(season || new Date().getFullYear());
}

/** GET /getNBAPlayerList -> ProviderPlayerRef[] */
export async function getPlayerIndex() {
  const body = await tankFetch('/getNBAPlayerList');
  const list = Array.isArray(body) ? body : [];
  return list
    .map((p) => ({
      externalId: p?.playerID != null ? String(p.playerID) : null,
      name: p?.longName || p?.espnName || p?.bRefName || '',
      teamAbbr: p?.team || null,
      yahooId: p?.yahooPlayerID != null && p.yahooPlayerID !== '' ? String(p.yahooPlayerID) : null,
    }))
    .filter((p) => p.externalId && p.name);
}

/** Map a Tank01 per-game/agg stat object to a provider-independent StatLine. */
function toStatLine(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const line = emptyStatLine();
  line.gamesPlayed = num(stats.gamesPlayed ?? stats.GP);
  line.minutes = num(stats.mins ?? stats.min);
  line.points = num(stats.pts);
  line.rebounds = num(stats.reb ?? stats.TRB);
  line.offRebounds = num(stats.OffReb ?? stats.oreb);
  line.defRebounds = num(stats.DefReb ?? stats.dreb);
  line.assists = num(stats.ast);
  line.steals = num(stats.stl);
  line.blocks = num(stats.blk);
  line.turnovers = num(stats.TOV ?? stats.tov);
  line.personalFouls = num(stats.pf ?? stats.PF);
  line.fgMade = num(stats.fgm);
  line.fgAtt = num(stats.fga);
  line.ftMade = num(stats.ftm);
  line.ftAtt = num(stats.fta);
  line.threesMade = num(stats.tptfgm ?? stats.fg3m);
  line.doubleDoubles = num(stats.doubleDouble ?? stats.DD);
  line.tripleDoubles = num(stats.tripleDouble ?? stats.TD);
  return line;
}

/** Average a list of game stat lines into a single per-game StatLine (or null). */
function aggregateGames(list) {
  const sum = emptyStatLine();
  const keys = ['minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personalFouls', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade', 'doubleDoubles', 'tripleDoubles'];
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const k of keys) sum[k] = 0;
  let n = 0;
  for (const g of list) {
    const line = toStatLine(g);
    if (!line) continue;
    n += 1;
    for (const k of keys) {
      if (line[k] == null) continue;
      sum[k] += line[k];
      counts[k] += 1;
    }
  }
  if (!n) return null;
  for (const k of keys) sum[k] = counts[k] ? Number((sum[k] / counts[k]).toFixed(2)) : null;
  sum.gamesPlayed = n;
  return sum;
}

/**
 * Season (+ last-10 recent) averages for ONE player from their game log.
 * This is the single Tank01 network call per player (getNBAGamesForPlayer).
 * The orchestrator caches this per player+season and reuses it across all
 * users/leagues, so a player is only fetched once until the cache expires.
 *
 * @param {string} season
 * @param {string} externalId
 * @returns {Promise<PlayerStats|null>} null when the player has no game data
 */
export async function getSeasonStatsForPlayer(season, externalId) {
  const yr = tankSeason(season);
  const body = await tankFetch(`/getNBAGamesForPlayer?playerID=${encodeURIComponent(externalId)}&season=${yr}`);
  const games = body && typeof body === 'object' ? Object.values(body) : [];
  const valid = games.filter((g) => g && typeof g === 'object');
  if (!valid.length) return null;

  // Games are keyed by gameID which sorts chronologically (YYYYMMDD prefix).
  const chrono = valid
    .map((g) => ({ g, id: String(g.gameID || '') }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((x) => x.g);

  const seasonAvg = aggregateGames(chrono);
  const recent = aggregateGames(chrono.slice(-10));
  return { externalId: String(externalId), season: seasonAvg || emptyStatLine(), recent, recentGameCount: Math.min(10, chrono.length) };
}

/**
 * Season averages for many players. Tank01 has no bulk season-average endpoint,
 * so this is one getNBAGamesForPlayer call per player. The orchestrator
 * (providers/index.js) caches PER PLAYER and only calls this for players whose
 * stats are not already cached, so a warm cache costs zero calls here.
 *
 * @param {string} season
 * @param {string[]} externalIds
 */
export async function getSeasonStats(season, externalIds = []) {
  const out = [];
  for (const externalId of externalIds) {
    try {
      const stats = await getSeasonStatsForPlayer(season, externalId);
      if (stats) out.push(stats);
    } catch {
      // Skip this player on failure; caller degrades gracefully.
    }
  }
  return out;
}

/** GET /getNBAInjuryList -> InjuryRecord[] */
export async function getInjuries() {
  const body = await tankFetch('/getNBAInjuryList');
  const list = Array.isArray(body) ? body : (body && typeof body === 'object' ? Object.values(body) : []);
  return list
    .filter((i) => i && (i.playerID || i.playerId))
    .map((i) => ({
      externalId: String(i.playerID ?? i.playerId),
      designation: i.designation || i.injStatus || null,
      description: i.description || i.injury || null,
    }));
}

// All 30 NBA team abbreviations (Tank01 uses these for getNBATeamSchedule).
const NBA_TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHO', 'POR', 'SAC', 'SA', 'TOR', 'UTA', 'WAS'];

/**
 * League-wide team schedules for a season. One call per team (bulk-ish, 30
 * calls max), heavily cached upstream and SHARED across users/leagues. Returns
 * { teamAbbr -> [{ gameDate:'YYYYMMDD', completed:boolean }] }.
 */
export async function getSchedule(season) {
  const yr = tankSeason(season);
  const out = {};
  const results = await Promise.all(NBA_TEAMS.map(async (team) => {
    try {
      const body = await tankFetch(`/getNBATeamSchedule?teamAbv=${team}&season=${yr}`);
      const games = Array.isArray(body?.schedule) ? body.schedule : [];
      return [team, games.map((g) => ({
        gameDate: g?.gameDate || null,
        completed: String(g?.gameStatus || '').toLowerCase() === 'completed' || g?.gameStatusCode === '3',
      })).filter((g) => g.gameDate)];
    } catch {
      return [team, null];
    }
  }));
  for (const [team, games] of results) if (games) out[team] = games;
  return out;
}

export const tank01Provider = {
  name: 'tank01',
  isConfigured,
  getPlayerIndex,
  getSeasonStats,
  getSeasonStatsForPlayer,
  getInjuries,
  getSchedule,
};

export default tank01Provider;
