import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

const { Pool } = pg;
const postgres = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
  max: 10,
});

function postgresParams(query) {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

const pool = {
  async execute(query, params = []) {
    let sql = postgresParams(query);
    if (/^\s*INSERT\s+/i.test(sql) && !/\bRETURNING\b/i.test(sql)) sql += ' RETURNING id';
    const result = await postgres.query(sql, params);
    if (/^\s*(SELECT|WITH)\s+/i.test(sql)) return [result.rows];
    return [{ insertId: result.rows[0]?.id, affectedRows: result.rowCount, rows: result.rows }];
  },
  query: (...args) => postgres.query(...args),
  end: () => postgres.end(),
};

export async function initDatabase() {
  await postgres.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL, team_name VARCHAR(100) DEFAULT 'My Team', created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, team VARCHAR(50) NOT NULL, position VARCHAR(10) NOT NULL,
    points_per_game NUMERIC(4,1) DEFAULT 0, rebounds_per_game NUMERIC(4,1) DEFAULT 0,
    assists_per_game NUMERIC(4,1) DEFAULT 0, steals_per_game NUMERIC(3,1) DEFAULT 0,
    blocks_per_game NUMERIC(3,1) DEFAULT 0, fg_percentage NUMERIC(4,1) DEFAULT 0,
    three_pt_percentage NUMERIC(4,1) DEFAULT 0, fantasy_points NUMERIC(5,1) DEFAULT 0,
    injury_status VARCHAR(50) DEFAULT 'Healthy', image_url VARCHAR(255), created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS rosters (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    acquired_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, UNIQUE (user_id, player_id))`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS trade_suggestions (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    give_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    receive_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    reasoning TEXT NOT NULL, confidence_score INTEGER DEFAULT 0, category VARCHAR(50) DEFAULT 'general',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS yahoo_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, yahoo_guid VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS yahoo_oauth_states (
    state_hash CHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  console.log('Database initialized successfully');
}

export default pool;
