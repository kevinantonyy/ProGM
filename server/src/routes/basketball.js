/**
 * Fantasy Basketball route.
 *
 * The user-facing Fantasy Basketball product, powered by Yahoo + Tank01 +
 * ProGM analytics. Yahoo is invisible infrastructure here; the endpoints are
 * framed around "basketball", not "yahoo".
 *
 * Reuses the working Yahoo OAuth token plumbing (accessTokenFor / yahooFantasy)
 * exported from the yahoo route — no duplicated auth logic.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { accessTokenFor, yahooFantasy } from './yahoo.js';
import {
  extractUserLeagues, extractUserTeams, normalizeLeagueSettings,
  extractRosterPlayers, extractPlayerList, yahooDraftPlayersPath,
} from '../services/fantasy/normalize.js';
import { buildBasketballWorkspace } from '../services/fantasy/basketballWorkspace.js';
import { currentSeasonLeagues, chooseDefaultLeague } from '../services/fantasy/leagueOrdering.js';
import {
  extractDraftResults, detectNewPicks, draftedPlayerKeys, removeDrafted,
  deriveDraftState, picksForTeam, deriveNextPick,
} from '../services/fantasy/draftResults.js';
import { analyzeRoster } from '../services/fantasy/rosterAnalysis.js';
import { buildDraftBoard } from '../services/fantasy/draftHelper.js';
import { buildProjectionContext, canonicalIdOf } from '../services/fantasy/insights.js';
import { scoringIsSupported } from '../services/fantasy/scoring.js';
import { cache } from '../services/providers/index.js';

const router = Router();
const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

// Short-lived cache for the assembled workspace so tab switches / re-renders
// don't rebuild (and don't hit Yahoo/Tank01) repeatedly. Keyed per user+league.
const WORKSPACE_TTL = 5 * 60 * 1000;
// Live-draft fetch coalescing: a very short cache so overlapping ~5s polls
// (and multiple tabs) never trigger concurrent duplicate Yahoo draftresults
// calls. Short enough that each poll still sees fresh picks promptly.
const DRAFT_FETCH_TTL = 3 * 1000;
// Yahoo ADP / market data changes during a draft, so cache it briefly (NOT
// immutable) and share across polls/tabs. One batched request per window.
const ADP_FETCH_TTL = 60 * 1000;

/**
 * Fetch the available-player pool with ownership, Yahoo ADP, and Yahoo Rank in
 * one batched request (count=50), cached briefly and shared. Never per-player.
 */
async function fetchAvailableWithAdp(leagueKey, token) {
  const key = `bball:availAdp:${leagueKey}`;
  const cached = cache.get(key);
  if (cached && !cached.meta.stale) return cached.value;
  // Ownership, ADP, and Yahoo Rank arrive in the existing league-wide batch.
  // Never fetch these signals per player or let them affect ProGM ordering.
  const data = await yahooFantasy(yahooDraftPlayersPath(leagueKey), token);
  cache.set(key, data, { provider: 'yahoo', ttl: ADP_FETCH_TTL });
  return data;
}

async function requireToken(req, res) {
  const token = await accessTokenFor(req.userId);
  if (!token) { res.status(404).json({ error: 'Connect your Yahoo account to use Fantasy Basketball.' }); return null; }
  return token;
}

function sendError(res, error, fallback) {
  const status = error.httpStatus === 401 || error.httpStatus === 403 ? error.httpStatus : 502;
  res.status(status).json({ error: error.message || fallback, yahooStatus: error.httpStatus || null });
}

/**
 * GET /api/basketball/leagues
 * The user's Yahoo NBA leagues + their team in each (for the league selector).
 */
router.get('/leagues', authenticate, async (req, res) => {
  try {
    const token = await requireToken(req, res);
    if (!token) return;
    const [leaguesData, teamsData] = await Promise.all([
      yahooFantasy('/users;use_login=1/games;game_codes=nba/leagues', token),
      yahooFantasy('/users;use_login=1/games;game_codes=nba/teams', token),
    ]);
    const rawLeagues = extractUserLeagues(leaguesData);
    const teams = extractUserTeams(teamsData);
    const teamByLeague = new Map(teams.map((t) => [t.leagueKey, t]));

    // Keep only Yahoo's newest season metadata group. Status is deliberately
    // not filtered: predraft, active, and completed leagues all remain valid.
    const persisted = typeof req.query.selected === 'string' ? req.query.selected : null;
    const { selectedLeagueKey, reason, leagues: ordered } = chooseDefaultLeague(currentSeasonLeagues(rawLeagues), persisted);

    res.json({
      connected: true,
      defaultLeagueKey: selectedLeagueKey,
      defaultReason: reason,
      leagues: ordered.map((l) => ({
        leagueKey: l.leagueKey,
        name: l.name,
        season: l.season,
        seasonYear: l.seasonYear,
        seasonLabel: l.seasonLabel,
        numTeams: l.numTeams,
        scoringType: l.scoringType,
        myTeam: teamByLeague.get(l.leagueKey) || null,
      })),
    });
  } catch (error) {
    sendError(res, error, 'Could not load your Yahoo basketball leagues');
  }
});

/**
 * GET /api/basketball/workspace?leagueKey=&teamKey=&refresh=true
 * The full Fantasy Basketball workspace for one league.
 */
router.get('/workspace', authenticate, async (req, res) => {
  const leagueKey = String(req.query.leagueKey || '');
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'A valid league must be selected.' });

  try {
    const token = await requireToken(req, res);
    if (!token) return;

    // Resolve the user's team in this league (query override or discovery).
    let teamKey = typeof req.query.teamKey === 'string' && TEAM_KEY_RE.test(req.query.teamKey) ? req.query.teamKey : null;
    if (!teamKey) {
      const teamsData = await yahooFantasy('/users;use_login=1/games;game_codes=nba/teams', token);
      const teams = extractUserTeams(teamsData);
      teamKey = teams.find((t) => t.leagueKey === leagueKey)?.teamKey || null;
    }
    if (!teamKey || !TEAM_KEY_RE.test(teamKey)) {
      return res.status(404).json({ error: 'Your team was not found in this league.' });
    }

    const cacheKey = `bball:workspace:${req.userId}:${leagueKey}:${teamKey}`;
    if (req.query.refresh !== 'true') {
      const cached = cache.get(cacheKey);
      if (cached && !cached.meta.stale) return res.json({ ...cached.value, cache: { hit: true, fetchedAt: cached.meta.fetchedAt } });
    }

    const workspace = await buildBasketballWorkspace({ yahooFantasy, accessToken: token, leagueKey, teamKey });
    cache.set(cacheKey, workspace, { provider: 'yahoo', ttl: WORKSPACE_TTL });
    res.json({ ...workspace, cache: { hit: false, fetchedAt: new Date().toISOString() } });
  } catch (error) {
    sendError(res, error, 'Could not load your Fantasy Basketball workspace');
  }
});

/**
 * GET /api/basketball/draft?leagueKey=&teamKey=&knownPicks=N
 * LIVE draft sync (read-only). Returns the current draft state, newly detected
 * picks since the client's known count, the user's drafted roster so far, and
 * ProGM best-available / roster-fit recommendations recomputed over the pool of
 * players NOT yet drafted — using the league's own scoring + ProGM projections.
 *
 * This endpoint NEVER writes to Yahoo and NEVER auto-drafts. It is purely a
 * read-only advisor. The client polls (~5s) only while the Draft Helper is open
 * and the draft is active; the server coalesces overlapping fetches via a 3s
 * cache so polling cannot stampede Yahoo.
 */
router.get('/draft', authenticate, async (req, res) => {
  const leagueKey = String(req.query.leagueKey || '');
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'A valid league must be selected.' });
  const knownPicks = Number.isInteger(Number(req.query.knownPicks)) ? Math.max(0, Number(req.query.knownPicks)) : 0;

  try {
    const token = await requireToken(req, res);
    if (!token) return;

    // Resolve the user's team in this league (query override or discovery).
    let teamKey = typeof req.query.teamKey === 'string' && TEAM_KEY_RE.test(req.query.teamKey) ? req.query.teamKey : null;
    if (!teamKey) {
      const teamsData = await yahooFantasy('/users;use_login=1/games;game_codes=nba/teams', token);
      teamKey = extractUserTeams(teamsData).find((t) => t.leagueKey === leagueKey)?.teamKey || null;
    }
    if (!teamKey || !TEAM_KEY_RE.test(teamKey)) {
      return res.status(404).json({ error: 'Your team was not found in this league.' });
    }

    // Coalesce overlapping polls: one Yahoo draftresults fetch per 3s window,
    // shared across concurrent requests/tabs for this league.
    const draftCacheKey = `bball:draftresults:${leagueKey}`;
    let draftData = cache.get(draftCacheKey);
    if (!draftData || draftData.meta.stale) {
      const fresh = await yahooFantasy(`/league/${leagueKey}/draftresults`, token);
      cache.set(draftCacheKey, fresh, { provider: 'yahoo', ttl: DRAFT_FETCH_TTL });
      draftData = { value: fresh, meta: { fetchedAt: new Date().toISOString(), stale: false } };
    }
    const picks = extractDraftResults(draftData.value);

    // Pick detection relative to what the client already has (idempotent across
    // refresh/reconnect; de-duped by player_key inside detectNewPicks).
    const prevStub = Array.from({ length: Math.min(knownPicks, picks.length) }, (_, i) => ({ playerKey: picks[i]?.playerKey }));
    const { newPicks, allPicks, totalPicks } = detectNewPicks(prevStub, picks);

    // League settings (scoring + roster) — reused for state + recommendations.
    const settingsData = await yahooFantasy(`/league/${leagueKey}/settings`, token);
    const league = normalizeLeagueSettings(settingsData);
    const settings = league?.settings || null;
    const rosterSlots = settings?.rosterSlots || [];
    const slotsPerTeam = rosterSlots.reduce((n, s) => n + (s.count || 0), 0);
    const expectedPicks = league?.numTeams && slotsPerTeam ? league.numTeams * slotsPerTeam : null;

    const draftState = deriveDraftState({
      yahooDraftStatus: league?.draftStatus || null,
      totalPicks,
      expectedPicks,
    });

    // The user's roster SO FAR = players this team has drafted.
    const myPicks = picksForTeam(allPicks, teamKey);
    const myPickKeys = new Set(myPicks.map((p) => p.playerKey));

    // Available pool = league players minus everyone already drafted. We request
    // the taken+available player pool and subtract drafted keys for correctness
    // even mid-draft (Yahoo marks players taken as they are picked).
    let availablePlayers = [];
    try {
      // One batched request (count=50) for ownership, ADP, and Yahoo Rank.
      const playersData = await fetchAvailableWithAdp(leagueKey, token);
      const leagueNode = playersData?.fantasy_content?.league;
      const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
      availablePlayers = extractPlayerList(playersNode);
    } catch {
      availablePlayers = [];
    }
    const draftedKeys = draftedPlayerKeys(allPicks);
    availablePlayers = removeDrafted(availablePlayers, draftedKeys); // drop drafted immediately

    // Live market context inputs. currentPick = the pick about to be made.
    // nextPick is derived from snake order IF reliably recoverable, else null
    // (so DRAFT NOW/WAIT are omitted but VALUE/REACH remain).
    const currentPick = totalPicks + 1;
    const nextPick = deriveNextPick({ myPicks, numTeams: league?.numTeams, currentPick });

    // Recompute recommendations over the remaining pool using league scoring +
    // ProGM projections (same engines as the workspace Draft Helper). Roster-fit
    // uses the user's drafted-so-far roster.
    let board = { available: false, availabilityKnown: true, board: [], noData: [], note: 'Projections unavailable.' };
    let externalAvailable = false;
    if (settings && scoringIsSupported(settings)) {
      const myRosterPlayers = allPicks
        .filter((p) => myPickKeys.has(p.playerKey))
        .map((p) => ({ playerKey: p.playerKey, name: '', eligiblePositions: [], teamAbbr: null }));
      const ctx = await buildProjectionContext({
        season: league?.season,
        players: [...availablePlayers, ...myRosterPlayers],
        statCategories: settings.statCategories || [],
        scoringSupported: true,
      });
      externalAvailable = ctx.externalAvailable;
      const analysis = analyzeRoster({ players: myRosterPlayers, settings });
      const projectionProvider = ctx.projectionProvider && {
        getProjection: (pl) => ctx.projectionByCanonicalId.get(canonicalIdOf(pl)) || null,
        getProjectedValue: (pl) => (ctx.projectionByCanonicalId.get(canonicalIdOf(pl)) || {}).projectedPoints ?? null,
      };
      const availableKeys = new Set(availablePlayers.map((p) => p.playerKey));
      board = buildDraftBoard({
        players: availablePlayers,
        settings,
        projectionProvider,
        rosterAnalysis: analysis,
        availabilityOf: (p) => availableKeys.has(p.playerKey),
        currentPick,
        nextPick, // null when snake slot not reliably recoverable -> no DRAFT NOW/WAIT
        currentSeason: league?.season || null, // for current-season Yahoo rank
      });
    }

    return res.json({
      leagueKey,
      teamKey,
      draftState, // 'predraft' | 'live' | 'complete'
      yahooDraftStatus: league?.draftStatus || null,
      totalPicks,
      expectedPicks,
      currentPick, // overall pick about to be made
      nextPick, // user's next projected overall pick (snake), or null if unreliable
      newPicks, // picks the client had not seen yet (by player_key)
      picks: allPicks, // full ordered board (pick, round, teamKey, playerKey)
      myRoster: myPicks, // the user's current drafted roster (pick, round, playerKey)
      recommendations: board, // best-available / roster-fit over UNDRAFTED players
      externalData: { available: externalAvailable },
      cache: { fetchedAt: draftData.meta.fetchedAt },
    });
  } catch (error) {
    sendError(res, error, 'Could not sync your Fantasy Basketball draft');
  }
});

export default router;
