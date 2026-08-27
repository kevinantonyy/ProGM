import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { generateTradeSuggestions } from '../services/tradeEngine.js';

const router = Router();

// Generate fresh AI trade suggestions
router.get('/suggestions', authenticate, async (req, res) => {
  try {
    const result = await generateTradeSuggestions(req.userId);
    res.json(result);
  } catch (error) {
    console.error('Trade suggestion error:', error);
    res.status(500).json({ error: 'Failed to generate trade suggestions' });
  }
});

export default router;
