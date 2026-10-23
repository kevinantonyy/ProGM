import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const HISTORY_TTL_MS = 10 * 60 * 1000;
export const MAX_HISTORY_TOKEN_LENGTH = 20_000;
const MAX_HISTORY_BYTES = 12_000;
const validMessage = (m) => m && typeof m === 'object' && !Array.isArray(m)
  && ['user', 'gm'].includes(m.role) && typeof m.text === 'string' && m.text.length <= 1200;

/**
 * A short-lived, user-bound, encrypted receipt for SERVER-VERIFIED GENERAL turns only.
 * No server conversation cache, database, browser history, or personalized answer is stored here.
 * The process-local key intentionally invalidates receipts on restart/deploy. Invalid receipts start a new general conversation.
 */
export function createGeneralChatHistory({ now = Date.now, key = randomBytes(32) } = {}) {
  const aad = (userId) => Buffer.from(`progm.general-history.v1:${String(userId)}`);
  return {
    read(token, userId) {
      if (userId == null || typeof token !== 'string' || token.length > MAX_HISTORY_TOKEN_LENGTH) return [];
      try {
        const [version, iv, content, tag, extra] = token.split('.');
        if (version !== 'g1' || extra !== undefined || !iv || !content || !tag) return [];
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(aad(userId));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const body = JSON.parse(Buffer.concat([decipher.update(Buffer.from(content, 'base64url')), decipher.final()]).toString('utf8'));
        const t = now();
        if (!Number.isFinite(body.at) || body.at > t || t - body.at >= HISTORY_TTL_MS
          || !Array.isArray(body.messages) || body.messages.length > 10 || !body.messages.every(validMessage)) return [];
        return body.messages;
      } catch { return []; }
    },
    issue(messages, userId) {
      if (userId == null || !Array.isArray(messages) || !messages.every(validMessage)) return null;
      const body = { at: now(), messages: messages.slice(-10).map(({ role, text }) => ({ role, text })) };
      while (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_HISTORY_BYTES) body.messages.shift();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(userId));
      const content = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
      return ['g1', iv.toString('base64url'), content.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
  };
}
