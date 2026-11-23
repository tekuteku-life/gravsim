/**
 * Integration Test Suite 14: Save -> Load -> Continue with the Worker runtime state (work unit E)
 *
 * Real pipeline: Universe (ObjectPlacer / RocketLauncher / LaunchSequencer / ObjectManager / SaveManager /
 * CalcWorkerManager) <-> structured-clone Worker bridge <-> SimulationController + PhysicsEngine
 * (scripts/gravsim_calc.js). The bridge only replaces the browser Worker transport: every message is
 * structured-cloned, Worker -> main replies are delivered asynchronously in FIFO order, and the physics is
 * stepped with a fixed sub-step so the uninterrupted and the reloaded flights are directly comparable.
 *
 * Design: docs/design/2026-11-20_trajectory_fx_flightplan.md §4.7 (snapshot protocol, runtimeState, degraded
 * mode without a snapshot), §4.1 (restore contract), §3.5-1 (field table); findings G2-07, G3-1-01, G3-1-02.
 *
 * Continuation contract (§1 #5 "complete restore", test plan §3-E): a flight saved and reloaded continues exactly
 * like the uninterrupted flight. With the same fixed sub-step and the same random sequence for the tank-pressure
 * noise / debris ids, this is checked bit for bit: rocket state every sub-step, event times, orbit elements and the
 * complete Worker state of every object (all fields, private ones included).
 */
import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { OBJECT_TYPES, PHYSICS, SIMULATION } from '../../scripts/gravsim_const.js';

// ------------------------------------------------------------------
// Worker transport emulation
// ------------------------------------------------------------------
let activeBridge = null;

class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.received = [];
		this.dropSnapshot = false;
		this.terminated = false;
		if (this.isPhysics) { PhysicsWorkerBridge.instances.push(this); }
	}

	postMessage(msg) {
		if (!this.isPhysics || this.terminated) { return; }
		const data = structuredClone(msg);
		this.received.push(data);
		if (data.cmd === 'snapshotRuntime' && this.dropSnapshot) { return; }
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
		setImmediate(() => {
			if (!this.terminated && this.onmessage) { this.onmessage({ data }); }
		});
	}

	terminate() { this.terminated = true; }
}
PhysicsWorkerBridge.instances = [];

const DT = 0.05; // s, integration sub-step
const SUB_STEPS = 10; // per frame -> 0.5 s per frame
const FRAME_S = DT * SUB_STEPS;
// Continuation accuracy (G3-1-01, Rev 6.11): the reloaded flight is bit-identical to the uninterrupted one, so events
// happen at exactly the same flight time and the orbit elements are equal (Object.is). Only the degraded mode (no
// snapshot) is compared with a tolerance, to show that the scenario depends on the runtime state.
const DEGRADED_REL_DIFF = 0.1;
// A trigger is evaluated once per sub-step, so it fires at the first sub-step whose clock reaches the threshold
const TRIGGER_STEP_TOL_S = DT + 1e-9;
// G3-1-07: a stuck promise fails the test instead of hanging the run
const ASYNC_TEST_TIMEOUT_MS = 5000;
const FLIGHT_TEST_TIMEOUT_MS = 60000;

// Deterministic Math.random (tank-pressure noise, Worker debris ids): re-seeded at the save point of the uninterrupted
// flight and right after the load, so both flights draw the same sequence from there on
const realRandom = Math.random;
let rngState = 1;
const reseed = (seed) => { rngState = seed >>> 0; };
const seededRandom = () => {
	rngState = (rngState + 0x6D2B79F5) >>> 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

const TRACKED = {
	highestStepIndex: (r) => r.flightComputer._highestStepIndex,
	stageState: (r) => r.stageState,
	currentStageIndex: (r) => r.currentStageIndex,
	isBoosterBurnout: (r) => r.isBoosterBurnout,
	isBoosterSeparated: (r) => r.isBoosterSeparated,
	fairingSeparated: (r) => Boolean(r.fairing?.isSeparated),
	isPayloadSeparated: (r) => r.isPayloadSeparated,
	isHoldDown: (r) => r.isHoldDown,
	// tank-pressure state machine (engine start / cutoff detection reads the restored wasFiring)
	presState: (r) => r.presState
};

const makeRecorder = (rocketId) => {
	const events = [];
	const last = {};
	const prime = (engine) => {
		const r = engine.objects.find(o => o.id === rocketId);
		for (const [field, get] of Object.entries(TRACKED)) { last[field] = get(r); }
	};
	return {
		events,
		prime,
		onSubStep(engine) {
			const r = engine.objects.find(o => o.id === rocketId);
			if (!r) { return; }
			for (const [field, get] of Object.entries(TRACKED)) {
				const v = get(r);
				if (last[field] !== undefined && last[field] !== v) {
					events.push({ field, value: v, t: r.flightComputer.flightTime });
				}
				last[field] = v;
			}
		}
	};
};

// Fixed-step replica of SimulationController.update(): same call order, deterministic dt
const stepFrames = (bridge, frames, { async = false, recorder = null } = {}) => {
	const e = bridge.ctrl.engine;
	for (let f = 0; f < frames; f++) {
		e._categorizeBodies();
		e._buildQuadTree(FRAME_S);
		e._checkCollisions(FRAME_S);
		e._checkRocheLimit();
		for (let i = 0; i < SUB_STEPS; i++) {
			e._moveObjects(DT);
			if (recorder) { recorder.onSubStep(e); }
		}
		e._updateEscapeStatus();
		const buf = WorkerBridge.formatWorkerToMain(e.objects);
		const msg = { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length };
		if (async) { bridge.toMain(msg); } else { bridge.onmessage({ data: msg }); }
		e.removeDeadObjects();
	}
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const workerRocket = (bridge, id) => bridge.ctrl.engine.objects.find(o => o.id === id);
const workerEarth = (bridge) => bridge.ctrl.engine.objects.find(o => o.name === 'Earth');

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
	return { apKm: (a * (1 + ecc) - earth.radius) / 1000, peKm: (a * (1 - ecc) - earth.radius) / 1000, energy };
};

const assertSameOrbit = (got, ref, label) => {
	assert.ok(Object.is(got.apKm, ref.apKm), `${label}: apogee ${got.apKm} vs ${ref.apKm} km (bit-identical)`);
	assert.ok(Object.is(got.peKm, ref.peKm), `${label}: perigee ${got.peKm} vs ${ref.peKm} km (bit-identical)`);
};

// ------------------------------------------------------------------
// Complete Worker state (every object, every own field incl. private ones; references to other objects by id)
// ------------------------------------------------------------------
const isCalcObject = (v) => v && typeof v === 'object' && typeof v.applyGravity === 'function' && 'id' in v;
const capture = (v, depth = 0, seen = new Set()) => {
	if (v === undefined) return '@undefined';
	if (typeof v === 'number') return Number.isNaN(v) ? '@NaN' : (Object.is(v, -0) ? '@-0' : v);
	if (v === null || typeof v !== 'object') return typeof v === 'function' ? '@function' : v;
	if (depth > 0 && isCalcObject(v)) return `@ref:${v.id}`;
	if (v instanceof Set) return { '@set': [...v].map(x => capture(x, depth + 1, seen)) };
	if (seen.has(v)) return '@cycle';
	seen.add(v);
	const out = Array.isArray(v) ? v.map(x => capture(x, depth + 1, seen)) : Object.fromEntries(Object.keys(v).map(k => [k, capture(v[k], depth + 1, seen)]));
	seen.delete(v);
	return out;
};
const captureWorker = (bridge) => {
	const e = bridge.ctrl.engine;
	return {
		order: e.objects.map(o => `${o.type}:${o.id}`),
		objects: Object.fromEntries(e.objects.map(o => [`${o.type}:${o.id}`, capture(o)]))
	};
};
const diffState = (a, b, path = '', out = []) => {
	if (typeof a === 'number' && typeof b === 'number') { if (!Object.is(a, b)) out.push({ path, a, b }); return out; }
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) out.push({ path, a, b }); return out; }
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (!(k in a) || !(k in b)) { out.push({ path: `${path}.${k}`, a: k in a ? a[k] : '@missing', b: k in b ? b[k] : '@missing' }); continue; }
		diffState(a[k], b[k], `${path}.${k}`, out);
	}
	return out;
};
// Differences that are not state of the continued flight (each is never read by the physics or guidance):
const INERT = [
	// load bookkeeping of PhysicsEngine.addObject: absent on objects never loaded, null once the first step consumed it
	(d) => /\._restoredForces$/.test(d.path) && d.a === '@missing' && d.b === null,
	// label of jettisoned hardware: the Worker names it after the rocket, the main thread (and so the save) by sub type
	(d) => /^\.objects\.2:-?\d+\.name$/.test(d.path),
	// never assigned before a payload separation (§4.1 compatibility contract) vs false from the restore derivation;
	// read only as a truthy flag
	(d) => /\.hasPayloadPropulsion$/.test(d.path) && d.a === '@missing' && d.b === false,
	// stages[0] is read only while stage 0 is active (mass sum, staging, telemetry)
	(d, r) => /\.stages\.0\.dryMassT$/.test(d.path) && r.currentStageIndex >= 1
];
const assertSameWorkerState = (ref, got, rocketKey, label) => {
	assert.deepEqual(got.order, ref.order, `${label}: same objects in the same order`);
	const r = ref.objects[rocketKey] || {};
	const diffs = diffState(ref, got).filter(d => !INERT.some(inert => inert(d, r)));
	assert.deepEqual(diffs.slice(0, 10).map(d => `${d.path}: ${d.a} vs ${d.b}`), [], `${label}: complete Worker state identical`);
};

// Rollout through the real RocketLauncher, then the LEGACY_QUICK command order of LaunchSequencer.executeCommand
const launch = ({ vehicleId, payloadId = 'earth_obs', missionId = 'leo_250km', profile = TIME_PROFILE() }) => {
	const universe = new Universe(createMockElement('canvas'));
	const bridge = PhysicsWorkerBridge.instances[PhysicsWorkerBridge.instances.length - 1];
	const earth = universe.ObjectPlacer.placeAtOrbitAroundSun('Earth') || universe.objects.find(o => o.name === 'Earth');
	const launcher = universe.RocketLauncher;
	launcher.hostId = earth.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	if (profile) { launcher.flightProfile = profile; }
	launcher.rollout();
	const rocket = universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
	assert.ok(rocket, 'rocket rolled out');
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
	assert.equal(workerRocket(bridge, rocket.id).isHoldDown, false, 'released');
	return { universe, bridge, rocketId: rocket.id };
};

// SaveManager download capture
let blobs = [];
const captureDownloads = () => {
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
	URL.revokeObjectURL = () => {};
	return () => { URL.createObjectURL = origCreate; URL.revokeObjectURL = origRevoke; };
};
const lastSave = async () => JSON.parse(await blobs[blobs.length - 1].text());

const loadInto = (json) => {
	const universe = new Universe(createMockElement('canvas'));
	const bridge = PhysicsWorkerBridge.instances[PhysicsWorkerBridge.instances.length - 1];
	const target = { files: [{ name: 'save.json', content: typeof json === 'string' ? json : JSON.stringify(json) }], value: 'x' };
	universe.SaveManager.load({ target });
	assert.equal(target.value, '', 'load completed');
	return { universe, bridge };
};

const rocketEntry = (save) => save.universe.objectManager.find(o => o.type === OBJECT_TYPES.ROCKET);

// Every event after the save happens in the same order at exactly the same flight time (G3-1-01)
const assertEventsMatch = (refEvents, gotEvents, saveT, label, minEvents = 5) => {
	const ref = refEvents.filter(ev => ev.t > saveT);
	assert.ok(ref.length >= minEvents, `${label}: the continuation exercises several events (${ref.length})`);
	assert.deepEqual(gotEvents.map(ev => `${ev.field}=${ev.value}@${ev.t}`), ref.map(ev => `${ev.field}=${ev.value}@${ev.t}`), `${label}: same events at the same times`);
};

describe('Integration 14: save -> load -> continue with the Worker runtime state (§4.7, G2-07)', () => {
	let origWorker;
	let hadSelf;
	let origSelf;
	let restoreDownloads;

	before(() => {
		origWorker = globalThis.Worker;
		hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
		origSelf = globalThis.self;
		globalThis.Worker = PhysicsWorkerBridge;
		globalThis.self = { postMessage: (msg) => { activeBridge.toMain(msg); } };
		restoreDownloads = captureDownloads();
	});

	after(() => {
		globalThis.Worker = origWorker;
		if (hadSelf) { globalThis.self = origSelf; } else { delete globalThis.self; }
		restoreDownloads();
	});

	afterEach(() => {
		mock.timers.reset();
		EventBus.clearAll();
		blobs = [];
	});

	it('time-profile flight saved at 150 s with a snapshot continues like the uninterrupted flight', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
		const A = launch({ vehicleId: 'h3_30' });
		const rec = makeRecorder(A.rocketId);
		rec.prime(A.bridge.ctrl.engine);
		stepFrames(A.bridge, 300, { recorder: rec });
		const rA = workerRocket(A.bridge, A.rocketId);
		const saveT = rA.flightComputer.flightTime;
		assert.ok(Math.abs(saveT - 150) < 1e-6, `saved at ${saveT}`);

		await A.universe.SaveManager.save();
		const save = await lastSave();
		assert.equal(save.version, 2);
		const entry = rocketEntry(save);
		const workerState = rA.getRuntimeState();
		assert.strictEqual(entry.restoredRuntimeState, true);
		assert.deepEqual(entry.runtimeState, JSON.parse(JSON.stringify(workerState)), 'snapshot == Worker state at save time');
		const mainRocket = A.universe.objects.find(o => o.id === A.rocketId);
		assert.equal(entry.runtimeState.flightComputer.flightTime, mainRocket.telemetry.flightTime, 'snapshot consistent with the main thread');
		assert.equal(entry.runtimeState.flightComputer.highestStepIndex, 3, 'rows 0..3 (t >= 120 s) latched');
		assert.equal(entry.runtimeState.presState, 'NOMINAL', 'tank pressurized in flight');
		assert.equal(entry.stageState, 'STG_BURNING');
		const kinAtSave = { x: rA.x, y: rA.y, vx: rA.vx, vy: rA.vy, fuelMass: rA.fuelMass, oxidMass: rA.oxidMass, burnTime: rA.burnTime };

		// Uninterrupted reference
		stepFrames(A.bridge, 1800, { recorder: rec });
		const refOrbit = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));
		const refStage = workerRocket(A.bridge, A.rocketId).stageState;

		// Reload into a fresh universe / engine
		const B = loadInto(save);
		const add = B.bridge.received.find(m => m.cmd === 'add' && m.id === A.rocketId);
		assert.strictEqual(add.restoredRuntimeState, true);
		assert.deepEqual(add.runtimeState, entry.runtimeState);
		const rB = workerRocket(B.bridge, A.rocketId);
		assert.deepEqual(JSON.parse(JSON.stringify(rB.getRuntimeState())), entry.runtimeState, 'Worker runtime state restored exactly');
		assert.equal(rB.currentStageIndex, 0);
		assert.equal(rB.stageState, 'STG_BURNING');
		for (const k of ['fuelMass', 'oxidMass', 'burnTime']) { assert.equal(rB[k], kinAtSave[k], k); }
		for (const k of ['x', 'y', 'vx', 'vy']) { assert.ok(Object.is(rB[k], kinAtSave[k]), `${k} exact (runtimeState.kinematics, no pixel round trip)`); }

		const recB = makeRecorder(A.rocketId);
		recB.prime(B.bridge.ctrl.engine);
		stepFrames(B.bridge, 1800, { recorder: recB });
		assertEventsMatch(rec.events, recB.events, saveT, 'h3_30 time profile');
		const rB2 = workerRocket(B.bridge, A.rocketId);
		assert.equal(rB2.stageState, refStage);
		assert.equal(rB2.stageState, 'ORBITAL_COAST');
		const gotOrbit = orbitOf(rB2, workerEarth(B.bridge));
		assertSameOrbit(gotOrbit, refOrbit, 'h3_30 time profile');
		assert.ok(refOrbit.energy < 0 && gotOrbit.energy < 0, 'both bound');

		// Same file without the runtime state (degraded mode): the time profile restarts at 0 s, so the
		// scenario is clearly sensitive to the snapshot (G2-07 measured Ap 238 km vs 2,780 km)
		const stripped = JSON.parse(JSON.stringify(save));
		rocketEntry(stripped).runtimeState = null;
		const D = loadInto(stripped);
		stepFrames(D.bridge, 1800);
		const degraded = orbitOf(workerRocket(D.bridge, A.rocketId), workerEarth(D.bridge));
		assert.ok(Math.abs(degraded.apKm - refOrbit.apKm) / refOrbit.apKm > DEGRADED_REL_DIFF,
			`degraded apogee ${degraded.apKm} km must differ from ${refOrbit.apKm} km`);
	});

	it('SRB vehicle saved during the booster burn keeps booster timers; Worker debris sub types survive a reload', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
		const A = launch({ vehicleId: 'h3_22' });
		const rec = makeRecorder(A.rocketId);
		rec.prime(A.bridge.ctrl.engine);
		stepFrames(A.bridge, 120, { recorder: rec });
		const saveT = workerRocket(A.bridge, A.rocketId).flightComputer.flightTime;
		await A.universe.SaveManager.save();
		const save = await lastSave();
		const rt = rocketEntry(save).runtimeState;
		assert.equal(rt.isBoosterIgnited, true);
		assert.ok(Math.abs(rt.boosterBurnTimer - 60) < 1e-6, `boosterBurnTimer ${rt.boosterBurnTimer}`);
		assert.equal(rocketEntry(save).isBoosterBurnout, false);

		stepFrames(A.bridge, 1800, { recorder: rec });
		const refOrbit = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));
		const burnout = rec.events.find(ev => ev.field === 'isBoosterBurnout' && ev.value === true);
		assert.ok(Math.abs(burnout.t - 105) <= TRIGGER_STEP_TOL_S, `reference SRB burnout at ${burnout.t}`);

		const B = loadInto(save);
		const recB = makeRecorder(A.rocketId);
		recB.prime(B.bridge.ctrl.engine);
		stepFrames(B.bridge, 1800, { recorder: recB });
		assertEventsMatch(rec.events, recB.events, saveT, 'h3_22 SRB');
		const gotOrbit = orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge));
		assertSameOrbit(gotOrbit, refOrbit, 'h3_22 SRB');

		// Jettisoned hardware of the uninterrupted flight: save and reload, sub types must reach the new Worker
		const debrisA = A.bridge.ctrl.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS).map(o => [o.id, o.debrisSubType]);
		assert.ok(debrisA.length >= 3, `debris present (${debrisA.length})`);
		assert.ok(new Set(debrisA.map(d => d[1])).size >= 3, 'several sub types');
		assert.ok(debrisA.every(d => d[1] > 0), 'hardware debris only');
		await A.universe.SaveManager.save();
		const save2 = await lastSave();
		const savedSub = save2.universe.objectManager.filter(o => o.type === OBJECT_TYPES.DEBRIS).map(o => [o.id, o.debrisSubType]);
		assert.deepEqual(savedSub.sort((p, q) => p[0] - q[0]), [...debrisA].sort((p, q) => p[0] - q[0]));
		const C = loadInto(save2);
		const debrisC = C.bridge.ctrl.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS).map(o => [o.id, o.debrisSubType]);
		assert.deepEqual(debrisC.sort((p, q) => p[0] - q[0]), [...debrisA].sort((p, q) => p[0] - q[0]));
	});

	it('Worker 3 frames ahead of the main thread: the reply is ordered after the pending updates (§4.7 protocol)', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		const A = launch({ vehicleId: 'h3_30' });
		stepFrames(A.bridge, 60);
		const mainRocket = A.universe.objects.find(o => o.id === A.rocketId);
		const before3 = mainRocket.telemetry.flightTime;
		stepFrames(A.bridge, 3, { async: true });
		const rA = workerRocket(A.bridge, A.rocketId);
		const workerT = rA.flightComputer.flightTime;
		assert.ok(Math.abs(workerT - before3 - 3 * FRAME_S) < 1e-9, 'Worker is 3 frames ahead');
		assert.equal(mainRocket.telemetry.flightTime, before3, 'main thread has not applied them yet');
		const expected = { x: rA.x, burnTime: rA.burnTime, fuelMass: rA.fuelMass };

		await A.universe.SaveManager.save();
		const save = await lastSave();
		const entry = rocketEntry(save);
		assert.equal(entry.runtimeState.flightComputer.flightTime, workerT);
		assert.equal(mainRocket.telemetry.flightTime, workerT, 'updates applied before the snapshot reply');
		assert.equal(entry.burnTime, expected.burnTime, 'saved kinematics belong to the same frame as the snapshot');
		assert.equal(entry.fuelMass, expected.fuelMass);
		assert.equal(entry.x, UnitConvertUtils.m2pix(expected.x));
	});

	it('Worker that never answers: save completes at RUNTIME_SNAPSHOT_TIMEOUT_MS without runtime state; load runs in the degraded mode', { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
		const A = launch({ vehicleId: 'h3_22' });
		stepFrames(A.bridge, 120);
		const rA = workerRocket(A.bridge, A.rocketId);
		const saveT = rA.flightComputer.flightTime;
		const kin = { stage: rA.currentStageIndex, stageState: rA.stageState, fuelMass: rA.fuelMass, burnTime: rA.burnTime };

		mock.timers.enable({ apis: ['setTimeout'] });
		A.bridge.dropSnapshot = true;
		let done = false;
		const p = A.universe.SaveManager.save().then(() => { done = true; });
		assert.equal(A.bridge.received.filter(m => m.cmd === 'snapshotRuntime').length, 1, 'snapshot requested');
		mock.timers.tick(SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS - 1);
		await flush();
		assert.equal(done, false, 'still waiting 1 ms before the timeout');
		assert.equal(blobs.length, 0);
		mock.timers.tick(1);
		await p;
		assert.equal(blobs.length, 1);
		mock.timers.reset();

		const save = await lastSave();
		const entry = rocketEntry(save);
		assert.strictEqual(entry.restoredRuntimeState, true);
		assert.strictEqual(entry.runtimeState, null);

		const B = loadInto(save);
		const rB = workerRocket(B.bridge, A.rocketId);
		// Kinematic / stage state is restored from the per-frame fields ...
		assert.equal(rB.currentStageIndex, kin.stage);
		assert.equal(rB.stageState, kin.stageState);
		assert.equal(rB.fuelMass, kin.fuelMass);
		assert.equal(rB.burnTime, kin.burnTime);
		assert.equal(rB.isBoosterBurnout, false);
		// ... while FC time, latches, booster timers and the tank-pressure state are initialized (§4.7)
		const rtB = rB.getRuntimeState();
		assert.equal(rtB.flightComputer.flightTime, 0);
		assert.equal(rtB.flightComputer.highestStepIndex, -1);
		assert.deepEqual(rtB.flightComputer.triggeredActionIndices, []);
		assert.equal(rtB.flightComputer.hasPassedMaxQ, false);
		assert.equal(rtB.boosterBurnTimer, 0);
		assert.equal(rtB.boosterSepTimer, 0);
		assert.equal(rtB.presState, 'ROLLOUT_FILL');

		const rec = makeRecorder(A.rocketId);
		rec.prime(B.bridge.ctrl.engine);
		stepFrames(B.bridge, 1800, { recorder: rec });
		// Time rows are re-evaluated from 0 s after the load: row k latches at its own value on the new clock
		const latches = rec.events.filter(ev => ev.field === 'highestStepIndex');
		const profile = TIME_PROFILE();
		assert.deepEqual(latches.map(ev => ev.value), [0, 1, 2, 3, 4, 5, 6]);
		for (const ev of latches) {
			assert.ok(Math.abs(ev.t - profile[ev.value].value) <= TRIGGER_STEP_TOL_S, `row ${ev.value} at FC ${ev.t}`);
		}
		const burnout = rec.events.find(ev => ev.field === 'isBoosterBurnout' && ev.value === true);
		assert.ok(Math.abs(burnout.t - 105) <= TRIGGER_STEP_TOL_S, `SRB burns a full ${burnout.t} s after the load (absolute ${saveT + burnout.t} s)`);
		const rB2 = workerRocket(B.bridge, A.rocketId);
		for (const k of ['x', 'y', 'vx', 'vy', 'mass', 'tankPresFuel', 'tankPresOxid']) {
			assert.ok(Number.isFinite(rB2[k]), `${k} finite after the degraded continuation`);
		}
	});

	it('Worker destroyed while the snapshot is pending: the file is still written without runtime state', { timeout: ASYNC_TEST_TIMEOUT_MS }, async () => {
		const A = launch({ vehicleId: 'h3_30' });
		stepFrames(A.bridge, 20);
		A.bridge.dropSnapshot = true;
		const p = A.universe.SaveManager.save();
		await flush();
		assert.equal(blobs.length, 0);
		A.universe.CalcWorkerManager.destroy();
		await p;
		assert.equal(blobs.length, 1);
		assert.strictEqual(rocketEntry(await lastSave()).runtimeState, null);
		assert.equal(A.bridge.terminated, true);
	});

	// ------------------------------------------------------------------
	// G3-1-01 / G3-1-02: every vehicle preset on a mission it flies, saved in each phase of the flight
	// ------------------------------------------------------------------
	const SAVE_POINTS = {
		pad_pressurized: null, // on the pad, tanks pressurized, engine not ignited (hold-down)
		pad_ignited: null, // on the pad, engine running, hold-down not yet released
		burn1: (r) => r.flightComputer.flightTime >= 100 && r.currentStageIndex === 0,
		booster: (r) => r.isBoosterIgnited && !r.isBoosterBurnout && r.flightComputer.flightTime >= 60,
		booster_sep: (r) => r.hasBoosters && r.isBoosterSeparated && r.currentStageIndex === 0,
		interstage: (r) => r.stageState === 'INTERSTAGE_COAST',
		fairing: (r) => Boolean(r.fairing?.enabled && r.fairing.isSeparated),
		payload_sep: (r) => r.isPayloadSeparated,
		coast: (r) => r.stageState === 'ORBITAL_COAST'
	};
	// [vehicle, payload, mission, save point, frames flown after the save, minimum number of events after the save]
	const CONTINUATION_CASES = [
		['falcon9', 'htv_x', 'iss_rendezvous', 'burn1', 500, 4],
		['falcon9', 'htv_x', 'iss_rendezvous', 'interstage', 200, 2],
		['falcon9', 'htv_x', 'iss_rendezvous', 'fairing', 200, 1],
		['falcon9', 'htv_x', 'iss_rendezvous', 'payload_sep', 200, 0],
		['falcon9', 'earth_obs', 'leo_250km', 'coast', 200, 0],
		['h3_22', 'htv_x', 'iss_rendezvous', 'pad_ignited', 300, 3],
		['h3_22', 'earth_obs', 'leo_250km', 'booster', 200, 3],
		['h3_24', 'earth_obs', 'leo_250km', 'booster_sep', 200, 1],
		['h3_30', 'earth_obs', 'leo_250km', 'pad_pressurized', 300, 4],
		['h3_30', 'earth_obs', 'leo_250km', 'payload_sep', 200, 0],
		['h3_30', 'mmx', 'mars_transfer', 'payload_sep', 200, 0],
		['epsilon', 'asnaro_2', 'leo_250km', 'burn1', 300, 2],
		['ssto', 'earth_obs', 'leo_250km', 'burn1', 300, 1]
	];

	const rolloutOnly = ({ vehicleId, payloadId, missionId }) => {
		const universe = new Universe(createMockElement('canvas'));
		const bridge = PhysicsWorkerBridge.instances[PhysicsWorkerBridge.instances.length - 1];
		const earth = universe.ObjectPlacer.placeAtOrbitAroundSun('Earth') || universe.objects.find(o => o.name === 'Earth');
		universe.RocketLauncher.hostId = earth.id;
		presetManager.applyToLauncher(universe.RocketLauncher, { vehicleId, payloadId, missionId });
		universe.RocketLauncher.rollout();
		const rocket = universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
		universe.LaunchSequencer.rocketId = rocket.id;
		return { universe, bridge, rocketId: rocket.id, seq: universe.LaunchSequencer };
	};
	// Pad saves: the launch commands are issued at the same frames in both flights
	const padContinuation = (point, w) => {
		if (point === 'pad_pressurized') { w.seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START'); stepFrames(w.bridge, 2); }
		if (point === 'pad_pressurized' || point === 'pad_ignited') { w.seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF'); }
	};
	const flyAfterSave = (w, point, rocketId, frames) => {
		const rec = makeRecorder(rocketId);
		rec.prime(w.bridge.ctrl.engine);
		const track = [];
		const onSub = (e) => {
			rec.onSubStep(e);
			const r = e.objects.find(o => o.id === rocketId);
			track.push(r ? [r.x, r.y, r.vx, r.vy, r.flightComputer.flightTime] : null);
		};
		padContinuation(point, w);
		stepFrames(w.bridge, 1, { recorder: { onSubStep: onSub } });
		const afterFirst = captureWorker(w.bridge);
		stepFrames(w.bridge, frames - 1, { recorder: { onSubStep: onSub } });
		return { events: rec.events, track, afterFirst, end: captureWorker(w.bridge) };
	};

	for (const [vehicleId, payloadId, missionId, point, frames, minEvents] of CONTINUATION_CASES) {
		it(`G3-1-01: ${vehicleId} / ${missionId} saved at ${point} continues bit-identically (${frames * FRAME_S} s)`, { timeout: FLIGHT_TEST_TIMEOUT_MS }, async () => {
			Math.random = seededRandom;
			try {
				reseed(7);
				const A = rolloutOnly({ vehicleId, payloadId, missionId });
				A.seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
				stepFrames(A.bridge, 2);
				if (point !== 'pad_pressurized') {
					A.seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
					stepFrames(A.bridge, 2);
				}
				if (SAVE_POINTS[point]) {
					A.seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
					let reached = false;
					for (let f = 0; f < 3000 && !reached; f++) {
						stepFrames(A.bridge, 1);
						reached = SAVE_POINTS[point](workerRocket(A.bridge, A.rocketId));
					}
					assert.ok(reached, `${point} reached`);
				}
				const rA0 = workerRocket(A.bridge, A.rocketId);
				const atSave = { t: rA0.flightComputer.flightTime, stage: rA0.currentStageIndex, stageState: rA0.stageState, isHoldDown: rA0.isHoldDown,
					isIgnited: rA0.isIgnited, isPayloadSeparated: rA0.isPayloadSeparated, isStage2Separated: rA0.isStage2Separated, fairing: rA0.fairing.isSeparated };
				await A.universe.SaveManager.save();
				const save = await lastSave();
				const entry = rocketEntry(save);
				assert.deepEqual(entry.runtimeState, JSON.parse(JSON.stringify(rA0.getRuntimeState())), 'snapshot == Worker state at save time');
				// G3-1-02: the saved flags are the flight's, not the defaults
				for (const k of ['isHoldDown', 'isIgnited', 'isPayloadSeparated', 'isStage2Separated']) {
					assert.strictEqual(entry[k], atSave[k], `saved ${k}`);
				}
				if (point.startsWith('pad')) { assert.strictEqual(entry.isHoldDown, true, 'saved on the pad'); }
				if (point === 'payload_sep') { assert.strictEqual(entry.isPayloadSeparated, true, 'saved after payload separation'); }
				for (const o of save.universe.objectManager) {
					assert.ok(o.runtimeState && Number.isFinite(o.runtimeState.kinematics?.x), `${o.type}:${o.id} carries its exact kinematics`);
				}
				reseed(11);
				const ref = flyAfterSave(A, point, A.rocketId, frames);
				const refOrbit = orbitOf(workerRocket(A.bridge, A.rocketId), workerEarth(A.bridge));

				const B = loadInto(save);
				B.universe.LaunchSequencer.rocketId = A.rocketId;
				B.seq = B.universe.LaunchSequencer;
				const rB0 = workerRocket(B.bridge, A.rocketId);
				for (const [k, v] of Object.entries(atSave)) {
					assert.strictEqual(k === 'fairing' ? rB0.fairing.isSeparated : (k === 't' ? rB0.flightComputer.flightTime : (k === 'stage' ? rB0.currentStageIndex : rB0[k])), v, `reloaded ${k}`);
				}
				assert.deepEqual(JSON.parse(JSON.stringify(rB0.getRuntimeState())), entry.runtimeState, 'Worker runtime state restored exactly');
				reseed(11);
				const got = flyAfterSave(B, point, A.rocketId, frames);

				assert.ok(ref.events.length >= minEvents, `the continuation exercises the flight (${ref.events.length} events)`);
				assertEventsMatch(ref.events, got.events, -Infinity, `${vehicleId} ${point}`, minEvents);
				assert.equal(got.track.length, ref.track.length);
				for (let i = 0; i < ref.track.length; i++) {
					if (!ref.track[i] || !got.track[i] || !ref.track[i].every((v, j) => Object.is(v, got.track[i][j]))) {
						assert.deepStrictEqual(got.track[i], ref.track[i], `rocket x, y, vx, vy, flight time at sub-step ${i + 1}`);
					}
				}
				const rocketKey = `${OBJECT_TYPES.ROCKET}:${A.rocketId}`;
				assertSameWorkerState(ref.afterFirst, got.afterFirst, rocketKey, `${point}, first frame`);
				assertSameWorkerState(ref.end, got.end, rocketKey, `${point}, ${frames * FRAME_S} s later`);
				assertSameOrbit(orbitOf(workerRocket(B.bridge, A.rocketId), workerEarth(B.bridge)), refOrbit, `${vehicleId} ${point}`);
			} finally {
				Math.random = realRandom;
			}
		});
	}

	it('old-format (main) save loads as a non-restored single-stage vehicle and keeps flying', () => {
		const A = launch({ vehicleId: 'h3_30', profile: null });
		stepFrames(A.bridge, 60);
		const modern = A.universe.getState(null);
		const mainKeys = ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'color', 'size', 'radius', 'generation', 'borderColor', 'borderWidth'];
		const rocketKeys = ['dryMass', 'fuelMass', 'oxidMass', 'ofRatio', 'thrustForce', 'burnTime', 'thrustAngle', 'flightProfile', 'massLossRate', 'maxGLimit'];
		const old = {
			version: 2,
			universe: {
				centerObjectId: modern.centerObjectId,
				cameraOffset: modern.cameraOffset,
				objectManager: modern.objectManager.map((o) => {
					const keys = o.type === OBJECT_TYPES.ROCKET ? [...mainKeys, ...rocketKeys] : [...mainKeys, 'mass'];
					return Object.fromEntries(keys.map(k => [k, o[k]]));
				})
			}
		};
		const oldRocket = rocketEntry(old);
		assert.equal(Object.prototype.hasOwnProperty.call(oldRocket, 'restoredRuntimeState'), false);

		const B = loadInto(old);
		const add = B.bridge.received.find(m => m.cmd === 'add' && m.id === A.rocketId);
		assert.strictEqual(add.restoredRuntimeState, false);
		assert.strictEqual(add.runtimeState, null);
		const rB = workerRocket(B.bridge, A.rocketId);
		assert.equal(rB.totalStages, 1, 'legacy single-stage conversion (main behaviour)');
		assert.equal(rB.currentStageIndex, 0);
		assert.equal(rB.dryMass, oldRocket.dryMass);
		assert.equal(rB.fuelMass, oldRocket.fuelMass);
		assert.equal(rB.oxidMass, oldRocket.oxidMass);
		assert.equal(rB.burnTime, oldRocket.burnTime);
		assert.equal(rB.thrustForce, oldRocket.thrustForce);
		assert.equal(rB.stageState, 'STG_BURNING');
		assert.equal(rB.flightComputer.flightTime, 0);
		const burn0 = rB.burnTime;
		stepFrames(B.bridge, 20);
		const rB2 = workerRocket(B.bridge, A.rocketId);
		assert.equal(rB2.stageState, 'STG_BURNING');
		assert.ok(rB2.burnTime < burn0, 'propellant is consumed');
		assert.ok(Math.abs(rB2.flightComputer.flightTime - 20 * FRAME_S) < 1e-9);
		assert.ok(['x', 'y', 'vx', 'vy'].every(k => Number.isFinite(rB2[k])));
		assert.equal(rB2.collided, false);
	});
});
