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
  extractRosterPlayers, extractPlayerList, yahooPlayerKeysPath,
} from '../services/fantasy/normalize.js';
import { fetchYahooDraftPool } from '../services/fantasy/yahooPlayerPool.js';
import { buildBasketballWorkspace } from '../services/fantasy/basketballWorkspace.js';
import { orderLeaguesForDisplay, chooseDefaultLeague } from '../services/fantasy/leagueOrdering.js';
import {
  extractDraftResults, detectNewPicks, draftedPlayerKeys, removeDrafted,
  deriveDraftState, picksForTeam, deriveNextPick,
} from '../services/fantasy/draftResults.js';
import { analyzeRoster } from '../services/fantasy/rosterAnalysis.js';
import { buildDraftBoard } from '../services/fantasy/draftHelper.js';
import { resolveRankingModel } from '../services/fantasy/rankingModel.js';
import { buildProjectionContext, canonicalIdOf } from '../services/fantasy/insights.js';
import { scoringIsSupported } from '../services/fantasy/scoring.js';
import { fetchYahooDraftResults, peekYahooDraftResults } from '../services/fantasy/yahooDraftPolling.js';
import { cache } from '../services/providers/index.js';
import { loadBaselineReference, referenceKey } from '../services/fantasy/baselineReference.js';

const router = Router();
const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

// Short-lived cache for the assembled workspace so tab switches / re-renders
// don't rebuild (and don't hit Yahoo/Tank01) repeatedly. Keyed per user+league.
const WORKSPACE_TTL = 5 * 60 * 1000;
// Live-draft settings change slowly; draft results have their own league-scoped
// cache, single-flight coordinator, backoff, and circuit breaker.
const DRAFT_SETTINGS_TTL = 2 * 60 * 1000;
// Yahoo ADP / market data changes during a draft, so cache it briefly (NOT
// immutable) and share across polls/tabs. One batched request per window.
const ADP_FETCH_TTL = 60 * 1000;

/**
 * Fetch the available-player pool with ownership, Yahoo ADP, and Yahoo Rank in
 * separate batched sub-resource requests (Yahoo only returns the first appended
 * sub-resource), cached briefly and shared. Never per-player.
 */
async function fetchAvailableWithAdp(leagueKey, token) {
  const result = await cache.remember(
    `bball:availDraftMetadata:v3:${leagueKey}`,
    { provider: 'yahoo', ttl: ADP_FETCH_TTL },
    () => fetchYahooDraftPool(yahooFantasy, token, leagueKey),
  );
  return result.value;
}

async function fetchDraftSettings(leagueKey, token) {
  return cache.remember(
    `bball:draftSettings:${leagueKey}`,
    { provider: 'yahoo', ttl: DRAFT_SETTINGS_TTL },
    () => yahooFantasy(`/league/${leagueKey}/settings`, token),
  );
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

    // Return every Yahoo league, newest season first. The client groups these
    // metadata-derived seasons while keeping historical leagues selectable.
    const persisted = typeof req.query.selected === 'string' ? req.query.selected : null;
    const { selectedLeagueKey, reason, leagues: ordered } = chooseDefaultLeague(orderLeaguesForDisplay(rawLeagues), persisted);

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

    const cacheKey = `bball:workspace:${resolveRankingModel()}:${req.userId}:${leagueKey}:${teamKey}`;
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
 * and the draft is active; the server coalesces overlapping fetches and backs
 * off when Yahoo temporarily denies draft-results access.
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

    // Settings are slower-changing and tell us when draft polling is unnecessary.
    // Fetch them first through a shared single-flight cache so predraft clients do
    // not call Yahoo's draftresults endpoint every five seconds.
    const settingsResult = await fetchDraftSettings(leagueKey, token);
    const league = normalizeLeagueSettings(settingsResult.value);
    const settings = league?.settings || null;
    const rosterSlots = settings?.rosterSlots || [];
    const slotsPerTeam = rosterSlots.reduce((n, s) => n + (s.count || 0), 0);
    const expectedPicks = league?.numTeams && slotsPerTeam ? league.numTeams * slotsPerTeam : null;

    // A predraft is inactive: return once and let the client stop polling. This
    // was the production 999 pattern — draftresults was requested indefinitely
    // even though Yahoo had not made that resource available.
    if (league?.draftStatus === 'predraft') {
      return res.json({
        leagueKey,
        teamKey,
        draftState: 'predraft',
        yahooDraftStatus: league.draftStatus,
        totalPicks: 0,
        expectedPicks,
        currentPick: 1,
        nextPick: null,
        newPicks: [],
        picks: [],
        myRoster: [],
        recommendations: null,
        externalData: { available: false },
        sync: { temporaryUnavailable: false, message: 'Waiting for the Yahoo draft to start.', retryAfterMs: null },
        cache: { fetchedAt: settingsResult.meta.fetchedAt, stale: Boolean(settingsResult.meta.stale) },
      });
    }

    let draftData;
    if (league?.draftStatus === 'postdraft') {
      const cachedDraft = peekYahooDraftResults(leagueKey);
      draftData = cachedDraft
        ? { value: cachedDraft.value, meta: { fetchedAt: cachedDraft.fetchedAt, stale: true, temporaryUnavailable: false } }
        : await fetchYahooDraftResults({ leagueKey, loader: () => yahooFantasy(`/league/${leagueKey}/draftresults`, token) });
    } else {
      draftData = await fetchYahooDraftResults({ leagueKey, loader: () => yahooFantasy(`/league/${leagueKey}/draftresults`, token) });
    }

    // With no prior success, HTTP 999 returns a usable temporary response rather
    // than failing the whole workspace. The client retains its last good state.
    if (!draftData.value) {
      const fallbackState = league?.draftStatus === 'postdraft' ? 'complete' : league?.draftStatus === 'drafting' ? 'live' : 'unavailable';
      return res.json({
        leagueKey,
        teamKey,
        draftState: fallbackState,
        yahooDraftStatus: league?.draftStatus || null,
        totalPicks: knownPicks,
        expectedPicks,
        currentPick: knownPicks + 1,
        nextPick: null,
        newPicks: [],
        picks: [],
        myRoster: [],
        recommendations: null,
        externalData: { available: false },
        sync: {
          temporaryUnavailable: true,
          message: draftData.meta.message,
          retryAfterMs: draftData.meta.retryAfterMs,
          circuitOpen: draftData.meta.circuitOpen,
          stale: Boolean(draftData.meta.stale),
        },
        cache: { fetchedAt: draftData.meta.fetchedAt, stale: Boolean(draftData.meta.stale) },
      });
    }

    const picks = extractDraftResults(draftData.value);

    // Pick detection relative to what the client already has (idempotent across
    // refresh/reconnect; de-duped by player_key inside detectNewPicks).
    const prevStub = Array.from({ length: Math.min(knownPicks, picks.length) }, (_, i) => ({ playerKey: picks[i]?.playerKey }));
    const { newPicks, allPicks, totalPicks } = detectNewPicks(prevStub, picks);

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
      // Separate cached batches for ownership, ADP, and Yahoo Rank.
      availablePlayers = await fetchAvailableWithAdp(leagueKey, token);
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
      let myRosterPlayers = [];
      if (myPickKeys.size) {
        try {
          const rosterPlayersData = await yahooFantasy(yahooPlayerKeysPath(leagueKey, [...myPickKeys]), token);
          const leagueNode = rosterPlayersData?.fantasy_content?.league;
          const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
          myRosterPlayers = extractPlayerList(playersNode);
        } catch {
          // Preserve live sync if optional roster metadata is temporarily unavailable.
          myRosterPlayers = allPicks
            .filter((p) => myPickKeys.has(p.playerKey))
            .map((p) => ({ playerKey: p.playerKey, name: '', eligiblePositions: [], teamAbbr: null }));
        }
      }
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
      // Reuse the baseline captured pre-draft so Overall Rank stays stable as
      // other teams draft; without it ranks are labelled relative to available players.
      const rankingModel = resolveRankingModel();
      const refKey = referenceKey({ leagueKey, season: league?.season, statCategories: settings.statCategories, rankingModel });
      board = buildDraftBoard({
        players: availablePlayers,
        settings,
        projectionProvider,
        poolComplete: false,
        baselineReference: loadBaselineReference(cache, refKey),
        rosterAnalysis: analysis,
        availabilityOf: (p) => availableKeys.has(p.playerKey),
        currentPick,
        nextPick, // null when snake slot not reliably recoverable -> no DRAFT NOW/WAIT
        currentSeason: league?.season || null, // for current-season Yahoo rank
        rankingModel,
      });
    }

    delete board.baselineReference; // internal normalization data, not sent to the client
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
      sync: {
        temporaryUnavailable: Boolean(draftData.meta.temporaryUnavailable),
        message: draftData.meta.message || null,
        retryAfterMs: draftData.meta.retryAfterMs || null,
        circuitOpen: Boolean(draftData.meta.circuitOpen),
        stale: Boolean(draftData.meta.stale),
      },
      cache: { fetchedAt: draftData.meta.fetchedAt, stale: Boolean(draftData.meta.stale) },
    });
  } catch (error) {
    // The process-wide Yahoo guard can pause requests before draft settings or
    // results are loaded. Return a successful degradation response so clients
    // retain their last known picks/recommendations instead of clearing state.
    if (Number(error?.httpStatus) === 999) {
      return res.json({
        leagueKey,
        teamKey: typeof req.query.teamKey === 'string' && TEAM_KEY_RE.test(req.query.teamKey) ? req.query.teamKey : null,
        draftState: 'unavailable',
        totalPicks: knownPicks,
        newPicks: [],
        picks: [],
        myRoster: [],
        recommendations: null,
        externalData: { available: false },
        sync: {
          temporaryUnavailable: true,
          message: 'Yahoo draft sync is temporarily unavailable. Showing the last successful state when available.',
          retryAfterMs: error.retryAfterMs || null,
          circuitOpen: error.yahooCode === 'CIRCUIT_OPEN',
          stale: true,
        },
        cache: { fetchedAt: null, stale: true },
      });
    }
    sendError(res, error, 'Could not sync your Fantasy Basketball draft');
  }
});

export default router;
