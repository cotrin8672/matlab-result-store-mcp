import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Saved } from './live.ts';
import type { PlotState, PlotUpdate } from './plots.ts';

const maxEntries = 128, maxBytes = 256 * 1024 * 1024;

export class PlotCache {
  readonly folder: string;
  private current?: PlotState;
  constructor(root: string) {
    const canonical = realpathSync(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    this.folder = path.join(tmpdir(), 'result-store-plot-cache-v1-' + createHash('sha256').update(key).digest('hex'));
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
  }

  private file(scheme: string, row: string, index: number, payload: string) {
    return path.join(this.folder, createHash('sha256').update(JSON.stringify([scheme, row, index, payload])).digest('hex') + '.json');
  }

  get(scheme: string, row: string, index: number, payload: string): Saved | undefined {
    const started = performance.now();
    const file = this.file(scheme, row, index, payload);
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      if (value.scheme !== scheme || value.row_id !== row || value.plot_index !== index || value.payload !== payload) return;
      const now = new Date(); utimesSync(file, now, now);
      return { ...value, update: { revision: value.revision, plot: value.plot }, timings: { cache_read_ms: performance.now() - started } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof SyntaxError) { remove(file); return; }
      throw error;
    }
  }

  update(next: PlotState, knownRevision?: string): PlotUpdate {
    const before = this.current;
    this.current = next;
    if (knownRevision === next.revision) return { revision: next.revision, base_revision: next.revision };
    const full = { revision: next.revision, plot: next.plot };
    const sameKeys = (a: object, b: object) => isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
    if (!before || knownRevision !== before.revision || before.plot.data.length !== next.plot.data.length ||
        !sameKeys(before.plot.layout, next.plot.layout) || !isDeepStrictEqual(before.plot.frames, next.plot.frames)) return full;
    const traces: NonNullable<PlotUpdate['traces']> = [];
    for (const [index, after] of next.plot.data.entries()) {
      const previous = before.plot.data[index];
      if (!sameKeys(previous, after)) return full;
      const values = Object.fromEntries(Object.entries(after).filter(([key, value]) => !isDeepStrictEqual(previous[key], value)));
      if (Object.keys(values).length) traces.push({ index, values });
    }
    const layout = Object.fromEntries(Object.entries(next.plot.layout).filter(([key, value]) => !isDeepStrictEqual(before.plot.layout[key], value)));
    return { revision: next.revision, base_revision: before.revision, traces, layout };
  }

  put(value: Saved) {
    const file = this.file(value.scheme, value.row_id, value.plot_index, value.payload), temporary = file + '.' + randomUUID() + '.tmp';
    const { update: _update, ...snapshot } = value;
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > maxBytes) return;
    writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, file);
    const entries = readdirSync(this.folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      const file = path.join(this.folder, name);
      try { const stat = statSync(file); return [{ file, bytes: stat.size, touched: stat.mtimeMs }]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }).sort((a, b) => a.touched - b.touched);
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0), count = entries.length;
    for (const entry of entries) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      remove(entry.file); bytes -= entry.bytes; count--;
    }
  }
}

function remove(file: string) {
  try { unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

const stores = new Map<string, PlotCache>();
export function plotCache(root: string) {
  let value = stores.get(root);
  if (!value) { value = new PlotCache(root); stores.set(root, value); }
  return value;
}
