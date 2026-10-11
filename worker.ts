import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export function running(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

export async function ensureWorker<T>(root: string, readSession: () => Promise<T | undefined>): Promise<T> {
  const existing = await readSession(); if (existing) return existing;
  const canonical = await realpath(root);
  const folder = path.join(tmpdir(), 'result-store-worker-' + createHash('sha256').update(canonical).digest('hex'));
  mkdirSync(folder, { recursive: true });
  const log = path.join(folder, 'matlab.log');
  const db = new DatabaseSync(path.join(folder, 'launch.sqlite'));
  db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS launch (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)');
  const token = randomUUID(), started = performance.now();
  let child: ReturnType<typeof spawn> | undefined, startupError: Error | undefined, ready = false;
  try {
    for (;;) {
      const session = await readSession();
      if (session) { ready = true; return session; }
      if (startupError) throw new Error(`Could not start the Plot worker: ${startupError.message}. MATLAB must be available on PATH.`);
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`The Plot worker exited before becoming ready. See ${log}.`);
      db.exec('BEGIN IMMEDIATE');
      const owner = db.prepare('SELECT pid, token FROM launch WHERE id=1').get() as { pid: number; token: string } | undefined;
      const acquired = !owner || !running(owner.pid);
      if (acquired) db.prepare('INSERT OR REPLACE INTO launch VALUES (1, ?, ?)').run(process.pid, token);
      db.exec('COMMIT');
      if (acquired) {
        if (await readSession()) continue;
        let common = '', ancestor = canonical;
        for (;;) {
          if (existsSync(path.join(ancestor, 'common/+store/loadSchemes.m'))) { common = path.join(ancestor, 'common'); break; }
          const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
        }
        const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
        child = spawn('matlab', [...(process.platform === 'win32' ? ['-wait'] : []), '-noFigureWindows', '-sd', canonical, '-logfile', log, '-batch',
          `addpath(${quote(path.join(import.meta.dirname, 'matlab'))});resultstore.worker(${quote(canonical)},${quote(common)});`],
        { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', error => { startupError = error; });
        if (child.pid) db.prepare('UPDATE launch SET pid=? WHERE token=?').run(child.pid, token);
        child.unref();
      }
      if (performance.now() - started > 120000) throw new Error(`The Plot worker is still starting. See ${log}.`);
      await delay(100);
    }
  } finally {
    if (ready || !child?.pid || !running(child.pid)) db.prepare('DELETE FROM launch WHERE token=?').run(token);
    db.close();
  }
}
