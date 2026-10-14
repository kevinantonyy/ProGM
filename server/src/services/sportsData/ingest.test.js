import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWalkForwardBacktest } from '../fantasy/backtest/runner.js';
import { exportHistoricalSnapshots, ingestBatch, registerSource } from './ingest.js';
import { MemorySportsDataStore } from './memoryStore.js';
import { ingestionBlockers, normalizeSource } from './sourcePermissions.js';
import { syntheticBatch, syntheticSource } from './syntheticFixture.js';

async function seeded(sourceOverrides = {}) {
  const store = new MemorySportsDataStore();
  await registerSource(store, syntheticSource(sourceOverrides));
  return store;
}

test('sources must document every permission explicitly', () => {
  assert.throws(() => normalizeSource({ ...syntheticSource(), permissions: { storage: true } }), /permissions\.commercialUse/);
  assert.throws(() => normalizeSource({ ...syntheticSource(), termsReviewedAt: null }), /termsReviewedAt/);
  assert.throws(() => normalizeSource({ ...syntheticSource(), reviewedBy: '' }), /reviewedBy/);
  assert.throws(() => normalizeSource({ ...syntheticSource(), licenseUrl: 'http://insecure.test' }), /https/);
  assert.throws(() => normalizeSource({ ...syntheticSource(), sports: ['cricket'] }), /known sports/);
  assert.throws(() => normalizeSource({ ...syntheticSource(), sourceKey: 'Bad Key' }), /slug/);
});

test('ingestion is refused without storage and commercial-use grants or for restricted providers', async () => {
  const blocked = [
    [{ permissions: { ...syntheticSource().permissions, storage: false } }, /storage is not permitted/],
    [{ permissions: { ...syntheticSource().permissions, commercialUse: false } }, /commercial use/],
    [{ sourceKey: 'bref', name: 'Basketball-Reference export' }, /Sports Reference/],
    [{ sourceKey: 'nba-stats', sourceUrl: 'https://stats.nba.com/stats/leaguegamelog' }, /NBA\.com/],
    [{ sourceKey: 'espn-feed', provider: 'ESPN' }, /ESPN/],
    [{ sourceKey: 'brescou-copy', sourceUrl: 'https://github.com/Brescou/NBA-dataset-stats-player-team' }, /Brescou/],
  ];
  for (const [overrides, pattern] of blocked) {
    const store = await seeded(overrides);
    const sourceKey = overrides.sourceKey || 'synthetic-fixture';
    await assert.rejects(ingestBatch(store, syntheticBatch({ sourceKey })), pattern);
    assert.equal((await store.query('teams', 'basketball')).length, 0);
  }
  const permitted = normalizeSource(syntheticSource({ sourceKey: 'nba-licensed', provider: 'NBA.com', writtenPermissionUrl: 'https://example.test/signed-agreement' }));
  assert.deepEqual(ingestionBlockers(permitted, 'basketball'), []);
  await assert.rejects(ingestBatch(new MemorySportsDataStore(), syntheticBatch()), /not registered/);
});

test('a stored registration that was weakened after registering is rejected at ingestion', async () => {
  const store = await seeded();
  store.state.sources.get('synthetic-fixture').permissions.storage = 'yes';
  await assert.rejects(ingestBatch(store, syntheticBatch()), /permissions\.storage/);
});

test('ingestion stores normalized, attributed records and is idempotent', async () => {
  const store = await seeded();
  const first = await ingestBatch(store, syntheticBatch());
  assert.deepEqual(first.counts.playerGameStats, { inserted: 4, updated: 0, unchanged: 0, duplicatesCollapsed: 0 });
  assert.deepEqual(first.counts.games.inserted, 2);
  const again = await ingestBatch(store, syntheticBatch());
  for (const kind of ['teams', 'players', 'games', 'playerGameStats']) assert.equal(again.counts[kind].inserted + again.counts[kind].updated, 0);

  const [stat] = await store.query('playerGameStats', 'basketball', { playerId: 'P1', season: 2023 });
  assert.equal(stat.sourceKey, 'synthetic-fixture');
  assert.equal(stat.season, 2023);
  assert.equal(stat.stats.points, 20);
  const runs = await store.listRuns();
  assert.deepEqual(runs.map((run) => run.status), ['succeeded', 'succeeded']);
});

test('incremental updates change only modified records and add new games', async () => {
  const store = await seeded();
  await ingestBatch(store, syntheticBatch());
  const batch = syntheticBatch();
  batch.playerGameStats[0].stats.points = 21;
  const result = await ingestBatch(store, batch);
  assert.equal(result.counts.playerGameStats.updated, 1);
  assert.equal(result.counts.playerGameStats.unchanged, 3);
  // A later batch can reference teams and players already stored.
  const next = syntheticBatch({ gameOffset: 10 });
  const added = await ingestBatch(store, { sourceKey: next.sourceKey, sport: 'basketball', games: next.games, playerGameStats: next.playerGameStats });
  assert.equal(added.counts.games.inserted, 2);
  assert.equal(added.counts.playerGameStats.inserted, 4);
  assert.equal((await store.query('games', 'basketball')).length, 4);
});

test('in-batch duplicates collapse when identical and fail when conflicting', async () => {
  const store = await seeded();
  const batch = syntheticBatch();
  batch.players.push({ ...batch.players[0] });
  const result = await ingestBatch(store, batch);
  assert.equal(result.counts.players.duplicatesCollapsed, 1);
  assert.equal(result.counts.players.inserted, 2);
  const conflicting = syntheticBatch();
  conflicting.players.push({ ...conflicting.players[0], fullName: 'Someone Else' });
  await assert.rejects(ingestBatch(store, conflicting), /Conflicting duplicate players/);
});

test('invalid or inconsistent records reject the whole batch atomically and log a failed run', async () => {
  const cases = [
    [(batch) => { batch.playerGameStats[0].stats.fgMade = 20; }, /fgMade greater than fgAtt/],
    [(batch) => { batch.playerGameStats[0].stats.rebounds = 9; }, /rebound split/],
    [(batch) => { batch.playerGameStats[0].stats.points = -1; }, /negative points/],
    [(batch) => { batch.playerGameStats[0].stats.points = 'many'; }, /non-numeric points/],
    [(batch) => { batch.playerGameStats[0].playerId = 'P404'; }, /unknown players: P404/],
    [(batch) => { batch.playerGameStats[0].teamId = 'T3'; batch.teams.push({ externalId: 'T3', name: 'Fixture Gammas' }); }, /did not play in game/],
    [(batch) => { batch.games[0].homeTeamId = 'T9'; }, /unknown teams: T9/],
    [(batch) => { batch.games[0].season = 1800; }, /invalid season/],
    [(batch) => { batch.games[0].seasonType = 'exhibition'; }, /unsupported seasonType/],
    [(batch) => { batch.players[0].fullName = ''; }, /fullName is required/],
  ];
  for (const [mutate, pattern] of cases) {
    const store = await seeded();
    const batch = syntheticBatch();
    mutate(batch);
    await assert.rejects(ingestBatch(store, batch), pattern);
    for (const kind of ['teams', 'players', 'games', 'playerGameStats']) assert.equal((await store.query(kind, 'basketball')).length, 0, `${kind} left behind`);
    const [run] = await store.listRuns();
    assert.equal(run.status, 'failed');
    assert.match(run.error, pattern);
  }
});

test('records from different sources stay separate and attributed', async () => {
  const store = await seeded();
  await registerSource(store, syntheticSource({ sourceKey: 'synthetic-second', name: 'Second synthetic fixture' }));
  await ingestBatch(store, syntheticBatch());
  await ingestBatch(store, syntheticBatch({ sourceKey: 'synthetic-second', points: 30 }));
  const players = await store.query('players', 'basketball', { search: 'guard' });
  assert.deepEqual(players.map((player) => player.sourceKey), ['synthetic-fixture', 'synthetic-second']);
  const second = await store.query('playerGameStats', 'basketball', { sourceKey: 'synthetic-second', playerId: 'P1' });
  assert.deepEqual(second.map((row) => row.stats.points).sort(), [30, 40]);
});

test('football is reserved but not ingestible yet', async () => {
  const store = await seeded({ sports: ['basketball', 'football'] });
  await assert.rejects(ingestBatch(store, { ...syntheticBatch(), sport: 'football' }), /not implemented/);
});

test('stored data exports to Phase 8 snapshots only with a model-training grant', async () => {
  const store = await seeded();
  await ingestBatch(store, syntheticBatch({ season: 2022 }));
  await ingestBatch(store, syntheticBatch({ season: 2023, gameOffset: 10, points: 24 }));
  const imported = await exportHistoricalSnapshots(store, { sport: 'basketball', sourceKey: 'synthetic-fixture' });
  const guard = imported.snapshots.find((row) => row.player.id === 'synthetic-fixture:P1' && row.season === 2023);
  assert.equal(guard.gamesPlayed, 2);
  assert.equal(guard.stats.points, 29);
  assert.equal(guard.stats.doubleDoubles, 0.5);
  assert.equal(guard.age, 23); // as of 2024-02-01
  assert.equal(guard.experience, 3);
  assert.equal(guard.teamAbbr, 'AAA');
  const center = imported.snapshots.find((row) => row.player.id === 'synthetic-fixture:P2' && row.season === 2023);
  assert.equal(center.gamesPlayed, 1); // DNP excluded
  assert.equal(imported.provenance.synthetic, true);
  const report = runWalkForwardBacktest({ snapshots: imported.snapshots, statCategories: [{ statId: 12, abbr: 'PTS', pointValue: 1, enabled: true }] });
  assert.equal(report.coverage.predictions, 2);

  const noTraining = await seeded({ permissions: { ...syntheticSource().permissions, modelTraining: false } });
  await ingestBatch(noTraining, syntheticBatch());
  await assert.rejects(exportHistoricalSnapshots(noTraining, { sport: 'basketball', sourceKey: 'synthetic-fixture' }), /does not permit model training/);
});
