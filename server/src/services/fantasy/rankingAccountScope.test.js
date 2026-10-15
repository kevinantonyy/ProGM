import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDraftBoard } from './draftHelper.js';
import { loadBaselineReference, referenceKey, saveBaselineReference } from './baselineReference.js';
import { parseV2UserIds, rankingProfile, rankingProfileForUser, resolveRankingModelForUser, resolveRankingShadow } from './rankingModel.js';

const here = dirname(fileURLToPath(import.meta.url));

test('only listed accounts get v2; everyone else, and anonymous callers, stay legacy', () => {
  const env = { PROGM_RANKING_V2_USER_IDS: '12' };
  assert.equal(resolveRankingModelForUser(12, env), 'v2');
  assert.equal(resolveRankingModelForUser('12', env), 'v2');
  for (const other of [1, 13, 112, 120, '1', null, undefined, '', 'abc']) assert.equal(resolveRankingModelForUser(other, env), 'legacy', String(other));
  assert.equal(resolveRankingModelForUser(12, {}), 'legacy'); // unset = off for everyone
});

test('list parsing: commas/spaces, ids normalised, junk tokens ignored', () => {
  assert.deepEqual([...parseV2UserIds({ PROGM_RANKING_V2_USER_IDS: ' 3, 007, 9  10\n11 x;1 ' })].sort(), ['10', '11', '3', '7', '9']);
});

test('malformed entries are ignored, wildcards are not honoured', () => {
  for (const bad of ['*', 'all', 'true', 'on', '-1', '1.5', 'v2', '1e3', '12345678901234']) {
    assert.equal(parseV2UserIds({ PROGM_RANKING_V2_USER_IDS: bad }).size, 0, bad);
    assert.equal(resolveRankingModelForUser(1, { PROGM_RANKING_V2_USER_IDS: bad }), 'legacy', bad);
  }
  assert.equal(resolveRankingModelForUser('007', { PROGM_RANKING_V2_USER_IDS: '7' }), 'v2');
});

test('the allowlist never turns the global model off, and the global model still applies to everyone when set', () => {
  assert.equal(resolveRankingModelForUser(5, { PROGM_RANKING_MODEL: 'v2', PROGM_RANKING_V2_USER_IDS: '1' }), 'v2');
  assert.equal(resolveRankingModelForUser(1, { PROGM_RANKING_MODEL: 'v2', PROGM_RANKING_V2_USER_IDS: '1' }), 'v2');
});

test('cache identity is per account; rookie estimates stay off and independent of the allowlist', () => {
  const env = { PROGM_RANKING_V2_USER_IDS: '12' };
  assert.equal(rankingProfileForUser(12, env), 'v2.noest');
  assert.equal(rankingProfileForUser(13, env), 'legacy.noest');
  assert.equal(rankingProfileForUser(13, env), rankingProfile({}));       // unlisted accounts keep today's exact profile/keys
  assert.equal(rankingProfileForUser(null, env), 'legacy.noest');
  assert.equal(rankingProfileForUser(12, { ...env, PROGM_ROOKIE_ESTIMATES: 'on' }), 'v2.est');
  assert.equal(rankingProfileForUser(12, {}), 'legacy.noest');
  assert.notEqual(
    referenceKey({ leagueKey: '428.l.1', season: '2026', statCategories: [], profile: rankingProfileForUser(12, env) }),
    referenceKey({ leagueKey: '428.l.1', season: '2026', statCategories: [], profile: rankingProfileForUser(13, env) }));
});

const SETTINGS = { teamCount: 4, rosterSlots: [
  { position: 'PG', count: 1, isStarting: true }, { position: 'SF', count: 1, isStarting: true }, { position: 'C', count: 1, isStarting: true },
  { position: 'BN', count: 3, isStarting: false }] };
const history = [2025, 2024, 2023].map((season) => ({ season, gamesPlayed: 74, gameTotal: 82 }));
const POS = ['PG', 'SF', 'C'];
const specs = Array.from({ length: 36 }, (_, i) => ({ key: `P${i}`, pos: POS[i % 3], pts: 50 - i * 0.9 }));
const players = () => specs.map((s) => ({ playerKey: s.key, name: s.key, teamAbbr: 'AAA', eligiblePositions: [s.pos], percentOwned: 0, status: null }));
const proj = { getProjection: (p) => ({ projectedPoints: specs.find((x) => x.key === p.playerKey).pts, confidence: 0.9, history }) };
const boardFor = (userId, env, reference = null) => buildDraftBoard({
  players: players(), settings: SETTINGS, projectionProvider: proj, poolComplete: true, baselineReference: reference,
  rankingModel: resolveRankingModelForUser(userId, env), rookieEstimates: false,
});
function memCache() { const m = new Map(); return { get: (k) => (m.has(k) ? { value: m.get(k), meta: { stale: false } } : null), set: (k, v) => m.set(k, v), keys: () => [...m.keys()] }; }

test('account isolation: the listed account is on v2; any other account is byte-identical to the allowlist-free legacy board', () => {
  const env = { PROGM_RANKING_V2_USER_IDS: '12' };
  const mine = boardFor(12, env); const other = boardFor(13, env); const baseline = boardFor(13, {});
  assert.equal(mine.rankingModel, 'v2');
  assert.equal(other.rankingModel, 'legacy');
  assert.equal(JSON.stringify(other), JSON.stringify(baseline));
  assert.ok(mine.board.some((r, i) => r.playerKey !== other.board[i].playerKey || r.value !== other.board[i].value), 'v2 must actually differ from legacy');
  assert.equal(mine.board[0].components.scarcity !== undefined, true);
});

test('frozen baselines are separated by account profile: a v2 reference is never served to a legacy account and vice versa', () => {
  const env = { PROGM_RANKING_V2_USER_IDS: '12' };
  const cache = memCache();
  const key = (u) => referenceKey({ leagueKey: '428.l.1', season: '2026', statCategories: [], profile: rankingProfileForUser(u, env) });
  const mine = boardFor(12, env); saveBaselineReference(cache, key(12), mine.baselineReference);
  assert.ok(loadBaselineReference(cache, key(12)));
  assert.equal(loadBaselineReference(cache, key(13)), null);
  const other = boardFor(13, env); saveBaselineReference(cache, key(13), other.baselineReference);
  assert.equal(loadBaselineReference(cache, key(12)).model, 'v2');
  assert.equal(loadBaselineReference(cache, key(13)).model, 'legacy');
  assert.equal(new Set(cache.keys()).size, 2);
  // Even a mis-routed reference cannot change the model: the board drops a reference built under another model.
  const guarded = boardFor(13, env, loadBaselineReference(cache, key(12)));
  assert.equal(JSON.stringify(guarded), JSON.stringify(boardFor(13, {})));
});

test('shadow mode is only for accounts whose visible model is legacy', () => {
  const env = { PROGM_RANKING_SHADOW: 'on', PROGM_RANKING_V2_USER_IDS: '12' };
  assert.equal(resolveRankingShadow(env, 12), false);
  assert.equal(resolveRankingShadow(env, 13), true);
});

test('wiring guard: workspace route, workspace builder and live draft route use per-account model/profile only', () => {
  for (const f of ['../../routes/basketball.js', 'basketballWorkspace.js']) {
    const text = readFileSync(join(here, f), 'utf8');
    assert.ok(!/resolveRankingModel\(\)/.test(text), `${f}: global resolveRankingModel() call`);
    assert.ok(!/rankingProfile\(\)/.test(text), `${f}: global rankingProfile() call`);
  }
  const route = readFileSync(join(here, '../../routes/basketball.js'), 'utf8');
  assert.equal((route.match(/rankingProfileForUser\(req\.userId\)/g) || []).length >= 3, true); // workspace cache key, ranking-compare key, live draft reference key
  assert.match(route, /buildBasketballWorkspace\(\{[^}]*userId: req\.userId/);
});
