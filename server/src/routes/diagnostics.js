/**
 * TEMPORARY protected diagnostics route.
 *
 * Sole purpose: let an authenticated ProGM user check whether the Render server
 * can reach the free NBA data sources (ESPN public JSON + cdn.nba.com) without
 * 403 / 429 / timeout / bot-blocking. This is connectivity testing ONLY.
 *
 * It does NOT activate freeNbaProvider, does NOT touch provider selection, and
 * does NOT change Tank01's role as production primary. It simply calls the
 * existing read-only freeNbaProbe and returns a SANITIZED connectivity summary.
 *
 * Response contains ONLY { status, kind, ms } per source — never keys, cookies,
 * tokens, headers, env vars, or any provider payload (players/injuries/schedule).
 *
 * Can be disabled without a code change by leaving ENABLE_FREE_NBA_DIAG unset.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { probeFreeNbaSources } from '../services/providers/freeNbaProbe.js';
import { probeEspnSeasonStats } from '../services/providers/espnStatsProbe.js';

const router = Router();

// Map the probe's internal source keys to the stable response field names.
const SOURCE_FIELD = {
  espn_byathlete: 'espnSeasonStats',
  espn_injuries: 'espnInjuries',
  nba_cdn_schedule: 'nbaSchedule',
};

/** Keep ONLY the safe connectivity fields; drop everything else. */
function sanitize(result) {
  return { status: result.status ?? null, kind: result.kind, ms: result.ms };
}

// The season-stats probe downloads the real ~8 MB ESPN response, so it is single-flight and rate limited per process.
const PROBE_MIN_INTERVAL_MS = 15 * 1000;
let probeBusy = false;
let probeLastStartedAt = 0;
export function resetEspnProbeGuard() { probeBusy = false; probeLastStartedAt = 0; }

/**
 * GET /api/diagnostics/free-nba
 * Protected (requires a valid ProGM auth token). Returns per-source
 * connectivity only. Gated behind ENABLE_FREE_NBA_DIAG so it can be turned off
 * from the Render dashboard without redeploying code.
 *
 * GET /api/diagnostics/free-nba?probe=espn-stats[&season=2026]
 * Explicitly requested, separate probe: ONE request to the same ESPN season-stats endpoint the projection provider uses
 * (season = Yahoo league season; default = the current one). Returns aggregate facts only (see espnStatsProbe.js). Same auth
 * and flag gate. It does not touch provider caches, breakers or counters, and never calls Yahoo, Tank01 or anything else.
 */
router.get('/free-nba', authenticate, async (req, res) => {
  if (process.env.ENABLE_FREE_NBA_DIAG !== 'true') {
    return res.status(404).json({ error: 'Diagnostic endpoint is disabled.' });
  }
  if (req.query.probe !== undefined) {
    if (req.query.probe !== 'espn-stats') return res.status(400).json({ error: 'Unknown probe.' });
    let leagueSeason;
    if (req.query.season !== undefined) {
      if (!/^\d{4}$/.test(String(req.query.season)) || Number(req.query.season) < 2000 || Number(req.query.season) > 2100) {
        return res.status(400).json({ error: 'season must be a 4-digit year such as 2026.' });
      }
      leagueSeason = Number(req.query.season);
    }
    const now = Date.now();
    if (probeBusy) return res.status(429).json({ error: 'probe_in_progress' });
    if (now - probeLastStartedAt < PROBE_MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'probe_cooldown', retryAfterMs: PROBE_MIN_INTERVAL_MS - (now - probeLastStartedAt) });
    }
    probeBusy = true;
    probeLastStartedAt = now;
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(await probeEspnSeasonStats(leagueSeason === undefined ? {} : { leagueSeason }));
    } catch {
      return res.status(200).json({ error: 'probe_failed' }); // never leak internals
    } finally {
      probeBusy = false;
    }
  }
  try {
    const { results, checkedAt } = await probeFreeNbaSources();
    const body = { checkedAt };
    for (const r of results) {
      const field = SOURCE_FIELD[r.source];
      if (field) body[field] = sanitize(r);
    }
    return res.json(body);
  } catch {
    // Never leak internals; a failed probe still returns a safe shape.
    return res.status(200).json({ error: 'probe_failed' });
  }
});

export default router;
