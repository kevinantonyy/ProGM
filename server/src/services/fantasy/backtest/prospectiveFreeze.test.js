import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The 2026-27 prospective evaluation is frozen: any change to its snapshot, inputs, weights, scoring or plan must fail loudly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const dir = path.join(root, 'ml/prospective/2026-27');
const SNAPSHOT_SHA256 = 'e509467a8aafe3fa5231c961d44aa5ff45b41e47e921044f9c58d51f0ada323e';
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('frozen 2026-27 snapshot and every registered input are unchanged', () => {
  assert.equal(sha(path.join(dir, 'snapshot-2026.json')), SNAPSHOT_SHA256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest-2026.json'), 'utf8')).sha256, SNAPSHOT_SHA256);
  const lines = fs.readFileSync(path.join(dir, 'FROZEN.sha256'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 7);
  for (const line of lines) {
    const [hash, file] = line.split(/\s+/);
    const p = file.startsWith('docs/') ? path.join(root, file) : path.join(dir, file);
    assert.equal(sha(p), hash, file);
  }
});

test('frozen snapshot declares pre-season data only and the registered primary model', () => {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot-2026.json'), 'utf8'));
  assert.equal(s.targetSeason, 2026);
  assert.ok(s.models.every((m) => m.dataCutoffSeason === 2025 && m.asOf === '2026-10-01T00:00:00.000Z'));
  assert.deepEqual(s.models.filter((m) => m.role === 'primary').map((m) => m.id), ['candidate_tier_shrink']);
  assert.ok(s.models.every((m) => m.predictions.length === 327));
});
