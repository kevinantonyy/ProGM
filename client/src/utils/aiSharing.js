// What the "Ask ProGM" chats send to the AI provider.
//
// General chat sends the latest typed question and an optional server-issued general-only history receipt. Basketball can ALSO be personalized after
// reading a disclosure; the browser then sends only a request (contextRequest) and the league/team keys. The browser NEVER sends league
// data and NEVER sends a label about where data came from: the server builds the league summary itself from the user's own cached
// workspace, after checking the server switch and the user's recorded consent (server/src/services/ai/*).
//
// Football (ESPN) league data is not shared at all, pending a separate review.

export const YAHOO_AI_SUBTITLE = 'General fantasy basketball help. Your Yahoo league data is not shared with the AI provider.';
export const YAHOO_AI_INTRO = 'Ask general fantasy basketball questions. To keep your Yahoo league private, ProGM does not send your roster or league to the AI unless you turn on personalization, so describe the players or situation you want help with.';
export const YAHOO_AI_PERSONAL_SUBTITLE = 'Personalized: a small summary of your Yahoo league is sent to Google Gemini when you ask a league question.';
export const YAHOO_AI_PERSONAL_INTRO = 'Personalization is on. Ask about your lineup, waivers, trades or standings. I only receive the parts of your league that your question needs.';
export const YAHOO_AI_UNAVAILABLE = 'Personalized answers are not available right now. Ask ProGM gives general advice.';

export const ESPN_AI_SUBTITLE = 'General fantasy football help. Your ESPN league data is not shared with the AI provider.';
export const ESPN_AI_INTRO = 'Ask general fantasy football questions. To keep your ESPN league private, ProGM does not send your roster or league to the AI, so describe the players or situation you want help with.';

// The visible transcript is display-only. Never replay old greetings or personalized replies, including legacy saved conversations.
const currentQuestion = (messages) => {
  const latest = Array.isArray(messages) ? messages.at(-1) : null;
  return latest?.role === 'user' && typeof latest.text === 'string' ? [{ role: 'user', text: latest.text }] : [];
};

/** Request body for POST /gm/chat without personalization: current question and optional verified general history. */
export function chatPayload(messages, historyToken) {
  return { messages: currentQuestion(messages), ...(typeof historyToken === 'string' ? { historyToken } : {}) };
}
export const basketballChatPayload = chatPayload;
export const footballChatPayload = chatPayload;

/** Personalized basketball chat: still no league data, only the request and the two keys the server uses to find the user's own cache entry. */
export function personalizedChatPayload(messages, { leagueKey, teamKey }) {
  return { messages: currentQuestion(messages), contextRequest: 'yahoo_league', leagueKey: leagueKey || null, teamKey: teamKey || null };
}

export const QUICK_QUESTIONS = ['Who should I start?', 'Best waiver pickups?', 'Any good trades for me?', 'What is my weakest position?'];

const SECTION_LABEL = { lineup: 'lineup', waivers: 'waivers', trades: 'trades', standings: 'standings', draft: 'draft board', roster: 'roster' };

/** The label under each answer, so general advice and league-based answers cannot be confused. */
export function answerTag(meta) {
  if (!meta?.shared) return 'General advice · no league data sent';
  const parts = (meta.sections || []).filter((s) => s !== 'overview').map((s) => SECTION_LABEL[s] || s);
  return `Used your league: ${parts.length ? parts.join(', ') : 'scoring settings and team rating'} · sent to Google Gemini`;
}
