import { emptyStatLine, num } from '../../providers/types.js';

export const HISTORICAL_SNAPSHOT_VERSION = 'progm.player-season.v1';

export const HISTORICAL_STAT_KEYS = Object.freeze([
  'points', 'rebounds', 'offRebounds', 'defRebounds', 'assists',
  'steals', 'blocks', 'turnovers', 'personalFouls', 'fgMade', 'fgAtt',
  'ftMade', 'ftAtt', 'threesMade', 'doubleDoubles', 'tripleDoubles',
]);

function textOrNull(value) {
  if (value == null) return null;
  const valueText = String(value).trim();
  return valueText || null;
}

function integerOrNull(value) {
  const parsed = num(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

function requireSeason(value) {
  const season = integerOrNull(value);
  if (season == null || season < 1946 || season > 2100) {
    throw new Error(`Invalid NBA season start year: ${value ?? 'missing'}`);
  }
  return season;
}

/** Convert one authorized source row into the stable player-season schema. */
export function normalizeHistoricalSnapshot(row, provenance) {
  if (!row || typeof row !== 'object') throw new Error('Historical snapshot row must be an object.');
  const season = requireSeason(row.season);
  if (row.statSeason != null && requireSeason(row.statSeason) !== season) {
    throw new Error(`Season alignment mismatch for ${row.playerId || row.externalId || 'unknown player'}.`);
  }

  const playerId = textOrNull(row.player?.id ?? row.playerId ?? row.externalId);
  if (!playerId) throw new Error('Historical snapshots require a stable player id; name-only identity is not accepted.');
  const playerName = textOrNull(row.player?.name ?? row.playerName ?? row.name);
  if (!playerName) throw new Error(`Historical snapshot ${playerId}/${season} is missing player name.`);

  const sourceStats = row.stats || row.statLine || {};
  const gamesPlayed = num(Object.hasOwn(row, 'gamesPlayed') ? row.gamesPlayed : sourceStats.gamesPlayed);
  const minutesPerGame = num(Object.hasOwn(row, 'minutesPerGame') ? row.minutesPerGame : sourceStats.minutes);
  const explicitMinutes = num(row.minutesTotal);
  const derivedMinutes = explicitMinutes == null && gamesPlayed != null && minutesPerGame != null;
  const minutesTotal = explicitMinutes ?? (derivedMinutes ? gamesPlayed * minutesPerGame : null);

  const statLine = emptyStatLine();
  statLine.gamesPlayed = gamesPlayed;
  statLine.minutes = minutesPerGame;
  for (const key of HISTORICAL_STAT_KEYS) {
    statLine[key] = num(Object.hasOwn(sourceStats, key) ? sourceStats[key] : row[key]);
  }

  const age = num(row.age);
  const experience = num(row.experience);
  return {
    schemaVersion: HISTORICAL_SNAPSHOT_VERSION,
    season,
    player: { id: playerId, name: playerName },
    teamAbbr: textOrNull(row.teamAbbr),
    position: textOrNull(row.position),
    age,
    experience,
    gamesPlayed,
    minutesPerGame,
    minutesTotal: minutesTotal == null ? null : Number(minutesTotal.toFixed(2)),
    stats: Object.fromEntries(HISTORICAL_STAT_KEYS.map((key) => [key, statLine[key]])),
    derived: { minutesTotal: derivedMinutes },
    provenance: { ...provenance },
  };
}

/** Validate identity uniqueness and basic numeric/season invariants. */
export function validateHistoricalSnapshots(snapshots) {
  const errors = [];
  const seen = new Set();
  for (const row of snapshots || []) {
    const key = `${row?.player?.id || ''}|${row?.season ?? ''}`;
    if (seen.has(key)) errors.push(`Duplicate player-season identity: ${key}`);
    seen.add(key);
    if (row?.schemaVersion !== HISTORICAL_SNAPSHOT_VERSION) errors.push(`Unsupported schema version for ${key}.`);
    if (!row?.player?.id || !row?.player?.name) errors.push(`Incomplete player identity for ${key}.`);
    if (!Number.isInteger(row?.season)) errors.push(`Invalid season for ${key}.`);
    for (const [field, value] of [
      ['gamesPlayed', row?.gamesPlayed], ['minutesPerGame', row?.minutesPerGame],
      ['minutesTotal', row?.minutesTotal], ['age', row?.age], ['experience', row?.experience],
    ]) {
      if (value != null && !Number.isFinite(value)) errors.push(`Non-finite ${field} for ${key}.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Rebuild the provider-independent per-game StatLine used by league scoring. */
export function snapshotToStatLine(snapshot) {
  const line = emptyStatLine();
  line.gamesPlayed = snapshot?.gamesPlayed ?? null;
  line.minutes = snapshot?.minutesPerGame ?? null;
  for (const key of HISTORICAL_STAT_KEYS) line[key] = snapshot?.stats?.[key] ?? null;
  return line;
}
