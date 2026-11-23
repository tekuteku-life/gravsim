# GravSim システム網羅的自動テストスイート (testsuites)

GravSim（多体万有引力・多段ロケット物理シミュレータ）の**全システム・全モジュール（`scripts/` の 43 モジュール）を対象とした網羅的自動テストスイート**です。  
過去に報告・改修されたすべての不具合の回帰テスト群（`regressions/`）、各コンポーネントを検証する単体テスト群（`unit/`）、モジュール間の連携を検証する結合テスト群（`integration/`）、ヘッドレス Chrome による E2E テスト群（`system/`）の4階層で構成されています。

本テストスイートは **外部ライブラリ（node_modules）への依存が一切ないゼロ依存設計（Zero-Dependency）** となっており、WSL（Windows Subsystem for Linux）上の Node.js 環境で `npm install` を実行することなく、そのまま即座に実行可能です。

---

## 1. ディレクトリ構成とテスト階層アーキテクチャ

testsuites/
├── README.md                      # 本説明書
├── run_all.mjs                    # 統合テストランナー（--unit, --regressions, --integration, --system, --coverage, --verbose 対応、1 件 300 秒のタイムアウト）
├── test_helpers.mjs               # ヘッドレスDOM/Canvas/WebAudioモック & 共通アサーション・モック生成
├── regressions/                   # 【不具合検知・回帰テスト群】（全455テスト、2026-11-22）
│   ├── 01_tank_pressure.test.mjs          # MECO後タンク圧・安全減圧・ベント保持
│   ├── 02_fuel_and_deltav.test.mjs         # 残燃料1/1000化バグ防止 & REM ΔV精度
│   ├── 03_solar_system_gravity.test.mjs    # 太陽系質量スケール & 軌道安定性
│   ├── 04_multistage_debris.test.mjs       # 全段デブリ発生・視認性・バッファ送受信
│   ├── 05_payload_and_events.test.mjs      # 第2段エンジン分離・ペイロード移行
│   ├── 06_telemetry_annunciator.test.mjs   # 16灯アナンシエーターランプ連動
│   ├── 07_trajectory_predictor.test.mjs    # 軌道予測の発射直後墜落防止 & 多段イベント検出
│   └── 08a〜08c・09〜21_*.test.mjs, 08_trajectory_guarantees_helpers.mjs # 2026-11 追加分（§2-D）
├── integration/                   # 【結合・ワークフロー検証テスト群】（全252テスト）
│   ├── 01_physics_worker_bridge.test.mjs              # 物理演算 Worker とメインスレッドの同期・デブリ生成
│   ├── 02_rocket_guidance_staging.test.mjs            # 発射・多段燃焼・分離パイプライン連携
│   ├── 03_trajectory_predictor_engine.test.mjs        # 軌道予測エンジンと物理エンジンの軌道一貫性
│   ├── 04_ui_telemetry_event_pipeline.test.mjs        # テレメトリHUD・アナンシエーター・音響パイプライン連携
│   ├── 05_mission_workflow_and_state_persistence.test.mjs # 発射台配備・地球優先天体選択・予測期間・状態保存復元
│   ├── 06〜10_*.test.mjs                               # 外部プリセット・軌道投入・タブ遷移・天体配置・大気 Isp
│   └── 11〜14_*.test.mjs                               # 2026-11 追加分（§2-D）
├── unit/                          # 【全モジュール機能・単体テスト群】（全888テスト）
│   ├── 01_core_physics.test.mjs            # 物理計算・空間四分木・バッファ同期・ユーティリティ
│   ├── 02_rocket_guidance.test.mjs         # フライトコンピュータ・自動シーケンサ・発射台・軌道予測
│   ├── 03_celestial_world.test.mjs         # 天体・ロケットオブジェクト・デブリ生成・公転配置・セーブ管理
│   ├── 04_camera_render.test.mjs           # カメラ・座標変換・レンダラー・発射台エフェクト・衝撃波
│   ├── 05_ui_telemetry_audio.test.mjs      # テレメトリHUDカード・操作パネル・入力・音響・シーケンサー
│   └── 06〜11_*.test.mjs, 07b_*.test.mjs   # 2026-11 追加分（§2-D「2026-11 追加テスト」）
├── system/                        # 【ヘッドレス Chrome による UI E2E テスト】（全41テスト、2026-11 追加）
│   ├── cdp_helpers.mjs                     # 静的サーバー・Chromium 起動・CDP クライアント（テストとしては収集されない）
│   └── 01〜05_*.test.mjs                   # 起動と予測線・フライトプラン表・打上げと段分離・保存と読込（2 ファイル）
└── perf/                          # 【計測スクリプト】（`npm test` には含めない）
    └── rollout_timing.mjs                  # rollout() の同期ブロック時間（設計書 §4.12 の受入基準の計測）
```

---

## 2. カバーする機能・モジュール対応表

### A. 回帰テスト群 (`testsuites/regressions/`)

| スイートファイル | カバーする過去の不具合・仕様 | 主な検証項目 |
| :--- | :--- | :--- |
| **`01_tank_pressure.test.mjs`** | **MECO後タンク圧問題**<br>（燃焼終了後にタンク圧が急落して0になる不具合） | ・燃焼中（NOMINAL）の目標加圧値（350 kPa）維持<br>・MECO瞬間の過渡的圧力スパイク（MECO_TRANSIENT）<br>・POST_MECO_VENT による安全減圧ベント挙動<br>・POST_MECO_HOLD 状態で **100〜120 kPa**（目標110 kPa）に安全保持され0に落ちないこと<br>・PRESSアナンシエーターランプ閾値（300 kPa）連動 |
| **`02_fuel_and_deltav.test.mjs`** | **残燃料バーの1/1000化バグ & REM $\Delta V$ 計算異常**<br>（IGNITE点火時に燃料表示が1/1000に激減するバグ） | ・点火時・Worker同期時に推進剤質量（ton）が二重変換（kg2ton）されず保持されること<br>・燃料パーセンテージバーが点火直後に0.1%へ激減せず100%から滑らかに減少すること<br>・ツィオルコフスキーのロケット方程式に基づく残余増速量（REM $\Delta V$）の計算精度<br>・多段ロケット全段（第1段＋第2段）合算 $\Delta V$（約 10.5〜11.5 km/s）の算出と m/s $\to$ km/s 表示変換 |
| **`03_solar_system_gravity.test.mjs`** | **太陽系配置時の惑星飛び出しバグ**<br>（質量の単位変換ミスにより天体が爆発的に飛散するバグ） | ・メインスレッド（ton）とPhysicsEngine Worker（kg）間の正確な質量変換（ton2kg / kg2ton）<br>・万有引力の理論加速度計算（1 AUにおける地球の理論加速度 $a_x \approx -5.932 \times 10^{-3}\text{ m/s}^2$）<br>・30日間（43,200ステップ）の数値積分で惑星が飛び出さず、距離偏差 0.1% 未満でケプラー円軌道を維持すること |
| **`04_multistage_debris.test.mjs`** | **各ステージ切り離し・フェアリングのデブリ未発生 & 不可視バグ**<br>（切り離し時にデブリが出ない、または1px暗灰色で見えない問題） | ・第1段ブースター切り離し時のブースターデブリ（25t, `debrisSubType: 1`）発生<br>・高度100km突破時のフェアリング左右2枚デブリ（各0.85t, `debrisSubType: 3`）発生<br>・第2段燃焼終了後の上段エンジンデブリ（4.5t, `debrisSubType: 2`）発生（全4個のデブリ生成）<br>・WorkerBridge共有Float64バッファにおけるデブリ属性のパッキング／アンパッキング<br>・メインスレッド側での視認性属性（サイズ 3.0〜4.0px、シルバー色 `#d0d8e0`、シアン枠線 `#00ffff`、軌跡初期化） |
| **`05_payload_and_events.test.mjs`** | **第2段エンジン切り離し & ペイロード分離イベント欠落**<br>（最終段燃焼後にペイロードが分離されず機体が移行しない問題） | ・第2段分離後にロケット本体がペイロード単体（質量 8.0t）へ移行し、燃料・推力が0になること<br>・`isPayloadSeparated` フラグ（バッファ FLAGS bit 2048）の Worker $\leftrightarrow$ メインスレッド間同期<br>・軌道予測器における `2-STG-SEP`（第2段分離）および `PAYLOAD SEP`（ペイロード分離）イベント検出 |
| **`06_telemetry_annunciator.test.mjs`** | **16灯アナンシエーターランプの多段ロケット連動漏れ**<br>（SECO, 1-SEP, 2-ENG, 2-SEP, P-SEP ランプの欠落・不整合） | ・ランプテストモード（16灯全点灯）の動作検証<br>・第1段上昇中（1-ENG点灯、MECO消灯、1-SEP消灯）<br>・第1段MECOおよび分離中（MECO点灯、1-SEP点滅/点灯、1-ENG消灯）<br>・第2段燃焼中（2-ENG点灯、1-SEP点灯維持、SECO消灯）<br>・第2段燃焼終了・分離・ペイロード放出（SECO点灯、2-SEP点灯、P-SEP点灯、ORBIT点灯） |
| **`07_trajectory_predictor.test.mjs`** | **軌道予測の発射直後墜落バグ & 多段イベント検出**<br>（発射直後に地表激突と予測されてしまうバグの防止） | ・発射台からの打ち上げ初期条件で即時墜落（alt < 0）とならず、100km以上の宇宙空間への軌道予測が正しく生成されること<br>・多段ロケット構成（各段推進剤、推力、フェアリング）の引き継ぎ<br>・全11個のフライトイベント（PITCH $\to$ MECO-1 $\to$ STG-1 SEP $\to$ SES-1 $\to$ FAIRING JETTISON $\to$ AP $\to$ ORBIT $\to$ SECO-1 $\to$ 2-STG-SEP $\to$ PAYLOAD SEP）の時系列検出 |

### B. 単体テスト群 (`testsuites/unit/`)

| スイートファイル | 対象モジュール | 主な検証内容 |
| :--- | :--- | :--- |
| **`01_core_physics.test.mjs`** | `gravsim_calc_quadtree.js`<br>`gravsim_calc.js`<br>`gravsim_worker_bridge.js`<br>`gravsim_utils.js`<br>`gravsim_event_bus.js`<br>`gravsim_profiler.js` | ・空間四分木（QuadTree）分割・プール再利用・近傍探索<br>・弾性衝突・ロッシュ限界・脱出速度判定アルゴリズム<br>・WorkerBridge 46スロット共有Float64バッファの完全双方向一貫性<br>・単位変換（m $\leftrightarrow$ km $\leftrightarrow$ AU, t $\leftrightarrow$ kg, kPa $\leftrightarrow$ Pa）と角度正規化<br>・EventBus 優先度付きイベントディスパッチ・購読解除<br>・WorkerProfiler による演算負荷計測<br>・自転追従ホールドダウン位置更新 & 最適サブステップ決定アルゴリズム |
| **`02_rocket_guidance.test.mjs`** | `gravsim_flight_computer.js`<br>`gravsim_launch_sequencer.js`<br>`gravsim_rocket_launcher.js`<br>`gravsim_trajectory_predictor.js` | ・フライトプロファイル高度/時間スロットル・ピッチ角度線形補間<br>・Max-G リミッター絞り込み & Max-Q オートスロットル・アンチストール制御<br>・発射台配備（Rollout ホールドダウン）& 射場照準マーカー描画<br>・発射シーケンサーライフサイクル & プリセット読み込み<br>・軌道予測器の非同期 Worker 応答・リクエスト合流キュー・全フライトイベント判定<br>・軌道予測画面内マーカー（通常イベント・IMPACT赤十字）の描画<br>・RocketLauncher の状態シリアライズ（getState / loadState）& ロールアウト中断 |
| **`03_celestial_world.test.mjs`** | `gravsim_object.js`<br>`gravsim_trajectory.js`<br>`gravsim_object_manager.js`<br>`gravsim_debris_generator.js`<br>`gravsim_save_manager.js`<br>`gravsim_object_placer.js` | ・天体（CelestialBody）・ロケット（Rocket）・破片（Debris）クラス階層<br>・Trajectory リングバッファ（二分探索補間 getInterpolatedPos・減衰 shrink・描画）<br>・ObjectManager 追加・削除・Worker同期・ヘリオスフィア脱出天体の自動消去<br>・宇宙状態の完全シリアライズ・復元（getState / loadState）<br>・ロケット飛行時の火炎（_drawFlame）描画 & 大気圏内エフェクトトレイル追加<br>・ObjectPlacer プリセット宇宙（太陽系、連星系、三体問題、銀河中心）一括展開 |
| **`04_camera_render.test.mjs`** | `gravsim_camera.js`<br>`gravsim_renderer.js`<br>`gravsim_overlay_renderer.js`<br>`gravsim_pad_effect.js`<br>`gravsim_visual_effect_manager.js`<br>`gravsim_trail_renderer.js` | ・Camera ワールド $\leftrightarrow$ スクリーン変換・Lerp補間・ズーム指数制限<br>・ターゲット切り替え時の画面ジャンプ防止オフセット補正<br>・打ち上げフェーズ（Phase 1〜4）追尾オートズーム・姿勢ロック<br>・Renderer 描画パイプライン（before $\to$ objects $\to$ after $\to$ overlay）<br>・OverlayRenderer 距離スケールバー（m, km, AU）およびデバッグ同心円描画<br>・TrailLineRenderer / EffectRenderer による実線軌跡 & 相対軌跡描画<br>・PadEffectRenderer 全発射台エフェクト（CHILLDOWN, DELUGE, ROFI等）および臍帯ケーブルVerlet物理更新<br>・VisualEffectManager 衝撃波生成・描画・高度超過自動停止ライフサイクル |
| **`05_ui_telemetry_audio.test.mjs`** | `gravsim_telemetry_panel.js`<br>`gravsim_telemetry_card.js`<br>`gravsim_control_panel.js`<br>`gravsim_tab_*.js`<br>`gravsim_input_manager.js`<br>`gravsim_launch_sequencer.js`<br>`gravsim_sound_sequencer.js`<br>`gravsim_audio_manager.js`<br>`gravsim_info_panel.js` | ・TelemetryCard 4種（FlightDynamics, AeroGuidance, PropulsionCard, NavigationCameraCard）のUI更新・リセット・描画<br>・TelemetryPanel 開閉トグル、ミニマルHUD描画、ホイール/スワイプによるカード切替<br>・ControlPanel モバイルメニュートグル、タブ切替（Rocket/System）、状態シリアライズ（getState / loadState）<br>・SystemTab スライダー、チェックボックス、オーディオ切替、隠し開発者モード（7回クリック）<br>・RocketTab 各段パラメータ、推進剤比率、ペイロードタブ、プリセットロード、発射/中断アクション<br>・InputManager マウスドラッグ、右クリックダブルタップ、2本指タッチピンチズーム<br>・InfoPanel 時間経過積算、FPS計測インターバル（500ms）、物理サブステップ表示<br>・AudioManager 非同期マニフェスト読み込み & 音声再生・アンロード |

### C. 結合テスト群 (`testsuites/integration/`)

| スイートファイル | 対象モジュール | 主な検証内容 |
| :--- | :--- | :--- |
| **`01_physics_worker_bridge.test.mjs`** | `gravsim_calc.js`<br>`gravsim_worker_bridge.js`<br>`gravsim_object_manager.js` | ・PhysicsEngine とメインスレッド間の46スロット共有Float64バッファ同期<br>・Worker側での段分離デブリ自動生成とメインスレッドObjectManagerインスタンス化<br>・単位変換の双方向整合性（km $\leftrightarrow$ m, t $\leftrightarrow$ kg）<br>・ゼロアロケーションバッファプールの再利用安定性 |
| **`02_rocket_guidance_staging.test.mjs`** | `gravsim_rocket_launcher.js`<br>`gravsim_launch_sequencer.js`<br>`gravsim_flight_computer.js`<br>`gravsim_calc_object.js` | ・LaunchSequencer カウントダウン・EventBus 発火・ホールドダウン解除連携<br>・CalcRocket 1段燃焼・分離・2段点火・フェアリング投棄・ペイロード放出の多段パイプライン<br>・FlightComputer ピッチ誘導姿勢遷移と構造Max-G/Max-Qリミッター制御 |
| **`03_trajectory_predictor_engine.test.mjs`** | `gravsim_trajectory_predictor.js`<br>`gravsim_calc_predictor.js`<br>`gravsim_calc.js` | ・メイン物理エンジン（RK4）と軌道予測エンジンの万有引力軌道一貫性<br>・runMultiBodySimulation による未来軌道点列生成と全フライトマイルストーン検出<br>・母天体の自転角速度に応じた予測軌跡の座標系回転補正 |
| **`04_ui_telemetry_event_pipeline.test.mjs`** | `gravsim_telemetry_panel.js`<br>`gravsim_telemetry_card.js`<br>`gravsim_sound_sequencer.js`<br>`gravsim_control_panel.js` | ・Workerテレメトリフレームのデコードと4種TelemetryCardおよびDOM要素更新<br>・16灯アナンシエーターマトリクスの飛行フェーズ連動点灯・点滅遷移<br>・EventBus 経由でのSoundSequencerコールアウト音声発火<br>・ControlPanel タブ切替同期およびタイムスケールのUniverseへの即時伝播 |
| **`05_mission_workflow_and_state_persistence.test.mjs`** | `gravsim_tab_rocket.js`<br>`gravsim_tab_system.js`<br>`gravsim_pad_effect.js`<br>`gravsim_save_manager.js`<br>`gravsim_universe.js` | ・ロケットタブ遷移時のデフォルト天体自動選定（地球優先、地球不在時は最後に追加された天体へのフォールバック、ユーザー選択保持・天体削除時リカバリ）<br>・予測期間スライダーの最低0.2カ月／初期値1.0カ月設定、RocketLauncher / プレビューへの即時伝播と日／月／年フォーマット<br>・ロールアウト〜パッドエフェクト〜内部電源/リフトオフによるストロングバック/アンビリカル退避のE2E検証<br>・SaveManager / Universe / ObjectManager / ControlPanel 状態の完全シリアライズ & デシリアライズ検証 |

---

### D. 2026-11 追加テスト（軌道予測・ロケット演出・フライトプラン刷新）

設計書 [`docs/design/2026-11-20_trajectory_fx_flightplan.md`](../docs/design/2026-11-20_trajectory_fx_flightplan.md) の要件 1〜5 と §4 補遺を対象とするテスト群。テスト計画は [`docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md`](../docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md)。期待値は設計書の式・表・保証から導いている。

| ファイル | テスト数 | 対象 |
| :--- | ---: | :--- |
| `unit/06_rotation_buffer_sync.test.mjs` | 133 | バッファ 51 スロット・`ROCKET_FLAG`・段状態コード、自転角の単一源（`_getRotationOmega`）、ホールドダウン同期、`updateObjectParams` の 2 パス、実飛行経路の記録、先減算の描画式 |
| `unit/07_trajectory_sampler.test.mjs` | 68 | 予測の終了理由 6 種、`maxSimTime`、ステップ・点数の上限と予算オプション、サンプラー、座標系の切替、`renderTrajectory`、飛行中の消去 |
| `unit/07b_trajectory_worker_scope.test.mjs` | 9 | 予測 Worker のメッセージ処理（モジュールを 1 プロセスで 1 回だけ読み込むため別ファイル） |
| `unit/08_rcs_vapor_cone.test.mjs` | 209 | RCS の状態判定と描画、`AeroUtils`（気温・音速・マッハ）、ベイパーコーン、マッハの 0 クリア、音響 |
| `unit/09_flight_plan_actions.test.mjs` | 175 | トリガ、アクションのラッチ、保留燃焼、`ORBIT_ASSIST`、分離の保留、7 ミッションの表、深宇宙サイジング、6 列の表、スライダ、推力クランプ、設定の専有化、無効な行の除去 |
| `unit/10_runtime_state_persistence.test.mjs` | 113 | 復元分岐の契約、実行時状態の保存・復元と検証、スナップショットのプロトコル、保存項目、読込のガード、不要コードの削除 |
| `unit/11_perf_rollout_timing.test.mjs` | 52 | 同期ブロック時間の計測スクリプト（`perf/rollout_timing.mjs`）: 回数と先後、回数の下限、既定のワールドと方位、構成（124）と回の完全性、最小値の比（main の最小値が正でない構成は無限大）、受入基準 1・2（2 は本ブランチだけの値）とそれぞれの終了コード、負荷の条件、余裕と全回・前半・後半の変動、出力の書式、ツリーと計測コードの指紋、分割実行の状態ファイル（保存・再開・不一致と不正な内容の拒否）、計測のループ（子プロセスが自分のツリーとワールドを記録する模擬のモジュールのツリーで、記録した先後どおりの実行、回ごとの保存・先後の継続、各ツリーの計測の前の負荷の標本、回数の上限、欠けた回の拒否）、オプションの検査と終了コード。子プロセスの起動には時間制限があり、止まった子プロセスはテストの失敗になる。実際の計測時間と負荷の値は確かめない |
| `integration/11_worker_sync_rotation_holddown.test.mjs` | 22 | Worker と主スレッドの自転角・ホールドダウン・2 パス・静止軌道の実飛行経路 |
| `integration/12_rcs_vapor_pipeline.test.mjs` | 25 | `CalcRocket` → `WorkerBridge` → `ObjectManager` → 描画の RCS・マッハ、実飛行 |
| `integration/13_flight_plan_missions.test.mjs` | 18 | 7 ミッションの実飛行（分離の保留、軌道投入、深宇宙のカットオフ） |
| `integration/14_save_load_runtime.test.mjs` | 19 | 実エンジンでの飛行 → 保存 → 読込 → 継続（スナップショットあり・なし）。全機体・各飛行段階で保存し、中断しない飛行とビット単位で一致すること |
| `regressions/08a_trajectory_guarantees_near_host_short.test.mjs` | 4 | 設計書 §4.3 の保証 1〜3（Sun+Earth・8 方位、地球近傍の閉軌道の 0.2 ヶ月とプリセットの期間） |
| `regressions/08b_trajectory_guarantees_near_host_long.test.mjs` | 11 | 同（1 ヶ月）、§4.3 の実測表 |
| `regressions/08c_trajectory_guarantees_deep_and_worlds.test.mjs` | 15 | 保証 4・5（深宇宙・月遷移）、他の 4 ワールド、独立監査 2 の指摘の回帰（G2-2-01・G2-2-02・G2-3-01・G2-4-01／G2-6-01・G2-8-01）。08a〜08c は 1 ファイル 60 秒の目安に収めるため旧 `08_trajectory_prediction_guarantees`（30 件）を分けたもので、共通部分は `08_trajectory_guarantees_helpers.mjs` |
| `regressions/09_flight_plan_findings.test.mjs` | 16 | G2-02（設定の共有参照）・G2-04（`vel` 再点火）・G2-05（推力クランプ）、工程 3 で直した不具合 |
| `regressions/10_persistence_findings.test.mjs` | 19 | G2-01（復元分岐の契約）・G2-07（実行時状態の復元）・G3-1-01（燃焼中の保存の継続）・G3-1-02（射点・ペイロード分離後の保存）、分離直後の投棄物と自分のロケットの衝突 |
| `regressions/11_preexisting_worker_fixes.test.mjs` | 23 | 既存の不具合（設計書 §4.13-1〜3）: ホールドダウン中のロケットとホストの衝突、予測用 Worker の物理ループ、予測の `steps` と t = 0 の `breakup` |
| `regressions/12_preexisting_ui_fixes.test.mjs` | 26 | §4.13-4〜8: 時間倍率・ズームの読込、予測期間のスライダの同期、ペイロード分離後の段表示、射点の HUD、読込直後の質量 |
| `regressions/13_preexisting_followup_fixes.test.mjs` | 17 | §4.13-9〜12: 読込直後の SRB 表示、Rocket タブを閉じたときの表示、予測期間の保存、テレメトリがないときの状態欄 |
| `regressions/14_preexisting_final_fixes.test.mjs` | 30 | §4.13-13〜18: 状態でない値の表示、アナンシエーターの使われない入力、タブを閉じたときの打上げの表示、カメラの対象、ミッションの予測期間の検証、範囲の定数 |
| `regressions/15_preexisting_last_fixes.test.mjs` | 22 | §4.13-19〜22: REF BODY、実時間（1.00 s/s）、状態の正規化、状態の数値リテラル |
| `regressions/16_preexisting_pattern_sweep.test.mjs` | 42 | §4.13-23〜26 の一括調査（Worker だけの項目と衝突の破片、id 0、状態の正規化、基準天体）。種類ごとのソースの走査（許可リスト付き） |
| `regressions/17_preexisting_remaining_fixes.test.mjs` | 32 | §4.13-27〜30: 「Sun は id 0」と世界の中心（除去済みの中心のフェードによらない判定、§4.14-13）、`rocket:destroyed`、縮小表示の SRB、破壊されたロケットの選択 |
| `regressions/18_removed_object_lifecycle.test.mjs` | 45 | §4.13-31〜32: 一覧に残る除去・破壊済みの物体（連番 `seq`／`syncSeq` による古いフレームの破棄を含む）、銀河中心と世界の中心、§4.14-13 の規則の適用と走査（`?.(`・`.length`・別名） |
| `regressions/19_branch_regressions.test.mjs` | 74 | 本ブランチの退行の修正（§4.14-1〜10）: 受動ペイロードの PAYLOAD CUTOFF、自走ペイロードの噴射、イベントの印、スライダの刻み、読込後の音声と相対高度、ホストが消えた射点、`sep_*` の行の予測のイベント、射点で満たす行、単段機の 2-STG-SEP |
| `regressions/20_flight_callout_flags.test.mjs` | 19 | 本ブランチの退行の修正（§4.14-11）: 音声のテレメトリのイベントのフラグ。実飛行 12 本で音声の列と各音声のフレーム（受動・自走ペイロード、単段・2 段・3 段機、`sep_*` の行、保存・読込）、PECO の 2 つの条件（MECO の状態、燃焼時間 ≤ 0） |
| `regressions/21_world_center_profiles.test.mjs` | 24 | 本ブランチの退行の修正（§4.14-12・-14）: 銀河中心の後（と Clear Selected の後）の各プロファイルが新しいページと同じ世界になる。利用者が空の世界に置いた天体（手で置いた Sgr A* を含む）は Deploy のボタン・太陽系で置き換えない。プロファイルの世界の中心の印（`isProfileWorldCenter`）の設定・保存・読込（旧形式のファイルを含む） |
| `system/01_app_boot_and_prediction.test.mjs` | 13 | 起動時のエラーなし、天体・射点の配置、予測線の描画、予測期間スライダの境界 |
| `system/02_rocket_tab_flight_plan.test.mjs` | 11 | 6 列の表（選択肢・追加・削除・320px で横スクロールなし）、不正な入力、推力スライダ |
| `system/03_launch_telemetry_staging.test.mjs` | 5 | 打上げ後のテレメトリ（高度・速度・マッハ）、段分離とアナンシエーター、デブリ |
| `system/04_save_load.test.mjs` | 4 | 保存 → 読込の往復（打上げ前・飛行中）、不正なセーブファイル |
| `system/05_save_load_period_hud_view.test.mjs` | 8 | 予測期間の保存、SRB の読込、HUD の状態欄・アナンシエーター、タブを開いたままの読込とカメラの対象、範囲の定数、Clear Selected の直後の保存（`system/04` から 1 ファイル 60 秒の目安のために分けた） |

#### ヘッドレス Chrome の E2E（`system/`）
- 依存なし。Node の `http` で `127.0.0.1` の空きポートに配信し、Chromium（既定 `/usr/bin/chromium`、環境変数 `CHROME_PATH` で変更可）を一時プロファイルで起動して、Node 標準の `WebSocket` で CDP を操作する。音声は Chromium の偽の出力（`--disable-audio-output`）に送り、実際の音声デバイスは開かない（Web Audio のグラフと時計はそのまま動く。音声デバイスのエラーで最初のクリックが止まった実行があったため）。終了時にブラウザ・サーバー・一時ディレクトリを必ず片付ける。
- Chromium が見つからない場合は skip せず失敗する。追加の起動フラグが必要な環境では `GRAVSIM_E2E_CHROME_ARGS` で渡す（例: `--no-sandbox`）。

#### 同期ブロック時間の計測（`perf/`）
- 設計書 §4.12 の受入基準（main 比 1.5 倍以内、7 天体で 2 秒以内、Sun+Earth で 1 秒以内）を、§4.12 の計測方法（交互実行・回ごとの先後入れ替え・最小値の比・統計量の変動との比較）で測る。負荷に左右されるため `npm test` には含めない。
- `npm run perf:rollout -- --baseline <main ブランチのチェックアウト> [--worlds SE,W7,SS,BIN,TB]`。終了コードは基準を満たせば 0、満たさなければ 1。
- 分割実行: `--state <ファイル>` を付けると、終わった回ごとにファイルへ保存し、同じファイルでの次の実行が続きから測る。`--max-rounds <n>` は 1 回の実行で測る回数の上限（`0` は保存済みの回の評価だけ）。負荷の条件（半数以上の回が load average 2.0 以下）を満たさないワールドは、高負荷の回を残したまま回を足す（§4.12 は高負荷の回を除外しない。上限は `--max-total`、既定は規定回数の 3 倍）。ファイルには両ツリー（`scripts/`・`presets/`・`testsuites/test_helpers.mjs`）と計測コード（`runChild`・`measure`・構成の定数）の指紋（md5）と方位（指定の文字列のまま）を記録し、どれかが変わった状態での再開は拒否する。各回は両ツリーが期待する全構成（4 方位で 124）をちょうど 1 回ずつ持たなければならず、欠けた・余分な・重複した構成のある回は保存せずに止める（保存済みの回も読込で検査する）。状態ファイル・計測の誤りとオプションの誤り（`--rounds-heavy` は 6 以上、`--rounds` は 3 以上、`--max-rounds` は 0 以上、`--max-total` は 1 以上の整数で、後の 2 つは `--state` が必要）の終了コードは 2、まだ回が要るときは 3。環境変数 `ROLLOUT_TIMING_TEST_LOAD`（数、または `@<ファイル>`）は計測スクリプト自身のテスト用で、負荷の標本を置き換える（状態ファイルに記録され、実際の計測の状態とは混ざらない）。マシンが空いているときに `--max-rounds 1` で 1 回ずつ進めれば、別の処理で負荷が上がっても、やり直すのはその回の分だけになる。

---

## 3. WSL 上での実行方法

WSL（Ubuntu等）のターミナルを開き、リポジトリルートに移動して実行します。

### 前提環境
- **OS**: WSL (Ubuntu 20.04 / 22.04 / 24.04 等) または Linux / macOS
- **Node.js**: v18.0.0 以上（推奨: v20, v22, v24）
- **外部依存関係**: 追加インストール（`npm install`）は**不要**です。

### 実行コマンド一覧

#### A. 全テストの実行（回帰テスト + 単体テスト + 結合テスト + システムテスト：計 1,636 テスト、2026-11-23 時点）
```bash
npm test
# または
node testsuites/run_all.mjs
```

#### B. 単体テストのみを実行
```bash
npm run test:unit
# または
node testsuites/run_all.mjs --unit
```

#### C. 回帰テストのみを実行
```bash
npm run test:regressions
# または
node testsuites/run_all.mjs --regressions
```

#### D. 結合テストのみを実行
```bash
npm run test:integration
# または
node testsuites/run_all.mjs --integration
```

#### E. コードカバレッジ付き実行（全テスト・ファイル別カバレッジ検証）
```bash
npm run test:coverage
# または
node testsuites/run_all.mjs --coverage
```

#### F. ヘッドレス Chrome の E2E のみを実行
```bash
npm run test:system
# または
node testsuites/run_all.mjs --system
```

---

## 4. テスト結果の見方

### 正常終了時（PASS）
全 1,636 テストが成功すると、緑色のチェックマーク（`✔`）とともに以下のような集計サマリーが表示されます（2026-11-23 の実行例）：
```text
ℹ tests 1636
ℹ suites 285
ℹ pass 1636
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 64777.304513

---------------------------------------------------------------
 [SUCCESS] All GravSim automated test suites passed successfully! 
===============================================================
```
- `fail 0`・`cancelled 0` となり、最終行に `[SUCCESS]` が表示されれば全機能・回帰・結合・E2E テストが正常です。
- プロセス終了コードは `0` です（CI/CD や bash スクリプトでの `$?` 判定に対応）。
- `run_all.mjs` はテスト 1 件あたり 300 秒のタイムアウトを付けて実行します（応答のない処理で実行全体が止まらないようにするため。環境変数 `GRAVSIM_TEST_TIMEOUT_MS` で変更可）。タイムアウトしたテストは `cancelled` に数えられ、終了コードは 0 以外になります。

---

## 5. コードカバレッジ実績（品質保証基準の達成）

`npm run test:coverage` を実行すると、全テスト実行後に標準出力にカバレッジレポートテーブルが出力されます（`testsuites/` 配下は集計から除外。起動用の `gravsim.js` はブラウザでだけ動くため Node のカバレッジには現れず、E2E（`system/`）で実行される）。  
基準は [`docs/development_process.md`](../docs/development_process.md) §3.4 の「最低 90% 以上、目標 97% 以上」です。2026-11-23 の実績（`scripts/` 全体）：
- **行カバレッジ**: **99.36%**
- **分岐カバレッジ**: **93.06%**
- **関数カバレッジ**: **97.34%**

### モジュール別カバレッジ実績テーブル（2026-11-23）

下表は工程 4 の実行（[テスト計画](../docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md) §5）の値です。ファイルごとの分岐の値は、乱数と並列実行の順序により実行ごとに最大 1 ポイントほど揺れます（全体の分岐の値の揺れは 0.1 ポイント程度。2026-11-22〜23 の実行で 92.97〜93.06%）。

| モジュール名 | 行 | 分岐 | 関数 |
| :--- | ---: | ---: | ---: |
| `gravsim_audio_manager.js` | 100.00% | 95.00% | 100.00% |
| `gravsim_calc_object.js` | 99.89% | 94.49% | 100.00% |
| `gravsim_calc_predictor.js` | 98.77% | 90.21% | 100.00% |
| `gravsim_calc_quadtree.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_calc.js` | 99.46% | 96.00% | 97.96% |
| `gravsim_camera.js` | 100.00% | 97.87% | 100.00% |
| `gravsim_const.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_control_panel.js` | 100.00% | 97.56% | 93.75% |
| `gravsim_debris_generator.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_destruction_manager.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_effect_trail.js` | 100.00% | 94.74% | 100.00% |
| `gravsim_event_bus.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_flight_computer.js` | 98.66% | 97.44% | 94.74% |
| `gravsim_info_panel.js` | 100.00% | 96.55% | 100.00% |
| `gravsim_input_manager.js` | 98.89% | 92.50% | 92.31% |
| `gravsim_launch_sequencer.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_object_manager.js` | 100.00% | 97.93% | 100.00% |
| `gravsim_object_placer.js` | 99.21% | 90.67% | 97.67% |
| `gravsim_object.js` | 98.36% | 92.50% | 97.62% |
| `gravsim_overlay_renderer.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_pad_effect.js` | 100.00% | 98.51% | 100.00% |
| `gravsim_preset_manager.js` | 98.16% | 80.54% | 93.10% |
| `gravsim_profiler.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_renderer.js` | 100.00% | 100.00% | 100.00% |
| `gravsim_rocket_launcher.js` | 99.54% | 82.55% | 97.62% |
| `gravsim_rocket_renderer.js` | 100.00% | 95.71% | 100.00% |
| `gravsim_save_manager.js` | 100.00% | 100.00% | 92.31% |
| `gravsim_sound_effects.js` | 100.00% | 99.31% | 100.00% |
| `gravsim_sound_sequencer.js` | 99.56% | 94.05% | 100.00% |
| `gravsim_tab_deploy.js` | 100.00% | 87.88% | 100.00% |
| `gravsim_tab_navi.js` | 100.00% | 97.37% | 100.00% |
| `gravsim_tab_rocket.js` | 100.00% | 88.19% | 96.04% |
| `gravsim_tab_system.js` | 99.42% | 94.53% | 98.11% |
| `gravsim_telemetry_card.js` | 100.00% | 98.31% | 96.77% |
| `gravsim_telemetry_panel.js` | 100.00% | 93.41% | 100.00% |
| `gravsim_trail_renderer.js` | 88.21% | 89.13% | 85.71% |
| `gravsim_trajectory_predictor.js` | 99.79% | 94.46% | 100.00% |
| `gravsim_trajectory.js` | 100.00% | 89.19% | 100.00% |
| `gravsim_universe.js` | 100.00% | 97.50% | 93.10% |
| `gravsim_utils.js` | 100.00% | 95.78% | 87.80% |
| `gravsim_visual_effect_manager.js` | 100.00% | 97.92% | 100.00% |
| `gravsim_worker_bridge.js` | 100.00% | 100.00% | 100.00% |
| **全体** | **99.36%** | **93.06%** | **97.34%** |

---

## 6. 技術仕様・テスト設計の詳細

### ヘッドレス DOM / Canvas / Web Audio モック機構 (`test_helpers.mjs`)
本シミュレータはブラウザの DOM（HUD表示・操作パネル）、Canvas 2D API（惑星・ロケット・軌跡描画）、Web Audio API（効果音・音声シーケンサー）を活用しています。  
純粋な Node.js 環境でこれらをテスト可能にするため、`test_helpers.mjs` で軽量・高速なモックレイヤーを提供しています：
- **CanvasRenderingContext2D モック**: パス操作（`beginPath`, `arc`, `moveTo`, `lineTo`）、アフィン変換（`setTransform`, `rotate`, `scale`）、テキスト計測（`measureText`）、線形/放射グラデーション生成をサポート。
- **DOM エレメントモック**: `addEventListener`, `dispatchEvent`, `classList`（add, remove, toggle, contains）、`style`、`setAttribute`/`getAttribute`、`scrollIntoView` を完全模倣。
- **Web Audio API モック**: `AudioContext`, `GainNode`, `OscillatorNode`, `AudioBufferSourceNode` をエミュレート。
- **LocalStorage モック**: ブラウザストレージの保存・取得・削除をメモリ上でサポート。
