import { createElement } from 'react';

/** Completed-draft screen. The Draft Preview button exists only when the server enabled it (onOpenPreview given). Plain JS so it is unit-testable. */
export default function DraftCompleted({ leagueName, onOpenRoster, onOpenPreview }) {
  return createElement('section', { className: 'card mx-auto max-w-2xl py-10 text-center', 'aria-labelledby': 'draft-complete-title' },
    createElement('p', { className: 'text-5xl', 'aria-hidden': 'true' }, '🏀'),
    createElement('h2', { id: 'draft-complete-title', className: 'mt-4 font-display text-3xl font-black' }, 'Your League Has Finished Drafting!'),
    createElement('p', { className: 'mx-auto mt-3 max-w-lg text-sm leading-6 text-dark-300' },
      `${leagueName ? `${leagueName} has completed its draft` : 'Your league has completed its draft'}, so the Draft Helper is retired for this season. Head to your team to set your lineup, then use Waivers, Trades and Start / Sit to improve your roster.`),
    createElement('div', { className: 'mt-6 flex flex-wrap items-center justify-center gap-3' },
      createElement('button', { type: 'button', onClick: onOpenRoster, className: 'btn-primary' }, 'View My Roster'),
      onOpenPreview && createElement('button', { type: 'button', onClick: onOpenPreview, className: 'rounded-lg border border-dark-600 bg-dark-800 px-4 py-2 text-sm font-semibold text-dark-100 hover:border-primary-500', 'data-testid': 'draft-preview-button' }, 'Draft Preview')),
    onOpenPreview && createElement('p', { className: 'mx-auto mt-3 max-w-md text-xs text-dark-400' }, 'Preview ProGM\'s rankings for every player in your league. Read-only; not a live draft.'));
}

/** What DraftHelper passes: a handler only when the server's workspace payload carries draftPreview.enabled. */
export function previewOpener(data, open) {
  return data?.draftPreview?.enabled === true ? open : undefined;
}
