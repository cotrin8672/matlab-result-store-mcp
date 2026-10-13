import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configFile } from './config.ts';
import type { Plot, PlotAnnotation } from './plots.ts';

export type PinnedPlot = {
  id: string; directory: string; scheme: string; row_id: string; plot_index: number;
  plot_name: string; payload: string; revision: string; created_at: string;
  keys: Record<string, unknown>; key_labels: Record<string, string>; annotations: PlotAnnotation[]; plotly_uri: string;
};
type Snapshot = PinnedPlot & { plot: Plot };

export class PlotPins {
  readonly folder: string;
  constructor(folder = path.join(path.dirname(configFile()), 'pins')) { this.folder = folder; }
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid pinned Plot ID.');
    return path.join(this.folder, id + '.json');
  }
  read(id: string): Snapshot { return JSON.parse(readFileSync(this.file(id), 'utf8')); }
  list() {
    let names: string[];
    try { names = readdirSync(this.folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pins: [], revision: '' }; throw error; }
    const pins = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      try { const { plot: _plot, ...metadata } = this.read(name.slice(0, -5)); return [metadata]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    }).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return { pins, revision: createHash('sha256').update(JSON.stringify(pins)).digest('hex') };
  }
  pin(value: Omit<Snapshot, 'id' | 'created_at' | 'plotly_uri'>) {
    const directory = process.platform === 'win32' ? value.directory.toLowerCase() : value.directory;
    const id = createHash('sha256').update(JSON.stringify([directory, value.scheme, value.row_id, value.plot_index, value.payload])).digest('hex');
    const file = this.file(id);
    if (!existsSync(file)) {
      mkdirSync(this.folder, { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      const snapshot: Snapshot = { ...value, id, created_at: new Date().toISOString(), plotly_uri: `result-store://pins/${id}/plot.json` };
      writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { rmSync(temporary, { force: true }); }
    }
    return this.list();
  }
  unpin(id: string) { rmSync(this.file(id), { force: true }); return this.list(); }
}
