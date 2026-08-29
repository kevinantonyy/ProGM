import { createContext, useContext, useMemo, useState } from 'react';

const EntityContext = createContext(null);

export function PlayerButton({ player, children, className = '' }) {
  const context = useContext(EntityContext);
  return <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); context?.openPlayer(player); }} className={`text-left font-semibold hover:text-primary-300 hover:underline ${className}`}>{children || player?.name}</button>;
}

export function TeamButton({ team, children, className = '' }) {
  const context = useContext(EntityContext);
  return <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); context?.openTeam(team); }} className={`text-left font-semibold hover:text-primary-300 hover:underline ${className}`}>{children || team?.name || team?.teamName}</button>;
}

function PlayerProfile({ player, findTeam }) {
  const team = findTeam(player.ownerTeam);
  const stats = [['Season projection', player.projectedPoints?.toFixed(1)], ['Season points', player.fantasyPoints?.toFixed(1)], ['Weekly projection', player.weeklyProjectedPoints?.toFixed(1)], ['Weekly points', player.weeklyPoints?.toFixed(1)], ['Rostered', `${(player.percentOwned || 0).toFixed(1)}%`], ['Started', `${(player.percentStarted || 0).toFixed(1)}%`]];
  return <><div className="flex items-start gap-4"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-600/20 font-black text-primary-300">{player.position}</span><div><h2 className="text-2xl font-black">{player.name}</h2><p className="mt-1 text-dark-400">{player.position} · {player.injuryStatus || 'ACTIVE'}{player.proRank ? ` · Expert rank #${player.proRank}` : ''}</p>{team && <div className="mt-2"><TeamButton team={team} className="text-sm text-primary-400">{team.name}</TeamButton></div>}</div></div><div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">{stats.map(([label, value]) => <div key={label} className="rounded-lg bg-dark-900 p-3"><p className="text-xs text-dark-400">{label}</p><p className="mt-1 text-lg font-black">{value ?? '—'}</p></div>)}</div></>;
}

function TeamProfile({ team, roster }) {
  return <><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary-400">Fantasy team</p><h2 className="mt-1 text-2xl font-black">{team.name || team.teamName}</h2><p className="mt-1 text-dark-400">{team.wins ?? 0}-{team.losses ?? 0}{team.ties ? `-${team.ties}` : ''} record · {Number(team.pointsFor || 0).toFixed(1)} points</p></div>{team.overall != null && <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-600/20 text-xl font-black text-primary-300">{team.overall}</span>}</div><div className="mt-5 max-h-[50vh] space-y-1 overflow-y-auto border-t border-dark-700 pt-3">{roster.length ? roster.sort((a, b) => b.projectedPoints - a.projectedPoints).map(player => <div key={player.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 even:bg-dark-900"><div><PlayerButton player={player} className="text-sm">{player.name}</PlayerButton><p className="text-xs text-dark-400">{player.position} · {player.injuryStatus}</p></div><p className="text-sm font-black text-primary-400">{player.projectedPoints.toFixed(1)}</p></div>) : <p className="text-dark-400">No roster details are available.</p>}</div></>;
}

export default function EntityModalProvider({ data, children }) {
  const [entity, setEntity] = useState(null);
  const teams = useMemo(() => data.leagueHub.standings.map(team => ({ ...team, name: team.name })), [data]);
  const findTeam = name => teams.find(team => team.name === name);
  const context = { openPlayer: player => setEntity({ type: 'player', value: player }), openTeam: team => setEntity({ type: 'team', value: findTeam(team?.name || team?.teamName) || team }) };
  const rosterFor = team => data.players.filter(player => player.ownerTeam === (team.name || team.teamName));
  function openPlainEntity(event) {
    if (event.target.closest('button, a, input, select, label')) return;
    const text = (event.target.childNodes?.[0]?.textContent || event.target.textContent || '').trim();
    const player = data.players.find(item => item.name === text);
    if (player) { event.target.classList.add('cursor-pointer'); context.openPlayer(player); return; }
    const team = findTeam(text);
    if (team) context.openTeam(team);
  }
  return <EntityContext.Provider value={context}><div onClickCapture={openPlainEntity}>{children}</div>{entity && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm" onMouseDown={() => setEntity(null)}><div role="dialog" aria-modal="true" className="w-full max-w-2xl rounded-2xl border border-dark-600 bg-dark-800 p-4 shadow-2xl sm:p-6" onMouseDown={event => event.stopPropagation()}><div className="mb-4 flex justify-end"><button type="button" onClick={() => setEntity(null)} className="btn-secondary px-3 py-1.5 text-sm">Close</button></div>{entity.type === 'player' ? <PlayerProfile player={entity.value} findTeam={findTeam} /> : <TeamProfile team={entity.value} roster={rosterFor(entity.value)} />}</div></div>}</EntityContext.Provider>;
}
