import { createElement as h, useEffect, useRef } from 'react';
import { trapConsentFocus } from '../utils/consentFocus.js';

/**
 * Consent dialog for sending part of a Yahoo league to Google Gemini. All wording comes from the SERVER (`disclosure`), so the version the
 * user agrees to is the version the server records. Plain JS (createElement) so it is unit-testable like the other shared components.
 *
 * Mobile: bottom sheet that scrolls (max 90% of the viewport), full-width 44px buttons, no hover-only controls. Accessibility: role=dialog,
 * aria-modal, labelled and described, focus moves into the dialog, Escape and "Not now" decline, focus returns to the opener.
 */
const list = (items) => h('ul', { className: 'mt-2 list-disc space-y-1 pl-5 text-sm text-dark-200' }, items.map((t) => h('li', { key: t }, t)));

export default function AiConsentDialog({ disclosure, busy = false, error = '', onAgree, onCancel }) {
  const ref = useRef(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;
  useEffect(() => {
    return trapConsentFocus(ref.current, { onCancel: () => cancelRef.current?.(), isBusy: () => busyRef.current });
  }, []);

  const d = disclosure;
  return h('div', { className: 'fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4', onClick: (e) => { if (!busy && e.target === e.currentTarget) onCancel?.(); } },
    h('div', { ref, role: 'dialog', 'aria-modal': 'true', 'aria-busy': busy, 'aria-labelledby': 'ai-consent-title', 'aria-describedby': 'ai-consent-intro', tabIndex: -1, className: 'max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-dark-600 bg-dark-800 p-5 shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:max-w-lg sm:rounded-2xl' },
      h('h2', { id: 'ai-consent-title', className: 'text-xl font-bold' }, d.title),
      h('p', { id: 'ai-consent-intro', className: 'mt-2 text-sm leading-6 text-dark-200' }, d.intro),
      h('h3', { className: 'mt-4 text-sm font-bold uppercase tracking-wide text-primary-400' }, 'What is sent'), list(d.sent),
      h('h3', { className: 'mt-4 text-sm font-bold uppercase tracking-wide text-green-400' }, 'What is never sent'), list(d.neverSent),
      h('div', { className: 'mt-4 rounded-lg border border-accent-orange/50 bg-accent-orange/10 p-3' },
        h('h3', { className: 'text-sm font-bold uppercase tracking-wide text-dark-50' }, 'How Google may use it'),
        h('p', { className: 'mt-1 text-sm leading-6 text-dark-200' }, d.google)),
      h('p', { className: 'mt-4 text-sm leading-6 text-dark-300' }, d.yahoo),
      h('p', { className: 'mt-3 text-sm leading-6 text-dark-300' }, d.optional),
      h('p', { className: 'mt-3 text-sm leading-6 text-dark-300' }, d.revoke),
      error ? h('p', { role: 'alert', className: 'mt-3 rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-400' }, error) : null,
      h('div', { className: 'mt-5 flex flex-col gap-2 sm:flex-row-reverse' },
        h('button', { type: 'button', onClick: onAgree, disabled: busy, className: 'btn-primary min-h-[44px] w-full disabled:opacity-50 sm:w-auto' }, busy ? 'Saving…' : d.agree),
        h('button', { type: 'button', onClick: onCancel, disabled: busy, className: 'btn-secondary min-h-[44px] w-full sm:w-auto' }, d.decline))));
}
