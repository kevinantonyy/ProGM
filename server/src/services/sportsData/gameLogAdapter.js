import { parseHistoricalCsv } from '../fantasy/backtest/datasetAdapter.js';

/**
 * Converts a player game-log export (rows already parsed from CSV or JSON) into
 * per-season Phase 9 ingestion batches. It performs no network access and
 * decides nothing about permissions: batches are only stored by `ingestBatch`
 * for a registered source whose documented rights allow it.
 *
 * The caller must state how the file labels seasons (`seasonLabel`): NBA tables
 * often use the END year (2026 = 2025-26) while ProGM uses the START year. The
 * label is verified against game dates so a wrong choice fails loudly.
 */
const ALIASES = Object.freeze({
  gameId: ['game_id', 'gameId'],
  gameDate: ['game_date', 'gameDate', 'date'],
  season: ['season'],
  gameType: ['game_type', 'gameType', 'season_type', 'seasonType'],
  playerId: ['player_id', 'playerId'],
  playerName: ['player_name', 'playerName', 'name'],
  teamId: ['team_id', 'teamId'],
  teamAbbr: ['team_abbreviation', 'team_abbrev', 'nba_abbrev', 'teamAbbr'],
  home: ['home'],
  minutes: ['min', 'minutes'],
  points: ['pts', 'points'],
  rebounds: ['reb', 'rebounds'],
  offRebounds: ['oreb', 'offRebounds'],
  defRebounds: ['dreb', 'defRebounds'],
  assists: ['ast', 'assists'],
  steals: ['stl', 'steals'],
  blocks: ['blk', 'blocks'],
  turnovers: ['tov', 'turnovers', 'turnover'],
  personalFouls: ['pf', 'personalFouls'],
  fgMade: ['fgm', 'fgMade'],
  fgAtt: ['fga', 'fgAtt'],
  ftMade: ['ftm', 'ftMade'],
  ftAtt: ['fta', 'ftAtt'],
  threesMade: ['fg3m', 'threesMade'],
  threesAtt: ['fg3a', 'threesAtt'],
});
const STAT_FIELDS = Object.keys(ALIASES).filter((key) => !['gameId', 'gameDate', 'season', 'gameType', 'playerId', 'playerName', 'teamId', 'teamAbbr', 'home'].includes(key));
const REGULAR = new Set(['regular', 'regular_season', 'regular season']);

function pick(row, field, fieldMap) {
  const candidates = fieldMap?.[field] ? [fieldMap[field]] : ALIASES[field];
  for (const key of candidates) if (Object.hasOwn(row, key) && row[key] !== '' && row[key] != null) return row[key];
  return null;
}

function minutesOf(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const clock = text.match(/^(\d+):(\d{2})$/);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrNull(value, label) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not numeric: ${value}.`);
  return parsed;
}

function gameTypeOf(row, fieldMap) {
  const explicit = pick(row, 'gameType', fieldMap);
  if (explicit != null) return REGULAR.has(String(explicit).toLowerCase()) ? 'regular' : 'other';
  // NBA game ids: 002 = regular season, 001 preseason, 003 all-star, 004 playoffs, 005 play-in.
  const gameId = String(pick(row, 'gameId', fieldMap) ?? '');
  if (/^\d{10}$/.test(gameId)) return gameId.startsWith('002') ? 'regular' : 'other';
  throw new Error(`Cannot tell the game type of ${gameId || 'a row without game id'}: provide a game type column or NBA-style game ids.`);
}

function startYearOf(label, seasonLabel, gameDate, gameId) {
  const season = Number(label) - (seasonLabel === 'end' ? 1 : 0);
  const from = Date.parse(`${season}-08-01`);
  const to = Date.parse(`${season + 1}-10-31`);
  const time = Date.parse(gameDate);
  if (Number.isNaN(time) || time < from || time > to) {
    throw new Error(`Game ${gameId} dated ${gameDate} does not fall in season ${season}-${String(season + 1).slice(2)}; check seasonLabel ("${seasonLabel}").`);
  }
  return season;
}

export function parseGameLogCsv(text) {
  return parseHistoricalCsv(text);
}

/**
 * @param {object[]} rows
 * @param {{sourceKey:string, seasonLabel:'end'|'start', fieldMap?:object, seasons?:number[]}} options
 * @returns {{batches:object[], diagnostics:object}} one batch per season (start year), oldest first
 */
export function adaptGameLogs(rows, { sourceKey, seasonLabel, fieldMap = {}, seasons = null }) {
  if (!Array.isArray(rows)) throw new Error('Game log rows must be an array.');
  if (!sourceKey) throw new Error('sourceKey is required.');
  if (!['end', 'start'].includes(seasonLabel)) throw new Error('seasonLabel must be "end" or "start": say how the file labels seasons.');
  const wanted = seasons ? new Set(seasons.map(Number)) : null;
  const diagnostics = { sourceRows: rows.length, nonRegularSeasonSkipped: 0, noPlayerNameSkipped: 0, incompleteGamesSkipped: 0, outsideRequestedSeasons: 0, duplicateRowsCollapsed: 0 };

  const bySeason = new Map();
  for (const row of rows) {
    if (gameTypeOf(row, fieldMap) !== 'regular') { diagnostics.nonRegularSeasonSkipped += 1; continue; }
    const gameId = String(pick(row, 'gameId', fieldMap) ?? '').trim();
    const playerId = String(pick(row, 'playerId', fieldMap) ?? '').trim();
    const teamId = String(pick(row, 'teamId', fieldMap) ?? '').trim();
    const gameDate = String(pick(row, 'gameDate', fieldMap) ?? '').slice(0, 10);
    if (!gameId || !playerId || !teamId || !gameDate) throw new Error(`Row is missing gameId/playerId/teamId/gameDate (game ${gameId || '?'}, player ${playerId || '?'}).`);
    const seasonRaw = pick(row, 'season', fieldMap);
    if (seasonRaw == null) throw new Error(`Row for game ${gameId} has no season.`);
    const season = startYearOf(seasonRaw, seasonLabel, gameDate, gameId);
    if (wanted && !wanted.has(season)) { diagnostics.outsideRequestedSeasons += 1; continue; }
    const name = pick(row, 'playerName', fieldMap);
    if (name == null || !String(name).trim()) { diagnostics.noPlayerNameSkipped += 1; continue; }
    const stats = {};
    for (const field of STAT_FIELDS) {
      stats[field] = field === 'minutes' ? minutesOf(pick(row, field, fieldMap)) : numberOrNull(pick(row, field, fieldMap), `${field} (game ${gameId}, player ${playerId})`);
    }
    // Arithmetic, not estimation: total rebounds = offensive + defensive.
    if (stats.rebounds == null && stats.offRebounds != null && stats.defRebounds != null) stats.rebounds = stats.offRebounds + stats.defRebounds;
    const entry = bySeason.get(season) || { games: new Map(), logs: new Map(), players: new Map(), teams: new Map() };
    const key = `${gameId}:${playerId}`;
    const previous = entry.logs.get(key);
    const candidate = { gameId, playerId, teamId, stats, home: pick(row, 'home', fieldMap) };
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(candidate)) throw new Error(`Conflicting duplicate game-log rows for ${key}.`);
      diagnostics.duplicateRowsCollapsed += 1;
      continue;
    }
    entry.logs.set(key, candidate);
    entry.players.set(playerId, String(name).trim());
    const abbr = pick(row, 'teamAbbr', fieldMap);
    if (!entry.teams.has(teamId) || (abbr && !entry.teams.get(teamId))) entry.teams.set(teamId, abbr ? String(abbr).trim() : null);
    const game = entry.games.get(gameId) || { gameId, gameDate, season, teams: new Map() };
    if (game.gameDate !== gameDate) throw new Error(`Game ${gameId} has conflicting dates: ${game.gameDate} and ${gameDate}.`);
    game.teams.set(teamId, candidate.home);
    entry.games.set(gameId, game);
    bySeason.set(season, entry);
  }

  const batches = [];
  for (const season of [...bySeason.keys()].sort((a, b) => a - b)) {
    const entry = bySeason.get(season);
    const games = [];
    const validGames = new Set();
    for (const game of [...entry.games.values()].sort((a, b) => (a.gameId < b.gameId ? -1 : 1))) {
      const teamIds = [...game.teams.keys()].sort();
      if (teamIds.length !== 2) { diagnostics.incompleteGamesSkipped += 1; continue; }
      const homeFlags = teamIds.map((id) => String(game.teams.get(id)).toLowerCase());
      const isHome = (flag) => ['true', '1', 'home'].includes(flag);
      const homeTeamId = isHome(homeFlags[0]) && !isHome(homeFlags[1]) ? teamIds[0] : isHome(homeFlags[1]) && !isHome(homeFlags[0]) ? teamIds[1] : teamIds[0];
      validGames.add(game.gameId);
      games.push({ externalId: game.gameId, season, seasonType: 'regular', gameDate: game.gameDate, homeTeamId, awayTeamId: teamIds.find((id) => id !== homeTeamId) });
    }
    const playerGameStats = [];
    const usedPlayers = new Set();
    const usedTeams = new Set();
    for (const log of [...entry.logs.values()].sort((a, b) => (`${a.gameId}:${a.playerId}` < `${b.gameId}:${b.playerId}` ? -1 : 1))) {
      if (!validGames.has(log.gameId)) continue;
      playerGameStats.push({ gameId: log.gameId, playerId: log.playerId, teamId: log.teamId, stats: log.stats });
      usedPlayers.add(log.playerId);
      usedTeams.add(log.teamId);
    }
    batches.push({
      sourceKey,
      sport: 'basketball',
      season,
      teams: [...usedTeams].sort().map((id) => ({ externalId: id, abbreviation: entry.teams.get(id) || null, name: entry.teams.get(id) || `Team ${id}` })),
      players: [...usedPlayers].sort().map((id) => ({ externalId: id, fullName: entry.players.get(id) })),
      games,
      playerGameStats,
    });
  }
  return { batches, diagnostics };
}
