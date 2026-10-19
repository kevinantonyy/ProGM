// Display helpers for the full-pool Rankings tab. Pure, so they are unit-testable.
// RULE: nothing here may create, change or recompute a rank. Filtering and searching only choose WHICH existing rows to show;
// every row keeps the `overallRank` the server computed once for the whole pool.

/** [value, label, tooltip]. "Rostered" means owned by ANOTHER team; "My Team" is owned by you. */
export const AVAILABILITY_FILTERS = [
  ['ALL', 'All', 'Every player in the league pool'],
  ['available', 'Available', 'Not on any team: can be added under Yahoo\'s rules'],
  ['rostered', 'Rostered', 'Owned by another team in this league'],
  ['mine', 'My Team', 'On your team'],
];

/** Returns a new array of the SAME row objects (never copies or edits them), so ranks cannot change. */
export function filterRankings(players, { availability = 'ALL', query = '' } = {}) {
  const rows = Array.isArray(players) ? players : [];
  const needle = String(query || '').trim().toLowerCase();
  return rows.filter((player) => {
    if (availability !== 'ALL' && player.availability !== availability) return false;
    if (!needle) return true;
    return [player.name, player.teamAbbr, player.ownerTeam].some((field) => String(field || '').toLowerCase().includes(needle));
  });
}

export function availabilityLabel(player) {
  if (player?.availability === 'mine') return 'Your team';
  if (player?.availability === 'rostered') return `Rostered · ${player.ownerTeam || 'another team'}`;
  if (player?.availability === 'available') return 'Available';
  return 'Availability unknown';
}

/** Text for a player with no ProGM rank: the reason is about missing STATS, never about whether the player can be added. */
export function unrankedLabel(player) {
  return player?.rankStatus === 'unranked' || player?.overallRank == null ? 'Unranked' : null;
}

export function poolCounts(players) {
  const rows = Array.isArray(players) ? players : [];
  return {
    total: rows.length,
    available: rows.filter((p) => p.availability === 'available').length,
    rostered: rows.filter((p) => p.availability === 'rostered').length,
    mine: rows.filter((p) => p.availability === 'mine').length,
    unranked: rows.filter((p) => p.overallRank == null).length,
  };
}
