import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, SCENARIOS, effectiveSeasonPoints, replacementLevel, replacementPerGame } from './replacementAware.js';
import { buildDraftBoard } from './draftHelper.js';
import { sanitizeWorkspace } from './snapshotCompare.js';
import { compareReplacementScenarios, replayPipeline } from './snapshotReplay.js';

// Prototype tests on synthetic input only.
const settings = { teamCount: 2, rosterSlots: [{ position: 'G', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true }, { position: 'UTIL', count: 1, isStarting: true }, { position: 'BN', count: 2, isStarting: false }] };
const row = (name, positions, perGame, games) => ({ name, eligiblePositions: positions, perGame, expectedSeasonGames: games, seasonPoints: perGame * games });
const pool = [
  row('G1', ['G', 'UTIL'], 60, 80), row('G2', ['G', 'UTIL'], 55, 75), row('G3', ['G', 'UTIL'], 50, 70), row('G4', ['G', 'UTIL'], 40, 70), row('G5', ['G', 'UTIL'], 35, 70), row('G6', ['G', 'UTIL'], 30, 70),
  row('C1', ['C', 'UTIL'], 58, 78), row('C2', ['C', 'UTIL'], 48, 72), row('C3', ['C', 'UTIL'], 36, 70), row('C4', ['C', 'UTIL'], 28, 70), row('C5', ['C', 'UTIL'], 20, 70),
  row('Hurt Star', ['G', 'C', 'UTIL'], 62, 50), row('Healthy Star', ['G', 'C', 'UTIL'], 52, 80),
];

test('rho = 0 reproduces today\'s season points exactly', () => {
  assert.deepEqual(effectiveSeasonPoints(pool, settings, { rho: 0 }), pool.map((r) => r.seasonPoints));
  assert.deepEqual(effectiveSeasonPoints(pool, settings, {}), pool.map((r) => r.seasonPoints));
});

test('effective points grow with coverage, never exceed the all-games bound, and perfect replacement is only an upper bound', () => {
  const at = (rho, o = {}) => effectiveSeasonPoints(pool, settings, { rho, ...o });
  const a = at(0.25), b = at(0.5), c = at(1);
  pool.forEach((r, i) => { assert.ok(r.seasonPoints <= a[i] && a[i] <= b[i] && b[i] <= c[i]); });
  const rpos = replacementPerGame(pool, settings);
  const hurt = pool.findIndex((r) => r.name === 'Hurt Star');
  assert.ok(Math.abs(c[hurt] - (50 * 62 + (GAMES - 50) * Math.min(rpos.G, rpos.C, rpos.UTIL))) < 1e-9);
});

test('lineup constraints: the constrained rule uses the worst eligible slot, the flexible rule the best; waiver level is lower than starter level', () => {
  const starter = replacementLevel(pool, settings, { depth: 'starter' }), waiver = replacementLevel(pool, settings, { depth: 'waiver' });
  for (const p of Object.keys(starter)) { assert.ok(waiver[p].index >= starter[p].index, p); assert.ok(waiver[p].seasonPoints <= starter[p].seasonPoints, p); }
  const i = pool.findIndex((r) => r.name === 'Hurt Star');
  const mn = effectiveSeasonPoints(pool, settings, { rho: 1, fill: 'min' })[i], mx = effectiveSeasonPoints(pool, settings, { rho: 1, fill: 'max' })[i];
  assert.ok(mx >= mn);
});

test('a player with no usable slot information is left untouched (nothing invented)', () => {
  const odd = [...pool, row('Mystery', ['XX'], 45, 60)];
  const eff = effectiveSeasonPoints(odd, settings, { rho: 1 });
  assert.equal(eff[odd.length - 1], 45 * 60);
});

test('the gap between a fully healthy and an injury-prone player narrows as replacement coverage rises', () => {
  const i = pool.findIndex((r) => r.name === 'Hurt Star'), j = pool.findIndex((r) => r.name === 'Healthy Star');
  const gap = (rho) => { const e = effectiveSeasonPoints(pool, settings, { rho }); return e[j] - e[i]; };
  assert.ok(gap(0) > gap(0.5) && gap(0.5) > gap(1));
});

// ---- pipeline level on a synthetic snapshot ----
const SETTINGS2 = { teamCount: 6, rosterSlots: [['PG', 1], ['SG', 1], ['G', 1], ['SF', 1], ['PF', 1], ['F', 1], ['C', 2], ['UTIL', 2]].map(([position, count]) => ({ position, count, isStarting: true })).concat([{ position: 'BN', count: 3, isStarting: false }]) };
const POS = [['PG', 'G'], ['SG', 'G'], ['SF', 'F'], ['PF', 'F'], ['C']];
const hist = (g) => [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: g, gameTotal: 82 }));
const vets = Array.from({ length: 120 }, (_, i) => ({ playerKey: `466.p.${1000 + i * 10}`, name: `Vet ${i}`, eligiblePositions: [...POS[i % 5], 'UTIL'], yahooAdp: i + 1, _pts: 62 - 10 * Math.log(i + 1), _g: i % 7 === 0 ? 40 : 72 }));
const provider = { getProjection: (p) => ({ projectedPoints: p._pts, confidence: 0.9, history: hist(p._g), lastSeason: { season: 2025, stats: { gamesPlayed: p._g } }, availabilityProfile: { age: 26, debutYear: 2018 } }) };
const board = buildDraftBoard({ players: vets, settings: SETTINGS2, projectionProvider: provider, currentSeason: 2026, availabilityOf: () => true, poolComplete: true });
const clean = sanitizeWorkspace({ connection: { draftStatus: 'predraft' }, settings: { scoringFormat: 'points', teamCount: 6, statCategories: [], rosterSlots: SETTINGS2.rosterSlots }, draftBoard: board, rankings: { players: [] } });

test('pipeline: the current scenario is identical to the plain replay and injury-prone players gain most as coverage rises', () => {
  const plain = replayPipeline(clean, { model: 'v2', rookieEstimates: false });
  const zero = replayPipeline(clean, { model: 'v2', rookieEstimates: false, replacement: { rho: 0 } });
  assert.deepEqual(plain.rows.map((r) => r.rank), zero.rows.map((r) => r.rank));
  const out = compareReplacementScenarios(clean, { highlight: ['vet 7', 'vet 3'], rookieEstimates: false });
  assert.deepEqual(out.scenarios.map((s) => s.id), SCENARIOS.map((s) => s.id));
  const cur = out.scenarios[0];
  assert.equal(cur.bands.top50.overlapWithCurrentModel, 50); assert.equal(cur.majorMovers.length, 0);
  const perfect = out.scenarios.at(-1);
  assert.ok(perfect.meanRankGainByProjectedGames.fewestGames >= perfect.meanRankGainByProjectedGames.mostGames);
  assert.equal(perfect.highlighted.length, 2);
  for (const sc of out.scenarios) for (const h of sc.highlighted) assert.ok(Number.isInteger(h.scenario) && Number.isInteger(h.current));
});
