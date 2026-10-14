import { restrictedSourceFromProvenance } from '../fantasy/backtest/sourcePolicy.js';
import { SPORTS } from './schema.js';

/**
 * A source must be registered with documented, human-reviewed permissions
 * before any of its data can be stored. Publicly accessible data is never
 * assumed to be reusable: storage and commercial use must both be explicitly
 * granted, and sources whose terms are known to prohibit this use are refused
 * unless written permission is on file.
 */
const PERMISSION_FLAGS = Object.freeze(['storage', 'commercialUse', 'modelTraining', 'redistribution', 'publicApi']);

// Providers whose terms prohibit (or have not granted) storage/commercial/ML
// reuse of their statistics. Matching is on any descriptive source field.
const PROHIBITED_WITHOUT_WRITTEN_PERMISSION = Object.freeze([
  { pattern: /sports-reference|basketball-reference|stathead/i, reason: 'Sports Reference terms prohibit automated access and AI training without written permission' },
  { pattern: /(^|[./\s])nba\.com|stats\.nba\.com|cdn\.nba\.com|nba_api/i, reason: 'NBA.com terms have not been verified to permit commercial reuse' },
  { pattern: /espn/i, reason: 'ESPN terms have not been verified to permit commercial reuse' },
  { pattern: /yahoo/i, reason: 'Yahoo Fantasy API terms restrict storage and separating underlying data' },
]);

const DESCRIPTIVE_FIELDS = ['sourceKey', 'name', 'provider', 'licenseUrl', 'sourceUrl'];

function text(value) {
  const valueText = typeof value === 'string' ? value.trim() : '';
  return valueText || null;
}

function requiredText(value, label) {
  const valueText = text(value);
  if (!valueText) throw new Error(`Source ${label} is required.`);
  return valueText;
}

function httpsUrl(value, label, { required = true } = {}) {
  const valueText = text(value);
  if (!valueText) {
    if (required) throw new Error(`Source ${label} is required.`);
    return null;
  }
  let url;
  try { url = new URL(valueText); } catch { throw new Error(`Source ${label} must be a valid URL.`); }
  if (url.protocol !== 'https:') throw new Error(`Source ${label} must use https.`);
  return url.toString();
}

/** Validate and normalize a source registration; throws on undocumented permissions. */
export function normalizeSource(raw) {
  const sourceKey = text(raw?.sourceKey);
  if (!sourceKey || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(sourceKey)) throw new Error('Source sourceKey must be a lowercase slug.');
  const sports = [...new Set(Array.isArray(raw.sports) ? raw.sports : [])];
  if (!sports.length || sports.some((sport) => !SPORTS[sport])) throw new Error(`Source ${sourceKey} must list known sports.`);
  const permissions = {};
  for (const flag of PERMISSION_FLAGS) {
    if (typeof raw.permissions?.[flag] !== 'boolean') throw new Error(`Source ${sourceKey} must explicitly document permissions.${flag} (true/false).`);
    permissions[flag] = raw.permissions[flag];
  }
  const termsReviewedAt = raw.termsReviewedAt && !Number.isNaN(Date.parse(raw.termsReviewedAt)) ? new Date(raw.termsReviewedAt).toISOString() : null;
  if (!termsReviewedAt) throw new Error(`Source ${sourceKey} requires termsReviewedAt.`);
  return {
    sourceKey,
    name: requiredText(raw.name, 'name'),
    provider: text(raw.provider),
    sports,
    licenseName: requiredText(raw.licenseName, 'licenseName'),
    licenseUrl: httpsUrl(raw.licenseUrl, 'licenseUrl'),
    sourceUrl: httpsUrl(raw.sourceUrl, 'sourceUrl', { required: false }),
    writtenPermissionUrl: httpsUrl(raw.writtenPermissionUrl, 'writtenPermissionUrl', { required: false }),
    termsReviewedAt,
    reviewedBy: requiredText(raw.reviewedBy, 'reviewedBy'),
    attribution: text(raw.attribution),
    synthetic: raw.synthetic === true,
    permissions,
  };
}

/** Reasons ingestion must be refused for this source, or [] when allowed. */
export function ingestionBlockers(source, sport) {
  const blockers = [];
  if (!source.permissions.storage) blockers.push('storage is not permitted');
  if (!source.permissions.commercialUse) blockers.push('commercial use is not permitted');
  if (sport && !source.sports.includes(sport)) blockers.push(`source is not registered for ${sport}`);
  if (!source.writtenPermissionUrl) {
    const descriptive = DESCRIPTIVE_FIELDS.map((field) => source[field]).filter(Boolean).join(' ');
    for (const { pattern, reason } of PROHIBITED_WITHOUT_WRITTEN_PERMISSION) if (pattern.test(descriptive)) blockers.push(reason);
    if (restrictedSourceFromProvenance(source)) blockers.push('Brescou-derived data requires documented upstream commercial rights');
  }
  return blockers;
}

export function assertIngestionPermitted(source, sport) {
  const blockers = ingestionBlockers(source, sport);
  if (blockers.length) throw new Error(`Ingestion refused for source ${source.sourceKey}: ${blockers.join('; ')}.`);
}

/** Phase 8 evaluation provenance for stored data; requires a model-training grant. */
export function evaluationProvenance(source, acquiredAt) {
  if (!source.permissions.modelTraining) throw new Error(`Source ${source.sourceKey} does not permit model training/evaluation.`);
  return {
    name: source.sourceKey,
    provider: source.provider,
    permission: `${source.licenseName}; reviewed ${source.termsReviewedAt} by ${source.reviewedBy}`,
    acquiredAt: acquiredAt || source.termsReviewedAt,
    authorized: true,
    synthetic: source.synthetic,
    licenseUrl: source.licenseUrl,
    sourceUrl: source.sourceUrl,
  };
}
