/**
 * EXPERIMENTAL age + minutes projection adjustment (account-scoped, default OFF).
 *
 *   PROGM_PROJECTION_ADJ_USER_IDS=<comma/space separated numeric ProGM user ids>
 *
 * What it does (draft board and Rankings tab only; waivers, trades, lineups and start/sit never see it):
 *   existing projection (unchanged formula)  +  delta
 *   delta = [ lastSeasonPointsPerMinute * ageFactor * predictedMinutes ]  -  lastSeasonPointsPerGame
 * so with no recent-form blend it equals the backtested "age + minutes" model, and the existing recent-form tilt is kept.
 *
 *   ageFactor        = (rpm + delta[age]) / rpm, where rpm and delta come from a proxy score (the league's weights on the
 *                      stats every season feed carries; OREB/DREB are left out because prior-season feeds omit them) and
 *                      the factor is applied to the player's real league-scoring per-minute production.
 *   predictedMinutes = ridge regression on [1, mpg(last), mpg(prior; last if missing), age, (age-26)^2, availability(last)]
 *   Both are fitted at runtime from the SAME cached ESPN league-wide season feeds the app already uses (no external or
 *   licensed research data, no per-player requests). If anything is missing the existing projection is used unchanged.
 *
 * Pure functions only: no network, no cache, no mutation of inputs.
 */
import { scoreStatLine, YAHOO_STAT_TO_STATLINE } from './scoring.js';

export const MIN_SUPPORT_MINUTES = 800;   // last-season minutes needed to be inside the fitted range
export const AGING_MIN_MINUTES = 500;
export const AGING_W0 = 5000;             // shrinkage of each age's mean change toward 0
export const RIDGE = 1.0;
export const MIN_PAIRS = 150;             // fewer fitted pairs/triples than this => model unavailable => fallback
export const MIN_TRIPLES = 150;
export const MAX_RELATIVE_DELTA = 0.35;   // |delta| capped at 35% of the existing projection
const PROXY_EXCLUDED_STAT_IDS = new Set([13, 14]); // OREB / DREB: absent from prior-season feeds

export function parseUserIds(value) {
  return new Set(String(value ?? '').split(/[\s,]+/).filter((x) => /^\d{1,12}$/.test(x)).map((x) => String(Number(x))));
}
export function resolveProjectionAdjustmentForUser(userId, env = process.env) {
  const id = userId == null ? '' : String(userId).trim();
  return /^\d{1,12}$/.test(id) && parseUserIds(env?.PROGM_PROJECTION_ADJ_USER_IDS).has(String(Number(id)));
}

/** League categories minus those that the multi-season feeds cannot supply. */
export function proxyCategories(statCategories) {
  return (statCategories || []).filter((c) => !PROXY_EXCLUDED_STAT_IDS.has(Number(c?.statId)));
}

/**
 * Season feed entries ([{externalId, season: StatLine}]) -> Map(id -> {fp, mpg, gp, minTotal}) using the proxy score.
 * A weighted stat that most rows in this feed lack (< 50% populated) is left out of the proxy for that season rather than
 * blanking every row; the real league-scoring figure for the last season is never affected by this.
 */
export function buildSeasonRows(entries, statCategories) {
  const valid = (entries || []).filter((e) => e?.season && e.externalId != null);
  const populated = (key) => (valid.length ? valid.filter((e) => e.season[key] != null).length / valid.length : 0);
  const cats = proxyCategories(statCategories).filter((c) => { const key = YAHOO_STAT_TO_STATLINE[Number(c.statId)]; return !key || populated(key) >= 0.5; });
  const rows = new Map();
  for (const e of valid) {
    const line = e.season; const id = String(e.externalId);
    const gp = Number(line.gamesPlayed); const mpg = Number(line.minutes);
    if (!(gp > 0) || !(mpg > 0)) continue;
    const scored = scoreStatLine(line, cats);
    if (scored.points == null || scored.unsupportedStats.length) continue;
    rows.set(id, { fp: scored.points, mpg, gp, minTotal: mpg * gp });
  }
  return rows;
}

function solve(A, b) { // Gauss-Jordan with partial pivoting (tiny systems)
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

export function minutesFeatures(mpg1, mpg2, ageT, avail1) {
  return [1, mpg1, mpg2 ?? mpg1, ageT, (ageT - 26) ** 2, avail1];
}

/**
 * @param {Object} p
 * @param {Map<number, Map<string,{fp,mpg,gp,minTotal}>>} p.tables   season (start year) -> rows from buildSeasonRows
 * @param {(id:string, season:number)=>number|null} p.ageAt          age during a season, or null
 * @returns {{delta:Object, beta:number[], pairs:number, triples:number, gameTotalBySeason:Object}|null}
 */
export function fitAdjustmentModel({ tables, ageAt }) {
  const seasons = [...tables.keys()].sort((a, b) => a - b);
  const gameTotal = {};
  for (const s of seasons) gameTotal[s] = Math.min(82, Math.max(1, ...[...tables.get(s).values()].map((r) => r.gp)));
  // ---- aging: weighted mean change in points-per-minute from age a to a+1
  const acc = []; // {age, d, w}
  for (const t of seasons) {
    const prev = tables.get(t - 1); if (!prev) continue;
    for (const [id, cur] of tables.get(t)) {
      const p = prev.get(id); if (!p || cur.minTotal < AGING_MIN_MINUTES || p.minTotal < AGING_MIN_MINUTES) continue;
      const age = ageAt(id, t - 1); if (age == null) continue;
      acc.push({ age: Math.min(37, Math.max(19, Math.round(age))), d: cur.fp / cur.mpg - p.fp / p.mpg, w: 2 / (1 / cur.minTotal + 1 / p.minTotal) });
    }
  }
  if (acc.length < MIN_PAIRS) return null;
  const delta = {};
  for (let a = 19; a <= 37; a += 1) {
    let sw = 0; let sd = 0;
    for (const r of acc) if (r.age >= a - 1 && r.age <= a + 1) { sw += r.w; sd += r.w * r.d; }
    delta[a] = sw > 0 ? sd / (sw + AGING_W0) : 0;
  }
  // ---- minutes: ridge regression of this season's minutes per game on last season's information
  const X = []; const y = [];
  for (const t of seasons) {
    const prev = tables.get(t - 1); if (!prev) continue;
    const prev2 = tables.get(t - 2) || null;
    for (const [id, cur] of tables.get(t)) {
      const p1 = prev.get(id); if (!p1 || cur.gp < 10 || p1.minTotal < MIN_SUPPORT_MINUTES) continue;
      const ageT = ageAt(id, t); if (ageT == null) continue;
      X.push(minutesFeatures(p1.mpg, prev2?.get(id)?.mpg, ageT, Math.min(1, p1.gp / gameTotal[t - 1]))); y.push(cur.mpg);
    }
  }
  if (X.length < MIN_TRIPLES) return null;
  const k = X[0].length; const A = Array.from({ length: k }, () => new Array(k).fill(0)); const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i += 1) for (let r = 0; r < k; r += 1) { b[r] += X[i][r] * y[i]; for (let c = 0; c < k; c += 1) A[r][c] += X[i][r] * X[i][c]; }
  for (let r = 0; r < k; r += 1) A[r][r] += RIDGE;
  const beta = solve(A, b);
  if (!beta || beta.some((v) => !Number.isFinite(v))) return null;
  return { delta, beta, pairs: acc.length, triples: X.length, gameTotalBySeason: gameTotal };
}

/**
 * Per-game change to add to the existing projection, or {reason} when the player is outside the fitted support.
 * @param {Object} p
 * @param {Object} p.model   fitAdjustmentModel result
 * @param {{fp,mpg,gp,minTotal}|undefined} p.last   proxy row for the last completed season
 * @param {{mpg}|undefined} p.prior                 proxy row for the season before it (optional)
 * @param {number|null} p.ageLast                   age during the last completed season
 * @param {number} p.lastPointsPerGame              real league-scoring points per game, last season
 * @param {number} p.lastMinutes                    last-season minutes per game (the same line)
 * @param {number} p.lastGameTotal
 */
export function adjustmentDelta({ model, last, prior, ageLast, lastPointsPerGame, lastMinutes, lastGameTotal }) {
  if (!model) return { reason: 'no_model' };
  if (ageLast == null) return { reason: 'no_age' };
  if (!last) return { reason: 'no_proxy_row' };
  if (last.minTotal < MIN_SUPPORT_MINUTES) return { reason: 'below_support_minutes' };
  if (!(lastPointsPerGame > 0) || !(lastMinutes > 0)) return { reason: 'no_last_season_points' };
  const rpm = last.fp / last.mpg;
  const ageKey = Math.min(37, Math.max(19, Math.round(ageLast)));
  const rel = rpm > 0.5 ? Math.min(1.3, Math.max(0.7, Math.max(0, rpm + model.delta[ageKey]) / rpm)) : 1;
  const feats = minutesFeatures(last.mpg, prior?.mpg, ageLast + 1, Math.min(1, last.gp / (lastGameTotal || 82)));
  const mhat = Math.min(40, Math.max(8, feats.reduce((s, v, i) => s + v * model.beta[i], 0)));
  const adjusted = (lastPointsPerGame / lastMinutes) * rel * mhat;
  return { delta: adjusted - lastPointsPerGame, ageFactor: rel, minutesPredicted: mhat, minutesLast: lastMinutes, ageLast };
}

/**
 * Build the account-scoped adjusted projections. Pure.
 * @param {Object} p
 * @param {Array} p.canonical                    identity-layer players ({canonicalId, matched, externalId})
 * @param {Map} p.projectionByCanonicalId        existing projections (never mutated)
 * @param {Map<string,Object>} p.statsByExternalId  last-season PlayerStats by id
 * @param {Map<string,{age:number|null}>} p.externalRefById
 * @param {Object<number,Array>} p.seasonEntries season -> [{externalId, season: StatLine}] for lastSeason, lastSeason-1, ...
 * @param {Array} p.statCategories
 * @param {number} p.lastSeason                  last completed season (start year)
 * @param {number} p.ageReferenceSeason          season the directory age refers to (current NBA season)
 */
export function computeAdjustedProjections({ canonical, projectionByCanonicalId, statsByExternalId, externalRefById, seasonEntries, statCategories, lastSeason, ageReferenceSeason }) {
  const diagnostics = { applied: 0, capped: 0, fallbacks: {}, pairs: 0, triples: 0, modelAvailable: false };
  const out = new Map();
  const tables = new Map();
  for (const [season, entries] of Object.entries(seasonEntries || {})) tables.set(Number(season), buildSeasonRows(entries, statCategories));
  const ageAt = (id, season) => { const a = externalRefById.get(String(id))?.age; return Number.isFinite(a) ? a + (season - ageReferenceSeason) : null; };
  const model = tables.has(lastSeason) ? fitAdjustmentModel({ tables, ageAt }) : null;
  if (!model) { diagnostics.fallbacks.no_model = canonical.length; return { adjustedByCanonicalId: out, diagnostics }; }
  diagnostics.modelAvailable = true; diagnostics.pairs = model.pairs; diagnostics.triples = model.triples;
  const lastTable = tables.get(lastSeason); const priorTable = tables.get(lastSeason - 1);
  const bump = (reason) => { diagnostics.fallbacks[reason] = (diagnostics.fallbacks[reason] || 0) + 1; };
  for (const c of canonical) {
    const proj = projectionByCanonicalId.get(c.canonicalId);
    if (!c.matched || !c.externalId || !proj || proj.estimate === true || proj.projectedPoints == null) { bump('no_base_projection'); continue; }
    if (!proj.lastSeasonFantasy?.complete) { bump('incomplete_last_season_scoring'); continue; }
    const id = String(c.externalId);
    const season = statsByExternalId.get(id)?.season;
    const r = adjustmentDelta({
      model, last: lastTable?.get(id), prior: priorTable?.get(id), ageLast: ageAt(id, lastSeason),
      lastPointsPerGame: proj.lastSeasonFantasy.points, lastMinutes: season?.minutes, lastGameTotal: model.gameTotalBySeason[lastSeason],
    });
    if (r.reason) { bump(r.reason); continue; }
    const cap = MAX_RELATIVE_DELTA * proj.projectedPoints;
    const delta = Math.max(-cap, Math.min(cap, r.delta)); if (delta !== r.delta) diagnostics.capped += 1;
    const perGame = Math.max(0, Number((proj.projectedPoints + delta).toFixed(2)));
    out.set(c.canonicalId, { ...proj, perGame, projectedPoints: perGame, method: 'age_minutes_adjusted', baseMethod: proj.method,
      adjustment: { deltaPerGame: Number(delta.toFixed(2)), ageFactor: Number(r.ageFactor.toFixed(3)), minutesPredicted: Number(r.minutesPredicted.toFixed(1)), minutesLast: Number(r.minutesLast.toFixed(1)), ageLast: r.ageLast, basePerGame: proj.projectedPoints } });
    diagnostics.applied += 1;
  }
  return { adjustedByCanonicalId: out, diagnostics };
}
