import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';

// Fantasy Basketball workspace — powered by Yahoo + Tank01 + ProGM analytics,
// rendered in the ProGM (.deploy-repo) design system. Yahoo is invisible
// infrastructure; the product surface is "Fantasy Basketball".

const SECTIONS = [
  ['overview', 'My Team'],
  ['roster', 'Roster'],
  ['start-sit', 'Start / Sit'],
  ['trades', 'Trades'],
  ['waivers', 'Waivers'],
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

function PlayerRow({ player, showProj = true }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dark-700 py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        {player.image ? <img src={player.image} alt="" className="h-9 w-9 rounded-full bg-dark-700 object-cover" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">{player.position}</span>}
        <div className="min-w-0">
          <p className="truncate font-semibold">{player.name}</p>
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
      {rating?.note && <p className="text-xs text-dark-500">{rating.note}</p>}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 text-xl font-bold">My roster</h2>
          {roster.map((p) => <PlayerRow key={p.id} player={p} />)}
        </section>
        <section className="card">
          <h2 className="text-xl font-bold">Standings</h2>
          <p className="mt-1 text-sm text-dark-400">Reported by Yahoo</p>
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
            <div className="mt-3 flex items-center justify-between gap-2 text-sm"><div><p className="text-[10px] uppercase text-green-400">Start</p><p className="font-semibold">{s.in?.name}</p><Proj value={s.in?.proj} /></div><span className="text-dark-500">↔</span><div className="text-right"><p className="text-[10px] uppercase text-red-400">Bench</p><p className="font-semibold">{s.out?.name || '—'}</p>{s.out && <Proj value={s.out?.proj} />}</div></div>
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
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-dark-700">
        {[['bestAvailable', 'Best Available'], ['bestFit', 'Best Fit']].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${view === k ? 'border-primary-500 text-primary-400' : 'border-transparent text-dark-400 hover:text-dark-50'}`}>{l}</button>
        ))}
      </div>
      <section className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-dark-700 text-left text-xs uppercase text-dark-400"><tr><th className="p-3">#</th><th className="p-3">Player</th><th className="p-3 text-right">{view === 'bestFit' ? 'Fit' : 'Proj'}</th><th className="p-3 text-right">Owned</th><th className="p-3 text-right">Status</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.playerKey} className="border-b border-dark-700 hover:bg-dark-900">
              <td className="p-3 text-dark-400">{p.rank}</td>
              <td className="p-3"><p className="font-semibold">{p.name}</p><p className="text-xs text-dark-400">{p.teamAbbr || 'FA'} · {p.eligiblePositions?.join('/')}{view === 'bestFit' && p.fitReason ? ` · ${p.fitReason}` : ''}</p></td>
              <td className="p-3 text-right">{view === 'bestFit' ? <span className="font-bold text-primary-400">{p.fitScore?.toFixed(1)}</span> : <Proj value={p.projectedPoints} />}</td>
              <td className="p-3 text-right text-dark-300">{p.percentOwned != null ? `${p.percentOwned}%` : '—'}</td>
              <td className="p-3 text-right"><StatusBadge status={p.status} /></td>
            </tr>))}
          </tbody>
        </table>
        {!rows.length && <p className="p-8 text-center text-dark-400">No ranked available players.</p>}
      </section>
      <p className="text-xs text-dark-500">Best Available ranks by projected league fantasy points. Best Fit adjusts for your roster's positional needs. Ownership % is context only, not a quality signal.</p>
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
        return <button key={key} onClick={() => onToggle(key)} className={`flex w-full items-center justify-between border-b border-dark-700 px-4 py-2.5 text-left last:border-0 ${sel ? 'bg-primary-600/15' : 'hover:bg-dark-900'}`}><div><p className={`text-sm font-medium ${sel ? 'text-primary-300' : ''}`}>{p.name}</p><p className="text-xs text-dark-400">{p.teamAbbr || 'FA'} · {(p.eligiblePositions || []).join('/') || p.primaryPosition}</p></div><span className={`flex h-5 w-5 items-center justify-center rounded border text-xs ${sel ? 'border-primary-400 bg-primary-500 text-white' : 'border-dark-600 text-transparent'}`}>✓</span></button>;
      }) : <p className="px-4 py-6 text-center text-sm text-dark-500">No players.</p>}</div>
    </div>
  );
  const ASSESS = { improves: ['Improves projected output', 'badge-green'], neutral: ['Approximately neutral', 'badge-blue'], reduces: ['Reduces projected output', 'badge-red'], unknown: ['Projection data unavailable', 'badge-orange'] };
  return (
    <div className="space-y-5">
      {error && <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">{error}</div>}
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
              <p className="mt-2 text-[11px] text-dark-500">{result.valuation.note}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// --- Tab: Ask ProGM (basketball context) ---
function AskProGM({ data }) {
  const [messages, setMessages] = useState([{ role: 'gm', text: `I'm your AI GM for ${data.connection.teamName}. I explain ProGM's basketball analysis — lineups, waivers, trades, and roster strengths. What are you weighing?` }]);
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
export function basketballContext(data) {
  const slim = (p) => ({ name: p?.name, position: p?.position, team: p?.teamAbbr, projected: p?.projectedPoints, injury: p?.injuryStatus, ownedPct: p?.percentOwned, starting: p?.isStarting });
  return {
    sport: 'basketball', league: data.connection?.leagueName, season: data.connection?.season, myTeam: data.connection?.teamName,
    settings: data.settings, analysis: data.analysis, rating: data.rating,
    roster: (data.myTeam?.roster || []).map(slim),
    standings: data.standings,
    lineupRecommendation: data.lineup ? { projectedCurrent: data.lineup.projectedCurrentPoints, projectedOptimized: data.lineup.projectedOptimizedPoints, difference: data.lineup.projectedDifference, swaps: (data.lineup.swaps || []).map((s) => ({ start: s.in?.name, bench: s.out?.name, gain: s.projectedGain })) } : null,
    waivers: data.waivers?.projectionsAvailable ? { bestAvailable: (data.waivers.bestAvailable || []).slice(0, 8).map(slim), bestFit: (data.waivers.bestFit || []).slice(0, 8).map((p) => ({ ...slim(p), fitScore: p.fitScore })) } : null,
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

  useEffect(() => {
    api.get('/basketball/leagues')
      .then((r) => {
        setLeagues(r.data.leagues || []);
        setLeagueKey((r.data.leagues || [])[0]?.leagueKey || '');
      })
      .catch((err) => { setError(err.response?.data?.error || 'Connect Yahoo to load your basketball leagues.'); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!leagueKey) return;
    setLoading(true); setError('');
    api.get('/basketball/workspace', { params: { leagueKey } })
      .then((r) => setData(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load Fantasy Basketball'))
      .finally(() => setLoading(false));
  }, [leagueKey]);

  if (loading && !data) return <div className="text-primary-400 animate-pulse">Loading your Fantasy Basketball…</div>;
  if (error && !data) return <div className="card max-w-2xl"><h1 className="text-2xl font-bold">Fantasy Basketball</h1><p className="mt-3 text-dark-300">{error}</p><Link to="/sync" className="btn-primary mt-5 inline-block">Sync your league</Link></div>;
  if (!data) return null;

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-primary-400">Fantasy Basketball</p>
          <h1 className="mt-1 text-3xl font-bold">{data.connection.teamName}</h1>
          <p className="mt-1 text-dark-400">{data.connection.leagueName} · {data.connection.season}</p>
        </div>
        <div className="flex items-center gap-3">
          {leagues?.length > 1 && (
            <select value={leagueKey} onChange={(e) => setLeagueKey(e.target.value)} className="input-field max-w-xs">
              {leagues.map((l) => <option key={l.leagueKey} value={l.leagueKey}>{l.name} · {l.season}</option>)}
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
      {active === 'gm' && <AskProGM data={data} />}
    </div>
  );
}
