import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import YahooFantasy from './pages/YahooFantasy';
import EspnFantasy from './pages/EspnFantasy';
import LeagueSync from './pages/LeagueSync';
import SportWorkspace from './pages/SportWorkspace';
import BasketballWorkspace from './pages/BasketballWorkspace';
import Home from './pages/Home';
import Settings from './pages/Settings';
import LoadingState from './components/LoadingState';

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center bg-dark-950 p-4"><LoadingState label="Opening ProGM…" /></div>;
  if (!token) return <Navigate to="/login" />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Home />} />
        <Route path="settings" element={<Settings />} />
        <Route path="yahoo" element={<YahooFantasy />} />
        <Route path="espn" element={<EspnFantasy />} />
        {/* Fantasy Basketball is powered by Yahoo + Tank01 + ProGM analytics.
            Its explicit routes take precedence over the generic :sport routes. */}
        <Route path="basketball/:section?" element={<BasketballWorkspace />} />
        {/* Football (and any other sport) stays on the existing ESPN workspace. */}
        <Route path=":sport/matchup/:matchupId" element={<SportWorkspace />} />
        <Route path=":sport/:section?" element={<SportWorkspace />} />
        <Route path="sync" element={<LeagueSync />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
