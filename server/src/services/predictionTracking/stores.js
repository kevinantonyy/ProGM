/**
 * Storage for prediction records: an in-memory reference store (tests, offline
 * tools) and a Postgres store on the existing pool. Both are append-only.
 * Postgres enforces this with triggers, independently of the application.
 */
export class MemoryPredictionStore {
  constructor() { this.rows = new Map(); }

  async ensureSchema() {}

  async transaction(fn) {
    const snapshot = new Map(this.rows);
    try { return await fn(this); } catch (error) { this.rows = snapshot; throw error; }
  }

  async getByKeys(keys) {
    const found = new Map();
    for (const key of keys) if (this.rows.has(key)) found.set(key, { ...this.rows.get(key) });
    return found;
  }

  async insertPredictions(predictions) {
    for (const prediction of predictions) {
      if (this.rows.has(prediction.key)) throw new Error(`duplicate key ${prediction.key}`);
      this.rows.set(prediction.key, Object.freeze({ ...prediction }));
    }
  }

  async list({ modelVersion, scoringConfigId, limit = 1000, offset = 0 } = {}) {
    return [...this.rows.values()]
      .filter((row) => (!modelVersion || row.modelVersion === modelVersion) && (!scoringConfigId || row.scoringConfigId === scoringConfigId))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(offset, offset + limit)
      .map(({ key: _key, hash: _hash, ...row }) => ({ ...row }));
  }
}

export const PREDICTION_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS pt_predictions (
    prediction_key TEXT PRIMARY KEY,
    sport VARCHAR(20) NOT NULL,
    player_id VARCHAR(128) NOT NULL,
    target_key VARCHAR(128) NOT NULL,
    target_game_id VARCHAR(128),
    target_date DATE NOT NULL,
    target_starts_at TIMESTAMPTZ,
    predicted_fppg DOUBLE PRECISION NOT NULL CHECK (predicted_fppg BETWEEN -100 AND 200),
    model_version VARCHAR(64) NOT NULL,
    scoring_config_id CHAR(36) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (target_starts_at IS NULL OR created_at < target_starts_at),
    CHECK (target_starts_at IS NOT NULL OR target_date > (created_at AT TIME ZONE 'UTC')::date))`,
  'CREATE INDEX IF NOT EXISTS pt_predictions_model_idx ON pt_predictions (model_version, scoring_config_id, target_date)',
  `CREATE OR REPLACE FUNCTION pt_predictions_append_only() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'pt_predictions is append-only'; END; $$ LANGUAGE plpgsql`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pt_predictions_no_change') THEN
      CREATE TRIGGER pt_predictions_no_change BEFORE UPDATE OR DELETE ON pt_predictions
        FOR EACH ROW EXECUTE FUNCTION pt_predictions_append_only();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pt_predictions_no_truncate') THEN
      CREATE TRIGGER pt_predictions_no_truncate BEFORE TRUNCATE ON pt_predictions
        FOR EACH STATEMENT EXECUTE FUNCTION pt_predictions_append_only();
    END IF;
  END $$`,
]);

function rowToPrediction(row) {
  return {
    schemaVersion: 'progm.prediction.v1',
    sport: row.sport,
    playerId: row.player_id,
    targetKey: row.target_key,
    targetGameId: row.target_game_id,
    targetDate: row.target_date instanceof Date ? row.target_date.toISOString().slice(0, 10) : String(row.target_date).slice(0, 10),
    targetStartsAt: row.target_starts_at ? new Date(row.target_starts_at).toISOString() : null,
    predictedFppg: row.predicted_fppg,
    modelVersion: row.model_version,
    scoringConfigId: row.scoring_config_id,
    createdAt: new Date(row.created_at).toISOString(),
    hash: row.content_hash,
  };
}

class PostgresTx {
  constructor(client) { this.client = client; }

  async getByKeys(keys) {
    if (!keys.length) return new Map();
    const { rows } = await this.client.query('SELECT * FROM pt_predictions WHERE prediction_key = ANY($1::text[])', [keys]);
    return new Map(rows.map((row) => [row.prediction_key, rowToPrediction(row)]));
  }

  async insertPredictions(predictions) {
    for (const p of predictions) {
      // created_at is deliberately omitted: the database clock assigns it, and
      // CHECK constraints reject a prediction at or after its target start.
      await this.client.query(
        `INSERT INTO pt_predictions (prediction_key, sport, player_id, target_key, target_game_id, target_date, target_starts_at,
           predicted_fppg, model_version, scoring_config_id, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [p.key, p.sport, p.playerId, p.targetKey, p.targetGameId, p.targetDate, p.targetStartsAt, p.predictedFppg, p.modelVersion, p.scoringConfigId, p.hash],
      );
    }
  }

  async list({ modelVersion, scoringConfigId, limit = 1000, offset = 0 } = {}) {
    const params = [];
    const where = [];
    if (modelVersion) { params.push(modelVersion); where.push(`model_version = $${params.length}`); }
    if (scoringConfigId) { params.push(scoringConfigId); where.push(`scoring_config_id = $${params.length}`); }
    params.push(limit, offset);
    const { rows } = await this.client.query(
      `SELECT * FROM pt_predictions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY prediction_key COLLATE "C" LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((row) => { const { hash: _hash, ...prediction } = rowToPrediction(row); return prediction; });
  }
}

export class PostgresPredictionStore extends PostgresTx {
  constructor(pool) {
    super(pool);
    this.pool = pool;
    this.schemaReady = null;
  }

  async ensureSchema() {
    this.schemaReady ||= (async () => {
      for (const statement of PREDICTION_SCHEMA_STATEMENTS) await this.pool.query(statement);
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
