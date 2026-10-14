import { createHash } from 'node:crypto';

/**
 * Frozen normalization reference for the shared ProGM Overall Rank.
 *
 * Overall Rank is relative to a player pool (pool maximum, positional
 * replacement baselines, scarcity, and the sorted list of baseline values).
 * While other teams draft, the visible pool shrinks, which would shift ranks.
 * The reference captured while the full pool is visible (pre-draft) is reused
 * for the rest of the draft, so baseline ranks stay put. It is stored in the
 * existing in-memory cache (cleared on restart; ranks then fall back to
 * "relative to available players").
 */
export const REFERENCE_TTL_MS = 12 * 60 * 60 * 1000;

function scoringSignature(statCategories) {
  const weighted = (statCategories || [])
    .filter((c) => c && c.enabled !== false && c.pointValue != null)
    .map((c) => `${c.statId}:${c.pointValue}`)
    .sort();
  return createHash('sha1').update(weighted.join('|')).digest('hex').slice(0, 12);
}

export function referenceKey({ leagueKey, season, statCategories }) {
  return `bball:overall-ref:${leagueKey}:${season ?? 'na'}:${scoringSignature(statCategories)}`;
}

export function loadBaselineReference(cache, key) {
  const hit = cache?.get?.(key);
  return hit && !hit.meta?.stale ? hit.value : null;
}

/** Only a complete-pool reference is worth freezing. */
export function saveBaselineReference(cache, key, reference) {
  if (!cache?.set || !reference?.complete) return;
  if (loadBaselineReference(cache, key)) return; // first complete capture wins
  cache.set(key, reference, { provider: 'progm', ttl: REFERENCE_TTL_MS });
}
