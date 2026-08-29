import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';

function leagueContext(data) {
  const slim = player => ({ name: player?.name, position: player?.position, nflTeam: player?.proTeam, owner: player?.ownerTeam || 'FA', projected: player?.projectedPoints, points: player?.fantasyPoints, expertRank: player?.proRank, injury: player?.injuryStatus, ownedPct: player?.percentOwned });
  return { sport: data.connection?.sport, league: data.connection?.leagueName, season: data.connection?.season, myTeam: data.connection?.teamName, settings: data.settings, analysis: data.analysis, needs: data.needs, roster: (data.myTeam?.roster || []).map(slim), standings: data.leagueHub?.standings, powerRankings: data.leagueHub?.powerRankings, waiverSuggestions: (data.waiverSuggestions || []).slice(0, 12).map(move => ({ add: slim(move), drop: slim(move.drop), projectedGain: move.netGain, overallBefore: move.overallBefore, overallAfter: move.overallAfter })), tradeSuggestions: (data.suggestions || []).slice(0, 10).map(trade => ({ opponent: trade.opponentTeam, send: trade.send.map(slim), receive: trade.receive.map(slim), sentValue: trade.sentValue, receivedValue: trade.receivedValue, valueGapPct: trade.valueDifferencePercent, overallBefore: trade.overallBefore, overallAfter: trade.overallAfter, reasoning: trade.reasoning })), playerPool: (data.players || []).map(slim), draftAvailable: data.draftAvailable };
}

export default function AIManager({ data }) {
  const key = `progm-chat-${data.connection?.leagueId || data.connection?.leagueName || 'league'}`;
  const initial = useMemo(() => ({ role: 'gm', text: `I’m your AI General Manager for ${data.connection?.teamName}. I can reason through trades, waivers, lineups, players, standings, and draft strategy using your synced league. What move are you considering?` }), [data.connection?.teamName]);
  const [messages, setMessages] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || [initial]; } catch { return [initial]; } });
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [error, setError] = useState(''); const endRef = useRef(null);
  useEffect(() => { localStorage.setItem(key, JSON.stringify(messages.slice(-30))); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, key]);
  async function send(value = text) {
    const clean = value.trim().slice(0, 800); if (!clean || sending) return;
    const next = [...messages, { role: 'user', text: clean }]; setMessages(next); setText(''); setError(''); setSending(true);
    try { const response = await api.post('/gm/chat', { messages: next.slice(-10), league: leagueContext(data) }); setMessages(items => [...items, { role: 'gm', text: response.data.message }]); }
    catch (err) { setError(err.response?.data?.error || 'The AI General Manager could not respond.'); }
    finally { setSending(false); }
  }
  const prompts = ['Analyze my biggest weakness', 'Find my best waiver move', 'Suggest a realistic trade', 'Help set my lineup'];
  return <div className="mx-auto max-w-4xl space-y-4">
    <section className="overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-r from-primary-900/40 to-dark-800 p-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">Gemini-powered league assistant</p><h2 className="mt-2 text-3xl font-black">AI General Manager</h2><p className="mt-2 max-w-2xl text-dark-300">Have a real conversation about your lineup, trades, waivers, players, standings, and draft using your current synced league data.</p></section>
    <section className="card p-0 sm:p-0"><div className="flex items-center justify-between border-b border-dark-700 px-4 py-3 sm:px-6"><div><p className="font-bold">ProGM Assistant</p><p className="text-xs text-green-400">● Gemini connected · {data.connection?.leagueName}</p></div><button className="text-sm text-dark-400 hover:text-white" onClick={() => { setMessages([initial]); setError(''); }}>Clear chat</button></div>
      <div className="h-[52vh] min-h-[360px] space-y-4 overflow-y-auto p-4 sm:p-6">{messages.map((message, index) => <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[78%] ${message.role === 'user' ? 'rounded-br-sm bg-primary-600 text-white' : 'rounded-bl-sm border border-dark-700 bg-dark-900 text-dark-200'}`}>{message.text}</div></div>)}{sending && <div className="flex justify-start"><div className="animate-pulse rounded-2xl rounded-bl-sm border border-dark-700 bg-dark-900 px-4 py-3 text-sm text-primary-400">Thinking through your league data…</div></div>}{error && <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}<div ref={endRef} /></div>
      <div className="border-t border-dark-700 p-4 sm:p-5"><div className="mb-3 flex gap-2 overflow-x-auto">{prompts.map(prompt => <button key={prompt} disabled={sending} onClick={() => send(prompt)} className="whitespace-nowrap rounded-full border border-dark-600 bg-dark-900 px-3 py-1.5 text-xs text-dark-300 hover:border-primary-500 hover:text-white">{prompt}</button>)}</div><form onSubmit={event => { event.preventDefault(); send(); }} className="flex gap-2"><input className="input-field" value={text} maxLength={800} onChange={event => setText(event.target.value)} placeholder="Ask a follow-up or describe a move…" aria-label="Message your AI General Manager" /><button className="btn-primary shrink-0 disabled:opacity-50" type="submit" disabled={!text.trim() || sending}>{sending ? 'Thinking…' : 'Send'}</button></form><p className="mt-2 text-xs text-dark-500">League context and messages are sent to Google Gemini’s free API to generate answers. Advice is not a guaranteed outcome.</p></div>
    </section>
  </div>;
}
