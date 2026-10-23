import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import LoadingState from '../components/LoadingState';
import YahooAttribution from '../components/YahooAttribution';

// Daily front office. Surfaces REAL opportunities from ProGM's analytics for
// whichever leagues the user has connected. Football uses the ESPN workspace;
// Basketball uses the Yahoo + Tank01 + ProGM engines. Nothing is fabricated —
// a card only appears when the underlying engine produced it.

function nth(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return (s[(v - 20) % 10] || s[v] || s[0]); }

// Build opportunity cards + rating from a FOOTBALL (ESPN) workspace.
function footballOpportunities(data) {
  const lineup = data.startSitSuggestions?.[0];
  const waiver = data.waiverSuggestions?.[0];
  const trade = data.tradeTargets?.buyLow?.[0];
  const injury = data.myTeam.roster.find((p) => !['ACTIVE', 'NORMAL'].includes(p.injuryStatus));
  const cards = [
    lineup && { type: 'START', text: `${lineup.start.name} over ${lineup.sit.name}`, detail: `+${lineup.projectedGain.toFixed(1)} projected points`, to: '/football/start-sit', urgent: true },
    waiver && { type: 'ADD', text: `${waiver.name} for ${waiver.drop.name}`, detail: `${waiver.category} · +${waiver.netGain.toFixed(1)} projected`, to: '/football/waivers' },
    trade && { type: 'TARGET', text: `${trade.name} from ${trade.ownerTeam}`, detail: `Buy-low candidate · expert #${trade.proRank}`, to: '/football/trades' },
    injury && { type: 'WATCH', text: `${injury.name}'s ${injury.injuryStatus.toLowerCase()} status`, detail: 'Recheck before lineup lock', to: '/football/start-sit' },
  ].filter(Boolean);
  return { sport: 'Fantasy Football', team: data.connection.teamName, cards, rating: data.rating?.overall != null ? { overall: data.rating.overall, label: '/99' } : null, to: '/football/overview' };
}

// Build opportunity cards + rating from a BASKETBALL (Yahoo/Tank01/ProGM) workspace.
function basketballOpportunities(data) {
  const cards = [];
  const swap = data.lineup?.projectionsAvailable ? data.lineup.swaps?.[0] : null;
  if (swap && swap.out) cards.push({ type: 'START', text: `${swap.in.name} over ${swap.out.name}`, detail: swap.projectedGain != null ? `+${swap.projectedGain} projected pts/game` : 'Lineup upgrade', to: '/basketball/start-sit', urgent: true });
  const fit = data.waivers?.projectionsAvailable ? data.waivers.bestFit?.[0] : null;
  if (fit) cards.push({ type: 'ADD', text: `${fit.name}`, detail: `Best fit waiver · ${fit.projectedPoints?.toFixed?.(1) ?? '—'} proj`, to: '/basketball/waivers' });
  const injury = data.myTeam.roster.find((p) => p.injuryStatus && !['Healthy', 'ACTIVE', 'NORMAL'].includes(p.injuryStatus));
  if (injury) cards.push({ type: 'WATCH', text: `${injury.name} · ${injury.injuryStatus}`, detail: injury.injuryDetail || 'Check status before lock', to: '/basketball/roster' });
  // A ProGM-recommended trade (only when the recommender actually produced one).
  const trade = data.recommendedTrades?.recommendations?.[0];
  if (trade) {
    const send = (trade.send || []).map((p) => p.name).join(', ');
    const recv = (trade.receive || []).map((p) => p.name).join(', ');
    const improve = trade.production?.net;
    if (send && recv) cards.push({ type: 'TRADE', text: `${recv} for ${send}`, detail: `${trade.withTeam || 'Opponent'}${improve != null ? ` · +${Number(improve).toFixed(1)} to your team` : ''}`, to: '/basketball/trades' });
  }
  // A projection-backed roster recommendation (e.g. thin position) as a TARGET.
  const rec = data.intelligence?.recommendations?.find((r) => /thin|depth|surplus/i.test(r.recommendation));
  if (rec) cards.push({ type: 'TARGET', text: rec.recommendation, detail: rec.reasons?.[0] || 'Roster construction insight', to: '/basketball/overview' });
  const rating = data.rating?.available && data.rating.overall != null
    ? { overall: data.rating.overall, label: `/99 · ${data.rating.rank}${data.rating.rank ? nth(data.rating.rank) : ''} of ${data.rating.teamCount}` }
    : null;
  return { sport: 'Fantasy Basketball', team: data.connection.teamName, cards, rating, to: '/basketball/overview', external: data.externalData };
}

const TYPE_STYLE = {
  START: 'bg-green-900/20 text-green-400', ADD: 'bg-primary-900/10 text-primary-400',
  TARGET: 'bg-dark-900 text-dark-300', WATCH: 'bg-orange-900/20 text-orange-400',
  TRADE: 'bg-primary-900/10 text-primary-400',
};

export default function Home() {
  const { user } = useAuth();
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const found = [];
      // Football (ESPN) — optional.
      try { const r = await api.get('/espn/workspace/football'); found.push(footballOpportunities(r.data)); } catch { /* not connected */ }
      // Basketball (Yahoo) — use first league if connected.
      try {
        const lg = await api.get('/basketball/leagues');
        const first = lg.data.leagues?.[0];
        if (first) { const w = await api.get('/basketball/workspace', { params: { leagueKey: first.leagueKey } }); found.push(basketballOpportunities(w.data)); }
      } catch { /* not connected */ }
      if (!cancelled) { setSections(found); setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="space-y-5"><h1 className="text-3xl font-black">{greeting}, {user?.username || 'GM'}</h1><LoadingState label="Building your front-office briefing…" /></div>;

  if (!sections.length) return (
    <div className="space-y-5"><h1 className="text-3xl font-black">{greeting}, {user?.username || 'GM'}</h1>
      <section className="empty-state"><p>Connect a league to unlock your daily front office.</p><Link to="/sync" className="btn-primary mt-4">Sync a league</Link></section>
    </div>
  );

  const totalOpps = sections.reduce((n, s) => n + s.cards.length, 0);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-br from-primary-900/40 via-dark-800 to-dark-800 p-6 sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary-400">Your daily front office</p>
        <h1 className="mt-2 text-3xl font-black sm:text-4xl">{greeting}, {user?.username || 'GM'}</h1>
        <p className="mt-3 text-lg text-dark-300">ProGM found <strong className="text-dark-50">{totalOpps} opportunit{totalOpps === 1 ? 'y' : 'ies'}</strong> across your connected leagues.</p>
      </section>

      {sections.map((sec) => (
        <section key={sec.sport} className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold">{sec.sport}</h2>
              <p className="text-sm text-dark-400">{sec.team}</p>
            </div>
            {sec.rating ? (
              <Link to={sec.to} className="card-hover flex items-center gap-3 px-4 py-2"><div><p className="stat-label">Team rating</p><p className="text-2xl font-black">{sec.rating.overall}<span className="text-sm text-dark-500">{sec.rating.label}</span></p></div></Link>
            ) : <Link to={sec.to} className="btn-secondary">View team</Link>}
          </div>
          {sec.external && !sec.external.available && <p className="text-xs text-orange-400">Projection data unavailable — showing available facts only.</p>}
          {sec.cards.length ? (
            <div className="grid gap-4 lg:grid-cols-2">{sec.cards.map((item) => (
              <Link key={item.type} to={item.to} className={`card-hover flex items-start gap-4 ${item.urgent ? 'border-orange-500/50' : ''}`}>
                <span className={`rounded-lg px-3 py-2 text-xs font-black ${TYPE_STYLE[item.type]}`}>{item.type}</span>
                <div><p className="font-bold">{item.text}</p><p className="mt-1 text-sm text-dark-400">{item.detail}</p></div>
              </Link>))}
            </div>
          ) : <p className="text-sm text-dark-400">No actionable opportunities right now — your team looks set.</p>}
          {sec.sport === 'Fantasy Basketball' && <YahooAttribution size="sm" />}
        </section>
      ))}
    </div>
  );
}
