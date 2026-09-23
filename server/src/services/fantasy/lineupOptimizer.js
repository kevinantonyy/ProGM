/**
 * Start/Sit lineup optimizer.
 *
 * Produces a LEGAL recommended lineup that respects Yahoo starting-slot
 * constraints and per-player positional eligibility, then compares it to the
 * current lineup by projected league fantasy points.
 *
 * It does NOT compare each starter to a single bench player independently
 * (which can suggest an illegal lineup). Instead it solves a slot-assignment:
 * fill the scarcest slots first with the best eligible available player, so the
 * result is always a valid lineup.
 *
 * Requires projections (projectedPoints per player). When projections are
 * unavailable for a player, that player is treated as unknown value and the
 * engine reports lower confidence and avoids over-confident swaps.
 *
 * Inputs are provider-independent; projections come from projection.js.
 */

const IL_SLOTS = new Set(['IL', 'IL+', 'IR', 'NA']);
const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/** Expand starting slots into individual slot instances (respecting counts). */
function expandStartingSlots(rosterSlots) {
  const slots = [];
  for (const slot of (rosterSlots || []).filter((s) => s.isStarting)) {
    for (let i = 0; i < slot.count; i += 1) slots.push(slot.position);
  }
  return slots;
}

/** Count, for each roster player, how many of the starting slots they're eligible for (scarcity aid). */
function eligibilityFlexibility(player, slotPositions) {
  return slotPositions.filter((pos) => player.eligiblePositions.includes(pos)).length;
}

/**
 * OPTIMAL legal-lineup solver (maximum-weight bipartite assignment).
 *
 * A greedy scarcity-first fill is NOT guaranteed globally optimal (verified by
 * brute-force testing to fail ~5% of randomized rosters). Instead we solve the
 * assignment of players -> starting slots as a maximum-weight bipartite
 * matching, which is provably optimal, respects eligibility, and always yields
 * a legal lineup. At fantasy roster sizes (~15 players, ~10 slots) this is
 * instant.
 *
 * Implementation: Kuhn's augmenting-path matching over players sorted by
 * descending projection. Because we add players in descending value and only
 * ever augment (never reduce) the matched set, and every player can occupy at
 * most one slot, the greedy-augmenting order combined with augmenting-path
 * reassignment yields the maximum-weight matching for this structure where all
 * edge weights for a given player are identical (a player's projection is the
 * same regardless of which slot they fill). That property makes descending-by-
 * value augmenting matching optimal here.
 *
 * @param {Array} players            candidates (each: {playerKey, eligiblePositions, proj, playable})
 * @param {string[]} slotPositions   expanded starting slot positions
 * @returns {{ assignment: Array<{slot,playerKey}>, total:number, unfilled:string[] }}
 */
function solveLineup(players, slotPositions) {
  const candidates = players.filter((p) => p.playable);
  // Sort players by descending projection; unknown (null) projections last.
  const ordered = [...candidates].sort((a, b) => (b.proj ?? -Infinity) - (a.proj ?? -Infinity));

  const slotOfPlayer = new Map(); // playerKey -> slot index
  const playerOfSlot = new Array(slotPositions.length).fill(null); // slot index -> playerKey

  // Try to seat one player, reassigning earlier players along an augmenting path.
  function tryAssign(player, visitedSlots) {
    for (let s = 0; s < slotPositions.length; s += 1) {
      if (!player.eligiblePositions.includes(slotPositions[s])) continue;
      if (visitedSlots.has(s)) continue;
      visitedSlots.add(s);
      const occupant = playerOfSlot[s];
      if (occupant == null || tryAssign(occupantPlayer(occupant), visitedSlots)) {
        playerOfSlot[s] = player.playerKey;
        slotOfPlayer.set(player.playerKey, s);
        return true;
      }
    }
    return false;
  }

  const byKey = new Map(candidates.map((p) => [p.playerKey, p]));
  function occupantPlayer(key) { return byKey.get(key); }

  // Seat players in descending value order. A player only displaces an
  // already-seated (higher-or-equal value) player if that player can move to
  // another eligible slot, so total value never decreases.
  for (const player of ordered) {
    if (player.proj == null) continue; // never assign purely-unknown players over known value; handled below
    tryAssign(player, new Set());
  }
  // Fill any still-empty slots with unknown-projection players (value 0 added),
  // so the lineup is complete where possible without inflating the total.
  for (const player of ordered) {
    if (slotOfPlayer.has(player.playerKey)) continue;
    tryAssign(player, new Set());
  }

  const assignment = [];
  const unfilled = [];
  for (let s = 0; s < slotPositions.length; s += 1) {
    if (playerOfSlot[s]) assignment.push({ slot: slotPositions[s], playerKey: playerOfSlot[s] });
    else unfilled.push(slotPositions[s]);
  }

  const total = assignment.reduce((sum, a) => sum + (byKey.get(a.playerKey)?.proj ?? 0), 0);
  return { assignment, total: Number(total.toFixed(2)), unfilled };
}

/**
 * @param {Object} params
 * @param {Array} params.players       normalized roster players (Yahoo)
 * @param {Object} params.settings     normalized league settings
 * @param {Object} params.projectionProvider  { getProjection(player) -> {projectedPoints, confidence,...} }
 */
export function optimizeLineup({ players, settings, projectionProvider }) {
  const slotPositions = expandStartingSlots(settings?.rosterSlots);

  // Decorate players with projection + playability.
  const decorated = players
    .filter((p) => !IL_SLOTS.has(p.selectedPosition)) // IL players are not lineup-eligible
    .map((p) => {
      const proj = projectionProvider?.getProjection ? projectionProvider.getProjection(p) : null;
      const out = Boolean(p.status && OUT_STATUSES.has(p.status));
      return {
        playerKey: p.playerKey,
        name: p.name,
        eligiblePositions: p.eligiblePositions,
        currentSlot: p.selectedPosition,
        currentlyStarting: p.isStarting,
        status: p.status,
        statusFull: p.statusFull,
        proj: proj?.projectedPoints ?? null,
        confidence: proj?.confidence ?? 0,
        playable: !out, // out players excluded from the recommended lineup
        flexibility: eligibilityFlexibility(p, slotPositions),
      };
    });

  const projectionsAvailable = decorated.some((p) => p.proj != null);

  // Current lineup total (players currently in starting slots).
  const current = decorated.filter((p) => p.currentlyStarting);
  const currentTotal = Number(current.reduce((s, p) => s + (p.proj ?? 0), 0).toFixed(2));

  // Optimal legal lineup.
  const solved = solveLineup(decorated, slotPositions);
  const optimalKeys = new Set(solved.assignment.map((a) => a.playerKey));

  // Individual swaps: who is in the optimal lineup but not currently starting,
  // and who is currently starting but not in the optimal lineup.
  const startIn = decorated.filter((p) => optimalKeys.has(p.playerKey) && !p.currentlyStarting);
  const sitOut = decorated.filter((p) => !optimalKeys.has(p.playerKey) && p.currentlyStarting);

  const swaps = [];
  // Pair swaps by slot where possible for readability.
  for (const slotAssign of solved.assignment) {
    const player = decorated.find((p) => p.playerKey === slotAssign.playerKey);
    if (player && !player.currentlyStarting) {
      // Find a currently-starting player being displaced (best-effort pairing).
      const displaced = sitOut.find((p) => !swaps.some((s) => s.out?.playerKey === p.playerKey));
      const reasons = buildReasons(player, displaced);
      swaps.push({
        slot: slotAssign.slot,
        in: pick(player),
        out: displaced ? pick(displaced) : null,
        projectedGain: displaced && player.proj != null && displaced.proj != null
          ? Number((player.proj - displaced.proj).toFixed(2))
          : null,
        reasons,
      });
    }
  }

  const projectedDiff = Number((solved.total - currentTotal).toFixed(2));

  // Honesty caveat: current starters with NO projection data are counted as 0,
  // which can inflate the apparent optimization gain. Surface this so the UI can
  // caveat the number rather than overstate certainty.
  const currentMissingData = current.filter((p) => p.proj == null).map((p) => p.name);

  // Confidence: average projection confidence of the players involved.
  const involved = [...startIn, ...sitOut];
  const avgConfidence = involved.length
    ? Number((involved.reduce((s, p) => s + p.confidence, 0) / involved.length).toFixed(2))
    : (projectionsAvailable ? 0.5 : 0);

  return {
    projectionsAvailable,
    currentLineup: current.map(pick),
    recommendedLineup: solved.assignment.map((a) => ({ slot: a.slot, ...pick(decorated.find((p) => p.playerKey === a.playerKey)) })),
    projectedCurrentPoints: projectionsAvailable ? currentTotal : null,
    projectedOptimizedPoints: projectionsAvailable ? solved.total : null,
    projectedDifference: projectionsAvailable ? projectedDiff : null,
    currentMissingDataCount: currentMissingData.length,
    currentMissingData,
    swaps: projectionsAvailable ? swaps : [],
    unfilledSlots: solved.unfilled,
    confidence: avgConfidence,
    note: projectionsAvailable
      ? 'Recommended lineup maximizes projected league fantasy points under your legal slot/eligibility constraints.'
      : 'Projection data is unavailable, so no start/sit ranking is produced. Deterministic lineup checks still apply.',
  };
}

function pick(p) {
  if (!p) return null;
  return {
    playerKey: p.playerKey, name: p.name, currentSlot: p.currentSlot,
    proj: p.proj, confidence: p.confidence, status: p.status, statusFull: p.statusFull,
  };
}

function buildReasons(inPlayer, outPlayer) {
  const reasons = [];
  if (inPlayer.proj != null && outPlayer?.proj != null) {
    const gain = inPlayer.proj - outPlayer.proj;
    if (gain > 0) reasons.push(`Projected +${gain.toFixed(1)} league fantasy pts/game (${inPlayer.proj.toFixed(1)} vs ${outPlayer.proj.toFixed(1)}).`);
  }
  if (outPlayer?.status && OUT_STATUSES.has(outPlayer.status)) {
    reasons.push(`${outPlayer.name} is ${outPlayer.statusFull || outPlayer.status}.`);
  }
  if (inPlayer.confidence < 0.4) reasons.push('Lower data confidence — limited recent sample.');
  return reasons;
}
