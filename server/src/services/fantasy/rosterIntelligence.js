/**
 * Roster intelligence.
 *
 * Turns the structural roster analysis + projections into SPECIFIC, actionable
 * recommendations, each as a reusable recommendation object:
 *
 *   {
 *     recommendation,          // short imperative summary
 *     confidence,              // 0-1 (data quality)
 *     projectedImpact,         // { metric, value } or null
 *     reasons: [],             // explainable bullet points
 *     dataSources: [],         // 'Yahoo' | 'External provider' | 'ProGM calculation'
 *     calculatedAt,            // ISO timestamp
 *   }
 *
 * When projections are unavailable, it still emits structural recommendations
 * (from Yahoo facts) but omits any projection-based ones. Never fabricates.
 */

function rec({ recommendation, confidence = null, projectedImpact = null, reasons = [], dataSources = [] }) {
  return { recommendation, confidence, projectedImpact, reasons, dataSources, calculatedAt: new Date().toISOString() };
}

/**
 * @param {Object} params
 * @param {Array} params.players               normalized roster players
 * @param {Object} params.analysis             analyzeRoster() result
 * @param {Object|null} params.projectionProvider
 * @param {Object} [params.lineup]             optimizeLineup() result (optional)
 */
export function buildRosterIntelligence({ players, analysis, projectionProvider, lineup = null }) {
  const recommendations = [];
  const projectionsAvailable = Boolean(projectionProvider?.getProjection);

  // --- Structural (Yahoo facts + ProGM calculation), always available ---

  const thin = analysis?.positions?.thinPositions || [];
  const overloaded = analysis?.positions?.overloadedPositions || [];

  if (thin.length) {
    recommendations.push(rec({
      recommendation: `Address thin depth at ${thin.map((t) => t.position).join(', ')}.`,
      reasons: thin.map((t) => `${t.position}: ${t.eligible} eligible player(s) for ${t.required} starting slot(s).`),
      dataSources: ['Yahoo', 'ProGM calculation'],
    }));
  }

  if (overloaded.length) {
    recommendations.push(rec({
      recommendation: `You have surplus depth at ${overloaded.map((o) => o.position).join(', ')} — tradeable from strength.`,
      reasons: overloaded.map((o) => `${o.position}: ${o.eligible} eligible players, more than needed.`),
      dataSources: ['Yahoo', 'ProGM calculation'],
    }));
  }

  if (analysis?.health?.injuredInActiveSlotCount > 0) {
    const injured = (analysis.health.injured || []).filter((p) => p.isStarting);
    recommendations.push(rec({
      recommendation: 'Move injured players out of your active lineup.',
      reasons: injured.map((p) => `${p.name} (${p.statusFull || p.status}) is in your ${p.slot} slot.`),
      dataSources: ['Yahoo'],
    }));
  }

  if (analysis?.counts?.openStartingSlots > 0) {
    recommendations.push(rec({
      recommendation: `Fill ${analysis.counts.openStartingSlots} open starting slot(s).`,
      reasons: ['You are not starting a full legal lineup.'],
      dataSources: ['Yahoo', 'ProGM calculation'],
    }));
  }

  // --- Projection-based (external provider), only when available ---

  let projectedStrength = null;
  if (projectionsAvailable) {
    const projected = players
      .map((p) => ({ player: p, proj: projectionProvider.getProjection(p) }))
      .filter((x) => x.proj?.projectedPoints != null);

    if (projected.length) {
      const starters = projected.filter((x) => x.player.isStarting);
      const bench = projected.filter((x) => !x.player.isStarting);
      const sum = (arr) => Number(arr.reduce((s, x) => s + x.proj.projectedPoints, 0).toFixed(1));

      projectedStrength = {
        startersProjected: sum(starters),
        benchProjected: sum(bench),
        topProjected: [...projected].sort((a, b) => b.proj.projectedPoints - a.proj.projectedPoints).slice(0, 3)
          .map((x) => ({ name: x.player.name, projectedPoints: x.proj.projectedPoints })),
      };

      // Lineup optimization opportunity.
      if (lineup?.projectionsAvailable && lineup.projectedDifference > 0) {
        recommendations.push(rec({
          recommendation: `Optimize your lineup for +${lineup.projectedDifference} projected pts/game.`,
          confidence: lineup.confidence,
          projectedImpact: { metric: 'projected pts/game', value: lineup.projectedDifference },
          reasons: (lineup.swaps || []).slice(0, 3).flatMap((s) => s.reasons || []),
          dataSources: ['Yahoo', 'External provider', 'ProGM calculation'],
        }));
      }

      // Weakest projected starter as an upgrade target.
      if (starters.length) {
        const weakestStarter = [...starters].sort((a, b) => a.proj.projectedPoints - b.proj.projectedPoints)[0];
        const strongestBench = bench.length ? [...bench].sort((a, b) => b.proj.projectedPoints - a.proj.projectedPoints)[0] : null;
        if (strongestBench && strongestBench.proj.projectedPoints > weakestStarter.proj.projectedPoints) {
          const gain = Number((strongestBench.proj.projectedPoints - weakestStarter.proj.projectedPoints).toFixed(1));
          recommendations.push(rec({
            recommendation: `Consider starting ${strongestBench.player.name} over ${weakestStarter.player.name}.`,
            confidence: Math.min(strongestBench.proj.confidence, weakestStarter.proj.confidence),
            projectedImpact: { metric: 'projected pts/game', value: gain },
            reasons: [`${strongestBench.player.name} projects ${strongestBench.proj.projectedPoints} vs ${weakestStarter.player.name} ${weakestStarter.proj.projectedPoints} (if lineup-eligible).`],
            dataSources: ['External provider', 'ProGM calculation'],
          }));
        }
      }
    }
  }

  return {
    projectionsAvailable,
    recommendations,
    projectedStrength,
    dataBasis: {
      facts: ['roster, lineup slots, and injury status (Yahoo)'],
      calculations: ['positional depth, open slots, lineup optimization'],
      requiresExternalData: projectionsAvailable ? [] : ['projected production for strength/upgrade recommendations'],
    },
  };
}
