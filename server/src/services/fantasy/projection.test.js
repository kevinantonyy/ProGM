import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendStatLines, projectPlayer, makeProjectionProvider, RECENT_WEIGHT, SEASON_WEIGHT } from './projection.js';
import { emptyStatLine } from '../providers/types.js';

const CATS = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1, enabled: true },
];

function line(o) { return { ...emptyStatLine(), ...o }; }

test('blendStatLines weights recent and season correctly', () => {
  const season = line({ points: 20, gamesPlayed: 40 });
  const recent = line({ points: 30 });
  const blended = blendStatLines(season, recent);
  // 0.35*30 + 0.65*20 = 10.5 + 13 = 23.5
  assert.equal(blended.points, 23.5);
});

test('blendStatLines uses season only when recent missing', () => {
  const blended = blendStatLines(line({ points: 18 }), null);
  assert.equal(blended.points, 18);
});

test('blendStatLines returns null when no data', () => {
  assert.equal(blendStatLines(null, null), null);
  assert.equal(blendStatLines(emptyStatLine(), emptyStatLine()), null);
});

test('projectPlayer produces league-specific per-game points', () => {
  const stats = {
    externalId: 'x',
    season: line({ points: 20, assists: 6, rebounds: 8, gamesPlayed: 40 }),
    recent: line({ points: 25, assists: 8, rebounds: 10 }),
    recentGameCount: 10,
  };
  const proj = projectPlayer({ stats, statCategories: CATS });
  // expected points = .35*25+.65*20 = 21.75; ast = .35*8+.65*6=6.7; reb=.35*10+.65*8=8.7
  // league pts = 21.75*1 + 6.7*1.5 + 8.7*1 = 21.75 + 10.05 + 8.7 = 40.5
  assert.equal(proj.projectedPoints, 40.5);
  assert.equal(proj.method, 'blended_recent_season');
  assert.ok(proj.confidence > 0.9); // full season + full recent + supported
});

test('projectPlayer returns null projection and 0 confidence with no data', () => {
  const proj = projectPlayer({ stats: null, statCategories: CATS });
  assert.equal(proj.projectedPoints, null);
  assert.equal(proj.confidence, 0);
  assert.equal(proj.method, 'no_data');
});

test('projectPlayer lower confidence with small sample and season only', () => {
  const stats = { externalId: 'y', season: line({ points: 10, gamesPlayed: 4 }), recent: null, recentGameCount: null };
  const proj = projectPlayer({ stats, statCategories: CATS });
  assert.equal(proj.method, 'season_only');
  assert.ok(proj.confidence < 0.5); // tiny sample, no recent
});

test('makeProjectionProvider bridges canonical ids to getProjectedValue', () => {
  const map = new Map([['cid1', { projectedPoints: 42 }]]);
  const provider = makeProjectionProvider({
    projectionByCanonicalId: map,
    canonicalIdOf: (p) => p.playerKey,
  });
  assert.equal(provider.getProjectedValue({ playerKey: 'cid1' }), 42);
  assert.equal(provider.getProjectedValue({ playerKey: 'missing' }), null);
});

test('weights are documented constants', () => {
  assert.equal(RECENT_WEIGHT + SEASON_WEIGHT, 1);
});
