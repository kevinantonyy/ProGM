import { createElement } from 'react';
import { STATUS_LEGEND, statusBadge, statusNotices } from '../utils/playerStatus.js';

/** Yahoo designation badge for a draft row; renders nothing when Yahoo shows none. Plain JS so it is unit-testable. */
export default function PlayerStatusBadge({ status }) {
  const b = statusBadge(status);
  if (!b) return null;
  return createElement('span', { className: `${b.className} player-status-badge`, title: b.title, 'aria-label': `${b.text}. ${b.title}`, 'data-testid': 'player-status-badge', 'data-state': b.state, tabIndex: 0 }, b.text);
}

/** Injury-data warning, stale-status notice and legend above the draft board. */
export function DraftStatusNotice({ statusData }) {
  if (!statusData) return null;
  const notices = statusNotices(statusData);
  return createElement('section', { className: `card space-y-1 p-3 text-xs leading-5${notices.length ? ' border-orange-500/30' : ''}`, 'data-testid': 'draft-status-notice', role: notices.length ? 'status' : undefined },
    ...notices.map((n) => createElement('p', { key: n.kind, className: 'font-semibold text-accent-orange', 'data-kind': n.kind }, n.text)),
    createElement('p', { key: 'legend', className: 'text-dark-400' }, STATUS_LEGEND));
}
