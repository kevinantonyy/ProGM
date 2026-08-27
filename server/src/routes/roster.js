import { Router } from 'express';
import pool from '../db/connection.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get user's roster
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, r.acquired_date FROM rosters r 
       JOIN players p ON r.player_id = p.id 
       WHERE r.user_id = ? 
       ORDER BY p.fantasy_points DESC`,
      [req.userId]
    );
    res.json({ roster: rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch roster' });
  }
});

// Add player to roster
router.post('/add', authenticate, async (req, res) => {
  try {
    const { playerId } = req.body;

    // Check roster size (max 15 players for NBA)
    const [existing] = await pool.execute('SELECT COUNT(*) as count FROM rosters WHERE user_id = ?', [req.userId]);
    if (existing[0].count >= 15) {
      return res.status(400).json({ error: 'Roster is full (max 15 players)' });
    }

    await pool.execute('INSERT INTO rosters (user_id, player_id) VALUES (?, ?)', [req.userId, playerId]);
    res.status(201).json({ message: 'Player added to roster' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Player already on roster' });
    }
    res.status(500).json({ error: 'Failed to add player' });
  }
});

// Remove player from roster
router.delete('/remove/:playerId', authenticate, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM rosters WHERE user_id = ? AND player_id = ?',
      [req.userId, req.params.playerId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Player not on roster' });
    }
    res.json({ message: 'Player removed from roster' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove player' });
  }
});

export default router;
