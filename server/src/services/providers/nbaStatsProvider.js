/**
 * stats.nba.com provider (FALLBACK / local-dev).
 *
 * No API key required, but this is an UNDOCUMENTED endpoint that frequently
 * blocks datacenter IPs (so it may work locally yet fail on Render). It is used
 * only as a fallback per the orchestrator's health rules, and never hammered.
 *
 * It has no Yahoo cross-reference ids, so identity matching against it relies
 * on normalized name + team. It provides season totals in one bulk call; the
 * mapper divides by games played. It does not provide recent form or injuries.
 */
import { num, emptyStatLine } from './types.js';
import { assertUrlAllowed, guardedFetch, sourceAllowed } from '../dataSources/policy.js';

const DEFAULT_TIMEOUT_MS = 8000;

// stats.nba.com requires these params present, most can be empty.
const LEAGUE_DASH_PARAMS = {
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: '0',
  LeagueID: '00', Location: '', MeasureType: 'Base', Month: '0', OpponentTeamID: '0', Outcome: '',
  PORound: '0', PaceAdjust: 'N', PerMode: 'Totals', Period: '0', PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', SeasonSegment: '', SeasonType: 'Regular Season',
  ShotClockRange: '', StarterBench: '', TeamID: '0', TwoWay: '0', VsConference: '', VsDivision: '',
};

export function isConfigured() {
  // No key needed, but NBA.com is default-deny (PROGM_DATA_NBA_COM=allow) and also gated by health + opt-in.
  return sourceAllowed('nba_com');
}

/** Yahoo season "2025" -> stats.nba.com "2025-26". */
export function nbaSeason(season) {
  const start = Number(season) || new Date().getFullYear();
  const end = String((start + 1) % 100).padStart(2, '0');
  return `${start}-${end}`;
}

async function nbaFetch(path, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  assertUrlAllowed('https://stats.nba.com/'); // NBA.com is default-deny (PROGM_DATA_NBA_COM)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await guardedFetch(`https://stats.nba.com/stats/${path}`, {
      headers: {
        // Browser-like headers are required or stats.nba.com returns 403.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Referer: 'https://www.nba.com/',
        Origin: 'https://www.nba.com',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`stats.nba.com HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** nba.com has no clean player-list-with-crossref; derive refs from the stats call. */
export async function getPlayerIndex(season) {
  const stats = await getSeasonStatsRaw(season);
  return stats.map((s) => ({ externalId: s.externalId, name: s.name, teamAbbr: s.teamAbbr, yahooId: null }));
}

export function mapLeagueDashPlayerStats(data) {
  const rs = data?.resultSets?.[0];
  if (!rs?.headers || !rs?.rowSet) return [];
  const idx = (name) => rs.headers.indexOf(name);
  const iId = idx('PLAYER_ID');
  const iName = idx('PLAYER_NAME');
  const iTeam = idx('TEAM_ABBREVIATION');

  return rs.rowSet.map((row) => {
    const line = emptyStatLine();
    const gamesPlayed = num(row[idx('GP')]);
    line.gamesPlayed = gamesPlayed;
    const perGame = (name) => {
      const total = num(row[idx(name)]);
      return total != null && gamesPlayed > 0 ? total / gamesPlayed : null;
    };
    line.minutes = perGame('MIN');
    line.points = perGame('PTS');
    line.rebounds = perGame('REB');
    line.offRebounds = perGame('OREB');
    line.defRebounds = perGame('DREB');
    line.assists = perGame('AST');
    line.steals = perGame('STL');
    line.blocks = perGame('BLK');
    line.turnovers = perGame('TOV');
    line.personalFouls = perGame('PF');
    line.fgMade = perGame('FGM');
    line.fgAtt = perGame('FGA');
    line.ftMade = perGame('FTM');
    line.ftAtt = perGame('FTA');
    line.threesMade = perGame('FG3M');
    return {
      externalId: String(row[iId]),
      name: row[iName],
      teamAbbr: row[iTeam],
      season: line,
      recent: null,
      recentGameCount: null,
    };
  });
}

async function getSeasonStatsRaw(season) {
  const qs = new URLSearchParams({ ...LEAGUE_DASH_PARAMS, Season: nbaSeason(season) }).toString();
  const data = await nbaFetch(`leaguedashplayerstats?${qs}`);
  return mapLeagueDashPlayerStats(data);
}

/** One official NBA bulk request; used to supplement ESPN's missing OREB/DREB. */
export async function getSeasonReboundSplits(season) {
  const all = await getSeasonStatsRaw(season);
  return all.map(({ externalId, name, teamAbbr, season: line }) => ({
    externalId,
    name,
    teamAbbr,
    gamesPlayed: line.gamesPlayed,
    offRebounds: line.offRebounds,
    defRebounds: line.defRebounds,
  }));
}

/** PlayerStats[] for the whole league (bulk). externalIds filter applied by caller if needed. */
export async function getSeasonStats(season, externalIds = null) {
  const all = await getSeasonStatsRaw(season);
  if (!externalIds) return all.map(({ name, teamAbbr, ...rest }) => rest);
  const wanted = new Set(externalIds.map(String));
  return all.filter((s) => wanted.has(s.externalId)).map(({ name, teamAbbr, ...rest }) => rest);
}

export const nbaStatsProvider = {
  name: 'nba_stats',
  isConfigured,
  getPlayerIndex,
  getSeasonStats,
  getSeasonReboundSplits,
  // No injuries endpoint implemented here; orchestrator falls back to Yahoo status.
};

export default nbaStatsProvider;
