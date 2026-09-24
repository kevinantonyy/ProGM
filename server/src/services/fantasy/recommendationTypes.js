/**
 * Provider-independent recommendation shapes shared across ProGM analytics
 * engines (basketball today; reusable for football later without a big
 * refactor). These are lightweight factory helpers + JSDoc typedefs, not
 * classes — engines return plain objects in these shapes.
 *
 * Every recommendation carries dataSources + calculatedAt so the UI and the
 * Ask ProGM explanation layer can be transparent about provenance, and so we
 * never blur Yahoo facts, ProGM calculations, and external-provider data.
 *
 * @typedef {'Yahoo'|'External provider'|'ProGM calculation'} DataSource
 *
 * @typedef {Object} Recommendation
 * @property {string} type              e.g. 'start', 'add_drop', 'trade', 'watch'
 * @property {string} recommendation    short imperative summary
 * @property {number|null} confidence   0-1 data-quality confidence (null if N/A)
 * @property {{metric:string, value:number}|null} projectedImpact
 * @property {string[]} reasons
 * @property {DataSource[]} dataSources
 * @property {string} calculatedAt      ISO timestamp
 *
 * @typedef {Object} TradeRecommendation
 * @property {Array} send               players I send (summaries)
 * @property {Array} receive            players I receive (summaries)
 * @property {string} withTeam          opponent team name
 * @property {string} withTeamKey
 * @property {'improves'|'neutral'|'reduces'} improvement   effect on MY team
 * @property {'balanced'|'favors your side'|'favors their side'|'plausible starting point'} fairness
 * @property {Object} production        { sendValue, receiveValue, net }
 * @property {Object} depthImpact       positional depth deltas for my roster
 * @property {string[]} whyForMe
 * @property {string[]} whyForThem
 * @property {string[]} risks
 * @property {number|null} confidence
 *
 * @typedef {Object} WaiverRecommendation
 * @property {Object} add               player to add (summary)
 * @property {Object|null} drop         player to drop (summary) — only when needed
 * @property {number|null} netImprovement
 * @property {string} category          'Must Add' | 'Streamer' | 'Stash' | 'Watch'
 * @property {string[]} reasons
 *
 * @typedef {Object} LineupRecommendation
 * @property {Array} currentLineup
 * @property {Array} recommendedLineup
 * @property {number|null} projectedCurrentPoints
 * @property {number|null} projectedOptimizedPoints
 * @property {number|null} projectedDifference
 * @property {Array} swaps
 *
 * @typedef {Object} TeamAnalysis
 * @property {Object} counts
 * @property {Object} positions
 * @property {Object} health
 * @property {string[]} strengths
 * @property {string[]} weaknesses
 */

/** Build a Recommendation object with a timestamp. */
export function makeRecommendation({
  type,
  recommendation,
  confidence = null,
  projectedImpact = null,
  reasons = [],
  dataSources = [],
}) {
  return { type, recommendation, confidence, projectedImpact, reasons, dataSources, calculatedAt: new Date().toISOString() };
}

/** Canonical data-source labels (avoids typos across engines). */
export const SOURCE = Object.freeze({
  YAHOO: 'Yahoo',
  EXTERNAL: 'External provider',
  PROGM: 'ProGM calculation',
});
