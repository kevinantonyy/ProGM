/**
 * Read-only comparison of the legacy and v2 draft-value models over an ALREADY BUILT draft board.
 * Pure: no network, no cache writes, no Yahoo requests. It re-derives both values from each row's own
 * published components (production, replacement, scarcity, confidence factor), so the same pool,
 * projections and eligibility feed both models and the comparison isolates the formula.
 *
 * Output carries player names and numbers only: no league keys, team names, tokens or roster contents.
 */
import { RANKING_MODELS } from './rankingModel.js';
import { normalizeName } from '../identity/playerIdentity.js';

const NEUTRAL_FIT = 0.5; // baseline (ProGM Rank) uses neutral roster fit for everyone

function value(c, weights) {
  return (weights.production * c.production + weights.replacement * c.replacement
    + weights.scarcity * c.scarcity + weights.rosterFit * NEUTRAL_FIT) * c.confidenceFactor * 100;
}

function competitionRanks(items, key) {
  const sorted = [...items].sort((a, b) => b[key] - a[key]);
  return new Map(items.map((it) => [it, 1 + sorted.filter((o) => o[key] > it[key]).length]));
}

const round = (x, d = 1) => (x == null ? null : Number(x.toFixed(d)));

export function compareRankingModels(boardRows, { top = 50, highlight = [] } = {}) {
  const rows = (boardRows || []).filter((r) => r?.components?.production != null && r.components.confidenceFactor != null);
  const L = RANKING_MODELS.legacy.weights;
  const V = RANKING_MODELS.v2.weights;
  const items = rows.map((r) => {
    const c = r.components;
    return { r, c, legacy: value(c, L), v2: value(c, V) };
  });
  const lr = competitionRanks(items, 'legacy');
  const vr = competitionRanks(items, 'v2');
  const shape = (it) => {
    const { r, c } = it; const cf = c.confidenceFactor;
    return {
      name: r.name,
      eligiblePositions: (r.eligiblePositions || []).filter((p) => p !== 'UTIL'),
      legacyRank: lr.get(it), v2Rank: vr.get(it), rankChange: lr.get(it) - vr.get(it), // + = moves up under v2
      projectedFantasyPointsPerGame: round(c.perGame, 1), expectedGames: round(c.expectedGames, 1), projectedSeasonPoints: Math.round(c.seasonPoints),
      factors: {
        productionPts: round(L.production * c.production * cf * 100), productionPtsV2: round(V.production * c.production * cf * 100),
        replacementPts: round(L.replacement * c.replacement * cf * 100),
        scarcityPtsLegacy: round(L.scarcity * c.scarcity * cf * 100), scarcityPtsV2: 0,
        confidenceFactor: round(cf, 3),
      },
      valueLegacy: round(it.legacy), valueV2: round(it.v2),
      estimate: r.estimate === true, projectionMethod: r.projectionMethod ?? null, confidence: round(c.confidence, 2),
    };
  };
  const byLegacy = [...items].sort((a, b) => lr.get(a) - lr.get(b));
  const topLegacy = byLegacy.slice(0, top);
  const inTopLegacy = new Set(topLegacy);
  const topV2 = [...items].sort((a, b) => vr.get(a) - vr.get(b)).slice(0, top);
  // Accent- and suffix-insensitive ("Alperen Sengun" finds Yahoo's "Alperen Şengün").
  const wanted = new Set((highlight || []).map((n) => normalizeName(n)));
  const highlighted = items.filter((it) => wanted.has(normalizeName(it.r.name)));
  const overlap = topV2.filter((it) => inTopLegacy.has(it)).length;
  const cElig = items.filter((it) => (it.r.eligiblePositions || []).includes('C'));
  const others = items.filter((it) => !(it.r.eligiblePositions || []).includes('C'));
  const mean = (arr) => (arr.length ? round(arr.reduce((s, it) => s + (vr.get(it) - lr.get(it)), 0) / arr.length) : null);
  return {
    generatedFrom: 'cached draft board rows (no new requests)',
    players: items.length,
    summary: {
      top: top, topOverlap: overlap,
      meanRankShiftV2: { cEligible: mean(cElig), otherPositions: mean(others), counts: { cEligible: cElig.length, others: others.length } },
      estimateRows: items.filter((it) => it.r.estimate === true).length,
    },
    topByLegacy: topLegacy.map(shape),
    enteringTopUnderV2: topV2.filter((it) => !inTopLegacy.has(it)).map(shape),
    leavingTopUnderV2: topLegacy.filter((it) => !topV2.includes(it)).map(shape),
    highlighted: highlighted.map(shape),
  };
}
