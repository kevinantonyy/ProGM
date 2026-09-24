/**
 * Schedule-aware weekly (fantasy-period) value.
 *
 * Fantasy basketball value depends not just on per-game production but on HOW
 * MANY games a player's NBA team plays during the relevant fantasy period.
 * A per-game projection understates a player on a 4-game week and overstates
 * one on a 2-game week.
 *
 *   expectedPeriodProduction = projectedPerGame × expectedGamesInPeriod
 *
 * This module is pure. It takes normalized team schedules and a fantasy period
 * window and computes expected games per team. When schedule or period data is
 * missing, it returns null (callers fall back to per-game value) — never a
 * fabricated game count.
 *
 * @typedef {Object} TeamSchedules  map of teamAbbr -> array of { gameDate:'YYYYMMDD', completed:boolean }
 */

import { normalizeTeam } from '../identity/playerIdentity.js';

/** Parse 'YYYYMMDD' or 'YYYY-MM-DD' to a comparable integer YYYYMMDD, or null. */
export function toYmd(value) {
  if (value == null) return null;
  const digits = String(value).replace(/-/g, '');
  if (!/^\d{8}$/.test(digits)) return null;
  return Number(digits);
}

/**
 * Determine the fantasy period window (inclusive) from league settings.
 * Daily-lineup leagues (rosterType === 'date') use the current scoring week's
 * start/end dates when Yahoo provides them. Returns null when unknown.
 *
 * @param {Object} settings normalized league settings (may include period info)
 * @returns {{ startYmd:number, endYmd:number }|null}
 */
export function resolvePeriodWindow(settings) {
  if (!settings) return null;
  const period = settings.period || {};
  const start = toYmd(period.startDate);
  const end = toYmd(period.endDate);
  if (start != null && end != null && end >= start) return { startYmd: start, endYmd: end };
  return null;
}

/**
 * Count a team's remaining games within [startYmd, endYmd] inclusive.
 * "Remaining" = not marked completed. If completion is unknown, count the game
 * (a game in the window we can't prove finished still counts as expected).
 *
 * @param {string} teamAbbr
 * @param {TeamSchedules} schedules
 * @param {number} startYmd
 * @param {number} endYmd
 * @returns {number|null} null when the team has no schedule data
 */
export function expectedGamesInPeriod(teamAbbr, schedules, startYmd, endYmd) {
  const team = normalizeTeam(teamAbbr);
  if (!team || !schedules) return null;
  // Try direct + normalized-alias keys so provider/Yahoo abbr differences align.
  const games = schedules[team] || schedules[teamAbbr] || null;
  if (!Array.isArray(games)) return null;
  let count = 0;
  for (const g of games) {
    const ymd = toYmd(g.gameDate);
    if (ymd == null) continue;
    if (ymd < startYmd || ymd > endYmd) continue;
    if (g.completed === true) continue; // already played — not "remaining"
    count += 1;
  }
  return count;
}

/**
 * Compute schedule-aware period value for a player.
 *
 * @param {Object} params
 * @param {number|null} params.projectedPerGame
 * @param {string|null} params.teamAbbr
 * @param {TeamSchedules|null} params.schedules
 * @param {{startYmd:number,endYmd:number}|null} params.periodWindow
 * @returns {{ expectedGames:number|null, periodProjectedPoints:number|null, scheduleAware:boolean }}
 */
export function playerPeriodValue({ projectedPerGame, teamAbbr, schedules, periodWindow }) {
  if (!periodWindow || !schedules) {
    return { expectedGames: null, periodProjectedPoints: null, scheduleAware: false };
  }
  const expectedGames = expectedGamesInPeriod(teamAbbr, schedules, periodWindow.startYmd, periodWindow.endYmd);
  if (expectedGames == null || projectedPerGame == null) {
    return { expectedGames, periodProjectedPoints: null, scheduleAware: false };
  }
  return {
    expectedGames,
    periodProjectedPoints: Number((projectedPerGame * expectedGames).toFixed(2)),
    scheduleAware: true,
  };
}

/**
 * Build a lookup for schedule-aware value across a set of players, keyed by a
 * caller-provided id function. Returns a Map id -> playerPeriodValue result.
 * Players whose team lacks schedule data get scheduleAware:false (per-game
 * fallback is the caller's responsibility).
 */
export function buildPeriodValues({ players, idOf, projectedOf, teamOf, schedules, periodWindow }) {
  const map = new Map();
  for (const p of players || []) {
    map.set(idOf(p), playerPeriodValue({
      projectedPerGame: projectedOf(p),
      teamAbbr: teamOf(p),
      schedules,
      periodWindow,
    }));
  }
  return map;
}
