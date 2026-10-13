import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

const EntityContext = createContext(null);

export function PlayerAvatar({ player, size = 'h-7 w-7' }) {
  return <span className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-dark-600 bg-dark-700 text-[9px] font-black text-dark-300 ${size}`}><span>{player?.position || '?'}</span>{player?.image && <img src={player.image} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>;
}

export function TeamLogo({ team, size = 'h-7 w-7' }) {
  const name = team?.name || team?.teamName || 'Team';
  return <span className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dark-600 bg-dark-700 text-[9px] font-black text-dark-300 ${size}`}><span>{name.slice(0, 2).toUpperCase()}</span>{team?.logo && <img src={team.logo} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span>;
}

export function PlayerButton({ player, children, className = '' }) {
  const context = useContext(EntityContext);
  const fallback = Math.max(40, Math.min(99, Math.round((player?.proRank ? Math.max(25, 100 - (player.proRank - 1) * 0.32) : 42) * 0.55 + Number(player?.percentOwned || 0) * 0.25 + Number(player?.percentStarted || 0) * 0.2)));
  return <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); context?.openPlayer(player); }} className={`inline-flex max-w-full items-center gap-1.5 text-left font-semibold hover:text-primary-300 ${className}`}><PlayerAvatar player={player} /><span className="truncate hover:underline">{children || player?.name}</span><span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-primary-600/20 px-1 text-[10px] font-black text-primary-300" title="ProGM player overall">{player?.overall ?? fallback}</span></button>;
}

export function TeamButton({ team, children, className = '' }) {
  const context = useContext(EntityContext);
  return <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); context?.openTeam(team); }} className={`inline-flex max-w-full items-center gap-2 text-left font-semibold hover:text-primary-300 hover:underline ${className}`}><TeamLogo team={team} /><span className="truncate">{children || team?.name || team?.teamName}</span></button>;
}

function PlayerProfile({ player, findTeam }) {
  const { data } = useContext(EntityContext);
  const team = findTeam(player.ownerTeam);
  const stats = [['Season projection', player.projectedPoints?.toFixed(1)], ['Season points', player.fantasyPoints?.toFixed(1)], ['Weekly projection', player.weeklyProjectedPoints?.toFixed(1)], ['Weekly points', player.weeklyPoints?.toFixed(1)], ['Rostered', `${(player.percentOwned || 0).toFixed(1)}%`], ['Started', `${(player.percentStarted || 0).toFixed(1)}%`]];
  const mine = player.ownerTeam === data.connection.teamName;
  const tradePath = `/${data.connection.sport}/trades?${mine ? `send=${player.id}` : `receive=${player.id}&opponent=${encodeURIComponent(player.ownerTeam || '')}`}`;
  return <><div className="flex items-start gap-4"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-600/20 font-black text-primary-300">{player.position}</span><div><h2 className="text-2xl font-black">{player.name}</h2><p className="mt-1 text-dark-400">{player.position} · {player.injuryStatus || 'ACTIVE'}{player.proRank ? ` · Expert rank #${player.proRank}` : ''}</p>{team && <div className="mt-2"><TeamButton team={team} className="text-sm text-primary-400">{team.name}</TeamButton></div>}</div></div><div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">{stats.map(([label, value]) => <div key={label} className="rounded-lg bg-dark-900 p-3"><p className="text-xs text-dark-400">{label}</p><p className="mt-1 text-lg font-black">{value ?? '—'}</p></div>)}</div>{player.ownerTeam && <Link to={tradePath} className="btn-primary mt-5 block w-full text-center">{mine ? 'Trade Away' : 'Trade For'} {player.name} →</Link>}</>;
}

function TeamProfile({ team, roster }) {
  return <><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary-400">Fantasy team</p><h2 className="mt-1 text-2xl font-black">{team.name || team.teamName}</h2><p className="mt-1 text-dark-400">{team.wins ?? 0}-{team.losses ?? 0}{team.ties ? `-${team.ties}` : ''} record · {Number(team.pointsFor || 0).toFixed(1)} points</p></div>{team.overall != null && <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-600/20 text-xl font-black text-primary-300">{team.overall}</span>}</div><div className="mt-5 max-h-[50vh] space-y-1 overflow-y-auto border-t border-dark-700 pt-3">{roster.length ? roster.sort((a, b) => b.projectedPoints - a.projectedPoints).map(player => <div key={player.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 even:bg-dark-900"><div><PlayerButton player={player} className="text-sm">{player.name}</PlayerButton><p className="text-xs text-dark-400">{player.position} · {player.injuryStatus}</p></div><p className="text-sm font-black text-primary-400">{player.projectedPoints.toFixed(1)}</p></div>) : <p className="text-dark-400">No roster details are available.</p>}</div></>;
}

export default function EntityModalProvider({ data, children }) {
  const [entity, setEntity] = useState(null);
  const closeRef = useRef(null);
  const previousFocus = useRef(null);
  const teams = useMemo(() => data.leagueHub.standings.map(team => ({ ...team, name: team.name })), [data]);
  const findTeam = name => teams.find(team => team.name === name);
  const context = { data, openPlayer: player => setEntity({ type: 'player', value: player }), openTeam: team => setEntity({ type: 'team', value: findTeam(team?.name || team?.teamName) || team }) };
  const rosterFor = team => data.players.filter(player => player.ownerTeam === (team.name || team.teamName));
  function openPlainEntity(event) {
    if (event.target.closest('button, a, input, select, label')) return;
    const text = (event.target.childNodes?.[0]?.textContent || event.target.textContent || '').trim();
    const player = data.players.find(item => item.name === text);
    if (player) { event.target.classList.add('cursor-pointer'); context.openPlayer(player); return; }
    const team = findTeam(text);
    if (team) context.openTeam(team);
  }
  useEffect(() => {
    if (!entity) return undefined;
    previousFocus.current = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') setEntity(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus.current?.focus?.(); };
  }, [entity]);
  return <EntityContext.Provider value={context}><div onClickCapture={openPlainEntity}>{children}</div>{entity && <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm" onMouseDown={() => setEntity(null)}><div role="dialog" aria-modal="true" aria-label={`${entity.type === 'player' ? entity.value.name : entity.value.name || entity.value.teamName} details`} className="w-full max-w-2xl rounded-2xl border border-dark-600 bg-dark-800 p-4 shadow-2xl sm:p-6" onMouseDown={event => event.stopPropagation()}><div className="mb-4 flex justify-end"><button ref={closeRef} type="button" onClick={() => setEntity(null)} className="btn-secondary px-3 py-1.5 text-sm">Close</button></div>{entity.type === 'player' ? <PlayerProfile player={entity.value} findTeam={findTeam} /> : <TeamProfile team={entity.value} roster={rosterFor(entity.value)} />}</div></div>}</EntityContext.Provider>;
}
