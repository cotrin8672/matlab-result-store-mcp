export type Plot = { data: Record<string, unknown>[]; layout: Record<string, unknown>; frames?: unknown[] };
export type PlotUpdate = {
  revision: string; base_revision?: string; plot?: Plot;
  traces?: { index: number; values: Record<string, unknown> }[];
  layout?: Record<string, unknown>;
};
export type PlotState = { revision: string; plot: Plot };
export type PlotAnnotation = { xaxis: string; yaxis: string } & (
  { type: 'point_label'; x: number; y: number; text: string } |
  { type: 'xline'; x: number; text?: string } |
  { type: 'yline'; y: number; text?: string }
);
export type PlotAnnotations = { revision: string; annotations: PlotAnnotation[] };

export function annotationLayout(plot: Plot, items: PlotAnnotation[]) {
  const prefix = 'result-store-ai-';
  const keep = (value: Record<string, unknown>) => !String(value.name ?? '').startsWith(prefix);
  const annotations = ((plot.layout.annotations ?? []) as Record<string, unknown>[]).filter(keep);
  const shapes = ((plot.layout.shapes ?? []) as Record<string, unknown>[]).filter(keep);
  const color = '#d62728';
  for (const [index, item] of items.entries()) {
    const name = `${prefix}${index}`, xref = item.xaxis, yref = item.yaxis;
    const text = item.text?.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const label = { name, text, font: { color, size: 12 }, bgcolor: 'rgba(255,255,255,0.85)' };
    if (item.type === 'point_label') {
      annotations.push({ ...label, x: item.x, y: item.y, xref, yref, showarrow: true, arrowhead: 2, arrowcolor: color, ax: 24, ay: -28 });
    } else if (item.type === 'xline') {
      shapes.push({ name, type: 'line', xref, yref: `${yref} domain`, x0: item.x, x1: item.x, y0: 0, y1: 1, line: { color, width: 1.5, dash: 'dash' } });
      if (text) annotations.push({ ...label, x: item.x, y: 1, xref, yref: `${yref} domain`, showarrow: false, xanchor: 'left', yanchor: 'top' });
    } else {
      shapes.push({ name, type: 'line', xref: `${xref} domain`, yref, x0: 0, x1: 1, y0: item.y, y1: item.y, line: { color, width: 1.5, dash: 'dash' } });
      if (text) annotations.push({ ...label, x: 1, y: item.y, xref: `${xref} domain`, yref, showarrow: false, xanchor: 'right', yanchor: 'bottom' });
    }
  }
  return { annotations, shapes };
}

export function validateAnnotations(plot: Plot, items: PlotAnnotation[]) {
  const exists = (ref: string) => plot.layout[`${ref[0]}axis${ref.slice(1)}`] !== undefined ||
    plot.data.some(trace => (trace[`${ref[0]}axis`] ?? ref[0]) === ref && ref[0] in trace);
  for (const item of items) for (const ref of [item.xaxis, item.yaxis]) {
    if (!exists(ref)) throw new Error(`Plot axis ${ref} does not exist. Check the axes in the Plotly JSON resource.`);
  }
}

export function applyPlotUpdate(current: PlotState | undefined, update: PlotUpdate): PlotState {
  if (update.plot) return { revision: update.revision, plot: update.plot };
  if (!current || current.revision !== update.base_revision) throw new Error('Plot revision changed; request a full Plot.');
  const data = current.plot.data.slice();
  for (const trace of update.traces ?? []) {
    if (!data[trace.index]) throw new Error('Invalid incremental Plot trace.');
    data[trace.index] = { ...data[trace.index], ...trace.values };
  }
  return { revision: update.revision, plot: { ...current.plot, data, layout: { ...current.plot.layout, ...update.layout } } };
}
