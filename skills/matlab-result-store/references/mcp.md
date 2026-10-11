# MCPで保存結果を読む

1. `list_schemes`で対象の保存先、Scheme、Key、Value、Plot、件数を確認する。
2. `search_results`の`filters`に条件を指定し、比較対象のRowIdを確定する。
   条件はAND。一致・複数選択・範囲・下限・上限・文字列の部分一致などに対応する。
   `contains`は大文字・小文字を区別する。NULLは過去の不明な条件。
   配列Keyは`list_candidates`から候補を取得し、返された`value`をそのままフィルタに渡す。
   表示ラベルから配列を復元しない。`not_in`は「すべて」の候補から指定値を除外する。
3. `get_result`で条件とValueの型・サイズを確認する。
4. `render_plot`で登録済みPlotのPNGを見る。図の軸・単位・正規化を確かめて解釈する。
   ライブ接続では既存MATLABで元のPlot関数を実行し、描画された線・軸からブラウザの図を生成する。
   接続がない場合は保存済みのfig2plotly出力を使う。`source: live`を確認すると区別できる。
5. 精密な数値が必要なときだけ、`get_result`の`include_values`に必要なValueを指定する。

RowIdは十進文字列で渡す。配列はMATLABの列優先順で、複素数は`data.real`と`data.imag`。
`slice.start`は**0始まり**、`slice.count`は各次元の要素数。次元の順序はMATLABの
`shape`と同じ。取得上限は既定4096要素、最大16384要素。NaN/Infと64bit整数は文字列。

画面からの選択にはScheme・RowId・Plot・条件と、表示中のブラウザの図の画像が添付される。
その選択を対象として回答する。別結果を参照するときはそのRowIdを明示する。
画像に表示されない履歴や成分は補わない。小さい数値の差は元データで確認する。

MCPはMATLABを起動せず、保存結果を変更しない。図の接続がない場合は、既存の
MATLABセッションで`resultStoreConnection = resultstore.connect(root)`を一度実行する。
必要なパスと接続手順はセットアップSkill・READMEにある。
オフラインの図が未出力・古い場合は`resultstore.exportPlot(scheme, rowId, plotIndex, root)`でも準備できる。
セットアップはリポジトリのREADMEにある。閲覧の準備としてsolverやプロジェクトの
`store.m`を実行しない。未出力の図を見たと主張しない。

現時点でValueの読み出しはv7.3 MATの密な数値・logical配列に対応する。
struct/cellの展開には未対応。対応外の値は推測で復元しない。

ライブ描画の`known_revision`は差分を受け取るブラウザ向け。通常のツール呼び出しでは省略する。
`include_preview`は既定trueでMATLABのPNGを返す。ブラウザはfalseを使い、自分で画像を生成する。
同じ結果の再描画には`refresh: true`を指定する。長い計算中などMATLABが応答しない場合、
新しいMATLABを起動して回避しない。ライブ描画に未対応の要素を、表示できたものとして扱わない。

GUIはFixed条件でテーブルと各パラメータの候補を絞り、Parametersで一致する結果を選ぶ。
`search_results`の`parameters`を使う場合、`rows`/`total`はFixedの一覧であり、両段の
評価件数は`matched_total`。`first_match`は1件のときだけ自動選択に使う。複数件から
勝手に先頭を選ばない。パラメータ間で候補を絞り合わないため、存在しない組み合わせは
該当なしになる。行選択は一致パラメータを同期し、範囲条件は保持する。
