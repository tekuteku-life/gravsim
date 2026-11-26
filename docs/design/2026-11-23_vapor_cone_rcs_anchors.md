# GravSim 設計書: ベイパーコーン・RCS・排煙・アンビリカルの位置を描画形状から決める

- **作成日**: 2026-11-23
- **最終改訂**: Rev 31（2026-11-26）
- **対象ブランチ**: `fix/vapor-cone-rcs-anchors`
- **準拠プロセス**: [docs/development_process.md](../development_process.md)
- **監査記録**: [docs/review/2026-11-23_vapor_cone_rcs_anchors.md](../review/2026-11-23_vapor_cone_rcs_anchors.md)
- **前提の設計書**: [2026-11-20_trajectory_fx_flightplan.md](2026-11-20_trajectory_fx_flightplan.md) の §3.2-3（RCS のノズル表）と §3.3（ベイパーコーン）。本書は、その位置と大きさの決め方を置き換える。ベイパーコーンの強度（§4.4 のベル関数）・色・形の式・LOD の条件は変えない。

## 改訂履歴

| Rev | 日付 | 内容 |
|---|---|---|
| 1 | 2026-11-23 | 初版 |
| 2 | 2026-11-23 | 独立監査1 Iteration 1（FAIL）の指摘 G1-1-01〜12 を反映した（§8.1）。主な変更は次のとおり。<br>・RCS を部品のない壁に置く。<br>・修正後の雲の範囲と受け入れの根拠を記載した。<br>・排煙・アンビリカルの接続点を形状から決める。<br>・未使用の外形を削除した。<br>・判定の規則を 1 つにした。<br>・投棄物を別ブランチにした。 |
| 3 | 2026-11-23 | 独立監査1 Iteration 2（FAIL）の指摘 G1-2-01〜11 を反映した（§8.2）。主な変更は次のとおり。<br>・RCS の噴射の広がりも部品に掛けない（§3.6）。<br>・避ける部品を、その時点で付いているかではなく機体の構成から決め、分離でノズルが動かないようにした（§3.6）。<br>・ペイロード単体の RCS は本体の角から前後へ噴く（§3.6）。<br>・アンビリカルのアームの先端と、パッドの粒子の尺度を直す（§3.8）。<br>・HUD の判定の呼び方を定めた（§3.1）。<br>・SRB の本数による描画の変化を R9 と §5.4 に加えた。<br>・§5.4 の入力に燃料の種類と気圧を加えた。<br>・影響範囲・E2E の手順・排煙の尺度・別ブランチの記録を訂正した。 |
| 4 | 2026-11-23 | 独立監査1 Iteration 3（FAIL）の指摘 G1-3-01〜09 を反映した（§8.3）。主な変更は次のとおり。<br>・RCS の噴射を機体の後ろに描く（§3.6。アレージがフィン・SRB の陰になり、アンテナの線の上にも描かない）。<br>・胴体の半径の問い合わせを外形（全部品の最大）にした（§3.8）。<br>・パッドの粒子の大きさも同じ尺度にした（§3.8-3）。<br>・形状に構成のフェアリング `fairingConfig` を加えた（§3.2）。<br>・段番号を HUD と同じく正規化し（`\|\| 0`）、アナンシエーターも同じ規則にした（§3.1）。<br>・R9・§5.4 の変わる入力を補った（2,743 通り）。<br>・記述の誤りを訂正した。 |
| 5 | 2026-11-24 | 独立監査1 Iteration 4（FAIL）の指摘 G1-4-01〜05 を反映した（§8.4）。主な変更は次のとおり。<br>・RCS の描く順を現在と同じ（機体・噴射炎・ベイパーコーンの上）に戻した。第 1 段のアレージがフィン・SRB に重なることと、衛星のアンテナの線との 1 画素未満の重なりは、利用者の了承（2026-11-24）で許容する（R4、§3.6）。<br>・SRB の設定は、Worker に送る `boosters` だけを読む（§3.1）。Worker の届かない代わりの値を削除する。<br>・アームの長さを、端面の範囲の外形の最小から決める（§3.8）。<br>・§3.1・§3.2・§3.3・§4・§5 の記述を訂正した（2,745 通り）。 |
| 6 | 2026-11-24 | 独立監査1 Iteration 5（FAIL）の指摘 G1-5-01〜08 を反映した（§8.5）。主な変更は次のとおり。<br>・第 1 段のアレージが部品に重なる範囲を「第 1 段が惰行の後に再点火するとき」に訂正し、利用者の了承を取り直した（2026-11-24）。<br>・アンテナの線との隙間を最短距離で求め直した。<br>・Worker の届かない代わりの値を 3 つとも削除する。<br>・`_computeBoosterLayout` の本数 0 の戻り値、射点の形状を求める時点を定めた。<br>・§5.1 の Rev 4 の記述を直し、改訂履歴の順を直した。 |
| 7 | 2026-11-24 | 独立監査1 Iteration 6（PASS（文書指摘あり））の文書指摘 G1-6-01〜04 を、工程 2 と並行して直した（§8.6）。アンテナのしきい値、射点の形状を求める時点と初期値・試験、d2・s2 の再現の手順、SRB の張り出しの式を訂正した。 |
| 8 | 2026-11-24 | 独立監査2 Iteration 1（FAIL）の指摘 G2-1-01〜07 を反映した（§8.7）。あわせて、監査が報告した既存の不具合（SRB の本数が異常に大きいと Worker と描画が止まる）を、利用者の判断（2026-11-24、「このブランチで直す」）で本数の規則に上限を設けて直す（§1.4.1 (f)、§3.1）。 |
| 9 | 2026-11-24 | 独立監査2 Iteration 2（FAIL）の指摘 G2-2-01〜05 を反映した（§8.8）。SRB の本数の規則で有限でない値（保存ファイルの `1e999` など）を不正として扱い、描画・HUD と物理の本数を揃えた。使われない `MAX_BOOSTER_COUNT` の公開ゲッターを削除した。R9・§3.1・§4・§5 の記述を訂正した。 |
| 10 | 2026-11-24 | 独立監査2 Iteration 3（PASS（文書指摘あり））の文書指摘 G2-3-01〜03 を直した（§8.9）。同監査が報告した既存の性能の問題（描画の設定 `ROCKET_VISUAL` を読むたびに設定全体を深く写す）を、利用者の判断（2026-11-24、「既存のコピーごと直す」）で範囲に加えた（§1.4.1 (g)、R10、§3.11）。この追加は設計監査（独立監査1）から受け直す。 |
| 11 | 2026-11-24 | 独立監査1 Iteration 7（FAIL）の指摘 G1-7-01〜06 を反映した（§8.10）。同じ種類の問題（Rocket タブのプレビューが毎フレーム旧形式のプリセットを全機体分組み立て直す）を §3.11 に加え、版番号をプリセットのすべての表に広げた。`getFuel`・`getPlume`・`getTheme` の記述、Worker の変更の範囲、計測と試験の計画、§3.1 の記述を訂正した。 |
| 12 | 2026-11-24 | 独立監査1 Iteration 8（FAIL）の指摘 G1-8-01〜04 を反映した（§8.11）。毎フレームのパラメータの深い写し（読み込んだロケットの大きさの代わりの値、プレビューの標的の印、スリングショットの HUD）を、読むだけの共有の写し `peekObjectParam` と、代わりの値を必要なときだけ求める順で直す（§1.4.1 (g)、§3.11-5）。§3.11-2・§5.1-11・R9 の記述を訂正した。 |
| 13 | 2026-11-24 | 独立監査1 Iteration 9（FAIL）の指摘 G1-9-01〜04 を反映した（§8.12）。パラメータを読む全箇所（約 40）を、毎フレーム・毎ステップに読むだけのものと、それ以外に分けた表を §3.11-5 に置き、前者をすべて読むだけの共有の写し（`peekObjectParam`、物理エンジンでは `peekCelestialParam`）にした。R10・§5.1-11・§3.11-2 の記述を訂正した。 |
| 14 | 2026-11-24 | 独立監査1 Iteration 10（PASS（文書指摘あり））の文書指摘 G1-10-01〜05 を、実装の前に直した（§8.13）。Worker の毎ステップの読みの説明（写しではなく名前の検索）、取り次ぎ（`ObjectPlacer`・`NaviTab`）、§4 の `CelestialBody._drawEffects`、§5.1-11 の試験、使われなくなる `RocketLauncher._getObjectParam` の削除を訂正・追加した。 |
| 15 | 2026-11-24 | 独立監査2 Iteration 4（PASS（文書指摘あり））の文書指摘 G2-4-01・02 を直した（§8.14）。`getBaseRadiusM` の `peekObjectParam` の経路の条件と、§4 の `RocketLauncher` の変更を書き足した。 |
| 16 | 2026-11-24 | 工程 3 のテストで見つかった 3 点を直した（§8.15）。外形の継ぎ目の丸めの隙間（`_silhouetteParts`）、`minBodyRadiusOver` の逆順の範囲、`peekObjectParam` の `null` の鍵。 |
| 17 | 2026-11-24 | 独立監査3 Iteration 1（FAIL）の指摘 G3-1-01〜05 を反映した（§8.16）。不足していた試験を加え（範囲の中の最小、アームの長さの規則、共有した入れ子の値の凍結、`_fairingRadiusAt` の一次式の分岐、`COLD_GAS_RCS` のない設定）、§3.11-2 の共有の例を訂正し、§4・§5 に工程 3 で決めた試験のファイルを書いた。 |
| 18 | 2026-11-24 | `unit/02_rocket_guidance.test.mjs` と同じ写しだった `integration/02_rocket_guidance_staging.test.mjs`（34 件）を、利用者の判断で削除した（§8.16）。§4 の参照と `testsuites/README.md` の件数を直した |
| 19 | 2026-11-24 | 独立監査3 Iteration 2（FAIL）の指摘 G3-2-01・02 と注意 3〜6 を反映した（§8.17）。アームの端面の機尾側の端の試験、`_fairingRadiusAt` の桁落ちしない根の式、`disableStaging` と `stages` のない物体の HUD の試験、E2E の RCS の役割の検証を加え、`testsuites/README.md` の実行例を実際の出力にした |
| 20 | 2026-11-24 | 独立監査3 Iteration 3（FAIL）の指摘 G3-3-01〜04 を反映した（§8.18）。`_fairingRadiusAt` の比 0・比 1・長さ 0、段のない物体の段番号 1、`COLD_GAS_RCS` の既定値の試験を加えた。横展開で見つけた、段数 1 の機体の低詳細と高詳細の食い違いを直した（§3.1、R9、§5.4 の描画の不変の差 216 通り）。試験の見出しと注記、§8.17 の数値を直した |
| 21 | 2026-11-24 | 独立監査3 Iteration 4（FAIL）の指摘 G3-4-01〜03 を反映した（§8.19）。ペイロード段階でないとき、段の番号でない段番号を最後の段と読む「現在の段」を §3.1 の規則にし、Rev 20 の低詳細の式を元に戻した（R9、§5.4 の描画の不変の差は 216 通りのまま、md5 は `63eddb23…`）。§5.1-2 に現在の段の一致の試験を加え、unit 08・回帰 12 の範囲外の段番号の期待値を直し、二分法の注記を直した |
| 22 | 2026-11-24 | 独立監査3 Iteration 5（FAIL）の指摘 G3-5-01〜03 を反映した（§8.20）。段番号の正規化 `normalizeStageIndex`（整数・切り捨て・0 から段数、`disableStaging` は最後の段まで）を §3.1 に加え、描画・HUD・主スレッドの読込・Worker の復元・`Rocket.mass` が使う。小数の段番号の保存ファイルで読込が途中で失敗した既存の不具合を直した（R9 の物理の変更に加えた）。現在の段は、正規化した段番号を最後の段までにしたものにした。§3.1 のコードの枠、§5.1-2 の試験を直した |
| 23 | 2026-11-24 | 独立監査3 Iteration 6（FAIL）の指摘 G3-6-01・02 を反映した（§8.21）。読込の段数を Worker と同じにし（段の配列がないか空なら 1）、段のない機体の保存→読込の試験を加えた。§3.1 の段数の数え方、R9 の確認方法と変わる入力、§4 の影響範囲、§5.4、§8.19 の記述を直した |
| 24 | 2026-11-25 | 独立監査3 Iteration 7（FAIL）の指摘 G3-7-01・02 を反映した（§8.22）。読込の段番号の試験に、2 段機の段数を超える値・文字列・真偽値・`null` と、段のない機体の書き換えた保存ファイルを加えた。R9 の主スレッドの値だけが変わる入力に数でない値を、§5.1-2 に段のない機体の保存→読込を書いた。保存ファイルの段の要素の検証（既存の不具合）を、利用者の判断（2026-11-25）で構造の見直しの入力 H2-16 に記録した（§6） |
| 25 | 2026-11-25 | 独立監査3 Iteration 8（PASS（文書指摘あり））の文書指摘 G3-8-01〜03 を、工程 4 と並行して直した（§8.23）。H2-16 の症状を要素の種類ごとに訂正し（§6・見直しの入力）、§5.1-2 の段のない機体の試験の範囲、R9 の変わる入力の括弧、§4 の見直しの入力の行、Rev 24 の日付を直した。工程 4 の結果（全テスト、カバレッジ、描画と物理の不変、§3.11-6 の計測、目視）を §5.5 に記録した |
| 26 | 2026-11-25 | 独立監査4 Iteration 1（FAIL）の指摘 G4-1-01〜06 を反映した（§8.24）。`testsuites/README.md` §1 のコードの柵を直した（`main` からある書式の不具合）。H2-16 の症状の条件、R9 の Worker と主スレッドで値の変わる入力、§3.1・§3.2・§3.10 の段番号の記述、§5.5 のカバレッジと物理の不変の記述、見直しの入力の H1-15 の行番号を直した。d2・s2 を今のツリーで実行し直した |
| 27 | 2026-11-25 | 独立監査4 Iteration 1 の注意 5 を、利用者の判断（2026-11-25）で本ブランチで直した（§8.24）。読込は保存ファイルの `totalStages` を読まず、段の配列から Worker と同じ数え方で決める（§3.1、R9、§4、§5.1-2、§6）。回帰 12 に `totalStages` を書き換えた保存ファイルの試験を加えた。工程 4 の確認をやり直した（§5.5） |
| 28 | 2026-11-26 | 独立監査4 Iteration 2（FAIL）の指摘 G4-2-01〜04 を反映した（§8.25）。回帰 12 に段番号のない保存ファイルの段数の試験を加え、`loadState` の注記を直した。README のカバレッジの揺れの記述、§5.5 の通らない行の分類、R9 の段数の項（Worker の変更の一覧から外した）、§3.1・§8.24 の段数を読む箇所の記述、§4 と旧設計書 §3.5-1 の注記を直した。工程 4 の確認をやり直した |
| 29 | 2026-11-26 | 独立監査4 Iteration 3（PASS（文書指摘あり））の文書指摘 G4-3-01 を直した（§8.26）。注意 2（最初のフレームの前の保存の段数 1）を、利用者の判断で構造の見直しの入力 H2-17 に記録した（§6）。R9 の段数の項と `loadState` の注記に、配置の後、最初の Worker のフレームの前に保存した多段機の保存ファイル（`totalStages` 1）を加えた。`gravsim_rocket_renderer.js` の本ブランチで生じた連続する空行 2 か所を 1 行にした（見た目だけ） |
| 30 | 2026-11-26 | G4-3-01 の解消の確認（未解消）の指摘を直した（§8.26）。R9 の段数の項で、保存が 1 を書くのを配置の後・最初のフレームの前に限り、読み込んだロケットでは読込で決めた段数を書くこと（`main` は読み込んだ値）を書いた。値が変わる 3 つの保存ファイルの前の値の書き出しを、(3) の `Rocket` の初期値に合わせた |
| 31 | 2026-11-26 | G4-3-01 の解消の確認（2 回目、解消）の付記 (a)・(b) を、確認の節 §3 の文案どおりに直した（R9 の段数の項と、同じ言い回しの §3.1 の段数の記述。書き換えた保存ファイルの端の入力の言い回しだけで、判定に影響しない）。文案の正しさは確認のエージェントが確かめているため、確認は重ねない |

---

## 1. 背景

### 1.1 報告された不具合

「ベイパーコーンがロケット中央付近で発生してしまっている」（利用者の改善要望、2026-11-23）。

### 1.2 調査結果

ベイパーコーンの頂点は、機体の長さ `L` に対する固定の割合で決まっている（`RocketRenderer.drawVaporCone`）。

- 主コーンは `xMin + 0.72 L`、副コーン（強度 0.55 以上のとき）は `xMin + 0.44 L`。
- `L = max(1, xMax - xMin)`。`xMin` は最下段の胴体の後端（ノズルを含まない）、`xMax` は機首である。

この割合は機体の形と関係がない。主コーンの 0.72 が合うのは、1 段機のフェアリング基部（`xMin` からの割合 0.718）だけである。設計書（2026-11-20 §3.3）は副コーンを「段間」と書いているが、0.44 は段間ではない。3 段機の第 1 段飛行で、下側の段間（割合 0.424〜0.477）に偶然かかるだけである。

構成ごとの位置を次の表に示す。

- 単位は画面半径 `R` 倍で、`+x` が機首である。
- 全構成でフェアリングを付けた状態で、実装の `_computeVisualLayout` と描画（`_drawHighDetail`）から計算した。
- 「機体の範囲」と「中央」はノズルの端から機首まで、割合の基準の `L` はノズルを除いた `xMin`〜`xMax` である。

| 構成 | 機体の範囲（ノズル端〜機首） | 中央 | `xMin`〜`xMax`（`L`） | 主コーン頂点（0.72 L） | フェアリング基部 | 副コーン頂点（0.44 L） | 最上段の段間の前端 |
|---|---|---|---|---|---|---|---|
| 1 段 | -1.850〜2.400 | 0.275 | -1.500〜2.400（3.900） | 1.308 | 1.300 | 0.216 | なし |
| 2 段・第 1 段飛行 | -3.100〜2.700 | -0.200 | -2.750〜2.700（5.450） | 1.174 | 1.600 | -0.352 | 0.400 |
| 2 段・第 2 段飛行 | -0.920〜1.700 | 0.390 | -0.600〜1.700（2.300） | 1.056 | 0.600 | 0.412 | なし |
| 3 段・第 1 段飛行 | -3.450〜3.500 | 0.025 | -3.100〜3.500（6.600） | 1.652 | 2.400 | -0.196 | 1.500 |
| 3 段・第 2 段飛行 | -1.920〜1.850 | -0.035 | -1.600〜1.850（3.450） | 0.884 | 0.750 | -0.082 | -0.150 |
| 3 段・第 3 段飛行 | -1.180〜1.100 | -0.040 | -0.900〜1.100（2.000） | 0.540 | 0.000 | -0.020 | なし |

- **2 段・第 1 段飛行**（Falcon 9・H3 の打ち上げで遷音速になる構成）
  - 主コーンの頂点は、フェアリング基部より 0.43 R 後ろの第 2 段の中ほどにある。ピーク（マッハ 1.00、強度 1）では、雲が後方 -0.751 まで伸び、段間を越えて機体中央（-0.200）にかかる。
  - 副コーンの頂点は、第 1 段の上部（-0.352）にある。
  - 報告の現象は、この 2 つの雲である。
- **2 段・第 2 段飛行と 3 段・第 3 段飛行**
  - 主コーンの頂点が、フェアリングの上（基部より前）に来る。
  - 段間がないのに、副コーンが段の中ほどに描かれる。
- **大きさ**: 長さ・幅・縁の位置・線幅は、主・副とも、機体で最も太い半径 `layout.halfWidth` から決めている。

### 1.3 根本原因

1. 演出の位置を、機体の形ではなく、全長に対する割合で決めている。
2. 演出の大きさを、その位置の太さではなく、機体で最も太い半径で決めている。
3. 機体の形の計算が 2 箇所にある。描画は `_drawHighDetail`、範囲の計算は `_computeVisualLayout` が、同じ式の写しを持つ。演出の位置は、範囲からさらに割合で作るため、描画した形とのつながりが切れている。

### 1.4 横展開

コードベース全体（`scripts/`）から、同じ種類の箇所を調べた。対象は、描画した形とは別の写しや固定の割合から、演出の位置・形・尺度・判定を決めている箇所である。

#### 1.4.1 本ブランチで直すもの

**(a) RCS（コールドガス）のノズル**（`drawColdGasRcs`）

ベイパーコーンと同じく、割合方式で決めている。前方は `xMin + 0.84 L`、後方は `xMin + 0.14 L`、壁は `yWall = layout.halfWidth` である。

| 構成 | 前方ノズル（0.84 L） | 後方ノズル（0.14 L） | フェアリング | 現在の段の範囲（半径） |
|---|---|---|---|---|
| 1 段 | 1.776 | -0.954 | 1.300〜2.400 | -1.500〜1.300（0.700） |
| 2 段・第 1 段飛行 | 1.828 | -1.987 | 1.600〜2.700 | -2.750〜0.050（0.700） |
| 2 段・第 2 段飛行 | 1.332 | -0.278 | 0.600〜1.700 | -0.600〜0.600（0.650） |
| 3 段・第 1 段飛行 | 2.444 | -2.176 | 2.400〜3.500 | -3.100〜-0.300（0.700） |
| 3 段・第 2 段飛行 | 1.298 | -1.117 | 0.750〜1.850 | -1.600〜-0.400（0.650） |
| 3 段・第 3 段飛行 | 0.780 | -0.620 | 0.000〜1.100 | -0.900〜0.000（0.550） |

1. **前方ノズルがフェアリングの上にある**: フェアリングを付けたすべての構成で、前方ノズルはフェアリングの範囲に入る。フェアリングは分離される覆いで、スラスタは持たない。
2. **フェアリング分離でノズルが飛ぶ**: 分離すると機首が衛星の前面に変わり、`xMax` が縮む。そのため、何も変わっていない段の上でノズルが動く。2 段・第 2 段飛行では、前方ノズルが 1.332 R から 1.114 R へ、フェアリングの上から衛星の上へ移る。
3. **噴射が機体から浮く**: `yWall` が機体で最も太い半径のため、細い段では機体から離れた位置から噴射する。たとえば 3 段・第 3 段飛行でフェアリングがあると、`yWall` は 0.65 R、第 3 段の半径は 0.55 R で、噴射は 0.10 R 浮く。
4. **ほかの部品の上から噴射する**
   - SRB 付きの第 1 段（H3-22・H3-24）: 後方ノズル（-1.987）が SRB の胴体（-2.614〜-0.364）の上にある。
   - ペイロード単体: 両方のノズルが、展開した太陽電池パネルの範囲（2 段機では ±0.364）にある。
   - 噴射は半角 0.34 rad の三角形で、長さは壁の半径の 2.4 倍ある。ノズルの位置を部品から外しても、噴射の広がりが部品に掛かりうる（独立監査1 Iteration 2 の G1-2-01）。

**(b) 同じファイルの判定の重複**

1. **ペイロード単体の判定が詳細度で違う**
   - 低詳細（`_drawLowDetail`）は `rocket.currentStageIndex >= rocket.totalStages` で判定する。
   - 高詳細と範囲の計算は、`telemetry.stageIndex >= telemetry.totalStages`（無ければ `currentStageIndex` と `stages.length`）で判定する。
   - 低詳細の `hasStage1` は高詳細と同じ `telemetry.stageIndex` を使うため、低詳細の中で 2 つの情報源が混ざっている。
2. **SRB の設定の読み元が詳細度で違う**
   - 高詳細（`_drawBoosters`）は、`rocket.boosters || rocket.rendering?.boosters || rocket.stages?.[0]?.boosters` を読む。
   - 低詳細の本数は `rocket.boosters?.count || rocket.rendering?.boosters?.count` を読み、`stages[0].boosters` を見ない。
   - 本数 0 の `rocket.boosters` があるとき、高詳細は描かないが、低詳細は `rendering.boosters.count` を使う。

**(c) 排煙・火花の放出位置**（`Rocket.updateHistory`、`scripts/gravsim_object.js` L447-501）

描画とは別の定数（`NOZZLE_BOTTOM_OFFSET`・`BASE_X_*_RATIO`・`NOZZLE*_LENGTH_RATIO`）から計算している。段の構成では描画と一致するが、次の状態でずれる（`R` 単位、機体の中心から後方への距離。独立監査1 Iteration 1 の測定）。

| 状態 | 現在の放出点 | 描画 |
|---|---|---|
| ペイロード単体の燃焼（水素の自走ペイロード、2 段機） | 6.120（第 2 段のノズル 0.92 と、段の燃料の炎 × 0.65） | 衛星の後面 0.455 から、水素の炎 × 0.35。先端は 3.605（海面。真空では 4.078） |
| ペイロード単体で燃焼なし（大気中・脱出中） | 0.920 | 衛星の後面 0.455 |
| 段もテレメトリもない機体 | 3.100（段数の既定値 `\|\| 2`） | 1 段機として描く（ノズル 1.850。段数の既定値 `\|\| 1`） |

ほかにも、描画と次の点で違う。

- ペイロード単体の分岐がない。燃料は、描画の `payloadFuelType` ではなく段の燃料を使う。
- 炎の長さが、真空での伸び（`_drawPlume` の `1 + e_vac × k`。`k` は燃料ごとに 0.15・0.12・0）を含まない。
- 炎の有無を `isIgnited && burnTime > 0` で決めており、描画の規則（`isEngineFiring`、ペイロード単体では `isPayloadEngineFiring`）と違う。
- 機体の尺度の代わりの値（`baseRadiusM` が 0 のとき）が、描画（`_getDrawRadius` の `defaultRocketRadius`）と違う（`bottomOffsetM / NOZZLE_BOTTOM_OFFSET`）。

**(d) 射点のアンビリカル**（`scripts/gravsim_pad_effect.js`、`PAD_EFFECT.STRUCTURE`）

1. **接続点**（`CABLE_CONN_X_MULT` 0.8・`CABLE_CONN_Y_MULT` -0.7。`UmbilicalCable` の L22-30・L89-96）は、構成によらず (0.8 R, -0.7 R) にある。x = 0.8 R の胴体の半径は、1 段機の 0.7 R（第 1 段）とだけ一致する。2 段機と 3 段機の半径は 0.65 R（第 2 段）で、接続点は胴体から 0.05 R 浮く。
2. **アームの先端**は、塔の位置 `UMBILICAL_OFFSET_Y`（-1.4）から長さ `UMBILICAL_ARM_LEN_MULT`（0.7）で、x = `UMBILICAL_TOP_X_MULT`（1.6）の -0.7 R にある。フェアリングを外した 1 段機（Rocket タブのチェックボックスで外せる）では、x = 1.6 R にあるのは収納状態のペイロード（半高 0.595 R）で、0.105 R 浮く（G1-3-02）。`getAttachPos` と、`PadEffectRenderer` の描画（L685）が使う。
   - x = 1.6 R の胴体の半径は、1 段機では 0.647 R（フェアリングの曲線）、2 段機では 0.65 R（第 2 段とフェアリングの境界）、3 段機では 0.55 R（第 3 段）である。
   - そのため、アームの先端は胴体から、それぞれ 0.053・0.05・0.15 R 浮く（独立監査1 Iteration 2 の G1-2-03）。
3. **パッドの粒子の尺度**（`PadEffectRenderer._getVisualMultiplier`）は、最小半径 `PAD_EFFECT.PHYSICS.MIN_VISUAL_RADIUS_PX`（2 px）を使う。構造物の描画（L607）とロケットの描画（`Rocket._getDrawRadius`）は、`ROCKET_VISUAL.MIN_SCREEN_RADIUS`（3.5 px）を使う。物理的な半径が 2〜3.5 px の縮尺では、粒子の起点（ノズル・側面）が描いたロケットの大きさと合わない（G1-2-11）。粒子の大きさ（`_drawParticles` L751）も、同じ 2 px の最小半径から決めている（G1-3-03）。

**(e) レンダラーの外の判定の重複**

1. **ペイロード段階**
   - HUD の `isPayloadPhase`（`scripts/gravsim_telemetry_card.js` L15-17）は、`isPayloadSeparated || tm.isPayloadSeparated || curStg >= totalStg` で判定する。同カードの L171-175 と、`gravsim_telemetry_panel.js` の `formatStageInfo`（L539-544）が使う。
   - レンダラーの規則にある、`!disableStaging` と `stages &&` の条件を持たない。
   - 本番の呼び出し元（パネルの L148・L463・L478 → L502）は、すべて `tm = target.telemetry` を渡す。主スレッドの `Rocket` は `stages` の配列を常に持ち（段のない機体では空の配列）、`disableStaging` の機体は分離しないため、今は食い違わない。
   - アナンシエーター（パネルの L702-703）は、段番号と段数を `(tm.stageIndex !== undefined ? tm.stageIndex : target.currentStageIndex) || 0`・`(tm.totalStages !== undefined ? tm.totalStages : target.totalStages) || 1` で、別に求めている（G1-3-06）。
   - HUD の段番号は `|| 0` で正規化する（`null`・`NaN` は 0）。レンダラーは正規化せず、テレメトリの段番号が `null`・`NaN` だと、2 段機では上段だけを描く。
2. **SRB の有無と本数**: 規則が 4 箇所にある。
   - Worker（`CalcRocket.hasBoosters`、`scripts/gravsim_calc_object.js` L331）: 本数 > 0 または燃焼時間 > 0 で SRB あり。
   - Worker の分離（L923）: 本数を `count || 2` とする。
   - HUD（`gravsim_telemetry_panel.js` L549）: `target.boosters` の本数 > 0 または燃焼時間 > 0 で SRB あり。
   - 推進剤の見積もり（`gravsim_preset_manager.js` L711 `hasSrbBoosters`）: 本数 > 0 または燃焼時間 > 0 で SRB あり。

   レンダラーは「本数 > 0」のときだけ描く。そのため、本数が 0 で燃焼時間がある設定では、物理と HUD は SRB あり、描画は SRB なしになる。出荷するプリセットにはない。

**(f) SRB の本数の上限がない（既存の不具合。独立監査2 Iteration 1 の注意で報告）**

SRB の本数は、プリセットや保存ファイルの値をそのまま使う。本数が異常に大きい設定（例: `1e9`。手で書き換えた保存ファイルなど）では、Worker の分離（`separateBoosters` の SRB ごとの繰り返し）と、描画の配置（`_drawBoosters` の `yPositions`）の繰り返しが終わらず、アプリが止まる。本ブランチでは形状（§3.2）が SRB の配置を排煙と射点の計算からも求めるため、同じ値を読む経路が増える。本数が小数のとき（例: 2.5）は、繰り返しの回数（3 回）と、1 本あたりの質量の除数（2.5）が食い違い、投棄物の質量の和が設定と合わない。利用者は、本ブランチで直すことを選んだ（2026-11-24）。

**(g) 描画の設定を読むたびに設定全体を深く写す（既存の性能の問題。独立監査2 Iteration 3 の注意で報告）**

`ROCKET_VISUAL`（`gravsim_preset_manager.js` の Proxy）は、プロパティを 1 つ読むたびに `presetManager.getRocketVisual()` を呼ぶ。`getRocketVisual()` は、描画の設定全体を `JSON.parse(JSON.stringify(...))` で深く写し、燃料ごとの噴射炎の表（`getPlumesMap`）とテーマの表（`getThemesMap`）も同じように写して組み立てる。

- 2 段機・SRB 2 本・噴射中・RCS の高詳細の描画 1 回あたり、`getRocketVisual()` は修正前（`main`）で 22 回、本ブランチで 23 回呼ばれる。描画 1 回は、修正前で約 436〜766 µs、本ブランチで約 415〜883 µs だった（作業者と独立監査1 Iteration 7 の計測、Node、`scratchpad/vapor/bench_visual.mjs`。機械の負荷で大きくばらつき、2 つの大小の順も入れ替わる）。その大半がこの写しで、写しをやめた試作では約 14 µs になった（独立監査1 Iteration 7）。
- 本ブランチは、排煙の放出位置（`updateHistory`、1 フレームに 2 回）と射点（保持中、約 8 回）でも設定を読むため、写しの回数が増える。
- 燃料の表 `ROCKET_FUELS`（`getFuelsMap`）も、同じく読むたびに全燃料を写す。Worker では構築・段の点火・段の分離のときだけ読み、毎ステップではない。
- **旧形式のプリセット**（独立監査1 Iteration 7 の G1-7-01）: Rocket タブを開いて射点に出すまでの間、`RocketLauncher.drawPreview` は毎フレーム（カードの小窓が見えていれば 2 回）`getBottomOffsetM`・`getBaseRadiusM` を呼ぶ。そのたびに `getLegacyPreset` が `getLegacyPresets()` を呼び、全機体の旧形式のプリセットを組み立て直す。1 回あたり `calculateMissionFlightPlan` が 10 回、`getFuel` の深い写しが 20 回で、約 260 µs かかる（同監査の計測）。`_legacyPresets` は `null` を代入するだけで読まれない値である。
- 利用者は、既存の写しごと本ブランチで直すことを選んだ（2026-11-24）。

- **天体・物体のパラメータ**（独立監査1 Iteration 8 の G1-8-01）: `getObjectParam(name)`（`getCelestial`）は、呼ぶたびにパラメータを深く写す（1 回約 1.8 µs）。次の毎フレームの経路がこれを呼ぶ。
  - `Rocket._visualBaseRadiusM`（本ブランチで設けた。描画・`updateHistory`・射点が使う）は、`baseRadiusM` があっても、代わりの値（`this.param?.RADIUS || getObjectParam('Rocket')?.RADIUS`）を先に求める。保存から読み込んだロケットは `param` を持たない（`ObjectManager.loadState` は `param` を保存も復元もしない）ため、毎回写しを作る。
  - プレビューの標的の印 `RocketLauncher.drawTargetMarker`（L409）は、毎フレーム `getObjectParam('Rocket')` を 1〜2 回呼ぶ。
  - スリングショットの配置のプレビュー `ObjectPlacer.drawPreview` の HUD（L979-980）と、そこから呼ぶ `getLaunchObjectName`（L798）は、毎フレーム `getObjectParam` を 2〜3 回呼ぶ。
  - 66d3687 より前の保存ファイルは天体の `param` を書かず、読み込んだ天体は `param` を持たない（`ObjectManager` の読込 L739 は版を確かめず、保存し直しても `null` のまま）。そのような天体では、天体の効果の描画 `CelestialBody._drawEffects`（L238、天体ごとに毎フレーム）、射点の位置 `RocketLauncher._calculateTransform`（L379）が、毎回写しを作る（独立監査1 Iteration 9 の G1-9-01）。Worker は天体を加えるときに `param` を決める（`gravsim_calc.js` L57・L127）ため、毎ステップの読み（`getCelestialParam` の代わりの値、`FlightComputer._updateTelemetry` L389）で写しは作らない。ただし投棄物など名前が表にない物体では、毎回、全天体を名前で探してから `null` を返す（投棄物 1 個で 1 更新あたり 11 回。独立監査1 Iteration 10 の計測）。全箇所の分類は §3.11-5 の表のとおりである。

#### 1.4.2 確かめて、直さないもの

- **`NOZZLE_BOTTOM_OFFSET`**（`presets/visuals/rocket.json` L36-40）
  - 射点の位置（`getBottomOffsetM`、物理）と、パッドの演出が使う形状の写しである。
  - 値（1.85・3.10・3.45）は、`R = 1` の形状の、全段が付いたときのノズル端とビット単位で一致する。
  - 物理に入るため、値は変えない。一致はテストで固定する（§5.1-9）。この写しは R7 の例外である。
- **パッドの排気の起点**（`PAD_EFFECT.PHYSICS.SIDE_OFFSET_MULT` 1.0）
  - x = 0 の胴体の半径は、全構成で 0.7 R である（1 段機・2 段機は第 1 段、3 段機は下側の段間）。
  - そのため、壁から外へ 0.3 R という余白は、構成によらず一定である。構成で食い違う写しではないため、意図した余白として残す。
  - この比較は、パッドの粒子とロケットが同じ尺度で描かれるとき（§3.8-3 の修正の後）に成り立つ。
- **主エンジン・SRB の噴射炎の起点**: 描画と同じ座標から作っており、ずれはない。

#### 1.4.3 別ブランチにするもの（利用者の判断、2026-11-23）

次の 2 点を変える必要があるため、利用者は別ブランチにすることを選んだ。

- Worker の物理（投棄物の初期位置）
- 描画の基準点の設計（段の分離で残った機体の描き方）

[構造の見直しへの入力](2026-11-21_architecture_redesign_inputs.md) に、H1-15・H4-25 として記録した（§6）。

- **分離のたびに、残った機体の描画が飛ぶ**: 機体の位置に対する描画の基準が、段の構成で変わる。基準は `presets/visuals/rocket.json` の `ALIGNMENT.BASE_X_*` で決まる。たとえば 2 段機の上段は、分離の前は 0.400〜1.600、後は -0.600〜0.600 に描かれ、1.0 R 後ろへずれる。
- **投棄物の初期位置が、描いていた位置と違う**
  - 段の投棄物は、機体の中心から `baseRad × 1.5 + 20 m` 後方に現れる。Falcon 9 の第 1 段（`R` = 70 m）では -1.79 R で、描いていた中心 -1.35 R より 0.44 R 後ろである。値は機体と段で変わる。
  - フェアリングの半分は、機体の中心の真横（`baseRad × 1.2 + 15 m`、前後の位置は 0）に現れる。
  - SRB の投棄物は、機体の中心の真横（`baseRad × 1.5 + 8 m`。4 本では前後に ±0.4 `baseRad`）に現れる。描いていた SRB の中心（2 段機で x = -1.564 R、y = ±0.947 R）とは違う。
  - Worker の `baseRad` は、`baseRadiusM` を受け取らず `radius / 3.10` で代わりに求める（H1-8 と同じ原因）。そのため、尺度は SSTO で 0.597 倍、Epsilon で 1.113 倍になる。
- **投棄物の描画寸法が機体と違う**（`RENDER.DEBRIS_HARDWARE`、`Debris._drawBody`）
  - 第 2 段は 1.6 R（機体では 1.2 R）、フェアリングは 1.3 R（同 1.1 R）である。
  - 3 段機の第 2 段は、第 1 段の形（2.8 R、フィン付き）で描かれる。
  - 3 段機の第 3 段は、2 段機の第 2 段の寸法で描かれる。
  - 直すには、どの段の投棄物かを Worker から受け取る必要がある。

### 1.5 修正後の雲の範囲と受け入れの根拠

修正後のピーク（マッハ 1.00、強度 1、気圧比 0.265 以上）での範囲を、§3.5 の式で求めた（`R = 1`、フェアリングあり）。「機体の外に出る位置」は、雲の輪郭が、その位置の胴体の半径を最初に越える x である。頂点は機体の軸の上（胴体の内側）にあるため、見える雲はここから始まる。

| 構成 | 機体（ノズル端〜機首）・中央 | 主コーン 頂点 → 後端・機体の外に出る位置 | 副コーン 頂点 → 後端・機体の外に出る位置 |
|---|---|---|---|
| 1 段 | -1.850〜2.400・0.275 | 1.300 → -0.625・0.916 | なし |
| 2 段・第 1 段飛行 | -3.100〜2.700・-0.200 | 1.600 → -0.188・1.244 | 0.400 → -1.102・-0.036 |
| 2 段・第 2 段飛行 | -0.920〜1.700・0.390 | 0.600 → -1.188・0.244 | なし |
| 3 段・第 1 段飛行 | -3.450〜3.500・0.025 | 2.400 → 0.612・2.119 | 1.500 → 0.106・1.095 |
| 3 段・第 2 段飛行 | -1.920〜1.850・-0.035 | 0.750 → -1.038・0.469 | -0.150 → -1.544・-0.555 |
| 3 段・第 3 段飛行 | -1.180〜1.100・-0.040 | 0.000 → -1.788・-0.281 | なし |

修正前の 2 段・第 1 段飛行（ピーク）は、次のとおりだった。

| | 頂点 → 後端 | 機体の外に出る位置 |
|---|---|---|
| 主コーン | 1.174 → -0.751 | 0.829 |
| 副コーン | -0.352 → -1.853 | -0.788 |

**受け入れの根拠**: 利用者は 2026-11-23 に、この位置と大きさで描いた試作の画像を見て、案 A を選んだ。案 A は、主コーンをフェアリングの肩に、副コーンを最上段の段間の前端に置く。

- 比べた案 B は主コーンだけで、2 段・第 1 段飛行の雲は機体中央の 0.012 R 前で終わる。
- 案 A を選ぶ質問では、「2 段機では機首から約 4 割の位置で、雲の後ろ側は機体中央にかかる」と説明した。

したがって、副コーンの雲が機体中央にかかることは要求に合う。直す対象は、雲が機体の形と無関係な位置から出ることである。主コーンの雲がフェアリング基部から、副コーンの雲が段間の前端から出ることで満たす。

---

## 2. 要求

1. **R1（主コーン）**: 主コーンは、機首の肩から後方へ広がる。機首の肩は次のとおりである。
   - フェアリングがあれば、フェアリングの基部。
   - フェアリングがなければ、露出したペイロードの前面。
   - ペイロード単体なら、衛星の前面。
2. **R2（副コーン）**: 強度が `SECONDARY_INTENSITY_MIN`（0.55）以上で、現在の機体に段間があるとき、副コーンは最上段の段間の前端から後方へ広がる。
   - 段間のない構成（1 段機、2 段機の第 2 段飛行、3 段機の第 3 段飛行、ペイロード単体）では描かない。
   - 副コーンを残すことは、利用者の選択（案 A、2026-11-23）である。
3. **R3（コーンの大きさ）**: 各コーンの長さ・幅・縁は、頂点の位置の機体の半径から決める。
4. **R4（RCS）**
   - スタックでは、ノズルを現在の段（描画している最下段）の壁に置き、横向きに噴射する。
     - 位置は、噴射の三角形（半角 `PLUME_SPREAD_RAD`）が、壁より外に張り出す部品に掛からない区間に置く。対象の部品は、フィン・SRB・胴体より太い隣の部分（フェアリングなど）である。
     - 壁の位置と噴射の長さは、その胴体の半径から決める。
   - ペイロード単体では、ノズルを衛星本体の四隅に置き、前後（機軸の方向）に噴射する。本体の上下に張り出すパネルとアンテナに掛からない。
   - フェアリング・SRB の分離で、ノズルの位置が変わらない。
   - 噴射は、機体・噴射炎・ベイパーコーンの上に描く（現在と同じ順）。噴射炎に隠れないためである。
   - 次の 2 つの重なりは、利用者の了承（2026-11-24。範囲を訂正して取り直した）で許容する。
     - 第 1 段のアレージの噴射が、胴体に沿って後ろへ伸びてフィン・SRB の上に重なること。第 1 段が惰行の後に再点火するとき（1 段機の再点火、2 段機・3 段機でもフライトプランで第 1 段に推力 0 の行を入れたとき）に起きる。H3-22・H3-24 では SRB に重なる。
     - 衛星の前方の噴射が、縮小したとき（`R` が 6.3〜8.0 px 未満）にアンテナの線と最大約 0.30 px 重なること。
   - 「部品が噴射より上」「噴射が噴射炎より上」「噴射炎が胴体より上（SRB の炎は第 1 段の後端に重なる）」の 3 つは循環し、描く順だけでは全部を満たせない。利用者は、噴射を常に見せる順を選んだ。
5. **R5（排煙・火花）**: 放出位置は、高詳細で描く噴射炎の起点と、ゆらぎを除いた炎の先端に一致する。ペイロード単体のときは、ペイロードの噴射炎を使う。尺度と範囲は §3.7 のとおりである。
6. **R6（射点）**
   - アンビリカルの接続点とアームの先端は、その位置の機体の外形（その x を覆う描画部品の半径の最大）にある。
   - パッドの粒子の位置と大きさは、ロケットと同じ尺度で決める。
7. **R7（形状の単一の出どころ）**
   - 機体の形は 1 箇所で計算し、描画・演出の位置・排煙・射点の接続点はすべてそこから取る。
   - 例外は `NOZZLE_BOTTOM_OFFSET` だけである（§1.4.2）。物理に入る写しのため値を残し、形状との一致をテストで固定する。
8. **R8（判定の単一の出どころ）**: 次の判定は、それぞれ 1 つの関数を使う。
   - スタックの状態（ペイロード単体・現在の段・段数・フェアリング）。主スレッドの、レンダラーの両方の詳細度、HUD（カード・段の表示・アナンシエーター）、排煙が使う。
   - SRB の設定（主スレッドの物体の `boosters`。`ObjectManager` が Worker に送るのもこれだけである）。主スレッドの、レンダラーの両方の詳細度と HUD が使う。
   - SRB の本数の式（設定から本数を決める）。上の使う側に加えて、Worker（`CalcRocket` が構築時に決めた `this.boosters` に対して）と推進剤の見積もりが使う。
9. **R9（変えないもの）**
   - 機体（`_drawHighDetail`・`_drawLowDetail`）の Canvas の命令列（命令と引数）は、次の 5 種類の入力でだけ変わる。
     - 低詳細のペイロード単体の判定と SRB の読み元が、§3.1 の 1 つの規則に揃う入力（低詳細だけが変わる）。
     - SRB の本数が §3.1 の `boosterCount` で現在と違う値になる設定。両方の詳細度で、その本数を描くようになる。
       - 本数が 1 以上の有限の数でなく（0・未定義・`null`・`NaN`・負の数・有限でない値・`"0"` など）、燃焼時間が有限の正の数の設定（2 本）。
       - 本数が 10 以上か小数の設定（上限と切り捨て。§1.4.1 (f)）。
       - 本数が数でない値で表されている設定（`"4"`・`[4]`・`" 4 "` など）。数に直した本数で描くため、高詳細の配置が汎用の並びから本数どおりの並び（4 本なら対の並び）に変わる。
     - テレメトリの段番号が `null`・`NaN` など偽の値になる入力（§3.1 の `|| 0`。両方の詳細度で段番号 0 として描く）。
     - SRB の設定を `rendering.boosters` か `stages[0].boosters` にだけ持つ入力（§3.1。Worker と同じく `boosters` だけを読むため、SRB を描かなくなる）。
     - 段番号が段の番号でない機体（§3.1 の段番号の正規化と現在の段）。段数 1 の機体で段番号 1 以上なら、低詳細も第 1 段を描く。段数以上の段番号では、噴射ありの高詳細の噴射炎が最後の段の燃料になる。負と小数の段番号は、正規化した段を描く。
   - `draw()` が描く順（機体・ベイパーコーン・RCS）は変えない。

     対象の入力は §5.4 の表に挙げる。それ以外の入力では変えない。
   - 物理・予測・保存は変えない。Worker と推進剤の見積もりで変えるのは、次の 4 つだけである（§3.1・§3.11）。予測のビット一致検査 d2・s2 で確認する。ただし、保存ファイルの段番号の正規化は、d2・s2 が通らない復元の分岐（予測は `restoredRuntimeState` を渡さず、s2 は保存・読込をしない）にあるため、unit 10-2（Worker の復元）、回帰 12（保存→読込の実際の経路）、system 04・05（正しい保存ファイルの E2E）で確かめる。
     - 保存ファイルの段番号の正規化（§3.1 の `normalizeStageIndex`。主スレッドの読込と Worker の復元）。正しい保存ファイル（0 から段数までの整数。段のない機体は段数 1 として数える）では同じ値になる。異なるのは次の入力だけである。
       - Worker の値が変わるのは、次の 2 つである（前の Worker の復元は `Math.max(0, Math.min(Number(x) || 0, 段数))`）。
         - 数にすると 0 と段数の間の小数になる値（`0.5` のほか、文字列の `"0.5"` など）: 切り捨てる。前は小数のまま残り、`stages[0.5]` が `undefined` になって読込が途中で失敗した。
         - `disableStaging` の機体で、数にすると段数以上になる値（`2` のほか、`"2"`・`[5]`・段数 1 の `true` など）: 最後の段までにする。前は段数（段のない位置）だった。
       - それ以外の値（負の数、数にならない値、`disableStaging` でない機体の段数を超える値など）では、Worker の値は前と同じである。
       - 主スレッドは、前は最初の Worker のフレームまで書かれた値のまま（検証しない）だった。今は、正規の値（0 から段数までの整数、`disableStaging` の機体は段数 − 1 まで）でないすべての値を、読込のときに Worker と同じ値に収める。
     - SRB の本数の式（分離の本数・`hasBoosters`・乾燥質量の既定値）。出荷するプリセットでは同じ値を返す。異なるのは不正な本数（10 以上・小数・負の数・文字列など）だけで、そのとき分離の本数や SRB の有無が §3.1 の規則の値になる。
     - `CalcRocket` の SRB の設定の、届かない代わりの値の削除。全入力で同じ値になる。
     - 設定の写しのキャッシュ（§3.11。Worker も `gravsim_preset_manager.js` を読み込む）。返す値は現在と同じである。
   - 主スレッドの読込は、保存ファイルの段数（`totalStages`）を読まず、段の配列から Worker と同じ数え方で決める（§3.1、Rev 27）。Worker の変更ではない（Worker は前から段の配列で数える）。最初の Worker のフレームの後に保存したファイルでは、値は変わらない。値が変わるのは次の保存ファイルで、前は読込の後の主スレッドの値が、最初の Worker のフレームまで (1)・(2) では保存ファイルの値、(3) では `Rocket` の初期値 1 のままになり、そのあいだに保存すると、保存（`ObjectManager` L617）がその値（偽の値なら段の配列の数）を書いた。(1) 配置の後、最初の Worker のフレームの前に保存した多段機（一時停止の中でロールアウトして、すぐに保存したとき）。主スレッドの `Rocket.totalStages` はフレームまでコンストラクタの初期値 1 のため（Worker は一時停止の間フレームを送らない）、書き換えていなくても `totalStages` 1 を持つ（`main` と同じ）。前は読込の後も 1、今は段の配列の数になる。(2) `totalStages` を書き換えた保存ファイル。(3) `totalStages` のキーを消した保存ファイル（書き換えたものだけである。`stages` と `totalStages` は、どちらも 66d3687 で保存に加わり、それより前の保存ファイルは段を持たず、段数は前も今も 1）。保存は今も `totalStages` を書く（本ブランチより前の版のアプリは、読込でこの値を使うため）。書く値は前と同じ `obj.totalStages || 段の配列の数` である。配置したロケットでは、最初の Worker のフレームの前に保存すると 1 を書く（`main` と同じ。構造の見直しの入力 H2-17）。読み込んだロケットでは、最初のフレームの前に保存すると、本ブランチは読込で決めた段の配列の数を書き、`main` は読み込んだ値（キーがなければ `Rocket` の初期値 1、0・`null` などの偽の値なら段の配列の数）を書いた。最初のフレームの後は、どちらもテレメトリの段数を書く。本ブランチの読込は、どの場合もこの値を読まない。
   - 次の要素は変えない。
     - ベイパーコーンの強度・マッハ角・色・形の式と、LOD の条件。
     - RCS の噴射の形（広がり・色）と、スタックの横向きの噴射の方向の表。
     - 排煙・火花の記録の条件（`isBurning || inAtmosphere || isEscaping`）。

10. **R10（設定の写し）**: 描画の設定、燃料・噴射炎・テーマの表、旧形式のプリセットの一覧、毎フレーム・毎ステップに読む天体・物体のパラメータは、プリセットの表が変わったときにだけ組み立て直し、それ以外は同じものを返す。返すものは変更できない（深く凍結した）形とし、ある読み手の変更がほかの読み手に漏れない。例外として、Worker の物理エンジンが初期化で受け取る `celestialParams` の物体は、現在どおり凍結せずに共有する（`peekCelestialParam` はそれをそのまま返す）。返す値は現在と同じで、描画と物理は変わらない（§5.4 で確かめる）。

---

## 3. 設計

### 3.1 スタックの状態と SRB の規則（`scripts/gravsim_utils.js`、新設 `RocketStackUtils`）

Worker と主スレッドの両方が読み込める `gravsim_utils.js` に置く（R8）。

```js
/** Largest SRB count the rules accept: the most strap-ons a real vehicle has flown (Delta II, 9). */
const MAX_BOOSTER_COUNT = 9;

export class RocketStackUtils {
	/**
	 * Stack state: the renderer (both LODs), the smoke emission and the HUD use this one rule. The HUD passes the
	 * telemetry it shows; everything else uses the rocket's own.
	 */
	static resolveStackState(rocket, telemetry = rocket?.telemetry) {
		const totalStg = telemetry?.totalStages || rocket?.stages?.length || 1;
		const stageIndex = RocketStackUtils.normalizeStageIndex(
			telemetry?.stageIndex !== undefined ? telemetry.stageIndex : rocket?.currentStageIndex, totalStg
		);
		const isPayloadOnly = !rocket?.disableStaging && Boolean(
			rocket?.isPayloadSeparated || telemetry?.isPayloadSeparated || (rocket?.stages && stageIndex >= totalStg)
		);
		// Out of the payload phase the current stage is one of the vehicle's stages
		const curStgIdx = isPayloadOnly ? stageIndex : Math.min(stageIndex, totalStg - 1);
		const hasFairing = Boolean(
			rocket?.disableStaging || (rocket?.fairing?.enabled && !telemetry?.isFairingSeparated && !rocket?.fairing?.isSeparated)
		);
		return { curStgIdx, totalStg, isPayloadOnly, hasFairing };
	}

	/**
	 * Stage index of a save, a Worker restore or the telemetry: a whole number in [0, stageCount] (the count is the
	 * payload phase); a disableStaging vehicle at most its last stage.
	 */
	static normalizeStageIndex(value, stageCount, disableStaging = false) {
		const index = Math.floor(Number(value) || 0);
		const last = disableStaging ? stageCount - 1 : stageCount;
		return Math.max(0, Math.min(index, last));
	}

	/** The SRB configuration a main-thread rocket object carries. */
	static resolveBoosters(rocket) {
		return rocket?.boosters || null;
	}

	/** SRB count: the count rounded down and capped at MAX_BOOSTER_COUNT (9) when at least 1, else 2 for a burning configuration, else 0. */
	static boosterCount(boosters) {
		if (!boosters) return 0;
		const count = Number(boosters.count);
		if (Number.isFinite(count) && count >= 1) return Math.min(MAX_BOOSTER_COUNT, Math.floor(count));
		const burnTimeSec = Number(boosters.burnTimeSec);
		return (Number.isFinite(burnTimeSec) && burnTimeSec > 0) ? 2 : 0;
	}
}
```

**`resolveStackState`**: 現在の高詳細の式に、テレメトリの出どころを引数にしたものである。段番号は `normalizeStageIndex` で正規化する（`null`・`NaN` は HUD と同じく 0。現在の高詳細は、テレメトリの段番号を正規化しない）。ペイロード段階でないときは、最後の段までにする（下の「現在の段」）。

- レンダラーの両方の詳細度と形状（§3.2）、`Rocket.updateHistory`（§3.7）は、`resolveStackState(rocket)` を使う。
  - **段番号の正規化**（Rev 22、§8.20）: 段番号は `normalizeStageIndex` で、0 から段数までの整数にする。数でない値（`null`・`NaN`・`undefined`・数にならない文字列）は 0、小数は切り捨て、範囲の外は収める。段数はペイロード段階（最後の段の 1 つ先）を表す。`disableStaging` の機体は分離せず、ペイロード段階にならないため、最後の段（段数 − 1）までとする。
    - 次の 4 か所が、この 1 つの関数を使う。`resolveStackState`（描画・HUD）、主スレッドの読込（`ObjectManager.loadState`）、Worker の復元（`CalcRocket` の `restoredRuntimeState`）、`Rocket.mass`。
    - 前は、4 か所の規則が別々だった（`main` でも同じ）。読込は検証せず、Worker の復元と `Rocket.mass` は `Math.max(0, Math.min(Number(i) || 0, count))` で小数を残し、描画と HUD は `|| 0` だけだった。小数の段番号の保存ファイルは、`stages[0.5]` が `undefined` になって読込が途中で失敗し、主スレッドにはロケットが残り、Worker にはなかった。負の段番号は、Worker と質量が第 1 段、描画が最後の段（高詳細の形状は 0 でも 1 でもない段番号を最後の段として描く）で、最初の Worker のフレームまで食い違った。
    - 正しい保存ファイル（段番号が 0 から段数までの整数、`disableStaging` の機体は 0）では、値は変わらない。`disableStaging` の機体は分離せず（`separateCurrentStage` が戻る）、`disableStaging` は物体を作るときと読込のときだけ決まる（`ObjectPlacer`・`loadState`）ため、範囲の外の段番号は、書き換えた保存ファイルか、試験の入力からしか来ない。
    - 段数は、使う側ごとに次のとおり数える。`resolveStackState` はテレメトリの段数、なければ `stages.length || 1`。読込は、段の配列がないか空なら 1（Worker の `normalizeRocketConfig` が 1 段を作り、保存の `totalStages` も 1 とする）。読込は保存ファイルの `totalStages` を読まず、主スレッドの `totalStages` もこの段数にする（Rev 27。前は保存ファイルの値をそのまま入れ、最初の Worker のフレームでテレメトリの値に置き換わるまで、その値を持った。そのあいだに保存すると、保存（`ObjectManager` L617）がその値（偽の値なら段の配列の数）を書いた。読み込んだロケットは予測線を持たないため、予測線のイベントの印は、そのあいだ段数を読まない）。この段数は、保存ファイルに段番号があるかどうかによらず決める。Worker の復元は `totalStages`、`Rocket.mass` は `stages.length`（段の配列が空なら使わない）。段のない機体（ストレステストの群れのロケット）は、主スレッドでは `stages` が空で、Worker では 1 段で飛び、数フレームでペイロード段階（段番号 1）になる。
  - **現在の段**: ペイロード段階でないとき、`curStgIdx` は正規化した段番号を最後の段（段数 − 1）までにした値とする。ペイロード段階では正規化した段番号のままである（カードはペイロードのタンクを、段の表示は `PAYLOAD` を使う）。
    - 最後の段までにするのは、ペイロード段階にならない機体（`disableStaging` の機体と `stages` のない物体）の段番号が段数以上の場合である。
    - 前は、この状態で使う側の判定が食い違っていた（`main` でも同じ）。段数 1 の機体で段番号 1 以上のとき、高詳細（形状の段数 1 の行は段番号を見ない）は第 1 段と SRB を描き、低詳細は上段の楕円を描いた。HUD は「2 / 1」と表示し、SRB の表示・第 1 段の名前・1-ENG を出さず、MECO を点けた。高詳細の噴射炎の燃料は、段番号の段がないため代わりの値になった。
    - この値を、両方の詳細度・形状（第 1 段の有無と噴射炎の燃料）・HUD（段の表示、SRB の表示、カードの見出しと残量の最大値、アナンシエーター）が使う。低詳細の `hasStage1 = !isPayloadOnly && curStgIdx === 0` は、`main` と同じ式のままである。
    - 描画で変わるのは次のものである。§5.4 の入力で変わるのは、段数 1・段番号 1 と 2・`disableStaging` の 192 通りで、段数 2・3 の燃料は、入力ではどちらも `liquid` で同じである。§5.4 の入力に、負と小数の段番号はない。
      - 段数 1 の機体の低詳細（第 1 段を描く）。
      - 噴射炎の燃料（段数以上の段番号で、最後の段の燃料になる）。
      - 負と小数の段番号の段（正規化した段。負と 1 未満の小数は第 1 段、段数 3 の 1.5 は第 2 段）。高詳細は、もとは最後の段を描いた。
- HUD
  - `gravsim_telemetry_card.js` の `isPayloadPhase` を削除する。
  - カードの `update(target, tm)`、パネルの `formatStageInfo(target, tm)` とアナンシエーター（L702-703）は、`resolveStackState(target, tm)` の `curStgIdx`・`totalStg`・`isPayloadOnly` を使う。
  - アナンシエーターの段数の代わりの値は、`target.totalStages` から `target.stages.length` に変わる。2 つが異なるのは、最初の Worker のフレームの前だけである。このとき、プレースホルダのテレメトリは段数を持たず、`target.totalStages` はコンストラクタの既定値 1、`stages.length` は機体の段数になる。最初のフレームの後は、テレメトリが段数を持つ。最初のフレームの前は段番号が 0（射点の PRE-LAUNCH）で、段数で決まる灯は点かないため、表示は変わらない。
  - `tm` を明示して渡すため、テストのように `target.telemetry` と別の `tm` を渡しても、表示の意味は現在と同じである。
  - 規則に加わる `!disableStaging` と `stages &&` は、§1.4.1 (e) の理由で、本番の表示を変えない。

**`resolveBoosters`**: 主スレッドの物体の SRB の設定で、`rocket.boosters` だけを読む。

- `ObjectManager` が Worker に送る SRB の設定は `obj.boosters` だけで（L153）、Worker の物理はこれに従う。主スレッドの表示も同じ設定から決めると、描画・HUD・物理の SRB が一致する。
- 現在の高詳細は、`rendering.boosters` と `stages[0].boosters` にも落ちる。これらにだけ設定を持つ物体では、物理にない SRB を描いていた。本番のロケットは、`boosters` か `rendering.boosters` があれば必ず `boosters` を持つため、この食い違いは起きない。2 つを合成するのは、ランチャの `applyPreset`（`gravsim_rocket_launcher.js` L237）、プリセットの適用（`gravsim_preset_manager.js` L649）、Rocket タブ（`gravsim_tab_rocket.js` L799）である。ランチャの初期値（L66）と `gravsim_preset_manager.js` L1087 は、合成せず、`boosters` がなければ `rendering.boosters` を `boosters` に入れる。
- Worker の `CalcRocket` の L330 は、`normConfig.boosters || thrustData?.boosters || thrustData?.rendering?.boosters || (normConfig.stages && normConfig.stages[0]?.boosters) || null` である。後ろの 3 つの代わりの値は、どれも届かない。
  - `normConfig.boosters` は `thrustData.boosters` の写し（`normalizeRocketConfig` L241）のため、`thrustData?.boosters` に落ちるのは、それも偽のときだけである。
  - `rendering` は Worker に渡らない。
  - 段の `boosters` は、`normalizeRocketConfig` が落とす。

  そのため `this.boosters = normConfig.boosters || null` とし、3 つを削除する（開発プロセス §3.2）。全入力で同じ値になる。
- 使う側は、レンダラーと HUD の SRB 表示（パネル L549。現在も `target.boosters` だけを読む）である。Worker は構築時に決めた `this.boosters` を持ち、本数の式 `boosterCount` だけを共有する。

**`resolveStackState`・`resolveBoosters` の `rocket?.`**: `rocket` が `null` や `undefined` でも例外を出さず、既定の状態（段番号 0、段数 1、スタック、フェアリングなし）と `null` を返す。

**`boosterCount`**: 本数の値を数に直し（`Number(count)`）、有限で 1 以上なら切り捨てて上限 `MAX_BOOSTER_COUNT`（9。実在の機体で最も多い Delta II の 9 本）で抑える。そうでなければ（0・負・小数の 0.5・`NaN`・`null`・未定義・文字列 `"0"`・有限でない値など）、燃焼時間を数に直した値が有限の正の数のとき 2、そうでなければ 0 とする。

- 上限は §1.4.1 (f) の止まる不具合を直すため、切り捨ては繰り返しの回数と質量の除数を一致させるためである（利用者の判断、2026-11-24）。
- 有限でない値を不正として扱うのは、主スレッドと Worker の本数を揃えるためである。保存ファイルの `1e999` は `JSON.parse` で `Infinity` になり、主スレッドの物体（`ObjectManager.loadState` L688）にはそのまま入るが、Worker には JSON の写し（L153、`normalizeRocketConfig` L241）で送るため `null` になる。どちらも「値がない」として同じ本数になる。
- 公開の定数は設けない（読む側がない）。

Worker の現在の規則との関係は次のとおりである。

- `hasBoosters`（`count > 0 || burnTimeSec > 0`）と `boosterCount(...) > 0` は、本数が 1 以上の有限の数、0・未定義・`NaN`・`null`、負の数で、同じ真偽になる。異なるのは次の設定だけである。
  - 0 < 本数 < 1（小数の 0.5 など）で燃焼時間がない設定。現在は SRB あり、修正後は SRB なし。
  - 本数・燃焼時間が有限でない設定（`Infinity`）。修正後は値がないものとして扱う。Worker は設定を JSON の写しで受け取り、有限でない値は `null` になるため、Worker の挙動は変わらない。
- 分離の本数 `count || 2` と `boosterCount` は、本数が 1〜9 の整数、0・未定義・`NaN`・`null`（燃焼時間が有限の正の数のとき 2）で同じ値になる。異なるのは、10 以上・小数・負の数・文字列などの不正な本数で、修正後は上の規則の値になる。
- SRB の乾燥質量の既定値（`dryMassT` がないとき、4 本なら 40 t、それ以外 20 t。L447・L917）も、本数をこの規則で決める。本数が 4 の整数なら現在と同じ値である。
- 出荷するプリセットの本数（0・2・4）では、どれも現在と同じ値になり、物理は変わらない（d2・s2 で確かめる）。
- 推進剤の見積もりの `hasSrbBoosters`（`gravsim_preset_manager.js` L711）は、`boosterCount(boosters) > 0` と、上の `hasBoosters` と同じ入力で同じ真偽になる。設定を写さずに読むため、有限でない値の設定では、現在の式と結果が変わる（修正後は値がないものとして扱う）。プリセットの JSON でも、`1e999` のような値は `JSON.parse` で `Infinity` になる。

使う側は次のとおりである。

- Worker: `CalcRocket.hasBoosters` と分離の本数。
- HUD の SRB 表示: `boosterCount(resolveBoosters(target)) > 0`。
- 推進剤の見積もり: `hasSrbBoosters`。
- レンダラー: 高詳細の本数と、低詳細の幅の倍率。

**描画の変化**（R9）

- 低詳細
  - ペイロード単体の判定が、`rocket.currentStageIndex >= rocket.totalStages` から本規則に変わる。
  - SRB の本数が、`rocket.boosters?.count || rocket.rendering?.boosters?.count` から `boosterCount(resolveBoosters(rocket))` に変わる。
- 両方の詳細度
  - 本数が 10 以上なら 9 本を、小数なら切り捨てた本数を描く（高詳細の本数、低詳細の幅の倍率）。
  - 本数が 1 以上の有限の数でなく燃焼時間が有限の正の数の設定では、SRB を 2 本描く。
  - 本数が数でない値（`"4"`・`[4]`・`" 4 "` など）なら、数に直した本数で描く。高詳細の配置は、汎用の並びから本数どおりの並び（4 本なら対の並び）に変わる。
  - Worker も同じ `boosterCount` を使うため、どの設定でも描画・HUD・物理の本数が一致する（有限でない値は上記の理由で揃う）。
  - テレメトリの段番号が偽の値（`null`・`NaN` など）なら、段番号 0 として描く（HUD と同じ）。
  - SRB の設定を `rendering.boosters` か `stages[0].boosters` にだけ持つ物体では、SRB を描かない（物理と同じ）。

### 3.2 形状 `RocketRenderer._computeStackGeometry(rocket, R, visualCfg = ROCKET_VISUAL)`

機体の形を計算する唯一の関数である（R7）。座標は機体の局所座標（`+x` が機首）の画面ピクセル（`R` に比例）である。

```js
{
	state,            // RocketStackUtils.resolveStackState(rocket)
	payload,          // { cx, r, isDeployed } | null
	fairing,          // { startX, radius, length } | null   描くフェアリング（付いているとき）
	fairingConfig,    // { startX, radius, length } | null   構成のフェアリング（分離の後も）
	segments,         // 機首から機尾の順（描画の順）
	boosterLayout,    // 構成の SRB の配置（§3.3）| null
	boostersAttached, // SRB を描くか
	plume             // { x, scale, fuelType, isFiring }
}
// segments の要素
{ kind: 'stage', stageIndex, startX, radius, length, nozzleX, nozzleLength, isExposedNozzle, hasFins }
{ kind: 'interstage', startX, radius, length }
```

#### ペイロード単体（`state.isPayloadOnly`）

- `payloadR` は次の 3 通りである。
  - 1 段機（`totalStg === 1`）: `r1`
  - 3 段以上（`totalStg >= 3`）: `r3`
  - それ以外: `r2`
- `payload = { cx: 0, r: payloadR, isDeployed: true }`、`fairing = null`、`fairingConfig = null`、`segments = []`、`boosterLayout = null`、`boostersAttached = false` とする。
- `plume` は次のとおりである（`busW = payloadR × SATELLITE_BUS_W_RATIO`）。
  - `x: -busW × 0.5`
  - `scale: ALIGNMENT.PAYLOAD_PLUME_SCALE ?? 0.35`
  - `fuelType: payloadFuelType(rocket)`
  - `isFiring: isPayloadEngineFiring(rocket)`

#### スタック

各位置は、現在の `_drawHighDetail` と同じ演算を同じ順で行って求める。浮動小数点の結果を変えないためである（R9）。

| 構成 | 基準 | 位置の式（現在の `_drawHighDetail` と同じ） | フェアリングの半径 | 露出ペイロードの半径 |
|---|---|---|---|---|
| 1 段 | `stg1X = R × (BASE_X_SINGLE_STAGE_RATIO ?? -1.5)` | `nozzle1X = stg1X - lNozzle1`、`fairingX = stg1X + l1` | `r1` | `r1` |
| 3 段・`curStgIdx === 0` | `stg1X = R × (BASE_X_3STG_STAGE1_RATIO ?? -3.1)` | `nozzle1X = stg1X - lNozzle1`、`inter1X = stg1X + l1`、`stg2X = inter1X + lInter`、`inter2X = stg2X + l2`、`stg3X = inter2X + lInter2`、`fairingX = stg3X + l3` | `r2` | `r3` |
| 3 段・`curStgIdx === 1` | `stg2X = R × (BASE_X_3STG_STAGE2_RATIO ?? -1.6)` | `nozzle2X = stg2X - lNozzle2`、`inter2X = stg2X + l2`、`stg3X = inter2X + lInter2`、`fairingX = stg3X + l3` | `r2` | `r3` |
| 3 段・それ以外 | `stg3X = R × (BASE_X_3STG_STAGE3_RATIO ?? -0.9)` | `nozzle3X = stg3X - lNozzle3`、`fairingX = stg3X + l3` | `r2` | `r3` |
| 2 段（`hasStage1 = curStgIdx === 0`） | `stg2X = hasStage1 ? R × BASE_X_STAGE1_RATIO : R × BASE_X_UPPER_RATIO` | `fairingX = stg2X + l2`、`interX = stg2X - lInter`、`stg1X = interX - l1`、`nozzle1X = stg1X - lNozzle1`、`nozzle2X = stg2X - lNozzle2` | `r2` | `r2` |

`r1`〜`r3`、`l1`〜`l3`、`lInter`、`lInter2`、`lFairing`、`lNozzle1`〜`lNozzle3` の式（既定値の `||` を含む）は、現在の `_drawHighDetail` と同じである。

- **`segments`**: 機首から機尾の順に、描画する胴体と段間を並べる。3 段・第 1 段飛行なら、第 3 段・段間 2・第 2 段・段間 1・第 1 段の順である。
  - `stageIndex` は構造上の段番号（0 が第 1 段）で、`curStgIdx` ではない。2 段機の第 2 段飛行は `[第 2 段 (1)]`、3 段機の第 3 段飛行は `[第 3 段 (2)]` である。
  - 形状は、正規化した `curStgIdx`（§3.1。0 から段数 − 1 の整数、ペイロード段階を除く）で描く。2 段機は `curStgIdx` が 0 以外なら上段だけ、3 段機は 0・1 以外なら第 3 段だけを描く。正規化の前の段番号で見ると、段数以上は最後の段（前と同じ）、負の数と 1 未満の小数は第 1 段（前は最後の段）、1 以上の小数は切り捨てた段になる（Rev 22、§8.20）。
  - 段の `nozzleX`・`nozzleLength` は、どの段でも、その段自身のノズル（`startX - lNozzleN`、`lNozzleN`）とする。
  - `isExposedNozzle` は、その段が最下段で、`stageIndex > 0` のときに真である。第 1 段のノズルは、`_drawStage1` が常に描く。
  - `hasFins` は `stageIndex === 0` である（`_drawStage1` が描く）。
  - `segments` の最後の要素は必ず段で、これを**現在の段**とする。
- **`fairingConfig`**: 機体の構成にフェアリングがある（`rocket.disableStaging || rocket.fairing?.enabled`）とき `{ startX: fairingX, radius: 表の半径, length: lFairing }`、そうでなければ `null`。分離の前後で変わらない（§3.6 が使う）。
- **`fairing`**: `state.hasFairing` なら `fairingConfig` と同じ値、そうでなければ `null`。
- **`payload`**: フェアリングがなければ `{ cx: fairingX + lFairing × PAYLOAD_OFFSET_RATIO, r: 表の半径, isDeployed: false }`。フェアリングがあれば `null` で、中のペイロードは描かない。
- **`boosterLayout`**: 第 1 段が `segments` にあり、`boosterCount(resolveBoosters(rocket)) > 0` のとき、§3.3 の配置。分離の後も持つ（§3.6 が使う）。
- **`boostersAttached`**: `boosterLayout` があり、`isBoosterSeparated`（`rocket` またはテレメトリ）でないとき真。
- **`plume`**: 次のとおりで、どれも現在の `_drawHighDetail` と同じ値である。
  - `x`: 現在の段の `nozzleX`。
  - `scale`: 第 1 段は `MAIN_PLUME_SCALE`、2 段機と 3 段機の第 2 段は `UPPER_PLUME_SCALE`、3 段機の第 3 段は `STAGE3_PLUME_SCALE ?? 0.5`。
  - `fuelType`: `(rocket.stages && rocket.stages[curStgIdx]?.fuelType) || rocket.fuelType || 'liquid'`。
  - `isFiring`: `isEngineFiring(rocket)`。

### 3.3 描画（`_drawHighDetail`、`_drawBoosters`）

`_drawHighDetail(ctx, rocket, R, zoomScale, theme, ambientPresRatio = 1.0, geometry = this._computeStackGeometry(rocket, R))` は、形状を受け取って描く。

**ペイロード単体**

1. 展開状態の `_drawPayloadSatellite(ctx, 0, 0, payload.r, true)` を描く。
2. `plume.isFiring` なら、`_drawPlume(ctx, plume.x, 0, plume.scale, rocket.thrustRatio || 1.0, plume.fuelType, R, ambientPresRatio)` を描く。

**スタック**

1. 機首: `fairing` があれば `_drawFairing` を、なければ `_drawPayloadSatellite(ctx, payload.cx, 0, payload.r, false)` を描く。
2. 胴体: `segments` を順に描く。
   - `stageIndex === 0` の段: `_drawStage1(ctx, startX, radius, length, nozzleX, nozzleLength, theme)` と、その直後に `_drawBoosters(...)`。
   - それ以外の段: `_drawStage2(ctx, startX, radius, length, isExposedNozzle, nozzleX, nozzleLength, theme)`。
   - 段間: `_drawInterstage`。
3. 噴射炎: `plume.isFiring` なら、`_drawPlume(ctx, plume.x, 0, plume.scale, throttle, plume.fuelType, R, ambientPresRatio)` を描く。

描く順と、Canvas に渡る座標は現在と同じである。現在の `_drawStage2` は、露出しないノズルの引数として、2 段機では `nozzle2X, lNozzle2`、3 段機では `0, 0` を受け取るが、露出しないときは読まない。そのため、引数がその段自身のノズルに揃っても、Canvas の命令は変わらない。

**SRB の配置**

`_computeBoosterLayout(rocket, stg1X, r1, l1, R)` を新設する。`_drawBoosters` の配置の計算（現在の L902-935）をそのまま移したもので、次の値を返す。

- `count`: `boosterCount(resolveBoosters(rocket))`
- `rB`・`lB`・`yOffset`・`xBase`・`lNozzleB`・`lNoseB`・`yPositions`
- 色・`plumeFuel`・`plumeScale`

値と、既定値の `||` は現在と同じである。`count` が 0 のとき（設定が `null` の場合を含む）は、ほかの値を読まずに `null` を返す。

- `_drawBoosters(ctx, rocket, stg1X, r1, l1, nozzle1X, lNozzle1, theme, isFiring, throttle, R, ambientPresRatio)` の引数は変えない。
  - 分離済みのとき、または `_computeBoosterLayout` が `null` を返したとき（本数 0。設定がない `{}` の物体を含む）は、何も描かずに戻る（現在と同じ）。
  - それ以外は `_computeBoosterLayout` の値で描く。
  - 引数を変えないのは、これを直接呼ぶ既存のテスト（unit 04・回帰 16・回帰 17）を変えずに済ませるためである。
- 形状の `boosterLayout` も、同じ `_computeBoosterLayout` で求める。

**`draw()`**: 形状を 1 回だけ計算し、`_drawHighDetail` と §3.4 の両方に渡す。

### 3.4 演出の位置 `RocketRenderer._layoutFromGeometry(geometry, R, visualCfg)`

戻り値は、演出の位置だけとする。`_computeVisualLayout(rocket, R, visualCfg = ROCKET_VISUAL)` は、`_layoutFromGeometry(_computeStackGeometry(rocket, R, visualCfg), R, visualCfg)` である。

```js
{
	screenRadius,        // R（LOD の判定）
	noseShoulder,        // { x, halfWidth } 主コーンの頂点
	interstageShoulder,  // { x, halfWidth } | null 副コーンの頂点
	rcs                  // { cw: [ノズル], ccw: [ノズル], ullage: [ノズル], plumeLen } | null（§3.6）
}
// ノズル: { x, y, ux, uy }（起点と噴射の単位ベクトル）
```

現在の `xMin`・`xMax`・`halfWidth` は削除する。修正後は、本番のコードで誰も読まないためである（開発プロセス §3.2。前の設計書 §4.9 の `totalLength` と同じ扱い）。外形の確認は、形状と描画の一致の確認（§5.1-3）に置き換える。

**`noseShoulder`**

- フェアリングがあれば、`{ x: fairing.startX, halfWidth: fairing.radius }`。フェアリングの曲線は基部で最も太く、そこで胴体とつながる。
- フェアリングがなければ、露出したペイロードの前面 `{ x: payload.cx + busW/2, halfWidth: busH/2 }`。箱型の衛星は、前面の角で流れが曲がる。
- ペイロード単体では、`{ x: +busW/2, halfWidth: busH/2 }`。
- ここで `busW = payload.r × SATELLITE_BUS_W_RATIO`、`busH = payload.r × SATELLITE_BUS_H_RATIO` である。

**`interstageShoulder`**

- `segments` のうち、最も機首側の段間の前端である。`x` は、その段間の直前（機首側）にある段の `startX`、`halfWidth` は段間の半径とする。
- 段間がなければ `null`。
- 段間の前端では、細い上段から太い段間へ直径が段差で広がり、段差の外側の角で流れが曲がる。
- `x` を段間の `startX + length` ではなく上の段の `startX` とするのは、描いた境界の座標そのものを使うためである。2 段機では、`interX + lInter` が丸めで `stg2X` と最下位ビットだけ異なりうる。

**全構成の値**（`R = 1`）

- フェアリングの有無は、現在の状態（`fairing`）である。
- `rcs` の列は、スタックでは横向きの前方・後方ノズルの x と壁の位置、ペイロード単体では四隅の位置である（詳細は §3.6）。
- フェアリングを構成に持つ機体では、分離の後も同じ `rcs` になる（§3.6）。

| 構成 | `noseShoulder` | `interstageShoulder` | RCS の胴体 | `rcs`（前方・後方・壁） |
|---|---|---|---|---|
| 1 段・フェアリングあり／分離後 | (1.300, 0.700)／(2.175, 0.595) | `null` | -1.500〜1.300 | 0.967・-0.488・0.700 |
| 2 段・第 1 段飛行・フェアリングあり／分離後 | (1.600, 0.650)／(2.440, 0.5525) | (0.400, 0.700) | -2.750〜0.050 | -0.283・-1.738・0.700 |
| 2 段・第 1 段飛行・SRB 2 本（H3-22） | 同上 | (0.400, 0.700) | 同上 | 0.012・-0.152・0.700 |
| 2 段・第 1 段飛行・SRB 4 本（H3-24） | 同上 | (0.400, 0.700) | 同上 | 0.018・-0.124・0.700 |
| 2 段・第 2 段飛行・フェアリングあり／分離後 | (0.600, 0.650)／(1.440, 0.5525) | `null` | -0.600〜0.600 | 0.408・-0.432・0.650 |
| 3 段・第 1 段飛行・フェアリングあり／分離後 | (2.400, 0.650)／(3.170, 0.4675) | (1.500, 0.650) | -3.100〜-0.300 | -0.633・-2.088・0.700 |
| 3 段・第 2 段飛行・フェアリングあり／分離後 | (0.750, 0.650)／(1.520, 0.4675) | (-0.150, 0.650) | -1.600〜-0.400 | -0.592・-1.432・0.650 |
| 3 段・第 3 段飛行・フェアリングあり／分離後 | (0.000, 0.650)／(0.770, 0.4675) | `null` | -0.900〜0.000 | -0.174・-0.779・0.550 |
| 3 段・第 3 段飛行・フェアリングを構成に持たない | (0.770, 0.4675) | `null` | 同上 | -0.144・-0.774・0.550 |
| ペイロード単体・1 段機 | (0.490, 0.595) | `null` | 本体 ±0.490、±0.595 | 四隅 (±0.490, ±0.595) |
| ペイロード単体・2 段機 | (0.455, 0.5525) | `null` | 本体 ±0.455、±0.5525 | 四隅 (±0.455, ±0.5525) |
| ペイロード単体・3 段機 | (0.385, 0.4675) | `null` | 本体 ±0.385、±0.4675 | 四隅 (±0.385, ±0.4675) |

### 3.5 ベイパーコーン `drawVaporCone(ctx, rocket, layout, visualCfg)`

**描く条件**は現在と同じで、次のすべてを満たすときに描く。

- `rocket`・`layout`・`VAPOR_CONE` がある。
- `layout.screenRadius` が LOD のしきい値（既定 10）以上である。
- `computeVaporConeParams` が `active` で、強度が 0.01 を超える。

**コーン**

- 主コーン: 頂点 `layout.noseShoulder`、倍率 1.0。`noseShoulder` がなければ、何も描かない。
- 副コーン: `layout.interstageShoulder` があり、強度が `SECONDARY_INTENSITY_MIN` 以上のとき、頂点 `interstageShoulder`、倍率 0.78。
- 描く順は、主、副の順（現在と同じ）。

**寸法**: 頂点 `{ x, halfWidth: h }` と倍率 `s` から決める。現在の式の `layout.halfWidth` を `h` に、頂点を `x` に置き換え、それ以外は同じである。

- `coneLen = h × CONE_LENGTH_RATIO × (0.75 + 0.5 × intensity) × s`
- `coneHalfW = min(h × MAX_WIDTH_MULTIPLIER, h × (1.1 + 1.35 × intensity × sin(machAngleRad))) × s`
- `xBack = x - coneLen`、`noseRimX = x - h × 0.25 × s`
- 放射グラデーション: `(x, 0, h × 0.15 × s)` → `(xBack + coneLen × 0.35, 0, max(coneLen, coneHalfW))`
- 縁の線幅: `max(1, h × 0.12)`

割合 `PRIMARY_STATION_FRACTION`・`SECONDARY_STATION_FRACTION` と、それに使っていた `L = max(1, xMax - xMin)` は削除する（§3.9）。

### 3.6 RCS（`_layoutFromGeometry` の `rcs`、`drawColdGasRcs`）

ノズルは `_layoutFromGeometry` が形状から求め、`layout.rcs` に入れる。`drawColdGasRcs` は、次の 3 つを満たすときに描く。

- LOD の条件（現在と同じ）を満たす。
- `layout.rcs` がある。
- 立っているフラグがある。

描くのは、立っているフラグの各ノズルで、`_drawRcsPlume(ctx, x, y, ux, uy, layout.rcs.plumeLen, cfg)` を呼ぶ。

**描く順**: 現在と同じく、`draw()` は `_drawHighDetail`（機体と噴射炎）、`drawVaporCone`、`drawColdGasRcs` の順に描く。噴射は、機体・噴射炎・ベイパーコーンの上に描かれ、常に見える（R4）。

- 横向きの噴射は、下の規則で部品に掛からない位置から出る。
- 部品と重なりうるのは、次の 2 つだけである（利用者の了承で許容、R4）。
  - アレージの噴射は、胴体に沿って後ろへ伸びる。第 1 段（惰行の後の再点火）では、フィン・SRB の上に重なる。開きの角 0.28 rad は広がりの半角 0.34 rad より小さいため、内側の縁は胴体の上にも重なる（現在と同じ）。
  - 衛星の前方の噴射と、前面のアンテナの線（§3.6.2）。

#### 3.6.1 スタック: 現在の段の壁から横向き

**胴体と壁**: 胴体は、現在の段（`segments` の最後の段）の `[startX, startX + length]` である。壁の位置は `h = radius` とする。

**噴射の長さ**: `plumeLen = max(MIN_PLUME_PX, h × PLUME_LEN_WIDTH_RATIO)`。

**掛かる部品**: 壁より外に張り出す部品と、その x の区間・張り出しの量 `e` は次のとおりである。部品は、その時点で付いているかではなく、機体の構成で決める。そのため、フェアリング・SRB の分離でノズルの位置は変わらない（R4）。

| 部品 | 条件 | x の区間 | 張り出し `e` |
|---|---|---|---|
| フィン | 段の `hasFins` | `[startX, startX + length × FIN_BASE_RATIO]`（後退したフィンの全長） | `radius × FIN_SPAN_RATIO` |
| SRB | 段が第 1 段で、形状の `boosterLayout` がある（分離の後も） | `[xBase - lNozzleB, xBase + lB + lNoseB]` | SRB の最も外側の縁から壁までの距離 `max(\|yPositions\|) + rB - h`（`yPositions` と `rB` は `_computeBoosterLayout` の値。2 本では `yOffset + rB - h`、4 本では `yOffset + pairGap + rB - h` に当たる） |
| 胴体より太い隣の部分 | 現在の段の直前（機首側）の要素の半径、またはその段が最上段で `fairingConfig` があるときはその半径が、`h` を超える | 隣の部分の x の区間（フェアリングなら `fairingConfig` の `[startX, startX + length]`） | 隣の部分の半径 `- h` |

**空きの区間**: 各部品の区間を、両側へ余白 `m = min(e, plumeLen) × tan(PLUME_SPREAD_RAD)` だけ広げる。噴射の三角形は、壁から距離 `d` の所で x の幅が `± d × tan(PLUME_SPREAD_RAD)` に広がる。部品は壁から `e` までしか張り出さないため、この余白があれば三角形は部品に掛からない。胴体の区間から広げた区間を除いた、長さが正の区間を、空きの区間とする。

**ノズル**: 空きの区間がなければ `rcs = null`（取り付ける壁がない）。あれば次のとおりである。

- 前方 `xFwd = Ff.min + |Ff| × FWD_STATION_FRACTION`（0.84）。`Ff` は、最も機首側の空きの区間である。
- 後方 `xAft = Fa.min + |Fa| × AFT_STATION_FRACTION`（0.14）。`Fa` は、最も機尾側の空きの区間である。
- 噴射の向きの表は、2026-11-20 §3.2-3 と同じである。

| フラグ | ノズル 1 | ノズル 2 |
|---|---|---|
| `cw` | `(xFwd, -h)`、向き `(0, -1)` | `(xAft, +h)`、向き `(0, +1)` |
| `ccw` | `(xFwd, +h)`、向き `(0, +1)` | `(xAft, -h)`、向き `(0, -1)` |
| `ullage` | `(xAft, +h)`、向き `(-cos c, +sin c)` | `(xAft, -h)`、向き `(-cos c, -sin c)` |

`c` は `ULLAGE_CANT_RAD` である。

**前後の順序**

- 空きの区間が 1 つなら、0.14 < 0.84 のため、前方ノズルが後方ノズルより `0.70 |F|` 前に来る。
- 2 つ以上なら、前方ノズルは機首側の区間に、後方ノズルは機尾側の区間にある。
- どちらの場合も、CW・CCW の偶力の向きは表のとおりに保たれる。
- 前の設計の `L` の下限（`max(1, …)`）は削除する。下限は、長さ 0 以下の退化した配置で前後の順序を保つためのものだったが、空きの区間は長さが正のものだけで、順序は上のとおり常に保たれる。
- 出荷する設定で最も短い空きの区間は、LOD のしきい値 `R = 4` での H3-24 の第 1 段（`0.202 × 4 = 0.81` px）である。前後の位置は、最下位ビットよりはるかに大きい差（`0.70 × 0.81` px）で分かれる。

**アレージ**: 噴射は後方ノズルから機尾側へ 0.28 rad 開いて出るため、胴体に沿って後ろへ伸びる。第 1 段（惰行の後の再点火。1 段機のほか、2 段機・3 段機でも第 1 段に推力 0 の行を入れたとき）では、フィン・SRB の上に重なる（利用者の了承で許容、R4）。

#### 3.6.2 ペイロード単体: 本体の四隅から前後

本体の上下には展開した太陽電池パネルが、前面にはアンテナが張り出す。そのため、横向きの噴射は、どこに置いてもパネルに掛かる（G1-2-01）。実機の衛星と同じく、スラスタを本体の四隅に置き、機軸の方向に噴射する。

- 本体の半幅を `a = busW/2`、半高を `b = busH/2` とする。
- `plumeLen = max(MIN_PLUME_PX, b × PLUME_LEN_WIDTH_RATIO)` とする。

| フラグ | ノズル 1 | ノズル 2 |
|---|---|---|
| `cw` | `(-a, -b)`、向き `(-1, 0)` | `(+a, +b)`、向き `(+1, 0)` |
| `ccw` | `(-a, +b)`、向き `(-1, 0)` | `(+a, -b)`、向き `(+1, 0)` |
| `ullage` | `(-a, +b)`、向き `(-cos c, +sin c)` | `(-a, -b)`、向き `(-cos c, -sin c)` |

**偶力の向き**: 画面座標（`+y` が下）では、トルクは `r × F = rx Fy - ry Fx` で、CW（`+Δθ`）が正である。

- `cw` のノズル 1 は、`(-a, -b)` で `-x` に噴射し、力は `+x` である。トルクは `-(-b)(+F) = +bF` で正。
- `cw` のノズル 2 は、`(+a, +b)` で `+x` に噴射し、力は `-x` である。トルクは `-(+b)(-F) = +bF` で正。
- `ccw` は、どちらも負である。
- `ullage` の 2 本は、上下対称で、トルクは打ち消し合う。合力は `+x` で、推進剤を後ろへ寄せる。

**掛からないことの確認**

- 前後に噴く三角形は、本体の前面より前、または後面より後ろにだけある。パネルは `|x| ≤ panelW/2 < a` の範囲にしかないため、掛からない。
- 前面のアンテナ（中心 `busW × SATELLITE_DISH_OFFSET_RATIO`、半径 `busH × SATELLITE_DISH_R_RATIO`）の円弧の中心線は、前方の噴射の内側の縁 `y = ±(b - d × tan(PLUME_SPREAD_RAD))` より内側にある。円弧の中心線から縁までの最短距離の最小は、1・2・3 段機で 0.095・0.089・0.075 R である。線の半幅 0.6 px がこの距離を超えるのは、`R` が 6.3・6.8・8.0 px 未満（6.288・6.772・8.003 px）のときで、霧の三角形が線に最大約 0.30 px 重なる。1 画素未満のため、利用者の了承で許容する（R4）。

### 3.7 排煙・火花の放出位置（`Rocket.updateHistory`、`RocketRenderer.nominalPlumeLength`）

**噴射炎の長さの式を 1 箇所にする**

`RocketRenderer.PLUME_VACUUM_STRETCH = { hydro: 0.15, solid: 0.12, ion: 0, liquid: 0.15 }` を設ける。未知の燃料は `liquid` と同じとし、`_drawPlume` の `default` と揃える。

- `_drawPlume` の `hydro`・`solid`・`liquid`（`default`）の分岐は、現在の定数の代わりに、この表の値を読む。
- 式の形（`R × lenMult × scale × throttle × (1 + flicker) × (1 + e_vac × k)`）と演算の順は変えないため、Canvas の命令は変わらない（§5.4 で燃料と気圧の全組み合わせを確かめる）。
- `ion` の分岐は、現在のまま真空の項を持たない。

公称の長さの関数を加える。

```js
static nominalPlumeLength(R, scale, throttle, fuelType, ambientPresRatio = 1.0) {
	const cfg = ROCKET_VISUAL.PLUMES[fuelType] || ROCKET_VISUAL.PLUMES.liquid;
	const p = Math.max(0, Math.min(1.0, ambientPresRatio));
	const k = this.PLUME_VACUUM_STRETCH[fuelType] ?? this.PLUME_VACUUM_STRETCH.liquid;
	return R * cfg.lenMult * scale * throttle * (1.0 + (1.0 - p) * k);
}
```

**機体の尺度を 1 箇所にする**

`Rocket._visualBaseRadiusM()` を設け、`this.baseRadiusM || defaultRocketRadius` を返す。`defaultRocketRadius` は、現在の `_getDrawRadius` と同じ式（`this.param?.RADIUS || presetManager の Rocket の RADIUS || 63`）である。`_getDrawRadius` と `updateHistory` の両方が、これを使う。`updateHistory` の `bottomOffsetM / mult` による代わりの値と、`NOZZLE_BOTTOM_OFFSET` の参照は削除する。

**放出位置**（`updateHistory` の現在の L447-498 を置き換える）

1. `geometry = RocketRenderer._computeStackGeometry(this, 1)` で、`R = 1` の形状（`R` 単位）を求める。
2. `scaleM = this._visualBaseRadiusM()` とする。
3. ノズルまでの距離は `nozzleDistM = -geometry.plume.x × scaleM` とする。
4. 炎の長さは、`geometry.plume.isFiring` なら `RocketRenderer.nominalPlumeLength(scaleM, geometry.plume.scale, this.thrustRatio || 1.0, geometry.plume.fuelType, RocketRenderer._resolveAmbientPresRatio(this))`、そうでなければ 0 とする。
5. 先端までの距離 `nozzleDistM + flameLenM` から点を作る。座標の変換・基準天体・モードは、現在と同じである。

段数の既定値は、`resolveStackState` の `|| 1` になる（現在は `|| 2`）。

**一致の範囲**

- 放出位置は、高詳細の形状を物理の尺度（`scaleM` メートル = `R`）で置いた位置である。描いた高詳細の噴射炎の起点・公称の先端と一致するのは、描画の半径 `_getDrawRadius` が物理の半径に等しいときである。
- 縮小して最小半径（`MIN_SCREEN_RADIUS` 3.5 px）が効くときは、描画が見やすさのために拡大される。排煙・火花は世界の座標に残る点のため、物理の位置のままとする。
- 低詳細（`R` < 4）では、機体を楕円で略記し、噴射炎もそれに合わせて描く。排煙は高詳細の形状の位置のままとする（現在も同じ）。

### 3.8 射点（`scripts/gravsim_pad_effect.js`）

1. **機体の外形の問い合わせ**: `RocketRenderer.bodyRadiusAt(geometry, x)` を設ける。x を覆う描画部品の半径の最大（側面図の外形）を返し、覆う部品がなければ `null` を返す。部品は次のとおりである。
   - `segments` の要素（`startX ≤ x ≤ startX + length`）: `radius`。
   - 付いているフェアリング（`fairing` の `[startX, startX + length]`）: `_drawFairing` の曲線の半径。曲線は二次ベジェで、始点 `(startX, radius)`、制御点 `(startX + length × FAIRING_CURVE_X_RATIO, radius × FAIRING_CURVE_Y_RATIO)`、終点 `(startX + length, 0)` である（上下対称）。`x` から媒介変数 `t` を二次方程式 `qa t² + qb t + qc = 0` で解き、`y(t)` を返す。根は、桁落ちしない形 `q / qa` と `qc / q`（`q = -(qb + sign(qb) √(qb² - 4 qa qc)) / 2`）で求める。この形は、制御点が中央のとき（`FAIRING_CURVE_X_RATIO` 0.5、`qa` = 0 で一次式）と、その近く、`x = startX` の近くでも誤差が最下位ビット程度で、しきい値で一次式に切り替える分岐はいらない（独立監査3 Iteration 2 の注意 3）。
   - 収納状態のペイロード（`payload` が `isDeployed: false`、`[cx - busW/2, cx + busW/2]`）: `busH/2`。
   - 最大を取るため、境界や重なり（段とフェアリングの境界、段の上端に重なる収納状態のペイロード）でも値は一意である。
   - 隣り合う段・段間は、機首側の要素の `startX` まで続くものとして扱う（区間の終わりを `max(startX + length, 機首側の要素の startX)` とする）。2 段機の第 1 段は第 2 段から下へ組み立てるため、第 1 段の前端（`stg1X + l1`）と段間の後端（`interX`）の間に、丸めで最下位ビットほどの隙間ができる（`R = 1` で 0.04999999999999982 と 0.050000000000000044）。この隙間を外形の穴（`null`）にしないためである。
   - `minBodyRadiusOver(geometry, x0, x1)` は、`x0 > x1` のとき両端を入れ替えて求める。
2. **接続点とアームの先端**
   - `PadEffectRenderer` に `_padAnchors(context)` を設け、接続点とアームの長さを返す。`update`（ケーブル）と `drawBackground`（アーム）の両方がこれを使う。
     - ロケットが射点に保持されている間（`rocket.isHoldDown`）は、`geometry = RocketRenderer._computeStackGeometry(rocket, 1)` から求め、値を覚える。保持の間は全段が付いている。
     - 保持が解けた後は、覚えた値を使い続ける。射点の演出は高度 3 km まで続き、その間に段やフェアリングを分離しても、離れていくアームとケーブルの形は変わらない。
     - まだ値を覚えていないとき（`start()` の後、保持中のロケットを一度も見ていない）は、設定値（`CABLE_CONN_Y_MULT`、`UMBILICAL_ARM_LEN_MULT`）を使う。ロケットのない文脈でも、覚えた値があればそれを使う。
     - 演出を始めるとき（`start()`）に、覚えた値を消す。
   - 接続点は `(CABLE_CONN_X_MULT, sign(CABLE_CONN_Y_MULT) × bodyRadiusAt(geometry, CABLE_CONN_X_MULT))` とする。
   - アームの長さは `|UMBILICAL_OFFSET_Y| - min(外形)` とする。外形の最小は、アームの端面の x の範囲 `[UMBILICAL_TOP_X_MULT - armThick, UMBILICAL_TOP_X_MULT]`（`armThick = UMBILICAL_H_MULT × UMBILICAL_ARM_THICK_MULT` = 0.325。範囲は 1.275〜1.600）でとる。
     - 外形は段ごとに一定か、フェアリングの曲線で機首へ向かって細くなる。そのため、最小は範囲の両端と、範囲の中の部品の境界の値の最小である。
     - アームは、ロケットより先に描かれる（`VisualEffectManager` の `onDrawBefore`）。端面は最も細い所で胴体に接し、それ以外の所では胴体の下に隠れるため、隙間は見えない。
     - 6 構成とも、最小は x = 1.6 の値で、下の表のとおりである。
     - 範囲の中に外形が `null` の所があれば、設定値を使う。
   - 求めるときに外形が `null` の値は、設定値（`CABLE_CONN_Y_MULT`、`UMBILICAL_ARM_LEN_MULT`）を使う。値を覚えていない間（上記）も設定値を使う。
   - `UmbilicalCable` の初期化（L28-29）、保持中の固定（L91-92）、`getAttachPos`（L61）、アームの描画（L685）は、渡された値を使う。

   | 構成 | 接続点の y（x = 0.8） | アームの長さ（x = 1.6 の外形） |
   |---|---|---|
   | 1 段機・フェアリングあり | -0.700（第 1 段） | 0.753（フェアリングの曲線 0.647） |
   | 1 段機・フェアリングなし | -0.700（第 1 段） | 0.805（収納状態のペイロード 0.595） |
   | 2 段機・フェアリングあり | -0.650（第 2 段） | 0.750（第 2 段とフェアリング 0.650） |
   | 2 段機・フェアリングなし | -0.650（第 2 段） | 0.750（第 2 段 0.650。ペイロードは 0.5525） |
   | 3 段機・フェアリングあり | -0.650（第 2 段） | 0.850（第 3 段 0.550） |
   | 3 段機・フェアリングなし | -0.650（第 2 段） | 0.850（第 3 段 0.550） |

3. **パッドの尺度**: 描画の半径を求める `_visualScreenRadius(context, zoomScale)` を設ける。ロケットがあるときは `rocket._getDrawRadius(zoomScale)`、ないときは現在の式 `max(MIN_VISUAL_RADIUS_PX, 物理の画面半径)` である。次の 3 箇所がこれを使う。
   - 構造物の描画（L607）。
   - 粒子の位置と速度の倍率 `_getVisualMultiplier`（`_visualScreenRadius / 物理の画面半径`）。
   - 粒子の大きさ `_drawParticles`（L751）。

### 3.9 設定スキーマ

`presets/visuals/rocket.json` と `_seedFallbacks()` の既定値の両方を変える。

`VAPOR_CONE` から、`PRIMARY_STATION_FRACTION` と `SECONDARY_STATION_FRACTION` を削除する（開発プロセス §3.2）。読み手は、レンダラー（L275・L278）と unit 08-1 の `D_VAPOR` だけである。

```json
"VAPOR_CONE": {
	"SECONDARY_INTENSITY_MIN": 0.55,
	"CONE_LENGTH_RATIO": 2.2,
	"MAX_WIDTH_MULTIPLIER": 2.8,
	"CORE_COLOR": "rgba(240, 248, 255, 0.70)",
	"EDGE_COLOR": "rgba(185, 215, 255, 0.0)",
	"RIM_COLOR": "rgba(255, 255, 255, 0.55)"
}
```

`COLD_GAS_RCS` は、キーも値も変えない。`FWD_STATION_FRACTION`・`AFT_STATION_FRACTION` の意味が、「機体全体」から「最も機首側・最も機尾側の空きの区間」に対する割合に変わる。ペイロード単体では使わない。

`PAD_EFFECT` の `CABLE_CONN_Y_MULT` と `UMBILICAL_ARM_LEN_MULT` は、ロケットがないときの代わりの値として残す。

### 3.10 変えないもの

- **物理・予測・保存**
  - Worker と推進剤の見積もりで変えるのは、SRB の本数の式と、`CalcRocket` の届かない代わりの値の削除、Worker の復元の段番号の正規化（§3.1）、設定の写しのキャッシュ（§3.11）だけである。出荷するプリセットと正しい保存ファイルでは同じ値を返す（R9）。
  - 射点の位置（`getBottomOffsetM`）と `NOZZLE_BOTTOM_OFFSET` は変えない。
- **描画**: 機体の命令列は、R9 の 5 種類の入力でだけ変わる（§5.4）。`draw()` の描く順は変えない。
- **既存の演出**
  - ベイパーコーンの強度と形。
  - RCS の噴射の形と、スタックの横向きの噴射の方向の表。
  - 排煙・火花の記録の条件と、描き方。
  - 射点の構造物の形（アームの長さだけが構成に合う）。

### 3.11 設定の写しのキャッシュ（`scripts/gravsim_preset_manager.js`）

1. **元の表の変更を数える**: `PresetManager` のプリセットの表（`vehicles`・`payloads`・`missions`・`celestials`・`celestialKeyMap`・`fuels`・`themes`・`visuals`）を、`Map` の派生クラス `VersionedMap` にする。`set`・`delete`・`clear` のたびに、`PresetManager` の版番号 `_derivedVersion` を 1 上げる（コンストラクタで渡す関数を呼ぶ）。`Map` としての振る舞い（`get`・`has`・`entries`・`values`・`size` など）は変わらない。すべての表を対象にするのは、旧形式のプリセットが `vehicles`・`payloads`・`missions`・`fuels`（`calculateMissionFlightPlan` の `getFuel`）から組み立てられ、依存する表を個別に追うより漏れがないためである。表が変わるのは、構築（`_seedFallbacks`・ディスクからの読込）と `init()` の読込のときだけで、変わるたびにすべてのキャッシュを捨てても負荷は問題にならない。
2. **派生の写しをキャッシュする**: 次の 5 つの関数は、版番号が同じ間は、前に作ったものをそのまま返す。版番号が変わっていれば、現在と同じ式で組み立て直し、深く凍結して版番号とともに覚える。
   - `getRocketVisual()`（`PLUMES` と `THEMES` を含む全体）
   - `getFuelsMap()`
   - `getPlumesMap()`
   - `getThemesMap()`
   - `getLegacyPresets()`。組み立てた一覧は、元の表の物体を参照することがあるため、凍結の前に `structuredClone` で深く写す（元の表の物体を凍結しない）。`calculateMissionFlightPlan` は SRB の設定を 1 段だけ展開して写す（`{ ...rendering.boosters, ...boosters }`）ため、設定の中の入れ子の値（物体・配列）は元の表と共有される。JSON の写しと違い、`undefined` の項目・`NaN`・`-0` を保つため、返す値は現在の一覧と同じである。`getLegacyPreset(id)` は、キャッシュした一覧にある鍵ならそれを返す。一覧にない鍵は、現在どおり `getVehicle(key.toLowerCase()) || getVehicle(id)` から組み立てる。一覧はすべての機体の id を大文字の鍵で持ち、出荷する機体の id（小文字の ASCII）は大文字と小文字の変換で往復するため、通常この経路に来るのは機体のない鍵で、現在どおり `null` を返す（`getVehicle` は名前では探さない）。大文字・小文字の変換が往復しない id（例: `ß`）の機体は、この経路で見つかり、現在どおり凍結しない組み立てを返す。
   - 読まれない `_legacyPresets` の代入（3 箇所）は削除する（開発プロセス §3.2）。
3. **深く凍結する**: 組み立てた物体と、その中のすべての物体・配列を `Object.freeze` する（再帰）。以前はどの呼び出しも新しい写しを返したため、読み手が写しを書き換えても自分の写しだけが変わった。凍結により、書き換えは例外（モジュールは strict mode）になり、共有した写しが壊れない。`scripts/` に、これらの写しを書き換える箇所はない（作業者の検索。テストは全件の実行で確かめる）。
4. **変えないもの**:
   - `ROCKET_VISUAL`・`ROCKET_FUELS` の Proxy はそのままで、中で呼ぶ関数が速くなるだけである。
   - `getFuel`・`getFuels`・`getPlume` は、現在どおり呼ぶたびに深く写した、凍結しない物体を返す（`getPlume` は `getFuel` の写しの `plume`）。`getTheme` は、現在どおり元の表の物体を返す。どれも毎フレームの経路にはない（旧形式のプリセットの組み立ての `getFuel` は、キャッシュによりなくなる）。
   - `ROCKET_FUELS` は、鍵にない名前のとき `getFuel(prop)`（凍結しない写し）を返す。現在と同じである。
   - 旧形式のプリセットの利用者（`RocketLauncher.loadPreset`・`getBaseRadiusM`・`getBottomOffsetM`、`RocketTab.loadPreset`）は、値を読むか、JSON で写してから使う。凍結した一覧を書き換えない。`getBottomOffsetM` は射点の位置（物理）に入るが、値は現在と同じである（d2・s2 で確かめる）。
   - 元の表の物体をその場で書き換えても版番号は上がらない。`scripts/` とテストに、元の表の物体をその場で書き換える箇所はない（作業者の検索）。書き換えるなら `set` で入れ直す、という約束とする。
   - Worker と主スレッドは、それぞれの `presetManager` で同じ規則に従う。
5. **読むだけのパラメータ `peekObjectParam(name)`**: `getObjectParam(name)` と同じ値を、名前ごとにキャッシュして深く凍結して返す（版番号が変われば作り直す。版番号は `celestials`・`celestialKeyMap` を含む全表）。見つからない名前の `null` も覚える。キャッシュの鍵は、`null` では `'null'`、それ以外では `` `${typeof name}:${String(name)}` `` とする（`String()` が `'null'` になる物体を名前に渡したとき、`null` の結果と取り違えないため）。名前ごとのキャッシュは、512 件を超えたらすべて捨てて作り直す（名前が物体ごとに違う場合に増え続けないため。出荷する物体の名前は物体ごとには変わらない）。`getObjectParam` は、物体の作成など、返した物体を持ち続けたり書き換えたりしうる呼び出し元があるため、現在どおり呼ぶたびに写す。
   - **規則**: 毎フレーム・毎ステップ・定期の更新で、パラメータを読むだけの経路は `peekObjectParam` を使う。物体の作成・操作のとき・予測の要求ごとのように一度だけ読む経路と、返した物体を持ち続ける経路は `getObjectParam` のまま（現在どおり）とする。
   - **物理エンジン**: `PhysicsEngine` に `peekCelestialParam(name)` を設ける。`celestialParams[name]`（Worker の初期化で受け取る表。現在どおり共有の物体）があればそれ、なければ `presetManager.peekObjectParam(name)` を返す。毎ステップの読みはこれを使い、`addObject` の `getCelestialParam` は現在どおりとする（物体に持たせるため）。`PredictorPhysicsEngine` は継承する。
   - **`Rocket._visualBaseRadiusM`**: `this.baseRadiusM` があればそれを返し、なければ `this.param?.RADIUS`、なければ `peekObjectParam('Rocket')?.RADIUS`、なければ 63 を返す。偽の値（0・`NaN`・`''`）の扱いは現在の `||` と同じで、値は現在と同じである。
   - **全箇所の分類**（`scripts/` の `getObjectParam`・`getObjectParams`・`_getObjectParam`・`getCelestialParam` の呼び出し。行は修正前）

     | 箇所 | 経路 | 使い方 | 修正後 |
     |---|---|---|---|
     | `gravsim_object.js` L238 `CelestialBody._drawEffects` | 毎フレーム・天体ごと | 読む | `peekObjectParam` |
     | `gravsim_object.js` L385 `Rocket._visualBaseRadiusM`（本ブランチ） | 毎フレーム（描画・`updateHistory`・射点） | 読む | 上記の順と `peekObjectParam` |
     | `gravsim_flight_computer.js` L389 `_updateTelemetry` | Worker の毎ステップ | 読む | `peekObjectParam` |
     | `gravsim_calc_object.js` L147 `GravSimCalcObject._checkAerodynamicDestruction` | Worker の毎サブステップ（大気中） | 読む | `peekObjectParam` |
     | `gravsim_calc_object.js` L1150 `CalcRocket._determinDynamicParam`、L1185 `CalcRocket._checkAerodynamicDestruction` | 同上（`objParam` がないとき） | 読む | `peekObjectParam` |
     | `gravsim_calc_object.js` L468 `CalcRocket` の構築 | 構築 | 持ち続ける（`this.objParam`） | 現在どおり |
     | `gravsim_calc.js` L38 `getCelestialParam` ← L57 `addObject` | 物体の追加 | 持ち続ける | 現在どおり |
     | `gravsim_calc.js` L215・L230・L525・L686・L716・L744・L865 | Worker の毎ステップ | 読む | `peekCelestialParam` |
     | `gravsim_calc_predictor.js` L289 | 予測 1 回に 1 回 | 読む | 現在どおり |
     | `gravsim_trajectory_predictor.js` L107-108・L206 | 予測の要求ごと | 読む・送る | 現在どおり |
     | `gravsim_rocket_launcher.js` L312 `getBaseRadiusM` の代わりの値 | 毎フレーム（`drawPreview`。プリセットがないとき） | 読む | `peekObjectParam` |
     | `gravsim_rocket_launcher.js` L379 `_calculateTransform` | 毎フレーム（`drawPreview`・`drawTargetMarker`）と射点に出すとき | 読む | `peekObjectParam` |
     | `gravsim_rocket_launcher.js` L409 `drawTargetMarker` | 毎フレーム | 読む | `peekObjectParam` |
     | `gravsim_object_placer.js` L798 `getLaunchObjectName` | 毎フレーム（HUD）と配置のとき | 有無を見る | `peekObjectParam` |
     | `gravsim_object_placer.js` L980 スリングショットの HUD | 毎フレーム | 読む | `peekObjectParam` |
     | `gravsim_object_placer.js` L112・L137・L148・L175・L281・L479・L512・L561・L562・L680 | 配置の操作のとき | 持ち続ける・計算 | 現在どおり |
     | `gravsim_tab_navi.js` L119 `_updateNaviStats` | 定期（Navi タブの表示中） | 読む | `peekObjectParam` |
     | `gravsim_tab_rocket.js` L898 | 統計の更新（操作のとき） | 読む | 現在どおり |
     | `gravsim_tab_deploy.js` L142、`gravsim_universe.js` L124・L243-248 | 配置タブの構築・Worker の初期化・取り次ぎ | 持ち続ける・送る | 現在どおり |

   - 取り次ぎ: 呼ぶ `presetManager` は次のとおりとする。
     - `RocketLauncher._peekObjectParam(name)`: `universe.presetManager`、なければ `this.presetManager`、なければモジュールの `presetManager` の `peekObjectParam`。
     - `ObjectPlacer._peekObjectParam(name)`: `universe.presetManager`、なければモジュールの `presetManager` の `peekObjectParam`（`ObjectPlacer` は `this.presetManager` を持たない）。
     - `NaviTab._updateNaviStats`: `target.param`、なければ `universe.presetManager`（なければモジュールの `presetManager`）の `peekObjectParam`。現在の `universe.getObjectParams`（呼ぶたびに写す）は使わない。
     - `CelestialBody`・`Rocket`・`FlightComputer`・`GravSimCalcObject`・`CalcRocket` は、現在の `getObjectParam` の取り出し方（`globalThis.__presetManager` やモジュールの `presetManager`）のまま、`peekObjectParam` を呼ぶ。
   - `RocketLauncher._getObjectParam` は、L312・L379・L409 を `_peekObjectParam` にすると呼び出し元がなくなるため、削除する（開発プロセス §3.2）。`ObjectPlacer._getObjectParam` は、配置の操作の経路が使い続けるため残す。
6. **期待する効果と計測**: 描画 1 回あたりの組み立て直しが 0 回（版番号が変わらない限り）になり、描画の時間が大きく減る。プレビュー（`drawPreview`）1 回あたりの旧形式のプリセットの組み立て直しも 0 回になる。工程 4 で、修正前と修正後の両方のツリーで、次を計測して記録する。
   - 高詳細の描画 1 回あたりの、`getRocketVisual()` の組み立て直しの回数（呼び出しの回数ではない。組み立てる内部の関数を数える）と、時間。
   - `RocketLauncher.drawPreview` 1 回あたりの、`getLegacyPresets()` の組み立て直しの回数と、時間。`getBaseRadiusM` の `peekObjectParam` の経路も測るときは、`currentPresetId` を一覧にない値にし、第 1 段の `rocketLengthM` を消す。
   - 次の 1 回あたりの、`getCelestial` の深い写しの回数（`param` を持たない天体・ロケットで）。
     - 高詳細の描画、`updateHistory`
     - 射点の演出（保持中）、`drawPreview`、スリングショットの HUD
     - 天体の効果の描画（10 体の世界の 1 フレーム）
     - Worker の物理の 1 更新（名前が表にない投棄物のいる世界）では、写しではなく `getCelestial` の名前の検索の回数を数える（修正前は投棄物 1 個で 11 回、修正後は最初の 1 回の後 0 回）。
   - 時間は機械の負荷でばらつくため、交互に 3 回ずつ測り、範囲で記録する。

---

## 4. 影響範囲

| 対象 | 変更 |
|---|---|
| `scripts/gravsim_utils.js` | `RocketStackUtils` を新設（§3.1） |
| `scripts/gravsim_rocket_renderer.js` | §3.1〜3.8 |
| `scripts/gravsim_object.js` | `Rocket._visualBaseRadiusM`（§3.7・§3.11-5）、`_getDrawRadius`、`updateHistory` の放出位置（§3.7）、`CelestialBody._drawEffects`（§3.11-5）、`Rocket.mass` の段番号（§3.1 の `normalizeStageIndex`） |
| `scripts/gravsim_rocket_launcher.js`、`scripts/gravsim_object_placer.js`、`scripts/gravsim_tab_navi.js`、`scripts/gravsim_flight_computer.js`、`scripts/gravsim_calc.js`、`scripts/gravsim_calc_object.js` | 毎フレーム・毎ステップ・定期のパラメータの読みを `peekObjectParam`・`peekCelestialParam` にする（§3.11-5 の表） |
| `scripts/gravsim_rocket_launcher.js`（追加） | 呼び出し元がなくなる `_getObjectParam` を削除し、`_peekObjectParam` を設ける（§3.11-5） |
| `scripts/gravsim_object_placer.js`（追加） | `_peekObjectParam` を設ける。`_getObjectParam` は配置の操作のために残す（§3.11-5） |
| `scripts/gravsim_pad_effect.js` | 接続点・アームの長さ・粒子の尺度（§3.8） |
| `scripts/gravsim_telemetry_card.js`、`scripts/gravsim_telemetry_panel.js` | `isPayloadPhase` の削除、`resolveStackState(target, tm)`、SRB の表示（§3.1） |
| `scripts/gravsim_object_manager.js` | `loadState` の段番号を `normalizeStageIndex` で正規化し、`totalStages` を段の配列から決める（§3.1。段数は Worker と同じく、段の配列がないか空なら 1。保存ファイルの `totalStages` は読まない） |
| `scripts/gravsim_calc_object.js` | `hasBoosters`・分離の本数・SRB の乾燥質量の既定値（L447・L917）（§3.1。出荷するプリセットでは値は同じ、不正な本数では §3.1 の規則の値になる）、L330 の届かない 3 つの代わりの値の削除（値は同じ）。`restoredRuntimeState` の復元の段番号（§3.1 の `normalizeStageIndex`。正しい保存ファイルでは同じ値） |
| `scripts/gravsim_preset_manager.js` | `hasSrbBoosters`（§3.1。値は同じ）、`_seedFallbacks`（§3.9）、設定の写しのキャッシュと `VersionedMap`（§3.11） |
| 設定の写しを読むテスト（`getRocketVisual`・`getFuelsMap` などを呼ぶ unit 08、integration 06・12、回帰 16・17 ほか） | 返す物体が凍結されるため、写しを書き換えるテストは例外になる。工程 3 で全件を実行し、該当するテストは写しを複製してから書き換える形に直す |
| `presets/visuals/rocket.json` | §3.9 |
| `testsuites/unit/08_rcs_vapor_cone.test.mjs` | 表の下に記載 |
| `testsuites/unit/10_runtime_state_persistence.test.mjs` | L2267-2281 の戻り値のキーの集合を、§3.4 の 4 つ（`screenRadius`・`noseShoulder`・`interstageShoulder`・`rcs`）にする。10-2 の復元の段番号の表に小数を加え、`disableStaging` の機体の復元の試験を加える（§3.1） |
| `testsuites/integration/12_rcs_vapor_pipeline.test.mjs` | 表の下に記載 |
| `testsuites/regressions/12_preexisting_ui_fixes.test.mjs` | L39・L514-515 は `isPayloadPhase` を直接呼ぶ。`RocketStackUtils.resolveStackState` のテストに置き換える。L471-552 の `formatStageInfo` のテストは、別の `tm` を渡す。§3.1 の `resolveStackState(target, tm)` で意味が変わらないため、期待値は変えない（工程 2 で通ることを確かめる）。項目 5 に、`Rocket.mass` の小数・`disableStaging` の段番号と、段番号・段数（`totalStages`）を書き換えた保存ファイル・段番号のない保存ファイル・段のない機体の保存→読込の試験を加える（§3.1） |
| `testsuites/regressions/13_preexisting_followup_fixes.test.mjs` | 変更不要の見込み。L249 の `rec.layout` は、生きているロケットと読み込んだロケットの配置全体の比較（L339-341）にだけ使い、外形のキーを個別に読まない |
| `_drawBoosters` を直接呼ぶテスト（unit 04 L973-976、回帰 16 L529-536、回帰 17 L903-909） | 引数を変えないため、変更不要の見込み（§3.3） |
| `updateHistory` を呼ぶテスト（unit 02・03・06、integration 08・10・11、回帰 18。integration 02 は unit 02 と同じ写しのため削除した。§8.16） | 放出位置を確かめるものは、§3.7 の期待値に合わせる。ペイロード単体・段なしの機体・真空の炎の長さで値が変わる。工程 2 で各テストの期待値を確かめる |
| `NOZZLE_BOTTOM_OFFSET`・`CABLE_CONN` を参照するテスト（unit 02 の L1301-1903。integration 02 は unit 02 と同じ写しのため削除した。§8.16） | `NOZZLE_BOTTOM_OFFSET` は値を変えないため、射点の位置のテストは変わらない。L1902-1903 の接続点のテストは、ロケットを渡さずにケーブルを直接呼ぶため、設定値を使い（§3.8-2）、期待値は変わらない見込み |
| `UmbilicalCable` を直接使うテスト（unit 04 L455・L1589・L1652） | 接続点を渡さない呼び方は、設定値を使う（§3.8-2）ため、変更不要の見込み |
| `_getVisualMultiplier` を直接呼ぶテスト（unit 04 L1627-1630） | ロケットのない文脈（`rPx <= 0` で 1.0）を確かめる。§3.8-3 でロケットがないときの式を変えないため、変更不要の見込み |
| アナンシエーターを確かめるテスト | §3.1 で段数の代わりの値が `target.stages.length` に変わる。工程 2 で検索し、期待値を確かめる |
| `testsuites/system/` | 新設（§5.3）。工程 3 で `testsuites/system/06_vapor_cone_rcs_anchors.test.mjs` とした |
| 工程 3 で新設した試験のファイル | `testsuites/unit/12_stack_rules_smoke_pad.test.mjs`（§5.1-1・2・7・8・9）、`testsuites/unit/13_preset_snapshot_cache.test.mjs`（§5.1-11）、`testsuites/integration/15_stack_geometry_pipeline.test.mjs`（§5.2）。§5.1-3〜6・10 は `testsuites/unit/08_rcs_vapor_cone.test.mjs` に、§5.2 の RCS・ベイパーコーンは `testsuites/integration/12_rcs_vapor_pipeline.test.mjs` にも置いた |
| `testsuites/README.md` | テスト数・カバレッジ |
| `docs/design/2026-11-20_trajectory_fx_flightplan.md` | §3.2-3 と §3.3 の位置の記述、§3.4 の `isPayloadPhase` に、本書で置き換えた旨の注記。§3.5-1 の復元の段番号の式に、`normalizeStageIndex` に置き換えた旨と、読込が `totalStages` を読まない旨（Rev 27）の注記 |
| `docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md` | §3 の C の `_computeVisualLayout` の外形と RCS の位置の試験に、本書で置き換えた旨の注記 |
| `docs/design/2026-11-21_architecture_redesign_inputs.md` | H1-15・H4-25・H2-16・H2-17 を追加・更新（§6） |

`unit/08` の変更

- 08-1 の設計値 `D_VAPOR`: 割合のキーを削除する。
- 08-4: 外形の包絡のテストを、形状と描画の一致・§3.4 の表に置き換える。
- 08-5
  - `designNozzles` を `layout.rcs` 基準にする。
  - 外形を手で作った配置を入力とするテスト（L1366-1392 の `L` の下限など）は、§3.6 の空きの区間の境界値のテストに作り直す。
- 08-6: LOD の境界のテストで、配置を `_computeVisualLayout` から作り直す。
- 08-7
  - コーンの位置と大きさの期待値を変える。
  - 外形を手で作った配置を入力とするテスト（L1578-1583 など）は、`noseShoulder`・`interstageShoulder` を持つ配置に作り直す。

`integration/12` の変更

- `designNozzles` を `layout.rcs` 基準にする。
- `assertConesMatch` と、12-1 の期待値を変える。12-1 の構成で段間がなくなる場合、コーンの数は 2 から 1 になる。
- L657 の `drawn.layout.halfWidth` の比較を、`layout.rcs` の壁（第 2 段の半径）の比較にする。

---

## 5. テスト計画

開発プロセス §3.3 に従い、各項目に正常系・異常系・境界値を含める。工程 3 で決めた試験のファイルは §4 の表のとおりである（unit 08・12・13、integration 12・15、system 06。unit 10 と回帰 12 は新しい規則に合わせた）。

### 5.1 単体

1. **`RocketStackUtils`**（§3.1）
   - 正常系: 各構成の `curStgIdx`・`totalStg`・`isPayloadOnly`・`hasFairing`。
   - 異常系: テレメトリなし、`stages` なし、`disableStaging`。
   - 境界値: `stageIndex = totalStages - 1`（スタック）と `stageIndex = totalStages`（ペイロード単体）。
   - `telemetry` の引数を省いたときと、明示したときの違い。
   - 段番号が `null`・`NaN`・`undefined`（`rocket.currentStageIndex` に落ちる）のとき。
   - `resolveBoosters` が `rocket.boosters` だけを読み、`rendering.boosters`・`stages[0].boosters` を読まない。
   - `boosterCount` の全分岐
     - 正の本数。
     - 本数が 0・未定義・`NaN`・`null` で、燃焼時間の有無。
     - 設定が `null`。
     - 負の本数と文字列。
     - 上限と切り捨て: 9・10・12・`1e9` と、2.5・0.5（燃焼時間の有無）。
     - 有限でない値: 本数 `Infinity`・`-Infinity`（燃焼時間の有無）、燃焼時間 `Infinity`。設定を JSON の写しにしたもの（Worker が受け取る値）と、同じ本数になる。
     - 数でない本数: `"4"`・`[4]`・`" 4 "`。
     - Worker の分離が、上限の本数（9）と切り捨てた本数で、その数の投棄物を作り、質量の和が設定の乾燥質量に一致する。異常に大きい本数でも、分離と描画が止まらない。
   - 物体が `null`・`undefined` のとき、`resolveStackState` は既定の状態（段番号 0、段数 1、スタック、フェアリングなし）を、`resolveBoosters` は `null` を返し、例外を出さない。`_computeStackGeometry` と `draw` は物体を要る（呼び出し元は必ず物体を渡す。`draw` は修正前から `rocket.thrustAngle` を読む）。
   - Worker の `hasBoosters`、`hasSrbBoosters` と同じ真偽になる。
2. **規則の一致**
   - テレメトリと `rocket` の値が食い違う入力（§5.4 の表の最初の 2 行。テレメトリの段番号 2 と `currentStageIndex` 1、`totalStages` なし）で、低詳細・高詳細・HUD のペイロード段階の判定が同じになる。
   - SRB の本数が、低詳細（楕円の幅の倍率）・高詳細（描く本数）・HUD（SRB の表示）で同じになる。
   - `rocket.boosters` に設定を持つ物体で、Worker の分離の本数と同じになる。対象は、本数 0・未定義・`NaN`・`null` で燃焼時間がある設定、負の数・文字列（`"0"`・`"4"`）・数でない値（`[4]`）・上限の直後と上限を超える本数（10・12・`1e9`）・小数（2.5）の本数を含む。
   - `rendering.boosters` か `stages[0].boosters` にだけ設定を持つ物体では、両方の詳細度と HUD が SRB なしになり、Worker（`hasBoosters` が偽）と一致する。
   - アナンシエーター・段の表示・カードが、同じ段番号と段数を使う（テレメトリの段番号が `null`・`NaN` の入力を含む）。
   - `disableStaging` の機体（ペイロードの分離のフラグが立っていても段の表示）と、`stages` のない物体（1 段。段番号ではペイロード段階にならず、フラグではなる）でも、低詳細・高詳細・HUD の判定が同じになる。
   - 現在の段（§3.1）: 段数 1〜3、段番号 −1・0・0.5・1・2・段数・段数 + 1、`disableStaging` の有無と、`stages` のない物体の組み合わせで、次のものが同じ段を使う。両方の詳細度の第 1 段と SRB、形状の第 1 段・現在の段・噴射炎の燃料、HUD の段の表示と SRB の表示、カードの見出しである。アナンシエーターの 1-ENG・MECO・2-ENG・SECO・SEP も、正規化した段番号に従う（負・小数・段数以上の段番号）。
   - 段番号の正規化（§3.1）: `normalizeStageIndex` の値（整数・小数・負・`Infinity`・数でない値・文字列・配列、段数 0、`disableStaging`）。Worker の復元（unit 10-2）と `Rocket.mass` の小数・`disableStaging`。保存ファイルの段番号を書き換えて読み込み、読込が完了し、主スレッド・Worker・描画と HUD の段番号と質量が一致する（回帰 12）。書き換えるのは、2 段機では小数・負・段数を超える値・文字列・真偽値・`null`・`disableStaging` で段数以上、段のない機体（ストレステストの群れのロケット、1 段として数える）では配置の直後の保存ファイルの 0・1・2・5・−1・0.5・`disableStaging` の 1 と、ペイロード分離の後の保存ファイルの 2 である。段のない機体の書き換えでは、最初のフレームの前の主スレッドと Worker の段番号が一致し、Worker が 1 段であることを確かめる（描画・HUD の規則は unit 12-1 の段のない物体の入力が、質量は回帰 12 の `Rocket.mass` の試験が受け持つ）。段のない機体をペイロード段階で保存して読み込み、段番号 1 と分離の状態が保たれることも確かめる。保存ファイルの `totalStages` を書き換えても（2 段機では 5・0・−1・`"7"`・`null`・1・キーなし、段のない機体では 3・4）、主スレッドの段数が Worker と同じ（2 段機 2、段のない機体 1）になり、段番号は保存した値のままである。段番号のない保存ファイル（段番号を消す、段番号を消して段数 7、両方を消す）でも段数は同じで、段番号は `Rocket` の初期値 0 である（Rev 28）。
3. **形状**（§3.2・§3.3）
   - 対象: 次の要素の組み合わせ。
     - 段の構成: 1 段、2 段の第 1・第 2 段、3 段の第 1〜3 段。
     - 範囲外の `curStgIdx`: 2 段機の 2 と 5、3 段機の 3。
     - フェアリングの 3 状態: あり、分離済み、構成になし。
     - ペイロード単体（1〜3 段機）と `disableStaging`。
     - SRB の本数: 0・2・4・3、分離の前後。
   - 記録した描画関数の引数（段・段間・フェアリング・ペイロード・SRB・噴射炎）が、形状と一致する。
   - `segments` の順序・種類・`stageIndex`、最下段だけの `isExposedNozzle`、`hasFins`、`boosterLayout` と `boostersAttached`。
4. **演出の位置**（§3.4）
   - §3.4 の表の全行。
   - `noseShoulder` が、描いたフェアリングの基部、または描いたペイロードの前面に一致する。
   - `interstageShoulder` が、描いた最も機首側の段間の直前の段の `startX` に一致する。
   - 戻り値のキーの集合が 4 つである。
5. **ベイパーコーン**（§3.5）
   - 正常系
     - ピークで、主コーンの頂点が `noseShoulder`、副コーンの頂点が `interstageShoulder` にある。
     - 各コーンの大きさ（長さ・幅・縁・グラデーション・線幅）が、頂点の `h` から決まる。
   - 境界値
     - 強度が 0.55 の直前・一致・直後で、副コーンが出ない・出る・出る。
     - 段間のない構成（1 段、2 段の第 2 段、3 段の第 3 段、ペイロード単体）では、ピークでも主コーンだけ。
     - フェアリング分離の前後で、主コーンの頂点がフェアリング基部からペイロードの前面へ移る。
   - 異常系
     - `noseShoulder` がない配置では、何も描かず、例外も出ない。
     - `interstageShoulder` が `null` なら、副コーンを描かない。
   - 不具合の回帰（2 段・第 1 段飛行・ピーク、`R = 40`）
     - 主コーンの頂点が 1.600 R にある（許容 1e-9 px）。修正前の 1.174 R とは 17 px 違う。
     - 副コーンの頂点が 0.400 R にある（許容 1e-9 px）。
     - 主コーンの雲が機体の外に出る位置が、1.244 R にある（許容 0.01 R）。修正前は 0.829 R である。
6. **RCS**（§3.6）
   - 正常系: §3.4 の表の全行で、CW・CCW・アレージのノズルが `rcs` の位置と向きにある。
   - 偶力の向き: 全構成で、CW の 2 本のトルクの和が正、CCW が負、アレージの和が 0 である。
   - 不具合の回帰
     - 全プリセットの機体（SRB の本数・寸法を含む）と全構成で、横向きの噴射の三角形（霧の半角）が、壁より外に張り出す部品の塗りの多角形に掛からない。部品はフィン・SRB・太い隣の部分・パネルで、Canvas の命令から多角形の交差で確かめる。アンテナの線は交差の対象にしない。線との 1 画素未満の重なりは利用者の了承で許容する（R4）ため、中心線から噴射の縁までの最短距離が §3.6.2 の値であることだけを確かめる。
     - フェアリング・SRB の分離の前後で、ノズルの位置が同じ（全構成）。
     - フェアリングを付けた構成で、どのノズルもフェアリングの範囲に入らない。
     - 3 段・第 3 段飛行でフェアリングがあっても、壁が 0.55 R にある。
   - 境界値
     - 空きの区間が 1 つの場合と 2 つの場合。
     - 部品の区間が胴体の端に一致する場合（長さ 0 の区間を捨てる）。
     - 空きの区間がない設定（SRB が段の全長を覆う設定）では、`rcs = null` で何も描かない。
     - LOD のしきい値の `R` で、最短の空きの区間でも前後が分かれる。
   - 異常系: `layout.rcs` がない配置では、何も描かない。
   - 描く順: `draw()` が、機体（`_drawHighDetail`）、ベイパーコーン、RCS の噴射の順に描く（現在と同じ）。噴射炎を描く状態でも、RCS の噴射が最後に描かれる。
7. **排煙・火花**（§3.7）
   - 次の各状態で、`effectTrail.addPoint` に渡る点が、`R = scaleM` の高詳細の形状の噴射炎の起点（非燃焼）と公称の先端（燃焼）に一致する（許容 1e-9 m）。
     - 段の構成の全状態。
     - ペイロード単体の燃焼と非燃焼（燃料の種類ごと）。
     - 段もテレメトリもない機体。
     - 真空と大気中。
     - `baseRadiusM` が 0 の機体（`_getDrawRadius` と同じ尺度）。
   - `_drawPlume` の長さ（ゆらぎ 0 のとき）と `nominalPlumeLength` が一致する（燃料ごと、気圧比 0・0.5・1）。
   - 記録の条件が変わらない。
8. **射点**（§3.8）
   - §3.8 の表の 6 構成で、接続点が x = 0.8 の外形にある。アームの長さが、端面の範囲（1.275〜1.600）の外形の最小に届き、範囲全体で端面と外形の間に隙間がない（端面の y ≥ 外形の −y）。
   - 範囲の両端: 3 段機を機尾側へずらし、第 3 段の前端（細い第 3 段とフェアリングの境）を範囲の中（1.35）、機尾側の端のすぐ内（1.275 + 1e-6）とすぐ外（1.275 − 1e-6）、範囲の外（1.2）に置く。アームの長さが、第 3 段が範囲に入るときは第 3 段に、入らないときは x = 1.6 のフェアリングの曲線に届く。x = 1.6 の値と違う最小（範囲の中の部品）も確かめる。
   - 値の時点: 保持の間に求めた値を、保持が解けて段・フェアリングを分離した後も使う。`start()` の後は消える。`update` を呼ばずに `drawBackground` を呼ぶと（値をまだ覚えていない、保持でないロケット）、設定値を使う。保持中のロケットなら、その場で求める。
   - `bodyRadiusAt` の値
     - 段・段間・フェアリングの曲線（`_drawFairing` が描くベジェの点と一致）・収納状態のペイロード。
     - 境界と重なり（最大を取る）。
     - 機体の外（`null`）。
   - 異常系: 値を覚えていない間（`start()` の後でロケットのない文脈、保持でないロケット）と、外形が `null` の位置では、設定値を使う。値を覚えた後は、ロケットのない文脈でも覚えた値を使う。
   - 尺度: 物理の半径が 2〜3.5 px の縮尺で、構造物・粒子の位置・粒子の大きさの 3 箇所が、ロケットの描画の半径を使う。ロケットがないときは、現在の式のままである。
9. **定数の固定**: `NOZZLE_BOTTOM_OFFSET` の 3 つの値が、`R = 1` の形状の全段が付いたときのノズル端（`-geometry.plume.x`）と、ビット単位で一致する。
10. **設定**（§3.9）: `rocket.json` と `_seedFallbacks` の `VAPOR_CONE` が、§3.9 のキーと値に一致し、削除した割合のキーを持たない。
11. **設定の写しのキャッシュ**（§3.11）
   - 正常系: 同じ版番号の間、4 つの関数が同じ物体（`===`）を返し、その値が現在の組み立て方（`JSON` の深い写し）と一致する（`assert.deepStrictEqual`）。
   - 版番号: プリセットの 8 つの表（`vehicles`・`payloads`・`missions`・`celestials`・`celestialKeyMap`・`fuels`・`themes`・`visuals`）の `set`・`delete`・`clear` のそれぞれの後で、版番号が上がり、5 つの関数と `peekObjectParam` が新しい物体を返し、値が変更を反映する。`vehicles`・`payloads`・`missions`・`fuels` の変更で、旧形式のプリセットの一覧が作り直される。
   - 凍結: 返した物体・入れ子の物体・配列への代入・削除・`push` が例外になり、元の表と次に返す物体は変わらない。
   - `ROCKET_VISUAL`・`ROCKET_FUELS`・`MULTISTAGE_PRESETS` の Proxy の読み・`in`・`Object.keys` が、現在と同じ結果になる。
   - 性能: 高詳細の描画 1 回あたり `getRocketVisual()` の組み立て直しが 0 回、`drawPreview` 1 回あたり `getLegacyPresets()` の組み立て直しが 0 回である（呼び出しの回数ではなく、組み立て直しの回数を数える）。
   - 旧形式のプリセット: 同じ版番号の間、`getLegacyPresets()` が同じ物体を返し、値が現在の組み立て方と一致し、凍結されている。元の表の物体（`vehicles` の値）は凍結されない。一覧にない鍵（機体のない鍵）の `getLegacyPreset` は、現在どおり `null` を返す。`RocketLauncher.loadPreset`・`RocketTab.loadPreset` が、凍結した一覧から現在と同じ状態を作る。
   - 異常系・境界値: 空の表（`clear` の後）、存在しない鍵の `delete`（版番号は上がる）、同じ値の `set`（版番号は上がる）、`getRocketVisual` の `visuals` に `rocket` がないとき（現在どおり空の物体と `PLUMES`・`THEMES`）、噴射炎を持たない燃料（`getPlumesMap` に入らない）。
   - `init()` の経路: 読込の前に作ったキャッシュは、`init()` が表を書き換えた後に捨てられ、読み込んだ値を返す（`fetch` を差し替えて確かめる）。読込が失敗した場合（`fetch` が例外）も、それまでに書き換えた表の分だけ作り直された値を返す。
   - `peekObjectParam`: `getObjectParam` と同じ値（`deepStrictEqual`）、同じ名前で同じ物体、凍結、`celestials`・`celestialKeyMap` の変更で作り直し、ない名前で `null`（2 回目は探さない）。名前が `null`・`undefined`・`''` のとき、大文字・小文字や前後の空白だけが違う名前のとき、`getObjectParam` と同じ結果になる。`getObjectParam` は現在どおり呼ぶたびに凍結しない新しい写しを返す。
   - `peekCelestialParam`: `celestialParams` にある名前ではその物体、ない名前では `peekObjectParam` の値を返す。`celestialParams` が `null`（予測の物理エンジンは常にこれ）のときも `peekObjectParam` の値を返す。
   - 取り次ぎの順: `RocketLauncher._peekObjectParam`（`universe.presetManager` → `this.presetManager` → モジュール）、`ObjectPlacer._peekObjectParam`（`universe.presetManager` → モジュール）、`NaviTab`（`target.param` → `universe.presetManager` → モジュール）が、前の候補があればそれを使う。
   - `Rocket._visualBaseRadiusM`: `baseRadiusM` があるとき `getCelestial` を呼ばない。`baseRadiusM` がなく `param` だけがあるとき `param.RADIUS`。どちらもないとき `peekObjectParam('Rocket')` の値、それもなければ 63。`baseRadiusM`・`param.RADIUS` が偽の値（0・`NaN`・`''`）のときは、次の候補に進む（現在と同じ）。
   - 読み手: §3.11-5 の表の `peekObjectParam`・`peekCelestialParam` の各箇所で、現在と同じ値を使い、`param` を持たない天体・ロケットでも `getCelestial` の深い写しが 0 回である。標的の印（`drawTargetMarker`）、スリングショットの HUD と `getLaunchObjectName`、天体の効果の描画、Navi タブ、射点の位置、Worker の毎ステップの読みを含む。Worker では、名前が表にない物体の名前の検索が、最初の 1 回の後 0 回になる。
   - 読み手の異常系: 表に記録がないとき、各読み手が現在と同じ代わりの値を使う（標的の印の半径 `|| 1`、スリングショットの HUD の `'1.00e+00 t'`、`getLaunchObjectName` の `'Rocket'`、`getBaseRadiusM` の 63）。`getBaseRadiusM` の `peekObjectParam` の経路は、`currentPresetId` が一覧にない（旧形式のプリセットが `null`）うえに、第 1 段に `rocketLengthM` がないときにだけ通る。
   - 往復しない id の `getLegacyPreset`（§3.11-2）は、機体 id `'ß'` に対して鍵 `'ẞ'` で確かめる（鍵 `'ß'` は大文字にすると一覧の `'SS'` に当たる）。

### 5.2 結合（`integration/12` の更新と追加）

- **RCS**: Worker 側の `CalcRocket` が出した RCS フラグを主スレッドへ同期して描いた噴射が、`layout.rcs` の位置に出る。既存の流れの期待値を更新する。
- **ベイパーコーン**: `CalcRocket` の大気飛行で求めたマッハと気圧比を主スレッドへ同期して描いたコーンが、`noseShoulder`・`interstageShoulder` に出る。
- **排煙**: 自走ペイロードの分離の後の燃焼で、同期した状態から記録した排煙の点が、衛星の後ろの炎の先端に出る。
- **SRB の本数**: 本数 0 で燃焼時間がある設定の `CalcRocket` の分離で作られる SRB の数と、主スレッドの描画・HUD の本数が一致する。
- **保存ファイルの有限でない値**: 本数や燃焼時間に `1e999` を書いた保存ファイルを `ObjectManager.loadState` で読み込み、主スレッドの物体（`Infinity`）の描画・HUD の本数と、Worker に送られた設定（`null`）の `CalcRocket` の SRB の有無・分離の本数が一致する。

### 5.3 システム（ヘッドレス Chrome、`testsuites/system/` に新設）

参考の時刻（独立監査1 Iteration 2 の測定、Falcon 9 の ISS の計画）は次のとおりである。

- マッハ 0.85 は T+55.3 s。
- 強度 0.55 以上の窓は T+57.5〜63.2 s（5.7 s）。
- 第 1 段の分離は T+167.8 s。整定の噴射はその直後、アレージは T+168.3 s から。

50 倍では、遷音速の窓は 114 ms しかない。窓より十分前に一時停止し、止まっている間に時間倍率を変える。

**準備**

1. 実際の UI で Earth を置き、Falcon 9（2 段、フェアリングあり）を選ぶ。
2. Rollout と Quick ignition で打ち上げ、秒読みの終了を待つ。

**遷音速**

1. 50 倍で進める。飛行時間が 40 s 以上になったら一時停止する（窓の 17 s 以上前）。
2. 一時停止のまま、System タブの時間倍率を実時間（1 sec/sec）にする。
3. マッハが 0.9 未満であることを確かめる。そうでなければ、前提の失敗として報告する。
4. 再開し、同期したマッハと気圧比から求めた強度が 0.6 以上になったら、一時停止する。
5. 一時停止した状態で、強度が 0.55 以上であることを確かめる。

**描画の確認**

- **実際の状態を、実際の Canvas に描く**
  - 同期済みの実際のロケットの写しを、ページ内の Canvas（ブラウザの 2D コンテキスト）に `R = 60` px で、`RocketRenderer.draw` を使って描く。
  - 写しは `thrustAngle` を 0 にする。軸を水平にして、列ごとに判定するためである。
  - 写しは `Object.assign(Object.create(Object.getPrototypeOf(r)), r, { thrustAngle: 0 })` で作る。
  - 比較用に、同じ写しのマッハを 0 にしたもの（`{ mach: 0, telemetry: { ...r.telemetry, mach: 0 } }` を加える）も描く。
  - 描く間は、`performance.now` と `Math.random` を固定値に差し替え、噴射炎のゆらぎを止める。
- **画素**: 2 枚で異なる画素のうち、胴体の外（その列の胴体の半径 + 1 px より外）にあるものを雲とする。
  - 雲の最も前の列が、§1.5 の式で求めた「主コーンが機体の外に出る位置」と ±2 px で一致する。強度は、一時停止した状態の値を使う。
  - フェアリング基部 + 1 px より前に、異なる画素がない。
- **位置**: 同じ描画で、次のものを記録する。
  - `_drawFairing`・`_drawInterstage` の引数。
  - `drawVaporCone` の中で Canvas が受けた `moveTo`（コーンの頂点）。

  主の頂点が描いたフェアリングの基部に、副の頂点が描いた段間の前端に一致することを確かめる。

**RCS**

1. 一時停止のまま、時間倍率を 10 倍にして再開する。
2. 飛行時間が 150 s 以上になったら一時停止する。
3. 一時停止のまま実時間にして、再開する。
4. 第 1 段の分離（`stageIndex` が 1）の後、アレージまたは整定の噴射（`rcsUllage || rcsCw || rcsCcw`）が立ったら、一時停止する。立っていなければ、再開して繰り返す（上限 10 回）。
5. 同じ方法（`thrustAngle` 0 の写し）で描き、`_drawRcsPlume` の起点と向きを記録する。
6. 起点が、第 2 段の胴体の `[startX, startX + length]` の中の壁 `±r2` にあり、描いたフェアリングの範囲に入らないことを確かめる。
7. 描いた噴射の役割を、§3.6.1 の表から独立に作った期待値（立ったフラグごとの前方・後方の位置、壁の側、噴射の向き。アレージは `ULLAGE_CANT_RAD` の傾き）と比べる。CW と CCW の取り違えと、前方と後方の取り違えを検出する（独立監査3 Iteration 2 の注意 4）。

最後に、セッション全体で例外・コンソールのエラー・ダイアログがないことを確かめる。

### 5.4 工程 4 の確認

- 機械的チェック（`npm run check`）のエラーが 0 件である。
- 全テスト（単体・結合・回帰・システム）が、skip なしで通る。
- カバレッジが最低 90%（目標 97%）である。

**描画の不変**（R9）

- 方法: 修正前（`main` の `git archive`）と修正後で、レンダラーの Canvas の命令列を比べる。
- 対象: 2,749 通りの入力で、次のものを描く。
  - `_drawHighDetail`（`R` が LOD 以上）、または `_drawLowDetail`（LOD 未満）。
  - すべての入力の `_drawLowDetail`。
- 入力の組み合わせ（2,749 通りの内訳）
  - 主: 2,304 通り。
    - 段数 1〜3、段番号 0〜段数 + 1。
    - フェアリング 4 状態。
    - SRB 0・2・4・3 本。
    - 噴射の有無、`disableStaging` の有無。
    - `R` 3・12・40。
  - 情報源の組み合わせ: 10 通り × `R` 2 通り。
  - 噴射炎: 405 通り。
    - 段数 1〜3、段番号 0〜段数。
    - 燃料 5 種（`liquid`・`solid`・`hydro`・`ion`・未知）。
    - 気圧比 0・0.4・1。
    - `R` 3・12・40。
    - 自走ペイロードの燃料も同じ。
  - SRB の設定: 8 通り × `R` 2 通り。
  - テレメトリの段番号が `null`・`NaN`: 2 通り × `R` 2 通り。
- 噴射炎のゆらぎは、`performance.now` と `Math.random` を、固定値と固定の系列に差し替えて止める。
- 合格の条件: 次の表の入力だけが異なり、残りの 2,533 通りの命令列の md5 が一致する。異なるのは、最初の 13 の入力（`R` 3・40 の 2 通りずつ。`stages[0].boosters` だけと本数 12 の入力は `R` 40 の 1 通り）の 24 通りと、最後の行の 192 通りの、計 216 通りである。

  | 異なってよい入力 | 修正前 | 修正後 |
  |---|---|---|
  | テレメトリが段番号 2（段数 2）、`rocket.currentStageIndex` が 1 | 低詳細はスタック | 低詳細もペイロード単体（高詳細と同じ） |
  | テレメトリなし、`currentStageIndex` 2、`totalStages` なし、`stages` 2 つ | 低詳細はスタック | 低詳細もペイロード単体（高詳細と同じ） |
  | `rocket.boosters.count` 0、`rendering.boosters.count` 2 | 低詳細は SRB 2 本の幅 | SRB なし（高詳細と同じ） |
  | `stages[0].boosters.count` 4 だけ | 高詳細は SRB 4 本、低詳細は SRB なし | 両方の詳細度で SRB なし（物理と同じ。`R` 3 は低詳細だけのため変わらない） |
  | `rendering.boosters.count` 2 だけ | 両方の詳細度で SRB 2 本 | 両方の詳細度で SRB なし（物理と同じ） |
  | `rocket.boosters = { count: 0, burnTimeSec: 100 }` | 両方の詳細度で SRB なし | 両方の詳細度で SRB 2 本（物理と同じ） |
  | `rocket.boosters = { burnTimeSec: 100 }` | 同上 | 同上 |
  | `rocket.boosters = { count: -1, burnTimeSec: 100 }` | 同上 | 両方の詳細度で SRB 2 本（Worker の分離も 2 本） |
  | `rocket.boosters = { count: '0', burnTimeSec: 100 }` | 同上 | 同上 |
  | `rocket.boosters = { count: 12 }` | 高詳細は SRB 12 本 | 高詳細は SRB 9 本（上限。低詳細の幅の倍率は 4 本以上で同じため `R` 3 は変わらない） |
  | `rocket.boosters = { count: 2.5 }` | 高詳細は SRB 3 本、低詳細は幅の倍率なし | 両方の詳細度で SRB 2 本（切り捨て） |
  | テレメトリの段番号 `null`（2 段機） | 両方の詳細度で上段だけ | 段番号 0 として全段（HUD と同じ） |
  | テレメトリの段番号 `NaN`（2 段機） | 同上 | 同上 |
  | 段数 1、段番号 1 と 2、`disableStaging`（主の組み合わせの 192 通り。フェアリング 4 × SRB 4 × 噴射 2 × `R` 3 × 段番号 2） | 低詳細は上段の楕円。噴射ありの高詳細は、噴射炎の燃料が代わりの `liquid` | 低詳細も第 1 段（高詳細と同じ）。噴射ありの高詳細（`R` 12・40 の 64 通り）は、第 1 段の燃料（入力では `solid`）の噴射炎（§3.1 の現在の段。§8.18・§8.19） |

- スクリプト: `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/vapor/draw_invariance.mjs`
- 実行
  - 修正前のツリー（同じディレクトリの `main_tree`）と作業ツリーで、`node draw_invariance.mjs <ツリー> <出力.json> hull` を実行する。
  - 出力の JSON を、キーごとに比べる。後のゲートの監査も、同じコマンドで再実行できる。
- 修正前の全体の md5: `cafb9c1453c2c5c499dc2991772a0b3a`。修正後（Rev 21・22）の全体の md5: `63eddb2360f81f397d8d5a7e29d4dc35`。Rev 19 までは、最後の行を除く 24 通りが異なる `5f2a0e3fb68b422c4d1014cd2e945ad3` だった。Rev 20 は、最後の行の低詳細だけが変わる `0b19a4f998e6c1f77a241f14c95853e1` だった。

**そのほかの確認**

- **物理の不変**: 予測のビット一致検査が一致する。
  - スクリプトは作業者の一時ディレクトリにある（`/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/`）。消えた場合は再現できないため、そのときは物理（Worker が読み込むファイル）の差分が、§3.1 の 3 つ（本数の式、届かない代わりの値の削除、Worker の復元の段番号の正規化）と §3.11（設定の写しのキャッシュ。返す値は同じ）だけであることを、コードの読み合わせで確かめる。
  - `GS_ROOT` のツリーには、`scripts/`・`presets/` に加えて `testsuites/test_helpers.mjs` が要る（d2 のハーネスが読む）。修正前のツリーで実行するときは、`git archive main scripts presets testsuites` で作る（描画の不変の `main_tree` は `scripts`・`presets` だけのため、そのままでは `ERR_MODULE_NOT_FOUND` になる）。
  - d2（5 ワールド × 7 構成の同期予測の結果全体）: リポジトリの根を作業ディレクトリにして `GS_ROOT=<ツリー> WORLDS=SE,W7,SS,BIN,TB node <一時ディレクトリ>/perf/d2.mjs` を実行し、出力の md5 が `2e22aefa3a20913ea507399278276b26` になる。`WORLDS` を付けないと、別の値になる。
  - s2（15 通りの打ち上げを主スレッドと Worker の経路で通す）: 同じくリポジトリの根で `GS_ROOT=<ツリー> node <一時ディレクトリ>/gate2_it2/s2_flights.mjs` を実行し、出力の md5 が `91c5b9816a026dec4be5e3648cfd4948` になる。
- **目視**: 修正後の全構成の描画（遷音速・RCS・射点）を、画像で確かめる。


### 5.5 工程 4 の結果（2026-11-25〜26）

計測は、作業ツリーで行った。Rev 27 で読込の段数（`gravsim_object_manager.js`）を直し、Rev 28 で回帰 12 の試験と注記を直したため、機械的チェック・全テスト・カバレッジ・描画の不変・物理の不変は Rev 28 のツリーでやり直した（`/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/p4/rev28/`。2026-11-26、このマシンでほかのテストが動いていないことを確かめてから始めた）。§3.11-6 の計測と目視は Rev 25 のツリーで行い、その後に変えたのは読込だけで、どちらの対象も通らない。テストと重い処理は 1 本ずつ実行した。

| 項目 | 結果 |
|---|---|
| 機械的チェック（`npm run check`） | 終了コード 0。lint のエラー 0、警告 54 件。警告の数は、変更したどのファイルも `main` と同じ |
| 全テスト（`npm test`） | 2,054 件すべて合格（339 suites、skip・todo なし）。単体 1,272、結合 278、回帰 458、システム 46。`duration_ms 78809.973836`（2026-11-26、Rev 28 のツリー。記録は `p4/rev28/full_test.log`） |
| カバレッジ（`npm run test:coverage`） | 行 99.52%、分岐 93.88%、関数 97.82%（`scripts/` 全体、Rev 28 のツリー。記録は `p4/rev28/coverage.log`。Rev 25・27 の実行は分岐 93.87%。基準の最低 90% を満たし、行と関数は目標の 97% を上回る）。本ブランチで加えた・変えた行のうち通らないのは、`gravsim_calc.js` L61（`peekCelestialParam` の `typeof presetManager` の守り。Node でも presetManager は必ず定義されるため届かない。L45 の同じ形の守りは `main` からある）だけである。変更したファイルには、`main` からある通らない行も残る（`gravsim_preset_manager.js` の Proxy の symbol・`inspect` の守りと `getOwnPropertyDescriptor` の `undefined`（L1338-1339・L1370-1371・L1388・L1396-1397・L1413。`main` でも通らない）、`gravsim_calc_object.js` L678・L997、`gravsim_calc.js` L936-938・L1124-1125、`gravsim_flight_computer.js` L660-668、`gravsim_object_placer.js` L432-439、`gravsim_rocket_launcher.js` L212-213・L270-271）。表は `testsuites/README.md` §5 |
| 描画の不変（§5.4） | 全体の md5 `63eddb2360f81f397d8d5a7e29d4dc35`（Rev 27・28 のツリー）。`main` と異なるのは §5.4 の表の 216 通りだけ |
| 物理の不変（§5.4） | d2 `2e22aefa3a20913ea507399278276b26`、s2 `91c5b9816a026dec4be5e3648cfd4948`（修正前と一致）。Rev 22・Rev 26・Rev 27・Rev 28 のツリーで実行し、どれも同じ値だった。Rev 23・Rev 27 で変えた `gravsim_object_manager.js` の `loadState` は、d2・s2 のどちらも通らない（d2 は主スレッド側で `gravsim_object_manager.js` を読み込むが、読込はしない） |
| E2E の RCS の印 | system 06 の一時停止で立つ印は実行ごとに変わる。本工程までの実行で CW（独立監査3 Iteration 7）と CCW（ほかの実行）の両方が立ち、どちらの役割も E2E で確かめた |

**§3.11-6 の計測**（`/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/p4/perf3116.mjs`、修正前のツリーは `git archive main scripts presets testsuites`）。1 回あたりの回数と時間で、修正前と修正後を交互に 3 回ずつ測った。回数は 3 回とも同じだった。

| 場面（1 回あたり） | 修正前: 設定の写しの組み立て直し / 旧形式のプリセットの組み立て直し / `getCelestial` | 修正前の時間 | 修正後: 回数 | 修正後の時間 |
|---|---|---|---|---|
| 高詳細の描画（R 40、遷音速・噴射・RCS） | 22 / 0 / 0 | 610〜639 µs | すべて 0 | 14.7〜15.3 µs |
| `updateHistory`（`baseRadiusM`・`param` なし） | 2 / 0 / 1 | 55.6〜57.1 µs | すべて 0 | 1.3〜3.0 µs |
| 射点の演出（保持中、`update`・`drawBackground`・`drawForeground`） | 1 / 0 / 1 | 36.9〜38.6 µs | すべて 0 | 12.2〜12.8 µs |
| `RocketLauncher.drawPreview`（一覧にある機体） | 1 / 2 / 2 | 242〜259 µs | すべて 0 | 3.3〜3.9 µs |
| `RocketLauncher.drawPreview`（一覧にない機体、第 1 段の `rocketLengthM` なし） | 1 / 6 / 3 | 590〜607 µs | すべて 0 | 4.0〜4.1 µs |
| スリングショットの HUD | 0 / 0 / 2 | 6.6〜7.1 µs | すべて 0 | 2.4〜2.5 µs |
| 天体の効果の描画（10 体の 1 フレーム、`param` なし） | 0 / 0 / 10 | 23.2〜23.6 µs | すべて 0 | 3.4〜3.7 µs |
| Worker の物理の 1 更新（名前が表にない投棄物、サブステップ 10 回） | `getCelestial` の名前の検索 11 回（最初の更新も 11 回） | 24.3〜25.7 µs | 検索 0 回（最初の更新も 0 回） | 19.9〜22.3 µs |

- 修正前の Worker の名前の検索は、更新ごとに 1 回とサブステップごとに 1 回である（サブステップ 3 回で 4 回、10 回で 11 回）。本番の更新は 1 フレームあたりサブステップ 20 回以上である。
- 修正後は、どの場面でも組み立て直し・写し・検索が 0 回である。最初のフレームで写しを作る場面も、計測の前の 20 回のうちに作り終える。

**目視**（`/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/p4/render_final.mjs`、ヘッドレス Chrome で描いた画像 `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/p4/img/vapor.png`・`rcs.png`・`pad.png`）

- 遷音速（マッハ 1.0、気圧比 0.5）の 10 の状態（1〜3 段機の各段、SRB 2・4 本、フェアリング分離の後、ペイロード単体）で、主コーンの頂点がフェアリングの基部（またはペイロードの前面）に、副コーンの頂点が最上段の段間の前端にある。
- RCS の CW・CCW・アレージの 30 の組み合わせで、横向きの噴射が現在の段の壁の空きの区間から出て、フィン・SRB・広い隣の段に掛からない。CW と CCW の偶力の向きは §3.6 の表のとおりである。ペイロード単体は本体の四隅から出る。第 1 段のアレージと SRB の重なりは、利用者が許容したものである。
- 射点の 6 構成（1〜3 段機、フェアリングの有無）で、アームの端面とケーブルの接続点が機体の外形に届き、隙間がない。

---

## 6. 別ブランチにした項目（利用者の判断、2026-11-23・2026-11-25・2026-11-26）

[構造の見直しへの入力](2026-11-21_architecture_redesign_inputs.md) に、次の 4 項目を記録する。H1-15・H4-25 の内容は §1.4.3 と同じである。

- **H1-15**（§3.1 Worker の物理と予測）
  - 段の分離のたびに、残った機体の描画が飛ぶ。
  - 投棄物（段・フェアリングの半分・SRB）の初期位置が、描いていた位置と違う。
  - Worker の尺度が `radius / 3.10`（H1-8）。
  - 直すには、描画の基準点を段の構成によらず物理の位置に対して固定し、投棄物の初期位置を形状から決める。物理の位置と予測のビット一致が変わる。
- **H4-25**（§3.4 描画）
  - 投棄物の描画寸法が機体と違う（第 2 段、フェアリング、3 段機の第 2・第 3 段）。
  - 直すには、どの段の投棄物かを Worker から受け取る必要がある。H1-15 と同じ作業で行う。
- **H2-16**（§3.2 物体・世界・保存と読込。利用者の判断、2026-11-25）
  - 保存ファイルの段の配列（`stages`）の要素の型を検証しない（`main` と同じ。手で書き換えた保存ファイルでだけ起きる）。症状は要素の種類で違う。
    - `null` の要素: Worker の `normalizeRocketConfig` が止まり、Worker にロケットが作られない（主スレッドには残る）。主スレッドの `Rocket.mass` は、その要素が現在の段より後ろにあるときだけ TypeError になる（読込そのものは `mass` を読まない）。
    - `null` でない物体でない要素（数・文字列・真偽値）: 読込は止まらない。その要素が現在の段かその後ろにあると、Worker はその段を既定値の段として飛ぶ（推力・質量は `normalizeRocketConfig` の既定値）。その要素が現在の段より後ろにあると、主スレッドの質量は `NaN` になる。現在の段より前の要素は、どちらにも影響しない。
  - H2-6 と同じ部類で、版番号付きの保存形式（見直しの C6）で段の設定の形を定め、読込で要素ごとに検証する。
  - 独立監査3 Iteration 7 の注意 2 で見つかり、Iteration 8 の G3-8-01 で症状を訂正した。本ブランチの段番号の正規化（§3.1）は段の要素を読まないため、この不具合に関わらない。
  - 同じ部類の、保存ファイルの段数（`totalStages`）を検証しない不具合（独立監査4 Iteration 1 の注意 5）は、利用者の判断（2026-11-25）で本ブランチで直した（§3.1、Rev 27）。H2-16 は段の配列の要素だけである。
- **H2-17**（§3.2 物体・世界・保存と読込。利用者の判断、2026-11-26）
  - 配置した多段機の主スレッドの段数（`Rocket.totalStages`）は、最初の Worker のフレームまで初期値の 1 のままで、そのあいだに保存すると保存ファイルに 1 が書かれる（一時停止の中でロールアウトしてすぐ保存したとき。`main` と同じ）。
  - 本ブランチの読込は `totalStages` を読まないため、表示・物理に影響しない（R9）。影響が残るのは、そのファイルを前の版のアプリで読んだときだけである。
  - 独立監査4 Iteration 3 の注意 2 で見つかった。直すと保存の中身が変わる（R9 の「保存は変えない」）ため、利用者の判断で構造の見直し（保存形式 C6）に回した。

---

## 7. 用語

| 用語 | 意味 |
|---|---|
| 現在の段 | 形状の `segments` の最後の段。描画している最下段で、噴射炎と RCS を持つ |
| 機首の肩 | 主コーンの頂点。フェアリングの基部、または露出したペイロードの前面 |
| 空きの区間 | RCS を持つ胴体の区間から、張り出す部品の区間（噴射の広がりの余白込み）を除いた残り |
| 構成の部品 | 分離の前後によらず機体の構成にある部品（`fairingConfig`、`boosterLayout`） |

---

## 8. 独立監査の指摘の対応

### 8.1 独立監査1 Iteration 1

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-1-01 | 【実装】 | RCS を空きの壁に置く（§3.6）。Iteration 2 で、噴射の広がりと分離の前後を含めて改めた |
| G1-1-02 | 【実装】 | 修正後の範囲と、受け入れの根拠（利用者が選んだ試作）を示した（§1.5）。E2E は、胴体の外の画素で確かめる（§5.3） |
| G1-1-03 | 【実装】 | 放出位置を形状から決める（§3.7）。`NOZZLE_BOTTOM_OFFSET` の一致を、テストで固定する（§5.1-9） |
| G1-1-04 | 【実装】 | 射点の接続点を直す（§3.8）。投棄物の位置・形と分離時の描画の飛びは、利用者の判断で別ブランチにした（§1.4.3、§6） |
| G1-1-05 | 【実装】 | 外形の戻り値を削除した（§3.4） |
| G1-1-06 | 【文書】 | ペイロード段階と SRB の本数を、1 つの規則にした（§3.1） |
| G1-1-07 | 【文書】 | §4 を訂正した |
| G1-1-08 | 【文書】 | 回帰の基準を、数値と許容差で定めた（§5.1-5） |
| G1-1-09 | 【文書】 | E2E の手順を定めた（§5.3。Iteration 2 で時間を改めた） |
| G1-1-10 | 【文書】 | R9 と §5.4 に、変わる入力とスクリプトを書いた |
| G1-1-11 | 【文書】 | `stageIndex` の意味、露出しないノズルの値、`ambientPresRatio` の既定値を定めた（§3.2・§3.3） |
| G1-1-12 | 【文書】 | §1.2・§3.4 の表を訂正した |

### 8.2 独立監査1 Iteration 2

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-2-01 | 【実装】 | 横向きの噴射は、広がり（半角）の余白を付けて部品を避ける（§3.6.1）。ペイロード単体は、本体の四隅から前後に噴く（§3.6.2）。パネル・アンテナに掛からない |
| G1-2-02 | 【実装】 | 避ける部品を機体の構成から決め、フェアリング・SRB の分離でノズルが動かない（§3.6.1） |
| G1-2-03 | 【実装】 | アームの長さを、胴体の壁までの長さにする（§3.8）。`bodyRadiusAt` は、フェアリングの曲線も扱う |
| G1-2-04 | 【文書】 | R9・§3.1・§3.10・§5.4 に、SRB の本数による両方の詳細度の変化を加えた。Worker と異なる入力の記述を訂正した |
| G1-2-05 | 【文書】 | §5.4 の入力に、燃料 5 種・気圧比 3 つ・自走ペイロードを加えた（2,735 通り） |
| G1-2-06 | 【文書】 | §4 に、`_drawBoosters` を直接呼ぶテスト、回帰 12 の L471-552、`updateHistory` を呼ぶテスト、integration 12 の L657 を加え、理由を訂正した |
| G1-2-07 | 【文書】 | HUD は `resolveStackState(target, tm)` と `boosterCount(resolveBoosters(target))` を使う（§3.1）。Worker が共有するのは本数の式だけである。`hasSrbBoosters` を加えた |
| G1-2-08 | 【文書】 | E2E は、窓の 17 s 以上前に一時停止して時間倍率を変える。写しの `thrustAngle` を 0 にする。10 倍に下げるきっかけを書いた（§5.3） |
| G1-2-09 | 【文書】 | 尺度を `_visualBaseRadiusM` の 1 箇所にし、一致の範囲を書いた（§3.7）。§5.1-9 の条件を `R = 1` とした |
| G1-2-10 | 【文書】 | §1.4.3 と H1-15・H4-25 の記録を補った |
| G1-2-11 | 【文書】 | パッドの粒子の尺度を直す（§3.8-3）。§1.4.2 に条件を、R7 に例外を書いた。クラス名を `PadEffectRenderer` とした |

### 8.3 独立監査1 Iteration 3

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-3-01 | 【実装】 | Rev 4 で RCS の噴射を機体の後ろに描いたが、噴射炎に隠れる（G1-4-01）ため、Rev 5 で利用者の判断により現在の順に戻し、重なりを許容した（§8.4） |
| G1-3-02 | 【実装】 | `bodyRadiusAt` を外形（収納状態のペイロードを含む部品の半径の最大）にした（§3.8-1）。フェアリングなしの 1 段機のアームは 0.805 になる |
| G1-3-03 | 【実装】 | `_visualScreenRadius` を、構造物・粒子の位置・粒子の大きさの 3 箇所で使う（§3.8-3） |
| G1-3-04 | 【文書】 | 形状に、構成のフェアリング `fairingConfig` を加えた（§3.2）。§3.6.1 はそれを使う |
| G1-3-05 | 【文書】 | R9・§3.1 の条件を「本数が正でなく、燃焼時間が正」とし、§5.4 に負の数と文字列の入力を加えた |
| G1-3-06 | 【文書】 | アナンシエーターも `resolveStackState(target, tm)` を使う（§3.1）。段番号を `\|\| 0` で正規化し、HUD の表示が変わらないようにした（レンダラーの変化は R9・§5.4）。R8 で、Worker は本数の式だけを共有すると書き分けた |
| G1-3-07 | 【文書】 | §4 の `_drawBoosters` を直接呼ぶテストの行に行番号を入れ、`NOZZLE_BOTTOM_OFFSET`・`CABLE_CONN` の行から回帰 16・17 を除いた |
| G1-3-08 | 【文書】 | H1-15 の箇所に、`_seedFallbacks`・`gravsim_calc.js:58-105`・`gravsim_calc_object.js:338` を加えた |
| G1-3-09 | 【文書】 | アンテナの値（中心線の隙間）と線の扱い（描く順）を書いた。ベジェの記述・外形の境界の規則・範囲外の段番号の記述を訂正した |

### 8.4 独立監査1 Iteration 4

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-4-01 | 【実装】 | 利用者の判断（2026-11-24、「機体の上に描く」）で、RCS の描く順を現在と同じに戻した。第 1 段のアレージとフィン・SRB の重なり、衛星のアンテナの線との 1 画素未満の重なりを許容する（R4、§3.6） |
| G1-4-02 | 【文書】 | §4 の unit 02・integration 02 の接続点の行を、ケーブルを直接呼ぶため期待値が変わらない、と訂正した。unit 04 の `_getVisualMultiplier` のテストの行を加えた |
| G1-4-03 | 【文書】 | アナンシエーターの段数の理由を訂正した（§3.1）。SRB の設定を `boosters` だけにして、描画・HUD・物理を一致させ、Worker の届かない代わりの値を削除する（§3.1、§4）。§5.1-2 の試験の入力を定めた |
| G1-4-04 | 【文書】 | アームの長さを、端面の範囲の外形の最小から決め、描く順の前提を書いた（§3.8-2）。§5.1-8 に範囲全体の試験を加えた |
| G1-4-05 | 【文書】 | ペイロード単体の形状の値（§3.2）、`_drawBoosters` の本数 0 での戻り（§3.3）、炎の先端の値の条件（§1.4.1 (c)）を書いた |

### 8.5 独立監査1 Iteration 5

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-5-01 | 【実装】 | 第 1 段のアレージの範囲（惰行の後の再点火。2 段機・3 段機を含み、H3-22・H3-24 では SRB に重なる）と、アンテナの線との重なり（最大約 0.30 px、`R` 6.3〜8.0 px 未満）を示して、利用者の了承を取り直した（2026-11-24、「許容する」）。R4・§3.6・§3.6.1 を訂正した |
| G1-5-02 | 【文書】 | アンテナの線との隙間を最短距離（0.095・0.089・0.075 R）で書き直した（§3.6.2） |
| G1-5-03 | 【文書】 | §5.1 の Rev 4 の記述（描く順、`resolveBoosters` の優先順位、「低詳細の 4 つ」）を訂正した |
| G1-5-04 | 【文書】 | R9・§3.10・§4 に、L330 の削除と、不正な本数で分離の本数が変わることを書いた |
| G1-5-05 | 【文書】 | `thrustData?.boosters` も届かないことを書き、3 つとも削除する（§3.1）。合成する箇所の引用を訂正した |
| G1-5-06 | 【文書】 | `_computeBoosterLayout` は本数 0 で `null` を返し、`_drawBoosters` はそのとき戻る（§3.3） |
| G1-5-07 | 【文書】 | 射点の形状は保持の間に求め、保持が解けた後は最後の値を使う（§3.8-2） |
| G1-5-08 | 【文書】 | 改訂履歴の行を順に並べた |

### 8.6 独立監査1 Iteration 6（PASS（文書指摘あり））

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-6-01 | 【文書】 | 2 段機のしきい値を 6.8 px（6.772 px）に訂正した（§3.6.2） |
| G1-6-02 | 【文書】 | `_padAnchors` の時点（保持の間に求めて覚える）、初期値（設定値）、消す時点（`start()`）を書き、§5.1-8 に試験を加えた（§3.8-2） |
| G1-6-03 | 【文書】 | §5.4 に d2・s2 の実行の手順と、スクリプトが消えたときの確かめ方を書いた |
| G1-6-04 | 【文書】 | SRB の張り出しを、`_computeBoosterLayout` の値（`max(\|yPositions\|) + rB - h`）で書いた（§3.6.1） |

### 8.7 独立監査2 Iteration 1

| 指摘 | 分類 | 対応 |
|---|---|---|
| G2-1-01 | 【実装】 | RCS の空きの区間の「長さが正」の規則を、胴体の区間そのものにも掛けた（`_rcsNozzles`）。`R` = 0・`NaN` や長さ 0 の段では `rcs = null` になる |
| G2-1-02 | 【文書】 | §3.1 のコードを実装に合わせ（`rocket?.`）、`null` の物体の扱いを書いた |
| G2-1-03 | 【文書】 | §3.8-2・§5.1-8 の「ロケットがないときは設定値」を、「値を覚えていない間は設定値、覚えた後はロケットのない文脈でも覚えた値」に訂正した |
| G2-1-04 | 【文書】 | §5.4 に、`GS_ROOT` のツリーに `testsuites/test_helpers.mjs` が要ることと、修正前のツリーの作り方を書いた |
| G2-1-05 | 【文書】 | H1-15 の `gravsim_calc_object.js` の行番号を、本ブランチの行に合わせた |
| G2-1-06 | 【文書】 | 2026-11-20 の設計書 §3.4（`isPayloadPhase`）と試験計画 §3 の C（`_computeVisualLayout` の外形）に、本書で置き換えた旨の注記を入れた |
| G2-1-07 | 【文書】 | 低詳細の噴射炎の真空の伸び 0.15 に、`PLUME_VACUUM_STRETCH` に従わない理由（全燃料で 1 つの略図の炎）をコメントで書いた |
| 注意（既存の不具合） | 【実装】（利用者の判断） | SRB の本数を 0〜9 の整数に丸める（§1.4.1 (f)、§3.1）。Worker の分離・`hasBoosters`・乾燥質量の既定値、描画、HUD、推進剤の見積もりが同じ規則を使う |

### 8.8 独立監査2 Iteration 2

| 指摘 | 分類 | 対応 |
|---|---|---|
| G2-2-01 | 【実装】 | `boosterCount` で、有限でない本数・燃焼時間を値がないものとして扱う（§3.1）。保存ファイルの `1e999` でも、主スレッド（`Infinity`）と Worker（JSON の写しで `null`）の本数が一致する |
| G2-2-02 | 【文書】 | §3.1 と §5.4 の表の「Worker の分離と揃わない」を訂正した（Worker も同じ規則で 2 本） |
| G2-2-03 | 【文書】 | 数でない本数（`"4"` など）で高詳細の配置が変わることを、R9 と §3.1 に加えた |
| G2-2-04 | 【文書】 | 読む側のない公開ゲッター `MAX_BOOSTER_COUNT` を削除し、§3.1 に公開の定数を設けないことを書いた |
| G2-2-05 | 【文書】 | §5.1-1 に `null` の物体と有限でない値の試験を加え、`_computeStackGeometry` が物体を要ることを書いた。§4 に旧設計書 §3.4 と試験計画の注記、乾燥質量の既定値を加えた。§8.7 の節番号を直した |

### 8.9 独立監査2 Iteration 3（PASS（文書指摘あり））と範囲の追加

| 指摘 | 分類 | 対応 |
|---|---|---|
| G2-3-01 | 【文書】 | §5.1-1 の `null` の物体の項を、Worker の分離の項の後へ移した |
| G2-3-02 | 【文書】 | §5.1-2 の一致の試験に不正な本数（負・文字列・上限超え・小数）を、§5.2 に `1e999` を書いた保存ファイルの読込の試験を加えた |
| G2-3-03 | 【文書】 | §3.1 の修正前の規則との比較に、有限でない値の扱い（Worker は変わらない、`hasSrbBoosters` は変わる）を加えた |
| 注意 1（既存の性能の問題） | 【実装】（利用者の判断） | 設定の写しをキャッシュし、深く凍結して共有する（§1.4.1 (g)、R10、§3.11）。設計監査から受け直す |

### 8.10 独立監査1 Iteration 7

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-7-01 | 【実装】 | 旧形式のプリセットの一覧もキャッシュし、版番号をプリセットのすべての表に広げた（§1.4.1 (g)、§3.11-1・2）。読まれない `_legacyPresets` を削除する |
| G1-7-02 | 【文書】 | `getFuel`・`getFuels`・`getPlume`（呼ぶたびに写す）と `getTheme`（元の物体）の記述、`ROCKET_FUELS` の名前での読みを訂正した（§3.11-4） |
| G1-7-03 | 【文書】 | R9・§3.10・§5.4 の Worker の変更の範囲に §3.11 を加えた |
| G1-7-04 | 【文書】 | §5.1-11 に異常系・境界値・`init()` の経路・旧形式のプリセットの試験を加えた。計測を組み立て直しの回数と、描画・プレビューの時間（範囲）にした（§3.11-6）。§1.4.1 (g) の時間を範囲で書き直した |
| G1-7-05 | 【文書】 | §5.1-2 に本数 10 と `[4]` を加えた |
| G1-7-06 | 【文書】 | §3.1 の分離の本数の比較を「燃焼時間が有限の正の数」に直し、`hasSrbBoosters` の括弧書きを訂正した |

### 8.11 独立監査1 Iteration 8

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-8-01 | 【実装】 | `peekObjectParam` を設け、毎フレームの経路（`_visualBaseRadiusM`、`drawTargetMarker`、スリングショットの HUD と `getLaunchObjectName`）を写さない読みにした。`_visualBaseRadiusM` は `baseRadiusM` を先に見る（§1.4.1 (g)、§3.11-5、§4、§5.1-11） |
| G1-8-02 | 【文書】 | §5.1-11 の版番号の試験を 8 つの表にし、旧形式のプリセットの作り直し、`MULTISTAGE_PRESETS`、噴射炎のない燃料、`init()` の失敗を加えた |
| G1-8-03 | 【文書】 | R9 の「次の 2 つだけ」を「3 つだけ」にした |
| G1-8-04 | 【文書】 | §3.11-2 と §5.1-11 の、一覧にない鍵の `getLegacyPreset` の記述を訂正した（機体のない鍵で `null`） |

### 8.12 独立監査1 Iteration 9

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-9-01 | 【実装】 | パラメータを読む全箇所（約 40）を分類し（§3.11-5 の表）、毎フレーム・毎ステップ・定期に読むだけの箇所をすべて `peekObjectParam`・`peekCelestialParam` にした。天体の効果の描画、射点の位置、Worker の物理エンジン・飛行計算機・空力、Navi タブを含む |
| G1-9-02 | 【文書】 | §5.1-11 に、各読み手の試験、`_visualBaseRadiusM` の `param` だけ・偽の値の境界、`peekObjectParam` の名前の境界を加えた。§3.11-6 の計測を、射点・`drawPreview`・HUD・天体の効果・Worker の 1 ステップに広げた |
| G1-9-03 | 【文書】 | R10 に、毎フレーム・毎ステップに読むパラメータを加えた |
| G1-9-04 | 【文書】 | §3.11-2 の一覧にない鍵の記述に、大文字・小文字の変換が往復しない id の場合を加えた |

### 8.13 独立監査1 Iteration 10（PASS（文書指摘あり））

| 指摘 | 分類 | 対応 |
|---|---|---|
| G1-10-01 | 【文書】 | §1.4.1 (g) の Worker の説明を「写しではなく名前の検索」に訂正し、§3.11-6 の計測と §5.1-11 の試験を検索の回数にした。R10 に `celestialParams` の共有の物体の例外を書いた |
| G1-10-02 | 【文書】 | §3.11-5 の取り次ぎを、`ObjectPlacer`（`this.presetManager` を使わない）と `NaviTab`（`universe.getObjectParams` を使わない）の実際に合わせて書き直した |
| G1-10-03 | 【文書】 | §4 に `CelestialBody._drawEffects` を加えた |
| G1-10-04 | 【文書】 | §5.1-11 に、読み手の異常系の代わりの値、取り次ぎの順、L312 の経路の条件、`celestialParams` が `null` の場合、往復しない id の鍵を加えた |
| G1-10-05 | 【文書】 | 使われなくなる `RocketLauncher._getObjectParam` の削除を §3.11-5 に書いた |

### 8.14 独立監査2 Iteration 4（PASS（文書指摘あり））

| 指摘 | 分類 | 対応 |
|---|---|---|
| G2-4-01 | 【文書】 | §3.11-6 と §5.1-11 に、`getBaseRadiusM` の `peekObjectParam` の経路の条件（一覧にない `currentPresetId` と、第 1 段の `rocketLengthM` がないこと）を書いた |
| G2-4-02 | 【文書】 | §4 に、`RocketLauncher._getObjectParam` の削除と `_peekObjectParam` の追加、`ObjectPlacer._peekObjectParam` の追加を書いた |

### 8.15 工程 3 のテストで見つかった不具合

| 出どころ | 不具合 | 対応 |
|---|---|---|
| unit 12 のテスト（§5.1-8） | 2 段機の第 1 段と段間の継ぎ目に丸めの隙間があり、`bodyRadiusAt` が描いた胴体の中で `null` を返す（`R = 1` で x = 0.05）。今の射点の問い合わせ（x = 0.8、1.275〜1.6）には掛からない潜在の不具合 | 隣り合う要素を継ぎ目まで続くものとして扱う（§3.8-1） |
| unit 12 のテスト | `minBodyRadiusOver` が逆順の範囲で誤った最小を返す（今の呼び出し元は正順だけ） | 両端を入れ替える（§3.8-1） |
| unit 13 のテスト | `peekObjectParam` の鍵が、`null` と `String()` が `'null'` になる物体で衝突する（今の呼び出し元は物体を渡さない） | `null` に専用の鍵を使う（§3.11-5） |

### 8.16 独立監査3 Iteration 1

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-1-01 | 【実装】 | unit 12-6 に、範囲の中の部品が両端より細い場合の `minBodyRadiusOver`（3 段機の第 3 段）と、端面の範囲の最小が x = 1.6 の値と違う構成（3 段機を 0.9 R 後ろへずらし、フェアリングの基部を端面の中に置く）でのアームの長さの試験を加えた。変異 G3・G10・G12 を検出する |
| G3-1-02 | 【実装】 | unit 13 に、SRB の設定の入れ子の値を持つ機体で、組み立てた一覧は凍結され、元の表の入れ子の値は凍結されない試験を加えた。変異 I9 を検出する |
| G3-1-03 | 【実装】 | unit 12-6 に `_fairingRadiusAt` の一次式の分岐（制御点が中央）の試験を、unit 08-16 に `COLD_GAS_RCS` のない設定の試験を加えた。変異 N1・N2 を検出する |
| G3-1-04 | 【文書】 | §3.11-2 と `getLegacyPresets` の JSDoc の共有の例を、SRB の設定の入れ子の値に訂正した |
| G3-1-05 | 【文書】 | §4 と §5 の冒頭に工程 3 の試験のファイルを書き、unit 12・13 の見出しの設計書の版を Rev 16 にした |

**既存の問題（利用者の判断、2026-11-24）**: 独立監査3 Iteration 1 の注意で、`testsuites/unit/02_rocket_guidance.test.mjs` と `testsuites/integration/02_rocket_guidance_staging.test.mjs` がバイト単位で同じファイルであることがわかった（`main` でも同じ。同じ 34 件が 2 回実行され、件数も二重に数えられていた）。中身はモックを使う単体テストのため、利用者の判断で結合側の写しを削除し、`testsuites/README.md` の件数と説明を直した。§4 の表の参照も unit 02 だけに直した。削除のあとの件数は、結合テスト 278 件、全体 1,974 件。

### 8.17 独立監査3 Iteration 2

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-2-01 | 【実装】 | unit 12-6 に、端面の範囲の機尾側の端の試験を 4 つ加えた（§5.1-8）。3 段機をずらし、第 3 段の前端を範囲の中（1.35）、機尾側の端のすぐ内（1.275 + 1e-6）とすぐ外（1.275 − 1e-6）、範囲の外（1.2）に置く。期待値は、設計の表（`D_HULL`）とベジェの二分法（`fairingCurveAt`）から作る。端面の厚みの変異 7 つ（2 倍・半分・`UMBILICAL_H_MULT` なし・0.3・0.35・±1e-5。監査の P1・P2・P6 を含む）をすべて検出する |
| G3-2-02 | 【実装】 | `testsuites/README.md` §4 の実行例を、2026-11-24 の `npm test` の実際の出力（1,982 件、338 suites、`duration_ms 80214.334183`）にした。件数は、単体 1,203、結合 278、回帰 455、システム 46 である |

注意点への対応:

- 注意 3（`_fairingRadiusAt` の桁落ち）: 根を、桁落ちしない形 `q / qa`・`qc / q` で求めるように直し、一次式の分岐を削除した（§3.8-1）。
  - 旧式の誤差（比 0.5 + 1e-12 で 2.2e-5、0.5 − 1e-12 で 4.4e-5。独立監査3 Iteration 3 の測定）が、最下位ビット程度になった。
  - 制御点が始点より前の比（−0.1・−0.5）でも、旧式と同じ根を選び、正しい。`qb` の符号によらず `-2 qc / (qb + √…)` とする形は使わない。この形は、負の比の `x = startX` で、もう一方の根 `t = 0` を選ぶ（旧式・二分法との差は −0.1 で 3.3e-2、−0.5 で 1.8e-1）。そのすぐ後の `x`（`startX + 1e-9`）では、`qb + √…` の桁落ちで誤差が 1e-10 程度になる。
  - 出荷する比 0.7 では、旧式との差は 4e-16 以下で、hull の描画の md5（`5f2a0e3fb68b422c4d1014cd2e945ad3`）は変わらない。
  - unit 12-6 に、比 0.5 の前後・始点の近く・負の比で二分法と 1e-12 以内に一致する試験を加えた。旧式・上の形・`qb` の符号を無視する形・根の取り違えの 4 つの変異を検出する。
- 注意 4（E2E の RCS の役割）: system 06 に、§3.6.1 の表から独立に作った位置・壁の側・向きとの比較を加えた（§5.3 の 7）。前方と後方の取り違え（監査の R5）と、CW と CCW の一覧の取り違えを、E2E で検出することを確かめた。
- 注意 5（HUD の規則の一致）: unit 12-2 に、`disableStaging` の機体（ペイロードの分離のフラグが立っていても段の表示）と、`stages` のない物体（1 段の表示と、フラグによるペイロード段階）の 3 つの入力を加えた（§5.1-2）。HUD を旧規則にする変異 H1x・H2x を検出する。
- 注意 6（監査記録の過去の節の修正）: Rev 18 で、監査記録の独立監査1 Iteration 4 の節（L1029）にあった、削除した `integration/02` へのリンクを、同じ内容の文に書き換えた。リンクが切れるためで、指摘や判定の内容は変えていない。

### 8.18 独立監査3 Iteration 3

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-3-01 | 【実装】 | unit 12-6 に、`_fairingRadiusAt` の比 0（`x(t) = startX + t² length`）と比 1（`x(t) = startX + (2t − t²) length`）を閉じた式と比べる試験と、長さ 0 のフェアリングで基部の半径を返す試験を加えた。二分法の試験に比 1.2 を加えた。監査の変異 F5・F6・F7・F11 を検出する |
| G3-3-02 | 【実装】 | unit 12-2 に、段のない物体の段番号 1（`currentStageIndex` とテレメトリの 2 通り）を加えた。段の表示は「2 / 1 (CORE)」で、ペイロード段階にならない。カードのペイロード段階は、見出しに出ないため、残量の最大値の初期化（ペイロードのタンク 7 t を使うのはペイロード段階だけ）で確かめる。監査の変異 H3s・H4s と H1x・H2x を検出する |
| G3-3-03 | 【実装】 | unit 08-16 に、`COLD_GAS_RCS` に `PLUME_SPREAD_RAD`・`ULLAGE_CANT_RAD` がない設定の試験を加えた。ノズルの余白とアレージの向きが既定値 0.34・0.28 で決まり、描く霧の半角も 0.34 で余白と揃うことを確かめる。監査の変異 D1・D2 と、描く側の既定値を変える変異 D3 を検出する |
| G3-3-04 | 【文書】 | unit 12 の見出しの設計書の版を Rev 20 に、system 06 の見出しに役割の検証を書き加えた。unit 12-6 の二分法の注記（負の比の `x = startX` の根）と、§8.17 の数値（旧式の − 側の誤差 4.4e-5、退けた形の差は `x = startX` の根の選び方と、その後の桁落ちによる）を直した |

**横展開で見つけた不具合（§3.1、R9）**: G3-3-02 の段のない物体の段番号 1 の入力を書くとき、高詳細は段数 1 の機体を段番号によらず第 1 段として描くのに、低詳細は `curStgIdx === 0` のときだけ第 1 段を描いていた（`main` でも同じ）。ペイロード段階でないまま段番号が 1 以上になる段数 1 の機体（`disableStaging` の 1 段機、`stages` のない物体）で、2 つの詳細度が食い違う。実際の飛行では届かない状態だが、§3.1 の「両方の詳細度で 1 つの規則」に反するため、低詳細を高詳細に合わせた（`hasStage1 = !isPayloadOnly && (curStgIdx === 0 || totalStg === 1)`）。

- 描画の不変では、段数 1・段番号 1 と 2・`disableStaging` の 192 通りが新たに異なり（§5.4 の表の最後の行）、ほかは Rev 19 と一致した。
- 低詳細を元に戻す変異 L1 を、unit 12-2 の新しい入力が検出する。
- 件数: 単体 1,207（unit 08 329、unit 12 110）、全体 1,986（338 suites）。`testsuites/README.md` §4 の実行例は、2026-11-24 の `npm test` の実際の出力（`duration_ms 81719.923827`）にした。

### 8.19 独立監査3 Iteration 4

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-4-01 | 【実装】 | unit 12-2 に、現在の段の一致の試験を加えた（§5.1-2）。段数 1〜3 × 段番号 −1・0・0.5・1・2・段数・段数 + 1 × `disableStaging` の有無と、`stages` のない物体の段番号 5 通りの、計 41 通りである。期待値は §3.1 の規則（ペイロード段階の判定と、段の番号でない段番号を最後の段と読むこと）から作る。両方の詳細度の第 1 段と SRB、形状の第 1 段・現在の段・噴射炎の燃料、HUD の段の表示と SRB の表示、カードの見出しを比べる。unit 12-1 に、その境界（−1、0.5、1.5、段数 − 1、段数、`Infinity`、ペイロード段階は段番号のまま）の試験を加えた |
| G3-4-02 | 【実装】 | 方針 (a) をとった。§3.1 の `resolveStackState` が、ペイロード段階でないとき、段の番号でない段番号を最後の段とした `curStgIdx` を返す。最初は負の段番号を第 1 段に収めたが、unit 08 の範囲外の段番号の試験（§5.1-3。負・小数・段数以上は最後の段として描く）で、高詳細の描く段が変わることがわかり、高詳細がもともと描く最後の段に揃えた。unit 08 の 12 の入力と回帰 12 の 1 つの期待値（段番号）を、この規則に直した（描く段の期待値は変わらない）。使う側（両方の詳細度、形状、HUD の段の表示・SRB の表示・カード・アナンシエーター）は変えずに、同じ段を使う。Rev 20 で変えた低詳細の式は、`main` と同じ `curStgIdx === 0` に戻した。アナンシエーターの試験に、`disableStaging` の 1 段機の段番号 1（1 段目の 1-ENG）と 2 段機の段番号 2 を加えた |
| G3-4-03 | 【文書】 | unit 12-6 の二分法の注記を、2 つの根があるとき（負の比の `x = startX`、比 1.2 の `x = startX + length` の `t = 5/7`）にどちらを取るかの説明に直した |

- 描画の不変: `main` と異なるのは、Rev 20 と同じ 216 通りである。そのうち、段数 1・段番号 1 と 2・`disableStaging`・噴射ありの高詳細（`R` 12・40）の 64 通りは、噴射炎の燃料が第 1 段の `solid` になり、Rev 20 と異なる。全体の md5 は `63eddb2360f81f397d8d5a7e29d4dc35` である（§5.4）。
- 変異: 最後の段と読む処理を外す・段数以上だけにする（負を残す）・整数の判定を外す（小数を残す）・ペイロード段階にもかける・段数を段の番号に含める・負を第 1 段にする・最後の段を段数にする・段番号 0 を除く、の 8 つと、パネルの SRB の表示・1-ENG・段の名前、カードの見出し、噴射炎の燃料が生の段番号を読む 5 つを、すべて検出する（unit 12・unit 08）。監査の L2・L3・L5（低詳細の式）は、この規則の段番号では等価になる。（Iteration 5 で、L2 は等価でないことがわかった。段のない物体でテレメトリの段数が 2 以上のとき、低詳細だけが第 1 段を描く。Rev 22 の試験で検出する。§8.20）
- §8.18 の低詳細の修正（`|| totalStg === 1`）は、この規則に置き換えた。
- 件数: 単体 1,251（unit 12 154）、全体 2,030（339 suites）。`testsuites/README.md` §4 の実行例は、2026-11-24 の `npm test` の実際の出力（`duration_ms 77744.30648`）にした。

### 8.20 独立監査3 Iteration 5

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-5-01 | 【実装】 | 方針 (a) をとった（利用者の方針: 見つけた既存の不具合は本ブランチで直す）。段番号の正規化 `RocketStackUtils.normalizeStageIndex(value, stageCount, disableStaging)` を §3.1 に加え、`resolveStackState`・`ObjectManager.loadState`・`CalcRocket` の復元・`Rocket.mass` の 4 か所が使う。小数の段番号の保存ファイルの読込が途中で失敗した既存の不具合（`main` と同じ）と、負の段番号・`disableStaging` の段数以上の段番号で主スレッドと Worker が別の段を使っていたことを直した。旧設計書 2026-11-20 §3.5-1 に注記を加えた |
| G3-5-02 | 【実装】 | アナンシエーターの試験に MECO・SECO の検証と、負・小数・段数以上の段番号の入力を加えた。現在の段の一致の試験に、カードの残量の最大値と、段のない物体のテレメトリの段数 2・3 の入力（13 通り）を加えた。名前と入力の合わない試験（「no MECO」、「index 0 and 1」）を直した |
| G3-5-03 | 【文書】 | §3.1 のコードの枠を実際のコード（`normalizeStageIndex` と現在の段）にした。unit 12 の注記（clamped）と見出しの設計書の版（Rev 22）を直した |

- 試験: unit 12-1 に `normalizeStageIndex` の値の試験（31 通り）と、正規化の境界の試験を加えた（前の「最後の段」の境界の試験を置き換えた）。unit 08 の範囲外の段番号の試験（14 の入力）は、正規化した段（負・1 未満の小数は第 1 段）を描くことを確かめる。unit 10-2 に小数の段番号と `disableStaging` の復元を、回帰 12 に `Rocket.mass` の小数・`disableStaging` と、段番号を書き換えた保存ファイルの読込の試験を加えた。
- 変異: 切り捨てを外す・四捨五入にする・`disableStaging` の上限を外す・現在の段を最後の段までにしない・生の段番号を読む、の 5 つと、読込・Worker の復元・`Rocket.mass` を前の式に戻す 3 つ、アナンシエーターの MECO・SECO・2-SEP・2-ENG、カードの残量の最大値、低詳細・形状が生の段番号を読むもの、監査の L2 を、すべて検出する。監査の M4（1-SEP が生の段番号を読む）は等価である。段数 2 以上では、正規化は「段番号 ≥ 1」が成り立つかどうかを変えない（負と 1 未満の小数は 0、1 以上は 1 以上）。
- 描画の不変: 全体の md5 は Rev 21 と同じ `63eddb2360f81f397d8d5a7e29d4dc35` で、`main` と異なるのは 216 通りである。物理の不変: d2 `2e22aefa3a20913ea507399278276b26`、s2 `91c5b9816a026dec4be5e3648cfd4948` で、修正前と一致する。
- 件数: 単体 1,272（unit 08 331、unit 10 114、unit 12 172）、回帰 456（回帰 12 27）、全体 2,052（339 suites）。`testsuites/README.md` §4 の実行例は、2026-11-24 の `npm test` の実際の出力（`duration_ms 80827.051792`）にした。

### 8.21 独立監査3 Iteration 6

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-6-01 | 【実装】 | `ObjectManager.loadState` の段数を、Worker（`normalizeRocketConfig` が 1 段を作る）・`resolveStackState`・保存の `totalStages` と同じく、段の配列がないか空なら 1 にした。段のない機体（ストレステストの群れのロケット）がペイロード段階（段番号 1）で保存され、読込で段番号 0 に変わっていた（Rev 22 で生じた。`main` では変わらない）。回帰 12 に、そのロケットを配置し、ペイロードの分離の後に保存して読み込み、主スレッド・Worker・テレメトリの段番号 1 と分離の状態が保たれる試験を加えた。前の式（段数 0）・読込で正規化しない・`disableStaging` の上限を外す、の 3 つの変異を検出する |
| G3-6-02 | 【文書】 | §4 の影響範囲の表に、`gravsim_object_manager.js`・`Rocket.mass`・`CalcRocket` の復元・unit 10-2・回帰 12・旧設計書 §3.5-1 を加えた。R9 に、段番号の正規化の確認方法（d2・s2 は復元の分岐を通らないため、unit 10-2・回帰 12・system 04・05）と、主スレッドの値だけが変わる入力（負の数・文字列・段数を超える値）を書いた。§5.4 の物理の差分を 3 つにし、§8.19 の L2 の記述に Iteration 5 の結果を加え、回帰 12 の注記を Rev 22 の規則にした |
- 件数: 回帰 457（回帰 12 28）、全体 2,053（339 suites）。`testsuites/README.md` §4 の実行例は、2026-11-24 の `npm test` の実際の出力（`duration_ms 79919.736299`）にした。描画の不変・d2・s2 は、変えたのが主スレッドの読込だけのため、Rev 22 と同じである（読込は、どちらの検査も通らない）。

### 8.22 独立監査3 Iteration 7

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-7-01 | 【実装】 | 回帰 12 の書き換えた保存ファイルの試験に、Falcon 9 の段番号 3・5（2）、`"1"`・`true`（1）、`null`（0）を加えた。段のない機体の書き換えた保存ファイルの試験を加えた（配置の直後の保存ファイルの 0・1・2・5・−1・0.5・`disableStaging` の 1 と、分離の後の保存ファイルの 2。期待値は 0・1・1・1・0・0・0・1 で、§3.1 から作る）。監査の C1（段のない機体の段数 2）・C2（`Infinity`）・C6（分離していないときだけ 0）・C8（上限を `disableStaging` のときだけかける）・C9（数でない値をそのまま入れる）と、Rev 22 の段数 0 を検出する。コードは変えていない |
| G3-7-02 | 【文書】 | R9 の主スレッドの値だけが変わる入力に、数でない値（文字列・真偽値・`null`・配列）を書いた。§5.1-2 に、書き換えた保存ファイルの入力と、段のない機体の保存→読込の試験を書いた |

**既存の不具合（利用者の判断、2026-11-25）**: 独立監査3 Iteration 7 の注意 2 で、保存ファイルの段の配列の要素の型を検証しないことがわかった（`main` と同じ。`null` の要素では Worker にロケットが作られず、ほかの物体でない要素では Worker が既定値の段で飛ぶ。症状は Iteration 8 の G3-8-01 で訂正した）。段の要素の型の検証は保存形式の問題で、利用者の判断で構造の見直しの入力に H2-16 として記録した（§6）。
- 件数（§8.22）: 回帰 458（回帰 12 29）、全体 2,054（339 suites）。`testsuites/README.md` §4 の実行例は、2026-11-25 の `npm test` の実際の出力（`duration_ms 79539.954598`）にした。コードは変えていないため、描画の不変・d2・s2 は Rev 22 と同じである。

### 8.23 独立監査3 Iteration 8（PASS（文書指摘あり））

| 指摘 | 分類 | 対応 |
|---|---|---|
| G3-8-01 | 【文書】 | §6 と見直しの入力の H2-16 の症状を、要素の種類ごとに訂正した。`null` の要素では Worker にロケットが作られず、`Rocket.mass` の TypeError は要素が現在の段より後ろのときだけである。数・文字列・真偽値の要素では読込は止まらず、Worker は既定値の段で飛び、主スレッドの質量は `NaN` になる。段番号の正規化は要素を読まないことを書いた |
| G3-8-02 | 【文書】 | §5.1-2 に、段のない機体の書き換えた保存ファイルの試験が確かめる範囲（最初のフレームの前の主スレッドと Worker の段番号、Worker の段数 1）と、描画・HUD の規則と質量を受け持つ試験を書いた。Iteration 7 の修正方針より狭い範囲にしたのは、残りの値を unit 12-1 と回帰 12 の `Rocket.mass` の試験が確かめるためである |
| G3-8-03 | 【文書】 | R9 の主スレッドの値だけが変わる入力を、「負の数と数でない値、`disableStaging` でない機体の段数を超える値」にした（`disableStaging` の機体の負の数・数でない値も含む）。§4 の見直しの入力の行に H2-16 を加えた。Rev 24 の日付を 2026-11-25 にした |

### 8.24 独立監査4 Iteration 1

| 指摘 | 分類 | 対応 |
|---|---|---|
| G4-1-01 | 【実装】 | `testsuites/README.md` §1 のディレクトリ構成のコードブロックに、開きの柵（```text）を加えた。`main`（4ae7a8e）からある書式の不具合で、§1 の後ろから §3 の見出しまでが 1 つのコードブロックとして表示されていた。柵の数が対になることを確かめた |
| G4-1-02 | 【文書】 | H2-16（§6・見直しの入力）の (2) に、要素の位置の条件を書いた。Worker が既定値の段で飛ぶのは要素が現在の段かその後ろのとき、主スレッドの質量が `NaN` になるのは現在の段より後ろのときで、前の要素は影響しない |
| G4-1-03 | 【文書】 | R9 の段番号の正規化で値が変わる入力を書き直した。Worker の値が変わるのは、数にすると 0 と段数の間の小数になる値（`"0.5"` を含む。前は読込が途中で失敗した）と、`disableStaging` の機体で数にすると段数以上になる値（`"2"`・`[5]`・`true` を含む）の 2 つだけである。主スレッドは、正規の値でないすべての値を読込のときに Worker と同じ値に収める |
| G4-1-04 | 【文書】 | §3.1 の `resolveStackState` の正規化の記述を `normalizeStageIndex` にし、§3.2 の範囲外の段番号の描き方を正規化した段番号の規則（負と 1 未満の小数は第 1 段）にした。§3.10 の Worker の変更に段番号の正規化を加え、描画の変わる入力を 5 種類にした |
| G4-1-05 | 【文書】 | §5.5 のカバレッジに、本ブランチの行で通らないのは届かない守りだけであることと、変更したファイルに残る `main` からの通らない行を書き分けた。物理の不変の根拠を、`loadState` を d2・s2 が通らないことに直し、d2・s2 を Rev 26 のツリーで実行し直して一致を確かめた。計測の時点の記述を直した |
| G4-1-06 | 【文書】 | 見直しの入力の H1-15 の `gravsim_calc.js` の行番号を、本ブランチの L74-121 にした（`main` では L58-105） |

**既存の不具合（利用者の判断、2026-11-25）**: 独立監査4 Iteration 1 の注意 5 で、読込が保存ファイルの `totalStages` を検証せずにそのまま入れることがわかった（`main` と同じ。主スレッドの値が最初の Worker のフレームまで書き換えた値のままになり、そのあいだに保存すると書き戻される。予測線のイベントの印を挙げた最初の記述は、独立監査4 Iteration 2 の G4-2-04 で訂正した）。利用者の判断で本ブランチで直した（Rev 27）。読込は `totalStages` を読まず、段の配列から Worker と同じ数え方（段の配列がないか空なら 1）で決める。回帰 12 の書き換えた保存ファイルの試験に、2 段機の `totalStages` の 7 通り（5・0・−1・`"7"`・`null`・1・キーなし）と、段のない機体の 2 通りを加えた。保存ファイルの値を入れる・`null` でないときだけ入れる・正の数のときだけ入れる・段のない機体を 0 と数える、の 4 つの変異を検出する。
- 工程 4 の確認のやり直し（Rev 27）: 機械的チェックはエラー 0、全テスト 2,054 件合格（件数は変わらない。回帰 12 の既存の試験に入力を加えた）、カバレッジは行 99.52%・分岐 93.87%・関数 97.82%（変わらない）、描画の md5 と d2・s2 は同じ値である（§5.5）。

### 8.25 独立監査4 Iteration 2

監査は、PC の停止で中断し、再開して終えた（監査記録の節に記録がある）。

| 指摘 | 分類 | 対応 |
|---|---|---|
| G4-2-01 | 【実装】 | 回帰 12 の段数の試験を、入力ごとに期待する段番号を持つ表にし、段番号のない保存ファイル（段番号を消す、段番号を消して段数 7、両方を消す）の 3 通りを加えた。段数を入れる処理を段番号の分岐の中に移す変異（Rev 26 の形）を検出する。`gravsim_object_manager.js` の注記の「古い保存ファイル」を直した |
| G4-2-02 | 【実装】 | `testsuites/README.md` §5 のファイルごとの分岐の値の揺れの記述を、実測（`gravsim_tab_navi.js` の 100.00% と 95.12%、タイマーで動く更新による）に合わせた |
| G4-2-03 | 【文書】 | §5.5 のカバレッジで、`gravsim_preset_manager.js` の通らない行を `main` からある行に分類し直した。本ブランチの行で通らないのは `gravsim_calc.js` L61 だけである |
| G4-2-04 | 【文書】 | R9 の段数の項を Worker の変更の一覧から外し、主スレッドの読込の変更として書いた。古い保存ファイルについての誤り（`stages` と `totalStages` はどちらも 66d3687 から）を直し、保存が `totalStages` を書き続ける理由を書いた。§3.1 と §8.24 の注記の、段数を読む箇所を、予測線のイベントの印から保存（L617）に直した。§4 の回帰 12 と旧設計書の行、旧設計書 §3.5-1 の注記に段数の読込を加えた |
- 工程 4 の確認のやり直し（Rev 28、2026-11-26）: 機械的チェックはエラー 0、全テスト 2,054 件合格（件数は変わらない。回帰 12 の既存の試験の表に入力を加えた）、カバレッジは行 99.52%・分岐 93.88%・関数 97.82%、描画の md5 と d2・s2 は同じ値である（§5.5）。

### 8.26 独立監査4 Iteration 3（PASS（文書指摘あり））

| 指摘 | 分類 | 対応 |
|---|---|---|
| G4-3-01 | 【文書】 | R9 の段数の項に、最初の Worker のフレームの前（一時停止の中でロールアウトしてすぐ）に保存した多段機の保存ファイルを、値が変わる入力として加えた。このファイルは、主スレッドの `Rocket.totalStages` の初期値 1 を持つ（`main` と同じ）。前は読込の後も 1、今は段の配列の数になる。キーを消した保存ファイルの前の値（`Rocket` の初期値 1）と、保存が書く値（配置の後、最初のフレームの前では 1。読み込んだロケットでは読込で決めた段数）を書き添えた（解消の確認の指摘で、範囲を配置の後に限った。Rev 30）。`gravsim_object_manager.js` の `loadState` の注記も同じく直した |

任意の注意への対応: `gravsim_rocket_renderer.js` の、本ブランチで生じた連続する空行 2 か所（`_drawLowDetail`・`_drawFairing` の前）を 1 行にした。動作は変わらない。

**既存の不具合（利用者の判断、2026-11-26）**: 独立監査4 Iteration 3 の注意 2 で、配置した多段機の主スレッドの段数が最初の Worker のフレームまで初期値の 1 のままで、そのあいだの保存が 1 を書くことがわかった（`main` と同じ）。本ブランチの読込はこの値を読まないため、表示・物理に影響しない。直すと保存の中身が変わるため、利用者の判断で構造の見直しの入力に H2-17 として記録した（§6）。

**G4-3-01 の解消の確認（未解消、2026-11-26）への対応（Rev 30）**: 確認の指摘は、R9 の「最初の Worker のフレームの前の保存では 1 を書く」が、配置したばかりのロケットだけに当てはまることだった（読み込んだロケットは、読込で段数を決めるため、本ブランチでは段の配列の数を、`main` では読み込んだ値を書く）。R9 と §8.26 の記述を配置の後に限り、読み込んだロケットの場合を書き分けた。3 つの保存ファイルの前の値の書き出しを、(1)・(2) は保存ファイルの値、(3) は `Rocket` の初期値に分けた。

**解消の確認（2 回目）の付記への対応（Rev 31）**: 2 回目の確認は G4-3-01 を「解消」とし、判定に影響しない付記を 2 つ残した。(a) 前置きの「保存がその値を書き戻した」が、偽の値に書き換えた保存ファイルでは成り立たない。(b)「`main` は読み込んだ値」が、キーを消した保存ファイルを含まない。確認の節 §3 の文案どおりに直した。(a) と同じ言い回しが §3.1 の段数の記述にもあったため、同じく直した。
