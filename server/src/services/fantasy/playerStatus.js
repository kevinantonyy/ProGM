/**
 * Yahoo player designations for display (experimental; PROGM_DRAFT_STATUS=on, default off).
 *
 * Display only: nothing here feeds projections, value, rank, waivers, lineups, trades or recommendations.
 * Yahoo returns a designation code (`status`), a label (`status_full`) and sometimes `injury_note`, but never when the
 * designation was set. `observedAt` is when ProGM requested the data from Yahoo, or null; it is never derived or invented.
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
export function classifyYahooStatus(player, { observedAt = null } = {}) {
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
  };
}

/**
 * Adds `leagueAvailability` and `playerStatus` to every draft row and a board-level `statusData` block. Returns a new
 * board; existing fields, row order and every ranking value are copied unchanged.
 * @param {object} board              buildDraftBoard() result
 * @param {Map<string,object>} poolByKey  playerKey -> normalized Yahoo player the row was built from
 * @param {{observedAt?:string|null, injuryReports?:{available:boolean, provider:string|null}}} meta
 */
export function withPlayerStatus(board, poolByKey, { observedAt = null, injuryReports = { available: false, provider: null } } = {}) {
  const annotate = (row) => ({
    ...row,
    // Rostered in this Yahoo league or not. Says nothing about health; that is playerStatus.
    leagueAvailability: row.availability ?? 'unknown',
    playerStatus: classifyYahooStatus(poolByKey.get(row.playerKey) ?? { status: row.status }, { observedAt }),
  });
  return {
    ...board,
    board: (board.board || []).map(annotate),
    noData: (board.noData || []).map(annotate),
    statusData: {
      source: 'yahoo',
      observedAt: isoOrNull(observedAt),
      injuryReports: { available: injuryReports.available === true, provider: injuryReports.provider ?? null },
      warning: injuryReports.available === true ? null
        : 'External injury reports are unavailable, so projections and expected games do not reflect current injuries. Designations shown are Yahoo\'s only; a player without one is not confirmed healthy.',
    },
  };
}
