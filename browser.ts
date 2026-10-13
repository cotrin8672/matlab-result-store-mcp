import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const selectionSchema = z.object({ directory: z.string().optional(), scheme: z.string().min(1), row_id: z.string().regex(/^[1-9]\d*$/), plot_index: z.number().int().min(1) });
const stateSchema = z.object({ revision: z.string(), kind: z.enum(['plot', 'annotations', 'pins']), selection: selectionSchema.optional(), plot_revision: z.string().optional(), pins_revision: z.string().optional() });
export type BrowserSelection = z.infer<typeof selectionSchema>;
export type BrowserState = z.infer<typeof stateSchema>;

function filename(root: string, scope?: string) {
  return path.join(tmpdir(), 'matlab-results-browser-' + createHash('sha256').update(scope ? root + ':' + scope : root).digest('hex') + '.json');
}
export function readBrowserState(root: string, scope?: string): BrowserState {
  try { return stateSchema.parse(JSON.parse(readFileSync(filename(root, scope), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', kind: 'plot' }; throw error; }
}
export function showInBrowser(root: string, selection: BrowserSelection | undefined, kind: BrowserState['kind'], plotRevision?: string, scope?: string) {
  const current = readBrowserState(root, scope);
  if (kind === 'plot' && current.kind === kind && plotRevision && current.plot_revision === plotRevision &&
      selection && current.selection?.directory === selection.directory && current.selection?.scheme === selection.scheme && current.selection.row_id === selection.row_id && current.selection.plot_index === selection.plot_index) return;
  const file = filename(root, scope), revision = randomUUID(), temporary = `${file}.${revision}.tmp`;
  const state = kind === 'pins' ? { ...current, pins_revision: revision } : { revision, kind, selection, plot_revision: plotRevision, pins_revision: current.pins_revision };
  writeFileSync(temporary, JSON.stringify(state), { flag: 'wx' });
  try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}
