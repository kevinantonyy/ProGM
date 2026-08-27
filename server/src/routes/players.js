import { Router } from 'express';
import pool from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get all players
router.get('/', authenticate, async (req, res) => {
  try {
    const { position, search, sort } = req.query;
    let query = 'SELECT * FROM players WHERE 1=1';
    const params = [];

    if (position && position !== 'ALL') {
      query += ' AND position = ?';
      params.push(position);
    }

    if (search) {
      query += ' AND (name ILIKE ? OR team ILIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const sortField = sort || 'fantasy_points';
    const allowedSorts = ['fantasy_points', 'points_per_game', 'rebounds_per_game', 'assists_per_game', 'name'];
    if (allowedSorts.includes(sortField)) {
      query += ` ORDER BY ${sortField} DESC`;
    } else {
      query += ' ORDER BY fantasy_points DESC';
    }

    const [rows] = await pool.execute(query, params);
    res.json({ players: rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Get single player
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM players WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    res.json({ player: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

export default router;
