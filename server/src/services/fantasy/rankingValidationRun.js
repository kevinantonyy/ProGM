import fs from 'node:fs';
import { evaluateVariants, poolSensitivity, rankVariants } from './rankingValidation.js';
import { spearmanCorrelation } from './backtest/metrics.js';
import { projectPlayer } from './projection.js';
import { emptyStatLine } from '../providers/types.js';

/**
 * Offline run of the ranking-variant validation on a prepared pool file
 * (see docs/evaluations/ranking-validation-prep.py): 2024-25 per-game lines and
 * starter position labels for projections, 2025-26 realized season totals as
 * the target. Only 2024-25 information feeds the rankings. Never imported by
 * production code.
 *
 *   node rankingValidationRun.js pool.json [report.json]
 */
const ASSUMED_SCORING = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }, { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true }, { statId: 17, abbr: 'ST', pointValue: 3, enabled: true },
  { statId: 18, abbr: 'BLK', pointValue: 3, enabled: true }, { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
];
// Assumed default Yahoo NBA lineup (NOT any user's league): PG SG G SF PF F C C UTIL UTIL + 3 bench, 12 teams.
const SETTINGS = {
  teamCount: 12,
  rosterSlots: [['PG', 1], ['SG', 1], ['G', 1], ['SF', 1], ['PF', 1], ['F', 1], ['C', 2], ['UTIL', 2]].map(([position, count]) => ({ position, count, isStarting: true }))
    .concat([{ position: 'BN', count: 3, isStarting: false }]),
};
// Starter labels in the logs are coarse (G/F/C); map them to eligible slots. Approximate: not Yahoo eligibility.
const ELIGIBLE = { G: ['PG', 'SG', 'G'], F: ['SF', 'PF', 'F'], C: ['C'] };
const DEPTH = { G: 36, F: 36, C: 24 }; // realized replacement depth by coarse label: slots per team x 12 teams

function eligibility(labels) {
  const out = new Set(['UTIL']);
  for (const label of labels) for (const pos of ELIGIBLE[label] || []) out.add(pos);
  return [...out];
}

export function buildPool(rows, priorSeason = 2024) {
  const players = [];
  const stats = new Map();
  const realized = new Map();
  const primary = new Map();
  for (const r of rows) {
    const key = String(r.id);
    const line = { ...emptyStatLine(), gamesPlayed: r.gp, points: r.pts, rebounds: r.reb, assists: r.ast, steals: r.stl, blocks: r.blk, turnovers: r.tov };
    stats.set(key, line);
    primary.set(key, r.primary || r.pos[0]);
    players.push({ playerKey: key, name: r.pname, teamAbbr: null, eligiblePositions: eligibility(r.pos), percentOwned: 0, status: null });
    realized.set(key, r.total_real);
  }
  const projectionProvider = {
    getProjection(p) {
      const season = stats.get(p.playerKey);
      const projection = projectPlayer({ stats: { season }, statCategories: ASSUMED_SCORING });
      // Only the prior season is known before the target season; one season of availability history.
      return { ...projection, history: [{ season: priorSeason, gamesPlayed: season.gamesPlayed, gameTotal: 82 }] };
    },
  };
  return { players, projectionProvider, realized, primary };
}

export function runValidation(rows, priorSeason = 2024) {
  const { players, projectionProvider, realized, primary } = buildPool(rows, priorSeason);
  const ranking = rankVariants({ players, projectionProvider, settings: SETTINGS, currentSeason: priorSeason + 1 });
  const byKey = new Map(ranking.rows.map((r) => [r.playerKey, r]));
  // Reference orderings: pure projected PPG, and projected season points (PPG x expected games).
  const refOrder = (field) => [...ranking.rows].sort((a, b) => b[field] - a[field]).map((r) => r.playerKey);
  const full = { ...ranking, D: refOrder('perGame'), E: refOrder('seasonPoints') };
  const opts = { settings: SETTINGS, primaryOf: (r) => primary.get(r.playerKey), depthOf: (pos) => DEPTH[pos] ?? 24 };
  const evaluate = (ranking2, topN) => evaluateVariants({ ranking: ranking2, realized, topN, ...opts });
  const base24 = evaluate(ranking, 24);
  const base50 = evaluate(ranking, 50);

  // Extra orderings through the same evaluator.
  const extra = (name) => {
    const pseudo = { rows: ranking.rows, A: full[name], B: full[name], C: full[name] };
    return { total24: evaluate(pseudo, 24).variants.A, total50: evaluate(pseudo, 50).variants.A };
  };

  // Realized orders and per-player lookup.
  const totalOrder = [...realized.keys()].sort((a, b) => realized.get(b) - realized.get(a));
  const realizedRank = new Map(totalOrder.map((k, i) => [k, i + 1]));
  const rankIn = (order) => new Map(order.map((k, i) => [k, i + 1]));
  const ranks = { A: rankIn(full.A), B: rankIn(full.B), C: rankIn(full.C), D: rankIn(full.D), E: rankIn(full.E) };

  // Bootstrap CI for Spearman(total) differences vs A.
  const spear = (order) => (sample) => {
    const r = rankIn(order);
    return spearmanCorrelation(sample.map((k) => [-r.get(k), -realizedRank.get(k)])).correlation;
  };
  const stats = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((name) => [name, spear(full[name])]));
  const keys = new Map(players.map((p) => [p.playerKey, 1]));
  return { ranking: full, base24, base50, extra, ranks, realizedRank, realized, byKey, players, projectionProvider, primary, stats, keys };
}

// CLI -----------------------------------------------------------------------
function ciFor(run, a, b, resamples = 1000) {
  const keys = [...run.keys.keys()];
  let state = 11;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const diffs = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample = keys.map(() => keys[Math.floor(random() * keys.length)]);
    diffs.push(run.stats[b](sample) - run.stats[a](sample));
  }
  diffs.sort((x, y) => x - y);
  return { mean: Number((diffs.reduce((s, v) => s + v, 0) / diffs.length).toFixed(4)), ci95: [Number(diffs[Math.floor(0.025 * resamples)].toFixed(4)), Number(diffs[Math.floor(0.975 * resamples)].toFixed(4))] };
}

if (process.argv[1] && process.argv[1].endsWith('rankingValidationRun.js')) {
  const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const run = runValidation(rows);
  const names = ['Cade Cunningham', 'Bam Adebayo', 'Alperen Sengun'];
  const report = {
    n: run.base24.n,
    variants: { A: run.base24.variants.A, B: run.base24.variants.B, C: run.base24.variants.C },
    top50: { A: run.base50.variants.A, B: run.base50.variants.B, C: run.base50.variants.C },
    references: { D_pureProjectedPPG: run.extra('D'), E_projectedSeasonPoints: run.extra('E') },
    bootstrapSpearmanTotalDiff: { B_minus_A: ciFor(run, 'A', 'B'), C_minus_A: ciFor(run, 'A', 'C'), E_minus_A: ciFor(run, 'A', 'E'), D_minus_A: ciFor(run, 'A', 'D') },
    stability: poolSensitivity({ players: run.players, projectionProvider: run.projectionProvider, settings: SETTINGS, currentSeason: 2025 }),
    comparison: names.map((name) => {
      const p = run.players.find((q) => q.name === name);
      if (!p) return { name, found: false };
      const row = run.byKey.get(p.playerKey);
      return {
        name, positions: p.eligiblePositions, perGame: Number(row.perGame.toFixed(1)), expectedSeasonPoints: Number(row.seasonPoints.toFixed(0)),
        rankA: run.ranks.A.get(p.playerKey), rankB: run.ranks.B.get(p.playerKey), rankC: run.ranks.C.get(p.playerKey),
        rankPPG: run.ranks.D.get(p.playerKey), rankSeasonPoints: run.ranks.E.get(p.playerKey),
        realizedTotal: Math.round(run.realized.get(p.playerKey)), realizedRank: run.realizedRank.get(p.playerKey),
      };
    }),
  };
  console.log(JSON.stringify(report, null, 2));
}
