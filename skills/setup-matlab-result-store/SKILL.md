---
name: setup-matlab-result-store
description: Set up the installed MATLAB Result Store plugin, prepare its dependencies and UI, and configure the saved-result folder. Use after plugin installation or when changing the Store folder.
---

# MATLAB Result Storeのセットアップ

インストールされたPluginを使える状態にし、保存済み結果のフォルダを設定する。

1. `codex plugin list --marketplace matlab-result-store --json`の`installed`から、このPluginの
   `version`を確認する。インストール先は通常
   `~/.codex/plugins/cache/matlab-result-store/matlab-result-store/<version>/`。
   `CODEX_HOME`があれば`~/.codex`の代わりに使う。このSkillの表示パスがMarketplaceの元を
   指す場合があるため、以降は必ずインストール先を使う。`setup.mjs`の存在を確認する。
2. Node.js 24以上と、pnpmまたはnpmを確認する。Codexが提供するランタイムも使える。
   利用できない場合は不足する前提を伝える。npmがあればpnpmの事前インストールは不要。
3. ユーザーが指定した保存フォルダに`results/store.sqlite`があることを確認する。
   現在のプロジェクトがその条件を満たす場合は使える。保存先が不明な場合だけ場所を聞く。
   LLE全体とPhCRなどの実験フォルダを取り違えない。
4. Pluginルートを作業ディレクトリとして、`node setup.mjs "<保存フォルダの絶対パス>"`
   を実行する。[setup.mjs](../../setup.mjs)が固定バージョンの依存関係を導入し、UIをビルドし、
   DBを読み取り専用で確認してから保存先を設定する。初回はパッケージ取得にネットワークを使う。
5. 出力された保存先・Schemeと件数を確認し、完了を伝える。MCPツールが利用できる場合は
   `list_schemes`でも同じ保存先を確認する。まだツールが読み込まれていない場合や保存先を
   切り替えた場合は、新しいチャットでPluginを使うよう案内する。
6. 図の描画には`matlab`がPATH上に必要。MCPが描画専用MATLABを保存先ごとに1つだけ
   自動起動して共有する。計算用セッションで`resultstore.connect`を実行する必要はない。
   フレームワークの`common`は保存先の祖先から自動検出する。別の場所にある場合は
   MATLAB標準の`MATLABPATH`に追加する。solverや`store.m`は実行しない。

設定は通常`~/.codex/matlab-result-store/store.local.json`へ保存する。`CODEX_HOME`があれば
その配下、ホストが`PLUGIN_DATA`を渡す場合はそのディレクトリを使う。MCP起動時に
`PLUGIN_DATA`内の設定がない場合も、通常の個人用設定を読む。Plugin更新後も同じ設定を
読める。`RESULT_STORE_ROOT`や起動引数を指定した場合はそちらが優先される。

描画専用プロセス以外のMATLABを追加起動しない。保存データの作成・変更は行わない。
Plot未出力はセットアップ失敗ではない。通常は共有の描画専用プロセスで描画する。
オフライン閲覧やライブ描画の対応外の図には`resultstore.exportCatalog` / `resultstore.exportPlot`を使える。
