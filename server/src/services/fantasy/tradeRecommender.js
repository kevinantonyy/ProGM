/**
 * AI Trade Recommender (deterministic candidate generation + scoring).
 *
 * ProGM — not Gemini — GENERATES and SCORES candidate trades. Gemini only
 * explains the resulting recommendations later. This engine:
 *   - inspects my roster + every opponent roster,
 *   - values players via the transparent playerValue model (projection +
 *     availability + positional scarcity; schedule-aware when available),
 *   - generates legal candidate packages (1↔1, 2↔1, 1↔2, 2↔2),
 *   - scores each by MY roster improvement AND separately by FAIRNESS,
 *   - filters illegal outcomes and absurd offers,
 *   - explains why it helps me and why it could plausibly help them.
 *
 * Two DIFFERENT questions are answered and surfaced separately:
 *   improvement — "does this improve MY team?" (net value to me)
 *   fairness    — "is this reasonably balanced for both sides?" (value gap)
 *
 * It never predicts acceptance; fairness uses hedged labels.
 * It never invents players — only players actually on the indicated rosters.
 */
import { playerValue, scarcityWeights } from './playerValue.js';

const FAIR_BAND = 0.10;        // within ±10% combined value => "balanced"
const PLAUSIBLE_BAND = 0.20;   // within ±20% => "plausible starting point"
const MIN_IMPROVEMENT = 1.0;   // ignore trades that barely move my value
const MAX_PER_TEAM = 3;
const MAX_TOTAL = 12;

/** Position counts a roster can field (for depth/legality reasoning). */
function positionalDepth(players, startingPositions) {
  const depth = {};
  for (const pos of startingPositions) depth[pos] = players.filter((p) => (p.eligiblePositions || []).includes(pos)).length;
  return depth;
}

/** Would removing `outPlayers` and adding `inPlayers` leave every starting slot fillable? */
function keepsLegalRoster(rosterAfter, settings) {
  // Simple legality guard: for each distinct starting position, ensure at least
  // as many eligible players remain as the league requires as starters.
  const slots = (settings?.rosterSlots || []).filter((s) => s.isStarting);
  const required = {};
  for (const slot of slots) required[slot.position] = (required[slot.position] || 0) + slot.count;
  for (const [pos, need] of Object.entries(required)) {
    const eligible = rosterAfter.filter((p) => (p.eligiblePositions || []).includes(pos)).length;
    if (eligible < need) return false;
  }
  return true;
}

function combos(players, sizes) {
  const out = [];
  const pool = players.slice(0, 12); // bound the search for budget/perf
  if (sizes.includes(1)) for (const p of pool) out.push([p]);
  if (sizes.includes(2)) for (let i = 0; i < pool.length; i += 1) for (let j = i + 1; j < pool.length; j += 1) out.push([pool[i], pool[j]]);
  return out;
}

function sumValue(players, valueOf) {
  let total = 0; let known = 0;
  for (const p of players) { const v = valueOf(p); if (v != null) { total += v; known += 1; } }
  return { total: Number(total.toFixed(2)), known, count: players.length };
}

function fairnessLabel(sendVal, receiveVal) {
  const max = Math.max(sendVal, receiveVal, 1);
  const gap = Math.abs(receiveVal - sendVal) / max;
  if (gap <= FAIR_BAND) return { fairness: 'balanced', gapPct: Math.round(gap * 1000) / 10 };
  const favorsMe = receiveVal > sendVal;
  if (gap <= PLAUSIBLE_BAND) return { fairness: 'plausible starting point', gapPct: Math.round(gap * 1000) / 10, favorsMe };
  return { fairness: favorsMe ? 'favors your side' : 'favors their side', gapPct: Math.round(gap * 1000) / 10, favorsMe };
}

/**
 * @param {Object} params
 * @param {Object} params.settings                normalized league settings
 * @param {Array} params.myRoster                 uiPlayer[] (mine)
 * @param {Array<{teamKey,name,roster}>} params.opponents  each with uiPlayer[] roster
 * @param {(player)=>{value:number|null}} [params.valueFn]  override (tests)
 * @param {Object} [params.analysis]              analyzeRoster() result for my needs
 */
export function recommendTrades({ settings, myRoster, opponents, valueFn, analysis }) {
  const weights = scarcityWeights(settings);
  const startingPositions = [...new Set((settings?.rosterSlots || []).filter((s) => s.isStarting).map((s) => s.position))];

  // Value function: schedule-aware period value preferred, else per-game.
  const valueOf = valueFn || ((p) => playerValue({
    projectedPerGame: p.projectedPoints,
    periodProjectedPoints: p.weeklyProjectedPoints,
    status: p.injuryStatus,
    eligiblePositions: p.eligiblePositions,
    weights,
  }).value);

  // If we cannot value players at all, we cannot recommend trades (no fabrication).
  const anyValue = myRoster.some((p) => valueOf(p) != null);
  if (!anyValue) {
    return { available: false, reason: 'Projection data unavailable; ProGM cannot generate trade recommendations without it.', recommendations: [] };
  }

  const myDepthBefore = positionalDepth(myRoster, startingPositions);
  const thinPositions = new Set((analysis?.positions?.thinPositions || []).map((t) => t.position));
  const results = [];

  for (const opp of opponents || []) {
    const oppRoster = opp.roster || [];
    if (!oppRoster.length) continue;
    const oppValued = [...oppRoster].filter((p) => valueOf(p) != null).sort((a, b) => valueOf(b) - valueOf(a));
    const myValued = [...myRoster].filter((p) => valueOf(p) != null).sort((a, b) => valueOf(b) - valueOf(a));

    const sends = combos(myValued, [1, 2]);
    const receives = combos(oppValued, [1, 2]);
    const perTeam = [];

    for (const send of sends) {
      for (const receive of receives) {
        // Keep package sizes sane (net roster size change within ±1).
        if (Math.abs(send.length - receive.length) > 1) continue;
        const sendKeys = new Set(send.map((p) => p.id));
        const receiveKeys = new Set(receive.map((p) => p.id));

        const myAfter = myRoster.filter((p) => !sendKeys.has(p.id)).concat(receive);
        const oppAfter = oppRoster.filter((p) => !receiveKeys.has(p.id)).concat(send);
        // Legality for BOTH rosters.
        if (!keepsLegalRoster(myAfter, settings) || !keepsLegalRoster(oppAfter, settings)) continue;

        const sendVal = sumValue(send, valueOf);
        const receiveVal = sumValue(receive, valueOf);
        // Require full valuation on both sides (avoid absurd matches on unknowns).
        if (sendVal.known !== send.length || receiveVal.known !== receive.length) continue;

        const myNet = Number((receiveVal.total - sendVal.total).toFixed(2));
        if (myNet < MIN_IMPROVEMENT) continue; // only surface trades that help me

        const fair = fairnessLabel(sendVal.total, receiveVal.total);
        // Skip absurd: strongly favors me is not a plausible offer for them.
        if (fair.fairness === 'favors your side') continue;

        const myAfterDepth = positionalDepth(myAfter, startingPositions);
        const depthImpact = startingPositions
          .map((pos) => ({ position: pos, before: myDepthBefore[pos] || 0, after: myAfterDepth[pos] || 0, change: (myAfterDepth[pos] || 0) - (myDepthBefore[pos] || 0) }))
          .filter((d) => d.change !== 0);

        const helpsThin = receive.some((p) => (p.eligiblePositions || []).some((pos) => thinPositions.has(pos)));
        const improvement = myNet >= MIN_IMPROVEMENT ? 'improves' : 'neutral';

        perTeam.push({
          withTeam: opp.name,
          withTeamKey: opp.teamKey,
          send: send.map(summ),
          receive: receive.map(summ),
          improvement,
          fairness: fair.fairness,
          fairnessGapPct: fair.gapPct,
          production: { sendValue: sendVal.total, receiveValue: receiveVal.total, net: myNet },
          depthImpact,
          whyForMe: buildWhyForMe({ myNet, helpsThin, receive, depthImpact }),
          whyForThem: buildWhyForThem({ fair, send }),
          risks: buildRisks({ receive, send }),
          confidence: packageConfidence(send.concat(receive)),
          score: myNet - fair.gapPct * 0.05 + (helpsThin ? 1.5 : 0),
        });
      }
    }

    perTeam.sort((a, b) => b.score - a.score);
    results.push(...perTeam.slice(0, MAX_PER_TEAM));
  }

  results.sort((a, b) => b.score - a.score);
  return {
    available: true,
    reason: null,
    recommendations: results.slice(0, MAX_TOTAL).map(({ score, ...r }) => r),
  };
}

function summ(p) {
  return { id: p.id, name: p.name, position: p.position, eligiblePositions: p.eligiblePositions, projectedPoints: p.projectedPoints, weeklyProjectedPoints: p.weeklyProjectedPoints ?? null, injuryStatus: p.injuryStatus, teamAbbr: p.teamAbbr };
}

function buildWhyForMe({ myNet, helpsThin, receive, depthImpact }) {
  const reasons = [];
  reasons.push(`Adds about +${myNet} projected value to your roster.`);
  if (helpsThin) reasons.push('Addresses a thin position where you lack startable depth.');
  const gained = depthImpact.filter((d) => d.change > 0).map((d) => d.position);
  if (gained.length) reasons.push(`Improves eligibility depth at ${gained.join(', ')}.`);
  const best = [...receive].sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))[0];
  if (best) reasons.push(`${best.name} is the headline piece coming back.`);
  return reasons;
}

function buildWhyForThem({ fair, send }) {
  const reasons = [];
  if (fair.fairness === 'balanced') reasons.push('Combined value is within ~10%, so it is a reasonably even swap on paper.');
  else reasons.push('The value gap is modest, making it a plausible starting point rather than a lopsided ask.');
  const best = [...send].sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))[0];
  if (best) reasons.push(`They receive ${best.name}, a real contributor, not just filler.`);
  return reasons;
}

function buildRisks({ receive, send }) {
  const risks = [];
  const hurt = receive.filter((p) => p.injuryStatus && !['Healthy', 'ACTIVE', 'NORMAL'].includes(p.injuryStatus));
  if (hurt.length) risks.push(`Incoming injury/status risk: ${hurt.map((p) => `${p.name} (${p.injuryStatus})`).join(', ')}.`);
  if (send.length > receive.length) risks.push('You send more players than you receive; confirm you keep enough roster depth.');
  risks.push('Values are projections, not guarantees; another manager may value players differently.');
  return risks;
}

function packageConfidence(players) {
  // Confidence = fraction of involved players that have real projection data.
  const known = players.filter((p) => p.projectedPoints != null).length;
  return players.length ? Number((known / players.length).toFixed(2)) : 0;
}
