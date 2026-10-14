/**
 * Fantasy Basketball workspace adapter.
 *
 * Produces a workspace object for the Fantasy Basketball UI, sourced from
 * Yahoo + Tank01 + the ProGM analytics engines. It deliberately does NOT
 * imitate every ESPN-only field; fields that have no genuine Yahoo/Tank01/ProGM
 * equivalent are returned as null/empty so the UI can show honest
 * unavailable/empty states rather than fabricated values.
 *
 * Data flow:
 *   Yahoo roster/settings/standings  (facts)
 *     + Tank01 stats via provider    (real NBA data)
 *     -> ProGM projections           (league-specific scoring)
 *     -> lineup optimizer / waiver / trade / roster intelligence engines
 *     -> structured workspace object -> UI (and Ask ProGM context)
 *
 * API budget: all Tank01 access goes through the cached provider layer. A
 * single workspace build fetches the player index once (cached 24h) and season
 * stats for the union of roster + available players once (cached 12h). It does
 * NOT fetch per request when the cache is warm.
 */
import {
  extractRosterPlayers,
  normalizeLeagueSettings,
  extractStandings,
  extractPlayerList,
  yahooPlayerKeysPath,
  mergeYahooPlayerMetadata,
} from './normalize.js';
import { fetchYahooDraftPool } from './yahooPlayerPool.js';
import { scoringIsSupported } from './scoring.js';
import { analyzeRoster } from './rosterAnalysis.js';
import { optimizeLineup } from './lineupOptimizer.js';
import { rankWaivers } from './waiverEngine.js';
import { buildRosterIntelligence } from './rosterIntelligence.js';
import { buildProjectionContext, canonicalIdOf } from './insights.js';
import { analyzeStartSit } from './startSit.js';
import { buildLeagueHub } from './leagueHub.js';
import { buildRankings } from './rankings.js';
import { loadBaselineReference, referenceKey, saveBaselineReference } from './baselineReference.js';
import { buildDraftBoard } from './draftHelper.js';
import { resolveRankingModel } from './rankingModel.js';
import { recommendTrades } from './tradeRecommender.js';
import { resolvePeriodWindow, playerPeriodValue } from './scheduleValue.js';
import * as providers from '../providers/index.js';

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/** Map a normalized Yahoo player (+ projection) into the UI player shape. */
function toUiPlayer(p, ctx, ownerTeam = null, periodValues = null) {
  const proj = ctx?.projectionByCanonicalId?.get(canonicalIdOf(p)) || null;
  const period = periodValues?.get(canonicalIdOf(p)) || null;
  return {
    id: p.playerKey,
    name: p.name,
    position: p.primaryPosition || (p.eligiblePositions && p.eligiblePositions[0]) || 'NBA',
    eligiblePositions: p.eligiblePositions || [],
    highResImage: ctx?.imageByCanonicalId?.get(canonicalIdOf(p)) || null,
    image: p.headshotUrl || null,
    teamAbbr: p.teamAbbr || null,
    // Per-game projected league fantasy points (ProGM). null when unavailable.
    projectedPoints: proj?.projectedPoints ?? null,
    projectionConfidence: proj?.confidence ?? null,
    projectionBreakdown: proj?.breakdown ?? null,
    lastSeasonFantasy: proj?.lastSeasonFantasy
      ? { season: proj.lastSeason?.season ?? null, ...proj.lastSeasonFantasy }
      : null,
    injuryStatus: p.status || 'Healthy',
    injuryDetail: p.statusFull || null,
    percentOwned: p.percentOwned ?? null,
    selectedPosition: p.selectedPosition || null,
    isStarting: Boolean(p.isStarting),
    ownerTeam,
    // Schedule-aware expected production over the current fantasy period.
    // null when schedule/period unavailable (never fabricated).
    weeklyProjectedPoints: period?.scheduleAware ? period.periodProjectedPoints : null,
    expectedGames: period?.scheduleAware ? period.expectedGames : null,
    // ESPN-only fields intentionally left null (never fabricated):
    proRank: null,
    percentStarted: null,
    fantasyPoints: null,
  };
}

/**
 * Wrap the base projection provider with a schedule-aware getPeriodValue so
 * Start/Sit, Rankings, and Trades can prefer expected period production.
 * Falls back cleanly (returns scheduleAware:false) when no schedule/period.
 */
function withPeriodValues(projectionProvider, { schedules, periodWindow }) {
  if (!projectionProvider) return null;
  return {
    ...projectionProvider,
    getProjectedValue: (player) => projectionProvider.getProjectedValue(player),
    getProjection: (player) => projectionProvider.getProjection(player),
    getPeriodValue(player) {
      const perGame = projectionProvider.getProjectedValue(player);
      return playerPeriodValue({
        projectedPerGame: perGame,
        teamAbbr: player.teamAbbr,
        schedules,
        periodWindow,
      });
    },
  };
}

/** Fetch a single opponent roster (Yahoo). Returns [] on failure (no fabrication). */
async function fetchOpponentRoster(yahooFantasy, accessToken, teamKey) {
  try {
    const data = await yahooFantasy(`/team/${teamKey}/roster/players`, accessToken);
    return extractRosterPlayers(data);
  } catch {
    return [];
  }
}

function extractLeaguePlayers(data) {
  const leagueNode = data?.fantasy_content?.league;
  const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
  return extractPlayerList(playersNode);
}

async function optionalPlayersRequest(yahooFantasy, accessToken, path) {
  try {
    return extractLeaguePlayers(await yahooFantasy(path, accessToken));
  } catch {
    return [];
  }
}

/**
 * Build the full basketball workspace.
 * @param {Object} params
 * @param {(path:string, token:string)=>Promise<any>} params.yahooFantasy   API helper from the route
 * @param {string} params.accessToken
 * @param {string} params.leagueKey
 * @param {string} params.teamKey     the user's team in this league
 */
export async function buildBasketballWorkspace({ yahooFantasy, accessToken, leagueKey, teamKey }) {
  // 1. League settings + standings (Yahoo facts).
  const [settingsData, standingsData, rosterData] = await Promise.all([
    yahooFantasy(`/league/${leagueKey}/settings`, accessToken),
    yahooFantasy(`/league/${leagueKey}/standings`, accessToken),
    yahooFantasy(`/team/${teamKey}/roster/players`, accessToken),
  ]);

  const league = normalizeLeagueSettings(settingsData);
  const settings = league?.settings || null;
  const standings = extractStandings(standingsData);
  let myRoster = extractRosterPlayers(rosterData);
  const myStanding = standings.find((t) => t.teamKey === teamKey) || standings.find((t) => t.isOwnedByLogin) || null;

  // 2. Yahoo returns only the first appended player sub-resource. Fetch each
  //    dataset in its own league-wide batch, then merge strictly by player_key.
  //    These fields remain Draft Helper context and never affect ProGM ranking.
  let availablePlayers = [];
  try {
    availablePlayers = await fetchYahooDraftPool(yahooFantasy, accessToken, leagueKey);
  } catch {
    availablePlayers = [];
  }

  // The status=A collection excludes rostered players. Request their metadata
  // in two exact-key batches so identity and league season remain unambiguous.
  const rosterKeys = myRoster.map((player) => player.playerKey).filter(Boolean);
  if (rosterKeys.length) {
    const [draftAnalysis, ranks] = await Promise.all([
      optionalPlayersRequest(yahooFantasy, accessToken, yahooPlayerKeysPath(leagueKey, rosterKeys, 'draft_analysis')),
      optionalPlayersRequest(yahooFantasy, accessToken, yahooPlayerKeysPath(leagueKey, rosterKeys, 'ranks')),
    ]);
    myRoster = mergeYahooPlayerMetadata(myRoster, draftAnalysis, ranks);
  }

  // 2b. Opponent rosters (Yahoo) fetched ONCE for the trade recommender +
  //     roster-strength rating. Bounded and cached by the 5-min workspace cache
  //     upstream. Each is a single Yahoo call; failures degrade to [].
  const opponentStandings = standings.filter((t) => !(t.teamKey === teamKey || t.isOwnedByLogin));
  const opponentRosterResults = await Promise.all(
    opponentStandings.map(async (t) => ({ teamKey: t.teamKey, name: t.name, players: await fetchOpponentRoster(yahooFantasy, accessToken, t.teamKey) })),
  );
  const opponentPlayersFlat = opponentRosterResults.flatMap((o) => o.players);

  // 3. Projection context for roster + available pool + opponent rosters
  //    (single cached fetch set — one identity/stats pass for everyone).
  const scoringSupported = scoringIsSupported(settings);

  // Instrument Tank01: measure requests attributable to THIS build. We snapshot
  // the counter before and after so the report can show cold vs cached cost.
  const tankBefore = providers.tank01RequestCount();
  const tankBreakdownBefore = providers.tank01RequestBreakdown();

  const ctx = await buildProjectionContext({
    season: league?.season,
    players: [...myRoster, ...availablePlayers, ...opponentPlayersFlat],
    statCategories: settings?.statCategories || [],
    scoringSupported,
  });

  // 3b. Team schedules (Tank01, cached 12h, SHARED). One orchestrated call set;
  //     the provider fetches per-NBA-team schedules and caches by season.
  let schedules = null;
  if (ctx.externalAvailable && league?.season) {
    try {
      const sched = await providers.getSchedule(league.season);
      schedules = sched?.value || null;
    } catch {
      schedules = null;
    }
  }
  const periodWindow = resolvePeriodWindow(settings);

  const baseProvider = ctx.projectionProvider;
  const projectionProvider = schedules && periodWindow ? withPeriodValues(baseProvider, { schedules, periodWindow }) : baseProvider;

  // Per-player schedule-aware period values, keyed by canonicalId.
  const periodValues = new Map();
  if (schedules && periodWindow && baseProvider) {
    for (const p of [...myRoster, ...availablePlayers, ...opponentPlayersFlat]) {
      periodValues.set(canonicalIdOf(p), playerPeriodValue({
        projectedPerGame: baseProvider.getProjectedValue(p),
        teamAbbr: p.teamAbbr,
        schedules,
        periodWindow,
      }));
    }
  }

  // 4. Analytics engines (all provider-independent, degrade cleanly).
  const analysis = settings ? analyzeRoster({ players: myRoster, settings }) : null;
  const lineup = settings ? optimizeLineup({ players: myRoster, settings, projectionProvider }) : null;
  const intelligence = analysis ? buildRosterIntelligence({ players: myRoster, analysis, projectionProvider, lineup }) : null;
  const waivers = rankWaivers({ availablePlayers, projectionProvider, rosterAnalysis: analysis, myRoster, settings });
  const startSit = settings ? analyzeStartSit({ players: myRoster, settings, projectionProvider }) : null;
  const leagueHub = buildLeagueHub({ standings, myTeamKey: teamKey });

  // Draft Helper (research tool). Pool = available free agents (availability is a
  // Yahoo fact here since they came from the status=A query) + my rostered players
  // (marked "rostered"). availabilityOf distinguishes the two honestly so the UI
  // never implies a rostered player is draftable.
  const availableKeys = new Set(availablePlayers.map((p) => p.playerKey));
  const draftPool = [...availablePlayers, ...myRoster];
  // Frozen overall-rank reference: captured pre-draft, reused while others draft.
  const rankingModel = resolveRankingModel();
  const refKey = referenceKey({ leagueKey, season: league?.season, statCategories: settings?.statCategories, rankingModel });
  const draftBoard = settings
    ? buildDraftBoard({
        players: draftPool,
        settings,
        projectionProvider,
        poolComplete: league?.draftStatus === 'predraft',
        baselineReference: loadBaselineReference(providers.cache, refKey),
        rosterAnalysis: analysis,
        availabilityOf: (p) => availableKeys.has(p.playerKey),
        currentSeason: league?.season || null, // for current-season Yahoo rank
        rankingModel,
      })
    : { available: false, availabilityKnown: true, board: [], noData: [], note: 'League settings unavailable.' };
  if (draftBoard.baselineReference) saveBaselineReference(providers.cache, refKey, draftBoard.baselineReference);
  delete draftBoard.baselineReference; // internal; not sent to the client
  // Rankings tab shares the Draft Helper's baseline: same Overall Rank per player.
  const overallRanks = new Map((draftBoard.board || []).map((row) => [row.playerKey, row.overallRank]));
  const rankings = buildRankings({
    players: availablePlayers,
    projectionProvider,
    overallRanks,
    rankScope: draftBoard.rankScope || null,
    rankingModel: draftBoard.rankingModel || null,
    sortBy: overallRanks.size ? 'overall' : (periodWindow ? 'period' : 'projected'),
  });

  // 4b. AI trade recommender (ProGM-generated + scored). Uses uiPlayer shapes so
  //     it can read weeklyProjectedPoints. Opponent rosters mapped to uiPlayers.
  const uiRosterForTrades = myRoster.map((p) => toUiPlayer(p, ctx, null, periodValues));
  const opponentsForTrades = opponentRosterResults.map((o) => ({
    teamKey: o.teamKey,
    name: o.name,
    roster: o.players.map((p) => toUiPlayer(p, ctx, o.name, periodValues)),
  }));
  const recommendedTrades = settings
    ? recommendTrades({ settings, myRoster: uiRosterForTrades, opponents: opponentsForTrades, analysis })
    : { available: false, reason: 'League settings unavailable.', recommendations: [] };

  // 5. Team Rating (league-relative). Blend standings rank with projected
  //    roster strength now that we have opponent projected values (real data).
  const opponentProjectedValues = opponentsForTrades.map((o) => o.roster.reduce((s, p) => s + (p.projectedPoints || 0), 0)).filter((v) => v > 0);
  const rating = buildTeamRating({ myRoster, projectionProvider, standings, myStanding, opponentProjectedValues });

  const tankAfter = providers.tank01RequestCount();
  const tankBreakdownAfter = providers.tank01RequestBreakdown();
  const tankBreakdownDelta = Object.fromEntries(
    Object.keys(tankBreakdownAfter).filter((k) => k !== 'total').map((k) => [k, Math.max(0, (tankBreakdownAfter[k] || 0) - (tankBreakdownBefore[k] || 0))]),
  );

  // 6. Assemble the workspace object (UI + Ask ProGM contract).
  const uiRoster = myRoster.map((p) => toUiPlayer(p, ctx, null, periodValues));
  const totalProjected = uiRoster.reduce((s, p) => s + (p.projectedPoints || 0), 0);
  const projectedKnown = uiRoster.filter((p) => p.projectedPoints != null).length;

  return {
    provider: 'yahoo',
    externalData: {
      available: ctx.externalAvailable,
      reason: ctx.reason,
      diagnostic: ctx.diagnostic || null,
      freshness: ctx.freshness,
      identity: ctx.identityDiagnostics,
      providerStatus: ctx.providerStatus,
    },
    connection: {
      leagueKey,
      teamKey,
      leagueId: league?.leagueId || null,
      leagueName: league?.name || 'NBA League',
      season: league?.season || null,
      teamName: myStanding?.name || 'My Team',
      sport: 'basketball',
    },
    settings: settings
      ? {
          scoringType: settings.scoringLabel || settings.scoringFormat,
          scoringFormat: settings.scoringFormat,
          statCategories: settings.statCategories,
          rosterSlots: settings.rosterSlots,
          teamCount: standings.length || settings.raw?.maxTeams || null,
          tradeDeadline: settings.raw?.tradeEndDate || null,
        }
      : null,
    myTeam: { id: teamKey, name: myStanding?.name || 'My Team', roster: uiRoster },
    standings: standings.map((t) => ({
      id: t.teamKey,
      name: t.name,
      rank: t.rank,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      pointsFor: t.pointsFor,
      isMine: t.teamKey === teamKey || t.isOwnedByLogin,
      manager: t.managerName,
    })),
    opponents: standings.filter((t) => !(t.teamKey === teamKey || t.isOwnedByLogin)).map((t) => ({ id: t.teamKey, name: t.name, rank: t.rank })),
    lineup,
    intelligence,
    waivers,
    startSit,
    leagueHub,
    rankings,
    draftBoard,
    recommendedTrades,
    rating,
    scheduleAware: Boolean(schedules && periodWindow),
    period: periodWindow ? { start: periodWindow.startYmd, end: periodWindow.endYmd, lineupFormat: settings?.lineupFormat || 'unknown' } : null,
    analysis: {
      rosterSize: uiRoster.length,
      totalProjected: ctx.externalAvailable ? Math.round(totalProjected * 10) / 10 : null,
      projectedKnown,
      injured: myRoster.filter((p) => p.status && !['Healthy', 'ACTIVE', 'NORMAL', ''].includes(p.status)).length,
    },
    // Tank01 usage attributable to this workspace build (0 when fully cached).
    tankUsage: {
      requestsThisBuild: Math.max(0, tankAfter - tankBefore),
      breakdown: tankBreakdownDelta, // per-endpoint attribution for THIS build
      opponentRostersFetched: opponentRosterResults.length, // Yahoo, not Tank01
      scheduleFetched: Boolean(schedules),
    },
  };
}

/**
 * Basketball Team Rating — transparent and league-relative.
 *
 * Methodology (documented, no fabrication):
 *   - When projections are available: teamProjectedValue = sum of each rostered
 *     player's projected per-game league fantasy points (unknown players
 *     contribute 0 to the sum but are counted so the number isn't overstated).
 *     The rating is that value scaled to 0-99 RELATIVE to the strongest team in
 *     THIS league's standings by points-for is NOT used; instead we rank the
 *     user's projected value against a league baseline derived from standings.
 *   - Primary signal is the league rank from Yahoo standings (a real, league-
 *     relative fact), mapped to a 40-99 band.
 *   - OPTIONAL roster-strength signal: when projected values for the other
 *     rosters are supplied (opponentProjectedValues), we blend 60% standings
 *     rank + 40% projected roster strength. We never fetch opponent rosters here
 *     (Tank01 budget) nor invent a baseline; without them the rating is rank-only.
 *   - When projections are unavailable: rating is null (shown as Unavailable).
 *
 * The result is explicitly labeled in the UI as league-relative ("Nth of M"),
 * never implied to be a universal/objective score.
 */
function buildTeamRating({ myRoster, projectionProvider, standings, myStanding, opponentProjectedValues = null }) {
  const hasProjections = Boolean(projectionProvider?.getProjection);
  const teamCount = standings.length || null;
  const rank = myStanding?.rank ?? null;

  if (!hasProjections) {
    return {
      available: false,
      overall: null,
      rank,
      teamCount,
      basis: 'unavailable',
      note: 'Team Rating needs projection data (connect an NBA stats provider).',
    };
  }

  // Sum projected per-game value across the roster (unknown -> 0, counted).
  let sum = 0;
  let known = 0;
  for (const p of myRoster) {
    const proj = projectionProvider.getProjection(p);
    if (proj?.projectedPoints != null) { sum += proj.projectedPoints; known += 1; }
  }
  const projectedValue = Math.round(sum * 10) / 10;

  // League-relative percentile from the user's standings rank (a real fact).
  // rank 1 -> ~99, last -> ~40, linear. This is explicitly league-relative.
  let rankScore = null;
  if (rank && teamCount && teamCount > 1) {
    const pct = 1 - (rank - 1) / (teamCount - 1); // 1.0 for first, 0 for last
    rankScore = 40 + pct * 59; // 40-99 band
  }

  // Roster-strength component (ProGM calculation), OPTIONAL. It is only used
  // when the caller supplies projected values for the other teams' rosters
  // (opponentProjectedValues). We do NOT fetch/derive those here because it
  // exceeds the Tank01 request budget for a single workspace build, and we will
  // not invent a baseline. When present, roster strength = this roster's
  // projected value vs the league-average projected value, mapped to a 40-99
  // band centered on 70 (average). See buildBasketballWorkspace wiring (task 12).
  let strengthScore = null;
  if (Array.isArray(opponentProjectedValues) && opponentProjectedValues.length > 0 && known > 0) {
    const all = [projectedValue, ...opponentProjectedValues.filter((v) => typeof v === 'number')];
    const avg = all.reduce((s, v) => s + v, 0) / all.length;
    if (avg > 0) {
      const ratio = projectedValue / avg;
      strengthScore = Math.max(40, Math.min(99, 70 * ratio));
    }
  }

  // Blend: when both signals exist, 60% standings rank (results so far) + 40%
  // projected roster strength (forward-looking). Otherwise use whichever exists.
  let overall = null;
  let basis;
  if (rankScore != null && strengthScore != null) {
    overall = Math.round(0.6 * rankScore + 0.4 * strengthScore);
    basis = 'blend_rank_and_roster_strength';
  } else if (rankScore != null) {
    overall = Math.round(rankScore);
    basis = 'league_relative_rank';
  } else if (strengthScore != null) {
    overall = Math.round(strengthScore);
    basis = 'roster_strength_only';
  } else {
    basis = 'insufficient_data';
  }

  return {
    available: true,
    overall, // league-relative, may be null if neither signal available
    rank,
    teamCount,
    projectedValue,
    projectedKnown: known,
    rosterSize: myRoster.length,
    basis,
    components: {
      standingsRankScore: rankScore != null ? Math.round(rankScore) : null,
      rosterStrengthScore: strengthScore != null ? Math.round(strengthScore) : null,
    },
    note: overall != null
      ? `League-relative rating${basis === 'blend_rank_and_roster_strength' ? ' blending current standings (60%) with projected roster strength (40%)' : basis === 'league_relative_rank' ? ' from your current standings position' : ' from projected roster strength'}${rank && teamCount ? ` (rank ${rank} of ${teamCount})` : ''}. Projected roster value ${projectedValue} pts/game across ${known}/${myRoster.length} players with data.`
      : 'Neither a standings rank nor a projected roster baseline is available, so a league-relative rating cannot be shown yet.',
  };
}
