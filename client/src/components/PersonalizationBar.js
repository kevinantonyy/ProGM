import { createElement as h } from 'react';
import { YAHOO_AI_UNAVAILABLE } from '../utils/aiSharing.js';

/**
 * The visible on/off control for personalized answers. `status`: 'loading' | 'unavailable' | 'off' | 'on'.
 * Off is the default and general chat works in every state. 44px touch targets; state is conveyed by text, not colour alone.
 */
export default function PersonalizationBar({ status, busy = false, onEnable, onDisable }) {
  if (status === 'loading') return null;
  if (status === 'unavailable') return h('p', { className: 'border-b border-dark-700 px-4 py-2 text-xs text-dark-400' }, YAHOO_AI_UNAVAILABLE);
  const on = status === 'on';
  return h('div', { className: 'flex flex-wrap items-center justify-between gap-2 border-b border-dark-700 px-4 py-3' },
    h('p', { className: `text-sm ${on ? 'text-green-400' : 'text-dark-300'}`, 'aria-live': 'polite' },
      on ? 'Personalized: parts of your league are sent to Google Gemini with each league question.' : 'Personalize with my Yahoo league: Off'),
    h('button', {
      type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', disabled: busy, onClick: on ? onDisable : onEnable,
      className: 'btn-secondary min-h-[44px] shrink-0 disabled:opacity-50',
    }, on ? 'Turn off' : 'Turn on…'));
}
