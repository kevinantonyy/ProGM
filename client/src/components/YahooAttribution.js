import { createElement } from 'react';

/**
 * Yahoo Fantasy Sports API attribution (one reusable component).
 *
 * Yahoo's Fantasy developer page ("Attribution requirements", https://sports.yahoo.com/developer) asks for:
 *   - the text "Fantasy data provided by Yahoo Fantasy" in products that link back to Yahoo Fantasy, and
 *   - the official Yahoo Fantasy logo, used only as provided, whenever Yahoo Fantasy Sports API information is referenced or used.
 * Yahoo's general API attribution guidelines (https://developer.yahoo.com/attribution/) link the Yahoo logo to https://www.yahoo.com/?ilc=401.
 *
 * Logo handling, deliberately conservative:
 *   - The official file is referenced at the URL Yahoo itself publishes on its developer page. It is NOT copied into this repository:
 *     nothing Yahoo has published grants a right to redistribute or self-host it (the API terms reserve all rights not expressly granted).
 *     Once Yahoo confirms in writing that bundling is allowed, change YAHOO_FANTASY_LOGO_URL to a bundled copy; nothing else changes.
 *   - The image is rendered unmodified: no recoloring, filters, effects, rotation, stretching or added elements.
 *   - The official file is a square canvas with the wordmark in a thin band at its centre. It is shown EXACTLY as provided: the full square,
 *     uniformly scaled, with no cropping or trimming (owner decision: TRIM_EMPTY_MARGIN = false). A wide, trimmed frame is available by setting
 *     TRIM_EMPTY_MARGIN to true, but that is not approved by Yahoo's guidelines until Yahoo confirms it.
 *   - The official SVG uses dark and purple fills and is designed for light backgrounds, so it sits on a plain white plate. The plate is
 *     a neutral container around the logo, not part of it, and keeps the logo legible on ProGM's dark theme.
 *   - If the image cannot load, the alt text and the attribution sentence remain.
 *
 * Use this once per Yahoo-powered view, not per row or card. Plain JS so it is unit-testable like the other shared components.
 */
export const YAHOO_FANTASY_LOGO_URL = 'https://763445962456-brand-assets.s3.us-west-2.amazonaws.com/brandwebsite/s3fs-public/Yahoo_Fantasy.svg';
export const YAHOO_ATTRIBUTION_TEXT = 'Fantasy data provided by Yahoo Fantasy';
export const YAHOO_LINK_URL = 'https://www.yahoo.com/?ilc=401';
// Fantasy-specific requirements (https://sports.yahoo.com/developer/, verified 2026-10-20) also ask for a link back to Fantasy.
// Keep the general YDN logo destination above; use the required sentence for the additional Fantasy destination.
export const YAHOO_FANTASY_LINK_URL = 'https://sports.yahoo.com/fantasy/';

export const TRIM_EMPTY_MARGIN = false;
const FRAME = { sm: 'h-10 w-40', md: 'h-14 w-52' };
const SQUARE = { sm: 'h-28 w-28', md: 'h-36 w-36' };

export default function YahooAttribution({ showText = true, size = 'md', className = '' }) {
  const box = (TRIM_EMPTY_MARGIN ? FRAME : SQUARE)[size] || (TRIM_EMPTY_MARGIN ? FRAME : SQUARE).md;
  return createElement('div', { className: `inline-flex flex-wrap items-center gap-x-3 gap-y-2 ${showText ? '' : 'shrink-0 '}${className}`.trim(), 'data-testid': 'yahoo-attribution' },
    createElement('a', {
      key: 'logo', href: YAHOO_LINK_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Yahoo Fantasy (opens yahoo.com in a new tab)',
      className: 'inline-flex shrink-0 rounded bg-white p-1 ring-1 ring-black/10',
    }, createElement('img', { src: YAHOO_FANTASY_LOGO_URL, alt: 'Yahoo Fantasy', className: `${box} block ${TRIM_EMPTY_MARGIN ? 'object-cover object-center' : ''}`.trim(), width: 144, height: 144, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' })),
    showText ? createElement('a', { key: 'text', href: YAHOO_FANTASY_LINK_URL, target: '_blank', rel: 'noopener noreferrer', className: 'text-xs leading-5 text-dark-400 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500', 'aria-label': `${YAHOO_ATTRIBUTION_TEXT} (opens Yahoo Fantasy in a new tab)` }, YAHOO_ATTRIBUTION_TEXT) : null);
}
