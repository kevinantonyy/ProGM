/**
 * Insights orchestration — the bridge between Yahoo data, the external stats
 * providers, and the analysis engines.
 *
 * Pipeline:
 *   normalized Yahoo players
 *     -> provider player index (cross-reference)
 *     -> canonical players (identity layer)
 *     -> provider season/recent stats for matched players
 *     -> ProGM projection per player (league-specific scoring)
 *     -> projectionProvider consumed by Start/Sit, Trades, Waivers, Roster
 *
 * If no external provider is available (no RAPIDAPI_KEY and fallback disabled,
 * or all providers unhealthy), this returns a context with externalAvailable
 * = false and a null projectionProvider, so every engine degrades cleanly to
 * Yahoo-only deterministic behavior. Nothing is fabricated.
 */
import * as providers from '../providers/index.js';
import { buildCanonicalPlayers, yahooIdFromKeys } from '../identity/playerIdentity.js';
import { projectPlayer, makeProjectionProvider } from './projection.js';
import { applyMarketPriors } from './marketPrior.js';
import { classifyUnprojected, lastSeasonCutoff, yahooPlayerNumber } from './unprojectedClass.js';

/** canonicalId used across the app for a normalized Yahoo player. */
export function canonicalIdOf(player) {
  return player?.playerKey || player?.playerId || null;
}

/** Feed transport/completeness metadata is independent of how many injuries it lists. */
export function injuryReportStatus(result, applicable = true) {
  const available = applicable && Array.isArray(result?.value);
  return {
    applicable,
    available,
    count: available ? result.value.length : null,
    provider: result?.meta?.provider ?? null,
    fetchedAt: result?.meta?.fetchedAt ?? null,
    stale: result?.meta?.stale === true,
  };
}

/** Map a normalized Yahoo player into the identity layer's source shape. */
function toSource(player) {
  return {
    playerKey: player.playerKey,
    playerId: player.playerId,
    name: player.name,
    teamAbbr: player.teamAbbr,
    yahooPlayerId: yahooIdFromKeys({
      editorialPlayerKey: player.editorialPlayerKey,
      playerKey: player.playerKey,
      playerId: player.playerId,
    }),
  };
}

/** Fill only missing rebound splits; total rebounds remain untouched. */
export function supplementReboundSplits(stats, split) {
  if (!stats?.season || !split) return stats;
  return {
    ...stats,
    season: {
      ...stats.season,
      offRebounds: stats.season.offRebounds ?? split.offRebounds ?? null,
      defRebounds: stats.season.defRebounds ?? split.defRebounds ?? null,
    },
  };
}

/**
 * Build a projection context for a set of normalized Yahoo players.
 *
 * @param {Object} params
 * @param {string|number} params.season          Yahoo season (e.g. "2025")
 * @param {Array} params.players                 normalized Yahoo players to project
 * @param {Array} params.statCategories          league settings.statCategories
 * @param {boolean} [params.scoringSupported]    whether league scoring can be applied
 * @param {boolean} [params.rookieEstimates]     add flagged, low-confidence Yahoo-ADP-implied estimates for players with no stat line (default off)
 * @returns {Promise<Object>} projection context
 */
export async function buildProjectionContext({ season, players, statCategories, scoringSupported = true, rookieEstimates = false, bulkOnly = false }) {
  const seasonYear = Number(season);
  const now = new Date();
  const currentNbaSeason = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const base = {
    externalAvailable: false,
    projectionProvider: null,
    projectionByCanonicalId: new Map(),
    imageByCanonicalId: new Map(),
    identityDiagnostics: null,
    freshness: null,
    providerStatus: providers.providerStatus(),
    reason: null,
    injuryReports: injuryReportStatus(null, seasonYear === currentNbaSeason),
  };

  if (!scoringSupported) {
    return { ...base, reason: 'League scoring format is not supported for points projections.' };
  }
  if (!players?.length) {
    return { ...base, reason: 'No players to project.' };
  }

  const lastCompletedSeason = Number.isInteger(seasonYear) ? seasonYear - 1 : null;
  // Draft projections are anchored to the latest completed season. Current
  // in-season form is blended separately below when real games are available.
  const projectionSeason = lastCompletedSeason ?? season;

  // 1. Provider player index (cross-reference). Null => Yahoo-only mode.
  let indexResult;
  try {
    indexResult = await providers.getPlayerIndex(projectionSeason);
  } catch {
    indexResult = null;
  }
  // An empty directory is as unusable as a missing one: matching against it would "succeed" with zero projections.
  if (!indexResult?.value?.length) {
    // Distinguish WHY the provider is unavailable so production can report a
    // precise, sanitized diagnostic instead of a generic message. This reads
    // the provider's recorded last error (status + classified kind) — it does
    // NOT make another provider request.
    const status = providers.providerStatus();
    const tank = status?.tank01 || {};
    const diag = tank.lastError || null;
    let reason = 'External NBA data provider is not available; running in Yahoo-only mode.';
    if (!tank.configured) {
      reason = tank.enabled === false
        ? 'Tank01 is disabled (PROGM_TANK01_ENABLED is not true), so only the free ESPN/NBA data sources are used, and they are unavailable.'
        : 'NBA stats provider is not configured on the server (RAPIDAPI_KEY missing).';
    } else if (diag?.kind === 'quota_exceeded') {
      reason = 'NBA stats provider quota/rate limit reached; projections will return when it resets.';
    } else if (diag?.kind === 'invalid_key') {
      reason = 'NBA stats provider rejected the API key (check RAPIDAPI_KEY).';
    } else if (diag?.kind === 'access_forbidden') {
      reason = 'NBA stats provider denied access (subscription/plan issue).';
    } else if (diag?.kind === 'provider_error') {
      reason = 'NBA stats provider is having a temporary outage; retrying later.';
    } else if (diag?.kind === 'network_error') {
      reason = 'Could not reach the NBA stats provider from the server (network).';
    }
    // ESPN (free_nba) is the primary source; say what it last reported (a sanitized, truncated health message), not only Tank01's state.
    const free = status?.free_nba || {};
    if (free.configured && free.lastErrorType) {
      reason = `NBA stats from ESPN are unavailable: ${free.lastErrorType}${free.state === 'open' ? ' (retries are paused for a few minutes)' : ''}`;
    } else if (indexResult?.value && !indexResult.value.length) {
      reason = 'The NBA player directory came back empty, so no projections can be built.';
    }
    return {
      ...base,
      reason,
      // Structured, sanitized diagnostic for the UI/report (no keys/bodies).
      diagnostic: {
        freeNba: { state: free.state ?? null, failures: free.failures ?? null, lastErrorType: free.lastErrorType ?? null },
        provider: 'tank01',
        available: false,
        configured: Boolean(tank.configured),
        reason: diag?.kind || (tank.configured ? 'unavailable' : 'not_configured'),
        status: diag?.status ?? null,
        rateLimit: diag?.rateLimit || null,
        breakerState: tank.state || null,
      },
    };
  }

  // 2. Canonical identity mapping + diagnostics.
  const source = players.map(toSource);
  const { players: canonical, diagnostics } = buildCanonicalPlayers(source, indexResult.value);
  const matched = canonical.filter((c) => c.matched && c.externalId);
  const externalIds = matched.map((c) => c.externalId);
  const externalRefById = new Map(indexResult.value.map((player) => [String(player.externalId), player]));
  // Only identity-safe matches may supply images. The identity layer deliberately
  // drops images for name-only matches, so no headshot is guessed from a name.
  const imageByCanonicalId = new Map(canonical.filter((c) => c.imageUrl).map((c) => [c.canonicalId, c.imageUrl]));

  // 3. Season stats for matched players (ONE league-wide request via the free
  //    provider's bulk path; filtered to our ids). Budget-conscious + shared.
  let statsResult = null;
  if (externalIds.length) {
    try {
      // Draft Preview passes bulkOnly: one league-wide request or nothing, never hundreds of per-player Tank01 calls.
      statsResult = bulkOnly
        ? await providers.getSeasonStatsBulkOnly(projectionSeason, externalIds)
        : await providers.getSeasonStats(projectionSeason, externalIds);
    } catch {
      statsResult = null;
    }
  }
  const statsByExternalId = new Map();
  if (statsResult?.value) {
    for (const s of statsResult.value) statsByExternalId.set(String(s.externalId), s);
  }

  // ESPN's league-wide season feed omits player OREB/DREB. Supplement those
  // two fields from one cached official NBA league-wide totals request. Match
  // through the same ambiguity-safe identity layer; never guess an id/name.
  const weightedStatIds = new Set((statCategories || [])
    .filter((cat) => cat?.enabled !== false && cat?.pointValue != null)
    .map((cat) => Number(cat.statId)));
  const needsReboundSplits = (weightedStatIds.has(13) && [...statsByExternalId.values()].some((s) => s?.season?.offRebounds == null))
    || (weightedStatIds.has(14) && [...statsByExternalId.values()].some((s) => s?.season?.defRebounds == null));
  let reboundResult = null;
  if (needsReboundSplits) {
    try {
      reboundResult = await providers.getSeasonReboundSplits(projectionSeason);
    } catch {
      reboundResult = null;
    }
  }
  const reboundRows = Array.isArray(reboundResult?.value) ? reboundResult.value : [];
  const reboundByCanonicalId = new Map();
  if (reboundRows.length) {
    const reboundRefs = reboundRows.map((row) => ({
      externalId: row.externalId,
      name: row.name,
      teamAbbr: row.teamAbbr,
      yahooId: null,
    }));
    const reboundMatches = buildCanonicalPlayers(source, reboundRefs).players;
    const reboundByExternalId = new Map(reboundRows.map((row) => [String(row.externalId), row]));
    for (const match of reboundMatches) {
      if (!match.matched || !match.externalId) continue;
      const row = reboundByExternalId.get(String(match.externalId));
      if (row) reboundByCanonicalId.set(match.canonicalId, row);
    }
  }

  // 3a. The same explicitly selected completed-season dataset also powers the
  // human-readable "Last Season" context; it is never silently substituted.
  // 3b. Recent form (OPTIONAL). Built from box scores of recently completed
  //     games (one request per game, shared). A failure here must NOT break
  //     season-stat projections — the model falls back to season-only cleanly.
  let recentResult = null;
  try {
    recentResult = await providers.getRecentForm(season);
  } catch {
    recentResult = null;
  }
  const recentByExternalId = recentResult?.value || {};

  // 3c. Historical availability (OPTIONAL): cached league-wide season records
  //     back to the earliest verified debut in this player pool. Each season is
  //     fetched once globally, never per player; failed/missing seasons remain
  //     missing and are never converted to zero games.
  let historyResult = null;
  try {
    const verifiedDebuts = matched
      .map((player) => Number(externalRefById.get(String(player.externalId))?.debutYear))
      .filter((year) => Number.isInteger(year) && year <= seasonYear);
    const earliestDebut = verifiedDebuts.length ? Math.min(...verifiedDebuts) : null;
    const careerSeasonCount = earliestDebut == null ? 3 : Math.max(3, Math.min(30, seasonYear - earliestDebut));
    historyResult = await providers.getHistoricalAvailability(season, careerSeasonCount);
  } catch {
    historyResult = null;
  }
  const historyByExternalId = historyResult?.value || {};

  // Current injury context is optional and identity-safe (same ESPN ids as the
  // primary index). It must never be applied to a historical Yahoo season.
  // Draft expected-games logic only acts on explicit verified season-ending
  // language; short-term Yahoo Q/GTD tags remain context only.
  let injuryResult = null;
  if (Number(season) === currentNbaSeason) {
    try {
      injuryResult = await providers.getInjuries();
    } catch {
      injuryResult = null;
    }
  }
  const injuryByExternalId = new Map((injuryResult?.value || []).map((injury) => [String(injury.externalId), injury]));
  const injuryReports = injuryReportStatus(injuryResult, seasonYear === currentNbaSeason);

  // 4. Project each canonical player using the league's actual scoring. Merge
  //    recent form into the season stats so the EXISTING projection model
  //    (season+recent blend) uses it with no weight changes. Historical
  //    availability is attached as projection.history for the draft expected-
  //    games model — it does NOT affect projected points per game itself.
  const projectionByCanonicalId = new Map();
  for (const c of canonical) {
    const base = c.externalId ? statsByExternalId.get(String(c.externalId)) || null : null;
    const reboundSplit = reboundByCanonicalId.get(c.canonicalId) || null;
    let stats = supplementReboundSplits(base, reboundSplit);
    if (base && c.externalId) {
      const rec = recentByExternalId[String(c.externalId)];
      if (rec && rec.recent) {
        stats = { ...stats, recent: rec.recent, recentGameCount: rec.recentGameCount ?? null };
      }
    }
    const projection = projectPlayer({ stats, statCategories });
    projection.matchMethod = c.matchMethod;
    projection.matched = c.matched;
    projection.history = (c.externalId && historyByExternalId[String(c.externalId)]) || null;
    const externalRef = c.externalId ? externalRefById.get(String(c.externalId)) : null;
    projection.availabilityProfile = externalRef
      ? { age: externalRef.age ?? null, debutYear: externalRef.debutYear ?? null, ageReferenceSeason: currentNbaSeason, targetSeason: seasonYear }
      : null;
    projection.injury = (c.externalId && injuryByExternalId.get(String(c.externalId))) || null;
    projection.lastSeason = stats?.season
      ? { season: projectionSeason, stats: stats.season }
      : null;
    projectionByCanonicalId.set(c.canonicalId, projection);
  }

  // Optional (flag-gated): clearly labelled estimates for players with no NBA stat line. Off by default.
  // Estimates live in their OWN map: waivers, trades, lineups and start/sit never see them.
  const estimateByCanonicalId = new Map();
  let estimateCount = 0;
  if (rookieEstimates) {
    const withEstimates = new Map(projectionByCanonicalId);
    const numberById = new Map(players.map((p) => [canonicalIdOf(p), yahooPlayerNumber(p)]));
    const cutoff = lastSeasonCutoff([...projectionByCanonicalId].map(([id, proj]) => ({ playerNumber: numberById.get(id), hasRealStats: proj?.projectedPoints != null && !proj.estimate })));
    const result = applyMarketPriors({
      canonical, players, projectionByCanonicalId: withEstimates, canonicalIdOf, seasonYear,
      classify: (c, p) => classifyUnprojected({ playerNumber: yahooPlayerNumber(p), cutoff, matched: c.matched, status: p?.status ?? null }),
    });
    estimateCount = result.estimateCount;
    for (const [id, proj] of withEstimates) if (proj?.estimate === true) estimateByCanonicalId.set(id, proj);
    for (const [id, proj] of result.skipped) estimateByCanonicalId.set(id, proj); // annotated "no projection" entries (reason only)
  }

  const projectionProvider = makeProjectionProvider({ projectionByCanonicalId, imageByCanonicalId, canonicalIdOf });
  const freshness = providers.cache.freshnessFrom(indexResult.meta, statsResult?.meta, recentResult?.meta);
  const projectedCount = [...projectionByCanonicalId.values()].filter((p) => p.projectedPoints != null).length;
  const recentCount = Object.keys(recentByExternalId).length;
  const historyCount = Object.keys(historyByExternalId).length;

  return {
    externalAvailable: true,
    projectionProvider,
    projectionByCanonicalId,
    estimateByCanonicalId,
    imageByCanonicalId,
    identityDiagnostics: { ...diagnostics, projectedCount, estimatedCount: estimateCount, recentFormPlayers: recentCount, historyPlayers: historyCount },
    freshness,
    providerStatus: providers.providerStatus(),
    // Per-source availability so the UI/report can see what the primary served.
    diagnostic: {
      provider: statsResult?.meta?.provider || indexResult?.meta?.provider || 'free_nba',
      available: true,
      sources: {
        seasonStats: Boolean(statsResult?.value?.length),
        lastSeasonStats: Boolean(statsResult?.value?.length),
        reboundSplits: reboundByCanonicalId.size > 0,
        recentForm: recentCount > 0,
        injuries: injuryReports.available,
        playerIndex: Boolean(indexResult?.value?.length),
        history: historyCount > 0,
        statsBudgetLimited: Boolean(statsResult?.meta?.budgetLimited), // per-player fallback hit its request budget
      },
    },
    injuryReports,
    reason: projectedCount > 0 ? null
      : bulkOnly && !statsResult?.value?.length
        ? 'The league-wide NBA stats feed was unavailable, and this view does not use slower per-player lookups, so no projections were built.'
        : statsResult?.meta?.budgetLimited
          ? (() => {
            const budget = providers.providerStatus()?.tank01?.playerBudget;
            return budget && (budget.hourly.limit === 0 || budget.daily.limit === 0)
              ? 'The ESPN stats feed was unavailable and the per-player paid-API fallback is disabled (its budget is 0), so no projections were built.'
              : 'NBA stats are temporarily limited to protect the data-provider quota; projections fill in as the limit resets.';
          })()
          : matched.length === 0
          ? 'No Yahoo players could be matched to the NBA player directory, so no projections were built.'
          : 'Provider returned no usable stats for these players yet.',
  };
}

/**
 * Draft-board view of a projection provider: falls back to a flagged estimate ONLY for getProjection
 * (rank and projected points). getProjectedValue / period values stay stats-only.
 */
export function withEstimates(provider, estimateByCanonicalId) {
  if (!provider || !estimateByCanonicalId?.size) return provider;
  return {
    ...provider,
    getProjection: (player) => {
      const own = provider.getProjection(player);
      if (own?.projectedPoints != null) return own;           // a real stat-based projection always wins
      return estimateByCanonicalId.get(canonicalIdOf(player)) || own || null;
    },
  };
}

/** Attach a projection summary to a normalized player (for UI display). */
export function withProjection(player, ctx) {
  const proj = ctx?.projectionByCanonicalId?.get(canonicalIdOf(player)) || null;
  return {
    ...player,
    projection: proj
      ? {
          projectedPoints: proj.projectedPoints,
          confidence: proj.confidence,
          method: proj.method,
          unsupportedStats: proj.unsupportedStats,
          breakdown: proj.breakdown,
        }
      : null,
  };
}
