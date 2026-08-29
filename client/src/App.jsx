import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import YahooFantasy from './pages/YahooFantasy';
import EspnFantasy from './pages/EspnFantasy';
import LeagueSync from './pages/LeagueSync';
import SportWorkspace from './pages/SportWorkspace';

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="text-primary-400 text-xl">Loading...</div></div>;
  if (!token) return <Navigate to="/login" />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Navigate to="/football" replace />} />
        <Route path="yahoo" element={<YahooFantasy />} />
        <Route path="espn" element={<EspnFantasy />} />
        <Route path=":sport/:section?" element={<SportWorkspace />} />
        <Route path="sync" element={<LeagueSync />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
