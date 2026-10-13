import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

const PlayerProfileContext = createContext(null);

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function compact(object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, value]) => present(value)));
}

function playerKey(player) {
  return player?.playerKey || player?.id || player?.name || null;
}

export function PlayerAvatar({ player, size = 'h-9 w-9', className = '', alt = '' }) {
  const sources = useMemo(() => [...new Set([player?.highResImage, player?.image, player?.headshotUrl].filter(Boolean))], [player?.highResImage, player?.image, player?.headshotUrl]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourceKey = sources.join('|');
  useEffect(() => setSourceIndex(0), [sourceKey]);
  const src = sources[sourceIndex] || null;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-dark-600 bg-dark-700 text-[10px] font-black text-dark-300 ${size} ${className}`}>
      <span aria-hidden="true">{initials(player?.name)}</span>
      {src && <img src={src} alt={alt} loading="lazy" decoding="async" draggable="false" className="absolute inset-0 h-full w-full object-contain object-bottom" onError={() => setSourceIndex((index) => Math.min(index + 1, sources.length))} />}
    </span>
  );
}

export function PlayerLink({ player, children, className = '', avatarSize = 'h-9 w-9', showAvatar = true }) {
  const context = useContext(PlayerProfileContext);
  return (
    <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); context?.openPlayer(player); }} className={`inline-flex max-w-full items-center gap-2 text-left font-semibold hover:text-primary-400 ${className}`} aria-label={`View ${player?.name || 'player'} profile`}>
      {showAvatar && <PlayerAvatar player={player} size={avatarSize} />}
      <span className="truncate hover:underline">{children || player?.name}</span>
    </button>
  );
}

function Stat({ label, value }) {
  return <div className="border-r border-dark-700 px-3 py-3 last:border-r-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-dark-400">{label}</p><p className="mt-1 text-lg font-black tabular-nums">{present(value) ? value : '—'}</p></div>;
}

function PlayerProfile({ player, data, closeRef }) {
  const positions = player.eligiblePositions?.length ? player.eligiblePositions.join('/') : player.position;
  const status = player.injuryDetail || player.statusFull || player.injuryStatus || player.status || null;
  const projection = player.projectedPoints ?? player.projected ?? null;
  const periodProjection = player.periodProjected ?? player.weeklyProjectedPoints ?? null;
  const progmRank = player.progmRank ?? player.overallRank ?? null;
  const history = Array.isArray(player.history) ? player.history.filter((row) => row?.gamesPlayed != null && row?.gameTotal) : [];
  const durability = player.components?.durabilityScore;
  const explanations = [player.rankReason, player.marketReason, player.rosterFitLabel, player.fitReason, player.reasoning].filter(Boolean);
  const fetchedAt = data.externalData?.freshness?.fetchedAt;
  const updated = fetchedAt ? new Date(fetchedAt) : null;
  const freshness = data.externalData?.available
    ? `${data.externalData?.freshness?.stale ? 'Data may be stale' : 'Data current'}${updated && !Number.isNaN(updated.valueOf()) ? ` · updated ${updated.toLocaleString()}` : ''}`
    : 'Projection data unavailable';

  return (
    <div>
      <header className="relative flex items-end gap-4 bg-[#151515] p-4 text-white sm:items-center sm:p-6">
        <PlayerAvatar player={player} size="h-24 w-24 sm:h-32 sm:w-32" className="rounded-md border-white/20 bg-white" alt={`${player.name} headshot`} />
        <div className="min-w-0 flex-1 pb-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-white/60">{player.teamAbbr || 'Team unavailable'}{positions ? ` · ${positions}` : ''}</p>
          <h2 id="player-profile-title" className="mt-1 truncate text-3xl font-black leading-none">{player.name}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {present(progmRank) && <span className="rounded bg-white/15 px-2 py-1 text-xs font-bold">ProGM #{progmRank}</span>}
            {present(player.yahooOverallRank) && <span className="rounded bg-white/15 px-2 py-1 text-xs font-bold">Yahoo #{player.yahooOverallRank}</span>}
            {status ? <span className={['Healthy', 'ACTIVE', 'NORMAL'].includes(status) ? 'badge-green' : 'badge-orange'}>{status}</span> : <span className="badge-blue">Status unavailable</span>}
          </div>
        </div>
        <button ref={closeRef} type="button" aria-label="Close player profile" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded border border-white/25 text-xl text-white hover:bg-white/10" data-profile-close>×</button>
      </header>

      <div className="divide-y divide-dark-700 bg-dark-800">
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <Stat label="Projected FP/G" value={projection != null ? Number(projection).toFixed(1) : null} />
          <Stat label="Yahoo ADP" value={player.yahooAdp} />
          <Stat label="Season Rank" value={player.yahooSeasonRank} />
          <Stat label="Owned" value={player.percentOwned != null ? `${player.percentOwned}%` : null} />
        </div>

        <section className="p-4 sm:p-6">
          <h3 className="text-xl font-bold">Player overview</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-dark-700 bg-dark-900 p-3"><p className="stat-label">ProGM Rank</p><p className="mt-1 text-xl font-black">{present(progmRank) ? `#${progmRank}` : '—'}</p></div>
            <div className="rounded-md border border-dark-700 bg-dark-900 p-3"><p className="stat-label">Yahoo Rank</p><p className="mt-1 text-xl font-black">{present(player.yahooOverallRank) ? `#${player.yahooOverallRank}` : '—'}</p></div>
            <div className="rounded-md border border-dark-700 bg-dark-900 p-3"><p className="stat-label">Upcoming period</p><p className="mt-1 text-xl font-black">{periodProjection != null ? `${Number(periodProjection).toFixed(1)} FP` : '—'}</p>{player.expectedGames != null && <p className="text-xs text-dark-400">{player.expectedGames} game{player.expectedGames === 1 ? '' : 's'} · {data.period?.start || 'current'}–{data.period?.end || 'period'}</p>}</div>
          </div>
          {explanations.length > 0 && <div className="mt-4 border-l-4 border-primary-500 bg-primary-500/5 p-3"><p className="text-xs font-bold uppercase tracking-wide text-primary-400">ProGM analysis</p>{explanations.map((text, index) => <p key={index} className="mt-1 text-sm leading-5 text-dark-300">{text}</p>)}</div>}
        </section>

        <section className="p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-bold">Availability & durability</h3>{durability != null && <span className="badge-blue">{Math.round(durability * 100)}% durability</span>}</div>
          {history.length ? <div className="mt-3 grid gap-2 sm:grid-cols-3">{history.map((row) => <div key={row.season} className="rounded-md bg-dark-900 p-3"><p className="text-xs text-dark-400">{row.season}</p><p className="mt-1 font-bold">{row.gamesPlayed}/{row.gameTotal} games</p></div>)}</div> : <p className="mt-2 text-sm text-dark-400">Historical availability is not available for this player.</p>}
        </section>

        <section className="p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-bold">Recent performance</h3><span className="text-xs text-dark-500">Live data only</span></div>
          <p className="mt-2 text-sm text-dark-400">Season averages and game logs are not exposed in the current basketball workspace.</p>
          <p className="mt-4 text-xs text-dark-500">{freshness}</p>
        </section>
      </div>
    </div>
  );
}

function collectPlayers(data) {
  const byKey = new Map();
  const byName = new Map();
  const add = (player, overrides = {}) => {
    if (!player?.name && !playerKey(player)) return;
    const key = playerKey(player);
    const existing = (key && byKey.get(key)) || (player.name && byName.get(player.name)) || {};
    const merged = { ...existing, ...compact(player), ...compact(overrides) };
    if (key) byKey.set(key, merged);
    if (merged.name) byName.set(merged.name, merged);
  };

  (data.myTeam?.roster || []).forEach((player) => add(player));
  (data.rankings?.players || []).forEach((player) => add(player, { progmRank: player.rank, projectedPoints: player.projected }));
  [...(data.waivers?.bestAvailable || []), ...(data.waivers?.bestFit || []), ...(data.waivers?.players || [])].forEach((player) => add(player));
  (data.waivers?.addDrop || []).forEach((move) => { add(move.add); add(move.drop); });
  [...(data.draftBoard?.board || []), ...(data.draftBoard?.noData || [])].forEach((player) => add(player, { progmRank: player.overallRank, projectedPoints: player.projected }));
  (data.recommendedTrades?.recommendations || []).forEach((trade) => { (trade.send || []).forEach((player) => add(player)); (trade.receive || []).forEach((player) => add(player)); });

  return { byKey, byName };
}

export default function BasketballPlayerProfileProvider({ data, children }) {
  const [selected, setSelected] = useState(null);
  const closeRef = useRef(null);
  const previousFocus = useRef(null);
  const index = useMemo(() => collectPlayers(data), [data]);

  const resolvePlayer = (player) => {
    const known = index.byKey.get(playerKey(player)) || index.byName.get(player?.name) || {};
    return { ...known, ...compact(player) };
  };
  const close = () => setSelected(null);
  const context = useMemo(() => ({ openPlayer: (player) => setSelected(resolvePlayer(player)) }), [index]);

  useEffect(() => {
    if (!selected) return undefined;
    previousFocus.current = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest('[role="dialog"]');
      const focusable = [...(dialog?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') || [])].filter((node) => !node.disabled);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = priorOverflow;
      previousFocus.current?.focus?.();
    };
  }, [selected]);

  return (
    <PlayerProfileContext.Provider value={context}>
      {children}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="player-profile-title" className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-lg border border-dark-600 bg-dark-800 shadow-xl sm:rounded-md">
            <div onClick={(event) => { if (event.target.closest('[data-profile-close]')) close(); }}><PlayerProfile player={selected} data={data} closeRef={closeRef} /></div>
          </div>
        </div>
      )}
    </PlayerProfileContext.Provider>
  );
}
