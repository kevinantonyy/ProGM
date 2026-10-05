/**
 * Expert signal consensus aggregator.
 *
 * Combines normalized ExpertSignals from one or more providers into a per-player
 * ExpertConsensus using:
 *   - freshness weighting (exponential decay by age; expired signals dropped)
 *   - confidence weighting (source-stated confidence)
 *   - deduplication (one effective signal per source+player+type; newest wins)
 *   - conflict detection (sources materially disagree -> flagged, not hidden)
 *   - minimum-source / minimum-confidence safeguards (meetsThreshold)
 *
 * It NEVER fabricates a signal and NEVER infers an opinion a provider did not
 * report. Output is advisory metadata only; wiring it into recommendations is
 * gated separately (see config.js) and off by default.
 */
import { normalizeSignal, POSITIVE_TYPES, NEGATIVE_TYPES } from './types.js';

export const DEFAULT_AGG_OPTIONS = Object.freeze({
  halfLifeHours: 48,     // signal weight halves every 48h of age
  minSources: 2,         // need >= 2 distinct sources to "meet threshold"
  minConfidence: 0.5,    // aggregate confidence must be >= this to meet threshold
  conflictBand: 0.34,    // if both +ve and -ve weight exceed this share -> conflicted
  maxAgeHours: 240,      // signals older than 10 days are ignored entirely
});

/** Directional sign for a signal type (+1 favorable, -1 unfavorable, 0 neutral/rank). */
function typeSign(type) {
  if (POSITIVE_TYPES.has(type)) return 1;
  if (NEGATIVE_TYPES.has(type)) return -1;
  return 0; // 'rank' carries its own signed sentiment
}

/**
 * Freshness weight in (0,1] from age using exponential decay. Fresh = ~1,
 * older decays toward 0. Returns 0 when expired or beyond maxAge.
 */
export function freshnessWeight(signal, now, { halfLifeHours, maxAgeHours }) {
  const published = Date.parse(signal.publishedAt);
  if (Number.isNaN(published)) return 0;
  if (signal.expiresAt) {
    const exp = Date.parse(signal.expiresAt);
    if (!Number.isNaN(exp) && now >= exp) return 0; // expired -> void
  }
  const ageHours = Math.max(0, (now - published) / 3_600_000);
  if (ageHours > maxAgeHours) return 0;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/** Stable key grouping signals to the same player (id when present, else normalized name). */
function playerKeyOf(signal) {
  if (signal.playerId) return `id:${signal.playerId}`;
  return `name:${signal.name.trim().toLowerCase()}`;
}

/**
 * Deduplicate to one signal per (source, player, type): the most recently
 * published wins. Prevents a single source double-counting the same opinion.
 */
function dedupe(signals) {
  const best = new Map();
  for (const s of signals) {
    const key = `${s.source}|${playerKeyOf(s)}|${s.type}`;
    const prev = best.get(key);
    if (!prev || Date.parse(s.publishedAt) > Date.parse(prev.publishedAt)) best.set(key, s);
  }
  return [...best.values()];
}

/**
 * Aggregate raw/normalized signals into per-player consensus records.
 *
 * @param {Array} rawSignals             raw or normalized ExpertSignal-like objects
 * @param {Object} [options]
 * @param {number} [options.now]          epoch ms (injectable for deterministic tests)
 * @returns {import('./types.js').ExpertConsensus[]}
 */
export function aggregateSignals(rawSignals, options = {}) {
  const opts = { ...DEFAULT_AGG_OPTIONS, ...options };
  const now = options.now ?? Date.now();

  const normalized = (rawSignals || []).map(normalizeSignal).filter(Boolean);
  const deduped = dedupe(normalized);

  // Group by player.
  const byPlayer = new Map();
  for (const s of deduped) {
    const key = playerKeyOf(s);
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key).push(s);
  }

  const out = [];
  for (const [, signals] of byPlayer) {
    let weightSum = 0;
    let weightedScore = 0;
    let weightedConfidence = 0;
    let posWeight = 0;
    let negWeight = 0;
    const sources = new Set();
    const citations = [];
    const typeWeight = new Map();

    for (const s of signals) {
      const fw = freshnessWeight(s, now, opts);
      if (fw <= 0) continue; // expired / too old -> excluded entirely
      const w = fw * s.confidence; // freshness × confidence
      if (w <= 0) continue;

      // Directional sentiment: explicit sentiment, oriented by the type's sign
      // when the type is directional (start/add/buy vs sit/drop/sell).
      const sign = typeSign(s.type);
      const directional = sign === 0 ? s.sentiment : sign * Math.abs(s.sentiment);

      weightSum += w;
      weightedScore += w * directional;
      weightedConfidence += w * s.confidence;
      if (directional > 0) posWeight += w;
      else if (directional < 0) negWeight += w;

      sources.add(s.source);
      citations.push({ source: s.source, sourceUrl: s.sourceUrl });
      typeWeight.set(s.type, (typeWeight.get(s.type) || 0) + w);
    }

    const first = signals[0];
    if (weightSum <= 0) {
      // All signals expired/too old -> a consensus with no usable weight.
      out.push({
        playerId: first.playerId, name: first.name, type: null,
        score: 0, confidence: 0, sourceCount: 0, conflicted: false,
        meetsThreshold: false, citations: [], computedAt: new Date(now).toISOString(),
      });
      continue;
    }

    const score = Number((weightedScore / weightSum).toFixed(4));
    const confidence = Number((weightedConfidence / weightSum).toFixed(4));
    const sourceCount = sources.size;

    // Conflict: both directions carry a material share of the total weight.
    const posShare = posWeight / weightSum;
    const negShare = negWeight / weightSum;
    const conflicted = posShare >= opts.conflictBand && negShare >= opts.conflictBand;

    // Dominant type = highest aggregated weight (null if conflicted/none).
    let dominantType = null;
    let bestW = 0;
    for (const [t, w] of typeWeight) if (w > bestW) { bestW = w; dominantType = t; }

    const meetsThreshold = sourceCount >= opts.minSources && confidence >= opts.minConfidence && !conflicted;

    out.push({
      playerId: first.playerId,
      name: first.name,
      type: conflicted ? null : dominantType,
      score,
      confidence,
      sourceCount,
      conflicted,
      meetsThreshold,
      citations,
      computedAt: new Date(now).toISOString(),
    });
  }

  return out;
}

/** Build a quick lookup (playerKey -> consensus) from aggregated records. */
export function indexConsensus(consensusList) {
  const map = new Map();
  for (const c of consensusList || []) {
    const key = c.playerId ? `id:${c.playerId}` : `name:${c.name.trim().toLowerCase()}`;
    map.set(key, c);
  }
  return map;
}
