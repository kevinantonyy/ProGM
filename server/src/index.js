import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import playerRoutes from './routes/players.js';
import rosterRoutes from './routes/roster.js';
import tradeRoutes from './routes/trades.js';
import yahooRoutes from './routes/yahoo.js';
import espnRoutes from './routes/espn.js';
import { initDatabase } from './db/connection.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/roster', rosterRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/yahoo', yahooRoutes);
app.use('/api/espn', espnRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'FantasyProGM API' });
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
    app.listen(PORT, () => {
      console.log(`FantasyProGM server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
