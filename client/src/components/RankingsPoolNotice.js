import { createElement } from 'react';

/**
 * Pool banner for the full-pool Rankings tab. A partial pool is NEVER presented as complete: when the server could not verify
 * the pool, this says so and lists why. Even a verified pool states its scope. Plain JS so it is unit-testable.
 */
export default function RankingsPoolNotice({ pool, total }) {
  if (!pool) return null;
  const counts = pool.counts || {};
  const warnings = Array.isArray(pool.warnings) ? pool.warnings : [];
  const limitations = Array.isArray(pool.limitations) ? pool.limitations : [];
  const children = [];
  if (pool.complete === true) {
    children.push(createElement('p', { key: 'scope', className: 'text-dark-200', 'data-testid': 'rankings-pool-complete' },
      `Full league pool: ${total ?? counts.total ?? '?'} players (${counts.available ?? '?'} available, ${counts.rostered ?? '?'} on other teams, ${counts.mine ?? '?'} on your team). Every team's roster loaded (${counts.teamsLoaded ?? '?'} of ${counts.teamsExpected ?? '?'}).`));
  } else {
    children.push(createElement('p', { key: 'partial', className: 'font-semibold text-accent-orange', 'data-testid': 'rankings-pool-partial' },
      'Partial player pool: some players could not be loaded or verified. These ranks are relative to the players ProGM could load and are NOT full-league ranks.'));
    const reasons = Array.isArray(pool.reasons) && pool.reasons.length ? pool.reasons : ['No completeness information was returned.'];
    children.push(createElement('ul', { key: 'reasons', className: 'list-disc pl-5 text-dark-300' }, ...reasons.map((reason) => createElement('li', { key: reason }, reason))));
  }
  if (warnings.length) children.push(createElement('ul', { key: 'warnings', className: 'list-disc pl-5 text-dark-400', 'data-testid': 'rankings-pool-warnings' }, ...warnings.map((warning) => createElement('li', { key: warning }, warning))));
  if (limitations.length) children.push(createElement('p', { key: 'limits', className: 'text-dark-400', 'data-testid': 'rankings-pool-limitation' }, limitations.join(' ')));
  return createElement('section', { className: `card space-y-1 p-3 text-xs leading-5${pool.complete === true ? '' : ' border-orange-500/40'}`, role: pool.complete === true ? undefined : 'alert', 'data-testid': 'rankings-pool-notice' }, ...children);
}
