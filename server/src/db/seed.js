import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool, { initDatabase } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

const NBA_PLAYERS = [
  // Guards
  { name: 'Luka Doncic', team: 'DAL', position: 'PG', points_per_game: 33.9, rebounds_per_game: 9.2, assists_per_game: 9.8, steals_per_game: 1.4, blocks_per_game: 0.5, fg_percentage: 48.7, three_pt_percentage: 35.4, fantasy_points: 62.1 },
  { name: 'Shai Gilgeous-Alexander', team: 'OKC', position: 'SG', points_per_game: 31.1, rebounds_per_game: 5.5, assists_per_game: 6.2, steals_per_game: 2.0, blocks_per_game: 0.9, fg_percentage: 53.5, three_pt_percentage: 35.3, fantasy_points: 55.8 },
  { name: 'Tyrese Haliburton', team: 'IND', position: 'PG', points_per_game: 20.1, rebounds_per_game: 3.9, assists_per_game: 10.9, steals_per_game: 1.2, blocks_per_game: 0.3, fg_percentage: 47.7, three_pt_percentage: 36.4, fantasy_points: 44.2 },
  { name: 'Jalen Brunson', team: 'NYK', position: 'PG', points_per_game: 28.7, rebounds_per_game: 3.5, assists_per_game: 6.7, steals_per_game: 0.9, blocks_per_game: 0.2, fg_percentage: 47.9, three_pt_percentage: 40.1, fantasy_points: 46.3 },
  { name: 'Devin Booker', team: 'PHX', position: 'SG', points_per_game: 27.1, rebounds_per_game: 4.5, assists_per_game: 6.9, steals_per_game: 1.0, blocks_per_game: 0.3, fg_percentage: 49.2, three_pt_percentage: 36.4, fantasy_points: 45.8 },
  { name: 'Stephen Curry', team: 'GSW', position: 'PG', points_per_game: 26.4, rebounds_per_game: 4.5, assists_per_game: 5.1, steals_per_game: 0.7, blocks_per_game: 0.4, fg_percentage: 45.0, three_pt_percentage: 40.8, fantasy_points: 42.1 },
  { name: 'Trae Young', team: 'ATL', position: 'PG', points_per_game: 25.7, rebounds_per_game: 2.8, assists_per_game: 10.8, steals_per_game: 1.3, blocks_per_game: 0.1, fg_percentage: 43.0, three_pt_percentage: 37.3, fantasy_points: 45.5 },
  { name: 'Donovan Mitchell', team: 'CLE', position: 'SG', points_per_game: 26.6, rebounds_per_game: 5.1, assists_per_game: 4.5, steals_per_game: 1.8, blocks_per_game: 0.4, fg_percentage: 46.2, three_pt_percentage: 36.8, fantasy_points: 43.9 },
  // Forwards
  { name: 'Jayson Tatum', team: 'BOS', position: 'SF', points_per_game: 26.9, rebounds_per_game: 8.1, assists_per_game: 4.9, steals_per_game: 1.0, blocks_per_game: 0.6, fg_percentage: 47.1, three_pt_percentage: 37.6, fantasy_points: 48.2 },
  { name: 'Kevin Durant', team: 'PHX', position: 'SF', points_per_game: 27.1, rebounds_per_game: 6.6, assists_per_game: 5.0, steals_per_game: 0.9, blocks_per_game: 1.2, fg_percentage: 52.3, three_pt_percentage: 41.8, fantasy_points: 47.5 },
  { name: 'Giannis Antetokounmpo', team: 'MIL', position: 'PF', points_per_game: 30.4, rebounds_per_game: 11.5, assists_per_game: 6.5, steals_per_game: 1.2, blocks_per_game: 1.1, fg_percentage: 61.1, three_pt_percentage: 27.4, fantasy_points: 60.8 },
  { name: 'LeBron James', team: 'LAL', position: 'SF', points_per_game: 25.7, rebounds_per_game: 7.3, assists_per_game: 8.3, steals_per_game: 1.3, blocks_per_game: 0.5, fg_percentage: 54.0, three_pt_percentage: 41.0, fantasy_points: 50.1 },
  { name: 'Jimmy Butler', team: 'MIA', position: 'SF', points_per_game: 20.8, rebounds_per_game: 5.3, assists_per_game: 5.0, steals_per_game: 1.3, blocks_per_game: 0.3, fg_percentage: 49.9, three_pt_percentage: 35.7, fantasy_points: 38.4, injury_status: 'Day-to-Day' },
  { name: 'Kawhi Leonard', team: 'LAC', position: 'SF', points_per_game: 23.7, rebounds_per_game: 6.1, assists_per_game: 3.6, steals_per_game: 1.6, blocks_per_game: 0.9, fg_percentage: 52.5, three_pt_percentage: 41.7, fantasy_points: 41.2, injury_status: 'Out' },
  { name: 'Paolo Banchero', team: 'ORL', position: 'PF', points_per_game: 22.6, rebounds_per_game: 6.9, assists_per_game: 5.4, steals_per_game: 0.8, blocks_per_game: 0.6, fg_percentage: 45.5, three_pt_percentage: 33.9, fantasy_points: 40.7 },
  { name: 'Scottie Barnes', team: 'TOR', position: 'PF', points_per_game: 19.9, rebounds_per_game: 7.2, assists_per_game: 6.1, steals_per_game: 1.3, blocks_per_game: 0.8, fg_percentage: 47.5, three_pt_percentage: 34.1, fantasy_points: 41.0 },
  // Centers
  { name: 'Nikola Jokic', team: 'DEN', position: 'C', points_per_game: 26.4, rebounds_per_game: 12.4, assists_per_game: 9.0, steals_per_game: 1.4, blocks_per_game: 0.9, fg_percentage: 58.3, three_pt_percentage: 35.9, fantasy_points: 63.5 },
  { name: 'Joel Embiid', team: 'PHI', position: 'C', points_per_game: 34.7, rebounds_per_game: 11.0, assists_per_game: 5.6, steals_per_game: 1.2, blocks_per_game: 1.7, fg_percentage: 52.9, three_pt_percentage: 38.8, fantasy_points: 61.3, injury_status: 'Day-to-Day' },
  { name: 'Anthony Davis', team: 'LAL', position: 'C', points_per_game: 24.7, rebounds_per_game: 12.6, assists_per_game: 3.5, steals_per_game: 1.2, blocks_per_game: 2.3, fg_percentage: 55.6, three_pt_percentage: 27.1, fantasy_points: 52.4 },
  { name: 'Victor Wembanyama', team: 'SAS', position: 'C', points_per_game: 21.4, rebounds_per_game: 10.6, assists_per_game: 3.9, steals_per_game: 1.2, blocks_per_game: 3.6, fg_percentage: 46.5, three_pt_percentage: 32.5, fantasy_points: 50.2 },
  { name: 'Bam Adebayo', team: 'MIA', position: 'C', points_per_game: 19.3, rebounds_per_game: 10.4, assists_per_game: 3.9, steals_per_game: 1.1, blocks_per_game: 0.8, fg_percentage: 52.2, three_pt_percentage: 18.2, fantasy_points: 39.8 },
  { name: 'Domantas Sabonis', team: 'SAC', position: 'C', points_per_game: 19.4, rebounds_per_game: 13.7, assists_per_game: 8.2, steals_per_game: 0.9, blocks_per_game: 0.4, fg_percentage: 56.1, three_pt_percentage: 37.5, fantasy_points: 49.6 },
  // More role players for trade pool
  { name: 'Dejounte Murray', team: 'NOP', position: 'PG', points_per_game: 22.5, rebounds_per_game: 5.3, assists_per_game: 6.1, steals_per_game: 1.5, blocks_per_game: 0.3, fg_percentage: 45.3, three_pt_percentage: 34.2, fantasy_points: 40.1 },
  { name: 'Darius Garland', team: 'CLE', position: 'PG', points_per_game: 18.0, rebounds_per_game: 2.7, assists_per_game: 6.5, steals_per_game: 1.3, blocks_per_game: 0.1, fg_percentage: 44.6, three_pt_percentage: 37.1, fantasy_points: 33.2 },
  { name: 'Mikal Bridges', team: 'NYK', position: 'SF', points_per_game: 19.6, rebounds_per_game: 4.5, assists_per_game: 3.6, steals_per_game: 1.0, blocks_per_game: 0.6, fg_percentage: 46.1, three_pt_percentage: 37.2, fantasy_points: 33.8 },
  { name: 'Lauri Markkanen', team: 'UTA', position: 'PF', points_per_game: 23.2, rebounds_per_game: 8.2, assists_per_game: 2.0, steals_per_game: 0.6, blocks_per_game: 0.5, fg_percentage: 48.0, three_pt_percentage: 39.9, fantasy_points: 38.5 },
  { name: 'Chet Holmgren', team: 'OKC', position: 'C', points_per_game: 16.5, rebounds_per_game: 7.9, assists_per_game: 2.4, steals_per_game: 0.8, blocks_per_game: 2.5, fg_percentage: 53.0, three_pt_percentage: 37.2, fantasy_points: 36.4 },
  { name: 'Jalen Williams', team: 'OKC', position: 'SF', points_per_game: 19.1, rebounds_per_game: 4.5, assists_per_game: 4.5, steals_per_game: 1.1, blocks_per_game: 0.7, fg_percentage: 51.8, three_pt_percentage: 38.6, fantasy_points: 35.6 },
  { name: 'Franz Wagner', team: 'ORL', position: 'SF', points_per_game: 19.7, rebounds_per_game: 5.3, assists_per_game: 3.7, steals_per_game: 1.1, blocks_per_game: 0.4, fg_percentage: 46.5, three_pt_percentage: 35.2, fantasy_points: 34.9 },
  { name: 'Jaren Jackson Jr.', team: 'MEM', position: 'PF', points_per_game: 22.5, rebounds_per_game: 5.5, assists_per_game: 2.1, steals_per_game: 1.0, blocks_per_game: 1.6, fg_percentage: 49.5, three_pt_percentage: 32.1, fantasy_points: 37.8 },
];

async function seed() {
  // Initialize database tables first
  await initDatabase();

  const connection = pool;

  console.log('Seeding database...');

  // Never overwrite an existing environment. Seed only a brand-new database.
  const [existingPlayers] = await connection.execute('SELECT COUNT(*) AS count FROM players');
  const [existingUsers] = await connection.execute('SELECT COUNT(*) AS count FROM users');
  if (Number(existingPlayers[0].count) > 0 || Number(existingUsers[0].count) > 0) {
    console.log('Seed skipped: database already contains application data.');
    await pool.end();
    return;
  }

  // Create demo user
  const passwordHash = await bcrypt.hash('demo123', 10);
  await connection.execute(
    'INSERT INTO users (username, email, password_hash, team_name) VALUES (?, ?, ?, ?)',
    ['demo', 'demo@fantasyprogm.com', passwordHash, 'Thunder Squad']
  );
  const [userRows] = await connection.execute('SELECT id FROM users WHERE username = ?', ['demo']);
  const userId = userRows[0].id;

  // Insert players
  for (const player of NBA_PLAYERS) {
    await connection.execute(
      `INSERT INTO players (name, team, position, points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game, fg_percentage, three_pt_percentage, fantasy_points, injury_status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        player.name, player.team, player.position,
        player.points_per_game, player.rebounds_per_game, player.assists_per_game,
        player.steals_per_game, player.blocks_per_game, player.fg_percentage,
        player.three_pt_percentage, player.fantasy_points, player.injury_status || 'Healthy',
      ]
    );
  }

  // Add some players to demo user's roster (8 players)
  const rosterPlayers = ['Luka Doncic', 'Jayson Tatum', 'Anthony Davis', 'Tyrese Haliburton', 'Jimmy Butler', 'Mikal Bridges', 'Lauri Markkanen', 'Bam Adebayo'];
  for (const name of rosterPlayers) {
    const [rows] = await connection.execute('SELECT id FROM players WHERE name = ?', [name]);
    if (rows.length > 0) {
      await connection.execute('INSERT INTO rosters (user_id, player_id) VALUES (?, ?)', [userId, rows[0].id]);
    }
  }

  console.log('Seed complete!');
  console.log('Demo user: demo / demo123');
  await pool.end();
}

seed()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
