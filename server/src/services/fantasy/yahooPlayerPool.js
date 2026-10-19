import { extractPlayerList, mergeYahooPlayerMetadata, yahooDraftPlayersPath } from './normalize.js';

export const YAHOO_PLAYER_PAGE_SIZE = 25;
export const YAHOO_POOL_MAX_PLAYERS = 1000;
const MAX_PLAYERS = YAHOO_POOL_MAX_PLAYERS;

function extractLeaguePlayers(data) {
  const leagueNode = data?.fantasy_content?.league;
  const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
  return extractPlayerList(playersNode);
}

/**
 * Fetch every Yahoo player page (status A by default) for one subresource.
 * An optional `report` object is filled with completeness evidence for Draft Preview:
 * { pages, noKey, duplicates, gapPages, hitCap, failed }. `untilEmpty` keeps paging past a short page and stops
 * only at an empty one (so an irregular short page can never silently truncate the list). Callers that omit
 * both options behave exactly as before.
 */
export async function fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, subresource, { bestEffort = false, captureStatusTime = false, status = 'A', report = null, untilEmpty = false } = {}) {
  const players = [];
  const seen = new Set();
  let sawShortPage = false;
  let ended = false;
  if (report) Object.assign(report, { pages: 0, noKey: 0, duplicates: 0, gapPages: 0, hitCap: false, failed: false });
  for (let start = 0; start < MAX_PLAYERS; start += YAHOO_PLAYER_PAGE_SIZE) {
    let page;
    let statusFetchedAt = null;
    try {
      page = extractLeaguePlayers(await yahooFantasy(
        yahooDraftPlayersPath(leagueKey, subresource, start, YAHOO_PLAYER_PAGE_SIZE, status),
        accessToken,
      ));
      if (captureStatusTime) statusFetchedAt = new Date().toISOString();
      if (report) report.pages += 1;
    } catch (error) {
      if (report) report.failed = true;
      if (bestEffort) break;
      throw error;
    }
    if (untilEmpty && sawShortPage && page.length > 0 && report) report.gapPages += 1; // data after a short page
    for (const player of page) {
      if (!player?.playerKey) { if (report) report.noKey += 1; continue; }
      if (seen.has(player.playerKey)) { if (report) report.duplicates += 1; continue; }
      seen.add(player.playerKey);
      // This records receipt of the actual status-bearing page, never a cache read.
      players.push(captureStatusTime ? { ...player, yahooStatusFetchedAt: statusFetchedAt } : player);
    }
    if (untilEmpty) {
      if (page.length === 0) { ended = true; break; }
      sawShortPage = page.length < YAHOO_PLAYER_PAGE_SIZE;
    } else if (page.length < YAHOO_PLAYER_PAGE_SIZE) { ended = true; break; }
  }
  if (report && !ended && !report.failed) report.hitCap = true; // ran out of allowed pages without seeing the end of the list
  return players;
}

/**
 * Complete available pool with independently paged Yahoo metadata.
 * Pass `{ report }` (an object) to read paging evidence for the available list: it then also keeps paging past a short page and
 * stops only at an empty one (one extra request), so a truncated list can be detected. Without it behaviour is unchanged.
 */
export async function fetchYahooDraftPool(yahooFantasy, accessToken, leagueKey, { report = null } = {}) {
  const ownership = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'percent_owned', report ? { captureStatusTime: true, report, untilEmpty: true } : { captureStatusTime: true });
  // Keep optional metadata sequential to avoid a large concurrent burst against
  // Yahoo. A late optional-page failure preserves already fetched real values.
  const draftAnalysis = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'draft_analysis', { bestEffort: true });
  const ranks = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'ranks', { bestEffort: true });
  return mergeYahooPlayerMetadata(ownership, draftAnalysis, ranks);
}
