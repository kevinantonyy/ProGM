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
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/${parsed.sportCode}/seasons/${parsed.season}/segments/0/leagues/${parsed.leagueId}?view=mTeam&view=mRoster&view=mSettings&view=mDraftDetail&view=mMatchup&view=mSchedule&view=mScoreboard&view=mTransactions2&view=kona_player_info`;
  const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, sortPercOwned: { sortPriority: 1, sortAsc: false }, limit: 500 } };
  const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Fantasy-Filter': JSON.stringify(filter) } });
  if (response.status === 401 || response.status === 403) throw new Error('This ESPN league is private. ProGM can only sync leagues ESPN exposes publicly.');
  if (!response.ok) throw new Error(response.status === 404 ? 'ESPN league not found' : 'ESPN could not load this league');
  const data = await response.json();
  const teams = (data.teams || []).map(team => ({ id: team.id, name: team.name || [team.location, team.nickname].filter(Boolean).join(' ') || `Team ${team.id}`, wins: team.record?.overall?.wins || 0, losses: team.record?.overall?.losses || 0, ties: team.record?.overall?.ties || 0, pointsFor: Number(team.record?.overall?.pointsFor || 0), pointsAgainst: Number(team.record?.overall?.pointsAgainst || 0), playoffSeed: team.playoffSeed || null, roster: (team.roster?.entries || []).map(entry => mapPlayer(entry.playerPoolEntry, parsed, entry.lineupSlotId, 'ONTEAM')).filter(Boolean) }));
  const rosteredIds = new Set(teams.flatMap(team => team.roster.map(player => player.id)));
  const playerPool = (data.players || []).map(entry => mapPlayer(entry, parsed, null, entry.status)).filter(Boolean);
  const playersById = new Map([...playerPool, ...teams.flatMap(team => team.roster)].map(player => [player.id, player]));
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const draftPicks = (data.draftDetail?.picks || []).map(pick => ({ overallPick: pick.overallPickNumber, round: pick.roundId, roundPick: pick.roundPickNumber, playerId: pick.playerId, playerName: playersById.get(pick.playerId)?.name || `Player ${pick.playerId}`, position: playersById.get(pick.playerId)?.position || '', teamId: pick.teamId, teamName: teamsById.get(pick.teamId)?.name || `Team ${pick.teamId}` })).sort((a, b) => b.overallPick - a.overallPick);
  const schedule = (data.schedule || []).map(matchup => ({ id: matchup.id, period: matchup.matchupPeriodId, winner: matchup.winner || 'UNDECIDED', home: { teamId: matchup.home?.teamId, teamName: teamsById.get(matchup.home?.teamId)?.name || 'TBD', score: Number(matchup.home?.totalPoints || 0) }, away: { teamId: matchup.away?.teamId, teamName: teamsById.get(matchup.away?.teamId)?.name || 'TBD', score: Number(matchup.away?.totalPoints || 0) } })).filter(matchup => matchup.home.teamId || matchup.away.teamId);
  const activity = (data.transactions || []).flatMap(transaction => (transaction.items || []).map(item => ({ id: `${transaction.id}-${item.playerId || item.teamId || 'item'}`, date: transaction.proposedDate || transaction.processDate || transaction.scoringPeriodId || null, type: item.type || transaction.type || 'TRANSACTION', playerName: playersById.get(item.playerId)?.name || null, fromTeam: teamsById.get(item.fromTeamId)?.name || null, toTeam: teamsById.get(item.toTeamId)?.name || teamsById.get(transaction.teamId)?.name || null }))).slice(0, 20);
  return { leagueId: parsed.leagueId, season: parsed.season, sport: parsed.sport, suggestedTeamId: parsed.suggestedTeamId, leagueName: data.settings?.name || `ESPN League ${parsed.leagueId}`, teams, availablePlayers: playerPool.filter(player => !rosteredIds.has(player.id) && player.availability !== 'ONTEAM'), settings: simplifySettings(data.settings), draft: { drafted: Boolean(data.draftDetail?.drafted), inProgress: Boolean(data.draftDetail?.inProgress), picks: draftPicks }, hub: { currentPeriod: Number(data.status?.currentMatchupPeriod || data.scoringPeriodId || 1), schedule, activity, fetchedAt: new Date().toISOString() } };
}

function positionNeeds(roster, sport) {
  const targets = sport === 'football' ? { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, 'D/ST': 1 } : { PG: 3, SG: 3, SF: 3, PF: 3, C: 3 };
  const counts = roster.reduce((all, player) => ({ ...all, [player.position]: (all[player.position] || 0) + 1 }), {});
  return Object.entries(targets).sort((a, b) => (b[1] - (counts[b[0]] || 0)) - (a[1] - (counts[a[0]] || 0))).map(([position]) => position);
}

function playerValue(player) {
  return Math.max(1, player.projectedPoints || 0) + Math.max(0, player.percentOwned || 0) * 0.12 + (player.proRank ? Math.max(0, 100 - player.proRank) * 0.08 : 0);
}

function packages(players, sizes = [1, 2]) {
  const pool = [...players].sort((a, b) => playerValue(b) - playerValue(a)).slice(0, 14);
  const result = sizes.includes(1) ? pool.map(player => [player]) : [];
  if (sizes.includes(2)) for (let first = 0; first < pool.length; first += 1) for (let second = first + 1; second < pool.length; second += 1) result.push([pool[first], pool[second]]);
  return result;
}

function buildTradePackages(myTeam, opponents, sport) {
  const myNeeds = positionNeeds(myTeam.roster, sport).slice(0, 3);
  const myPackages = packages(myTeam.roster);
  const results = [];
  const seen = new Set();
  for (const opponent of opponents) {
    const theirNeeds = positionNeeds(opponent.roster, sport).slice(0, 3);
    const teamResults = [];
    for (const send of myPackages) for (const receive of packages(opponent.roster)) {
      if (send.length === 1 && receive.length === 1) continue;
      const sentValue = send.reduce((sum, player) => sum + playerValue(player), 0);
      const receivedValue = receive.reduce((sum, player) => sum + playerValue(player), 0);
      const difference = Math.abs(sentValue - receivedValue) / Math.max(sentValue, receivedValue);
      if (difference > 0.075) continue;
      const helpsMe = receive.some(player => myNeeds.includes(player.position));
      const helpsThem = send.some(player => theirNeeds.includes(player.position));
      if (!helpsMe || !helpsThem) continue;
      const key = `${send.map(player => player.id).sort().join('-')}|${receive.map(player => player.id).sort().join('-')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      teamResults.push({ send, receive, opponentTeam: opponent.name, sentValue: Math.round(sentValue * 10) / 10, receivedValue: Math.round(receivedValue * 10) / 10, valueDifferencePercent: Math.round(difference * 1000) / 10, confidence: Math.round(92 - difference * 200), reasoning: `You address ${receive.find(player => myNeeds.includes(player.position))?.position || 'depth'}, while ${opponent.name} receives help at ${send.find(player => theirNeeds.includes(player.position))?.position || 'a need'}. The projected package values are within ${Math.round(difference * 1000) / 10}%.` });
    }
    results.push(...teamResults.sort((a, b) => b.confidence - a.confidence).slice(0, 3));
  }
  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

function buildWorkspace(connection, league) {
  const myTeam = league.teams.find(team => team.id === connection.team_id);
  if (!myTeam) throw new Error('Your ESPN team was not found');
  const opponents = league.teams.filter(team => team.id !== myTeam.id);
  const trades = buildTradePackages(myTeam, opponents, league.sport);
  const needs = positionNeeds(myTeam.roster, league.sport);
  const available = [...(league.availablePlayers || [])].filter(player => player.projectedPoints || player.percentOwned || player.proRank);
  const waivers = available.map(player => { const samePosition = myTeam.roster.filter(item => item.position === player.position).sort((a, b) => playerValue(a) - playerValue(b)); const drop = samePosition[0] || [...myTeam.roster].sort((a, b) => playerValue(a) - playerValue(b))[0] || null; const netGain = drop ? player.projectedPoints - drop.projectedPoints : 0; return { ...player, score: netGain * 3 + player.percentOwned / 5 + Math.max(0, 12 - needs.indexOf(player.position) * 2), drop, netGain: Math.round(netGain * 10) / 10, reasoning: drop ? `Add ${player.name} and drop ${drop.name}. This keeps the roster balanced at ${player.position} and projects a ${netGain >= 0 ? '+' : ''}${netGain.toFixed(1)} point change.` : '' }; }).filter(player => player.drop && player.netGain > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  const totalRostered = league.teams.reduce((sum, team) => sum + team.roster.length, 0);
  const draftAvailable = Boolean(league.draft?.inProgress || (!league.draft?.drafted && totalRostered === 0));
  const draft = draftAvailable ? available.map(player => ({ ...player, draftScore: player.projectedPoints + (player.proRank ? Math.max(0, 220 - player.proRank) : 0) + Math.max(0, 45 - needs.indexOf(player.position) * 8), reasoning: `${player.proRank ? `ESPN expert rank #${player.proRank}` : 'Projection and league-value pick'}; adjusted for your league scoring and the live draft board.` })).sort((a, b) => b.draftScore - a.draftScore).slice(0, 30) : [];
  const totalProjected = myTeam.roster.reduce((sum, player) => sum + player.projectedPoints, 0);
  const standings = [...league.teams].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor).map((team, index) => ({ ...team, rank: index + 1, roster: undefined }));
  const maxPoints = Math.max(1, ...league.teams.map(team => team.pointsFor || 0));
  const powerRankings = league.teams.map(team => { const games = team.wins + team.losses + team.ties; const winRate = games ? (team.wins + team.ties * 0.5) / games : 0; return { id: team.id, name: team.name, wins: team.wins, losses: team.losses, score: Math.round((winRate * 65 + (team.pointsFor / maxPoints) * 35) * 10) / 10, pointsFor: team.pointsFor }; }).sort((a, b) => b.score - a.score).map((team, index) => ({ ...team, rank: index + 1 }));
  const currentPeriod = league.hub?.currentPeriod || 1;
  const leagueHub = { currentPeriod, weeklyMatchups: (league.hub?.schedule || []).filter(matchup => matchup.period === currentPeriod), schedule: league.hub?.schedule || [], standings, powerRankings, draftRecap: [...(league.draft?.picks || [])].sort((a, b) => a.overallPick - b.overallPick), activity: league.hub?.activity || [], fetchedAt: league.hub?.fetchedAt || null };
  return { connection: { leagueId: connection.league_id, leagueName: connection.league_name, season: connection.season, teamName: connection.team_name, sport: league.sport }, myTeam, opponents: opponents.map(({ roster, ...team }) => ({ ...team, rosterSize: roster.length })), players: league.teams.flatMap(team => team.roster.map(player => ({ ...player, ownerTeam: team.name }))).sort((a, b) => b.projectedPoints - a.projectedPoints), suggestions: trades, waiverSuggestions: waivers, draftRecommendations: draft, draftAvailable, draftStatus: { inProgress: Boolean(league.draft?.inProgress), completed: !draftAvailable && totalRostered > 0, picks: league.draft?.picks || [] }, leagueHub, needs, settings: league.settings || {}, analysis: { rosterSize: myTeam.roster.length, totalProjected: Math.round(totalProjected * 10) / 10, avgProjected: myTeam.roster.length ? Math.round(totalProjected / myTeam.roster.length * 10) / 10 : 0, injured: myTeam.roster.filter(player => !['ACTIVE', 'NORMAL'].includes(player.injuryStatus)).length } };
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
    let league = connection.league_data;
    if (req.query.refresh === 'true' || !league?.teams?.length) {
      try { league = await fetchLeague(connection.league_id, connection.season, sport); await pool.execute('UPDATE espn_connections SET league_data = ?::jsonb, updated_at=CURRENT_TIMESTAMP WHERE user_id = ? AND sport = ?', [JSON.stringify(league), req.userId, sport]); }
      catch (refreshError) { if (!league?.teams?.length) throw refreshError; }
    }
    res.json(buildWorkspace(connection, league));
  } catch (error) { console.error('Failed to load ESPN workspace:', error); res.status(/Connect an ESPN|not found/.test(error.message) ? 404 : 500).json({ error: error.message || 'Could not load ESPN league data' }); }
});

export default router;
