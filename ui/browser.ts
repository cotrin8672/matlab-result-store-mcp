import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { queriesFor, type QueryDefinition, type QueryKind, type QueryValue, type Filter, type Candidate, type Domain } from '../queries.ts';
import { annotationLayout, applyPlotUpdate, type Plot, type PlotAnnotations, type PlotState, type PlotUpdate } from '../plots.ts';

type Key = { name: string; class: string | null; kind: QueryKind };
type Scheme = { id: string; keys: Key[]; values: string[]; count: number; plots: { index: number; name: string }[] | null };
type Catalog = { schemes: Scheme[]; plot_catalog: string };
type Row = { row_id: string; keys: Record<string, unknown>; key_labels: Record<string, string> };
type Page = { rows: Row[]; total: number; matched_total: number; first_match: string | null; selected_matches: boolean };
type Artifact = Row & { scheme: string; plot_index: number; plot_name: string; plotly_uri: string; annotations_uri: string; payload: string };
type Condition = { id: number; key: Key; definition: QueryDefinition; values: QueryValue[]; all: boolean;
  total: number; domain: Candidate[]; domainFilters: Filter[]; known: Map<string, Candidate>; positions: number[]; sync?: () => void };
declare const Plotly: {
  react(element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>): Promise<void>;
  purge(element: HTMLElement): void;
  addFrames(element: HTMLElement, frames: unknown[]): Promise<void>;
  update(element: HTMLElement, data: Record<string, unknown>, layout: Record<string, unknown>, indices: number[]): Promise<void>;
  relayout(element: HTMLElement, layout: Record<string, unknown>): Promise<void>;
  toImage(element: HTMLElement, options: Record<string, unknown>): Promise<string>;
  Plots: { resize(element: HTMLElement): Promise<void> };
};
declare const MathJax: { startup: { promise: Promise<void> } };

const app = new App({ name: 'MatlabResults', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const schemeSelect = element<HTMLSelectElement>('scheme'), plotSelect = element<HTMLSelectElement>('plot-choice');
const status = element('status'), ask = element<HTMLButtonElement>('ask'), addContextButton = element<HTMLButtonElement>('add-context');
const dialog = element<HTMLDialogElement>('picker-dialog');
const compactLayout = matchMedia('(max-width:760px)');
let catalog: Catalog, offset = 0, nextId = 0, request = 0;
let selected: Artifact | undefined, selectedRowId: string | undefined;
let renderedPlot: PlotState | undefined, plotQueue: Promise<unknown> = Promise.resolve();
let plotAnnotations: PlotAnnotations = { revision: '', annotations: [] }, annotationsPending = false;
let conditions: Condition[] = [];

function showError(error: unknown) { status.textContent = status.title = error instanceof Error ? error.message : String(error); status.dataset.error = 'true'; }
function note(text: string) { status.textContent = status.title = text; status.dataset.error = 'false'; }
function data<T>(reply: CallToolResult): T {
  if (reply.isError) throw new Error(reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  return reply.structuredContent as T;
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> { return data<T>(await app.callServerTool({ name, arguments: args })); }
function run(action: Promise<unknown>) { void action.catch(showError); }
function currentScheme() { return catalog.schemes.find(s => s.id === schemeSelect.value)!; }
function option(value: string, text: string) { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }
function button(text: string, action: () => void, label?: string) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action;
  if (label) b.setAttribute('aria-label', label); return b;
}
const valueId = (value: QueryValue) => JSON.stringify(value);
function valueText(c: Condition, value: QueryValue) { return c.known.get(valueId(value))?.label ?? (value === null ? '<missing>' : String(value)); }
function currentText(c: Condition) {
  if (!c.total) return '候補なし';
  if (c.definition.op === 'in') return c.all ? `すべて${c.values.length ? `（${c.values.length}件を除外）` : ''}`
    : c.values.length > 2 ? `${c.values.length}件` : c.values.map(v => valueText(c, v)).join(', ') || '選択なし';
  return c.values.map(v => valueText(c, v)).join(c.definition.op === 'between' ? ' ～ ' : '');
}
function compile(mode: 'Fixed' | 'Parametric', exceptId = 0): Filter[] {
  return conditions.filter(c => c.definition.mode === mode && c.id !== exceptId).flatMap(c => {
    let op: Filter['op'] = c.definition.op;
    if (op === 'in' && c.all) { if (!c.values.length) return []; op = 'not_in'; }
    else if (mode === 'Parametric' && !c.total) op = 'false';
    return [{ key: c.key.name, op, value: ['in', 'not_in', 'between'].includes(op) ? c.values : c.values[0] ?? null }];
  });
}
function ordered(c: Condition) { return ['between', 'gte', 'lte'].includes(c.definition.op); }
async function domain(c: Condition, args: Record<string, unknown> = {}): Promise<Domain> {
  return call('list_candidates', { scheme: currentScheme().id, key: c.key.name, filters: c.domainFilters, ordered: ordered(c), limit: 25, ...args });
}
function remember(c: Condition, candidates: (Candidate | null)[]) { candidates.forEach(v => { if (v) c.known.set(valueId(v.value), v); }); }
async function candidateAt(c: Condition, index: number): Promise<Candidate> {
  const known = c.domain.find(v => v.index === index);
  return known ?? (await domain(c, { offset: index, limit: 1 })).candidates[0];
}
async function loadDomain(c: Condition, reset: boolean, token: number) {
  c.domainFilters = compile('Fixed', c.definition.mode === 'Fixed' ? c.id : 0);
  const snap = c.definition.control === 'range' || (c.definition.control === 'slider' && c.definition.op !== 'eq');
  const result = await domain(c, { locate: reset || c.definition.op === 'contains' ? [] : c.values, nearest: snap });
  if (token !== request) return;
  c.total = result.total; c.domain = result.candidates; remember(c, [...result.candidates, ...result.locations]);
  if (reset) { c.values = []; c.all = c.definition.op === 'in'; }
  if (c.definition.op === 'contains') { if (reset) c.values = ['']; return; }
  if (!c.total) return;
  if (c.definition.op === 'in') {
    if (!reset && c.definition.mode === 'Parametric') c.values = result.locations.flatMap(v => v ? [v.value] : []);
    return;
  }
  if (!c.values.length || (c.definition.mode === 'Parametric' && c.definition.op === 'eq')) {
    const first = result.locations[0] ?? c.domain[0];
    c.values = [first.value]; c.positions = [first.index];
    if (c.definition.op === 'between') { const last = await candidateAt(c, c.total - 1); if (token !== request) return; remember(c, [last]); c.values.push(last.value); c.positions.push(last.index); }
  } else {
    c.positions = result.locations.map(v => v?.index ?? 0);
    result.locations.forEach((v, i) => { if (v) c.values[i] = v.value; });
    if (c.definition.control === 'range') {
      const bounds = result.locations.filter((v): v is Candidate => v !== null).sort((a, b) => a.index - b.index);
      c.positions = bounds.map(v => v.index); c.values = bounds.map(v => v.value);
    }
  }
}

function configurePlots(preserve = false) {
  const scheme = currentScheme(), old = preserve ? plotSelect.value : '';
  plotSelect.replaceChildren(...(scheme.plots ?? []).map(p => option(String(p.index), p.name)));
  if (scheme.plots?.some(p => String(p.index) === old)) plotSelect.value = old;
  plotSelect.disabled = !scheme.plots?.length;
}
function changeScheme(id?: string) {
  if (id) schemeSelect.value = id;
  const scheme = currentScheme(); conditions = []; offset = 0; selectedRowId = undefined; dialog.close(); configurePlots();
  element<HTMLSelectElement>('sort').replaceChildren(option('RowId', '保存順'), ...scheme.keys.map(k => option(k.name, k.name)));
  element('direction').textContent = '↑';
}
async function addCondition() {
  const key = currentScheme().keys[0]; if (!key) return;
  const c: Condition = { id: ++nextId, key, definition: queriesFor(key.kind)[0], values: [], all: false, total: 0, domain: [], domainFilters: [], known: new Map(), positions: [0] };
  conditions.push(c); await refreshFixed(c.id);
}
async function changeCondition(c: Condition, key: Key, name: string) {
  const previous = c.definition, previousKey = c.key;
  c.key = key; c.definition = queriesFor(key.kind).find(q => q.name === name) ?? queriesFor(key.kind)[0];
  await refreshFixed(previousKey !== key || previous.op !== c.definition.op ? c.id : undefined);
}
function inlineParameter(c: Condition) { return compactLayout.matches && (c.definition.control === 'slider' || c.definition.control === 'range'); }
function renderQueries() {
  element('filters').replaceChildren(...conditions.map(c => {
    const row = document.createElement('div'); row.className = 'query-row'; row.dataset.query = String(c.id);
    const key = document.createElement('select'); key.setAttribute('aria-label', `Query ${c.id} Key`);
    key.append(...currentScheme().keys.map(k => option(k.name, k.name))); key.value = c.key.name;
    key.onchange = () => run(changeCondition(c, currentScheme().keys.find(k => k.name === key.value)!, c.definition.name));
    const query = document.createElement('select'); query.setAttribute('aria-label', `Query ${c.id} 種類`);
    query.append(...queriesFor(c.key.kind).map(q => option(q.name, q.name))); query.value = c.definition.name;
    query.onchange = () => run(changeCondition(c, c.key, query.value));
    const remove = button('×', () => { conditions = conditions.filter(v => v !== c); run(refreshFixed()); }, `Query ${c.id} を削除`);
    const editor = document.createElement('div'); editor.className = 'query-editor';
    if (c.definition.mode === 'Fixed') editor.append(makeEditor(c));
    else {
      if (inlineParameter(c)) { editor.classList.add('inline-parameter'); editor.append(makeEditor(c)); }
      const text = document.createElement('output'); text.className = 'current'; text.id = `current-${c.id}`; text.textContent = currentText(c); editor.append(text);
    }
    row.append(key, query, editor, remove); return row;
  }));
}
function renderParameters() {
  const parameters = element('parameters');
  parameters.replaceChildren(...conditions.filter(c => c.definition.mode === 'Parametric' && !inlineParameter(c)).map(c => {
    const row = document.createElement('div'); row.className = 'parameter'; row.dataset.parameter = String(c.id);
    const label = document.createElement('label'); label.textContent = c.key.name;
    row.append(label, makeEditor(c)); return row;
  }));
  element('parameters-panel').hidden = compactLayout.matches && !parameters.childElementCount;
}
compactLayout.addEventListener('change', () => { if (catalog) { renderQueries(); renderParameters(); } });
function sync(c: Condition) { const label = document.getElementById(`current-${c.id}`); if (label) label.textContent = currentText(c); c.sync?.(); }
async function changed(c: Condition) {
  if (c.definition.mode === 'Fixed') await refreshFixed();
  else { sync(c); await evaluate(++request); }
}
function numericInput(c: Condition, side: number) {
  const input = document.createElement('input'); input.type = 'number'; input.step = 'any';
  input.setAttribute('aria-label', `${c.key.name} ${c.definition.name}${c.definition.op === 'between' ? side ? ' 上限' : ' 下限' : ''}`);
  const value = c.values[side], raw = c.known.get(valueId(value))?.raw ?? value; input.value = String(raw ?? '');
  let timer: ReturnType<typeof setTimeout>;
  const apply = () => {
    clearTimeout(timer); if (!input.isConnected || !conditions.includes(c)) return;
    if (!input.value || !Number.isFinite(Number(input.value))) { showError(`${c.key.name}には数値を入力してください。`); return; }
    const value = /^(u?int64)$/.test(c.key.class ?? '') ? input.value : Number(input.value);
    const current = c.known.get(valueId(c.values[side]))?.raw ?? c.values[side];
    if (String(current) === input.value) return;
    c.values[side] = value; run(changed(c));
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 200); };
  input.onchange = apply;
  input.onkeydown = event => { if (event.key === 'Enter') apply(); };
  return input;
}
function makeEditor(c: Condition): HTMLElement {
  const box = document.createElement('div'); box.className = 'editor'; c.sync = undefined;
  if (!c.total && c.definition.op !== 'contains') { box.textContent = '候補なし'; return box; }
  const kind = c.definition.control;
  if (kind === 'slider' || kind === 'range') {
    const row = document.createElement('div'); row.className = 'slider-row';
    const inputs = document.createElement('div'); inputs.className = 'slider-inputs';
    const ranges = Array.from({ length: kind === 'range' ? 2 : 1 }, (_, side) => {
      const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = String(Math.max(1, c.total - 1)); input.step = '1'; input.value = String(c.positions[side] ?? 0); input.disabled = c.total < 2;
      input.setAttribute('aria-label', `${c.key.name} ${c.definition.name}${kind === 'range' ? side ? ' 上限' : ' 下限' : ''}`);
      let timer: ReturnType<typeof setTimeout>;
      const apply = () => { if (!input.isConnected || !conditions.includes(c)) return; const indices = ranges.map(r => Number(r.value)).sort((a, b) => a - b); run(setIndices(c, indices)); };
      input.oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 100); };
      input.onchange = () => { clearTimeout(timer); apply(); };
      inputs.append(input); return input;
    });
    const step = (delta: number) => run(setIndices(c, c.positions.map(v => v + Math.max(-Math.min(...c.positions), Math.min(c.total - 1 - Math.max(...c.positions), delta)))));
    const previous = button('‹', () => step(-1), `${c.key.name} 前の候補`), next = button('›', () => step(1), `${c.key.name} 次の候補`);
    row.append(previous, inputs, next); box.append(row);
    const ticks = document.createElement('div'); ticks.className = 'ticks';
    const first = document.createElement('span'), last = document.createElement('span'); first.textContent = c.domain[0]?.label ?? ''; last.textContent = `${c.total}候補`;
    ticks.append(first, last); box.append(ticks);
    c.sync = () => { ranges.forEach((r, i) => { r.value = String(c.positions[i]); }); previous.disabled = Math.min(...c.positions) <= 0; next.disabled = Math.max(...c.positions) >= c.total - 1; };
    c.sync();
  } else if (kind === 'bounds') { box.classList.add('bounds'); box.append(numericInput(c, 0), numericInput(c, 1)); }
  else if (kind === 'number') box.append(numericInput(c, 0));
  else if (kind === 'text') {
    const input = document.createElement('input'); input.value = String(c.values[0] ?? ''); input.setAttribute('aria-label', `${c.key.name} ${c.definition.name}`);
    let timer: ReturnType<typeof setTimeout>;
    const apply = () => { clearTimeout(timer); if (input.isConnected && conditions.includes(c) && c.values[0] !== input.value) { c.values = [input.value]; run(changed(c)); } };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 200); }; input.onchange = apply;
    input.onkeydown = event => { if (event.key === 'Enter') apply(); }; box.append(input);
  } else if (kind === 'select' && c.total <= 25) {
    const select = document.createElement('select'); select.setAttribute('aria-label', `${c.key.name} ${c.definition.name}`);
    const values = [...c.domain]; const value = c.values[0];
    if (!values.some(v => valueId(v.value) === valueId(value))) values.push({ index: -1, value, label: valueText(c, value), raw: value });
    select.append(...values.map((v, i) => option(String(i), v.label)));
    select.value = String(values.findIndex(v => valueId(v.value) === valueId(value)));
    select.onchange = () => { const v = values[Number(select.value)]; c.values = [v.value]; c.positions = [v.index]; run(changed(c)); }; box.append(select);
  } else if (kind === 'list') box.append(makePicker(c, true, true).element);
  else { const choose = button(currentText(c), () => openPicker(c), `${c.key.name} ${c.definition.name}`); c.sync = () => { choose.textContent = currentText(c); }; box.append(choose); }
  return box;
}
async function setIndices(c: Condition, indices: number[]) {
  if (!conditions.includes(c) || !c.total) return;
  const token = ++request, candidates = await Promise.all(indices.map(index => candidateAt(c, index)));
  if (token !== request || !conditions.includes(c)) return;
  remember(c, candidates); c.positions = indices; c.values = candidates.map(v => v.value); sync(c); await evaluate(token);
}

function makePicker(c: Condition, multiple: boolean, immediate: boolean) {
  let values = [...c.values], all = c.all, start = 0, page: Candidate[] = [], revision = 0;
  const box = document.createElement('div'); box.className = 'picker';
  const toolbar = document.createElement('div'); toolbar.className = 'picker-pages';
  const previous = button('‹', () => { start -= 25; run(load()); }, `${c.key.name} 候補の前ページ`);
  const next = button('›', () => { start += 25; run(load()); }, `${c.key.name} 候補の次ページ`);
  const count = document.createElement('span'), allLabel = document.createElement('label'); allLabel.className = 'check';
  const allInput = document.createElement('input'); allInput.type = 'checkbox'; allInput.checked = all; allLabel.append(allInput, document.createTextNode('すべて')); allLabel.hidden = !multiple;
  const list = document.createElement('div'); list.className = 'choices';
  const commit = () => { if (immediate) { c.values = [...values]; c.all = all; run(changed(c)); } };
  allInput.onchange = () => { all = allInput.checked; values = []; paint(); commit(); };
  function paint() {
    allInput.checked = all;
    list.replaceChildren(...page.map(v => {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = multiple ? 'checkbox' : 'radio'; input.name = `candidate-${c.id}`;
      const present = values.some(value => valueId(value) === valueId(v.value)); input.checked = multiple && all ? !present : present;
      input.setAttribute('aria-label', `${c.key.name} 候補 ${v.index + 1}: ${v.label}`);
      input.onchange = () => { if (multiple) {
        values = values.filter(value => valueId(value) !== valueId(v.value));
        if (all ? !input.checked : input.checked) values.push(v.value);
      } else values = [v.value]; commit(); };
      label.append(input, document.createTextNode(v.label)); return label;
    }));
  }
  async function load() {
    const token = ++revision, result = await domain(c, { offset: start }); if (token !== revision) return;
    page = result.candidates; remember(c, page); previous.disabled = start === 0; next.disabled = start + 25 >= result.total;
    count.textContent = `${result.total ? start + 1 : 0}–${Math.min(start + 25, result.total)} / ${result.total}`; paint();
  }
  toolbar.append(previous, next, count, allLabel); box.append(toolbar, list); run(load());
  return { element: box, read: () => ({ values, all }) };
}
function openPicker(c: Condition) {
  const picker = makePicker(c, c.definition.op === 'in', false);
  element('picker-title').textContent = c.key.name; element('picker-body').replaceChildren(picker.element);
  element('picker-cancel').onclick = () => dialog.close();
  element('picker-apply').onclick = () => {
    const result = picker.read(); dialog.close(); if (!conditions.includes(c)) return;
    if (c.definition.op === 'in' || result.values.length) { c.values = result.values; c.all = result.all; run(changed(c)); }
  }; dialog.showModal();
}

async function refreshFixed(resetId?: number) {
  const token = ++request; note('検索中…'); offset = 0;
  if (resetId) await loadDomain(conditions.find(c => c.id === resetId)!, true, token);
  for (const c of conditions) { if (token !== request) return; await loadDomain(c, false, token); }
  if (token !== request) return;
  renderQueries(); renderParameters(); await evaluate(token);
}
function highlight() { document.querySelectorAll<HTMLTableRowElement>('#rows tr').forEach(tr => tr.setAttribute('aria-selected', String(tr.dataset.row === selectedRowId))); }
function renderTable(page: Page) {
  const scheme = currentScheme(), header = document.createElement('tr');
  for (const key of scheme.keys) { const th = document.createElement('th'); th.textContent = key.name; header.append(th); }
  element('head').replaceChildren(header);
  element('rows').replaceChildren(...page.rows.map(row => {
    const tr = document.createElement('tr'); tr.dataset.row = row.row_id; tr.tabIndex = 0; tr.setAttribute('aria-label', `結果${row.row_id}を表示`);
    tr.onclick = () => run(selectRow(row.row_id)); tr.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(selectRow(row.row_id)); } };
    for (const key of scheme.keys) { const td = document.createElement('td'); td.textContent = row.key_labels[key.name]; tr.append(td); } return tr;
  }));
  element('page').textContent = page.total ? `${offset + 1}–${Math.min(offset + 25, page.total)} / ${page.total}件` : '0件';
  element<HTMLButtonElement>('previous').disabled = offset === 0;
  element<HTMLButtonElement>('next').disabled = offset + 25 >= page.total; highlight();
}
async function evaluate(token: number, preferredRowId?: string, reply?: CallToolResult, force = false) {
  const page = await call<Page>('search_results', { scheme: currentScheme().id, filters: compile('Fixed'), parameters: compile('Parametric'),
    selected_row_id: preferredRowId ?? selectedRowId, offset, limit: 25, sort_key: element<HTMLSelectElement>('sort').value, descending: element('direction').textContent === '↓' });
  if (token !== request) return;
  renderTable(page); element('matches').textContent = `${page.matched_total} / ${currentScheme().count}件`;
  const target = preferredRowId ?? (page.selected_matches ? selectedRowId : page.matched_total === 1 ? page.first_match ?? undefined : undefined);
  if (!target) {
    selectedRowId = undefined; await clearPlot(); if (token !== request) return;
    note(''); highlight(); return;
  }
  selectedRowId = target; highlight();
  if (force || !selected || selected.row_id !== target || selected.scheme !== currentScheme().id || selected.plot_index !== Number(plotSelect.value)) await loadSelection(target, token, reply, force);
}
async function selectRow(rowId: string, reply?: CallToolResult) {
  const token = ++request;
  for (const c of conditions.filter(c => c.definition.mode === 'Parametric' && c.definition.op === 'eq')) {
    const result = await domain(c, { locate: [{ candidate: rowId }] }); if (token !== request) return;
    remember(c, result.locations); c.values = [{ candidate: rowId }];
    if (result.locations[0]) { c.values = [result.locations[0].value]; c.positions = [result.locations[0].index]; }
  }
  renderQueries(); renderParameters(); await evaluate(token, rowId, reply);
}
async function clearPlot() {
  selected = undefined; renderedPlot = undefined; ask.disabled = addContextButton.disabled = true; Plotly.purge(element('plot'));
  plotAnnotations = { revision: '', annotations: [] };
}
async function loadSelection(rowId: string, token: number, reply?: CallToolResult, refresh = false) {
  ask.disabled = addContextButton.disabled = true;
  const task = plotQueue.then(() => token === request ? drawSelection(rowId, token, reply, refresh) : undefined);
  plotQueue = task.catch(() => {});
  try { await task; }
  catch (error) { if (token !== request) return; await clearPlot(); throw error; }
}
async function drawSelection(rowId: string, token: number, reply?: CallToolResult, refresh = false) {
  if (token !== request) return;
  note('Plotを読み込み中…');
  const args = { scheme: currentScheme().id, row_id: rowId, plot_index: Number(plotSelect.value || 1) };
  if (!currentScheme().plots?.length) { await clearPlot(); note('登録済みPlotがありません。'); return; }
  const response = reply ?? await app.callServerTool({ name: 'render_plot', arguments: { ...args, include_preview: false, known_revision: renderedPlot?.revision, refresh } });
  const artifact = data<Artifact>(response);
  if (token !== request) return;
  let update = response._meta?.plot_update as PlotUpdate | undefined;
  if (!update || (!update.plot && update.base_revision !== renderedPlot?.revision)) {
    const resource = await app.readServerResource({ uri: artifact.plotly_uri });
    const content = resource.contents.find(c => 'text' in c);
    if (!content || !('text' in content)) throw new Error('Plotデータを読み取れませんでした。');
    update = { revision: '', plot: JSON.parse(content.text) as Plot };
  }
  await MathJax.startup.promise; if (token !== request) return;
  const next = applyPlotUpdate(renderedPlot, update);
  if (update.plot) {
    delete next.plot.layout.width; delete next.plot.layout.height; next.plot.layout.autosize = true;
    await Plotly.react(element('plot'), next.plot.data, next.plot.layout, { responsive: true, displaylogo: false, showLink: false });
    if (next.plot.frames?.length) await Plotly.addFrames(element('plot'), next.plot.frames);
  } else {
    const traces = update.traces ?? [], fields = new Set(traces.flatMap(trace => Object.keys(trace.values)));
    if (traces.length || Object.keys(update.layout ?? {}).length) await Plotly.update(element('plot'),
      Object.fromEntries([...fields].map(key => [key, traces.map(trace => trace.values[key])])), update.layout ?? {}, traces.map(trace => trace.index));
  }
  renderedPlot = next;
  if (token !== request) return;
  selected = artifact; plotAnnotations = { revision: '', annotations: [] };
  await refreshAnnotations(true); if (token !== request) return;
  ask.disabled = addContextButton.disabled = false; note('');
}
async function refreshAnnotations(force = false) {
  const artifact = selected; if (!artifact || !renderedPlot) return;
  const resource = await app.readServerResource({ uri: artifact.annotations_uri });
  const content = resource.contents.find(c => 'text' in c);
  if (!content || !('text' in content)) throw new Error('Plotの注釈を読み取れませんでした。');
  const saved = JSON.parse(content.text) as PlotAnnotations;
  if (selected !== artifact || !renderedPlot || (!force && saved.revision === plotAnnotations.revision)) return;
  await Plotly.relayout(element('plot'), annotationLayout(renderedPlot.plot, saved.annotations));
  plotAnnotations = saved;
}
async function addContext() {
  const artifact = selected; if (!artifact) return;
  const task = plotQueue.then(async () => {
    if (selected !== artifact) return;
    // Sandboxed hosts can block the blob URL used by Plotly's PNG export.
    const preview = new Image();
    preview.src = await Plotly.toImage(element('plot'), { format: 'svg', width: 1100, height: 800 });
    await preview.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 800;
    canvas.getContext('2d')!.drawImage(preview, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    const selection = { ...artifact, annotations: plotAnnotations.annotations };
    await app.updateModelContext({ content: [{ type: 'text', text: `選択した保存結果: ${JSON.stringify(selection)}` },
      { type: 'image', mimeType: 'image/png', data: png.slice(png.indexOf(',') + 1) }], structuredContent: { selection } });
    note('コンテキストに追加しました。'); return selection;
  });
  plotQueue = task.catch(() => {});
  return task;
}
async function accept(reply: CallToolResult) {
  const payload = data<Partial<Catalog & Artifact>>(reply);
  if (payload.schemes) {
    const old = schemeSelect.value; catalog = payload as Catalog;
    schemeSelect.replaceChildren(...catalog.schemes.map(s => option(s.id, `${s.id} (${s.count})`)));
    if (!catalog.schemes.length) { note('登録済みのSchemeがありません。'); return; }
    changeScheme(catalog.schemes.some(s => s.id === old) ? old : undefined); await refreshFixed();
  } else if (payload.plotly_uri && payload.scheme && payload.row_id) {
    if (!catalog) await accept(await app.callServerTool({ name: 'list_schemes', arguments: {} }));
    changeScheme(payload.scheme); plotSelect.value = String(payload.plot_index); await refreshFixed(); await selectRow(payload.row_id, reply);
  }
}

element('add-query').onclick = () => run(addCondition());
element('clear-query').onclick = () => { conditions = []; run(refreshFixed()); };
schemeSelect.onchange = () => { changeScheme(); run(refreshFixed()); };
plotSelect.onchange = () => { if (selectedRowId) run(evaluate(++request, selectedRowId, undefined, true)); };
element('refresh').onclick = () => run((async () => {
  const updated = await call<Catalog>('list_schemes', {}); const old = currentScheme().id; catalog = updated;
  if (catalog.schemes.some(s => s.id === old)) {
    schemeSelect.replaceChildren(...catalog.schemes.map(s => option(s.id, `${s.id} (${s.count})`))); schemeSelect.value = old; configurePlots(true);
    conditions = conditions.filter(c => currentScheme().keys.some(k => k.name === c.key.name));
    conditions.forEach(c => { c.key = currentScheme().keys.find(k => k.name === c.key.name)!; });
    await refreshFixed(); if (selectedRowId) await evaluate(++request, selectedRowId, undefined, true);
  }
  else await accept({ content: [], structuredContent: updated });
})());
element('previous').onclick = () => { offset -= 25; run(evaluate(++request)); };
element('next').onclick = () => { offset += 25; run(evaluate(++request)); };
element<HTMLSelectElement>('sort').onchange = () => { offset = 0; run(evaluate(++request)); };
element('direction').onclick = () => { element('direction').textContent = element('direction').textContent === '↑' ? '↓' : '↑'; offset = 0; run(evaluate(++request)); };
element('toggle-table').onclick = () => { const hidden = element('main').classList.toggle('table-hidden'); element('table-wrap').hidden = hidden; element('pages').hidden = hidden; element('toggle-table').textContent = hidden ? 'Tableを表示' : 'Tableを隠す'; };
addContextButton.onclick = () => run(addContext());
ask.onclick = () => run((async () => {
  const artifact = await addContext(); if (!artifact) return;
  const question = element<HTMLTextAreaElement>('question').value.trim() || 'この結果の特徴を説明して。';
  const text = `${question}\n\nScheme: ${artifact.scheme}\nRowId: ${artifact.row_id}\nPlot: ${artifact.plot_name}\n条件: ${JSON.stringify(artifact.keys)}`;
  const message = { role: 'user' as const, content: [{ type: 'text' as const, text }], _meta: { 'openai/message': { send: false } } };
  const response = await app.sendMessage(message); if (response.isError) throw new Error('会話に渡せませんでした。'); note('選択した結果を会話に渡しました。');
})());
let resizeFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (selected) void Plotly.Plots.resize(element('plot')); }); }).observe(element('plot'));
function theme(context: ReturnType<App['getHostContext']>) { if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); }
app.addEventListener('hostcontextchanged', theme); app.ontoolresult = reply => run(accept(reply)); await app.connect(); theme(app.getHostContext());
setInterval(() => {
  if (document.hidden || !selected || annotationsPending) return;
  annotationsPending = true;
  const task = plotQueue.then(() => refreshAnnotations()); plotQueue = task.catch(() => {});
  run(task.finally(() => { annotationsPending = false; }));
}, 1000);
