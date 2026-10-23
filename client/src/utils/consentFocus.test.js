import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapConsentFocus } from './consentFocus.js';

function dom() {
  const listeners = new Map();
  const doc = { body: { style: { overflow: 'auto' } }, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) };
  const element = () => ({ disabled: false, hidden: false, isConnected: true, getAttribute: () => null, getClientRects: () => [1], focus() { doc.activeElement = this; listeners.get('focusin')?.({ target: this }); } });
  const opener = element(); const first = element(); const last = element();
  const dialog = Object.assign(element(), { ownerDocument: doc, contains: (el) => [dialog, first, last].includes(el), querySelectorAll: () => [first, last].filter((el) => !el.disabled) });
  opener.focus();
  const key = (name, shiftKey = false) => { const e = { key: name, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; listeners.get('keydown')?.(e); return e; };
  return { doc, listeners, opener, first, last, dialog, key };
}

test('consent focus enters the dialog, wraps Tab/Shift+Tab, and redirects outside focus', () => {
  const d = dom(); const cleanup = trapConsentFocus(d.dialog);
  assert.equal(d.doc.activeElement, d.dialog); assert.equal(d.doc.body.style.overflow, 'hidden');
  assert.equal(d.key('Tab').prevented, true); assert.equal(d.doc.activeElement, d.first);
  d.key('Tab', true); assert.equal(d.doc.activeElement, d.last);
  d.key('Tab'); assert.equal(d.doc.activeElement, d.first);
  d.opener.focus(); assert.equal(d.doc.activeElement, d.first);
  cleanup(); assert.equal(d.doc.activeElement, d.opener); assert.equal(d.doc.body.style.overflow, 'auto'); assert.equal(d.listeners.size, 0);
});

test('busy consent dialog traps focus with disabled controls and cannot be cancelled by Escape', () => {
  const d = dom(); let busy = true; let cancelled = 0;
  const cleanup = trapConsentFocus(d.dialog, { isBusy: () => busy, onCancel: () => cancelled++ });
  d.first.disabled = true; d.last.disabled = true;
  d.key('Tab'); assert.equal(d.doc.activeElement, d.dialog);
  d.key('Escape'); assert.equal(cancelled, 0);
  busy = false; d.key('Escape'); assert.equal(cancelled, 1);
  cleanup();
});

test('hidden controls are skipped and closing does not focus a removed opener', () => {
  const d = dom(); const cleanup = trapConsentFocus(d.dialog);
  d.first.hidden = true; d.key('Tab'); assert.equal(d.doc.activeElement, d.last);
  d.opener.isConnected = false; cleanup(); assert.notEqual(d.doc.activeElement, d.opener);
});
