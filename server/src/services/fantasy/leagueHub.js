/**
 * League Hub for Fantasy Basketball.
 *
 * Builds a league overview from REAL Yahoo standings only. Every field is
 * either a Yahoo fact (wins/losses/ties/points-for, rank, manager) or a ProGM
 * calculation clearly derived from those facts (a power ranking that blends
 * record and scoring). It does NOT fabricate matchups, projections, or activity
 * that Yahoo did not provide.
 *
 * Power Ranking methodology (documented, league-relative):
 *   score = 65% winPct + 35% normalized points-for
 * Both inputs come straight from the standings. Points-for is normalized to the
 * strongest scorer in THIS league so the number is comparable within the league
 * and never implied to be universal. When a league has no games played yet
 * (all winPct and PF zero), power ranking is omitted rather than invented.
 */

/** Win percentage from a standings row (ties count as half a win). */
function winPct(row) {
  const w = row.wins || 0;
  const l = row.losses || 0;
  const t = row.ties || 0;
  const games = w + l + t;
  if (games === 0) return null;
  return (w + t * 0.5) / games;
}

/**
 * Build the league hub view.
 * @param {Object} params
 * @param {Array} params.standings   normalized standings rows
 *   ({ teamKey, name, rank, wins, losses, ties, pointsFor, managerName, isOwnedByLogin })
 * @param {string} [params.myTeamKey]
 */
export function buildLeagueHub({ standings, myTeamKey = null }) {
  const rows = Array.isArray(standings) ? standings : [];
  const teamCount = rows.length;

  if (teamCount === 0) {
    return {
      available: false,
      teamCount: 0,
      standings: [],
      powerRankings: [],
      note: 'No standings available from Yahoo for this league yet.',
    };
  }

  const maxPf = Math.max(...rows.map((r) => (typeof r.pointsFor === 'number' ? r.pointsFor : 0)), 0);
  const anyGames = rows.some((r) => (r.wins || 0) + (r.losses || 0) + (r.ties || 0) > 0);

  // Standings (Yahoo facts) passed through with light shaping.
  const standingsView = [...rows]
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map((r) => ({
      teamKey: r.teamKey,
      name: r.name,
      rank: r.rank ?? null,
      wins: r.wins ?? 0,
      losses: r.losses ?? 0,
      ties: r.ties ?? 0,
      pointsFor: r.pointsFor ?? null,
      manager: r.managerName ?? null,
      isMine: r.teamKey === myTeamKey || Boolean(r.isOwnedByLogin),
    }));

  // Power ranking (ProGM calculation) only when there is real game data.
  let powerRankings = [];
  if (anyGames) {
    powerRankings = rows
      .map((r) => {
        const wp = winPct(r) ?? 0;
        const pfNorm = maxPf > 0 && typeof r.pointsFor === 'number' ? r.pointsFor / maxPf : 0;
        const score = 0.65 * wp + 0.35 * pfNorm;
        return {
          teamKey: r.teamKey,
          name: r.name,
          isMine: r.teamKey === myTeamKey || Boolean(r.isOwnedByLogin),
          winPct: Number(wp.toFixed(3)),
          pointsFor: r.pointsFor ?? null,
          powerScore: Number((score * 100).toFixed(1)),
        };
      })
      .sort((a, b) => b.powerScore - a.powerScore)
      .map((t, i) => ({ powerRank: i + 1, ...t }));
  }

  return {
    available: true,
    teamCount,
    standings: standingsView,
    powerRankings,
    dataBasis: {
      facts: ['team records and points-for (Yahoo standings)', 'league rank and managers (Yahoo)'],
      calculations: ['power ranking = 65% win% + 35% league-normalized points-for'],
    },
    note: anyGames
      ? 'Power Ranking blends record (65%) and league-relative scoring (35%). Standings are Yahoo facts.'
      : 'No games have been played yet, so a power ranking is not shown. Standings reflect Yahoo order.',
  };
}
