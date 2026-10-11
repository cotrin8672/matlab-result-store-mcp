import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function userConfigFile(): string {
  // Codex does not forward CODEX_HOME to MCP processes; use the installed cache location.
  const cache = path.resolve(import.meta.dirname, '../../..');
  const installedHome = path.basename(cache) === 'cache' && path.basename(path.dirname(cache)) === 'plugins'
    ? path.dirname(path.dirname(cache)) : path.join(homedir(), '.codex');
  return path.join(process.env.CODEX_HOME ?? installedHome, 'matlab-result-store', 'store.local.json');
}

export function configFile(): string {
  return process.env.PLUGIN_DATA ? path.join(process.env.PLUGIN_DATA, 'store.local.json') : userConfigFile();
}

export function configuredRoot(): string {
  const arg = process.argv[2];
  if (arg && !arg.startsWith('--')) return arg;
  if (process.env.RESULT_STORE_ROOT) return process.env.RESULT_STORE_ROOT;
  for (const file of [configFile(), userConfigFile(), path.join(import.meta.dirname, 'store.local.json')]) {
    if (!existsSync(file)) continue;
    const { root } = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof root !== 'string' || !root.trim()) throw new Error(`Invalid Store root in ${file}.`);
    return root;
  }
  throw new Error('Store folder is not configured. Run the MATLAB Result Store setup skill and choose a folder containing results/store.sqlite.');
}
