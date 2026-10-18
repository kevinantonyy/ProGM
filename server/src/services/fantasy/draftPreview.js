import { extractPlayerList, mergeYahooPlayerMetadata, yahooPlayerKeysPath } from './normalize.js';
import { fetchYahooPlayerDataset, YAHOO_POOL_MAX_PLAYERS } from './yahooPlayerPool.js';

/** Draft Preview (read-only rankings for a completed draft). Off unless PROGM_DRAFT_PREVIEW is on/true/1. */
export function resolveDraftPreview(env = process.env) {
  return ['on', 'true', '1'].includes(String(env?.PROGM_DRAFT_PREVIEW ?? '').trim().toLowerCase());
}

const KEY_BATCH = 25; // Yahoo accepts up to 25 player_keys per request
export const PREVIEW_CACHE_PREFIX = 'bball:preview:v1';

function leaguePlayers(data) {
  const leagueNode = data?.fantasy_content?.league;
  const playersNode = Array.isArray(leagueNode) ? leagueNode.find((el) => el && el.players)?.players : null;
  return extractPlayerList(playersNode);
}

async function poolForStatus(yahooFantasy, token, leagueKey, status) {
  const report = {};
  const base = await fetchYahooPlayerDataset(yahooFantasy, token, leagueKey, 'percent_owned', { status, captureStatusTime: true, report });
  // Optional metadata is best-effort, exactly like the live Draft Helper pool.
  const draftAnalysis = await fetchYahooPlayerDataset(yahooFantasy, token, leagueKey, 'draft_analysis', { status, bestEffort: true });
  const ranks = await fetchYahooPlayerDataset(yahooFantasy, token, leagueKey, 'ranks', { status, bestEffort: true });
  return { players: mergeYahooPlayerMetadata(base, draftAnalysis, ranks), report };
}

/**
 * Complete league player pool for a finished draft: Yahoo status A (free agents) + T (taken), deduplicated by
 * player_key, then topped up from the draft results by player_key. Only read-only Yahoo GETs.
 *
 * `complete` is true only when every check passes; otherwise `reasons` says why and callers must not present the
 * ranking as a full-pool ranking.
 *
 * @param {Set<string>|null} draftedKeys player keys from the Yahoo draft results, or null when those were unavailable
 */
export async function fetchDraftPreviewPool(yahooFantasy, token, leagueKey, { draftedKeys = null, now = () => new Date() } = {}) {
  const available = await poolForStatus(yahooFantasy, token, leagueKey, 'A');
  const taken = await poolForStatus(yahooFantasy, token, leagueKey, 'T');

  const byKey = new Map();
  let listedInBoth = 0;
  for (const player of taken.players) byKey.set(player.playerKey, { ...player, poolSource: 'T' });
  for (const player of available.players) {
    // Paging while teams add/drop can list a player on both sides; the taken record wins.
    if (byKey.has(player.playerKey)) { listedInBoth += 1; continue; }
    byKey.set(player.playerKey, { ...player, poolSource: 'A' });
  }

  // Fallback: any drafted player the A/T queries missed is fetched by exact player_key.
  const missing = draftedKeys ? [...draftedKeys].filter((key) => !byKey.has(key)) : [];
  let fromFallback = 0;
  let fallbackFailedBatches = 0;
  for (let i = 0; i < missing.length; i += KEY_BATCH) {
    const batch = missing.slice(i, i + KEY_BATCH);
    try {
      const fetchedAt = now().toISOString();
      for (const player of leaguePlayers(await yahooFantasy(yahooPlayerKeysPath(leagueKey, batch, 'percent_owned'), token))) {
        if (!player?.playerKey || !batch.includes(player.playerKey) || byKey.has(player.playerKey)) continue;
        byKey.set(player.playerKey, { ...player, yahooStatusFetchedAt: fetchedAt, poolSource: 'draftResults' });
        fromFallback += 1;
      }
    } catch {
      fallbackFailedBatches += 1;
    }
  }
  const stillMissing = draftedKeys ? [...draftedKeys].filter((key) => !byKey.has(key)).length : null;

  const skippedWithoutKey = available.report.noKey + taken.report.noKey;
  const reasons = [];
  if (available.report.hitCap) reasons.push(`The free-agent list reached the ${YAHOO_POOL_MAX_PLAYERS}-player limit, so more players may exist.`);
  if (taken.report.hitCap) reasons.push(`The taken-player list reached the ${YAHOO_POOL_MAX_PLAYERS}-player limit, so more players may exist.`);
  if (taken.players.length === 0) reasons.push('Yahoo returned no taken players for this league.');
  if (skippedWithoutKey > 0) reasons.push(`${skippedWithoutKey} Yahoo player entries had no player key and could not be ranked.`);
  if (draftedKeys == null) reasons.push('Yahoo draft results were unavailable, so the pool could not be checked against the players who were drafted.');
  else if (draftedKeys.size === 0) reasons.push('Yahoo draft results contained no picks, so the pool could not be checked against the players who were drafted.');
  else if (stillMissing > 0) reasons.push(`${stillMissing} drafted ${stillMissing === 1 ? 'player is' : 'players are'} missing from the player pool even after fetching them by player key.`);

  return {
    players: [...byKey.values()],
    completeness: {
      complete: reasons.length === 0,
      reasons,
      counts: {
        total: byKey.size,
        available: available.players.length,
        taken: taken.players.length,
        draftedPicks: draftedKeys ? draftedKeys.size : null,
        fromDraftResultsFallback: fromFallback,
        fallbackFailedBatches,
        stillMissing,
        skippedWithoutKey,
        duplicatesRemoved: available.report.duplicates + taken.report.duplicates + listedInBoth,
      },
    },
  };
}
