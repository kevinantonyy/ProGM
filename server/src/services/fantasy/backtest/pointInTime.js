/**
 * Point-in-time data access for chronological evaluation.
 *
 * A forecast made at time T may only use rows whose `availableAt` is at or before T. Season statistics become final when the
 * season ends, so by default a season-s row is available from 1 July of s+1 (season start-year convention) and a preseason
 * forecast for season t is made on 1 October of t. Rows that are not yet available are never copied into the view, so no model
 * can read them, accidentally or otherwise. Views are deep-frozen.
 */
import { createHash } from 'node:crypto';

export const EVALUATION_FRAMEWORK_VERSION = 'progm.chrono-eval.v1';

export function forecastAsOf(targetSeason) { return `${targetSeason}-10-01T00:00:00.000Z`; }
export function seasonFinalAt(season) { return `${season + 1}-07-01T00:00:00.000Z`; }
export function rowAvailableAt(row) { return row?.availableAt ?? seasonFinalAt(row.season); }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
}

export function fingerprint(rows) {
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.player.id}|${r.season}|${r.gamesPlayed}|${r.minutesPerGame}|${JSON.stringify(r.stats)};`);
  return h.digest('hex').slice(0, 16);
}

/** @returns a frozen view holding only rows available at `asOf`. */
export function createPointInTimeView(snapshots, asOf) {
  const cut = Date.parse(asOf);
  if (!Number.isFinite(cut)) throw new Error('A valid asOf timestamp is required.');
  const rows = snapshots.filter((row) => Date.parse(rowAvailableAt(row)) <= cut).map((row) => structuredClone(row));
  const seasons = rows.map((r) => r.season);
  const latestAvailableAt = rows.reduce((m, r) => Math.max(m, Date.parse(rowAvailableAt(r))), 0);
  return deepFreeze({
    asOf: new Date(cut).toISOString(),
    rows,
    rowCount: rows.length,
    cutoffSeason: seasons.length ? Math.max(...seasons) : null,
    latestAvailableAt: latestAvailableAt ? new Date(latestAvailableAt).toISOString() : null,
    fingerprint: fingerprint(rows),
    historyOf: (playerId) => rows.filter((r) => r.player.id === playerId).sort((a, b) => b.season - a.season),
  });
}

/** Throws if a view could contain information from the future of `asOf`. */
export function assertViewIsPointInTime(view) {
  for (const r of view.rows) {
    if (Date.parse(rowAvailableAt(r)) > Date.parse(view.asOf)) throw new Error(`Leakage: row ${r.player.id}/${r.season} is not available at ${view.asOf}.`);
  }
  return true;
}
