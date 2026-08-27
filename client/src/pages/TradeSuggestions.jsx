import { useState, useEffect } from 'react';
import api from '../services/api';

export default function TradeSuggestions() {
  const [tradeData, setTradeData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchSuggestions();
  }, []);

  async function fetchSuggestions() {
    try {
      const res = await api.get('/trades/suggestions');
      setTradeData(res.data);
    } catch (err) {
      console.error('Failed to fetch trade suggestions:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    fetchSuggestions();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-pulse">🤖</div>
          <p className="text-primary-400 text-lg">AI is analyzing your roster...</p>
          <p className="text-dark-400 text-sm mt-1">Finding the best trade opportunities</p>
        </div>
      </div>
    );
  }

  const { suggestions = [], analysis } = tradeData || {};

  function getConfidenceColor(score) {
    if (score >= 80) return 'text-green-400';
    if (score >= 60) return 'text-accent-orange';
    return 'text-dark-400';
  }

  function getConfidenceBar(score) {
    if (score >= 80) return 'bg-green-500';
    if (score >= 60) return 'bg-accent-orange';
    return 'bg-dark-500';
  }

  function getCategoryIcon(category) {
    switch (category) {
      case 'Position Need': return '🎯';
      case 'Injury Risk': return '🏥';
      case 'Upgrade': return '⬆️';
      case 'Sell High': return '📈';
      case 'Buy Low': return '📉';
      default: return '🔄';
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <span>🤖</span> AI Trade Suggestions
          </h1>
          <p className="text-dark-400 mt-1">Personalized trade recommendations based on your roster analysis</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-primary flex items-center gap-2"
        >
          {refreshing ? (
            <span className="animate-spin">↻</span>
          ) : (
            <span>↻</span>
          )}
          Refresh Analysis
        </button>
      </div>

      {/* Roster Analysis Summary */}
      {analysis && analysis.rosterSize > 0 && (
        <div className="card bg-gradient-to-r from-primary-900/30 to-dark-800 border-primary-700/30">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span>📊</span> Roster Intelligence Report
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-dark-400">Roster Strength</p>
              <p className="text-xl font-bold text-primary-400">{analysis.avgFantasyPoints} FP/Player</p>
            </div>
            <div>
              <p className="text-sm text-dark-400">Position Gaps</p>
              {analysis.weakPositions?.length > 0 ? (
                <div className="flex gap-1 mt-1">
                  {analysis.weakPositions.map(pos => (
                    <span key={pos} className="badge-red">{pos}</span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-green-400 mt-1">None — well balanced</p>
              )}
            </div>
            <div>
              <p className="text-sm text-dark-400">Position Depth</p>
              {analysis.strongPositions?.length > 0 ? (
                <div className="flex gap-1 mt-1">
                  {analysis.strongPositions.map(pos => (
                    <span key={pos} className="badge-green">{pos}</span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-dark-300 mt-1">Evenly distributed</p>
              )}
            </div>
            <div>
              <p className="text-sm text-dark-400">Injury Concerns</p>
              <p className={`text-xl font-bold ${analysis.injuredCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {analysis.injuredCount > 0 ? `${analysis.injuredCount} player${analysis.injuredCount > 1 ? 's' : ''}` : 'All clear'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Trade Suggestions */}
      {suggestions.length > 0 ? (
        <div className="space-y-4">
          {suggestions.map((trade, idx) => (
            <div key={idx} className="card-hover border-l-4 border-l-primary-500">
              {/* Trade Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{getCategoryIcon(trade.category)}</span>
                  <span className="badge-blue">{trade.category}</span>
                  <span className="text-dark-500 text-sm">#{idx + 1}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold ${getConfidenceColor(trade.confidence_score)}`}>
                    {trade.confidence_score}%
                  </span>
                  <span className="text-xs text-dark-400">confidence</span>
                </div>
              </div>

              {/* Confidence Bar */}
              <div className="w-full bg-dark-700 rounded-full h-1.5 mb-4">
                <div
                  className={`h-1.5 rounded-full ${getConfidenceBar(trade.confidence_score)} transition-all`}
                  style={{ width: `${trade.confidence_score}%` }}
                />
              </div>

              {/* Trade Visualization */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center mb-4">
                {/* Give Player */}
                <div className="bg-red-900/10 border border-red-700/30 rounded-lg p-4">
                  <p className="text-xs text-red-400 font-medium uppercase mb-2">You Trade Away</p>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-600/20 rounded-full flex items-center justify-center text-sm font-bold text-red-400">
                      {trade.give_player.position}
                    </div>
                    <div>
                      <p className="font-bold">{trade.give_player.name}</p>
                      <p className="text-sm text-dark-400">{trade.give_player.team} · {trade.give_player.fantasy_points} FP</p>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-dark-400">
                    <span>{trade.give_player.points_per_game} PPG</span>
                    <span>{trade.give_player.rebounds_per_game} RPG</span>
                    <span>{trade.give_player.assists_per_game} APG</span>
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden md:flex flex-col items-center gap-1">
                  <div className="text-2xl">⇄</div>
                </div>

                {/* Receive Player */}
                <div className="bg-green-900/10 border border-green-700/30 rounded-lg p-4">
                  <p className="text-xs text-green-400 font-medium uppercase mb-2">You Receive</p>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-green-600/20 rounded-full flex items-center justify-center text-sm font-bold text-green-400">
                      {trade.receive_player.position}
                    </div>
                    <div>
                      <p className="font-bold">{trade.receive_player.name}</p>
                      <p className="text-sm text-dark-400">{trade.receive_player.team} · {trade.receive_player.fantasy_points} FP</p>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-dark-400">
                    <span>{trade.receive_player.points_per_game} PPG</span>
                    <span>{trade.receive_player.rebounds_per_game} RPG</span>
                    <span>{trade.receive_player.assists_per_game} APG</span>
                  </div>
                </div>
              </div>

              {/* AI Reasoning */}
              <div className="bg-dark-900 rounded-lg p-4 border border-dark-700">
                <div className="flex items-start gap-2">
                  <span className="text-sm mt-0.5">💡</span>
                  <div>
                    <p className="text-xs text-primary-400 font-medium uppercase mb-1">AI Reasoning</p>
                    <p className="text-sm text-dark-300 leading-relaxed">{trade.reasoning}</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card text-center py-12">
          <div className="text-4xl mb-4">🏀</div>
          <h3 className="text-lg font-bold mb-2">No Trade Suggestions Yet</h3>
          <p className="text-dark-400">
            Add at least 3 players to your roster and the AI will analyze trade opportunities.
          </p>
        </div>
      )}

      {/* How It Works */}
      <div className="card">
        <h2 className="text-lg font-bold mb-4">How AI Trade Analysis Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="text-center p-4">
            <div className="text-3xl mb-2">📋</div>
            <h3 className="font-medium mb-1">Roster Scan</h3>
            <p className="text-sm text-dark-400">AI scans your roster for position gaps, injury risks, and underperforming players</p>
          </div>
          <div className="text-center p-4">
            <div className="text-3xl mb-2">🧠</div>
            <h3 className="font-medium mb-1">Market Analysis</h3>
            <p className="text-sm text-dark-400">Compares available players against your needs and identifies value opportunities</p>
          </div>
          <div className="text-center p-4">
            <div className="text-3xl mb-2">🎯</div>
            <h3 className="font-medium mb-1">Trade Match</h3>
            <p className="text-sm text-dark-400">Generates personalized trades ranked by confidence score with detailed reasoning</p>
          </div>
        </div>
      </div>
    </div>
  );
}
