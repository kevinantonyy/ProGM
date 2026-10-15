#!/usr/bin/env node
// READ-ONLY Yahoo ranking comparison for a saved ProGM workspace response.
//   node scripts/yahooRankCompare.mjs <saved-workspace-response.json> [output-folder]
// Reads ONE local file. No network, no database, no Yahoo calls, no imports of app code. Writes two sanitized files
// (progm-yahoo-rank-comparison.json / .md) containing only player names, positions and numbers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOP = [25, 50, 100];
const LIST = 20;
const WORST = 12;
const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const num = (v) => { const n = typeof v === 'string' ? Number(v.trim()) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null; };

/** 1-based competition ranks (ties share the best rank) for values where SMALLER is better. */
export function competitionRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const first = new Map(); sorted.forEach((v, i) => { if (!first.has(v)) first.set(v, i + 1); });
  return values.map((v) => first.get(v));
}
function pearson(a, b) {
  const n = a.length; if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n; const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i += 1) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Pull the board/noData rows from a saved workspace response (or an already-extracted { board } object). */
export function extractRows(doc) {
  const db = doc?.draftBoard ?? doc;
  const board = Array.isArray(db?.board) ? db.board : [];
  const noData = Array.isArray(db?.noData) ? db.noData : [];
  const pick = (r, inBoard) => ({
    name: typeof r?.name === 'string' ? r.name.slice(0, 80) : 'Unknown',
    positions: Array.isArray(r?.eligiblePositions) ? r.eligiblePositions.filter((p) => typeof p === 'string' && p !== 'UTIL').slice(0, 6) : [],
    inBoard,
    progm: inBoard ? num(r.overallRank) : null,
    yahooOR: num(r?.yahooOverallRank),
    yahooSeason: num(r?.yahooSeasonRank),
    adpMerged: num(r?.yahooAdp),
    adpLive: num(r?.yahooAdpLive),
    adpPreseason: num(r?.yahooAdpPreseason),
  });
  return {
    rows: [...board.map((r) => pick(r, true)), ...noData.map((r) => pick(r, false))],
    meta: {
      rankScope: typeof db?.rankScope === 'string' ? db.rankScope : null,
      rankingModel: typeof db?.rankingModel === 'string' ? db.rankingModel : null,
      draftStatus: typeof doc?.connection?.draftStatus === 'string' ? doc.connection.draftStatus : null,
      boardRows: board.length, noDataRows: noData.length,
    },
  };
}

const METHODS = [
  ['yahooOR', 'Yahoo Overall Rank (OR)'],
  ['yahooSeason', 'Yahoo Season Rank (S, current season)'],
  ['adpMerged', 'Yahoo ADP as stored (live, or preseason when live is missing)'],
  ['adpLive', 'Yahoo live ADP'],
  ['adpPreseason', 'Yahoo preseason ADP'],
];

/** Compare two orderings on the players that have both. Smaller value = earlier. */
export function compareOrders(rows, keyA, keyB, { names = ['A', 'B'] } = {}) {
  const shared = rows.filter((r) => r[keyA] != null && r[keyB] != null);
  if (shared.length < 10) return { n: shared.length, note: 'too few players with both values' };
  const ra = competitionRanks(shared.map((r) => r[keyA])); const rb = competitionRanks(shared.map((r) => r[keyB]));
  const diffs = shared.map((r, i) => ({ name: r.name, positions: r.positions, a: ra[i], b: rb[i], diff: rb[i] - ra[i] })); // + => B ranks him later than A
  const overlap = Object.fromEntries(TOP.map((N) => {
    const k = Math.min(N, shared.length); let hit = 0;
    for (const d of diffs) if (d.a <= k && d.b <= k) hit += 1;
    return [`top${N}`, { of: k, overlap: hit, share: round(hit / k, 3) }];
  }));
  const abs = diffs.map((d) => Math.abs(d.diff));
  const sorted = [...diffs].sort((x, y) => y.diff - x.diff);
  return {
    n: shared.length, spearman: round(pearson(ra, rb), 3), overlap,
    medianSignedDifference: round(median(diffs.map((d) => d.diff)), 1), medianAbsoluteDifference: round(median(abs), 1),
    share: { within5: round(abs.filter((v) => v <= 5).length / abs.length, 3), over15: round(abs.filter((v) => v > 15).length / abs.length, 3), over30: round(abs.filter((v) => v > 30).length / abs.length, 3) },
    convention: `difference = rank in ${names[1]} minus rank in ${names[0]}; positive = ${names[1]} places the player later`,
    largestLater: sorted.slice(0, WORST).map(({ name, positions, a, b, diff }) => ({ name, positions, [names[0]]: a, [names[1]]: b, diff })),
    largestEarlier: sorted.slice(-WORST).reverse().map(({ name, positions, a, b, diff }) => ({ name, positions, [names[0]]: a, [names[1]]: b, diff })),
  };
}

export function topList(rows, key, n = LIST) {
  return rows.filter((r) => r[key] != null).sort((x, y) => x[key] - y[key] || x.name.localeCompare(y.name)).slice(0, n)
    .map((r, i) => ({ position: i + 1, name: r.name, positions: r.positions, value: r[key] }));
}

export function buildReport(doc) {
  const { rows, meta } = extractRows(doc);
  const total = rows.length; const board = rows.filter((r) => r.inBoard);
  const cov = (pred, set = rows) => ({ players: set.filter(pred).length, share: set.length ? round(set.filter(pred).length / set.length, 3) : null });
  const hasProvenance = rows.some((r) => r.adpLive != null || r.adpPreseason != null);
  const coverage = {
    players: total, withProgmRank: board.length, withoutProgmRank: total - board.length,
    yahooOR: cov((r) => r.yahooOR != null), yahooSeason: cov((r) => r.yahooSeason != null), adpAsStored: cov((r) => r.adpMerged != null),
    liveAdp: hasProvenance ? cov((r) => r.adpLive != null) : 'not recorded in this response',
    preseasonAdp: hasProvenance ? cov((r) => r.adpPreseason != null) : 'not recorded in this response',
    adpProvenance: hasProvenance
      ? { liveOnly: cov((r) => r.adpLive != null && r.adpPreseason == null).players, preseasonFallbackOnly: cov((r) => r.adpLive == null && r.adpPreseason != null).players, both: cov((r) => r.adpLive != null && r.adpPreseason != null).players, neither: cov((r) => r.adpLive == null && r.adpPreseason == null).players }
      : 'Live and preseason ADP are merged into one value before they reach the saved response (average_pick, else preseason_average_pick). They cannot be separated from this file.',
    withYahooSignalButNoProgmRank: rows.filter((r) => !r.inBoard && (r.yahooOR != null || r.adpMerged != null)).length,
  };
  const methods = METHODS.filter(([k]) => rows.some((r) => r[k] != null) && (hasProvenance || (k !== 'adpLive' && k !== 'adpPreseason')));
  const vsProgm = Object.fromEntries(methods.map(([k, label]) => [k, { label, ...compareOrders(board, 'progm', k, { names: ['ProGM', 'Yahoo'] }) }]));
  const yahooAgainstItself = {};
  if (methods.some(([k]) => k === 'yahooOR') && methods.some(([k]) => k === 'adpMerged')) yahooAgainstItself['OR vs ADP (as stored)'] = compareOrders(rows, 'yahooOR', 'adpMerged', { names: ['OR', 'ADP'] });
  const top20 = { progm: topList(board, 'progm'), ...Object.fromEntries(methods.map(([k]) => [k, topList(rows, k)])) };
  const yahooOnly = topList(rows.filter((r) => !r.inBoard), rows.some((r) => !r.inBoard && r.yahooOR != null) ? 'yahooOR' : 'adpMerged', 15);
  return {
    generatedFrom: 'one saved workspace response (local file); no network, no database',
    privacy: 'Only player names, eligible positions and numeric ranks are included. No league, team or account identifiers and no credentials.',
    context: { rankScope: meta.rankScope, rankingModel: meta.rankingModel, draftStatus: meta.draftStatus, boardRows: meta.boardRows, noDataRows: meta.noDataRows },
    scoringNote: 'Yahoo OR and ADP are treated purely as rankings. Nothing in the response says which scoring format they reflect, so no format is assumed.',
    coverage, vsProgm, yahooAgainstItself, top20, yahooRankedButNoProgmRank: yahooOnly,
    howToIdentifyYahooBoard: 'Open Yahoo\'s draft list in its default order and compare its first 20 names with each list under top20. The matching list is the field Yahoo shows as its board.',
  };
}

const fmt = (x) => (x == null ? '-' : String(x));
export function toMarkdown(rep) {
  const L = [];
  L.push('# ProGM vs Yahoo ranking comparison', '', rep.privacy, '', rep.scoringNote, '');
  L.push(`Rank scope: ${fmt(rep.context.rankScope)}; ProGM model: ${fmt(rep.context.rankingModel)}; draft status: ${fmt(rep.context.draftStatus)}; ProGM-ranked players ${rep.context.boardRows}; players without a ProGM rank ${rep.context.noDataRows}.`, '');
  L.push('## Coverage', '', `Players in file: ${rep.coverage.players} (ProGM-ranked ${rep.coverage.withProgmRank}, not ranked ${rep.coverage.withoutProgmRank}).`);
  for (const [k, label] of [['yahooOR', 'Yahoo OR'], ['yahooSeason', 'Yahoo season rank'], ['adpAsStored', 'ADP as stored'], ['liveAdp', 'Live ADP'], ['preseasonAdp', 'Preseason ADP']]) {
    const v = rep.coverage[k]; L.push(`- ${label}: ${typeof v === 'string' ? v : `${v.players} players (${Math.round(v.share * 100)}%)`}`);
  }
  L.push(`- ADP provenance: ${typeof rep.coverage.adpProvenance === 'string' ? rep.coverage.adpProvenance : JSON.stringify(rep.coverage.adpProvenance)}`, `- Players with a Yahoo rank/ADP but no ProGM rank: ${rep.coverage.withYahooSignalButNoProgmRank}`, '');
  L.push('## ProGM Rank vs each Yahoo ranking', '');
  L.push('| Yahoo field | shared players | Spearman | top-25 | top-50 | top-100 | median diff | median abs diff | within 5 | over 15 | over 30 |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of Object.values(rep.vsProgm)) {
    if (c.spearman == null) { L.push(`| ${c.label} | ${c.n} | ${c.note || '-'} | | | | | | | | |`); continue; }
    L.push(`| ${c.label} | ${c.n} | ${c.spearman} | ${c.overlap.top25.overlap}/${c.overlap.top25.of} | ${c.overlap.top50.overlap}/${c.overlap.top50.of} | ${c.overlap.top100.overlap}/${c.overlap.top100.of} | ${c.medianSignedDifference} | ${c.medianAbsoluteDifference} | ${Math.round(c.share.within5 * 100)}% | ${Math.round(c.share.over15 * 100)}% | ${Math.round(c.share.over30 * 100)}% |`);
  }
  L.push('', 'Ranks are recomputed within the shared players of each pair. Difference = Yahoo rank minus ProGM rank (positive: Yahoo places the player later than ProGM).', '');
  for (const [k, c] of Object.entries(rep.vsProgm)) {
    if (!c.largestLater) continue;
    L.push(`### Largest discrepancies: ${c.label}`, '', 'Yahoo later than ProGM (ProGM higher on the player):', '');
    for (const d of c.largestLater) L.push(`- ${d.name} (${d.positions.join('/')}): ProGM ${d.ProGM}, Yahoo ${d.Yahoo} (${d.diff > 0 ? '+' : ''}${d.diff})`);
    L.push('', 'Yahoo earlier than ProGM (Yahoo higher on the player):', '');
    for (const d of c.largestEarlier) L.push(`- ${d.name} (${d.positions.join('/')}): ProGM ${d.ProGM}, Yahoo ${d.Yahoo} (${d.diff > 0 ? '+' : ''}${d.diff})`);
    L.push('');
  }
  for (const [k, c] of Object.entries(rep.yahooAgainstItself)) if (c.spearman != null) L.push(`## ${k}`, '', `Shared ${c.n}; Spearman ${c.spearman}; top-25 overlap ${c.overlap.top25.overlap}/${c.overlap.top25.of}; top-50 ${c.overlap.top50.overlap}/${c.overlap.top50.of}; median abs difference ${c.medianAbsoluteDifference}.`, '');
  L.push('## Top 20 under each method', '', rep.howToIdentifyYahooBoard, '');
  const labels = { progm: 'ProGM Rank', ...Object.fromEntries(METHODS) };
  for (const [k, list] of Object.entries(rep.top20)) {
    L.push(`### ${labels[k] || k}`, ''); list.forEach((p) => L.push(`${p.position}. ${p.name} (${p.positions.join('/')})${k === 'progm' ? '' : ` [${p.value}]`}`)); L.push('');
  }
  if (rep.yahooRankedButNoProgmRank.length) { L.push('## Yahoo-ranked players without a ProGM rank (top 15)', ''); rep.yahooRankedButNoProgmRank.forEach((p) => L.push(`${p.position}. ${p.name} (${p.positions.join('/')}) [${p.value}]`)); L.push(''); }
  return L.join('\n');
}

const PRIVATE_PATTERNS = [/\b\d{2,4}\.l\.\d+/i, /\.t\.\d+/i, /eyJ[A-Za-z0-9_-]{10,}/, /bearer\s/i, /access[_-]?token|refresh[_-]?token|cookie|authorization/i, /league[_-]?key|team[_-]?key/i];
export function findPrivateData(text) { return PRIVATE_PATTERNS.filter((p) => p.test(text)).map(String); }

export function defaultOutputFolder(env = process.env, exists = fs.existsSync) {
  const home = os.homedir();
  for (const p of [env.USERPROFILE && path.join(env.USERPROFILE, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Desktop')]) if (p && exists(p)) return p;
  return process.cwd();
}

function main() {
  const [input, outArg] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/yahooRankCompare.mjs <saved-workspace-response.json> [output-folder]'); process.exit(2); }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(input, 'utf8')); } catch { console.error('Could not read the input file as JSON.'); process.exit(2); }
  const rep = buildReport(doc);
  if (!rep.coverage.players) { console.error('No draft board rows were found in that file (expected draftBoard.board).'); process.exit(3); }
  const json = JSON.stringify(rep, null, 2); const md = toMarkdown(rep);
  const hits = findPrivateData(json + md);
  if (hits.length) { console.error('Refusing to write: output matched private-data patterns.'); process.exit(4); }
  const out = outArg || defaultOutputFolder();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'progm-yahoo-rank-comparison.json'), json);
  fs.writeFileSync(path.join(out, 'progm-yahoo-rank-comparison.md'), md);
  console.log(`Wrote progm-yahoo-rank-comparison.md and .json to ${out}`);
  console.log(`Players: ${rep.coverage.players}; ADP provenance recorded: ${typeof rep.coverage.adpProvenance !== 'string'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
