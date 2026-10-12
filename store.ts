import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import h5 from 'h5wasm/node';
import { parse as parseNpy } from 'npyjs';
import type { Filter, QueryKind, QueryValue } from './queries.ts';

type Row = Record<string, SQLOutputValue>;
type Key = {
  name: string; source: string; rule: string; class: string | null;
  storage: string | null; shape: string | null; kind: QueryKind;
};
type Plot = { index: number; name: string; inputs: string[] };
type Scheme = { id: string; cardinality: string; storage: string; keys: Key[]; values: string[] };
type Catalog = { version: number; snapshot: string; schemes: { id: string; plots: Plot[] }[] };
export type Selection = { start: number[]; count: number[] };

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>, jsonSafe);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function identifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

export class ResultStore {
  root: string;
  db: DatabaseSync;

  constructor(root: string) {
    this.root = realpathSync(root);
    this.db = new DatabaseSync(path.join(this.root, 'results', 'store.sqlite'), { readOnly: true });
    this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  }

  query(sql: string, params: SQLInputValue[] = []): Row[] {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  }

  file(relative: string): string {
    const filename = path.resolve(this.root, relative.replaceAll('\\', '/'));
    const resolved = realpathSync(filename);
    const child = path.relative(this.root, resolved);
    if (child.startsWith('..' + path.sep) || child === '..' || path.isAbsolute(child)) {
      throw new Error('Artifact path is outside the configured Store root.');
    }
    return resolved;
  }

  scheme(id: string): Scheme {
    const row = this.query('SELECT id,cardinality,storage_id FROM __store_schemes WHERE id=? AND active=1', [id])[0];
    if (!row) throw new Error(`Unknown active Scheme: ${id}`);
    const keys = this.query(`SELECT k.name,k.source,k.rule,c.matlab_class,c.storage,c.row_shape
      FROM __store_keys k LEFT JOIN __sqlite_matlab_columns c
      ON c.table_name=? AND c.column_name=k.name WHERE k.scheme_id=? ORDER BY k.position`, [row.storage_id, id]);
    return {
      id, cardinality: String(row.cardinality), storage: String(row.storage_id),
      keys: keys.map(k => ({
        name: String(k.name), source: String(k.source), rule: String(k.rule),
        class: k.matlab_class === null ? null : String(k.matlab_class),
        storage: k.storage === null ? null : String(k.storage),
        shape: k.row_shape === null ? null : String(k.row_shape),
        kind: k.storage === 'text' ? 'text' : k.storage === 'native' && k.row_shape === '1,1'
          ? k.matlab_class === 'logical' ? 'logical' : 'number' : 'value',
      })),
      values: this.query('SELECT name FROM __store_values WHERE scheme_id=? ORDER BY position', [id]).map(v => String(v.name)),
    };
  }

  catalog(): { status: 'ready' | 'missing' | 'stale'; entries: Catalog['schemes'] } {
    let catalog: Catalog;
    try {
      catalog = JSON.parse(readFileSync(this.file('results/web/catalog.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', entries: [] };
      throw error;
    }
    const snapshot = this.query("SELECT value FROM __store_meta WHERE name='metadata'")[0]?.value;
    if (catalog.version !== 1 || !snapshot || path.resolve(catalog.snapshot) !== this.file(String(snapshot))) {
      return { status: 'stale', entries: [] };
    }
    return { status: 'ready', entries: catalog.schemes };
  }

  listSchemes() {
    const catalog = this.catalog();
    return {
      root: this.root, plot_catalog: catalog.status,
      schemes: this.query('SELECT id FROM __store_schemes WHERE active=1 ORDER BY id').map(row => {
        const scheme = this.scheme(String(row.id));
        return {
          ...scheme,
          count: Number(this.query(`SELECT COUNT(*) AS count FROM ${identifier(scheme.storage)}`)[0].count),
          plots: catalog.status === 'ready' ? catalog.entries.find(s => s.id === scheme.id)?.plots ?? [] : null,
        };
      }),
    };
  }

  keyValue(value: SQLOutputValue, key: Key): unknown {
    if (value instanceof Uint8Array) {
      const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
      const array = parseNpy(bytes);
      const data = Array.from(array.data as unknown as ArrayLike<unknown>);
      return {
        shape: array.shape, dtype: array.dtype, order: array.fortranOrder ? 'column-major' : 'row-major',
        data: data.length <= 64 ? jsonSafe(data) : undefined,
        elements: data.length,
      };
    }
    if (key.class === 'logical' && value !== null) return Boolean(value);
    if (typeof value === 'bigint' && key.class !== 'int64' && key.class !== 'uint64') return Number(value);
    return jsonSafe(value);
  }

  row(scheme: Scheme, row: Row) {
    return {
      row_id: String(row.RowId),
      keys: Object.fromEntries(scheme.keys.map(k => [k.name, this.keyValue(row[k.name], k)])),
      key_labels: Object.fromEntries(scheme.keys.map(k => [k.name, this.keyLabel(row[k.name], k)])),
    };
  }

  record(scheme: Scheme, rowId: string): Row {
    if (!/^[1-9]\d*$/.test(rowId) || BigInt(rowId) > 9223372036854775807n) throw new Error('row_id must be a positive SQLite RowId, supplied as a decimal string.');
    const row = this.query(`SELECT * FROM ${identifier(scheme.storage)} WHERE RowId=?`, [BigInt(rowId)])[0];
    if (!row) throw new Error(`No record ${scheme.id}/${rowId}`);
    return row;
  }

  keyLabel(value: SQLOutputValue, key: Key): string {
    if (value === null) return '<missing>';
    if (!(value instanceof Uint8Array)) return String(this.keyValue(value, key)) || '\"\"';
    const array = parseNpy(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
    const data = Array.from(array.data as unknown as ArrayLike<number | bigint>);
    const complex = array.dtype.startsWith('c');
    if (!complex && data.length <= 6 && array.shape.length === 2) {
      const at = (row: number, column: number) => data[array.fortranOrder ? column * array.shape[0] + row : row * array.shape[1] + column];
      return '[' + Array.from({ length: array.shape[0] }, (_, r) => Array.from({ length: array.shape[1] }, (_, c) => String(at(r, c))).join(' ')).join('; ') + ']';
    }
    if (array.dtype.startsWith('f') && data.length > 1 && array.shape.filter(n => n !== 1).length === 1) {
      const numbers = data.map(Number), step = (numbers.at(-1)! - numbers[0]) / (numbers.length - 1);
      const tolerance = 8 * Number.EPSILON * numbers.reduce((maximum, n) => Math.max(maximum, Math.abs(n)), 0);
      if (step && numbers.every(Number.isFinite) && numbers.slice(1).every((v, i) => Math.abs(v - numbers[i] - step) <= tolerance)) {
        return [numbers[0], step, numbers.at(-1)!].map(n => Number(n.toPrecision(12))).join(':');
      }
    }
    return `${array.shape.join('×')} ${key.class === 'cell' ? array.dtype : key.class}`;
  }

  bind(scheme: Scheme, key: Key, value: QueryValue): SQLInputValue {
    if (value && typeof value === 'object') return this.record(scheme, value.candidate)[key.name];
    if (value === null) return null;
    if (key.storage === 'npy' || key.storage === 'mixed') throw new Error(`Use a value from list_candidates to filter array Key ${key.name}.`);
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'string' && /^(u?int64)$/.test(key.class ?? '') && /^-?\d+$/.test(value)) return BigInt(value);
    return value;
  }

  predicates(scheme: Scheme, filters: Filter[]) {
    const params: SQLInputValue[] = [];
    const clauses = filters.map(filter => {
      if (filter.op === 'false') return '0';
      const key = scheme.keys.find(k => k.name === filter.key);
      if (!key) throw new Error(`Unknown Key: ${filter.key}`);
      const column = identifier(key.name);
      if (filter.op === 'is_null') return `${column} IS NULL`;
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (values.some(v => v === undefined)) throw new Error(`Filter ${filter.op} requires value.`);
      const bind = values.map(v => this.bind(scheme, key, v!));
      if (filter.op === 'between') {
        if (key.kind !== 'number' || bind.length !== 2 || bind.some(v => typeof v !== 'number' && typeof v !== 'bigint')) throw new Error('between requires [minimum, maximum] for a numeric scalar Key.');
        params.push(...bind); return `${column} BETWEEN ? AND ?`;
      }
      if (filter.op === 'in' || filter.op === 'not_in') {
        const present = bind.filter(v => v !== null);
        params.push(...present);
        const parts = present.length ? [`${column} IN (${present.map(() => '?').join(',')})`] : [];
        if (bind.includes(null)) parts.push(`${column} IS NULL`);
        const match = parts.join(' OR ') || '0';
        return filter.op === 'not_in' ? `NOT COALESCE((${match}),0)` : `(${match})`;
      }
      if (bind.length !== 1) throw new Error(`${filter.op} requires one scalar value.`);
      if (filter.op === 'contains') {
        if (key.kind !== 'text' || typeof bind[0] !== 'string') throw new Error('contains requires a text Key and string.');
        params.push(bind[0]); return `instr(${column},?)>0`;
      }
      if (bind[0] === null && (filter.op === 'eq' || filter.op === 'ne')) return `${column} IS ${filter.op === 'ne' ? 'NOT ' : ''}NULL`;
      if ((filter.op === 'gte' || filter.op === 'lte') && key.kind !== 'number') throw new Error('Ordered comparisons require a numeric scalar Key.');
      params.push(bind[0]);
      const operators = { eq: '=', ne: '<>', gte: '>=', lte: '<=' };
      return `${column} ${operators[filter.op]} ?`;
    });
    return { where: clauses.length ? clauses.map(c => `(${c})`).join(' AND ') : '1', params };
  }

  search(id: string, filters: Filter[], limit: number, offset: number, sortKey: string, descending: boolean, parameters: Filter[] = [], selectedRowId?: string) {
    const scheme = this.scheme(id);
    if (sortKey !== 'RowId' && !scheme.keys.some(k => k.name === sortKey)) throw new Error('sort_key must be RowId or a Key.');
    const { where, params } = this.predicates(scheme, filters);
    const table = identifier(scheme.storage);
    const total = Number(this.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, params)[0].count);
    const columns = ['RowId', ...scheme.keys.map(k => k.name)].map(identifier).join(',');
    const order = (sortKey === 'RowId' ? '' : `(${identifier(sortKey)} IS NULL),`) + `${identifier(sortKey)} ${descending ? 'DESC' : 'ASC'},RowId ASC`;
    const rows = this.query(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const matched = this.predicates(scheme, [...filters, ...parameters]);
    const stats = this.query(`SELECT COUNT(*) AS count,MIN(RowId) AS first,COALESCE(MAX(CASE WHEN RowId=? THEN 1 ELSE 0 END),0) AS selected FROM ${table} WHERE ${matched.where}`, [selectedRowId ? BigInt(selectedRowId) : 0, ...matched.params])[0];
    return { scheme: id, total, limit, offset, rows: rows.map(r => this.row(scheme, r)), matched_total: Number(stats.count),
      first_match: stats.first === null ? null : String(stats.first), selected_matches: Boolean(stats.selected) };
  }

  candidates(id: string, name: string, filters: Filter[], ordered: boolean, limit: number, offset: number, locate: QueryValue[] = [], nearest = false) {
    const scheme = this.scheme(id), key = scheme.keys.find(k => k.name === name);
    if (!key) throw new Error(`Unknown Key: ${name}`);
    const { where, params } = this.predicates(scheme, filters), column = identifier(name);
    const domain = `SELECT ${column} AS v,MIN(RowId) AS representative FROM ${identifier(scheme.storage)} WHERE (${where})${ordered ? ` AND ${column} IS NOT NULL` : ''} GROUP BY ${column}`;
    const ranked = `SELECT *,ROW_NUMBER() OVER(ORDER BY (v IS NULL),v)-1 AS position FROM (${domain})`;
    const candidate = (row: Row) => ({ index: Number(row.position), value: { candidate: String(row.representative) }, label: this.keyLabel(row.v, key), raw: this.keyValue(row.v, key) });
    const rows = this.query(`SELECT * FROM (${ranked}) ORDER BY position LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const locations = locate.map(value => {
      const raw = this.bind(scheme, key, value);
      let row = this.query(`SELECT * FROM (${ranked}) WHERE v IS ? LIMIT 1`, [...params, raw])[0];
      if (!row && nearest) row = key.kind === 'number' && (typeof raw === 'number' || typeof raw === 'bigint')
        ? this.query(`SELECT * FROM (${ranked}) WHERE v IS NOT NULL ORDER BY ABS(v-?),v LIMIT 1`, [...params, raw])[0]
        : this.query(`SELECT * FROM (${ranked}) ORDER BY position LIMIT 1`, params)[0];
      return row ? candidate(row) : null;
    });
    return { scheme: id, key: name, total: Number(this.query(`SELECT COUNT(*) AS count FROM (${domain})`, params)[0].count),
      limit, offset, candidates: rows.map(candidate), locations };
  }

  async getResult(id: string, rowId: string, include: string[], selection: Selection | undefined, maxElements: number) {
    const scheme = this.scheme(id);
    for (const name of include) if (!scheme.values.includes(name)) throw new Error(`Unknown Value: ${name}`);
    if (selection && !include.length) throw new Error('A slice requires include_values.');
    const row = this.record(scheme, rowId);
    const catalog = this.catalog();
    const values = await readMatValues(this.file(String(row.__store_payload)), scheme.values, include, selection, maxElements);
    return { scheme: id, ...this.row(scheme, row), payload: String(row.__store_payload), plot_catalog: catalog.status,
      plots: catalog.status === 'ready' ? catalog.entries.find(s => s.id === id)?.plots ?? [] : null, values };
  }

  plotArtifact(id: string, rowId: string, plotIndex: number) {
    const scheme = this.scheme(id);
    const row = this.record(scheme, rowId);
    const folder = `results/web/${id}/${rowId}/${plotIndex}`;
    let manifest: { version: number; scheme: string; row_id: string; plot_index: number; plot_name: string; payload: string };
    try {
      manifest = JSON.parse(readFileSync(this.file(`${folder}/manifest.json`), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Plot export is missing.');
      throw error;
    }
    const catalog = this.catalog();
    const plot = catalog.entries.find(s => s.id === id)?.plots.find(p => p.index === plotIndex);
    if (manifest.version !== 1 || manifest.scheme !== id || manifest.row_id !== rowId || manifest.plot_index !== plotIndex || manifest.payload !== row.__store_payload || catalog.status !== 'ready' || plot?.name !== manifest.plot_name) {
      throw new Error('Plot export is stale.');
    }
    return { ...manifest, ...this.row(scheme, row), folder, html_path: this.file(`${folder}/plot.html`) };
  }
}

export async function readMatValues(filename: string, names: string[], include: string[], selection: Selection | undefined, maxElements: number) {
  for (const name of include) if (!names.includes(name)) throw new Error(`Unknown Value: ${name}`);
  if (selection && !include.length) throw new Error('A slice requires include_values.');
  await h5.ready;
  const file = new h5.File(filename, 'r');
  try {
    return Object.fromEntries(names.map(name => {
      const item = file.get(name);
      if (!(item instanceof h5.Dataset)) return [name, { supported: false, reason: 'Only numeric/logical datasets are supported.' }];
      const matlabClass = item.attrs.MATLAB_class?.value;
      const compound = Array.isArray(item.dtype) ? item.dtype : [];
      const complex = compound.length === 2 && compound[0][0] === 'real' && compound[1][0] === 'imag';
      const supported = /^(double|single|logical|u?int(8|16|32|64))$/.test(String(matlabClass)) && (typeof item.dtype === 'string' || complex);
      const empty = item.attrs.MATLAB_empty?.value !== undefined;
      const shape = empty ? Array.from(item.value as ArrayLike<number>, Number) : [...(item.shape ?? [])].reverse();
      let count = shape;
      let ranges: [number, number][] | undefined;
      if (selection && include.includes(name)) {
        if (selection.start.length !== shape.length || selection.count.length !== shape.length) throw new Error(`Slice rank must match MATLAB shape of ${name}.`);
        count = selection.count;
        ranges = selection.start.map((start, i): [number, number] => {
          if (start + count[i] > shape[i]) throw new Error(`Slice exceeds MATLAB shape of ${name}.`);
          return [start, start + count[i]];
        }).reverse();
      }
      const elements = count.reduce((a, b) => a * b, 1);
      const info: Record<string, unknown> = { class: matlabClass, shape, complex, supported, order: 'column-major' };
      if (include.includes(name)) {
        if (!supported) throw new Error(`Value ${name} is not a supported numeric/logical dataset.`);
        if (elements > maxElements) throw new Error(`${name} has ${elements} selected elements; request a slice or raise max_elements (maximum 16384).`);
        const raw = empty ? [] : ranges ? item.slice(ranges) : item.value;
        if (complex) {
          const pairs = raw as number[][];
          info.data = { real: jsonSafe(pairs.map(p => p[0])), imag: jsonSafe(pairs.map(p => p[1])) };
        } else if (matlabClass === 'logical') {
          info.data = Array.from(raw as ArrayLike<number>, Boolean);
        } else info.data = jsonSafe(raw);
        info.selected_shape = count;
        if (selection) info.start = selection.start;
      }
      return [name, info];
    }));
  } finally { file.close(); }
}
