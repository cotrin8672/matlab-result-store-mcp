# トラブル対応

原因を確認するための資料。診断だけを依頼された場合は、Schemeや保存済み結果を
変更しない。エラー名と実際に呼んだAPI、root、Scheme、条件を対応づける。

| 症状 | 最初に確認すること |
| --- | --- |
| Schemeが見つからない | root、登録済みScheme一覧、対象の宣言。別実験のcwdを使っていないか |
| `store:MissingKey` | Keyの取得元名。decoratorならsolver入力、caller、近い親Contextの順で確認する。`ExistingValue`では呼出し時の欠落は補えない |
| `store:MissingValue` | decoratorではsolver出力名とValue名が全て一致するか。`put`ではcallerにValue変数があるか。`get`では要求名が宣言済みValueか |
| `store:AmbiguousRecord` | 同じKeyに複数行があるか。直接読取ならRowIdを指定する。decoratorは曖昧な複数行を自動選択しない |
| 条件を変えたのにキャッシュが一致する | 変えた条件が宣言済みKeyか、派生Keyの変換後に同値になっていないか、実際の取得元がどこか |
| solverのコードを変えたのに以前の値が返る | キャッシュはKeyで決まり、solverのコード変更を自動で識別しない。再計算を依頼された場合に`recompute`を使う |
| `store:InvalidSolver` | 名前のある`.m`関数か、固定の入力・出力宣言か。匿名関数や`varargin`／`varargout`をdecoratorへ渡していないか |
| `store:InvalidOverride`／`store:InvalidRunner` | scopeのフィールドがsolver入力名またはKey取得元名か。runnerが`cached`／`recompute`／`scope`から返されたものか |
| scopeの記録条件と計算が合わない | 上書き対象がsolver入力か、メタデータだけのKey取得元か。事前に求めた依存引数も必要に応じて指定されているか |
| `store:RecordNotFound` | 保存先、Scheme、RowId、全Key条件。番号だけを別の保存先へ持ち込んでいないか |
| `store:MissingRecordFile` | 登録されたMATパスの実在。別のファイルで勝手に代用せず欠落を報告する |
| Plotが登録・実行できない | 関数のMATLABパス、最初のparent引数、残りの引数名とScheme Key／Valueの一致、実際に渡したparentの型 |
| 同じRowIdなのに図が以前と違う | `recompute`等によるValue更新、MATパス、Plot実装、図のスケール。RowIdは内容の版番号ではない |
| GUIに同じRowIdの更新が現れない | ブラウザの更新操作で再読込したか。既存データを変更して対処しない |
| `parfor`でworkspace取得が失敗する | 本体で直接caller依存APIを呼んでいないか。runner内での呼出し、workerのパス、各プロセスのContextを確認する |

共通MEXが見つからない場合はMATLABパスと`common/build_store.m`の現行手順を確認する。
ソースを読めたことと、MEXをビルド・実行できたことは区別する。

参照元: `common/+store/wrap.m`、`common/+store/scope.m`、
`common/+store/functionNames.m`、`common/+store/rust/store-common/src/io.rs`、
`common/+store/rust/store-common/src/decorator.rs`、`common/docs/query-browser.md`。
