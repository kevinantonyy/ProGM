// Test fixture only: a Yahoo workspace shaped like buildBasketballWorkspace() output, seeded with sentinels that must NEVER reach an AI provider.
export const SENTINELS = {
  league: 'ZZ League Name', myTeam: 'ZZ My Team Name', rival1: 'ZZ Rival One', rival2: 'ZZ Rival Two', manager: 'ZZ Manager Person',
  token: 'ZZ-ACCESS-TOKEN-VALUE-0123456789abcdef0123456789', refresh: 'ZZ-REFRESH-TOKEN-VALUE', email: 'zz.user@example.com', username: 'zzuser_name',
  guid: 'ZZGUID1234567890', playerKey: '466.p.9001', leagueKey: '466.l.12345', teamKey: '466.l.12345.t.3', image: 'https://img.example/zz-headshot.png',
};

const P = (n, name, pos, team, proj, extra = {}) => ({ id: `466.p.${9000 + n}`, name, position: pos[0], eligiblePositions: pos, teamAbbr: team, projectedPoints: proj, injuryStatus: 'Healthy', percentOwned: 70 + n, isStarting: false, image: SENTINELS.image, highResImage: SENTINELS.image, ownerTeam: null, guid: SENTINELS.guid, ...extra });

export function makeYahooWorkspace(overrides = {}) {
  const roster = [P(1, 'Alpha Guard', ['PG', 'SG'], 'AAA', 38.2, { isStarting: true }), P(2, 'Bravo Wing', ['SF'], 'BBB', 30.1, { isStarting: true }), P(3, 'Charlie Big', ['C'], 'CCC', 33.4, { injuryStatus: 'INJ' }), P(4, 'Delta Bench', ['PG'], 'DDD', 31.0)];
  return {
    provider: 'yahoo',
    accessToken: SENTINELS.token, refreshToken: SENTINELS.refresh, userEmail: SENTINELS.email, yahooGuid: SENTINELS.guid,
    externalData: { available: true, identity: { debug: SENTINELS.token } },
    connection: { leagueKey: SENTINELS.leagueKey, teamKey: SENTINELS.teamKey, leagueId: '12345', leagueName: SENTINELS.league, season: '2025', teamName: SENTINELS.myTeam, sport: 'basketball' },
    settings: {
      scoringType: 'H2H Points', scoringFormat: 'points', teamCount: 3,
      statCategories: [{ statId: 12, name: 'Points Scored', abbr: 'PTS', enabled: true, pointValue: 1 }, { statId: 15, name: 'Rebounds', abbr: 'REB', enabled: true, pointValue: 1.2 }, { statId: 99, name: 'Hidden', abbr: 'HID', enabled: false, pointValue: 5 }],
      rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'SF', count: 1, isStarting: true }, { position: 'BN', count: 2, isStarting: false }],
    },
    myTeam: { id: SENTINELS.teamKey, name: SENTINELS.myTeam, roster },
    standings: [
      { id: '466.l.12345.t.1', name: SENTINELS.rival1, rank: 1, wins: 9, losses: 3, ties: 0, isMine: false, manager: SENTINELS.manager },
      { id: SENTINELS.teamKey, name: SENTINELS.myTeam, rank: 2, wins: 7, losses: 5, ties: 0, isMine: true, manager: 'Me Myself' },
      { id: '466.l.12345.t.2', name: SENTINELS.rival2, rank: 3, wins: 2, losses: 10, ties: 0, isMine: false, manager: 'Other Person' },
    ],
    rating: { overall: 61, rank: 2, teamCount: 3, basis: 'blend_rank_and_roster_strength', note: `League-relative rating for ${SENTINELS.myTeam}` },
    analysis: { rosterSize: 4, injured: 1, totalProjected: 132.7 },
    lineup: {
      projectionsAvailable: true, projectedCurrentPoints: 68.3, projectedOptimizedPoints: 71.5, projectedDifference: 3.2,
      swaps: [{ slot: 'PG', in: { playerKey: '466.p.9004', name: 'Delta Bench', proj: 31.0 }, out: { playerKey: '466.p.9001', name: 'Alpha Guard', proj: 27.8 }, projectedGain: 3.2, reasons: ['Projected +3.2 league fantasy pts/game (31.0 vs 27.8).'] }],
    },
    startSit: { benchOverStarter: [{ start: { playerKey: '466.p.9004', name: 'Delta Bench' }, sit: { playerKey: '466.p.9001', name: 'Alpha Guard' }, gain: 3.2, reason: `Delta Bench projects for 31 pts/game vs 27.8 for Alpha Guard (faces ${SENTINELS.rival1}).` }] },
    waivers: {
      projectionsAvailable: true,
      bestAvailable: [P(10, 'Echo Free', ['PF'], 'EEE', 29.9), P(11, 'Foxtrot Free', ['SG'], 'FFF', 27.5)],
      bestFit: [{ ...P(10, 'Echo Free', ['PF'], 'EEE', 29.9), fitScore: 33.1 }],
      addDrop: [{ add: { name: 'Echo Free', playerKey: '466.p.9010' }, drop: { name: 'Delta Bench', playerKey: '466.p.9004' }, netImprovement: -1.1, category: 'Watch' }],
    },
    recommendedTrades: {
      available: true,
      recommendations: [{ withTeam: SENTINELS.rival1, withTeamKey: '466.l.12345.t.1', send: [{ name: 'Bravo Wing', playerKey: '466.p.9002' }], receive: [{ name: 'Golf Star', playerKey: '466.p.9020' }], production: { net: 4.1 }, fairness: 'balanced', whyForMe: [`Adds about +4.1 projected value; ${SENTINELS.manager} is open to offers.`] }],
    },
    draftBoard: { board: [{ name: 'Golf Star', overallRank: 5, tier: 1, rosterFit: 'need', availability: 'rostered', yahooAdp: 4.4, yahooOverallRank: 9, priorityNote: `fit for ${SENTINELS.myTeam}`, playerKey: '466.p.9020' }] },
    ...overrides,
  };
}
