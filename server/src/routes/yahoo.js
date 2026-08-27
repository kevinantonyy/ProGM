import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';

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
  if (!response.ok) throw new Error(data.error_description || data.error || 'Yahoo token exchange failed');
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
  const tokens = await exchangeToken({
    grant_type: 'refresh_token',
    redirect_uri: config().redirectUri,
    refresh_token: connection.refresh_token,
  });
  return saveTokens(userId, tokens, connection.refresh_token);
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
  const response = await fetch(`${FANTASY_URL}${path}${path.includes('?') ? '&' : '?'}format=json`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.description || 'Yahoo Fantasy API request failed');
  return data;
}

router.get('/status', authenticate, async (req, res) => {
  const [rows] = await pool.execute('SELECT updated_at FROM yahoo_connections WHERE user_id = ?', [req.userId]);
  res.json({ configured: configured(), connected: rows.length > 0, updatedAt: rows[0]?.updated_at || null });
});

router.post('/auth-url', authenticate, async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Yahoo integration is not configured yet' });
  const state = crypto.randomBytes(32).toString('base64url');
  await pool.execute('DELETE FROM yahoo_oauth_states WHERE expires_at < NOW()');
  await pool.execute(
    'INSERT INTO yahoo_oauth_states (state_hash, user_id, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL \'10 minutes\')',
    [stateHash(state), req.userId]
  );
  const params = new URLSearchParams({ client_id: config().clientId, redirect_uri: config().redirectUri, response_type: 'code', state });
  res.json({ url: `${AUTH_URL}?${params}` });
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
    await saveTokens(userId, tokens);
    redirect.searchParams.set('yahoo', 'connected');
  } catch (error) {
    redirect.searchParams.set('yahoo', 'error');
    redirect.searchParams.set('message', error.message);
  }
  res.redirect(redirect.toString());
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
    res.status(502).json({ error: error.message });
  }
});

router.delete('/connection', authenticate, async (req, res) => {
  await pool.execute('DELETE FROM yahoo_connections WHERE user_id = ?', [req.userId]);
  res.status(204).end();
});

export default router;
