// ESPN-backed screens must sit behind the server's availability answer, and no new ESPN caller may appear unreviewed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk(SRC).filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f));
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

test('every client file that calls an /espn API is a known one', () => {
  const callers = sources.filter((f) => /api\.(get|post|put|delete)\([^)]*\/espn/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(callers, ['components/NewsFeed.jsx', 'pages/EspnFantasy.jsx', 'pages/FantasyFootball.jsx', 'pages/Home.jsx', 'pages/Login.jsx', 'pages/SportWorkspace.jsx', 'services/useEspnAvailability.js'].sort());
});

test('the football workspace and the ESPN sync page render nothing but a notice unless ESPN is available', () => {
  for (const file of ['pages/SportWorkspace.jsx', 'pages/EspnFantasy.jsx']) {
    const code = read(file);
    const wrapper = code.slice(code.indexOf('export default function'));
    assert.match(wrapper, /useEspnAvailability\(\)/, file);
    assert.match(wrapper, /!espn\.available\) return <EspnUnavailable/, file);
    assert.ok(wrapper.indexOf('EspnUnavailable') < wrapper.indexOf('Inner />'), `${file}: the notice is decided before the real page mounts, so its effects never fire`);
    assert.doesNotMatch(wrapper, /api\./, `${file}: the wrapper makes no ESPN request`);
  }
});

test('the news feed is only reachable through the gated workspace; the unrouted legacy football page stays unrouted', () => {
  const importers = (name) => sources.filter((f) => new RegExp(`from '[^']*/${name}'`).test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(importers('NewsFeed'), ['pages/SportWorkspace.jsx']);
  assert.deepEqual(importers('FantasyFootball'), [], 'FantasyFootball.jsx calls an ESPN endpoint and must not be routed');
});

test('login shows the ESPN connect form only when available, explains otherwise, and drops a stale pending ESPN connect', () => {
  const code = read('pages/Login.jsx');
  assert.match(code, /useEspnAvailability\(\)/);
  assert.match(code, /\{!isRegister && espn\.available && \(/, 'the ESPN form is behind the availability flag');
  assert.match(code, /ESPN leagues are not available/);
  assert.match(code, /espn\.available \? sessionStorage\.getItem\('espnPending'\) : null/);
  assert.match(code, /sessionStorage\.removeItem\('espnPending'\)/);
  const preview = code.slice(code.indexOf('async function previewEspn'), code.indexOf('function saveEspnTeam'));
  assert.equal((code.match(/\/espn\/preview/g) || []).length, 1, 'one preview call, inside previewEspn');
  assert.ok(preview.includes('/espn/preview'));
});

test('the home page asks the availability endpoint before it requests any ESPN workspace', () => {
  const code = read('pages/Home.jsx');
  assert.ok(code.indexOf('loadEspnAvailability(') < code.indexOf("'/espn/workspace/football'"));
  assert.match(code, /if \(espn\.available\) \{ try \{ const r = await api\.get\('\/espn\/workspace\/football'\)/);
});

test('Yahoo basketball is not behind the ESPN switch', () => {
  const basketball = read('pages/BasketballWorkspace.jsx');
  assert.doesNotMatch(basketball, /useEspnAvailability|EspnUnavailable|\/espn\//);
  assert.doesNotMatch(read('pages/YahooFantasy.jsx'), /useEspnAvailability|\/espn\//);
});
