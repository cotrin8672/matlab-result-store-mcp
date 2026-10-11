import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { McpServer, ResourceTemplate, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { ResultStore, jsonSafe } from './store.ts';

export function configuredRoot(): string {
  const arg = process.argv[2];
  if (arg && !arg.startsWith('--')) return arg;
  if (process.env.RESULT_STORE_ROOT) return process.env.RESULT_STORE_ROOT;
  const config = path.join(process.env.PLUGIN_DATA ?? import.meta.dirname, 'store.local.json');
  if (existsSync(config)) return JSON.parse(readFileSync(config, 'utf8')).root;
  throw new Error('Supply a Store project root as the first argument, RESULT_STORE_ROOT, or root in store.local.json.');
}

export function createServer(root: string): McpServer {
  const store = new ResultStore(root);
  const server = new McpServer({ name: 'matlab-result-store', version: '0.1.0' });
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

  registerAppResource(server, 'Result Store browser', uiUri, {}, async () => ({
    contents: [{ uri: uiUri, mimeType: RESOURCE_MIME_TYPE,
      text: readFileSync(new URL('./dist/browser.html', import.meta.url), 'utf8'),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  }));

  registerAppTool(server, 'list_schemes', {
    title: '保存結果を開く',
    description: 'List active Schemes, Keys, Values, registered Plots and record counts, and open the graphical Result Store browser. A missing/stale Plot catalog needs resultstore.exportCatalog(root) in an existing MATLAB session.',
    inputSchema: z.object({}), annotations,
    _meta: { ui: { resourceUri: uiUri, visibility: ['app', 'model'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, async () => result(store.listSchemes()));

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
  }, async a => result(store.search(a.scheme, a.filters, a.limit, a.offset, a.sort_key, a.descending, a.parameters, a.selected_row_id)));

  server.registerTool('list_candidates', {
    description: 'Read paginated distinct saved Key values after Fixed filters, sorted as in the MATLAB GUI (NULL last). No MAT payloads are loaded. Pass each returned value object directly to search_results for exact scalar/array equality or membership. ordered excludes NULL for range controls. locate returns each requested value and its zero-based candidate index; nearest snaps missing numeric values to the closest saved value.',
    inputSchema: z.object({
      scheme, key: z.string(), filters, ordered: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
      locate: z.array(queryValue).default([]), nearest: z.boolean().default(false),
    }), annotations,
  }, async a => result(store.candidates(a.scheme, a.key, a.filters, a.ordered, a.limit, a.offset, a.locate, a.nearest)));

  server.registerTool('get_result', {
    description: 'Read one result and Value metadata from MATLAB v7.3/HDF5 without MATLAB. Arrays are returned only when named in include_values. Complex arrays have separate real/imag flat arrays, in MATLAB column-major order. Slice indices are ZERO-BASED in MATLAB dimension order; count is the number of elements per dimension. NaN/Inf and 64-bit integers are strings to preserve their meaning.',
    inputSchema: z.object({
      scheme, row_id: rowId,
      include_values: z.array(z.string()).default([]),
      slice: z.object({ start: z.array(z.number().int().min(0)), count: z.array(z.number().int().min(1)) }).optional(),
      max_elements: z.number().int().min(1).max(16384).default(4096),
    }), annotations,
  }, async a => result(await store.getResult(a.scheme, a.row_id, a.include_values, a.slice, a.max_elements)));

  registerAppTool(server, 'render_plot', {
    description: 'Return the PNG preview of an existing registered Plot, its parameter conditions, and MCP resource links to interactive offline HTML and Plotly JSON. Uses fig2plotly exports; never starts MATLAB. Missing/stale exports must be regenerated with resultstore.exportPlot in an existing MATLAB session. PNG is the original MATLAB Figure; HTML is its fig2plotly conversion.',
    inputSchema: z.object({ scheme, row_id: rowId, plot_index: plotIndex }), annotations,
    _meta: { ui: { resourceUri: uiUri, visibility: ['app', 'model'] } },
  }, async a => {
    const artifact = store.plotArtifact(a.scheme, a.row_id, a.plot_index);
    const base = `result-store://plots/${encodeURIComponent(a.scheme)}/${a.row_id}/${a.plot_index}`;
    const { folder, ...metadata } = artifact;
    const reply = result({ ...metadata, html_uri: `${base}/plot.html`, plotly_uri: `${base}/plot.json` });
    return { ...reply, content: [
      ...reply.content,
      { type: 'image' as const, mimeType: 'image/png', data: readFileSync(store.file(`${folder}/preview.png`)).toString('base64') },
      { type: 'resource_link' as const, uri: `${base}/plot.html`, name: 'Interactive Plot', mimeType: 'text/html' },
      { type: 'resource_link' as const, uri: `${base}/plot.json`, name: 'Plotly data/layout', mimeType: 'application/json' },
    ] };
  });

  server.registerResource('plot-artifact', new ResourceTemplate('result-store://plots/{scheme}/{rowId}/{plotIndex}/{file}', { list: undefined }), {
    description: 'Interactive HTML or Plotly JSON for an exported registered Plot.',
  }, async (uri, vars) => {
    if (typeof vars.scheme !== 'string' || typeof vars.rowId !== 'string' || typeof vars.plotIndex !== 'string' || typeof vars.file !== 'string') throw new Error('Invalid Plot resource URI.');
    if (!['plot.html', 'plot.json'].includes(vars.file) || !/^[1-9]\d*$/.test(vars.plotIndex)) throw new Error('Unknown Plot resource.');
    const artifact = store.plotArtifact(vars.scheme, vars.rowId, Number(vars.plotIndex));
    return { contents: [{ uri: uri.href, mimeType: vars.file === 'plot.html' ? 'text/html' : 'application/json', text: readFileSync(store.file(`${artifact.folder}/${vars.file}`), 'utf8') }] };
  });

  server.server.onclose = () => store.db.close();
  return server;
}

export function httpHandler(root: string) {
  return toNodeHandler(createMcpHandler(() => createServer(root)));
}

if (import.meta.main) {
  const root = configuredRoot();
  const httpIndex = process.argv.indexOf('--http');
  if (httpIndex >= 0) {
    const port = Number(process.argv[httpIndex + 1] ?? 8732);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port.');
    const handler = httpHandler(root);
    const host = localhostHostValidation(), origin = localhostOriginValidation();
    createHttpServer(async (req, res) => {
      if (!host(req, res) || !origin(req, res)) return;
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      await handler(req, res);
    }).listen(port, '127.0.0.1', () => console.error(`MCP: http://127.0.0.1:${port}/mcp`));
  } else await serveStdio(() => createServer(root));
}
