/**
 * Adapters from data ProGM has ALREADY fetched into log observations. No network, no database, no credentials.
 * Only the named fields below are read; every other field on the input (owner, roster slot, league data) is ignored.
 */

export const ESPN_FEED_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const YAHOO_KEY_RE = /^(?:\d+|nba)\.p\.(\d+)$/;

/** Numeric Yahoo player id from a player key / editorial key / plain id. League and team keys never match. */
export function yahooPlayerNumber(p) {
  for (const candidate of [p.editorialPlayerKey, p.playerKey, p.id]) {
    const m = typeof candidate === 'string' ? YAHOO_KEY_RE.exec(candidate) : null;
    if (m) return m[1];
  }
  const id = p.playerId;
  if ((typeof id === 'string' || typeof id === 'number') && /^\d{1,12}$/.test(String(id))) return String(id);
  return null;
}

/**
 * Yahoo player pool rows: normalized players ({status,statusFull,injuryNote}) or draft-board rows ({status}).
 * Yahoo omits `status` for healthy players, so an absent status on a row that is present is recorded as basis
 * 'absent-status' (not as a reported status). The UI placeholder "Healthy" is treated the same way.
 */
export function fromYahooPlayers(players) {
  const observations = []; const skipped = [];
  if (!Array.isArray(players)) return { observations, skipped: [{ index: 0, reason: 'input-not-an-array' }] };
  players.forEach((p, index) => {
    if (!p || typeof p !== 'object') { skipped.push({ index, reason: 'row-not-an-object' }); return; }
    const num = yahooPlayerNumber(p);
    if (!num) { skipped.push({ index, reason: 'no-yahoo-player-id' }); return; }
    const status = typeof p.status === 'string' && p.status.trim() ? p.status : (typeof p.injuryStatus === 'string' && p.injuryStatus.trim() && p.injuryStatus !== 'Healthy' ? p.injuryStatus : null);
    const note = [p.injuryNote, p.statusFull, p.injuryDetail].find((v) => typeof v === 'string' && v.trim()) ?? null;
    observations.push({
      source: 'yahoo', playerId: `yahoo:${num}`, playerName: typeof p.name === 'string' ? p.name : null,
      rawStatus: status, note, basis: status ? 'reported' : 'absent-status',
      sourceUrl: null, sourcePublishedAt: null,
    });
  });
  return { observations, skipped };
}

/**
 * ESPN league-wide injuries: either the raw payload ({injuries:[{injuries:[...]}]}) or the already-mapped list
 * produced by mapEspnInjuries ([{externalId, designation, description}]). ESPN lists only injured players, so
 * absence from the feed is NOT recorded as healthy.
 */
export function fromEspnInjuries(input) {
  const observations = []; const skipped = [];
  const push = (index, id, name, rawStatus, note, published) => {
    if (id == null || !/^\d{1,12}$/.test(String(id))) { skipped.push({ index, reason: 'no-espn-athlete-id' }); return; }
    observations.push({ source: 'espn', playerId: `espn:${id}`, playerName: typeof name === 'string' ? name : null, rawStatus: typeof rawStatus === 'string' ? rawStatus : null, note, basis: 'reported', sourceUrl: ESPN_FEED_URL, sourcePublishedAt: published ?? null });
  };
  let index = 0;
  if (Array.isArray(input)) {
    for (const row of input) { push(index, row?.externalId, row?.name, row?.designation, row?.description ?? null, null); index += 1; }
  } else if (input && typeof input === 'object' && Array.isArray(input.injuries)) {
    for (const team of input.injuries) {
      for (const inj of Array.isArray(team?.injuries) ? team.injuries : []) {
        const a = inj?.athlete || {};
        push(index, a.id, a.displayName ?? a.fullName, inj?.status || inj?.type?.description || null, inj?.shortComment || inj?.longComment || null, inj?.date ?? null);
        index += 1;
      }
    }
  } else return { observations, skipped: [{ index: 0, reason: 'unrecognised-espn-input' }] };
  return { observations, skipped };
}

/** Locate Yahoo player rows in a saved file: an array, {players}, or a saved workspace response's draft board. */
export function yahooRowsFromFile(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    if (Array.isArray(json.players)) return json.players;
    const db = json.draftBoard;
    if (db && typeof db === 'object' && (Array.isArray(db.board) || Array.isArray(db.noData))) return [...(db.board || []), ...(db.noData || [])];
  }
  return null;
}
