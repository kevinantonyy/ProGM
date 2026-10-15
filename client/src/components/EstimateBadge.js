import { createElement } from 'react';
import { ESTIMATE_LABEL, ESTIMATE_TOOLTIP, isEstimated } from '../utils/estimateBadge.js';

/** Small badge for estimated projections; renders nothing for every other player. Plain JS so it is unit-testable. */
export default function EstimateBadge({ player }) {
  if (!isEstimated(player)) return null;
  return createElement('span', { className: 'badge-blue ml-2 align-middle', title: ESTIMATE_TOOLTIP, 'data-testid': 'estimate-badge', tabIndex: 0, 'aria-label': `${ESTIMATE_LABEL}: ${ESTIMATE_TOOLTIP}` }, ESTIMATE_LABEL);
}
