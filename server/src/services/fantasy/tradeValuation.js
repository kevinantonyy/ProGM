/**
 * Trade valuation engine (multi-factor).
 *
 * Extends the objective trade analysis (tradeAnalyzer.js) with PROJECTION-based
 * factors when external data is available. It deliberately does NOT reduce a
 * trade to a single arbitrary 0-100 "trade score". Instead it reports the
 * measurable factors and a qualitative assessment:
 *
 *   'improves' | 'neutral' | 'reduces'   (projected roster output direction)
 *
 * Factors surfaced:
 *   - projected production sent / received / net
 *   - positional depth change (from tradeAnalyzer)
 *   - roster-slot implications (player count change)
 *   - injury/status concerns among involved players
 *   - data quality / confidence
 *
 * Raw per-player projections stay accessible so the assessment is explainable.
 */

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);
const NEUTRAL_BAND = 2.0; // within +/- this many league pts/game is "approximately neutral"

function sumProjected(players, projectionProvider) {
  let total = 0;
  let known = 0;
  const detail = [];
  for (const p of players) {
    const proj = projectionProvider?.getProjection ? projectionProvider.getProjection(p) : null;
    const value = proj?.projectedPoints ?? null;
    if (value != null) { total += value; known += 1; }
    detail.push({ playerKey: p.playerKey, name: p.name, projectedPoints: value, confidence: proj?.confidence ?? 0 });
  }
  return { total: Number(total.toFixed(2)), known, count: players.length, detail };
}

function injuryConcerns(players) {
  return players
    .filter((p) => p.status && OUT_STATUSES.has(p.status))
    .map((p) => ({ playerKey: p.playerKey, name: p.name, status: p.status, statusFull: p.statusFull }));
}

/**
 * @param {Object} params
 * @param {Object} params.baseAnalysis        analyzeTrade() result (objective facts)
 * @param {Array} params.sendPlayers          normalized players I send
 * @param {Array} params.receivePlayers       normalized players I receive
 * @param {Object|null} params.projectionProvider
 * @returns {Object} valuation (additive to baseAnalysis)
 */
export function valuateTrade({ baseAnalysis, sendPlayers, receivePlayers, projectionProvider }) {
  const projectionsAvailable = Boolean(projectionProvider?.getProjection);

  if (!projectionsAvailable) {
    return {
      projectionsAvailable: false,
      assessment: 'unknown',
      note: 'Projection data is unavailable. Trade impact is shown as objective roster/positional changes only; no production assessment is made.',
      production: null,
      injuryConcerns: {
        send: injuryConcerns(sendPlayers),
        receive: injuryConcerns(receivePlayers),
      },
      confidence: 0,
    };
  }

  const send = sumProjected(sendPlayers, projectionProvider);
  const receive = sumProjected(receivePlayers, projectionProvider);
  const net = Number((receive.total - send.total).toFixed(2));

  let assessment = 'neutral';
  if (net > NEUTRAL_BAND) assessment = 'improves';
  else if (net < -NEUTRAL_BAND) assessment = 'reduces';

  // Confidence = average confidence across all involved players with known data.
  const known = [...send.detail, ...receive.detail].filter((d) => d.projectedPoints != null);
  const confidence = known.length
    ? Number((known.reduce((s, d) => s + d.confidence, 0) / known.length).toFixed(2))
    : 0;

  // Data-quality caveat when some involved players couldn't be projected.
  const totalInvolved = send.count + receive.count;
  const knownInvolved = send.known + receive.known;
  const partial = knownInvolved < totalInvolved;

  const reasons = [];
  reasons.push(`Projected per-game output: give ${send.total}, receive ${receive.total} (net ${net > 0 ? '+' : ''}${net}).`);
  if (baseAnalysis?.mine?.rosterSizeAfter !== baseAnalysis?.mine?.rosterSizeBefore) {
    reasons.push(`Your roster size changes ${baseAnalysis.mine.rosterSizeBefore} -> ${baseAnalysis.mine.rosterSizeAfter}.`);
  }
  const gainedDepth = (baseAnalysis?.mine?.depthChange || []).filter((d) => d.change > 0).map((d) => d.position);
  const lostDepth = (baseAnalysis?.mine?.depthChange || []).filter((d) => d.change < 0).map((d) => d.position);
  if (gainedDepth.length) reasons.push(`Adds eligibility depth at ${gainedDepth.join(', ')}.`);
  if (lostDepth.length) reasons.push(`Reduces eligibility depth at ${lostDepth.join(', ')}.`);
  if (partial) reasons.push('Some involved players lack projection data; assessment confidence is reduced.');

  return {
    projectionsAvailable: true,
    assessment, // improves | neutral | reduces
    production: {
      sendTotal: send.total,
      receiveTotal: receive.total,
      net,
      send: send.detail,
      receive: receive.detail,
      knownInvolved,
      totalInvolved,
    },
    injuryConcerns: {
      send: injuryConcerns(sendPlayers),
      receive: injuryConcerns(receivePlayers),
    },
    reasons,
    confidence,
    note: 'Assessment reflects projected per-game league fantasy output plus positional depth. It is not a certainty or a single trade grade.',
  };
}
