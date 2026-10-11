# 基本概念

## 条件から結果へたどる

このフレームワークは「どの条件で計算した、何の結果か」をSchemeで定義し、
条件の検索と大きな計算結果の読み込みを分ける。

| 用語 | 意味 |
| --- | --- |
| Scheme | 一つの結果単位の宣言。名前、Key、Value、重複の扱い、Plotを持つ |
| Key | 結果の識別・検索・キャッシュ一致に使う条件。配列も使える |
| Value | 保存する結果の名前。波形やパワー曲線などの本体 |
| RowId | 保存行を指定する`uint64`の番号。保存先とSchemeも併せて扱う |
| Plot | そのSchemeのKey／Valueを入力に取る登録済み描画関数 |
| root | `results`を持つ作業ディレクトリ。実験プロジェクトごとに異なり得る |

例えば`waveform`が`At_in`と`Bt_in`をValueとして保存し、`F`と`detuning`を
Keyとして宣言していれば、その二条件で波形を探せる。これは説明用の例であり、
実際のKeyとValueは対象プロジェクトの宣言で確認する。

Keyは宣言されたものがすべてで、すべてのsolver引数が自動でKeyになるわけではない。
計算に影響する条件がKeyに含まれていなければ、その条件を変えてもキャッシュが
一致し得る。既存Schemeへ勝手にKeyを追加せず、まずその事実を説明する。

## 保存と重複

- SQLiteがKey、RowId、ValueのMATファイルへのパスを持つ。Value本体はMATに保存する。
  数値scalarや文字列はSQLの通常列、数値配列のKeyはNPY BLOBを使う。
- `One`は全Keyが一致する行を一件に制限する。`Many`は同じKeyの複数行を許す。
  どちらも、それ自体でsolverの実行やキャッシュ利用を決める指定ではない。
- `cached`は一致する一件を読み、一致がなければ計算して保存する。
  `recompute`は再計算し、一致する一件があればRowIdを維持してValueを更新する。
  複数件に一致するとどちらも曖昧性のエラーになる。
- Valueを更新すると新しいMATパスを公開する。同じRowIdでも、再計算の前後で
  数値が変わり得る。RowIdを計算内容の不変な版番号として扱わない。
- SQLのNULLは条件不明を表す。数値ゼロや既知の空配列と同じ意味にしない。

## extendsによる宣言と保存先の共有

`child.extends(base)`には親のSchemeオブジェクトを渡す。
Key、Value、取得元、派生Keyの規則、過去行の補完値、cardinality、Plotを引き継ぐ。

追加Keyがなければ、親子は同じSQL行とMATファイルを使う。Scheme名とPlot登録は
分けられるので、同じ結果に異なる表示を付けられる。
新しいKeyを追加すると、子Schemeは専用の保存先を持つ。
共有するSchemeはKey／Valueの定義を揃える。

異なるScheme名の二行を比較するときは`storageId`も確認する。
同じ保存行を別の名前から見ている場合があり、独立した二回の計算とは限らない。
現行の宣言の拡張には`extends`を使う。過去の`Ref`／`inherit`の例を新規実装へ戻さない。

## 宣言のcommitと計算は別の操作

`store.createScheme`は新しい宣言オブジェクトを作る。
`store.commit([schemes...])`は有効な宣言集合を入れ替える。
省いたSchemeの保存データは消さないが、そのSchemeは有効な一覧から外れる。
`scheme.commit()`はそのSchemeだけを更新する。

したがって、既存結果を見るために毎回宣言スクリプトを実行する必要はない。
閲覧は登録済みの宣言を読むところから始める。

参照元: `common/README.md`、`common/docs/result-store.md`、
`common/+store/Scheme.m`、`common/+store/commit.m`。
