import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { McpServer, ResourceTemplate, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ResultStore, jsonSafe } from './store.ts';
import { configuredRoot } from './config.ts';
import { livePlots } from './live.ts';
import { annotationLayout, validateAnnotations, type Plot } from './plots.ts';
import { annotationsSchema, readAnnotations, writeAnnotations } from './annotations.ts';
export { configuredRoot } from './config.ts';

function plotHtml(plot: Plot) {
  const assets = ['node_modules/mathjax/es5/tex-svg-full.js', 'node_modules/plotly.js-dist-min/plotly.min.js']
    .map(file => `<script>${readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll(/<\/script/gi, '<\\/script')}</script>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>html,body,#plot{margin:0;width:100%;height:100%}</style><script>window.MathJax={svg:{fontCache:'local'},startup:{typeset:false}};</script>${assets}<div id="plot"></div><script>const plot=${JSON.stringify(plot).replaceAll('<', '\\u003c')};MathJax.startup.promise.then(async()=>{await Plotly.react('plot',plot.data,plot.layout,{responsive:true,displaylogo:false});if(plot.frames?.length)await Plotly.addFrames('plot',plot.frames);});</script>`;
}

export function createServer(root?: string): McpServer {
  let store: ResultStore | undefined;
  const getStore = () => store ??= new ResultStore(root ?? configuredRoot());
  const server = new McpServer({ name: 'matlab-result-store', version: '0.2.5' });
  const uiUri = 'ui://result-store/browser.html';
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const scheme = z.string().min(1).describe('Active Scheme ID from list_schemes.');
  const rowId = z.string().regex(/^[1-9]\d*$/).describe('RowId as a decimal string, from search_results.');
  const plotIndex = z.number().int().min(1).default(1).describe('Registered Plot index from list_schemes/get_result.');
  const scalar = z.union([z.number().finite(), z.string(), z.boolean()]);
  const queryValue = z.union([scalar, z.null(), z.object({ candidate: rowId }).describe('Saved Key value from list_candidates, identified by a representative RowId. Preserves arrays and 64-bit integers exactly.')]);
  const filters = z.array(z.object({ key: z.string(), op: z.enum(['eq', 'ne', 'gte', 'lte', 'between', 'in', 'not_in', 'contains', 'is_null', 'false']), value: z.union([queryValue, z.array(queryValue)]).optional() })).default([]);
  function result(data: Record<string, unknown>) {
    const safe = jsonSafe(data) as Record<string, unknown>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(safe) }], structuredContent: safe };
  }
  async function listSchemes() {
    const store = getStore();
    if (store.catalog().status !== 'ready') {
      const native = livePlots(store.root), session = await native.session();
      if (session) await native.refreshCatalog(session);
    }
    return store.listSchemes();
  }
  async function plotBackend(id: string, rowId: string, plotIndex: number, refresh = false) {
    const store = getStore(), native = livePlots(store.root), session = await native.session(false);
    store.record(store.scheme(id), rowId);
    if (session) return { native, session };
    if (!refresh) {
      try { return { artifact: store.plotArtifact(id, rowId, plotIndex) }; }
      catch { /* Missing or stale exports are rendered by the shared worker. */ }
    }
    return { native, session: (await native.session())! };
  }
  async function readPlot(id: string, rowId: string, plotIndex: number): Promise<{ plot: Plot; payload: string; plot_name: string; htmlPath?: string }> {
    const store = getStore(), backend = await plotBackend(id, rowId, plotIndex);
    if (backend.session) {
      const { native, session } = backend;
      const row = store.record(store.scheme(id), rowId);
      let rendered = native.cached(id, rowId, plotIndex);
      if (!rendered || rendered.payload !== row.__store_payload) rendered = await native.render(session, id, rowId, plotIndex, false, false);
      return { plot: rendered.plot, payload: rendered.payload, plot_name: rendered.plot_name };
    }
    const artifact = backend.artifact!;
    return { plot: JSON.parse(readFileSync(store.file(`${artifact.folder}/plot.json`), 'utf8')), payload: artifact.payload, plot_name: artifact.plot_name, htmlPath: artifact.html_path };
  }

  registerAppResource(server, 'Results', uiUri, {}, async () => ({
    contents: [{ uri: uiUri, mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(new URL('./dist/browser.html', import.meta.url), 'utf8'),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  }));

  registerAppTool(server, 'open_browser', {
    title: 'Results',
    description: 'Open the graphical Result Store browser only when the user asks to open it. Reuse an already open browser instead of opening another. For data or Plot retrieval use list_schemes, search_results, get_result and render_plot, which do not open a browser.',
    inputSchema: z.object({}), annotations,
    _meta: { ui: { resourceUri: uiUri, visibility: ['app', 'model'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, async () => result(await listSchemes()));

  server.registerTool('list_schemes', {
    description: 'List active Schemes, Keys, Values, registered Plots and record counts without opening a browser. A missing/stale Plot catalog is refreshed by one shared dedicated MATLAB Plot worker; calculation sessions are not used.',
    inputSchema: z.object({}), annotations,
  }, async () => result(await listSchemes()));

  server.registerTool('search_results', {
    description: 'Search saved results with AND conditions without loading MAT payloads. filters define the Fixed result table; optional parameters further restrict matched_total/first_match/selected_matches, as in the MATLAB GUI. Use list_candidates values for exact array Key comparisons. contains is case-sensitive. NULL means an unknown historical Key.',
    inputSchema: z.object({
      scheme,
      filters,
      parameters: filters.describe('Parametric conditions. These affect match statistics, while rows/total remain the Fixed table.'),
      selected_row_id: rowId.optional(),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      sort_key: z.string().default('RowId'), descending: z.boolean().default(false),
    }), annotations,
  }, async a => result(getStore().search(a.scheme, a.filters, a.limit, a.offset, a.sort_key, a.descending, a.parameters, a.selected_row_id)));

  server.registerTool('list_candidates', {
    description: 'Read paginated distinct saved Key values after Fixed filters, sorted as in the MATLAB GUI (NULL last). No MAT payloads are loaded. Pass each returned value object directly to search_results for exact scalar/array equality or membership. ordered excludes NULL for range controls. locate returns each requested value and its zero-based candidate index; nearest snaps missing numeric values to the closest saved value.',
    inputSchema: z.object({
      scheme, key: z.string(), filters, ordered: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
      locate: z.array(queryValue).default([]), nearest: z.boolean().default(false),
    }), annotations,
  }, async a => result(getStore().candidates(a.scheme, a.key, a.filters, a.ordered, a.limit, a.offset, a.locate, a.nearest)));

  server.registerTool('get_result', {
    description: 'Read one result and Value metadata from MATLAB v7.3/HDF5 without MATLAB. Arrays are returned only when named in include_values. Complex arrays have separate real/imag flat arrays, in MATLAB column-major order. Slice indices are ZERO-BASED in MATLAB dimension order; count is the number of elements per dimension. NaN/Inf and 64-bit integers are strings to preserve their meaning.',
    inputSchema: z.object({
      scheme, row_id: rowId,
      include_values: z.array(z.string()).default([]),
      slice: z.object({ start: z.array(z.number().int().min(0)), count: z.array(z.number().int().min(1)) }).optional(),
      max_elements: z.number().int().min(1).max(16384).default(4096),
    }), annotations,
  }, async a => result(await getStore().getResult(a.scheme, a.row_id, a.include_values, a.slice, a.max_elements)));

  server.registerTool('render_plot', {
    description: 'Render a registered MATLAB Plot through one automatically started shared Plot worker, independent of calculation sessions, or read a saved fig2plotly export. Does not open a browser. include_preview returns the original MATLAB PNG; AI annotations are in plot_annotations, HTML/JSON and the browser image. known_revision enables incremental updates of changed trace fields and axes; refresh reloads the result and reruns the Plot.',
    inputSchema: z.object({ scheme, row_id: rowId, plot_index: plotIndex,
      include_preview: z.boolean().default(true), known_revision: z.string().optional(), refresh: z.boolean().default(false) }), annotations,
  }, async a => {
    const store = getStore();
    const backend = await plotBackend(a.scheme, a.row_id, a.plot_index, a.refresh);
    const base = `result-store://plots/${encodeURIComponent(a.scheme)}/${a.row_id}/${a.plot_index}`;
    if (backend.session) {
      const { native, session } = backend;
      const scheme = store.scheme(a.scheme), row = store.record(scheme, a.row_id);
      const rendered = await native.render(session, a.scheme, a.row_id, a.plot_index, a.include_preview, a.refresh, a.known_revision);
      if (rendered.payload !== row.__store_payload) throw new Error('The saved result changed during rendering. Refresh the Plot.');
      const reply = result({ scheme: a.scheme, ...store.row(scheme, row), plot_index: a.plot_index,
        plot_name: rendered.plot_name, payload: rendered.payload, source: 'live', revision: rendered.revision,
        timings: rendered.timings, plot_annotations: readAnnotations(store, a.scheme, a.row_id, a.plot_index, rendered.payload),
        html_uri: `${base}/plot.html`, plotly_uri: `${base}/plot.json`, annotations_uri: `${base}/annotations.json` });
      return { ...reply, _meta: { plot_update: rendered.update }, content: [
        ...reply.content,
        ...(rendered.preview ? [{ type: 'image' as const, mimeType: 'image/png', data: rendered.preview }] : []),
        { type: 'resource_link' as const, uri: `${base}/plot.html`, name: 'Interactive Plot', mimeType: 'text/html' },
        { type: 'resource_link' as const, uri: `${base}/plot.json`, name: 'Plotly data/layout', mimeType: 'application/json' },
      ] };
    }
    const artifact = backend.artifact!;
    const { folder, ...metadata } = artifact;
    const reply = result({ ...metadata, plot_annotations: readAnnotations(store, a.scheme, a.row_id, a.plot_index, artifact.payload),
      html_uri: `${base}/plot.html`, plotly_uri: `${base}/plot.json`, annotations_uri: `${base}/annotations.json` });
    return { ...reply, content: [
      ...reply.content,
      ...(a.include_preview ? [{ type: 'image' as const, mimeType: 'image/png', data: readFileSync(store.file(`${folder}/preview.png`)).toString('base64') }] : []),
      { type: 'resource_link' as const, uri: `${base}/plot.html`, name: 'Interactive Plot', mimeType: 'text/html' },
      { type: 'resource_link' as const, uri: `${base}/plot.json`, name: 'Plotly data/layout', mimeType: 'application/json' },
    ] };
  });

  server.registerTool('annotate_plot', {
    description: 'Replace the AI annotations on one registered Plot: point_label (x,y,text), xline (x, optional text), or yline (y, optional text). Coordinates are in data units; xaxis/yaxis select Plotly subplot axes (default x/y). Send the full desired annotation list; [] clears AI annotations. Existing MATLAB annotations and data are preserved. Annotations are saved and appear in the existing browser without opening another tab. Read annotations_uri to inspect current annotations.',
    inputSchema: z.object({ scheme, row_id: rowId, plot_index: plotIndex, annotations: annotationsSchema }),
    annotations: { ...annotations, readOnlyHint: false },
  }, async a => {
    const store = getStore(), { plot, payload, plot_name } = await readPlot(a.scheme, a.row_id, a.plot_index);
    validateAnnotations(plot, a.annotations);
    const saved = writeAnnotations(store, a.scheme, a.row_id, a.plot_index, payload, a.annotations);
    const base = `result-store://plots/${encodeURIComponent(a.scheme)}/${a.row_id}/${a.plot_index}`;
    const scheme = store.scheme(a.scheme), row = store.record(scheme, a.row_id);
    return result({ scheme: a.scheme, ...store.row(scheme, row), plot_index: a.plot_index, plot_name, payload, ...saved,
      annotations_uri: `${base}/annotations.json`, plotly_uri: `${base}/plot.json`, html_uri: `${base}/plot.html` });
  });

  server.registerResource('plot-artifact', new ResourceTemplate('result-store://plots/{scheme}/{rowId}/{plotIndex}/{file}', { list: undefined }), {
    description: 'Interactive HTML, Plotly JSON or saved AI annotations for a registered Plot.',
  }, async (uri, vars) => {
    const store = getStore();
    if (typeof vars.scheme !== 'string' || typeof vars.rowId !== 'string' || typeof vars.plotIndex !== 'string' || typeof vars.file !== 'string') throw new Error('Invalid Plot resource URI.');
    if (!['plot.html', 'plot.json', 'annotations.json'].includes(vars.file) || !/^[1-9]\d*$/.test(vars.plotIndex)) throw new Error('Unknown Plot resource.');
    if (vars.file === 'annotations.json') {
      const row = store.record(store.scheme(vars.scheme), vars.rowId);
      return { contents: [{ uri: uri.href, mimeType: 'application/json',
        text: JSON.stringify(readAnnotations(store, vars.scheme, vars.rowId, Number(vars.plotIndex), String(row.__store_payload))) }] };
    }
    const { plot, payload, htmlPath } = await readPlot(vars.scheme, vars.rowId, Number(vars.plotIndex));
    const saved = readAnnotations(store, vars.scheme, vars.rowId, Number(vars.plotIndex), payload);
    const annotated = saved.annotations.length ? { ...plot, layout: { ...plot.layout, ...annotationLayout(plot, saved.annotations) } } : plot;
    return { contents: [{ uri: uri.href, mimeType: vars.file === 'plot.html' ? 'text/html' : 'application/json',
      text: vars.file === 'plot.html' ? htmlPath && !saved.annotations.length ? readFileSync(htmlPath, 'utf8') : plotHtml(annotated) : JSON.stringify(annotated) }] };
  });

  server.server.onclose = () => store?.db.close();
  return server;
}

export function httpHandler(root?: string) {
  return toNodeHandler(createMcpHandler(() => createServer(root)));
}

export async function startServer() {
  const httpIndex = process.argv.indexOf('--http');
  if (httpIndex >= 0) {
    const port = Number(process.argv[httpIndex + 1] ?? 8732);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port.');
    const handler = httpHandler();
    const host = localhostHostValidation(), origin = localhostOriginValidation();
    createHttpServer(async (req, res) => {
      if (!host(req, res) || !origin(req, res)) return;
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      await handler(req, res);
    }).listen(port, '127.0.0.1', () => console.error(`MCP: http://127.0.0.1:${port}/mcp`));
  } else await serveStdio(() => createServer());
}

if (import.meta.main) await startServer();
