import { useMemo, useState } from 'react';
import { PlayerButton } from './EntityModal';

function tradeValue(player) {
  return Math.max(1, Number(player.projectedPoints) || 0) + Math.max(0, Number(player.percentOwned) || 0) * 0.12 + (player.proRank ? Math.max(0, 100 - player.proRank) * 0.08 : 0);
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
  const [opponent, setOpponent] = useState(data.opponents[0]?.name || '');
  const [sendIds, setSendIds] = useState([]);
  const [receiveIds, setReceiveIds] = useState([]);
  const [suggestionMessage, setSuggestionMessage] = useState('');
  const opponentPlayers = useMemo(() => data.players.filter(player => player.ownerTeam === opponent), [data.players, opponent]);
  const send = data.myTeam.roster.filter(player => sendIds.includes(player.id));
  const receive = opponentPlayers.filter(player => receiveIds.includes(player.id));
  const sentPoints = send.reduce((total, player) => total + player.projectedPoints, 0);
  const receivedPoints = receive.reduce((total, player) => total + player.projectedPoints, 0);
  const sentValue = send.reduce((total, player) => total + tradeValue(player), 0);
  const receivedValue = receive.reduce((total, player) => total + tradeValue(player), 0);
  const valueDelta = receivedValue - sentValue;
  const pointDelta = receivedPoints - sentPoints;
  const overallAfter = Math.max(0, Math.min(99, Math.round((data.rating.rosterValue - sentValue + receivedValue) / data.rating.maxTeamValue * 99)));
  const overallChange = overallAfter - data.rating.overall;
  const gap = send.length && receive.length ? Math.abs(valueDelta) / Math.max(sentValue, receivedValue) * 100 : 0;
  const verdict = !send.length || !receive.length ? null : gap <= 7.5 ? 'Fair trade' : valueDelta > 0 ? 'You are winning' : 'You are losing';
  const verdictClass = verdict === 'Fair trade' ? 'text-blue-400' : verdict === 'You are winning' ? 'text-green-400' : 'text-red-400';
  const opponentTeam = data.opponents.find(team => team.name === opponent);
  const espnTradeUrl = `https://fantasy.espn.com/${data.connection.sport}/team?leagueId=${encodeURIComponent(data.connection.leagueId)}&teamId=${encodeURIComponent(opponentTeam?.id || '')}&seasonId=${encodeURIComponent(data.connection.season)}`;
  function toggle(id, setter) { setter(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
  function suggestTrade() {
    if (!send.length) { setSuggestionMessage('Select at least one player you are willing to send first.'); return; }
    if (!opponentPlayers.length) { setSuggestionMessage('This manager does not have a synced roster to build from.'); return; }
    const targetValue = sentValue;
    const needs = data.needs?.slice(0, 3) || [];
    const ranked = possiblePackages(opponentPlayers, 3).map(players => {
      const value = players.reduce((total, player) => total + tradeValue(player), 0);
      const gapPercent = Math.abs(value - targetValue) / Math.max(value, targetValue) * 100;
      const needMatches = players.filter(player => needs.includes(player.position)).length;
      return { players, gapPercent, score: gapPercent - needMatches * 0.35 };
    }).sort((a, b) => a.score - b.score);
    const best = ranked[0];
    setReceiveIds(best.players.map(player => player.id));
    setSuggestionMessage(best.gapPercent <= 7.5 ? `ProGM found a realistic return from ${opponent}.` : `This is the closest available return from ${opponent}, but it remains outside the 7.5% fair-value range.`);
  }
  return <section className="card border-primary-500/30"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary-400">Trade details</p><h2 className="mt-1 text-2xl font-bold">Build and balance your own trade</h2><p className="mt-2 text-sm text-dark-400">Select players on both sides. ProGM compares league projections, ownership, expert rank, and combined package value.</p></div>
    <div className="mt-5"><label className="text-sm text-dark-300">Trade partner</label><select value={opponent} onChange={event => { setOpponent(event.target.value); setReceiveIds([]); setSuggestionMessage(''); }} className="input-field mt-2">{data.opponents.map(team => <option key={team.id} value={team.name}>{team.name}</option>)}</select></div>
    <div className="mt-5 grid gap-5 xl:grid-cols-2"><div><div className="mb-2 flex items-center justify-between gap-3"><p className="text-sm font-bold uppercase tracking-wide text-red-400">You send</p><button type="button" onClick={() => { setSendIds([]); setSuggestionMessage(''); }} disabled={!sendIds.length} className="text-xs font-semibold text-dark-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Uncheck all</button></div><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{data.myTeam.roster.map(player => <PlayerOption key={player.id} player={player} selected={sendIds.includes(player.id)} onToggle={() => toggle(player.id, setSendIds)} />)}</div></div><div><div className="mb-2 flex items-center justify-between gap-3"><p className="text-sm font-bold uppercase tracking-wide text-green-400">You receive from {opponent}</p><button type="button" onClick={() => { setReceiveIds([]); setSuggestionMessage(''); }} disabled={!receiveIds.length} className="text-xs font-semibold text-dark-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Uncheck all</button></div><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{opponentPlayers.map(player => <PlayerOption key={player.id} player={player} selected={receiveIds.includes(player.id)} onToggle={() => toggle(player.id, setReceiveIds)} />)}</div></div></div>
    <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={suggestTrade} disabled={!send.length} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">✨ Suggest a trade</button><p className={`text-sm ${suggestionMessage.includes('realistic') ? 'text-green-400' : 'text-dark-400'}`}>{suggestionMessage || 'Select your outgoing player(s), then let ProGM build the return package.'}</p></div>
    <div className="mt-6 rounded-xl border border-dark-600 bg-dark-900 p-5">{verdict ? <><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={`text-2xl font-black ${verdictClass}`}>{verdict}</p><p className="mt-1 text-sm text-dark-400">{gap.toFixed(1)}% value difference {gap <= 7.5 ? '— inside the realistic range' : '— outside the realistic range'}</p></div><span className={`rounded-full px-4 py-2 text-sm font-bold ${gap <= 7.5 ? 'bg-blue-900/40 text-blue-400' : valueDelta > 0 ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>{valueDelta >= 0 ? '+' : ''}{valueDelta.toFixed(1)} value</span></div><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5"><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Send points</p><p className="mt-1 text-xl font-bold">{sentPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Receive points</p><p className="mt-1 text-xl font-bold">{receivedPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Point change</p><p className={`mt-1 text-xl font-bold ${pointDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pointDelta >= 0 ? '+' : ''}{pointDelta.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Team overall</p><p className={`mt-1 text-xl font-bold ${overallChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.rating.overall} → {overallAfter} <span className="text-sm">({overallChange >= 0 ? '+' : ''}{overallChange})</span></p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Balance score</p><p className="mt-1 text-xl font-bold">{Math.max(0, 100 - gap).toFixed(0)}%</p></div></div><div className="mt-5 flex flex-col gap-3 rounded-lg border border-primary-500/30 bg-primary-900/10 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">Ready to propose this package?</p><p className="mt-1 text-xs text-dark-400">Opens {opponent}'s ESPN team page. Tap Propose Trade, then select the players shown above and confirm in ESPN.</p></div><a href={espnTradeUrl} target="_blank" rel="noreferrer" className="btn-primary shrink-0 text-center">Send to ESPN ↗</a></div></> : <p className="text-center text-dark-400">Select at least one player from each team to analyze the trade.</p>}</div>
  </section>;
}
