import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { footballChatPayload, ESPN_AI_INTRO, ESPN_AI_SUBTITLE } from '../utils/aiSharing';

export default function AIManager({ data }) {
  const initial = { role: 'gm', text: ESPN_AI_INTRO };
  // Do not restore legacy league-keyed localStorage chats: they may contain identifiers and old personalized answers.
  // Existing saved data is not deleted. This session's visible history stays in memory; only verified GENERAL receipts are replayable.
  const [messages, setMessages] = useState([initial]);
  const [historyToken, setHistoryToken] = useState(null);
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [error, setError] = useState(''); const endRef = useRef(null);
  useEffect(() => { if (messages.length === 1) setHistoryToken(null); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { setMessages([{ role: 'gm', text: ESPN_AI_INTRO }]); setHistoryToken(null); }, [data.connection?.leagueId]);
  async function send(value = text) {
    const clean = value.trim().slice(0, 800); if (!clean || sending) return;
    const next = [...messages, { role: 'user', text: clean }]; setMessages(next); setText(''); setError(''); setSending(true);
    try { const response = await api.post('/gm/chat', footballChatPayload(next, historyToken)); setHistoryToken(response.data.historyToken || null); setMessages(items => [...items, { role: 'gm', text: response.data.message }]); }
    catch (err) { setError(err.response?.data?.error || 'The AI General Manager could not respond.'); }
    finally { setSending(false); }
  }
  const prompts = ['How do I value a flex spot?', 'When should I stash a handcuff?', 'How do I judge a fair trade?', 'Bye-week strategy tips'];
  return <div className="mx-auto max-w-4xl space-y-4">
    <section className="overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-r from-primary-900/40 to-dark-800 p-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">Gemini-powered league assistant</p><h2 className="mt-2 text-3xl font-black">Ask ProGM</h2><p className="mt-2 max-w-2xl text-dark-300">{ESPN_AI_SUBTITLE}</p></section>
    <section className="card p-0 sm:p-0"><div className="flex items-center justify-between border-b border-dark-700 px-4 py-3 sm:px-6"><div><p className="font-bold">ProGM Assistant</p><p className="text-xs text-green-400">● Gemini connected · {data.connection?.leagueName}</p></div><button className="text-sm text-dark-400 hover:text-white" onClick={() => { setMessages([initial]); setError(''); }}>Clear chat</button></div>
      <div className="h-[52vh] min-h-[360px] space-y-4 overflow-y-auto p-4 sm:p-6">{messages.map((message, index) => <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[78%] ${message.role === 'user' ? 'rounded-br-sm bg-primary-600 text-white' : 'rounded-bl-sm border border-dark-700 bg-dark-900 text-dark-200'}`}>{message.text}</div></div>)}{sending && <div className="flex justify-start"><div className="animate-pulse rounded-2xl rounded-bl-sm border border-dark-700 bg-dark-900 px-4 py-3 text-sm text-primary-400">Thinking…</div></div>}{error && <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}<div ref={endRef} /></div>
      <div className="border-t border-dark-700 p-4 sm:p-5"><div className="mb-3 flex gap-2 overflow-x-auto">{prompts.map(prompt => <button key={prompt} disabled={sending} onClick={() => send(prompt)} className="whitespace-nowrap rounded-full border border-dark-600 bg-dark-900 px-3 py-1.5 text-xs text-dark-300 hover:border-primary-500 hover:text-white">{prompt}</button>)}</div><form onSubmit={event => { event.preventDefault(); send(); }} className="flex gap-2"><input className="input-field" value={text} maxLength={800} onChange={event => setText(event.target.value)} placeholder="Ask a follow-up or describe a move…" aria-label="Message your AI General Manager" /><button className="btn-primary shrink-0 disabled:opacity-50" type="submit" disabled={!text.trim() || sending}>{sending ? 'Thinking…' : 'Send'}</button></form><p className="mt-2 text-xs text-dark-500">Your question and verified general-chat history are sent to Google Gemini. No synced ESPN league data is attached. Earlier saved chats are not restored. Advice is not a guaranteed outcome.</p></div>
    </section>
  </div>;
}
