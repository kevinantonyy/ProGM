import { useMemo, useState } from 'react';
import { PlayerButton } from './EntityModal';

const MINIMUMS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, 'D/ST': 1 };
const SORTS = {
  projected: { label: 'Projected points', compare: (a, b) => b.projectedPoints - a.projectedPoints },
  overall: { label: 'ProGM overall', compare: (a, b) => (b.overall || 0) - (a.overall || 0) },
  expert: { label: 'Expert rank', compare: (a, b) => (a.proRank || 9999) - (b.proRank || 9999) },
  owned: { label: 'Rostered %', compare: (a, b) => b.percentOwned - a.percentOwned },
};

function signed(value, digits = 1) {
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;
}

function canReplace(roster, drop, add) {
  const counts = roster.reduce((result, player) => ({ ...result, [player.position]: (result[player.position] || 0) + 1 }), {});
  counts[drop.position] = (counts[drop.position] || 0) - 1;
  counts[add.position] = (counts[add.position] || 0) + 1;
  return Object.entries(MINIMUMS).every(([position, minimum]) => (counts[position] || 0) >= minimum);
}

function Recommendation({ player, index, espnPlayersUrl }) {
  return <article className="rounded-lg border border-dark-700 bg-dark-900 p-4"><div className="flex gap-4"><span className="text-lg font-black text-dark-500">#{index + 1}</span><div className="min-w-0 flex-1"><div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]"><div><p className="text-xs font-semibold uppercase text-green-400">Add</p><PlayerButton player={player}>{player.name}</PlayerButton><p className="text-xs text-dark-400">{player.position} · {player.projectedPoints.toFixed(1)} projected</p></div><div className="self-center text-dark-500">for</div><div><p className="text-xs font-semibold uppercase text-red-400">Drop</p><PlayerButton player={player.drop}>{player.drop.name}</PlayerButton><p className="text-xs text-dark-400">{player.drop.position} · {player.drop.projectedPoints.toFixed(1)} projected</p></div></div><div className="mt-3 flex flex-wrap items-center gap-2"><span className="badge-green">+{player.netGain.toFixed(1)} projected points</span><span className="badge-blue">OVR {player.overallBefore} → {player.overallAfter} ({signed(player.overallChange, 0)})</span><span className="text-xs text-dark-400">{player.availability}</span></div><p className="mt-2 text-sm leading-6 text-dark-300">{player.reasoning}</p><div className="mt-3 flex flex-wrap items-center gap-3"><a href={espnPlayersUrl} target="_blank" rel="noreferrer" className="btn-primary inline-block text-center text-sm">Add in ESPN ↗</a><p className="text-xs text-dark-500">Search {player.name}, choose {player.drop.name}, then confirm.</p></div></div></div></article>;
}

export default function WaiverWire({ data, espnPlayersUrl }) {
  const roster = data.myTeam.roster || [];
  const available = useMemo(() => (data.rankings || []).filter(player => !player.ownerTeam), [data.rankings]);
  const positions = useMemo(() => [...new Set(available.map(player => player.position))].sort(), [available]);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('ALL');
  const [sort, setSort] = useState('projected');
  const [selectedId, setSelectedId] = useState(null);
  const [compareId, setCompareId] = useState(null);
  const filtered = useMemo(() => available.filter(player => position === 'ALL' || player.position === position).filter(player => player.name.toLowerCase().includes(search.trim().toLowerCase())).sort(SORTS[sort].compare), [available, position, search, sort]);
  const selected = available.find(player => player.id === selectedId);
  const compared = roster.find(player => player.id === compareId);

  function beginCompare(player) {
    setSelectedId(player.id);
    const candidates = roster.filter(rosterPlayer => canReplace(roster, rosterPlayer, player)).sort((a, b) => a.projectedPoints - b.projectedPoints);
    const samePosition = candidates.find(rosterPlayer => rosterPlayer.position === player.position);
    setCompareId((samePosition || candidates[0] || roster[0])?.id ?? null);
  }

  const validMove = selected && compared ? canReplace(roster, compared, selected) : false;
  const pointChange = selected && compared ? selected.projectedPoints - compared.projectedPoints : 0;
  const overallChange = selected && compared ? (selected.overall || 0) - (compared.overall || 0) : 0;

  return <div className="space-y-5">
    <section className="card"><h2 className="text-xl font-bold">Waiver replacement suggestions</h2><p className="mt-1 text-sm text-dark-400">Personalized add/drop moves with positive projected improvement.</p><div className="mt-5 space-y-3">{data.waiverSuggestions.length ? data.waiverSuggestions.map((player, index) => <Recommendation key={player.id} player={player} index={index} espnPlayersUrl={espnPlayersUrl} />) : <p className="text-dark-400">No available player currently projects as a clear upgrade over a specific player on your roster.</p>}</div></section>

    {selected && <section className="card border-primary-500/40"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-primary-400">Player comparison</p><h2 className="mt-1 text-xl font-bold">Would this improve your roster?</h2></div><button type="button" className="btn-secondary text-sm" onClick={() => setSelectedId(null)}>Close comparison</button></div><div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_1fr]"><div className="rounded-lg border border-green-400/30 bg-green-400/5 p-4"><p className="text-xs font-semibold uppercase text-green-400">Add</p><div className="mt-2"><PlayerButton player={selected} className="text-lg">{selected.name}</PlayerButton></div><p className="mt-1 text-sm text-dark-400">{selected.position} · OVR {selected.overall ?? '—'} · Expert {selected.proRank ? `#${selected.proRank}` : '—'}</p><p className="mt-3 text-2xl font-black tabular-nums">{selected.projectedPoints.toFixed(1)}</p><p className="text-xs text-dark-400">Projected points</p></div><div className="self-center text-center text-dark-500">for</div><div className="rounded-lg border border-red-400/30 bg-red-400/5 p-4"><label className="text-xs font-semibold uppercase text-red-400">Compare with / drop</label><select value={compareId ?? ''} onChange={event => setCompareId(Number(event.target.value))} className="input-field mt-2">{roster.map(player => <option key={player.id} value={player.id}>{player.name} · {player.position}</option>)}</select>{compared && <><div className="mt-3"><PlayerButton player={compared} className="text-lg">{compared.name}</PlayerButton></div><p className="mt-1 text-sm text-dark-400">{compared.position} · OVR {compared.overall ?? '—'} · Expert {compared.proRank ? `#${compared.proRank}` : '—'}</p><p className="mt-3 text-2xl font-black tabular-nums">{compared.projectedPoints.toFixed(1)}</p><p className="text-xs text-dark-400">Projected points</p></>}</div></div>{compared && <div className={`mt-4 rounded-lg border p-4 ${validMove && pointChange > 0 ? 'border-green-400/30 bg-green-400/5' : 'border-red-400/30 bg-red-400/5'}`}><div className="grid grid-cols-2 gap-4 sm:grid-cols-4"><div><p className="stat-label">Point change</p><p className={`mt-1 text-xl font-black ${pointChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(pointChange)}</p></div><div><p className="stat-label">Player OVR</p><p className={`mt-1 text-xl font-black ${overallChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(overallChange, 0)}</p></div><div><p className="stat-label">Rostered</p><p className="mt-1 text-xl font-black">{selected.percentOwned.toFixed(1)}%</p></div><div><p className="stat-label">Verdict</p><p className={`mt-1 font-bold ${validMove && pointChange > 0 ? 'text-green-400' : 'text-red-400'}`}>{!validMove ? 'Invalid lineup' : pointChange > 0 ? 'Upgrade' : pointChange === 0 ? 'Sidegrade' : 'Downgrade'}</p></div></div>{!validMove && <p className="mt-3 text-sm text-red-400">This move would leave a required starting position without enough players. Compare against a different player.</p>}<a href={espnPlayersUrl} target="_blank" rel="noreferrer" className={`mt-4 inline-block text-center text-sm ${validMove ? 'btn-primary' : 'btn-secondary pointer-events-none opacity-50'}`}>Add in ESPN ↗</a></div>}</section>}

    <section className="card overflow-hidden p-0 sm:p-0"><div className="border-b border-dark-700 p-4 sm:p-5"><h2 className="text-xl font-bold">All available players</h2><p className="mt-1 text-sm text-dark-400">Search the full synced ESPN free-agent and waiver pool, then compare anyone with your roster.</p><div className="mt-4 grid gap-3 sm:grid-cols-3"><input value={search} onChange={event => setSearch(event.target.value)} className="input-field" placeholder="Search players" /><select value={position} onChange={event => setPosition(event.target.value)} className="input-field"><option value="ALL">All positions</option>{positions.map(item => <option key={item} value={item}>{item}</option>)}</select><select value={sort} onChange={event => setSort(event.target.value)} className="input-field">{Object.entries(SORTS).map(([key, option]) => <option key={key} value={key}>{option.label}</option>)}</select></div><p className="mt-3 text-xs text-dark-400">{filtered.length} available players</p></div><div className="max-h-[680px] overflow-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="sticky top-0 z-10 border-b border-dark-700 bg-dark-900 text-xs uppercase tracking-wide text-dark-400"><tr><th className="p-3">Player</th><th className="p-3">Status</th><th className="p-3 text-right">OVR</th><th className="p-3 text-right">Expert</th><th className="p-3 text-right">Projected</th><th className="p-3 text-right">Rostered</th><th className="p-3 text-right">Action</th></tr></thead><tbody>{filtered.map(player => <tr key={player.id} className={`border-b border-dark-700/80 hover:bg-dark-900 ${selectedId === player.id ? 'bg-primary-500/10' : ''}`}><td className="p-3"><PlayerButton player={player}>{player.name}</PlayerButton><p className="text-xs text-dark-400">{player.position} · {player.injuryStatus}</p></td><td className="p-3"><span className="badge-blue">{player.availability || 'Available'}</span></td><td className="p-3 text-right font-bold">{player.overall ?? '—'}</td><td className="p-3 text-right">{player.proRank ? `#${player.proRank}` : '—'}</td><td className="p-3 text-right font-bold text-primary-400">{player.projectedPoints.toFixed(1)}</td><td className="p-3 text-right">{player.percentOwned.toFixed(1)}%</td><td className="p-3 text-right"><button type="button" onClick={() => beginCompare(player)} className="btn-secondary px-3 py-1.5 text-xs">Compare</button></td></tr>)}</tbody></table>{!filtered.length && <p className="p-8 text-center text-dark-400">No available players match these filters.</p>}</div></section>
  </div>;
}
