/**
 * Labels for the shared ProGM Rank. A rank that is only relative to the
 * players currently available must never read as the stable ProGM Rank.
 */
export const RELATIVE_SCOPE = 'available_players';

export function rankLabel(scope) {
  return scope === RELATIVE_SCOPE ? 'Rank (avail.)' : 'ProGM Rank';
}

export function rankTitle(scope) {
  return scope === RELATIVE_SCOPE
    ? 'Rank among the players currently available. It can change as players are drafted or added.'
    : 'ProGM Rank: season value, expected games, positional replacement and scarcity. Same in Rankings and Draft Helper; ignores your roster; stable as other teams draft.';
}

/** Draft Helper sort buttons: ProGM Rank first (default), then Yahoo comparisons. */
export function draftSortButtons(scope) {
  return [['progm', rankLabel(scope), rankTitle(scope)]];
}

/** Rankings tab sort columns; the rank sort is only offered when ranks exist. */
export function rankingsRankColumn(scope, hasRanks) {
  return hasRanks ? ['overall', rankLabel(scope)] : null;
}
