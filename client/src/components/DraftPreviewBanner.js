import { createElement } from 'react';

export const PREVIEW_DISCLAIMER = 'Draft Preview: this is not a live draft. It is a read-only view of ProGM\'s rankings for every player in your league, drafted or not, using your league\'s scoring settings. Nothing is sent to Yahoo.';

/** Preview label plus a verified / unverified player-pool notice. Plain JS so it is unit-testable. */
export default function DraftPreviewBanner({ completeness, projection }) {
  const noProjections = projection != null && projection.projectedCount === 0;
  const complete = completeness?.complete === true;
  const counts = completeness?.counts;
  return createElement('section', { className: `card space-y-2 p-3 text-sm sm:p-4${complete ? '' : ' border-orange-500/40'}`, 'data-testid': 'draft-preview-banner' },
    createElement('p', { key: 'label', className: 'font-semibold text-dark-100' }, PREVIEW_DISCLAIMER),
    complete
      ? createElement('p', { key: 'pool', className: 'text-xs text-dark-300', 'data-testid': 'preview-pool-verified' }, `Full player pool verified: ${counts?.total ?? 'all'} players (${counts?.taken ?? '?'} taken, ${counts?.available ?? '?'} free agents), including every player in your draft results. Ranks are full-pool ranks.`)
      : createElement('div', { key: 'pool', role: 'alert', 'data-testid': 'preview-pool-warning', className: 'space-y-1 text-xs' },
        createElement('p', { className: 'font-semibold text-accent-orange' }, 'The player pool could not be verified as complete. These rankings cover only the players ProGM could load and are NOT full-pool rankings; ranks are relative to that partial list.'),
        createElement('ul', { className: 'list-disc pl-5 text-dark-300' }, ...(completeness?.reasons?.length ? completeness.reasons : ['No completeness information was returned.']).map((reason) => createElement('li', { key: reason }, reason)))),
    noProjections && createElement('div', { key: 'noProjections', role: 'alert', 'data-testid': 'preview-no-projections', className: 'space-y-1 rounded-lg border border-orange-500/40 p-3 text-xs' },
      createElement('p', { className: 'font-semibold text-accent-orange' }, `No players could be ranked: none of the ${projection.totalPlayers ?? 'listed'} players received a projection. The list below is Yahoo's player pool only; ProGM ranks and projected points are unavailable.`),
      createElement('p', { className: 'text-dark-300' }, projection.reason || 'The NBA stats data needed for projections is unavailable.'),
      createElement('p', { className: 'text-dark-400' }, 'This is a projection-data problem, not a problem with Yahoo or your league settings. Try again in a few minutes.')),
    completeness?.warnings?.length > 0 && createElement('ul', { key: 'warnings', className: 'list-disc pl-5 text-xs text-accent-orange', 'data-testid': 'preview-warnings' }, ...completeness.warnings.map((w) => createElement('li', { key: w }, w))));
}
