/**
 * Projection model selection (feature flag). DEFAULT IS THE EXISTING MODEL.
 *
 *   PROGM_PROJECTION_MODEL=recency_hybrid_v1   enables the recency hybrid
 *   (unset / anything else)                    existing model (immediate rollback)
 *
 * The hybrid's defaults come from the Phase 15 offline study (half-life 5
 * games, ramp of 10 window games), tuned on validation data only; see
 * docs/evaluations/phase15-early-season-hybrid.md. That study used historical
 * data held under maintainer permission plus owner risk acceptance, not
 * verified NBA permission. Overrides are validated and fall back to defaults.
 */
export const EXISTING_MODEL_VERSION = 'progm.existing.v1';
export const HYBRID_MODEL_VERSION = 'progm.recency-hybrid.v1';
export const HYBRID_DEFAULTS = Object.freeze({ halfLife: 5, rampGames: 10 });

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return value != null && value !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function resolveProjectionModel(env = process.env) {
  if (String(env.PROGM_PROJECTION_MODEL || '').trim() !== 'recency_hybrid_v1') {
    return { kind: 'existing', version: EXISTING_MODEL_VERSION };
  }
  return {
    kind: 'recency_hybrid',
    version: HYBRID_MODEL_VERSION,
    halfLife: boundedNumber(env.PROGM_HYBRID_HALF_LIFE, HYBRID_DEFAULTS.halfLife, 1, 30),
    rampGames: boundedNumber(env.PROGM_HYBRID_RAMP_GAMES, HYBRID_DEFAULTS.rampGames, 1, 30),
  };
}

/** Labels for API responses: which model produced which horizon's numbers. */
export function projectionModelLabels(model = resolveProjectionModel()) {
  return { season: EXISTING_MODEL_VERSION, nextGame: model.version, hybridEnabled: model.kind === 'recency_hybrid' };
}
