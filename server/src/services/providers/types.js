/**
 * Provider-independent data models + the StatsProvider interface contract.
 *
 * Every external NBA data provider (Tank01, stats.nba.com, or a future one)
 * normalizes its responses into these shapes. Analysis engines consume ONLY
 * these shapes and never see provider-specific JSON. This is what keeps ProGM
 * from being locked into any single provider.
 *
 * All numeric fields are per-game averages unless noted. Missing data is null,
 * never fabricated.
 *
 * @typedef {Object} ProviderPlayerRef
 * @property {string} externalId      Provider's player id
 * @property {string} name
 * @property {string|null} teamAbbr
 * @property {string|null} yahooId     Provider-supplied Yahoo cross-reference id (Tank01 has this; nba.com does not)
 *
 * @typedef {Object} StatLine        Per-game statline (provider-independent stat keys)
 * @property {number|null} gamesPlayed
 * @property {number|null} minutes
 * @property {number|null} points
 * @property {number|null} rebounds
 * @property {number|null} offRebounds
 * @property {number|null} defRebounds
 * @property {number|null} assists
 * @property {number|null} steals
 * @property {number|null} blocks
 * @property {number|null} turnovers
 * @property {number|null} personalFouls
 * @property {number|null} fgMade
 * @property {number|null} fgAtt
 * @property {number|null} ftMade
 * @property {number|null} ftAtt
 * @property {number|null} threesMade
 * @property {number|null} doubleDoubles
 * @property {number|null} tripleDoubles
 *
 * @typedef {Object} PlayerStats
 * @property {string} externalId
 * @property {StatLine} season        Season per-game averages
 * @property {StatLine|null} recent    Recent-window per-game averages (e.g. last N games), or null if unavailable
 * @property {number|null} recentGameCount
 *
 * @typedef {Object} InjuryRecord
 * @property {string} externalId
 * @property {string|null} designation  Provider status (e.g. "Out", "Day-To-Day")
 * @property {string|null} description
 *
 * @typedef {Object} TeamScheduleInfo
 * @property {string} teamAbbr
 * @property {number} gamesInWindow     Number of games in the queried window
 *
 * The StatsProvider interface (duck-typed; each provider is a plain object):
 * {
 *   name: string,
 *   isConfigured(): boolean,           // e.g. Tank01 requires RAPIDAPI_KEY
 *   getPlayerIndex(): Promise<ProviderPlayerRef[]>,
 *   getSeasonStats(season): Promise<PlayerStats[]>,   // keyed by externalId
 *   getInjuries(): Promise<InjuryRecord[]>,
 *   getSchedule(season, opts): Promise<TeamScheduleInfo[]>,   // optional
 * }
 *
 * Not all providers implement every method; callers must feature-detect and
 * degrade gracefully (Yahoo-only) when a capability or provider is missing.
 */

/** An empty statline with all-null fields (used as a safe default; not fabricated data). */
export function emptyStatLine() {
  return {
    gamesPlayed: null, minutes: null, points: null, rebounds: null,
    offRebounds: null, defRebounds: null, assists: null, steals: null,
    blocks: null, turnovers: null, personalFouls: null, fgMade: null, fgAtt: null, ftMade: null,
    ftAtt: null, threesMade: null, doubleDoubles: null, tripleDoubles: null,
  };
}

/** Coerce a value to a finite number or null (never NaN, never fabricated). */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
