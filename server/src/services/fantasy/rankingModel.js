/**
 * Selectable ProGM draft-value ranking model.
 *
 *   A (default, production):  0.70*production + 0.20*replacement + 0.05*scarcity + 0.05*rosterFit
 *   B (flagged):              0.70*production + 0.20*replacement + 0.00*scarcity + 0.05*rosterFit
 *
 * Both multiply by the same confidence factor (0.9 + 0.1*confidence) and scale
 * by 100. B drops the separate min-max scarcity bonus and does NOT redistribute
 * its 0.05 weight, so B = A - 5 * scarcity * confidenceFactor (on the same
 * player, before rounding). B scores therefore sit up to 5 points below A.
 *
 * Selected server-side via PROGM_RANKING_MODEL ("A" | "B", case-insensitive).
 * Anything else (unset, empty, unknown) falls back to A. No client toggle.
 */
export const RANKING_MODELS = Object.freeze({
  A: Object.freeze({
    id: 'A',
    label: 'progm.draft-value.A',
    weights: Object.freeze({ production: 0.70, replacement: 0.20, scarcity: 0.05, rosterFit: 0.05 }),
  }),
  B: Object.freeze({
    id: 'B',
    label: 'progm.draft-value.B',
    weights: Object.freeze({ production: 0.70, replacement: 0.20, scarcity: 0, rosterFit: 0.05 }),
  }),
});

export const DEFAULT_RANKING_MODEL = 'A';

/** Normalize any input to a known model id ('A' | 'B'); unknown -> default. */
export function normalizeRankingModel(value) {
  const id = String(value ?? '').trim().toUpperCase();
  return Object.hasOwn(RANKING_MODELS, id) ? id : DEFAULT_RANKING_MODEL;
}

/** Resolve the active model id from the environment (default A). */
export function resolveRankingModel(env = process.env) {
  return normalizeRankingModel(env?.PROGM_RANKING_MODEL);
}

export function rankingModelInfo(id) {
  return RANKING_MODELS[normalizeRankingModel(id)];
}
