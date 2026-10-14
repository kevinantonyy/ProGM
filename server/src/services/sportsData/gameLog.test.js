import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptGameLogs } from './gameLogAdapter.js';
import { gameFantasyPoints, loadPlayerGameLogs, previousSeasonBaseline, runGameLogEvaluation } from './gameLogEvaluation.js';
import { importGameLogRows } from './gameLogImport.js';
import { MemorySportsDataStore } from './memoryStore.js';
import { syntheticSource } from './syntheticFixture.js';

// Synthetic, repository-generated rows in NBA-style lowercase columns. Not real data.
const SCORING = [
  { statId: 12, abbr: 'PTS', pointValue: 1, enabled: true },
  { statId: 15, abbr: 'REB', pointValue: 1.2, enabled: true },
  { statId: 16, abbr: 'AST', pointValue: 1.5, enabled: true },
  { statId: 17, abbr: 'ST', pointValue: 3, enabled: true },
  { statId: 18, abbr: 'BLK', pointValue: 3, enabled: true },
  { statId: 19, abbr: 'TO', pointValue: -1, enabled: true },
];

function seededRandom(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
}

/** Seasons are labelled by END year, as NBA stats tables do (2021 = 2020-21). */
function syntheticRows({ endYears = [2020, 2021, 2022, 2023], datesPerSeason = 10, seed = 7 } = {}) {
  const random = seededRandom(seed);
  const rows = [];
  const teams = ['1610612701', '1610612702', '1610612703', '1610612704'];
  for (const endYear of endYears) {
    for (let day = 0; day < datesPerSeason; day += 1) {
      const date = `${endYear - 1}-11-${String(day + 1).padStart(2, '0')}`;
      for (let pair = 0; pair < 2; pair += 1) {
        const home = teams[pair * 2 + (day % 2)];
        const away = teams[pair * 2 + 1 - (day % 2)];
        const gameId = `002${String(endYear - 1).slice(2)}${String(day * 2 + pair + 1).padStart(5, '0')}`;
        for (const teamId of [home, away]) {
          for (let slot = 1; slot <= 3; slot += 1) {
            const playerId = `${teamId.slice(-1)}0${slot}`;
            const level = 8 + Number(playerId) % 7 * 2 + (endYear - 2020) * (slot - 2);
            const pts = Math.max(0, Math.round(level + (random() - 0.5) * 10));
            const oreb = Math.round(random() * 3);
            const dreb = Math.round(2 + random() * 5);
            rows.push({
              season: endYear, game_id: gameId, game_date: date, player_id: playerId, player_name: `Synthetic ${playerId}`,
              team_id: teamId, team_abbreviation: `T${teamId.slice(-1)}`, home: teamId === home, min: `${24 + slot * 3}:30`,
              pts, oreb, dreb, ast: Math.round(random() * 6), stl: Math.round(random() * 2), blk: Math.round(random() * 2),
              tov: Math.round(random() * 3), pf: 2, fgm: Math.max(1, Math.floor(pts / 3)), fga: Math.max(1, Math.floor(pts / 3)) + 5, fg3m: 1, fg3a: 3, ftm: 1, fta: 2,
            });
          }
        }
      }
    }
  }
  return rows;
}

test('adapter converts end-year labels, keeps only regular season, and validates rows', () => {
  const rows = syntheticRows({ endYears: [2021], datesPerSeason: 2 });
  rows.push({ ...rows[0], game_id: '0012000001', game_date: '2020-10-10' }); // preseason
  rows.push({ ...rows[0], game_id: '0042000101', game_date: '2021-05-30' }); // playoffs
  rows.push({ ...rows[0], player_id: '999', player_name: '' }); // no name
  rows.push({ ...rows[0] }); // identical duplicate
  const { batches, diagnostics } = adaptGameLogs(rows, { sourceKey: 'synthetic-fixture', seasonLabel: 'end' });
  assert.equal(batches.length, 1);
  const [batch] = batches;
  assert.equal(batch.season, 2020);
  assert.equal(batch.games.length, 4);
  assert.equal(batch.playerGameStats.length, 24);
  assert.deepEqual([diagnostics.nonRegularSeasonSkipped, diagnostics.noPlayerNameSkipped, diagnostics.duplicateRowsCollapsed], [2, 1, 1]);
  const game = batch.games[0];
  assert.equal(game.homeTeamId, '1610612701');
  const stat = batch.playerGameStats[0].stats;
  assert.equal(stat.minutes, 27.5);
  assert.equal(stat.rebounds, stat.offRebounds + stat.defRebounds);

  assert.throws(() => adaptGameLogs(syntheticRows({ endYears: [2021], datesPerSeason: 1 }), { sourceKey: 's', seasonLabel: 'start' }), /check seasonLabel/);
  assert.throws(() => adaptGameLogs([], { sourceKey: 's' }), /seasonLabel/);
  const conflicting = syntheticRows({ endYears: [2021], datesPerSeason: 1 });
  conflicting.push({ ...conflicting[0], pts: conflicting[0].pts + 1 });
  assert.throws(() => adaptGameLogs(conflicting, { sourceKey: 's', seasonLabel: 'end' }), /Conflicting duplicate/);
  const oneSided = syntheticRows({ endYears: [2021], datesPerSeason: 1 }).filter((row) => !(row.game_id.endsWith('1') && row.team_id === '1610612702'));
  assert.equal(adaptGameLogs(oneSided, { sourceKey: 's', seasonLabel: 'end' }).diagnostics.incompleteGamesSkipped, 1);
});

test('import refuses sources without documented rights and stores nothing', async () => {
  const rows = syntheticRows({ endYears: [2021], datesPerSeason: 1 });
  for (const [overrides, pattern] of [
    [{ sourceKey: 'llimllib-nba-data', sourceUrl: 'https://github.com/llimllib/nba_data' }, /no licence/],
    [{ sourceKey: 'nba-stats', sourceUrl: 'https://stats.nba.com/stats/playergamelogs' }, /NBA\.com/],
    [{ sourceKey: 'brescou', sourceUrl: 'https://github.com/Brescou/NBA-dataset-stats-player-team' }, /Brescou/],
    [{ permissions: { ...syntheticSource().permissions, storage: false } }, /storage is not permitted/],
  ]) {
    const store = new MemorySportsDataStore();
    await assert.rejects(importGameLogRows(store, { rows, source: syntheticSource(overrides), seasonLabel: 'end' }), pattern);
    assert.equal((await store.query('playerGameStats', 'basketball')).length, 0);
  }
});

test('import is per-season, idempotent, and incremental', async () => {
  const store = new MemorySportsDataStore();
  const rows = syntheticRows({ endYears: [2020, 2021], datesPerSeason: 3 });
  const first = await importGameLogRows(store, { rows, source: syntheticSource(), seasonLabel: 'end' });
  assert.deepEqual(first.seasons.map((s) => [s.season, s.counts.playerGameStats.inserted]), [[2019, 36], [2020, 36]]);
  const again = await importGameLogRows(store, { rows, source: syntheticSource(), seasonLabel: 'end' });
  assert.ok(again.seasons.every((s) => s.counts.playerGameStats.inserted === 0 && s.counts.playerGameStats.updated === 0));
  const more = syntheticRows({ endYears: [2021], datesPerSeason: 4 });
  const added = await importGameLogRows(store, { rows: more, source: syntheticSource(), seasonLabel: 'end' });
  assert.equal(added.seasons[0].counts.games.inserted, 2);
  assert.equal((await store.query('games', 'basketball', { season: 2020 }, { limit: 100 })).length, 8);
  const limited = await importGameLogRows(new MemorySportsDataStore(), { rows, source: syntheticSource(), seasonLabel: 'end', seasons: [2020] });
  assert.deepEqual(limited.seasons.map((s) => s.season), [2020]);
});

test('fantasy points per game follow league scoring and need every scored category', () => {
  const stats = { points: 20, rebounds: 10, assists: 5, steals: 1, blocks: 2, turnovers: 3 };
  assert.equal(gameFantasyPoints(stats, SCORING), 20 + 12 + 7.5 + 3 + 6 - 3);
  assert.equal(gameFantasyPoints({ ...stats, turnovers: null }, SCORING), null);
});

function handLogs(test2021 = 30) {
  const games = [
    { gameId: 'a', date: '2019-11-01', season: 2019, fantasyPoints: 10 },
    { gameId: 'b', date: '2019-11-02', season: 2019, fantasyPoints: 20 },
    { gameId: 'c', date: '2020-11-01', season: 2020, fantasyPoints: 12 },
    { gameId: 'd', date: '2020-11-03', season: 2020, fantasyPoints: 18 },
    { gameId: 'e', date: '2021-11-01', season: 2021, fantasyPoints: test2021 },
  ];
  return { players: new Map([['p', games]]), provenance: { name: 'hand', synthetic: true } };
}
const lastGame = ({ history }) => (history.length ? history.at(-1).fantasyPoints : null);

test('game-level evaluation matches hand-computed MAE, RMSE, bias and selection', () => {
  const report = runGameLogEvaluation({ logs: handLogs(), candidates: { lastGame } });
  assert.deepEqual(report.split, { train: [2019], validation: [2020], test: [2021] });
  assert.deepEqual(report.validation.models.baseline.overall, { count: 2, mae: 3, rmse: 3, bias: 0 });
  assert.deepEqual(report.validation.models.lastGame.overall, { count: 2, mae: 7, rmse: 7.0711, bias: 1 });
  assert.equal(report.selection.selectedModel, 'lastGame');
  assert.deepEqual(report.test.models.baseline.overall, { count: 1, mae: 15, rmse: 15, bias: -15 });
  assert.deepEqual(report.testComparison.mae, { baseline: 15, selected: 12 });
  assert.equal(report.testComparison.maeChange, -0.2);
  assert.deepEqual([report.testComparison.seasonsImproved, report.testComparison.seasonsCompared], [1, 1]);
  assert.equal(report.level, 'game');
  assert.equal(report.accuracyStatus, 'synthetic_only_unvalidated');
});

test('predictions see only earlier games; later outcomes cannot change earlier results', () => {
  const spy = ({ history, target }) => {
    assert.ok(history.every((game) => game.date < target.date));
    return previousSeasonBaseline({ history, target });
  };
  runGameLogEvaluation({ logs: handLogs(), candidates: { spy } });
  const original = runGameLogEvaluation({ logs: handLogs(), candidates: { lastGame } });
  const changed = runGameLogEvaluation({ logs: handLogs(99), candidates: { lastGame } });
  assert.deepEqual(changed.validation, original.validation);
  assert.deepEqual(changed.selection, original.selection);
  assert.notDeepEqual(changed.test, original.test);
  // Same-day games are not visible to each other.
  const sameDay = handLogs();
  sameDay.players.get('p').push({ gameId: 'f', date: '2021-11-01', season: 2021, fantasyPoints: 1 });
  runGameLogEvaluation({ logs: sameDay, candidates: { spy } });
});

test('end-to-end: stored synthetic logs evaluate reproducibly; training permission is required', async () => {
  const store = new MemorySportsDataStore();
  await importGameLogRows(store, { rows: syntheticRows(), source: syntheticSource(), seasonLabel: 'end' });
  const logs = await loadPlayerGameLogs(store, { sourceKey: 'synthetic-fixture', statCategories: SCORING });
  assert.equal(logs.players.size, 12);
  const report = runGameLogEvaluation({ logs });
  assert.deepEqual(report.split, { train: [2019, 2020], validation: [2021], test: [2022] });
  assert.equal(report.test.commonSampleCount, 12 * 10);
  assert.ok(report.selection.selectedModel.startsWith('recency_'));
  assert.deepEqual(runGameLogEvaluation({ logs: await loadPlayerGameLogs(store, { sourceKey: 'synthetic-fixture', statCategories: SCORING }) }), report);

  const noTraining = new MemorySportsDataStore();
  await importGameLogRows(noTraining, { rows: syntheticRows({ endYears: [2021], datesPerSeason: 1 }), source: syntheticSource({ permissions: { ...syntheticSource().permissions, modelTraining: false } }), seasonLabel: 'end' });
  await assert.rejects(loadPlayerGameLogs(noTraining, { sourceKey: 'synthetic-fixture', statCategories: SCORING }), /does not permit model training/);
});
