import { useEffect, useMemo, useRef, useState } from 'react';

const STARTERS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];

function points(player) { return Number(player?.projectedPoints || 0).toFixed(1); }
function names(players = [], limit = 4) { return players.slice(0, limit).map(player => `${player.name} (${points(player)} projected)`).join(', '); }

function answerQuestion(question, data) {
  const q = question.toLowerCase();
  const roster = data.myTeam?.roster || [];
  const available = (data.availablePlayers || data.players || []).filter(player => !player.ownerTeam);
  const standings = data.leagueHub?.standings || [];
  const team = standings.find(item => item.name === data.connection?.teamName);
  const player = [...roster, ...(data.players || [])].find(item => q.includes(item.name.toLowerCase()));

  if (player) {
    const ownership = player.ownerTeam ? `rostered by ${player.ownerTeam}` : 'available in your league';
    return `${player.name} is a ${player.position} who is ${ownership}. ProGM has ${points(player)} projected points, ${Number(player.fantasyPoints || 0).toFixed(1)} points scored, and an expert rank of ${player.proRank ? `#${player.proRank}` : 'not available'}. ${player.injuryStatus && player.injuryStatus !== 'ACTIVE' ? `Injury status: ${player.injuryStatus}.` : 'No active injury concern is shown.'}`;
  }
  if (/waiver|pickup|pick up|free agent|drop/.test(q)) {
    const moves = data.waiverSuggestions || [];
    if (!moves.length) return 'I do not see a waiver move that clearly improves your projected roster right now. Refresh ESPN data after waivers process and I’ll check again.';
    return `My top waiver move is add ${moves[0].name} and drop ${moves[0].drop.name}. That projects a +${Number(moves[0].netGain).toFixed(1)} point gain and changes your team OVR from ${moves[0].overallBefore} to ${moves[0].overallAfter}. Other options: ${moves.slice(1, 4).map(move => `${move.name} for ${move.drop.name} (+${Number(move.netGain).toFixed(1)})`).join('; ') || 'none with a positive gain'}.`;
  }
  if (/trade|deal|package/.test(q)) {
    const trades = data.suggestions || [];
    if (!trades.length) return 'I do not currently see a realistic balanced package within ProGM’s fair-value range. Try selecting players in the Trade Builder and use Suggest a Trade.';
    const trade = trades[0];
    return `Best balanced idea: send ${trade.send.map(p => p.name).join(' + ')} and receive ${trade.receive.map(p => p.name).join(' + ')} from ${trade.opponentTeam}. The values are ${trade.sentValue} versus ${trade.receivedValue} (${trade.valueDifferencePercent}% gap), with your OVR moving ${trade.overallBefore} → ${trade.overallAfter}. ${trade.reasoning}`;
  }
  if (/start|sit|lineup|bench/.test(q)) {
    const starters = roster.filter(player => STARTERS.includes(player.position)).sort((a, b) => b.projectedPoints - a.projectedPoints);
    const injured = roster.filter(player => player.injuryStatus && !['ACTIVE', 'NORMAL'].includes(player.injuryStatus));
    return `${injured.length ? `First, monitor ${injured.map(p => `${p.name} (${p.injuryStatus})`).join(', ')}. ` : ''}Your highest projected options are ${names(starters, 6) || names(roster.sort((a, b) => b.projectedPoints - a.projectedPoints), 6)}. For position-by-position swaps, open Start / Sit; it checks your actual lineup slots and explains every positive upgrade.`;
  }
  if (/standing|record|rank|power/.test(q)) {
    if (!team) return 'I can analyze standings after the league data finishes syncing.';
    const rank = standings.findIndex(item => item.id === team.id) + 1;
    return `You are #${rank} of ${standings.length} at ${team.wins}-${team.losses}${team.ties ? `-${team.ties}` : ''}, with ${Number(team.pointsFor || 0).toFixed(1)} points scored and a ${team.overall}/99 team OVR. ${rank <= standings.length / 2 ? 'You are currently in the upper half of the league.' : 'Waiver upgrades and balanced trades are your clearest paths upward.'}`;
  }
  if (/roster|team|strength|weak|need/.test(q)) {
    const best = [...roster].sort((a, b) => b.projectedPoints - a.projectedPoints);
    return `Your roster has ${roster.length} players and ${Number(data.analysis?.totalProjected || 0).toFixed(1)} total projected points. Your strongest projected players are ${names(best, 5)}. ProGM flags these needs: ${(data.needs || []).slice(0, 5).join(', ') || 'no major positional weakness detected'}.`;
  }
  if (/draft/.test(q)) {
    return data.draftAvailable ? `Your league has not finished drafting. Open Draft Helper for a live board personalized to ${data.settings?.scoringType || 'your scoring'} and the picks already made.` : 'Your league has already drafted, so live Draft Help is inactive for this season. I can still help with trades, waivers, lineups, and rankings.';
  }
  if (/best|top|recommend|what should|help/.test(q)) {
    const move = data.waiverSuggestions?.[0];
    const trade = data.suggestions?.[0];
    return `Here’s my GM checklist: ${move ? `consider adding ${move.name} for ${move.drop.name} (+${Number(move.netGain).toFixed(1)} projected points); ` : 'your waiver board has no clear positive upgrade; '}${trade ? `review the balanced package with ${trade.opponentTeam}; ` : 'build a custom trade package; '}and verify your lineup in Start / Sit. Ask me about a player, trade, waiver, lineup, roster, standings, or draft for a more specific answer.`;
  }
  return `I can help with your real ${data.connection?.leagueName || 'synced league'} data. Try “Who should I pick up?”, “Suggest a trade”, “How strong is my team?”, “Who should I start?”, or ask about a player by name.`;
}

export default function AIManager({ data }) {
  const key = `progm-chat-${data.connection?.leagueId || data.connection?.leagueName || 'league'}`;
  const initial = useMemo(() => ({ role: 'gm', text: `I’m your ProGM assistant for ${data.connection?.teamName}. I use your synced league settings, roster, projections, standings, trade values, and waiver pool. What move are you considering?` }), [data.connection?.teamName]);
  const [messages, setMessages] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || [initial]; } catch { return [initial]; } });
  const [text, setText] = useState('');
  const endRef = useRef(null);
  useEffect(() => { localStorage.setItem(key, JSON.stringify(messages.slice(-30))); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, key]);
  function send(value = text) {
    const clean = value.trim().slice(0, 500);
    if (!clean) return;
    setMessages(items => [...items, { role: 'user', text: clean }, { role: 'gm', text: answerQuestion(clean, data) }]);
    setText('');
  }
  const prompts = ['Who should I pick up?', 'Suggest a trade', 'How strong is my team?', 'Who should I start?'];
  return <div className="mx-auto max-w-4xl space-y-4">
    <section className="overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-r from-primary-900/40 to-dark-800 p-6"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-400">League-aware assistant</p><h2 className="mt-2 text-3xl font-black">AI General Manager</h2><p className="mt-2 max-w-2xl text-dark-300">Chat about your lineup, trades, waivers, players, standings, and draft. Answers are generated from your current ProGM league analysis at no added cost.</p></section>
    <section className="card p-0 sm:p-0"><div className="flex items-center justify-between border-b border-dark-700 px-4 py-3 sm:px-6"><div><p className="font-bold">ProGM Assistant</p><p className="text-xs text-green-400">● Ready · {data.connection?.leagueName}</p></div><button className="text-sm text-dark-400 hover:text-white" onClick={() => setMessages([initial])}>Clear chat</button></div>
      <div className="h-[52vh] min-h-[360px] space-y-4 overflow-y-auto p-4 sm:p-6">{messages.map((message, index) => <div key={index} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[75%] ${message.role === 'user' ? 'rounded-br-sm bg-primary-600 text-white' : 'rounded-bl-sm border border-dark-700 bg-dark-900 text-dark-200'}`}>{message.text}</div></div>)}<div ref={endRef} /></div>
      <div className="border-t border-dark-700 p-4 sm:p-5"><div className="mb-3 flex gap-2 overflow-x-auto">{prompts.map(prompt => <button key={prompt} onClick={() => send(prompt)} className="whitespace-nowrap rounded-full border border-dark-600 bg-dark-900 px-3 py-1.5 text-xs text-dark-300 hover:border-primary-500 hover:text-white">{prompt}</button>)}</div><form onSubmit={event => { event.preventDefault(); send(); }} className="flex gap-2"><input className="input-field" value={text} maxLength={500} onChange={event => setText(event.target.value)} placeholder="Ask your GM anything…" aria-label="Message your AI General Manager" /><button className="btn-primary shrink-0" type="submit" disabled={!text.trim()}>Send</button></form><p className="mt-2 text-xs text-dark-500">ProGM estimates are decision support, not guaranteed outcomes.</p></div>
    </section>
  </div>;
}
