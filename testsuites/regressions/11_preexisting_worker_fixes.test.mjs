/**
 * Regression Suite 11: three pre-existing Worker-side bugs (they also occurred on main), fixed on this branch.
 *
 * 1. Hold-down on a long frame (design §3.1.1-2): a held rocket was judged to collide with its host when the first frame
 *    after an 'add' was long (placement, a load without the Worker runtime state, or any later 'add' while held).
 *    SimulationController.update() checks collisions once per frame, extrapolating every object over the whole frame
 *    with x + v t + a t^2 / 2. A held rocket's a(t) is its host's only after its first hold-down step; after the force
 *    evaluation of PhysicsEngine.addObject() it is gravity toward the host, so a long frame extrapolated it into the
 *    surface. Fix: a held rocket never collides with its own host (PhysicsEngine._isHeldOnHost); the expected pose is the
 *    hold-down formula of §3.1.1-2 (host + (R + bottomOffset + hostAlt)(cos th, sin th), v = host.v + omega x r).
 * 2. Stray simulation loop (design §2, §4.12): gravsim_calc.js started a SimulationController in every dedicated Worker
 *    that evaluated it, so the trajectory predictor Worker (gravsim_calc_predictor.js imports PhysicsEngine) also ran
 *    one and posted about 60 'update' messages per second. Fix: only the Worker whose entry script is this module (script
 *    URL === import.meta.url, the query included, the fragment ignored) starts it (isPhysicsWorkerEntry).
 * 3. Predictor bookkeeping (design §4.3, §4.11): `steps` is the number of integration steps actually taken (a remainder
 *    of 0.01 s or less before the horizon is not integrated and not counted), and a vehicle already destroyed at t = 0
 *    ends with `breakup` at t = 0 (the time the condition held) at the initial point, without an integration step.
 *
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §1 (expected values from the design or
 * closed-form physics) and §4.6.
 *
 * Module evaluation order matters for fix 2: gravsim_calc.js decides when it is evaluated whether it starts the loop.
 * This file therefore evaluates the predictor Worker's modules under a mocked worker global scope first (top-level
 * await, before the mock DOM exists and before anything else imports gravsim_calc.js), records what the evaluation
 * started, and only then loads the rest. The physics Worker (gravsim_calc.js as the entry script, with the app's
 * cache-busting query) is evaluated in fresh child processes without coverage collection: another module instance of
 * gravsim_calc.js (a URL with a query) would replace the coverage of the plain one in the merged report. While modules
 * are evaluated, setInterval is replaced by a recorder that schedules nothing, so a re-introduced stray loop fails the
 * assertions instead of running (or keeping a process alive).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_URL = new URL('../../scripts/', import.meta.url);
const CALC_URL = new URL('gravsim_calc.js', SCRIPTS_URL).href;
const PREDICTOR_URL = new URL('gravsim_calc_predictor.js', SCRIPTS_URL).href;
// Universe creates the physics Worker with a cache-busting query (`./scripts/gravsim_calc.js?v=${Date.now()}`)
const PHYSICS_WORKER_URL = `${CALC_URL}?v=1732170000000`;

const { SIMULATION, PHYSICS, TRAJECTORY_PREDICTION, OBJECT_TYPES } = await import('../../scripts/gravsim_const.js');

/** Dedicated-worker global scope stand-in: location, postMessage, onmessage (no document). */
const makeWorkerScope = (href) => ({
	location: { href },
	posted: [],
	onmessage: null,
	postMessage(msg) { this.posted.push(msg); }
});

/**
 * Evaluate `specifier` with `scope` as the global `self`; returns the module and the intervals it registered (recorded
 * only, never scheduled). Restores `self` and setInterval afterwards.
 */
async function evaluateInScope(scope, specifier) {
	const realSetInterval = globalThis.setInterval;
	const hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
	const prevSelf = globalThis.self;
	const intervals = [];
	globalThis.setInterval = (fn, ms) => {
		const handle = { recorded: true };
		intervals.push({ fn, ms, handle });
		return handle;
	};
	globalThis.self = scope;
	try {
		const module = await import(specifier);
		return { module, intervals, onmessageAfterImport: scope.onmessage };
	} finally {
		globalThis.setInterval = realSetInterval;
		if (hadSelf) { globalThis.self = prevSelf; } else { delete globalThis.self; }
	}
}

/** Run fn with `scope` as the global self (SimulationController posts through the global self). */
const withSelf = (scope, fn) => {
	const hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
	const prevSelf = globalThis.self;
	globalThis.self = scope;
	try { return fn(); } finally {
		if (hadSelf) { globalThis.self = prevSelf; } else { delete globalThis.self; }
	}
};

// Fix 2: the predictor Worker. gravsim_calc_predictor.js is its entry script and imports gravsim_calc.js; both are
// evaluated here for the first time in this process (preset_manager, a dependency of gravsim_calc.js only, is not
// loaded yet: gravsim_const.js imports nothing).
const firstCalcEvaluation = globalThis.__presetManager === undefined;
const predictorScope = makeWorkerScope(PREDICTOR_URL);
const predictorEval = await evaluateInScope(predictorScope, '../../scripts/gravsim_calc_predictor.js');

/**
 * Child process standing in for a dedicated Worker: `self` with the given script URL, setInterval recorded only; it
 * imports `moduleUrl` as the entry script, then runs every recorded loop tick once and sends one 'snapshotRuntime'
 * command, and prints what happened after a marker line.
 */
const CHILD_WORKER = `
const [href, moduleUrl] = process.argv.slice(1);
const intervals = [];
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { recorded: true }; };
const posted = [];
globalThis.self = { location: { href }, postMessage: (m) => { posted.push(m); }, onmessage: null };
await import(moduleUrl);
const onmessage = typeof self.onmessage;
await new Promise((resolve) => setTimeout(resolve, 5));
for (const i of intervals) { i.fn(); }
if (typeof self.onmessage === 'function') { self.onmessage({ data: { cmd: 'snapshotRuntime', requestId: 11 } }); }
console.log('@@RESULT@@' + JSON.stringify({ intervals: intervals.map(i => i.ms), onmessage,
	posted: posted.map(m => ({ cmd: m.cmd, requestId: m.requestId, rockets: m.rockets })) }));
`;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const evaluateInChildWorker = (href, moduleUrl) => {
	// Keep the extra module instance out of the merged coverage. An empty value disables collection in the child (a
	// missing one would be copied from this process by child_process).
	const env = { ...process.env, NODE_V8_COVERAGE: '' };
	const p = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_WORKER, href, moduleUrl],
		{ cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60000 });
	assert.equal(p.status, 0, `child worker exited with ${p.status}: ${p.stderr}`);
	const marker = p.stdout.lastIndexOf('@@RESULT@@');
	assert.ok(marker >= 0, 'child worker result');
	return JSON.parse(p.stdout.slice(marker + '@@RESULT@@'.length));
};

// The rest of the application (the plain gravsim_calc.js instance is the one evaluated with the predictor above)
const { setupMockDOM, createMockUniverse } = await import('../test_helpers.mjs');
setupMockDOM();
const { SimulationController, PhysicsEngine, isPhysicsWorkerEntry } = await import('../../scripts/gravsim_calc.js');
const { runMultiBodySimulation, PredictorPhysicsEngine } = predictorEval.module;
const { WorkerBridge } = await import('../../scripts/gravsim_worker_bridge.js');
const { ObjectManager } = await import('../../scripts/gravsim_object_manager.js');
const { ObjectPlacer } = await import('../../scripts/gravsim_object_placer.js');
const { RocketLauncher } = await import('../../scripts/gravsim_rocket_launcher.js');
const { TrajectoryPredictor } = await import('../../scripts/gravsim_trajectory_predictor.js');
const { presetManager } = await import('../../scripts/gravsim_preset_manager.js');
const { EventBus } = await import('../../scripts/gravsim_event_bus.js');
const { UnitConvertUtils } = await import('../../scripts/gravsim_utils.js');

const TP = TRAJECTORY_PREDICTION;
const AU = PHYSICS.METERS_PER_AU;
const m2p = UnitConvertUtils.m2pix;
const EARTH = presetManager.getObjectParam('Earth');
const OMEGA_E = (2 * Math.PI) / EARTH.ROTATION_PERIOD;
const GM_E = PHYSICS.G * UnitConvertUtils.ton2kg(EARTH.MASS); // presets in t, the Worker in kg
const RE = 6371e3; // synthetic predictor worlds (as in unit 07)
const ME = 5.972e24;

// ===========================================================================
// Fix 1 harness: the application path (ObjectPlacer / RocketLauncher.rollout / ObjectManager) to a real
// SimulationController, driven by real SimulationController.update() frames with a deterministic clock
// ===========================================================================

const createApp = () => {
	EventBus.clearAll();
	WorkerBridge._bufferPool.length = 0;
	const ctrl = new SimulationController();
	const worker = { postMessage: (msg) => ctrl.handleMessage({ data: msg.cmd === 'returnBuffer' ? msg : structuredClone(msg) }) };
	const universe = createMockUniverse();
	const om = new ObjectManager(null, worker);
	om.universe = universe;
	universe.ObjectManager = om;
	Object.defineProperty(universe, 'objects', { get() { return om.objects; }, set(a) { om.objects = a; }, configurable: true });
	universe.addObject = (obj) => om.addObject(obj);
	universe.getObjectParams = (name) => presetManager.getObjectParam(name);
	universe.ObjectPlacer = new ObjectPlacer(universe);
	worker.postMessage({ cmd: 'initDefinitions', celestialParams: presetManager.getObjectParamsMap() });
	const app = {
		ctrl, om, universe, engine: ctrl.engine,
		placeSunEarth() {
			universe.ObjectPlacer.placeObject('Sun', 0, 0, 0, 0);
			return universe.ObjectPlacer.placeObject('Earth', m2p(AU), 0, 0, m2p(29780));
		},
		rollout(earth, { hostAltitudeM } = {}) {
			const rl = new RocketLauncher(universe, { presetManager });
			universe.RocketLauncher = rl;
			rl.updatePredictionSync = () => null;
			rl.updatePrediction = () => null;
			rl.requestPreviewUpdate = () => {};
			presetManager.applyToLauncher(rl, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
			rl.mode = 'host';
			rl.hostId = earth.id;
			rl.hostAngleDeg = 30;
			if (hostAltitudeM !== undefined) { rl.hostAltitudeM = hostAltitudeM; }
			rl.rollout();
			return rl.rolloutedRocketId;
		},
		/**
		 * One real SimulationController.update() frame of `totalDtS` simulated seconds: the clock jumps beyond
		 * MAX_FRAME_ELAPSED_MS (clamped to it, the longest frame) and the time scale is chosen for totalDtS.
		 */
		frame(totalDtS) {
			const timeScale = totalDtS * SIMULATION.TIME_SCALE / (SIMULATION.MAX_FRAME_ELAPSED_MS * PHYSICS.YEARS_PER_SECOND);
			ctrl.handleMessage({ data: { cmd: 'setTimeScale', timeScale } });
			const realNow = Date.now;
			const scope = { posted: [], postMessage(m) { this.posted.push(m); } };
			try {
				const t0 = 1.7e12;
				ctrl.lastTime = t0;
				Date.now = () => t0 + 5 * SIMULATION.MAX_FRAME_ELAPSED_MS;
				withSelf(scope, () => ctrl.update());
			} finally {
				Date.now = realNow;
			}
			const msg = scope.posted.find(m => m.cmd === 'update');
			assert.ok(msg, 'the controller posted an update frame');
			om.updateObjectParams(msg);
			return { totalDt: msg.deltaTime * msg.subSteps, subSteps: msg.subSteps };
		},
		worker: (id) => ctrl.engine.objects.find(o => o.id === id),
		main: (id) => om.objects.find(o => o.id === id)
	};
	return app;
};

/** Hold-down pose of §3.1.1-2 relative to the host: angle, radius, and the velocity deviation from host.v + omega x r. */
const holdDownPose = (rocket, host) => {
	const dx = rocket.x - host.x;
	const dy = rocket.y - host.y;
	return {
		angle: Math.atan2(dy, dx),
		r: Math.hypot(dx, dy),
		dv: Math.hypot((rocket.vx - host.vx) - (-OMEGA_E * dy), (rocket.vy - host.vy) - (OMEGA_E * dx))
	};
};
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Asserts the rocket is still held on the pad at the hold-down pose after `elapsedS` from hostAngle th0. */
const assertOnPad = (app, id, earthId, th0, elapsedS, label) => {
	const r = app.worker(id);
	const host = app.worker(earthId);
	assert.ok(r, `${label}: the rocket still exists in the Worker`);
	assert.equal(r.collided, false, `${label}: not collided`);
	assert.equal(r.shattered, false, `${label}: not shattered`);
	assert.equal(r.isHoldDown, true, `${label}: still held`);
	const pose = holdDownPose(r, host);
	const rPad = host.radius + r.bottomOffsetM + r.hostAltM;
	assert.ok(Math.abs(pose.r - rPad) < 1e-3, `${label}: on the pad radius (${pose.r} vs ${rPad} m)`);
	assert.ok(angleDiff(pose.angle, th0 + OMEGA_E * elapsedS) < 1e-9, `${label}: pad angle th0 + omega t`);
	assert.ok(pose.dv < 1e-6, `${label}: velocity host.v + omega x r (deviation ${pose.dv} m/s)`);
	const main = app.main(id);
	assert.ok(main, `${label}: the rocket still exists on the main thread`);
	assert.ok(!main.collided && !main.isImpact, `${label}: no impact on the main thread`);
};

/**
 * Closed form of the long-frame hazard (design §3.1.1-2 + free fall): a rocket at rest on the rotating pad that falls
 * freely with g = GM / r^2 (the a(t) the extrapolation used) reaches the surface after t = sqrt(2 h / (g - omega^2 r))
 * and is below it until 0.5 g t^2 = 2 r (1 - omega^2 r / g). Frames whose collision samples (totalDt * i / N, i < N)
 * fall into that interval were judged collisions.
 */
const fallWindow = (rPad, hostAltM) => {
	const g = GM_E / (rPad * rPad);
	const tIn = Math.sqrt((2 * hostAltM) / (g - OMEGA_E * OMEGA_E * rPad));
	const tOut = Math.sqrt((4 * rPad * (1 - (OMEGA_E * OMEGA_E * rPad) / g)) / g);
	return { tIn, tOut };
};

describe('Regression 11-1: a held rocket never collides with its host, whatever the frame length (§3.1.1-2)', () => {
	let origInfo;
	let origDebug;
	beforeEach(() => {
		origInfo = console.info;
		origDebug = console.debug;
		console.info = () => {};
		console.debug = () => {};
	});
	afterEach(() => {
		console.info = origInfo;
		console.debug = origDebug;
		EventBus.clearAll();
	});

	it('the closed-form hazard window for the app default pad altitude (10 m) contains the frame lengths used below', () => {
		const app = createApp();
		const earth = app.placeSunEarth();
		const id = app.rollout(earth);
		const r = app.worker(id);
		assert.equal(r.hostAltM, 10, 'RocketLauncher default pad altitude');
		const { tIn, tOut } = fallWindow(earth.radius + r.bottomOffsetM + r.hostAltM, r.hostAltM);
		const N = SIMULATION.CALC_EXPAND_DIV_NUM;
		assert.ok(tIn > 1.4 && tIn < 1.45, `entry ${tIn} s`);
		assert.ok(tOut > 1600 && tOut < 1620, `exit ${tOut} s`);
		// A frame is in the hazard when some sample totalDt * i / N (0 < i < N) lies in (tIn, tOut)
		const hazardous = (T) => Array.from({ length: N - 1 }, (_, k) => T * (k + 1) / N).some(t => t > tIn && t < tOut);
		for (const T of [1.6, 2, 100, 1000, 5000, 30000]) { assert.ok(hazardous(T), `${T} s is a hazardous frame`); }
		for (const T of [1.4, 1e5, PHYSICS.YEARS_PER_SECOND]) { assert.ok(!hazardous(T), `${T} s is outside the hazard`); }
	});

	it('normal: the first frame after rollout keeps the rocket on the pad for long frames (1.6 s .. 30,000 s)', () => {
		for (const T of [1.6, 2, 100, 1000, 5000, 30000]) {
			const app = createApp();
			const earth = app.placeSunEarth();
			const id = app.rollout(earth);
			const th0 = app.worker(id).hostAngleRad;
			const { totalDt } = app.frame(T);
			assert.ok(Math.abs(totalDt - T) <= 1e-9 * T, `frame length ${totalDt} s`);
			assertOnPad(app, id, earth.id, th0, totalDt, `first frame ${T} s`);
			// and the following frames, short and long, keep it there
			let t = totalDt;
			for (const T2 of [1 / 60, T, 3]) { t += app.frame(T2).totalDt; }
			assertOnPad(app, id, earth.id, th0, t, `frames after the first ${T} s`);
		}
	});

	it('normal: a later add while the rocket is held (another body placed) does not make the next long frame a collision', () => {
		const app = createApp();
		const earth = app.placeSunEarth();
		const id = app.rollout(earth);
		const th0 = app.worker(id).hostAngleRad;
		let t = 0;
		for (let i = 0; i < 5; i++) { t += app.frame(1 / 60).totalDt; }
		app.universe.ObjectPlacer.placeObject('Mars', 0, m2p(1.524 * AU), m2p(-24070), 0);
		assert.ok(app.engine.objects.some(o => o.name === 'Mars'), 'Mars added in the Worker');
		t += app.frame(100).totalDt;
		assertOnPad(app, id, earth.id, th0, t, 'long frame after the add');
	});

	it('normal: saved on the pad and loaded without the Worker runtime state, the first long frame keeps it on the pad', () => {
		const src = createApp();
		const earth = src.placeSunEarth();
		const id = src.rollout(earth);
		for (let i = 0; i < 3; i++) { src.frame(1 / 60); }
		const saved = JSON.parse(JSON.stringify(src.om.getState())); // no runtime snapshot (legacy save / snapshot timeout)
		const rocketEntry = saved.find(o => o.type === OBJECT_TYPES.ROCKET);
		assert.equal(rocketEntry.isHoldDown, true, 'saved as held');
		assert.ok(!rocketEntry.runtimeState, 'no Worker runtime state in the save');

		for (const T of [2, 3600]) {
			const app = createApp();
			app.om.loadState(JSON.parse(JSON.stringify(saved)));
			const r = app.worker(id);
			assert.ok(r && r.isHoldDown === true, 'loaded as held');
			const th0 = r.hostAngleRad;
			const { totalDt } = app.frame(T);
			assertOnPad(app, id, earth.id, th0, totalDt, `first frame ${T} s after the load`);
		}
	});

	it('boundary: frames below the hazard (1.4 s), far beyond it (1e5 s) and the longest frame (one year at time scale 1)', () => {
		for (const T of [1.4, 1e5, PHYSICS.YEARS_PER_SECOND]) {
			const app = createApp();
			const earth = app.placeSunEarth();
			const id = app.rollout(earth);
			const th0 = app.worker(id).hostAngleRad;
			const { totalDt } = app.frame(T);
			assertOnPad(app, id, earth.id, th0, totalDt, `first frame ${T} s`);
		}
	});

	it('abnormal: a pad altitude of 0 m (rocket base exactly on the surface) never collides, short or long frames', () => {
		// With h = 0 the hazard window starts at t = 0: even a normal first frame (1/60 s) was a collision
		const app = createApp();
		const earth = app.placeSunEarth();
		const id = app.rollout(earth, { hostAltitudeM: 0 });
		assert.equal(app.worker(id).hostAltM, 0);
		const th0 = app.worker(id).hostAngleRad;
		let t = 0;
		for (const T of [...Array(30).fill(1 / 60), 100, 5000, 1]) {
			t += app.frame(T).totalDt;
			assertOnPad(app, id, earth.id, th0, t, `alt 0, after a ${T} s frame`);
		}
	});

	it('guard: a released rocket on the pad still falls and collides with its host within a long frame', () => {
		const app = createApp();
		const earth = app.placeSunEarth();
		const id = app.rollout(earth);
		const r = app.worker(id);
		app.om.updateRocketState(id, false, false); // released, engine off: free fall from 10 m
		assert.equal(r.isHoldDown, false);
		const { tIn } = fallWindow(earth.radius + r.bottomOffsetM + r.hostAltM, r.hostAltM);
		assert.ok(tIn < 100, 'the free fall reaches the surface within the frame');
		app.frame(100);
		assert.equal(r.collided, true, 'a rocket that is not held is not exempt');
	});

	it('guard: a held rocket still collides with other objects (debris on the pad)', () => {
		const app = createApp();
		const earth = app.placeSunEarth();
		const id = app.rollout(earth);
		app.frame(1 / 60);
		const r = app.worker(id);
		app.ctrl.handleMessage({ data: {
			cmd: 'add', id: 7777, name: 'Debris', type: OBJECT_TYPES.DEBRIS, x: r.x, y: r.y, vx: r.vx, vy: r.vy,
			radius: 1, mass: 0.5, generation: 1, debrisSubType: 0, parentRocketId: null
		} });
		app.frame(1 / 60);
		const deb = app.worker(7777);
		assert.ok(!deb || deb.collided === true, 'the overlapping debris collided with the held rocket');
		assert.equal(r.collided, false, 'the heavier held rocket survives');
		assert.equal(r.isHoldDown, true);
	});

	it('the exemption is exactly the hold-down condition: held + hostId of that body (PhysicsEngine._isHeldOnHost)', () => {
		const engine = new PhysicsEngine();
		const host = { id: 5, type: OBJECT_TYPES.CELESTIAL };
		const held = { id: 9, type: OBJECT_TYPES.ROCKET, isHoldDown: true, hostId: 5 };
		assert.equal(engine._isHeldOnHost(held, host), true);
		assert.equal(engine._isHeldOnHost(host, held), false, 'the body is not held on the rocket');
		assert.equal(engine._isHeldOnHost({ ...held, isHoldDown: false }, host), false, 'released');
		assert.equal(engine._isHeldOnHost({ ...held, hostId: 6 }, host), false, 'held on another body');
		assert.equal(engine._isHeldOnHost({ ...held, hostId: null }, host), false, 'no host');
		assert.equal(engine._isHeldOnHost({ ...held, type: OBJECT_TYPES.DEBRIS }, host), false, 'not a rocket');
	});
});

// ===========================================================================
// Fix 2: only the physics Worker's entry module starts the simulation loop
// ===========================================================================

describe('Regression 11-2: the SimulationController loop runs only in the physics Worker (§2, §4.12)', () => {
	it('precondition: gravsim_calc.js was first evaluated in this process inside the predictor Worker scope', () => {
		assert.equal(firstCalcEvaluation, true);
		assert.equal(typeof predictorEval.module.runMultiBodySimulation, 'function');
	});

	it('the app creates the predictor Worker from gravsim_calc_predictor.js, whose URL is not gravsim_calc.js', () => {
		const origWorker = globalThis.Worker;
		class RecordingWorker { constructor(url, opts) { this.url = String(url); this.opts = opts; } postMessage() {} terminate() {} }
		globalThis.Worker = RecordingWorker;
		try {
			const tp = new TrajectoryPredictor({ objects: [] });
			assert.equal(tp._worker.url, PREDICTOR_URL, 'the scope URL used above is the real predictor Worker URL');
			assert.deepEqual(tp._worker.opts, { type: 'module' });
			assert.notEqual(tp._worker.url, CALC_URL);
		} finally {
			globalThis.Worker = origWorker;
		}
	});

	it('predictor Worker: importing gravsim_calc.js starts no loop; self.onmessage is the predictor handler only', () => {
		assert.equal(predictorEval.intervals.length, 0, 'no setInterval while the predictor Worker modules are evaluated');
		assert.equal(predictorScope.posted.length, 0, 'nothing posted before a request');
		assert.equal(typeof predictorEval.onmessageAfterImport, 'function');
		// The handler answers a request with exactly one predictionResult and nothing else
		withSelf(predictorScope, () => predictorScope.onmessage({ data: {
			cmd: 'predict', requestId: 4, hostId: 1,
			celestialBodies: [{ id: 1, name: 'TestHost', x: 0, y: 0, vx: 0, vy: 0, massKg: 0, radius: RE, param: { ROTATION_PERIOD: 0 } }],
			rocketConfig: { x: RE + 1e6, y: 0, vx: 0, vy: 0, bottomOffsetM: 2, dryMassT: 1, fuelMassT: 0, oxidMassT: 0, stages: [{ thrustKN: 0, fuelMassT: 0, oxidMassT: 0, burnTime: 0, dryMassT: 1 }] },
			options: { maxSimTime: 1 }
		} }));
		assert.deepEqual(predictorScope.posted.map(m => m.cmd), ['predictionResult']);
		assert.equal(predictorScope.posted[0].requestId, 4);
	});

	it('physics Worker: its entry module (cache-busting query included) starts exactly one loop at CALC_INTERVAL', () => {
		const res = evaluateInChildWorker(PHYSICS_WORKER_URL, PHYSICS_WORKER_URL);
		assert.equal(res.intervals.length, 1, 'one SimulationController loop');
		assert.ok(Math.abs(res.intervals[0] - 1000 / SIMULATION.CALC_INTERVAL) < 1e-12, 'about 60 frames per second');
		assert.equal(res.onmessage, 'function', 'the controller receives the main-thread commands');
		// A tick of the loop posts an update frame; a command is answered on the same scope
		assert.deepEqual(res.posted.map(m => m.cmd), ['update', 'runtimeSnapshot']);
		assert.equal(res.posted[1].requestId, 11);
		assert.deepEqual(res.posted[1].rockets, []);
	});

	it('fresh processes: the predictor Worker and a Worker of another gravsim_calc.js instance start no loop', () => {
		const predictor = evaluateInChildWorker(PREDICTOR_URL, PREDICTOR_URL);
		assert.deepEqual(predictor.intervals, [], 'predictor Worker');
		assert.equal(predictor.onmessage, 'function', 'the predictor handler is installed');
		assert.deepEqual(predictor.posted, [], 'nothing posted (a snapshot command is not the predictor protocol)');
		const other = evaluateInChildWorker(`${CALC_URL}?v=1`, `${CALC_URL}?v=2`);
		assert.deepEqual(other.intervals, [], 'the module is not the entry script of this Worker');
		assert.equal(other.onmessage, 'object', 'self.onmessage untouched (null)');
		assert.deepEqual(other.posted, []);
	});

	it('isPhysicsWorkerEntry: true only for a worker scope whose script URL is this module (normal, boundary)', () => {
		const scope = (href, extra = {}) => ({ location: { href }, postMessage() {}, ...extra });
		assert.equal(isPhysicsWorkerEntry(scope(PHYSICS_WORKER_URL), PHYSICS_WORKER_URL), true, 'same URL with query');
		assert.equal(isPhysicsWorkerEntry(scope(CALC_URL), CALC_URL), true, 'same URL without query');
		assert.equal(isPhysicsWorkerEntry(scope(`${PHYSICS_WORKER_URL}#boot`), PHYSICS_WORKER_URL), true, 'a fragment is ignored');
		assert.equal(isPhysicsWorkerEntry(scope(PREDICTOR_URL), CALC_URL), false, 'the predictor Worker');
		assert.equal(isPhysicsWorkerEntry(scope(`${CALC_URL}?v=1`), `${CALC_URL}?v=2`), false, 'another instance (different query)');
		assert.equal(isPhysicsWorkerEntry(scope(`${CALC_URL}?v=1`), CALC_URL), false, 'query only on the worker URL');
		assert.equal(isPhysicsWorkerEntry(scope(CALC_URL), `${CALC_URL}?v=1`), false, 'query only on the module URL');
		assert.equal(isPhysicsWorkerEntry(scope('http://127.0.0.1:8080/scripts/gravsim_calc.js'), CALC_URL), false, 'same file name, other origin');
	});

	it('isPhysicsWorkerEntry: false on the main thread, in Node and for malformed scopes (abnormal)', () => {
		const ok = { location: { href: CALC_URL }, postMessage() {} };
		assert.equal(isPhysicsWorkerEntry(undefined, CALC_URL), false, 'Node: no self');
		assert.equal(isPhysicsWorkerEntry(null, CALC_URL), false);
		assert.equal(isPhysicsWorkerEntry({ ...ok, document: {} }, CALC_URL), false, 'main thread (window has a document)');
		assert.equal(isPhysicsWorkerEntry({ location: ok.location }, CALC_URL), false, 'no postMessage');
		assert.equal(isPhysicsWorkerEntry({ ...ok, postMessage: 'x' }, CALC_URL), false, 'postMessage not a function');
		assert.equal(isPhysicsWorkerEntry({ postMessage() {} }, CALC_URL), false, 'no location');
		assert.equal(isPhysicsWorkerEntry({ location: null, postMessage() {} }, CALC_URL), false, 'null location');
		for (const href of [undefined, null, 42, '', 'scripts/gravsim_calc.js', 'not a url']) {
			assert.equal(isPhysicsWorkerEntry({ location: { href }, postMessage() {} }, CALC_URL), false, `href ${String(href)}`);
		}
		for (const moduleUrl of [undefined, '', 'not a url']) {
			assert.equal(isPhysicsWorkerEntry(ok, moduleUrl), moduleUrl === undefined, `module URL ${String(moduleUrl)}`);
		}
		assert.equal(isPhysicsWorkerEntry(), false, 'default arguments in Node (no self)');
	});

	it('main thread: a stray update message (what the old predictor Worker posted) is ignored by TrajectoryPredictor', () => {
		const origWorker = globalThis.Worker;
		class InertWorker { constructor() { this.onmessage = null; } postMessage() {} terminate() {} }
		globalThis.Worker = InertWorker;
		try {
			const tp = new TrajectoryPredictor({ objects: [] });
			tp._worker.onmessage({ data: { cmd: 'update', deltaTime: 0.4, subSteps: 40, objectsData: new ArrayBuffer(0), validLength: 0 } });
			assert.equal(tp.prediction, null);
			assert.equal(tp.isStale, true);
			assert.equal(tp._pendingCallbacks.size, 0);
		} finally {
			globalThis.Worker = origWorker;
		}
	});
});

// ===========================================================================
// Fix 3: steps = integration steps actually taken; breakup at the time the condition held
// ===========================================================================

const GM = PHYSICS.G * ME;
const COAST_STAGES = [{ thrustKN: 0, fuelMassT: 0, oxidMassT: 0, burnTime: 0, dryMassT: 1 }];
const EARTH_LIKE_ATM = { ROTATION_PERIOD: 0, ATM_LIMIT_ALT: 100000, ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 };
const vCirc = (r) => Math.sqrt(GM / r);

/** Synthetic world: host id 1 (optionally moving) and a probe; see unit 07 for the same fixtures. */
const simulate = ({ host = {}, rocket = {}, options = {} } = {}) => runMultiBodySimulation({
	hostId: 1,
	celestialBodies: [{ id: 1, name: 'TestHost', x: 0, y: 0, vx: 0, vy: 0, massKg: ME, radius: RE, param: { ROTATION_PERIOD: 0 }, ...host }],
	rocketConfig: {
		name: 'Probe', x: RE + 400e3, y: 0, vx: 0, vy: 0, radius: 2, bottomOffsetM: 2,
		dryMassT: 1, fuelMassT: 0, oxidMassT: 0, thrustForceN: 0, burnTime: 0, flightProfile: [], stages: COAST_STAGES,
		...rocket
	},
	options
});
const coast = (options) => simulate({ rocket: { x: RE + 400e3, vy: vCirc(RE + 400e3) }, options });

/**
 * Run fn while counting PredictorPhysicsEngine.step() calls. `t` accumulates the step lengths like the predictor's
 * clock (0 + dt + dt ...); `destroyedAt` is that clock after the first step that ended with the rocket destroyed.
 */
const countSteps = (fn) => {
	const orig = PredictorPhysicsEngine.prototype.step;
	const rec = { calls: 0, t: 0, destroyedAt: null, destroyedBefore: null };
	PredictorPhysicsEngine.prototype.step = function (dt) {
		if (rec.calls === 0) { rec.destroyedBefore = Boolean(this.rocket.collided || this.rocket.shattered); }
		orig.call(this, dt);
		rec.calls++;
		rec.t += dt;
		if (rec.destroyedAt === null && (this.rocket.collided || this.rocket.shattered)) { rec.destroyedAt = rec.t; }
	};
	try {
		rec.res = fn();
	} finally {
		PredictorPhysicsEngine.prototype.step = orig;
	}
	return rec;
};

/** Vehicle over its load limit at t = 0: q = rho(20 km) v^2 / 2 at 3 km/s, half of it exceeds both Q limits. */
const overLimitAtStart = (hostExtra = {}, rocketExtra = {}, options = { maxSimTime: 3600 }) => simulate({
	host: { param: EARTH_LIKE_ATM, ...hostExtra },
	rocket: { name: 'Rocket', x: RE + 20e3, vy: 3000, ...rocketExtra },
	options
});

describe('Regression 11-3: predictor steps and the breakup time (§4.3, §4.11)', () => {
	const dtCool = TP.DT.POST_BURNOUT_COOL; // unpowered steps during the first POST_BURNOUT_DURATION_S (120 s)

	it('steps counts only integrated steps: a remainder of 0.01 s or less before the horizon is not a step', () => {
		assert.equal(dtCool, 0.1);
		// maxSimTime = k * dtCool + dtCool / 20: k steps, then a 0.005 s remainder that is not integrated
		for (const k of [0, 1, 1000]) {
			const rec = countSteps(() => coast({ maxSimTime: k * dtCool + dtCool / 20 }));
			assert.equal(rec.res.endReason, 'horizon', `k=${k}`);
			assert.equal(rec.calls, k, `k=${k}: integration steps`);
			assert.equal(rec.res.steps, k, `k=${k}: steps`);
			assert.equal(rec.res.points.at(-1).time, rec.t, `k=${k}: the line ends at the last integrated time`);
		}
		// Boundary: a remainder just above 0.01 s is integrated (one more step, ending exactly at the horizon)
		for (const k of [0, 1, 1000]) {
			const T = k * dtCool + 0.0101;
			const rec = countSteps(() => coast({ maxSimTime: T }));
			assert.equal(rec.res.steps, k + 1, `k=${k}: remainder 0.0101 s`);
			assert.equal(rec.calls, k + 1);
			assert.equal(rec.res.maxSimTime, T);
		}
	});

	it('steps equals the integration steps for every end reason', () => {
		const r0 = RE + 400e3;
		const cases = [
			['horizon', () => coast({ maxSimTime: 600 })],
			['horizon', () => coast({ maxSimTime: 7200.004 })],
			['point_budget', () => coast({ maxSimTime: 0.2 * (365.25 / 12) * 86400, maxPoints: 50 })],
			['step_budget', () => coast({ maxSimTime: 0.2 * (365.25 / 12) * 86400 })],
			['impact', () => simulate({ rocket: { x: RE + 100e3 }, options: { maxSimTime: 3600 } })],
			['breakup', () => simulate({
				host: { param: EARTH_LIKE_ATM },
				rocket: { name: 'Rocket', x: RE + 120e3, vx: -200, vy: 7800, dryMassT: 20, stages: [{ ...COAST_STAGES[0], dryMassT: 20 }] },
				options: { maxSimTime: 3600 }
			})],
			['impact', () => simulate({ rocket: { x: r0, vy: 0.96 * vCirc(r0) }, options: { maxSimTime: 20000 } })]
		];
		for (const [reason, run] of cases) {
			const rec = countSteps(run);
			assert.equal(rec.res.endReason, reason);
			assert.equal(rec.res.steps, rec.calls, `${reason}: steps = integration steps`);
			assert.ok(rec.res.steps <= TP.MAX_STEPS_CAP);
		}
		assert.equal(countSteps(() => coast({ maxSimTime: 0.2 * (365.25 / 12) * 86400 })).res.steps, TP.MAX_STEPS, 'step budget 120,000');
	});

	it('breakup during the run: the event time is the clock after the step that destroyed the vehicle', () => {
		const rec = countSteps(() => simulate({
			host: { param: EARTH_LIKE_ATM },
			rocket: { name: 'Rocket', x: RE + 120e3, vx: -200, vy: 7800, dryMassT: 20, stages: [{ ...COAST_STAGES[0], dryMassT: 20 }] },
			options: { maxSimTime: 3600 }
		}));
		const ev = rec.res.events.filter(e => e.id === 'breakup');
		assert.equal(rec.res.endReason, 'breakup');
		assert.equal(rec.destroyedBefore, false);
		assert.ok(rec.destroyedAt > 0);
		assert.equal(ev.length, 1);
		assert.equal(ev[0].time, rec.destroyedAt, 'the time the condition first held');
		assert.equal(rec.res.points.at(-1).time, rec.destroyedAt, 'the final point is at the breakup');
		assert.equal(rec.res.steps, rec.calls);
	});

	it('destroyed at t = 0: breakup at time 0 at the initial point, no integration step (static and moving host)', () => {
		const rhoV2 = 0.5 * EARTH_LIKE_ATM.ATM_DENSITY_0 * Math.exp(-20e3 / EARTH_LIKE_ATM.ATM_SCALE_HEIGHT) * 3000 * 3000;
		const limits = presetManager.getObjectParam('Rocket');
		assert.ok(rhoV2 / 2 > Math.max(limits.MAX_Q_AXIAL, limits.MAX_Q_LATERAL), 'over the load limit at t = 0 (closed form)');
		const worlds = [
			['host at rest', {}, {}],
			// the host moves at 29.78 km/s: a step would leave the frozen wreck behind (a second, displaced point)
			['moving host', { vx: 29780 }, { vx: 29780 }]
		];
		for (const [label, hostExtra, rocketExtra] of worlds) {
			const rec = countSteps(() => overLimitAtStart(hostExtra, rocketExtra));
			const res = rec.res;
			assert.equal(res.endReason, 'breakup', label);
			assert.equal(rec.calls, 0, `${label}: no integration step`);
			assert.equal(res.steps, 0, `${label}: steps`);
			assert.equal(res.points.length, 1, `${label}: only the initial point`);
			assert.equal(res.maxSimTime, 0, `${label}: maxSimTime is the final point time`);
			const ev = res.events.filter(e => e.id === 'breakup');
			assert.equal(ev.length, 1, label);
			assert.equal(ev[0].time, 0, `${label}: the condition held at t = 0`);
			assert.equal(ev[0].name, 'BREAKUP');
			assert.equal(ev[0].type, 'impact');
			const p0 = res.points[0];
			for (const key of ['relX', 'relY', 'r', 'phiSurf', 'worldX', 'worldY']) {
				assert.equal(ev[0][key], p0[key], `${label}: event ${key} at the initial point`);
			}
			assert.equal(ev[0].altM, p0.altM, `${label}: event altitude`);
			assert.equal(res.maxAltM, p0.altM, `${label}: maximum altitude of the single point`);
			assert.equal(res.maxQ, 0, `${label}: no step, no max-Q sample`);
			assert.equal(res.events.filter(e => e.type === 'impact' && e.id !== 'breakup').length, 0);
		}
	});

	it('boundary: destroyed at t = 0 with a horizon of 0.01 s or less still ends with breakup (not horizon)', () => {
		for (const maxSimTime of [0.01, 0.005]) {
			const rec = countSteps(() => overLimitAtStart({}, {}, { maxSimTime }));
			assert.equal(rec.res.endReason, 'breakup', `${maxSimTime} s`);
			assert.equal(rec.res.steps, 0);
			assert.equal(rec.res.events.find(e => e.id === 'breakup')?.time, 0);
		}
	});

	it('the sync path (TrajectoryPredictor.calculateSync) reports the same steps and breakup as the direct call', () => {
		const tp = new TrajectoryPredictor(null);
		const host = {
			id: 11, name: 'TestHost', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0,
			mass: UnitConvertUtils.kg2ton(ME), radius: RE, rotationAngle: 0, param: { ROTATION_PERIOD: 0 }
		};
		const r0 = RE + 400e3;
		const res = tp.calculateSync({
			host, relX: m2p(r0), relY: 0, relVx: 0, relVy: m2p(vCirc(r0)), maxSimTime: dtCool + dtCool / 20, bottomOffsetM: 2,
			stages: COAST_STAGES, dryMassT: 1, fuelMassT: 0, oxidMassT: 0, burnTime: 0
		});
		assert.equal(res.endReason, 'horizon');
		assert.equal(res.steps, 1, 'one 0.1 s step; the 0.005 s remainder is not a step');
	});
});
