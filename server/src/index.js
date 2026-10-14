import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import yahooRoutes from './routes/yahoo.js';
import espnRoutes from './routes/espn.js';
import gmRoutes from './routes/gm.js';
import basketballRoutes from './routes/basketball.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import { createSportsDataRouter } from './routes/sportsData.js';
import { initDatabase, postgresPool } from './db/connection.js';
import { PostgresSportsDataStore } from './services/sportsData/postgresStore.js';
import { configurePredictionRecorder } from './services/predictionTracking/liveRecorder.js';
import { PostgresPredictionStore } from './services/predictionTracking/stores.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/yahoo', yahooRoutes);
app.use('/api/espn', espnRoutes);
app.use('/api/gm', gmRoutes);
app.use('/api/basketball', basketballRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);
// Internal, admin-only, read-only; 404 unless ENABLE_SPORTS_DATA_API=true.
let sportsDataStore = null;
app.use('/api/internal/sports-data', createSportsDataRouter({
  getStore: () => (sportsDataStore ||= new PostgresSportsDataStore(postgresPool)),
}));

// Live prediction tracking (Phase 10 store): off unless PROGM_PREDICTION_TRACKING=true.
if (process.env.PROGM_PREDICTION_TRACKING === 'true') configurePredictionRecorder(new PostgresPredictionStore(postgresPool));

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
    app.listen(PORT, () => {
      console.log(`ProGM server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
