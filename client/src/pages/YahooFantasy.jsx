import { useEffect, useState } from 'react';
import api from '../services/api';

export default function YahooFantasy() {
  const [status, setStatus] = useState(null);
  const [fantasy, setFantasy] = useState({ leagues: [], teams: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const statusRes = await api.get('/yahoo/status');
      setStatus(statusRes.data);
      if (statusRes.data.connected) {
        const fantasyRes = await api.get('/yahoo/fantasy');
        setFantasy(fantasyRes.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load Yahoo Fantasy data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function connect() {
    try {
      const res = await api.post('/yahoo/auth-url');
      window.location.assign(res.data.url);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start Yahoo connection');
    }
  }

  if (loading) return <div className="text-primary-400">Loading Yahoo Fantasy…</div>;

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">Yahoo Fantasy</h1>
          <p className="mt-2 text-dark-400">Your linked NBA leagues and teams.</p>
        </div>
        <div className="rounded-xl bg-[#6001d2] px-4 py-2 font-black text-white">Y!</div>
      </div>

      {error && <div className="mb-6 rounded-lg border border-red-700/50 bg-red-900/30 p-4 text-red-400">{error}</div>}

      {!status?.configured && (
        <div className="card max-w-2xl">
          <h2 className="text-xl font-semibold">Yahoo setup required</h2>
          <p className="mt-2 text-sm leading-6 text-dark-300">Add the Yahoo Consumer Key and Consumer Secret to the server environment, then restart the backend.</p>
        </div>
      )}

      {status?.configured && !status.connected && (
        <div className="card max-w-2xl text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-[#6001d2] text-2xl font-black">Y!</div>
          <h2 className="text-xl font-semibold">Connect Yahoo Fantasy</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-dark-300">Authorize read access so ProGM can display your basketball leagues and teams.</p>
          <button onClick={connect} className="mt-5 rounded-lg bg-[#6001d2] px-6 py-3 font-semibold text-white hover:bg-[#7b20e8]">Continue with Yahoo</button>
        </div>
      )}

      {status?.connected && (
        <div className="grid gap-8 xl:grid-cols-2">
          <section>
            <h2 className="mb-4 text-xl font-semibold">Leagues</h2>
            <div className="space-y-3">
              {fantasy.leagues.map(league => <div key={league.leagueKey} className="card"><h3 className="font-semibold text-white">{league.name}</h3><p className="mt-1 text-sm text-dark-400">{league.season} · {league.scoringType || 'NBA'} · {league.numTeams || '—'} teams</p></div>)}
              {!fantasy.leagues.length && <p className="text-dark-400">No NBA leagues were returned by Yahoo.</p>}
            </div>
          </section>
          <section>
            <h2 className="mb-4 text-xl font-semibold">Teams</h2>
            <div className="space-y-3">
              {fantasy.teams.map(team => <div key={team.teamKey} className="card"><h3 className="font-semibold text-white">{team.name}</h3><p className="mt-1 text-sm text-dark-400">Team ID {team.teamId}</p></div>)}
              {!fantasy.teams.length && <p className="text-dark-400">No NBA teams were returned by Yahoo.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
