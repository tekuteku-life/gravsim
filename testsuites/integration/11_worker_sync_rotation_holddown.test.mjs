/**
 * Integration Test Suite 11: Worker synchronization of the rotation SSOT, hold-down over sub-steps,
 * two-pass commit order and actual-flight-path recording in a synchronous (GEO) orbit (work unit A).
 *
 * Real modules wired together like the application does:
 *   ObjectManager.addObject / updateObject / updateRocketState --(structured clone)--> SimulationController.handleMessage
 *   PhysicsEngine (_moveObjects sub-steps, or the real SimulationController.update with adaptive sub-steps)
 *   WorkerBridge.formatWorkerToMain --(transferred buffer)--> ObjectManager.updateObjectParams --> Rocket / CelestialBody
 *   'returnBuffer' --> WorkerBridge pool (the same ArrayBuffer is reused by the next frame)
 *
 * Expected values come from docs/design/2026-11-20_trajectory_fx_flightplan.md §3.1.1 (incl. Rev 6.10: single spin-rate
 * source, held rockets not integrated, updateObject omits a non-finite angle, slot 48 mach fallback), §4.8 and §4.10
 * (see the test plan docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-A).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM } from '../test_helpers.mjs';

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import {
	PHYSICS, SIMULATION, OBJECT_TYPES, OBJECT_STATE, BUFFER_INDEX, CALC_BUFFER_CONFIG, RENDER, MULTISTAGE_ROCKET,
	STAGE_STATE_TO_CODE
} from '../../scripts/gravsim_const.js';

setupMockDOM();

const TWO_PI = 2 * Math.PI;
const ATTR = CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;
const m2p = UnitConvertUtils.m2pix;
const p2m = UnitConvertUtils.pix2m;
const AU_PX = m2p(PHYSICS.METERS_PER_AU);
const EARTH = presetManager.getObjectParam('Earth');
const SUN = presetManager.getObjectParam('Sun');
const MARS = presetManager.getObjectParam('Mars');
const VENUS = presetManager.getObjectParam('Venus');
const OMEGA_E = TWO_PI / EARTH.ROTATION_PERIOD;
const GM_E = PHYSICS.G * UnitConvertUtils.ton2kg(EARTH.MASS);
const V_EARTH_ORBIT = 29780; // m/s

/**
 * Main thread <-> Worker harness. Messages to the Worker are structured-cloned (as postMessage does);
 * the update buffer goes back through 'returnBuffer' into the WorkerBridge pool.
 */
const createWorld = () => {
	WorkerBridge._bufferPool.length = 0;
	const ctrl = new SimulationController();
	const toWorkerLog = [];
	const toWorker = (m) => {
		toWorkerLog.push(m.cmd);
		ctrl.handleMessage({ data: m.cmd === 'returnBuffer' ? m : structuredClone(m) });
	};
	const om = new ObjectManager(null, { postMessage: toWorker });
	toWorker({ cmd: 'initDefinitions', celestialParams: presetManager.getObjectParamsMap() });
	const world = {
		ctrl, engine: ctrl.engine, om, toWorker, toWorkerLog,
		lastMsg: null, lastSlots: null,
		deliver(msg) {
			world.lastMsg = msg;
			world.lastSlots = new Float64Array(msg.objectsData, 0, msg.validLength).slice();
			om.updateObjectParams(msg);
			return msg;
		},
		/** One Worker frame with an explicit sub-step count (same order as SimulationController.update). */
		frame(totalDt, subSteps) {
			const e = ctrl.engine;
			e._categorizeBodies();
			e._buildQuadTree(totalDt);
			e._checkCollisions(totalDt);
			e._checkRocheLimit();
			const dt = totalDt / subSteps;
			for (let i = 0; i < subSteps; i++) { e._moveObjects(dt); }
			e._updateEscapeStatus();
			const buffer = WorkerBridge.formatWorkerToMain(e.objects);
			const msg = { cmd: 'update', deltaTime: dt, subSteps, objectsData: buffer.buffer, validLength: buffer.length };
			e.removeDeadObjects();
			return world.deliver(msg);
		},
		/** One real SimulationController.update() frame (adaptive sub-steps) with a deterministic clock. */
		controllerFrame(elapsedMs) {
			const realNow = Date.now;
			const hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
			const prevSelf = globalThis.self;
			let posted = null;
			try {
				const t0 = 1.7e12;
				ctrl.lastTime = t0;
				Date.now = () => t0 + elapsedMs;
				globalThis.self = { postMessage: (m) => { posted = m; } };
				ctrl.update();
			} finally {
				Date.now = realNow;
				if (hadSelf) { globalThis.self = prevSelf; } else { delete globalThis.self; }
			}
			assert.ok(posted && posted.cmd === 'update', 'controller posted an update frame');
			return world.deliver(posted);
		},
		/** Format and deliver the current Worker state without stepping (a frame of zero length). */
		publish() {
			const buffer = WorkerBridge.formatWorkerToMain(ctrl.engine.objects);
			return world.deliver({ cmd: 'update', deltaTime: 0, subSteps: 0, objectsData: buffer.buffer, validLength: buffer.length });
		},
		engineObj: (id) => ctrl.engine.objects.find((o) => o.id === id)
	};
	return world;
};

/** Main-thread celestial body built from a preset (mass in t, radius in m, positions in px). */
const makeBody = (id, preset, xPx, yPx, vxPx = 0, vyPx = 0, rot = 0) => {
	const b = new CelestialBody(id, preset.NAME, xPx, yPx, vxPx, vyPx, preset.MASS, preset.COLOR || '#888888', 5, preset.RADIUS, 0);
	b.param = preset;
	b.rotationAngle = rot;
	return b;
};

/** Held rocket placed on the pad exactly as RocketLauncher does (host velocity + surface rotation velocity). */
const makeHeldRocket = (id, host, theta0, { hostAltM = 1, bottomOffsetM = 31.5, thrustForce = 1.8e6 } = {}) => {
	const r = host.radius + bottomOffsetM + hostAltM;
	const dx = m2p(r * Math.cos(theta0));
	const dy = m2p(r * Math.sin(theta0));
	const rocket = new Rocket(id, 'Rocket', host.x + dx, host.y + dy, host.vx - OMEGA_E * dy, host.vy + OMEGA_E * dx, 20, 30, 70, '#ffffff', 2, bottomOffsetM, 0);
	Object.assign(rocket, {
		hostId: host.id, hostAngleRad: theta0, hostAltM, bottomOffsetM, isHoldDown: true, isIgnited: true,
		thrustForce, burnTime: 100, ofRatio: 70 / 30
	});
	return { rocket, r };
};

/** Coasting satellite on a circular orbit of radius rM around host (no propellant, staging disabled). */
const makeOrbiter = (id, host, rM, phase, gm) => {
	const v = Math.sqrt(gm / rM);
	const sat = new Rocket(id, 'Rocket', host.x + m2p(rM * Math.cos(phase)), host.y + m2p(rM * Math.sin(phase)),
		host.vx - m2p(v * Math.sin(phase)), host.vy + m2p(v * Math.cos(phase)), 1, 0, 0, '#ffffff', 2, 2, 0);
	Object.assign(sat, { hostId: host.id, isHoldDown: false, isIgnited: false, burnTime: 0, disableStaging: true });
	return sat;
};

const slot = (slots, index, key) => slots[index * ATTR + BUFFER_INDEX[key]];

// ===========================================================================
describe('Integration 11-1: rotation angle SSOT across ObjectManager, Worker and WorkerBridge', () => {
	let origDebug;
	beforeEach(() => {
		EventBus.clearAll();
		origDebug = console.debug;
		console.debug = () => {};
	});
	afterEach(() => {
		console.debug = origDebug;
		EventBus.clearAll();
	});

	it('the Worker alone integrates every body; the main thread mirrors it bit-for-bit for 1..40 sub-steps', () => {
		const w = createWorld();
		const sun = makeBody(1, SUN, 0, 0);
		const earth = makeBody(2, EARTH, AU_PX, 0, 0, m2p(V_EARTH_ORBIT), 0.25);
		const mars = makeBody(3, MARS, 0, -1.52 * AU_PX, m2p(24070), 0, -1.0);
		for (const b of [sun, earth, mars]) { w.om.addObject(b); }
		const sat = makeOrbiter(4, earth, 7.0e6, 0.3, GM_E);
		w.om.addObject(sat);
		assert.equal(w.engineObj(2).rotationAngle, 0.25, 'initial angle sent with the add message');
		assert.equal(w.engineObj(3).rotationAngle, -1.0);

		const omegaM = TWO_PI / MARS.ROTATION_PERIOD;
		let t = 0;
		for (const n of [1, 7, 40, 3, 20]) {
			w.frame(60, n);
			t += 60;
			for (const b of [sun, earth, mars]) {
				assert.equal(b.rotationAngle, w.engineObj(b.id).rotationAngle, `${b.name}: main mirrors the Worker after n=${n}`);
			}
			assert.ok(Math.abs(earth.rotationAngle - (0.25 + OMEGA_E * t)) <= 1e-12, `Earth after t=${t}`);
			assert.ok(Math.abs(mars.rotationAngle - (-1.0 + omegaM * t)) <= 1e-12, `Mars after t=${t}`);
			assert.equal(sun.rotationAngle, 0, 'Sun has no rotation period');
			assert.equal(sat.rotationAngle, 0, 'rockets carry no rotation angle');
			assert.equal(slot(w.lastSlots, 3, 'ROTATION_ANGLE'), 0, 'rocket slot 47 is 0');
		}
	});

	it('a non-finite main-thread angle is not sent by updateObject: the Worker keeps integrating and the main thread recovers (Rev 6.10)', () => {
		const w = createWorld();
		const earth = makeBody(2, EARTH, 0, 0, 0, 0, 0.5);
		w.om.addObject(earth);
		w.frame(60, 20);
		const workerAngle = w.engineObj(2).rotationAngle;
		for (const bad of [NaN, Infinity, undefined]) {
			earth.rotationAngle = bad;
			w.om.updateObject(earth);
			assert.equal(w.toWorkerLog[w.toWorkerLog.length - 1], 'update', 'the position update is still sent');
			assert.equal(w.engineObj(2).rotationAngle, workerAngle, `Worker angle kept for ${String(bad)}`);
		}
		w.frame(60, 20);
		assert.ok(Math.abs(earth.rotationAngle - (0.5 + OMEGA_E * 120)) <= 1e-12, 'main thread takes the Worker angle again');
		assert.equal(earth.rotationAngle, w.engineObj(2).rotationAngle);
	});

	it('ObjectManager.updateObject re-seeds the Worker angle and the Worker continues from it; a NaN angle on add starts at 0', () => {
		const w = createWorld();
		const earth = makeBody(2, EARTH, 0, 0, 0, 0, 0.5);
		w.om.addObject(earth);
		w.frame(60, 20);
		assert.ok(Math.abs(earth.rotationAngle - (0.5 + OMEGA_E * 60)) <= 1e-12);

		earth.rotationAngle = 2.0;
		w.om.updateObject(earth);
		assert.equal(w.toWorkerLog[w.toWorkerLog.length - 1], 'update');
		assert.equal(w.engineObj(2).rotationAngle, 2.0);
		w.frame(60, 20);
		assert.ok(Math.abs(earth.rotationAngle - (2.0 + OMEGA_E * 60)) <= 1e-12);

		const venus = makeBody(5, VENUS, 10 * AU_PX, 0, 0, 0, NaN);
		w.om.addObject(venus);
		assert.equal(w.engineObj(5).rotationAngle, 0, 'non-finite main angle is sent as 0');
		w.frame(60, 20);
		assert.ok(Math.abs(venus.rotationAngle - (TWO_PI / VENUS.ROTATION_PERIOD) * 60) <= 1e-15);
		assert.ok(Number.isFinite(venus.rotationAngle));
	});

	it('real SimulationController.update frames (adaptive sub-steps): rotation equals ω·Σ(deltaTime·subSteps)', () => {
		const w = createWorld();
		const earth = makeBody(2, EARTH, 0, 0, 0, 0, 0.1);
		w.om.addObject(earth);
		w.om.addObject(makeOrbiter(4, earth, 6.9e6, 0, GM_E));
		const perFrameS = 60;
		w.toWorker({ cmd: 'setTimeScale', timeScale: perFrameS / (16 * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) });
		let simulated = 0;
		for (let i = 0; i < 6; i++) {
			const msg = w.controllerFrame(16);
			const frameS = msg.deltaTime * msg.subSteps;
			simulated += frameS;
			assert.ok(Math.abs(frameS - perFrameS) <= 1e-9, `frame ${i}: ${msg.subSteps} sub-steps cover ${frameS} s`);
			assert.ok(msg.subSteps >= SIMULATION.SUB_STEPS.MIN && msg.subSteps <= SIMULATION.SUB_STEPS.MAX);
			assert.equal(earth.rotationAngle, w.engineObj(2).rotationAngle, `frame ${i}: main mirrors the Worker`);
			assert.ok(Math.abs(earth.rotationAngle - (0.1 + OMEGA_E * simulated)) <= 1e-12, `frame ${i}: rotation = ω·t`);
		}
	});
});

// ===========================================================================
describe('Integration 11-2: hold-down synchronization over sub-steps and liftoff', () => {
	let origDebug;
	let origInfo;
	beforeEach(() => {
		EventBus.clearAll();
		origDebug = console.debug;
		origInfo = console.info;
		console.debug = () => {};
		console.info = () => {};
	});
	afterEach(() => {
		console.debug = origDebug;
		console.info = origInfo;
		EventBus.clearAll();
	});

	const THETA0 = 1.0;
	const ROT0 = 0.25;

	/**
	 * Sun + moving Earth (host accelerates, so the end-of-step velocity re-sync matters) + held rocket, then a first frame
	 * of firstFrameS (one sub-step; 0 = none). The default is a short real-time frame (the app forces the minimum time
	 * scale for launch setup). A freshly added rocket still carries its add-time gravity acceleration, which the Worker's
	 * per-frame collision look-ahead extrapolates into the pad over a long frame; a held rocket never collides with its
	 * host (§3.1.1-2), so the first frame may have any length.
	 */
	const setup = (opts, firstFrameS = 0.02) => {
		const w = createWorld();
		const sun = makeBody(1, SUN, 0, 0);
		const earth = makeBody(2, EARTH, AU_PX, 0, 0, m2p(V_EARTH_ORBIT), ROT0);
		w.om.addObject(sun);
		w.om.addObject(earth);
		const { rocket, r } = makeHeldRocket(3, earth, THETA0, opts);
		w.om.addObject(rocket);
		if (firstFrameS > 0) {
			w.frame(firstFrameS, 1);
			assert.equal(rocket.state, OBJECT_STATE.ACTIVE, `the rocket survives a first pad frame of ${firstFrameS} s`);
		}
		return { w, earth, rocket, r, elapsed: Math.max(0, firstFrameS) };
	};

	const assertOnPad = (s, label) => {
		const { w, earth, rocket, r } = s;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const theta = Math.atan2(relY, relX);
		assert.ok(Math.abs(p2m(Math.hypot(relX, relY)) - r) <= 1e-3, `${label}: pad radius`);
		assert.ok(Math.abs((theta - earth.rotationAngle) - (THETA0 - ROT0)) <= 1e-9, `${label}: pad fixed to the rotating surface`);
		const dvx = p2m(rocket.vx - earth.vx);
		const dvy = p2m(rocket.vy - earth.vy);
		assert.ok(Math.abs(dvx - (-OMEGA_E * r * Math.sin(theta))) <= 1e-6, `${label}: relative vx = -ω r sinθ`);
		assert.ok(Math.abs(dvy - (OMEGA_E * r * Math.cos(theta))) <= 1e-6, `${label}: relative vy = ω r cosθ`);
		const er = w.engineObj(3);
		assert.ok(Math.abs(er.hostAngleRad - (THETA0 + OMEGA_E * s.elapsed)) <= 1e-12, `${label}: Worker pad angle θ0 + ω t`);
		assert.equal(rocket.isHoldDown, true);
		assert.equal(rocket.actualFlightPath.length, 0, `${label}: nothing recorded while held`);
	};

	it('keeps the held rocket on the rotating pad for explicit 1 / 7 / 40 sub-step frames', () => {
		const s = setup();
		for (const n of [1, 7, 40, 2, 13]) {
			s.w.frame(60, n);
			s.elapsed += 60;
			assertOnPad(s, `n=${n}`);
		}
		assert.equal(s.rocket.telemetry.flightTime, 0, 'flight clock does not run on the pad');
	});

	it('a long first frame after the add keeps the held rocket on the pad (no collision with its host, §3.1.1-2)', () => {
		// hostAltM 1 m: a free fall from rest on the pad reaches the surface after sqrt(2 h / (g - ω² r)) ≈ 0.45 s, so the
		// look-ahead samples (frame × i / CALC_EXPAND_DIV_NUM) of these frames lie inside the host for the add-time gravity
		for (const firstFrameS of [0.5, 60, 3600]) {
			const s = setup(undefined, firstFrameS);
			assertOnPad(s, `first frame ${firstFrameS} s`);
			s.w.frame(60, 7);
			s.elapsed += 60;
			assertOnPad(s, `60 s after a first frame of ${firstFrameS} s`);
		}
		// The same with the real SimulationController.update (adaptive sub-steps) as the first frame: 600 s in 16 ms
		const s = setup(undefined, 0);
		s.w.toWorker({ cmd: 'setTimeScale', timeScale: 600 / (16 * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) });
		const msg = s.w.controllerFrame(16);
		s.elapsed += msg.deltaTime * msg.subSteps;
		assert.equal(s.rocket.state, OBJECT_STATE.ACTIVE, 'the rocket survives a first controller frame of 600 s');
		assertOnPad(s, `first controller frame (${msg.subSteps} sub-steps)`);
	});

	it('the Worker flight computer of the held rocket sees the pad synchronized to the advanced host on every sub-step', () => {
		// §3.1.1-2: the hold-down sync runs right after the position half-step, i.e. before flight control, so the
		// sensors of a held rocket read host + r(cosθ, sinθ) for the host position of the same sub-step.
		const s = setup();
		const { w, r } = s;
		const workerRocket = w.engineObj(3);
		const workerEarth = w.engineObj(2);
		const seen = [];
		const flightControl = workerRocket.flightControl;
		workerRocket.flightControl = function (...args) {
			seen.push({ dx: this.x - workerEarth.x, dy: this.y - workerEarth.y, th: this.hostAngleRad, rot: workerEarth.rotationAngle, ref: args[1], dist: args[2] });
			return flightControl.apply(this, args);
		};
		const n = 7;
		w.frame(60, n);
		assert.equal(seen.length, n, 'flight control once per sub-step');
		seen.forEach((v, k) => {
			const th = THETA0 + OMEGA_E * (s.elapsed + (k + 1) * (60 / n));
			assert.ok(Math.abs(v.th - th) <= 1e-12, `sub-step ${k}: pad angle θ0 + ω t`);
			assert.ok(Math.abs((v.th - v.rot) - (THETA0 - ROT0)) <= 1e-12, `sub-step ${k}: pad fixed to the rotating surface`);
			// 1e-3 m: rounding of two coordinates near 1 AU (ulp ~3e-5 m); a sync before the host moved is off by ~v·dt ~ 255 km
			assert.ok(Math.abs(v.dx - r * Math.cos(v.th)) <= 1e-3, `sub-step ${k}: x offset from the current host position`);
			assert.ok(Math.abs(v.dy - r * Math.sin(v.th)) <= 1e-3, `sub-step ${k}: y offset from the current host position`);
			assert.equal(v.ref, workerEarth, `sub-step ${k}: the host is the reference body handed to flight control`);
			assert.ok(Math.abs(v.dist - r) <= 1e-9, `sub-step ${k}: distance to the host handed to flight control`);
		});
	});

	it('keeps the held rocket on the rotating pad for real SimulationController.update frames (adaptive sub-steps)', () => {
		const s = setup();
		s.w.toWorker({ cmd: 'setTimeScale', timeScale: 60 / (16 * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) });
		for (const ms of [16, 8, 16, 33]) {
			const msg = s.w.controllerFrame(ms);
			s.elapsed += msg.deltaTime * msg.subSteps;
			assertOnPad(s, `controller frame ${ms} ms (${msg.subSteps} sub-steps)`);
		}
	});

	it('after release the pad effect follows the Worker rotation and the rocket climbs freely and starts its actual path', () => {
		const s = setup();
		const { w, earth, rocket } = s;
		const pad = new PadEffectRenderer();
		pad.start(3, 2);
		const ctx = () => ({ rocket, host: earth, m2pix: m2p, zoomScale: 1 });
		for (let i = 0; i < 3; i++) {
			w.frame(30, 10);
			s.elapsed += 30;
			pad.update(0.016, ctx());
		}
		const padAngleOnSurface = Math.atan2(pad.startRelPadY, pad.startRelPadX) - earth.rotationAngle;
		const padRadius = Math.hypot(pad.startRelPadX, pad.startRelPadY);
		assert.ok(Math.abs(padAngleOnSurface - (THETA0 - ROT0)) <= 1e-9, 'pad captured at the launch site');
		const releasedAngle = w.engineObj(3).hostAngleRad;

		w.toWorker({ cmd: 'rocketCommand', id: 3, command: 'RELEASE_HOLD_DOWN' });
		EventBus.emit('rocket:update-state', 3, true, false);
		assert.equal(w.engineObj(3).isHoldDown, false, 'Worker released by setRocketState / RELEASE_HOLD_DOWN');

		let prevDist = Math.hypot(rocket.x - earth.x, rocket.y - earth.y);
		let prevFlightTime = 0;
		const flown = [];
		for (let i = 0; i < 10; i++) {
			const rotBefore = earth.rotationAngle;
			w.frame(1, 20);
			pad.update(0.016, ctx()); // render dt differs from the simulated frame time (time warp)
			assert.ok(earth.rotationAngle > rotBefore, 'host keeps rotating');
			const onSurface = Math.atan2(pad.startRelPadY, pad.startRelPadX) - earth.rotationAngle;
			assert.ok(Math.abs(onSurface - padAngleOnSurface) <= 1e-9, `frame ${i}: pad stays on the launch site`);
			assert.ok(Math.abs(Math.hypot(pad.startRelPadX, pad.startRelPadY) - padRadius) <= padRadius * 1e-12);
			assert.equal(pad.padRefRotationAngle, earth.rotationAngle);
			assert.equal(w.engineObj(3).hostAngleRad, releasedAngle, 'pad angle no longer advanced in the Worker');
			const dist = Math.hypot(rocket.x - earth.x, rocket.y - earth.y);
			assert.ok(dist > prevDist, `frame ${i}: climbing`);
			prevDist = dist;
			assert.equal(rocket.isHoldDown, false);
			assert.equal(rocket.mach, w.engineObj(3).mach, `frame ${i}: slot 48 carries the Worker mach`);
			assert.equal(rocket.telemetry.mach, rocket.mach);
			assert.ok(rocket.telemetry.flightTime > prevFlightTime);
			prevFlightTime = rocket.telemetry.flightTime;
			const relX = rocket.x - earth.x;
			const relY = rocket.y - earth.y;
			flown.push({ t: rocket.telemetry.flightTime, relX, relY, r: Math.hypot(relX, relY), phiSurf: Math.atan2(relY, relX) - earth.rotationAngle });
		}
		assert.ok(Math.abs(flown[0].t - 1) <= 1e-12, 'flight clock starts at release');
		// Oracle for the design rule (no frame switch => host-fixed displacement >= ACTUAL_SAMPLE_MIN_DIST_M from the last kept point)
		const expected = [];
		for (const f of flown) {
			const last = expected[expected.length - 1];
			if (!last || p2m(Math.hypot(f.r * Math.cos(f.phiSurf) - last.r * Math.cos(last.phiSurf), f.r * Math.sin(f.phiSurf) - last.r * Math.sin(last.phiSurf))) >= RENDER.PREDICTED_TRAJECTORY.ACTUAL_SAMPLE_MIN_DIST_M) {
				expected.push(f);
			}
		}
		assert.ok(rocket.mach > 0, `the climbing rocket moves relative to the air (Mach ${rocket.mach})`);
		const path = rocket.actualFlightPath;
		assert.ok(expected.length >= 3, `precondition: the climb produces several samples (${expected.length})`);
		assert.deepEqual(path.map((p) => p.time), expected.map((f) => f.t), 'recorded exactly at the rule-selected frames');
		assert.deepEqual(path.map((p) => [p.relX, p.relY]), expected.map((f) => [f.relX, f.relY]));
	});
});

// ===========================================================================
describe('Integration 11-2b: single spin-rate source and pinned held rockets through the Worker pipeline (Rev 6.10)', () => {
	let origDebug;
	let origInfo;
	beforeEach(() => {
		EventBus.clearAll();
		origDebug = console.debug;
		origInfo = console.info;
		console.debug = () => {};
		console.info = () => {};
	});
	afterEach(() => {
		console.debug = origDebug;
		console.info = origInfo;
		EventBus.clearAll();
	});

	const THETA0 = -0.4;
	/** Custom airless body (unknown to the presets) with a held rocket on it. */
	const setupCustom = (param) => {
		const w = createWorld();
		const host = new CelestialBody(7, 'UnitCustomWorld', 0, 0, 0, 0, 5.0e21, '#aaaaaa', 5, 3.0e6, 0);
		host.param = param;
		host.rotationAngle = 0.1;
		w.om.addObject(host);
		const rM = 3.0e6 + 10 + 1;
		const rocket = new Rocket(8, 'Rocket', m2p(rM * Math.cos(THETA0)), m2p(rM * Math.sin(THETA0)), 0, 0, 20, 30, 70, '#ffffff', 2, 10, 0);
		Object.assign(rocket, { hostId: 7, hostAngleRad: THETA0, hostAltM: 1, bottomOffsetM: 10, isHoldDown: true, isIgnited: false, burnTime: 100, ofRatio: 70 / 30 });
		w.om.addObject(rocket);
		w.frame(0.02, 1);
		assert.equal(rocket.state, OBJECT_STATE.ACTIVE, 'precondition: rocket survives the first pad frame');
		return { w, host, rocket, rM };
	};
	const surfaceAngle = (s) => Math.atan2(s.rocket.y - s.host.y, s.rocket.x - s.host.x) - s.host.rotationAngle;

	it('a period delivered to the Worker as rotationPeriod rotates the body and the pad together', () => {
		const s = setupCustom(null);
		assert.equal(s.w.engineObj(7).param, null, 'precondition: no param anywhere for this body');
		assert.equal(s.host.rotationAngle, 0.1, 'no rotation before a period is known');
		const e = s.w.engineObj(7);
		s.w.toWorker({ cmd: 'update', id: 7, x: e.x, y: e.y, vx: e.vx, vy: e.vy, ax: e.ax, ay: e.ay, rotationPeriod: 2000 });
		const omega = TWO_PI / 2000;
		let t = 0;
		for (const n of [1, 9, 40]) {
			s.w.frame(50, n);
			t += 50;
			assert.ok(Math.abs(s.host.rotationAngle - (0.1 + omega * t)) <= 1e-12, `n=${n}: body angle`);
			assert.ok(Math.abs(surfaceAngle(s) - (THETA0 - 0.1)) <= 1e-9, `n=${n}: pad fixed to the rotating surface`);
			const dvy = p2m(s.rocket.vy - s.host.vy);
			const theta = surfaceAngle(s) + s.host.rotationAngle;
			assert.ok(Math.abs(dvy - omega * s.rM * Math.cos(theta)) <= 1e-6, `n=${n}: surface velocity ω r cosθ`);
		}
	});

	for (const [label, param] of [['period 1e-6', { ROTATION_PERIOD: 1e-6 }], ['numeric-string period', { ROTATION_PERIOD: '2000' }], ['NaN period', { ROTATION_PERIOD: NaN }]]) {
		it(`${label}: neither the body nor the pad rotates`, () => {
			const s = setupCustom(param);
			for (let i = 0; i < 4; i++) {
				s.w.frame(50, 10);
				assert.equal(s.host.rotationAngle, 0.1, 'body angle unchanged');
				assert.ok(Math.abs(surfaceAngle(s) - (THETA0 - 0.1)) <= 1e-9, 'pad unchanged');
				assert.equal(s.w.engineObj(8).hostAngleRad, THETA0, 'Worker pad angle unchanged');
				assert.ok(Math.abs(p2m(Math.hypot(s.rocket.vx - s.host.vx, s.rocket.vy - s.host.vy))) <= 1e-9, 'no surface velocity');
			}
		});
	}

	// Design §4.14-7 (a regression of this branch, fixed): a held rocket is pinned only while its host exists. This test
	// asserted the frozen rocket before ("stays pinned, position and velocity not integrated"); main integrated it
	it('missing target: a held rocket whose host was removed is a free body again (integrated: no other body, so it keeps its velocity), its pad angle unchanged', () => {
		const s = setupCustom({ ROTATION_PERIOD: 1000 });
		s.w.frame(10, 5);
		s.w.om.removeObject(s.host);
		assert.equal(s.w.engineObj(7), undefined, 'host removed from the Worker');
		const before = { x: s.rocket.x, y: s.rocket.y, vx: s.rocket.vx, vy: s.rocket.vy };
		assert.ok(p2m(Math.hypot(before.vx, before.vy)) > 1000, 'input: the pad velocity of the spinning host (ω r)');
		const er = s.w.engineObj(8);
		const angle = er.hostAngleRad;
		let elapsed = 0;
		for (const n of [1, 20]) {
			s.w.frame(30, n);
			elapsed += 30;
			assert.deepEqual({ vx: s.rocket.vx, vy: s.rocket.vy }, { vx: before.vx, vy: before.vy }, `n=${n}: no force, the velocity stays`);
			assert.ok(Math.abs(p2m(s.rocket.x - (before.x + before.vx * elapsed))) <= 1e-6, `n=${n}: x moves by vx t`);
			assert.ok(Math.abs(p2m(s.rocket.y - (before.y + before.vy * elapsed))) <= 1e-6, `n=${n}: y moves by vy t`);
			assert.equal(er.hostAngleRad, angle, 'no pad to follow');
			assert.equal(s.rocket.state, OBJECT_STATE.ACTIVE);
		}
	});

	it('slot 48 fallback through the pipeline: without a numeric Worker mach the flight-computer telemetry mach reaches the main thread', () => {
		const s = setupCustom(null);
		const er = s.w.engineObj(8);
		er.mach = 0.37;
		er.flightComputer.telemetryCache.mach = 0.91;
		s.w.publish();
		assert.equal(s.rocket.mach, 0.37, 'own mach first');
		er.mach = undefined;
		s.w.publish();
		assert.equal(s.rocket.mach, 0.91, 'then the telemetry cache');
		assert.equal(s.rocket.telemetry.mach, 0.91);
		er.flightComputer.telemetryCache.mach = undefined;
		s.w.publish();
		assert.equal(s.rocket.mach, 0, 'then 0');
	});
});

// ===========================================================================
describe('Integration 11-3: two-pass commit with the real engine and a reused transfer buffer', () => {
	let origDebug;
	beforeEach(() => {
		EventBus.clearAll();
		origDebug = console.debug;
		console.debug = () => {};
	});
	afterEach(() => {
		console.debug = origDebug;
		EventBus.clearAll();
	});

	it('records history against the same-epoch host although the host follows the rocket in the buffer; destruction runs last', () => {
		const w = createWorld();
		const earthMain = makeBody(3, EARTH, AU_PX, 0, 0, m2p(V_EARTH_ORBIT), 0.4);
		// Buffer order = Worker order = add order: crasher, satellite, Earth.
		const crasher = new Rocket(1, 'Crasher', earthMain.x + m2p(1.0e6), earthMain.y, earthMain.vx, earthMain.vy, 5, 0, 0, '#ff0000', 2, 10, 0);
		Object.assign(crasher, { hostId: 3, isHoldDown: false, isIgnited: false, burnTime: 0, disableStaging: true });
		crasher.actualFlightPath = [{ relX: 0, relY: 0, r: 0, phiSurf: 0, time: 0 }];
		const sat = makeOrbiter(2, earthMain, 7.0e6, 0.8, GM_E);
		sat.predictedTrajectory = { hostId: 3, frameSwitchTime: 0, points: [] };
		w.om.addObject(crasher);
		w.om.addObject(sat);
		w.om.addObject(earthMain);
		assert.deepEqual(w.engine.objects.map((o) => o.id), [1, 2, 3]);

		const log = [];
		for (const o of [crasher, sat, earthMain]) {
			for (const method of ['updateHistory', 'setCollided']) {
				const orig = o[method].bind(o);
				o[method] = (...args) => { log.push(`${o.id}:${method}`); return orig(...args); };
			}
		}
		EventBus.on('object:impacted', (t) => log.push(`impacted:${t.id}`));

		const earthBefore = { x: earthMain.x, y: earthMain.y };
		const msg1 = w.frame(60, 20);
		assert.deepEqual(log, ['2:updateHistory', '3:updateHistory', 'impacted:1', '1:setCollided']);

		const p = sat.actualFlightPath[0];
		assert.equal(p.relX, sat.x - earthMain.x, 'relative to the Earth position of this frame');
		assert.equal(p.relY, sat.y - earthMain.y);
		assert.equal(p.phiSurf, Math.atan2(p.relY, p.relX) - earthMain.rotationAngle, 'surface angle uses this frame\'s rotation');
		assert.equal(earthMain.rotationAngle, w.engineObj(3).rotationAngle);
		assert.equal(p.time, sat.telemetry.flightTime);
		const staleErrM = p2m(Math.hypot((sat.x - earthBefore.x) - p.relX, (sat.y - earthBefore.y) - p.relY));
		assert.ok(Math.abs(staleErrM - V_EARTH_ORBIT * 60) <= 1.0e3, `a stale (previous-frame) host would be ~1787 km off (${staleErrM} m)`);

		assert.equal(crasher.state, OBJECT_STATE.REMOVED);
		assert.equal(crasher.isDestroyed, true);
		assert.equal(crasher.actualFlightPath, null);
		assert.equal(crasher.trajectory.count, 0, 'destroyed rocket trail is cleared and not re-populated');
		assert.deepEqual(w.engine.objects.map((o) => o.id), [2, 3], 'Worker dropped the dead object after posting the frame');

		// Frame 2 reuses the returned ArrayBuffer with a shifted layout: Earth now occupies the slot the satellite used.
		const satCode = STAGE_STATE_TO_CODE[w.engineObj(2).stageState];
		assert.notEqual(satCode, 0, 'precondition: the satellite record carries a non-zero stage code');
		assert.equal(slot(w.lastSlots, 1, 'STAGE_STATE_CODE'), satCode, 'frame 1: satellite in record 1');
		assert.equal(earthMain.trajectory.count, 1);
		const msg2 = w.frame(60, 20);
		assert.equal(msg2.objectsData, msg1.objectsData, 'the pooled transfer buffer is reused');
		assert.equal(slot(w.lastSlots, 1, 'ID'), 3);
		assert.deepEqual(['ROTATION_ANGLE', 'TM_MACH', 'STAGE_STATE_CODE', 'STG_TIMER'].map((k) => slot(w.lastSlots, 1, k)),
			[w.engineObj(3).rotationAngle, 0, 0, 0], 'no rocket value survives in the celestial record');
		assert.equal(slot(w.lastSlots, 0, 'ROTATION_ANGLE'), 0);
		assert.equal(earthMain.rotationAngle, w.engineObj(3).rotationAngle);
		assert.equal(sat.stageState, w.engineObj(2).stageState);
		assert.equal(sat.actualFlightPath.length, 2, 'satellite keeps recording (inertial rule, ~450 km per frame)');
		assert.equal(earthMain.trajectory.count, 2, 'one history point per frame for live objects');
	});

	it('creates main-thread objects only for Worker-spawned debris', () => {
		const w = createWorld();
		const earthMain = makeBody(3, EARTH, 0, 0);
		w.om.addObject(earthMain);
		const far = (k) => 5.0e7 + k * 1.0e7;
		w.toWorker({ cmd: 'add', id: 500, name: 'Fairing', type: OBJECT_TYPES.DEBRIS, x: far(0), y: 0, vx: 0, vy: 2800, radius: 3, mass: 1.2, generation: 1, debrisSubType: 3 });
		w.toWorker({ cmd: 'add', id: 501, name: 'Rogue', type: OBJECT_TYPES.ROCKET, x: far(1), y: 0, vx: 0, vy: 2600, mass: 1, isIgnited: false, disableStaging: true });
		w.toWorker({ cmd: 'add', id: 502, name: 'RogueMoon', type: OBJECT_TYPES.CELESTIAL, x: far(2), y: 0, vx: 0, vy: 2400, mass: 1e3, radius: 10 });
		w.frame(10, 5);
		const deb = w.om.objects.find((o) => o.id === 500);
		assert.ok(deb instanceof Debris);
		assert.equal(deb.name, MULTISTAGE_ROCKET.DEBRIS_SPECS[3].name);
		assert.equal(deb.x, m2p(w.engineObj(500).x));
		assert.equal(deb.trajectory.count, 1);
		assert.equal(w.om.objects.some((o) => o.id === 501 || o.id === 502), false);
		w.frame(10, 5);
		assert.equal(w.om.objects.filter((o) => o.id === 500).length, 1, 'known debris is updated, not duplicated');
		assert.equal(deb.trajectory.count, 2);
	});
});

// ===========================================================================
describe('Integration 11-4: actual flight path in a synchronous (GEO) orbit', () => {
	const T_ROT = EARTH.ROTATION_PERIOD;
	const R_GEO = Math.cbrt(GM_E * T_ROT * T_ROT / (4 * Math.PI * Math.PI));
	const FRAMES = 60;
	const FRAME_S = 60;

	const fly = (frameSwitchTime) => {
		EventBus.clearAll();
		const w = createWorld();
		const earth = makeBody(1, EARTH, 0, 0, 0, 0, 0);
		w.om.addObject(earth);
		const sat = makeOrbiter(2, earth, R_GEO, 0.6, GM_E);
		sat.predictedTrajectory = { hostId: 1, frameSwitchTime, points: [] };
		w.om.addObject(sat);
		const frames = [];
		for (let i = 0; i < FRAMES; i++) {
			w.frame(FRAME_S, 20);
			const relX = sat.x - earth.x;
			const relY = sat.y - earth.y;
			frames.push({ t: sat.telemetry.flightTime, relX, relY, r: Math.hypot(relX, relY), phiSurf: Math.atan2(relY, relX) - earth.rotationAngle });
		}
		EventBus.clearAll();
		return { sat, frames };
	};

	const surfaceDriftM = (a, b) => p2m(Math.hypot(a.r * Math.cos(a.phiSurf) - b.r * Math.cos(b.phiSurf), a.r * Math.sin(a.phiSurf) - b.r * Math.sin(b.phiSurf)));

	it('precondition: the satellite is synchronous (host-fixed drift < 5 m, inertial motion ~184 km per frame)', () => {
		const { frames } = fly(null);
		assert.deepEqual(frames.map((f) => f.t), Array.from({ length: FRAMES }, (_, i) => (i + 1) * FRAME_S), 'flight clock advances with the Worker');
		let maxDrift = 0;
		for (const f of frames) { maxDrift = Math.max(maxDrift, surfaceDriftM(f, frames[0])); }
		assert.ok(maxDrift < RENDER.PREDICTED_TRAJECTORY.ACTUAL_SAMPLE_MIN_DIST_M, `max host-fixed drift ${maxDrift} m`);
		for (let i = 1; i < FRAMES; i++) {
			const step = p2m(Math.hypot(frames[i].relX - frames[i - 1].relX, frames[i].relY - frames[i - 1].relY));
			assert.ok(Math.abs(step - Math.sqrt(GM_E / R_GEO) * FRAME_S) <= 1, `inertial step ${step} m`);
		}
	});

	it('without a frame switch only the first point is recorded (host-fixed rule, craft stationary over the surface)', () => {
		const { sat, frames } = fly(null);
		assert.equal(sat.actualFlightPath.length, 1);
		assert.equal(sat.actualFlightPath[0].time, frames[0].t);
		assert.equal(sat.actualFlightPath[0].relX, frames[0].relX);
	});

	it('with the switch at 1800 s: host-fixed until 1800 s (inclusive), then every frame is recorded inertially (G2-3-03)', () => {
		const { sat, frames } = fly(1800);
		const expected = frames.filter((f, i) => i === 0 || f.t > 1800);
		assert.equal(expected.length, 31);
		assert.deepEqual(sat.actualFlightPath.map((p) => p.time), expected.map((f) => f.t));
		sat.actualFlightPath.forEach((p, i) => {
			assert.equal(p.relX, expected[i].relX, `point ${i} is this frame's inertial offset`);
			assert.equal(p.relY, expected[i].relY);
		});
		const last = sat.actualFlightPath[sat.actualFlightPath.length - 1];
		assert.equal(last.time, FRAMES * FRAME_S, 'the newest point is the current position');
		assert.equal(last.relX, frames[FRAMES - 1].relX);
	});

	it('with the switch at liftoff (0 s) every frame is recorded with its flight time', () => {
		const { sat, frames } = fly(0);
		assert.equal(sat.actualFlightPath.length, FRAMES);
		assert.deepEqual(sat.actualFlightPath.map((p) => p.time), frames.map((f) => f.t));
		assert.deepEqual(sat.actualFlightPath.map((p) => [p.relX, p.relY]), frames.map((f) => [f.relX, f.relY]));
	});

	it('with a switch after the flown interval (beyond 3600 s) the host-fixed rule applies throughout', () => {
		const { sat } = fly(FRAMES * FRAME_S);
		assert.equal(sat.actualFlightPath.length, 1, 'time == frameSwitchTime at the last frame is still host-fixed');
	});
});
