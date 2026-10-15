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

export function themedPlotLayout(plot: Plot, items: PlotAnnotation[], colors: { background: string; text: string; grid: string }, height?: number) {
  const annotated = annotationLayout(plot, items);
  const layout: Record<string, unknown> = { ...annotated, paper_bgcolor: colors.background, plot_bgcolor: colors.background,
    'font.color': colors.text, 'title.font.color': colors.text, 'hoverlabel.bgcolor': colors.background, 'hoverlabel.font.color': colors.text,
    annotations: annotated.annotations.map(item => String(item.name ?? '').startsWith('result-store-ai-') ? item
      : { ...item, font: { ...(item.font as object), color: colors.text } }) };
  const fontSize = Number((plot.layout.font as Record<string, unknown> | undefined)?.size) || 12;
  const textHeight = (value: unknown, size: number) => {
    const label: Record<string, unknown> | undefined = typeof value === 'string' ? { text: value } : value as Record<string, unknown> | undefined;
    return label?.text ? String(label.text).split(/<br\s*\/?>|\n/i).length * (Number((label.font as Record<string, unknown> | undefined)?.size) || size) * 1.3 : 0;
  };
  const margin = (plot.layout.margin ?? {}) as Record<string, unknown>;
  const top = Math.max(Number(margin.t ?? 100), textHeight(plot.layout.title, fontSize * 1.4) + 16, 24);
  const bottom = Math.max(Number(margin.b ?? 80), 16);
  layout['margin.t'] = top; layout['margin.b'] = bottom;
  if (textHeight(plot.layout.title, fontSize * 1.4)) {
    layout['title.yref'] = 'container'; layout['title.y'] = 1; layout['title.yanchor'] = 'top'; layout['title.pad.t'] = 8;
  }
  const innerHeight = Math.max(1, (height && Number.isFinite(height) ? height : Number(plot.layout.height) || 450) - top - bottom);
  const rows: { name: string; domain: number[]; xaxis: Record<string, unknown> }[] = [];
  for (const name of Object.keys(plot.layout)) {
    if (/^[xy]axis\d*$/.test(name)) {
      const axis = plot.layout[name] as Record<string, unknown>;
      layout[`${name}.automargin`] = true;
      layout[`${name}.title.standoff`] = Math.max(6, Number((axis.title as Record<string, unknown> | undefined)?.standoff) || 0);
      for (const field of ['color', 'linecolor', 'tickcolor', 'tickfont.color', 'title.font.color']) layout[`${name}.${field}`] = colors.text;
      for (const field of ['gridcolor', 'zerolinecolor']) layout[`${name}.${field}`] = colors.grid;
      if (name.startsWith('y') && !axis.overlaying && Array.isArray(axis.domain) && axis.domain.length === 2) {
        const anchor = typeof axis.anchor === 'string' && /^x\d*$/.test(axis.anchor) ? axis.anchor : `x${name.slice(5)}`;
        rows.push({ name, domain: axis.domain as number[], xaxis: (plot.layout[`xaxis${anchor.slice(1)}`] ?? {}) as Record<string, unknown> });
      }
    } else if (/^legend\d*$/.test(name)) {
      layout[`${name}.bgcolor`] = colors.background;
      layout[`${name}.font.color`] = colors.text;
      layout[`${name}.title.font.color`] = colors.text;
    } else if (/^coloraxis\d*$/.test(name)) {
      layout[`${name}.colorbar.bgcolor`] = colors.background;
      for (const field of ['tickcolor', 'tickfont.color', 'title.font.color', 'outlinecolor']) layout[`${name}.colorbar.${field}`] = colors.text;
    }
  }
  for (const row of rows) {
    const [low, high] = row.domain, xdomain = (row.xaxis.domain ?? [0, 1]) as number[];
    let start = low;
    for (const below of rows) {
      const otherX = (below.xaxis.domain ?? [0, 1]) as number[], edge = below.domain[1];
      if (edge > low + 1e-6 || Math.min(xdomain[1], otherX[1]) <= Math.max(xdomain[0], otherX[0])) continue;
      const tickSize = Number((row.xaxis.tickfont as Record<string, unknown> | undefined)?.size) || fontSize;
      const xlabel = textHeight(row.xaxis.title, fontSize * 1.2);
      const ticks = row.xaxis.showticklabels === false ? 0 : tickSize * 1.3 + 4;
      const standoff = Math.max(6, Number((row.xaxis.title as Record<string, unknown> | undefined)?.standoff) || 0);
      const labels = row.xaxis.side === 'top' ? 0 : ticks + (xlabel ? xlabel + standoff : 0);
      const titles = annotated.annotations.filter(item => item.xref === 'paper' && item.yref === 'paper' && item.yanchor === 'bottom' &&
        Math.abs(Number(item.y) - edge) < 1e-6 && Number(item.x) >= otherX[0] && Number(item.x) <= otherX[1]);
      const gap = labels + Math.max(0, ...titles.map(item => textHeight(item, fontSize))) + 8;
      start = Math.max(start, Math.min(high - 32 / innerHeight, edge + gap / innerHeight));
    }
    // Recompute from saved domains on every resize; paper annotations keep their saved coordinates.
    layout[`${row.name}.domain`] = [start, high];
  }
  return layout;
}

export function themedPlotData(plot: Plot, background: string) {
  const rgb = (value: unknown): number[] | undefined => {
    if (typeof value !== 'string') return;
    if (/^#[\da-f]{3,8}$/i.test(value)) {
      const hex = value.slice(1), full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
      if (full.length === 6 || full.length === 8) return [...[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)), full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1];
    }
    const match = value.match(/^rgba?\(([^)]+)\)$/i);
    if (match) {
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map((part, i) => parseFloat(part) * (part.endsWith('%') ? (i === 3 ? .01 : 2.55) : 1));
      if (parts.length >= 3 && parts.every(Number.isFinite)) return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    if (typeof document !== 'undefined' && CSS.supports('color', value)) {
      const parser = document.createElement('canvas').getContext('2d');
      if (parser) { parser.fillStyle = value; if (parser.fillStyle !== value) return rgb(parser.fillStyle); }
    }
  };
  const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, channel, i) => {
    const c = channel / 255; return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
  const bg = rgb(background), dark = bg !== undefined && luminance(bg) < .2;
  const minimumContrast = 7;
  const visibleColor = (value: unknown) => {
    const original = rgb(value);
    if (!dark || !original || original[3] === 0) return structuredClone(value ?? null);
    const contrast = (mix: number) => {
      const foreground = original.slice(0, 3).map((c, i) => (c + (255 - c) * mix) * original[3] + bg![i] * (1 - original[3]));
      return (luminance(foreground) + .05) / (luminance(bg!) + .05);
    };
    if (contrast(0) >= minimumContrast) return value;
    let low = 0, high = 1;
    for (let i = 0; i < 16; i++) { const middle = (low + high) / 2; if (contrast(middle) < minimumContrast) low = middle; else high = middle; }
    return `rgba(${original.slice(0, 3).map(c => Math.ceil(c + (255 - c) * high)).join(',')},${original[3]})`;
  };
  const line = (trace: Record<string, unknown>) => (trace.line ?? {}) as Record<string, unknown>;
  const marker = (trace: Record<string, unknown>) => (trace.marker ?? {}) as Record<string, unknown>;
  return {
    'line.color': plot.data.map(trace => visibleColor(line(trace).color)),
    'line.width': plot.data.map(trace => dark && Number(line(trace).width) > 0 ? Math.max(2, Number(line(trace).width)) : line(trace).width ?? null),
    'marker.color': plot.data.map(trace => marker(trace).coloraxis ? structuredClone(marker(trace).color ?? null) : visibleColor(marker(trace).color)),
    'marker.line.color': plot.data.map(trace => {
      const edge = (marker(trace).line ?? {}) as Record<string, unknown>;
      return edge.coloraxis ? structuredClone(edge.color ?? null) : visibleColor(edge.color);
    }),
  };
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
