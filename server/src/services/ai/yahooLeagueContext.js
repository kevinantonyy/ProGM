/**
 * Server-side builder of the MINIMUM Yahoo league context that may be sent to Gemini for one question.
 *
 * Input is the signed-in user's OWN cached workspace (read by the caller from a cache key that contains the authenticated user id).
 * Nothing here talks to Yahoo, the database or the network. Output objects are built FIELD BY FIELD from an explicit allowlist, never by
 * copying or spreading workspace objects, so a field added to the workspace later cannot leak. Then the result is scanned and refused
 * on any credential, identifier, URL or Yahoo-key shape.
 *
 * Never included: tokens or secrets, email, username, Yahoo identifiers/keys, league / team / manager names (other teams are pseudonyms),
 * images and URLs, Yahoo ownership percentages, ADP and Yahoo ranks.
 */
export const MAX_SECTIONS = 3; // including `overview`
export const MAX_CONTEXT_BYTES = 6144;

// Order = priority when more sections match than fit. `overview` is always present and counts toward MAX_SECTIONS.
const SECTION_RULES = [
  ['lineup', /\b(start|starting|sit|bench|lineup|line-up|optimi[sz]e|slot|slots)\b/i],
  ['waivers', /\b(waivers?|pick ?ups?|pick up|free[- ]agents?|add|drop|stream|streaming|available)\b/i],
  ['trades', /\b(trade|trades|trading|buy|sell|offer|package)\b/i],
  ['standings', /\b(standings?|rankings?|playoffs?|power|schedule|matchups?|opponents?|seed)\b/i],
  ['draft', /\b(draft|adp|keepers?|sleepers?|prospects?|pick)\b(?! ?ups?\b)(?! up\b)/i],
  ['roster', /\b(roster|team|weak|weakness|weaknesses|strengths?|depth|injur\w*|injured|players?|positions?|needs?|improve)\b/i],
];

/** Which sections a question needs, decided by the server from the latest user message only. */
export function chooseSections(question) {
  const text = String(question || '');
  const matched = SECTION_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  return ['overview', ...matched.slice(0, MAX_SECTIONS - 1)];
}

const FORBIDDEN_KEY = /token|secret|password|passwd|hash|email|guid|authorization|cookie|refresh|access|api_?key|player_?key|team_?key|league_?key|user_?id|username|image|logo|url|owned|adp|manager|ownerteam/i;
const FORBIDDEN_VALUE = [
  ['email', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['bearer', /\bbearer\s+\S/i],
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{4,}\./],
  ['url', /https?:\/\//i],
  ['long_token', /(?<![\w.-])[A-Za-z0-9_\-+/=]{32,}(?![\w.-])/],
  ['yahoo_key', /\b\d{2,4}\.[lpt]\.\d+/],
];

const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const text = (s, max = 160) => (typeof s === 'string' ? s.slice(0, max) : null);
const list = (v) => (Array.isArray(v) ? v : []);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const knownTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function dataQuality(ws, cacheInfo) {
  const provider = ws?.externalData?.freshness;
  const roster = Array.isArray(ws?.myTeam?.roster) ? ws.myTeam.roster : null;
  const missing = roster ? roster.filter((p) => round1(p?.projectedPoints) == null).length : null;
  const partialLineup = Number.isInteger(ws?.lineup?.currentMissingDataCount) ? ws.lineup.currentMissingDataCount : null;
  const notes = ['ProGM projections and recommendation gains are estimates, not observed results. Standings are Yahoo observations.'];
  const stale = cacheInfo?.stale === true || provider?.stale === true ? true
    : cacheInfo?.stale === false && provider?.stale === false ? false : null;
  if (stale) notes.push('Cached data is stale; do not describe it as live.');
  if (!knownTime(cacheInfo?.fetchedAt) || !knownTime(provider?.fetchedAt)) notes.push('Some data freshness is unknown; do not invent an as-of time.');
  if (missing == null) notes.push('Roster projection coverage is unknown.');
  else if (missing > 0) notes.push('Some roster players lack projections; comparisons may be partial.');
  if (partialLineup > 0) notes.push('Some current starters lack projections; the lineup gain may be overstated.');
  if (ws?.externalData?.available !== true) notes.push('External projection availability is not confirmed.');
  return { workspaceCachedAt: knownTime(cacheInfo?.fetchedAt), providerFetchedAt: knownTime(provider?.fetchedAt), stale,
    rosterPlayersWithoutProjection: missing, lineupStartersWithoutProjection: partialLineup, notes };
}

function player(p) {
  if (!p || typeof p !== 'object') return null;
  const positions = list(p.eligiblePositions).filter((x) => typeof x === 'string').join('/') || (typeof p.position === 'string' ? p.position : null);
  const status = typeof p.injuryStatus === 'string' && p.injuryStatus && p.injuryStatus !== 'Healthy' ? p.injuryStatus : null;
  return { name: text(p.name, 60), pos: positions, team: text(p.teamAbbr, 5), proj: round1(p.projectedPoints), ...(status ? { status: text(status, 24) } : {}), ...(typeof p.isStarting === 'boolean' ? { starting: p.isStarting } : {}),
    ...(typeof p.estimate === 'boolean' ? { estimate: p.estimate } : {}),
    ...(round2(p.projectionConfidence) != null ? { confidence: round2(p.projectionConfidence) } : {}) };
}

/** Pseudonyms: your team is "Your team", other teams "Team A".. by order of appearance; league and manager names collapse to neutral words. */
function makePseudonyms(ws) {
  const myKey = ws?.myTeam?.id ?? ws?.connection?.teamKey ?? null;
  const byKey = new Map();
  const replacements = []; // [name, replacement]
  let next = 0;
  const label = () => `Team ${String.fromCharCode(65 + (next++ % 26))}${next > 26 ? Math.floor((next - 1) / 26) : ''}`;
  const addTeam = (key, name, mine) => {
    const k = key ?? `name:${name}`;
    if (!byKey.has(k)) byKey.set(k, mine ? 'Your team' : label());
    if (typeof name === 'string' && name.length >= 3) replacements.push([name, byKey.get(k)]);
    return byKey.get(k);
  };
  addTeam(myKey, ws?.myTeam?.name ?? ws?.connection?.teamName, true);
  for (const t of list(ws?.standings)) {
    const mine = t?.isMine === true || (myKey != null && t?.id === myKey);
    addTeam(mine ? myKey : t?.id, t?.name, mine);
    if (typeof t?.manager === 'string' && t.manager.length >= 3) replacements.push([t.manager, 'someone']);
  }
  for (const t of list(ws?.recommendedTrades?.recommendations)) if (t?.withTeamKey) addTeam(t.withTeamKey, t.withTeam, false);
  if (typeof ws?.connection?.leagueName === 'string' && ws.connection.leagueName.length >= 3) replacements.push([ws.connection.leagueName, 'the league']);
  replacements.sort((a, b) => b[0].length - a[0].length); // longest first so "Team Alpha Two" is not clobbered by "Team Alpha"
  const scrub = (s) => {
    if (typeof s !== 'string') return null;
    return replacements.reduce((out, [name, rep]) => out.replace(new RegExp(esc(name), 'gi'), rep), s);
  };
  return { teamLabel: (key, name) => byKey.get(key) || byKey.get(`name:${name}`) || 'another team', scrub, names: replacements.map(([n]) => n) };
}

const BUILDERS = {
  overview(ws) {
    const cats = list(ws?.settings?.statCategories).filter((c) => c && c.enabled !== false);
    const slots = list(ws?.settings?.rosterSlots).filter((s) => s && s.count > 0);
    const r = ws?.rating || null;
    return {
      season: text(String(ws?.connection?.season ?? ''), 9) || null,
      scoring: text(ws?.settings?.scoringType, 40),
      teams: typeof ws?.settings?.teamCount === 'number' ? ws.settings.teamCount : null,
      stats: cats.slice(0, 25).map((c) => (c.pointValue != null ? `${text(c.abbr || c.name, 12)} ${c.pointValue}` : text(c.abbr || c.name, 12))),
      slots: slots.slice(0, 15).map((s) => `${text(s.position, 6)}x${s.count}`),
      rating: r && r.overall != null ? { overall: r.overall, rank: r.rank ?? null, of: r.teamCount ?? null, basis: text(r.basis, 40) } : null,
      rosterSize: ws?.analysis?.rosterSize ?? list(ws?.myTeam?.roster).length,
      injured: ws?.analysis?.injured ?? null,
    };
  },
  roster(ws) {
    return { players: list(ws?.myTeam?.roster).slice(0, 20).map(player).filter(Boolean) };
  },
  lineup(ws, ps) {
    const lu = ws?.lineup;
    const ss = ws?.startSit;
    return {
      projectedNow: round1(lu?.projectedCurrentPoints), projectedBest: round1(lu?.projectedOptimizedPoints), gain: round1(lu?.projectedDifference),
      swaps: list(lu?.swaps).slice(0, 5).map((s) => ({ start: text(s?.in?.name, 60), bench: text(s?.out?.name, 60), gain: round1(s?.projectedGain), why: ps.scrub(text(list(s?.reasons)[0], 140)) })),
      startSit: list(ss?.benchOverStarter).slice(0, 5).map((s) => ({ start: text(s?.start?.name, 60), sit: text(s?.sit?.name, 60), gain: round1(s?.gain), why: ps.scrub(text(s?.reason, 140)) })),
    };
  },
  waivers(ws) {
    const w = ws?.waivers;
    if (!w?.projectionsAvailable) return { available: false };
    return {
      best: list(w.bestAvailable).slice(0, 6).map(player).filter(Boolean),
      fit: list(w.bestFit).slice(0, 6).map((p) => ({ ...player(p), fit: round2(p?.fitScore) })),
      addDrop: list(w.addDrop).slice(0, 5).map((m) => ({ add: text(m?.add?.name, 60), drop: text(m?.drop?.name, 60), net: round1(m?.netImprovement), category: text(m?.category, 16) })),
    };
  },
  trades(ws, ps) {
    return {
      ideas: list(ws?.recommendedTrades?.recommendations).slice(0, 4).map((t) => ({
        with: ps.teamLabel(t?.withTeamKey, t?.withTeam),
        send: list(t?.send).map((p) => text(p?.name, 60)).filter(Boolean).slice(0, 4),
        receive: list(t?.receive).map((p) => text(p?.name, 60)).filter(Boolean).slice(0, 4),
        gain: round1(t?.production?.net), fairness: text(t?.fairness, 24), why: ps.scrub(text(list(t?.whyForMe)[0], 140)),
      })),
    };
  },
  standings(ws, ps) {
    return {
      table: list(ws?.standings).slice(0, 16).map((t) => ({ team: t?.isMine === true ? 'Your team' : ps.teamLabel(t?.id, t?.name), rank: t?.rank ?? null, w: t?.wins ?? null, l: t?.losses ?? null, t: t?.ties ?? null })),
    };
  },
  draft(ws) {
    return {
      board: list(ws?.draftBoard?.board).slice(0, 10).map((p) => ({ name: text(p?.name, 60), progmRank: p?.overallRank ?? null, tier: p?.tier ?? null, fit: text(p?.rosterFit, 12), availability: text(p?.availability, 12), estimate: typeof p?.estimate === 'boolean' ? p.estimate : null })),
    };
  },
};

function scanKeys(value, path = '') {
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { const hit = scanKeys(value[i], `${path}[${i}]`); if (hit) return hit; } return null; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) return `key:${path ? `${path}.` : ''}${k}`;
      const hit = scanKeys(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

function scanValues(value) {
  if (typeof value === 'string') { for (const [kind, re] of FORBIDDEN_VALUE) if (re.test(value)) return `value:${kind}`; return null; }
  if (Array.isArray(value)) { for (const v of value) { const hit = scanValues(v); if (hit) return hit; } return null; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) { const hit = scanValues(v); if (hit) return hit; } }
  return null;
}

/** Trim the longest list in a non-overview section until the JSON fits; fails closed if it cannot. */
function fitToBudget(context) {
  const size = () => Buffer.byteLength(JSON.stringify(context), 'utf8');
  while (size() > MAX_CONTEXT_BYTES) {
    let longest = null;
    for (const [section, body] of Object.entries(context)) {
      if (section === 'overview' || !body || typeof body !== 'object') continue;
      for (const [k, v] of Object.entries(body)) if (Array.isArray(v) && v.length > 1 && (!longest || v.length > longest.arr.length)) longest = { arr: v, section, k };
    }
    if (!longest) return false;
    longest.arr.pop();
  }
  return true;
}

/**
 * @param {{ workspace: object, question: string, forbiddenValues?: string[] }} args
 * `forbiddenValues`: exact strings (user name, e-mail, ...) that must not appear anywhere in the context.
 */
export function buildYahooLeagueContext({ workspace, question, forbiddenValues = [], cacheInfo = null }) {
  if (!workspace || typeof workspace !== 'object' || workspace.provider !== 'yahoo') return { ok: false, reason: 'no_workspace' };
  const ps = makePseudonyms(workspace);
  const sections = chooseSections(question);
  const context = {};
  for (const name of sections) context[name] = BUILDERS[name](workspace, ps);
  context.overview.dataQuality = dataQuality(workspace, cacheInfo);
  if (!fitToBudget(context)) return { ok: false, reason: 'context_too_large' };

  const keyHit = scanKeys(context);
  if (keyHit) return { ok: false, reason: `leak_guard:${keyHit}` };
  const valueHit = scanValues(context);
  if (valueHit) return { ok: false, reason: `leak_guard:${valueHit}` };
  const body = JSON.stringify(context).toLowerCase();
  const isPseudonym = (v) => /^(your team|team [a-z]\d*|the league|someone)$/i.test(v.trim());
  const exact = [...ps.names, ...forbiddenValues].filter((v) => typeof v === 'string' && v.trim().length >= 4 && !isPseudonym(v));
  for (const value of exact) {
    if (body.includes(value.trim().toLowerCase())) return { ok: false, reason: 'leak_guard:exact_value' };
  }
  return { ok: true, context, sections, bytes: Buffer.byteLength(JSON.stringify(context), 'utf8') };
}

const NOTICES = {
  no_consent: 'Personalized answers are off. Turn on “Personalize with my league” to use your roster; this answer is general.',
  no_yahoo: 'Connect Yahoo Fantasy to use personalized answers; this answer is general.',
  cold_cache: 'Reload your league (use Refresh on the workspace), then ask again. This answer is general.',
  bad_selection: 'Open your league in the workspace, then ask again. This answer is general.',
  withheld: 'ProGM could not prepare a safe summary of your league for this question, so this answer is general.',
};

/**
 * Production builder for the `yahoo_league` source. Everything it reads is injected:
 *  consent        { hasActiveConsent(userId) }
 *  readWorkspace  ({ userId, leagueKey, teamKey }) -> { value } | null   (cache ONLY; must never call Yahoo)
 *  hasYahooConnection(userId) -> boolean
 *  loadIdentity(userId) -> { username, email } (used only to guarantee they are NOT in the outgoing context)
 * Returns { context, sections, bytes } or { unavailable, notice }.
 */
const LEAGUE_KEY = /^\d+\.l\.\d+$/;
const TEAM_KEY = /^\d+\.l\.\d+\.t\.\d+$/;

export function createYahooLeagueBuilder({ consent, readWorkspace, hasYahooConnection, loadIdentity }) {
  const unavailable = (reason, notice) => ({ unavailable: reason, notice });
  return async ({ userId, question, selectors = {} }) => {
    if (userId == null) return unavailable('no_user', NOTICES.no_consent);
    if (!(await consent.hasActiveConsent(userId))) return unavailable('no_consent', NOTICES.no_consent);
    if (!(await hasYahooConnection(userId))) return unavailable('no_yahoo_connection', NOTICES.no_yahoo);
    const { leagueKey, teamKey } = selectors;
    if (typeof leagueKey !== 'string' || typeof teamKey !== 'string' || !LEAGUE_KEY.test(leagueKey) || !TEAM_KEY.test(teamKey) || !teamKey.startsWith(`${leagueKey}.t.`)) {
      return unavailable('bad_selection', NOTICES.bad_selection);
    }
    const hit = await readWorkspace({ userId, leagueKey, teamKey });
    const workspace = hit?.value;
    if (!workspace) return unavailable('cold_cache', NOTICES.cold_cache);
    if (workspace.connection?.leagueKey !== leagueKey || workspace.connection?.teamKey !== teamKey) return unavailable('bad_selection', NOTICES.bad_selection);
    const identity = (await loadIdentity(userId)) || {};
    const built = buildYahooLeagueContext({ workspace, question, forbiddenValues: [identity.username, identity.email], cacheInfo: hit });
    if (!built.ok) return unavailable(built.reason, NOTICES.withheld);
    return built;
  };
}
