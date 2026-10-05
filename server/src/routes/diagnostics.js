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

/**
 * GET /api/diagnostics/free-nba
 * Protected (requires a valid ProGM auth token). Returns per-source
 * connectivity only. Gated behind ENABLE_FREE_NBA_DIAG so it can be turned off
 * from the Render dashboard without redeploying code.
 */
router.get('/free-nba', authenticate, async (req, res) => {
  if (process.env.ENABLE_FREE_NBA_DIAG !== 'true') {
    return res.status(404).json({ error: 'Diagnostic endpoint is disabled.' });
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
