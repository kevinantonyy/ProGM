import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import YahooAttribution, { YAHOO_FANTASY_LOGO_URL, YAHOO_ATTRIBUTION_TEXT, YAHOO_LINK_URL, YAHOO_FANTASY_LINK_URL, TRIM_EMPTY_MARGIN } from './YahooAttribution.js';

const html = (props) => renderToStaticMarkup(createElement(YahooAttribution, props));

test('shows the required wording exactly and the official logo from the URL Yahoo publishes', () => {
  const out = html({});
  assert.equal(YAHOO_ATTRIBUTION_TEXT, 'Fantasy data provided by Yahoo Fantasy');
  assert.ok(out.includes('Fantasy data provided by Yahoo Fantasy'));
  assert.ok(out.includes(`src="${YAHOO_FANTASY_LOGO_URL}"`));
  assert.match(YAHOO_FANTASY_LOGO_URL, /^https:\/\/763445962456-brand-assets\.s3\.us-west-2\.amazonaws\.com\/brandwebsite\/s3fs-public\/Yahoo_Fantasy\.svg$/);
});

test('the logo links to Yahoo safely and has an accessible name', () => {
  const out = html({});
  assert.equal(YAHOO_LINK_URL, 'https://www.yahoo.com/?ilc=401');
  assert.ok(out.includes(`href="${YAHOO_LINK_URL.replace(/&/g, '&amp;')}"`));
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /alt="Yahoo Fantasy"/);
  assert.match(out, /aria-label="Yahoo Fantasy/);
  assert.match(out, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
});

test('the required attribution sentence links back to Fantasy without changing the general YDN logo destination', () => {
  const out = html({});
  assert.equal(YAHOO_FANTASY_LINK_URL, 'https://sports.yahoo.com/fantasy/');
  assert.ok(out.includes(`href="${YAHOO_FANTASY_LINK_URL}"`));
  assert.ok(out.includes(`href="${YAHOO_LINK_URL}"`));
  assert.equal((out.match(/<a /g) || []).length, 2);
});

test('the logo is not altered: no filters, recoloring, rotation or extra elements, and it sits on a plain white plate', () => {
  const out = html({ size: 'sm' });
  assert.doesNotMatch(out, /filter|invert|grayscale|brightness|opacity|rotate|scale-|blur|shadow|drop-shadow|mix-blend|hue/i);
  assert.match(out, /bg-white/);
  assert.equal((out.match(/<img /g) || []).length, 1);
  assert.equal((out.match(/<svg/g) || []).length, 0, 'no homemade or inline logo');
});

test('the full official canvas is shown as provided: square, uniformly scaled, no cropping', () => {
  assert.equal(TRIM_EMPTY_MARGIN, false);
  for (const size of ['sm', 'md']) {
    const out = html({ size });
    assert.match(out, /class="(h-28 w-28|h-36 w-36) block"/);
    assert.doesNotMatch(out, /object-cover|object-fill|object-none|aspect-|skew|translate|overflow-hidden/);
    const [h, w] = [out.match(/h-(\d+)/)[1], out.match(/ w-(\d+)/)[1]];
    assert.equal(h, w, 'equal height and width: the canvas keeps its 1:1 proportions');
  }
});

test('logo-only mode omits the sentence but keeps the logo and link', () => {
  const out = html({ showText: false });
  assert.doesNotMatch(out, /Fantasy data provided/);
  assert.match(out, /<img /);
  assert.match(out, /<a /);
});

test('renders no network-backed script and is purely presentational', () => {
  const out = html({ className: 'mt-4' });
  assert.doesNotMatch(out, /<script|onclick/i);
  assert.match(out, /class="inline-flex flex-wrap items-center gap-x-3 gap-y-2 mt-4"/);
});
