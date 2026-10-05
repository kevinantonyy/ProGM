/**
 * Expert intelligence — provider-independent signal shapes + interface.
 *
 * This layer models OUTSIDE expert opinion (analyst start/sit, add/drop,
 * buy/sell, rankings) as a normalized signal that ProGM can OPTIONALLY blend
 * into its own deterministic recommendations later. It is intentionally
 * generic so multiple LICENSED/PERMITTED providers can be plugged in without
 * touching the engines.
 *
 * ⚠️ No external site is scraped or integrated here. There is only a null
 * provider by default, and the whole layer is DISABLED by default so it cannot
 * change current recommendations until it is explicitly turned on with real,
 * permitted sources.
 *
 * @typedef {'start'|'sit'|'add'|'drop'|'buy'|'sell'|'rank'} ExpertSignalType
 *
 * @typedef {Object} ExpertSignal
 * @property {string|null} playerId     External/canonical player id when known
 * @property {string} name              Player name (always present for matching)
 * @property {string} source            Provider/source identifier (e.g. 'acme-fantasy')
 * @property {ExpertSignalType} type
 * @property {number} sentiment         Directional opinion in [-1, 1]
 *                                      (+ = favorable/start/add/buy, - = sit/drop/sell).
 *                                      For 'rank', a normalized desirability in [-1,1].
 * @property {number} confidence        Source-stated confidence in [0, 1]
 * @property {string} publishedAt       ISO timestamp the opinion was published
 * @property {string|null} sourceUrl    Link to the original item (attribution)
 * @property {string|null} expiresAt    ISO timestamp after which the signal is stale/void
 *
 * @typedef {Object} ExpertConsensus
 * @property {string|null} playerId
 * @property {string} name
 * @property {ExpertSignalType|null} type        dominant signal type (null if mixed/none)
 * @property {number} score             freshness+confidence weighted mean sentiment [-1,1]
 * @property {number} confidence        aggregate confidence [0,1]
 * @property {number} sourceCount       distinct sources contributing
 * @property {boolean} conflicted       true when sources materially disagree
 * @property {boolean} meetsThreshold   passes minimum source/confidence safeguards
 * @property {Array<{source:string, sourceUrl:string|null}>} citations
 * @property {string} computedAt
 *
 * The ExpertProvider interface (duck-typed plain object):
 * {
 *   name: string,
 *   isEnabled(): boolean,                 // provider-level kill switch
 *   getSignals(params): Promise<ExpertSignal[]>   // params: { playerNames?, playerIds?, season? }
 * }
 *
 * Providers MUST return only data they are licensed/permitted to serve, with
 * accurate publishedAt/sourceUrl for attribution. The aggregator never
 * fabricates a signal and never infers one that a provider did not report.
 */

/** Valid signal types (used for validation; never guesses an unknown type). */
export const SIGNAL_TYPES = Object.freeze(['start', 'sit', 'add', 'drop', 'buy', 'sell', 'rank']);

/** Signal types whose natural sentiment is positive/negative (for conflict logic). */
export const POSITIVE_TYPES = Object.freeze(new Set(['start', 'add', 'buy']));
export const NEGATIVE_TYPES = Object.freeze(new Set(['sit', 'drop', 'sell']));

/** Clamp a number into [min, max]; returns null for non-finite input (never fabricates). */
export function clamp(value, min, max) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.max(min, Math.min(max, Number(value)));
}

/**
 * Validate + normalize a raw signal into an ExpertSignal, or return null if it
 * is unusable (missing name, bad type, missing timestamp). Never fabricates
 * missing fields; it only drops invalid records.
 *
 * @param {Partial<ExpertSignal>} raw
 * @returns {ExpertSignal|null}
 */
export function normalizeSignal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  if (!SIGNAL_TYPES.includes(raw.type)) return null;
  if (!raw.source || typeof raw.source !== 'string') return null;
  if (!raw.publishedAt || Number.isNaN(Date.parse(raw.publishedAt))) return null;

  const sentiment = clamp(raw.sentiment, -1, 1);
  const confidence = clamp(raw.confidence, 0, 1);
  if (sentiment == null || confidence == null) return null; // require real values

  return {
    playerId: raw.playerId != null ? String(raw.playerId) : null,
    name,
    source: raw.source,
    type: raw.type,
    sentiment,
    confidence,
    publishedAt: new Date(raw.publishedAt).toISOString(),
    sourceUrl: raw.sourceUrl || null,
    expiresAt: raw.expiresAt && !Number.isNaN(Date.parse(raw.expiresAt)) ? new Date(raw.expiresAt).toISOString() : null,
  };
}
