import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';
import BasketballPlayerProfileProvider, { PlayerLink } from '../components/BasketballPlayerProfile';

// Fantasy Basketball workspace — powered by Yahoo + Tank01 + ProGM analytics,
// rendered in the ProGM (.deploy-repo) design system. Yahoo is invisible
// infrastructure; the product surface is "Fantasy Basketball".

const SECTIONS = [
  ['overview', 'My Team'],
  ['roster', 'Roster'],
  ['start-sit', 'Start / Sit'],
  ['trades', 'Trades'],
  ['waivers', 'Waivers'],
  ['rankings', 'Rankings'],
  ['draft', 'Draft Helper'],
  ['league', 'League Hub'],
  ['gm', 'Ask ProGM'],
];

function Proj({ value }) {
  if (value == null) return <span className="text-dark-500">—</span>;
  return <span className="font-bold text-primary-400">{value.toFixed(1)}</span>;
}

function StatusBadge({ status }) {
  if (!status || ['Healthy', 'ACTIVE', 'NORMAL'].includes(status)) return <span className="badge-green">Healthy</span>;
  const out = ['O', 'OUT', 'IL', 'INJ', 'NA', 'SUSP'].includes(status);
  return <span className={out ? 'badge-red' : 'badge-orange'}>{status}</span>;
}

function Freshness({ external }) {
  if (!external?.available) return <span className="badge-orange">Projections unavailable</span>;
  const f = external.freshness;
  const when = f?.fetchedAt ? new Date(f.fetchedAt) : null;
  return <span className="text-xs text-dark-400">{f?.stale ? 'Data may be stale' : 'Data current'}{when ? ` · updated ${when.toLocaleTimeString()}` : ''}</span>;
}

function SecondaryDetails({ label = 'Details', children, className = '' }) {
  return <details className={`text-xs text-dark-400 ${className}`}><summary className="cursor-pointer font-semibold text-dark-400 hover:text-primary-400">{label}</summary><div className="mt-2 leading-5 text-dark-400">{children}</div></details>;
}

function PlayerRow({ player, showProj = true }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dark-700 py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <PlayerLink player={player}>{player.name}</PlayerLink>
          <p className="truncate text-xs text-dark-400">{player.teamAbbr || 'FA'} · {player.eligiblePositions?.join('/') || player.position}{player.selectedPosition ? ` · ${player.selectedPosition}` : ''}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <StatusBadge status={player.injuryStatus} />
        {showProj && <div className="text-right"><Proj value={player.projectedPoints} /><p className="text-xs text-dark-400">proj/gm</p></div>}
      </div>
    </div>
  );
}

// --- Tab: Overview ---
function Overview({ data }) {
  const roster = [...data.myTeam.roster].sort((a, b) => (b.projectedPoints ?? -1) - (a.projectedPoints ?? -1));
  const rating = data.rating;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card"><p className="stat-label">Roster</p><p className="stat-value mt-1">{data.analysis.rosterSize}</p></div>
        <div className="card"><p className="stat-label">Team projected</p><p className="stat-value mt-1">{data.analysis.totalProjected ?? '—'}</p></div>
        <div className="card"><p className="stat-label">Injuries</p><p className={`stat-value mt-1 ${data.analysis.injured ? 'text-red-400' : 'text-green-400'}`}>{data.analysis.injured}</p></div>
        <div className="card">
          <p className="stat-label">Team rating</p>
          {rating?.available && rating.overall != null ? (
            <><p className="stat-value mt-1">{rating.overall}<span className="text-base text-dark-500">/99</span></p><p className="text-xs text-dark-400">{rating.rank}{rating.rank ? nth(rating.rank) : ''} of {rating.teamCount} teams</p></>
          ) : (<p className="mt-1 text-sm text-dark-400">Unavailable</p>)}
        </div>
      </div>
      {rating?.note && <SecondaryDetails label="Team Rating method">{rating.note}</SecondaryDetails>}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 text-xl font-bold">My roster</h2>
          {roster.map((p) => <PlayerRow key={p.id} player={p} />)}
        </section>
        <section className="card">
          <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Standings</h2><span className="badge-blue">Yahoo</span></div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-dark-600 text-left text-dark-400"><tr><th className="pb-2">#</th><th className="pb-2">Team</th><th className="pb-2 text-right">Record</th><th className="pb-2 text-right">PF</th></tr></thead>
              <tbody>{data.standings.map((t) => (
                <tr key={t.id} className={`border-b border-dark-700 ${t.isMine ? 'bg-primary-600/10' : ''}`}>
                  <td className="py-2 font-bold text-dark-400">{t.rank ?? '—'}</td>
                  <td className="py-2">{t.name}{t.isMine && <span className="badge-blue ml-2">You</span>}</td>
                  <td className="py-2 text-right">{t.wins != null ? `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}` : '—'}</td>
                  <td className="py-2 text-right text-primary-400">{t.pointsFor != null ? Math.round(t.pointsFor).toLocaleString() : '—'}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {data.intelligence?.recommendations?.length > 0 && (
        <section className="card">
          <h2 className="text-xl font-bold">ProGM recommendations</h2>
          <div className="mt-4 grid gap-3">{data.intelligence.recommendations.map((rec, i) => (
            <div key={i} className="rounded-lg border border-dark-700 bg-dark-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">{rec.recommendation}</p>
                {rec.projectedImpact && <span className="badge-green shrink-0">+{rec.projectedImpact.value} {rec.projectedImpact.metric}</span>}
              </div>
              {rec.reasons?.length > 0 && <ul className="mt-2 space-y-0.5">{rec.reasons.map((r, j) => <li key={j} className="text-xs text-dark-400">· {r}</li>)}</ul>}
              <div className="mt-2 flex flex-wrap gap-1.5">{(rec.dataSources || []).map((s) => <span key={s} className="badge-blue">{s}</span>)}</div>
            </div>))}
          </div>
        </section>
      )}
    </div>
  );
}

function nth(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return (s[(v - 20) % 10] || s[v] || s[0]); }

// Yahoo season start-year -> "2025-26" label. Falls back to the raw value.
function seasonLabelFrom(season) {
  const y = Number(season);
  if (!Number.isInteger(y)) return season || '';
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// --- Tab: Roster (starters / bench / IL) ---
function Roster({ data }) {
  const roster = data.myTeam.roster;
  const starters = roster.filter((p) => p.isStarting);
  const bench = roster.filter((p) => !p.isStarting && !['IL', 'IL+'].includes(p.selectedPosition));
  const il = roster.filter((p) => ['IL', 'IL+'].includes(p.selectedPosition));
  const Group = ({ title, players }) => players.length ? (
    <section className="card"><h2 className="mb-2 text-lg font-bold">{title} <span className="text-dark-500">({players.length})</span></h2>{players.map((p) => <PlayerRow key={p.id} player={p} />)}</section>
  ) : null;
  return <div className="space-y-4"><Group title="Starting lineup" players={starters} /><Group title="Bench" players={bench} /><Group title="Injured reserve" players={il} /></div>;
}

// --- Tab: Start/Sit ---
function StartSit({ data }) {
  const lu = data.lineup;
  if (!lu) return <section className="card text-dark-400">Start/Sit is unavailable for this league.</section>;
  if (!lu.projectionsAvailable) return (
    <section className="card border-orange-500/30"><h2 className="text-xl font-bold">Who should I start?</h2><p className="mt-2 text-dark-300">{lu.note}</p><p className="mt-2 text-xs text-dark-500">Connect an NBA stats provider to unlock projected-points lineup optimization.</p></section>
  );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <div className="card"><p className="stat-label">Current projected</p><p className="stat-value mt-1">{lu.projectedCurrentPoints?.toFixed(1)}</p></div>
        <div className="card"><p className="stat-label">Optimized projected</p><p className="stat-value mt-1 text-green-400">{lu.projectedOptimizedPoints?.toFixed(1)}</p></div>
        <div className="card"><p className="stat-label">Difference</p><p className={`stat-value mt-1 ${lu.projectedDifference > 0 ? 'text-green-400' : ''}`}>{lu.projectedDifference > 0 ? '+' : ''}{lu.projectedDifference?.toFixed(1)}</p></div>
      </div>
      {lu.currentMissingDataCount > 0 && <p className="rounded-lg border border-orange-700/40 bg-orange-900/10 p-3 text-xs text-orange-300">{lu.currentMissingDataCount} current starter(s) have no projection data ({lu.currentMissingData.join(', ')}) and count as 0, so the difference overstates the true gain. Treat it as directional.</p>}
      {lu.swaps?.length ? (
        <section><h2 className="mb-3 text-xl font-bold">Suggested swaps</h2><div className="grid gap-3 md:grid-cols-2">{lu.swaps.map((s, i) => (
          <div key={i} className="card"><div className="flex items-center justify-between"><span className="badge-blue">{s.slot}</span>{s.projectedGain != null && <span className="badge-green">+{s.projectedGain} proj</span>}</div>
            <div className="mt-3 flex items-center justify-between gap-2 text-sm"><div><p className="text-[10px] uppercase text-green-400">Start</p><PlayerLink player={s.in} avatarSize="h-7 w-7">{s.in?.name}</PlayerLink><Proj value={s.in?.proj} /></div><span className="text-dark-500">↔</span><div className="text-right"><p className="text-[10px] uppercase text-red-400">Bench</p>{s.out ? <PlayerLink player={s.out} avatarSize="h-7 w-7">{s.out.name}</PlayerLink> : <p className="font-semibold">—</p>}{s.out && <Proj value={s.out?.proj} />}</div></div>
            {s.reasons?.length > 0 && <ul className="mt-2 space-y-0.5">{s.reasons.map((r, j) => <li key={j} className="text-xs text-dark-400">· {r}</li>)}</ul>}
          </div>))}
        </div></section>
      ) : <section className="card text-center"><h2 className="text-lg font-bold">Your lineup is already optimal</h2><p className="mt-1 text-dark-400">No projected-points improvement available from a legal swap.</p></section>}
    </div>
  );
}

// --- Tab: Waivers ---
function Waivers({ data }) {
  const w = data.waivers;
  const [view, setView] = useState('bestAvailable');
  if (!w) return <section className="card text-dark-400">Waivers unavailable.</section>;
  if (!w.projectionsAvailable) return <section className="card border-orange-500/30"><h2 className="text-xl font-bold">Waiver rankings</h2><p className="mt-2 text-dark-300">{w.note}</p></section>;
  const rows = view === 'bestFit' ? w.bestFit : w.bestAvailable;
  const CAT = { MustAdd: 'badge-green', Upgrade: 'badge-green', Stream: 'badge-blue', OpenSlot: 'badge-blue', Watch: 'badge-orange' };
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-dark-700">
        {[['bestAvailable', 'Best Available'], ['bestFit', 'Best Fit'], ['addDrop', 'Add / Drop']].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${view === k ? 'border-primary-500 text-primary-400' : 'border-transparent text-dark-400 hover:text-dark-50'}`}>{l}</button>
        ))}
      </div>

      {view === 'addDrop' && (
        <section className="space-y-3">
          {!(w.addDrop || []).length && <div className="card text-sm text-dark-400">No add/drop upgrade available right now. ProGM only pairs an add with a drop when your roster is full and the move is a clear net gain — it won't suggest churn.</div>}
          {(w.addDrop || []).map((m, i) => (
            <div key={i} className="card">
              <div className="flex items-center justify-between gap-2">
                <span className={CAT[m.category] || 'badge-orange'}>{m.category}</span>
                {m.netImprovement != null && <span className="badge-green">+{m.netImprovement} proj</span>}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0"><p className="text-[10px] uppercase text-green-400">Add</p><PlayerLink player={m.add} avatarSize="h-7 w-7">{m.add?.name}</PlayerLink><Proj value={m.add?.projectedPoints} /></div>
                <span className="text-dark-500">↔</span>
                <div className="min-w-0 text-right"><p className="text-[10px] uppercase text-red-400">{m.drop ? 'Drop' : 'Open slot'}</p>{m.drop ? <PlayerLink player={m.drop} avatarSize="h-7 w-7">{m.drop.name}</PlayerLink> : <p className="truncate font-semibold">No drop needed</p>}{m.drop && <Proj value={m.drop?.projectedPoints} />}</div>
              </div>
              {m.reason && <p className="mt-2 border-t border-dark-700 pt-2 text-xs text-dark-400">{m.reason}</p>}
              {m.drop && m.drop.projectionKnown === false && <p className="mt-1 text-[11px] text-orange-300/80">Drop candidate has no projection — confirm before dropping.</p>}
            </div>))}
        </section>
      )}
      {view !== 'addDrop' && (
        <>
          <section className="card overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-dark-700 text-left text-xs uppercase text-dark-400"><tr><th className="p-3">#</th><th className="p-3">Player</th><th className="p-3 text-right">{view === 'bestFit' ? 'Fit' : 'Proj'}</th><th className="p-3 text-right">Owned</th><th className="p-3 text-right">Status</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.playerKey} className="border-b border-dark-700 hover:bg-dark-900">
                  <td className="p-3 text-dark-400">{p.rank}</td>
                  <td className="p-3"><PlayerLink player={p}>{p.name}</PlayerLink><p className="text-xs text-dark-400" title={view === 'bestFit' ? p.fitReason : undefined}>{p.teamAbbr || 'FA'} · {p.eligiblePositions?.join('/')}{view === 'bestFit' && p.fitReason ? ' · Fit details available' : ''}</p></td>
                  <td className="p-3 text-right">{view === 'bestFit' ? <span className="font-bold text-primary-400">{p.fitScore?.toFixed(1)}</span> : <Proj value={p.projectedPoints} />}</td>
                  <td className="p-3 text-right text-dark-300">{p.percentOwned != null ? `${p.percentOwned}%` : '—'}</td>
                  <td className="p-3 text-right"><StatusBadge status={p.status} /></td>
                </tr>))}
              </tbody>
            </table>
            {!rows.length && <p className="p-8 text-center text-dark-400">No ranked available players.</p>}
          </section>
          <SecondaryDetails label="How waiver rankings work">Best Available uses projected league fantasy points. Best Fit adjusts for positional need. Ownership is context only.</SecondaryDetails>
        </>
      )}
    </div>
  );
}

// --- Tab: Trades ---
function Trades({ data, leagueKey }) {
  const teams = data.opponents;
  const myRoster = data.myTeam.roster;
  const [theirTeamKey, setTheirTeamKey] = useState('');
  const [theirRoster, setTheirRoster] = useState([]);
  const [sendKeys, setSendKeys] = useState([]);
  const [receiveKeys, setReceiveKeys] = useState([]);
  const [result, setResult] = useState(null);
  const [loadingTheirs, setLoadingTheirs] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  async function pickOpponent(key) {
    setTheirTeamKey(key); setTheirRoster([]); setReceiveKeys([]); setResult(null);
    if (!key) return;
    setLoadingTheirs(true);
    try { const d = await api.get(`/yahoo/team/${key}/roster`, { params: { leagueKey } }); setTheirRoster(d.data.players || []); }
    catch (err) { setError(err.response?.data?.error || 'Could not load that roster'); }
    finally { setLoadingTheirs(false); }
  }
  const toggle = (list, setter) => (k) => setter(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  async function analyze() {
    setAnalyzing(true); setError(''); setResult(null);
    try { const d = await api.post(`/yahoo/league/${leagueKey}/trade/analyze`, { myTeamKey: data.connection.teamKey, theirTeamKey, sendKeys, receiveKeys }); setResult(d.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not analyze trade'); }
    finally { setAnalyzing(false); }
  }
  const Picker = ({ title, players, selected, onToggle }) => (
    <div className="card p-0"><div className="border-b border-dark-700 px-4 py-3"><h3 className="text-sm font-semibold">{title}</h3></div>
      <div className="max-h-72 overflow-y-auto">{players.length ? players.map((p) => {
        const key = p.playerKey || p.id; const sel = selected.includes(key);
        return <div key={key} className={`flex w-full items-center justify-between gap-3 border-b border-dark-700 px-4 py-2.5 last:border-0 ${sel ? 'bg-primary-600/15' : 'hover:bg-dark-900'}`}><div className="min-w-0"><PlayerLink player={p} avatarSize="h-8 w-8" className={sel ? 'text-primary-300' : ''}>{p.name}</PlayerLink><p className="pl-10 text-xs text-dark-400">{p.teamAbbr || 'FA'} · {(p.eligiblePositions || []).join('/') || p.primaryPosition}</p></div><button type="button" onClick={() => onToggle(key)} aria-pressed={sel} aria-label={`${sel ? 'Remove' : 'Select'} ${p.name}`} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border text-xs ${sel ? 'border-primary-400 bg-primary-500 text-white' : 'border-dark-600 text-transparent hover:border-primary-400'}`}>✓</button></div>;
      }) : <p className="px-4 py-6 text-center text-sm text-dark-500">No players.</p>}</div>
    </div>
  );
  const ASSESS = { improves: ['Improves projected output', 'badge-green'], neutral: ['Approximately neutral', 'badge-blue'], reduces: ['Reduces projected output', 'badge-red'], unknown: ['Projection data unavailable', 'badge-orange'] };
  const recs = data.recommendedTrades;
  const FAIR = { balanced: 'badge-green', 'plausible starting point': 'badge-blue', 'favors their side': 'badge-orange' };
  return (
    <div className="space-y-5">
      {error && <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}

      {/* ProGM AI trade recommender (found for you, not fabricated). */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="mr-auto text-xl font-bold">ProGM trade ideas</h2><span className="badge-blue">Real rosters</span><span className="badge-orange">Acceptance not predicted</span></div>
        {recs && !recs.available && <div className="card border-orange-500/30 text-sm text-dark-300">{recs.reason}</div>}
        {recs?.available && !recs.recommendations.length && <div className="card text-sm text-dark-400">No trade clearly improves your team right now without being lopsided. ProGM will not suggest a move just to churn.</div>}
        {recs?.available && recs.recommendations.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-2">{recs.recommendations.map((t, i) => (
            <div key={i} className="card space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-dark-300">with {t.withTeam}</span>
                <div className="flex items-center gap-1.5">
                  {t.production?.net != null && <span className="badge-green">+{t.production.net} to you</span>}
                  <span className={FAIR[t.fairness] || 'badge-orange'}>{t.fairness}</span>
                </div>
              </div>
              <div className="flex items-stretch justify-between gap-2 text-sm">
                <div className="min-w-0 flex-1"><p className="text-[10px] uppercase text-red-400">You send</p>{t.send.map((p) => <PlayerLink key={p.id || p.playerKey} player={p} avatarSize="h-7 w-7" className="mt-1 flex">{p.name}</PlayerLink>)}</div>
                <span className="self-center text-dark-500">↔</span>
                <div className="min-w-0 flex-1 text-right"><p className="text-[10px] uppercase text-green-400">You receive</p>{t.receive.map((p) => <PlayerLink key={p.id || p.playerKey} player={p} avatarSize="h-7 w-7" className="mt-1 flex">{p.name}</PlayerLink>)}</div>
              </div>
              {t.whyForMe?.length > 0 && <div className="border-t border-dark-700 pt-2"><p className="text-xs text-dark-300">{t.whyForMe[0]}</p>{t.whyForMe.length > 1 && <SecondaryDetails label="More reasons" className="mt-2">{t.whyForMe.slice(1, 3).map((reason) => <p key={reason}>· {reason}</p>)}</SecondaryDetails>}</div>}
              {t.risks?.length > 0 && <p className="text-[11px] text-orange-300/80">Risk: {t.risks[0]}</p>}
              <p className="text-[11px] text-dark-500">Confidence {Math.round((t.confidence ?? 0) * 100)}% · based on how much of the package has projection data.</p>
            </div>))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dark-700 pt-5"><h2 className="text-xl font-bold">Analyze a specific trade</h2><span className="badge-blue">Projected assessment</span></div>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm text-dark-300">Trade with</label><select value={theirTeamKey} onChange={(e) => pickOpponent(e.target.value)} className="input-field max-w-xs"><option value="">Select a team…</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Picker title="You send" players={myRoster} selected={sendKeys} onToggle={toggle(sendKeys, setSendKeys)} />
        {theirTeamKey ? (loadingTheirs ? <div className="card text-dark-400">Loading roster…</div> : <Picker title="You receive" players={theirRoster} selected={receiveKeys} onToggle={toggle(receiveKeys, setReceiveKeys)} />) : <div className="card flex items-center justify-center text-sm text-dark-500">Select a team to trade with.</div>}
      </div>
      <button onClick={analyze} disabled={!theirTeamKey || (!sendKeys.length && !receiveKeys.length) || analyzing} className="btn-primary disabled:opacity-40">{analyzing ? 'Analyzing…' : 'Analyze trade'}</button>
      {result && (
        <section className="space-y-4">
          {result.valuation && (
            <div className="card"><div className="flex items-center justify-between"><p className="font-semibold">Trade assessment</p><span className={ASSESS[result.valuation.assessment]?.[1] || 'badge-orange'}>{ASSESS[result.valuation.assessment]?.[0]}</span></div>
              {result.valuation.production && <div className="mt-3 grid grid-cols-3 gap-3 text-center"><div><p className="text-xs text-dark-400">Give</p><p className="font-bold">{result.valuation.production.sendTotal}</p></div><div><p className="text-xs text-dark-400">Receive</p><p className="font-bold">{result.valuation.production.receiveTotal}</p></div><div><p className="text-xs text-dark-400">Net</p><p className={`font-bold ${result.valuation.production.net > 0 ? 'text-green-400' : result.valuation.production.net < 0 ? 'text-red-400' : ''}`}>{result.valuation.production.net > 0 ? '+' : ''}{result.valuation.production.net}</p></div></div>}
              {result.valuation.reasons?.length > 0 && <ul className="mt-3 space-y-0.5 border-t border-dark-700 pt-3">{result.valuation.reasons.map((r, i) => <li key={i} className="text-xs text-dark-400">· {r}</li>)}</ul>}
              {result.valuation.note && <SecondaryDetails label="Assessment method" className="mt-3">{result.valuation.note}</SecondaryDetails>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// --- Tab: Rankings ---
function Rankings({ data }) {
  const r = data.rankings;
  const [sortBy, setSortBy] = useState(data.scheduleAware ? 'period' : 'projected');
  if (!r) return <section className="card text-dark-400">Rankings unavailable.</section>;
  if (!r.projectionsAvailable) return <section className="card border-orange-500/30"><h2 className="text-xl font-bold">Player rankings</h2><p className="mt-2 text-dark-300">{r.note}</p></section>;
  const players = [...(r.players || [])].sort((a, b) => {
    if (sortBy === 'owned') return (b.percentOwned ?? -1) - (a.percentOwned ?? -1);
    if (sortBy === 'period') return (b.periodProjected ?? -1) - (a.periodProjected ?? -1);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return (b.projected ?? -1) - (a.projected ?? -1);
  });
  const cols = [['projected', 'Proj/gm'], data.scheduleAware && ['period', 'This period'], ['owned', 'Owned'], ['name', 'Name']].filter(Boolean);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-dark-400">Sort by</span>
        {cols.map(([k, l]) => <button key={k} onClick={() => setSortBy(k)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${sortBy === k ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:text-dark-50'}`}>{l}</button>)}
      </div>
      <section className="card overflow-x-auto p-0">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="border-b border-dark-700 text-left text-xs uppercase text-dark-400"><tr><th className="p-3">#</th><th className="p-3">Player</th><th className="p-3 text-right">Proj/gm</th>{data.scheduleAware && <th className="p-3 text-right">Period</th>}<th className="p-3 text-right">Owned</th></tr></thead>
          <tbody>{players.map((p, i) => (
            <tr key={p.playerKey} className="border-b border-dark-700 hover:bg-dark-900">
              <td className="p-3 text-dark-400">{i + 1}</td>
              <td className="p-3"><PlayerLink player={p}>{p.name}</PlayerLink><p className="text-xs text-dark-400">{p.teamAbbr || 'FA'} · {p.eligiblePositions?.join('/')}</p></td>
              <td className="p-3 text-right"><Proj value={p.projected} /></td>
              {data.scheduleAware && <td className="p-3 text-right">{p.periodProjected != null ? <span className="font-bold text-primary-400">{p.periodProjected.toFixed(1)}</span> : <span className="text-dark-500">—</span>}{p.expectedGames != null && <span className="ml-1 text-xs text-dark-500">({p.expectedGames}g)</span>}</td>}
              <td className="p-3 text-right text-dark-300">{p.percentOwned != null ? `${p.percentOwned}%` : '—'}</td>
            </tr>))}
          </tbody>
        </table>
      </section>
      <SecondaryDetails label="Ranking method">{r.note}</SecondaryDetails>
    </div>
  );
}

// Live Yahoo draft sync hook. Polls /basketball/draft every ~5s while the Draft
// Helper tab is open AND the draft is active. Read-only: never writes to Yahoo.
// - No overlapping requests (in-flight guard).
// - Stops polling when the tab closes/unmounts, or when the draft is complete,
//   or on predraft (nothing to sync yet).
// - Reconnect-safe: the server de-dupes picks by player_key, and we drive
//   detection off the known pick count so refresh never double-counts.
const DRAFT_POLL_MS = 5000;

function useLiveDraft({ leagueKey, teamKey, active }) {
  const [sync, setSync] = useState({ status: 'idle', draftState: null, picks: [], myRoster: [], recommendations: null, newPicks: [], error: null, lastSyncAt: null, totalPicks: 0 });

  useEffect(() => {
    if (!active || !leagueKey) return undefined;
    let cancelled = false;
    let inFlight = false;
    let timer = null;
    let knownPicks = 0;

    async function poll() {
      if (cancelled || inFlight) return; // never overlap requests
      inFlight = true;
      try {
        const r = await api.get('/basketball/draft', { params: { leagueKey, teamKey, knownPicks } });
        if (cancelled) return;
        const d = r.data;
        knownPicks = d.totalPicks ?? knownPicks;
        setSync({
          status: d.draftState === 'complete' ? 'complete' : d.draftState === 'live' ? 'live' : 'waiting',
          draftState: d.draftState,
          picks: d.picks || [],
          myRoster: d.myRoster || [],
          recommendations: d.recommendations || null,
          newPicks: d.newPicks || [],
          totalPicks: d.totalPicks ?? 0,
          error: null,
          lastSyncAt: new Date().toISOString(),
        });
        // Stop polling once the draft is over — nothing more will change.
        if (d.draftState === 'complete') { cancelled = true; return; }
      } catch (err) {
        if (!cancelled) setSync((s) => ({ ...s, status: 'error', error: err.response?.data?.error || 'Draft sync error' }));
      } finally {
        inFlight = false;
        if (!cancelled) timer = setTimeout(poll, DRAFT_POLL_MS);
      }
    }
    setSync((s) => ({ ...s, status: 'connecting' }));
    poll();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [leagueKey, teamKey, active]);

  return sync;
}

// Status banner: LIVE / waiting / complete / sync error / connecting.
function LiveDraftBanner({ live }) {
  const map = {
    connecting: ['badge-blue', 'Connecting to your Yahoo draft…'],
    live: ['badge-green', `LIVE · ${live.totalPicks} pick${live.totalPicks === 1 ? '' : 's'} made`],
    waiting: ['badge-orange', 'Waiting for the draft to start…'],
    complete: ['badge-blue', 'Draft complete'],
    error: ['badge-red', live.error || 'Draft sync error'],
    idle: ['badge-orange', 'Draft sync idle'],
  };
  const [cls, label] = map[live.status] || map.idle;
  const pulsing = live.status === 'live' || live.status === 'connecting';
  return (
    <div className="flex items-center justify-between rounded-lg border border-dark-700 bg-dark-900 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${live.status === 'live' ? 'bg-green-400' : live.status === 'error' ? 'bg-red-400' : 'bg-dark-500'} ${pulsing ? 'animate-pulse' : ''}`} />
        <span className={cls}>{label}</span>
        {live.newPicks?.length > 0 && live.status === 'live' && <span className="text-xs text-green-400">+{live.newPicks.length} new</span>}
      </div>
      {live.lastSyncAt && <span className="text-xs text-dark-500">synced {new Date(live.lastSyncAt).toLocaleTimeString()}</span>}
    </div>
  );
}

// The user's drafted roster-so-far during a live draft (pick #, round).
function LiveDraftRoster({ live }) {
  if (!live.myRoster?.length) return (
    <section className="card"><h3 className="text-sm font-bold">Your draft picks</h3><p className="mt-1 text-xs text-dark-400">No picks yet — your selections will appear here as the draft progresses.</p></section>
  );
  return (
    <section className="card">
      <h3 className="text-sm font-bold">Your draft picks <span className="text-dark-500">({live.myRoster.length})</span></h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {live.myRoster.map((p) => (
          <span key={p.playerKey} className="rounded-lg border border-dark-700 bg-dark-800 px-2.5 py-1 text-xs">
            <span className="text-dark-500">R{p.round ?? '?'} P{p.pick ?? '?'}</span> · {p.playerKey}
          </span>
        ))}
      </div>
    </section>
  );
}

// --- Tab: Draft Helper (research tool + LIVE Yahoo draft sync) ---
function DraftHelper({ data, leagueKey, active }) {
  const live = useLiveDraft({ leagueKey, teamKey: data.connection?.teamKey, active });
  const isLive = live.draftState === 'live' || live.draftState === 'complete';
  // When a live draft is active, the recommendations come from the live sync
  // (undrafted pool, recomputed after each pick). Otherwise fall back to the
  // existing offseason/static Draft Helper board — preserving current behavior.
  const db = isLive && live.recommendations ? live.recommendations : data.draftBoard;

  const [q, setQ] = useState('');
  const [pos, setPos] = useState('ALL');
  const [avail, setAvail] = useState('ALL');
  const [sortBy, setSortBy] = useState('value');

  const liveBanner = <LiveDraftBanner live={live} />;

  if (!db) return <section className="space-y-4">{liveBanner}<section className="card text-dark-400">Draft Helper unavailable.</section></section>;
  if (!db.available) return (
    <section className="space-y-4">{liveBanner}<section className="card border-orange-500/30"><h2 className="text-xl font-bold">Draft Helper</h2><p className="mt-2 text-dark-300">{db.note}</p></section></section>
  );

  const positions = ['ALL', ...Array.from(new Set((db.board || []).flatMap((p) => p.eligiblePositions || []))).sort()];
  let rows = [...(db.board || [])];
  if (q.trim()) { const s = q.trim().toLowerCase(); rows = rows.filter((p) => p.name.toLowerCase().includes(s) || (p.teamAbbr || '').toLowerCase().includes(s)); }
  if (pos !== 'ALL') rows = rows.filter((p) => (p.eligiblePositions || []).includes(pos));
  if (db.availabilityKnown && avail !== 'ALL') rows = rows.filter((p) => p.availability === avail);
  rows.sort((a, b) => {
    if (sortBy === 'projected') return (b.projected ?? -1) - (a.projected ?? -1);
    if (sortBy === 'period') return (b.periodProjected ?? -1) - (a.periodProjected ?? -1);
    if (sortBy === 'scarcity') return (b.scarcity ?? -1) - (a.scarcity ?? -1);
    if (sortBy === 'owned') return (b.percentOwned ?? -1) - (a.percentOwned ?? -1);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return (b.value ?? -1) - (a.value ?? -1); // default: ProGM value
  });

  const AVAIL_BADGE = { available: 'badge-green', rostered: 'badge-blue', unknown: 'badge-orange' };
  const FIT_BADGE = { need: 'badge-green', surplus: 'badge-orange', neutral: 'text-dark-400' };
  const hasPeriod = data.scheduleAware;
  const sortBtns = [['value', 'ProGM value'], ['projected', 'Proj/gm'], hasPeriod && ['period', 'Period'], ['scarcity', 'Scarcity'], ['owned', 'Owned'], ['name', 'Name']].filter(Boolean);

  return (
    <div className="space-y-4">
      {liveBanner}
      <div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-xl font-bold">Draft Helper</h2><span className="badge-blue">League-specific</span>{isLive && <span className="badge-green">Read-only live board</span>}</div>
        {isLive ? <p className="mt-1 text-xs text-dark-400">Recomputed after every pick.</p> : <SecondaryDetails label="Board method" className="mt-2">{db.note}</SecondaryDetails>}
      </div>

      {isLive && <LiveDraftRoster live={live} />}

      {/* Research vs available-to-acquire is made explicit. */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search player or team…" className="input-field max-w-xs" />
        <select value={pos} onChange={(e) => setPos(e.target.value)} className="input-field max-w-[10rem]">{positions.map((p) => <option key={p} value={p}>{p === 'ALL' ? 'All positions' : p}</option>)}</select>
        {db.availabilityKnown && (
          <div className="flex gap-1">
            {[['ALL', 'All'], ['available', 'Available to acquire'], ['rostered', 'Rostered']].map(([k, l]) => (
              <button key={k} onClick={() => setAvail(k)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${avail === k ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:text-dark-50'}`}>{l}</button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-dark-400">Sort by</span>
        {sortBtns.map(([k, l]) => <button key={k} onClick={() => setSortBy(k)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${sortBy === k ? 'bg-primary-600 text-white' : 'bg-dark-800 text-dark-300 hover:text-dark-50'}`}>{l}</button>)}
      </div>

      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-dark-700 text-left text-xs uppercase text-dark-400"><tr>
            <th className="p-3">ProGM Rank</th><th className="p-3">Player</th><th className="p-3">Tier</th>
            <th className="p-3 text-right">Yahoo Rank</th><th className="p-3 text-right">Yahoo ADP</th><th className="p-3 text-right">Season Rank</th><th className="p-3">Comparison</th>
            <th className="p-3 text-right">Value</th><th className="p-3 text-right">Proj/gm</th>
            {hasPeriod && <th className="p-3 text-right">Period</th>}
            <th className="p-3 text-right">Scarcity</th><th className="p-3">Fit</th>
            {db.availabilityKnown && <th className="p-3">Availability</th>}
            <th className="p-3 text-right">Owned</th><th className="p-3 text-right">Conf</th>
          </tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.playerKey} className="border-b border-dark-700 hover:bg-dark-900">
              <td className="p-3 text-dark-400">{p.overallRank}</td>
              <td className="p-3"><div className="flex items-center gap-2"><PlayerLink player={p}>{p.name}</PlayerLink>{p.out && <span className="badge-red">OUT</span>}</div><p className="pl-11 text-xs text-dark-400">{p.teamAbbr || 'FA'} · {p.eligiblePositions?.join('/')}</p></td>
              <td className="p-3"><span className="badge-blue">T{p.tier}</span></td>
              <td className="p-3 text-right text-dark-300">{p.yahooOverallRank ?? '—'}</td>
              <td className="p-3 text-right text-dark-300">{p.yahooAdp ?? '—'}</td>
              <td className="p-3 text-right text-dark-300">{p.yahooSeasonRank ?? '—'}</td>
              <td className="p-3"><span className="text-xs text-dark-300" title={p.rankReason}>{p.rankAgreement === 'progm_higher' ? 'ProGM higher' : p.rankAgreement === 'yahoo_higher' ? 'Yahoo higher' : p.rankAgreement === 'progm_lean' ? 'ProGM lean' : p.rankAgreement === 'yahoo_lean' ? 'Yahoo lean' : p.rankAgreement === 'aligned' ? 'Agreement' : '—'}</span></td>
              <td className="p-3 text-right font-bold text-primary-400">{p.value?.toFixed(1)}</td>
              <td className="p-3 text-right"><Proj value={p.projected} /></td>
              {hasPeriod && <td className="p-3 text-right">{p.periodProjected != null ? <span className="text-primary-400">{p.periodProjected.toFixed(1)}</span> : <span className="text-dark-500">—</span>}{p.expectedGames != null && <span className="ml-1 text-xs text-dark-500">({p.expectedGames}g)</span>}</td>}
              <td className="p-3 text-right text-dark-300">{p.scarcity != null ? `×${p.scarcity.toFixed(2)}` : '—'}</td>
              <td className="p-3"><span className={FIT_BADGE[p.rosterFit] || 'text-dark-400'} title={p.rosterFitLabel}>{p.rosterFit === 'need' ? 'Need' : p.rosterFit === 'surplus' ? 'Surplus' : '—'}</span></td>
              {db.availabilityKnown && <td className="p-3"><span className={AVAIL_BADGE[p.availability]}>{p.availability === 'available' ? 'Available' : p.availability === 'rostered' ? 'Rostered' : 'Unknown'}</span></td>}
              <td className="p-3 text-right text-dark-300">{p.percentOwned != null ? `${p.percentOwned}%` : '—'}</td>
              <td className="p-3 text-right text-dark-300">{p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}</td>
            </tr>))}
          </tbody>
        </table>
        {!rows.length && <p className="p-8 text-center text-dark-400">No players match your filters.</p>}
      </section>

      {db.noData?.length > 0 && (
        <section className="card">
          <h3 className="text-sm font-bold">No projection data ({db.noData.length})</h3>
          <p className="mt-1 text-xs text-dark-500">Unranked rather than zeroed.</p>
          <SecondaryDetails label="Show players" className="mt-2">{db.noData.slice(0, 30).map((p) => p.name).join(', ')}{db.noData.length > 30 ? ` +${db.noData.length - 30} more` : ''}</SecondaryDetails>
        </section>
      )}
    </div>
  );
}

// --- Tab: League Hub ---
function LeagueHub({ data }) {
  const hub = data.leagueHub;
  if (!hub?.available) return <section className="card text-dark-400">{hub?.note || 'League hub unavailable.'}</section>;
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section className="card">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Standings</h2><span className="badge-blue">Yahoo</span></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-sm">
          <thead className="border-b border-dark-600 text-left text-dark-400"><tr><th className="pb-2">#</th><th className="pb-2">Team</th><th className="pb-2 text-right">Record</th><th className="pb-2 text-right">PF</th></tr></thead>
          <tbody>{hub.standings.map((t) => (
            <tr key={t.teamKey} className={`border-b border-dark-700 ${t.isMine ? 'bg-primary-600/10' : ''}`}>
              <td className="py-2 font-bold text-dark-400">{t.rank ?? '—'}</td>
              <td className="py-2">{t.name}{t.isMine && <span className="badge-blue ml-2">You</span>}</td>
              <td className="py-2 text-right">{t.wins}-{t.losses}{t.ties ? `-${t.ties}` : ''}</td>
              <td className="py-2 text-right text-primary-400">{t.pointsFor != null ? Math.round(t.pointsFor).toLocaleString() : '—'}</td>
            </tr>))}
          </tbody></table></div>
      </section>
      <section className="card">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Power Ranking</h2><span className="badge-blue">65% record · 35% scoring</span></div>
        {hub.powerRankings.length ? (
          <div className="mt-4 space-y-2">{hub.powerRankings.map((t) => (
            <div key={t.teamKey} className={`flex items-center justify-between rounded-lg border border-dark-700 px-4 py-2.5 ${t.isMine ? 'bg-primary-600/10' : 'bg-dark-900'}`}>
              <div className="flex items-center gap-3"><span className="text-lg font-black text-dark-500">{t.powerRank}</span><div><p className="font-semibold">{t.name}{t.isMine && <span className="badge-blue ml-2">You</span>}</p><p className="text-xs text-dark-400">Win% {(t.winPct * 100).toFixed(0)}%</p></div></div>
              <span className="stat-value text-lg">{t.powerScore.toFixed(1)}</span>
            </div>))}
          </div>
        ) : <p className="mt-4 text-sm text-dark-400">{hub.note}</p>}
      </section>
    </div>
  );
}

// --- Tab: Ask ProGM (basketball context) ---
function AskProGM({ data }) {
  const [messages, setMessages] = useState([{ role: 'gm', text: `${data.connection.teamName} is loaded. Ask about a lineup, waiver, trade, or roster decision.` }]);
  const [text, setText] = useState(''); const [sending, setSending] = useState(false); const [error, setError] = useState('');
  async function send(value = text) {
    const clean = value.trim().slice(0, 800); if (!clean || sending) return;
    const next = [...messages, { role: 'user', text: clean }]; setMessages(next); setText(''); setError(''); setSending(true);
    try { const r = await api.post('/gm/chat', { messages: next.slice(-10), league: basketballContext(data) }); setMessages((m) => [...m, { role: 'gm', text: r.data.message }]); }
    catch (err) { setError(err.response?.data?.error || 'Ask ProGM could not respond.'); }
    finally { setSending(false); }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="card p-0"><div className="border-b border-dark-700 px-4 py-3"><p className="font-bold">ProGM Assistant</p><p className="text-xs text-green-400">● Explains ProGM basketball analytics</p></div>
        <div className="h-[52vh] min-h-[340px] space-y-4 overflow-y-auto p-4">{messages.map((m, i) => <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${m.role === 'user' ? 'rounded-br-sm bg-primary-600 text-white' : 'rounded-bl-sm border border-dark-700 bg-dark-900 text-dark-200'}`}>{m.text}</div></div>)}{sending && <div className="text-sm text-primary-400">Thinking…</div>}{error && <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}</div>
        <div className="border-t border-dark-700 p-4"><form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2"><input className="input-field" value={text} maxLength={800} onChange={(e) => setText(e.target.value)} placeholder="Ask about your lineup, waivers, or a trade…" /><button className="btn-primary shrink-0 disabled:opacity-50" disabled={!text.trim() || sending}>Send</button></form></div>
      </section>
    </div>
  );
}

// Structured basketball analytics context for Gemini (explanation-only).
// Gemini never invents trades, values, or stats — it only explains the
// ProGM-computed recommendations packed into this context. Every field here is
// produced by a ProGM engine (or is a Yahoo fact); nothing is fabricated.
export function basketballContext(data) {
  const slim = (p) => ({ name: p?.name, position: p?.position, team: p?.teamAbbr, projected: p?.projectedPoints, injury: p?.injuryStatus, ownedPct: p?.percentOwned, starting: p?.isStarting });
  return {
    sport: 'basketball', league: data.connection?.leagueName, season: data.connection?.season, myTeam: data.connection?.teamName,
    settings: data.settings, analysis: data.analysis, rating: data.rating,
    roster: (data.myTeam?.roster || []).map(slim),
    standings: data.standings,
    lineupRecommendation: data.lineup ? { projectedCurrent: data.lineup.projectedCurrentPoints, projectedOptimized: data.lineup.projectedOptimizedPoints, difference: data.lineup.projectedDifference, swaps: (data.lineup.swaps || []).map((s) => ({ start: s.in?.name, bench: s.out?.name, gain: s.projectedGain })) } : null,
    // Schedule-aware start/sit calls (ProGM), when produced by the engine.
    startSit: data.startSit?.benchOverStarter?.length
      ? { scheduleAware: data.startSit.scheduleAware, calls: data.startSit.benchOverStarter.slice(0, 6).map((s) => ({ start: s.start?.name, sit: s.sit?.name, gain: s.gain, note: s.reason })) }
      : null,
    waivers: data.waivers?.projectionsAvailable ? {
      bestAvailable: (data.waivers.bestAvailable || []).slice(0, 8).map(slim),
      bestFit: (data.waivers.bestFit || []).slice(0, 8).map((p) => ({ ...slim(p), fitScore: p.fitScore })),
      // Paired add/drop moves (ProGM), never an add without a considered drop.
      addDrop: (data.waivers.addDrop || []).slice(0, 6).map((m) => ({ add: m.add?.name, drop: m.drop?.name || null, net: m.netImprovement, category: m.category })),
    } : null,
    // AI trade recommender candidates (ProGM-generated + scored, not Gemini).
    recommendedTrades: (data.recommendedTrades?.recommendations || []).slice(0, 6).map((t) => ({
      with: t.withTeam,
      youSend: (t.send || []).map((p) => p.name),
      youReceive: (t.receive || []).map((p) => p.name),
      myImprovement: t.production?.net ?? null,
      fairness: t.fairness,
      confidence: t.confidence,
    })),
    // Player rankings (ProGM), top slice for reference.
    rankingsTop: (data.rankings?.players || []).slice(0, 15).map((p) => ({ rank: p.rank, name: p.name, projected: p.projected, period: p.periodProjected })),
    // Draft Helper board top slice (ProGM value + fit + availability), for
    // explanation only — Gemini must not invent rankings or values.
    draftBoardTop: (data.draftBoard?.board || []).slice(0, 15).map((p) => ({ rank: p.overallRank, name: p.name, value: p.value, tier: p.tier, fit: p.rosterFit, availability: p.availability })),
    leagueHub: data.leagueHub ? { powerRankings: (data.leagueHub.powerRankings || []).map((t) => ({ rank: t.powerRank, name: t.name, score: t.powerScore })) } : null,
    recommendations: data.intelligence?.recommendations,
    dataAvailable: data.externalData?.available,
  };
}

export default function BasketballWorkspace() {
  const { section = 'overview' } = useParams();
  const navigate = useNavigate();
  const active = SECTIONS.some(([k]) => k === section) ? section : 'overview';

  const [leagues, setLeagues] = useState(null);
  const [leagueKey, setLeagueKey] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const workspaceRequest = useRef(0);

  useEffect(() => {
    // Send the remembered in-session selection so the server can honor it —
    // unless a newer season has appeared, in which case it returns that as the
    // default. This keeps a stale pick from blocking a newer season.
    let remembered = null;
    try { remembered = sessionStorage.getItem('progm-bball-league'); } catch { /* ignore */ }
    const controller = new AbortController();
    api.get('/basketball/leagues', { params: remembered ? { selected: remembered } : {}, signal: controller.signal })
      .then((r) => {
        const currentLeagues = r.data.leagues || [];
        const nextKey = r.data.defaultLeagueKey || currentLeagues[0]?.leagueKey || '';
        setLeagues(currentLeagues);
        setLeagueKey(nextKey);
        try { if (nextKey) sessionStorage.setItem('progm-bball-league', nextKey); else sessionStorage.removeItem('progm-bball-league'); } catch { /* ignore */ }
        if (!nextKey) setLoading(false);
      })
      .catch((err) => { if (err.code !== 'ERR_CANCELED') { setError(err.response?.data?.error || 'Connect Yahoo to load your basketball leagues.'); setLoading(false); } });
    return () => controller.abort();
  }, []);

  function selectLeague(key) {
    if (!key || key === leagueKey) return;
    workspaceRequest.current += 1;
    setData(null);
    setError('');
    setLoading(true);
    setLeagueKey(key);
    try { sessionStorage.setItem('progm-bball-league', key); } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!leagueKey) return undefined;
    const requestId = ++workspaceRequest.current;
    const controller = new AbortController();
    setLoading(true); setError('');
    api.get('/basketball/workspace', { params: { leagueKey }, signal: controller.signal })
      .then((r) => { if (requestId === workspaceRequest.current) setData(r.data); })
      .catch((err) => { if (err.code !== 'ERR_CANCELED' && requestId === workspaceRequest.current) setError(err.response?.data?.error || 'Could not load Fantasy Basketball'); })
      .finally(() => { if (!controller.signal.aborted && requestId === workspaceRequest.current) setLoading(false); });
    return () => controller.abort();
  }, [leagueKey]);

  if (loading && !data) return <div className="text-primary-400 animate-pulse">Loading your Fantasy Basketball…</div>;
  if (error && !data) return <div className="card max-w-2xl"><h1 className="text-2xl font-bold">Fantasy Basketball</h1><p className="mt-3 text-dark-300">{error}</p><Link to="/sync" className="btn-primary mt-5 inline-block">Sync your league</Link></div>;
  if (leagues && !leagues.length) return <div className="card max-w-2xl"><h1 className="text-2xl font-bold">No current-season leagues</h1><p className="mt-2 text-sm text-dark-400">Yahoo did not return an NBA league for its newest fantasy season.</p><Link to="/sync" className="btn-primary mt-5 inline-block">Check Yahoo connection</Link></div>;
  if (!data) return null;

  return (
    <BasketballPlayerProfileProvider key={leagueKey} data={data}>
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-primary-400">Fantasy Basketball</p>
          <h1 className="mt-1 text-3xl font-bold">{data.connection.teamName}</h1>
          <p className="mt-1 text-dark-400">{data.connection.leagueName} · {seasonLabelFrom(data.connection.season)}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          {leagues?.length > 1 && (
            <select value={leagueKey} onChange={(e) => selectLeague(e.target.value)} aria-label="Select fantasy basketball league" className="input-field w-full max-w-xs sm:w-auto">
              {leagues.map((l) => <option key={l.leagueKey} value={l.leagueKey}>{l.myTeam?.name || l.name} — {l.seasonLabel || l.season}</option>)}
            </select>
          )}
          <Freshness external={data.externalData} />
        </div>
      </header>

      <nav className="flex gap-5 overflow-x-auto border-b border-dark-700">
        {SECTIONS.map(([key, label]) => (
          <button key={key} onClick={() => navigate(`/basketball/${key}`)} className={`whitespace-nowrap border-b-2 px-0.5 py-3 text-sm font-semibold transition-colors ${active === key ? 'border-primary-500 text-primary-400' : 'border-transparent text-dark-400 hover:border-dark-600 hover:text-dark-50'}`}>{label}</button>
        ))}
      </nav>

      {active === 'overview' && <Overview data={data} />}
      {active === 'roster' && <Roster data={data} />}
      {active === 'start-sit' && <StartSit data={data} />}
      {active === 'trades' && <Trades data={data} leagueKey={leagueKey} />}
      {active === 'waivers' && <Waivers data={data} />}
      {active === 'rankings' && <Rankings data={data} />}
      {active === 'draft' && <DraftHelper data={data} leagueKey={leagueKey} active={active === 'draft'} />}
      {active === 'league' && <LeagueHub data={data} />}
      {active === 'gm' && <AskProGM data={data} />}
    </div>
    </BasketballPlayerProfileProvider>
  );
}
