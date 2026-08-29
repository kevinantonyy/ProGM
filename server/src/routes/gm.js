import express from 'express';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const usage = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

function allowRequest(userId) {
  const now = Date.now();
  const recent = (usage.get(userId) || []).filter(time => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) return false;
  recent.push(now); usage.set(userId, recent); return true;
}

router.post('/chat', authenticate, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI General Manager is not configured yet.' });
  if (!allowRequest(req.userId)) return res.status(429).json({ error: 'You have reached the chat limit. Please try again in a few minutes.' });
  const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-10) : [];
  const latest = messages.at(-1)?.text?.trim();
  if (!latest || latest.length > 800) return res.status(400).json({ error: 'Enter a message between 1 and 800 characters.' });
  const system = `You are ProGM, an expert fantasy sports general manager. Give direct, conversational, evidence-based advice using the supplied synced league data. Discuss trades, waivers, start/sit decisions, rankings, standings, roster construction, draft strategy, and players. Remember the conversation. Never invent live news, stats, players, or league facts absent from the data. Clearly distinguish estimates from facts. If data is missing, say so. Be concise but explain the numbers. Never guarantee outcomes.`;
  const context = JSON.stringify(req.body.league || {}).slice(0, 60000);
  const contents = [{ role: 'user', parts: [{ text: `${system}\n\nCURRENT SYNCED LEAGUE DATA:\n${context}` }] }, { role: 'model', parts: [{ text: 'Understood. I will use this league data and conversation to provide specific fantasy advice.' }] }, ...messages.map(message => ({ role: message.role === 'gm' ? 'model' : 'user', parts: [{ text: String(message.text).slice(0, 1200) }] }))];
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify({ contents, generationConfig: { temperature: 0.45, maxOutputTokens: 700 } }) });
    const result = await response.json();
    if (!response.ok) { console.error('Gemini error:', response.status, result?.error?.message); return res.status(response.status === 429 ? 429 : 502).json({ error: response.status === 429 ? 'The free AI quota is temporarily exhausted. Please try again later.' : 'The AI service could not answer right now.' }); }
    const text = result.candidates?.[0]?.content?.parts?.map(part => part.text).join('').trim();
    if (!text) return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
    return res.json({ message: text });
  } catch (error) { console.error('GM chat error:', error.message); return res.status(502).json({ error: 'The AI service is temporarily unavailable.' }); }
});

export default router;
