import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/connection.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.js';
import {
  extractUserLeagues,
  extractUserTeams,
  normalizeLeagueSettings,
  extractStandings,
  extractRosterPlayers,
  extractPlayerList,
} from '../services/fantasy/normalize.js';
import { analyzeRoster } from '../services/fantasy/rosterAnalysis.js';
import { analyzeStartSit } from '../services/fantasy/startSit.js';
import { analyzeTrade } from '../services/fantasy/tradeAnalyzer.js';
import { scoringIsSupported } from '../services/fantasy/scoring.js';
import { buildProjectionContext, withProjection, canonicalIdOf } from '../services/fantasy/insights.js';
import { optimizeLineup } from '../services/fantasy/lineupOptimizer.js';
import { rankWaivers } from '../services/fantasy/waiverEngine.js';
import { valuateTrade } from '../services/fantasy/tradeValuation.js';
import { buildRosterIntelligence } from '../services/fantasy/rosterIntelligence.js';
import { providerStatus, externalDataAvailable } from '../services/providers/index.js';

const router = Router();
const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const FANTASY_URL = 'https://fantasysports.yahooapis.com/fantasy/v2';

function config() {
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : null;
  return {
    clientId: process.env.YAHOO_CLIENT_ID,
    clientSecret: process.env.YAHOO_CLIENT_SECRET,
    redirectUri: process.env.YAHOO_REDIRECT_URI || `${renderUrl || `http://localhost:${process.env.PORT || 3005}`}/api/yahoo/callback`,
    frontendUrl: process.env.FRONTEND_URL || renderUrl || 'http://localhost:5173',
  };
}

function configured() {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
}

function stateHash(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

async function exchangeToken(body) {
  const { clientId, clientSecret } = config();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  const data = await response.json();
  if (!response.ok) {
    // Log safe diagnostics only — never the client secret, auth code, or tokens.
    console.error('[yahoo] Token exchange error', {
      endpoint: '/oauth2/get_token',
      grantType: body.grant_type || null,
      httpStatus: response.status,
      yahooCode: data.error || null,
      yahooMessage: data.error_description || null,
    });
    const error = new Error(data.error_description || data.error || 'Yahoo token exchange failed');
    error.httpStatus = response.status;
    error.yahooCode = data.error || null;
    throw error;
  }
  return data;
}

async function saveTokens(userId, tokens, previousRefreshToken = null) {
  const refreshToken = tokens.refresh_token || previousRefreshToken;
  if (!refreshToken) throw new Error('Yahoo did not return a refresh token');
  const expiresAt = new Date(Date.now() + Math.max(60, Number(tokens.expires_in || 3600) - 60) * 1000);
  await pool.execute(
    `INSERT INTO yahoo_connections (user_id, access_token, refresh_token, expires_at, yahoo_guid)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
       expires_at=EXCLUDED.expires_at, yahoo_guid=COALESCE(EXCLUDED.yahoo_guid, yahoo_connections.yahoo_guid), updated_at=CURRENT_TIMESTAMP`,
    [userId, tokens.access_token, refreshToken, expiresAt, tokens.xoauth_yahoo_guid || null]
  );
  return tokens.access_token;
}

async function accessTokenFor(userId) {
  const [rows] = await pool.execute('SELECT * FROM yahoo_connections WHERE user_id = ?', [userId]);
  if (!rows.length) return null;
  const connection = rows[0];
  if (new Date(connection.expires_at).getTime() > Date.now()) return connection.access_token;
  try {
    const tokens = await exchangeToken({
      grant_type: 'refresh_token',
      redirect_uri: config().redirectUri,
      refresh_token: connection.refresh_token,
    });
    return saveTokens(userId, tokens, connection.refresh_token);
  } catch (error) {
    // A refresh token that is invalid/revoked (e.g. minted before Fantasy provisioning)
    // will never recover. Drop the stale connection so the user re-authorizes cleanly.
    if (error.httpStatus === 400 || error.httpStatus === 401 || error.httpStatus === 403) {
      await pool.execute('DELETE FROM yahoo_connections WHERE user_id = ?', [userId]);
    }
    throw error;
  }
}

function collectResources(node, resourceKey, output = []) {
  if (Array.isArray(node)) {
    const merged = Object.assign({}, ...node.filter(item => item && typeof item === 'object' && !Array.isArray(item)));
    if (merged[`${resourceKey}_key`] && !output.some(item => item[`${resourceKey}_key`] === merged[`${resourceKey}_key`])) {
      output.push(merged);
    }
    node.forEach(item => collectResources(item, resourceKey, output));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(value => collectResources(value, resourceKey, output));
  }
  return output;
}

async function yahooFantasy(path, accessToken) {
  const endpoint = `${FANTASY_URL}${path}${path.includes('?') ? '&' : '?'}format=json`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { parseErrorBody: raw.slice(0, 300) };
  }

  if (!response.ok) {
    // Yahoo returns error details under `error` (OAuth/JSON) — never log the token.
    const yahooCode = data?.error?.code ?? data?.error ?? null;
    const yahooMessage = data?.error?.description || data?.error_description || data?.parseErrorBody || 'Yahoo Fantasy API request failed';
    console.error('[yahoo] Fantasy API error', {
      endpoint: path,
      httpStatus: response.status,
      yahooCode,
      yahooMessage,
      accessTokenPresent: Boolean(accessToken),
    });
    const error = new Error(yahooMessage);
    error.httpStatus = response.status;
    error.yahooCode = yahooCode;
    error.endpoint = path;
    throw error;
  }

  return data;
}

router.get('/status', authenticate, async (req, res) => {
  const [rows] = await pool.execute('SELECT updated_at FROM yahoo_connections WHERE user_id = ?', [req.userId]);
  res.json({
    configured: configured(),
    connected: rows.length > 0,
    updatedAt: rows[0]?.updated_at || null,
    // External NBA data availability (does not expose any keys).
    externalData: { available: externalDataAvailable(), providers: providerStatus() },
  });
});

router.post('/auth-url', optionalAuthenticate, async (req, res) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'Yahoo integration is not configured yet' });
    const state = crypto.randomBytes(32).toString('base64url');
    await pool.execute('DELETE FROM yahoo_oauth_states WHERE expires_at < NOW()');
    await pool.execute('DELETE FROM yahoo_pending_connections WHERE claim_expires_at < NOW()');
    await pool.execute(
      'INSERT INTO yahoo_oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL \'10 minutes\')',
      [stateHash(state), req.userId || null]
    );
    const params = new URLSearchParams({ client_id: config().clientId, redirect_uri: config().redirectUri, response_type: 'code', state });
    res.json({ url: `${AUTH_URL}?${params}` });
  } catch (error) {
    console.error('Failed to create Yahoo authorization request:', error);
    res.status(500).json({ error: 'Could not start Yahoo connection' });
  }
});

router.get('/callback', async (req, res) => {
  const redirect = new URL('/yahoo', config().frontendUrl);
  try {
    if (req.query.error) throw new Error(req.query.error === 'access_denied' ? 'Yahoo access was declined' : String(req.query.error));
    if (!req.query.code || !req.query.state) throw new Error('Missing Yahoo authorization response');
    const [states] = await pool.execute(
      'SELECT user_id FROM yahoo_oauth_states WHERE state_hash = ? AND expires_at > NOW()',
      [stateHash(String(req.query.state))]
    );
    if (!states.length) throw new Error('Yahoo authorization session expired; please try again');
    const userId = states[0].user_id;
    await pool.execute('DELETE FROM yahoo_oauth_states WHERE state_hash = ?', [stateHash(String(req.query.state))]);
    const tokens = await exchangeToken({ grant_type: 'authorization_code', redirect_uri: config().redirectUri, code: String(req.query.code) });
    if (userId) {
      await saveTokens(userId, tokens);
      redirect.searchParams.set('yahoo', 'connected');
    } else {
      const claim = crypto.randomBytes(32).toString('base64url');
      const tokenExpiresAt = new Date(Date.now() + Math.max(60, Number(tokens.expires_in || 3600) - 60) * 1000);
      await pool.execute(
        `INSERT INTO yahoo_pending_connections
         (claim_hash, access_token, refresh_token, expires_at, yahoo_guid, claim_expires_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP + INTERVAL '15 minutes')`,
        [stateHash(claim), tokens.access_token, tokens.refresh_token, tokenExpiresAt, tokens.xoauth_yahoo_guid || null]
      );
      redirect.pathname = '/login';
      redirect.searchParams.set('yahoo', 'pending');
      redirect.searchParams.set('claim', claim);
    }
  } catch (error) {
    redirect.searchParams.set('yahoo', 'error');
    redirect.searchParams.set('message', error.message);
  }
  res.redirect(redirect.toString());
});

router.post('/claim', authenticate, async (req, res) => {
  try {
    if (!req.body?.claim) return res.status(400).json({ error: 'Yahoo connection claim is required' });
    const claimHash = stateHash(String(req.body.claim));
    const [rows] = await pool.execute(
      'SELECT * FROM yahoo_pending_connections WHERE claim_hash = ? AND claim_expires_at > NOW()',
      [claimHash]
    );
    if (!rows.length) return res.status(410).json({ error: 'Yahoo connection expired; please connect again' });
    const pending = rows[0];
    await saveTokens(req.userId, {
      access_token: pending.access_token,
      refresh_token: pending.refresh_token,
      expires_in: Math.max(60, Math.floor((new Date(pending.expires_at).getTime() - Date.now()) / 1000)),
      xoauth_yahoo_guid: pending.yahoo_guid,
    });
    await pool.execute('DELETE FROM yahoo_pending_connections WHERE claim_hash = ?', [claimHash]);
    res.json({ connected: true });
  } catch (error) {
    console.error('Failed to claim Yahoo connection:', error);
    res.status(500).json({ error: 'Could not attach Yahoo connection to this account' });
  }
});

router.get('/fantasy', authenticate, async (req, res) => {
  try {
    const accessToken = await accessTokenFor(req.userId);
    if (!accessToken) return res.status(404).json({ error: 'Yahoo account is not connected' });
    const [leaguesData, teamsData] = await Promise.all([
      yahooFantasy('/users;use_login=1/games;game_codes=nba/leagues', accessToken),
      yahooFantasy('/users;use_login=1/games;game_codes=nba/teams', accessToken),
    ]);
    const leagues = collectResources(leaguesData, 'league').map(({ league_key, league_id, name, season, url, scoring_type, num_teams }) => ({ leagueKey: league_key, leagueId: league_id, name, season, url, scoringType: scoring_type, numTeams: num_teams }));
    const teams = collectResources(teamsData, 'team').map(({ team_key, team_id, name, url, team_logos, managers }) => ({ teamKey: team_key, teamId: team_id, name, url, teamLogos: team_logos, managers }));
    res.json({ leagues, teams });
  } catch (error) {
    // Pass through Yahoo's auth failures (401/403) instead of masking them as a gateway error.
    const status = error.httpStatus === 401 || error.httpStatus === 403 ? error.httpStatus : 502;
    res.status(status).json({
      error: error.message,
      yahooStatus: error.httpStatus || null,
      yahooCode: error.yahooCode || null,
      endpoint: error.endpoint || null,
    });
  }
});

router.delete('/connection', authenticate, async (req, res) => {
  await pool.execute('DELETE FROM yahoo_connections WHERE user_id = ?', [req.userId]);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Normalized fantasy dashboard endpoints (Phase 1-5 foundation).
// These reuse the existing OAuth token plumbing (accessTokenFor / yahooFantasy)
// and route all Yahoo parsing through services/fantasy/normalize.js.
// ---------------------------------------------------------------------------

// Yahoo keys look like "466.l.230294" (league) and "466.l.230294.t.1" (team).
// Validate strictly before interpolating into an API path.
const LEAGUE_KEY_RE = /^\d+\.l\.\d+$/;
const TEAM_KEY_RE = /^\d+\.l\.\d+\.t\.\d+$/;

function sportGameCode(sport) {
  return sport === 'nfl' ? 'nfl' : 'nba';
}

// Shared handler for surfacing Yahoo errors with safe diagnostics.
function sendYahooError(res, error, fallback = 'Could not load Yahoo data') {
  const status = error.httpStatus === 401 || error.httpStatus === 403 ? error.httpStatus : 502;
  res.status(status).json({
    error: error.message || fallback,
    yahooStatus: error.httpStatus || null,
    yahooCode: error.yahooCode || null,
    endpoint: error.endpoint || null,
  });
}

async function requireToken(req, res) {
  const accessToken = await accessTokenFor(req.userId);
  if (!accessToken) {
    res.status(404).json({ error: 'Yahoo account is not connected' });
    return null;
  }
  return accessToken;
}

/**
 * GET /api/yahoo/leagues?sport=nba
 * Returns the user's normalized leagues (each with the user's team for that league).
 */
router.get('/leagues', authenticate, async (req, res) => {
  try {
    const accessToken = await requireToken(req, res);
    if (!accessToken) return;
    const gameCode = sportGameCode(req.query.sport);
    const [leaguesData, teamsData] = await Promise.all([
      yahooFantasy(`/users;use_login=1/games;game_codes=${gameCode}/leagues`, accessToken),
      yahooFantasy(`/users;use_login=1/games;game_codes=${gameCode}/teams`, accessToken),
    ]);
    const leagues = extractUserLeagues(leaguesData);
    const teams = extractUserTeams(teamsData);
    const teamByLeague = new Map(teams.map((t) => [t.leagueKey, t]));
    const merged = leagues.map((league) => ({
      ...league,
      myTeam: teamByLeague.get(league.leagueKey) || null,
    }));
    res.json({ sport: gameCode, leagues: merged });
  } catch (error) {
    sendYahooError(res, error, 'Could not load your Yahoo leagues');
  }
});

/**
 * GET /api/yahoo/league/:leagueKey/overview
 * League meta + settings + standings + the user's team, all normalized.
 */
router.get('/league/:leagueKey/overview', authenticate, async (req, res) => {
  const { leagueKey } = req.params;
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'Invalid league key' });
  try {
    const accessToken = await requireToken(req, res);
    if (!accessToken) return;
    const [settingsData, standingsData] = await Promise.all([
      yahooFantasy(`/league/${leagueKey}/settings`, accessToken),
      yahooFantasy(`/league/${leagueKey}/standings`, accessToken),
    ]);
    const league = normalizeLeagueSettings(settingsData);
    const standings = extractStandings(standingsData);
    const myTeam = standings.find((t) => t.isOwnedByLogin) || null;
    res.json({ league, standings, myTeam });
  } catch (error) {
    sendYahooError(res, error, 'Could not load this league');
  }
});

/**
 * GET /api/yahoo/team/:teamKey/roster
 * Normalized roster for a team. Optional ?leagueKey= to include settings +
 * deterministic roster analysis and start/sit checks.
 */
router.get('/team/:teamKey/roster', authenticate, async (req, res) => {
  const { teamKey } = req.params;
  const leagueKey = req.query.leagueKey ? String(req.query.leagueKey) : teamKey.split('.t.')[0];
  if (!TEAM_KEY_RE.test(teamKey)) return res.status(400).json({ error: 'Invalid team key' });
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'Invalid league key' });
  try {
    const accessToken = await requireToken(req, res);
    if (!accessToken) return;
    const [rosterData, settingsData] = await Promise.all([
      yahooFantasy(`/team/${teamKey}/roster/players`, accessToken),
      yahooFantasy(`/league/${leagueKey}/settings`, accessToken),
    ]);
    const players = extractRosterPlayers(rosterData);
    const league = normalizeLeagueSettings(settingsData);
    const settings = league?.settings || null;
    const analysis = settings ? analyzeRoster({ players, settings }) : null;

    // Projection context (external data). Degrades to Yahoo-only when unavailable.
    const ctx = settings
      ? await buildProjectionContext({ season: league.season, players, statCategories: settings.statCategories, scoringSupported: scoringIsSupported(settings) })
      : { externalAvailable: false, projectionProvider: null, projectionByCanonicalId: new Map(), freshness: null, identityDiagnostics: null, reason: 'No league settings.' };

    // Start/Sit: deterministic checks (existing) + optimized lineup (new, when projections exist).
    const startSit = settings ? analyzeStartSit({ players, settings, projectionProvider: ctx.projectionProvider }) : null;
    const lineup = settings ? optimizeLineup({ players, settings, projectionProvider: ctx.projectionProvider }) : null;

    // Roster intelligence recommendations.
    const intelligence = analysis ? buildRosterIntelligence({ players, analysis, projectionProvider: ctx.projectionProvider, lineup }) : null;

    // Attach per-player projections (null when unavailable).
    const playersWithProjection = players.map((p) => withProjection(p, ctx));

    res.json({
      teamKey,
      leagueKey,
      settings,
      players: playersWithProjection,
      analysis,
      startSit,
      lineup,
      intelligence,
      external: {
        available: ctx.externalAvailable,
        reason: ctx.reason,
        freshness: ctx.freshness,
        identity: ctx.identityDiagnostics,
        providerStatus: ctx.providerStatus,
      },
    });
  } catch (error) {
    sendYahooError(res, error, 'Could not load this roster');
  }
});

/**
 * POST /api/yahoo/league/:leagueKey/trade/analyze
 * Body: { myTeamKey, theirTeamKey, sendKeys:[], receiveKeys:[] }
 * Returns objective before/after trade information (no fabricated values).
 */
router.post('/league/:leagueKey/trade/analyze', authenticate, async (req, res) => {
  const { leagueKey } = req.params;
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'Invalid league key' });
  const { myTeamKey, theirTeamKey, sendKeys = [], receiveKeys = [] } = req.body || {};
  if (!TEAM_KEY_RE.test(String(myTeamKey || '')) || !TEAM_KEY_RE.test(String(theirTeamKey || ''))) {
    return res.status(400).json({ error: 'Valid team keys are required' });
  }
  try {
    const accessToken = await requireToken(req, res);
    if (!accessToken) return;
    const [myRosterData, theirRosterData, settingsData] = await Promise.all([
      yahooFantasy(`/team/${myTeamKey}/roster/players`, accessToken),
      yahooFantasy(`/team/${theirTeamKey}/roster/players`, accessToken),
      yahooFantasy(`/league/${leagueKey}/settings`, accessToken),
    ]);
    const myRoster = extractRosterPlayers(myRosterData);
    const theirRoster = extractRosterPlayers(theirRosterData);
    const league = normalizeLeagueSettings(settingsData);
    const settings = league?.settings || null;
    const send = Array.isArray(sendKeys) ? sendKeys.map(String) : [];
    const receive = Array.isArray(receiveKeys) ? receiveKeys.map(String) : [];

    const result = analyzeTrade({ settings, myRoster, theirRoster, sendKeys: send, receiveKeys: receive });

    // Multi-factor valuation using projections for just the involved players.
    const sendPlayers = myRoster.filter((p) => send.includes(p.playerKey));
    const receivePlayers = theirRoster.filter((p) => receive.includes(p.playerKey));
    const ctx = settings
      ? await buildProjectionContext({ season: league.season, players: [...sendPlayers, ...receivePlayers], statCategories: settings.statCategories, scoringSupported: scoringIsSupported(settings) })
      : { externalAvailable: false, projectionProvider: null, freshness: null };
    const valuation = valuateTrade({ baseAnalysis: result, sendPlayers, receivePlayers, projectionProvider: ctx.projectionProvider });

    res.json({
      ...result,
      valuation,
      external: { available: ctx.externalAvailable, freshness: ctx.freshness },
    });
  } catch (error) {
    sendYahooError(res, error, 'Could not analyze this trade');
  }
});

/**
 * GET /api/yahoo/league/:leagueKey/players?status=FA&position=PG&search=&start=0
 * Available/free-agent player discovery from the league player pool.
 * status: 'FA' (free agents), 'W' (waivers), 'A' (available = FA+W), 'T' (taken/all).
 */
router.get('/league/:leagueKey/players', authenticate, async (req, res) => {
  const { leagueKey } = req.params;
  if (!LEAGUE_KEY_RE.test(leagueKey)) return res.status(400).json({ error: 'Invalid league key' });

  const statusMap = { FA: 'FA', W: 'W', A: 'A', T: 'T', ALL: 'ALL' };
  const status = statusMap[String(req.query.status || 'A').toUpperCase()] || 'A';
  const start = Math.max(0, Math.min(Number(req.query.start) || 0, 1000));
  const position = typeof req.query.position === 'string' && /^[A-Za-z+/]{1,6}$/.test(req.query.position) ? req.query.position : null;
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 40).replace(/[^\w .'-]/g, '') : '';

  try {
    const accessToken = await requireToken(req, res);
    if (!accessToken) return;
    const filters = [`status=${status}`, 'sort=AR', `start=${start}`, 'count=25'];
    if (position) filters.push(`position=${position}`);
    if (search) filters.push(`search=${encodeURIComponent(search)}`);
    // Request the percent_owned sub-resource so ownership % is included per player.
    const path = `/league/${leagueKey}/players;${filters.join(';')}/percent_owned`;
    const data = await yahooFantasy(path, accessToken);
    // Players collection lives under fantasy_content.league[1].players
    const leagueNode = data?.fantasy_content?.league;
    const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
    const players = extractPlayerList(playersNode);

    // Optional waiver ranking (Best Available / Best Fit). Needs league settings
    // for projections and, for Best Fit, the user's roster analysis.
    const teamKey = typeof req.query.teamKey === 'string' && TEAM_KEY_RE.test(req.query.teamKey) ? req.query.teamKey : null;
    let waivers = null;
    let external = { available: false, freshness: null };
    if (String(req.query.rank || '') === 'true') {
      const settingsData = await yahooFantasy(`/league/${leagueKey}/settings`, accessToken);
      const league = normalizeLeagueSettings(settingsData);
      const settings = league?.settings || null;
      let rosterAnalysis = null;
      if (teamKey) {
        const rosterData = await yahooFantasy(`/team/${teamKey}/roster/players`, accessToken);
        const rosterPlayers = extractRosterPlayers(rosterData);
        rosterAnalysis = settings ? analyzeRoster({ players: rosterPlayers, settings }) : null;
      }
      const ctx = settings
        ? await buildProjectionContext({ season: league.season, players, statCategories: settings.statCategories, scoringSupported: scoringIsSupported(settings) })
        : { externalAvailable: false, projectionProvider: null, freshness: null };
      waivers = rankWaivers({ availablePlayers: players, projectionProvider: ctx.projectionProvider, rosterAnalysis });
      external = { available: ctx.externalAvailable, freshness: ctx.freshness, reason: ctx.reason };
    }

    res.json({ leagueKey, status, start, count: players.length, players, waivers, external });
  } catch (error) {
    sendYahooError(res, error, 'Could not load available players');
  }
});

// Shared helpers reused by the basketball workspace route. Exporting them keeps
// the working OAuth/token logic in one place (no duplication).
export { accessTokenFor, yahooFantasy };

export default router;
