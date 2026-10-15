import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBoard } from './draftHelper.js';
import { canonicalIdOf, withAdjustedProjections } from './insights.js';
import { rankingProfileForUser } from './rankingModel.js';
import {
  MAX_RELATIVE_DELTA, adjustmentDelta, buildSeasonRows, computeAdjustedProjections, fitAdjustmentModel, parseUserIds, proxyCategories, resolveProjectionAdjustmentForUser,
} from './projectionAdjustment.js';
import { projectPlayer } from './projection.js';

// Synthetic players only (seeded, deterministic).
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const CATS = [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }, { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true }, { statId: 13, abbr: 'OREB', pointValue: 1, enabled: true }];
const LAST = 2025; const REF = 2026;
const ageGrowth = (age) => (age <= 23 ? 0.08 : age <= 27 ? 0.01 : age <= 31 ? -0.03 : -0.08);   // true per-minute change from `age` to age+1
const line = (fpm, mpg, gp, withSplits) => {
  const fp = fpm * mpg;
  return { gamesPlayed: gp, minutes: mpg, points: fp * 0.6, rebounds: fp * 0.2 / 1.2, assists: fp * 0.2 / 1.5, offRebounds: withSplits ? 1 : null, defRebounds: withSplits ? 2 : null };
};
function makeLeague(n = 400) {
  const seasonEntries = { [LAST]: [], [LAST - 1]: [], [LAST - 2]: [], [LAST - 3]: [] }; const refs = new Map();
  for (let i = 0; i < n; i += 1) {
    const ageLast = 20 + Math.floor(rnd() * 16); let fpm = 0.6 + rnd() * 0.8; let mpg = 18 + rnd() * 16;
    const hist = [];
    for (let k = 3; k >= 0; k -= 1) { // oldest -> LAST
      const age = ageLast - k; hist.push({ season: LAST - k, age, fpm, mpg, gp: 55 + Math.floor(rnd() * 27) });
      fpm = Math.max(0.3, fpm + ageGrowth(age) + (rnd() - 0.5) * 0.04); mpg = Math.min(38, Math.max(12, mpg + 0.4 * (28 - mpg) / 4 + (rnd() - 0.5) * 3));
    }
    for (const h of hist) seasonEntries[h.season].push({ externalId: `p${i}`, season: line(h.fpm, h.mpg, h.gp, h.season === LAST) });
    refs.set(`p${i}`, { age: ageLast + 1 });
  }
  return { seasonEntries, refs };
}
const rowsOf = (entries) => buildSeasonRows(entries, CATS);
const tablesOf = (seasonEntries) => new Map(Object.entries(seasonEntries).map(([s, e]) => [Number(s), rowsOf(e)]));
const ageAtFn = (refs) => (id, season) => { const a = refs.get(id)?.age; return a == null ? null : a + (season - REF); };

test('flag: account allowlist only, junk ignored, never global; cache profile changes only for listed accounts', () => {
  assert.deepEqual([...parseUserIds(' 3, 007 x;1 *')].sort(), ['3', '7']);
  assert.equal(resolveProjectionAdjustmentForUser(7, { PROGM_PROJECTION_ADJ_USER_IDS: '7' }), true);
  for (const bad of [8, null, undefined, '', 'abc']) assert.equal(resolveProjectionAdjustmentForUser(bad, { PROGM_PROJECTION_ADJ_USER_IDS: '7' }), false);
  for (const v of ['*', 'all', 'on', 'true', '']) assert.equal(resolveProjectionAdjustmentForUser(7, { PROGM_PROJECTION_ADJ_USER_IDS: v }), false);
  assert.equal(resolveProjectionAdjustmentForUser(7, {}), false);
  const env = { PROGM_PROJECTION_ADJ_USER_IDS: '7' };
  assert.equal(rankingProfileForUser(7, env), 'legacy.noest.pam');
  assert.equal(rankingProfileForUser(8, env), 'legacy.noest');
  assert.equal(rankingProfileForUser(8, env), rankingProfileForUser(8, {}));
  assert.equal(rankingProfileForUser(7, { ...env, PROGM_RANKING_V2_USER_IDS: '7' }), 'v2.noest.pam');
});

test('proxy score leaves out OREB/DREB (prior-season feeds omit them) and skips rows it cannot score', () => {
  assert.deepEqual(proxyCategories(CATS).map((c) => c.statId), [12, 15, 16]);
  const rows = rowsOf([
    { externalId: 'a', season: line(1, 30, 70, false) },
    { externalId: 'b', season: { ...line(1, 30, 70, false), points: null } },     // unscorable
    { externalId: 'c', season: { ...line(1, 30, 0, false) } },                    // no games
    { externalId: 'd', season: { ...line(1, 0, 70, false) } },                    // no minutes
  ]);
  assert.deepEqual([...rows.keys()], ['a']);
  assert.ok(Math.abs(rows.get('a').fp - 30) < 1e-9);
});

test('a weighted stat that most rows in a season feed lack is dropped from the proxy instead of blanking the season', () => {
  const cats = [...CATS, { statId: 27, abbr: 'DD', pointValue: 3, enabled: true }];
  const entries = Array.from({ length: 10 }, (_, i) => ({ externalId: `x${i}`, season: { ...line(1, 30, 70, false), doubleDoubles: null } }));
  assert.equal(buildSeasonRows(entries, cats).size, 10);
  const some = entries.map((e, i) => (i < 8 ? { ...e, season: { ...e.season, doubleDoubles: 0.1 } } : e));
  assert.equal(buildSeasonRows(some, cats).size, 8); // DD kept (80% populated); the two rows missing it cannot be scored and are skipped
});

test('fit recovers the direction and rough size of the true aging and minutes structure', () => {
  const { seasonEntries, refs } = makeLeague();
  const model = fitAdjustmentModel({ tables: tablesOf(seasonEntries), ageAt: ageAtFn(refs) });
  assert.ok(model && model.pairs > 300 && model.triples > 300);
  assert.ok(model.delta[22] > 0.02, `young should improve, got ${model.delta[22]}`);
  assert.ok(model.delta[34] < -0.02, `old should decline, got ${model.delta[34]}`);
  assert.ok(model.delta[22] > model.delta[26] && model.delta[26] > model.delta[34]);
  assert.ok(model.beta[1] > 0.3, 'last season minutes should carry weight');
  assert.ok(model.beta.every(Number.isFinite));
});

test('thin data -> no model -> everyone falls back to the existing projection', () => {
  const { seasonEntries, refs } = makeLeague(20);
  assert.equal(fitAdjustmentModel({ tables: tablesOf(seasonEntries), ageAt: ageAtFn(refs) }), null);
  const canonical = [{ canonicalId: 'c1', matched: true, externalId: 'p1' }];
  const r = computeAdjustedProjections({ canonical, projectionByCanonicalId: new Map(), statsByExternalId: new Map(), externalRefById: refs, seasonEntries, statCategories: CATS, lastSeason: LAST, ageReferenceSeason: REF });
  assert.equal(r.adjustedByCanonicalId.size, 0); assert.equal(r.diagnostics.modelAvailable, false);
  const none = computeAdjustedProjections({ canonical, projectionByCanonicalId: new Map(), statsByExternalId: new Map(), externalRefById: refs, seasonEntries: {}, statCategories: CATS, lastSeason: LAST, ageReferenceSeason: REF });
  assert.equal(none.adjustedByCanonicalId.size, 0);
});

test('adjustmentDelta fallbacks: every missing or unsupported input is reported, none fabricated', () => {
  const model = { delta: Object.fromEntries(Array.from({ length: 19 }, (_, i) => [19 + i, 0])), beta: [0, 1, 0, 0, 0, 0] };
  const last = { fp: 30, mpg: 30, gp: 70, minTotal: 2100 };
  const base = { model, last, prior: undefined, ageLast: 25, lastPointsPerGame: 30, lastMinutes: 30, lastGameTotal: 82 };
  assert.equal(adjustmentDelta({ ...base, model: null }).reason, 'no_model');
  assert.equal(adjustmentDelta({ ...base, ageLast: null }).reason, 'no_age');
  assert.equal(adjustmentDelta({ ...base, last: undefined }).reason, 'no_proxy_row');
  assert.equal(adjustmentDelta({ ...base, last: { ...last, minTotal: 300 } }).reason, 'below_support_minutes');
  assert.equal(adjustmentDelta({ ...base, lastPointsPerGame: 0 }).reason, 'no_last_season_points');
  const ok = adjustmentDelta(base);
  assert.equal(ok.reason, undefined); assert.ok(Math.abs(ok.delta) < 1e-9, 'identity model must leave the projection unchanged');
});

function adjusted() {
  const { seasonEntries, refs } = makeLeague();
  const canonical = []; const projectionByCanonicalId = new Map(); const statsByExternalId = new Map();
  for (const e of seasonEntries[LAST]) {
    const st = { externalId: e.externalId, season: e.season, recent: null };
    canonical.push({ canonicalId: `c-${e.externalId}`, matched: true, externalId: e.externalId });
    projectionByCanonicalId.set(`c-${e.externalId}`, projectPlayer({ stats: st, statCategories: CATS.filter((c) => c.statId !== 13) }));
    statsByExternalId.set(e.externalId, st);
  }
  return { canonical, projectionByCanonicalId, statsByExternalId, externalRefById: refs, seasonEntries, statCategories: CATS, lastSeason: LAST, ageReferenceSeason: REF };
}

test('computeAdjustedProjections: never mutates inputs, is deterministic, labels method, and respects the cap', () => {
  const args = adjusted();
  const frozen = JSON.stringify([args.projectionByCanonicalId.get('c-p3'), args.seasonEntries[LAST][3]]);
  Object.freeze(args.canonical); // shallow freeze is enough to catch accidental pushes
  const r1 = computeAdjustedProjections(args); const r2 = computeAdjustedProjections(args);
  assert.equal(JSON.stringify([args.projectionByCanonicalId.get('c-p3'), args.seasonEntries[LAST][3]]), frozen);
  assert.deepEqual([...r1.adjustedByCanonicalId], [...r2.adjustedByCanonicalId]);
  assert.ok(r1.adjustedByCanonicalId.size > 300);
  for (const [id, a] of r1.adjustedByCanonicalId) {
    const base = args.projectionByCanonicalId.get(id);
    assert.equal(a.method, 'age_minutes_adjusted'); assert.equal(a.baseMethod, base.method);
    assert.equal(a.perGame, a.projectedPoints); assert.ok(a.perGame >= 0);
    assert.ok(Math.abs(a.perGame - base.projectedPoints) <= MAX_RELATIVE_DELTA * base.projectedPoints + 0.011);
    assert.equal(a.confidence, base.confidence);
    assert.equal(a.lastSeasonFantasy, base.lastSeasonFantasy); // last-season display untouched
  }
});

test('direction: young players rise, old players fall, prime-age players barely move', () => {
  const args = adjusted(); const r = computeAdjustedProjections(args);
  const avgBy = (lo, hi) => { const xs = [...r.adjustedByCanonicalId].filter(([id]) => { const age = args.externalRefById.get(id.slice(2)).age - 1; return age >= lo && age <= hi; }).map(([, a]) => a.adjustment.deltaPerGame / a.adjustment.basePerGame); return xs.reduce((s, v) => s + v, 0) / xs.length; };
  assert.ok(avgBy(20, 22) > 0.01); assert.ok(avgBy(33, 35) < -0.01); assert.ok(Math.abs(avgBy(25, 27)) < Math.abs(avgBy(33, 35)));
});

test('no player-specific logic: identical inputs under different ids/names get identical adjustments', () => {
  const args = adjusted();
  const twin = (id) => { const e = args.seasonEntries; for (const s of Object.keys(e)) { const src = e[s].find((x) => x.externalId === 'p5'); if (src) e[s].push({ externalId: id, season: { ...src.season } }); } args.externalRefById.set(id, { ...args.externalRefById.get('p5') });
    const st = { externalId: id, season: { ...args.statsByExternalId.get('p5').season }, recent: null }; args.canonical.push({ canonicalId: `c-${id}`, matched: true, externalId: id });
    args.projectionByCanonicalId.set(`c-${id}`, projectPlayer({ stats: st, statCategories: CATS.filter((c) => c.statId !== 13) })); args.statsByExternalId.set(id, st); };
  twin('zz-twin');
  const r = computeAdjustedProjections(args);
  assert.equal(r.adjustedByCanonicalId.get('c-zz-twin').perGame, r.adjustedByCanonicalId.get('c-p5').perGame);
});

test('withAdjustedProjections: only draft-board getProjection changes; others pass through; empty map is a no-op', () => {
  const base = { getProjection: () => ({ projectedPoints: 10, perGame: 10 }), getProjectedValue: () => 10, extra: 1 };
  assert.equal(withAdjustedProjections(base, new Map()), base);
  const hit = { name: 'Some Player', teamAbbr: 'AAA', playerKey: 'nba.p.1' }; const miss = { name: 'Other Player', teamAbbr: 'BBB', playerKey: 'nba.p.2' };
  const w = withAdjustedProjections(base, new Map([[canonicalIdOf(hit), { projectedPoints: 12, perGame: 12 }]]));
  assert.equal(w.getProjection(hit).projectedPoints, 12);
  assert.equal(w.getProjection(miss).projectedPoints, 10);
  assert.equal(w.getProjectedValue(hit), 10); assert.equal(w.extra, 1);
});

test('wiring guard: the adjusted provider is applied only on the draft board paths, per account', async () => {
  const { readFileSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url'); const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const ws = readFileSync(join(here, 'basketballWorkspace.js'), 'utf8'); const route = readFileSync(join(here, '../../routes/basketball.js'), 'utf8');
  assert.match(ws, /projectionAdjustment: resolveProjectionAdjustmentForUser\(userId\)/);
  assert.match(ws, /draftProvider = withEstimates\(withAdjustedProjections\(projectionProvider, ctx\.adjustedByCanonicalId\)/);
  assert.equal((ws.match(/withAdjustedProjections\(/g) || []).length, 1); // waivers, trades, lineup, start/sit keep the base provider
  assert.match(route, /projectionAdjustment: resolveProjectionAdjustmentForUser\(req\.userId\)/);
});

// ---- ranking regression: default accounts are byte-identical; adjusted accounts differ only through per-game points ----
const SETTINGS = { teamCount: 4, rosterSlots: [{ position: 'PG', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true }, { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 74, gameTotal: 82 }));
const pool = Array.from({ length: 24 }, (_, i) => ({ playerKey: `K${i}`, name: `N${i}`, teamAbbr: 'AAA', eligiblePositions: [i % 2 ? 'PG' : 'C'], percentOwned: 0, status: null }));
const baseProvider = { getProjection: (p) => ({ projectedPoints: 50 - Number(p.playerKey.slice(1)), perGame: 50 - Number(p.playerKey.slice(1)), confidence: 0.9, history, method: 'season_only' }) };
const board = (provider) => buildDraftBoard({ players: pool, settings: SETTINGS, projectionProvider: provider, poolComplete: true, rankingModel: 'legacy' });

test('regression: with the flag off (empty adjusted map) the draft board is byte-identical to the current board', () => {
  assert.equal(JSON.stringify(board(withAdjustedProjections(baseProvider, new Map()))), JSON.stringify(board(baseProvider)));
});

test('adjusted account: ranks and values change only because per-game points change; pool and eligibility identical', () => {
  const canon = (p) => `K:${p.playerKey}`;
  const prov = { ...baseProvider };
  const adj = new Map(pool.map((p, i) => [canon(p), { ...baseProvider.getProjection(p), perGame: (50 - i) + (i < 6 ? 3 : -2), projectedPoints: (50 - i) + (i < 6 ? 3 : -2), method: 'age_minutes_adjusted' }]));
  const wrapped = { ...prov, getProjection: (p) => adj.get(canon(p)) || prov.getProjection(p) };
  const a = board(baseProvider); const b = board(wrapped);
  assert.deepEqual(a.board.map((r) => r.playerKey).sort(), b.board.map((r) => r.playerKey).sort());
  assert.equal(a.rankingModel, b.rankingModel); assert.equal(a.totalProjected, b.totalProjected);
  const ra = new Map(a.board.map((r) => [r.playerKey, r])); 
  for (const r of b.board) { assert.deepEqual(r.eligiblePositions, ra.get(r.playerKey).eligiblePositions); assert.equal(r.components.confidence, ra.get(r.playerKey).components.confidence); assert.equal(r.projectionMethod, 'age_minutes_adjusted'); }
  assert.notEqual(JSON.stringify(a.board.map((r) => r.value)), JSON.stringify(b.board.map((r) => r.value)));
});
