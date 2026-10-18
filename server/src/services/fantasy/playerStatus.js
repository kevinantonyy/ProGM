/**
 * Yahoo player designations for display (experimental; PROGM_DRAFT_STATUS=on, default off).
 *
 * Display only: nothing here feeds projections, value, rank, waivers, lineups, trades or recommendations.
 * Yahoo returns a designation code (`status`), a label (`status_full`) and sometimes `injury_note`, but never when the
 * designation was set. `observedAt` preserves the status-bearing Yahoo fetch/cache time, or null when unknown.
 *
 * States keep "inactive" apart from "out", and "none" (Yahoo shows no designation) apart from "unknown" (a code this
 * table does not recognise). Neither "none" nor anything else here means the player is confirmed healthy.
 */
const STATE_BY_CODE = Object.freeze({
  NA: 'inactive',
  O: 'out', OUT: 'out', INJ: 'out', IL: 'out', 'IL+': 'out', IR: 'out', OFS: 'out',
  D: 'doubtful',
  Q: 'questionable', GTD: 'questionable', DTD: 'questionable', P: 'questionable',
  SUSP: 'suspended',
});
const LABEL_BY_CODE = Object.freeze({
  NA: 'Not active', O: 'Out', OUT: 'Out', INJ: 'Injured', IL: 'Injured list', 'IL+': 'Injured list', IR: 'Injured reserve',
  OFS: 'Out for season', D: 'Doubtful', Q: 'Questionable', GTD: 'Game-time decision', DTD: 'Day-to-day', P: 'Probable', SUSP: 'Suspended',
});
export const PLAYER_STATUS_STATES = Object.freeze(['inactive', 'out', 'doubtful', 'questionable', 'suspended', 'none', 'unknown']);

export function resolveDraftStatusDisplay(env = process.env) {
  return ['on', 'true', '1'].includes(String(env?.PROGM_DRAFT_STATUS ?? '').trim().toLowerCase());
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoOrNull = (v) => (v != null && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/** @param {{status?:string|null, statusFull?:string|null, injuryNote?:string|null}} player normalized Yahoo player */
export function classifyYahooStatus(player, { observedAt = null, stale = false } = {}) {
  const code = text(player?.status);
  const key = code?.toUpperCase() ?? null;
  const state = key == null ? 'none' : (STATE_BY_CODE[key] ?? 'unknown');
  return {
    code,
    state,
    label: text(player?.statusFull) ?? (key ? LABEL_BY_CODE[key] ?? code : null),
    note: text(player?.injuryNote),
    source: 'yahoo',
    observedAt: isoOrNull(observedAt),
    ...(stale ? { stale: true } : {}),
  };
}

/**
 * Adds `leagueAvailability` and `playerStatus` to every draft row and a board-level `statusData` block. Returns a new
 * board; existing fields, row order and every ranking value are copied unchanged.
 * @param {object} board              buildDraftBoard() result
 * @param {Map<string,object>} poolByKey  playerKey -> normalized Yahoo player the row was built from
 * @param {{observedAt?:string|null, stale?:boolean, injuryReports?:object}} meta cached-source metadata
 */
export function withPlayerStatus(board, poolByKey, { observedAt = null, stale = false, injuryReports = { available: false, provider: null } } = {}) {
  const annotate = (row) => ({
    ...row,
    // Rostered in this Yahoo league or not. Says nothing about health; that is playerStatus.
    leagueAvailability: row.availability ?? 'unknown',
    playerStatus: classifyYahooStatus(poolByKey.get(row.playerKey) ?? { status: row.status }, {
      observedAt: Object.hasOwn(poolByKey.get(row.playerKey) || {}, 'yahooStatusFetchedAt')
        ? poolByKey.get(row.playerKey).yahooStatusFetchedAt : observedAt,
      stale,
    }),
  });
  const rows = (board.board || []).map(annotate);
  const noData = (board.noData || []).map(annotate);
  const times = [...rows, ...noData].map((row) => row.playerStatus.observedAt);
  const oldest = times.length ? (times.every(Boolean) ? times.sort()[0] : null) : isoOrNull(observedAt);
  return {
    ...board,
    board: rows,
    noData,
    statusData: {
      source: 'yahoo',
      observedAt: oldest,
      stale: stale === true,
      injuryReports: { ...injuryReports, available: injuryReports.available === true, provider: injuryReports.provider ?? null },
      warning: injuryReports.applicable === false ? 'Current injury reports are not applied to historical-season projections.'
        : injuryReports.available !== true ? 'External injury reports are unavailable, so projections and expected games do not reflect current injuries. Designations shown are Yahoo\'s only; a player without one is not confirmed healthy.'
          : injuryReports.stale ? 'External injury reports are cached and may be out of date; current injury coverage is not guaranteed.' : null,
    },
  };
}
