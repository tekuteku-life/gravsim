/**
 * Regression Test Suite 10: Persistence findings G2-01 and G2-07 (work unit E)
 *
 * G2-01: every rollout and every slingshot rocket used to enter the CalcRocket restore branch because the
 *        main-thread Rocket always carries stageState 'PRE_LAUNCH'; the slingshot vehicle lost its first-stage
 *        propulsion (burnTime 0, fuel 0, stuck in PRE_LAUNCH). Contract (§4.1): restore only for
 *        restoredRuntimeState === true, emitted by getState and carried by loadState / _buildRocketPayload.
 * G2-07: FlightComputer state, booster timers, tank pressure and debrisSubType were lost on save/load (time
 *        profiles re-evaluated from 0 s, SRB burn extended). Fixed by the Worker runtime snapshot (§4.7) with
 *        restore-value validation (§4.7 Rev 6.2, Iteration 2 Watchpoint 2).
 * G3-1-01: a flight saved during a burn lost the thrust of the first half-step after the load (_thrustRatio and
 *        _wasFiring not saved; falcon9 perigee 1.2-2.7 % off after 900 s), drag and the aero cache were re-evaluated
 *        from the saved v(t + dt), positions went through the pixel round trip, and jettisoned hardware lost its
 *        parent rocket (fairing halves / SRB casings collided with their rocket at the first frame). Fixed in Rev 6.11:
 *        the continuation is bit-identical.
 * G3-1-02: the §3.5-1 booleans were only compared at their default values; a save on the pad and after payload
 *        separation now goes through the real path.
 *
 * All checks go through the real path: RocketLauncher.rollout / ObjectPlacer slingshot -> ObjectManager ->
 * structured-clone Worker bridge -> SimulationController / PhysicsEngine -> WorkerBridge -> ObjectManager.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockElement, assertClose } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { Debris } from '../../scripts/gravsim_object.js';
import { OBJECT_TYPES, PHYSICS, SIMULATION, TANK_PRESSURE_SIM } from '../../scripts/gravsim_const.js';

// ------------------------------------------------------------------
// Worker transport emulation (structured clone, FIFO asynchronous replies)
// ------------------------------------------------------------------
let activeBridge = null;

class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.received = [];
		if (this.isPhysics) { PhysicsWorkerBridge.instances.push(this); }
	}

	postMessage(msg) {
		if (!this.isPhysics) { return; }
		const data = structuredClone(msg);
		this.received.push(data);
		const prev = activeBridge;
		activeBridge = this;
		try {
			this.ctrl.handleMessage({ data });
		} finally {
			activeBridge = prev;
		}
	}

	toMain(msg) {
		const data = structuredClone(msg);
		setImmediate(() => { if (this.onmessage) { this.onmessage({ data }); } });
	}

	terminate() {}
}
PhysicsWorkerBridge.instances = [];

const DT = 0.05;
const SUB_STEPS = 10;
const FRAME_S = DT * SUB_STEPS;
// Continuation accuracy (G3-1-01, Rev 6.11): bit-identical to the uninterrupted flight (orbit elements Object.is,
// events at the same flight time). Only the degraded mode (no snapshot) is compared with a tolerance.
const DEGRADED_REL_DIFF = 0.1;
const FLIGHT_TEST_TIMEOUT_MS = 60000;
const sameOrbit = (got, ref, label) => {
	assert.ok(Object.is(got.peKm, ref.peKm), `${label}: perigee ${got.peKm} vs ${ref.peKm} km`);
	assert.ok(Object.is(got.apKm, ref.apKm), `${label}: apogee ${got.apKm} vs ${ref.apKm} km`);
};
// A trigger is evaluated once per sub-step, so it fires at the first sub-step whose clock reaches the threshold
const TRIGGER_STEP_TOL_S = DT + 1e-9;

// First flight time (per sub-step) at which `pred` holds for the rocket
const firstTime = (bridge, rocketId, frames, pred) => {
	let t = null;
	stepFrames(bridge, frames, (e) => {
		const r = e.objects.find(o => o.id === rocketId);
		if (t === null && r && pred(r)) { t = r.flightComputer.flightTime; }
	});
	return t;
};

const stepFrames = (bridge, frames, onSubStep = null) => {
	const e = bridge.ctrl.engine;
	for (let f = 0; f < frames; f++) {
		e._categorizeBodies();
		e._buildQuadTree(FRAME_S);
		e._checkCollisions(FRAME_S);
		e._checkRocheLimit();
		for (let i = 0; i < SUB_STEPS; i++) {
			e._moveObjects(DT);
			if (onSubStep) { onSubStep(e); }
		}
		e._updateEscapeStatus();
		const buf = WorkerBridge.formatWorkerToMain(e.objects);
		bridge.onmessage({ data: { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length } });
		e.removeDeadObjects();
	}
};

const lastBridge = () => PhysicsWorkerBridge.instances[PhysicsWorkerBridge.instances.length - 1];
const workerRocket = (bridge, id) => bridge.ctrl.engine.objects.find(o => o.id === id);
const workerEarth = (bridge) => bridge.ctrl.engine.objects.find(o => o.name === 'Earth');
const rocketEntry = (state) => state.objectManager.find(o => o.type === OBJECT_TYPES.ROCKET);

const orbitOf = (r, earth) => {
	const GM = PHYSICS.G * earth.mass;
	const rx = r.x - earth.x;
	const ry = r.y - earth.y;
	const vx = r.vx - earth.vx;
	const vy = r.vy - earth.vy;
	const rr = Math.hypot(rx, ry);
	const v = Math.hypot(vx, vy);
	const energy = v * v / 2 - GM / rr;
	const a = -GM / (2 * energy);
	const h = rx * vy - ry * vx;
	const ecc = Math.sqrt(Math.max(0, 1 + 2 * energy * h * h / (GM * GM)));
	return { apKm: (a * (1 + ecc) - earth.radius) / 1000, peKm: (a * (1 - ecc) - earth.radius) / 1000 };
};

const relDiff = (a, b) => Math.abs(a - b) / Math.abs(b);

const newWorld = () => {
	const universe = new Universe(createMockElement('canvas'));
	const bridge = lastBridge();
	const earth = universe.ObjectPlacer.placeAtOrbitAroundSun('Earth') || universe.objects.find(o => o.name === 'Earth');
	return { universe, bridge, earth };
};

const rollout = ({ vehicleId, payloadId = 'earth_obs', missionId = 'leo_250km', profile = null }) => {
	const w = newWorld();
	w.universe.RocketLauncher.hostId = w.earth.id;
	presetManager.applyToLauncher(w.universe.RocketLauncher, { vehicleId, payloadId, missionId });
	if (profile) { w.universe.RocketLauncher.flightProfile = profile; }
	w.universe.RocketLauncher.rollout();
	const rocket = w.universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
	return { ...w, rocketId: rocket.id };
};

const liftoff = (w) => {
	const seq = w.universe.LaunchSequencer;
	seq.rocketId = w.rocketId;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(w.bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(w.bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
};

// Save through Universe.captureRuntimeSnapshot (real CalcWorkerManager protocol) and Universe.getState
const saveState = async (w) => JSON.parse(JSON.stringify(w.universe.getState(await w.universe.captureRuntimeSnapshot())));

const loadWorld = (state) => {
	const universe = new Universe(createMockElement('canvas'));
	const bridge = lastBridge();
	universe.loadState(JSON.parse(JSON.stringify(state)));
	return { universe, bridge };
};

// `_activateStage(0)` reference values derived from the stage-0 configuration the Worker received (§4.1, §3.5-1)
const assertStage0Reference = (r, add, label) => {
	const s0 = add.stages[0];
	assert.ok(s0.burnTime > 0, `${label}: stage 0 has a configured burn time`);
	assert.equal(r.currentStageIndex, 0, `${label}: currentStageIndex`);
	assert.equal(r.dryMass, s0.dryMassT, `${label}: dryMass`);
	assert.equal(r.fuelMass, s0.fuelMassT, `${label}: fuelMass`);
	assert.equal(r.oxidMass, s0.oxidMassT, `${label}: oxidMass`);
	assert.equal(r.burnTime, s0.burnTime, `${label}: burnTime`);
	assert.equal(r.thrustForce, s0.thrustKN * 1000, `${label}: thrustForce`);
	assert.equal(r.thrustForceVac, s0.thrustKN * 1000, `${label}: thrustForceVac`);
	assert.equal(r.massLossRate, (s0.fuelMassT + s0.oxidMassT) / s0.burnTime, `${label}: massLossRate`);
	assert.equal(r.isPayloadSeparated, false, `${label}: isPayloadSeparated`);
	assert.strictEqual(r.isStage2Separated, false, `${label}: isStage2Separated initialized`);
	assert.strictEqual(r.hasPayloadPropulsion, undefined, `${label}: hasPayloadPropulsion compat contract`);
	assert.equal(r.stgTimer, 0, `${label}: stgTimer`);
	assert.equal(r.flightComputer.flightTime, 0, `${label}: FC time`);
	assert.equal(r.presState, 'ROLLOUT_FILL', `${label}: tank state`);
	const fairingT = (add.fairing?.enabled && !add.fairing?.isSeparated) ? add.fairing.massT : 0;
	const stagesT = add.stages.reduce((s, st) => s + st.dryMassT + st.fuelMassT + st.oxidMassT, 0);
	assertClose(r.mass, (add.payload?.massT || 0) + fairingT + stagesT, 1e-9, `${label}: total mass`);
};

const TIME_PROFILE = () => ([
	{ type: 'time', value: 0, thrust: 100, angle: 0, action: '' },
	{ type: 'time', value: 20, thrust: 100, angle: 10, action: '' },
	{ type: 'time', value: 60, thrust: 100, angle: 30, action: '' },
	{ type: 'time', value: 120, thrust: 100, angle: 55, action: '' },
	{ type: 'time', value: 200, thrust: 100, angle: 75, action: '' },
	{ type: 'time', value: 300, thrust: 100, angle: 88, action: '' },
	{ type: 'time', value: 450, thrust: 100, angle: 90, action: '' }
]);

describe('Regression 10: persistence findings G2-01 / G2-07', () => {
	let origWorker;
	let hadSelf;
	let origSelf;

	before(() => {
		origWorker = globalThis.Worker;
		hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
		origSelf = globalThis.self;
		globalThis.Worker = PhysicsWorkerBridge;
		globalThis.self = { postMessage: (msg) => { activeBridge.toMain(msg); } };
	});

	after(() => {
		globalThis.Worker = origWorker;
		if (hadSelf) { globalThis.self = origSelf; } else { delete globalThis.self; }
	});

	afterEach(() => EventBus.clearAll());

	describe('G2-01: restore-branch contract', () => {
		const configs = [
			{ vehicleId: 'h3_30', payloadId: 'earth_obs' },
			{ vehicleId: 'h3_22', payloadId: 'earth_obs' },
			{ vehicleId: 'h3_24', payloadId: 'earth_obs' },
			{ vehicleId: 'falcon9', payloadId: 'earth_obs' },
			{ vehicleId: 'epsilon', payloadId: 'asnaro_2' },
			{ vehicleId: 'ssto', payloadId: 'earth_obs' }
		];
		for (const cfg of configs) {
			it(`rollout of ${cfg.vehicleId} initializes through _activateStage(0), not the restore branch`, () => {
				const w = rollout(cfg);
				const main = w.universe.objects.find(o => o.id === w.rocketId);
				assert.equal(main.stageState, 'PRE_LAUNCH', 'main Rocket default that used to trigger the restore inference');
				assert.strictEqual(main.restoredRuntimeState, false);
				const add = w.bridge.received.find(m => m.cmd === 'add' && m.id === w.rocketId);
				assert.strictEqual(add.restoredRuntimeState, false);
				assert.strictEqual(add.runtimeState, null);
				assert.equal(add.stageState, 'PRE_LAUNCH');
				const r = workerRocket(w.bridge, w.rocketId);
				assertStage0Reference(r, add, cfg.vehicleId);
				assert.equal(r.stageState, 'PRE_LAUNCH');
				assert.equal(r.isHoldDown, true);
				assert.equal(r.isBoosterIgnited, false);
				assert.equal(r.boosterBurnTimer, 0);
			});
		}

		it('slingshot rocket keeps its first-stage propulsion and keeps burning', () => {
			const w = newWorld();
			document.getElementById('mass-select').value = 'Rocket';
			const cx = w.universe.canvas.width / 2;
			const cy = w.universe.canvas.height / 2;
			EventBus.emit('input:drag-start', cx + 300, cy);
			EventBus.emit('input:drag-end', cx + 280, cy);
			const main = w.universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
			assert.ok(main, 'slingshot rocket placed');
			assert.equal(main.disableStaging, true);
			const add = w.bridge.received.find(m => m.cmd === 'add' && m.id === main.id);
			assert.strictEqual(add.restoredRuntimeState, false);
			assert.strictEqual(add.runtimeState, null);
			assert.equal(add.stageState, 'PRE_LAUNCH');
			assert.equal(add.burnTime, 0, 'main-thread slingshot object has no burn time of its own');
			assert.equal(add.fuelMass, 0);
			assert.deepEqual(add.stages, w.universe.RocketLauncher.stages, 'stages copied from the launcher');
			const r = workerRocket(w.bridge, main.id);
			assert.equal(r.isHoldDown, false);
			assertStage0Reference(r, add, 'slingshot');
			assert.equal(r.stageState, 'STG_BURNING');

			const s0 = add.stages[0];
			const prop0 = r.fuelMass + r.oxidMass;
			stepFrames(w.bridge, 40); // 20 s
			const r2 = workerRocket(w.bridge, main.id);
			assert.equal(r2.collided, false);
			assert.equal(r2.stageState, 'STG_BURNING', 'still burning after 20 s');
			assert.equal(r2._thrustRatio, 1, 'full-duration thrust in the last sub-step');
			assert.equal(r2.flightComputer.currentThrottle, 1, 'empty profile -> full throttle');
			assert.equal(r2.thrustForce, s0.thrustKN * 1000, 'stage-0 thrust kept (was lost in G2-01)');
			assertClose(r2.burnTime, s0.burnTime - 20, 1e-6, 'burn time consumed');
			assertClose(prop0 - (r2.fuelMass + r2.oxidMass), r.massLossRate * 20, 1e-6, 'propellant consumed');
			const mainAfter = w.universe.objects.find(o => o.id === main.id);
			assert.equal(mainAfter.stageState, 'STG_BURNING', 'synchronized to the main thread');
		});

		it('save/load carries restoredRuntimeState: true and restores the in-flight stage instead of re-activating stage 0', async () => {
			const A = rollout({ vehicleId: 'h3_22' });
			liftoff(A);
			stepFrames(A.bridge, 640); // 320 s: SRBs gone, second stage burning
			const rA = workerRocket(A.bridge, A.rocketId);
			assert.equal(rA.currentStageIndex, 1, 'precondition: second stage');
			assert.equal(rA.stageState, 'STG_BURNING');
			const state = await saveState(A);
			const entry = rocketEntry(state);
			assert.strictEqual(entry.restoredRuntimeState, true);
			assert.equal(entry.currentStageIndex, 1);

			const B = loadWorld(state);
			const mainB = B.universe.objects.find(o => o.id === A.rocketId);
			assert.strictEqual(mainB.restoredRuntimeState, true);
			const add = B.bridge.received.find(m => m.cmd === 'add' && m.id === A.rocketId);
			assert.strictEqual(add.restoredRuntimeState, true);
			assert.deepEqual(add.runtimeState, entry.runtimeState);
			const rB = workerRocket(B.bridge, A.rocketId);
			for (const k of ['currentStageIndex', 'stageState', 'isBoosterBurnout', 'isBoosterSeparated', 'isPayloadSeparated', 'isStage2Separated', 'dryMass', 'fuelMass', 'oxidMass', 'burnTime', 'thrustForceVac', 'ispVac', 'ispSl']) {
				assert.deepEqual(rB[k], rA[k], `restored ${k}`);
			}
			assert.equal(rB.thrustForceVac, add.stages[1].thrustKN * 1000);
			assertClose(rB.mass, rA.mass, 1e-12, 'restored mass');
		});
	});

	describe('G2-07: Worker runtime state survives save/load', () => {
		it('h3_22 LEO saved at 30 s: booster timers are kept and the orbit matches the uninterrupted flight (t5: Pe 143 -> 176 km)', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			const A = rollout({ vehicleId: 'h3_22' });
			liftoff(A);
			stepFrames(A.bridge, 60);
			const state = await saveState(A);
			const rt = rocketEntry(state).runtimeState;
			assert.ok(rt, 'runtime state saved');
			assert.ok(Math.abs(rt.boosterBurnTimer - 30) < 1e-6, `boosterBurnTimer ${rt.boosterBurnTimer}`);
			assert.ok(Math.abs(rt.flightComputer.flightTime - 30) < 1e-6);
			assert.ok(rt.flightComputer.highestStepIndex >= 1, 'altitude rows already latched');
			assert.equal(rt.presState, 'NOMINAL');
			const refBurnoutT = firstTime(A.bridge, A.rocketId, 1800, (r) => r.isBoosterBurnout);
			assert.ok(Math.abs(refBurnoutT - 105) <= TRIGGER_STEP_TOL_S, `reference SRB burnout at FC ${refBurnoutT} s`);
			const ref = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));

			const B = loadWorld(state);
			const rB = workerRocket(B.bridge, A.rocketId);
			assert.deepEqual(JSON.parse(JSON.stringify(rB.getRuntimeState())), rt, 'restored as saved');
			const burnoutT = firstTime(B.bridge, A.rocketId, 1800, (r) => r.isBoosterBurnout);
			assert.equal(burnoutT, refBurnoutT, 'SRB burnout at the same flight time (timer-driven -> exact, §4.7), not extended');
			const got = orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge));
			sameOrbit(got, ref, 'h3_22 saved at 30 s');

			const stripped = JSON.parse(JSON.stringify(state));
			rocketEntry(stripped).runtimeState = null;
			const C = loadWorld(stripped);
			stepFrames(C.bridge, 1800);
			const degraded = orbitOf(workerRocket(C.bridge, A.rocketId), workerEarth(C.bridge));
			assert.ok(relDiff(degraded.peKm, ref.peKm) > DEGRADED_REL_DIFF, `scenario is sensitive to the runtime state (degraded Pe ${degraded.peKm} km)`);
		});

		it('time-trigger profile saved at 150 s keeps its apogee (t6: Ap 238 -> 2,780 km)', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			const A = rollout({ vehicleId: 'h3_30', profile: TIME_PROFILE() });
			liftoff(A);
			stepFrames(A.bridge, 300);
			const state = await saveState(A);
			const fc = rocketEntry(state).runtimeState.flightComputer;
			assert.ok(Math.abs(fc.flightTime - 150) < 1e-6);
			assert.equal(fc.highestStepIndex, 3);
			const refLatchT = firstTime(A.bridge, A.rocketId, 1800, (r) => r.flightComputer._highestStepIndex === 4);
			assert.ok(Math.abs(refLatchT - 200) <= TRIGGER_STEP_TOL_S, `reference row 4 (t = 200 s) at FC ${refLatchT}`);
			const ref = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));

			const B = loadWorld(state);
			const nextLatchT = firstTime(B.bridge, A.rocketId, 1800, (r) => r.flightComputer._highestStepIndex === 4);
			assert.equal(nextLatchT, refLatchT, 'row 4 latches at the same flight time (time-triggered -> exact, §4.7), not re-evaluated from 0 s');
			const got = orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge));
			sameOrbit(got, ref, 'h3_30 time profile saved at 150 s');
		});

		it('debrisSubType reaches the Worker after a load (saved 4,4,3,3,1 used to become 0)', async () => {
			const A = newWorld();
			const subs = [4, 4, 3, 3, 1];
			subs.forEach((sub, i) => {
				const d = new Debris(-(1000 + i), 'Jettisoned', A.earth.x + 0.01 * (i + 1), A.earth.y, A.earth.vx, A.earth.vy, 2 + i, '#c8d0d8', 5, 2.6, 1, '#00ffcc', 0, sub, 'orange');
				A.universe.ObjectManager.addObject(d);
			});
			const state = await saveState(A);
			assert.deepEqual(state.objectManager.filter(o => o.type === OBJECT_TYPES.DEBRIS).map(o => o.debrisSubType), subs);
			const B = loadWorld(state);
			const got = B.bridge.ctrl.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS).map(o => [o.id, o.debrisSubType]);
			assert.deepEqual(got, subs.map((sub, i) => [-(1000 + i), sub]));
		});

		it('hand-edited runtime values are validated before they reach the flight (Iteration 2 Watchpoint 2)', async () => {
			const A = rollout({ vehicleId: 'h3_22' });
			liftoff(A);
			stepFrames(A.bridge, 20); // 10 s, stage 0
			const state = await saveState(A);
			const rt = rocketEntry(state).runtimeState;
			Object.assign(rt, { presState: 'HACKED', tankPresFuel: 1e308, presStartF: -5, boosterBurnTimer: 1e308 });
			Object.assign(rt.flightComputer, { flightTime: 1e308, hasPassedApogee: true, apogeeTime: 1e308, triggeredActionIndices: [0, 1, 2], pendingActions: ['sep_stage1'] });

			const B = loadWorld(state);
			const rB = workerRocket(B.bridge, A.rocketId);
			assert.equal(rB.presState, 'ROLLOUT_FILL', "'HACKED' rejected");
			assert.equal(rB.tankPresFuel, 2 * TANK_PRESSURE_SIM.MAX_SCALE_KPA);
			assert.equal(rB._presStartF, 0);
			assert.equal(rB.boosterBurnTimer, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S);
			assert.equal(rB.flightComputer.flightTime, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S);
			assert.equal(rB.flightComputer.apogeeTime, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S);
			assert.equal(rB.flightComputer._triggeredActionIndices.size, 0, 'rows without an action cannot be latched');
			assert.deepEqual(rB.flightComputer._pendingActions, [], 'action absent from the profile is dropped');

			stepFrames(B.bridge, 120); // +60 s
			const r2 = workerRocket(B.bridge, A.rocketId);
			assert.equal(r2.currentStageIndex, 0, 'no premature stage separation');
			assert.equal(r2.shattered, false);
			for (const k of ['x', 'y', 'vx', 'vy', 'mass', 'tankPresFuel', 'tankPresOxid', 'burnTime']) {
				assert.ok(Number.isFinite(r2[k]), `${k} finite (was NaN with flightTime 1e308)`);
			}
			const main = B.universe.objects.find(o => o.id === A.rocketId);
			assert.ok(Number.isFinite(main.telemetry.tankPresFuel) && Number.isFinite(main.telemetry.tankPresOxid));

			const allowed = JSON.parse(JSON.stringify(state));
			rocketEntry(allowed).runtimeState.presState = 'DEPLETED';
			const C = loadWorld(allowed);
			assert.equal(workerRocket(C.bridge, A.rocketId).presState, 'DEPLETED', 'allow-listed state accepted');
		});
	});

	// Uninterrupted flight A and reloaded flight B fly the same number of frames; rocket kinematics are recorded per
	// sub-step and the tracked events with their flight time
	const EVENT_FIELDS = {
		stageState: (r) => r.stageState, stage: (r) => r.currentStageIndex, fairing: (r) => Boolean(r.fairing?.isSeparated),
		payload: (r) => r.isPayloadSeparated, boosterBurnout: (r) => r.isBoosterBurnout, boosterSep: (r) => r.isBoosterSeparated, presState: (r) => r.presState
	};
	const fly = (w, rocketId, frames) => {
		const track = [];
		const events = [];
		const last = {};
		stepFrames(w.bridge, frames, (e) => {
			const r = e.objects.find(o => o.id === rocketId);
			track.push(r ? `${r.x},${r.y},${r.vx},${r.vy},${r.flightComputer.flightTime}` : 'gone');
			if (!r) { return; }
			for (const [k, get] of Object.entries(EVENT_FIELDS)) {
				const v = get(r);
				if (k in last && last[k] !== v) { events.push(`${k}=${v}@${r.flightComputer.flightTime}`); }
				last[k] = v;
			}
		});
		return { track, events };
	};
	const assertSameContinuation = (ref, got, label) => {
		const i = ref.track.findIndex((v, k) => v !== got.track[k]);
		assert.equal(i, -1, `${label}: rocket state differs from sub-step ${i + 1} (${got.track[i]} vs ${ref.track[i]})`);
		assert.deepEqual(got.events, ref.events, `${label}: same events at the same flight times`);
	};

	describe('G3-1-01: the continuation after a load is bit-identical', () => {
		// The audit measured falcon9 Pe 143.75 -> 146.75 / 147.60 km (ISS) and 141.82 -> 143.52 / 144.09 km (LEO) for saves at 100 s / 300 s
		for (const [payloadId, missionId, saveFrames] of [['htv_x', 'iss_rendezvous', 200], ['htv_x', 'iss_rendezvous', 600], ['earth_obs', 'leo_250km', 200], ['earth_obs', 'leo_250km', 600]]) {
			it(`falcon9 ${missionId} saved during the burn at ${saveFrames * FRAME_S} s: same events and orbit 900 s later`, { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
				const A = rollout({ vehicleId: 'falcon9', payloadId, missionId });
				liftoff(A);
				stepFrames(A.bridge, saveFrames);
				const rA0 = workerRocket(A.bridge, A.rocketId);
				assert.equal(rA0.stageState, 'STG_BURNING', 'precondition: saved during a burn');
				assert.equal(rA0._thrustRatio, 1, 'precondition: full thrust in the last sub-step');
				const at = { ax: rA0.ax, ay: rA0.ay, wasFiring: rA0._wasFiring, mass: rA0.mass, x: rA0.x, vy: rA0.vy };
				const state = await saveState(A);
				const rt = rocketEntry(state).runtimeState;
				assert.equal(rt.thrustRatio, 1, 'thrust state saved');
				assert.equal(rt.wasFiring, true, 'engine-start detection state saved');
				const ref = fly(A, A.rocketId, 1800);
				const refOrbit = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));
				assert.equal(workerRocket(A.bridge, A.rocketId).stageState, 'ORBITAL_COAST', 'reference flight reached orbit');

				const B = loadWorld(state);
				const rB0 = workerRocket(B.bridge, A.rocketId);
				// Root cause: the first half-step after the load used an acceleration without thrust
				assert.equal(rB0._thrustRatio, 1);
				assert.equal(rB0._wasFiring, true);
				assert.ok(Object.is(rB0.ax, at.ax) && Object.is(rB0.ay, at.ay), `a(t) of the saved step incl. thrust and drag (${rB0.ax}, ${rB0.ay} vs ${at.ax}, ${at.ay})`);
				assert.ok(Object.is(rB0.x, at.x) && Object.is(rB0.vy, at.vy), 'exact position / velocity');
				assert.equal(rB0.mass, at.mass);
				const got = fly(B, A.rocketId, 1800);
				assertSameContinuation(ref, got, `falcon9 ${missionId} @${saveFrames * FRAME_S} s`);
				assert.ok(ref.events.length >= 4, `the continuation passes staging and orbit insertion (${ref.events.join(' ')})`);
				sameOrbit(orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge)), refOrbit, `falcon9 ${missionId}`);
			});
		}

		it('jettisoned fairing halves keep their parent rocket: no self-collision at the first frame after the load', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			const A = rollout({ vehicleId: 'falcon9', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			liftoff(A);
			let f = 0;
			while (!workerRocket(A.bridge, A.rocketId).fairing.isSeparated && f++ < 1000) { stepFrames(A.bridge, 1); }
			const fairingIds = A.bridge.ctrl.engine.objects.filter(o => o.debrisSubType === 3).map(o => o.id);
			assert.equal(fairingIds.length, 2, 'precondition: two fairing halves next to the rocket');
			const state = await saveState(A);
			const entries = state.objectManager.filter(o => fairingIds.includes(o.id));
			assert.deepEqual(entries.map(o => o.runtimeState.parentRocketId), [A.rocketId, A.rocketId], 'parent rocket saved');
			const massA = workerRocket(A.bridge, A.rocketId).mass;
			const ref = fly(A, A.rocketId, 20);

			const B = loadWorld(state);
			assert.deepEqual(B.bridge.ctrl.engine.objects.filter(o => fairingIds.includes(o.id)).map(o => o.parentRocketId), [A.rocketId, A.rocketId]);
			const got = fly(B, A.rocketId, 20);
			assert.deepEqual(B.bridge.ctrl.engine.objects.filter(o => fairingIds.includes(o.id)).map(o => o.collided), [false, false], 'fairing halves still flying (used to be absorbed by the rocket)');
			assert.equal(workerRocket(B.bridge, A.rocketId).mass, workerRocket(A.bridge, A.rocketId).mass, `rocket mass (${massA} t at the save) not increased by the fairing`);
			assertSameContinuation(ref, got, 'after fairing separation');
		});
	});

	describe('G3-1-02: §3.5-1 booleans through a real save / load (pad hold-down, payload separation)', () => {
		it('saved on the pad (hold-down, engine running): the reloaded rocket is still held down and lifts off like the original', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			const A = rollout({ vehicleId: 'h3_22', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			const seq = A.universe.LaunchSequencer;
			seq.rocketId = A.rocketId;
			seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
			stepFrames(A.bridge, 2);
			seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
			stepFrames(A.bridge, 6);
			const rA0 = workerRocket(A.bridge, A.rocketId);
			assert.equal(rA0.isHoldDown, true);
			assert.equal(rA0.isIgnited, true);
			assert.notEqual(rA0.hostAngleRad, A.universe.objects.find(o => o.id === A.rocketId).hostAngleRad, 'precondition: the pad rotated with the Earth');
			const state = await saveState(A);
			const entry = rocketEntry(state);
			assert.strictEqual(entry.isHoldDown, true, 'saved held down');
			assert.strictEqual(entry.isIgnited, true);
			assert.equal(entry.stageState, 'PRE_LAUNCH');
			seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
			const ref = fly(A, A.rocketId, 240);

			const B = loadWorld(state);
			const mainB = B.universe.objects.find(o => o.id === A.rocketId);
			assert.strictEqual(mainB.isHoldDown, true, 'main thread loads the hold-down flag');
			const rB0 = workerRocket(B.bridge, A.rocketId);
			assert.strictEqual(rB0.isHoldDown, true, 'Worker still held down');
			assert.equal(rB0.hostAngleRad, rA0.hostAngleRad, 'pad angle of the saved frame');
			B.universe.LaunchSequencer.rocketId = A.rocketId;
			B.universe.LaunchSequencer.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
			const got = fly(B, A.rocketId, 240);
			assertSameContinuation(ref, got, 'pad save');
		});

		it('saved after payload separation: the reloaded object is the separated payload and flies on like the original', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			const A = rollout({ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
			liftoff(A);
			let f = 0;
			while (!workerRocket(A.bridge, A.rocketId).isPayloadSeparated && f++ < 3000) { stepFrames(A.bridge, 1); }
			const rA0 = workerRocket(A.bridge, A.rocketId);
			assert.equal(rA0.isPayloadSeparated, true, 'precondition');
			const state = await saveState(A);
			const entry = rocketEntry(state);
			assert.strictEqual(entry.isPayloadSeparated, true, 'saved separated');
			assert.strictEqual(entry.isStage2Separated, true);
			const ref = fly(A, A.rocketId, 120);
			const refOrbit = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));

			const B = loadWorld(state);
			const mainB = B.universe.objects.find(o => o.id === A.rocketId);
			assert.strictEqual(mainB.isPayloadSeparated, true);
			const rB0 = workerRocket(B.bridge, A.rocketId);
			assert.strictEqual(rB0.isPayloadSeparated, true, 'Worker restored as the separated payload');
			assert.equal(rB0.mass, rA0.mass, 'payload mass only');
			assert.equal(rB0.radius, rA0.radius, 'payload radius');
			assert.deepEqual(rB0.objParam, rA0.objParam, 'parameters of the original vehicle (not looked up by the payload name)');
			const got = fly(B, A.rocketId, 120);
			assertSameContinuation(ref, got, 'payload-separation save');
			sameOrbit(orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge)), refOrbit, 'payload');
		});
	});
});
