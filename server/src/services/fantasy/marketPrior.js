/**
 * Market-implied preseason estimate for players with NO usable NBA stats in the
 * projection season (incoming rookies, or veterans absent last season).
 *
 * Why: ProGM's projection is built from last completed season's per-game
 * stats, so a player who did not play has no stat line, no provider match and
 * would otherwise be dropped from the board ("no data"). Yahoo's ADP already
 * encodes the market's view of expected role and minutes. We calibrate that
 * view onto ProGM's OWN scale using players who do have stats:
 *
 *   perGameFantasyPoints ~= intercept + slope * ln(ADP)      (ordinary least squares)
 *
 * fitted per call on the same pool and in this league's scoring, so league
 * scoring is preserved (the target is the league-scored per-game projection).
 *
 * Guard rails (no arbitrary overrides):
 *  - needs >= MIN_POINTS calibration players with real stats and an ADP;
 *  - slope must be negative (earlier pick => more points) and the fit must
 *    explain a meaningful share of variance (R^2 >= MIN_R2);
 *  - the estimate is only produced inside the calibrated ADP range (no
 *    extrapolation), never below 0, and is capped at the best calibration
 *    player's projection;
 *  - confidence is fixed low (ESTIMATE_CONFIDENCE) and the row is flagged
 *    `estimate: true` so every consumer can say so;
 *  - the estimate feeds ProGM's value only for these players. Because it is
 *    derived from ADP, market comparisons (VALUE/REACH/DRAFT NOW/WAIT, Yahoo
 *    rank agreement) are suppressed for them: they would be circular.
 */
export const MIN_POINTS = 40;
export const MIN_R2 = 0.25;
export const MIN_CALIBRATION_GAMES = 20;
export const ESTIMATE_CONFIDENCE = 0.3;
export const ESTIMATE_METHOD = 'market_prior_estimate';

/** Fit perGame ~ a + b*ln(adp). rows: [{ adp, perGame }]. Returns null when unreliable. */
export function fitMarketPrior(rows) {
  const pts = (rows || []).filter((r) => Number.isFinite(r?.adp) && r.adp >= 1 && Number.isFinite(r?.perGame));
  if (pts.length < MIN_POINTS) return null;
  const xs = pts.map((r) => Math.log(r.adp));
  const ys = pts.map((r) => r.perGame);
  const n = pts.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  if (!(slope < 0) || r2 < MIN_R2) return null;
  return {
    intercept: my - slope * mx,
    slope,
    r2: Number(r2.toFixed(3)),
    n,
    minAdp: Math.min(...pts.map((r) => r.adp)),
    maxAdp: Math.max(...pts.map((r) => r.adp)),
    maxPerGame: Math.max(...ys),
  };
}

/** Per-game league fantasy points implied by ADP, or null when outside the calibrated range. */
export function marketPriorPerGame(model, adp) {
  if (!model || !Number.isFinite(adp) || adp < model.minAdp || adp > model.maxAdp) return null;
  const value = model.intercept + model.slope * Math.log(adp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Number(Math.min(value, model.maxPerGame).toFixed(2));
}

/** A projection object (same shape consumers expect) built from the market prior. */
export function marketPriorProjection(model, adp, { debutYear = null, targetSeason = null } = {}) {
  const perGame = marketPriorPerGame(model, adp);
  if (perGame == null) return null;
  return {
    projectedPoints: perGame,
    perGame,
    confidence: ESTIMATE_CONFIDENCE,
    confidenceGamesPlayedShortfall: 0,
    expected: null,
    breakdown: [],
    unsupportedStats: [],
    availability: null,
    method: ESTIMATE_METHOD,
    estimate: true,
    estimateBasis: { source: 'yahoo_adp', adp, r2: model.r2, calibrationPlayers: model.n },
    history: null,
    availabilityProfile: { age: null, debutYear, ageReferenceSeason: null, targetSeason },
    lastSeasonFantasy: null,
    lastSeason: null,
    injury: null,
  };
}

/**
 * Add market-prior estimates to projectionByCanonicalId (mutates the map) for
 * canonical players that have no projection. Returns { estimateCount, model }.
 * Players with a real projection, or with a scoring-support gap, are untouched.
 */
export function applyMarketPriors({ canonical, players, projectionByCanonicalId, canonicalIdOf, seasonYear, classify = null }) {
  // `classify(canonicalEntry, yahooPlayer) -> { class, reason }` decides who may be estimated. Without it NOBODY is
  // estimated: a missing projection alone never makes someone a rookie.
  const playerById = new Map((players || []).map((p) => [canonicalIdOf(p), p]));
  const skipped = new Map();
  const adpByCanonicalId = new Map((players || []).map((p) => [canonicalIdOf(p), Number(p.yahooAdp)]));
  const calibration = [];
  for (const [id, proj] of projectionByCanonicalId) {
    const adp = adpByCanonicalId.get(id);
    const gp = proj.lastSeason?.stats?.gamesPlayed;
    if (proj.projectedPoints != null && !proj.estimate && Number.isFinite(adp) && gp >= MIN_CALIBRATION_GAMES) calibration.push({ adp, perGame: proj.projectedPoints });
  }
  const model = fitMarketPrior(calibration);
  let estimateCount = 0;
  for (const c of canonical || []) {
    const existing = projectionByCanonicalId.get(c.canonicalId);
    if (existing?.projectedPoints != null) continue;
    if (existing?.method === 'incomplete_scoring_data') continue; // scoring gap, not a stats gap
    const verdict = classify ? classify(c, playerById.get(c.canonicalId)) : { class: 'unknown', reason: 'No classifier supplied.' };
    if (verdict.class !== 'rookie_or_new_entrant') {
      skipped.set(c.canonicalId, { ...(existing || { projectedPoints: null, method: 'no_data' }), unprojectedClass: verdict.class, unprojectedReason: verdict.reason });
      continue;
    }
    if (!model) { skipped.set(c.canonicalId, { ...(existing || { projectedPoints: null, method: 'no_data' }), unprojectedClass: verdict.class, unprojectedReason: 'Rookie candidate, but no reliable ADP calibration is available.' }); continue; }
    const estimate = marketPriorProjection(model, adpByCanonicalId.get(c.canonicalId), { debutYear: null, targetSeason: Number.isInteger(seasonYear) ? seasonYear : null });
    if (!estimate) continue;
    estimate.matchMethod = c.matchMethod ?? null;
    estimate.matched = Boolean(c.matched);
    estimate.unprojectedClass = verdict.class;
    projectionByCanonicalId.set(c.canonicalId, estimate);
    estimateCount += 1;
  }
  return { estimateCount, model, skipped };
}
