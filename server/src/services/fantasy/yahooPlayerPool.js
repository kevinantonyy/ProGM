import { extractPlayerList, mergeYahooPlayerMetadata, yahooDraftPlayersPath } from './normalize.js';

export const YAHOO_PLAYER_PAGE_SIZE = 25;
const MAX_PLAYERS = 1000;

function extractLeaguePlayers(data) {
  const leagueNode = data?.fantasy_content?.league;
  const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
  return extractPlayerList(playersNode);
}

/** Fetch every Yahoo available-player page for one subresource. */
export async function fetchYahooPlayerDataset(yahooFantasy, accessToken, leagueKey, subresource, { bestEffort = false, captureStatusTime = false } = {}) {
  const players = [];
  const seen = new Set();
  for (let start = 0; start < MAX_PLAYERS; start += YAHOO_PLAYER_PAGE_SIZE) {
    let page;
    let statusFetchedAt = null;
    try {
      page = extractLeaguePlayers(await yahooFantasy(
        yahooDraftPlayersPath(leagueKey, subresource, start, YAHOO_PLAYER_PAGE_SIZE),
        accessToken,
      ));
      if (captureStatusTime) statusFetchedAt = new Date().toISOString();
    } catch (error) {
      if (bestEffort) break;
      throw error;
    }
    for (const player of page) {
      if (!player?.playerKey || seen.has(player.playerKey)) continue;
      seen.add(player.playerKey);
      // This records receipt of the actual status-bearing page, never a cache read.
      players.push(captureStatusTime ? { ...player, yahooStatusFetchedAt: statusFetchedAt } : player);
    }
    if (page.length < YAHOO_PLAYER_PAGE_SIZE) break;
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
