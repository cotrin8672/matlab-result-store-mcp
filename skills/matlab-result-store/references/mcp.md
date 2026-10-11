# MCPで保存結果を読む

1. `list_schemes`で対象の保存先、Scheme、Key、Value、Plot、件数を確認する。
2. `search_results`の`filters`に条件を指定し、比較対象のRowIdを確定する。
   条件はAND。スカラーKeyの一致・範囲などに対応する。NULLは過去の不明な条件。
3. `get_result`で条件とValueの型・サイズを確認する。
4. `render_plot`で登録済みPlotのPNGを見る。図の軸・単位・正規化を確かめて解釈する。
   インタラクティブ表示は、そのFigureをfig2plotlyで変換したもの。
5. 精密な数値が必要なときだけ、`get_result`の`include_values`に必要なValueを指定する。

RowIdは十進文字列で渡す。配列はMATLABの列優先順で、複素数は`data.real`と`data.imag`。
`slice.start`は**0始まり**、`slice.count`は各次元の要素数。次元の順序はMATLABの
`shape`と同じ。取得上限は既定4096要素、最大16384要素。NaN/Infと64bit整数は文字列。

画面からの選択にはScheme・RowId・Plot・条件と元のMATLAB画像が添付される。
その選択を対象として回答する。別結果を参照するときはそのRowIdを明示する。
画像に表示されない履歴や成分は補わない。小さい数値の差は元データで確認する。

MCPはMATLABを起動せず、保存結果を変更しない。Plotが未出力・古い場合は、既存の
MATLABセッションで`resultstore.exportCatalog(root)`または
`resultstore.exportPlot(scheme, rowId, plotIndex, root)`による出力が必要と伝える。
セットアップはリポジトリのREADMEにある。閲覧の準備としてsolverやプロジェクトの
`store.m`を実行しない。未出力の図を見たと主張しない。

現時点でValueの読み出しはv7.3 MATの密な数値・logical配列に対応する。
struct/cellの展開と配列Keyによる絞り込みには未対応。対応外の値は推測で復元しない。
