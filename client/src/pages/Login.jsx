import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [yahooStatus, setYahooStatus] = useState(null);
  const [yahooLoading, setYahooLoading] = useState(false);
  const [espnLeagueId, setEspnLeagueId] = useState('');
  const [espnSeason, setEspnSeason] = useState(String(new Date().getFullYear()));
  const [espnSport, setEspnSport] = useState('football');
  const [espnPreview, setEspnPreview] = useState(null);
  const [espnTeamId, setEspnTeamId] = useState('');
  const [espnLoading, setEspnLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('yahoo') === 'connected') setError('Yahoo account linked successfully.');
    if (params.get('yahoo') === 'pending' && params.get('claim')) {
      sessionStorage.setItem('yahooClaim', params.get('claim'));
      setError('Yahoo authorized successfully. Sign in or register to finish linking your fantasy account.');
    }
    if (params.get('yahoo') === 'error') setError(params.get('message') || 'Yahoo connection failed');
    if (localStorage.getItem('token')) {
      api.get('/yahoo/status').then(res => setYahooStatus(res.data)).catch(() => {});
    }
  }, []);

  async function connectYahoo() {
    setYahooLoading(true);
    setError('');
    try {
      const res = await api.post('/yahoo/auth-url');
      window.location.assign(res.data.url);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not start Yahoo connection');
      setYahooLoading(false);
    }
  }

  async function previewEspn() {
    setEspnLoading(true); setError('');
    try {
      const res = await api.post('/espn/preview', { leagueId: espnLeagueId, season: espnSeason, sport: espnSport });
      setEspnPreview(res.data);
      setEspnSport(res.data.sport);
      setEspnSeason(String(res.data.season));
      setEspnTeamId(String(res.data.suggestedTeamId || res.data.teams[0]?.id || ''));
    } catch (err) { setError(err.response?.data?.error || 'Could not load ESPN league'); }
    finally { setEspnLoading(false); }
  }

  function saveEspnTeam() {
    if (!espnTeamId) return setError('Select your ESPN team');
    sessionStorage.setItem('espnPending', JSON.stringify({ leagueId: espnPreview.leagueId, season: espnPreview.season, sport: espnPreview.sport, teamId: Number(espnTeamId) }));
    setError('ESPN team selected successfully. Sign in or register to attach it to your ProGM account.');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let authResult;
      if (isRegister) {
        const res = await api.post('/auth/register', { email, password });
        authResult = res.data;
        login(res.data.token, res.data.user);
      } else {
        const res = await api.post('/auth/login', { username, password });
        authResult = res.data;
        login(res.data.token, res.data.user);
      }
      const yahooClaim = sessionStorage.getItem('yahooClaim');
      const espnPending = sessionStorage.getItem('espnPending');
      if (yahooClaim) {
        await api.post('/yahoo/claim', { claim: yahooClaim }, { headers: { Authorization: `Bearer ${authResult.token}` } });
        sessionStorage.removeItem('yahooClaim');
        navigate('/yahoo?yahoo=connected');
      } else if (espnPending) {
        const pendingEspn = JSON.parse(espnPending);
        await api.post('/espn/connect', pendingEspn, { headers: { Authorization: `Bearer ${authResult.token}` } });
        sessionStorage.removeItem('espnPending');
        navigate(`/${pendingEspn.sport}`);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-950 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">
            <span className="text-accent-orange">Pro</span>
            <span className="text-white">GM</span>
          </h1>
          <p className="text-dark-400">Personalized Football & Basketball Assistant</p>
        </div>

        {/* Form Card */}
        <div className="card">
          <h2 className="text-xl font-bold mb-6">
            {isRegister ? 'Create Account' : 'Sign In'}
          </h2>

          {error && (
            <div className={`${error.includes('successfully') ? 'bg-green-900/30 border-green-700/50 text-green-400' : 'bg-red-900/30 border-red-700/50 text-red-400'} border rounded-lg p-3 mb-4 text-sm`}>
              {error}
            </div>
          )}

          {!isRegister && (
            <div className="mb-6 rounded-xl border border-[#6b4ba1]/50 bg-[#3f2867]/20 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6001d2] text-xl font-black text-white">Y!</div>
                <div>
                  <p className="font-semibold text-white">Bring in your Yahoo Fantasy team</p>
                  <p className="mt-1 text-xs leading-5 text-dark-300">Connect Yahoo first, then sign in or create an account to securely attach your fantasy leagues and teams.</p>
                </div>
              </div>
              <button type="button" onClick={connectYahoo} disabled={yahooLoading || yahooStatus?.connected} className="mt-4 w-full rounded-lg bg-[#6001d2] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#7b20e8] disabled:opacity-60">
                {yahooStatus?.connected ? 'Yahoo account connected' : yahooLoading ? 'Opening Yahoo…' : 'Connect Yahoo Fantasy'}
              </button>
              {yahooStatus && !yahooStatus.configured && <p className="mt-2 text-center text-xs text-amber-400">Yahoo developer credentials still need to be added by the app owner.</p>}
            </div>
          )}

          {!isRegister && (
            <div className="mb-6 rounded-xl border border-red-700/40 bg-red-950/20 p-4">
              <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-600 text-xl font-black text-white">E</div><div><p className="font-semibold text-white">Connect an ESPN public league</p><p className="mt-1 text-xs leading-5 text-dark-300">Paste a football or basketball team URL. ProGM uses the league settings and real player pool to personalize every tool.</p></div></div>
              <input className="input-field mt-4" value={espnLeagueId} onChange={e => { setEspnLeagueId(e.target.value); setEspnPreview(null); }} placeholder="Paste ESPN team URL or league ID" />
              <div className="mt-2 grid grid-cols-2 gap-2"><select className="input-field" value={espnSport} onChange={e => setEspnSport(e.target.value)}><option value="football">Football</option><option value="basketball">Basketball</option></select><input className="input-field" value={espnSeason} onChange={e => setEspnSeason(e.target.value)} placeholder="Season" /></div>
              {!espnPreview ? <button type="button" onClick={previewEspn} disabled={espnLoading || !espnLeagueId} className="mt-3 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50">{espnLoading ? 'Loading ESPN…' : 'Find ESPN league'}</button> : <div className="mt-3"><p className="mb-2 text-sm font-medium text-white">{espnPreview.leagueName}</p><select className="input-field" value={espnTeamId} onChange={e => setEspnTeamId(e.target.value)}>{espnPreview.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select><button type="button" onClick={saveEspnTeam} className="mt-2 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500">Use this ESPN team</button></div>}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isRegister && <div>
              <label className="block text-sm text-dark-300 mb-1.5">Email or username</label>
              <input
                type="text"
                className="input-field"
                placeholder="Email or username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>}

            {isRegister && (
              <>
                <div>
                  <label className="block text-sm text-dark-300 mb-1.5">Email</label>
                  <input
                    type="email"
                    className="input-field"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-sm text-dark-300 mb-1.5">Password</label>
              <input
                type="password"
                className="input-field"
                placeholder="Enter password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3 disabled:opacity-50"
            >
              {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 text-center text-sm">
            <span className="text-dark-400">
              {isRegister ? 'Already have an account?' : "Don't have an account?"}
            </span>
            <button
              onClick={() => { setIsRegister(!isRegister); setError(''); }}
              className="ml-2 text-primary-400 hover:text-primary-300 font-medium"
            >
              {isRegister ? 'Sign In' : 'Register'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
