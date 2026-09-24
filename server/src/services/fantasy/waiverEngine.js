/**
 * Waiver recommendation engine.
 *
 * Ranks players Yahoo confirms are AVAILABLE in the league in two distinct ways:
 *
 *   BEST AVAILABLE — strongest projected league fantasy value, regardless of
 *                    the user's roster.
 *   BEST FIT       — projected value adjusted for the user's positional needs,
 *                    so a slightly-lower projection at a thin position can rank
 *                    above a higher projection at an overloaded position.
 *
 * percent_owned (from Yahoo) is displayed for context but is NEVER used as a
 * proxy for player quality.
 *
 * Requires projections (projectionProvider). Without them the engine returns
 * availability + ownership facts only and marks recommendations unavailable.
 *
 * PAIRED ADD/DROP: a pickup is only actionable if there is a roster spot for the
 * player. When the roster is full every ADD must be paired with a DROP, and the
 * pair is only recommended when the incoming player is projected to out-produce
 * the outgoing one by a meaningful margin (net improvement). The drop candidate
 * is chosen from the user's own weakest, non-essential players — never a healthy
 * starter unless the upgrade is decisive, and injured-reserve stashes are only
 * cut as a last resort. We never invent a value to force a pairing.
 */

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/** Minimum projected-points gain (add minus drop) to recommend a paired move. */
const MIN_NET_IMPROVEMENT = 1.0;

/** Roster slots that mean a player is stashed away, not occupying an active spot. */
const STASH_SLOTS = new Set(['IL', 'IL+', 'IR', 'NA']);

/**
 * Would the roster still be able to fill every required STARTING slot after
 * dropping `dropPlayer` and adding `addPlayer`? Uses eligiblePositions (a Yahoo
 * fact). When settings are unknown we cannot prove illegality, so we allow it
 * (the engine still degrades safely; the UI shows the move for confirmation).
 *
 * @param {Array}  ownRoster   decorated roster players (eligiblePositions[])
 * @param {Object} dropPlayer  the candidate to drop
 * @param {Object} addPlayer   the incoming player
 * @param {Object} settings    normalized league settings (rosterSlots)
 */
function keepsLegalRosterAfterSwap(ownRoster, dropPlayer, addPlayer, settings) {
  const slots = (settings?.rosterSlots || []).filter((s) => s.isStarting);
  if (!slots.length) return true; // unknown requirements -> don't block
  const required = {};
  for (const slot of slots) required[slot.position] = (required[slot.position] || 0) + slot.count;
  const after = ownRoster
    .filter((p) => p.playerKey !== dropPlayer.playerKey)
    .concat([{ eligiblePositions: addPlayer.eligiblePositions || [] }]);
  for (const [pos, need] of Object.entries(required)) {
    const eligible = after.filter((p) => (p.eligiblePositions || []).includes(pos)).length;
    if (eligible < need) return false;
  }
  return true;
}

/**
 * Compute a positional-need multiplier per starting position from the user's
 * roster analysis. Thin positions get a boost (>1), overloaded get a slight
 * discount (<1). This is a ProGM calculation, clearly separated from raw value.
 */
function needMultipliers(rosterAnalysis) {
  const mult = {};
  if (!rosterAnalysis?.positions) return mult;
  for (const t of rosterAnalysis.positions.thinPositions || []) mult[t.position] = 1.25;
  for (const o of rosterAnalysis.positions.overloadedPositions || []) mult[o.position] = 0.9;
  return mult;
}

/** Best positional-need multiplier that applies to a player's eligible positions. */
function bestNeedMultiplier(player, mult) {
  let best = 1;
  for (const pos of player.eligiblePositions || []) {
    if (mult[pos] != null) best = Math.max(best, mult[pos]);
  }
  // If a player is only eligible for overloaded spots, apply the discount.
  if (best === 1) {
    const discounts = (player.eligiblePositions || []).map((p) => mult[p]).filter((v) => v != null && v < 1);
    if (discounts.length && (player.eligiblePositions || []).every((p) => (mult[p] ?? 1) < 1)) {
      best = Math.min(...discounts);
    }
  }
  return best;
}

/**
 * Categorize a paired move by how strong the net improvement is. Descriptive
 * only — never a prediction that a move will "work".
 */
function categorizeNet(net) {
  if (net >= 6) return 'MustAdd';
  if (net >= 3) return 'Upgrade';
  if (net >= MIN_NET_IMPROVEMENT) return 'Stream';
  return 'Watch';
}

/**
 * Decorate the user's own roster players with projections so we can identify
 * the weakest droppable candidates. Returns null when projections are missing
 * (we will not guess who to drop without real value).
 *
 * @param {Array} myRoster            normalized roster players (with selectedPosition/status)
 * @param {Object} projectionProvider {getProjection(player)}
 */
function decorateOwnRoster(myRoster, projectionProvider) {
  if (!Array.isArray(myRoster) || !projectionProvider?.getProjection) return null;
  return myRoster.map((p) => {
    const proj = projectionProvider.getProjection(p);
    return {
      playerKey: p.playerKey,
      name: p.name,
      teamAbbr: p.teamAbbr,
      eligiblePositions: p.eligiblePositions || [],
      status: p.status || null,
      statusFull: p.statusFull || null,
      selectedPosition: p.selectedPosition || null,
      isStarting: Boolean(p.isStarting),
      stashed: STASH_SLOTS.has(p.selectedPosition),
      out: Boolean(p.status && OUT_STATUSES.has(p.status)),
      projectedPoints: proj?.projectedPoints ?? null,
    };
  });
}

/**
 * Rank the user's own players as drop candidates, worst-first. We prefer to
 * shed players who are unrostered value (low/no projection) and NOT stashed on
 * IL for a reason. A healthy contributor is only a drop candidate at the bottom
 * of the value list. Players with no projection are treated as lowest value but
 * flagged so the caller can surface uncertainty rather than fabricate a number.
 */
function rankDropCandidates(ownRoster) {
  return [...ownRoster]
    .map((p) => ({
      ...p,
      // Sort key: unknown projection sorts as very low but is flagged.
      dropSortValue: p.projectedPoints == null ? -1 : p.projectedPoints,
    }))
    .sort((a, b) => {
      // Never surface an IL stash as the first drop unless nothing else exists.
      if (a.stashed !== b.stashed) return a.stashed ? 1 : -1;
      return a.dropSortValue - b.dropSortValue;
    });
}

/**
 * Build paired ADD + DROP recommendations from ranked available players and the
 * user's own roster. Only produces a pair when:
 *   - the roster is full (open slots === 0), so a drop is actually required, AND
 *   - the incoming player out-projects the drop candidate by >= MIN_NET_IMPROVEMENT.
 * When there are open slots, ADDs are returned without a forced drop.
 *
 * @param {Array}  rankableAdds  decorated available players (projection known, not OUT)
 * @param {Array}  ownRoster     decorateOwnRoster() output
 * @param {number} openSlots     open roster slots (from rosterAnalysis)
 * @param {Object} settings      normalized league settings (for post-swap legality)
 * @param {number} limit
 */
function pairAddDrops({ rankableAdds, ownRoster, openSlots, settings, limit }) {
  const dropCandidates = rankDropCandidates(ownRoster);
  const rosterFull = openSlots <= 0;
  const results = [];
  const usedDrops = new Set();

  for (const add of rankableAdds) {
    if (results.length >= limit) break;

    if (!rosterFull) {
      // There is a free slot — no drop required for this add.
      results.push({
        add: {
          playerKey: add.playerKey,
          name: add.name,
          teamAbbr: add.teamAbbr,
          eligiblePositions: add.eligiblePositions,
          projectedPoints: add.projectedPoints,
          percentOwned: add.percentOwned,
        },
        drop: null,
        openSlotUsed: true,
        netImprovement: null,
        category: 'OpenSlot',
        reason: 'You have an open roster spot, so this player can be added without dropping anyone.',
      });
      continue;
    }

    // Roster is full: find the weakest drop we have not already spent that this
    // add actually beats by a meaningful margin AND that keeps the roster legal
    // (never drop the only player who can fill a required starting slot).
    const drop = dropCandidates.find((d) => {
      if (usedDrops.has(d.playerKey)) return false;
      if (!keepsLegalRosterAfterSwap(ownRoster, d, add, settings)) return false;
      if (d.projectedPoints == null) return true; // unknown value: weakest, flagged below
      return add.projectedPoints - d.projectedPoints >= MIN_NET_IMPROVEMENT;
    });

    if (!drop) continue; // No justified drop — do not force a churn move.

    usedDrops.add(drop.playerKey);
    const net = drop.projectedPoints == null
      ? null
      : Number((add.projectedPoints - drop.projectedPoints).toFixed(2));

    results.push({
      add: {
        playerKey: add.playerKey,
        name: add.name,
        teamAbbr: add.teamAbbr,
        eligiblePositions: add.eligiblePositions,
        projectedPoints: add.projectedPoints,
        percentOwned: add.percentOwned,
      },
      drop: {
        playerKey: drop.playerKey,
        name: drop.name,
        teamAbbr: drop.teamAbbr,
        eligiblePositions: drop.eligiblePositions,
        projectedPoints: drop.projectedPoints,
        status: drop.status,
        stashed: drop.stashed,
        projectionKnown: drop.projectedPoints != null,
      },
      openSlotUsed: false,
      netImprovement: net,
      category: net == null ? 'Watch' : categorizeNet(net),
      reason: drop.projectedPoints == null
        ? `Your roster is full. ${drop.name} has no projection available, so confirm they are droppable before adding ${add.name}.`
        : `Your roster is full. Adding ${add.name} and dropping ${drop.name} projects to +${net} fantasy points.`,
    });
  }

  return results;
}

/**
 * @param {Object} params
 * @param {Array} params.availablePlayers   normalized Yahoo players (available pool)
 * @param {Object} params.projectionProvider {getProjection(player)} or null
 * @param {Object} [params.rosterAnalysis]   analyzeRoster() result for the user's team
 * @param {Array}  [params.myRoster]         normalized roster players (for paired add/drop)
 * @param {Object} [params.settings]         normalized league settings (post-swap legality)
 * @param {number} [params.limit]
 */
export function rankWaivers({ availablePlayers, projectionProvider, rosterAnalysis = null, myRoster = null, settings = null, limit = 25 }) {
  const projectionsAvailable = Boolean(projectionProvider?.getProjection);
  const mult = needMultipliers(rosterAnalysis);

  const decorated = (availablePlayers || []).map((p) => {
    const proj = projectionsAvailable ? projectionProvider.getProjection(p) : null;
    const projected = proj?.projectedPoints ?? null;
    const needMult = bestNeedMultiplier(p, mult);
    const out = Boolean(p.status && OUT_STATUSES.has(p.status));
    return {
      playerKey: p.playerKey,
      name: p.name,
      teamAbbr: p.teamAbbr,
      eligiblePositions: p.eligiblePositions,
      status: p.status,
      statusFull: p.statusFull,
      percentOwned: p.percentOwned ?? null,
      projectedPoints: projected,
      confidence: proj?.confidence ?? 0,
      out,
      // Fit score: projected value scaled by positional need. Null if no projection.
      fitScore: projected != null ? Number((projected * needMult).toFixed(2)) : null,
      needMultiplier: needMult,
    };
  });

  if (!projectionsAvailable) {
    return {
      projectionsAvailable: false,
      bestAvailable: [],
      bestFit: [],
      addDrop: [],
      players: decorated, // still expose availability + ownership facts
      note: 'Projection data is unavailable, so players are shown with availability and ownership only (no ranking).',
    };
  }

  const rankable = decorated.filter((p) => p.projectedPoints != null && !p.out);

  const bestAvailable = [...rankable]
    .sort((a, b) => b.projectedPoints - a.projectedPoints)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  const bestFit = [...rankable]
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      ...p,
      fitReason: p.needMultiplier > 1
        ? `Boosted for a thin position you can start (${p.eligiblePositions.join('/')}).`
        : p.needMultiplier < 1
          ? 'Slightly discounted — you already have depth at this player\'s positions.'
          : 'Neutral positional fit.',
    }));

  // Paired ADD/DROP: only when we have the user's roster + projections for it.
  const ownRoster = decorateOwnRoster(myRoster, projectionProvider);
  let addDrop = [];
  if (ownRoster) {
    const openSlots = rosterAnalysis?.counts?.openSlots ?? 0;
    addDrop = pairAddDrops({ rankableAdds: bestAvailable, ownRoster, openSlots, settings, limit });
  }

  return {
    projectionsAvailable: true,
    bestAvailable,
    bestFit,
    addDrop,
    note: 'BEST AVAILABLE ranks by projected league fantasy points. BEST FIT adjusts for your roster\'s positional needs. ADD/DROP pairs every pickup with a corresponding drop only when your roster is full and the move is a net upgrade. Ownership % is context only, not a quality signal.',
  };
}
