// TEST ONLY (never imported by production code). Opts every external data source in, exactly as an operator re-enabling them would
// with PROGM_DATA_*=allow, so tests of provider logic can run against mocked HTTP. Default-deny behavior is tested in policy.test.js.
import { DATA_SOURCES } from './policy.js';

for (const { env } of Object.values(DATA_SOURCES)) process.env[env] = 'allow';
