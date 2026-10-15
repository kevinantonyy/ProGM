/**
 * Who is allowed to receive a (flagged) ADP-implied rookie estimate.
 *
 * Missing projections or an unmatched identity are NOT evidence of a rookie: injured veterans and name-matching
 * failures look the same. The one independent signal available at runtime is Yahoo's own player number:
 * Yahoo assigns ids in increasing order, so a player whose number is higher than EVERY player who has a real
 * last-season stat line was added to Yahoo after those players, i.e. cannot have played that season.
 * Anyone at or below that cutoff (veterans, injured veterans, earlier draft stashes) is never estimated.
 *
 * Assumption (unverified, fail-safe): Yahoo player numbers are monotonic in creation time. If it is wrong the
 * cutoff is simply higher and fewer players qualify, never more. Every other case stays "no projection" with a reason.
 */
export const RookieClass = Object.freeze({
  ROOKIE: 'rookie_or_new_entrant',
  NEW_ENTRANT_INJURED: 'new_entrant_injured',
  EARLIER_PLAYER: 'earlier_player_no_recent_stats',
  UNKNOWN: 'unknown',
  SCORING_GAP: 'scoring_gap',
});

/** Numeric Yahoo player number from a player_key ("466.p.6014"), editorial key ("nba.p.6014") or player_id. */
export function yahooPlayerNumber(player) {
  for (const raw of [player?.playerKey, player?.editorialPlayerKey, player?.playerId]) {
    const m = /(?:^|\.p\.)(\d+)$/.exec(String(raw ?? ''));
    if (m) return Number(m[1]);
  }
  return null;
}

/** Highest Yahoo player number among players that have a real (non-estimated) stat-based projection. */
export function lastSeasonCutoff(entries) {
  let max = null;
  for (const { playerNumber, hasRealStats } of entries) {
    if (hasRealStats && Number.isFinite(playerNumber)) max = max == null ? playerNumber : Math.max(max, playerNumber);
  }
  return max;
}

const REASONS = {
  [RookieClass.ROOKIE]: 'Yahoo added this player after every player who has a last-season NBA stat line, and there is no injury status: treated as an incoming player.',
  [RookieClass.NEW_ENTRANT_INJURED]: 'Looks like an incoming player but carries an injury/status flag; Yahoo ADP is not an injury-adjusted projection, so no estimate is made.',
  [RookieClass.EARLIER_PLAYER]: 'Yahoo created this player before last season ended (a veteran without a recent stat line, or an earlier draft stash). ADP is not used to estimate such players.',
  [RookieClass.UNKNOWN]: 'Not enough metadata to tell an incoming player from a veteran, so no estimate is made.',
  [RookieClass.SCORING_GAP]: 'League scoring uses a stat the data provider does not supply.',
};

export function classifyUnprojected({ playerNumber = null, cutoff = null, matched = false, status = null, scoringGap = false }) {
  const done = (cls) => ({ class: cls, reason: REASONS[cls] });
  if (scoringGap) return done(RookieClass.SCORING_GAP);
  if (!Number.isFinite(playerNumber) || !Number.isFinite(cutoff)) return done(RookieClass.UNKNOWN);
  if (playerNumber <= cutoff) return done(RookieClass.EARLIER_PLAYER);
  if (matched) return done(RookieClass.UNKNOWN);               // provider knows him yet no stat line: do not guess
  if (status) return done(RookieClass.NEW_ENTRANT_INJURED);    // any Yahoo status flag blocks an estimate
  return done(RookieClass.ROOKIE);
}
