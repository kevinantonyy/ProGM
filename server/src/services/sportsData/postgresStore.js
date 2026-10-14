/**
 * Postgres implementation of the sports data store interface, built on the
 * existing `pg` pool. Tables are created lazily by ensureSchema() (only when
 * the internal sports data feature is used), never by the app's startup path.
 * Every statement is parameterized.
 */
const TABLES = Object.freeze({
  teams: { table: 'sd_teams', columns: {} },
  players: { table: 'sd_players', columns: {} },
  games: {
    table: 'sd_games',
    columns: { season: 'season', season_type: 'seasonType', game_date: 'gameDate', home_team_id: 'homeTeamId', away_team_id: 'awayTeamId' },
  },
  playerGameStats: {
    table: 'sd_player_game_stats',
    columns: { game_id: 'gameId', player_id: 'playerId', team_id: 'teamId', season: 'season', season_type: 'seasonType' },
  },
});

const COMMON = `sport VARCHAR(20) NOT NULL, source_key VARCHAR(63) NOT NULL REFERENCES sd_sources(source_key),
  external_id VARCHAR(160) NOT NULL, data JSONB NOT NULL, content_hash CHAR(64) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;

export const SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS sd_sources (source_key VARCHAR(63) PRIMARY KEY, data JSONB NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sd_teams (${COMMON}, PRIMARY KEY (sport, source_key, external_id))`,
  `CREATE TABLE IF NOT EXISTS sd_players (${COMMON}, PRIMARY KEY (sport, source_key, external_id))`,
  `CREATE TABLE IF NOT EXISTS sd_games (${COMMON}, season INTEGER NOT NULL, season_type VARCHAR(20) NOT NULL,
    game_date DATE, home_team_id VARCHAR(160) NOT NULL, away_team_id VARCHAR(160) NOT NULL,
    PRIMARY KEY (sport, source_key, external_id),
    FOREIGN KEY (sport, source_key, home_team_id) REFERENCES sd_teams(sport, source_key, external_id),
    FOREIGN KEY (sport, source_key, away_team_id) REFERENCES sd_teams(sport, source_key, external_id))`,
  `CREATE TABLE IF NOT EXISTS sd_player_game_stats (${COMMON}, game_id VARCHAR(160) NOT NULL, player_id VARCHAR(160) NOT NULL,
    team_id VARCHAR(160) NOT NULL, season INTEGER NOT NULL, season_type VARCHAR(20) NOT NULL,
    PRIMARY KEY (sport, source_key, external_id),
    UNIQUE (sport, source_key, game_id, player_id),
    FOREIGN KEY (sport, source_key, game_id) REFERENCES sd_games(sport, source_key, external_id),
    FOREIGN KEY (sport, source_key, player_id) REFERENCES sd_players(sport, source_key, external_id),
    FOREIGN KEY (sport, source_key, team_id) REFERENCES sd_teams(sport, source_key, external_id))`,
  'CREATE INDEX IF NOT EXISTS sd_games_season_idx ON sd_games (sport, season, season_type)',
  'CREATE INDEX IF NOT EXISTS sd_pgs_player_idx ON sd_player_game_stats (sport, source_key, player_id, season)',
  `CREATE TABLE IF NOT EXISTS sd_ingestion_runs (id SERIAL PRIMARY KEY, source_key VARCHAR(63) NOT NULL REFERENCES sd_sources(source_key),
    sport VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, counts JSONB NOT NULL DEFAULT '{}'::jsonb, error TEXT,
    started_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ NOT NULL)`,
]);

function rowToRecord(row) {
  return { sourceKey: row.source_key, ...row.data, firstSeenAt: new Date(row.first_seen_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

class PostgresTx {
  constructor(client) { this.client = client; }

  async upsertSource(source) {
    await this.client.query(`INSERT INTO sd_sources (source_key, data) VALUES ($1, $2)
      ON CONFLICT (source_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [source.sourceKey, source]);
  }

  async getSource(sourceKey) {
    const { rows } = await this.client.query('SELECT data, registered_at, updated_at FROM sd_sources WHERE source_key = $1', [sourceKey]);
    return rows[0] ? { ...rows[0].data, registeredAt: new Date(rows[0].registered_at).toISOString(), updatedAt: new Date(rows[0].updated_at).toISOString() } : null;
  }

  async listSources() {
    const { rows } = await this.client.query('SELECT data, registered_at, updated_at FROM sd_sources ORDER BY source_key COLLATE "C"');
    return rows.map((row) => ({ ...row.data, registeredAt: new Date(row.registered_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }));
  }

  async getRecords(kind, sport, sourceKey, externalIds) {
    if (!externalIds.length) return new Map();
    const { rows } = await this.client.query(
      `SELECT external_id, data, content_hash FROM ${TABLES[kind].table} WHERE sport = $1 AND source_key = $2 AND external_id = ANY($3::text[])`,
      [sport, sourceKey, externalIds],
    );
    return new Map(rows.map((row) => [row.external_id, { ...row.data, contentHash: row.content_hash }]));
  }

  async upsertRecords(kind, sport, sourceKey, records) {
    const { table, columns } = TABLES[kind];
    const extra = Object.keys(columns);
    const names = ['sport', 'source_key', 'external_id', ...extra, 'data', 'content_hash'];
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    const updates = [...extra, 'data', 'content_hash'].map((name) => `${name} = EXCLUDED.${name}`).join(', ');
    const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})
      ON CONFLICT (sport, source_key, external_id) DO UPDATE SET ${updates}, updated_at = now()
      WHERE ${table}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
      RETURNING (xmax = 0) AS inserted`;
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const record of records) {
      const { contentHash, ...data } = record;
      const { rows } = await this.client.query(sql, [sport, sourceKey, record.externalId, ...extra.map((name) => record[columns[name]] ?? null), data, contentHash]);
      if (!rows.length) counts.unchanged += 1;
      else counts[rows[0].inserted ? 'inserted' : 'updated'] += 1;
    }
    return counts;
  }

  async insertRun(run) {
    const { rows } = await this.client.query(
      `INSERT INTO sd_ingestion_runs (source_key, sport, status, counts, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [run.sourceKey, run.sport, run.status, run.counts || {}, run.error || null, run.startedAt, run.finishedAt],
    );
    return rows[0].id;
  }

  async listRuns({ limit = 50 } = {}) {
    const { rows } = await this.client.query(
      'SELECT id, source_key, sport, status, counts, error, started_at, finished_at FROM sd_ingestion_runs ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return rows.map((row) => ({
      id: row.id, sourceKey: row.source_key, sport: row.sport, status: row.status, counts: row.counts, error: row.error,
      startedAt: new Date(row.started_at).toISOString(), finishedAt: new Date(row.finished_at).toISOString(),
    }));
  }

  async query(kind, sport, filters = {}, { limit = 100, offset = 0 } = {}) {
    const { table } = TABLES[kind];
    const params = [sport];
    const where = ['sport = $1'];
    const add = (clause, value) => { params.push(value); where.push(clause.replaceAll('?', `$${params.length}`)); };
    if (filters.sourceKey) add('source_key = ?', filters.sourceKey);
    if (filters.season != null && (kind === 'games' || kind === 'playerGameStats')) add('season = ?', filters.season);
    if (filters.seasonType && (kind === 'games' || kind === 'playerGameStats')) add('season_type = ?', filters.seasonType);
    if (filters.teamId && kind === 'games') add('(home_team_id = ? OR away_team_id = ?)', filters.teamId);
    if (filters.teamId && kind === 'playerGameStats') add('team_id = ?', filters.teamId);
    if (filters.playerId && kind === 'playerGameStats') add('player_id = ?', filters.playerId);
    if (filters.gameId && kind === 'playerGameStats') add('game_id = ?', filters.gameId);
    if (filters.search && kind === 'players') add("data->>'fullName' ILIKE ?", `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`);
    // Byte-order collation keeps pagination deterministic and identical to the memory store.
    const keys = 'source_key COLLATE "C", external_id COLLATE "C"';
    const order = kind === 'games' ? `game_date NULLS FIRST, ${keys}` : keys;
    params.push(limit, offset);
    const { rows } = await this.client.query(
      `SELECT source_key, data, first_seen_at, updated_at FROM ${table} WHERE ${where.join(' AND ')}
       ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map(rowToRecord);
  }
}

export class PostgresSportsDataStore extends PostgresTx {
  constructor(pool) {
    super(pool);
    this.pool = pool;
    this.schemaReady = null;
  }

  async ensureSchema() {
    this.schemaReady ||= (async () => {
      for (const statement of SCHEMA_STATEMENTS) await this.pool.query(statement);
    })().catch((error) => { this.schemaReady = null; throw error; });
    return this.schemaReady;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
