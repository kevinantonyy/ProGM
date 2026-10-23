/**
 * What may be sent to an external AI provider (currently Google Gemini via routes/gm.js).
 *
 * PROVENANCE IS SERVER-CONTROLLED. The server never forwards league data that the browser supplies, and never trusts a browser-supplied
 * label ("source: espn") as proof of where data came from: a label is just text. The only context that can reach the provider is
 * produced by a SERVER-SIDE BUILDER that is (1) registered in code, (2) listed below with an explicit allowance, and (3) switched on by a
 * server-side setting. Everything else is restricted, and so is anything ambiguous. The user's own typed chat messages are the one
 * always-allowed input (they are what the user chose to send), and general chat keeps working with no league context at all.
 *
 * Allowlist (explicit; default for every league source is NOT allowed):
 *   user_message          allowed   text the user typed into the chat
 *   espn_football_league  blocked   ESPN-derived; Disney's terms restrict automated access, commercial use and AI tooling; no permission established
 *   yahoo_league          OFF       Yahoo-derived. Off unless the server switch PROGM_AI_YAHOO_DATA is exactly "allow" AND the user has an active
 *                                   server-recorded consent AND the builder (services/ai/yahooLeagueContext.js) produces a minimized context.
 *                                   Yahoo's permission for third-party AI processing is NOT established; the switch is the kill switch.
 *
 * A source is usable only if (1) a server builder is wired (index.js), (2) the matching environment variable is exactly "allow".
 * Nothing in the repository sets either variable.
 */

export const AI_SOURCES = Object.freeze({
  user_message: Object.freeze({ allowed: true, rights: 'Text the user typed into the chat. Not league data.' }),
  espn_football_league: Object.freeze({ allowed: false, overrideEnv: 'PROGM_AI_ESPN_DATA', rights: 'ESPN-derived; permission to send to a third-party AI provider is not established.' }),
  yahoo_league: Object.freeze({ allowed: false, overrideEnv: 'PROGM_AI_YAHOO_DATA', rights: 'Yahoo-derived; permission to send to a third-party AI provider is not established.' }),
});

/** Server-side context builders, by source name. Intentionally EMPTY: no league data can be built for the AI provider today. */
export const DEFAULT_BUILDERS = Object.freeze({});

// Keys that only exist on Yahoo-sourced objects in this codebase (Yahoo keys, ADP/rank, ownership, draft analysis).
const YAHOO_KEY = /yahoo|^(player|league|team)_?key$|^percent_?owned$|^owned_?pct$|^draft_?analysis$/i;

/** Paths of keys inside `value` that look Yahoo-derived (iterative, bounded; never throws on odd input). */
export function findYahooMarkers(value, { limit = 5, maxNodes = 50_000 } = {}) {
  const found = [];
  const stack = [{ node: value, path: '' }];
  let visited = 0;
  while (stack.length && found.length < limit && visited < maxNodes) {
    const { node, path } = stack.pop();
    visited += 1;
    if (Array.isArray(node)) { node.forEach((item, i) => stack.push({ node: item, path: `${path}[${i}]` })); continue; }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (found.length >= limit) break;
        const here = path ? `${path}.${key}` : key;
        if (YAHOO_KEY.test(key)) found.push(here);
        stack.push({ node: child, path: here });
      }
    }
  }
  return found;
}

export function sourceEnabled(source, env = process.env) {
  const entry = AI_SOURCES[source];
  if (!entry || source === 'user_message') return false;
  if (entry.allowed) return true;
  return String(env?.[entry.overrideEnv] ?? '').trim().toLowerCase() === 'allow';
}

export const BLOCKED_NOTICE = 'League data is not shared with the AI provider. Answers are general; describe the players or situation you want help with.';

export const YAHOO_OFF_NOTICE = 'Personalized answers are not available right now. This answer is general.';

const none = (reason, extra = {}) => ({ context: null, shared: false, source: null, blocked: false, reason, notice: null, sections: [], bytes: 0, ...extra });
const blocked = (source, reason, notice = BLOCKED_NOTICE) => ({ context: null, shared: false, source, blocked: true, reason, notice, sections: [], bytes: 0 });

/**
 * Decide what league context (if any) goes to the provider.
 * `contextRequest` is only a REQUEST from the browser ("I would like context of this kind"): it cannot supply data and cannot make a
 * source allowed. The context itself comes from `builders[source]`, server code reading server-held data, and is built for the
 * `question` (the latest user message) from `selectors` (league/team keys: lookups, never data and never proof of anything).
 * A builder returns { context, sections, bytes } or { unavailable, notice }.
 */
export async function resolveAiContext({ userId, contextRequest, question = '', selectors = {}, env = process.env, builders = DEFAULT_BUILDERS } = {}) {
  if (contextRequest == null || contextRequest === '') return none('no_context_requested');
  if (typeof contextRequest !== 'string') return blocked('invalid', 'unknown_source'); // arrays, objects and numbers are never coerced into a name
  const source = contextRequest;
  if (!Object.hasOwn(AI_SOURCES, source) || source === 'user_message') return blocked(source, 'unknown_source');
  if (!sourceEnabled(source, env)) return blocked(source, `${source}_not_permitted`, source === 'yahoo_league' ? YAHOO_OFF_NOTICE : BLOCKED_NOTICE);
  const builder = Object.hasOwn(builders, source) ? builders[source] : null;
  if (typeof builder !== 'function') return blocked(source, 'no_server_builder');
  let result;
  try { result = await builder({ userId, question, selectors }); } catch { return blocked(source, 'builder_failed'); }
  if (result?.unavailable) return blocked(source, String(result.unavailable), typeof result.notice === 'string' ? result.notice : BLOCKED_NOTICE);
  const context = result?.context;
  if (context == null || typeof context !== 'object') return blocked(source, 'builder_returned_nothing');
  // Defence in depth: server-built context for a non-Yahoo source must not contain Yahoo-shaped data.
  if (source !== 'yahoo_league' && findYahooMarkers(context).length) return blocked(source, 'yahoo_markers_in_server_context');
  return { context, shared: true, source, blocked: false, reason: 'server_built_allowlisted_context', notice: null, sections: Array.isArray(result.sections) ? result.sections : [], bytes: Number(result.bytes) || 0 };
}
