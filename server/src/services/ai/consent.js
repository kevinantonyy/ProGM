/**
 * Server-recorded, revocable consent to send part of a user's Yahoo league to Google Gemini.
 *
 * The disclosure text lives HERE and is served to the browser, so the version the user agrees to is the version the server knows.
 * Consent is checked against the database on EVERY personalized request; a revoked or outdated row means no league data is sent.
 * Revoking stops future sharing only: data Google already received cannot be recalled from here, and the text says so.
 */
export const CONSENT_SCOPE = 'yahoo_league_gemini';
export const DISCLOSURE_VERSION = 1;

export const DISCLOSURE = Object.freeze({
  version: DISCLOSURE_VERSION,
  title: 'Share your Yahoo league with Google Gemini?',
  intro: 'To answer questions about your team, ProGM can send part of your league to Google’s Gemini AI service. It happens only when you turn this on and ask a question that needs it.',
  sent: Object.freeze([
    'A small summary chosen by your question: for example your players with their projections and injury status, your team rating, lineup, waiver or trade ideas that ProGM calculated, or the standings.',
    'Your scoring settings. Other teams appear only as “Team A”, “Team B”, and so on.',
    'At most about 6 KB of league information per question. After every answer you can open “See what was sent” to read the exact text.',
  ]),
  neverSent: Object.freeze([
    'Your password or login details, or any Yahoo access token.',
    'Your email address or username.',
    'Yahoo IDs, and your league, team and manager names.',
    'Profile pictures, Yahoo ownership percentages, ADP or Yahoo rankings.',
  ]),
  google: 'ProGM uses Google’s free Gemini service. Google’s terms for the free service say that Google may use what is sent to improve its products, and that human reviewers may read it (Google first separates it from your account and key). ProGM cannot delete it from Google’s systems.',
  yahoo: 'Your league information comes from Yahoo Fantasy through the connection you approved. Yahoo’s rules about sharing league data with outside AI services are still being clarified, so ProGM may turn this feature off at any time.',
  optional: 'This is optional. ProGM’s general AI chat works without it, and nothing about your league is sent unless you agree.',
  revoke: 'You can turn this off at any time in Ask ProGM. ProGM stops sending your league with your next question. Turning it off does not remove information Google has already received. ProGM keeps a record of your choice (the date and this version of the text) so it can honor it.',
  agree: 'Share my league with Gemini',
  decline: 'Not now',
});

export function createConsentStore(execute) {
  return {
    async get(userId) {
      const [rows] = await execute(
        'SELECT disclosure_version, granted_at, revoked_at FROM ai_data_consents WHERE user_id = ? AND scope = ?',
        [userId, CONSENT_SCOPE],
      );
      return rows?.[0] || null;
    },
    async hasActiveConsent(userId) {
      if (userId == null) return false;
      const row = await this.get(userId);
      return Boolean(row) && row.revoked_at == null && Number(row.disclosure_version) === DISCLOSURE_VERSION;
    },
    /** `version` is the disclosure version the user actually saw; a stale page cannot grant consent to newer text. */
    async grant(userId, version) {
      if (Number(version) !== DISCLOSURE_VERSION) return false;
      await execute(
        `INSERT INTO ai_data_consents (user_id, scope, disclosure_version, granted_at, revoked_at) VALUES (?, ?, ?, NOW(), NULL)
         ON CONFLICT (user_id, scope) DO UPDATE SET disclosure_version = EXCLUDED.disclosure_version, granted_at = NOW(), revoked_at = NULL`,
        [userId, CONSENT_SCOPE, DISCLOSURE_VERSION],
      );
      return true;
    },
    async revoke(userId) {
      await execute('UPDATE ai_data_consents SET revoked_at = NOW() WHERE user_id = ? AND scope = ? AND revoked_at IS NULL', [userId, CONSENT_SCOPE]);
    },
  };
}

/** In-memory store with the same contract, for tests. */
export function createMemoryConsentStore() {
  const rows = new Map();
  return {
    rows,
    async get(userId) { return rows.get(userId) || null; },
    async hasActiveConsent(userId) { const r = rows.get(userId); return Boolean(r) && r.revoked_at == null && r.disclosure_version === DISCLOSURE_VERSION; },
    async grant(userId, version) { if (Number(version) !== DISCLOSURE_VERSION) return false; rows.set(userId, { disclosure_version: DISCLOSURE_VERSION, granted_at: new Date(), revoked_at: null }); return true; },
    async revoke(userId) { const r = rows.get(userId); if (r) r.revoked_at = new Date(); },
  };
}
