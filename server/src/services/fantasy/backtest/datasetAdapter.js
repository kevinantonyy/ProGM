import { importHistoricalDataset } from './importer.js';

const CORE_ALIASES = Object.freeze({
  season: ['season', 'season_start_year'],
  statSeason: ['statSeason', 'stat_season'],
  playerId: ['playerId', 'player_id', 'externalId', 'external_id'],
  name: ['name', 'player_name'],
  teamAbbr: ['teamAbbr', 'team_abbr', 'team'],
  position: ['position', 'pos'],
  age: ['age'],
  experience: ['experience', 'years_experience'],
  gamesPlayed: ['gamesPlayed', 'games_played', 'gp'],
  minutesPerGame: ['minutesPerGame', 'minutes_per_game', 'mpg', 'min'],
  minutesTotal: ['minutesTotal', 'minutes_total'],
});

const STAT_ALIASES = Object.freeze({
  points: ['points', 'pts'], rebounds: ['rebounds', 'reb'],
  offRebounds: ['offRebounds', 'off_rebounds', 'oreb'],
  defRebounds: ['defRebounds', 'def_rebounds', 'dreb'],
  assists: ['assists', 'ast'], steals: ['steals', 'stl'], blocks: ['blocks', 'blk'],
  turnovers: ['turnovers', 'tov', 'turnover'], personalFouls: ['personalFouls', 'personal_fouls', 'pf'],
  fgMade: ['fgMade', 'fg_made', 'fgm'], fgAtt: ['fgAtt', 'fg_att', 'fga'],
  ftMade: ['ftMade', 'ft_made', 'ftm'], ftAtt: ['ftAtt', 'ft_att', 'fta'],
  threesMade: ['threesMade', 'threes_made', 'fg3m'],
  doubleDoubles: ['doubleDoubles', 'double_doubles', 'dd', 'dd2'],
  tripleDoubles: ['tripleDoubles', 'triple_doubles', 'td', 'td3'],
});

function valueFor(row, canonical, aliases, fieldMap) {
  const mapped = fieldMap?.[canonical];
  const candidates = mapped ? [mapped] : aliases;
  for (const key of candidates) {
    if (Object.hasOwn(row, key)) return row[key] === '' ? null : row[key];
  }
  return null;
}

/** Parse ordinary RFC-4180-style CSV without adding a runtime dependency. */
export function parseHistoricalCsv(text) {
  if (typeof text !== 'string') throw new Error('CSV import requires text content.');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error('CSV import contains an unterminated quoted field.');
  row.push(field);
  if (row.some((item) => item !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((item, index) => (index === 0 ? item.replace(/^\uFEFF/, '') : item).trim());
  if (new Set(headers).size !== headers.length || headers.some((item) => !item)) throw new Error('CSV headers must be non-empty and unique.');
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export function normalizeTabularHistoricalRows(rows, fieldMap = {}) {
  if (!Array.isArray(rows)) throw new Error('Tabular historical export must contain an array of rows.');
  return rows.map((row) => ({
    season: valueFor(row, 'season', CORE_ALIASES.season, fieldMap),
    statSeason: valueFor(row, 'statSeason', CORE_ALIASES.statSeason, fieldMap),
    playerId: valueFor(row, 'playerId', CORE_ALIASES.playerId, fieldMap),
    name: valueFor(row, 'name', CORE_ALIASES.name, fieldMap),
    teamAbbr: valueFor(row, 'teamAbbr', CORE_ALIASES.teamAbbr, fieldMap),
    position: valueFor(row, 'position', CORE_ALIASES.position, fieldMap),
    age: valueFor(row, 'age', CORE_ALIASES.age, fieldMap),
    experience: valueFor(row, 'experience', CORE_ALIASES.experience, fieldMap),
    gamesPlayed: valueFor(row, 'gamesPlayed', CORE_ALIASES.gamesPlayed, fieldMap),
    minutesPerGame: valueFor(row, 'minutesPerGame', CORE_ALIASES.minutesPerGame, fieldMap),
    minutesTotal: valueFor(row, 'minutesTotal', CORE_ALIASES.minutesTotal, fieldMap),
    stats: Object.fromEntries(Object.entries(STAT_ALIASES).map(([key, aliases]) => [key, valueFor(row, key, aliases, fieldMap)])),
  }));
}

function minutesValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parts = String(value).split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.length === 2 ? parts[0] + (parts[1] / 60) : parts[0];
}

function finiteProviderNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flattenBalldontliePages(input) {
  if (Array.isArray(input)) return input.flatMap((item) => Array.isArray(item?.data) ? item.data : item);
  if (Array.isArray(input?.pages)) return input.pages.flatMap((page) => page?.data || []);
  return input?.data || [];
}

/**
 * Aggregate authorized BALLDONTLIE /v1/stats exports into player seasons.
 * The adapter performs no API calls and accepts only regular-season full-game rows.
 */
export function normalizeBalldontlieGameStats(input) {
  const records = flattenBalldontliePages(input);
  if (!Array.isArray(records)) throw new Error('BALLDONTLIE export must contain data or pages[].data arrays.');
  const groups = new Map();
  const statMap = {
    points: 'pts', rebounds: 'reb', offRebounds: 'oreb', defRebounds: 'dreb', assists: 'ast',
    steals: 'stl', blocks: 'blk', turnovers: 'turnover', personalFouls: 'pf', fgMade: 'fgm',
    fgAtt: 'fga', ftMade: 'ftm', ftAtt: 'fta', threesMade: 'fg3m',
  };
  for (const record of records) {
    const game = record?.game || {};
    if (game.postseason === true || game.season_type && game.season_type !== 'regular') continue;
    const season = Number(game.season ?? record.season);
    const playerId = record?.player?.id ?? record.player_id;
    const gameId = game.id ?? record.game_id;
    if (!Number.isInteger(season) || playerId == null || gameId == null) throw new Error('BALLDONTLIE rows require game season/id and player id.');
    const key = `${playerId}|${season}`;
    const group = groups.get(key) || { season, playerId, records: new Map() };
    if (group.records.has(String(gameId))) throw new Error(`Duplicate BALLDONTLIE player/game row: ${playerId}/${gameId}.`);
    group.records.set(String(gameId), record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const games = [...group.records.values()];
    const latest = games.reduce((chosen, item) => String(item?.game?.date || '') > String(chosen?.game?.date || '') ? item : chosen, games[0]);
    const stats = {};
    for (const [canonical, providerKey] of Object.entries(statMap)) {
      const values = games.map((game) => finiteProviderNumber(game[providerKey]));
      stats[canonical] = values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / games.length : null;
    }
    const minutes = games.map((game) => minutesValue(game.min));
    const doubleTriple = games.map((game) => ['pts', 'reb', 'ast', 'stl', 'blk'].map((key) => finiteProviderNumber(game[key])));
    const achievementsComplete = doubleTriple.every((values) => values.every(Number.isFinite));
    stats.doubleDoubles = achievementsComplete ? doubleTriple.filter((values) => values.filter((value) => value >= 10).length >= 2).length / games.length : null;
    stats.tripleDoubles = achievementsComplete ? doubleTriple.filter((values) => values.filter((value) => value >= 10).length >= 3).length / games.length : null;
    return {
      season: group.season,
      statSeason: group.season,
      playerId: `balldontlie:${group.playerId}`,
      name: [latest?.player?.first_name, latest?.player?.last_name].filter(Boolean).join(' '),
      teamAbbr: latest?.team?.abbreviation ?? null,
      position: latest?.player?.position ?? null,
      age: null,
      experience: null,
      gamesPlayed: games.length,
      minutesPerGame: minutes.every(Number.isFinite) ? minutes.reduce((sum, value) => sum + value, 0) / games.length : null,
      minutesTotal: minutes.every(Number.isFinite) ? minutes.reduce((sum, value) => sum + value, 0) : null,
      stats,
    };
  });
}

export function importHistoricalExport({ input, format = 'json', provenance, fieldMap = {} }) {
  let rows;
  let sourceRows;
  if (format === 'csv') {
    sourceRows = parseHistoricalCsv(input);
    rows = normalizeTabularHistoricalRows(sourceRows, fieldMap);
  } else if (format === 'tabular-json') {
    sourceRows = input?.rows || input;
    rows = normalizeTabularHistoricalRows(sourceRows, fieldMap);
  } else if (format === 'balldontlie-stats') rows = normalizeBalldontlieGameStats(input);
  else if (format === 'json') rows = input?.snapshots || input?.rows || input;
  else throw new Error(`Unsupported historical import format: ${format}.`);
  return importHistoricalDataset({ rows, sourceRows: sourceRows || rows, provenance: provenance || input?.provenance });
}
