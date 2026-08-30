import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PlayerButton } from './EntityModal';
import api from '../services/api';
import { leagueContext } from './AIManager';

function tradeValue(player) {
  return Math.max(1, Number(player.projectedPoints) || 0) + Math.max(0, Number(player.percentOwned) || 0) * 0.12 + (player.proRank ? Math.max(0, 100 - player.proRank) * 0.08 : 0);
}

const MINIMUM_POSITION_COUNTS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, 'D/ST': 1 };

function rosterCuts(roster, tradedAway, extraIncoming, incoming = []) {
  if (extraIncoming <= 0) return [];
  const tradedIds = new Set(tradedAway.map(player => player.id));
  const remaining = roster.filter(player => !tradedIds.has(player.id));
  const counts = [...remaining, ...incoming].reduce((result, player) => ({ ...result, [player.position]: (result[player.position] || 0) + 1 }), {});
  const cuts = [];
  for (const player of remaining.slice().sort((a, b) => tradeValue(a) - tradeValue(b))) {
    if (cuts.length === extraIncoming) break;
    if ((counts[player.position] || 0) <= (MINIMUM_POSITION_COUNTS[player.position] || 0)) continue;
    cuts.push(player);
    counts[player.position] -= 1;
  }
  return cuts;
}

function rosterSpotCost(roster, tradedAway, extraIncoming, incoming = []) {
  return rosterCuts(roster, tradedAway, extraIncoming, incoming).reduce((total, player) => total + tradeValue(player), 0);
}

function possiblePackages(players, maxSize = 3) {
  const results = [];
  function build(start, current) {
    if (current.length) results.push([...current]);
    if (current.length === maxSize) return;
    for (let index = start; index < players.length; index += 1) build(index + 1, [...current, players[index]]);
  }
  build(0, []);
  return results;
}

function PlayerOption({ player, selected, onToggle }) {
  return <label className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition ${selected ? 'border-primary-500 bg-primary-600/10' : 'border-dark-700 bg-dark-900 hover:border-dark-600'}`}><div className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 accent-blue-500" /><div className="min-w-0"><PlayerButton player={player} className="block max-w-full truncate text-sm">{player.name}</PlayerButton><p className="text-xs text-dark-400">{player.position} · {player.projectedPoints.toFixed(1)} pts · {player.percentOwned.toFixed(1)}% owned</p></div></div><span className="shrink-0 text-sm font-bold text-primary-400">{tradeValue(player).toFixed(1)}</span></label>;
}

export default function TradeBuilder({ data }) {
  const [params] = useSearchParams();
  const [opponent, setOpponent] = useState(params.get('opponent') || data.opponents[0]?.name || '');
  const [sendIds, setSendIds] = useState(params.get('send') ? [Number(params.get('send'))] : []);
  const [receiveIds, setReceiveIds] = useState(params.get('receive') ? [Number(params.get('receive'))] : []);
  const [suggestionMessage, setSuggestionMessage] = useState('');
  const [managerInput, setManagerInput] = useState('');
  const [negotiation, setNegotiation] = useState('');
  const [negotiating, setNegotiating] = useState(false);
  const opponentPlayers = useMemo(() => data.players.filter(player => player.ownerTeam === opponent), [data.players, opponent]);
  const send = data.myTeam.roster.filter(player => sendIds.includes(player.id));
  const receive = opponentPlayers.filter(player => receiveIds.includes(player.id));
  const sentPoints = send.reduce((total, player) => total + player.projectedPoints, 0);
  const receivedPoints = receive.reduce((total, player) => total + player.projectedPoints, 0);
  const sentValue = send.reduce((total, player) => total + tradeValue(player), 0);
  const receivedValue = receive.reduce((total, player) => total + tradeValue(player), 0);
  const requiredUserCuts = Math.max(0, receive.length - send.length);
  const userCuts = rosterCuts(data.myTeam.roster, send, requiredUserCuts, receive);
  const userRosterCost = userCuts.reduce((total, player) => total + tradeValue(player), 0);
  const opponentRosterCost = rosterSpotCost(opponentPlayers, receive, send.length - receive.length, send);
  const adjustedReceivedValue = receivedValue - userRosterCost;
  const adjustedSentValue = sentValue - opponentRosterCost;
  const valueDelta = adjustedReceivedValue - adjustedSentValue;
  const droppedPoints = userCuts.reduce((total, player) => total + player.projectedPoints, 0);
  const pointDelta = receivedPoints - sentPoints - droppedPoints;
  const overallAfter = Math.max(0, Math.min(99, Math.round((data.rating.rosterValue - sentValue + receivedValue - userRosterCost) / data.rating.maxTeamValue * 99)));
  const overallChange = overallAfter - data.rating.overall;
  const gap = send.length && receive.length ? Math.abs(valueDelta) / Math.max(adjustedSentValue, adjustedReceivedValue, 1) * 100 : 0;
  const baseVerdict = !send.length || !receive.length ? null : userCuts.length < requiredUserCuts ? 'Invalid roster' : gap <= 7.5 ? 'Fair trade' : valueDelta > 0 ? 'You are winning' : 'You are losing';
  const verdict = baseVerdict && userCuts.length ? `${baseVerdict} · Drop ${userCuts.map(player => player.name).join(' + ')}` : baseVerdict;
  const verdictClass = baseVerdict === 'Fair trade' ? 'text-blue-400' : baseVerdict === 'You are winning' ? 'text-green-400' : 'text-red-400';
  const opponentTeam = data.opponents.find(team => team.name === opponent);
  const espnTradeUrl = `https://fantasy.espn.com/${data.connection.sport}/team?leagueId=${encodeURIComponent(data.connection.leagueId)}&teamId=${encodeURIComponent(opponentTeam?.id || '')}&seasonId=${encodeURIComponent(data.connection.season)}`;
  function toggle(id, setter) { setter(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
  function suggestTrade() {
    if (receive.length) {
      const rankedOutgoing = possiblePackages(data.myTeam.roster, 3).map(players => { const neededCuts = Math.max(0, receive.length - players.length); const cuts = rosterCuts(data.myTeam.roster, players, neededCuts, receive); const valid = cuts.length === neededCuts; const value = players.reduce((total, player) => total + tradeValue(player), 0) - rosterSpotCost(opponentPlayers, receive, players.length - receive.length, players); const rosterCost = cuts.reduce((total, player) => total + tradeValue(player), 0); const returnValue = receivedValue - rosterCost; const gapPercent = Math.abs(value - returnValue) / Math.max(value, returnValue, 1) * 100; return { players, gapPercent, rosterCost, valid, score: gapPercent + Math.max(0, receive.length - players.length) * 2 + (valid ? 0 : 10000) }; }).sort((a, b) => a.score - b.score);
      const bestOutgoing = rankedOutgoing[0];
      if (!bestOutgoing.valid) { setSuggestionMessage('No valid package was found without leaving a required lineup position empty. Try another target.'); return; }
      if (bestOutgoing.gapPercent > 7.5) { setSuggestionMessage(`No fair offer was found for ${receive.map(player => player.name).join(' + ')} within the 7.5% value range. Try another target or add a player.`); return; }
      setSendIds(bestOutgoing.players.map(player => player.id));
      const cuts = rosterCuts(data.myTeam.roster, bestOutgoing.players, receive.length - bestOutgoing.players.length, receive);
      setSuggestionMessage(`ProGM found a realistic offer for ${receive.map(player => player.name).join(' + ')}.${cuts.length ? ` You would need to drop ${cuts.map(player => player.name).join(' + ')}; that cost is included in the grade.` : ''}`);
      return;
    }
    if (!send.length) { setSuggestionMessage('Select player(s) on either side first.'); return; }
    if (!opponentPlayers.length) { setSuggestionMessage('This manager does not have a synced roster to build from.'); return; }
    const targetValue = sentValue;
    const needs = data.needs?.slice(0, 3) || [];
    const ranked = possiblePackages(opponentPlayers, 3).map(players => {
      const neededCuts = Math.max(0, players.length - send.length);
      const cuts = rosterCuts(data.myTeam.roster, send, neededCuts, players);
      const valid = cuts.length === neededCuts;
      const value = players.reduce((total, player) => total + tradeValue(player), 0) - cuts.reduce((total, player) => total + tradeValue(player), 0);
      const offerValue = targetValue - rosterSpotCost(opponentPlayers, players, send.length - players.length, send);
      const gapPercent = Math.abs(value - offerValue) / Math.max(value, offerValue, 1) * 100;
      const needMatches = players.filter(player => needs.includes(player.position)).length;
      const rosterCost = cuts.reduce((total, player) => total + tradeValue(player), 0);
      return { players, gapPercent, rosterCost, valid, score: gapPercent - needMatches * 0.35 + Math.max(0, players.length - send.length) * 2 + (valid ? 0 : 10000) };
    }).sort((a, b) => a.score - b.score);
    const best = ranked[0];
    if (!best.valid) { setSuggestionMessage('No valid return was found without leaving a required lineup position empty. Try another player or trade partner.'); return; }
    if (best.gapPercent > 7.5) { setSuggestionMessage(`No fair return was found from ${opponent} within the 7.5% value range. Try a different player or trade partner.`); return; }
    setReceiveIds(best.players.map(player => player.id));
    const cuts = rosterCuts(data.myTeam.roster, send, best.players.length - send.length, best.players);
    setSuggestionMessage(`ProGM found a realistic return from ${opponent}.${cuts.length ? ` You would need to drop ${cuts.map(player => player.name).join(' + ')}; that cost is included in the grade.` : ''}`);
  }
  async function negotiate() {
    if (!send.length || !receive.length || !managerInput.trim()) return;
    setNegotiating(true); setNegotiation('');
    try {
      const candidateNames = (players, selected, targetValue) => [...selected, ...players.slice().sort((a, b) => Math.abs(tradeValue(a) - targetValue) - Math.abs(tradeValue(b) - targetValue))].filter((player, index, list) => list.findIndex(item => item.id === player.id) === index).slice(0, 3).map(player => player.name).join(', ');
      const outgoingCandidates = candidateNames(data.myTeam.roster, send, receivedValue);
      const incomingCandidates = candidateNames(opponentPlayers, receive, sentValue);
      const concerns = managerInput.trim().slice(0, 100);
      const packageNames = players => `${players.slice(0, 4).map(player => player.name).join(', ')}${players.length > 4 ? ` + ${players.length - 4} more` : ''}`;
      const prompt = `Negotiate: send [${packageNames(send)}]; receive [${packageNames(receive)}] from ${opponent}. ProGM grade: ${baseVerdict}; adjusted value ${adjustedSentValue.toFixed(1)} out vs ${adjustedReceivedValue.toFixed(1)} in${userCuts.length ? ` after dropping ${userCuts.map(player => player.name).join(', ')}` : ''}. Priorities: ${concerns}. Explain consistently with these roster-adjusted numbers; if asked why it wins, explain the advantage instead of reversing the grade. Counteroffers use exact names only. SEND: ${outgoingCandidates}. RECEIVE: ${incomingCandidates}. End: COUNTER: SEND names | RECEIVE names; or COUNTER: NONE.`;
      const response = await api.post('/gm/chat', { messages: [{ role: 'user', text: prompt }], league: leagueContext(data) });
      const message = response.data.message || '';
      const counter = message.match(/COUNTER:\s*SEND\s*(.*?)\s*\|\s*RECEIVE\s*(.*?)(?:\n|$)/i);
      const explanation = message.replace(/\n?\s*COUNTER:\s*(?:SEND\s*.*?\s*\|\s*RECEIVE\s*.*?|NONE)\s*$/i, '').trim();
      setNegotiation(explanation || message);
      if (counter) {
        const parseNames = value => value.split(/,|\+/).map(name => name.trim().toLowerCase()).filter(Boolean);
        const outgoingNames = parseNames(counter[1]);
        const incomingNames = parseNames(counter[2]);
        const outgoing = data.myTeam.roster.filter(player => outgoingNames.includes(player.name.trim().toLowerCase()));
        const incoming = opponentPlayers.filter(player => incomingNames.includes(player.name.trim().toLowerCase()));
        if (outgoing.length === outgoingNames.length && incoming.length === incomingNames.length && outgoing.length && incoming.length) {
          setSendIds(outgoing.map(player => player.id));
          setReceiveIds(incoming.map(player => player.id));
          setSuggestionMessage('Ask ProGM applied its counteroffer below.');
        }
      }
    }
    catch (err) { setNegotiation(err.response?.data?.error || 'Ask ProGM could not negotiate this package right now.'); }
    finally { setNegotiating(false); }
  }
  return <section className="card border-primary-500/30"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary-400">Trade details</p><h2 className="mt-1 text-2xl font-bold">Build and balance your own trade</h2><p className="mt-2 text-sm text-dark-400">Select players on both sides. ProGM compares league projections, ownership, expert rank, and combined package value.</p></div><div className="mt-5 grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-green-800/40 bg-green-950/10 p-4"><h3 className="font-bold text-green-400">Buy-low targets</h3><div className="mt-2 space-y-2">{data.tradeTargets?.buyLow?.slice(0, 4).map(player => <button type="button" key={player.id} onClick={() => { setOpponent(player.ownerTeam); setReceiveIds([player.id]); }} className="flex w-full items-center justify-between rounded-lg bg-dark-900 p-3 text-left hover:bg-dark-800"><span><span className="font-semibold">{player.name}</span><span className="block text-xs text-dark-400">{player.ownerTeam} · #{player.proRank} expert</span></span><span className="badge-green">Target</span></button>)}</div></div><div className="rounded-xl border border-orange-800/40 bg-orange-950/10 p-4"><h3 className="font-bold text-orange-400">Sell-high candidates</h3><div className="mt-2 space-y-2">{data.tradeTargets?.sellHigh?.slice(0, 4).map(player => <button type="button" key={player.id} onClick={() => setSendIds([player.id])} className="flex w-full items-center justify-between rounded-lg bg-dark-900 p-3 text-left hover:bg-dark-800"><span><span className="font-semibold">{player.name}</span><span className="block text-xs text-dark-400">{player.position} · {player.percentOwned.toFixed(1)}% rostered</span></span><span className="badge-orange">Shop</span></button>)}</div></div></div>
    <div className="mt-5"><label className="text-sm text-dark-300">Trade partner</label><select value={opponent} onChange={event => { setOpponent(event.target.value); setReceiveIds([]); setSuggestionMessage(''); }} className="input-field mt-2">{data.opponents.map(team => <option key={team.id} value={team.name}>{team.name}</option>)}</select></div>
    <div className="mt-5 grid gap-5 xl:grid-cols-2"><div><div className="mb-2 flex items-center justify-between gap-3"><p className="text-sm font-bold uppercase tracking-wide text-red-400">You send</p><button type="button" onClick={() => { setSendIds([]); setSuggestionMessage(''); }} disabled={!sendIds.length} className="text-xs font-semibold text-dark-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Uncheck all</button></div><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{data.myTeam.roster.map(player => <PlayerOption key={player.id} player={player} selected={sendIds.includes(player.id)} onToggle={() => toggle(player.id, setSendIds)} />)}</div></div><div><div className="mb-2 flex items-center justify-between gap-3"><p className="text-sm font-bold uppercase tracking-wide text-green-400">You receive from {opponent}</p><button type="button" onClick={() => { setReceiveIds([]); setSuggestionMessage(''); }} disabled={!receiveIds.length} className="text-xs font-semibold text-dark-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Uncheck all</button></div><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{opponentPlayers.map(player => <PlayerOption key={player.id} player={player} selected={receiveIds.includes(player.id)} onToggle={() => toggle(player.id, setReceiveIds)} />)}</div></div></div>
    <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={suggestTrade} disabled={!send.length && !receive.length} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">✨ Suggest a trade</button><p className={`text-sm ${suggestionMessage.includes('realistic') ? 'text-green-400' : 'text-dark-400'}`}>{suggestionMessage || 'Select player(s) on either side; ProGM will build the matching package.'}</p></div>
    {send.length > 0 && receive.length > 0 && <div className="mt-6 rounded-xl border border-dark-600 bg-gradient-to-r from-red-950/20 via-dark-900 to-green-950/20 p-4">
      <p className="text-xs font-bold uppercase tracking-widest text-dark-400">Trade overview</p>
      <div className="mt-3 grid items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
        <div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-red-400">You send</p><div className="space-y-2">
          {send.map(player => <div key={player.id} className="rounded-lg border border-red-900/40 bg-dark-900/80 px-3 py-2"><PlayerButton player={player} className="font-semibold">{player.name}</PlayerButton><p className="mt-0.5 text-xs text-dark-400">{player.position} · {player.projectedPoints.toFixed(1)} projected pts</p></div>)}
          {userCuts.map(player => <div key={`drop-${player.id}`} className="rounded-lg border border-red-600/60 bg-red-950/30 px-3 py-2"><div className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600 font-black text-white">−</span><PlayerButton player={player} className="font-semibold text-red-300">Drop {player.name}</PlayerButton></div><p className="mt-0.5 pl-7 text-xs text-red-300/80">Roster cut · −{player.projectedPoints.toFixed(1)} projected pts</p></div>)}
        </div></div>
        <div className="hidden rounded-full border border-dark-600 bg-dark-800 px-3 py-2 text-dark-300 md:block">⇄</div>
        <div><p className="mb-2 text-xs font-bold uppercase tracking-wide text-green-400">You receive from {opponent}</p><div className="space-y-2">{receive.map(player => <div key={player.id} className="rounded-lg border border-green-900/40 bg-dark-900/80 px-3 py-2"><PlayerButton player={player} className="font-semibold">{player.name}</PlayerButton><p className="mt-0.5 text-xs text-dark-400">{player.position} · {player.projectedPoints.toFixed(1)} projected pts</p></div>)}</div></div>
      </div>
    </div>}
    <div className="mt-6 rounded-xl border border-dark-600 bg-dark-900 p-5">{verdict ? <><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={`text-2xl font-black ${verdictClass}`}>{verdict}</p><p className="mt-1 text-sm text-dark-400">{gap.toFixed(1)}% value difference {gap <= 7.5 ? '— inside the realistic range' : '— outside the realistic range'}</p></div><span className={`rounded-full px-4 py-2 text-sm font-bold ${gap <= 7.5 ? 'bg-blue-900/40 text-blue-400' : valueDelta > 0 ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>{valueDelta >= 0 ? '+' : ''}{valueDelta.toFixed(1)} value</span></div><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5"><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Send points</p><p className="mt-1 text-xl font-bold">{sentPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Receive points</p><p className="mt-1 text-xl font-bold">{receivedPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Point change</p><p className={`mt-1 text-xl font-bold ${pointDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pointDelta >= 0 ? '+' : ''}{pointDelta.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Team overall</p><p className={`mt-1 text-xl font-bold ${overallChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.rating.overall} → {overallAfter} <span className="text-sm">({overallChange >= 0 ? '+' : ''}{overallChange})</span></p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Balance score</p><p className="mt-1 text-xl font-bold">{Math.max(0, 100 - gap).toFixed(0)}%</p></div></div><div className="mt-5 rounded-lg border border-dark-700 bg-dark-800 p-4"><p className="font-semibold">Trade negotiator</p><p className="mt-1 text-xs text-dark-400">Tell Ask ProGM what matters to you—specific players, risk tolerance, positions, or whether the other manager rejected an offer.</p><textarea value={managerInput} onChange={event => setManagerInput(event.target.value)} className="input-field mt-3 min-h-24" placeholder="Example: I want to keep my RB depth and they asked for another receiver…" /><button type="button" onClick={negotiate} disabled={negotiating || !managerInput.trim()} className="btn-secondary mt-3 disabled:opacity-50">{negotiating ? 'Negotiating…' : 'Ask ProGM to negotiate'}</button>{negotiation && <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-dark-200">{negotiation}</p>}</div><div className="mt-5 flex flex-col gap-3 rounded-lg border border-primary-500/30 bg-primary-900/10 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">Ready to propose this package?</p><p className="mt-1 text-xs text-dark-400">Opens {opponent}'s ESPN team page. Tap Propose Trade, then select the players shown above and confirm in ESPN.</p></div><a href={espnTradeUrl} target="_blank" rel="noreferrer" className="btn-primary shrink-0 text-center">Send to ESPN ↗</a></div></> : <p className="text-center text-dark-400">Select at least one player from each team to analyze the trade.</p>}</div>
  </section>;
}
