import { createHash } from 'node:crypto';
import { num } from '../providers/types.js';

/**
 * Normalized, provider-independent sports data schema. Every record is keyed by
 * (sport, sourceKey, externalId) so several authorized providers can coexist;
 * cross-provider identity linking is intentionally deferred (see README).
 * Missing values stay null; nothing is defaulted to zero.
 */
export const SCHEMA_VERSION = 'progm.sports-data.v1';

export const SPORTS = Object.freeze({
  basketball: Object.freeze({
    implemented: true,
    leagues: ['NBA'],
    seasonTypes: ['regular', 'postseason', 'preseason', 'allstar', 'playin'],
    // Shares the provider StatLine vocabulary (providers/types.js) plus threesAtt.
    gameStatKeys: Object.freeze([
      'minutes', 'points', 'rebounds', 'offRebounds', 'defRebounds', 'assists', 'steals', 'blocks',
      'turnovers', 'personalFouls', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade', 'threesAtt',
    ]),
  }),
  // Reserved so schemas, routes and storage stay sport-generic. Not implemented.
  football: Object.freeze({ implemented: false, leagues: ['NFL'], seasonTypes: [], gameStatKeys: Object.freeze([]) }),
});

export const ENTITY_KINDS = Object.freeze(['teams', 'players', 'games', 'playerGameStats']);

export function requireSport(sport) {
  const config = SPORTS[sport];
  if (!config) throw new Error(`Unknown sport: ${sport}.`);
  if (!config.implemented) throw new Error(`Sport not implemented yet: ${sport}.`);
  return config;
}

function text(value) {
  if (value == null) return null;
  const valueText = String(value).trim();
  return valueText || null;
}

function requiredText(value, label) {
  const valueText = text(value);
  if (!valueText) throw new Error(`${label} is required.`);
  return valueText;
}

function season(value, label) {
  const parsed = num(value);
  if (parsed == null || !Number.isInteger(parsed) || parsed < 1946 || parsed > 2100) throw new Error(`${label} has invalid season: ${value ?? 'missing'}.`);
  return parsed;
}

function isoDate(value, label) {
  if (value == null || value === '') return null;
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  if (!match || Number.isNaN(Date.parse(match[0]))) throw new Error(`${label} has invalid date: ${value}.`);
  return match[0];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** Stable content hash used for idempotent, incremental upserts. */
export function contentHash(record) {
  const { contentHash: _ignored, ...rest } = record;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export function normalizeTeam(raw, sport) {
  const externalId = requiredText(raw?.externalId, 'Team externalId');
  return {
    externalId,
    abbreviation: text(raw.abbreviation),
    name: requiredText(raw.name, `Team ${externalId} name`),
    city: text(raw.city),
    league: text(raw.league) || SPORTS[sport].leagues[0],
  };
}

export function normalizePlayer(raw) {
  const externalId = requiredText(raw?.externalId, 'Player externalId');
  return {
    externalId,
    fullName: requiredText(raw.fullName, `Player ${externalId} fullName`),
    birthDate: isoDate(raw.birthDate, `Player ${externalId}`),
    position: text(raw.position),
    debutSeason: raw.debutSeason == null || raw.debutSeason === '' ? null : season(raw.debutSeason, `Player ${externalId}`),
  };
}

export function normalizeGame(raw, sport) {
  const externalId = requiredText(raw?.externalId, 'Game externalId');
  const label = `Game ${externalId}`;
  const seasonType = text(raw.seasonType) || 'regular';
  if (!SPORTS[sport].seasonTypes.includes(seasonType)) throw new Error(`${label} has unsupported seasonType: ${seasonType}.`);
  const homeTeamId = requiredText(raw.homeTeamId, `${label} homeTeamId`);
  const awayTeamId = requiredText(raw.awayTeamId, `${label} awayTeamId`);
  if (homeTeamId === awayTeamId) throw new Error(`${label} has the same home and away team.`);
  return {
    externalId,
    season: season(raw.season, label),
    seasonType,
    gameDate: isoDate(raw.gameDate, label),
    homeTeamId,
    awayTeamId,
    homeScore: num(raw.homeScore),
    awayScore: num(raw.awayScore),
    status: text(raw.status) || 'final',
  };
}

export function normalizePlayerGameStat(raw, sport) {
  const gameId = requiredText(raw?.gameId, 'Stat gameId');
  const playerId = requiredText(raw?.playerId, 'Stat playerId');
  const label = `Stat ${gameId}/${playerId}`;
  const stats = {};
  for (const key of SPORTS[sport].gameStatKeys) {
    const value = raw.stats?.[key];
    if (value != null && value !== '' && num(value) == null) throw new Error(`${label} has non-numeric ${key}: ${value}.`);
    stats[key] = num(value);
    if (stats[key] != null && stats[key] < 0) throw new Error(`${label} has negative ${key}.`);
  }
  for (const [made, attempted] of [['fgMade', 'fgAtt'], ['ftMade', 'ftAtt'], ['threesMade', 'threesAtt'], ['threesMade', 'fgMade']]) {
    if (stats[made] != null && stats[attempted] != null && stats[made] > stats[attempted]) throw new Error(`${label} has ${made} greater than ${attempted}.`);
  }
  if ([stats.rebounds, stats.offRebounds, stats.defRebounds].every((value) => value != null)
      && stats.rebounds !== stats.offRebounds + stats.defRebounds) {
    throw new Error(`${label} has inconsistent rebound split.`);
  }
  return {
    externalId: `${gameId}:${playerId}`,
    gameId,
    playerId,
    teamId: requiredText(raw.teamId, `${label} teamId`),
    didNotPlay: raw.didNotPlay === true || stats.minutes === 0,
    stats,
  };
}

export const NORMALIZERS = Object.freeze({
  teams: normalizeTeam,
  players: normalizePlayer,
  games: normalizeGame,
  playerGameStats: normalizePlayerGameStat,
});
