import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import yahooRoutes from './routes/yahoo.js';
import espnRoutes from './routes/espn.js';
import { createGmRouter, handleGmJsonError } from './routes/gm.js';
import basketballRoutes, { readCachedWorkspace } from './routes/basketball.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import pool, { initDatabase } from './db/connection.js';
import { startYahooOAuthCleanup } from './services/yahooOauthCleanup.js';
import { createConsentStore } from './services/ai/consent.js';
import { createYahooLeagueBuilder } from './services/ai/yahooLeagueContext.js';

// Personalized Ask ProGM: wired here, but usable only when PROGM_AI_YAHOO_DATA is exactly "allow" (unset by default) AND the user has consented.
const consentStore = createConsentStore(pool.execute);
const gmRoutes = createGmRouter({
  consent: consentStore,
  builders: {
    yahoo_league: createYahooLeagueBuilder({
      consent: consentStore,
      readWorkspace: readCachedWorkspace, // cache only: never calls Yahoo
      hasYahooConnection: async (userId) => { const [rows] = await pool.execute('SELECT 1 AS ok FROM yahoo_connections WHERE user_id = ?', [userId]); return rows.length > 0; },
      loadIdentity: async (userId) => { const [rows] = await pool.execute('SELECT username, email FROM users WHERE id = ?', [userId]); return rows[0] || null; },
    }),
  },
});

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(cors());
app.use(express.json());
app.use(handleGmJsonError);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/yahoo', yahooRoutes);
app.use('/api/espn', espnRoutes);
app.use('/api/gm', gmRoutes);
app.use('/api/basketball', basketballRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProGM API' });
});

// In production, serve the built React app from the same stable Render domain.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Initialize database and start server
async function start() {
  try {
    await initDatabase();
    startYahooOAuthCleanup(pool.execute);
    app.listen(PORT, () => {
      console.log(`ProGM server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
