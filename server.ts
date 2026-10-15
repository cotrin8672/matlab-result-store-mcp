import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { McpServer, ResourceTemplate, createMcpHandler, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ResultStore, jsonSafe } from './store.ts';
import { configuredRoot } from './config.ts';
import { livePlots } from './live.ts';
import { annotationLayout, validateAnnotations, type Plot } from './plots.ts';
import { annotationsSchema, readAnnotations, writeAnnotations } from './annotations.ts';
import { readBrowserState, showInBrowser } from './browser.ts';
import { matlabJobs } from './jobs.ts';
import { JobEvents, jobOwner } from './events.ts';
import { plotCache } from './cache.ts';
import { PlotPins } from './pins.ts';
import { copyPlot } from './clipboard.ts';
export { configuredRoot } from './config.ts';

function plotHtml(plot: Plot) {
  const assets = ['node_modules/mathjax/es5/tex-svg-full.js', 'node_modules/plotly.js-dist-min/plotly.min.js']
    .map(file => `<script>${readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll(/<\/script/gi, '<\\/script')}</script>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>html,body,#plot{margin:0;width:100%;height:100%}</style><script>window.MathJax={svg:{fontCache:'local'},startup:{typeset:false}};</script>${assets}<div id="plot"></div><script>const plot=${JSON.stringify(plot).replaceAll('<', '\\u003c')};MathJax.startup.promise.then(async()=>{await Plotly.react('plot',plot.data,plot.layout,{responsive:true,displaylogo:false});if(plot.frames?.length)await Plotly.addFrames('plot',plot.frames);});</script>`;
}

export function createServer(root?: string): McpServer {
  const stores = new Map<string, ResultStore>();
  const getStore = (directory?: string) => {
    const folder = realpathSync(directory ?? root ?? configuredRoot());
    let store = stores.get(folder);
    if (!store) {
      if (!existsSync(path.join(folder, 'results', 'store.sqlite'))) throw new Error(`No results/store.sqlite in ${folder}. Choose a saved-result directory from list_stores.`);
      store = new ResultStore(folder); stores.set(folder, store);
    }
    return store;
  };
  const browserRoot = () => realpathSync(root ?? configuredRoot(true) ?? process.cwd());
  const browserScope = (context: ServerContext) => {
    const meta = context.mcpReq._meta, hosted = meta?.['x-codex-turn-metadata'] as Record<string, unknown> | undefined;
    const thread = [meta?.thread_id, meta?.threadId, meta?.['openai/session'], hosted?.thread_id, hosted?.chatgpt_conversation_id]
      .find(value => typeof value === 'string' && value.length);
    return thread ? createHash('sha256').update(JSON.stringify([jobOwner(context), thread])).digest('hex') : undefined;
  };
  const browserUri = (context: ServerContext) => {
    const scope = browserScope(context);
    return scope ? `result-store://browser/${scope}/state` : 'result-store://browser/state';
  };
  const server = new McpServer({ name: 'matlab-result-store', version: '0.5.6' }, {
    cacheHints: { 'server/discover': { ttlMs: 300000, cacheScope: 'private' }, 'tools/list': { ttlMs: 300000, cacheScope: 'private' } },
  });
  const getJobs = (directory?: string) => matlabJobs(getStore(directory).root);
  JobEvents.register(server, directory => getJobs(directory).events);
  const uiUri = 'ui://result-store/browser-v0.5.4.html';
  const pins = new PlotPins();
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const directory = z.string().min(1).refine(path.isAbsolute, 'directory must be an absolute path.').optional()
    .describe('Absolute directory containing results/store.sqlite. Omit to use the configured default. Does not change other conversations or the global configuration.');
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
  function uiResult(reply: CallToolResult) {
    // shortcut: desktop tab reuse relies on widgetSessionId, revisit when a public single-panel API is available.
    return { ...reply, _meta: { ...reply._meta, 'openai/widgetSessionId': 'matlab-results' } };
  }
  const plotUri = (store: ResultStore, id: string, row: string, index: number, file: string) =>
    `result-store://plots/${encodeURIComponent(id)}/${row}/${index}/${file}?directory=${encodeURIComponent(store.root)}`;
  const jobResult = (folder: string | undefined, data: Record<string, unknown>) => {
    const store = getStore(folder), uri = typeof data.result_uri === 'string' ? new URL(data.result_uri) : undefined;
    uri?.searchParams.set('directory', store.root);
    return result({ ...data, directory: store.root, ...(uri ? { result_uri: uri.href } : {}) });
  };
  const jobId = z.string().uuid().describe('Job ID returned by a MATLAB run tool or list_matlab_jobs.');
  const runInput = z.object({
    directory,
    code: z.string().min(1).max(1000000).describe('MATLAB code to execute in a fresh function workspace. root is the selected Store directory. Use run_matlab_worker for existing scripts via run(fullfile(root,"script.m")); R2024a background threads do not support run, cd or clearvars. Execution has the same file/system access as MATLAB.'),
    outputs: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/)).max(100).default([])
      .refine(names => new Set(names).size === names.length, 'Output variable names must be unique.')
      .describe('Variables to retain as a v7.3 MAT file. Prefer scalar diagnostics or the specific arrays needed for analysis; [] retains only the console log.'),
  });
  const executeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  server.registerTool('run_matlab_background', {
    description: 'Start MATLAB code asynchronously with parfeval(backgroundPool) inside the shared MCP MATLAB. Return a Job ID immediately and leave the main thread available for registered Plots. Thread-compatible functions only; graphics, unsupported MEX, run/cd/clearvars in R2024a require the explicit run_matlab_worker tool. No automatic retry or backend switch. Retrieve status, logs, errors and selected outputs with get_matlab_job. MCP Events subscribers receive matlab.job.finished.',
    inputSchema: runInput, annotations: executeAnnotations,
  }, async (a, context) => jobResult(a.directory, await getJobs(a.directory).start('background', a.code, a.outputs, jobOwner(context))));
  server.registerTool('run_matlab_worker', {
    description: 'Start MATLAB code asynchronously on one reusable Processes pool worker, separate from the Plot main thread. Requires Parallel Computing Toolbox; the single process worker starts only when needed, with an initial pool startup delay. Use for graphics or MEX/functions unsupported by backgroundPool. For parfor/spmd or scripts that launch parallel jobs, use run_matlab_parallel instead; process workers cannot submit local cluster jobs. Return a Job ID immediately. Retrieve status/logs/errors/outputs with get_matlab_job or subscribe to matlab.job.finished. Execution does not use an interactive calculation session.',
    inputSchema: runInput, annotations: executeAnnotations,
  }, async (a, context) => jobResult(a.directory, await getJobs(a.directory).start('worker', a.code, a.outputs, jobOwner(context))));
  server.registerTool('run_matlab_parallel', {
    description: 'Start an asynchronous MATLAB batch Job from the shared client MATLAB, with an explicit Processes pool for parfor or spmd in existing scripts. workers is the parfor pool size; MATLAB also starts one batch driver process. The Plot main thread remains available after submission. Requires Parallel Computing Toolbox and capacity in the Processes profile. Do not call batch/parcluster from run_matlab_worker or run_matlab_background. Retrieve logs, errors and outputs with get_matlab_job; cancel with cancel_matlab_job or subscribe to matlab.job.finished.',
    inputSchema: runInput.extend({ workers: z.number().int().min(1).max(128).describe('Number of Processes pool workers for parfor/spmd. One additional batch driver is required; choose within available CPU/memory and the cluster profile capacity.') }),
    annotations: executeAnnotations,
  }, async (a, context) => jobResult(a.directory, await getJobs(a.directory).start('parallel', a.code, a.outputs, jobOwner(context), a.workers)));
  server.registerTool('get_matlab_job', {
    description: 'Read an asynchronous MATLAB Job without waiting for it to finish. Returns queued/running/succeeded/failed/cancelled, console log (last 65,536 characters), error identifier/stack and output metadata. Read selected numeric/logical variables with include_values; arrays use the same exact complex/64-bit representation and zero-based MATLAB-dimension slicing as get_result. Jobs and output files survive MCP reconnects; results are kept in the OS temporary folder.',
    inputSchema: z.object({ directory, job_id: jobId, include_values: z.array(z.string()).default([]),
      slice: z.object({ start: z.array(z.number().int().min(0)), count: z.array(z.number().int().min(1)) }).optional(),
      max_elements: z.number().int().min(1).max(16384).default(4096) }), annotations,
  }, async (a, context) => jobResult(a.directory, await getJobs(a.directory).get(a.job_id, jobOwner(context), a.include_values, a.slice, a.max_elements)));
  server.registerTool('list_matlab_jobs', {
    description: 'List recent asynchronous MATLAB Jobs for this Store, including Jobs started through another MCP connection. Does not start MATLAB or load output arrays.',
    inputSchema: z.object({ directory, limit: z.number().int().min(1).max(100).default(20) }), annotations,
  }, async (a, context) => jobResult(a.directory, getJobs(a.directory).list(jobOwner(context), a.limit)));
  server.registerTool('cancel_matlab_job', {
    description: 'Request cancellation of a MATLAB Future or parallel batch Job, including a queued Job. cancel_requested means the request is pending; get_matlab_job confirms the final state. Already finished Jobs are unchanged. Code that has already written files is not rolled back.',
    inputSchema: z.object({ directory, job_id: jobId }), annotations: { ...executeAnnotations, idempotentHint: true },
  }, async (a, context) => jobResult(a.directory, getJobs(a.directory).cancel(a.job_id, jobOwner(context))));
  const readJob: Parameters<typeof server.registerResource>[3] = async (uri, vars, context) => {
    const id = jobId.parse(vars.jobId), folder = directory.parse(uri.searchParams.get('directory') ?? undefined);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await getJobs(folder).get(id, jobOwner(context))) }] };
  };
  server.registerResource('matlab-job', new ResourceTemplate('matlab-results://jobs/{jobId}{?directory}', { list: undefined }), {
    description: 'MATLAB Job status, console log, errors and output variable metadata.', mimeType: 'application/json',
  }, readJob);
  server.registerResource('matlab-job-default', new ResourceTemplate('matlab-results://jobs/{jobId}', { list: undefined }), {}, readJob);
  async function listSchemes(folder?: string) {
    if (!folder && !root && !configuredRoot(true)) return { root: '', directory: '', plot_catalog: 'missing', schemes: [] };
    const store = getStore(folder);
    if (store.catalog().status !== 'ready') {
      const native = livePlots(store.root), session = await native.session();
      if (session) await native.refreshCatalog(session);
    }
    return { ...store.listSchemes(), directory: store.root };
  }
  async function plotBackend(store: ResultStore, id: string, rowId: string, plotIndex: number, refresh = false) {
    const row = store.record(store.scheme(id), rowId);
    if (!refresh) {
      const cached = plotCache(store.root).get(id, rowId, plotIndex, String(row.__store_payload));
      if (cached) return { cached };
    }
    const native = livePlots(store.root), session = await native.session(false);
    if (session) return { native, session };
    if (!refresh) {
      try { return { artifact: store.plotArtifact(id, rowId, plotIndex) }; }
      catch { /* Missing or stale exports are rendered by the shared worker. */ }
    }
    return { native, session: (await native.session())! };
  }
  async function readPlot(store: ResultStore, id: string, rowId: string, plotIndex: number): Promise<{ plot: Plot; payload: string; plot_name: string; revision: string; htmlPath?: string }> {
    const backend = await plotBackend(store, id, rowId, plotIndex);
    if (backend.cached) return backend.cached;
    if (backend.session) {
      const { native, session } = backend;
      const rendered = await native.render(session, id, rowId, plotIndex, false, false);
      if (rendered.payload !== store.record(store.scheme(id), rowId).__store_payload) throw new Error('The saved result changed during rendering. Refresh the Plot.');
      plotCache(store.root).put(rendered);
      return { plot: rendered.plot, payload: rendered.payload, plot_name: rendered.plot_name, revision: rendered.revision };
    }
    const artifact = backend.artifact!;
    return { plot: JSON.parse(readFileSync(store.file(`${artifact.folder}/plot.json`), 'utf8')), payload: artifact.payload, plot_name: artifact.plot_name, htmlPath: artifact.html_path,
      revision: artifact.payload + ':' + statSync(store.file(`${artifact.folder}/plot.json`)).mtimeMs };
  }

  registerAppResource(server, 'MatlabResults', uiUri, {}, async () => ({
    contents: [{ uri: uiUri, mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(new URL('./dist/browser.html', import.meta.url), 'utf8'),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] },
      },
    }],
  }));

  registerAppTool(server, 'open_browser', {
    title: 'MatlabResults',
    description: 'Open MatlabResults for browsing saved results and pinned comparisons. render_plot also opens this same UI when displaying a result. Specify directory to choose another Store without changing the default configuration.',
    inputSchema: z.object({ directory }), annotations,
    _meta: { ui: { resourceUri: uiUri, visibility: ['app', 'model'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, async (a, context) => uiResult(result({ ...await listSchemes(a.directory), browser_state_uri: browserUri(context) })));

  server.registerTool('copy_plot', {
    description: 'Copy the displayed Plot as SVG with a PNG fallback to the local Windows clipboard. Used only by the explicit Copy button in MatlabResults.',
    inputSchema: z.object({ svg: z.string().min(1).max(20 * 1024 * 1024), png: z.string().min(1).max(20 * 1024 * 1024) }),
    annotations: { ...annotations, readOnlyHint: false }, _meta: { ui: { visibility: ['app'] } },
  }, async a => result(await copyPlot(a.svg, a.png)));

  server.registerResource('browser-state', 'result-store://browser/state', {
    description: 'Latest completed model-requested Plot for the existing browser.', mimeType: 'application/json',
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(readBrowserState(browserRoot())) }] }));
  server.registerResource('browser-state-scoped', new ResourceTemplate('result-store://browser/{scope}/state', { list: undefined }), {
    description: 'Latest completed Plot selection in this conversation.', mimeType: 'application/json',
  }, async (uri, vars) => {
    const scope = z.string().regex(/^[a-f0-9]{64}$/).parse(vars.scope);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(readBrowserState(browserRoot(), scope)) }] };
  });

  server.registerTool('list_stores', {
    description: 'List saved-result directories at directory and its immediate children, identified by results/store.sqlite. Accepts any project directory. Does not start MATLAB.',
    inputSchema: z.object({ directory }), annotations,
  }, async a => {
    const initial = root ?? configuredRoot(true) ?? process.cwd();
    const folder = realpathSync(a.directory ?? (existsSync(path.join(initial, 'results', 'store.sqlite')) ? path.dirname(initial) : initial));
    const candidates = [folder, ...readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(folder, entry.name))];
    return result({ directory: folder, stores: candidates.filter(candidate => existsSync(path.join(candidate, 'results', 'store.sqlite')))
      .map(candidate => ({ directory: realpathSync(candidate), name: path.basename(candidate) })) });
  });

  server.registerTool('list_schemes', {
    description: 'List active Schemes, Keys, Values, registered Plots and record counts without opening a browser. A missing/stale Plot catalog is refreshed by one shared dedicated MATLAB Plot worker; calculation sessions are not used.',
    inputSchema: z.object({ directory }), annotations,
  }, async (a, context) => result({ ...await listSchemes(a.directory), browser_state_uri: browserUri(context) }));

  server.registerTool('search_results', {
    description: 'Search saved results with AND conditions without loading MAT payloads. filters define the Fixed result table; optional parameters further restrict matched_total/first_match/selected_matches, as in the MATLAB GUI. Use list_candidates values for exact array Key comparisons. contains is case-sensitive. NULL means an unknown historical Key.',
    inputSchema: z.object({
      directory, scheme,
      filters,
      parameters: filters.describe('Parametric conditions. These affect match statistics, while rows/total remain the Fixed table.'),
      selected_row_id: rowId.optional(),
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      sort_key: z.string().default('RowId'), descending: z.boolean().default(false),
    }), annotations,
  }, async a => { const store = getStore(a.directory); return result({ directory: store.root, ...store.search(a.scheme, a.filters, a.limit, a.offset, a.sort_key, a.descending, a.parameters, a.selected_row_id) }); });

  server.registerTool('list_candidates', {
    description: 'Read paginated distinct saved Key values after Fixed filters, sorted as in the MATLAB GUI (NULL last). No MAT payloads are loaded. Pass each returned value object directly to search_results for exact scalar/array equality or membership. ordered excludes NULL for range controls. locate returns each requested value and its zero-based candidate index; nearest snaps missing numeric values to the closest saved value.',
    inputSchema: z.object({
      directory, scheme, key: z.string(), filters, ordered: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
      locate: z.array(queryValue).default([]), nearest: z.boolean().default(false),
    }), annotations,
  }, async a => { const store = getStore(a.directory); return result({ directory: store.root, ...store.candidates(a.scheme, a.key, a.filters, a.ordered, a.limit, a.offset, a.locate, a.nearest) }); });

  server.registerTool('get_result', {
    description: 'Read one result and Value metadata from MATLAB v7.3/HDF5 without MATLAB. Arrays are returned only when named in include_values. Complex arrays have separate real/imag flat arrays, in MATLAB column-major order. Slice indices are ZERO-BASED in MATLAB dimension order; count is the number of elements per dimension. NaN/Inf and 64-bit integers are strings to preserve their meaning.',
    inputSchema: z.object({
      directory, scheme, row_id: rowId,
      include_values: z.array(z.string()).default([]),
      slice: z.object({ start: z.array(z.number().int().min(0)), count: z.array(z.number().int().min(1)) }).optional(),
      max_elements: z.number().int().min(1).max(16384).default(4096),
    }), annotations,
  }, async a => { const store = getStore(a.directory); return result({ directory: store.root, ...await store.getResult(a.scheme, a.row_id, a.include_values, a.slice, a.max_elements) }); });

  registerAppTool(server, 'render_plot', {
    title: 'MatlabResults',
    description: 'Display a registered Plot in the MatlabResults side panel. This is a UI render tool: calling it shows the completed result, reusing the same panel for consecutive model calls. Choose directory for another Store. Use shared cached Plots even while MATLAB is Busy; otherwise use the shared Plot worker or saved export. include_preview returns the original MATLAB PNG if cached; preview_available=false means only the interactive Plot is available. known_revision enables incremental updates; refresh bypasses cache and reruns the Plot.',
    _meta: { ui: { resourceUri: uiUri, visibility: ['app', 'model'] } },
    inputSchema: z.object({ directory, scheme, row_id: rowId, plot_index: plotIndex,
      include_preview: z.boolean().default(true), known_revision: z.string().optional(), refresh: z.boolean().default(false) }), annotations,
  }, async (a, context) => {
    const store = getStore(a.directory), browserCall = context.mcpReq._meta?.['matlab-results/browser'] === true;
    function completed(reply: CallToolResult, revision: string) {
      if (!browserCall) showInBrowser(browserRoot(), { directory: store.root, scheme: a.scheme, row_id: a.row_id, plot_index: a.plot_index }, 'plot', revision, browserScope(context));
      return uiResult({ ...reply, structuredContent: { ...(reply.structuredContent as Record<string, unknown>), browser_state_uri: browserUri(context) } });
    }
    const backend = await plotBackend(store, a.scheme, a.row_id, a.plot_index, a.refresh);
    const uri = (file: string) => plotUri(store, a.scheme, a.row_id, a.plot_index, file);
    if (backend.cached || backend.session) {
      const scheme = store.scheme(a.scheme);
      const rendered = backend.cached ?? await backend.native!.render(backend.session!, a.scheme, a.row_id, a.plot_index, a.include_preview, a.refresh, a.known_revision);
      const row = store.record(scheme, a.row_id);
      if (rendered.payload !== row.__store_payload) throw new Error('The saved result changed during rendering. Refresh the Plot.');
      if (!backend.cached) plotCache(store.root).put(rendered);
      // Large model replies lose typed metadata in desktop transport; the UI fetches its own incremental data.
      const update = browserCall ? plotCache(store.root).update(rendered, a.known_revision) : undefined;
      const reply = result({ directory: store.root, scheme: a.scheme, ...store.row(scheme, row), plot_index: a.plot_index,
        plot_name: rendered.plot_name, payload: rendered.payload, source: backend.cached ? 'cache' : 'live', revision: rendered.revision,
        preview_available: !!rendered.preview,
        timings: rendered.timings, plot_annotations: readAnnotations(store, a.scheme, a.row_id, a.plot_index, rendered.payload),
        html_uri: uri('plot.html'), plotly_uri: uri('plot.json'), annotations_uri: uri('annotations.json') });
      return completed({ ...reply, ...(update ? { _meta: { plot_update: update } } : {}), content: [
        ...reply.content,
        ...(a.include_preview && rendered.preview ? [{ type: 'image' as const, mimeType: 'image/png', data: rendered.preview }] : []),
        { type: 'resource_link' as const, uri: uri('plot.html'), name: 'Interactive Plot', mimeType: 'text/html' },
        { type: 'resource_link' as const, uri: uri('plot.json'), name: 'Plotly data/layout', mimeType: 'application/json' },
      ] }, rendered.revision);
    }
    const artifact = backend.artifact!;
    const { folder, ...metadata } = artifact;
    const revision = artifact.payload + ':' + statSync(store.file(`${folder}/plot.json`)).mtimeMs;
    const reply = result({ ...metadata, directory: store.root, revision, plot_annotations: readAnnotations(store, a.scheme, a.row_id, a.plot_index, artifact.payload),
      html_uri: uri('plot.html'), plotly_uri: uri('plot.json'), annotations_uri: uri('annotations.json') });
    return completed({ ...reply, content: [
      ...reply.content,
      ...(a.include_preview ? [{ type: 'image' as const, mimeType: 'image/png', data: readFileSync(store.file(`${folder}/preview.png`)).toString('base64') }] : []),
      { type: 'resource_link' as const, uri: uri('plot.html'), name: 'Interactive Plot', mimeType: 'text/html' },
      { type: 'resource_link' as const, uri: uri('plot.json'), name: 'Plotly data/layout', mimeType: 'application/json' },
    ] }, revision);
  });

  server.registerTool('annotate_plot', {
    description: 'Replace the AI annotations on one registered Plot: point_label (x,y,text), xline (x, optional text), or yline (y, optional text). Coordinates are in data units; xaxis/yaxis select Plotly subplot axes (default x/y). Send the full desired annotation list; [] clears AI annotations. Existing MATLAB annotations and data are preserved. Annotations are saved and appear in the existing browser without opening another tab. Read annotations_uri to inspect current annotations.',
    inputSchema: z.object({ directory, scheme, row_id: rowId, plot_index: plotIndex, annotations: annotationsSchema }),
    annotations: { ...annotations, readOnlyHint: false },
  }, async (a, context) => {
    const store = getStore(a.directory), { plot, payload, plot_name } = await readPlot(store, a.scheme, a.row_id, a.plot_index);
    validateAnnotations(plot, a.annotations);
    const saved = writeAnnotations(store, a.scheme, a.row_id, a.plot_index, payload, a.annotations);
    const uri = (file: string) => plotUri(store, a.scheme, a.row_id, a.plot_index, file);
    const scheme = store.scheme(a.scheme), row = store.record(scheme, a.row_id);
    showInBrowser(browserRoot(), { directory: store.root, scheme: a.scheme, row_id: a.row_id, plot_index: a.plot_index }, 'annotations', undefined, browserScope(context));
    return result({ directory: store.root, scheme: a.scheme, ...store.row(scheme, row), plot_index: a.plot_index, plot_name, payload, ...saved,
      annotations_uri: uri('annotations.json'), plotly_uri: uri('plot.json'), html_uri: uri('plot.html') });
  });

  server.registerTool('list_pinned_plots', {
    description: 'List frozen Plot snapshots pinned for comparison across Schemes and Store directories. Each pin includes its original conditions and a plotly_uri resource. Does not load MAT data or contact MATLAB.',
    inputSchema: z.object({}), annotations,
  }, async () => result(pins.list()));
  server.registerTool('pin_plot', {
    description: 'Pin the current registered Plot as an immutable snapshot in the comparison Canvas. Keeps conditions, data and current AI annotations across directory changes and app restarts. Re-pinning the same saved payload is idempotent. known_revision rejects pinning a different revision from the one displayed.',
    inputSchema: z.object({ directory, scheme, row_id: rowId, plot_index: plotIndex, known_revision: z.string().optional() }),
    annotations: { ...annotations, readOnlyHint: false },
  }, async (a, context) => {
    const store = getStore(a.directory), captured = await readPlot(store, a.scheme, a.row_id, a.plot_index);
    if (a.known_revision && a.known_revision !== captured.revision) throw new Error('The Plot changed before pinning. Display the current Plot and pin it again.');
    const spec = store.scheme(a.scheme), row = store.record(spec, a.row_id);
    if (captured.payload !== row.__store_payload) throw new Error('The saved result changed before pinning. Display the current Plot and retry.');
    const snapshot = pins.pin({ ...captured, directory: store.root, scheme: a.scheme, ...store.row(spec, row), plot_index: a.plot_index,
      annotations: readAnnotations(store, a.scheme, a.row_id, a.plot_index, captured.payload).annotations });
    showInBrowser(browserRoot(), undefined, 'pins', undefined, browserScope(context));
    return result(snapshot);
  });
  server.registerTool('unpin_plot', {
    description: 'Remove one frozen snapshot from the comparison Canvas. Saved results and the original Plot are retained.',
    inputSchema: z.object({ pin_id: z.string().regex(/^[a-f0-9]{64}$/) }), annotations: { ...annotations, readOnlyHint: false },
  }, async (a, context) => { const snapshot = pins.unpin(a.pin_id); showInBrowser(browserRoot(), undefined, 'pins', undefined, browserScope(context)); return result(snapshot); });
  server.registerResource('pinned-plot', new ResourceTemplate('result-store://pins/{pinId}/plot.json', { list: undefined }), {
    description: 'Immutable Plotly data/layout of a pinned comparison Plot.', mimeType: 'application/json',
  }, async (uri, vars) => {
    if (typeof vars.pinId !== 'string') throw new Error('Invalid pinned Plot URI.');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(pins.read(vars.pinId).plot) }] };
  });

  const readArtifact: Parameters<typeof server.registerResource>[3] = async (uri, vars) => {
    const store = getStore(directory.parse(uri.searchParams.get('directory') ?? undefined));
    if (typeof vars.scheme !== 'string' || typeof vars.rowId !== 'string' || typeof vars.plotIndex !== 'string' || typeof vars.file !== 'string') throw new Error('Invalid Plot resource URI.');
    if (!['plot.html', 'plot.json', 'annotations.json'].includes(vars.file) || !/^[1-9]\d*$/.test(vars.plotIndex)) throw new Error('Unknown Plot resource.');
    if (vars.file === 'annotations.json') {
      const row = store.record(store.scheme(vars.scheme), vars.rowId);
      return { contents: [{ uri: uri.href, mimeType: 'application/json',
        text: JSON.stringify(readAnnotations(store, vars.scheme, vars.rowId, Number(vars.plotIndex), String(row.__store_payload))) }] };
    }
    const { plot, payload, htmlPath } = await readPlot(store, vars.scheme, vars.rowId, Number(vars.plotIndex));
    const saved = readAnnotations(store, vars.scheme, vars.rowId, Number(vars.plotIndex), payload);
    const annotated = saved.annotations.length ? { ...plot, layout: { ...plot.layout, ...annotationLayout(plot, saved.annotations) } } : plot;
    return { contents: [{ uri: uri.href, mimeType: vars.file === 'plot.html' ? 'text/html' : 'application/json',
      text: vars.file === 'plot.html' ? htmlPath && !saved.annotations.length ? readFileSync(htmlPath, 'utf8') : plotHtml(annotated) : JSON.stringify(annotated) }] };
  };
  server.registerResource('plot-artifact', new ResourceTemplate('result-store://plots/{scheme}/{rowId}/{plotIndex}/{file}{?directory}', { list: undefined }), {
    description: 'Interactive HTML, Plotly JSON or saved AI annotations for a registered Plot in the selected Store.',
  }, readArtifact);
  server.registerResource('plot-artifact-default', new ResourceTemplate('result-store://plots/{scheme}/{rowId}/{plotIndex}/{file}', { list: undefined }), {}, readArtifact);

  server.server.onclose = () => { for (const store of stores.values()) store.db.close(); };
  return server;
}

export function httpHandler(root?: string) {
  if (root) matlabJobs(root);
  return toNodeHandler(createMcpHandler(() => createServer(root)));
}

export async function startServer() {
  const root = configuredRoot(true);
  if (root) matlabJobs(root);
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
