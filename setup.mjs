import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFile } from './config.ts';

export function preparePlugin() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('MATLAB Result Store needs Node.js 24 or later.');
  const folder = import.meta.dirname;
  const hash = createHash('sha256');
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'build.mjs', 'queries.ts', 'plots.ts', 'ui/browser.ts', 'ui/browser.html', 'ui/query-function.ts', 'ui/preview.ts', 'ui/preview.html']) {
    hash.update(readFileSync(path.join(folder, file)));
  }
  const fingerprint = hash.digest('hex');
  const stamp = path.join(folder, 'node_modules', '.result-store-ready');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint && existsSync(path.join(folder, 'dist', 'browser.html'))) return;
  console.error('Preparing MATLAB Result Store dependencies and UI...');
  const options = {
    cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true,
  };
  const available = spawnSync('pnpm --version', options).status === 0;
  const install = spawnSync(available
    ? 'pnpm install --frozen-lockfile --prod=false'
    : 'npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --prod=false', options);
  if (install.stdout) process.stderr.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error('Dependency setup failed. Check that pnpm or npm is available and the package registry is reachable, then run setup again.');
  const build = spawnSync(process.execPath, ['build.mjs'], { cwd: folder, stdio: ['ignore', 2, 2], windowsHide: true });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Result Store UI build failed. Run setup again after resolving the build error.');
  writeFileSync(stamp, fingerprint);
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node setup.mjs <Store folder containing results/store.sqlite>');
  const root = realpathSync(input);
  if (!statSync(path.join(root, 'results', 'store.sqlite')).isFile()) throw new Error('Store folder must contain results/store.sqlite.');
  preparePlugin();
  const { ResultStore } = await import('./store.ts');
  const store = new ResultStore(root);
  let data;
  try { data = store.listSchemes(); } finally { store.db.close(); }
  const config = configFile();
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ root }, null, 2) + '\n');
  console.log(JSON.stringify({ root, config, schemes: data.schemes.map(scheme => ({ id: scheme.id, count: scheme.count })), plot_catalog: data.plot_catalog }, null, 2));
}
