/**
 * Draft phase from Yahoo's own league draft_status (already part of the cached
 * league settings): 'predraft' | 'drafting' | 'postdraft'.
 *
 * Completion is NEVER inferred from the draft date, an empty player pool or a
 * pick count. Anything missing or unrecognised is 'unknown', and the normal
 * Draft Helper is shown for it.
 */
export function resolveDraftPhase({ yahooDraftStatus } = {}) {
  const status = typeof yahooDraftStatus === 'string' ? yahooDraftStatus.trim().toLowerCase() : '';
  if (status === 'postdraft') return 'completed';
  if (status === 'drafting') return 'active';
  if (status === 'predraft') return 'predraft';
  return 'unknown';
}

export function isDraftCompleted(input) {
  return resolveDraftPhase(input) === 'completed';
}
