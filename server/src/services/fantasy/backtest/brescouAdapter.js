import { parseHistoricalCsv } from './datasetAdapter.js';
import { importHistoricalDataset } from './importer.js';

const REQUIRED_INDEX_FIELDS = Object.freeze(['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'POSITION', 'FROM_YEAR']);
const REQUIRED_STATS_FIELDS = Object.freeze([
  'PLAYER_ID', 'PLAYER_NAME', 'TEAM_ID', 'TEAM_ABBREVIATION', 'AGE', 'GP', 'MIN',
  'FGM', 'FGA', 'FG3M', 'FTM', 'FTA', 'OREB', 'DREB', 'REB', 'AST', 'TOV',
  'STL', 'BLK', 'PF', 'PTS', 'DD2', 'TD3', 'SEASON',
]);

const PER_GAME_STATS = Object.freeze({
  points: 'PTS', rebounds: 'REB', offRebounds: 'OREB', defRebounds: 'DREB',
  assists: 'AST', steals: 'STL', blocks: 'BLK', turnovers: 'TOV',
  personalFouls: 'PF', fgMade: 'FGM', fgAtt: 'FGA', ftMade: 'FTM',
  ftAtt: 'FTA', threesMade: 'FG3M',
});

function parseBrescouCsv(text) {
  const withoutBom = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
  // player_index.csv has an unnamed pandas index column. Give it a harmless name
  // so the shared strict CSV parser can still validate the remaining headers.
  return parseHistoricalCsv(withoutBom?.startsWith(',') ? `_ROW_INDEX${withoutBom}` : withoutBom);
}

function requireHeaders(rows, required, label) {
  if (!rows.length) throw new Error(`Brescou ${label} CSV is empty.`);
  const headers = new Set(Object.keys(rows[0]));
  const missing = required.filter((field) => !headers.has(field));
  if (missing.length) throw new Error(`Brescou ${label} CSV is missing columns: ${missing.join(', ')}.`);
}

function numberOrNull(value, field, identity) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Brescou ${field} for ${identity}: ${value}.`);
  return parsed;
}

export function parseBrescouSeason(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2}|\d{4})$/);
  if (!match) throw new Error(`Invalid Brescou season identifier: ${value ?? 'missing'}.`);
  const start = Number(match[1]);
  const end = Number(match[2].length === 2 ? `${String(start + 1).slice(0, 2)}${match[2]}` : match[2]);
  if (end !== start + 1) throw new Error(`Misaligned Brescou season identifier: ${value}.`);
  return start;
}

function buildPlayerIndex(rows) {
  const players = new Map();
  for (const row of rows) {
    const id = String(row.PERSON_ID ?? '').trim();
    if (!id) throw new Error('Brescou player_index row is missing PERSON_ID.');
    if (players.has(id)) throw new Error(`Duplicate Brescou player index identity: ${id}.`);
    const name = [row.PLAYER_FIRST_NAME, row.PLAYER_LAST_NAME].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
    players.set(id, {
      name: name || null,
      position: String(row.POSITION ?? '').trim() || null,
      debutYear: numberOrNull(row.FROM_YEAR, 'FROM_YEAR', id),
    });
  }
  return players;
}

function mapStatsRow(row, players) {
  const providerId = String(row.PLAYER_ID ?? '').trim();
  const season = parseBrescouSeason(row.SEASON);
  const identity = `${providerId || 'missing'}/${row.SEASON}`;
  if (!providerId) throw new Error(`Brescou stats row is missing PLAYER_ID for ${row.SEASON}.`);
  const player = players.get(providerId);
  if (!player) throw new Error(`Brescou player ${providerId}/${season} is missing from player_index.csv.`);
  const gamesPlayed = numberOrNull(row.GP, 'GP', identity);
  const minutesPerGame = numberOrNull(row.MIN, 'MIN', identity);
  const stats = Object.fromEntries(Object.entries(PER_GAME_STATS).map(([key, field]) => [
    key, numberOrNull(row[field], field, identity),
  ]));
  for (const [key, field] of [['doubleDoubles', 'DD2'], ['tripleDoubles', 'TD3']]) {
    const total = numberOrNull(row[field], field, identity);
    stats[key] = total == null || gamesPlayed == null || gamesPlayed <= 0 ? null : total / gamesPlayed;
  }
  if ([stats.rebounds, stats.offRebounds, stats.defRebounds].every(Number.isFinite)
      && Math.abs(stats.rebounds - stats.offRebounds - stats.defRebounds) > 0.21) {
    throw new Error(`Inconsistent Brescou rebound split for ${identity}.`);
  }
  const sourceName = String(row.PLAYER_NAME ?? '').trim();
  const debutYear = player.debutYear;
  return {
    season,
    statSeason: season,
    playerId: `brescou:${providerId}`,
    name: sourceName || player.name,
    teamId: String(row.TEAM_ID ?? '').trim() || null,
    teamAbbr: String(row.TEAM_ABBREVIATION ?? '').trim() || null,
    position: player.position,
    age: numberOrNull(row.AGE, 'AGE', identity),
    experience: debutYear == null ? null : Math.max(0, season - debutYear),
    gamesPlayed,
    minutesPerGame,
    minutesTotal: gamesPlayed == null || minutesPerGame == null ? null : gamesPlayed * minutesPerGame,
    stats,
    sourceTotals: {
      doubleDoubles: numberOrNull(row.DD2, 'DD2', identity),
      tripleDoubles: numberOrNull(row.TD3, 'TD3', identity),
    },
  };
}

function aggregateTeamRows(rows) {
  const identity = `${rows[0].playerId}/${rows[0].season}`;
  const teamKeys = new Set();
  for (const row of rows) {
    const teamKey = row.teamId || row.teamAbbr;
    if (!teamKey || teamKeys.has(teamKey)) throw new Error(`Duplicate Brescou player-season-team row: ${identity}/${teamKey || 'missing'}.`);
    teamKeys.add(teamKey);
  }
  const games = rows.map((row) => row.gamesPlayed);
  const totalGames = games.every(Number.isFinite) ? games.reduce((sum, value) => sum + value, 0) : null;
  const weighted = (getter) => {
    const values = rows.map(getter);
    if (totalGames == null || totalGames <= 0 || !values.every(Number.isFinite)) return null;
    return values.reduce((sum, value, index) => sum + value * games[index], 0) / totalGames;
  };
  const stats = {};
  for (const key of Object.keys(PER_GAME_STATS)) stats[key] = weighted((row) => row.stats[key]);
  for (const key of ['doubleDoubles', 'tripleDoubles']) {
    const totals = rows.map((row) => row.sourceTotals[key]);
    stats[key] = totalGames == null || totalGames <= 0 || !totals.every(Number.isFinite)
      ? null : totals.reduce((sum, value) => sum + value, 0) / totalGames;
  }
  return {
    ...rows[0],
    teamId: null,
    teamAbbr: 'TOT',
    gamesPlayed: totalGames,
    minutesPerGame: weighted((row) => row.minutesPerGame),
    minutesTotal: totalGames == null || !rows.every((row) => Number.isFinite(row.minutesTotal))
      ? null : rows.reduce((sum, row) => sum + row.minutesTotal, 0),
    stats,
  };
}

function deduplicatePlayerSeasons(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.playerId}|${row.season}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  let aggregateRowsUsed = 0;
  let componentRowsDropped = 0;
  let teamRowsAggregated = 0;
  const normalized = [];
  for (const group of groups.values()) {
    if (group.length === 1) { normalized.push(group[0]); continue; }
    const totals = group.filter((row) => row.teamAbbr?.toUpperCase() === 'TOT' || row.teamId === '0');
    if (totals.length > 1) throw new Error(`Multiple Brescou aggregate rows for ${group[0].playerId}/${group[0].season}.`);
    if (totals.length === 1) {
      const components = group.filter((row) => row !== totals[0]);
      if (components.every((row) => Number.isFinite(row.gamesPlayed)) && Number.isFinite(totals[0].gamesPlayed)) {
        const componentGames = components.reduce((sum, row) => sum + row.gamesPlayed, 0);
        if (componentGames !== totals[0].gamesPlayed) throw new Error(`Brescou aggregate GP mismatch for ${group[0].playerId}/${group[0].season}.`);
      }
      normalized.push(totals[0]);
      aggregateRowsUsed += 1;
      componentRowsDropped += components.length;
    } else {
      normalized.push(aggregateTeamRows(group));
      teamRowsAggregated += group.length;
    }
  }
  return { rows: normalized, aggregateRowsUsed, componentRowsDropped, teamRowsAggregated };
}

function coverageFor(rows) {
  const seasons = [...new Set(rows.map((row) => row.season))].sort((a, b) => a - b);
  const gaps = [];
  for (let season = seasons[0]; season < seasons.at(-1); season += 1) if (!seasons.includes(season)) gaps.push(season);
  return { firstSeason: seasons[0] ?? null, lastSeason: seasons.at(-1) ?? null, seasonCount: seasons.length, gaps };
}

/** Normalize local Brescou regular-season CSV exports. This function performs no network access. */
export function importBrescouHistoricalCsv({ playerIndexCsv, traditionalStatsCsv, provenance }) {
  const indexRows = parseBrescouCsv(playerIndexCsv);
  const statsRows = parseBrescouCsv(traditionalStatsCsv);
  requireHeaders(indexRows, REQUIRED_INDEX_FIELDS, 'player index');
  requireHeaders(statsRows, REQUIRED_STATS_FIELDS, 'traditional regular-season stats');
  const players = buildPlayerIndex(indexRows);
  const deduplicated = deduplicatePlayerSeasons(statsRows.map((row) => mapStatsRow(row, players)));
  const imported = importHistoricalDataset({ rows: deduplicated.rows, provenance });
  return {
    ...imported,
    diagnostics: {
      ...imported.diagnostics,
      sourceRows: statsRows.length,
      aggregateRowsUsed: deduplicated.aggregateRowsUsed,
      componentRowsDropped: deduplicated.componentRowsDropped,
      teamRowsAggregated: deduplicated.teamRowsAggregated,
      seasonCoverage: coverageFor(deduplicated.rows),
    },
  };
}

export { assertBrescouTrainingAuthorized } from './sourcePolicy.js';
