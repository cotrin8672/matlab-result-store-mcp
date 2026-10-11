import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ResultStore } from './store.ts';
import type { PlotAnnotation, PlotAnnotations } from './plots.ts';

const axes = {
  xaxis: z.string().regex(/^x(?:[2-9]|[1-9]\d+)?$/).default('x').describe('Plotly x axis reference: x, x2, x3, ...'),
  yaxis: z.string().regex(/^y(?:[2-9]|[1-9]\d+)?$/).default('y').describe('Plotly y axis reference: y, y2, y3, ...'),
};
const coordinate = z.number().finite(), text = z.string().min(1).max(500);
export const annotationsSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('point_label'), x: coordinate, y: coordinate, text, ...axes }).strict(),
  z.object({ type: z.literal('xline'), x: coordinate, text: text.optional(), ...axes }).strict(),
  z.object({ type: z.literal('yline'), y: coordinate, text: text.optional(), ...axes }).strict(),
])).max(100);
const savedSchema = z.object({ payload: z.string(), revision: z.string(), annotations: annotationsSchema });
const cache = new Map<string, { stamp: string; saved: z.infer<typeof savedSchema> }>();
const empty = (): PlotAnnotations => ({ revision: '', annotations: [] });
function filename(scheme: string, rowId: string, plotIndex: number) {
  return createHash('sha256').update(JSON.stringify([scheme, rowId, plotIndex])).digest('hex') + '.json';
}

export function readAnnotations(store: ResultStore, scheme: string, rowId: string, plotIndex: number, payload: string): PlotAnnotations {
  let file: string;
  try { file = store.file(`results/web/annotations/${filename(scheme, rowId, plotIndex)}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
  const stat = statSync(file, { bigint: true }), stamp = `${stat.mtimeNs}:${stat.size}`;
  let entry = cache.get(file);
  if (!entry || entry.stamp !== stamp) {
    entry = { stamp, saved: savedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) }; cache.set(file, entry);
  }
  return entry.saved.payload === payload ? { revision: entry.saved.revision, annotations: entry.saved.annotations } : empty();
}

export function writeAnnotations(store: ResultStore, scheme: string, rowId: string, plotIndex: number, payload: string, annotations: PlotAnnotation[]): PlotAnnotations {
  if (store.record(store.scheme(scheme), rowId).__store_payload !== payload) throw new Error('The saved result changed while annotating. Retry with the current Plot.');
  const previous = readAnnotations(store, scheme, rowId, plotIndex, payload);
  if (JSON.stringify(previous.annotations) === JSON.stringify(annotations)) return previous;
  mkdirSync(path.join(store.file('results/web'), 'annotations'), { recursive: true });
  const file = path.join(store.file('results/web/annotations'), filename(scheme, rowId, plotIndex));
  const saved = { payload, revision: randomUUID(), annotations }, temporary = `${file}.${saved.revision}.tmp`;
  writeFileSync(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
  try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
  cache.delete(file);
  return { revision: saved.revision, annotations };
}
