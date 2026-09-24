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

/**
 * Resolve the value we should rank a start/sit decision on.
 *
 * Prefers the schedule-aware period projection (expected points across the
 * games the player actually has in the current fantasy period) when it is
 * available, because in daily leagues a player with more games in the week is
 * worth starting over an equal per-game player with fewer games. Falls back to
 * the per-game projection when schedule data is missing. Returns null (never 0)
 * when there is no projection at all — we do not fabricate a value.
 *
 * @param {import('./normalize.js').NormalizedPlayer} player
 * @param {Object} provider  { getProjectedValue?, getPeriodValue? }
 * @returns {{ value:number|null, basis:'period'|'perGame'|'none', expectedGames:number|null }}
 */
export function resolveStartValue(player, provider) {
  if (provider && typeof provider.getPeriodValue === 'function') {
    const period = provider.getPeriodValue(player);
    if (period && period.scheduleAware && period.periodProjectedPoints != null) {
      return { value: period.periodProjectedPoints, basis: 'period', expectedGames: period.expectedGames ?? null };
    }
  }
  if (provider && typeof provider.getProjectedValue === 'function') {
    const perGame = provider.getProjectedValue(player);
    if (perGame != null) return { value: perGame, basis: 'perGame', expectedGames: null };
  }
  return { value: null, basis: 'none', expectedGames: null };
}

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

  // 3. Projection-based ranking, schedule-aware when possible.
  const hasProjections = Boolean(
    projectionProvider && (typeof projectionProvider.getProjectedValue === 'function' || typeof projectionProvider.getPeriodValue === 'function'),
  );
  let startCandidates = null;
  let benchOverStarter = null;
  let scheduleAware = false;
  let projectionNote = 'Start/Sit ranking by expected production requires an external projections provider (not yet connected).';

  if (hasProjections) {
    const valued = players
      .map((p) => {
        const r = resolveStartValue(p, projectionProvider);
        if (r.basis === 'period') scheduleAware = true;
        return {
          playerKey: p.playerKey,
          name: p.name,
          eligiblePositions: p.eligiblePositions,
          isStarting: Boolean(p.isStarting),
          out: Boolean(p.status && OUT_STATUSES.has(p.status)),
          value: r.value,
          valueBasis: r.basis,
          expectedGames: r.expectedGames,
        };
      })
      .filter((c) => c.value != null);

    startCandidates = [...valued].sort((a, b) => b.value - a.value);

    // Actionable Start/Sit: a healthy bench player projected clearly above a
    // startable-elsewhere active starter at a shared position. This never
    // recommends starting an OUT player and never fabricates a value.
    benchOverStarter = [];
    const activeStarters = valued.filter((c) => c.isStarting && !c.out);
    const healthyBench = valued.filter((c) => !c.isStarting && !c.out);
    for (const b of healthyBench) {
      const beatable = activeStarters
        .filter((s) => s.eligiblePositions.some((pos) => b.eligiblePositions.includes(pos)))
        .filter((s) => b.value - s.value >= 1)
        .sort((a, c) => a.value - c.value)[0];
      if (beatable) {
        benchOverStarter.push({
          start: { playerKey: b.playerKey, name: b.name, value: b.value, expectedGames: b.expectedGames },
          sit: { playerKey: beatable.playerKey, name: beatable.name, value: beatable.value, expectedGames: beatable.expectedGames },
          gain: Number((b.value - beatable.value).toFixed(2)),
          basis: b.valueBasis,
          reason: scheduleAware && b.valueBasis === 'period'
            ? `${b.name} projects for ${b.value} pts over ${b.expectedGames ?? '?'} game(s) this period vs ${beatable.value} for ${beatable.name}.`
            : `${b.name} projects for ${b.value} pts/game vs ${beatable.value} for ${beatable.name}.`,
        });
      }
    }
    benchOverStarter.sort((a, b) => b.gain - a.gain);

    projectionNote = scheduleAware
      ? 'Rankings use expected production over each player\'s games in the current fantasy period (schedule-aware).'
      : 'Rankings use per-game projections (schedule data unavailable, so games-in-period is not weighted).';
  }

  return {
    dataBasis: {
      facts: ['current lineup slots and player injury status (Yahoo)', 'league starting slot configuration (Yahoo)'],
      calculations: ['open startable slots', 'eligible bench players per open slot', 'injured players in active slots', 'schedule-aware expected production ranking (when schedule available)'],
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
    benchOverStarter,
    scheduleAware,
    projectionNote,
  };
}
