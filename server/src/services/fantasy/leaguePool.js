/**
 * Full-league player pool for the Rankings tab (PROGM_RANKINGS_FULL_POOL, default off, completed drafts only).
 *
 * Pool = every player Yahoo lists as AVAILABLE + every player on MY roster + every player on EVERY OTHER team's roster, merged and
 * deduplicated by Yahoo player_key. Pure and I/O free: the workspace builder passes in what it already fetched.
 *
 * SCOPE LIMITATION (always reported): this is "available + all rosters", NOT proof that every Yahoo-eligible player is included.
 * A player who is neither available nor on a roster (if Yahoo has any) cannot be detected from these two sources.
 *
 * `complete` is true only when every check passes; otherwise `reasons` says why and callers must not call the ranking full-pool.
 * Ownership never feeds ranking: this module only annotates players; ranks are computed elsewhere from projections alone.
 */

export function resolveRankingsFullPool(env = process.env) {
  return ['on', 'true', '1'].includes(String(env?.PROGM_RANKINGS_FULL_POOL ?? '').trim().toLowerCase());
}

export const POOL_SCOPE = 'yahoo_available_plus_all_team_rosters';
export const POOL_LIMITATION = 'This pool is every player Yahoo lists as available plus every player on every team in this league. It cannot prove that no other Yahoo-eligible player exists.';

/**
 * @param {object} input
 * @param {{players:Array, ok:boolean, report?:{failed?:boolean,hitCap?:boolean,noKey?:number,gapPages?:number}|null}} input.available
 * @param {{teamKey:string|null, name:string}} input.myTeam
 * @param {{players:Array, ok:boolean, fetchedAt?:string|null}} input.myRoster
 * @param {Array<{teamKey:string, name:string, players:Array, ok:boolean, fetchedAt?:string|null}>} input.opponents
 * @param {number|null} input.expectedTeams  league size from Yahoo settings
 */
export function assembleLeaguePool({ available, myTeam, myRoster, opponents = [], expectedTeams = null }) {
  const byKey = new Map();
  let duplicateOwnership = 0;
  let availableAlsoRostered = 0;
  let rosterEntriesWithoutKey = 0;
  let availableWithoutKey = 0;
  const failedRosters = [];
  const emptyRosters = [];
  let teamsLoaded = 0;

  const addRoster = (team, roster, mine) => {
    if (!roster?.ok) { failedRosters.push(team.name || team.teamKey || 'a team'); return; } // a FAILED request is never the same as an empty roster
    teamsLoaded += 1;
    if (!roster.players?.length) emptyRosters.push(team.name || team.teamKey || 'a team');
    for (const player of roster.players || []) {
      if (!player?.playerKey) { rosterEntriesWithoutKey += 1; continue; }
      if (byKey.has(player.playerKey)) { duplicateOwnership += 1; byKey.get(player.playerKey).ownershipConflict = true; continue; } // first owner kept, conflict flagged
      byKey.set(player.playerKey, {
        ...player,
        yahooStatusFetchedAt: player.yahooStatusFetchedAt ?? roster.fetchedAt ?? null,
        availability: mine ? 'mine' : 'rostered',
        ownerTeam: team.name ?? null,
        ownerTeamKey: team.teamKey ?? null,
        ownedByMe: mine,
      });
    }
  };

  addRoster(myTeam || {}, myRoster, true);
  for (const opponent of opponents) addRoster(opponent, opponent, false);

  for (const player of available?.players || []) {
    if (!player?.playerKey) { availableWithoutKey += 1; continue; }
    if (byKey.has(player.playerKey)) { availableAlsoRostered += 1; continue; } // the league changed while loading: the roster record wins
    byKey.set(player.playerKey, { ...player, availability: 'available', ownerTeam: null, ownerTeamKey: null, ownedByMe: false });
  }

  const report = available?.report || {};
  const teamsKnown = 1 + opponents.length;
  const reasons = [];
  if (!(expectedTeams > 0)) reasons.push('The number of teams in this league is unknown, so the rosters cannot be checked for completeness.');
  else if (teamsKnown !== expectedTeams) reasons.push(`Yahoo's standings listed ${teamsKnown} of ${expectedTeams} teams, so some rosters were never requested.`);
  if (failedRosters.length) reasons.push(`The roster could not be loaded for ${failedRosters.join(', ')}; their players are missing.`);
  if (emptyRosters.length) reasons.push(`The roster for ${emptyRosters.join(', ')} came back with no players, which is not expected after a draft.`);
  if (!available?.ok) reasons.push('The list of available players could not be loaded; every free agent is missing.');
  else {
    if (report.failed) reasons.push('A page of the available-player list failed to load, so some free agents may be missing.');
    if (report.hitCap) reasons.push('The available-player list reached the 1000-player limit, so more free agents may exist.');
    if (report.noKey > 0 || availableWithoutKey > 0) reasons.push(`${(report.noKey || 0) || availableWithoutKey} available-player entries had no player key and could not be ranked.`);
  }
  if (rosterEntriesWithoutKey > 0) reasons.push(`${rosterEntriesWithoutKey} roster entries had no player key and could not be ranked.`);
  if (duplicateOwnership > 0) reasons.push(`${duplicateOwnership} ${duplicateOwnership === 1 ? 'player appears' : 'players appear'} on more than one team roster, so ownership is ambiguous.`);

  const warnings = [];
  if (availableAlsoRostered > 0) warnings.push(`${availableAlsoRostered} ${availableAlsoRostered === 1 ? 'player was' : 'players were'} listed as available and on a roster (the league changed while loading); treated as rostered.`);
  if (report.gapPages > 0) warnings.push('Yahoo returned the available-player list with irregular paging; every page was still read.');

  const players = [...byKey.values()];
  return {
    players,
    completeness: {
      complete: reasons.length === 0,
      scope: POOL_SCOPE,
      reasons,
      warnings,
      limitations: [POOL_LIMITATION],
      counts: {
        total: players.length,
        available: players.filter((p) => p.availability === 'available').length,
        rostered: players.filter((p) => p.availability === 'rostered').length,
        mine: players.filter((p) => p.availability === 'mine').length,
        teamsExpected: expectedTeams ?? null,
        teamsLoaded,
        failedRosters: failedRosters.length,
        duplicateOwnership,
        availableAlsoRostered,
      },
    },
  };
}
