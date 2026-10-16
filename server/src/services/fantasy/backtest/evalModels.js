/**
 * Baseline models for the chronological evaluation. Each model is { id, version, fit(view, ctx) } where fit() receives ONLY a
 * point-in-time view and returns { predict(playerId) -> { fppg, minutes, games, fallback? }, diagnostics }.
 *
 * - production:      what ProGM ships today: last season's stat line carried forward (scored with the league's exact weights),
 *                    last season's minutes, and the production durability model (durability.js) for games.
 * - age_minutes:     the experimental age + minutes adjustment (projectionAdjustment.js, branch feature/projection-age-minutes),
 *                    same durability games. Falls back to `production` per player when it cannot be applied.
 * - naive_games:     last season's games played (reference only for the games target).
 */
import { scoreStatLine } from '../scoring.js';
import { buildAvailabilityBaselineModel, estimateExpectedGames } from '../durability.js';
import { adjustmentDelta, buildSeasonRows, fitAdjustmentModel, MAX_RELATIVE_DELTA } from '../projectionAdjustment.js';
import { snapshotToStatLine } from './snapshot.js';
import { emptyStatLine } from '../../providers/types.js';

export function strictScore(statLine, statCategories) {
  const s = scoreStatLine(statLine, statCategories);
  return s.points != null && s.unsupportedStats.length === 0 ? s.points : null;
}

function gameTotals(rows) {
  const t = {}; for (const r of rows) if (Number.isFinite(r.gamesPlayed)) t[r.season] = Math.min(82, Math.max(t[r.season] || 1, r.gamesPlayed)); return t;
}

function durabilityGames(view, targetSeason, { profilePool = 'all' } = {}) {
  const totals = gameTotals(view.rows);
  const byPlayer = new Map();
  // 'active' mirrors production more closely: the availability baseline is built from players still in the league (production builds it
  // from the current Yahoo pool), not from everyone who ever appeared in the history.
  const active = new Set(view.rows.filter((r) => r.season === targetSeason - 1).map((r) => r.player.id));
  for (const r of view.rows) {
    if (profilePool === 'active' && !active.has(r.player.id)) continue; if (!byPlayer.has(r.player.id)) byPlayer.set(r.player.id, []); byPlayer.get(r.player.id).push(r); }
  const profileOf = (rows) => {
    const sorted = [...rows].sort((a, b) => b.season - a.season); const latest = sorted[0];
    return {
      history: sorted.filter((r) => r.gamesPlayed != null).map((r) => ({ season: r.season, gamesPlayed: r.gamesPlayed, gameTotal: totals[r.season] || 82 })),
      age: latest.age, ageReferenceSeason: latest.season,
      debutYear: latest.experience != null ? latest.season - latest.experience : null,
    };
  };
  const profiles = new Map([...byPlayer].map(([id, rows]) => [id, profileOf(rows)]));
  const baseline = buildAvailabilityBaselineModel([...profiles.values()], targetSeason);
  return (playerId) => {
    const p = profiles.get(playerId); if (!p) return null;
    const baselineContext = baseline.forPlayer({ age: p.age, debutYear: p.debutYear, ageReferenceSeason: p.ageReferenceSeason, targetSeason });
    return estimateExpectedGames(p.history, { baselineContext, age: p.age, debutYear: p.debutYear, targetSeason }).expectedGames;
  };
}

export function productionModel({ profilePool = 'all', id = 'production' } = {}) {
  return {
    id, version: profilePool === 'all' ? 'progm.production-carry-forward+durability.v1' : `progm.production-carry-forward+durability.v1.pool-${profilePool}`,
    description: 'Last-season stat line (league scoring), last-season minutes, production durability model for games.',
    fit(view, { statCategories, targetSeason }) {
      const gamesOf = durabilityGames(view, targetSeason, { profilePool });
      return {
        diagnostics: { trainingRows: view.rowCount, cutoffSeason: view.cutoffSeason },
        predict(playerId) {
          const last = view.historyOf(playerId).find((r) => r.season === targetSeason - 1);
          if (!last) return null;
          return { fppg: strictScore(snapshotToStatLine(last), statCategories), minutes: last.minutesPerGame ?? null, games: gamesOf(playerId) };
        },
      };
    },
  };
}

export function ageMinutesModel() {
  const base = productionModel();
  return {
    id: 'age_minutes', version: 'progm.age-minutes.v1',
    description: 'Experimental age (per-minute) + minutes adjustment on top of the production projection; durability games.',
    fit(view, ctx) {
      const { statCategories, targetSeason } = ctx; const prod = base.fit(view, ctx);
      const last = targetSeason - 1; const tables = new Map();
      for (let s = last; s >= last - 3; s -= 1) {
        const entries = view.rows.filter((r) => r.season === s).map((r) => ({ externalId: r.player.id, season: snapshotToStatLine(r) }));
        if (entries.length) tables.set(s, buildSeasonRows(entries, statCategories));
      }
      const ageIndex = new Map(view.rows.map((r) => [`${r.player.id}|${r.season}`, r.age]));
      const ageAt = (id, season) => { const a = ageIndex.get(`${id}|${season}`); return Number.isFinite(a) ? a : null; };
      const model = tables.has(last) ? fitAdjustmentModel({ tables, ageAt }) : null;
      return {
        diagnostics: { ...prod.diagnostics, adjustmentModel: model ? { pairs: model.pairs, triples: model.triples } : null },
        predict(playerId) {
          const p = prod.predict(playerId); if (!p) return null;
          if (!model || p.fppg == null) return { ...p, fallback: model ? 'no_league_scoring' : 'no_model' };
          const row = tables.get(last)?.get(playerId); const lastRow = view.historyOf(playerId).find((r) => r.season === last);
          const r = adjustmentDelta({ model, last: row, prior: tables.get(last - 1)?.get(playerId), ageLast: ageAt(playerId, last), lastPointsPerGame: p.fppg, lastMinutes: lastRow?.minutesPerGame, lastGameTotal: model.gameTotalBySeason[last] });
          if (r.reason) return { ...p, fallback: r.reason };
          const cap = MAX_RELATIVE_DELTA * p.fppg; const delta = Math.max(-cap, Math.min(cap, r.delta));
          return { fppg: Math.max(0, p.fppg + delta), minutes: r.minutesPredicted, games: p.games };
        },
      };
    },
  };
}

export function naiveGamesModel() {
  return {
    id: 'naive_games', version: 'progm.naive-games.v1', description: 'Last season games played (games target only).',
    fit(view, { targetSeason }) {
      return { diagnostics: {}, predict(playerId) { const l = view.historyOf(playerId).find((r) => r.season === targetSeason - 1); return l ? { fppg: null, minutes: null, games: l.gamesPlayed } : null; } };
    },
  };
}

/**
 * Precomputed (offline-trained) model, e.g. Python ML v1. Predictions are basketball statistics; fantasy points are computed HERE with
 * the league's exact weights, so every model is scored by the same deterministic code. Each prediction must declare that it was trained
 * only on seasons before its target and forecast no later than the evaluation's forecast time; otherwise the fold is refused.
 */
export function precomputedModel(doc) {
  if (doc?.schema !== 'progm.ml-predictions.v1' || !doc.model?.id || !doc.model?.version) throw new Error('Unsupported ML predictions document.');
  const byTarget = new Map();
  for (const p of doc.predictions || []) { if (!byTarget.has(p.targetSeason)) byTarget.set(p.targetSeason, new Map()); byTarget.get(p.targetSeason).set(String(p.playerId), p); }
  return {
    id: doc.model.id, version: doc.model.version, description: `Precomputed offline model (${doc.model.version}, features ${doc.model.featureHash})`,
    fit(view, { statCategories, targetSeason, asOf }) {
      const rows = byTarget.get(targetSeason) || new Map();
      for (const p of rows.values()) {
        if (!(p.trainedThroughSeason < targetSeason) || !(p.dataCutoffSeason < targetSeason) || Date.parse(p.asOf) > Date.parse(asOf)) {
          throw new Error(`Leakage: ${doc.model.id} prediction for ${p.playerId}/${targetSeason} was trained or dated after the forecast point.`);
        }
      }
      return {
        diagnostics: { precomputed: rows.size, provenanceHash: doc.provenanceHash ?? null },
        predict(playerId) {
          const p = rows.get(playerId); if (!p) return null;
          const line = { ...emptyStatLine(), ...p.statLine, gamesPlayed: null };
          return { fppg: strictScore(line, statCategories), minutes: p.minutes ?? null, games: p.games ?? null };
        },
      };
    },
  };
}

/** Component swap: take one model's per-game production and another's games played (pre-specified hybrids only). */
export function hybridModel({ id, production, games }) {
  return {
    id, version: `${production.version}+games:${games.version}`, description: `${production.id} per-game production with ${games.id} games played`,
    fit(view, ctx) {
      const a = production.fit(view, ctx); const b = games.fit(view, ctx);
      return { diagnostics: { production: a.diagnostics, games: b.diagnostics }, predict(playerId) { const x = a.predict(playerId); if (!x) return null; const y = b.predict(playerId); return { ...x, games: y?.games ?? x.games, fallback: x.fallback ?? null }; } };
    },
  };
}

/** Equal-weight (or given-weight) average of several models' per-game points, minutes and/or games. Pre-specified ensembles only. */
export function blendModel({ id, perGame, games }) {
  const parts = [...new Set([...perGame, ...games])];
  return {
    id, version: `blend(perGame:${perGame.map((m) => m.id).join('+')};games:${games.map((m) => m.id).join('+')})`, description: `Equal-weight blend; per-game from ${perGame.map((m) => m.id).join(', ')}, games from ${games.map((m) => m.id).join(', ')}`,
    fit(view, ctx) {
      const fitted = new Map(parts.map((m) => [m, m.fit(view, ctx)]));
      const avg = (models, key, playerId) => { const v = models.map((m) => fitted.get(m).predict(playerId)?.[key]).filter(Number.isFinite); return v.length === models.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return { diagnostics: {}, predict(playerId) {
        if (!fitted.get(perGame[0]).predict(playerId)) return null;
        return { fppg: avg(perGame, 'fppg', playerId), minutes: avg(perGame, 'minutes', playerId), games: avg(games, 'games', playerId) };
      } };
    },
  };
}

/**
 * Tier-dependent games shrinkage: games = w * ML + (1 - w) * reference, with w chosen per tier (top N by the reference model's predicted
 * season total vs the rest). Weights are fixed inputs (frozen before evaluation); per-game production comes from `perGame`.
 */
export function tierShrinkGamesModel({ id, perGame, reference, ml, topN, weights }) {
  return {
    id, version: `tier-shrink(top${topN}:${weights.top};rest:${weights.rest})(${perGame.id}|${reference.id}|${ml.id})`, description: `Per-game from ${perGame.id}; games ${weights.top}/${weights.rest} ML weight for the top ${topN} by ${reference.id} season total / the rest`,
    fit(view, ctx) {
      const a = perGame.fit(view, ctx); const ref = reference.fit(view, ctx); const m = ml.fit(view, ctx);
      const ids = [...new Set(view.rows.filter((r) => r.season === ctx.targetSeason - 1).map((r) => r.player.id))];
      const totals = ids.map((pid) => { const p = ref.predict(pid); return [pid, p && Number.isFinite(p.fppg) && Number.isFinite(p.games) ? p.fppg * p.games : -Infinity]; })
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      const top = new Set(totals.slice(0, topN).map(([pid]) => pid));
      return { diagnostics: { topTier: top.size }, predict(playerId) {
        const x = a.predict(playerId); if (!x) return null;
        const g0 = ref.predict(playerId)?.games; const g1 = m.predict(playerId)?.games; const w = top.has(playerId) ? weights.top : weights.rest;
        const games = Number.isFinite(g0) && Number.isFinite(g1) ? w * g1 + (1 - w) * g0 : (Number.isFinite(g0) ? g0 : null);
        return { ...x, games, fallback: x.fallback ?? null };
      } };
    },
  };
}

export const DEFAULT_BASELINES = () => [productionModel(), ageMinutesModel(), naiveGamesModel()];
