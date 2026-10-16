/**
 * Private-data scanner for log records. A record that matches any pattern is refused (never written).
 * Patterns cover Yahoo league/team keys, credentials and contact details; player ids and public names are allowed.
 */
export const PRIVATE_PATTERNS = Object.freeze([
  ['yahoo-league-key', /\b\d+\.l\.\d+/],
  ['yahoo-team-key', /\.t\.\d+\b/],
  ['credential', /access[_-]?token|refresh[_-]?token|oauth|bearer\s+[a-z0-9._~+/=-]{10,}|client[_-]?secret|api[_-]?key|authorization\s*:/i],
  ['cookie', /set-cookie|\bcookie\s*[:=]|\bsession[_-]?id\s*[:=]/i],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['league-parameter', /[?&;](?:league|team|league_key|team_key|guid|token)=/i],
]);

/** @returns {string[]} names of the patterns found in `text` (empty when clean). */
export function findPrivateData(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return PRIVATE_PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}
