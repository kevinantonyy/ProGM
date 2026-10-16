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

export function strictScore(statLine, statCategories) {
  const s = scoreStatLine(statLine, statCategories);
  return s.points != null && s.unsupportedStats.length === 0 ? s.points : null;
}

function gameTotals(rows) {
  const t = {}; for (const r of rows) if (Number.isFinite(r.gamesPlayed)) t[r.season] = Math.min(82, Math.max(t[r.season] || 1, r.gamesPlayed)); return t;
}

function durabilityGames(view, targetSeason) {
  const totals = gameTotals(view.rows);
  const byPlayer = new Map();
  for (const r of view.rows) { if (!byPlayer.has(r.player.id)) byPlayer.set(r.player.id, []); byPlayer.get(r.player.id).push(r); }
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

export function productionModel() {
  return {
    id: 'production', version: 'progm.production-carry-forward+durability.v1',
    description: 'Last-season stat line (league scoring), last-season minutes, production durability model for games.',
    fit(view, { statCategories, targetSeason }) {
      const gamesOf = durabilityGames(view, targetSeason);
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

export const DEFAULT_BASELINES = () => [productionModel(), ageMinutesModel(), naiveGamesModel()];
