/**
 * Display helpers for the experimental draft-board status fields (server flag PROGM_DRAFT_STATUS=on).
 * Rows without `playerStatus` (flag off) keep the existing OUT badge.
 */
export const STATUS_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // shortcut: one fixed window; tune per draft phase if game-day use needs it

/** 'fresh' | 'stale' | 'unknown' (no or invalid fetch time; never assumed fresh). */
export function statusFreshness(observedAt, now = Date.now()) {
  const t = Date.parse(observedAt ?? '');
  if (!Number.isFinite(t) || t > now) return 'unknown';
  return now - t > STATUS_STALE_AFTER_MS ? 'stale' : 'fresh';
}

const STYLE = { out: 'badge-red', suspended: 'badge-red', doubtful: 'badge-orange', questionable: 'badge-orange', inactive: 'badge-blue', unknown: 'badge-blue' };
const EXPLAIN = {
  inactive: 'Not active on Yahoo. Yahoo does not say why, so this is not necessarily an injury.',
  out: 'Yahoo designation: out.',
  suspended: 'Yahoo designation: suspended.',
  doubtful: 'Yahoo designation: doubtful.',
  questionable: 'Yahoo designation: questionable or day-to-day.',
  unknown: 'ProGM does not recognise this Yahoo code; treat the player\'s status as unknown.',
};

/** Badge for a designated player, or null when Yahoo shows no designation (which is NOT a confirmation of health). */
export function statusBadge(status, { formatTime = (iso) => new Date(iso).toLocaleString() } = {}) {
  if (!status || !status.code || status.state === 'none') return null;
  const state = Object.hasOwn(STYLE, status.state) ? status.state : 'unknown';
  const label = state === 'unknown' ? 'Unrecognised' : (status.label || status.code);
  const fetched = statusFreshness(status.observedAt) === 'unknown' ? 'Fetch time unknown.' : `Fetched from Yahoo ${formatTime(status.observedAt)}.`;
  return {
    text: `${status.code} · ${label}`,
    className: STYLE[state],
    state,
    title: [EXPLAIN[state], status.note ? `Note: ${status.note}.` : null, fetched].filter(Boolean).join(' '),
  };
}

export function leagueAvailabilityLabel(value) {
  if (value === 'available') return 'Not rostered in your league';
  if (value === 'rostered') return 'Rostered in your league';
  return 'League availability unknown';
}

export const STATUS_LEGEND = 'Badges are Yahoo designations. NA = not active (Yahoo gives no reason). No badge means Yahoo lists no designation; it does not confirm the player is healthy.';

/** Board-level notices: injury-data warning, stale or unknown fetch time. */
export function statusNotices(statusData, now = Date.now()) {
  if (!statusData) return [];
  const notices = [];
  if (statusData.warning) notices.push({ kind: 'warning', text: statusData.warning });
  const freshness = statusFreshness(statusData.observedAt, now);
  if (freshness === 'stale') notices.push({ kind: 'stale', text: `Yahoo statuses were fetched about ${Math.floor((now - Date.parse(statusData.observedAt)) / 3600000)} hours ago and may be out of date. Refresh to update them.` });
  if (freshness === 'unknown') notices.push({ kind: 'stale', text: 'The time these Yahoo statuses were fetched is unknown, so they may be out of date.' });
  if (statusData.stale && freshness === 'fresh') notices.push({ kind: 'stale', text: 'Yahoo could not refresh player statuses. Showing cached designations, which may be out of date.' });
  return notices;
}
