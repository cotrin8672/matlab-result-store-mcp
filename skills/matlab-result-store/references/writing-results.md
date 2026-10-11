# Schemeの宣言と保存・再利用

## solverへ保存を付ける

数値計算のsolverをそのまま呼べる形で保ち、保存とキャッシュをdecoratorで付ける。
solverは名前のある`.m`関数で、固定の入力名・出力名を持つ必要がある。
すべてのsolver出力名とすべてのScheme Value名が一致しなければならない。
decoratorにはSchemeオブジェクトを渡す。

次は仕組みを説明する最小の例。リポジトリ直下の空の作業用サブディレクトリに
以下の三ファイルを置き、そのディレクトリをMATLABのcwdにして実行する。
共通MEXが利用可能であることを前提とする。既存の実験条件やsolverの代替ではない。

`solve_scale.m`:

```matlab
function y = solve_scale(x, gain)
y = gain .* x;
end
```

`plot_scale.m`:

```matlab
function plot_scale(parent, x, y)
ax = axes('Parent', parent);
plot(ax, x, y);
end
```

`demo_store.m`:

```matlab
addpath(fullfile("..", "common"));
x = (0:4).';
gain = 2;

scaled = store.createScheme("scaled_signal", "y", "One");
scaled.addKey("x");
scaled.addKey("gain");
scaled.addPlot(@plot_scale);
scaled.commit();

run_cached = store.cached(@solve_scale, scaled);
[y, rowId] = run_cached(x, gain);
data = store.get("scaled_signal", rowId, "y");
disp(data.y);
```

表示される値は列ベクトル`[0; 2; 4; 6; 8]`。
同じ入力で再び`run_cached`を呼ぶとsolverを実行せず保存値を返す。
追加の最終出力が`uint64`のRowIdになる。通常のsolver引数は省略せず渡す。

## Keyの取得元

通常は`scheme.addKey("name")`で同名の条件を宣言する。
派生Keyは`scheme.addDerivedKey("source", "name", transform)`で宣言し、
保存時と検索時に同じ決定的な変換を使う。

decoratorはKeyの取得元を、solver入力、呼出し元workspace、近い親runnerのContextの
順に探す。Contextは同じMATLABプロセス内の同期的なネストに使う。
独立したworkerへ暗黙に受け渡されるものではない。

`addKey("name", ExistingValue=value)`は既存行の不明なNULLを補完する指定であり、
呼出し時に存在しない変数の代わりにはならない。

## 再計算と局所条件

再計算を依頼された場合は`store.recompute(@solve_scale, scaled)`を使う。
返される関数の入力・出力は`cached`と同じ。一致行のValueを更新するので、
既存結果の閲覧や診断のために呼び出さない。

上の例で、呼出し元の`gain`を変えずに一回の条件を変えるなら:

```matlab
run_gain4 = store.scope(run_cached, struct('gain', 4));
[y4, rowId4] = run_gain4(x, gain);
```

`gain`は2のまま、検索・計算・保存はいずれもgain=4で行う。
scopeのフィールド名は固定solver入力名、またはScheme Keyの取得元名に合わせる。
入れ子のscopeでは後から適用した指定が優先する。

solver入力を上書きすると計算に渡す値も変わる。一方、solver入力ではないKey取得元の
上書きはメタデータの変更であり、通常のsolver内部変数を書き換えるものではない。
上書きした値に依存して事前計算された別の引数は自動では再計算されない。

## workspace APIと並列実行

既存runnerが直接APIを使っている場合は、その方式を維持する。

| API | 挙動 |
| --- | --- |
| `store.put(id)` | 呼出し元の宣言済みKey／Valueを読み、新規行を保存する |
| `store.put(id, Overwrite=true)` | One Schemeの一致行を更新する |
| `[found, rowIds] = store.exist(id)` | 呼出し元のKey条件で検索する |
| `data = store.get(id)` | 現在の全Keyに一致する一件を構造体で読む |
| 出力なしの`store.get(id)` | Valueを呼出し元workspaceへ戻す |

これらの保存・条件検索とdecoratorの保存先はcwd。明示的なroot付き読取APIと混同しない。
process workerを使う場合は先にScheme宣言を済ませ、`parfor`からrunnerを呼ぶ。
`parfor`本体でcaller workspaceに依存するStore操作を直接行わない。

参照元: `common/+store/functionNames.m`、`common/+store/wrap.m`、
`common/+store/scope.m`、`common/+store/rust/store-common/src/decorator.rs`、
`common/+store/rust/store-common/src/io.rs`。
