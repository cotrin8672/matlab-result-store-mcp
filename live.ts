import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyPlotUpdate, type PlotState, type PlotUpdate } from './plots.ts';

type Session = { version: number; folder: string; token: string; pid: number };
type Reply = { error?: string; payload: string; plot_name: string; update: PlotUpdate; preview?: string; timings: Record<string, number> };
type Saved = Reply & PlotState & { scheme: string; row_id: string; plot_index: number };

export class LivePlots {
  readonly root: string;
  private current?: Saved;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.root = root; }

  cached(scheme: string, rowId: string, plotIndex: number) {
    const value = this.current;
    return value?.scheme === scheme && value.row_id === rowId && value.plot_index === plotIndex ? value : undefined;
  }

  async session(): Promise<Session | undefined> {
    let value: Session;
    try { value = JSON.parse(await readFile(path.join(this.root, 'results/web/live.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let folder: string;
    try { folder = await realpath(value.folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const relative = path.relative(await realpath(tmpdir()), folder);
    if (value.version !== 1 || !relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        !path.basename(folder).startsWith('result-store-') || !/^[a-f0-9-]{36}$/i.test(value.token) || !Number.isInteger(value.pid)) {
      throw new Error('Invalid MATLAB live connection. Run resultstore.connect(root) again.');
    }
    try { process.kill(value.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    return { ...value, folder };
  }

  async render(session: Session, scheme: string, rowId: string, plotIndex: number, preview: boolean, refresh: boolean, knownRevision?: string) {
    const task = this.queue.then(async () => {
      const id = randomUUID(), request = path.join(session.folder, `${id}.request.json`), response = path.join(session.folder, `${id}.response.json`);
      const temporary = request + '.tmp', started = performance.now();
      let received = false;
      try {
        await writeFile(temporary, JSON.stringify({ token: session.token, scheme, row_id: rowId, plot_index: plotIndex,
          preview, refresh, known_revision: this.current?.revision ?? '', expires: Date.now() + 30000 }));
        await rename(temporary, request);
        let reply: Reply;
        for (;;) {
          try { reply = JSON.parse(await readFile(response, 'utf8')); received = true; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (performance.now() - started > 30000) throw new Error('MATLAB did not respond. It may be busy. Run resultstore.connect(root) in the existing session when it is available.');
          await delay(15);
        }
        if (reply.error) throw new Error(reply.error);
        const previous = this.current;
        const state = applyPlotUpdate(previous, reply.update);
        this.current = { ...reply, ...state, scheme, row_id: rowId, plot_index: plotIndex };
        const update = knownRevision && knownRevision === reply.update.base_revision
          ? reply.update : { revision: state.revision, plot: state.plot };
        return { ...this.current, update, timings: { ...reply.timings, round_trip_ms: performance.now() - started } };
      } finally {
        // MATLAB owns received requests; simultaneous unlink can fail on Windows.
        for (const file of [temporary, response, ...(received ? [] : [request])]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
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
