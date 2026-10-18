/**
 * The real workspace builder with a stubbed Yahoo helper (no network: no players, so no provider calls) must only
 * advertise Draft Preview when PROGM_DRAFT_PREVIEW is on, and must otherwise keep exactly the same payload shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBasketballWorkspace } from './basketballWorkspace.js';

const LEAGUE = '466.l.1';
const settings = { fantasy_content: { league: [
  { league_key: LEAGUE, season: '2026', num_teams: 2, draft_status: 'postdraft' },
  { settings: {
    scoring_type: 'headpoint',
    roster_positions: [{ roster_position: { position: 'PG', count: 1, is_starting_position: 1 } }],
    stat_categories: { stats: [{ stat: { stat_id: 12, abbr: 'PTS', enabled: 1 } }] },
    stat_modifiers: { stats: [{ stat: { stat_id: 12, value: 1 } }] },
  } },
] } };
const yahooFantasy = async (path) => (path.includes('/settings') ? structuredClone(settings) : { fantasy_content: {} });

async function workspaceWith(t, value) {
  const saved = process.env.PROGM_DRAFT_PREVIEW;
  t.after(() => { if (saved === undefined) delete process.env.PROGM_DRAFT_PREVIEW; else process.env.PROGM_DRAFT_PREVIEW = saved; });
  if (value === undefined) delete process.env.PROGM_DRAFT_PREVIEW; else process.env.PROGM_DRAFT_PREVIEW = value;
  return buildBasketballWorkspace({ yahooFantasy, accessToken: 'synthetic', leagueKey: LEAGUE, teamKey: `${LEAGUE}.t.1`, userId: 1 });
}

test('flag off (unset, off, junk): the draftPreview capability key is absent', async (t) => {
  for (const value of [undefined, '', 'off', 'false', '0', 'maybe']) {
    const ws = await workspaceWith(t, value);
    assert.equal('draftPreview' in ws, false, String(value));
    assert.equal(ws.connection.draftStatus, 'postdraft');
  }
});

test('flag on: draftPreview is { enabled: true } and it is the ONLY difference in the payload shape', async (t) => {
  const off = await workspaceWith(t, undefined);
  for (const value of ['on', 'true', '1']) {
    const on = await workspaceWith(t, value);
    assert.deepEqual(on.draftPreview, { enabled: true });
    assert.deepEqual(Object.keys(on).filter((k) => k !== 'draftPreview'), Object.keys(off));
  }
});
