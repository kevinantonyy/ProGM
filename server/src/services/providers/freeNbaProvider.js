/**
 * Free NBA data provider (NBA CDN + ESPN public JSON) — PRIMARY external source.
 *
 * Wired as the primary provider in candidateProviders() (index.js); Tank01 is
 * the fallback. Implements the same provider-independent interface (types.js)
 * so downstream ProGM engines never know which source supplied the data.
 *
 * Sources (all free, structured JSON — no HTML scraping, no auth bypass):
 *   - Season stats + player directory: ESPN public "statistics/byathlete"
 *     (one request returns the whole league, per-game averages).
 *   - Schedule: official NBA CDN scheduleLeagueV2.json (one request, whole
 *     season). Requires browser-like Referer/Origin headers.
 *   - Recent form: NBA CDN live boxscore per completed gameId (one request per
 *     game, league-wide — not per player).
 *   - Injuries: ESPN public league-wide injuries (one request).
 *
 * The network functions are thin wrappers; the response→model MAPPERS are pure
 * and exported so they can be unit-tested with fixtures (no live network in
 * tests). Missing data is null, never fabricated.
 */
import { num, emptyStatLine } from './types.js';

const ESPN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ESPN_HEADERS = { 'User-Agent': ESPN_UA, Accept: 'application/json' };
// NBA CDN edge returns 403 without a browser-like Origin/Referer.
const NBA_CDN_HEADERS = { 'User-Agent': ESPN_UA, Accept: '*/*', Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' };
const DEFAULT_TIMEOUT_MS = 12000;
// How many of a team's most recent completed games to use for recent form.
const RECENT_GAMES_PER_TEAM = 10;

export function isConfigured() {
  return true; // no key required
}

// --- Request instrumentation (per-endpoint, for API-budget visibility) ------
let requestCount = 0;
const endpointCounts = { byathlete: 0, injuries: 0, schedule: 0, boxscore: 0, other: 0 };
let lastError = null; // { status:number|null, kind:string, at:string }

function classifyEndpoint(url) {
  if (url.includes('/statistics/byathlete')) return 'byathlete';
  if (url.includes('/injuries')) return 'injuries';
  if (url.includes('scheduleLeagueV2')) return 'schedule';
  if (url.includes('/boxscore/')) return 'boxscore';
  return 'other';
}
function classifyStatus(status) {
  if (status === 401) return 'invalid_key';
  if (status === 403) return 'forbidden_or_bot_block';
  if (status === 429) return 'rate_limited';
  if (status != null && status >= 500) return 'provider_error';
  if (status == null) return 'network_error';
  return 'http_error';
}
export function getRequestCount() { return requestCount; }
export function getRequestBreakdown() { return { ...endpointCounts, total: requestCount }; }
export function getLastError() { return lastError; }
export function resetRequestCount() {
  requestCount = 0;
  for (const k of Object.keys(endpointCounts)) endpointCounts[k] = 0;
  lastError = null;
}

async function jsonFetch(url, headers, timeout = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  requestCount += 1; // counts every actual outbound request (cache misses only)
  endpointCounts[classifyEndpoint(url)] += 1;
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      lastError = { status: res.status, kind: classifyStatus(res.status), at: new Date().toISOString() };
      const err = new Error(`free_nba HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    lastError = null;
    // NBA CDN serves JSON as text/plain; parse defensively either way.
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch (error) {
    if (error.httpStatus == null) lastError = { status: null, kind: 'network_error', at: new Date().toISOString() };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// --- ESPN byathlete: pure mapper -------------------------------------------

/**
 * Build a { statName -> value } map for one ESPN athlete entry by zipping each
 * category's `names[]` with its per-game `values[]`. Category label lists come
 * from the top-level `glossary`/`categories` payload keyed by category name.
 *
 * @param {Object} athleteEntry  one element of payload.athletes
 * @param {Object<string,string[]>} namesByCategory  category -> names[]
 * @returns {Object<string, number|null>}
 */
export function espnAthleteStatMap(athleteEntry, namesByCategory) {
  const out = {};
  for (const cat of athleteEntry?.categories || []) {
    const names = namesByCategory[cat.name] || [];
    const values = cat.values || [];
    for (let i = 0; i < names.length; i += 1) out[names[i]] = num(values[i]);
  }
  return out;
}

/** Map an ESPN per-game stat map to a provider-independent StatLine. */
export function espnStatMapToLine(m) {
  const line = emptyStatLine();
  line.gamesPlayed = m.gamesPlayed ?? null;
  line.minutes = m.avgMinutes ?? null;
  line.points = m.avgPoints ?? null;
  line.rebounds = m.avgRebounds ?? null;
  line.assists = m.avgAssists ?? null;
  line.steals = m.avgSteals ?? null;
  line.blocks = m.avgBlocks ?? null;
  line.turnovers = m.avgTurnovers ?? null;
  line.fgMade = m.avgFieldGoalsMade ?? null;
  line.fgAtt = m.avgFieldGoalsAttempted ?? null;
  line.ftMade = m.avgFreeThrowsMade ?? null;
  line.ftAtt = m.avgFreeThrowsAttempted ?? null;
  line.threesMade = m.avgThreePointFieldGoalsMade ?? null;
  return line;
}

/** Extract category -> names[] from an ESPN byathlete payload. */
export function espnNamesByCategory(payload) {
  const map = {};
  for (const cat of payload?.categories || []) map[cat.name] = cat.names || [];
  return map;
}

/**
 * Map a full ESPN byathlete payload to ProviderPlayerRef[] (directory) —
 * pure, testable.
 */
export function mapEspnDirectory(payload) {
  return (payload?.athletes || [])
    .map((a) => ({
      externalId: a.athlete?.id != null ? String(a.athlete.id) : null,
      name: a.athlete?.displayName || '',
      teamAbbr: a.athlete?.teamShortName || a.athlete?.team?.abbreviation || null,
      yahooId: null, // ESPN exposes no Yahoo cross-reference
    }))
    .filter((p) => p.externalId && p.name);
}

/**
 * Map a full ESPN byathlete payload to PlayerStats[] (season per-game) — pure.
 * ESPN provides season averages only here; recent is null (filled separately
 * from box scores). recentGameCount stays null.
 */
export function mapEspnSeasonStats(payload) {
  const namesByCat = espnNamesByCategory(payload);
  return (payload?.athletes || [])
    .map((a) => {
      const id = a.athlete?.id != null ? String(a.athlete.id) : null;
      if (!id) return null;
      const statMap = espnAthleteStatMap(a, namesByCat);
      return { externalId: id, season: espnStatMapToLine(statMap), recent: null, recentGameCount: null };
    })
    .filter(Boolean);
}

// --- NBA CDN schedule: pure mapper -----------------------------------------

/** 'YYYY-MM-DDT...' or ISO -> 'YYYYMMDD' string, or null. */
export function toYmd(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Map NBA CDN scheduleLeagueV2 payload to { teamAbbr -> [{gameDate, completed}] }.
 * gameStatus: 1=scheduled, 2=live, 3=final(completed). Each game is attributed
 * to BOTH the home and away team so per-team windows can be counted.
 */
export function mapNbaSchedule(payload) {
  const out = {};
  const days = payload?.leagueSchedule?.gameDates || [];
  const push = (abbr, game) => {
    if (!abbr) return;
    if (!out[abbr]) out[abbr] = [];
    out[abbr].push(game);
  };
  for (const day of days) {
    for (const g of day.games || []) {
      const gameDate = toYmd(g.gameDateEst || g.gameDate);
      if (!gameDate) continue;
      const completed = g.gameStatus === 3;
      push(g.homeTeam?.teamTricode, { gameDate, completed });
      push(g.awayTeam?.teamTricode, { gameDate, completed });
    }
  }
  return out;
}

// --- NBA CDN boxscore: pure mapper (recent form building block) -------------

/**
 * Parse an ISO-8601 duration like "PT34M12.00S" (or "PT34M", "PT0M00.00S") into
 * decimal minutes. Returns null for empty/unparseable values (never 0 unless
 * the value genuinely parses to zero minutes). Also tolerates a plain number
 * or "MM:SS" string just in case a source varies.
 */
export function parseIsoMinutes(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  // ISO-8601 duration: PT#M#S (minutes and/or seconds, decimals allowed).
  const iso = /^PT(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso) {
    const mins = iso[1] != null ? parseFloat(iso[1]) : 0;
    const secs = iso[2] != null ? parseFloat(iso[2]) : 0;
    if (iso[1] == null && iso[2] == null) return null;
    return Number((mins + secs / 60).toFixed(2));
  }
  // "MM:SS" fallback.
  const colon = /^(\d+):(\d{1,2})$/.exec(s);
  if (colon) return Number((parseInt(colon[1], 10) + parseInt(colon[2], 10) / 60).toFixed(2));
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Map one NBA CDN player boxscore statistics object to a single-game StatLine. */
export function mapBoxscorePlayerLine(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const line = emptyStatLine();
  line.gamesPlayed = 1;
  line.minutes = parseIsoMinutes(stats.minutes ?? stats.minutesCalculated); // "PT34M12.00S" -> 34.2
  line.points = num(stats.points);
  line.rebounds = num(stats.reboundsTotal);
  line.offRebounds = num(stats.reboundsOffensive);
  line.defRebounds = num(stats.reboundsDefensive);
  line.assists = num(stats.assists);
  line.steals = num(stats.steals);
  line.blocks = num(stats.blocks);
  line.turnovers = num(stats.turnovers);
  line.fgMade = num(stats.fieldGoalsMade);
  line.fgAtt = num(stats.fieldGoalsAttempted);
  line.ftMade = num(stats.freeThrowsMade);
  line.ftAtt = num(stats.freeThrowsAttempted);
  line.threesMade = num(stats.threePointersMade);
  return line;
}

/** Extract [{ externalId, line }] for every player in an NBA CDN boxscore. */
export function mapBoxscore(payload) {
  const out = [];
  for (const side of [payload?.game?.homeTeam, payload?.game?.awayTeam]) {
    for (const p of side?.players || []) {
      const id = p.personId != null ? String(p.personId) : null;
      const line = mapBoxscorePlayerLine(p.statistics);
      if (id && line) out.push({ externalId: id, line });
    }
  }
  return out;
}

// --- ESPN injuries: pure mapper --------------------------------------------

/** Map ESPN league-wide injuries payload to InjuryRecord[] (flatten teams). */
export function mapEspnInjuries(payload) {
  const out = [];
  for (const team of payload?.injuries || []) {
    for (const inj of team.injuries || []) {
      const athlete = inj.athlete || {};
      const id = athlete.id != null ? String(athlete.id) : null;
      if (!id) continue;
      out.push({
        externalId: id,
        designation: inj.status || inj.type?.description || null,
        description: inj.shortComment || inj.longComment || null,
      });
    }
  }
  return out;
}

// --- Recent-form aggregation: pure --------------------------------------------

const RECENT_KEYS = ['minutes', 'points', 'rebounds', 'offRebounds', 'defRebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade'];

/**
 * Average a list of single-game StatLines into one recent per-game StatLine.
 * Only stats present in a game contribute; a stat missing in every game stays
 * null (never fabricated to 0). Returns { line, gameCount } or null if empty.
 */
export function aggregateRecentLines(lines) {
  const valid = (lines || []).filter(Boolean);
  if (!valid.length) return null;
  const out = emptyStatLine();
  for (const key of RECENT_KEYS) {
    let sum = 0; let n = 0;
    for (const g of valid) { if (g[key] != null) { sum += g[key]; n += 1; } }
    out[key] = n ? Number((sum / n).toFixed(2)) : null;
  }
  out.gamesPlayed = valid.length;
  return { line: out, gameCount: valid.length };
}

/**
 * From a mapped schedule ({teamAbbr -> [{gameDate, completed, gameId}]}) pick
 * the most recent completed game ids, newest first, de-duplicated. Requires the
 * schedule to carry gameId (see mapNbaScheduleWithIds).
 */
export function recentCompletedGameIds(scheduleWithIds, perTeam = RECENT_GAMES_PER_TEAM) {
  const ids = new Set();
  for (const games of Object.values(scheduleWithIds || {})) {
    const completed = (games || [])
      .filter((g) => g.completed && g.gameId)
      .sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)))
      .slice(0, perTeam);
    for (const g of completed) ids.add(g.gameId);
  }
  return [...ids];
}

/**
 * Schedule mapper variant that also keeps gameId (needed to fetch box scores).
 * Shape: { teamAbbr -> [{ gameId, gameDate, completed }] }.
 */
export function mapNbaScheduleWithIds(payload) {
  const out = {};
  const days = payload?.leagueSchedule?.gameDates || [];
  const push = (abbr, game) => { if (!abbr) return; (out[abbr] ||= []).push(game); };
  for (const day of days) {
    for (const g of day.games || []) {
      const gameDate = toYmd(g.gameDateEst || g.gameDate);
      if (!gameDate) continue;
      const game = { gameId: g.gameId || null, gameDate, completed: g.gameStatus === 3 };
      push(g.homeTeam?.teamTricode, game);
      push(g.awayTeam?.teamTricode, game);
    }
  }
  return out;
}

// --- Network methods (thin; used only when explicitly invoked) --------------

const BYATHLETE_URL = (yr) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1000&season=${yr}&seasontype=2`;

export async function getPlayerIndex(season) {
  const yr = Number(season) || new Date().getFullYear();
  const payload = await jsonFetch(BYATHLETE_URL(yr), ESPN_HEADERS);
  return mapEspnDirectory(payload);
}

/**
 * League-wide season stats in ONE request (bulk). The orchestrator caches this
 * whole array once per season and filters per player, so N players cost ONE
 * ESPN request — not N. This is the method index.js should prefer.
 */
export async function getSeasonStatsBulk(season) {
  const yr = Number(season) || new Date().getFullYear();
  const payload = await jsonFetch(BYATHLETE_URL(yr), ESPN_HEADERS);
  return mapEspnSeasonStats(payload);
}

/**
 * Back-compat batch method. Fetches the league-wide dataset once and filters.
 * (Still one request regardless of how many ids are requested.)
 */
export async function getSeasonStats(season, externalIds = null) {
  const all = await getSeasonStatsBulk(season);
  if (!externalIds) return all;
  const wanted = new Set(externalIds.map(String));
  return all.filter((s) => wanted.has(s.externalId));
}

export async function getSchedule(season) {
  const payload = await jsonFetch('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', NBA_CDN_HEADERS);
  return mapNbaSchedule(payload);
}

/** Schedule variant that retains gameId (for recent-form box-score selection). */
export async function getScheduleWithIds(season) {
  const payload = await jsonFetch('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', NBA_CDN_HEADERS);
  return mapNbaScheduleWithIds(payload);
}

export async function getInjuries() {
  const payload = await jsonFetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', ESPN_HEADERS);
  return mapEspnInjuries(payload);
}

/** Fetch + map one completed game's box score (recent-form building block). */
export async function getBoxscore(gameId) {
  const payload = await jsonFetch(`https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`, NBA_CDN_HEADERS);
  return mapBoxscore(payload);
}

/**
 * Recent-form map keyed by externalId (NBA personId), built from box scores of
 * recently completed games. ONE request per completed game, shared across every
 * player in that game — never one request per player.
 *
 * @param {string|number} season
 * @param {(gameId:string)=>Promise<Array<{externalId,line}>>} [fetchBox]  override for caching/tests
 * @returns {Promise<Map<string,{recent:StatLine, recentGameCount:number}>>}
 */
export async function getRecentForm(season, { fetchBox = getBoxscore, perTeam = RECENT_GAMES_PER_TEAM, scheduleWithIds = null } = {}) {
  // Reuse a caller-supplied schedule (already cached) to avoid a duplicate
  // schedule request; only fetch it ourselves when not provided.
  let sched = scheduleWithIds;
  if (!sched) {
    const payload = await jsonFetch('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', NBA_CDN_HEADERS);
    sched = mapNbaScheduleWithIds(payload);
  }
  const gameIds = recentCompletedGameIds(sched, perTeam);
  const linesByPlayer = new Map(); // externalId -> StatLine[]
  for (const gid of gameIds) {
    let rows = [];
    try { rows = await fetchBox(gid); } catch { rows = []; }
    for (const { externalId, line } of rows || []) {
      if (!linesByPlayer.has(externalId)) linesByPlayer.set(externalId, []);
      linesByPlayer.get(externalId).push(line);
    }
  }
  const out = new Map();
  for (const [externalId, lines] of linesByPlayer) {
    const agg = aggregateRecentLines(lines);
    if (agg) out.set(externalId, { recent: agg.line, recentGameCount: agg.gameCount });
  }
  return out;
}

export const freeNbaProvider = {
  name: 'free_nba',
  isConfigured,
  getPlayerIndex,
  getSeasonStats,
  getSeasonStatsBulk,
  getInjuries,
  getSchedule,
  getScheduleWithIds,
  getRecentForm,
  getBoxscore,
};

export default freeNbaProvider;
