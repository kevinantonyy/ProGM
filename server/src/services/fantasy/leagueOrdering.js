/**
 * Yahoo league ordering + default selection.
 *
 * Fantasy basketball users accumulate leagues across seasons. ProGM must:
 *   - determine each league's season from Yahoo METADATA (never the name),
 *   - sort newest season first with a deterministic tiebreak,
 *   - deduplicate by stable Yahoo league key (not name),
 *   - auto-select the newest league by default,
 *   - keep older leagues accessible,
 *   - honor a user's in-session manual selection, BUT never let a stale
 *     selection permanently block a newer season from becoming the default.
 *
 * Nothing here is sport-specific; it works for any Yahoo game.
 */

/**
 * Parse a numeric season start-year from Yahoo league metadata.
 * Yahoo's `season` is the START year of the season (e.g. "2025" => 2025-26).
 * Returns null when it cannot be determined (never guessed from the name).
 *
 * @param {{season?:string|number, leagueKey?:string}} league
 * @returns {number|null}
 */
export function parseSeasonYear(league) {
  if (!league) return null;
  const raw = league.season;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1990 && n <= 2100) return n;
  }
  // Fallback: the Yahoo league_key game-id prefix increases each season
  // (e.g. 454.l.* is an older game than 466.l.*). We do NOT convert this to a
  // calendar year (that would be a guess); it's only used as a tiebreak in
  // sorting via gameIdOf(). So return null here for the year itself.
  return null;
}

/** Extract the numeric Yahoo game id prefix from a league key ("466.l.123" -> 466). */
export function gameIdOf(league) {
  const key = league?.leagueKey || '';
  const m = /^(\d+)\.l\.\d+$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Human season label from a start year: 2025 -> "2025-26". null-safe. */
export function seasonLabel(year) {
  if (year == null) return null;
  const end = String((year + 1) % 100).padStart(2, '0');
  return `${year}-${end}`;
}

/**
 * Deduplicate leagues by stable leagueKey. When duplicates exist, keep the
 * first occurrence but prefer one that has a parseable season.
 */
export function dedupeLeagues(leagues) {
  const byKey = new Map();
  for (const lg of leagues || []) {
    if (!lg?.leagueKey) continue;
    const existing = byKey.get(lg.leagueKey);
    if (!existing) { byKey.set(lg.leagueKey, lg); continue; }
    // Prefer the record that has a season over one that doesn't.
    if (parseSeasonYear(existing) == null && parseSeasonYear(lg) != null) {
      byKey.set(lg.leagueKey, lg);
    }
  }
  return [...byKey.values()];
}

/**
 * Sort leagues newest-first. Ordering keys, in priority order:
 *   1. season start-year (desc) when known; leagues with a known season always
 *      rank above leagues with an unknown season,
 *   2. Yahoo game-id prefix (desc) as a deterministic season proxy/tiebreak,
 *   3. leagueKey (asc) as a final stable, deterministic tiebreak.
 *
 * This is pure and deterministic; ties never depend on input order.
 */
export function sortLeaguesNewestFirst(leagues) {
  return [...dedupeLeagues(leagues)].sort((a, b) => {
    const ya = parseSeasonYear(a);
    const yb = parseSeasonYear(b);
    if (ya != null && yb != null && ya !== yb) return yb - ya;
    if (ya != null && yb == null) return -1;
    if (ya == null && yb != null) return 1;
    const ga = gameIdOf(a);
    const gb = gameIdOf(b);
    if (ga != null && gb != null && ga !== gb) return gb - ga;
    if (ga != null && gb == null) return -1;
    if (ga == null && gb != null) return 1;
    // Final deterministic tiebreak.
    return String(a.leagueKey).localeCompare(String(b.leagueKey));
  });
}

/**
 * Annotate leagues with sorted order + season label, ready for the UI selector.
 * @returns {Array<league & {seasonYear:number|null, seasonLabel:string|null}>}
 */
export function orderLeaguesForDisplay(leagues) {
  return sortLeaguesNewestFirst(leagues).map((lg) => {
    const year = parseSeasonYear(lg);
    return { ...lg, seasonYear: year, seasonLabel: seasonLabel(year) };
  });
}

/**
 * Return only leagues from Yahoo's newest fantasy season metadata. League
 * status is intentionally ignored so predraft, active, and completed leagues
 * from that season remain selectable. If Yahoo omits every season value, use
 * the newest Yahoo game-id group rather than guessing from the calendar.
 */
export function currentSeasonLeagues(leagues) {
  const ordered = orderLeaguesForDisplay(leagues);
  if (!ordered.length) return [];
  const newestWithSeason = ordered.find((league) => league.seasonYear != null);
  if (newestWithSeason) return ordered.filter((league) => league.seasonYear === newestWithSeason.seasonYear);
  const newestGameId = gameIdOf(ordered[0]);
  return newestGameId == null ? ordered.slice(0, 1) : ordered.filter((league) => gameIdOf(league) === newestGameId);
}

/**
 * Choose which league should be selected.
 *
 * Rules:
 *   - Default = the newest league (first after sorting).
 *   - If the user made an in-session manual selection AND that league is not
 *     older than the newest available season, honor it.
 *   - If the user's persisted selection belongs to an OLDER season than the
 *     newest available, fall back to the newest (a newer season must be able to
 *     become the sensible default without a code change).
 *
 * @param {Array} leagues
 * @param {string|null} persistedLeagueKey  the user's in-session manual choice
 * @returns {{ selectedLeagueKey: string|null, reason: string, leagues: Array }}
 */
export function chooseDefaultLeague(leagues, persistedLeagueKey = null) {
  const ordered = orderLeaguesForDisplay(leagues);
  if (!ordered.length) return { selectedLeagueKey: null, reason: 'no_leagues', leagues: ordered };

  const newest = ordered[0];
  const newestYear = newest.seasonYear;

  if (persistedLeagueKey) {
    const chosen = ordered.find((l) => l.leagueKey === persistedLeagueKey);
    if (chosen) {
      // Honor the manual pick unless it's from an older season than the newest.
      const chosenYear = chosen.seasonYear;
      const isOlderSeason = newestYear != null && chosenYear != null && chosenYear < newestYear;
      if (!isOlderSeason) {
        return { selectedLeagueKey: chosen.leagueKey, reason: 'honored_manual_selection', leagues: ordered };
      }
      return { selectedLeagueKey: newest.leagueKey, reason: 'superseded_by_newer_season', leagues: ordered };
    }
    // Persisted key no longer exists among the user's leagues.
    return { selectedLeagueKey: newest.leagueKey, reason: 'persisted_not_found', leagues: ordered };
  }

  return { selectedLeagueKey: newest.leagueKey, reason: 'default_newest', leagues: ordered };
}
