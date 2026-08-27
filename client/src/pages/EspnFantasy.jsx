import { useEffect, useState } from 'react';
import api from '../services/api';

export default function EspnFantasy() {
  const [status, setStatus] = useState(null);
  const [names, setNames] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.get('/espn/status').then(res => setStatus(res.data)).catch(() => setStatus({ connected: false })); }, []);
  async function importRoster(e) {
    e.preventDefault(); setError(''); setMessage('');
    try {
      const res = await api.post('/espn/manual-import', { playerNames: names });
      setMessage(`Imported ${res.data.imported} matching players${res.data.unmatched.length ? `. ${res.data.unmatched.length} names were not in ProGM's player pool.` : '.'}`);
    } catch (err) { setError(err.response?.data?.error || 'Could not import roster'); }
  }
  return <div className="max-w-3xl">
    <div className="mb-8 flex items-start justify-between gap-4"><div><h1 className="text-3xl font-bold text-white">ESPN Fantasy</h1><p className="mt-2 text-dark-400">Public league sync and private league manual import.</p></div><div className="rounded-xl bg-red-600 px-4 py-2 text-xl font-black text-white">E</div></div>
    {error && <div className="mb-5 rounded-lg border border-red-700/50 bg-red-900/30 p-4 text-red-400">{error}</div>}
    {message && <div className="mb-5 rounded-lg border border-green-700/50 bg-green-900/30 p-4 text-green-400">{message}</div>}
    {status?.connected && <div className="card mb-6"><p className="text-xs uppercase tracking-wide text-dark-400">Connected public {status.connection.sport} league</p><h2 className="mt-2 text-xl font-semibold">{status.connection.league_name}</h2><p className="mt-1 text-dark-300">{status.connection.team_name} · {status.connection.season}</p>{status.connection.sport === 'football' && <p className="mt-3 text-sm text-amber-400">League and roster connected. ProGM's current player analysis is NBA-focused, so football trade analysis is not yet applied to your main roster.</p>}</div>}
    <form onSubmit={importRoster} className="card"><h2 className="text-xl font-semibold">Private league roster import</h2><p className="mt-2 text-sm leading-6 text-dark-300">ESPN does not offer third-party OAuth. Paste one player name per line; ProGM never asks for your ESPN password or session cookies.</p><textarea value={names} onChange={e => setNames(e.target.value)} rows="10" className="input-field mt-5" placeholder={'Luka Doncic\nJayson Tatum\nNikola Jokic'} required /><button className="btn-primary mt-4 px-6 py-3">Import roster</button></form>
  </div>;
}
