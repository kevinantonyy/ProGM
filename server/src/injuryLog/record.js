/**
 * Log record construction. Pure: no I/O, no clock. `observedAt` is supplied by the store at write time and is never
 * taken from the input.
 */
import { createHash } from 'node:crypto';
import { MAPPING_VERSION, mapStatus, reasonCategory } from './statusMap.js';
import { findPrivateData } from './privacy.js';

export const SCHEMA = 'progm.injury-log.v1';
export const SOURCES = Object.freeze(['yahoo', 'espn']);
export const BASES = Object.freeze(['reported', 'absent-status']);
const ID_RE = /^(yahoo|espn):\d{1,12}$/;
const EXCERPT_MAX = 120;
const RAW_STATUS_MAX = 40;
const NAME_MAX = 80;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Canonical JSON: keys sorted, no whitespace. Stable across runs and platforms. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function cleanUrl(raw) {
  if (raw == null || raw === '') return { url: null };
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:') return { url: null, warning: 'source-url-not-https' };
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    const url = u.toString();
    if (url.length > 300) return { url: null, warning: 'source-url-too-long' };
    return { url };
  } catch { return { url: null, warning: 'source-url-invalid' }; }
}

function cleanTime(raw, observedAtMs) {
  if (raw == null || raw === '') return { at: null };
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return { at: null, warning: 'source-published-at-invalid' };
  // A claimed publish time after our own observation is not credible; drop it rather than store it.
  if (ms > observedAtMs) return { at: null, warning: 'source-published-at-in-future' };
  return { at: new Date(ms).toISOString() };
}

/** Fields that identify the source evidence. Excludes observedAt so identical evidence hashes identically. */
export function evidenceOf(r) {
  return { source: r.source, playerId: r.playerId, rawStatus: r.rawStatus, noteSha256: r.noteSha256, sourceUrl: r.sourceUrl, sourcePublishedAt: r.sourcePublishedAt, basis: r.basis };
}
export const contentHashOf = (r) => sha256(canonicalJson(evidenceOf(r)));
/** Identity of the player's reported state. Two consecutive records with the same stateKey are duplicates. */
export const stateKeyOf = (r) => sha256(canonicalJson({ source: r.source, playerId: r.playerId, rawStatus: r.rawStatus, status: r.status, reason: r.reason, mappingVersion: r.mappingVersion }));
/** Integrity id over the whole record (everything but recordId itself). */
export const recordIdOf = (r) => { const { recordId, ...rest } = r; return sha256(canonicalJson(rest)); };

/**
 * @param {object} obs { source, playerId, playerName?, rawStatus, note?, sourceUrl?, sourcePublishedAt?, basis? }
 * @param {{observedAt:string, keepExcerpt?:boolean}} ctx
 * @returns {{record:object, warnings:string[]}|{reject:string}}
 */
export function buildRecord(obs, { observedAt, keepExcerpt = false }) {
  if (!obs || typeof obs !== 'object' || Array.isArray(obs)) return { reject: 'observation-not-an-object' };
  if ('observedAt' in obs || 'availableAt' in obs) return { reject: 'caller-supplied-observation-time' };
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return { reject: 'invalid-observation-time' };
  if (!SOURCES.includes(obs.source)) return { reject: 'unknown-source' };
  if (typeof obs.playerId !== 'string' || !ID_RE.test(obs.playerId) || !obs.playerId.startsWith(`${obs.source}:`)) return { reject: 'invalid-player-id' };
  const basis = obs.basis ?? 'reported';
  if (!BASES.includes(basis)) return { reject: 'invalid-basis' };

  const warnings = [];
  let rawStatus = null;
  if (obs.rawStatus != null) {
    if (typeof obs.rawStatus !== 'string') return { reject: 'invalid-status' };
    rawStatus = obs.rawStatus.trim().slice(0, RAW_STATUS_MAX) || null;
  }
  // A missing status is only meaningful when the source's convention says so (Yahoo omits it for healthy players).
  if (rawStatus == null && basis !== 'absent-status') return { reject: 'missing-status' };
  if (rawStatus != null && basis === 'absent-status') return { reject: 'basis-conflicts-with-status' };

  const note = typeof obs.note === 'string' && obs.note.trim() ? obs.note.trim() : null;
  const status = basis === 'absent-status' ? 'available' : mapStatus(rawStatus, note);
  const url = cleanUrl(obs.sourceUrl); if (url.warning) warnings.push(url.warning);
  const pub = cleanTime(obs.sourcePublishedAt, observedAtMs); if (pub.warning) warnings.push(pub.warning);
  const name = typeof obs.playerName === 'string' ? obs.playerName.trim().slice(0, NAME_MAX) || null : null;

  const record = {
    schema: SCHEMA,
    observedAt: new Date(observedAtMs).toISOString(),
    source: obs.source,
    playerId: obs.playerId,
    playerName: name,
    rawStatus,
    status,
    reason: basis === 'absent-status' ? 'unspecified' : reasonCategory(note, status),
    basis,
    sourceUrl: url.url,
    sourcePublishedAt: pub.at,
    noteSha256: note ? sha256(note) : null,
    noteLength: note ? note.length : 0,
    ...(keepExcerpt && note ? { noteExcerpt: note.slice(0, EXCERPT_MAX) } : {}),
    mappingVersion: MAPPING_VERSION,
  };
  record.contentHash = contentHashOf(record);
  record.recordId = recordIdOf(record);

  const hits = findPrivateData({ ...record, noteSha256: undefined, contentHash: undefined, recordId: undefined });
  if (hits.length) return { reject: `private-data:${hits.join(',')}` };
  return { record, warnings };
}

/** Structural + integrity validation of a stored record (used by the reader and `verify`). */
export function validateStoredRecord(r) {
  if (!r || typeof r !== 'object') return 'not-an-object';
  if (r.schema !== SCHEMA) return 'unknown-schema';
  if (!SOURCES.includes(r.source) || typeof r.playerId !== 'string' || !ID_RE.test(r.playerId) || !r.playerId.startsWith(`${r.source}:`)) return 'invalid-identity';
  if (!Number.isFinite(Date.parse(r.observedAt))) return 'invalid-observed-at';
  if (r.contentHash !== contentHashOf(r)) return 'content-hash-mismatch';
  if (r.recordId !== recordIdOf(r)) return 'record-id-mismatch';
  return null;
}
