import bcrypt from 'bcryptjs';
import pool, { initDatabase } from './connection.js';

async function seed() {
  await initDatabase();
  const [users] = await pool.execute('SELECT id FROM users WHERE username = ?', ['demo']);
  if (!users.length) {
    const passwordHash = await bcrypt.hash('demo123', 10);
    await pool.execute('INSERT INTO users (username, email, password_hash, team_name) VALUES (?, ?, ?, ?)', ['demo', 'demo@fantasyprogm.com', passwordHash, 'Demo Front Office']);
  }
  console.log('Account seed complete. Player and roster data comes only from synced fantasy providers.');
  await pool.end();
}

seed().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
