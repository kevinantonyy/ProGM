import { Router } from 'express';
import pool from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const POSITIONS = { football: { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' }, basketball: { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' } };

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
  const year = Number(parsedSeason);
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error('Enter a valid ESPN league ID or team URL');
  if (!Number.isInteger(year) || year < 2018 || year > new Date().getFullYear() + 1) throw new Error('Enter a valid ESPN season');
  return { leagueId, season: year, sport, sportCode: sport === 'football' ? 'ffl' : 'fba', suggestedTeamId };
}

function mapPlayer(raw, parsed, lineupSlotId = null, status = null) {
  const player = raw?.player || raw;
  if (!player?.fullName) return null;
  const projection = (player.stats || []).find(stat => stat.seasonId === parsed.season && stat.statSourceId === 1 && stat.statSplitTypeId === 0);
  const actual = (player.stats || []).find(stat => stat.seasonId === parsed.season && stat.statSourceId === 0 && stat.statSplitTypeId === 0);
  const proRank = Object.values(player.draftRanksByRankType || {}).map(item => Number(item?.rank)).filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
  return { id: player.id, name: player.fullName, position: POSITIONS[parsed.sport][player.defaultPositionId] || 'FLEX', proTeamId: player.proTeamId, projectedPoints: Number(projection?.appliedTotal || 0), fantasyPoints: Number(actual?.appliedTotal || 0), percentOwned: Number(player.ownership?.percentOwned || 0), percentStarted: Number(player.ownership?.percentStarted || 0), injuryStatus: player.injuryStatus || 'ACTIVE', lineupSlotId, availability: status || raw?.status || 'UNKNOWN', proRank };
}

function simplifySettings(settings = {}) {
  return {
    scoringType: settings.scoringSettings?.scoringType || 'League scoring',
    scoringItems: (settings.scoringSettings?.scoringItems || []).filter(item => Number(item.points) !== 0).slice(0, 12).map(item => ({ statId: item.statId, points: Number(item.points) })),
    rosterSlots: settings.rosterSettings?.lineupSlotCounts || {},
    teamCount: settings.size || null,
    draftType: settings.draftSettings?.type || settings.draftSettings?.draftType || 'League draft',
  };
}

async function fetchLeague(input, season, requestedSport) {
  const parsed = parseLeagueInput(input, season, requestedSport);
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${parsed.sportCode}/seasons/${parsed.season}/segments/0/leagues/${parsed.leagueId}?view=mTeam&view=mRoster&view=mSettings&view=kona_player_info`;
  const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, sortPercOwned: { sortPriority: 1, sortAsc: false }, limit: 500 } };
  const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Fantasy-Filter': JSON.stringify(filter) } });
  if (response.status === 401 || response.status === 403) throw new Error('This ESPN league is private. ProGM can only sync leagues ESPN exposes publicly.');
  if (!response.ok) throw new Error(response.status === 404 ? 'ESPN league not found' : 'ESPN could not load this league');
  const data = await response.json();
  const teams = (data.teams || []).map(team => ({ id: team.id, name: team.name || [team.location, team.nickname].filter(Boolean).join(' ') || `Team ${team.id}`, wins: team.record?.overall?.wins || 0, losses: team.record?.overall?.losses || 0, roster: (team.roster?.entries || []).map(entry => mapPlayer(entry.playerPoolEntry, parsed, entry.lineupSlotId, 'ONTEAM')).filter(Boolean) }));
  const rosteredIds = new Set(teams.flatMap(team => team.roster.map(player => player.id)));
  const playerPool = (data.players || []).map(entry => mapPlayer(entry, parsed, null, entry.status)).filter(Boolean);
  return { leagueId: parsed.leagueId, season: parsed.season, sport: parsed.sport, suggestedTeamId: parsed.suggestedTeamId, leagueName: data.settings?.name || `ESPN League ${parsed.leagueId}`, teams, availablePlayers: playerPool.filter(player => !rosteredIds.has(player.id) && player.availability !== 'ONTEAM'), settings: simplifySettings(data.settings) };
}

function positionNeeds(roster, sport) {
  const targets = sport === 'football' ? { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, 'D/ST': 1 } : { PG: 3, SG: 3, SF: 3, PF: 3, C: 3 };
  const counts = roster.reduce((all, player) => ({ ...all, [player.position]: (all[player.position] || 0) + 1 }), {});
  return Object.entries(targets).sort((a, b) => (b[1] - (counts[b[0]] || 0)) - (a[1] - (counts[a[0]] || 0))).map(([position]) => position);
}

function buildWorkspace(connection, league) {
  const myTeam = league.teams.find(team => team.id === connection.team_id);
  if (!myTeam) throw new Error('Your ESPN team was not found');
  const opponents = league.teams.filter(team => team.id !== myTeam.id);
  const opponentPlayers = opponents.flatMap(team => team.roster.map(player => ({ ...player, ownerTeam: team.name, ownerTeamId: team.id })));
  const trades = myTeam.roster.flatMap(give => opponentPlayers.filter(receive => receive.position === give.position && receive.projectedPoints > give.projectedPoints * 1.08).sort((a, b) => (a.projectedPoints - give.projectedPoints) - (b.projectedPoints - give.projectedPoints)).slice(0, 1).map(receive => ({ give, receive, confidence: Math.min(92, Math.round(62 + (receive.projectedPoints - give.projectedPoints) / 5)), reasoning: `${receive.name} is a projected upgrade at ${give.position} in your league's scoring. ${receive.ownerTeam} is the manager to approach.` }))).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  const needs = positionNeeds(myTeam.roster, league.sport);
  const available = [...(league.availablePlayers || [])].filter(player => player.projectedPoints || player.percentOwned || player.proRank);
  const waivers = available.map(player => { const drop = myTeam.roster.filter(item => item.position === player.position).sort((a, b) => a.projectedPoints - b.projectedPoints)[0] || null; return { ...player, score: player.projectedPoints + player.percentOwned / 4 + Math.max(0, 18 - needs.indexOf(player.position) * 3) - (['OUT', 'INJURY_RESERVE'].includes(player.injuryStatus) ? 25 : 0), drop, reasoning: `${player.position} is ${needs.slice(0, 3).includes(player.position) ? 'a roster need' : 'useful depth'} for your lineup. ${player.percentOwned.toFixed(1)}% rostered with ${player.projectedPoints.toFixed(1)} projected points${drop ? `; compare against ${drop.name}` : ''}.` }; }).sort((a, b) => b.score - a.score).slice(0, 20);
  const draft = available.map(player => ({ ...player, draftScore: player.projectedPoints + (player.proRank ? Math.max(0, 220 - player.proRank) : 0) + Math.max(0, 45 - needs.indexOf(player.position) * 8), reasoning: `${player.proRank ? `ESPN expert rank #${player.proRank}` : 'Projection and roster-demand pick'}; ${player.position} ranks ${Math.max(1, needs.indexOf(player.position) + 1)} among your current positional needs.` })).sort((a, b) => b.draftScore - a.draftScore).slice(0, 30);
  const totalProjected = myTeam.roster.reduce((sum, player) => sum + player.projectedPoints, 0);
  return { connection: { leagueId: connection.league_id, leagueName: connection.league_name, season: connection.season, teamName: connection.team_name, sport: league.sport }, myTeam, opponents: opponents.map(({ roster, ...team }) => ({ ...team, rosterSize: roster.length })), players: league.teams.flatMap(team => team.roster.map(player => ({ ...player, ownerTeam: team.name }))).sort((a, b) => b.projectedPoints - a.projectedPoints), suggestions: trades, waiverSuggestions: waivers, draftRecommendations: draft, needs, settings: league.settings || {}, analysis: { rosterSize: myTeam.roster.length, totalProjected: Math.round(totalProjected * 10) / 10, avgProjected: myTeam.roster.length ? Math.round(totalProjected / myTeam.roster.length * 10) / 10 : 0, injured: myTeam.roster.filter(player => !['ACTIVE', 'NORMAL'].includes(player.injuryStatus)).length } };
}

router.post('/preview', async (req, res) => { try { res.json(await fetchLeague(req.body?.leagueId, req.body?.season, req.body?.sport)); } catch (error) { res.status(400).json({ error: error.message }); } });

router.post('/connect', authenticate, async (req, res) => {
  try {
    const league = await fetchLeague(req.body?.leagueId, req.body?.season, req.body?.sport);
    const team = league.teams.find(item => item.id === Number(req.body?.teamId));
    if (!team) return res.status(400).json({ error: 'Select a valid ESPN team' });
    await pool.execute(`INSERT INTO espn_connections (user_id, league_id, season, team_id, league_name, team_name, roster_names, sport, league_data) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb) ON CONFLICT (user_id, sport) DO UPDATE SET league_id=EXCLUDED.league_id, season=EXCLUDED.season, team_id=EXCLUDED.team_id, league_name=EXCLUDED.league_name, team_name=EXCLUDED.team_name, roster_names=EXCLUDED.roster_names, league_data=EXCLUDED.league_data, updated_at=CURRENT_TIMESTAMP`, [req.userId, league.leagueId, league.season, team.id, league.leagueName, team.name, JSON.stringify(team.roster.map(player => player.name)), league.sport, JSON.stringify(league)]);
    res.json({ connected: true, leagueName: league.leagueName, teamName: team.name, sport: league.sport });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/status', authenticate, async (req, res) => { const [rows] = await pool.execute('SELECT league_id, season, sport, team_id, league_name, team_name, roster_names, updated_at FROM espn_connections WHERE user_id = ? ORDER BY sport', [req.userId]); res.json({ connected: rows.length > 0, connections: rows, connection: rows[0] || null }); });

router.get('/workspace/:sport', authenticate, async (req, res) => {
  try {
    const sport = ['football', 'basketball'].includes(req.params.sport) ? req.params.sport : null;
    if (!sport) return res.status(400).json({ error: 'Choose football or basketball' });
    const [rows] = await pool.execute('SELECT * FROM espn_connections WHERE user_id = ? AND sport = ?', [req.userId, sport]);
    if (!rows.length) return res.status(404).json({ error: `Connect an ESPN ${sport} league first` });
    const connection = rows[0];
    let league;
    try { league = await fetchLeague(connection.league_id, connection.season, sport); await pool.execute('UPDATE espn_connections SET league_data = ?::jsonb, updated_at=CURRENT_TIMESTAMP WHERE user_id = ? AND sport = ?', [JSON.stringify(league), req.userId, sport]); }
    catch (refreshError) { league = connection.league_data; if (!league?.teams?.length) throw refreshError; }
    res.json(buildWorkspace(connection, league));
  } catch (error) { console.error('Failed to load ESPN workspace:', error); res.status(/Connect an ESPN|not found/.test(error.message) ? 404 : 500).json({ error: error.message || 'Could not load ESPN league data' }); }
});

export default router;
