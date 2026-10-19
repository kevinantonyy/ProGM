import { createElement } from 'react';

/** Shown above the Rankings table only when NO listed player has a projection, so a column of dashes always comes with a reason. Plain JS so it is unit-testable. */
export default function RankingsNotice({ players, reason }) {
  const list = Array.isArray(players) ? players : [];
  if (!list.length || list.some((player) => player?.projected != null)) return null;
  return createElement('section', { role: 'alert', 'data-testid': 'rankings-no-projections', className: 'card space-y-1 border-orange-500/30 p-3 text-sm' },
    createElement('p', { key: 'headline', className: 'font-semibold text-accent-orange' }, 'No player has a projection, so ProGM ranks and projected points cannot be shown.'),
    createElement('p', { key: 'reason', className: 'text-dark-300' }, reason || 'The NBA stats data needed for projections is unavailable.'));
}
