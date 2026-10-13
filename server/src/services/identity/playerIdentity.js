/**
 * Provider-independent player identity layer.
 *
 * Maps a Yahoo player -> canonical ProGM player -> external-provider player.
 * The rest of ProGM consumes canonical players and never re-implements name
 * matching.
 *
 * Matching strategy (in priority order):
 *   1. yahoo_id  — exact match on the external provider's yahooPlayerID
 *                  cross-reference (Tank01 provides this). Highest confidence.
 *   2. name_team — normalized full name AND same NBA team abbreviation.
 *   3. name_only — normalized full name, unique across the provider set.
 *
 * If more than one external candidate matches at a given tier, the player is
 * recorded as AMBIGUOUS and left unmatched (never silently guessed).
 *
 * @typedef {Object} ExternalPlayerRef
 * @property {string} externalId          Provider player id
 * @property {string} name                Provider full name
 * @property {string|null} teamAbbr       Provider NBA team abbreviation
 * @property {string|null} yahooId        Provider-supplied Yahoo cross-ref id (if any)
 * @property {string|null} imageUrl       Provider-supplied headshot URL (if any)
 *
 * @typedef {Object} CanonicalPlayer
 * @property {string} canonicalId         ProGM canonical id (Yahoo player key when sourced from Yahoo)
 * @property {string} name
 * @property {string|null} teamAbbr
 * @property {string|null} yahooPlayerId
 * @property {string|null} externalId     Matched provider id, or null
 * @property {'yahoo_id'|'name_team'|'name_only'|null} matchMethod
 * @property {boolean} matched
 */

// NBA team aliases so differing abbreviations across providers still align.
const TEAM_ALIASES = {
  GS: 'GSW', GSW: 'GSW',
  NY: 'NYK', NYK: 'NYK',
  NO: 'NOP', NOP: 'NOP', NOR: 'NOP',
  SA: 'SAS', SAS: 'SAS',
  PHX: 'PHO', PHO: 'PHO',
  UTA: 'UTA', UTAH: 'UTA',
  WSH: 'WAS', WAS: 'WAS',
  BKN: 'BKN', BRK: 'BKN',
  CHA: 'CHA', CHO: 'CHA',
};

export function normalizeTeam(abbr) {
  if (!abbr) return null;
  const upper = String(abbr).toUpperCase().trim();
  return TEAM_ALIASES[upper] || upper;
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Normalize a player name for comparison:
 *   - lower-case
 *   - strip accents/diacritics
 *   - remove punctuation (periods, apostrophes, hyphens -> space)
 *   - drop generational suffixes (Jr, Sr, II, III, IV, V)
 *   - collapse whitespace
 */
export function normalizeName(name) {
  if (!name) return '';
  const stripped = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacritics
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/[-_/]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = stripped.split(' ').filter((t) => t && !SUFFIXES.has(t));
  return tokens.join(' ');
}

/**
 * Build fast lookup indexes over the external player set.
 * @param {ExternalPlayerRef[]} externalPlayers
 */
function indexExternal(externalPlayers) {
  const byYahooId = new Map();
  const byNameTeam = new Map();
  const byName = new Map();

  for (const ext of externalPlayers) {
    if (ext.yahooId != null && ext.yahooId !== '') {
      byYahooId.set(String(ext.yahooId), ext);
    }
    const nName = normalizeName(ext.name);
    if (!nName) continue;

    const team = normalizeTeam(ext.teamAbbr);
    if (team) {
      const key = `${nName}|${team}`;
      if (!byNameTeam.has(key)) byNameTeam.set(key, []);
      byNameTeam.get(key).push(ext);
    }
    if (!byName.has(nName)) byName.set(nName, []);
    byName.get(nName).push(ext);
  }

  return { byYahooId, byNameTeam, byName };
}

/**
 * Match one Yahoo/canonical-source player against the external index.
 * Returns { externalId, matchMethod, matched, ambiguous }.
 */
function matchOne(sourcePlayer, index) {
  const yahooId = sourcePlayer.yahooPlayerId != null ? String(sourcePlayer.yahooPlayerId) : null;

  // Tier 1: exact yahoo id cross-reference.
  if (yahooId && index.byYahooId.has(yahooId)) {
    const match = index.byYahooId.get(yahooId);
    return { externalId: match.externalId, imageUrl: match.imageUrl || null, matchMethod: 'yahoo_id', matched: true, ambiguous: false };
  }

  const nName = normalizeName(sourcePlayer.name);
  const team = normalizeTeam(sourcePlayer.teamAbbr);

  // Tier 2: normalized name + team.
  if (nName && team) {
    const candidates = index.byNameTeam.get(`${nName}|${team}`) || [];
    if (candidates.length === 1) {
      return { externalId: candidates[0].externalId, imageUrl: candidates[0].imageUrl || null, matchMethod: 'name_team', matched: true, ambiguous: false };
    }
    if (candidates.length > 1) {
      return { externalId: null, matchMethod: null, matched: false, ambiguous: true };
    }
  }

  // Tier 3: normalized name, unique across the whole set.
  if (nName) {
    const candidates = index.byName.get(nName) || [];
    if (candidates.length === 1) {
      return { externalId: candidates[0].externalId, imageUrl: null, matchMethod: 'name_only', matched: true, ambiguous: false };
    }
    if (candidates.length > 1) {
      return { externalId: null, matchMethod: null, matched: false, ambiguous: true };
    }
  }

  return { externalId: null, matchMethod: null, matched: false, ambiguous: false };
}

/**
 * Build canonical players by matching source (Yahoo-normalized) players to an
 * external provider player set. Returns canonical players + diagnostics.
 *
 * @param {Array<{playerKey?:string, playerId?:string, name:string, teamAbbr?:string|null, yahooPlayerId?:string|null}>} sourcePlayers
 * @param {ExternalPlayerRef[]} externalPlayers
 * @returns {{ players: CanonicalPlayer[], byCanonicalId: Map<string,CanonicalPlayer>, diagnostics: Object }}
 */
export function buildCanonicalPlayers(sourcePlayers, externalPlayers = []) {
  const index = indexExternal(externalPlayers);
  const players = [];
  const diagnostics = {
    total: sourcePlayers.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    byMethod: { yahoo_id: 0, name_team: 0, name_only: 0 },
    unmatchedPlayers: [], // { name, teamAbbr, reason }
  };

  for (const sp of sourcePlayers) {
    const canonicalId = sp.playerKey || sp.playerId || normalizeName(sp.name);
    const yahooPlayerId = sp.yahooPlayerId != null
      ? String(sp.yahooPlayerId)
      : (sp.playerId != null ? String(sp.playerId) : null);

    const result = matchOne({ ...sp, yahooPlayerId }, index);

    if (result.matched) {
      diagnostics.matched += 1;
      diagnostics.byMethod[result.matchMethod] += 1;
    } else {
      diagnostics.unmatched += 1;
      if (result.ambiguous) diagnostics.ambiguous += 1;
      diagnostics.unmatchedPlayers.push({
        name: sp.name,
        teamAbbr: sp.teamAbbr || null,
        reason: result.ambiguous ? 'ambiguous' : 'no_match',
      });
    }

    players.push({
      canonicalId,
      name: sp.name,
      teamAbbr: normalizeTeam(sp.teamAbbr),
      yahooPlayerId,
      externalId: result.externalId,
      imageUrl: result.imageUrl || null,
      matchMethod: result.matchMethod,
      matched: result.matched,
    });
  }

  diagnostics.matchRate = diagnostics.total ? Number((diagnostics.matched / diagnostics.total).toFixed(3)) : 0;
  const byCanonicalId = new Map(players.map((p) => [p.canonicalId, p]));
  return { players, byCanonicalId, diagnostics };
}

/**
 * Derive the numeric Yahoo player id from a Yahoo editorial_player_key
 * ("nba.p.10290" -> "10290") or player_key ("454.p.10290" -> "10290").
 */
export function yahooIdFromKeys({ editorialPlayerKey, playerKey, playerId } = {}) {
  if (editorialPlayerKey && editorialPlayerKey.includes('.p.')) return editorialPlayerKey.split('.p.')[1];
  if (playerKey && playerKey.includes('.p.')) return playerKey.split('.p.')[1];
  return playerId != null ? String(playerId) : null;
}
