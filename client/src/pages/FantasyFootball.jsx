import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

export default function FantasyFootball() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function load() {
    setLoading(true); setError('');
    try { setData((await api.get('/espn/football')).data); }
    catch (err) { setError(err.response?.data?.error || 'Could not load fantasy football'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  if (loading) return <div className="text-primary-400 animate-pulse">Loading ESPN Fantasy Football…</div>;
  if (error) return <div className="card max-w-2xl"><h1 className="text-2xl font-bold">Fantasy Football</h1><p className="mt-3 text-red-400">{error}</p><Link to="/login" className="btn-primary mt-5 inline-block">Connect ESPN league</Link></div>;
  const { connection, myTeam, opponents, suggestions, analysis } = data;
  return <div className="space-y-8">
    <div className="flex items-start justify-between"><div><h1 className="text-3xl font-bold">Fantasy Football</h1><p className="mt-1 text-dark-400">{connection.teamName} · {connection.leagueName} · {connection.season}</p></div><button onClick={load} className="btn-primary">↻ Refresh</button></div>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><div className="card"><p className="stat-label">Roster Size</p><p className="stat-value mt-1">{analysis.rosterSize}</p></div><div className="card"><p className="stat-label">Projected Points</p><p className="stat-value mt-1">{analysis.totalProjected}</p></div><div className="card"><p className="stat-label">Average Projection</p><p className="stat-value mt-1">{analysis.avgProjected}</p></div><div className="card"><p className="stat-label">Injury Concerns</p><p className={`stat-value mt-1 ${analysis.injured ? 'text-red-400' : 'text-green-400'}`}>{analysis.injured}</p></div></div>
    <div className="grid gap-6 xl:grid-cols-2"><section className="card"><h2 className="mb-4 text-xl font-bold">My ESPN Roster</h2><div className="space-y-2">{myTeam.roster.sort((a,b)=>b.projectedPoints-a.projectedPoints).map(player=><div key={player.id} className="flex items-center justify-between border-b border-dark-700 py-3 last:border-0"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">{player.position}</span><div><p className="font-medium">{player.name}</p><p className="text-xs text-dark-400">{player.injuryStatus} · {player.percentOwned.toFixed(1)}% rostered</p></div></div><div className="text-right"><p className="font-bold text-primary-400">{player.projectedPoints.toFixed(1)}</p><p className="text-xs text-dark-400">projected</p></div></div>)}</div></section>
    <section className="card border-primary-500/30"><h2 className="mb-4 text-xl font-bold">🤖 Football Trade Suggestions</h2>{suggestions.length ? <div className="space-y-4">{suggestions.map((trade,index)=><div key={`${trade.give.id}-${trade.receive.id}`} className="rounded-lg border border-dark-700 bg-dark-900 p-4"><div className="mb-2 flex items-center justify-between"><span className="badge-blue">{trade.give.position} Upgrade</span><span className="text-sm font-bold text-green-400">{trade.confidence}% confidence</span></div><p><span className="text-red-400">{trade.give.name}</span><span className="mx-2 text-dark-500">→</span><span className="text-green-400">{trade.receive.name}</span></p><p className="mt-1 text-xs text-dark-400">Manager: {trade.receive.ownerTeam}</p><p className="mt-3 text-sm leading-6 text-dark-300">{trade.reasoning}</p></div>)}</div> : <p className="text-dark-400">No clear same-position upgrades found from the current projections.</p>}</section></div>
    <section className="card"><h2 className="mb-4 text-xl font-bold">League Opponents</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{opponents.map(team=><div key={team.id} className="rounded-lg border border-dark-700 bg-dark-900 p-4"><p className="font-semibold">{team.name}</p><p className="mt-1 text-sm text-dark-400">{team.wins}-{team.losses} · {team.rosterSize} players</p></div>)}</div></section>
  </div>;
}
