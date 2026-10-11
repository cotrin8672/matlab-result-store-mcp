---
name: matlab-result-store
description: >-
  Use the MATLAB Result Store framework to declare Schemes, save or reuse solver
  results with store.cached, store.recompute and store.scope, or search, plot
  and interpret saved results through the Result Store MCP tools or
  common/+store and common/+query. Use for Scheme/Key/Value/RowId questions and existing registered Plots. This skill
  covers the storage framework, not general MATLAB programming or LLE theory.
---

# MATLAB Result Store

Schemeで条件・保存する値・Plotを宣言するMATLABの保存フレームワークを扱う。
保存結果の解釈では、既存Plotの画像を入口にし、条件と取得元を添える。
精密な確認に必要な数値は元データから求める。

## 最初に確かめること

- 対象プロジェクトと保存先の`root`を特定する。通常、DBは
  `root/results/store.sqlite`にある。リポジトリ全体のルートと、実験ごとの保存先は
  同じとは限らない。
- 対象の`store.m`、`common/README.md`、`common/docs/result-store.md`と、今回使う
  `common/+store`の関数を確認する。現行ファイルをAPIの根拠にする。
- 既存結果を読むときは`store.loadSchemes(root)`から登録済みSchemeを調べる。
  プロジェクトの`store.m`は宣言をcommitするスクリプトなので、閲覧の前処理として
  無条件に実行しない。
- MCPツールが利用できる場合は、[MCPでの閲覧](references/mcp.md)に従う。
  ツールの返す保存先・宣言・条件を根拠にし、閲覧のためにMATLABを新規起動しない。
- MATLAB実行環境や画像を見る手段は、実際に利用できるものを使う。
  このSkill自体はMATLAB接続を提供しない。

## 必要な資料を選ぶ

| 作業 | 読む資料 |
| --- | --- |
| 結果の単位、Key、Value、保存先の共有を理解する | [基本概念](references/concepts.md) |
| Schemeを宣言する、solverに保存・再利用を付ける、局所条件を指定する | [宣言と保存](references/writing-results.md) |
| 条件検索、結果選択、既存Plotの画像化、比較・解釈を行う | [検索と画像による解釈](references/reading-results.md) |
| MCPツールやグラフィカルな結果選択画面から保存結果を読む | [MCPでの閲覧](references/mcp.md) |
| 保存・検索・描画のエラーや予想外のキャッシュ一致を調べる | [トラブル対応](references/troubleshooting.md) |

すべての資料を毎回読む必要はない。詳細な既存の説明が必要なら、対象リポジトリの
`common/docs/query-browser.md`と`common/docs/result-store-walkthrough.html`も参照する。
古い説明と現行APIに差があれば、現行の関数定義・動作を確認する。

## 作業の進め方

- 保存・再利用では、今回の条件のうち何が宣言済みKeyかを確認する。
  キャッシュ一致は宣言されたKeyだけで決まり、solver引数全体を自動では比較しない。
- 閲覧では条件をKeyで絞り、比較対象のRowIdを確定してから必要なValueを読む。
  複数件の一致を、理由なく先頭一件へ縮めない。
- 解釈では目的に合う登録済みPlotを描画し、画像を実際に見てから述べる。
  軸、単位、線形／対数、正規化はPlotとsolverの実装で確かめる。
- 終状態、パラメータ走査、時間発展を区別する。保存されていない履歴や、画像に
  表示されていない成分を推測で補わない。
- 保存方法への変更と数値計算への変更を混ぜない。依頼された式・変数名・計算順序・
  出力・Plotを維持する。閲覧や診断を理由にScheme、Key、保存結果を変更しない。

## 結果の伝え方

対象の保存先、Scheme、RowId、比較条件と使用したPlotを示す。
画像で観察できたことと、元データから計算して確認した値を区別する。
コードを読んだだけ、MATLABで実行した、画像を見た、という確認範囲も区別する。
