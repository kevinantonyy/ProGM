import os from 'node:os';
import path from 'node:path';

/**
 * Default private log directory: outside the repository, per user.
 * The path flavour follows `platform`, not the machine running the code, so the result is the same on every host
 * (Windows: %LOCALAPPDATA%\ProGM\injury-log with backslashes; elsewhere: ~/.progm/injury-log with forward slashes).
 */
export function defaultLogDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.PROGM_INJURY_LOG_DIR) return p.resolve(env.PROGM_INJURY_LOG_DIR);
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'ProGM', 'injury-log');
  return p.join(home, '.progm', 'injury-log');
}
