/**
 * Deterministic injury/suspension status mapping. A fixed lookup table, no scoring, no text interpretation beyond
 * the two fixed rules below. Anything not in the table maps to 'unknown' (never guessed).
 *
 * Bump MAPPING_VERSION whenever the table or a rule changes; every record carries the version it was written with.
 */
export const MAPPING_VERSION = 'progm.injury-status-map.v1';
export const STATUSES = Object.freeze(['out', 'doubtful', 'questionable', 'available', 'suspended', 'unknown']);
export const REASONS = Object.freeze(['suspension', 'illness', 'rest', 'personal', 'injury', 'other', 'unspecified']);

// Keys are normalizeToken() output. Yahoo status codes and ESPN status / type descriptions.
const TABLE = new Map(Object.entries({
  O: 'out', OUT: 'out', INJ: 'out', IL: 'out', 'IL+': 'out', IR: 'out', OFS: 'out', NA: 'out',
  'OUT FOR SEASON': 'out', 'OUT INDEFINITELY': 'out', 'NOT ACTIVE': 'out', INACTIVE: 'out', INJURED: 'out',
  'INJURED RESERVE': 'out', 'INJURED LIST': 'out',
  D: 'doubtful', DOUBTFUL: 'doubtful',
  // Day-to-day / game-time decision / probable are all "may or may not play": kept as questionable, never as available.
  Q: 'questionable', QUESTIONABLE: 'questionable', GTD: 'questionable', 'GAME TIME DECISION': 'questionable',
  DTD: 'questionable', 'DAY TO DAY': 'questionable', P: 'questionable', PROBABLE: 'questionable',
  HEALTHY: 'available', ACTIVE: 'available', AVAILABLE: 'available',
  SUSP: 'suspended', SUSPENDED: 'suspended', SUSPENSION: 'suspended',
}));

export function normalizeToken(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  return t || null;
}

/**
 * @param {string|null} rawStatus source status code/text
 * @param {string|null} [note]    transient free text, used ONLY for the suspension rule below, never stored
 * Rule 1: table lookup of rawStatus. Rule 2: a status that maps to 'out' becomes 'suspended' when the note contains
 * the word suspend/suspended/suspension (ESPN lists suspensions as "Out").
 */
export function mapStatus(rawStatus, note = null) {
  const token = normalizeToken(rawStatus);
  if (!token) return 'unknown';
  const mapped = TABLE.get(token) ?? 'unknown';
  if (mapped === 'out' && typeof note === 'string' && /\bsuspen(?:d|ded|sion|sions)\b/i.test(note)) return 'suspended';
  return mapped;
}

const REASON_RULES = [
  ['suspension', /\bsuspen(?:d|ded|sion|sions)\b/i],
  ['rest', /\b(?:rest|load management|managed?|maintenance)\b/i],
  ['personal', /\b(?:personal|family|bereavement|paternity|non-?basketball|league matter|g league|assignment)\b/i],
  ['illness', /\b(?:ill|illness|sick|flu|covid|virus|stomach|migraine|headache)\b/i],
  ['injury', /\b(?:injur\w*|sprain\w*|strain\w*|fractur\w*|tear|torn|surgery|soreness|sore|contusion|bruise\w*|knee|ankle|foot|calf|hamstring|hip|shoulder|wrist|hand|finger|thumb|elbow|groin|quad\w*|achilles|concussion|rehab\w*|recover\w*)\b/i],
];

/** Coarse reason category. The category is stored; the free text and any body part are not. */
export function reasonCategory(note, status) {
  if (status === 'suspended') return 'suspension';
  if (typeof note !== 'string' || !note.trim()) return 'unspecified';
  for (const [name, re] of REASON_RULES) if (re.test(note)) return name;
  return 'other';
}
