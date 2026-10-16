import os from 'node:os';
import path from 'node:path';

/** Default private log directory: outside the repository, per user. */
export function defaultLogDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.PROGM_INJURY_LOG_DIR) return path.resolve(env.PROGM_INJURY_LOG_DIR);
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'ProGM', 'injury-log');
  return path.join(home, '.progm', 'injury-log');
}
