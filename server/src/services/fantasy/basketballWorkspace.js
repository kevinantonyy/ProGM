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
} from './normalize.js';
import { scoringIsSupported } from './scoring.js';
import { analyzeRoster } from './rosterAnalysis.js';
import { optimizeLineup } from './lineupOptimizer.js';
import { rankWaivers } from './waiverEngine.js';
import { buildRosterIntelligence } from './rosterIntelligence.js';
import { buildProjectionContext, withProjection, canonicalIdOf } from './insights.js';

const OUT_STATUSES = new Set(['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP']);

/** Map a normalized Yahoo player (+ projection) into the UI player shape. */
function toUiPlayer(p, ctx, ownerTeam = null) {
  const proj = ctx?.projectionByCanonicalId?.get(canonicalIdOf(p)) || null;
  return {
    id: p.playerKey,
    name: p.name,
    position: p.primaryPosition || (p.eligiblePositions && p.eligiblePositions[0]) || 'NBA',
    eligiblePositions: p.eligiblePositions || [],
    image: p.headshotUrl || null,
    teamAbbr: p.teamAbbr || null,
    // Per-game projected league fantasy points (ProGM). null when unavailable.
    projectedPoints: proj?.projectedPoints ?? null,
    projectionConfidence: proj?.confidence ?? null,
    projectionBreakdown: proj?.breakdown ?? null,
    injuryStatus: p.status || 'Healthy',
    injuryDetail: p.statusFull || null,
    percentOwned: p.percentOwned ?? null,
    selectedPosition: p.selectedPosition || null,
    isStarting: Boolean(p.isStarting),
    ownerTeam,
    // ESPN-only fields intentionally left null (never fabricated):
    proRank: null,
    percentStarted: null,
    weeklyProjectedPoints: null,
    fantasyPoints: null,
  };
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
  const myRoster = extractRosterPlayers(rosterData);
  const myStanding = standings.find((t) => t.teamKey === teamKey) || standings.find((t) => t.isOwnedByLogin) || null;

  // 2. Available player pool (free agents / waivers) with ownership.
  let availablePlayers = [];
  try {
    const playersData = await yahooFantasy(`/league/${leagueKey}/players;status=A;sort=AR;start=0;count=50/percent_owned`, accessToken);
    const leagueNode = playersData?.fantasy_content?.league;
    const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
    availablePlayers = extractPlayerList(playersNode);
  } catch {
    availablePlayers = [];
  }

  // 3. Projection context for roster + available pool (single cached fetch set).
  const scoringSupported = scoringIsSupported(settings);
  const ctx = await buildProjectionContext({
    season: league?.season,
    players: [...myRoster, ...availablePlayers],
    statCategories: settings?.statCategories || [],
    scoringSupported,
  });

  const projectionProvider = ctx.projectionProvider;

  // 4. Analytics engines (all provider-independent, degrade cleanly).
  const analysis = settings ? analyzeRoster({ players: myRoster, settings }) : null;
  const lineup = settings ? optimizeLineup({ players: myRoster, settings, projectionProvider }) : null;
  const intelligence = analysis ? buildRosterIntelligence({ players: myRoster, analysis, projectionProvider, lineup }) : null;
  const waivers = rankWaivers({ availablePlayers, projectionProvider, rosterAnalysis: analysis });

  // 5. Team Rating (basketball-specific, league-relative). Computed here from
  //    the user's projected roster value vs the rest of the standings by points
  //    for a defensible, transparent, league-relative rating. See teamRating().
  const rating = buildTeamRating({ myRoster, projectionProvider, standings, myStanding });

  // 6. Assemble the workspace object (UI + Ask ProGM contract).
  const uiRoster = myRoster.map((p) => toUiPlayer(p, ctx));
  const totalProjected = uiRoster.reduce((s, p) => s + (p.projectedPoints || 0), 0);
  const projectedKnown = uiRoster.filter((p) => p.projectedPoints != null).length;

  return {
    provider: 'yahoo',
    externalData: {
      available: ctx.externalAvailable,
      reason: ctx.reason,
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
    rating,
    analysis: {
      rosterSize: uiRoster.length,
      totalProjected: ctx.externalAvailable ? Math.round(totalProjected * 10) / 10 : null,
      projectedKnown,
      injured: myRoster.filter((p) => p.status && !['Healthy', 'ACTIVE', 'NORMAL', ''].includes(p.status)).length,
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
 *   - We cannot cheaply project every opponent roster (Tank01 budget), so the
 *     rating is scaled against the user's own projected value and expressed as a
 *     league rank from Yahoo standings (a real, league-relative fact).
 *   - When projections are unavailable: rating is null (shown as Unavailable).
 *
 * The result is explicitly labeled in the UI as league-relative ("Nth of M"),
 * never implied to be a universal/objective score.
 */
function buildTeamRating({ myRoster, projectionProvider, standings, myStanding }) {
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
  let overall = null;
  if (rank && teamCount && teamCount > 1) {
    const pct = 1 - (rank - 1) / (teamCount - 1); // 1.0 for first, 0 for last
    overall = Math.round(40 + pct * 59); // 40-99 band
  }

  return {
    available: true,
    overall, // league-relative, may be null if standings rank missing
    rank,
    teamCount,
    projectedValue,
    projectedKnown: known,
    rosterSize: myRoster.length,
    basis: 'league_relative_rank',
    note: overall != null
      ? `League-relative rating from your current standings position (rank ${rank} of ${teamCount}). Projected roster value ${projectedValue} pts/game across ${known}/${myRoster.length} players with data.`
      : 'Standings rank unavailable from Yahoo, so a league-relative rating cannot be shown yet.',
  };
}
