import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const selectionSchema = z.object({ scheme: z.string().min(1), row_id: z.string().regex(/^[1-9]\d*$/), plot_index: z.number().int().min(1) });
const stateSchema = z.object({ revision: z.string(), kind: z.enum(['plot', 'annotations']), selection: selectionSchema.optional() });
export type BrowserSelection = z.infer<typeof selectionSchema>;
export type BrowserState = z.infer<typeof stateSchema>;

function filename(root: string) {
  return path.join(tmpdir(), 'matlab-results-browser-' + createHash('sha256').update(root).digest('hex') + '.json');
}
export function readBrowserState(root: string): BrowserState {
  try { return stateSchema.parse(JSON.parse(readFileSync(filename(root), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', kind: 'plot' }; throw error; }
}
export function showInBrowser(root: string, selection: BrowserSelection, kind: BrowserState['kind']) {
  const file = filename(root), revision = randomUUID(), temporary = `${file}.${revision}.tmp`;
  writeFileSync(temporary, JSON.stringify({ revision, kind, selection }), { flag: 'wx' });
  try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}
