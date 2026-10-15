# MCPで保存結果を読む・解析する

閲覧画面は同じ会話で基本1つを使う。`render_plot`は図の取得と同時にMatlabResults画面にも表示するため、続けて`open_browser`を呼ぶ必要はない。
図を指定せず閲覧画面だけを開くときは`open_browser`を使う。検索・配列取得・注釈のために画面を追加しない。

保存先は各ツールの`directory`に任意の絶対パスを渡して指定する。直下に`results/store.sqlite`が必要。省略時は設定済みの既定フォルダを使う。
`list_stores({directory: "絶対パス"})`でそのフォルダ自身と直下の子フォルダにある保存先を探せる。画面のDirectory欄でも切り替えられ、既定の設定を書き換えない。特定のプロジェクト名には依存しない。

1. `list_schemes`で対象の保存先、Scheme、Key、Value、Plot、件数を確認する。
2. `search_results`の`filters`に条件を指定し、比較対象のRowIdを確定する。
   条件はAND。一致・複数選択・範囲・下限・上限・文字列の部分一致などに対応する。
   `contains`は大文字・小文字を区別する。NULLは過去の不明な条件。
   配列Keyは`list_candidates`から候補を取得し、返された`value`をそのままフィルタに渡す。
   表示ラベルから配列を復元しない。`not_in`は「すべて」の候補から指定値を除外する。
3. `get_result`で条件とValueの型・サイズを確認する。
4. `render_plot`で登録済みPlotのPNGを見る。図の軸・単位・正規化を確かめて解釈する。
   描画完了後、MatlabResults画面に対象が表示される。連続した表示は同じUIセッションを使う。別ディレクトリでも`directory`を指定すれば切り替わる。
   描画専用MATLABで元のPlot関数を実行し、描画された線・軸からブラウザの図を生成する。
   既存の有効なfig2plotly出力も使える。`source: cache`はNodeキャッシュ、`source: live`は共有MATLAB。
   `preview_available: false`の場合はPNGを見たと主張しない。画像が必要なら`refresh: true`で取得する。
5. 精密な数値が必要なときだけ、`get_result`の`include_values`に必要なValueを指定する。

比較する図は`pin_plot`に`directory`・`scheme`・`row_id`・`plot_index`を渡してピン留めできる。画面ではPlotヘッダーの「Pin」を使う。
ページ下部のPinned Canvasに図が並び、別Scheme・別ディレクトリへ移っても残る。ピンは図・保存条件・その時点のAI注釈を固定したスナップショットで、元の結果の更新には追従しない。同じ保存payloadを再びピン留めしても重複しない。
`list_pinned_plots`は一覧と図のresource URIを返し、`unpin_plot({pin_id: "..."})`は指定したピンだけを解除する。通常のPlotキャッシュと異なり、ピンは個人用設定と同じ場所の`pins/`に保存される。

図の解釈を示すには`annotate_plot`を使う。`point_label`は`x`・`y`・`text`、`xline`は`x`、`yline`は`y`を指定し、線にも`text`を付けられる。
座標はデータ単位。`xaxis`・`yaxis`は対象のsubplotのPlotly軸名を指定する（省略時`x`・`y`）。軸の対応はPlotly JSONで確認する。
`annotations`はAI注釈の一覧全体を置き換える。既存のAI注釈は`render_plot`の`plot_annotations`または`annotations_uri`で確認し、保持する分も含める。空配列でAI注釈だけを消す。
注釈は保存され、既存の閲覧画面にも対象の図が表示される。同じ図への変更は注釈だけを更新する。別の結果には適用されない。注釈を表示するために新しいタブを開かない。
`render_plot`のPNGは元のMATLAB図。注釈はHTML・Plotly JSON・ブラウザの図と手動追加した画像に含まれる。

RowIdは十進文字列で渡す。配列はMATLABの列優先順で、複素数は`data.real`と`data.imag`。
`slice.start`は**0始まり**、`slice.count`は各次元の要素数。次元の順序はMATLABの
`shape`と同じ。取得上限は既定4096要素、最大16384要素。NaN/Infと64bit整数は文字列。

「コンテキストに追加」を押すと、その時点のディレクトリ・Scheme・RowId・Plot・条件と図の画像が添付される。
閲覧やSweepでは添付内容は自動更新されない。添付された選択を対象として回答する。別結果を参照するときはそのRowIdを明示する。
画像に表示されない履歴や成分は補わない。小さい数値の差は元データで確認する。

検索と配列取得はSQLite・MATファイルを直接読む。図やPlot一覧が必要なときだけ、
MCPが共通のMATLABを1つだけ自動起動し、全チャット・全Directoryで共有する。チャット切り替えやMCP再接続でも同じプロセスを再利用する。要求ごとのDirectoryで関数・作業フォルダを切り替え、配列・Plot・Jobの保存先を混同しない。各DirectoryのResult Storeフレームワークは互換版を使う。計算用MATLABがBusyでも描画できる。
`resultstore.connect`の手動実行は不要。必要なパスはセットアップSkill・READMEにある。
オフラインの図が未出力・古い場合は`resultstore.exportPlot(scheme, rowId, plotIndex, root)`でも準備できる。

ライブ描画は2-Dの`scatter`にも対応する。点の色とサイズに加え、カラーマップ・色範囲・カラーバー・数値のDataTip行も取得でき、scatterのためにExportへ切り替える必要はない。
セットアップはリポジトリのREADMEにある。閲覧の準備としてsolverやプロジェクトの
`store.m`を実行しない。未出力の図を見たと主張しない。

現時点でValueの読み出しはv7.3 MATの密な数値・logical配列に対応する。
struct/cellの展開には未対応。対応外の値は推測で復元しない。

ライブ描画の`known_revision`は差分を受け取るブラウザ向け。通常のツール呼び出しでは省略する。
`include_preview`は既定trueでMATLABのPNGを返す。ブラウザはfalseを使い、自分で画像を生成する。
最大128件・256MiBのLRUキャッシュをOSの一時フォルダで共有する。キャッシュがあればMATLABへ問い合わせず、Busy・終了中やMCP再接続後も閲覧できる。
保存結果のpayload差し替えで別キャッシュになる。Plot関数を編集した場合や同じ結果を再描画する場合は`refresh: true`を指定する。描画専用プロセスが応答しない場合も、
AIが別途MATLABを起動して回避しない。ライブ描画に未対応の要素を、表示できたものとして扱わない。

GUIはFixed条件でテーブルと各パラメータの候補を絞り、Parametersで一致する結果を選ぶ。
`search_results`の`parameters`を使う場合、`rows`/`total`はFixedの一覧であり、両段の
評価件数は`matched_total`。`first_match`は1件のときだけ自動選択に使う。複数件から
勝手に先頭を選ばない。パラメータ間で候補を絞り合わないため、存在しない組み合わせは
該当なしになる。行選択は一致パラメータを同期し、範囲条件は保持する。

## 非同期MATLAB解析

通常は`run_matlab_background`に`code`と必要な変数名の`outputs`を渡す。MCP用MATLABのbackgroundPoolで実行し、ジョブIDをすぐ返す。コードは独立した関数ワークスペースで動き、保存先stringの`root`が使える。対話セッションの変数は共有しない。

描画やthread非対応関数・MEXが必要なときは`run_matlab_worker`を使う。R2024aの`run`・`cd`・`clearvars`はthread非対応なので、既存スクリプトもworkerで`run(...)`を使う。Parallel Computing Toolboxが必要で、追加のプロセスworkerを1つ起動・再利用する。失敗後にbackendを変えて再実行すると副作用が重複することがあるため、エラーと実行内容を確認して選ぶ。

既存スクリプトの`parfor`・`spmd`を実際に並列実行するには`run_matlab_parallel`を使い、`directory`・`code`・`outputs`に加え、プールのworker数`workers`を明示する。共有MATLABのクライアントから`batch`を投入するので、計算中もPlotのメインスレッドを使える。`run_matlab_worker`の中から`batch`や`parcluster`を呼ばない。
`workers`とは別にbatchドライバが1プロセス必要。Processesプロファイルの上限と空きCPU・メモリに収める。ジョブの状態・ログ・出力・キャンセル・Eventsは他の実行ツールと同じ。監視MATLABが終了した場合は保存したbatch IDから再接続し、同じ計算を再投入しない。
旧バージョンのMCP描画用MATLABは、実行中のMCPジョブがないときだけ自動で更新する。対話・CLIの計算用MATLABには触れない。

`get_matlab_job`は即時に状態・標準出力の末尾65536文字・エラー・出力メタデータを返す。状態はqueued/running/succeeded/failed/cancelled。成功した変数だけを`include_values`で取得し、大きい配列は`slice`で絞る。列優先順、複素数、64bit整数、取得上限は`get_result`と同じ。`list_matlab_jobs`でMCP接続をまたいだ最近のジョブを確認できる。

`cancel_matlab_job`の`cancel_requested`は中止要求であり、中止完了ではない。最終状態を確認する。実行済みのファイル書き込みは巻き戻らない。保存結果の解析という依頼だけで、solver・Scheme・元データの書き換えを実行しない。

ホストがMCP Eventsに対応する場合、`events/subscribe`で`matlab.job.finished`と`{"job_id":"<ID>"}`を購読する。既定以外の保存先のジョブでは購読引数にも`directory`を渡す。通知は成功・失敗・中止の最終状態と結果URIを含む。通知を受けてから`get_matlab_job`でログ・値を読む。ホストが用意したwebhookを使い、AIが自分でcallbackや署名secretを作って自動再開を装わない。

公式の対応先はWork web、Work Cloud、Dots。ローカルCodexの自動再開は未確認で、非対応ホストでは`get_matlab_job`を使う。ジョブ状態・出力・未送信通知はOSの一時フォルダに保存され、MCP再接続では維持する。MATLABが終了したbackground/workerの実行中ジョブは失敗になる。OSによる一時ファイルの清掃後まで保持する保証はない。

MCPプロセス再起動後、既定以外の保存先のジョブ監視は、その`directory`を指定したジョブ取得・一覧・購読などの操作で再開する。
