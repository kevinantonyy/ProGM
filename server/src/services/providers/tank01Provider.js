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

export function isConfigured() {
  return Boolean(apiKey());
}

async function tankFetch(path, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const key = apiKey();
  if (!key) throw new Error('Tank01 not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`Tank01 HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    const json = await res.json();
    // Tank01 wraps payloads in { statusCode, body }.
    return json?.body ?? json;
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
  line.fgMade = num(stats.fgm);
  line.fgAtt = num(stats.fga);
  line.ftMade = num(stats.ftm);
  line.ftAtt = num(stats.fta);
  line.threesMade = num(stats.tptfgm ?? stats.fg3m);
  return line;
}

/**
 * Season averages for many players. Tank01's per-player season stats come from
 * getNBAPlayerInfo/getNBAGamesForPlayer, which are per-player calls. To respect
 * the API budget, the orchestrator only requests stats for the specific
 * externalIds it needs (roster + candidate pool), and caches per player.
 *
 * @param {string} season
 * @param {string[]} externalIds
 */
export async function getSeasonStats(season, externalIds = []) {
  const out = [];
  const yr = tankSeason(season);
  // Per-player game logs; aggregate to season + recent. Budget-bounded by caller.
  for (const externalId of externalIds) {
    try {
      const body = await tankFetch(`/getNBAGamesForPlayer?playerID=${encodeURIComponent(externalId)}&season=${yr}`);
      const games = body && typeof body === 'object' ? Object.values(body) : [];
      const valid = games.filter((g) => g && typeof g === 'object');
      if (!valid.length) continue;

      const agg = (list) => {
        const sum = emptyStatLine();
        const keys = ['minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade'];
        for (const k of keys) sum[k] = 0;
        let n = 0;
        for (const g of list) {
          const line = toStatLine(g);
          if (!line) continue;
          n += 1;
          for (const k of keys) sum[k] += line[k] || 0;
        }
        if (!n) return null;
        for (const k of keys) sum[k] = Number((sum[k] / n).toFixed(2));
        sum.gamesPlayed = n;
        return sum;
      };

      // Games are keyed by gameID which sorts chronologically (YYYYMMDD prefix).
      const chrono = valid
        .map((g) => ({ g, id: String(g.gameID || '') }))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((x) => x.g);

      const seasonAvg = agg(chrono);
      const recent = agg(chrono.slice(-10));

      out.push({ externalId: String(externalId), season: seasonAvg || emptyStatLine(), recent, recentGameCount: Math.min(10, chrono.length) });
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

export const tank01Provider = {
  name: 'tank01',
  isConfigured,
  getPlayerIndex,
  getSeasonStats,
  getInjuries,
};

export default tank01Provider;
