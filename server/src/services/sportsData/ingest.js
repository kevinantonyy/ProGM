import { importHistoricalDataset } from '../fantasy/backtest/importer.js';
import { HISTORICAL_STAT_KEYS } from '../fantasy/backtest/snapshot.js';
import { ENTITY_KINDS, NORMALIZERS, SCHEMA_VERSION, contentHash, requireSport } from './schema.js';
import { assertIngestionPermitted, evaluationProvenance, normalizeSource } from './sourcePermissions.js';

export const MAX_BATCH_RECORDS = 50000;

/** Register or update a source after validating its documented permissions. */
export async function registerSource(store, raw) {
  const source = normalizeSource(raw);
  await store.ensureSchema();
  await store.upsertSource(source);
  return source;
}

function prepareKind(kind, rawRecords, sport) {
  if (!Array.isArray(rawRecords)) throw new Error(`${kind} must be an array.`);
  const byId = new Map();
  let duplicatesCollapsed = 0;
  for (const raw of rawRecords) {
    const record = NORMALIZERS[kind](raw, sport);
    const existing = byId.get(record.externalId);
    if (existing) {
      if (contentHash(existing) !== contentHash(record)) throw new Error(`Conflicting duplicate ${kind} record in batch: ${record.externalId}.`);
      duplicatesCollapsed += 1;
      continue;
    }
    byId.set(record.externalId, record);
  }
  return { byId, duplicatesCollapsed };
}

async function resolve(tx, kind, sport, sourceKey, batchMap, ids) {
  const missing = [...new Set(ids)].filter((id) => !batchMap.has(id));
  const stored = await tx.getRecords(kind, sport, sourceKey, missing);
  const lookup = (id) => batchMap.get(id) || stored.get(id) || null;
  return { lookup, unknown: missing.filter((id) => !stored.has(id)) };
}

/**
 * Validate, deduplicate and upsert one provider batch atomically. Re-ingesting
 * identical data is a no-op (content hashes); changed records are updated.
 * Every record is attributed to its registered source.
 */
export async function ingestBatch(store, batch, { now = () => new Date().toISOString() } = {}) {
  const { sourceKey, sport } = batch || {};
  requireSport(sport);
  await store.ensureSchema();
  const stored = sourceKey ? await store.getSource(sourceKey) : null;
  if (!stored) throw new Error(`Ingestion refused: source ${sourceKey ?? '(missing)'} is not registered.`);
  // Re-validate the stored registration so a weakened or stale record cannot be used.
  const source = normalizeSource(stored);
  assertIngestionPermitted(source, sport);

  const startedAt = now();
  try {
    const total = ENTITY_KINDS.reduce((sum, kind) => sum + (batch[kind]?.length || 0), 0);
    if (total === 0) throw new Error('Ingestion batch is empty.');
    if (total > MAX_BATCH_RECORDS) throw new Error(`Ingestion batch exceeds ${MAX_BATCH_RECORDS} records; split it into smaller batches.`);
    const prepared = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, prepareKind(kind, batch[kind] || [], sport)]));

    const counts = await store.transaction(async (tx) => {
      const teams = prepared.teams.byId;
      const games = prepared.games.byId;
      const gameTeams = await resolve(tx, 'teams', sport, sourceKey, teams, [...games.values()].flatMap((game) => [game.homeTeamId, game.awayTeamId]));
      if (gameTeams.unknown.length) throw new Error(`Games reference unknown teams: ${gameTeams.unknown.slice(0, 5).join(', ')}.`);

      const stats = [...prepared.playerGameStats.byId.values()];
      const statGames = await resolve(tx, 'games', sport, sourceKey, games, stats.map((stat) => stat.gameId));
      const statPlayers = await resolve(tx, 'players', sport, sourceKey, prepared.players.byId, stats.map((stat) => stat.playerId));
      if (statGames.unknown.length) throw new Error(`Player stats reference unknown games: ${statGames.unknown.slice(0, 5).join(', ')}.`);
      if (statPlayers.unknown.length) throw new Error(`Player stats reference unknown players: ${statPlayers.unknown.slice(0, 5).join(', ')}.`);
      for (const stat of stats) {
        const game = statGames.lookup(stat.gameId);
        if (![game.homeTeamId, game.awayTeamId].includes(stat.teamId)) throw new Error(`Stat ${stat.externalId} team ${stat.teamId} did not play in game ${stat.gameId}.`);
        // Denormalized for season queries and evaluation exports.
        stat.season = game.season;
        stat.seasonType = game.seasonType;
      }

      const result = {};
      for (const kind of ENTITY_KINDS) {
        const records = [...prepared[kind].byId.values()].map((record) => ({ ...record, contentHash: contentHash(record) }));
        result[kind] = { ...(await tx.upsertRecords(kind, sport, sourceKey, records)), duplicatesCollapsed: prepared[kind].duplicatesCollapsed };
      }
      return result;
    });
    const runId = await store.insertRun({ sourceKey, sport, status: 'succeeded', counts, schemaVersion: SCHEMA_VERSION, startedAt, finishedAt: now() });
    return { runId, sourceKey, sport, counts };
  } catch (error) {
    await store.insertRun({ sourceKey, sport, status: 'failed', counts: {}, error: error.message, startedAt, finishedAt: now() });
    throw error;
  }
}

async function queryAll(store, kind, sport, filters) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await store.query(kind, sport, filters, { limit: 1000, offset });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function ageOn(birthDate, isoDay) {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = isoDay.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * Aggregate stored regular-season player games into Phase 8 player-season
 * snapshots. Requires the source's model-training permission; did-not-play
 * rows are excluded and incomplete categories stay null.
 */
export async function exportHistoricalSnapshots(store, { sport, sourceKey, seasons = null }) {
  requireSport(sport);
  const stored = await store.getSource(sourceKey);
  if (!stored) throw new Error(`Source ${sourceKey} is not registered.`);
  const source = normalizeSource(stored);
  const provenance = evaluationProvenance(source, stored.updatedAt);
  const wanted = seasons == null ? null : new Set(seasons.map(Number));
  const statRows = (await queryAll(store, 'playerGameStats', sport, { sourceKey, seasonType: 'regular' }))
    .filter((row) => !row.didNotPlay && (!wanted || wanted.has(row.season)));
  const players = new Map((await queryAll(store, 'players', sport, { sourceKey })).map((row) => [row.externalId, row]));
  const teams = new Map((await queryAll(store, 'teams', sport, { sourceKey })).map((row) => [row.externalId, row]));

  const groups = new Map();
  for (const row of statRows) {
    const key = `${row.playerId}|${row.season}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const rows = [...groups.values()].map((games) => {
    const { playerId, season } = games[0];
    const player = players.get(playerId) || {};
    const mean = (key) => {
      const values = games.map((game) => game.stats[key]);
      return values.every((value) => value != null) ? values.reduce((sum, value) => sum + value, 0) / games.length : null;
    };
    const stats = {};
    for (const key of HISTORICAL_STAT_KEYS) if (key !== 'doubleDoubles' && key !== 'tripleDoubles') stats[key] = mean(key);
    const achievement = games.map((game) => ['points', 'rebounds', 'assists', 'steals', 'blocks'].map((key) => game.stats[key]));
    const complete = achievement.every((values) => values.every((value) => value != null));
    stats.doubleDoubles = complete ? achievement.filter((values) => values.filter((value) => value >= 10).length >= 2).length / games.length : null;
    stats.tripleDoubles = complete ? achievement.filter((values) => values.filter((value) => value >= 10).length >= 3).length / games.length : null;
    // Stat rows are not date-ordered, so attribute the season to the most frequent team.
    const teamGames = new Map();
    for (const game of games) teamGames.set(game.teamId, (teamGames.get(game.teamId) || 0) + 1);
    const [mainTeamId] = [...teamGames.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const mainTeam = teams.get(mainTeamId);
    return {
      season,
      statSeason: season,
      playerId: `${sourceKey}:${playerId}`,
      name: player.fullName,
      teamAbbr: mainTeam?.abbreviation ?? null,
      position: player.position ?? null,
      age: ageOn(player.birthDate, `${season + 1}-02-01`),
      experience: player.debutSeason == null ? null : Math.max(0, season - player.debutSeason),
      gamesPlayed: games.length,
      minutesPerGame: mean('minutes'),
      stats,
    };
  });
  return importHistoricalDataset({ rows, provenance });
}
