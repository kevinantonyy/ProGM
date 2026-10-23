import express from 'express';
import { authenticate as defaultAuthenticate } from '../middleware/auth.js';
import { resolveAiContext, sourceEnabled, DEFAULT_BUILDERS } from '../services/ai/aiDataPolicy.js';
import { DISCLOSURE, DISCLOSURE_VERSION } from '../services/ai/consent.js';
import { createGeneralChatHistory, MAX_HISTORY_TOKEN_LENGTH } from '../services/ai/generalChatHistory.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
export const MAX_PREVIEWS = 20;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

const SYSTEM_WITH_LEAGUE = `You are ProGM, an expert fantasy sports general manager. The user agreed to share a summary of their league; it is below. Other teams are anonymized as "Team A", "Team B" and so on, and the user's own team is "Your team". Use only the supplied data and the conversation. Default to a concise, mobile-friendly answer: lead with the recommendation, use at most 3 short bullets when useful, and normally stay under 90 words. Avoid introductions, repeated context, long paragraphs, and generic disclaimers. Include only the most decision-relevant numbers. The ProGM projections, ratings and suggestions in the data were calculated by ProGM; explain them, do not invent different numbers. If the data needed for the question is missing, say so briefly and suggest asking about that topic (for example waivers, trades or lineup). Never invent facts absent from the data. Distinguish estimates from facts and never guarantee outcomes.`;

// Used when no league data is shared: general advice only, and never pretend to know the user's roster, league or standings.
const SYSTEM_GENERAL = `You are ProGM, an expert fantasy sports general manager. No league, roster or standings data has been shared with you, so give general fantasy advice and reason only from what the user writes in the conversation. Never claim to know the user's roster, team, league settings, standings or opponents; when a recommendation depends on them, ask the user to describe the players or situation. Default to a concise, mobile-friendly answer: lead with the recommendation, use at most 3 short bullets when useful, and normally stay under 90 words. Avoid introductions, repeated context and generic disclaimers. Distinguish estimates from facts and never guarantee outcomes.`;

/** The exact league text placed in the request. The "See what was sent" preview shows this very string. */
export function renderLeagueContext(leagueContext) {
  return leagueContext == null ? null : JSON.stringify(leagueContext).slice(0, 60000);
}

/** Pure: the exact request body sent to the AI provider. Exported so tests can inspect precisely what leaves the server. */
export function buildGeminiRequest({ messages, leagueContext }) {
  const rendered = renderLeagueContext(leagueContext);
  const hasContext = rendered != null;
  const system = hasContext ? SYSTEM_WITH_LEAGUE : SYSTEM_GENERAL;
  const opening = hasContext ? `${system}\n\nUSER-APPROVED LEAGUE SUMMARY:\n${rendered}` : system;
  const ack = hasContext ? 'Understood. I will use this league summary and conversation to provide specific fantasy advice.' : 'Understood. I will give general fantasy advice and ask for details I do not have.';
  const contents = [
    { role: 'user', parts: [{ text: opening }] },
    { role: 'model', parts: [{ text: ack }] },
    ...messages.map((message) => ({ role: message.role === 'gm' ? 'model' : 'user', parts: [{ text: String(message.text).slice(0, 1200) }] })),
  ];
  return { contents, generationConfig: { temperature: 0.35, maxOutputTokens: 450 } };
}

const selectorsFrom = (body) => ({ leagueKey: typeof body?.leagueKey === 'string' ? body.leagueKey : null, teamKey: typeof body?.teamKey === 'string' ? body.teamKey : null });
const objectBody = (body) => body != null && typeof body === 'object' && !Array.isArray(body);

/** Validate ALL entries, including history we will discard. Only the latest user message is trusted as new user input. */
export function validChatBody(body) {
  return objectBody(body) && Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 10
    && body.messages.every((m) => objectBody(m) && Object.keys(m).every((k) => ['role', 'text'].includes(k))
      && ['user', 'gm'].includes(m.role) && typeof m.text === 'string' && m.text.length <= (m.role === 'user' ? 800 : 12_000))
    && body.messages.at(-1).role === 'user' && body.messages.at(-1).text.trim().length > 0
    && (body.historyToken == null || (typeof body.historyToken === 'string' && body.historyToken.length <= MAX_HISTORY_TOKEN_LENGTH));
}

/** express.json() runs before this router. Avoid echoing malformed raw chat bodies through Express's default error/log response. */
export function handleGmJsonError(error, req, res, next) {
  if (req.path?.startsWith('/api/gm/') && error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Send a valid JSON object.' });
  }
  return next(error);
}

/**
 * `builders`: server-side league-context builders (wired in index.js; none by default).
 * `consent`: server-side consent store (none by default, so personalization is unavailable and consent routes answer 503).
 */
export function createGmRouter({ authenticate = defaultAuthenticate, fetchImpl = (...args) => fetch(...args), env = process.env, now = Date.now, builders = DEFAULT_BUILDERS, consent = null } = {}) {
  const router = express.Router();
  const usage = new Map();
  const previewUsage = new Map();
  const history = createGeneralChatHistory({ now });

  function allowRequest(userId, store = usage, limit = MAX_REQUESTS) {
    const t = now();
    for (const [id, times] of store) if (!times.length || t - times.at(-1) >= WINDOW_MS) store.delete(id);
    const recent = (store.get(userId) || []).filter((time) => t - time < WINDOW_MS);
    if (recent.length >= limit) return false;
    recent.push(t); store.set(userId, recent); return true;
  }

  const personalizationAvailable = () => Boolean(consent) && typeof builders.yahoo_league === 'function' && sourceEnabled('yahoo_league', env);

  // ---- consent (server-recorded, revocable) -----------------------------------------------------------------------------
  router.get('/consent', authenticate, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!personalizationAvailable()) return res.json({ available: false, granted: false });
    try { return res.json({ available: true, granted: await consent.hasActiveConsent(req.userId), version: DISCLOSURE_VERSION, disclosure: DISCLOSURE }); }
    catch (error) { console.error('Consent read failed:', error.message); return res.status(500).json({ error: 'Could not read your sharing choice.' }); }
  });

  router.post('/consent', authenticate, async (req, res) => {
    if (!personalizationAvailable()) return res.status(503).json({ error: 'Personalized answers are not available right now.' });
    try {
      const ok = await consent.grant(req.userId, req.body?.version);
      if (!ok) return res.status(409).json({ error: 'The sharing text has changed. Please read it again.', version: DISCLOSURE_VERSION });
      return res.json({ granted: true, version: DISCLOSURE_VERSION });
    } catch (error) { console.error('Consent write failed:', error.message); return res.status(500).json({ error: 'Could not save your choice.' }); }
  });

  // Revoking is always allowed, even when the feature is switched off.
  router.delete('/consent', authenticate, async (req, res) => {
    if (!consent) return res.json({ granted: false });
    try { await consent.revoke(req.userId); return res.json({ granted: false }); }
    catch (error) { console.error('Consent revoke failed:', error.message); return res.status(500).json({ error: 'Could not turn sharing off. Please try again.' }); }
  });

  // ---- "See what would be sent": the same resolution as /chat, without calling the provider --------------------------------
  router.post('/context-preview', authenticate, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!objectBody(req.body) || typeof req.body.question !== 'string' || !req.body.question.trim() || req.body.question.length > 800) return res.status(400).json({ error: 'Type a question between 1 and 800 characters to preview.' });
    if (!allowRequest(req.userId, previewUsage, MAX_PREVIEWS)) return res.status(429).json({ error: 'You have reached the preview limit. Please try again in a few minutes.' });
    const question = req.body.question.trim();
    const decision = await resolveAiContext({ userId: req.userId, contextRequest: req.body?.contextRequest, question, selectors: selectorsFrom(req.body), env, builders });
    return res.json({ leagueDataShared: decision.shared, leagueDataNotice: decision.notice, leagueSections: decision.sections, leagueContextSent: decision.shared ? renderLeagueContext(decision.context) : null });
  });

  router.post('/chat', authenticate, async (req, res) => {
    // Validate before touching nested data, checking configuration, or making any external request.
    if (!validChatBody(req.body)) return res.status(400).json({ error: 'Send 1–10 valid user/GM text messages ending with a user question (1–800 characters).' });
    if (!env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI General Manager is not configured yet.' });
    if (!allowRequest(req.userId)) return res.status(429).json({ error: 'You have reached the chat limit. Please try again in a few minutes.' });
    const latest = req.body.messages.at(-1).text.trim();

    // Default-deny: the browser's league payload and labels are never read. Only a server-built, consented, allowlisted context can
    // reach the provider (services/ai/aiDataPolicy.js); contextRequest and the league/team keys are requests and lookups, not data.
    try {
      const decision = await resolveAiContext({ userId: req.userId, contextRequest: req.body.contextRequest, question: latest, selectors: selectorsFrom(req.body), env, builders });
      // Client history (including old personalized replies, forged labels and pre-hardening greetings) NEVER reaches the provider.
      // Only server-issued GENERAL receipts can supply prior turns. Context requests start afresh, even if denied or switched off.
      const previous = decision.shared || req.body.contextRequest ? [] : history.read(req.body.historyToken, req.userId);
      const messages = [...previous.slice(-8), { role: 'user', text: latest }];
      const payload = buildGeminiRequest({ messages, leagueContext: decision.context });
      const meta = { leagueDataShared: decision.shared, leagueDataNotice: decision.notice, leagueSections: decision.sections, leagueContextSent: decision.shared ? renderLeagueContext(decision.context) : null };
      const response = await fetchImpl(GEMINI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) { console.error('Gemini error:', response.status); return res.status(response.status === 429 ? 429 : 502).json({ error: response.status === 429 ? 'The free AI quota is temporarily exhausted. Please try again later.' : 'The AI service could not answer right now.' }); }
      const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text).join('').trim();
      if (!text) return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
      res.set?.('Cache-Control', 'no-store');
      const historyToken = decision.shared ? null : history.issue([...messages, { role: 'gm', text: text.slice(0, 1200) }], req.userId);
      return res.json({ message: text, ...meta, historyToken });
    } catch { console.error('GM chat error: request failed'); return res.status(502).json({ error: 'The AI service is temporarily unavailable.' }); }
  });

  return router;
}

export default createGmRouter();
