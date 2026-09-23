/**
 * Start/Sit foundation.
 *
 * Produces DETERMINISTIC lineup observations that require only Yahoo data:
 *   - empty starting slots while an eligible bench player is available
 *   - injured/out players occupying active starting slots
 *   - bench players who are eligible for a currently-empty starting slot
 *
 * It deliberately does NOT rank who to start based on expected production —
 * that needs projections from an external provider. The `projectionProvider`
 * parameter is the seam where that plugs in later: when a provider is supplied,
 * `rankStartCandidates` will use it; until then it returns null so the UI can
 * show "projection data required".
 *
 * @typedef {Object} ProjectionProvider
 * @property {(player: import('./normalize.js').NormalizedPlayer) => number|null} getProjectedValue
 */

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/** Expand starting slots into individual slot instances (respecting counts). */
function expandStartingSlots(rosterSlots) {
  const slots = [];
  for (const slot of rosterSlots.filter((s) => s.isStarting)) {
    for (let i = 0; i < slot.count; i += 1) slots.push(slot.position);
  }
  return slots;
}

/**
 * @param {Object} params
 * @param {import('./normalize.js').NormalizedPlayer[]} params.players
 * @param {Object} params.settings              normalized league settings
 * @param {ProjectionProvider|null} [params.projectionProvider]
 */
export function analyzeStartSit({ players, settings, projectionProvider = null }) {
  const rosterSlots = settings?.rosterSlots || [];
  const startingSlotInstances = expandStartingSlots(rosterSlots);

  const starters = players.filter((p) => p.isStarting);
  const bench = players.filter((p) => !p.isStarting && p.selectedPosition !== 'IL' && p.selectedPosition !== 'IL+');

  const issues = [];

  // 1. Injured/out player in an active starting slot.
  for (const p of starters) {
    if (p.status && OUT_STATUSES.has(p.status)) {
      issues.push({
        type: 'injured_in_lineup',
        severity: 'high',
        playerKey: p.playerKey,
        playerName: p.name,
        slot: p.selectedPosition,
        status: p.status,
        statusFull: p.statusFull,
        message: `${p.name} (${p.statusFull || p.status}) is in your active ${p.selectedPosition} slot.`,
      });
    }
  }

  // 2. Empty starting slots (fewer active starters than starting slots) with an
  //    eligible bench player available to fill them.
  const filledCount = starters.length;
  const openStartingCount = Math.max(0, startingSlotInstances.length - filledCount);
  if (openStartingCount > 0) {
    // Which slot positions look unfilled? Compare required vs currently-started per position.
    const startedByPosition = {};
    for (const p of starters) startedByPosition[p.selectedPosition] = (startedByPosition[p.selectedPosition] || 0) + 1;

    const requiredByPosition = {};
    for (const pos of startingSlotInstances) requiredByPosition[pos] = (requiredByPosition[pos] || 0) + 1;

    for (const [pos, required] of Object.entries(requiredByPosition)) {
      const started = startedByPosition[pos] || 0;
      if (started < required) {
        const eligibleBench = bench.filter((p) => p.eligiblePositions.includes(pos) && (!p.status || !OUT_STATUSES.has(p.status)));
        if (eligibleBench.length > 0) {
          issues.push({
            type: 'empty_slot_fillable',
            severity: 'high',
            slot: pos,
            openCount: required - started,
            message: `${required - started} open ${pos} slot(s) with ${eligibleBench.length} eligible bench player(s) available.`,
            eligibleBench: eligibleBench.map((p) => ({ playerKey: p.playerKey, name: p.name, eligiblePositions: p.eligiblePositions })),
          });
        } else {
          issues.push({
            type: 'empty_slot_unfillable',
            severity: 'medium',
            slot: pos,
            openCount: required - started,
            message: `${required - started} open ${pos} slot(s), but no healthy eligible bench player to fill.`,
          });
        }
      }
    }
  }

  // 3. Projection-based ranking (seam for future data). Deterministic-only for now.
  let startCandidates = null;
  let projectionNote = 'Start/Sit ranking by expected production requires an external projections provider (not yet connected).';
  if (projectionProvider && typeof projectionProvider.getProjectedValue === 'function') {
    startCandidates = [...players]
      .map((p) => ({ playerKey: p.playerKey, name: p.name, projected: projectionProvider.getProjectedValue(p) }))
      .filter((c) => c.projected != null)
      .sort((a, b) => b.projected - a.projected);
    projectionNote = 'Rankings use the connected projections provider.';
  }

  return {
    dataBasis: {
      facts: ['current lineup slots and player injury status (Yahoo)', 'league starting slot configuration (Yahoo)'],
      calculations: ['open startable slots', 'eligible bench players per open slot', 'injured players in active slots'],
      requiresExternalData: ['who to start by expected production (projections)'],
    },
    summary: {
      startingSlots: startingSlotInstances.length,
      activeStarters: starters.length,
      openStartingSlots: openStartingCount,
      benchAvailable: bench.length,
      issueCount: issues.length,
    },
    issues: issues.sort((a, b) => (a.severity === 'high' ? -1 : 1) - (b.severity === 'high' ? -1 : 1)),
    startCandidates,
    projectionNote,
  };
}
