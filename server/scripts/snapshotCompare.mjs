// Usage: node scripts/snapshotCompare.mjs <saved-workspace-response.json> [outDir]
// Reads ONE local file, writes two sanitized files, makes no network or database access.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWorkspace, analyzeSnapshot } from '../src/services/fantasy/snapshotCompare.js';
import { compareScenarios, fidelity, playerNumberEvidence } from '../src/services/fantasy/snapshotReplay.js';

const [input, outDir = '.'] = process.argv.slice(2);
if (!input) { console.error('Usage: node scripts/snapshotCompare.mjs <saved-workspace-response.json> [outDir]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const HIGHLIGHT = ['Cade Cunningham', 'Bam Adebayo', 'Alperen Sengun'];
const clean = sanitizeWorkspace(raw, { trace: HIGHLIGHT });
const result = analyzeSnapshot(clean, { highlight: HIGHLIGHT, top: 50 });
let pipeline;
try {
  pipeline = { fidelityOfReplay: fidelity(clean), ...compareScenarios(clean, { highlight: HIGHLIGHT }), yahooPlayerNumberEvidence: playerNumberEvidence(clean) };
} catch (e) { pipeline = { unavailable: String(e.message || e) }; }
const snapshotPath = path.join(outDir, 'progm-sanitized-snapshot.json');
const resultPath = path.join(outDir, 'progm-ranking-comparison.json');
const { rankingsParity, ...shareable } = clean; // parity pairs are not written to disk
fs.writeFileSync(snapshotPath, JSON.stringify(shareable, null, 1));
fs.writeFileSync(resultPath, JSON.stringify(result, null, 1));
const pipelinePath = path.join(outDir, 'progm-offline-pipeline.json');
fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 1));
const h = result.comparison.highlighted;
console.log(`players in board: ${result.comparison.players}; top-50 overlap legacy/v2: ${result.comparison.summary.topOverlap}/50`);
for (const p of h) console.log(`${p.name}: legacy #${p.legacyRank} -> v2 #${p.v2Rank} (${p.projectedFantasyPointsPerGame}/gm, ${p.expectedGames} games)`);
console.log('Rankings vs Draft Helper:', JSON.stringify(result.rankingsVsDraftHelper));
console.log('Unprojected by class:', JSON.stringify(Object.fromEntries(Object.entries(result.rookieEstimateCoverage.unprojectedByClass).map(([k, v]) => [k, `${v.total} (${v.withAdp} with ADP)`]))));
console.log('Rookie estimate coverage:', JSON.stringify({ ...result.rookieEstimateCoverage, players: undefined }));
if (pipeline.unavailable) console.log('Offline pipeline replay unavailable:', pipeline.unavailable);
else {
  console.log('Replay fidelity (legacy replay vs ranks shown by the app):', JSON.stringify(pipeline.fidelityOfReplay));
  for (const r of pipeline.rookies) console.log(`Rookie ${r.name}: ADP ${r.yahooAdp} -> ${r.impliedFantasyPointsPerGame}/gm x ${r.expectedGames} games, ProGM Rank #${r.proGMRank} of ${r.poolSize}`);
  for (const [k, b] of Object.entries(pipeline.bands)) console.log(`${k}: overlap ${b.overlap}/${b.size.legacy}, entering ${b.entering.length}, leaving ${b.leaving.length}`);
  for (const h of pipeline.highlighted) console.log(h.found === false ? `${h.name}: not in the pool` : `${h.name}: legacy #${h.legacy} -> v2 #${h.v2} -> v2+rookies #${h.experimental}`);
}
console.log(`Wrote ${snapshotPath}, ${resultPath} and ${pipelinePath}. Share only these three files after reading them.`);
