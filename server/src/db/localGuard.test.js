import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { databaseProblems, assertLocalDatabaseIfRequired, databaseHost } from './localGuard.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEON = 'postgres://user:topsecret@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require';
const LOCAL = 'postgres://postgres:local@localhost:5432/progm_shadow';

test('both URLs are checked; the unpooled one counts even when DATABASE_URL is local', () => {
  assert.equal(databaseProblems({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL }).problems.length, 0);
  const p = databaseProblems({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: NEON }).problems;
  assert.equal(p.length, 1); assert.match(p[0], /DATABASE_URL_UNPOOLED.*ep-cool-123/);
  assert.equal(databaseProblems({ DATABASE_URL: NEON, DATABASE_URL_UNPOOLED: LOCAL }).problems.length, 1);
  assert.ok(databaseProblems({}).problems.length > 0);
  assert.equal(databaseHost('not a url'), '(unparseable)');
});

test('reports never contain credentials', () => {
  const text = JSON.stringify(databaseProblems({ DATABASE_URL: NEON, DATABASE_URL_UNPOOLED: NEON }));
  assert.ok(!text.includes('topsecret') && !text.includes('user:'));
});

test('guard is inert unless PROGM_REQUIRE_LOCAL_DB is on, and throws for non-local hosts when on', () => {
  assert.doesNotThrow(() => assertLocalDatabaseIfRequired({ DATABASE_URL: NEON }));
  assert.throws(() => assertLocalDatabaseIfRequired({ PROGM_REQUIRE_LOCAL_DB: 'on', DATABASE_URL: NEON }), /refusing to connect/);
  assert.throws(() => assertLocalDatabaseIfRequired({ PROGM_REQUIRE_LOCAL_DB: 'on', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: NEON }), /refusing/);
  assert.doesNotThrow(() => assertLocalDatabaseIfRequired({ PROGM_REQUIRE_LOCAL_DB: 'on', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL }));
});

function run(script, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: serverDir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
}

test('importing the real db module with a non-local URL and the guard on fails before any pool exists', () => {
  const r = run("await import('./src/db/connection.js'); console.log('IMPORTED');", { PROGM_REQUIRE_LOCAL_DB: 'on', DATABASE_URL: NEON, DATABASE_URL_UNPOOLED: NEON });
  assert.notEqual(r.status, 0); assert.ok(!r.stdout.includes('IMPORTED')); assert.ok(!r.stderr.includes('topsecret'));
  const ok = run("await import('./src/db/connection.js'); console.log('IMPORTED'); process.exit(0)", { PROGM_REQUIRE_LOCAL_DB: 'on', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL });
  assert.equal(ok.status, 0, ok.stderr); assert.ok(ok.stdout.includes('IMPORTED'));
});

test('npm run shadow:local starter stops at the preflight for a hosted database and never starts the server', () => {
  const r = spawnSync(process.execPath, ['scripts/shadowStart.mjs'], { cwd: serverDir, env: { PATH: process.env.PATH, DATABASE_URL: NEON, DATABASE_URL_UNPOOLED: NEON }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STOP - problems found/); assert.ok(!/Database initialized|server running/.test(r.stdout + r.stderr));
  assert.ok(!(r.stdout + r.stderr).includes('topsecret'));
});
