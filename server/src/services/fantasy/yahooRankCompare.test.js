import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, compareOrders, competitionRanks, extractRows, findPrivateData, toMarkdown, topList } from '../../../scripts/yahooRankCompare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '../../../scripts/yahooRankCompare.mjs');

// Synthetic players only.
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ name: `Player ${i + 1}`, eligiblePositions: ['PG', 'UTIL'], ...f(i + 1) }));
const doc = (extra = {}) => ({
  draftBoard: {
    rankScope: 'full_pool', rankingModel: 'v2',
    board: mk(150, (r) => ({ overallRank: r, yahooOverallRank: r, yahooAdp: r + 0.5, yahooSeasonRank: r, ...extra })),
    noData: [{ name: 'Rookie A', eligiblePositions: ['SG'], yahooAdp: 12.5, yahooOverallRank: 30 }, { name: 'Rookie B', eligiblePositions: ['C'], yahooAdp: 40 }],
  },
  connection: { draftStatus: 'predraft', leagueKey: '428.l.123456', teamKey: '428.l.123456.t.2' },
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.secretsecretsecret', cookie: 'abc',
});

test('competition ranks share the best rank on ties', () => assert.deepEqual(competitionRanks([5, 1, 1, 9]), [3, 1, 1, 4]));

test('identical orderings: Spearman 1, full overlap, zero differences', () => {
  const rows = extractRows(doc()).rows.filter((r) => r.inBoard);
  const c = compareOrders(rows, 'progm', 'yahooOR', { names: ['ProGM', 'Yahoo'] });
  assert.equal(c.spearman, 1); assert.equal(c.overlap.top25.overlap, 25); assert.equal(c.overlap.top100.overlap, 100);
  assert.equal(c.medianAbsoluteDifference, 0); assert.equal(c.share.within5, 1);
});

test('reversed ordering: Spearman -1, no overlap in the top 25; largest discrepancies are the extremes', () => {
  const rows = extractRows(doc()).rows.filter((r) => r.inBoard).map((r) => ({ ...r, yahooOR: 151 - r.progm }));
  const c = compareOrders(rows, 'progm', 'yahooOR', { names: ['ProGM', 'Yahoo'] });
  assert.equal(c.spearman, -1); assert.equal(c.overlap.top25.overlap, 0);
  assert.equal(c.largestLater[0].diff, 149); assert.equal(c.largestEarlier[0].diff, -149);
});

test('partial coverage: only players holding both values are compared; shared count reported', () => {
  const d = doc(); d.draftBoard.board.forEach((r, i) => { if (i % 2) delete r.yahooOverallRank; });
  const rep = buildReport(d);
  assert.equal(rep.vsProgm.yahooOR.n, 75); assert.equal(rep.coverage.yahooOR.players, 75 + 1);   // + the rookie that has an OR
  assert.equal(rep.coverage.withoutProgmRank, 2); assert.equal(rep.coverage.withYahooSignalButNoProgmRank, 2);
});

test('live and preseason ADP: merged-only responses say provenance is unavailable; responses with both fields separate them', () => {
  const merged = buildReport(doc());
  assert.equal(typeof merged.coverage.adpProvenance, 'string'); assert.match(merged.coverage.adpProvenance, /cannot be separated/);
  assert.equal(merged.vsProgm.adpLive, undefined); assert.equal(merged.vsProgm.adpPreseason, undefined);
  const d = doc(); d.draftBoard.board.forEach((r, i) => { if (i < 100) r.yahooAdpLive = r.yahooAdp; else r.yahooAdpPreseason = r.yahooAdp; });
  const split = buildReport(d);
  assert.deepEqual(split.coverage.adpProvenance, { liveOnly: 100, preseasonFallbackOnly: 50, both: 0, neither: 2 });
  assert.ok(split.vsProgm.adpLive && split.vsProgm.adpPreseason);
});

test('top-20 lists use each field\'s own order; ties and gaps are handled', () => {
  const rows = [{ name: 'B', positions: [], yahooOR: 2 }, { name: 'A', positions: [], yahooOR: 1 }, { name: 'N', positions: [], yahooOR: null }];
  assert.deepEqual(topList(rows, 'yahooOR').map((p) => p.name), ['A', 'B']);
});

test('report holds names and numbers only: no league/team keys, tokens or cookies', () => {
  const rep = buildReport(doc()); const text = JSON.stringify(rep) + toMarkdown(rep);
  assert.deepEqual(findPrivateData(text), []);
  for (const banned of ['428.l.', 'eyJ', 'secretsecret', 'cookie', 'accessToken', 'draftStatus: predraft'.slice(0, 0) + 'teamKey']) assert.ok(!text.includes(banned), banned);
});

test('script is read-only by construction: node builtins only, no network or database calls', () => {
  const src = fs.readFileSync(script, 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.every((m) => m.startsWith('node:')), imports.join());
  for (const banned of [/\bfetch\(/, /https?:\/\//, /\bpg\b/, /DATABASE_URL/, /yahooFantasy/, /XMLHttpRequest/, /child_process/]) assert.ok(!banned.test(src), String(banned));
});

test('CLI: writes sanitized .json and .md to the chosen folder; refuses input without a board; refuses output that would carry private patterns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycmp-')); const out = path.join(dir, 'out');
  const input = path.join(dir, 'in.json'); fs.writeFileSync(input, JSON.stringify(doc()));
  const ok = spawnSync(process.execPath, [script, input, out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const json = fs.readFileSync(path.join(out, 'progm-yahoo-rank-comparison.json'), 'utf8'); const md = fs.readFileSync(path.join(out, 'progm-yahoo-rank-comparison.md'), 'utf8');
  assert.deepEqual(findPrivateData(json + md), []); assert.ok(!ok.stdout.includes('428.l.'));
  fs.writeFileSync(input, JSON.stringify({ nothing: true }));
  assert.equal(spawnSync(process.execPath, [script, input, out], { encoding: 'utf8' }).status, 3);
  const leaky = doc(); leaky.draftBoard.board[0].name = 'Player 428.l.123456.t.2';
  fs.writeFileSync(input, JSON.stringify(leaky));
  const out2 = path.join(dir, 'out2');
  assert.equal(spawnSync(process.execPath, [script, input, out2], { encoding: 'utf8' }).status, 4);
  assert.ok(!fs.existsSync(path.join(out2, 'progm-yahoo-rank-comparison.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});
