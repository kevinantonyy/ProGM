import { ENTITY_KINDS } from './schema.js';

/**
 * In-memory implementation of the sports data store interface. Used by tests
 * and offline tooling; it mirrors the Postgres store's semantics, including
 * all-or-nothing transactions and referential checks done by ingestion.
 */
// Matches Postgres COLLATE "C" ordering used by the Postgres store.
function byteCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class MemorySportsDataStore {
  constructor() {
    this.state = { sources: new Map(), records: new Map(ENTITY_KINDS.map((kind) => [kind, new Map()])), runs: [] };
    this.clock = () => new Date().toISOString();
  }

  async ensureSchema() {}

  async transaction(fn) {
    const snapshot = structuredClone(this.state);
    try {
      return await fn(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async upsertSource(source) {
    const existing = this.state.sources.get(source.sourceKey);
    this.state.sources.set(source.sourceKey, { ...structuredClone(source), registeredAt: existing?.registeredAt || this.clock(), updatedAt: this.clock() });
  }

  async getSource(sourceKey) {
    const source = this.state.sources.get(sourceKey);
    return source ? structuredClone(source) : null;
  }

  async listSources() {
    return [...this.state.sources.values()].sort((a, b) => byteCompare(a.sourceKey, b.sourceKey)).map((source) => structuredClone(source));
  }

  static key(sport, sourceKey, externalId) { return `${sport}|${sourceKey}|${externalId}`; }

  async getRecords(kind, sport, sourceKey, externalIds) {
    const table = this.state.records.get(kind);
    const found = new Map();
    for (const externalId of externalIds) {
      const row = table.get(MemorySportsDataStore.key(sport, sourceKey, externalId));
      if (row) found.set(externalId, structuredClone(row.record));
    }
    return found;
  }

  async upsertRecords(kind, sport, sourceKey, records) {
    const table = this.state.records.get(kind);
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const record of records) {
      const key = MemorySportsDataStore.key(sport, sourceKey, record.externalId);
      const existing = table.get(key);
      if (existing?.contentHash === record.contentHash) { counts.unchanged += 1; continue; }
      const now = this.clock();
      table.set(key, { sport, sourceKey, record: structuredClone(record), contentHash: record.contentHash, firstSeenAt: existing?.firstSeenAt || now, updatedAt: now });
      counts[existing ? 'updated' : 'inserted'] += 1;
    }
    return counts;
  }

  async insertRun(run) {
    const id = this.state.runs.length + 1;
    this.state.runs.push({ id, ...structuredClone(run) });
    return id;
  }

  async listRuns({ limit = 50 } = {}) {
    return [...this.state.runs].sort((a, b) => b.id - a.id).slice(0, limit).map((run) => structuredClone(run));
  }

  async query(kind, sport, filters = {}, { limit = 100, offset = 0 } = {}) {
    // Same filter applicability as the Postgres store.
    const seasonal = kind === 'games' || kind === 'playerGameStats';
    const isStat = kind === 'playerGameStats';
    const search = kind === 'players' ? filters.search?.toLowerCase() : null;
    const rows = [...this.state.records.get(kind).values()]
      .filter((row) => row.sport === sport && (!filters.sourceKey || row.sourceKey === filters.sourceKey))
      .map((row) => ({ sourceKey: row.sourceKey, ...row.record, firstSeenAt: row.firstSeenAt, updatedAt: row.updatedAt }))
      .filter((row) => (!seasonal || filters.season == null || row.season === filters.season)
        && (!seasonal || !filters.seasonType || row.seasonType === filters.seasonType)
        && (!seasonal || !filters.teamId || (isStat ? row.teamId === filters.teamId : [row.homeTeamId, row.awayTeamId].includes(filters.teamId)))
        && (!isStat || !filters.playerId || row.playerId === filters.playerId)
        && (!isStat || !filters.gameId || row.gameId === filters.gameId)
        && (!search || String(row.fullName || '').toLowerCase().includes(search)))
      .sort((a, b) => byteCompare(a.gameDate || '', b.gameDate || '')
        || byteCompare(a.sourceKey, b.sourceKey) || byteCompare(a.externalId, b.externalId));
    return rows.slice(offset, offset + limit).map(({ contentHash: _hash, ...row }) => row);
  }
}
