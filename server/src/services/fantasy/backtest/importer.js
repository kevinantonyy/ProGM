import {
  HISTORICAL_SNAPSHOT_VERSION,
  HISTORICAL_STAT_KEYS,
  normalizeHistoricalSnapshot,
  validateHistoricalSnapshots,
} from './snapshot.js';
import { restrictedSourceFromProvenance, restrictedSourceFromRows } from './sourcePolicy.js';

export function normalizeProvenance(raw) {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  const permission = typeof raw?.permission === 'string' ? raw.permission.trim() : '';
  const acquiredAt = raw?.acquiredAt && !Number.isNaN(Date.parse(raw.acquiredAt))
    ? new Date(raw.acquiredAt).toISOString()
    : null;
  if (raw?.authorized !== true) throw new Error('Historical import refused: source authorization must be explicitly true.');
  if (!name || !permission || !acquiredAt) {
    throw new Error('Historical import requires source name, permission/license evidence, and acquiredAt timestamp.');
  }
  return {
    name,
    datasetVersion: raw?.datasetVersion == null ? null : String(raw.datasetVersion),
    permission,
    acquiredAt,
    authorized: true,
    synthetic: raw?.synthetic === true,
    provider: raw?.provider == null ? null : String(raw.provider),
    licenseUrl: raw?.licenseUrl == null ? null : String(raw.licenseUrl),
    sourceUrl: raw?.sourceUrl == null ? null : String(raw.sourceUrl),
    exportId: raw?.exportId == null ? null : String(raw.exportId),
    restrictedSource: restrictedSourceFromProvenance(raw),
    commercialModelTrainingAuthorized: raw?.commercialModelTrainingAuthorized === true,
    rightsEvidenceUrl: raw?.rightsEvidenceUrl == null ? null : String(raw.rightsEvidenceUrl),
  };
}

/** Import a bulk user-supplied or otherwise authorized historical dataset. */
export function importHistoricalDataset({ rows, provenance, sourceRows = rows }) {
  if (!Array.isArray(rows)) throw new Error('Historical import rows must be an array.');
  const normalizedProvenance = normalizeProvenance(provenance);
  // Detect restricted data from its content too, so choosing a generic format
  // or omitting the source name cannot bypass the licensing gate.
  normalizedProvenance.restrictedSource ||= restrictedSourceFromRows(sourceRows) || restrictedSourceFromRows(rows);
  const snapshots = rows.map((row) => normalizeHistoricalSnapshot(row, normalizedProvenance));
  const validation = validateHistoricalSnapshots(snapshots);
  if (!validation.valid) throw new Error(`Historical import validation failed: ${validation.errors.join(' ')}`);

  const missingByField = {};
  const fields = ['teamAbbr', 'position', 'age', 'experience', 'gamesPlayed', 'minutesPerGame', 'minutesTotal'];
  for (const field of fields) missingByField[field] = snapshots.filter((row) => row[field] == null).length;
  for (const key of HISTORICAL_STAT_KEYS) missingByField[`stats.${key}`] = snapshots.filter((row) => row.stats[key] == null).length;

  return {
    schemaVersion: HISTORICAL_SNAPSHOT_VERSION,
    provenance: normalizedProvenance,
    snapshots,
    diagnostics: {
      rows: snapshots.length,
      players: new Set(snapshots.map((row) => row.player.id)).size,
      seasons: [...new Set(snapshots.map((row) => row.season))].sort((a, b) => a - b),
      missingByField,
    },
  };
}

/**
 * Adapter for an already-normalized provider season. It performs no fetching;
 * callers must supply authorized data and attest its permission in provenance.
 */
export function importNormalizedProviderSeason({ season, playerIndex = [], playerStats = [], provenance }) {
  const refs = new Map(playerIndex.map((player) => [String(player.externalId), player]));
  const rows = playerStats.map((record) => {
    const ref = refs.get(String(record.externalId)) || {};
    const line = record.season || {};
    const debutYear = Number.isInteger(Number(ref.debutYear)) ? Number(ref.debutYear) : null;
    return {
      season,
      statSeason: record.seasonYear ?? season,
      externalId: record.externalId,
      name: ref.name || record.name,
      teamAbbr: ref.teamAbbr || record.teamAbbr || null,
      position: ref.position || null,
      age: ref.age ?? null,
      experience: debutYear == null ? null : Number(season) - debutYear,
      gamesPlayed: line.gamesPlayed,
      minutesPerGame: line.minutes,
      stats: line,
    };
  });
  return importHistoricalDataset({ rows, provenance });
}
