// Safety check before a LOCAL shadow-mode run. Prints only host-level facts (never passwords, tokens or full URLs).
// Exit code 1 = do not start the server with this environment.
//   node scripts/shadowPreflight.mjs
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { databaseProblems } from '../src/db/localGuard.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// Mirror the app: server/.env (db/connection.js) and ./.env of the working directory (index.js). Existing variables win.
dotenv.config({ path: join(serverDir, '.env'), quiet: true });
dotenv.config({ quiet: true });

const problems = [];
const db = databaseProblems(process.env);
const notes = [...db.notes];
for (const p of db.problems) problems.push(`${p} Do NOT start the server: it runs CREATE/ALTER TABLE on startup and stores/refreshes Yahoo tokens in that database.`);
if (process.env.RENDER_EXTERNAL_HOSTNAME) problems.push('RENDER_EXTERNAL_HOSTNAME is set: the Yahoo redirect would be built for Render. Remove it for local runs.');
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') problems.push('NODE_ENV=production. Unset it for local runs (diagnostics stay closed in production mode).');
if (!process.env.YAHOO_CLIENT_ID || !process.env.YAHOO_CLIENT_SECRET) notes.push('YAHOO_CLIENT_ID/SECRET not set: Yahoo sign-in will report "not configured".');
if (/onrender\.com/i.test(`${process.env.YAHOO_REDIRECT_URI || ''} ${process.env.FRONTEND_URL || ''}`)) problems.push('YAHOO_REDIRECT_URI or FRONTEND_URL points at onrender.com: sign-in would be sent to production. Use the local callback (http://localhost:3005/api/yahoo/callback) registered on a Yahoo app you control.');
for (const name of ['PROGM_RANKING_MODEL', 'PROGM_ROOKIE_ESTIMATES']) if (process.env[name]) problems.push(`${name} is set (${process.env[name]}). Unset it: shadow mode requires the visible model to be legacy with rookie estimates off.`);
notes.push(`PROGM_RANKING_SHADOW=${process.env.PROGM_RANKING_SHADOW || '(unset)'}  PROGM_RANKING_DIAGNOSTIC=${process.env.PROGM_RANKING_DIAGNOSTIC || '(unset)'}  PORT=${process.env.PORT || '(unset; Vite proxy expects 3005)'}`);

for (const n of notes) console.log('  ' + n);
if (problems.length) {
  console.log('\nSTOP - problems found:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nPreflight OK: environment looks local and safe.');
