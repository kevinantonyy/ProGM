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
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${parsed.sportCode}/seasons/${parsed.season}/segments/0/leagues/${parsed.leagueId}?view=mTeam&view=mRoster&view=mSettings`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 401 || response.status === 403) throw new Error('This ESPN league is private. Use manual roster import instead.');
  if (!response.ok) throw new Error(response.status === 404 ? 'ESPN league not found' : 'ESPN could not load this league');
  const data = await response.json();
  const positionNames = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
  const teams = (data.teams || []).map(team => ({
    id: team.id,
    name: team.name || [team.location, team.nickname].filter(Boolean).join(' ') || `Team ${team.id}`,
    wins: team.record?.overall?.wins || 0,
    losses: team.record?.overall?.losses || 0,
    roster: (team.roster?.entries || []).map(entry => {
      const player = entry.playerPoolEntry?.player;
      if (!player?.fullName) return null;
      const seasonProjection = (player.stats || []).find(stat => stat.seasonId === parsed.season && stat.statSourceId === 1 && stat.statSplitTypeId === 0);
      const seasonActual = (player.stats || []).find(stat => stat.seasonId === parsed.season && stat.statSourceId === 0 && stat.statSplitTypeId === 0);
      return { id: player.id, name: player.fullName, position: positionNames[player.defaultPositionId] || 'FLEX', proTeamId: player.proTeamId, projectedPoints: Number(seasonProjection?.appliedTotal || 0), fantasyPoints: Number(seasonActual?.appliedTotal || 0), percentOwned: Number(player.ownership?.percentOwned || 0), injuryStatus: player.injuryStatus || 'ACTIVE', lineupSlotId: entry.lineupSlotId };
    }).filter(Boolean),
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
    const rosterNames = team.roster.map(player => typeof player === 'string' ? player : player.name);
    const sync = league.sport === 'basketball' ? await replaceRoster(req.userId, rosterNames) : { matched: [], unmatched: rosterNames };
    await pool.execute(
      `INSERT INTO espn_connections (user_id, league_id, season, team_id, league_name, team_name, roster_names, sport, league_data)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET league_id=EXCLUDED.league_id, season=EXCLUDED.season,
       team_id=EXCLUDED.team_id, league_name=EXCLUDED.league_name, team_name=EXCLUDED.team_name,
       roster_names=EXCLUDED.roster_names, sport=EXCLUDED.sport, league_data=EXCLUDED.league_data, updated_at=CURRENT_TIMESTAMP`,
      [req.userId, league.leagueId, league.season, team.id, league.leagueName, team.name, JSON.stringify(rosterNames), league.sport, JSON.stringify(league)]
    );
    res.json({ connected: true, leagueName: league.leagueName, teamName: team.name, ...sync });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/status', authenticate, async (req, res) => {
  const [rows] = await pool.execute('SELECT league_id, season, sport, team_id, league_name, team_name, roster_names, updated_at FROM espn_connections WHERE user_id = ?', [req.userId]);
  res.json({ connected: rows.length > 0, connection: rows[0] || null });
});

router.get('/football', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM espn_connections WHERE user_id = ? AND sport = ?', [req.userId, 'football']);
    if (!rows.length) return res.status(404).json({ error: 'Connect an ESPN football league first' });
    const connection = rows[0];
    let league = connection.league_data;
    if (!league?.teams?.length) league = await fetchLeague(connection.league_id, connection.season, 'football');
    const myTeam = league.teams.find(team => team.id === connection.team_id);
    if (!myTeam) return res.status(404).json({ error: 'Your ESPN team was not found' });
    const opponents = league.teams.filter(team => team.id !== myTeam.id);
    const candidates = opponents.flatMap(team => team.roster.map(player => ({ ...player, ownerTeam: team.name, ownerTeamId: team.id })));
    const suggestions = myTeam.roster.flatMap(give => candidates
      .filter(receive => receive.position === give.position && receive.projectedPoints > give.projectedPoints * 1.08)
      .sort((a, b) => (a.projectedPoints - give.projectedPoints) - (b.projectedPoints - give.projectedPoints))
      .slice(0, 1)
      .map(receive => ({ give, receive, confidence: Math.min(92, Math.round(62 + (receive.projectedPoints - give.projectedPoints) / 5)), reasoning: `${receive.name} projects for ${Math.round(receive.projectedPoints - give.projectedPoints)} more season points at ${give.position}. Target ${receive.ownerTeam} with a balanced package around ${give.name}.` })))
      .sort((a, b) => b.confidence - a.confidence).slice(0, 6);
    const totalProjected = myTeam.roster.reduce((sum, player) => sum + player.projectedPoints, 0);
    res.json({ connection: { leagueId: connection.league_id, leagueName: connection.league_name, season: connection.season, teamName: connection.team_name }, myTeam, opponents: opponents.map(({ roster, ...team }) => ({ ...team, rosterSize: roster.length })), suggestions, analysis: { rosterSize: myTeam.roster.length, totalProjected: Math.round(totalProjected * 10) / 10, avgProjected: myTeam.roster.length ? Math.round(totalProjected / myTeam.roster.length * 10) / 10 : 0, injured: myTeam.roster.filter(player => !['ACTIVE', 'NORMAL'].includes(player.injuryStatus)).length } });
  } catch (error) {
    console.error('Failed to load ESPN football workspace:', error);
    res.status(500).json({ error: 'Could not load ESPN football data' });
  }
});

router.post('/manual-import', authenticate, async (req, res) => {
  try {
    const names = Array.isArray(req.body?.playerNames) ? req.body.playerNames : String(req.body?.playerNames || '').split(/[\n,]/);
    const sync = await replaceRoster(req.userId, names);
    res.json({ imported: sync.matched.length, ...sync });
  } catch { res.status(500).json({ error: 'Could not import this roster' }); }
});

export default router;
