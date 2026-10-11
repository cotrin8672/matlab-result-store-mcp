import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyPlotUpdate, type PlotState, type PlotUpdate } from './plots.ts';
import { ensureWorker, running } from './worker.ts';

type Session = { version: number; folder: string; token: string; pid: number };
type Reply = { error?: string; payload: string; plot_name: string; update: PlotUpdate; preview?: string; timings: Record<string, number> };
type Saved = Reply & PlotState & { scheme: string; row_id: string; plot_index: number };

export class LivePlots {
  readonly root: string;
  private current?: Saved;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.root = root; }

  async session(start = true): Promise<Session | undefined> {
    return start ? ensureWorker(this.root, () => this.readSession()) : this.readSession();
  }

  private async readSession(): Promise<Session | undefined> {
    let value: Session;
    try { value = JSON.parse(await readFile(path.join(this.root, 'results/web/worker.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let folder: string;
    try { folder = await realpath(value.folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const relative = path.relative(await realpath(tmpdir()), folder);
    if (value.version !== 1 || !relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        !path.basename(folder).startsWith('result-store-') || !/^[a-f0-9-]{36}$/i.test(value.token) || !Number.isInteger(value.pid)) {
      throw new Error('Invalid Plot worker connection.');
    }
    if (!running(value.pid)) return;
    return { ...value, folder };
  }

  async refreshCatalog(session: Session) {
    const task = this.queue.then(() => this.send(session, { operation: 'catalog' }));
    this.queue = task.catch(() => {});
    await task;
  }

  private async send<T extends { error?: string }>(session: Session, args: Record<string, unknown>): Promise<T> {
    const id = randomUUID(), request = path.join(session.folder, `${id}.request.json`), response = path.join(session.folder, `${id}.response.json`);
    const temporary = request + '.tmp', started = performance.now();
    let received = false;
    try {
      await writeFile(temporary, JSON.stringify({ token: session.token, ...args, expires: Date.now() + 30000 }));
      await rename(temporary, request);
      let reply: T;
      for (;;) {
        try { reply = JSON.parse(await readFile(response, 'utf8')); received = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (performance.now() - started > 30000) throw new Error('The Plot worker did not respond within 30 seconds.');
        await delay(15);
      }
      if (reply.error) throw new Error(reply.error);
      return reply;
    } finally {
      // MATLAB owns received requests; simultaneous unlink can fail on Windows.
      for (const file of [temporary, response, ...(received ? [] : [request])]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async render(session: Session, scheme: string, rowId: string, plotIndex: number, preview: boolean, refresh: boolean, knownRevision?: string) {
    const task = this.queue.then(async () => {
      const started = performance.now();
      const reply = await this.send<Reply>(session, { scheme, row_id: rowId, plot_index: plotIndex,
        preview, refresh, known_revision: this.current?.revision ?? '' });
      const previous = this.current;
      const state = applyPlotUpdate(previous, reply.update);
      this.current = { ...reply, ...state, scheme, row_id: rowId, plot_index: plotIndex };
      const update = knownRevision && knownRevision === reply.update.base_revision
        ? reply.update : { revision: state.revision, plot: state.plot };
      return { ...this.current, update, timings: { ...reply.timings, round_trip_ms: performance.now() - started } };
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

const stores = new Map<string, LivePlots>();
export function livePlots(root: string) {
  let value = stores.get(root);
  if (!value) { value = new LivePlots(root); stores.set(root, value); }
  return value;
}
