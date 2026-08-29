import { useMemo, useState } from 'react';

function tradeValue(player) {
  return Math.max(1, Number(player.projectedPoints) || 0) + Math.max(0, Number(player.percentOwned) || 0) * 0.12 + (player.proRank ? Math.max(0, 100 - player.proRank) * 0.08 : 0);
}

function PlayerOption({ player, selected, onToggle }) {
  return <label className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition ${selected ? 'border-primary-500 bg-primary-600/10' : 'border-dark-700 bg-dark-900 hover:border-dark-600'}`}><div className="flex min-w-0 items-center gap-3"><input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 accent-blue-500" /><div className="min-w-0"><p className="truncate text-sm font-semibold">{player.name}</p><p className="text-xs text-dark-400">{player.position} · {player.projectedPoints.toFixed(1)} pts · {player.percentOwned.toFixed(1)}% owned</p></div></div><span className="shrink-0 text-sm font-bold text-primary-400">{tradeValue(player).toFixed(1)}</span></label>;
}

export default function TradeBuilder({ data }) {
  const [opponent, setOpponent] = useState(data.opponents[0]?.name || '');
  const [sendIds, setSendIds] = useState([]);
  const [receiveIds, setReceiveIds] = useState([]);
  const opponentPlayers = useMemo(() => data.players.filter(player => player.ownerTeam === opponent), [data.players, opponent]);
  const send = data.myTeam.roster.filter(player => sendIds.includes(player.id));
  const receive = opponentPlayers.filter(player => receiveIds.includes(player.id));
  const sentPoints = send.reduce((total, player) => total + player.projectedPoints, 0);
  const receivedPoints = receive.reduce((total, player) => total + player.projectedPoints, 0);
  const sentValue = send.reduce((total, player) => total + tradeValue(player), 0);
  const receivedValue = receive.reduce((total, player) => total + tradeValue(player), 0);
  const valueDelta = receivedValue - sentValue;
  const pointDelta = receivedPoints - sentPoints;
  const gap = send.length && receive.length ? Math.abs(valueDelta) / Math.max(sentValue, receivedValue) * 100 : 0;
  const verdict = !send.length || !receive.length ? null : gap <= 7.5 ? 'Fair trade' : valueDelta > 0 ? 'You are winning' : 'You are losing';
  const verdictClass = verdict === 'Fair trade' ? 'text-blue-400' : verdict === 'You are winning' ? 'text-green-400' : 'text-red-400';
  function toggle(id, setter) { setter(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
  return <section className="card border-primary-500/30"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary-400">Trade details</p><h2 className="mt-1 text-2xl font-bold">Build and balance your own trade</h2><p className="mt-2 text-sm text-dark-400">Select players on both sides. ProGM compares league projections, ownership, expert rank, and combined package value.</p></div>
    <div className="mt-5"><label className="text-sm text-dark-300">Trade partner</label><select value={opponent} onChange={event => { setOpponent(event.target.value); setReceiveIds([]); }} className="input-field mt-2">{data.opponents.map(team => <option key={team.id} value={team.name}>{team.name}</option>)}</select></div>
    <div className="mt-5 grid gap-5 xl:grid-cols-2"><div><p className="mb-2 text-sm font-bold uppercase tracking-wide text-red-400">You send</p><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{data.myTeam.roster.map(player => <PlayerOption key={player.id} player={player} selected={sendIds.includes(player.id)} onToggle={() => toggle(player.id, setSendIds)} />)}</div></div><div><p className="mb-2 text-sm font-bold uppercase tracking-wide text-green-400">You receive from {opponent}</p><div className="max-h-80 space-y-2 overflow-y-auto pr-1">{opponentPlayers.map(player => <PlayerOption key={player.id} player={player} selected={receiveIds.includes(player.id)} onToggle={() => toggle(player.id, setReceiveIds)} />)}</div></div></div>
    <div className="mt-6 rounded-xl border border-dark-600 bg-dark-900 p-5">{verdict ? <><div className="flex flex-wrap items-center justify-between gap-3"><div><p className={`text-2xl font-black ${verdictClass}`}>{verdict}</p><p className="mt-1 text-sm text-dark-400">{gap.toFixed(1)}% value difference {gap <= 7.5 ? '— inside the realistic range' : '— outside the realistic range'}</p></div><span className={`rounded-full px-4 py-2 text-sm font-bold ${gap <= 7.5 ? 'bg-blue-900/40 text-blue-400' : valueDelta > 0 ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>{valueDelta >= 0 ? '+' : ''}{valueDelta.toFixed(1)} value</span></div><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4"><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Send points</p><p className="mt-1 text-xl font-bold">{sentPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Receive points</p><p className="mt-1 text-xl font-bold">{receivedPoints.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Point change</p><p className={`mt-1 text-xl font-bold ${pointDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pointDelta >= 0 ? '+' : ''}{pointDelta.toFixed(1)}</p></div><div className="rounded-lg bg-dark-800 p-3"><p className="text-xs text-dark-400">Balance score</p><p className="mt-1 text-xl font-bold">{Math.max(0, 100 - gap).toFixed(0)}%</p></div></div></> : <p className="text-center text-dark-400">Select at least one player from each team to analyze the trade.</p>}</div>
  </section>;
}
