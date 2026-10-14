/**
 * Draft Helper (research / rankings tool) for Fantasy Basketball.
 *
 * Yahoo leagues in-season are already drafted, so this is NOT a live-draft
 * autopick engine. It is a research tool that ranks players by ProGM value
 * (projection × health × league scarcity) and groups them into value tiers so a
 * manager can study relative worth for keeper/dynasty planning or next season's
 * draft. Every value comes from real projections; players without a projection
 * are listed separately as "no data", never assigned a fabricated value.
 */
import { scarcityWeights } from './playerValue.js';
import { computeAvailabilityBaseline, estimateExpectedGames } from './durability.js';
import { computeMarketContext, computeRankComparison } from './adpMarket.js';

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/**
 * Draft-value model (distinct from the trade/waiver playerValue model).
 *
 * DRAFT VALUE answers "who is worth more to draft" in Yahoo points leagues.
 * Its primary input is projected regular-season fantasy points (projected FPPG
 * x expected games), not a current-week schedule total. Components are each
 * normalized to a comparable 0..1 scale
 * BEFORE combining, so no single raw scale (e.g. raw fantasy points) can
 * dominate, then blended with fixed weights:
 *
 *   production   (0..1)  projected season fantasy points vs the pool max
 *   replacement  (0..1)  season value ABOVE the positional replacement
 *                        baseline (VORP-style): rewards players who clear the
 *                        bar at a scarce position, computed from the pool itself
 *   scarcity     (0..1)  league positional scarcity (rarer eligible slots)
 *   confidence   (0..1)  data-quality confidence (missing/thin data penalized,
 *                        never treated as zero production)
 *   roster fit   (0..1)  selected team's positional need (secondary only)
 *
 *   rawScore = 0.70*production + 0.20*replacement + 0.05*scarcity + 0.05*fit
 *   draftValue = rawScore
 *                * (CONF_FLOOR + (1-CONF_FLOOR)*confidence)   // confidence penalty
 *
 * Expected games already incorporates historical availability and an explicit
 * verified season-ending injury cap, so no separate durability or injury
 * multiplier is applied. This prevents double-counting availability risk.
 */
export const DRAFT_WEIGHTS = Object.freeze({ production: 0.70, replacement: 0.20, scarcity: 0.05, rosterFit: 0.05 });
const CONF_FLOOR = 0.9; // data quality is a restrained 0-10% adjustment, never the primary ranking signal

/** Max scarcity weight among a player's eligible positions (>=1). */
function bestScarcity(eligiblePositions, weights) {
  let best = 1;
  for (const pos of eligiblePositions || []) if (weights[pos] != null) best = Math.max(best, weights[pos]);
  return best;
}

/** Normalize scarcity weight (~1.0..1.2) into a 0..1 component. */
function scarcityComponent(scarcity, weights) {
  const vals = Object.values(weights || {});
  const maxW = vals.length ? Math.max(1, ...vals) : 1;
  if (maxW <= 1) return 0; // no positional differentiation in this league
  return Math.max(0, Math.min(1, (scarcity - 1) / (maxW - 1)));
}

/**
 * Positional replacement baselines (VORP-style) from the pool itself.
 * For each starting position, the baseline is the season production of a
 * "replacement" starter: the player ranked at (teamCount × slotsForPos). A
 * player's replacement component is how far their season value exceeds the
 * best (lowest) baseline among the positions they're eligible for, normalized
 * by the pool's spread. Entirely data-derived; no hardcoded player/position.
 *
 * @param {Array<{seasonPoints:number|null, eligiblePositions:string[]}>} rows
 * @param {Object} settings  normalized league settings
 * @returns {{ baselineByPos:Object, spread:number }}
 */
export function computeReplacementBaselines(rows, settings) {
  const startingSlots = (settings?.rosterSlots || []).filter((s) => s.isStarting);
  const teamCount = settings?.teamCount || settings?.numTeams || settings?.raw?.maxTeams || 12;
  const demand = {};
  for (const slot of startingSlots) demand[slot.position] = (demand[slot.position] || 0) + (slot.count || 0);

  const valued = rows.filter((r) => r.seasonPoints != null);
  const allVals = valued.map((r) => r.seasonPoints).sort((a, b) => b - a);
  const spread = allVals.length ? Math.max(1e-6, allVals[0] - allVals[allVals.length - 1]) : 1;

  const baselineByPos = {};
  for (const pos of Object.keys(demand)) {
    // Players eligible at this position, best-first.
    const eligible = valued
      .filter((r) => (r.eligiblePositions || []).includes(pos))
      .map((r) => r.seasonPoints)
      .sort((a, b) => b - a);
    const starters = Math.max(1, Math.round((demand[pos] || 0) * teamCount));
    // Replacement = the starter just past the last startable slot (next man up).
    const idx = Math.min(eligible.length - 1, starters);
    baselineByPos[pos] = eligible.length ? eligible[Math.max(0, idx)] : 0;
  }
  return { baselineByPos, spread };
}

/**
 * Compute a draft value + explainable component breakdown for one player.
 * Season-total anchored: never uses a games-in-window period total.
 *
 * @param {Object} params
 * @param {number|null} params.seasonPoints   projected regular-season fantasy points
 * @param {number|null} params.perGame        projected per-game fantasy points
 * @param {number|null} params.expectedGames  projected regular-season games
 * @param {number|null} params.confidence     data-quality confidence 0..1
 * @param {string[]} params.eligiblePositions
 * @param {Object} params.weights             scarcityWeights(settings)
 * @param {number} params.poolMaxSeasonPoints max season total in pool
 * @param {{baselineByPos:Object, spread:number}} params.replacement
 * @param {number} [params.rosterFitScore]     need=1, neutral=.5, surplus=0
 * @param {Object|null} [params.availabilityModel] expected-games explanation
 * @returns {{ value:number|null, components:Object }|{ value:null, components:Object }}
 */
export function computeDraftValue({ seasonPoints, perGame, expectedGames, confidence, eligiblePositions, weights, poolMaxSeasonPoints, replacement, rosterFitScore = 0.5, availabilityModel = null }) {
  if (seasonPoints == null) {
    return { value: null, components: { reason: 'no_projection' } };
  }
  // 1. Production: projected season total vs pool max (0..1).
  const production = poolMaxSeasonPoints > 0 ? Math.max(0, Math.min(1, seasonPoints / poolMaxSeasonPoints)) : 0;

  // 2. Replacement (VORP): season total above the best baseline among eligible
  //    positions, normalized by pool spread (0..1, clamped).
  let bestBaseline = Infinity;
  for (const pos of eligiblePositions || []) {
    const b = replacement?.baselineByPos?.[pos];
    if (b != null && b < bestBaseline) bestBaseline = b;
  }
  if (!Number.isFinite(bestBaseline)) bestBaseline = 0;
  const vorp = seasonPoints - bestBaseline;
  const replacementComp = Math.max(0, Math.min(1, vorp / (replacement?.spread || 1)));

  // 3. Scarcity (0..1).
  const scarcityW = bestScarcity(eligiblePositions, weights);
  const scarcityComp = scarcityComponent(scarcityW, weights);

  // 4. Confidence penalty (never zeroes real production).
  const conf = confidence == null ? 0 : Math.max(0, Math.min(1, confidence));
  const confFactor = CONF_FLOOR + (1 - CONF_FLOOR) * conf;

  // 5. Roster need is intentionally small and secondary to season production.
  const fitComp = Math.max(0, Math.min(1, Number(rosterFitScore) || 0));

  const blendedScore = DRAFT_WEIGHTS.production * production
    + DRAFT_WEIGHTS.replacement * replacementComp
    + DRAFT_WEIGHTS.scarcity * scarcityComp
    + DRAFT_WEIGHTS.rosterFit * fitComp;
  const rawScore = seasonPoints > 0 ? blendedScore : 0;

  // Scale to 0..100. Availability already affects seasonPoints through
  // expectedGames, so it is deliberately not multiplied again here.
  const value = Number((rawScore * confFactor * 100).toFixed(2));

  return {
    value,
    components: {
      perGame: Number(perGame.toFixed(2)),
      expectedGames: Number(expectedGames.toFixed(1)),
      seasonPoints: Number(seasonPoints.toFixed(1)),
      production: Number(production.toFixed(3)),
      replacement: Number(replacementComp.toFixed(3)),
      vorp: Number(vorp.toFixed(1)),
      scarcity: Number(scarcityComp.toFixed(3)),
      scarcityWeight: scarcityW,
      confidence: Number(conf.toFixed(2)),
      confidenceFactor: Number(confFactor.toFixed(3)),
      rosterFit: Number(fitComp.toFixed(2)),
      availability: availabilityModel || null,
      availabilityPenaltyAppliedAgain: false,
      rawScore: Number(rawScore.toFixed(4)),
    },
  };
}

/**
 * Assign value tiers by natural gaps in the sorted value list. A new tier
 * starts when the drop from the previous player exceeds `gapFactor` × the
 * running average gap. Purely descriptive grouping of real values.
 */
function assignTiers(sortedValued, gapFactor = 1.8) {
  if (sortedValued.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < sortedValued.length; i += 1) gaps.push(sortedValued[i - 1].value - sortedValued[i].value);
  const avgGap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
  let tier = 1;
  return sortedValued.map((p, i) => {
    if (i > 0) {
      const gap = sortedValued[i - 1].value - p.value;
      if (avgGap > 0 && gap > gapFactor * avgGap) tier += 1;
    }
    return { ...p, tier };
  });
}

/** Roster-fit label for a player against the user's thin/overloaded positions. */
function rosterFit(eligiblePositions, thinSet, overloadedSet) {
  const elig = eligiblePositions || [];
  if (elig.some((pos) => thinSet.has(pos))) return { fit: 'need', label: 'Fills a thin position on your roster' };
  if (elig.length && elig.every((pos) => overloadedSet.has(pos))) return { fit: 'surplus', label: 'You already have depth here' };
  return { fit: 'neutral', label: 'Neutral fit' };
}

function rosterFitScore(fit) {
  if (fit === 'need') return 1;
  if (fit === 'surplus') return 0;
  return 0.5;
}

function oneDecimal(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(1)) : null;
}

function seasonLabel(season) {
  const year = Number(season);
  return Number.isInteger(year) ? `${year}–${String((year + 1) % 100).padStart(2, '0')}` : String(season || 'last season');
}

function nbaStatSentence(player) {
  const last = player.lastSeasonNba;
  if (!last) return null;
  const stats = [
    last.points != null ? `${last.points} NBA points` : null,
    last.rebounds != null ? `${last.rebounds} rebounds` : null,
    last.assists != null ? `${last.assists} assists` : null,
  ].filter(Boolean);
  if (!stats.length) return null;
  const list = stats.length === 1 ? stats[0] : stats.length === 2 ? `${stats[0]} and ${stats[1]}` : `${stats[0]}, ${stats[1]}, and ${stats[2]}`;
  let sentence = `In ${seasonLabel(last.season)}, ${player.name} averaged ${list} per game.`;
  if (last.gamesPlayed != null && last.gamesPlayed < 60) sentence = sentence.replace(/\.$/, ` across ${last.gamesPlayed} games.`);
  return sentence;
}

/** Deterministic, data-backed Draft Helper recommendation (no AI call). */
export function buildDraftRecommendation({ player, overallRank, market, seasonProjectionRank, projectionCount, availabilityKnown }) {
  const rostered = availabilityKnown && player.availability !== 'available';
  let action;
  if (rostered) {
    action = `${player.name} is already rostered in this league, so do not treat this row as an available draft recommendation.`;
  } else if (market?.label === 'DRAFT NOW') {
    action = `Draft ${player.name} now; Yahoo ADP ${player.yahooAdp} suggests ${player.name} may not reach your next selection.`;
  } else if (market?.label === 'WAIT') {
    action = `Keep ${player.name} on your shortlist rather than reaching now; Yahoo ADP ${player.yahooAdp} suggests more time may be available.`;
  } else if (market?.label === 'VALUE') {
    action = `Target ${player.name} as a good value at ProGM Rank #${overallRank}; Yahoo ADP is ${player.yahooAdp}.`;
  } else if (market?.label === 'REACH') {
    action = `Consider waiting on ${player.name}; Yahoo ADP ${player.yahooAdp} is later than ProGM Rank #${overallRank}.`;
  } else {
    action = `Consider ${player.name} at ProGM Rank #${overallRank}${player.yahooAdp != null ? `, with a Yahoo ADP of ${player.yahooAdp}` : ''}.`;
  }

  const positions = (player.eligiblePositions || []).join('/') || 'their position';
  const fit = player.rosterFit === 'need'
    ? `fills a roster need at ${positions}`
    : player.rosterFit === 'surplus'
      ? `adds depth at ${positions}, where your roster is already strong`
      : `adds ${positions} depth`;
  let production;
  if (seasonProjectionRank === 1 && projectionCount > 0) {
    production = `${player.name} has the highest projected regular-season fantasy-point total among ${projectionCount} ${availabilityKnown ? 'available ' : ''}players with projections and ${fit}.`;
  } else if (seasonProjectionRank != null && projectionCount > 0) {
    production = `${player.name} projects #${seasonProjectionRank} of ${projectionCount} ${availabilityKnown ? 'available ' : ''}players in regular-season fantasy points and ${fit}.`;
  } else {
    production = `${player.name} ${fit}.`;
  }

  let context = nbaStatSentence(player);
  const baselineGames = player.availabilityModel?.baselineAvailability != null
    ? player.availabilityModel.baselineAvailability * 82
    : null;
  const materialAvailabilityRisk = player.expectedSeasonGames != null
    && baselineGames != null
    && player.expectedSeasonGames <= baselineGames - 8;
  if (player.availabilityModel?.injuryReason) {
    const injury = `${player.name}'s verified injury report indicates ${player.availabilityModel.injuryReason}, which is reflected in the expected-games estimate.`;
    context = context ? `${context} ${injury}` : injury;
  } else if (materialAvailabilityRisk) {
    const risk = `Recent availability history projects about ${Math.round(player.expectedSeasonGames)} games, adding material season-volume risk.`;
    context = context ? `${context} ${risk}` : risk;
  } else if (!context && player.lastSeasonYahooRank != null) {
    context = `Yahoo ranked ${player.name} #${player.lastSeasonYahooRank} for the ${seasonLabel(player.lastSeasonYahooRankSeason)} season.`;
  }
  return [action, production, context].filter(Boolean).join(' ');
}

/**
 * @param {Object} params
 * @param {Array} params.players             candidate pool (normalized)
 * @param {Object} params.settings           normalized league settings (for scarcity)
 * @param {Object} params.projectionProvider {getProjection, getPeriodValue?}
 * @param {Object} [params.rosterAnalysis]   analyzeRoster() result (for roster fit/need)
 * @param {(player)=>boolean} [params.availabilityOf]  returns true if the player is
 *        actually available to acquire in Yahoo. When omitted, availability is
 *        treated as UNKNOWN (never fabricated as available).
 * @param {string} [params.position]         filter to a position
 * @param {number} [params.limit]
 * @param {number|null} [params.currentPick] current overall draft pick (live) for market labels
 * @param {number|null} [params.nextPick]    user's next projected overall pick (live); enables DRAFT NOW/WAIT
 * @param {string|number|null} [params.currentSeason] Yahoo/NBA season for picking the current-season Yahoo rank
 */
export function buildDraftBoard({ players, settings, projectionProvider, rosterAnalysis = null, availabilityOf = null, position = null, limit = 1000, currentPick = null, nextPick = null, currentSeason = null }) {
  const hasProjections = Boolean(projectionProvider?.getProjection);
  const thinSet = new Set((rosterAnalysis?.positions?.thinPositions || []).map((t) => t.position));
  const overloadedSet = new Set((rosterAnalysis?.positions?.overloadedPositions || []).map((o) => o.position));
  const availabilityKnown = typeof availabilityOf === 'function';

  let pool = Array.isArray(players) ? players : [];
  if (position) pool = pool.filter((p) => (p.eligiblePositions || []).includes(position));

  const decorate = (p, extra) => {
    const fit = rosterFit(p.eligiblePositions, thinSet, overloadedSet);
    const previousSeason = Number.isFinite(Number(currentSeason)) ? String(Number(currentSeason) - 1) : null;
    const seasonRanks = p.yahooSeasonRanks || p.yahooRanks?.bySeason || {};
    return {
      playerKey: p.playerKey,
      name: p.name,
      highResImage: projectionProvider?.getHeadshotUrl?.(p) || null,
      image: p.headshotUrl || null,
      teamAbbr: p.teamAbbr || null,
      eligiblePositions: p.eligiblePositions || [],
      status: p.status || null,
      out: Boolean(p.status && OUT_STATUSES.has(p.status)),
      percentOwned: p.percentOwned ?? null, // context only
      // Yahoo MARKET data (ADP) — context only, never feeds ProGM value/ranking.
      yahooAdp: p.yahooAdp ?? null,
      yahooAvgRound: p.yahooAvgRound ?? null,
      yahooPercentDrafted: p.yahooPercentDrafted ?? null,
      // Yahoo RANK (external signal; labeled "Yahoo Rank", NOT Expert Rank).
      // Overall (OR) + current-season (S) + prior seasons for explanation only.
      // Never feeds ProGM value/ranking; comparison is attached after sorting.
      yahooOverallRank: p.yahooOverallRank ?? p.yahooRanks?.overall ?? null,
      yahooSeasonRank: currentSeason != null ? (p.yahooSeasonRanks?.[String(currentSeason)] ?? p.yahooRanks?.bySeason?.[String(currentSeason)] ?? null) : null,
      lastSeasonYahooRank: previousSeason != null ? (seasonRanks[previousSeason] ?? null) : null,
      lastSeasonYahooRankSeason: previousSeason,
      yahooPriorSeasonRanks: (p.yahooSeasonRanks || p.yahooRanks?.bySeason)
        ? Object.entries(p.yahooSeasonRanks || p.yahooRanks.bySeason)
            .filter(([yr]) => currentSeason == null || String(yr) !== String(currentSeason))
            .map(([yr, rank]) => ({ season: yr, rank }))
            .sort((a, b) => Number(b.season) - Number(a.season))
        : [],
      // Availability is a Yahoo FACT when known, otherwise explicitly unknown.
      availability: availabilityKnown ? (availabilityOf(p) ? 'available' : 'rostered') : 'unknown',
      rosterFit: fit.fit,
      rosterFitLabel: fit.label,
      ...extra,
    };
  };

  if (!hasProjections) {
    return {
      available: false,
      availabilityKnown,
      board: [],
      noData: pool.map((p) => decorate(p, {})),
      note: 'Draft research needs projection data (connect an NBA stats provider). Showing player list only.',
    };
  }

  // Pass 1: gather the league-scored per-game projection and metadata. The
  // schedule-aware current-period total remains display-only.
  const prelim = [];
  const noData = [];
  for (const p of pool) {
    const proj = projectionProvider.getProjection(p);
    const period = typeof projectionProvider.getPeriodValue === 'function' ? projectionProvider.getPeriodValue(p) : null;
    const scheduleAware = Boolean(period?.scheduleAware);
    const perGame = proj?.projectedPoints ?? null;
    const base = decorate(p, {
      projected: perGame,
      periodProjected: scheduleAware ? (period.periodProjectedPoints ?? null) : null, // display only
      expectedGames: scheduleAware ? (period.expectedGames ?? null) : null, // display only
      confidence: proj?.confidence ?? null,
      injury: proj?.injury ?? null,
      lastSeasonNba: proj?.lastSeason?.stats
        ? {
            season: proj.lastSeason.season,
            points: oneDecimal(proj.lastSeason.stats.points),
            rebounds: oneDecimal(proj.lastSeason.stats.rebounds),
            assists: oneDecimal(proj.lastSeason.stats.assists),
            gamesPlayed: oneDecimal(proj.lastSeason.stats.gamesPlayed),
          }
        : null,
      lastSeasonFantasy: proj?.lastSeasonFantasy
        ? { season: proj.lastSeason?.season ?? null, ...proj.lastSeasonFantasy }
        : null,
    });
    // Historical availability (optional) rides on the projection object.
    const history = proj?.history ?? null;
    if (perGame == null) { noData.push({ ...base, value: null }); continue; }
    prelim.push({ ...base, perGame, history });
  }

  // Expected season games use 3 completed seasons, recency weighted. Players
  // with incomplete/no history regress toward the pool availability baseline.
  const availabilityBaseline = computeAvailabilityBaseline(prelim.map((r) => r.history));
  const seasonRows = prelim.map((r) => {
    const availabilityModel = estimateExpectedGames(r.history, {
      baselineAvailability: availabilityBaseline,
      injury: r.injury,
    });
    const expectedSeasonGames = availabilityModel.expectedGames;
    return {
      ...r,
      expectedSeasonGames,
      projectedSeasonPoints: Number((r.perGame * expectedSeasonGames).toFixed(1)),
      seasonPoints: Number((r.perGame * expectedSeasonGames).toFixed(1)),
      availabilityModel,
    };
  });

  // Pool-wide references for normalization (computed from the pool itself).
  const weights = scarcityWeights(settings, seasonRows);
  const poolMaxSeasonPoints = seasonRows.reduce((m, r) => Math.max(m, r.seasonPoints), 0);
  const replacement = computeReplacementBaselines(seasonRows, settings);

  // Pass 2: compute season-total-anchored draft value + explainability.
  const valued = seasonRows.map((r) => {
    const dv = computeDraftValue({
      seasonPoints: r.seasonPoints,
      perGame: r.perGame,
      expectedGames: r.expectedSeasonGames,
      confidence: r.confidence,
      eligiblePositions: r.eligiblePositions,
      weights,
      poolMaxSeasonPoints,
      replacement,
      rosterFitScore: rosterFitScore(r.rosterFit),
      availabilityModel: r.availabilityModel,
    });
    return {
      ...r,
      value: dv.value,
      scarcity: dv.components.scarcityWeight,
      components: dv.components, // explainability: why this player ranks here
    };
  });

  // Global BEST AVAILABLE order: season production is primary; positional
  // replacement, scarcity, and roster fit are explicitly secondary. Yahoo ADP
  // remains market context only and never changes ProGM order.
  const sorted = valued.sort((a, b) => b.value - a.value).slice(0, limit);
  const projectionPool = valued
    .filter((p) => !availabilityKnown || p.availability === 'available')
    .sort((a, b) => b.projectedSeasonPoints - a.projectedSeasonPoints);
  const projectionRankByKey = new Map(projectionPool.map((p, i) => [p.playerKey, i + 1]));
  const board = assignTiers(sorted).map((p, i) => {
    const overallRank = i + 1;
    // Market context compares ProGM rank (this board position) vs Yahoo ADP.
    // DRAFT NOW/WAIT only when a reliable nextPick was supplied.
    const market = computeMarketContext({
      progmRank: overallRank,
      yahooAdp: p.yahooAdp,
      currentPick,
      nextPick,
    });
    // ProGM-vs-Yahoo RANK agreement (independent of ADP; never reorders board).
    const rankCmp = computeRankComparison({ progmRank: overallRank, yahooOverallRank: p.yahooOverallRank });
    const row = {
      overallRank, // ProGM Rank (authoritative ordering)
      ...p,
      adpVsProgm: market.adpVsProgm,
      marketLabel: market.label,
      marketReason: market.reason,
      rankGap: rankCmp.rankGap,
      rankAgreement: rankCmp.agreement,
      rankReason: rankCmp.reason,
    };
    row.recommendation = buildDraftRecommendation({
      player: row,
      overallRank,
      market,
      seasonProjectionRank: projectionRankByKey.get(row.playerKey) ?? null,
      projectionCount: projectionPool.length,
      availabilityKnown,
    });
    return row;
  });

  return {
    available: true,
    availabilityKnown,
    position: position || null,
    board,
    noData, // players with no projection, listed honestly (not ranked)
    totalEligible: pool.length,
    totalProjected: board.length,
    dataBasis: {
      facts: ['player eligibility, team, injury status, ownership, availability (Yahoo)'],
      calculations: [
        'projected season points = league-scored projected fantasy points/game × expected regular-season games',
        'expected games = recency-weighted availability from the last 3 completed seasons; incomplete history regresses toward the pool baseline',
        'draft value = normalized blend of projected season production (70%), positional replacement/VORP (20%), scarcity (5%), and roster fit (5%)',
        'confidence makes a restrained data-quality adjustment; expected games accounts for availability once, with no second durability/injury multiplier',
        'current-period schedule totals do NOT drive draft value',
        'Yahoo ADP shown as MARKET context (VALUE/REACH/DRAFT NOW/WAIT) — it never changes the ProGM ranking',
        'Yahoo Rank (overall + current season) shown as an independent EXTERNAL signal with a ProGM-vs-Yahoo agreement note — it never reorders the ProGM board',
      ],
    },
    note: availabilityKnown
      ? 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability reflects Yahoo — "available" means free to acquire now; "rostered" means owned. Players without projections are listed under "no data", never given a fake value.'
      : 'Research tool: players ranked by ProGM value under this league\'s scoring. Availability is not confirmed here, so treat this as rankings/research, not a claim that every player is draftable. Players without projections are listed under "no data", never given a fake value.',
  };
}
