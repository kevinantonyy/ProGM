/**
 * Licensing policy for offline model data. Brescou/NBA-dataset-stats-player-team
 * is MIT-licensed, but upstream NBA statistics rights are unverified, so any
 * import recognized as Brescou-derived is restricted regardless of the import
 * format chosen. Restricted snapshots may be imported for validation, but no
 * backtest, evaluation, or model fit may run on them without documented rights.
 */

export const RESTRICTED_SOURCES = Object.freeze({ BRESCOU: 'brescou' });

const BRESCOU_TEXT = /brescou|nba-dataset-stats-player-team/i;
const PROVENANCE_TEXT_FIELDS = ['name', 'provider', 'sourceUrl', 'licenseUrl', 'datasetVersion', 'exportId', 'permission'];
// Column signatures of the Brescou traditional-stats and player-index CSVs
// (NBA.com stats schema). Matching either marks the import as restricted.
const BRESCOU_COLUMN_SIGNATURES = Object.freeze([
  ['PLAYER_ID', 'NBA_FANTASY_PTS', 'WNBA_FANTASY_PTS', 'DD2', 'TD3', 'SEASON'],
  ['PERSON_ID', 'PLAYER_SLUG', 'FROM_YEAR', 'TO_YEAR'],
]);

function rowIdentity(row) {
  return String(row?.player?.id ?? row?.playerId ?? row?.externalId ?? row?.PLAYER_ID ?? '');
}

export function restrictedSourceFromProvenance(raw) {
  if (raw?.restrictedSource != null && String(raw.restrictedSource).trim()) return String(raw.restrictedSource).trim();
  return PROVENANCE_TEXT_FIELDS.some((field) => raw?.[field] != null && BRESCOU_TEXT.test(String(raw[field])))
    ? RESTRICTED_SOURCES.BRESCOU : null;
}

export function restrictedSourceFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (rowIdentity(row).toLowerCase().startsWith('brescou:')) return RESTRICTED_SOURCES.BRESCOU;
    if (row.provenance && restrictedSourceFromProvenance(row.provenance)) return restrictedSourceFromProvenance(row.provenance);
  }
  const keys = new Set(rows.flatMap((row) => (row && typeof row === 'object' ? Object.keys(row) : [])).map((key) => key.toUpperCase()));
  return BRESCOU_COLUMN_SIGNATURES.some((signature) => signature.every((column) => keys.has(column)))
    ? RESTRICTED_SOURCES.BRESCOU : null;
}

export function hasDocumentedTrainingRights(provenance) {
  return provenance?.commercialModelTrainingAuthorized === true && Boolean(String(provenance?.rightsEvidenceUrl ?? '').trim());
}

export function assertBrescouTrainingAuthorized(provenance) {
  if (!hasDocumentedTrainingRights(provenance)) {
    throw new Error('Brescou model training is blocked until upstream commercial-use and model-training rights are documented. Use --validate-only.');
  }
}

/** Throws when any snapshot comes from a restricted source without documented training rights. */
export function assertSnapshotsTrainable(snapshots) {
  for (const snapshot of snapshots || []) {
    const provenance = snapshot?.provenance;
    const restricted = provenance?.restrictedSource || restrictedSourceFromRows([snapshot]);
    if (restricted && !hasDocumentedTrainingRights(provenance)) {
      throw new Error(`${restricted === RESTRICTED_SOURCES.BRESCOU ? 'Brescou' : restricted} model training is blocked until upstream commercial-use and model-training rights are documented. Use --validate-only.`);
    }
  }
}
