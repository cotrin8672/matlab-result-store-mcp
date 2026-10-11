# MATLAB Result Store MCP

MATLAB Result Storeに保存された結果を検索し、図を見ながらAIと会話するためのMCPサーバーとPlugin Extension。

- **MCP**: Scheme一覧、条件検索、MATファイルの読み出し、登録済みPlotの取得。
- **Skill**: 保存フレームワークの概念・利用手順・結果解釈・トラブル対応。
- **Extension**: Schemeと条件を画面で選び、Plotlyで拡大・縮小し、選択した結果について質問する。

検索と配列取得はSQLiteとv7.3 MATを直接読み、MATLABを必要としない。図は1つの共有された描画専用MATLABで、登録済みPlot関数の描画結果から生成する。PlotごとのTS関数は不要で、数式や正規化は元のMATLAB関数を使う。保存済みのfig2plotly出力も引き続き開ける。

## Codex Appへ導入する

Node.js 24以上が必要。依存関係は利用可能なpnpm、なければnpm経由で準備する。
Codexが提供するNode.js・pnpmも利用できる。pnpmの手動インストールや、閲覧用MATLABの手動起動は不要。描画にはMATLABが必要。

1. Pluginsの「Add a marketplace」を開く。
2. Sourceに`https://github.com/cotrin8672/matlab-result-store-mcp`を入力して追加する。
   Git refとSparse pathsは空欄でよい。
3. Marketplaceの「MATLAB Result Store」をインストールする。
4. Pluginのセットアップを実行し、`results/store.sqlite`がある保存フォルダを指定する。
   「MATLAB Result Storeをセットアップして。保存先は○○」と依頼してもよい。
5. 新しいチャットでPluginを選び、「保存結果を開いて」と依頼する。

`.agents/plugins/marketplace.json`でこのリポジトリ自体をPluginとして公開している。
アプリから追加したMarketplaceは個人用設定で利用できる。アプリのURL入力に相当するCLI操作:

```powershell
codex plugin marketplace add https://github.com/cotrin8672/matlab-result-store-mcp
codex plugin add matlab-result-store@matlab-result-store
```

セットアップ用Skillは、実際にインストールされたコピーで依存関係を導入し、UIをビルドする。
MCPの初回起動でも同じ準備を行うため、初回だけパッケージ取得にネットワークを使う。
準備済みなら次の起動ではインストールとビルドを省略する。保存先が未設定でもMCPは接続でき、
結果を読むときにセットアップを案内する。初回の準備に備え、MCPの起動待ち時間は120秒にしている。

保存先は通常`~/.codex/matlab-result-store/store.local.json`に保持する。
`CODEX_HOME`があればその配下、`PLUGIN_DATA`があればそのディレクトリを使う。
MCPにだけ`PLUGIN_DATA`が渡されても、その中に設定がなければ通常の個人用設定を読む。
Pluginのキャッシュを更新しても設定は残る。保存フォルダを変える場合もセットアップを使う。
個人用の設定は最後に指定した1フォルダで、新しいチャットから反映される。

対象は既存のResult Store形式の`results/store.sqlite`とMATファイルを持つプロジェクト。
保存フレームワークや実験データはこのリポジトリに含まれない。図の表示には、後述の描画専用MATLAB、または保存済みのPlot出力を使う。MCP Apps UIの表示はホストの対応に依存する。

## 開発用セットアップ

Node.js 24以上とpnpmが必要。

```powershell
ghq get https://github.com/cotrin8672/matlab-result-store-mcp
Set-Location (Join-Path (ghq root) "github.com/cotrin8672/matlab-result-store-mcp")
pnpm install --frozen-lockfile
pnpm build
```

対象は既存のResult Store形式の`results/store.sqlite`とMATファイルを持つプロジェクト。保存フレームワークや実験データはこのリポジトリに含まれない。

## 描画専用MATLABを共有する

図やPlot一覧が必要なときに、MCPが保存先ごとに描画専用MATLABを1つだけ自動起動する。別のMCP接続やタブからも同じプロセスを共有する。計算用MATLABには接続しないので、そのセッションがBusyでも保存済み結果を描画できる。手動の`resultstore.connect(root)`は不要。

`matlab`をPATH上に置く。フレームワークの`common`は保存先から祖先をたどって検出し、保存先とPluginの`matlab`フォルダをパスに追加する。`common`が別の場所にある場合は、MATLAB標準の`MATLABPATH`に追加する。solverや`store.m`は実行しない。起動は[MATLAB標準の非対話モード](https://www.mathworks.com/help/matlab/ref/matlabwindows.html)を使い、画面を開かない。初回の起動だけ待ち時間がある。

非表示のFigureを使い回し、Plot関数自身の軸・線の更新処理をそのまま使う。結果ごとのExportやfig2plotlyのインストールは不要。

初回は系列・軸・タイトルなどを送り、次回からは変更された系列のフィールド（`x`、`y`など）と軸設定だけを送る。ブラウザは既存の図へ`Plotly.update`でまとめて反映する。系列数や構成が変わった場合、または差分の基準が一致しない場合は図全体を送る。操作が続いている間の古い描画要求はブラウザ側で省く。

同じ結果・Plotの再取得ではMATの読み込みとMATLAB描画を省く。「更新」は保存結果を読み直してPlotを再実行するため、Plot関数の編集にも追従する。ブラウザ操作ではPNG・HTMLをMATLABで毎回保存せず、AIへ渡す画像は手動追加時にブラウザで生成する。`render_plot`を直接呼ぶ場合は既定でMATLABのPNGを返す。

通信にはMATLAB標準のtimerとローカルの一時ファイルを使う。Pythonや追加Toolboxは不要。`results/web/worker.json`には接続情報だけを保存する。起動中のプロセス情報は一時フォルダのSQLiteで共有して重複起動を防ぐ。起動失敗時のログの場所はエラーに表示する。

## オフライン用に既存Plotを出力する

Plotly MATLABを別途取得する。以下は動作確認に使ったコミット。

```powershell
git clone https://github.com/plotly/plotly_matlab.git vendor/plotly_matlab
git -C vendor/plotly_matlab checkout 662ab5dca1879b683c0735e477ba552b67c3eea4
```

既存のMATLABセッションで、保存フレームワークの`common`、対象プロジェクト、変換ヘルパーをパスに追加する。次のパスは実際の保存先に置き換える。

```matlab
pluginRoot = "path/to/matlab-result-store-mcp";
frameworkRoot = "path/to/LLE";
root = fullfile(frameworkRoot, "PhCR");
addpath(fullfile(frameworkRoot, "common"));
addpath(root);
addpath(fullfile(pluginRoot, "matlab"));
addpath(genpath(fullfile(pluginRoot, "vendor", "plotly_matlab")));

% 登録済みのSchemeとPlot一覧を出力する。
resultstore.exportCatalog(root);

% 例: waveformのRowId 1、登録順で1番目のPlotを出力する。
resultstore.exportPlot("waveform", uint64(1), 1, root);
```

`exportPlot`は保存されたValueを登録済みのPlot関数へ渡し、元のFigureのPNG、Plotly JSON、単体で開けるHTMLを`root/results/web/<scheme>/<rowId>/<plotIndex>/`に出力する。Plotly.jsとMathJaxはローカルに同梱し、閲覧時のCDNアクセスやPlotlyログインは不要。

プロジェクトの`store.m`やsolverは実行しない。同じRowIdの再計算でMATファイルが変わった場合、古いPlotはMCP側で拒否する。Plot関数自体を編集した場合も、手動で再出力する。

## ローカルで画面を使う

```powershell
pnpm preview "path/to/project" 8732
```

`http://127.0.0.1:8732`を開く。Schemeを選び、「＋ Query」でKeyとクエリを追加する。操作はMATLABの`query_browser`に合わせている。

- Fixed: `isEqual`、`oneOf`、`between`、`atLeast`、`atMost`、`contains`。
- Parameters: `sweepValue`、`selectValue`、`selectValues`、`chooseValues`、`sweepRange`、`setRange`、`sweepMinimum`、`setMinimum`、`sweepMaximum`、`setMaximum`、`searchText`。

各Keyの型で使えるクエリを表示する。固定条件はANDで評価し、各パラメータの候補はその固定条件だけから取得する。スライダーは保存済み候補を動かし、存在しない中間値を作らない。他のパラメータを動かしても候補や現在値は変えない。同じ条件の操作方法を切り替えたときは値を引き継ぐ。

テーブルはグラフの下に配置し、Fixedの結果をページ単位で表示する。並べ替え・昇降順・表示切り替えに対応。行をクリックするとPlotを描画し、すべての一致パラメータをその行の値へ同期する。範囲などの条件は保持する。一致が1件なら自動選択し、複数件では先頭を勝手に選ばない。

候補の複数選択は「すべて」と除外を扱い、候補が多い場合はページを移動できる。配列Keyも保存値を候補から選択できる。「この結果について質問」は、選択したScheme・RowId・Plot・条件と質問を右側の下書き欄へ渡す。

プレビューは実際のMCPクライアント、HTTPサーバー、MCP Appsの`AppBridge`を使用する。AIへの送信は行わない。

## MCPツール

| ツール | 用途 |
| --- | --- |
| `open_browser` | 明示的に閲覧画面を開く。既に開いている画面はそのまま使う |
| `list_schemes` | Scheme・Key・Value・登録済みPlot・件数を列挙する |
| `search_results` | KeyのAND条件検索。Fixedの行一覧とParametricの一致件数・選択状態を返す |
| `list_candidates` | Fixed条件下の保存済み候補をページ単位で取得。配列の一致や候補スライダーに使う |
| `get_result` | 1件の条件とValueメタデータ。明示した配列だけを取得する |
| `render_plot` | 共有の描画専用MATLABでPlotを実行し、PNGとHTML・Plotly JSONへのresource linkを返す。描画完了後、同じ保存先を開いている既存画面にも反映する |
| `annotate_plot` | 指定したPlotの点ラベル・縦線・横線を設定する。同じ閲覧画面に反映し、空配列でAI注釈を消す |

AIの`render_plot`が完了すると、既存のMatlabResults画面が約1秒間隔で完了通知を読み、Scheme・RowId・Plotを同期する。同じ結果の再描画も反映する。新しいタブや会話コンテキストは追加しない。画面内の行選択・Sweepは通知を発生させないので、更新を繰り返さない。表示先の通知だけをOSの一時フォルダで保存先ごとに共有し、実験データは変更しない。
`annotate_plot`も対象の図を既存画面に表示する。同じ図への注釈変更は注釈だけを更新する。

検索例:

```json
{
  "scheme": "waveform",
  "filters": [{ "key": "detuning", "op": "between", "value": [4, 6] }],
  "limit": 25,
  "offset": 0
}
```

条件は`eq`、`ne`、`gte`、`lte`、`between`、`in`、`not_in`、`contains`、`is_null`、`false`。`contains`は大文字・小文字を区別する。`filters`だけなら通常の検索。`parameters`を追加すると、`rows`と`total`はFixedの一覧を保ち、`matched_total`、`first_match`、`selected_matches`に両方の条件の評価結果を返す。

`list_candidates`の`value`は、候補を代表する行の`{"candidate":"<RowId>"}`。同じScheme・Keyのフィルタへそのまま渡す。表示ラベルや小さい配列の表示値から再構成せず、SQLiteに保存された値を使うため、配列や64bit整数もそのまま比較できる。`ordered`は範囲操作向けにNULLを除き、`locate`は候補位置（0始まり）、`nearest`は最も近い保存値を取得する。候補取得・検索はSQLのWHERE・GROUP BY・LIMIT/OFFSETで行い、MAT本体を読み込まない。

RowIdは十進文字列。`get_result`の`include_values`は既定では空。配列はMATLABの列優先順、複素数は`real`/`imag`を分離する。部分取得の`slice.start`は0始まり、`count`は各次元の要素数。既定上限は4096、最大16384要素。NaN/Infと64bit整数は文字列で返す。

stdioで起動する場合:

```powershell
node server.ts "path/to/project"
```

クライアントの設定例。パスは絶対パスに置き換える。

```json
{
  "mcpServers": {
    "result-store": {
      "command": "node",
      "args": ["path/to/matlab-result-store-mcp/start.mjs", "path/to/project"]
    }
  }
}
```

HTTPでのローカル接続は`node server.ts "path/to/project" --http 8732`。エンドポイントは`http://127.0.0.1:8732/mcp`。

## Plugin Extensionとして使う

`.codex-plugin/plugin.json`とルートの`.mcp.json`、`skills/`が一つのPluginパッケージになる。
CodexのMCP起動待ち時間を同梱するため、[公式に対応しているCodex形式](https://developers.openai.com/plugins/build/plugins)を使う。
`open_browser`だけにサイドバーと会話パネルのentrypointと`ui://result-store/browser.html`を宣言する。
通常の検索・配列取得・`render_plot`はMCP Apps UIを開かない。閲覧画面は明示的に開き、既に開いている画面を使い回す。

保存先はセットアップ用Skillが設定する。手動で設定する場合は、インストール先で次を実行する。

```powershell
node setup.mjs "path/to/project"
```

起動引数、環境変数`RESULT_STORE_ROOT`、個人用設定の順に優先する。開発用にはPluginルートの
`store.local.json`も引き続き使える。個人用設定がない場合に読み込む。

```json
{ "root": "path/to/project" }
```

`start.mjs`がインストール先の依存関係とUIを準備してからMCPを起動する。
ローカルPluginをキャッシュへコピーするホストでは、元のチェックアウトを更新しただけでは
反映されない。Marketplaceの更新・Pluginの再インストールを使う。

Plotヘッダーの「コンテキストに追加」を押すと、その時点の結果のメタデータとPNGを`ui/update-model-context`で渡す。閲覧・Sweep・選択解除ではコンテキストを変更せず、PNGも生成しない。質問ボタンは現在の図をコンテキストに追加してから、`openai/message`の`send: false`で会話の下書きを作る。[公式のExtension仕様](https://developers.openai.com/plugins/build/extensions)に沿った実装。

AIの注釈は`annotate_plot`に一覧を渡して設定する。座標はデータの単位で、`xaxis`・`yaxis`はPlotlyの軸名（`x`・`y`、`x2`・`y2`など）を指定する。省略時は`x`・`y`。一覧全体を置き換え、`annotations: []`でAI注釈を消す。元のPlot関数の注釈は保持する。

```json
{
  "scheme": "waveform", "row_id": "1", "plot_index": 1,
  "annotations": [
    { "type": "point_label", "x": 0, "y": 1, "text": "ピーク" },
    { "type": "xline", "x": 0, "text": "中心" },
    { "type": "yline", "y": 0.5, "text": "比較基準" }
  ]
}
```

注釈は`results/web/annotations/`のJSONに保存し、同じ画面が1秒ごとに変更を確認して注釈だけを更新する。Scheme・RowId・Plotごとに分かれ、元の保存データが差し替わった場合は古い注釈を適用しない。HTML・Plotly JSONと「コンテキストに追加」の画像には注釈が入る。`render_plot`のPNGはMATLABの元図で、注釈一覧は`plot_annotations`に返す。

Codex Appへのローカル導入は上記のMarketplaceを使う。ChatGPT側でリモートMCP接続を作る場合は
[公式の接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)に従う。
リモートからの開発接続にはSecure MCP Tunnelなどが必要。このHTTPサーバーはloopback限定で、
公開サーバー向けの認証は含まない。

## 現時点の範囲

- Valueの読み出しは、v7.3 MATの密な数値・logical配列。struct/cellの展開は未対応。
- 配列Keyの一致・複数選択は`list_candidates`の保存値を使う。任意の配列を入力して作る操作はない。
- ライブ描画は2-D Cartesian axesの線・マーカー・単色のpolygon patch・xline/ylineに対応する。MATLABのUIコールバックやその他の描画要素は移植しない。対応外はエラーとして伝え、オフラインのfig2plotly出力を使用できる。フォントや凡例位置はMATLABと完全には一致しない。
- 保存結果の計算・更新・削除を行うツールはない。

## 確認

```powershell
pnpm check
pnpm build
```

実データではPhCRの`waveform`を使用し、MAT読み出しの1024複素要素とMATLABの値の一致、元のFigureと変換後の4系列・軸範囲の一致、HTML/JSON/UI resource、画面での選択・ズーム・質問の引き渡しを確認した。クエリは`scan_waveform`の実データでMATLABの`store.browse`と件数・行順・候補・配列の一致・除外・最近傍位置を比較した。

ライブ描画では既存のR2024aセッションを使い、`cw_solution`の2種類のPlot、`scan_waveform`、`detuning_scan_comb_power`と、polygon patch・xline/ylineを確認した。`scan_waveform`の4系列は元のMATLAB出力と全点一致し、隣の結果へは4系列の`y`だけを差分送信した。他の計算がない状態でのMCP応答は約0.29秒（MAT読み込み約15ms、Plot実行約110ms）。同じ結果では読み込み・描画を省き、基準revisionが異なる場合は全体送信で復帰した。MCPのPNG・HTML・JSON、オフライン出力の互換性と、プレビュー画面のスライダー連続切替・画像と質問の引き渡しも確認した。ChatGPT本体への接続確認は別途必要。

導入は独立した個人設定でCodex CLIからMarketplace追加・Pluginインストールを行い、
Codex app-serverによるセットアップSkill・5ツールの認識と、保存済みPlotの取得を確認した。
依存関係のないインストール先からの初回起動、保存先の設定前後、設定の引き継ぎ、
PNGとUI resourceも確認した。Codex Appの画面操作とUIの描画は別途確認が必要。

参考: [Pluginパッケージ仕様](https://developers.openai.com/plugins/build/plugins)、[MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)、[Plotly MATLAB](https://github.com/plotly/plotly_matlab)。
