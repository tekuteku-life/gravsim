/**
 * Unit Test Suite 10: Runtime-State Persistence (work unit E)
 *
 * Expected values are derived from docs/design/2026-11-20_trajectory_fx_flightplan.md:
 * - §4.1   restore-branch contract (`restoredRuntimeState === true` only)
 * - §3.5-1 CalcRocket restore procedure and the getState / loadState / _buildRocketPayload field table
 * - §4.7   Worker runtime snapshot protocol, runtimeState contents and restore-value validation
 * - §3.5-3 SaveManager guards, InfoPanel Date compatibility, determineOptimalSubSteps / AERO_DYNAMIC
 * - §3.5-2 removed dead code, §4.9 removed redundant code
 * Each group covers normal, abnormal (null / NaN / wrong type / missing / out of range) and boundary cases.
 */
import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMockDOM, createMockElement, assertClose } from '../test_helpers.mjs';

setupMockDOM();

import { PhysicsEngine, SimulationController } from '../../scripts/gravsim_calc.js';
import { CalcRocket, CalcDebris } from '../../scripts/gravsim_calc_object.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { ROCKET_FUELS } from '../../scripts/gravsim_preset_manager.js';
import { SaveManager } from '../../scripts/gravsim_save_manager.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { InfoPanel } from '../../scripts/gravsim_info_panel.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { normalizeRocketConfig, UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import {
	SIMULATION, OBJECT_TYPES, TANK_PRESSURE_STATES, TANK_PRESSURE_SIM, AERO_DYNAMIC, UI,
	RENDER, TRAJECTORY_PREDICTION, FLIGHT_COMPUTER_CONFIG
} from '../../scripts/gravsim_const.js';

// ------------------------------------------------------------------
// Shared fixtures (design-independent inputs with exactly representable arithmetic)
// ------------------------------------------------------------------
const MAX_T = SIMULATION.RUNTIME_RESTORE_MAX_TIME_S;
const KPA_MAX = 2 * TANK_PRESSURE_SIM.MAX_SCALE_KPA;
const SRC = (file) => fs.readFileSync(path.resolve(process.cwd(), 'scripts', file), 'utf8');

const stagesCfg = () => ([
	{ stageNumber: 1, name: 'S1', fuelType: 'liquid', thrustKN: 7600, ispVac: 311, ispSl: 282, dryMassT: 25, fuelMassT: 120, oxidMassT: 280, burnTime: 160, ofRatio: 2.3, radius: 1.85, separationDelaySec: 1.5, ignitionDelaySec: 2, jettisonSpeedM_S: 18 },
	{ stageNumber: 2, name: 'S2', fuelType: 'hydro', thrustKN: 980, ispVac: 448, ispSl: 300, dryMassT: 4.5, fuelMassT: 30, oxidMassT: 70, burnTime: 400, ofRatio: 5.5, radius: 1.85, separationDelaySec: 1.5, ignitionDelaySec: 2, jettisonSpeedM_S: 1.5 }
]);
const PROP = () => ({ enabled: true, fuelType: 'hydro', thrustKN: 0.5, ispVac: 321, ispSl: 301, ofRatio: 1.6, fuelMassT: 0.4, oxidMassT: 0.6, burnTime: 900 });
const payloadCfg = (prop = null) => ({ name: 'Sat', massT: 6, radius: 1.5, ...(prop ? { propulsion: prop } : {}) });
const fairingCfg = () => ({ enabled: true, massT: 1.7, separationAltKm: 110, isSeparated: false });
const boostersCfg = () => ({ count: 2, name: 'SRB', burnTimeSec: 105, thrustKN: 4310, coreThrustKN: 2940, dryMassT: 20, separationDelaySec: 1.5, jettisonSpeedM_S: 12 });
// Rows 1, 3, 4 carry actions (sep_payload twice -> latched budget of 2)
const PROFILE = () => ([
	{ type: 'alt', value: 0, thrust: 100, angle: 0, action: '' },
	{ type: 'time', value: 30, thrust: 100, angle: 20, action: 'sep_stage1' },
	{ type: 'time', value: 60, thrust: 100, angle: 40, action: '' },
	{ type: 'time', value: 90, thrust: 100, angle: 60, action: 'sep_payload' },
	{ type: 'time', value: 120, thrust: 0, angle: 80, action: 'sep_payload' }
]);

// §4.7 (Rev 6.2) runtime state, then the Rev 6.11 additions (G3-1-01: everything the next step reads before rewriting it)
const FC_KEYS_62 = ['flightTime', 'targetLaunchAngle', 'highestStepIndex', 'triggeredActionIndices', 'pendingActions',
	'hasPassedApogee', 'apogeeTime', 'prevVv', 'maxRecordedQ', 'hasPassedMaxQ', 'maxQConfirmTimer', 'maxQStatusTimer'];
const FC_KEYS = [...FC_KEYS_62, 'currentThrustAngle', 'isAntiStallActive'];
const ROCKET_RT_KEYS_62 = ['flightComputer', 'isBoosterIgnited', 'boosterBurnTimer', 'boosterSepTimer', 'presState', 'presTimer',
	'tankPresFuel', 'tankPresOxid', 'presStartF', 'presStartO', 'postSepRcsTimer', 'ullageRestartTimer'];
const ROCKET_RT_KEYS_611 = ['thrustRatio', 'wasFiring', 'massLossRate', 'thrustForce', 'thrustForceVac', 'ispVac', 'ispSl', 'ofRatio',
	'fuelType', 'hostAngleRad', 'ventStartF', 'ventStartO', 'noiseFiltF', 'noiseFiltO', 'paramName', 'kinematics'];
const ROCKET_RT_KEYS = [...ROCKET_RT_KEYS_62, ...ROCKET_RT_KEYS_611];
const KIN_KEYS = ['x', 'y', 'vx', 'vy', 'ax', 'ay', 'aero'];
const ROCKET_AERO_KEYS = ['currentQ', 'mach', 'qAxialKpa', 'qLateralKpa', 'aoaDeg', 'progradeAngle'];

const SAMPLE_FC_STATE = () => ({
	flightTime: 123.5, targetLaunchAngle: -1.25, highestStepIndex: 3,
	triggeredActionIndices: [1, 3], pendingActions: ['sep_payload'],
	hasPassedApogee: true, apogeeTime: 100.25, prevVv: -12.5,
	maxRecordedQ: 35.25, hasPassedMaxQ: true, maxQConfirmTimer: 0.5, maxQStatusTimer: 3,
	currentThrustAngle: -1.125, isAntiStallActive: true
});
const DEFAULT_FC_STATE = (thrustAngle = 0) => ({
	flightTime: 0, targetLaunchAngle: thrustAngle, highestStepIndex: -1,
	triggeredActionIndices: [], pendingActions: [],
	hasPassedApogee: false, apogeeTime: null, prevVv: 0,
	maxRecordedQ: 0, hasPassedMaxQ: false, maxQConfirmTimer: 0, maxQStatusTimer: 0,
	currentThrustAngle: thrustAngle, isAntiStallActive: false
});
// Exactly representable values that differ from every constructor default of makeCalcRocket()
const SAMPLE_KINEMATICS = () => ({
	x: 6.5e6 + 0.125, y: -2.5e5, vx: 12.5, vy: 7600.25, ax: -8.5, ay: 0.75,
	aero: { currentQ: 1250.5, mach: 2.25, qAxialKpa: 1.125, qLateralKpa: 0.125, aoaDeg: 4.5, progradeAngle: 0.625 }
});
const SAMPLE_ROCKET_RT = () => ({
	flightComputer: SAMPLE_FC_STATE(),
	isBoosterIgnited: true, boosterBurnTimer: 42.5, boosterSepTimer: 0.75,
	presState: 'NOMINAL', presTimer: 7.25, tankPresFuel: 351.5, tankPresOxid: 349.75,
	presStartF: 101.3, presStartO: 101.25, postSepRcsTimer: 1.5, ullageRestartTimer: 0.5,
	thrustRatio: 0.75, wasFiring: true, massLossRate: 1.75, thrustForce: 2.94e6, thrustForceVac: 2.5e6,
	ispVac: 455, ispSl: 380, ofRatio: 5.25, fuelType: 'hydro', hostAngleRad: -1.5, ventStartF: 350.5, ventStartO: 349.5,
	noiseFiltF: -0.25, noiseFiltO: 0.5, paramName: 'UnitRocket', kinematics: SAMPLE_KINEMATICS()
});

// Time clamp [0, RUNTIME_RESTORE_MAX_TIME_S]; non-finite / wrong type -> 0
const TIME_CASES = [
	[0, 0], [12.5, 12.5], [MAX_T - 1, MAX_T - 1], [MAX_T, MAX_T], [MAX_T + 1, MAX_T], [1e308, MAX_T],
	[-1e-9, 0], [-5, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0], ['100', 0], [null, 0], [true, 0], [undefined, 0], [{}, 0]
];
// Tank pressure clamp [0, 2 x MAX_SCALE_KPA]; non-finite / wrong type -> 0
const KPA_CASES = [
	[0, 0], [101.3, 101.3], [KPA_MAX - 1e-6, KPA_MAX - 1e-6], [KPA_MAX, KPA_MAX], [KPA_MAX + 1e-6, KPA_MAX], [1e308, KPA_MAX],
	[-0.001, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0], ['350', 0], [null, 0], [undefined, 0]
];

const makeCalcRocket = (td = {}, masses = {}) => new CalcRocket(
	11, 'UnitRocket', 0, 7.0e6, 7500, 0, 0, 0, 31.5, 0,
	masses.dry ?? 57.5, masses.fuel ?? 0, masses.oxid ?? 0,
	{ stages: stagesCfg(), payload: payloadCfg(), fairing: fairingCfg(), flightProfile: PROFILE(), objParam: {}, ...td }
);

// Reference values of `_activateStage(0)` derived from stagesCfg()[0] (§3.5-1 / §4.1)
const assertActivatedStage0 = (r, label) => {
	const s0 = stagesCfg()[0];
	assert.equal(r.currentStageIndex, 0, `${label}: currentStageIndex`);
	assert.equal(r.dryMass, s0.dryMassT, `${label}: dryMass`);
	assert.equal(r.fuelMass, s0.fuelMassT, `${label}: fuelMass`);
	assert.equal(r.oxidMass, s0.oxidMassT, `${label}: oxidMass`);
	assert.equal(r.burnTime, s0.burnTime, `${label}: burnTime`);
	assert.equal(r.thrustForce, s0.thrustKN * 1000, `${label}: thrustForce`);
	assert.equal(r.thrustForceVac, s0.thrustKN * 1000, `${label}: thrustForceVac`);
	assert.equal(r.massLossRate, (s0.fuelMassT + s0.oxidMassT) / s0.burnTime, `${label}: massLossRate`);
	assert.equal(r.fuelType, s0.fuelType, `${label}: fuelType`);
	assert.equal(r.ispVac, s0.ispVac, `${label}: ispVac`);
	assert.equal(r.ispSl, s0.ispSl, `${label}: ispSl`);
	assert.equal(r.isPayloadSeparated, false, `${label}: isPayloadSeparated`);
	assert.strictEqual(r.isStage2Separated, false, `${label}: isStage2Separated explicitly false (§4.1)`);
	assert.strictEqual(r.hasPayloadPropulsion, undefined, `${label}: hasPayloadPropulsion compat contract (§4.1)`);
	assert.equal(r.stgTimer, 0, `${label}: stgTimer`);
	// payload 6 + fairing 1.7 + stage 1 (25+120+280) + stage 2 (4.5+30+70)
	assertClose(r.mass, 6 + 1.7 + 425 + 104.5, 1e-12, `${label}: total mass`);
};

const withSelf = (fn) => {
	const had = Object.prototype.hasOwnProperty.call(globalThis, 'self');
	const orig = globalThis.self;
	const posted = [];
	globalThis.self = { postMessage: (msg) => { posted.push(msg); } };
	try {
		fn();
	} finally {
		if (had) { globalThis.self = orig; } else { delete globalThis.self; }
	}
	return posted;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
// G3-1-07: a stuck snapshot promise (e.g. a timeout or destroy() regression) must fail the test instead of hanging the run
const ASYNC_TEST_TIMEOUT_MS = 5000;

class RecordingWorker {
	constructor(url, opts) {
		this.url = String(url);
		this.opts = opts;
		this.posted = [];
		this.terminated = 0;
		this.onmessage = null;
	}
	postMessage(msg) { this.posted.push(msg); }
	terminate() { this.terminated++; }
}

// ==================================================================
// 1. §4.1 restore-branch contract
// ==================================================================
describe('Unit 10-1: CalcRocket restore-branch contract (§4.1)', () => {
	it('takes the restore branch only for restoredRuntimeState === true', () => {
		const restored = makeCalcRocket({ restoredRuntimeState: true, currentStageIndex: 0, stageState: 'STG_BURNING', burnTime: 50 }, { dry: 57.5, fuel: 10, oxid: 20 });
		assert.equal(restored.dryMass, 57.5, 'restore branch keeps the transmitted dry mass');
		assert.equal(restored.fuelMass, 10);
		assert.equal(restored.oxidMass, 20);
		assert.equal(restored.burnTime, 50);
	});

	for (const flag of [undefined, false, null, 'true', 1, {}, []]) {
		it(`does not take the restore branch for restoredRuntimeState = ${JSON.stringify(flag)}`, () => {
			// Fields that the old heuristic inferred a restore from (G2-01): truthy stageState, stage index, separation flags
			const r = makeCalcRocket({
				restoredRuntimeState: flag, stageState: 'PRE_LAUNCH', currentStageIndex: 1,
				isPayloadSeparated: true, isStage2Separated: true, stgTimer: 9, burnTime: 0
			}, { dry: 57.5, fuel: 0, oxid: 0 });
			assertActivatedStage0(r, `flag=${JSON.stringify(flag)}`);
			assert.equal(r.stageState, 'STG_BURNING', 'not held down -> STG_BURNING from the normal initialization');
		});
	}

	it('normal initialization of a held-down rocket (main Rocket default stageState PRE_LAUNCH) activates stage 0', () => {
		const r = makeCalcRocket({ restoredRuntimeState: false, stageState: 'PRE_LAUNCH', isHoldDown: true, isIgnited: false });
		assertActivatedStage0(r, 'rollout');
		assert.equal(r.stageState, 'PRE_LAUNCH');
		assert.equal(r.isHoldDown, true);
	});

	it('ignores runtimeState unless restoredRuntimeState === true', () => {
		const fresh = makeCalcRocket();
		for (const flag of [undefined, false, 'true', 1]) {
			const r = makeCalcRocket({ restoredRuntimeState: flag, runtimeState: SAMPLE_ROCKET_RT() });
			assert.deepEqual(r.getRuntimeState(), fresh.getRuntimeState(), `flag=${JSON.stringify(flag)} must not restore`);
		}
		const restored = makeCalcRocket({ restoredRuntimeState: true, runtimeState: SAMPLE_ROCKET_RT(), currentStageIndex: 0, stageState: 'STG_BURNING' }, { dry: 25, fuel: 100, oxid: 200 });
		assert.equal(restored.flightComputer.flightTime, 123.5);
		assert.equal(restored.presState, 'NOMINAL');
	});

	it('restore branch without runtimeState (snapshot unavailable) keeps runtime defaults (degraded mode, §4.7)', () => {
		const fresh = makeCalcRocket().getRuntimeState();
		// Initialized runtime fields; the Rev 6.11 thrust / engine fields are derived from the restored stage instead
		const RUNTIME_DEFAULT_KEYS = [...ROCKET_RT_KEYS_62, 'thrustRatio', 'wasFiring', 'ventStartF', 'ventStartO', 'noiseFiltF', 'noiseFiltO', 'hostAngleRad', 'paramName'];
		const pick = (st) => Object.fromEntries(RUNTIME_DEFAULT_KEYS.map(k => [k, st[k]]));
		const s1 = stagesCfg()[1];
		for (const rt of [null, undefined, 0, '']) {
			const r = makeCalcRocket({ restoredRuntimeState: true, runtimeState: rt, currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: 280 }, { dry: 4.5, fuel: 20, oxid: 50 });
			const st = r.getRuntimeState();
			assert.deepEqual(pick(st), pick(fresh), `runtimeState=${JSON.stringify(rt)}`);
			assert.equal(r.currentStageIndex, 1, 'kinematic/stage state is still restored');
			// §3.5-1 derivation from the transmitted stage-1 values
			assert.equal(st.massLossRate, (20 + 50) / 280);
			assert.equal(st.thrustForce, s1.thrustKN * 1000);
			assert.equal(st.thrustForceVac, s1.thrustKN * 1000);
			assert.deepEqual([st.ispVac, st.ispSl, st.ofRatio, st.fuelType], [s1.ispVac, s1.ispSl, s1.ofRatio, s1.fuelType]);
			assert.deepEqual(st.kinematics, { x: 0, y: 7.0e6, vx: 7500, vy: 0, ax: 0, ay: 0, aero: { currentQ: 0, mach: 0, qAxialKpa: 0, qLateralKpa: 0, aoaDeg: 0, progradeAngle: 0 } }, 'constructor kinematics');
		}
	});

	it('main-thread Rocket defaults to restoredRuntimeState === false and runtimeState === null', () => {
		const r = new Rocket(1, 'Rocket', 0, 0, 0, 0, 1, 1, 1, '#fff', 1, 1, 0, null, 0);
		assert.strictEqual(r.restoredRuntimeState, false);
		assert.strictEqual(r.runtimeState, null);
		assert.equal(r.stageState, 'PRE_LAUNCH');
	});
});

// ==================================================================
// 2. §3.5-1 CalcRocket restore procedure
// ==================================================================
describe('Unit 10-2: CalcRocket restore procedure (§3.5-1)', () => {
	const restore = (td, masses) => makeCalcRocket({ restoredRuntimeState: true, ...td }, masses);

	it('clamps currentStageIndex = clamp(Number(x) || 0, 0, totalStages) (§3.5-1 Rev 6.10)', () => {
		const cases = [
			[undefined, 0], [0, 0], [1, 1], [2, 2], [3, 2], [7, 2], [Infinity, 2], [-1, 0], [-100, 0], [-Infinity, 0],
			[NaN, 0], [null, 0], ['1', 1], ['2', 2], ['', 0], ['abc', 0], [true, 1], [false, 0]
		];
		for (const [input, expected] of cases) {
			const r = restore({ currentStageIndex: input, stageState: 'STG_BURNING', burnTime: 10 }, { dry: 4.5, fuel: 1, oxid: 1 });
			assert.equal(r.currentStageIndex, expected, `currentStageIndex ${input}`);
		}
	});

	it('derives isStage2Separated = Boolean(saved || index >= 2 || (payload separated && totalStages <= 2)) (§3.5-1 Rev 6.10)', () => {
		const three = () => ([...stagesCfg(), { stageNumber: 3, name: 'S3', fuelType: 'hydro', thrustKN: 110, ispVac: 460, ispSl: 300, dryMassT: 2, fuelMassT: 3, oxidMassT: 15, burnTime: 500, ofRatio: 5.5, radius: 1.5 }]);
		const cases = [
			// [label, stages, saved fields, expected]
			['saved true at index 1', stagesCfg(), { isStage2Separated: true, currentStageIndex: 1 }, true],
			['saved false, index 0', stagesCfg(), { isStage2Separated: false, currentStageIndex: 0 }, false],
			['saved false, index 1', stagesCfg(), { isStage2Separated: false, currentStageIndex: 1 }, false],
			['saved false, index 2 (= totalStages)', stagesCfg(), { isStage2Separated: false, currentStageIndex: 2 }, true],
			['saved missing, index 2', stagesCfg(), { currentStageIndex: 2 }, true],
			['2 stages, payload separated at index 1', stagesCfg(), { isStage2Separated: false, currentStageIndex: 1, isPayloadSeparated: true }, true],
			['3 stages, payload separated at index 1', three(), { isStage2Separated: false, currentStageIndex: 1, isPayloadSeparated: true }, false],
			['3 stages, index 1', three(), { isStage2Separated: false, currentStageIndex: 1 }, false],
			['3 stages, index 2', three(), { isStage2Separated: false, currentStageIndex: 2 }, true],
			['1 stage, payload separated at index 0', [stagesCfg()[0]], { currentStageIndex: 0, isPayloadSeparated: true }, true],
			['1 stage, index 0', [stagesCfg()[0]], { currentStageIndex: 0 }, false]
		];
		for (const [label, stages, fields, expected] of cases) {
			const r = restore({ stages, stageState: 'STG_BURNING', burnTime: 10, ...fields }, { dry: 4.5, fuel: 1, oxid: 1 });
			assert.strictEqual(r.isStage2Separated, expected, label);
		}
	});

	it('derives hasPayloadPropulsion = Boolean(saved || (payload separated && propulsion.enabled)) (§3.5-1 Rev 6.10)', () => {
		const cases = [
			// [label, payload, saved fields, expected]
			['saved true before separation', payloadCfg(PROP()), { hasPayloadPropulsion: true, isPayloadSeparated: false, currentStageIndex: 1 }, true],
			['saved false, separated, propulsion enabled', payloadCfg(PROP()), { hasPayloadPropulsion: false, isPayloadSeparated: true, currentStageIndex: 2 }, true],
			['saved missing, separated, propulsion enabled', payloadCfg(PROP()), { isPayloadSeparated: true, currentStageIndex: 2 }, true],
			['saved false, separated, propulsion disabled', payloadCfg({ ...PROP(), enabled: false }), { hasPayloadPropulsion: false, isPayloadSeparated: true, currentStageIndex: 2 }, false],
			['saved false, separated, no propulsion', payloadCfg(), { hasPayloadPropulsion: false, isPayloadSeparated: true, currentStageIndex: 2 }, false],
			['saved false, attached, propulsion enabled', payloadCfg(PROP()), { hasPayloadPropulsion: false, isPayloadSeparated: false, currentStageIndex: 1 }, false]
		];
		for (const [label, payload, fields, expected] of cases) {
			const r = restore({ payload, stageState: 'STG_BURNING', burnTime: 450, ...fields }, { dry: 6, fuel: 0.25, oxid: 0.5 });
			assert.strictEqual(r.hasPayloadPropulsion, expected, label);
		}
		// The derived flag selects the payload engine (§3.5-1 engine specs)
		const derived = restore({ payload: payloadCfg(PROP()), hasPayloadPropulsion: false, isPayloadSeparated: true, currentStageIndex: 2, stageState: 'STG_BURNING', burnTime: 450 }, { dry: 6, fuel: 0.25, oxid: 0.5 });
		assert.equal(derived.thrustForceVac, PROP().thrustKN * 1000);
		assert.equal(derived.thrustForce, PROP().thrustKN * 1000);
		assert.equal(derived.mass, 6 + 0.25 + 0.5);
		const passive = restore({ payload: payloadCfg({ ...PROP(), enabled: false }), hasPayloadPropulsion: false, isPayloadSeparated: true, currentStageIndex: 2, stageState: 'STG_BURNING', burnTime: 450 }, { dry: 6, fuel: 0.25, oxid: 0.5 });
		assert.equal(passive.thrustForce, 0);
		assert.equal(passive.mass, 6, 'passive payload mass = payload.massT');
	});

	it('restores separation flags as booleans', () => {
		const r = restore({ currentStageIndex: 1, isBoosterBurnout: 1, isBoosterSeparated: 'yes', stageState: 'STG_BURNING', burnTime: 10, isPayloadSeparated: 0 }, { dry: 4.5, fuel: 1, oxid: 1 });
		assert.strictEqual(r.isBoosterBurnout, true);
		assert.strictEqual(r.isBoosterSeparated, true);
		assert.strictEqual(r.isPayloadSeparated, false);
		const r2 = restore({ currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: 10, isStage2Separated: false, isPayloadSeparated: false }, { dry: 4.5, fuel: 1, oxid: 1 });
		assert.strictEqual(r2.isStage2Separated, false);
		assert.strictEqual(r2.isBoosterBurnout, false);
		assert.strictEqual(r2.isBoosterSeparated, false);
	});

	it('restores stageState, falling back to PRE_LAUNCH (held down) or STG_BURNING', () => {
		assert.equal(restore({ stageState: 'INTERSTAGE_COAST', currentStageIndex: 1, burnTime: 10 }).stageState, 'INTERSTAGE_COAST');
		assert.equal(restore({ stageState: 'STG_COAST', currentStageIndex: 1, burnTime: 10 }).stageState, 'STG_COAST');
		assert.equal(restore({ currentStageIndex: 0 }).stageState, 'STG_BURNING');
		assert.equal(restore({ stageState: '', currentStageIndex: 0 }).stageState, 'STG_BURNING');
		assert.equal(restore({ stageState: undefined, isHoldDown: true, currentStageIndex: 0 }).stageState, 'PRE_LAUNCH');
	});

	it('restores stgTimer only when finite (otherwise 0)', () => {
		const cases = [[0, 0], [2.5, 2.5], [1e6, 1e6], [NaN, 0], [Infinity, 0], ['2', 0], [null, 0], [undefined, 0]];
		for (const [input, expected] of cases) {
			assert.equal(restore({ stgTimer: input, currentStageIndex: 1, stageState: 'INTERSTAGE_COAST' }).stgTimer, expected, `stgTimer ${input}`);
		}
	});

	it('derives engine specs from the current stage and applies masses as transmitted', () => {
		const r = restore({ currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: 280 }, { dry: 4.5, fuel: 20, oxid: 50 });
		const s1 = stagesCfg()[1];
		assert.equal(r.fuelType, s1.fuelType);
		assert.equal(r.thrustForceVac, s1.thrustKN * 1000);
		assert.equal(r.thrustForce, s1.thrustKN * 1000);
		assert.equal(r.ispVac, s1.ispVac);
		assert.equal(r.ispSl, s1.ispSl);
		assert.equal(r.ofRatio, s1.ofRatio);
		assert.equal(r.dryMass, 4.5);
		assert.equal(r.fuelMass, 20);
		assert.equal(r.oxidMass, 50);
		assert.equal(r.burnTime, 280);
		assert.equal(r.massLossRate, (20 + 50) / 280);
		assert.equal(r.currentIsp, r.getEffectiveIsp(r.ambientPresRatio));
		assert.equal(r.currentIsp, s1.ispVac, 'vacuum (ambientPresRatio 0) -> ispVac');
		assertClose(r.mass, 6 + 1.7 + 4.5 + 20 + 50, 1e-12, 'payload + fairing + active stage');
	});

	it('ORBITAL_COAST keeps thrustForceVac but zeroes thrustForce', () => {
		const r = restore({ currentStageIndex: 1, stageState: 'ORBITAL_COAST', burnTime: 0 }, { dry: 4.5, fuel: 0, oxid: 0 });
		assert.equal(r.thrustForce, 0);
		assert.equal(r.thrustForceVac, stagesCfg()[1].thrustKN * 1000);
		assert.equal(r.massLossRate, 0, 'burnTime 0 -> massLossRate 0 (boundary)');
	});

	it('self-propelled separated payload uses payload.propulsion', () => {
		const prop = PROP();
		const r = makeCalcRocket({
			restoredRuntimeState: true, currentStageIndex: 2, isPayloadSeparated: true, hasPayloadPropulsion: true,
			stageState: 'STG_BURNING', burnTime: 450, payload: payloadCfg(prop)
		}, { dry: 6, fuel: 0.25, oxid: 0.5 });
		assert.equal(r.fuelType, prop.fuelType);
		assert.equal(r.thrustForceVac, prop.thrustKN * 1000);
		assert.equal(r.thrustForce, prop.thrustKN * 1000);
		assert.equal(r.ispVac, prop.ispVac);
		assert.equal(r.ispSl, prop.ispSl);
		assert.equal(r.ofRatio, prop.ofRatio);
		assert.equal(r.radius, 1.5, 'payload radius');
		assert.equal(r.massLossRate, 0.75 / 450);
		assert.equal(r.mass, 6 + 0.25 + 0.5, 'self-propelled payload mass = dry + propellant');
	});

	it('passive separated payload has no thrust and payload mass only', () => {
		const r = restore({ currentStageIndex: 2, isPayloadSeparated: true, hasPayloadPropulsion: false, stageState: 'ORBITAL_COAST' }, { dry: 6, fuel: 0, oxid: 0 });
		assert.equal(r.thrustForceVac, 0);
		assert.equal(r.thrustForce, 0);
		assert.equal(r.fuelType, 'liquid');
		assert.equal(r.radius, 1.5);
		assert.equal(r.mass, 6);
		const coasting = restore({ currentStageIndex: 2, isPayloadSeparated: true, hasPayloadPropulsion: false, stageState: 'STG_BURNING' }, { dry: 6, fuel: 0, oxid: 0 });
		assert.equal(coasting.thrustForce, 0, 'non-propelled payload never thrusts even if stageState says burning');
	});

	it('booster core thrust after SRB burnout and isBoosterIgnited consistency', () => {
		const burnout = restore({ boosters: boostersCfg(), currentStageIndex: 0, isBoosterBurnout: true, stageState: 'STG_BURNING', burnTime: 100 }, { dry: 25, fuel: 50, oxid: 100 });
		assert.equal(burnout.thrustForceVac, boostersCfg().coreThrustKN * 1000);
		assert.equal(burnout.isBoosterIgnited, false);
		const burning = restore({ boosters: boostersCfg(), currentStageIndex: 0, stageState: 'STG_BURNING', burnTime: 100 }, { dry: 25, fuel: 50, oxid: 100 });
		assert.equal(burning.thrustForceVac, stagesCfg()[0].thrustKN * 1000);
		assert.equal(burning.isBoosterIgnited, true);
		const held = restore({ boosters: boostersCfg(), currentStageIndex: 0, isHoldDown: true, stageState: 'PRE_LAUNCH', burnTime: 160 }, { dry: 25, fuel: 120, oxid: 280 });
		assert.equal(held.isBoosterIgnited, false, 'held down -> SRB not ignited');
		const sep = restore({ boosters: boostersCfg(), currentStageIndex: 0, isBoosterBurnout: true, isBoosterSeparated: true, stageState: 'STG_BURNING', burnTime: 100 }, { dry: 25, fuel: 50, oxid: 100 });
		assert.equal(sep.isBoosterIgnited, false);
	});

	it('Rev 6.11: repeats the booster dry-mass jettison of stages[0] at stage 0 after the SRB separation (Worker-only change)', () => {
		const b = boostersCfg();
		const s0 = stagesCfg()[0];
		const restored = (td) => makeCalcRocket({ boosters: b, restoredRuntimeState: true, currentStageIndex: 0, stageState: 'STG_BURNING', burnTime: 50, isBoosterBurnout: true, ...td }, { dry: 5, fuel: 50, oxid: 100 });
		// separateBoosters(): stages[0].dryMassT -= boosters.dryMassT (20 t)
		assert.equal(restored({ isBoosterSeparated: true }).stages[0].dryMassT, s0.dryMassT - b.dryMassT);
		const live = makeCalcRocket({ boosters: b });
		live.isBoosterBurnout = true;
		live.separateBoosters();
		assert.equal(restored({ isBoosterSeparated: true }).stages[0].dryMassT, live.stages[0].dryMassT, 'same as the live separation');
		// Not yet separated, already on stage 1 (stage 0 no longer read), payload separated, no boosters, normal init: unchanged
		assert.equal(restored({ isBoosterSeparated: false }).stages[0].dryMassT, s0.dryMassT);
		assert.equal(restored({ isBoosterSeparated: true, currentStageIndex: 1 }).stages[0].dryMassT, s0.dryMassT);
		assert.equal(restored({ isBoosterSeparated: true, isPayloadSeparated: true, currentStageIndex: 2 }).stages[0].dryMassT, s0.dryMassT);
		assert.equal(makeCalcRocket({ restoredRuntimeState: true, currentStageIndex: 0, isBoosterSeparated: true, stageState: 'STG_BURNING' }).stages[0].dryMassT, s0.dryMassT, 'no boosters');
		assert.equal(makeCalcRocket({ boosters: b, isBoosterSeparated: true }).stages[0].dryMassT, s0.dryMassT, 'normal initialization');
		// Booster dry-mass fallback of separateBoosters (2 -> 20 t, 4 -> 40 t) and the clamp at 0
		const { dryMassT: _boosterDry, ...noDry } = b;
		assert.equal(makeCalcRocket({ boosters: noDry, restoredRuntimeState: true, currentStageIndex: 0, isBoosterSeparated: true, isBoosterBurnout: true, stageState: 'STG_BURNING' }).stages[0].dryMassT, s0.dryMassT - 20);
		assert.equal(makeCalcRocket({ boosters: { ...noDry, count: 4 }, restoredRuntimeState: true, currentStageIndex: 0, isBoosterSeparated: true, isBoosterBurnout: true, stageState: 'STG_BURNING' }).stages[0].dryMassT, 0, 'max(0, 25 - 40)');
		// The stage-1 debris therefore carries the same mass as in the saved flight
		const r = restored({ isBoosterSeparated: true });
		r.separateCurrentStage();
		assert.equal(r._pendingDebris.at(-1).mass, s0.dryMassT - b.dryMassT);
	});

	it('sanitizes non-finite / negative masses and burn time', () => {
		const r = restore({ currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: NaN }, { dry: 4.5, fuel: -3, oxid: NaN });
		assert.equal(r.fuelMass, 0);
		assert.equal(r.oxidMass, 0);
		assert.equal(r.burnTime, 0);
		assert.equal(r.massLossRate, 0);
		const neg = restore({ currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: -5 }, { dry: 4.5, fuel: 1, oxid: 1 });
		assert.equal(neg.burnTime, 0);
		assert.equal(neg.massLossRate, 0);
	});
});

// ==================================================================
// 3. §4.7 CalcRocket runtime state
// ==================================================================
describe('Unit 10-3: CalcRocket.getRuntimeState / restoreRuntimeState (§4.7)', () => {
	it('exposes exactly the §4.7 runtime-state fields (Rev 6.2 + Rev 6.11)', () => {
		const r = makeCalcRocket();
		const st = r.getRuntimeState();
		assert.deepEqual(Object.keys(st).sort(), [...ROCKET_RT_KEYS].sort());
		assert.deepEqual(Object.keys(st.flightComputer).sort(), [...FC_KEYS].sort());
		assert.deepEqual(Object.keys(st.kinematics).sort(), [...KIN_KEYS].sort());
		assert.deepEqual(Object.keys(st.kinematics.aero).sort(), [...ROCKET_AERO_KEYS].sort());
		const s0 = stagesCfg()[0];
		assert.deepEqual(st, {
			flightComputer: DEFAULT_FC_STATE(0),
			isBoosterIgnited: false, boosterBurnTimer: 0, boosterSepTimer: 0,
			presState: 'ROLLOUT_FILL', presTimer: 0, tankPresFuel: 0, tankPresOxid: 0,
			presStartF: 0, presStartO: 0, postSepRcsTimer: 0, ullageRestartTimer: 0,
			// Rev 6.11: no thrust yet, stage-0 engine (_activateStage(0)), constructor pad angle / name, unset vent start
			thrustRatio: 0, wasFiring: false, massLossRate: (s0.fuelMassT + s0.oxidMassT) / s0.burnTime,
			thrustForce: s0.thrustKN * 1000, thrustForceVac: s0.thrustKN * 1000, ispVac: s0.ispVac, ispSl: s0.ispSl, ofRatio: s0.ofRatio,
			fuelType: s0.fuelType, hostAngleRad: 0, ventStartF: null, ventStartO: null, noiseFiltF: 0, noiseFiltO: 0, paramName: 'UnitRocket',
			kinematics: { x: 0, y: 7.0e6, vx: 7500, vy: 0, ax: 0, ay: 0, aero: { currentQ: 0, mach: 0, qAxialKpa: 0, qLateralKpa: 0, aoaDeg: 0, progradeAngle: 0 } }
		});
	});

	it('round-trips through JSON into a freshly constructed restored rocket', () => {
		const a = makeCalcRocket({ boosters: boostersCfg() });
		Object.assign(a, {
			isBoosterIgnited: true, boosterBurnTimer: 42.5, boosterSepTimer: 0.75, presState: 'IGNITION_TRANSIENT', presTimer: 7.25,
			tankPresFuel: 351.5, tankPresOxid: 349.75, _presStartF: 101.3, _presStartO: 101.25, _postSepRcsTimer: 1.5, _ullageRestartTimer: 0.5,
			// Rev 6.11 fields with values no constructor derives
			_thrustRatio: 0.625, _wasFiring: true, massLossRate: 1.75, thrustForce: 7.25e6, thrustForceVac: 2.94e6, ispVac: 305, ispSl: 271,
			ofRatio: 2.125, fuelType: 'solid', hostAngleRad: 4.75, _ventStartF: 352.25, _ventStartO: 348.5, _noiseFiltF: -0.375, _noiseFiltO: 0.875,
			x: 6.4e6 + 0.5, y: 1.25e5, vx: -3.5, vy: 7.75e3, ax: 1.5, ay: -9.25,
			_currentQ: 3125.5, mach: 1.75, _qAxialKpa: 3.0625, _qLateralKpa: 0.0625, _aoaDeg: 2.5, _progradeAngle: 1.375
		});
		a.flightComputer.restoreRuntimeState(SAMPLE_FC_STATE());
		const saved = a.getRuntimeState();
		assert.deepEqual(saved.kinematics, { x: 6.4e6 + 0.5, y: 1.25e5, vx: -3.5, vy: 7.75e3, ax: 1.5, ay: -9.25, aero: { currentQ: 3125.5, mach: 1.75, qAxialKpa: 3.0625, qLateralKpa: 0.0625, aoaDeg: 2.5, progradeAngle: 1.375 } });
		const json = JSON.parse(JSON.stringify(saved));
		const b = makeCalcRocket({ boosters: boostersCfg(), restoredRuntimeState: true, runtimeState: json, currentStageIndex: 0, stageState: 'STG_BURNING', burnTime: 100 }, { dry: 25, fuel: 60, oxid: 140 });
		assert.deepEqual(b.getRuntimeState(), saved);
		for (const [k, v] of Object.entries({ _thrustRatio: 0.625, _wasFiring: true, hostAngleRad: 4.75, _noiseFiltF: -0.375, x: 6.4e6 + 0.5, vy: 7.75e3, ax: 1.5, _aoaDeg: 2.5 })) {
			assert.strictEqual(b[k], v, `restored ${k}`);
		}
		assert.equal(b.flightComputer.currentThrustAngle, -1.125);
		assert.equal(b.flightComputer.getTriggerValue('time'), 123.5);
		assert.equal(b.flightComputer.getTriggerValue('apogee'), 123.5 - 100.25);
	});

	it('Rev 6.11: validates the thrust, engine, pad-angle and tank-filter fields (absent -> constructor value)', () => {
		const keep = Symbol('keep');
		// [state key, rocket property, cases [input, expected | keep]]
		const unitClamp = (lo, hi) => [[lo, lo], [hi, hi], [(lo + hi) / 2, (lo + hi) / 2], [hi + 1e-9, hi], [hi + 5, hi], [lo - 1e-9, lo], [lo - 5, lo], [1e308, hi], [-1e308, lo],
			[NaN, keep], [Infinity, keep], [-Infinity, keep], ['0.5', keep], [null, keep], [undefined, keep], [true, keep], [{}, keep]];
		const nonNeg = [[0, 0], [1.75, 1.75], [7.6e6, 7.6e6], [1e308, 1e308], [-1e-9, keep], [-5, keep], [NaN, keep], [Infinity, keep], ['3', keep], [null, keep], [undefined, keep], [false, keep]];
		const finite = [[0, 0], [-1.5, -1.5], [7.25, 7.25], [-1e6, -1e6], [NaN, keep], [Infinity, keep], [-Infinity, keep], ['1', keep], [null, keep], [undefined, keep]];
		const kpaOpt = [...KPA_CASES.filter(([i]) => Number.isFinite(i)), [NaN, keep], [Infinity, keep], ['350', keep], [null, keep], [undefined, keep]];
		const table = [
			['thrustRatio', '_thrustRatio', unitClamp(0, 1)],
			['noiseFiltF', '_noiseFiltF', unitClamp(-1, 1)],
			['noiseFiltO', '_noiseFiltO', unitClamp(-1, 1)],
			['massLossRate', 'massLossRate', nonNeg],
			['thrustForce', 'thrustForce', nonNeg],
			['thrustForceVac', 'thrustForceVac', nonNeg],
			['ispVac', 'ispVac', nonNeg],
			['ispSl', 'ispSl', nonNeg],
			['ofRatio', 'ofRatio', nonNeg],
			['hostAngleRad', 'hostAngleRad', finite],
			['ventStartF', '_ventStartF', kpaOpt],
			['ventStartO', '_ventStartO', kpaOpt]
		];
		for (const [key, prop, cases] of table) {
			for (const [input, expected] of cases) {
				const r = makeCalcRocket({ hostAngleRad: 0.25 });
				const before = r[prop];
				r.restoreRuntimeState({ [key]: input });
				const want = expected === keep ? before : expected;
				assert.ok(Object.is(r[prop], want), `${key} ${String(input)} -> ${String(r[prop])} (expected ${String(want)})`);
			}
		}
		for (const [input, expected] of [[true, true], [false, false], ['true', false], [1, false], [null, false], [undefined, false]]) {
			const r = makeCalcRocket();
			r.restoreRuntimeState({ wasFiring: input });
			assert.strictEqual(r._wasFiring, expected, `wasFiring ${String(input)}`);
		}
		const known = Object.keys(ROCKET_FUELS).filter(k => k !== stagesCfg()[0].fuelType);
		assert.ok(known.length > 0, 'fuel presets loaded');
		for (const f of known) {
			const r = makeCalcRocket();
			r.restoreRuntimeState({ fuelType: f });
			assert.equal(r.fuelType, f, `fuelType ${f}`);
		}
		for (const bad of ['no_such_fuel', '', 'LIQUID', 3, null, undefined, {}]) {
			const r = makeCalcRocket();
			r.restoreRuntimeState({ fuelType: bad });
			assert.equal(r.fuelType, stagesCfg()[0].fuelType, `fuelType ${JSON.stringify(bad)} keeps the stage fuel`);
		}
		// Pre-Rev 6.11 runtime state: the constructor's values survive (no exception)
		const old = makeCalcRocket({ restoredRuntimeState: true, runtimeState: Object.fromEntries(ROCKET_RT_KEYS_62.map(k => [k, SAMPLE_ROCKET_RT()[k]])),
			currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: 280, hostAngleRad: 0.25 }, { dry: 4.5, fuel: 20, oxid: 50 });
		const s1 = stagesCfg()[1];
		assert.deepEqual([old._thrustRatio, old._wasFiring, old.massLossRate, old.thrustForce, old.thrustForceVac, old.hostAngleRad, old._ventStartF, old._noiseFiltF],
			[0, false, (20 + 50) / 280, s1.thrustKN * 1000, s1.thrustKN * 1000, 0.25, undefined, 0]);
		assert.equal(old.presState, 'NOMINAL', 'Rev 6.2 fields still restored');
	});

	it('Rev 6.11: thrust state restores the first sub-step: applyThrust and the engine-start detection see the saved burn', () => {
		const burning = (rt) => makeCalcRocket({ restoredRuntimeState: true, runtimeState: rt, currentStageIndex: 0, stageState: 'STG_BURNING', burnTime: 100 }, { dry: 25, fuel: 60, oxid: 140 });
		const rt = { ...SAMPLE_ROCKET_RT(), thrustRatio: 1, wasFiring: true, presState: 'NOMINAL', presTimer: 3, kinematics: null };
		const r = burning(rt);
		r.ax = 0; r.ay = 0; r.thrustAngle = 0; r.ambientPresRatio = 0;
		r.applyThrust();
		// effective thrust (vacuum) / mass, along thrustAngle 0
		assertClose(r.ax, r.getEffectiveThrustForce(0) * r.invMassKg, 1e-12, 'thrust acceleration from the restored ratio');
		const { thrustRatio: _ratio, wasFiring: _firing, ...pre611 } = rt;
		const old = burning(pre611);
		old.ax = 0; old.applyThrust();
		assert.equal(old.ax, 0, 'pre-6.11 runtime state: no thrust in the first sub-step (the G3-1-01 defect)');
		// updatePressure: engine already firing -> no new IGNITION_TRANSIENT
		r.isIgnited = true;
		r.updatePressure(0.05, 0);
		assert.equal(r.presState, 'NOMINAL', 'restored wasFiring: no spurious engine-start transient');
		old.isIgnited = true;
		old._thrustRatio = 1;
		old.updatePressure(0.05, 0);
		assert.equal(old.presState, 'IGNITION_TRANSIENT', 'without wasFiring the same step detects an engine start');
	});

	it('Rev 6.11: kinematics restore exact position / velocity and keep a(t) and the aero cache for re-application', () => {
		const r = makeCalcRocket();
		r.restoreRuntimeState({ kinematics: SAMPLE_KINEMATICS() });
		const k = SAMPLE_KINEMATICS();
		assert.deepEqual([r.x, r.y, r.vx, r.vy, r.ax, r.ay], [k.x, k.y, k.vx, k.vy, k.ax, k.ay]);
		assert.deepEqual([r._currentQ, r.mach, r._qAxialKpa, r._qLateralKpa, r._aoaDeg, r._progradeAngle], ROCKET_AERO_KEYS.map(key => k.aero[key]));
		assert.deepEqual(r._restoredForces, { ax: k.ax, ay: k.ay, aero: k.aero }, 'kept until the first step');
		// A force evaluation overwrites them; applyRestoredForces() puts the saved values back
		r.ax = 0; r.ay = 0; r._qAxialKpa = 9; r._aoaDeg = 1; r.mach = 0;
		r.applyRestoredForces();
		assert.deepEqual([r.ax, r.ay, r._qAxialKpa, r._aoaDeg, r.mach], [k.ax, k.ay, k.aero.qAxialKpa, k.aero.aoaDeg, k.aero.mach]);
		assert.deepEqual(r.getRuntimeState().kinematics, k, 'round trip');
		// Any missing / non-finite kinematic value: ignored as a whole
		for (const key of ['x', 'y', 'vx', 'vy', 'ax', 'ay']) {
			for (const bad of [NaN, Infinity, '1', null, undefined]) {
				const q = makeCalcRocket();
				const before = q.getRuntimeState().kinematics;
				q.restoreRuntimeState({ kinematics: { ...SAMPLE_KINEMATICS(), [key]: bad } });
				assert.deepEqual(q.getRuntimeState().kinematics, before, `${key} ${String(bad)}`);
				assert.equal(q._restoredForces, undefined);
			}
		}
		for (const bad of [null, 'k', 5, [], true]) {
			const q = makeCalcRocket();
			q.restoreRuntimeState({ kinematics: bad });
			assert.equal(q.x, 0, `kinematics ${JSON.stringify(bad)}`);
			assert.equal(q._restoredForces, undefined);
		}
		// Aero cache: validated one by one (non-negative pressures / Mach, AoA in [0, 180] deg, finite prograde angle)
		const aeroCases = [
			['currentQ', '_currentQ', [[0, 0], [5, 5], [-1, null], [NaN, null], ['5', null]]],
			['mach', 'mach', [[0, 0], [25, 25], [-0.5, null], [Infinity, null]]],
			['qAxialKpa', '_qAxialKpa', [[0, 0], [60, 60], [-1e-9, null], [NaN, null]]],
			['qLateralKpa', '_qLateralKpa', [[0, 0], [3, 3], [-2, null], [null, null]]],
			['aoaDeg', '_aoaDeg', [[0, 0], [180, 180], [180 + 1e-9, null], [-1, null], [NaN, null]]],
			['progradeAngle', '_progradeAngle', [[-3.5, -3.5], [7, 7], [NaN, null], [Infinity, null], ['1', null]]]
		];
		for (const [key, prop, cases] of aeroCases) {
			for (const [input, expected] of cases) {
				const q = makeCalcRocket();
				const before = q[prop];
				q.restoreRuntimeState({ kinematics: { ...SAMPLE_KINEMATICS(), aero: { [key]: input } } });
				assert.ok(Object.is(q[prop], expected === null ? before : expected), `aero.${key} ${String(input)}`);
				assert.equal(q.x, SAMPLE_KINEMATICS().x, 'position applied regardless of the aero cache');
			}
		}
		const noAero = makeCalcRocket();
		noAero.restoreRuntimeState({ kinematics: { ...SAMPLE_KINEMATICS(), aero: 'x' } });
		assert.deepEqual(noAero._restoredForces.aero, {}, 'non-object aero cache ignored');
	});

	it('restores presState only from the TANK_PRESSURE_STATES allow-list', () => {
		for (const s of TANK_PRESSURE_STATES) {
			const r = makeCalcRocket();
			r.restoreRuntimeState({ ...SAMPLE_ROCKET_RT(), presState: s });
			assert.equal(r.presState, s, `allowed ${s}`);
		}
		for (const bad of ['HACKED', '', 'nominal', ' NOMINAL', 'NOMINAL ', null, undefined, 3, {}, ['NOMINAL'], true]) {
			const r = makeCalcRocket();
			r.restoreRuntimeState({ ...SAMPLE_ROCKET_RT(), presState: bad });
			assert.equal(r.presState, 'ROLLOUT_FILL', `rejected ${JSON.stringify(bad)} keeps the initial state`);
			const n = makeCalcRocket();
			n.presState = 'NOMINAL';
			n.restoreRuntimeState({ presState: bad });
			assert.equal(n.presState, 'NOMINAL', `rejected ${JSON.stringify(bad)} keeps the current state`);
		}
	});

	it('TANK_PRESSURE_STATES is frozen and matches every presState the state machine assigns', () => {
		assert.ok(Object.isFrozen(TANK_PRESSURE_STATES));
		assert.equal(new Set(TANK_PRESSURE_STATES).size, TANK_PRESSURE_STATES.length, 'no duplicates');
		const assigned = new Set([...SRC('gravsim_calc_object.js').matchAll(/presState\s*=\s*'([A-Z_]+)'/g)].map(m => m[1]));
		assert.deepEqual([...assigned].sort(), [...TANK_PRESSURE_STATES].sort());
	});

	it('clamps tank pressures to [0, 2 x MAX_SCALE_KPA]', () => {
		for (const key of ['tankPresFuel', 'tankPresOxid', 'presStartF', 'presStartO']) {
			const prop = { presStartF: '_presStartF', presStartO: '_presStartO' }[key] || key;
			for (const [input, expected] of KPA_CASES) {
				const r = makeCalcRocket();
				r.restoreRuntimeState({ ...SAMPLE_ROCKET_RT(), [key]: input });
				assert.strictEqual(r[prop], expected, `${key} ${String(input)}`);
			}
		}
	});

	it('clamps timers to [0, RUNTIME_RESTORE_MAX_TIME_S]', () => {
		const map = { boosterBurnTimer: 'boosterBurnTimer', boosterSepTimer: 'boosterSepTimer', presTimer: 'presTimer', postSepRcsTimer: '_postSepRcsTimer', ullageRestartTimer: '_ullageRestartTimer' };
		for (const [key, prop] of Object.entries(map)) {
			for (const [input, expected] of TIME_CASES) {
				const r = makeCalcRocket();
				r.restoreRuntimeState({ ...SAMPLE_ROCKET_RT(), [key]: input });
				assert.strictEqual(r[prop], expected, `${key} ${String(input)}`);
			}
		}
	});

	it('restores isBoosterIgnited gated (airborne and ignited) while the SRBs burn on stage 0, as saved afterwards (Rev 6.11)', () => {
		const airborne = () => makeCalcRocket({ boosters: boostersCfg() });
		const a = airborne();
		a.restoreRuntimeState({ isBoosterIgnited: false });
		assert.equal(a.isBoosterIgnited, false);
		a.restoreRuntimeState({ isBoosterIgnited: true });
		assert.equal(a.isBoosterIgnited, true);

		const held = makeCalcRocket({ boosters: boostersCfg(), isHoldDown: true, isIgnited: true });
		held.restoreRuntimeState({ isBoosterIgnited: true });
		assert.equal(held.isBoosterIgnited, false, 'held down');

		const notIgnited = makeCalcRocket({ boosters: boostersCfg(), isIgnited: false });
		notIgnited.restoreRuntimeState({ isBoosterIgnited: true });
		assert.equal(notIgnited.isBoosterIgnited, false, 'not ignited');

		// Burnt out / separated / upper stage: the flag no longer selects the thrust model (getEffectiveThrustForce /
		// getEffectiveIsp require !isBoosterBurnout && stage 0), so the saved boolean is kept as is (exact round trip)
		for (const [label, patch] of [['burnt out', { isBoosterBurnout: true }], ['burnt out and separated', { isBoosterBurnout: true, isBoosterSeparated: true }],
			['upper stage', { currentStageIndex: 1 }], ['burnt out, held down', { isBoosterBurnout: true, isHoldDown: true }]]) {
			for (const saved of [true, false]) {
				const q = airborne();
				Object.assign(q, patch);
				q.restoreRuntimeState({ isBoosterIgnited: saved });
				assert.equal(q.isBoosterIgnited, saved, `${label}: saved ${saved} kept`);
			}
			const q = airborne();
			Object.assign(q, patch, { isBoosterIgnited: true });
			q.restoreRuntimeState({ isBoosterIgnited: 'true' });
			assert.equal(q.isBoosterIgnited, true, `${label}: non-boolean leaves the flag untouched`);
			const thrust = q.getEffectiveThrustForce(0);
			q.isBoosterIgnited = false;
			assert.equal(q.getEffectiveThrustForce(0), thrust, `${label}: the flag does not change the thrust`);
		}

		// Separated but not burnt out on stage 0 cannot be produced by the flight (separateBoosters follows the burnout):
		// the flag would select the SRB thrust, so it is left untouched
		const inconsistent = airborne();
		inconsistent.isBoosterSeparated = true;
		inconsistent.restoreRuntimeState({ isBoosterIgnited: true });
		assert.equal(inconsistent.isBoosterIgnited, false, 'separated without burnout: left untouched');

		const noSrb = makeCalcRocket();
		noSrb.restoreRuntimeState({ isBoosterIgnited: true });
		assert.equal(noSrb.isBoosterIgnited, false, 'no boosters: left untouched');
	});

	it('delegates flightComputer state and skips it when absent', () => {
		const r = makeCalcRocket();
		r.restoreRuntimeState({ flightComputer: SAMPLE_FC_STATE() });
		assert.deepEqual(r.flightComputer.getRuntimeState(), SAMPLE_FC_STATE());
		r.restoreRuntimeState({ flightComputer: null });
		assert.deepEqual(r.flightComputer.getRuntimeState(), SAMPLE_FC_STATE(), 'null flightComputer leaves FC untouched');
	});

	it('ignores non-object state and resets missing fields of an object state to their initial values', () => {
		for (const bad of [null, undefined, 0, 42, 'state', true]) {
			const r = makeCalcRocket();
			r.restoreRuntimeState(SAMPLE_ROCKET_RT());
			const before = r.getRuntimeState();
			r.restoreRuntimeState(bad);
			assert.deepEqual(r.getRuntimeState(), before, `${JSON.stringify(bad)} is ignored`);
		}
		const r = makeCalcRocket();
		r.restoreRuntimeState({});
		assert.deepEqual(r.getRuntimeState(), makeCalcRocket().getRuntimeState(), 'empty object -> initial values');
	});
});

// ==================================================================
// 4. §4.7 FlightComputer runtime state
// ==================================================================
describe('Unit 10-4: FlightComputer.getRuntimeState / restoreRuntimeState (§4.7)', () => {
	const fcWith = (patch, profile = PROFILE()) => {
		const fc = new FlightComputer({ flightProfile: profile });
		fc.restoreRuntimeState({ ...SAMPLE_FC_STATE(), ...patch });
		return fc;
	};

	it('exposes exactly the §4.7 fields with initial values on a fresh FC', () => {
		const fc = new FlightComputer({ flightProfile: PROFILE(), thrustAngle: -1.5 });
		assert.deepEqual(fc.getRuntimeState(), DEFAULT_FC_STATE(-1.5));
	});

	it('round-trips internal state (including Set -> array) and returns copies', () => {
		const a = new FlightComputer({ flightProfile: PROFILE() });
		a.flightTime = 123.5;
		a.targetLaunchAngle = -1.25;
		a._highestStepIndex = 3;
		a._triggeredActionIndices = new Set([1, 3]);
		a._pendingActions = ['sep_payload'];
		a.hasPassedApogee = true;
		a.apogeeTime = 100.25;
		a._prevVv = -12.5;
		a.maxRecordedQ = 35.25;
		a.hasPassedMaxQ = true;
		a.maxQConfirmTimer = 0.5;
		a.maxQStatusTimer = 3;
		a.currentThrustAngle = -1.125;
		a._isAntiStallActive = true;
		const st = a.getRuntimeState();
		assert.deepEqual(st, SAMPLE_FC_STATE());
		st.triggeredActionIndices.push(4);
		st.pendingActions.push('sep_stage1');
		assert.deepEqual([...a._triggeredActionIndices], [1, 3], 'returned array is a copy');
		assert.deepEqual(a._pendingActions, ['sep_payload'], 'returned array is a copy');

		const b = new FlightComputer({ flightProfile: PROFILE() });
		b.restoreRuntimeState(JSON.parse(JSON.stringify(a.getRuntimeState())));
		assert.deepEqual(b.getRuntimeState(), SAMPLE_FC_STATE());
		assert.ok(b._triggeredActionIndices instanceof Set);
		assert.equal(b.hasScheduledAction('sep_stage1'), false, 'latched row 1');
		assert.equal(b.hasScheduledAction('sep_payload'), true, 'row 4 not latched yet');
		assert.deepEqual(b.consumePendingActions(), ['sep_payload']);
		assert.deepEqual(b.consumePendingActions(), []);
	});

	it('clamps flightTime and Max-Q timers to [0, RUNTIME_RESTORE_MAX_TIME_S]', () => {
		for (const key of ['flightTime', 'maxQConfirmTimer', 'maxQStatusTimer']) {
			for (const [input, expected] of TIME_CASES) {
				assert.strictEqual(fcWith({ [key]: input })[key], expected, `${key} ${String(input)}`);
			}
		}
	});

	it('restores apogeeTime (clamped) only when hasPassedApogee', () => {
		for (const [input, expected] of TIME_CASES) {
			const finite = Number.isFinite(input);
			assert.strictEqual(fcWith({ hasPassedApogee: true, apogeeTime: input }).apogeeTime, finite ? expected : null, `apogeeTime ${String(input)}`);
		}
		assert.strictEqual(fcWith({ hasPassedApogee: false, apogeeTime: 50 }).apogeeTime, null);
		assert.strictEqual(fcWith({ hasPassedApogee: undefined, apogeeTime: 50 }).hasPassedApogee, false);
		assert.ok(Number.isNaN(fcWith({ hasPassedApogee: false, apogeeTime: 50 }).getTriggerValue('apogee')));
	});

	it('clamps highestStepIndex to [-1, profile length - 1] as an integer', () => {
		const cases = [[-1, -1], [-2, -1], [0, 0], [3, 3], [4, 4], [5, 4], [999, 4], [2.9, 2], [NaN, -1], [Infinity, -1], ['2', -1], [null, -1], [undefined, -1]];
		for (const [input, expected] of cases) {
			assert.strictEqual(fcWith({ highestStepIndex: input })._highestStepIndex, expected, `highestStepIndex ${String(input)}`);
		}
		const empty = new FlightComputer({ flightProfile: [] });
		empty.restoreRuntimeState({ ...SAMPLE_FC_STATE(), highestStepIndex: 3 });
		assert.equal(empty._highestStepIndex, -1, 'empty profile');
		assert.equal(empty._triggeredActionIndices.size, 0);
		assert.deepEqual(empty._pendingActions, []);
	});

	it('accepts triggeredActionIndices only for in-range integer rows that carry an action', () => {
		const cases = [
			[[1, 3], [1, 3]], [[1, 3, 4], [1, 3, 4]], [[0, 2], []], [[1, 2, 3], [1, 3]],
			[[-1, 5, 99], []], [[1.5, '1', null, NaN, 3], [3]], [[1, 1, 3, 3], [1, 3]],
			['1', []], [5, []], [{ 0: 1 }, []], [null, []], [undefined, []], [[], []]
		];
		for (const [input, expected] of cases) {
			const fc = fcWith({ triggeredActionIndices: input, pendingActions: [] });
			assert.deepEqual([...fc._triggeredActionIndices].sort((x, y) => x - y), expected, `triggered ${JSON.stringify(input)}`);
		}
	});

	it('accepts pendingActions only for latched rows, bounded by the number of latched rows per action', () => {
		const cases = [
			[[1, 3, 4], ['sep_payload', 'sep_payload', 'sep_payload', 'sep_stage1', 'sep_stage1', 'sep_stage2', 42, null], ['sep_payload', 'sep_payload', 'sep_stage1']],
			[[3], ['sep_payload', 'sep_payload', 'sep_stage1'], ['sep_payload']],
			[[1], ['sep_payload', 'sep_stage1'], ['sep_stage1']],
			[[], ['sep_stage1', 'sep_payload'], []],
			[[0, 2], ['sep_stage1'], []],
			[[1, 3], 'sep_stage1', []],
			[[1, 3], null, []],
			[[1, 3], [], []]
		];
		for (const [latched, pending, expected] of cases) {
			const fc = fcWith({ triggeredActionIndices: latched, pendingActions: pending });
			assert.deepEqual(fc._pendingActions, expected, `latched ${JSON.stringify(latched)} pending ${JSON.stringify(pending)}`);
		}
	});

	it('sanitizes prevVv, maxRecordedQ, targetLaunchAngle and boolean flags', () => {
		assert.equal(fcWith({ prevVv: -12.5 })._prevVv, -12.5, 'negative vertical speed kept');
		for (const bad of [NaN, Infinity, '5', null]) {
			assert.equal(fcWith({ prevVv: bad })._prevVv, 0, `prevVv ${String(bad)}`);
			assert.equal(fcWith({ maxRecordedQ: bad }).maxRecordedQ, 0, `maxRecordedQ ${String(bad)}`);
			assert.equal(fcWith({ targetLaunchAngle: bad }).targetLaunchAngle, 0, `targetLaunchAngle ${String(bad)} keeps the initial angle`);
		}
		assert.equal(fcWith({ maxRecordedQ: -1 }).maxRecordedQ, 0);
		assert.equal(fcWith({ maxRecordedQ: 0 }).maxRecordedQ, 0);
		assert.equal(fcWith({ maxRecordedQ: 35.25 }).maxRecordedQ, 35.25);
		assert.equal(fcWith({ targetLaunchAngle: -3.5 }).targetLaunchAngle, -3.5);
		assert.strictEqual(fcWith({ hasPassedMaxQ: false }).hasPassedMaxQ, false);
		assert.strictEqual(fcWith({ hasPassedMaxQ: undefined }).hasPassedMaxQ, false);
		assert.strictEqual(fcWith({ hasPassedMaxQ: true }).hasPassedMaxQ, true);
	});

	it('ignores non-object state and resets an empty object to initial values', () => {
		for (const bad of [null, undefined, 0, 42, 'state', true]) {
			const fc = fcWith({});
			fc.restoreRuntimeState(bad);
			assert.deepEqual(fc.getRuntimeState(), SAMPLE_FC_STATE(), `${JSON.stringify(bad)} ignored`);
		}
		const fc = fcWith({});
		fc.restoreRuntimeState({});
		// Rev 6.2 fields reset; the angles and the Rev 6.11 optional fields keep their current values
		assert.deepEqual(fc.getRuntimeState(), { ...DEFAULT_FC_STATE(0), targetLaunchAngle: -1.25, currentThrustAngle: -1.125, isAntiStallActive: true },
			'missing fields -> initial values (angles and optional flags kept)');
	});

	it('Rev 6.11: restores the attitude command currentThrustAngle (finite only) and the anti-stall flag (boolean only)', () => {
		// Constructor value = config.thrustAngle; hold-down re-syncs the rocket's thrustAngle to the pad, so they differ
		const fresh = () => new FlightComputer({ flightProfile: PROFILE(), thrustAngle: -1.5 });
		for (const v of [-1.125, 0, -0, 3.5, -7.25, 1e6]) {
			const fc = fresh();
			fc.restoreRuntimeState({ currentThrustAngle: v });
			assert.ok(Object.is(fc.currentThrustAngle, v), `currentThrustAngle ${v}`);
			assert.ok(Object.is(fc.currentThrustAngleRad, v), 'the output angle matches until the next update()');
		}
		for (const bad of [NaN, Infinity, -Infinity, '1.5', null, undefined, true, {}]) {
			const fc = fresh();
			fc.restoreRuntimeState({ currentThrustAngle: bad });
			assert.equal(fc.currentThrustAngle, -1.5, `currentThrustAngle ${String(bad)} keeps the constructor value`);
			assert.equal(fc.currentThrustAngleRad, -1.5);
		}
		for (const [v, expected] of [[true, true], [false, false], ['true', false], [1, false], [null, false], [undefined, false]]) {
			const fc = fresh();
			fc.restoreRuntimeState({ isAntiStallActive: v });
			assert.strictEqual(fc._isAntiStallActive, expected, `isAntiStallActive ${String(v)}`);
		}
		const kept = fresh();
		kept._isAntiStallActive = true;
		kept.restoreRuntimeState({ isAntiStallActive: 'false' });
		assert.strictEqual(kept._isAntiStallActive, true, 'non-boolean keeps the current flag');
	});

	it('Rev 6.11: a restored attitude command continues the rate-limited turn like the saved FC', () => {
		// Both FCs see the same sensor; only the restored one starts from the saved command (tower-clearance rate limit)
		const sensor = () => ({ dt: 0.05, isHoldDown: false, refBody: { x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: 6.371e6, name: 'Earth' }, distToRefM: 6.3715e6,
			x: 6.3715e6, y: 0, vx: 0, vy: 465, ax: 0, ay: 0, mass: 500, fuelMass: 400, thrustForce: 7.6e6, thrustRatio: 1, burnTime: 100, massLossRate: 2.5,
			qAxialKpa: 0, qLateralKpa: 0, aoaDeg: 0, progradeAngle: 0, stageState: 'STG_BURNING', isIgnited: true });
		const a = new FlightComputer({ flightProfile: [], thrustAngle: 0.5 });
		a.update(sensor());
		const saved = JSON.parse(JSON.stringify(a.getRuntimeState()));
		const b = new FlightComputer({ flightProfile: [], thrustAngle: 0.5 });
		b.restoreRuntimeState(saved);
		const old = new FlightComputer({ flightProfile: [], thrustAngle: 0.5 });
		const { currentThrustAngle: _angle, isAntiStallActive: _antiStall, ...pre611 } = saved;
		old.restoreRuntimeState(pre611);
		a.update(sensor());
		b.update(sensor());
		old.update(sensor());
		assert.ok(Object.is(b.currentThrustAngleRad, a.currentThrustAngleRad), 'restored FC: same command after the next update');
		assert.notEqual(old.currentThrustAngleRad, a.currentThrustAngleRad, 'without the saved command the turn restarts from thrustAngle');
	});

	it('tolerates a non-array flight profile', () => {
		const fc = new FlightComputer({ flightProfile: 'not-a-profile' });
		fc.restoreRuntimeState(SAMPLE_FC_STATE());
		assert.equal(fc._highestStepIndex, -1);
		assert.equal(fc._triggeredActionIndices.size, 0);
		assert.deepEqual(fc._pendingActions, []);
		assert.equal(fc.flightTime, 123.5);
	});
});

// ==================================================================
// 5. §4.7 Worker side
// ==================================================================
const calcRocketPayload = (id, extra = {}) => ({
	cmd: 'add', id, name: 'Rocket', type: OBJECT_TYPES.ROCKET, x: 7.0e6 + id, y: 0, vx: 0, vy: 7500, radius: 31.5, generation: 0,
	mass: 25, fuelMass: 120, oxidMass: 280, thrustForce: 7.6e6, burnTime: 160, stages: stagesCfg(), payload: payloadCfg(), fairing: fairingCfg(),
	flightProfile: PROFILE(), param: {}, ...extra
});

describe('Unit 10-5: Worker runtime snapshot (§4.7)', () => {
	it('PhysicsEngine.getRocketRuntimeSnapshot returns every live object in object order (Rev 6.11: also bodies and debris)', () => {
		const engine = new PhysicsEngine();
		assert.deepEqual(engine.getRocketRuntimeSnapshot(), [], 'empty engine');
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.371e6, param: {} });
		const r1 = engine.addObject(calcRocketPayload(21));
		const r2 = engine.addObject(calcRocketPayload(22));
		const r3 = engine.addObject(calcRocketPayload(23));
		const deb = engine.addObject({ id: 30, name: 'Debris', type: OBJECT_TYPES.DEBRIS, x: 1e7, y: 0, mass: 1, radius: 2, debrisSubType: 3, parentRocketId: 21 });
		r1.flightComputer.flightTime = 11;
		r3.flightComputer.flightTime = 33;
		const kin = (o) => ({ x: o.x, y: o.y, vx: o.vx, vy: o.vy, ax: o.ax, ay: o.ay, aero: { currentQ: o._currentQ, mach: o.mach } });
		assert.deepEqual(engine.getRocketRuntimeSnapshot(), [
			{ id: 1, runtimeState: { kinematics: kin(earth), mass: 5.972e24 } },
			{ id: 21, runtimeState: r1.getRuntimeState() },
			{ id: 22, runtimeState: r2.getRuntimeState() },
			{ id: 23, runtimeState: r3.getRuntimeState() },
			{ id: 30, runtimeState: { kinematics: kin(deb), parentRocketId: 21 } }
		]);
		assert.equal(engine.getRocketRuntimeSnapshot()[1].runtimeState.flightComputer.flightTime, 11);
		r2.collided = true;
		r3.shattered = true;
		deb.collided = true;
		assert.deepEqual(engine.getRocketRuntimeSnapshot().map(e => e.id), [1, 21], 'collided / shattered objects are skipped');
		engine.objects.push({ id: 40, type: OBJECT_TYPES.ROCKET, collided: false, shattered: false });
		assert.deepEqual(engine.getRocketRuntimeSnapshot().map(e => e.id), [1, 21], 'object without getRuntimeState is skipped');
	});

	it("SimulationController answers 'snapshotRuntime' with 'runtimeSnapshot' echoing requestId", () => {
		const ctrl = new SimulationController();
		ctrl.handleMessage({ data: calcRocketPayload(51) });
		ctrl.handleMessage({ data: calcRocketPayload(52) });
		const r51 = ctrl.engine.objects.find(o => o.id === 51);
		r51.flightComputer.flightTime = 99.5;
		r51.presState = 'NOMINAL';
		for (const requestId of [7, 0, 2 ** 31]) {
			const posted = withSelf(() => ctrl.handleMessage({ data: { cmd: 'snapshotRuntime', requestId } }));
			assert.equal(posted.length, 1);
			assert.deepEqual(posted[0], { cmd: 'runtimeSnapshot', requestId, rockets: ctrl.engine.getRocketRuntimeSnapshot() });
			assert.equal(posted[0].rockets[0].runtimeState.flightComputer.flightTime, 99.5);
			assert.equal(posted[0].rockets[0].runtimeState.presState, 'NOMINAL');
		}
		const empty = new SimulationController();
		const posted = withSelf(() => empty.handleMessage({ data: { cmd: 'snapshotRuntime', requestId: 3 } }));
		assert.deepEqual(posted, [{ cmd: 'runtimeSnapshot', requestId: 3, rockets: [] }]);
		ctrl.destroy();
		empty.destroy();
	});

	it("PhysicsEngine.addObject forwards the restore fields and runtimeState to CalcRocket", () => {
		const engine = new PhysicsEngine();
		const r = engine.addObject(calcRocketPayload(61, {
			mass: 4.5, fuelMass: 20, oxidMass: 50, burnTime: 280, currentStageIndex: 1, isPayloadSeparated: false, isStage2Separated: false,
			isBoosterBurnout: true, isBoosterSeparated: true, hasPayloadPropulsion: false, stageState: 'STG_COAST', stgTimer: 3.5,
			targetVInfKmS: 3.3, restoredRuntimeState: true, runtimeState: SAMPLE_ROCKET_RT()
		}));
		assert.equal(r.currentStageIndex, 1);
		assert.equal(r.stageState, 'STG_COAST');
		assert.equal(r.stgTimer, 3.5);
		assert.equal(r.isBoosterBurnout, true);
		assert.equal(r.isBoosterSeparated, true);
		assert.equal(r.targetVInfKmS, 3.3);
		assert.equal(r.dryMass, 4.5);
		assert.equal(r.burnTime, 280);
		assert.deepEqual(r.getRuntimeState().flightComputer, SAMPLE_FC_STATE());
		assert.equal(r.presState, 'NOMINAL');
		const plain = engine.addObject(calcRocketPayload(62, { restoredRuntimeState: false, runtimeState: SAMPLE_ROCKET_RT(), stageState: 'PRE_LAUNCH', currentStageIndex: 1 }));
		assertActivatedStage0(plain, 'restoredRuntimeState false via addObject');
		assert.equal(plain.flightComputer.flightTime, 0);
	});

	// G3-1-02: the fixture above uses the main-thread defaults for most flags, so a dropped flag would still compare equal.
	// Every §3.5-1 boolean of the forwarding below is the inverse of that fixture and of the Rocket / CalcRocket default.
	it('G3-1-02: PhysicsEngine.addObject forwards every inverted boolean (hold-down, not ignited, payload / stage 2 separated, ...)', () => {
		const three = [...stagesCfg(), { ...stagesCfg()[1], stageNumber: 3, name: 'S3' }];
		const base = calcRocketPayload(63, {
			mass: 4.5, fuelMass: 20, oxidMass: 50, burnTime: 280, currentStageIndex: 1, stageState: 'STG_COAST', stgTimer: 3.5,
			restoredRuntimeState: true, runtimeState: SAMPLE_ROCKET_RT()
		});
		// Fixture of the test above (61) and its inverse; every boolean the Worker reads from the 'add' message
		const flags61 = {
			isHoldDown: false, isIgnited: true, isPayloadSeparated: false, isStage2Separated: false, isBoosterBurnout: true, isBoosterSeparated: true,
			hasPayloadPropulsion: false, autoControl: true, disableStaging: false, disableOrbitalCutoff: false, fairingSeparated: false
		};
		const inverse = Object.fromEntries(Object.entries(flags61).map(([k, v]) => [k, !v]));
		const build = (f) => {
			const { fairingSeparated, ...rest } = f;
			return structuredClone({ ...base, ...rest, stages: three, boosters: boostersCfg(), fairing: { ...fairingCfg(), isSeparated: fairingSeparated } });
		};
		// Each boolean has its non-default value in one of the two fixtures (main-thread Rocket and freshly placed CalcRocket)
		const mainDefault = new Rocket(1, 'Rocket', 0, 0, 0, 0, 1, 1, 1, '#fff', 1, 1, 0, null, 0);
		const workerDefault = makeCalcRocket();
		const defaults = (o) => ({ ...Object.fromEntries(Object.keys(flags61).map(k => [k, Boolean(o[k])])), fairingSeparated: Boolean(o.fairing?.isSeparated) });
		for (const [label, def] of [['main', defaults(mainDefault)], ['Worker', defaults(workerDefault)]]) {
			for (const k of Object.keys(flags61)) {
				assert.ok(flags61[k] !== def[k] || inverse[k] !== def[k], `${k}: a fixture differs from the ${label} default`);
			}
			for (const k of ['isHoldDown', 'isIgnited', 'isPayloadSeparated', 'isStage2Separated', 'fairingSeparated']) {
				assert.notEqual(inverse[k], def[k], `${k}: the inverted fixture differs from the ${label} default (G3-1-02)`);
			}
		}
		// Not implied by the restore derivations: 3 stages, stage index 1, no payload propulsion configured
		assert.equal(base.currentStageIndex < 2 && three.length > 2 && !payloadCfg().propulsion, true);
		for (const f of [flags61, inverse]) {
			const r = new PhysicsEngine().addObject(build(f));
			const { fairingSeparated, ...rest } = f;
			for (const [k, v] of Object.entries(rest)) {
				assert.strictEqual(r[k], v, `Worker ${k} = ${v}`);
			}
			assert.strictEqual(r.fairing.isSeparated, fairingSeparated, 'Worker fairing.isSeparated');
			assert.strictEqual(r.flightComputer.disableOrbitalCutoff, f.disableOrbitalCutoff, 'FC disableOrbitalCutoff');
		}
	});

	it('Rev 6.11: a restored rocket keeps the parameters of the original vehicle (paramName) after being renamed to the payload', () => {
		const engine = new PhysicsEngine();
		// Parameters known only to the Worker definitions (initDefinitions), not to the preset fallback of CalcRocket
		engine.setCelestialParams({ UnitVehicle: { MAX_Q_AXIAL: 42000, MAX_Q_LATERAL: 4200, DRAG_COEF: 0.25, AERO_AREA_FRONT: 9, AERO_AREA_SIDE: 99 } });
		const sat = { name: 'Sat', restoredRuntimeState: true, isPayloadSeparated: true, currentStageIndex: 2, stageState: 'ORBITAL_COAST', mass: 0, fuelMass: 0, oxidMass: 0, burnTime: 0 };
		const r = engine.addObject(calcRocketPayload(64, { ...sat, param: undefined, runtimeState: { ...SAMPLE_ROCKET_RT(), paramName: 'UnitVehicle' } }));
		assert.equal(r.name, 'Sat');
		assert.equal(r.objParam.MAX_Q_AXIAL, 42000, 'objParam resolved from paramName');
		assert.equal(r.flightComputer.config.maxQAxialLimit, 42000);
		assert.equal(r.flightComputer.config.maxQLateralLimit, 4200);
		assert.equal(r.getRuntimeState().paramName, 'UnitVehicle', 'kept for the next save');
		assert.equal(r.dryMass, 0, 'restored passive payload keeps its dry mass of exactly 0');
		// Invalid / absent paramName, or no restore contract: resolved from the current name (behaviour before Rev 6.11)
		for (const [label, extra] of [['empty', { runtimeState: { paramName: '' } }], ['number', { runtimeState: { paramName: 5 } }], ['absent', { runtimeState: {} }],
			['not restored', { restoredRuntimeState: false, runtimeState: { paramName: 'UnitVehicle' } }]]) {
			const q = engine.addObject(calcRocketPayload(65, { ...sat, param: undefined, ...extra }));
			assert.equal(q.objParam, null, `${label}: no parameters named 'Sat'`);
			assert.equal(q.flightComputer.config.maxQAxialLimit, Infinity);
			assert.equal(q.getRuntimeState().paramName, 'Sat');
		}
		const fresh = engine.addObject(calcRocketPayload(66, { param: undefined, name: 'UnitVehicle', mass: 0 }));
		assert.equal(fresh.objParam.MAX_Q_AXIAL, 42000, 'normal add: by name');
		assert.equal(fresh.dryMass, stagesCfg()[0].dryMassT, 'normal add: dry mass from _activateStage(0)');
		const noRestoreMass = engine.addObject(calcRocketPayload(67, { stages: undefined, mass: 0 }));
		assert.equal(noRestoreMass.dryMass, SIMULATION.DEFAULT_OBJECT_MASS, 'normal add keeps the mass || DEFAULT_OBJECT_MASS fallback');
	});

	it('Rev 6.11: restored celestial body / debris get the exact Worker kinematics, mass and parent rocket', () => {
		const engine = new PhysicsEngine();
		const earthRt = { kinematics: { x: 1.5e11 + 0.25, y: -3.5e10, vx: 7.25e3, vy: 2.95e4, ax: 1e-3, ay: -5e-3, aero: { currentQ: 0, mach: 0 } }, mass: 5.97219e24 };
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 1.5e11, y: -3.5e10, mass: 5.972e24, radius: 6.371e6, param: {}, runtimeState: earthRt });
		assert.deepEqual([earth.x, earth.y, earth.vx, earth.vy, earth.ax, earth.ay], [1.5e11 + 0.25, -3.5e10, 7.25e3, 2.95e4, 1e-3, -5e-3]);
		assert.equal(earth.mass, 5.97219e24);
		assert.equal(earth.invMass, 1 / 5.97219e24);
		const debRt = { kinematics: { x: 1.5e11 + 7e6, y: -3.5e10, vx: 7.25e3, vy: 3.7e4, ax: -2.5, ay: 9.75, aero: { currentQ: 125, mach: 0.5 } }, parentRocketId: 0 };
		const deb = engine.addObject({ id: -5, name: 'Fairing', type: OBJECT_TYPES.DEBRIS, x: 1.5e11 + 7e6, y: -3.5e10, mass: 1.1, radius: 2, debrisSubType: 3, runtimeState: debRt });
		assert.equal(deb.parentRocketId, 0, 'parent rocket restored (id 0 included)');
		assert.deepEqual([deb.ax, deb.ay, deb._currentQ, deb.mach], [-2.5, 9.75, 125, 0.5]);
		assert.deepEqual(deb.getRuntimeState(), debRt, 'round trip');
		assert.deepEqual(earth.getRuntimeState(), earthRt, 'round trip (re-applied after the debris add)');
		// Invalid entries are ignored one by one; a body without runtime state behaves as before
		const e2 = new PhysicsEngine();
		for (const bad of [{ mass: -1 }, { mass: 0 }, { mass: NaN }, { mass: '5' }, { kinematics: { ...earthRt.kinematics, vx: NaN } }]) {
			const b = e2.addObject({ id: 2, name: 'B', type: OBJECT_TYPES.CELESTIAL, x: 3, y: 4, vx: 5, vy: 6, mass: 7e20, radius: 1e6, param: {}, runtimeState: bad });
			assert.deepEqual([b.x, b.y, b.vx, b.vy, b.mass], [3, 4, 5, 6, 7e20], JSON.stringify(bad));
		}
		for (const bad of [{ parentRocketId: '7' }, { parentRocketId: NaN }, { parentRocketId: null }, {}]) {
			const d = e2.addObject({ id: 3, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 0, y: 0, mass: 1, radius: 1, parentRocketId: 9, runtimeState: bad });
			assert.equal(d.parentRocketId, 9, `parentRocketId ${JSON.stringify(bad)} keeps the transmitted value`);
		}
		for (const bad of [null, 'state', 5, true]) {
			const d = e2.addObject({ id: 4, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 1, y: 2, mass: 1, radius: 1, runtimeState: bad });
			assert.deepEqual([d.x, d.y, d.parentRocketId], [1, 2, null]);
		}
	});

	it('Rev 6.11: saved a(t) and aero cache survive the force evaluations of the following adds and are consumed by the first step', () => {
		const engine = new PhysicsEngine();
		const param = { ATM_LIMIT_ALT: 100000, ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 };
		const earthRt = { kinematics: { x: 0, y: 0, vx: 0, vy: 0, ax: 1.25e-3, ay: -2.5e-3, aero: { currentQ: 0, mach: 0 } }, mass: 5.972e24 };
		engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.371e6, param, runtimeState: earthRt });
		// Rocket in the atmosphere (10 km): drag and the aero cache depend on the velocity, which the saved flight used one step earlier
		const k = { x: 6.381e6, y: 0, vx: 50, vy: 750, ax: 4.5, ay: 11.25, aero: { currentQ: 9000, mach: 2.5, qAxialKpa: 8.75, qLateralKpa: 0.25, aoaDeg: 3.5, progradeAngle: 1.25 } };
		// All action rows already executed: the step below jettisons nothing (no 'add' inside the step)
		const fc = { ...SAMPLE_FC_STATE(), highestStepIndex: 4, triggeredActionIndices: [1, 3, 4], pendingActions: [] };
		const r = engine.addObject(calcRocketPayload(21, { x: 6.381e6, vx: 50, vy: 750, restoredRuntimeState: true, stageState: 'STG_BURNING', runtimeState: { ...SAMPLE_ROCKET_RT(), flightComputer: fc, kinematics: k } }));
		const fresh = new PhysicsEngine();
		fresh.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.371e6, param });
		const evaluated = fresh.addObject(calcRocketPayload(21, { x: 6.381e6, vx: 50, vy: 750 }));
		assert.notEqual(evaluated.ax, k.ax, 'precondition: an evaluation from the saved v(t + dt) differs');
		const deb = engine.addObject({ id: -9, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 6.39e6, y: 0, vx: 0, vy: 700, mass: 1, radius: 1,
			runtimeState: { kinematics: { x: 6.39e6, y: 0, vx: 0, vy: 700, ax: -9.5, ay: 0.5, aero: { currentQ: 1, mach: 2 } }, parentRocketId: 21 } });
		// After both following adds (each re-evaluates all forces), every restored object still has its saved values
		const earth = engine.objects[0];
		assert.deepEqual([earth.ax, earth.ay], [1.25e-3, -2.5e-3]);
		assert.deepEqual([r.ax, r.ay, r._currentQ, r.mach, r._qAxialKpa, r._qLateralKpa, r._aoaDeg, r._progradeAngle], [4.5, 11.25, 9000, 2.5, 8.75, 0.25, 3.5, 1.25]);
		assert.deepEqual([deb.ax, deb.ay], [-9.5, 0.5]);
		assert.equal(r.inAtmosphere, true, 'position-only aero state is re-derived');
		assert.deepEqual(engine._restoredPending.map(o => o.id), [1, 21, -9]);
		// The first step consumes them: its half-step uses the saved a(t), then forces are evaluated normally
		const vy0 = r.vy;
		const count = engine.objects.length;
		engine._moveObjects(0.05);
		assert.equal(engine.objects.length, count, 'precondition: nothing was added during the step');
		assert.deepEqual(engine._restoredPending, [], 'consumed by the step itself');
		assert.equal(r._restoredForces, null);
		assert.notEqual(r.ax, 4.5, 'a(t + dt) evaluated by the step');
		const half = vy0 + 11.25 * 0.05 / 2;
		assert.ok(Math.abs((r.vy - half) - r.ay * 0.05 / 2) < 1e-9, 'velocity Verlet with the saved a(t) in the first half-step');
		// A later add (e.g. jettisoned debris) does not bring the saved values back
		engine.addObject({ id: -10, name: 'D2', type: OBJECT_TYPES.DEBRIS, x: 7e6, y: 0, mass: 1, radius: 1 });
		assert.notEqual(earth.ax, 1.25e-3);
	});

	it('Rev 6.11: an object without saved forces ends the re-application (forces are evaluated from then on)', () => {
		const engine = new PhysicsEngine();
		const earthRt = { kinematics: { x: 0, y: 0, vx: 0, vy: 0, ax: 1.25e-3, ay: -2.5e-3 }, mass: 5.972e24 };
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.371e6, param: {}, runtimeState: earthRt });
		assert.equal(earth.ax, 1.25e-3);
		const moon = engine.addObject({ id: 2, name: 'Moon', type: OBJECT_TYPES.CELESTIAL, x: 3.844e8, y: 0, mass: 7.35e22, radius: 1.737e6, param: {} });
		assert.deepEqual(engine._restoredPending, []);
		assert.equal(earth._restoredForces, null);
		assert.ok(earth.ax > 0 && earth.ay === 0, 'evaluated pull of the new body');
		assert.ok(moon.ax < 0);
	});
});

// ==================================================================
// 6. §4.7 Main side: CalcWorkerManager / Universe
// ==================================================================
describe('Unit 10-6: CalcWorkerManager and Universe snapshot capture (§4.7)', () => {
	let uni = null;
	let CWM = null;

	before(() => {
		EventBus.clearAll();
		uni = new Universe(createMockElement('canvas'));
		CWM = uni.CalcWorkerManager.constructor;
	});

	after(() => {
		uni.destroy();
		EventBus.clearAll();
	});

	afterEach(() => {
		mock.timers.reset();
	});

	const newManager = (cb = () => {}) => {
		const orig = globalThis.Worker;
		globalThis.Worker = RecordingWorker;
		try {
			return new CWM(cb);
		} finally {
			globalThis.Worker = orig;
		}
	};
	const reply = (m, requestId, rockets) => m.worker.onmessage({ data: { cmd: 'runtimeSnapshot', requestId, rockets } });

	it('design constants', () => {
		assert.equal(SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS, 2000);
		assert.equal(SIMULATION.RUNTIME_RESTORE_MAX_TIME_S, 1e10);
	});

	it("posts {cmd:'snapshotRuntime', requestId} with distinct ids and resolves on the matching reply", { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		const m = newManager();
		assert.ok(m.worker instanceof RecordingWorker);
		assert.match(m.worker.url, /gravsim_calc\.js/);
		const p1 = m.requestRuntimeSnapshot();
		const p2 = m.requestRuntimeSnapshot();
		assert.equal(m.worker.posted.length, 2);
		const [q1, q2] = m.worker.posted;
		assert.deepEqual(Object.keys(q1).sort(), ['cmd', 'requestId']);
		assert.equal(q1.cmd, 'snapshotRuntime');
		assert.equal(q2.cmd, 'snapshotRuntime');
		assert.notEqual(q1.requestId, q2.requestId);
		assert.equal(m._runtimeRequests.size, 2);
		const rockets2 = [{ id: 2, runtimeState: { presState: 'NOMINAL' } }];
		const rockets1 = [{ id: 1, runtimeState: { presState: 'DEPLETED' } }];
		reply(m, q2.requestId, rockets2); // out of order
		reply(m, q1.requestId, rockets1);
		assert.deepEqual(await p1, rockets1);
		assert.deepEqual(await p2, rockets2);
		assert.equal(m._runtimeRequests.size, 0);
	});

	it('ignores replies with unknown or already answered requestIds', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		const m = newManager();
		const p = m.requestRuntimeSnapshot();
		const { requestId } = m.worker.posted[0];
		reply(m, requestId + 1000, [{ id: 9, runtimeState: {} }]);
		reply(m, undefined, []);
		assert.equal(m._runtimeRequests.size, 1, 'still pending');
		reply(m, requestId, [{ id: 1, runtimeState: { a: 1 } }]);
		reply(m, requestId, [{ id: 1, runtimeState: { a: 2 } }]);
		assert.deepEqual(await p, [{ id: 1, runtimeState: { a: 1 } }]);
		assert.equal(m._runtimeRequests.size, 0);
	});

	it('resolves [] when the reply carries a non-array rockets field', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		for (const rockets of [undefined, null, {}, 'x', 5]) {
			const m = newManager();
			const p = m.requestRuntimeSnapshot();
			reply(m, m.worker.posted[0].requestId, rockets);
			assert.deepEqual(await p, [], `rockets=${JSON.stringify(rockets)}`);
		}
	});

	it('clears the timeout when the reply arrives', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const m = newManager();
		const cleared = [];
		const mockedClear = globalThis.clearTimeout;
		globalThis.clearTimeout = (t) => { cleared.push(t); return mockedClear(t); };
		try {
			const p = m.requestRuntimeSnapshot();
			const timer = m._runtimeRequests.get(m.worker.posted[0].requestId).timer;
			reply(m, m.worker.posted[0].requestId, []);
			assert.deepEqual(await p, []);
			assert.deepEqual(cleared, [timer]);
		} finally {
			globalThis.clearTimeout = mockedClear;
		}
	});

	it('resolves null exactly at RUNTIME_SNAPSHOT_TIMEOUT_MS and ignores a late reply', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const m = newManager();
		let result = 'pending';
		const p = m.requestRuntimeSnapshot().then((r) => { result = r; });
		mock.timers.tick(SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS - 1);
		await flush();
		assert.equal(result, 'pending', 'one millisecond before the timeout');
		assert.equal(m._runtimeRequests.size, 1);
		mock.timers.tick(1);
		await p;
		assert.strictEqual(result, null);
		assert.equal(m._runtimeRequests.size, 0);
		assert.doesNotThrow(() => reply(m, m.worker.posted[0].requestId, [{ id: 1, runtimeState: {} }]));
		assert.strictEqual(result, null);
	});

	it('honours an explicit timeout including 0 ms', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		for (const ms of [0, 50]) {
			const m = newManager();
			let result = 'pending';
			const p = m.requestRuntimeSnapshot(ms).then((r) => { result = r; });
			if (ms > 0) {
				mock.timers.tick(ms - 1);
				await flush();
				assert.equal(result, 'pending', `${ms - 1} ms`);
			}
			mock.timers.tick(ms > 0 ? 1 : 0);
			await p;
			assert.strictEqual(result, null, `${ms} ms`);
		}
	});

	it('destroy() resolves every pending request with null, clears them and terminates the worker', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const m = newManager();
		const p1 = m.requestRuntimeSnapshot();
		const p2 = m.requestRuntimeSnapshot();
		m.destroy();
		assert.strictEqual(await p1, null);
		assert.strictEqual(await p2, null);
		assert.equal(m._runtimeRequests.size, 0);
		assert.equal(m.worker.terminated, 1);
		assert.doesNotThrow(() => mock.timers.tick(SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS));
		assert.doesNotThrow(() => reply(m, m.worker.posted[0].requestId, []));
		const idle = newManager();
		idle.destroy();
		assert.equal(idle.worker.terminated, 1, 'destroy with nothing pending');
	});

	it("still forwards 'update' messages to the callback", () => {
		const got = [];
		const m = newManager((d) => got.push(d.subSteps));
		m.worker.onmessage({ data: { cmd: 'update', subSteps: 12 } });
		assert.deepEqual(got, [12]);
	});

	it('Universe.captureRuntimeSnapshot maps live entries by id and returns null when unavailable', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		const capture = (rockets) => Universe.prototype.captureRuntimeSnapshot.call({ CalcWorkerManager: { requestRuntimeSnapshot: async () => rockets } });
		assert.strictEqual(await capture(null), null);
		const emptyMap = await capture([]);
		assert.ok(emptyMap instanceof Map);
		assert.equal(emptyMap.size, 0);
		const map = await capture([
			{ id: 0, runtimeState: { k: 0 } },
			{ id: 7, runtimeState: { k: 7 } },
			null,
			{ runtimeState: { k: 'no-id' } },
			{ id: 8, runtimeState: null },
			{ id: 9 }
		]);
		assert.deepEqual([...map.entries()], [[0, { k: 0 }], [7, { k: 7 }]]);
	});

	it('Universe.captureRuntimeSnapshot over a real CalcWorkerManager', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const m = newManager();
		const p = Universe.prototype.captureRuntimeSnapshot.call({ CalcWorkerManager: m });
		reply(m, m.worker.posted[0].requestId, [{ id: 3, runtimeState: SAMPLE_ROCKET_RT() }]);
		const map = await p;
		assert.deepEqual([...map.keys()], [3]);
		assert.deepEqual(map.get(3), SAMPLE_ROCKET_RT());
		const timeout = Universe.prototype.captureRuntimeSnapshot.call({ CalcWorkerManager: m });
		mock.timers.tick(SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS);
		assert.strictEqual(await timeout, null);
	});

	it('Universe.getState forwards the runtime snapshot to ObjectManager.getState (default null)', () => {
		const seen = [];
		const fake = {
			centerObject: { id: 5 },
			camera: { targetOffset: { x: 1, y: 2 } },
			ObjectManager: { getState: (s) => { seen.push(s); return ['om']; } },
			RocketLauncher: { getState: () => 'rl' },
			ControlPanel: { getState: () => 'cp' }
		};
		const snap = new Map([[1, {}]]);
		assert.deepEqual(Universe.prototype.getState.call(fake, snap), {
			centerObjectId: 5, cameraOffset: { x: 1, y: 2 }, objectManager: ['om'], rocketLauncher: 'rl', controlPanel: 'cp'
		});
		Universe.prototype.getState.call(fake);
		assert.strictEqual(seen[0], snap);
		assert.strictEqual(seen[1], null);
	});
});

// ==================================================================
// 7. §4.7 SaveManager.save()
// ==================================================================
const installDownloadSpy = () => {
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	const origCreateEl = document.createElement;
	const spy = { created: [], revoked: [], anchors: [] };
	let n = 0;
	URL.createObjectURL = (blob) => { const url = `blob:test/${++n}`; spy.created.push({ blob, url }); return url; };
	URL.revokeObjectURL = (url) => { spy.revoked.push(url); };
	document.createElement = (tag) => {
		const el = createMockElement(tag);
		if (tag === 'a') {
			el.clicks = 0;
			el.click = () => { el.clicks++; };
			spy.anchors.push(el);
		}
		return el;
	};
	spy.restore = () => {
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
		document.createElement = origCreateEl;
	};
	return spy;
};

const fakeUniverse = (extra = {}) => ({
	stateCalls: [],
	loaded: [],
	getState(snapshot) { this.stateCalls.push(snapshot); return { objectManager: [{ id: 1 }], marker: 'state' }; },
	loadState(st) { this.loaded.push(st); },
	...extra
});

describe('Unit 10-7: SaveManager.save() asynchronous and synchronous paths (§4.7)', () => {
	let spy = null;
	afterEach(() => {
		if (spy) { spy.restore(); spy = null; }
	});

	const assertWritten = async (expectedSnapshotArg, universe) => {
		assert.equal(spy.created.length, 1, 'exactly one file');
		assert.deepEqual(universe.stateCalls, [expectedSnapshotArg]);
		assert.strictEqual(universe.stateCalls[0], expectedSnapshotArg);
		const json = JSON.parse(await spy.created[0].blob.text());
		assert.deepEqual(json, { version: 2, universe: { objectManager: [{ id: 1 }], marker: 'state' } });
		assert.equal(spy.created[0].blob.type, 'application/json');
		assert.equal(spy.anchors.length, 1);
		assert.equal(spy.anchors[0].href, spy.created[0].url);
		assert.match(spy.anchors[0].download, /^GravSim_Data_\d{8}_\d{4}\.json$/);
		assert.equal(spy.anchors[0].clicks, 1);
		assert.deepEqual(spy.revoked, [spy.created[0].url]);
	};

	it('writes synchronously with a null snapshot when captureRuntimeSnapshot is unavailable', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		for (const capture of [undefined, null, {}, 'fn']) {
			spy = installDownloadSpy();
			const universe = fakeUniverse(capture === undefined ? {} : { captureRuntimeSnapshot: capture });
			const p = new SaveManager(universe).save();
			assert.ok(p instanceof Promise, 'save() returns a Promise');
			await assertWritten(null, universe); // written before awaiting
			assert.strictEqual(await p, undefined);
			spy.restore();
			spy = null;
		}
	});

	it('waits for the snapshot and passes it to getState', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		spy = installDownloadSpy();
		let resolveCapture;
		const universe = fakeUniverse({ captureRuntimeSnapshot: () => new Promise((r) => { resolveCapture = r; }) });
		const p = new SaveManager(universe).save();
		await flush();
		assert.equal(spy.created.length, 0, 'nothing written before the snapshot arrives');
		assert.equal(universe.stateCalls.length, 0);
		const snapshot = new Map([[3, SAMPLE_ROCKET_RT()]]);
		resolveCapture(snapshot);
		await p;
		await assertWritten(snapshot, universe);
	});

	it('writes without runtime state when the snapshot resolves null (timeout)', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		spy = installDownloadSpy();
		const universe = fakeUniverse({ captureRuntimeSnapshot: async () => null });
		await new SaveManager(universe).save();
		await assertWritten(null, universe);
	});

	it('writes without runtime state when the capture rejects, and the save Promise still resolves', { timeout: ASYNC_TEST_TIMEOUT_MS }, async (t) => {
		spy = installDownloadSpy();
		const errors = t.mock.method(console, 'error', () => {});
		const universe = fakeUniverse({ captureRuntimeSnapshot: () => Promise.reject(new Error('worker gone')) });
		assert.strictEqual(await new SaveManager(universe).save(), undefined);
		await assertWritten(null, universe);
		assert.equal(errors.mock.callCount(), 1);
	});

	it('treats a capture function returning a non-thenable as unavailable (synchronous write)', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		spy = installDownloadSpy();
		const universe = fakeUniverse({ captureRuntimeSnapshot: () => undefined });
		const p = new SaveManager(universe).save();
		await assertWritten(null, universe);
		await p;
	});
});

// ==================================================================
// 8. §3.5-3 SaveManager.load() guards
// ==================================================================
describe('Unit 10-8: SaveManager.load() guards (§3.5-3)', () => {
	let origReader;
	let origAlert;
	let hadAlert;
	let alerts;
	let readers;

	before(() => {
		origReader = globalThis.FileReader;
		hadAlert = Object.prototype.hasOwnProperty.call(globalThis, 'alert');
		origAlert = globalThis.alert;
		globalThis.FileReader = class TestFileReader {
			constructor() { readers++; this.onload = null; }
			readAsText(file) { this.onload(file.event !== undefined ? file.event : { target: { result: file.content } }); }
		};
	});
	after(() => {
		globalThis.FileReader = origReader;
		if (hadAlert) { globalThis.alert = origAlert; } else { delete globalThis.alert; }
	});

	const setup = () => {
		alerts = [];
		readers = 0;
		globalThis.alert = (msg) => { alerts.push(msg); };
		const universe = fakeUniverse();
		return { universe, sm: new SaveManager(universe) };
	};
	const load = (sm, file) => {
		const target = { files: file ? [file] : [], value: 'C:\\fakepath\\save.json' };
		sm.load({ target });
		return target;
	};
	const assertRejected = (universe, target, label) => {
		assert.deepEqual(alerts, ['Invalid save file.'], `${label}: one alert`);
		assert.equal(universe.loaded.length, 0, `${label}: loadState not called`);
		assert.equal(target.value, '', `${label}: file input reset`);
	};

	it('does nothing without a selected file', () => {
		const { universe, sm } = setup();
		const target = load(sm, null);
		assert.equal(readers, 0);
		assert.equal(universe.loaded.length, 0);
		assert.deepEqual(alerts, []);
		assert.equal(target.value, 'C:\\fakepath\\save.json');
	});

	it('rejects a non-string reader result', () => {
		for (const content of [undefined, null, 42, new ArrayBuffer(8), {}, true]) {
			const { universe, sm } = setup();
			assertRejected(universe, load(sm, { content }), `content=${Object.prototype.toString.call(content)}`);
		}
		const { universe, sm } = setup();
		assertRejected(universe, load(sm, { event: undefined }), 'missing event');
		const s2 = setup();
		assertRejected(s2.universe, load(s2.sm, { event: { target: null } }), 'missing event target');
	});

	it('rejects invalid JSON', (t) => {
		const errors = t.mock.method(console, 'error', () => {});
		for (const content of ['', '{', 'not json', '{"universe":', '{universe:{}}']) {
			const { universe, sm } = setup();
			assertRejected(universe, load(sm, { content }), JSON.stringify(content));
		}
		assert.equal(errors.mock.callCount(), 5);
	});

	it('rejects JSON that is not a non-array object', () => {
		for (const content of ['null', '42', '"str"', 'true', '[]', '[{"universe":{}}]']) {
			const { universe, sm } = setup();
			assertRejected(universe, load(sm, { content }), content);
		}
	});

	it('rejects a missing, non-object or array universe', () => {
		for (const content of ['{}', '{"version":2}', '{"universe":null}', '{"universe":0}', '{"universe":""}', '{"universe":"x"}', '{"universe":true}', '{"universe":[]}', '{"universe":[{"objectManager":[]}]}']) {
			const { universe, sm } = setup();
			assertRejected(universe, load(sm, { content }), content);
		}
	});

	it('loads a valid save (including the empty-object boundary) and resets the file input', () => {
		for (const [content, expected] of [
			['{"universe":{}}', {}],
			['{"version":2,"universe":{"objectManager":[],"centerObjectId":0}}', { objectManager: [], centerObjectId: 0 }]
		]) {
			const { universe, sm } = setup();
			const target = load(sm, { content });
			assert.deepEqual(alerts, []);
			assert.deepEqual(universe.loaded, [expected]);
			assert.equal(target.value, '');
		}
	});

	it('alerts when loadState throws and works without a global alert', (t) => {
		const errors = t.mock.method(console, 'error', () => {});
		const { universe, sm } = setup();
		universe.loadState = () => { throw new Error('boom'); };
		const target = load(sm, { content: '{"universe":{}}' });
		assert.deepEqual(alerts, ['Invalid save file.']);
		assert.equal(target.value, '');
		assert.equal(errors.mock.callCount(), 1);
		delete globalThis.alert;
		const s2 = setup();
		delete globalThis.alert;
		assert.doesNotThrow(() => load(s2.sm, { content: 'not json' }));
		assert.doesNotThrow(() => load(s2.sm, { content: 42 }));
		assert.equal(s2.universe.loaded.length, 0);
	});
});

// ==================================================================
// 9. §3.5-1 ObjectManager field table, §4.7 runtimeState / debrisSubType, old format
// ==================================================================
// §3.5-1 (Rev 6.10): the table applies to getState() / loadState(). ROCKET `mass` is not saved; it is recomputed
// on load from the stage and payload masses.
const TABLE = {
	CELESTIAL: ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'mass', 'radius', 'color', 'generation', 'rotationAngle', 'param'],
	DEBRIS: ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'mass', 'radius', 'color', 'generation', 'debrisSubType', 'colorTheme', 'baseRadiusM'],
	ROCKET: ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'dryMass', 'fuelMass', 'oxidMass', 'burnTime', 'thrustForce', 'thrustAngle',
		'radius', 'color', 'generation', 'stages', 'payload', 'fairing', 'boosters', 'flightProfile', 'colorTheme', 'hostId', 'hostAngleRad',
		'hostAltM', 'bottomOffsetM', 'baseRadiusM', 'autoControl', 'disableStaging', 'disableOrbitalCutoff', 'targetApogeeKm',
		'targetPerigeeKm', 'targetVInfKmS', 'isHoldDown', 'isIgnited', 'currentStageIndex', 'totalStages', 'isPayloadSeparated',
		'isStage2Separated', 'isBoosterBurnout', 'isBoosterSeparated', 'hasPayloadPropulsion', 'stageState', 'stgTimer', 'mach',
		'rcsCw', 'rcsCcw', 'rcsUllage', 'restoredRuntimeState']
};
const ROCKET_STATE_KEYS = TABLE.ROCKET;
// §4.7: transient values recomputed every step are not transferred to the Worker.
const ROCKET_TRANSIENT = ['mach', 'rcsCw', 'rcsCcw', 'rcsUllage'];
// §3.5-1 (Rev 6.10): _buildRocketPayload() sends only what the Worker uses: no `color`, no `totalStages`,
// the dry mass travels as `mass` (no `dryMass` key), and no `mach` / `rcs*` (§4.7).
const ROCKET_NOT_SENT = ['color', 'totalStages', 'dryMass', ...ROCKET_TRANSIENT];
const ROCKET_PAYLOAD_KEYS = TABLE.ROCKET.filter(k => !ROCKET_NOT_SENT.includes(k));

const recorder = () => ({ posted: [], postMessage(msg) { this.posted.push(structuredClone(msg)); } });

const buildWorld = () => {
	const earth = new CelestialBody(1, 'Earth', 100.5, -50.25, 0.125, 0.0625, 5.972e21, '#3366cc', 5, 6371000, 0, '#ffffff', 1);
	earth.rotationAngle = 1.2345;
	earth.param = { ROTATION_PERIOD: 86164, ATM_LIMIT_ALT: 100000, ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 };
	const deb = new Debris(8, 'Fairing', 101.5, -49.5, 0.25, 0.5, 2.2, '#c8d0d8', 5, 2.6, 1, '#00ffcc', 0, 3, 'blue');
	deb.baseRadiusM = 3.1;
	const r = new Rocket(7, 'Rocket', 100.75, -50.5, 0.5, -0.25, 4.5, 20, 50, '#abcdef', 3, 31.5, 0, '#123456', 2, 'blue');
	Object.assign(r, {
		ofRatio: 5.5, thrustForce: 980000, burnTime: 280, thrustAngle: -1.25, flightProfile: PROFILE(), massLossRate: 0.25, maxGLimit: 4,
		stages: stagesCfg(), payload: payloadCfg(PROP()), fairing: { ...fairingCfg(), isSeparated: true }, boosters: boostersCfg(),
		hostId: 1, hostAngleRad: 0.75, hostAltM: 12.5, bottomOffsetM: 31.5, baseRadiusM: 63, autoControl: false, disableStaging: true,
		disableOrbitalCutoff: true, targetApogeeKm: 400, targetPerigeeKm: 250, targetVInfKmS: 3.3, isHoldDown: false, isIgnited: true,
		currentStageIndex: 1, totalStages: 2, isPayloadSeparated: false, isStage2Separated: false, isBoosterBurnout: true,
		isBoosterSeparated: true, hasPayloadPropulsion: true, stageState: 'INTERSTAGE_COAST', stgTimer: 1.25, mach: 0.95,
		rcsCw: true, rcsCcw: false, rcsUllage: true
	});
	return { earth, deb, r };
};

// G3-1-02: buildWorld() has the main-thread default for isHoldDown, isIgnited, isPayloadSeparated, isStage2Separated and rcsCcw,
// so a save / load path that drops one of them still compares equal. This second world inverts every §3.5-1 boolean
// (and moves the remaining default-valued fields off their defaults).
const ROCKET_BOOLEANS = ['autoControl', 'disableStaging', 'disableOrbitalCutoff', 'isHoldDown', 'isIgnited', 'isPayloadSeparated', 'isStage2Separated',
	'isBoosterBurnout', 'isBoosterSeparated', 'hasPayloadPropulsion', 'rcsCw', 'rcsCcw', 'rcsUllage'];
const buildInvertedWorld = () => {
	const w = buildWorld();
	const inv = Object.fromEntries(ROCKET_BOOLEANS.map(k => [k, !w.r[k]]));
	const three = [...stagesCfg(), { ...stagesCfg()[1], stageNumber: 3, name: 'S3' }];
	Object.assign(w.r, inv, {
		generation: 2, stages: three, totalStages: 3, currentStageIndex: 1, payload: payloadCfg(), fairing: { ...fairingCfg(), isSeparated: false },
		stageState: 'PRE_LAUNCH', stgTimer: 0.5, hostAngleRad: -0.5, colorTheme: 'orange'
	});
	return w;
};

describe('Unit 10-9: ObjectManager state persistence (§3.5-1, §4.7)', () => {
	afterEach(() => EventBus.clearAll());

	it('getState emits every §3.5-1 field for CELESTIAL / DEBRIS / ROCKET with deep copies', () => {
		const { earth, deb, r } = buildWorld();
		const om = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om.addObject(o));
		const snap = new Map([[7, SAMPLE_ROCKET_RT()]]);
		const [cs, ds, rs] = om.getState(snap);
		for (const k of TABLE.CELESTIAL) {
			assert.ok(Object.prototype.hasOwnProperty.call(cs, k), `CELESTIAL.${k}`);
			assert.deepEqual(cs[k], earth[k], `CELESTIAL.${k} value`);
		}
		for (const k of TABLE.DEBRIS) {
			assert.ok(Object.prototype.hasOwnProperty.call(ds, k), `DEBRIS.${k}`);
			assert.deepEqual(ds[k], deb[k], `DEBRIS.${k} value`);
		}
		for (const k of ROCKET_STATE_KEYS) {
			assert.ok(Object.prototype.hasOwnProperty.call(rs, k), `ROCKET.${k}`);
			if (k !== 'restoredRuntimeState') { assert.deepEqual(rs[k], r[k], `ROCKET.${k} value`); }
		}
		assert.strictEqual(rs.restoredRuntimeState, true);
		assert.equal(Object.prototype.hasOwnProperty.call(rs, 'mass'), false, 'ROCKET mass is not saved (§3.5-1)');
		assert.deepEqual(rs.runtimeState, SAMPLE_ROCKET_RT());
		assert.notStrictEqual(rs.runtimeState, snap.get(7), 'runtimeState is a copy');
		for (const k of ['stages', 'payload', 'fairing', 'boosters', 'flightProfile']) {
			assert.notStrictEqual(rs[k], r[k], `ROCKET.${k} is a copy`);
		}
		assert.notStrictEqual(cs.param, earth.param, 'CELESTIAL.param is a copy');
		assert.equal(cs.rotationAngle, 1.2345);
		assert.equal(ds.debrisSubType, 3);
	});

	it('G3-1-02: the inverted world really differs from the defaults: every boolean has its non-default value in one of the two worlds', () => {
		const a = buildWorld().r;
		const b = buildInvertedWorld().r;
		const d = new Rocket(1, 'Rocket', 0, 0, 0, 0, 1, 1, 1, '#fff', 1, 1, 0, null, 0);
		for (const k of ROCKET_BOOLEANS) {
			assert.equal(typeof a[k], 'boolean', `${k} is a boolean in the fixture`);
			assert.notEqual(a[k], b[k], `${k} inverted`);
			assert.ok(a[k] !== Boolean(d[k]) || b[k] !== Boolean(d[k]), `${k}: one world differs from the Rocket default`);
		}
		for (const k of ['isHoldDown', 'isIgnited', 'isPayloadSeparated', 'isStage2Separated', 'rcsCcw']) {
			assert.notEqual(b[k], Boolean(d[k]), `${k}: the inverted world differs from the Rocket default (G3-1-02)`);
		}
		assert.notEqual(a.fairing.isSeparated, b.fairing.isSeparated);
		// Other optional table fields (read with "if (o.k !== undefined)"): one world has a non-default value
		const optional = ROCKET_STATE_KEYS.filter(k => !['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'dryMass', 'fuelMass', 'oxidMass', 'color', 'radius', 'restoredRuntimeState'].includes(k));
		for (const k of optional) {
			const same = (v) => JSON.stringify(v ?? null) === JSON.stringify(d[k] ?? null);
			assert.ok(!same(a[k]) || !same(b[k]), `${k}: a fixture value differs from the Rocket default ${JSON.stringify(d[k])}`);
		}
	});

	it('G3-1-02: the inverted world round-trips getState -> loadState -> getState and reaches the Worker (_buildRocketPayload -> PhysicsEngine.addObject)', () => {
		const { earth, deb, r } = buildInvertedWorld();
		const om1 = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om1.addObject(o));
		const snap = new Map([[7, SAMPLE_ROCKET_RT()]]);
		const saved = JSON.parse(JSON.stringify(om1.getState(snap)));
		const rs = saved[2];
		for (const k of ROCKET_STATE_KEYS) {
			if (k !== 'restoredRuntimeState') { assert.deepEqual(rs[k], r[k], `saved ROCKET.${k}`); }
		}
		const wm = recorder();
		const om2 = new ObjectManager(null, wm);
		om2.loadState(saved);
		const r2 = om2.objects[2];
		for (const k of ROCKET_STATE_KEYS) {
			if (k !== 'restoredRuntimeState') { assert.deepEqual(r2[k], r[k], `loaded ROCKET.${k}`); }
		}
		assert.deepEqual(om2.getState(snap), om1.getState(snap), 'getState -> loadState -> getState');
		const ra = wm.posted.find(m => m.cmd === 'add' && m.id === 7);
		for (const k of ROCKET_BOOLEANS.filter(k => !ROCKET_TRANSIENT.includes(k))) {
			assert.strictEqual(ra[k], r[k], `payload.${k}`);
		}
		assert.strictEqual(ra.fairing.isSeparated, false);
		const engine = new PhysicsEngine();
		wm.posted.filter(m => m.cmd === 'add').forEach(m => engine.addObject(m));
		const cr = engine.objects.find(o => o.id === 7);
		// Not implied by the restore derivations: stage index 1 of 3, payload without propulsion
		for (const k of ['autoControl', 'disableStaging', 'disableOrbitalCutoff', 'isHoldDown', 'isIgnited', 'isPayloadSeparated', 'isStage2Separated',
			'isBoosterBurnout', 'isBoosterSeparated', 'hasPayloadPropulsion']) {
			assert.strictEqual(cr[k], r[k], `Worker ${k} = ${r[k]}`);
		}
		assert.strictEqual(cr.fairing.isSeparated, false, 'Worker fairing attached');
		assert.equal(cr.stageState, 'PRE_LAUNCH');
		assert.equal(cr.hostAngleRad, SAMPLE_ROCKET_RT().hostAngleRad, 'runtime pad angle overrides the main-thread rollout angle');
	});

	it('Rev 6.11: getState saves the runtime state of celestial bodies and debris only when the snapshot has one (deep copy)', () => {
		const { earth, deb, r } = buildWorld();
		const om = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om.addObject(o));
		const earthRt = { kinematics: { x: 1.5, y: 2.5, vx: 3.5, vy: 4.5, ax: 5.5, ay: 6.5, aero: { currentQ: 0, mach: 0 } }, mass: 5.972e24 };
		const debRt = { kinematics: { x: 1.25, y: 2.25, vx: 3.25, vy: 4.25, ax: 5.25, ay: 6.25, aero: { currentQ: 7, mach: 0.5 } }, parentRocketId: 7 };
		const snap = new Map([[1, earthRt], [8, debRt], [7, SAMPLE_ROCKET_RT()]]);
		const [cs, ds] = om.getState(snap);
		assert.deepEqual(cs.runtimeState, earthRt);
		assert.deepEqual(ds.runtimeState, debRt);
		assert.notStrictEqual(cs.runtimeState, earthRt, 'copy');
		assert.notStrictEqual(ds.runtimeState.kinematics, debRt.kinematics, 'deep copy');
		// No entry / no snapshot / non-object entry: the entry keeps the pre-Rev 6.11 format (no runtimeState key)
		for (const s of [undefined, null, new Map(), new Map([[1, null], [8, 'x']]), {}]) {
			const [c2, d2] = om.getState(s);
			assert.equal(Object.prototype.hasOwnProperty.call(c2, 'runtimeState'), false, 'CELESTIAL without runtime state');
			assert.equal(Object.prototype.hasOwnProperty.call(d2, 'runtimeState'), false, 'DEBRIS without runtime state');
		}
	});

	it("Rev 6.11: loadState sends the runtime state of celestial bodies and debris with their 'add' message only", () => {
		const { earth, deb, r } = buildWorld();
		const om1 = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om1.addObject(o));
		const earthRt = { kinematics: { x: 1.5, y: 2.5, vx: 3.5, vy: 4.5, ax: 5.5, ay: 6.5, aero: { currentQ: 0, mach: 0 } }, mass: 5.972e24 };
		const debRt = { kinematics: { x: 1.25, y: 2.25, vx: 3.25, vy: 4.25, ax: 5.25, ay: 6.25, aero: { currentQ: 7, mach: 0.5 } }, parentRocketId: 7 };
		const saved = JSON.parse(JSON.stringify(om1.getState(new Map([[1, earthRt], [8, debRt], [7, SAMPLE_ROCKET_RT()]]))));
		const wm = recorder();
		const om2 = new ObjectManager(null, wm);
		om2.loadState(saved);
		const [ca, da] = wm.posted.filter(m => m.cmd === 'add');
		assert.deepEqual(ca.runtimeState, earthRt);
		assert.deepEqual(da.runtimeState, debRt);
		assert.equal(om2.objects[0].runtimeState, undefined, 'not kept on the main-thread body (no re-send)');
		assert.equal(om2.objects[1].runtimeState, undefined);
		// Re-adding the same main-thread object later sends no runtime state
		const wm3 = recorder();
		new ObjectManager(null, wm3).addObject(om2.objects[1]);
		assert.equal(Object.prototype.hasOwnProperty.call(wm3.posted[0], 'runtimeState'), false);
		// Non-object runtime state of a body / debris is not sent
		for (const bad of [null, 'state', 42, true]) {
			const st = JSON.parse(JSON.stringify(saved));
			st[0].runtimeState = bad;
			st[1].runtimeState = bad;
			const w = recorder();
			new ObjectManager(null, w).loadState(st);
			const adds = w.posted.filter(m => m.cmd === 'add');
			assert.equal(Object.prototype.hasOwnProperty.call(adds[0], 'runtimeState'), false, `CELESTIAL ${JSON.stringify(bad)}`);
			assert.equal(Object.prototype.hasOwnProperty.call(adds[1], 'runtimeState'), false, `DEBRIS ${JSON.stringify(bad)}`);
		}
		// The Worker applies them
		const engine = new PhysicsEngine();
		wm.posted.filter(m => m.cmd === 'add').forEach(m => engine.addObject(m));
		const ce = engine.objects.find(o => o.id === 1);
		const cd = engine.objects.find(o => o.id === 8);
		assert.deepEqual([ce.x, ce.vy, ce.ax, ce.mass], [1.5, 4.5, 5.5, 5.972e24]);
		assert.deepEqual([cd.x, cd.ay, cd.parentRocketId], [1.25, 6.25, 7]);
	});

	it('getState emits runtimeState null without a matching snapshot entry', () => {
		const { r } = buildWorld();
		const om = new ObjectManager(null, recorder());
		om.addObject(r);
		for (const snap of [undefined, null, new Map(), new Map([[8, {}]]), new Map([[7, null]]), {}]) {
			const [rs] = om.getState(snap);
			assert.strictEqual(rs.restoredRuntimeState, true);
			assert.strictEqual(rs.runtimeState, null, `snapshot ${Object.prototype.toString.call(snap)}`);
		}
	});

	it('getState defaults for an unconfigured rocket and debris/celestial without optional fields', () => {
		const om = new ObjectManager(null, recorder());
		const r = new Rocket(3, 'Rocket', 0, 0, 0, 0, 1, 2, 3, '#fff', 1, 1, 0, null, 0);
		r.colorTheme = undefined;
		r.stageState = undefined;
		r.isHoldDown = true;
		const d = new Debris(4, 'D', 0, 0, 0, 0, 1, '#888', 1, 1, 1, null, 0);
		d.debrisSubType = undefined;
		const c = new CelestialBody(5, 'X', 0, 0, 0, 0, 1, '#fff', 1, 1, 0, null, 0);
		c.rotationAngle = undefined;
		[r, d, c].forEach(o => om.addObject(o));
		const [rs, ds, cs] = om.getState();
		assert.equal(rs.colorTheme, 'orange');
		assert.equal(rs.stageState, 'PRE_LAUNCH', 'held down fallback');
		assert.equal(rs.totalStages, 1);
		assert.deepEqual(rs.stages, [], 'Rocket default stages');
		assert.strictEqual(rs.payload, null);
		assert.strictEqual(rs.boosters, null);
		assert.deepEqual(rs.flightProfile, []);
		assert.equal(ds.debrisSubType, 0);
		assert.equal(cs.rotationAngle, 0);
		assert.strictEqual(cs.param, null);
	});

	it('loadState restores every field, keeps restoredRuntimeState / runtimeState and is idempotent with getState', () => {
		const { earth, deb, r } = buildWorld();
		const om1 = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om1.addObject(o));
		const snap = new Map([[7, SAMPLE_ROCKET_RT()]]);
		const saved = JSON.parse(JSON.stringify(om1.getState(snap)));
		const wm = recorder();
		const om2 = new ObjectManager(null, wm);
		om2.loadState(saved);
		assert.equal(om2.objects.length, 3);
		const [c2, d2, r2] = om2.objects;
		assert.ok(c2 instanceof CelestialBody && d2 instanceof Debris && r2 instanceof Rocket);
		for (const k of ROCKET_STATE_KEYS) {
			if (k !== 'restoredRuntimeState') { assert.deepEqual(r2[k], r[k], `loaded ROCKET.${k}`); }
		}
		assert.strictEqual(r2.restoredRuntimeState, true);
		assert.deepEqual(r2.runtimeState, SAMPLE_ROCKET_RT());
		for (const k of TABLE.DEBRIS) { assert.deepEqual(d2[k], deb[k], `loaded DEBRIS.${k}`); }
		for (const k of TABLE.CELESTIAL) { assert.deepEqual(c2[k], earth[k], `loaded CELESTIAL.${k}`); }
		assert.deepEqual(om2.getState(snap), om1.getState(snap), 'getState -> loadState -> getState round trip');
	});

	it('loadState accepts restoredRuntimeState only when strictly true and runtimeState only when an object', () => {
		const { r } = buildWorld();
		const om = new ObjectManager(null, recorder());
		om.addObject(r);
		const [base] = JSON.parse(JSON.stringify(om.getState(new Map([[7, SAMPLE_ROCKET_RT()]]))));
		const cases = [
			[{ restoredRuntimeState: true }, true, SAMPLE_ROCKET_RT()],
			[{ restoredRuntimeState: 'true' }, false, SAMPLE_ROCKET_RT()],
			[{ restoredRuntimeState: 1 }, false, SAMPLE_ROCKET_RT()],
			[{ restoredRuntimeState: undefined }, false, SAMPLE_ROCKET_RT()],
			[{ runtimeState: null }, true, null],
			[{ runtimeState: 'state' }, true, null],
			[{ runtimeState: 42 }, true, null],
			[{ runtimeState: undefined }, true, null]
		];
		for (const [patch, flag, rt] of cases) {
			const wm = recorder();
			const om2 = new ObjectManager(null, wm);
			om2.loadState([{ ...base, ...patch }]);
			assert.strictEqual(om2.objects[0].restoredRuntimeState, flag, `flag for ${JSON.stringify(patch)}`);
			assert.deepEqual(om2.objects[0].runtimeState, rt, `runtimeState for ${JSON.stringify(patch)}`);
			const add = wm.posted.find(m => m.cmd === 'add');
			assert.strictEqual(add.restoredRuntimeState, flag);
			assert.deepEqual(add.runtimeState, flag ? rt : null, 'runtimeState travels only with restoredRuntimeState === true');
		}
	});

	it("addObject / _buildRocketPayload sends every Worker-relevant table field, the restore contract and no transient fields", () => {
		const { earth, deb, r } = buildWorld();
		const om1 = new ObjectManager(null, recorder());
		[earth, deb, r].forEach(o => om1.addObject(o));
		const saved = JSON.parse(JSON.stringify(om1.getState(new Map([[7, SAMPLE_ROCKET_RT()]]))));
		const wm = recorder();
		const om2 = new ObjectManager(null, wm);
		om2.loadState(saved);
		const adds = wm.posted.filter(m => m.cmd === 'add');
		assert.equal(adds.length, 3);
		const [ca, da, ra] = adds;
		const conv = { x: 'pix2m', y: 'pix2m', vx: 'pix2m', vy: 'pix2m' };
		for (const k of ROCKET_PAYLOAD_KEYS) {
			assert.ok(Object.prototype.hasOwnProperty.call(ra, k), `payload.${k}`);
			const expected = conv[k] ? UnitConvertUtils[conv[k]](r[k]) : (k === 'restoredRuntimeState' ? true : r[k]);
			assert.deepEqual(ra[k], expected, `payload.${k} value`);
		}
		assert.equal(ra.mass, r.dryMass, 'dry mass travels as `mass` (PhysicsEngine.addObject contract)');
		assert.deepEqual(ra.runtimeState, SAMPLE_ROCKET_RT());
		for (const k of ROCKET_NOT_SENT) {
			assert.equal(Object.prototype.hasOwnProperty.call(ra, k), false, `${k} not sent to the Worker (§3.5-1, §4.7)`);
		}
		assert.equal(ca.rotationAngle, 1.2345);
		assert.deepEqual(ca.param, earth.param);
		assert.equal(ca.mass, UnitConvertUtils.ton2kg(earth.mass));
		assert.equal(Object.prototype.hasOwnProperty.call(ca, 'debrisSubType'), false);
		assert.equal(da.debrisSubType, 3);

		// The Worker reconstructs the restored rocket from that payload
		const engine = new PhysicsEngine();
		adds.forEach(a => engine.addObject(a));
		const cr = engine.objects.find(o => o.id === 7);
		assert.equal(cr.currentStageIndex, 1);
		assert.equal(cr.stageState, 'INTERSTAGE_COAST');
		assert.equal(cr.stgTimer, 1.25);
		assert.equal(cr.hasPayloadPropulsion, true);
		assert.equal(cr.dryMass, 4.5);
		assert.equal(cr.fuelMass, 20);
		assert.equal(cr.burnTime, 280);
		assert.equal(cr.fairing.isSeparated, true);
		assert.deepEqual(cr.getRuntimeState().flightComputer, SAMPLE_FC_STATE());
		assert.equal(engine.objects.find(o => o.id === 8).debrisSubType, 3);
		assert.equal(engine.objects.find(o => o.id === 1).rotationAngle, 1.2345);
	});

	it('ROCKET mass is not saved and is recomputed from the stage and payload masses on load (§3.5-1)', () => {
		const p = payloadCfg();
		const cases = [
			// [label, rocket fields, expected mass = payload + fairing (if attached) + active stage + upper stages]
			['upper stage, fairing attached', { currentStageIndex: 1, dryMass: 4.5, fuelMass: 20, oxidMass: 50, fairing: fairingCfg() }, p.massT + 1.7 + 4.5 + 20 + 50],
			['first stage, fairing attached', { currentStageIndex: 0, dryMass: 25, fuelMass: 100, oxidMass: 200, fairing: fairingCfg() }, p.massT + 1.7 + 25 + 100 + 200 + (4.5 + 30 + 70)],
			['first stage, no fairing', { currentStageIndex: 0, dryMass: 25, fuelMass: 0, oxidMass: 0, fairing: { ...fairingCfg(), enabled: false } }, p.massT + 25 + (4.5 + 30 + 70)]
		];
		for (const [label, fields, expected] of cases) {
			const r = new Rocket(7, 'Rocket', 0, 0, 0, 0, fields.dryMass, fields.fuelMass, fields.oxidMass, '#fff', 3, 31.5, 0, null, 0);
			Object.assign(r, { stages: stagesCfg(), payload: payloadCfg(), totalStages: 2, stageState: 'STG_BURNING', burnTime: 50, ...fields });
			const om1 = new ObjectManager(null, recorder());
			om1.addObject(r);
			const [saved] = JSON.parse(JSON.stringify(om1.getState()));
			assert.equal(Object.prototype.hasOwnProperty.call(saved, 'mass'), false, `${label}: mass not saved`);
			const wm = recorder();
			const om2 = new ObjectManager(null, wm);
			om2.loadState([saved]);
			assertClose(om2.objects[0].mass, expected, 1e-12, `${label}: main-thread mass`);
			const add = wm.posted.find(m => m.cmd === 'add');
			assert.equal(add.mass, fields.dryMass, `${label}: dry mass travels as mass`);
			const cr = new PhysicsEngine().addObject(add);
			assertClose(cr.mass, expected, 1e-12, `${label}: Worker mass`);
		}
	});

	it('_buildRocketPayload of a freshly placed rocket never requests a restore', () => {
		const om = new ObjectManager(null, recorder());
		const r = new Rocket(3, 'Rocket', 0, 0, 0, 0, 1, 2, 3, '#fff', 1, 1, 0, null, 0);
		r.runtimeState = SAMPLE_ROCKET_RT();
		const p = om._buildRocketPayload(r);
		assert.strictEqual(p.restoredRuntimeState, false);
		assert.strictEqual(p.runtimeState, null);
		assert.equal(p.stageState, 'PRE_LAUNCH');
		r.restoredRuntimeState = 'true';
		assert.strictEqual(om._buildRocketPayload(r).restoredRuntimeState, false);
		r.restoredRuntimeState = true;
		r.runtimeState = null;
		const p2 = om._buildRocketPayload(r);
		assert.strictEqual(p2.restoredRuntimeState, true);
		assert.strictEqual(p2.runtimeState, null);
	});

	it('DEBRIS debrisSubType is sent to the Worker for every sub type (missing -> 0)', () => {
		for (const sub of [0, 1, 2, 3, 4, undefined]) {
			const wm = recorder();
			const om = new ObjectManager(null, wm);
			const d = new Debris(20, 'D', 1, 2, 0, 0, 1.5, '#888', 1, 2, 1, null, 0, sub ?? 0);
			if (sub === undefined) { d.debrisSubType = undefined; }
			om.addObject(d);
			const [add] = wm.posted;
			assert.equal(add.debrisSubType, sub ?? 0, `subType ${sub}`);
			const engine = new PhysicsEngine();
			assert.equal(engine.addObject(add).debrisSubType, sub ?? 0);
		}
	});

	it('loads an old-format (main) save as a normal, non-restored vehicle', () => {
		const old = [
			{ id: 0, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, color: '#ff0', size: 10, radius: 6.96e8, generation: 0, borderColor: null, borderWidth: 0, mass: 1.989e27 },
			{
				id: 5, type: OBJECT_TYPES.ROCKET, name: 'Rocket', x: 180, y: -0.5, vx: 0, vy: 0.01, color: '#fff', size: 3, radius: 31.5, generation: 0, borderColor: null, borderWidth: 0,
				dryMass: 25, fuelMass: 100, oxidMass: 230, ofRatio: 2.3, thrustForce: 7.25e6, burnTime: 150, thrustAngle: -1.2, flightProfile: PROFILE(), massLossRate: 2.2, maxGLimit: 4
			},
			{ id: 9, type: OBJECT_TYPES.DEBRIS, name: 'Debris', x: 1, y: 1, vx: 0, vy: 0, color: '#888', size: 1, radius: 2, generation: 1, borderColor: null, borderWidth: 0, mass: 3 }
		];
		const wm = recorder();
		const om = new ObjectManager(null, wm);
		om.loadState(JSON.parse(JSON.stringify(old)));
		const rocket = om.objects.find(o => o.id === 5);
		assert.strictEqual(rocket.restoredRuntimeState, false);
		assert.strictEqual(rocket.runtimeState, null);
		assert.equal(om.objects.find(o => o.id === 9).debrisSubType, 0);
		const add = wm.posted.find(m => m.cmd === 'add' && m.id === 5);
		assert.strictEqual(add.restoredRuntimeState, false);
		assert.strictEqual(add.runtimeState, null);
		const engine = new PhysicsEngine();
		wm.posted.filter(m => m.cmd === 'add').forEach(m => engine.addObject(m));
		const cr = engine.objects.find(o => o.id === 5);
		assert.equal(cr.totalStages, 1, 'legacy single-stage conversion');
		assert.equal(cr.currentStageIndex, 0);
		assert.equal(cr.dryMass, 25);
		assert.equal(cr.fuelMass, 100);
		assert.equal(cr.oxidMass, 230);
		assert.equal(cr.burnTime, 150);
		assert.equal(cr.thrustForce, 7.25e6);
		assert.equal(cr.massLossRate, 330 / 150);
		assert.equal(cr.stageState, 'STG_BURNING');
		assert.equal(cr.flightComputer.flightTime, 0);
		assert.equal(engine.objects.find(o => o.id === 9).debrisSubType, 0);
		assert.equal(engine.objects.find(o => o.id === 0).rotationAngle, 0);
	});

	it('loadState of a non-array clears objects and loads nothing', () => {
		for (const bad of [null, undefined, {}, 'x', 5]) {
			const om = new ObjectManager(null, recorder());
			om.addObject(new Debris(1, 'D', 0, 0, 0, 0, 1, '#888', 1, 1, 1, null, 0));
			om.loadState(bad);
			assert.equal(om.objects.length, 0, `${JSON.stringify(bad)}`);
		}
	});
});

// ==================================================================
// 10. §3.5-3 InfoPanel Date compatibility
// ==================================================================
describe('Unit 10-10: InfoPanel Date / number compatibility (§3.5-3)', () => {
	afterEach(() => {
		mock.timers.reset();
		EventBus.clearAll();
	});
	const NOW = 1_000_000;
	const interval = UI.UPDATE_INTERVAL.INFO_PANEL;
	const panel = () => {
		mock.timers.enable({ apis: ['Date'], now: NOW });
		return new InfoPanel({ objects: [] });
	};

	it('initializes lastTime as a number (Date.now())', () => {
		const info = panel();
		assert.equal(typeof info.lastTime, 'number');
		assert.equal(info.lastTime, NOW);
	});

	for (const kind of ['number', 'Date']) {
		it(`updates exactly at the interval boundary with a ${kind} lastTime`, () => {
			const info = panel();
			const mk = (ms) => (kind === 'Date' ? new Date(ms) : ms);
			info.lastTime = mk(NOW - (interval - 1));
			info.fpsCount = 0;
			info.ui.fps.textContent = 'before';
			info.ui.fps._cachedText = 'before';
			info.updateFPS();
			assert.equal(info.fpsCount, 1, 'interval - 1 ms: no update');
			assert.equal(info.ui.fps.textContent, 'before');

			info.lastTime = mk(NOW - interval);
			info.fpsCount = 9;
			info.physFpsCount = 5;
			info.lastSubSteps = 120;
			info.updateFPS();
			const sec = interval / 1e3;
			assert.equal(info.ui.fps.textContent, `${(10 / sec).toFixed(1)} / ${(5 / sec).toFixed(1)}`);
			assert.equal(info.ui.fps.title, 'Sub-steps: 120');
			assert.equal(info.fpsCount, 0);
			assert.equal(info.physFpsCount, 0);
			assert.strictEqual(info.lastTime, NOW, 'lastTime stored as a number');
		});
	}

	it('treats a non-numeric lastTime as 0 instead of producing NaN', () => {
		for (const bad of [undefined, null, NaN, 'abc', {}]) {
			const info = panel();
			info.lastTime = bad;
			info.fpsCount = 9999;
			info.physFpsCount = 5000;
			info.lastSubSteps = 0;
			info.ui.fps.title = 'unchanged';
			info.updateFPS();
			assert.ok(!info.ui.fps.textContent.includes('NaN'), `${String(bad)}`);
			// elapsed = NOW - 0 ms
			assert.equal(info.ui.fps.textContent, `${(10000 / (NOW / 1e3)).toFixed(1)} / ${(5000 / (NOW / 1e3)).toFixed(1)}`);
			assert.equal(info.ui.fps.title, 'unchanged', 'no sub-step title when lastSubSteps is 0');
			mock.timers.reset();
			EventBus.clearAll();
		}
	});

	it('a future lastTime (negative elapsed) does not update', () => {
		const info = panel();
		info.lastTime = new Date(NOW + 10);
		info.ui.fps.textContent = 'before';
		info.ui.fps._cachedText = 'before';
		info.updateFPS();
		assert.equal(info.fpsCount, 1);
		assert.equal(info.ui.fps.textContent, 'before');
		assert.strictEqual(info.lastTime.getTime(), NOW + 10, 'lastTime untouched');
	});
});

// ==================================================================
// 11. §3.5-3 / §4.9 determineOptimalSubSteps on the SSOT
// ==================================================================
describe('Unit 10-11: determineOptimalSubSteps uses SIMULATION.SUB_STEPS directly (§3.5-3, §4.9)', () => {
	const cfg = SIMULATION.SUB_STEPS;
	const poweredRocket = (id = 900) => ({ ...calcRocketPayload(id), isHoldDown: false, isIgnited: true });

	it('has no duplicated literal fallback and every referenced key exists in the SSOT', () => {
		const src = SRC('gravsim_calc.js');
		const body = src.slice(src.indexOf('determineOptimalSubSteps(totalDt, timeScale)'), src.indexOf('Simulation Controller'));
		assert.match(body, /const cfg = SIMULATION\.SUB_STEPS;/);
		assert.doesNotMatch(src, /SIMULATION\.SUB_STEPS\s*\|\|/);
		const keys = new Set([...body.matchAll(/cfg\.([A-Z_]+)/g)].map(m => m[1]));
		assert.ok(keys.size >= 15);
		for (const k of keys) {
			assert.ok(Number.isFinite(cfg[k]), `SIMULATION.SUB_STEPS.${k} is defined`);
		}
	});

	it('SimulationController fallbacks equal the SSOT values', () => {
		const src = SRC('gravsim_calc.js');
		assert.equal(Number(src.match(/cfg\?\.SMOOTHING_DECAY \?\? ([0-9.]+)/)[1]), cfg.SMOOTHING_DECAY);
		assert.equal(Number(src.match(/cfg\?\.MIN \?\? ([0-9.]+)/)[1]), cfg.MIN);
		assert.equal(Number(src.match(/cfg\?\.MAX \?\? ([0-9.]+)/)[1]), cfg.MAX);
		assert.equal(Number(src.match(/SIMULATION\.SUB_STEPS\?\.BASE \|\| ([0-9.]+)/)[1]), cfg.BASE);
		const ctrl = new SimulationController();
		assert.equal(ctrl.currentSubSteps, cfg.BASE);
		ctrl.destroy();
	});

	it('baseline steps scale with timeScale and the base cap', () => {
		const engine = new PhysicsEngine();
		engine._categorizeBodies();
		const base = (ts) => Math.max(cfg.MIN, Math.ceil(cfg.BASE * Math.min(ts, cfg.TIME_SCALE_BASE_CAP)));
		const half = cfg.MIN / cfg.BASE;
		for (const ts of [0, -1, half, half + 1e-6, 1, 2.5, cfg.TIME_SCALE_BASE_CAP, cfg.TIME_SCALE_BASE_CAP + 0.5, 1e9]) {
			assert.equal(engine.determineOptimalSubSteps(1, ts), base(ts), `timeScale ${ts}`);
		}
		assert.equal(engine.determineOptimalSubSteps(1, 0), cfg.MIN);
		assert.equal(engine.determineOptimalSubSteps(1, half + 1e-6), cfg.MIN + 1, 'just above the MIN boundary');
		assert.equal(engine.determineOptimalSubSteps(1, 1e9), Math.ceil(cfg.BASE * cfg.TIME_SCALE_BASE_CAP));
	});

	it('powered rockets bound dt by ROCKET_POWERED_MAX_DT and the result is clamped to MAX', () => {
		const engine = new PhysicsEngine();
		engine.addObject(poweredRocket());
		engine._categorizeBodies();
		const dtR = cfg.ROCKET_POWERED_MAX_DT;
		assert.equal(engine.determineOptimalSubSteps(100, 1), Math.ceil(100 / dtR));
		assert.equal(engine.determineOptimalSubSteps(cfg.MAX * dtR - 0.6, 1), Math.ceil((cfg.MAX * dtR - 0.6) / dtR));
		assert.equal(engine.determineOptimalSubSteps(cfg.MAX * dtR, 1), cfg.MAX, 'exactly MAX');
		assert.equal(engine.determineOptimalSubSteps(cfg.MAX * dtR + 0.001, 1), cfg.MAX, 'clamped just above MAX');
		const held = new PhysicsEngine();
		held.addObject({ ...poweredRocket(), isHoldDown: true });
		held._categorizeBodies();
		assert.equal(held.determineOptimalSubSteps(100, 1), cfg.BASE, 'held-down rocket adds no constraint');
	});

	it('scales the maximum with the body count above BODY_COUNT_THRESHOLD', () => {
		const run = (n) => {
			const engine = new PhysicsEngine();
			engine.addObject(poweredRocket());
			for (let i = 1; i < n; i++) {
				engine.objects.push(new CalcDebris(1000 + i, 'D', 1e9 + i * 1e4, 0, 0, 0, 0, 0, 1, 1, 1, 0, null));
			}
			engine._categorizeBodies();
			return engine.determineOptimalSubSteps(1e5, 1);
		};
		const thr = cfg.BODY_COUNT_THRESHOLD;
		const floorMax = cfg.MIN * cfg.BODY_COUNT_MIN_MULT;
		assert.equal(run(thr), cfg.MAX, 'at the threshold');
		assert.equal(run(thr + 1), Math.max(floorMax, Math.floor(cfg.MAX * (thr / (thr + 1)))), 'just above the threshold');
		const atFloor = Math.floor(cfg.MAX * thr / floorMax);
		assert.equal(run(atFloor), floorMax, 'reaches the floor');
		assert.equal(run(atFloor + 100), floorMax, 'clamped to the floor below it');
	});

	it('uses AERO_DYNAMIC.DEFAULT_SCALE_HEIGHT when the atmosphere body has no scale height (AERO_DYNAMIC import)', () => {
		const make = (param) => {
			const engine = new PhysicsEngine();
			const d = engine.addObject({ id: 77, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 0, y: 0, vx: 849, vy: 0, mass: 1, radius: 1 });
			engine._categorizeBodies();
			d.ax = 0;
			d.ay = 0;
			d.inAtmosphere = true;
			d._nearestAtmBody = { name: 'NoSuchBody', param };
			return engine;
		};
		const v = 849;
		const dtDefault = cfg.ETA_ATM * (AERO_DYNAMIC.DEFAULT_SCALE_HEIGHT / (v + cfg.ATM_VEL_OFFSET));
		assert.equal(make({ ATM_LIMIT_ALT: 1 }).determineOptimalSubSteps(100, 1), Math.max(cfg.BASE, Math.ceil(100 / dtDefault)));
		const dtCustom = cfg.ETA_ATM * (17000 / (v + cfg.ATM_VEL_OFFSET));
		assert.equal(make({ ATM_LIMIT_ALT: 1, ATM_SCALE_HEIGHT: 17000 }).determineOptimalSubSteps(100, 1), Math.max(cfg.BASE, Math.ceil(100 / dtCustom)));
	});
});

// ==================================================================
// 12. §3.5-2 dead code removal and §4.9
// ==================================================================
describe('Unit 10-12: removed dead code (§3.5-2) and redundant code (§4.9)', () => {
	afterEach(() => EventBus.clearAll());

	const REMOVED = [
		['RENDER.PREDICTED_TRAJECTORY', RENDER.PREDICTED_TRAJECTORY, 'COLOR_ORBIT'],
		['RENDER.PREDICTED_TRAJECTORY', RENDER.PREDICTED_TRAJECTORY, 'COLOR_FALL'],
		['SIMULATION', SIMULATION, 'CALC_SUB_STEPS_BASE'],
		['SIMULATION', SIMULATION, 'CALC_SUB_STEPS_MAX'],
		['TRAJECTORY_PREDICTION.EVENTS', TRAJECTORY_PREDICTION.EVENTS, 'ORBIT_HORIZONTAL_VEL_MIN_M_S'],
		['FLIGHT_COMPUTER_CONFIG', FLIGHT_COMPUTER_CONFIG, 'TOWER_CLEARANCE_MIN_Q']
	];

	it('removed constants are absent and referenced nowhere in scripts/', () => {
		const dir = path.resolve(process.cwd(), 'scripts');
		const sources = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
		for (const [owner, obj, key] of REMOVED) {
			assert.ok(obj && typeof obj === 'object', `${owner} exists`);
			assert.equal(Object.prototype.hasOwnProperty.call(obj, key), false, `${owner}.${key} removed`);
			assert.equal(sources.includes(key), false, `${key} has no remaining reference`);
		}
		assert.ok(Object.prototype.hasOwnProperty.call(RENDER.PREDICTED_TRAJECTORY, 'COLOR_FLIGHT'), 'sibling constants kept');
	});

	it('TrajectoryPredictor.prototype.render has a single definition with the null-prediction guard', () => {
		const src = SRC('gravsim_trajectory_predictor.js');
		assert.equal([...src.matchAll(/^\s*render\s*\(\s*ctx\s*,\s*renderContext/gm)].length, 1);
		const orig = TrajectoryPredictor.renderTrajectory;
		const calls = [];
		TrajectoryPredictor.renderTrajectory = (...args) => { calls.push(args); };
		try {
			TrajectoryPredictor.prototype.render.call({ prediction: null }, 'ctx', {});
			assert.equal(calls.length, 0, 'no prediction -> nothing rendered');
			const prediction = { points: [] };
			TrajectoryPredictor.prototype.render.call({ prediction }, 'ctx', { showPredictedTrajectory: false }, { extra: 1 });
			assert.equal(calls.length, 1);
			assert.strictEqual(calls[0][2], prediction);
			assert.deepEqual(calls[0][3], { showPredictedTrajectory: false, showActualPath: true, extra: 1 });
			TrajectoryPredictor.prototype.render.call({ prediction }, 'ctx', null);
			assert.deepEqual(calls[1][3], { showPredictedTrajectory: true, showActualPath: true });
		} finally {
			TrajectoryPredictor.renderTrajectory = orig;
		}
	});

	it('Universe no longer integrates celestial rotation on the main thread', () => {
		const src = SRC('gravsim_universe.js');
		assert.equal(src.includes('ROTATION_PERIOD'), false);
		assert.equal(/rotationAngle\s*=/.test(src), false);
		const uni = new Universe(createMockElement('canvas'));
		const earth = new CelestialBody(50, 'Earth', 10, 10, 0, 0, 5.972e21, '#36c', 5, 6371000, 0, null, 0);
		earth.param = { ROTATION_PERIOD: 86164 };
		earth.rotationAngle = 0.25;
		uni.ObjectManager.addObject(earth);
		EventBus.emitUpdate(16, 3600);
		EventBus.emitUpdate(16, 86164 / 4);
		assert.equal(earth.rotationAngle, 0.25);
		uni.destroy();
	});

	it('§4.9: normalizeRocketConfig emits no unread mission fields', () => {
		for (const input of [{ stages: [{}] }, { stages: [{}, {}], payload: payloadCfg() }, { dryMassT: 1, fuelMassT: 2 }]) {
			const out = normalizeRocketConfig(input);
			for (const k of ['disableOrbitalCutoff', 'targetApogeeKm', 'targetPerigeeKm', 'targetVInfKmS', 'flightProfile']) {
				assert.equal(Object.prototype.hasOwnProperty.call(out, k), false, `${k} not added`);
			}
		}
		assert.strictEqual(normalizeRocketConfig(null), null);
	});

	it('§4.9: _computeVisualLayout returns no totalLength in any layout branch', () => {
		const layouts = [
			{ stages: [{}, {}], currentStageIndex: 0, fairing: { enabled: true } },
			{ stages: [{}, {}], currentStageIndex: 1 },
			{ stages: [{}, {}], isPayloadSeparated: true },
			{ stages: [{}], currentStageIndex: 0 },
			{ stages: [{}, {}, {}], currentStageIndex: 0 },
			{ stages: [{}, {}, {}], currentStageIndex: 1 },
			{ stages: [{}, {}, {}], currentStageIndex: 2 }
		];
		for (const rocket of layouts) {
			const out = RocketRenderer._computeVisualLayout(rocket, 10);
			assert.deepEqual(Object.keys(out).sort(), ['halfWidth', 'screenRadius', 'xMax', 'xMin'], JSON.stringify(rocket));
		}
	});

	it('§4.9: PresetManager public methods carry a single merged JSDoc block', () => {
		const lines = SRC('gravsim_preset_manager.js').split('\n');
		for (const sig of ['calculateMissionFlightPlan({', 'applyToLauncher(launcher']) {
			const idx = lines.findIndex(l => l.trim().startsWith(sig));
			assert.ok(idx > 0, `${sig} found`);
			let i = idx - 1;
			assert.match(lines[i].trim(), /^\*\/$/, `${sig} has a JSDoc block`);
			while (i > 0 && !lines[i].trim().startsWith('/**')) { i--; }
			assert.ok(lines.slice(i, idx).some(l => l.includes('@param')), `${sig} JSDoc has @param`);
			const prev = lines[i - 1].trim();
			assert.notEqual(prev, '*/', `${sig}: no second JSDoc block directly above`);
			assert.equal(lines.slice(Math.max(0, i - 3), i).some(l => l.trim() === '*/'), false, `${sig}: no split JSDoc`);
		}
	});
});
