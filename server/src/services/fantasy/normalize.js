/**
 * Yahoo Fantasy -> normalized ProGM fantasy models.
 *
 * Yahoo's Fantasy API returns awkward JSON: collections are numeric-keyed maps
 * with a sibling `count`, and resources are arrays of single-property objects.
 * This module is the ONLY place that understands that shape. Everything
 * downstream (analysis services, routes, frontend) consumes the clean models
 * defined here.
 *
 * Design goal: these models are provider-agnostic. A future NFL feed or a
 * third-party stats/projections provider can produce the same shapes, so the
 * analysis and recommendation layers never need to know where data came from.
 *
 * Every field here is a FACT sourced directly from Yahoo. Nothing is invented.
 * Fields Yahoo does not provide are returned as null (never fabricated).
 *
 * @typedef {Object} NormalizedPlayer
 * @property {string} playerKey            Yahoo player_key (stable id)
 * @property {string} playerId             Yahoo player_id
 * @property {string} name                 Full display name
 * @property {string|null} teamAbbr        Pro team abbreviation (e.g. "SAS")
 * @property {string|null} teamName        Pro team full name
 * @property {string|null} primaryPosition Primary position (e.g. "PG")
 * @property {string[]} eligiblePositions  All lineup positions the player is eligible for
 * @property {string|null} displayPosition Yahoo display position string ("PG,SG")
 * @property {string|null} headshotUrl     Headshot image URL
 * @property {string} selectedPosition     The slot this player currently occupies ("PG", "BN", "IL", ...)
 * @property {boolean} isStarting          True if currently in a starting slot (not BN/IL)
 * @property {string|null} status          Injury status code from Yahoo (e.g. "O","GTD","INJ") or null when healthy
 * @property {string|null} statusFull      Human-readable status ("Out","Game Time Decision") or null
 * @property {string|null} injuryNote      Yahoo injury note or null
 * @property {number|null} uniformNumber   Jersey number or null
 *
 * @typedef {Object} RosterSlot
 * @property {string} position             Slot code ("PG","SG","G","Util","BN","IL",...)
 * @property {string|null} positionType    Yahoo position_type ("P" for player, "G"-ish for other sports)
 * @property {number} count                How many of this slot the league has
 * @property {boolean} isStarting          Whether this is an active/starting slot
 *
 * @typedef {Object} StatCategory
 * @property {number} statId
 * @property {string} name                 Full stat name ("Points Scored")
 * @property {string} abbr                 Short label ("PTS")
 * @property {string|null} group           Yahoo stat group name
 * @property {boolean} enabled
 * @property {number|null} pointValue      For points leagues: points per unit (from stat_modifiers). null for category leagues.
 *
 * @typedef {Object} NormalizedLeagueSettings
 * @property {string} scoringType          Raw Yahoo value ("headpoint","head","roto")
 * @property {'points'|'category'|'roto'|'unknown'} scoringFormat  Normalized format
 * @property {string|null} scoringLabel    Yahoo human label ("H2H Points")
 * @property {RosterSlot[]} rosterSlots     All roster slots
 * @property {StatCategory[]} statCategories Scoring categories/stats
 * @property {Object} raw                  Selected extra raw settings (waiver_type, uses_faab, trade_end_date, num_playoff_teams)
 *
 * @typedef {Object} NormalizedLeague
 * @property {string} leagueKey
 * @property {string} leagueId
 * @property {string} name
 * @property {string|null} url
 * @property {string|null} logoUrl
 * @property {string} sport                "nba" | "nfl" | ...
 * @property {string|null} season
 * @property {number|null} numTeams
 * @property {string|null} currentWeek
 * @property {string|null} startDate
 * @property {string|null} endDate
 * @property {boolean} isFinished
 * @property {string|null} scoringType
 *
 * @typedef {Object} NormalizedTeam
 * @property {string} teamKey
 * @property {string} teamId
 * @property {string} name
 * @property {string|null} logoUrl
 * @property {boolean} isOwnedByLogin
 * @property {string|null} managerName
 * @property {number|null} rank
 * @property {number|null} playoffSeed
 * @property {number|null} wins
 * @property {number|null} losses
 * @property {number|null} ties
 * @property {string|null} winPct
 * @property {number|null} pointsFor
 * @property {number|null} pointsAgainst
 */

// ---------------------------------------------------------------------------
// Low-level Yahoo shape helpers
// ---------------------------------------------------------------------------

/** Yahoo collections are { "0": {...}, "1": {...}, count: N }. Return the items as an array. */
export function yahooCollection(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.keys(node)
    .filter((key) => key !== 'count')
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => node[key]);
}

/**
 * Yahoo resources are arrays of single-property objects, sometimes mixed with
 * empty arrays and nested arrays. Flatten them into one plain object.
 */
export function mergeYahooProps(node) {
  const out = {};
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item && typeof item === 'object') {
      Object.assign(out, item);
    }
  };
  visit(node);
  return out;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Yahoo draft_analysis uses the string "-" (and sometimes "" / "0.0" for
 * never-drafted players) to mean "no market data". Treat "-" and blanks as
 * NULL (never fabricate 0). A real "0" stays null too for ADP since pick 0 is
 * not meaningful; percent_drafted of exactly 0 is coerced from "-" already, so
 * callers see null when Yahoo had nothing.
 */
function yahooNumOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && (value.trim() === '' || value.trim() === '-'))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One available-player batch for a single Yahoo player sub-resource. */
export function yahooDraftPlayersPath(leagueKey, subresource = 'percent_owned') {
  return `/league/${leagueKey}/players;status=A;sort=OR;start=0;count=50/${subresource}`;
}

/** Fetch one Yahoo sub-resource for an exact, identity-safe player-key batch. */
export function yahooPlayerKeysPath(leagueKey, playerKeys, subresource) {
  const keys = (playerKeys || []).filter(Boolean).map((key) => encodeURIComponent(key)).join(',');
  return `/league/${leagueKey}/players;player_keys=${keys}${subresource ? `/${subresource}` : ''}`;
}

/** Merge independently fetched Yahoo player sub-resources by stable player_key. */
export function mergeYahooPlayerMetadata(players, ...metadataSets) {
  const metadataByKey = new Map();
  for (const set of metadataSets) {
    for (const player of set || []) {
      if (!player?.playerKey) continue;
      const metadata = metadataByKey.get(player.playerKey) || {};
      for (const field of ['percentOwned', 'yahooAdp', 'yahooAvgRound', 'yahooPercentDrafted']) {
        if (player[field] != null) metadata[field] = player[field];
      }
      if (player.yahooRanks) {
        metadata.yahooRanks = player.yahooRanks;
        metadata.yahooOverallRank = player.yahooOverallRank ?? player.yahooRanks.overall ?? null;
        metadata.yahooSeasonRanks = player.yahooSeasonRanks || player.yahooRanks.bySeason || {};
      }
      metadataByKey.set(player.playerKey, metadata);
    }
  }
  return (players || []).map((player) => (
    metadataByKey.has(player.playerKey) ? { ...player, ...metadataByKey.get(player.playerKey) } : player
  ));
}

/**
 * Parse Yahoo `player_ranks` (from the `ranks` sub-resource) into a compact,
 * season-agnostic shape:
 *   { overall: number|null, bySeason: { [year:string]: number } }
 * - rank_type 'OR'  -> overall (Yahoo's overall rank; one value, no season)
 * - rank_type 'S'   -> bySeason[rank_season] (per-season rank)
 * Numeric strings are coerced safely; missing/"-"/non-numeric -> omitted
 * (never fabricated as 0). Returns null when no usable ranks are present.
 *
 * @param {Array|undefined} node  Yahoo player_ranks array
 */
export function parseYahooRanks(node) {
  if (!Array.isArray(node)) return null;
  let overall = null;
  const bySeason = {};
  for (const entry of node) {
    const r = entry && entry.player_rank ? entry.player_rank : entry;
    if (!r || typeof r !== 'object') continue;
    const value = yahooNumOrNull(r.rank_value);
    if (value == null) continue;
    if (r.rank_type === 'OR') {
      if (overall == null) overall = value; // first OR wins
    } else if (r.rank_type === 'S' && r.rank_season != null && String(r.rank_season).trim()) {
      bySeason[String(r.rank_season).trim()] = value;
    }
  }
  if (overall == null && Object.keys(bySeason).length === 0) return null;
  return { overall, bySeason };
}

// ---------------------------------------------------------------------------
// Scoring format
// ---------------------------------------------------------------------------

/** Map Yahoo scoring_type to a normalized format ProGM analysis understands. */
export function normalizeScoringFormat(scoringType) {
  switch (scoringType) {
    case 'headpoint':
      return 'points';
    case 'point':
      return 'points';
    case 'head':
      return 'category';
    case 'roto':
      return 'roto';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/**
 * Normalize one Yahoo player entry. A player is either the raw
 * [ [props...], {selected_position}, {is_editable} ] tuple (roster context)
 * or just the [props...] array (player list context).
 */
export function normalizePlayer(rawPlayer) {
  // Roster tuples wrap the prop array as element 0 and add sibling elements
  // such as selected_position (roster) or percent_owned (players list).
  let propsNode = rawPlayer;
  let selectedPosition = null;
  let percentOwnedValue = null;
  let draftAnalysis = null; // { yahooAdp, yahooAvgRound, yahooPercentDrafted } or null
  let yahooRanks = null; // { overall:number|null, bySeason:{ [year]: number } } or null

  if (Array.isArray(rawPlayer) && Array.isArray(rawPlayer[0])) {
    propsNode = rawPlayer[0];
    const meta = mergeYahooProps(rawPlayer.slice(1));
    if (Array.isArray(meta.selected_position)) {
      const sp = mergeYahooProps(meta.selected_position);
      selectedPosition = sp.position || null;
    }
    // percent_owned arrives as its own Yahoo prop-array: [{coverage_type},{value},{delta}]
    if (Array.isArray(meta.percent_owned)) {
      const po = mergeYahooProps(meta.percent_owned);
      percentOwnedValue = po.value;
    } else if (meta.percent_owned && typeof meta.percent_owned === 'object') {
      percentOwnedValue = meta.percent_owned.value;
    }
    // draft_analysis is a prop-array: [{average_pick},{average_round},
    // {average_cost},{percent_drafted},{preseason_average_pick},...]. Yahoo
    // uses the string "-" for missing values -> normalize to null (NEVER 0).
    // preseason_* is used as a fallback before live draft data accumulates.
    const daNode = meta.draft_analysis;
    if (daNode) {
      const da = Array.isArray(daNode) ? mergeYahooProps(daNode) : daNode;
      const adp = yahooNumOrNull(da.average_pick) ?? yahooNumOrNull(da.preseason_average_pick);
      const rnd = yahooNumOrNull(da.average_round) ?? yahooNumOrNull(da.preseason_average_round);
      const pct = yahooNumOrNull(da.percent_drafted) ?? yahooNumOrNull(da.preseason_percent_drafted);
      draftAnalysis = { yahooAdp: adp, yahooAvgRound: rnd, yahooPercentDrafted: pct };
    }
    // player_ranks (from the `ranks` sub-resource) is an array of
    //   { player_rank: { rank_type:'OR'|'S', rank_value:'65', rank_season?:'2024' } }
    // OR = Yahoo's overall rank (one value, no season). S = per-season rank.
    // Season-agnostic parse here; the current-season pick happens downstream
    // (where league.season is known). Missing -> null, never 0. Graceful.
    yahooRanks = parseYahooRanks(meta.player_ranks);
  }

  const p = mergeYahooProps(propsNode);

  const eligiblePositions = Array.isArray(p.eligible_positions)
    ? p.eligible_positions.map((e) => (e && e.position) || null).filter(Boolean)
    : [];

  const selected = selectedPosition || null;
  const benchSlots = new Set(['BN', 'IL', 'IL+', 'IR', 'NA']);

  return {
    playerKey: p.player_key || null,
    playerId: p.player_id || null,
    // Cross-season-stable Yahoo key ("nba.p.10290"); its numeric id is what
    // external providers (e.g. Tank01 yahooPlayerID) cross-reference.
    editorialPlayerKey: p.editorial_player_key || null,
    name: p.name?.full || [p.name?.first, p.name?.last].filter(Boolean).join(' ') || 'Unknown Player',
    teamAbbr: p.editorial_team_abbr || null,
    teamName: p.editorial_team_full_name || null,
    primaryPosition: p.primary_position || null,
    eligiblePositions,
    displayPosition: p.display_position || null,
    headshotUrl: p.headshot?.url || p.image_url || null,
    selectedPosition: selected,
    isStarting: selected ? !benchSlots.has(selected) : false,
    // Yahoo only includes status fields when a player is not fully healthy.
    status: p.status || null,
    statusFull: p.status_full || null,
    injuryNote: p.injury_note || null,
    uniformNumber: toNumberOrNull(p.uniform_number),
    // Yahoo ownership %, only present when the players resource is requested
    // with the percent_owned sub-resource. null otherwise.
    percentOwned: toNumberOrNull(percentOwnedValue),
    // Yahoo market/ADP, only present when the draft_analysis sub-resource is
    // requested. Missing values are null (never 0). These are MARKET context —
    // they do NOT feed ProGM projections or the core ranking.
    yahooAdp: draftAnalysis?.yahooAdp ?? null,
    yahooAvgRound: draftAnalysis?.yahooAvgRound ?? null,
    yahooPercentDrafted: draftAnalysis?.yahooPercentDrafted ?? null,
    // Yahoo RANK, only present when the `ranks` sub-resource is requested.
    // Independent EXTERNAL signal (labeled "Yahoo Rank" in product, NOT
    // "Expert Rank"). Season-agnostic here; the caller picks the current
    // season's S rank. null when absent (never 0). Does NOT feed ProGM rank.
    yahooRanks: yahooRanks || null,
    yahooOverallRank: yahooRanks?.overall ?? null,
    yahooSeasonRanks: yahooRanks?.bySeason || {},
  };
}

/** Extract normalized players from a Yahoo roster response (/team/{key}/roster/players). */
export function extractRosterPlayers(rosterResponse) {
  const team = rosterResponse?.fantasy_content?.team;
  if (!Array.isArray(team)) return [];
  // team[1].roster["0"].players is the collection
  const rosterNode = team.find((el) => el && el.roster)?.roster;
  const playersNode = rosterNode?.['0']?.players || rosterNode?.players;
  return yahooCollection(playersNode)
    .map((entry) => entry?.player)
    .filter(Boolean)
    .map(normalizePlayer);
}

/** Extract normalized players from a players-list response (e.g. league players / free agents). */
export function extractPlayerList(playersNode) {
  return yahooCollection(playersNode)
    .map((entry) => entry?.player)
    .filter(Boolean)
    .map(normalizePlayer);
}

// ---------------------------------------------------------------------------
// League + settings
// ---------------------------------------------------------------------------

/** Pull the league meta object (fantasy_content.league[0]) into normalized form. */
export function normalizeLeagueMeta(leagueMeta) {
  const m = mergeYahooProps(leagueMeta);
  return {
    leagueKey: m.league_key || null,
    leagueId: m.league_id || null,
    name: m.name || 'Unnamed League',
    url: m.url || null,
    logoUrl: m.logo_url || null,
    sport: m.game_code || null,
    season: m.season || null,
    numTeams: toNumberOrNull(m.num_teams),
    currentWeek: m.current_week != null ? String(m.current_week) : null,
    startDate: m.start_date || null,
    endDate: m.end_date || null,
    isFinished: m.is_finished === 1 || m.is_finished === '1',
    // Yahoo draft lifecycle: 'predraft' | 'drafting' | 'postdraft' (when present).
    draftStatus: m.draft_status || null,
    scoringType: m.scoring_type || null,
    // Lineup format: 'date' = daily lineups (games-per-week matters most),
    // 'week' = weekly lineups. Drives schedule-aware weekly value.
    rosterType: m.roster_type || null,
    // Yahoo's current coverage date (YYYY-MM-DD), used to anchor the period.
    editKey: m.edit_key || null,
  };
}

/** Normalize league settings (/league/{key}/settings). */
export function normalizeLeagueSettings(settingsResponse) {
  const league = settingsResponse?.fantasy_content?.league;
  if (!Array.isArray(league)) return null;

  const meta = normalizeLeagueMeta(league[0]);
  const settingsNode = league.find((el) => el && el.settings)?.settings;
  const s = Array.isArray(settingsNode) ? mergeYahooProps(settingsNode) : settingsNode || {};

  const rosterSlots = Array.isArray(s.roster_positions)
    ? s.roster_positions
        .map((rp) => rp && rp.roster_position)
        .filter(Boolean)
        .map((rp) => ({
          position: rp.position,
          positionType: rp.position_type || null,
          count: toNumberOrNull(rp.count) ?? 0,
          isStarting: rp.is_starting_position === 1 || rp.is_starting_position === '1',
        }))
    : [];

  // stat_modifiers (points value per stat) only exist in points leagues.
  const modifierById = {};
  const modifierStats = s.stat_modifiers?.stats;
  if (Array.isArray(modifierStats)) {
    modifierStats.forEach((entry) => {
      const stat = entry?.stat;
      if (stat && stat.stat_id != null) modifierById[String(stat.stat_id)] = toNumberOrNull(stat.value);
    });
  }

  const statCategories = Array.isArray(s.stat_categories?.stats)
    ? s.stat_categories.stats
        .map((entry) => entry?.stat)
        .filter(Boolean)
        .map((stat) => ({
          statId: toNumberOrNull(stat.stat_id),
          name: stat.name || stat.display_name || '',
          abbr: stat.abbr || stat.display_name || '',
          group: stat.group || null,
          enabled: stat.enabled === '1' || stat.enabled === 1,
          pointValue: modifierById[String(stat.stat_id)] ?? null,
        }))
    : [];

  const scoringType = s.scoring_type || meta.scoringType;

  // Lineup format + current fantasy-period window (for schedule-aware value).
  // 'date' roster type = daily lineups; the relevant period is the current
  // fantasy week. We anchor the window at Yahoo's current coverage date
  // (edit_key/current_date) and extend through the end of that ISO week,
  // clamped to the season end. If the season is over or dates are missing,
  // no period is produced (callers fall back to per-game value).
  const lineupFormat = meta.rosterType === 'week' ? 'weekly' : meta.rosterType === 'date' ? 'daily' : 'unknown';
  const period = computeCurrentPeriod({ editKey: meta.editKey, seasonEnd: meta.endDate, isFinished: meta.isFinished });

  return {
    ...meta,
    settings: {
      scoringType,
      scoringFormat: normalizeScoringFormat(scoringType),
      scoringLabel: s.scoring_label || null,
      lineupFormat,
      period,
      rosterSlots,
      statCategories,
      raw: {
        waiverType: s.waiver_type || null,
        usesFaab: s.uses_faab === '1' || s.uses_faab === 1,
        tradeEndDate: s.trade_end_date || null,
        numPlayoffTeams: toNumberOrNull(s.num_playoff_teams),
        maxTeams: toNumberOrNull(s.max_teams),
      },
    },
  };
}

/**
 * Current fantasy-period window: [editKey (today), end of that ISO week],
 * clamped to season end. Returns { startDate, endDate } as 'YYYY-MM-DD', or
 * null when the season is finished or the anchor date is unavailable. Never
 * fabricates a window without a real anchor date.
 */
function computeCurrentPeriod({ editKey, seasonEnd, isFinished }) {
  if (isFinished || !editKey) return null;
  const start = new Date(`${editKey}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  // End of the current week (Sunday). Yahoo NBA weeks run Mon–Sun.
  const dow = start.getUTCDay(); // 0=Sun..6=Sat
  const daysToSunday = dow === 0 ? 0 : 7 - dow;
  const end = new Date(start.getTime() + daysToSunday * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  let endStr = fmt(end);
  if (seasonEnd && endStr > seasonEnd) endStr = seasonEnd;
  return { startDate: fmt(start), endDate: endStr };
}

// ---------------------------------------------------------------------------
// Standings / teams
// ---------------------------------------------------------------------------

/** Normalize one team entry from a standings response. */
export function normalizeStandingsTeam(rawTeam) {
  // rawTeam = [ [meta props...], {team_stats}, {team_points}, {team_standings} ]
  const metaProps = Array.isArray(rawTeam) ? rawTeam.find((el) => Array.isArray(el)) : null;
  const meta = mergeYahooProps(metaProps || rawTeam);
  const extra = mergeYahooProps(Array.isArray(rawTeam) ? rawTeam.filter((el) => !Array.isArray(el)) : []);

  const standings = extra.team_standings || {};
  const outcome = standings.outcome_totals || {};

  let managerName = null;
  if (Array.isArray(meta.managers) && meta.managers[0]?.manager) {
    managerName = meta.managers[0].manager.nickname || null;
  }

  let logoUrl = null;
  if (Array.isArray(meta.team_logos) && meta.team_logos[0]?.team_logo) {
    logoUrl = meta.team_logos[0].team_logo.url || null;
  }

  return {
    teamKey: meta.team_key || null,
    teamId: meta.team_id != null ? String(meta.team_id) : null,
    name: meta.name || 'Unnamed Team',
    logoUrl,
    isOwnedByLogin: meta.is_owned_by_current_login === 1 || meta.is_owned_by_current_login === '1',
    managerName,
    rank: toNumberOrNull(standings.rank),
    playoffSeed: toNumberOrNull(standings.playoff_seed),
    wins: toNumberOrNull(outcome.wins),
    losses: toNumberOrNull(outcome.losses),
    ties: toNumberOrNull(outcome.ties),
    winPct: outcome.percentage != null ? String(outcome.percentage) : null,
    pointsFor: toNumberOrNull(extra.team_points?.total ?? standings.points_for),
    pointsAgainst: toNumberOrNull(standings.points_against),
  };
}

/** Extract all normalized teams from a standings response (/league/{key}/standings). */
export function extractStandings(standingsResponse) {
  const league = standingsResponse?.fantasy_content?.league;
  if (!Array.isArray(league)) return [];
  const standingsNode = league.find((el) => el && el.standings)?.standings;
  const teamsNode = Array.isArray(standingsNode)
    ? mergeYahooProps(standingsNode).teams
    : standingsNode?.teams;
  return yahooCollection(teamsNode)
    .map((entry) => entry?.team)
    .filter(Boolean)
    .map(normalizeStandingsTeam)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
}

// ---------------------------------------------------------------------------
// Leagues list (games -> leagues for the logged-in user)
// ---------------------------------------------------------------------------

/**
 * Extract the user's leagues from /users;use_login=1/games;game_codes=xxx/leagues.
 * Returns normalized league meta objects. Uses a resilient recursive walk since
 * the nesting depth varies.
 */
export function extractUserLeagues(response) {
  const leagues = [];
  const seen = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      if (node.league_key && !seen.has(node.league_key)) {
        // A league meta object may itself be split across an array of props.
        // Only treat it as a league if it also carries a name (avoids partials).
      }
      // Yahoo nests each league as an array under a numeric key; the first
      // element is the meta prop array.
      Object.entries(node).forEach(([key, value]) => {
        if (key === 'league' && Array.isArray(value)) {
          const meta = normalizeLeagueMeta(value[0]);
          if (meta.leagueKey && !seen.has(meta.leagueKey)) {
            seen.add(meta.leagueKey);
            leagues.push(meta);
          }
        }
        walk(value);
      });
    }
  };

  walk(response?.fantasy_content ?? response);
  return leagues;
}

/**
 * Extract the user's teams (with their league_key) from
 * /users;use_login=1/games;game_codes=xxx/teams.
 * Returns [{ teamKey, teamId, name, leagueKey, logoUrl }].
 */
export function extractUserTeams(response) {
  const teams = [];
  const seen = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.entries(node).forEach(([key, value]) => {
        if (key === 'team' && Array.isArray(value)) {
          const meta = mergeYahooProps(value.find((el) => Array.isArray(el)) || value);
          if (meta.team_key && !seen.has(meta.team_key)) {
            seen.add(meta.team_key);
            let logoUrl = null;
            if (Array.isArray(meta.team_logos) && meta.team_logos[0]?.team_logo) {
              logoUrl = meta.team_logos[0].team_logo.url || null;
            }
            teams.push({
              teamKey: meta.team_key,
              teamId: meta.team_id != null ? String(meta.team_id) : null,
              name: meta.name || 'My Team',
              // A team_key looks like "454.l.164406.t.3"; its league_key is "454.l.164406".
              leagueKey: meta.team_key.split('.t.')[0],
              logoUrl,
            });
          }
        }
        walk(value);
      });
    }
  };

  walk(response?.fantasy_content ?? response);
  return teams;
}
