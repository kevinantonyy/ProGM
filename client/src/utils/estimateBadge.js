/** Shared wording for players whose projection is a Yahoo-ADP-implied estimate (no NBA stat line). */
export const ESTIMATE_LABEL = 'Estimated';
export const ESTIMATE_TOOLTIP = 'Estimate based on Yahoo ADP. Low confidence, and not an independent statistical projection. Value/Reach and Draft Now/Wait comparisons are not shown for it.';

/** Strict: only the server's explicit `estimate: true` counts (missing/false/"true" strings do not). */
export function isEstimated(player) {
  return player?.estimate === true;
}
