/**
 * Expert intelligence framework — public entry point.
 *
 * DISABLED BY DEFAULT. The whole layer is a no-op unless BOTH:
 *   1. the feature flag EXPERT_SIGNALS_ENABLED === 'true', AND
 *   2. at least one registered provider reports isEnabled() === true.
 *
 * Until then, getExpertConsensus() returns an empty, disabled result and the
 * optional recommendation blend (applyExpertSignal) is a pure pass-through —
 * so current recommendations are byte-for-byte unchanged.
 *
 * To add a real provider later: implement the ExpertProvider interface
 * (see types.js), register it in `registerProvider`, obtain the proper license/
 * permission, and set EXPERT_SIGNALS_ENABLED=true. No engine code changes.
 */
import { aggregateSignals, indexConsensus } from './aggregator.js';
import nullExpertProvider from './nullProvider.js';

// Registry starts with only the (always-disabled) null provider.
const providers = [nullExpertProvider];

/** Register an additional expert provider (licensed/permitted sources only). */
export function registerProvider(provider) {
  if (provider && typeof provider.getSignals === 'function' && typeof provider.isEnabled === 'function') {
    providers.push(provider);
  }
  return providers.length;
}

/** For tests: reset the registry to just the null provider. */
export function _resetProvidersForTest() {
  providers.length = 0;
  providers.push(nullExpertProvider);
}

/** Global feature flag — expert signals are OFF unless explicitly enabled. */
export function isExpertEnabled() {
  return process.env.EXPERT_SIGNALS_ENABLED === 'true';
}

/** Providers that are currently enabled (only when the global flag is on too). */
function activeProviders() {
  if (!isExpertEnabled()) return [];
  return providers.filter((p) => {
    try { return p.isEnabled(); } catch { return false; }
  });
}

/**
 * Fetch + aggregate expert consensus for a set of players.
 *
 * @param {Object} params
 * @param {string[]} [params.playerNames]
 * @param {string[]} [params.playerIds]
 * @param {string|number} [params.season]
 * @param {Object} [params.aggregateOptions]  overrides for the aggregator
 * @returns {Promise<{ enabled:boolean, reason:string|null, consensus:Array, index:Map }>}
 */
export async function getExpertConsensus({ playerNames, playerIds, season, aggregateOptions } = {}) {
  const active = activeProviders();
  if (!active.length) {
    return {
      enabled: false,
      reason: isExpertEnabled() ? 'No enabled expert providers registered.' : 'Expert signals are disabled.',
      consensus: [],
      index: new Map(),
    };
  }

  const all = [];
  for (const provider of active) {
    try {
      const signals = await provider.getSignals({ playerNames, playerIds, season });
      if (Array.isArray(signals)) for (const s of signals) all.push(s);
    } catch {
      // A failing provider must not break the layer; skip it.
    }
  }

  const consensus = aggregateSignals(all, aggregateOptions);
  return { enabled: true, reason: null, consensus, index: indexConsensus(consensus) };
}

/**
 * OPTIONAL expert nudge for a recommendation value.
 *
 * Pure pass-through unless expert signals are enabled AND a consensus exists
 * for the player AND it clears the minimum-source/confidence safeguards. Even
 * then it only applies a SMALL bounded multiplier so expert opinion informs,
 * never overrides, ProGM's deterministic value. When disabled it returns the
 * baseValue unchanged, so recommendations do not change today.
 *
 * @param {number|null} baseValue        ProGM-computed value (null stays null)
 * @param {Object|null} consensus        an ExpertConsensus for this player (or null)
 * @param {Object} [opts]
 * @param {number} [opts.maxAdjustment]  max fractional nudge (default 0.10 = ±10%)
 * @returns {{ value:number|null, adjusted:boolean, reason:string|null }}
 */
export function applyExpertSignal(baseValue, consensus, opts = {}) {
  const maxAdjustment = opts.maxAdjustment ?? 0.10;
  if (!isExpertEnabled()) return { value: baseValue, adjusted: false, reason: 'disabled' };
  if (baseValue == null) return { value: null, adjusted: false, reason: 'no_base_value' };
  if (!consensus || !consensus.meetsThreshold) return { value: baseValue, adjusted: false, reason: 'below_threshold' };

  // score in [-1,1] -> bounded multiplier in [1-max, 1+max].
  const factor = 1 + maxAdjustment * consensus.score;
  const value = Number((baseValue * factor).toFixed(2));
  return { value, adjusted: true, reason: `expert_${consensus.type || 'consensus'}` };
}

export { aggregateSignals, indexConsensus } from './aggregator.js';
export { normalizeSignal, SIGNAL_TYPES } from './types.js';
