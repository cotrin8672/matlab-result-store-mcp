import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { queriesFor, type QueryDefinition, type QueryKind, type QueryValue, type Filter, type Candidate, type Domain } from '../queries.ts';
import { queryFunction } from './query-function.ts';
import { themedPlotLayout, themedPlotData, applyPlotUpdate, type Plot, type PlotAnnotation, type PlotAnnotations, type PlotState, type PlotUpdate } from '../plots.ts';
import type { BrowserSelection, BrowserState } from '../browser.ts';

type Key = { name: string; class: string | null; kind: QueryKind };
type Scheme = { id: string; keys: Key[]; values: string[]; count: number; plots: { index: number; name: string }[] | null; ref_schemes?: string[] };
type Catalog = { root: string; directory: string; schemes: Scheme[]; plot_catalog: string; browser_state_uri?: string };
type InitialRef = { scheme: string; row_id: string };
type Row = { row_id: string; keys: Record<string, unknown>; key_labels: Record<string, string>; initial_ref?: InitialRef | null; initial_ref_status?: string };
type Page = { rows: Row[]; columns?: Key[]; total: number; matched_total: number; first_match: string | null; selected_matches: boolean };
type RefScheme = { id: string; keys: Key[]; available: boolean };
type PathNode = Row & InitialRef & { sequence: number; cycle: number | string | null; cumulative_cycle: number | string | null };
type ResultPath = { terminal: InitialRef; path_length: number; total: number; offset: number; limit: number; nodes: PathNode[];
  termination: { reason: 'complete' | 'cycle' | 'broken_ref' | 'unknown_initial' | 'limit'; ref?: InitialRef }; total_cycle: number | string | null };
type Artifact = Row & { directory: string; scheme: string; plot_index: number; plot_name: string; plotly_uri: string; annotations_uri: string; payload: string; revision?: string; browser_state_uri?: string };
type Pin = Row & { id: string; directory: string; scheme: string; plot_index: number; plot_name: string; payload: string; revision: string; created_at: string; annotations: PlotAnnotation[]; plotly_uri: string };
type Pins = { pins: Pin[]; revision: string };
type PinCard = { pin: Pin; element: HTMLElement; graph: HTMLElement; plot?: Plot; colors: string };
type Condition = { id: number; key: Key; definition: QueryDefinition; values: QueryValue[]; all: boolean;
  total: number; domain: Candidate[]; domainFilters: Filter[]; known: Map<string, Candidate>; positions: number[]; sync?: () => void };
declare const Plotly: {
  react(element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>): Promise<void>;
  purge(element: HTMLElement): void;
  addFrames(element: HTMLElement, frames: unknown[]): Promise<void>;
  update(element: HTMLElement, data: Record<string, unknown>, layout: Record<string, unknown>, indices?: number[]): Promise<void>;
  relayout(element: HTMLElement, layout: Record<string, unknown>): Promise<void>;
  toImage(element: HTMLElement, options: Record<string, unknown>): Promise<string>;
  Plots: { resize(element: HTMLElement): Promise<void> };
};
declare const MathJax: { startup: { promise: Promise<void> } };

const app = new App({ name: 'MatlabResults', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const schemeSelect = element<HTMLSelectElement>('scheme'), plotSelect = element<HTMLSelectElement>('plot-choice');
const directoryInput = element<HTMLInputElement>('directory');
const refSelect = element<HTMLSelectElement>('ref-scheme'), pathSlider = element<HTMLInputElement>('path-slider');
const status = element('status'), addContextButton = element<HTMLButtonElement>('add-context'), pinButton = element<HTMLButtonElement>('pin-plot');
const copyButton = element<HTMLButtonElement>('copy-plot'), plotThemeButton = element<HTMLButtonElement>('plot-theme');
const pickerPopover = element('picker-popover');
const compactLayout = matchMedia('(max-width:760px), (orientation:portrait)');
let plotTheme: 'auto' | 'light' | 'dark' = 'auto';
let catalog: Catalog, offset = 0, nextId = 0, request = 0;
let selected: Artifact | undefined, selectedRowId: string | undefined;
let renderedPlot: PlotState | undefined, plotQueue: Promise<unknown> = Promise.resolve();
let plotAnnotations: PlotAnnotations = { revision: '', annotations: [] }, updatesPending = false, browserRevision = '', plotColors = '';
let browserStateUri = 'result-store://browser/state', browserPinsRevision = '';
let conditions: Condition[] = [];
let refScheme = '', refSchemes: RefScheme[] = [];
let resultPath: ResultPath | undefined, pathIndex = -1;
const pinCards = new Map<string, PinCard>();
let pinsRevision = '', pinsRequest = 0, pinQueue: Promise<unknown> = Promise.resolve();
let loadingPlot: number | undefined;

const icons = {
  folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>',
  scheme: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pin: '<path d="m16 3 5 5-4 1-3 5v4l-8-8h4l5-3Z M3 21l6-6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  spinner: '<path d="M12 3a9 9 0 1 1-9 9"/>',
  context: '<path d="M9 18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6 M3 18v3l5-3 M17 14v8m-4-4h8"/>',
  auto: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  dark: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>',
  refresh: '<path d="M20 7v5h-5 M4 17v-5h5 M5.3 7a8 8 0 0 1 13-2L20 8 M4 16l1.7 3a8 8 0 0 0 13-2"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  previous: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
};
function icon(name: keyof typeof icons) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon');
  svg.innerHTML = icons[name]; return svg;
}
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon as keyof typeof icons)));
function plotBusy(token: number, busy: boolean) {
  if (busy) loadingPlot = token;
  else { if (loadingPlot !== token) return; loadingPlot = undefined; }
  element('plot-title').classList.toggle('loading', busy); element('plot').setAttribute('aria-busy', String(busy));
}

function showError(error: unknown) { status.textContent = status.title = error instanceof Error ? error.message : String(error); status.dataset.error = 'true'; }
function note(text: string) { status.textContent = status.title = text; status.dataset.error = 'false'; }
function useBrowserState(uri?: string) { if (uri && uri !== browserStateUri) { browserStateUri = uri; browserRevision = browserPinsRevision = ''; } }
function themeColors() {
  if (plotTheme === 'light') return { background: '#ffffff', text: '#202020', grid: '#0000001f' };
  if (plotTheme === 'dark') return { background: '#181818', text: '#eeeeee', grid: '#ffffff29' };
  const style = getComputedStyle(document.documentElement);
  return { background: style.backgroundColor, text: style.color,
    grid: style.getPropertyValue('--color-border-secondary').trim() || (style.colorScheme === 'dark' ? '#ffffff29' : '#0000001f') };
}
function data<T>(reply: CallToolResult): T {
  if (reply.isError) throw new Error(reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  return reply.structuredContent as T;
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return data<T>(await app.callServerTool({ name, arguments: { ...(catalog && !['list_stores', 'list_pinned_plots', 'unpin_plot'].includes(name) ? { directory: catalog.directory } : {}), ...args } }));
}
async function read<T>(uri: string): Promise<T> {
  const resource = await app.readServerResource({ uri });
  const content = resource.contents.find(c => 'text' in c);
  if (!content || !('text' in content)) throw new Error('Plotデータを読み取れませんでした。');
  return JSON.parse(content.text) as T;
}
function run(action: Promise<unknown>) { void action.catch(showError); }
function currentScheme() { return catalog.schemes.find(s => s.id === schemeSelect.value)!; }
function refKeys() { return (refSchemes.find(s => s.id === refScheme)?.keys ?? []).map(key => ({ ...key, name: `Ref.${key.name}` })); }
function conditionKeys(c: Condition) { return c.key.name.startsWith('Ref.') ? refKeys() : currentScheme().keys; }
function plotScheme() {
  if (!resultPath) return currentScheme();
  const node = resultPath.nodes[pathIndex]; return node ? catalog.schemes.find(s => s.id === node.scheme) : undefined;
}
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
  return call('list_candidates', { scheme: currentScheme().id, ...(refScheme ? { ref_scheme: refScheme } : {}), key: c.key.name, filters: c.domainFilters, ordered: ordered(c), limit: 25, ...args });
}
function remember(c: Condition, candidates: (Candidate | null)[]) { candidates.forEach(v => { if (v) c.known.set(valueId(v.value), v); }); }
async function candidateAt(c: Condition, index: number): Promise<Candidate> {
  const known = c.domain.find(v => v.index === index);
  return known ?? (await domain(c, { offset: index, limit: 1 })).candidates[0];
}
async function loadDomain(c: Condition, reset: boolean, token: number) {
  c.domainFilters = compile('Fixed', c.definition.mode === 'Fixed' ? c.id : 0);
  const snap = c.definition.control === 'range' || (c.definition.control === 'slider' && c.definition.op !== 'eq');
  const result = await domain(c, { locate: reset || c.definition.op === 'contains' ? [] : c.values, nearest: snap,
    limit: c.definition.control === 'select' ? 100 : 25 });
  if (token !== request) return;
  c.total = result.total; c.domain = result.candidates; remember(c, [...result.candidates, ...result.locations]);
  if (c.definition.control === 'select') {
    for (let start = c.domain.length; start < c.total; start += 100) {
      const page = await domain(c, { offset: start, limit: 100 }); if (token !== request) return;
      c.domain.push(...page.candidates); remember(c, page.candidates);
    }
  }
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
  const scheme = plotScheme(), old = preserve ? plotSelect.value : '';
  plotSelect.replaceChildren(...(scheme?.plots ?? []).map(p => option(String(p.index), p.name)));
  if (scheme?.plots?.some(p => String(p.index) === old)) plotSelect.value = old;
  plotSelect.disabled = !scheme?.plots?.length;
}
function changeScheme(id?: string) {
  if (id) schemeSelect.value = id;
  const scheme = currentScheme(); conditions = []; refScheme = ''; refSchemes = []; offset = 0; selectedRowId = undefined;
  resetPath(true); pickerPopover.hidePopover(); configurePlots(); renderRefSchemes();
  element<HTMLSelectElement>('sort').replaceChildren(option('RowId', '保存順'), ...scheme.keys.map(k => option(k.name, k.name)));
  element('direction').textContent = '↑';
}
async function addCondition(ref = false) {
  const key = (ref ? refKeys() : currentScheme()?.keys)[0]; if (!key) return;
  const c: Condition = { id: ++nextId, key, definition: queriesFor(key.kind)[0], values: [], all: false, total: 0, domain: [], domainFilters: [], known: new Map(), positions: [0] };
  conditions.push(c); await refreshFixed(c.id);
}
async function changeCondition(c: Condition, key: Key, name: string) {
  const previous = c.definition, previousKey = c.key;
  c.key = key; c.definition = queriesFor(key.kind).find(q => q.name === name) ?? queriesFor(key.kind)[0];
  await refreshFixed(previousKey !== key || previous.op !== c.definition.op ? c.id : undefined);
}
function inlineParameter(c: Condition) { return compactLayout.matches && (c.definition.control === 'slider' || c.definition.control === 'range'); }
function removeCondition(c: Condition) {
  conditions = conditions.filter(value => value !== c); run(refreshFixed());
}
function swipeQuery(row: HTMLElement, c: Condition) {
  let pointer: number | undefined, startX = 0, startY = 0, distance = 0, swiping = false;
  row.tabIndex = 0; row.setAttribute('aria-label', `Query ${c.id}`);
  row.setAttribute('aria-description', '左端を左右にスワイプ、またはDeleteキーで削除');
  row.onkeydown = event => {
    if (event.target === row && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); removeCondition(c); }
  };
  row.onpointerdown = event => {
    if (event.button !== 0 || (event.target as Element).closest('input,select,button,.query-function-control')) return;
    pointer = event.pointerId; startX = event.clientX; startY = event.clientY; distance = 0; swiping = false;
    row.setPointerCapture(pointer);
  };
  row.onpointermove = event => {
    if (pointer !== event.pointerId) return;
    const x = event.clientX - startX, y = event.clientY - startY;
    if (!swiping && Math.abs(y) > 8 && Math.abs(y) > Math.abs(x)) { row.releasePointerCapture(pointer); pointer = undefined; return; }
    if (!swiping && (Math.abs(x) < 8 || Math.abs(x) < Math.abs(y) * 1.5)) return;
    event.preventDefault(); swiping = true; distance = x; row.style.transform = `translateX(${x}px)`; row.classList.add('swiping');
    row.parentElement!.classList.add('swiping');
  };
  const finish = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return;
    pointer = undefined; row.style.transform = ''; row.classList.remove('swiping'); row.parentElement!.classList.remove('swiping');
    if (event.type === 'pointerup' && Math.abs(distance) >= Math.min(96, row.clientWidth * .2)) removeCondition(c);
  };
  row.onpointerup = row.onpointercancel = finish;
}
function renderQueries() {
  pickerPopover.hidePopover();
  const rows = conditions.map(c => {
    const row = document.createElement('div'); row.className = 'query-row'; row.dataset.query = String(c.id);
    const key = document.createElement('select'); key.setAttribute('aria-label', `Query ${c.id} Key`);
    key.append(...conditionKeys(c).map(k => option(k.name, k.name.replace(/^Ref\./, '')))); key.value = c.key.name;
    key.onchange = () => run(changeCondition(c, conditionKeys(c).find(k => k.name === key.value)!, c.definition.name));
    const query = queryFunction(c.definition, queriesFor(c.key.kind), name => run(changeCondition(c, c.key, name)), `Query ${c.id} 種類`);
    const grip = document.createElement('span'); grip.className = 'query-swipe'; grip.title = '左右にスワイプして削除'; grip.append(icon('grip'));
    const editor = document.createElement('div'); editor.className = 'query-editor';
    if (c.definition.mode === 'Fixed') editor.append(makeEditor(c));
    else {
      if (inlineParameter(c)) { editor.classList.add('inline-parameter'); editor.append(makeEditor(c)); }
      const text = document.createElement('output'); text.className = 'current'; text.id = `current-${c.id}`; text.textContent = text.title = currentText(c); editor.append(text);
    }
    row.append(grip, key, query, editor); swipeQuery(row, c);
    const item = document.createElement('div'); item.className = 'query-item'; item.append(row); return { c, item };
  });
  element('filters').replaceChildren(...rows.filter(({ c }) => !c.key.name.startsWith('Ref.')).map(({ item }) => item));
  element('ref-filters').replaceChildren(...rows.filter(({ c }) => c.key.name.startsWith('Ref.')).map(({ item }) => item));
}
function renderRefSchemes() {
  refSelect.replaceChildren(option('', '指定なし'), ...refSchemes.map(s => {
    const item = option(s.id, `${s.id}${s.available ? '' : '（利用不可）'}`); item.disabled = !s.available && s.id !== refScheme; return item;
  }));
  refSelect.value = refScheme;
  element('ref-panel').hidden = !currentScheme()?.ref_schemes?.length && !refSchemes.length && !refScheme;
  element<HTMLButtonElement>('add-ref-query').disabled = !refScheme || !refKeys().length;
}
async function refreshRefSchemes(token: number) {
  if (!currentScheme().ref_schemes?.length && !refScheme) { refSchemes = []; renderRefSchemes(); return; }
  const previous = refSchemes.find(s => s.id === refScheme);
  const reply = await call<{ schemes: RefScheme[] }>('list_ref_schemes', {
    scheme: currentScheme().id, filters: compile('Fixed').filter(filter => !filter.key.startsWith('Ref.')),
  });
  if (token !== request) return;
  refSchemes = reply.schemes;
  if (previous && !refSchemes.some(s => s.id === previous.id)) refSchemes.push(previous);
  renderRefSchemes();
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
function positionQueries() {
  const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
  if (compactLayout.matches) element('main').insertBefore(sidebar, document.querySelector('.table-panel'));
  else document.querySelector('.columns')!.prepend(sidebar);
}
positionQueries();
compactLayout.addEventListener('change', () => { positionQueries(); if (catalog) { renderQueries(); renderParameters(); } });
function sync(c: Condition) { const label = document.getElementById(`current-${c.id}`); if (label) label.textContent = label.title = currentText(c); c.sync?.(); }
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
  } else if (kind === 'select') {
    const select = document.createElement('select'); select.setAttribute('aria-label', `${c.key.name} ${c.definition.name}`);
    const values = [...c.domain]; const value = c.values[0];
    if (!values.some(v => valueId(v.value) === valueId(value))) values.push({ index: -1, value, label: valueText(c, value), raw: value });
    select.append(...values.map((v, i) => option(String(i), v.label)));
    select.value = String(values.findIndex(v => valueId(v.value) === valueId(value)));
    select.onchange = () => { const v = values[Number(select.value)]; c.values = [v.value]; c.positions = [v.index]; run(changed(c)); }; box.append(select);
  } else if (kind === 'list') box.append(makePicker(c, true, true).element);
  else {
    const choose = button(currentText(c), () => openPicker(c, choose), `${c.key.name} ${c.definition.name}`);
    choose.setAttribute('aria-haspopup', 'dialog');
    c.sync = () => { choose.textContent = currentText(c); }; box.append(choose);
  }
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
function openPicker(c: Condition, anchor: HTMLElement) {
  if (pickerPopover.matches(':popover-open')) {
    pickerPopover.hidePopover(); if (pickerPopover.dataset.condition === String(c.id)) return;
  }
  pickerPopover.dataset.condition = String(c.id);
  const picker = makePicker(c, true, false);
  element('picker-title').textContent = c.key.name; element('picker-body').replaceChildren(picker.element);
  element('picker-cancel').onclick = () => { pickerPopover.hidePopover(); anchor.focus(); };
  element('picker-apply').onclick = () => {
    const result = picker.read(); pickerPopover.hidePopover(); anchor.focus(); if (!conditions.includes(c)) return;
    c.values = result.values; c.all = result.all; run(changed(c));
  };
  const bounds = anchor.getBoundingClientRect(), width = Math.min(Math.max(bounds.width, 240), innerWidth - 16);
  pickerPopover.style.width = `${width}px`;
  pickerPopover.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - width - 8))}px`;
  pickerPopover.showPopover();
  const height = pickerPopover.getBoundingClientRect().height;
  pickerPopover.style.top = `${Math.max(8, bounds.bottom + height + 12 <= innerHeight ? bounds.bottom + 4 : bounds.top - height - 4)}px`;
  pickerPopover.querySelector<HTMLInputElement>('input')?.focus();
}
addEventListener('resize', () => pickerPopover.hidePopover());

async function refreshFixed(resetId?: number) {
  const token = ++request; note('検索中…'); offset = 0;
  plotBusy(token, true);
  try {
    if (resetId) await loadDomain(conditions.find(c => c.id === resetId)!, true, token);
    for (const c of conditions) { if (token !== request) return; await loadDomain(c, false, token); }
    await refreshRefSchemes(token);
    if (token !== request) return;
    renderQueries(); renderParameters(); await evaluate(token);
  } finally { plotBusy(token, false); }
}
function highlight() { document.querySelectorAll<HTMLTableRowElement>('#rows tr').forEach(tr => tr.setAttribute('aria-selected', String(tr.dataset.row === selectedRowId))); }
function renderTable(page: Page) {
  const columns = page.columns ?? currentScheme().keys, header = document.createElement('tr');
  const sort = element<HTMLSelectElement>('sort'), descending = element('direction').textContent === '↓';
  const previousSort = sort.value;
  sort.replaceChildren(option('RowId', '保存順'), ...columns.map(key => option(key.name, key.name)));
  if (previousSort === 'RowId' || columns.some(key => key.name === previousSort)) sort.value = previousSort;
  for (const key of columns) {
    const th = document.createElement('th'), active = sort.value === key.name;
    th.setAttribute('aria-sort', active ? descending ? 'descending' : 'ascending' : 'none');
    const label = `${key.name}を${active && !descending ? '降順' : '昇順'}に並べ替え`;
    const control = button(`${key.name}${active ? descending ? ' ↓' : ' ↑' : ''}`, () => {
      element('direction').textContent = sort.value === key.name && element('direction').textContent === '↑' ? '↓' : '↑';
      sort.value = key.name; offset = 0; run(evaluate(++request));
    }, label);
    control.title = label; th.append(control); header.append(th);
  }
  element('head').replaceChildren(header);
  element('rows').replaceChildren(...page.rows.map(row => {
    const tr = document.createElement('tr'); tr.dataset.row = row.row_id; tr.tabIndex = 0; tr.setAttribute('aria-label', `結果${row.row_id}を表示`);
    tr.onclick = () => run(selectRow(row.row_id)); tr.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(selectRow(row.row_id)); } };
    for (const key of columns) { const td = document.createElement('td'); td.textContent = row.key_labels[key.name] ?? ''; tr.append(td); } return tr;
  }));
  element('page').textContent = page.total ? `${offset + 1}–${Math.min(offset + 25, page.total)} / ${page.total}件` : '0件';
  element<HTMLButtonElement>('previous').disabled = offset === 0;
  element<HTMLButtonElement>('next').disabled = offset + 25 >= page.total; highlight();
}
const pathFilterIds = ['path-sequence-min', 'path-sequence-max', 'path-cycle-min', 'path-cycle-max'];
function resetPath(clearFilters = false) {
  resultPath = undefined; pathIndex = -1; element('path-panel').hidden = true;
  if (clearFilters) pathFilterIds.forEach(id => { element<HTMLInputElement>(id).value = ''; });
}
function pathFilters() {
  const values = pathFilterIds.map(id => element<HTMLInputElement>(id).value.trim());
  const sequence: { min?: number; max?: number } = {}, cumulative: { min?: number | string; max?: number | string } = {};
  values.forEach((value, i) => {
    if (!value) return;
    const number = Number(value);
    if (!Number.isFinite(number) || number < (i < 2 ? 1 : 0) || (i < 2 && !Number.isSafeInteger(number))) throw new Error('Pathの範囲条件を確認してください。');
    if (i < 2) sequence[i ? 'max' : 'min'] = number;
    else {
      if (number > Number.MAX_SAFE_INTEGER && !/^\d+$/.test(value)) throw new Error('大きな累積cycleは整数の十進表記で入力してください。');
      cumulative[i === 3 ? 'max' : 'min'] = number > Number.MAX_SAFE_INTEGER ? value : number;
    }
  });
  if (sequence.min !== undefined && sequence.max !== undefined && sequence.min > sequence.max) throw new Error('順序の下限が上限を超えています。');
  return { ...(Object.keys(sequence).length ? { sequence } : {}), ...(Object.keys(cumulative).length ? { cumulative_cycle: cumulative } : {}) };
}
function renderPath() {
  const path = resultPath; element('path-panel').hidden = !path;
  if (!path) return;
  const node = path.nodes[pathIndex];
  const terminal = element('path-terminal'); terminal.textContent = `終端 ${path.terminal.scheme} / RowId ${path.terminal.row_id}`;
  terminal.title = `${terminal.textContent} · 累積cycle ${path.total_cycle ?? '?'}`;
  pathSlider.max = String(Math.max(1, path.nodes.length - 1)); pathSlider.value = String(Math.max(0, pathIndex)); pathSlider.disabled = path.nodes.length < 2;
  element<HTMLButtonElement>('path-previous').disabled = pathIndex <= 0;
  element<HTMLButtonElement>('path-next').disabled = pathIndex < 0 || pathIndex >= path.nodes.length - 1;
  const label = element('path-node'), position = element('path-position');
  label.textContent = node ? `${node.scheme} / RowId ${node.row_id}` : '該当なし'; label.title = node ? JSON.stringify(node.key_labels) : '';
  position.textContent = node ? `${node.sequence} / ${path.path_length} · Σcycle ${node.cumulative_cycle ?? '?'}` : `0 / ${path.path_length}`;
  position.title = node ? `cycle ${node.cycle ?? '?'} · ${path.total}件該当` : '';
  pathSlider.setAttribute('aria-valuetext', `${label.textContent} ${position.textContent}`);
  const reasons = { complete: '', cycle: '初期値Refが循環しています。', broken_ref: '初期値Refの参照先が見つかりません。', unknown_initial: '初期値Refが不明です。', limit: 'Pathの取得上限に達しました。' };
  element('path-termination').textContent = reasons[path.termination.reason];
}
async function loadPath(rowId: string, token: number, preserve = false) {
  const sequence = preserve ? resultPath?.nodes[pathIndex]?.sequence : undefined;
  const oldScheme = plotScheme()?.id, oldName = plotSelect.selectedOptions[0]?.textContent;
  const args = { scheme: currentScheme().id, row_id: rowId, limit: 1000, ...pathFilters() };
  const path = await call<ResultPath>('get_result_path', args);
  while (token === request && path.nodes.length < path.total) {
    const page = await call<ResultPath>('get_result_path', { ...args, offset: path.nodes.length });
    if (!page.nodes.length) break;
    path.nodes.push(...page.nodes);
  }
  if (token !== request) return;
  resultPath = path;
  pathIndex = sequence === undefined ? -1 : path.nodes.findIndex(node => node.sequence === sequence);
  if (pathIndex < 0) pathIndex = path.nodes.length - 1;
  configurePlots(oldScheme === plotScheme()?.id);
  const samePlot = plotScheme()?.plots?.find(plot => plot.name === oldName);
  if (samePlot) plotSelect.value = String(samePlot.index);
  renderPath();
}
async function choosePath(index: number) {
  const node = resultPath?.nodes[index]; if (!node) return;
  const oldName = plotSelect.selectedOptions[0]?.textContent;
  pathIndex = index; configurePlots();
  const samePlot = plotScheme()?.plots?.find(plot => plot.name === oldName);
  if (samePlot) plotSelect.value = String(samePlot.index);
  renderPath(); await loadSelection(node.row_id, ++request);
}
async function filterPath() {
  if (!resultPath) return;
  const row = resultPath.terminal.row_id, token = ++request;
  plotBusy(token, true);
  try {
    await loadPath(row, token, true); if (token !== request) return;
    const node = resultPath?.nodes[pathIndex];
    if (node) await loadSelection(node.row_id, token); else await clearPlot(token, true);
  } finally { plotBusy(token, false); }
}
async function evaluate(token: number, preferredRowId?: string, reply?: CallToolResult, force = false, refresh = false) {
  plotBusy(token, true);
  try {
    const page = await call<Page>('search_results', { scheme: currentScheme().id, ...(refScheme ? { ref_scheme: refScheme } : {}), filters: compile('Fixed'), parameters: compile('Parametric'),
      selected_row_id: preferredRowId ?? selectedRowId, offset, limit: 25, sort_key: element<HTMLSelectElement>('sort').value, descending: element('direction').textContent === '↓' });
    if (token !== request) return;
    renderTable(page); element('matches').textContent = `${page.matched_total} / ${currentScheme().count}件`;
    const target = preferredRowId ?? (page.selected_matches ? selectedRowId : page.matched_total === 1 ? page.first_match ?? undefined : undefined);
    if (!target) {
      selectedRowId = undefined; await clearPlot(); if (token !== request) return;
      note(page.matched_total > 1 ? `${page.matched_total}件該当しています。Queryで絞り込むか、表から表示する結果を選択してください。` : ''); highlight(); return;
    }
    selectedRowId = target; highlight();
    const samePath = resultPath?.terminal.scheme === currentScheme().id && resultPath.terminal.row_id === target;
    if (!samePath || force) await loadPath(target, token, samePath);
    if (token !== request) return;
    const node = resultPath?.nodes[pathIndex];
    if (!node) { await clearPlot(token, true); return; }
    if (force || !selected || selected.directory !== catalog.directory || selected.row_id !== node.row_id || selected.scheme !== node.scheme || selected.plot_index !== Number(plotSelect.value))
      await loadSelection(node.row_id, token, node.scheme === currentScheme().id && node.row_id === target ? reply : undefined, refresh);
    else note('');
  } finally { plotBusy(token, false); }
}
async function selectRow(rowId: string, reply?: CallToolResult, force = false) {
  const token = ++request;
  resetPath();
  for (const c of conditions.filter(c => c.definition.mode === 'Parametric' && c.definition.op === 'eq')) {
    const result = await domain(c, { locate: [{ candidate: rowId }] }); if (token !== request) return;
    remember(c, result.locations); c.values = [{ candidate: rowId }];
    if (result.locations[0]) { c.values = [result.locations[0].value]; c.positions = [result.locations[0].index]; }
  }
  renderQueries(); renderParameters(); await evaluate(token, rowId, reply, force);
}
async function clearPlot(token = request, keepPath = false) {
  pinButton.disabled = addContextButton.disabled = copyButton.disabled = true;
  const task = plotQueue.then(() => {
    if (token !== request) return;
    if (!keepPath) resetPath();
    selected = undefined; renderedPlot = undefined; Plotly.purge(element('plot'));
    plotAnnotations = { revision: '', annotations: [] };
  });
  plotQueue = task.catch(() => {}); await task;
}
async function loadSelection(rowId: string, token: number, reply?: CallToolResult, refresh = false) {
  pinButton.disabled = addContextButton.disabled = copyButton.disabled = true;
  if (!plotScheme()?.plots?.length) { await clearPlot(token, true); if (token === request) note('このPathの結果には登録済みPlotがありません。'); return; }
  plotBusy(token, true);
  const task = plotQueue.then(() => token === request ? drawSelection(rowId, token, reply, refresh) : undefined);
  plotQueue = task.catch(() => {});
  try { await task; }
  catch (error) { if (token !== request) return; await clearPlot(token, true); throw error; }
  finally { plotBusy(token, false); }
}
async function drawSelection(rowId: string, token: number, reply?: CallToolResult, refresh = false) {
  if (token !== request) return;
  note('');
  const args = { directory: catalog.directory, scheme: plotScheme()!.id, row_id: rowId, plot_index: Number(plotSelect.value || 1) };
  const response = reply?._meta?.plot_update ? reply : await app.callServerTool({ name: 'render_plot', arguments: { ...args, include_preview: false, known_revision: renderedPlot?.revision, refresh },
    _meta: { 'matlab-results/browser': true } });
  const artifact = data<Artifact>(response);
  if (token !== request) return;
  useBrowserState(artifact.browser_state_uri);
  let update = response._meta?.plot_update as PlotUpdate | undefined;
  if (!update || (!update.plot && update.base_revision !== renderedPlot?.revision)) {
    update = { revision: artifact.revision ?? '', plot: await read<Plot>(artifact.plotly_uri) };
  }
  await MathJax.startup.promise; if (token !== request) return;
  const next = applyPlotUpdate(renderedPlot, update);
  if (update.plot) {
    delete next.plot.layout.width; delete next.plot.layout.height; next.plot.layout.autosize = true;
    const colors = themeColors();
    const layout = { ...structuredClone(next.plot.layout), paper_bgcolor: colors.background, plot_bgcolor: colors.background,
      font: { ...(next.plot.layout.font as object), color: colors.text } };
    await Plotly.react(element('plot'), structuredClone(next.plot.data), layout, { responsive: true, displaylogo: false, showLink: false });
    if (next.plot.frames?.length) await Plotly.addFrames(element('plot'), next.plot.frames);
  } else {
    const traces = update.traces ?? [], fields = new Set(traces.flatMap(trace => Object.keys(trace.values)));
    if (traces.length || Object.keys(update.layout ?? {}).length) await Plotly.update(element('plot'),
      Object.fromEntries([...fields].map(key => [key, traces.map(trace => structuredClone(trace.values[key]))])), structuredClone(update.layout ?? {}), traces.map(trace => trace.index));
  }
  renderedPlot = next;
  if (token !== request) return;
  selected = artifact; plotAnnotations = { revision: '', annotations: [] };
  await refreshAnnotations(true); if (token !== request) return;
  pinButton.disabled = addContextButton.disabled = copyButton.disabled = false; note('');
}
async function refreshAnnotations(force = false) {
  const artifact = selected; if (!artifact || !renderedPlot) return;
  const saved = await read<PlotAnnotations>(artifact.annotations_uri);
  const colors = themeColors();
  const signature = JSON.stringify(colors);
  if (selected !== artifact || !renderedPlot || (!force && saved.revision === plotAnnotations.revision && signature === plotColors)) return;
  await Plotly.update(element('plot'), themedPlotData(renderedPlot.plot, colors.background), themedPlotLayout(renderedPlot.plot, saved.annotations, colors, element('plot').clientHeight));
  plotAnnotations = saved; plotColors = signature;
}
async function showSelection(selection: BrowserSelection, reply?: CallToolResult) {
  const directory = selection.directory ?? catalog?.directory;
  if (selected && selected.directory === directory && selected.scheme === selection.scheme && selected.row_id === selection.row_id && selected.plot_index === selection.plot_index &&
      (reply?.structuredContent as Partial<Artifact> | undefined)?.revision === renderedPlot?.revision && renderedPlot?.revision) return;
  if (catalog?.directory !== directory || !catalog?.schemes.some(s => s.id === selection.scheme && s.plots?.some(p => p.index === selection.plot_index)))
    await openDirectory(directory, false);
  if ((directory && catalog?.directory !== directory) || !catalog?.schemes.some(s => s.id === selection.scheme)) return;
  if (currentScheme().id !== selection.scheme) changeScheme(selection.scheme);
  plotSelect.value = String(selection.plot_index);
  await selectRow(selection.row_id, reply, true);
}
async function refreshBrowser() {
  const token = request;
  const state = await read<BrowserState>(browserStateUri);
  if (token !== request) return false;
  const pins = state.pins_revision ?? (state.kind === 'pins' ? state.revision : undefined);
  if (pins && pins !== browserPinsRevision) { await refreshPins(); browserPinsRevision = pins; }
  if (state.revision === browserRevision || token !== request) return false;
  if (state.kind === 'pins') { browserRevision = state.revision; return false; }
  const samePlot = state.selection && selected?.directory === (state.selection.directory ?? catalog.directory) && selected.scheme === state.selection.scheme && selected.row_id === state.selection.row_id && selected.plot_index === state.selection.plot_index;
  const unchanged = samePlot && (state.kind === 'annotations' || state.plot_revision === renderedPlot?.revision);
  if (state.selection && !unchanged) await showSelection(state.selection);
  browserRevision = state.revision;
  return !unchanged;
}
async function addContext() {
  const artifact = selected; if (!artifact) return;
  const task = plotQueue.then(async () => {
    if (selected !== artifact) return;
    const { png } = await plotImages();
    const selection = { ...artifact, annotations: plotAnnotations.annotations };
    await app.updateModelContext({ content: [{ type: 'text', text: `選択した保存結果: ${JSON.stringify(selection)}` },
      { type: 'image', mimeType: 'image/png', data: png.slice(png.indexOf(',') + 1) }], structuredContent: { selection } });
    note('コンテキストに追加しました。'); return selection;
  });
  plotQueue = task.catch(() => {});
  return task;
}

async function plotImages(width = 1100, height = 800) {
  // Sandboxed hosts can block the blob URL used by Plotly's PNG export.
  const svg = await Plotly.toImage(element('plot'), { format: 'svg', width, height });
  const preview = new Image(); preview.src = svg; await preview.decode();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(preview, 0, 0, width, height);
  return { svg, png: canvas.toDataURL('image/png') };
}

async function copyCurrentPlot() {
  const artifact = selected; if (!artifact || !renderedPlot) return;
  const label = copyButton.getAttribute('aria-label')!, title = copyButton.title;
  copyButton.disabled = true;
  copyButton.setAttribute('aria-busy', 'true'); copyButton.setAttribute('aria-label', 'Plotをコピー中');
  copyButton.title = 'Plotをコピー中…'; copyButton.replaceChildren(icon('spinner')); note('');
  const task = plotQueue.then(async () => {
    if (selected !== artifact) return;
    const graph = element('plot'), height = Math.max(1, Math.round(1200 * graph.clientHeight / graph.clientWidth));
    data(await app.callServerTool({ name: 'copy_plot', arguments: await plotImages(1200, height) }));
    note('Plotをコピーしました。PowerPointに貼り付けできます。');
  });
  plotQueue = task.catch(() => {});
  try { await task; } finally {
    copyButton.setAttribute('aria-busy', 'false'); copyButton.setAttribute('aria-label', label);
    copyButton.title = title; copyButton.replaceChildren(icon('copy'));
    if (selected === artifact) copyButton.disabled = false;
  }
}

async function setCatalog(updated: Catalog, token = request) {
  useBrowserState(updated.browser_state_uri);
  const old = catalog?.directory === updated.directory ? schemeSelect.value : '';
  catalog = updated; directoryInput.value = updated.directory;
  schemeSelect.replaceChildren(...catalog.schemes.map(s => option(s.id, `${s.id} (${s.count})`)));
  schemeSelect.disabled = element<HTMLButtonElement>('add-query').disabled = element<HTMLButtonElement>('clear-query').disabled = !catalog.schemes.length;
  if (!catalog.schemes.length) {
    conditions = []; refScheme = ''; refSchemes = []; selectedRowId = undefined; plotSelect.replaceChildren(); plotSelect.disabled = true;
    element('filters').replaceChildren(); element('ref-filters').replaceChildren(); element('ref-panel').hidden = true;
    element('parameters').replaceChildren(); element('head').replaceChildren(); element('rows').replaceChildren();
    element('matches').textContent = element('page').textContent = '';
    element<HTMLButtonElement>('previous').disabled = element<HTMLButtonElement>('next').disabled = true;
    await clearPlot(token); note('登録済みのSchemeがありません。'); return;
  }
  await clearPlot(token);
  if (token !== request) return;
  changeScheme(catalog.schemes.some(s => s.id === old) ? old : undefined);
}
async function openDirectory(directory?: string, evaluate = true, fromInput = false) {
  const token = ++request; note('読み込み中…');
  const updated = await call<Catalog>('list_schemes', directory ? { directory } : {});
  if (token !== request) return;
  if (fromInput && directoryInput.value.trim() !== directory) { note(''); return; }
  await setCatalog(updated, token);
  if (token === request && catalog.schemes.length && evaluate) await refreshFixed();
}
async function themePins() {
  const colors = themeColors();
  for (const card of pinCards.values()) {
    const signature = `${JSON.stringify(colors)}:${card.graph.clientHeight}`;
    if (!card.plot || card.colors === signature) continue;
    await Plotly.update(card.graph, themedPlotData(card.plot, colors.background), themedPlotLayout(card.plot, card.pin.annotations, colors, card.graph.clientHeight));
    card.colors = signature;
  }
}
async function acceptPins(snapshot: Pins, token = ++pinsRequest) {
  const task = pinQueue.then(async () => {
    if (token !== pinsRequest || snapshot.revision === pinsRevision) return;
    for (const [id, card] of pinCards) if (!snapshot.pins.some(pin => pin.id === id)) {
      graphObserver.unobserve(card.graph); Plotly.purge(card.graph); card.element.remove(); pinCards.delete(id);
    }
    element('pins-panel').hidden = !snapshot.pins.length; element('pins-count').textContent = String(snapshot.pins.length);
    for (const pin of snapshot.pins) {
      let card = pinCards.get(pin.id);
      if (!card) {
        const section = document.createElement('article'); section.className = 'pin-card'; section.dataset.pin = pin.id;
        const heading = document.createElement('div'); heading.className = 'pin-heading';
        const title = document.createElement('h3'); title.textContent = `${pin.scheme} / RowId ${pin.row_id} · ${pin.plot_name}`; title.title = title.textContent;
        const remove = button('×', () => run(call<Pins>('unpin_plot', { pin_id: pin.id }).then(snapshot => acceptPins(snapshot))), `${pin.scheme} RowId ${pin.row_id} ${pin.plot_name} のピンを解除`);
        remove.title = 'ピンを解除'; heading.append(title, remove);
        const directory = document.createElement('p'); directory.className = 'pin-directory muted'; directory.textContent = directory.title = pin.directory;
        const graph = document.createElement('div'); graph.className = 'pin-plot'; graph.setAttribute('aria-label', `${pin.scheme} RowId ${pin.row_id} ${pin.plot_name}`);
        section.append(heading, directory, graph); element('pins').append(section);
        card = { pin, element: section, graph, colors: '' }; pinCards.set(pin.id, card); graphObserver.observe(graph);
      }
      if (card.pin.revision !== pin.revision || JSON.stringify(card.pin.annotations) !== JSON.stringify(pin.annotations)) { card.plot = undefined; card.colors = ''; }
      card.pin = pin;
      if (!card.plot) {
        const plot = await read<Plot>(pin.plotly_uri), layout = structuredClone(plot.layout), colors = themeColors();
        delete layout.width; delete layout.height; layout.autosize = true;
        layout.paper_bgcolor = layout.plot_bgcolor = colors.background; layout.font = { ...(layout.font as object), color: colors.text };
        await MathJax.startup.promise;
        await Plotly.react(card.graph, structuredClone(plot.data), layout, { responsive: true, displaylogo: false, showLink: false });
        if (plot.frames?.length) await Plotly.addFrames(card.graph, structuredClone(plot.frames));
        card.plot = plot;
      }
    }
    await themePins();
    if (token === pinsRequest) pinsRevision = snapshot.revision;
  });
  pinQueue = task.catch(() => {}); await task;
}
async function refreshPins() {
  const token = ++pinsRequest, snapshot = await call<Pins>('list_pinned_plots', {});
  await acceptPins(snapshot, token);
}
async function pinCurrent() {
  await plotQueue;
  const artifact = selected; if (!artifact || !renderedPlot) return;
  pinButton.disabled = true;
  try {
    await acceptPins(await call<Pins>('pin_plot', { directory: artifact.directory, scheme: artifact.scheme, row_id: artifact.row_id,
      plot_index: artifact.plot_index, known_revision: renderedPlot.revision }));
    note('ピン留めしました。');
  } finally { if (selected === artifact) pinButton.disabled = false; }
}
async function accept(reply: CallToolResult) {
  const payload = data<Partial<Catalog & Artifact>>(reply);
  useBrowserState(payload.browser_state_uri);
  if (payload.schemes) {
    const token = ++request; await setCatalog(payload as Catalog, token);
    if (token === request && catalog.schemes.length) await refreshFixed();
  } else if (payload.plotly_uri && payload.scheme && payload.row_id) {
    await showSelection(payload as Artifact, reply);
  }
}

element('add-query').onclick = () => run(addCondition());
element('add-ref-query').onclick = () => run(addCondition(true));
refSelect.onchange = () => {
  refScheme = refSelect.value; conditions = conditions.filter(c => !c.key.name.startsWith('Ref.'));
  const sort = element<HTMLSelectElement>('sort'); if (sort.value.startsWith('Ref.')) sort.value = 'RowId';
  renderRefSchemes(); run(refreshFixed());
};
element('clear-query').onclick = () => {
  conditions = []; refScheme = ''; renderRefSchemes();
  const sort = element<HTMLSelectElement>('sort'); if (sort.value.startsWith('Ref.')) sort.value = 'RowId';
  run(refreshFixed());
};
element('path-previous').onclick = () => run(choosePath(pathIndex - 1));
element('path-next').onclick = () => run(choosePath(pathIndex + 1));
element('path-bounds').onclick = () => {
  const filters = element('path-filters'); filters.hidden = !filters.hidden;
  element('path-bounds').setAttribute('aria-expanded', String(!filters.hidden));
};
let pathTimer: ReturnType<typeof setTimeout>;
const applyPathIndex = () => { clearTimeout(pathTimer); run(choosePath(Number(pathSlider.value))); };
pathSlider.oninput = () => { clearTimeout(pathTimer); pathTimer = setTimeout(applyPathIndex, 100); };
pathSlider.onchange = applyPathIndex;
let pathBoundsTimer: ReturnType<typeof setTimeout>;
const applyPathFilters = () => { clearTimeout(pathBoundsTimer); run(filterPath()); };
pathFilterIds.forEach(id => {
  const input = element<HTMLInputElement>(id);
  input.oninput = () => { clearTimeout(pathBoundsTimer); pathBoundsTimer = setTimeout(applyPathFilters, 200); };
  input.onchange = applyPathFilters;
  input.onkeydown = event => { if (event.key === 'Enter') applyPathFilters(); };
});
let directoryTimer: ReturnType<typeof setTimeout>, pendingDirectory = '';
function applyDirectory() {
  clearTimeout(directoryTimer);
  const directory = directoryInput.value.trim();
  if (!directory || directory === catalog?.directory || directory === pendingDirectory) return;
  pendingDirectory = directory;
  run(openDirectory(directory, true, true).catch(error => { if (directoryInput.value.trim() === directory) throw error; })
    .finally(() => { if (pendingDirectory === directory) pendingDirectory = ''; }));
}
directoryInput.oninput = () => {
  clearTimeout(directoryTimer);
  const listed = Array.from(element<HTMLDataListElement>('directories').options).some(value => value.value === directoryInput.value);
  directoryTimer = setTimeout(applyDirectory, listed ? 0 : 500);
};
directoryInput.onchange = applyDirectory;
directoryInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); applyDirectory(); } };
schemeSelect.onchange = () => { changeScheme(); run(refreshFixed()); };
plotSelect.onchange = () => { if (selectedRowId) run(evaluate(++request, selectedRowId, undefined, true)); };
element('refresh').onclick = () => run((async () => {
  const directory = directoryInput.value.trim();
  if (directory && directory !== catalog?.directory) { applyDirectory(); return; }
  const token = ++request, updated = await call<Catalog>('list_schemes', {});
  if (token !== request) return;
  const old = currentScheme()?.id; catalog = updated; directoryInput.value = updated.directory; useBrowserState(updated.browser_state_uri);
  if (catalog.schemes.some(s => s.id === old)) {
    schemeSelect.replaceChildren(...catalog.schemes.map(s => option(s.id, `${s.id} (${s.count})`))); schemeSelect.value = old; configurePlots(true);
    const keys = [...currentScheme().keys, ...refKeys()];
    conditions = conditions.filter(c => keys.some(k => k.name === c.key.name));
    conditions.forEach(c => { c.key = keys.find(k => k.name === c.key.name)!; });
    const pending = refreshFixed(), refreshToken = request;
    await pending; if (refreshToken === request && selectedRowId) await evaluate(++request, selectedRowId, undefined, true, true);
  }
  else await accept({ content: [], structuredContent: updated });
})());
element('previous').onclick = () => { offset -= 25; run(evaluate(++request)); };
element('next').onclick = () => { offset += 25; run(evaluate(++request)); };
element<HTMLSelectElement>('sort').onchange = () => { offset = 0; run(evaluate(++request)); };
element('direction').onclick = () => { element('direction').textContent = element('direction').textContent === '↑' ? '↓' : '↑'; offset = 0; run(evaluate(++request)); };
element('toggle-table').onclick = () => { const hidden = element('main').classList.toggle('table-hidden'); element('table-wrap').hidden = hidden; element('pages').hidden = hidden; element('toggle-table').textContent = hidden ? 'Tableを表示' : 'Tableを隠す'; };
addContextButton.onclick = () => run(addContext());
pinButton.onclick = () => run(pinCurrent());
copyButton.onclick = () => run(copyCurrentPlot());
plotThemeButton.onclick = () => {
  plotTheme = plotTheme === 'auto' ? 'light' : plotTheme === 'light' ? 'dark' : 'auto';
  plotThemeButton.replaceChildren(icon(plotTheme));
  plotThemeButton.setAttribute('aria-label', `Plotテーマ: ${plotTheme === 'auto' ? 'アプリに追従' : plotTheme}。クリックで切り替え`);
  plotThemeButton.title = plotThemeButton.getAttribute('aria-label')!;
  refreshPlotThemes();
};
let resizeFrame = 0;
const graphObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => {
    const graphs = [...(selected ? [element('plot')] : []), ...[...pinCards.values()].filter(card => card.plot).map(card => card.graph)]
      .filter(graph => graph.clientWidth > 0 && graph.clientHeight > 0);
    run(Promise.all(graphs.map(graph => Plotly.Plots.resize(graph))).then(() => refreshPlotThemes()));
  });
});
graphObserver.observe(element('plot'));
function refreshPlotThemes() {
  if (selected) {
    const task = plotQueue.then(async () => {
      if (!selected || !renderedPlot) return;
      const colors = themeColors();
      await Plotly.update(element('plot'), themedPlotData(renderedPlot.plot, colors.background), themedPlotLayout(renderedPlot.plot, plotAnnotations.annotations, colors, element('plot').clientHeight));
      plotColors = JSON.stringify(colors);
    }); plotQueue = task.catch(() => {}); run(task);
  }
  const task = pinQueue.then(() => themePins()); pinQueue = task.catch(() => {}); run(task);
}
function theme(context: ReturnType<App['getHostContext']>) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  refreshPlotThemes();
}
app.addEventListener('hostcontextchanged', theme); app.ontoolresult = reply => run(accept(reply)); await app.connect(); theme(app.getHostContext());
run(refreshPins());
run((async () => {
  const listing = await call<{ stores: { directory: string; name: string }[] }>('list_stores', {});
  element('directories').replaceChildren(...listing.stores.map(store => option(store.directory, store.name)));
})());
setInterval(() => {
  if (document.hidden || !catalog || updatesPending) return;
  updatesPending = true;
  run((async () => {
    if (await refreshBrowser()) return;
    const task = plotQueue.then(() => refreshAnnotations()); plotQueue = task.catch(() => {});
    await task;
  })().finally(() => { updatesPending = false; }));
}, 1000);
