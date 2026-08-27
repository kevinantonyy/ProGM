import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function Dashboard() {
  const { user } = useAuth();
  const [roster, setRoster] = useState([]);
  const [tradeData, setTradeData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [rosterRes, tradeRes] = await Promise.all([
          api.get('/roster'),
          api.get('/trades/suggestions'),
        ]);
        setRoster(rosterRes.data.roster);
        setTradeData(tradeRes.data);
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-primary-400 animate-pulse text-lg">Loading dashboard...</div>
      </div>
    );
  }

  const totalFP = roster.reduce((sum, p) => sum + parseFloat(p.fantasy_points), 0);
  const avgFP = roster.length > 0 ? (totalFP / roster.length).toFixed(1) : 0;
  const healthyCount = roster.filter(p => p.injury_status === 'Healthy').length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Welcome back, {user?.username}</h1>
        <p className="text-dark-400 mt-1">{user?.teamName} - Season Overview</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="stat-label">Roster Size</p>
          <p className="stat-value mt-1">{roster.length}<span className="text-dark-500 text-base">/15</span></p>
        </div>
        <div className="card">
          <p className="stat-label">Total Fantasy Pts</p>
          <p className="stat-value mt-1">{totalFP.toFixed(1)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Avg FP/Player</p>
          <p className="stat-value mt-1">{avgFP}</p>
        </div>
        <div className="card">
          <p className="stat-label">Healthy Players</p>
          <p className="stat-value mt-1">
            <span className={healthyCount === roster.length ? 'text-green-400' : 'text-orange-400'}>
              {healthyCount}
            </span>
            <span className="text-dark-500 text-base">/{roster.length}</span>
          </p>
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Roster Players */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">Top Performers</h2>
            <Link to="/roster" className="text-sm text-primary-400 hover:text-primary-300">View All</Link>
          </div>
          <div className="space-y-3">
            {roster.slice(0, 5).map(player => (
              <div key={player.id} className="flex items-center justify-between py-2 border-b border-dark-700 last:border-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-600/20 rounded-full flex items-center justify-center text-xs font-bold text-primary-400">
                    {player.position}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{player.name}</p>
                    <p className="text-xs text-dark-400">{player.team}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold text-primary-400">{player.fantasy_points}</p>
                  <p className="text-xs text-dark-400">FPPG</p>
                </div>
              </div>
            ))}
            {roster.length === 0 && (
              <p className="text-dark-400 text-center py-4">No players on roster. <Link to="/players" className="text-primary-400">Add some!</Link></p>
            )}
          </div>
        </div>

        {/* AI Trade Suggestions Preview */}
        <div className="card border-primary-500/30">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <span>🤖</span> AI Trade Suggestions
            </h2>
            <Link to="/trades" className="text-sm text-primary-400 hover:text-primary-300">View All</Link>
          </div>
          {tradeData?.suggestions?.length > 0 ? (
            <div className="space-y-3">
              {tradeData.suggestions.slice(0, 3).map((trade, idx) => (
                <div key={idx} className="bg-dark-900 rounded-lg p-3 border border-dark-700">
                  <div className="flex items-center justify-between mb-2">
                    <span className="badge-blue">{trade.category}</span>
                    <span className="text-xs font-medium text-accent-green">{trade.confidence_score}% confidence</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-red-400">{trade.give_player.name}</span>
                    <span className="text-dark-500">→</span>
                    <span className="text-green-400">{trade.receive_player.name}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-dark-400 text-center py-4">Add players to your roster to get AI suggestions.</p>
          )}
        </div>
      </div>

      {/* Roster Analysis */}
      {tradeData?.analysis && roster.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-bold mb-4">Roster Analysis</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {tradeData.analysis.weakPositions?.length > 0 && (
              <div>
                <p className="text-sm text-dark-400">Weak Positions</p>
                <div className="flex gap-1 mt-1">
                  {tradeData.analysis.weakPositions.map(pos => (
                    <span key={pos} className="badge-red">{pos}</span>
                  ))}
                </div>
              </div>
            )}
            {tradeData.analysis.strongPositions?.length > 0 && (
              <div>
                <p className="text-sm text-dark-400">Strong Positions</p>
                <div className="flex gap-1 mt-1">
                  {tradeData.analysis.strongPositions.map(pos => (
                    <span key={pos} className="badge-green">{pos}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="text-sm text-dark-400">Avg Fantasy Points</p>
              <p className="text-lg font-bold text-primary-400 mt-1">{tradeData.analysis.avgFantasyPoints}</p>
            </div>
            <div>
              <p className="text-sm text-dark-400">Injured</p>
              <p className={`text-lg font-bold mt-1 ${tradeData.analysis.injuredCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {tradeData.analysis.injuredCount} player{tradeData.analysis.injuredCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
