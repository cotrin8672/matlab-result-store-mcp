# MATLAB Result Store MCP

MATLAB Result Storeに保存された結果を検索し、図を見ながらAIと会話するためのMCPサーバーとPlugin Extension。

- **MCP**: Scheme一覧、条件検索、MATファイルの読み出し、登録済みPlotの取得。
- **Skill**: 保存フレームワークの概念・利用手順・結果解釈・トラブル対応。
- **Extension**: Schemeと条件を画面で選び、Plotlyで拡大・縮小し、選択した結果について質問する。

MCPサーバーはSQLiteとv7.3 MATを直接読み、MATLABを起動しない。既存Plotを変換するときだけ、利用中のMATLABセッションでfig2plotlyを使う。描画関数の数式や正規化は変更しない。

## セットアップ

Node.js 24以上とpnpmが必要。

```powershell
ghq get https://github.com/cotrin8672/matlab-result-store-mcp
Set-Location (Join-Path (ghq root) "github.com/cotrin8672/matlab-result-store-mcp")
pnpm install --frozen-lockfile
pnpm build
```

対象は既存のResult Store形式の`results/store.sqlite`とMATファイルを持つプロジェクト。保存フレームワークや実験データはこのリポジトリに含まれない。

## 既存Plotを出力する

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

`http://127.0.0.1:8732`を開く。Schemeを選び、条件を入力して検索し、RowIdを押すとPlotが表示される。「この結果について質問」は、選択したScheme・RowId・Plot・条件と質問を右側の下書き欄へ渡す。

プレビューは実際のMCPクライアント、HTTPサーバー、MCP Appsの`AppBridge`を使用する。AIへの送信は行わない。

## MCPツール

| ツール | 用途 |
| --- | --- |
| `list_schemes` | Scheme・Key・Value・登録済みPlot・件数を列挙し、閲覧画面を開く |
| `search_results` | スカラーKeyによるAND条件検索。RowIdとKeyのみを返す |
| `get_result` | 1件の条件とValueメタデータ。明示した配列だけを取得する |
| `render_plot` | 元のMATLAB FigureのPNGと、変換済みHTML・Plotly JSONへのMCP resource linkを返す |

検索例:

```json
{
  "scheme": "waveform",
  "filters": [{ "key": "detuning", "op": "between", "value": [4, 6] }],
  "limit": 25,
  "offset": 0
}
```

条件は`eq`、`ne`、`gte`、`lte`、`between`、`in`、`contains`、`is_null`。RowIdは十進文字列。`get_result`の`include_values`は既定では空。配列はMATLABの列優先順、複素数は`real`/`imag`を分離する。部分取得の`slice.start`は0始まり、`count`は各次元の要素数。既定上限は4096、最大16384要素。NaN/Infと64bit整数は文字列で返す。

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
      "args": ["path/to/matlab-result-store-mcp/server.ts", "path/to/project"]
    }
  }
}
```

HTTPでのローカル接続は`node server.ts "path/to/project" --http 8732`。エンドポイントは`http://127.0.0.1:8732/mcp`。

## Plugin Extensionとして使う

ルートの`plugin.json`と`mcp.json`、`skills/`が一つのPluginパッケージになる。`list_schemes`にサイドバーと会話パネルのentrypointを宣言し、`ui://result-store/browser.html`をMCP Apps UIとして提供する。

Plugin起動時の保存先は、環境変数`RESULT_STORE_ROOT`、またはPluginルートの`store.local.json`で指定する。

```json
{ "root": "path/to/project" }
```

ホストが`PLUGIN_DATA`を渡す場合は、そのディレクトリの`store.local.json`を読む。設定・依存パッケージ・UIビルドは実際にホストが使うインストール先に用意する。ローカルPluginをキャッシュへコピーするホストでは、元のチェックアウトを更新しただけでは反映されない。

ChatGPT側では、選択した結果のメタデータとPNGを`ui/update-model-context`で渡し、質問ボタンは`openai/message`の`send: false`で会話の下書きを作る。[公式のExtension仕様](https://developers.openai.com/plugins/build/extensions)に沿った実装。

このリポジトリの作成だけではChatGPTへの登録・インストールは完了しない。接続は[公式の接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)に従い、ローカル／repo marketplace、または登録済みMCP接続とSkillの組み合わせを使う。リモートからの開発接続にはSecure MCP Tunnelなどが必要。このHTTPサーバーはloopback限定で、公開サーバー向けの認証は含まない。

## 現時点の範囲

- Valueの読み出しは、v7.3 MATの密な数値・logical配列。struct/cellの展開は未対応。
- 配列Keyは型・形状と小さい値を表示できるが、配列Keyによる絞り込みは未対応。
- 図は明示的に出力した登録済みPlotのみ。fig2plotlyが扱わない描画要素やMATLABのコールバックは移植しない。元のPNGを併せて確認できる。
- 保存結果の計算・更新・削除を行うツールはない。

## 確認

```powershell
pnpm check
pnpm build
```

実データではPhCRの`waveform`を使用し、MAT読み出しの1024複素要素とMATLABの値の一致、元のFigureと変換後の4系列・軸範囲の一致、4つのMCPツール、HTML/JSON/UI resource、画面での選択・ズーム・質問の引き渡しを確認した。ChatGPT本体への接続確認は別途必要。

参考: [Pluginパッケージ仕様](https://developers.openai.com/plugins/build/plugins)、[MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)、[Plotly MATLAB](https://github.com/plotly/plotly_matlab)。
