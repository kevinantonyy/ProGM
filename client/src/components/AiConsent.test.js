import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AiConsentDialog from './AiConsentDialog.js';
import PersonalizationBar from './PersonalizationBar.js';
// The real server text: the dialog must show exactly what the server will record consent for.
import { DISCLOSURE } from '../../../server/src/services/ai/consent.js';

const html = (props) => renderToStaticMarkup(createElement(AiConsentDialog, { disclosure: DISCLOSURE, onAgree() {}, onCancel() {}, ...props }));
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

test('the dialog shows the real disclosure: free-tier training, human review, optional, revocable, Yahoo rules, what is and is not sent', () => {
  const out = decode(html());
  for (const sentence of [DISCLOSURE.title, DISCLOSURE.intro, DISCLOSURE.google, DISCLOSURE.yahoo, DISCLOSURE.optional, DISCLOSURE.revoke, ...DISCLOSURE.sent, ...DISCLOSURE.neverSent]) assert.ok(out.includes(sentence), `missing: ${sentence.slice(0, 50)}`);
  assert.match(out, /may use what is sent to improve its products/);
  assert.match(out, /human reviewers may read it/);
  assert.match(out, /does not remove information Google has already received/);
  assert.match(out, /still being clarified/);
  assert.match(out, /What is sent/);
  assert.match(out, /What is never sent/);
  assert.match(out, /How Google may use it/);
  assert.match(out, /border-accent-orange\/50 bg-accent-orange\/10/, 'warning surface uses theme-aware semantic tokens');
  assert.doesNotMatch(out, /text-amber-(100|300)/, 'warning text must remain readable on the light surface');
});

test('the dialog is an accessible mobile sheet with two clear choices and nothing pre-ticked', () => {
  const out = html();
  assert.match(out, /role="dialog"/);
  assert.match(out, /aria-modal="true"/);
  assert.match(out, /aria-labelledby="ai-consent-title"/);
  assert.match(out, /aria-describedby="ai-consent-intro"/);
  assert.match(out, /max-h-\[90vh\][^"]*overflow-y-auto|overflow-y-auto[^"]*max-h-\[90vh\]/, 'scrolls inside the viewport on a phone');
  assert.match(out, /items-end/, 'bottom sheet on small screens');
  assert.equal((out.match(/min-h-\[44px\]/g) || []).length, 2, 'both buttons are 44px touch targets');
  assert.match(out, new RegExp(`>${DISCLOSURE.agree}<`));
  assert.match(out, new RegExp(`>${DISCLOSURE.decline}<`));
  assert.doesNotMatch(out, /type="checkbox"|checked/, 'no pre-ticked box; consent is an explicit button');
});

test('busy and error states are announced and block double submission', () => {
  const out = html({ busy: true, error: 'Could not save your choice. Nothing was shared.' });
  assert.match(out, /role="alert"/);
  assert.match(out, /Could not save your choice\. Nothing was shared\./);
  assert.match(out, /Saving…/);
  assert.equal((out.match(/disabled=""/g) || []).length, 2);
});

const bar = (props) => renderToStaticMarkup(createElement(PersonalizationBar, { onEnable() {}, onDisable() {}, ...props }));

test('the personalization control: Off by default, plain words, a real switch, 44px', () => {
  assert.equal(bar({ status: 'loading' }), '');
  const unavailable = bar({ status: 'unavailable' });
  assert.match(unavailable, /not available right now/);
  assert.doesNotMatch(unavailable, /button/, 'no way to turn on something that is switched off');
  const off = bar({ status: 'off' });
  assert.match(off, /Personalize with my Yahoo league: Off/);
  assert.match(off, /role="switch"/);
  assert.match(off, /aria-checked="false"/);
  assert.match(off, />Turn on…</);
  assert.match(off, /min-h-\[44px\]/);
  const on = bar({ status: 'on' });
  assert.match(on, /aria-checked="true"/);
  assert.match(on, />Turn off</);
  assert.match(on, /sent to Google Gemini/);
  assert.match(on, /text-green-400/, 'enabled notice uses the light/dark semantic green');
  assert.match(bar({ status: 'on', busy: true }), /disabled=""/);
});
