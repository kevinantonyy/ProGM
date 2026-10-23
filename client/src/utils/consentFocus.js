/** Install and remove one dialog's keyboard/focus boundary. Kept DOM-only for browser and unit testing. */
export function trapConsentFocus(dialog, { onCancel, isBusy = () => false } = {}) {
  const doc = dialog.ownerDocument;
  const opener = doc.activeElement;
  const previousOverflow = doc.body.style.overflow;
  const items = () => [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0);
  const focusFirst = () => (items()[0] || dialog).focus();
  const focusIn = (event) => { if (!dialog.contains(event.target)) focusFirst(); };
  const keydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!isBusy()) onCancel?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = items();
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(doc.activeElement) || doc.activeElement === dialog) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  doc.body.style.overflow = 'hidden';
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('focusin', focusIn, true);
  dialog.focus();
  return () => {
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('focusin', focusIn, true);
    doc.body.style.overflow = previousOverflow;
    if (opener?.isConnected !== false) opener?.focus?.();
  };
}
