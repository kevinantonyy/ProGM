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
import { extractUserLeagues, extractUserTeams } from '../services/fantasy/normalize.js';
import { buildBasketballWorkspace } from '../services/fantasy/basketballWorkspace.js';
import { orderLeaguesForDisplay, chooseDefaultLeague } from '../services/fantasy/leagueOrdering.js';
import { cache } from '../services/providers/index.js';

const router = Router();
const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

// Short-lived cache for the assembled workspace so tab switches / re-renders
// don't rebuild (and don't hit Yahoo/Tank01) repeatedly. Keyed per user+league.
const WORKSPACE_TTL = 5 * 60 * 1000;

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

    // Newest season first, deduped by stable key, with season labels. The
    // client may pass its remembered selection so we can compute the default
    // that yields to a newer season when one appears.
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

export default router;
