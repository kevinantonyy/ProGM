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
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('yahoo') === 'connected') setError('Yahoo account linked successfully.');
    if (params.get('yahoo') === 'error') setError(params.get('message') || 'Yahoo connection failed');
    if (localStorage.getItem('token')) {
      api.get('/yahoo/status').then(res => setYahooStatus(res.data)).catch(() => {});
    }
  }, []);

  async function connectYahoo() {
    if (!localStorage.getItem('token')) {
      setError('Sign in to FantasyProGM first, then link your Yahoo Fantasy account.');
      return;
    }
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

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        const res = await api.post('/auth/register', { username, email, password, teamName });
        login(res.data.token, res.data.user);
      } else {
        const res = await api.post('/auth/login', { username, password });
        login(res.data.token, res.data.user);
      }
      navigate('/');
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
            <span className="text-primary-400">Fantasy</span>
            <span className="text-accent-orange">Pro</span>
            <span className="text-white">GM</span>
          </h1>
          <p className="text-dark-400">NBA AI-Powered Trade Advisor</p>
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
                  <p className="mt-1 text-xs leading-5 text-dark-300">Link Yahoo to securely view your NBA leagues and teams in FantasyProGM.</p>
                </div>
              </div>
              <button type="button" onClick={connectYahoo} disabled={yahooLoading || yahooStatus?.connected} className="mt-4 w-full rounded-lg bg-[#6001d2] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#7b20e8] disabled:opacity-60">
                {yahooStatus?.connected ? 'Yahoo account connected' : yahooLoading ? 'Opening Yahoo…' : 'Connect Yahoo Fantasy'}
              </button>
              {yahooStatus && !yahooStatus.configured && <p className="mt-2 text-center text-xs text-amber-400">Yahoo developer credentials still need to be added by the app owner.</p>}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-dark-300 mb-1.5">Username</label>
              <input
                type="text"
                className="input-field"
                placeholder="Enter username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>

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
                <div>
                  <label className="block text-sm text-dark-300 mb-1.5">Team Name</label>
                  <input
                    type="text"
                    className="input-field"
                    placeholder="My NBA Squad"
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
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

          {!isRegister && (
            <div className="mt-4 p-3 bg-dark-900 rounded-lg text-center">
              <p className="text-xs text-dark-400">Demo credentials</p>
              <p className="text-sm text-dark-300 font-mono mt-1">demo / demo123</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
