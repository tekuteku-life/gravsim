# GravSim 設計書 (Rev 6.23): 軌道予測・ロケット演出・フライトプラン刷新および全体監査

- **作成日**: 2026-11-20（Gate 1 Iteration 1〜5 全指摘 F-01〜F-13, F2-01〜F2-08, F3-01〜F3-04, F4-01〜F4-02, F5-01〜F5-05 全統合・数値検証済 自己完結版 Rev 6） ／ Rev 6.1 補遺（§4、独立監査2 Iteration 1 指摘 G2-01〜G2-10 反映）: 2026-11-20 18:20 JST ／ Rev 6.2（§4.3 置き換え・§4.7 追補・§4.10〜4.12 新設、独立監査2 Iteration 2 指摘 G2-2-01〜G2-2-04 反映） ／ Rev 6.3（§4.3 保証・実測、§4.10 切替条件・実飛行経路の記録、§4.11 衝突抑止の削除、§4.12 周回数・予算、独立監査2 Iteration 3 指摘 G2-3-01〜G2-3-03 反映） ／ Rev 6.4（§4.3 保証 3・表、§4.10 回転量の数値、§4.12 安定周回の判定、独立監査2 Iteration 4 指摘 G2-4-01〜G2-4-03 反映） ／ Rev 6.5（§4.3 保証 3 のワールド条件・表、§4.12 第三天体の接近と影響域・受入基準、独立監査2 Iteration 5 指摘 G2-5-01〜G2-5-02 反映） ／ Rev 6.6（安定周回の打ち切り・延長表示を廃止し §4.3・§4.12 を置き換え、独立監査2 Iteration 6 指摘 G2-6-01〜G2-6-03 反映） ／ Rev 6.7（§4.3 保証 3・4 のワールド条件、§4.12 ステップ上限の適用範囲・下限の根拠、§4 ヘッダ、独立監査2 Iteration 7 指摘 G2-7-01 と Watchpoint 2・4・6・7 反映）: 2026-11-20 23:04 JST ／ Rev 6.8（§4.3 保証 2・4 (b)・表、§4.12 ステップ上限 340,000・1 ステップあたりの処理の削減・受入基準の統計量、独立監査2 Iteration 8 指摘 G2-8-01〜G2-8-03 反映）: 2026-11-21 03:11 JST（Rev 6.9 で日時を訂正。当初の記載 02:46 は、含めた計測より前の時刻だった） ／ Rev 6.9（§4.3 終了理由の表・保証 4 (b)、§4.12 計測方法の定義と実測の差し替え、独立監査2 Iteration 9（PASS（文書指摘あり））の文書指摘 G2-9-01〜G2-9-02 を工程 3 と並行して反映）: 2026-11-21 05:17 JST ／ Rev 6.10（工程 3 のテスト作成で判明した事項の反映。実装の修正: 自転角速度の単一源 `_getRotationOmega` とホールドダウン中の最終速度積分の省略（§3.1.1-2）、`FlightComputer` コンストラクタの軌道目標（§3.4-1）、フライトプランの無効な行の除去（§3.4-1）、予算オプションの数値化（§4.12）。記述を実装に合わせた訂正: `updateObject` の自転角・スロット 48 のフォールバック（§3.1.1）、気温の下限の注記・描画の `L` と LOD 既定値（§3.2・§3.3）、`ORBIT_ASSIST` の `!disableOrbitalCutoff`・トリガの表示名（§3.4）、保存項目と復元手順・継続の精度（§3.5-1・§4.7）、予測用ロケットの RCS タイマー（§4.12））: 2026-11-21 06:19 JST ／ Rev 6.11（独立監査3 Iteration 1（FAIL）の指摘 G3-1-01〜G3-1-09 と Watchpoint の反映。実装の修正: 保存・読込を挟んだ飛行のビット単位の継続（§4.7・§3.5-1。推力比・推進系・運動学・空力キャッシュ・FC の姿勢指令の保存、天体・デブリの実行時状態、投棄物の親ロケット、ペイロード分離後のパラメータ、乾燥質量 0・SRB 分離後の第 1 段乾燥質量。Rev 6.10 の継続の精度の記述を置き換え）、フライトプランの行の有限の数値の検証と表のセル編集（§3.4-1）。記述の訂正・明確化: 自転周期のプリセットの段と他の箇所との一致（§3.1.1-2）、整定タイマーをセットする分離とブースタ分離の順序（§3.2-2）、`L` の下限の理由（§3.2-3・§3.3-1）、気温の下限 180 K の注記（§3.3）、深宇宙サイジングの基準質量と高度の倍率（§3.4-3）、終了理由の表の式と点数予算の記述（§4.3）、余裕と比べる変動の定義（§4.12）、対象外とする既存の不具合（§4.13 新設））: 2026-11-21 09:16 JST ／ Rev 6.12（利用者の判断（2026-11-21）で、工程 3 で見つかった main と同じ既存の不具合を本ブランチの範囲に加えて修正。§4.13 を「本ブランチで修正した既存の不具合」に置き換え、1〜32 を記述: ホールドダウンの衝突・予測用 Worker のループ・予測の `steps`、時間倍率とズーム・予測期間・世界の中心の保存、スライダ・段表示・HUD・質量・SRB 表示、Rocket タブの開閉、状態の文字と正規化、アナンシエーターの使われない入力、カメラの対象、REF BODY、実時間、不具合の種類ごとの一括調査（Worker だけの項目・id 0・状態の正規化・基準天体）、「Sun は id 0」、`rocket:destroyed`、縮小表示の SRB、破壊されたロケットの選択、一覧に残る除去・破壊済みの物体、銀河中心。関係する §3.1.1-2・§3.4-1・§3.4-4・§3.5-1・§4.3・§4.7・§4.11 を改訂）／ Rev 6.13（最後に行った読み取りだけの不具合の探索の結果を main と比べ、本ブランチの退行と悪化を修正。§4.14 新設: 受動ペイロードの PAYLOAD CUTOFF、自走ペイロードの噴射の描画、予測線のイベントの印、Rocket タブのスライダの刻み、`SystemTab.loadState` の削除、読込後の音声の時計と相対高度、ホストが消えた射点のロケット、燃焼中の段を分離する `sep_*` の行の予測のイベント、射点で条件を満たす行、単段機の 2-STG-SEP。main と同じ既存の不具合は [構造の見直しへの入力](2026-11-21_architecture_redesign_inputs.md) に記録し、構造の見直し（別ブランチ）で直す）: 2026-11-22 00:51 JST ／ Rev 6.14（独立監査3 Iteration 2 の指摘 G3-2-01〜G3-2-05 を反映。§4.14-11〜13 新設: 音声のテレメトリのイベントのフラグ、銀河中心の後のプロファイル、世界の中心の判定と生きている物体の規則の走査。§4.13-27・-31・-32、§4.14-4・-6 (a)、§4.7 の継続の精度、§4 の見出しを改訂）: 2026-11-22 09:50 JST ／ Rev 6.15（独立監査3 Iteration 3 の指摘 G3-3-01〜G3-3-03 を反映。§4.14-14 新設: 利用者が空の世界に置いた天体の置き換え。§4.13-27 の置き換えの対象、§4.14-11 の燃焼時間の条件、§4.14-12 と §4.13-27 の遠くのロケット・デブリの制限、§4.14-13 (b) の走査の当たり、§4.14-11 の main との音声の列の条件を改訂）: 2026-11-22 13:21 JST ／ Rev 6.16（独立監査3 Iteration 4 の指摘 G3-4-01〜G3-4-02 を反映。§4.14-14 の置き換えの対象を種類から保存する役割の印 `isProfileWorldCenter` に改め、§4.13-27・§3.5-1 に印を追加。§4 の最終改訂の行、§4.14-11 の版の表記、§4.14-14 の main の恒星のボタンの記述を訂正）: 2026-11-22 14:23 JST ／ Rev 6.17（独立監査3 Iteration 5 の指摘 G3-5-01〜G3-5-02 を反映。§4.14-14 (c) と §3.5-1 に、旧形式のファイル（`isWorldCenter` がない）での印の読み方を明記）: 2026-11-22 15:29 JST ／ Rev 6.18（独立監査3 Iteration 6 の指摘 G3-6-01（【文書】）を反映。テスト計画 §4.2 の役割の印の変異の内訳（31 件 = 検出 24 件 + 等価 7 件）を訂正。設計の内容は変えない）: 2026-11-22 16:06 JST ／ Rev 6.19（工程 4 の同期ブロック時間の計測で、別のプロジェクトの処理が計測の途中で負荷を上げ、負荷の条件を満たせなかったため、§4.12 に分割実行（`--state`）を追加。計測する構成・回数と順序・負荷の条件・統計量・余裕・受入基準は変えない）: 2026-11-22 19:56 JST ／ Rev 6.20（独立監査4 Iteration 1（FAIL）の指摘 G4-1-01〜G4-1-03 を反映。計測スクリプトの修正: 受入基準 2 を本ブランチの全構成から求め、回ごとに両ツリーの構成がそろっていることを計測した回と保存した回で検査し、オプションの値を検査する（G4-1-02）。`unit/11` に変動の後半・計測コードの指紋・既定の上限・計測のループ（模擬のモジュールのツリー）・不正な状態ファイルのテストを追加（G4-1-01）。§4.12 の分割実行の記述を補い、作業領域の道具の場所を明記（G4-1-03。テスト計画 §4.2 の変異 F27 の対象の訂正を含む）。計測コード（`runChild`・`measure`・構成の定数）は変えず、保存した 21 回を計測せずに再評価して値が変わらないことを確かめた）: 2026-11-23 06:30 JST ／ Rev 6.21（独立監査4 Iteration 2（FAIL）の指摘 G4-2-01〜G4-2-03 を反映。計測スクリプトの修正: 受入基準 1 で main の最小値が正でない構成を無限大の比とする（G4-2-02）、`--rounds-heavy`・`--rounds` を整数として検査する、テスト用の負荷をファイルからも読む。`unit/11` に、計測のループが記録した先後どおりに各ツリーをそのツリーとワールドで測ること、負荷の標本の時点、受入基準 2 だけの不成立の終了コード、回数の下限、既定のワールドと方位、出力の書式のテストを加え、判定側の全行への機械的な変異で取りこぼしを確かめた（G4-2-01）。テスト計画 §5 の E2E の残りの数え方の説明と時刻の範囲を訂正（G4-2-03）。計測コードは変えず、保存した 21 回の再評価の値は変わらない）: 2026-11-23 07:33 JST ／ Rev 6.22（独立監査4 Iteration 3（FAIL）の指摘 G4-3-01〜G4-3-03 を反映。`unit/11` の子プロセスの起動に時間制限を付け、止まった子プロセスを `npm test` の停止ではなくテストの失敗にする（G4-3-01）。1 分平均の負荷を `os.loadavg` の差し替えで確かめるテストを加え、テスト計画 §5 の変異の残りの理由を訂正（G4-3-02）。指紋の区切りのコメントを訂正（G4-3-03）。工程 4 の再実行の `npm test` の 1 回で E2E の最初のクリックが音声デバイスのエラーとともに 20 s 止まったため、E2E の Chromium を偽の音声出力（`--disable-audio-output`）で起動する（テスト計画 §5 の経緯の 5）。設計の内容と計測コードは変えない）: 2026-11-23 08:39 JST ／ Rev 6.23（独立監査4 Iteration 4（PASS（文書指摘あり））の文書指摘 G4-4-01 を反映。テスト計画 §4.1 の `unit/11_perf_rollout_timing` の件数を 51 件から 52 件に訂正（内訳 26 + 16 + 9 + 1 と全 1,636 件に合わせる）。設計の内容は変えない）: 2026-11-23 09:21 JST
- **対象ブランチ**: `feat/trajectory-fx-flightplan`
- **準拠プロセス**: [docs/development_process.md](../development_process.md)

---

## 1. 要求事項と設計方針（あるべき姿）

場当たり的な修正・実装時への仕様先送り・曖昧な省略表記をすべて排除し、物理エンジン（Worker）・通信ブリッジ・予測シミュレーション・描画・UI・永続化を単一責任・確定数式・全既存テスト互換ガードの下で設計する。

| # | 要求事項 | 確定アーキテクチャ |
|---|---------|-------------------|
| 1 | ロケット打ち上げ時・予測線のジグザグ防止 | 1) 主スレッド `Universe` L182–193 の非同期自転角積分を撤去し、`CalcCelestialBody.rotationAngle` を `PhysicsEngine` / `PredictorPhysicsEngine` 単一源へ統合、`_moveObjects(dt)` 内に `_updateHoldDownPositions(dt)`（＋終端速度再同期）を内蔵しサブステップ位相差を解消。<br>2) `ObjectManager.updateObjectParams` を2パス化し（Pass 1: `_cache` 参照を残さず実体へ反映＋新規 `Debris` 生成 → Pass 2A: 未衝突対象の `target.updateHistory(this.physicsSequence, this.objects, isPaused)` 一斉実行 → Pass 2B: `setCollided` / 破砕処理実行）、加えて `Rocket._recordActualFlightPath` L500/L539 の末尾点欠落バグを是正。<br>3) 予測サンプリングを `TRAJECTORY_PREDICTION.SAMPLING` にて位置角・速度方位角 (`HEADING_DELTA_RAD`)・遠近点通過・残余点予算下限 (`hardBudgetFloorDt`) で 0.2〜36ヶ月完走（`1200s` で `> 500` 点維持）とし、衝突点重複除去をループ外メートル変位比較へ一元化、`TrajectoryPredictor` & `TrailRenderer` を先減算精密式へ統一。 |
| 2 | コールドガス RCS アニメーション再現 | `FlightComputer._computeThrustAngle` で `INTERSTAGE_COAST` 姿勢整合＋更新前目標角 `desiredThrustAngleRad` を確定。`CalcRocket` はステージング遷移後の `_updateRcsState` にて `(this.isHoldDown || this.collided || this.shattered)` 停止ガード・パルス／連続判定・`INTERSTAGE_COAST` 末尾 `(ignDelay - this.stgTimer) <= 1.5s` / 再点火沈降から `ROCKET_FLAG` (`RCS_CW/CCW/ULLAGE`) を発行し、`WorkerBridge` → `_applyRocketState` 同期を経て `RocketRenderer._computeVisualLayout`（`+X` 機首・`+Y` CW 側・単体 `0.85 * payloadR`）の確定座標・ベクトルで噴流を描画する。 |
| 3 | 遷音速域の衝撃波ベイパーコーンアニメーション再現 | 実在定数 `ATM_DENSITY_0`, `ATM_SCALE_HEIGHT`, `ATM_LIMIT_ALT` を用いる `AeroUtils` に気温プロファイル $T(h)$・音速・マッハ数・Prandtl-Glauert 強度／クランプ幅式を集約、`applyAerodynamics` ゼロ速度 return 前と基底/サブクラス両 `clearAerodynamicParameters` で `mach = 0` を確実クリア、`TM_MACH` 経由で `target.mach` と `target.telemetry.mach` へ同期し、`SoundEffects` L346 の `/ 340.0` を共通計算へ統一する。 |
| 4 | フライトプラン修復＋1段/2段/ペイロード切り離しタイミング設定 | `0°`=天頂（垂直）・`90°`=ローカル水平の実在規約の下で全7ミッション個別プロファイル表を確定（`iss_rendezvous` 8行維持、`lunar_insertion` `pe: 250` 維持）、`disableOrbitalCutoff` / `targetApogeeKm` / `targetPerigeeKm` / `targetVInfKmS` と `vel`/`apogee` トリガ・`action`（`sep_stage1`, `sep_stage2`, `sep_payload`）を全経路へ貫通。検証済 `FlightComputer` `ORBIT_ASSIST`（ISS 5/5・LEO 6/6・GTO・Lunar 合格）＋全機体（SRB/非SRB）連動深宇宙サイジング＋Deferred Auto-Staging/Orbital Hold＋UI 6列テーブル（320px適合）＋スライダ `max` 全3箇所同期を完備。 |
| 5 | 全体不具合・横展開是正・デッドコード削除 | `AERO_DYNAMIC` 未 import、`determineOptimalSubSteps` 欠落、`tmPayloadSeparated`/`tmBurnTime` タイポ、部分モック互換ガード、`WorkerBridge` `OBJ_ATTR_COUNT = 51` と `getState`/`loadState`＋`CalcRocket` 完全復元、`InfoPanel` 型互換、`SaveManager` ガード、デッドコード削除、機械チェック 0 エラー＋Chrome E2E＋異常/境界テスト＋97% カバレッジ目標を達成する。 |

---

## 2. システム全体のデータフロー

```
presets/celestials/*.json (ATM_DENSITY_0, ATM_SCALE_HEIGHT, ATM_LIMIT_ALT, ROTATION_PERIOD)
presets/missions/*.json + vehicles/*.json + payloads/*.json + visuals/rocket.json
        │
        ▼
[PresetManager] ── calculateMissionFlightPlan()（深宇宙増槽＋非SRB/SRB両方の離床/コアTWR保証＋_adaptFlightProfileForVehicle互換）
        │              └─ applyToLauncher(launcher, { vehicleId, payloadId, missionId, applyRecommendedMission })
        ▼
[RocketLauncher] ── state/context/cacheKey に 4ターゲット + vehicle/payload/missionId + flightProfile(action/vel) 全包含
   ├──▶ [TrajectoryPredictor / gravsim_calc_predictor.js]
   │        └─ 適応サンプリング(3000点予算保証) + 全通過段sep検出 + vel基準統一 + 先減算高精度描画
   └──▶ [ObjectPlacer / ObjectManager._buildRocketPayload] ──▶ [Physics Worker]
                                                                   ├── CalcCelestialBody.rotationAngle を物理dt統合＋ホールドダウン同期
                                                                   ├── FlightComputer: 独立アクションラッチ + vel/apogee + 慣性ORBIT_ASSIST
                                                                   ├── CalcRocket: AeroUtilsマッハ(0クリア) + 遷移後RCS/Ullage + Deferred分離 + !isPayloadSeparated境界V∞
                                                                   ▼
                                                             [WorkerBridge (OBJ_ATTR_COUNT = 51, 全スロット明示書込)]
                                                                   ▼
                                                             [ObjectManager.updateObjectParams (Two-Pass Atomic Commit)]
                                                                   ├── Pass 1: _cache反映(null/undefinedガード・RCS/stageState/fairing同期) + Debris生成
                                                                   ├── Pass 2A: historyTargets.updateHistory(this.physicsSequence, this.objects, isPaused)
                                                                   └── Pass 2B: pendingDestructions (setCollided / 破砕) 実行
```

---

## 3. 要件別 詳細設計仕様

### 3.1 [要件1] 軌道線・予測線ジグザグ防止

#### 3.1.1 バッファ拡張・自転角 SSOT・ホールドダウン同期・2パス原子的コミット
1. **`gravsim_const.js` & `gravsim_worker_bridge.js` (`OBJ_ATTR_COUNT = 51`)**:
   - `BUFFER_INDEX`: `ROTATION_ANGLE: 47`, `TM_MACH: 48`, `STAGE_STATE_CODE: 49`, `STG_TIMER: 50`、`CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT: 51`。
   - `ROCKET_FLAG`: `RCS_CW: 1 << 16`, `RCS_CCW: 1 << 17`, `RCS_ULLAGE: 1 << 18`, `HAS_PAYLOAD_PROP: 1 << 19`（符号付き 32bit 安全域内）。
   - `STAGE_STATE_TO_CODE = Object.freeze({ PRE_LAUNCH: 0, STG_BURNING: 1, STG_MECO: 2, INTERSTAGE_COAST: 3, STG_COAST: 4, ORBITAL_COAST: 5 })` / `CODE_TO_STAGE_STATE = Object.freeze(['PRE_LAUNCH', 'STG_BURNING', 'STG_MECO', 'INTERSTAGE_COAST', 'STG_COAST', 'ORBITAL_COAST'])`。
   - `WorkerBridge.formatWorkerToMain`: 再利用プール汚染を完全に防ぐため全オブジェクト種別についてスロット `47..50` および未使用箇所を毎回明示上書き（天体は `ROTATION_ANGLE = obj.rotationAngle || 0`・他 `0`、ロケットは `47 = 0`, `48 = obj.mach ?? flightComputer のテレメトリの mach ?? 0`（Rev 6.10 で記述を実装に合わせた。Worker 側の `CalcRocket` に `telemetry` はなく、`CalcRocket.mach` は常に数値のためフォールバックには通常到達しない）, `49 = STAGE_STATE_TO_CODE[obj.stageState] ?? 0`, `50 = obj.stgTimer || 0`、デブリ/その他は `47..50` すべて `0`）。
   - `WorkerBridge.parseWorkerToMain`: `rotationAngle`, `mach`, `stageState` (`CODE_TO_STAGE_STATE[Math.round(code)] || 'PRE_LAUNCH'`), `stgTimer`, `rcsCw`, `rcsCcw`, `rcsUllage`, `hasPayloadPropulsion` を抽出。
2. **自転角統合・ホールドダウンサブステップ整合 (`gravsim_calc.js`, `gravsim_calc_predictor.js`, `gravsim_object_manager.js`, `gravsim_universe.js`)**:
   - `ObjectManager.addObject`（`CELESTIAL` 分岐）は `rotationAngle: Number.isFinite(obj.rotationAngle) ? obj.rotationAngle : 0` を送信する。`ObjectManager.updateObject` は、天体で `rotationAngle` が有限のときだけ送信し、それ以外は項目を省く（Worker 側の自転角を 0 に戻さず保つ。Rev 6.10 で記述を実装に合わせた）。
   - `PhysicsEngine.addObject(data)` と `PhysicsEngine.updateObject(data)`（`L116–128`）の両方で `if (Number.isFinite(data.rotationAngle)) obj.rotationAngle = data.rotationAngle;` と `rotationPeriod` を反映。
   - 自転の角速度は `PhysicsEngine._getRotationOmega(body)` を単一源とし、天体の自転角の積分とホールドダウンの同期の両方がこれを使う（Rev 6.10。ホールドダウン側が `param.ROTATION_PERIOD` だけを見ていたため、周期が `rotationPeriod` だけにある場合などに射点が地表からずれた）。`_updatePositionAndHalfVelocity(dt)`（および `PredictorPhysicsEngine` 同等ステップ）内で、`CalcCelestialBody` の自転角を `rotPeriod = obj.param?.ROTATION_PERIOD ?? obj.rotationPeriod ?? this.getCelestialParam(obj.name)?.ROTATION_PERIOD ?? 0`（Rev 6.11 でプリセットの段を追記、G3-1-06・G3-1-09。`getCelestialParam(name)` は `initDefinitions` で受け取った `celestialParams[name]`、なければ `presetManager.getObjectParam(name)`。各段は `null`/`undefined` のときだけ次へ進み、`0`・`NaN`・文字列などはその段で確定する）に対し `if (Number.isFinite(rotPeriod) && Math.abs(rotPeriod) > 1e-6) obj.rotationAngle = (obj.rotationAngle || 0) + ((2 * Math.PI) / rotPeriod) * dt;` として積分。
   - 他の箇所との一致（Rev 6.11、独立監査3 Iteration 1 Watchpoint 4）: 主スレッドの初速（`RocketLauncher`）・予測の設定（`TrajectoryPredictor._buildSimulationParams`）、Worker の誘導の対地速度（`FlightComputer`）・空力の大気速度（`CalcRocket.applyAerodynamics`）・予測のホスト角速度（`runMultiBodySimulation`）は、`param`（なければ名前でプリセット）の `ROTATION_PERIOD` を使う。`PhysicsEngine.addObject` は `param = data.param || getCelestialParam(name)`、`rotationPeriod = data.rotationPeriod ?? param?.ROTATION_PERIOD ?? 0` とし、主スレッドは `add` に `rotationPeriod` を入れない。このため `_getRotationOmega` の第 1 段はこれらの箇所と同じ値になり、`param` に `ROTATION_PERIOD` がない場合（保存データを手で書き換えた場合など）は全箇所で 0 になる。第 2・3 段が効くのは `updateObject` で `rotationPeriod` を個別に書き換えた場合（アプリは行わない）だけで、そのときは他の箇所と一致しない。
   - **ホールドダウン完全同期 (`gravsim_calc.js:436–464, 897–900`)**:
     - `_updatePositionAndHalfVelocity(dt)` と `_updateFinalVelocity(dt)` では `obj.isHoldDown === true` のロケットに対する自由推進・重力速度積分をスキップ（ホストが存在する間だけ。ホストがなければ通常の積分。Rev 6.13、§4.14-7）。
     - `_moveObjects(dt)` 内で `_updatePositionAndHalfVelocity(dt)` 直後に `this._updateHoldDownPositions(dt)` を呼び、さらに `_updateFinalVelocity(dt)` の直後に `isHoldDown` ロケットの位置/速度 (`host.vx - omega * dy`, `host.vy + omega * dx`) を最終再同期する（`SimulationController` L898 側の移動前呼出を削除、既存単体呼び出し互換維持）。
     - フレームごとの衝突判定（`SimulationController.update()` の `_checkCollisions(totalDt)`）では、ホールドダウン中のロケットとそのホストの組を除く（Rev 6.12、§4.13-1）。
   - `gravsim_universe.js` L182–193 のメインスレッド旧 `rotationAngle` 更新ループを削除。
3. **2パス原子的 `ObjectManager.updateObjectParams` (`gravsim_object_manager.js`)**:
   - Pass 1: `_cache` 参照配列を作らず実インスタンスへ即時反映（新規自動生成対象は `OBJECT_TYPES.DEBRIS` のみ）。`_applyBaseState` に `if (Number.isFinite(objData.rotationAngle)) { target.rotationAngle = objData.rotationAngle; }` ガード。衝突/破砕対象は `pendingDestructions`、他は `historyTargets` へ積む。
   - Pass 2A: `for (const target of historyTargets) { target.updateHistory(this.physicsSequence, this.objects, isPaused); }`。
   - Pass 2B: `for (const ev of pendingDestructions) { /* setCollided / shatter 処理 */ }`。
4. **`Rocket._recordActualFlightPath` L500 / L538–539 間引き末尾欠落バグ修正 (`gravsim_object.js`)**:
   - `push` 後の現在長を用いるため、間引きコールバック内判定を `idx === arr.length - 1` とし、最新点を常に保持する。

#### 3.1.2 予測線 3000 点予算両立サンプリング・終端点整理・精度統一
- `TRAJECTORY_PREDICTION.SAMPLING`: `HEADING_DELTA_RAD: 0.035`, `MIN_HEADING_SPEED_M_S: 5.0`, `TIME_HEADING_COAST_S: 2.5`, `TIME_APSIDAL_COAST_S: 2.0`, `MIN_SAMPLE_DT_S: 0.05`, `MIN_SAMPLE_DISPLACEMENT_M_SQ: 1e-4`, `BUDGET_SOFT_THRESHOLD_RATIO: 0.55`。削除: `RENDER.PREDICTED_TRAJECTORY.COLOR_ORBIT`, `COLOR_FALL`（L268–269）。
- `gravsim_calc_predictor.js`:
  - `scaledCoastSampleTime = Math.max(baseCoastSampleTime, maxSimTime / (maxPoints * 0.45))`
  - `baseNearBodyDt = (maxSimTime > 86400 * 3) ? Math.max(nearBodyTimeThreshold, maxSimTime / (maxPoints * 0.65)) : nearBodyTimeThreshold`
  - `hardBudgetFloorDt = (points.length > maxPoints * 0.55) ? ((maxSimTime - simTime) / Math.max(1, maxPoints - points.length - 1)) * 0.85 : 0`
  - 時間 / 位置偏角 (`ANGLE_DELTA_RAD`) / 速度方位角 (`HEADING_DELTA_RAD`) / 遠近点通過 (`prevVv * vV <= 0`) / 近傍天体 / 燃焼境界 (`isBurning !== prevSampledBurning`) でサンプリング（`1200s` で **970 点 (> 500)**、12〜36ヶ月で **2,494〜2,533 点 (< 3000 完走)** 実測確認済）。
  - ループ内衝突 `points.push` (L370–381) 削除、ループ後 (L590) のみに **メートル座標** 変位 `(finalRelX_m - lastSampleRelX_m)**2 + (finalRelY_m - lastSampleRelY_m)**2 >= 1e-4` かつ `simTime > lastSampleTime + 1e-6` の単一最終点追加を配置。
- `gravsim_trajectory_predictor.js` ＆ `gravsim_trail_renderer.js` L233–239: `((hostObj.x - basis.x) + localRelX) * zoomScale` 順へ統一、重複 `render()`（`gravsim_trajectory_predictor.js:893–895`）を削除。

---

### 3.2 [要件2] コールドガス RCS アニメーション再現

1. **定数・フラグ (`scripts/gravsim_const.js`)**:
   ```js
   export const RCS_CONFIG = Object.freeze({
       ATTITUDE_DEADBAND_RAD: 0.015,
       SLEW_CONTINUOUS_RAD: 0.08,
       LOW_AERO_PRES_RATIO: 0.35,
       PULSE_PERIOD_S: 0.45,
       PULSE_DUTY: 0.42,
       POST_SEP_SETTLE_S: 2.5,
       POST_SEP_DAMP_PERIOD_S: 0.35,
       POST_SEP_DAMP_PULSE_S: 0.09,
       ULLAGE_PRE_IGNITION_S: 1.5,
       ULLAGE_POST_COAST_S: 1.2
   });
   ```
2. **`FlightComputer` と `CalcRocket._updateRcsState` 完全ロジック (`scripts/gravsim_flight_computer.js`, `scripts/gravsim_calc_object.js`)**:
   - `FlightComputer._computeThrustAngle`: **`sensor.stageState === 'INTERSTAGE_COAST'` をコースト追従 (`progradeAngle`) へ統合**し、毎ステップ `this.desiredThrustAngleRad` を保存。
   - `CalcRocket.flightControl`: `flightComputer.update` 直前角 `const preUpdateAngle = this.thrustAngle;` を保存し、`L1128–1163`（`STG_COAST -> STG_BURNING` 再点火時 `this._ullageRestartTimer = RCS_CONFIG.ULLAGE_POST_COAST_S` セット、分離時 `this._postSepRcsTimer = RCS_CONFIG.POST_SEP_SETTLE_S` セット含む）完了の**直後**に `_updateRcsState(dt, currentThrustN, preUpdateAngle)` を実行。整定タイマーは、段分離 `separateCurrentStage`・フェアリング分離 `separateFairing`・ブースタ分離 `separateBoosters`・ペイロード分離 `separatePayload` のいずれでもセットする。ブースタ分離はブースタの状態機械（燃焼処理の後、`_updateRcsState` の後）で行うため、ブースタの整定窓は分離の次のステップから始まる（窓の長さは同じ。RCS の表示だけの差で、物理には影響しない。ブースタの状態機械を前に移すと推力の更新順が変わり飛行結果が変わるため、この順序を維持する。Rev 6.11、独立監査3 Iteration 1 の修正で確認）。
   - **`_updateRcsState` 詳細式・符号規約**:
     - `this._postSepRcsTimer = Math.max(0, (this._postSepRcsTimer || 0) - dt);`
     - `this._ullageRestartTimer = Math.max(0, (this._ullageRestartTimer || 0) - dt);`
     - 停止ガード：**`if (this.isHoldDown || this.collided || this.shattered) { this.rcsCw = false; this.rcsCcw = false; this.rcsUllage = false; /* telemetry同期 */ return; }`**
     - 符号規約：Canvas 回転角 $\theta$ 増加方向 (`+Δθ`) が時計回り (CW)、減少方向 (`-Δθ`) が反時計回り (CCW)。よって `targetAngle = this.autoControl ? (this.flightComputer?.desiredThrustAngleRad ?? preUpdateAngle) : preUpdateAngle;` に対し、`const err = MathUtils.normalizeAngle(targetAngle - preUpdateAngle);` が **`> +ATTITUDE_DEADBAND_RAD` → `rcsCw`、` < -ATTITUDE_DEADBAND_RAD` → `rcsCcw`**。
     - 作動条件：`const allowRcs = (this.ambientPresRatio <= RCS_CONFIG.LOW_AERO_PRES_RATIO) || (currentThrustN <= 0) || (Math.abs(err) > RCS_CONFIG.SLEW_CONTINUOUS_RAD) || (this._postSepRcsTimer > 0);`
     - デューティサイクル式：`const tPulse = this.flightComputer?.flightTime || 0; const pulseOn = (tPulse % RCS_CONFIG.PULSE_PERIOD_S) < (RCS_CONFIG.PULSE_PERIOD_S * RCS_CONFIG.PULSE_DUTY);`
       - `let rcsCw = false; let rcsCcw = false;`
       - If `allowRcs`:
         - If `err > RCS_CONFIG.ATTITUDE_DEADBAND_RAD`: `rcsCw = (err >= RCS_CONFIG.SLEW_CONTINUOUS_RAD || this._postSepRcsTimer > 0) ? true : pulseOn;`
         - Else if `err < -RCS_CONFIG.ATTITUDE_DEADBAND_RAD`: `rcsCcw = (-err >= RCS_CONFIG.SLEW_CONTINUOUS_RAD || this._postSepRcsTimer > 0) ? true : pulseOn;`
         - Else if `this._postSepRcsTimer > 0`: 整定交互ダンピング（`const phase = this._postSepRcsTimer % RCS_CONFIG.POST_SEP_DAMP_PERIOD_S; rcsCw = phase < RCS_CONFIG.POST_SEP_DAMP_PULSE_S; rcsCcw = phase >= 0.175 && phase < (0.175 + RCS_CONFIG.POST_SEP_DAMP_PULSE_S);`）。
     - **Ullage 判定**: `const nextStage = this.stages[this.currentStageIndex]; const ignDelay = nextStage?.ignitionDelaySec ?? MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC;` に対し、`const rcsUllage = (this.stageState === 'INTERSTAGE_COAST' && (ignDelay - this.stgTimer) <= RCS_CONFIG.ULLAGE_PRE_IGNITION_S) || (this._ullageRestartTimer > 0);`。
     - `this.rcsCw = rcsCw; this.rcsCcw = rcsCcw; this.rcsUllage = rcsUllage;` および `flightComputer.telemetryCache`（`rcsCw`, `rcsCcw`, `rcsUllage`）へ保存、`WorkerBridge` で `ROCKET_FLAG.RCS_*` 梱包・展開。
   - **`ObjectManager._applyRocketState` 同期（F5-02 #4）**:
     ```js
     if (objData.rcsCw !== undefined) { target.rcsCw = Boolean(objData.rcsCw); if (target.telemetry) target.telemetry.rcsCw = target.rcsCw; }
     if (objData.rcsCcw !== undefined) { target.rcsCcw = Boolean(objData.rcsCcw); if (target.telemetry) target.telemetry.rcsCcw = target.rcsCcw; }
     if (objData.rcsUllage !== undefined) { target.rcsUllage = Boolean(objData.rcsUllage); if (target.telemetry) target.telemetry.rcsUllage = target.rcsUllage; }
     ```
3. **JSON スキーマ・`RocketRenderer` 確定座標・ノズル幾何表 (`presets/visuals/rocket.json`, `PresetManager._seedFallbacks()`, `scripts/gravsim_rocket_renderer.js`)**:
   - **`COLD_GAS_RCS` 完全スキーマ**（`rocket.json` & `_seedFallbacks()` 共通）：
     ```json
     "COLD_GAS_RCS": {
       "FWD_STATION_FRACTION": 0.84,
       "AFT_STATION_FRACTION": 0.14,
       "PLUME_LEN_WIDTH_RATIO": 2.4,
       "MIN_PLUME_PX": 4.0,
       "PLUME_SPREAD_RAD": 0.34,
       "ULLAGE_CANT_RAD": 0.28,
       "CORE_COLOR": "rgba(235, 248, 255, 0.85)",
       "MIST_COLOR": "rgba(195, 228, 255, 0.28)"
     }
     ```
   - **`RocketRenderer` ローカル座標定義**: `ctx.rotate(rocket.thrustAngle)` 下で `+X` = 機首（前）、`-X` = 機尾（後）、`+Y` = CW (`+Δθ`) 側、`-Y` = CCW (`-Δθ`) 側。
   - `_computeVisualLayout(rocket, screenRadius, visualCfg)`: 現在段構成・ペイロード単体時（`_drawPayloadSatellite` L375–383 準拠 `xMin = -0.70 * payloadR, xMax = +0.70 * payloadR, halfWidth = 0.85 * payloadR`）の `{ xMin, xMax, halfWidth }` を一貫算出。
   - **ノズル座標・噴射方向ベクトル確定表 (`L = Math.max(1, layout.xMax - layout.xMin)`（Rev 6.10 で実装に合わせた。Rev 6.11 で理由を訂正、G3-1-05: `L` は除数ではなく位置の倍率である。下限 1 px により、長さが 0 または負（`xMax ≤ xMin`）の退化した配置でも、各ステーションは `xMin` から機首側へ `0.14 < 0.44 < 0.72 < 0.84`（× `L` ≥ 1 px）の順に並び、前方ノズル `xFwd` は後方ノズル `xAft` より `0.70 L` ≥ 0.70 px 前に来るため、CW/CCW の偶力の向きは表のとおりに保たれる。下限がないと、長さ 0 では前後のノズルが重なって CW と CCW が同じ描画になり、負の長さでは前後が入れ替わって偶力の向きが逆になる。0 < 長さ < 1 px では位置が `xMax` より前（機体の外）に出る。出荷する設定では LOD しきい値での最小の長さが 3.08 px（3 段機のペイロード単体、`0.55 × 1.40 × 4`）のため、下限は効かない。`NaN` は防がない）, `xFwd = layout.xMin + L * 0.84`, `xAft = layout.xMin + L * 0.14`, `yWall = layout.halfWidth`, `screenRadius >= LOD_RADIUS_THRESHOLD` 時描画)**:
     | Active Bit | Nozzle 1 Position | Nozzle 1 Jet Unit Vector | Nozzle 2 Position | Nozzle 2 Jet Unit Vector | Physical Effect |
     |---|---|---|---|---|---|
     | `rcsCw` | `(xFwd, -yWall)` | `(0, -1)` (`-Y` jet -> `+Y` force on nose) | `(xAft, +yWall)` | `(0, +1)` (`+Y` jet -> `-Y` force on tail) | Pure CW (`+Δθ`) Couple |
     | `rcsCcw` | `(xFwd, +yWall)` | `(0, +1)` (`+Y` jet -> `-Y` force on nose) | `(xAft, -yWall)` | `(0, -1)` (`-Y` jet -> `+Y` force on tail) | Pure CCW (`-Δθ`) Couple |
     | `rcsUllage` | `(xAft, +yWall)` | `(-cos(0.28), +sin(0.28))` | `(xAft, -yWall)` | `(-cos(0.28), -sin(0.28))` | Axial `+X` Ullage Settling |

---

### 3.3 [要件3] 遷音速域の衝撃波ベイパーコーンアニメーション再現

1. **`AeroUtils` 完全数式 (`scripts/gravsim_utils.js`, `AERO_DYNAMIC` in `gravsim_const.js`)**:
   - 大気定数読取: `density0 = Number(atmParam?.ATM_DENSITY_0 ?? atmParam?.atmDensity0 ?? 0)`, `scaleH = Number(atmParam?.ATM_SCALE_HEIGHT ?? atmParam?.atmScaleHeight ?? 0)`, `limitAlt = Number(atmParam?.ATM_LIMIT_ALT ?? atmParam?.atmLimitAlt ?? 0)`。
   - 無効/無大気ガード: `if (!Number.isFinite(altM) || !(density0 > 0 && scaleH > 0) || (limitAlt > 0 && altM > limitAlt)) return 0;`
   - **大気温度プロファイル `getAtmosphericTemperatureK(altM, atmParam)`**:
     ```js
     const clAlt = Math.max(0, altM);
     const scaleRatio = scaleH / 8500;
     const tropopauseM = 11000 * scaleRatio;
     const rawT = (clAlt <= tropopauseM)
         ? (288.15 - (0.0065 / scaleRatio) * clAlt)
         : (216.65 + 0.001 * ((clAlt - tropopauseM) / scaleRatio));
     return Math.max(180, Math.min(350, rawT));
     ```
     - 注記（Rev 6.10。Rev 6.11 で訂正、G3-1-04）: ラプス率 `0.0065 / scaleRatio` が有限であれば、生の気温の最小は対流圏界面の 216.65 K で、スケールハイトによらない。下限 180 K のクランプが効くのは、スケールハイトが約 3.07e-307 m 以下で `0.0065 / scaleRatio` が `Infinity` に桁あふれする場合だけである。このとき 0 < 高度 ≤ 対流圏界面（`11000 × scaleRatio` m）では生の気温が −∞ になり、180 K（音速 `sqrt(1.4 × 287.05 × 180)` = 268.95 m/s）を返す。同じ条件で高度 0 以下では `clAlt = 0` のため `Infinity × 0` で気温が `NaN` になるが、音速とマッハ数は 0 を返すため、物理と描画に `NaN` は伝わらない。`NaN` になるのはこの場合だけである（スケールハイトが約 2.1e-320 m 以下で `scaleRatio` が 0 になると対流圏界面も 0 になり、0 < 高度では 350 K）。実在のプリセットではいずれも起きない（防御的な上下限として残す）。
   - **音速・マッハ数**:
     `getSpeedOfSound(altM, atmParam) = (T > 0) ? Math.sqrt(1.4 * 287.05 * T) : 0;`
     `computeMach(airSpeedMS, altM, atmParam) = (Number.isFinite(airSpeedMS) && airSpeedMS > 0 && a > 0) ? (airSpeedMS / a) : 0;`
   - **SSOT 定数 (`AERO_DYNAMIC` in `gravsim_const.js`)**: `TRANSONIC_MACH_MIN: 0.82`, `TRANSONIC_MACH_MAX: 1.22`, `TRANSONIC_PEAK_MACH: 1.00`, `TRANSONIC_MIN_PRES_RATIO: 0.015`。
   - **凝縮強度・マッハ角・描画寸法 `computeVaporConeParams(mach, ambientPresRatio)`**:
     - 不成立時 (`!Number.isFinite(mach) || !Number.isFinite(ambientPresRatio) || mach < TRANSONIC_MACH_MIN || mach > TRANSONIC_MACH_MAX || ambientPresRatio <= TRANSONIC_MIN_PRES_RATIO`) → `{ active: false, intensity: 0, machAngleRad: Math.PI / 2 }`。
     - 成立時:
       ```js
       const halfSpan = Math.max(0.01, (AERO_DYNAMIC.TRANSONIC_MACH_MAX - AERO_DYNAMIC.TRANSONIC_MACH_MIN) * 0.5); // 0.20
       const u = Math.max(0, 1 - Math.abs(mach - AERO_DYNAMIC.TRANSONIC_PEAK_MACH) / halfSpan);
       const machFactor = u * u * (3 - 2 * u); // Smoothstep bell: 0 at 0.82/1.22, 1.0 at 1.00
       const presFactor = Math.min(1, Math.max(0, (ambientPresRatio - AERO_DYNAMIC.TRANSONIC_MIN_PRES_RATIO) / 0.25));
       const intensity = machFactor * presFactor;
       const machAngleRad = Math.asin(Math.min(0.96, 1 / Math.max(1 / 0.96, mach))); // max ~73.74 deg
       ```
     - `RocketRenderer.drawVaporCone(ctx, rocket, layout, visualCfg)` 描画寸法式 (`active && intensity > 0.01 && screenRadius >= LOD_RADIUS_THRESHOLD` 時):
       - `L = Math.max(1, layout.xMax - layout.xMin)`（Rev 6.10 で実装に合わせた。下限の意味は §3.2-3 と同じで、主コーンの頂点 `0.72 L` と副コーンの頂点 `0.44 L` が `xMin` より前に、主が副より前に並ぶ。Rev 6.11、G3-1-05）。`LOD_RADIUS_THRESHOLD` が設定にない場合の既定値は 10（RCS・ベイパーコーンとも）。
       - Primary cone vertex: `(xPrimary, 0)` where `xPrimary = layout.xMin + L * cfg.PRIMARY_STATION_FRACTION` (`0.72`)
       - `coneLen = layout.halfWidth * cfg.CONE_LENGTH_RATIO * (0.75 + 0.5 * intensity)`
       - `coneHalfW = Math.min(layout.halfWidth * cfg.MAX_WIDTH_MULTIPLIER, layout.halfWidth * (1.1 + 1.35 * intensity * Math.sin(machAngleRad)))`
       - 後端 `xBack = xPrimary - coneLen`, 台形／円錐放射グラデーション（`CORE_COLOR` → `EDGE_COLOR` ＋前縁 `RIM_COLOR`）描画。`intensity >= cfg.SECONDARY_INTENSITY_MIN` の場合は段間 `xSecondary = layout.xMin + L * cfg.SECONDARY_STATION_FRACTION` (`0.44`) にも `0.78x` スケールの副コーンを描画する。
2. **`VAPOR_CONE` 完全スキーマ (`presets/visuals/rocket.json` & `_seedFallbacks()` 共通)**:
   ```json
   "VAPOR_CONE": {
     "PRIMARY_STATION_FRACTION": 0.72,
     "SECONDARY_STATION_FRACTION": 0.44,
     "SECONDARY_INTENSITY_MIN": 0.55,
     "CONE_LENGTH_RATIO": 2.2,
     "MAX_WIDTH_MULTIPLIER": 2.8,
     "CORE_COLOR": "rgba(240, 248, 255, 0.70)",
     "EDGE_COLOR": "rgba(185, 215, 255, 0.0)",
     "RIM_COLOR": "rgba(255, 255, 255, 0.55)"
   }
   ```
3. **`mach = 0` クリア・`SoundEffects` 横展開**:
   - `GravSimCalcObject.applyAerodynamics`: `if (vRelSq === 0) return;` **直前に** `this.mach = 0;`。
   - 基底 `GravSimCalcObject.clearAerodynamicParameters()` ＆ サブクラス `CalcRocket.clearAerodynamicParameters()` **双方**で `this.mach = 0;`。
   - `ObjectManager._applyRocketState`: `if (Number.isFinite(objData.mach)) { target.mach = objData.mach; if (target.telemetry) target.telemetry.mach = objData.mach; }`。
   - `SoundEffects` (`scripts/gravsim_sound_effects.js:346`): `const atmParam = this.universe?.objects?.find(o => o.id === rocket.dominantBodyId)?.param ?? null; const telemetry = rocket.telemetry; const mach = Number.isFinite(telemetry?.mach) ? telemetry.mach : AeroUtils.computeMach(Math.hypot(telemetry?.vV || 0, telemetry?.vH || 0), telemetry?.altM || 0, atmParam);`。

---

### 3.4 [要件4] フライトプラン修復 ＆ 切り離しタイミング追加

1. **トリガ・独立ラッチ・`ORBIT_ASSIST` 確定式・`targetVInfKmS` 境界 (`gravsim_flight_computer.js`, `gravsim_calc_object.js`, `gravsim_calc_predictor.js`, `gravsim_telemetry_panel.js`)**:
   - `FlightComputer._evaluateProfile`:
     - トリガ判定（L73–79）および補間用 `currentVal`（L114–121）の**両方**に `time`, `alt`, `vel` (`Math.hypot(this.telemetryCache.vV || 0, this.telemetryCache.vH || 0)`), `apogee`（燃料残制限なし）を実装。
     - `gravsim_calc_predictor.js` 側 `eventRules` (`L522–532`) の `'vel'` 判定は `const fcTm = rocket.flightComputer?.telemetryCache; const curVel = fcTm ? Math.hypot(fcTm.vV || 0, fcTm.vH || 0) : Math.hypot(vV, vH);` とし、`FlightComputer` と完全一致させる。
     - 独立アクションラッチ：`_highestStepIndex` で順次前進し跨いだ全行の非空 `action` を抽出すると同時に、先の未到達ガイド行の後に置かれた条件達成済 `action !== ''` 行も `_triggeredActionIndices` で 1回だけ `this._pendingActions.push(step.action)` へ積む。`FlightComputer` 公開 API：`hasScheduledAction(actionName)`（`_triggeredActionIndices` 未登録の残余ステップに指定名があるか）・`consumePendingActions()`（配列を返して空にクリア）。アクションの実行は飛行中のステップだけとする（ホールドダウン中と `dt = 0` の評価では保留のまま。Rev 6.13、§4.14-9）。取り出した時点で適用できないアクション（第 1 段の燃焼中の `sep_stage2`、2 回目の `sep_stage1` など）は実行せずに捨てる（保留に戻さない。Worker と予測で同じ）。
     - `ORBITAL_COAST` 中も `flightComputer.update` は継続し `action` 抽出のみ行う。
     - フライトプランの行の検証（Rev 6.10）: `FlightComputer` のコンストラクタ、`RocketLauncher.loadState`、`RocketTab.loadState` は、オブジェクトでない行（`null`・数値など）と、`value`・`thrust`・`angle` のいずれかが有限の数値でない行（欠けている・文字列・`NaN`・`±Infinity`・`null`。いずれも壊れたセーブから入り得る）を取り除き、配列でない値は空のプランとして扱う（有限の数値の検証は Rev 6.11、独立監査3 Iteration 1 Watchpoint 5。従来は欠けた行がスロットルと角度を `NaN` にしていた）。`thrust`・`angle` に既定値は設けず、補わずに除く。`type`・`action` は検証しない。行番号（ラッチ・実行時状態の復元）は、取り除いた後の配列の番号とする。Rocket タブの表のセル編集は、有限の数値に解釈できない入力を 0 として書き戻す（Rev 6.11。`±Infinity` の行が表に残ったまま打上げ時に除かれることを防ぐ）。
     - `FlightComputer` のコンストラクタは、`config.targetApogeeKm`・`targetPerigeeKm`・`disableOrbitalCutoff` を自身の値として保持する（Rev 6.10 で実装を修正。従来は内部の `this.config` から読んでいたため 0／`false` になり、最初の `update` でセンサー値に上書きされるまで目標が欠けていた）。
   - **Deferred Auto-Staging / Deferred Orbital Hold 契約 (`CalcRocket`)**:
     - `CalcRocket` コンストラクタは `targetApogeeKm`, `targetPerigeeKm`, `disableOrbitalCutoff` を `new FlightComputer(config)` へ渡し、毎ステップ `this._sensorData` へ **`stageState: this.stageState`**, `targetApogeeKm: this.targetApogeeKm`, `targetPerigeeKm: this.targetPerigeeKm`, `disableOrbitalCutoff: this.disableOrbitalCutoff` を格納してから `this.flightComputer.update(this._sensorData)` を呼ぶ。直後に `for (const act of this.flightComputer.consumePendingActions()) this.executeProfileAction(act);` を実行する。
     - 予約有無判定ヘルパー `_isCurrentStageSepDeferred()`:
       - `cur === 0 && totalStages >= 2`: `fc.hasScheduledAction('sep_stage1')`
       - `cur === 1 && totalStages >= 3`: `fc.hasScheduledAction('sep_stage2')`
       - `cur === totalStages - 1`: `fc.hasScheduledAction('sep_payload') || (totalStages === 2 && fc.hasScheduledAction('sep_stage2'))`
     - `_isPayloadSepDeferred()`: `fc.hasScheduledAction('sep_payload') || (totalStages === 2 && currentStageIndex === 1 && fc.hasScheduledAction('sep_stage2'))`。
     - **燃焼終了時 (`L1202–1223`)**: `fuelMass=0, oxidMass=0, burnTime=0, isIgnited=false, _thrustRatio=0`、`isPayloadSeparated` なら `'ORBITAL_COAST'`、そうでなければ `'STG_MECO'` (`stgTimer=0`)。`L1145–1150` (`STG_MECO` 経過待機) では **`if (!this._isCurrentStageSepDeferred() && this.stgTimer >= sepDelay)` のみ自動 `separateCurrentStage()`** を行い、`true` の間は `'STG_MECO'` のまま推力ゼロでプロファイルトリガまで保持する！
     - **軌道投入カットオフ時 (`L1066–1084`)**: カットオフ達成時に `_isPayloadSepDeferred()` が `true` なら、`stageState = 'ORBITAL_COAST'`（エンジン停止・推力 0・燃料 0）へ移行しつつ **`isPayloadSeparated` は `false` のまま保持**し、後の `sep_payload` / `sep_stage2` 到着時に分離する。予約なしなら従来通り `STG_MECO` →即 `separateCurrentStage()`。
     - **`executeProfileAction(action)` & `separatePayload()`**: 先頭 **`if (this.disableStaging) return;`**。`sep_stage1` / `sep_stage2`（3段機→Stage 3、2段機→`STAGE2_SEPARATED + PAYLOAD_SEPARATED` 統合・自走有は推進引き継ぎ `STG_COAST`）／`sep_payload`（未分離フェアリング＋残存下段を `guard <= totalStages + 1` で順次 `separateCurrentStage()` 分離し自走有は `STG_COAST` + `autoControl` 維持）。
   - **検証済 `ORBIT_ASSIST` 確定数式（Rev 5 継承・変更不可）**:
     - `isCircularTarget = Boolean(targetApogeeKm > 0 && targetPerigeeKm > 0 && targetApogeeKm / targetPerigeeKm <= 1.5)`。
     - 慣性ベクトル `(dx, dy, dvx, dvy)`, `E >= 0 ? apKm = Infinity : apKm`, 介入条件 `isCircularTarget && !disableOrbitalCutoff && sensor.stageState === 'STG_BURNING' && altM >= 140000 && vHMag >= 4200 && (apKm >= targetApogeeKm * 0.88 || E >= 0)`:
       $$r_{\text{tgt}} = R_{\text{host}} + \frac{h_{\text{ap,tgt}} + h_{\text{pe,tgt}}}{2}\cdot 1000,\quad \text{apOver} = \text{Number.isFinite}(\text{apKm}) ? \max(0, (\text{apKm} - h_{\text{ap,tgt}})\cdot 1000) : \max(0, \text{altM})$$
       $$v_{r,\text{tgt}} = \text{clamp}\left(\frac{(r_{\text{tgt}} - r) - 1.1\cdot \text{apOver}}{130},\ -85,\ +14\right),\quad \gamma_{\text{cmd}} = \text{clamp}\left(\frac{v_{r,\text{tgt}} - v_r}{650},\ -0.30,\ +0.45\right)$$
       $$\vec{t} = \cos\gamma_{\text{cmd}}\hat{u}_H + \sin\gamma_{\text{cmd}}\hat{u}_R,\quad \phi_{\text{cmd}} = \text{atan2}(t_y, t_x)$$
   - **`targetVInfKmS` 双曲線カットオフ明確化（F5-03 #4）**: `gravsim_calc_object.js:1038` の `!this.isPayloadSeparated` 分岐内において、**`!this.isPayloadSeparated`** を明示条件として **`else if (!this.isPayloadSeparated && (this.disableOrbitalCutoff || this.targetVInfKmS > 0) && E >= 0 && this.targetVInfKmS > 0)`** にて `curAltM >= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_MIN_ALT_M && Math.sqrt(2 * E) / 1000 >= this.targetVInfKmS` 到達時にカットオフ（ペイロード分離後の `mmx` 再点火には絶対に干渉しない）。
   - **`gravsim_calc_predictor.js`**: `for (let s = prevStageIndex + 1; s <= Math.min(rocket.currentStageIndex, rocket.totalStages); s++)` で全通過段の `stg_sep_${s}` と `payload_sep` を記録。`TelemetryPanel` L681 は `rocket.isPayloadSeparated` のみで `P-SEP` 点灯。`payload_cutoff` は、ステップの開始時にペイロードが分離済みで、前のステップが STG_BURNING、このステップで ORBITAL_COAST か燃焼時間 0 になったときだけ記録する（Rev 6.13、§4.14-1）。ステップの開始時に燃焼中だった段のカットオフは分離の前に記録し、分離と同じステップで点火したペイロードは PAYLOAD START とする。段番号が段数以上の状態は段のカットオフとしない（§4.14-8）。2-STG-SEP は段数が 2 以上の機体だけ（§4.14-10）。
   - **ペイロード分離後の HUD**（Rev 6.12、§4.13-6）: 分離後の段番号は段数（最後の段の次）になるため、`isPayloadSeparated`（オブジェクトまたはテレメトリ）または段番号 ≥ 段数のとき（`isPayloadPhase`）、STAGE 行は `N / M (段名)` の代わりに `PAYLOAD (<payload.name>)`（名前がなければ `PAYLOAD`）、推進カードの見出しは `[ PROPULSION: PAYLOAD ]`（2 段以上の機体）、推進剤バーの満量は `payload.propulsion` の `fuelMassT`／`oxidMassT`（推進系がなければ 0）とする。段名の規則（段の名前、なければ BOOSTER／UPPER／CORE）と SRB タグ（第 1 段のみ）は変えない。
2. **全 7 ミッション確定 `flightProfile`・目標値表（すべて `0°` 天頂→`90°` 水平、`action: ""` 既定）**:
   | Mission ID | `targetApKm` / `PeKm` / `VInfKmS` / `disableCutoff` / `targetDv` | `flightProfile` 全行 `(type, value, thrust, angle)` |
   |---|---|---|
   | `leo_250km` | `null / null / null / false / 9300` | `(alt,0,100,0), (alt,2000,100,10), (alt,15000,100,26), (alt,40000,100,48), (alt,80000,100,68), (alt,150000,100,80), (alt,220000,100,86), (alt,300000,100,89), (alt,380000,100,90)` |
   | `iss_rendezvous` (**8行維持**) | `400 / 400 / null / false / 9500` | `(alt,0,100,0), (alt,2000,100,8), (alt,18000,100,22), (alt,50000,100,42), (alt,100000,100,62), (alt,200000,100,76), (alt,320000,100,85), (alt,400000,100,90)` |
   | `gto_insertion` | `35786 / 250 / null / false / 11800` | `(alt,0,100,0), (alt,2000,100,11), (alt,14000,100,28), (alt,38000,100,50), (alt,78000,100,70), (alt,145000,100,82), (alt,210000,100,87), (alt,290000,100,89), (alt,370000,100,90)` |
   | `lunar_insertion` | `384400 / 250 / null / false / 12300` | `(alt,0,100,0), (alt,1800,100,11), (alt,14000,100,29), (alt,36000,100,51), (alt,75000,100,71), (alt,140000,100,83), (alt,205000,100,88), (alt,285000,100,89), (alt,360000,100,90)` |
   | `mars_transfer` | `null / null / 3.3 / true / 12800` | `(alt,0,100,0), (alt,2000,100,10), (alt,15000,100,26), (alt,42000,100,46), (alt,85000,100,66), (alt,155000,100,78), (alt,230000,100,85), (alt,310000,100,89), (alt,380000,100,90)` |
   | `jupiter_transfer` | `null / null / 9.0 / true / 15800` | `(alt,0,100,0), (alt,2000,100,9), (alt,16000,100,25), (alt,44000,100,45), (alt,90000,100,64), (alt,165000,100,77), (alt,245000,100,85), (alt,325000,100,89), (alt,390000,100,90)` |
   | `solar_escape` | `null / null / 12.8 / true / 18500` | `(alt,0,100,0), (alt,2000,100,8), (alt,17000,100,24), (alt,48000,100,44), (alt,95000,100,63), (alt,175000,100,76), (alt,260000,100,84), (alt,340000,100,88), (alt,400000,100,90)` |
3. **深宇宙自動サイジング数式（非 SRB 機体 `h3_30`/`falcon9` 含め確定, F5-01 #2）**:
   - 対象：`stages.length >= 2 && last.fuelType !== 'solid' && Boolean(mission?.disableOrbitalCutoff || (mission?.targetVInfKmS > 0))`（ベース機体 JSON 不変）。
   - `reqDv = Math.max(mission.targetDeltaVM_S || 0, Math.round(11500 + (Math.hypot(11200, (mission.targetVInfKmS || 0) * 1000) - 7800)))`
   - 基準質量（Rev 6.11 で実装どおりに定義、G3-1-03）: `baseMassLiftoff = payload + fairing + boosterDry + boosterProp + Σ(最終段以外の段の dry + fuel + oxid) + last.dryMassT`。SRB 機体の `baseMassPostSrb = payload + stages[0].dryMassT + remStg0Prop + Σ(第 2 段〜最終段の 1 つ前の段の dry + fuel + oxid) + last.dryMassT`（非 SRB 機体は `baseMassLiftoff` と同じ）。`baseMassPostSrb` はフェアリングを含めない。フェアリングは 115〜120 km で分離し、SRB 分離（燃焼 105 s）の時点ではまだ付いているため、付いたままの実際のコア TWR は 1.142〜1.148 になる（1.15 は推力を決めるための目安で、差は推力で 17〜23 kN、0.2〜0.3%）。プリセットのブースタは推進剤の質量を持たないため、`boosterProp` は 0 になる。
   - SRB 燃焼後残存質量式：`stg0BurnT = stages[0].burnTime || 290; srbBurnT = boosters ? (boosters.burnTimeSec || 105) : 0; remStg0Prop = boosters ? Math.max(0, stg0Prop * (1 - srbBurnT / Math.max(1, stg0BurnT))) : stg0Prop;`
   - **非 SRB 機体（`h3_30`, `falcon9`）と SRB 機体（`h3_22`, `h3_24`）共通の上限・推力強化**:
     - `maxStg0Thrust = Math.max(origStg0Thrust, 10000)`（非 SRB `h3_30` `4410 kN` → 最大 `10000 kN`、既定超 `h3_24` `11500 kN` 維持）、`maxCoreThrust = Math.max(origCoreThrust, 10000)`。
     - `maxByTwr = Math.max(origUpperProp, Math.min(maxStg0Thrust / (G0 * 1.25) - baseMassLiftoff, maxCoreThrust / (G0 * 1.15) - baseMassPostSrb))`（非 SRB 時 `baseMassPostSrb === baseMassLiftoff`, `maxCoreThrust === maxStg0Thrust` により `1.25` 基準が支配）。
     - `maxByTank = ofRatio > 0 ? Math.min(1500 * (1 + ofRatio), 3000 * (1 + 1 / ofRatio)) : 1500` → `hardCap = Math.min(maxByTwr, maxByTank)`。
     - 二分探索（28 反復）で `last.fuelMassT` / `oxidMassT` を解出し、`last.thrustKN = Math.ceil(Math.min(Math.max(last.thrustKN, 10000), Math.max(last.thrustKN, (newUpperProp * isp * G0) / 420, upperMass0 * G0 * 0.60)))`（`burnTime <= 420.0s` 保証）。
     - 第1段推力更新：
       - `boosters` あり：`boosters.coreThrustKN = Math.ceil(Math.min(maxCoreThrust, Math.max(origCoreThrust, newPostSrbMass * G0 * 1.15)))`、`stages[0].thrustKN = Math.ceil(Math.min(Math.max(maxStg0Thrust, boosters.coreThrustKN + (boosters.thrustKN || 0)), Math.max(origStg0Thrust, newLiftoffMass * G0 * 1.25, boosters.coreThrustKN + (boosters.thrustKN || 0))))`。
       - `boosters` なし（`h3_30`, `falcon9`）：`stages[0].thrustKN = Math.ceil(Math.min(maxStg0Thrust, Math.max(origStg0Thrust, newLiftoffMass * G0 * 1.25)))`。
       - `stages[0].burnTime` を `effTh0 = boosters?.coreThrustKN || stages[0].thrustKN` で再算出。
   - `_adaptFlightProfileForVehicle`: `const refUpper = vehicle?.stages?.[1] ?? stages?.[1];` で元推力基準判定（`08_tab_navigation_lifecycle.test.mjs:1356` の `vehicle = {}` 完全互換）、非固体多段深宇宙時は `altScale >= 1.0` を保証。高度の倍率は main の値を維持する: 全段固体 0.62、単段 0.58、上段 TWR（`thrustKN / (dry + fuel + oxid + 4)`）が 6.0 未満なら 1.08、それ以外 0.85（Rev 6.11 で値を明記、G3-1-03）。
4. **`applyToLauncher`・貫通経路・6 列 UI (`index.html`, `style.css`, `RocketTab`)・スライダ 3 箇所 (`F5-05`)**:
   - `applyToLauncher`: `(payloadId !== undefined && payloadId !== null) || applyRecommendedMission === true` のみ推奨ミッション適用。
   - `#rl-flight-profile-table` 全 6 列定義（`children[0..5]`順厳守）：
     - `children[0]` (`19%`): `<select class="fp-trigger">` (`alt`="Alt(m)", `time`="Time(s)", `vel`="Vel(m/s)", `apogee`="Apogee(s)"。Rev 6.10 で表示名の空白を実装に合わせた)
     - `children[1]` (`22%`): `<input type="number" class="fp-val">`
     - `children[2]` (`14%`): `<input type="number" class="fp-thrust">`
     - `children[3]` (`14%`): `<input type="number" class="fp-angle">`
     - `children[4]` (`21%`): `<select class="fp-action">` (`""`="-", `"sep_stage1"`="Stg1", `"sep_stage2"`="Stg2", `"sep_payload"`="Pay")
     - `children[5]` (`10%`): `<button type="button" class="fp-del">✕</button>`（`05_ui_telemetry_audio.test.mjs:1642` を `row0.children[5].children[0]` へ更新＋列4 `fp-action` 検証追加）
   - CSS (`style.css`): `.profile-table { width: 100%; table-layout: fixed; border-collapse: collapse; }`・`th, td { padding: 2px 1px; box-sizing: border-box; overflow: hidden; }`・`select, input { width: 100%; min-width: 0; font-size: 11px; padding: 2px 2px; box-sizing: border-box; }`・`::-webkit-inner-spin-button, ::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }`＋`input[type="number"] { -moz-appearance: textfield; }`（320px サイドバーで `scrollWidth <= clientWidth`）。
   - `#rl-launch-thrust` 動的 `max = Math.max(10000, Math.ceil(thrustKN))` 同期を **`RocketTab` の全 3 箇所**（`selectTab` L659, `loadState` L1129, `rlFuelType` change L221）に水平適用する。
   - **予測期間スライダの同期**（Rev 6.12、§4.13-5）: `RocketTab.applyOrthogonalConfig`（ミッション・ペイロード（推奨ミッション）・機体の選択と適用）は `applyToLauncher` の後に `ui:sync-prediction-duration`（`predictionDurationMonths`）を発行し、`SystemTab.syncPredictionDuration` が `#pred-duration` とラベル（12 ヶ月未満は `<m> mo (<round(m × 365.25 / 12)> d)`、12 ヶ月以上は `<m / 12 を小数 1 桁> yr (<m> mo)`）に表示する。表示だけで、ランチャの値は変えない（範囲外はスライダを端に置き、ラベルは使用中の値を示す）。有限の正の数値以外は無視する。ラベルを書くのは、スライダの入力処理と共通の 1 か所（`_showPredictionDurationLabel`）だけとする。読込で期間を適用したときも、`RocketLauncher.loadState` が同じイベントで表示する（§3.5-1）。ミッションの期間は §3.5-1 の規則で検証して適用する（§4.13-17）。
   - **Rocket タブのスライダの範囲と刻み**（Rev 6.13、§4.14-4）: サイジング（§3.4-3）の値を表せる刻みとする（推進剤 0.1 t、乾燥質量 0.1〜500 t・0.1 t、推力 1 kN から・1 kN、ペイロードの質量と推進剤 0.01 t）。
   - **Rocket タブを閉じたときの表示**（Rev 6.12、§4.13-10）: 開く前の時間倍率・ズーム（スライダとも）・カメラの対象とオフセットに戻す。自動追尾中は追尾を止めてホストに合わせ、ロールアウト済み・シーケンス中は打上げの表示とする（§4.13-15）。カメラの対象は、開く前のオブジェクトが残っているときだけ戻す（§4.13-16）。

---

### 3.5 [要件5] 全残存バグ・保存復元全項目・デッドコード 3 群・静的検証・テスト

1. **`ObjectManager._applyRocketState` & 完全 `getState`/`loadState` 全フィールド表 (`F5-04`)**:
   - `_applyRocketState`: L295 (`isPayloadSeparated`), L312 (`burnTime`), L300 (`isStage2Separated` フォールバック)、`if (target.fairing && objData.tmFairingSeparated !== undefined)`, `!== undefined`/`Number.isFinite` ガード付き `stageState`, `stgTimer`, `hasPayloadPropulsion`, `mach`, `rcsCw`, `rcsCcw`, `rcsUllage` 同期。
   - `getState()` / `loadState()` 厳密全項目（Rev 6.10 で適用範囲を明確化。`_buildRocketPayload()` が Worker へ送る `add` メッセージは、Worker が使う項目に限る。ロケットでは `color`・`totalStages` を送らず、乾燥質量は `mass` として送る。`mach`・`rcs*` も送らない（§4.7））：
     - `CELESTIAL`: `id, type, name, x, y, vx, vy, mass, radius, color, generation, rotationAngle, param`、`runtimeState`（Rev 6.11、スナップショットに項目があるときだけ。§4.7）
     - `DEBRIS`: `id, type, name, x, y, vx, vy, mass, radius, color, generation, debrisSubType, colorTheme, baseRadiusM`、`runtimeState`（Rev 6.11、スナップショットに項目があるときだけ。§4.7）
     - `ROCKET`（`mass` は保存しない。ロケットの質量は読込時に各段・ペイロードの質量から再計算する。Rev 6.10 で訂正。Rev 6.12（§4.13-8）: 再計算（`Rocket.mass`）は `CalcRocket.updateTotalMass()` と同じ和を、オブジェクトが保持し保存する分離状態から求め、毎フレームのテレメトリは読まない。ペイロード分離後は、自走（`hasPayloadPropulsion`、なければ `payload.propulsion.enabled`）なら `dryMass + fuelMass + oxidMass`、受動なら `payload.massT`。分離前は `payload.massT` + フェアリング（`enabled && !fairing.isSeparated`）+ 現在の段 + 上段（段番号は数値化して `[0, 段数]` に収める）。ブースタは `dryMass`（Worker の値で、投棄した SRB を含まない）に反映済み。Rev 6.13（§4.14-6 (f)）: 読込で主スレッドの `rocket.flightTime` を `runtimeState.flightComputer.flightTime` から設定する。保存項目は変えない）: `id, type, name, x, y, vx, vy, dryMass, fuelMass, oxidMass, burnTime, thrustForce, thrustAngle, radius, color, generation, stages, payload, fairing, boosters, flightProfile, colorTheme, hostId, hostAngleRad, hostAltM, bottomOffsetM, baseRadiusM, autoControl, disableStaging, disableOrbitalCutoff, targetApogeeKm, targetPerigeeKm, targetVInfKmS, isHoldDown, isIgnited, currentStageIndex, totalStages, isPayloadSeparated, isStage2Separated, isBoosterBurnout, isBoosterSeparated, hasPayloadPropulsion, stageState, stgTimer, mach, rcsCw, rcsCcw, rcsUllage, restoredRuntimeState: true`。
     - `controlPanel`（Rev 6.12、§4.13-4。オブジェクトの表の外）: 保存は `{ controlPanel: { timeScaleVal, zoomScaleVal } }`。タブ分割前（git 53d6e87〜0adb139）の保存は直下の `{ timeScaleVal, zoomScaleVal }`（同じ `version: 2`）で、`ControlPanel.resolveSystemTabState` が形で判別する。`timeScaleVal` は、シミュレーションに与えている指数（`SystemTab.getTimeScaleExp()`。実時間は −7.4991… のまま）とする。有限の数値だけをスライダの範囲（時間倍率 −7.5〜1、ズーム −2〜9）に丸めて適用し、時間倍率は刻みに丸めずに与え、スライダは最も近い刻みを表示する（§4.13-20）。それ以外の値は現在の値のまま（他方は適用する）。Rocket タブが開いている間はタブの規則（最小の時間倍率で一時停止し、閉じるときに戻す）を優先し、読み込んだ値は閉じるときに戻す値になる（`RocketTab.deferViewState`。Rocket タブは射点の準備のために最小の倍率で一時停止しており、開いたまま大きい倍率に戻すと、その状態でロールアウトできてしまうため。読込のボタンは System タブにあり、通常はすぐ反映される）。
     - `rocketLauncher` の予測期間（Rev 6.12、§4.13-11）: `RocketLauncher.getState()` に `predictionDurationMonths` を加える。`maxSimTimeSec` は保存せず、読込時に `months × 365.25 / 12 × 86400`（スライダと同じ式）で求める。有限の正の数値だけを `#pred-duration` の範囲（`TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS`〜`MAX_DURATION_MONTHS`、0.2〜36 ヶ月）に丸めて適用し、`ui:sync-prediction-duration` で表示する（`controlPanel` の項目がない保存でも表示される）。項目がない（Rev 6.12 より前の保存）・数値でない・0 以下のときは、使用中の期間のままとする。刻み（0.1）に乗らない値は丸めない。
     - 世界の中心と自動のホスト（Rev 6.12、§4.13-27）: `CELESTIAL` に `isWorldCenter`（真偽値）、`rocketLauncher` に `hostAutoSelected`（真偽値）を加える。真偽値でない値は、ないものとして扱う。どの天体にも `isWorldCenter` がない旧形式のファイルは id 0 の天体を中心とし、`hostAutoSelected` がないファイルは中心のホストを自動で選んだものとする（どちらも、旧いコードがそのファイルで行ったことと同じ）。
     - プロファイルの世界の中心（Rev 6.16、§4.14-14）: `CELESTIAL` に `isProfileWorldCenter`（真偽値。プロファイルが `worldCenter: true` の静的な物体として置いた世界の中心（銀河中心の Sgr A*）だけが真）を加える。主スレッドだけの項目で、Worker には送らない。読込は天体ごとに、`isWorldCenter` の有無によらず、厳密に `true` のときだけ真とし、`false`・ない・真偽値でない値は偽とする。印のない旧形式のファイル（main と Rev 6.15 までの保存）の中心はプロファイルの中心でなく、Deploy のボタンと太陽系はその中心を置き換えない。`isWorldCenter` の旧形式の規則（id 0 の天体を中心とする）は変えず、その中心の印もファイルの値（ないときは偽）のままとする（Rev 6.17、G3-5-01）。
   - **`CalcRocket` `restoredRuntimeState` 復元手順（`_activateStage(0)` 抑止時）**:
     ```js
     // Rev 6.10 で実装に合わせて訂正: 段番号は数値化して範囲に収め（NaN は 0）、分離フラグは段番号とも整合させる
     this.currentStageIndex = Math.max(0, Math.min(Number(data.currentStageIndex) || 0, this.totalStages));
     this.isPayloadSeparated = Boolean(data.isPayloadSeparated);
     this.isStage2Separated = Boolean(data.isStage2Separated || this.currentStageIndex >= 2 || (this.isPayloadSeparated && this.totalStages <= 2));
     this.isBoosterBurnout = Boolean(data.isBoosterBurnout);
     this.isBoosterSeparated = Boolean(data.isBoosterSeparated);
     this.hasPayloadPropulsion = Boolean(data.hasPayloadPropulsion || (this.isPayloadSeparated && this.payload?.propulsion?.enabled));
     this.stageState = data.stageState || (this.isHoldDown ? 'PRE_LAUNCH' : 'STG_BURNING');
     this.stgTimer = Number.isFinite(data.stgTimer) ? data.stgTimer : 0;
     // エンジン諸元(fuelType, thrustForceVac, ispVac, ispSl, ofRatio)は:
     // (isPayloadSeparated && hasPayloadPropulsion) → this.payload.propulsion から算出、
     // isPayloadSeparated (非自走) → 0、
     // それ以外 → this.stages[this.currentStageIndex] (ROCKET_FUELSフォールバック込) から算出。
     // 質量・残燃料は data.dryMass, data.fuelMass, data.oxidMass, data.burnTime をそのまま適用し、
     // massLossRate = this.burnTime > 0 ? (this.fuelMass + this.oxidMass) / this.burnTime : 0;
     // this.thrustForce = this.stageState === 'ORBITAL_COAST' || (isPayloadSeparated && !hasPayloadPropulsion) ? 0 : this.thrustForceVac;
     // this.currentIsp = this.getEffectiveIsp(this.ambientPresRatio);
     // this.updateTotalMass();
     // Rev 6.11（G3-1-01）: SRB 分離済みで第 1 段にいるときは、stages[0].dryMassT から SRB の乾燥質量を引く（separateBoosters と同じ）
     // Rev 6.11: 乾燥質量は data.mass をそのまま使う（受動ペイロードの 0 を含む。既定値で置き換えない）
     // Rev 6.11: objParam は runtimeState.paramName（なければ name）で引く（ペイロード分離後もロケットのパラメータを使う）
     // Rev 6.11: 最後に runtimeState（§4.7）を復元し、推進系の値・推力比・姿勢指令・運動学の値は保存値で上書きする
     ```
2. **削除対象デッドコード 3 群（確定リスト, 横展開監査済）**:
   1. `scripts/gravsim_const.js`: `RENDER.PREDICTED_TRAJECTORY.COLOR_ORBIT`, `RENDER.PREDICTED_TRAJECTORY.COLOR_FALL`（および全コードベース参照 0 件の未使用定数 `SIMULATION.CALC_SUB_STEPS_BASE`, `SIMULATION.CALC_SUB_STEPS_MAX`, `TRAJECTORY_PREDICTION.EVENTS.ORBIT_HORIZONTAL_VEL_MIN_M_S`, `FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MIN_Q`）
   2. `scripts/gravsim_trajectory_predictor.js:893–895`: 重複定義 `TrajectoryPredictor.prototype.render`
   3. `scripts/gravsim_universe.js:182–193`: 旧メインスレッド非同期 `rotationAngle` 更新ループ
3. **その他不具合・検証**:
   - `scripts/gravsim_calc.js`: `AERO_DYNAMIC` import、`determineOptimalSubSteps` フォールバック補完。
   - `scripts/gravsim_info_panel.js`: `Date.now()`＋`instanceof Date` 互換＋`05_ui` L953 (`Date.now() - 600`)。
   - `scripts/gravsim_save_manager.js`: `if (typeof raw !== 'string') { alert(...); return; }` → `const state = JSON.parse(raw); if (!state || typeof state !== 'object' || !state.universe || typeof state.universe !== 'object') { alert(...); return; }`（非配列オブジェクト＋`universe` 構造検証）。
   - `node --check` ＋ `.eslintrc.json` ＋ `jsconfig.json` (`checkJs: true`, 0 エラー) ＋ Node カバレッジ `>= 90%` (目標 `>= 97%`) ＋ Chrome E2E (`server.listen(0, '127.0.0.1')`, `/tmp` 分離, `try/finally`, 正常・異常・境界 3観点網羅)。

---

## 4. 補遺 Rev 6.1〜6.23: 独立監査2 Iteration 1〜9 指摘（G2-01〜G2-10, G2-2-01〜G2-2-04, G2-3-01〜G2-3-03, G2-4-01〜G2-4-03, G2-5-01〜G2-5-02, G2-6-01〜G2-6-03, G2-7-01, G2-8-01〜G2-8-03, G2-9-01〜G2-9-02）、工程 3 のテスト作成で判明した事項（Rev 6.10）、独立監査3 Iteration 1 指摘（G3-1-01〜G3-1-09、Rev 6.11）、既存の不具合の修正（Rev 6.12、§4.13）、本ブランチの退行の修正（Rev 6.13、§4.14）、独立監査3 Iteration 2 指摘（G3-2-01〜G3-2-05、Rev 6.14）、独立監査3 Iteration 3 指摘（G3-3-01〜G3-3-03、Rev 6.15）、独立監査3 Iteration 4 指摘（G3-4-01〜G3-4-02、Rev 6.16）、独立監査3 Iteration 5 指摘（G3-5-01〜G3-5-02、Rev 6.17）、独立監査3 Iteration 6 指摘（G3-6-01、Rev 6.18）、工程 4 の計測の分割実行（Rev 6.19、§4.12）、独立監査4 Iteration 1 指摘（G4-1-01〜G4-1-03、Rev 6.20）、独立監査4 Iteration 2 指摘（G4-2-01〜G4-2-03、Rev 6.21）、独立監査4 Iteration 3 指摘（G4-3-01〜G4-3-03、Rev 6.22）、独立監査4 Iteration 4 の文書指摘（G4-4-01、Rev 6.23）の反映

- **改訂日**: 2026-11-20 18:20 JST（Rev 6.1）。以降の改訂（Rev 6.2〜6.23）の日時と対象は冒頭の改訂履歴を正とする。最終改訂: Rev 6.23、2026-11-23 09:21 JST
- **位置付け**: Rev 6（Gate 1 Iteration 6 PASS）の仕様は本補遺で明示的に置き換える項目を除き不変。本補遺は実装監査で判明した契約不備・設計記述の誤り・横展開漏れを確定させるもので、独立監査2 の各 Iteration（Iteration 2 以降）の突合対象に含める。

### 4.1 復元分岐の契約（G2-01、Rev 6 L283 の明確化）
- `CalcRocket` の復元分岐（`_activateStage(0)` 抑止）は **`thrustData.restoredRuntimeState === true` のときに限り** 実行する。`stageState`・`isPayloadSeparated`・`currentStageIndex` などからの推定は禁止（主スレッド `Rocket` は既定で `stageState = 'PRE_LAUNCH'` を持つため、推定すると全ロールアウトが復元分岐に入る）。
- `ObjectManager.getState()` の ROCKET は `restoredRuntimeState: true` を出力し、`loadState()` はそれを `Rocket.restoredRuntimeState` に保持、`_buildRocketPayload()` は `obj.restoredRuntimeState === true` をそのまま転送する。主スレッド `Rocket` の既定値は `false`。
- `_activateStage(0)` 経路でも `isStage2Separated = false` を明示初期化する。`hasPayloadPropulsion` は Rev 6 の互換契約（`06_external_presets_and_payload_propulsion.test.mjs:285`、通常初期化時 `undefined`）を維持する。

### 4.2 打上げ機体の設定の専有化（G2-02）
- `ObjectPlacer.placeObject()` の ROCKET 分岐は `flightProfile`・`stages`・`payload`・`fairing`・`boosters`・`rendering` を **ディープコピー** して機体専有とする。`RocketLauncher` の設定オブジェクトと参照を共有してはならない（`_applyRocketState` のフェアリング同期や次回打上げ用の UI 編集が、飛行中の機体や次の機体に伝播するため）。

### 4.3 予測サンプラーの確定（G2-03・G2-10、Rev 6 L83 の置き換え）
- **遠近点通過**: 半径方向速度の厳密な符号交差 `(prevVv > 0 && vV <= 0) || (prevVv < 0 && vV >= 0)` とする（`0 → 0` の退化ケースを除外）。`prevVv` の更新はループ末尾の 1 箇所のみとし、AP イベント判定と遠近点サンプリングの両方が前ステップ値を参照する。
- **滑らかさのハード上限（新設）**: `TRAJECTORY_PREDICTION.SAMPLING.MAX_ANGLE_STEP_RAD = 0.12`。前回サンプルからのホスト中心位置角、または速度方位角（`speed > MIN_HEADING_SPEED_M_S` 時）の変化がこれ以上になったら、`hardBudgetFloorDt` などの予算間引きに優先して（`MIN_SAMPLE_DT_S` 以上なら）必ずサンプルする。点数予算（`maxPoints`。下表の `point_budget`）が尽きた場合は、エイリアシング（周回が数本の弦に潰れるジグザグ）を起こさず、その点数で打ち切る（Rev 6.11、G3-1-09）。
- **滑らかさの測定座標系**: 上限は **描画座標系**（§4.10）で判定する。座標系切替前は `max(慣性系の位置角変化, 地表固定系の位置角変化 |Δ phiSurf|)`、切替後は慣性系の位置角変化を `MAX_ANGLE_STEP_RAD` と比較する（Rev 6.2、G2-2-01）。
- **終了理由と到達範囲（Rev 6.6 で置き換え、G2-10・G2-2-03・G2-6-01/02）**: Rev 6 の「0.2〜36 ヶ月完走」は撤回する。予測は次のいずれかで終了し、結果に `endReason` として出力する。`steps` には実際に積分したステップ数を出力する（要求期間までの残りが 0.01 s 以下のとき、その残りは積分せず、数えない。Rev 6.12、§4.13-3）。結果の `maxSimTime` は **常に最終点の時刻**とし、実際に積分した範囲を超える有効期間を主張しない。
  | `endReason` | 条件 |
  |---|---|
  | `horizon` | 要求期間 `maxSimTime` に到達 |
  | `impact` | 天体表面に到達（既存） |
  | `breakup` | 機体が破壊された（§4.11。t = 0 で既に破壊されている場合を含む） |
  | `point_budget` | 点数予算 `maxPoints = min(MAX_POINTS, Number(options.maxPoints) > 0 ? Number(options.maxPoints) : MAX_POINTS)` に到達（数値化の規則は §4.12。アプリの経路では `options.maxPoints` を渡さないため `MAX_POINTS = 3,000`。Rev 6.9、G2-9-01。Rev 6.11 で式を Rev 6.10 の規則に合わせた、G3-1-09） |
  | `step_budget` | ステップ予算 `min(MAX_STEPS_CAP, max(MAX_STEPS, ceil(maxSimTime / 5)))` に到達（`MAX_STEPS = 120,000`、`MAX_STEPS_CAP = 340,000`。Rev 6.8 で 400,000 から変更）。`options.maxSteps` を渡すと `max` の中の下限を引き上げるが、結果は `MAX_STEPS_CAP` を超えない（§4.12。アプリの経路は渡さない。Rev 6.9、G2-9-01） |
  | `no_host` | ホスト天体が見つからない（点 0） |
- **安定周回の打ち切りと延長表示は廃止する**（Rev 6.6）: Rev 6.2〜6.5 では、安定と判定した周回を早期に打ち切り、要求期間まで有効として表示していた。しかし、瞬時の軌道要素、潮汐比、ヒル半径、外挿のいずれの判定にも、第三天体による衝突や減衰を見逃す反例が残った（G2-4-01、G2-5-01、G2-6-01、G2-6-02）。そのため、計算していない未来の有効性を主張する機構そのものを撤去する。飛行中に予測線を延ばす機能（飛行中の状態からの再予測・継ぎ足し）は、別の課題として扱う。
- **保証**:
  1. 【全予測】描画座標系での隣接サンプル間の角度変化が `MAX_ANGLE_STEP_RAD` ＋ 1 積分ステップ分以内（終端の最終点を含む。テストでは `<= 0.15 rad` で判定）。プレビュー・飛行中のいずれの時刻でも成り立つ。
  2. 【全予測】点数が `MAX_POINTS` 以下（`options.maxPoints` は上限を下げる方向にだけ効き、`MAX_POINTS` は超えない。Rev 6.8、G2-8-01）で、時刻が単調増加。`endReason` は上表のいずれか。飛行中は、飛行時刻が `maxSimTime`（最終点の時刻）を過ぎた時点で予測線を消す（既存動作）。`maxSimTime` は同期経路（`calculateSync`）と Worker 経路で同じ値とする（点 0 個の `no_host` では 0。Worker 経路の既定値の補完は `maxSimTime` が欠けている場合に限り、0 を 1 年に置き換えない。Rev 6.7、Iteration 7 Watchpoint 4）。
  3. 【ホスト近傍の閉軌道：§4.3 表の LEO / ISS / GTO のプリセット構成】全打上げ方位で、最短期間 0.2 ヶ月でも座標系切替後に 1 周回以上を描画する。終了理由は `step_budget`。周回数は **切替後の描画上の回転量**（切替後のホスト中心の位置角の累積）で判定し、時間／周期は使わない。対象ワールド: Sun+Earth、7 天体ワールド、アプリの `SOLAR_SYSTEM`・`BINARY_SYSTEM`・`THREE_BODY` 配置（Rev 6.7 で明記。Iteration 7 で 5 ワールドすべてで成立を確認。0.2 ヶ月の切替後の回転量は LEO 1.90 周、ISS 1.73 周、GTO 1.32 周で、ワールド・方位によらない）。
  4. 【ホスト離脱軌道：深宇宙 3 ミッションのプリセット】全期間（0.2〜36 ヶ月）・全打上げ方位で `endReason ∈ {horizon, point_budget}`。到達率（最終点の時刻／要求期間）はワールドで分ける（Rev 6.7、G2-7-01）。
     - (a) Sun+Earth、7 天体ワールド、アプリの `SOLAR_SYSTEM` 配置（ホストが主星から約 1 AU を周回するワールド）: 到達率 ≥ 99.5%（テストの閾値。Iteration 7 の実測の最小は 99.91%、Mars 36 ヶ月）。
     - (b) アプリの `BINARY_SYSTEM`・`THREE_BODY` 配置など、ホストが主星の近く（約 0.35 AU）を周回するワールド: **到達率は保証しない**。ホスト中心の描画では、離脱後の機体がホストのまわりを周回する（36 ヶ月・8 方位で切替後の描画上の回転量 7.8〜15.3 周）。上記の滑らかさの上限が点の予算より優先されるため（本節「滑らかさのハード上限」）、3,000 点が要求期間より先に尽きる。保証 1・2 は成り立つ（深宇宙 3 ミッション × 7 期間 × 8 方位（各ワールド 168 件）の、構成ごとの描画上の最大角度ステップの最大値: `BINARY_SYSTEM` 0.135 rad、`THREE_BODY` 0.140 rad。保証 1 に必要なのは最大値なので下限は書かない（Rev 6.9、G2-9-01）。最大は `THREE_BODY` の Mars 36 ヶ月・方位 225° の 0.140 rad で、終端ではなく 103 日目の地球への再接近時。テストの閾値 0.15 rad との余裕は 0.010 rad。Rev 6.8 で 8 方位・7 期間の実測に訂正、G2-8-02）。実測（8 方位）: 3 ヶ月以下は全件 `horizon`（100%）。`point_budget` は Mars で 9 ヶ月から、3 ミッションとも 18 ヶ月から現れる。12 ヶ月は Mars のみ `point_budget`（99.90〜99.94%）。36 ヶ月は 3 ミッションとも全件 `point_budget`（93.38〜99.92%。最短は `THREE_BODY` の Solar・方位 45° で、要求期間の 72.5 日前の 1,023.2 日に終わる）。main は 3,000 点で約 33,000 s に打ち切られるため、本ブランチからの後退ではない。
  5. 【月遷移などの束縛軌道】到達期間は保証しない。`step_budget`・`breakup`・`impact` のいずれでも終わり得る（例: Sun+Earth で太陽摂動により近地点が下がり、`breakup` で終わる方位がある）。保証 1・2 のみ成り立つ。
- **実測**（Rev 6.8、Sun+Earth、打上げ方位 0°、`applyToLauncher` → `updatePredictionSync`。描画角は実際の `renderTrajectory` の出力座標で測定し、プレビューと飛行中の複数時刻で同値）:
  | ミッション（機体） | 0.2 ヶ月 | 1〜36 ヶ月 | 描画上の最大角度ステップ |
  |---|---|---|---|
  | `iss_rendezvous`（h3_22） | `step_budget` 11,262 s・1,528 点（約 2.0 周） | `step_budget` 33,262 s・1,829 点 | 0.036 rad（0.2 ヶ月）／ 0.120 rad |
  | `leo_250km`（h3_30） | `step_budget` 11,358 s・1,572 点（約 2.0 周） | `step_budget` 33,358 s・1,834 点 | 0.037 rad ／ 0.120 rad |
  | `gto_insertion`（h3_24） | `step_budget` 40,882 s・1,537 点（約 1.4 周） | `step_budget` 133,707 s・1,747〜1,771 点 | 0.060 rad ／ 0.120 rad |
  | `lunar_insertion`（h3_24） | `step_budget` 372,654 s・1,566 点 | `step_budget` 1,203,081 s・1,598〜2,013 点 | 0.069 rad ／ 0.120 rad |
  | `mars_transfer`（h3_30） | `horizon` 100%・1,949 点 | `horizon` 100%・2,965〜3,000 点 | 0.120 rad |
  | `jupiter_transfer`（h3_24） | `horizon` 100%・1,416 点 | `horizon` 100%・2,431〜2,501 点 | 0.120 rad |
  | `solar_escape`（falcon9） | `horizon` 100%・1,679 点 | `horizon` 100%・2,695〜2,730 点 | 0.112 rad |
- **打上げ方位 8 通り**（0°〜315°、45° 刻み）:
  - LEO 0.2・ISS 0.3・GTO 0.5 ヶ月（各既定期間）: 全方位 `step_budget`。到達時刻は方位によらず、LEO 0.1 日、ISS 0.2 日、GTO 1.2 日。
  - Jupiter・Solar 36 ヶ月と Mars 12 ヶ月: 全方位 `horizon`。
  - Mars 36 ヶ月: 3 方位が `horizon`、5 方位が `point_budget`（到達率 99.91〜99.98%）。
  - Lunar 1 ヶ月: 4 方位が `step_budget`（13.8〜13.9 日）、4 方位が `breakup`（10.2〜10.4 日）。
  - LEO・ISS 1〜36 ヶ月: 全方位 `step_budget`、0.38〜0.39 日（切替後 5.79 周）。GTO 1〜36 ヶ月: 全方位 `step_budget`、1.55 日（3.54 周）。
- 1200 s の予測は全ミッションで `horizon`、1,122〜1,631 点（> 500 点）。

### 4.4 ベイパーコーン強度のベル関数（G2-08、Rev 6 L177–179 の置き換え）
- 範囲定数とピーク定数をすべて意味のある値として使う **非対称 smoothstep** とする。
  ```js
  const peak = AERO_DYNAMIC.TRANSONIC_PEAK_MACH; // 1.00
  const span = (mach <= peak) ? (peak - AERO_DYNAMIC.TRANSONIC_MACH_MIN)   // 0.18
                              : (AERO_DYNAMIC.TRANSONIC_MACH_MAX - peak);  // 0.22
  const u = Math.max(0, 1 - Math.abs(mach - peak) / Math.max(0.01, span));
  const machFactor = u * u * (3 - 2 * u); // 0 at 0.82 / 1.22, 1 at 1.00 (continuous at both ends)
  ```
- 境界値の期待値: Mach 0.8199 → 不成立（`active: false`, `intensity: 0`）、0.82 → `intensity: 0`、0.91 → `machFactor = 0.5`、1.00 → `1`、1.11 → `0.5`、1.22 → `0`、1.2201 → 不成立。`active` は `intensity > 0.01`。

### 4.5 保留燃焼判定の SSOT 化（G2-04）
- トリガ種別ごとの計測値は `FlightComputer.getTriggerValue(type)`（`time` → `flightTime`、`alt` → `altM`、`vel` → `hypot(vV, vH)`、`apogee` → 遠地点通過後の経過時間・通過前は `NaN`）に一元化し、`_isStepTriggered` とプロファイル補間はこれを使う。
- `CalcRocket` のコースト／最終カットオフ判定は `FlightComputer.hasPendingBurnStep()` を使う。定義は「逐次ラッチ `_highestStepIndex` より後ろに `thrust > 0` の行が残っている」こと。行は順にしか到達しないため、後続行は自身の条件成立済みでも、先行行がブロックしていれば保留とみなす。

### 4.6 燃料種変更時の推力クランプ（G2-05、Rev 6 L271 の補完）
- `rlFuelType` 変更時の TWR 保護は `stg.thrustKN = Math.min(Math.max(stg.thrustKN, minThrustKN), Math.max(THRUST_SLIDER_BASE_MAX_KN, Math.ceil(stg.thrustKN)))` とし、既に基準上限を超えている機体の推力を引き下げない。`THRUST_SLIDER_BASE_MAX_KN = 10000` は `RocketTab` のモジュール定数で、`_syncThrustSlider` と共用する。

### 4.7 Worker 実行時状態の保存・復元（G2-07、Rev 6 F5-04 表への追補）
- 毎フレームのバッファ（51 スロット）では運ばない Worker 専有状態は、**保存時に Worker へスナップショットを要求** して保存データに含める。
  - プロトコル: 主スレッド `CalcWorkerManager.requestRuntimeSnapshot()` → `{cmd: 'snapshotRuntime', requestId}` → Worker `PhysicsEngine.getRocketRuntimeSnapshot()` → `{cmd: 'runtimeSnapshot', requestId, rockets: [{id, runtimeState}]}`。Worker メッセージは順序保証され、`update` バッファは受信時に同期適用されるため、応答受信時点の主スレッド状態と整合する。応答が `SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS = 2000` ms 以内に来なければ `null`（実行時状態なしで保存。従来互換）。Rev 6.11（G3-1-01）: 応答の `rockets` は互換のため名前を据え置き、中身は生存している全オブジェクト（ロケット・天体・デブリ）とする。`getState` は天体・デブリにも、スナップショットに項目があるときだけ `runtimeState` を出力し、`loadState` はそれを `add` メッセージにだけ付ける（主スレッドのオブジェクトには保持しない）。
  - `SaveManager.save()` は `universe.captureRuntimeSnapshot` があればスナップショット取得後に書き出し、なければ同期で書き出す（戻り値は `Promise<void>`）。`Universe.getState(runtimeSnapshot)` → `ObjectManager.getState(runtimeSnapshot)` が ROCKET ごとに（Rev 6.11 からは天体・デブリにも）`runtimeState` を出力する。
  - `runtimeState` の内容:
    - `flightComputer`: `flightTime`, `targetLaunchAngle`, `highestStepIndex`, `triggeredActionIndices[]`, `pendingActions[]`, `hasPassedApogee`, `apogeeTime`, `prevVv`, `maxRecordedQ`, `hasPassedMaxQ`, `maxQConfirmTimer`, `maxQStatusTimer`、Rev 6.11 で `currentThrustAngle`（レート制限された姿勢指令。ホールドダウン中はロケットの `thrustAngle` が射点に同期し直されるため同じ値ではない）, `isAntiStallActive`
    - `CalcRocket`: `isBoosterIgnited`, `boosterBurnTimer`, `boosterSepTimer`, `presState`, `presTimer`, `tankPresFuel`, `tankPresOxid`, `presStartF`, `presStartO`, `postSepRcsTimer`, `ullageRestartTimer`、Rev 6.11 で `thrustRatio`, `wasFiring`, `massLossRate`, `thrustForce`, `thrustForceVac`, `ispVac`, `ispSl`, `ofRatio`, `fuelType`, `hostAngleRad`, `ventStartF`, `ventStartO`, `noiseFiltF`, `noiseFiltO`, `paramName`, `kinematics{x, y, vx, vy, ax, ay, aero{currentQ, mach, qAxialKpa, qLateralKpa, aoaDeg, progradeAngle}}`
    - 天体（Rev 6.11）: `kinematics`（`aero` は `currentQ`, `mach`）、`mass`（Worker の単位）
    - デブリ（Rev 6.11）: `kinematics`、`parentRocketId`
  - 復元: `loadState` → `Rocket.runtimeState` → `_buildRocketPayload`（`restoredRuntimeState === true` のときのみ）→ `PhysicsEngine.addObject` → `CalcRocket` コンストラクタ末尾の `restoreRuntimeState()`。値は有限性・範囲（ステップ番号はプロファイル長以内、時間は非負）を検証してから適用する。
  - 復元値の検証（Rev 6.2）:
    - 時間系（`flightTime`、`apogeeTime`、各タイマ）は `[0, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S = 1e10]` に、タンク圧は `[0, 2 × TANK_PRESSURE_SIM.MAX_SCALE_KPA]` に丸める。
    - `presState` は `TANK_PRESSURE_STATES` の許可値のみ受理する（それ以外は初期値のまま）。
    - `triggeredActionIndices` は、現プロファイルで `action` を持つ行の番号のみ受理する。
    - `pendingActions` は、ラッチ済みの行の `action` に限り、行数を上限として受理する（プロファイルにないアクションは実行されない）。
    - Rev 6.11 の項目（G3-1-01）: `thrustRatio` は `[0, 1]`、`noiseFiltF`/`noiseFiltO` は `[-1, 1]` に丸める。推力・Isp・O/F・`massLossRate` は有限かつ 0 以上、角度（`hostAngleRad`・`currentThrustAngle`）は有限のときだけ受理する。`ventStartF`/`ventStartO` はタンク圧と同じ丸めで、`null` は未設定。真偽値（`wasFiring`・`isAntiStallActive`）は真偽値のときだけ受理する。`fuelType` は `ROCKET_FUELS` のキーのみ。`kinematics` は 6 値すべてが有限のときだけ受理し、空力の値は 1 つずつ検証する（`aoaDeg` は `[0, 180]`）。天体の `mass` は有限かつ正、デブリの `parentRocketId` は有限のときだけ受理する。Rev 6.11 の項目はすべて省略可能で、欠けた・不正な項目はコンストラクタの値のままとする（Rev 6.10 以前の保存データは例外なく読み込める）。`isBoosterIgnited` は、第 1 段で SRB が燃焼中なら従来どおり検証し、燃焼終了後・上段では保存値のままとする。
    - 保存した力の再適用（Rev 6.11）: `addObject` は、`kinematics` を持つオブジェクトの保存した加速度 a(t) と空力キャッシュを、後続の `add` による力の評価のあとに再適用し、最初の `_moveObjects` で終える（`kinematics` のない `add` があれば、その時点で終える）。
  - スナップショットなし（Worker 無応答）で保存した場合、ロード後は FC 時刻・ラッチ・ブースタタイマ・タンク圧状態が初期化される（劣化モード。従来互換）。
  - 継続の精度（Rev 6.11 で改訂、G3-1-01。Rev 6.10 の記述を置き換える）: 保存・読込を挟んだ飛行は、同じ時間刻み・同じ乱数列のもとで、中断しない飛行とビット単位で一致する。全 6 機体 × 射点（加圧後・点火後）・第 1 段燃焼中・SRB 燃焼中・SRB 分離直後・MECO・段間・第 2 段燃焼中・フェアリング分離後・ペイロード分離後・軌道投入後の 147 通りで、保存後 600 s の毎フレームと全オブジェクトの全項目を比較した。一致しないのは、物理・誘導が読まない `_restoredForces`、投棄物の名前、`hasPayloadPropulsion` の未設定と `false`、第 1 段分離後の `stages[0].dryMassT` と、射点のホールドダウン中に保存した飛行の解除前のフレームの `_half_vx`/`_half_vy` だけである（Rev 6.14、G3-2-05。読込で `addObject` が現在の速度を入れる半ステップの作業値で、保持中は更新も参照もされず、解除後の最初のステップで書き直されるため、位置・速度は一致する。integration 14 は解除の後のフレームから比べる）。Rev 6.10 に記した原因（重力だけから加速度を求めるため推力・抗力が入らない）は誤りで、実際の原因は次のとおりだった: (1) `_thrustRatio`・`_wasFiring` を保存せず、最初の半ステップの推力がなく、タンク圧のモデルが点火を誤検出した、(2) 抗力・空力キャッシュを保存した v(t+dt) で評価し直していた（抗力は入っていた）、(3) 位置・速度・天体の質量がピクセル・t との往復で最大 1 ulp ずれた、(4) 推進系の値・射点角・FC の姿勢指令を段の設定から求め直していた、(5) 投棄物が親ロケットを失い、フェアリング・SRB の分離直後に読み込むと最初のフレームで自分のロケットと衝突して質量と運動量を取り込んだ（既存の不具合）、(6) ペイロード分離後は名前でパラメータを引き直して見つからず、抗力と構造の上限を失っていた、(7) 受動ペイロードの乾燥質量 0 が既定値 1 になった、(8) `separateBoosters` が Worker でだけ行う第 1 段の乾燥質量の減算が失われた。実時間のアプリでは時間刻みが壁時計で決まり、タンク圧のノイズも乱数のため、中断しない飛行そのものは再現しないが、同じ時間刻みの列には同じ経過になる。テストはイベント時刻・軌道要素・Worker の全状態の完全一致で判定する（integration 14、回帰 10）。
- 最初の Worker フレームまで（Rev 6.12、§4.13-7）: 主スレッドの `Rocket.telemetry` は仮の値で、`status` の既定値は `FlightComputer` の初期値 `PRE_LAUNCH`（ホールドダウン中も同じ値を報告し、LIFTOFF は報告しない）とする。Rocket タブが一時停止している射点と、一時停止中の読込の直後は、この値を表示する。質量は §3.5-1 の再計算で、最初から Worker と同じ値になる。分離状態を表示に使う箇所（描画、STAGE 行の SRB タグ、2-SEP・P-SEP）は、オブジェクトの値を先に、テレメトリを代替として読む（§4.13-9）。状態の表にない値は PRE-LAUNCH と表示する（§4.13-13）。
- 主スレッドの時計と相対高度（Rev 6.13、§4.14-6）: T+ の音声の時計は Worker の MET（`telemetry.flightTime`、HUD と同じ）とする。相対高度の基準は射点の高度 `hostAltM + bottomOffsetM`（ホストのないロケットは最初のフレーム）とする。読込で主スレッドの `rocket.flightTime` を保存した実行時状態から設定する。
- DEBRIS の `debrisSubType` を `ObjectManager.addObject` で Worker へ転送する。
- `mach`・`rcsCw`・`rcsCcw`・`rcsUllage` は毎ステップ再計算される過渡値のため、Worker へは転送しない（Gate 1 WP2 の転送列挙から除外）。

### 4.8 パッドエフェクトの自転追従（G2-09）
- `PadEffectRenderer.update` はリフトオフ後、主スレッドで `omega * dt` を積分しない。Worker 由来の `host.rotationAngle`（SSOT）の前回値 `padRefRotationAngle` からの差分だけパッド位置・角度を回転させる。

### 4.9 不要コードの削除（G2-06）
- `normalizeRocketConfig` に追加していた未読出力 5 項目、`determineOptimalSubSteps` の到達不能なフォールバック（`SIMULATION.SUB_STEPS` を直接参照）、`_computeVisualLayout` の未使用戻り値 `totalLength`、`PresetManager` の重複 JSDoc を削除・統合する。

---

### 4.10 予測線の描画座標系（Rev 6.2 新設、G2-2-01）
- Rev 6 までは全点を地表固定の回転系（`phiSurf + host.rotationAngle`）で描いていた。この場合、ホスト離脱後の長期予測は自転で毎点 1〜3 rad 跳び、飛行中は遠方の線全体が自転とともに回る。そこで座標系を次のように確定する。
- **切替点**（Rev 6.3 で条件を拡張、G2-3-01）: 予測器は、次のいずれかが初めて成り立った以降の最初のサンプルで座標系を切り替える。
  - 軌道投入（`orbit` イベント判定 `isOrbital` が真）。
  - 大気上限（`ATM_LIMIT_ALT`、未定義なら `EVENTS.ORBIT_MIN_ALT_M`）より上で、ホストに対して `E >= 0`（離脱軌道）。
  - 大気上限より上で、高度が `TRAJECTORY_PREDICTION.FRAME_SWITCH.MAX_HOST_FIXED_ALT_M = 50,000 km` 以上。

  直接上昇型の離脱（接線速度が局所円軌道速度に届かない）でも、地表固定系のまま渦巻くことはない。切替後に再突入する高ロフトの弾道では、着地点が慣性系で描かれ、地表上の位置と `ω × (着地時刻 − 切替時刻)` だけずれる（許容）。
- **切替情報の出力**: `frameSwitchTime`（切替サンプルの時刻。未投入なら `null`）、`frameSwitchHostRot`（その時刻のホスト自転角 `hostInitRot + ω t`）、`hostOmega` を結果に出力する。Worker 経路でも同じフィールドを引き継ぐ。
- **描画**（`TrajectoryPredictor.renderTrajectory`）:
  - 基準自転角: `frameRefRot = host.rotationAngle − (flight モードかつ切替あり ? hostOmega × max(0, currentFlightTime − frameSwitchTime) : 0)`。飛行中は機体が切替時刻を過ぎた時点の自転角で凍結される。
  - `time <= frameSwitchTime` の点（および切替なしの全点）: 地表固定系。描画角 `phiSurf + frameRefRot`。上昇軌跡が射点・地表に追従する。
  - `time > frameSwitchTime` の点: ホスト中心の慣性系。`(relX, relY)` を一定角 `frameRefRot − frameSwitchHostRot` だけ回転して描く。切替点では両式が一致するため、線は連続する。
  - プレビュー（射点待機中）では、線全体が射点とともに剛体回転する（「いま打ち上げた場合」の軌道）。飛行中の切替後は、遠方の線が宇宙空間に固定される。
  - 飛行中、機体が切替時刻に達するまでは、遠方の線も射点とともに剛体回転する。回転量は最大 `ω × frameSwitchTime`（Rev 6.4 で数値を訂正、G2-4-02。実測: LEO h3_30 0.044 rad、LEO falcon9 0.090 rad、LEO h3_22 0.120 rad、ISS h3_22 0.138 rad、ISS h3_30 0.166 rad、ISS h3_24 0.176 rad）。この間も、機体は常に描画された予測線上にある（地表固定系の部分は時刻 τ の点が機体位置と一致する）。機体が切替時刻を過ぎると、線全体が宇宙空間に固定される。
  - `r/phiSurf` を持たない旧形式の予測は、従来どおり `rotationOffset` で回転する。
- **水平適用**:
  - イベントマーカー: 同じ規則を `ev.time` で適用する。
  - 実飛行経路: `Rocket._recordActualFlightPath` は各点に記録時の飛行時刻 `time` を付ける。切替後に記録された点は、記録時の慣性オフセット `(relX, relY)` をそのまま描く（凍結後の描画座標系と一致する）。切替前の点は `phiSurf + frameRefRot` で描く。
  - 実飛行経路の記録判定（Rev 6.3、G2-3-03）: 新しい点を記録するかどうかは、その点が描かれる座標系での移動量で判定する。機体の `predictedTrajectory.frameSwitchTime` を過ぎていれば慣性オフセット `(relX, relY)` の差、それ以外は地表固定系の差を `ACTUAL_SAMPLE_MIN_DIST_M` と比較する（地表に対して静止する静止軌道付近でも記録が止まらない）。

### 4.11 破壊時の予測打ち切り（Rev 6.2 新設、G2-2-02）
- 主ループは各ステップで `rocket.collided || rocket.shattered` を検査し、真なら `breakup` イベント（`id: 'breakup'`、`name: 'BREAKUP'`、`type: 'impact'`）を登録して打ち切る（`endReason: 'breakup'`）。イベントの時刻は条件が成り立った時刻とする。ステップの後に検出した場合はそのステップ後の時刻、主ループの前（t = 0）に既に成り立っている場合（初期条件で荷重限界を超えているなど）は 0 とし、積分せずに初期点で打ち切る（点は初期点 1 個、`steps` 0、`maxSimTime` 0、`maxAltM` は初期点の高度。要求期間が 0.01 s 以下でも `breakup`。Rev 6.12、§4.13-3）。ループ後の最終点は破壊位置で 1 回だけ出力する。破壊後の静止した残骸が直線として描かれることはない。
- 既存の「軌道到達時は impact ルールのイベントを抑止する」処理は削除する（Rev 6.3）。衝突イベントは必ずループ打ち切りと同時に登録され、`endReason === 'impact'` のときに限って存在する。抑止処理は、軌道到達後の減衰による実際の衝突を隠すだけだった。

### 4.12 予測の計算予算（Rev 6.2 新設、Rev 6.6 で置き換え、Rev 6.8 で上限・基準を改訂、Rev 6.9 で計測方法と実測を訂正、G2-2-04・G2-6-01/02・G2-8-03・G2-9-02。Rev 6.19 で計測の分割実行を追加、Rev 6.20 で構成の完全性の検査を追加、Rev 6.21 で受入基準 1 の比の扱いと回数の検査を明確化）
- **ステップ上限**（Rev 6.8 で 400,000 から変更、G2-8-03）: `TRAJECTORY_PREDICTION.MAX_STEPS_CAP = 340,000`。同期・非同期で同じ値を使う決定的な上限とする。`options.maxSteps`（テスト・ハーネス用。アプリの呼び出し経路は渡さない）は下限を引き上げるだけで、この上限は超えない（Rev 6.7、Iteration 7 Watchpoint 6）。点数も同様に、`options.maxPoints` は `MAX_POINTS` を下げる方向にだけ効く（Rev 6.8、G2-8-01）。どちらも `Number()` で数値化して正の値（`Infinity` を含む）のときだけ使い、それ以外（欠落・0・負値・`NaN`・数値でない文字列）は指定なしとして扱う（Rev 6.10。従来は数値でない文字列で予算が `NaN` になり、1 ステップも積分せずに `step_budget` で終わっていた）。これで主スレッドの同期予測（`rollout()`、Rocket タブを開いたとき、`calculate()` のフォールバック）のブロック時間を抑える。
  - 値の根拠: main は地球近傍の閉軌道を 3,000 点で打ち切り、そこまでに約 333,000〜360,000 ステップを使う。上限をこれと同程度にして、ステップ数の比をほぼ 1 にする。400,000 ではステップ数の比だけで約 1.2 倍になり、Sun+Earth で main 比 1.54 倍に達した（Iteration 8）。
  - 到達範囲（Sun+Earth、1 ヶ月以上）: LEO 33,358 s、ISS 33,262 s、GTO 133,707 s、月遷移 1,203,081 s（main は LEO 32,758 s、ISS 32,579 s、GTO 35,439 s、月遷移 36,552 s）。地球近傍の閉軌道は main と同程度、GTO と月遷移は main より長い。飛行中は最終点の時刻で予測線が消える（LEO・ISS 0.38〜0.39 日、GTO 1.55 日）。予測線を飛行中に延ばす機能は別の課題とする（§4.3）。
- **ステップ下限**: `MAX_STEPS = 120,000`（main は 100,000）。最短期間 0.2 ヶ月でも GTO が座標系切替後に 1 周以上を描画するための値。`MAX_STEPS = 100,000` でも 0.2 ヶ月（525,960 s）の実効予算は `ceil(525,960 / 5) = 105,192` ステップになるが、このとき GTO の切替後の描画上の回転量は 0.949 周にとどまる。120,000 では 1.32 周（Rev 6.7 で数値を訂正。Iteration 7 Watchpoint 2、`e3b_rev_definition.mjs`。独立監査2 の作業領域のスクリプトで、リポジトリにはない）。0.2 ヶ月の予測はこの下限で予算が決まる（main の実効予算 105,192 ステップに対して 120,000、比 1.14）。このため、0.2 ヶ月の ISS・GTO・月遷移が main 比の最も大きい構成になる（下記。Rev 6.9 で訂正、G2-9-02）。
- **1 ステップあたりの処理の削減**（Rev 6.8、G2-8-03）: 予測結果を変えずに、ループ内の処理を減らす。
  - 予測用の `CalcRocket` は RCS の演出状態を更新しない（`trackRcsVisualState: false`。`_updateRcsState` を呼ばないため、`rcsCw`・`rcsCcw`・`rcsUllage` は `false` のままで、タイマーも減算しない。分離・再点火の処理はタイマーに初期値を設定するが、参照されない）。これらは描画と Worker ブリッジのフラグだけが読み、物理は読まない。通常のシミュレーションでは従来どおり更新する。
  - サンプラー: ループ内で不変の `SAMPLING`・`EVENTS` の定数と `mu` をループの外で 1 回だけ求める。ステップ冒頭の距離は前ステップの値を使う（位置は `engine.step()` の中でしか変わらない）。同じ `atan2` の重複を除く。速度イベント・円軌道速度・ホスト基準のエネルギーは、必要なとき（速度イベントがある、軌道未到達、座標系の切替前）だけ求める。汎用イベントの判定は alt/time/vel 型の規則だけを回す。速さの閾値は二乗で比べる。
  - 確認: 5 ワールド × 7 構成（`d2_sync_equal_trees.mjs`。独立監査2 Iteration 9 の作業領域のスクリプトで、リポジトリにはない。工程 3・4 では、作業者の作業領域のスクリプト `perf/d2.mjs`（5 ワールド × 7 構成の同期予測の結果全体の md5 を出力する）の出力の md5 が独立監査3 Iteration 1 以来の値と一致することを確かめた（テスト計画 §5））で、変更前後の同期予測の結果全体（JSON）の md5 が一致する。独立監査2 Iteration 9 では、上限をそろえた比較で 5 ワールド × 7 ミッション × 7 期間 × 8 方位の 1,960 件と、追加の経路・イベント・ホスト・衝突の 1,354 件がすべて一致した。ただし一致は実測によるもので、速さの閾値を二乗で比べる変更は、境界のごく近く（相対 5e-15 程度）では判定が入れ替わり得る。
- **安定周回の打ち切りは行わない**（§4.3）。Rev 6.2〜6.5 の `SETTLED_ORBIT` 定数、潮汐比・ヒル半径・外挿による判定、`FlightComputer.hasAnyScheduledAction()`、`settled_orbit` 終了理由はすべて削除する。
- **受入基準**（`rollout()` の同期ブロック時間。Rev 6.8 で設定、Rev 6.9 で計測方法を定義、G2-8-03・G2-9-02）:
  1. main 比 1.5 倍以内: 全ワールド（Sun+Earth、7 天体ワールド、アプリの `SOLAR_SYSTEM`・`BINARY_SYSTEM`・`THREE_BODY` 配置）・全期間。
  2. 絶対値: 7 天体ワールドで最悪 2 秒以内、Sun+Earth で最悪 1 秒以内（利用者が Rocket タブを開いたときなどに感じる停止時間）。`SOLAR_SYSTEM` は main 自体が 3 秒前後かかるため、比だけで判定する。
  - **計測する構成**: 7 ミッションのプリセット（機体・ペイロードは §4.3 の表のとおり）× 期間 × 打上げ方位 4 通り（0°/90°/180°/270°）× 上記 5 ワールド。期間は、地球近傍の 4 ミッション（LEO・ISS・GTO・月遷移）が既定・0.2・0.5・1・12・36 ヶ月、深宇宙の 3 ミッションが既定・0.2・1・36 ヶ月（重複を除き 1 ワールドあたり 124 構成）。経路は `ObjectPlacer`（`SOLAR_SYSTEM` などは `deployProfile`）→ `PresetManager.applyToLauncher` → `RocketLauncher.rollout()`。
  - **回数と順序**: ワールドごとに本ブランチと main を交互に実行し、回ごとに先後を入れ替える。Sun+Earth・7 天体は 6 回以上、他は 3 回以上。
  - **負荷**: 回ごとに 1 分平均の load average を記録する。規定回数のうち半数以上は load average 2.0 以下（16 コア）で実行する。高負荷の回は時間を延ばす方向にだけ働き、下記の最小値による統計量にはほとんど影響しないため、除外はしない。
  - **分割実行**（Rev 6.19）: 回は 1 回ずつ別の実行に分けてよい。`testsuites/perf/rollout_timing.mjs --state <ファイル>` は、終わった回（両ツリーの全構成の値と、各ツリーの計測の直前の load average）をファイルに保存し、同じファイルでの次の実行が続きの回から測る（回の番号で先後の入れ替えを続ける）。`--max-rounds <n>` は 1 回の実行で測る回数の上限（`0` は評価だけ）。負荷の条件を満たさないワールドは、高負荷の回を除外せずに残したまま回を足す（足した回も上の回数の規定の「以上」に含まれる。上限は `--max-total`、既定は規定回数の 3 倍で、上限に達しても満たさなければ負荷の条件を満たさないと判定する）。これにより、別の処理で負荷が上がっても、やり直すのはその回の分だけになる。統計量・余裕・受入基準は、保存したすべての回に対して上の定義どおりに求める。ファイルには両ツリーの指紋（`scripts/`・`presets/`・`testsuites/test_helpers.mjs` の md5）、計測コードの指紋、方位を記録し、どれかが変わった状態での再開は拒否する（違うコードで測った回を混ぜない）。**完全性**（Rev 6.20、G4-1-02）: 各回は、両ツリーが上の構成（4 方位で 124）をちょうど 1 回ずつ、有限で負でない時間とともに持たなければならない。計測した回がこれを満たさなければ保存せずに計測の誤りとして止め、保存した回は読込で同じ検査を行う（先後が回の番号どおりであることと、負荷の標本が 2 つあることも検査する）。受入基準 2 は本ブランチの全構成の最小値の最大で、main の値を使わない（従来の実装は main の値がない構成を受入基準 2 からも除いていた。工程 4 の 21 回は全回で両ツリーが 124 構成を持ち、値は変わらない）。`--max-rounds` は 0 以上、`--max-total` は 1 以上の整数で、どちらも `--state` が必要。`--rounds-heavy` は 6 以上、`--rounds` は 3 以上の整数（Rev 6.21。従来は小さい値を黙って下限に直していた）。それ以外は使い方の誤り。環境変数 `ROLLOUT_TIMING_TEST_LOAD`（数、または `@<ファイル>` で標本ごとにファイルの内容を読む）は計測スクリプト自身のテストのためだけに負荷の標本を置き換え、その値を状態ファイルに記録する（実際の計測の状態と混ざらない）。判定と分割実行の規則（回数と先後、回数の下限、構成と回の完全性、最小値の比、受入基準 1・2 とそれぞれの終了コード、負荷の条件、余裕と全回・前半・後半の変動、ツリーと計測コードの指紋、状態ファイルの保存・再開・拒否、計測のループが記録した先後のとおりに各ツリーをそのツリーとワールドで測ること、回ごとの保存・先後の継続、負荷の標本が各ツリーの計測の前（前のツリーの後）に取られること、回数の上限）は `unit/11_perf_rollout_timing` で確かめる。ループは、子プロセスが自分のツリーの名前とワールドを記録する模擬のモジュールのツリーで実際に回す。実際の計測時間と負荷の値は確かめない（G4-1-01・G4-2-01）。
  - **統計量**: 構成ごとに本ブランチと main それぞれの全回の最小値をとって比を求め、全構成の最大を受入基準 1 の値とする（main の最小値が正でない構成は比を無限大とし、受入基準 1 を満たさない。Rev 6.21、G4-2-02）。受入基準 2 は、構成ごとの本ブランチの最小値の最大とする。
  - **余裕**: 基準と統計量の差が、統計量自体の変動を上回ることを求める。統計量自体の変動は、全回・前半の回（先頭から floor(回数 / 2) 回）・後半の回（残りの回）のそれぞれで同じ統計量を計算し、その最大と最小の差とする（Rev 6.11 で定義を明確化、G3-1-08。`testsuites/perf/rollout_timing.mjs` はこの定義で計算する。Iteration 9 の計測にこの定義を当てはめると SE 0.051、W7 0.038、`BINARY_SYSTEM` 0.129、`THREE_BODY` 0.032、`SOLAR_SYSTEM` 0.033 で、どのワールドでも余裕（0.206〜0.299）を下回る。同じ回の対の比のばらつきは、最小値を使う統計量の変動より大きいため、比較対象にしない）。
- **実測**（独立監査2 Iteration 9 による、上記の方法での計測。`gate2_it9/t9_rollout.mjs`（独立監査2 の作業領域のスクリプトで、リポジトリにはない。工程 4 の計測は `testsuites/perf/rollout_timing.mjs` で行い、テスト計画 §5 に記録した）。Sun+Earth・7 天体は 6 回、他は 3 回。load average 1.05〜2.03／16 コア、ただし 3 回目の Sun+Earth・7 天体・`BINARY_SYSTEM` は 1.6〜4.35。表は構成ごとの最小値（本ブランチ／main、ms）の行内の範囲と、行内の比の最大）:
  | 構成 | Sun+Earth（6 回） | 7 天体（6 回） | `BINARY_SYSTEM`（3 回） | `THREE_BODY`（3 回） | `SOLAR_SYSTEM`（3 回） |
  |---|---|---|---|---|---|
  | `leo_250km` 既定（0.2 ヶ月） | 129〜168／114〜143（1.18） | 198〜261／173〜227（1.24） | 208〜244／172〜212（1.22） | 176〜216／153〜181（1.19） | 560〜636／535〜589（1.15） |
  | `iss_rendezvous` 既定（0.3 ヶ月） | 304〜336／281〜326（1.10） | 515〜540／472〜509（1.10） | 459〜489／441〜467（1.05） | 392〜435／382〜415（1.07） | 1,392〜1,464／1,343〜1,396（1.05） |
  | `gto_insertion` 既定（0.5 ヶ月） | 494〜515／469〜474（1.09） | 832〜859／776〜786（1.10） | 759〜770／724〜734（1.06） | 651〜672／645〜651（1.04） | 2,296〜2,303／2,203〜2,252（1.04） |
  | ISS・GTO・月遷移 0.2 ヶ月 | 230〜245／187〜193（**1.29**） | 382〜394／313〜318（**1.26**） | 349〜357／290〜300（**1.23**） | 297〜312／257〜265（**1.21**） | 1,047〜1,073／880〜925（**1.20**） |
  | LEO・ISS・月遷移 0.5 ヶ月 | 271〜530／260〜481（1.15） | 496〜859／456〜789（1.12） | 446〜781／426〜736（1.11） | 378〜683／361〜646（1.07） | 1,307〜2,342／1,299〜2,299（1.07） |
  | `leo_250km` 1〜36 ヶ月 | 346〜354／327〜337（1.08） | 632〜652／575〜586（1.13） | 563〜585／532〜546（1.09） | 480〜494／454〜470（1.08） | 1,680〜1,719／1,656〜1,682（1.03） |
  | `iss_rendezvous` 1〜36 ヶ月 | 640〜652／586〜600（1.10） | 1,079〜1,096／983〜997（1.11） | 972〜992／913〜928（1.08） | 841〜854／801〜826（1.07） | 2,973〜3,048／2,793〜2,908（1.08） |
  | `gto_insertion` 1〜36 ヶ月 | 645〜677／633〜646（1.07） | 1,081〜1,100／1,060〜1,075（1.04） | 980〜1,002／990〜1,014（1.01） | 832〜863／868〜884（0.99） | 2,975〜3,003／3,018〜3,098（0.99） |
  | `lunar_insertion` 1〜36 ヶ月 | 497〜690／653〜669（1.04） | 1,105〜1,122／1,089〜1,108（1.02） | 748〜1,018／1,022〜1,036（0.99） | 664〜896／887〜912（1.01） | 2,188〜3,039／3,104〜3,311（0.98） |
  | 深宇宙 3 ミッション 0.2 ヶ月 | 166〜192／188〜199（0.86〜1.01） | 271〜305／308〜328（0.87〜0.98） | 242〜276／287〜298（0.81〜0.93） | 212〜242／249〜268（0.82〜0.94） | 734〜824／907〜936（0.80〜0.89） |
  | 深宇宙 3 ミッション 1〜36 ヶ月 | 176〜222／596〜665（0.27〜0.35） | 288〜349／989〜1,074（0.27〜0.35） | 256〜338／900〜1,019（0.26〜0.34） | 225〜283／794〜900（0.26〜0.35） | 762〜927／2,900〜3,191（0.24〜0.31） |
  - 受入基準 1: 最大比は Sun+Earth 1.294（`lunar_insertion` 0.2 ヶ月・270°）、7 天体 1.258（`iss_rendezvous` 0.2 ヶ月・90°）、`BINARY_SYSTEM` 1.228、`THREE_BODY` 1.211、`SOLAR_SYSTEM` 1.201。どのワールドでも最大になるのは 0.2 ヶ月の ISS・GTO・月遷移で、ステップ下限（120,000 対 main の 105,192）による。上限 340,000 に達する構成は 0.94〜1.13 倍。基準との差は 0.206 で、統計量自体の変動（部分集合での差。Sun+Earth 1.29〜1.35、7 天体 1.25〜1.31、変動 0.05〜0.13）を上回る。
  - 受入基準 2: Sun+Earth 690 ms（単発の最大 882 ms）、7 天体 1,122 ms（単発の最大 1,449 ms、load average 4.4 の回）。`SOLAR_SYSTEM` の最悪は 3,048 ms で、main（3,311 ms）と同程度。
  - 深宇宙 3 ミッションは、1〜36 ヶ月で main の 0.24〜0.35 倍、0.2 ヶ月で 0.80〜1.01 倍。main はこれらを 3,000 点まで細かく積分するが、本ブランチは要求期間までを約 10 万ステップで描く。

### 4.13 本ブランチで修正した既存の不具合（Rev 6.11 で対象外として記録、Rev 6.12 で利用者の判断により範囲に加えて修正）
- **経緯**: 工程 3 のテスト作成で、main でも同じように起きる既存の不具合が 8 件見つかった。Rev 6.11 では、要件 5 の「全残存バグ」「保存復元全項目」を §3.5 の項目に限ると解釈して対象外とした（独立監査3 Iteration 1 Watchpoint 8）。利用者の判断（2026-11-21）で 8 件とも本ブランチの範囲に加えて修正した（Rev 6.12）。修正の作業中に見つかった同じ種類の不具合も、同様に修正する（§4.13-9 以降）。
- **修正した不具合と仕様**:
  1. **ホールドダウン中のロケットとホストの衝突**（要件 1）: `SimulationController.update()` はフレームごとに 1 回、各物体を `x + v t + a t²/2` でフレーム長 `totalDt` まで外挿して衝突を判定する。ホールドダウン中のロケットの `a` は、最初のホールドダウン同期の後はホストと同じだが、`PhysicsEngine.addObject()` の力の評価の直後（配置、実行時状態のない読込、保持中の別の `add`）はホストへの重力のままで、長いフレームでは外挿が地表の下に入り、衝突と判定されていた（射点高度 10 m で約 1.5〜32,000 s のフレーム、0 m では通常のフレームでも）。仕様: ホールドダウン中のロケット（`isHoldDown` が真で、`hostId` の天体に `_updateHoldDownPositions` が固定する条件。`PhysicsEngine._isHeldOnHost`）とそのホストの組は、衝突判定から除く。フレームの長さによらずホストとは衝突しない。他の天体・デブリ・ロケットとの衝突、および解除後のホストとの衝突は従来どおり判定する。最初の同期の後のフレームでこの組が衝突と判定されることはないため、通常の経路の結果は変わらない（§3.1.1-2）。
  2. **物理ループの起動判定**: `gravsim_calc.js` は、評価している専用 Worker のエントリスクリプトであるとき（`self.location.href` と `import.meta.url` がフラグメントを除いて一致。クエリ `?v=…` は含めて比べる。`isPhysicsWorkerEntry`）だけ `SimulationController` を起動する。物理 Worker（`Universe` が `./scripts/gravsim_calc.js?v=<時刻>` で作る）だけが該当し、予測用 Worker（エントリは `gravsim_calc_predictor.js`）、主スレッド（`self.document` がある）、Node（`self` がない）では起動しない。従来は予測用 Worker でも空のエンジンのループが動き、毎秒約 60 回の `update` を送っていた（主スレッドの `TrajectoryPredictor` は無視していた）。
  3. **予測の `steps` と t = 0 の `breakup`**（要件 1）: §4.3・§4.11 のとおり。`steps` は実際に積分したステップ数とし、t = 0 で既に破壊されている機体は時刻 0 の `breakup` で初期点だけを出力する。アプリの経路で変わるのは `steps` だけで、4 ワールド × 7 ミッション × 7 期間 × 8 方位の 1,568 構成のうち 3 構成で 1 減る（`solar_escape` 0.2 ヶ月。点・時刻・イベントは不変）。
  4. **読込で時間倍率とズームが戻らない**（要件 5）: `ControlPanel.getState()` は git 0adb139（タブ分割）以降 `{ controlPanel: { timeScaleVal, zoomScaleVal } }` を保存するが、`loadState` は直下を読んでいた。仕様は §3.5-1 の `controlPanel` の行。
  5. **ミッションを変えても予測期間のスライダと表示が動かない**（要件 4）: `applyToLauncher` が変えた予測期間をスライダに書く経路がなかった。仕様は §3.4-4 の「予測期間スライダの同期」。
  6. **ペイロード分離後の段表示が「3 / 2 (UPPER)」になる**: 分離後の段番号は段数（最後の段の次）になるが、HUD にその場合分けがなかった。推進カードの見出し（`STAGE 3`）と推進剤バーの満量も同じ原因だった。仕様は §3.4-1 の「ペイロード分離後の HUD」。
  7. **射点で HUD が「LIFTOFF」と表示される**: 主スレッドの `Rocket` のテレメトリの既定の `status` が 0（LIFTOFF）で、Rocket タブが一時停止している間は Worker のフレームが来ないため、点火までそのまま表示されていた。仕様は §4.7 の「最初の Worker フレームまで」。
  8. **読込直後の質量表示**（要件 5）: `Rocket.mass` がフェアリングの分離を毎フレームのテレメトリ（最初のフレームまでは仮の値）から読んでいたため、フェアリング分離済みのロケットを読み込むと 1 フレームだけフェアリング込みになった。また、自走ペイロードの分離後は `payload.massT` を二重に足していた（main でも常時。HTV-X で Worker の 4.5 t に対して 9.43 t）。仕様は §3.5-1 の ROCKET の行（`Rocket.mass` の再計算）。
- **修正の作業中に見つかり、同様に修正した不具合**:
  9. **読込直後の STAGE 行の SRB 表示**（要件 5）: 最初の Worker フレームまでのテレメトリ（§4.7）は分離フラグを持たないが、`formatStageInfo` は SRB タグをテレメトリだけから読んでいたため、SRB の燃焼終了後・分離後に保存した H3 を一時停止中に読み込むと、最初のフレームまで `[+SRB]` になった。仕様: SRB タグは、ロケットが保持し保存する `isBoosterSeparated`・`isBoosterBurnout` を先に、テレメトリを代替として読む（分離が燃焼終了に優先する）。`RocketRenderer` はフェアリング・ペイロード・SRB・段番号を既に同じ規則で読んでおり、最初のフレームの前も飛行中と同じに描く（描画の不具合は起きていなかった）。`TrajectoryPredictor.updateRocketFlightEvents` のフェアリングのイベントはテレメトリだけを読むが、読み込んだロケットは予測線を持たず、射点では欠けた値が実際の状態と同じため、変更しない。
  10. **Rocket タブを閉じても開く前の表示に戻らない**: `open()` が射点の準備（最小の時間倍率・ホストに合わせたズーム・ホストの追尾）の後に保存していた（git 1bd9842 で順序が入れ替わった。1fbd7dd は先に保存していた）。仕様: `open()` は、タブが閉じていたときだけ、準備の前に時間倍率・ズーム・カメラの対象とオフセットを保存する（開いているタブの再クリックでは上書きしない）。対象がなければ戻さない。ズームを戻すときは `camera:zoom-changed` でスライダと表示も合わせる（git 8fa926d で抜けていた）。`deferViewState` の規則（§3.5-1）は変えない。
  11. **予測期間が保存されない**（要件 5）: 仕様は §3.5-1 の `rocketLauncher` の行。
  12. **テレメトリがないときの HUD の状態欄**: `_resetPinnedHeader` が `STATUS_MAP[6]` を書いていた（git 82f8860 で TRACKING を指していたが、bd61960 で状態を −1〜5 に振り直したときに未定義になった）。仕様: ロケットのテレメトリがないときは `STATUS_MAP[STATUS.TRACKING]`、MET は `T+ ---y ---d --:--:--`、STAGE は `---` を表示する。
  13. **状態コードでない値の HUD の状態欄**: `_updatePinnedHeader`・`_updateMinimalHud` は、状態の表にない値（`undefined`・`NaN`・範囲外・小数。`FlightComputer` は報告しない）を `STATUS_MAP[0]` で表示していた（git 82f8860 で `MISSION_STATUS.PRE_LAUNCH` を置き換えたときは 0 が PRE-LAUNCH だったが、bd61960 の振り直しで LIFTOFF になった。9efd5e3 が最小表示に写した）。仕様: `STATUS_MAP` の自身の項目でない値は `STATUS_MAP[STATUS.PRE_LAUNCH]`（`FlightComputer` の初期値）を表示する（`TelemetryPanel.formatMissionStatus`）。AUTO-SEQUENCE／AUTO-SEQ に置き換えるのは（§4.13-21 の正規化の後の）`PRE_LAUNCH` だけとする。`STATUS_MAP` を数値の直値で引かない。
  14. **アナンシエーターの使われない入力**（要件 5、デッドコード）: 主スレッドに届かない値を読む項が 3 つあり、常に偽だった。(a) 1-SEP・2-SEP の点滅（`tm.isStgSepActive`。git 5f0628d の Worker のタイマー `stgSepLampTimer`（分離から 3.5 s）とスロット `TM_STG_SEP_ACTIVE` を e49d500 が削除し、読む側だけが残った。主スレッドの値では作れない（段間の惰行は全プリセットで 2.0 s、ペイロード分離にはない）。また元の式は、第 1 段の分離で 2-SEP を点灯・点滅させていた）。(b) WARN の推進剤残量の項（`target.maxFuel` は設定されない。`isIgnited` がないと `undefined` になり、毎回ランプを反転させた）。(c) PRESS の `target.presState`（Worker にだけある）。(b)(c) は git c98ddf9 から。仕様: 3 つとも削除し、`MULTISTAGE_ROCKET.STG_SEP_LAMP_DURATION_SEC` も削除する。1-SEP は段数 ≥ 2 かつ段番号 ≥ 1、2-SEP は段数 ≥ 2 かつ（段番号 ≥ 2・第 2 段分離・ペイロード分離のいずれか）で点灯し、点滅しない。WARN は Q-LIM・G-LIM・STALL のいずれか（点灯中は点滅）。PRESS はテレメトリの両タンク圧が `TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA` 以上。点灯の値は真偽値とする（`classList.toggle` の第 2 引数が `undefined` だと反転するため）。推進剤残量の警告が必要なら、新しい設計として定める。
  15. **ロールアウト中・シーケンス中に Rocket タブを閉じたとき**: 自動追尾なしでロールアウト済みかシーケンス実行中の分岐は、実時間を代入しながら適用していなかった（git e02858f／3734026 は適用していたが、5998ab1 が戻す呼び出しを else 側へ移した）。仕様: 点火ボタンと同じ打上げの表示（`RocketTab.applyLaunchView`）とする。時間倍率は実時間、カメラの対象・オフセット・ズームはそのままとし、開く前の値は以後戻さない。タブのボタンはロックされるため、UI からは到達しない。
  16. **読込・削除の後のカメラの対象**: `restoreCameraTarget` は、`open()` で保存したオブジェクトが置き換え・削除された後でも追尾し直していた。仕様: 同一の参照が `universe.objects` にあるときだけ、対象とオフセットを戻す（id では判定しない。読込は保存した id で新しいオブジェクトを作るため、同じ id が別の天体を指し得る）。戻さないときは、読込（`centerObjectId`・`cameraOffset`）またはタブが設定した対象のままとする。
  17. **ミッションの予測期間の検証**: `applyToLauncher` は真の値なら何でも代入していた。仕様: §3.5-1 の `rocketLauncher` の行と同じ規則を、同じ実装（`gravsim_preset_manager.js` の `normalizePredictionDurationMonths`・`applyPredictionDurationMonths`。`RocketLauncher.loadState` も使う）で適用する。無効な値なら使用中の期間のままとする。
  18. **予測期間の範囲の定数**: `TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS`（0.2）・`MAX_DURATION_MONTHS`（36）とし、`index.html` の `#pred-duration` の min・max と一致させる（テストで確かめる）。
  19. **Navigation & Camera カードの REF BODY が常に「---」**: git 9efd5e3 から `NavigationCameraCard` は Worker のオブジェクト参照 `dominantBody` を読んでいたが、主スレッドに届くのはバッファの ID（`dominantBodyId`、なしは −1）と `distToDominantM` だけである。仕様: REF BODY は、数値の `dominantBodyId` と ID が厳密に一致する宇宙の天体（CELESTIAL）の名前とし、それ以外（−1・数値でない・該当なし・天体でない）は「---」とする（`NavigationCameraCard.resolveDominantBody`。ID 0 も天体として扱う。カードは `TelemetryPanel` から宇宙を受け取る）。
  20. **実時間が 0.998 倍で進む（ブラウザ）**: 実時間の指数は log10(1/(365.25×86400)) = −7.4991… である。git e02858f はこれを直接シミュレーションに与えていたが、git 8fa926d で `ui:set-time-scale` がスライダに書いて読み直す形になり、`#time-scale`（最小 −7.5、刻み 0.1）が −7.5 に丸めたため、点火ボタン・`LaunchSequencer.start`・射点のまま Rocket タブを閉じる操作は 10^−7.5 × 31,557,600 = 0.998 s/s で進んでいた（表示は「1.00 sec/sec」）。仕様: `SystemTab` は、コードが指定した指数（実時間・Rocket タブの復元・読込）をそのまま与え（`applyTimeScaleExp`）、スライダは最も近い刻みを表示する。スライダがその刻みを表示している間は、その指数を時間倍率とする（`getTimeScaleExp`）。`input`・`ui:set-time-scale-min`、またはスライダに別の刻みが書かれたときは、スライダの値に戻る。`ui:set-time-scale` は有限の数値だけを受け、スライダの範囲に丸め、それ以外は何も変えない。`RocketTab.saveTimeScale` は `ControlPanel.getTimeScaleExp()` を保存する（`log10(10^0.3) = 0.29999999999999993` のずれを避けるため）。`index.html` の範囲と刻みは変えない（実時間はどの 10 進の刻みにも乗らない。`step="any"` は操作感と保存値を変え、最小値の変更は −1 などを刻みから外すため）。
  21. **状態でない値の扱いの統一**: §4.13-13 はヘッダと最小 HUD の文字だけを直したが、アナンシエーターは PRE_LAUNCH 以外を打上げ後とみなし（TWR-C・PITCH・ORBIT・1-ENG・MECO・2-ENG・SECO）、AUTO-SEQUENCE と MAX-Q の色・警告は元の値で比べ、"2" などの文字列はヘッダでだけその状態になっていた。仕様: パネルで状態を読む箇所はすべて `TelemetryPanel.normalizeMissionStatus` を通す。`TELEMETRY.STATUS` の数値と厳密に等しい値（−0 は 0）以外は PRE_LAUNCH とする。自動シーケンス中は、そのような値も AUTO-SEQUENCE／AUTO-SEQ と表示する（§4.13-13 の「置き換えるのは PRE_LAUNCH そのものだけ」を、正規化した後の PRE_LAUNCH に改める）。
  22. **状態の数値リテラル**: `TM_STATUS = tm.status || 0`（git c176196。0 は bd61960 以降 LIFTOFF）、`approach_maxq` の `value: 2`（9f83252、2 規則）、`ObjectManager` の `curStatus === 3`（e49d500、3 箇所）を `TELEMETRY.STATUS` の名前に置き換える。仕様: Worker の状態が有限の数値でないとき（FlightComputer のテレメトリがない場合。CalcRocket は必ず持つ）は、主スレッドの仮の値（§4.7）と同じ PRE_LAUNCH を書く。報告された状態はそのまま書くため、通常の経路はビット単位で変わらない。非ロケットの `TM_STATUS` の 0 は、主スレッドが読まない枠の埋め値のため変えない。
- **不具合の種類ごとの一括調査**（Rev 6.12）: 1 件ずつ直すと同じ種類の不具合が続けて見つかったため、次の 4 種類について `scripts/` の全箇所を機械的に洗い、すべて直した。種類ごとに、同じ型がまた入ったら気づけるように、ソースを走査するテスト（無害な箇所は明示した許可リスト）を置く（`regressions/16_preexisting_pattern_sweep`）。
  23. **Worker の物体だけが持つ項目を主スレッドが読む**: Worker 側で代入され、主スレッドの物体（`gravsim_object.js`・`ObjectManager`・`ObjectPlacer`・`RocketLauncher`）では代入されない項目（75 個）を機械的に列挙し、主スレッドのすべての読み出しを確かめた。(a) `SoundEffects.update` は轟音・超音速音を `!rocket.collided && !rocket.shattered`（git 0dbb27e。Worker の名前）で守っていたため、破壊・削除の後も軌跡が消えるまで `universe.objects` に残るロケットが鳴り続けた。仕様: `state === OBJECT_STATE.ACTIVE && !isDestroyed` のロケットだけを鳴らす。(b) **本ブランチの退行**: 衝突の記録（§3.1-3 の 2 パスの `updateObjectParams` で `ObjectManager` が写す）が `debrisMass`（`BUFFER_INDEX.DEBRIS_MASS`）を落としていたため、`DestructionManager` の質量が `NaN` になり、衝突で破片が作られなかった（main は解析した記録全体を渡していた）。仕様: 写す記録は、`DestructionManager` が読む項目をすべて持つ（既存のバッファの枠から運ぶ。枠は増やさない）。(c) `RocketRenderer._drawBoosters` の `rocket.isBoosterIgnited`（git 760e804）は主スレッドでは常に未定義で、代替の `!isHoldDown && isIgnited`（Worker の点火規則と同じ）を使っていた。無害だが、読み出しを削除してこの規則を直接使う。対象外（物体の項目ではないもの）: 解析した衝突の記録 `objData`、プリセット定義の `ispVac`・`ispSl`・`rotationPeriod`、物体でないクラスの自身の項目、Worker で動く `formatWorkerToMain`。
  24. **id 0 を「なし」と扱う**: id は 0 から振られる（読込はファイルの id を保ち、空の保存の読込でカウンタは 0 に戻る）。直した箇所: `SoundEffects._getActiveRocket`（`rocketId ||` で id 0 のシーケンサーのロケットを飛ばした）、`VisualEffectManager.update`（id 0 の射点の演出が止まらなかった）、Worker の `data.parentRocketId || null`・`deb.parentRocketId || null`・兄弟の判定（git e4dd777。id 0 のロケットが分離直後の第 1 段とフェアリングに衝突して取り込み、軌道が変わった。0 以外の id ではビット単位で同じ）、`deb.id || nextId`（等価）、`RocketTab._getDefaultHostId` の天体がないときの戻り値（0 → `null`。0 は別の物体の id になり得る）、`Rocket.draw` の `!predictedTrajectory.hostId`（無害）。いずれも `null`／`undefined`（番兵が −1 の項目は −1）との明示的な比較にする。
  25. **状態の正規化の共通化**: §4.13-21 の規則を `gravsim_utils.js` の `normalizeMissionStatus` に移し（`TelemetryPanel.normalizeMissionStatus` はこれを呼ぶ）、`TrajectoryPredictor.updateRocketFlightEvents`（生の値の `>=` で、"3"・6・2.5・`Infinity` が MAX-Q・MECO のイベントを通過していた）、`SoundSequencer` の `type: 'status'` の規則、`ObjectManager` の MECO・SECO・PECO の判定でも使う。Worker の `TM_STATUS` と主スレッドの `telemetry.status` は、値をそのまま運ぶ。
  26. **基準天体を特定できないときの距離**: Navigation & Camera カードは REF BODY を特定できないときも DIST REF を表示し、Navi タブは id が見つからないとき Ref Body・Altitude・Velocity を前の値のまま残していた（天体でない物体も基準にした）。仕様: どちらも `NavigationCameraCard.resolveDominantBody` で特定し、特定できなければ、カードは両方 `---`、Navi タブは `NONE`・`--- km`・`--- km/s` とする。
- **一括調査で種類に当てはまらなかった不具合**（Rev 6.12、利用者の判断で修正）:
  27. **「Sun は id 0」の前提**: `clearObjects` は id 0 を残し、カメラの代替と `_getDefaultHostId` は id ≠ 0 の天体を優先し、Rocket タブは id 0 のホストを既定のホストに置き換え、連星・三体の生成器は `objects[0]` を最初の星にしていた（git 386ca67・74c81a3・1bd9842・c3951b3・6aaaae7）。id 0 はページの最初の Sun だけが持つため、Reset の後は連星系が「Sun B」だけになり、自動で選んだ Sun が Earth を配置しても残り、利用者が選んだ「Sun (ID: 0)」は次の一覧の変化で置き換えられた。仕様: 世界の中心 `CelestialBody.isWorldCenter`（シミュレーションの中に物体がない世界（生きている物体（`isLiveObject`）が 0。一覧に残ってフェード中の除去済みの物体は数えない。Rev 6.14、§4.14-13）に最初に置いた天体。`Universe.reset()` の Sun）を持つ。消去はこれを残し、生成器は有効な中心（`ObjectManager.getWorldCenter`）を最初の星にし、なければ新しく置く。中心の上に作る配置（連星・三体の最初の星、太陽系・Stress Test・Deploy の惑星と恒星のボタンが周りに置く Sun）は、中心のほかに天体がない世界（プロファイルの消去、または System › Clear Selected の後）で、中心がその天体と別の種類（`param.NAME` が別のプリセット）であり、かつ、中心がプロファイルの置いた世界の中心（`CelestialBody.isProfileWorldCenter` が真。`deployProfile` が `DEPLOY_PROFILES` の `worldCenter: true` の静的な物体として置いた天体で、現在は銀河中心の Sgr A*。保存する。Rev 6.16、§4.14-14）であるか、自分の消去を持つプロファイル（連星・三体・Stress Test）の消去の直後であるときは、中心を除去し、その天体を Reset が Sun を置く位置（キャンバスの中心、静止）に新しい中心として置いてから続ける（`ObjectPlacer._replaceCenterOfOtherKind`。§4.13-32 の逆向き。ロケット・デブリが残っていても中心とし、カメラが古い中心を追っていれば新しい中心に移す。Rev 6.14、§4.14-12。制限: 新しい中心から 200 AU より遠くにある飛行中のロケット・デブリは、次の更新で脱出の規則（`ObjectManager._checkEscapeAndRemove`、最も重い天体から 200 AU）により除去・破壊される。銀河中心の世界では Sgr A* の周りの物体がこれに当たる。main では同じ操作の Clear Selected の時点で、残った id 0 の Sun に対して同じ規則で起きる。見直しの入力 H2-14）。世界に天体を加える配置（Deploy のボタン、太陽系）は、利用者が空の世界に置いた中心を、種類によらず（手で置いた Sgr A* も）置き換えない（Rev 6.15・6.16、§4.14-14）。同じ種類の中心、`param` のない中心（`param` を保存する前の保存ファイル。中心はページの Sun）、ほかに天体がある世界の中心は、そのまま使う（名前 "Sun" の前提による連星・三体の後の太陽系の例外は見直しの入力 H2-1 のまま）。既定のホストとカメラの代替は中心以外を優先する。`RocketLauncher.hostAutoSelected`（`_assignDefaultHost` で真、利用者の選択で偽）を持ち、ホストが `null` か、自動で選んだ中心のときだけ置き換える。保存: 天体の `isWorldCenter`・`isProfileWorldCenter`、`rocketLauncher.hostAutoSelected`（§3.5-1）。id のカウンタは Reset で戻さない（物体の一覧の外の参照と送信中のフレームが新しい物体を指さないようにするため。id の値に依存する処理はなくなった）。読込は従来どおり（ファイルの id を保ち、カウンタを最大 + 1 にする）。物理は id の順序だけを読み、Reset の後に作った世界も、新しいページで作った世界とビット単位で同じに動く。
  28. **`rocket:destroyed` を送る側がない**: git 0dbb27e が受け手だけを加えた（`audio:stop-all` も同様）。仕様: `ObjectManager` が主スレッドでロケットを破壊・除去したとき（`removeObject`、バッファの衝突）に、ロケットごとに 1 回発行する。受け手は、シーケンスのロケット（`LaunchSequencer.rocketId`）のときだけ散水の音を止めて状態を消す（射点の上で機体が破壊されたとき、散水の音が鳴り続けていた）。轟音・超音速音は §4.13-23(a) で次の更新で止まるため、ここでは止めない（すべての音を止めると、噴射中の別のロケットの音も切れるため）。`audio:stop-all` の受け手は削除する。待ち受けるだけで発行されないイベント、発行されるだけで待ち受けのないイベントは、ほかにない（63 種、走査で確かめる）。
  29. **縮小表示の SRB の炎**: 縮小表示は燃焼終了だけで SRB の炎を太くしていたため、射点の MAIN ENGINE START の後も SRB が燃えて見えた。仕様: 両方の詳細度で `RocketRenderer.isBoosterFiring`（付いていて、燃焼終了でなく、`!isHoldDown && isIgnited`）を使う。段と自走ペイロードの噴射は `RocketRenderer.isEngineFiring` を使う（Rev 6.13、§4.14-2）。
  30. **破壊されたロケットの選択**: `_getActiveRocket` は一覧に残る破壊済みのロケットを選び、噴射中の別のロケットの音が出なかった。仕様: シーケンスのロケット → カメラの対象 → 最初のロケットの順に、飛行中（`state === OBJECT_STATE.ACTIVE && !isDestroyed`）のものを選ぶ。射点の演出の停止、Worker の破片の配色、既定のホストと `open()` の存在の確認も同じ規則にする。テレメトリパネルは、選んだロケットを表示し続けるため対象外とする。
- **一覧に残る除去・破壊済みの物体の一括調査**（Rev 6.12、利用者の判断で修正）:
  31. **一覧に残る除去・破壊済みの物体を生きているものとして扱う**: 除去（Clear Selected・中断・脱出・粉砕・Reset・読込）や破壊（衝突）の後も、物体は軌跡が消えるまで `REMOVED` のまま `universe.objects` に残る。生きている物体の規則は §4.13-23(a) と同じとし、`gravsim_utils.js` の `isLiveObject` にまとめる（状態を持たない記録は生きているとみなす）。(a) `LaunchSequencer` は自身のロケットの `rocket:destroyed` で中断する（理由 `rocket-destroyed` を付けた `sequencer-abort`。`SoundEffects` はこの理由ではすべての音を止めない）。`RocketLauncher` は射点のロケットの `rocket:destroyed` で射点を解放する（`rolloutedRocketId` を `null`、射点の演出を止め、Rocket タブを Rollout に戻してロックを外す）。従来はカウントダウンと `WATER DELUGE` が続き、散水の音が Reset まで鳴った。(b) `remove`・`clear` のメッセージは主スレッドの連番 `seq` を持ち、Worker は処理した最大の値を毎フレーム `syncSeq` で返す。主スレッドは、除去より前に作られたフレームのその id のデータと、最後の `clear` より前に作られたフレーム全体を捨てる（バッファは返す）。一覧に残る除去済みの物体はフレームのデータを受けない。Reset・読込は生きている物体を 1 回ずつ除去してから `clear` を送り、Worker は世界を空にする（主スレッドが見ていない、送信中のフレームで生まれたデブリも消える）。従来は、送信中のフレームの未知のデブリが "Jettisoned Debris" として戻り、読込では同じ id の物体に古い世界の位置を書いた。`syncSeq` のないフレームは同期済みとみなす。除去・消去を送らない通常の飛行の物理は変わらない。(c) 保存は生きている物体だけを書く。(d) 射点のホストの一覧は生きている天体だけを出す。(e) 同じ型の箇所: カメラの最後の代替、自動追尾（追尾を始めたロケットが生きていなければ止める）、予測に入れる天体、ランチャーのホストと射点のロケット、System・Navi・テレメトリの一覧（テレメトリは表示中のロケットを残す。§4.13-30）と一覧の変化の通知（生きている数の変化でも通知する）、物体数と経過時間、REF BODY と Navi の基準天体、タブを閉じたときのカメラの対象の復元、Deploy の Sun の代替と生成器のホスト、Clear Selected と Reset の二重の除去。対象外の箇所（描画、§4.13-30 の表示対象、`_isReplaceableHost`、`updateRocketState`、フェードそのもの、Reset・読込の直後）は、走査のテストの許可リストに理由付きで置く。効果の軌跡の基準天体、ORBIT の通過の判定のホスト、射点の演出のホストにも規則を適用する（Rev 6.14、§4.14-13）。
  32. **銀河中心と世界の中心**: 静的な物体に `worldCenter: true` を持つプロファイル（銀河中心の Sgr A*）は、消去の後に現在の世界の中心を除去し、その物体を世界の中心にしてカメラで追う（git 6aaaae7 は、Sun を Sgr A* の周りの軌道に置く軌道要素を加えており、Sun は 1 つの意図）。連星・三体は世界の中心をその位置のまま最初の星に使うが、銀河中心は別の位置に中心を置くため置き換える。従来は、ページの Sun（§4.13-27 以降は Reset の後も）が静止したまま残り、Sun が 2 つになった。新しいページ・Reset の後・2 回目の配置・他のプロファイルの後で、同じ世界になる。逆向きに、銀河中心の後（その後の Clear Selected の後も）に Sun の上に作る配置を行うと、Sgr A* は §4.13-27 の規則で Reset の Sun に置き換わり、連星・三体・Stress Test・銀河中心（と、銀河中心と Clear Selected の後の太陽系）は新しいページと同じ世界になる（Rev 6.14、§4.14-12）。消去なしで銀河中心の後に置く太陽系は、銀河中心の世界の Sun の周りに、新しいページと同じ相対の状態で置く（追加のプロファイル）。
- **直さないこと**: 物理 Worker で `add` の直後の最初のフレームは、加速度がまだホストへの重力のため `determineOptimalSubSteps` が多めのサブステップ数を選ぶ。精度が上がる方向で無害であり、変えると通常の経路の結果が変わるため、そのままにする。

### 4.14 本ブランチの退行の修正（Rev 6.13、Rev 6.14 で 11〜13、Rev 6.15 で 14 を追加、Rev 6.16・6.17 で 14 を改訂）
- 経緯: 最後に行った読み取りだけの不具合の探索 4 本（[構造の見直しへの入力](2026-11-21_architecture_redesign_inputs.md) §3）の結果を main と比べ、本ブランチで入った不具合と悪化した不具合を、利用者の判断（既存の不具合は見直しへ、本ブランチの退行は本ブランチで直す）により直した。main でも同じように起きる部分は見直しの入力 §3 に残す。
1. 受動ペイロードの PAYLOAD CUTOFF（H1-9）: 上段の燃焼中に sep_payload の行（§3.4-1）が受動ペイロードを分離すると、そのステップが STG_BURNING → ORBITAL_COAST（分離済み）となり、予測はペイロードのエンジンの停止と見なして PAYLOAD CUTOFF を記録していた。仕様: payload_cutoff は、ステップの開始時にペイロードが分離済みで（その燃焼がペイロード自身のもの）、前のステップが STG_BURNING で、このステップで ORBITAL_COAST か燃焼時間 0 になったときだけ記録する。受動ペイロードは分離後に STG_BURNING にならないため記録されない。自走ペイロードが燃焼中に分離されて燃焼を続ける場合の停止は従来どおり記録する。
2. 自走ペイロードの噴射の描画（H4-3）: RocketRenderer のペイロード単体の描画は、両方の詳細度で噴射を描く前に戻っていた（main では自走ペイロードが噴射しなかったため見えなかった）。仕様: RocketRenderer.isEngineFiring（点火済み・燃焼時間 > 0・スロットル（またはテレメトリの TWR）> PLUMES.THRUST_THRESHOLD。段の噴射の規則をそのまま 1 か所にしたもの）と、自走（hasPayloadPropulsion、なければ payload.propulsion.enabled。Rocket.mass と同じ）の両方が真のとき、バスの後面（-x、高詳細度は -0.5 × payloadR × SATELLITE_BUS_W_RATIO、低詳細度はアイコンの後端）から噴射を描く。高詳細度は _drawPlume を payload.propulsion.fuelType（文字列でなければ liquid）、ROCKET_VISUAL.ALIGNMENT.PAYLOAD_PLUME_SCALE（0.35、presets/visuals/rocket.json と既定値）、スロットルで呼ぶ。低詳細度は段の三角形の噴射を PAYLOAD_PLUME_SCALE 倍の長さで描く。両方の詳細度で同じ規則（§4.13-29）。
3. 予測線のイベントの印（H1-6）: updateRocketFlightEvents が、payload_sep と最後の stg_sep_N を ORBITAL_COAST で通過としていた。遅らせたペイロード分離（§3.4-1）では SECO で ORBITAL_COAST に入るため、分離のずっと前に通過になった（本ブランチの部分）。main からの部分（同じ 1 イベント 1 規則で直す）: payload_cutoff が段の規則（status ≥ MECO または段番号 > 0）で MECO-1 に、点火のイベント（ses_N・payload_start・reignition_N）が「段番号 > 0 かつ点火」で SES-1 に通過していた。仕様（どれも従来どおり予測時刻 ev.time 以降なら通過）: payload_sep は isPayloadSeparated、stg_sep_N は段番号 ≥ N か（N が段数以上なら）isPayloadSeparated。payload_cutoff は分離済みで ORBITAL_COAST か燃焼時間 ≤ 0（予測の規則と同じ）。ses_k は段番号 > k、または段番号 = k で点火。payload_start は分離済みで点火。reignition_N（段番号 N-1 の再点火）は、その段の最初の燃焼でも点火フラグが立つため状態では区別できず、段番号 > N-1 か分離済みのときだけ状態で通過する（それ以外は予測時刻）。段番号が数値でなければ 0 とする。
4. Rocket タブのスライダの刻み（H3-17）: 深宇宙のサイジング（§3.4-3）は推進剤を 0.1 t、推力を 1 kN で、ペイロードのサイジングは質量と推進剤を 0.01 t で決めるが、スライダは 1 t・50 kN（最小 100 kN）・0.5 t・0.05 t 刻みで、値を表せなかった（全組合せで 275 値、main では 32 値）。HTML の値の検証が刻みに丸めるため、つまみの位置がずれ、触ると値が変わった。仕様（index.html）: #rl-fuel-mass・#rl-oxid-mass は 0.1 t 刻み、#rl-launch-mass は 0.1〜500 t・0.1 t 刻み（Epsilon 第 3 段 0.8 t）、#rl-launch-thrust は 1 kN〜（最大は §3.4-4 のまま）1 kN 刻み（同 85 kN）、#rl-payload-mass は 0.01 t 刻み、#rl-payload-fuel・#rl-payload-oxid は 0.01 t 刻み。サイジングは変えない。RocketTab の入力処理は小数として読み（parseFloat）、O/F 比で連動する推進剤は 0.1 t に丸める（RocketTab.roundToSliderStep、サイジングと同じ Math.round(v × 10) / 10）。ペイロード質量の表示は小数 2 桁。各刻みは、全組合せの値を表すのに必要な最も粗い刻み（10 倍粗いと外れる値がある）。ほかの範囲は main から変えない: #rl-fuel-mass 0〜1500 t・#rl-oxid-mass 0〜3000 t（§3.4-3 の maxByTank のタンクの上限）、#rl-launch-thrust の最大 10000 kN（§3.4-4 の基準値。機体の推力が超えるときはそこまで上げる）、#rl-payload-mass 0〜100 t、#rl-payload-fuel 0〜10 t、#rl-payload-oxid 0〜20 t（Rev 6.14、G3-2-04 でテストが値を確かめる）。
5. SystemTab.loadState の削除（H3-18 の一部）: 本ブランチが ControlPanel.loadState を書き直して（§3.5-1、Rocket タブが開いている間は deferViewState）から呼ばれなくなった。残すと、開いた Rocket タブの規則を通らない読込の経路になるため削除する。System タブの表示の読込は ControlPanel.loadState（SystemTab.normalizeViewState → deferViewState または applyViewState）だけとする。
6. 読込後の音声の時計と相対高度（H2-4／H4-4）: 読込の後も Worker の MET は続く（§4.7）が、SoundSequencer は主スレッドの rocket.flightTime（保存しないため 0 から）を T+ の時計にしていたため T+1〜5 の秒読みがまた鳴り、相対高度（relativeAltM）は読込の後の最初のフレームを基準にしたため 0 からになり、高度の音声が数百 m 遅れた（main は Worker の MET も 0 に戻ったため、表示とは一致していた）。仕様:
   (a) SoundSequencer の T+ の時計はテレメトリの対象の Worker の MET（telemetry.flightTime。HUD の MET と同じ）で、数値型で有限の正の数のときだけ使う（数字の文字列などほかの型の値は変換せずに使わない。§4.13-21 と同じ扱い。Rev 6.14、G3-2-04。射点では MET 0 のため T+ の音声は鳴らない）。カウントダウン中は従来どおり LaunchSequencer の時計。
   (b) 時計の源が切り替わって時刻が戻っても、同じ整数秒の音声は 1 回だけ鳴る（lastTimeKeySecond。カウントダウンの終了で Worker の MET が 1 フレーム遅れて読まれる場合）。
   (c) 読込（Universe.loadState）で SoundSequencer.resyncAfterLoad を呼ぶ: 前の飛行の 1 回だけのフラグを消し、読み込んだ飛行の最初の有効な MET で、その時点で成り立つ 1 回だけの条件と、その秒までの整数秒を、鳴らさずに済んだものとする。音声のプロファイルは保存しないため、同じセッションのものを使い続ける（新しいページの読込では従来どおり鳴らない）。
   (d) Reset（simulation:reset）はプロファイル・フラグ・時計を消す（中断と同じ）。カウントダウンの終了（sequencer-end）は消さない（MECO・SES・SECO などの音声はその後に来る）。
   (e) 相対高度の基準は射点の高度 hostAltM + bottomOffsetM（_updateHoldDownPositions がホールドダウン中に保つ高度。最初のフレームの値と 1e-9 m 以内で一致）とする（ObjectManager.padAltitudeM。ホストのないロケットは従来どおり最初のフレーム）。保存形式は変えない。
   (f) 読込で主スレッドの rocket.flightTime を、保存した runtimeState.flightComputer.flightTime から FlightComputer と同じ検証（restoredRuntimeState が真のときだけ、[0, RUNTIME_RESTORE_MAX_TIME_S]、数値でなければ 0）で設定する（Worker の FC と同じ値）。
   制限: 保存と読込の後の最初のフレームの間（1 フレーム以内）に成り立った 1 回だけの条件は、鳴らずに済んだものとされる。
7. 射点のロケットのホストが消えたとき（工程 3 の修正で見つかった (a)）: 本ブランチはホールドダウン中のロケットを積分から除いたため（§3.1.1-2）、ホストが削除・破壊されて一覧から消えると、ロケットが宇宙空間で静止した（main では積分され、ホストの最後の速度で進んだ）。仕様: 積分から除くのは、ホールドダウン中でホストが存在する（_updateHoldDownPositions が固定する）ロケットだけとする（PhysicsEngine._getHoldDownHost、_updateHoldDownPositions と同じ検索）。ホストのないホールドダウン中のロケットは他の物体と同じに積分する。通常の経路（ホストあり）は変わらない。

既存の節の変更
8. 燃焼中の段を分離する `sep_*` の行と予測のイベント（工程 3 の修正中に発見、本ブランチの機能の経路）: `sep_stage1`・`sep_stage2`・`sep_payload`（§3.4-1）は、燃焼中の段の推進剤を 0 にして同じステップで分離するため、予測のステップは STG_BURNING から次の状態へ直接移る。その段のカットオフが記録されず、段の規則がペイロード分離後（段番号 = 段数）のペイロードの状態を最後の段とみなして、自走ペイロードの停止の時刻に SECO-1 を（点火していない上段にも）記録し、分離と同じ `flightControl` で再点火する自走ペイロードに PAYLOAD START がなく、段間の惰行中の分離では SES-2 と記録していた（例: H3-30 ＋ HTV-X、ISS、500 s の `sep_payload` で SECO-1 が 566 s、PAYLOAD START なし。Worker は 500 s に上段のカット・分離・点火、566 s に停止）。仕様（`runMultiBodySimulation`）: (a) STG_MECO／ORBITAL_COAST による段のカットオフは、段番号 < 段数のときだけ記録する（段番号 = 段数はペイロードの状態で、その停止は PAYLOAD CUTOFF だけ。記録済みの集合・`hasReachedMeco`・`mecoSimTime` は従来どおり）。(b) ステップの開始時に燃焼中（STG_BURNING、ペイロード未分離）の段がこのステップで分離されたら、そのカットオフを、未記録なら分離のイベントより前に同じ時刻で記録する（`hasReachedMeco`・`mecoSimTime` も更新する）。点火の前に分離された段（INTERSTAGE_COAST、`sep_payload` が一緒に落とす後の段）と、指令による惰行中（STG_COAST）の段は記録しない（惰行の開始はイベントでない。main と同じ）。(c) ステップの開始時に未分離のペイロードが、終わりに分離済みかつ STG_BURNING なら PAYLOAD START とし、SES・REIGNITION より先に判定する。既定のプランでは、段は STG_MECO（3 s 以上）を経て分離し、ペイロードは分離の次のステップで点火するため、結果は変わらない。同じ時刻のイベントは、カットオフ・分離・点火の順に並ぶ（`sep_payload` が強制するフェアリングの分離だけは、Worker では先に起きるが、予測の一覧では同じ時刻の分離の後に並ぶ。印の位置は同じ。既定のプランのイベントの順序を変えないため、この並びとする）。
9. 射点で条件を満たす行（同上）: MET はホールドダウン中 0 のまま（§3.1.1-2）で、`FlightComputer` は射点でもプランを評価するため、時刻 0 の行と射点の値以下の alt・vel の行はロールアウトの直後に成立し、Worker はそのアクションを射点で実行していた（段・フェアリングを射点で投棄し、自走ペイロードや次の段がホールドダウン中に点火・燃焼した）。予測は liftoff の評価（`flightControl(0)`）で実行し、分離のイベントがなかった。仕様: `CalcRocket.flightControl` は、ホールドダウン中でなく `dt > 0` のときだけ、保留中のアクションを取り出して実行する。行は射点でラッチされ、アクションは保留のまま待ち（保存・読込でも続く。§4.7）、解除の後の最初の飛行ステップ（Worker の最初のサブステップ、予測の最初のステップ）で実行される。予測の liftoff の評価（`dt = 0`）は射点の最後の評価にあたり、実行しない。既定のプランの行はアクションを持たないため、通常の経路は変わらない。
10. 単段機の予測の 2-STG-SEP（同上）: `CalcRocket` はペイロード分離のとき段数が 2 以下なら `isStage2Separated` を立てるため、単段機（SSTO）の既定のプランの予測に、第 2 段がないのに 2-STG-SEP が記録されていた（main は STG-1 SEP だけ）。仕様: 予測の `isStage2Separated` による 2-STG-SEP は、段数が 2 以上の機体だけで記録する。`isStage2Separated` のフラグそのもの（復元・描画が使う）は変えない。

独立監査3 Iteration 2 の指摘（Rev 6.14）
11. 音声のテレメトリのイベントのフラグ（G3-2-01）: 主スレッドがテレメトリに書く飛行のイベントのフラグ（`ObjectManager._applyRocketState` の `isMeco`・`isStage1Separated`・`isSes`・`isSeco`・`isStage2Separated`・`isPes`・`isPeco`。読むのは打上げのシーケンスの音声の規則（`LAUNCH_SEQUENCES` の `fl_*`）だけ）は、main ではペイロード分離のフラグが存在しない項目（`tmPayloadSeparated`）を読んでいたためペイロードの項が常に偽で、ペイロードの音声は鳴らなかった。本ブランチは Gate 1 でこの読み違いを直し、`isStage2Separated` を Worker から取り、自走ペイロードが燃焼するようになった（§4.14-2）が、フラグの意味と消費者を確かめなかったため、次の音声が鳴っていた。(a) 受動ペイロード（ASNARO-2・ALOS-4）の分離のたびに「ペイロードエンジン燃焼停止」（`fl_peco`。分離で燃焼時間 0・MECO の状態になる）。噴射しないまま分離した自走ペイロード（Falcon 9・H3-30 ＋ HTV-X など。見直しの入力 H1-5）でも同じ。(b) 単段機（SSTO）のペイロード分離で「第二段、分離」（`CalcRocket` は段数 2 以下ならペイロード分離で `isStage2Separated` を立てる。§4.14-10）。(c) 単段機の自走ペイロード（HTV-X・MMX）の点火で「第二段エンジン燃焼開始」（分離の後の段番号は段数 = 1）。(d) 3 段機で第 2 段が MECO の状態を通らないとき、SECO がペイロード分離で鳴った: 第 2 段の燃焼中の `sep_stage2` の行（§3.4-1）では、その分離ではなく第 3 段の後に鳴り、第 3 段の燃焼中の保存・読込の後は、保存の前に鳴った SECO がまた鳴った（§4.14-6 (c) は読込の時点で成り立つ条件だけを済みとする）。原因: 予測は (a)(b) を §4.14-1・-10 で直したが、同じフラグを読む主スレッドに横展開していなかった。
   仕様（段のイベントは段のもの、ペイロードのイベントはペイロード自身のエンジンのもので、予測のイベントの規則と同じ）: 2-STG-SEP は Worker のフラグ（なければ段番号 ≥ 2 か分離済み）で、段数が 2 以上の機体だけ（ロケットの `isStage2Separated` は保存・復元が使うため Worker の値のまま）。SES は段番号 1 がペイロード分離の前に噴射しているとき（単段機の分離の後の噴射は PES。予測が PAYLOAD START を SES より先に判定するのと同じ、§4.14-8 (c)）。SECO は段番号 1 の MECO の状態か、第 2 段がなくなったとき（段番号 ≥ 2 か分離済み。燃焼中の段を分離した行ではその分離がカットオフ、§4.14-8 (b)。読込の後は済みとされる）。PES は従来どおり分離済みで噴射。PECO は、分離済みのペイロードの噴射を一度見た後（主スレッドの `_payloadBurnDetected`。保存しない。読込の後は最初のフレームから）、噴射が止まり、MECO の状態か燃焼時間 0（≤ 0。Worker のフレームの燃焼時間は `WorkerBridge.formatWorkerToMain` が 0 以上に丸めるため、負の値は届かない）のとき（§4.14-1 と同じ。指令の惰行は停止としない。2 つの条件は回帰 20 が別々に確かめる、Rev 6.15、G3-3-02）。MECO・1-STG-SEP は変えない。
   変えないもの（main と同じ既存の不具合。見直しの入力 H4-21〜H4-23）: 単段機はペイロード分離で SECO と 1-STG-SEP が鳴る。第 1 段の分離がフレームの最後のサブステップで起きると、SECO が 1 フレームだけ立つ。
   既定のプランの音声の列は、受動ペイロードと噴射しない自走ペイロードで main と同じ。ただし、H4-22 の 1 フレームの SECO は、フレームの位相が本ブランチと main で違うため起きる飛行が違い、その飛行では SECO と SES の順が main と違う（受動ペイロードとペイロードなしの 126 飛行のうち 13。例: H3-30・ペイロードなし・GTO は本ブランチで 260.5 s、main で 647.0 s に SECO。Rev 6.15、G3-3-03）。自走ペイロードが噴射する飛行では PES・PECO が加わる（main では噴射しなかった、§4.14-2）。物理は変わらない（主スレッドだけの変更）。
12. 銀河中心の後のプロファイル（G3-2-02、本ブランチの退行）: §4.13-32 で Sgr A* を世界の中心にした後、(a) 連星・三体の主星「Sun A」「Sun A (Trisolaris 1)」が Sgr A* のオブジェクトのまま（半径 1.27e10 m、枠線 #FF4500・0.1、`param` は Sagittarius A*。Worker も同じ）になり、(b) 銀河中心 → System › Clear Selected → 太陽系は "Sun object not found in the universe." の例外で一時停止のまま何も置かれなかった。同じ型: Stress Test の群れ（ホストは Sun）は何も置かず、Clear Selected の後の惑星・恒星のボタンは Sgr A*（カメラの対象）の周りに置いた。main は id 0 の Sun が残るため起きない。原因: 生成器は中心の名前・色・質量・位置だけを書き換え、太陽系は名前 "Sun" の天体を探す。どちらも中心が Sun の種類であることを前提にしていた（§4.13-27）が、§4.13-32 で Sun でない中心ができた。
   仕様: §4.13-27 の規則（`ObjectPlacer._replaceCenterOfOtherKind`）。呼ぶ箇所は、連星・三体の生成器（最初の星のテンプレート）、`deployProfile`（プロファイルが自分で置かずに周りに置くホスト（`_externalHosts`。太陽系・Stress Test の Sun）に、生きている同名の天体がないとき）、`placeAtOrbitAroundSun`（生きている Sun がないとき。カメラの対象の代替より先）。置き換えは `Universe.reset()` と同じ `add` を送るため、ロケット・デブリが残っていなければ、結果はビット単位で新しいページと同じ（残っている場合は §4.13-27 の制限のとおり）。物理の規則は変えない。直さないこと（見直しの入力 H2-1）: 名前 "Sun" の前提（連星・三体の後の太陽系の例外と一時停止の対、その後の Stress Test が何も置かない、惑星のボタンがカメラの対象を主星にする）。銀河中心の世界で Sun だけが破壊された後の太陽系も、ほかに天体があるため置き換えず、同じ例外になる。
13. 世界の中心の判定と、生きている物体の規則の走査（G3-2-03）: (a) 中心（Sun）を除去した直後（一覧に残ってフェード中）に連星を置くと、新しい主星が中心にならず、続く Clear Selected で 2 つの星が消えた。フェードの後では Sun A が中心として残り、数秒のフェードで結果が変わった。(b) 回帰 18 の走査は `objects?.find?.(`、別名の一覧、`.length` の判定を拾わず、(a) を見逃した。(c) 許可リストの 4 項目（5 箇所）の理由が実態と違った。原因: (a) `placeObject` が空の一覧を `list.length === 0` で判定し、除去済みの物体を数えた（§4.13-31 の種類）。(b)(c) 走査の範囲と許可の理由の確認の不足。
   仕様: (a) 空の世界は、生きている物体がない世界とする（§4.13-27）。(b) 走査は `?.(` の呼び出し、一覧の `.length`、`|| []` つきの for-of、別名（一覧・`objectsMap` をそのまま代入した変数。代入からその波括弧の終わりまで）を対象とし、`countLive(` を規則の適用に数える。対象外の形（分割代入の改名、別のプロパティ・関数の戻り値・引数を通した一覧、コピー、計算した添字）はテストに明記する。新しく当たった箇所は、ランチャの読込（規則を適用）と、カメラの代替の生きている一覧の長さ、`updateUI` の一覧の数（意図して一覧の数を見る）、`loadState`、`formatWorkerToMain`（Worker 自身の一覧）を理由付きで許可する（Rev 6.15、G3-3-03 で補足: `formatWorkerToMain` のループの中の要素 `objects[i]`（`gravsim_worker_bridge.js:40`）は対象外の形（計算した添字）で、主スレッドのスクリプトでこの形はここだけだが、同じループの `.length` の許可と同じ理由（物理 Worker 自身の一覧で、除去済みの物体を持たない）が当たる。走査は行単位で規則を数えるため、`gravsim_info_panel.js:60`（`om.countLive()`、なければ一覧の長さ）は規則の適用と数える。一覧の長さは `ObjectManager` のない宇宙のための代替で、`Universe` は `InfoPanel` の前に `ObjectManager` を作るためアプリでは通らない（単体テストの模擬の宇宙だけが通る）。経過時間の判定は生きている数を使う）。(c) 規則を適用する箇所: 効果の軌跡の基準天体（除去済みの天体は基準にせず、絶対座標（refId −1）で記録する）、ORBIT の通過の判定のホスト（ホストが除去済みなら時刻の規則だけ）、射点の演出のホスト（ホストが生きていなければ演出を止める。ホスト id のない演出は従来どおり）。理由を付け直して許可する箇所: 実飛行経路の記録（同じホストに対して描く `renderTrajectory` はホストが一覧から消えると描かず、一覧に残る除去済みのホストは除去された位置に止まるため、記録した点はロケットの位置そのもの。保存も Worker への送信もしない）。物理は変えない。

独立監査3 Iteration 3 の指摘（Rev 6.15）
14. 利用者が空の世界に置いた天体の置き換え（G3-3-01、本ブランチの退行）: §4.14-12 の置き換え（`ObjectPlacer._replaceCenterOfOtherKind`）は、中心の `param.NAME` が置く天体と違い、中心のほかに生きている天体がないことだけを条件にしていた。§4.14-13 (a) により、空の世界に利用者が最初に置いた天体はフェードによらず世界の中心になる。そのため、新しいページで Sun の上に BlackHole を置き（Sun は衝突で破壊される）、System › Clear Selected で世界を空にし、マウスで Jupiter を置いた後に Deploy の Earth・Mars・Sun・Sirius のボタンや太陽系を押すと、Jupiter が除去され（Worker からも消え、保存にも残らない）、キャンバスの中心に新しい Sun（中心）が置かれた。main と Iteration 2 のツリーでは、これらのボタンで Jupiter は残る。原因: 置き換えの対象を「別の種類の中心」と定義し、中心ができた経路（プロファイルの `worldCenter`、空の世界への最初の配置、読込）を区別しなかった。Rev 6.15 の修正は役割（プロファイルの世界の中心）を種類（`param.NAME`）で近似したため、利用者が手で置いた Sagittarius A* は (a) でも置き換わった（独立監査3 Iteration 4 の G3-4-01、本ブランチの退行）。
   仕様: (a) 世界に天体を加える配置（Deploy の惑星・恒星・Sun のボタン（`placeAtOrbitAroundSun`）、自分の消去を持たないプロファイル（太陽系）の `_externalHosts`）は、中心がプロファイルの置いた世界の中心であるときだけ置き換える。その役割は印 `CelestialBody.isProfileWorldCenter`（真偽値、既定は偽）で表し、`deployProfile` が `worldCenter: true` の静的な物体（現在は銀河中心の Sagittarius A* だけ）として置いた天体に、`isWorldCenter` と同時に真を設定する。ほかの経路でできた中心（空の世界に最初に置いた天体、Reset の Sun、置き換えで置いた新しい中心、生成器が中心から作った最初の星）は偽のままで、置き換えない。印は世界の中心でだけ読み、種類は読まない（Rev 6.16、G3-4-01。種類による判定 `_profileCenterKinds` は削除した）。利用者が置いた中心は、手で置いた Sgr A* を含めて、種類によらずそのまま残る。Sun がなければ、惑星のボタンはキャンバスの中心に Sun（中心ではない）を置いてその周りに惑星を置き、Sun のボタンは Sun を置く（Iteration 2 のツリーで、その天体がフェードの後に中心になった場合と同じ）。カメラが生きている天体を追っていれば、惑星・恒星はその周りに置く（main と同じ）。太陽系と、惑星でない恒星のボタンは、生きている Sun もカメラの対象もなければ "Sun object not found in the universe." の例外のまま（名前 "Sun" の前提、見直しの入力 H2-1。太陽系は main と同じく一時停止のまま。恒星のボタンも、アプリの更新でカメラの対象が外れたこの経路では main と同じ例外になる。main が除去済みの天体の周りに置くのは、カメラがまだ除去済みの天体を指しているときだけ）。(b) 自分の消去を持つプロファイル（連星・三体・Stress Test。`clearPrevious: true`）は、その消去の直後に、別の種類の中心をどれでも置き換える。消去は中心のほかのすべての天体を除去し、中心はその世界の Sun として使うだけである。生成器は中心の名前・色・質量・運動だけを書き換えるため、利用者の Jupiter をそのまま使うと、半径・`param` が Jupiter の「Sun A」（Worker の名前も Jupiter）になる。main でもこの消去は利用者の天体を除去する（id 0 だけを残す）。結果は新しいページとビット単位で同じ。銀河中心は従来どおり古い中心を除去する（§4.13-32）。(c) 印は保存する（§3.5-1、天体の `isProfileWorldCenter`）。読込は天体ごとに、`isWorldCenter` の有無によらず、厳密に `true` のときだけ真とし、`false`・ない・真偽値でない値は偽とするため、保存・読込の後も同じに働く。`isWorldCenter` のない旧形式のファイルでは id 0 の天体が中心になり（§4.13-27）、その天体の印が真のときだけプロファイルの中心とする（印のある旧形式のファイルは main も本ブランチも書かず、手で作ったファイルだけ。Rev 6.17、G3-5-01）。印は世界の中心でだけ読むため、中心でない天体の印は効果がない。印のない保存ファイル（main と、本ブランチの Rev 6.15 までの保存）の中心はプロファイルの中心とせず、(a) では置き換えない（main で天体が残るのと同じ）。`param` のない旧形式の中心は従来どおり置き換えない。手で置いた Sagittarius A*（Deploy › Object Mass の一覧はすべてのプリセットを含む）が空の世界の中心になっても印は偽のため、(a) ではほかの天体と同じに残り、結果は main と同じになる（Sun・惑星のボタンはキャンバスの中心に Sun（中心でない）を加え、カメラが Sgr A* を追っていれば惑星・恒星をその周りに置き、カメラの対象がなければ恒星のボタンは例外、太陽系は例外で一時停止のまま）。同じ種類の中心と、ほかに天体がある世界の中心は、従来どおりそのまま使う。物理は変えない。

