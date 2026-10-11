# 保存結果の検索と画像による解釈

## 対象を特定する

`common`と対象プロジェクトのPlot関数をMATLABパスへ追加する。
`root`は保存先の作業ディレクトリ、`id`は選んだScheme名とする。

```matlab
schemes = store.loadSchemes(root);
schemeIds = keys(schemes);
scheme = store.loadScheme(id, root);
```

`scheme.keys`、`scheme.values`、`scheme.storageId`、`scheme.plots`を確認する。
同じScheme名が別の保存先にもあり得るため、rootを省略したまま別実験を読まない。
閲覧のために対象の`store.m`を実行したり宣言をcommitしたりする必要はない。

## 先にKeyを検索する

件数が大きい場合はGUIと同じSQLの読取経路を使う。
以下は[保存の例](writing-results.md)の`scaled_signal`で、gain=2を探す場合。

```matlab
root = string(pwd);
id = "scaled_signal";
source = store.browse("source", id, root);
filters = struct('Key', "gain", 'Operator', "isEqual", 'Value', 2);
stats = store.browse("stats", source, filters, uint64(0));
page = store.browse("page", source, filters, 1, 20, "", false);
candidates = store.browse("candidates", source, "gain", filters, true, 1, 20);
```

`stats.Count`は該当件数。pageの開始位置は1始まりで、上の例は最大20行を取得する。
空のsortKeyはRowId順、最後のlogicalは降順指定。candidatesは保存済み候補値のcell配列。
候補にない中間値を保存結果として扱わない。

filtersの各要素は`Key`、`Operator`、`Value`を持ち、複数要素はANDで結合する。
SQL読取の主なoperatorは`isEqual`、`oneOf`、`notOneOf`、`between`、`>=`、`<=`、
`contains`。`oneOf`などの複数値と`between`の上下限にはcell配列を渡す。
GUIのクエリ名と内部operator名は同一とは限らない。

小さいKey一覧をMATLAB上で扱う場合は次も使える:

```matlab
D = store.queryTable("scaled_signal", root);
Q = query.isEqual("gain", 2);
R = Q(D);
```

`queryTable`は全Key行をMATLABへ取得する。`query.*`はそのテーブルを絞る関数であり、
SQLページ取得とは別の経路。`query.isEqual`の配列比較は`isequaln`、
`query.oneOf`は候補値のcell配列を使う。

## RowIdを選び、必要なValueを読む

検索で返った`page.RowId`や`R.RowId`から目的の結果を選ぶ。
複数件ある場合は比較対象として扱うか、ユーザーの条件で一件へ絞る。
RowIdが小さいことだけを理由に先頭行を採用しない。
以下の`rowId`は選択済みの`uint64`、`valueNames`は必要なValue名のstring配列とする。

```matlab
row = store.getRecordRow(id, rowId, root);
data = store.get(id, rowId, valueNames, root);
payloadPath = store.getRecordPath(id, rowId, root);
```

`store.get`の出力を受け、解析のためにcaller workspaceを置き換えない。
RowId指定の読取では現在のworkspaceのKeyを検索条件にしない。
大きな配列をそのまま会話へ列挙せず、必要な画像や指標を返す。

## 既存Plotを画像として見る

目的に合う`scheme.plots`の登録を選び、その関数の実装を確認する。
`Name`がPlot名、`Inputs`が宣言順の`Key.name`／`Value.name`、`Function`が描画関数。
`plotIndex`は選択した登録の番号、`id`／`root`／`rowId`は上で特定した結果とする。

Figureをparentに取れるPlotでは、例えば次のように画像化できる:

```matlab
scheme = store.loadScheme(id, root);
spec = scheme.plots(plotIndex);
inputs = store.getValue(id, rowId, spec.Inputs, root);
imagePath = string(tempname) + ".png";
f = figure('Visible', 'off');
spec.Function(f, inputs{:});
drawnow;
print(f, char(imagePath), '-dpng', '-r150');
close(f);
```

`getValue`は入力順のcell配列を返し、必要なValueだけをMATから読む。
parentの型に制約があるPlotでは、既存GUIが使う親コンテナに合わせて描画方法を選ぶ。
画像化のためにPlotの式、正規化、描画する成分を変更しない。
使える画像閲覧ツールで生成画像を開いて確認する。ファイルを作ったことだけを
根拠に「図を見ると」と述べない。

比較では軸範囲、単位、線形／対数、FFTの規約、正規化、表示成分を確認する。
図の情報が不足する場合は、元のPlot／solverで分かる範囲を添え、不明な単位などを
作らない。画像に表示されない位相や、終状態に含まれない途中の履歴は判断できない。

## 数値による確認と取得元

画像で概観し、必要なら表示範囲を拡大する。正確なピーク位置、帯域幅、積分値、
微小差などは元データから計算する。定義と正規化は既存の実装やユーザーの指定に
合わせる。画像での見立てだけで数値精度や状態の安定性を確定しない。

結果にはroot、Scheme、RowId、比較条件、Plot名と画像を添える。
同じRowIdのValueが再計算で変わり得るため、再現性が必要なら読取時点のMATパスも
控える。実行中の更新が疑われる場合は、その時点で同じ保存内容を読めたか確認する。

MCPやUIが接続されている環境では、選択した結果IDと条件をモデルへ渡し、画像も
モデルが参照できる経路で渡す。UIに描画されただけでAIにも画像が届いたとは考えない。
利用可能なツールの仕様を確認し、存在しない画像取得・解析ツールを仮定しない。

参照元: `common/+store/browse.m`、`common/+store/queryTable.m`、
`common/+store/getValue.m`、`common/+store/getRecordRow.m`、
`common/+store/getRecordPath.m`、`common/docs/query-browser.md`。
