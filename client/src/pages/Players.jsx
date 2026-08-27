import { useState, useEffect } from 'react';
import api from '../services/api';

export default function Players() {
  const [players, setPlayers] = useState([]);
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('ALL');
  const [sort, setSort] = useState('fantasy_points');
  const [adding, setAdding] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetchData();
  }, [position, sort]);

  async function fetchData() {
    try {
      const [playersRes, rosterRes] = await Promise.all([
        api.get('/players', { params: { position, sort, search } }),
        api.get('/roster'),
      ]);
      setPlayers(playersRes.data.players);
      setRoster(rosterRes.data.roster.map(p => p.id));
    } catch (err) {
      console.error('Failed to fetch players:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(e) {
    e.preventDefault();
    setLoading(true);
    await fetchData();
  }

  async function addToRoster(playerId) {
    setAdding(playerId);
    setMessage('');
    try {
      await api.post('/roster/add', { playerId });
      setRoster(prev => [...prev, playerId]);
      setMessage('Player added to roster!');
      setTimeout(() => setMessage(''), 2000);
    } catch (err) {
      setMessage(err.response?.data?.error || 'Failed to add player');
    } finally {
      setAdding(null);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-primary-400 animate-pulse text-lg">Loading players...</div></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Player Database</h1>
        <p className="text-dark-400 mt-1">Browse and add players to your roster</p>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex flex-col md:flex-row gap-4">
          <form onSubmit={handleSearch} className="flex-1">
            <input
              type="text"
              className="input-field"
              placeholder="Search by name or team..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </form>
          <select
            className="input-field md:w-40"
            value={position}
            onChange={e => setPosition(e.target.value)}
          >
            <option value="ALL">All Positions</option>
            <option value="PG">Point Guard</option>
            <option value="SG">Shooting Guard</option>
            <option value="SF">Small Forward</option>
            <option value="PF">Power Forward</option>
            <option value="C">Center</option>
          </select>
          <select
            className="input-field md:w-40"
            value={sort}
            onChange={e => setSort(e.target.value)}
          >
            <option value="fantasy_points">Fantasy Points</option>
            <option value="points_per_game">Points</option>
            <option value="rebounds_per_game">Rebounds</option>
            <option value="assists_per_game">Assists</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {/* Message */}
      {message && (
        <div className={`p-3 rounded-lg text-sm ${message.includes('added') ? 'bg-green-900/30 text-green-400 border border-green-700/50' : 'bg-red-900/30 text-red-400 border border-red-700/50'}`}>
          {message}
        </div>
      )}

      {/* Players Table */}
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-dark-700">
              <th className="text-left py-3 px-2 text-sm text-dark-400 font-medium">Player</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium">POS</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium">PPG</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium hidden md:table-cell">RPG</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium hidden md:table-cell">APG</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium hidden lg:table-cell">FG%</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium">FP</th>
              <th className="text-center py-3 px-2 text-sm text-dark-400 font-medium">Status</th>
              <th className="text-right py-3 px-2 text-sm text-dark-400 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {players.map(player => {
              const onRoster = roster.includes(player.id);
              return (
                <tr key={player.id} className="border-b border-dark-800 hover:bg-dark-800/50 transition-colors">
                  <td className="py-3 px-2">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-primary-600/20 rounded-full flex items-center justify-center text-xs font-bold text-primary-400">
                        {player.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="font-medium text-sm">{player.name}</p>
                        <p className="text-xs text-dark-400">{player.team}</p>
                      </div>
                    </div>
                  </td>
                  <td className="text-center py-3 px-2">
                    <span className="badge-blue text-xs">{player.position}</span>
                  </td>
                  <td className="text-center py-3 px-2 text-sm font-medium">{player.points_per_game}</td>
                  <td className="text-center py-3 px-2 text-sm hidden md:table-cell">{player.rebounds_per_game}</td>
                  <td className="text-center py-3 px-2 text-sm hidden md:table-cell">{player.assists_per_game}</td>
                  <td className="text-center py-3 px-2 text-sm hidden lg:table-cell">{player.fg_percentage}%</td>
                  <td className="text-center py-3 px-2 text-sm font-bold text-primary-400">{player.fantasy_points}</td>
                  <td className="text-center py-3 px-2">
                    {player.injury_status === 'Healthy' ? (
                      <span className="badge-green text-xs">Healthy</span>
                    ) : (
                      <span className="badge-red text-xs">{player.injury_status}</span>
                    )}
                  </td>
                  <td className="text-right py-3 px-2">
                    {onRoster ? (
                      <span className="text-xs text-dark-400 bg-dark-700 px-2 py-1 rounded">On Roster</span>
                    ) : (
                      <button
                        onClick={() => addToRoster(player.id)}
                        disabled={adding === player.id}
                        className="btn-primary text-xs py-1.5 px-3"
                      >
                        {adding === player.id ? '...' : '+ Add'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
