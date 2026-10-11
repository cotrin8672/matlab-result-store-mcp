export type QueryKind = 'number' | 'logical' | 'text' | 'value';
export type QueryValue = string | number | boolean | null | { candidate: string };
export type Filter = {
  key: string;
  op: 'eq' | 'ne' | 'gte' | 'lte' | 'between' | 'in' | 'not_in' | 'contains' | 'is_null' | 'false';
  value?: QueryValue | QueryValue[];
};
export type Candidate = { index: number; value: QueryValue; label: string; raw: unknown };
export type Domain = { total: number; candidates: Candidate[]; locations: (Candidate | null)[] };

// Names, evaluation stages and controls follow common/query_browser.mlapp.
export const queries = [
  { name: 'isEqual', mode: 'Fixed', op: 'eq', control: 'select' },
  { name: 'oneOf', mode: 'Fixed', op: 'in', control: 'choices' },
  { name: 'between', mode: 'Fixed', op: 'between', control: 'bounds' },
  { name: 'atLeast', mode: 'Fixed', op: 'gte', control: 'number' },
  { name: 'atMost', mode: 'Fixed', op: 'lte', control: 'number' },
  { name: 'contains', mode: 'Fixed', op: 'contains', control: 'text' },
  { name: 'sweepValue', mode: 'Parametric', op: 'eq', control: 'slider' },
  { name: 'selectValue', mode: 'Parametric', op: 'eq', control: 'select' },
  { name: 'selectValues', mode: 'Parametric', op: 'in', control: 'list' },
  { name: 'chooseValues', mode: 'Parametric', op: 'in', control: 'choices' },
  { name: 'sweepRange', mode: 'Parametric', op: 'between', control: 'range' },
  { name: 'setRange', mode: 'Parametric', op: 'between', control: 'bounds' },
  { name: 'sweepMinimum', mode: 'Parametric', op: 'gte', control: 'slider' },
  { name: 'setMinimum', mode: 'Parametric', op: 'gte', control: 'number' },
  { name: 'sweepMaximum', mode: 'Parametric', op: 'lte', control: 'slider' },
  { name: 'setMaximum', mode: 'Parametric', op: 'lte', control: 'number' },
  { name: 'searchText', mode: 'Parametric', op: 'contains', control: 'text' },
] as const;
export type QueryDefinition = typeof queries[number];

export function queriesFor(kind: QueryKind) {
  return queries.filter(q => q.op === 'eq' || q.op === 'in' || (kind === 'number' && ['between', 'gte', 'lte'].includes(q.op)) || (kind === 'text' && q.op === 'contains'));
}
