/**
 * Server-side ranking feature flags. Both default OFF, so production keeps the legacy model.
 *
 *   PROGM_RANKING_MODEL=v2        draft value without the separate min-max scarcity bonus
 *   PROGM_RANKING_SHADOW=on       compute v2 beside the legacy board for diagnostics only; users still get legacy
 *   PROGM_ROOKIE_ESTIMATES=on     low-confidence, clearly flagged estimates for players with no NBA stat line
 *
 * Weights (value = (sum of weight*component) * (0.9 + 0.1*confidence) * 100):
 *   legacy: 0.70 production + 0.20 replacement + 0.05 scarcity + 0.05 roster fit   (current production)
 *   v2:     0.75 production + 0.20 replacement + 0.00 scarcity + 0.05 roster fit
 * v2 moves the scarcity weight to the position-neutral production term so scores stay on one scale.
 * Scarcity and replacement both derive from eligible-player supply, so legacy counts positional supply twice.
 *
 * Anything other than the exact documented values (including unset, empty or a typo) keeps the legacy model.
 */
import { resolveProjectionAdjustmentForUser } from './projectionAdjustment.js';

export const RANKING_MODELS = Object.freeze({
  legacy: Object.freeze({ id: 'legacy', weights: Object.freeze({ production: 0.70, replacement: 0.20, scarcity: 0.05, rosterFit: 0.05 }) }),
  v2: Object.freeze({ id: 'v2', weights: Object.freeze({ production: 0.75, replacement: 0.20, scarcity: 0, rosterFit: 0.05 }) }),
});
export const DEFAULT_RANKING_MODEL = 'legacy';

export function normalizeRankingModel(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(RANKING_MODELS, id) ? id : DEFAULT_RANKING_MODEL;
}
export function rankingModelInfo(id) { return RANKING_MODELS[normalizeRankingModel(id)]; }

export function resolveRankingModel(env = process.env) { return normalizeRankingModel(env?.PROGM_RANKING_MODEL); }

/**
 * Account-scoped v2: PROGM_RANKING_V2_USER_IDS is a comma/space separated list of numeric ProGM user ids. Listed accounts get v2;
 * every other account (and any request without a user id) gets the global model, which stays legacy unless PROGM_RANKING_MODEL
 * is set. Malformed entries are ignored, never treated as a wildcard.
 */
export function parseV2UserIds(env = process.env) {
  return new Set(String(env?.PROGM_RANKING_V2_USER_IDS ?? '').split(/[\s,]+/).filter((x) => /^\d{1,12}$/.test(x)).map((x) => String(Number(x))));
}

export function resolveRankingModelForUser(userId, env = process.env) {
  const id = userId == null ? '' : String(userId).trim();
  if (/^\d{1,12}$/.test(id) && parseV2UserIds(env).has(String(Number(id)))) return 'v2';
  return resolveRankingModel(env);
}

export function resolveRookieEstimates(env = process.env) {
  return ['on', 'true', '1'].includes(String(env?.PROGM_ROOKIE_ESTIMATES ?? '').trim().toLowerCase());
}

/**
 * Cache identity: any cached ranking, frozen baseline reference or workspace payload must be keyed by this,
 * so rankings built under different flags can never be served for one another.
 */
export function rankingProfile(env = process.env) {
  return `${resolveRankingModel(env)}.${resolveRookieEstimates(env) ? 'est' : 'noest'}`;
}

/** Per-account cache identity: every cached ranking, workspace or frozen baseline must be keyed with THIS, never the global one. */
export function rankingProfileForUser(userId, env = process.env) {
  // '.pam' (projection: age+minutes) only for accounts on the experimental projection, so every other account keeps its exact keys.
  return `${resolveRankingModelForUser(userId, env)}.${resolveRookieEstimates(env) ? 'est' : 'noest'}${resolveProjectionAdjustmentForUser(userId, env) ? '.pam' : ''}`;
}

/**
 * Shadow mode: only while the visible model is legacy and rookie estimates are off, so the comparison is
 * legacy vs v2 over identical inputs. It never changes rankingProfile(), so cache identity and output are untouched.
 */
export function resolveRankingShadow(env = process.env, userId = null) {
  const on = ['on', 'true', '1'].includes(String(env?.PROGM_RANKING_SHADOW ?? '').trim().toLowerCase());
  return on && resolveRankingModelForUser(userId, env) === 'legacy' && !resolveRookieEstimates(env);
}

/**
 * Ranking diagnostics endpoints (ranking-compare, ranking-shadow). Off by default. In NODE_ENV=production they stay
 * closed unless PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION=yes is ALSO set, so a stray flag cannot open them on Render.
 */
export function rankingDiagnosticsEnabled(env = process.env) {
  if (String(env?.PROGM_RANKING_DIAGNOSTIC ?? '').trim().toLowerCase() !== 'on') return false;
  if (String(env?.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    return String(env?.PROGM_RANKING_DIAGNOSTIC_ALLOW_PRODUCTION ?? '').trim().toLowerCase() === 'yes';
  }
  return true;
}
