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
 * { pages, noKey, duplicates, hitCap, failed }. Callers that omit it behave as before.
 */
export async function fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, subresource, { bestEffort = false, captureStatusTime = false, status = 'A', report = null } = {}) {
  const players = [];
  const seen = new Set();
  if (report) Object.assign(report, { pages: 0, noKey: 0, duplicates: 0, hitCap: false, failed: false });
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
    for (const player of page) {
      if (!player?.playerKey) { if (report) report.noKey += 1; continue; }
      if (seen.has(player.playerKey)) { if (report) report.duplicates += 1; continue; }
      seen.add(player.playerKey);
      // This records receipt of the actual status-bearing page, never a cache read.
      players.push(captureStatusTime ? { ...player, yahooStatusFetchedAt: statusFetchedAt } : player);
    }
    if (page.length < YAHOO_PLAYER_PAGE_SIZE) break;
    if (report && start + YAHOO_PLAYER_PAGE_SIZE >= MAX_PLAYERS) report.hitCap = true; // last allowed page was still full
  }
  return players;
}

/** Complete available pool with independently paged Yahoo metadata. */
export async function fetchYahooDraftPool(yahooFantasy, accessToken, leagueKey) {
  const ownership = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'percent_owned', { captureStatusTime: true });
  // Keep optional metadata sequential to avoid a large concurrent burst against
  // Yahoo. A late optional-page failure preserves already fetched real values.
  const draftAnalysis = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'draft_analysis', { bestEffort: true });
  const ranks = await fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, 'ranks', { bestEffort: true });
  return mergeYahooPlayerMetadata(ownership, draftAnalysis, ranks);
}
