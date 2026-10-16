import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import PlayerStatusBadge, { DraftStatusNotice } from '../components/PlayerStatusBadge.js';
import { STATUS_STALE_AFTER_MS, leagueAvailabilityLabel, statusBadge, statusFreshness, statusNotices } from './playerStatus.js';

const AT = '2026-10-16T07:00:00.000Z'; const NOW = Date.parse(AT);
const st = (code, state, extra = {}) => ({ code, state, label: null, note: null, source: 'yahoo', observedAt: AT, ...extra });
const html = (status) => renderToStaticMarkup(createElement(PlayerStatusBadge, { status }));

test('NA, O, INJ and Q are visible with their Yahoo code; inactive looks different from out', () => {
  const na = statusBadge(st('NA', 'inactive', { label: 'Not active' }));
  const o = statusBadge(st('O', 'out', { label: 'Out' }));
  const inj = statusBadge(st('INJ', 'out', { label: 'Injured' }));
  const q = statusBadge(st('Q', 'questionable', { label: 'Questionable' }));
  assert.deepEqual([na.text, o.text, inj.text, q.text], ['NA · Not active', 'O · Out', 'INJ · Injured', 'Q · Questionable']);
  assert.notEqual(na.className, o.className); assert.equal(o.className, 'badge-red'); assert.equal(q.className, 'badge-orange');
  assert.match(na.title, /does not say why/); assert.match(na.title, /not necessarily an injury/);
  for (const s of [st('NA', 'inactive'), st('INJ', 'out')]) assert.ok(html(s).includes('data-testid="player-status-badge"'));
});

test('no designation renders nothing and is never labelled healthy; an unrecognised code is "unknown", not healthy', () => {
  for (const s of [st(null, 'none'), null, undefined]) { assert.equal(statusBadge(s), null); assert.equal(html(s), ''); }
  const u = statusBadge(st('XYZ', 'unknown', { label: 'XYZ' }));
  assert.equal(u.text, 'XYZ · Unrecognised'); assert.match(u.title, /status as unknown/);
  assert.equal(statusBadge(st('ZZ', 'some-future-state')).state, 'unknown');
  assert.ok(!/healthy/i.test(html(st('XYZ', 'unknown'))));
});

test('stale data: fetch time older than the window, or missing, is flagged; missing is never treated as fresh', () => {
  assert.equal(statusFreshness(AT, NOW), 'fresh');
  assert.equal(statusFreshness(AT, NOW + STATUS_STALE_AFTER_MS), 'fresh');
  assert.equal(statusFreshness(AT, NOW + STATUS_STALE_AFTER_MS + 1), 'stale');
  for (const v of [null, undefined, '', 'not a date']) assert.equal(statusFreshness(v, NOW), 'unknown');
  const stale = statusNotices({ observedAt: AT, warning: null }, NOW + 9 * 3600000);
  assert.deepEqual(stale.map((n) => n.kind), ['stale']); assert.match(stale[0].text, /about 9 hours ago/);
  assert.match(statusNotices({ observedAt: null, warning: null }, NOW)[0].text, /fetched is unknown/);
  assert.match(statusBadge(st('O', 'out', { observedAt: null })).title, /Fetch time unknown/);
});

test('missing injury data: the server warning is shown above the board, alongside the legend', () => {
  const warning = 'External injury reports are unavailable, ... not confirmed healthy.';
  const out = renderToStaticMarkup(createElement(DraftStatusNotice, { statusData: { observedAt: new Date().toISOString(), warning } }));
  assert.ok(out.includes(warning)); assert.ok(out.includes('data-kind="warning"')); assert.ok(out.includes('does not confirm the player is healthy'));
  const clean = renderToStaticMarkup(createElement(DraftStatusNotice, { statusData: { observedAt: new Date().toISOString(), warning: null } }));
  assert.ok(!clean.includes('data-kind=')); assert.ok(clean.includes('No badge means'));
  assert.equal(renderToStaticMarkup(createElement(DraftStatusNotice, { statusData: undefined })), '', 'flag off: nothing rendered');
});

test('league availability wording never implies health', () => {
  assert.equal(leagueAvailabilityLabel('available'), 'Not rostered in your league');
  assert.equal(leagueAvailabilityLabel('rostered'), 'Rostered in your league');
  assert.equal(leagueAvailabilityLabel(undefined), 'League availability unknown');
});

test('freshness respects stale-cache signals and treats future/unknown timestamps conservatively', () => {
  assert.equal(statusFreshness(new Date(NOW + 1000).toISOString(), NOW), 'unknown');
  const notices = statusNotices({ observedAt: AT, stale: true }, NOW);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /cached designations/);
});

test('warning uses the adaptive semantic theme color', () => {
  const out = renderToStaticMarkup(createElement(DraftStatusNotice, { statusData: { observedAt: AT, warning: 'Unavailable' } }));
  assert.match(out, /text-accent-orange/);
  assert.ok(!out.includes('text-orange-300'));
});

test('status badge and notice colors meet normal-text contrast in both themes', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  assert.match(css, /\.player-status-badge\s*\{[^}]*background: rgb\(var\(--dark-800\)\)/);
  assert.match(html(st('Q', 'questionable')), /player-status-badge/);
  const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const color = (root, token) => new RegExp(`--${token}:\\s*([\\d ]+)`).exec(root)[1].trim().split(/\s+/).map(Number);
  const luminance = (rgb) => rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.equal(roots.length, 2);
  for (const [index, root] of roots.entries()) {
    const surface = color(root, 'dark-800');
    for (const semantic of ['red', 'orange']) {
      const foreground = color(root, `semantic-${semantic}`);
      const badgeRatio = contrast(foreground, surface);
      assert.ok(badgeRatio >= 4.5, `theme ${index} ${semantic} badge contrast: ${badgeRatio}`);
      assert.ok(contrast(foreground, surface) >= 4.5, `theme ${index} ${semantic} notice contrast`);
    }
    assert.ok(contrast(color(root, 'dark-300'), surface) >= 4.5);
    assert.ok(contrast(color(root, 'dark-400'), surface) >= 4.5);
  }
});
