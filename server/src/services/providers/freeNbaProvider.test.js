/**
 * Unit tests for the EXPERIMENTAL freeNbaProvider MAPPERS only.
 * No live network — fixtures mirror the real shapes observed during probing.
 * These verify the ESPN/NBA-CDN responses normalize into ProGM's provider-
 * independent structures with no fabricated data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapEspnDirectory, mapEspnSeasonStats, espnNamesByCategory, espnAthleteStatMap,
  espnStatMapToLine, mapNbaSchedule, toYmd, mapBoxscore, mapBoxscorePlayerLine, mapEspnInjuries,
  parseIsoMinutes, aggregateRecentLines, mapNbaScheduleWithIds, recentCompletedGameIds, getRecentForm, espnSeasonEndYear,
} from './freeNbaProvider.js';

test('Yahoo/NBA season start-year maps to ESPN season end-year', () => {
  assert.equal(espnSeasonEndYear(2026), 2027);
  assert.equal(espnSeasonEndYear('2025'), 2026);
  assert.equal(espnSeasonEndYear('bad'), null);
});

// Fixture mirroring the real ESPN byathlete payload (categories + values).
const ESPN_BYATHLETE = {
  categories: [
    { name: 'general', names: ['gamesPlayed', 'avgMinutes', 'rebounds', 'avgRebounds'] },
    { name: 'offensive', names: ['avgPoints', 'avgFieldGoalsMade', 'avgFieldGoalsAttempted', 'avgThreePointFieldGoalsMade', 'avgFreeThrowsMade', 'avgFreeThrowsAttempted', 'avgAssists', 'avgTurnovers'] },
    { name: 'defensive', names: ['avgSteals', 'avgBlocks'] },
  ],
  athletes: [
    {
      athlete: { id: '4278073', displayName: 'Shai Gilgeous-Alexander', teamShortName: 'OKC', position: { abbreviation: 'G' }, headshot: { href: 'https://a.espncdn.com/i/headshots/nba/players/full/4278073.png' } },
      categories: [
        { name: 'general', values: [76, 34.2, 379, 5.0] },
        { name: 'offensive', values: [32.7, 11.3, 21.8, 2.1, 7.9, 8.8, 6.4, 2.4] },
        { name: 'defensive', values: [1.7, 1.0] },
      ],
    },
  ],
};

test('espnNamesByCategory + espnAthleteStatMap zip names to values', () => {
  const namesByCat = espnNamesByCategory(ESPN_BYATHLETE);
  const m = espnAthleteStatMap(ESPN_BYATHLETE.athletes[0], namesByCat);
  assert.equal(m.gamesPlayed, 76);
  assert.equal(m.avgPoints, 32.7);
  assert.equal(m.avgRebounds, 5.0);
  assert.equal(m.avgAssists, 6.4);
  assert.equal(m.avgSteals, 1.7);
  assert.equal(m.avgBlocks, 1.0);
});

test('espnStatMapToLine maps per-game averages into a StatLine (no fabrication)', () => {
  const namesByCat = espnNamesByCategory(ESPN_BYATHLETE);
  const line = espnStatMapToLine(espnAthleteStatMap(ESPN_BYATHLETE.athletes[0], namesByCat));
  assert.equal(line.points, 32.7);
  assert.equal(line.rebounds, 5.0);
  assert.equal(line.assists, 6.4);
  assert.equal(line.steals, 1.7);
  assert.equal(line.blocks, 1.0);
  assert.equal(line.turnovers, 2.4);
  assert.equal(line.threesMade, 2.1);
  assert.equal(line.fgMade, 11.3);
  assert.equal(line.ftAtt, 8.8);
  assert.equal(line.minutes, 34.2);
  assert.equal(line.gamesPlayed, 76);
  assert.equal(line.doubleDoubles, null); // not provided -> null, not 0
});

test('mapEspnDirectory produces ProviderPlayerRef with no yahooId', () => {
  const dir = mapEspnDirectory(ESPN_BYATHLETE);
  assert.equal(dir.length, 1);
  assert.deepEqual(dir[0], { externalId: '4278073', name: 'Shai Gilgeous-Alexander', teamAbbr: 'OKC', yahooId: null, imageUrl: 'https://a.espncdn.com/i/headshots/nba/players/full/4278073.png' });
});

test('mapEspnSeasonStats yields PlayerStats keyed by externalId, recent null', () => {
  const stats = mapEspnSeasonStats(ESPN_BYATHLETE);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].externalId, '4278073');
  assert.equal(stats[0].season.points, 32.7);
  assert.equal(stats[0].recent, null);
  assert.equal(stats[0].recentGameCount, null);
});

test('toYmd converts ISO dates', () => {
  assert.equal(toYmd('2025-11-03T00:00:00Z'), '20251103');
  assert.equal(toYmd('2025-11-03'), '20251103');
  assert.equal(toYmd(null), null);
  assert.equal(toYmd('bad'), null);
});

test('mapNbaSchedule attributes each game to home AND away, marks completed', () => {
  const payload = {
    leagueSchedule: {
      gameDates: [
        { games: [
          { gameId: '1', gameDateEst: '2025-11-03T00:00:00Z', gameStatus: 3, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' } },
          { gameId: '2', gameDateEst: '2025-11-05T00:00:00Z', gameStatus: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'PHI' } },
        ] },
      ],
    },
  };
  const sched = mapNbaSchedule(payload);
  assert.deepEqual(sched.BOS, [{ gameDate: '20251103', completed: true }, { gameDate: '20251105', completed: false }]);
  assert.deepEqual(sched.NYK, [{ gameDate: '20251103', completed: true }]);
  assert.deepEqual(sched.PHI, [{ gameDate: '20251105', completed: false }]);
});

test('mapBoxscorePlayerLine + mapBoxscore build single-game lines by personId', () => {
  const one = mapBoxscorePlayerLine({ points: 24, reboundsTotal: 7, assists: 6, steals: 2, blocks: 0, turnovers: 3, fieldGoalsMade: 9, fieldGoalsAttempted: 17, freeThrowsMade: 4, freeThrowsAttempted: 5, threePointersMade: 2 });
  assert.equal(one.points, 24);
  assert.equal(one.gamesPlayed, 1);
  assert.equal(one.rebounds, 7);
  const payload = { game: { homeTeam: { players: [{ personId: 111, name: 'A', statistics: { points: 24, reboundsTotal: 7, assists: 6 } }] }, awayTeam: { players: [{ personId: 222, name: 'B', statistics: { points: 10, reboundsTotal: 3, assists: 1 } }] } } };
  const rows = mapBoxscore(payload);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].externalId, '111');
  assert.equal(rows[1].externalId, '222');
  assert.equal(rows[0].line.points, 24);
});

test('mapEspnInjuries flattens teams to per-player records', () => {
  const payload = {
    injuries: [
      { id: '1', displayName: 'Atlanta Hawks', injuries: [
        { status: 'Out', shortComment: 'Ankle', athlete: { id: '999' } },
        { status: 'Day-To-Day', longComment: 'Knee soreness', athlete: { id: '888' } },
      ] },
      { id: '2', displayName: 'Boston Celtics', injuries: [] },
    ],
  };
  const recs = mapEspnInjuries(payload);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { externalId: '999', designation: 'Out', description: 'Ankle' });
  assert.equal(recs[1].externalId, '888');
  assert.equal(recs[1].designation, 'Day-To-Day');
});

test('mappers tolerate empty/garbage payloads without throwing', () => {
  assert.deepEqual(mapEspnDirectory(null), []);
  assert.deepEqual(mapEspnSeasonStats({}), []);
  assert.deepEqual(mapNbaSchedule(null), {});
  assert.deepEqual(mapBoxscore({}), []);
  assert.deepEqual(mapEspnInjuries(null), []);
});

// --- ISO-8601 duration / minutes parsing ------------------------------------

test('parseIsoMinutes handles PT##M##S and edge formats', () => {
  assert.equal(parseIsoMinutes('PT34M12.00S'), 34.2);
  assert.equal(parseIsoMinutes('PT34M'), 34);
  assert.equal(parseIsoMinutes('PT0M00.00S'), 0);
  assert.equal(parseIsoMinutes('PT12S'), 0.2);
  assert.equal(parseIsoMinutes('28:30'), 28.5); // MM:SS fallback
  assert.equal(parseIsoMinutes(31.5), 31.5);    // plain number
  assert.equal(parseIsoMinutes(''), null);        // empty -> null, not 0
  assert.equal(parseIsoMinutes(null), null);
  assert.equal(parseIsoMinutes('PT'), null);      // no components -> null
});

test('mapBoxscorePlayerLine parses ISO minutes', () => {
  const line = mapBoxscorePlayerLine({ minutes: 'PT34M12.00S', points: 20 });
  assert.equal(line.minutes, 34.2);
  assert.equal(line.points, 20);
  const noMin = mapBoxscorePlayerLine({ points: 20 });
  assert.equal(noMin.minutes, null); // missing -> null (never 0)
});

// --- Recent-form aggregation ------------------------------------------------

test('aggregateRecentLines averages present stats, nulls when always missing', () => {
  const g1 = { ...mapBoxscorePlayerLine({ points: 20, reboundsTotal: 10, assists: 4, minutes: 'PT30M' }) };
  const g2 = { ...mapBoxscorePlayerLine({ points: 30, reboundsTotal: 6, assists: 8, minutes: 'PT40M' }) };
  const agg = aggregateRecentLines([g1, g2]);
  assert.equal(agg.gameCount, 2);
  assert.equal(agg.line.points, 25);
  assert.equal(agg.line.rebounds, 8);
  assert.equal(agg.line.assists, 6);
  assert.equal(agg.line.minutes, 35);
  assert.equal(agg.line.doubleDoubles, null); // never present -> stays null
  assert.equal(aggregateRecentLines([]), null);
});

test('mapNbaScheduleWithIds keeps gameId; recentCompletedGameIds picks newest completed, deduped', () => {
  const payload = { leagueSchedule: { gameDates: [
    { games: [{ gameId: 'g1', gameDateEst: '2025-11-01T00:00:00Z', gameStatus: 3, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' } }] },
    { games: [{ gameId: 'g2', gameDateEst: '2025-11-03T00:00:00Z', gameStatus: 3, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'PHI' } }] },
    { games: [{ gameId: 'g3', gameDateEst: '2025-11-05T00:00:00Z', gameStatus: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'MIA' } }] },
  ] } };
  const sched = mapNbaScheduleWithIds(payload);
  assert.equal(sched.BOS.length, 3);
  assert.equal(sched.BOS[0].gameId, 'g1');
  const ids = recentCompletedGameIds(sched, 10);
  // g1 + g2 completed (g3 scheduled); shared BOS games deduped once.
  assert.deepEqual([...ids].sort(), ['g1', 'g2']);
});

test('getRecentForm builds a per-player map from ONE box score per game (stubbed fetchBox)', async () => {
  // Stub schedule fetch via global.fetch for just the schedule URL; stub box via param.
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('scheduleLeagueV2')) {
      return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => JSON.stringify({ leagueSchedule: { gameDates: [
        { games: [{ gameId: 'g1', gameDateEst: '2025-11-01T00:00:00Z', gameStatus: 3, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' } }] },
      ] } }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  let boxCalls = 0;
  const fetchBox = async (gid) => { boxCalls += 1; return [{ externalId: '111', line: mapBoxscorePlayerLine({ points: 20, reboundsTotal: 5, minutes: 'PT30M' }) }, { externalId: '222', line: mapBoxscorePlayerLine({ points: 10, reboundsTotal: 2, minutes: 'PT20M' }) }]; };
  try {
    const map = await getRecentForm('2025', { fetchBox });
    assert.equal(boxCalls, 1); // ONE box score populated BOTH players
    assert.equal(map.get('111').recentGameCount, 1);
    assert.equal(map.get('111').recent.points, 20);
    assert.equal(map.get('222').recent.points, 10);
  } finally {
    global.fetch = originalFetch;
  }
});
