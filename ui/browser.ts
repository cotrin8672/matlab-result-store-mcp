import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';

type Key = { name: string; class: string | null; storage: string | null };
type Scheme = { id: string; keys: Key[]; values: string[]; count: number; plots: { index: number; name: string }[] | null };
type Catalog = { schemes: Scheme[]; plot_catalog: string };
type Row = { row_id: string; keys: Record<string, unknown> };
type Page = { rows: Row[]; total: number };
type Artifact = Row & { scheme: string; plot_index: number; plot_name: string; plotly_uri: string; payload: string };
type Plot = { data: unknown[]; layout: Record<string, unknown>; frames?: unknown[] };
declare const Plotly: {
  react(element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>): Promise<void>;
  purge(element: HTMLElement): void;
  addFrames(element: HTMLElement, frames: unknown[]): Promise<void>;
};
declare const MathJax: { startup: { promise: Promise<void> } };

const app = new App({ name: 'Result Store browser', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const schemeSelect = element<HTMLSelectElement>('scheme');
const plotSelect = element<HTMLSelectElement>('plot-choice');
const status = element('status');
const ask = element<HTMLButtonElement>('ask');
let catalog: Catalog;
let offset = 0;
let selected: Artifact | undefined;
let request = 0;
let filters: { key: Key; op: HTMLSelectElement; value: HTMLInputElement; upper: HTMLInputElement }[] = [];

function showError(error: unknown) {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.dataset.error = 'true';
}
function note(text: string) { status.textContent = text; status.dataset.error = 'false'; }
function data<T>(reply: CallToolResult): T {
  if (reply.isError) throw new Error(reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  return reply.structuredContent as T;
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return data<T>(await app.callServerTool({ name, arguments: args }));
}
function currentScheme() { return catalog.schemes.find(s => s.id === schemeSelect.value)!; }
function format(value: unknown): string {
  if (value === null) return '不明';
  if (typeof value === 'object' && value && 'shape' in value) return `[${(value.shape as number[]).join(' × ')}]`;
  return String(value);
}
function option(value: string, text: string) { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }

function changeScheme(id?: string) {
  if (id) schemeSelect.value = id;
  const scheme = currentScheme();
  const form = element('filters'); form.replaceChildren(); filters = [];
  for (const key of scheme.keys.filter(k => k.storage !== 'npy' && k.storage !== 'mixed')) {
    const row = document.createElement('div'); row.className = 'filter';
    const label = document.createElement('label'); label.textContent = key.name;
    const op = document.createElement('select'); op.setAttribute('aria-label', `${key.name}の条件`);
    const text = key.class === 'string' || key.class === 'char';
    const choices = text ? [['eq', '一致'], ['ne', '除外'], ['contains', '含む'], ['is_null', '不明']] : [['eq', '='], ['between', '範囲'], ['gte', '以上'], ['lte', '以下'], ['is_null', '不明']];
    op.append(...choices.map(([v, t]) => option(v, t)));
    const value = document.createElement('input'); value.placeholder = '指定なし'; value.setAttribute('aria-label', key.name);
    const upper = document.createElement('input'); upper.className = 'range'; upper.placeholder = '上限'; upper.hidden = true; upper.setAttribute('aria-label', `${key.name}の上限`);
    op.onchange = () => { upper.hidden = op.value !== 'between'; value.hidden = op.value === 'is_null'; };
    row.append(label, op, value, upper); form.append(row); filters.push({ key, op, value, upper });
  }
  plotSelect.replaceChildren(...(scheme.plots ?? []).map(p => option(String(p.index), p.name)));
  plotSelect.disabled = !scheme.plots?.length;
  offset = 0;
}

function queryFilters() {
  function parse(value: string, key: Key) {
    if (key.class === 'string' || key.class === 'char') return value;
    if (key.class === 'logical') {
      if (!['true', 'false', '1', '0'].includes(value)) throw new Error(`${key.name}にはtrue/falseを入力してください。`);
      return value === 'true' || value === '1';
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${key.name}には数値を入力してください。`);
    return number;
  }
  return filters.flatMap(f => {
    if (f.op.value === 'is_null') return [{ key: f.key.name, op: 'is_null' }];
    if (f.value.value === '') return [];
    if (f.op.value === 'between' && !f.upper.value) throw new Error(`${f.key.name}の上限を入力してください。`);
    return [{ key: f.key.name, op: f.op.value, value: f.op.value === 'between' ? [parse(f.value.value, f.key), parse(f.upper.value, f.key)] : parse(f.value.value, f.key) }];
  });
}

async function search() {
  const token = ++request;
  selected = undefined; ask.disabled = true;
  Plotly.purge(element('plot'));
  element('conditions').textContent = '結果を選択してください。'; element('details').textContent = '';
  await app.updateModelContext({ content: [], structuredContent: {} });
  note('検索中…');
  const scheme = currentScheme();
  const page = await call<Page>('search_results', { scheme: scheme.id, filters: queryFilters(), offset, limit: 25 });
  if (token !== request) return;
  const header = document.createElement('tr');
  for (const name of ['RowId', ...scheme.keys.map(k => k.name)]) { const th = document.createElement('th'); th.textContent = name; header.append(th); }
  element('head').replaceChildren(header);
  element('rows').replaceChildren(...page.rows.map(row => {
    const tr = document.createElement('tr'); tr.dataset.row = row.row_id;
    const cell = document.createElement('td'); const button = document.createElement('button'); button.textContent = row.row_id; button.setAttribute('aria-label', `結果${row.row_id}を表示`);
    button.onclick = () => void select(row.row_id).catch(showError); cell.append(button); tr.append(cell);
    for (const key of scheme.keys) { const td = document.createElement('td'); td.textContent = format(row.keys[key.name]); tr.append(td); }
    return tr;
  }));
  element('page').textContent = page.total ? `${offset + 1}–${Math.min(offset + 25, page.total)} / ${page.total}件` : '0件';
  element<HTMLButtonElement>('previous').disabled = offset === 0;
  element<HTMLButtonElement>('next').disabled = offset + 25 >= page.total;
  note(catalog.plot_catalog === 'ready' ? '' : 'Plot一覧の出力が必要です。MATLABで resultstore.exportCatalog(root) を実行してください。');
}

async function display(reply: CallToolResult, token: number) {
  const artifact = data<Artifact>(reply);
  const resource = await app.readServerResource({ uri: artifact.plotly_uri });
  const content = resource.contents.find(c => 'text' in c);
  if (!content || !('text' in content)) throw new Error('Plotデータを読み取れませんでした。');
  const plot = JSON.parse(content.text) as Plot;
  await MathJax.startup.promise;
  if (token !== request) return;
  delete plot.layout.width; delete plot.layout.height; plot.layout.autosize = true;
  await Plotly.react(element('plot'), plot.data, plot.layout, { responsive: true, displaylogo: false, showLink: false });
  if (plot.frames?.length) await Plotly.addFrames(element('plot'), plot.frames);
  if (token !== request) return;
  selected = artifact;
  element('conditions').textContent = `${artifact.scheme} / RowId ${artifact.row_id}\n${JSON.stringify(artifact.keys)}`;
  const image = reply.content.find(c => c.type === 'image');
  await app.updateModelContext({
    content: [{ type: 'text', text: `選択した保存結果: ${JSON.stringify(artifact)}` }, ...(image ? [image] : [])],
    structuredContent: { selection: artifact },
  });
  if (token !== request) return;
  ask.disabled = false; note('');
}

async function select(rowId: string, reply?: CallToolResult) {
  const token = ++request;
  selected = undefined; ask.disabled = true; note('Plotを読み込み中…');
  Plotly.purge(element('plot'));
  element('conditions').textContent = `${currentScheme().id} / RowId ${rowId}`;
  element('details').textContent = '';
  await app.updateModelContext({ content: [], structuredContent: {} });
  document.querySelectorAll<HTMLTableRowElement>('#rows tr').forEach(tr => tr.setAttribute('aria-selected', String(tr.dataset.row === rowId)));
  const args = { scheme: currentScheme().id, row_id: rowId, plot_index: Number(plotSelect.value || 1) };
  const details = await call<{ values: Record<string, { class?: string; shape?: number[] }> }>('get_result', { scheme: args.scheme, row_id: rowId });
  if (token !== request) return;
  element('details').textContent = Object.entries(details.values).map(([name, v]) => `${name}: ${v.class ?? '?'} [${v.shape?.join(' × ') ?? '?'}]`).join(' · ');
  await display(reply ?? await app.callServerTool({ name: 'render_plot', arguments: args }), token);
}

async function accept(reply: CallToolResult) {
  const payload = data<Partial<Catalog & Artifact>>(reply);
  if (payload.schemes) {
    const old = schemeSelect.value;
    catalog = payload as Catalog;
    schemeSelect.replaceChildren(...catalog.schemes.map(s => option(s.id, `${s.id} (${s.count})`)));
    if (!catalog.schemes.length) { note('登録済みのSchemeがありません。'); return; }
    changeScheme(catalog.schemes.some(s => s.id === old) ? old : undefined);
    await search();
  } else if (payload.plotly_uri && payload.scheme && payload.row_id) {
    if (!catalog) await accept(await app.callServerTool({ name: 'list_schemes', arguments: {} }));
    changeScheme(payload.scheme); plotSelect.value = String(payload.plot_index);
    await search(); await select(payload.row_id, reply);
  }
}

function submitSearch() { offset = 0; void search().catch(showError); }
element('search').onclick = submitSearch;
element<HTMLFormElement>('query').onsubmit = event => { event.preventDefault(); submitSearch(); };
schemeSelect.onchange = () => { changeScheme(); void search().catch(showError); };
plotSelect.onchange = () => { if (selected) void select(selected.row_id).catch(showError); };
element('refresh').onclick = () => void app.callServerTool({ name: 'list_schemes', arguments: {} }).then(accept).catch(showError);
element('previous').onclick = () => { offset -= 25; void search().catch(showError); };
element('next').onclick = () => { offset += 25; void search().catch(showError); };
ask.onclick = () => void (async () => {
  if (!selected) return;
  const question = element<HTMLTextAreaElement>('question').value.trim() || 'この結果の特徴を説明して。';
  const text = `${question}\n\nScheme: ${selected.scheme}\nRowId: ${selected.row_id}\nPlot: ${selected.plot_name}\n条件: ${JSON.stringify(selected.keys)}`;
  // OpenAI's draft-message extension is passed through the standard Apps bridge.
  const message = { role: 'user' as const, content: [{ type: 'text' as const, text }], _meta: { 'openai/message': { send: false } } };
  const response = await app.sendMessage(message);
  if (response.isError) throw new Error('会話に渡せませんでした。');
  note('選択した結果を会話に渡しました。');
})().catch(showError);

function theme(context: ReturnType<App['getHostContext']>) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.addEventListener('hostcontextchanged', theme);
app.ontoolresult = reply => void accept(reply).catch(showError);
await app.connect();
theme(app.getHostContext());
