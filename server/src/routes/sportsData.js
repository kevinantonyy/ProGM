/**
 * INTERNAL, read-only access to ProGM's stored sports data.
 *
 * Disabled unless ENABLE_SPORTS_DATA_API=true (404 otherwise). When enabled,
 * every request needs a valid ProGM token AND a user id listed in
 * SPORTS_DATA_ADMIN_USER_IDS. Only GET is supported; ingestion happens offline
 * through services/sportsData/ingest.js, never over HTTP.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { SPORTS } from '../services/sportsData/schema.js';

const MAX_LIMIT = 200;
const MAX_OFFSET = 100000;

class BadRequest extends Error {}

function intParam(value, name, { min, max, fallback = null }) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new BadRequest(`${name} must be an integer.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new BadRequest(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

function slugParam(value, name) {
  if (value == null || value === '') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(String(value))) throw new BadRequest(`${name} is invalid.`);
  return String(value);
}

function filtersFrom(query, sport) {
  const seasonType = query.seasonType == null || query.seasonType === '' ? null : String(query.seasonType);
  if (seasonType && !SPORTS[sport].seasonTypes.includes(seasonType)) throw new BadRequest('seasonType is invalid.');
  const search = query.search == null ? null : String(query.search).trim();
  if (search && search.length > 60) throw new BadRequest('search must be 60 characters or fewer.');
  return {
    sourceKey: slugParam(query.sourceKey, 'sourceKey'),
    season: intParam(query.season, 'season', { min: 1946, max: 2100 }),
    seasonType,
    teamId: slugParam(query.teamId, 'teamId'),
    search: search || null,
  };
}

function pageFrom(query) {
  return {
    limit: intParam(query.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: 50 }),
    offset: intParam(query.offset, 'offset', { min: 0, max: MAX_OFFSET, fallback: 0 }),
  };
}

function adminIds(env) {
  return new Set(String(env.SPORTS_DATA_ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
}

export function createSportsDataRouter({ getStore, env = process.env }) {
  const router = Router();
  // Schema creation is memoized by the store and only runs for authorized requests.
  const store = async () => {
    const instance = getStore();
    await instance.ensureSchema();
    return instance;
  };

  router.use((req, res, next) => {
    if (env.ENABLE_SPORTS_DATA_API !== 'true') return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    return next();
  });
  router.use(authenticate);
  router.use((req, res, next) => {
    if (!adminIds(env).has(String(req.userId))) return res.status(403).json({ error: 'Forbidden' });
    if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').json({ error: 'Read-only endpoint' });
    return next();
  });

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
      if (error.status) return res.status(error.status).json({ error: error.message });
      return res.status(500).json({ error: 'internal_error' });
    }
  };

  const sportOf = (req) => {
    const config = SPORTS[req.params.sport];
    if (!config) throw Object.assign(new Error('Unknown sport'), { status: 404 });
    if (!config.implemented) throw Object.assign(new Error(`${req.params.sport} is not implemented yet`), { status: 501 });
    return req.params.sport;
  };

  router.get('/sources', handle(async () => ({ sources: await (await store()).listSources() })));
  router.get('/ingestion-runs', handle(async (req) => ({
    runs: await (await store()).listRuns({ limit: intParam(req.query.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: 50 }) }),
  })));

  const list = (kind, extra = () => ({})) => handle(async (req) => {
    const sport = sportOf(req);
    const page = pageFrom(req.query);
    const filters = { ...filtersFrom(req.query, sport), ...extra(req) };
    return { sport, kind, ...page, data: await (await store()).query(kind, sport, filters, page) };
  });
  router.get('/:sport/teams', list('teams'));
  router.get('/:sport/players', list('players'));
  router.get('/:sport/games', list('games'));
  router.get('/:sport/players/:playerId/games', list('playerGameStats', (req) => ({ playerId: slugParam(req.params.playerId, 'playerId') })));
  router.get('/:sport/games/:gameId/stats', list('playerGameStats', (req) => ({ gameId: slugParam(req.params.gameId, 'gameId') })));
  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}
