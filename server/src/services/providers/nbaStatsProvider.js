/**
 * stats.nba.com provider (FALLBACK / local-dev).
 *
 * No API key required, but this is an UNDOCUMENTED endpoint that frequently
 * blocks datacenter IPs (so it may work locally yet fail on Render). It is used
 * only as a fallback per the orchestrator's health rules, and never hammered.
 *
 * It has no Yahoo cross-reference ids, so identity matching against it relies
 * on normalized name + team. It provides season per-game averages in one bulk
 * call (budget-friendly). It does not provide recent-form or injuries here.
 */
import { num, emptyStatLine } from './types.js';

const DEFAULT_TIMEOUT_MS = 8000;

// stats.nba.com requires these params present, most can be empty.
const LEAGUE_DASH_PARAMS = {
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '',
  DraftPick: '', DraftYear: '', GameScope: '', GameSegment: '', Height: '', LastNGames: '0',
  LeagueID: '00', Location: '', MeasureType: 'Base', Month: '0', OpponentTeamID: '0', Outcome: '',
  PORound: '0', PaceAdjust: 'N', PerMode: 'PerGame', Period: '0', PlayerExperience: '',
  PlayerPosition: '', PlusMinus: 'N', Rank: 'N', SeasonSegment: '', SeasonType: 'Regular Season',
  ShotClockRange: '', StarterBench: '', TeamID: '0', TwoWay: '0', VsConference: '', VsDivision: '',
};

export function isConfigured() {
  // No key needed; treated as always "configured" but gated by health + opt-in.
  return true;
}

/** Yahoo season "2025" -> stats.nba.com "2025-26". */
function nbaSeason(season) {
  const start = Number(season) || new Date().getFullYear();
  const end = String((start + 1) % 100).padStart(2, '0');
  return `${start}-${end}`;
}

async function nbaFetch(path, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`https://stats.nba.com/stats/${path}`, {
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

async function getSeasonStatsRaw(season) {
  const qs = new URLSearchParams({ ...LEAGUE_DASH_PARAMS, Season: nbaSeason(season) }).toString();
  const data = await nbaFetch(`leaguedashplayerstats?${qs}`);
  const rs = data?.resultSets?.[0];
  if (!rs?.headers || !rs?.rowSet) return [];
  const idx = (name) => rs.headers.indexOf(name);
  const iId = idx('PLAYER_ID');
  const iName = idx('PLAYER_NAME');
  const iTeam = idx('TEAM_ABBREVIATION');

  return rs.rowSet.map((row) => {
    const line = emptyStatLine();
    line.gamesPlayed = num(row[idx('GP')]);
    line.minutes = num(row[idx('MIN')]);
    line.points = num(row[idx('PTS')]);
    line.rebounds = num(row[idx('REB')]);
    line.offRebounds = num(row[idx('OREB')]);
    line.defRebounds = num(row[idx('DREB')]);
    line.assists = num(row[idx('AST')]);
    line.steals = num(row[idx('STL')]);
    line.blocks = num(row[idx('BLK')]);
    line.turnovers = num(row[idx('TOV')]);
    line.fgMade = num(row[idx('FGM')]);
    line.fgAtt = num(row[idx('FGA')]);
    line.ftMade = num(row[idx('FTM')]);
    line.ftAtt = num(row[idx('FTA')]);
    line.threesMade = num(row[idx('FG3M')]);
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
  // No injuries endpoint implemented here; orchestrator falls back to Yahoo status.
};

export default nbaStatsProvider;
