import { Router } from 'express';
import pool from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

function validSeason(value) {
  const season = Number(value);
  return Number.isInteger(season) && season >= 2018 && season <= new Date().getFullYear() + 1 ? season : null;
}

function parseLeagueInput(input, season, requestedSport) {
  let leagueId = String(input || '').trim();
  let sport = requestedSport === 'football' ? 'football' : 'basketball';
  let parsedSeason = season;
  let suggestedTeamId = null;
  if (/^https?:\/\//i.test(leagueId)) {
    try {
      const url = new URL(leagueId);
      leagueId = url.searchParams.get('leagueId') || '';
      parsedSeason = url.searchParams.get('seasonId') || season;
      suggestedTeamId = Number(url.searchParams.get('teamId')) || null;
      if (url.pathname.includes('/football/')) sport = 'football';
      if (url.pathname.includes('/basketball/')) sport = 'basketball';
    } catch { throw new Error('Enter a valid ESPN Fantasy URL or league ID'); }
  }
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error('Enter a valid ESPN league ID or team URL');
  const validYear = validSeason(parsedSeason);
  if (!validYear) throw new Error('Enter a valid ESPN season');
  return { leagueId, season: validYear, sport, sportCode: sport === 'football' ? 'ffl' : 'fba', suggestedTeamId };
}

async function fetchLeague(leagueInput, season, requestedSport) {
  const parsed = parseLeagueInput(leagueInput, season, requestedSport);
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${parsed.sportCode}/seasons/${parsed.season}/segments/0/leagues/${parsed.leagueId}?view=mTeam&view=mRoster`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 401 || response.status === 403) throw new Error('This ESPN league is private. Use manual roster import instead.');
  if (!response.ok) throw new Error(response.status === 404 ? 'ESPN league not found' : 'ESPN could not load this league');
  const data = await response.json();
  const teams = (data.teams || []).map(team => ({
    id: team.id,
    name: team.name || [team.location, team.nickname].filter(Boolean).join(' ') || `Team ${team.id}`,
    roster: (team.roster?.entries || []).map(entry => entry.playerPoolEntry?.player?.fullName).filter(Boolean),
  }));
  return { leagueId: parsed.leagueId, season: parsed.season, sport: parsed.sport, suggestedTeamId: parsed.suggestedTeamId, leagueName: data.settings?.name || `ESPN League ${parsed.leagueId}`, teams };
}

async function replaceRoster(userId, playerNames) {
  const cleanNames = [...new Set(playerNames.map(name => String(name).trim()).filter(Boolean))].slice(0, 15);
  if (!cleanNames.length) return { matched: [], unmatched: [] };
  const [players] = await pool.execute('SELECT id, name FROM players WHERE LOWER(name) = ANY(?)', [cleanNames.map(name => name.toLowerCase())]);
  const byName = new Map(players.map(player => [player.name.toLowerCase(), player]));
  const matched = cleanNames.filter(name => byName.has(name.toLowerCase()));
  const unmatched = cleanNames.filter(name => !byName.has(name.toLowerCase()));
  await pool.execute('DELETE FROM rosters WHERE user_id = ?', [userId]);
  for (const name of matched) {
    await pool.execute('INSERT INTO rosters (user_id, player_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [userId, byName.get(name.toLowerCase()).id]);
  }
  return { matched, unmatched };
}

router.post('/preview', async (req, res) => {
  try { res.json(await fetchLeague(req.body?.leagueId, req.body?.season, req.body?.sport)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/connect', authenticate, async (req, res) => {
  try {
    const league = await fetchLeague(req.body?.leagueId, req.body?.season, req.body?.sport);
    const team = league.teams.find(item => item.id === Number(req.body?.teamId));
    if (!team) return res.status(400).json({ error: 'Select a valid ESPN team' });
    const sync = league.sport === 'basketball' ? await replaceRoster(req.userId, team.roster) : { matched: [], unmatched: team.roster };
    await pool.execute(
      `INSERT INTO espn_connections (user_id, league_id, season, team_id, league_name, team_name, roster_names, sport)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)
       ON CONFLICT (user_id) DO UPDATE SET league_id=EXCLUDED.league_id, season=EXCLUDED.season,
       team_id=EXCLUDED.team_id, league_name=EXCLUDED.league_name, team_name=EXCLUDED.team_name,
       roster_names=EXCLUDED.roster_names, sport=EXCLUDED.sport, updated_at=CURRENT_TIMESTAMP`,
      [req.userId, league.leagueId, league.season, team.id, league.leagueName, team.name, JSON.stringify(team.roster), league.sport]
    );
    res.json({ connected: true, leagueName: league.leagueName, teamName: team.name, ...sync });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/status', authenticate, async (req, res) => {
  const [rows] = await pool.execute('SELECT league_id, season, sport, team_id, league_name, team_name, roster_names, updated_at FROM espn_connections WHERE user_id = ?', [req.userId]);
  res.json({ connected: rows.length > 0, connection: rows[0] || null });
});

router.post('/manual-import', authenticate, async (req, res) => {
  try {
    const names = Array.isArray(req.body?.playerNames) ? req.body.playerNames : String(req.body?.playerNames || '').split(/[\n,]/);
    const sync = await replaceRoster(req.userId, names);
    res.json({ imported: sync.matched.length, ...sync });
  } catch { res.status(500).json({ error: 'Could not import this roster' }); }
});

export default router;
