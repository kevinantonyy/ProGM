import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

export default function Roster() {
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(null);

  useEffect(() => {
    fetchRoster();
  }, []);

  async function fetchRoster() {
    try {
      const res = await api.get('/roster');
      setRoster(res.data.roster);
    } catch (err) {
      console.error('Failed to fetch roster:', err);
    } finally {
      setLoading(false);
    }
  }

  async function removePlayer(playerId) {
    setRemoving(playerId);
    try {
      await api.delete(`/roster/remove/${playerId}`);
      setRoster(prev => prev.filter(p => p.id !== playerId));
    } catch (err) {
      console.error('Failed to remove player:', err);
    } finally {
      setRemoving(null);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-primary-400 animate-pulse text-lg">Loading roster...</div></div>;
  }

  const positionGroups = { PG: [], SG: [], SF: [], PF: [], C: [] };
  roster.forEach(p => {
    if (positionGroups[p.position]) positionGroups[p.position].push(p);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Roster</h1>
          <p className="text-dark-400 mt-1">{roster.length}/15 players</p>
        </div>
        <Link to="/players" className="btn-primary">
          + Add Players
        </Link>
      </div>

      {roster.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-dark-400 text-lg mb-4">Your roster is empty</p>
          <Link to="/players" className="btn-primary">Browse Players</Link>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(positionGroups).map(([position, players]) => (
            players.length > 0 && (
              <div key={position}>
                <h2 className="text-sm font-bold text-dark-400 uppercase tracking-wide mb-3">
                  {position === 'PG' ? 'Point Guard' : position === 'SG' ? 'Shooting Guard' : position === 'SF' ? 'Small Forward' : position === 'PF' ? 'Power Forward' : 'Center'} ({players.length})
                </h2>
                <div className="grid gap-3">
                  {players.map(player => (
                    <div key={player.id} className="card-hover flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-primary-600/20 rounded-full flex items-center justify-center">
                          <span className="text-sm font-bold text-primary-400">{player.position}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold">{player.name}</h3>
                            {player.injury_status !== 'Healthy' && (
                              <span className="badge-red text-xs">{player.injury_status}</span>
                            )}
                          </div>
                          <p className="text-sm text-dark-400">{player.team}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-6">
                        <div className="hidden md:flex gap-6 text-center">
                          <div>
                            <p className="text-sm font-bold">{player.points_per_game}</p>
                            <p className="text-xs text-dark-400">PPG</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold">{player.rebounds_per_game}</p>
                            <p className="text-xs text-dark-400">RPG</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold">{player.assists_per_game}</p>
                            <p className="text-xs text-dark-400">APG</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold text-primary-400">{player.fantasy_points}</p>
                            <p className="text-xs text-dark-400">FP</p>
                          </div>
                        </div>
                        <button
                          onClick={() => removePlayer(player.id)}
                          disabled={removing === player.id}
                          className="btn-danger text-xs py-1.5 px-3"
                        >
                          {removing === player.id ? '...' : 'Drop'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
