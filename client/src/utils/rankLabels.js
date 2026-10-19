/**
 * Labels for the shared ProGM Rank. A rank that is only relative to the
 * players currently available must never read as the stable ProGM Rank.
 */
export const RELATIVE_SCOPE = 'available_players';
// Full-pool Rankings whose pool could NOT be verified as complete: ranks are relative to the players that were loaded.
export const PARTIAL_SCOPE = 'partial_pool';

export function rankLabel(scope) {
  if (scope === PARTIAL_SCOPE) return 'Rank (partial)';
  return scope === RELATIVE_SCOPE ? 'Rank (avail.)' : 'ProGM Rank';
}

export function rankTitle(scope) {
  if (scope === PARTIAL_SCOPE) return 'Rank among the players ProGM could load. The player pool was not verified as complete, so this is not a full-league ProGM Rank.';
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
