import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Roster from './pages/Roster';
import Players from './pages/Players';
import TradeSuggestions from './pages/TradeSuggestions';
import YahooFantasy from './pages/YahooFantasy';

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
        <Route index element={<Dashboard />} />
        <Route path="roster" element={<Roster />} />
        <Route path="players" element={<Players />} />
        <Route path="trades" element={<TradeSuggestions />} />
        <Route path="yahoo" element={<YahooFantasy />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
