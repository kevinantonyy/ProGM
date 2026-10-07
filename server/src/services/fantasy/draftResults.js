/**
 * Yahoo draft-results normalizer + pure live-draft helpers.
 *
 * Yahoo `/league/{key}/draftresults` returns the draft board as a numeric-keyed
 * collection under fantasy_content.league[1].draft_results, each item wrapping a
 * `draft_result` object: { pick, round, team_key, player_key }. For leagues that
 * have not drafted yet the collection is empty.
 *
 * These functions are PURE (no network) so pick detection, de-duplication and
 * availability removal are fully unit-testable. The route layer handles fetching
 * and polling. Nothing here is fabricated — a field Yahoo omits stays null.
 */
import { yahooCollection, mergeYahooProps } from './normalize.js';

/**
 * Extract normalized draft picks from a Yahoo draftresults response.
 * @returns {Array<{ pick:number|null, round:number|null, teamKey:string|null, playerKey:string|null }>}
 *          sorted ascending by pick number (picks without a number sort last).
 */
export function extractDraftResults(response) {
  const league = response?.fantasy_content?.league;
  if (!Array.isArray(league)) return [];
  const node = league.find((el) => el && el.draft_results)?.draft_results;
  const picks = yahooCollection(node)
    .map((entry) => entry?.draft_result)
    .filter(Boolean)
    .map((d) => {
      const m = mergeYahooProps(d);
      const pick = m.pick != null && m.pick !== '' ? Number(m.pick) : null;
      const round = m.round != null && m.round !== '' ? Number(m.round) : null;
      return {
        pick: Number.isFinite(pick) ? pick : null,
        round: Number.isFinite(round) ? round : null,
        teamKey: m.team_key || null,
        playerKey: m.player_key || null,
      };
    })
    // A pick is only meaningful once a player_key is assigned.
    .filter((d) => d.playerKey);
  return picks.sort((a, b) => (a.pick ?? Infinity) - (b.pick ?? Infinity));
}

/**
 * De-duplicate picks by player_key (a reconnect/refresh can re-deliver the same
 * pick). Keeps the lowest pick number for a player — the real selection.
 */
export function dedupePicks(picks) {
  const byPlayer = new Map();
  for (const p of picks || []) {
    if (!p.playerKey) continue;
    const prev = byPlayer.get(p.playerKey);
    if (!prev || (p.pick ?? Infinity) < (prev.pick ?? Infinity)) byPlayer.set(p.playerKey, p);
  }
  return [...byPlayer.values()].sort((a, b) => (a.pick ?? Infinity) - (b.pick ?? Infinity));
}

/**
 * Compare a previous and current pick list and return only the NEW picks
 * (by player_key), so the UI can surface "just drafted" without re-processing
 * the whole board. Deterministic + idempotent across reconnects.
 *
 * @param {Array} previousPicks
 * @param {Array} currentPicks
 * @returns {{ newPicks:Array, allPicks:Array, totalPicks:number }}
 */
export function detectNewPicks(previousPicks, currentPicks) {
  const prevKeys = new Set((previousPicks || []).map((p) => p.playerKey));
  const all = dedupePicks(currentPicks);
  const newPicks = all.filter((p) => !prevKeys.has(p.playerKey));
  return { newPicks, allPicks: all, totalPicks: all.length };
}

/** Set of drafted player_keys from a pick list (for fast availability checks). */
export function draftedPlayerKeys(picks) {
  return new Set((picks || []).map((p) => p.playerKey).filter(Boolean));
}

/**
 * Remove drafted players from an available pool immediately.
 * @param {Array} availablePlayers  normalized players (have playerKey)
 * @param {Set<string>} draftedKeys
 */
export function removeDrafted(availablePlayers, draftedKeys) {
  if (!draftedKeys || draftedKeys.size === 0) return availablePlayers || [];
  return (availablePlayers || []).filter((p) => !draftedKeys.has(p.playerKey));
}

/**
 * Derive a draft lifecycle status from settings + picks.
 *   - 'predraft'  : draft hasn't started (no picks, draft_status not post)
 *   - 'live'      : picks exist but not all made
 *   - 'complete'  : draft_status === 'postdraft' OR every pick slot filled
 * draftStatus comes from Yahoo league settings (draft_status) when available.
 *
 * @param {Object} params
 * @param {string|null} params.yahooDraftStatus   league.draft_status ('predraft'|'drafting'|'postdraft')
 * @param {number} params.totalPicks
 * @param {number|null} params.expectedPicks       numTeams × roster size (when known)
 */
export function deriveDraftState({ yahooDraftStatus, totalPicks, expectedPicks }) {
  if (yahooDraftStatus === 'postdraft') return 'complete';
  if (expectedPicks && totalPicks >= expectedPicks && expectedPicks > 0) return 'complete';
  if (yahooDraftStatus === 'drafting') return 'live';
  if (totalPicks > 0) return 'live';
  return 'predraft';
}

/** Picks belonging to a specific team (the user's roster-so-far during a draft). */
export function picksForTeam(picks, teamKey) {
  return (picks || []).filter((p) => p.teamKey === teamKey);
}

/**
 * Derive the user's next overall pick in a SNAKE draft, reliably or not at all.
 *
 * A snake draft alternates direction each round. If we know the user's draft
 * SLOT (their 1-based position in round 1) and the team count, the next pick
 * after `currentPick` is deterministic. We derive the slot from the user's
 * FIRST actual pick in draftresults (its overall pick number in round 1), which
 * is the only reliable signal — Yahoo does not expose a draft-order resource we
 * depend on. If any input is missing/inconsistent we return null so the caller
 * OMITS DRAFT NOW/WAIT rather than inventing a next pick.
 *
 * @param {Object} params
 * @param {Array} params.myPicks       the user's picks so far (pick numbers)
 * @param {number|null} params.numTeams
 * @param {number} params.currentPick  the next overall pick about to be made
 * @returns {number|null} the user's next overall pick strictly after currentPick, or null
 */
export function deriveNextPick({ myPicks, numTeams, currentPick }) {
  const n = Number(numTeams);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (!Number.isInteger(currentPick) || currentPick < 1) return null;

  // Need the user's round-1 slot. Prefer an explicit round-1 pick; otherwise
  // infer from any pick whose round we can trust.
  const picksWithNums = (myPicks || []).filter((p) => Number.isInteger(p.pick) && p.pick >= 1);
  if (!picksWithNums.length) return null;

  const firstOverall = Math.min(...picksWithNums.map((p) => p.pick));
  // In a snake draft, round 1 is picks 1..n, so the slot is simply the first
  // overall pick IF that pick is in round 1. If the user's earliest known pick
  // is not in round 1 we cannot reliably recover the slot -> null.
  if (firstOverall > n) return null;
  const slot = firstOverall; // 1-based slot in round 1

  // Overall pick for this user in round r (1-based), snake order:
  //   odd round  r: (r-1)*n + slot
  //   even round r: (r-1)*n + (n - slot + 1)
  const pickInRound = (r) => (r % 2 === 1 ? (r - 1) * n + slot : (r - 1) * n + (n - slot + 1));

  // Find the smallest round whose pick is strictly greater than currentPick.
  // (currentPick is the pick about to be made; "next" is the user's upcoming one.)
  for (let r = 1; r <= 50; r += 1) {
    const overall = pickInRound(r);
    if (overall >= currentPick) return overall;
  }
  return null;
}
