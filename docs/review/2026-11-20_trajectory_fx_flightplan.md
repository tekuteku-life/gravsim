# 独立監査レビュー記録: 軌道予測・ロケット演出・フライトプラン刷新および全体監査

対象設計書: [`docs/design/2026-11-20_trajectory_fx_flightplan.md`](../design/2026-11-20_trajectory_fx_flightplan.md)  
準拠プロセス: [`docs/development_process.md`](../development_process.md)  
対象ブランチ: `feat/trajectory-fx-flightplan`

---

## 独立監査1: 設計監査 — Iteration 1

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 1
- **実施日時**: 2026-11-20 15:15 JST
- **判定**: **FAIL**

設計書を実コードベースおよび既存テスト群とゼロベース照合した結果、**実在しないシンボル・フィールド名への依存、98%の長期予測打ち切りを招く点数キャップとの矛盾、2段ロケット分離ステートマシン・自走ペイロードとの構造的破綻、座標軸／RCSノズル仕様の先送り、パラメータ貫通経路と既存テスト（`05`, `06`, `07`, `05_ui`）との衝突** など多数の重大設計不備を検出した。設計書および横展開箇所を是正の上、Iteration 2 での再監査が必要である。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### F-01 [Critical] 要件1: 実在しないシンボル名・メソッド名・プロパティ名による設計乖離
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L77, L81, L89, L102–103
  - 実装: `scripts/gravsim_const.js` L268–269, L331–343 / `scripts/gravsim_object.js` L54–93, L210–244, L353–541 / `scripts/gravsim_trajectory_predictor.js` L574–589, L684–717, L749–764
- **現象**:
  1. `gravsim_const.js` に `TRAJECTORY_RENDER_CONFIG` は存在しない。サンプリング定数は `TRAJECTORY_PREDICTION.SAMPLING`（L331–343）であり、削除対象の `COLOR_ORBIT`, `COLOR_FALL` は `RENDER.PREDICTED_TRAJECTORY`（L268–269）配下にある。
  2. `gravsim_object.js` の `CelestialBody`（L210–244）に `update()` メソッドは存在しない（履歴更新は `GravSimObject.updateHistory` L54–93 および `Rocket.updateHistory` L353–469）。また `Rocket._recordActualFlightPath`（L477–541）は既に `this.isHoldDown` 時に早期 return し（L482）、単純差分 `this.x - host.x` ではなく表面回転座標 `(r * cos(phiSurf), r * sin(phiSurf))` を `RENDER.PREDICTED_TRAJECTORY.ACTUAL_SAMPLE_MIN_DIST_M = 5.0`（25 m²）閾値で記録しているため、設計書 L77 の記述と食い違う。さらに L538–539 の間引きでは `const len = this.actualFlightPath.length;` が `push`（L526）より **前**（L500）で取得された古い値を参照しているため、末尾 `push` 点が保持されない実バグが存在する（正しくは `this.actualFlightPath.length - 1`）。
  3. `gravsim_trajectory_predictor.js` の点プロパティは `pt.rx` / `pt.ry` ではなく `pt.relX` / `pt.relY`（および表面極座標 `pt.r`, `pt.phiSurf`：L574–586, L684–696, L749–761）。また「現在位置〜予測開始点の接続」という処理は存在しない（L710–717 は `actualFlightPath` 末尾への現在位置付加）。
- **修正方針**:
  - 設計書 L77, L81, L89, L102–103 のシンボル名・定数パス・対象処理記述を実コードに合わせて全面訂正し、`Rocket._recordActualFlightPath` L500/L539 の `len` 不整合バグと `r`/`phiSurf` 分岐の座標変換（および `TrailRenderer` 等の他描画箇所への横展開有無）を明記する。

#### F-02 [Critical] 要件1: `rotationAngle` 同期漏れ・`WorkerBridge` プール汚染・2パス `updateObjectParams` の原子的コミット不備
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L63–75
  - 実装: `scripts/gravsim_calc.js` L45–110 / `scripts/gravsim_worker_bridge.js` L7, L13–22, L32–223 / `scripts/gravsim_object_manager.js` L43–74, L111–124, L139–259, L442–446 / `scripts/gravsim_object.js` L339–350
- **現象**:
  1. `ObjectManager.addObject`（L65–67 の `CELESTIAL` 分岐）と `ObjectManager.updateObject`（L111–124）が `rotationAngle` を Worker へ送信しない仕様のままのため、`loadState()` 等で復元・設定した天体自転角が Worker 側で `0` に巻き戻る。
  2. `PhysicsEngine.addObject`（`gravsim_calc.js:47, 94–103`）は `param` が `null` のカスタム天体に対して `data.rotationPeriod` からのフォールバックを持たず、`ROTATION_PERIOD === 0` / `undefined` のゼロ除算ガードも設計書に未定義。
  3. `WorkerBridge._getBuffer()`（L13–22）はプール再利用時に `Float64Array` をゼロ初期化しないため、`formatWorkerToMain`（L32–138）で非ロケット／通常オブジェクトに対しても `ROTATION_ANGLE` (47)・`TM_MACH` (48) へ明示的に `0` 書き込みしないと過去データのゴミ値が混入する。
  4. `WorkerBridge.parseWorkerToMain`（L7, L149–221）は単一静的オブジェクト `this._cache` を使い回してコールバックを呼ぶため、2パス `updateObjectParams` の Pass 1 で `records.push(objData)` のように参照保存すると全レコードが末尾オブジェクトで上書き破壊される。Pass 1 では実オブジェクト生成（新規発生するのは `DEBRIS` のみであり、設計書 L72 の「未登録デブリ/ペイロード」の記述は誤り）と全状態反映を完了させ、Pass 2 用の対象リスト（および衝突/破砕フラグ判定に必要な情報）だけを別保持する構造にする必要がある。
  5. `Rocket.setCollided()`（`gravsim_object.js:339–350`）は `actualFlightPath = null` と `trajectory.clear()` を実行する。Pass 1 で `setCollided()` を実行してから Pass 2 で `updateHistory()` を呼ぶと、消去直後の軌跡へ再記録されてしまうため、Pass 2 の `updateHistory()` と衝突・破砕処理の実行順序（または衝突済オブジェクトの `updateHistory` 抑止）を明記する必要がある。
  6. `ObjectManager.updateObjectParams` の単一オブジェクト経路（L232–234）を通る既存単体テストは `rotationAngle` を渡さないため、`_applyBaseState`（L237–259）に `Number.isFinite(objData.rotationAngle)` ガードが必須。また新規生成デブリの Pass 2 `updateHistory` へ `isPaused` 引数が統一されているかも整理が必要。
- **修正方針**:
  - `ObjectManager.addObject`/`updateObject` への `rotationAngle` 送信追加、`WorkerBridge` 全種別スロット 0 クリア、`parseWorkerToMain` の `_cache` コピー／2パス設計詳細（Pass 1: 状態反映＋新規 `Debris` 登録、Pass 2: 未衝突アクティブオブジェクトの `updateHistory` 実行後に `isCollided`/`isShattered` 処理）、`Number.isFinite` ガードを設計書に追記する。

#### F-03 [Critical] 要件1: `TIME_COAST_CAP_S = 600.0` と `MAX_POINTS = 3000` の衝突による長期間予測の強制打ち切り
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L84, L94, L100
  - 実装: `scripts/gravsim_calc_predictor.js` L165, L316, L360–382, L590 / `scripts/gravsim_const.js` L305
- **現象**:
  1. `runMultiBodySimulation` は `while (simTime < maxSimTime && stepCount < maxSteps && points.length < maxPoints)`（`gravsim_calc_predictor.js:316`）で `MAX_POINTS = 3000` に到達するとシミュレーションを打ち切る。設計書 L84・L94 の通り `scaledCoastSampleTime` の上限を `TIME_COAST_CAP_S = 600.0`（10分）でキャップすると、1ヶ月で約 `4,383` 点、12ヶ月（`mars_transfer`）で約 `52,596` 点、36ヶ月（`jupiter_transfer` / `solar_escape`）で約 `157,788` 点が必要となり、**約 20.8 日時点で `points.length === 3000` に達して長期予測が強制終了（残余 90%〜98% 欠損）** する。
  2. 衝突時の重複点除去について、設計書 L100 は「メインループ後（L590）」のみ言及しているが、ループ内衝突分岐（L370–381）でも既に衝突点を `points.push()` して `break` している。L370 と L590 の二重追加整理（またはループ後のみに統一）が必要。
- **修正方針**:
  - `TIME_COAST_CAP_S = 600.0` の一律キャップを廃止し、支配天体・目標天体近傍（`minSurfaceDist < NEAR_BODY_DIST_M` 等）の区間または位置角・方位角変化（`ANGLE_DELTA_RAD` / `HEADING_DELTA_RAD`）が大きい曲線部でのみ密サンプリングし、長距離直線巡航時は `maxSimTime / (maxPoints * 0.7)` を維持して 12ヶ月〜36ヶ月全体が `3000` 点以内に収まる設計に改める。衝突時 L370 / L590 のポイント追加一元化および既存 `testsuites/regressions/07_trajectory_predictor.test.mjs:69`（`maxSimTime = 1200` で `points.length > 500` 必須）の充足条件も明記する。

#### F-04 [Major] 要件2: `RocketRenderer` ローカル座標軸の特定先送りと RCS ノズル幾何仕様の未確定
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L133, L139, L141–154
  - 実装: `scripts/gravsim_rocket_renderer.js` L8–34, L101–265 / `presets/visuals/rocket.json` L5, L24–56
- **現象**:
  1. 設計書 L139 が「実装工程時に `RocketRenderer.draw` の既存変換 `ctx.rotate(angle)` と機体描画軸 `±X / ±Y` を直接参照してノズル位置・噴射ベクトルを一意に整合させる」と設計を先送りしており、Gate 1 の「曖昧性の排除」を満たしていない。
  2. 実コード `gravsim_rocket_renderer.js:8–11, 144–264` では `ctx.rotate(rocket.thrustAngle)` のもと、ローカル座標 **`+X` が機首（前）、`-X` が機尾（後）、`+Y` が時計回り（CW, `+Δθ`）側、`-Y` が反時計回り（CCW）側** である。かつ段数・現在段により機体端座標が大きく非対称に変化する（例：2段第1段は `-2.75R .. +2.7R`、2段第2段は `-0.6R .. +1.7R`、3段第1段は `-3.1R .. +3.5R`、ペイロード単独時は `±0.7 * payloadR` の衛星バス）。設計書 L143–144 の `"NOZZLE_NOSE_OFFSET_RATIO": 0.34`, `"NOZZLE_AFT_OFFSET_RATIO": -0.42` は「どの区間長に対する比か」「ノズルの `Y` 側壁位置（`±r1` / `±r2` 等）」や、CW 時の正確な噴射ベクトル（機首 `+X` 側で `-Y` 方向噴射、機尾 `-X` 側で `+Y` 方向噴射）、さらに `geom` のインターフェースや `MIN_BODY_PX: 6` と `LOD_RADIUS_THRESHOLD = 4.0`（`rocket.json:5`）の関係が一切定義されていない。
- **修正方針**:
  - ローカル座標定義（`+X` 前方、`+Y` CW側）、段別・ペイロード別の前後端 `(xMin, xMax)` と胴体半径 `yHull` の `geom` 取得式、比率の基準（`(xMin, xMax)` 間の正規化位置か中心基準長か）、CW / CCW / Ullage の明確なノズル座標 `(nx, ny)` と噴射単位ベクトル `(ux, uy)`、低詳細描画時の扱いを設計書に確定記載する。

#### F-05 [Major] 要件2: `CalcRocket._updateRcsState` の目標角取得・`INTERSTAGE_COAST`・再点火前 Ullage の矛盾
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L128–137
  - 実装: `scripts/gravsim_calc_object.js` L1003–1010, L1128–1162 / `scripts/gravsim_flight_computer.js` L364–469
- **現象**:
  1. `gravsim_calc_object.js:1003–1007` では `this.flightComputer.update()` 後に `this.thrustAngle = this.flightComputer.currentThrustAngleRad` を上書きしてから戻るため、呼び出し後に `flightComputer.currentThrustAngle` を `targetAngle` とすると `err` が常に `0` になる。一方 `targetLaunchAngle` を使うとタワークリアランス垂直上昇、Load Relief / AoA クランプ、`STG_MECO` プログレード追従、分離後太陽指向 `sunAngle`（`gravsim_flight_computer.js:372–418, 420–456`）と一致しない偽の誤差が出る。
  2. `autoControl === false` のときでも `postSepSettleTimer > 0` なら発火する条件（L131）において、参照すべき `targetAngle` が未定義。
  3. `FlightComputer._computeThrustAngle`（L370）は `if (sensor.burnTime <= 0)` でコースト姿勢分岐へ入るため、次段が `_activateStage` 済（`burnTime > 0`）の `INTERSTAGE_COAST` 中に誤って上昇誘導側を実行する既存問題への考慮がない。
  4. L136 の「再点火直前コースト中（`ULLAGE_PRE_IGNITION_S: 1.8`）」は、現行 `gravsim_calc_object.js:1128–1134` が `throttle > 0` を受けた瞬間に無遅延で `STG_BURNING` へ遷移する仕様と矛盾しており、プロファイル先読みまたは予点火タイマ遷移がないと点灯条件が存在しない。
- **修正方針**:
  - `FlightComputer._computeThrustAngle` 内で更新前後の実回転量・目標姿勢（`desiredAngle` と更新前角度、および `STG_MECO` / `INTERSTAGE_COAST` 時の姿勢制御）から角誤差・旋回要求を算出する契約を定め、Ullage の点灯契機（例：`INTERSTAGE_COAST` 末尾 `ULLAGE_PRE_IGNITION_S` 秒、および再点火時 `STG_COAST` 予点火遅延を導入するか点火後沈降とするか）と `INTERSTAGE_COAST` 中の `FlightComputer` 姿勢扱いを明確化する。

#### F-06 [Critical] 要件3: `AeroUtils` の天体大気パラメータ名誤り（`SURFACE_PRESSURE` / `SCALE_HEIGHT` 不在）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L161–164, L303
  - 実装: `presets/celestials/earth.json` L11–15 / `presets/celestials/moon.json` / `scripts/gravsim_preset_manager.js` L58–62 / `scripts/gravsim_calc_object.js` L154
- **現象**:
  - 天体 JSON と `PresetManager._normalizeCelestial`（`gravsim_preset_manager.js:58–62`）の実際の正規化フィールド名は **`ATM_DENSITY_0` / `atmDensity0`**, **`ATM_SCALE_HEIGHT` / `atmScaleHeight`**, **`ATM_LIMIT_ALT` / `atmLimitAlt`** であり、`SURFACE_PRESSURE` や `SCALE_HEIGHT` はコードベース全体に一切存在しない。設計書記載のまま実装すると全天体で無大気判定（マッハ数 `0`）または `NaN` になる。
- **修正方針**:
  - 設計書およびテスト仕様（L162, L164, L303）を実在フィールド名（`ATM_DENSITY_0`, `ATM_SCALE_HEIGHT`, `ATM_LIMIT_ALT` および小文字別名フォールバック）へ修正する。

#### F-07 [Major] 要件3: `VAPOR_CONE` の SSOT 違反・マッハ角／寸法未定義・速度0/大気圏外クリア漏れ・`SoundEffects` フォールバック未設計
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L167–190, L172
  - 実装: `scripts/gravsim_const.js` L75–81 / `scripts/gravsim_calc_object.js` L176–178, L204–210, L1281–1287 / `scripts/gravsim_object_manager.js` L314–356 / `scripts/gravsim_sound_effects.js` L344–346
- **現象**:
  1. 閾値（`0.82`, `1.22`, `0.015`）を `gravsim_const.js` の `AERO_DYNAMIC` と `presets/visuals/rocket.json` の `VAPOR_CONE` 双方に二重定義しており SSOT 原則に反する。また現行 `AERO_DYNAMIC`（L75–81）に当該キー追加の明示も L168 で漏れている。
  2. L168 は $\mu = \arcsin(0.96)$ を「~78°」と記すが正しくは **`73.74°`**。また `PRIMARY_AXIAL_RATIO: 0.22`, `SECONDARY_AXIAL_RATIO: -0.10`, `WIDTH_MULTIPLIER: 2.8`, `LENGTH_MULTIPLIER: 2.4` の座標基準（機首基準か全体幅基準か、マッハ角 $\tan\mu$ との結合式と `WIDTH_MULTIPLIER` クランプ関係）が未定義であり、そのまま `length * tan(73.74°)` を計算すると全幅が過大化する恐れがある。
  3. `GravSimCalcObject.applyAerodynamics`（`gravsim_calc_object.js:176–178`）は `if (vRelSq === 0) return;` で早期終了するため、その前での `this.mach = 0` 設定および `clearAerodynamicParameters`（基底 L204–210・`CalcRocket` L1281–1287 の両方）での `this.mach = 0` リセットが欠落している。
  4. `SoundEffects`（`gravsim_sound_effects.js:346`）は `rocket.telemetry` を参照するため、`ObjectManager._applyRocketState` で `target.mach` に加えて **`target.telemetry.mach`** にも格納する必要がある。また `telemetry.mach === undefined` 時のフォールバックで必要な `altM` とホスト天体 `atmParam` の取得手順（`rocket.dominantBodyId` からの参照など）が未定義。
- **修正方針**:
  - 遷音速閾値の SSOT 配置先を統一し、マッハ角・コーン座標計算式、`applyAerodynamics` ゼロ速度時と両 `clearAerodynamicParameters` での `mach = 0` 初期化、`target.telemetry.mach` 同期と `SoundEffects` フォールバックの引数解決手順を設計書に明記する。

#### F-08 [Critical] 要件4: 2段ロケットの `sep_stage2` 構造矛盾・`sep_payload` による自走ペイロード破壊・下段スキップ未定義
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L214–222
  - 実装: `scripts/gravsim_calc_object.js` L431–572 / `scripts/gravsim_rocket_renderer.js` L37–41, L105–109, L126–130, L234–264 / `scripts/gravsim_worker_bridge.js` L111, L116 / `scripts/gravsim_object_manager.js` L295, L300, L346 / `scripts/gravsim_telemetry_panel.js` L673–683
- **現象**:
  1. 現行コード（`CalcRocket.separateCurrentStage` L442, L517–570、`RocketRenderer._drawHighDetail` L105–109、`WorkerBridge` L116、`ObjectManager` L300、`TelemetryPanel` L674）は、2段式ロケットにおいて「第2段終了・切り離し」と「ペイロード分離（`isPayloadSeparated = true`）」を同一遷移としている。設計書 L217 のように「2段式ロケットで `sep_stage2` 時に `STAGE2_SEPARATED` だけ立てて `isPayloadSeparated = false` のまま第2段乾燥質量を減算する」と、(a) 描画側に「2段タンク無し・未分離ペイロード」の表示分岐が無く依然2段本体を描画し続ける、(b) Stage 2 デブリが放出されない（運動量・ビジュアル不整合）、(c) `WorkerBridge` L116・`ObjectManager` L300・`TelemetryPanel` L674 が `STAGE2_SEPARATED` フラグを別軸扱いしておらず表示と音シーケンスが齟齬を起こす。
  2. L219 が `sep_payload` / `separatePayload()` を「**推進・操舵終了**」と規定しているが、自走推進付きペイロード（`geo_sat`, `htv_x`, `lunar_orbiter`, `mmx`：統合テスト `06` で検証済）は `separateCurrentStage` L527–555 により分離後に独自推進系を起動して `STG_COAST` へ移行し、姿勢制御やアポジー再点火を行う必要がある。
  3. 1段燃焼中や2段（3段機）燃焼中に `sep_payload` が指定された際、未分離の下段・フェアリングをどう処置するか（順次切り離しデブリ放出か禁止か）が未定義。
- **修正方針**:
  - 2段式機体における `sep_stage2` と `sep_payload` の厳密な責任境界（原則として「最終段未分離時の `sep_payload` は必要なら現行段も順次分離し、2段機の `sep_stage2` は最終段切り離しとして扱う」等、もし別イベントとして残す場合は第2段デブリ放出と `RocketRenderer` / `TelemetryPanel` / `WorkerBridge` / `ObjectManager` / `calc_predictor` 全箇所の一貫定義を記載）、および自走ペイロード搭載時に `separatePayload()` が推進系を引き継いで `STG_COAST` へ移行する仕様へ修正する。

#### F-09 [Critical] 要件4: `FlightComputer` / `calc_predictor` / `TelemetryPanel` の `vel`・`apogee`・イベント検出・ステップ飛ばし不備
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L202, L204–211, L265
  - 実装: `scripts/gravsim_flight_computer.js` L58–156, L364–469 / `scripts/gravsim_calc_predictor.js` L427–448, L522–532 / `scripts/gravsim_tab_rocket.js` L463 / `scripts/gravsim_telemetry_panel.js` L678–683
- **現象**:
  1. `"vel"` トリガ（L202）は `FlightComputer._evaluateProfile`（L69–86）にも `RocketTab._renderProfileTable`（L463）にも **存在しない**。参照速度の定義（対ホスト相対速か対気速か）と予測イベント（`gravsim_calc_predictor.js:522–532`）での扱いを明記した新規追加仕様が必要。
  2. `missionElapsedTime`（L211）というプロパティは存在せず実名は `flightTime`（`gravsim_flight_computer.js:141–143`）。また `ORBITAL_COAST` 中に `flightComputer.update` がプロファイル再点火（throttle上書き）を行わず `action` のみ監視する制御仕様が必要。
  3. L202 の `apogee` 発火条件「**燃料残**かつ動径速度 `<= 15 m/s`」は、同じ設計書 L211 の「軌道投入後（SECO 後＝燃料 0）に `apogee` でペイロード分離」と **自己矛盾** している。さらに `<= 15 m/s` 条件にすると上昇中（垂直成分低下時）や弾道飛行で早発火し、既存回帰テスト `testsuites/regressions/05_payload_and_events.test.mjs:438–495`（`time: 340 -> apogee: 0` 再点火）を壊す危険が高い。
  4. `_evaluateProfile` は単なる `_highestStepIndex` 先頭からの順次 `break` ループ（L69–86）だと、1サブステップで複数ステップ（例：`sep_stage1` と次の `alt` ステップ）を跨いだ場合や、`alt`/`time`/`apogee` 混在プロファイルで後続ステップが先に発火する場合に中間の `action` を取りこぼす。
  5. `gravsim_calc_predictor.js:427, 437` の予測イベント検出は **`lastStageState === 'STG_MECO'`** を前提としているため、フライトプロファイルの `action` により `STG_BURNING` や `ORBITAL_COAST` から直接分離すると **`stg_sep_1` / `stg_sep_2` / `payload_sep` イベントが予測タイムラインから完全に欠落する**。また `TelemetryPanel` L681 は `isOrbit` かつ最終段非燃焼のとき未分離でも `P-SEP` ランプを誤点灯させてしまう。
- **修正方針**:
  - `vel` トリガ（単位・速度定義・UI `<option>`・予測対応）の新規定義、`flightTime` 使用への訂正、`apogee` 検出は既存の通過判定（`_prevVv > 0 && vV <= 0 && altM >= APOGEE_MIN_ALT_M` 等、燃料残要件を付けない）との整合設計、跨ぎステップ漏れの無い独立ラッチ（`_executedStepIndices` 等）、および `calc_predictor.js` の状態変化ベース（`currentStageIndex` 増加 / `!lastIsPayloadSeparated && rocket.isPayloadSeparated`）分離検出と `TelemetryPanel` L681 条件の適正化を明記する。

#### F-10 [Critical] 要件4: ミッションパラメータ貫通漏れ・`applyToLauncher` 誤仕様・深宇宙サイジング・既存テスト (`06`, `07`, `05_ui`) との非互換
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L224–267
  - 実装: `scripts/gravsim_preset_manager.js` L741–817 / `scripts/gravsim_rocket_launcher.js` L41–63, L419–445, L474–475, L700–751 / `scripts/gravsim_object_placer.js` L92–174 / `scripts/gravsim_trajectory_predictor.js` L161–188 / `scripts/gravsim_calc_predictor.js` L195–222 / `scripts/gravsim_object_manager.js` L76–103 / `presets/missions/*.json` / `index.html` L473 / `style.css` L27, L949–982 / `testsuites/integration/06_external_presets_and_payload_propulsion.test.mjs` L362–364, L581–582 / `testsuites/integration/07_preset_orbit_insertion.test.mjs` L382, L525, L530–594 / `testsuites/unit/05_ui_telemetry_audio.test.mjs` L1642
- **現象**:
  1. **受け渡し経路・永続化の未反映**: `ObjectPlacer.placeObject`（L92–174）、`ObjectManager._buildRocketPayload`（L76–103）、`RocketLauncher._getPredictionContext`（L419–445）、`TrajectoryPredictor._buildSimulationParams`（L161–188）、`runMultiBodySimulation`（L195–222）のいずれも `disableOrbitalCutoff`, `targetApogeeKm`, `targetPerigeeKm`, `targetVInfKmS` を受け渡していない（`disableOrbitalCutoff` 等の一部経路も抜けており全量貫通が必要）。また `RocketLauncher` コンストラクタは `currentPayloadId` / `currentMissionId` を初期化せず、`getState`/`loadState`（L700–751）にも保存しない。`updatePrediction` のキャッシュキー（L474–475）にも `action`・`stages`・ミッションターゲットを含める必要がある。
  2. **`applyToLauncher` シグネチャ誤記と既存テスト `06` 破壊**: 設計書 L235 は `applyToLauncher(vehicleId, payloadId, missionId, options = {})` と誤記しているが、実装は `applyToLauncher(launcher, { vehicleId, payloadId, missionId } = {})`（L741）。さらに L237 の「`options.applyRecommendedMission === true` のときだけ `recommendedMissionId` を適用」とすると、既存テスト `06_external_presets_and_payload_propulsion.test.mjs:362–364`（`pm.applyToLauncher(mockLauncher, { payloadId: 'geo_sat' })`）および同 L581–582（`{ payloadId: 'mmx' }`）が **`options` 指定なしで推奨ミッション反映を期待しているため失敗する**。正しくは「`missionId` 未指定かつ **`payloadId !== undefined`**（明示的にペイロードを変更したとき、または `applyRecommendedMission === true`）のときに推奨ミッションを反映し、`payloadId === undefined`（車両変更のみ）では `launcher.currentMissionId` を維持する」とすべきである。
  3. **円軌道カットオフ・ピッチ誘導仕様不足とテスト `07` 破壊リスク**: L256 は ISS（400×400）に対して `peKm >= max(160, 400 * 0.85) = 340 km` かつ `apKm >= 360 km`（既存の `|| (ecc <= 0.04 && peKm >= 140)` を除去する形）を要求する一方、`ORBIT_ASSIST` 閉ループ水平ピッチ誘導の数式・切替条件・ゲインが一切未記載であり、そのまま昇ると `apKm` が `07_preset_orbit_insertion.test.mjs:382` の上限 `550 km` を超過してテスト失敗する危険が高い。また設計書 L243 は `lunar_insertion` を `targetPerigeeKm: 200` と書いているが、現行 `presets/missions/lunar_insertion.json:9` は `250` であり差異意図の説明がない。
  4. **深宇宙Δvサイジング閾値 `13500` が `mars_transfer` を取りこぼし、物理上限と衝突**: `presets/missions/mars_transfer.json:8` の `targetDeltaVM_S` は **`12800`** であり（`jupiter_transfer.json` `14500`, `solar_escape.json` `15500`）、L263 の `> 13500` 条件では **Mars Transfer がサイジング対象外となる**。さらに `14500 / 15500 m/s` 自体が重力・大気損失込みで $v_\infty = 9.0 / 12.8\text{ km/s}$ に必要な実Δv（~15.6 / ~18+ km/s）を下回っており、`falcon9`（`isp=320s`）等の非水素機体では上段燃料上限（`1500t / 3000t`）・推力スライダ上限 `#rl-launch-thrust max="10000"`（`index.html:473`）・`07_preset_orbit_insertion.test.mjs:572` の `1200` ステップ以内完了条件（`h3_24` 第2段 `160 kN` で増槽しすぎると燃焼が `1200s` を超える）との両立計算仕様が欠落している。
  5. **7ミッション差別化仕様の具体値欠落**: 現行 `presets/missions/` は `iss_rendezvous` 以外の6ミッションが同一の `flightProfile`（`alt: 0..380000` 9行）を共有しているが、設計書には各ミッションで変えるプロファイル行・分離アクション・目標値の一覧が未記載。
  6. **6列 UI テーブルによる既存テスト衝突と 320px 幅レイアウト詳細不足**: `#rl-flight-profile-table` を6列化すると、既存テスト `testsuites/unit/05_ui_telemetry_audio.test.mjs:1642`（`row0.children[4].children[0]` を削除ボタンとしてクリック）が壊れる（`children[5]` へ移動する）ためテスト更新方針の明記が必要。また `.sidebar` `width: 320px`（`style.css:27`）で `<input type="number">` のスピンボタン・列幅比率・パディングをどう収めるかの CSS 詳細仕様が必要。
- **修正方針**:
  - 上記全貫通経路と `RocketLauncher` 状態項目の網羅、`applyToLauncher` の正確な条件式、`ORBIT_ASSIST` 誘導式、`lunar_insertion` perigee 値および深宇宙サイジング対象判定（`disableOrbitalCutoff === true` または `targetVInfKmS > 0` も考慮）・推力／燃焼時間／`1200` ステップ制約との整合、7ミッション具体プロファイル表、6列 CSS 比率・既存 UI テスト追従方針を設計書へ追記する。

#### F-11 [Major] 要件5: `gravsim_object_manager.js` の同種タイポ見落とし (`tmBurnTime`) と `getState`/`loadState` 欠損フィールド
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L276–277
  - 実装: `scripts/gravsim_object_manager.js` L295, L300, L312, L386–453
- **現象**:
  1. `gravsim_object_manager.js:295` の `objData.tmPayloadSeparated` タイポ修正だけが挙げられているが、同メソッド L312 に同一パターンの **`objData.tmBurnTime`**（正しくは `objData.burnTime`）が残存している。また L300 の `isStage2Separated` も `objData.isStage2Separated` を見ず `curStg >= 2 || isPayloadSep` で上書きしている。
  2. `getState`/`loadState`（L386–453）の強化項目（L277）から、**`Debris` の `debrisSubType`, `colorTheme`, `baseRadiusM`**、**飛行中 `Rocket` の `currentStageIndex`, `totalStages`, `baseRadiusM`, `bottomOffsetM`, `hostAngleRad`, `hostAltM`, `isPayloadSeparated`, `isBoosterBurnout`, `isBoosterSeparated`, `hasPayloadPropulsion`, `stageState`, `stgTimer`**、および **`CelestialBody` の `param`** が漏れている（段分離済みのロケットをロードすると Stage 0 状態に戻る）。
- **修正方針**:
  - `objData.burnTime` 修正と `isStage2Separated` 同期、および上記 `Debris` / `Rocket` ランタイムステート / `CelestialBody` の全フィールド永続化仕様を設計書に追加する。

#### F-12 [Major] 要件5: `InfoPanel` 型変更 (`Date` → `number`) による `tsc --noEmit` × 既存テスト衝突
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L278, L295
  - 実装: `scripts/gravsim_info_panel.js` L20, L88–90 / `testsuites/unit/05_ui_telemetry_audio.test.mjs` L953
- **現象**:
  - `InfoPanel` の `this.lastTime` を `Date.now()`（`number`）へ変更し、同時に `jsconfig.json`（`checkJs: true`）で `testsuites/**/*.mjs` まで型チェックすると、既存テスト `testsuites/unit/05_ui_telemetry_audio.test.mjs:953` が **`info.lastTime = new Date(Date.now() - 600);`** を代入しているため即型チェックエラー（または実行時 `Date.now() - Date` = NaN）を引き起こす。
- **修正方針**:
  - 設計書に `05_ui_telemetry_audio.test.mjs:953` の更新方針、または `InfoPanel` 側での安全変換（`const lastMs = this.lastTime instanceof Date ? this.lastTime.getTime() : this.lastTime;` と JSDoc `number | Date`）を明記する。

#### F-13 [Minor] テスト設計: `test:coverage` と `testsuites/system/` の一括実行干渉
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L313–317, L323
  - 実装: `testsuites/run_all.mjs` L53–58 / `package.json` L7, L11–12
- **現象**:
  - `npm run test` および `npm run test:coverage` は `testsuites/run_all.mjs:53–58` により `testsuites/system/*.test.mjs` も含めてすべて実行する。ヘッドレス Chrome テストは静的 HTTP ポート（固定ポートだと並列・再実行で競合）およびプロセスリーク防止設計を明確にしておかないと、`test:coverage` 自体がハングまたは異常終了する。またブラウザ側スクリプトの実行分は Node の `--experimental-test-coverage` には計測されないため、カバレッジ目標 90%〜97% 以上は Unit / Integration / Regression で達成する計画であることを確認する必要がある。
- **修正方針**:
  - `testsuites/system/chrome_helper.mjs` に動的エフェメラルポート (`server.listen(0)`) と `try/finally`（異常終了時 Chromium SIGKILL）を要件化し、UI E2E とは別に Node テスト側でカバレッジ 97% 目標を確保する方針を明記する。

---

### 2. 横展開確認（Horizontal Check）

全 `scripts/*.js` および `testsuites/**/*.mjs` を横断検索し、同種パターンの残存状況を確認した：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| `tm*` フィールド名タイポ (`WorkerBridge` 出力 vs `ObjectManager`) | `gravsim_object_manager.js:295` (`tmPayloadSeparated`) に加え **L312 (`objData.tmBurnTime`)** を発見。また L300 (`isStage2Separated`) が `objData.isStage2Separated` を無視。 | **要適用（L295・L300・L312 を一括是正）** |
| ハードコード音速 `340` | `scripts/` 全体検索の結果、`scripts/gravsim_sound_effects.js:346` の1箇所のみ。 | **適用済計画あり（フォールバック入力設計の補完要）** |
| 大気パラメータ名参照 | `gravsim_calc.js:735`, `gravsim_calc_object.js:154`, `gravsim_tab_navi.js:122`, `gravsim_preset_manager.js:58–62` はすべて `ATM_DENSITY_0` / `ATM_SCALE_HEIGHT` / `ATM_LIMIT_ALT` を使用。設計書 L162, L164, L303 の `SURFACE_PRESSURE` / `SCALE_HEIGHT` が単独で誤り。 | **要適用（設計書用語を `ATM_*` に統一）** |
| 描画の二重減算・浮動小数点精度（`(abs - basis)`） | `gravsim_trajectory_predictor.js:542–589, 698, 763` のほか、**`scripts/gravsim_trail_renderer.js:233–239`（`EffectTrail` 描画）** でも `absX = relX + refObj.x; const rx = (absX - basisPos.x) * zoomScale` と世界座標加算後に `basis` 減算している箇所を発見。`GravSimObject.draw`（`L150`）・`Rocket.draw`（`L574`）は直接 `x - basis.x`。 | **要横展開検討（`TrailRenderer` L233–239 も `(refObj.x - basisPos.x) + relX` 順へ統一）** |
| `new Date()` 減算 | `scripts/` 全体で `gravsim_info_panel.js:20, 89–90` のみ（`gravsim_save_manager.js:41` はファイル名フォーマット用途で正当）。ただしテスト `05_ui_telemetry_audio.test.mjs:953` との型互換注意。 | **要適用（テスト側含め整合）** |
| `actualFlightPath` 間引き末尾保持 | `gravsim_object.js:500, 538–539` の1箇所のみ。`len` が `push` 前取得のため最新点を削除する不具合あり。 | **要適用（`this.actualFlightPath.length - 1` 使用）** |
| `isStage2Separated` / `PAYLOAD_SEPARATED` フラグ参照 | `gravsim_const.js:529, 619`（シーケンサ音響トリガ）、`gravsim_telemetry_panel.js:673–683`（`2sep`/`psep` ランプ）、`gravsim_worker_bridge.js:116`、`gravsim_object_manager.js:300, 346` に存在。 | **要一括整合（2段式 `sep_stage2` と遅延 `sep_payload` の全箇所整合必須）** |
| `JSON.parse` 入力検証 | `gravsim_save_manager.js:57` が未ガード。`gravsim_preset_manager.js` は既読込チェック有。 | **計画通適用＋不正構造オブジェクト (`!state || typeof state !== 'object'`) ガード推奨** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **既存テストとの完全互換検証が不可欠な境界条件**:
   - `testsuites/unit/01_core_physics.test.mjs:264, 307`（`WorkerBridge` テスト）：`CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT` 定数を参照しているため `47 -> 49` 拡張自体には追従するが、テスト内のモックオブジェクトが `rotationAngle` / `mach` / `flags` 未設定でも壊れないことを要確認。
   - `testsuites/regressions/07_trajectory_predictor.test.mjs:69`：`maxSimTime = 1200` で `points.length > 500` をアサートしている。サンプリングロジック見直し後も 500 点超を維持すること。
   - `testsuites/integration/06_external_presets_and_payload_propulsion.test.mjs:362–364, 581–582`：`applyToLauncher(launcher, { payloadId })` が `options` 無しで `recommendedMissionId` を適用する挙動を壊さないこと。
   - `testsuites/integration/07_preset_orbit_insertion.test.mjs:358–594`：ISS (`step < 850`, `ecc < 0.05`, `140 <= peKm`, `380 <= apKm <= 550`)、GTO (`step < 1200`, `ap >= 35000`)、TLI (`step < 1200`, `ap >= 350000`)、Mars (`step < 1200`, `E > 0`, `ecc > 1.0`) すべてを壊さない誘導／サイジング式にすること。
   - `testsuites/regressions/05_payload_and_events.test.mjs:438–495`：`time: 340` のコースト後 `apogee: 0` 再点火による円軌道投入が壊れないこと。
   - `testsuites/unit/05_ui_telemetry_audio.test.mjs:953, 1642`：`InfoPanel.lastTime` の `Date` 代入と `#rl-flight-profile-table` 削除ボタン `children[4]` 参照は設計修正と同期してテスト側/互換ハンドリングを設計すること。
2. **設計書修正後の確認観点（Gate 1 Iteration 2 に向けて）**:
   - **「実装時に参照して決める」などの先送りをゼロ**にし、RCS ノズル位置・向き、ベイパーコーン座標・幅式、`ORBIT_ASSIST` 誘導式、各ミッション用 `flightProfile` 差分をすべて設計書上で数値・式・型レベルまで一意に確定させること。
   - `tsc --noEmit`（`checkJs: true`）導入時に全 `scripts/*.js` と `testsuites/**/*.mjs`（モックオブジェクトの拡張プロパティや JSDoc 欠落を含む）で既存の潜在型エラーが出得るため、`jsconfig.json` の対象範囲と JSDoc 補完方針を明確にしておくこと。


---

## 独立監査1: 設計監査 — Iteration 2

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 2
- **実施日時**: 2026-11-20 15:29 JST
- **判定**: **FAIL**

Rev 2 設計書（[docs/design/2026-11-20_trajectory_fx_flightplan.md](../design/2026-11-20_trajectory_fx_flightplan.md)）を Iteration 1 指摘 F-01〜F-13 および実コードベース・プリセット JSON・既存テスト群（物理シミュレーション数値検証含む）とゼロベースで突合した。

**Iteration 1 指摘の反映状況**:
- **解消済**: F-04（ローカル座標軸 `+X` 機首 / `+Y` CW・トルク一致 RCS ノズル幾何）、F-06（`ATM_DENSITY_0` / `ATM_SCALE_HEIGHT` / `ATM_LIMIT_ALT`）、F-08（2段 `sep_stage2` 統合・`sep_payload` 順次分離＋自走ペイロード推進維持）、F-09（`vel`/`apogee` トリガ・`flightTime`・`calc_predictor` 状態遷移検出・`TelemetryPanel`）、F-10 の一部（`applyToLauncher` 契約・6列 UI と `05_ui` テスト追従・4ターゲット貫通）、F-11（`tmBurnTime`・`isStage2Separated`・`getState`/`loadState` 項目拡張）、F-12（`InfoPanel` 型互換）、F-13（動的エフェメラルポート・`try/finally`・カバレッジ 97% 計画）。
- **未解消／新規デグレード検出**: **7ミッションのピッチ角定義の上下反転 (`90° ↔ 0°`) と `iss_rendezvous` 行数不足による既存テスト破壊、`ORBIT_ASSIST` 誘導式の符号曖昧性と実際の物理軌道投入失敗、`ObjectManager` Pass 2A `updateHistory` 引数破壊、`CalcRocket` ウルジ `stgTimer` 比較方向逆転、`SoundEffects` 存在しない `universe.getObjectById` 参照、`NearBody 15s` による 3000 点枯渇再発、深宇宙サイジングの境界・TWR 破綻** を新規/残存不具合として検出した。よって Gate 1 を差し戻す。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### F2-01 [Critical] 7ミッションのピッチ角定義が上下反転 (`90° ↔ 0°`) しており、`iss_rendezvous` 行数不足で既存テストが即失敗する
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L304–311
  - 実装・テスト: `scripts/gravsim_flight_computer.js:159–162`, `scripts/gravsim_rocket_launcher.js:39, 906–910`, `presets/missions/*.json`, `testsuites/unit/03_celestial_world.test.mjs:1169`
- **現象**:
  1. `FlightComputer`（`gravsim_flight_computer.js:162`）および `RocketLauncher`（`L909–910`）において、`flightProfile[].angle` は **天頂基準オフセット角**（`0°` = 垂直上昇、`90°` = ローカル水平）である（現行 `presets/missions/*.json` はすべて `(alt 0 -> 0°)` から `(380000 -> 90°)`）。しかし Rev 2 L305–311 は全7ミッションについて **`(alt 0 -> 90°)` から `(140000 -> 0°)`** と角度を 90° 補角で反転記載しており、そのまま適用すると地上から水平発射し軌道上で垂直噴射する破綻状態になる。
  2. Rev 2 L306 は `iss_rendezvous` を **6行** としているが、`RocketLauncher`（`L39`）の既定ミッションが `iss_rendezvous` であるため、既存テスト `testsuites/unit/03_celestial_world.test.mjs:1169`（`assert.ok(rl.flightProfile.length >= 8)`）が即失敗する。
- **修正方針**:
  - 全7ミッションのピッチ角を現行座標規約（`0°` 垂直 〜 `90°` 水平）に訂正し、`iss_rendezvous`（および共通整合のため他ミッションも必要に応じて確認）は `>= 8` 行を維持したうえで全機体・全ミッションで軌道投入が成立する具体値を記載・検証する。

#### F2-02 [Critical] `ORBIT_ASSIST` 誘導式の符号曖昧性・制御権不整合・LEO/ISS 軌道投入失敗
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L280, L283–292
  - 実装・テスト: `scripts/gravsim_calc_object.js:1003–1007`, `scripts/gravsim_flight_computer.js:159–166, 236–259, 364–469`, `testsuites/integration/07_preset_orbit_insertion.test.mjs:157–260, 309–383`
- **現象**:
  1. **符号・ベクトルの曖昧性と反転リスク**: Canvas 世界座標系では動径外向き角 $\theta = \text{atan2}(dy, dx)$ に対し順行水平方向（$v_h \ge 0$）が $\theta + \pi/2$ であるため、水平から動径外向き（天頂側）へ $+\gamma_{\text{cmd}}$ だけ起こす変換は **`horizAngle - Math.sign(v_h || 1) * gamma_cmd`**（またはベクトル合成 $\vec{t} = \cos\gamma_{\text{cmd}} \cdot \text{sign}(v_h || 1)\hat{u}_H + \sin\gamma_{\text{cmd}}\hat{u}_R$, `atan2(t_y, t_x)`）となる。Rev 2 L289 の曖昧な文言（`radialOutAngle ± PI/2` と `+gamma_cmd`）通りに `+gamma_cmd` を加算すると地球側（下向き）へピッチダウンして墜落する（実 `PhysicsEngine` 検証で `h3_22` `peKm = 9.4 km`、`falcon9` `74.6 km`、`epsilon` `18.1 km`、`ssto` `2.1 km`、`ISS h3_22` `-43.0 km` を確認）。
  2. **逆行軌道での `max(400, v_h * 0.35)` クランプ誤り**: 逆行（$v_h < 0$）時に `v_h * 0.35 < 0` となり常に `400` へ固定されるため、`Math.abs(v_h) * 0.35` とする必要がある。
  3. **プロファイル＋`ORBIT_ASSIST` 組み合わせの物理未収束**: 外向き符号を正しく `-gamma_cmd` に補正した上で設計書 L284–292 と L305–306（角度を `0°→90°` へ戻したプロファイル）を実 `PhysicsEngine._moveObjects(1.0)` で検証した結果、`leo_250km` で `h3_30`（`ecc=1.1687` 未カットオフ）、`h3_22`（`peKm=132.2`, `ecc=1.1689`）、`falcon9`（`peKm=85.5`, `ecc=2.0256`）、`epsilon`（`peKm=97.7`）、`ssto`（`peKm=121.6`）および `iss_rendezvous` で `h3_22`（`peKm=63.9`, `apKm=7872`）・`h3_30`（`apKm=3063`）がいずれも **`07_preset_orbit_insertion.test.mjs` 要件（`peKm >= 140`, `ecc < 1.0`, `ISS apKm 380..550`, `< 850s`）を満たさず失敗**する（原因: 低高度 `100 km` で早すぎる `ORBIT_ASSIST` 介入・`v_r * 0.65` 項および急ピッチプロファイルにより近地点形成前に脱出速度到達または降下）。
  4. **制御モジュール責務の矛盾**: 設計書 L280 は `ORBIT_ASSIST` を `(CalcRocket)` 配下としているが、`CalcRocket.flightControl` L1007 は毎ステップ `this.thrustAngle = this.flightComputer.currentThrustAngleRad` を上書きするため、`FlightComputer._computeThrustAngle` 内に統合するか `desiredThrustAngleRad`／`currentThrustAngle` を同期しないと姿勢と `_updateRcsState` が破綻する。
- **修正方針**:
  - `ORBIT_ASSIST` を `FlightComputer` へ統合（`targetApogeeKm` / `targetPerigeeKm` を渡す）し、上記ベクトル合成による符号ミス不可能な世界角変換式と `Math.abs(v_h)` を明記する。さらに全6機体（`leo_250km`）と `iss_rendezvous` が現行テスト `07` の全制約（`peKm >= 140`, `ISS apKm 380..550`, `ecc < 0.05`, `< 850s`）を実物理エンジン上で通過するプロファイル・介入開始条件・ゲインを設計書に確定する。

#### F2-03 [Critical] `ObjectManager.updateObjectParams` Pass 2A の `updateHistory` 引数誤りによる実行時クラッシュ
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L45, L83
  - 実装: `scripts/gravsim_object_manager.js:153`, `scripts/gravsim_object.js:54, 70, 353, 383`
- **現象**:
  - 設計書 L45・L83 は `target.updateHistory(universe, dt, isPaused);` と記述しているが、`GravSimObject.updateHistory`（L54）および `Rocket.updateHistory`（L353）の実際の仮引数は **`(currentFrame, objects, isPaused = false)`** であり、現行 `ObjectManager` L153 の実呼び出しは `target.updateHistory(this.physicsSequence, this.objects, isPaused);` である。設計書通り実装すると第2引数 `objects` に数値 `dt` が渡り、L70・L383 の `objects.find(...)` で毎フレーム `TypeError: objects.find is not a function` でクラッシュする。
- **修正方針**:
  - 設計書 L45・L83 を **`target.updateHistory(this.physicsSequence, this.objects, isPaused);`** へ訂正する。

#### F2-04 [Critical] `CalcRocket` ステージ間ウルジ条件 `stgTimer <= ULLAGE_PRE_IGNITION_S` のカウント方向逆転
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L154
  - 実装: `scripts/gravsim_calc_object.js:1151–1162`, `scripts/gravsim_const.js:712`
- **現象**:
  - `CalcRocket.flightControl`（L1152–1155）において `this.stgTimer` は `0` から `ignDelay`（`nextStage?.ignitionDelaySec ?? MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC = 2.0`。なお設計書 L154 記載の `STAGE_SEP_COAST_S` は実在しない）へ向かって **加算（カウントアップ）** される。
  - したがって設計書 L154 の条件 `stgTimer <= RCS_CONFIG.ULLAGE_PRE_IGNITION_S`（`stgTimer <= 1.5`）を実装すると、分離直後 `0.0s .. 1.5s` にウルジが点灯し、次段点火直前の末尾 `1.5s .. 2.0s` に消灯してしまう（仕様意図と真逆）。
- **修正方針**:
  - 条件Aを **`const ignDelay = nextStage?.ignitionDelaySec ?? MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC;`** に対し **`(ignDelay - this.stgTimer) <= RCS_CONFIG.ULLAGE_PRE_IGNITION_S`**（すなわち `this.stgTimer >= Math.max(0, ignDelay - RCS_CONFIG.ULLAGE_PRE_IGNITION_S)`）へ修正し、`flightControl` 内でステージング状態遷移（`STG_COAST -> STG_BURNING` 含む L1128–1163）の **後** に `_updateRcsState` を呼ぶ順序を明記する。

#### F2-05 [Critical] `SoundEffects` の存在しないメソッド `universe.getObjectById` 呼び出しによる実行時例外・型エラー
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L215
  - 実装: `scripts/gravsim_universe.js`, `scripts/gravsim_sound_effects.js:346`
- **現象**:
  - `Universe` クラスおよびテスト用モック `createMockUniverse()` に `getObjectById` メソッドは存在しない。設計書 L215 の `universe?.getObjectById(rocket.dominantBodyId)?.param` は `universe` が存在する通常実行時に `TypeError: universe.getObjectById is not a function` を引き起こし、`tsc --noEmit` でもエラーとなる。
- **修正方針**:
  - 設計書 L215 を既存コード流儀どおり **`this.universe?.objects?.find(o => o.id === rocket.dominantBodyId)?.param`** へ修正する。

#### F2-06 [Major] 長期予測サンプラー: `NearBody 15.0s` と `budgetScale <= 5` による 3000 点枯渇の再発および最終点単位不一致
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L96, L101–110
  - 実装: `scripts/gravsim_calc_predictor.js:316, 547–600`, `scripts/gravsim_const.js:341`
- **現象**:
  1. `TRAJECTORY_PREDICTION.SAMPLING.NEAR_BODY_DIST_M = 10,000,000` m（10,000 km）であるため、LEO (`250 km`)・ISS (`400 km`)・GTO 近地点付近などの周回軌道予測では期間中つねに `minSurfaceDist < NEAR_BODY_DIST_M` となる。設計書 L104 の固定 `NearBody 15.0s` をそのまま採用すると **`45,000s`（12.5時間）で 3000 点上限に到達して予測が強制終了**し、既定 1 ヶ月（または 0.2〜36 ヶ月スライダ上限）予測の大部分が欠落する。さらに `ANGLE_DELTA_RAD = 0.02` / `HEADING_DELTA_RAD = 0.035` も `budgetScale <= 5`（1周約 63 点）では約 20 周（30時間）で 3000 点を使い切る。
  2. 設計書 L96・L110 の最終点重複除去 `変位二乗 >= MIN_SAMPLE_DISPLACEMENT_M_SQ (1e-4)` は、比較対象の座標単位が明記されていない。`points` 内の `pt.relX / pt.relY` は **ピクセル単位**（`1 m ≈ 1.2e-9 px`）であるため、ピクセル差分の二乗を `1e-4 m²` と比較すると最終衝突点まで捨てられてしまう。
- **修正方針**:
  - `NearBody` 間隔および角度/方位角/遠近点サンプリングに対し、残余シミュレーション時間と残余点予算に基づく下限間隔 `minBudgetDt = (maxSimTime - simTime) / Math.max(1, maxPoints - points.length)`（または周回時間に応じた動的角度閾値拡張。`1200s` 短期予測時は十分小さく `> 500` 点を保証）を組み込み、任意の周回/深宇宙軌道・任意予測期間（0.2〜36ヶ月）で 3000 点内に完走する式を明記する。また L110 の変位二乗比較は **メートル座標 (`curRelX_m - lastSampleRelX_m`, `curRelY_m - lastSampleRelY_m`)** で実施する旨を明記する。

#### F2-07 [Major] 深宇宙上段サイジング (`calculateMissionFlightPlan`) の境界・TWR・ブースター推力不整合
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L297–302
  - 実装・プリセット・テスト: `scripts/gravsim_preset_manager.js:592–712`, `scripts/gravsim_calc_object.js:1233, 1241`, `presets/missions/lunar_insertion.json:8`, `presets/vehicles/h3_22.json`, `presets/vehicles/h3_24.json`, `presets/vehicles/falcon9.json`, `testsuites/integration/06_external_presets_and_payload_propulsion.test.mjs:174`
- **現象**:
  1. L298 の条件 `mission.targetDeltaVM_S >= 12000` により、`disableOrbitalCutoff: false` の非脱出ミッション `lunar_insertion`（`targetDeltaVM_S: 12300`）まで増槽対象に入り、`reqDv = 13100` へ強制拡張される。
  2. `falcon9`（上段 `isp = 320s`）で `jupiter_transfer`（必要上段推進剤 `1,101 t`）／`solar_escape`（`3,096 t`）を計算すると総質量 `1,556 t` / `3,551 t` に対し第1段推力上限 `10,000 kN` での初期 **TWR が `0.65` / `0.29`（離床不能）** となる。`stage1TWR >= 1.25` と第1段推力上限から逆算される最大許容上段推進剤キャップの数式が設計書に欠落している。
  3. `h3_24` の第1段初期推力は既に **`11,500 kN`**（`06` テスト L174 検証済）であり、L302 の「上限 `10000 kN` 内で」をそのまま適用すると既存定格を下回る恐れがある（`Math.max(stg0.thrustKN, Math.min(10000, ...))` が必要）。さらに `h3_22` 等 SRB 付機体で第1段推力を増強しても、`boosters.coreThrustKN`（`CalcRocket` L1241 でブースター燃焼終了後に `this.thrustForce` へ再設定）が更新されない仕様漏れがある。
- **修正方針**:
  - 対象条件を `mission.disableOrbitalCutoff === true || mission.targetVInfKmS > 0` に限定し、第1段最大許容質量 `maxStage1SupportedMassT = maxStage1ThrustKN / (G0 * 1.25)`（`maxStage1ThrustKN = Math.max(origStage1ThrustKN, 10000)`）による上段推進剤キャップ式、および SRB 付機体での `boosters.coreThrustKN` 比例更新ルールを明記する。

#### F2-08 [Minor] その他の実装齟齬・ガード漏れ（一括是正要）
- **`PhysicsEngine.updateObject(data)` (`scripts/gravsim_calc.js:116–128`)**: 設計書 L63 で `ObjectManager.updateObject` から `rotationAngle` を送信する計画だが、受信側 `PhysicsEngine.updateObject` での `rotationAngle` 更新が設計書から漏れている。
- **`CalcRocket.separatePayload()` の無限ループ防止 (`docs/design/2026-11-20_trajectory_fx_flightplan.md` L255 / `scripts/gravsim_calc_object.js:432`)**: `separateCurrentStage()` は `if (this.disableStaging) return;` で早期終了するため、`separatePayload()` の `while (!this.isPayloadSeparated && this.currentStageIndex < this.totalStages)` は関数先頭で `if (this.disableStaging) return;` をチェックしないと無限ループになる。
- **`ObjectManager._buildRocketPayload` & `CalcRocket` の `loadState()` 復元**: 飛行中（Stage 2 以降／ペイロード分離後）の `Rocket` を `loadState()` で再登録すると、`CalcRocket` コンストラクタが `_activateStage(0)` を無条件実行して Stage 0 へ巻き戻すため、`ObjectManager._buildRocketPayload` → `PhysicsEngine.addObject` → `CalcRocket` でのランタイム段階復元契約を明記する必要がある。
- **`ObjectManager._applyRocketState` (`scripts/gravsim_object_manager.js:300`)**: 既存テスト `03_celestial_world.test.mjs:1113–1124` 等のモック入力は `isStage2Separated` を渡さないため、`objData.isStage2Separated !== undefined ? Boolean(objData.isStage2Separated) : (curStg >= 2 || isPayloadSep)` とする。
- **`PresetManager._seedFallbacks()` (`scripts/gravsim_preset_manager.js:324–409`)**: `presets/visuals/rocket.json` に追加する `COLD_GAS_RCS` と `VAPOR_CONE` をオフラインフォールバック `fallbackVisual` にも同値追加する。
- **`FlightComputer` フィールド表記ゆれ**: 設計書 L240 の `sensor.vV` / `sensor.altM` は実コードでは `this.telemetryCache.vV` / `this.telemetryCache.altM`。また `'vel'` イベント判定（`gravsim_flight_computer.js:254` は地表自転差引済の対気/対地表速度、`gravsim_calc_predictor.js:356` は天体中心慣性速度）の基準一致（`calc_predictor.js` 側で `rocket.flightComputer.telemetryCache` を参照するか定義統一）を明記する。

---

### 2. 横展開確認（Horizontal Check）

Rev 2 修正内容および今回検出箇所についてコードベース全体を横断確認した：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| フライトプロファイル角度定義 (`0°` 天頂〜`90°` 水平) | `gravsim_flight_computer.js:162`, `gravsim_rocket_launcher.js:365, 909–910`, `presets/missions/*.json` すべて `0°`=天頂、`90°`=水平。設計書 L305–311 だけが逆転。 | **要修正（全7ミッション表の角度を `0°→90°` へ訂正＋`iss_rendezvous` `>= 8` 行維持）** |
| `updateHistory` 呼び出しシグネチャ | `gravsim_object.js:54, 353`, `gravsim_object_manager.js:153`, `testsuites/unit/03_celestial_world.test.mjs:564, 1008` すべて `(currentFrame, objects, isPaused)`。設計書 L45・L83 のみ `(universe, dt, isPaused)` と誤記。 | **要修正（設計書 L45・L83 を `(this.physicsSequence, this.objects, isPaused)` へ訂正）** |
| `stgTimer` カウント方向 (`STG_MECO` / `INTERSTAGE_COAST`) | `gravsim_calc_object.js:1146, 1152` は双方 `0` からの加算（経過時間）。`STG_MECO` は `>= sepDelay`、`INTERSTAGE_COAST` は `>= ignDelay` で遷移。 | **要修正（設計書 L154 を `ignDelay - stgTimer <= ULLAGE_PRE_IGNITION_S` へ訂正）** |
| `disableStaging` ガード | `separateCurrentStage` (L432), `separateFairing` (L575), `separateBoosters` (L627), `flightControl` (L1013, L1019, L1138) すべてに配置済。新設 `separatePayload` / `executeProfileAction` にも必須。 | **要適用（先頭ガードで無限ループ防止）** |
| `Universe` オブジェクト検索 (`objects.find` vs `getObjectById`) | `gravsim_rocket_launcher.js:90`, `gravsim_telemetry_panel.js:405`, `gravsim_sound_effects.js:401` すべて `universe.objects.find(...)`。`getObjectById` は全コードベース不在。 | **要修正（設計書 L215 を `this.universe?.objects?.find(...)` へ訂正）** |
| `PhysicsEngine.updateObject` vs `ObjectManager.updateObject` | `ObjectManager.addObject` / `updateObject` 双方から `rotationAngle` 送信するため、対となる `PhysicsEngine.addObject` と `PhysicsEngine.updateObject` 両方に反映が必要。 | **要水平適用（`PhysicsEngine.updateObject` にも `rotationAngle` 反映追加）** |
| ホールドダウン拘束と天体自転のサブステップ同期 | `gravsim_calc.js:898–899` は `_updateHoldDownPositions(dt)` の後に `_moveObjects(dt)` を実行し、`isHoldDown` ロケットも `_updatePositionAndHalfVelocity` で1サブステップ分移動する。`|omega * dt|` 分の微小位相差が出ないよう、ロケット側 `isHoldDown` の積分スキップまたは `_moveObjects` 内自転統合直後の位置再拘束を検討推奨。 | **次版設計での整理推奨** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **設計書修正後の物理シミュレーション事前検証（Gate 1 Iteration 3 への必須条件）**:
   - `ORBIT_ASSIST` と 7ミッションプロファイル（`0°→90°` 正符号・`>= 8` 行の `iss_rendezvous` 含む）は、設計書改訂時点で実 `PhysicsEngine` 計算上 **既存テスト `07_preset_orbit_insertion.test.mjs` 全項目（6機体 LEO、`ISS 380–550 km`、`GTO >= 35000 km`、`TLI >= 350000 km`、`Mars E > 0, ecc > 1.0, < 1200s`）および `03_celestial_world.test.mjs:1169` が通る数式・具体値を確定** させること。
2. **予測サンプラーの周回軌道・長期境界**:
   - `leo_250km` / `iss_rendezvous` / `gto_insertion` において `predictionDurationMonths = 0.2 .. 36.0` の全範囲で 3000 点打ち切りが発生しないこと、かつ `testsuites/regressions/07_trajectory_predictor.test.mjs:69`（`maxSimTime = 1200s` で `points.length > 500`）を引き続き満たす数式にすること。
3. **`Payload` 単体時の RCS ノズル位置**:
   - `_drawPayloadSatellite`（`gravsim_rocket_renderer.js:375–383`）では衛星バス幅 `1.40 * payloadR`（X 半径 `0.70 * payloadR`）・バス高 `1.70 * payloadR`（Y 半径 **`0.85 * payloadR`**）であるため、`halfWidth` に `0.85 * payloadR` を採用するとノズルが衛星バス外壁に正確に接する（`0.70 * payloadR` のままだと壁内側に食い込む）。


---

## 独立監査1: 設計監査 — Iteration 3

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 3
- **実施日時**: 2026-11-20 15:46 JST
- **判定**: **FAIL**

Rev 3 設計書（[docs/design/2026-11-20_trajectory_fx_flightplan.md](../design/2026-11-20_trajectory_fx_flightplan.md)）を `docs/development_process.md`、Iteration 1・2 の全指摘事項（特に F2-01〜F2-08）、および実コードベース・プリセット・テスト群（実 `PhysicsEngine` および予測サンプラーによる数値シミュレーション検証を含む）とゼロベースで照合した。

**Iteration 2 指摘（F2-01〜F2-08）の反映状況**:
- **解消確認**:
  - **F2-01**: 全7ミッションが現行規約（`0°`=天頂・`90°`=水平）へ統一され、`iss_rendezvous` は 8 行（`03_celestial_world.test.mjs:1169` の `>= 8` を充足）、`lunar_insertion` は `targetPerigeeKm: 250` を維持。
  - **F2-03**: `ObjectManager.updateObjectParams` Pass 2A が `target.updateHistory(this.physicsSequence, this.objects, isPaused)` へ訂正され、`_cache` 参照保存回避および Pass 2B 後段分離も整合。
  - **F2-04**: ステージ間ウルジ条件が `(ignDelay - this.stgTimer) <= RCS_CONFIG.ULLAGE_PRE_IGNITION_S` へ訂正され、`_updateRcsState` 呼び出し位置もステージング状態遷移（`L1128–1163`）の後へ配置。
  - **F2-05**: `SoundEffects` が実在API `this.universe?.objects?.find(o => o.id === rocket.dominantBodyId)?.param ?? null` へ訂正。
  - **F2-06**: 予測サンプラーの `hardBudgetFloorDt`（点使用率 `> 0.55` で発動）を実 `PredictorPhysicsEngine` で検証し、`maxSimTime = 1200s` で **696 点 (`> 500`)**、0.2 / 1.0 / 36 ヶ月の LEO・深宇宙軌道で **999〜2,063 点 (`< 3000`)・100% 完走** を確認。ループ外L590 でのメートル単位重複判定一元化も整合。
  - **F2-08（一部残存あり）**: `PhysicsEngine.updateObject` の `rotationAngle` 更新、`separatePayload` / `executeProfileAction` 先頭 `if (this.disableStaging) return;` ガード、`_applyRocketState` の `isStage2Separated` フォールバック、`PresetManager._seedFallbacks()`、`FlightComputer` 実在フィールド名（`telemetryCache.vV/altM/vH`）、`_drawPayloadSatellite` `0.85 * payloadR` 外壁整合、および `_moveObjects(dt)` 内への `_updateHoldDownPositions` 統合と既存テスト（`01_core_physics.test.mjs:491`, `01_physics_worker_bridge.test.mjs:97`）との非干渉を確認。
- **未解消／新規設計不備（FAIL 要因）**:
  - **F3-01 (F2-02 未解消)**: Rev 3 L208–211 記載の `ORBIT_ASSIST` 介入条件・誘導式をそのまま実 `PhysicsEngine` 上の `iss_rendezvous`（`h3_22`＋`htv_x`）へ適用すると、`apKm` が **596.1 km**（`payloadDeltaVM_S` 無適用時 680.3 km）まで上昇し、**既存統合テスト `07_preset_orbit_insertion.test.mjs:382`（`apKm <= 550`）に失敗**する。また `FlightComputer` への `targetApogeeKm`/`targetPerigeeKm`・`apKm`/`peKm` 受け渡し／計算仕様が依然未記載。
  - **F3-02 (F2-07 未解消)**: Rev 3 の深宇宙増槽＋ピッチプロファイルを実 `PhysicsEngine` で検証すると、**`h3_24`（`jupiter_transfer` / `solar_escape`）、`h3_22`（`jupiter_transfer` / `solar_escape`）、`falcon9`（`solar_escape`）の5ケースで地上墜落（`CRASH`, `altKm = -0.2..-0.4`）** が発生する。
  - **F3-03**: `CalcRocket._updateRcsState` 仕様（L134, L145）が実在しないプロパティ **`isCrashed`** を参照している。
  - **F3-04 (F2-08 残課題)**: `ObjectManager.getState`/`loadState` 仕様（L231）が列挙する `stageState`・`stgTimer`・`hasPayloadPropulsion`・`tmFairingSeparated` について、Worker → メインスレッド同期経路および `CalcRocket` コンストラクタ `_activateStage(0)` 抑止契約が未定義。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### F3-01 [Critical] F2-02 未解消: `ORBIT_ASSIST` が `iss_rendezvous` を `apKm = 596.1 km (> 550 km)` へ悪化させテスト `07` を破壊し、`FlightComputer` への軌道要素入力仕様も欠落している
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L208–211
  - 実装・テスト: `scripts/gravsim_flight_computer.js:8–56, 364–469` / `scripts/gravsim_calc_object.js:310–335, 972–1002` / `testsuites/integration/07_preset_orbit_insertion.test.mjs:309–383`
- **現象**:
  1. 実 `PhysicsEngine._moveObjects(1.0)` 上で Rev 3 L208–210 記載の条件 `isCircularTarget && altM >= 150000 && apKm >= targetApogeeKm * 0.96 && peKm < targetPerigeeKm * 0.80 && vV > 50` および $\gamma_{\text{cmd}} = \text{clamp}(-v_V / \max(400, |\vec{v}_H|), -0.12, 0)$ を `h3_22`＋`htv_x`＋`iss_rendezvous`（`07_preset_orbit_insertion.test.mjs:309–383` 対象）に適用すると、`t = 280 s`（`alt = 279 km, vV = +1093 m/s`）から `-0.12 rad` の下向きピッチが継続して `t = 510 s`・`alt = 394 km` で `vV <= 50` に達し介入が停止する（この時点で `peKm = -3083 km` と軌道速度に大きく不足）。その後は `vV > 50` 条件外れによりプロファイル終端 `90°`（ローカル水平）に戻るため、地球重力で `vV = -296 m/s` まで沈みながら加速し、`ecc <= 0.04` 到達時の最終遠地点が **`apKm = 596.1 km`**（`payloadDeltaVM_S` 無適用設定時は `680.3 km`）となり、**`07_preset_orbit_insertion.test.mjs:382` の `apKm >= 380 && apKm <= 550` 要件を不合格とする**（なお `ORBIT_ASSIST` 無しの現行実装では `pe = 179.6 km, ap = 480.9 km, ecc = 0.022` で合格する）。
  2. Rev 3 L208 は `FlightComputer._computeThrustAngle` 内で `isCircularTarget`, `apKm`, `peKm`, `targetApogeeKm`, `targetPerigeeKm` を参照する仕様としているが、`CalcRocket` の `new FlightComputer({...})`（`gravsim_calc_object.js:310–318`）および `_sensorData`（`L330–335, 972–1002`）にはこれらを渡す定義がなく、`FlightComputer` 内部で `apKm`/`peKm` を算出する場合の速度基準（慣性対天体速度 `(sensor.vx - refBody.vx, sensor.vy - refBody.vy)` と地表相対速度 `telemetryCache.vV` の区別）も設計書に明記されていない。
- **修正方針**:
  - `iss_rendezvous`（`h3_22`＋`htv_x` および他5機体）に対して実 `PhysicsEngine` 上で `380 <= apKm <= 550`, `ecc < 0.05`, `peKm >= 140`, `< 850s` を確実に達成できるよう、`ORBIT_ASSIST` の介入条件・制御則（例：目標アポジー近傍で `vV <= 0` の落下側も水平以上へ抑える双方向制御 `gammaCmd` または適切な介入閾値・プロファイル整合）を見直して数値検証すること。あわせて `CalcRocket` → `FlightComputer` への `targetApogeeKm` / `targetPerigeeKm` 伝達経路（コンストラクタ／`_sensorData`）と `apKm` / `peKm` / $\vec{v}_{\text{rel}}$ の慣性基準を明記する。

#### F3-02 [Critical] F2-07 未解消: `jupiter_transfer` / `solar_escape` で `h3_24`・`h3_22`・`falcon9` が地上墜落する
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L205–206, L213–220
  - 実装・プリセット: `scripts/gravsim_preset_manager.js:592–736` / `scripts/gravsim_calc_object.js:1226–1263` / `presets/vehicles/h3_22.json` / `presets/vehicles/h3_24.json` / `presets/vehicles/falcon9.json`
- **現象**:
  - Rev 3 L205–206 および L213–220 の数式を実 `PhysicsEngine._moveObjects(1.0)` 上で検証した結果、**`h3_24`（`jupiter_transfer`: step 464, `altKm = -0.2` / `solar_escape`: step 279, `altKm = -0.2`）、`h3_22`（`jupiter_transfer`: step 400, `altKm = -0.4` / `solar_escape`: step 204, `altKm = -0.3`）、`falcon9`（`solar_escape`: step 362, `altKm = -0.2`）の5組み合わせが地上墜落**することを確認した。根本原因は以下の複合である：
    1. **SRB 燃焼終了後のコア TWR（`boosters.coreThrustKN`）欠落**: `h3_24`（総推力 `11500 kN` だが `t = 105 s` に SRB `8560 kN` が燃え尽きコア `2940 kN` のみになる）および `h3_22`（`7250 kN` → `2940 kN`）について、Rev 3 L218・L220 は離床総推力 `stages[0].thrustKN` のみで `TWR >= 1.25` を判定するため、`newStg0Thrust <= 11500` の場合に `coreThrustKN = 2940 kN` が一切増強されない。上段増槽（`143.7 t`〜`370.6 t`）により `t = 105 s` 以降の残存質量が `432 t`〜`660 t` に増加し、**SRB 分離後 TWR が `0.69`〜`0.45`（< 1.0）へ急落して失速・墜落**する。
    2. **`_adaptFlightProfileForVehicle` L719 の `altScale` 反転**: 上段推力を `420 s` 上限対応で引き上げると（例: `h3_24` で `160 kN → 1510..3894 kN`）、`stages[1].thrustKN / upperMass` が `6.0` を超え `isLowUpperTwr` が `false` へ反転し、`altScale` が `1.08` から **`0.85`** へ縮小する。
    3. **低高度急ピッチダウンとの競合**: 元から低高度寄りの `jupiter_transfer` / `solar_escape` プロファイル（`12 km -> 32°`, `32 km -> 55°` 等）に `0.85` が掛かる（`10.2 km -> 32°`, `27.2 km -> 55°`）結果、TWR `1.25` の `falcon9` や SRB 燃焼後低 TWR 機体が大気圏内で横向きとなり高度維持不能になる。
    4. なお補足として、`h3_30` × `mars_transfer` は初期構成の計算 Δv `14410 >= reqDv (14376)` のため増槽されず、2段 `618 s` の重力損失で `vInf = 2.53 km/s < 3.3 km/s` に留まる点、また `last.thrustKN` の `Math.round` 丸めで `last.burnTime` が `420.1 s` となる場合がある点も併せて整理を要する。
- **修正方針**:
  - SRB 付機体では離床 TWR に加えて **SRB 燃焼終了時点（`boosters.burnTimeSec` 消費後）の残存質量に対する `coreThrustKN` ベース TWR（例: `>= 1.05`）** を上段増槽上限および `coreThrustKN` / `stages[0].thrustKN` スケーリングへ組み込むこと。また深宇宙プロファイルのピッチ高度または `_adaptFlightProfileForVehicle`（高質量・SRB・深宇宙時の `altScale` 縮小抑止）を実 `PhysicsEngine` シミュレーションで検証して全機体非墜落・脱出成立を確定し、`last.thrustKN` 切り上げで `burnTime <= 420.0s` を厳密保証する。

#### F3-03 [Major] `CalcRocket._updateRcsState` が実在しないプロパティ `isCrashed` を参照している
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L134, L145
  - 実装: `scripts/gravsim_calc_object.js:31–35`
- **現象**:
  - Rev 3 L134 および L145 は RCS / Ullage の停止ガード条件を `isHoldDown || isCrashed` / `!isHoldDown && !isCrashed` と記述しているが、`GravSimCalcObject`（L31–35）および `CalcRocket` に `isCrashed` プロパティは存在しない（実在するのは `this.collided` および `this.shattered`）。このまま実装すると未定義変数として `ReferenceError` または `this.isCrashed === undefined` によるガード無効化を起こす。
- **修正方針**:
  - `isCrashed` の記述を実在フィールド **`(this.collided || this.shattered)`**（すなわち `this.isHoldDown || this.collided || this.shattered`）へ修正する。

#### F3-04 [Minor] `ObjectManager.getState` / `loadState` の `stageState`・`stgTimer`・`hasPayloadPropulsion`・`fairing.isSeparated` の Worker 同期経路と `CalcRocket` 復元契約の不足（F2-08 残課題）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L231
  - 実装: `scripts/gravsim_const.js:467–480` / `scripts/gravsim_worker_bridge.js:49–138, 190–217` / `scripts/gravsim_object_manager.js:76–103, 261–357, 386–453` / `scripts/gravsim_calc_object.js:228–336`
- **現象**:
  1. Rev 3 L231 は飛行中 `Rocket` の `getState`/`loadState` 復元対象として `stageState`, `stgTimer`, `hasPayloadPropulsion`, `tmFairingSeparated`, 設計パラメータ群を列挙しているが、現在 `WorkerBridge`（`BUFFER_INDEX` 0–48）は `stageState`・`stgTimer`・`hasPayloadPropulsion` を Worker からメインスレッドへ転送しておらず、`ObjectManager._applyRocketState`（L261–357）も `target.fairing.isSeparated`・`target.stageState`・`target.stgTimer`・`target.hasPayloadPropulsion` を更新しない。したがってメインスレッドの `ObjectManager.getState()` 実行時にはこれらが `undefined` のままになる。
  2. `CalcRocket` コンストラクタ（`gravsim_calc_object.js:265–306`）は無条件で `this._activateStage(0)`（Stage 0 のフル燃料・推力で上書き）と `this.stageState = this.isHoldDown ? 'PRE_LAUNCH' : 'STG_BURNING'` を実行するため、`loadState` → `ObjectManager.addObject` → `PhysicsEngine.addObject` 経由で飛行中ロケットを復元した際に `_activateStage(0)` による状態巻き戻しを抑止して実段・残燃料・分離状態・ペイロード推進を再構築する契約を明記する必要がある。
- **修正方針**:
  - `WorkerBridge` / `_applyRocketState` で `stageState`（コード化転送または決定論的導出）・`stgTimer`・`hasPayloadPropulsion`・`fairing.isSeparated` を同期するか、状態復元時の導出規約を明記し、あわせて `ObjectManager._buildRocketPayload` / `getState` / `loadState` と `CalcRocket` コンストラクタでの全設計フィールド（`stages`, `payload`, `fairing`, `boosters`, `colorTheme`, `autoControl`, `disableStaging`, `disableOrbitalCutoff`, `targetApogeeKm`, `targetPerigeeKm`, `targetVInfKmS`, `hostId`, `isHoldDown`, `isIgnited`）＋ランタイム段状態復元手順（`_activateStage(0)` 抑止）を確定させること。

---

### 2. 横展開確認（Horizontal Check）

Rev 3 全体および今回検出事項のコードベース横断確認を実施した：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 衝突／破砕状態フラグ参照 (`isCrashed` vs `collided \|\| shattered`) | `gravsim_calc.js`, `gravsim_calc_predictor.js`, `gravsim_sound_effects.js`, `gravsim_worker_bridge.js` 全箇所が `collided` / `shattered` を使用。`isCrashed` は設計書 L134, L145 のみに存在する誤記。 | **要修正（設計書 L134, L145 を `this.collided \|\| this.shattered` へ統一）** |
| `_updateHoldDownPositions` のテスト直接呼び出し互換 | `testsuites/unit/01_core_physics.test.mjs:491`（単体呼び出し、`_moveObjects` なし）および `testsuites/integration/01_physics_worker_bridge.test.mjs:97–98`（`isHoldDown: false` での連続呼び出し）は、`PhysicsEngine._updateHoldDownPositions` メソッドが残置され `_moveObjects(dt)` 内で `isHoldDown` 時のみ作用するため両方非破壊。 | **現状設計で互換維持（ただし `_updateFinalVelocity` 後の `isHoldDown` 速度再同期有無は Watchpoint 化）** |
| `TrajectoryPredictor.render` 重複メソッド削除 (`L893–895`) | `scripts/gravsim_trajectory_predictor.js` 内に `L318–326` と `L893–895` の2定義が存在。`L893–895` 削除により `L318–326`（`if (!this.prediction) return;` と表示フラグ既定値付）が有効化され、`RocketLauncher.drawPreview` (`L541, 549`) および `02_rocket_guidance.test.mjs:1003, 1076` と完全互換。 | **削除妥当（問題なし）** |
| `RocketTab` 6列化と既存 UI テスト参照 | `05_ui_telemetry_audio.test.mjs:1066–1077`（`querySelectorAll('input, select')` の `[0..3]`）は非破壊、L1642（`row0.children[4].children[0]`）のみ `children[5]` へ更新要（設計書 L224 で対処済）。 | **設計書記載通りで整合** |
| `boosters.coreThrustKN` 参照箇所 | `scripts/gravsim_calc_object.js:302, 1241, 1252` と `scripts/gravsim_preset_manager.js:686` の全箇所が `boosters.coreThrustKN` を参照。`h3_22` / `h3_24` 両方に存在し、深宇宙増槽でのコア TWR チェックとスケーリング対象の両方に含める必要あり。 | **要横展開（`h3_22`, `h3_24` 両方の SRB 燃焼後コア TWR 保証を適用）** |
| `FlightComputer._evaluateProfile` トリガ種別分岐 | `type === 'vel'` 追加時、トリガ判定（L73–79）だけでなく補間用 `currentVal` 算出（L114–121）にも `'vel'` 分岐が必要。 | **実装時漏れ防止のため設計書・Watchpoint へ明記推奨** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **Iteration 4（再監査）への必須検証項目**:
   - 修正版 `ORBIT_ASSIST` と修正版深宇宙サイジング（SRB コア推力 TWR 保護＋`_adaptFlightProfileForVehicle`／プロファイル整合）について、改訂設計書（Rev 4）時点で実 `PhysicsEngine._moveObjects(1.0)` による **全6機体 × LEO、`iss_rendezvous` (`380 <= apKm <= 550`, `ecc < 0.05`)、GTO、Lunar TLI、および `h3_24` / `h3_22` / `h3_30` / `falcon9` × `mars_transfer` / `jupiter_transfer` / `solar_escape` の非墜落・目標到達** を必ず再確認すること。
2. **微細な実装時境界条件**:
   - `PresetManager.calculateMissionFlightPlan`: 深宇宙増槽の上段推力算出時、`last.thrustKN` を `Math.ceil` で切り上げることで `last.burnTime <= 420.0 s` を厳密に満たせる（`Math.round` の丸め誤差による `420.1 s` 超過を防止）。また `maxByTank` 算出は `#rl-fuel-mass` (`max=1500`) と `#rl-oxid-mass` (`max=3000`) 双方の上限（`ofRatio > 0 ? Math.min(1500 * (1 + ofRatio), 3000 * (1 + 1 / ofRatio)) : 1500`）を考慮すること。
   - `PhysicsEngine._moveObjects(dt)`: `_updatePositionAndHalfVelocity(dt)` 直後に `_updateHoldDownPositions(dt)` を実行する場合、ループ終端の `_updateFinalVelocity(dt)` 後に `host.vx, host.vy` が `t + dt` へ進むため、最終ステップの `isHoldDown` ロケットの `vx/vy` も `host.vx - omega * dy`, `host.vy + omega * dx` へ再同期すると完全一致する。
   - `SoundEffects`: `const telemetry = rocket.telemetry;` に対して `Number.isFinite(telemetry?.mach)` のオプショナルチェーンを用いることで `telemetry` 欠落モックに対しても安全となる。
   - `gravsim_calc_predictor.js` 状態差分イベント検出: `separatePayload()` が複数段を同一ステップでスキップする場合に備え、`for (let s = prevStageIndex + 1; s <= Math.min(rocket.currentStageIndex, rocket.totalStages); s++)` のように全通過段の `stg_sep_${s}` を記録すること。


---

## 独立監査1: 設計監査 — Iteration 4

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 4
- **実施日時**: 2026-11-20 15:57 JST
- **判定**: **FAIL**

Rev 4 設計書（[docs/design/2026-11-20_trajectory_fx_flightplan.md](../design/2026-11-20_trajectory_fx_flightplan.md)）を `docs/development_process.md`、Iteration 1〜3 の指摘事項（特に F3-01〜F3-04 および Watchpoints）、および実コードベース・プリセット JSON・既存テスト群（実 `PhysicsEngine._moveObjects(1.0)` による物理検証含む）とゼロベースで照合した。なお、実ソース・プリセット・テストファイルの改変は 0 件（未追跡の `docs/` 配下のみ）であることを `git status -u` / `git diff --stat` で確認済み。

**Iteration 3 指摘（F3-01〜F3-04）の検証結果**:
- **F3-02（解消確認）**: 深宇宙サイジング（`disableOrbitalCutoff || targetVInfKmS > 0`、`reqDv` 式、`hardCap = min(maxByTank, maxByTwr)`、離床 TWR `>= 1.25` かつ SRB 分離後コア TWR `>= 1.15` 連動 `boosters.coreThrustKN` / `stages[0].thrustKN` 強化、`Math.ceil` による `last.thrustKN` 切り上げ `<= 420.0s`、`_adaptFlightProfileForVehicle` の `altScale >= 1.0` 維持）を実 `PhysicsEngine._moveObjects(1.0)` で検証し、**`h3_24`・`h3_22`・`h3_30`・`falcon9` × `mars_transfer` / `jupiter_transfer` / `solar_escape` 全12構成（`earth_obs`・`htv_x` および `mmx` 搭載時を含む）で地上墜落 0 件・双曲線脱出（`E > 0`, `ecc > 1.0`, `stg1BT <= 420.0s`, `earth_obs` `663–793s` / `htv_x` `874–991s`）** を確認した（※既存テスト `08_tab_navigation_lifecycle.test.mjs:1356` 向けのヌルガードのみ F4-02 に記載）。
- **F3-03（解消確認）**: 設計書 L16, L98 より `isCrashed` 参照が完全除去され、`this.collided || this.shattered` へ統一されたこと、および `scripts/`・`testsuites/`・`presets/` 全体に `isCrashed` が存在しないことを確認した。
- **F3-04（設計骨子は解消、既存単体テスト向けガード不足あり）**: `CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT = 51`（`ROTATION_ANGLE: 47`, `TM_MACH: 48`, `STAGE_STATE_CODE: 49`, `STG_TIMER: 50`, `ROCKET_FLAG.HAS_PAYLOAD_PROP: 1 << 19`）と `WorkerBridge` 全種別 0 クリア・`getState`/`loadState`・`CalcRocket` `restoredRuntimeState`（`_activateStage(0)` 抑止）は `01_core_physics.test.mjs:134–308` および `05_payload_and_events.test.mjs:77–133` と整合している。ただし `03_celestial_world.test.mjs:1079, 1113–1124, 1250–1257`（`rocket.fairing === null` かつ `stageState` 欠落モック）に対する明示ガードが不足しているため F4-02 として指摘する。
- **F3-01（未解消・Critical FAIL 要因）**: Rev 4 L135–140 の双方向 `ORBIT_ASSIST` 制御則を実 `PhysicsEngine._moveObjects(1.0)` 上でそのまま検証した結果、**`h3_22 + htv_x`（`07_preset_orbit_insertion.test.mjs:309–383` 対象）が `850s` 以内にカットオフせず `apKm = 6038.1 km, ecc = 0.3015` で完全失敗**し、さらに **`h3_22 + earth_obs` (`593.3 km`)・`h3_24 + htv_x` (`593.8 km`)・`h3_30 + htv_x` (`551.5 km`) も上限 `550 km` を超過**する（F4-01）。よって Gate 1 を差し戻す。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### F4-01 [Critical] F3-01 未解消: Rev 4 の `ORBIT_ASSIST` 制御則が実物理エンジン上で `iss_rendezvous` を 5 構成中 4 構成で失敗させる
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L18, L133–141
  - 実装・テスト: `scripts/gravsim_flight_computer.js:364–469` / `scripts/gravsim_calc_object.js:972–1007, 1037–1086` / `testsuites/integration/07_preset_orbit_insertion.test.mjs:309–383`
- **現象**:
  - Rev 4 L136–140 記載の介入条件および制御則：
    - `isCircularTarget && altM >= 180000 && apKm >= targetApogeeKm * 0.93 && sensor.stageState === 'STG_BURNING'`
    - `vrTgt = clamp(((R_host + targetApogeeKm * 1000) - r) / 180, -25, +12)`
    - `gamma_cmd = clamp((vrTgt - vr) / max(600, |v_H|), -0.22, +0.14)`
    を実 `PhysicsEngine._moveObjects(1.0)`（`07_preset_orbit_insertion.test.mjs:353` と同一条件）へ適用して 5 構成を実測した結果は以下の通り（`leo_250km` 6/6、`gto_insertion` [`pe=534.1 km, ap=36495.1 km, ecc=0.7225`]、`lunar_insertion` [`pe=526.6 km, ap=427250.9 km, ecc=0.9687`] は全合格）：
    1. **`h3_22 + htv_x`（`07_preset_orbit_insertion.test.mjs:309–383` 直接対象）**: **FAIL**（`850s` 時点で `stageState = 'STG_BURNING'`, `isPayloadSeparated = false`, `peKm = 288.7`, **`apKm = 6038.1 km`**, `ecc = 0.3015`）。`t=280s`（`alt=279.1 km, vr=+997.8 m/s, pe=-4701 km`）で `ap=372.4 km >= 372.0` により第1段燃焼中に早期介入し、`vrTgt <= +12` クランプによって `-0.201 rad` 下向きピッチで上昇を止め、`t=500–720s` の低推力第2段（`150 kN`, 加速度 `~3.5 m/s²`）中に `vr = -311.9 m/s` まで沈降する。この際 `gamma_cmd` が `max(600, |v_H|) ≈ 7400` で除算されるため上向き角が `+0.043 rad`（約 `2.5°`、鉛直推力 `~0.15 m/s²`）に抑え込まれ（上限 `+0.14` に全く届かない）、`t=735s` の離心率極小点でも `ecc = 0.0402 > 0.04`（`pe=37.0 km < 140`, `ap=573.8 km`）となって `CalcRocket` L1061 のカットオフ条件を素通りし、`apKm` が `6038 km` まで発散する。
    2. **`h3_22 + earth_obs`**: `peKm = 157.6 km`, `ecc = 0.0323`, **`apKm = 593.3 km > 550 km`**（上限超過 FAIL）。
    3. **`h3_24 + htv_x`**: `peKm = 160.0 km`, `ecc = 0.0321`, **`apKm = 593.8 km > 550 km`**（上限超過 FAIL）。
    4. **`h3_30 + htv_x`**: `peKm = 160.9 km`, `ecc = 0.0290`, **`apKm = 551.5 km > 550 km`**（上限超過 FAIL）。
    5. **`falcon9 + htv_x`**: `peKm = 188.2 km`, `apKm = 460.0 km`, `ecc = 0.0203`, `490s`（PASS）。
    - なお、サブステップ `dt = 0.05s`・旋回レート制限なし・大気抵抗有効（`name = 'Rocket'`）いずれの条件で再検証しても `h3_22 + htv_x`（`apKm = 5542–6187 km`）・`h3_22 + earth_obs`（`591–641 km`）は同様に不合格となる。また `E >= 0` 到達時の `apKm` 負値化防止（`E < 0 ? ... : Infinity`）も L133–136 に明記が必要である。
- **修正方針**:
  - `ORBIT_ASSIST` の介入開始条件（例：早すぎる第1段高上昇率領域での介入抑制、または `apKm` 閾値および `peKm` 条件の適正化）と双方向ピッチ制御則（沈降 `vr < 0` 時に低 TWR 上段でも確実に沈降を止められる `gamma_cmd` ゲイン／分母設計、および `E >= 0 ? Infinity : ...` ガード）を見直し、設計書記載のそのままの数式を実 `PhysicsEngine._moveObjects(1.0)` 上で実行して **ISS 5 機体構成すべてが `380 <= apKm <= 550`, `ecc < 0.05`, `peKm >= 140`, `< 850s` を満たすこと** を実測確認した上で Rev 5 へ確定記載すること。

#### F4-02 [Minor] 既存テスト（`03_celestial_world.test.mjs` / `08_tab_navigation_lifecycle.test.mjs`）との非互換を招くガード漏れ
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L148, L164
  - 実装・テスト: `scripts/gravsim_object_manager.js:261–357` / `scripts/gravsim_object.js:294` / `scripts/gravsim_preset_manager.js:714–736` / `testsuites/unit/03_celestial_world.test.mjs:1079, 1113–1124, 1250–1257` / `testsuites/integration/08_tab_navigation_lifecycle.test.mjs:1356–1360`
- **現象**:
  1. **`_applyRocketState` の `target.fairing` ヌル参照クラッシュ**: `Rocket` コンストラクタ（`gravsim_object.js:294`）は `this.fairing = null;` で初期化するため、既存テスト `03_celestial_world.test.mjs:1079, 1113–1124` は `rocket.fairing === null` の状態で `objMgr._applyRocketState(rocket, { ..., tmFairingSeparated: true })` を呼び出す。Rev 4 L164 の `tmFairingSeparated → target.fairing.isSeparated` をガードなしで実装すると `TypeError: Cannot set properties of null` で既存テストがクラッシュする。
  2. **`_applyRocketState` の部分モック `undefined` 上書きリスク**: `03_celestial_world.test.mjs:1113` および `1250` の直接呼び出しモックは `stageState`, `stgTimer`, `hasPayloadPropulsion`, `mach` を渡さない。`objData.stageState !== undefined` 等の未定義ガードがないと有効状態が `undefined` で上書きされる。
  3. **`_adaptFlightProfileForVehicle` の `vehicle.stages` 未定義**: 既存テスト `08_tab_navigation_lifecycle.test.mjs:1356` は `pm._adaptFlightProfileForVehicle(rawProfile, {}, [...])` のように第2引数 `vehicle` に空オブジェクト `{}` を渡す。Rev 4 L148 の「`vehicle.stages[1]` 定格 TWR で判定」に `stages[1]` へのフォールバック（`const refUpper = vehicle?.stages?.[1] ?? stages?.[1];`）が明記されていないため、`vehicle.stages` 欠落時に `TypeError` または `lowTwrProf[0].value === 850` となりテスト失敗する。
- **修正方針**:
  - 設計書 L164 に `if (target.fairing) { target.fairing.isSeparated = Boolean(objData.tmFairingSeparated); }` および `stageState` / `stgTimer` / `hasPayloadPropulsion` の `!== undefined` ガードを明記し、L148 に `const refUpper = vehicle?.stages?.[1] ?? stages?.[1];` フォールバックを明記する。

---

### 2. 横展開確認（Horizontal Check）

Rev 4 修正内容および既存テスト互換についてコードベース全体を横断確認した：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 衝突／破砕状態フラグ (`collided \|\| shattered`) | `scripts/`・`testsuites/`・`presets/` に `isCrashed` は 0 件。Rev 4 も `this.isHoldDown \|\| this.collided \|\| this.shattered` へ完全統一。 | **解消確認済（問題なし）** |
| 深宇宙サイジング SRB コア TWR & `_adaptFlightProfileForVehicle` | `h3_22`, `h3_24`, `h3_30`, `falcon9` × 3 深宇宙ミッションで非墜落確認。ただし `08_tab_navigation_lifecycle.test.mjs:1356` が `vehicle = {}` で `_adaptFlightProfileForVehicle` を直接呼ぶ。 | **F4-02 で `vehicle?.stages?.[1] ?? stages?.[1]` フォールバック要明記** |
| `WorkerBridge` `OBJ_ATTR_COUNT = 51` と既存モック | `01_core_physics.test.mjs:134–308`・`05_payload_and_events.test.mjs:77–133` のロケットモックは `stageState` 等を持たないが、`STAGE_STATE_TO_CODE[obj.stageState] ?? 0` と `\|\| 0` により非破壊。 | **設計書通りで互換維持** |
| `_applyRocketState` の部分モック互換 | `03_celestial_world.test.mjs:1113, 1250` は `rocket.fairing === null` かつ `stageState`/`stgTimer`/`hasPayloadPropulsion`/`mach` 未設定のモックを渡す。 | **F4-02 で `if (target.fairing)` および `!== undefined` ガード要明記** |
| `CalcRocket` `restoredRuntimeState` と既存テスト | `new CalcRocket` / `engine.addObject` を呼ぶ全既存テスト（`05_payload_and_events`, `04_multistage_debris`, `02_fuel_and_deltav`, `01_tank_pressure` 等）は生成後に `currentStageIndex`/`stageState` を変更しており生成時上書きは起きない。 | **現行契約で互換維持** |
| `ORBIT_ASSIST` 対象の誤爆有無（GTO / Lunar / LEO） | `isCircularTarget = (targetApogeeKm > 0 && targetPerigeeKm > 0 && targetApogeeKm / targetPerigeeKm <= 1.5)` により、`leo_250km` (`0`)・`gto_insertion` (`143.1`)・`lunar_insertion` (`1537.6`)・深宇宙 (`0`) は完全に非対象。 | **対象分離は正常（ISS 制御則のみ F4-01 で修正要）** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **Iteration 5（再監査）への必須検証条件**:
   - **F4-01**: 改訂版 `ORBIT_ASSIST` 数式（`E < 0 ? ... : Infinity` ガード含む）が設計書記載そのままの式で `PhysicsEngine._moveObjects(1.0)` 上の **ISS 5 機体構成すべて（特に `07_preset_orbit_insertion.test.mjs:309–383` の `h3_22 + htv_x`）で `380 <= apKm <= 550`, `ecc < 0.05`, `peKm >= 140`, `< 850s`** を満たすこと（および `leo_250km` 6/6・`gto_insertion`・`lunar_insertion` 非破壊）を再検証すること。
2. **微細な実装・UI 連携の留意点**:
   - `calculateMissionFlightPlan` の SRB 付機体では `boosters.coreThrustKN` を `<= 10000 kN` 上限で強化し、`stages[0].thrustKN = boosters.thrustKN + boosters.coreThrustKN` と連動させる（例：`h3_24` `solar_escape` で `17213 kN`）。`index.html:473` の `#rl-launch-thrust` スライダは `max="10000"` であるため（既存 `h3_24` `11500 kN` 含め）、`RocketTab` 側のスライダ同期で値が勝手に `10000` へ丸め戻されないこと（または動的 `max` 更新）に実装時注意すること。
   - `calculateMissionFlightPlan` から `targetVInfKmS` を返却し、`applyToLauncher` → `RocketLauncher` → `ObjectPlacer` / `TrajectoryPredictor` → `ObjectManager` / `calc_predictor` → `PhysicsEngine.addObject` → `CalcRocket` まで 4 ターゲット全貫通させること。
   - `ObjectManager.getState()` / `loadState()` において、`03_celestial_world.test.mjs:1272–1275` のような最小フィールド構成のセーブデータ読み込み時も `rotationAngle || 0` や `restoredRuntimeState === false` が安全にフォールバックされること。


---

## 独立監査1: 設計監査 — Iteration 5

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 5
- **実施日時**: 2026-11-20 16:07 JST
- **判定**: **FAIL**

Rev 5 設計書（[`docs/design/2026-11-20_trajectory_fx_flightplan.md`](../design/2026-11-20_trajectory_fx_flightplan.md)、全 157 行）を `docs/development_process.md`、Iteration 1〜4 指摘（F-01〜F-13, F2-01〜F2-08, F3-01〜F3-04, F4-01〜F4-02）、および実コードベース・プリセット JSON・既存テスト群（Node 上での実 `PhysicsEngine._moveObjects` ＆ `PredictorPhysicsEngine` 数値シミュレーション検証含む）とゼロベースで照合した。なお、`git status -u` によりソース・プリセット・テストファイルの改変は 0 件であることを確認済みである。

**Iteration 4 指摘（F4-01 / F4-02）および主要数値ロジックの独立検証結果（PASS 確認済み部分）**:
- **F4-01（完全解消・実測 PASS）**: Rev 5 L113–120 記載の `ORBIT_ASSIST` 数式（`isCircularTarget = Boolean(targetApogeeKm > 0 && targetPerigeeKm > 0 && targetApogeeKm / targetPerigeeKm <= 1.5)`, `altM >= 140000 && vHMag >= 4200 && (apKm >= targetApogeeKm * 0.88 || E >= 0)`, `E < 0 ? ... : Infinity` 保護, `vrTgt`, `gamma_cmd`, `cos(gamma_cmd)*uH + sin(gamma_cmd)*uR`）を実 `PhysicsEngine._moveObjects(1.0)` および `dt = 0.05s`（`Rocket` `objParam` 有り／無し双方）で直接検証し、以下を確認した：
  - **`iss_rendezvous` 全 5 構成（`dt = 1.0`, テスト `07` 準拠）**:
    - `h3_22 + htv_x`: `748s`, `pe = 166.0 km`, `ap = 479.3 km`, `ecc = 0.0234`（PASS）
    - `h3_22 + earth_obs`: `710s`, `pe = 154.4 km`, `ap = 423.6 km`, `ecc = 0.0202`（PASS）
    - `h3_24 + htv_x`: `659s`, `pe = 160.0 km`, `ap = 517.4 km`, `ecc = 0.0266`（PASS）
    - `falcon9 + htv_x`: `491s`, `pe = 309.9 km`, `ap = 428.5 km`, `ecc = 0.0088`（PASS）
    - `h3_30 + htv_x`: `728s`, `pe = 183.7 km`, `ap = 502.5 km`, `ecc = 0.0237`（PASS）
  - **実運用条件（`Rocket` `objParam` 付与時、`dt = 1.0s` / `dt = 0.05s`）**: 全 5 構成が `ap = 419.9..501.1 km`（`dt=0.05`: `385.6..474.3 km`）, `pe >= 140.6 km`, `ecc <= 0.0249`, `< 755s` で PASS。
  - **他ミッション非破壊**: `leo_250km` 全 6 機体（`274..662s < 850s`, `pe >= 141.2 km`, `ecc < 1.0`）、`gto_insertion`（`875s`, `pe = 591.2 km`, `ap = 36371.7 km`, `ecc = 0.720`）、`lunar_insertion`（`930s`, `pe = 633.0 km`, `ap = 439990.2 km`, `ecc = 0.969`）すべて PASS。
- **F4-02（解消確認）**: `ObjectManager._applyRocketState` の `if (target.fairing && objData.tmFairingSeparated !== undefined)`・`!== undefined` / `Number.isFinite` ガード群・`objData.isPayloadSeparated` (L295) / `objData.burnTime` (L312) / `isStage2Separated` フォールバック (L300) は `03_celestial_world.test.mjs:1079, 1113–1124, 1250–1257` と完全互換。`PresetManager._adaptFlightProfileForVehicle` の `const refUpper = vehicle?.stages?.[1] ?? stages?.[1];` は `08_tab_navigation_lifecycle.test.mjs:1356` と完全互換。`#rl-launch-thrust` スライダ動的 `max = Math.max(10000, Math.ceil(thrustKN))` 方針も妥当。
- **予測サンプラー（F-03 / F2-06）**: `hardBudgetFloorDt` 式を `PredictorPhysicsEngine` で実測し、`1200s` で **970 点 (`> 500`)**、`12ヶ月`（`mars_transfer`）で **2,494 点 (`< 3000`, 100% 完走)**、`36ヶ月`（`jupiter_transfer`）で **2,533 点 (`< 3000`, 100% 完走)** を確認。

**FAIL 理由（Rev 5 要約圧縮による仕様欠落・曖昧プレースホルダ化の発生）**:
F4-01 と F4-02 の修正は完全に検証できた一方、Rev 5 作成時に設計書全体が 157 行の要約版へ圧縮された結果、**Iteration 1〜3 で既に解消・必須化されていた具体的数値・数式・JSON スキーマ・フィールド一覧・状態遷移仕様・デッドコード対象が設計書本文から抜け落ちた**。このまま工程 2（実装）へ進むと、設計書に書かれていない仕様を実装者が場当たり的に補完せざるを得ず、`docs/development_process.md` 第 3.1 節および Gate 1 基準（曖昧性・プレースホルダの排除）に違反する。よって Rev 6 にて F4-01/F4-02 の確定式を保持したまま下記仕様を復元・補完する必要がある。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### F5-01 [Critical] 要件4: 7ミッション差別化仕様の具体 `flightProfile` 行・分離 `action` 定義が Rev 5 から消失（F-10 #5 / F2-01 再発）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L18, L132–133
  - プリセット: `presets/missions/*.json`
- **現象**:
  - L18 で「7ミッションを完全差別化（`iss_rendezvous` 8行維持、`lunar_insertion` `targetPerigeeKm: 250` 維持）」と謳い、L133 で行数（`9行` / `8行`）と目標値のみ列挙しているが、現行 `presets/missions/` では `iss_rendezvous` 以外の 6 ミッションが同一の `flightProfile`（`alt: 0..380000`）を共有している。Rev 5 には **各ミッションで設定する具体的な `(type, value, thrust, angle, action)` テーブルが 1 行も記載されていない**（Iteration 1 Watchpoint 2 の「各ミッション用 `flightProfile` 差分をすべて設計書上で数値・式・型レベルまで一意に確定させること」に逆行）。
  - さらに L130 の深宇宙サイジングにおいて「`SRB付機体の boosters.coreThrustKN（<= 10000 上限・元値下限維持）と stages[0].thrustKN を連動強化`」と記されており、非 SRB 機体（`h3_30` `4410 kN`, `falcon9` `7600 kN`）で `stages[0].thrustKN` も `10000 kN` 上限まで増強するか否かが曖昧である（`h3_30` で増強しない場合、`4410 / (9.80665 * 1.25) = 359.8 t` 制約により上段推進剤が `86.25 t` で頭打ちとなり、`jupiter_transfer` / `solar_escape` の必要 Δv に到達できない）。
- **修正方針**:
  - 全 7 ミッションの確定 `flightProfile` 行一覧（全行の `type`, `value`, `thrust`, `angle`, `action` 適用有無）と目標パラメータを Rev 6 へ明記し、実 `PhysicsEngine` 上で既存テスト `07` 互換および全 7 ミッションの成立を再確認できる状態にする。あわせて深宇宙サイジングにおける非 SRB 機体（`h3_30`, `falcon9`）の `stages[0].thrustKN` 引き上げ上限（`<= Math.max(origThrust, 10000)`）と反復 Δv 解法・SRB 燃焼後残存質量算出式を明記する。

#### F5-02 [Critical] 要件2・3: `AeroUtils` 温度モデル・`VAPOR_CONE` 計算式・`COLD_GAS_RCS` / `VAPOR_CONE` JSON スキーマ・RCS 符号/Ullage 幾何/同期先が欠落（F-04 / F-07 退行）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L61, L86–90, L96, L99, L145–150
  - 実装: `scripts/gravsim_utils.js`, `scripts/gravsim_calc_object.js`, `scripts/gravsim_object_manager.js`, `scripts/gravsim_rocket_renderer.js`, `presets/visuals/rocket.json`, `scripts/gravsim_preset_manager.js`
- **現象**:
  1. L96 は `a = sqrt(1.4 * 287.05 * T)` と記すが、高度 `altM`（および他天体 `ATM_SCALE_HEIGHT` 等）から気温 $T$ を求める温度プロファイル式が未記載。またベイパーコーンの「強度・クランプ幅式」を文言で言及するだけで、実数式および前後軸方向配置比率・幅/長さ乗数式が一切欠落している。
  2. L99 は「`presets/visuals/rocket.json` と完全同一の `COLD_GAS_RCS`, `VAPOR_CONE` を同梱」と記すが、両セクションのキー名・数値（色、アルファ、ノズル径/位置比、幅倍率等）の定義が設計書内に存在しない。
  3. L89–90 は `CalcRocket._updateRcsState` の `err` 符号規約（`targetAngle - currentAngle` の正が CW か CCW か）、連続／パルス判定式（`|err| >= SLEW_CONTINUOUS_RAD`、低大気 `ambientPresRatio <= LOW_AERO_PRES_RATIO`、分離整定タイマ減算、デューティサイクル式）、および `RocketRenderer` の CW/CCW 噴射方向と Ullage ノズル座標・斜め角が省略されている。
  4. L61 は `WorkerBridge.parseWorkerToMain` で `rcsCw`, `rcsCcw`, `rcsUllage` を抽出する設計だが、受け側の `ObjectManager._applyRocketState`（L145–150）に `target`（または `target.telemetry`）へそれらを反映する仕様が抜け落ちている。
- **修正方針**:
  - `AeroUtils` の温度 $T(h)$・音速・マッハ数・ベイパーコーン強度/幅クランプ数式、`presets/visuals/rocket.json` / `_seedFallbacks()` に追加する `COLD_GAS_RCS` / `VAPOR_CONE` 全キー確定値、`_updateRcsState` の完全ロジックと符号規約、`RocketRenderer` の CW/CCW/Ullage 座標・噴射ベクトル表、および `_applyRocketState` への `rcsCw`/`rcsCcw`/`rcsUllage`（`!== undefined` ガード付）同期を明記する。

#### F5-03 [Major] 要件4: `"Deferred Auto-Staging / Orbital Hold 完備"` の実体未定義、`_sensorData.stageState` 連携漏れ、`'vel'` 予測基準・`targetVInfKmS` カットオフ境界の曖昧性（F-09 / F2-08 残・再発）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L39, L87, L106–108, L111, L116, L127
  - 実装: `scripts/gravsim_calc_object.js:972–1086`, `scripts/gravsim_flight_computer.js`, `scripts/gravsim_calc_predictor.js`
- **現象**:
  1. L39・L107 に「`Deferred Auto-Staging / Orbital Hold 完備`」と記載されているが、どのような条件で自動段分離やカットオフ分離を遅延・保留し、どのイベント/状態で解除するのかという制御仕様が設計書から欠落している。
  2. L87 (`sensor.stageState === 'INTERSTAGE_COAST'`) および L116 (`sensor.stageState === 'STG_BURNING'`) は `_sensorData.stageState` に依存しているが、L111 の `_sensorData` 同期項目列挙から `stageState` が抜け落ちている。また `FlightComputer` が発火した独立アクションラッチ（どの行の `action` が今ステップ発火したか）を `CalcRocket` へ渡すインターフェースが未記載。
  3. L108 の「`vel イベントも統一基準化`」は、`gravsim_calc_predictor.js` で地表相対速度（`flightComputer.telemetryCache` の `Math.hypot(vV, vH)`）と慣性対天体速度（`Math.hypot(curRelVx, curRelVy)`）のどちらに統一するかが明記されていない（F2-08 指摘の再発）。
  4. L127 の双曲線カットオフ `else if (E >= 0 && this.targetVInfKmS > 0)` は、`gravsim_calc_object.js:1038` の既存条件上 `!this.isPayloadSeparated` と並列の `isPayloadBurning`（`mmx` 等の自走ペイロード燃焼時）にも到達し得るため、ペイロード分離後に Earth 圏内で再点火した際へ誤って強制カットオフが掛からないよう適用境界（`!this.isPayloadSeparated` 限定等）を明確にする必要がある。
- **修正方針**:
  - Deferred Auto-Staging / Orbital Hold の状態遷移条件、`_sensorData`（`stageState`, `targetApogeeKm`, `targetPerigeeKm`, `disableOrbitalCutoff`）同期、アクションラッチ受け渡し契約、`calc_predictor.js` の `vel` 速度基準、および `targetVInfKmS` カットオフの `!this.isPayloadSeparated` 境界を明記する。

#### F5-04 [Major] 要件5: `getState`/`loadState` フィールドのプレースホルダ化・`CalcRocket` 復元契約不足・第3のデッドコード群未特定（F-11 / F3-04 退行）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L152–155
  - 実装: `scripts/gravsim_object_manager.js:386–453`, `scripts/gravsim_calc_object.js:228–336`, `scripts/gravsim_save_manager.js:50–71`, `scripts/gravsim_const.js`
- **現象**:
  1. L152 が `Rocket（全設計項目＋全ランタイム段階項目）` と抽象プレースホルダで記述されており、F-11 / F3-04 で確定必須とされた具体的保存・復元フィールド一覧（`stages`, `payload`, `fairing`, `boosters`, `colorTheme`, `autoControl`, `disableStaging`, `disableOrbitalCutoff`, `targetApogeeKm`, `targetPerigeeKm`, `targetVInfKmS`, `hostId`, `hostAngleRad`, `hostAltM`, `bottomOffsetM`, `baseRadiusM`, `isHoldDown`, `isIgnited`, `currentStageIndex`, `totalStages`, `isPayloadSeparated`, `isBoosterBurnout`, `isBoosterSeparated`, `hasPayloadPropulsion`, `stageState`, `stgTimer`）が消失している。
  2. L153 の `CalcRocket` `restoredRuntimeState` 契約について、`_activateStage(0)` を抑止した場合に `data`（および `stages[currentStageIndex]` / `payload.propulsion`）から `fuelType`, `thrustForceVac`, `ispVac`, `ispSl`, `burnTime`, `ofRatio`, `dryMass`, `fuelMass`, `oxidMass`, `massLossRate`, `isPayloadSeparated`, `hasPayloadPropulsion`, `isBoosterBurnout`, `isBoosterSeparated`, `stageState`, `stgTimer`, `currentIsp`, `updateTotalMass()` をどう再構築するかが未記載。
  3. L155 の `デッドコード3群削除` について、Rev 5 内に明示されているのは 2 群（L78 の `COLOR_ORBIT`/`COLOR_FALL`、L80 の重複 `TrajectoryPredictor.render`）のみであり、第 3 群の対象シンボルが一切書かれていない（`gravsim_const.js` に存在する未使用定数群 `CALC_SUB_STEPS_BASE`, `CALC_SUB_STEPS_MAX`, `ETA_VEL`, `ETA_VEL_ORBITAL`, `ATM_BUFFER_ZONE_*`, `TIME_NEAR_BODY_S`, `ORBIT_HORIZONTAL_VEL_MIN_M_S`, `TOWER_CLEARANCE_MIN_Q` のいずれを削るか不明）。また `SaveManager（文字列・構造検証）` の具体的な検証条件（`!state || typeof state !== 'object' || !state.universe || typeof state.universe !== 'object'` 等）も省略されている。
- **修正方針**:
  - `getState`/`loadState`/`_buildRocketPayload` の全フィールド一覧、`CalcRocket` `restoredRuntimeState` 復元手順、削除対象デッドコード 3 群の完全リスト、および `SaveManager.load` 構造検証条件を設計書に明記する。

#### F5-05 [Minor] 要件4 UI: 6列 `#rl-flight-profile-table` の選択肢・CSS 仕様と `RocketTab.loadState` 側スライダ `max` 更新漏れ（F-10 #6 / F4-02 補足）
- **箇所**:
  - 設計書: `docs/design/2026-11-20_trajectory_fx_flightplan.md` L137
  - 実装: `index.html:473, 526–535`, `style.css:949–982`, `scripts/gravsim_tab_rocket.js:221, 453–503, 659, 1129`
- **現象**:
  - L137 は列幅比率 `(19/22/14/14/21/10%)` と `05_ui` L1642 の `children[5]` 更新のみを記し、追加される Action 列の見出し・`<select>` 選択肢（値と表示文言）および `'vel'` トリガの `<option>`、`.sidebar` `320px` 幅に収めるための数値入力スピンボタン非表示／パディング CSS 仕様が抜けており、`05_ui_telemetry_audio.test.mjs:1626–1643` の `row0.children[0..5]` 列順契約（0:Trigger, 1:Value, 2:Thrust, 3:Angle, 4:Action, 5:Delete）も明記されていない。
  - `#rl-launch-thrust` スライダの動的 `max` 更新は `selectTab`（`gravsim_tab_rocket.js:659`）だけでなく `loadState`（`L1129`）の `updateSlider('rlLaunchThrust', ...)` にも適用しないとセーブデータ読込時に `10000 kN` 超の推力が `10000` に丸められる。また `rlFuelType` 変更時（`L221`）の上限クランプも `Math.max(10000, stg.thrustKN)` とする必要がある。
- **修正方針**:
  - 6 列テーブルの各列定義・選択肢・CSS ルール、`RocketTab.selectTab` / `loadState` / `rlFuelType` 変更時の `#rl-launch-thrust` 動的 `max` 同期を設計書へ追記する。

---

### 2. 横展開確認（Horizontal Check）

Rev 5 の変更点および今回指摘箇所をコードベース全体で横断調査した：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| `ORBIT_ASSIST` と 7 ミッションプロファイル | F4-01 の `ORBIT_ASSIST` 式は `iss_rendezvous` 5/5・`leo_250km` 6/6・`gto_insertion`・`lunar_insertion` で検証済で問題なし。一方 7 ミッション個別の `flightProfile` 数値テーブルが Rev 5 から欠落。 | **`ORBIT_ASSIST` 式はそのまま固定し、7 ミッション表を設計書へ復元要** |
| `_applyRocketState` と部分モック互換 | `03_celestial_world.test.mjs:1079, 1113, 1250`・`01_core_physics.test.mjs:134–308`・`08_tab_navigation_lifecycle.test.mjs:1356` の互換ガードは Rev 5 L131, L143–150 で解消確認。ただし L61 の `rcsCw`/`rcsCcw`/`rcsUllage` に対する `_applyRocketState` 同期が欠落。 | **L145–150 に `rcsCw`/`rcsCcw`/`rcsUllage` の `!== undefined` 同期を追加要** |
| `#rl-launch-thrust` スライダ `max` 参照箇所 | `scripts/gravsim_tab_rocket.js` 全体で `#rl-launch-thrust` への値設定・クランプは **`selectTab` (L659)・`loadState` (L1129)・`rlFuelType` change (L221)** の 3 箇所に存在。 | **3 箇所すべてに `> 10000 kN` 対応を水平適用要** |
| `gravsim_const.js` の未使用・重複候補定数 | `grep` により `SIMULATION.CALC_SUB_STEPS_BASE` / `CALC_SUB_STEPS_MAX` / `SUB_STEPS.ETA_VEL` / `ETA_VEL_ORBITAL` / `ATM_BUFFER_ZONE_*`、`RENDER.PREDICTED_TRAJECTORY.COLOR_ORBIT` / `COLOR_FALL`、`TRAJECTORY_PREDICTION.SAMPLING.TIME_NEAR_BODY_S`（L167 参照有→置換え後の扱いに注意）、`EVENTS.MAX_Q_DEFAULT_ALT_M`（`trajectory_predictor.js:360` 参照有）、`EVENTS.ORBIT_HORIZONTAL_VEL_MIN_M_S`、`FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MIN_Q` を確認。 | **削除対象を識別子単位で明示し、他所参照中定数の誤削除を防止要** |
| `targetVInfKmS` と自走ペイロード (`mmx` 等) | `CalcRocket.flightControl` L1038 は `!this.isPayloadSeparated` と `isPayloadBurning` を同一 `if` で扱う。`targetVInfKmS` による脱出カットオフはペイロード分離後再点火にも反応し得る。 | **`!this.isPayloadSeparated` 条件への限定を設計書で明確化要** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **Rev 6 作成上の厳守事項（F4-01 / F4-02 を壊さないこと）**:
   - **F4-01 で実測合格した Rev 5 L113–120 の `ORBIT_ASSIST` 数式（パラメータ・条件・符号・`E >= 0` `Infinity` 保護含む）および L78–79 のサンプラー式、L131・L143–150 の F4-02 互換ガードは一切変更せずそのまま維持すること。**
   - 要約化によって他の既解決仕様を再削除しないよう、Rev 6 は全要件の定数名・数式・JSON スキーマ・全 7 ミッションの `flightProfile` 表・保存/復元フィールド一覧・削除対象デッドコード 3 群を省略せず明記した自己完結型設計書にすること。
2. **Iteration 6（再監査）での検証対象**:
   - 7 ミッションの確定 `flightProfile`（特に `mars_transfer` / `jupiter_transfer` / `solar_escape` の新プロファイルおよび非 SRB 機体 `h3_30` / `falcon9` の推力・増槽整合）を実 `PhysicsEngine` 上で検証し、全機体・全ミッションの非墜落・目標到達を確認すること。
   - 復元された `AeroUtils` 温度/コーン式、`COLD_GAS_RCS`/`VAPOR_CONE` スキーマ、Deferred Auto-Staging、`getState`/`loadState`、`CalcRocket` 復元契約、デッドコード 3 群に実コードおよび既存テスト（`01`, `02`, `03`, `05`, `06`, `07`, `08`, `05_ui`, `regressions/05, 06, 07`）との不整合がないこと。


---

## 独立監査1: 設計監査 — Iteration 6

- **対象ゲート**: 独立監査1: 設計監査
- **イテレーション番号**: Iteration 6
- **実施日時**: 2026-11-20 16:16 JST
- **判定**: **PASS**

Rev 6 設計書（[`docs/design/2026-11-20_trajectory_fx_flightplan.md`](../design/2026-11-20_trajectory_fx_flightplan.md)、全 311 行）を [`docs/development_process.md`](../development_process.md)、Iteration 1〜5 の全指摘事項（F-01〜F-13, F2-01〜F2-08, F3-01〜F3-04, F4-01〜F4-02, F5-01〜F5-05 および Watchpoints）、実ソースコード・プリセット JSON・既存テスト群とゼロベースで突合し、実 `PhysicsEngine._moveObjects(1.0)` および数式・`grep` による独立検証を実施した。なお、`git status -u` によりソース・プリセット・テストファイルの改変は 0 件（未追跡の `docs/` 配下のみ）であることを確認済みである。

**Iteration 5 指摘（F5-01〜F5-05）および全体設計の独立検証結果**:

1. **F5-01（完全解消・全 7 ミッション物理シミュレーション PASS）**:
   - Rev 6 L237–246 に全 7 ミッションの具体 `flightProfile` 行（全行 `0°`=天頂 〜 `90°`=ローカル水平、`iss_rendezvous` **8 行維持** [`03_celestial_world.test.mjs:1169` 充足]、`lunar_insertion` `targetPerigeeKm: 250` 維持）と目標パラメータが省略なく確定記載された。
   - Rev 6 L248–260 の深宇宙自動サイジング（`h3_30`/`falcon9` 非 SRB 機体の上限 `maxStg0Thrust = Math.max(origStg0Thrust, 10000)` 引き上げ＋SRB 機体 `h3_22`/`h3_24` の `boosters.coreThrustKN` 連動＋`Math.ceil` `<= 420.0s`＋`vehicle?.stages?.[1] ?? stages?.[1]`＋非固体多段深宇宙 `altScale >= 1.0`）と Rev 6 L229–235 の `ORBIT_ASSIST` 式を実 `PhysicsEngine._moveObjects(1.0)` で検証し、全パターン非墜落・目標達成を確認した：
     - **`leo_250km` (6/6, `< 850s`, `pe >= 140`, `ecc < 1.0`)**: `h3_30` (650s, Pe 195.1, Ap 827.1, ecc 0.0459), `h3_22` (661s, Pe 147.9, Ap 378.7, ecc 0.0174), `h3_24` (580s, Pe 188.1, Ap 1083.6, ecc 0.0639), `falcon9` (472s, Pe 195.2, Ap 356.3, ecc 0.0121), `epsilon` (342s, Pe 181.5, Ap 5345.0, ecc 0.2826), `ssto` (273s, Pe 141.2, Ap 12236.8, ecc 0.4815)。
     - **`iss_rendezvous` (5/5, `dt=1.0`, `objParam` 無/有双方)**: `h3_22+htv_x` (746s/752s, Pe 158.5/158.3, Ap 468.9/462.7, ecc 0.0232/0.0228), `h3_22+earth_obs` (710s/716s, Pe 160.7/153.8, Ap 425.5/419.5, ecc 0.0199/0.0200), `h3_24+htv_x` (657s/704s, Pe 165.5/163.9, Ap 518.2/416.9, ecc 0.0263/0.0190), `falcon9+htv_x` (488s/489s, Pe 298.4/309.0, Ap 429.1/467.9, ecc 0.0097/0.0118), `h3_30+htv_x` (725s/728s, Pe 173.7/165.9, Ap 497.8/496.5, ecc 0.0242/0.0247) — 全構成が `380 <= apKm <= 550`, `ecc < 0.05`, `peKm >= 140`, `< 850s` で PASS。
     - **`gto_insertion` & `lunar_insertion`**: GTO `h3_24+earth_obs` (866s, Pe 533.9, Ap 36497.6, ecc 0.7225) / `geo_sat` (880s, Pe 528.9, Ap 36219.5, ecc 0.7212)、Lunar `h3_24+earth_obs` (918s, Pe 526.5, Ap 427468.8, ecc 0.9687) / `lunar_orbiter` (896s, Pe 533.5, Ap 422277.6, ecc 0.9683) で PASS。
     - **深宇宙 3 ミッション（`mars_transfer`, `jupiter_transfer`, `solar_escape` × `h3_30`, `falcon9`, `h3_22`, `h3_24`, `earth_obs` / `mmx`）**: **墜落 0 件・全組み合わせ双曲線脱出（`E > 0`, `ecc > 1.0`, `burnTime <= 420.0s`, `639–730s`）** を確認（`h3_30`/`h3_22`/`h3_24`: Mars `vInf 3.66–3.94 km/s`, Jupiter `vInf 9.16–9.26 km/s`, Solar `vInf 12.90–12.95 km/s`; `falcon9`: Mars `3.60 km/s`, Jupiter `5.32 km/s`, Solar `5.30 km/s`。`epsilon`/`ssto` も非墜落・`ORBITAL_COAST` 移行を確認）。
2. **F5-02（完全解消）**:
   - `AeroUtils` の実在定数（`ATM_DENSITY_0`, `ATM_SCALE_HEIGHT`, `ATM_LIMIT_ALT` + 小文字別名）読取、無大気/無効入力ガード、$T(\text{altM})$ 温度モデル、音速・マッハ数、`computeVaporConeParams`、および `RocketRenderer.drawVaporCone` 寸法式が Rev 6 L156–207 に完全確定された（`Earth`, `Mars`, `Venus`, `Titan`, `Jupiter`, `Moon` の全大気パラメータおよび境界値 `Mach 0.81..1.23`, `presRatio 0.015`, `NaN` で実測検証済）。
   - `COLD_GAS_RCS`（L132–141）と `VAPOR_CONE`（L192–201）の全 JSON スキーマが `presets/visuals/rocket.json` および `PresetManager._seedFallbacks()` 共通定義として明記され、`AERO_DYNAMIC` の遷音速閾値と SSOT 分離も維持されている。
   - `CalcRocket._updateRcsState` 完全ロジック（停止ガード `isHoldDown || collided || shattered`、`err = normalizeAngle(targetAngle - preUpdateAngle)` の符号規約 `err > 0 -> rcsCw`、`allowRcs`、デューティ式、整定ダンピング、`INTERSTAGE_COAST` 末尾 `(ignDelay - stgTimer) <= 1.5s` / `_ullageRestartTimer`）、`RocketRenderer` 確定座標・ノズル幾何表（`+X` 機首 / `+Y` CW・単体 `0.85 * payloadR`・純 CW/CCW カップルと `+X` 軸ウルジ）、および `ObjectManager._applyRocketState` の `rcsCw`/`rcsCcw`/`rcsUllage`（`!== undefined` ガード付）同期が L106–150 にて整合している。
3. **F5-03（完全解消）**:
   - Deferred Auto-Staging / Orbital Hold（`_isCurrentStageSepDeferred()`, `_isPayloadSepDeferred()`, `STG_MECO` 保持, 軌道投入時 `ORBITAL_COAST` + `isPayloadSeparated = false` 保持, `executeProfileAction` / `separatePayload()` 先頭 `if (this.disableStaging) return;` + `guard <= totalStages + 1` + 自走ペイロード `STG_COAST` 維持）が L219–228 に明確定義された。
   - `_sensorData` への `stageState`, `targetApogeeKm`, `targetPerigeeKm`, `disableOrbitalCutoff` 同期、および `FlightComputer` 公開 API `hasScheduledAction(actionName)` / `consumePendingActions()` / `_triggeredActionIndices` / `ORBITAL_COAST` 中 `action` 抽出継続（L217–220）が確定した。
   - `gravsim_calc_predictor.js` の `'vel'` 判定基準が `fcTm ? Math.hypot(fcTm.vV || 0, fcTm.vH || 0) : Math.hypot(vV, vH)` へ統一され（L216）、`targetVInfKmS` 双曲線カットオフに **`!this.isPayloadSeparated`** 明示ガード（L235）が付与された。
4. **F5-04（完全解消）**:
   - `ObjectManager.getState()` / `loadState()` / `_buildRocketPayload()` の `CELESTIAL` / `DEBRIS` / `ROCKET` 全保存・復元項目（L279–282）および `CalcRocket` `restoredRuntimeState` 復元手順（`_activateStage(0)` 抑止時の諸元・質量・推力・`currentIsp`・`updateTotalMass()` 再構築、L283–302）が具体化され、最小フィールド互換（`03_celestial_world.test.mjs:1129–1139, 1272–1276`）および `06_external_presets_and_payload_propulsion.test.mjs:285`（通常初期化時 `hasPayloadPropulsion === undefined` 維持）との両立も確認した。
   - 削除対象デッドコード 3 群（L303–306）のうちグループ 1 の 6 定数（`COLOR_ORBIT`, `COLOR_FALL`, `CALC_SUB_STEPS_BASE`, `CALC_SUB_STEPS_MAX`, `ORBIT_HORIZONTAL_VEL_MIN_M_S`, `TOWER_CLEARANCE_MIN_Q`）について `scripts/`, `testsuites/`, `presets/`, `index.html`, `style.css` 全体を `grep` し **参照 0 件**（一方で他所参照中の `TIME_NEAR_BODY_S`, `MAX_Q_DEFAULT_ALT_M` は除外済）を確認した。グループ 2（重複 `TrajectoryPredictor.prototype.render` L893–895）・グループ 3（`gravsim_universe.js` L182–193）も問題ない。
   - `SaveManager.load` 構造検証（L310）は既存テスト（`03` L467, `05_ui` L1396）と整合している。
5. **F5-05（完全解消）**:
   - 6 列 `#rl-flight-profile-table` の `children[0..5]` 列順・幅比率（`19/22/14/14/21/10%`）・`<select>` 全選択肢・スピンボタン非表示含む CSS（`style.css` `.sidebar` `320px` 適合）・`05_ui_telemetry_audio.test.mjs:1642` (`children[5]`) 更新と `L1066–1077`（`inputs[0..3]`）互換が L263–270 に確定された。
   - `#rl-launch-thrust` 動的 `max = Math.max(10000, Math.ceil(thrustKN))` 同期が `RocketTab` 内全該当箇所（`selectTab` L659, `loadState` L1129, `rlFuelType` change L221 の全 3 箇所を `grep` で網羅確認）へ水平適用されている（L271）。

---

### 1. 要修正箇所（Findings / Required Fixes）

なし（Critical / Major / 実ブロッカー 0 件。工程 2 実装へ進行可）。

---

### 2. 横展開確認（Horizontal Check）

Rev 6 全仕様とコードベース全体の最終横断確認結果は以下の通り：

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| `gravsim_const.js` 削除対象デッドコード 6 定数 | `scripts/`, `testsuites/`, `presets/`, `index.html`, `style.css` 全検索で `COLOR_ORBIT`, `COLOR_FALL`, `CALC_SUB_STEPS_BASE`, `CALC_SUB_STEPS_MAX`, `ORBIT_HORIZONTAL_VEL_MIN_M_S`, `TOWER_CLEARANCE_MIN_Q` の外部参照 **0 件**。参照中の `TIME_NEAR_BODY_S` (`gravsim_calc_predictor.js:167`)・`MAX_Q_DEFAULT_ALT_M` (`gravsim_trajectory_predictor.js:360`) は正しく除外。 | **削除安全（設計通り実施可）** |
| `#rl-launch-thrust` 動的 `max` 同期箇所 | `scripts/` 全体で `#rl-launch-thrust` / `rlLaunchThrust` の値代入・クランプは `gravsim_tab_rocket.js` の `selectTab` (L659), `loadState` (L1129), `rlFuelType` change (L221) の 3 箇所のみ。 | **全 3 箇所網羅済（問題なし）** |
| `RocketTab` 6 列化と既存テスト参照 | `05_ui_telemetry_audio.test.mjs:1066–1077` (`querySelectorAll('input, select')` の `[0..3]`) は非破壊。`L1642` (`row0.children[4]`) は `children[5]` 更新計画済。`.profile-table button.remove-step-btn` CSS (`style.css:973, 980`) は `fp-del` と併用または更新可能。 | **整合済（Watchpoint 参照）** |
| `Universe.rotationAngle` 削除影響 | `testsuites/` 全体検索で `Universe` がメインスレッド側で `rotationAngle` を積分する前提のテストは 0 件（すべて初期値設定モックのみ）。 | **削除安全（問題なし）** |
| `InfoPanel.lastTime` 互換 | `gravsim_info_panel.js:20, 89–90` と `05_ui_telemetry_audio.test.mjs:953` のみ。`instanceof Date` 変換＋`Date.now()` 統一計画で非破壊。 | **整合済（問題なし）** |
| `Payload`・`Stage` 状態同期のモック耐性 | `01_core_physics.test.mjs:134–308`, `03_celestial_world.test.mjs:1079, 1113, 1250, 1272`, `06_external_presets_and_payload_propulsion.test.mjs:285, 362, 581`, `08_tab_navigation_lifecycle.test.mjs:1356` すべて互換ガード確認済。 | **整合済（問題なし）** |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

工程 2（実装・静的検証）および工程 3〜4（テスト追加・E2E・カバレッジ確認）において、以下の微細な実装境界に留意すること（設計差し戻し不要の実装時ガード）：

1. **`PresetManager.calculateMissionFlightPlan` の `boosters` 判定**:
   - `h3_30.json` および `falcon9.json` は `rendering.boosters: { count: 0 }` を持つため、`calculateMissionFlightPlan` のマージ後 `boosters` は `{ count: 0 }`（truthy オブジェクト）となる。Rev 6 L250・L257–259 の SRB 有無分岐では `gravsim_calc_object.js:249` と同一の **`const hasBoosters = Boolean(boosters && ((boosters.count > 0) || (boosters.burnTimeSec > 0)));`** を用いること（単純 `if (boosters)` にすると非 SRB 機体で `stages[0].burnTime` 算出や `remStg0Prop` が誤判定される）。
2. **`CalcRocket.executeProfileAction` の段インデックス冪等ガード & `restoredRuntimeState` 補完**:
   - `sep_stage1` 実行時は `if (this.currentStageIndex !== 0 || this.isPayloadSeparated) return;`、`sep_stage2` 実行時は `if (this.isPayloadSeparated || (this.totalStages >= 3 && this.currentStageIndex > 1)) return;` のように段インデックスを確認し、重複・遅延トリガによる上段誤分離を防ぐこと。
   - `CalcRocket` の `restoredRuntimeState` 復元（Rev 6 L283–302）において、`this.hasBoosters && this.isBoosterBurnout && this.currentStageIndex === 0` の場合は `thrustForceVac = this.coreThrustVac` とし、`this.isBoosterIgnited = !this.isBoosterBurnout && !this.isHoldDown && this.isIgnited` を整合させること。また `PhysicsEngine.addObject(data)`（`gravsim_calc.js:48–82`）へ `currentStageIndex`, `isPayloadSeparated`, `isStage2Separated`, `isBoosterBurnout`, `isBoosterSeparated`, `hasPayloadPropulsion`, `stageState`, `stgTimer`, `mach`, `rcsCw`, `rcsCcw`, `rcsUllage`, `restoredRuntimeState`, `targetVInfKmS` を漏れなく転送すること。
3. **`SaveManager.load`・`RocketTab` ボタン CSS・予測サンプラー 36 ヶ月境界**:
   - `SaveManager.load`（Rev 6 L310）では `Array.isArray(state)` / `Array.isArray(state.universe)` も弾く形（`!state || typeof state !== 'object' || Array.isArray(state) || !state.universe || typeof state.universe !== 'object' || Array.isArray(state.universe)`）にすると JSON 配列 `[]` や `{ universe: [] }` も確実に拒否できる。
   - 6 列テーブルの削除ボタンは `class="fp-del remove-step-btn"` とするか `style.css:973, 980` へ `.fp-del` を併記し既存赤ボタン装飾を維持すること。
   - 予測サンプラーの `hardBudgetFloorDt`（Rev 6 L82）は 36 ヶ月 (`94,672,800s`) 検証で `points = 3000` 到達時 `simTime ≈ 94,627,424s`（**99.95% 到達**）となるため、`maxSimTime` 厳密 `100.0%` 一致を E2E/Unit テストでアサートする場合は終端残余ステップの扱い（または `sampleBurnBoundary` 後の `* 0.85`→上限近傍の調整）に注意すること。また `gravsim_calc.js:653–661` の `determineOptimalSubSteps` フォールバックには `MIN_SURFACE_DIST`〜`BODY_COUNT_MIN_MULT` まで全キーを補完すること。
4. **工程 2〜4 の品質ゲート要件**:
   - `node --check`、ESLint（`.eslintrc.json`）、TypeScript `tsc --noEmit`（`jsconfig.json` `checkJs: true`）すべて **エラー 0 件** を必須達成すること。
   - `testsuites/system/` のヘッドレス Chrome UI テスト（`server.listen(0, '127.0.0.1')`、`/tmp` プロファイル分離、`try/finally` プロセス終了保証）を実装し、全追加・既存テストで **正常系・異常系・境界値** の 3 観点を網羅し、カバレッジ **97% 以上目標（最低 90% 以上）** を維持すること。


---

## 独立監査2: 実装監査 — Iteration 1

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 1
- **実施日時**: 2026-11-20 18:01 JST
- **判定**: **FAIL**（Major 4 件 / Minor 6 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（`git diff main` 38 ファイル +1600/-354、未追跡 `.eslintrc.json` / `jsconfig.json` / `types/ambient.d.ts`）を、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6、Gate 1 Iteration 6 Watchpoints 1〜4 とゼロベースで突合した。実装作業者の主張は前提にせず、以下を実施した（ソース・テスト・プリセット・設計書は無変更。`git status -u` で確認済）。

- 機械的チェックと既存テストの実行。
- 全差分の精読と設計書 Rev 6 との項目別突合。
- **実アプリ経路**（`PresetManager.applyToLauncher` → `RocketLauncher.rollout()` → `ObjectPlacer.placeObject()` → `ObjectManager.addObject()/_buildRocketPayload()` → `PhysicsEngine.addObject()` → `_moveObjects()` → `WorkerBridge.formatWorkerToMain()/parseWorkerToMain()` → `ObjectManager.updateObjectParams()`）を Node 上で駆動する検証ハーネスによる実地検証。Gate 1 および `07_preset_orbit_insertion.test.mjs` は `engine.addObject()` 直呼びのため `_buildRocketPayload` 経路を通らない点に留意した。
- `git archive main` で抽出した main ツリーとの A/B 比較（回帰か既存不具合かの判定）。
- 検証スクリプト一式: `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2/`（`harness.mjs`, `t1`〜`t17`）。main 比較用ツリーは同 scratchpad の `main_tree/`、計装用コピーは `feat_tree/`（いずれもリポジトリ外）。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax`（`node --check` 全 `scripts/` `testsuites/`） | exit 0・エラー 0 |
| Lint | `npm run check:lint`（システム ESLint v6.4.0 + `.eslintrc.json`） | **エラー 0**／警告 54（全件 `testsuites/` の `no-unused-vars`、`scripts/` は 0 件） |
| 型 | `npm run check:types`（`tsc 7.0.2 -p jsconfig.json`, `checkJs: true`） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**設計書 Rev 6 突合結果（要約）**:

| 要件 | 突合結果 |
|---|---|
| 1 ジグザグ防止 | `BUFFER_INDEX 47..50`／`OBJ_ATTR_COUNT 51`／`ROCKET_FLAG` bit16..19／`STAGE_STATE_TO_CODE`・`CODE_TO_STAGE_STATE`：一致。NaN で汚染したプール再利用でも全 51 スロットの明示上書きを確認（rocket/celestial/debris）。自転角 SSOT（`PhysicsEngine._updatePositionAndHalfVelocity`）と `Universe` 旧ループ削除：一致（main/worker 間の `rotationAngle` 差 0）。ホールドダウン同期・2 パス原子的コミット・`_recordActualFlightPath` 末尾保持・先減算描画・重複 `render()` 削除：一致。サンプラー定数・`scaledCoastSampleTime`・`baseNearBodyDt`・`hardBudgetFloorDt`・ループ外最終点：一致。**ただし遠近点通過サンプリングが機能していない（G2-03）**。 |
| 2 RCS | `RCS_CONFIG`、`desiredThrustAngleRad`、`INTERSTAGE_COAST` のコースト追従、`_updateRcsState`（停止ガード・符号規約・`allowRcs`・デューティ・整定ダンピング・Ullage 1.5 s 境界）、各タイマのセット、`_applyRocketState` の RCS 同期、`COLD_GAS_RCS` スキーマ（JSON とフォールバック）、ノズル幾何：一致（単体検証済）。 |
| 3 ベイパーコーン | `AERO_DYNAMIC` 定数、`AeroUtils` 各式、`mach = 0` の 3 箇所クリア、`TM_MACH` 同期、`SoundEffects`、`VAPOR_CONE` スキーマ：一致。**ただし設計式と設計注記の不整合あり（G2-08）**。 |
| 4 フライトプラン | 7 ミッションの `flightProfile` 全行・目標値（`iss_rendezvous` 8 行、`lunar_insertion` `pe: 250`）、`vel`/`apogee` トリガ、独立ラッチ API、Deferred Staging / Orbital Hold、`ORBIT_ASSIST`、`!isPayloadSeparated` 境界の V∞ カットオフ、予測側の全通過段 sep 検出、`P-SEP`、深宇宙サイジング（WP1 `hasSrbBoosters` 含む）、`applyToLauncher`、6 列 UI/CSS、スライダ `max` の 3 箇所同期：一致。**ただし `vel` の横展開漏れ（G2-04）と `rlFuelType` 上限クランプ未修正（G2-05）あり**。 |
| 5 全体是正 | `_applyRocketState` 各フィールド、`getState`/`loadState` フィールド、デッドコード 3 群の削除（6 定数の参照 0 件）、`AERO_DYNAMIC` import、`InfoPanel`、`SaveManager`（WP3 の配列拒否含む）、タイポ修正：一致。**ただし `restoredRuntimeState` の契約違反（G2-01）、共有参照の破壊（G2-02）、不要コード残存（G2-06）、復元の欠落（G2-07）あり**。 |

**Gate 1 Iteration 6 Watchpoints 突合**:

| WP | 結果 |
|---|---|
| WP1 `hasBoosters` 判定 | ✓（`gravsim_preset_manager.js:679` `hasSrbBoosters` を 2B 節全体で使用） |
| WP2 冪等ガード・復元補完・転送 | 冪等ガードは ✓（`sep_stage2` は `currentStageIndex === 1` 限定で WP より厳格）。復元時の `coreThrustVac` と `isBoosterIgnited` 整合も ✓。`PhysicsEngine.addObject` の転送は 14 項目中 10 項目のみで、`mach`/`rcsCw`/`rcsCcw`/`rcsUllage` が未転送（過渡値で初回ステップに再計算されるため機能影響なし。G2-07 に記載）。**転送したフィールドについても、`CalcRocket` 側の分岐が G2-01 の通り誤っている**。 |
| WP3 SaveManager・CSS・36 ヶ月・フォールバック | 配列拒否 ✓、`fp-del` と `remove-step-btn` の併記 ✓、36 ヶ月予測の到達率 100.00% ✓、フォールバックの全キー補完 ✓。ただし補完した値が SSOT と乖離（G2-06）。 |
| WP4 機械チェック | 3 種ともエラー 0 ✓（Chrome E2E とカバレッジは工程 3/4 の範囲） |

**実地物理検証（実経路ハーネス、dt = 0.1 s × 10 サブステップ／フレーム、フレームごとに Worker→Main 往復）**:

| 構成 | 結果（墜落 0 件・同期不一致 0 件） |
|---|---|
| `leo_250km` × 6 機体 | `h3_30` Pe 181.9／Ap 778.4、`h3_22` 141.6／393.3、`h3_24` 141.8／529.0、`falcon9` 147.4／268.4、`epsilon` 160.7／4259.4、`ssto` **133.0**／11588.2 km（全機 `ORBITAL_COAST` かつペイロード分離済） |
| `iss_rendezvous` × 4 機体（`htv_x`） | `h3_22` 142.6／434.3、`h3_24` 142.7／405.6、`falcon9` 152.6／384.4、`h3_30` 144.3／475.3 km（ecc ≤ 0.025） |
| `gto_insertion`／`lunar_insertion`（`h3_24`） | GTO Pe 389.0／Ap 35864.6 km、Lunar Pe 385.0／Ap 389354.0 km |
| 深宇宙 | `h3_30+mmx` Mars：ecc 1.68・V∞ 6.25 km/s。`falcon9` Jupiter：V∞ 5.36。`h3_24` Solar：V∞ 12.80（いずれも双曲線脱出） |
| 同期検証項目 | `stageState`, `stgTimer`, `mach`, `telemetry.mach`, `rcsCw/Ccw/Ullage`, `telemetry.rcsCw`, `isPayloadSeparated`, `isStage2Separated`, `currentStageIndex`, `hasPayloadPropulsion`, `fairing.isSeparated`, Earth `rotationAngle`：全フレームで Worker と Main が一致。最大マッハ 4.5〜10.1、ベイパーコーン有効 9〜13 フレーム（最大強度 0.98〜1.00）、RCS/Ullage 噴射は全フライトで観測。 |
| save/load 往復（15 スナップショット） | `h3_22` ISS（30〜760 s）、`falcon9` ISS（100〜500 s）、`h3_24+mmx` Mars（60〜700 s）：全件で復元後に継続飛行でき、墜落 0 件。段状態・質量・推力・燃料の差分なし（燃焼終了後の `isBoosterIgnited` と `ORBITAL_COAST` 時の `massLossRate` のみ差分、機能影響なし）。Earth `rotationAngle` は完全一致。ただし G2-07 の欠落を確認。 |
| 分離アクション 6 シナリオ | 予測と実機の分離高度差 ≤ 0.5 km。`falcon9` ISS の `sep_payload` 遅延（カットオフ → `ORBITAL_COAST` 保持 → 340 km で分離）、2 段機の `sep_stage2`（time 560 s）、3 段機 `epsilon`、`vel` ラッチ：すべて設計どおり。早期・遅延分離で上段の TWR が不足し再突入するケースは物理的に妥当な結果。 |
| 予測サンプラー | 1200 s：1204 点・到達率 100%。深宇宙 12〜36 ヶ月：2429〜2964 点・100%（main は 0.04〜0.11%）。重複点 0・時刻の非単調 0。地球近傍：G2-10 参照。 |

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-01 [Major] `restoredRuntimeState` 契約違反：通常ロールアウトとスリングショットのロケットが全件「復元分岐」に入り、スリングショット機の第 1 段推進が消失する（回帰）
- **箇所**:
  - `scripts/gravsim_calc_object.js:320-325`（`CalcRocket` コンストラクタの `hasRestoredRuntime`。`thrustData?.stageState ||` を含む）、`:326-382`（復元分岐）
  - `scripts/gravsim_object.js:303`（`Rocket` 既定値 `this.stageState = 'PRE_LAUNCH'`）
  - `scripts/gravsim_object_manager.js:81-84, 118-121`（`_buildRocketPayload` のヒューリスティックな `isRestored`）、`:452-505`（`getState()` に `restoredRuntimeState: true` がない）
  - 影響経路: `scripts/gravsim_object_placer.js:724-750`（`goLaunch` → `placeObject(..., { isSlingshot: true, disableStaging: true })`）
- **現象**:
  1. 主スレッドの `Rocket` は常に `stageState = 'PRE_LAUNCH'`（truthy）を持ち、`_buildRocketPayload` がそれをそのまま送る。`CalcRocket` は `restoredRuntimeState || stageState || ...` の OR 判定のため、`_buildRocketPayload` が `restoredRuntimeState: false` を付けても無視される。結果、**実経路のすべてのロールアウト（t1 で 7 構成全件）が `_activateStage(0)` を経由しない**。設計 Rev 6 L283 の「`_activateStage(0)` 抑止は `restoredRuntimeState` 時のみ」に反する。ロールアウト機では値が偶然一致するため顕在化していないが、`_activateStage(0)` 経路では `isStage2Separated` が未初期化（`undefined`）のまま残るなど、2 経路の初期状態が一致しない。
  2. **スリングショット機（回帰。main と A/B 比較）**: main では `_activateStage(0)` が働き、`burnTime 240 s`・fuel 34.3 t・dry 25 t・総質量 301.2 t・`STG_BURNING` だった。本ブランチでは復元分岐に入り、`burnTime 0`・fuel 0・dry 57.5 t（`Rocket` パラメータの `MASS`）・総質量 93.7 t となり、`disableStaging` のため `stageState` が `PRE_LAUNCH` から抜けない。
  3. 設計 F5-04 の ROCKET 保存項目にある `restoredRuntimeState: true` が `getState()` に存在しない。
- **修正方針**:
  - `CalcRocket` の分岐は `thrustData?.restoredRuntimeState === true` だけで判定する。`stageState` などからの推定は削除する。
  - `getState()` の ROCKET に `restoredRuntimeState: true` を出力する。`loadState()` はそれを `obj.restoredRuntimeState` に保持する。`_buildRocketPayload` は `obj.restoredRuntimeState === true` をそのまま転送する（推定は行わない）。
  - `_activateStage(0)` 経路でも `isStage2Separated = false`・`hasPayloadPropulsion` を明示初期化して 2 経路の初期状態を揃える。ただし `06_external_presets_and_payload_propulsion.test.mjs:285` の `hasPayloadPropulsion === undefined` 契約との整合を確認すること。
  - 実経路（rollout・slingshot・loadState）で `CalcRocket` の初期状態が `_activateStage(0)` 参照値と一致することをテストで固定する。

#### G2-02 [Major] 打上げ済みロケットと `RocketLauncher` 設定の共有参照の破壊：初回打上げのフェアリング分離が次回打上げ構成へ伝播する（回帰）
- **箇所**:
  - `scripts/gravsim_object_manager.js:323-325`（`_applyRocketState` の `target.fairing.isSeparated = ...`。本差分で新規追加）
  - `scripts/gravsim_object_placer.js:121-123, 143-147`（`options.flightProfile/stages/payload/fairing/boosters/rendering` を参照のまま代入）
  - `scripts/gravsim_rocket_launcher.js:623, 639-643`（`rollout()` が自身の設定オブジェクトをそのまま渡す）
  - `scripts/gravsim_object_manager.js:468-474`（`getState()` が共有オブジェクトを直列化する）
- **現象**:
  1. 主スレッドのロケットと `RocketLauncher` の `fairing`/`stages`/`payload`/`boosters`/`flightProfile` が同一参照になっている（t13 で 5 項目すべて `===` を確認）。新規の `_applyRocketState` がフェアリング分離を書き込むと、`RocketLauncher.fairing.isSeparated = true` に書き換わる。
  2. **同じ構成で 2 機目をロールアウトすると、フェアリング分離済みの状態で Worker に生成される**（t4: `calc fairing.isSeparated = true`、質量が 325.13 t から 322.93 t へ −2.2 t。フェアリングの投棄・描画が消え、予測もフェアリングなしで計算）。`RocketLauncher.getState()` も `isSeparated: true` を永続化する。main では `isSeparated` は不変だった（A/B で回帰を確認）。
  3. リフトオフ後、タブのロックが解除された状態で次回用の設定を RocketTab で編集すると、飛行中ロケットの保存内容が汚染される（t13: `stages[1].fuelMassT` と `flightProfile[3].angle` の編集が、飛行中機の `getState()` にそのまま出力された）。今回 `getState()` が `stages/payload/fairing/boosters` も保存するようになったため、ロード後の `CalcRocket` が誤った上段諸元で復元される。
- **修正方針**:
  - `rollout()`（または `placeObject` の ROCKET 分岐）で `stages/payload/fairing/boosters/flightProfile/rendering` をディープコピーし、ロケット専有のオブジェクトにする。
  - `fairing` の同期はロケット専有のコピーにだけ書き込む。
  - 同種の参照共有を `ObjectPlacer` の他フィールドについても横断確認する。
  - 「2 回目ロールアウト時にフェアリングが未分離であること」と「リフトオフ後のランチャー編集が飛行中機の保存値に影響しないこと」をテストで固定する。

#### G2-03 [Major] 予測サンプラーの「遠近点通過サンプリング」（`sampleByApsidal`）がデッドパスになっている（設計要件 1-3 の不履行）
- **箇所**: `scripts/gravsim_calc_predictor.js:534`（Apoapsis 検出直後の `prevVv = vV;`）、`:597-601`（`sampleByApsidal` の `prevVv * vV <= 0`）、`:624`（重複した `prevVv = vV;`）。シンボルは `runMultiBodySimulation`。
- **現象**: L534 で `prevVv` が当ステップの `vV` に上書きされた後に L599 で参照されるため、`prevVv * vV = vV² ≥ 0` となる。条件が真になるのは `vV === 0` のときだけで、その場合も直後の `(|prevVv| + |vV|) > 0.5` で偽になるため、**`sampleByApsidal` は理論上も実測上も一度も発火しない**。計装コピーで計測した結果、GTO 0.5 ヶ月（262,980 評価）・ISS 0.2 ヶ月（105,192 評価）・Lunar 1 ヶ月（525,960 評価）のすべてで条件成立 0 回・発火 0 回だった。L624 の再代入は冗長コード。
- **修正方針**:
  - サンプリング判定用に別変数（例: `prevSampleLoopVv`）を設けて更新をループ末尾 1 箇所にまとめる。または L534 の上書き前に `const apsidalCrossed = prevVv * vV <= 0 && ...` を算出しておく。
  - 冗長な L624 を削除する。
  - GTO/Lunar 予測で遠近点サンプルが発生すること（> 0 件）と、1200 s で 500 点超・36 ヶ月で 3000 点以下を維持することを再計測する。

#### G2-04 [Major] 新トリガ `vel` の横展開漏れ：`hasPendingProfileBurns` が `vel` 行を認識せず、コースト後の `vel` 再点火が恒久 MECO（推進剤破棄）に化ける
- **箇所**: `scripts/gravsim_calc_object.js:1259-1270`（`CalcRocket.flightControl` 内の `hasPendingProfileBurns`。`time`/`alt`/`apogee` のみ判定）
- **現象**: 設計 Rev 6 L215 は「`vel` を全経路へ貫通」と定めている。しかし、最終段で軌道が閉じた状態（`peKm >= ORBITAL_CUTOFF_CIRCULAR_MIN_PE_KM`）で推力 0 行によるコーストが指令されたとき、後続の推力行が `vel` トリガだと「保留中の燃焼なし」と判定される。その結果 `STG_COAST`（推進剤保持）ではなく `STG_MECO`（`burnTime = 0`）へ遷移する。t12 で再現：後続行が `time`/`alt` なら `STG_COAST`・`burnTime 600`、`vel` なら **`STG_MECO`・`burnTime 0`**。
- **修正方針**:
  - `curVel = Math.hypot(tm.vV, tm.vH)` を用いて `step.type === 'vel' && step.value > curVel` を追加する。
  - 望ましくは、トリガ種別の分岐を `FlightComputer` 側の単一ヘルパ（例: `hasPendingBurn()`。`_isStepTriggered` を再利用）へ集約し、重複する分岐（`flight_computer.js:73-79/160-167`、`calc_predictor.js:545-550`、本箇所）を SSOT 化する。

#### G2-05 [Minor] `rlFuelType` 変更時の TWR 保護処理が 10000 kN 上限で推力を下げてしまう（F5-05／Rev 6 L271 の不完全な適用）
- **箇所**: `scripts/gravsim_tab_rocket.js:222-224`（`rlFuelType` の change ハンドラ内 `stg.thrustKN = Math.min(Math.max(stg.thrustKN, minThrustKN), 10000)`）
- **現象**: スライダの動的 `max` 同期（`_syncThrustSlider`）は 3 箇所に入った。しかし本箇所の上限クランプは `10000` 固定のままである。このため、もともと 10000 kN を超える第 1 段推力が、TWR 保護処理によって逆に引き下げられる。t15 で再現：`h3_24` LEO（11500 kN）が燃料種を `hydro` から `methane` に変えると 10000 kN に、`h3_24` Solar（深宇宙サイジング後 17107 kN）も 10000 kN に低下し、TWR が 1 を割り込む。
- **修正方針**: 上限を `Math.max(10000, Math.ceil(stg.thrustKN))`（F5-05 で指定）に変更し、`_syncThrustSlider` と整合させる。境界（9999/10000/10001 kN、`minThrustKN` > 現推力 > 10000 kN）をテストで固定する。

#### G2-06 [Minor] 不要・冗長コード、SSOT と乖離した重複値の残存（§3.2）
- **箇所と現象**:
  1. `scripts/gravsim_utils.js:195-201, 237-240`（`normalizeRocketConfig`）: 新規追加の出力 `disableOrbitalCutoff`/`targetApogeeKm`/`targetPerigeeKm`/`targetVInfKmS`/`flightProfile` は、唯一の呼出元 `CalcRocket`（`gravsim_calc_object.js:241-256`）が入力にも渡さず出力も読まない（読むのは `stages/boosters/payload/fairing/colorTheme` のみ）。デッドコードである。
  2. `scripts/gravsim_calc.js:684-702`（`determineOptimalSubSteps` のフォールバック値）: `SIMULATION.SUB_STEPS` は常に定義されているため到達不能。しかも追加した値が SSOT と乖離している（`MIN_SURFACE_DIST 1000`（SSOT 1.0）、`VELOCITY_EPSILON 10`（1e-3）、`MIN_TINY_ACCEL 1e-4`（1e-3）、`ACCEL_VEL_OFFSET 100`（10）、`ATM_VEL_OFFSET 50`（1）、`ROCKET_POWERED_MAX_DT 0.25`（0.5）、`TIME_SCALE_BASE_CAP 1e7`（10）、`BODY_COUNT_THRESHOLD 25`（50）、`BODY_COUNT_MIN_MULT 0.3`（2））。万一使われた場合は挙動が乖離する。
  3. `scripts/gravsim_rocket_renderer.js:76, 95, 102, 107, 111, 122`（`_computeVisualLayout` の戻り値 `totalLength`）: どこからも読まれない（利用側は `L = xMax - xMin` を自前で算出している）。
  4. `scripts/gravsim_preset_manager.js:609-612, 890-896`: JSDoc ブロックの重複（説明ブロックと `@param` ブロックが分離）。
- **修正方針**:
  - (1) と (3) は削除する。
  - (2) は既定値を単一の凍結定数（例: `SIMULATION.SUB_STEPS` 自体を `Object.freeze` して参照、または `DEFAULT_SUB_STEPS` を共有）にして重複リテラルを廃止する。フォールバック自体を不要とするなら設計補遺のうえで削除する。
  - (4) は 1 ブロックに統合する。

#### G2-07 [Minor] save/load 復元の欠落（「`CalcRocket` 完全復元」の未達。設計補遺が必要）
- **箇所**: `scripts/gravsim_object_manager.js:452-505`（`getState`）、`:72-75`（`addObject` の DEBRIS 分岐が `debrisSubType` を Worker へ送らない）、`scripts/gravsim_calc.js:48-92`（`PhysicsEngine.addObject` の転送。`mach/rcs*` は未転送）、`scripts/gravsim_calc_object.js:320-382`（`FlightComputer` は常に新規生成）
- **現象**:
  1. `FlightComputer` の実行時状態（`flightTime`, `_highestStepIndex`, `_triggeredActionIndices`, `hasPassedApogee/apogeeTime`）、`boosterBurnTimer/boosterSepTimer`、`presState`/タンク圧が保存されない。
  2. その結果、ロード後は `time`/`apogee` トリガのプロファイルが 0 s から再評価され、SRB 燃焼が経過時間分延長される。t6：`time` トリガのプロファイルを 150 s 時点で保存・ロードすると Ap が 238 km から 2,780 km に変化。t5：`h3_22` を 30 s 時点で保存・ロードすると Pe が 143 km から 176 km に変化。
  3. ロード後の Worker 側デブリの `debrisSubType` がすべて 0 になる（保存元 4,4,3,3,1）。
- **修正方針**:
  - 復元対象に `FlightComputer` 状態とブースタタイマを追加する（設計の F5-04 表を補遺）。または「ロード時に時間系トリガを再基準化する」等の受容挙動を設計で明記する。
  - DEBRIS 生成時に `debrisSubType` を Worker へ転送する。
  - WP2 列挙の `mach/rcs*` は過渡値のため非転送で可、と設計に明記する。

#### G2-08 [Minor] 遷音速ベル関数の設計式と設計注記の不整合（境界不連続）
- **箇所**: `scripts/gravsim_utils.js:298-318`（`AeroUtils.computeVaporConeParams`）。設計 Rev 6 L177-179 の式をそのまま実装している。
- **現象**: `TRANSONIC_PEAK_MACH 1.00`・`halfSpan 0.20` のため、smoothstep の零点は Mach **0.80/1.20** であり、注記の「0 at 0.82/1.22」と一致しない。実測では Mach 0.8199 で 0、**0.82 で強度 0.028（`active: true`）へ不連続に立ち上がり**、1.20〜1.22 は不感帯だった。
- **修正方針**: 中心を `(MIN+MAX)/2 = 1.02` にするか、範囲を 0.80/1.20 に揃えるかを設計で確定してから実装を合わせる。工程 3 の境界値テスト（0.8199/0.82/1.0/1.2/1.22）の期待値を先に決めること。

#### G2-09 [Minor] 主スレッド独自の自転積分が `PadEffectRenderer` に残存（要件 1-1 の SSOT 化の横展開漏れ）
- **箇所**: `scripts/gravsim_pad_effect.js:362-376`（`PadEffectRenderer.update`。リフトオフ後に `omega * scaledDt` を積分）
- **現象**: 惑星の `rotationAngle` は Worker 由来（SSOT）に変わった一方、パッド位置は主スレッドの `scaledDt` で独自に積分している。削除済みの `Universe` 旧ループと同型であり、フレームクランプ（`MAX_FRAME_ELAPSED_MS`）、タイムスケール変更、一時停止時に地表とパッド塔の位相がずれ得る。表示は高度 3 km（`EFFECT_STOP_ALT_M`）未満の短時間に限られる。
- **修正方針**: リフトオフ時点の `host.rotationAngle` を記録し、`host.rotationAngle` の差分でパッド位置と角度を回転させる方式に置き換える。

#### G2-10 [Minor] 設計記述「0.2〜36 ヶ月完走」が地球近傍ミッションで不成立（既存制約。設計の訂正または実装対応が必要）
- **箇所**: `scripts/gravsim_calc_predictor.js:158-160`（`computedMaxSteps = Math.max(100000, Math.ceil(maxSimTime / 5))`）と近地点付近の dt 0.1 s
- **現象**: 地球近傍では予測がステップ予算で打ち切られる（t7）。ISS 0.2 ヶ月は 1478 点・到達率 1.86%（約 9,780 s）、1 ヶ月は 1.97%、3 ヶ月は 1.99%、GTO 0.5 ヶ月は 7.86% だった。main も 1.86%/1.24%/0.41% で既存制約だが、設計 Rev 6 要件 1-3 は「0.2〜36 ヶ月完走」と記載している。
- **修正方針**: dt を考慮したステップ予算（例: `maxSimTime / 最小 dt` の上限付き算出、または軌道周期ベースの dt 拡大）を実装するか、設計の適用範囲を「深宇宙」に訂正する。工程 3 で到達率をアサートする前に確定すること。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| truthy な `stageState` による復元推定（G2-01） | `CalcRocket` の生成元は `PhysicsEngine.addObject`（Worker 側 add。rollout・slingshot・loadState の全経路が `_buildRocketPayload` を通る）と `runMultiBodySimulation`（`stageState` なしのため `_activateStage(0)`）の 2 箇所。主スレッドの `Rocket` 既定値（`gravsim_object.js:303`）により前者は全件が復元分岐に入る。 | **要**（判定を `restoredRuntimeState === true` に一本化。`getState`/`loadState`/`_buildRocketPayload` も修正） |
| `placeObject` による参照代入（G2-02） | `gravsim_object_placer.js:121-147` で `flightProfile/stages/payload/fairing/boosters/rendering` の 6 項目を参照代入。主スレッド側の書込元は `_applyRocketState`（`fairing.isSeparated`、新規）と RocketTab の各スライダ・プロファイル表（`rl.stages[i]`/`rl.payload`/`rl.fairing`/`rl.flightProfile[i]` をその場で更新）。`ObjectManager.loadState` は JSON 由来の新規オブジェクトのため問題なし。 | **要**（rollout 時に 6 項目をディープコピー） |
| ループ内の「前回値」変数が使用前に上書きされるパターン（G2-03） | `calc_predictor.js` の `prev*` 系を全数確認。`prevStageIndex`/`prevStg2Sep`/`prevPayloadSep`/`prevSampledBurning`/`lastStageState` は使用後に更新されており正常。`prevVv` のみ使用前に上書き（L534 → L599）。`FlightComputer._prevVv` は使用後に更新しており正常。 | **要**（`prevVv` のみ） |
| トリガ種別分岐（`time/alt/vel/apogee`）（G2-04） | `FlightComputer._isStepTriggered`（✓）、補間 `currentVal`（✓）、予測側 `eventRules`（✓）、RocketTab の `<select>`（✓）、`_adaptFlightProfileForVehicle`（`alt` のみスケール。`vel` は意図的に非スケールで ✓）、**`CalcRocket.hasPendingProfileBurns`（✗）**。 | **要**（1 箇所。分岐の SSOT 化を推奨） |
| 10000 kN 固定上限（G2-05） | `gravsim_tab_rocket.js` 内の `10000` は L223 のクランプ（✗）と `_syncThrustSlider`（✓、`Math.max(10000, …)`）。`index.html:473` の静的 `max="10000"` は動的同期で上書きされ ✓。`preset_manager` の 10000 は設計式どおり ✓。 | **要**（L223 のみ） |
| 主スレッド独自の自転・角度積分（G2-09） | `Universe` 旧ループは削除済み ✓。`gravsim_pad_effect.js:362-376` が角度を積分（✗）。`rocket_launcher.js:310`、`flight_computer.js:301`、`trajectory_predictor.js:104` は `omega` を速度計算に使うのみで角度積分ではない（✓）。 | **要**（pad_effect のみ） |
| 先減算精密式（ホスト差分 → ローカル加算） | `trajectory_predictor.js`（予測線・実軌跡・イベントマーカー）と `trail_renderer.js:236-237` は適用済み ✓。`visual_effect_manager.js:128`、`pad_effect.js:596, 752` はローカルオフセット加算のない単一減算で精度問題なし。 | 不要 |
| `WorkerBridge` のスロット上書きと共有 `_cache` | NaN 汚染プールで全 51 スロットの上書きを確認 ✓。`_cache` は全種別で共有され、ロケット固有キーが後続の天体・デブリへ残留するが、読むのはロケットの `_applyRocketState` だけ。 | 不要（Watchpoint 6） |
| 復元時の転送項目（G2-07） | `PhysicsEngine.addObject` のロケット 10 項目 ✓（`mach/rcs*` は過渡値で未転送）、CELESTIAL の `rotationAngle/param` ✓、**DEBRIS の `debrisSubType` 未転送（✗）**、`FlightComputer` とブースタタイマは未保存（✗）。 | **要**（軽微。設計補遺とあわせて対応） |
| `normalizeRocketConfig` 新規出力の利用者（G2-06） | 呼出元は `CalcRocket`（L241）とテスト（`01_core_physics`、`02_rocket_guidance`）のみ。新規 5 フィールドの読み手は 0 件。 | **要**（削除） |
| デッドコード 3 群 | `COLOR_ORBIT`/`COLOR_FALL`/`CALC_SUB_STEPS_BASE`/`CALC_SUB_STEPS_MAX`/`ORBIT_HORIZONTAL_VEL_MIN_M_S`/`TOWER_CLEARANCE_MIN_Q`/`tmPayloadSeparated`/`tmBurnTime` の参照は `scripts/` `testsuites/` `index.html` で 0 件 ✓。重複 `render()` 削除 ✓（`render` は L322 の 1 定義のみ）。`Universe` 旧ループ削除 ✓。 | 不要 |
| ホールドダウン時の `_updateFinalVelocity` スキップ（設計 L67） | `_updateFinalVelocity` は `isHoldDown` をスキップしないが、直後の `_updateHoldDownPositions(0)` で位置・速度を上書き再同期しており、最終状態は等価。 | 不要（等価のため許容。設計表記との差は記録のみ） |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **差し戻し後の再監査（独立監査2 Iteration 2）の要件**:
   - G2-01〜G2-10 の修正と横展開の後、`engine.addObject()` 直呼びではなく**実経路**（`applyToLauncher` → `rollout` → `ObjectPlacer` → `ObjectManager` → `PhysicsEngine` → `WorkerBridge` → `ObjectManager`）で、全ミッションの非墜落・同期・save/load を再計測すること。`07_preset_orbit_insertion.test.mjs` の直呼び方式では G2-01/G2-02 は検出できない。
   - 再計測と同時に、機械的チェック 3 種のエラー 0 件と既存テスト 332 件全パスを再確認すること。
2. **工程 3 で固定すべき回帰テスト**:
   - rollout 経由の `CalcRocket` 初期状態が `_activateStage(0)` 参照値と一致すること。
   - スリングショット機の第 1 段推進が有効であること。
   - 2 回目ロールアウト時にフェアリングが未分離であること。
   - リフトオフ後のランチャー編集が飛行中機の `getState` に影響しないこと。
   - GTO/Lunar 予測で遠近点サンプルが 1 件以上発生すること。
   - コースト行の後に `vel` 再点火行があると `STG_COAST` になること。
   - `rlFuelType` 変更時に推力が 10000 kN 超を維持すること。
   - 遷音速ベル関数の境界値（G2-08 で確定した期待値）。
3. **地球近傍の物理マージン（既存。main と同値）**:
   - 実経路（プリセット Earth 半径 6378 km）では `ssto` の LEO 近地点が約 **133 km** で、`07` テストと Gate 1 の受入基準 `pe >= 140`（テスト用 Earth 半径 6371 km では 141 km）を下回る。
   - `h3_22` の ISS/LEO は dt ≤ 0.05 s で Pe 140.3〜141.6 km と基準ぎりぎり。
   - テストは実プリセットと dt を明示し、受入基準を設計で確定すること。
4. **自走ペイロードの V∞**: `mmx` は分離後に自身の推進で即時再点火し、F5-03 #4 により `targetVInfKmS` カットオフの対象外となる。そのため Mars 予定 3.3 km/s に対し V∞ が 6.25〜6.47 km/s になる。`falcon9` の Jupiter は 5.36 km/s（目標 9.0）。これらの構成で V∞ の目標到達をアサートしないこと。仕様化する場合は設計で扱いを決めること。
5. **`AeroUtils` の温度モデルは地球基準**: 全天体で海面温度 288.15 K、γ = 1.4、R = 287.05 を使うため、Mars/Venus/Titan/Jupiter の地表音速はすべて 340.3 m/s になる。非地球天体のマッハ数・ベイパーコーンは近似である（設計レベルの制約として認識）。
6. **`WorkerBridge._cache` の共有**: ロケット固有キーが後続の非ロケットエントリにも残る。今後、非ロケット種別で `mach`/`rcs*`/`stageState` を読む処理を追加する場合はリセットが必要。
7. **`FlightComputer._highestStepIndex` の単調化**: 高度が下がってもプロファイル行は巻き戻らない（main からの挙動変更）。下降・再突入軌道のテスト期待値はラッチ挙動を前提にすること。
8. **ツールチェーンの再現性**: ESLint はシステムの v6.4.0（eslintrc 形式）、tsc は global の 7.0.2 で、`package.json` に devDependencies がない。ESLint v9 以降では `.eslintrc.json` と `--ext` が無効になるため、バージョンを固定するか手順を明記すること。`testsuites/` の lint 警告 54 件と、新規の `/** @type {any} */` 48 箇所は型品質上の負債として扱うこと。
9. **UI/E2E**: Trigger 列のラベルは `Alt(m)`/`Time(s)`/`Vel(m/s)`/`Apogee(s)` で、設計表記（`Alt (m)` 等）とは空白だけが異なる。E2E は `value` と `children[0..5]` の列順で検証し、320px サイドバーで `scrollWidth <= clientWidth` が成り立つことを実ブラウザで確認すること。


---

## 独立監査2: 実装監査 — Iteration 2

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 2
- **実施日時**: 2026-11-20 18:47 JST
- **判定**: **FAIL**（Major 1 件 / Minor 3 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（Iteration 1 以降の変更は `scripts/` 15 ファイルと設計書 §4 補遺 Rev 6.1）を、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1、Iteration 1 の指摘 G2-01〜G2-10 と Watchpoints とゼロベースで突合した。作業者の申告は前提にせず、Iteration 1 時点の作業ツリーのスナップショット（scratchpad `feat_tree/`）との差分を全行精読した。ソース・テスト・プリセット・設計書は無変更（`git status` が監査開始時と同一であることを確認）。

- **実経路ハーネスの強化**: Iteration 1 の `engine.addObject()` 直結ではなく、**実物の `Universe`（主スレッド）と実物の `SimulationController`（Worker 側）を、非同期・順序保証・structured clone のメッセージ路で接続**して駆動した。経路は `PresetManager.applyToLauncher` → `RocketLauncher.rollout` → `ObjectPlacer` → `ObjectManager.addObject/_buildRocketPayload` → `CalcWorkerManager.postMessage` → `SimulationController.handleMessage` → `PhysicsEngine` → `WorkerBridge` → `CalcWorkerManager.handleMessage` → `ObjectManager.updateObjectParams`。保存は `SaveManager.save` → `Universe.captureRuntimeSnapshot` → `requestRuntimeSnapshot` → Worker `snapshotRuntime` → `runtimeSnapshot` → `_writeSaveFile`（Blob の内容を捕捉）、読込は `Universe.loadState` の実経路で行った。
- 検証スクリプト一式: `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it2/`（`e2e.mjs`、`s1`〜`s10`。計装コピーは同ディレクトリの `inst_tree/`）。main 比較は `scratchpad/main_tree/`、Iteration 1 比較は `scratchpad/feat_tree/` を使用した。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件 `testsuites/`、`scripts/` は 0 件） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 1 指摘の解消確認**:

| ID | 判定 | 確認内容（実経路での実測） |
|---|---|---|
| G2-01 | ✓ 解消 | `CalcRocket` の分岐が `restoredRuntimeState === true` のみになった（`gravsim_calc_object.js:322`）。rollout 8 構成すべてで `restoredRuntimeState=false`・`runtimeState=null` が送られ、`_activateStage(0)` 参照値との差分は 23 項目で 0。`isStage2Separated=false` は両経路で初期化される。`hasPayloadPropulsion` は通常初期化で `undefined` のまま（`06` テストの契約を維持）。スリングショット機は main と同値（burn 240 s・fuel 34.3 t・dry 25 t・301.2 t・`STG_BURNING`）に戻り、20 s 後も燃焼が継続する。`getState` が `restoredRuntimeState: true` を出力し、`loadState` と `_buildRocketPayload` も契約どおりに転送する。 |
| G2-02 | ✓ 解消 | `placeObject` が 6 項目をディープコピーするようになった（`gravsim_object_placer.js:121-150`）。ランチャーとの共有参照は 0/6。リフトオフ後にランチャーの `stages[1].fuelMassT` と `flightProfile[3].angle` を編集しても、飛行中機の `getState` は元の値を保持する。2 機目は `fairing.isSeparated=false`・325.13 t で、1 機目と同値。 |
| G2-03 | ✓ 解消 | 厳密な符号交差の判定に変わり（`gravsim_calc_predictor.js:598`）、`prevVv` の更新はループ末尾の 1 箇所（`:632`）になった。外側ループに `continue` はない。計装で遠近点サンプルの発火を確認した（ISS 0.2 ヶ月 3 件、GTO 0.5 ヶ月 3 件、Lunar 1 ヶ月 2 件、LEO 3 ヶ月 5 件）。符号交差は約 2 回／周でノイズはない。1200 s で 1204〜1630 点、36 ヶ月でも 3000 点以下。 |
| G2-04 | ✓ 解消 | `getTriggerValue` と `hasPendingBurnStep` を SSOT 化した（`gravsim_flight_computer.js:74-106`）。`_isStepTriggered` と補間はこれを使う。後続行が `vel` トリガのケースは `STG_COAST`・burnTime 600 になった（Iteration 1 では `STG_MECO`・0）。`time`/`alt` のケースも同じ結果。 |
| G2-05 | ✓ 解消 | `h3_24` LEO は 11500 kN、Solar は 17107 kN を維持する。`THRUST_SLIDER_BASE_MAX_KN` は `_syncThrustSlider` と共用している。 |
| G2-06 | ✓ 解消 | 4 項目とも削除・統合済みで、残存する参照は 0。新設のフォールバック値（`sampling.X \|\| 0.12` など）は SSOT と全件一致する（main からの既存規約）。 |
| G2-07 | ✓ 解消（スナップショットあり） | 15 回の保存すべてで、Worker が 3 フレーム先行した状態でも、書出し時点の主スレッド `telemetry.flightTime`、Worker の値、スナップショットの値が一致した（例: 33.00/33.00/33.00）。FC 状態・ブースタタイマ・タンク圧は差分 0。時間トリガのプロファイルを 150 s 時点で保存した場合、+900 s 後の Ap は 235.6 km に対して復元側 243.1 km（Iteration 1 では 2,780 km）。`debrisSubType` は 5/5 一致。タイムアウト時の挙動は補遺 §4.7 のとおり（Watchpoint 1）。 |
| G2-08 | ✓ 解消 | 強度は Mach 0.8199/0.82/0.91/1.00/1.11/1.22/1.2201 → 0/0/0.5/1/0.5/0/0。`active` は `intensity > 0.01` で判定。§4.4 の期待値と一致する。 |
| G2-09 | ✓ 解消 | パッドの回転角は `host.rotationAngle` の差分と一致する（Worker 更新のない描画フレームでは回転 0、2π を跨ぐ場合も正しく追従）。NaN の場合は更新しない。 |
| G2-10 | △ 一部未解消 | 慣性系の隣接角度ステップは最大 0.120〜0.121 rad で、§4.3 保証 1〜3 を満たす。Iteration 1 時点のツリーにあった ISS/LEO/GTO 1〜36 ヶ月のジグザグ（1.9〜3.1 rad。作業者が自己申告した回帰）は解消した。**ただし描画座標系では保証が成立しておらず（G2-2-01）、補遺 §4.3 の Lunar の分類が実測と矛盾する（G2-2-03）**。 |

**補遺 Rev 6.1（§4）と実装・Rev 6 本文との突合**: §4.1・4.2・4.4〜4.9 は実装と一致し、Rev 6 本文の置換箇所（L83、L177-179、L283、F5-04 表）とも矛盾しない。プロトコルは §4.7 の記述どおりで、Worker の順序保証と update の同期適用により整合性が成り立つことを実測で確認した。§4.7 の入力検証は数値（有限性・非負・ステップ番号の範囲）に限られ、文字列項目は検証されない（Watchpoint 2）。§4.3 には G2-2-01 と G2-2-03 の不備がある。

**実地検証の結果（実経路、dt = 0.1 s × 10 サブステップ／フレーム）**:

| 項目 | 結果 |
|---|---|
| 飛行 15 構成（LEO×6、ISS×4、GTO、Lunar、Mars、Jupiter、Solar） | **墜落 0・同期不一致 0**（`stageState`, `stgTimer`, `mach`, `telemetry.mach`, `rcs*`, `isPayloadSeparated`, `currentStageIndex`, `hasPayloadPropulsion`, `fairing`, `flightTime`, Earth `rotationAngle` を毎フレーム比較）。軌道要素は Iteration 1 と同値（例: `h3_22` ISS Pe 142.6／Ap 434.3、GTO Ap 35,865.9、Lunar Ap 389,251.6、Solar V∞ 12.80）。 |
| save/load（スナップショットあり、15 時点） | 全件で継続飛行でき、墜落 0。差分は `hasPayloadPropulsion` の undefined→false（契約）、SRB 分離後の `isBoosterIgnited` true→false（実機側の値が古いまま残る既存挙動）、`ORBITAL_COAST` 中の `massLossRate` のみ。+900 s 後の差は ISS で Pe 0.8 km 以内、falcon9 で Pe 3.5 km 以内、Mars で V∞ 0.01 km/s 以内。 |
| save/load（スナップショットなし、Worker 無応答） | 2001〜2005 ms で `runtimeState: null` のまま保存され、15/15 件とも墜落なし。FC・ブースタタイマ・タンク圧は初期化される（§4.7 の「従来互換」）。時間トリガのプロファイルでは Ap が 235.6 km から 2,762.8 km に変わる。 |
| プロトコルの異常系 | 遅延応答（2.6 s）は 2003 ms で `null` に確定し、遅れて届いた応答は無視されて保留 Map は 0 件になる。保留中の `destroy()` は `null` を返す。不正な `rockets` は `[]` として扱われる。同時要求 2 件はどちらも正常に応答する。`console.error` は 0 件。 |
| 異常値の `runtimeState`（8 種類） | 例外 0。NaN・負値・型不正は 0／既定値に補正される。`highestStepIndex` 999 は 7 にクランプされ、インデックスは整数かつ範囲内のものだけ残る。配列・数値の `runtimeState` は無視される。ただし文字列項目と極大値には課題がある（Watchpoint 2）。 |
| 旧セーブ形式 | **main 形式のファイル（main ツリーで生成）は main と現行で完全に同じ状態に読み込まれる**（A/B 比較で確認）。フラグのないファイルは `_activateStage(0)` で読み込まれる（推定禁止の契約どおり）。フラグはあるが runtime がないファイルは、FC 状態なしで復元分岐に入る。 |
| パッド上（`PRE_LAUNCH`）での保存 → 読込 → 打上げ | 差分は `currentIsp` のみ（再計算される値）。打上げ後の軌道は Pe 142.6／Ap 434.3 で、保存なしの場合（142.4／433.9）と同等。 |
| スリングショット機の save/load | 全項目が一致し、+50 s 後の burn と fuel も一致する。 |
| 予測サンプラー（慣性系） | 1200 s：1204〜1630 点・到達率 100%。ISS/LEO/GTO は 1〜36 ヶ月で最大 0.120 rad（Iteration 1 ツリーでは 1.0〜3.1 rad、main では 0.020）、0.2 ヶ月で 1.6 周以上。深宇宙 3 ミッションは 12〜36 ヶ月で到達率 100%（2430〜2999 点）。重複点 0、時刻の非単調 0（main は打切り時に各 1 件）。 |
| 予測線（**描画座標系**、`phiSurf + host.rotationAngle`） | ISS/LEO/GTO/Lunar 1 ヶ月/Mars 1 ヶ月は 0.066〜0.146 rad で問題ない。**Mars 12 ヶ月、Jupiter 36 ヶ月、Solar 36 ヶ月（いずれもプリセット既定値）では、1 rad を超える隣接ステップがそれぞれ 1315/1354/1350 ペアあり、最大 1.75/3.00/2.90 rad**。main はすべて 0.019 rad（G2-2-01）。 |

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-2-01 [Major] 予測線は描画座標系（ホスト自転系）で大きくジグザグする：深宇宙 3 ミッションのプリセット既定期間で、隣接点ペアの 44〜54%（ホスト離脱後の区間ではほぼ全数）が 1 rad を超えて跳ぶ（要件 1「予測線のジグザグ防止」の不履行・main からの回帰）
- **箇所**:
  - `scripts/gravsim_trajectory_predictor.js:564, 579`（`TrajectoryPredictor.renderTrajectory` の `filterScreenPoints`。全点を `phiScreen = pt.phiSurf + currentHostRot` のホスト自転系で描画する）、`:689`（実飛行経路）、`:754`（イベントマーカー）
  - `scripts/gravsim_calc_predictor.js:366`（`curPhiSurf = curInertialPhi - (hostInitRot + curRotAngle)`）、`:568-611`（`runMultiBodySimulation` のサンプラー。`sampleByAngle`、`sampleByHeading`、`sampleByAngleCap` はすべて**慣性系**のホスト中心角で判定する）
  - 設計書 §4.3（保証 1 を慣性系の角度で定義している）
- **現象**:
  1. サンプラーと補遺 §4.3 の滑らかさ保証は慣性系の角度で定義されている。一方、描画は全点を地表固定の回転系に射影する。ホストを離脱した区間では時間ベースのサンプル間隔が約 23,000 s になり、地球自転で約 1.7 rad 回る。このため、描画上の隣接点はほぼ毎点 1〜3 rad 跳ぶ。
  2. 実測（s10、Sun+Earth、プリセット既定期間）:
     - `mars_transfer` 12 ヶ月: 1315/2964 ペアが 1 rad 超、最大 1.750 rad。高度 約 20 万 km（t ≈ 30,000 s）から始まる。
     - `jupiter_transfer` 36 ヶ月: 1354/2500 ペア、最大 3.002 rad。
     - `solar_escape` 36 ヶ月: 1350/2729 ペア、最大 2.901 rad。
     - `lunar_insertion` 12 ヶ月: 1019 ペア（G2-2-02 と複合）。
     - 予測線は地球周辺から放射状に交差する長大な弦の束として描かれる。main は約 3.3 万 s で打ち切られるため最大 0.019 rad で、顕在化していなかった。
  3. 射影の方式自体は main からの既存設計である。しかし、本ブランチが要件 1-3（36 ヶ月まで描画）で予測期間を延ばしたことで、プリセット既定の操作で必ず発生するようになった。Iteration 1 のツリーでも同値（Mars 12 ヶ月 1315 ペア、Jupiter 36 ヶ月 1354 ペア）で、Iteration 1 の監査では検出されなかった。
  4. flight モードでは `currentHostRot` が毎フレーム進むため、遠方の予測線全体が地球の自転とともに画面上で回転する。
- **修正方針**:
  - 予測線の**描画座標系**を設計補遺で確定する。推奨は、地表近傍（上昇中・大気圏内。`TrailRenderer` の `TRAIL_MODE.ATMOSPHERE` と同じ考え方）だけ地表固定系で描き、それ以外はホスト中心の慣性系（予測時点の自転角で固定。既存の `rotationOffset` 経路）で描く方式。予測器から点ごとに座標系フラグを出力し、切替点で連続になるようにする。
  - §4.3 の保証 1 を「描画座標系での隣接角度ステップ」として再定義し、サンプラーがその座標系で保証を満たすようにする。回転系のまま角度上限で保証する方式は、36 ヶ月で約 1,100 回転 × 約 52 点となり、`MAX_POINTS` 内では実現できない。
  - イベントマーカーと実飛行経路（`_recordActualFlightPath` も `r/phiSurf` を記録し、2 分の 1 間引きを行う）にも同じ判断を水平適用する。
  - 全 7 ミッション × 0.2〜36 ヶ月で、**描画座標系**の隣接ステップを再計測すること。

#### G2-2-02 [Minor] 予測器は機体の破壊後も計算を続け、凍結した残骸点の直線を予測線として出力する（既存の欠陥だが、本ブランチの到達率拡張で顕在化）
- **箇所**: `scripts/gravsim_calc_predictor.js:337`（主ループの条件）、`:381-392`（打切りは `minSurfaceDist <= 0` の場合だけ）。`scripts/gravsim_calc.js` の各積分ループは `collided/shattered` の物体をスキップする（`:487, 515, 550, 575`）ため、破壊された機体は慣性空間で静止する。
- **現象**:
  1. `lunar_insertion` を Sun+Earth の世界で 12 ヶ月予測すると、太陽摂動で近地点が下がり、t = 7,109,241 s に高度 78 km・10.7 km/s で動圧破壊される。その後の 24.4×10⁶ s 分のサンプルは、静止した破壊点から地球が離れていく直線（ホストに対し約 29.8 km/s、約 4.8 AU）になる。それでも到達率は 99.86% と報告され、IMPACT などのイベントは記録されない。36 ヶ月でも同じ。
  2. 上昇中の破壊でも同じ現象が起き、main でも再現する（既存）。例: 水平プロファイルの `h3_30` は 2,724 s 時点でホストから 86,105 km まで直線で離れていき、イベントは `pitch, maxq` のみ。main と現行で同値。
  3. 補遺 §4.3 の「月遷移は完走」という主張の一部は、この直線区間で成り立っているだけである（G2-2-03）。
- **修正方針**: 主ループで `rocket.collided || rocket.shattered` を検出したら、破壊イベント（`impact` 系または新しい種別）を登録して打ち切る。ループ外の最終点は破壊位置で 1 回だけ出力する。到達率の評価では、破壊以降の区間を到達とみなさない。上昇中の破壊、再突入中の破壊、地表衝突の 3 経路をテストで固定する。

#### G2-2-03 [Minor] 補遺 §4.3「完走範囲の訂正」の Lunar 遷移の分類が実測と矛盾する（G2-10 の確定が不十分で、工程 3 の到達率アサーションの前提として使えない）
- **箇所**: `docs/design/2026-11-20_trajectory_fx_flightplan.md` §4.3（「月遷移・深宇宙 3 ミッションに限る」「完走」）
- **現象**:
  - `lunar_insertion` の到達率は 0.2 ヶ月 56.77%（1525 点）、**1 ヶ月（プリセット既定値）70.74%**（2391 点）、3 ヶ月 76.41% で、ステップ予算 `max(MAX_STEPS, maxSimTime/5)` で打ち切られる。近地点通過のたびに dt 0.1 s のステップを消費するためである。
  - 12〜36 ヶ月の 99.8% 以上は、G2-2-02 の破壊後の直線で成り立っているだけである。Moon を含む 7 天体の世界でも、1 ヶ月の到達率は 69.5%。
  - 補遺 §4.3 の実測欄も、Lunar の到達率を記載していない。
- **修正方針**: §4.3 を訂正する。Lunar（高離心率の束縛軌道）を「ホスト近傍の閉軌道」と同じ保証区分に移すか、ステップ予算の設計を変更して完走させるかを確定する。G2-2-01 と G2-2-02 の修正後に、全 7 ミッション × 0.2〜36 ヶ月の到達率・点数・描画座標系の角度ステップを実測し直して、表として記載すること。

#### G2-2-04 [Minor] 同期予測（主スレッド）の計算時間が回帰：長期間を指定した地球近傍軌道では、ロールアウト時に UI が 5.8〜17 秒停止する（main は約 1.2 秒）
- **箇所**: `scripts/gravsim_rocket_launcher.js:602`（`rollout()` → `updatePredictionSync()`）、`scripts/gravsim_tab_rocket.js:992-993`（Rocket タブを開いたとき）、`scripts/gravsim_trajectory_predictor.js:298, 306`（`calculate` → `calculateSync` → `runMultiBodySimulation` を主スレッドで同期実行）
- **現象**:
  1. `MAX_ANGLE_STEP_RAD` が予算による間引きより優先されるため、地球近傍の閉軌道は約 29 周（LEO で約 157,000 s、約 158 万ステップ）を dt 0.1 s で積分してから 3000 点に達する。main は約 3.3 万 s・約 33 万ステップで点数予算に達していた。
  2. `rollout()` の同期ブロック時間（s6/s6b、Node v24、主スレッドで同期実行）:
     - 7 天体の世界でシステムタブのスライダから期間を指定した場合: LEO 3 ヶ月 **5,924 ms**（main 1,119 ms）、ISS 12 ヶ月 **5,768 ms**（main 1,199 ms）、Lunar 36 ヶ月 **17,172 ms**（main 1,181 ms）。
     - Sun+Earth の世界: LEO 3 ヶ月 3.9 s、GTO 36 ヶ月 5.2 s、Lunar 36 ヶ月 7.3 s（main はいずれも 0.76 s 以下）。
     - プリセット既定期間: 1.1〜1.4 倍（7 天体で Lunar 1 ヶ月 1,931 ms 対 1,381 ms、GTO 0.5 ヶ月 951 ms 対 829 ms）。
     - Iteration 1 のツリーは最大 42.8 s だったので、それよりは改善している。
  3. 深宇宙プリセット（36 ヶ月）は離脱軌道のため 0.3〜2.2 s に収まる（main 0.66〜1.8 s）。
- **修正方針**: 同期予測の計算コスト予算を設計補遺で確定し、次のいずれかで上限を設ける。
  - (a) ロールアウト時とタブを開いたときの予測を非同期 Worker 経路に移す。
  - (b) 同期経路だけステップ数または計算時間に上限を設ける。
  - (c) 推力予定なし・E < 0・近地点が大気圏外のホスト近傍周回は、N 周で打ち切る（上限角度の下では、それ以上周回させても描画情報は増えない）。
  - 主要構成で main 比の上限（例: 1.5 倍以内）を受入基準として計測する。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 慣性系でサンプルし回転系で描画する座標系の不一致（G2-2-01） | `renderTrajectory` の予測線（`:579`）、実飛行経路（`:689`）、イベントマーカー（`:754`）はすべて `phiSurf + currentHostRot`。`_recordActualFlightPath`（`gravsim_object.js:498-560`）は回転系の変位 5 m 以上で記録し、6000 点を超えると 2 分の 1 に間引く。このため長期飛行では回転系での点間隔が広がり得る（既存）。`TrailRenderer`（`:227-229`）は `TRAIL_MODE.ATMOSPHERE` のときだけ回転系を使う（妥当）。 | **要**（3 箇所を同一の設計判断で修正） |
| 破壊後も続くループ（G2-2-02） | 予測ループは継続する（✗）。`PhysicsEngine` が破壊済み物体をスキップするのは設計どおり。実機の `Rocket.draw` は `!isDestroyed` で予測線を非表示にする（✓）。`PredictorPhysicsEngine._updateFlightControl` も破壊済み機体を除外している（✓）。 | **要**（予測ループのみ） |
| 主スレッドでの同期重計算（G2-2-04） | `updatePredictionSync` の呼出元は `rollout()`（L602）と `RocketTab`（L992）。`TrajectoryPredictor.calculate()` も、初回や Worker 不在時に `calculateSync` へフォールバックする（L298）。非同期の Worker 経路は問題ない。 | **要**（3 経路） |
| 復元値の検証（§4.7） | `FlightComputer.restoreRuntimeState` と `CalcRocket.restoreRuntimeState` の数値は有限性・非負・範囲で補正される（✓）。文字列の `presState` と `pendingActions` は形式チェックのみ（✗）。極大の有限値（`flightTime = 1e308`）は Worker 側のタンク圧ノイズを NaN にする。 | 任意（Watchpoint 2） |
| 共有参照（G2-02 の型） | `placeObject` 内の残りの代入はすべてプリミティブ。`loadState` の入力は JSON 由来で共有なし。`_buildRocketPayload` の `boosters` は JSON コピー。Worker への送信は structured clone。 | 不要 |
| 使用前に上書きされる前回値（G2-03 の型） | `prevVv` のみ移動。外側ループに `continue` はなく、必ず更新される。他の `prev*` は Iteration 1 で確認済み。 | 不要 |
| トリガ種別の分岐（G2-04 の型） | `_isStepTriggered`、補間、`hasPendingBurnStep` は `getTriggerValue` に集約された（✓）。予測器の `eventRules` はイベント定義用の別の意味（`simTime` とテレメトリ速度）で、プロファイル行とは独立。 | 不要 |
| 定数のフォールバック値（G2-06 の型） | 本差分で追加・変更した `sampling.X \|\| 値` 16 箇所と、RCS の `?? 値` 2 箇所は SSOT と全件一致する。`SimulationController` の `?? 20/1200/40/0.90` は main からの既存で、値も一致する。 | 不要 |
| 主スレッドでの自転積分（G2-09 の型） | パッドエフェクトは修正済み。`rocket_launcher.js:310`、`flight_computer.js:360`、`trajectory_predictor.js:104` は omega を速度計算に使うだけ。 | 不要 |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **スナップショットなしで保存した場合の劣化**:
   - Worker が 2 s 以内に応答しないと、`restoredRuntimeState: true` かつ `runtimeState: null` で保存される。
   - その結果、読込後に FC の時刻・ラッチ・Max-Q・ブースタタイマが初期化され、`presState` は飛行中でも `ROLLOUT_FILL` → `UNPRESSURIZED` になる（タンク圧テレメトリが無加圧を表示する）。時間トリガのプロファイルでは結果が大きく変わる（Ap 235.6 → 2,762.8 km）。
   - 利用者への通知はない。テストでは両モードを分けて期待値を定めること。
2. **復元値の検証の残課題**（いずれも手編集したファイルでのみ起こる）:
   - `presState` は任意の文字列を受理する（例: `'HACKED'` が永続する）。
   - `pendingActions` はプロファイルに存在しない `sep_stage1` なども受理して実行する（実測では t = 40 s で分離し、動圧破壊した）。
   - `flightTime = 1e308` で Worker 側の `tankPresFuel` が NaN になる（主スレッドの表示は 0）。
   - 異常系・境界値テストの前に、許可値リスト・行に由来するアクションへの限定・有限上限の要否を決めること。
3. **フラグの非対称**:
   - `hasPayloadPropulsion` は通常初期化で `undefined`、復元時は `false`。
   - `isBoosterIgnited` は実機側で SRB 分離後も `true` のまま残り、復元すると `false` になる（既存・機能影響なし）。
   - save/load の一致テストでは、これらを真偽値として比較するか、除外を明記すること。
4. **旧形式の互換**: main 形式のファイルは main と同じ状態に読み込まれる。ただし、主スレッド側の `thrustForce` が古いまま保存されるため、2 段目の推進剤で 7250 kN の単段機になる既存挙動も main と同じになる。改善するかどうかは別途判断し、現状挙動をテストで固定すること。
5. **`SaveManager.save()` は Promise を返す**: テストでは `await` すること。`universe.destroy()` 後に保存が完了した場合でもファイルを書き出す（境界の挙動）。
6. **予測テストの測定座標系**: G2-2-01 の修正後は、角度ステップを**描画座標系**で測定すること（慣性系の `relX/relY` だけでは検出できない）。G2-2-02 の修正後は、破壊以降を到達率に含めないこと。
7. **Iteration 1 の Watchpoint 3〜9 は引き続き有効**: `ssto` の Pe 133 km、`mmx` の V∞、`AeroUtils` が地球基準である点、`_cache` の共有、ラッチの単調性、ツールチェーンのバージョン固定、Trigger 列ラベル。lint 警告 54 件（testsuites）と `/** @type {any} */` 50 箇所は型品質上の負債として残る。


---

## 独立監査2: 実装監査 — Iteration 3

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 3
- **実施日時**: 2026-11-20 19:28 JST
- **判定**: **FAIL**（Major 1 件 / Minor 2 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.2、Iteration 1〜2 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 2 時点のツリーのコピー（scratchpad `gate2_it2/inst_tree/`。計装は `gravsim_calc_predictor.js` のみ）と比較した。Iteration 2 以降に変更されたのは `scripts/` の 6 ファイルと設計書だけで、テスト・プリセット・`index.html`・`style.css` は変わっていない。6 ファイルは `gravsim_calc_predictor.js`、`gravsim_trajectory_predictor.js`、`gravsim_object.js`、`gravsim_calc_object.js`、`gravsim_flight_computer.js`、`gravsim_const.js`。差分は全行を読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。`git status` の内容は監査開始時と同じ。
- **描画座標系での計測**: Iteration 1 の Watchpoint 1 と Iteration 2 の Watchpoint 6 に従った。実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx（`moveTo`／`lineTo`／`quadraticCurveTo`／`arc` を記録）で呼び、描かれた座標を計測した。条件はズーム 1e9、canvas 1e13 px。
- **実経路での計測**: 実物の `Universe` と `SimulationController` をメッセージ路でつないだハーネス（Iteration 2 の `e2e.mjs`）で飛行させた。射点で 40 s のカウントダウンを挟み、`rocket:update-state` と `liftoff` を発行する。予測線は `Rocket.draw` と同じ引数で描いて計測した。
- **スクリプト**: 検証スクリプトは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it3/` に置いた（`v1`〜`v13`、ログ `*.log`）。
- **比較用ツリー**（いずれも scratchpad 内の作業用コピー）:
  - `gate2_it3/nosettle_tree/`: 打ち切りなしの比較用。`REVOLUTIONS=1e9`、`MAX_STEPS_CAP=2e7` に変更。
  - `gate2_it3/inst3/`: 遠近点サンプルの発火回数を数える計装コピー。
  - `scratchpad/main_tree/`: main との比較用。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/` の 16 ファイル。`scripts/` は 0 件） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 2 指摘の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-2-01 | △ プリセットでは解消、横展開に漏れ（G2-3-01） | **描画座標系の角度ステップ**: 7 ミッション × 0.2/1/3/12/36 ヶ月（Sun+Earth、打上げ方位 0°）で、描画上の隣接角度ステップは最大 0.120 rad。0.15 rad 超は 0 件。プレビューと飛行中（切替前後と終端付近を含む 7〜9 時刻、射点で 37 s 待機したあとに打ち上げる想定）の両方で同じ値になり、§4.3 表の点数・終了時刻・最大ステップを完全に再現した。方位 135°/270° と 6 天体ワールドでも 0.120 rad 以下。<br>**切替点の連続性**: 切替時刻の前後 0.5 s で描画線が動く量は ω×0.5 s×r の剛体回転分だけで、飛び（不連続）はない。切替後は、頂点の移動が浮動小数点誤差（≤ 1.8e-4 m）に収まる。<br>**イベントマーカー**: 線上からのずれは 2 m 以内（Mars 12/36 ヶ月の遠方 `ap` は弦の矢高で 361/3,038 km）。<br>**`rotatePrediction`**: 切替情報を保持したまま剛体回転し、描画のずれは 1.5e-8 m。<br>**実経路飛行**（LEO・ISS×2・GTO・Lunar・Mars。上昇は 1 s/フレーム、軌道投入後は 500 s/フレームの時間倍率で約 70 時間）: 機体と描画予測線の距離は LEO/ISS が 2.6〜3.6 km、GTO 28 km、Mars 67 km、Lunar 1,287 km（打上げ約 2.5 日後の遠方）。実飛行経路と予測線の差も同程度。切替後の頂点はフレーム間で固定され、移動は 2.5e-2 m 以下。<br>**未解消**: 軌道投入判定が遅れて成立する離脱軌道（G2-3-01）。 |
| G2-2-02 | ✓ 解消 | **上昇中の破壊**（水平プロファイル、1200 s／3 ヶ月）: `breakup`（t=47 s、高度 2 km）で終了した。<br>**再突入中の破壊**（vel カット 6800/7000/7200 m/s、`isOrbital=true`）: `breakup`（高度 55〜75 km）で終了した。<br>**鉛直ロフト**: `breakup`（高度 40 km）で終了した。<br>**月遷移**: 方位 135°/270° で 0.886/0.897×10⁶ s に `breakup` で終了した。<br>どの経路でも、最終点と破壊位置の差は 0.0 m で、破壊後の直線は描かれない。`breakup` は `id: 'breakup'`・`type: 'impact'` で記録され、軌道到達時の impact 抑止（`gravsim_calc_predictor.js:747-751`）の対象外であることを確認した。 |
| G2-2-03 | △ 一部未解消（G2-3-02） | §4.3 は `endReason` 方式に書き直され、実測表は打上げ方位 0° の Sun+Earth で全セル再現した。ただし、保証 4・5 は「全ミッション・全期間」とうたっているのに、方位と天体構成によっては成立しない。 |
| G2-2-04 | ✓ 解消 | **同期ブロック時間**（7 天体構成の `rollout()`、各 2 回）: 本ブランチ / main は次のとおり。§4.12 の表を再現し、受入基準（既定期間で main 比 1.5 倍以内、任意期間で 2 s 以内）を満たす。<br>・LEO 0.2 ヶ月: 215〜227 / 181〜183 ms<br>・Lunar 1 ヶ月: 1,453〜1,497 / 1,117〜1,128 ms（1.34 倍）<br>・GTO 0.5 ヶ月: 920〜929 / 793〜802 ms<br>・LEO 3 ヶ月: 700 / 1,073〜1,109 ms<br>・ISS 12 ヶ月: 690〜698 / 1,025〜1,035 ms<br>・Lunar 36 ヶ月: 1,464〜1,475 / 1,131〜1,140 ms<br>**安定周回の打ち切り条件**は、次のいずれでも早期に打ち切らなかった。<br>・再点火の予定（`disableOrbitalCutoff`、t=25,000 s で再点火）: `reignition_2` まで予測した。<br>・未到達の `sep_payload` 行: `step_budget` まで継続した。<br>・t=20,000 s の分離: 分離の 3 周後に `settled_orbit`（36,766 s）で終了した。<br>・自走ペイロード（mmx を 20,000 s で分離し、30,000 s に燃焼）: `payload_start` まで予測した。<br>・大気内に近地点がある軌道: `breakup` で終了した。<br>・再点火後に遠地点が 50,000 km を超える軌道: 打ち切らなかった。<br>**打ち切りの妥当性**: 7 天体の GTO/ISS について、打ち切らずに 7.5 日／1.8 日まで計算した結果と比べた。近地点・遠地点の変動は 392〜396／35,806〜35,816 km と 141／432 km の範囲に収まり、3 周で打ち切っても描画に影響しないことを確認した。<br>**`MAX_STEPS_CAP`**: 深宇宙 3 ミッションについて、6 天体ワールド（1/12/36 ヶ月 × 方位 4 通り × 月の位相 4 通り）と Sun+Earth（0.2〜36 ヶ月 × 方位 8 通り）で計測した。使用ステップは最大 102,160。上限 400,000 には一度も達しなかった（`step_budget` 0 件）。 |
| Iteration 2 WP2（復元値の検証） | ✓ 解消 | 実際の save → load 経路で次を確認した。<br>・`presState='HACKED'` は棄却され、初期値になった。`'DEPLETED'` は許可値なので受理された。<br>・プロファイルにない `pendingActions=['sep_stage1']` は除去された。<br>・action のない行の `triggeredActionIndices=[0,1,2]` は除去され、それに伴う `pendingActions` も除去された。<br>・`flightTime`／`apogeeTime`／`boosterBurnTimer` に `1e308` を与えると 1e10 に丸められ、`tankPresFuel=1e308` は 1000 kPa に、`presStartF=-5` は 0 に丸められた。<br>・上記のどの場合も +60 s 飛行して NaN は 0 件。<br>・FC 単体では、ラッチ済み 1 行に対する `pendingActions=['sep_payload','sep_payload','sep_stage1']` が `['sep_payload']` に絞られた。<br>・`hasAnyScheduledAction()` はラッチ前が true、ラッチ後が false。<br>・`TANK_PRESSURE_STATES` の 9 値は、コード中の全 `presState` 代入値と一致した。 |

**Iteration 1 指摘の回帰確認**:

| ID | 結果 |
|---|---|
| G2-01 / G2-02 | ✓ 回帰なし。8 構成で `restoredRuntimeState=false`、`_activateStage(0)` 参照値との差分なし。スリングショット機の諸元は main と同値（burn 240 s・301.2 t・`STG_BURNING`）。ランチャーとの共有参照は 0/6。2 機目のフェアリングは未分離・325.13 t。 |
| G2-03 | ✓ 回帰なし。計装コピーでの遠近点サンプルの発火回数は ISS 0.2 ヶ月 3、GTO 0.5 ヶ月 3、Lunar 1 ヶ月 2、LEO 3 ヶ月 5 で、Iteration 2 と同数。 |
| G2-04〜G2-09 | ✓ 回帰なし。該当ファイルは Iteration 2 以降変更されていない（`gravsim_flight_computer.js` は復元検証と `hasAnyScheduledAction` の追加のみ）。G2-06 の削除対象の参照は 0 件のまま。 |
| 実経路飛行 15 構成 | **墜落 0・同期不一致 0**。軌道要素は Iteration 2 と完全に一致した（`h3_22` ISS Pe 142.6／Ap 434.3、GTO Ap 35,865.9、Solar V∞ 12.80 など）。 |
| save/load（スナップショットあり、15 時点） | 全件で墜落 0。差分項目と +900 s 後の軌道要素は Iteration 2 と同じ。 |
| 旧セーブ形式 | main 形式のファイルは、main と本ブランチで完全に同じ状態に読み込まれる（A/B 比較）。 |

**補遺 §4（Rev 6.2 分）と実装の突合**:

- §4.3（終了理由・保証・実測表）: 実測表は再現する。ただし保証 4・5 の記述が過大（G2-3-02）。
- §4.7（復元値の検証）: 一致する。
- §4.10（予測線の描画座標系）:
  - 描画式（`frameRefRot`、切替前は地表固定系、切替後は一定角の慣性系、旧形式予測の扱い、イベントマーカー、実飛行経路の `time` 付与）は一致する。
  - ただし、切替点を `isOrbital` で決める規定が離脱軌道で破綻する（G2-3-01）。
  - 実飛行経路の記録判定が描画座標系に追従していない（G2-3-03）。
- §4.11（破壊時の打ち切り）: 一致する。
- §4.12（計算予算・安定周回の打ち切り・ステップ上限）: 一致する。条件の妥当性は上表のとおり。
- `maxSimTime` の意味の変更（`settled_orbit` では要求期間）: 利用箇所は `renderTrajectory` の飛行中消去判定（`gravsim_trajectory_predictor.js:537-538`）だけで、整合する。既存テスト（`02_rocket_guidance` の `currentFlightTime: 600 > maxSimTime 500`）も通る。
- Rev 6 本文との矛盾: なし（§4.3 で「0.2〜36 ヶ月完走」を明示的に撤回している）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-3-01 [Major] 軌道投入判定が遅れて成立する（または成立しない）離脱軌道で、描画座標系の切替が数日〜数週間遅れる。その間、予測線はホストの周りに数十回巻く渦巻きとして描かれ、飛行中は遠方の線全体がホストの自転とともに回る（G2-2-01 の横展開漏れ）
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:584-585`（`isOrbital` の判定。`orbit` イベントと同じ条件で、`vTangential >= 0.95 vCirc` かつ `vV > -50`）
  - `scripts/gravsim_calc_predictor.js:642-672`（`needsFrameSwitch = isOrbital && frameSwitchTime === null`。切替は `isOrbital` だけで決まる）
  - `scripts/gravsim_calc_predictor.js:636-638`（切替前の角度上限 `|ΔphiSurf|`）
  - `scripts/gravsim_trajectory_predictor.js:575-584`（`frameRefRot`。切替前は `currentHostRot` に追従する）
  - 設計書 §4.10「切替点」（L403）
- **現象**:
  1. 機首角を天頂から 30° 以下に抑えたプロファイル（RocketTab のフライトプラン表で設定できる直接上昇型の離脱）では、切替が大幅に遅れる。例: `h3_30+mmx`／`h3_24`／`falcon9` の深宇宙機で最大角 0〜30°。
     - `orbit` 判定は、接線速度が局所円軌道速度の 0.95 倍に届くまで成立しない。そのため、ホストから 8〜12 百万 km 離れた打上げ後 12.5〜23 日まで、座標系が切り替わらない。
     - 実測（`v8b_spiral.mjs`、Sun+Earth、12〜36 ヶ月）:

       | プロファイル（最大角） | 切替時刻 | 切替距離 |
       |---|---|---|
       | Mars 0° | 1,981,721 s（22.9 日） | 1,167 万 km |
       | Mars 20° | 15.4 日 | — |
       | Mars 25° | 15.1 日 | — |
       | Mars 30° | 1,325,130 s（15.3 日） | 842 万 km |
       | Jupiter 20° | 12.5 日 | 979 万 km |

     - 境界は 30° と 35° の間にある。35° と 40° では 0.2 時間以内に切り替わり、問題はない。
     - 全プリセットの組合せ（機体 6 × ミッション 7、既定ペイロード）では、切替が起きる 34 件はすべて 2,417 s 以内に切り替わる。切替なしの 8 件は、いずれも軌道に届かずに `breakup` で終わる構成である（`v12.log`）。この現象はプリセットの組合せでは起きない。
  2. 切替前の区間は地表固定系で描かれる。このため、慣性系では 0.01〜0.18 周しか回らない離脱経路が、描画上は **12.5〜23.0 周の渦巻き**になり、ホストから数百万 km まで巻きつく。
     - 角度上限 `|ΔphiSurf| ≤ 0.12 rad` が毎周約 52 点を強制するため、3,000 点のうち 1,758〜2,703 点がこの渦巻きに使われる。終了理由は `point_budget`（到達率 99.6〜99.9%）。
     - 角度ステップの保証 1 は満たすが、描かれる形は物理的に意味がない。
     - `ORBIT` マーカーも 800 万 km 以上離れた位置に描かれる。
  3. 飛行中、切替までの 12〜23 日間は、`frameRefRot = currentHostRot` のままである。そのため、遠方の線全体（切替後の慣性区間も含む）がホストの自転とともに回り続ける。
     - 10 分間での線の移動量は 700 万〜1,330 万 km。
     - これは G2-2-01 の現象 4（「飛行中は遠方の線全体が地球の自転とともに画面上で回転する」）そのもので、§4.10 の目標「飛行中の切替後は、遠方の線が宇宙空間に固定される」が、このクラスの軌道では達成されない。
  4. main は全点を地表固定系で描くため、同じ渦巻きが起きる（main の 45° プロファイルでは 196 周）。したがって回帰ではなく、Rev 6.2 の修正が軌道投入判定の早い軌道にしか効かないという適用範囲の漏れである。
- **修正方針**:
  - §4.10 の切替条件を「軌道投入」から「地表固定で描く意味がなくなった時点」に改める。
  - 例: 最初に次のいずれかを満たしたサンプルで切り替える。
    - `isOrbital`
    - 大気圏外（`ATM_LIMIT_ALT` か `ORBIT_MIN_ALT_M` の大きいほう）での `E ≥ 0`（ホスト離脱）
    - 燃焼終了後に、大気圏外を一定時間（例: 1 周回相当、またはホスト自転角で 0.5 rad 以上）飛行している
    - 例: ホスト中心距離が `DIST_THRESHOLDS_M.FAR` を超えた
  - 弾道飛行で地表に戻る軌道を地表固定系のまま描くかどうかも、あわせて設計で確定する。
  - 切替条件は予測器（サンプラーの角度上限）と描画の両方で同じ値を使う。
  - 次をテストで固定する。
    - 直接上昇型の離脱（最大角 0°／30°）で、切替が打上げ後 1 時間以内に起きること。
    - 切替前の描画上の巻き数が 1 周未満であること。
    - 飛行中に、切替後の頂点がフレーム間で固定されること。

#### G2-3-02 [Minor] §4.3 の保証 4・5 が「全ミッション・全期間」では成立しない。打上げ方位と天体構成によっては破れるため、工程 3 の到達率アサーションの前提として使えない
- **箇所**:
  - 設計書 §4.3「保証」4・5（L345-346）と実測表（打上げ方位 0°・Sun+Earth の 1 条件だけで計測している）
  - `scripts/gravsim_calc_predictor.js:613-641`（予算による間引き `hardBudgetFloorDt` より角度上限 `sampleByAngleCap` を優先する処理。点数予算が尽きると `point_budget` で終了する）
- **現象**（`v5b.log`、`v1_ang.log`、`v1_w7.log`）:
  1. **保証 4**（「深宇宙 3 ミッションは 0.2〜36 ヶ月の全期間で `horizon`（到達率 100%）」）: `mars_transfer`（`h3_30+mmx`）の 36 ヶ月では、打上げ方位 8 通りのうち 5 通り（90°/135°/180°/225°/270°）で `point_budget` になる（3,000 点、到達率 99.91〜99.98%）。方位 0° では、ちょうど 3,000 点で `horizon` に届いている（表の値）。点数予算の余裕がほぼない状態で保証している。Jupiter と Solar は全方位で `horizon`。
  2. **保証 5**（「月遷移は `step_budget` で打ち切られる…1 ヶ月以上で 1.5×10⁶ s 以上」）は、次の条件で破れる。
     - Sun+Earth・方位 135°／270°: 太陽の摂動で近地点が下がり、0.886×10⁶ s／0.897×10⁶ s に再突入して `breakup` で終了する（1 ヶ月と 36 ヶ月の両方）。破壊時の打ち切りが正しく働いた結果である。
     - Moon を含む 6 天体ワールド・方位 0°: `step_budget` で終了するが、到達時刻は 1,481,744 s で、1.5×10⁶ s に届かない。
  3. 工程 3 では、保証の文言どおりに「深宇宙は常に `horizon`」「月遷移は 1.5×10⁶ s 以上」とアサートすると、パラメータ化したテスト（方位・天体構成）が失敗する。
- **修正方針**:
  - 保証 4・5 を、成立条件（ワールド構成・打上げ方位）付きの記述に改める。
  - または実装を変更する。例: 深宇宙では、角度上限のサンプルを予算内に収めるための点数予約や、`MAX_ANGLE_STEP_RAD` を最終点まで守れる間引きの再設計を行う。
  - 保証 5 は「`step_budget` または `breakup`（摂動による再突入）」とする。あわせて、到達時刻の下限をどの天体構成で保証するのかを明記する。
  - 実測表に、方位と天体構成のばらつき（最小・最大）を加える。

#### G2-3-03 [Minor] 実飛行経路の記録判定が地表固定系のままである。描画は切替後に慣性系へ移ったため、静止軌道付近では記録が止まり、実飛行経路が弦 1 本で描かれる（§4.10 の水平適用漏れ。main からの回帰）
- **箇所**:
  - `scripts/gravsim_object.js:535-549`（`Rocket._recordActualFlightPath`。前回点との**地表固定系**での変位 `lastSurfX/curSurfX` が 5 m 以上のときだけ記録する）
  - `scripts/gravsim_trajectory_predictor.js:602-616`（`projectActual`。切替後の点は記録時の慣性オフセットで描く）
  - 設計書 §4.10「水平適用 実飛行経路」（L412）
- **現象**:
  1. 地表固定系でほとんど動かない軌道（静止軌道や準同期軌道）では、慣性系で大きく動いていても新しい点が記録されない。
  2. 単体再現（`v11_geo_actual.mjs`）: 半径 42,164 km の同期周回を 60 s フレームで 12 時間動かした。
     - 記録された点は **1 点**だけで、描画上は先頭点から現在位置までの弦 1 本（角度ステップ 3.14 rad）になった。
     - 同じ条件の LEO では 719 点が記録され、最大ステップは 0.067 rad。
  3. main は全点を地表固定系で描いていたため、静止軌道の機体は 1 点に留まるのが正しい表示だった。本ブランチでは、描画を慣性系に変えたのに記録判定を変えていないため、この不整合が新たに生じた。
  4. プリセット（GTO は遠地点でも地表固定系の速度が約 1.5 km/s ある）では顕在化しない。
- **修正方針**:
  - 記録の間引き判定を描画座標系にそろえる。例: 記録時の飛行時刻がその機体の予測の `frameSwitchTime` を過ぎていれば慣性オフセット（`relX/relY`）の変位で判定し、それ以前は地表固定系で判定する。または両方の変位の大きいほうで判定する。
  - 境界（同期軌道、切替直前・直後）をテストで固定する。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 描画座標系の切替条件が軌道投入判定に依存している（G2-3-01） | 切替を参照するのは次の 3 箇所で、いずれも予測器の `frameSwitchTime` だけを参照する。<br>・予測器の角度上限（`calc_predictor.js:636-638`）<br>・予測線とイベントマーカー（`projectPredicted`）<br>・実飛行経路（`projectActual`）<br>したがって、切替条件を変えれば 3 箇所に一括で効く。`TrailRenderer` は `TRAIL_MODE.ATMOSPHERE` による独自の判定で、切替とは無関係（変更不要）。`orbit` イベントの判定（`isOrbital`）自体は既存の仕様で、切替条件と分離すべきもの。 | **要**（切替条件を新設） |
| 計算に使う座標系と、判定・記録に使う座標系の不一致（G2-3-03） | 予測器のサンプラーは、切替前は `max(慣性, 地表)`、切替後は慣性で判定しており、描画と一致する（✓）。不一致は `_recordActualFlightPath` の記録判定（地表固定系のみ、✗）。`TrailRenderer` の記録・描画は同じモードを使う（✓）。 | **要**（`_recordActualFlightPath` のみ） |
| 保証値の条件依存（G2-3-02） | §4.3 の保証 1〜3 は、方位 0°/135°/270°、Sun+Earth と 6 天体ワールドで成立した（最大 0.120 rad、点数 3,000 以下、時刻の非単調 0、LEO/ISS 0.2 ヶ月で 1 周以上）。破れるのは保証 4・5 だけ。§4.12 の受入基準（同期ブロック時間）は 7 天体構成で成立する。 | **要**（保証 4・5 の記述） |
| 安定周回の打ち切り条件（再点火、分離、大気減衰、摂動、自走ペイロード） | `coastIsFinal` は次をすべて確認した（✓）。<br>・`ORBITAL_COAST` からは推進できない（FC のスロットルは 0 に固定。軌道カットオフ時に推進剤は破棄される）。<br>・`STG_COAST` は `hasPendingBurnStep()` で再点火の予定を検出する。<br>・`hasAnyScheduledAction()` で未ラッチのアクションを検出する。<br>・自走ペイロードは `STG_COAST` で保留燃焼を検出する。<br>大気の上限より上では抗力が 0（`gravsim_calc.js:443`）なので、近地点 ≥ `ATM_LIMIT_ALT` の条件と整合する。支配天体は最大加速度で決まるため、ホストが小天体の場合はヒル球の外で除外される。ただし月をホストにした場合の扱いは Watchpoint 2 を参照。 | 不要 |
| 破壊時の打ち切りとイベント抑止 | `breakup` は impact 抑止（`impactRule.id` の削除）の対象外であることを、`isOrbital=true` の再突入破壊 3 件で確認した（✓）。`updateRocketFlightEvents` は `type: 'impact'` として扱う（✓）。マーカーは赤い × 印で描かれる（✓）。 | 不要 |
| `maxSimTime` の意味の変更 | `scripts/` の利用箇所は `renderTrajectory:537` の 1 箇所だけ。Worker 経路（`_initWorker` の受信処理）も `endReason`/`steps`/`frameSwitch*`/`hostOmega` を転送する（✓）。 | 不要 |
| ステップ上限（`MAX_STEPS_CAP`） | 同期・非同期で同じ関数（`runMultiBodySimulation`）を使う（✓）。`options.maxSteps` を指定すると上限を超えられるが、本番コードから指定する経路はない（テスト専用）。深宇宙での最大使用ステップは 102,160。 | 不要 |
| 復元値の検証（§4.7） | FC と CalcRocket のすべての時間系フィールドが `RUNTIME_RESTORE_MAX_TIME_S` で丸められ、タンク圧 4 項目が `2 × MAX_SCALE_KPA` で丸められる。`presState` は許可値リストで、`pendingActions` はラッチ済み行の数を上限として受理する（✓）。`targetLaunchAngle`/`prevVv`/`maxRecordedQ` は有限性だけを検査する（実害なし）。 | 不要 |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **プリセット既定期間では安定周回で打ち切られない**:
   - 既定期間の LEO 0.2 ヶ月・ISS 0.3 ヶ月・GTO 0.5 ヶ月では、ステップ予算 `max(MAX_STEPS, maxSimTime/5)` が 3 周分に足りない。`step_budget` で終了し、終了時刻はそれぞれ 9,877 s／15,041 s／103,414 s。
   - そのため飛行中は、それぞれ 2.7／4.2／28.7 時間で予測線が消える。一方、ISS で 0.36 ヶ月、GTO で 0.6 ヶ月を指定すると `settled_orbit` になり、要求期間（11 日、18 日）のあいだ表示が続く。
   - 要求期間を少し延ばしただけで表示期間が数十倍に延びる非単調な挙動になる（消える挙動そのものは main と同じ）。
   - テストでは既定期間の `endReason` を `step_budget` として固定すること。改善する場合は、ステップ予算を「安定周回の判定に必要な周回数」以上にする案などを設計で検討すること。
2. **`SETTLED_ORBIT.MAX_APOAPSIS_ALT_M` は 50,000 km の絶対値で、ホストの大きさに依存しない**:
   - 月をホストにすると、月が支配天体となる範囲（中心距離 約 42,500 km 以内）で、地球の潮汐加速度は月の重力の最大約 2 割に達する（中心距離 40,000 km で 18%）。
   - 計測した月発射の構成（プリセット 3 種と、vel カット速度を変えたプロファイル 10 種）は、どれも 3 周に達する前に衝突するか `step_budget` で終わったため、打ち切りは起きなかった。しかし、3 周は安定していても後で衝突する月周回軌道があれば、要求期間のあいだ誤った安定軌道を表示し続ける。
   - ヒル半径に比例した上限にするか、地球以外のホストでの扱いを設計に明記すること。
3. **`runMultiBodySimulation` の早期 return**（`gravsim_calc_predictor.js:191`、ホスト不在時）は `endReason`/`steps`/`frameSwitchTime`/`frameSwitchHostRot`/`hostOmega` を返さない。§4.3 は結果に `endReason` を出力すると定めているため、異常系テストで期待値を決める前に、たとえば `endReason: 'no_host'` を返すかどうかを決めること。
4. **時間倍率が大きいときの実飛行経路**: 記録は 1 フレームに 1 回まで（既存）。500 s/フレームでは LEO の実飛行経路が 0.6 rad の弦になる。main の地表固定系描画でも同じ。予測線の保証（§4.3）の対象外であることをテストで明示すること。
5. **プレビューと上昇中の剛体回転**: §4.10 の仕様どおり、射点待機中と切替前の上昇中（プリセットで約 8〜40 分）は、深宇宙の予測線全体が射点とともに 1 日 1 回転する（遠方の線は 10 分間で 240 万〜760 万 km 動く）。E2E の描画テストでは、切替時刻の前後で期待値を分けること。
6. **軌道到達後に壊れずに衝突した場合のマーカー**: `isOrbital` のとき impact ルールのイベントを削除する処理（main からの既存）により、軌道投入後に壊れずに地表へ衝突した予測では、`endReason='impact'` なのに IMPACT マーカーが描かれない。一方、`breakup` は描かれる。この非対称を仕様として残すかどうかを決めてから、テストの期待値を定めること。
7. **描画座標系の計測方法**: × 印のマーカー（`type: 'impact'`。`breakup` を含む）は `moveTo`/`lineTo` で 2 本の線を描く。記録用 ctx で予測線の頂点を数えるときは、予測線の `stroke` だけを対象にすること（本監査の `v2_flight_frame.mjs` は `setLineDash` と `stroke` の単位で区別している）。
8. **Iteration 1・2 の Watchpoint は引き続き有効**: スナップショットなしで保存した場合の劣化、フラグの非対称、旧形式の `thrustForce`、`SaveManager.save()` の Promise、`ssto` の Pe 133 km、`mmx` の V∞、`AeroUtils` が地球基準である点、`_cache` の共有、ラッチの単調性、ツールチェーンのバージョン固定、Trigger 列のラベル。lint 警告 54 件（testsuites）は型品質上の負債として残る。

---

## 独立監査2: 実装監査 — Iteration 4

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 4
- **実施日時**: 2026-11-20 20:06 JST
- **判定**: **FAIL**（Major 1 件 / Minor 2 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.3、Iteration 1〜3 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 3 時点のツリーのコピー（scratchpad `gate2_it3/inst3/` と `gate2_it3/nosettle_tree/`。どちらも計装・定数変更は 1 ファイルのみなので、2 つを突き合わせて Iteration 3 の原本を復元した）と比較した。Iteration 3 以降に変更されたのは次の 3 ファイルと設計書だけで、テスト・プリセット・`package.json` は変わっていない。差分は全行を読んだ。
  - `scripts/gravsim_calc_predictor.js`: `MAX_STEPS` の既定値、ホスト不在時の戻り値（`endReason: 'no_host'` など）、座標系の切替条件の拡張、軌道到達時の impact 抑止の削除。
  - `scripts/gravsim_const.js`: `MAX_STEPS` 120,000、`FRAME_SWITCH.MAX_HOST_FIXED_ALT_M`、`SETTLED_ORBIT.REVOLUTIONS` 1。
  - `scripts/gravsim_object.js`: `Rocket._recordActualFlightPath` の記録判定。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。`git status --short` の内容は監査開始時と同じ（ハッシュ一致）。
- **描画座標系での計測**: Iteration 2 の Watchpoint 6 に従い、実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標を計測した（ズーム 1e9、canvas 1e13 px）。プレビューと飛行中（射点で 37 s 待機してから打ち上げる想定で、切替時刻の前後、終端付近、安定周回では終端後と要求期間の直前を含む 7〜9 時刻）の両方で測った。
- **実経路での計測**: Iteration 2 の `e2e.mjs`（実物の `Universe` と `SimulationController` をメッセージ路でつないだハーネス）と、Iteration 3 の `v2_flight_frame.mjs` を再実行した。
- **スクリプト**: 検証スクリプトとログは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it4/` に置いた（`a1`〜`a10`、`d1`、ログ `*.log`）。
- **比較用ツリー**（いずれも scratchpad 内の作業用コピー）:
  - `gate2_it4/nosettle_tree/`: 打ち切りなしの参照用。`REVOLUTIONS=1e9`、`MAX_STEPS`／`MAX_STEPS_CAP=2e7` に変更。
  - `gate2_it4/rev3_tree/`: 現行コードで `REVOLUTIONS=3` だけを戻したもの。
  - `gate2_it4/inst_tree/`: 安定周回の判定状態を記録する計装コピー。
  - `scratchpad/main_tree/`: main との比較用。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/`。`scripts/` は 0 件） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 3 指摘の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-3-01 | ✓ 解消 | **直接上昇型の離脱**（`a2_direct.mjs`、Sun+Earth、機首角の上限 0〜40°）: 切替は打上げ後 612〜678 s（高度 673〜2,563 km）に起きる。Iteration 3 では、最大角 30° 以下の構成で 12.5〜22.9 日だった（`falcon9` の 0°/25° は上昇中に破壊され、切替に至らない。Iteration 3 と同じ）。<br>・切替前の描画上の巻き数: 0.04 周以下（Iteration 3 は 12.5〜23.0 周）。<br>・終了理由: `horizon`、到達率 100%（Iteration 3 は `point_budget`）。<br>・切替後の頂点の移動（tsw+1 s と tsw+3600 s の比較）: 1.3e-8 km 以下で、宇宙空間に固定される。<br>**プリセットへの影響**: 機体 6 × ミッション 7 の全組合せで、切替時刻は Iteration 3 と 1 件も変わらない（`a3_combo.log` と Iteration 3 の `v12.log` を diff）。<br>**弾道飛行**（`a3_ballistic.mjs`、鉛直ロフト）:<br>・頂点 6,319 km: 切替は起きず、地表固定系で描かれる。BREAKUP マーカーは地表の真上（4.7 km、0.04°）。<br>・頂点 79,273 km: 高度 50,000 km（13,283 s）で切り替わる。飛行中、着地時刻に描かれるマーカーは実際の着地点と一致する（0.0 km）。プレビューでは ω ×（着地時刻 − 切替時刻）だけずれる。§4.10 の「許容」の記述どおり。<br>切替後は射点側の端も宇宙空間に固定される（§4.10 の仕様どおり）。 |
| G2-3-02 | ✓ 解消（記述は再現。1 箇所に不備: G2-4-02） | **§4.3 の実測表**（`a1_table.mjs`、Sun+Earth、方位 0°、0.2/1/3/12/36 ヶ月）: 全セルを再現した（点数・終了時刻・終了理由・描画上の最大角度ステップ）。プレビューと飛行中で同じ値。<br>**打上げ方位 8 通り × 7 ミッション × 0.2/0.3/0.5/1/3/12/36 ヶ月（392 件）**:<br>・保証 1・2 の違反 0 件（描画上の最大ステップ 0.120 rad、0.15 rad 超 0、点数 3,000 以下、時刻の非単調 0）。<br>・保証 3: LEO/ISS/GTO（表の機体）は全件 `settled_orbit`。切替後の描画は 1.00〜1.08 周。<br>・保証 4: 深宇宙 3 ミッションは全件 `horizon` か `point_budget`。到達率 99.91% 以上。<br>・保証 5: Lunar は `step_budget` か `breakup`。<br>・方位 8 通りの記述（Mars 36 ヶ月: 3 方位 `horizon`・5 方位 `point_budget`・99.91〜99.98%。Lunar 1 ヶ月: `step_budget` 17.27〜17.40 日・`breakup` 10.25〜10.39 日）も一致した。<br>**7 天体ワールド**（方位 4 通り × 6 期間、168 件）: 保証 1〜5 の違反 0 件。<br>**1200 s**: 全ミッションで `horizon`、1,122〜1,631 点。<br>ただし、安定周回の結論そのものが誤る場合がある（G2-4-01）。 |
| G2-3-03 | ✓ 解消 | **単体再現**（`a5_recorder.mjs`。半径 42,164 km の同期周回を 60 s フレームで 12 時間）:<br>・記録点: 719 点（Iteration 3 のツリーでは 1 点）。描画上の最大ステップ 0.004 rad（Iteration 3 は 3.14 rad）。<br>・LEO 相当: 719 点・0.067 rad で、Iteration 3 と同じ。<br>**境界**: t = 切替時刻ちょうどは地表固定系で判定し、t = 切替時刻 + 1e-6 s からは慣性系で判定する。描画側（`projectActual` の `pt.time > frameSwitchTime`）と一致する。<br>**途中で切り替わる場合**: 切替前は地表固定系、切替後は慣性系で記録される。描画は連続する（最大 0.004 rad）。<br>**予測を持たない機体**（スリングショット・ロード後）、`frameSwitchTime: null`、旧形式（フィールドなし）: 従来どおり地表固定系で判定する。これらの機体は `Rocket.draw` で実飛行経路を描かないため、表示への影響はない。<br>**慣性空間で静止した点**: 切替後は記録されない（正しい）。 |
| Iteration 3 WP1（既定期間で安定周回に届かない） | ✓ 解消 | LEO 0.2・ISS 0.3・GTO 0.5 ヶ月（既定値）は `settled_orbit` になった。実経路飛行（`v2_flight_frame.mjs`、約 70 時間）で、既定期間でも予測線が消えないことを確認した（Iteration 3 では 2.7／4.2／28.7 時間で消えた）。 |
| Iteration 3 WP2（月をホストにした安定周回） | ✗ **未対応のまま、`REVOLUTIONS` の変更で顕在化**（G2-4-01） | — |
| Iteration 3 WP3（ホスト不在時の戻り値） | ✓ 解消 | `endReason: 'no_host'`、`steps: 0`、`frameSwitchTime: null`、`frameSwitchHostRot: null`、`hostOmega: 0` を返す。§4.3 保証 2 の記述と一致する。 |
| Iteration 3 WP6（軌道到達後の衝突マーカー） | ✓ 解消 | 抑止処理は削除された。月面上空 150 km から 0.97 vCirc で周回させた場合（`a7b_impact_direct.mjs`。`isOrbital=true` のあと 2,216 s に地表衝突）:<br>・本ブランチ: `endReason='impact'` で、IMPACT イベントがあり、マーカーも描かれる。`updateRocketFlightEvents` は地表到達時に passed にする。<br>・main: 同じ条件で IMPACT イベントが消える。<br>392＋168 件の予測すべてで、`impact`／`impact_*` イベントの有無と `endReason === 'impact'` が一致した。 |

**Iteration 1・2 指摘の回帰確認**:

| ID | 結果 |
|---|---|
| G2-01 / G2-02 | ✓ 回帰なし。`s1_init_paths.mjs` の出力は Iteration 3 と完全に一致する（8 構成で `restoredRuntimeState=false`、`_activateStage(0)` 参照値との差分なし、共有参照 0/6、2 機目のフェアリング未分離）。 |
| G2-03〜G2-09 | ✓ 回帰なし。該当ファイル（`gravsim_flight_computer.js`、`gravsim_calc_object.js`、`gravsim_utils.js`、`gravsim_pad_effect.js`、`gravsim_tab_rocket.js`、`gravsim_object_placer.js`、`gravsim_object_manager.js`）は Iteration 3 以降変更されていない。予測器のサンプラーは切替判定以外変わっていない。 |
| G2-2-01〜G2-2-04 | ✓ 回帰なし。描画上の最大ステップは全件 0.120 rad 以下。破壊時は `breakup` で打ち切られる。同期ブロック時間は下表のとおり。 |
| 実経路飛行 15 構成（`s2_flights.mjs`） | **墜落 0・同期不一致 0**。出力は Iteration 3 と完全に一致する。 |
| save/load（スナップショットあり、15 時点。`s3_saveload.mjs`） | 全件で墜落 0。Iteration 3 との差分は保存処理の所要時間（0〜2 ms）だけ。 |
| スリングショット機の save/load（`s9`） | Iteration 3 と完全に一致する。 |
| 旧セーブ形式（`s8`、main 形式のファイル） | main と本ブランチで同じ状態に読み込まれ、+600 s 後も同値（Pe 181／Ap 11,581 km）。 |
| 実経路の描画（`v2_flight_frame.mjs`、8 構成・約 70 時間） | 機体と描画予測線の距離は LEO/ISS 2.6〜3.6 km、GTO 28.7 km、Mars 66.8 km、Lunar 1,287 km で、Iteration 3 と同等。切替後の頂点の移動はフレーム間で 2.5e-2 m 以下。 |

**同期ブロック時間**（7 天体ワールドの `rollout()`、各 2 回。`a4_rollout_timing.mjs`）。§4.12 の表を再現し、受入基準（既定期間で main 比 1.5 倍以内、任意期間で 2 s 以内）を満たす:

| 構成 | 本ブランチ | main |
|---|---|---|
| `leo_250km` 0.2 ヶ月（既定） | 179〜182 ms | 177〜184 ms |
| `lunar_insertion` 1 ヶ月（既定） | 1,439〜1,460 ms（1.28 倍） | 1,125〜1,142 ms |
| `gto_insertion` 0.5 ヶ月（既定） | 419〜427 ms | 784 ms |
| `leo_250km` 3 ヶ月 | 295〜306 ms | 1,070〜1,085 ms |
| `iss_rendezvous` 12 ヶ月 | 311〜316 ms | 1,023〜1,056 ms |
| `lunar_insertion` 36 ヶ月 | 1,471〜1,502 ms | 1,145〜1,146 ms |

**補遺 §4（Rev 6.3 分）と実装の突合**:

- §4.3（保証 1〜5・実測表・打上げ方位 8 通り・1200 s）: 実装・実測と一致する。保証 3 の対象機体は表の組合せに限られる（Watchpoint 2）。
- §4.10（切替条件の拡張）: 実装（`gravsim_calc_predictor.js:646-651`、`FRAME_SWITCH.MAX_HOST_FIXED_ALT_M`、大気上限の既定値）と一致する。高ロフトの着地点のずれも記述どおり。
- §4.10（飛行中の剛体回転の上限）: 「プリセットでは 0.05 rad 以下」が実測と合わない（G2-4-02）。
- §4.10（実飛行経路の記録判定）: 一致する。
- §4.11（衝突イベント抑止の削除）: 一致する。
- §4.12（周回数 1、`MAX_STEPS` 120,000、受入基準の実測）: 定数と表は一致する。ただし「不変の軌道は 1 周で描画内容が確定」の前提を、判定条件が保証していない（G2-4-01）。
- Rev 6 本文との矛盾: なし。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-4-01 [Major] 安定周回の判定が、第三天体の摂動で数日後に衝突する軌道を「安定」と判定する。その結果、要求期間いっぱい（既定 1 ヶ月）誤った閉軌道を表示し、IMPACT も表示しない。月をホストにした場合は `REVOLUTIONS` を 3 → 1 にしたことで新たに発生する（Iteration 3 Watchpoint 2 の顕在化）
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:687-718`（`runMultiBodySimulation` の安定周回の判定。`isSettled` は瞬時の接触軌道要素だけで判定する。近地点高度 ≥ 大気上限、遠地点高度 ≤ 50,000 km、`E < 0`、支配天体がホスト）
  - `scripts/gravsim_calc_predictor.js:766`（`settled_orbit` のとき `maxSimTime` を要求期間にする）
  - `scripts/gravsim_const.js:362-364`（`SETTLED_ORBIT.REVOLUTIONS: 1`、`MAX_APOAPSIS_ALT_M: 50000000`）
  - 設計書 §4.12（L429-434。「不変の軌道は 1 周で描画内容が確定」「これ以上周回させても描画情報は増えない」）、§4.3 保証 3
- **現象**:
  1. **月をホストにした場合**（Earth＋Moon のワールド。近月点高度 200 km、遠月点高度 8,000〜32,000 km、近月点の向き 8 通り、要求期間 1 ヶ月。`a8b_moon_settle_ab.mjs`）:
     - 本ブランチで `settled_orbit` になった 26 件のうち 12 件は、打ち切らない参照計算（`nosettle_tree`）では 2.90〜16.63 日後に月面へ衝突する。
     - 本ブランチの予測は 0.72〜1.70 日で打ち切られる。`maxSimTime` は 30.44 日で、飛行中は 30 日間、閉じた楕円の予測線を表示し続ける。IMPACT マーカーは出ない。
     - 遠月点 8,000 km の別の方位でも、参照計算では近月点が 5 km まで下がる。
  2. **月面からの打上げでも再現する**（`a8f_moon_launch_lowtwr.mjs`。月面の射点から単段機を打ち上げ、`vel` 行で停止させる。フライトコンピュータとプロファイルは実物）:
     - 16 件中 6 件で同じ現象が起きる。例: 停止速度 2,100 m/s・射点 90° の場合、本ブランチは 0.80 日で `settled_orbit` になり、30.44 日まで表示する。参照計算では 3.18 日に衝突する。
  3. **回帰の判定**（`a8d_cases.mjs`、`a8f_rev3_main.log`）:
     - 上記の 12 件と打上げ 4 件は、`REVOLUTIONS=3` のツリー（`rev3_tree`。他は現行と同じ）ではすべて `step_budget`（1.0〜1.8 日）で終わる。誤った安定判定は 0 件。
     - main は安定周回の打ち切りを持たないため、このような主張をしない。
     - したがって、月をホストにした場合は Iteration 4 の 3 → 1 の変更で新たに生じた。Iteration 3 の Watchpoint 2 は、この危険を指摘して設計での扱いを求めていたが、Rev 6.3 では対応されていない。
  4. **地球をホストにした場合も同じ原因で起きる**（`a8g_earth_settle_ab.mjs`。Earth＋Moon、近地点 110 km、遠地点 45,000 km、月に対する向き 8 通り）:
     - 2 件（90°/270°）で、0.57 日に `settled_orbit` になる。参照計算では、月の摂動で近地点が大気上限を割り、5.65／6.13 日に衝突する。
     - `REVOLUTIONS=3` でも同じ 2 件が誤判定される。こちらは Rev 6.2 からの欠陥で、Iteration 3 では GTO/ISS のプリセットだけを確認していたため検出していなかった。
     - プリセットの GTO（`h3_22` の近地点 117 km、`falcon9` の 154 km）は、7 天体ワールドで打ち切らずに 9.2〜10.1 日計算しても衝突しない（`a10_gto_nosettle_w7.log`）。§4.3 の表の構成では顕在化しない。
  5. 判定条件は 1 周の間の瞬時値しか見ない。そのため、近地点が大気上限（月は既定値 100 km）や地表に近く、第三天体の潮汐で近点高度が周回ごとに動く軌道を「不変」と誤認する。予測の主目的（衝突の予告）が損なわれ、しかも「要求期間まで有効」と表示されるため、利用者には誤りが分からない。
- **修正方針**:
  - 「不変」であることを判定条件で保証する。次のいずれか、または組合せを設計補遺で確定する。
    - (a) 連続する 2 周の接触軌道要素（近点高度・遠点高度・近点引数）の変化量に上限を設け、その範囲に収まったときだけ打ち切る。近点高度の余裕（例: 大気上限＋周回あたりの変化量 × 要求期間内の周回数）も判定に入れる。
    - (b) 第三天体の潮汐比 `max_k 2 μ_k r_apo³ / (μ_host d_k³)` に上限（例: 1e-5）を設けるか、遠点上限をヒル半径に比例させる。
    - (c) 打ち切る場合は、要求期間まで延長するのではなく、有効期間（例: 打ち切り時刻の数倍）を `maxSimTime` として返す。
  - 打ち切り後の表示期間を延長するのであれば、その期間内に近点高度が大気上限を割らないことを、何らかの根拠で保証すること。
  - Rev 6.3 の目的（既定期間で LEO/ISS/GTO を安定周回に到達させる、§4.12 の同期ブロック時間の受入基準）を維持できるかを再計測すること。
  - 次をテストで固定する。
    - 月ホストの衝突例（上記の 12 件のうち数件）が `settled_orbit` にならないこと。
    - 地球ホストの近地点 110 km・遠地点 45,000 km・月に対して 90° の例が `settled_orbit` にならないこと。
    - §4.3 表の LEO/ISS/GTO は従来どおり `settled_orbit` になること。

#### G2-4-02 [Minor] §4.10（Rev 6.3）の「飛行中の剛体回転量はプリセットでは 0.05 rad 以下」が実測と合わない。§4.3 の表にある ISS（`h3_22`）でも 0.138 rad で、工程 3 の E2E の期待値として使えない
- **箇所**: 設計書 §4.10 L417（「回転量は最大 `ω × frameSwitchTime`（プリセットでは 0.05 rad 以下）」）。関連する実装は `scripts/gravsim_trajectory_predictor.js:579-581`（`frameRefRot`）。
- **現象**（`a6_rigid.mjs`。飛行時刻 0 と切替直前で、描画された予測線の遠端の回転角を比較した）:
  - 実測値は `ω × frameSwitchTime` と一致する。上限の式自体は正しい。
  - ただし括弧内の数値が合わない。

    | 構成 | 切替時刻 | 回転量 | 遠端の移動 |
    |---|---|---|---|
    | `iss_rendezvous`（`h3_22`、§4.3 表の構成） | 1,888 s | **0.138 rad** | 898 km |
    | `iss_rendezvous`（`h3_24`／`h3_30`） | 2,417／2,275 s | **0.176／0.166 rad** | 1,149／1,081 km |
    | `leo_250km`（`falcon9`／`h3_22`） | 1,234／1,642 s | **0.090／0.120 rad** | 588／781 km |
    | `gto_insertion`（`h3_22`） | 793 s | **0.058 rad** | 379 km |

  - 0.05 rad 以下になるのは、切替が 686 s 以内に起きる構成だけ（LEO の `h3_30` 0.044、ISS の `falcon9` 0.035、GTO の `h3_24` 0.038、Lunar 0.036、Mars 0.035 rad など）。
  - §4.10 の切替条件の拡張（高度 50,000 km）により、プリセット外の高ロフトでは切替が 13,283 s になり、回転量は約 0.97 rad に達する（`a3_ballistic.mjs`）。
- **修正方針**:
  - 括弧内を実測値に改める。例: 「§4.3 表の構成では最大 0.14 rad（ISS）。機体の組合せによっては 0.18 rad」。
  - または数値の上限をやめて `ω × frameSwitchTime` だけを規定し、E2E では切替時刻から期待値を計算するよう明記する。

#### G2-4-03 [Minor] Rev 6.3 の変更の横展開漏れ: `REVOLUTIONS` のフォールバック値が SSOT と食い違い（G2-06 と同じ型の回帰）、切替条件のコメント 2 箇所が旧仕様のまま
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:344`（`settledSweepTargetRad = (settledCfg?.REVOLUTIONS || 3) * 2 * Math.PI`）
  - `scripts/gravsim_calc_predictor.js:336-337`（「The switch happens at the first sample at/after orbit insertion.」）
  - `scripts/gravsim_trajectory_predictor.js:571`（「points up to frameSwitchTime (orbit insertion) are drawn host-fixed」）
- **現象**:
  1. SSOT（`gravsim_const.js:363`）を 1 に変えたのに、フォールバック値は 3 のまま残っている。
     - Iteration 2 で、フォールバック値はすべて SSOT と一致させると確認している（G2-06 の横展開）。同じ関数の `MAX_STEPS || 120000` は今回更新されているのに、この 1 箇所だけが更新されていない。
     - 定数が定義されているため通常は到達しない。しかし工程 3 でカバレッジのためにこの分岐を通すテストを書くと、仕様と異なる 3 周の挙動を期待値として固定してしまう。
  2. 2 箇所のコメントは、切替を「軌道投入時」だけと説明しており、§4.10 Rev 6.3（`E ≥ 0`、高度 50,000 km）と食い違う。同じ関数の 646-647 行目のコメントは更新されている。
- **修正方針**:
  - フォールバックを `|| 1` にする。または、定数が必ず定義されることを前提にフォールバックを削除する。
  - 2 箇所のコメントを §4.10 の切替条件に合わせて更新する。
  - `scripts/` 内で、Rev 6.3 で変更した定数（`MAX_STEPS`、`REVOLUTIONS`、`FRAME_SWITCH`）の参照とコメントを再検索して確認すること。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 瞬時の軌道要素による「不変」判定（G2-4-01） | 安定周回の打ち切りは `runMultiBodySimulation` の 1 箇所だけ（同期・Worker 共通）。<br>判定に使う閾値は次の 3 つで、いずれもホストの大きさや第三天体の影響によらない固定値。<br>・`hostAtmLimitAltM`（月などの無大気天体では既定値 100 km）<br>・`MAX_APOAPSIS_ALT_M`（50,000 km）<br>・`isHostDominant`<br>地球ホストのプリセットで近地点が最も低い GTO の `h3_22`（117 km）と `falcon9`（154 km）を、7 天体ワールドで打ち切らずに 9〜10 日計算した範囲では、衝突は起きない。他のプリセット構成の近地点は 141 km 以上（LEO/ISS は遠地点も 473 km 以下、GTO の `h3_24`/`h3_30` は 357 km 以上）。Iteration 3 でも 7 天体の GTO/ISS を 7.5／1.8 日まで確認している。誤判定は、近点高度が閾値に近く遠点が高い軌道、または月のような小天体ホストで起きる。 | **要**（判定条件と表示期間の設計を補遺で確定） |
| 設計書の数値の主張と実測の不一致（G2-4-02） | Rev 6.3 で追加・変更された数値をすべて再計測した。§4.3 の実測表・方位 8 通り・1200 s の点数、§4.12 の同期ブロック時間、`ω × 着地時刻差` は一致した。不一致は §4.10 L417 の括弧内だけ。 | **要**（1 箇所） |
| SSOT とフォールバック値の不一致（G2-4-03） | `gravsim_calc_predictor.js`、`gravsim_trajectory_predictor.js`、`gravsim_object.js` の `<定数> \|\| 値`（数値または定数参照のもの）44 箇所を確認した。不一致は `REVOLUTIONS \|\| 3` の 1 箇所だけ。`MAX_STEPS \|\| 120000`、`MAX_STEPS_CAP \|\| 400000`、`FRAME_SWITCH?.MAX_HOST_FIXED_ALT_M \|\| DIST_THRESHOLDS_M.FAR`（50,000 km）、`ACTUAL_SAMPLE_MIN_DIST_M \|\| 5.0`、`ACTUAL_MAX_POINTS \|\| 6000` は一致する。`dtCfg.POST_BURNOUT_DURATION_S \|\| 120.0`（`DT` には定義がなく、常にフォールバックの 120 を使う）は main からの既存で、値は `SAMPLING` の 120 と同じ。 | **要**（1 箇所） |
| 切替条件の参照箇所（G2-3-01 の横展開） | 予測器が出力する `frameSwitchTime` を参照するのは次の 4 箇所で、条件の拡張は 4 箇所すべてに効く（✓）。<br>・サンプラーの角度上限<br>・`projectPredicted`（予測線とイベントマーカー）<br>・`projectActual`<br>・`_recordActualFlightPath` の記録判定（新規）<br>`TrailRenderer` は `TRAIL_MODE` による独自の判定で、無関係（変更不要）。`orbit` イベントの判定は切替条件と分離されたまま（✓）。旧仕様を説明するコメントが 2 箇所残る（G2-4-03）。 | 要（コメントのみ） |
| 記録と描画の座標系の一致（G2-3-03 の横展開） | 記録判定（`recTime > switchTime`）と描画（`pt.time > frameSwitchTime`）は同じ境界を使う（✓）。予測を持たない機体は実飛行経路を描かない（`Rocket.draw` の条件）。`predictedTrajectory` は離床時に 1 回だけ代入され、飛行中に差し替わらないため、記録済みの点と描画時の切替時刻がずれることはない（`gravsim_rocket_launcher.js:98-106, 648`）。 | 不要 |
| impact 抑止の削除の影響 | `prediction.events` の利用箇所は `updateRocketFlightEvents`、`renderTrajectory`、`rotatePrediction` の 3 つだけ（✓）。衝突検出は検出と同時にループを打ち切る 1 経路だけで、誤った衝突を作る経路はない（`getMinSurfaceDist` は天体だけを対象にする）。既存テストに、抑止を前提にしたものはない（`npm test` 全パス）。 | 不要 |
| ホスト不在時の戻り値 | 早期 return は `runMultiBodySimulation:191` の 1 箇所だけ。`_buildSimulationParams` はホストがないと `null` を返し、`calculateSync` も `null` を返す（✓）。Worker の受信処理は `maxSimTime: 0` を 1 年に置き換えるが、点が 0 なので描画には影響しない。 | 不要 |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G2-4-01 の修正は §4.12 の受入基準と両立させること**: 判定を厳しくすると、LEO/ISS/GTO の既定期間で再び `step_budget` になり、飛行中に予測線が消える問題（Iteration 3 の Watchpoint 1）が戻る可能性がある。修正後は §4.3 の表、方位 8 通り、7 天体ワールドの同期ブロック時間を再計測すること。
2. **保証 3 の対象は §4.3 の表の機体の組合せに限られる**（`a9_nontable.mjs`）。表にない組合せでは、次のように `settled_orbit` にならない。テストのパラメータ化では表の組合せを使うか、例外を明記すること。
   - `h3_22`＋`leo_250km`（既定ペイロード）は遠地点が 105,658 km になり、`step_budget`（1.68 日）で終わる。
   - `ssto`＋`iss_rendezvous` は地球を離脱して `horizon` になる。
   - `epsilon` は全ミッションで `breakup` になる。
3. **直接上昇型の離脱での ORBIT マーカー**: 切替は 1 時間以内に起きるようになった。しかし `orbit` イベント（`vTangential ≥ 0.95 vCirc`）は 12.5〜22.9 日後、地球から 800〜1,200 万 km の位置で成立し、その位置に ORBIT マーカーが描かれる（`a2.log`）。main は約 3.3 万 s で打ち切るため、表示されなかった。離脱軌道で `orbit` イベントを出すかどうかを決めてから、テストの期待値を定めること。
4. **「衝突イベント」の範囲**: §4.11 の「衝突イベントは `endReason === 'impact'` のときに限って存在する」は、`impact`／`impact_<id>` の id で判定すると成り立つ。一方、`breakup` イベントも `type: 'impact'` を持つ。テストでは type ではなく id で判定すること。
5. **無大気天体での安定周回の閾値**: 大気上限が未定義の天体（月など）では、近点高度の閾値が `ORBIT_MIN_ALT_M`（100 km）になる。近月点 40.9 km の安定した周回は `step_budget`（3.3 時間）で終わり、飛行中に予測線が消える（`a7b.log` の 0.985 vCirc、`a7c_minalt.mjs`）。§4.12 の仕様どおりだが、利用者から見ると非一貫なので、テストで期待値を固定すること。
6. **高ロフト弾道の着地点**: 切替後に再突入する弾道の着地マーカーは、プレビューでは地表上の位置から ω ×（着地時刻 − 切替時刻）だけずれる。飛行中、着地時刻に描かれる位置は実際の着地点と一致する。E2E では評価する時刻を明記すること。
7. **Iteration 3 の Watchpoint 4・5・7 は引き続き有効**: 時間倍率が大きいときの実飛行経路（500 s/フレームで 0.6 rad の弦）、切替前の剛体回転（G2-4-02 の数値で期待値を定めること）、記録用 ctx での計測方法。
8. **Iteration 1・2 の Watchpoint は引き続き有効**: スナップショットなしで保存した場合の劣化、フラグの非対称、旧形式の `thrustForce`、`SaveManager.save()` の Promise、`ssto` の Pe 133 km、`mmx` の V∞、`AeroUtils` が地球基準である点、`_cache` の共有、ラッチの単調性、ツールチェーンのバージョン固定、Trigger 列のラベル。lint 警告 54 件（testsuites）は型品質上の負債として残る。

---

## 独立監査2: 実装監査 — Iteration 5

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 5
- **実施日時**: 2026-11-20 21:03 JST
- **判定**: **FAIL**（Major 1 件 / Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.4、Iteration 1〜4 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 4 の監査で作られたツリーのコピーから、Iteration 4 時点の原本を復元した。`gate2_it4/rev3_tree/` と `gate2_it4/nosettle_tree/` の `gravsim_calc_predictor.js`・`gravsim_trajectory_predictor.js` は同一で、`gravsim_const.js` の違いは計装用の定数だけである。Iteration 4 以降に変更されたのは次の 3 ファイルと設計書だけで、テスト・プリセット・`package.json` は変わっていない。差分は全行を読んだ。
  - `scripts/gravsim_calc_predictor.js`: 安定周回の判定の置き換え（`tidalRatioAt`、`settleRef`、外挿による検証）、`REVOLUTIONS` のフォールバック、切替条件のコメント。
  - `scripts/gravsim_const.js`: `SETTLED_ORBIT`（`REVOLUTIONS: 1`、`DRIFT_SAFETY_FACTOR: 2`、`MAX_PROJECTED_SHAPE_CHANGE: 0.02`、`MAX_TIDAL_RATIO: 1e-4`。`MAX_APOAPSIS_ALT_M` は削除）。
  - `scripts/gravsim_trajectory_predictor.js`: 描画座標系のコメント 1 行。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。監査開始時と終了時で `git status --short` と、`scripts/`・`testsuites/`・`presets/`・`docs/`（本ファイルを除く）の全ファイルの md5 が一致することを確認した。
- **描画座標系での計測**: 実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標で測った（ズーム 1e9、Iteration 3 の `v1_drawn.mjs` の `capture`）。プレビューと飛行中（射点で 37 s 待機した想定。切替前後、終端付近、安定周回では終端後と要求期間の直前を含む 7〜9 時刻）の両方で測った。
- **実経路での計測**: Iteration 2〜4 のハーネス（実物の `Universe` と `SimulationController` をメッセージ路でつないだ `e2e.mjs`、`s1`〜`s9`、`v2_flight_frame.mjs`）を再実行した。予測は `RocketLauncher.updatePredictionSync()` と `rollout()` の実経路で求めた。
- **スクリプト**: 検証スクリプトとログは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it5/` に置いた（`b1`〜`b6`、`c1`〜`c7`、`r_a8*`、`ab.mjs`、ログ `*.log`）。
- **比較用ツリー**（いずれも scratchpad 内の作業用コピー）:
  - `gate2_it5/nosettle_tree/`: 打ち切りなしの参照用。**現行ツリー**から作り直し、`REVOLUTIONS=1e9`、`MAX_STEPS`／`MAX_STEPS_CAP=2e7` に変更した（`gate2_it4/nosettle_tree/` は使っていない）。A/B 比較では、参照側に `maxSteps` 2e8・`maxPoints` 1e6 を渡して要求期間の最後まで計算した（`ab.mjs`）。物理ステップ幅は `maxSimTime` だけで決まるため、打ち切り時刻までは両者の軌道が一致する。
  - `gate2_it5/it4_tree/`: Iteration 4 の原本（`REVOLUTIONS=1`）。
  - `scratchpad/main_tree/`: main との比較用。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/` の 16 ファイル。`scripts/` は 0 件） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 4 指摘の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-4-01 | △ 指摘した事例は解消。新しい判定に別の穴がある（G2-5-01） | **Iteration 4 の再現スクリプト**（新しい参照ツリーで再実行）:<br>・月ホスト（`r_a8b`。近月点 200 km、遠月点 8,000〜32,000 km × 8 方位、1 ヶ月）: `settled_orbit` は 0/48 件（Iteration 4 は 26 件、うち誤判定 12 件）。遠月点 8,000 km でも地球の潮汐比は 2.6e-3 で、すべて候補から外れる。<br>・月面からの打上げ（`r_a8f`。`a8f_cases.json` の 16 件）: `settled_orbit` は 0 件（Iteration 4 は誤判定 6 件）。全件 `step_budget`（1.01〜1.62 日）。<br>・地球ホスト（`r_a8g`。近地点 110/150 km、遠地点 30,000〜49,000 km × 8 方位）: `settled_orbit` は 0/24 件（Iteration 4 は誤判定 2 件）。全件 `step_budget`。<br>**近点高度の余裕が最も小さい打ち切りの検証**（`c1`・`c2`）: 遠点と方位の組ごとに、打ち切られる最も低い近点高度を探し、その軌道を打ち切らずに要求期間の最後まで計算して比べた。<br>・Earth＋Moon、1 ヶ月（遠地点 10,000〜54,000 km × 8 方位、48 件）: 衝突 0、大気上限割れ 0。期間中の最低高度は 108.9 km（近地点 110 km で打ち切った軌道）。形の変化は \|Δa\|/a 6.2e-5 以下、\|Δe\| 6.6e-4 以下。<br>・Sun＋Earth＋Moon、0.5 ヶ月（16 件）: 同じく違反 0。最低高度 108.8 km。<br>・月ホスト、1 ヶ月（遠月点 150〜500 km、14 件）: 違反 0。最低高度 129.8 km。遠月点 1,200 km 以上は打ち切られない。<br>・潮汐による下限 `τ × a` だけで見積もった近点の低下（安全係数 2 を除く）は、実測の 4〜6 倍だった。例: 遠地点 54,000 km（τ ≈ 9.5e-5、1 周あたり 3.2 km、30 日で 134 km）に対し、実測は最大 22 km。Sun+Earth の GTO 3 ヶ月（1 周あたり 0.37 km、76 km）に対し、実測は 19 km。<br>**プリセット**（`c4`。Sun+Earth と 7 天体、0.5〜3 ヶ月、方位 2〜4 通り、延べ 44 件）: 打ち切った LEO/ISS/GTO を打ち切らずに要求期間の最後まで計算しても、衝突・大気上限割れは 0 件。近地点の低下は最大 19 km（GTO 3 ヶ月）、形の変化は \|Δe\| 8.3e-4 以下、近点方向の回転は 0.004 rad 以下。<br>**未解消**: 第三天体の大きさと接近を見ていないため、第三天体に衝突する軌道を打ち切る（G2-5-01）。 |
| G2-4-02 | ✓ 解消 | §4.10 L417 の回転量は「最大 `ω × frameSwitchTime`」と実測値（LEO h3_30 0.044、LEO falcon9 0.090、LEO h3_22 0.120、ISS h3_22 0.138、ISS h3_30 0.166、ISS h3_24 0.176 rad）に改められた。`b6_rigid.mjs`（Iteration 4 の `a6_rigid.mjs` と同じ）の出力は Iteration 4 と完全に一致し、記載値と合う。 |
| G2-4-03 | ✓ 解消 | `REVOLUTIONS \|\| 1`（`gravsim_calc_predictor.js:345`）。新しい定数のフォールバック `DRIFT_SAFETY_FACTOR \|\| 2`、`MAX_PROJECTED_SHAPE_CHANGE \|\| 0.02`、`MAX_TIDAL_RATIO \|\| 1e-4` も SSOT と一致する。切替条件のコメント 2 箇所（`gravsim_calc_predictor.js:336-338`、`gravsim_trajectory_predictor.js:571`）は §4.10 の 3 条件に合わせて更新された。`scripts/`・`testsuites/`・`types/` に `MAX_APOAPSIS_ALT_M` の参照は残っていない。 |
| Iteration 4 WP1（既定期間との両立） | ✓ | LEO 0.2・ISS 0.3・GTO 0.5 ヶ月（既定）は、Sun+Earth の 8 方位と 7 天体の 4 方位のすべてで `settled_orbit`。同期ブロック時間は下表。 |
| Iteration 4 WP2（保証 3 の対象） | ✓ | §4.3 保証 3 に「表にない機体の組合せは `settled_orbit` になるとは限らない」が追記された。7 天体の全 18 組合せ（`b1_combo_w7.log`）では、`h3_22` の GTO（0.5/1 ヶ月）、`falcon9`・`ssto` の GTO（1 ヶ月）が `step_budget`、`ssto` の ISS が `horizon`、`epsilon` が全件 `breakup`。 |

**Iteration 1〜3 指摘の回帰確認**:

| ID | 結果 |
|---|---|
| G2-01 / G2-02 | ✓ 回帰なし。`s1_init_paths.mjs` の出力は Iteration 4 と完全に一致する。 |
| G2-03〜G2-09 | ✓ 回帰なし。該当ファイルは Iteration 4 以降変更されていない。予測器の変更は安定周回の判定だけで、サンプラーと切替判定は変わっていない。 |
| G2-2-01〜G2-2-04、G2-3-01〜G2-3-03 | ✓ 回帰なし。**§4.3 の保証 1・2**: Sun+Earth の 7 ミッション × 7 期間（0.2〜36 ヶ月）× 8 方位（392 件）と、7 天体の 7 × 7 × 4 方位（196 件）で、描画上の最大角度ステップは 0.120 rad、0.15 rad 超 0 件、点数 3,000 以下、時刻の非単調 0 件、`impact` イベントの有無と `endReason === 'impact'` は全件一致。**保証 4・5**: 深宇宙 3 ミッションは全件 `horizon` か `point_budget`（到達率 99.91% 以上）、Lunar は `step_budget` か `breakup`。§4.3 の方位 8 通りの記述（Mars 36 ヶ月 3/5、Lunar 1 ヶ月 4/4・10.25〜17.40 日）と 1200 s（全件 `horizon`、1,122〜1,631 点）も一致した。 |
| 実経路飛行 15 構成（`s2_flights.mjs`） | **墜落 0・同期不一致 0**。出力は Iteration 4 と完全に一致する。 |
| save/load（スナップショットあり、15 時点。`s3_saveload.mjs`） | 全件で墜落 0。Iteration 4 との差分は保存処理の所要時間だけ。 |
| スリングショット機の save/load（`s9`）、旧セーブ形式（`s8`） | Iteration 4 と完全に一致する。 |
| 実経路の描画（`v2_flight_frame.mjs`、約 70 時間） | Iteration 4 と共通の 8 構成は、出力が完全に一致する。機体と描画予測線の距離は LEO/ISS 2.6〜3.6 km、GTO 28.6 km、Mars 66.8 km、Lunar 1,287 km。今回追加した 2 構成（ISS `h3_22` 1 ヶ月、GTO 3 ヶ月）でも、予測線は途中で消えない（距離 3.6 km／28.6 km。GTO 3 ヶ月は Sun+Earth で `settled_orbit`）。 |

**§4.3 実測表の再現**（`b1_table.mjs`、Sun+Earth、方位 0°、0.2/1/3/12/36 ヶ月）: 全セルの点数・終了時刻・終了理由を再現した（ISS 7,303 s・1,397 点、LEO 6,301 s・1,411 点、GTO 39,026 s・1,509 点、1〜3 ヶ月 1,474〜1,506 点、12・36 ヶ月 `step_budget` 155,735 s・1,797 点など）。ただし GTO 行の「描画上の最大角度ステップ 0.060 rad」は、12・36 ヶ月の `step_budget` では 0.120 rad になる（G2-5-02）。

**同期ブロック時間**（7 天体ワールドの `rollout()`、各 2 回。`b4_rollout_timing.mjs`。他の計測ジョブをすべて止めた状態で測定）。§4.12 の表を再現し、受入基準（既定期間で main 比 1.5 倍以内、任意期間で 2 s 以内）を満たす。表の下 4 行は Iteration 4 の表にない構成で、今回の改訂で `step_budget` まで計算するようになった GTO 3〜36 ヶ月を含む:

| 構成 | 本ブランチ | main |
|---|---|---|
| `leo_250km` 0.2 ヶ月（既定） | 186〜194 ms | 175〜197 ms |
| `lunar_insertion` 1 ヶ月（既定） | 1,449〜1,456 ms（1.27〜1.34 倍） | 1,084〜1,139 ms |
| `gto_insertion` 0.5 ヶ月（既定） | 439〜445 ms | 787〜799 ms |
| `iss_rendezvous` 0.3 ヶ月（既定） | 292〜312 ms | 475〜491 ms |
| `leo_250km` 3 ヶ月 | 302〜319 ms | 1,075〜1,089 ms |
| `iss_rendezvous` 12 ヶ月 | 317〜320 ms | 1,032〜1,055 ms |
| `lunar_insertion` 36 ヶ月 | 1,492〜1,521 ms | 1,128〜1,139 ms |
| `gto_insertion` 1 ヶ月 | 426〜430 ms（`settled_orbit`） | 1,129〜1,149 ms |
| `gto_insertion` 3／12／36 ヶ月 | 1,488〜1,539 ms（`step_budget`、155,742 s） | 1,066〜1,168 ms |
| `leo_250km` 36 ヶ月 | 256〜261 ms | 1,007〜1,031 ms |
| 深宇宙 3 ミッション（既定） | 347〜448 ms | 1,034〜1,105 ms |

**補遺 §4（Rev 6.4 分）と実装の突合**:

- §4.12 の候補条件（座標系切替済み、最終コースト、予定アクションなし、支配天体がホスト、`E < 0`、近点高度 ≥ 大気上限、遠点での潮汐比 ≤ 1e-4、内側の天体は `τ = ∞`）と検証（`N = 残り時間 / 観測周期`、`k = 2N`、`max(観測値, τa)` による近点・遠点・形の外挿、不合格なら次の 1 周を観測）は、`gravsim_calc_predictor.js:349-361, 707-770` と一致する。同期・Worker の両経路は同じ関数を使う。
- §4.12 の実測（月ホスト 12/26 → 0、月面打上げ 6 → 0、地球ホスト 2 → 0）: 再現した（上表）。「すべて潮汐比で候補から除外」「外挿した近点変化が余裕を超えるため打ち切らない」も実測と合う。
- §4.12 の「これにより、打ち切った軌道は要求期間内に大気上限を割らないこと、および描画した 1 周と形がほぼ変わらないこと（2% 以内）が、安全係数 2 で保証される」: 大気上限と形については、上の敵対的な検証で反例は見つからなかった。ただし、第三天体への衝突を防げない（G2-5-01）。
- §4.3 保証 3・表の GTO 行: Sun+Earth では一致する。月を含むワールドでは GTO 3 ヶ月が `settled_orbit` にならず、表の最大角度ステップも 1 セル合わない（G2-5-02）。
- §4.10 の回転量: 一致する。
- Rev 6 本文との矛盾: なし。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-5-01 [Major] 新しい安定周回の判定は第三天体の大きさと接近を考慮していない。質量の小さい天体（`2 m_k / m_host < MAX_TIDAL_RATIO`）は潮汐比の条件で除外されることがない。そのため、遠点がその天体の軌道帯（中心距離 ± 半径）と重なる軌道も「安定」と判定される。プリセットの GTO でも、利用者が置いた天体に数日後に衝突する軌道を打ち切り、要求期間いっぱい閉じた楕円を表示して IMPACT を出さない（G2-4-01 と同じ型の誤判定）
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:349-361`（`thirdBodies`、`tidalRatioAt`）
    - 「軌道の内側の天体」の判定は中心距離 `d > r` だけで、天体の半径 `R_k` もヒル半径も見ていない。
    - 潮汐比 `2 (m_k / m_host)(r / d)³` は `r < d` で常に `2 m_k / m_host` 未満である。このため、軽い天体は遠点が中心距離のすぐ内側にあっても除外されない。
  - `scripts/gravsim_calc_predictor.js:725-728, 750, 756-758`（候補条件と、予測遠点半径での潮汐比の判定）
  - 設計書 §4.12 L437（候補条件「遠点での第三天体の潮汐比 … 天体が軌道の内側にあれば τ = ∞」）、L445（「安全係数 2 で保証される」）
- **現象**（打ち切らない参照計算と比較。`ab.mjs`）:
  1. **プリセットの GTO と、利用者が置いた天体**（`c6_gto_lowmass_moon.mjs`、`c7_gto_mimas_realpath.mjs`）:
     - 条件: Sun+Earth のワールドに、Deploy タブの質量選択リスト（`mass-select`）にあるプリセット天体 `Mimas`（3.75e19 kg、半径 198 km。`2m/M_earth = 1.3e-5`）を、地球を回る半径 42,300 km の円軌道に置く。そのうえで `h3_24`＋`geo_sat`＋`gto_insertion` を既定期間（0.5 ヶ月）で予測する。GTO の遠地点半径は 42,194 km で、Mimas の軌道帯（42,102〜42,498 km）の中にある。
     - 予測器単体（`c6`。実際のランチャーが作るパラメータに Mimas を追加）: Mimas の位相 8 通りのうち 7 件が 0.45 日で `settled_orbit` になる（残る 1 件は、予測自体が 0.22 日の衝突を出す）。7 件を打ち切らずに計算すると、3 件（位相 0°/270°/315°）が 10.36／8.62／9.49 日に Mimas に衝突する。
     - 実経路（`c7`。`ObjectPlacer.placeObject('Mimas', …)` → `applyToLauncher` → `RocketLauncher.updatePredictionSync()`。位相 0°/90°/270°/315°）でも同じ結果になる。アプリが受け取る予測は 4 件とも `endReason: 'settled_orbit'`、`maxSimTime` 15.22 日で、イベントに IMPACT はない。同じパラメータを打ち切らずに計算すると、3 件が 8.62〜10.36 日に Mimas に衝突する（`impact_<MimasのID>`）。
     - 近地点と形は衝突の直前まで変わらない（\|Δa\|/a ≤ 2e-4）。そのため、外挿による検証では検出できない。
     - 置く半径を 42,164 km（静止軌道。遠地点の内側）にすると、`d ≤ r` の規則で全件が候補から外れる（`step_budget`）。半径 42,400 km（軌道帯が遠地点の外側）では、15 日以内の衝突は起きない。つまり、天体の半径の分だけ、判定に穴がある。
  2. **Deploy タブの木星の衛星**（`c3_jupiter_io.mjs`）:
     - 条件: Jupiter＋Io（`2m/M = 9.4e-5 < 1e-4`。Io の軌道半径 421,866 km、半径 1,822 km、ヒル半径 約 10,600 km）。木星をホストにして、近点高度 10,000 km、遠点半径 410,000〜421,000 km の軌道を 16 方位で予測する。期間は 0.2・0.5・1 ヶ月。
     - 結果: `settled_orbit` になった 321 件のうち 15 件が、参照計算では 1.22〜21.47 日後に Io に衝突する（例: 0.2 ヶ月、遠点 420,500 km、方位 247.5°。0.81 日で打ち切られ、参照計算では 1.22 日に衝突）。
     - 予測遠点半径での潮汐比の判定は、`r_apo + 変化量 × k` が Io の中心距離を超えたときだけ働く。そのため、遠点が Io の軌道帯やヒル球の中にあっても通る。
  3. main は安定周回の打ち切りを持たない。GTO の予測は 25,693 s で止まり、それより先の有効性は主張しない。§4.12 の「要求期間まで有効」という表示は本ブランチで導入されたもので、それが誤っている。
  4. 到達経路について: 1 は、通常の UI 操作（プリセット天体の配置と、プリセットの打上げ）で作れる。Mimas を遠地点付近に置くという条件は狭いが、静止軌道帯に天体を置いて GTO を打ち上げる操作は、このサンドボックスで自然に起こり得る。2 は、木星から打ち上げる機体が現実的なプリセットにないため、予測器単体での再現である。どちらも、§4.12 が「保証される」とする打ち切りの安全性の反例になる。
- **修正方針**:
  - 第三天体に近い軌道を候補から外す条件を、設計補遺 §4.12 で確定してから実装する。例: 各第三天体 k について、`d_k − R_k − κ · r_H,k ≤ r_apo`（候補条件）または `≤ 予測遠点半径`（検証）なら `τ = ∞` とする。ここで `r_H,k = d_k (m_k / (3 m_host))^(1/3)`、κ は 3 程度。
    - 参考値: κ = 3 の場合、月（地球ホスト）では除外境界が約 198,000 km で、現行の潮汐比の条件（約 61,000 km）より緩い。したがって LEO/ISS/GTO の既定期間の打ち切りは変わらない。上記の Mimas（境界 40,479 km）と Io（境界 388,363 km）の反例はすべて除外される。
  - 第三天体までの距離 `d_k` は判定時点の値しか使っていない。離心率の大きい軌道や接近中の天体は、要求期間中に近づく可能性がある。ホストに束縛された第三天体ならその近点距離を使うなど、期間中の最小距離で判定する方法も、あわせて検討すること（Watchpoint 3）。
  - 修正後に、本 Iteration の `c1`〜`c7` と、§4.3 の表・方位 8 通り・7 天体ワールド・同期ブロック時間を再計測すること。
  - 次をテストで固定する（工程 3）。
    - 上記の GTO＋Mimas（42,300 km）と Jupiter＋Io の反例が `settled_orbit` にならないこと。
    - 月を含むワールドで、LEO/ISS/GTO の既定期間が従来どおり `settled_orbit` になること。

#### G2-5-02 [Minor] Rev 6.4 で改訂した §4.3 と §4.12 の記述の一部が実測と合わない、または適用範囲が書かれていない。工程 3 のパラメータ化テストの期待値として、そのままでは使えない
- **箇所**: 設計書 §4.3 L344（保証 3）、L352（表の GTO 行）、L336（`endReason` 表の `settled_orbit` 行）、§4.12 L437、L451-459（同期ブロック時間の表）
- **現象**:
  1. **保証 3 にワールドの条件がない**（L344）:
     - 「GTO は 0.2〜3 ヶ月で `settled_orbit`」は Sun+Earth でしか成り立たない。7 天体ワールド（月あり）の GTO 3 ヶ月は、4 方位すべてで `step_budget`（155,742 s・1,800 点）になる（`b1_w7.log`）。
     - 原因は月の潮汐による下限である。GTO の遠地点での月の潮汐比は約 3.3e-5 で、1 周あたりの下限は約 0.8 km になる。3 ヶ月では k = 2N ≈ 410 となり、予測近地点は 389 − 約 330 = 約 60 km で、大気上限（100 km）を下回る。月を含むワールドで GTO が打ち切られるのは 1 ヶ月までである。
     - Iteration 4 では、7 天体ワールドでも保証 3 の違反は 0 件だった。今回の改訂で新たに条件付きになったが、保証の文面には反映されていない。
  2. **表の GTO 行の最大角度ステップ**（L352）: 0.060 rad と書かれている。しかし、Rev 6.4 で `step_budget` に変わった 12・36 ヶ月では 0.120 rad になる（`b1_az0.log`）。他の行は全期間の最大値を書いている（Lunar 0.120 rad など）。
  3. **「地球では遠点高度約 55,000 km に相当」**（L437）: これは月がある場合の値である。Sun+Earth（§4.3 の実測表の構成）では、太陽の潮汐比が 1e-4 に達する遠点高度は約 73,000 km になる。
  4. **`endReason` 表の `settled_orbit` 行**（L336）: 「安定周回を `SETTLED_ORBIT.REVOLUTIONS` 周続けた」のままである。Rev 6.4 では「1 周観測した後に外挿による検証に合格した」に変わり、合格するまで観測し直すため、周回数は 1 とは限らない。
  5. **同期ブロック時間の表**（L451-459）: 今回の改訂で生じた最悪の構成を載せていない。7 天体ワールドの GTO 3〜36 ヶ月は、Iteration 4 では 0.45 日で打ち切られていたが、今回は `step_budget`（400,000 ステップ）まで計算するようになった。実測は 1,488〜1,539 ms で、受入基準（2 s 以内）は満たす。ただし月遷移 36 ヶ月（1,492〜1,521 ms）と並ぶ最悪の構成であり、受入基準の根拠として表に載せる必要がある。
- **修正方針**:
  - 保証 3 に、適用するワールド（Sun+Earth）を明記する。あわせて、月を含むワールドでの GTO の範囲（1 ヶ月まで）を書く。
  - GTO 行の最大角度ステップを 0.120 rad に改める。または、期間ごとに分けて書く。
  - L437 の相当値に、月がある場合の値であることを明記する（Sun+Earth では約 73,000 km）。
  - L336 を、検証に合格した時点で終わることがわかる記述に改める。
  - §4.12 の表に、7 天体ワールドの GTO 3・12・36 ヶ月を追加する。
  - G2-5-01 の修正で数値が変わる場合は、それを反映した後の値で書くこと。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 第三天体を中心距離だけで扱う（G2-5-01） | 第三天体の位置から軌道の安全性を判断する処理は、安定周回の判定（`tidalRatioAt`）の 1 箇所だけである（同期・Worker 共通）。<br>その他の処理は次のとおり。<br>・衝突判定 `getMinSurfaceDist`: 天体の半径を含めた表面距離を使う（✓）。<br>・ステップ幅（`DIST_THRESHOLDS_M`）: 表面距離で決まる（✓）。<br>・支配天体: 重力加速度が最大の天体（`gravsim_calc.js:615-633`）。半径による軟化を含む（✓）。<br>・座標系の切替: ホストだけを見る（第三天体は関係しない）。<br>配置できるプリセット天体のうち、`2m/M < 1e-4` になる組合せ（潮汐比の条件が効かない組合せ）は次のとおり。<br>・地球ホスト: Mimas（1.3e-5）、Enceladus（3.6e-5）、Asteroid<br>・木星ホスト（Deploy タブのボタンで配置）: Io（9.4e-5）、Europa（5.1e-5）<br>・土星ホスト（同）: Mimas、Enceladus、Rhea（8.1e-6） | **要**（設計と実装） |
| 第三天体までの距離を判定時点の値で固定する | 同じく `tidalRatioAt` の 1 箇所だけ。<br>・月を離心軌道（e = 0.055）に置いた場合、潮汐比の変動は計算上 ±17% で、安全係数 2 の範囲に収まる。<br>・離心軌道の Mimas（近地点 41,000 km・遠地点 150,000 km、遠地点から開始、16 方位）が GTO の遠地点帯を横切る場合でも、15 日以内の衝突は 0 件だった（`c6`、`ECC=41000`）。<br>反例は見つかっていないが、原理的には漏れがある（Watchpoint 3）。 | 要検討（G2-5-01 の修正とあわせて） |
| 新しい定数の SSOT とフォールバック | `SETTLED_ORBIT` の 4 定数のフォールバックは、すべて SSOT と一致する（`1`、`2`、`0.02`、`1e-4`）。<br>削除した `MAX_APOAPSIS_ALT_M` の参照は `scripts/`・`testsuites/`・`types/` で 0 件。<br>`MAX_STEPS \|\| 120000`、`MAX_STEPS_CAP \|\| 400000`、`FRAME_SWITCH?.MAX_HOST_FIXED_ALT_M` は変わっていない。 | 不要 |
| 古い仕様を説明するコメント（G2-4-03 の横展開） | `scripts/` で「orbit insertion」「REVOLUTIONS」「50,000 km」を検索した。切替条件と安定周回の説明は、`gravsim_calc_predictor.js:336-338, 666-667, 707-708` と `gravsim_const.js:355-366` のすべてが現行仕様と一致する。`settled_orbit` を参照するのは予測器だけ（描画は `maxSimTime` だけを見る）。 | 不要 |
| 設計書の数値の主張と実測（G2-4-02 の横展開） | Rev 6.4 で追加・変更された数値をすべて再計測した。<br>・一致: §4.10 の回転量 6 件、§4.12 の実測 3 件、§4.3 の点数・終了時刻・方位 8 通り・1200 s。<br>・不一致または条件の不足: G2-5-02 の 5 点。 | **要**（G2-5-02） |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G2-5-01 の修正は、既定期間での打ち切りと両立させること**: 除外条件を足すと、LEO/ISS/GTO の既定期間で `settled_orbit` に届かなくなる可能性がある。修正後は §4.3 の表、方位 8 通り、7 天体ワールド、同期ブロック時間を再計測すること。κ を決めたら、境界のすぐ内側と外側（例: Mimas の軌道半径を遠地点 + R_k + κ r_H の前後に置く）をテストで固定すること。
2. **長い期間の GTO では、飛行中に予測線が 1.8 日で消える**: GTO は、Sun+Earth の 12 ヶ月以上と、月を含むワールドの 3 ヶ月以上で `step_budget`（約 155,700 s）になる。Rev 6.4 で受け入れた仕様（保証 3）だが、Iteration 4 では打ち切られていた構成である。飛行中に `currentFlightTime > maxSimTime` で予測線が消えることを、E2E の期待値として明記すること（main は 25,693 s で止まるので、main からの回帰ではない）。
3. **第三天体までの距離の時間変化**: 判定は判定時点の `d_k` を使い、期間中に第三天体が近づく場合を考えていない。G2-5-01 の修正では、ホストに束縛された第三天体ならその近点距離を使うなど、期間中の最小距離に基づく判定を検討すること。
4. **安定周回の閾値の境界値テスト**: `MAX_TIDAL_RATIO`（1e-4）、`DRIFT_SAFETY_FACTOR`（2）、`MAX_PROJECTED_SHAPE_CHANGE`（0.02）、大気上限との比較（`>=`）は、いずれも境界の直前・一致・直後で結果が変わる。工程 3 では、要求期間を変えて k を動かす方法で境界を作ると、軌道を変えずに済む（例: GTO の Sun+Earth で、3 ヶ月は `settled_orbit`、12 ヶ月は `step_budget`）。
5. **近点方向の回転は検証の対象外**: 外挿の検証は a・e・近点高度・遠点半径だけを見て、近点方向の回転は見ていない。今回の計測では、1 ヶ月で 0.031 rad（低い月周回）、GTO 3 ヶ月で 0.004 rad 以下だった。長期間の離心軌道で予測線と機体がずれる上限は、テストで値を固定するか、設計に明記すること。
6. **Iteration 4 の Watchpoint 3〜8 は引き続き有効**: 直接上昇型の離脱での ORBIT マーカー、衝突イベントは type ではなく id で判定すること、無大気天体での閾値 100 km、高ロフト弾道の着地点、時間倍率が大きいときの実飛行経路、記録用 ctx での計測方法。Iteration 1・2 の Watchpoint（スナップショットなしで保存した場合の劣化、ツールチェーンのバージョン固定など）と、lint 警告 54 件（testsuites）も残る。

---

## 独立監査2: 実装監査 — Iteration 6

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 6
- **実施日時**: 2026-11-20 21:48 JST
- **判定**: **FAIL**（Major 2 件 / Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.5、Iteration 1〜5 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03、G2-5-01〜G2-5-02）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 5 の監査で作った参照ツリー `gate2_it5/nosettle_tree/`（Iteration 5 時点のコピー。計装は `gravsim_const.js` の定数 3 つだけ）と、Iteration 5 開始時の全ファイルの md5（`gate2_it5/md5_before.txt`）を現行ツリーと突き合わせた。Iteration 5 以降に変更されたのは次の 2 ファイルと設計書だけで、テスト・プリセット・`package.json`・他のソースは変わっていない。差分は全行を読んだ。
  - `scripts/gravsim_calc_predictor.js:349-391`: `settledHillFactor`、`thirdBodies`（ホストとの二体相対運動で束縛／非束縛を判定し、`dMin`・`innerEdge` を予測開始時に 1 回だけ求める）、`tidalRatioAt`（`innerEdge <= r` なら `Infinity`、それ以外は `dMin` での潮汐比）。
  - `scripts/gravsim_const.js:371-374`: `SETTLED_ORBIT.HILL_EXCLUSION_FACTOR: 3` とコメント。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。監査開始時と終了時で、`git status --short` と、`scripts/`・`testsuites/`・`presets/`・`types/`・`docs/`（本ファイルを除く）・設定ファイルの全ファイルの md5 が一致することを確認した。
- **描画座標系での計測**: 実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標で測った（ズーム 1e9、Iteration 3 の `v1_drawn.mjs` の `capture`。プレビューと飛行中の 7〜9 時刻）。
- **実経路での計測**: 予測は `ObjectPlacer.placeObject` → `PresetManager.applyToLauncher` → `RocketLauncher.updatePredictionSync()`／`rollout()` の実経路で求めた。Iteration 2〜5 のハーネス（`e2e.mjs` 系の `s1`〜`s9`、`v2_flight_frame.mjs`、`b1_table.mjs`、`b4_rollout_timing.mjs`）を再実行した。
- **スクリプト**: 検証スクリプトとログは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it6/` に置いた（`d1`〜`d10`、再実行した `b1`・`b4`・`c3`・`c7`・`r_a8*`、ログ `*.log`）。
- **比較用ツリー**（いずれも scratchpad 内の作業用コピー）:
  - `gate2_it6/nosettle_tree/`: 打ち切りなしの参照用。**現行ツリーから作り直し**、`REVOLUTIONS=1e9`、`MAX_STEPS`／`MAX_STEPS_CAP=2e7` に変更した。A/B 比較（`gate2_it6/ab.mjs`）では、参照側に `maxSteps` 2e8・`maxPoints` 1e6 を渡して要求期間の最後まで計算した。
  - `gate2_it6/inst_tree/`: 現行ツリーに、外挿による検証の入力と結果（観測周期、`k`、潮汐比、観測した近点変化、潮汐による下限、予測近点高度）を記録する 1 行だけを加えた計装コピー。
  - `scratchpad/main_tree/`: main との比較用。
- **比較ハーネスの補正**（重要）: Iteration 5 の `c3_jupiter_io.mjs` は、木星のパラメータを `{ ROTATION_PERIOD, ATM_LIMIT_ALT }` だけで与えている。この場合、機体が大気上限（3,000 km）より下に入ると、`CalcRocket.applyAerodynamics`（`gravsim_calc_object.js:158`）の密度が `undefined × exp(…) = NaN` になり、以降の参照計算の点がすべて NaN になる。`ab.mjs` の最低高度は NaN の点を無視するため、**大気上限を割った事例が「違反なし・最低高度 ≈ 3,000 km」として隠れていた**。今回の `ab.mjs` は参照計算の非有限値を検出して違反として数え、木星の事例は実際のプリセットのパラメータ（`presetManager.getObjectParam('Jupiter')`。`atmDensity0`・`atmScaleHeight` を含む）で計算し直した。地球ホストの Iteration 5 の `c1`（近地点の余裕の検証）は密度を含むパラメータを使っており、影響を受けない。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/`。`scripts/` は 0 件） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 5 指摘の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-5-01 | △ 指摘した事例は解消。同じ型の穴が非束縛天体と除外境界の外側に残る（G2-6-01・G2-6-02） | **Iteration 5 の反例**（新しい参照ツリーで再実行）:<br>・GTO＋Mimas 42,300 km、実経路（`c7`、位相 0°/90°/270°/315°）: 4 件とも `step_budget`（1.09〜1.20 日）。`settled_orbit` は 0 件（Iteration 5 は 4/4 件、うち 3 件が Mimas に衝突）。Mimas の除外境界は 40,479 km で、GTO の遠地点 42,194 km より内側にある。<br>・木星＋Io の軌道帯（`c3`、遠点 405,000〜421,000 km × 16 方位、0.2 ヶ月、96 件）: `settled_orbit` は 0 件。Io の除外境界は 388,363 km。<br>・月ホスト（`r_a8b`、48 件）、月面からの打上げ（`r_a8f`、16 件）、地球ホスト（`r_a8g`、24 件）、GTO＋Mimas の予測器単体（`c6`、8 位相）: `settled_orbit` はいずれも 0 件（Iteration 5 と同じ）。<br>・離心軌道の Io（e = 0.1、遠点から開始。除外境界は近点距離 379,530 km から 349,100 km）: 遠点 352,000 km は 8/8 件が除外。345,000 km 以内の 24 件は打ち切られ、違反 0 件。<br>・Galilean 4 衛星（`d3`、遠点 150,000〜387,000 km × 8 方位、48 件）と Io のみ（56 件）: 違反 0 件。複数衛星でも、最も近い衛星（Io）の境界が効く。<br>**未解消**: 非束縛天体の最接近を直線運動で見積もるため、ホストの重力で曲げられて接近する天体を見逃す（G2-6-01）。束縛衛星の除外境界のすぐ外側では、外挿が衛星との会合による変化を過小評価する（G2-6-02）。 |
| G2-5-02 | △ 5 点中 4 点は解消。1 点は値が誤っている（G2-6-03） | (1) 保証 3 のワールド条件: §4.3 の表のとおり（下記「補遺との突合」）。✓<br>(2) GTO 行の最大角度ステップ: 「0.060 rad（`settled_orbit`）／0.120 rad（12・36 ヶ月）」に改められ、実測と一致する。✓<br>(3) L443 の相当値: 月がある場合の約 55,000 km は実測 54,362 km と合う。✓ Sun+Earth の「約 72,000 km」は、現行コードの式（`d_min` は太陽との相対軌道の近点距離 149,399,076 km）で 73,023 km になる。Iteration 5 が示した約 73,000 km とも異なる。✗<br>(4) `endReason` 表の `settled_orbit` 行: 「`REVOLUTIONS` 周を観測し、変化量の外挿による検証に合格した（不合格なら次の周を観測し直す）」に改められた。✓<br>(5) 同期ブロック時間の表: 7 天体ワールドの GTO 3〜36 ヶ月が追加され、実測（1,486〜1,609 ms）と合う。✓ |
| Iteration 5 WP1（既定期間との両立） | ✓ | LEO 0.2・ISS 0.3・GTO 0.5 ヶ月（既定）は、Sun+Earth の 8 方位、7 天体の 8 方位、アプリの `SOLAR_SYSTEM` 配置（下記）のすべてで `settled_orbit`。Iteration 5 の `b1` 系の出力（Sun+Earth の方位 0° 35 件・8 方位 392 件、7 天体の 4 方位 196 件、計 623 件）と完全に一致する（所要時間を除く）。 |
| Iteration 5 WP3（第三天体までの距離の時間変化） | △ | 束縛天体は相対軌道の近点距離で見積もるようになった（✓）。非束縛天体は直線運動で見積もるため、ホストに近づく天体の加速と曲がりを無視する（G2-6-01）。 |

**Iteration 1〜4 指摘の回帰確認**:

| ID | 結果 |
|---|---|
| G2-01 / G2-02 | ✓ 回帰なし。`s1_init_paths.mjs` の出力は Iteration 5 と完全に一致する。 |
| G2-03〜G2-09 | ✓ 回帰なし。該当ファイルは Iteration 5 以降変更されていない。予測器の変更は第三天体の判定だけで、サンプラーと切替判定は変わっていない。 |
| G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03 | ✓ 回帰なし。Sun+Earth の 7 ミッション × 7 期間 × 8 方位（392 件）と、7 天体の 7 × 7 × 4 方位（196 件）、方位 0° の表（35 件）の出力は Iteration 5 と完全に一致する（所要時間を除く）。描画上の最大角度ステップ 0.120 rad、0.15 rad 超 0 件、点数 3,000 以下、時刻の非単調 0 件、`impact` イベントの有無と `endReason === 'impact'` は全件一致。7 天体の残り 4 方位（45°/135°/225°/315°）を LEO/ISS/GTO の 0.2/0.5/1/36 ヶ月で追加した 48 件でも、違反 0 件。 |
| 実経路飛行 15 構成（`s2_flights.mjs`） | **墜落 0・同期不一致 0**。出力は Iteration 5 と完全に一致する。 |
| save/load（スナップショットあり、15 時点。`s3_saveload.mjs`） | 全件で墜落 0。Iteration 5 との差分は保存処理の所要時間だけ。 |
| スリングショット機の save/load（`s9`）、旧セーブ形式（`s8`） | Iteration 5 と完全に一致する。 |
| 実経路の描画（`v2_flight_frame.mjs`、約 70 時間、10 構成） | Iteration 5 と完全に一致する。機体と描画予測線の距離は LEO/ISS 2.6〜3.6 km、GTO 28.6 km、Mars 66.8 km、Lunar 1,287 km。 |

**同期ブロック時間**（`rollout()`、各 2 回、本ブランチと main を交互に実行。`b4_rollout_timing.mjs`。別プロジェクトの無関係なプロセスが 1〜2 コアを使用中、load average 約 2.5／16 コア）:

7 天体ワールド（Sun/Earth/Moon/Venus/Mars/Jupiter）。§4.12 の表を再現し、受入基準（既定期間で main 比 1.5 倍以内、任意期間で 2 s 以内）を満たす。最悪は既定期間で月遷移の 1.33 倍、任意期間で GTO 12 ヶ月の 1,609 ms:

| 構成 | 本ブランチ | main |
|---|---|---|
| `leo_250km` 0.2 ヶ月（既定） | 196〜198 ms | 179〜184 ms |
| `lunar_insertion` 1 ヶ月（既定） | 1,502〜1,510 ms（1.30〜1.33 倍） | 1,136〜1,159 ms |
| `gto_insertion` 0.5 ヶ月（既定） | 438〜445 ms | 796〜808 ms |
| `iss_rendezvous` 0.3 ヶ月（既定） | 304〜306 ms | 483〜508 ms |
| `leo_250km` 3 ヶ月 | 309〜321 ms | 1,087〜1,090 ms |
| `iss_rendezvous` 12 ヶ月 | 326〜328 ms | 1,056〜1,070 ms |
| `lunar_insertion` 36 ヶ月 | 1,522〜1,539 ms | 1,155〜1,159 ms |
| `gto_insertion` 1 ヶ月 | 426〜434 ms（`settled_orbit`） | 1,134〜1,135 ms |
| `gto_insertion` 3／12／36 ヶ月 | 1,486〜1,609 ms（`step_budget`） | 1,108〜1,128 ms |
| `leo_250km` 36 ヶ月 | 264〜266 ms | 1,027〜1,030 ms |
| 深宇宙 3 ミッション（既定） | 366〜432 ms | 1,034〜1,114 ms |

参考として、アプリの `SOLAR_SYSTEM` 配置（`ObjectPlacer.deployProfile('SOLAR_SYSTEM')`、21 天体）でも同じ 15 構成を測った（`SS=1`）。既定期間はすべて main より短い（LEO 431〜432／590〜612 ms、月遷移 2,445〜2,460／3,240〜3,320 ms、GTO 1,120〜1,183／2,244〜2,383 ms、ISS 793〜804／1,376〜1,481 ms）。任意期間の最悪は GTO 3〜36 ヶ月の 3,905〜4,021 ms（`step_budget`）で、main（3,111〜3,356 ms）の 1.18〜1.29 倍である。この配置では main も 2 秒を超える（Watchpoint 3）。

**補遺 §4（Rev 6.5 分）と実装の突合**:

- §4.12 の「第三天体の接近と影響域」: 実装（`gravsim_calc_predictor.js:356-391`）は記述どおり、束縛天体は相対軌道の近点距離と現在距離の小さい方、非束縛天体は要求期間内の直線運動での最接近距離を `d_k,min` とする。束縛で軽い天体は `R_k + 3 r_H,k` を引く。ただし次の 2 点が記述と異なる、または記述が成り立たない。
  - 束縛で重い天体: 記述は `edge_k = d_k,min`、実装は `d_k,min − R_k`（`innerEdge = dMin - (b.radius || 0) - 0`）。実害はない（重い天体は潮汐比が先に効く）が、境界値テストの期待値が変わる（G2-6-03）。
  - 非束縛天体の直線運動による最接近の見積もりは、ホストの重力による接近の加速と曲がりを無視しており、安全側ではない（G2-6-01）。
- §4.12 の例（月 ≒ 198,000 km、Mimas 42,300 km ≒ 40,500 km、Io ≒ 388,000 km）: 実装の式で、月は 196,109 km（7 天体ワールドの月。相対軌道の近点 380,620 km から。円軌道 384,400 km なら 198,063 km）、Mimas 40,479 km、Io 388,363 km。一致する。
- §4.12 の実測（Mimas 4 位相・木星＋Io 98 件で誤判定 0 件、遠点 15〜30 万 km の近点変化 70 km 以内）: Mimas 4 位相は再現した。木星＋Io の 98 件は、期間・近点高度・遠点の範囲が書かれておらず、再現できない。同じ型の構成で、近点高度を大気上限の近くにすると誤判定が出る（G2-6-02）。遠点 30 万 km の近点変化は 0.5 ヶ月・8 方位で最大 76.5 km（G2-6-03）。
- §4.12 の「打ち切った軌道は要求期間内に大気上限を割らないこと…が、安全係数 2 で保証される」: 反例がある（G2-6-01・G2-6-02）。
- §4.3 保証 3 の表（Sun+Earth: LEO/ISS 0.2〜36 ヶ月・GTO 0.2〜3 ヶ月、7 天体: LEO/ISS 0.2〜36 ヶ月・GTO 0.2〜1 ヶ月）: Sun+Earth の 8 方位 × 7 期間、7 天体の 4 方位 × 7 期間と残り 4 方位 × 0.2/0.5/1/36 ヶ月で、全件一致する。GTO は Sun+Earth の 12・36 ヶ月、7 天体の 3〜36 ヶ月で `step_budget`。切替後の描画は 1.00〜1.08 周。
- §4.3 の実測表・方位 8 通り・1200 s: Iteration 5 と同じ出力で、一致する。
- §4.12 の受入基準の表: 再現した（上表）。
- Rev 6 本文との矛盾: なし。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-6-01 [Major] 非束縛の第三天体の最接近を直線運動で見積もるため、ホストの重力で曲げられて接近する天体を見逃す。プリセットの GTO（既定期間）で、利用者が投げ入れた天体に衝突する軌道や、天体の通過で大気に再突入する軌道を「安定」と判定し、要求期間いっぱい閉じた楕円を表示して IMPACT を出さない（G2-5-01 と同じ型）。束縛と非束縛の境界で判定が不連続になる
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:373-377`（`thirdBodies` の非束縛側。`tStar = -(r·v)/|v|²` を `[0, maxSimTime]` に丸めた直線上の最接近距離を `dMin` とし、`innerEdge = dMin − R_k`）
  - `scripts/gravsim_calc_predictor.js:367-372`（束縛側。相対軌道の近点距離を使う。こちらはホストによる曲がりを含む）
  - `scripts/gravsim_calc_predictor.js:381-391`（`tidalRatioAt`。両者の `dMin`・`innerEdge` をそのまま使う）、`:753-754, :786`（候補条件と予測遠点での判定）、`:845`（`settled_orbit` のとき `maxSimTime` を要求期間にする）
  - 設計書 §4.12 L447（「ホストに束縛されていない天体: `d_k,min` は要求期間内の直線運動での最接近距離、`edge_k = d_k,min − R_k`」）、L456（「安全係数 2 で保証される」）
- **現象**（打ち切らない参照計算と比較。`ab.mjs`）:
  1. **束縛と非束縛の境界**（`d1_flyby_boundary.mjs`、`d2_flyby_realpath.mjs`）:
     - 条件: Sun+Earth のワールドに、Deploy タブの質量選択リスト（`mass-select`）にある `Moon` を、地球から 1,300,000 km の位置に、地球に対して脱出速度の f 倍の速さで置く。向きは、地球との二体運動での近地点が 60,000 km になるように選ぶ（スリングショットで配置できる）。そのうえで `h3_24`＋`geo_sat`＋`gto_insertion` を既定期間（0.5 ヶ月）で予測する。接近方向は 8 通り。
     - f = 0.99（わずかに束縛）: 近点 60,000 km から除外境界が求まり、8/8 件が候補から外れる（`step_budget`）。
     - f = 1.01（わずかに非束縛）: 実際の軌道はほぼ同じ（二体の近点 60,000 km、約 13.7 日後に通過）。しかし直線運動の最接近は 355,886 km と見積もられ、GTO の遠地点での潮汐比は 4.1e-5 で上限 1e-4 を下回る。8/8 件が 0.45 日で `settled_orbit` になる。
     - f = 1.01 の参照計算: 2 件（接近方向 45°/270°）は、天体の通過で近地点が下がり、13.68／13.69 日に高度 79 km で `breakup` する。1 件（0°）は形が 2.4% 変わる（`|Δa|/a` 2.40e-2、`|Δe|` 2.77e-2）。
     - 実経路（`ObjectPlacer.placeObject('Moon', …)` → `applyToLauncher` → `updatePredictionSync()`）でも同じ結果になる。アプリが受け取る予測は `endReason: 'settled_orbit'`、`maxSimTime` 15.22 日で、IMPACT・BREAKUP のイベントはない。
  2. **第三天体への衝突**（`d4_unbound_collision.mjs`、`d5_unbound_collision_realpath.mjs`）:
     - 条件: 同じワールドに、`mass-select` の `Mimas`（3.75e19 kg、半径 198 km）を、地球から 1,566,729 km の位置に地球に対して非束縛の速度で置く（初期状態は GTO の 9.94 日目の遠地点付近を通るように、時間を逆向きに積分して求めた。ログに数値を記載）。
     - 直線運動の最接近は 104,295 km と見積もられ、除外されない。実際には地球の重力で曲げられ、近地点 42,186 km（GTO の遠地点付近）を通る。
     - 実経路の予測（既定 0.5 ヶ月）は `settled_orbit`（0.45 日）、表示期間 15.22 日、IMPACT なし。参照計算は 9.935 日に `impact_<MimasのID>` で終わる。近地点と形は衝突の直前まで変わらない（`|Δa|/a` 3.0e-7）ため、外挿による検証では検出できない。
  3. **長い期間での過剰な除外**（`d8b_binary_phase.mjs`）: 直線運動は、ホストの主星を周回する天体の相対運動を、要求期間全体にわたって直線で延長する。アプリの `BINARY_SYSTEM` 配置で、地球の公転位相を 0.1° 刻みで動かすと、Sun B（実際の距離は常に 2.65 AU 以上）の直線上の最接近が地球の近くを通る位相がある。12・36 ヶ月の予測では、LEO／ISS が 0.83〜0.86% の位相で、GTO が 5.39% の位相で、Sun B だけで候補から外れる。安全側ではあるが、同じ近似の妥当性の問題である。
  4. main は安定周回の打ち切りを持たないため、これらの軌道の有効性を主張しない。§4.12 の「要求期間まで有効」の表示は本ブランチで導入されたもので、それが誤っている。
- **修正方針**:
  - 非束縛天体も、ホストとの二体相対運動（双曲線）で最接近を見積もる。接近中（`r·v < 0`）で、近点通過が要求期間内なら近点距離 `h²/(μ(1+e))` を、離れつつあれば現在距離を `d_k,min` とする。これで束縛側と同じ式になり、E = 0 で連続になる。
  - 非束縛天体にも、通過時の影響に見合う余裕を設ける。現行は天体の半径だけで、軽い天体が遠点のすぐ外を通る場合の会合の影響を見ない（G2-6-02 と同じ問題）。
  - ホストの主星を周回する遠方の天体（惑星、連星の伴星など）は、二体の近似も直線の近似も長期間では成り立たない。要求期間内にその天体が `r_apo` ＋余裕まで近づけないことを、速度の上限などから保守的に判定する方法を、あわせて検討すること。
  - 設計補遺 §4.12 L447 を改め、§4.12 の保証の記述と整合させる。
  - 次をテストで固定する（工程 3）。
    - 上記の Moon（f = 0.99／1.01 の組）と Mimas の反例が `settled_orbit` にならないこと。f = 0.99 と 1.01 で判定が同じになること。
    - 月を含むワールドと `SOLAR_SYSTEM` 配置で、LEO/ISS/GTO の既定期間が従来どおり `settled_orbit` になること。

#### G2-6-02 [Major] 束縛衛星の除外境界（`R_k + 3 r_H,k`）のすぐ外側では、外挿による検証が衛星との会合による近点の変化を過小評価する。安全係数 2 を含めた予測近点高度は大気上限以上なのに、要求期間内に大気上限を割る軌道を打ち切る。設計書の木星＋Io の実測は、大気上限の通過で参照計算が NaN になるハーネスによるもので、この誤判定が隠れていた
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:767-793`（外挿による検証。1 周の観測値と、潮汐による下限 `τ × a` の大きい方を、`k = 2N` 倍する）
  - `scripts/gravsim_calc_predictor.js:369-372`（除外境界 `d_min − R_k − 3 r_H,k`）、`scripts/gravsim_const.js:369, 374`（`DRIFT_SAFETY_FACTOR: 2`、`HILL_EXCLUSION_FACTOR: 3`）
  - 設計書 §4.12 L448（「木星＋Io の周回 98 件で、誤判定は 0 件」）、L452-456（外挿と「安全係数 2 で保証される」）
- **現象**（`d3_jupiter_multi.mjs`、`d9r_inst_io.mjs`。木星のパラメータはプリセット）:
  1. 条件: 木星＋Io（Io は円軌道 421,700 km、除外境界 388,363 km）。木星ホストで、近点高度 3,700／3,800 km（大気上限 3,000 km）、遠点半径 384,000 km（除外境界の 4,363 km 内側）の軌道を 16 方位で 0.5 ヶ月予測する。
  2. 結果: 128 件が `settled_orbit` になり、うち 4 件（方位 225°／292.5°）は参照計算で近点高度が 2,645〜2,841 km まで下がる（大気上限を 159〜355 km 下回る）。
  3. 計装した検証（近点高度 3,700 km、方位 225°）:
     - 0.71 日の 1 周の観測で、近点高度の変化は +8.6 km、潮汐比は 7.1e-5、下限 `τ a` は 16.3 km。`k` = 41 で予測近点高度 3,041 km となり、合格する。
     - 参照計算の近点高度は 3,709 → 3,424（1.41 日）→ 3,168（4.95 日）→ 2,949（8.47 日）→ 2,764 km（12.70 日）と、3.53 日ごとに段階的に下がる。これは Io との会合（機体 5 周・Io 2 周）による変化である。
     - 実際の低下（944 km）は、安全係数 2 を含む予測（667 km）を 1.4 倍上回る。観測した 1 周（0.71 日）は会合の周期（3.53 日）より短いため、観測値に会合の影響が入らない。滑らかな潮汐による下限 `τ a` も、会合ごとの近接による変化を表さない。
  4. 地球ホストでも安全係数を使い切る（`d10_edge_satellite_gto.mjs`）: Sun+Earth に `mass-select` の `Enceladus`（1.08e20 kg）を、除外境界が GTO の遠地点の 50 km 外側になる半径 45,000 km の円軌道に置く。`falcon9`／`h3_22` の GTO（近地点 157〜166 km）を 0.5 ヶ月・12 位相で予測すると、打ち切られた 34 件（除外境界の 50 km 外側 21 件、300 km 外側 13 件）で、衝突・大気上限割れはなかった。しかし最悪の事例（`falcon9`、位相 30°。`d10b_inst_enc.mjs` で計装）では、外挿による予測近点高度 108.7 km（予測の低下 47.6 km）に対し、参照計算は 107.8 km（低下 48.8 km）で、安全係数 2 を含む予測を上回った。近地点がもう少し低い軌道では、大気上限を割る。
  5. **設計書の実測が隠していた理由**: Iteration 5 の `c3_jupiter_io.mjs` の木星のパラメータは `ATM_DENSITY_0` を持たない。機体が大気上限より下に入ると参照計算が NaN になり、最低高度の計算から外れる。上の 4 件は、このパラメータでは「最低高度 3,000.0 km・違反なし」に見える（`d3s_io_pe3700.log`。今回の `ab.mjs` では `NONFINITE@8.49d`／`@10.61d` として検出される）。設計書の「98 件で誤判定 0 件」が同じハーネスによるなら、近点の余裕が小さい軌道の誤判定を検出できない。
- **修正方針**:
  - 除外境界の外側にある束縛衛星について、会合による変化を外挿に入れる方法を設計補遺で確定する。例:
    - 観測区間を、境界が `r_apo` の一定倍以内にある衛星との会合周期以上にする（1 周ではなく）。
    - 会合ごとの近点の変化の見積もり（例: 最接近距離 `edge_k − r_apo` での速度変化 `2 G m_k / (s v_rel)` を近点の変化に換算）を、`τ a` に加えて下限とする。
    - `HILL_EXCLUSION_FACTOR` を引き上げ、境界の外側で安全係数 2 が成り立つことを実測で示す（上の木星＋Io では、遠点 384,000 km は Io から約 3.6 r_H）。
  - 方法を決めたら、木星＋Io（近点高度を大気上限の近くにした軌道）、地球＋Enceladus（除外境界のすぐ外側）を、プリセットのパラメータで再計測すること。参照計算では、非有限値を違反として数えること。
  - 設計書 §4.12 L448 の実測に、条件（期間・近点高度・遠点の範囲・方位数・ハーネスのパラメータ）を書くこと。
  - 次をテストで固定する（工程 3）。上記の木星＋Io の 2 方位が `settled_orbit` にならない、または参照計算で大気上限を割らないこと。除外境界の直前・直後の両側。

#### G2-6-03 [Minor] Rev 6.5 で改訂した §4.12 の記述に、実装・実測と合わない箇所と、条件が書かれていない実測がある。工程 3 の境界値テストの期待値として、そのままでは使えない
- **箇所**: 設計書 §4.12 L443（「Sun+Earth では約 72,000 km」）、L445（「重ければ `edge_k = d_k,min`」）、L448（「木星＋Io の周回 98 件」「近点の変化は 70 km 以内」）
- **現象**:
  1. L443: 現行コードの式（太陽の `d_min` = 相対軌道の近点距離 149,399,076 km）で、潮汐比が 1e-4 になる遠点高度は 73,023 km である（`d7_equiv_alt.mjs`）。Iteration 5 の G2-5-02 が示した約 73,000 km とも異なる。
  2. L445: 実装（`gravsim_calc_predictor.js:371-372`）は、重い束縛天体でも `innerEdge = dMin − R_k` とし、半径を引く。記述では半径を引かない。
  3. L448: 「木星＋Io の周回 98 件」の期間・近点高度・遠点の範囲・方位が書かれておらず、再現できない（G2-6-02 のとおり、同じ型の構成で誤判定が出る）。「遠点 15 万〜30 万 km、近点の変化は 70 km 以内」も期間が書かれていない。近点高度 10,000 km・0.5 ヶ月・8 方位では、遠点 30 万 km で最大 76.5 km（Io のみ）、78.3 km（Galilean 4 衛星）だった。
- **修正方針**:
  - L443 を 73,000 km に改める。
  - L445 を実装に合わせる（重い天体も `d_k,min − R_k`）。または実装を記述に合わせる。どちらにするかを決め、境界値テストの期待値と一致させる。
  - L448 の実測に条件（期間、近点高度、遠点の範囲、方位数、木星のパラメータ）を書く。G2-6-01・G2-6-02 の修正で数値が変わる場合は、修正後の値で書くこと。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 第三天体の将来の最接近の見積もり（G2-6-01） | 第三天体の将来位置から軌道の安全性を判断する処理は、`runMultiBodySimulation` の `thirdBodies`／`tidalRatioAt` の 1 箇所だけである（同期の `TrajectoryPredictor` と Worker 経路は同じ関数を呼ぶ: `gravsim_trajectory_predictor.js:315`、`gravsim_calc_predictor.js:134`）。<br>束縛・非束縛の判定（相対エネルギー）もここだけ。`scripts/` で `hill`・`closest`・`tStar`・`dMin` を検索しても、他に同種の処理はない。<br>衝突判定 `getMinSurfaceDist`、ステップ幅、支配天体は各ステップの実際の位置を使い、見積もりを含まない（✓）。 | **要**（設計と実装） |
| 1 周の観測と滑らかな潮汐の下限による外挿（G2-6-02） | 外挿は `runMultiBodySimulation:767-793` の 1 箇所だけ。観測区間は `REVOLUTIONS`（1 周）で固定され、第三天体との会合周期を考慮しない。下限 `τ a` は、潮汐比の最大値（和ではない）を使う。Galilean 4 衛星では最大値と和の差は約 1.25 倍で、今回の計測では違反に結びつかなかった。 | **要**（設計と実装） |
| 大気パラメータを欠く天体での NaN | `CalcRocket.applyAerodynamics`（`gravsim_calc_object.js:158`）は `ATM_DENSITY_0`・`ATM_SCALE_HEIGHT` の有無を確かめずに密度を求める（main も同じ）。`atmLimitAlt` を持つプリセット 8 天体（Earth、Venus、Mars、Jupiter、Saturn、Uranus、Neptune、Titan）はすべて密度と尺度高を持つので、プリセットからは到達しない。一方、監査・テストのハーネスでホストのパラメータを手書きすると、大気上限より下で参照計算が NaN になり、違反が隠れる（G2-6-02 の 5）。Iteration 4・5 の `r_a8b`／`r_a8f`／`r_a8g`（地球のパラメータに密度なし）、`c3`（木星）が該当する。今回の結論に関わるものは、プリセットのパラメータで計算し直した。 | 不要（既存の挙動）。工程 3 のテストでは、プリセットのパラメータを使うか、非有限値を失敗として扱うこと（Watchpoint 2） |
| 新しい定数の SSOT とフォールバック | `HILL_EXCLUSION_FACTOR \|\| 3` は SSOT（3）と一致する。`SETTLED_ORBIT` の他の 4 定数のフォールバックも一致する（`1`、`2`、`0.02`、`1e-4`）。 | 不要 |
| コメントと記述 | `gravsim_calc_predictor.js:350-355` のコメントは実装と一致する。`gravsim_const.js:372-373` は、軽い束縛天体の場合だけを説明している（誤りではない）。設計書との不一致は G2-6-03。 | 要（G2-6-03） |
| 過剰な除外（打ち切ってよい軌道） | アプリの配置で確認した（`d6_solar_system_profile.mjs`、`d8_profile.mjs`）。<br>・`SOLAR_SYSTEM`（21 天体）: LEO/ISS は既定〜36 ヶ月、GTO は既定・1 ヶ月で、4 方位すべて `settled_orbit`。GTO 3 ヶ月以上は月の潮汐で `step_budget`（7 天体と同じ）。地球から見て潮汐比が最大の第三天体は月（GTO の遠地点で 3.85e-5）と太陽（1.57e-5）。非束縛の惑星は 3e-10 以下。<br>・`BINARY_SYSTEM`: 配置直後の LEO/ISS は `settled_orbit`、GTO は Sun A の潮汐比（3.5e-4）で `step_budget`。長い期間では、公転位相によって Sun B の直線近似で除外される（G2-6-01 の 3）。 | G2-6-01 の修正で対応 |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G2-6-01・G2-6-02 の修正は、既定期間での打ち切りと両立させること**: 非束縛天体の見積もりを双曲線にし、境界の外側に余裕を足すと、`SOLAR_SYSTEM` などの多天体配置で LEO/ISS/GTO が打ち切られなくなる可能性がある。修正後は §4.3 の表、方位 8 通り、7 天体ワールド、`SOLAR_SYSTEM` 配置、同期ブロック時間を再計測すること。
2. **参照計算との比較では非有限値を失敗として扱うこと**: 手書きのホストのパラメータに `ATM_DENSITY_0`・`ATM_SCALE_HEIGHT` がないと、大気上限より下で予測が NaN になる。工程 3 のテストでは、プリセットのパラメータ（`presetManager.getObjectParam`）を使うこと。
3. **同期ブロック時間の受入基準のワールド**: §4.12 の受入基準は 7 天体ワールドで定義されている。アプリの `SOLAR_SYSTEM` 配置（21 天体）では、本ブランチの最悪は GTO 3〜36 ヶ月の 3,905〜4,021 ms（main の最悪は 月遷移 36 ヶ月などの 3,294〜3,393 ms）で、2 秒を超える。main 比では 1.5 倍以内に収まる。基準の対象にこの配置を含めるかを決めておくこと。
4. **境界値テスト**: G2-6-01 の修正後は、束縛と非束縛の境界（f = 0.99／1.01 の組）で判定が連続であることをテストで固定すること。Iteration 5 の Watchpoint 1（除外境界の直前・直後）と Watchpoint 4（`MAX_TIDAL_RATIO`・`DRIFT_SAFETY_FACTOR`・`MAX_PROJECTED_SHAPE_CHANGE`・大気上限との比較）も引き続き有効。
5. **「7 天体ワールド」の定義**: 設計書の 7 天体ワールドは Sun/Earth/Moon/Venus/Mars/Jupiter の 6 天体である（ロケットを含めて 7 オブジェクト）。テストではこの構成を明示的に組むこと。
6. **Iteration 5 の Watchpoint 2・5・6 は引き続き有効**: 長い期間の GTO では飛行中に予測線が約 1.8 日で消えること、近点方向の回転は検証の対象外であること、Iteration 4 の Watchpoint 3〜8。Iteration 1・2 の Watchpoint（スナップショットなしで保存した場合の劣化、ツールチェーンのバージョン固定など）と、lint 警告 54 件（testsuites）も残る。

---

## 独立監査2: 実装監査 — Iteration 7

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 7
- **実施日時**: 2026-11-20 23:00 JST
- **判定**: **FAIL**（Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.6、Iteration 1〜6 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03、G2-5-01〜G2-5-02、G2-6-01〜G2-6-03）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 6 の監査終了時の全ファイルの md5（`gate2_it6/md5_after.txt`）を現行ツリーと突き合わせた。Iteration 6 以降に変更されたのは次の 3 ファイルと設計書だけで、テスト・プリセット・`package.json`・`types/`・他のソースは変わっていない。Iteration 6 時点の原本は scratchpad 内のコピーで md5 が一致するもの（`gate2_it6/nosettle_tree/scripts/gravsim_calc_predictor.js`、`gate2_it6/inst_tree/scripts/gravsim_const.js`・`gravsim_flight_computer.js`）を使い、差分を全行読んだ。差分はすべて削除で、追加は `maxSimTime` の 1 行とコメント 1 行だけである。
  - `scripts/gravsim_calc_predictor.js`: `settledCfg` 系の定数 6 個、`thirdBodies`、`tidalRatioAt`、`settledSweepRad`・`prevSettledAngle`・`settleRef`、ループ末尾の安定周回の判定と外挿による検証（約 65 行）を削除。戻り値の `maxSimTime` を `points[points.length - 1]?.time || simTime` に一本化（`:727-728`）。
  - `scripts/gravsim_const.js`: `TRAJECTORY_PREDICTION.SETTLED_ORBIT`（5 定数とコメント）を削除。
  - `scripts/gravsim_flight_computer.js`: `hasAnyScheduledAction()` を削除。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。監査開始時と終了時で、`git status --short` と、`scripts/`・`testsuites/`・`presets/`・`types/`・`docs/`（本ファイルを除く）・設定ファイルの全ファイル（139 件）の md5 が一致することを確認した。
- **描画座標系での計測**: 実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標で測った（ズーム 1e9、Iteration 3 の `v1_drawn.mjs` の `capture`）。プレビューと飛行中（射点で 37 s 待機した想定。0 s、100 s、切替の前後、切替 + 3,000 s、終端の半分、終端の 1 s 前）の 7 時刻に加え、終端の直後（最終点の時刻 + 0.001 s）に線が消えることを確かめた。
- **実経路での計測**: 予測は `ObjectPlacer.placeObject` → `PresetManager.applyToLauncher` → `RocketLauncher.updatePredictionSync()`／`rollout()` の実経路で求めた。Iteration 2〜6 のハーネス（`e2e.mjs` 系の `s1`・`s2`・`s3`・`s8`・`s9`、`v2_flight_frame.mjs`）を再実行した。
- **スクリプト**: 検証スクリプトとログは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it7/` に置いた（`e1`〜`e6`、`g1`、`t1`〜`t4`、ログ `*.log`、集計 `t1_summary.txt`）。
- **ワールド**: Sun+Earth（SE）、7 天体ワールド（W7: Sun/Earth/Moon/Venus/Mars/Jupiter）、アプリの配置プロファイル `SOLAR_SYSTEM`（SS、21 天体）・`BINARY_SYSTEM`（BIN: Sun A/Sun B/Earth/Moon/Jupiter）・`THREE_BODY`（TB: 恒星 3 個と Earth）。後の 3 つは `ObjectPlacer.deployProfile` で配置した（Deploy タブと同じ経路）。
- **比較用ツリー**: `scratchpad/main_tree/`（`git show main:` と `scripts/`・`presets/`・`testsuites/` の 130 ファイルが一致することを確認した）。main との比較では、main_tree を cwd にし、`GS_ROOT` を設定した。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/` の 16 ファイル。`scripts/` は 0 件。Iteration 6 と同一） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**安定周回の機構の除去**:

| 確認項目 | 結果 |
|---|---|
| コード・定数・型 | `scripts/`・`testsuites/`・`types/`・`presets/`・`index.html`・`style.css` で `settl`（`POST_SEP_SETTLE_S` を除く）・`SETTLED_ORBIT`・`hasAnyScheduledAction`・`tidal`・`hill`・`extrapolat`・`REVOLUTIONS`・`DRIFT_SAFETY`・`PROJECTED_SHAPE`・`安定`・`周回` を検索し、残骸 0 件（`tidal` は既存の `DebrisGenerator` の潮汐破砕のみ）。 |
| 削除後に未使用になった識別子 | なし。`hostAtmLimitAltM`（座標系切替 `:646`）、`curInertialPhi`（`:381`）、`MathUtils`（`:424` ほか）、`mu`（`:580`）は引き続き使われる。ESLint の `no-unused-vars` は `scripts/` で 0 件。 |
| 残した関連処理 | `FlightComputer.hasPendingBurnStep()` は `CalcRocket`（`gravsim_calc_object.js:1306`）が使う（§4.5）。`_triggeredActionIndices` は保存・復元とラッチで使う。いずれも安定周回とは独立。 |
| コメント | `gravsim_calc_predictor.js:630-633`（角度の上限の理由）と `:727`（実際に積分した範囲だけが有効）は、新しい方針と一致する。古い記述は残っていない。 |
| 設計書 | `SETTLED_ORBIT`・`settled_orbit`・潮汐比・ヒル半径・外挿は §4.3 L341（廃止の経緯）と §4.12 L436（削除の宣言）にだけ現れる。Rev 6.5 の記述（約 72,000 km、98 件、70 km、`edge_k`、安全係数 2、Mimas、Io）は残っていない。 |
| 結果の消費側 | `endReason`・`maxSimTime` を読むのは `TrajectoryPredictor`（Worker 経路 `:60-63`、描画の消去判定 `:537-541`）だけ。`settled_orbit` に依存する分岐は他にない。 |

**Iteration 6 指摘の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-6-01 | ✓ 解消（機構の廃止） | `thirdBodies`（直線運動・二体の最接近の見積もり）が削除され、見積もりに基づく判定経路が存在しない。Iteration 6 の反例を実経路で再実行した（`g1_it6_counterexamples.mjs`）。<br>・Moon を f = 0.99／1.01 で投げ入れた GTO（既定 0.5 ヶ月、8 方位 × 2）: 16 件すべて `step_budget`、最終点 1.197 日、`maxSimTime` = 最終点の時刻。f = 0.99 と 1.01 で結果は同じ（境界の不連続はなくなった）。<br>・非束縛の Mimas（9.935 日に衝突する初期状態）: 0.5 ヶ月は `step_budget` 1.197 日、12 ヶ月は `step_budget` 1.802 日。いずれも `maxSimTime` = 最終点の時刻。<br>・全件、飛行中は最終点の時刻 − 1 s で線が描かれ、最終点の時刻 + 0.001 s で消える。衝突の前に予測線が消えるので、衝突する軌道を閉じた楕円として表示し続けることはない。 |
| G2-6-02 | ✓ 解消（機構の廃止） | 外挿による検証が削除された。木星（プリセットのパラメータ）＋Io、近点高度 3,700 km・遠点 384,000 km・16 方位・0.5 ヶ月: 16 件すべて `step_budget`（6.04〜7.07 日）、`maxSimTime` = 最終点の時刻。非有限値 0 件。予測は計算した範囲だけを表示する。 |
| G2-6-03 | ✓ 解消 | §4.12 は置き換えられ、指摘した L443・L445・L448 の記述（約 72,000 km、重い天体の `edge_k`、木星＋Io の 98 件、70 km）は削除された。 |
| Iteration 6 WP1（既定期間での打ち切りとの両立） | ― 対象外 | 打ち切りがなくなったため。既定期間の結果は下記の §4.3 の突合を参照。 |
| Iteration 6 WP2（参照計算の非有限値） | ✓（継続） | 今回のスクリプトはプリセットのパラメータを使い、非有限値を検査した（`e1`・`g1`。0 件）。工程 3 でも有効。 |
| Iteration 6 WP3（受入基準のワールド） | ✓ | §4.12 の受入基準は「全ワールドで main 比 1.5 倍以内、7 天体では 2 秒以内」に改められ、`SOLAR_SYSTEM` 配置も表に含まれた。下記の実測で満たす。 |
| Iteration 6 WP4（打ち切りの境界値テスト） | ― 対象外 | 判定がなくなったため。 |

**Iteration 1〜5 指摘の回帰確認**:

| ID | 結果 |
|---|---|
| G2-01 / G2-02 | ✓ 回帰なし。`s1_init_paths.mjs` の出力は Iteration 6 と完全に一致する。 |
| G2-03〜G2-09 | ✓ 回帰なし。該当ファイルは Iteration 6 以降変更されていない。予測器の変更は安定周回の判定の削除だけで、サンプラー・切替判定・衝突／破壊の打ち切りは 1 行も変わっていない。 |
| G2-10、G2-2-03 | ✓ §4.3 の終了理由の表・保証 5 は実測と一致する（下記）。 |
| G2-3-02（保証の適用範囲） | △ 同じ型が保証 4 で再発した。Sun+Earth・7 天体・`SOLAR_SYSTEM` では成り立つが、`BINARY_SYSTEM`・`THREE_BODY` 配置では成り立たない（G2-7-01）。 |
| G2-2-01、G2-3-01、G2-4-02（描画座標系） | ✓ Sun+Earth の 7 ミッション × 7 期間（0.2/0.3/0.5/1/3/12/36 ヶ月）× 8 方位（392 件）で、描画上の最大角度ステップ 0.120 rad、0.15 rad 超 0 件、点数 3,000 以下、時刻の非単調 0 件、非有限値 0 件。切替時刻は Iteration 6 と同じ（ISS h3_22 1,888.3 s、LEO h3_30 599.0 s、GTO 526.8 s）。 |
| G2-2-02、§4.11（破壊・衝突） | ✓ 392 件で、`impact` イベントの有無と `endReason === 'impact'`、`breakup` イベントの有無と `endReason === 'breakup'` は全件一致。最終点より後の時刻のイベント 0 件。 |
| G2-2-04（同期ブロック時間） | ✓ 下記の受入基準を満たす（5 ワールド）。 |
| G2-3-03（実飛行経路） | ✓ `v2_flight_frame.mjs`（実経路で約 70 時間、5 構成）で、実飛行経路の最大角度ステップ・機体と予測線の距離は Iteration 6 と同水準（LEO/ISS 3.3〜3.6 km、GTO 28.2 km、Lunar 1,287 km、Mars 66.8 km。Lunar・Mars は完全に一致）。LEO/ISS/GTO は Iteration 6 では要求期間まで線が描かれていたが、今回は最終点（39,262 s／39,358 s／155,735 s）の直後の 40,000 s／40,000 s／157,500 s で消える（下記）。 |
| G2-4-01、G2-4-03、G2-5-01、G2-5-02 | ✓ 対象の機構・定数・記述ごと削除された（`REVOLUTIONS` のフォールバックを含む）。 |
| 実経路飛行 15 構成（`s2_flights.mjs`） | **墜落 0・同期不一致 0**。出力は Iteration 6 と完全に一致する。 |
| save/load（スナップショットあり、15 時点。`s3_saveload.mjs snapshot`） | 全件で墜落 0。Iteration 6 との差分は保存処理の所要時間（`saveMs`）だけ。 |
| スリングショット機の save/load（`s9`）、旧セーブ形式（`s8`） | Iteration 6 と完全に一致する。 |

**補遺 §4（Rev 6.6 分）と実装の突合**:

- §4.3 の終了理由の表: 実装は表のとおり 6 種類だけを返す（`no_host` は `steps: 0`・点 0）。ステップ予算は `min(MAX_STEPS_CAP, max(MAX_STEPS, ceil(maxSimTime / 5)))`（`gravsim_calc_predictor.js:160`、`MAX_STEPS = 120,000`・`MAX_STEPS_CAP = 400,000`、`gravsim_const.js:308-309`）。`maxSimTime` は常に最終点の時刻（`:728`）で、392 件 + 1200 s の 7 件 + 反例 34 件の全件で `maxSimTime === 最終点の時刻` を確認した。
- §4.3 の保証 1〜5（Sun+Earth の 392 件、`e1_se_az8.log`）:
  1. 描画上の最大角度ステップ 0.120 rad（プレビューと飛行中の 7 時刻）。✓ W7 では最大 0.124 rad、BIN 0.135 rad、TB 0.127 rad（深宇宙の 36 ヶ月。いずれも 0.15 rad 以下で、保証の「`MAX_ANGLE_STEP_RAD` ＋ 1 積分ステップ分」の範囲内。`e1_w7_*`・`e1_ss_az2`・`e6_*`）。
  2. 点数 3,000 以下、時刻は単調増加、`endReason` は表のいずれか。飛行中は最終点の時刻を過ぎると線が消え、それより前には消えない。✓
  3. LEO/ISS/GTO は全 7 期間 × 8 方位で `step_budget`。0.2 ヶ月の切替後の描画は LEO 1.90 周、ISS 1.73 周、GTO 1.32 周（方位によらない）。✓ W7・SS（各 4 方位、6 期間）と BIN・TB（各 5 方位、0.2/1/36 ヶ月）でも全件 `step_budget`、0.2 ヶ月の最終点は Sun+Earth と同じ時刻（±2 s）、切替後の描画は同じ周数。
  4. 深宇宙 3 ミッションは全 7 期間 × 8 方位で `horizon`／`point_budget`、到達率 ≥ 99.91%。✓ 7 天体と `SOLAR_SYSTEM` でも、12・36 ヶ月 × 8 方位と全期間 × 4 方位で同じ（最小 99.91%）。**ただし `BINARY_SYSTEM`・`THREE_BODY` 配置では 36 ヶ月の到達率が最小 93.38% に下がり（48 件中 40 件が 99.9% 未満）、保証が成り立たない（G2-7-01）**。
  5. 月遷移は `step_budget`／`breakup`。✓ 方位 90°・135° の `breakup` は、5.1〜5.2 日の遠地点（386,000〜388,600 km）のあとで近地点が下がり、10.25〜10.39 日に高度 63〜80 km で破壊される。方位 0° は同じ時期に近地点が 1,264 km に上がる（`e4_lunar_breakup.mjs`）。設計の「太陽摂動により近地点が下がり」と一致する。
- §4.3 の実測表（方位 0°）: 7 ミッション × 5 期間の点数・最終時刻・終了理由・描画上の最大角度ステップは、表と全件一致する（例: ISS 0.2 ヶ月 11,262 s・1,528 点、GTO 1〜36 ヶ月 155,735 s・1,797〜1,820 点、Mars 1〜36 ヶ月 2,965〜3,000 点、Solar 36 ヶ月 0.112 rad）。「約 N 周」は打上げからの慣性系の回転量（ISS 2.0、GTO 1.35）と一致する。
- §4.3 の打上げ方位 8 通り: LEO 0.2・ISS 0.3・GTO 0.5 ヶ月は全方位 `step_budget`（0.13／0.17／1.20 日）。Jupiter・Solar 36 ヶ月と Mars 12 ヶ月は全方位 `horizon`。Mars 36 ヶ月は 3 方位 `horizon`・5 方位 `point_budget`（99.91〜99.98%）。Lunar 1 ヶ月は 4 方位 `step_budget`（17.27〜17.40 日）・4 方位 `breakup`（10.25〜10.39 日）。すべて記述どおり。
- §4.3 の 1200 s: 7 ミッションすべて `horizon`、1,122〜1,631 点。✓
- §4.12 のステップ下限の根拠「100,000 では 0.998 周」: 結論（1 周に届かない）は再現する。ただし数値は測り方で変わる（Watchpoint 2）。
- §4.12 の main の到達範囲「約 33,000 s、月遷移 36,552 s」: main_tree の実測で、1 ヶ月以上の LEO 32,758 s、ISS 32,579 s、GTO 35,439 s、月遷移 36,552 s（いずれも 3,000 点で打ち切り）。✓ 既定期間では、main は LEO 9,877 s、ISS 15,049 s、GTO 25,693 s、本ブランチは 11,358 s、15,041 s、103,410 s で、本ブランチの到達範囲は main 以上（ISS は同等）。
- §4.12 の受入基準（`rollout()` の同期ブロック時間）: 下記。
- Rev 6 本文との矛盾: なし（Rev 6 §1・§3.1.2 の「0.2〜36 ヶ月完走」「12〜36 ヶ月で 2,494〜2,533 点」は §4.3 が明示的に撤回している）。

**同期ブロック時間**（`rollout()`、`t1_rollout_matrix.mjs`。7 ミッション × 6 期間（既定・0.2・1・3・12・36 ヶ月）× 4 方位（0°/90°/180°/270°）× 3 ワールド。本ブランチと main をワールドごとに交互に 2 回ずつ実行し、構成ごとに最小値をとって、4 方位の最大を示す。load average 1.3〜3.8／16 コア）:

| 構成 | 7 天体 本ブランチ | main | `SOLAR_SYSTEM` 本ブランチ | main | Sun+Earth 本ブランチ | main |
|---|---|---|---|---|---|---|
| `leo_250km` 既定（0.2 ヶ月） | 317 ms | 231 ms | 671 ms | 586 ms | 196 ms | 146 ms |
| `iss_rendezvous` 既定（0.3 ヶ月） | 598 ms | 514 ms | 1,495 ms | 1,385 ms | 400 ms | 328 ms |
| `gto_insertion` 既定（0.5 ヶ月） | 964 ms | 828 ms | 2,408 ms | 2,246 ms | 565 ms | 487 ms |
| `lunar_insertion` 既定（1 ヶ月） | 1,428 ms | 1,143 ms | 3,676 ms | 3,155 ms | 908 ms | 675 ms |
| `leo_250km` 3 ヶ月 | 852 ms | 611 ms | 2,090 ms | 1,967 ms | 471 ms | 345 ms |
| `iss_rendezvous` 12 ヶ月 | 1,415 ms | 1,027 ms | 3,624 ms | 2,850 ms | 858 ms | 620 ms |
| `iss_rendezvous` 36 ヶ月 | 1,410 ms | 1,036 ms | 3,608 ms | 2,868 ms | 853 ms | 603 ms |
| `gto_insertion` 3〜36 ヶ月 | 1,420〜1,438 ms | 1,099〜1,111 ms | 3,668〜3,679 ms | 3,084〜3,112 ms | 869〜892 ms | 658〜671 ms |
| `lunar_insertion` 36 ヶ月 | 1,425 ms | 1,130 ms | 3,652 ms | 3,178 ms | 891 ms | 677 ms |
| 深宇宙 3 ミッション（全期間） | 373〜495 ms | 413〜1,525 ms | 770〜948 ms | 911〜3,200 ms | 195〜271 ms | 201〜752 ms |

- 受入基準「全ワールド・全期間で main 比 1.5 倍以内」: 各構成の方位ごとの比の最大は、7 天体 1.44（`iss_rendezvous` 3 ヶ月）、`SOLAR_SYSTEM` 1.28（`iss_rendezvous` 1〜3 ヶ月）、Sun+Earth 1.44（`leo_250km` 1 ヶ月）。Sun+Earth は比が最も大きいため、LEO/ISS/GTO/Lunar × 5 期間 × 4 方位を 5 回交互に計り直した（`run_t3.sh`）: 最小値どうしの比の最大 1.43、中央値どうしの比の最大 1.49（`leo_250km` 1 ヶ月の 1 方位）。✓（余裕は小さい。Watchpoint 1）
- 受入基準「7 天体ワールドでは最悪 2 秒以内」: 最悪 1,464 ms（`lunar_insertion` 12 ヶ月。2 回の計測の大きい方をとっても 1,580 ms）。✓
- §4.12 の表（Rev 6.6 の実測）とは絶対値が異なる（計測時の負荷の違い）が、比は同程度である（表の最大比 1.39 に対し、今回は 1.28〜1.44）。表に Sun+Earth の行はないが、同じ基準を満たす。
- 追加のワールド（`t2_rollout_profiles.mjs`・`t2b_rollout_profiles.mjs`。2 回交互、2 方位）: `BINARY_SYSTEM` は最大比 1.38（`leo_250km` 36 ヶ月。最大 1,301 ms）、`THREE_BODY` は最大比 1.40（`iss_rendezvous` 36 ヶ月。最大 1,121 ms）。✓

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-7-01 [Minor] Rev 6.6 で書き直した §4.3 の保証 4 にワールドの条件がなく、アプリの配置プロファイル `BINARY_SYSTEM`・`THREE_BODY` では成り立たない（36 ヶ月の到達率は最小 93.38%、48 件中 40 件が 99.9% 未満）。工程 3 の到達率アサーションの前提として、そのままでは使えない（G2-3-02 と同じ型）
- **箇所**:
  - 設計書 §4.3 L346（保証 4「【ホスト離脱軌道：深宇宙 3 ミッションのプリセット】全期間・全打上げ方位で `endReason ∈ {horizon, point_budget}`、到達率 ≥ 99.9%」）
  - 関連する実装（変更は不要）: `scripts/gravsim_calc_predictor.js:630-641`（`sampleByAngleCap`。点の予算より滑らかさを優先する）、`:352`（`points.length < maxPoints` で打ち切る）
- **現象**（`e5_profiles_guarantee4.mjs`、`e6_table_profiles.mjs`。実経路 `deployProfile` → `applyToLauncher` → `updatePredictionSync`、8 方位）:
  1. 深宇宙 3 ミッションの 36 ヶ月は、`BINARY_SYSTEM` で全 24 件、`THREE_BODY` で全 24 件が `point_budget` で終わり、到達率は次のとおり。
     - `BINARY_SYSTEM`: Mars 95.47〜99.88%、Jupiter 95.17〜99.92%、Solar 97.41〜99.90%（99.9% 未満は 20/24 件。Solar の最大 99.90% は 99.897%、`e5b_exact.mjs`）。
     - `THREE_BODY`: Mars 95.46〜99.88%、Jupiter 95.61〜99.91%、Solar 93.38〜99.90%（99.9% 未満は 20/24 件）。
     - 最も短い例（`THREE_BODY`、Solar、方位 45°）は 1,023.2 日（到達率 93.38%）で終わり、要求期間（1,095.75 日）の 72.5 日前に予測線が消える。
  2. 原因: これらのワールドでは地球が主星から 0.35 AU を周回しているため、ホスト中心の描画では離脱後の機体がホストのまわりを 9〜15 周する。各周に `MAX_ANGLE_STEP_RAD`（0.12 rad）ごとの点が必要になり、3,000 点の予算が要求期間より先に尽きる。これは §4.3 の「点数予算が尽きた場合は…`MAX_POINTS` で打ち切る」どおりの動作で、描画上の最大角度ステップは 0.121〜0.135 rad（保証 1 は成り立つ）。実装の不具合ではなく、保証 4 の記述の適用範囲の問題である。
  3. 同じ保証は、Sun+Earth（全 7 期間 × 8 方位）、7 天体と `SOLAR_SYSTEM`（12・36 ヶ月 × 8 方位、全期間 × 4 方位）では成り立つ（最小 99.91%）。余裕は 0.01 ポイントしかない。`BINARY_SYSTEM`・`THREE_BODY` の 12 ヶ月の Mars も 99.90%（31,526,351 s／31,557,600 s = 99.901%）で境界上にある。
  4. 保証 3（Rev 6.5 ではワールドごとの表があった）も Rev 6.6 でワールドの条件が消えたが、こちらは 5 ワールドすべてで成り立つ（上記）。保証 1・2・5 は「全予測」の記述どおり 5 ワールドで成り立つ。
  5. main は 3,000 点で約 33,000 s に打ち切られるため、本ブランチからの回帰ではない（記述の誤り）。
- **修正方針**:
  - 保証 4 にワールドの条件を書く（例: 「Sun+Earth・7 天体ワールド・`SOLAR_SYSTEM` 配置で」）。`BINARY_SYSTEM`・`THREE_BODY` などのホストが主星の近くを周回するワールドについては、`endReason ∈ {horizon, point_budget}` だけを保証し、到達率は実測の範囲（36 ヶ月で 93〜100%）を示す、または保証しないと明記する。
  - 到達率の閾値 99.9% は、成り立つワールドでも余裕が 0.01 ポイントしかない。工程 3 のテストがわずかな変更で壊れないよう、閾値を見直す（例: 99.5%）か、閾値と実測の最小値（99.91%）を併記する。
  - 横展開: §4.3・§4.12 の他の「全〜」の記述（保証 1・2・3・5、受入基準「全ワールド」）は、5 ワールドで成り立つことを確認した（下記の横展開表）。ワールドを限定する場合は、それらの記述と整合させること。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 計算していない期間の有効性の主張（G2-6-01・G2-6-02 の本質） | 予測の有効期間を決めるのは `runMultiBodySimulation` の戻り値 `maxSimTime`（`gravsim_calc_predictor.js:728`、最終点の時刻）だけ。消費側は `TrajectoryPredictor.renderTrajectory:537-541`（`currentFlightTime >= maxTime` で消去）だけである。<br>Worker 経路の `data.maxSimTime || TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC`（`gravsim_trajectory_predictor.js:60`）は `maxSimTime` が 0 のとき 1 年に置き換える。0 になるのは点が 1 個以下（`no_host`、初回ステップでの終了）のときだけで、`renderTrajectory` は点 2 個未満で何も描かないため、表示には影響しない（main と同じ既存の挙動。Watchpoint 4）。<br>`rotatePrediction`（旧形式）と打上げ時のコピー（`gravsim_rocket_launcher.js:98, 106, 648`）は `maxSimTime` をそのまま引き継ぐ。<br>`scripts/` で `kepler`・`conic`・`extrapol`・`validUntil`・`horizon` を検索しても、解析的な軌道で予測を延長する処理はない。 | 不要 |
| 予測の早期打ち切り（判定による `break`） | ループの `break` は、衝突（`:395-408`）、破壊（`:410-418`）、要求期間の端での `dt <= 0.01`（`:367`）の 3 箇所だけ。いずれも実際の状態に基づき、将来の見積もりを含まない。 | 不要 |
| 削除した機構の残骸 | 上記「安定周回の機構の除去」のとおり 0 件。テスト（`testsuites/`）にも `settled_orbit`・`SETTLED_ORBIT`・`hasAnyScheduledAction` を参照するものはない。 | 不要 |
| 削除に伴う未使用コード・デッドコンフィグ | 削除による新たな未使用はない。一方、`TRAJECTORY_PREDICTION` には main から引き継いだ未使用キーがある: `MIN_DURATION_MONTHS`、`EVENTS.PITCH_DEFAULT_ALT_M`、`EVENTS.APOAPSIS_MIN_STEP`、`SYNC.MAX_STEPS`・`MAX_FLIGHT_TIME_S`・`DT_LOW_ALT`・`DT_MID_ALT`・`DT_HIGH_ALT`・`ALT_BOUNDARY_LOW_M`・`ALT_BOUNDARY_MID_M`（`SYNC` で使われるのは `POWERED_CUTOFF_S` だけ）。main でも同じく未使用で（main ではさらに `EVENTS.ORBIT_HORIZONTAL_VEL_MIN_M_S` も未使用。本ブランチで削除済み）、本ブランチが持ち込んだものではない。 | 不要（既存。Watchpoint 5） |
| ワールドの条件のない保証・基準（G2-7-01） | §4.3 の保証 1〜5 と §4.12 の受入基準を、5 ワールド（SE、W7、SS、BIN、TB）で確かめた。<br>・保証 1（描画上の角度ステップ ≤ 0.15 rad）、保証 2（点数・単調性・終了理由・最終点での消去）、保証 3（LEO/ISS/GTO の `step_budget` と切替後 1 周以上）、保証 5（月遷移）: 5 ワールドすべてで成り立つ。<br>・保証 4: SE・W7・SS で成り立ち、BIN・TB で成り立たない（G2-7-01）。<br>・受入基準「全ワールドで main 比 1.5 倍以内」: 5 ワールドで成り立つ（最大 1.44）。「7 天体で 2 秒以内」: 最悪 1,464 ms。<br>・§4.3 の実測表・方位 8 通りは「Sun+Earth」と明記されており、条件の不足はない。 | **要**（G2-7-01） |
| ステップ上限の迂回 | `options.maxSteps` は `Math.max(options.maxSteps, computedMaxSteps)` で上限を超えられる（`:161`、main と同じ）。アプリの呼び出し側（`RocketLauncher._getPredictionContext` → `_buildSimulationParams:244`）は `config.maxSteps` を設定しないため、アプリでは常に `MAX_STEPS_CAP` 以下になる。 | 不要（Watchpoint 6） |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **同期ブロック時間の余裕は小さい**: main 比の最大は 1.44（7 天体の `iss_rendezvous` 3 ヶ月、Sun+Earth の `leo_250km` 1 ヶ月）で、基準 1.5 との差は 4% しかない。比は「ステップ数の比（400,000 対 main の 333,000〜360,000 ≒ 1.11〜1.20。`t4_step_count.mjs`）×1 ステップあたりのコストの比（約 1.2）」で決まり、天体が少ないワールドほど 1 ステップあたりのサンプラーの処理の比率が上がって大きくなる。工程 3 で計時を CI のアサーションにする場合は、交互実行・複数回の最小値で比べ、単発の計測では判定しないこと。サンプラーに処理を足す変更では、Sun+Earth と 7 天体の LEO/ISS を再計測すること。
2. **§4.12「100,000 では 0.998 周」の測り方**: `MAX_STEPS = 100,000` でも、0.2 ヶ月（525,960 s）では `ceil(maxSimTime / 5) = 105,192` が下限を上回るため、実際の予算は 105,192 ステップになる。このとき GTO は、切替後の描画上の回転量 0.949 周、時間／周期で 0.996 周（周期 38,089 s）だった（`e3b_rev_definition.mjs`）。0.998 はどちらとも一致しないが、結論（1 周に届かない。120,000 では 1.32 周）は成り立つ。保証 3 のテストは描画上の回転量（切替後のホスト中心の角度の累積）で判定し、時間／周期を使わないこと。
3. **飛行中の予測線は最終点で消える**: LEO/ISS は既定期間で約 0.13〜0.17 日（約 2〜3 周）、1 ヶ月以上で 0.45〜0.46 日、GTO は既定で 1.20 日、1 ヶ月以上で 1.80 日で消える（main は 0.11〜0.41 日）。Iteration 6 までは LEO/ISS/GTO の多くの構成で要求期間まで描いていたので、工程 3 の E2E は「最終点の時刻 − ε で描画あり、+ ε で描画なし」を期待値にすること。延長表示を前提にしたテストは書かないこと（予測の継ぎ足しは別課題）。
4. **Worker 経路の `maxSimTime` の既定値**: `gravsim_trajectory_predictor.js:60` の `data.maxSimTime || MAX_SIM_TIME_SEC` は、点 1 個以下の結果で `maxSimTime` を 1 年に書き換え、同期経路（`calculateSync`、0 のまま）と値が食い違う。描画には影響しないが、工程 3 で `no_host` などの異常系を Worker 経路と同期経路で比べるテストを書く場合は、この差を期待値に入れるか、別途修正を検討すること。
5. **既存のデッドコンフィグ**: `TRAJECTORY_PREDICTION.SYNC` の 7 キー（「Fallback synchronous simulation limits」というコメントつき。`SYNC.MAX_STEPS: 400`）などは main から未使用のまま残っている。§4.12 の同期予測の上限（`MAX_STEPS_CAP`）と紛らわしいので、§3.2 の不要コード削除として、別の変更で整理することを推奨する。
6. **`options.maxSteps` は上限を超えられる**: 監査・テストのハーネスでは便利だが、`MAX_STEPS_CAP` は「アプリの呼び出し経路での上限」である。工程 3 で上限のテストを書く場合は、`options.maxSteps` を渡さない経路で確かめること。
7. **設計書の補遺ヘッダ**: §4 の「改訂日: 2026-11-20 18:20 JST」は Rev 6.1 の日時のままで、「位置付け」の「独立監査2 Iteration 2 の突合対象に含める」も古い。内容の矛盾ではないが、工程 3 以降で補遺を参照する際は、L3 の改訂履歴（Rev 6.6）を正とすること。
8. **引き続き有効な Watchpoint**: Iteration 6 の WP2（非有限値を失敗として扱う）・WP5（7 天体ワールドの定義: Sun/Earth/Moon/Venus/Mars/Jupiter の 6 天体＋ロケット）。Iteration 4 の WP2（保証 3 は §4.3 の表の機体の組合せに限る）・WP3（直接上昇型の離脱での ORBIT マーカー）・WP4（衝突イベントは id で判定）・WP5（無大気天体での閾値 100 km。安定周回に関する部分は対象外になった）・WP6（高ロフト弾道の着地点）・WP7・WP8。Iteration 1・2 の Watchpoint（スナップショットなしで保存した場合の劣化、ツールチェーンのバージョン固定など）と、lint 警告 54 件（testsuites）も残る。安定周回の閾値・外挿・第三天体に関する Watchpoint（Iteration 4 WP1、Iteration 5 WP1・WP3〜WP5、Iteration 6 WP1・WP4）は、機構の廃止で対象外になった。

---

## 独立監査2: 実装監査 — Iteration 8

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 8
- **実施日時**: 2026-11-21 00:51 JST
- **判定**: **FAIL**（Minor 3 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.7、Iteration 1〜7 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03、G2-5-01〜G2-5-02、G2-6-01〜G2-6-03、G2-7-01）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 7 の監査終了時の md5（`gate2_it7/md5_final.txt`、139 件）を現行ツリーと突き合わせた。変更されたのは次の 3 ファイルだけで、テスト・プリセット・`package.json`・`types/`・他のソース・本ファイルは変わっていない。Iteration 7 時点の原本のコピーは scratchpad になかったため、現行ファイルから申告された変更だけを元に戻したものを作り、その md5 が Iteration 7 の値（`772217092877…`、`f108231df3fa…`）と一致することを確かめた。したがって、コードの差分は次の 3 行（とコメント 1 行）だけである。
  - `scripts/gravsim_calc_predictor.js:161-162`: `maxSteps = Math.min(maxStepsCap, options.maxSteps ? Math.max(options.maxSteps, computedMaxSteps) : computedMaxSteps)`（コメント 1 行を追加）。
  - `scripts/gravsim_calc_predictor.js:729`: `maxSimTime: points[points.length - 1]?.time ?? simTime`（`||` → `??`）。
  - `scripts/gravsim_trajectory_predictor.js:60`: `maxSimTime: data.maxSimTime ?? TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC`（`||` → `??`）。
  - 設計書: Rev 6.7（冒頭の改訂履歴、§4 見出し・改訂日・位置付け、§4.3 保証 2・3・4、§4.12 ステップ上限・ステップ下限・「全ワールド」の定義と計測方法）。Iteration 7 時点のコピーがないため、§4 全体を読み、Iteration 7 の記録が引用している旧記述と比べた。
- **変更していないもの**: ソース・テスト・プリセット・設計書は一切変更していない。監査開始時と終了時で、`git status --short` と、`scripts/`・`testsuites/`・`presets/`・`types/`・`docs/`（本ファイルを除く）・設定ファイルの全ファイル（本ファイルを除く 138 件）の md5 が一致することを確認した（本ファイルは追記のみ。既存部分 1,889 行は追記前と同一）。
- **描画座標系での計測**: 実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標で測った（ズーム 1e9、Iteration 3 の `v1_drawn.mjs` の `capture`）。プレビューと飛行中（射点で 37 s 待機した想定。0 s、100 s、切替の前後、切替 + 3,000 s、終端の半分、終端の 1 s 前）の 7 時刻に加え、終端の直後（最終点の時刻 + 0.001 s）に線が消えることを確かめた。**切替後の描画上の回転量**は、切替時刻以降の点だけを持つ予測を `renderTrajectory` に渡し（飛行中、切替 + 0.5 s）、描かれた頂点のホスト中心の角度変化の絶対値を累積して求めた。点の `relX/relY` から求めた値とは 0.001 周以内で一致した。
- **実経路での計測**: 予測は `ObjectPlacer.placeObject`／`ObjectPlacer.deployProfile` → `PresetManager.applyToLauncher` → `RocketLauncher.updatePredictionSync()`／`rollout()` の実経路で求めた。
- **Worker 経路**: `globalThis.Worker` を、実物の `gravsim_calc_predictor.js` の `self.onmessage`（Worker 側）と実物の `TrajectoryPredictor._initWorker` の `onmessage`（主スレッド側）を `structuredClone` でつなぐ偽物に置き換え、`requestPrediction` と `RocketLauncher.updatePrediction(false, cb)` の経路で、同期経路（`calculateSync`）と結果全体を比べた。
- **スクリプト**: 検証スクリプトとログは `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it8/` に置いた（`a1_guarantees.mjs`・`a1_summ.py`（保証 1〜5、ログ `a1_*.jsonl`・`a2_*.jsonl`）、`b1_step_floor.mjs`、`c1_tb_maxstep.mjs`、`d1_cap_worker.mjs`、`d2_sync_equal_trees.mjs`、`run_t.sh`・`run_t5.sh`・`t_summ.py`・`t5_summ.py`（同期ブロック時間、ログ `t_*.log`・`t5_*.log`・`t6_*.log`、負荷 `t_load.txt`・`t5_load.txt`・`t6_load.txt`、集計 `t_summary.txt`・`t5_summary.txt`）、`run_reg.sh`（回帰））。
- **ワールド**: Sun+Earth（SE）、7 天体ワールド（W7: Sun/Earth/Moon/Venus/Mars/Jupiter）、アプリの配置プロファイル `SOLAR_SYSTEM`（SS、21 天体）・`BINARY_SYSTEM`（BIN: Sun A/Sun B/Earth/Moon/Jupiter）・`THREE_BODY`（TB: 恒星 3 個と Earth）。後の 3 つは `ObjectPlacer.deployProfile` で配置した（Deploy タブと同じ経路。既存の Sun が Sun A に流用される点も実アプリと同じ）。`deployProfile` の配置は乱数を使わず、結果は再現する。
- **比較用ツリー**: `scratchpad/main_tree/`（`git show main:` と `scripts/`・`presets/`・`testsuites/` の 130 ファイルが一致することを再確認した）。Iteration 7 の挙動との比較には、上記の復元ファイルを入れた `gate2_it8/it7_tree/`（`scripts/` の 43 ファイルが Iteration 7 の md5 と一致）を使った。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/` の 16 ファイル。`scripts/` は 0 件。出力は Iteration 7 と同一） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 7 指摘・Watchpoint の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-7-01 | ✓ 解消（ただし (b) の説明の数値は G2-8-02） | 保証 4 は (a)／(b) に分けられ、どちらも実測と一致する（下記の保証の表）。<br>・(a) SE・W7・SS: 深宇宙 3 ミッション × 15 期間（0.2/0.3/0.5/1/1.5/2/2.5/3/6/9/12/18/24/30/36 ヶ月）× 8 方位（各ワールド 360 件）で、全件 `horizon`／`point_budget`、到達率の最小は 99.9085%（Mars 36 ヶ月）。閾値 99.5% に対して 0.41 ポイントの余裕がある。<br>・(b) BIN・TB: 同じ 360 件で全件 `horizon`／`point_budget`。記述された到達率（3 ヶ月以下は全件 `horizon`、12 ヶ月は Mars だけ `point_budget` で 99.899〜99.935%、36 ヶ月は全件 `point_budget` で 93.38〜99.92%、最短は TB の Solar・方位 45° で 1,023.2 日・72.5 日前）は再現する。 |
| Iteration 7 WP2（ステップ下限の根拠） | ✓ 解消 | §4.12 は「`MAX_STEPS = 100,000` でも実効予算は `ceil(525,960 / 5) = 105,192`、GTO の切替後の描画上の回転量は 0.949 周、120,000 では 1.32 周」に改められた。5 ワールド × 8 方位で、100,000 のとき 105,192 ステップ・0.949〜0.950 周、120,000 のとき 120,000 ステップ・1.319〜1.320 周（`b1_step_floor.mjs`。描画座標系で測定）。時間／周期では 0.996 周／1.06 周で、結論（100,000 では 1 周に届かない）はどちらの定義でも同じ。 |
| Iteration 7 WP4（Worker 経路の `maxSimTime`） | ✓ 解消 | 下記「Rev 6.7 のコード変更」。`no_host` の Worker 経路は Iteration 7 のコードでは 31,557,600（1 年）、現行では 0 で、同期経路と一致する。 |
| Iteration 7 WP6（`options.maxSteps` による上限の迂回） | ✓ 解消（横展開は G2-8-01） | 下記「Rev 6.7 のコード変更」。`MAX_STEPS_CAP` は直接呼び出し・`calculateSync`・Worker 経路のいずれでも超えられない。同じ型の `options.maxPoints` は未対応（G2-8-01）。 |
| Iteration 7 WP7（補遺ヘッダ） | ✓ 解消 | §4 の見出しは「補遺 Rev 6.1〜6.7」、改訂日は「Rev 6.1。以降は冒頭の改訂履歴を正とする。最終改訂: Rev 6.7、2026-11-20 23:04 JST」、位置付けは「各 Iteration（Iteration 2 以降）の突合対象」に改められた。冒頭の改訂履歴の Rev 6.7 の項と矛盾しない。 |
| Iteration 7 WP1（同期ブロック時間の余裕） | ✗ 基準超過 | 下記の再計測で、Sun+Earth の LEO/ISS が §4.12 の方法（交互実行・最小値どうしの比）で 1.5 倍を超えた（G2-8-03）。 |
| Iteration 7 WP3（最終点で消える） | ✓（継続） | 全 2,920 件で、最終点の時刻 − 1 s で描画あり、+ 0.001 s で描画なし。 |
| Iteration 7 WP5（既存のデッドコンフィグ） | ― 未対応（継続） | `TRAJECTORY_PREDICTION.SYNC` の 7 キーなどは変わっていない。main からの既存。 |
| Iteration 7 WP8 | ✓（継続） | 該当ファイルは変わっていない。 |

**Rev 6.7 のコード変更の検証**（`d1_cap_worker.mjs`。現行ツリーと `it7_tree` で同じスクリプトを実行し、出力を比べた）:

| 確認項目 | 現行 | Iteration 7 のコード |
|---|---|---|
| ステップ上限（LEO、0.2／36 ヶ月、`runMultiBodySimulation` を直接、`options.maxSteps` = undefined/0/−5/NaN/1/50,000/120,000/200,000/400,000/400,001/1e6/Infinity/'500000'） | 全 26 件で `steps` ≤ 400,000、かつ `min(CAP, max(maxSteps, 計算値))` と一致（例: 0.2 ヶ月の 200,000 → 200,000、1e6 → 400,000）。下限（120,000）を下げる値は無視される。 | 400,001／500,000／1,000,000 ステップ、Infinity では 1,581,956 ステップ（`point_budget`）まで回る |
| 同上、`calculateSync({ maxSteps: 1e6 })`・Worker 経路（`requestPrediction`）・Worker へ直接送ったメッセージ | いずれも 400,000 | いずれも 1,000,000 |
| アプリの経路への影響 | `RocketLauncher._getPredictionContext` の `config` は `maxSteps` を持たない（`gravsim_rocket_launcher.js:424-454`）。下記の保証の表のステップ数（LEO 0.2 ヶ月 120,000、1 ヶ月以上 400,000 など）と回帰ハーネスの出力は Iteration 7 と同一。`Math.min` の追加による計算量の変化はない。 | ― |
| `?? simTime`（`gravsim_calc_predictor.js:729`） | `no_host` 以外は初期点（時刻 0）が必ずあるので、右辺に落ちるのは点 0 個の場合だけで、その経路（`no_host`）は先に `maxSimTime: 0` で返る。点 1 個（`maxPoints: 1`、要求期間 0.005 s）でも `maxSimTime` は 0 で、`||` のときと同じ。7 ミッション × 5 ワールド（35 構成）の同期経路の予測結果全体（JSON の md5）は、Iteration 7 のコードと完全に一致した（`d2_sync_equal_trees.mjs`）。 | 同じ |
| 同期経路と Worker 経路の一致（7 ミッション、`step_budget`／`breakup`／`horizon` を含む 7 構成） | 結果オブジェクト全体（キー集合・`maxSimTime`・点・イベント）が `calculateSync`・`requestPrediction`・`updatePrediction(false, cb)` で一致 | 同じ |
| `no_host`（`host.id` がどの天体とも一致しない構成を `TrajectoryPredictor` に渡す） | 同期・Worker とも `endReason: 'no_host'`・点 0・`maxSimTime` 0 | Worker 経路だけ `maxSimTime` 31,557,600 |
| 点 1 個の結果（`maxPoints: 1`、要求期間 0.005 s） | 同期・Worker とも `maxSimTime` 0 | Worker 経路だけ 31,557,600 |
| Worker の結果に `maxSimTime` がない／`null`／0 | 31,557,600／31,557,600／0（設計書の「欠けている場合に限り補完」と一致） | 31,557,600／31,557,600／31,557,600 |

**§4.3 保証（Rev 6.7）と実装の突合**（`a1_guarantees.mjs`。7 ミッション × 7 期間（0.2/0.3/0.5/1/3/12/36 ヶ月）× 8 方位 = 392 件と、深宇宙 3 ミッション × 8 期間（1.5/2/2.5/6/9/18/24/30 ヶ月）× 8 方位 = 192 件を、5 ワールドそれぞれで実行。計 2,920 件）:

| 保証（Rev 6.7） | SE | W7 | SS | BIN | TB |
|---|---|---|---|---|---|
| 件数 | 584 | 584 | 584 | 584 | 584 |
| 1. 描画上の最大角度ステップ（0.15 rad 超の件数） | 0.120 rad（0 件） | 0.124 rad（0 件。Solar 36 ヶ月・225°） | 0.120 rad（0 件） | 0.135 rad（0 件） | **0.140 rad**（0 件。Mars 36 ヶ月・225°） |
| 2. 点数 ≤ 3,000・単調性・終了理由・`maxSimTime` = 最終点・最終点での消去 | 違反 0 件 | 違反 0 件 | 違反 0 件 | 違反 0 件 | 違反 0 件 |
| 3. LEO/ISS/GTO（全期間 × 8 方位、168 件） | 全件 `step_budget`。0.2 ヶ月の切替後: 1.900／1.727／1.320 周 | 同左 | 同左 | 全件 `step_budget`。1.900／1.727／1.319〜1.320 周 | 同左（BIN と同じ） |
| 4. 深宇宙 3 ミッション（15 期間 × 8 方位、360 件） | (a) 全件 `horizon`／`point_budget`。最小 99.9085%（Mars 36 ヶ月。`point_budget` は Mars 36 ヶ月の 5 件だけ） | (a) 同左（5 件） | (a) 同左（6 件） | (b) 全件 `horizon`／`point_budget`。3 ヶ月以下は全件 `horizon`。12 ヶ月は Mars だけ `point_budget`（99.899〜99.933%）。36 ヶ月は全件 `point_budget`（95.17〜99.92%） | (b) 同左。12 ヶ月の Mars 99.899〜99.935%。36 ヶ月 93.38〜99.92%（最短は Solar・45° の 1,023.2 日、要求期間の 72.5 日前） |
| 5. 月遷移（7 期間 × 8 方位、56 件） | `step_budget` 36・`breakup` 20 | `step_budget` 51・`breakup` 5 | `step_budget` 41・`breakup` 15 | `step_budget` 44・`breakup` 10・**`horizon` 2**（方位 135° の 0.5／1 ヶ月） | `step_budget` 46・`breakup` 10 |

- 保証 2 の検査項目: 点数 ≤ 3,000、ステップ数 ≤ 400,000、時刻の単調増加、非有限値なし、`endReason` が表の 6 種類のいずれか、`maxSimTime` = 最終点の時刻、最終点より後のイベントなし、`impact`／`breakup` のイベントの有無と `endReason` の一致、飛行中は最終点の時刻 − 1 s まで描かれ + 0.001 s で消える。2,920 件で違反 0 件。
- 保証 3 の LEO/ISS/GTO は、全期間 × 8 方位（各ワールド 168 件）で全件 `step_budget`。0.2 ヶ月の切替後の描画上の回転量は 5 ワールド・8 方位で LEO 1.900 周、ISS 1.727 周、GTO 1.319〜1.320 周（プレビューと飛行中で同じ）。0.2 ヶ月より長い期間では予算が増えるので回転量は同じかそれ以上。
- §4.3 の実測表（Sun+Earth・方位 0°）、打上げ方位 8 通りの記述、1200 s の予測（7 ミッションすべて `horizon`・1,122〜1,631 点）は、すべて記述どおり。

**§4.12（Rev 6.7）と実装の突合**:

- ステップ上限: 「`options.maxSteps`（テスト・ハーネス用。アプリの呼び出し経路は渡さない）は下限を引き上げるだけで、この上限は超えない」は、上記の 26 件＋3 経路の実測と一致する。
- ステップ下限: 「0.2 ヶ月の実効予算は `ceil(525,960 / 5) = 105,192`、GTO の回転量は 0.949 周、120,000 では 1.32 周」は、上記のとおり 5 ワールド × 8 方位で再現する（525,960 s = 0.2 × 30.4375 日）。
- 「全ワールド」の定義（5 ワールド）と計測方法（交互実行・最小値どうしの比）が明記された。Iteration 7 の再計測値として引用された数値（7 天体 1.44、Sun+Earth 1.43（5 回）、`THREE_BODY` 1.40、`BINARY_SYSTEM` 1.38、`SOLAR_SYSTEM` 1.28、7 天体の最悪 1,464 ms）は Iteration 7 の記録と一致する。
- 受入基準（`rollout()` の同期ブロック時間）の再計測: 下記。7 天体ワールドの最悪 2 秒以内は満たすが、全ワールドで main 比 1.5 倍以内は Sun+Earth で満たさない（G2-8-03）。

**同期ブロック時間**（`rollout()`、Iteration 7 の `t2b_rollout_profiles.mjs` をそのまま使用。7 ミッション × 6 期間（既定・0.2・1・3・12・36 ヶ月）× 4 方位（0°/90°/180°/270°）× 5 ワールド。本ブランチと main をワールドごとに交互に 2 回ずつ実行し、比が最も大きい SE・W7 の LEO/ISS/GTO/Lunar × 5 期間はさらに 3 回、LEO/ISS は SE・W7・TB でさらに 6 回（`run_t5.sh`）、SE でさらに 4 回（`t6`）交互に実行した。構成・方位ごとに最小値どうしの比をとり、4 方位の最大を示す。load average は `t_load.txt`）:

| 構成 | SE 本ブランチ／main（比） | W7 本ブランチ／main（比） | SS 本ブランチ／main（比） | BIN 本ブランチ／main（比） | TB 本ブランチ／main（比） |
|---|---|---|---|---|---|
| `leo_250km` 既定（0.2 ヶ月） | 194／145 ms（1.36） | 295／225 ms（1.35） | 668／583 ms（1.21） | 275／219 ms（1.30） | 233／187 ms（1.35） |
| `iss_rendezvous` 既定（0.3 ヶ月） | 398／326 ms（1.34） | 590／498 ms（1.19） | 1,496／1,390 ms（1.08） | 547／464 ms（1.20） | 480／409 ms（1.20） |
| `gto_insertion` 既定（0.5 ヶ月） | 584／478 ms（1.28） | 930／786 ms（1.19） | 2,412／2,201 ms（1.10） | 825／745 ms（1.13） | 715／647 ms（1.12） |
| `lunar_insertion` 既定（1 ヶ月） | 914／654 ms（1.42） | 1,431／1,112 ms（1.29） | 3,676／3,080 ms（1.20） | 1,283／1,047 ms（1.26） | 1,137／896 ms（1.30） |
| `leo_250km` 1 ヶ月 | 512／356 ms（**1.54**） | 842／613 ms（1.46） | 2,100／1,693 ms（1.24） | 743／559 ms（1.37） | 655／465 ms（1.44） |
| `leo_250km` 3〜36 ヶ月 | 477／346 ms（1.43） | 831／587 ms（1.46） | 2,070／1,945 ms（1.07） | 733／552 ms（1.35） | 632／461 ms（1.41） |
| `iss_rendezvous` 1〜36 ヶ月 | 883／598 ms（**1.52**） | 1,396／1,027 ms（1.41） | 3,709／2,896 ms（1.35） | 1,260／935 ms（1.37） | 1,092／828 ms（1.36） |
| `gto_insertion` 1〜36 ヶ月 | 884／646 ms（1.43） | 1,415／1,094 ms（1.33） | 3,675／2,995 ms（1.24） | 1,276／1,013 ms（1.31） | 1,105／865 ms（1.29） |
| `lunar_insertion` 3〜36 ヶ月 | 911／654 ms（1.40） | 1,417／1,125 ms（1.28） | 3,690／3,109 ms（1.21） | 1,276／1,026 ms（1.27） | 1,139／916 ms（1.28） |
| ISS/GTO/Lunar 0.2 ヶ月 | 274／195 ms（1.48） | 427／326 ms（1.36） | 1,145／923 ms（1.29） | 387／309 ms（1.33） | 344／266 ms（1.35） |
| 深宇宙 3 ミッション（全期間） | 264／669 ms（1.07） | 376／1,078 ms（1.06） | 957／3,130 ms（0.96） | 349／1,011 ms（1.02） | 316／888 ms（1.02） |

- 表の値: 本ブランチ・main はそれぞれ「構成・方位ごとの全回の最小値」の行内の最大、比は「方位ごとの最小値どうしの比」の行内の最大。交互実行の回数は、全構成 2 回、SE・W7 の LEO/ISS/GTO/Lunar 5 回、LEO/ISS は SE 15 回・W7 11 回・TB 8 回。load average は 1.0〜1.3（SE・W7 の 1 回目など）から 2.2〜3.4（00:02 以降。OS の定期監査 `lynis`・`find`・`updatedb` が動作）。
- 受入基準「全ワールド・全期間で main 比 1.5 倍以内」（§4.12 の方法: 交互実行・構成ごとの最小値どうし）: W7 1.46、TB 1.44、BIN 1.37、SS 1.35 は満たす。**SE は 1.54**（`leo_250km` 1 ヶ月・方位 270°: 512／332 ms）で、ほかに `iss_rendezvous` 36 ヶ月・180° 1.52、12 ヶ月・90° 1.50 が 1.5 を超え、SE の LEO/ISS 44 構成中 3 構成が基準を満たさない（G2-8-03）。同じ回の本ブランチと main の比（隣接実行の対）は、LEO 1 ヶ月・270° が 15 回で 1.41〜1.54（中央値 1.46）、ISS 36 ヶ月・180° が 1.35〜1.52 で、回ごとに 0.1〜0.17 ばらつく。
- 受入基準「7 天体ワールドでは最悪 2 秒以内」: 最小値で最悪 1,431 ms（`lunar_insertion` 1 ヶ月）、単発の最大でも 1,630 ms（`gto_insertion` 1 ヶ月・270°、負荷 2.8 のとき）。✓
- 深宇宙 3 ミッションは 0.2 ヶ月で main と同等（比 0.96〜1.07）、1 ヶ月以上では main の 0.3〜0.4 倍。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-8-01 [Minor] §4.3 保証 2「【全予測】点数が `MAX_POINTS` 以下」が、`options.maxPoints` を渡す呼び出しでは成り立たない（Rev 6.7 で `MAX_STEPS_CAP` を全呼び出し元の上限にした修正（Iteration 7 Watchpoint 6）が、同じ型の点数の上限に横展開されていない）
- **箇所**:
  - `scripts/gravsim_calc_predictor.js:157`（`runMultiBodySimulation`: `const maxPoints = options.maxPoints || TRAJECTORY_PREDICTION.MAX_POINTS;`）
  - `scripts/gravsim_trajectory_predictor.js:245`（`TrajectoryPredictor._buildSimulationParams`: `maxPoints: config.maxPoints || TRAJECTORY_PREDICTION.MAX_POINTS`。同期経路と Worker 経路の両方がこの値を使う）
  - 設計書 §4.3 L344（保証 2「【全予測】点数が `MAX_POINTS` 以下」）、L338（`point_budget`「`MAX_POINTS` に到達」）、L330（「点数予算が尽きた場合は…`MAX_POINTS` で打ち切る」）
  - 対比: 同じ関数の `:161-162`（Rev 6.7: 「MAX_STEPS_CAP is a hard, deterministic bound for every caller」）と §4.12 L436（`options.maxSteps` は上限を超えない）
- **現象**（`d1_cap_worker.mjs` (c)、Sun+Earth、`mars_transfer` 36 ヶ月・方位 45°、`calculateSync`）: `config.maxPoints` が未指定・500・3,000 のときの点数は 3,000・500・3,000 だが、5,000 を渡すと **3,844 点**（`horizon`）になり、`MAX_POINTS`（3,000）を超える。Worker 経路も同じ値を受け取る。
- **原因**: Rev 6.7 では、ステップ数について「`options.maxSteps` は下限を引き上げるだけで上限は超えない」とし、コードも `Math.min(maxStepsCap, …)` に改めた。一方、点数については、`options.maxPoints` が `MAX_POINTS` を置き換える既存の実装（main と同じ）のままで、保証 2 は呼び出し条件なしに「全予測」で `MAX_POINTS` 以下と書いている。アプリの呼び出し経路（`RocketLauncher._getPredictionContext`）は `maxPoints` を渡さないため、利用者から見える影響はない。しかし、`TrajectoryPredictor` の `config.maxPoints`・`runMultiBodySimulation` の `options.maxPoints` は公開された引数で、工程 3 で保証 2 の異常系・境界値テスト（`maxPoints` に `MAX_POINTS` を超える値を渡す）を書くと、設計書と実装が食い違う。G2-7-01（条件のない保証）、Iteration 7 Watchpoint 6（迂回できる上限）と同じ型である。
- **修正方針**:
  - ステップ数と同じ扱いにそろえる（例: `maxPoints = Math.min(MAX_POINTS, options.maxPoints || MAX_POINTS)`。`options.maxPoints` は予算を下げるだけにする）。または、保証 2 と §4.3 の終了理由の表を「点数が `maxPoints`（既定 `MAX_POINTS`。アプリの呼び出し経路は渡さない）以下」に改め、`MAX_POINTS` がアプリの経路での上限であることを §4.12 の `MAX_STEPS_CAP` の記述と並べて書く。どちらにするかを設計書に明記すること。
  - 横展開: `runMultiBodySimulation` の `options` は `maxSimTime`・`maxPoints`・`maxSteps` の 3 つだけで、`maxSimTime` には上限の主張がない（下記の横展開表）。

#### G2-8-02 [Minor] Rev 6.7 で書き直した §4.3 保証 4 (b) の説明の数値（描画上の最大角度ステップ 0.121〜0.135 rad、ホストのまわりを 9〜15 周）が、記述の対象（深宇宙 3 ミッション・8 方位）の実測と一致しない（最大角度ステップは最大 0.140 rad、回転量は 7.84〜15.28 周）
- **箇所**: 設計書 §4.3 L348（保証 4 (b)「ホスト中心の描画では、離脱後の機体がホストのまわりを 9〜15 周する。…保証 1・2 は成り立つ（描画上の最大角度ステップ 0.121〜0.135 rad）」）
- **現象**（`a1_guarantees.mjs`、BIN・TB、深宇宙 3 ミッション × 7 期間 × 8 方位、描画座標系）:
  1. 描画上の最大角度ステップ（`point_budget` で終わる構成ごとの最大値）は、BIN 0.120〜0.135 rad、**TB 0.120〜0.140 rad**。最大は TB の `mars_transfer` 36 ヶ月・方位 225° の **0.1401 rad**（プレビューと飛行中で同じ）。この点は終端ではなく途中の 103.0〜103.1 日（サンプル間隔 10,800 s、地球から 0.0037 AU に戻ってきたところ）にある（`c1_tb_maxstep.mjs`）。同じ構成の BIN は 0.130 rad。
  2. 36 ヶ月の切替後の描画上の回転量（最終点まで）は、BIN 7.88〜15.27 周、TB 7.84〜15.28 周。9 周未満が 3 件ある（Jupiter・方位 135° の BIN 7.88 周と TB 7.84 周、TB の Solar・方位 45° の 8.34 周）。
  3. 記述の数値は、Iteration 7 の監査が 5 方位（0°/90°/180°/270°/315°）× 3 期間（0.2/1/36 ヶ月）で測った値（`gate2_it7/e6_TB.log` など。方位 225° と 12 ヶ月を含まない）と同じで、8 方位の結果ではない。同じ箇所の到達率（「実測（8 方位）」）は 8 方位で測った値と一致する。
- **影響**: 保証 1（`MAX_ANGLE_STEP_RAD` ＋ 1 積分ステップ以内、テストの閾値 0.15 rad）自体は成り立つ。しかし、(b) の数値を期待値の上限にしたテスト（例: BIN/TB で ≤ 0.135 rad）は TB の方位 225° で失敗する。また、テストの閾値 0.15 rad との余裕は、記述から読み取れる 0.015 rad ではなく 0.010 rad しかない。
- **修正方針**: (b) の数値を 8 方位の実測（最大角度ステップ 0.120〜0.140 rad、最大は TB の Mars 36 ヶ月・方位 225°。回転量は 36 ヶ月で約 8〜15 周）に改める。あるいは、数値を「例」として測定条件（方位・期間）を併記する。横展開として、§4.3・§4.12 のほかの実測値に、測定条件より広い範囲の主張がないかを確かめること（本監査で確かめた範囲では、保証 3 の回転量、(a) の最小到達率、§4.3 の実測表、方位 8 通りの記述、1200 s、§4.12 のステップ下限の数値は一致した）。

#### G2-8-03 [Minor] §4.12 の受入基準「全ワールド・全期間で main 比 1.5 倍以内」を、§4.12 自身が定める計測方法（交互実行・構成ごとの最小値どうしの比）で再計測すると、Sun+Earth の地球近傍の閉軌道で満たさない（最大 1.54 倍）。比の実際の値（約 1.4〜1.5）が基準 1.5 と重なっており、合否が計測時の状態で入れ替わる
- **箇所**:
  - 設計書 §4.12 L439（受入基準「全ワールド・全期間で main 比 1.5 倍以内」）、L452（「全ワールド」は Sun+Earth を含む 5 ワールド。比は交互に複数回実行し、構成ごとの最小値どうしで求める。「Iteration 7 の再計測での最大比は…Sun+Earth 1.43（5 回）」）
  - 関連する実装（Iteration 7 から変更なし）: `scripts/gravsim_calc_predictor.js:158-162`（ステップ予算 `min(400,000, max(120,000, ceil(T/5)))`）、`:595-681`（1 ステップごとのサンプラーの判定）
- **現象**（`run_t.sh`・`run_t5.sh`・`t6`、`rollout()` の同期ブロック時間、本ブランチと main を交互に実行。上記の表）:
  1. SE の `leo_250km` 1 ヶ月・方位 270° は 15 回で、本ブランチの最小 512 ms、main の最小 332 ms、比 **1.54**。`iss_rendezvous` 36 ヶ月・180° は 871／574 ms で **1.52**、12 ヶ月・90° は 873／581 ms で **1.50**（いずれも 11〜15 回）。SE の LEO/ISS 44 構成中 3 構成が 1.5 を超え、ほかに 1.49〜1.50 が 5 構成ある。
  2. 同じ回の対（本ブランチの直後に main）の比も、LEO 1 ヶ月・270° は 1.41〜1.54（中央値 1.46）、ISS 36 ヶ月・180° は 1.35〜1.52 で、1.5 を超える回がある。
  3. Iteration 7 は同じコード（Rev 6.7 の変更は `Math.min` と `??` だけで、計算量は変わらない。予測結果も 35 構成で完全に一致）を同じ方法で計り、SE は 1.43（5 回）だった。比の実際の値が基準 1.5 のすぐ下から上にまたがっており、合否は計測時の負荷や回数で決まる。
  4. ほかの 4 ワールドは満たす（W7 1.46、TB 1.44、BIN 1.37、SS 1.35）。7 天体の最悪 2 秒以内も満たす（1,431 ms、単発でも 1,630 ms）。SE の絶対値は小さい（最小値での最悪 914 ms、単発の最大 1,093 ms）。
- **原因**: Iteration 7 Watchpoint 1 のとおり、比は「ステップ数の比（400,000 対 main の 333,000〜360,000）× 1 ステップあたりのコストの比（約 1.2〜1.3）」で決まる。天体が 2 個の SE では 1 ステップあたりの重力計算が最も軽いため、サンプラー（描画座標系の角度判定・座標系切替の判定など）の追加コストの割合が大きく、比が 1.5 に届く。基準は Iteration 7 の実測（1.43〜1.44）にほとんど余裕のない値で置かれ、§4.12 の計測方法（最小値どうしの比の、構成・方位の最大）は多数の構成の最大をとるため、ばらつきの上側を拾う。
- **修正方針**:
  - 実装で余裕を作る（例: SE・W7 の LEO/ISS で 1 ステップあたりのサンプラーの処理を減らす）か、基準を改める。基準を改める場合は、根拠（利用者から見える停止時間、例えば「SE で 1 s 以内」「7 天体で 2 s 以内」などの絶対値）を書き、比を残すなら再現性のある統計量（例: 10 回以上の交互実行で、同じ回の対の比の中央値）と計測条件（負荷、回数、方位）を §4.12 に定めること。
  - どちらの場合も、工程 3・4 で CI の判定に使えるよう、基準と実測値の間に計測のばらつき（本監査では同じ構成で 0.1〜0.17）を上回る余裕を持たせること。
  - 横展開: 同じ基準のほかのワールド（W7 1.46、TB 1.44）も余裕は 0.04〜0.06 しかない。基準を改める場合は 5 ワールドすべてを同じ方法で再計測すること。

---

### 2. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 呼び出し元が迂回できる上限（Iteration 7 WP6） | `runMultiBodySimulation` の `options` は `maxSimTime`・`maxPoints`・`maxSteps` の 3 つ。`maxSteps` は Rev 6.7 で上限が固定された（上記）。**`maxPoints` は `MAX_POINTS` を超えられる**（G2-8-01）。`maxSimTime` は上限の主張がなく、長くしてもステップ上限で計算量は抑えられる。ほかの上限（`DT.DEEP_SPACE_MAX_CAP`、`SAMPLING.MAX_ANGLE_STEP_RAD`、`RENDER.PREDICTED_TRAJECTORY.ACTUAL_MAX_POINTS`、`SIMULATION` の `TIME_SCALE_BASE_CAP`）は呼び出し元の引数で変えられない。 | **要**（G2-8-01） |
| 0 が正当な値になる有効期間・時刻のフィールドへの `||`（Iteration 7 WP4） | `scripts/` で `maxSimTime` を含む行は 28 行（5 ファイル）。結果側の 2 箇所（`gravsim_calc_predictor.js:729`、`gravsim_trajectory_predictor.js:60`）は `??` になった。残る `||` は次のとおりで、いずれも表示・計算に影響しない。<br>・`gravsim_trajectory_predictor.js:537` `prediction.maxSimTime \|\| (points[last]?.time \|\| 0)`: `maxSimTime` は常に最終点の時刻なので、0 のときの代替値も 0（同じ値）。`maxSimTime` を持たない旧形式の予測では最終点の時刻になる。<br>・`gravsim_calc_predictor.js:156`、`gravsim_trajectory_predictor.js:243` `maxSimTime \|\| MAX_SIM_TIME_SEC`: 要求期間（入力）の既定値。アプリでは 0 は入らない（スライダーは 0.2〜36 ヶ月、`applyToLauncher` は `predictionDurationMonths` が 0 のとき適用しない）。<br>・`gravsim_object.js:364, 591`、`gravsim_trajectory_predictor.js:349` `telemetry?.flightTime \|\| this.flightTime \|\| 0`: `Rocket.flightTime` は 0 以外に代入されない（`gravsim_object.js:267`、`gravsim_rocket_launcher.js:90`）ので、結果は `??` と同じ（main と同じ既存のコード）。<br>・`frameSwitchHostRot \|\| 0`・`hostOmega`・`frameSwitchTime` は `Number.isFinite` で判定しており、0 を正しく扱う。<br>・`gravsim_calc_predictor.js:345` の大気上限 `\|\| ORBIT_MIN_ALT_M`（無大気天体で 100 km）は Iteration 4 WP5 の既知事項。 | 不要 |
| 条件のない保証・基準（G2-7-01） | §4.3 の保証 1〜5 と §4.12 の受入基準を 5 ワールドで確かめた（上記の表）。保証 1・2・5 は「全予測」の記述どおり 5 ワールドの全 2,920 件で成り立つ。保証 3 は 5 ワールドを明記し、全件成り立つ。保証 4 は (a)／(b) に分かれ、どちらも成り立つ。受入基準は「全ワールド」が 5 ワールドと定義されたが、再計測では SE で 1.5 倍を超えた（G2-8-03）。保証 2 は呼び出し条件（`maxPoints`）が抜けている（G2-8-01）。 | **要**（G2-8-01・G2-8-03） |
| 実測値の測定条件（G2-8-02） | §4.3 の実測表（SE・方位 0°）、方位 8 通りの記述（SE）、1200 s、保証 3 の回転量（5 ワールド・8 方位）、保証 4 (a) の最小 99.91%、(b) の到達率、§4.12 のステップ下限（0.949／1.32 周）・Iteration 7 の比の引用は、それぞれの条件で再現した。条件より広く書かれていたのは (b) の 2 つの数値だけ。 | **要**（G2-8-02） |
| 予測の有効期間の主張（G2-6-01・G2-6-02） | Iteration 7 から変更なし。有効期間は最終点の時刻だけで、外挿・延長はない。 | 不要 |

---

### 3. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **Rev 6.7 のコード変更にはテストがない**: `testsuites/` に `maxSteps`・`MAX_STEPS_CAP` を扱うテストはなく、Worker の結果の `maxSimTime` は 1,000 を渡すテスト（`unit/04_camera_render.test.mjs:1374`）だけである。工程 3 では、`options.maxSteps` に上限超え・`Infinity`・文字列・0・負値を渡すテスト、Worker の結果の `maxSimTime` が 0／`null`／欠落のテスト、`no_host` を同期経路と Worker 経路で比べるテストを追加すること（`no_host` は `host.id` がどの天体とも一致しない構成で `TrajectoryPredictor` 経由でも再現できる）。
2. **保証 1 の余裕**: 描画上の最大角度ステップは SE・SS で 0.120 rad、W7 で 0.124 rad、BIN で 0.135 rad、TB で 0.140 rad（Mars 36 ヶ月・方位 225°）。テストの閾値 0.15 rad との差は 0.010 rad しかない。BIN/TB では閾値を 0.15 rad より厳しくしないこと。
3. **保証 4 (b) のワールドでは中間の期間でも点数予算で終わる**: BIN/TB では、Mars は 9 ヶ月（8 方位中 2 方位）から `point_budget` になり、18 ヶ月以上では 3 ミッションとも `point_budget` が出る（Jupiter 18 ヶ月は 5 方位、他は全方位）。18〜30 ヶ月の到達率は最小 97.56%（BIN の Jupiter 30 ヶ月・方位 315°）。(b) のテストは `endReason ∈ {horizon, point_budget}` だけを判定し、到達率は判定しないこと。(a) のワールドでは 1.5〜30 ヶ月の中間期間も全件 `horizon`（100%）だった。
4. **同期ブロック時間の計測**（Iteration 7 WP1 の継続、G2-8-03）: 同じ構成でも回ごとの比が 0.1〜0.17 ばらつき、OS の定期処理（`lynis`・`find`・`updatedb`）が動く時間帯もある。工程 3・4 で計時をアサーションにする場合は、交互実行・複数回で比べ、計測時の load average を記録すること。サンプラーに処理を足す変更では、SE と W7 の LEO/ISS（1〜36 ヶ月）を再計測すること。
5. **保証 5 の終了理由に `horizon` もある**: BIN の月遷移・方位 135° は 0.5／1 ヶ月で `horizon`（100%）で終わる（Iteration 7 は BIN/TB を 5 方位で測ったため、この方位を含まなかった）。保証 5 は「到達期間は保証しない」で `horizon` を否定していないが、工程 3 のテストで月遷移の終了理由を `{step_budget, breakup, impact}` に限定しないこと。
6. **要求期間 0 の扱い**: `maxSimTime: 0` を渡すと `||` で 1 年に置き換わる（入力の既定値。アプリからは到達しない）。工程 3 で要求期間の境界値テストを書く場合は、0 が「予測なし」ではなく既定の 1 年になることを期待値にするか、別途仕様を決めること。
7. **Worker の既定値は `null` にも適用される**: `data.maxSimTime ?? MAX_SIM_TIME_SEC` は `undefined` だけでなく `null` も 1 年に置き換える。設計書の「欠けている場合」は両方を含む意味で読むこと。
8. **引き続き有効な Watchpoint**: Iteration 7 の WP3（飛行中の予測線は最終点で消える）・WP5（既存のデッドコンフィグ）。Iteration 6 の WP2（非有限値を失敗として扱う）・WP5（7 天体ワールドの定義）。Iteration 4 の WP2（保証 3 は §4.3 の表の機体の組合せに限る。ホストは Earth）・WP3・WP4・WP5・WP6・WP7・WP8。Iteration 1・2 の Watchpoint（スナップショットなしで保存した場合の劣化、ツールチェーンのバージョン固定など）と、lint 警告 54 件（testsuites）も残る。

---

## 独立監査2: 実装監査 — Iteration 9

- **対象ゲート**: 独立監査2: 実装監査
- **イテレーション番号**: Iteration 9
- **実施日時**: 2026-11-21 03:12〜05:15 JST（03:33 頃に WSL ホストが停止し、実行中の計測がすべて中断した。再開後、完了マーカーのないログはすべて破棄して再実行した。下記「中断と再実行」）
- **判定**: **PASS（文書指摘あり）**（Minor 2 件、いずれも【文書】。【実装】の指摘なし）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.2・§4、設計書 Rev 6 本文、§4 補遺 Rev 6.1〜6.8、Iteration 1〜8 の指摘（G2-01〜G2-10、G2-2-01〜G2-2-04、G2-3-01〜G2-3-03、G2-4-01〜G2-4-03、G2-5-01〜G2-5-02、G2-6-01〜G2-6-03、G2-7-01、G2-8-01〜G2-8-03）と各 Watchpoints に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: Iteration 8 の監査終了時の md5（`gate2_it8/md5_end.txt`、139 件）を現行ツリーと突き合わせた。変更されたのは次の 3 ファイルと設計書だけで、テスト・プリセット・`package.json`・`types/`・他のソース・本ファイルは変わっていない（`manifest.json` は Iteration 8 の一覧になかったため今回から対象に加えた。コミット済みで未変更）。作業者が Iteration 8 時点のコピーと申告した `scratchpad/perf/before_tree/scripts/` の 43 ファイルは、md5 がすべて Iteration 8 の値と一致したので、これを原本として差分を全行読んだ（`gate2_it9/predictor.diff`）。
  - `scripts/gravsim_calc_predictor.js`: `maxPoints = Math.min(MAX_POINTS, options.maxPoints || MAX_POINTS)`（`:158`）、`MAX_STEPS_CAP` のフォールバック 340,000（`:160`）、予測用 `CalcRocket` に `trackRcsVisualState: false`（`:236`）、ループ内の定数・`mu` のループ外への移動（`:354-383`）、ステップ冒頭の距離に前ステップの `curDistHostM` を使用（`:391`）、`currentAngle = curInertialPhi`（`atan2` の重複除去、`:626`）、速度イベントの速さ・円軌道速度・ホスト基準エネルギーの必要時だけの計算（`:596-600`、`:617`、`:673-675`）、汎用イベントを alt/time/vel 型の規則だけで回す（`:373`、`:601`）、速さの閾値を二乗で比較（`:629-630`、`:651`、`:670`）。
  - `scripts/gravsim_calc_object.js`: `trackRcsVisualState`（既定 true、`:311`）と `if (this.trackRcsVisualState) this._updateRcsState(...)`（`:1468`）。
  - `scripts/gravsim_const.js:309`: `MAX_STEPS_CAP` 400,000 → 340,000。
  - 設計書: Rev 6.8（冒頭の改訂履歴、§4 見出し・改訂日、§4.3 終了理由の表・保証 2・保証 4 (b)・実測表・方位 8 通り、§4.12 全面）。Iteration 8 時点の設計書のコピーはないため、§4 全体を読み、Iteration 8 の記録が引用している旧記述と比べた。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書は一切変更していない。監査開始時（`gate2_it9/md5_start.txt`、140 件）と終了時で、`git status --short` と、`scripts/`・`testsuites/`・`presets/`・`types/`・`docs/`（本ファイルを除く）・設定ファイルの全ファイルの md5 が一致することを確認した。例外は `docs/development_process.md` の 1 件で、監査中（04:26 JST）に利用者の判断で改訂された（md5 `25064a01…` → `8030bc4b…`。§2 の末尾に「PASS（文書指摘あり）」の 1 文、§4 の 3 に判定と分類の項目、§4 の 5 を追加）。これは想定された変更として記録する。本ファイルは追記のみで、既存部分 2,057 行は追記前と同一。
- **判定の規則**: 判定は、改訂後の `docs/development_process.md` §2・§4 の 3・§4 の 5 に従う。各指摘に【文書】／【実装】の分類（§4 の 5 の 1）を付け、指摘がすべて【文書】なので「PASS（文書指摘あり）」とした。監査の範囲と厳しさは改訂前と変えていない。
- **中断と再実行**: 03:33 頃の WSL ホスト停止で、実行中だった D3（ビット同一性の総当たり）のうち `cur_SE`・`cur400_SE` 以外、D4・D5 のすべてが途中で切れた。再開後、作業ツリーの md5 と `git status` が開始時と一致すること、比較用ツリー（下記）の md5 が作成時と一致することを確かめ、完了マーカー（`.done`）のないログを `gate2_it9/partial_crash/` に移して使わず、すべて再実行した。同期ブロック時間の計測（T9）は中断時点で未着手で、再開後に負荷が下がってから（load average 1.3）単独で実行した。
- **描画座標系での計測**: Iteration 8 と同じく、実物の `TrajectoryPredictor.renderTrajectory` を記録用のモック ctx で呼び、描かれた座標で測った（ズーム 1e9、`gate2_it3/v1_drawn.mjs` の `capture`、検査本体は `gate2_it8/a1_guarantees.mjs` をそのまま使用）。
- **実経路での計測**: `ObjectPlacer.placeObject`／`ObjectPlacer.deployProfile` → `PresetManager.applyToLauncher` → `RocketLauncher.updatePredictionSync()`／`rollout()`。
- **Worker 経路**: Iteration 8 の `d1_cap_worker.mjs` と同じ偽 Worker（実物の `gravsim_calc_predictor.js` の `self.onmessage` と実物の `TrajectoryPredictor._initWorker` の `onmessage` を `structuredClone` でつなぐ）。
- **ワールド**: Sun+Earth（SE）、7 天体ワールド（W7: Sun/Earth/Moon/Venus/Mars/Jupiter）、アプリの `SOLAR_SYSTEM`（SS、21 天体）・`BINARY_SYSTEM`（BIN）・`THREE_BODY`（TB）配置。
- **比較用ツリー**（すべて `gate2_it9/` 下）: `it8_tree/`（Iteration 8 のコード。`scripts/` 43 ファイルが Iteration 8 の md5 と一致）、`it8_cap340/`（`it8_tree` の `MAX_STEPS_CAP` だけを 340,000 にしたもの）、`cur_cap400/`（現行ツリーの `MAX_STEPS_CAP` だけを 400,000 にしたもの）、`nopres_tree/`（横展開の計測用。現行ツリーで予測器のタンク圧計算だけを止めたもの）。main との比較は `scratchpad/main_tree/`（`git show main:` と `scripts/`・`presets/`・`testsuites/` の 130 ファイルが一致することを再確認した）。
- **スクリプト**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate2_it9/`）: `d3_sweep.mjs`・`cmp.py`（ビット同一性の総当たり、ログ `d3/`）、`d4_extra.mjs`（追加の経路・イベント・ホスト・衝突、ログ `d4/`）、`d5_points_worker.mjs`（点数・ステップ上限と同期／Worker の一致、ログ `d5.jsonl`）、`det_probe.mjs`・`pfx_probe.mjs`（再現性・前方一致）、`r1_mainsim_rcs.mjs`（通常シミュレーションの RCS）、`m1_steps.mjs`（main と本ブランチのステップ数）、`a1_summ9.py`（保証 1〜5、ログ `a1/`）、`t9_rollout.mjs`・`run_t9.sh`・`t9_summ.py`（同期ブロック時間、ログ `t9/`、負荷 `t9/load.txt`）、`p1_pres_bench.mjs`（タンク圧の計算コスト、ログ `p1.log`）、`sq_eq.mjs`（二乗比較の境界）、`s1200.mjs`（1200 s の予測）、`run_reg.sh`（回帰、ログ `reg/`）、`run_mech.sh`（機械的チェック）、`job.sh`・`jobs_b.txt`・`jobs_c.txt`（再実行のジョブ一覧）。

**機械的チェック・既存テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文 | `npm run check:syntax` | exit 0・エラー 0 |
| Lint | `npm run check:lint`（ESLint v6.4.0） | **エラー 0**／警告 54（全件が `testsuites/` の 16 ファイル。`scripts/` は 0 件。出力は Iteration 8 と同一） |
| 型 | `npm run check:types`（tsc 7.0.2） | エラー 0 |
| 既存テスト | `npm test` | **332/332 pass**・fail 0・skipped 0 |

**Iteration 8 指摘・Watchpoint の解消確認**:

| ID | 判定 | 確認内容（実測） |
|---|---|---|
| G2-8-01 | ✓ 解消（同じ上限を定義している終了理由の表の記述は G2-9-01 の 2） | `runMultiBodySimulation` は `maxPoints = min(MAX_POINTS, options.maxPoints \|\| MAX_POINTS)`（`gravsim_calc_predictor.js:158`）になった。`mars_transfer` 36 ヶ月・方位 45° と `leo_250km` 1 ヶ月で、`maxPoints` に undefined/null/0/−5/NaN/1/2/500/2,999/3,000/3,001/5,000/1e6/Infinity/'5000'/'500'/'abc' を、直接呼び出し・`calculateSync`・Worker 経路（`requestPrediction`）・Worker への直接メッセージの 4 経路で渡し、全 136 件で点数 ≤ 3,000（Iteration 8 で 3,844 点になった 5,000 も 3,000 点・`horizon`）。4 経路の結果は全件一致。§4.3 保証 2・§4.12 の記述と一致する（`d5_points_worker.mjs`）。 |
| G2-8-02 | △ 一部未解消（G2-9-01） | (b) の回転量「36 ヶ月・8 方位で 7.8〜15.3 周」（実測 BIN 7.88〜15.27、TB 7.84〜15.28）、最大角度ステップの最大「TB の Mars 36 ヶ月・方位 225° の 0.140 rad」、BIN の最大 0.135 rad、到達率の各数値は実測と一致する。ただし、範囲の下限「0.120」は記述された条件（深宇宙 3 ミッション × 7 期間 × 8 方位）では成り立たない（G2-9-01）。 |
| G2-8-03 | ✓ 解消（受入基準は 5 ワールドとも満たす。実測の記述と計測方法の定義は G2-9-02） | 下記「同期ブロック時間」。 |
| Iteration 8 WP1（Rev 6.7 のコード変更のテスト） | ― 工程 3 の事項（継続） | `testsuites/` は Iteration 8 から変わっていない。`maxSteps`・`maxPoints`・`MAX_STEPS_CAP` を扱うテストはまだない。 |
| Iteration 8 WP2（保証 1 の余裕） | ✓（継続） | 描画上の最大角度ステップは SE・SS 0.120 rad、W7 0.124 rad、BIN 0.135 rad、TB 0.140 rad で Iteration 8 と同じ（深宇宙は上限 340,000 に達しないため結果が変わらない）。 |
| Iteration 8 WP5（保証 5 の `horizon`） | ✓（継続） | BIN の月遷移・方位 135° は 0.5 ヶ月で `horizon`（15.22 日）。1 ヶ月は上限変更で `step_budget`（22.26 日）になり、`horizon` は 56 件中 1 件。 |
| Iteration 8 WP4（同期ブロック時間の計測） | ✓ 対応 | 下記の計測は交互実行・規定回数・負荷の記録を守り、SE・W7 の LEO/ISS（1〜36 ヶ月）を含む。 |
| Iteration 8 WP3・WP6〜WP8 | ✓（継続） | 該当する記述・コードは変わっていない（(b) の中間の期間の結果、要求期間 0 と `null` の扱いは Iteration 8 と同じ）。 |

**Rev 6.8 のコード変更の検証**:

1. **結果を変えない最適化（ビット同一性）**: 上限を同じ値にそろえた 2 組（現行 ⇔ `it8_cap340`、`cur_cap400` ⇔ `it8_tree`）で、同じ構成の同期予測の結果全体を比べた。数値は JSON の最短表現に加え −0・NaN・±Infinity を区別してハッシュした（`d3_sweep.mjs` の `exactHash`）。
   | 比較 | 構成 | 結果 |
   |---|---|---|
   | 現行 ⇔ `it8_cap340`（上限 340,000） | 5 ワールド × 7 ミッション × 7 期間（0.2/0.3/0.5/1/3/12/36 ヶ月）× 8 方位 = 1,960 件（`step_budget` 1,059・`horizon` 761・`point_budget` 80・`breakup` 60） | **1,960 件すべて一致** |
   | `cur_cap400` ⇔ `it8_tree`（上限 400,000） | SE 392 件 ＋ 他の 4 ワールド × 7 ミッション × 3 期間（0.2/1/36 ヶ月）× 8 方位 = 1,064 件（最大 400,000 ステップ） | **1,064 件すべて一致** |
   | 追加の経路（`d4_extra.mjs`。現行 ⇔ `it8_cap340` で 1,006 件、`cur_cap400` ⇔ `it8_tree` で 348 件） | (1) 既定の表にない alt/time/vel 型のイベント規則（`value`/`altM`/`time`/`vel` の各キー、無効化した規則、キーのない規則、未知の型）と速度規則だけの表、SE・W7・TB × 7 ミッション × 3 期間 × 2 方位。(2) W7 で Moon（自転なし。射点での相対速度 0）・Mars・Venus・Jupiter をホストにした 504 件。(3) 推進剤 25/50/75%、急な／浅い姿勢、推力 0 の変種（`impact`・`breakup` を含む）。(4) `rollout()` の予測と、ホールドダウンで 8 s 待機したあとの射点の機体状態からの予測（Earth・Moon ホスト）。(5) ホストの自転角 0/2.5/−3.0。`impact` 122 件・`breakup` 260 件を含む | **全件一致** |
   - 上限の影響の確認: 同じ順序で実行した SE の 392 件で、現行（340,000）と `cur_cap400`（400,000）の結果が異なるのは 112 件で、400,000 の実行が 340,000 を超えるステップを使った構成と完全に一致した（それ以外の 280 件は一致）。340,000 で打ち切った予測は、400,000 の予測と最後の 1 点（打ち切り位置の点）を除いて前方一致する（ISS・GTO 1 ヶ月で確認、`pfx_probe.mjs`）。
   - 同期経路と Worker 経路: 現行ツリーで、SE・W7・TB（Earth ホスト）と W7 の Moon・Jupiter ホスト × 7 ミッション × 3 構成（0.2 ヶ月・0°、1 ヶ月・90°、36 ヶ月・225°）× 2 種類のイベント表の 210 件で、`calculateSync`・`requestPrediction`（Worker）・`updatePrediction(false, cb)`（既定のイベント表のとき）の結果全体が一致した（`d5_points_worker.mjs`）。
   - 静的確認: ステップ冒頭の距離の再利用は、位置が `engine.step()`（`PredictorPhysicsEngine.step` = `_moveObjects`）の中でしか変わらないこと、初回の `initDistHostM` の計算後に位置を変える処理（`flightControl(0, …)`、エンジンの生成）がないことを確かめた。汎用イベントのループは、alt/time/vel 以外の型では何もしない（`:601-613`）ので、規則の絞り込みは等価。`mu` はループの外に出たが、予測エンジンは衝突処理（`_checkCollisions`）を呼ばないため、ホストの質量は予測中に変わらない。`speedMS > 0.1` → `speedSq > 0.01`、`speedMS > 5` → `speedSq > 25` は、境界のごく近く（相対 5e-15 以内で約 0.7%、`sq_eq.mjs`）では判定が入れ替わり得るので、厳密には数学的に等価ではない。上の総当たりでは差は出なかった（Watchpoint 1）。
2. **RCS の演出状態の省略**（`trackRcsVisualState`）:
   - 読み手の確認: `rcsCw`・`rcsCcw`・`rcsUllage` を読むのは `WorkerBridge.formatWorkerToMain` のフラグ（`gravsim_worker_bridge.js:145-147`）、`ObjectManager` の同期（`gravsim_object_manager.js:329-331, 415-417, 502-504, 575-577`）、`RocketRenderer`（`gravsim_rocket_renderer.js:146-148`）だけ。`_postSepRcsTimer`・`_ullageRestartTimer` を読むのは `_updateRcsState` 自身と実行時スナップショット（`getRuntimeState`/`restoreRuntimeState`、`gravsim_calc_object.js:437-438, 464-465`）だけで、物理・誘導・段階遷移（`flightControl` の状態機械、`FlightComputer`）は読まない。`FlightComputer.telemetryCache.rcs*` を読むコードはない。
   - 通常のシミュレーション: `PhysicsEngine.addObject`（`gravsim_calc.js:49-80`）は `thrustData` を項目ごとに組み立てて `trackRcsVisualState` を渡さないため、Worker の機体は常に既定値 true。実経路（`rollout` → ホールドダウン 5 s → 打上げ → 3,600 s。1 フレーム = 0.1 s × 4 サブステップ）で、ISS/LEO/GTO/月遷移/Solar の 5 機の 1 フレームごとの状態（位置・速度・姿勢・段・推進剤・RCS フラグ・タイマー・主スレッド側の RCS フラグ）と 600 s ごとの実行時スナップショットのハッシュが、Iteration 8 のコードと完全に一致した（`Math.random` は両方で同じ種の擬似乱数に置換。`r1_mainsim_rcs.mjs`）。RCS は 11〜630 フレームで作動し、主スレッドの `Rocket` にも届いている。既存の `gate2/t16_rcs_timeline.mjs`（3 機）の出力も Iteration 8 と同一。
   - 保存・復元: スナップショットの項目と復元の処理は変わっていない。Worker の機体は追跡が有効なので、保存されるタイマーは従来どおり。予測用の機体は保存されない。
3. **`MAX_STEPS_CAP` = 340,000**: アプリの値の唯一の使用箇所は `gravsim_calc_predictor.js:160-163`。`options.maxSteps` に undefined/0/1e6/Infinity/'500000'/340,001/'abc' を渡しても 340,000 を超えない（直接呼び出しと Worker 経路、`d5_points_worker.mjs`）。main のステップ数（`PredictorPhysicsEngine.step` の呼び出し回数、5 ワールド × 8 方位、`m1_steps.mjs`）は、1 ヶ月で LEO 333,997〜334,003、ISS 333,085〜333,086、GTO 360,433〜360,437、月遷移 371,359〜371,362（いずれも 3,001 点で打ち切り）、0.2 ヶ月で 105,192（`max(100,000, ceil(525,960 / 5))`）。§4.12 の「main は地球近傍の閉軌道を 3,000 点で打ち切り、約 333,000〜360,000 ステップ」「400,000 ではステップ数の比だけで約 1.2 倍」（400,000 / 333,085 = 1.20）、main の到達時刻（LEO 32,758 s、ISS 32,579 s、GTO 35,439 s、月遷移 36,552 s）は実測と一致する。

**§4.3 保証（Rev 6.8）と実装の突合**（`a1_guarantees.mjs`、5 ワールドそれぞれで 7 ミッション × 7 期間 × 8 方位 = 392 件と、深宇宙 3 ミッション × 8 期間（1.5/2/2.5/6/9/18/24/30 ヶ月）× 8 方位 = 192 件。計 2,920 件）:

| 保証（Rev 6.8） | SE | W7 | SS | BIN | TB |
|---|---|---|---|---|---|
| 件数 | 584 | 584 | 584 | 584 | 584 |
| 1. 描画上の最大角度ステップ（0.15 rad 超の件数） | 0.120 rad（0 件） | 0.124 rad（0 件） | 0.120 rad（0 件） | 0.135 rad（0 件） | **0.140 rad**（0 件） |
| 2. 点数 ≤ 3,000・ステップ ≤ 340,000・単調性・終了理由・`maxSimTime` = 最終点・最終点での消去 | 違反 0 件 | 違反 0 件 | 違反 0 件 | 違反 0 件 | 違反 0 件 |
| 3. LEO/ISS/GTO（全期間 × 8 方位、168 件） | 全件 `step_budget`。0.2 ヶ月の切替後: 1.900／1.727／1.320 周。1 ヶ月以上: 5.785／5.789／3.538 周 | 同左 | 同左 | 全件 `step_budget`。1.900／1.727／1.319〜1.320 周 | 同左（BIN と同じ） |
| 4. 深宇宙 3 ミッション（15 期間 × 8 方位、360 件） | (a) 全件 `horizon`／`point_budget`。最小 99.9085%（Mars 36 ヶ月） | (a) 同左 | (a) 同左（`point_budget` 6 件） | (b) 全件 `horizon`／`point_budget`。3 ヶ月以下は全件 `horizon`。12 ヶ月は Mars だけ `point_budget`（99.899〜99.933%）。36 ヶ月は全件 `point_budget`（95.17〜99.92%） | (b) 同左。12 ヶ月の Mars 99.899〜99.935%。36 ヶ月 93.38〜99.92%（最短は Solar・45° の 1,023.2 日、要求期間の 72.5 日前） |
| 5. 月遷移（7 期間 × 8 方位、56 件） | `step_budget` 36・`breakup` 20 | `step_budget` 51・`breakup` 5 | `step_budget` 41・`breakup` 15 | `step_budget` 45・`breakup` 10・`horizon` 1 | `step_budget` 46・`breakup` 10 |

- 保証 2 の検査項目は Iteration 8 と同じ（点数、ステップ数（今回は 340,000）、時刻の単調増加、非有限値、`endReason` の種類、`maxSimTime` = 最終点の時刻、最終点より後のイベント、`impact`／`breakup` イベントと `endReason` の一致、飛行中の最終点 − 1 s での描画と + 0.001 s での消去）。2,920 件で違反 0 件。
- 上限 340,000 の影響を受けるのは、地球近傍の閉軌道（LEO/ISS/GTO/月遷移）の約 0.65 ヶ月以上だけである。深宇宙 3 ミッションの最大ステップ数は SE 102,159、W7 128,066、SS 139,166、BIN 150,922、TB 132,368 で上限に届かず、保証 1・4 の結果は Iteration 8 と同じ。
- §4.3 の実測表（Rev 6.8、SE・方位 0°）は全 7 行・全列が実測と一致する（例: ISS 1〜36 ヶ月 `step_budget` 33,262 s・1,829 点、GTO 133,707 s・1,747〜1,771 点、月遷移 1,203,081 s・1,598〜2,013 点）。
- 打上げ方位 8 通りの記述（LEO 0.2・ISS 0.3・GTO 0.5 ヶ月は全方位 `step_budget` で 0.13／0.17／1.20 日、Jupiter・Solar 36 ヶ月と Mars 12 ヶ月は全方位 `horizon`、Mars 36 ヶ月は 3 方位 `horizon`・5 方位 `point_budget`（99.91〜99.98%）、Lunar 1 ヶ月は 4 方位 `step_budget`（13.80〜13.92 日）・4 方位 `breakup`（10.25〜10.39 日）、LEO・ISS 1〜36 ヶ月は 0.385〜0.386 日・5.785〜5.789 周、GTO 1〜36 ヶ月は 1.547〜1.548 日・3.538 周）は、すべて記述どおり。
- 1200 s の予測は 7 ミッションすべて `horizon`・1,122〜1,631 点で、記述どおり（SE・方位 0°、`s1200.mjs`）。

**§4.12（Rev 6.8）と実装の突合**:

- ステップ上限 340,000・`options.maxSteps`・`options.maxPoints` の記述は、上記の実測と一致する。値の根拠（main は 3,000 点で約 333,000〜360,000 ステップ、400,000 ではステップ数の比が約 1.2 倍）、到達範囲（SE・1 ヶ月以上で LEO 33,358 s、ISS 33,262 s、GTO 133,707 s、月遷移 1,203,081 s。main は 32,758／32,579／35,439／36,552 s）、飛行中に線が消える時刻（0.38〜0.39 日、1.55 日）も一致する（月遷移は方位 0°/180° の値。他の方位は §4.3 の方位 8 通りの記述どおり 13.80 日または `breakup`）。
- ステップ下限（0.2 ヶ月の main の実効予算 105,192、GTO 0.949 周／120,000 で 1.32 周）は Iteration 8 で確認済みで、今回のコード変更の影響を受けない（0.2 ヶ月の予測は 4 組の比較ですべて一致）。
- 1 ステップあたりの処理の削減の記述（RCS の演出状態は描画と Worker ブリッジのフラグだけが読み、物理は読まない。通常のシミュレーションでは従来どおり更新する。サンプラーの各項目）は、上記「Rev 6.8 のコード変更の検証」のとおり実装と一致する。「確認: 5 ワールド × 7 構成で md5 が一致」は作業者のログ（`perf/d2_*.log`、35 構成）で確かめ、本監査ではさらに広い範囲（計 4,378 件）で一致を確かめた。
- 受入基準 1・2 は満たす（下記）。ただし、実測の記述と計測方法の定義に、再計測と合わない点がある（G2-9-02）。

**同期ブロック時間**（`rollout()`。`t9_rollout.mjs` は Iteration 7 の `t2b_rollout_profiles.mjs` と同じ経路で、期間をミッションごとに変えたもの: 地球近傍の 4 ミッションは既定・0.2・0.5・1・12・36 ヶ月、深宇宙 3 ミッションは既定・0.2・1・36 ヶ月。4 方位（0°/90°/180°/270°）× 5 ワールド、1 回あたり 124 構成。§4.12 の方法どおり、本ブランチと main をワールドごとに交互に実行し（回ごとに先後を入れ替えた）、SE・W7 は 6 回、BIN・TB・SS は 3 回。構成ごとに両者の最小値をとって比を求めた。表の値は「構成ごとの最小値」の行内の範囲（ms）と、行内の比の最大）:

| 構成 | SE（6 回） | W7（6 回） | BIN（3 回） | TB（3 回） | SS（3 回） |
|---|---|---|---|---|---|
| `leo_250km` 既定（0.2 ヶ月） | 129〜168／114〜143（1.18） | 198〜261／173〜227（1.24） | 208〜244／172〜212（1.22） | 176〜216／153〜181（1.19） | 560〜636／535〜589（1.15） |
| `iss_rendezvous` 既定（0.3 ヶ月） | 304〜336／281〜326（1.10） | 515〜540／472〜509（1.10） | 459〜489／441〜467（1.05） | 392〜435／382〜415（1.07） | 1,392〜1,464／1,343〜1,396（1.05） |
| `gto_insertion` 既定（0.5 ヶ月） | 494〜515／469〜474（1.09） | 832〜859／776〜786（1.10） | 759〜770／724〜734（1.06） | 651〜672／645〜651（1.04） | 2,296〜2,303／2,203〜2,252（1.04） |
| **ISS/GTO/月遷移 0.2 ヶ月**（Rev 6.8 の表にない） | 230〜245／187〜193（**1.29**） | 382〜394／313〜318（**1.26**） | 349〜357／290〜300（**1.23**） | 297〜312／257〜265（**1.21**） | 1,047〜1,073／880〜925（**1.20**） |
| LEO・ISS・月遷移 0.5 ヶ月（同上） | 271〜530／260〜481（1.15） | 496〜859／456〜789（1.12） | 446〜781／426〜736（1.11） | 378〜683／361〜646（1.07） | 1,307〜2,342／1,299〜2,299（1.07） |
| `leo_250km` 1〜36 ヶ月 | 346〜354／327〜337（1.08） | 632〜652／575〜586（1.13） | 563〜585／532〜546（1.09） | 480〜494／454〜470（1.08） | 1,680〜1,719／1,656〜1,682（1.03） |
| `iss_rendezvous` 1〜36 ヶ月 | 640〜652／586〜600（1.10） | 1,079〜1,096／983〜997（1.11） | 972〜992／913〜928（1.08） | 841〜854／801〜826（1.07） | 2,973〜3,048／2,793〜2,908（1.08） |
| `gto_insertion` 1〜36 ヶ月 | 645〜677／633〜646（1.07） | 1,081〜1,100／1,060〜1,075（1.04） | 980〜1,002／990〜1,014（1.01） | 832〜863／868〜884（0.99） | 2,975〜3,003／3,018〜3,098（0.99） |
| `lunar_insertion` 1〜36 ヶ月 | 497〜690／653〜669（1.04） | 1,105〜1,122／1,089〜1,108（1.02） | 748〜1,018／1,022〜1,036（0.99） | 664〜896／887〜912（1.01） | 2,188〜3,039／3,104〜3,311（0.98） |
| 深宇宙 3 ミッション 0.2 ヶ月（同上） | 166〜192／188〜199（0.86〜1.01） | 271〜305／308〜328（0.87〜0.98） | 242〜276／287〜298（0.81〜0.93） | 212〜242／249〜268（0.82〜0.94） | 734〜824／907〜936（0.80〜0.89） |
| 深宇宙 3 ミッション 1〜36 ヶ月 | 176〜222／596〜665（0.27〜0.35） | 288〜349／989〜1,074（0.27〜0.35） | 256〜338／900〜1,019（0.26〜0.34） | 225〜283／794〜900（0.26〜0.35） | 762〜927／2,900〜3,191（0.24〜0.31） |

- **受入基準 1（main 比 1.5 倍以内、全ワールド・全期間）**: §4.12 の方法での最大比は SE 1.294（`lunar_insertion` 0.2 ヶ月・270°）、W7 1.258（`iss_rendezvous` 0.2 ヶ月・90°）、BIN 1.228、TB 1.211、SS 1.201。✓（基準との差 0.206）。同じデータを回の部分集合に分けて同じ統計量を計算すると、SE 1.29〜1.35（1〜3 回目だけでは 1.35）、W7 1.25〜1.31 で、統計量自体の変動は 0.05〜0.13。
- **受入基準 2（絶対値）**: 構成ごとの最小値の最大で、SE 690 ms（単発の最大 882 ms）、W7 1,122 ms（同 1,449 ms、負荷 4.4 の回）。✓。SS は最悪 3,048 ms で、main（3,311 ms）と同程度。
- 最大比はどのワールドでも ISS/GTO/月遷移の 0.2 ヶ月（ステップ数は本ブランチ 120,000 対 main 105,192）で、LEO 0.2 ヶ月（SE 1.18、W7 1.24）より大きい（G2-9-02）。上限（340,000 ステップ）に達する構成は 0.94〜1.13 倍。
- 負荷（`t9/load.txt`）: 1 分平均で 1.05〜2.03（16 コア）。ただし 3 回目の SE・W7・BIN は 1.6〜4.35（他プロセスの影響）。同じ構成の回ごとの比（同じ回の対）の幅は最大で SE 0.32、W7 0.44、BIN 0.41、TB 0.21、SS 0.17（3 回目を除くと SE 0.22、W7 0.24）。最小値どうしの比はこの影響を受けにくい（上記の部分集合での変動 0.05〜0.13）。
- 作業者のログ（`perf/t/`・`perf/t2/`・`perf/t3/`）も確認した。期間は既定と 1・12・36 ヶ月だけで（`PERIODS='[1,12,36]'`）、ISS/GTO/月遷移 0.2 ヶ月と 0.5 ヶ月は計測されていない。深宇宙は 2 方位・2 回で、比は 0.26〜0.72（Jupiter 1 ヶ月・0° が 0.27／0.26）。

**回帰の確認**（Iteration 7・8 の実経路ハーネスを現行ツリーで再実行し、Iteration 8 のログと比較。`run_reg.sh`）:

| ハーネス | 結果 |
|---|---|
| `s1_init_paths.mjs`・`s2_flights.mjs`・`s8_legacy_ab.mjs`・`s9_slingshot_saveload.mjs` | Iteration 8 と完全に一致（s2 は 16 機体構成の飛行・RCS フレーム数・ベイパーコーンを含む） |
| `s3_saveload.mjs snapshot` | 保存の所要時間（`saveMs`）の 4 行だけが異なり、それ以外は一致 |
| `gate2/t16_rcs_timeline.mjs`（3 機） | 現行と Iteration 8 のコードで完全に一致 |
| `v2_flight_frame.mjs` | 12 行が異なる。予測の最終時刻（例: ISS 39,262 → 33,262 s、GTO 155,735 → 133,707 s）と、機体から描画された予測線までの距離の推移の一部（例: GTO の 1,500 s で 0.9 → 2.8 km）。`it8_cap340`（Iteration 8 のコードに上限 340,000）の出力は現行と完全に一致し、`cur_cap400`（現行のコードに上限 400,000）の出力は Iteration 8 と完全に一致したので、差はすべて上限の変更による。予測は打ち切り点を除いて前方一致するので、距離の変化は、このハーネスの指標（描画された線全体のうち最も近い線分までの距離）が、打ち切られた後の周回の線分を失ったためである（回帰ではない。Watchpoint 7）。 |

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G2-9-01 [Minor]【文書】 §4.3 で Rev 6.8 に直した記述に、測定条件や実装と合わない部分が残っている（G2-8-01・G2-8-02 の修正の横展開漏れ）
- **箇所**:
  - 設計書 §4.3 L348（保証 4 (b)「深宇宙 3 ミッション × 7 期間 × 8 方位の描画上の最大角度ステップ: `BINARY_SYSTEM` 0.120〜0.135 rad、`THREE_BODY` 0.120〜0.140 rad」）
  - 設計書 §4.3 L338（終了理由の表 `point_budget`「`MAX_POINTS` に到達」）、L330（「点数予算が尽きた場合は…`MAX_POINTS` で打ち切る」）、L339（`step_budget` の式に `options.maxSteps` が現れない）
  - 対応する実装: `scripts/gravsim_calc_predictor.js:158`（`maxPoints = min(MAX_POINTS, options.maxPoints || MAX_POINTS)`）、`:163`（`maxSteps = min(cap, options.maxSteps ? max(options.maxSteps, 計算値) : 計算値)`）、`:386`（ループ条件 `points.length < maxPoints`）、`:712-716`（`endReason` の決定）
- **現象**:
  1. (b) の範囲: 記述された条件（深宇宙 3 ミッション × 7 期間 × 8 方位、各 168 件）で描画上の最大角度ステップを構成ごとに求めると、BIN は 0.0888〜0.1350 rad（0.120 未満が 80 件）、TB は 0.0888〜0.1401 rad（同 79 件）。最小は `solar_escape` 0.2 ヶ月（`horizon`）。下限 0.120 が成り立つのは `point_budget` で終わる構成（BIN・TB 各 32 件、0.1201〜0.1350／0.1201〜0.1401 rad）だけで、これは Iteration 8 が測った条件（「`point_budget` で終わる構成ごとの最大値」）である。Rev 6.8 は条件の文言を「7 期間 × 8 方位」に広げたが、数値は `point_budget` の構成のものが残っている。最大値（BIN 0.135 rad、TB 0.140 rad、Mars 36 ヶ月・方位 225°）と回転量（7.8〜15.3 周）は正しい。
  2. 終了理由の表: 保証 2 は `options.maxPoints` で上限を下げられると書いており、`maxPoints: 500` を渡すと 500 点・`point_budget` で終わる（4 経路とも、`d5_points_worker.mjs`）。ところが、表は `point_budget` を「`MAX_POINTS` に到達」と定義している。同様に、`step_budget` の式は `options.maxSteps` で下限が上がることを含まない（§4.12 には書かれている）。アプリの呼び出し経路はどちらも渡さないので、アプリの挙動は表どおりである。
- **影響**: 設計書から期待値を作ると、正しい実装に対してテストが失敗する。例えば、BIN/TB の深宇宙で「最大角度ステップ ≥ 0.120」を確かめるテストは 0.2 ヶ月で失敗する。「`point_budget` ⟹ 点数 = 3,000」を確かめるテストは、`maxPoints` を下げた呼び出しで失敗する。
- **原因**: G2-8-02 の修正で条件の文言を書き換えたとき、下限を測り直していない。G2-8-01 の修正では保証 2 と §4.12 を直したが、同じ上限を定義している終了理由の表を直していない。
- **修正方針**: (b) は「`point_budget` で終わる構成（BIN・TB 各 32 件）で 0.120〜0.135／0.120〜0.140 rad」と条件を書くか、全 168 件の範囲（0.089〜0.135／0.089〜0.140 rad）に改めるか、下限を書かない（保証 1 に必要なのは最大値だけ）。終了理由の表は、`point_budget` を「点数予算 `maxPoints`（`min(MAX_POINTS, options.maxPoints)`。アプリの経路では `MAX_POINTS`）に到達」とし、`step_budget` の式に `options.maxSteps` の扱いを加えるか、§4.12 を参照させる。横展開として、§4.3 のほかの「範囲」の記述の下限・上限が、書かれた条件の全件で成り立つかを確かめること（本監査で確かめた範囲では、ほかの記述は一致した）。
- **分類**: 【文書】。設計書の記述を直すだけで済み、実装・テストの変更は要らない。訂正後も要求（保証 1: 0.15 rad 以内。実測の最大 0.140 rad）は満たされる。

#### G2-9-02 [Minor]【文書】 §4.12 の同期ブロック時間の実測と根拠の記述が、§4.12 自身の基準（全期間）と計測方法で測り直した結果と合わない。最大比になる構成が実測表から抜けており、計測方法には、どの構成を測るかと、余裕と比べるばらつきの定義がない
- **箇所**: 設計書 §4.12
  - L461（「最大比は 7 天体の LEO 0.2 ヶ月で 1.25 倍（ステップ下限 120,000 対 main の 100,000 による）。…基準 1.5 との差は 0.25 以上で、回ごとのばらつき（0.1〜0.17）を上回る」）。L440（「0.2 ヶ月の LEO はこの下限で予算が決まるため、main 比が最も大きい構成になる」）
  - L451-460（実測表。期間は既定と 1〜36 ヶ月だけ）
  - L463（「深宇宙 3 ミッション（…1・12・36 ヶ月、2 方位、2 回）は Sun+Earth・7 天体で main の 0.46〜0.72 倍」）
  - L449（計測方法。回数と統計量はあるが、構成の範囲（期間・方位）がない）、L450（余裕の比較対象「同じ構成の回ごとの比のばらつき 0.1〜0.17（Iteration 8）」）
- **現象**（上記「同期ブロック時間」）:
  1. 受入基準そのものは満たしている（最大比 1.294、SE 690 ms、W7 1,122 ms）。
  2. しかし、5 ワールドすべてで、最大比になるのは ISS/GTO/月遷移の 0.2 ヶ月（SE 1.29、W7 1.26、BIN 1.23、TB 1.21、SS 1.20）で、LEO 0.2 ヶ月（SE 1.18、W7 1.24）ではない。これらの構成は Rev 6.8 の実測表にない。作業者の計測は `PERIODS='[1,12,36]'` と既定期間だけで、Iteration 8 の表にはあった「ISS/GTO/Lunar 0.2 ヶ月」の行（SE 1.48）が落ちている。このため、「最大比は…LEO 0.2 ヶ月で 1.25 倍」「基準との差は 0.25 以上」は、基準の対象である全期間では成り立たない（実際の差は 0.21）。
  3. 「ステップ下限 120,000 対 main の 100,000」: 0.2 ヶ月の main の実効予算は 105,192 ステップである（実測。同じ §4.12 の L440 もそう書いている）。ステップ数の比は 1.14 で、1.2 ではない。
  4. 深宇宙: 「Sun+Earth・7 天体で main の 0.46〜0.72 倍」は再現しない。本監査（4 方位・6 回）では 1〜36 ヶ月で SE・W7 とも 0.27〜0.35、0.2 ヶ月で 0.86〜1.01／0.87〜0.98。作業者自身のログ（`perf/t3/`）でも 0.26〜0.72（Jupiter 1 ヶ月・0° が 0.27／0.26）で、下限 0.46 はどちらとも合わない。また、2 回の計測は §4.12 自身の方法（SE・W7 は 6 回以上）を満たさない。
  5. 計測方法（L449）は回数と統計量（構成ごとの最小値どうしの比の、全構成での最大）を定めているが、どの構成（期間・方位）を「全構成」とするかを定めていない。この統計量は測る構成を増やすほど大きくなるので、結果は構成の選び方で変わる。実際、作業者の構成の範囲には最大になる構成が入っていなかった。さらに、余裕と比べる「回ごとの比のばらつき 0.1〜0.17」は Iteration 8 の 1 回の観測値で、何のばらつきかが定義されていない。本監査では、同じ構成の対の比の幅は 0.17〜0.44（3 回目（負荷 1.6〜4.35）を除くと 0.15〜0.24）、最小値どうしの比（判定に使う統計量）の部分集合での変動は 0.05〜0.13 だった。
  6. （参考）冒頭の改訂履歴と §4 ヘッダの Rev 6.8 の日時（02:46 JST）は、表に含まれる BIN・TB・SS の計測（`perf/t2/load.txt`、02:45〜03:09）と深宇宙の計測（`perf/t3/`、03:07〜03:10）より前で、設計書の更新時刻（03:11）とも合わない。
- **影響**: 工程 3・4 で、受入基準を CI などで再現するときに、測る構成によって最大比と余裕が変わる。また、「最大は LEO 0.2 ヶ月・1.25 倍」「深宇宙は 0.46 倍以上」を前提にした期待値や監視は誤る。
- **原因**: Rev 6.8 の再計測は、地球近傍 4 ミッションの既定期間と 1・12・36 ヶ月だけを対象にした（`perf/run_t.sh`・`run_t2.sh`）。深宇宙は 2 回の短い計測から書いた。その結果を「全期間」の基準の実測として一般化した。
- **修正方針**: 計測方法に、測る構成（例: 7 ミッション × {既定、0.2、0.5、1、12、36 ヶ月} × 4 方位 × 5 ワールド）、負荷の条件（例: 1 分平均 2 以下の回だけを使う、または記録して外れ値の回を除く）、余裕と比べるばらつきの定義（例: 回を 2 つに分けた部分集合での統計量の差）を書く。実測の記述を、最大比（SE の ISS/GTO/月遷移 0.2 ヶ月で約 1.29）、余裕（約 0.2）、0.2 ヶ月の main の予算（105,192 ステップ。比 1.14）、深宇宙（方法どおりの回数で測った値）に改める。改訂履歴の日時を実際の改訂に合わせる。実装の変更は要らない（基準を満たしている）。
- **分類**: 【文書】。設計書の記述を直すだけで済み、実装・テスト・設定の変更は要らない。実態に合わせて直しても、要求（全ワールド・全期間で main 比 1.5 倍以内、SE 1 s・W7 2 s 以内、余裕が §4.12 の 0.17 を上回る）は満たされる（最大比 1.294、差 0.206。統計量の変動 0.05〜0.13 も上回る。SE 690 ms、W7 1,122 ms）。

---

### 2. 前ゲートの文書指摘の解消確認

該当なし（独立監査1 は Iteration 6 で指摘なしの PASS。独立監査2 の Iteration 8 は FAIL で、その指摘の解消は上記「Iteration 8 指摘・Watchpoint の解消確認」に記録した）。

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 呼び出し元が迂回できる上限（G2-8-01、Iteration 7 WP6） | `runMultiBodySimulation` の `options` は `maxSimTime`・`maxPoints`・`maxSteps` の 3 つ。`maxPoints`・`maxSteps` は 4 経路（直接・`calculateSync`・Worker・Worker への直接メッセージ）で上限を超えない（d5）。`maxSimTime` には上限の主張がなく、計算量はステップ上限で抑えられる。ほかの上限（`DT.DEEP_SPACE_MAX_CAP`、`SAMPLING.MAX_ANGLE_STEP_RAD`、`RENDER.PREDICTED_TRAJECTORY.ACTUAL_MAX_POINTS`、`SIMULATION.TIME_SCALE_BASE_CAP`）は Iteration 8 から変わらず、呼び出し元の引数で変えられない。異常値（負値・数値でない文字列）の扱いは未定義（Watchpoint 3）。 | 不要 |
| 実測値の測定条件（G2-8-02） | §4.3 の実測表・方位 8 通り・1200 s（1,122〜1,631 点、全件 `horizon`）・保証 3 の回転量・保証 4 (a) の最小・(b) の到達率と回転量と最大値、§4.12 の main のステップ数と到達時刻・400,000 の比・ステップ下限は、書かれた条件で再現した。条件より広く書かれていたのは、(b) の最大角度ステップの下限（G2-9-01）と、§4.12 の最大比・余裕・深宇宙の比・ステップ下限の説明（G2-9-02）。 | **要**（G2-9-01・G2-9-02。いずれも【文書】） |
| 計測のばらつきの上にある基準（G2-8-03） | 受入基準 1 は最大比 1.294 で、統計量の変動（0.05〜0.13）と Iteration 8 の対の比の幅（0.17）を上回る余裕（0.206）がある。基準 2 は SE で 310 ms、W7 で 878 ms の余裕。ただし、余裕と比べるばらつきの定義と、測る構成の範囲が設計書にない（G2-9-02 (5)）。 | **要**（G2-9-02） |
| 予測器で計算している描画専用の状態（RCS の省略の横展開） | RCS の演出状態は省略された。残っているのは次のとおり。<br>・タンク圧の模擬（`CalcRocket.updatePressure`、`gravsim_calc_object.js:1051-1219`、毎ステップ `Math.random` 2 回・`Math.sin` 2 回）。読み手は Worker ブリッジの `TM_TANK_PRES_*`、`TelemetryPanel`・`TelemetryCard`（`presState` はテレメトリパネルの表示判定だけ）で、物理・誘導・段階遷移は読まない。予測器で止めると（`nopres_tree`）、予測結果は同一のまま、SE の LEO 1 ヶ月 328〜340 → 292〜296 ms、ISS 1 ヶ月 652〜668 → 618〜620 ms、LEO 0.2 ヶ月 229〜232 → 213〜216 ms（5〜11% 減、`p1.log`）。<br>・マッハ数（`AeroUtils.computeMach`。大気中のみ）、`FlightComputer` のテレメトリ（`remDv` の段ごとの `Math.log`、`twr`、`aV`/`aH`）。<br>設計書が除外を求めているのは RCS だけなので、不備ではない。 | 任意（性能の余地。Watchpoint 5） |
| 予測結果に含まれる、実行履歴に依存する値 | 予測の `hostId` と各点の `domId` は、プロセス内でそれまでに作られた天体の数で決まる ID で、同じ構成でも実行順で変わる（`det_probe.mjs`。ID を除くと同一）。物理には影響しない。 | 不要（Watchpoint 2） |
| 0 が正当な値になるフィールドへの `\|\|`（Iteration 7 WP4） | Iteration 8 から変わっていない（`maxPoints` の新しい行も `options.maxPoints \|\| MAX_POINTS` で、0 は既定値になる。これは G2-8-01 の修正方針どおり） | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **ビット同一性は実測による確認である**: 速さの閾値の二乗比較（`speedSq > 0.01`・`> 25`）は、境界の極めて近く（相対 5e-15 以内）では `Math.hypot` による比較と判定が入れ替わり得る。本監査の 4,378 件（`d3`・`d4`）では差は出なかったが、数学的な等価性はない。今後サンプラーを最適化する場合も、同じ規模の総当たり（数値を厳密にハッシュし、同じ実行順で比べる）で確かめること。
2. **予測結果の ID は実行順に依存する**: `hostId`・`domId` は、プロセス内でそれまでに作られた天体の数で変わる。工程 3 で予測結果をスナップショット（ゴールデン値）として比べるテストを書く場合は、これらを除くか、天体の生成順を固定すること。
3. **`maxPoints`・`maxSteps` の異常値**: 負の `maxPoints` は 1 点・`point_budget`・0 ステップ、数値でない文字列（`'abc'`）は `NaN` になり、1 点・`step_budget`・0 ステップで終わる（`maxSteps: 'abc'` も同じ。どちらも Iteration 8 のコードから変わらない）。設計書はこれらを定めていない。工程 3 の異常系テスト（Iteration 8 WP1）では期待値を設計書で決めてから書くこと（`step_budget` はステップ予算に達したことを意味しないので、検証して拒否するか既定値に戻す仕様を検討すること）。
4. **同期ブロック時間の計測**: 判定には、ISS/GTO/月遷移の 0.2 ヶ月を必ず含めること（どのワールドでも最大比になる）。負荷が 3〜4 の回では、同じ構成の対の比の幅が 0.44 まで広がった。工程 3・4 で計時をアサーションにする場合は、交互実行・規定回数・構成ごとの最小値を守り、負荷を記録して高負荷の回の扱いを決めること。現在の余裕は比で 0.21、絶対値で SE 310 ms・W7 878 ms。
5. **描画専用の計算の省略の余地**: 予測器のタンク圧の模擬は 5〜11% のコストで、結果に影響しない。今後省く場合は、`trackRcsVisualState` と同様に予測器だけで止め、通常のシミュレーション（Worker）は従来どおりにすること。主スレッドの `Math.random` の消費が変わるので、乱数を使うほかの処理（破片の ID など）の並びも変わる。そのうえで、ビット同一性（予測）と `r1_mainsim_rcs.mjs` 相当（通常のシミュレーション）を確かめること。
6. **上限 340,000 と main の関係**: 地球近傍の閉軌道の到達時刻は main をわずかに上回るだけである（ISS 33,262 対 32,579 s、LEO 33,358 対 32,758 s）。上限をさらに下げると、飛行中の予測線が main より早く消える。保証 3（0.2 ヶ月で 1 周以上）は下限 `MAX_STEPS` で決まり、上限には依存しない。
7. **`v2_flight_frame.mjs` の距離の指標**: この指標は、描画された線全体のうち最も近い線分までの距離なので、予測の長さ（周回数）で変わる。工程 3 で「機体が予測線上にある」ことをテストする場合は、現在時刻に対応する区間までの距離で判定すること。
8. **引き続き有効な Watchpoint**: Iteration 8 の WP1（Rev 6.7 のコード変更のテスト。今回の `maxPoints` の上限、`trackRcsVisualState` の既定値と予測器での無効化を含めること）、WP2（保証 1 の余裕 0.010 rad）、WP3（(b) のワールドでは中間の期間でも点数予算で終わる）、WP5（保証 5 に `horizon` もある。BIN の方位 135°・0.5 ヶ月）、WP6・WP7。Iteration 7 の WP3・WP5、Iteration 6 の WP2・WP5、Iteration 4 の WP2〜WP8、Iteration 1・2 の Watchpoint。lint 警告 54 件（testsuites）も残る。

---

## 独立監査3: テスト設計・実装監査 — Iteration 1

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 1
- **実施日時**: 2026-11-21 06:40〜08:00 JST
- **判定**: **FAIL**（【実装】Major 3 件・Minor 5 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §2・§3.3・§3.4・§4、設計書 Rev 6.10、テスト計画（`docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md`。§1〜3 を計画、§4 を作業者の申告として扱う）、`testsuites/README.md` §2-D、独立監査2 Iteration 9 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。

- **差分の特定**: 独立監査2 の終了時の md5（`gate2_it9/md5_end.txt`、140 件）と現行ツリーを突き合わせた。変わったのは、設計書、`package.json`（`perf:rollout` の追加）、`testsuites/README.md`、本体 5 ファイル（`gravsim_calc.js`・`gravsim_calc_predictor.js`・`gravsim_flight_computer.js`・`gravsim_rocket_launcher.js`・`gravsim_tab_rocket.js`）と、新規のテスト計画・テスト 19 ファイル（unit 06〜10・07b、integration 11〜14、regressions 08〜10、system 01〜04・`cdp_helpers.mjs`、`perf/rollout_timing.mjs`）。`docs/development_process.md`・プリセット・`types/`・他のソースは変わっていない。本ファイルは独立監査2 の終了時から変わっていない（md5 `b7d7ee25…`）。
- **変更前の本体**: 作業者の申告した `scratchpad/phase3/gravsim_calc_before_R2R3.js`・`pre_D_fix/`（3 ファイル）・`predictor_before_opts.js` の md5 は、独立監査2 の終了時の値と一致した。これを原本として差分を全行読んだ（`gate3_it1/diffs/`）。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画は一切変更していない。監査開始時（`gate3_it1/md5_start.txt`、159 件）と終了時（`md5_end.txt`）で、`git status --short` と、`scripts/`・`testsuites/`・`presets/`・`types/`・`docs/`（本ファイルを除く）・設定ファイル（`package.json`・`jsconfig.json`・`.eslintrc.json`・`index.html`・`style.css`・`manifest.json`）の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,244 行は追記前と同一。
- **突然変異の方法**: すべて `gate3_it1/` 下のコピー上で 1 箇所ずつ不具合を入れ、テストを実行してから元に戻した（作業ツリーには触れていない）。単位 B は本監査で 22 件を作った（`mutB/mutate.mjs`）。単位 A・C・D・E は、本監査が起動した独立の補助エージェント 4 体が各単位のテストを読んで計 308 件（A 68・C 73・D 109・E 58）を作り（`agent_A/`〜`agent_E/`）、生き残ったもののうち主要な 9 件を、本監査が `npm test` と同じ非 system の全 1,078 件に対して再実行して確かめた（`survivors/verify.mjs`）。補助エージェントの結論は、本監査が再現できたものだけを指摘に使った。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it1/`）: `run_checks.sh`（テスト・カバレッジ・機械的チェックの順次実行、各 `.log`・`.done`・`.load_*`）、`ident/run_ident.sh`（本体変更前後の一致の再実行）、`mutB/`（単位 B の突然変異）、`survivors/`（生き残った変異の全スイート再実行）、`probeE/`（保存・読込後の継続の精度、変更していない本体のコピー上）、`hang/`（タイムアウト処理の退行で止まることの確認）、`reg08_alone.log`、`perf_SE.*`（`perf:rollout` の試行）、`agent_A/`〜`agent_E/`（補助エージェント）。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 全テスト | `npm test` | **1,102/1,102 pass**・fail 0・cancelled 0・skipped 0・todo 0（175 スイート）。所要 70.3 s（load average 0.94 → 3.22、16 コア） |
| E2E 1 回目 | `npm run test:system` | 24/24 pass・skipped 0、44.4 s。前後とも GravSim の Chromium プロセス 0、`/tmp/gravsim-*` 0 |
| E2E 2 回目 | `npm run test:system` | 24/24 pass・skipped 0、44.3 s。終了後のプロセス・一時ディレクトリ 0（`npm test` の中の 1 回と合わせて 3 回） |
| Chromium なし | `CHROME_PATH=/nonexistent/chromium node --test testsuites/system/03_*.test.mjs` | 終了コード 1、4 件 cancelled・skipped 0、「Chromium is not available」で失敗。一時ディレクトリは作られない |
| カバレッジ | `npm run test:coverage` | 1,102 pass、152.9 s。**行 99.26%・分岐 91.82%・関数 96.40%**（作業者の申告は分岐 91.85%。下記 Watchpoint 6） |
| 構文 | `npm run check:syntax` | exit 0 |
| Lint | `npm run check:lint` | エラー 0／警告 54（全件が既存の 16 ファイル。追加した 19 ファイルは 0 件） |
| 型 | `npm run check:types` | エラー 0 |
| 本体変更前後の一致 | `perf/d2.mjs`（5 ワールド × 7 構成の同期予測の結果全体の md5）、`gate2_it2/s2_flights.mjs`（実飛行） | 独立監査2 の終了時のツリーと現行ツリーで**完全に一致**（d2 35 件、s2 15 機の全行。下記） |
| 回帰 08 単独 | `node --test testsuites/regressions/08_*.test.mjs` | 30/30、55.0 s（`npm test` の並列実行の中では 69.7 s） |
| 単位 B の突然変異 | `mutB/mutate.mjs`（22 件） | **22 件すべて検出** |
| 同期ブロック時間 | `npm run perf:rollout -- --baseline scratchpad/main_tree --worlds SE` | 6 回（交互・先後入れ替え）。最大比 1.285（`lunar_insertion` 0.2 ヶ月・0°）、余裕 0.215、スクリプトの変動 0.024、基準 2 は 693 ms（`lunar_insertion` 1 ヶ月・180°）で、基準 1・2 は満たす。ただし load average 1.92〜4.84 で「半数以上が 2.0 以下」を満たさず、スクリプトは終了コード 1（再計測を求める）を返した。独立監査2 Iteration 9 の値（1.294・690 ms）と同程度で、スクリプトは §4.12 の手順どおり動く（変動の定義は G3-1-08）。所要 661 s |

**工程 3 での本体の変更（作業者の申告 §4.4）の検証**:

1. **`PhysicsEngine._getRotationOmega`**（`gravsim_calc.js:181-184`）: `param.ROTATION_PERIOD ?? rotationPeriod ?? プリセット ?? 0` を、有限かつ `|P| > 1e-6` のときだけ `2π/P` にする。自転角の積分（`:496-499`）とホールドダウン（`:191`）の両方がこれを使う。変更前のホールドダウンは `host.param || プリセット` の `ROTATION_PERIOD` が真のときだけ回転していた。`addObject` は `param = data.param || プリセット`（`:47`）と `rotationPeriod = data.rotationPeriod ?? param?.ROTATION_PERIOD ?? 0`（`:115`）を必ず設定するため、アプリの経路（周期は常に `param` にある）では両者は同じ値になる。違いが出るのは、`param` に周期がなく `rotationPeriod` だけがある場合（`updateObject` 経由。主スレッドは `rotationPeriod` を送らない）と、`|P| ≤ 1e-6`・非有限の場合だけで、いずれも新しいほうが自転角の積分と一致する。予測エンジン（`PredictorPhysicsEngine.step` = `_moveObjects`）も同じメソッドを継承する。
2. **ホールドダウン中の最終速度の省略**（`:557-558`）: 解除は `RELEASE_HOLD_DOWN`／`setRocketState` のメッセージでステップの間に起きるため（`gravsim_calc_object.js:988-993`、`gravsim_calc.js:882`）、解除後の最初のステップでは `_updatePositionAndHalfVelocity` が半速度を作り直し、古い `_half_vx` は使われない。ホスト付きの機体では、変更前も `_updateHoldDownPositions(0)` が最終速度を上書きしていたので結果は同じ。違いはホストが見つからない機体だけで、変更前は位置を変えずに速度だけが積分されていた。
3. **`FlightComputer` のコンストラクタ**（`gravsim_flight_computer.js:19, 64-67`）: 存在しない `this.config` から読んでいた目標値を `config` から読む。`CalcRocket` は毎ステップ `_sensorData` に目標値を入れ、`update()` が `_computeThrustAngle` の前に反映する（`:264-266`）ので、飛行中の挙動は従来どおりで、最初の `update` より前の状態だけが変わる。重複していた `disableOrbitalCutoff` の代入も 1 つになった。
4. **フライトプランの行の除去**（`gravsim_flight_computer.js:19`、`gravsim_rocket_launcher.js:748-753`、`gravsim_tab_rocket.js:1152-1156`）: オブジェクトでない行を除き、配列でない値は空にする。保存されたラッチの行番号は Worker の `FlightComputer` が除去後の配列で作り、読込でも同じ除去を通るので一致する。`CalcRocket.flightProfile`（`gravsim_calc_object.js:285`）と `ObjectManager.loadState` の機体の `flightProfile`（`gravsim_object_manager.js:539-542`）は除去しないが、どちらも `FlightComputer` へ渡すか保存し直すだけで、行を参照する主スレッドのコード（`gravsim_rocket_launcher.js:370, 483`、`gravsim_tab_rocket.js:473, 934`）は除去済みの `RocketLauncher.flightProfile` だけを読む（grep で確認）。
5. **予算オプションの数値化**（`gravsim_calc_predictor.js:157-167`）: `Number()` が正のときだけ使う。アプリの経路は `maxSteps` を渡さず（`config.maxSteps` は未設定）、`maxPoints` には `MAX_POINTS` を渡す（`gravsim_trajectory_predictor.js:244-245`）ので結果は変わらない。
6. **一致の再実行**: 独立監査2 の終了時のツリー（`phase3/pre_R2R3_tree`。`scripts/` の md5 が独立監査2 の終了時と一致）と現行ツリーで、`d2.mjs` を 5 ワールド（`WORLDS=SE,W7,SS,BIN,TB`）× 7 構成、`s2_flights.mjs` を実行した。出力の md5 は d2 `2e22aefa…`、s2 `91c5b981…` で、前後とも、作業者の 4 つのログとも一致した。なお、s2 の飛行は 15 機で（最終行は合計）、テスト計画 §4.4 の「16 構成」は誤り（G3-1-09）。上記 1・2 の違いはアプリの経路では起きないため、この比較は変更した分岐を通らない。分岐そのものは単体テストが検出する（補助エージェントが変更前の `gravsim_calc.js` を部分的に戻した 4 通りの変異をすべて検出。`FlightComputer`・`RocketLauncher`・`RocketTab` の変更前のコピーと部分的な戻しも 8 通りすべて検出。単位 B の `maxSteps` の戻し（B20）も検出）。

**テスト計画 §3 の項目ごとの突合**（○: 設計から導いた期待値で正常系・異常系・境界値がある、△: 一部不足、×: 欠落）:

| 単位 | 結果 | 主な根拠 |
|---|---|---|
| A 自転角・バッファ・同期 | ○（一部 △） | 51 スロット・フラグ・段状態コードの値と丸めの境界（1.49/1.5/5.5/−0.6/NaN/±Infinity）、番兵値で埋めた再利用バッファで全種別の 47〜50 の上書き、周期の正・負・0・NaN・1e-6 の隣接値、ホールドダウンの位置・速度（1/2/7/40 サブステップ、1e-6 m・1e-9 m/s）、2 パスの順序、間引きの境界、静止軌道の実飛行、先減算の厳密一致。△: デブリの解析側の自転角の消去、`_moveObjects` 内の呼び出し順（G3-1-06） |
| B 予測サンプラー・終了理由・描画 | ○ | 6 種の終了理由を閉じた形の運動（質量 0 のホスト・円軌道・脱出速度の倍数）で作り、境界（0.01 s、1e-4 m²、MIN_SAMPLE_DT_S の 0.0499/0.05/0.0501、E の ±0.05%、ステップ予算の式と 600,000/1,700,000 s 前後）を設計の式で確かめる。予算オプションは 15 種の異常値を設計の規則と照合。描画は記録用 ctx の座標で厳密比較。回帰 08 は §4.3 の表・方位 8 通り・保証 1〜5 を 5 ワールドで確かめる。突然変異 22 件すべて検出 |
| C RCS・ベイパーコーン・マッハ | ○（一部 △） | 不感帯・0.08 rad・気圧比 0.35・デューティ・アレージ 1.5 s・ダンピング位相の前後と一致、ノズルの表を力とトルクでも確認、§4.4 の 0.8199〜1.2201 の表。△: Rev 6.10 で追記した記述（`L` の下限・LOD 既定値・180 K）の未検証、件数を確かめないループ（G3-1-04・G3-1-05） |
| D フライトプラン | △ | トリガの境界（隣接する倍精度値）、ラッチ、`ORBIT_ASSIST` のクランプ 4 種と 140 km・4,200 m/s・0.88・1.5 の一致、7 ミッションの表（設計の表 = テスト = プリセット）、6 列の表、G2-02/04/05。×: 1 ステップに複数のアクションが積まれた場合の実行、`vel` 行の補間、`r_tgt` の平均項、燃料種変更時のスライダ同期（G3-1-03）。△: V∞ の一致・TWR 下限（G3-1-04） |
| E 実行時状態・保存・復元 | △ | 復元分岐の契約（'true'・1・{} など）、§4.7 の項目の一覧の一致、時間 1e10・圧力 2×MAX の前後、`presState` の許可リスト、ラッチの検証、2,000 ms のタイムアウト（偽タイマで 1,999/2,000 ms）、§3.5-1 の表の項目名。×: 真偽値の項目の保存・復元（G3-1-02）、継続の精度（G3-1-01）。△: タイムアウト処理の退行でテストが止まる（G3-1-07） |
| F ヘッドレス Chrome | ○ | `listen(0, '127.0.0.1')`・`os.tmpdir()` 配下の一時プロファイル（`XDG_CONFIG_HOME` も中に置く）・プロセスグループと `--user-data-dir` での終了・`after` と `process.on('exit')` での片付け・Chromium がないと失敗（テストあり）。コレクタの見逃しがないことを、わざと例外・`console.error`・`alert` を起こすタブで自己テストしている。正常系（起動・配置・予測線の画素と PRED の切替・6 列・320 px・打上げとテレメトリ・段分離とデブリ・保存と読込）、異常系（不正なセーブ 10 種、不正な入力）、境界値（予測期間 0.2/36 ヶ月とその外、推力スライダ、0/1/多数の行）がある |

**テスト計画 §4.5（確かめられなかった項目）の理由の検証**:

| 項目 | 理由は妥当か | 確認内容 |
|---|---|---|
| 最終点の重複除去の時刻の境界（1e-6 s） | ○ | 0.01 s 以下の残りは積分しない（`:403-406`）ので、異なる 2 時刻の差は常に 0.01 s を超える |
| E がちょうど 0 | ○ | E はステップ後の状態から求めるため、ちょうど 0 になるステップを作れない |
| V∞ がちょうど目標値 | **×** | カットオフと同じ式の順で `targetVInfKmS = Math.sqrt(2 * E) / 1000` とすると、一致で `STG_MECO`、1 ulp 上で `STG_BURNING` になる（`agent_D/probe/vinf_equal.mjs` を本監査で実行） |
| `ORBIT_ASSIST` の E ≥ 0 の単独条件 | ○ | E ≥ 0 では遠地点が無限大になり、0.88 倍の条件が常に成り立つ（論理的に冗長） |
| 気温の下限 180 K | **×** | `getAtmosphericTemperatureK(1e-310, { ATM_SCALE_HEIGHT: 1e-310 })` は 180 K、音速 268.95 m/s、`computeMach(300)` は 1.115（本監査で実行）。`0.0065 / scaleRatio` が無限大になり、生の気温が −Infinity になるため。NaN になるのは高度 0 以下だけ |
| 深宇宙サイジングの TWR 下限 | **×** | 計画の出力（各段・ペイロード・フェアリング・ブースタの質量の和）から TWR を求めると、`h3_30` の Jupiter・Solar と `falcon9` の 3 ミッションで 1.250 ちょうどになり、下限を確かめられる（`agent_D/probe/twr.mjs` を本監査で実行） |
| 飛行中に予測線が最終点で消えること（E2E） | ○ | 実時間で数時間かかる。単体（`unit/07` の 39.999/40/40.001 s）と回帰 08（全件で最終点 −1 s・+0.001 s）が確かめる |
| 120 s のフルカウントダウン（E2E） | ○ | 即時点火で同じ経路を通る |
| 同期ブロック時間の受入基準 | ○ | 負荷に左右される。`perf/rollout_timing.mjs` で測る |

**`perf/rollout_timing.mjs` と §4.12 の突合**: 構成（7 ミッション × 期間（地球近傍 4 ミッションは既定・0.2・0.5・1・12・36 ヶ月、深宇宙は既定・0.2・1・36 ヶ月、重複除去）× 4 方位 = 1 ワールドあたり 124 構成）、経路（`ObjectPlacer`／`deployProfile` → `applyToLauncher` → `rollout()`。`rollout()` は `updatePredictionSync()` を先に呼ぶので `updatePrediction` の差し替えは計時に影響しない）、交互実行と回ごとの先後の入れ替え、回数（SE・W7 は 6 回以上、他は 3 回以上を強制）、負荷の記録と「半数以上が 2.0 以下」、統計量（構成ごとの最小値の比の最大、基準 2 は本ブランチの最小値の最大、SE 1 s・W7 2 s）は §4.12 どおり。独立監査2 Iteration 9 の `t9_rollout.mjs` と同じ経路。ただし、余裕と比べる「統計量自体の変動」の計算が §4.12 の定義と異なる（G3-1-08）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-1-01 [Major]【実装】 保存・読込を挟んだ飛行が中断しない飛行と一致しない。Rev 6.10 はこれを「継続の精度」として仕様にしたが、原因の記述が誤っており、精度の範囲も一部の機体でしか成り立たない（要求の後退）
- **箇所**:
  - 設計書 §4.7 L404（「継続の精度」。Rev 6.10 で追加）。要求は §1 の表 #5「`getState`/`loadState`＋`CalcRocket` 完全復元」、テスト計画 §3-E「保存しなかった場合と同じ経過になる」
  - `scripts/gravsim_calc_object.js:298`（`this._thrustRatio = 0`）、`:403`（`this._wasFiring = false`）、`:425-440`（`getRuntimeState` に推力の状態がない）、`:1566-1577`（推力は `_thrustRatio > 0` のときだけ加速度に入る）、`scripts/gravsim_calc.js:121`・`:572-578`（`addObject` が `_calculateForces` を呼び、重力・空力・推力から加速度を求める）
  - `testsuites/integration/14_save_load_runtime.test.mjs:76`、`testsuites/regressions/10_persistence_findings.test.mjs:70`（`ORBIT_REL_TOL = 0.01`）。継続を比べる機体は `h3_30`・`h3_22` だけ（integration 14 の 6 件、回帰 10 の G2-07）
- **現象**:
  1. 読込後の機体は `_thrustRatio = 0` で作られ、`addObject` の `_calculateForces` が求める最初の加速度に推力が入らない。このため、燃焼中に保存した飛行は、最初の半ステップ分だけ推力を失い、中断しない飛行からずれる。`_wasFiring` も復元されず、読込直後のタンク圧の模擬が「点火」を検出し得る。
  2. 設計書の説明（「`addObject` が重力だけから加速度を求め、最初の半ステップには推力・抗力が入らない」）は誤り。`_calculateForces` は `_applyAerodynamics` を含み、抗力は入る。欠けるのは推力だけで、原因は加速度を保存しないことではなく、推力の状態を復元しないことである。
  3. 設計書は「テストはこの範囲（軌道要素 1% 以内）で判定する」とするが、1% は `falcon9` で成り立たない。変更していない本体のコピーで integration 14 と同じハーネスを使い、900 s 後の軌道要素を比べた（`probeE/zz_probe.test.mjs`）:
     | 機体・ミッション | 保存時刻 | 近地点（中断なし → 読込後） | 遠地点の差 |
     |---|---|---|---|
     | `falcon9`・ISS | 100 s / 300 s（燃焼中） | 143.75 → 146.75 / 147.60 km（**2.08% / 2.68%**） | 0.24% |
     | `falcon9`・LEO | 100 s / 300 s（燃焼中） | 141.82 → 143.52 / 144.09 km（**1.20% / 1.60%**） | 0.62% / 0.76% |
     | `h3_22`・ISS | 100 / 300 / 500 s | 0.05〜0.28% | 0.05〜**0.61%** |
     | `h3_24`・LEO | 100 / 300 / 500 s | 0.01〜0.19% | 0.03〜0.24% |
     | `falcon9`（2 ミッション） | 500 s（`ORBITAL_COAST`） | 差 0.000% | 0.000% |
     軌道投入後の保存は完全に一致するので、ずれは燃焼中の保存だけで起きる。テストが `falcon9` を飛ばさないため、1% の判定で通っている。
- **影響**: 設計書の要求（完全復元、保存しなかった場合と同じ経過）を満たさない。Rev 6.10 の記述はこの差を仕様として受け入れ、原因を誤って書いているため、直すべき欠落（推力の状態の復元漏れ）が隠れる。テストの許容値 1% は、測った 2 機体にしか根拠がない。
- **原因**: §4.7 の `runtimeState` の項目に、推力の状態（`_thrustRatio`）とタンク圧の点火検出の状態（`_wasFiring`）がない。工程 3 で差を見つけたとき、原因を確かめずに許容範囲として設計書へ書いた。独立監査2 Iteration 2 も「falcon9 で Pe 3.5 km 以内」の差を観測していたが、指摘にしていなかった。
- **修正方針**: 推力の状態を復元する（`runtimeState` に `thrustRatio` と `wasFiring` を加えて検証付きで復元する、または復元した機体では保存した加速度をそのまま使う）。そのうえで、継続を「イベントの時刻が一致し、軌道要素の差が数値誤差の程度」で判定するテストに改め、`falcon9` を含む全機体と、燃焼中・段間・ペイロード分離後・射点での保存を加える。§4.7 の記述は、修正後の実測に合わせて書き直す。差を受け入れる場合は要求の変更になるので、§1 の表 #5 とテスト計画 §3-E を改め、原因の正しい説明と全機体での上限を書いたうえで、利用者の判断を得ること。
- **分類**: 【実装】。本体（`runtimeState`）とテストの変更が必要。また、記述を実態に合わせて直すだけでは要求（完全復元）を満たさない（§4 の 5 の 1 の 3 つ目）。

#### G3-1-02 [Major]【実装】 §3.5-1 の真偽値の項目（`isPayloadSeparated`・`isHoldDown` など）の保存・転送・読込を、どのテストも確かめていない（期待値が既定値と同じ）
- **箇所**:
  - `testsuites/unit/10_runtime_state_persistence.test.mjs:1180-1196`（`buildWorld()` の機体が `isHoldDown: false`・`isIgnited: true`・`isPayloadSeparated: false`・`isStage2Separated: false`・`rcsCcw: false`。主スレッドの `Rocket` の既定値と同じ）と `:1215-1220`・`:1281`（保存・読込の値を元の値と比べる）、`:704-712`（`PhysicsEngine.addObject` の転送も `isPayloadSeparated: false`・`isStage2Separated: false`）
  - integration 14・回帰 10 の保存は、いずれも燃焼中（ペイロード分離前）か保存後すぐの比較で、ペイロード分離後と射点（ホールドダウン中）の保存がない
- **現象**: 次の変異は、`npm test` と同じ非 system の全 1,078 件をすべて通過した（`survivors/results.json`）。
  | 変異 | 箇所 |
  |---|---|
  | `PhysicsEngine.addObject` が `isPayloadSeparated` を `CalcRocket` に渡さない | `gravsim_calc.js:82` |
  | `ObjectManager.getState` が `isPayloadSeparated` を常に `false` で保存する | `gravsim_object_manager.js:494` |
  | `ObjectManager.loadState` が `isHoldDown` を読まない | `gravsim_object_manager.js:563` |
  補助エージェントの実行では、`isIgnited`・`isStage2Separated`・`rcsCcw` の同種の変異も unit E の 3 ファイルを通過した。
- **影響**: ペイロード分離後に保存したセーブは、分離前の機体として読み込まれ得る（復元手順 §3.5-1 は、`isPayloadSeparated` が偽なら現在の段からエンジン諸元を作る）。射点で保存したセーブは、解放済みの機体として読み込まれ得る。これらの退行をテストで検出できない。§3.5-1 の表を「項目名があること」だけで確かめ、値は既定値でしか確かめていない。
- **原因**: 往復の比較の期待値を、元の機体の値（= 既定値）にしている。既定値と異なる値で試していない。
- **修正方針**: すべての真偽値を既定値と逆にした 2 つ目の機体（ホールドダウン中・未点火・ペイロード分離済み・2 段分離済み・`rcsCcw: true` など）を加え、まず各値が `new Rocket()` の既定値と異なることを確かめてから、`getState`・`loadState`・`_buildRocketPayload`・`PhysicsEngine.addObject` の往復を比べる。結合テストに、ペイロード分離後と射点での保存・読込を加える（G3-1-01 と合わせる）。横展開として、他の項目（数値・文字列）でも既定値と同じ値で比べている箇所がないかを確かめること。
- **分類**: 【実装】。テストの追加が必要。

#### G3-1-03 [Major]【実装】 フライトプランで設計書が定めた契約のうち 4 つを、どのテストも検出しない。2 つの期待値は設計書ではなく現在の出力から取っている
- **箇所と現象**（次の変異は、いずれも非 system の全 1,078 件を通過した。`survivors/results.json`）:
  1. **1 ステップに積まれた複数のアクションの実行**: `gravsim_calc_object.js:1294-1297` で最初の 1 件だけを実行する変異。設計書 §3.4-1 は `for (const act of this.flightComputer.consumePendingActions()) this.executeProfileAction(act);` と定める。`FlightComputer` が複数を返すこと（`unit/09:461, 555`）は確かめているが、`CalcRocket` が全件を実行することは確かめていない。変異では 2 件目以降が消費されたまま失われる。
  2. **`vel` 行の補間**: `gravsim_flight_computer.js:243` で `vel` 行の補間値を 0 にする変異。設計書 §3.4-1 は「トリガ判定および補間用 `currentVal` の**両方**に `time`, `alt`, `vel`, `apogee` を実装」、§4.5 は「`_isStepTriggered` とプロファイル補間は `getTriggerValue` を使う」と定める。補間のテストは `alt` だけ（`unit/09:2006-2023`）。
  3. **`ORBIT_ASSIST` の目標半径の平均項**: `gravsim_flight_computer.js:620` で `r_tgt` を遠地点だけから求める変異。クランプされない検査はすべて遠地点 = 近地点（400/400 km）で、比 600/400 の検査は +14 にクランプされる。
  4. **燃料種の変更時のスライダ同期**（§3.4-4 の 3 箇所の 1 つ、§4.6）: `gravsim_tab_rocket.js:230` の `_syncThrustSlider` を除く変異。テスト（`unit/09:1803-1854`、`regressions/09:258-284`）は `max` だけを確かめるが、この処理では推力の引き上げが `max(10000, ceil(thrust))` で抑えられるため、`max` は変わらない。変わるのはスライダの値と表示で、これを確かめていない。
  5. 現在の出力を期待値にしている（テスト計画 §1 の 1 に反する）: `unit/09:1472-1494` の高度の倍率 1.08/0.85/0.62/0.58 と TWR 6 のしきい値（設計書にない）、`regressions/09:258` の `['solar_escape', 17107]`（G2-05 の回帰で、燃料種の変更前の推力と比べればよいところを、サイジング結果の現在の推力を直書きしている）。後者は、補助エージェントの変異のうち 2 件（コアの TWR 1.15、二分探索の 28 反復）を検出する唯一のテストで、設計の契約ではなく値の固定で守っている。
- **影響**: 複数のアクションを同じ条件で並べたフライトプラン（例: 同じ時刻の `sep_stage1` と `sep_payload`）、`vel` 行どうしの補間、楕円の目標軌道での誘導、燃料種の変更後の推力表示が壊れても、テストは通る。
- **原因**: `FlightComputer` 単体の検査で済ませ、`CalcRocket` との接続（1）を確かめていない。補間の検査を `alt` で代表させた（2）。目標値を対称な値に固定した（3）。`max` の同期だけを観点にした（4）。
- **修正方針**: (1) 同じトリガ値の `sep_stage1` と `sep_payload`（3 段機では `sep_stage1` と `sep_stage2`）を 1 回の `flightControl` で処理し、段番号・`isPayloadSeparated`・デブリの種類を確かめる。(2) 連続する 2 つの `vel` 行の中間の速さ（`vV ≠ 0`）でスロットルと角度を確かめる（`apogee` も unit D に加える）。(3) 例えば 420/380 km の目標で、クランプされない状態の `γ` を式と比べる。(4) 引き上げが起きる場合に、スライダの値と表示が新しい推力になることを確かめる。(5) 設計書の式から導ける契約（下限・上限・単調性）に置き換えるか、値を設計書に書いて出典にする。
- **分類**: 【実装】。テストの追加・修正が必要。

#### G3-1-04 [Minor]【実装】 テスト計画 §4.5 の「確かめられなかった」理由のうち 3 件が誤りで、境界値のテストが欠けている（設計書 §3.3 の注記も誤り）
- **箇所**: テスト計画 §4.5（V∞・180 K・TWR 下限の 3 行）、設計書 §3.3 L169（Rev 6.10 の注記）、`unit/09:1229-1230`（V∞ は目標 ×(1 ± 1e-6) だけ）、`unit/08:1366-1374`（気温はスケールハイト 1〜1e7 m の総当たりだけ）、`unit/09:1396-1414`（サイジングは「元の推力以上・上限以下」だけ）
- **現象**: 上記「テスト計画 §4.5 の理由の検証」のとおり、V∞ の一致、180 K の下限、TWR 1.25 の下限は、いずれも作って確かめられる。補助エージェントの変異では、V∞ の `>=` を `>` にする変異と 180 K のクランプを外す変異が全スイートを通過した。TWR の下限を 1.25 から 1.0 にする変異（本監査で全スイートに対して実行）は、回帰 08 の予測の数値（`falcon9` の `solar_escape` の点数・描画角など）でだけ検出され、サイジングのテストは検出しない。設計書 §3.3 の注記は「下限 180 K のクランプは実際には効かない」「スケールハイトが約 3e-307 m 未満では気温は NaN、音速とマッハ数は 0」とするが、実際には 0 < 高度 ≤ 対流圏界面で 180 K・音速 268.95 m/s になり、NaN になるのは高度 0 以下だけである。
- **影響**: 境界の「一致」（§3.3 の 3 観点）が欠け、TWR の下限（機体が離昇できることの保証）は予測の黄金値に依存して間接的にしか守られていない。
- **原因**: 理由を実測で確かめずに書いた。
- **修正方針**: V∞ の一致（`STG_MECO`）と 1 ulp 上（`STG_BURNING`）、180 K の下限（極小のスケールハイト）と NaN の場合（高度 0）、サイジング後の離昇 TWR ≥ min(上限で決まる値, 1.25)・SRB 分離後のコア TWR ≥ 1.15（上限で決まらない場合）を加える。設計書 §3.3 の注記とテスト計画 §4.5 を実測に合わせて直す。
- **分類**: 【実装】。テストの追加が必要（設計書とテスト計画の訂正を伴う）。

#### G3-1-05 [Minor]【実装】 RCS・ベイパーコーンで、Rev 6.10 で追記した記述と一部の配線を確かめていない。件数を確かめないループがある
- **箇所と現象**:
  1. `L = Math.max(1, layout.xMax - layout.xMin)`（設計書 §3.2 L145・§3.3 L186、Rev 6.10）: テストの期待値の式が `const L = layout.xMax - layout.xMin;`（`unit/08:218, 1220`、`integration/12:73, 150`）で、下限を含まない。下限を外す変異が通過する（補助エージェント）。設計書の理由「退化した配置での 0 除算・負の長さを防ぐ」も誤りで、`L` は除数に使われない。0 < L < 1 ではむしろ噴流とコーンが機体の外に描かれる（出荷する設定では最小でも L = 3.08 px なので起きない）。
  2. LOD しきい値の既定値 10（`gravsim_rocket_renderer.js:145, 177`、Rev 6.10）: テストは設定値 4.0 だけを使う（`unit/08:437-438, 1171, 1195`）。
  3. `unit/08:1141-1150` の 2 つの `for (const p of extractPlumes(...))` は件数を確かめないため、描画が 0 件でも通る（細い機体で描画を省く変異が通過）。
  4. テレメトリだけにあるフラグの扱い（`unit/08:1165-1169`）は `rcsCw` だけで、`rcsCcw`・`rcsUllage` を外す変異が通過する。
  5. フェアリング・ブースタ・ペイロード分離での整定タイマーの設定（`gravsim_calc_object.js:716, 767, 880`）と、`flightControl` が `_updateRcsState` に渡す推力（`:1467`）を確かめていない。`integration/12:569-590` の毎ステップの判定は、タイマーなどの入力を本体の値から取るため、入力の誤りを検出できない（補助エージェントの変異 4 件が通過）。
- **影響**: Rev 6.10 で設計書に書いた挙動と、分離時の RCS の作動条件の退行を検出できない。描画が消える退行をループの検査が見逃す。
- **修正方針**: 期待値の式に `Math.max(1, …)` を入れ、L = 0.5 と負の配置を加える（設計書の理由も直す）。`LOD_RADIUS_THRESHOLD` のない設定で 10 と 10 − 1e-9 を確かめる。ループの前に件数を確かめる。3 つのフラグすべてで確かめる。各分離の直後に `_postSepRcsTimer === RCS_CONFIG.POST_SEP_SETTLE_S` を確かめ、コースト中の `flightControl` で推力 0 として扱われることを確かめる。設計書 §3.2-2 の「分離時」がフェアリング・ブースタ・ペイロードを含むことを明記する。
- **分類**: 【実装】。テストの追加・修正が必要。

#### G3-1-06 [Minor]【実装】 自転角・バッファで、デブリの解析側の消去と `_moveObjects` 内の呼び出し順を直接確かめていない。一部の期待値が設計書の式にない段から来ている
- **箇所と現象**:
  1. `gravsim_worker_bridge.js:262`（デブリのレコードで `_cache.rotationAngle = 0`）を除く変異が、非 system の全 1,078 件を通過した（`survivors/results.json`）。`unit/06:361-373` の順序は天体 → ロケット → デブリで、デブリの直前は常にロケット（ロケットの分岐が値を消す）。天体の直後のデブリを解析する検査がない。§3.1.1-1「前の値が残らない」の解析側が守られていない。
  2. 設計書 §3.1.1-2 は、ホールドダウンの同期を `_updatePositionAndHalfVelocity(dt)` の**直後**に呼ぶと定める。同期を位置の更新の前に置く変異（変更前の位相ずれの順序）は unit 06 の 127 件を通過し、integration 11 で機体が破壊されて `TypeError` になることでだけ失敗する（補助エージェント）。要求を表すアサーションがない。
  3. `unit/06:708-709, 885-896` は、天体に周期がないときにプリセット（名前）から周期を取る段を期待値にしている。設計書 §3.1.1-2 の式（`rotPeriod = obj.param?.ROTATION_PERIOD ?? obj.rotationPeriod ?? 0`）はこの段を含まないので、期待値が実装から来ている（アプリの経路では `addObject` が必ず `rotationPeriod` を設定するため、この段には到達しない）。
- **修正方針**: (1) 天体（`rotationAngle: 1.2`）の直後にデブリを置いて、デブリの `rotationAngle === 0` と `updateObjectParams` 後の主スレッドのデブリの値を確かめる。(2) `flightControl` を監視して、その時点の位置・速度が `host + r(cos, sin)(θ0 + ω dt)` であることを確かめる。(3) 設計書の式にプリセットの段を加える（G3-1-09）か、実装から段を除く。
- **分類**: 【実装】。テストの追加が必要。

#### G3-1-07 [Minor]【実装】 非同期のプロトコルのテストにタイムアウトがなく、退行するとテストが失敗せずに止まる
- **箇所**: `unit/10_runtime_state_persistence.test.mjs:826-875`（`mock.timers` 下で `await p`）、`integration/14_save_load_runtime.test.mjs:441-453`。`testsuites/run_all.mjs` は `--test-timeout` を渡さない（Node のテストランナーの既定は無制限）
- **現象**: コピー上で `requestRuntimeSnapshot` の既定のタイムアウトを 2,000 ms から 3,000 ms に変えると、unit 10 は失敗せずに止まり、外側の 150 s のタイムアウトで打ち切った（`hang/hang.log`、終了コード 124）。`npm test` では無期限に止まる。補助エージェントの実行でも、`destroy()` が保留中の要求を解決しない変異で同じく止まった。
- **影響**: §4.7 のタイムアウト・破棄の契約が壊れると、CI などで失敗として報告されず、ジョブが止まる。
- **修正方針**: 該当するテストに `{ timeout: 5000 }` などを付けるか、`run_all.mjs` に `--test-timeout` を加える（E2E は既に `describe` に 240,000 ms を付けている）。
- **分類**: 【実装】。テストの変更が必要。

#### G3-1-08 [Minor]【実装】 `perf/rollout_timing.mjs` の「統計量自体の変動」が §4.12 の定義と異なり、変動を小さく見積もり得る
- **箇所**: `testsuites/perf/rollout_timing.mjs:185-187`（`stats = [全回, 前半, 後半]`、`variation = max(|各統計量 − 全回の統計量|)`）、設計書 §4.12 L458（「全回を部分集合（例: 前半の回と後半の回）に分けて同じ統計量を計算したときの差の最大」）
- **現象**: スクリプトは各部分集合の統計量と全回の統計量との差の最大をとる。§4.12 の定義（部分集合どうしの差）では |前半 − 後半| になり、全回の値が前半と後半の間にあると、スクリプトの値はその半分程度まで小さくなる。独立監査2 Iteration 9 の記録も、部分集合と全回の値の範囲（例: SE 1.29〜1.35）を変動としていた。
- **影響**: 余裕の判定（`margin > variation`）が §4.12 より甘くなり得る。
- **修正方針**: 部分集合（と全回）の統計量の最大と最小の差を変動とする。あるいは §4.12 の定義を、スクリプトの定義に合わせて明確にする（どちらでも、計測結果の記録にどちらを使ったかを書く）。
- **分類**: 【実装】。スクリプトの変更が必要（迷う場合は【実装】、§4 の 5 の 2）。

#### G3-1-09 [Minor]【文書】 設計書・テスト計画の記述に、Rev 6.10 の変更の横展開漏れと誤記がある
- **箇所と現象**:
  1. 設計書 §4.3 L342（終了理由の表 `point_budget`）が `maxPoints = min(MAX_POINTS, options.maxPoints || MAX_POINTS)` のまま。Rev 6.10 の規則（§4.12 L442: `Number()` が正のときだけ使う）と合わない（例: `maxPoints: -5` で表は −5、実装は 3,000）。また、§4.3 L334「点数予算が尽きた場合は…`MAX_POINTS` で打ち切る」は、G2-9-01 が箇所に挙げた記述（当時 L330）で、変わっていない（`options.maxPoints` を渡すとその値で打ち切る）。
  2. 設計書 §4 の見出し L319「補遺 Rev 6.1〜6.9」。Rev 6.10 は §4.7・§4.12 も変えている。
  3. 設計書 §3.1.1-2 L65 の自転周期の式にプリセット（名前）の段がない（G3-1-06 の 3）。
  4. テスト計画の冒頭 L3 の対象が「Rev 6.9」（テストは Rev 6.10 の記述を期待値にしている）。§2 の F の行の `system/01_app_e2e.test.mjs` は存在しない（実際は `01_app_boot_and_prediction.test.mjs` など。§4.1 は正しい）。§4.4 の「実飛行（16 構成）」は 15 構成（`s2_flights.mjs` の出力は 15 機と合計の行）。
- **修正方針**: 1 は表を「`maxPoints = min(MAX_POINTS, Number(options.maxPoints) > 0 ? Number(options.maxPoints) : MAX_POINTS)`（§4.12）」とし、L334 を「点数予算（`maxPoints`）が尽きた場合は…打ち切る」に直す。2〜4 は記述を直す。§3.3 の気温の注記・§3.2 の `L` の理由・§4.7 の継続の精度は、それぞれ G3-1-04・G3-1-05・G3-1-01 で直す。
- **分類**: 【文書】。設計書とテスト計画の記述を直すだけで、実装・テストの変更は要らない。直しても要求は満たされる。

---

### 2. 前ゲートの文書指摘の解消確認

独立監査2 Iteration 9（PASS（文書指摘あり））の文書指摘 G2-9-01・G2-9-02 を、設計書 Rev 6.9・6.10 と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G2-9-01 (1) 保証 4 (b) の最大角度ステップの範囲 | ✓ 解消 | L352 は「構成ごとの描画上の最大角度ステップの最大値: `BINARY_SYSTEM` 0.135 rad、`THREE_BODY` 0.140 rad。保証 1 に必要なのは最大値なので下限は書かない」になった。回帰 08 は THREE_BODY の Mars 36 ヶ月・方位 225° の 0.140 rad（103 日目、終端でない）を確かめ、通過する |
| G2-9-01 (2) 終了理由の表・`MAX_POINTS` の記述 | △ 一部未解消（G3-1-09 の 1） | Rev 6.9 で表の `point_budget` に `options.maxPoints` を、`step_budget` に `options.maxSteps` と §4.12 の参照を加えた。しかし、同じ指摘が箇所に挙げた「`MAX_POINTS` で打ち切る」（現 L334）は変わっていない。また、Rev 6.10 で予算オプションの規則を変えたとき、表の式を直していない |
| G2-9-02 §4.12 の実測・根拠・計測方法 | ✓ 解消 | L445 に 0.2 ヶ月の main の実効予算 105,192 ステップ・比 1.14・最大比の構成（0.2 ヶ月の ISS・GTO・月遷移）。L454-458 に計測する構成（124 構成 × 5 ワールド）・回数と順序・負荷・統計量・余裕と比べる変動の定義。L459-475 の実測表は独立監査2 Iteration 9 の表と全セルが一致（機械的に比較）。最大比 1.294・余裕 0.206・深宇宙 0.24〜0.35／0.80〜1.01 も記録どおり。L3 の Rev 6.8 の日時は 03:11 に訂正し、理由を付記した。なお、変動の定義の解釈とスクリプトの実装が合わない点は G3-1-08 |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 期待値が既定値と同じで、往復の比較が空振りする（G3-1-02） | unit 10 の `buildWorld()` と `addObject` の転送の 2 箇所。unit 06 のプール再利用の検査は番兵値で埋めたバッファを使い、integration 11・12 は非既定値で同期を確かめている（空振りしない）。unit 10 の CELESTIAL・DEBRIS の項目は非既定値 | **要**（G3-1-02） |
| 件数を確かめないループ・条件付きのアサーション | `unit/08:1141, 1147`（G3-1-05）。他の `if (…) assert` は、`regressions/08` の終了理由ごとの検査（直後に終了理由の件数を `deepEqual` で確かめる）、`unit/07:540, 545`（同じ条件の件数を別に確かめる）、`integration/13:280` などで、空振りしない。`assert.ok(true)`・`skip`・`todo`・`only` は新規 19 ファイルに 0 件 | **要**（G3-1-05） |
| 設計書ではなく現在の出力や実装を期待値にする | `unit/09:1472-1494`・`regressions/09:258`（G3-1-03 の 5）、`unit/06:708-709, 885-896`（G3-1-06 の 3）、`integration/12:569-590` の入力（G3-1-05 の 5）。単位 B は閉じた形の運動と設計書の表から期待値を作っており、該当なし | **要** |
| Rev 6.10 で設計書に追記した記述のテスト | 本体の修正 5 件（`_getRotationOmega`、最終速度の省略、コンストラクタの目標値、行の除去、予算オプション）はすべてテストがあり、戻すと検出される。記述の訂正のうち、`L` の下限・LOD 既定値・180 K の注記（G3-1-04・05）と継続の精度（G3-1-01）が未検証または誤り。`updateObject` の自転角・スロット 48・`ORBIT_ASSIST` の `!disableOrbitalCutoff`・トリガの表示名・保存項目の表・RCS タイマーはテストがあり、記述も実装と一致 | **要**（G3-1-01・04・05） |
| テスト計画 §4.5 の理由 | 8 件中 3 件が誤り（G3-1-04）、5 件は妥当 | **要**（G3-1-04） |
| タイムアウトのない非同期テスト | unit 10・integration 14（G3-1-07）。E2E は `describe` に 240,000 ms、待機ごとに上限を持つ。unit 07b は同期的に Worker のハンドラを呼ぶ | **要**（G3-1-07） |
| 自転角速度の算出の重複（`_getRotationOmega` の横展開） | `gravsim_calc_object.js:165`（大気の共回転）、`gravsim_flight_computer.js:377`（地表相対速度）、`gravsim_calc_predictor.js:290-291`（`hostOmega`）、`gravsim_trajectory_predictor.js:109`、`gravsim_rocket_launcher.js:310`（配置時の速度）は、`param.ROTATION_PERIOD` が真のときに `2π/P` とし、有限性・`|P| > 1e-6` を確かめない（予測器だけ `rotationPeriod` の段を持つ）。プリセットの周期はすべて 35,730 s 以上の正の数で、主スレッドは `rotationPeriod` を送らないので、アプリの経路では一致する。手で編集したセーブ（`ObjectManager.loadState` は `param` をそのまま写す）では食い違い得る。設計書が単一源を求めているのは `PhysicsEngine` の 2 箇所だけ | 任意（Watchpoint 4） |
| フライトプランの行の検証（Rev 6.10 の横展開） | 除去の入口は 3 箇所で、行を参照するのは除去済みの配列だけ（上記）。ただし、除去はオブジェクトかどうかだけで、`thrust`・`angle` のない行（`{ type: 'time', value: 0 }`）はスロットル NaN になり、その機体は燃焼しない（補助エージェント）。設計書の記述（オブジェクトでない行の除去）の範囲内 | 任意（Watchpoint 5） |
| 本体の変更の回帰 | アプリの経路の同期予測（5 ワールド × 7 構成）と実飛行（15 機）は変更前後で完全に一致（上記）。単位 B の突然変異 22 件、補助エージェントの A・C・D・E の 308 件（Rev 6.10 の修正の戻し 12 件を含む）のうち、全スイートで生き残ったものは指摘に挙げた | 不要（指摘以外） |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-1-01 を直したあとの確認**: 推力の状態を復元する変更は、通常の飛行（保存・読込を挟まない）には影響しないはずなので、`perf/d2.mjs` と `gate2_it2/s2_flights.mjs` の一致を再確認すること。継続のテストは `falcon9` を含む全機体と、燃焼中・段間・ペイロード分離後・射点の保存で行い、`probeE/zz_probe.test.mjs` の表（`falcon9` の燃焼中で近地点 1.2〜2.7%）が数値誤差の程度に下がることを確かめること。タンク圧の模擬（`_wasFiring`）は読込の 1 フレーム後の状態でも比べること。
2. **全スイートでの突然変異**: 単位ごとのファイルだけで変異を試すと、別のファイル（特に回帰 08 の予測の黄金値）で偶然検出されるものと、本当に守られていないものを区別できない。工程 3 の再作業では、追加したテストが狙った変異を、そのテスト自身で検出することを確かめること（例: TWR の下限は回帰 08 でだけ検出される）。
3. **実行時間**: 回帰 08 は単独で 55.0 s、`npm test` の並列実行では 69.7 s（計画の目安 1 ファイル 60 秒）。`npm test` 全体は 70.3 s、カバレッジ付きは 152.9 s。テストを加えるときは回帰 08 の構成を増やさないこと。
4. **自転角速度の算出の重複**（横展開確認の表）: 単一源にまとめるか、セーブの読込で `param` を検証すること。設計書の範囲外なので、扱いを工程 4 で決めること。
5. **フライトプランの行の検証の範囲**: 数値の項目が欠けた行は、例外にはならないがスロットル NaN になる。セーブの破損への対策としてどこまで検証するかを設計書に書くこと。
6. **カバレッジの再現性**: 本監査の分岐カバレッジは 91.82% で、作業者の申告（91.85%）と 0.03 ポイント違う（行・関数は一致）。乱数（タンク圧のノイズ、デブリの ID）や並列実行の順序で通る分岐が変わり得る。工程 4 で記録するときは、計測条件を書くこと。ファイル単位では `gravsim_trail_renderer.js` の行 88.21%（90% 未満）、`gravsim_rocket_launcher.js` の分岐 79.72%、`gravsim_preset_manager.js` の分岐 80.22% が低い。
7. **E2E の環境**: 本監査中、同じホストで別のプロジェクトのヘッドレス Chromium（`/tmp/kogai-ui-*` のプロファイル）が並行して動いていた。`cdp_helpers.mjs` の後片付けは自分のプロセスグループと `--user-data-dir` だけを対象にし、それらには触れなかった（終了後の一覧で確認）。残留の確認には、GravSim のプロファイル名（`gravsim-e2e-`）で絞ること。
8. **範囲外とした既存の不具合**（テスト計画 §4.6）: 時間倍率とズームが読込で戻らない（`ControlPanel` の入れ子）、ペイロード分離後の主スレッドの質量表示などは、要件 5（「保存復元全項目」）と関わる。範囲外とする判断を設計書に記録するか、工程 4 で扱いを決めること（現在はテスト計画にだけある）。
9. **`testsuites/README.md` の既存の記述**: §1 の「全36テスト」「全18テスト」、§4 の「全182テスト」、§5 のカバレッジの表（96.43% など）は main からの古い値で、§2-D・§3 の 1,102 件と合わない。工程 4 で更新すること。
10. **引き続き有効な Watchpoint**: 独立監査2 Iteration 9 の WP1（ビット同一性は実測による）、WP2（予測結果の ID は実行順に依存。回帰 08 は ID を比べていない）、WP4（同期ブロック時間の計測）、WP5〜WP8。lint 警告 54 件（既存の testsuites）も残る。

---

## 独立監査3: テスト設計・実装監査 — Iteration 2

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 2
- **実施日時**: 2026-11-22 01:06〜09:20 JST（01:14 以降、WSL の再起動で中断し、08:10 に再開した。中断の前に機械的チェックと Iteration 1 の変異の再実行は完了していた。再開時に作業ツリーが監査開始時の md5 と一致することを確かめてから続けた）
- **判定**: **FAIL**（【実装】Major 1 件・Minor 3 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §3.3・§3.4・§4、設計書 Rev 6.13（Rev 6.11 = Iteration 1 の指摘の反映、Rev 6.12 = §4.13 の 1〜32、Rev 6.13 = §4.14 の 1〜10）、テスト計画、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（このブランチは見直しの入力に挙げた作業で区切り、main でも起きる不具合は見直しの入力 §3 に記録して別ブランチで直す。本ブランチの退行はここで直す）は利用者の判断として扱い、その適用が正しいかを確かめた。

- **差分の特定**: Iteration 1 が監査したツリー（`scratchpad/gate3_fix/base_tree`。`gate3_it1/md5_start.txt` の全件と一致することを確認）と現行ツリーを `diff -r` で比べた（`gate3_it2/diffs/`）。変わったのは、本体 27 ファイル（`gravsim_calc.js`・`gravsim_calc_object.js`・`gravsim_calc_predictor.js`・`gravsim_flight_computer.js`・`gravsim_object*.js`・`gravsim_universe.js`・`gravsim_worker_bridge.js`・UI タブ・描画・音など）、`index.html`、`presets/visuals/rocket.json`、設計書・テスト計画・見直しの入力（新規）、`testsuites/README.md`・`run_all.mjs`・`perf/rollout_timing.mjs`、既存テスト 7 ファイル（integration 05/07/08/09、regressions 06、unit 03/05）、Iteration 1 のテスト 16 ファイルの変更、新規テスト 14 ファイル（regressions 11〜19、`08_trajectory_guarantees_helpers.mjs`・`08a`〜`08c`（旧 08 の分割）、system 05）。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate3_it2/md5_start.txt`、484 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,461 行は追記前（`review_before_append.md`、md5 `e52babbf…`）と同一。
- **突然変異の方法**: すべて `gate3_it2/pristine`（作業ツリーの完全なコピー）からの使い捨てのコピー上で、1 箇所ずつ文字列置換（一致数を検査）で不具合を入れ、**その変更の対象として計画・設計書が挙げるテストファイルだけ**を実行した（`gate3_it2/mutrun.mjs`）。生き残ったものは、`npm test` と同じ非 system の全 1,492 件でも実行した。Iteration 1 の変異の再実行が 35 件＋タイムアウト 4 件（`it1/`）、本ラウンドの変更（§4.13・§4.14・Rev 6.11）に対する変異が 95 件（`mutN/`）。
- **補助エージェント**: 独立の補助エージェント 2 体を起動した。agent_T は新規・変更したテストの設計を読み（緩いアサーション、期待値の出典、走査の許可リスト）、agent_B は見直しの入力 §3 の「main」の列の突合と、どちらにも載っていない本ブランチの退行の探索を行った。結論は、本監査が自分で再実行・再現できたものだけを使った（再現の出力は `gate3_it2/repro/`）。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it2/`）: `progress.log`（経過。中断と再開を含む）、`run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 3 回・カバレッジ）、`ident/`（中断しない経路の一致）、`it1/`（Iteration 1 の変異）、`mutN/`（本ラウンドの変異）、`cont/`（保存・読込の継続の独立の確認）、`timing/`（ファイルごとの単独実行の時間と件数）、`repro/`（指摘と見直しの入力の再現）、`probe_d8/`（等価な変異の確認）、`agent_T/`・`agent_B/`（補助エージェント）。`stale_20261121/` は 2026-11-21 の中断した旧い試行の残りで、本監査の根拠には使っていない。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0。Lint はエラー 0／警告 54（全件が既存の 16 テストファイル。本ラウンドで変更した既存のテスト 6 ファイルも変更前と同じ件数で、新規のファイルは 0 件）。型は TypeScript 7.0.2 で 44 ファイルを検査しエラー 0 |
| 全テスト | `npm test` | **1,533/1,533 pass**・fail 0・cancelled 0・skipped 0・todo 0（262 スイート）、66.2 s（load average 1.26 → 10.03、16 コア） |
| E2E 1〜3 回目 | `npm run test:system` × 3 | 3 回とも **41/41 pass**・skipped 0・cancelled 0（49.5 s・50.9 s・55.5 s）。`npm test` の中の 1 回と合わせて 4 回、失敗なし。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0。system/03 の大気上限の境界（H1-14）のほかに不安定なテストは見つからなかった |
| カバレッジ | `npm run test:coverage` | 1,533 pass、156.8 s。**行 99.35%・分岐 92.97%・関数 97.32%**（README は分岐 92.96%。ファイル単位では `gravsim_tab_rocket.js` の分岐 88.19%（README 87.99%）など、乱数と並列実行の順序による 0.01〜0.2 ポイントの揺れ） |
| ファイルごとの単独実行 | `node --test <file>`（全 51 ファイルを順に、負荷なし） | 全ファイル成功。件数は regressions 404・unit 836・integration 252・system 41（計 1,533。README・テスト計画 §4.1 と一致）。最長は system/02 44.5 s、system/04 43.9 s、regressions/08c 26.1 s、08b 20.7 s、unit/07 14.4 s、integration/14 14.6 s で、すべて 60 s の目安以内 |
| 中断しない経路の一致 | `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）、`gate2_it2/s2_flights.mjs`（cwd = リポジトリ、`GS_ROOT` = 各ツリー） | Iteration 1 のツリーと現行ツリーで**完全に一致**: d2 `2e22aefa3a20913ea507399278276b26`、s2 `91c5b9816a026dec4be5e3648cfd4948`（両ツリーとも期待値と同じ。s2 は 15 機、衝突 0・不一致 0） |
| Iteration 1 の変異の再実行 | `it1/`（35 件、対象ファイルのみ） | 34 件を対象のファイルだけで検出。残る 1 件（D8: `maxPostSrbMassT` の 1.15 → 1.0。本監査で追加）は全スイートでも生き残るが、出荷する 6 機体 × 7 ミッション × 7 ペイロード（なしを含む）の 294 通りでサイジングの出力が変異前とバイト単位で同じで、プリセットからは到達しない（`probe_d8/`） |
| 本ラウンドの変異 | `mutN/`（95 件、対象ファイルのみ） | 90 件を対象のファイルだけで検出。W16（§4.14-7 の最終速度）は unit/06、W35（天体の質量の復元）は unit/10 で検出（いずれも計画が同じ項目の担当に挙げるファイル）。U13（カメラの対象を参照でなく id で比べる）は等価（読込の後の旧オブジェクトは必ず `REMOVED` で、続く `isLiveObject` の検査で同じ結果になる）。**U43・U48 は全スイートでも生き残る**（G3-2-04） |

**Iteration 1 の指摘の解消確認**（【実装】G3-1-01〜G3-1-08）:

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-1-01 継続の精度 | ✓ 解消 | `runtimeState` に推力比・`wasFiring`・推進系・射点角・運動学（位置・速度・加速度・空力キャッシュ）・FC の姿勢指令などが加わり、天体・デブリにも実行時状態を出す（`gravsim_calc_object.js:225-276, 289-305, 520-537, 590-612, 1755-1768`、`gravsim_calc.js:50-163`）。integration 14 は 6 機体すべての 13 通り（射点の加圧後・点火後、燃焼中、段間、フェアリング、SRB 分離、ペイロード分離、軌道投入）で Worker の全項目を `Object.is` で比べる。復元の各項目を消す変異 W27〜W35 は、担当として挙げた integration 14 または unit 10 の単独実行で検出（W35（天体の質量）だけは integration 14 を通過し、unit 10 で検出）。**独立の確認**: integration 14 と別のハーネス（agent_B の `B3/harness.mjs`）、別の時間刻み（0.02 s × 25）・別の乱数の種で、6 機体の 10 通り（燃焼中、SRB 燃焼中、SRB 分離後、フェアリング分離後、3 段機の第 2 段、受動・自走ペイロードの分離後（MMX は噴射中）、射点で点火後のホールドダウン中）を、保存した JSON を別プロセスで読み込んで 60 s 続け、毎フレームの全オブジェクトの全項目を倍精度のビットで比べた（`cont/`）。違いは §4.7 が挙げる投棄物の名前・`hasPayloadPropulsion` の未設定と `false`・第 1 段分離後の `stages[0].dryMassT` と、射点の保存で解除前のフレームの `_half_vx`/`_half_vy`（G3-2-05 の 3）だけで、位置・速度・質量・状態はすべて一致した |
| G3-1-02 真偽値の往復 | ✓ 解消 | unit 10 に既定値と逆の値の機体を加え、`new Rocket()` の既定値と異なることを先に確かめてから往復を比べる。Iteration 1 の 3 件の変異は unit 10・integration 14・回帰 10 の**それぞれ単独**で検出（9/9）。同種の `isIgnited`・`isStage2Separated`・`rcsCcw` の保存・転送・読込を落とす 5 件も検出 |
| G3-1-03 フライトプランの契約 | ✓ 解消 | 複数アクションの実行（D2）、`vel` 行の補間（D4）、`r_tgt` の平均項（D5）、燃料種変更時のスライダの値と表示（D3）を unit D のファイルだけで検出。高度の倍率 0.62・0.58・1.08・0.85 と上段 TWR 6.0 は設計書 §3.4-3 に値が書かれ（Rev 6.11）、回帰 09 の G2-05 は「変更前の推力」と比べる形になった |
| G3-1-04 境界値の欠落 | ✓ 解消 | V∞ の一致（D6 `>=` → `>`）、180 K の下限（C1）、離昇 TWR 1.25（D1）、SRB 分離後のコア 1.15（D7）を対象のファイルだけで検出。設計書 §3.3 の注記とテスト計画 §4.5 は実測どおり（180 K は 0 < 高度 ≤ 対流圏界面で効く） |
| G3-1-05 RCS・ベイパーコーン | ✓ 解消 | `L` の下限（C2・C3）、LOD 既定値 10（C4）、テレメトリだけのフラグ 3 種（C5・C6）、4 種の分離の整定タイマー（C7〜C10）、RCS に渡す推力（C11）をすべて unit 08／integration 12 で検出。件数を確かめないループは `assertPlumesMatch` で件数ごと比べる形になった |
| G3-1-06 自転角・呼び出し順 | ✓ 解消 | デブリの自転角の消去（A1）と `_moveObjects` 内の順序（A2）を unit 06 だけで検出。設計書 §3.1.1-2 の式にプリセットの段が入った |
| G3-1-07 タイムアウト | ✓ 解消 | `run_all.mjs` が `--test-timeout=300000`（`GRAVSIM_TEST_TIMEOUT_MS` で変更可）を渡し、unit 10・integration 14 の非同期テストは個別に 5,000 ms などを持つ。`--test-timeout` なしで実行しても、`destroy()` が保留中の要求を解決しない変異は unit 10 で 5 s、integration 14 で 20 s に失敗として止まり、既定のタイムアウトを 3,000 ms にする変異は unit 10 が定数の検査で検出（integration 14 は明示のタイムアウトを使うため成功するが、止まらない） |
| G3-1-08 変動の定義 | ✓ 解消 | `rollout_timing.mjs:187-188` は全回・前半・後半の統計量の最大 − 最小とし、設計書 §4.12 L478 も同じ定義を明記した |

**本ラウンドの本体の変更の検証**（工程 2 の実装監査に準じて全行を読み、変異と再現で確かめた）:

1. **Worker のプロトコル（§4.13-31(b)）**: `remove`・`clear` に主スレッドの連番 `seq`、Worker は処理した最大値を毎フレーム `syncSeq` で返す（`gravsim_calc.js:943-1006, 1068`）。`ObjectManager.updateObjectParams` は `ackSeq < _clearSeq` のフレーム全体と、`removedSeq > ackSeq` の id のデータを捨て、一覧に残る除去済みの物体には何も書かない（`gravsim_object_manager.js:231-245, 338-341`）。Reset・読込は生きている物体を除去してから `clear` を送る（`:47-55`）。境界（`seq−1`・`seq`、`clear` の前後、`syncSeq` の欠落・`NaN`・文字列）を含めて回帰 18 が検出する（W07〜W14 の 8 件すべて）。`syncSeq` のないフレームを同期済みとみなす互換も正しい。スナップショットの応答には連番がない（Watchpoint 4）。
2. **世界の中心と `hostAutoSelected`（§4.13-27・-32）**: 空の一覧に最初に置いた天体を中心とし、消去・生成器・既定のホスト・カメラの代替が id 0 でなく中心を見る。旧形式の保存（フラグなし）は id 0 を中心とし、`hostAutoSelected` のない保存は中心のホストを自動とみなす（`gravsim_object_manager.js:732-738`、`gravsim_rocket_launcher.js:818-829`）。変異 U25〜U31 はすべて回帰 17・18 で検出。ただし、銀河中心を中心にしたことの副作用（G3-2-02）と、中心の判定が一覧に残る除去済みの物体を数える箇所（G3-2-03）がある。
3. **ホールドダウンの規則（§4.13-1・§4.14-7・§4.14-9）**: ホストとの衝突の除外は `isHoldDown` かつ `hostId` が一致する組だけ（`_isHeldOnHost`）、積分の除外はホストがあるときだけ（`_getHoldDownHost`）、保留中のアクションは `!isHoldDown && dt > 0` のときだけ実行（`gravsim_calc_object.js:1440-1449`）。いずれもアプリの通常の経路を変えないこと（d2・s2 の一致）と、変異 W01・W02・W15〜W18 の検出を確かめた。
4. **予測のイベントの規則（§4.14-1・-3・-8・-10）**: `payload_cutoff` は開始時に分離済みの燃焼の停止だけ、燃焼中の段の `sep_*` はカットオフを分離の前に記録、分離と同じステップの点火は PAYLOAD START、2-STG-SEP は段数 2 以上だけ（`gravsim_calc_predictor.js:500-604`）。主スレッドの印の規則（`gravsim_trajectory_predictor.js:390-470`）は予測の命名（`ses_k` = 段番号 k の点火、`reignition_N` = 段番号 N−1）と一致する。変異 W19〜W24・U38〜U42 をすべて回帰 19 で検出。ただし、同じ読み違いが音声のテレメトリに残っている（G3-2-01）。
5. **実時間の厳密な倍率（§4.13-20）**: コードが与えた指数を `_exactTimeScale` に保ち、スライダがその刻みを表示している間だけ使う（`gravsim_tab_system.js:378-401`）。`input`・`ui:set-time-scale-min` で解除、`saveTimeScale` は `getTimeScaleExp()` を保存する。変異 U14〜U16 を回帰 15 で検出。
6. **保存の後方互換**: 旧い `controlPanel` の直下の形式（U01）、予測期間のない保存、`isWorldCenter`・`hostAutoSelected` のない保存（U29）、Rev 6.10 以前の `runtimeState`（新しい項目はすべて省略可能、`restoreKinematicState` は 6 値が有限でなければ全体を無視）を確かめた。

**見直しの入力 §3 の「main」の列の突合**（再現の出力は `repro/backlog/`。agent_B の再現スクリプトを本監査が両ツリーで実行し直した）:

| ID | 文書の記載 | 結果 |
|---|---|---|
| H1-9 | なし（退行）→ 修正 | ✓ main は `sep_payload` を持たず行を無視する。本ブランチは PAYLOAD CUTOFF を記録しない（SECO-1・2-STG-SEP・PAYLOAD SEP が 500 s） |
| H1-6 | 悪化 → 修正 | ✓ main は GEO の `payload_cutoff` を 300.5 s・`payload_start` を 305.5 s（予測 612.6 s）、Epsilon の `ses_2` を 116 s（予測 252.8 s）で通過にする。本ブランチは実際の時刻（907.0 s・252.0 s・1,200.5 s）で通過 |
| H2-4・H4-4 | あり（本ブランチの部分は修正） | ✓ main は読込後に Worker の MET が 0.5 s に戻り、相対高度 0、num_1〜5 が鳴り直す。本ブランチは MET が続き（13.0 s）、鳴り直さない |
| H3-17 | 悪化 → 修正 | ✓ 252 通りで表せない値が本ブランチ 0、main 58（数え方は agent_B の「機体／段／項目＝値」。文書の 275／32 とは数え方が違う） |
| H3-18 | あり（`SystemTab.loadState` は削除） | ✓ main は `gravsim_tab_system.js:387` に定義し `gravsim_control_panel.js:96` から呼ぶ。本ブランチにはない |
| H4-3 | なし（退行）→ 修正 | ✓ main の描画も噴射を描かずに戻るが、main では自走ペイロードが噴射しないため見えない（h3_24・HTV-X・ISS で噴射 0 フレーム、両ツリー同じ）。修正は存在する |
| H1-1・H1-2・H1-5・H1-8・H2-1・H2-5・H3-3・H3-12・H4-1・H4-8・H4-20 | あり | ✓ 11 件とも両ツリーで同じ現象（H1-1 月の質量 7.34e22 kg の消失、H1-2 配置順で衝突を素通り、H1-5 再点火の 1 サブステップ後に推進剤 0、H1-8 Epsilon 28.94 m・SSTO 29.84 m、H2-1 連星・三体の後の太陽系で例外と一時停止、H2-5 破片が岩の形（main は種別も 0）、H3-3 射点で機体などを変更できる、H3-12 同数の読込で一覧が古い（main は中心の一覧も）、H4-1 ORBIT が点かない、H4-8 射点 5,000 m で演出が消え TWR-C が点く、H4-20 第 3 段の燃焼中に SECO が点く） |

退行・悪化とされた 6 行はすべて文書どおりで、修正は作業ツリーにある。一方、どちらにも載っていない本ブランチの退行が 2 件見つかった（G3-2-01・G3-2-02）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-2-01 [Major]【実装】 受動ペイロードの分離で「PAYLOAD ENGINE CUTOFF」、単段機で「2ND STAGE SEPARATION」の音声が鳴る（本ブランチの退行。§4.14-1・§4.14-10 の横展開漏れ）
- **箇所**: `scripts/gravsim_object_manager.js:444`（`isPayloadSep = Boolean(objData.isPayloadSeparated)`。Gate 1 の指摘で `tmPayloadSeparated` のタイポを直した）、`:449`（`isStage2Separated` を Worker の値から取る）、`:462`（`isPeco = isPayloadSep && !isFiring && (status === MECO || burnTime <= 0)`。推進系の有無を見ない）、`:496, 501`（テレメトリに書く）、`scripts/gravsim_calc_object.js:802`（ペイロード分離で `totalStages <= 2` なら `isStage2Separated` を立てる）、音声の規則 `scripts/gravsim_const.js:566, 568, 656, 658`（`isStage2Separated == true` → `fl_2-stage_sep`、`isPeco == true` → `fl_peco`）
- **現象**（`repro/B1_peco.out`・`B2_ssto.out`。実 Universe と in-process の `SimulationController`、LEGACY_QUICK、両ツリーで同じスクリプト）:
  - h3_30 ＋ ASNARO-2（`propulsion.enabled = false`）・LEO: 分離の 618.9 s に `telemetry.isPeco` が真になり、`fl_2-stage_sep` と同時に `fl_peco` が鳴る。ALOS-4（earth_obs）も 649.9 s に同じ。main は `isPeco` が一度も真にならず、`fl_peco` は鳴らない（他の音声は同じ）
  - SSTO（1 段）＋ ALOS-4・LEO: ペイロード分離の 285.3 s に `telemetry.isStage2Separated` が真になり、`fl_2-stage_sep`（と `fl_peco`）が鳴る。main は鳴らない（`curStg >= 2 || isPayloadSep` で、タイポのため偽）
- **影響**: 受動ペイロード（出荷する 6 種のうち ASNARO-2・ALOS-4）を載せた飛行では毎回、存在しないエンジンの停止がアナウンスされ、単段機では存在しない第 2 段の分離がアナウンスされる。§4.14-1（受動ペイロードの PAYLOAD CUTOFF）と §4.14-10（単段機の 2-STG-SEP）は同じ読み違いを予測でだけ直し、同じフラグを読む主スレッドのテレメトリと音声に残した。§4.14 にも見直しの入力 §3 にも記録がない。アナンシエーターの 2-SEP は `totalStages > 1` で守られており（`gravsim_telemetry_panel.js:720-736`）影響しない。
- **原因**: Gate 1 の指摘（タイポの修正、`isStage2Separated` の同期）でフラグが主スレッドに届くようになったが、そのフラグの意味（受動ペイロードは分離時に燃焼時間 0、単段機はペイロード分離で `isStage2Separated`）と消費者（音声の規則）を確かめなかった。§4.14 の修正で横展開の対象を予測に限った。
- **修正方針**: `isPeco` を、分離済みのペイロードが自分の推進系で燃焼した後の停止に限る（予測の §4.14-1 と同じ規則。例えば `hasPayloadPropulsion` と直前の燃焼）。テレメトリの第 2 段分離（または `fl_2-stage_sep` の規則）を段数 2 以上に限る（§4.14-10 と同じ規則。`isStage2Separated` のフラグそのものは復元・描画が使うので変えない）。受動ペイロード・単段機で鳴らないこと、自走ペイロード（HTV-X・MMX など）の PES・PECO と 2 段・3 段機の 2-STG-SEP は従来どおり鳴ることのテストを加え、設計書 §4.14 に記録する。同じフラグを読む他の主スレッドの箇所（`isSeco` を含む）も確かめること。
- **分類**: 【実装】。本体とテストの変更が必要。

#### G3-2-02 [Minor]【実装】 銀河中心を世界の中心にした変更（§4.13-32）の後、連星・三体の主星が Sgr A* の大きさのままになり、Clear Selected の後の太陽系の配置が例外で止まる（本ブランチの退行）
- **箇所**: `scripts/gravsim_const.js:1065`（`worldCenter: true`）、`scripts/gravsim_object_placer.js:335-341`（古い中心の除去）、`:461, 494-505`（連星の生成器は中心の名前・色・質量・位置だけを書き換えて主星にする）、`:572` と `:625-637`（三体も同じ）、`scripts/gravsim_universe.js:328`（消去は中心を残す）、`scripts/gravsim_object_placer.js:299`（"Sun" がないと例外。一時停止は `:325` で既に発行済み）
- **現象**（`repro/B3_gc_binary.out`・`B3_gc_threebody.out`・`B4_gc_clear_solar.out`。agent_B のスクリプトを両ツリーで実行）:
  1. Galactic Center の後に Binary Star System を配置すると、「Sun A」は Sgr A* のオブジェクトのまま（半径 1.270e10 m = 太陽の約 18 倍、枠線 `#FF4500`・0.1、`param` は Sagittarius A*。Worker も同じ半径と `param`）。Three-Body Problem の「Sun A (Trisolaris 1)」も同じ。新しいページでの配置と main では、どちらも半径 6.963e8 m・`param` Sun
  2. Galactic Center → System › Clear Selected（天体）→ Solar System: 残るのは Sgr A* だけで、"Sun object not found in the universe." の例外になり、一時停止のまま何も置かれない。main では id 0 の Sun が残り、20 天体が配置される
- **影響**: 銀河中心の後の連星・三体は、主星の大きさ・衝突半径・抗力・表示が誤った世界になる。2 は通常の UI の操作で例外と一時停止（見直しの入力 H2-1 と同じ例外の、本ブランチで新しく生じた経路）。§4.13-32 は「他のプロファイルの後で、同じ世界になる」ことを銀河中心の側でだけ確かめ、銀河中心の後の他のプロファイルを確かめていない。§4.14 にも見直しの入力 §3 にも記録がない（H2-10 は再利用した中心の軌跡の色だけ）。
- **原因**: §4.13-27 の「生成器は有効な中心を最初の星にする」は、中心が常に Sun の型であることを前提にしていたが、§4.13-32 で Sun でない中心ができた。
- **修正方針**: 生成器が中心を主星として再利用するときに型（半径・`param`・枠線）をテンプレートから設定し直すか、Sun の型でない中心は再利用せずに置き換える（§4.13-32 の逆向き）。Solar System など "Sun" を前提にする配置も、銀河中心の世界から正しく置けるようにする（少なくとも本ブランチで新しく生じた経路は直し、H2-1 の一時停止の対は見直しで扱う）。Galactic Center → Binary・Three-Body・Solar System、Galactic Center → Clear Selected → 各プロファイルのテストを加え、設計書 §4.13-27・-32 に規則を書く。
- **分類**: 【実装】。本体・テスト・設計書の変更が必要。

#### G3-2-03 [Minor]【実装】 世界の中心の判定が一覧に残る除去済みの物体を数える（§4.13-31 の種類）。回帰 18 の走査はこれと `find?.(` の形を見逃し、許可リストの理由の一部が実態と合わない
- **箇所**:
  - `scripts/gravsim_object_placer.js:211-212`（`const list = this.universe.objects; obj.isWorldCenter = Array.isArray(list) && list.length === 0;`）
  - `testsuites/regressions/17_preexisting_remaining_fixes.test.mjs:372-385`（除去した Sun が一覧に残っている間の連星の配置で「a removed center is no center」、続く消去で「全天体が消える」ことを期待値にしている）
  - `testsuites/regressions/18_removed_object_lifecycle.test.mjs:1176`（走査の `HIT`）、`:1204-1228`（`ALLOWED`）
- **現象**:
  1. 世界の中心（Sun）を除去した直後（一覧に残ってフェード中）に Binary Star System を配置すると、新しい主星は中心にならず（`getWorldCenter()` は `null`）、続く Clear Selected（天体）で 2 つの星が消える。同じ操作をフェードが終わった後に行うと、「Sun A」が中心になり、Clear Selected で残る（`repro/wc_fade.out`。フェードの終了は一覧からの除去で模した）。同じ操作の結果が数秒のフェードの有無で変わり、回帰 17 はフェード中の結果を期待値として固定している。
  2. 回帰 18 の走査の `HIT` は `objects.find(` 等の直後の `(` を要求し、`objects?.find?.(` の形を拾わない（`node` で確認。`gravsim_rocket_launcher.js:826` が該当し、許可リストにも検査にも入っていない。読込の直後に呼ばれるため現在は無害）。別名の一覧（上記 1 の `list`）や `.length` による判定も対象外で、1 を見逃した。
  3. 許可リストの 4 項目（5 箇所）の理由が実態と違う: `gravsim_object.js:74`・`:428`（`updateHistory` で効果の軌跡の点の基準を**記録**する処理で、描画ではない）、`gravsim_object.js:531`（`_recordActualFlightPath` の実飛行経路の**記録**）、`gravsim_trajectory_predictor.js:498`（`updateRocketFlightEvents` の ORBIT の通過の判定で、通過の状態を書き換える）、`gravsim_visual_effect_manager.js:106`（ホストの参照。理由はロケットによる停止だけを述べるが、ホストの参照には生きている物体の規則がなく、停止の判定はロケットだけを見るため、ロケットが飛行中で 3 km 未満の間は除去済みのホストが射点の演出に使われる（コードで確認））。いずれも影響は小さいが、許可の根拠が誤っているため、走査が守る規則の範囲が不明確になっている。
- **修正方針**: 中心の判定を生きている物体の数で行う（`countLive() === 0`。§4.13-27 の「空の一覧」をそう定義する）。回帰 17 の期待値をフェードによらない結果に直す。走査に `?.(` の形を加え、別名と `.length` の判定を拾うか、対象外とする範囲を明記する。許可リストの理由を実態に合わせて書き直し、記録・状態の更新にあたる箇所は規則を適用するか理由を付け直す。
- **分類**: 【実装】。本体とテストの変更が必要。

#### G3-2-04 [Minor]【実装】 設計書が値を定める項目のいくつかを、テストが範囲や比率でしか確かめていない（生き残る変異 2 件、緩いアサーション、実装から取った期待値）
- **箇所と現象**:
  1. §4.14-2「低詳細度は段の三角形の噴射を `PAYLOAD_PLUME_SCALE` 倍の長さで描く」: `regressions/19:399-418` は向き・対称・スロットルとの比例だけを確かめる。`gravsim_rocket_renderer.js:310` から `payloadScale` を除く変異（U43）は、回帰 19 と非 system の全 1,492 件を通過した（`mutN/out/logfull_U43.txt`）。`ambientPresRatio: 0` で長さは閉じた形で決まる。
  2. §4.14-4「`#rl-launch-mass` は 0.1〜500 t・0.1 t 刻み」: `regressions/19:656-731` は全プリセットの値が刻みに乗ることと 10 倍粗い刻みで外れることだけを確かめ、属性の値を確かめない。`index.html:470` の `min="0.1"` を `0` にする変異（U48）は全件を通過した。
  3. 設計書が件数を明記する走査を下限で確かめている: `regressions/16:688` `WORKER_ONLY.size > 40`（§4.13-23 は 75 個。実測 75）、`regressions/17:821` `on.size > 50 && emit.size > 50`（§4.13-28 は 63 種。実測 63／63。いずれも本監査がコピー上でアサーションを失敗させて値を表示して確認）。抽出の正規表現が退行して項目を落としても通る。
  4. 空振りするアサーション: `regressions/17:904` の `seen.burnoutNarrow >= 0`（§4.6 の 29 の範囲「MAIN ENGINE START から SRB 分離まで」のうち、SRB の燃焼終了後・分離前の局面を通ったことを要求しない）、`regressions/17:733-737` の `const v = Math.hypot(...) || 1; … assert.ok(v > 0)`（常に真）。
  5. `regressions/19:1004-1007`: 題名は「有限の正の数でない MET は時計にならない」だが、文字列 `'12'` を 12 として受け入れることを期待値にしている（`gravsim_sound_sequencer.js:139` の `Number()` の挙動を写した期待値）。§4.14-6 (a) は「有限の正の数のときだけ使う」とし、§4.13-21 は数字の文字列を状態でないとして扱う。
- **影響**: §3.4 の「緩いアサーションなし」、テスト計画 §1-1 の「設計書から期待値を導く」に反し、1・2 の退行は検出されない。
- **修正方針**: 1 は長さを `R × PLUME_LEN_RATIO × PAYLOAD_PLUME_SCALE × スロットル × (1 + e_vac × 0.15)` と厳密に比べる。2 は 7 本のスライダの `min`・`max`・`step` を設計書の値と比べる。3 は件数を設計書の値と等号で比べる。4 は燃焼終了後の局面を 1 フレーム以上要求し、トートロジーを除く。5 は設計書と実装・テストを一致させる（文字列を受け入れないなら実装を直し、受け入れるなら設計書に書く）。
- **分類**: 【実装】。テストの変更が必要（5 は実装か設計書の変更を伴う）。

#### G3-2-05 [Minor]【文書】 設計書・テスト計画の見出しと対象の範囲が Rev 6.12・6.13 に追随していない。§4.7 の継続の記述に 1 項目の漏れがある
- **箇所と現象**:
  1. 設計書 §4 の見出し（L333）が「補遺 Rev 6.1〜6.11」のまま。§4.13（Rev 6.12）と §4.14（Rev 6.13）を含む（G3-1-09 の 2 と同じ型）。
  2. テスト計画の冒頭 L3 の対象が「要件 1〜5 と §4 補遺 4.1〜4.12」で、§4.13・§4.14 のテスト（§4.1 の表の 2 行、§4.6）を含まない。§2 の F の行は `system/01`〜`04` で、`05_save_load_period_hud_view` がない（§4.1 にはある）。§4.6 は §4.13 の項目ごとのテストと期待値の出典を表にするが、§4.14 の 1〜10 には同じ表がない（§4.1 の G の行だけ）。
  3. 設計書 §4.7 の継続の精度は「全オブジェクトの全項目を比較した。一致しないのは `_restoredForces`、投棄物の名前、`hasPayloadPropulsion` の未設定と `false`、第 1 段分離後の `stages[0].dryMassT` だけ」とするが、射点のホールドダウン中に保存して読み込むと、解除前のフレームでは `_half_vx`/`_half_vy` も一致しない（`cont/` の h330_pad。読込時に `addObject` が現在の速度を入れ、保持中は更新も参照もされず、解除後の最初のステップで書き直されるため、位置・速度は一致する）。integration 14 は解除してから最初のフレームを比べるため現れない。
- **修正方針**: 1・2 は見出し・対象・F の行を直し、§4.14 の項目ごとのテストと期待値の出典の表を §4.6 に倣って加える。3 は保持中の `_half_vx`/`_half_vy`（保持中に読まれない作業値）を一致しない項目に加えるか、比べた条件（解除の後）を明記する。
- **分類**: 【文書】。文書の訂正だけで、実装・テストは変わらず、要求も満たされる。

---

### 2. 前ゲートの文書指摘の解消確認

独立監査3 Iteration 1 の文書指摘 G3-1-09 を、設計書 Rev 6.11〜6.13・テスト計画と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-1-09 (1) 終了理由の表・点数予算の記述 | ✓ 解消 | §4.3 L356 の `point_budget` は `maxPoints = min(MAX_POINTS, Number(options.maxPoints) > 0 ? Number(options.maxPoints) : MAX_POINTS)` になり、L348 は「点数予算（下表の `point_budget`）が尽きた場合は…その点数で打ち切る」になった |
| G3-1-09 (2) §4 の見出し | △ 再発（G3-2-05 の 1） | Rev 6.11 で「補遺 Rev 6.1〜6.11」に直したが、Rev 6.12・6.13 で §4.13・§4.14 を加えたときに範囲を直していない |
| G3-1-09 (3) 自転周期の式のプリセットの段 | ✓ 解消 | §3.1.1-2 L65 が `obj.param?.ROTATION_PERIOD ?? obj.rotationPeriod ?? this.getCelestialParam(obj.name)?.ROTATION_PERIOD ?? 0` になった |
| G3-1-09 (4) テスト計画の対象・ファイル名・構成数 | ✓ 解消（新たな不整合は G3-2-05 の 2） | L3 は Rev 6.13、§2 の F の行は `system/01_app_boot_and_prediction.test.mjs`、§4.4 は「実飛行（15 構成）」になった |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| §4.14 で予測だけを直したフラグの読み違い（受動ペイロードの停止、単段機の第 2 段分離） | 同じフラグ（`isPayloadSeparated`・`burnTime`・`isStage2Separated`）を読む主スレッドの箇所: 音声のテレメトリ（G3-2-01）、アナンシエーター（`totalStages > 1` で守られている）、予測線の印（§4.14-3 で修正済み）、描画（§4.14-2 で修正済み） | **要**（G3-2-01） |
| Sun の型を前提にした中心の再利用 | 連星・三体の生成器（G3-2-02 の 1）、太陽系の配置の "Sun" の検索（G3-2-02 の 2。H2-1 と同じ箇所）、Deploy の Sun の代替（`gravsim_object_placer.js:289-301`） | **要**（G3-2-02） |
| 一覧に残る除去済みの物体を生きているとみなす（§4.13-31） | 走査の対象外の形: 別名の一覧と `.length`（`gravsim_object_placer.js:212`、G3-2-03）、`find?.(`（`gravsim_rocket_launcher.js:826`、無害）。走査が拾う箇所は全件が規則か許可リストに当たる（回帰 18 の走査そのものが確かめ、agent_T の複製した走査でも同じ）。許可リストの理由の誤りは 4 項目 | **要**（G3-2-03） |
| 設計書が値を定める項目を範囲・比率で確かめる | 低詳細度の噴射の長さ、スライダの属性、走査の件数（G3-2-04）。§4.14-2 の高詳細度（`PAYLOAD_PLUME_SCALE` を `_drawPlume` に渡す）、§4.14-4 の刻み（`step` の変異 U46・U49）、`min="1"`（U47）は検出される | **要**（G3-2-04） |
| 実装から取った期待値 | `regressions/19:1007`（G3-2-04 の 5）。他に agent_T が挙げた `regressions/16:548-575`（SRB の規則をテスト側で書き直して毎フレーム比べる）は、描画の変異 U23・U24 を回帰 17 が検出するため指摘にしない。`regressions/19:713` のサイジングの値は入力（前提）として使っており、計画 §4.5 が導出できないとした値 | 一部 **要**（G3-2-04） |
| 既存テストの期待値の変更 | integration 05・07・08・09、regressions 06、unit 03・05 の変更をすべて読んだ。いずれも §4.13-14・-19・-24・-27・-30・-31、§4.14-5・-6 の仕様の変更に対応し、本体に合わせただけの変更はない（integration 07 の `'ACTIVE'` → `OBJECT_STATE.ACTIVE` はアプリに存在しない値の修正） | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件（grep） | 不要 |
| 中断しない経路への影響 | d2（35 構成）・s2（15 機）が変更前後で完全に一致。§4.13・§4.14 の各修正は保存・読込・除去・射点の特殊な経路だけを変える | 不要 |
| 保存・読込の継続 | 独立のハーネスの 10 通りで、§4.7 が挙げる違いと G3-2-05 の 3 のほかはビット単位で一致 | 不要（文書は G3-2-05） |
| 見直しの入力 §3 の「main」の列 | 退行・悪化の 6 行と「あり」の 11 行を両ツリーで再現し、すべて記載どおり。見直しに載っていない main と共通の不具合の候補は Watchpoint 3 | 不要（G3-2-01・02 を除く） |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-2-01・02 の修正の確認**: 音声のテレメトリと生成器の変更は物理を変えないはずなので、d2（`2e22aefa…`）・s2（`91c5b981…`）の一致を再確認すること。音声は受動ペイロード（ASNARO-2・ALOS-4）、単段機（SSTO）、自走ペイロード（HTV-X・MMX）、2 段・3 段機の全音声の列を、修正前後で比べること（`repro/B1_peco.out`・`B2_ssto.out` が修正前の列）。
2. **変異は担当のファイルだけで**: 本ラウンドの 95 件のうち 90 件は担当のファイルだけで検出された。修正で加えるテストも、狙った変異をそのファイルだけで検出することを確かめること（U43・U48 の型）。
3. **見直しの入力に載っていない共通の不具合の候補**: カウントダウン中（ホールドダウン中）に保存して読み込むと、ロケットは射点に固定されたまま、シーケンスも `rolloutedRocketId` も戻らず、UI から解放できない（agent_B の `B2/c4_pad_save_load.mjs` を本ブランチで再現）。main は保持・ホストを保存しないため別の形で打ち上げられない。本ブランチの退行とは言えないため指摘にしないが、見直しの入力 §3 に記録するかを決めること。
4. **スナップショットの応答と連番**: `runtimeSnapshot` の応答には `syncSeq` がない。保存の要求の直後に読込を行うと、古い世界の実行時状態が同じ id の新しいオブジェクトに付く可能性がある（再現していない。見直しの C3 の世代番号で扱うこと）。
5. **実行時間**: 単独実行で最長は system/02 の 44.5 s、regressions/08c の 26.1 s（負荷なし）。`npm test` 全体は 66.2 s（並列）、カバレッジ付きは 156.8 s。工程 4 で負荷の条件を記録すること。
6. **カバレッジのファイル単位**: `gravsim_trail_renderer.js` の行 88.21%、`gravsim_preset_manager.js` の分岐 80.54%、`gravsim_rocket_launcher.js` の分岐 82.39%、`gravsim_tab_rocket.js` の分岐 88.19% が低い（全体は基準を満たす）。分岐の値は実行ごとに 0.01〜0.2 ポイント揺れる。
7. **確かめていない数値の申告**: §4.13-3 の 1,568 構成の掃引（3 構成で `steps` が 1 減る）、§4.14-4 の 275 値／32 値（agent_B の数え方では 276／58）、§4.7 の 147 通りは、本監査では再実行していない（d2・s2 と独立の 10 通りの継続で代えた）。
8. **引き続き有効な Watchpoint**: Iteration 1 の WP4（自転角速度の算出の重複）、WP5（フライトプランの行の検証の範囲。Rev 6.11 で数値の項目の検証を加えた）、WP7（E2E の環境）、lint 警告 54 件（既存の testsuites）。

---

## 独立監査3: テスト設計・実装監査 — Iteration 3

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 3
- **実施日時**: 2026-11-22 09:53〜13:00 JST（10:30 頃にマシンが停止し、12:37 に再開した。停止の前に、機械的チェック・ファイルごとの単独実行・中断しない経路の一致・Iteration 2 の指摘の再現・補助エージェントの調査は完了していた。再開時に作業ツリーが監査開始時の md5 と一致することを確かめ、途中だった突然変異（64 件中 36 件が完了）は残りだけを、掃引は最初からやり直した。停止の原因はメモリ（7.6 GB）の不足とみられるため、再開後は並列数を下げた）
- **判定**: **FAIL**（【実装】Minor 2 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §3.3・§3.4・§4、設計書 Rev 6.14（§4.14-11〜13 を追加）、テスト計画、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1・2 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行・悪化はここで直す）は利用者の判断として扱い、その適用が正しいかを確かめた。

- **差分の特定**: Iteration 2 が監査したツリー（`scratchpad/gate3_it2/pristine`。`gate3_it2/md5_start.txt` の全 484 件と一致することを確認）と現行ツリーを `diff -r` で比べた（`gate3_it3/full.diff`・`code.diff`・`diffs/`）。変わったのは、本体 7 ファイル（`gravsim_object_manager.js`・`gravsim_object_placer.js`・`gravsim_object.js`・`gravsim_trajectory_predictor.js`・`gravsim_visual_effect_manager.js`・`gravsim_rocket_launcher.js`・`gravsim_sound_sequencer.js`）、回帰 15〜19 の変更、新規の回帰 20・21、設計書・テスト計画・見直しの入力・`testsuites/README.md`・本ファイル。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate3_it3/md5_start.txt`、486 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,625 行は追記前（`review_before_append.md`、md5 `c792a85d…`）と同一。
- **突然変異の方法**: すべて `gate3_it3/pristine`（作業ツリーの完全なコピー）からの使い捨てのコピー上で、1 箇所ずつ文字列置換（一致数を検査）で不具合を入れ、**その変更の対象として計画・設計書が挙げるテストファイルだけ**を実行した（`gate3_it3/mutrun.mjs`。Iteration 2 の `mutrun.mjs` に再開と全スイート実行の並列数の制限だけを加えた）。生き残ったものは、`npm test` と同じ非 system の全 1,528 件でも実行した。本ラウンドの変更に対する変異が 64 件（`mut/mutants.json`・`mut/out/`）。
- **補助エージェント**: 独立の補助エージェント 2 体を起動した。agent_T は新規・変更したテストの設計（緩いアサーション、期待値の出典、走査の許可リスト、件数）を読み、agent_B は本ラウンドの本体の変更による退行を 3 ツリー（現行・Iteration 2・main）で探した。結論は、本監査が自分で再実行・再現できたものだけを使った（再現の出力は `gate3_it3/repro/`）。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it3/`）: `progress.log`（経過。停止と再開を含む）、`run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 3 回・カバレッジ 2 回）、`timing/`（ファイルごとの単独実行）、`ident/`（中断しない経路の一致）、`mut/`（変異）、`sweep/`（音声の列の掃引）、`prof/`（プロファイルの列）、`h/`（再現用のハーネスとスクリプト）、`repro/`（指摘・見直しの入力の再現）、`main/`（`git archive main` の展開）、`agent_T/`・`agent_B/`（補助エージェント）。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（4.2 s）。Lint はエラー 0／警告 54（全件が既存の 16 テストファイル。本ラウンドで変更・追加したテスト 7 ファイルは 0 件）。型は TypeScript 7.0.2 で 44 ファイルを検査しエラー 0 |
| 全テスト | `npm test` | **1,569/1,569 pass**・fail 0・cancelled 0・skipped 0・todo 0（273 スイート）、62.6 s（load average 0.11 → 8.54、16 コア・メモリ 7.6 GB） |
| E2E 1〜3 回目 | `npm run test:system` × 3 | 3 回とも **41/41 pass**・skipped 0・cancelled 0（48.6 s・48.8 s・49.1 s）。`npm test` の中の 1 回と合わせて 4 回、失敗なし。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0 |
| カバレッジ | `npm run test:coverage`（2 回） | 2 回とも 1,569 pass（101.6 s・108.1 s）。1 回目 **行 99.36%・分岐 93.03%・関数 97.34%**（README と一致）、2 回目 99.36%・92.99%・97.34%。ファイル単位の分岐は実行ごとに最大 1 ポイント揺れる（`gravsim_object_placer.js` 90.49%／89.47%（README 90.49%）、`gravsim_rocket_renderer.js` 96.03%／95.71%（README 96.35%）、`gravsim_rocket_launcher.js` 82.55%／82.55%（README 81.79%）など） |
| ファイルごとの単独実行 | `node --test <file>`（全 53 ファイルを順に、負荷なし。load average 2.03 以下） | 全ファイル成功・skip 0。件数は regressions 440・unit 836・integration 252・system 41（計 1,569。README・テスト計画 §4.1 と一致。回帰 15＝22・16＝42・17＝32・18＝45・19＝74・20＝17・21＝11）。最長は system/04 44.2 s、system/02 41.8 s、regressions/08c 25.8 s、08b 20.1 s、integration/14 14.5 s、unit/07 14.5 s で、すべて 60 s の目安以内。新規の回帰 20 は 2.3 s、21 は 0.4 s |
| 中断しない経路の一致 | `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）、`gate2_it2/s2_flights.mjs`（cwd = リポジトリ、`GS_ROOT` = 各ツリー） | Iteration 2 のツリーと現行ツリーで**完全に一致**: d2 `2e22aefa3a20913ea507399278276b26`、s2 `91c5b9816a026dec4be5e3648cfd4948`（両ツリーとも期待値と同じ。s2 は 15 機、衝突 0・不一致 0） |
| 本ラウンドの変異 | `mut/`（64 件、対象ファイルのみ） | 58 件を対象のファイルだけで検出。L08（ホスト id のない射点の演出を「ホストが消えた」とみなす）は回帰 18 を通過し、全スイートで回帰 16 B2 が検出。A12（`tmTotalStages` のないフレームの段数の既定値 1 → 2）・T01（MET の `typeof` の検査を除く）・L09（射点の演出のホスト id が `undefined` の場合）は等価または到達しない（ロケットのフレームは常に段数を持ち、`Number.isFinite` は変換せず、`effect:pad-start` は常に数値の `hostId` を渡す）。**A11・A14 は全スイートでも生き残る**（G3-3-02） |

**Iteration 2 の【実装】指摘の解消確認**（G3-2-01〜G3-2-04）:

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-2-01 音声のフラグ | ✓ 解消 | Iteration 2 の再現スクリプト（`gate3_it2/agent_B/B3/r01`・`r02`）を両ツリーで実行した（`repro/G1_*`）。h3_30 ＋ ASNARO-2・ALOS-4 は Iteration 2 のツリーで分離の 618.9 s・649.9 s に `fl_peco` が鳴り、現行ツリーでは鳴らない（`fl_2-stage_sep` は残る）。SSTO ＋ ALOS-4 は Iteration 2 で 285.3 s に `fl_2-stage_sep`・`fl_peco`、現行は MECO・1-STG-SEP・SECO だけ。SSTO ＋ HTV-X は Iteration 2 で `fl_ses`・`fl_2-stage_sep` が鳴り、現行は PES（264.5 s）・PECO（467.6 s）だけ。規則（`gravsim_object_manager.js:447-478`）は設計書 §4.14-11 と一致し、ロケットの `isStage2Separated` は Worker の値のまま。全機体 × ペイロード × ミッションの掃引（下記）でも同じ |
| G3-2-02 銀河中心の後 | ✓ 解消 | `gate3_it2/agent_B/B2/c1`・`c2` を両ツリーで実行した（`repro/G2_*`）。銀河中心 → 連星・三体の「Sun A」は Iteration 2 で半径 1.270e10 m・枠線 `#FF4500`・`param` Sagittarius A*（Worker も同じ）、現行は 6.963e8 m・枠線なし・`param` Sun（Worker も同じ）。銀河中心 → Clear Selected → 太陽系は Iteration 2 で例外と一時停止、現行は Sun（中心）と 20 天体が置かれ一時停止しない。プロファイルの全 81 通りの 2 段の列（Solar・Binary・Three-Body・Galactic Center・Stress Test・Clear Selected・Reset・Earth・Sun のボタン）で、Iteration 2 との違いは銀河中心 → 連星・三体・Stress Test が新しいページと同じになった 3 列だけ（main との違いは中心の印と、§4.13-32 で直した銀河中心の Sun の重複だけで、例外の列は main と同じ）。現行ツリーの 128 通りの 3 段の列（銀河中心・連星・三体・太陽系 → Clear Selected・Reset・太陽系・銀河中心 → 各操作）を含め、残る例外と空振りは連星・三体の後の太陽系・Stress Test だけで、見直しの入力 H2-1（本ラウンドで追記）のとおり（`prof/`） |
| G3-2-03 中心の判定と走査 | ✓ 解消（新たな問題は G3-3-01） | 中心を除去した直後（フェード中）の連星は、Iteration 2 で中心なし・Clear Selected で全天体が消え、現行はフェードの前後とも Sun A が中心で残る（`repro/G3_wc_fade_*`）。走査は `?.(`・`.length`・`|| []`・別名を拾い、`gravsim_rocket_launcher.js:828` は規則を適用した。許可リストの理由が実態と違った 5 箇所のうち、効果の軌跡の基準天体（2 箇所）・ORBIT の通過・射点の演出のホストの 4 箇所は規則を適用して許可リストから外れ、実飛行経路の記録の 1 箇所は理由を書き直した。新しく当たった箇所（カメラの代替の生きている一覧の長さ、`updateUI` の一覧の数、`loadState`、`formatWorkerToMain`）は理由付きで許可された。走査の変異 S01〜S07 はすべて回帰 18 の入力のテストで検出。ただし、生きている物体の数による空の世界の判定は、§4.14-12 の置き換えと組み合わさって新しい退行を生んだ（G3-3-01） |
| G3-2-04 緩いアサーション | ✓ 解消（新たな不足は G3-3-02） | U43（X01）・U48（X02）は回帰 19 だけで検出し、Iteration 2 のテストでは生き残ることを同じ変異で確かめた（`mut/oldassert/`）。7 本のスライダの `min`・`max`・`step`（X02〜X05・X09）、Worker だけの項目 75 個の等号（新しい Worker の項目を加える X07）、イベント名 63 種の等号（名前の対を加える X08）を検出し、X07・X08 は Iteration 2 のテストでは生き残る。SRB の燃焼終了の後の局面は `>= 1`、`regressions/17` の小惑星の衝突はトートロジーを除いて距離 400 m・相対速度 500 m/s・向きを入力として確かめる形になった。MET は数値型だけ（`gravsim_sound_sequencer.js:142-144`）になり、設計書 §4.14-6 (a) と回帰 19 の期待値（数字の文字列・真偽値・配列・`Number` オブジェクト・BigInt は時計にならない）が一致した（T02・T04 を検出） |

**本ラウンドの本体の変更の検証**（全行を読み、変異と再現で確かめた）:

1. **音声のテレメトリのフラグ（§4.14-11）**: 2-STG-SEP の段数の条件、SES の分離の条件、SECO の段番号 ≥ 2 の項、PECO の噴射のラッチ（`_payloadBurnDetected`。保存しない）を読んだ。変異 A01〜A10・A13 をすべて回帰 20（A09 は回帰 15 でも）だけで検出。**掃引**（`sweep/`。6 機体 × ペイロード 7 通り（なしを含む）× 7 ミッションの 294 飛行を 3 ツリーで、既定のミッションの 42 通り × 保存・読込の時刻 5 通りの 210 飛行を現行と Iteration 2 で。LEGACY_QUICK、0.5 s のフレーム）: Iteration 2 との違いは 294 飛行中 214 で、7 つの型のすべてが「受動・ペイロードなしの分離の PECO がなくなる」「SSTO の 2-STG-SEP・SES がなくなる」「自走ペイロードの分離時の PECO がなくなり、実際の停止の PECO が残る」のどれか。main との違いは、自走ペイロードが噴射する飛行の PES・PECO の追加（設計書のとおり）と、受動ペイロード・ペイロードなしの 126 飛行のうち 13 で SECO と SES の順が入れ替わること（H4-22。G3-3-03 の 3）だけ。1-STG-SEP・2-STG-SEP・PES の時刻は Worker の状態のイベントと 1 フレーム以内で一致し、2-STG-SEP・SES は段数 2 以上だけ、PECO は PES の後だけで鳴り、読込の前に起きた段の分離・PES は読込の後に鳴らない。同じ音声が 2 回鳴るのは、H4-22 の 1 フレームの SECO の後に第 2 段の燃焼中に保存・読込した場合だけ（10 飛行。Iteration 2 のツリーでも同じ飛行で起きる）。geo_sat の深宇宙ミッションの PECO は燃焼時間 1,262 s の終わり（1,956 s・1,920 s）で鳴ることを長い飛行で確かめた。Epsilon などの「ロケットが消える」飛行は再突入時の動圧による破壊で、両ツリーで同じ。
2. **銀河中心の後の置き換え（§4.14-12）**: `_replaceCenterOfOtherKind`・`_externalHosts`・`placeAtOrbitAroundSun`・連星と三体の生成器の変更を読んだ。変異 P01〜P16・P18〜P20 をすべて回帰 21 だけで、P17（一覧の長さによる空の世界）を回帰 17 だけで検出。旧形式の保存（main で作った銀河中心・連星・Earth の保存）を読み込んだ後の各操作は、銀河中心 → Clear Selected → Earth のボタン（意図した修正）を除いて Iteration 2 と同じ（agent_B の `s1_saves_then_steps.mjs` を本監査が両ツリーで再実行、`repro/legacy_main_save.out`。id 0 の `param` のない中心は置き換えない）。ただし、置き換えの条件が広すぎ、利用者の置いた天体を消す（G3-3-01）。遠くの飛行中のロケットが消える件は G3-3-03 の 4。
3. **生きている物体の規則（§4.14-13）**: 効果の軌跡の基準天体、ORBIT の通過のホスト、射点の演出のホスト（ホストがなければ止める。描画のフックは `null` の文脈を飛ばす）、ランチャの旧形式の読込を読んだ。変異 L01〜L07 を回帰 18 だけで検出。agent_B のスクリプトを本監査が両ツリーで再実行した範囲で、射点の演出は、ホストの除去（射点・上昇中）で Iteration 2 より早く同じ更新で止まるだけで、`rolloutedRocketId`・Rollout ボタン・散水の音のフラグは変わらない（`repro/pad_host_removed.out`）。通常の飛行（ホストが生きている）の効果の軌跡・通過したイベントとそのフレーム・射点の演出の停止のフレームは、H3-22 ＋ HTV-X・ISS と SSTO ＋ MMX・火星遷移の 900 s で両ツリーの出力が同じ（`repro/normal_flight_md5.out`）。回帰 18 の補助 `frame()` の時間の修正（1 フレームが 1,000 倍の長さだった）は正しく（`SimulationController.update()` は経過 16 ms × 倍率で時間を求める）、旧い補助に戻したコピーでは R7 の効果の軌跡のテストだけが失敗し、R2 の各テストはどちらでも成功する。
4. **MET の型（§4.14-6 (a)）**: 数値型で有限の正の数だけを使う。T02（`Number()` に戻す）・T03（`>= 0`）・T04（文字列を `parseFloat`）を回帰 19 で検出。

**見直しの入力 §3 の本ラウンドの新しい行の突合**（`repro/`、`sweep/`）:

| ID | 文書の記載 | 結果 |
|---|---|---|
| H4-21 | 単段機のペイロード分離で SECO が鳴る。main で同じ | ✓ SSTO の全飛行で `fl_seco` が分離と同時に鳴る（main・現行とも。例: SSTO ＋ ASNARO-2・LEO で 307.5 s） |
| H4-22 | 第 1 段の分離がフレームの最後のサブステップで起きると SECO が 1 フレーム立つ。main で同じ | ✓ 2 段以上の 245 飛行のうち、1-STG-SEP と同じフレームに `fl_seco` が鳴るのは main 27、現行 21、Iteration 2 21（どの飛行で起きるかはフレームの位相で変わる） |
| H4-23 | 単段機のペイロード分離で 1-STG-SEP が鳴る。main で同じ | ✓ SSTO の全飛行で両ツリーとも鳴る |
| H4-24 | 効果の軌跡の点が、記録時に生きていた天体が一覧から消えると相対座標のまま描かれる。main で同じ | ✓ コードで確認（`gravsim_trail_renderer.js` は `refId` の天体がなければ点の値をそのまま使う。記録の時点の規則だけが本ラウンドで変わった） |
| H2-12 | 射点で保存・読込すると射点に保持されたまま解放できない | ✓ 現行ツリーで再現（`repro/H2_12.out`。読込の後 `rolloutedRocketId` は `null`、Rollout ボタンの表示、150 s 後も保持）。main はハーネスの音声のモックが合わず再実行できなかった（Iteration 2 の agent_B の結果のとおり、形が違う） |
| H2-13 | 新しいページで連星を続けて配置すると系が r1 ずつずれる。main で同じ | ✓ 両ツリーで 1・2・3 回目の重心が 960 → 690 → 420 px（`repro/H2_13.out`） |
| H2-1（追記） | 連星・三体の後の Stress Test は何も置かない、など | ✓ 2 段・3 段の列で、連星・三体の後の Stress Test は天体 1 つ（中心）だけ（`prof/`） |

本ラウンドで直したとされる 3 件の退行（G3-2-01〜03）はすべて直っている。一方、置き換えの規則そのものによる新しい退行が 1 件ある（G3-3-01）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-3-01 [Minor]【実装】 世界の中心の置き換え（§4.14-12）が、利用者が空の世界に置いた天体を、Deploy のボタンで消す（本ラウンドの退行）
- **箇所**: `scripts/gravsim_object_placer.js:99-114`（`_replaceCenterOfOtherKind`。条件は、中心の `param.NAME` が置く天体と違い、中心のほかに生きている天体がないことだけ）、呼び出し `:322-323`（Sun のボタン）・`:344-346`（惑星・恒星のボタン）・`:399-401`（`deployProfile` の `_externalHosts`。太陽系・Stress Test）、`:260`（空の世界の判定。§4.14-13 (a)）。設計書 §4.13-27（L529）・§4.14-12（L565-566）
- **現象**（`repro/C_user_center.out`、`h/user_center.mjs`。3 ツリーで同じスクリプト）: 新しいページで Sun の上にマウスで BlackHole を置き（Sun は衝突で破壊される）、System › Clear Selected（すべて）で世界を空にし、マウスで Jupiter を置く（空の世界に最初に置いた天体なので世界の中心になる）。その後に Deploy の Earth・Mars・Sun・Sirius のボタンを押すと、現行ツリーでは Jupiter が除去され（Worker からも消え、保存にも残らない）、キャンバスの中心に新しい Sun（中心）が置かれて、Earth などはその周りに置かれる。Solar System でも Jupiter が除去されて太陽系が置かれる。Iteration 2 のツリーと main では、どのボタンでも Jupiter は残る（Earth・Mars・Sun のボタンでは新しい天体が加わるだけ。Sirius は main では置かれ、Iteration 2 では例外。Solar System は両方で "Sun object not found" の例外（H2-1 の型））。
- **影響**: 利用者が置いた天体が、天体を追加するボタンで黙って消える。§4.14-12 の規則は §4.13-32 の逆向き（銀河中心の Sgr A* を新しいページの Sun に戻す）として設計されたが、条件は「中心が別の種類で、ほかに天体がない」だけで、プロファイルが中心にした天体に限っていない。Iteration 2 のツリーでは、このような天体は空の世界の判定（一覧の長さ。除去済みの天体がフェード中は空でない）のため中心にならないことが多く、置き換えもなかった。§4.14-13 (a)（生きている物体の数）と §4.14-12 の組み合わせで新しく生じた。回帰 21 C は「同じ種類の中心」「`param` のない中心」「ほかに天体がある中心」だけを確かめ、利用者が置いた別の種類の中心を確かめていない。§4.14 にも見直しの入力 §3 にも記録がない。
- **原因**: 置き換えの対象を「別の種類の中心」と定義し、中心ができる経路（プロファイルの `worldCenter`、空の世界への最初の配置、読込）を区別しなかった。
- **修正方針**: 置き換えを、プロファイルが中心に指定した天体（`worldCenter: true` の静的な物体。Sgr A*）に限るなどして、利用者が置いた天体を消さない規則にし、設計書 §4.13-27・§4.14-12 に書く。利用者が空の世界に置いた別の種類の中心のある世界で、惑星・恒星・Sun のボタンと太陽系・連星などのプロファイルを使うテストを加える（ボタンの期待値は main と同じく天体が残ること）。
- **分類**: 【実装】。本体・テスト・設計書の変更が必要。

#### G3-3-02 [Minor]【実装】 PECO の「燃焼時間 0」の条件をどのテストも確かめていない（生き残る変異 2 件）
- **箇所**: `scripts/gravsim_object_manager.js:478`（`curStatus === TELEMETRY.STATUS.MECO || (objData.burnTime !== undefined && objData.burnTime <= 0)`）。`testsuites/regressions/20_flight_callout_flags.test.mjs:405-406, 438-460`（停止のフレーム `STOPPED` は MECO の状態と燃焼時間 0 を同時に持ち、ほかは燃焼時間 40 の惰行だけ）、`regressions/15:788-796`・`regressions/16:1122-1131`（状態を変えるが燃焼時間は 50 のまま）
- **現象**: `burnTime <= 0` を `< 0` にする変異（A11）と、燃焼時間の項を除いて MECO の状態だけにする変異（A14。agent_T の候補と同じ）が、回帰 20 と非 system の全 1,528 件を通過した（`mut/out/logfull_A11.txt`・`logfull_A14.txt`）。実飛行では PECO のフレームは MECO の状態と燃焼時間 0 を同時に持つ（agent_T が 4 構成で確認）ため、現在の出荷の構成では等価に近い。
- **影響**: 設計書 §4.14-11 が §4.14-1 と同じとして定める規則（MECO の状態**か**燃焼時間 0）の片方が退行しても検出されない。§3.4 の「緩いアサーションなし」と、テスト計画 §1-2 の境界値（燃焼時間 0 の直前・一致）を満たしていない。
- **修正方針**: 回帰 20 の 5 に、ペイロードの噴射を見た後の MECO でない状態（COASTING・ASCENT など）で燃焼時間 0・−0・正の小さな値のフレームを加え、0 では PECO、正では PECO でないことを確かめる。
- **分類**: 【実装】。テストの変更が必要。

#### G3-3-03 [Minor]【文書】 テスト計画・設計書・テストのコメントの不整合と、見直しの入力への記録漏れ
- **箇所と現象**:
  1. テスト計画 §4.2 の最後の項: 「世界の中心（§4.14-12・-13）: 32 件」の中に「イベントの抽出・SRB の分離の時刻・小惑星の向きを回帰 17」と、変更前の `> 50`・`>= 0` のアサーションに当てた 3 件を含めているが、これらは G3-2-04（緩いアサーション）の修正で、G3-2-04 の 31 件（4＋21＋2＋4）に入っていない。また §4.6 の 28・29 の行は Rev 6.14 の等号・局面を書くが、23 の行（「A スキャン（3）」）は Worker だけの項目 75 個を等号で確かめるようになったことを書いていない。
  2. 回帰 18 S のコメント（`:1308` "Out of scope (none in scripts/ at the time of writing ...)"）は、計算した添字 `objects[i]` が `scripts/` にないとするが、`gravsim_worker_bridge.js:40` にある（そのループの `.length` の当たりが許可リストにあり、扱いは正しい）。また、走査は行単位で規則を数えるため、`gravsim_info_panel.js:60`（`om ? om.countLive() : this.universe.objects.length`）を「規則を適用」と数えるが、当たりそのものは一覧の長さの代替（`ObjectManager` は常にあり到達しない）で、設計書 §4.14-13 (b) の「新しく当たった箇所」にも挙がっていない（agent_T の指摘を `scan_hits.txt` とコードで確認）。
  3. 設計書 §4.14-11（L564）「既定のプランの音声の列は、受動ペイロードと噴射しない自走ペイロードで main と同じ」: 掃引では、受動ペイロードとペイロードなしの 126 飛行のうち 13 で SECO と SES の順が main と違う（H4-22 の 1 フレームの SECO が、本ブランチと main でフレームの位相が違うため別の飛行で起きる。例: H3-30・ペイロードなし・GTO は本ブランチで 260.5 s に SECO、main は 647.0 s）。H4-22 は直前の「変えないもの」に挙がっているが、この文には条件がない。
  4. 遠くにある飛行中のロケット・デブリが、世界の中心の置き換えの直後に消える: 銀河中心 → Earth のボタン → 打上げ → System › Clear Selected（天体だけ）→ Deploy の Earth・Sirius などのボタンで、Sgr A* が Sun に置き換わると、次の更新でロケットと投棄物が `ObjectManager._checkEscapeAndRemove`（最も重い天体から 200 AU、`gravsim_object_manager.js:552-571`）で除去・破壊される（agent_B の `r2_flight_center_replaced.mjs` を本監査が両ツリーで再実行、`repro/C1_flight_center_replaced.out`。Iteration 2 のツリーではロケットは残る）。main では同じ操作の Clear Selected の時点で、残った id 0 の Sun に対して同じ規則でロケットが消える（`repro/C1_placed_rocket.out`）ため、本ブランチの退行ではない（main と同じ仕組みが別の時点で起きる）。しかし設計書 §4.13-27 は「ロケット・デブリが残っていても中心とし」とだけ書き、その後に消えること、§4.14-12 の「結果はビット単位で新しいページと同じ」がロケット・デブリのない場合に限ることを書いておらず、見直しの入力 §3 にも記録がない。
- **修正方針**: 1・2 は計画 §4.2・§4.6 とコメント・設計書 §4.14-13 (b) を実態に合わせる。3 は「H4-22 の 1 フレームの SECO を除いて」と条件を書く。4 は見直しの入力 §3 に行を加え、設計書 §4.13-27・§4.14-12 に制限として書く（G3-3-01 の修正で規則を変える場合は、その規則に合わせて書く）。
- **分類**: 【文書】。文書とテストのコメントの訂正だけで、実装・テストの動作は変わらず、設計書の要求（§4.13-27 はロケット・デブリが残ることを保証していない）も満たされる。

---

### 2. 前イテレーションの文書指摘の解消確認

独立監査3 Iteration 2 の文書指摘 G3-2-05 を、設計書 Rev 6.14・テスト計画と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-2-05 (1) §4 の見出し | ✓ 解消 | L333 が「補遺 Rev 6.1〜6.14: …既存の不具合の修正（Rev 6.12、§4.13）、本ブランチの退行の修正（Rev 6.13、§4.14）、独立監査3 Iteration 2 指摘（G3-2-01〜G3-2-05、Rev 6.14）の反映」になり、§4.14 の見出しも「Rev 6.14 で 11〜13 を追加」 |
| G3-2-05 (2) テスト計画の対象・F の行・§4.14 の表 | ✓ 解消（新たな不整合は G3-3-03 の 1） | L3 は「Rev 6.14 の要件 1〜5 と §4 補遺 4.1〜4.14（§4.13・§4.14 を含む）」、§2 の F の行は `system/01`〜`05_save_load_period_hud_view`。§4.7 が新設され、§4.14 の 1〜13 の項目ごとにテスト・件数・期待値の出典を挙げる（11〜13 の件数 17・11・6 と内容は回帰 20・21・18 と一致） |
| G3-2-05 (3) §4.7 の継続の精度 | ✓ 解消 | L422 の一致しない項目に「射点のホールドダウン中に保存した飛行の解除前のフレームの `_half_vx`/`_half_vy`」と理由、integration 14 は解除の後から比べることが加わった |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 置き換え・除去が、規則の想定より広い物体に及ぶ | `_replaceCenterOfOtherKind` の呼び出し 5 箇所すべてで、利用者が置いた別の種類の中心が除去される（G3-3-01）。§4.13-32 の銀河中心の配置は、プロファイル自身の `worldCenter` の天体を置く場合だけ古い中心を除去し、利用者の天体は除去しない（プロファイルの消去が他の天体を消すのは従来どおり）。置き換えの後の遠いロケット・デブリの除去は main と同じ仕組み（G3-3-03 の 4） | **要**（G3-3-01） |
| 規則の「または」の片方だけを確かめるテスト | PECO の燃焼時間 0（G3-3-02）。SECO の 3 つの項（分離済み・段番号 ≥ 2・段番号 1 の MECO）は A05〜A07 で、2-STG-SEP の段数の境界は A02 で、ORBIT の通過のホストの有無は L03 で、射点の演出のホストの有無は L05・L06 で検出される | **要**（G3-3-02） |
| 予測と主スレッドの同じ意味のフラグ | §4.14-11 の 7 つのフラグを読むのは音声の規則（`LAUNCH_SEQUENCES` の `fl_*`）だけで、アナンシエーターは独自の条件（`gravsim_telemetry_panel.js:720-736`）を持つ（grep で確認）。予測の PAYLOAD CUTOFF は `ORBITAL_COAST` の段の状態、音声の PECO はテレメトリの MECO の状態か燃焼時間 0 で判定する。掃引では PECO はすべて PES の後に 1 回だけ鳴り、燃焼の終わり（H3-24 ＋ MMX の 1,038 s、geo_sat の 1,956 s・1,920 s など）に一致 | 不要（テストの不足は G3-3-02） |
| 一覧に残る除去済みの物体（§4.13-31） | 走査（回帰 18 S）は 74 箇所を当て、49 が規則、25 が許可リスト（agent_T の複製の走査を本監査が確認）。対象外の形（分割代入の改名、別のプロパティ・関数の戻り値、コピー）は `scripts/` の主スレッドにない。行単位の判定の弱さは G3-3-03 の 2 | 不要（文書は G3-3-03） |
| 既存テストの期待値の変更 | 回帰 15・16 の PECO の期待値は、噴射を見た後の規則への変更（§4.14-11）に対応し、噴射を見ていない場合に PECO でないことを加えた。回帰 17 W1 はフェード中の期待値（中心なし・全天体の消去）を、フェードによらない結果に直した（§4.14-13 (a)）。本体に合わせただけの変更はない | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件（grep） | 不要 |
| 中断しない経路への影響 | d2（35 構成）・s2（15 機）が変更前後で完全に一致。本ラウンドの変更は主スレッドの音声のフラグ、配置、除去済みの物体の扱いだけ | 不要 |
| 見直しの入力 §3 の新しい行 | H2-12・H2-13・H4-21〜H4-24・H2-1 の追記を再現・コードで確認し、すべて記載どおり。記録のない main と共通の現象は G3-3-03 の 4 | 不要（文書は G3-3-03） |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-3-01 の修正の範囲**: 置き換えを銀河中心の中心に限る場合も、銀河中心 → Clear Selected → 各プロファイル・ボタンの結果（回帰 21 の A・B）が変わらないこと、利用者が置いた天体と読込の中心が残ることを確かめること。物理は変わらないはずなので d2（`2e22aefa…`）・s2（`91c5b981…`）の一致を再確認すること。
2. **変異は担当のファイルだけで**: 本ラウンドの 64 件のうち 58 件は担当のファイルだけで検出された。修正で加えるテストも、狙った変異（A11・A14 の型）をそのファイルだけで検出することを確かめること。
3. **メモリ**: 本監査のマシン（7.6 GB、うち約 3 GB は IDE）は、変異 6 並列と掃引 9 本の同時実行でメモリが尽きて停止した。`node --test` で全スイートを並列に実行する作業（変異の全スイート、カバレッジ）は `--test-concurrency` を下げ、同時に走らせないこと。工程 4 で負荷とメモリの条件を記録すること。
4. **カバレッジのファイル単位**: 全体は基準を満たす（行 99.36%、分岐 92.99〜93.03%、関数 97.34%）が、分岐は目標 97% に届かず、ファイル単位の分岐は実行ごとに最大 1 ポイント揺れる（`gravsim_object_placer.js` 89.47〜90.49%、`gravsim_rocket_launcher.js` 82.55%（README 81.79%）、`gravsim_preset_manager.js` 80.54%）。README の値は 1 回の実行の例として扱うこと。
5. **H4-22 と保存・読込**: H4-22 の 1 フレームの SECO の後に第 2 段の燃焼中に保存・読込すると、実際の SECO でもう一度鳴る（10 飛行。Iteration 2 と同じ）。見直しで H4-22 を直すときに、§4.14-6 (c) の読込の印と合わせて扱うこと。
6. **引き続き有効な Watchpoint**: Iteration 2 の WP4（`runtimeSnapshot` の応答に連番がない。見直しの入力 C3 に記録された）、WP7（§4.13-3 の 1,568 構成の掃引、§4.14-4 の 275 値／32 値、§4.7 の 147 通りは再実行していない）、Iteration 1 の WP4・WP5・WP7、lint 警告 54 件（既存の testsuites）。

---

## 独立監査3: テスト設計・実装監査 — Iteration 4

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 4
- **実施日時**: 2026-11-22 13:25〜14:00 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **FAIL**（【実装】Minor 1 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §3.3・§3.4・§4、設計書 Rev 6.15（§4.14-14 を追加、§4.13-27・§4.14-11〜13 を改訂）、テスト計画、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1〜3 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行はここで直す）は利用者の判断として扱い、その適用が正しいかを確かめた。

- **差分の特定**: Iteration 3 が監査したツリー（`scratchpad/gate3_it3/pristine`。`gate3_it3/md5_start.txt` の全 486 件と一致することを確認）と現行ツリーを `diff -ruN` で比べた（`gate3_it4/full.diff`、878 行）。変わったのは、本体 1 ファイル（`gravsim_object_placer.js`: `_replaceCenterOfOtherKind(template, cleared)`、新しい `_profileCenterKinds()`、呼ぶ箇所 5 つの `cleared`、コメント）、回帰 20（PECO の境界 2 件）・回帰 21（D の 7 件と補助、`PHYSICS` の import）・回帰 18（S のコメントだけ）、設計書（Rev 6.15）・テスト計画・見直しの入力（H2-1 の追記、H2-14・H2-15 の新設）・`testsuites/README.md`。本ファイルは Iteration 3 の追記の後から変わっていない（md5 `b174bc40…`）。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate3_it4/md5_start.txt`、486 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,750 行は追記前（`review_before_append.md`、md5 `b174bc40…`）と同一。git の状態（HEAD `0e453a8`、stash なし）も変えていない。
- **突然変異の方法**: すべて `gate3_it4/pristine`（作業ツリーの完全なコピー。md5 の一致を確認）からの使い捨てのコピー上で、1 箇所ずつ文字列置換（一致数を検査）で不具合を入れ、**その変更の対象として計画・設計書が挙げるテストファイルだけ**を実行した（`gate3_it4/mutrun.mjs`。Iteration 3 の `mutrun.mjs` とコピー元だけが違う。並列 2）。生き残ったものは、`npm test` と同じ非 system の全 1,537 件でも実行した。対象は 58 件: Iteration 3 の変異のうち置換がそのまま当たる A11・A14・P01〜P09・P12〜P14・P17・P18・P20 の 17 件（`mut/mutants_it3.json`）と、本ラウンドの変更に対する 41 件（`mut/mutants.json`。置き換えの対象 Q01〜Q25、呼ぶ箇所の変更に合わせて置換を直した P10・P11・P15・P16・P19、PECO の条件 A15〜A25）。
- **補助エージェント**: 起動しなかった。本ラウンドの差分は本体の 1 関数とその呼び出し、回帰テスト 2 ファイルの追加で、すべて本監査が読み、変異と再現・掃引で確かめた。Iteration 3 の停止（メモリ）を踏まえ、並行の作業も増やさなかった。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB（IDE が約 3 GB を使用）。機械的チェック、ファイルごとの単独実行、中断しない経路の一致、変異、掃引、カバレッジの 2 回目を、この順に 1 つずつ実行した（重なったのは作業ツリーの複製（tar）と読み取りだけ）。各段の前後の空きメモリは 3.8〜4.2 GB、load average の最大は 9.95（`npm test` の直後）。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it4/`）: `progress.log`（経過）、`run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 3 回・カバレッジ 2 回）、`timing/`（ファイルごとの単独実行）、`ident/`（中断しない経路の一致）、`mut/`（変異）、`h/`（再現・掃引のスクリプト。`harness.mjs`・`user_center.mjs`・`profiles.mjs` などは Iteration 3 の `h/` の複写、`uc_matrix.mjs`・`h2_15_sunbody.mjs` は本監査で追加）、`repro/`（再現の出力）、`uc/`（利用者が置いた中心の掃引と解析）、`prof/`（プロファイルの列）、`main/`（`git archive main` の展開、0e453a8）。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（4.2 s）。Lint はエラー 0／警告 54（全件が既存の 16 テストファイルで、Iteration 3 と同じファイル。本ラウンドで変更した回帰 18・20・21 は 0 件）。型は TypeScript 7.0.2 でエラー 0 |
| 全テスト | `npm test` | **1,578/1,578 pass**・fail 0・cancelled 0・skipped 0・todo 0（274 スイート）、67.6 s（load average 0.45 → 9.95、空きメモリ 3.9 GB） |
| E2E 1〜3 回目 | `npm run test:system` × 3 | 3 回とも **41/41 pass**・skipped 0・cancelled 0（49.0 s・49.7 s・50.0 s）。`npm test` の中の 1 回と合わせて 4 回、失敗なし。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0 |
| カバレッジ | `npm run test:coverage`（2 回） | 2 回とも 1,578 pass（105.9 s・104.0 s）。**行 99.36%・分岐 93.02%／93.04%・関数 97.34%**（README は 99.36%・93.03%・97.34%）。ファイル単位では `gravsim_object_placer.js` の分岐が 2 回とも 89.96%（README 90.94%）、`gravsim_calc_object.js` 94.61%（README 94.49%）、`gravsim_rocket_launcher.js` 82.55%（README 82.30%）。`gravsim_object_placer.js` の未実行の行 436-443 は `profile.center` の処理で、`center` を持つプロファイルはない（既存） |
| ファイルごとの単独実行 | `node --test <file>`（全 53 ファイルを作業ツリーの複製 `timing_tree` で順に。load average 4.40 以下） | 全ファイル成功・skip 0。件数は regressions 449・unit 836・integration 252・system 41（計 1,578。README・テスト計画 §4.1 と一致し、README §2-D の件数のある 31 行もすべて一致）。Iteration 3 との違いは回帰 20 の 17 → 19 と回帰 21 の 11 → 18 だけ。最長は system/04 43.6 s、system/02 42.0 s、system/03 39.5 s、system/01 38.4 s、system/05 38.2 s、regressions/08c 26.6 s、08b 20.7 s で、すべて 60 s の目安以内。回帰 18 は 1.4 s、20 は 2.3 s、21 は 0.6 s。`timing_tree` の md5 は実行の前後で変わらない |
| 中断しない経路の一致 | `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）、`gate2_it2/s2_flights.mjs`（cwd = リポジトリ、`GS_ROOT` = 各ツリー、1 本ずつ順に） | Iteration 3 のツリーと現行ツリーで**完全に一致**: d2 `2e22aefa3a20913ea507399278276b26`（27.4 s・28.0 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（7.6 s・7.5 s。15 機、衝突 0・不一致 0）。両ツリーとも期待値と同じ |
| 本ラウンドの変異 | `mut/`（58 件、対象ファイルのみ） | 50 件を対象のファイルだけで検出。**A11・A14 は回帰 20 だけで検出**（各 2 s）。A24（PECO の MECO の比較を正規化の前の状態で行う）は回帰 20 を通過し、全スイートで回帰 16 C の走査が検出（§4.13-25 の規則。数値の状態では動作は同じ）。残る 7 件（P09・Q17〜Q20・A19・A25）は全スイートでも生き残り、すべて等価（下記） |

**Iteration 3 の【実装】指摘の解消確認**（G3-3-01・G3-3-02）:

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-3-01 利用者が置いた中心 | ✓ 解消（同じ型の残りは G3-4-01） | Iteration 3 の再現スクリプト（`gate3_it3/h/user_center.mjs`）を Iteration 3 のツリーと現行ツリーで実行した（`repro/C_user_center.out`）。新しいページ → Sun の上に BlackHole → Clear Selected → マウスで Jupiter（中心）の後、Iteration 3 のツリーでは Earth・Mars・Sun・Sirius のボタンと太陽系で Jupiter が除去され（Worker からも）、新しい Sun が中心になる。現行ツリーでは Jupiter は中心のまま残り、Earth・Mars のボタンは Sun（中心でない）と惑星を、Sun のボタンは Sun を加え、Sirius のボタンと太陽系は "Sun object not found in the universe." の例外で何も変えない（太陽系は一時停止のまま。H2-1）。下記の掃引で、Jupiter・Sirius・Earth・Sun・Moon・BlackHole を利用者が置いた場合の 23 の追加の配置は、全 1,656 通りで main と同じ結果になった。ただし、利用者が手で置いた Sgr A* は消える（G3-4-01） |
| G3-3-02 PECO の燃焼時間 0 | ✓ 解消 | 回帰 20 の 5 に 2 件（ペイロードの噴射を見た後、MECO 以外の 6 つの状態 × 燃焼時間 0・−0・−1e-9・−1 で PECO、`Number.MIN_VALUE`・1e-9・0.1・40 と燃焼時間のないフレームで PECO でない、MECO の状態だけ（燃焼時間 40・`Number.MIN_VALUE`・なし）でも PECO、噴射中と噴射を見ていない場合は燃焼時間 0 でも PECO でない、段数 1〜3。フレームごとの列）が加わった。Iteration 3 で全スイートを通過した A11（`<= 0` → `< 0`）・A14（MECO の状態だけ）を、同じ置換で回帰 20 だけで検出した。条件の他の部分の変異 A15〜A18・A20〜A23（MECO の項を除く、`!isFiring` を `!isIgnited` に、`<= 1e-9`・`=== 0`・`<= Number.MIN_VALUE`、`&&` を `||` に、ラッチを除く、`!(burnTime > 0)`）もすべて回帰 20 だけで検出 |

**本ラウンドの本体の変更の検証**（全行を読み、変異と再現・掃引で確かめた）:

1. **置き換えの対象（§4.14-14）**: `_replaceCenterOfOtherKind(template, cleared = false)`（`gravsim_object_placer.js:108-124`）は、`cleared` でなければ、中心の `param.NAME` が `_profileCenterKinds()`（`:131-141`。`DEPLOY_PROFILES` の静的な物体のうち `worldCenter === true` のもののプリセットの `NAME`。現在は Sagittarius A* だけ）に含まれるときだけ置き換える（`:113`）。`cleared` は `deployProfile` が `profile.clearPrevious === true` から求め（`:429`）、`_externalHosts` の呼び出し（`:431`）と連星・三体の生成器（`:465`・`:468` → `:564`・`:684`）に渡す。Sun・惑星・恒星のボタン（`:351`・`:374`）は渡さない。設計書 §4.13-27（L529）・§4.14-14（L571-572）の規則と一致する。変異 Q01〜Q16・Q21〜Q25（制限の除去・反転・`||`・中心でなくテンプレートの種類で判定、`cleared` の既定値・無視・固定・反転、呼ぶ箇所ごとの渡し忘れ・誤り、種類の集合をすべての静的な物体・テンプレートの鍵・空・生成器・最初のプロファイルだけから求める）をすべて回帰 21 だけで検出した。Q17（`worldCenter` を真偽で読む。値は `true` だけ）・Q18（`NAME` の代わりに `name`。プリセットの `param` は両方を同じ値で持つ）・Q19・Q20（生成器の `cleared` の既定値。アプリの呼ぶ箇所はすべて値を渡し、unit 03 の直接の呼び出しは中心のない世界）は等価。Iteration 3 の P01〜P20 は、P09 を除いて回帰 21（P17 は回帰 17）で検出した。P09（`_externalHosts` が自分で置くホストも返す）は新しい規則では等価: 太陽系の追加のホスト（Earth・Jupiter・Saturn）では、中心は最初の Sun の置き換えの後は Sun、利用者の天体の世界では利用者の天体で、どちらもプロファイルの中心の種類でなく `cleared` でもないため置き換えず、銀河中心のホスト（Sgr A*）では古い中心の除去の後で中心がない。
2. **PECO の条件（§4.14-11）**: 本体は変わらない（`gravsim_object_manager.js:478`）。テストは上表の G3-3-02 のとおり。A19（`!== undefined` の検査を除く。`undefined <= 0` は偽）・A25（`isPayloadSep` の項を除く。ラッチは分離済みで噴射しているとき（`isPes`）だけ立ち、Worker の分離のフラグは戻らない）は等価。設計書 L562 の「Worker のフレームの燃焼時間は `formatWorkerToMain` が 0 以上に丸める」は `gravsim_worker_bridge.js:56` のとおり。
3. **回帰 18 S のコメント**: 対象外の形のうち主スレッドのスクリプトにあるのは計算した添字 `objects[i]`（`gravsim_worker_bridge.js:40`）だけ、という新しい記述を grep で確かめた（分割代入の改名・関数の戻り値の一覧・コピーは 0 件。`gravsim_calc.js:204` は Worker）。テストの動作は変わらない（45 件）。

**回帰の探索**（`uc/`・`prof/`・`repro/`）:

- **利用者が空の世界に置いた中心 × Deploy の全ボタン・プロファイル**（`h/uc_matrix.mjs`）: アプリの更新ループ（カメラの代替、除去した天体のフェードの片付け、`updateUI`）を、Worker のフレームごとの `EventBus.emitUpdate` で再現した。置く天体 7（Jupiter・Sirius・Earth・Sun・Sgr A*・Moon・BlackHole）× 置く時点 2（除去した天体のフェード中・後）× カメラ 3（更新ループのまま（この経路では null）・利用者の天体・null）× 保存と読込の有無 2 × 操作 27（Sun・惑星・準惑星のボタン 12、恒星 7、衛星 3（Moon・Io・Titan）、プロファイル 5）の 2,268 通りを、現行・Iteration 3・main の 3 ツリーで実行した（`uc/analysis.txt`）。
  - 現行ツリーで利用者の天体が消えるのは、(1) 自分の消去を持つ連星・三体・Stress Test・銀河中心（Sun の種類の天体は連星・三体・Stress Test では主星として使い直されて残り、銀河中心では消える）と、(2) 手で置いた Sgr A* に対する 20 の操作（G3-4-01）だけ。(1) は main と Iteration 3 のツリーでも同じ通りで消える（main の連星は Sun A を失い「Sun B・Earth・Moon・Jupiter」になる。§4.13-27 で直した main の不具合）。現行ツリーの (1) の世界は、回帰 21 D のとおり新しいページとビット単位で同じ。
  - Sgr A* 以外の 6 種の天体に対する 23 の追加の配置（1,656 通り）は、一覧（中心の印を除く）・例外・一時停止のすべてが main と同じ。フェード中と後で結果は変わらず、Worker の物体の一覧は 3 ツリーの全通りで主スレッドと一致した。保存と読込の後も規則は同じ（読込はカメラを読み込んだ中心に移すため、恒星のボタンはその周りに置く。main も同じ）。Iteration 3 のツリーとの違いは、利用者の天体が残るようになった 1,200 通りだけ。
- **銀河中心の経路（§4.14-12）**: Iteration 3 の `h/profiles.mjs` の 81 通りの 2 段の列と 128 通りの 3 段の列（銀河中心・連星・三体・太陽系・Stress Test・Clear Selected・Reset・Earth・Sun のボタン）を Iteration 3 のツリーと現行ツリーで実行し、出力は完全に一致した（Iteration 3 の監査の `prof/` の出力とも一致）。回帰 21 A〜C も変わらず成功し、銀河中心の経路を壊す変異（P01〜P08・P10〜P16・P18〜P20、Q05・Q06・Q16・Q22〜Q25）は回帰 21 で検出される。
- **自分の消去を持つプロファイルでの置き換え（作業者の判断の確認）**: 連星・三体・Stress Test は、利用者が置いた別の種類の中心も置き換える（`cleared`）。main でもこれらの消去は id 0 以外の天体を除去するため、利用者の天体は main でも消える（上記 (1)、7 種のすべて）。置き換えない場合は、§4.13-27 の「消去は中心を残し、生成器は中心を最初の星にする」と、生成器が半径・`param` を書き換えないこと（G3-2-02）から、Jupiter の半径と `param` の「Sun A」になる。現行ツリーの結果は新しいページと同じで、main（Sun A を失う）より正しい。main と設計の両方に整合すると判断した。
- **手で置いた Sgr A***: 設計書 §4.14-14 は制限として記載する。main では残り、本ブランチの置き換えで消える退行のため、G3-4-01 とした。
- **見直しの入力の本ラウンドの行**: H2-14 は Iteration 3 の再現（`gate3_it3/repro/C1_*`）の出力と記載が一致する。H2-15 は、新しいページと銀河中心 → Clear Selected の後の連星・三体で、Worker の主星の名前が "Sun" のままであることを確かめた（`repro/h2_15_sunbody_cur.out`・`_main.out`。main も同じ）が、理由の記述に不足がある（G3-4-02 の 3）。H2-1 の追記（恒星のボタンの例外）は、上記の掃引で、生きている Sun もカメラの対象もないとき main も同じ例外を投げる（G3-4-02 の 4）。

本ラウンドで直したとされる 2 件（G3-3-01・G3-3-02）は直っており、物理と中断しない経路は変わらない。一方、G3-3-01 と同じ型の退行が、プロファイルの中心と同じ種類の天体（Sgr A*）について残る（G3-4-01）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-4-01 [Minor]【実装】 利用者が手で置いた Sagittarius A* は、Deploy のボタンと太陽系で消える（G3-3-01 と同じ型の残り。設計書は制限として記載）
- **箇所**: `scripts/gravsim_object_placer.js:108-124`（`_replaceCenterOfOtherKind`。`:113` の制限は中心の `param.NAME` だけを読む）、`:131-141`（`_profileCenterKinds`）、呼ぶ箇所 `:351`（Sun のボタン）・`:374`（惑星・恒星のボタン）・`:431`（太陽系の `_externalHosts`）。設計書 §4.14-14 (a) と制限（L572）。`testsuites/regressions/21_world_center_profiles.test.mjs:564-581`（この除去を期待値とする boundary のテスト）
- **現象**（`repro/C_user_sgra.out`、`uc/uc_cur.txt`・`uc_main.txt`・`analysis.txt`）: 新しいページで Sun の上にマウスで BlackHole を置き（Sun は衝突で破壊される）、System › Clear Selected で世界を空にし、Deploy › Object Mass で Sagittarius A* を選んでマウスで置く（空の世界に最初に置いた天体なので世界の中心になる）。その後に Deploy の Sun・惑星・準惑星（12）か恒星（7）のボタン、または太陽系を押すと、現行ツリーでは Sgr A* が除去され（Worker からも消え、保存にも残らない）、キャンバスの中心に新しい Sun（中心）が置かれて、その周りに置かれる。main ではどの操作でも Sgr A* は残る（Sun・惑星のボタンは天体を加え、恒星のボタンと太陽系は "Sun object not found in the universe." の例外。Iteration 2 のツリーは置き換えを持たない）。掃引では、この 20 の操作 × カメラ 3 × フェード中・後 × 保存と読込の有無の 240 通りすべてで、main で残り現行で消える。
- **影響**: G3-3-01 と同じく、利用者が置いた天体が、天体を加えるボタンで説明なく消える。本ブランチの置き換え（§4.14-12）による退行で、main では起きない。設計書 §4.14-14 は「区別には保存する印が要るため、見直しの C4 の役割のフラグで扱う」として制限に書くが、利用者の範囲の決定では本ブランチの退行はここで直す対象であり、先送りの判断の記録も、見直しの入力 §3 の行もない。回帰 21 D の boundary のテストは、この除去を正しい結果として固定している。
- **原因**: 「プロファイルが世界の中心として置いた天体」という役割を、天体の種類（`param.NAME`）で近似した。手で置いた同じ種類の天体と区別できない。
- **修正方針**: プロファイルの `worldCenter` の静的な物体として置いた天体（`deployProfile` の `centerDef`）に役割の印を持たせて保存・読込し、追加の配置（`cleared` でない呼び出し）はその印のある中心だけを置き換える（本ブランチは既に `isWorldCenter`・`hostAutoSelected` を保存に加えており、同じ扱いでよい。main の保存の銀河中心は id 0 の Sun が中心のため影響しない）。回帰 21 D の boundary のテストを、手で置いた Sgr A* が Jupiter と同じく残る期待値（Sun・惑星のボタンは Sun を加え、恒星のボタンと太陽系は例外。main と同じ）に改め、印のある Sgr A* の保存・読込の後の置き換えを確かめる。設計書 §4.13-27・§4.14-14 の規則と制限を改める。利用者がこの制限を受け入れる場合は、その判断を記録したうえで見直しの入力 §3 に行を加える。
- **分類**: 【実装】。本体・テスト・設計書の変更が必要。

#### G3-4-02 [Minor]【文書】 設計書・見直しの入力の改訂表示と main との比較の記述の不整合
- **箇所と現象**:
  1. 設計書 §4 の改訂日（L335）「最終改訂: Rev 6.13、2026-11-22 00:51 JST」: Rev 6.14（09:50）・Rev 6.15（13:21）の後も変わっていない（同じ行の「Rev 6.2〜6.15」は更新されている）。
  2. 設計書 §4.14-11（L564）に本ラウンドで加えた「ただし、H4-22 の 1 フレームの SECO は…」の文の注記が「Rev 6.14、G3-3-03」になっている。G3-3-03 は Iteration 3 の指摘で、冒頭の改訂履歴のとおり Rev 6.15 で反映した。
  3. 見直しの入力 H2-15（L98）「現在は無害（Worker は名前をパラメータの代替としてだけ読み…）」: Worker は `_categorizeBodies`（`gravsim_calc.js:221`）で名前が 'Sun' の天体を飛行制御の太陽 `sunBody` に選ぶため、名前はパラメータの代替のほかにも読まれる。現在の配置では、名前が "Sun" のままの主星がそのまま `sunBody` になり、名前を揃えた場合の代替（`massiveBodies[0]`）も同じ主星なので、結論（現在は無害）は変わらない（`repro/h2_15_sunbody_cur.out`・`_main.out`: 新しいページの連星・三体、銀河中心 → Clear Selected → 連星で、`sunBody` と `massiveBodies[0]` は同じ主星の id）。しかし、見直しで名前を揃えると `sunBody` の選び方が変わることが書かれていない。
  4. 設計書 §4.14-14 (a)（L572）「恒星のボタンは main では破壊された Sun（カメラの対象）の周りに置いていた」と、見直しの入力 H2-1 の追記（L84）「（Sun の破壊の後の Clear Selected など）…main は除去済みのカメラの対象の周りに黙って置く。§4.13-31 の生きている物体の規則で例外になった」: main で置かれるのはカメラが除去済みの物体を追っている場合だけである。アプリの更新ループでは、カメラの代替が追っている天体の破壊の後にカメラを生きている天体に移し、Clear Selected がその天体を除去するとカメラは null になるため、挙げられた経路（Sun の破壊の後の Clear Selected）では main も同じ例外を投げる（掃引の 1,656 通りで main と同じ）。回帰 21 D の補助はアプリの更新ループを通さないためカメラが破壊された Sun に残り、その注記（`regressions/21:508-509`）も同じ書き方をしている。
- **修正方針**: 1・2 は訂正する。3 は「Worker は名前 'Sun' を `sunBody` の選択にも使うが、現在の配置では同じ主星になる」と理由を書き、見直しで扱う範囲に `sunBody` を含める。4 は「カメラが除去済みの物体を追っているとき」と条件を書き、Sun の破壊の後の Clear Selected の経路では main も同じ例外であることを書く。
- **分類**: 【文書】。文書とテストのコメントの訂正だけで、実装・テストの動作は変わらず、設計書の要求も満たされる（4 は main との比較の記述で、本ブランチの規則と結果は変わらない）。

---

### 2. 前イテレーションの文書指摘の解消確認

独立監査3 Iteration 3 の文書指摘 G3-3-03 を、設計書 Rev 6.15・テスト計画・見直しの入力・回帰 18 と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-3-03 (1) 計画 §4.2・§4.6 | ✓ 解消 | §4.2 の「世界の中心（§4.14-12・-13）」は 28 件（回帰 21 の 12・回帰 17 の 1・回帰 18 の 15）になり、イベントの抽出・SRB の分離の時刻・小惑星の向きの 4 件は緩いアサーション（G3-2-04）の 35 件（4＋21＋2＋4＋2＋1＋1）に移った。§4.6 の 23 の行に「Worker だけの項目は 75 個を等号で確かめる」が加わった |
| G3-3-03 (2) 回帰 18 S のコメント・§4.14-13 (b) | ✓ 解消 | コメント（`regressions/18:1308-1315`）は、主スレッドのスクリプトにある対象外の形が `formatWorkerToMain` の `objects[i]`（`gravsim_worker_bridge.js:40`）だけで、同じループの `.length` の許可の理由が当たると書く（grep で確認）。設計書 §4.14-13 (b)（L568）は、`gravsim_info_panel.js:60` の行が規則の適用と数えられること、一覧の長さは `ObjectManager` のない宇宙の代替で、アプリでは `Universe` が `ObjectManager`（`gravsim_universe.js:127`）を `InfoPanel`（`:132`）の前に作るため通らないことを書く（コードで確認） |
| G3-3-03 (3) §4.14-11 の main との音声の列 | ✓ 解消（新たな不整合は G3-4-02 の 2） | L564 に「H4-22 の 1 フレームの SECO は…受動ペイロードとペイロードなしの 126 飛行のうち 13…H3-30・ペイロードなし・GTO は本ブランチで 260.5 s、main で 647.0 s」と条件が加わった（Iteration 3 の掃引の値と一致） |
| G3-3-03 (4) 遠くのロケット・デブリ | ✓ 解消 | 見直しの入力に H2-14（L97）が加わり、Iteration 3 の再現（`gate3_it3/repro/C1_flight_center_replaced.out`・`C1_placed_rocket.out`）と記載が一致する。設計書 §4.13-27（L529）に制限（新しい中心から 200 AU より遠い飛行中のロケット・デブリは `_checkEscapeAndRemove`（`gravsim_object_manager.js:552-571`）で除去・破壊される、main では Clear Selected の時点で同じ規則で起きる）が、§4.14-12（L566）に「ロケット・デブリが残っていなければ、結果はビット単位で新しいページと同じ」が加わった |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 置き換え・除去が利用者の天体に及ぶ | `_replaceCenterOfOtherKind` の呼び出し 5 箇所を、利用者が置いた中心 7 種 × 全 27 操作 × カメラ・フェード・保存と読込で掃引した（2,268 通り × 3 ツリー）。追加の配置（`:351`・`:374`・`:431` の太陽系）は Sgr A* 以外の中心を残し、main と同じ結果。自分の消去を持つプロファイル（`:431` の Stress Test、`:564`・`:684`）と銀河中心の古い中心の除去（`:418-422`）は利用者の天体を消すが、main でも消える。残りは手で置いた Sgr A*（G3-4-01） | **要**（G3-4-01） |
| 役割を種類・名前で表す | 本ラウンドの `_profileCenterKinds` は役割（プロファイルの中心）を種類で近似した（G3-4-01）。ほかに、太陽系・恒星のボタンのホストを名前 "Sun" で探す（H2-1）、Worker の `sunBody` を名前 'Sun' で選ぶ（H2-15。記述は G3-4-02 の 3）。いずれも見直しの入力 §2 の C4・S3 の型で、本ラウンドで新しく生じたのは G3-4-01 だけ | **要**（G3-4-01） |
| 規則の「または」の片方だけを確かめるテスト | PECO の 2 つの条件（A11・A14・A15）、条件の各部分（A16〜A18・A20〜A23）を回帰 20 だけで検出。置き換えの条件の `cleared` と種類の各部分（Q01〜Q16・Q21〜Q25）を回帰 21 だけで検出 | 不要 |
| 等価な変異 | P09・Q17〜Q20・A19・A25 の 7 件。いずれもコードの値の範囲（`worldCenter` は `true` だけ、`param` は `name` と `NAME` を同じ値で持つ、呼ぶ箇所はすべて `cleared` を渡す、`undefined <= 0` は偽、分離のフラグは戻らない）による。G3-4-01 の修正で規則が変わる場合は P09・Q17〜Q20 を再確認する | 不要（Watchpoint 2） |
| 既存テストの期待値の変更 | 本ラウンドは回帰 20・21 にテストを加えただけで、既存のテストの期待値・アサーションの変更はない（回帰 18 はコメントだけ）。ただし回帰 21 D の boundary は退行を期待値にしている（G3-4-01） | 不要（G3-4-01 で扱う） |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件（grep） | 不要 |
| 中断しない経路への影響 | d2（35 構成）・s2（15 機）が変更前後で完全に一致。本ラウンドの本体の変更は配置の規則だけ | 不要 |
| 見直しの入力 §3 の新しい行 | H2-14・H2-15・H2-1 の追記を再現とコードで確認した。H2-14 は記載どおり。H2-15 の理由と H2-1 の main との比較に条件の書き漏れ（G3-4-02 の 3・4）。記録のない main と共通の現象は見つからなかった | 不要（文書は G3-4-02） |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-4-01 の修正の範囲**: 役割の印で置き換えを限る場合も、銀河中心 → Clear Selected → 各プロファイル・ボタン（回帰 21 A〜C、`h/profiles.mjs` の 2 段・3 段の列）と、利用者が置いた中心（回帰 21 D、`h/uc_matrix.mjs`）の結果が、手で置いた Sgr A* を除いて変わらないことを確かめること。印の保存・読込と、印を持たない保存（main の保存、本ブランチのこれまでの保存）の扱いを決めて書くこと。物理は変わらないはずなので d2（`2e22aefa…`）・s2（`91c5b981…`）の一致を再確認すること。
2. **等価な変異の再確認**: 本ラウンドの等価な 7 件（P09・Q17〜Q20・A19・A25）のうち、P09・Q17〜Q20 は置き換えの規則と呼ぶ箇所に依存する。G3-4-01 の修正の後に、修正で加えるテストがそのファイルだけで新しい規則の変異を検出することと合わせて確かめること。
3. **カバレッジのファイル単位**: 全体は基準を満たす（行 99.36%、分岐 93.02〜93.04%、関数 97.34%）が、`gravsim_object_placer.js` の分岐は本監査の 2 回とも 89.96% で、README の 90.94% は再現しなかった（Iteration 3 でも 89.47〜90.49% と揺れた）。未実行の行 436-443（`profile.center`）は到達しないコードで、見直しで削除の候補になる。README の値は 1 回の実行の例として扱うこと。
4. **H2-1 の一時停止**: 利用者が置いた中心（Sun と Sgr A* 以外の種類。Jupiter・Sirius・Earth・Moon・BlackHole）の世界で太陽系を押すと、例外の後に一時停止のまま残る（main と同じ。掃引の 60 通り）。工程 4 の手動確認でこれを本ブランチの新しい不具合と数えないこと。見直しで一時停止の対の try/finally と合わせて扱う。
5. **メモリ**: 本監査は重い処理を 1 つずつ順に実行し、空きメモリは 3.8 GB を下回らなかった。工程 4 でも、全スイートの並列実行（`npm test`・カバレッジ・変異の全スイート）を同時に走らせないこと。
6. **引き続き有効な Watchpoint**: Iteration 3 の WP5（H4-22 の 1 フレームの SECO の後の保存・読込で SECO が再び鳴る）、Iteration 2 の WP4（`runtimeSnapshot` の応答に連番がない。見直しの入力 C3）、WP7（§4.13-3 の 1,568 構成の掃引、§4.14-4 の 275 値／32 値、§4.7 の 147 通りは再実行していない）、Iteration 1 の WP4・WP5・WP7、lint 警告 54 件（既存の testsuites）。

---

## 独立監査3: テスト設計・実装監査 — Iteration 5

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 5
- **実施日時**: 2026-11-22 14:29〜15:26 JST（停止なし。重い処理はすべて 1 つずつ順に実行した。掃引の 1 本はメモリの増加のため途中で止め、分割して実行し直した）
- **判定**: **FAIL**（【実装】Minor 1 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §3.3・§3.4・§4、設計書 Rev 6.16（§4.14-14 の置き換えの対象を保存する役割の印 `CelestialBody.isProfileWorldCenter` に改訂、§4.13-27・§3.5-1 に印を追加）、テスト計画、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1〜4 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行はここで直す）は利用者の判断として扱い、その適用が正しいかを確かめた。

- **差分の特定**: Iteration 4 が監査したツリー（`scratchpad/gate3_it4/pristine`。`gate3_it4/md5_start.txt` の全 486 件と一致することを確認）と現行ツリーを `diff -ruN` で比べた（`gate3_it5/full.diff`、946 行。`diffs/`）。変わったのは、本体 3 ファイル（`gravsim_object.js`: 新しい項目 `isProfileWorldCenter`、`gravsim_object_placer.js`: `deployProfile` での設定・`_replaceCenterOfOtherKind` の判定・`_profileCenterKinds` の削除・コメント、`gravsim_object_manager.js`: 保存と読込）、回帰 21（D の G3-4-01 の 1 件の書き換えと補助、E の 5 件の新設、`worldOf` に印を追加、`SOLAR_PLANETS` の import）、設計書（Rev 6.16）・テスト計画・見直しの入力（H2-1・H2-15 の記述）・`testsuites/README.md`、本ファイル（Iteration 4 の追記だけ。追記前の 2,750 行は `gate3_it4/pristine` の本ファイルと同一）。追加・削除されたファイルはない。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate3_it5/md5_start.txt`、486 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,865 行は追記前（`review_before_append.md`、md5 `bf34f27a…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 85 行）も変えていない。次のラウンドのために、監査開始時の作業ツリーの完全なコピーを `gate3_it5/pristine` に置いた（md5 の一致を確認）。
- **突然変異の方法**: すべて `gate3_it5/pristine` からの使い捨てのコピー上で、1 箇所ずつ文字列置換（一致数を検査）で不具合を入れ、**その変更の対象として計画・設計書が挙げるテストファイルだけ**（回帰 21。P17 は回帰 17）を実行した（`gate3_it5/mutrun.mjs`。Iteration 4 の `mutrun.mjs` とコピー元、全スイートの並列数 2 だけが違う。変異の並列 2）。生き残ったものは、`npm test` と同じ非 system の全 1,542 件でも実行した。対象は 68 件: 本ラウンドの印に対する 35 件（`mut/mutants_it5.json`: M01〜M34 と、削除された `_profileCenterKinds` の Q17 を残る `worldCenter` の読み取り（`deployProfile` の `centerDef`）に移した Q17a）と、Iteration 3・4 の置き換えの変異のうち置換がそのまま当たる 33 件（`mut/mutants_prev.json`: Q02・Q07〜Q15・Q19〜Q21、P01〜P20）。PECO の A 系列は、本体の条件（`gravsim_object_manager.js:478` 付近）と回帰 20 が変わっていないため再実行していない。
- **補助エージェント**: 起動しなかった。本ラウンドの差分は本体の 3 ファイルの十数行と回帰 21 で、すべて本監査が読み、変異と再現・掃引で確かめた。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB（IDE が約 3 GB を使用）。監査の開始前から、本リポジトリと無関係な孤立した Node のテストプロセス（cwd は削除済みの `/tmp/kogai-mutate-*`、`tests/lib.test.js`、各 90% 前後の CPU）が 14 本ほど動いており、load average は全工程を通じて 15〜24 だった（本監査のプロセスではないため停止していない。`foreign_procs_1.txt`）。所要時間は Iteration 4 より長い（`npm test` 102 s 対 68 s など）。機械的チェック、ファイルごとの単独実行、中断しない経路の一致、再現・掃引、変異を、この順に 1 つずつ実行した。掃引の最初の版（`h/flag_seq.mjs` の 2,744 列を 1 プロセスで）は、補助の模擬 Worker が `setImmediate` に積む応答が同期のループで解放されずに RSS が 4.9 GB（空き 0.3 GB）に達したため、その時点で停止し（`progress.log` 14:53）、列ごとに模擬 Worker を止めてイベントループに戻す修正をして、約 60 列ずつの別プロセスで実行し直した（最大 RSS 1.3 GB、空きメモリ監視の `watchdog.sh` を併用）。停止前に出力されていた 1,280 列は、やり直しの出力と完全に一致した。以後の各段の前後の空きメモリは 3.8〜5.2 GB。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it5/`）: `progress.log`（経過）、`run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 3 回・カバレッジ）、`timing/`（ファイルごとの単独実行）、`ident/`（中断しない経路の一致）、`mut/`（変異）、`h/`（再現・掃引のスクリプト。`harness.mjs`・`user_center.mjs`・`uc_matrix.mjs`・`profiles.mjs` は Iteration 4 の `h/` の複写、`flag_seq.mjs`・`xsave.mjs`・`payload_check.mjs` は本監査で追加）、`repro/`（G3-4-01 の再現）、`uc/`（利用者が置いた中心の掃引と解析）、`prof/`（プロファイルの列）、`flag/`（印の列の掃引）、`xsave/`（ツリーをまたぐ保存と読込、Worker への送信）、`main/`（`git archive main` の展開、0e453a8）、`pristine/`（監査開始時の作業ツリーの完全なコピー）。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（7.4 s）。Lint はエラー 0／警告 54（全件が既存の 16 テストファイルで、Iteration 4 と同じファイル。本ラウンドで変更した回帰 21 は 0 件）。型は TypeScript 7.0.2 でエラー 0 |
| 全テスト | `npm test` | **1,583/1,583 pass**・fail 0・cancelled 0・skipped 0・todo 0（275 スイート）、102.1 s（load average 15.8 → 23.8、空きメモリ 4.0 GB） |
| E2E 1〜3 回目 | `npm run test:system` × 3 | 3 回とも **41/41 pass**・skipped 0・cancelled 0（77.1 s・80.1 s・77.4 s）。`npm test` の中の 1 回と合わせて 4 回、失敗なし。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0 |
| カバレッジ | `npm run test:coverage` | 1,583 pass（173.8 s）。**行 99.36%・分岐 93.06%・関数 97.34%**（README は 99.36%・93.04%・97.34%）。ファイル単位では README の 42 行のうち 41 行が一致し、違うのは `gravsim_rocket_renderer.js` の分岐（96.35%、README 96.03%）だけ（README が書く揺れの範囲内）。本ラウンドで変えた `gravsim_object.js`（98.36%・92.50%・97.62%）・`gravsim_object_placer.js`（99.21%・90.67%・97.67%）・`gravsim_object_manager.js`（100%・97.93%・100%）は README と一致。`gravsim_object_placer.js` の未実行の行 423-430 は `profile.center` の処理（`center` を持つプロファイルはない。既存） |
| ファイルごとの単独実行 | `node --test <file>`（全 53 ファイルを作業ツリーの複製 `timing_tree` で順に） | 全ファイル成功・skip 0。件数は regressions 454・unit 836・integration 252・system 41（計 1,583。README・テスト計画 §4.1 と一致し、README §2-D の件数のある 31 行もすべて一致）。Iteration 4 との違いは回帰 21 の 18 → 23 だけ。最長は system/02 55.4 s、system/04 49.1 s、system/01 46.1 s、system/05 45.8 s、regressions/08c 45.8 s で、すべて 60 s の目安以内（load average 15.4〜16.9 の下）。回帰 21 は 2.0 s。`timing_tree` の md5 は実行の前後で変わらない |
| 中断しない経路の一致 | `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）、`gate2_it2/s2_flights.mjs`（cwd = リポジトリ、`GS_ROOT` = 各ツリー、1 本ずつ順に） | Iteration 4 のツリーと現行ツリーで**完全に一致**: d2 `2e22aefa3a20913ea507399278276b26`（47.1 s・47.7 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（13.6 s・13.2 s）。両ツリーとも期待値と同じ |
| 本ラウンドの変異 | `mut/`（68 件、対象ファイルのみ） | 59 件を対象のファイルだけで検出（本ラウンドの 35 件のうち 29 件を回帰 21 だけで、Iteration 3・4 の 33 件のうち 30 件を回帰 21（P17 は回帰 17）だけで）。全スイートでも生き残った 9 件のうち 7 件（M08・M22・M29・Q17a・P09・Q19・Q20）は等価。残る 2 件（M30・M31）は `isWorldCenter` のない旧形式のファイルで結果が変わる（G3-5-01） |

**Iteration 4 の【実装】指摘の解消確認**（G3-4-01）:

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-4-01 利用者が手で置いた Sgr A* | ✓ 解消 | Iteration 4 の再現スクリプト（`h/user_center.mjs SgrAStar <ボタン>`）を Iteration 4 のツリー・現行ツリー・main で実行した（`repro/C_user_sgra.out`）。新しいページ → Sun の上に BlackHole → Clear Selected → マウスで Sgr A*（中心）の後、Iteration 4 のツリーでは Earth・Sun・Sirius のボタンと太陽系で Sgr A* が除去され（Worker からも）、新しい Sun が中心になる（`gate3_it4/repro/C_user_sgra.out` と同じ出力）。現行ツリーでは Sgr A* は中心のまま残り、Earth のボタンは Sun（中心でない）と Earth を、Sun のボタンは Sun を加え、Sirius のボタンと太陽系は "Sun object not found in the universe." の例外で何も変えない（太陽系は一時停止のまま。H2-1）。アプリの更新ループを通した掃引（`h/uc_matrix.mjs`、`uc/analysis.txt`）では、手で置いた Sgr A* に対する 23 の追加の配置の 276 通りすべてで、一覧（中心の印を除く）・例外・一時停止・カメラ・Worker の一覧が main と同じになり、Iteration 4 で main と違った 240 通りはすべて「消える」から「残る」に変わった。回帰 21 D の boundary（除去を期待値とした 1 件）は、同じ操作の 160 通りで main と同じ結果を確かめる regression に置き換わった |

**本ラウンドの本体の変更の検証**（全行を読み、変異と再現・掃引で確かめた）:

1. **役割の印 `CelestialBody.isProfileWorldCenter`**（`gravsim_object.js:227-232`）: 既定は `false`。`deployProfile` が `worldCenter: true` の静的な物体（`centerDef`、`gravsim_object_placer.js:404`）として置いた天体にだけ、`isWorldCenter` と同時に真を設定する（`:441-447`）。現在は銀河中心の Sgr A* だけ。ほかに真を設定する箇所はない（grep）。置き換えで置いた新しい中心（`:121-124`、`placeObject` の新しい物体）、生成器が使い直す中心（同じ種類の中心だけで、印は偽のまま）、Reset の Sun（`gravsim_universe.js:278-290`、`placeObject`）、空の世界に置いた天体（`:272`）は偽。2 回目の銀河中心は古い中心（印つき）を除去し（`:405-408`）、新しい Sgr A* が印を持つ。
2. **置き換えの判定**（`_replaceCenterOfOtherKind`、`:110-126`）: `cleared` でなければ、中心の `isProfileWorldCenter !== true` のとき置き換えない（`:115`）。種類の判定 `_profileCenterKinds` は削除され、参照は残っていない（grep。設計書 L573 の「削除した」の記述だけ）。種類が同じ・`param` がない・ほかに天体がある中心を残す条件（`:113`・`:116-117`）と、`cleared` の求め方・渡し方（`:416`・`:418`・`:455`・`:458`、生成器 `:554`・`:674`）、Sun・惑星・恒星のボタンの呼び出し（`:337`・`:360`）は Iteration 4 と同じ。設計書 §4.13-27（L530）・§4.14-14 (a)〜(c)（L573）と一致する。
3. **保存と読込**（`gravsim_object_manager.js:641-644`・`:743-746`）: 保存は天体ごとに `isProfileWorldCenter === true` の真偽値を書き（ロケット・デブリには書かない）、読込は厳密に `true` のときだけ真とする。`false`・項目なし・真偽値でない値は偽。`isWorldCenter` の旧形式の規則（どの天体にも `isWorldCenter` がなければ id 0 を中心にする、`:753-759`）は変わらず、その中心の印も偽。設計書 §3.5-1（L296）と一致する。`SaveManager` は `universe.getState()` を JSON にするだけで（`gravsim_save_manager.js:50-55`・`:84-91`）、項目の一覧や版の検査はない。
4. **Worker への送信**: `addObject` の `add`（`gravsim_object_manager.js:97-127`）と `updateObject` の `update`（`:193-210`）は送る項目を列挙して作り、印を含まない。銀河中心 → Clear Selected → 保存 → 読込 → Earth のボタンの全メッセージのキー（25 種）に `WorldCenter` を含むものはなく、`add` のキーの集合は Iteration 4 のツリーと同じ、Worker の物体に印の項目はない（`xsave/payload_cur.txt`・`payload_it4.txt`）。中断しない経路の d2・s2 も完全に一致した（上表）。
5. **コメント**: `_replaceCenterOfOtherKind` の JSDoc（`:84-109`）、`placeAtOrbitAroundSun` の 2 箇所（`:333-335`・`:353-357`）、`deployProfile`（`:410-415`・`:441-443`）、保存・読込（`gravsim_object_manager.js:642-643`・`:744-745`）の記述は動作と一致する。
6. **変異**（`mut/`）: 印の設定（M01 既定値が真、M02 項目の初期化なし、M09 プロファイルが付けない、M10 すべての静的な物体に付ける、M11・M12 置き換えで置いた新しい中心に付ける・古い中心の値を写す、M13 空の世界の最初の天体に付ける、M14・M15 生成器が使い直す中心に付ける、M16 Reset の Sun に付ける）、判定（M03 判定を除く、M04 種類による判定に戻す、M05 反転、M06 `&&` を `||` に、M07 `cleared` を無視、M20 印と種類の両方を要求、M17〜M19 呼ぶ箇所が `cleared` に真を渡す）、保存と読込（M21 保存しない、M23 `isWorldCenter` を書く、M24 読まない、M25 生の値、M26 `Boolean()`、M27 ないときに真、M28 `isWorldCenter` を読む、M32 文字列 "true" も真）、ほかの規則との組み合わせ（M33 2 回目の銀河中心が古い中心を残す、M34 自分の消去を持つプロファイルが中心の印を消す）の 29 件を、回帰 21 だけで検出した（各 1〜3 s）。全スイートでも生き残った 6 件のうち、M08（`!flag`）・M22（保存で生の値）・M29（`typeof === 'boolean'` の読込）は印が常に真偽値のため、Q17a（`centerDef` を `worldCenter` の真偽で探す）は `DEPLOY_PROFILES` の値が `true` だけのため等価。M30（旧形式の規則で中心にした id 0 の天体に印を付ける）・M31（ファイルの `isWorldCenter` が真のときだけ印を読む）は `isWorldCenter` のないファイルで結果が変わり、等価でない（G3-5-01）。Iteration 3・4 の 33 件は、P09・Q19・Q20 を除いて回帰 21（P17 は回帰 17）だけで検出し、この 3 件は Iteration 4 と同じ理由で等価（呼ぶ箇所と規則に変更がない）。

**回帰の探索**（`uc/`・`prof/`・`flag/`・`xsave/`・`repro/`）:

- **利用者が空の世界に置いた中心 × Deploy の全ボタン・プロファイル**（`h/uc_matrix.mjs`、Iteration 4 と同じ 2,268 通り。Iteration 4 のツリーと main の出力は `gate3_it4/uc/` のものを使った。両ツリーは変わっていない）: 7 種の天体（Jupiter・Sirius・Earth・Sun・Sgr A*・Moon・BlackHole）に対する 23 の追加の配置の 1,932 通りは、**すべて main と同じ**（一覧（中心の印を除く）・例外・一時停止・利用者の天体の有無・カメラ・Worker の一覧）。Iteration 4 のツリーとの違いは、手で置いた Sgr A* の 240 通り（消える → 残る）だけ。自分の消去を持つプロファイル（連星・三体・Stress Test・銀河中心）の 336 通りは Iteration 4 のツリーと完全に同じ（利用者の天体は main と同じく消え、Sun の種類の天体だけが主星として使い直される）。Worker の一覧の不一致・フレームの例外は 0 件。
- **銀河中心の経路**（`h/profiles.mjs`、Iteration 3・4 の 81 通りの 2 段と 128 通りの 3 段の列）: 出力は Iteration 4 の監査の現行ツリーの出力（`gate3_it4/prof/`）と完全に一致した。
- **印の列の掃引**（`h/flag_seq.mjs`、本監査で追加）: 銀河中心・連星・三体・太陽系・Stress Test・Clear Selected・Reset・保存と読込（JSON にして新しいページで読む）・Sun・Earth・Sirius のボタン・世界を空にする操作（中心に BlackHole、Clear Selected）・利用者の Sgr A*・Jupiter の配置の 14 の操作の、新しいページからの全 3 段の列 2,744 通りと、銀河中心または空の世界から始まる 4 段の列 1,024 通り（操作の後にアプリの更新を 3 フレーム）を、現行ツリーと Iteration 4 のツリーで実行した（`flag/analysis.txt`）。現行ツリーで印を持つのは、どの列でも銀河中心の Sgr A* が中心のときの 1 体だけ（862 列。印を持つ中心でない天体は 0）で、中心が印のない Sgr A* の 90 列はすべて利用者が置いた Sgr A* の列。Iteration 4 のツリーとの違いは 42 列で、**すべて手で置いた Sgr A* が空の世界の中心になった列**（Iteration 4 のツリーでは Sun に置き換わり、現行ツリーでは残る。うち 2 列は途中の太陽系の例外だけが違い、最後の連星・銀河中心で同じ世界になる）。保存と読込を挟む列（銀河中心 → 保存と読込 → Clear Selected → Earth など）を含め、ほかの 3,726 列は印の項目を除いて完全に一致した。Worker の一覧の不一致は 0 件。
- **ツリーをまたぐ保存と読込**（`h/xsave.mjs`）: 8 つの世界（銀河中心、銀河中心 → Clear Selected、新しいページ、利用者の Sgr A*、利用者の Jupiter、連星、銀河中心 → Clear Selected → Reset、銀河中心 → 連星）の保存を main・Iteration 4・現行の各ツリーで作り、9 つの操作（Sun・Earth・Sirius のボタン、太陽系、連星、銀河中心、Clear Selected → Sun のボタン、Clear Selected → 太陽系、三体）の前に読み込んだ（各 72 通り）。(1) 現行ツリーの保存を現行ツリーで読む結果は、Iteration 4 の保存を Iteration 4 のツリーで読む結果と、利用者の Sgr A* の 6 通り（残る）を除いて同じで、印の保存・読込が Iteration 4 の種類による判定と同じ置き換えを再現する。(2) main の保存は現行ツリーと Iteration 4 のツリーで 72 通りとも同じ結果（main は `param` も `isWorldCenter` も保存しないため、中心は旧形式の規則による id 0 の Sun で、印は関係しない）。(3) Iteration 4（Rev 6.15）の保存の銀河中心の Sgr A* は、現行ツリーでは印のない中心として残る。銀河中心 → Clear Selected の保存では、Sun・Earth・Sirius のボタンと太陽系が main がそのファイルを読んだ場合と同じ結果になる（Earth は Sgr A* の周りに置かれて次のフレームで破片になる、太陽系は例外で一時停止のまま。連星・三体・Clear Selected の後の結果が main と違うのは §4.13 で直した main の不具合による）。設計書 §3.5-1・§4.14-14 (c) が「印のない旧形式のファイル（main と Rev 6.15 までの保存）の中心はプロファイルの中心とせず…（main で天体が残るのと同じ）」と定める挙動で、本ブランチの未公開の版の保存だけに関わる。
- **見直しの入力の本ラウンドの行**: H2-1 の追記（恒星のボタンの例外の条件）と H2-15 の訂正（`sunBody` の選択）を、上の掃引（アプリの更新ループの経路で main も同じ例外）と `gravsim_calc.js:221`（`massiveBodies.find(b => b.name === 'Sun') || massiveBodies[0]`）で確かめた。記録のない main と共通の現象は見つからなかった（空の世界・利用者の天体の世界での太陽系の例外と一時停止は H2-1 の範囲）。

本ラウンドで直したとされる G3-4-01 は直っており、手で置いた Sgr A* を除く全経路の結果、物理と中断しない経路は Iteration 4 と変わらない。一方、印の読込は、`isWorldCenter` のない旧形式のファイルとの組み合わせがテストで固定されていない（G3-5-01）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-5-01 [Minor]【実装】 `isWorldCenter` のない旧形式のファイルでの印の読込を、どのテストも確かめていない（変異 M30・M31 が全スイートを通過）
- **箇所**: `scripts/gravsim_object_manager.js:743-746`（印の読込）・`:753-759`（旧形式の中心の規則）。設計書 §3.5-1（L296「`isWorldCenter` の旧形式の規則（id 0 の天体を中心とする）は変えず、その中心も偽とする」）・§4.14-14 (c)（L573「印のない保存ファイル…の中心はプロファイルの中心とせず、(a) では置き換えない」）。`testsuites/regressions/21_world_center_profiles.test.mjs:806-843`（E の abnormal。印の値 7 種を試すファイルは、すべての天体に `isWorldCenter` がある現行の形式だけ）
- **現象**（`mut/out_it5/results.json`、`mut/legacy_probe_orig.txt`・`legacy_probe_M30.txt`・`legacy_probe_M31.txt`）: 次の 2 つの変異は、ファイルの読込の結果を変えるが、回帰 21 も非 system の全 1,542 件も通過する。
  1. M30（旧形式の規則で中心にした id 0 の天体に印を付ける: `if (legacyCenter) { legacyCenter.isWorldCenter = true; legacyCenter.isProfileWorldCenter = true; }`）: どの天体にも `isWorldCenter` がないファイルで、id 0 の天体が `param` を持つ Jupiter または Sgr A* だけの世界を読み込み、Sun・Earth のボタンか太陽系を押すと、その天体が除去されて新しい Sun の周りに作られる。変更前のコードでは天体は中心のまま残り、Sun は横に加わり、太陽系は "Sun object not found in the universe." の例外になる（main と同じ）。
  2. M31（ファイルの `isWorldCenter` が真のときだけ印を読む）: `isProfileWorldCenter: true` を持ち `isWorldCenter` のない id 0 の Sgr A*・Jupiter のファイルで、変更前は印を真として読んで Sun・Earth のボタンと太陽系が置き換え、M31 では偽として残す。どちらが正しいかは設計書に書かれていない（§3.5-1 の「読込は厳密に `true` のときだけ真」と「旧形式の…その中心も偽」のどちらが当たるかが決まらない）。
- **影響**: 設計書が明示する旧形式のファイルの契約（旧形式の中心は印を持たず、Deploy のボタンと太陽系はそれを置き換えない）が、テストで固定されていない。旧形式の中心に印を付ける変更が入ると、読み込んだ天体が天体を加えるボタンで消える（G3-3-01・G3-4-01 と同じ型の結果）が、どのテストも失敗しない。main と本ブランチの各版が書いたファイルではこの違いは現れない（main は `param` を保存しない。`param` を保存し `isWorldCenter` を保存しない Rev 6.12 より前の版（`scratchpad/feat_tree`）では、id 0 はページの最初の Sun で、種類は Sun のまま）ため、手で編集したファイルなどでだけ起きる。しかし回帰 21 E は手で作った印の値（`1`・`"true"`・`{}`・`[true]`・`null`）を異常系の入力として確かめており、旧形式と印の組み合わせも同じ入力の範囲（工程 3 の異常系: 不正値・状態不整合）に入る。
- **原因**: E の abnormal のテストは印の値を現行の形式のファイル（すべての天体に `isWorldCenter` がある）でだけ変え、旧形式のファイルを読むテスト（回帰 17 W・回帰 21 C の「legacy save without a param」）は、id 0 の中心が Sun の種類か `param` のないファイルで、印が結果に関わらない。
- **修正方針**: 回帰 21 E に、(1) どの天体にも `isWorldCenter` がなく、id 0 の天体が `param` を持つ Jupiter（と Sgr A*）だけのファイルを読むと、その天体が印のない中心になり、Sun・Earth のボタンは天体を残して Sun（中心でない）を加え、太陽系は例外になる（main と同じ）ことを確かめるテストを加える（M30 を検出する）。(2) `isProfileWorldCenter: true` を持ち `isWorldCenter` のないファイルの読み方を設計書 §3.5-1 に書き（現行のコードは真として読み、旧形式の規則で中心になった id 0 の天体を置き換える）、テストで固定する（M31 を検出するか、M31 の動作を仕様にする）。テスト計画 §4.2・§4.7 の 14 の行を更新する。
- **分類**: 【実装】。テストの追加（と設計書の 1 文）が必要。本体の動作の誤りではない。

#### G3-5-02 [Minor]【文書】 テスト計画 §4.2・§4.3 の記述の不整合
- **箇所と現象**:
  1. テスト計画 §4.3 の `npm test` の行（L114）「1,583 件…（2026-11-22、独立監査3 Iteration 4 の指摘への対応の後）。1 回目は E2E 03 の 1 件が大気の上限の直下の標本で失敗した（…H1-14 に記録）。修正後、…すべて成功」: E2E 03 の失敗は 1,533 件の時点（独立監査3 Iteration 2 より前。`gate3_it2/pristine` の同じ行は「1,533 件…（約 73 秒）。1 回目は E2E 03 の…」）の出来事で、その後の更新でも文が残り、いまは Iteration 4 の指摘への対応の後の最初の実行が失敗したように読める。
  2. §4.2 の最後の項目（L108）「Iteration 3・4 の監査が等価とした Q17・Q19・Q20・P09（規則の変更の後も同じ理由で等価）」: Q17（`worldCenter` を真偽で読む）は本ラウンドで削除された `_profileCenterKinds` の中の変異で、その形では存在しない。残る `worldCenter` の読み取りは `deployProfile` の `centerDef`（`gravsim_object_placer.js:404`）で、そこへ移した変異（本監査の Q17a）は同じ理由（`DEPLOY_PROFILES` の値は `true` だけ）で等価だった。
- **修正方針**: 1 は、文を起きた時点（1,533 件の実行）の記述として書くか、最新の実行の行から外す。2 は、Q17 を `centerDef` の読み取りに移したことを書く（G3-5-01 の修正で加える変異も合わせて書く）。
- **分類**: 【文書】。テスト計画の記述の訂正だけで、実装・テストの変更を必要とせず、設計書の要求も満たされる。

---

### 2. 前イテレーションの文書指摘の解消確認

独立監査3 Iteration 4 の文書指摘 G3-4-02 を、設計書 Rev 6.16・見直しの入力・回帰 21 と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-4-02 (1) §4 の最終改訂 | ✓ 解消 | 設計書 L336 は「以降の改訂（Rev 6.2〜6.16）…最終改訂: Rev 6.16、2026-11-22 14:23 JST」で、冒頭の改訂履歴（L3）の Rev 6.16 の日時と一致する。§4 の見出し（L334）にも Iteration 4 の指摘（G3-4-01〜G3-4-02、Rev 6.16）が加わった |
| G3-4-02 (2) §4.14-11 の版の表記 | ✓ 解消 | L565 の H4-22 の 1 フレームの SECO の文の注記は「Rev 6.15、G3-3-03」になった（改訂履歴の Rev 6.15 と一致） |
| G3-4-02 (3) H2-15 の理由 | ✓ 解消 | 見直しの入力 L98 は「Worker は名前を、パラメータの代替と、飛行制御が使う Sun（`sunBody`、`gravsim_calc.js:221`）の選択に読むが、天体はすべて `param` を持ち、`sunBody` は両方のツリーで主星（`massiveBodies[0]`）と同じになる」と理由を書く。`gravsim_calc.js:221` は `this.sunBody = this.massiveBodies.find(b => b.name === 'Sun') || (… massiveBodies[0] …)` で記述と一致し、行に `sunBody` が挙がったことで見直しの範囲に入った |
| G3-4-02 (4) main の恒星のボタン | ✓ 解消 | 設計書 §4.14-14 (a)（L573）は「恒星のボタンも、アプリの更新でカメラの対象が外れたこの経路では main と同じ例外になる。main が除去済みの天体の周りに置くのは、カメラがまだ除去済みの天体を指しているときだけ」、見直しの入力 H2-1（L84）は「（main も同じ。アプリの更新でカメラの対象が外れるため。main が除去済みの天体の周りに黙って置くのは、カメラがまだ除去済みの天体を指しているときだけで、本ブランチはそのときも §4.13-31 の生きている物体の規則で例外になる…）」と条件を書く。回帰 21 の補助 `userCenterWorld` の JSDoc（`regressions/21:197-203`）と D の G3-3-01 の 2 件目の注記（`:586-589`）も、補助がアプリの更新ループを通さないためカメラが破壊された Sun に残ること、アプリの更新では main も同じ例外であることを書く。掃引（`uc/`、`repro/`）の main の結果と一致する |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 置き換え・除去が利用者の天体に及ぶ | `_replaceCenterOfOtherKind` の呼び出し 5 箇所を、利用者が置いた中心 7 種 × 全 27 操作 × カメラ・フェード・保存と読込（2,268 通り）、印の列 3,768 通り、ツリーをまたぐ保存と読込（8 × 72 通り）で確かめた。追加の配置は、手で置いた Sgr A* を含む 7 種のすべてで main と同じ結果。自分の消去を持つプロファイルと銀河中心の古い中心の除去は Iteration 4 と同じ（main でも利用者の天体は消える） | 不要 |
| 役割を種類・名前で表す | プロファイルの中心の役割は印になり、種類による判定は残っていない（grep）。残る名前・種類の前提は、太陽系・恒星のボタンが名前 "Sun" で探す（H2-1）、Worker の `sunBody` を名前 'Sun' で選ぶ（H2-15）、同じ種類の中心を使い直す（§4.13-27 の仕様）で、いずれも見直しの入力に記録済みか設計どおり | 不要 |
| 保存に加えた項目の旧形式・不正値 | 本ブランチが保存に加えた 3 項目のうち、`isWorldCenter` は旧形式・不正値 8 種・中心が 2 つのファイルを回帰 17 W で、`hostAutoSelected` は項目のないファイルを回帰 17 で確かめる。`isProfileWorldCenter` は現行の形式での 7 種の値を回帰 21 E で確かめるが、旧形式（`isWorldCenter` のない）ファイルとの組み合わせは確かめていない（G3-5-01） | **要**（G3-5-01） |
| 主スレッドだけの項目の Worker への送信 | `add`・`update` のメッセージは項目を列挙して作り、印も `isWorldCenter` も含まない（`xsave/payload_*.txt`）。d2・s2 も一致 | 不要 |
| 等価な変異 | M08・M22・M29（印は常に真偽値）、Q17a（`worldCenter` は `true` だけ）、P09・Q19・Q20（Iteration 4 と同じ理由。呼ぶ箇所・規則に変更なし）の 7 件。M30・M31 は等価でない（G3-5-01） | 不要（G3-5-01 を除く） |
| 既存テストの期待値の変更 | 回帰 21 D の boundary（手で置いた Sgr A* の除去を期待値とした 1 件）を、Iteration 4 の修正方針どおり main と同じ結果を確かめる regression に置き換えた。`worldOf` に印を加えたため、A〜D の新しいページとの比較は印も比べる（強くなる方向）。ほかのテストの期待値・アサーションの変更はない | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件（grep） | 不要 |
| 中断しない経路への影響 | d2（35 構成）・s2（15 機）が変更前後で完全に一致。本ラウンドの本体の変更は配置の規則と保存の 1 項目だけ | 不要 |
| 見直しの入力 §3 の行 | H2-1 の追記と H2-15 の訂正を再現とコードで確認した。記録のない main と共通の現象は見つからなかった（空の世界・利用者の天体の世界での太陽系の例外と一時停止は H2-1 の範囲。Earth を Sgr A* の周りに置くと次のフレームで破片になるのは、利用者の配置の物理的な結果で main も同じ） | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-5-01 の修正の範囲**: 加えるテストが回帰 21 だけで M30 を検出すること、M31 の扱いを設計書に書いてそのとおりに固定することを確かめること。本体を変える場合は、本監査の `h/flag_seq.mjs`（3,768 列）・`h/uc_matrix.mjs`・`h/xsave.mjs` の結果と d2（`2e22aefa…`）・s2（`91c5b981…`）の一致を再確認すること。
2. **以前の版の保存**: Rev 6.12〜6.15 の版で保存した銀河中心の世界（`isWorldCenter` があり印がない）は、読込の後は印のない中心として扱われ、Clear Selected の後の Earth のボタンでは Earth が Sgr A* の周りに置かれて次のフレームで破片になり、太陽系は例外で一時停止のまま残る（main がそのファイルを読んだ場合と同じ。設計書 §4.14-14 (c) の判断）。工程 4 の手動確認で、工程 3 の途中で作った保存ファイルを使う場合はこれを新しい不具合と数えず、現行のツリーで保存し直すこと。
3. **見直しの入力の行番号**: §3 の行の行番号は記録した時点のツリーのもので、現行と合わないものがある（例: H2-1 の `gravsim_object_placer.js:264-266,289,322,343-344,373` は現行ツリーとも main とも合わない。現行では `placeAtOrbitAroundSun` の `:336`・`:359`・`:368`、`deployProfile` の `:394`）。見直しでは記号名で引くこと。
4. **計測の条件**: 本監査の間、本リポジトリと無関係な孤立した Node のテストプロセス（`/tmp/kogai-mutate-*`）が 14 本ほど CPU を使い続け、load average が 15〜24 だったため、所要時間は Iteration 4 より 1.5〜2 倍長い（system/02 55.4 s、08c 45.8 s）。工程 4 で 1 ファイル 60 秒の目安や `npm run perf:rollout` を測る場合は、それらが止まっていることを先に確かめること。
5. **補助の模擬 Worker のメモリ**: `scratchpad` の `h/harness.mjs`（回帰テストと同じ、同じプロセスで動く模擬 Worker）は、Worker から主スレッドへの応答を `setImmediate` に積むため、同期のループで多数の宇宙を作ると解放されずにメモリが増える（本監査で 1 プロセス 4.9 GB）。長い掃引は、列ごとに模擬 Worker を止めてイベントループに戻すか、プロセスを分けること。回帰 21 の G3-4-01 のテスト（160 通り）は 2 s・通常のメモリで終わる。
6. **引き続き有効な Watchpoint**: Iteration 4 の WP4（利用者が置いた中心の世界での太陽系の例外の後の一時停止。main と同じ）、WP3（カバレッジのファイル単位の揺れ。README に注記された）、Iteration 3 の WP5、Iteration 2 の WP4・WP7、Iteration 1 の WP4・WP5・WP7、lint 警告 54 件（既存の testsuites）。重い処理（全スイート・E2E・カバレッジ・変異の全スイート）を同時に走らせないこと。

---

## 独立監査3: テスト設計・実装監査 — Iteration 6

- **対象ゲート**: 独立監査3: テスト設計・実装監査
- **イテレーション番号**: Iteration 6
- **実施日時**: 2026-11-22 15:36〜16:04 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **PASS（文書指摘あり）**（【文書】Minor 1 件、【実装】0 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリーを、[`docs/development_process.md`](../development_process.md) §3.3・§3.4・§4、設計書 Rev 6.17（§4.14-14 (c)・§3.5-1 に、`isWorldCenter` のない旧形式のファイルでの役割の印 `isProfileWorldCenter` の読み方を追加）、テスト計画、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1〜5 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行はここで直す）は利用者の判断として扱い、その適用が正しいかを確かめた。

- **差分の特定**: Iteration 5 が監査したツリー（`scratchpad/gate3_it5/pristine`。`gate3_it5/md5_start.txt` の全 486 件と一致することを確認）と現行ツリーを `diff -rq` と行・行内の差分で比べた（`gate3_it6/diffs/`）。変わったのは、回帰 21（E の末尾に 1 件を追加。44 行の追加だけで、既存の行の変更・削除はない）、設計書（Rev 6.17。表題、冒頭の改訂履歴、§3.5-1 L296、§4 の見出し L334 と最終改訂 L336、§4.14 の見出し L539、§4.14-14 (c) L573）、テスト計画（表題の版、§4.1 L86・L97、§4.2 L108・L109、§4.3 L115-116、§4.7 の見出し L194 と 14 の行 L213）、`testsuites/README.md`（件数、回帰 21 の行、全体と 5 ファイルのカバレッジ）、本ファイル（Iteration 5 の追記だけ。md5 は Iteration 5 の監査の終了時の `gate3_it5/md5_end.txt` と同じ）。**`scripts/`・プリセット・設定・見直しの入力は Iteration 5 のツリーとバイト単位で同じ**（md5）で、追加・削除されたファイルはない。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate3_it6/md5_start.txt`、486 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 2,981 行は追記前（`review_before_append.md`、md5 `46ad149a…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 85 行）も変えていない。次のラウンドのために、監査開始時の作業ツリーの完全なコピーを `gate3_it6/pristine` に置いた（md5 の一致を確認）。
- **突然変異の方法**: すべて `gate3_it6/pristine` からの使い捨てのコピー上で、1 箇所ずつ文字列置換（一致数を検査）で不具合を入れ、その変更の対象のテストファイル（回帰 21。P17 は回帰 17）だけを実行した（`gate3_it6/mutrun.mjs`。Iteration 5 の `mutrun.mjs` とコピー元だけが違う。変異の並列 2）。本ラウンドの 12 件（`mut/mutants_it6.json`、N01〜N12）は、生き残ったものを `npm test` と同じ非 system の全 1,543 件でも実行した。Iteration 5 の 68 件（`mut/mutants_rerun.json`: M01〜M34・Q17a と Q02・Q07〜Q15・Q19〜Q21・P01〜P20）は対象のファイルだけで再実行した（本体と回帰 21 以外のテストファイルが変わっていないため、全スイートの結果は Iteration 5 と同じになる）。
- **補助エージェント**: 起動しなかった。本ラウンドの差分はテスト 1 件と文書の記述で、すべて本監査が読み、変異と掃引で確かめた。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB（IDE が約 3 GB を使用）。監査の開始前から、本リポジトリと無関係な孤立した Node のテストプロセス（`tests/lib.test.js`、cwd は `/tmp/kogai-mutate-*`、各 93% 前後の CPU）が 14 本動いており、load average は全工程を通じて 15.4〜24.3 だった（本監査のプロセスではないため停止していない。`foreign_procs_1.txt`）。機械的チェック、ファイルごとの単独実行、中断しない経路の一致、旧形式のファイルの掃引、変異を、この順に 1 つずつ実行した。機械的チェックの各段の開始前の空きメモリは 4.8 GB 前後（テストの実行中は 3.3 GB 前後）、掃引の 1 プロセスの最大 RSS は約 200 MB で、空きメモリの監視（`watchdog.sh`、900 MB 未満で本監査のプロセスを止める）は一度も作動しなかった。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate3_it6/`）: `progress.log`（経過）、`run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 3 回・カバレッジ）、`timing/`（ファイルごとの単独実行）、`ident/`（中断しない経路の一致）、`run_seq.sh`（以降の段の順次実行）、`h/`（`harness.mjs`・`legacy_probe.mjs` は Iteration 5 の `h/` の複写、`legacy_sweep.mjs`・`legacy_analyze.py`・`legacy_camera.mjs` は本監査で追加）、`probe/`（旧形式のファイルの掃引の出力と解析）、`mut/`（変異）、`diffs/`（差分）、`pristine/`（監査開始時の作業ツリーの完全なコピー）。

**機械的チェック・テスト実行結果**:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（7.7 s）。Lint はエラー 0／警告 54（全件が既存の 16 テストファイルで、Iteration 5 と同じ。本ラウンドで変更した回帰 21 は 0 件）。型は TypeScript 7.0.2 でエラー 0 |
| 全テスト | `npm test` | **1,584/1,584 pass**・fail 0・cancelled 0・skipped 0・todo 0（275 スイート）、96.9 s（load average 15.8 → 23.7、空きメモリ 4.8 GB） |
| E2E 1〜3 回目 | `npm run test:system` × 3 | 3 回とも **41/41 pass**・skipped 0・cancelled 0（76.4 s・77.1 s・78.8 s）。`npm test` の中の 1 回と合わせて 4 回、失敗なし。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0 |
| カバレッジ | `npm run test:coverage` | 1,584 pass（164.8 s）。**行 99.36%・分岐 93.06%・関数 97.34%**（README・テスト計画は 99.36%・93.03%・97.34%。差 0.03 ポイントは README が書く全体の揺れ（0.05 ポイント程度）の範囲内）。ファイル単位では README の 42 行のうち 37 行が一致し、違う 5 行はすべて分岐（`gravsim_calc_object.js` 94.61%／README 94.49%、`gravsim_rocket_launcher.js` 82.55%／82.30%、`gravsim_tab_rocket.js` 87.99%／88.19%、`gravsim_trajectory_predictor.js` 94.46%／94.00%、`gravsim_universe.js` 96.69%／97.50%。最大 0.81 ポイントで、README の「最大 1 ポイントほど」の範囲内）。本体は Iteration 5 と同じで、本ラウンドで README が書き換えた 5 行（`gravsim_calc.js` 95.76% など）も同じ揺れの範囲 |
| ファイルごとの単独実行 | `node --test <file>`（全 53 ファイルを作業ツリーの複製 `timing_tree` で順に） | 全ファイル成功・skip 0。件数は regressions 455・unit 836・integration 252・system 41（計 1,584。README・テスト計画 §4.1 と一致し、README §2-D の件数のある 31 行もすべて一致）。Iteration 5 との違いは回帰 21 の 23 → 24 だけ。最長は system/02 57.0 s、system/05 55.5 s、system/04 51.9 s、regressions/08c 46.9 s、system/01 46.1 s で、すべて 60 s の目安以内（load average 15.6〜21.3 の下）。回帰 21 は 1.9 s。`timing_tree` の md5 は実行の前後で変わらない |
| 中断しない経路の一致 | `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）、`gate2_it2/s2_flights.mjs`（cwd = リポジトリ、`GS_ROOT` = 各ツリー、1 本ずつ順に） | Iteration 5 のツリーと現行ツリーで**完全に一致**: d2 `2e22aefa3a20913ea507399278276b26`（51.4 s・51.6 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（14.5 s・14.2 s）。両ツリーとも期待値と同じ |
| 本ラウンドの変異 | `mut/`（80 件、対象ファイルのみ） | 本ラウンドの 12 件のうち 10 件を回帰 21 だけで検出（M30・M31 と同じ置換の N01・N02 を含む）。残る 2 件のうち N08 は全スイートで回帰 17 が検出し、N11（形式による分岐を加える高次の変異）は全スイートを通過（下記 5）。Iteration 5 の 68 件の再実行では、検出が 59 件から 61 件に増え（M30・M31 が回帰 21 だけで検出に変わった）、生き残る 7 件は Iteration 5 で等価とした M08・M22・M29・Q17a・Q19・Q20・P09 と同じ。結果が変わったのは M30・M31 だけ |

**Iteration 5 の【実装】指摘の解消確認**（G3-5-01）:

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-5-01 旧形式のファイルでの印の読込 | ✓ 解消 | (1) 設計書: §3.5-1（L296）は「読込は天体ごとに、`isWorldCenter` の有無によらず、厳密に `true` のときだけ真…`isWorldCenter` の旧形式の規則（id 0 の天体を中心とする）は変えず、その中心の印もファイルの値（ないときは偽）のままとする（Rev 6.17、G3-5-01）」、§4.14-14 (c)（L573）は「`isWorldCenter` のない旧形式のファイルでは id 0 の天体が中心になり（§4.13-27）、その天体の印が真のときだけプロファイルの中心とする（印のある旧形式のファイルは main も本ブランチも書かず、手で作ったファイルだけ）」と定め、Iteration 5 で決まらなかった 2 点（旧形式の中心に印を付けるか＝M30、`isWorldCenter` のない天体の印を読むか＝M31）を、現行のコード（`gravsim_object_manager.js:746` の 1 つの式を天体ごとに、`:757-760` の規則は `isWorldCenter` だけを設定）と同じ動作に一意に決めた。(2) テスト: 回帰 21 E の新しい 1 件（`regressions/21_world_center_profiles.test.mjs:867-909`）は、どの天体にも `isWorldCenter` がない（入力で確認）id 0 だけのファイルを新しいページで読み（`loadInto`、`Universe.loadState`）、`param` を持つ Jupiter（印なし）・Sgr A*（印なし）・Sgr A*（印 `true`）× Sun のボタン・太陽系の 6 通りで、読込の直後の中心を `[id, name, isWorldCenter, isProfileWorldCenter] = [0, 名前, true, 印が true か]` で固定し、印のない中心は Sun のボタンで残って新しいページの Sun（中心でない）が横に加わり、太陽系は "Sun object not found in the universe." で何も変えず、印が真の Sgr A* は Sun のボタンで新しいページと同じ世界に、太陽系で除去されて Sun が中心になることを確かめる。(3) 変異: M30（N01）・M31（N02）は回帰 21 だけの実行で、それぞれ新しい 1 件だけが失敗して検出された（24 件中 1 件、各 3 s）。旧形式の中心の印を偽に固定する・種類で決める・反転する（N03〜N05）、旧形式の規則を無効にする（N07）、id 0 で `isWorldCenter` のない天体に印を付ける（N09）、旧形式でだけ「ないときに真」・生の値にする（N10・N12）も回帰 21 だけで検出した。(4) テスト計画 §4.2（L109）・§4.7 の 14 の行（L213、D（7）・E（6）。数えて一致）と README の回帰 21 の行（L116、24 件）が更新された。(5) 旧形式のファイルの掃引（下記 6）で、Sun のボタン・太陽系・Clear Selected → Sun のボタンの結果は印のないファイルで main と 225 通りすべて同じで、テストの「as on main」の期待値と一致する |

**本ラウンドの変更の検証**（全行を読み、変異と掃引で確かめた）:

1. **本体**: `scripts/`・`presets/`・設定は Iteration 5 のツリーとバイト単位で同じ（md5）。アプリの動作は Iteration 5 の監査が確かめたものから変わらず、中断しない経路の d2・s2 も一致した（上表）。
2. **追加したテスト**（`regressions/21:867-909`）: ファイルは `legacyFile` が `presetManager.getObjectParam` の値から id 0 の天体 1 つだけで作り、印は `undefined` のとき項目自体を置かない（`'isWorldCenter' in o` が偽であることも入力として検査）。各通りの最後に `EventBus.clearAll()`、`newUniverse` が id のカウンタを 0 に戻すため、通りの間と他のテストとの間で状態は持ち越さない（単独実行・`npm test`・カバレッジ付きの実行のいずれでも成功）。期待値は新しいページの同じ操作（`freshButton('Sun')`）と、読込の直後の世界（`worldOf`。Worker の半径・質量・`param` も比べる）から作り、太陽系の例外はメッセージまで比べる。最初の `deepEqual` が読込の結果を固定するため、印の読み方を変える変異はボタンの経路によらずここで失敗する。Lint の警告は 0 件。
3. **設計書 Rev 6.17**: 表題（L1）、冒頭の改訂履歴（L3「Rev 6.17（独立監査3 Iteration 5 の指摘 G3-5-01〜G3-5-02 を反映…）: 2026-11-22 15:29 JST」）、§4 の見出し（L334、Iteration 5 の指摘（G3-5-01〜G3-5-02、Rev 6.17）を追加）と最終改訂（L336「Rev 6.2〜6.17…最終改訂: Rev 6.17、2026-11-22 15:29 JST」）、§4.14 の見出し（L539「Rev 6.16・6.17 で 14 を改訂」）は互いに一致する。§4.14-14 (c) に加わった「印は世界の中心でだけ読むため、中心でない天体の印は効果がない」は、印を読むのが `_replaceCenterOfOtherKind` の中心（`gravsim_object_placer.js:115`）だけで、置き換えには中心のほかに生きている天体がないことが要る（`:116-117`）ことと一致する。`isWorldCenter` を設定するのは 5 箇所（`gravsim_object_placer.js:123`・`:272`・`:444`、`gravsim_object_manager.js:741`・`:759`）だけで、中心でない天体が後から中心になるのは、ファイルが複数の中心を名指しした場合（`getWorldCenter` は最初の生きている中心。回帰 17 の boundary）だけで、そのときその天体はファイルが名指しした中心である。「印のある旧形式のファイルは main も本ブランチも書かない」は、保存がすべての天体に `isWorldCenter` と印を一緒に書くこと（`gravsim_object_manager.js:641`・`:644`）、main はどちらも書かず、Rev 6.12〜6.15 は `isWorldCenter` だけを書いたことと一致する。
4. **テスト計画・README**: §4.1（L86 の 332 + 1,252 = 1,584、Iteration 5 の指摘への対応で 1 件。L97 の回帰 21 は 24）、§4.2 の新しい項目（L109。上の変異の結果と一致）、§4.3（L115-116 の 1,584 件・カバレッジ）、§4.7 の見出し（L194、Rev 6.13〜6.17）と 14 の行（L213）、README（L16 の 455、L116、L144・L191-200 の 1,584、L217・L268 の分岐 93.03%）は実行の結果と一致する。§4.2 の Iteration 4 の対応の項目（L108）の件数だけが合わない（G3-6-01）。
5. **変異**（`mut/`）: 本ラウンドの 12 件のうち、N01〜N07・N09・N10・N12 の 10 件を回帰 21 だけで検出した（各 2〜3 s。N06（現行の形式のファイルで印を読まない）は新しい 1 件ではなく既存の D・E の 3 件で、N07（旧形式の規則を無効にする）は新しい 1 件と既存の C の 1 件で失敗し、ほかの 8 件は新しい 1 件だけが失敗する）。N08（旧形式の規則で id 0 の代わりに最初の天体を中心にする）は、回帰 21 のファイルが天体 1 つだけのため回帰 21 では同じ結果になる（探索のための変異）が、全スイートでは回帰 17 W4 の「id 0 のないファイルは中心なし」と回帰 16・17 の走査で検出された（§4.13-27 の規則は回帰 17 の担当で、本ラウンドの変更ではない）。N11（`isWorldCenter` のない天体でだけ印を `Boolean()` で読む）は全スイートを通過した: 旧形式のファイルで印が `1`・`"true"`・`{}`・`[true]` の id 0 の中心がプロファイルの中心になり、設計書の「`isWorldCenter` の有無によらず、厳密に `true`」と違う。ただし現行のコードは印をすべての天体に同じ 1 つの式で読み（`:746`）、N11 は形式による分岐を新たに書き加える高次の変異（2 つの変更の組み合わせ）で、単一の変更の変異（形式に依存させる M31・N06 と、緩める M25〜M27・M32）はそれぞれ検出される。このため指摘とせず、次工程の注意点に記録した（§4 の 2）。Iteration 5 の 68 件の再実行は、M30・M31 が「生き残り」から「検出」に変わった（新しい 1 件だけが失敗）ほかは Iteration 5 と同じ結果で（検出 61、生き残り 7 件はすべて Iteration 5 で等価とした変異）、既存のテストの検出力は落ちていない。
6. **旧形式のファイルの掃引**（`h/legacy_sweep.mjs`・`legacy_analyze.py`、`probe/analysis.txt`）: どの天体にも `isWorldCenter` がないファイルを、id 0 の天体 5 種（Sun、Jupiter、Sgr A*、Sirius、`param` のない Jupiter）× 印 6 種（ない、`true`、`false`、`1`、`"true"`、`null`）× ほかの天体 3 種（なし、印 `true` の Sgr A*（id 1）、Earth（id 1））で作り、読込の後に 7 つの操作（Sun・Earth・Sirius のボタン、太陽系、連星、銀河中心、Clear Selected → Sun のボタン）をした 630 通りを、現行ツリー・Iteration 5 のツリー・main で実行した。現行ツリーと Iteration 5 のツリーの出力は全項目で同じ。現行ツリーでは 630 通りすべてで id 0 が中心になり、印は `true` のときだけ真（真偽値でない値は偽）、id 1 の印は真として読まれるが中心でないため効果がない。加える配置（ボタン 3 つと太陽系、Clear Selected → Sun のボタン）の 450 通りで、id 0 の天体が置き換わるのは、印が `true`・ほかに天体がない（Clear Selected の後を含む）・別の種類・`param` がある場合だけだった（規則と違う結果は 0 件）。印のないファイルでの Sun のボタン・太陽系・Clear Selected → Sun のボタンの 225 通りは、例外・一時停止・一覧（中心の印を除く）が main と完全に同じ。Earth・Sirius のボタンは 150 通りのうち 120 通りで main と違ったが、これは補助がアプリの更新を通さないため、読込の後もカメラがページの最初の（読込で除去された）Sun を指したままになるためで（main は除去済みの天体の周りに置き、本ブランチは §4.13-31 の生きている物体の規則に従う。設計書 §4.14-14 (a) が書く条件）、読込の後にアプリの更新を 2 フレーム通すと（カメラが読み込んだ天体に移る）、Jupiter・Sgr A*・Sirius の 3 種 × Earth・Sirius・Sun のボタンの 9 通りすべてで main と同じになった（`h/legacy_camera.mjs`、`probe/camera_cur.txt`・`camera_main.txt`）。

本ラウンドで直したとされる G3-5-01 は直っており、本体は変わらず、テストの追加で既存の検出力は落ちていない。G3-5-02 の 2 点は直ったが、その修正で、テスト計画 §4.2 の件数と内訳が合わなくなった（G3-6-01）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G3-6-01 [Minor]【文書】 テスト計画 §4.2 の Iteration 4 の指摘への対応の項目で、変異の件数と内訳が合わない
- **箇所**: [`2026-11-20_trajectory_fx_flightplan_test_plan.md`](../design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §4.2 の「独立監査3 Iteration 4 の指摘（G3-4-01）への対応」の項目（L108）
- **現象**: 「役割の印 `isProfileWorldCenter`（§4.14-14）の変異 31 件のうち 24 件（…）を回帰 21 だけで検出した。残る 7 件は等価: 印は真偽値だけを持つため `!flag`・`typeof === 'boolean'` の読込・生の値の保存は同じ結果になる 3 件と、Iteration 3・4 の監査が等価とした Q19・Q20・P09（規則の変更の後も同じ理由で等価）。Q17 の対象（`_profileCenterKinds`）は削除したため、Iteration 5 の監査は残る `deployProfile` の `worldCenter` の読み取りに当てて等価（Q17a）とした。」と書く。G3-5-02 (2) の修正で内訳から Q17 を除いたため、「残る 7 件」の内訳は 3 件 + 3 件 = 6 件になり、7 件目が何かが読み取れない（Q17a は Iteration 5 の監査が当てた変異で、作業者の 31 件には入らない）。修正前（`gate3_it5/pristine` の同じ行）は「3 件と、…Q17・Q19・Q20・P09」で 7 件だった。あわせて、同じ文の括弧内の「24 件」の列挙は 23 項目で、どれが 2 件に当たるかも読み取れない（Iteration 5 の時点から同じ）。
- **影響**: 変異による有効性の確認の記録で、実行した件数・検出した件数・等価とした件数の関係が読み手に検証できない。テスト・実装には影響しない（本監査の再実行で、Q17a を含む Iteration 5 の 68 件の結果は Iteration 5 と同じ。上記 5）。
- **修正方針**: 31 件の内訳を ID か項目で数が合うように書く。例えば、Q17 を 31 件に数えていたなら「Q17 は対象の `_profileCenterKinds` を削除したため当てられない（Iteration 5 の監査が `deployProfile` の `centerDef` に移した Q17a は等価）」として「実行した 30 件のうち 24 件を検出、6 件は等価」のように件数を直し、括弧内の列挙も 24 項目にする（または「主なもの」と書く）。
- **分類**: 【文書】。テスト計画の記述の訂正だけで、実装・テストの変更を必要とせず、設計書の要求も満たされる。

---

### 2. 前イテレーションの文書指摘の解消確認

独立監査3 Iteration 5 の文書指摘 G3-5-02 を、テスト計画・README と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-5-02 (1) §4.3 の E2E 03 の失敗の記述 | ✓ 解消 | テスト計画 L115 は「1,584 件、cancelled 0、skip 0（2026-11-22、独立監査3 Iteration 5 の指摘への対応の後）。2026-11-21 の 1,533 件の実行（独立監査3 Iteration 2 の前）では、1 回目に E2E 03 の 1 件が大気の上限の直下の標本で失敗した（…H1-14 に記録）。修正後、…すべて成功」で、失敗が起きた時点（1,533 件の実行）の記述になり、最新の実行が失敗したようには読めない。`gate3_it2/pristine` の同じ行（1,533 件の時点）と一致する |
| G3-5-02 (2) §4.2 の Q17 | ✓ 解消（ただし件数の不整合が新たに生じた → G3-6-01） | テスト計画 L108 は「Q17 の対象（`_profileCenterKinds`）は削除したため、Iteration 5 の監査は残る `deployProfile` の `worldCenter` の読み取りに当てて等価（Q17a）とした」と書き、Q17 がその形では存在しないこと、Q17a が `centerDef` の読み取り（`gravsim_object_placer.js:404`）に移したものであることが記録された。L109 には G3-5-01 の修正で加えたテストが M30・M31 を検出したことも書かれた（修正方針の「G3-5-01 の修正で加える変異も合わせて書く」）。ただし内訳から Q17 を除いたことで「残る 7 件」と内訳（6 件）が合わなくなった（G3-6-01） |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 保存に加えた項目の旧形式・不正値 | 本ブランチが保存に加えた 3 項目のうち、`isWorldCenter` は旧形式・不正値 8 種・id 0 のないファイル・中心が 2 つのファイルを回帰 17 W・W4 で、`hostAutoSelected` は項目のないファイルを回帰 17 で、`isProfileWorldCenter` は現行の形式での 7 種の値を回帰 21 E の abnormal で、旧形式（`isWorldCenter` のない）ファイルでの「ない」と `true` を本ラウンドの 1 件で確かめる。旧形式の掃引（630 通り）で、設計書 §3.5-1・§4.14-14 (c) と違う結果はなかった | 不要 |
| 読込の厳密さが形式によって分かれる | 印の読込はすべての天体に同じ 1 つの式（`gravsim_object_manager.js:746`）で、形式による分岐はない。分岐を加えて緩める高次の変異 N11 は全スイートを通過するが、単一の変更の変異（形式への依存 M31・N06、緩める M25〜M27・M32）はすべて検出される | 不要（§4 の 2 に記録） |
| 等価な変異 | 生き残る 7 件（M08・M22・M29・Q17a・Q19・Q20・P09）は Iteration 5 と同じで、本体と回帰 21 以外のテストが変わっていないため、等価の理由も同じ。本ラウンドの N08 は回帰 21 の固定のファイルでは同じ結果になる探索用の変異で、全スイートで回帰 17 が検出する | 不要 |
| 既存テストの期待値の変更 | 回帰 21 の差分は E の末尾への 44 行の追加だけで、既存のテストの期待値・アサーションの変更はない（行の差分で確認） | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件（grep） | 不要 |
| 中断しない経路への影響 | 本体は変わらず、d2（35 構成）・s2（15 機）が Iteration 5 のツリーと完全に一致 | 不要 |
| 見直しの入力 §3 の行 | 本ラウンドで変更なし（md5）。新しいテストが main と同じとして期待する太陽系の例外は H2-1 に記録済み。掃引で見た Earth・Sirius のボタンの main との違い（カメラが除去済みの天体を指すときだけ）は §4.13-31 で直した main の不具合で、設計書 §4.14-14 (a)・H2-1 に条件が書かれている。記録のない main と共通の現象は見つからなかった | 不要 |
| 文書の版・件数の表記 | 設計書の表題・改訂履歴・§4 の見出しと最終改訂・§4.14 の見出しは Rev 6.17（15:29 JST）で一致。テスト計画 §4.1・§4.3・§4.7 と README の件数・カバレッジは実行の結果と一致。§4.2 L108 の件数だけが合わない | **要**（G3-6-01） |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G3-6-01 の修正**: 工程 4 と並行してテスト計画 §4.2 L108 の件数と内訳を直し、§4 の 5 の 3 により設計書の改訂履歴に指摘 ID と修正内容を記録すること（テスト計画には改訂履歴がない）。確認は独立監査4 で行う。
2. **旧形式のファイルの読み方を分けるとき**: 印の読込は現在、形式によらず天体ごとに同じ式で、旧形式のファイルでの真偽値でない印（`1`・`"true"` など）は現行の形式での値のテスト（回帰 21 E の abnormal）を通して間接に固定されているだけである（変異 N11 が全スイートを通過）。構造の見直しで保存の形式・移行の処理を作り直し、旧形式の読込を別の経路にする場合は、その経路で設計書 §3.5-1 の「`isWorldCenter` の有無によらず、厳密に `true`」を確かめるテスト（旧形式 × 不正値）を加えること。同様に、旧形式の規則（id 0 を中心にする）の「id 0 のないファイルは中心なし」は回帰 17 W4 だけが確かめる（回帰 21 の旧形式のファイルは天体 1 つだけ）。
3. **補助でカメラが除去済みの天体に残る**: アプリの更新ループを通さない補助（`h/harness.mjs`、回帰 21 の `loadInto` など）では、読込の後もカメラがページの最初の Sun（読込で除去済み）を指したままで、Earth・恒星のボタンの結果が main と違って見える（main は除去済みの天体の周りに置く）。main との比較では、回帰 21 の `appUserCenterWorld` のようにアプリの更新を通すこと。工程 4 の手動確認（実際のアプリ）では更新ループが動くため、この違いは現れない。
4. **以前の版の保存**（Iteration 5 の WP2、引き続き有効）: Rev 6.12〜6.15 の版で保存した銀河中心の世界は、読込の後は印のない中心として扱われる（main がそのファイルを読んだ場合と同じ）。工程 4 の手動確認で工程 3 の途中の保存ファイルを使う場合は、現行のツリーで保存し直すこと。
5. **計測の条件**: 本監査の間も、本リポジトリと無関係な孤立した Node のテストプロセス（`/tmp/kogai-mutate-*`）が 14 本 CPU を使い続け、load average が 15〜24 だった（system/02 57.0 s、08c 46.9 s。Iteration 5 とほぼ同じ）。工程 4 で 1 ファイル 60 秒の目安や `npm run perf:rollout` を測る場合は、それらが止まっていることを先に確かめること。
6. **引き続き有効な Watchpoint**: Iteration 5 の WP3（見直しの入力の行番号は記号名で引く）・WP5（補助の模擬 Worker のメモリ。本監査の掃引は 1 通りごとに Worker を止めてイベントループに戻し、1 プロセス約 200 MB だった）、Iteration 4 の WP3・WP4、Iteration 3 の WP5、Iteration 2 の WP4・WP7、Iteration 1 の WP4・WP5・WP7、lint 警告 54 件（既存の testsuites）。重い処理（全スイート・E2E・カバレッジ・変異の全スイート）を同時に走らせないこと。

---

## 独立監査4: 最終総合監査 — Iteration 1

- **対象ゲート**: 独立監査4: 最終総合監査
- **イテレーション番号**: Iteration 1
- **実施日時**: 2026-11-23 05:48〜06:12 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **FAIL**（【実装】Minor 2 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（HEAD `0e453a8` = `main`）を、[`docs/development_process.md`](../development_process.md) §2・§3.4・§4、設計書 Rev 6.19（§4.12 に計測の分割実行を追加）、テスト計画（§5 を作業者の申告として扱う）、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査3 Iteration 1〜6 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行と、利用者が範囲に加えた設計書 §4.13 の既存の不具合は本ブランチで直す）は利用者の判断として扱い、その適用を確かめた。

- **差分の特定**: Iteration 6 が監査したツリー（`scratchpad/gate3_it6/pristine`。`gate3_it6/md5_start.txt` の 486 件と一致することを確認）と現行ツリーを `diff -rq` と行・行内の差分で比べた（`gate4_it1/diffs/`）。Iteration 6 の終了時（`gate3_it6/md5_end.txt`）から変わったのは、設計書（Rev 6.19: 表題 L1、冒頭の改訂履歴 L3 の Rev 6.18・6.19、§4 の見出し L334、最終改訂 L336、§4.12 の見出し L462、分割実行の項目 L478 の追加）、テスト計画（対象の版 L3、§4.1 L86・L98、§4.2 L108、§5 L215-227 の新設）、`testsuites/README.md`（unit の件数 862、unit 11 の行 L97、分割実行の項目 L131、全体 1,610 件・281 スイート、カバレッジの値）、`testsuites/perf/rollout_timing.mjs`（分割実行の追加。`runChild`・`measure` は変更なし）、新しい `testsuites/unit/11_perf_rollout_timing.test.mjs`（26 件）だけである。本ファイルは Iteration 6 の追記の後の md5（`b7bae1a4…`）のまま。**`scripts/`・`presets/`・設定・ほかのテスト・見直しの入力は Iteration 6 のツリーとバイト単位で同じ**（md5）。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate4_it1/md5_start.txt`、487 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 3,076 行は追記前（`review_before_append.md`、md5 `b7bae1a4…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 86 行）も変えていない。監査開始時の作業ツリーの完全なコピーを `gate4_it1/pristine` に置いた。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB。開始時の load average は 0.22 で、別のプロジェクトの重いプロセスは動いていなかった（`procs_start.txt`）。重い処理（機械的チェック、`npm test`、E2E、カバレッジ、d2、s2、E2E の 2 回目）は 1 本のスクリプト（`run_checks.sh`）で順に実行し、各段の後の load average・空きメモリ・残留物を `checks/status` に記録した（load average は本監査の `npm test` の並列実行で最大 10.7、空きメモリは 4.86 GB を下回らなかった）。同期ブロック時間は再計測していない（静かなマシンで約 70 分を要するため。保存した回の評価と、ハーネスを使わない独立な再計算で確かめた。下記 1）。
- **補助エージェント**: 起動しなかった。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate4_it1/`）: `run_checks.sh`・`checks/`（機械的チェック・テスト・E2E 2 回・カバレッジ・d2・s2 と `status`）、`perf_state_copy.json`・`perf_eval.out`（保存した回の評価）、`indep_stats.py`・`indep_fp.py`（統計量と指紋の独立な再計算）、`main_archive/`（`git archive 0e453a8`）、`main_lint/`・`main_lint.log`（main の Lint）、`mut/`（計測スクリプトの変異。`run_mut.py`・`results.json`）、`unit11.log`、`diffs/`、`pristine/`。

**機械的チェック・テスト実行結果**（テスト計画 §5 と比較）:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（4.4 s）。Lint はエラー 0／警告 54（§5 と同じ）。警告はすべて既存の testsuites の 16 ファイル（テスト 15 ファイルと `test_helpers.mjs`）で、`perf/rollout_timing.mjs`・`unit/11` は 0 件。同じ設定で main（`git archive 0e453a8`）を Lint するとエラー 2／警告 58 で、本ブランチは警告を増やしていない（`scripts/` の警告 4 件とエラー 2 件が消え、変更したテストファイルの警告は main と同じ）。型は TypeScript 7.0.2 でエラー 0 |
| 全テスト | `npm test` | **1,610/1,610 pass**・fail 0・cancelled 0・skipped 0・todo 0（281 スイート）、66.1 s（load average 0.28 → 10.7）。§5 と一致 |
| E2E | `npm run test:system` × 2 | 2 回とも **41/41 pass**・skipped 0・cancelled 0（49.2 s・49.3 s）。各回の前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0（`npm test` の中の 1 回と合わせて 3 回、失敗なし） |
| カバレッジ | `npm run test:coverage` | 1,610 pass（102.1 s）。**行 99.36%・分岐 93.02%・関数 97.34%**（§5 は分岐 92.97%。差 0.05 ポイントは §5・README が書く揺れ（0.1 ポイント程度）の範囲内）。最低 90% を満たす。README のファイルごとの表（43 行）は作業者の工程 4 の実行（`phase4/coverage2.log`）と全行一致 |
| 計測スクリプトの単体テスト | `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` | 26/26 pass（6 スイート、0.45 s）。一時ディレクトリ（`/tmp/rollout-timing-unit-*`）は残らない |
| 中断しない経路の一致 | 作業領域の `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）・`gate2_it2/s2_flights.mjs`（`GS_ROOT` = 作業ツリー） | **一致**: d2 `2e22aefa3a20913ea507399278276b26`（27.7 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（7.7 s）。stderr は空 |
| 同期ブロック時間（評価のみ） | `phase4/perf_state.json` のコピー（md5 `db6c2be3…`）に `--baseline phase4/main_tree --max-rounds 0` | 終了コード 0、計測なし（0.05 s）。指紋の照合を通ったため、現行のツリー・main のツリー・計測コードは保存した回を測ったときと同じ。5 ワールドの出力は §5 の値と全項目一致（下記 1） |

`skip`・`todo`・`.only`・`assert.ok(true)` は `testsuites/` 全体で 0 件（grep）。`unit/11` に条件付きのアサーションはない。作業者の `phase4/` のログ（`check2.log`・`test2.log`・`sys1〜3.log`・`coverage2.log`・`d2.log`・`s2.log`・`perf_run1_load.log`・`perf_run2.log`・`perf3_a1.log`・`perf_split.log`・`perf_final.log`）の値は、§5 の転記と一致する。

**本ラウンドの変更と工程 4 の結果の検証**:

1. **同期ブロック時間の結果（テスト計画 §5 L227）**:
   - main のツリー: `phase4/main_tree` は、本監査が新しく作った `git archive 0e453a8`（444 ファイル）と `diff -r` で同一。
   - 指紋: 同じ規則の独自の実装（`indep_fp.py`）で、現行ツリー・Iteration 6 のツリー・監査開始時のコピーが `d07b6077…`、`phase4/main_tree` が `a0ee7d59…`（どちらも 106 ファイル）で、状態ファイルの値と一致する。計測コードの指紋 `a06e9e63…` は現行の `rollout_timing.mjs` が受理した。`rollout_timing.mjs` の最終更新（11-22 19:48:55）は最初の分割実行（19:59:36）より前で、`scripts/`・`presets/` の最終更新は 11-22 14:17。各実行は開始時に指紋を照合するため、21 回とも同じコードで測った。
   - 保存した回: Sun+Earth・7 天体が各 6 回、`SOLAR_SYSTEM`・`BINARY_SYSTEM`・`THREE_BODY` が各 3 回の計 21 回。どの回も両ツリーが同じ 124 構成を持ち、先後は回の番号どおりに交互（偶数回は本ブランチが先）。load average の標本 42 個は 0.17〜1.81 で、全回が 2.0 以下。`phase4/status` では 21 回の実行がそれぞれ 1 回ずつ測り（20 回が終了コード 3、最後が 0）、最後の評価も終了コード 0。
   - 統計量の独立な再計算（`indep_stats.py`。ハーネスを使わない）: 最大比〔構成〕／余裕／変動（全回・前半・後半）は、Sun+Earth 1.3281〔`lunar_insertion` 0.2 ヶ月・0°〕／0.1719／0.0619（1.3281・1.2806・1.3425）、7 天体 1.2444〔`leo_250km` 0.2 ヶ月・270°〕／0.2556／0.0159、`SOLAR_SYSTEM` 1.2218〔`iss_rendezvous` 0.2 ヶ月・180°〕／0.2782／0.0106、`BINARY_SYSTEM` 1.2537〔`lunar_insertion` 0.2 ヶ月・90°〕／0.2463／0.0078、`THREE_BODY` 1.2532〔同〕／0.2468／0.0147。受入基準 2 は Sun+Earth 695.6 ms・7 天体 1,098.4 ms（`lunar_insertion` 1 ヶ月・0°）、`SOLAR_SYSTEM` 3,074.0 ms。§5 の値と一致し、5 ワールドとも受入基準 1・2 と負荷の条件を満たす。
   - 先立つ一括実行 3 回の値（`perf_run1_load.log`・`perf_run2.log`・`perf3_a1.log`）も §5 の記述（最大比 1.23〜1.31、Sun+Earth 711〜712 ms、7 天体 1,130〜1,155 ms、1 回目の `THREE_BODY` の変動 0.302 > 余裕 0.257）と一致する。捨てた実行も 1 回目の `THREE_BODY` を除いて受入基準 1・2 を満たしており、よい結果の回を選んだ形跡はない。
   - 注記: 負荷の標本は各ツリーの計測の直前だけでとる（§4.12 の方法。Rev 6.19 で変わらない）。`perf_split.log` の回の終わりの load average は Sun+Earth の 5 回目が 2.40、7 天体の 4 回目が 3.16 で、計測の途中で別の処理が始まった回がある（記録された標本はどちらも 2.0 以下）。仮にこの 2 回を高負荷と数えても、負荷の条件（6 回中 5 回）は満たし、最小値による統計量は除外しない規則のもとで同じである。
2. **計測スクリプトの分割実行（設計書 §4.12 L478）**: 全行を読んだ。
   - 定義どおりの方法との同等性: `runChild`・`measure`（構成・経路・計測）は Iteration 6 のツリーから変わっていない（差分）。回の中で本ブランチと main を続けて測り、先後を回の番号で入れ替える（`roundOrder(r)`、`r = rounds.length`）ため、回を別の実行に分けても、回数・順序・負荷の記録・統計量（全回・前半 floor(n/2) 回・後半）・余裕・受入基準の定義は分けない場合と同じ。`--state` なしでは `maxTotal = required` で、規定の回数だけを測る（従来と同じ）。負荷の条件を満たさないときに回を足す規則は設計書の「足した回も上の回数の規定の『以上』に含まれる」と一致し、足すかどうかは負荷だけで決まり測った値に依らないため、統計量に偏りを入れない。
   - 指紋の範囲: 計測される値を決めるのは各ツリーの `scripts/`・`presets/`（`measure` が cwd を各ツリーにし、`PresetManager` は `process.cwd()` から読む）・`testsuites/test_helpers.mjs`（`../scripts/gravsim_event_bus.js` だけを読み込む）で、`treeFingerprint` はこれらの相対パスと内容を覆う。計測コードの指紋は `runChild`・`measure` のソースと構成（`MISSIONS`・`NEAR`・`MO`）を覆う（ただしテストがない。G4-1-01 の 2）。Node の版は覆わない（§4 の 4）。
   - 端の場合: 状態ファイルの指紋・版・方位の不一致と `worlds` の欠落・型違いは終了コード 2（テストあり）、JSON でないファイルも `loadState` の例外が終了コード 2 になる（テストなし。G4-1-01）。`--max-total` が規定回数より小さい値は規定回数に丸め、`--max-rounds 0` は評価だけ。`--max-rounds` に数でない値・値のない指定を渡すと上限なし（全回を測る）になる（§4 の 4）。
   - 変異（`mut/run_mut.py`。`gate4_it1/pristine` から作ったコピーに 1 箇所ずつ入れ、`unit/11` だけを実行。変異なしのコピーは成功）: 21 件のうち検出 8 件（`--max-rounds` の無視、版の照合の削除、受入基準 2 の除外の位置、`worlds` の検査の削除、木の指紋の対象と内容 3 件、負荷の数え方）、等価 3 件（負荷の標本を回の最初の 1 つにする L10（§4.12 は回ごとの記録だけを定める）、未完のワールドも合否に入れる L13（未完なら終了コード 3 が優先）、`--max-total` の下限の丸めを外す L21（完了には `n >= required` が要る））、**生き残り 10 件**（G4-1-01）。作業者の変異 22 件（`phase4/mut/run.py`）は判定の関数と CLI の入口を変えるもので、回を測るループ・既定の上限・計測コードの指紋・変動の後半を変えるものを含まない。
   - 統計量の関数は、main の値がない構成を受入基準 2 からも除く（G4-1-02）。
3. **ブランチ全体（main との差分）のリリース前の確認**:
   - デバッグ用のコード: 追加行に `console.log`・`debugger`・`TODO`・`FIXME`・`XXX` はない。`console.debug` 3 件は main にもあるもの（移動）、`alert` 3 件は不正なセーブファイルの通知（main の 1 件と、要件 5 の読込のガードで加えた 2 件。unit 10・`system/04` が確かめる）。`gravsim_profiler.js` は main と同じ。
   - 不要・互換だけのコード（§3.2）: `scripts/` の export で `scripts/`・`index.html` から参照されないものは、main にもある 6 個と、設計書 §4.13-2 が名指しし回帰 11 が直接テストする `isPhysicsWorkerEntry` だけ。追加行の legacy・互換の記述は、旧形式のファイルの読込（§3.5-1・§4.14-14 (c)）と応答の名前 `rockets` の据え置き（§4.7）だけで、どちらも設計書の要求。
   - 秘密・個人情報: 変更・追加した 95 ファイルに、鍵・トークン・パスワード・メールアドレスはない（`cdp_helpers.mjs` の `--password-store=basic` は Chromium の起動フラグ）。利用者名を含む作業領域の絶対パス（`/tmp/claude-1000/-home-k-…`）が、本ファイル（本監査の追記の前で 15 行）と見直しの入力 L57 にあり、テスト計画 L227・見直しの入力 L95・L97 は作業領域の相対パスを書く（§4 の 3、G4-1-03）。
   - コミットしてはならないファイル: 追跡されていない 43 件は、テスト、`docs/`、`.eslintrc.json`・`jsconfig.json`・`types/ambient.d.ts`（`npm run check` が使う）、`testsuites/perf/`・`system/cdp_helpers.mjs`・回帰 08 の補助だけで、ログ・一時ファイル・カバレッジの出力・`.claude/` の設定・`node_modules` はない。
   - 文書の整合: 設計書の表題・改訂履歴 L3・§4 の見出し L334・最終改訂 L336（Rev 6.19、2026-11-22 19:56 JST）・§4.12 の見出しは互いに一致し、テスト計画 L3 は Rev 6.19。件数（unit 862 = 836 + 26、全体 1,610 = 1,584 + 26、281 スイート = 275 + 6）・カバレッジ・E2E・d2・s2・計測の値は、本監査の実行と作業者のログと一致する。テスト計画 §5 L223 は E2E の後に Chromium が「残っていない」と書くが、作業者の `phase4/status` は 3 回とも `leftovers=1/0` と記録している。数が 1 のまま増えないため、照合の文字列を含む別のプロセス（監視のコマンドなど）を数えたものと考えられ、本監査の 2 回では前後とも 0 だった。
   - 要求とテストの対応: 要件 1〜5、§4.3 の保証 1〜5（回帰 08a〜c が設計書の閾値 0.15 rad・`MAX_POINTS`・切替後 1 周・99.5% で判定）、§4.13 の 1〜32 と §4.14 の 1〜14（テスト計画 §4.6・§4.7 の表に担当のテストがあり、独立監査3 の各 Iteration が変異で確かめた）、§4.12 の受入基準（`perf/rollout_timing.mjs` の計測、上記 1）に、成功するテストまたは計測がある。テスト計画 §4.5 の確かめられなかった項目には理由と代替が書かれている。§4.12 の分割実行の規則のうち、`unit/11` が確かめていないものは G4-1-01。
   - 範囲の決定の適用: 本体・プリセット・見直しの入力は Iteration 6 から変わらないため、Iteration 6 までに確かめた区分（§4.13 は利用者の判断で本ブランチで修正、§4.14 は本ブランチの退行として修正、見直しの入力 §3 は main と共通で別ブランチ）はそのまま有効。本ラウンドの差分（計測スクリプトと文書）に、main と共通の不具合や本ブランチの退行に当たるものはない。

本ラウンドで直したとされる G3-6-01 は件数と内訳が合うようになったが、その修正で 1 項目の帰属が誤った（G4-1-03 の 2）。工程 4 の結果（機械的チェック・全テスト・E2E・カバレッジ・d2・s2・同期ブロック時間）は再現・再計算で確かめられた。一方、工程 4 で追加した計測スクリプトの分割実行と判定は、単体テストが規則の一部を確かめておらず（G4-1-01）、統計量に設計書の定義と違う端の扱いがある（G4-1-02）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G4-1-01 [Minor]【実装】 計測スクリプトの単体テスト `unit/11` が、設計書 §4.12 の分割実行と変動の規則の一部を確かめていない（変異 10 件が生き残る）
- **箇所**: [`testsuites/unit/11_perf_rollout_timing.test.mjs`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) L186-200（`requires the margin to exceed (strictly) the variation over all, first-half and second-half rounds`）、L279-290（`refuses a state from another harness or version, …`）、L293-353（`Command line`）。対象は [`testsuites/perf/rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) の `evaluateWorld`（L196-200）、`harnessFingerprint`（L245-247）、`runParent` の回を測るループ（L297-313）
- **現象**: 設計書 L478 は「判定の規則は `unit/11_perf_rollout_timing` で確かめる」、テスト計画 §5 L225 は変異 22 件のうち 21 件を検出、README L97 は `unit/11` が「分割実行の状態ファイル（保存・再開・指紋の不一致の拒否）」を確かめると書く。しかし次の変異は `unit/11` を通過する（`gate4_it1/mut/results.json`）。
  1. 変動の後半: 変動を全回と前半だけから求める（L19）、後半から最後の回を除く（L18）。L186-200 の例は外れ値が前半（第 0 回）にあり、後半の統計量が全回と同じ値になるため、後半の項が結果に効かない。L19 を実測の状態に当てると、Sun+Earth の変動は 0.0619 から 0.0475 に下がる（G3-1-08 で直した「変動を小さく見積もる」型）。
  2. 計測コードの指紋: `runChild` を除く（L5）、`measure` を除く（L6）、定数にする（L7）。L279-290 は状態ファイルの `harness` の値を書き換えて拒否を見るだけで、指紋が計測コードから作られることを確かめない（L7 では計測コードを変えても、保存した回と混ぜて再開する）。
  3. 既定の上限: `--max-total` の既定を規定回数の 2 倍にする（L4。設計書は 3 倍）。
  4. 回を測るループ: 回ごとに保存しない（L2。状態ファイルが一度も書かれない）、`--max-rounds` の残りを減らさない（L3。`--max-rounds 1` で残りの全回を測る）、再開した回の先後を回の番号によらず常に本ブランチを先にする（L1。設計書の「回の番号で先後の入れ替えを続ける」に反する）、`--state` なしでも回を足す（L9。ヘッダの「Without --state, every world runs exactly the required rounds」に反する）。CLI のテストは保存済みの回の評価だけで、1 回も測らない。
  - ほかに、異常系の「JSON でない状態ファイル」（終了コード 2）のテストがない。
- **影響**: 工程 4 の計測結果そのものは正しい（本監査が状態ファイルから独立に再計算し、指紋・先後・回数・構成を確かめた。上記 1）。しかし、これらの規則を壊す変更（構造の見直しでの再利用を含む）を `npm test` は検出せず、設計書・テスト計画・README の「`unit/11` で確かめる」は実態より広い。工程 4 で追加したコードはこのゲートで初めて監査され、§3.3 の正常系・異常系・境界値の網羅を満たしていない。
- **修正方針**:
  1. 変動: 後半の統計量だけが最大（または最小）になる回の並び（例: 4 回で最後の回だけが外れる）を加え、後半の範囲（第 floor(n/2) 回から最後の回まで）を固定する。
  2. 計測コードの指紋: ハーネスを一時ディレクトリに複写し、`runChild` または `measure` の本体を 1 文字変えた複写が別の指紋になり、同じ状態ファイルの再開を拒否することを確かめる。
  3. 既定の上限: `--max-total` を渡さずに、高負荷の回を 3 × 規定回数 − 1 回と 3 × 規定回数 回保存した状態を `--max-rounds 0` で評価し、終了コードが 3 と 1 になることを確かめる。
  4. ループ: 即座に終わる模擬の `scripts/`・`testsuites/test_helpers.mjs` とハーネスの複写を置いた小さな偽のツリーで、`--state <file> --max-rounds 1` を繰り返し、実行ごとに 1 回だけ増えて保存されること、再開した回の `order` が回の番号どおりに交互になること、`--state` なしでは規定の回数だけ測ることを確かめる。JSON でない状態ファイルの終了コード 2 も加える。
  5. いずれも `runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` を変えずにできる。これらを変えると計測コードの指紋が変わり、保存した 21 回を再評価できなくなる。修正後に `perf_state.json` のコピーを `--max-rounds 0` で評価し直し、指紋が受理されて値が変わらないことを記録する。
  6. テスト計画 §5 L225 の変異の記述、README L97 の対象、設計書 L478 の「判定の規則」の範囲を、加えたテストに合わせる。README L131 の「方位の指紋（md5）」は、方位が文字列のまま記録される（md5 ではない）ため、あわせて直す。
- **分類**: 【実装】。テストの追加が必要（文書の訂正を伴う）。

#### G4-1-02 [Minor]【実装】 受入基準 2 の統計量が main の値のない構成を黙って除き、両ツリーの構成がそろっていることを確かめない。`unit/11` はこの除外を期待値にしている
- **箇所**: [`testsuites/perf/rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) の `statistic`（L163-168。L165 の `if (!(b > 0)) continue;` が L167 の `maxAbs` の更新より前にある）と `measure`（L148）。[`unit/11`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) L93-100（`skips configurations whose baseline minimum is missing or not positive`）
- **現象**: 設計書 §4.12 は「受入基準 2 は、構成ごとの本ブランチの最小値の最大とする」と定め、main の値を使わない。実装は、main の最小値がない（または正でない）構成を、受入基準 1 だけでなく受入基準 2 からも除く。また、回ごとに両ツリーが同じ構成の集合（124 構成）を持つかを検査しない（`measure` は子プロセスの標準出力のうち `{` で始まる行だけを読み、件数を確かめない）。L93-100 は、main の値がない 5,000 ms の構成を除いた `maxAbs = 80` を期待値にしており、設計書ではなく実装の動作から期待値を取っている（G3-1-03・G3-2-04 と同じ型）。
- **影響**: 工程 4 の 21 回は、すべての回で両ツリーが同じ 124 構成を持つため（上記 1）、結果は変わらない。子プロセスは失敗すると終了コードで止まるため、通常は到達しない。ただし、main で一部の構成の行が出力されない場合（行の破損、計測の対象の変更など）は、本ブランチの遅い構成が受入基準 2 から黙って抜け、基準を満たすと判定され得る。
- **修正方針**: 回ごとに両ツリーの構成の集合が一致し、期待する全構成（`MISSIONS` × 期間 × 方位）を持つことを `runParent` か `statistic` の側で検査し、欠けていれば計測の失敗として止める（または判定を不成立にする）。受入基準 2 は本ブランチの全構成で求める。`unit/11` の L93-100 は設計書の定義（受入基準 2 は本ブランチだけの値）から期待値を作り直し、構成が欠けた回の扱いのテストを加える。`runChild`・`measure` のソースは変えず（G4-1-01 の 5）、保存した 21 回の再評価で値が変わらないことを確かめる。
- **分類**: 【実装】。スクリプトとテストの変更が必要。

#### G4-1-03 [Minor]【文書】 テスト計画の工程 4 の記録が、リポジトリにない作業領域のスクリプトをリポジトリのパスのように書いている。G3-6-01 の修正で 1 項目の帰属が誤った
- **箇所**: [`2026-11-20_trajectory_fx_flightplan_test_plan.md`](../design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §5 L226・L227、§4.6 L192、§4.2 L108
- **現象**:
  1. §5 L226 は中断しない経路の一致のコマンドを「`perf/d2.mjs`（5 ワールド）、`s2_flights.mjs`（15 機）」と書く。同じ表の他の行は `npm run …` と `perf/rollout_timing.mjs`（`testsuites/perf/`）で、`perf/d2.mjs` は `testsuites/perf/d2.mjs` と読めるが、そのファイルはリポジトリになく、作業領域（`scratchpad/perf/d2.mjs`・`scratchpad/gate2_it2/s2_flights.mjs`）にある。§4.6 L192 の `s2_flights.mjs`・`d2.mjs` も同じ。L227 の状態ファイル `scratchpad/phase4/perf_state.json` も作業領域にある。作業領域は一時的（見直しの入力 L57 も「作業領域は一時的なため…リポジトリに移す」と書く）で、「`--max-rounds 0` で計測せずに評価し直せる」はリポジトリからは再現できない。
  2. §4.2 L108 は、変異 F26・F27 を「`deployProfile` の `cleared` が常に真・既定値が真 2 件」と書く。F27（`g3it4_fix/mutants.json`）は `_replaceCenterOfOtherKind(template, cleared = false)`（`gravsim_object_placer.js:110`）の既定値を真にする変異で、`deployProfile`（`:416` の `const cleared = profile.clearPrevious === true`。既定値はない）の変異ではない。G3-6-01 の修正で加わった記述である（修正前は「ボタンが `cleared` を渡す・常に真・既定値が真」）。件数（31 = 24 + 7）と ID の内訳は正しい。
- **影響**: リリースの記録から、中断しない経路の確認と計測の再評価に使った道具を特定・再現できない。変異の 1 件の対象を読み違える。テスト・実装には影響しない。
- **修正方針**: (1) L192・L226・L227 に、作業領域のスクリプト・ファイルであること（場所と、一時的であること）を書く。見直しの安全網として d2・s2 を使う（見直しの入力 §2）なら、リポジトリに移すかどうかを見直しの工程 1 で決めると書く。設計書 §4.12 L466 の `e3b_rev_definition.mjs`、L470 の `d2_sync_equal_trees.mjs`、L481 の `gate2_it9/t9_rollout.mjs` も同じ書き方で、同様に場所を明記するのが望ましい（横展開）。(2) L108 を「`_replaceCenterOfOtherKind` の `cleared` の既定値が真・`deployProfile` の `cleared` が常に真 2 件」のように直す。§4 の 5 の 3 により、設計書の改訂履歴に指摘 ID と修正内容を記録する。
- **分類**: 【文書】。テスト計画（と設計書）の記述の訂正だけで、実装・テストの変更を必要とせず、設計書の要求も満たされる。

---

### 2. 前ゲートの文書指摘の解消確認

独立監査3 Iteration 6（PASS（文書指摘あり））の文書指摘 G3-6-01 を、テスト計画・設計書・作業者の変異の記録と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G3-6-01 テスト計画 §4.2 の Iteration 4 の指摘への対応の項目の件数と内訳 | ✓ 解消（ただし 1 項目の帰属の誤りが新たに生じた → G4-1-03 の 2） | L108 は「変異 31 件（新しい 27 件 F01〜F27 と、Iteration 3・4 の監査の Q17・Q19・Q20・P09 を新しいコードに当て直した 4 件）のうち 24 件（F01〜F20・F24〜F27。…）を回帰 21 だけで検出した。残る 7 件は等価: …3 件（F21〜F23）と、Q17（…Iteration 5 の監査の Q17a と同じ変異）・Q19・Q20・P09」になり、27 + 4 = 31、20 + 4 = 24、3 + 4 = 7、24 + 7 = 31 が合う。括弧内の列挙も 4 + 2 + 7 + 5 + 1 + 1 + 2 + 2 = 24 件になった。作業者の記録（`g3it4_fix/mutants.json`・`out2/results.json`）の 31 件の ID・説明・結果（KILLED 24、SURVIVED 7: F21〜F23・Q17・Q19・Q20・P09）と一致し、Q17 の置換は Iteration 5 の監査の Q17a（`gate3_it5/mut/mutants_it5.json`）と同じ文字列である。設計書の改訂履歴 L3 に「Rev 6.18（独立監査3 Iteration 6 の指摘 G3-6-01（【文書】）を反映。テスト計画 §4.2 の役割の印の変異の内訳（31 件 = 検出 24 件 + 等価 7 件）を訂正。設計の内容は変えない）: 2026-11-22 16:06 JST」があり、§4 の 5 の 3 の記録の要件を満たす。末尾の「Rev 6.17 の訂正の記述は誤りで、Rev 6.18 で直した」も G3-6-01 の内容と一致する。ただし F27 の対象の書き方が誤った（G4-1-03 の 2） |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 判定の関数のテストが、規則の一部が結果に効かない入力だけを使う（G4-1-01 の 1） | `unit/11` の変動の例（後半の統計量 = 全回の統計量）。`testsuites/` でほかに統計量を判定するコードはない（`run_all.mjs` は件数の集計、回帰 08 の補助は設計書の閾値との比較）。予測・音声などの判定は独立監査3 の各 Iteration が全スイートの変異で確かめた | **要**（G4-1-01） |
| 駆動のループ・CLI がテストされない（G4-1-01 の 4） | `testsuites/` の駆動のコードは `perf/rollout_timing.mjs`、`run_all.mjs`（`npm test` のたびに全経路が動き、1 件あたりのタイムアウトは G3-1-07 で確認）、`system/cdp_helpers.mjs`（`system/01` がエラーの収集と一時プロファイルを自己テストする）。テストされない駆動は `rollout_timing.mjs` だけ | **要**（G4-1-01） |
| 指紋・照合の対象が実際の依存を覆うか（G4-1-01 の 2） | `treeFingerprint` は子プロセスが読むもの（`scripts/`、cwd からの `presets/`、`../scripts/gravsim_event_bus.js` だけを読む `test_helpers.mjs`）を覆う。計測コードの指紋は `runChild`・`measure`・構成を覆うがテストがない。Node の版は覆わない | **要**（G4-1-01）。Node の版は §4 の 4 |
| 欠けたデータを黙って除く（G4-1-02） | `testsuites/` の補助・計測のコード（`perf/`・回帰 08 の補助・`test_helpers.mjs`・`cdp_helpers.mjs`・`run_all.mjs`）で、`continue` で値を除くのは `rollout_timing.mjs:165` だけ（grep） | **要**（G4-1-02） |
| 設計書ではなく実装の動作から期待値を取る（G4-1-02） | `unit/11` の L93-100。ほかの 25 件の期待値は設計書 §4.12 の規則・定数（1.5、1 s・2 s、2.0、6・3 回、前半・後半）とヘッダの終了コードから作られている | **要**（G4-1-02） |
| 文書が作業領域のファイルをリポジトリのもののように書く（G4-1-03 の 1） | テスト計画 L192・L226・L227、設計書 L466・L470・L481。見直しの入力 L57・L95・L97 は作業領域のパスと一時的であることを明記している。README は作業領域のファイルを参照しない | **要**（G4-1-03） |
| 前ゲートの指摘の修正で生じた新しい誤り（G4-1-03 の 2） | 本ラウンドで変わった文書の行（設計書 L1・L3・L334・L336・L462・L478、テスト計画 L3・L86・L98・L108・L215-227、README の変更箇所）を全部読み、値はログと照合した。帰属の誤りは L108 の 1 か所 | **要**（G4-1-03） |
| Lint の警告の増減 | 本ブランチは 54 件、main は同じ設定で 58 件とエラー 2 件。追加・変更したファイルで増えた警告はない | 不要 |
| デバッグ用のコード・秘密・コミットしてはならないファイル | 上記 3。該当なし（作業領域の絶対パスは §4 の 3） | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件 | 不要 |
| 中断しない経路への影響 | 本体は Iteration 6 から変わらず、d2（35 構成）・s2（15 機）の md5 が一致 | 不要 |
| 見直しの入力 §3 の行 | 本ラウンドで変更なし（md5）。本体の変更がないため、区分の見直しは不要 | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G4-1-01〜03 の修正と再監査**: 判定は FAIL のため、工程 4 に差し戻して直し、独立監査4 Iteration 2 を受けること。修正は計測スクリプトのテスト（と `statistic`・`runParent`）と文書だけで、本体・プリセット・ほかのテストは変わらないはずなので、d2・s2 の md5 と、`npm test` の件数の差が追加したテストの件数だけであることで確かめられる。`runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` を変えなければ、計測コードの指紋は `a06e9e63…` のままで、保存した 21 回（`phase4/perf_state.json`）を `--max-rounds 0` で再評価でき、約 70 分の再計測は要らない。変えた場合は、新しい状態ファイルで測り直すこと（違うコードで測った回を混ぜない。§4.12）。
2. **計測の証跡の保存**: 同期ブロック時間の受入基準の証跡（`phase4/perf_state.json`、md5 `db6c2be3…`）と main のツリー（`phase4/main_tree`）、d2・s2 のスクリプトと期待値は作業領域にしかなく、再起動や片付けで消える。マージの前に、PR に添付するなど残し方を決めること。構造の見直し（別ブランチ）は d2・s2 と自動テストを安全網とする（見直しの入力 §2）ため、見直しの工程 1 でリポジトリに移すこと。
3. **作業領域の絶対パス**: 本ファイル（本監査の追記の前で 15 行。本監査の追記にも 3 行）と見直しの入力 L57 に、利用者名を含む作業領域の絶対パス（`/tmp/claude-1000/-home-k-…`）がある。秘密ではないが、リポジトリを公開する場合は扱いを決めること。
4. **計測スクリプトの定義されていない動作**（指摘ではない）: `--max-rounds` に数でない値や値のない指定を渡すと、上限なしで全回を測る。計測コードの指紋は Node の版を含まないため、Node を更新した後の再開は拒否されず、違う版で測った回が混ざり得る。負荷の標本は各ツリーの計測の直前だけで、計測の途中の負荷の上昇（本計測では Sun+Earth の 5 回目・7 天体の 4 回目の終わりに 2.40・3.16）は記録されない。いずれも設計書 §4.12 の定義の範囲内だが、構造の見直しで再利用する場合は、明示的に拒否する、状態ファイルに Node の版を記録するなどを検討すること。
5. **`npm run check` の環境**: `package.json` に開発用の依存がなく、`npm run check` は全体にインストールされた ESLint 6.4.0（`.eslintrc.json` と `--ext` を使う。ESLint 9 以降の既定の設定形式では読まれない）と TypeScript 7.0.2 に依存する。README は `npm test` がゼロ依存であることだけを書き、`npm run check` の前提を書いていない。別の環境・CI で機械的チェックを再現するなら、版を記録するか依存として固定すること。
6. **分岐カバレッジ**: 本監査で 93.02% で、目標 97% は行・関数だけが満たす（最低 90% は満たす）。`gravsim_preset_manager.js` 80.54%・`gravsim_rocket_launcher.js` 82.04% など低いファイルが残る（README の表）。構造の見直しで扱うこと。
7. **引き続き有効な Watchpoint**: 独立監査3 Iteration 6 の WP2（旧形式のファイルの読み方を分けるとき）・WP3（補助でカメラが除去済みの天体に残る）・WP4（以前の版の保存）、Iteration 5 の WP3・WP5、Iteration 4 の WP3・WP4、Iteration 3 の WP5、Iteration 2 の WP4・WP7、Iteration 1 の WP4・WP5・WP7、lint 警告 54 件（既存の testsuites）。重い処理（全スイート・E2E・カバレッジ・変異の全スイート・計測）を同時に走らせないこと。

---

## 独立監査4: 最終総合監査 — Iteration 2

- **対象ゲート**: 独立監査4: 最終総合監査
- **イテレーション番号**: Iteration 2
- **実施日時**: 2026-11-23 06:32〜06:58 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **FAIL**（【実装】Minor 2 件、【文書】Minor 1 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（HEAD `0e453a8` = `main`）を、[`docs/development_process.md`](../development_process.md) §2・§3.4・§4、設計書 Rev 6.20（§4.12 の分割実行に構成の完全性の検査・オプションの検査・試験用の負荷の環境変数を追加）、テスト計画（§5 を作業者の申告として扱う）、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査4 Iteration 1 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行と、利用者が範囲に加えた設計書 §4.13 の既存の不具合は本ブランチで直す）は利用者の判断として扱い、その適用を確かめた。

- **差分の特定**: Iteration 1 が監査したツリー（`scratchpad/gate4_it1/pristine`。`gate4_it1/md5_start.txt` の 487 件と一致することを確認）と現行ツリーを `diff -rq` と行の差分で比べた（`gate4_it2/diffs/`）。Iteration 1 の終了時（`gate4_it1/md5_end.txt`）から変わったのは次の 5 ファイルだけである。
  - `testsuites/perf/rollout_timing.mjs`: ヘッダ L24-41、`statistic` の受入基準 2 の位置（L173）、新しい `expectedKeys`（L181-193）・`checkRound`（L195-223）・`testLoad`/`sampleLoad`（L303-312）・`intOption`（L360-367）、`formatWorld`（L264-265）、`loadState`（L314-345）、`parentMain`/`runParent`（L369-431）、export。`runChild`（L70-149）・`measure`（L151-158）・`MISSIONS`・`NEAR`・`MO` は変わらない。
  - `testsuites/unit/11_perf_rollout_timing.test.mjs`: 26 → 42 件、6 → 9 スイート。追加 16 件と、保存する回を完全な回にするための既存の入力の変更。既存のアサーションの削除・緩和はない（`harness` の形の検査は `harnessFingerprint()` との一致に強めた）。
  - 設計書（Rev 6.20）: 表題 L1、改訂履歴 L3 の末尾への Rev 6.20 の追加（Rev 6.19 までの部分はバイト単位で同じ）、§4 の見出し L334、最終改訂 L336、§4.12 の見出し L462、L466・L470・L481 の作業領域の注記、分割実行の項目 L478 の「完全性」以降。
  - テスト計画: L3、§4.1 L86・L98、§4.2 L108、§4.6 L192、§5 L215-233。
  - README: L33・L97・L131・L146・L193-202、カバレッジの記述と表（L217-270 の 10 行）。
  - 本ファイルは Iteration 1 の追記の後の md5（`59d84e41…`）のまま。`scripts/`・`presets/`・設定・`testsuites/system/`・ほかのテスト・見直しの入力は Iteration 1 のツリーとバイト単位で同じ（md5）。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate4_it2/md5_start.txt`、487 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 3,212 行は追記前（`review_before_append.md`、md5 `59d84e41…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 86 行）も変えていない。監査開始時の作業ツリーの完全なコピーを `gate4_it2/pristine` に置いた（md5 の一致を確認）。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB。開始時の load average は 0.93（作業者の再実行の直後）、本監査の重い処理の直前は 0.04 で、別のプロジェクトの重いプロセスは動いていなかった（`procs_start.txt`）。重い処理（機械的チェック、`unit/11` の単独実行、`npm test`、カバレッジ、d2、s2、同期ブロック時間の評価、E2E）は 1 本のスクリプト（`run_checks.sh`）で順に実行し、各段の後の load average・空きメモリ・残留物を `checks/status` に記録した（各段の後の load average は最大 9.40（`npm test` の並列実行の後）、空きメモリは 4.5 GB を下回らなかった）。続いて変異を 2 回、1 つずつ実行した（本監査の 41 件は load average 5.8（直前の E2E の名残り）→ 2.0、作業者の 67 件の再実行は 0.06 → 1.34。変異の判定は時間に依らない）。同期ブロック時間は再計測していない（保存した回の評価と、ハーネスを使わない独立な再計算で確かめた。下記 6）。
- **補助エージェント**: 起動しなかった。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate4_it2/`）: `run_checks.sh`・`checks/`（機械的チェック・テスト・カバレッジ・d2・s2・評価・E2E と `status`）、`perf_state_copy.json`（評価に使った状態ファイルのコピー）、`keys_vs_state.mjs`（保存した回の構成の並びと `expectedKeys` の比較）、`main_archive/`（`git archive 0e453a8`）、`mut/`（本監査の変異。`run_mut.py`・`results.json`・`run.log`）、`mut_impl/`（作業者の変異の再実行）、`probe/`（受入基準 2 の終了コードと main の 0 ms の再現）、`pg_like_run.sh`（E2E の残留物の数え方の再現）、`diffs/`、`pristine/`。

**機械的チェック・テスト実行結果**（テスト計画 §5 と比較）:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（4.3 s）。Lint はエラー 0／警告 54（既存の 16 ファイル。`perf/rollout_timing.mjs`・`unit/11` は 0 件。出力は作業者の `g4fix/check.log` と同じ）。型は TypeScript 7.0.2 でエラー 0。§5 L227 と一致 |
| 全テスト | `npm test` | **1,626/1,626 pass**・fail 0・cancelled 0・skipped 0・todo 0（284 スイート）、66.0 s（load average 0.12 → 9.40）。§5 L228 と一致（1,610 + 16） |
| カバレッジ | `npm run test:coverage` | 1,626 pass（101.2 s）。**行 99.36%・分岐 93.01%・関数 97.34%**（§5・README は分岐 93.04%。差 0.03 ポイントは §5 が書く揺れの範囲内）。最低 90% を満たす。README のファイルごとの表（42 ファイルと全体）は作業者の `g4fix/coverage.log` と全行一致し、本監査の実行とは 36 ファイルが一致、6 ファイルが分岐だけ最大 0.67 ポイント違う（README の「最大 1 ポイントほど」の範囲内） |
| 計測スクリプトの単体テスト | `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` | 42/42 pass（9 スイート、2.7 s）。一時ディレクトリ（`/tmp/rollout-timing-unit-*`）は残らない |
| E2E | `npm run test:system` × 1 | **41/41 pass**・skipped 0・cancelled 0（49.1 s）。前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0（`npm test` の中の 1 回と合わせて 2 回、失敗なし）。`testsuites/system/` と本体が Iteration 1 から変わらないため 1 回とした |
| 中断しない経路の一致 | 作業領域の `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）・`gate2_it2/s2_flights.mjs`（`GS_ROOT` = 作業ツリー） | **一致**: d2 `2e22aefa3a20913ea507399278276b26`（28.3 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（7.6 s）。stderr は空 |
| 同期ブロック時間（評価のみ） | `phase4/perf_state.json` のコピー（md5 `db6c2be3…`）に `--baseline phase4/main_tree --max-rounds 0` | 終了コード 0、計測なし（0.07 s）、stderr は空。出力 5 行は分割実行の最後の評価（`phase4/perf_final.log`）・作業者の `g4fix/reeval2.log`・Iteration 1 の `gate4_it1/perf_eval.out` とバイト単位で同じ。状態ファイルのコピーの md5 は評価の後も同じ |

`skip`・`todo`・`.only`・`assert.ok(true)` は `testsuites/` 全体で 0 件（grep。一致したのはコメントの英語の "only" だけ）。`unit/11` の条件付きのアサーションは L639 の 1 件（3 回目の実行の終了コードを `r.status === 0 ? 0 : 1` と比べる。下記 4）。

**本ラウンドの変更の検証**:

1. **構成の完全性（`expectedKeys`・`checkRound`、設計書 L478）**:
   - `expectedKeys` は `runChild` のループ（`MISSIONS` × 重複を除いた期間 × 方位）と同じ式で、キーの書式も `key()` を共有する。保存した 21 回の 42 ツリー分の構成の並びは、すべて `expectedKeys('0,90,180,270')` の 124 件と順序まで一致した（`keys_vs_state.mjs`）。つまり、実際の `runChild` が出した並びと一致する。方位の文字列は親と子に同じものを渡し、両側で `Number` で変換するため、`0.0`・`-0`・空文字列でもキーは一致する。
   - `checkRound` は回の先後（回の番号どおり）、負荷の標本 2 つ（有限・非負）、両ツリーの全構成の有無・余分・重複・時間（有限・非負）を検査する。計測した回は保存の前に検査し（不合格なら保存せずに終了コード 2）、保存した回は読込で検査する。設計書 L478 の完全性の定義と一致する（負荷の値の検査は設計書より厳しいが、`os.loadavg()` は常に有限・非負）。
   - 端の場合: 方位の重複（`0,0`）では、すべての回が「重複」で止まる。数でない方位は `NaN` と `null` でキーが合わずに止まる。どちらも使い方の誤りとしては拒否されず、1 回を測った後に終了コード 2 になるが、誤った回は保存されない（§4 の 4）。
   - 最小の時間: 保存した 42 ツリー分の最小は 108.4 ms。`checkRound` は 0 ms を受け付け、受入基準 1 は main の最小値が 0 の構成を除く（G4-2-02）。
2. **オプションの検査**: `--max-rounds`（0 以上の整数）・`--max-total`（1 以上の整数）の値の誤り、値のない `--state`・`--state --…` は使い方の誤り（終了コード 2）で、`--max-rounds`・`--max-total` は `--state` が必要。`intOption` は `Number` で変換するため `1e0`・`0x10`・前後の空白も整数として受け付ける（無害）。投げられた例外は `runParent` がすべて終了コード 2 にする（Iteration 1 では計測の失敗の例外が Node の既定の 1 になり、「基準を満たさない」の 1 と区別できなかった）。`--rounds-heavy`・`--rounds` は従来どおり、数でない値を黙って既定値にし、下限 6・3 に丸める（丸めにはテストがない。G4-2-01 の 5）。
3. **試験用の負荷 `ROLLOUT_TIMING_TEST_LOAD`**: 設定されているときだけ、その実行で k 番目に測るツリーの前の標本を一覧の k 番目（循環）に置き換え、標準エラーに警告を出す。値は状態ファイルの `testLoad` に記録され、読込で比べる（`undefined` は JSON に書かれないため、保存した実測の状態（`testLoad` なし）は環境変数がないときだけ受理される。本監査の評価で確認）。子プロセスは読まない。`unit/11` は子プロセスの `env` だけに渡すか、プロセス内のテスト（L502-521）で `finally` で元に戻す。`run_all.mjs` はファイルごとに別プロセスで実行するため、ほかのテストには漏れない。ただし、`--state` なしの実計測で設定されていた場合、標準出力の結果の行には印がない（標準エラーの警告だけ。§4 の 4）。
4. **偽のツリーの計測のループ（`unit/11` L623-692）**: 模擬のモジュールの 2 つのツリーで、ハーネスの複写を実際に回す。回ごとの保存、`--max-rounds 1` の実行ごとに 1 回、記録した先後の継続、負荷の標本の数と順序、`--state` なしの規定回数、`--max-total` までの追加、欠けた・余分な構成の回の拒否と非保存を確かめる。期待値は設計書（31 構成の並び `designKeys`、先後、回数）とヘッダ（終了コード・メッセージ）から作られている。ただし、2 つのツリーは同じ内容で、子の出力にツリー・ワールドの区別がないため、どのツリーをどの順に、どのワールドとして測ったかは確かめられない（G4-2-01）。L639 は 3 回目の終了コードとして 0 と 1 のどちらも受け付ける。模擬の時間は実時間のため受入基準 1 の成否が定まらないことによるもので、完了したこと（2・3 でない）は確かめている。
5. **変異**（`mut/`・`mut_impl/`。`gate4_it2/pristine` から作ったコピーに 1 箇所ずつ入れ（一致数を検査）、`unit/11` だけを実行。変異なしのコピーは成功）:
   - Iteration 1 の 21 件（`gate4_it1/mut/run_mut.py`）を新しい文面に当て直した 22 件（L7 は、Iteration 1 の文面どおりの形（実際には `runChild` を除くだけ）と、指紋を定数にする形の 2 件にした）: 20 件を検出、生き残りは L13・L21 の 2 件だけ。Iteration 1 で生き残った 10 件（L1〜L7・L9・L18・L19）と、Iteration 1 で等価とした L10（負荷の標本を回の初めにまとめて取る）はすべて検出する。
   - 作業者の 67 件（`g4fix/mut/run.py`）を本監査の `pristine` で再実行: 64 件を検出、生き残り 3 件（L13・L21・P8）で、`g4fix/mut3/results.json` と全件一致。「作業者の 20 件」は工程 4 の 22 件のうち、Iteration 1 の L14・L16 と同じ規則を当てる 2 件を除いたもの。
   - 等価の判断（作業者の判断に同意する）: L13（未完了のワールドの成否も全体の `ok` に入れる）は、未完了なら終了コードが成否によらず 3 になるため等価。L21（`--max-total` を規定回数で下から抑えない）は、`complete = n >= required && (loadOk || n >= maxTotal)` で、`maxTotal < required` なら後半は `n >= required` のもとで常に真になり、抑えた場合（`maxTotal = required`）と同じ式になるため等価。P8（`maxRatio <= 1.5` → `<`）は、`margin = 1.5 − maxRatio > variation ≥ 0`（変動は最大 − 最小で負にならない）が `maxRatio < 1.5` を含むため等価。
   - 本監査の新しい変異 19 件（X1〜X19。新しいコードと、Iteration 1 の変異が当てていない駆動の部分）: 10 件を検出（X8〜X11・X13・X15〜X19）、9 件が生き残る。X12（子に方位を渡さず `0` にする）は、テストの方位が `0` だけのため同じ結果になるが、実際の 4 方位の計測では `checkRound` が 93 構成の欠落で止めるため、誤った回は保存されない（指摘としない）。X14（負荷を 5 分平均にする）は、設計書 L478 が「実際の計測時間と負荷の値は確かめない」とした範囲（指摘としない）。残る 7 件（X1〜X7）は G4-2-01。X13（main の最小値 0 を無限大の比として受入基準 1 に入れる）は、`unit/11` L223-231 が「除く」ことを期待値にしているため検出された（G4-2-02）。
6. **同期ブロック時間の結果（テスト計画 §5 L233）**: `phase4/main_tree` は本監査が作った `git archive 0e453a8`（444 ファイル）と `diff -r` で同一。指紋は、現行ツリー `d07b6077…`（Iteration 1 の独自の実装 `indep_fp.py` でも同じ）、main `a0ee7d59…`、計測コード `a06e9e63…` で、状態ファイルの値と一致する。保存した 21 回は全回が `checkRound` を通り、先後は回の番号どおり。統計量の独立な再計算（`gate4_it1/indep_stats.py`。ハーネスを使わず、受入基準 2 を本ブランチの全構成で求める）は Iteration 1 と同じ値（最大比 Sun+Earth 1.3281・7 天体 1.2444・`SOLAR_SYSTEM` 1.2218・`BINARY_SYSTEM` 1.2537・`THREE_BODY` 1.2532、受入基準 2 は Sun+Earth 695.6 ms・7 天体 1,098.4 ms・`SOLAR_SYSTEM` 3,074.0 ms）で、§5 の値と一致する。21 回を測ったときの `rollout_timing.mjs`（Iteration 1 の監査が確かめた 11-22 19:48:55 の版）は、測る順序（`for (const t of round.order)`）・ツリー（`measure(trees[t], world, azimuths)`）・終了コード（`ok && e.crit1 && e.crit2 && e.loadOk`）・回数の下限（6・3）がいずれも正しい（`gate4_it1/pristine` の L282-283・L304・L306・L317）。G4-2-01 の生き残りは、これらを壊す将来の変更を検出できないことで、工程 4 の結果には影響しない。
7. **リリース前の確認（Iteration 1 以降の変更分）**:
   - デバッグ用のコード: 変更した 2 ファイルに `debugger`・`TODO`・`FIXME`・`XXX` はなく、`console.log` は結果の行の出力（`rollout_timing.mjs:414`）だけ。
   - 秘密・個人情報: 変更した 5 ファイルに鍵・トークン・パスワード・メールアドレス・作業領域の絶対パスはない（テスト計画は `scratchpad/` からの相対表記）。作業領域の絶対パスは、本ファイル（本監査の追記の前で 18 行）と見直しの入力 L57 のまま。
   - コミットしてはならないファイル: `git status --porcelain` は Iteration 1 の終了時と同じ 86 行（追跡されていない 34 項目）で、ログ・状態ファイル・一時ファイル・カバレッジの出力は作業ツリーにない。無視されているファイルもない。
   - 文書の整合: 設計書の表題・L3 の Rev 6.20（2026-11-23 06:30 JST）・§4 の見出し L334・最終改訂 L336・§4.12 の見出し L462 は互いに一致し、テスト計画 L3 は Rev 6.20。設計書の保存時刻（06:30:43）は、Rev 6.20 が「確かめた」とする再評価（`g4fix/reeval2.log`、06:25:31）より後。件数（unit 878 = 862 + 16、全体 1,626 = 1,610 + 16、284 スイート = 281 + 3、`unit/11` 42 = 26 + 16）、カバレッジ、d2・s2、計測の値は本監査の実行・作業者のログと一致する。テスト計画 §5 L231 の変異の記述（67 件 = 21 + 20 + 26、検出 64、等価 3）は本監査の再実行と一致する。§5 の時刻と E2E の残留物の説明に誤りがある（G4-2-03）。
   - 範囲の決定の適用: 本ラウンドの差分は、本ブランチで追加した計測スクリプトとそのテスト・文書だけで、main と共通の不具合（見直しの入力 §3）に当たるものはない。G4-2-01・G4-2-02 も本ブランチで追加したコードのもので、本ブランチで直す対象である。

G4-1-01〜03 で指摘した項目はすべて直っている。工程 4 の結果（機械的チェック・全テスト・E2E・カバレッジ・d2・s2・同期ブロック時間）も再現・再計算で確かめられた。一方、`unit/11` のループのテストは 2 つの同じ偽のツリーを使うため、記録された先後と実際の計測の対応を確かめていない。受入基準 2 の終了コードと回数の下限にもテストがない（G4-2-01）。また、受入基準 1 には main の最小値 0 ms の構成を除く経路が残り、テストがそれを期待値にしている（G4-2-02）。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G4-2-01 [Minor]【実装】 `unit/11` の計測のループと終了コードのテストが、測ったツリー・順序・ワールド、受入基準 2 の終了コード、規定回数の下限を確かめない（変異 7 件が生き残る）
- **箇所**:
  - [`testsuites/unit/11_perf_rollout_timing.test.mjs`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) の `mkFakeTree`（L82-120。2 つのツリーが同じ内容で、模擬の `rollout` の出力にツリー・ワールドの区別がない）。
  - 同ファイルの `Measuring loop`（L623-692）、`samples the load before each tree, …`（L654-660）、`Command line`（L524-621）。
  - 対象は [`testsuites/perf/rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) の `parentMain` のうち、回を測るループ（L397-399）、終了コードの判定（L416）、回数の下限（L375-376）。
- **現象**: 設計書 L478 は「判定と分割実行の規則（回数と先後、…受入基準 1・2、…計測のループの回ごとの保存・先後の継続・ツリーごとの負荷の標本・回数の上限）は `unit/11_perf_rollout_timing` で確かめる」と書く。README L97 も「計測のループ（…先後の継続・ツリーごとの負荷の標本…）、オプションの検査と終了コード」と書く。しかし次の変異は `unit/11` を通過する（`gate4_it2/mut/results.json`。計測スクリプトを使うテストは `unit/11` だけ）。
  1. 測る順序（X1）: L397 を `for (const t of ['cur', 'base'])` にする。記録する `order` は回の番号どおりのまま、毎回本ブランチを先に測る。L634-652 は記録された `order` の列だけを比べる。
  2. 測るツリー（X2）: L399 を `measure(trees.cur, …)` にして、main の値も本ブランチのツリーで測る。比はほぼ 1 になり、受入基準 1 は常に満たされる。
  3. ワールド（X3）: L399 で子に `'SE'` を渡し、`SOLAR_SYSTEM` などを Sun+Earth として測る。構成の集合は同じため、`checkRound` も通る。
  4. 受入基準 2 の終了コード（X5）: L416 から `e.crit2` を除く。
     - CLI のテストは、基準を持つ Sun+Earth・7 天体の完了した状態を評価しない。このため、「criterion2 NG」を出しながら終了コード 0 になる変更を検出しない（`probe/crit2_exit.mjs`: 本ブランチの最小値 1,200 ms の Sun+Earth の 6 回で、現行は 1、変異は 0）。
     - ヘッダは「0 when every criterion holds, 1 otherwise」と書き、工程 4 の結論（§5 L233「終了コード 0（5 ワールドとも受入基準 1・2 と負荷の条件を満たす）」）はこの終了コードに拠る。負荷の条件を除く同種の変異（P18）は検出される。
  5. 回数の下限（X6・X7）: L375・L376 の下限 6・3 を 1 にする。テストは `--rounds-heavy`・`--rounds` を一度も渡さないため、`--rounds-heavy 2` で Sun+Earth・7 天体が 2 回で完了する変更を検出しない（設計書 L476「Sun+Earth・7 天体は 6 回以上、他は 3 回以上」）。`requiredRounds` のテスト（L137-145）は、丸めた後の値を受け取る関数だけを見る。
  6. 負荷の標本の時点（X4）: 標本を各ツリーの計測の後に取る。L654 の名前は「before each tree」だが、試験用の負荷はそれまでに測ったツリーの数で引くため、前に取ったか後に取ったかを区別できない（設計書 L478「各ツリーの計測の直前の load average」）。後に取ると計測自身の負荷が入り、条件を厳しくする方向に働く。
- **影響**: 工程 4 の 21 回の結果は正しい（上記 6）。しかし、ループの配線・終了コード・回数の下限を壊す変更（構造の見直しでの再利用を含む）を `npm test` は検出しない。設計書・README の「`unit/11` で確かめる」は実態より広い。G4-1-01 の修正で加えた偽のツリーのループのテストは、記録の形（`order` の列・件数・保存）を確かめるが、2 つのツリーを区別できないため、記録と実際の計測の対応は確かめていない。
- **修正方針**:
  1. 偽のツリーを区別できるようにする。例えば、`mkFakeTree(root, name)` が模擬のモジュールにツリーの名前を埋め込み、模擬の `rollout`・`deployProfile`・`placeObject` が、環境変数で渡したログファイルに「ツリー・ワールド（配置したプロファイル・天体）・呼び出しの順」を追記する。または、ツリーごとに決まった時間を使う（例: 本ブランチ 1 ms、main 2 ms）。そのうえで、次の 3 点を確かめる。
     - 回 r で先に測られたツリーが `roundOrder(r)[0]` であること。
     - `round.base` の値が main のツリーから来たこと。
     - 子が `--worlds` のワールドで配置したこと（`TB` なら `THREE_BODY`、`W7` なら Moon・Venus・Mars・Jupiter）。
     時間をツリーごとに決めれば、L639 の 3 回目の終了コードも 0 に固定できる。
  2. 受入基準 2 の終了コード: Sun+Earth（または 7 天体）の完了した状態を `--max-rounds 0` で評価する。受入基準 1 と負荷を満たし、本ブランチの最小値が 1,000 ms をわずかに超える（1,000.5 ms）状態で終了コード 1 と「criterion2 NG」、ちょうど 1,000 ms で 0 になることを確かめる。
  3. 回数の下限: `--rounds-heavy 2`・`--rounds 1` を渡しても、保存した 2 回の Sun+Earth と 1 回の `THREE_BODY` が未完了（`2/6`・`1/3`、終了コード 3）になること、`--rounds-heavy 8` では 8 回が要ることを確かめる。
  4. 負荷の標本の時点: 確かめるなら、試験用の負荷を「それまでに終わった子の数」で引ける形にする（例: 模擬の `rollout` が書くファイルを読む）。確かめないなら、L654 のテスト名と、設計書 L478・README L97 の「ツリーごとの負荷の標本」を、標本の数と順序だけを確かめるという記述に直す。
  5. いずれも `runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` を変えずにできる（テストと、テストの中の模擬のモジュールの変更）。修正後に `perf_state.json` のコピーを `--max-rounds 0` で評価し直し、値が変わらないことを記録する。設計書 L478・README L97・テスト計画 §5 L231 の記述は、加えたテストに合わせる。
- **分類**: 【実装】。テストの追加が必要（文書の訂正を伴う）。

#### G4-2-02 [Minor]【実装】 受入基準 1 が main の最小値 0 ms の構成を黙って除く。`checkRound` は 0 ms を有効とし、`unit/11` は除外を期待値にしている
- **箇所**:
  - [`testsuites/perf/rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) の `statistic`（L175 `if (!(b > 0)) continue;`）と `checkRound`（L216。`o.ms < 0` だけを拒否する）。
  - [`unit/11`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) L223-231（`leaves a configuration without a positive baseline out of criterion 1 only; …`）と L158-163（`accepts a complete round, including a time of exactly 0 ms, …`）。
- **現象**:
  - 設計書 §4.12 L479 は、受入基準 1 を「構成ごとに本ブランチと main それぞれの全回の最小値をとって比を求め、全構成の最大」とする。完全性（L478、Rev 6.20）は各構成に「有限で負でない時間」を求める。
  - Rev 6.20 の修正で、main の値がない構成は `checkRound` が止めるようになった。しかし、main の最小値が 0 ms の構成は検査を通り、`statistic` が受入基準 1 から除く。本ブランチが正の時間なら比は無限大で、受入基準 1 を満たさないはずの構成が、黙って判定から抜ける。
  - 再現（`probe/zero_base.mjs`）: `THREE_BODY` の完了した 3 回のうち、`leo_250km` 0.2 ヶ月・0° だけを main 0 ms・本ブランチ 50 ms にする（ほかは 120／100 ms）。この状態は `maxRatio=1.200 (leo_250km|0.5|0)`、「criterion1 OK」、終了コード 0 になる。
  - `unit/11` L223-231 は、main 0 ms・本ブランチ 50 ms の構成を除いた `maxRatio = 0.8` を期待値にしている。受入基準 1 の部分は、設計書ではなく実装の動作から期待値を取っている（G4-1-02 と同じ型。G4-1-02 の修正方針「L93-100 は設計書の定義から期待値を作り直し」は受入基準 2 の部分だけに当てられた）。0 を無限大の比として扱う変異 X13 は、この期待値のせいで「検出」される。
- **影響**: 工程 4 の 21 回の最小の時間は 108.4 ms で 0 ms の構成はなく、結果は変わらない。`rollout()` が 0 ms で終わることは通常ない（G4-1-02 と同じく、通常は到達しない）。ただし、境界値（ゼロ）で設計書の定義と実装が食い違い、テストが実装の側を固定している。
- **修正方針**: 次のどちらかに決め、`statistic` の `continue` で除く経路をなくす。
  - 0 ms を計測の誤りとして扱う。`checkRound` が時間に正の値を求め、設計書 L478 の「有限で負でない時間」を「有限で正の時間」にする。
  - main の最小値が正でない構成を、比が無限大の構成として受入基準 1 に入れる（受入基準 1 を満たさない）。

  `unit/11` L223-231 は設計書の定義から期待値を作り直し、L158-163 の 0 ms の扱いも決めた規則に合わせる。保存した 21 回（最小 108.4 ms）を再評価し、値が変わらないことを確かめる。
- **分類**: 【実装】。スクリプトとテストの変更が必要。文書だけで「main の最小値が 0 の構成は除く」とすると、受入基準 1 の「全構成」が狭まる（§4 の 5 の 1）。

#### G4-2-03 [Minor]【文書】 テスト計画 §5 の E2E の残留物の説明が実際の仕組みと違い、経緯の 3 の時刻の終わりがログより遅い
- **箇所**: [`2026-11-20_trajectory_fx_flightplan_test_plan.md`](../design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §5 L229、L221
- **現象**:
  1. L229 は、`phase4/status` の `leftovers=1` の理由を「記録に使ったスクリプトの数え方（コマンド置換の中の `pgrep -fc gravsim-e2e- || true`）が自身のシェルにも一致するため」とする。さらに「Chromium がない状態で同じ形のスクリプトが 1 を返すことを確かめた」と書く。
     - しかし、コマンド置換のサブシェルのコマンドラインはスクリプトを起動したときのもの（`bash run.sh`）で、パターンを含まない。
     - 本監査で、作業者の `g4fix/pg.sh` と `run.sh` と同じ形の `pg_like_run.sh` を試した。パターンを含まないコマンドから `bash <ファイル>` で起動すると 0（Chromium なし）、パターンの文字列を含むコマンドから起動すると 1 になった。
     - したがって 1 は、スクリプト自身のシェルではなく、スクリプトを起動したシェルのコマンドラインに一致したものと考えられる。スクリプトの内容を含む 1 回の呼び出しで、書き込みと起動をしたとみられる（`run.sh` の更新時刻 16:07:11 は開始の記録と同じ秒、`pg.sh` の更新時刻は 06:31:32）。
     - 結論（Chromium は残っていない）は変わらない。Chromium が残っていれば、プロファイルの引数を持つプロセスが複数あり、数は 1 にとどまらない。Iteration 1 と本監査の実行でも、前後とも 0 だった。
  2. L221 は経緯の 3 を「2026-11-23 06:25〜06:32 JST に `npm run check`・`npm test`・`npm run test:coverage`・d2・s2 を再実行し、保存した 21 回を計測せずに再評価した」と書く。しかし、作業者のログの時刻は `reeval2.log` の 06:25:31 から `s2.log` の 06:29:13 までで、テスト計画自体の保存時刻（06:31:40）も 06:32 より前である。
- **影響**: 工程 4 の記録から、残留物の数が 1 になった原因と再実行の時刻を正しく読み取れない。テスト・実装には影響しない。
- **修正方針**: (1) L229 の理由を「数え方が、スクリプトを書いて起動した呼び出しのコマンドライン（パターンを含む）にも一致したため」に直す。確かめた内容は「同じ呼び出し方では Chromium がないときに 1、パターンを含まないコマンドから起動すると 0」と書く。(2) L221 の時刻を 06:25〜06:29 に直す。§4 の 5 の 3 により、設計書の改訂履歴に指摘 ID と修正内容を記録する。
- **分類**: 【文書】。テスト計画の記述の訂正だけで、実装・テストの変更を必要とせず、設計書の要求も満たされる。

---

### 2. 前イテレーションの指摘の解消確認

独立監査4 Iteration 1（FAIL）の指摘 G4-1-01〜03 を、コード・テスト・文書・変異の再実行・保存した回の再評価と突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G4-1-01 `unit/11` が分割実行と変動の規則の一部を確かめない（変異 10 件の生き残り） | ✓ 解消（ただし同じ範囲に未検出の規則が残る → G4-2-01） | (1) 修正方針の 1〜6 に対応するテストが加わった。<br>・変動の後半（L334-349）: 後半だけが最大になる 4 回、最後の回が後半の統計量を決める 4 回、5 回の前半・後半。<br>・計測コードの指紋（L392-430）: ハーネスを一時ディレクトリに複写し、`runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` を 1 か所ずつ変えた複写は別の指紋になって同じ状態ファイルの再開を拒否し、評価の定数・コメントでは指紋が変わらない。<br>・既定の上限（L607-620）: 高負荷 8 回で 3、9 回で 1。<br>・偽のツリーのループ（L623-692）: `--max-rounds 1` の実行ごとに 1 回を保存、`order` の交互、`--state` なしの規定回数、`--max-total` までの追加。<br>・JSON でない状態ファイル（L483-490・L554-566）。<br>(2) Iteration 1 の変異を当て直した 22 件のうち、生き残っていた 10 件（L1〜L7・L9・L18・L19）と L10 はすべて検出され、残る L13・L21 は等価（上記 5）。<br>(3) README L131 の「方位の指紋（md5）」は「方位（指定の文字列のまま）」に直り、テスト計画 §5 L231・README L97・設計書 L478 の記述も加えたテストに合わせて書き直された。<br>(4) ただし、ループのテストは 2 つの同じ偽のツリーを使うため、測ったツリー・順序・ワールドを確かめない。受入基準 2 の終了コードと回数の下限にもテストがない（G4-2-01） |
| G4-1-02 受入基準 2 の統計量が main の値のない構成を除き、構成がそろっていることを確かめない | ✓ 解消（ただし受入基準 1 の 0 ms の除外が残る → G4-2-02） | (1) `statistic` は受入基準 2 を本ブランチの全構成から求める（L173 の更新が main の値の検査より前にある）。<br>(2) `checkRound` は、計測した回（保存の前、L402-406）と保存した回（読込、L333-343）で、両ツリーの 124 構成（4 方位）の有無・余分・重複・時間と、先後・負荷の標本を検査する。欠けた回は保存せずに終了コード 2 で止まり、設計書 L478 と一致する。<br>(3) `unit/11` L223-231 の受入基準 2 の期待値（5,000 ms）は設計書の定義から作られ、L148-197・L483-500・L678-692 が欠けた回の扱いを確かめる。<br>(4) `runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` は変わらず（差分）、計測コードの指紋は `a06e9e63…` のまま。保存した 21 回は `--max-rounds 0` の評価で全回が検査を通り、出力は分割実行の最後の評価（`phase4/perf_final.log`）とバイト単位で同じ。独立な再計算でも受入基準 2 は Sun+Earth 695.6 ms・7 天体 1,098.4 ms・`SOLAR_SYSTEM` 3,074.0 ms で変わらない（上記 6）。<br>(5) ただし、main の最小値が 0 ms の構成を受入基準 1 から除く経路が残り、`unit/11` がそれを期待値にしている（G4-2-02） |
| G4-1-03 作業領域の道具をリポジトリのパスのように書く。F27 の帰属の誤り | ✓ 解消 | (1) 作業領域の道具の書き方:<br>・テスト計画 L192 は「`s2_flights.mjs`・`d2.mjs` はリポジトリにない作業者の作業領域のスクリプト。§5」と書く。<br>・§5 L223 は、作業領域（Claude Code のセッションの一時ディレクトリ、`scratchpad/`）であること、一時的であること、d2・s2 をリポジトリに移すかを見直しの工程 1 で決めることを書く。<br>・L232・L233 は `scratchpad/perf/d2.mjs`・`scratchpad/gate2_it2/s2_flights.mjs`・`scratchpad/phase4/perf_state.json` と書き、リポジトリにないことを明記した。<br>・設計書 L466（`e3b_rev_definition.mjs`）・L470（`d2_sync_equal_trees.mjs` と作業者の `perf/d2.mjs`）・L481（`gate2_it9/t9_rollout.mjs`）も、作業領域のスクリプトでリポジトリにないことを書く（横展開）。<br>・設計書・テスト計画・見直しの入力・README が参照する `.mjs`・`.py`・`.sh`・`.json` のうち、リポジトリにないものを検索した。残りは見直しの入力の `scratchpad/…`（明記済み）と、テスト計画 §2 の計画の表（L21）の旧ファイル名 `08_trajectory_prediction_guarantees` だけだった。後者は §4.1 L91・README L104 が 08a〜c への分割を説明している。<br>(2) F27 の帰属: §4.2 L108 は「`deployProfile` の `cleared` が常に真（F26）・`_replaceCenterOfOtherKind` の引数 `cleared` の既定値が真（F27）2 件」と書く。これは `g3it4_fix/mutants.json` の F26・F27 の置換（`gravsim_object_placer.js:416`・`:110`）と一致し、同じ文の「既定値が真 1 件」は F19（`CelestialBody` の既定値）に当たる。括弧内の列挙は 24 件のまま合う。<br>(3) 設計書の改訂履歴 L3 の Rev 6.20 に、G4-1-03 と F27 の訂正が記録されている（§4 の 5 の 3） |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 模擬の入力が、規則の効く違いを持たない（G4-2-01 の 1〜3・6） | `unit/11` の偽のツリー（2 つが同じ内容）、ワールド（`TB` だけ）、方位（`0` だけ）、試験用の負荷（測った数で引く）。方位は実際の計測で `checkRound` が止めるため影響しない（X12）。`testsuites/` で子プロセスを駆動するほかのコード（`run_all.mjs`・`system/cdp_helpers.mjs`）は Iteration 1 で確認済みで、本ラウンドで変わっていない | **要**（G4-2-01） |
| 終了コード・回数の決定の一部にテストがない（G4-2-01 の 4・5） | `parentMain` の終了コードの要素（未完了、受入基準 1、受入基準 2、負荷）のうち、テストがないのは受入基準 2 だけ（P15・P17・P18 と、受入基準 1 を除く追加の変異 X20（`mut/x20/`）は検出、X5 は生き残る）。回数の決定（`requiredRounds` と CLI の丸め）のうち、テストがないのは CLI の丸めだけ（X6・X7）。`--max-rounds`・`--max-total` の検査は L537-552 が網羅する | **要**（G4-2-01） |
| 欠けた・0 のデータを黙って除く（G4-2-02） | `testsuites/` の補助・計測のコードで、`continue` で値を除くのは `rollout_timing.mjs:175` だけ（grep。`cdp_helpers.mjs:230・232` は `/proc` の走査で、数字でない項目と自身を除くもの）。負荷の標本の 0 は正当な値 | **要**（G4-2-02） |
| 設計書ではなく実装の動作から期待値を取る（G4-2-02） | `unit/11` の 42 件をすべて読んだ。期待値は設計書 §4.12（124 構成の並び、1.5・1 s・2 s・2.0、6・3 回、前半・後半、先後）とヘッダ（終了コード・メッセージ）から作られている。実装から取ったものは L223-231 の受入基準 1 の部分だけ。L639 の 3 回目の終了コードは 0 と 1 の両方を受け付ける（模擬の時間が実時間のため。G4-2-01 の修正方針 1 で固定できる） | **要**（G4-2-02） |
| 文書の説明・時刻とログの突合（G4-2-03） | 本ラウンドで変わった文書の行（設計書 L1・L3・L334・L336・L462・L466・L470・L478・L481、テスト計画 L3・L86・L98・L108・L192・L215-233、README の変更箇所）をすべて読み、値・時刻をログと照合した。誤りは L221 の時刻と L229 の説明の 2 か所。設計書の Rev 6.20 の時刻（06:30）と内容は、作業者のログ（06:25:31 の再評価）と設計書の保存時刻（06:30:43）に整合する | **要**（G4-2-03） |
| 試験用の仕組みが実計測に入る | `ROLLOUT_TIMING_TEST_LOAD` は状態ファイルに記録され、実測の状態（`testLoad` なし）とは相互に再開を拒否する。子は読まない。テストは子の `env` だけに渡すか、プロセス内で元に戻す。`--state` なしの実計測で設定されると、結果の行に印がない | 不要（§4 の 4） |
| 指紋の範囲 | `expectedKeys`・`checkRound` は計測コードの指紋に入らないが、計測される値を決めず、回を検査するだけ。`runChild`・`measure`・構成の定数は変わらず、指紋は `a06e9e63…` | 不要 |
| Lint の警告・デバッグ用のコード・秘密・コミットしてはならないファイル | 警告 54 件は Iteration 1 と同じファイル。そのほかは上記 7 で、該当なし | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件 | 不要 |
| 中断しない経路への影響 | 本体は Iteration 1 から変わらず、d2（35 構成）・s2（15 機）の md5 が一致 | 不要 |
| 見直しの入力 §3 の行 | 本ラウンドで変更なし（md5）。本ラウンドの差分と指摘は本ブランチで追加した計測スクリプトのもので、main と共通の不具合ではない | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G4-2-01〜03 の修正と再監査**:
   - 判定は FAIL のため、工程 4 に差し戻して直し、独立監査4 Iteration 3 を受けること。修正は `unit/11`（と G4-2-02 の `statistic`・`checkRound`）と文書だけで、本体・プリセット・ほかのテストは変わらないはずである。
   - 次の 3 点で確かめられる: d2・s2 の md5、`npm test` の件数の差が追加したテストの件数だけであること、保存した 21 回（`phase4/perf_state.json`）を `--max-rounds 0` で再評価して値が変わらないこと。
   - 偽のツリーを区別できるようにする変更は、テストの中の模擬のモジュールで行い、`runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` を変えないこと（変えると計測コードの指紋 `a06e9e63…` が変わり、保存した回を再評価できなくなる）。
   - G4-2-02 で `checkRound` に正の時間を求める場合も、保存した回の最小は 108.4 ms のため、21 回は検査を通るはずである。
2. **マージの前の確認**: 追跡されていない 34 項目（追加したテストと補助、`docs/`、`npm run check` が使う `.eslintrc.json`・`jsconfig.json`・`types/`、`testsuites/perf/`・`testsuites/system/`）をすべてコミットに含めること。`npm test`・`npm run check` の結果はこれらに依存する。
3. **計測の証跡の保存**（Iteration 1 の WP2、引き続き有効）: 同期ブロック時間の受入基準の証跡（`phase4/perf_state.json`、md5 `db6c2be3…`）、main のツリー（`phase4/main_tree`）、d2・s2 のスクリプトと期待値は、作業領域にしかない。マージの前に残し方を決めること。構造の見直しはこれらを安全網とするため、見直しの工程 1 でリポジトリに移すこと。
4. **計測スクリプトの定義されていない動作**（指摘ではない）:
   - 方位の重複（`0,0`）や数でない方位は使い方の誤りとして拒否されず、1 回を測った後に `checkRound` が止める（誤った回は保存されない）。
   - `--rounds-heavy`・`--rounds` は、数でない値を黙って既定値にする（下限は守られる）。
   - `ROLLOUT_TIMING_TEST_LOAD` が設定されたまま `--state` なしで実計測すると、負荷の条件は試験の値で判定される。標準出力の結果の行には印がない（標準エラーの警告だけ）。
   - 計測コードの指紋は Node の版を含まない（Iteration 1 の WP4）。
   - 構造の見直しで再利用する場合は、これらを明示的に拒否する、結果の行に試験の値であることを出す、状態ファイルに Node の版を記録する、などを検討すること。
5. **作業領域の絶対パス**（Iteration 1 の WP3）: 本ファイル（本監査の追記の前で 18 行。本監査の追記にも 1 行）と見直しの入力 L57 に、利用者名を含む作業領域の絶対パスがある。リポジトリを公開する場合は扱いを決めること。
6. **`npm run check` の環境と分岐カバレッジ**（Iteration 1 の WP5・WP6）: 全体にインストールされた ESLint 6.4.0・TypeScript 7.0.2 に依存する。分岐カバレッジは本監査で 93.01% で、目標 97% は行・関数だけが満たす。構造の見直しで扱うこと。
7. **引き続き有効な Watchpoint**: 独立監査4 Iteration 1 の WP7 に挙げたもの（独立監査3 の各 Iteration の WP、lint 警告 54 件）。重い処理（全スイート・E2E・カバレッジ・変異・計測）を同時に走らせないこと。

---

## 独立監査4: 最終総合監査 — Iteration 3

- **対象ゲート**: 独立監査4: 最終総合監査
- **イテレーション番号**: Iteration 3
- **実施日時**: 2026-11-23 07:42〜08:13 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **FAIL**（【実装】Minor 1 件、【文書】Minor 2 件）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（HEAD `0e453a8` = `main`）を、[`docs/development_process.md`](../development_process.md) §2・§3.4・§4、設計書 Rev 6.21（受入基準 1 の無限大の比、`--rounds-heavy`・`--rounds` の検査、ファイルから読む試験用の負荷を追加）、テスト計画（§5 を作業者の申告として扱う）、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査4 Iteration 1・2 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行と、利用者が範囲に加えた設計書 §4.13 の既存の不具合は本ブランチで直す）は利用者の判断として扱い、その適用を確かめた。

- **差分の特定**: Iteration 2 が監査したツリー（`scratchpad/gate4_it2/pristine`。`gate4_it2/md5_start.txt` の 487 件と一致することを確認）と現行ツリーを、`diff` と行内の差分で比べた（`gate4_it3/diffs/`）。Iteration 2 の終了時（`gate4_it2/md5_end.txt`）から変わったのは次の 5 ファイルだけである。
  - `testsuites/perf/rollout_timing.mjs`: ヘッダ L15-20・L39-41、`statistic` の比（L176-179）、`sampleLoad`（L306-315。一覧の形と測った数 `measured` を削除）、`parentMain` の `--rounds-heavy`・`--rounds`（L378-379 が `intOption` を使う）と、ループ・進行の行からの `measured` の削除（L396-412）。`runChild`（L73-151）・`measure`（L154-160）は Iteration 1 のツリーの同じ関数と同一（抽出して比較）で、`MISSIONS`・`NEAR`・`MO` も変わらない。
  - `testsuites/unit/11_perf_rollout_timing.test.mjs`: 42 → 51 件（9 スイートのまま）。名前で比べると、置き換え・改名が 3 件（「main の最小値が正でない構成を受入基準 1 から除く」→「無限大の比として数える」、負荷の標本の 1 件、`--state` なしの 1 件）、追加が 12 件。`mkFakeTree` にツリーの名前の引数と `FAKE_LOG`・`FAKE_LOAD_FILE`、`fullRound` に方位の引数を追加。消えたアサーションは、G4-2-02 で設計書の定義に合わせた受入基準 1 の期待値（0.8 → 無限大）と、廃止した一覧の形の試験用の負荷のものだけで、ほかの緩和はない。
  - 設計書（Rev 6.21）: 表題 L1、改訂履歴 L3 の末尾への Rev 6.21 の追加（Rev 6.20 までの部分は同じ）、§4 の見出し L334、最終改訂 L336、§4.12 の見出し L462、分割実行 L478（回数の検査、試験用の負荷の形、`unit/11` の範囲）、統計量 L479（無限大の比）。
  - テスト計画: L3、§4.1 L86・L98、§5 L221（経緯の 3）・L222（経緯の 4 を新設）・L224・L229-234。
  - README: L33・L97・L131・L146・L193-202・L219・L245・L252-253・L270。
  - 本ファイルは Iteration 2 の追記の後の md5（`a3a25425…`）のまま。`scripts/`・`presets/`・設定・`testsuites/system/`・ほかのテスト・見直しの入力は Iteration 2 のツリーとバイト単位で同じで、`scripts/`・`presets/`・`testsuites/system/`・`index.html`・`style.css`・設定は独立監査3 Iteration 6 の終了時（`gate3_it6/md5_end.txt`）とも同じ（md5）。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate4_it3/md5_start.txt`、487 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確認した。本ファイルは追記のみで、既存部分 3,386 行は追記前（`review_before_append.md`、md5 `a3a25425…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 86 行）も変えていない。監査開始時の作業ツリーの完全なコピーを `gate4_it3/pristine` に置いた。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB。開始時（07:42）の load average は 5.19。別のプロジェクトの重いプロセスはなかったが、**作業者の最初の変異の実行（`g4fix2/auto/run1`、07:01〜07:11。タイムアウトで直下のプロセスだけを止めた）から残ったプロセス**が動き続けていた: `node --test` の 3 本（PID 3636869・3741875・3749761、プロセスグループ 3595950、作業ディレクトリ `run1/m79`・`m226`・`m233`）と、その下で終わらない計測のループを回す計測スクリプトの複写（`/tmp/rollout-timing-unit-sHnkrl`・`-7nEnxt`・`-wi4c6v` の下。PID 3637733 は CPU 約 70%、RSS 565 MB → 08:09 に 654 MB）。本監査が起動したものではないため止めていない（下記 G4-3-01 の証拠でもある）。これらが常に 1〜2 コアを使うため、本監査と作業者の 07:29〜07:33 の再実行の時間は、その負荷の下での値である。`/tmp/rollout-timing-unit-*` もこれらの実行から 12 個残っている（本監査の実行は 1 つも残していない）。重い処理（機械的チェック、`unit/11` の単独実行、`npm test`、カバレッジ、d2、s2、同期ブロック時間の評価、E2E）は 1 本のスクリプト（`run_checks.sh`）で順に実行し、各段の後の load average・空きメモリ・残留物を `checks/status` に記録した（load average は `npm test` の並列実行の後に最大 13.6、空きメモリは 3,804 MB を下回らなかった）。続いて `npm run test:unit`（件数の確認）と、変異を 3 回（3 並列まで）1 つずつ実行した（load average 3.8〜7.9。変異の判定は時間に依らない）。同期ブロック時間は再計測していない（保存した回の評価と、ハーネスを使わない独立な再計算で確かめた。下記 6）。
- **補助エージェント**: 起動しなかった。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate4_it3/`）: `run_checks.sh`・`checks/`（機械的チェック・テスト・カバレッジ・d2・s2・評価・E2E・unit だけの実行と `status`）、`perf_state_copy.json`、`mut/`（本監査の変異 `run_mut.py`・`out/results.json`・`run.log`、Iteration 2 の変異の一覧の当て直し `rerun_it2.py`・`rerun/results.json`・`rerun.log`、文面の変わった 4 件の当て直し `run_adapted.py`・`adapted/`）、`probe/`（`loadavg_stub.mjs`: `os.loadavg` の差し替えによる 1 分平均と 5 分平均の区別、`hang/`: 同期の待ちとテストのタイムアウト）、`it2_names.txt`・`it3_names.txt`（`unit/11` のテスト名）、`diffs/`、`pristine/`。

**機械的チェック・テスト実行結果**（テスト計画 §5 と比較）:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（5.0 s）。Lint はエラー 0／警告 54（既存の 16 ファイル。`perf/rollout_timing.mjs`・`unit/11` は 0 件。出力は作業者の `g4fix2/check.log` と同じ）。型は TypeScript 7.0.2 でエラー 0。§5 L228 と一致 |
| 計測スクリプトの単体テスト | `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` | 51/51 pass（9 スイート、4.0 s、load average 3.9）。一時ディレクトリ（`/tmp/rollout-timing-unit-*`）は増えない |
| 全テスト | `npm test` | **1,635/1,635 pass**・fail 0・cancelled 0・skipped 0・todo 0（284 スイート）、77.3 s（load average 3.87 → 13.63）。§5 L229 と一致（1,626 + 9）。`npm run test:unit` は 887/887（105 スイート、16.7 s）で README L33 と一致 |
| カバレッジ | `npm run test:coverage` | 1,635 pass（119.2 s）。**行 99.36%・分岐 93.10%・関数 97.34%**（§5・README は分岐 93.02%。差 0.08 ポイントは §5 が書く揺れ（0.1 ポイントほど）の範囲内）。最低 90% を満たす。README のファイルごとの表（42 ファイルと全体）は作業者の `g4fix2/coverage.log` と全行一致し、本監査の実行とは 38 行が一致、5 行（全体を含む）が分岐だけ違う（最大は `gravsim_object_placer.js` の 89.67% → 90.67%。README L224 の「最大 1 ポイントほど」の範囲内） |
| 中断しない経路の一致 | 作業領域の `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）・`gate2_it2/s2_flights.mjs`（`GS_ROOT` = 作業ツリー） | **一致**: d2 `2e22aefa3a20913ea507399278276b26`（31.3 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（8.7 s）。stderr は空 |
| 同期ブロック時間（評価のみ） | `phase4/perf_state.json` のコピー（md5 `db6c2be3…`）に `--baseline phase4/main_tree --max-rounds 0` | 終了コード 0、計測なし（0.07 s）、stderr は空。出力 5 行は分割実行の最後の評価（`phase4/perf_final.log`）・作業者の `g4fix2/reeval3.log` とバイト単位で同じ。コピーの md5 は評価の後も同じ |
| E2E | `npm run test:system` × 1 | **41/41 pass**・skipped 0・cancelled 0（52.5 s）。前後で `gravsim-e2e-` のプロファイルの Chromium は 0、`/tmp/gravsim-*` は 0（`npm test` の中の 1 回と合わせて 2 回、失敗なし）。本体と `testsuites/system/` が独立監査3 Iteration 6 から変わらないため 1 回とした |

`skip`・`todo`・`.only`・`assert.ok(true)` は `testsuites/` 全体で 0 件（grep）。`unit/11` の条件付きのアサーションは L778 の 1 件（3 回目の実行の終了コードを `r.status === 0 ? 0 : 1` と比べる。§4 の 4）。

**本ラウンドの変更の検証**:

1. **受入基準 1 の無限大の比（G4-2-02、設計書 L479）**:
   - `statistic`（L176-179）は、main の最小値が正でない（0 または値がない）構成の比を `Infinity` とし、本ブランチの最小値が 0 でも（0/0）`Infinity` になる。`evaluateWorld` の `crit1` は `Infinity <= 1.5` が偽のため必ず不成立で、終了コードは 1。設計書 L479 の「main の最小値が正でない構成は比を無限大とし、受入基準 1 を満たさない」と一致する。
   - 全回の統計量が `Infinity` のときの変動は `NaN`（`Infinity − Infinity`）か `Infinity` で、結果の行は `variation=NaN` などになるが、`crit1` は統計量の側で不成立になるため判定は変わらない。全回の main の最小値が正なら前半・後半も正（部分集合の最小値は全回の最小値以上）で、変動は有限のまま。
   - `checkRound` は引き続き 0 ms を有効な時間とし（設計書 L478 の「有限で負でない時間」）、0 ms の構成は受入基準 1 を満たさない側で扱われる。保存した 21 回の最小は 108.4 ms で、値は変わらない。
2. **`--rounds-heavy`・`--rounds` の検査（設計書 L478）**: `intOption` で 6 以上・3 以上の整数を求め、それより小さい値・整数でない値・値のない指定は使い方の誤り（終了コード 2）。設計書 §4.12 の「Sun+Earth・7 天体は 6 回以上、他は 3 回以上」と矛盾しない（オプションは規定回数を引き上げるだけで、下限より少ない回数では完了しない。Rev 6.20 までは小さい値を黙って下限に直していた）。`6.0`・`0x6`・前後の空白は 6 として受け付ける（無害。Iteration 2 が `--max-rounds` について書いたものと同じ）。
3. **試験用の負荷（`ROLLOUT_TIMING_TEST_LOAD` = 数 または `@<ファイル>`）**:
   - 標本ごとに値（またはファイルの内容）を `Number` で読む。ファイルがないと例外で終了コード 2、数でない内容は `NaN` で `checkRound` が拒否する（終了コード 2、保存しない）。
   - 値は状態ファイルの `testLoad` に文字列のまま記録され、実測の状態（`testLoad` なし）とは相互に再開を拒否する（本監査の評価でも、環境変数なしで受理された）。子プロセスは読まない。`FAKE_*` の環境変数を読むのは `TMP` の下の模擬のモジュールだけで、`scripts/` に参照はない（grep）。
   - `--state` なしの実計測で設定されていた場合に結果の行に印がないことは Iteration 2 の §4 の 4 のまま。
4. **偽のツリーの計測のループ**: 模擬の `gravsim_rocket_launcher.js` は、読み込まれたとき（各子プロセスの開始時）に `$FAKE_LOG` へ「ツリーの名前 `--world` の値」を追記し、`$FAKE_LOAD_FILE` の数を 1 増やす。
   - L772-795・L823-835 は、ログの並びが回の番号どおりの先後（`orderLog`）・ツリー・ワールドと一致することを確かめる。L812-821 は、ファイルを試験用の負荷にして標本が `[[0, 1], [2, 3]]`（n 番目の標本はそれまでに測った n 個のツリーを見る）であることを確かめる。期待値は設計書（`roundOrder` の先後、31 構成、規定回数、各ツリーの計測の直前の標本）から作られている。
   - ワールドは子に渡した引数の段階で確かめる（設計書 L478 の「子プロセスが自分のツリーの名前とワールドを記録する」と一致）。模擬の `ObjectPlacer` は配置を記録しないため、子の中での配置（`runChild` の対応）は確かめない（下記 5 の R 系。§4 の 3）。
5. **変異**（`gate4_it3/pristine` から作ったコピーに 1 箇所ずつ入れ（一致数を検査）、`unit/11` だけを実行。タイムアウトではプロセスグループごと止め、残留物なし。変異なしのコピーは成功）:
   - **Iteration 2 の X1〜X7 の当て直し**: X1（先後の固定）・X2（main を本ブランチで測る）・X3（ワールドを渡さない）・X4（標本をツリーの後に取る）・X5（受入基準 2 を終了コードに含めない）・X6・X7（回数の下限を 1 にする）と、Rev 6.20 の黙って丸める形に戻す X6b・X7b は、すべて検出する。
   - **Iteration 2 の変異の一覧の再実行**（`gate4_it2/mut/run_mut.py` の 41 件と `mut_impl/run_impl.py` の 67 件の一覧だけを使う）: 108 件のうち 90 件を検出、生き残り 6 件（L13 2 件・L21 2 件・P8 は Iteration 2 が等価と判断したもので、本監査も同意。X12 は誤った回を保存しない）、文面が変わった 11 件。文面が変わったもののうち、L10（標本を回の初めにまとめて取る）・L12（受入基準 2 を main の値のある構成だけで求める）・N15（環境変数を無視する）と構文の壊れた P15 は新しい文面に当て直して 4 件とも検出、X4・X6・X7・X14 は上記と下記に含めた。X13 はその内容が Rev 6.21 の実装になり、逆の変異（Y1）を検出する。N26 は対象（測った数）が削除された。
   - **本監査の新しい変異 Y1〜Y18**: 15 件を検出（0 の main を比 0 にする・`b >= 0` で割る・無限大の比を最大から除く・最小値 0 を次の回で置き換える・0 ms を拒否する、ファイルの負荷を 1 回だけ読む、警告や `testLoad` の記録の削除、整数でない値の受付、重い回数と軽い回数の取り違え、`argValue` の範囲、ワールドの順の並べ替え、既定の回数 7、受入基準 2 の境界、状態のツリーの取り違え）。生き残り 3 件は、進行の行の負荷の値（Y7。標準エラーの表示で、設計書・ヘッダに定めがない）、計測した回の検査に方位 0 の構成を使う（Y14。テストの方位が 0 だけのため。4 方位の実計測では最初の回が「unexpected configuration」で止まり保存されない）、結果の行の `maxAbs` の丸め方（Y17。表示だけ）で、指摘としない。
   - **計測コード R1〜R10**（作業者の変異は `measure` より後の行だけが対象）: 検出は子の `--root` を本ブランチにする R9 だけで、R1〜R8・R10（`SOLAR_SYSTEM` を `BINARY_SYSTEM` で配置、7 天体の惑星を置かない、`THREE_BODY` を `BINARY_SYSTEM` で配置、既定以外の期間を当てない、方位を当てない、時間を定数にする、機体を固定する、子の作業ディレクトリを本ブランチにする（main がプリセットを本ブランチから読む）、Sun を置かない）は生き残る。設計書 L478 は `unit/11` の範囲を「計測のループが…各ツリーをそのツリーとワールドで測ること」（子プロセスが記録するツリーの名前とワールド）とし、「実際の計測時間…は確かめない」とするため、範囲外である。保存した 21 回は `runChild`・`measure` の指紋 `a06e9e63…` で、Iteration 1 が全行を読んだコードで測ったことが保証される（§4 の 3）。
   - **作業者の変異（`g4fix2/auto/gen_run.py`・`run4/results.json`）**: スクリプトを読んだ。`const key` の行（L162）から最後までの行（`usage()` の本体、コメント・括弧だけの行を除く）に、文の削除・比較と論理の演算子・`??`・否定・数・値の文字列の変更を 1 か所ずつ入れ、X1〜X7 を加えた 331 件で、結果は検出 308・タイムアウト 3・構文の誤り 10・生き残り 10 件。§5 L232 の数（321 件のうち 311 件を検出、タイムアウト 3 件を含む）と一致する。タイムアウトの 3 件（L247 `||` → `&&`、L396 `&&` → `||`、L409 の `rounds.push` の削除）は計測のループが終わらなくなる変異で、上の残ったプロセスはこの 3 件の `run1` での実行である（G4-3-01）。
   - **作業者が等価などとした 10 件の判断**:
     - 等価に同意する 7 件: L258（`maxRatio <= 1.5` → `<`。余裕 > 変動 ≥ 0 が `maxRatio < 1.5` を含む。浮動小数点でも 1.5 − x > 0 と x < 1.5 は同値）、L378・L379・L394（`??` → `||`。`intOption` の値は 6・3・1 以上の整数か `undefined` で、偽の値を取らない）、L395（`??=` → `||=`。`loadState` が配列以外を拒否し、空の配列も真）、L366（値のない指定の既定 `''` → `'_x'`。どちらも整数でなく使い方の誤り）、L439（読み込んだときの `invokedPath` の既定。どちらも自身の実パスと一致しない）。
     - L303（計測コードの指紋の `NEAR` の区切り `,` → `,_x`）: 指紋が計測コードで変わり同じなら同じという性質は保たれる（ミッション ID に `,` はない）ため、テストの観点では等価に同意する。ただし指紋の値が変わるため、保存した 21 回は「different harness」で拒否される（安全側）。指紋の値そのもの（`a06e9e63…`）を固定するテストはなく、固定しているのは保存した回の評価だけである。
     - L359（使い方の文言）: 等価ではないが、文言は設計書・ヘッダに定めがなく、`unit/11` は `^usage: ` だけを見る。指摘としない。
     - L313（1 分平均 → 5 分平均）: **区別できないとする判断には同意しない**。親のプロセスに `node --import` で `os.loadavg` を差し替えるモジュールを読ませると区別できる（`probe/loadavg_stub.mjs`: `[0.25, 7.5, 9.5]` に差し替えて偽のツリーで 1 回測ると、現行は `loads [0.25, 0.25]`、変異は `[7.5, 7.5]`）。生き残ること自体は、設計書 L478 の「実際の…負荷の値は確かめない」の範囲内（Iteration 2 の X14 と同じ判断）だが、§5 L232 の理由が事実と違う（G4-3-02）。
     - L366・L439 の §5 L232 の理由「どの既定でも」は、L366 については数の既定（例えば `'6'`）なら値のない `--rounds-heavy` を 6 として受け付けるため誤り（G4-3-02）。L439 は自身の実パスを既定にする場合を除いて成り立つ。
6. **同期ブロック時間の結果（テスト計画 §5 L234）**: 指紋は、現行ツリー `d07b6077…`、main（`phase4/main_tree`）`a0ee7d59…`、計測コード `a06e9e63…` で、状態ファイルの値と一致する。保存した 21 回（Sun+Earth・7 天体が各 6 回、ほかが各 3 回、5,208 件、最小 108.4 ms）は全回が `checkRound` を通る。統計量の独立な再計算（`gate4_it1/indep_stats.py`。ハーネスを使わない）は Iteration 1・2 と同じ値（最大比 Sun+Earth 1.3281・7 天体 1.2444・`SOLAR_SYSTEM` 1.2218・`BINARY_SYSTEM` 1.2537・`THREE_BODY` 1.2532、受入基準 2 は Sun+Earth 695.6 ms・7 天体 1,098.4 ms・`SOLAR_SYSTEM` 3,074.0 ms、先後は回の番号どおり）で、§5 の値と一致する。
7. **リリース前の確認（Iteration 2 以降の変更分）**:
   - デバッグ用のコード: 変更した 2 ファイルに `debugger`・`TODO`・`FIXME`・`XXX` はなく、`console.log` は結果の行の出力（`rollout_timing.mjs:415`）と、`unit/11` L632 の子プロセスに渡す文字列だけ。
   - 秘密・個人情報: 変更した 5 ファイルに鍵・トークン・パスワード・メールアドレス・作業領域の絶対パスはない。作業領域の絶対パスは、本ファイル（本監査の追記の前で 19 行）と見直しの入力 L57 のまま。
   - コミットしてはならないファイル: `git status --porcelain` は Iteration 2 の終了時と同じ 86 行（追跡されていない 34 項目）で、ログ・状態ファイル・一時ファイル・カバレッジの出力は作業ツリーにない。
   - 文書の整合: 設計書の表題・L3 の Rev 6.21（2026-11-23 07:33 JST）・§4 の見出し L334・最終改訂 L336・§4.12 の見出し L462 は互いに一致し、テスト計画 L3 は Rev 6.21。保存時刻は設計書・README が 07:33:53、テスト計画が 07:41:49。Rev 6.21 の「判定側の全行への機械的な変異で取りこぼしを確かめた」は、07:33 の時点で作業者の `run2`（07:12〜07:18）・`run3`（07:20〜07:28）が済んでおり、§5 L232 が引く最後の `run4`（07:33:28〜07:41:31）の数はテスト計画（07:41:49 の保存）が書くため、矛盾しない。件数（unit 887 = 878 + 9、全体 1,635 = 1,626 + 9、284 スイート、`unit/11` 51 = 26 + 16 + 9）、カバレッジ、d2・s2、計測の値は本監査の実行・作業者のログと一致する。経緯の 4（L222）の時刻 07:29〜07:33（ログの時刻 07:29:03〜07:33:12）は `g4fix2` のログ（`reeval3.log` 07:29:03 〜 `s2.log` 07:33:12）と一致し、`run4` はその後に始まっていて重い処理は重なっていない。「開始時の load average 5.25」はログに記録がなく確かめられない（同じ時刻に上の残ったプロセスが動いていたことと矛盾しない）。§5 L232 の 2 件の理由に誤りがある（G4-3-02）。
   - 範囲の決定の適用: 本ラウンドの差分は、本ブランチで追加した計測スクリプトとそのテスト・文書だけで、main と共通の不具合（見直しの入力 §3）に当たるものはない。G4-3-01〜03 も本ブランチで追加したテスト・文書のもので、本ブランチで直す対象である。

G4-2-01〜03 で指摘した項目はすべて直っている。工程 4 の結果（機械的チェック・全テスト・E2E・カバレッジ・d2・s2・同期ブロック時間）も再現・再計算で確かめられた。一方、`unit/11` の子プロセスの同期の待ちにはタイムアウトがなく、計測スクリプトのループが終わらなくなる退行では `npm test` が失敗せずに止まる（G4-3-01。G3-1-07 と同じ型で、作業者の変異の実行から残ったプロセスが実際に 1 時間以上動き続けている）。また、テスト計画 §5 の変異の行の理由 2 件（G4-3-02）と、`unit/11` のコメント 1 件（G4-3-03）が事実と違う。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G4-3-01 [Minor]【実装】 `unit/11` の子プロセスの同期の待ち（`spawnSync`）にタイムアウトがなく、計測スクリプトが終わらなくなる退行では `npm test` が失敗せずに止まる（`run_all.mjs` の 1 件 300 秒のタイムアウトも効かない）
- **箇所**: [`testsuites/unit/11_perf_rollout_timing.test.mjs`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) の `spawnSync` の 4 か所: L576（`Command line` の `run`）、L631（`-e` からの読込）、L765（`Measuring loop` の `run`）、L801（実際の load average の経路）。関係する記述: [`testsuites/README.md`](../../testsuites/README.md) L210、テスト計画 L74（G3-1-07）
- **現象**:
  - 4 か所とも `timeout` を渡さない。`spawnSync` は待つ間テストのプロセスのイベントループを止めるため、Node のテストランナーの `--test-timeout`（`run_all.mjs` は 300,000 ms）は発火しない。
  - 再現（`probe/hang/`）: 計測のループの条件 L396 を `budget > 0 || …` にした複写で `node --test --test-timeout=10000` を実行すると、10 秒を過ぎても終わらず、50 秒の時点で計測スクリプトの複写と子プロセスが回り続けていた（本監査がプロセスグループごと止めた）。
  - 作業者の変異 321 件のうち 3 件（L247・L396・L409）がこの形で止まる。作業者の `run4` は外側の 90 秒で打ち切ってタイムアウトとして検出に数えた。最初の `run1` では直下のプロセスだけを止めたため、`node --test` の 3 本と計測のループが 08:09 の時点で 1 時間以上動き続け、1 本は RSS 654 MB まで増えている。止まったテストの `after` も実行されず、`/tmp/rollout-timing-unit-*` が残る。
  - README L210 は「`run_all.mjs` はテスト 1 件あたり 300 秒のタイムアウトを付けて実行します（応答のない処理で実行全体が止まらないようにするため…）。タイムアウトしたテストは `cancelled` に数えられ、終了コードは 0 以外になります」と書くが、`unit/11` のこれらのテストでは成り立たない。
  - G3-1-07（独立監査3 Iteration 1、【実装】）は「退行するとテストが失敗せずに止まる」ことを指摘し、その対応で `run_all.mjs` に 1 件 300 秒のタイムアウトが加わり、非同期のテストは個別のタイムアウトを持つ。子プロセスを同期で待つ回帰 11 も `spawnSync(…, { timeout: 60000 })` とする。工程 4 で加えた `unit/11` だけがこの対策を持たない。
- **影響**: 計測スクリプトの判定・ループ・保存を壊す退行のうち、ループが終わらなくなるもの（3/321 の実例がある）を、`npm test` は失敗として報告せず無期限に止まる。CI ではジョブの打ち切りまで止まり、手元では残ったプロセスがメモリと CPU を使い続ける（このマシンは 7.6 GB）。誤った PASS にはならず、工程 4 の結果にも影響しない。
- **修正方針**: 4 か所の `spawnSync` に `timeout`（回帰 11 と同じ 60,000 ms など。`unit/11` の 1 回の実行は 1 秒未満）を渡し、タイムアウトしたとき（`r.error` が `ETIMEDOUT`、`r.signal` が `SIGTERM`）に失敗として報告する（例えば `run` の中で `assert.equal(r.error, undefined)`）。計測スクリプトの `measure`（L155）は計測コードの指紋に入るため変えない（変えると保存した 21 回を再評価できなくなる）。修正後に、作業者のタイムアウトの 3 件（L247・L396・L409）が `node --test` で、タイムアウトの範囲内で失敗として終わり、プロセスと一時ディレクトリを残さないことを確かめる。テスト計画 §5 L232 の「タイムアウト 3 件を含む」は、修正後の結果に合わせて直す。
- **分類**: 【実装】。テストの変更が必要。README L210 の記述を狭めて済ませると、G3-1-07 で確立した「退行したテストは止まらずに失敗する」を `unit/11` だけ外すことになるため、文書の訂正では解消しない（§4 の 5 の 1。迷う場合は【実装】）。

#### G4-3-02 [Minor]【文書】 テスト計画 §5 の変異の行が、生き残った変異の理由として事実と違う一般化を書いている（「単体テストで区別できない」「どの既定でも使い方の誤り」）
- **箇所**: [`2026-11-20_trajectory_fx_flightplan_test_plan.md`](../design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §5 L232（「計測スクリプトの判定の有効性」の「残る 10 件」）。対象のコードは [`rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) L313（`sampleLoad`）・L366（`intOption`）
- **現象**:
  1. 1 分平均を 5 分平均にする変異（L313 `os.loadavg()[0]` → `[1]`）を「単体テストで区別できない 1 件（…どちらも実際の負荷で、テストからは値を決められない）」とする。しかし、親のプロセスに `node --import <ファイル>` で `os.loadavg` を差し替えるモジュールを読ませれば、値を決めて区別できる（上記 5、`probe/loadavg_stub.mjs`: 現行 `[0.25, 0.25]`、変異 `[7.5, 7.5]`）。なお `unit/11` L797 の名前は「samples the 1-minute load average when no test load is set」だが、確かめるのは試験用の負荷を使わない経路（警告と `testLoad` がない、値が有限で負でない）だけで、この変異も通る。この変異が生き残ること自体は、設計書 L478 の「実際の計測時間と負荷の値は確かめない」の範囲内である。
  2. L366 の変異（値のない指定の既定 `''` → `'_x'`）を「値のないオプションの既定の文字列（どの既定でも使い方の誤り）」とする。変異そのものは等価だが、「どの既定でも」は誤り。数の文字列（Rev 6.20 までのコードが `argValue('--rounds-heavy', 6)` で使っていた形）を既定にすると、最後の引数の `--rounds-heavy`（値なし）が受け付けられる（本監査の確認: 現行は終了コード 2 と使い方、既定 `'6'` の複写は終了コード 3 で評価に進む）。
- **影響**: 判定・計測・テストには影響しない。構造の見直しで計測スクリプトを再利用するとき、5 分平均の取り違えを検出する手段がないと読み違える、既定の文字列を変えても安全だと読み違える。
- **修正方針**: L232 を事実に合わせる。例えば (1)「`unit/11` は区別しない 1 件（負荷の標本を 1 分平均から 5 分平均に変える。設計書 §4.12 は実際の負荷の値を確かめないとする。`--import` で `os.loadavg` を差し替えれば区別できる）」、(2)「値のない指定の既定の文字列（既定が整数の文字列でない限り使い方の誤り）」。`unit/11` L797 の名前を確かめる内容に合わせる、または `os.loadavg` を差し替えて 1 分平均を確かめるテストを加えるのは任意（テストの変更。G4-3-01 の修正と同時に行うなら妨げはない）。§4 の 5 の 3 により、設計書の改訂履歴に指摘 ID と修正内容を記録する。
- **分類**: 【文書】。テスト計画の記述の訂正だけで、実装・テストの変更を必要とせず、設計書の要求（負荷の値は確かめない）も満たされたまま。

#### G4-3-03 [Minor]【文書】 `unit/11` L433 のコメントが「区切りがあるので内容は衝突しない」と書くが、ツリーの指紋は NUL を含む内容で衝突する
- **箇所**: [`testsuites/unit/11_perf_rollout_timing.test.mjs`](../../testsuites/unit/11_perf_rollout_timing.test.mjs) L433-439（`changes with a file content, a renamed file, an added preset or a missing helper` の最後の例）。対象は [`rollout_timing.mjs`](../../testsuites/perf/rollout_timing.mjs) の `treeFingerprint`（L293-297）
- **現象**: コメントは「Each file is framed (path, NUL, content, NUL), so a content that looks like the next path cannot collide.」と書く。区切りは NUL だけで長さを含まないため、内容が「NUL・次のパス・NUL」を含めば衝突する。本監査の確認: `scripts/x.js` = `A`・`scripts/y.js` = `B` のツリーと、`scripts/x.js` = `A\0scripts/y.js\0B` だけのツリーが同じ指紋（`3d71d140…`）になる。L438 の例は先頭の NUL を欠く内容（`Ascripts/y.js\0B`）で、衝突しない場合だけを確かめている。作業者の申告の「指紋の区切り（framing）のテスト」はこの例である。
- **影響**: 実際にはない（`scripts/`・`presets/` はテキストで、この形の NUL を含む変更は偶然には起きない。保存した 21 回の指紋は Iteration 1 の独自の実装でも一致）。ただし、テストのコメントがテストの確かめる範囲より強い性質を主張している。
- **修正方針**: コメントを確かめる内容に合わせる（例:「次のパスを NUL の区切りなしに含む内容は 2 つのファイルと区別される。内容が NUL の区切りを含めば区別できないが、ソースのテキストでは起きない」）。指紋の形式（長さを含む区切りなど）は、変えると保存した 21 回の指紋 `d07b6077…`・`a0ee7d59…` が変わり再評価できなくなるため、本ブランチでは変えない（§4 の 4）。
- **分類**: 【文書】。テストファイルのコメント（動作と型チェックに影響しない記述）の訂正だけで、設計書の要求（変わったツリーでの再開の拒否）も、通常の変更に対しては満たされたまま。

---

### 2. 前イテレーションの指摘の解消確認

独立監査4 Iteration 2（FAIL）の指摘 G4-2-01〜03 を、コード・テスト・文書・変異の再実行・保存した回の再評価・作業者のログと突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G4-2-01 `unit/11` が測ったツリー・順序・ワールド、受入基準 2 の終了コード、回数の下限を確かめない（変異 7 件の生き残り） | ✓ 解消 | (1) 偽のツリーの区別: `mkFakeTree(root, name)` の模擬のモジュールが子プロセスごとに「ツリーの名前 `--world`」を記録し、L772-795・L823-835 が記録の並びを回の番号どおりの先後・ツリー・ワールドと比べる。<br>(2) 受入基準 2 の終了コード: L691-708 が Sun+Earth 1,001 ms・7 天体 2,001 ms で終了コード 1 と「criterion2 NG」、1,000 ms・2,000 ms で 0、`SOLAR_SYSTEM` 5,000 ms で 0 を確かめる。<br>(3) 回数の下限: L721-737 が `5`・`2`・`7.5`・`x`・`0`・値なしを使い方の誤りとし、`8`・`4` で未完了（3）、既定と `6`・`3` で 0 を確かめる。設計書 L478 も「6 以上・3 以上の整数、それ以外は使い方の誤り」に改めた。<br>(4) 標本の時点: L812-821 が、子プロセスが増やすファイルを試験用の負荷にして `[[0, 1], [2, 3]]` を確かめる。<br>(5) Iteration 2 の X1〜X7（と X6b・X7b、L10 の当て直し）はすべて検出される（上記 5）。`runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` は変わらず、計測コードの指紋 `a06e9e63…` のまま保存した 21 回を再評価でき、出力は同じ。<br>(6) 設計書 L478・README L97・テスト計画 §5 L232 は加えたテストに合わせて書き直された。<br>注: 修正方針 1 の「子が `--worlds` のワールドで配置したこと」は、子に渡した引数の記録として実装された（設計書 L478 はこの範囲を定める）。子の中での配置などの対応（`runChild`）は `unit/11` の範囲外で、R1〜R8・R10 が生き残る（§4 の 3）。L778 の条件付きのアサーションは残る（修正方針の「固定できる」は任意。終了コードの 0 と 1 の区別は L652-719 が決定的に確かめる。§4 の 4） |
| G4-2-02 受入基準 1 が main の最小値 0 ms の構成を黙って除く | ✓ 解消 | (1) `statistic` は main の最小値が正でない構成を比 `Infinity` として受入基準 1 に入れ（L176-179）、設計書 L479（Rev 6.21）がその扱いを定める。修正方針の 2 つ目の選択肢で、`checkRound` は 0 ms を引き続き有効とする（設計書 L478 の「有限で負でない時間」と一致）。<br>(2) `unit/11` L233-250 は main 0 ms・値なし・0/0 の比を `Infinity`、`evaluateWorld` の受入基準 1 を不成立、結果の行を `maxRatio=Infinity` とし、L710-719 は CLI の終了コード 1 と「criterion1 NG」を確かめる。期待値は設計書の定義から作られている。<br>(3) 0 の main を除く・比 0 にする・`b >= 0` で割る・無限大の比を最大から除く・最小値 0 を次の回で置き換える変異（Y1〜Y4）と Iteration 1 の受入基準 2 の除外（L12 の当て直し）はすべて検出される。<br>(4) 保存した 21 回の最小は 108.4 ms で、再評価の出力は同じ |
| G4-2-03 テスト計画 §5 の E2E の残留物の説明と経緯の 3 の時刻 | ✓ 解消 | (1) L230 は、`leftovers=1` を「記録に使ったスクリプト（`scratchpad/phase4/run.sh`）の作成と起動を 1 回のコマンドで行ったため、起動したシェルのコマンド行がパターンを含み、`pgrep -fc gravsim-e2e-` がそのシェルに一致した」と説明する。`run.sh` の更新時刻 16:07:11.48 が開始の記録 16:07:11 と同じ秒であること、Iteration 2 の再現（パターンを含まないコマンド行から起動すると 0、含むと 1）と整合する。本監査の E2E の前後でも Chromium は 0 だった。<br>(2) L221 の経緯の 3 は 06:25〜06:29（ログの時刻 06:25:31〜06:29:13）になり、`g4fix/reeval2.log`（06:25:31）〜`s2.log`（06:29:13）と一致する。経緯の 3 に加えた値（1,626/1,626、67.7 s、分岐 93.04%、d2・s2 一致、再評価の出力は同じ）も `g4fix/` のログと一致する。<br>(3) 設計書の改訂履歴 L3 の Rev 6.21 に G4-2-03 の訂正が記録されている（§4 の 5 の 3） |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 子プロセスを同期で待つテストにタイムアウトがない（G4-3-01） | `testsuites/` で `spawnSync`・`execSync`・`execFileSync` を使うのは `unit/11`（4 か所、すべて `timeout` なし）と回帰 11（L117、`timeout: 60000`）だけ。`run_all.mjs` は `spawn`（非同期）で、E2E（`cdp_helpers.mjs`）は待機ごとに上限を持つ（G3-1-07 で確認済み、本ラウンドで変更なし）。計測スクリプト自身の `measure`（L155）も `timeout` を持たないが、`npm test` の外の実計測で、計測コードの指紋に入る | **要**（G4-3-01。`measure` は §4 の 4） |
| 変異を等価・区別できないとした理由が事実と合うか（G4-3-02） | §5 L232 の生き残り 10 件の理由をすべて確かめた（上記 5）。誤りは 5 分平均と L366 の「どの既定でも」の 2 件。L439 の「どの既定でも自身のパスと一致しない」は自身の実パスを既定にする場合を除いて成り立つ。経緯の 3 の時点の 67 件の等価 3 件（L13・L21・P8）は、本監査も等価と判断した | **要**（G4-3-02） |
| テストのコメント・名前が、確かめる範囲より強い性質を書く（G4-3-02 の 1、G4-3-03） | `unit/11` の 51 件のコメントと名前をすべて読んだ。L433 のコメント（区切り）と L797 の名前（「1-minute」）のほかは、確かめる内容と一致する。`treeFingerprint` の「absent」の印（L295）も、内容 `\u0001absent` のファイルとは区別できないが、どの文書・コメントも区別できるとは書いていない（L432 の「missing file differs from an empty one」は成り立つ） | **要**（G4-3-02・G4-3-03） |
| 設計書ではなく実装の動作から期待値を取る | `unit/11` の 51 件のうち、新しい 12 件の期待値は設計書 §4.12（無限大の比、6・3 以上の整数、1 s・2 s の境界、既定の 5 ワールドと 4 方位、先後、各ツリーの前の標本、3 倍の上限）とヘッダ（終了コード）から作られている。結果の行の書式（L300-312）・同じ値のときに最初の構成を報告すること（L252-261）・1 回だけのときの空の前半の統計量 0（L304-307）は、設計書に定めのない表示・端の扱いを実装から固定したものだが、判定は変えない（1 回では規定回数 3 以上を満たさず完了しない） | 不要 |
| 試験用の仕組みが実計測に入る | `ROLLOUT_TIMING_TEST_LOAD`（数・`@<ファイル>`）は状態ファイルに記録され、実測の状態とは相互に再開を拒否する。`FAKE_*` は `TMP` の模擬のモジュールだけが読む。`--state` なしの実計測で設定されると結果の行に印がない（Iteration 2 の §4 の 4 のまま） | 不要（§4 の 4） |
| 計測コード（`runChild`・`measure`）の動作がテストされない | R1〜R8・R10 が生き残る（上記 5）。設計書 L478 は実際の計測を `unit/11` の範囲外とし、保存した 21 回は指紋で Iteration 1 が読んだコードによることが保証される | 不要（§4 の 3） |
| 文書の数・時刻とログの突合 | 本ラウンドで変わった文書の行（設計書 L1・L3・L334・L336・L462・L478・L479、テスト計画 L3・L86・L98・L221・L222・L224・L229-234、README の変更箇所）をすべて読み、値・時刻を本監査の実行と作業者のログ（`g4fix/`・`g4fix2/`・`phase4/`）と照合した。誤りは G4-3-02 の 2 か所だけ | **要**（G4-3-02） |
| Lint の警告・デバッグ用のコード・秘密・コミットしてはならないファイル | 警告 54 件は Iteration 2 と同じ 16 ファイル。そのほかは上記 7 で、該当なし | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件 | 不要 |
| 中断しない経路への影響 | 本体は独立監査3 Iteration 6 から変わらず、d2（35 構成）・s2（15 機）の md5 が一致 | 不要 |
| 見直しの入力 §3 の行 | 本ラウンドで変更なし（md5）。本ラウンドの差分と指摘は本ブランチで追加した計測スクリプトのテストと文書のもので、main と共通の不具合ではない | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G4-3-01〜03 の修正と再監査**:
   - 判定は FAIL のため、工程 4 に差し戻して直し、独立監査4 Iteration 4 を受けること。修正は `unit/11`（`spawnSync` のタイムアウト、任意で L797）とテスト計画 §5 L232・`unit/11` L433 のコメントだけで、本体・プリセット・計測スクリプト・ほかのテストは変わらないはずである。
   - 次の 4 点で確かめられる: d2・s2 の md5、`npm test` の件数（1,635 のまま、またはテストを加えた分だけの差）、保存した 21 回（`phase4/perf_state.json`）の `--max-rounds 0` の再評価の出力が同じこと、作業者のタイムアウトの 3 件（L247・L396・L409）が `node --test` で失敗として終わりプロセスを残さないこと。
   - 計測スクリプトの `runChild`・`measure`・`MISSIONS`・`NEAR`・`MO` と `treeFingerprint` の形式は変えないこと（変えると指紋 `a06e9e63…`・`d07b6077…`・`a0ee7d59…` が変わり、保存した回を再評価できなくなる）。
2. **残ったプロセスと一時ディレクトリの片付け**: 作業者の `g4fix2/auto/run1` から残ったプロセス（プロセスグループ 3595950: `node --test` の PID 3636869・3741875・3749761 と、その下の計測スクリプトの複写と子プロセス）が、08:09 の時点で 1 時間以上 CPU 1〜2 コアを使い、1 本は RSS 654 MB で増え続けている。本監査は起動していないため止めていない。作業者が止め（例えば `kill -- -3595950`）、`/tmp/rollout-timing-unit-*` の 12 個を消すこと。止めるまでは、時間に依る結果（計測を含む）にこの負荷が入る。変異の実行では、タイムアウトでプロセスグループごと止めること（`run1` の形は残る）。
3. **計測コードの動作のテスト**（指摘ではない）: `unit/11` の模擬の `ObjectPlacer`・`presetManager`・`RocketLauncher` は配置・プリセット・期間・方位を記録しないため、`runChild` の対応（`SOLAR_SYSTEM`・`BINARY_SYSTEM`・`THREE_BODY` の配置、7 天体の惑星、期間・方位・機体の適用、時間の測り方）と `measure` の作業ディレクトリ（main がプリセットを main のツリーから読む）を壊す変更（R1〜R8・R10）を `npm test` は検出しない。設計書 L478 の範囲の外で、保存した 21 回は指紋で保証されるが、構造の見直しで計測スクリプトを変更・再利用する場合は、模擬のモジュールが呼び出しを記録する形のテストを加えること。
4. **計測スクリプトの定義されていない動作**（指摘ではない。Iteration 2 の §4 の 4 から引き続き）:
   - `unit/11` L778 は 3 回目の実行の終了コードとして 0 と 1 の両方を受け付ける（模擬の時間が実時間のため）。ツリーごとに時間を決める模擬にすれば固定できる。
   - `measure`（L155）は子プロセスを待つ上限を持たず、実計測で子が止まると計測全体が止まる（計測コードの指紋に入るため本ブランチでは変えない）。
   - `treeFingerprint` は NUL だけで区切るため、NUL を含む内容では区別できない（G4-3-03）。見直しで再利用するなら、長さを含む区切りにすること。
   - 方位の重複・数でない方位は 1 回を測った後に `checkRound` が止める、`ROLLOUT_TIMING_TEST_LOAD` を設定したまま `--state` なしで実計測すると結果の行に印がない、計測コードの指紋は Node の版を含まない。
5. **マージの前の確認**（Iteration 2 の WP2・WP3、引き続き有効）: 追跡されていない 34 項目をすべてコミットに含めること。同期ブロック時間の証跡（`phase4/perf_state.json`、md5 `db6c2be3…`）、main のツリー（`phase4/main_tree`）、d2・s2 のスクリプトと期待値は作業領域にしかなく、再起動や片付けで消える。マージの前に残し方を決め、構造の見直しの工程 1 でリポジトリに移すこと。
6. **作業領域の絶対パス**（Iteration 1 の WP3）: 本ファイル（本監査の追記の前で 19 行。本監査の追記にも 1 行）と見直しの入力 L57 に、利用者名を含む作業領域の絶対パスがある。リポジトリを公開する場合は扱いを決めること。
7. **`npm run check` の環境と分岐カバレッジ**（Iteration 1 の WP5・WP6）: 全体にインストールされた ESLint 6.4.0・TypeScript 7.0.2 に依存する。分岐カバレッジは本監査で 93.10% で、目標 97% は行・関数だけが満たす。構造の見直しで扱うこと。
8. **引き続き有効な Watchpoint**: 独立監査4 Iteration 1 の WP7 に挙げたもの（独立監査3 の各 Iteration の WP、lint 警告 54 件）。重い処理（全スイート・E2E・カバレッジ・変異・計測）を同時に走らせないこと。

---

## 独立監査4: 最終総合監査 — Iteration 4

- **対象ゲート**: 独立監査4: 最終総合監査
- **イテレーション番号**: Iteration 4
- **実施日時**: 2026-11-23 08:47〜09:22 JST（停止なし。重い処理はすべて 1 つずつ順に実行した）
- **判定**: **PASS（文書指摘あり）**（【文書】Minor 1 件。【実装】なし）

ブランチ `feat/trajectory-fx-flightplan` の未コミット作業ツリー（HEAD `0e453a8` = `main`）を、[`docs/development_process.md`](../development_process.md) §2・§3.4・§4、設計書 Rev 6.22（G4-3-01〜03 の反映と E2E の Chromium の起動フラグ）、テスト計画（§5 を作業者の申告として扱う）、[構造の見直しへの入力](../design/2026-11-21_architecture_redesign_inputs.md)（以下「見直しの入力」）、`testsuites/README.md`、独立監査4 Iteration 1〜3 の記録に照らして、ゼロベースで検証した。作業者の申告は前提にしていない。範囲の決定（main でも起きて本ブランチが原因でない不具合は見直しの入力 §3 に記録して別ブランチで直し、本ブランチの退行と、利用者が範囲に加えた設計書 §4.13 の既存の不具合は本ブランチで直す）は利用者の判断として扱い、その適用を確かめた。

- **差分の特定**: Iteration 3 が監査したツリー（`scratchpad/gate4_it3/pristine`）と現行ツリーを `diff` で比べ（`gate4_it4/diffs/`）、Iteration 3 の終了時の md5（`gate4_it3/md5_end.txt`、487 件）と本監査の開始時の md5（`gate4_it4/md5_start.txt`、487 件）を突き合わせた。変わったのは次の 5 ファイルだけである。
  - `testsuites/unit/11_perf_rollout_timing.test.mjs`: 51 → 52 件（9 → 10 スイート）。時間制限付きの起動 `spawnNode`（L132-141。`timeout` 60,000 ms、`killSignal: 'SIGKILL'`、`r.error` を投げる）と、そのテストのスイート「Test helpers」（L150-158）を追加。`spawnSync` を直接呼んでいた 4 か所（`Command line` の `run` L599、`-e` からの読込 L654、`Measuring loop` の `run` L788、1 分平均のテスト L827）をすべて `spawnNode` に置き換えた。1 分平均のテスト（L820-836）は `--import` で `os.loadavg` を `[0.25, 7.5, 9.75]` に差し替え、進行の行の `load 0.25` と標本 `[0.25, 0.25]` を確かめる形にした（消えたアサーションは「標本が 2 つ・有限で負でない」の 2 行だけで、より強い `deepEqual` に置き換わった）。指紋の区切りのコメント（L454-456）を訂正。テスト名の比較で、追加は「fails a hung child with ETIMEDOUT instead of waiting for it」の 1 件だけ。
  - `testsuites/system/cdp_helpers.mjs`: `CHROME_BASE_FLAGS` に `--disable-audio-output`（L210）と、その理由のコメント（L187-190）を追加。ほかの行は同じ。
  - 設計書: 表題 L1・改訂履歴 L3 の末尾への Rev 6.22 の追加（Rev 6.21 までの部分は同じ）・§4 の見出し L334・最終改訂 L336。
  - テスト計画: L3・§4.1 L86・L98、§5 L222（経緯の 4）・L223（経緯の 5 を新設）・L225・L230-235。
  - README: L33・L97・L125・L146・L193-202・L219・L245・L252-253・L270。
  - 本ファイルは Iteration 3 の追記の後の md5 のまま。`scripts/`・`presets/`・`index.html`・`style.css`・設定・見直しの入力・`testsuites/perf/rollout_timing.mjs`（md5 `d077898c…`）・ほかのテストは Iteration 3 のツリーとバイト単位で同じ。`scripts/`・`presets/`・`index.html`・`style.css`・設定は独立監査3 Iteration 6 の終了時（`gate3_it6/md5_end.txt`）とも同じで、`testsuites/system/` でそれ以後に変わったのは `cdp_helpers.mjs` だけ（md5）。変更行はすべて読んだ。
- **変更していないもの**: ソース・テスト・プリセット・設定・設計書・テスト計画・見直しの入力は一切変更していない。監査開始時（`gate4_it4/md5_start.txt`、487 件。`.git` を除く全ファイル）と終了時（`md5_end.txt`）で、本ファイル以外の全ファイルの md5 が一致することを確かめた。本ファイルは追記のみで、既存部分 3,541 行は追記前（`review_before_append.md`、md5 `eac0aae1…`）と同一。git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 86 行（追跡されていない 34 項目））も変えていない。監査開始時の作業ツリーの完全なコピーを `gate4_it4/pristine` に置いた。
- **負荷とメモリ**: 16 コア・メモリ 7.6 GB。開始時（08:47）の load average は 4.27（1 分）で、別のプロジェクトのテストと変異のプロセスが監査の間ずっと 1〜2 コアを使っていた（本監査は止めていない）。Iteration 3 が記録した作業者の残りのプロセス（プロセスグループ 3595950）は存在せず、`/tmp/rollout-timing-unit-*`・`/tmp/gravsim-*` は開始時に 0 個だった。重い処理（機械的チェック、`unit/11` の単独実行、`npm test`、カバレッジ、d2、s2、同期ブロック時間の評価）は 1 本のスクリプト（`run_checks.sh`）で順に実行し、各段の後の load average・空きメモリ・残留物を `checks/status` に記録した（load average は `npm test` の後に最大 11.8、空きメモリは 2,411 MB を下回らなかった）。続いて、止まる変異の 3 件（3 並列）、E2E 5 回、音声の調査 6 回、変異の全件（3 並列）、止まる子プロセスの調査、`npm run test:unit` を 1 つずつ実行した（load average 3.3〜8.2）。
- **補助エージェント**: 起動しなかった。
- **スクリプト・ログ**（すべて `/tmp/claude-1000/-home-k-workspace-gravsim/921029b3-8449-4810-a179-0ffe89eacade/scratchpad/gate4_it4/`）: `run_checks.sh`・`checks/`、`hang/`（止まる変異の調査 `run_hang.py`・各ログ・`results_L247_L396_L409.json`）、`sys/`（E2E の `run_sys.sh`・`run_sys_b.sh`・`sys1〜5.log`・`status`）、`audio/`（`probe.mjs`・`hung_server.py`・結果の JSON）、`mut/`（`gen_run_audit.py`・`out/results.json`・`run.log`）、`orphan/`（`run_orphan.py`・`result.json`）、`diffs/`、`pristine/`、`it4_names.txt`。

**機械的チェック・テスト実行結果**（テスト計画 §5 と比較）:

| チェック | コマンド | 結果 |
|---|---|---|
| 構文・Lint・型 | `npm run check` | 終了コード 0（7.6 s）。Lint はエラー 0／警告 54（既存の 16 ファイル。`unit/11`・`perf/rollout_timing.mjs`・`system/cdp_helpers.mjs` は 0 件）。出力は作業者の `g4fix3/check_f.log` とバイト単位で同じ。§5 L229 と一致 |
| 計測スクリプトの単体テスト | `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` | 52/52 pass（10 スイート、4.1 s、load average 2.5）。一時ディレクトリは増えない |
| 全テスト | `npm test` | **1,636/1,636 pass**・fail 0・cancelled 0・skipped 0・todo 0（285 スイート）、74.4 s（load average 2.5 → 11.8）。§5 L230 と一致（1,635 + 1）。`npm run test:unit` は 888/888（106 スイート、15.2 s）で README L33 と一致 |
| カバレッジ | `npm run test:coverage` | 1,636 pass（107.2 s）。**行 99.36%・分岐 93.02%・関数 97.34%**（§5・README は分岐 93.06%。差 0.04 ポイントは §5 L232 が書く揺れ（0.1 ポイントほど、92.97〜93.06%）の範囲内）。最低 90% を満たす。README のファイルごとの表（42 ファイルと全体）は作業者の `g4fix3/coverage_f.log` と全行一致する |
| 中断しない経路の一致 | 作業領域の `perf/d2.mjs`（`WORLDS=SE,W7,SS,BIN,TB`）・`gate2_it2/s2_flights.mjs`（`GS_ROOT` = 作業ツリー） | **一致**: d2 `2e22aefa3a20913ea507399278276b26`（28.8 s）、s2 `91c5b9816a026dec4be5e3648cfd4948`（8.0 s）。stderr は空 |
| 同期ブロック時間（評価のみ） | `phase4/perf_state.json` のコピー（md5 `db6c2be3…`）に `--baseline phase4/main_tree --max-rounds 0` | 終了コード 0、計測なし（0.07 s）、stderr は空。出力 5 行は分割実行の最後の評価（`phase4/perf_final.log`）・作業者の `g4fix3/reeval.log` とバイト単位で同じ。コピーの md5 は評価の後も同じ |
| E2E | `npm run test:system` × 5 | 5 回とも **41/41 pass**・skipped 0・cancelled 0（50.3〜51.4 s、load average 3.3〜8.2）。`npm test`・カバレッジの中の 2 回と合わせて 7 回、失敗なし。どのログにも「AudioContext encountered an error」はない。各回の後に `/tmp/gravsim-*` は 0。`gravsim-e2e-` のプロファイルの Chromium は、パターンを含まないコマンド行から起動した 4・5 回目の後に 0（1〜3 回目は記録用のスクリプトの作成と起動を 1 回のコマンドで行ったため、起動したシェル自身が数えられて 1 と記録された。G4-2-03 と同じ現象で、3 回目の直後の `ps` で該当するプロセスがないことを確かめた） |

`skip`・`todo`・`.only`・`assert.ok(true)` は `testsuites/` 全体で 0 件（grep）。`unit/11` の条件付きのアサーションは L801 の 1 件（3 回目の実行の終了コード。Iteration 3 の §4 の 4 から変わらない）。新しいテストのアサーション（`ETIMEDOUT` の例外、10 s 未満で戻ること、正常な子の出力、`[0.25, 0.25]`、進行の行）はどれも空ではない。

**本ラウンドの変更の検証**:

1. **子プロセスの時間制限（G4-3-01）**:
   - `spawnNode` は `spawnSync` に `timeout: 60000` と `killSignal: 'SIGKILL'` を渡し、`r.error`（時間切れでは `ETIMEDOUT`）を投げる。`unit/11` に `spawnSync` を直接呼ぶ箇所は残っていない（`spawnNode` の中の 1 か所だけ）。
   - 止まる変異の当て直し（`hang/run_hang.py`）: Iteration 3 の調査と作業者の `run5` の 3 件（L247 `||` → `&&`、L396 `&&` → `||`、L409 `rounds.push(round)` の削除）を、本監査のツリーのコピー（計測スクリプトだけを変え、`unit/11` は現行）に入れ、`node --test` を `--test-timeout` も外側の時間制限もなしに、それぞれ別のセッションで同時に実行した（安全のための上限 600 s でプロセスグループごと止める仕組みは発火しなかった）。3 件とも終了コード 1 で、123.0 s・124.0 s・125.0 s で終わった（テストランナーの `duration_ms` は 122.6〜123.0 s。load average 6.5 → 6.0）。失敗はそれぞれ 16・11・6 件で、時間切れのテストの誤りは `Error: spawnSync /usr/bin/node ETIMEDOUT`。終わった直後に、そのプロセスグループのプロセスと変異のディレクトリを参照するプロセスは 0、`/tmp/rollout-timing-unit-*` も 0（`after` が実行された）。Iteration 3 では同じ L396 の変異が 50 s を過ぎても終わらなかった。
   - `run_all.mjs` の 1 件 300 秒の制限の下でも、1 件のテストが待つのは最大 2 回（120 s）で、止まらずに失敗する。README L97 の「子プロセスの起動には時間制限があり、止まった子プロセスはテストの失敗になる」と L210 の記述は成り立つ。
   - 計測スクリプトの `measure`（L155）は変わらず（計測コードの指紋 `a06e9e63…` のまま、保存した 21 回を再評価できる）。
2. **1 分平均の負荷のテスト（G4-3-02 の任意の部分）**: `--import` で読ませたモジュールが親プロセスの `os.loadavg` を `[0.25, 7.5, 9.75]` に差し替える。計測スクリプトは `os` の既定のエクスポートを通して呼ぶため差し替えが効き、子プロセス（`--child`）には `--import` が渡らない（負荷の標本は親だけが取る）。設計書 L477 の「1 分平均の load average」から作った期待値で、5 分平均にする変異（L313 `[0]` → `[1]`）は検出される（下記 4）。
3. **E2E の偽の音声出力（`--disable-audio-output`）**: 下記「E2E の失敗と起動フラグの評価」にまとめる。
4. **変異の全件の再実行**（作業者の `g4fix2/auto/gen_run.py` を読み、読み込み元だけを本監査の `pristine` に変えた複写 `mut/gen_run_audit.py`。3 並列、09:05〜09:13、load average 6.3〜6.7）: 候補 331 件、検出 309・時間切れ（90 s）3・構文の誤り 10・生き残り 9 件で、作業者の `run5/results.json` と 331 件すべての変異の内容と判定が一致した。時間切れの 3 件は上記 1 の 3 件で、打ち切らなければ約 123 s で失敗として終わる。生き残りの 9 件は Iteration 3 が判断した 10 件から L313 を除いたもので、等価 8 件（L258・L378・L379・L394・L395・L303・L366・L439）と使い方の文言 1 件（L359）。L313 の 4 件（削除 2・`!==`・`[1]`）はすべて検出される。X1〜X7 はすべて検出される。なお、時間切れの 3 件は 90 s の打ち切りで `SIGKILL` されて `after` が実行されないため、本監査の実行でも `/tmp/rollout-timing-unit-*` が 3 個残った（本監査が消した。§4 の 3）。
5. **リリース前の確認（Iteration 3 以降の変更分）**:
   - デバッグ用のコード: 変更した 2 ファイルの追加行に `debugger`・`TODO`・`FIXME`・`XXX` はなく、`console.log` は `unit/11` L654 の子プロセスに渡す文字列（従来から）だけ。
   - 秘密・個人情報: 追加行に鍵・トークン・パスワード・メールアドレス・作業領域の絶対パスはない。作業領域の絶対パスは、本ファイル（本監査の追記の前で 20 行。本監査の追記にも 1 行）と見直しの入力 L57 のまま。
   - コミットしてはならないファイル: `git status --porcelain` は Iteration 3 の終了時と同じ 86 行（追跡されていない 34 項目）で、ログ・状態ファイル・一時ファイル・カバレッジの出力は作業ツリーにない。
   - 文書の整合: 設計書の表題・L3 の Rev 6.22（2026-11-23 08:39 JST）・§4 の見出し L334・最終改訂 L336 は互いに一致し、テスト計画 L3 は Rev 6.22。Rev 6.22 は G4-3-01〜03 の ID と修正内容、起動フラグの変更を記録している（§4 の 5 の 3）。保存時刻は設計書・README が 08:39:04、テスト計画が 08:46:11。README の値（1,636、285 スイート、64,777 ms、93.06%、ファイルごとの表）は 08:34:56〜08:37:46 の最後の実行（`g4fix3/run.txt`・`test_f.log`・`coverage_f.log`）と一致し、テスト計画の変異の数は `run5`（08:37:54〜08:45:46。最後の実行の後で、重い処理は重なっていない）と一致する。経緯の 5（L223）の時刻（08:22〜08:26、08:26〜08:29、08:29〜08:31、08:32〜08:34、08:34〜08:37）と各回の結果は `g4fix3/` のログ（`run.txt`・`sys_runs.txt`・`test.log`〜`test3.log`・`sys1〜6.log`・`coverage.log`）の時刻・件数と一致する。経緯の 4（L222）に加えた値（1,635/1,635、78.2 s、93.02%、d2・s2 一致、再評価の出力は同じ）は `g4fix2/` のログと一致し、Iteration 3 が確かめられないとした「開始時の load average 5.25」は削除された。件数は README（regressions 455 + integration 252 + unit 888 + system 41 = 1,636）・テスト計画 L98（52）・§5 と一致するが、テスト計画 §4.1 L86 だけが `unit/11` を 51 件と書く（G4-4-01）。
   - 範囲の決定の適用: 本ラウンドの差分は、本ブランチで追加した計測スクリプトのテスト、E2E の起動フラグ、文書だけで、main と共通の不具合（見直しの入力 §3）に当たるものはない。G4-4-01 も本ブランチの文書のもので、本ブランチで直す対象である。

**E2E の失敗と起動フラグの評価**（依頼された批判的な確認）:

1. **失敗の事実**: 作業者の 08:22 の `npm test`（`g4fix3/test.log`）では、`system/01` の最初のテストの最初のクリック（`clickTab('tab-deploy')`）の `Input.dispatchMouseEvent` が 20 s で時間切れになり、Earth がないまま後続の 7 件が失敗した（ISS・Mars の予測の終了理由が `impact`、Moon の配置の例外「Earth object not found」、破片の待ちの時間切れ、全体の問題の一覧に例外と `[log other] The AudioContext encountered an error from the audio device or the WebAudio renderer.`）。開始時の load average は 0.79 で、高負荷による時間切れではない。作業領域に残る工程 4 のすべてのログ（`phase4/`・`gate4_it1〜3/`・`g4fix/`・`g4fix2/`・`g4fix3/`）で、このメッセージを含むのはこの 1 件だけである。アプリは最初の `click` で `SoundEffects._initAudio` が AudioContext を作り（`gravsim_sound_effects.js` L243-L281）、`AudioManager` は音声の選択まで作らない（`gravsim_tab_system.js` L166-173）ため、「アプリは最初のクリックで AudioContext を作る」は正しい。
2. **原因の仮説の裏付け**（`audio/probe.mjs`。本監査のコピーの `cdp_helpers.mjs` で起動し、GravSim を起動して最初のクリックの時間を測る。フラグなしは `CHROME_BASE_FLAGS` から `--disable-audio-output` だけを除く）:
   - 実際の音声サーバー（WSLg の `PULSE_SERVER=unix:/mnt/wslg/PulseServer`）: フラグなしでは Chromium が音声サーバーにクライアントとして接続し（`pactl list clients` で 2 件）、`outputLatency` 0.192 s（RDP の出力）。フラグありでは接続は 0 件で、`outputLatency` 0.032 s（偽の出力）。どちらも `state` は `running`、`currentTime` は 1 s で 1.001 s・0.998 s 進み、`sampleRate` 44,100、最初のクリックは約 0.1 s。
   - 応答しない音声サーバー（接続を受けて何も返さないソケットを `PULSE_SERVER` にする）: フラグなしでは最初のクリックが **5,104 ms・5,114 ms**（2 回）止まり、その後は出力の遅延が偽の出力と同じ値（`outputLatency` 0.032 s）になって続く。フラグありでは 111 ms・94 ms で、止まらない。2 回目以降のクリックはどれも約 0.07 s。
   - したがって、「ホストの音声の経路が応答しないと、AudioContext を作る最初のクリックがページごと止まり、`--disable-audio-output` はその経路を開かない」という仕組みは再現で裏付けられた。08:22 の失敗の 20 s を超える停止と「encountered an error」の記録そのものは再現していない（本監査の再現は 5 s で、エラーの記録もない）ため、その 1 回の原因がこの経路だったことは、記録の一致と仕組みの再現による推定である。
3. **文書の書き方**: テスト計画 L223 は観察した事実（時間切れ、同じ実行の Chromium の記録、アプリが最初のクリックで AudioContext を作ること、その後の実行で起きなかったこと）と対処を分けて書き、原因を確定したとは書いていない。設計書 Rev 6.22 も「音声デバイスのエラーとともに 20 s 止まった」と書く。README L125（「音声デバイスのエラーで最初のクリックが止まった実行があったため」）と `cdp_helpers.mjs` L187-190 は因果として書くが、上記の再現と矛盾せず、事実と違う記述ではないため指摘としない（§4 の 2）。
4. **E2E の確かめる内容への影響**: `testsuites/system/` の音声に関わるアサーションは、`system/01` L509（燃焼中の `audioCtx.state` が `running`、轟音の `isRunning`）・L517-524（削除後 2 s 以内に轟音が止まり鳴り直さない）、`system/02` L547・L562-579（散水の `isDelugeTriggered`・`isRunning`）、`system/04` L330・L359（`audio:play` のイベント）で、どれもアプリの Web Audio のグラフとイベントの状態を見る。偽の出力でもグラフは描画のスレッドに引かれ、`state` は `running`、時計は実時間で進む（上記 2）ため、これらは同じ意味を保つ。実際の出力の値（`sampleRate`・`baseLatency`・`outputLatency`・`setSinkId` など）を確かめるテストはない（grep）。失われるのはホストの音声デバイスの経路だけで、設計書・テスト計画・§3.3 はそれを E2E の対象にしていない。全体の問題の一覧（L669-672）は引き続きページと Worker の例外・コンソールのエラーを集め、外れるのはホストの音声デバイスに由来する記録だけである。**弱めていない**と判断する。
5. **§3.4 との整合**: 失敗した 1 回をテスト計画 §5 L223・L230・L231 に隠さず記録し、再試行や待ちの延長、アサーションの緩和で吸収していない（`cdp_helpers.mjs` の差分はフラグとコメントだけ）。最後の結果（作業者の 08:34〜08:37 と本監査の全実行）は skip なしで 100% 成功している。テストの外の環境への依存を取り除く変更で、§3.4 と整合する。
6. **フラグの検証の十分さ**: 作業者の検証はフラグを加えた後の成功の回数（`test:system` 3 回、`npm test`・カバレッジ各 1 回）だけで、失敗の頻度（工程 4 のログで 1 回）からは成功の回数で効果を示せない。本監査の再現（上記 2: 接続しないこと、応答しないサーバーでも止まらないこと、グラフと時計が動くこと）と E2E 7 回の成功で、フラグが仕組みを断つことと、E2E の確かめる内容を変えないことは確かめられた。工程 4 で加えたフラグとして十分と判断する。

G4-3-01〜03 で指摘した項目はすべて直っている。工程 4 の結果（機械的チェック・全テスト・E2E・カバレッジ・d2・s2・同期ブロック時間）も再現・再評価で確かめられ、起動フラグの変更は E2E の確かめる内容を弱めていない。残るのは、テスト計画 §4.1 の `unit/11` の件数 1 か所（G4-4-01、【文書】）だけである。

---

### 1. 要修正箇所（Findings / Required Fixes）

#### G4-4-01 [Minor]【文書】 テスト計画 §4.1 L86 が `unit/11` の件数を 51 件のまま書いている（内訳の和と全体の件数は 52 件）
- **箇所**: [`2026-11-20_trajectory_fx_flightplan_test_plan.md`](../design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §4.1 L86（「工程 4 で計測スクリプトの単体テスト 51 件（…分割実行の追加で 26 件、…G4-1-01・G4-1-02 への対応で 16 件、…G4-2-01・G4-2-02 への対応で 9 件、Iteration 3 の指摘 G4-3-01 への対応で 1 件）を加え、全 1,636 件」）
- **現象**: 内訳の和は 26 + 16 + 9 + 1 = 52 件で、全体の 1,584 + 52 = 1,636 件とも一致する。同じ文書の L98（`unit/11_perf_rollout_timing`（52））、README L97（52）、本監査の実行（52/52、全体 1,636）も 52 件で、L86 の「51 件」だけが Iteration 3 の時点の数のまま残っている。
- **影響**: 判定・テストには影響しない。§4.1 だけを読むと、内訳と合計が合わない。
- **修正方針**: L86 の「単体テスト 51 件」を「単体テスト 52 件」にする。§4 の 5 の 3 により、設計書の改訂履歴に指摘 ID と修正内容を記録する。§4 の 5 の 5 により、修正後に独立エージェントがこの指摘の解消だけを確認し、その結果を本ファイルに追記してから完了とする。
- **分類**: 【文書】。テスト計画の数の訂正だけで、実装・テスト・設定の変更を必要とせず、設計書の要求も満たされたまま（§4 の 5 の 1 の「改訂履歴・見出しの不整合」「転記誤り」に当たる）。

---

### 2. 前イテレーションの指摘の解消確認

独立監査4 Iteration 3（FAIL）の指摘 G4-3-01〜03 を、コード・テスト・文書・変異の再実行・止まる変異の当て直し・作業者のログと突き合わせた。

| ID | 判定 | 確認内容 |
|---|---|---|
| G4-3-01 `unit/11` の `spawnSync` にタイムアウトがなく、計測スクリプトが終わらなくなる退行で `npm test` が止まる | ✓ 解消 | (1) `spawnNode`（L132-141）が `timeout` 60,000 ms・`SIGKILL` で起動し、時間切れを例外にする。4 か所（L599・L654・L788・L827。旧 L576・L631・L765・L801）がすべてこれを使い、`spawnSync` を直接呼ぶ箇所は残っていない。<br>(2) 修正方針の確認: 作業者の時間切れの 3 件（L247・L396・L409）を、外側の時間制限も `--test-timeout` もなしに実行すると、123.0 s・124.0 s・125.0 s で終了コード 1（`ETIMEDOUT` の失敗）になり、プロセスと `/tmp/rollout-timing-unit-*` を残さない（上記 1）。<br>(3) L150-158 のテストが、止まる子プロセス（30 s 待つ子に 300 ms の制限）で `ETIMEDOUT` が 10 s 未満で投げられることと、正常な子の出力を確かめる。<br>(4) テスト計画 §5 L233 の「タイムアウト 3 件を含む」は、「90 s で打ち切った 3 件は、打ち切らなくても…約 123 s で失敗として終わる」に直された（本監査の実測と一致）。README L97 に時間制限の記述が加わった。<br>(5) 計測スクリプトの `measure` は変えず、保存した 21 回の再評価の出力は同じ。<br>(6) Iteration 3 の §4 の 2（作業者の残りのプロセスと一時ディレクトリ）: プロセスグループ 3595950 のプロセスはなく、`/tmp/rollout-timing-unit-*` は開始時に 0 個。テスト計画 L222 がその経緯（08:15 に止めて消した）を記録した。作業者の `gen_run.py` はプロセスグループごと止める形になった |
| G4-3-02 テスト計画 §5 の生き残った変異の理由（1 分平均・L366） | ✓ 解消 | (1) 1 分平均: `unit/11` L820-836 が `os.loadavg` を差し替えて 1 分平均の値を確かめる形になり、5 分平均にする変異（L313 `[0]` → `[1]`）は作業者の `run5` と本監査の再実行で検出される。§5 L233 は生き残りからこれを除き、「`os.loadavg` を差し替えるテストで検出」と書く。<br>(2) L366: §5 L233 は「数でない文字列なので元と同じく使い方の誤りになる。数を表す文字列にすると値のない指定を受け付けるため、どの文字列でも等価というわけではない」と事実に合わせた。L439 も「`'_x'` は自身のパスと一致しない」に狭めた。<br>(3) 残る 9 件の理由（等価 8 件と使い方の文言）は Iteration 3 の判断と一致する。<br>(4) 設計書の改訂履歴 L3 の Rev 6.22 に G4-3-02 の内容が記録されている（§4 の 5 の 3） |
| G4-3-03 `unit/11` の指紋の区切りのコメントが衝突しないと書く | ✓ 解消 | L454-456 は「閉じの NUL が内容と次のパスをつなげないため、この組は異なる。内容自体が NUL の区切りを含めば衝突しうる（ソースとプリセットは NUL を含まない）。指紋は異なるツリーの混在を防ぐもので、作為的なファイルを防ぐものではない」と、確かめる内容と指紋の性質に合わせた。指紋の対象（`scripts/`・`presets/`・`testsuites/test_helpers.mjs`）に NUL を含むファイルはない（grep で 0 件）。`treeFingerprint` の形式は変わらず、指紋 `d07b6077…`・`a0ee7d59…` のまま再評価できる。Rev 6.22 に記録されている |

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| 子プロセスを同期で待つテストにタイムアウトがない（G4-3-01 の再確認） | `testsuites/` で `spawnSync`・`execSync`・`execFileSync` を使うのは `unit/11` の `spawnNode`（`timeout` 60,000 ms）と回帰 11 L117（`timeout: 60000`、時間切れは `status` が `null` で L119 のアサーションが失敗する）だけ。`scripts/` に `child_process` はない。`run_all.mjs` と `cdp_helpers.mjs` は非同期の `spawn` で、それぞれテストごとの制限と待機ごとの上限を持つ。計測スクリプトの `measure`（L155）は制限を持たないが、計測コードの指紋に入る（§4 の 2） | 不要（`measure` の子が止まる場合は §4 の 2） |
| 文書の件数の不一致（G4-4-01） | テスト計画（L86・L98・L230-233）、README（L16・L25・L33・L40・L97・L146・L193-197）、設計書のテストの件数をすべて本監査の実行と照合した。誤りは L86 の 1 か所だけ | **要**（G4-4-01） |
| E2E がホストの環境に依存する | `CHROME_BASE_FLAGS` の各フラグを確かめた。GPU（`--disable-gpu`）、共有メモリ（`--disable-dev-shm-usage`）、鍵の保管（`--password-store=basic`・`--use-mock-keychain`）、音声（今回の `--disable-audio-output`）、背景の制限（3 つの `--disable-background*`・`--disable-renderer-backgrounding`）はすでに外され、配信は `127.0.0.1` の自前のサーバー。プロファイル・crashpad は一時ディレクトリで、残留物はない（5 回とも） | 不要 |
| 環境に由来する失敗を、再試行やアサーションの緩和で吸収している | `cdp_helpers.mjs` に再試行の仕組みはなく、今回の差分はフラグとコメントだけ。E2E の待ちの上限（`DEFAULT_TIMEOUT_MS` 20,000 ms など）は変わらない | 不要 |
| テストの名前・コメントが確かめる範囲より強い性質を書く（G4-3-02・03 の再確認） | `unit/11` の 52 件の名前と、変更された 3 か所のコメント（L132-135・L454-456・L821）を読み、確かめる内容と一致することを確かめた。ヘッダ L8-9 の「`ROLLOUT_TIMING_TEST_LOAD` が標本を固定する」は、`--import` で固定する 1 件を挙げていないが、誤りではない | 不要 |
| 生き残った変異の理由が事実と合うか | 本監査の再実行の生き残り 9 件すべてについて、§5 L233 の理由を確かめた。誤りはない | 不要 |
| 文書の数・時刻とログの突合 | 本ラウンドで変わった文書の行をすべて読み、値・時刻を本監査の実行と作業者のログ（`g4fix2/`・`g4fix3/`・`phase4/`）と照合した。誤りは G4-4-01 だけ | **要**（G4-4-01） |
| Lint の警告・デバッグ用のコード・秘密・コミットしてはならないファイル | 警告 54 件は Iteration 3 と同じ 16 ファイル。そのほかは上記 5 で、該当なし | 不要 |
| `skip`・`todo`・`only`・`assert.ok(true)` | `testsuites/` 全体で 0 件 | 不要 |
| 中断しない経路への影響 | 本体は独立監査3 Iteration 6 から変わらず、d2（35 構成）・s2（15 機）の md5 が一致 | 不要 |
| 見直しの入力 §3 の行 | 本ラウンドで変更なし（md5）。本ラウンドの差分と指摘は本ブランチで追加したテスト・E2E の起動フラグ・文書のもので、main と共通の不具合ではない | 不要 |

---

### 4. 次工程で注意すべき点（Watchpoints for Next Phase）

1. **G4-4-01 の修正と完了の確認**（§4 の 5 の 5）: 判定は PASS（文書指摘あり）で、工程 4 は通過とする。テスト計画 L86 の件数を直して設計書の改訂履歴に記録した後、独立エージェントがその解消だけを確認し、本ファイルに追記してから完了とすること。修正は文書だけのため、テスト・d2・s2・再評価の再実行は要らない。
2. **`unit/11` の子プロセスの下で止まるプロセスの残り**（指摘ではない）: `spawnNode` は直下の計測スクリプトだけを `SIGKILL` するため、計測スクリプトがさらに起動した子プロセス（`measure` の `--child`）が止まった場合は、テストは 60 s で失敗するが、その子プロセスは残り続ける。本監査の調査（`orphan/`: `runChild` の先頭を無限ループにした複写で 1 件だけを実行）では、テストは 60.2 s で `ETIMEDOUT` の失敗になり、`npm test` は止まらないが、`--child` のプロセスが親を失って CPU を使い続けた（本監査がプロセスグループごと止めた）。`runChild` は計測コードの指紋に入る部分で、作業者の変異の対象外、文書にも残らないとの記述はないため、指摘としない。構造の見直しで計測スクリプトを再利用するなら、計測スクリプトを `detached` で起動してプロセスグループごと止める、または `measure` に制限を付けること（`measure` を変えると指紋が変わる）。
3. **変異の実行の打ち切り**（指摘ではない）: `gen_run.py` の 90 s の打ち切りは、`unit/11` が時間切れで失敗するまでの約 123 s より短く、打ち切った 3 件は `after` が実行されずに `/tmp/rollout-timing-unit-*` を 3 個残す（本監査の再実行でも残り、本監査が消した）。再利用するなら、打ち切りを 150 s 以上にするか、打ち切りの後に一時ディレクトリを消すこと。
4. **E2E の起動フラグの監視**（指摘ではない）: `--disable-audio-output` で E2E はホストの音声デバイスを開かなくなった。08:22 の 1 回の原因がこの経路だったことは推定であり（上記の評価の 2）、フラグの後に同じ形（最初のクリックの `Input.dispatchMouseEvent` の時間切れ）の失敗が起きれば、仮説が外れていたことになるため、別の原因として調べること。README L125・`cdp_helpers.mjs` L187-190 の因果の書き方を「音声デバイスのエラーとともに」と弱めるのは任意。ホストの音声デバイスの経路（デバイスのエラー時のアプリの振る舞い）は E2E の対象外のままである。
5. **マージの前の確認**（Iteration 2 の WP2・WP3、引き続き有効）: 追跡されていない 34 項目をすべてコミットに含めること。同期ブロック時間の証跡（`phase4/perf_state.json`、md5 `db6c2be3…`）、main のツリー（`phase4/main_tree`）、d2・s2 のスクリプトと期待値は作業領域にしかなく、再起動や片付けで消える。マージの前に残し方を決め、構造の見直しの工程 1 でリポジトリに移すこと。
6. **作業領域の絶対パス**（Iteration 1 の WP3）: 本ファイル（本監査の追記の前で 20 行。本監査の追記にも 1 行）と見直しの入力 L57 に、利用者名を含む作業領域の絶対パスがある。リポジトリを公開する場合は扱いを決めること。
7. **`npm run check` の環境と分岐カバレッジ**（Iteration 1 の WP5・WP6）: 全体にインストールされた ESLint 6.4.0・TypeScript 7.0.2 に依存する。分岐カバレッジは本監査で 93.02% で、目標 97% は行・関数だけが満たす。構造の見直しで扱うこと。
8. **構造の見直しのブランチへの引き継ぎ**: Iteration 3 の §4 の 3（模擬のモジュールが呼び出しを記録しないため、`runChild` の対応と `measure` の作業ディレクトリを壊す変更を `npm test` は検出しない）と §4 の 4（L801 の条件付きのアサーション、`measure` の制限なし、NUL だけの区切り、方位の検査の時点、`--state` なしの試験用の負荷の印、Node の版を含まない指紋）は引き続き有効。見直しの入力 §3 の行は本ブランチでは直さない（範囲の決定）。
9. **引き続き有効な Watchpoint**: 独立監査4 Iteration 1 の WP7 に挙げたもの（独立監査3 の各 Iteration の WP、lint 警告 54 件）。重い処理（全スイート・E2E・カバレッジ・変異・計測）を同時に走らせないこと。

---

## 独立監査4: 最終総合監査 — 文書指摘の解消確認（§4 の 5 の 5）

- **対象ゲート**: 独立監査4: 最終総合監査（Iteration 4 の判定 PASS（文書指摘あり）の後の確認）
- **確認の対象**: 独立監査4 Iteration 4 の文書指摘 G4-4-01（1 件）。全体の再監査は行わない（§4 の 5 の 5）
- **実施日時**: 2026-11-23 09:21〜09:26 JST
- **結果**: **G4-4-01 は解消**。修正で新たに生じた不整合はなし。新たな指摘はなし

[`docs/development_process.md`](../development_process.md) §4 の 5 に従い、Iteration 4 が監査したツリー（`scratchpad/gate4_it4/pristine`）と md5（`gate4_it4/md5_start.txt`・`md5_end.txt`、各 487 件）を基準に、修正の差分と G4-4-01 の解消だけを確かめた。作業者の申告（テスト計画 L3・L86、設計書の表題・改訂履歴 L3・§4 の見出し・最終改訂）は前提にせず、差分から確かめた。

- **差分の特定**: Iteration 4 の終了時の md5（`md5_end.txt`）と本確認の開始時の md5（`gate4_confirm/md5_before.txt`、487 件。`.git` を除く全ファイル）を突き合わせ、`pristine` と `diff -r` で比べた。ファイルの一覧は同じで、Iteration 4 の終了時から md5 が変わったのは次の 2 ファイルだけである。
  - テスト計画（236 行のまま）: L3 の対象の版「Rev 6.22」→「Rev 6.23」と、§4.1 L86 の「単体テスト 51 件」→「単体テスト 52 件」の 2 行。文字単位の比較で、変わったのはこの 2 つの数字だけ。
  - 設計書（575 行のまま）: 次の 4 行。
    - 表題 L1: 「Rev 6.22」→「Rev 6.23」。
    - 改訂履歴 L3: 末尾に Rev 6.23 を追加した。既存の 5,141 文字は同じで、末尾に 193 文字を加えただけ。
    - §4 の見出し L334: 「Rev 6.1〜6.22」→「Rev 6.1〜6.23」とし、末尾に「、独立監査4 Iteration 4 の文書指摘（G4-4-01、Rev 6.23）」を加えた。
    - 最終改訂 L336: 「Rev 6.2〜6.22」→「Rev 6.2〜6.23」、「Rev 6.22、2026-11-23 08:39 JST」→「Rev 6.23、2026-11-23 09:21 JST」。
  - 本ファイルは Iteration 4 の終了時の md5（`ee739638…`）のまま。`pristine` の本ファイル（3,541 行、md5 `eac0aae1…`）は現行の先頭 792,246 バイトとバイト単位で同じで、違いは Iteration 4 の追記（L3542-3664）だけ。
  - 次のものは Iteration 4 の開始時・終了時と md5 が同じで、コード・テスト・プリセット・設定の変更はない: `scripts/`、`presets/`、`testsuites/`（README・`unit/11` を含む）、`index.html`、`style.css`、設定、見直しの入力、`docs/development_process.md`。
  - 変更行はすべて読んだ。
- **変更していないもの**: 本ファイルへの追記のほかは何も変更していない。次の 3 点を確かめた。
  - 本確認の開始時（`gate4_confirm/md5_before.txt`）と終了時（`md5_after.txt`）で、本ファイル以外の全ファイルの md5 が一致する。
  - 本ファイルの既存の 3,664 行は、追記前（`review_before_append.md`、md5 `ee739638…`）とバイト単位で同じ。
  - git の状態（HEAD `0e453a8`、stash なし、`git status --porcelain` の 86 行（追跡されていない 34 項目））も変えていない。
- **実行したもの**: `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` の 1 回だけ（4.6 s、load average 4.3 → 4.6）。修正が文書だけのため、全スイート・E2E・カバレッジ・変異・計測は実行していない（Iteration 4 の §4 の 1）。
- **補助エージェント**: 起動しなかった。

---

### 1. 文書指摘の解消確認

| ID | 判定 | 確認内容 |
|---|---|---|
| G4-4-01 テスト計画 §4.1 L86 が `unit/11` の件数を 51 件と書く | ✓ 解消 | (1) L86 は「単体テスト 52 件（`unit/11_perf_rollout_timing`。分割実行の追加で 26 件、…G4-1-01・G4-1-02 への対応で 16 件、…G4-2-01・G4-2-02 への対応で 9 件、…G4-3-01 への対応で 1 件）を加え、全 1,636 件」となった。内訳の和 26 + 16 + 9 + 1 = 52 とも、全体 1,584 + 52 = 1,636 とも一致する。<br>(2) 同じ文書の L98（`unit/11_perf_rollout_timing`（52。…））と、README L97 の `unit/11` の行（52）に一致する。<br>(3) 実際のテスト: `node --test testsuites/unit/11_perf_rollout_timing.test.mjs` は tests 52・suites 10・pass 52・fail 0・cancelled 0・skipped 0・todo 0（4.6 s）。テストファイルは Iteration 4 から変わっていない（md5）。実行の前後で `/tmp/rollout-timing-unit-*` は 0 個。<br>(4) 内訳そのもの: 本ファイルの独立監査4 の各 Iteration の記録では、`unit/11` は Iteration 1 で 26 件、Iteration 2 で 42 件（+16）、Iteration 3 で 51 件（+9）、Iteration 4 で 52 件（+1）で、L86 の内訳と一致する。<br>(5) §4 の 5 の 3: 設計書の改訂履歴 L3 の Rev 6.23 に、指摘 ID（G4-4-01）と修正内容（テスト計画 §4.1 の件数を 51 件から 52 件に訂正）が記録されている |

---

### 2. 修正で新たに生じた不整合の確認

1. **改訂履歴の記載**: Rev 6.23 の記載は次のとおりで、差分（テスト計画の 1 か所の数字の訂正と、それに伴う版の更新だけ）と一致する。
   - 記載: 「独立監査4 Iteration 4（PASS（文書指摘あり））の文書指摘 G4-4-01 を反映。テスト計画 §4.1 の `unit/11_perf_rollout_timing` の件数を 51 件から 52 件に訂正（内訳 26 + 16 + 9 + 1 と全 1,636 件に合わせる）。設計の内容は変えない）: 2026-11-23 09:21 JST」
   - 設計の本文は変わっていない（変わったのは L1・L3・L334・L336 だけ）。
   - テスト計画 L3 の対象の版の更新を Rev 6.23 は書かないが、Rev 6.21・6.22 も同じ扱いで、従来の書き方に沿う。
2. **版の表記の一致**: 次の 5 か所は互いに一致する。
   - 設計書の表題 L1: Rev 6.23。
   - 設計書の改訂履歴 L3 の最後の項: Rev 6.23。
   - 設計書の §4 の見出し L334: 「Rev 6.1〜6.23」。末尾は「独立監査4 Iteration 4 の文書指摘（G4-4-01、Rev 6.23）の反映」。
   - 設計書の最終改訂 L336: 「Rev 6.2〜6.23」「Rev 6.23、2026-11-23 09:21 JST」。
   - テスト計画 L3: Rev 6.23。

   L334 の括弧の対応と、既存の各項の並び（Rev 6.22 までの部分）は変わっていない。
3. **時刻**: 次の順序に矛盾はない。
   - 設計書とテスト計画の保存時刻はどちらも 09:21:20 で、Rev 6.23 の 09:21 JST と一致する。
   - この保存は、Iteration 4 の追記の保存（09:20:22）と Iteration 4 の終了時の md5（09:20:27）より後で、本確認の開始（09:21:47）より前である。
   - Iteration 4 の記録の実施日時は 09:22 までだが、Iteration 4 が確認に使った終了時の md5 は 09:20:27 に修正前のツリーで取られている。したがって、Iteration 4 の確認と修正は重なっていない。
4. **Rev 6.22 を指す残りの記述**: 次の 2 か所は過去の改訂を指す記述で、どちらも正しいまま。Rev 6.23 は計測スクリプトも設計の内容も変えないためである。
   - テスト計画 L223 の「設計書 Rev 6.22」: G4-3-01 の対応の版。
   - テスト計画 L235 の「設計書 Rev 6.20〜6.22」: 経緯の 3〜5 の計測スクリプトの変更の版。

   設計書・テスト計画・README・見直しの入力・`docs/development_process.md` に、現在の版を Rev 6.22 とする記述は残っていない。

---

### 3. 横展開確認（Horizontal Check）

| パターン | 横断調査結果 | 水平適用の要否 |
|---|---|---|
| `unit/11` の件数を 51 と書く箇所 | `docs/` 配下（本ファイルを除く 4 ファイル）と `testsuites/README.md` の「51」をすべて調べた。`unit/11` の件数を表すものはない。残るのは次のものだけ。<br>・時刻: 設計書 L3 の 00:51、テスト計画 L220 の 19:51。<br>・訂正の経緯: Rev 6.23 の「51 件から 52 件に訂正」。<br>・バッファの 51 スロット・`OBJ_ATTR_COUNT = 51`: 設計書 L19・L56・L57・L406、テスト計画 L20・L30、README L91。<br>本ファイルの過去の記録にある 51 件は Iteration 3 の時点の値で、記録として正しい | 不要 |
| `unit/11` の件数・全体の件数の一致 | 次の値は実際の実行（52）と一致する。<br>・テスト計画: L86（52、全 1,636）、L98（52）、§5 L230・L232（1,636）。<br>・README: L97（52）、L146・L193（1,636）。<br>テスト計画 L115・L116 の 1,584 件は独立監査3 の時点の記録で、日付付きの過去の値 | 不要 |
| 現在の版の表記 | 上記 2 の 2・4 のとおり、版を表す 5 か所が Rev 6.23 で一致する。Rev 6.22 を現在の版とする記述はない | 不要 |

---

### 4. 新たな指摘

なし。

---

### 5. 次工程で注意すべき点（Watchpoints for Next Phase）

1. 独立監査4 Iteration 4 の §4 の 2〜9 は、そのまま有効である。本確認で対象の文書とコードが変わっていないためである。対象は次のとおり。
   - `unit/11` の孫プロセスの残り
   - 変異の実行の打ち切り
   - E2E の起動フラグの監視
   - マージの前の確認
   - 作業領域の絶対パス（本追記には作業領域の絶対パスを加えていない）
   - `npm run check` の環境と分岐カバレッジ
   - 構造の見直しへの引き継ぎ
   - 引き続き有効な Watchpoint

G4-4-01 は解消され、修正による新たな不整合もない。§4 の 5 の 5 により、独立監査4（最終総合監査）は完了とする。
