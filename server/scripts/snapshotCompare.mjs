// Usage: node scripts/snapshotCompare.mjs <saved-workspace-response.json> [outDir]
// Reads ONE local file, writes two sanitized files, makes no network or database access.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspace, analyzeSnapshot } from '../src/services/fantasy/snapshotCompare.js';

const [input, outDir = '.'] = process.argv.slice(2);
if (!input) { console.error('Usage: node scripts/snapshotCompare.mjs <saved-workspace-response.json> [outDir]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const clean = sanitizeWorkspace(raw);
const result = analyzeSnapshot(clean, { highlight: ['Cade Cunningham', 'Bam Adebayo', 'Alperen Sengun'], top: 50 });
const snapshotPath = path.join(outDir, 'progm-sanitized-snapshot.json');
const resultPath = path.join(outDir, 'progm-ranking-comparison.json');
const { rankingsParity, ...shareable } = clean; // parity pairs are not written to disk
fs.writeFileSync(snapshotPath, JSON.stringify(shareable, null, 1));
fs.writeFileSync(resultPath, JSON.stringify(result, null, 1));
const h = result.comparison.highlighted;
console.log(`players in board: ${result.comparison.players}; top-50 overlap legacy/v2: ${result.comparison.summary.topOverlap}/50`);
for (const p of h) console.log(`${p.name}: legacy #${p.legacyRank} -> v2 #${p.v2Rank} (${p.projectedFantasyPointsPerGame}/gm, ${p.expectedGames} games)`);
console.log('Rankings vs Draft Helper:', JSON.stringify(result.rankingsVsDraftHelper));
console.log('Rookie estimate coverage:', JSON.stringify({ ...result.rookieEstimateCoverage, players: undefined }));
console.log(`Wrote ${snapshotPath} and ${resultPath}. Share only these two files after reading them.`);
