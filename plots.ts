export type Plot = { data: Record<string, unknown>[]; layout: Record<string, unknown>; frames?: unknown[] };
export type PlotUpdate = {
  revision: string; base_revision?: string; plot?: Plot;
  traces?: { index: number; values: Record<string, unknown> }[];
  layout?: Record<string, unknown>;
};
export type PlotState = { revision: string; plot: Plot };

export function applyPlotUpdate(current: PlotState | undefined, update: PlotUpdate): PlotState {
  if (update.plot) return { revision: update.revision, plot: update.plot };
  if (!current || current.revision !== update.base_revision) throw new Error('Plot revision changed; request a full Plot.');
  const data = current.plot.data.slice();
  for (const trace of update.traces ?? []) {
    if (!data[trace.index]) throw new Error('Invalid incremental Plot trace.');
    data[trace.index] = { ...data[trace.index], ...trace.values };
  }
  return { revision: update.revision, plot: { data, layout: { ...current.plot.layout, ...update.layout } } };
}
