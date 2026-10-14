import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteScarcity, evaluateVariants, poolSensitivity, rankVariants } from './rankingValidation.js';

// SYNTHETIC pools only. These tests check the harness mechanics; they are not evidence about real players.
const SETTINGS = { teamCount: 12, rosterSlots: [...['PG', 'SG', 'SF', 'PF', 'C'].map((position) => ({ position, count: 1, isStarting: true })), { position: 'BN', count: 3, isStarting: false }] };
const history = [{ season: 2025, gamesPlayed: 75, gameTotal: 82 }, { season: 2024, gamesPlayed: 75, gameTotal: 82 }, { season: 2023, gamesPlayed: 75, gameTotal: 82 }];

function pool(supply) {
  const players = [];
  const proj = {};
  for (const [pos, n] of Object.entries(supply)) {
    for (let i = 0; i < n; i += 1) {
      const key = `${pos}${i}`;
      players.push({ playerKey: key, name: key, teamAbbr: 'X', eligiblePositions: [pos], percentOwned: 0, status: null });
      proj[key] = 45 - 30 * i / (n - 1); // identical talent curve at every position
    }
  }
  return { players, projectionProvider: { getProjection: (p) => ({ projectedPoints: proj[p.playerKey], confidence: 0.9, history }) } };
}
const realizedFrom = (players, projectionProvider) => new Map(players.map((p) => [p.playerKey, projectionProvider.getProjection(p).projectedPoints * 75]));

test('absolute scarcity is proportional, not stretched to the full range', () => {
  const near = absoluteScarcity(SETTINGS, pool({ PG: 60, SG: 60, SF: 60, PF: 60, C: 54 }).players);
  assert.ok(near.C > 0 && near.C < 0.15, `C ${near.C}`); // 10% fewer centers -> small bonus
  assert.equal(near.PG, 0);
  const much = absoluteScarcity(SETTINGS, pool({ PG: 60, SG: 60, SF: 60, PF: 60, C: 20 }).players);
  assert.ok(much.C > near.C);
});

test('with equal supply all variants agree and no position is favoured', () => {
  const { players, projectionProvider } = pool({ PG: 40, SG: 40, SF: 40, PF: 40, C: 40 });
  const ranking = rankVariants({ players, projectionProvider, settings: SETTINGS });
  const report = evaluateVariants({ ranking, realized: realizedFrom(players, projectionProvider), settings: SETTINGS });
  for (const v of ['A', 'B', 'C']) {
    assert.ok(report.variants[v].total.spearman > 0.99, v);
    for (const bias of Object.values(report.variants[v].positionalBias)) assert.ok(Math.abs(bias) < 5, `${v} ${bias}`);
  }
});

test('thin center supply makes the current model (A) favour centers; B and C favour them far less', () => {
  const { players, projectionProvider } = pool({ PG: 60, SG: 60, SF: 60, PF: 60, C: 40 });
  const ranking = rankVariants({ players, projectionProvider, settings: SETTINGS });
  const report = evaluateVariants({ ranking, realized: realizedFrom(players, projectionProvider), settings: SETTINGS });
  const centerBias = (v) => report.variants[v].positionalBias.C;
  assert.ok(centerBias('A') < centerBias('B'), `A ${centerBias('A')} B ${centerBias('B')}`); // more negative = more overvalued
  assert.ok(centerBias('A') < centerBias('C'));
  assert.ok(report.variants.B.total.spearman >= report.variants.A.total.spearman - 1e-9);
});

test('pool sensitivity is deterministic and bounded', () => {
  const { players, projectionProvider } = pool({ PG: 40, SG: 40, SF: 40, PF: 40, C: 25 });
  const a = poolSensitivity({ players, projectionProvider, settings: SETTINGS });
  assert.deepEqual(poolSensitivity({ players, projectionProvider, settings: SETTINGS }), a);
  for (const v of ['A', 'B', 'C']) {
    assert.ok(a[v].spearman > 0.9 && a[v].spearman <= 1);
    assert.ok(a[v].meanAbsRankChange >= 0);
  }
});

import { buildPool, runValidation } from './rankingValidationRun.js';

test('runner: rankings use only prior-season fields, never the realized totals (leakage guard)', () => {
  // Synthetic rows in the prepared-pool format.
  const labels = ['G', 'F', 'C'];
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `p${i}`, pname: `Player ${i}`, gp: 60 + (i % 20), pts: 25 - i * 0.25, reb: 4 + (i % 7), ast: 2 + (i % 5), stl: 1, blk: 0.5, tov: 2,
    pos: [labels[i % 3]], primary: labels[i % 3], gp_real: 70, total_real: 3000 - i * 20,
  }));
  const a = runValidation(rows);
  const scrambled = runValidation(rows.map((r, i) => ({ ...r, total_real: (i * 7919) % 3000 })));
  for (const v of ['A', 'B', 'C', 'D', 'E']) assert.deepEqual(scrambled.ranking[v], a.ranking[v], v);
  assert.notEqual(scrambled.base24.variants.A.total.spearman, a.base24.variants.A.total.spearman); // only the evaluation changes
  assert.deepEqual(runValidation(rows).ranking.A, a.ranking.A); // deterministic
  const pool = buildPool(rows);
  assert.ok(pool.players.every((p) => p.eligiblePositions.includes('UTIL')));
  assert.deepEqual(pool.players[0].eligiblePositions.sort(), ['G', 'PG', 'SG', 'UTIL']);
});
