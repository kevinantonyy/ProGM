/**
 * Deterministic roster analysis.
 *
 * Operates ONLY on normalized models (see normalize.js) and the league's actual
 * roster slots + scoring settings. Produces facts and ProGM-computed structural
 * observations. It does NOT use or invent player projections, rankings, or
 * statistics — those require an external data provider added in a later phase.
 *
 * Every returned value is either:
 *   - a Yahoo fact (e.g. which players are injured, who is starting), or
 *   - a ProGM calculation derived purely from Yahoo facts (e.g. positional
 *     depth counts, open slots, thin/overloaded positions).
 *
 * The `dataBasis` field on the result labels this explicitly so the frontend
 * can separate facts from calculations from future-projection needs.
 */

const BENCH_SLOTS = new Set(['BN', 'IL', 'IL+', 'IR', 'NA']);
const INJURY_ACTIVE_OK = new Set(['', 'ACTIVE', 'NORMAL']);

/** Positions that are "real" lineup positions rather than flex/util buckets. */
const FLEX_POSITIONS = new Set(['G', 'F', 'Util', 'UTIL', 'W', 'FLEX', 'SF/PF', 'G/F']);

/**
 * Count how many roster players are eligible for each starting slot position.
 * Uses eligiblePositions (a Yahoo fact) so flex eligibility is respected.
 */
function buildEligibilityDepth(players, startingPositions) {
  const depth = {};
  for (const pos of startingPositions) {
    depth[pos] = players.filter((p) => p.eligiblePositions.includes(pos)).length;
  }
  return depth;
}

/**
 * @param {Object} params
 * @param {import('./normalize.js').NormalizedPlayer[]} params.players  Roster players (normalized)
 * @param {Object} params.settings  Normalized league settings ({ scoringFormat, rosterSlots, statCategories, ... })
 */
export function analyzeRoster({ players, settings }) {
  const rosterSlots = settings?.rosterSlots || [];
  const startingSlots = rosterSlots.filter((s) => s.isStarting);
  const benchSlots = rosterSlots.filter((s) => !s.isStarting);

  const totalStartingSlots = startingSlots.reduce((sum, s) => sum + s.count, 0);
  const totalBenchSlots = benchSlots.reduce((sum, s) => sum + s.count, 0);
  const totalSlots = totalStartingSlots + totalBenchSlots;

  const starters = players.filter((p) => p.isStarting);
  const bench = players.filter((p) => !p.isStarting && p.selectedPosition !== 'IL' && p.selectedPosition !== 'IL+');
  const injuredReserve = players.filter((p) => p.selectedPosition === 'IL' || p.selectedPosition === 'IL+');

  // Injury facts (from Yahoo status).
  const injured = players.filter((p) => p.status && !INJURY_ACTIVE_OK.has(p.status));
  const injuredInActiveSlot = injured.filter((p) => p.isStarting);

  // Distinct real starting positions (exclude flex buckets for "primary" depth view).
  const startingPositions = [...new Set(startingSlots.map((s) => s.position))];
  const primaryPositions = startingPositions.filter((pos) => !FLEX_POSITIONS.has(pos));

  // Eligibility-based depth: how many rostered players can fill each starting slot.
  const eligibilityDepth = buildEligibilityDepth(players, startingPositions);

  // Required starters per position (slot counts) to compare against depth.
  const requiredByPosition = {};
  for (const slot of startingSlots) {
    requiredByPosition[slot.position] = (requiredByPosition[slot.position] || 0) + slot.count;
  }

  // Thin / overloaded positions (ProGM calculation, primary positions only).
  const thinPositions = [];
  const overloadedPositions = [];
  for (const pos of primaryPositions) {
    const required = requiredByPosition[pos] || 0;
    const eligible = eligibilityDepth[pos] || 0;
    if (eligible <= required) thinPositions.push({ position: pos, eligible, required });
    else if (eligible >= required + 3) overloadedPositions.push({ position: pos, eligible, required });
  }

  // Open roster slots (ProGM calculation): slots minus rostered players.
  const openSlots = Math.max(0, totalSlots - players.length);
  const openStartingSlots = Math.max(0, totalStartingSlots - starters.length);

  // Strongest / weakest by eligibility depth (structural only — NOT talent).
  const depthRanked = primaryPositions
    .map((pos) => ({ position: pos, eligible: eligibilityDepth[pos] || 0, required: requiredByPosition[pos] || 0 }))
    .sort((a, b) => b.eligible - a.eligible);

  return {
    dataBasis: {
      facts: [
        'roster slots and scoring settings (Yahoo)',
        'each player\'s eligible positions, current slot, and injury status (Yahoo)',
      ],
      calculations: [
        'positional eligibility depth vs required starters',
        'thin / overloaded positions',
        'open roster and starting slots',
        'starters vs bench split',
      ],
      requiresExternalData: [
        'player talent/value ranking',
        'statistical strength of each position',
        'projected production',
      ],
    },
    scoringFormat: settings?.scoringFormat || 'unknown',
    counts: {
      rosterSize: players.length,
      totalSlots,
      totalStartingSlots,
      totalBenchSlots,
      startersActive: starters.length,
      benchCount: bench.length,
      injuredReserveCount: injuredReserve.length,
      openSlots,
      openStartingSlots,
    },
    positions: {
      startingPositions,
      requiredByPosition,
      eligibilityDepth,
      depthRanked,
      thinPositions,
      overloadedPositions,
      strongest: depthRanked.slice(0, 3),
      weakest: [...depthRanked].reverse().slice(0, 3),
    },
    health: {
      injuredCount: injured.length,
      injured: injured.map((p) => ({ playerKey: p.playerKey, name: p.name, status: p.status, statusFull: p.statusFull, slot: p.selectedPosition, isStarting: p.isStarting })),
      injuredInActiveSlotCount: injuredInActiveSlot.length,
    },
    lineup: {
      starters: starters.map((p) => p.playerKey),
      bench: bench.map((p) => p.playerKey),
      injuredReserve: injuredReserve.map((p) => p.playerKey),
    },
  };
}
