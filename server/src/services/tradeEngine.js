import pool from '../db/connection.js';

/**
 * AI Trade Suggestion Engine (Mock Logic)
 * 
 * Analyzes a user's roster and identifies:
 * 1. Position weaknesses (positions where team is below average)
 * 2. Surplus positions (positions where team has depth)
 * 3. Injury risks (players with injury status)
 * 4. Buy-low opportunities (underperforming stars)
 * 5. Sell-high opportunities (overperforming role players)
 * 
 * Then generates personalized trade suggestions with reasoning.
 */

const POSITION_NEEDS = {
  PG: { min: 1, ideal: 2 },
  SG: { min: 1, ideal: 2 },
  SF: { min: 1, ideal: 2 },
  PF: { min: 1, ideal: 2 },
  C: { min: 1, ideal: 2 },
};

function analyzeRoster(rosterPlayers) {
  const analysis = {
    positionCounts: { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 },
    avgFantasyPoints: 0,
    totalFantasyPoints: 0,
    weakPositions: [],
    strongPositions: [],
    injuredPlayers: [],
    topPlayers: [],
    bottomPlayers: [],
  };

  // Count positions and stats
  for (const player of rosterPlayers) {
    analysis.positionCounts[player.position]++;
    analysis.totalFantasyPoints += parseFloat(player.fantasy_points);
    if (player.injury_status !== 'Healthy') {
      analysis.injuredPlayers.push(player);
    }
  }

  analysis.avgFantasyPoints = rosterPlayers.length > 0
    ? analysis.totalFantasyPoints / rosterPlayers.length
    : 0;

  // Identify weak and strong positions
  for (const [pos, needs] of Object.entries(POSITION_NEEDS)) {
    if (analysis.positionCounts[pos] < needs.min) {
      analysis.weakPositions.push(pos);
    } else if (analysis.positionCounts[pos] > needs.ideal) {
      analysis.strongPositions.push(pos);
    }
  }

  // Sort players by fantasy points
  const sorted = [...rosterPlayers].sort((a, b) => parseFloat(b.fantasy_points) - parseFloat(a.fantasy_points));
  analysis.topPlayers = sorted.slice(0, 3);
  analysis.bottomPlayers = sorted.slice(-3);

  return analysis;
}

function generateReasoning(givePlayer, receivePlayer, category, analysis) {
  const reasonings = {
    position_need: `Your roster is thin at ${receivePlayer.position}. Trading ${givePlayer.name} (${givePlayer.position}) from your surplus fills this gap with ${receivePlayer.name}, who averages ${receivePlayer.fantasy_points} fantasy points per game.`,
    
    injury_risk: `${givePlayer.name} is currently ${givePlayer.injury_status}. Selling now before potential missed games and acquiring ${receivePlayer.name} (${receivePlayer.fantasy_points} FPPG) keeps your roster productive.`,
    
    buy_low: `${receivePlayer.name} is a high-ceiling player available at discount value. Trading ${givePlayer.name} for a talent of this caliber upgrades your ${receivePlayer.position} position significantly.`,
    
    sell_high: `${givePlayer.name} is performing above expected value. Capitalizing by acquiring ${receivePlayer.name} (${receivePlayer.points_per_game} PPG, ${receivePlayer.rebounds_per_game} RPG, ${receivePlayer.assists_per_game} APG) gives you more consistent long-term production.`,
    
    upgrade: `This is a straight upgrade at the ${receivePlayer.position} position. ${receivePlayer.name} averages ${(parseFloat(receivePlayer.fantasy_points) - parseFloat(givePlayer.fantasy_points)).toFixed(1)} more fantasy points per game than ${givePlayer.name}.`,
  };

  return reasonings[category] || `Trading ${givePlayer.name} for ${receivePlayer.name} improves your overall roster balance and fantasy output.`;
}

function calculateConfidence(givePlayer, receivePlayer, category) {
  let confidence = 50;

  // Better fantasy points = higher confidence
  const pointsDiff = parseFloat(receivePlayer.fantasy_points) - parseFloat(givePlayer.fantasy_points);
  confidence += Math.min(pointsDiff * 2, 20);

  // Injury risk trades are more urgent
  if (category === 'injury_risk') confidence += 15;

  // Position need fills are valuable
  if (category === 'position_need') confidence += 10;

  return Math.max(30, Math.min(95, Math.round(confidence)));
}

export async function generateTradeSuggestions(userId) {
  // Get user's roster
  const [rosterRows] = await pool.execute(
    `SELECT p.* FROM rosters r JOIN players p ON r.player_id = p.id WHERE r.user_id = ?`,
    [userId]
  );

  if (rosterRows.length === 0) {
    return { suggestions: [], analysis: { message: 'Add players to your roster to get AI trade suggestions.' } };
  }

  // Analyze roster
  const analysis = analyzeRoster(rosterRows);

  // Get available players (not on user's roster)
  const [availablePlayers] = await pool.execute(
    `SELECT p.* FROM players p WHERE p.id NOT IN (SELECT player_id FROM rosters WHERE user_id = ?) ORDER BY p.fantasy_points DESC`,
    [userId]
  );

  const suggestions = [];
  const rosterPlayerIds = new Set(rosterRows.map(p => p.id));

  // Strategy 1: Address position weaknesses
  for (const weakPos of analysis.weakPositions) {
    const targets = availablePlayers.filter(p => p.position === weakPos);
    const tradeable = rosterRows.filter(p => 
      analysis.strongPositions.includes(p.position) || 
      analysis.positionCounts[p.position] > POSITION_NEEDS[p.position].min
    );

    if (targets.length > 0 && tradeable.length > 0) {
      const target = targets[0]; // Best available at that position
      const give = tradeable[tradeable.length - 1]; // Weakest from surplus
      suggestions.push({
        give_player: give,
        receive_player: target,
        reasoning: generateReasoning(give, target, 'position_need', analysis),
        confidence_score: calculateConfidence(give, target, 'position_need'),
        category: 'Position Need',
      });
    }
  }

  // Strategy 2: Trade injured players
  for (const injured of analysis.injuredPlayers) {
    const replacements = availablePlayers.filter(p => 
      p.position === injured.position && 
      p.injury_status === 'Healthy' &&
      parseFloat(p.fantasy_points) >= parseFloat(injured.fantasy_points) * 0.7
    );

    if (replacements.length > 0) {
      const target = replacements[0];
      suggestions.push({
        give_player: injured,
        receive_player: target,
        reasoning: generateReasoning(injured, target, 'injury_risk', analysis),
        confidence_score: calculateConfidence(injured, target, 'injury_risk'),
        category: 'Injury Risk',
      });
    }
  }

  // Strategy 3: Upgrade bottom players
  for (const weak of analysis.bottomPlayers) {
    const upgrades = availablePlayers.filter(p => 
      p.position === weak.position &&
      parseFloat(p.fantasy_points) > parseFloat(weak.fantasy_points) + 5 &&
      p.injury_status === 'Healthy'
    );

    if (upgrades.length > 0 && !suggestions.find(s => s.give_player.id === weak.id)) {
      const target = upgrades[0];
      suggestions.push({
        give_player: weak,
        receive_player: target,
        reasoning: generateReasoning(weak, target, 'upgrade', analysis),
        confidence_score: calculateConfidence(weak, target, 'upgrade'),
        category: 'Upgrade',
      });
    }
  }

  // Strategy 4: Sell high on players near peak value from surplus positions
  for (const strongPos of analysis.strongPositions) {
    const surplusPlayers = rosterRows
      .filter(p => p.position === strongPos)
      .sort((a, b) => parseFloat(a.fantasy_points) - parseFloat(b.fantasy_points));

    if (surplusPlayers.length > 0) {
      const sellCandidate = surplusPlayers[surplusPlayers.length - 1]; // Highest from surplus
      const weakPosTargets = availablePlayers.filter(p => 
        analysis.weakPositions.includes(p.position) || 
        (parseFloat(p.fantasy_points) > parseFloat(sellCandidate.fantasy_points) && p.injury_status === 'Healthy')
      );

      if (weakPosTargets.length > 0 && !suggestions.find(s => s.give_player.id === sellCandidate.id)) {
        const target = weakPosTargets[0];
        suggestions.push({
          give_player: sellCandidate,
          receive_player: target,
          reasoning: generateReasoning(sellCandidate, target, 'sell_high', analysis),
          confidence_score: calculateConfidence(sellCandidate, target, 'sell_high'),
          category: 'Sell High',
        });
      }
    }
  }

  // Sort by confidence
  suggestions.sort((a, b) => b.confidence_score - a.confidence_score);

  // Save suggestions to database
  await pool.execute('DELETE FROM trade_suggestions WHERE user_id = ?', [userId]);
  for (const suggestion of suggestions.slice(0, 5)) {
    await pool.execute(
      'INSERT INTO trade_suggestions (user_id, give_player_id, receive_player_id, reasoning, confidence_score, category) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, suggestion.give_player.id, suggestion.receive_player.id, suggestion.reasoning, suggestion.confidence_score, suggestion.category]
    );
  }

  return {
    suggestions: suggestions.slice(0, 5),
    analysis: {
      rosterSize: rosterRows.length,
      avgFantasyPoints: analysis.avgFantasyPoints.toFixed(1),
      weakPositions: analysis.weakPositions,
      strongPositions: analysis.strongPositions,
      injuredCount: analysis.injuredPlayers.length,
    },
  };
}
