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
  { name: 'isEqual', mode: 'Fixed', op: 'eq', control: 'select', hint: '選んだ値と一致する結果にテーブルを絞ります（Fixed）。' },
  { name: 'oneOf', mode: 'Fixed', op: 'in', control: 'choices', hint: '選んだ複数の値のいずれかと一致する結果にテーブルを絞ります（Fixed）。' },
  { name: 'between', mode: 'Fixed', op: 'between', control: 'bounds', hint: '入力した下限以上・上限以下の結果にテーブルを絞ります。両端を含みます（Fixed）。' },
  { name: 'atLeast', mode: 'Fixed', op: 'gte', control: 'number', hint: '入力した値以上の結果にテーブルを絞ります。指定値を含みます（Fixed）。' },
  { name: 'atMost', mode: 'Fixed', op: 'lte', control: 'number', hint: '入力した値以下の結果にテーブルを絞ります。指定値を含みます（Fixed）。' },
  { name: 'contains', mode: 'Fixed', op: 'contains', control: 'text', hint: '入力した文字列を含む結果にテーブルを絞ります（Fixed）。' },
  { name: 'sweepValue', mode: 'Parametric', op: 'eq', control: 'slider', hint: 'スライダーで選んだ値と一致する結果をPlot用に選びます。テーブルは変わりません（Parametric）。' },
  { name: 'selectValue', mode: 'Parametric', op: 'eq', control: 'select', hint: 'ドロップダウンで選んだ値と一致する結果をPlot用に選びます。テーブルは変わりません（Parametric）。' },
  { name: 'selectValues', mode: 'Parametric', op: 'in', control: 'list', hint: '一覧で選んだ複数の値のいずれかと一致する結果をPlot用に選びます。テーブルは変わりません（Parametric）。' },
  { name: 'chooseValues', mode: 'Parametric', op: 'in', control: 'choices', hint: '選択パネルで指定した複数の値のいずれかと一致する結果をPlot用に選びます。テーブルは変わりません（Parametric）。' },
  { name: 'sweepRange', mode: 'Parametric', op: 'between', control: 'range', hint: 'スライダーで指定した下限以上・上限以下の結果をPlot用に選びます。両端を含み、テーブルは変わりません（Parametric）。' },
  { name: 'setRange', mode: 'Parametric', op: 'between', control: 'bounds', hint: '入力した下限以上・上限以下の結果をPlot用に選びます。両端を含み、テーブルは変わりません（Parametric）。' },
  { name: 'sweepMinimum', mode: 'Parametric', op: 'gte', control: 'slider', hint: 'スライダーで指定した値以上の結果をPlot用に選びます。指定値を含み、テーブルは変わりません（Parametric）。' },
  { name: 'setMinimum', mode: 'Parametric', op: 'gte', control: 'number', hint: '入力した値以上の結果をPlot用に選びます。指定値を含み、テーブルは変わりません（Parametric）。' },
  { name: 'sweepMaximum', mode: 'Parametric', op: 'lte', control: 'slider', hint: 'スライダーで指定した値以下の結果をPlot用に選びます。指定値を含み、テーブルは変わりません（Parametric）。' },
  { name: 'setMaximum', mode: 'Parametric', op: 'lte', control: 'number', hint: '入力した値以下の結果をPlot用に選びます。指定値を含み、テーブルは変わりません（Parametric）。' },
  { name: 'searchText', mode: 'Parametric', op: 'contains', control: 'text', hint: '入力した文字列を含む結果をPlot用に選びます。テーブルは変わりません（Parametric）。' },
] as const;
export type QueryDefinition = typeof queries[number];

export function queriesFor(kind: QueryKind) {
  return queries.filter(q => q.op === 'eq' || q.op === 'in' || (kind === 'number' && ['between', 'gte', 'lte'].includes(q.op)) || (kind === 'text' && q.op === 'contains'));
}
