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
export const MAX_MEDIAN_RELATIVE_DELTA = 0.15; // if the typical adjustment is larger than this the inputs are treated as corrupt
export const AGE_MIN = 18; export const AGE_MAX = 45;
export const DEBUT_CHECK_MIN_PLAYERS = 20;     // age-convention plausibility check needs at least this many recent debutants
export const DEBUT_AGE_BAND = [20.5, 24.0];    // plausible median age in a player's debut season (research data: 22-23)
const MAX_DELTA_PER_MINUTE = 0.6;              // fitted aging change per minute beyond this is not credible (typical |delta| < 0.1)
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

const STAT_KEYS = ['points', 'rebounds', 'offRebounds', 'defRebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personalFouls', 'fgMade', 'fgAtt', 'ftMade', 'ftAtt', 'threesMade'];
/** Malformed or physically implausible feed rows are dropped, never repaired: numbers only, finite, non-negative, within per-game limits. */
export function plausibleLine(line) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!line || !num(line.gamesPlayed) || !num(line.minutes)) return false;
  if (!(line.gamesPlayed > 0 && line.gamesPlayed <= 90) || !(line.minutes > 0 && line.minutes <= 48)) return false;
  for (const k of STAT_KEYS) { const v = line[k]; if (v != null && (!num(v) || v < 0 || v > 70)) return false; }
  for (const k of ['doubleDoubles', 'tripleDoubles']) { const v = line[k]; if (v != null && (!num(v) || v < 0 || v > 1.0001)) return false; }
  return true;
}

export function validAge(age) { return typeof age === 'number' && Number.isFinite(age) && age >= AGE_MIN && age <= AGE_MAX; }

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
    if (!plausibleLine(line)) continue;
    const gp = line.gamesPlayed; const mpg = line.minutes;
    const scored = scoreStatLine(line, cats);
    if (scored.points == null || scored.unsupportedStats.length || !Number.isFinite(scored.points) || scored.points < 0 || scored.points / mpg > 6) continue;
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
  // A fit that is not credible is no fit: never extrapolate a garbage curve into rankings.
  if (Object.values(delta).some((d) => !Number.isFinite(d) || Math.abs(d) > MAX_DELTA_PER_MINUTE) || !(beta[1] > 0 && beta[1] < 1.5)) return null;
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
  if (!validAge(ageLast)) return { reason: 'no_age' };
  if (!last) return { reason: 'no_proxy_row' };
  if (last.minTotal < MIN_SUPPORT_MINUTES) return { reason: 'below_support_minutes' };
  if (!(Number.isFinite(lastPointsPerGame) && lastPointsPerGame > 0 && lastPointsPerGame < 250) || !(Number.isFinite(lastMinutes) && lastMinutes > 0 && lastMinutes <= 48)) return { reason: 'no_last_season_points' };
  const rpm = last.fp / last.mpg;
  const ageKey = Math.min(37, Math.max(19, Math.round(ageLast)));
  const rel = rpm > 0.5 ? Math.min(1.3, Math.max(0.7, Math.max(0, rpm + model.delta[ageKey]) / rpm)) : 1;
  const feats = minutesFeatures(last.mpg, prior?.mpg, ageLast + 1, Math.min(1, last.gp / (lastGameTotal || 82)));
  const mhat = Math.min(40, Math.max(8, feats.reduce((s, v, i) => s + v * model.beta[i], 0)));
  const adjusted = (lastPointsPerGame / lastMinutes) * rel * mhat;
  if (!Number.isFinite(adjusted)) return { reason: 'non_finite' };
  return { delta: adjusted - lastPointsPerGame, ageFactor: rel, minutesPredicted: mhat, minutesLast: lastMinutes, ageLast };
}

/**
 * The directory gives each player's CURRENT age; ages for other seasons are derived with a whole-year offset, and the model is fitted
 * and applied on that same derived variable, so a constant offset cannot bias it. What can be checked without trusting the convention is
 * plausibility: among recent debutants (directory debutYear within the last four completed seasons) the derived age in the debut season
 * must look like a debut-season age. Gross errors (wrong units, wrong season base, unrelated numbers) fail it. A one-year drift is NOT
 * detectable this way (see docs). Too few debutants to check => not verified => the adjustment is not applied.
 */
export function checkAgeConvention({ externalRefById, ageAt, lastSeason }) {
  const ages = [];
  for (const [id, ref] of externalRefById) {
    const d = Number(ref?.debutYear);
    if (!Number.isInteger(d) || d < lastSeason - 3 || d > lastSeason) continue;
    const a = ageAt(id, d); if (a != null) ages.push(a);
  }
  if (ages.length < DEBUT_CHECK_MIN_PLAYERS) return { ok: false, reason: 'age_convention_unverifiable', debutants: ages.length };
  ages.sort((a, b) => a - b);
  const median = ages.length % 2 ? ages[(ages.length - 1) / 2] : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2;
  const ok = median >= DEBUT_AGE_BAND[0] && median <= DEBUT_AGE_BAND[1];
  return { ok, reason: ok ? null : 'age_convention_check_failed', debutants: ages.length, medianDebutAge: Number(median.toFixed(1)) };
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
  const ageAt = (id, season) => { const a = externalRefById.get(String(id))?.age; return validAge(a) ? a + (season - ageReferenceSeason) : null; };
  const convention = checkAgeConvention({ externalRefById, ageAt, lastSeason });
  diagnostics.ageConvention = convention;
  if (!convention.ok) { diagnostics.fallbacks[convention.reason] = canonical.length; return { adjustedByCanonicalId: out, diagnostics }; }
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
  const rel = [...out.values()].map((a) => Math.abs(a.adjustment.deltaPerGame) / Math.max(1, a.adjustment.basePerGame)).sort((a, b) => a - b);
  const medianRel = rel.length ? rel[Math.floor(rel.length / 2)] : 0;
  diagnostics.medianRelativeDelta = Number(medianRel.toFixed(4));
  if (medianRel > MAX_MEDIAN_RELATIVE_DELTA) { // corrupt feed symptom: discard everything rather than rank on it
    diagnostics.fallbacks.implausible_aggregate = out.size; diagnostics.applied = 0; out.clear();
  }
  return { adjustedByCanonicalId: out, diagnostics };
}
