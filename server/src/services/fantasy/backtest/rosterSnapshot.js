import { num } from '../../providers/types.js';
import { normalizeProvenance } from './importer.js';

export const ROSTER_SNAPSHOT_VERSION = 'progm.team-roster.v1';

function text(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function season(value) {
  const parsed = num(value);
  if (!Number.isInteger(parsed) || parsed < 1946 || parsed > 2100) throw new Error(`Invalid roster season: ${value ?? 'missing'}`);
  return parsed;
}

export function normalizeTeamRosterDataset({ rows, teamSeasons = [], provenance }) {
  if (!Array.isArray(rows)) throw new Error('Team roster import rows must be an array.');
  const normalizedProvenance = normalizeProvenance(provenance);
  const completeness = new Map();
  for (const item of teamSeasons || []) {
    const key = `${season(item.season)}|${text(item.teamAbbr) || ''}`;
    if (!text(item.teamAbbr)) throw new Error('Roster completeness records require a team abbreviation.');
    completeness.set(key, item.complete === true);
  }
  const seen = new Set();
  const snapshots = rows.map((row) => {
    const rosterSeason = season(row.season);
    const playerId = text(row.player?.id ?? row.playerId ?? row.externalId);
    const playerName = text(row.player?.name ?? row.playerName ?? row.name);
    const teamAbbr = text(row.teamAbbr ?? row.team);
    if (!playerId || !playerName || !teamAbbr) throw new Error('Roster rows require stable player id, name, and team abbreviation.');
    const key = `${rosterSeason}|${playerId}`;
    if (seen.has(key)) throw new Error(`Duplicate roster player-season identity: ${key}`);
    seen.add(key);
    const gamesPlayed = num(row.gamesPlayed);
    const minutesPerGame = num(row.minutesPerGame);
    const explicitMinutes = num(row.minutesTotal);
    return {
      schemaVersion: ROSTER_SNAPSHOT_VERSION,
      season: rosterSeason,
      player: { id: playerId, name: playerName },
      teamAbbr,
      position: text(row.position),
      gamesPlayed,
      minutesPerGame,
      minutesTotal: explicitMinutes ?? (gamesPlayed != null && minutesPerGame != null ? gamesPlayed * minutesPerGame : null),
      teamRosterComplete: completeness.get(`${rosterSeason}|${teamAbbr}`) === true,
      knownBeforeSeason: row.knownBeforeSeason === true,
      provenance: { ...normalizedProvenance },
    };
  });
  return {
    schemaVersion: ROSTER_SNAPSHOT_VERSION,
    provenance: normalizedProvenance,
    snapshots,
    diagnostics: {
      rows: snapshots.length,
      seasons: [...new Set(snapshots.map((row) => row.season))].sort((a, b) => a - b),
      completeTeamSeasons: [...completeness.values()].filter(Boolean).length,
    },
  };
}

/** Build a roster file from authorized player-season snapshots; completeness must be asserted separately. */
export function rosterRowsFromPlayerSeasons(snapshots) {
  return (snapshots || []).map((row) => ({
    season: row.season,
    playerId: row.player.id,
    name: row.player.name,
    teamAbbr: row.teamAbbr,
    position: row.position,
    gamesPlayed: row.gamesPlayed,
    minutesPerGame: row.minutesPerGame,
    minutesTotal: row.minutesTotal,
    knownBeforeSeason: false,
  }));
}
