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

/**
 * Compute market context for one player. Pure + deterministic.
 *
 * @param {Object} params
 * @param {number|null} params.progmRank    ProGM Best-Available overall rank (1-based)
 * @param {number|null} params.yahooAdp     Yahoo average pick (ADP), or null
 * @param {number|null} [params.currentPick] current overall draft pick (live), or null
 * @param {number|null} [params.nextPick]    user's next projected overall pick, or null
 * @returns {{ adpVsProgm:number|null, label:string, reason:string }}
 */
export function computeMarketContext({ progmRank, yahooAdp, currentPick = null, nextPick = null }) {
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
    const strongValue = adpVsProgm >= STRONG_VALUE_GAP;
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
    if (isValue && likelyToSurvive) {
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
