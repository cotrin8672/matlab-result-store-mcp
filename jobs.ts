import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { livePlots } from './live.ts';
import { running } from './worker.ts';
import { readMatValues, type Selection } from './store.ts';
import { JobEvents } from './events.ts';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Job = {
  job_id: string; backend: 'background' | 'worker'; state: JobState;
  created_at: string; updated_at: string; finished_at?: string; pid?: number;
  outputs: string[]; result_uri: string;
  error?: { identifier: string; message: string; stack?: unknown };
};
type Record = { owner: string; data: string };
export const finished = (job: Job) => ['succeeded', 'failed', 'cancelled'].includes(job.state);

export class MatlabJobs {
  readonly root: string;
  readonly folder: string;
  readonly db: DatabaseSync;
  readonly events: JobEvents;
  private timer: ReturnType<typeof setInterval>;
  private ticking = false;
  private submissions = new Set<string>();

  constructor(root: string) {
    this.root = realpathSync(root);
    const key = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
    this.folder = path.join(tmpdir(), 'result-store-jobs-' + createHash('sha256').update(key).digest('hex'));
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.folder, 'jobs.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL)');
    this.events = new JobEvents(this.db, (id, owner) => this.record(id, owner));
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  private record(id: string, owner?: string): Job {
    const row = this.db.prepare('SELECT owner, data FROM jobs WHERE id=?').get(id) as Record | undefined;
    if (!row || (owner !== undefined && row.owner !== owner)) throw new Error('Unknown MATLAB Job.');
    const job = JSON.parse(row.data) as Job;
    return { ...job, result_uri: `matlab-results://jobs/${job.job_id}?directory=${encodeURIComponent(this.root)}` };
  }

  private save(job: Job) { this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.job_id); }

  async start(backend: Job['backend'], code: string, outputs: string[], owner: string) {
    const id = randomUUID(), folder = path.join(this.folder, id), created = new Date().toISOString();
    mkdirSync(folder, { mode: 0o700 });
    const functionName = 'mcp_job_' + id.replaceAll('-', '_');
    const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
    const fields = outputs.map(name => `${quote(name)},{${name}}`).join(',');
    writeFileSync(path.join(folder, `${functionName}.m`), `function mcp_outputs = ${functionName}()\nroot = string(${quote(this.root)});\n${code}\nmcp_outputs = struct(${fields});\nend\n`, { mode: 0o600 });
    writeFileSync(path.join(folder, 'request.json'), JSON.stringify({ job_id: id, backend, function_name: functionName, outputs }), { mode: 0o600 });
    const job: Job = { job_id: id, backend, state: 'queued', created_at: created, updated_at: created,
      outputs, result_uri: `matlab-results://jobs/${id}?directory=${encodeURIComponent(this.root)}` };
    this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?)').run(id, owner, JSON.stringify(job));
    this.submit(job);
    return job;
  }

  private submit(job: Job) {
    const id = job.job_id, folder = path.join(this.folder, id);
    if (this.submissions.has(id)) return;
    this.submissions.add(id);
    // The persistent ID is returned before MATLAB starts up or creates a process pool.
    void livePlots(this.root).submitJob({ job_id: id, folder }).catch(error => {
      const current = this.record(id);
      if (finished(current) || readJson(path.join(folder, 'status.json')) || error.name === 'TimeoutError') return;
      const now = new Date().toISOString();
      this.save({ ...current, state: 'failed', updated_at: now, finished_at: now,
        error: { identifier: 'resultstore:SubmissionFailed', message: error.message } });
      void this.tick();
    }).finally(() => this.submissions.delete(id));
  }

  private sync(id: string) {
    let job = this.record(id);
    if (!finished(job)) {
      const status = readJson(path.join(this.folder, id, 'status.json')) as Partial<Job> | undefined;
      if (status) {
        job = { ...job, ...status };
        if (!finished(job) && job.pid && !running(job.pid)) {
          const now = new Date().toISOString();
          job = { ...job, state: 'failed', updated_at: now, finished_at: now,
            error: { identifier: 'resultstore:WorkerExited', message: 'The MCP MATLAB process exited before this Job finished.' } };
        }
        this.save(job);
      } else this.submit(job);
    }
    if (finished(job)) this.events.publish(job);
    return job;
  }

  async get(id: string, owner: string, include: string[] = [], selection?: Selection, maxElements = 4096) {
    this.record(id, owner);
    const job = this.sync(id);
    const log = readText(path.join(this.folder, id, 'stdout.txt'));
    const values = job.state === 'succeeded' && job.outputs.length
      ? await readMatValues(path.join(this.folder, id, 'outputs.mat'), job.outputs, include, selection, maxElements) : undefined;
    if (job.state === 'succeeded' && !job.outputs.length && include.length) throw new Error('This Job has no output variables.');
    return { ...job, stdout: log.slice(-65536), stdout_truncated: log.length > 65536, values };
  }

  list(owner: string, limit: number) {
    const rows = this.db.prepare('SELECT id FROM jobs WHERE owner=? ORDER BY rowid DESC LIMIT ?').all(owner, limit) as { id: string }[];
    return { jobs: rows.map(row => this.sync(row.id)) };
  }

  cancel(id: string, owner: string) {
    this.record(id, owner);
    const job = this.sync(id);
    if (finished(job)) return { ...job, cancel_requested: false };
    const file = path.join(this.folder, id, 'cancel');
    writeFileSync(file, '');
    return { ...job, cancel_requested: true };
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.db.prepare(`SELECT id FROM jobs WHERE json_extract(data, '$.state') IN ('queued', 'running')
        OR NOT EXISTS (SELECT 1 FROM events WHERE event_id='evt_' || jobs.id)`).all() as { id: string }[];
      for (const row of rows) this.sync(row.id);
      await this.events.flush();
    } catch (error) { console.error('MATLAB Job monitor:', error instanceof Error ? error.message : String(error)); }
    finally { this.ticking = false; }
  }

  close() { clearInterval(this.timer); this.db.close(); }
}

function readJson(file: string): unknown {
  const text = readText(file);
  return text ? JSON.parse(text) : undefined;
}
function readText(file: string) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

const stores = new Map<string, MatlabJobs>();
export function matlabJobs(root: string) {
  const canonical = realpathSync(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  let jobs = stores.get(key);
  if (!jobs) { jobs = new MatlabJobs(canonical); stores.set(key, jobs); }
  return jobs;
}
