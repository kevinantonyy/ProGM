/**
 * Yahoo ADP / market-context intelligence for the Draft Helper.
 *
 * This layer compares ProGM's own ranking (the authoritative draft value) with
 * Yahoo's market average draft position (ADP). The two are kept SEPARATE: ADP
 * never changes ProGM's ranking or value — it only produces an advisory MARKET
 * LABEL so a drafter understands where the room is likely to take a player
 * relative to where ProGM values him.
 *
 * Labels (deterministic, documented thresholds; no player-specific logic):
 *   VALUE      ProGM ranks the player materially BETTER (earlier) than Yahoo
 *              ADP — i.e. the market undervalues him. (adpVsProgm >= VALUE_GAP)
 *   REACH      Yahoo ADP is materially LATER than the current pick — taking him
 *              now would be ahead of the market. (yahooAdp - currentPick >= REACH_GAP)
 *   DRAFT NOW  Strong ProGM value AND the player is unlikely to survive to the
 *              user's NEXT pick (ADP falls before nextPick, within a survival
 *              margin). Requires a known nextPick.
 *   WAIT       ProGM likes the player but ADP suggests a reasonable chance he
 *              survives to the user's next pick. Requires a known nextPick.
 *   neutral    insufficient data / confidence, or none of the above.
 *
 * adpVsProgm = yahooAdp - progmRank  (positive => market later than ProGM, i.e.
 * ProGM values him earlier/higher = a VALUE lean).
 *
 * All thresholds are exported constants so they can be tuned/backtested without
 * touching logic.
 */

export const ADP_THRESHOLDS = Object.freeze({
  VALUE_GAP: 8,        // ProGM at least this many picks earlier than ADP => VALUE
  REACH_GAP: 10,       // ADP at least this many picks later than current pick => REACH
  STRONG_VALUE_GAP: 12, // larger gap required to call it a strong-value DRAFT NOW
  SURVIVE_MARGIN: 3,   // ADP within this margin BEFORE nextPick => "won't survive"
});

// Thresholds for the ProGM-vs-Yahoo RANK comparison (ranking spots, not picks).
// Tunable + exported so the agreement bands can be adjusted/backtested later.
export const RANK_COMPARE_THRESHOLDS = Object.freeze({
  CLOSE_GAP: 5,  // |yahooRank - progmRank| <= this => "aligned"
  LARGE_GAP: 15, // gap of at least this => "significantly" more bullish
});

/**
 * Compute market context for one player. Pure + deterministic.
 *
 * @param {Object} params
 * @param {number|null} params.progmRank    ProGM Best-Available overall rank (1-based)
 * @param {number|null} params.yahooAdp     Yahoo average pick (ADP), or null
 * @param {number|null} [params.actionRank]  roster-aware board position used ONLY to gate DRAFT NOW/WAIT
 *                                          (defaults to progmRank). VALUE/REACH always use progmRank.
 * @param {number|null} [params.currentPick] current overall draft pick (live), or null
 * @param {number|null} [params.nextPick]    user's next projected overall pick, or null
 * @returns {{ adpVsProgm:number|null, label:string, reason:string }}
 */
export function computeMarketContext({ progmRank, yahooAdp, actionRank = null, currentPick = null, nextPick = null }) {
  // Insufficient data -> neutral (never fabricated).
  if (progmRank == null || yahooAdp == null) {
    return { adpVsProgm: null, label: 'neutral', reason: 'Insufficient ProGM rank or Yahoo ADP data.' };
  }

  const adpVsProgm = Number((yahooAdp - progmRank).toFixed(1));
  const { VALUE_GAP, REACH_GAP, STRONG_VALUE_GAP, SURVIVE_MARGIN } = ADP_THRESHOLDS;

  const isValue = adpVsProgm >= VALUE_GAP;         // market later than ProGM
  const isReach = currentPick != null && (yahooAdp - currentPick) >= REACH_GAP; // ADP well after now

  // DRAFT NOW / WAIT require a reliably known next pick; otherwise omit them.
  if (nextPick != null) {
    // Actionable advice uses the roster-aware board position (falls back to ProGM Rank).
    const actionGap = Number((yahooAdp - (actionRank ?? progmRank)).toFixed(1));
    const strongValue = actionGap >= STRONG_VALUE_GAP;
    // "Won't survive" => ADP lands before the user's next pick (minus margin).
    const unlikelyToSurvive = yahooAdp <= (nextPick - SURVIVE_MARGIN);
    const likelyToSurvive = yahooAdp >= nextPick;

    if (strongValue && unlikelyToSurvive) {
      return {
        adpVsProgm,
        label: 'DRAFT NOW',
        reason: `Strong ProGM value (ADP ${yahooAdp} vs ProGM #${progmRank}) and likely gone before your next pick (#${nextPick}).`,
      };
    }
    if (actionGap >= VALUE_GAP && likelyToSurvive) {
      return {
        adpVsProgm,
        label: 'WAIT',
        reason: `ProGM likes him, but market ADP ${yahooAdp} suggests he may last to your next pick (#${nextPick}).`,
      };
    }
  }

  if (isValue) {
    return {
      adpVsProgm,
      label: 'VALUE',
      reason: `Market undervalues: Yahoo ADP ${yahooAdp} vs ProGM #${progmRank} (+${adpVsProgm}).`,
    };
  }
  if (isReach) {
    return {
      adpVsProgm,
      label: 'REACH',
      reason: `Yahoo ADP ${yahooAdp} is ${Number((yahooAdp - currentPick).toFixed(1))} picks later than the current pick (#${currentPick}).`,
    };
  }

  return { adpVsProgm, label: 'neutral', reason: 'ProGM rank and market ADP are closely aligned.' };
}

/**
 * Deterministic ProGM-vs-Yahoo RANK comparison (independent of ADP / market
 * timing). Yahoo Rank is an EXTERNAL signal shown alongside ProGM Rank — it
 * NEVER reorders the ProGM board and does NOT affect DRAFT NOW/WAIT.
 *
 *   rankGap = yahooOverallRank - progmRank
 *     > +LARGE_GAP  => ProGM is notably more bullish (ProGM ranks him earlier)
 *     < -LARGE_GAP  => Yahoo is notably more bullish
 *     |rankGap| <= CLOSE_GAP => agreement
 *
 * @param {Object} params
 * @param {number|null} params.progmRank          ProGM board rank (1-based)
 * @param {number|null} params.yahooOverallRank   Yahoo overall (OR) rank
 * @returns {{ rankGap:number|null, agreement:string, reason:string }}
 */
export function computeRankComparison({ progmRank, yahooOverallRank }) {
  if (progmRank == null || yahooOverallRank == null) {
    return { rankGap: null, agreement: 'unknown', reason: 'Yahoo Rank unavailable for comparison.' };
  }
  const rankGap = Number((yahooOverallRank - progmRank).toFixed(0));
  const { CLOSE_GAP, LARGE_GAP } = RANK_COMPARE_THRESHOLDS;

  if (Math.abs(rankGap) <= CLOSE_GAP) {
    return { rankGap, agreement: 'aligned', reason: 'ProGM and Yahoo are closely aligned on this player.' };
  }
  if (rankGap >= LARGE_GAP) {
    return { rankGap, agreement: 'progm_higher', reason: 'ProGM is significantly higher on this player than Yahoo.' };
  }
  if (rankGap <= -LARGE_GAP) {
    return { rankGap, agreement: 'yahoo_higher', reason: 'Yahoo ranks this player significantly higher than ProGM.' };
  }
  // Between CLOSE and LARGE: a mild lean, reported directionally but softly.
  return rankGap > 0
    ? { rankGap, agreement: 'progm_lean', reason: 'ProGM is somewhat higher on this player than Yahoo.' }
    : { rankGap, agreement: 'yahoo_lean', reason: 'Yahoo is somewhat higher on this player than ProGM.' };
}
