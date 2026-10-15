// Local shadow-mode starter: sets the local-only flags, runs the preflight (exits 1 on any problem, so the server is never
// started), then starts the normal server in this same process with PROGM_REQUIRE_LOCAL_DB=on as a second, hard guard.
//   npm run shadow:local
process.env.PROGM_REQUIRE_LOCAL_DB = 'on';
process.env.PROGM_RANKING_SHADOW = 'on';
process.env.PROGM_RANKING_DIAGNOSTIC = 'on';
process.env.PORT = '3005'; // the Vite dev proxy expects 3005
await import('./shadowPreflight.mjs'); // process.exit(1) on problems
await import('../src/index.js');
