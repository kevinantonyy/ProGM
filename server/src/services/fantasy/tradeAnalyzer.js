/**
 * Trade Analyzer foundation.
 *
 * Given the user's roster, another team's roster, and the players proposed to
 * move each way, this computes OBJECTIVE, factual before/after information:
 *   - who is involved and their positions
 *   - roster size before/after for each side
 *   - positional eligibility depth change for each side
 *   - relevant league settings (scoring format, trade deadline)
 *
 * It does NOT produce a "trade value", "winner", or "grade" — those require
 * player valuations/rankings from an external provider. The `valuationProvider`
 * parameter is the seam: when supplied, `valueDelta` is computed; otherwise it
 * stays null and the UI shows "valuation data required".
 *
 * @typedef {Object} ValuationProvider
 * @property {(player: import('./normalize.js').NormalizedPlayer) => number|null} getValue
 */

function depthByStartingPosition(players, startingPositions) {
  const depth = {};
  for (const pos of startingPositions) {
    depth[pos] = players.filter((p) => p.eligiblePositions.includes(pos)).length;
  }
  return depth;
}

function applyTrade(roster, outKeys, inPlayers) {
  const outSet = new Set(outKeys);
  const kept = roster.filter((p) => !outSet.has(p.playerKey));
  return kept.concat(inPlayers);
}

function summarizePlayer(p) {
  return {
    playerKey: p.playerKey,
    name: p.name,
    teamAbbr: p.teamAbbr,
    primaryPosition: p.primaryPosition,
    eligiblePositions: p.eligiblePositions,
    status: p.status,
    statusFull: p.statusFull,
  };
}

function diffDepth(before, after, startingPositions) {
  return startingPositions.map((pos) => ({
    position: pos,
    before: before[pos] || 0,
    after: after[pos] || 0,
    change: (after[pos] || 0) - (before[pos] || 0),
  }));
}

/**
 * @param {Object} params
 * @param {Object} params.settings                    normalized league settings
 * @param {import('./normalize.js').NormalizedPlayer[]} params.myRoster
 * @param {import('./normalize.js').NormalizedPlayer[]} params.theirRoster
 * @param {string[]} params.sendKeys                   playerKeys I send away
 * @param {string[]} params.receiveKeys                playerKeys I receive
 * @param {ValuationProvider|null} [params.valuationProvider]
 */
export function analyzeTrade({ settings, myRoster, theirRoster, sendKeys, receiveKeys, valuationProvider = null }) {
  const startingPositions = [
    ...new Set((settings?.rosterSlots || []).filter((s) => s.isStarting).map((s) => s.position)),
  ];

  const sendPlayers = myRoster.filter((p) => sendKeys.includes(p.playerKey));
  const receivePlayers = theirRoster.filter((p) => receiveKeys.includes(p.playerKey));

  // Validate that all requested players exist on the respective rosters.
  const missing = [
    ...sendKeys.filter((k) => !sendPlayers.some((p) => p.playerKey === k)).map((k) => ({ side: 'mine', playerKey: k })),
    ...receiveKeys.filter((k) => !receivePlayers.some((p) => p.playerKey === k)).map((k) => ({ side: 'theirs', playerKey: k })),
  ];

  const myBefore = depthByStartingPosition(myRoster, startingPositions);
  const theirBefore = depthByStartingPosition(theirRoster, startingPositions);

  const myAfterRoster = applyTrade(myRoster, sendKeys, receivePlayers);
  const theirAfterRoster = applyTrade(theirRoster, receiveKeys, sendPlayers);

  const myAfter = depthByStartingPosition(myAfterRoster, startingPositions);
  const theirAfter = depthByStartingPosition(theirAfterRoster, startingPositions);

  // Optional valuation seam.
  let valueDelta = null;
  let valuationNote = 'Objective trade value/grade requires an external player valuation provider (not yet connected). The figures above are factual roster/positional changes only.';
  if (valuationProvider && typeof valuationProvider.getValue === 'function') {
    const sum = (arr) => arr.reduce((t, p) => t + (valuationProvider.getValue(p) || 0), 0);
    const sendValue = sum(sendPlayers);
    const receiveValue = sum(receivePlayers);
    valueDelta = { sendValue, receiveValue, net: receiveValue - sendValue };
    valuationNote = 'Trade value uses the connected valuation provider.';
  }

  return {
    dataBasis: {
      facts: ['players and their positions/eligibility/status (Yahoo)', 'league scoring format and trade settings (Yahoo)'],
      calculations: ['roster size before/after', 'positional eligibility depth change per side'],
      requiresExternalData: ['trade value, fairness grade, winner (player valuations/rankings)'],
    },
    valid: missing.length === 0 && (sendPlayers.length > 0 || receivePlayers.length > 0),
    missing,
    scoringFormat: settings?.scoringFormat || 'unknown',
    tradeDeadline: settings?.raw?.tradeEndDate || null,
    send: sendPlayers.map(summarizePlayer),
    receive: receivePlayers.map(summarizePlayer),
    mine: {
      rosterSizeBefore: myRoster.length,
      rosterSizeAfter: myAfterRoster.length,
      depthChange: diffDepth(myBefore, myAfter, startingPositions),
    },
    theirs: {
      rosterSizeBefore: theirRoster.length,
      rosterSizeAfter: theirAfterRoster.length,
      depthChange: diffDepth(theirBefore, theirAfter, startingPositions),
    },
    valueDelta,
    valuationNote,
  };
}
