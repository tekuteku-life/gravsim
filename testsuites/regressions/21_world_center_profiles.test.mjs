/**
 * Regression Suite 21: after Galactic Center, also after Galactic Center and System › Clear Selected, every deploy profile
 * builds the world of a fresh page (design §4.13-27 and §4.13-32 as revised, §4.14-12; audit G3-2-02), and a body the user
 * placed is not replaced by what adds to the world, whatever its kind (§4.14-14; audits G3-3-01, G3-4-01).
 *
 * §4.13-32 made Sagittarius A* the world center of the Galactic Center profile. The placements built on the world center
 * took it for a body of the Sun's kind (§4.13-27):
 *  1. The binary and three-body generators reuse the center as their first star and rewrite its name, colour, mass and
 *     motion only. After Galactic Center, "Sun A" (and "Sun A (Trisolaris 1)") kept the radius of Sgr A* (1.27e10 m, 18
 *     times the Sun's), its border and its param, on the main thread and in the Worker.
 *  2. Solar System goes around the body named "Sun". After Galactic Center and Clear Selected only Sgr A* is left: the
 *     placement threw "Sun object not found in the universe." after the pause, so the simulation stayed paused with
 *     nothing placed. The swarms of Stress Test (around the Sun) placed nothing, and the Deploy buttons put a planet
 *     around Sgr A* (the camera's target).
 * The rule: a world reduced to a world center of another kind (its param names another preset) than the body a placement
 * is built on gets the center of a fresh page: the old center is removed and that body placed where Reset places the Sun
 * (the canvas center, at rest) as the new center; the placement then goes on as on a fresh page. A center of the kind, a
 * center without a param (a legacy save) and a world with other celestial bodies are left as they are.
 * Which centers (design §4.14-14, audits G3-3-01 and G3-4-01, section D): a body the user places into the empty world is
 * its center too (§4.14-13 (a)), and the Deploy buttons and Solar System removed it. What adds to the world replaces only
 * the world center a profile placed (CelestialBody.isProfileWorldCenter, given to the static object marked worldCenter:
 * Sgr A* of Galactic Center, and saved); the kind alone (Iteration 4) also removed a Sgr A* the user placed by hand. After
 * the clear of the profile itself (Binary, Three-Body, Stress Test) a center of any other kind is replaced.
 *
 * Expected values: the same profile deployed on a fresh page, compared object for object (ids left out) and bit for bit
 * after Worker frames; the presets (presets/celestials/sun.json: radius 696,340,000 m, no border; sgra_star.json); the
 * profile definitions (DEPLOY_PROFILES). Nothing is copied from the output of the code under test.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { GravSimObject } from '../../scripts/gravsim_object.js';
import { SOLAR_PLANETS } from '../../scripts/gravsim_object_placer.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { OBJECT_TYPES, OBJECT_STATE, DEPLOY_PROFILES, PHYSICS } from '../../scripts/gravsim_const.js';

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 20
// ------------------------------------------------------------------
let activeBridge = null;
class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		/** Main -> Worker messages but the returned buffers: { cmd, id } */
		this.sent = [];
		if (this.isPhysics) { PhysicsWorkerBridge.last = this; }
	}

	postMessage(msg) {
		if (!this.isPhysics || this.terminated) { return; }
		if (msg && msg.cmd !== 'returnBuffer') { this.sent.push({ cmd: msg.cmd, id: msg.id }); }
		const data = structuredClone(msg);
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

const DT = 0.1;
const SUB_STEPS = 10;
const FRAME_S = DT * SUB_STEPS;
/** Fixed-step replica of SimulationController.update(), delivering each frame to the main thread synchronously. */
const stepFrames = (bridge, frames) => {
	const e = bridge.ctrl.engine;
	for (let f = 0; f < frames; f++) {
		e._categorizeBodies();
		e._buildQuadTree(FRAME_S);
		e._checkCollisions(FRAME_S);
		e._checkRocheLimit();
		for (let i = 0; i < SUB_STEPS; i++) { e._moveObjects(DT); }
		e._updateEscapeStatus();
		const buf = WorkerBridge.formatWorkerToMain(e.objects);
		bridge.onmessage({ data: { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length } });
		e.removeDeadObjects();
	}
};

/** A page load: the id counter starts at 0 (the Sun of Universe.reset() gets id 0). */
const newUniverse = () => {
	GravSimObject._idCounter = 0;
	const universe = new Universe(createMockElement('canvas'));
	// The trajectory prediction is not under test here: skip it
	const launcher = universe.RocketLauncher;
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;
	launcher.requestPreviewUpdate = () => {};
	universe.updateUI(0);
	return { universe, bridge: PhysicsWorkerBridge.last };
};
/** Deploy › a profile button. */
const deploy = (universe, profileId) => {
	EventBus.emit('object:deploy-profile', profileId);
	universe.updateUI(0);
};
/** System › Clear Selected with every check box (debris, rockets, celestial bodies). */
const clearAll = (universe) => {
	EventBus.emit('simulation:clear-objects', true, true, true);
	universe.updateUI(0);
};
/** Deploy › a planet or star button (object:deploy-orbit-sun). */
const deployButton = (universe, name) => {
	EventBus.emit('object:deploy-orbit-sun', name);
	universe.updateUI(0);
};
const live = (universe) => universe.objects.filter((o) => o.state === OBJECT_STATE.ACTIVE && !o.isDestroyed);
const liveNames = (universe) => live(universe).map((o) => o.name).sort();

/** Math.random of a fixed sequence while `fn` runs (the swarms of Stress Test are random), the same on both sides. */
const seeded = (fn) => {
	const orig = Math.random;
	let x = 20261122;
	Math.random = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
	try { return fn(); } finally { Math.random = orig; }
};

/**
 * The world without ids: every object in the simulation in list order (the order of creation, which the Worker's pairing
 * reads), with what its kind gives it (name, param, radius, mass, colour, border, draw size), its role, its motion, and
 * what the Worker has of it.
 */
const worldOf = (universe, bridge) => live(universe).map((o) => {
	const w = bridge.ctrl.engine.objects.find((e) => e.id === o.id);
	return {
		name: o.name, type: o.type, isWorldCenter: o.isWorldCenter === true, isProfileWorldCenter: o.isProfileWorldCenter === true, param: o.param?.NAME ?? null,
		radius: o.radius, mass: o.mass, color: o.color, size: o.size, borderColor: o.borderColor, borderWidth: o.borderWidth,
		x: o.x, y: o.y, vx: o.vx, vy: o.vy,
		worker: w ? { radius: w.radius, mass: w.mass, param: w.param?.NAME ?? null } : null
	};
});
/** Kinematics of every live object in list order after `frames` Worker frames. */
const kinematics = (universe, bridge, frames) => {
	stepFrames(bridge, frames);
	return live(universe).map((o) => [o.name, o.x, o.y, o.vx, o.vy, o.mass]);
};
const sameBits = (a, b) => a.length === b.length && a.every((row, i) => row.every((v, j) => Object.is(v, b[i][j])));

/** The profile on a fresh page: its world, the camera's target, and its kinematics after `frames` frames. */
const freshWorld = (profileId, frames) => seeded(() => {
	const { universe, bridge } = newUniverse();
	deploy(universe, profileId);
	const world = worldOf(universe, bridge);
	const camera = universe.camera.trackingTarget?.name ?? null;
	const kin = kinematics(universe, bridge, frames);
	EventBus.clearAll();
	return { world, camera, kin };
});
/** Galactic Center (and Clear Selected of everything) first, a few frames, then the profile. */
const afterGalactic = (profileId, frames, { clear }) => {
	const w = newUniverse();
	deploy(w.universe, 'GALACTIC_CENTER');
	stepFrames(w.bridge, 3);
	if (clear) {
		clearAll(w.universe);
		assert.deepEqual(liveNames(w.universe), [presetManager.getObjectParam('SgrAStar').NAME], 'input: Clear Selected keeps Sgr A*, the center');
	}
	return seeded(() => {
		deploy(w.universe, profileId);
		const world = worldOf(w.universe, w.bridge);
		const camera = w.universe.camera.trackingTarget?.name ?? null;
		const center = w.universe.ObjectManager.getWorldCenter();
		const isPaused = w.universe.isPaused;
		const workerIds = w.bridge.ctrl.engine.objects.map((o) => o.id).sort((a, b) => a - b);
		const liveIds = live(w.universe).map((o) => o.id).sort((a, b) => a - b);
		const kin = kinematics(w.universe, w.bridge, frames);
		return { ...w, world, camera, center, isPaused, workerIds, liveIds, kin };
	});
};
const SUN = presetManager.getObjectParam('Sun');
const SGRA = presetManager.getObjectParam('SgrAStar');
const PREFIXES = [['Galactic Center', { clear: false }], ['Galactic Center, Clear Selected', { clear: true }]];

/**
 * The world of audit G3-3-01 (design §4.14-14): a fresh page; a BlackHole placed with the mouse onto the Sun destroys it;
 * System › Clear Selected (everything) empties the world; the user places `body` with the mouse (placeObject, as the
 * slingshot does), the first body of an empty world and so its center (§4.13-27, §4.14-13 (a)). The camera is left on the
 * destroyed Sun: the app's update loop is not run (with it the camera leaves the destroyed body and Clear Selected leaves
 * it on nothing; appUserCenterWorld). The messages to the Worker are recorded from here.
 */
const userCenterWorld = (body) => {
	const w = newUniverse();
	const sun = w.universe.objects[0];
	w.universe.ObjectPlacer.placeObject('BlackHole', sun.x + 0.001, sun.y, 0, 0);
	w.universe.updateUI(0);
	for (let f = 0; f < 20 && live(w.universe).includes(sun); f++) { stepFrames(w.bridge, 1); }
	assert.equal(live(w.universe).includes(sun), false, 'input: the BlackHole destroyed the Sun');
	clearAll(w.universe);
	stepFrames(w.bridge, 2);
	assert.deepEqual(live(w.universe), [], 'input: Clear Selected emptied the world');
	const user = w.universe.ObjectPlacer.placeObject(body, 450, 300, 0, 0);
	w.universe.updateUI(0);
	stepFrames(w.bridge, 2);
	const param = presetManager.getObjectParam(body);
	assert.deepEqual([w.universe.ObjectManager.getWorldCenter(), user.name, user.param?.NAME], [user, param.NAME, param.NAME], `input: the user's ${param.NAME}, the center`);
	assert.equal(w.universe.camera.trackingTarget, sun, 'input: the camera on the destroyed Sun');
	w.bridge.sent.length = 0;
	return { ...w, user, param };
};
/** The user's body in the list, the Worker and the save, as the center. */
const assertUserKept = (w, label) => {
	assert.ok(live(w.universe).includes(w.user), `${label}: in the simulation`);
	assert.equal(w.universe.ObjectManager.getWorldCenter(), w.user, `${label}: the center`);
	const inWorker = w.bridge.ctrl.engine.objects.find((o) => o.id === w.user.id);
	assert.deepEqual([inWorker?.radius, inWorker?.mass, inWorker?.param?.NAME], [w.param.RADIUS, UnitConvertUtils.ton2kg(w.param.MASS), w.param.NAME], `${label}: in the Worker (mass in kg)`);
	const saved = w.universe.getState().objectManager;
	assert.deepEqual(saved.map((o) => o.id), live(w.universe).map((o) => o.id), `${label}: the save has the objects in the simulation`);
	const s = saved.find((o) => o.id === w.user.id);
	assert.deepEqual([s?.name, s?.param?.NAME, s?.radius, s?.isWorldCenter, s?.isProfileWorldCenter], [w.param.NAME, w.param.NAME, w.param.RADIUS, true, false],
		`${label}: in the save, the center, not a profile's`);
	assert.deepEqual(w.bridge.sent.filter((m) => m.cmd === 'remove'), [], `${label}: nothing removed`);
};
/** A save to a file and its load into a new page (the JSON the save manager writes); the messages to the Worker are recorded from there. */
const saveAndLoad = (universe) => {
	const state = JSON.parse(JSON.stringify(universe.getState()));
	EventBus.clearAll();
	return loadInto(state);
};
/** A new page that loads `state` (Universe.loadState, as SaveManager does); the messages to the Worker are recorded from there. */
const loadInto = (state) => {
	const loaded = newUniverse();
	loaded.universe.loadState(state);
	loaded.universe.updateUI(0);
	loaded.bridge.sent.length = 0;
	return loaded;
};
/** Frames of the app: a Worker frame, then the main thread's update loop (camera fallback, removal of the faded objects, UI). */
const appFrames = (w, n) => {
	for (let i = 0; i < n; i++) {
		stepFrames(w.bridge, 1);
		EventBus.emitUpdate(FRAME_S * 1000, FRAME_S);
		w.universe.updateUI(0);
	}
};
/**
 * The world of audit G3-4-01 as the app makes it (the update loop after every Worker frame): the steps of userCenterWorld,
 * where the camera leaves the destroyed Sun and Clear Selected leaves it on nothing. `faded`: `body` is placed after the
 * removed objects have faded out of the list, else while they are still listed (§4.13-31). `camera`: 'app' (where the
 * loop leaves it) or 'user' (the user tracks the body). `load`: a save and a load before the placement under test; the
 * loop then puts the camera on the loaded body, the only one. The messages to the Worker are recorded from here.
 */
const appUserCenterWorld = (body, { faded, camera, load }) => {
	let w = newUniverse();
	const sun = w.universe.objects[0];
	w.universe.ObjectPlacer.placeObject('BlackHole', sun.x + 0.001, sun.y, 0, 0);
	w.universe.updateUI(0);
	for (let f = 0; f < 20 && live(w.universe).includes(sun); f++) { appFrames(w, 1); }
	assert.equal(live(w.universe).includes(sun), false, 'input: the BlackHole destroyed the Sun');
	clearAll(w.universe);
	assert.deepEqual(live(w.universe), [], 'input: Clear Selected emptied the world');
	if (faded) {
		for (let f = 0; f < 3000 && w.universe.objects.length > 0; f++) { appFrames(w, 1); }
		assert.deepEqual(w.universe.objects, [], 'input: the removed objects have faded out of the list');
	} else {
		assert.ok(w.universe.objects.length > 0, 'input: the removed objects are still listed');
	}
	let user = w.universe.ObjectPlacer.placeObject(body, 450, 300, 0, 0);
	w.universe.updateUI(0);
	appFrames(w, 2);
	if (camera === 'user') { EventBus.emit('camera:set-tracking-target', user); }
	if (load) {
		const id = user.id;
		w = saveAndLoad(w.universe);
		appFrames(w, 2);
		user = live(w.universe).find((o) => o.id === id);
		if (camera === 'user') { EventBus.emit('camera:set-tracking-target', user); }
	}
	const param = presetManager.getObjectParam(body);
	assert.deepEqual([w.universe.ObjectManager.getWorldCenter(), user?.name, user?.param?.NAME, user?.isProfileWorldCenter], [user, param.NAME, param.NAME, false],
		`input: the user's ${param.NAME}, the center, not a profile's`);
	assert.equal(w.universe.camera.trackingTarget ?? null, (camera === 'user' || load) ? user : null, 'input: the camera on the body (tracked, or after the load) or on nothing');
	w.bridge.sent.length = 0;
	return { ...w, user, param };
};
/** `obj` (preset `name`) placed by a Deploy button around `host` ({ x, y, vx, vy, mass } before): at its perihelion distance and speed (vis-viva). */
const assertAtPerihelion = (obj, host, name, label) => {
	const p = presetManager.getObjectParam(name);
	const aM = UnitConvertUtils.au2m(p.A);
	const rpM = aM * (1 - p.E);
	const vpM = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(host.mass + p.MASS) * (2 / rpM - 1 / aM));
	assert.equal(obj?.name, p.NAME, `${label}: the body`);
	assert.ok(Math.abs(Math.hypot(obj.x - host.x, obj.y - host.y) / UnitConvertUtils.m2pix(rpM) - 1) < 1e-9, `${label}: at its perihelion distance from the host`);
	assert.ok(Math.abs(Math.hypot(obj.vx - host.vx, obj.vy - host.vy) / UnitConvertUtils.m2pix(vpM) - 1) < 1e-9, `${label}: at its perihelion speed around the host (vis-viva)`);
};
/** Clear Selected and `button` on a fresh page: the page's Sun (the canvas center, at rest) and what the button adds. */
const freshButton = (button) => {
	const fresh = newUniverse();
	clearAll(fresh.universe);
	deployButton(fresh.universe, button);
	const world = worldOf(fresh.universe, fresh.bridge);
	const camera = fresh.universe.camera.trackingTarget?.name ?? null;
	EventBus.clearAll();
	return { world, camera };
};

describe('Regression 21: every profile builds the world of a fresh page after Galactic Center (design §4.13-27, -32, §4.14-12, -14)', () => {
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

	afterEach(() => {
		EventBus.clearAll();
	});

	it('input: the five profiles of the Deploy tab, the Sun and Sgr A* presets, Galactic Center\'s own center', () => {
		assert.deepEqual(Object.keys(DEPLOY_PROFILES).sort(), ['BINARY_SYSTEM', 'DEBUG_STRESS_TEST', 'GALACTIC_CENTER', 'SOLAR_SYSTEM', 'THREE_BODY']);
		assert.deepEqual([SUN.NAME, SUN.RADIUS, SUN.BORDER_COLOR ?? null, SUN.BORDER_WIDTH ?? 0], ['Sun', 696340000, null, 0], 'presets/celestials/sun.json');
		assert.deepEqual([SGRA.NAME, SGRA.RADIUS, SGRA.BORDER_COLOR, SGRA.BORDER_WIDTH], ['Sagittarius A*', 1.27e10, '#FF4500', 0.1], 'presets/celestials/sgra_star.json');
		assert.deepEqual(DEPLOY_PROFILES.GALACTIC_CENTER.staticObjects.filter((d) => d.worldCenter).map((d) => d.template), ['SgrAStar']);
		assert.deepEqual(['BINARY_SYSTEM', 'THREE_BODY', 'DEBUG_STRESS_TEST', 'GALACTIC_CENTER'].map((id) => DEPLOY_PROFILES[id].clearPrevious), [true, true, true, true]);
		assert.equal(DEPLOY_PROFILES.SOLAR_SYSTEM.clearPrevious, false, 'Solar System adds to the world');
		assert.equal(DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.template, 'Sun');
		assert.equal(DEPLOY_PROFILES.THREE_BODY.generators[0].stars[0].template, 'Sun');
	});

	describe('A. the profiles with a clear of their own (Binary, Three-Body, Stress Test, Galactic Center)', () => {
		it('normal (real path): Binary Star System: "Sun A" is a Sun (radius 6.9634e8 m, no border, param Sun, also in the Worker); the world of a fresh page, bit for bit after 20 frames', () => {
			const fresh = freshWorld('BINARY_SYSTEM', 20);
			const primary = DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary;
			assert.deepEqual(fresh.world.map((o) => o.name), [primary.name, 'Sun B', 'Earth', 'Moon', 'Jupiter'], 'input: the fresh page');
			for (const [label, opts] of PREFIXES) {
				const r = afterGalactic('BINARY_SYSTEM', 20, opts);
				const sunA = r.world[0];
				assert.deepEqual([sunA.name, sunA.isWorldCenter, sunA.param, sunA.radius, sunA.borderColor, sunA.borderWidth], [primary.name, true, 'Sun', 696340000, null, 0],
					`${label}: Sun A has the Sun's kind (it kept Sgr A*'s radius 1.27e10 m, border #FF4500 / 0.1 and param)`);
				assert.deepEqual(sunA.worker, { radius: 696340000, mass: fresh.world[0].worker.mass, param: 'Sun' }, `${label}: and so in the Worker`);
				assert.deepEqual(r.world, fresh.world, `${label}: object for object as on a fresh page (ids left out)`);
				assert.equal(r.center?.name, primary.name, `${label}: the world center`);
				assert.deepEqual([r.camera, r.isPaused], [fresh.camera, false], `${label}: the camera on Sun A, running`);
				assert.deepEqual(r.workerIds, r.liveIds, `${label}: the Worker has the same objects`);
				assert.ok(sameBits(r.kin, fresh.kin), `${label}: identical after 20 frames`);
				EventBus.clearAll();
			}
		});

		it('normal (real path): Three-Body Problem: "Sun A (Trisolaris 1)" is a Sun; the world of a fresh page, bit for bit after 20 frames', () => {
			const fresh = freshWorld('THREE_BODY', 20);
			const first = DEPLOY_PROFILES.THREE_BODY.generators[0].stars[0];
			assert.equal(fresh.world[0].name, first.name, 'input: the fresh page');
			for (const [label, opts] of PREFIXES) {
				const r = afterGalactic('THREE_BODY', 20, opts);
				const star = r.world[0];
				assert.deepEqual([star.name, star.isWorldCenter, star.param, star.radius, star.borderColor, star.borderWidth, star.worker.radius, star.worker.param],
					[first.name, true, 'Sun', 696340000, null, 0, 696340000, 'Sun'], `${label}: the first star has the Sun's kind`);
				assert.deepEqual(r.world, fresh.world, `${label}: object for object as on a fresh page`);
				assert.deepEqual([r.camera, r.isPaused], [fresh.camera, false]);
				assert.deepEqual(r.workerIds, r.liveIds);
				assert.ok(sameBits(r.kin, fresh.kin), `${label}: identical after 20 frames`);
				EventBus.clearAll();
			}
		});

		it('normal (real path): Stress Test: its swarms go around a Sun at the center (they placed nothing around Sgr A*); the world of a fresh page (same random numbers)', () => {
			const fresh = freshWorld('DEBUG_STRESS_TEST', 2);
			const gens = DEPLOY_PROFILES.DEBUG_STRESS_TEST.generators;
			assert.equal(fresh.world.length, 1 + gens.reduce((n, g) => n + g.count, 0), 'input: the Sun and the swarms on a fresh page');
			for (const [label, opts] of PREFIXES) {
				const r = afterGalactic('DEBUG_STRESS_TEST', 2, opts);
				assert.deepEqual([r.world[0].name, r.world[0].isWorldCenter, r.world[0].radius, r.world[0].param], ['Sun', true, 696340000, 'Sun'], `${label}: the Sun of a fresh page`);
				assert.deepEqual(r.world, fresh.world, `${label}: object for object as on a fresh page`);
				assert.deepEqual(r.workerIds, r.liveIds);
				assert.ok(sameBits(r.kin, fresh.kin), `${label}: identical after 2 frames`);
				EventBus.clearAll();
			}
		});

		it('normal (real path): Galactic Center again: the world of a fresh page, also after Clear Selected', () => {
			const fresh = freshWorld('GALACTIC_CENTER', 10);
			for (const [label, opts] of PREFIXES) {
				const r = afterGalactic('GALACTIC_CENTER', 10, opts);
				assert.deepEqual([r.world[0].name, r.world[0].isWorldCenter, r.world[0].radius], ['Sagittarius A*', true, 1.27e10], `${label}: Sgr A* the center`);
				assert.deepEqual(r.world, fresh.world, label);
				assert.ok(sameBits(r.kin, fresh.kin), `${label}: identical after 10 frames`);
				EventBus.clearAll();
			}
		});
	});

	describe('B. Solar System and the Deploy buttons, which go around the Sun', () => {
		it('normal (real path): Galactic Center, Clear Selected, Solar System: the Sun the center and its 20 bodies as on a fresh page, bit for bit; the simulation runs (it threw and stayed paused)', () => {
			const fresh = freshWorld('SOLAR_SYSTEM', 20);
			assert.deepEqual([fresh.world.length, fresh.world[0].name, fresh.world[0].isWorldCenter], [1 + DEPLOY_PROFILES.SOLAR_SYSTEM.staticObjects.length, 'Sun', true], 'input: the fresh page');
			const r = afterGalactic('SOLAR_SYSTEM', 20, { clear: true });
			assert.equal(r.isPaused, false, 'not left paused');
			assert.deepEqual([r.world[0].name, r.world[0].isWorldCenter, r.world[0].radius, r.world[0].borderColor, r.world[0].param], ['Sun', true, 696340000, null, 'Sun']);
			assert.deepEqual(r.world, fresh.world, 'object for object as on a fresh page');
			assert.deepEqual(r.workerIds, r.liveIds, 'Sgr A* is gone on both sides');
			assert.equal(r.camera, 'Sun', 'the camera on the new center, as on a fresh page');
			assert.ok(sameBits(r.kin, fresh.kin), 'identical after 20 frames');
			// Clear Selected keeps the new center, as on a fresh page
			clearAll(r.universe);
			assert.deepEqual(liveNames(r.universe), ['Sun']);
		});

		it('normal (real path): Galactic Center, then Solar System without a clear: the galactic world stays, the 20 bodies go around its Sun as on a fresh page around the center', () => {
			const fresh = seeded(() => {
				const { universe, bridge } = newUniverse();
				deploy(universe, 'SOLAR_SYSTEM');
				return worldOf(universe, bridge);
			});
			EventBus.clearAll();
			const { universe, bridge } = newUniverse();
			deploy(universe, 'GALACTIC_CENTER');
			const galactic = worldOf(universe, bridge);
			deploy(universe, 'SOLAR_SYSTEM');
			const world = worldOf(universe, bridge);
			assert.deepEqual(world.slice(0, galactic.length), galactic, 'the galactic bodies unchanged, Sgr A* the center');
			const added = world.slice(galactic.length);
			const sun = galactic.find((o) => o.name === 'Sun');
			const fSun = fresh[0];
			assert.equal(added.length, fresh.length - 1, 'the 20 bodies');
			const kind = (o) => [o.name, o.type, o.isWorldCenter, o.param, o.radius, o.mass, o.color, o.size, o.borderColor, o.borderWidth, o.worker];
			assert.deepEqual(added.map(kind), fresh.slice(1).map(kind), 'the same bodies');
			// Relative to the Sun as on the fresh page around the center (rounding of the Sun's position, 950 AU from Sgr A*)
			const tolX = 1e-12 * Math.hypot(sun.x, sun.y);
			const tolV = 1e-12 * Math.hypot(sun.vx, sun.vy);
			for (let i = 0; i < added.length; i++) {
				const a = added[i];
				const f = fresh[i + 1];
				assert.ok(Math.abs((a.x - sun.x) - (f.x - fSun.x)) <= tolX && Math.abs((a.y - sun.y) - (f.y - fSun.y)) <= tolX, `${a.name}: position around the Sun`);
				assert.ok(Math.abs((a.vx - sun.vx) - (f.vx - fSun.vx)) <= tolV && Math.abs((a.vy - sun.vy) - (f.vy - fSun.vy)) <= tolV, `${a.name}: velocity around the Sun`);
			}
			assert.equal(universe.ObjectManager.getWorldCenter()?.name, 'Sagittarius A*');
		});

		it('normal (real path): Galactic Center, Clear Selected, then the Earth button or the Sun button: as after Clear Selected on a fresh page', () => {
			for (const button of ['Earth', 'Sun']) {
				const fresh = newUniverse();
				clearAll(fresh.universe);
				deployButton(fresh.universe, button);
				const freshWorldNow = worldOf(fresh.universe, fresh.bridge);
				const freshCamera = fresh.universe.camera.trackingTarget?.name;
				EventBus.clearAll();
				const r = newUniverse();
				deploy(r.universe, 'GALACTIC_CENTER');
				clearAll(r.universe);
				deployButton(r.universe, button);
				assert.deepEqual(worldOf(r.universe, r.bridge), freshWorldNow, `${button}: around a Sun at the center (it went around Sgr A*, the camera target)`);
				assert.equal(r.universe.camera.trackingTarget?.name, freshCamera, `${button}: the camera`);
				EventBus.clearAll();
			}
			// Without the clear the galactic Sun is there: Earth goes around it, Sgr A* stays the center
			const { universe } = newUniverse();
			deploy(universe, 'GALACTIC_CENTER');
			const gSun = live(universe).find((o) => o.name === 'Sun');
			deployButton(universe, 'Earth');
			const earth = live(universe).find((o) => o.name === 'Earth');
			const p = presetManager.getObjectParam('Earth');
			const rp = UnitConvertUtils.m2pix(UnitConvertUtils.au2m(p.A) * (1 - p.E));
			assert.ok(Math.abs(Math.hypot(earth.x - gSun.x, earth.y - gSun.y) / rp - 1) < 1e-9, 'Earth at its perihelion from the galactic Sun');
			assert.equal(universe.ObjectManager.getWorldCenter()?.name, 'Sagittarius A*');
		});
	});

	describe('C. what the rule leaves as it is', () => {
		it('abnormal: a center of another kind with other bodies (Galactic Center whose Sun was destroyed): Solar System does not replace Sgr A*', () => {
			const { universe, bridge } = newUniverse();
			deploy(universe, 'GALACTIC_CENTER');
			universe.removeObject(live(universe).find((o) => o.name === 'Sun'));
			const before = worldOf(universe, bridge);
			bridge.sent.length = 0;
			// The placement still finds no Sun (the name "Sun" of the profile, H2-1 of the redesign inputs; it throws)
			try { deploy(universe, 'SOLAR_SYSTEM'); } catch { /* H2-1 */ }
			assert.deepEqual(worldOf(universe, bridge), before, 'the stars keep Sgr A*: nothing removed, nothing placed');
			assert.deepEqual(bridge.sent.filter((m) => m.cmd === 'remove' || m.cmd === 'add'), []);
		});

		it('abnormal: rockets left by Clear Selected › celestial bodies: the new Sun is the center although an object is in the simulation; the camera stays on a rocket it tracks', () => {
			for (const tracked of [false, true]) {
				const { universe } = newUniverse();
				deploy(universe, 'GALACTIC_CENTER');
				const rocket = universe.ObjectPlacer.placeObject('Rocket', 1e6, 0, 0, 0);
				EventBus.emit('simulation:clear-objects', false, false, true);
				assert.deepEqual(liveNames(universe), ['Rocket', 'Sagittarius A*'], 'input: the rocket and the center left');
				if (tracked) { EventBus.emit('camera:set-tracking-target', rocket); }
				deploy(universe, 'SOLAR_SYSTEM');
				const center = universe.ObjectManager.getWorldCenter();
				assert.deepEqual([center?.name, center?.radius, live(universe).filter((o) => o.isWorldCenter === true).length], ['Sun', 696340000, 1], `tracked ${tracked}: the Sun, the only center`);
				assert.equal(live(universe).length, 1 + 1 + DEPLOY_PROFILES.SOLAR_SYSTEM.staticObjects.length, 'the rocket, the Sun and its 20 bodies');
				assert.equal(universe.camera.trackingTarget, tracked ? rocket : center, `tracked ${tracked}: the camera`);
				EventBus.clearAll();
			}
		});

		it('boundary: a center of the kind is reused, not replaced (Binary twice, a legacy save without a param); without a center a new primary as before', () => {
			const { universe, bridge } = newUniverse();
			deploy(universe, 'BINARY_SYSTEM');
			const sunA = universe.ObjectManager.getWorldCenter();
			bridge.sent.length = 0;
			deploy(universe, 'BINARY_SYSTEM');
			assert.equal(universe.ObjectManager.getWorldCenter(), sunA, 'the same Sun A (a Sun by its param, whatever its name)');
			assert.equal(bridge.sent.some((m) => m.cmd === 'remove' && m.id === sunA.id), false);
			EventBus.clearAll();
			// A save written before the param and the center were saved: its id-0 body is the center, without a param
			const legacy = newUniverse();
			legacy.universe.ObjectManager.loadState([{ id: 0, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 400, y: 300, vx: 0, vy: 0, mass: SUN.MASS, radius: SUN.RADIUS }]);
			const loaded = legacy.universe.ObjectManager.getWorldCenter();
			assert.deepEqual([loaded?.id, loaded?.param ?? null], [0, null], 'input: the legacy center, no param');
			deploy(legacy.universe, 'BINARY_SYSTEM');
			assert.deepEqual([legacy.universe.ObjectManager.getWorldCenter(), loaded.name], [loaded, DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.name], 'reused as before');
			EventBus.clearAll();
			const none = newUniverse();
			none.universe.removeObject(none.universe.objects[0]);
			deploy(none.universe, 'THREE_BODY');
			assert.equal(none.universe.ObjectManager.getWorldCenter()?.name, DEPLOY_PROFILES.THREE_BODY.generators[0].stars[0].name, 'a new first star, the center');
		});
	});

	// ==================================================================
	// D. A body the user placed into the empty world (design §4.14-14; audits G3-3-01, G3-4-01). It is the world center
	// (§4.14-13 (a)). The replacement read only "another kind than the Sun, alone in the world", so the Deploy buttons and
	// Solar System removed it (also from the Worker and the save) and put a new Sun at the canvas center; restricted to
	// the kind of a profile's world center, it still removed a Sgr A* the user placed by hand. What adds to the world
	// replaces only the world center a profile placed (its flag, section E); a profile with its own clear replaces any
	// other kind. Expected values: the same buttons on a fresh page after Clear Selected, the profiles on a fresh page, the
	// presets, the outcome on main (git archive main, the same steps with the app's update loop) and on the Iteration 2
	// tree (where such a body became the center after the fade of the removed objects): the body stays for the buttons
	// and Solar System; the clear of a profile removed it on main too.
	// ==================================================================
	describe('D. a body the user placed into the empty world is its center: the placements that add to the world keep it (design §4.14-14)', () => {
		it('input: the world center of a profile is Sgr A* only (a Sgr A* the user places by hand has its kind, not its role); Jupiter and Sirius are of no profile\'s center', () => {
			const centers = Object.values(DEPLOY_PROFILES).flatMap((p) => (p.staticObjects || []).filter((d) => d.worldCenter === true).map((d) => presetManager.getObjectParam(d.template).NAME));
			assert.deepEqual(centers, [SGRA.NAME]);
			assert.deepEqual(['Jupiter', 'Sirius'].map((b) => presetManager.getObjectParam(b).NAME), ['Jupiter', 'Sirius']);
		});

		it('regression (G3-3-01): the user\'s Jupiter or Sirius, then the Earth, Mars or Sun button: it stays the center (list, Worker, save); the Sun and the planet of a fresh page are added beside it (it was removed and a new Sun made the center)', () => {
			for (const button of ['Earth', 'Mars', 'Sun']) {
				const ref = freshButton(button);
				assert.deepEqual([ref.world[0].name, ref.world[0].isWorldCenter, ref.world.length], ['Sun', true, button === 'Sun' ? 1 : 2], `input: ${button} on a fresh page`);
				for (const body of ['Jupiter', 'Sirius']) {
					const w = userCenterWorld(body);
					const before = worldOf(w.universe, w.bridge);
					deployButton(w.universe, button);
					assert.deepEqual(worldOf(w.universe, w.bridge), [before[0], { ...ref.world[0], isWorldCenter: false }, ...ref.world.slice(1)],
						`${body}, ${button}: the user's ${body} as it was, then a Sun at the canvas center (not the center) and what the button adds, as on a fresh page`);
					assert.equal(w.universe.camera.trackingTarget?.name, ref.camera, `${body}, ${button}: the camera as on a fresh page`);
					assertUserKept(w, `${body}, ${button}`);
					assert.deepEqual(w.bridge.ctrl.engine.objects.map((o) => o.id), live(w.universe).map((o) => o.id), `${body}, ${button}: the Worker has the same objects`);
					EventBus.clearAll();
				}
			}
		});

		it('regression (G3-3-01): the user\'s Jupiter or Sirius, then the Sirius button or Solar System: no Sun to go around, "Sun object not found" as on main when the camera points at no removed body (the app\'s update loop leaves it on nothing on this path) and on the Iteration 2 tree (the name "Sun", H2-1 of the redesign inputs); nothing removed, nothing placed (they removed the body and built around a new Sun)', () => {
			for (const body of ['Jupiter', 'Sirius']) {
				for (const [label, act] of [['the Sirius button', (u) => deployButton(u, 'Sirius')], ['Solar System', (u) => deploy(u, 'SOLAR_SYSTEM')]]) {
					const w = userCenterWorld(body);
					const before = worldOf(w.universe, w.bridge);
					// Solar System pauses first and stays paused (H2-1). This helper leaves the camera on the destroyed Sun, where
					// main would put Sirius (a removed camera target, which the Deploy buttons no longer take, §4.13-31); with the
					// app's update loop the camera leaves it and Clear Selected leaves it on nothing, and main throws the same
					// (audit G3-4-02 (4); the app's path with Sgr A*: the regression G3-4-01 below)
					assert.throws(() => act(w.universe), { message: 'Sun object not found in the universe.' }, `${body}, ${label}`);
					assert.deepEqual(worldOf(w.universe, w.bridge), before, `${body}, ${label}: the world as it was`);
					assertUserKept(w, `${body}, ${label}`);
					assert.deepEqual(w.bridge.sent.filter((m) => m.cmd === 'add'), [], `${body}, ${label}: nothing added`);
					EventBus.clearAll();
				}
			}
		});

		it('normal: the camera on the user\'s Jupiter: the Earth and Sirius buttons put the body around it at its perihelion (the camera\'s target, as on main); nothing removed', () => {
			for (const name of ['Earth', 'Sirius']) {
				const w = userCenterWorld('Jupiter');
				EventBus.emit('camera:set-tracking-target', w.user);
				const host = { x: w.user.x, y: w.user.y, vx: w.user.vx, vy: w.user.vy, mass: w.user.mass };
				deployButton(w.universe, name);
				assert.deepEqual(live(w.universe).map((o) => o.name), ['Jupiter', name], `${name}: added, no Sun placed`);
				const obj = live(w.universe)[1];
				const p = presetManager.getObjectParam(name);
				const aM = UnitConvertUtils.au2m(p.A);
				const rpM = aM * (1 - p.E);
				const vpM = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(host.mass + p.MASS) * (2 / rpM - 1 / aM));
				const dist = Math.hypot(obj.x - host.x, obj.y - host.y);
				const speed = Math.hypot(obj.vx - host.vx, obj.vy - host.vy);
				assert.ok(Math.abs(dist / UnitConvertUtils.m2pix(rpM) - 1) < 1e-9, `${name}: at its perihelion distance from Jupiter`);
				assert.ok(Math.abs(speed / UnitConvertUtils.m2pix(vpM) - 1) < 1e-9, `${name}: at its perihelion speed around Jupiter (vis-viva)`);
				assertUserKept(w, name);
				EventBus.clearAll();
			}
		});

		it('normal (real path): the user\'s Jupiter or Sirius, then a profile with its own clear (Binary, Three-Body, Stress Test, Galactic Center): the world of a fresh page, bit for bit; that clear removes the user\'s body with every other (also on main), and "Sun A" is a Sun, not the body renamed (it kept Jupiter\'s radius and param)', () => {
			for (const [profileId, frames] of [['BINARY_SYSTEM', 20], ['THREE_BODY', 20], ['DEBUG_STRESS_TEST', 2], ['GALACTIC_CENTER', 10]]) {
				const fresh = freshWorld(profileId, frames);
				for (const body of ['Jupiter', 'Sirius']) {
					const w = userCenterWorld(body);
					const r = seeded(() => {
						deploy(w.universe, profileId);
						const world = worldOf(w.universe, w.bridge);
						const camera = w.universe.camera.trackingTarget?.name ?? null;
						const workerIds = w.bridge.ctrl.engine.objects.map((o) => o.id);
						const liveIds = live(w.universe).map((o) => o.id);
						return { world, camera, workerIds, liveIds, kin: kinematics(w.universe, w.bridge, frames) };
					});
					assert.deepEqual([r.world[0].isWorldCenter, r.world[0].radius, r.world[0].param, r.world[0].worker.param], [true, fresh.world[0].radius, fresh.world[0].param, fresh.world[0].param], `${body}, ${profileId}: the center of a fresh page`);
					assert.deepEqual(r.world, fresh.world, `${body}, ${profileId}: object for object as on a fresh page`);
					assert.deepEqual([r.camera, w.universe.isPaused], [fresh.camera, false], `${body}, ${profileId}: the camera, running`);
					assert.deepEqual(r.workerIds, r.liveIds, `${body}, ${profileId}: the Worker has the same objects`);
					assert.ok(sameBits(r.kin, fresh.kin), `${body}, ${profileId}: identical after ${frames} frames`);
					assert.equal(w.universe.getState().objectManager.some((o) => o.id === w.user.id), false, `${body}, ${profileId}: the user's body not saved`);
					EventBus.clearAll();
				}
			}
		});

		it('regression (G3-4-01): a Sgr A* the user placed by hand into the empty world (Deploy › Object Mass lists every preset) has the kind of Galactic Center\'s center but not its role: each of the 12 Sun, planet and dwarf-planet buttons, the 7 star buttons and Solar System keeps it the center (list, Worker, save) with the outcome of main, with the app\'s camera or the camera on it, placed while the removed objects fade or after, with a save and a load before (they removed it and built around a new Sun)', () => {
			// The buttons of the Deploy tab that go around the Sun (gravsim_tab_deploy.js: deployButtons, dwarfPlanets, otherStars)
			const STARS = ['Betelgeuse', 'Sirius', 'AlphaCentauriA', 'ProximaCentauri', 'Rigel', 'Vega', 'Polaris'];
			const BUTTONS = ['Sun', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Ceres', 'Eris', ...STARS];
			assert.deepEqual(BUTTONS.filter((b) => b !== 'Sun' && !STARS.includes(b)), [...SOLAR_PLANETS], 'input: the planets and dwarf planets, for which the placer places a missing Sun');
			const refs = new Map(BUTTONS.map((b) => [b, freshButton(b)]));
			let cases = 0;
			for (const faded of [false, true]) {
				for (const camera of ['app', 'user']) {
					for (const load of [false, true]) {
						for (const action of [...BUTTONS, 'SOLAR_SYSTEM']) {
							const w = appUserCenterWorld('SgrAStar', { faded, camera, load });
							const label = `${action} (${faded ? 'faded' : 'listed'}, camera ${camera}${load ? ', loaded' : ''})`;
							const host = w.universe.camera.trackingTarget === w.user ? { x: w.user.x, y: w.user.y, vx: w.user.vx, vy: w.user.vy, mass: w.user.mass } : null;
							const before = worldOf(w.universe, w.bridge);
							const ref = refs.get(action);
							// main (git archive main; the app's update loop): the Sun button puts a Sun at the canvas center; a planet goes
							// around the camera's target, else around a Sun placed at the canvas center (not the center); a star around
							// the camera's target, else "Sun object not found"; Solar System throws and stays paused (H2-1)
							if (action === 'SOLAR_SYSTEM' || (STARS.includes(action) && !host)) {
								assert.throws(() => (action === 'SOLAR_SYSTEM' ? deploy(w.universe, action) : deployButton(w.universe, action)), { message: 'Sun object not found in the universe.' }, label);
								assert.deepEqual(worldOf(w.universe, w.bridge), before, `${label}: nothing placed`);
								assert.deepEqual([w.universe.camera.trackingTarget?.name ?? null, w.universe.isPaused], [host ? SGRA.NAME : null, action === 'SOLAR_SYSTEM'], `${label}: the camera; paused by Solar System only (H2-1)`);
							} else if (action === 'Sun' || !host) {
								deployButton(w.universe, action);
								assert.deepEqual(worldOf(w.universe, w.bridge), [...before, { ...ref.world[0], isWorldCenter: false }, ...ref.world.slice(1)],
									`${label}: Sgr A* as it was, then a Sun at the canvas center (not the center) and what the button adds, as on a fresh page`);
								assert.equal(w.universe.camera.trackingTarget?.name, ref.camera, `${label}: the camera as on a fresh page`);
							} else {
								deployButton(w.universe, action);
								const now = live(w.universe);
								assert.deepEqual(now.map((o) => o.name), [SGRA.NAME, presetManager.getObjectParam(action).NAME], `${label}: added around Sgr A* (the camera's target), no Sun placed`);
								const obj = now[1];
								assertAtPerihelion(obj, host, action, label);
								assert.equal(w.universe.camera.trackingTarget, STARS.includes(action) ? w.user : obj, `${label}: the camera on the planet, a star leaves it on Sgr A*`);
							}
							assertUserKept(w, label);
							assert.deepEqual(w.bridge.ctrl.engine.objects.map((o) => o.id), live(w.universe).map((o) => o.id), `${label}: the Worker has the same objects`);
							assert.deepEqual(w.universe.getState().objectManager.filter((o) => o.isProfileWorldCenter !== false).map((o) => o.name), [], `${label}: no profile center saved (false on every body)`);
							cases++;
							EventBus.clearAll();
						}
					}
				}
			}
			assert.equal(cases, 2 * 2 * 2 * 20);
		});

		it('normal: after a save and a load the rule is the same (it reads the saved flag): the user\'s Jupiter stays at the Sun button and Solar System; Sgr A* of Galactic Center, after Clear Selected, is replaced by the Sun of a fresh page', () => {
			for (const [label, act, names] of [['the Sun button', (u) => deployButton(u, 'Sun'), ['Jupiter', 'Sun']], ['Solar System', (u) => deploy(u, 'SOLAR_SYSTEM'), null]]) {
				const u = userCenterWorld('Jupiter');
				const l = saveAndLoad(u.universe);
				const center = l.universe.ObjectManager.getWorldCenter();
				assert.deepEqual([center?.id, center?.param?.NAME, live(l.universe).length], [u.user.id, 'Jupiter', 1], `input (${label}): the loaded Jupiter, the center`);
				const w = { ...l, user: center, param: u.param };
				if (names) { act(l.universe); } else { assert.throws(() => act(l.universe), { message: 'Sun object not found in the universe.' }, `loaded, ${label}: as without the load (H2-1)`); }
				assertUserKept(w, `loaded, ${label}`);
				assert.deepEqual(live(l.universe).map((o) => o.name), names || ['Jupiter'], `loaded, ${label}: as without the load`);
				EventBus.clearAll();
			}
			const ref = freshButton('Sun');
			const g = newUniverse();
			deploy(g.universe, 'GALACTIC_CENTER');
			const l = saveAndLoad(g.universe);
			clearAll(l.universe);
			assert.deepEqual([liveNames(l.universe), l.universe.ObjectManager.getWorldCenter()?.param?.NAME], [[SGRA.NAME], SGRA.NAME], 'input: the loaded Sgr A*, the center, alone');
			deployButton(l.universe, 'Sun');
			assert.deepEqual(worldOf(l.universe, l.bridge), ref.world, 'loaded Galactic Center, Clear Selected, the Sun button: as on a fresh page');
		});
	});

	// ==================================================================
	// E. The role of the profile's world center (design §4.14-14, §3.5-1; audit G3-4-01): CelestialBody.isProfileWorldCenter
	// is given to the body a profile places from its static object marked worldCenter (Sgr A* of Galactic Center) and saved
	// with it; every other body, and every center a placement makes, has it false. Only true in a file marks the role, so a
	// save without it (every save before §4.14-14, also of main) has no profile center and the Deploy buttons and Solar
	// System keep its center. Expected values: DEPLOY_PROFILES (the static object marked worldCenter), the world of a fresh
	// page, the rule of the design.
	// ==================================================================
	describe('E. the flag of the profile\'s world center (design §4.14-14, §3.5-1)', () => {
		/** Celestial bodies in the list (also those fading out) whose flag is not strictly false. */
		const flagged = (universe) => universe.objects.filter((o) => o.type === OBJECT_TYPES.CELESTIAL && o.isProfileWorldCenter !== false).map((o) => o.name);
		/** The flag of every celestial body in the save (rockets and debris have none). */
		const savedFlags = (universe) => universe.getState().objectManager.filter((o) => o.type === OBJECT_TYPES.CELESTIAL).map((o) => [o.name, o.isProfileWorldCenter]);

		it('normal: Galactic Center gives the flag to its Sgr A* only (also in the save, as a boolean on every celestial body); it stays through Clear Selected; a second Galactic Center gives it to its new Sgr A* and removes the old one', () => {
			const { universe } = newUniverse();
			assert.deepEqual(flagged(universe), [], 'the Sun of the page has it false');
			deploy(universe, 'GALACTIC_CENTER');
			const sgra = universe.ObjectManager.getWorldCenter();
			assert.deepEqual([sgra?.param?.NAME, sgra?.isWorldCenter, sgra?.isProfileWorldCenter], [SGRA.NAME, true, true], 'Sgr A*, the center of the profile');
			assert.deepEqual(flagged(universe), [SGRA.NAME], 'no other body has it (the page Sun removed, the stars and the Sun of the profile placed)');
			const statics = DEPLOY_PROFILES.GALACTIC_CENTER.staticObjects;
			assert.deepEqual(savedFlags(universe), live(universe).map((o) => [o.name, o === sgra]), 'saved: true for Sgr A*, false for the others');
			assert.equal(live(universe).length, statics.length, 'input: the bodies of the profile');
			clearAll(universe);
			assert.deepEqual([liveNames(universe), universe.ObjectManager.getWorldCenter(), sgra.isProfileWorldCenter], [[SGRA.NAME], sgra, true], 'Clear Selected keeps the center and its flag');
			deploy(universe, 'GALACTIC_CENTER');
			const again = universe.ObjectManager.getWorldCenter();
			assert.notEqual(again, sgra, 'a new Sgr A*');
			assert.equal(sgra.state, OBJECT_STATE.REMOVED, 'the old one removed');
			assert.deepEqual(live(universe).filter((o) => o.isProfileWorldCenter === true), [again], 'the new Sgr A* has the flag');
		});

		it('normal: no center a placement makes has the flag: the Sun that replaces Sgr A* (the Sun, Earth and Sirius buttons, Solar System, Stress Test), "Sun A" and the first star of the generators (after Galactic Center and on a fresh page), the Sun of Reset, a body placed into the empty world', () => {
			const cases = [
				['Galactic Center, Binary', (u) => deploy(u, 'BINARY_SYSTEM'), DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.name],
				['Galactic Center, Clear Selected, Three-Body', (u) => { clearAll(u); deploy(u, 'THREE_BODY'); }, DEPLOY_PROFILES.THREE_BODY.generators[0].stars[0].name],
				['Galactic Center, Stress Test', (u) => seeded(() => deploy(u, 'DEBUG_STRESS_TEST')), 'Sun'],
				['Galactic Center, Clear Selected, Solar System', (u) => { clearAll(u); deploy(u, 'SOLAR_SYSTEM'); }, 'Sun'],
				['Galactic Center, Clear Selected, the Sun button', (u) => { clearAll(u); deployButton(u, 'Sun'); }, 'Sun'],
				['Galactic Center, Clear Selected, the Earth button', (u) => { clearAll(u); deployButton(u, 'Earth'); }, 'Sun'],
				['Galactic Center, Clear Selected, the Sirius button', (u) => { clearAll(u); deployButton(u, 'Sirius'); }, 'Sun']
			];
			for (const [label, act, centerName] of cases) {
				const { universe } = newUniverse();
				deploy(universe, 'GALACTIC_CENTER');
				const sgra = universe.ObjectManager.getWorldCenter();
				act(universe);
				const center = universe.ObjectManager.getWorldCenter();
				assert.deepEqual([center?.name, center?.param?.NAME, sgra.state], [centerName, 'Sun', OBJECT_STATE.REMOVED], `input (${label}): Sgr A* replaced by a Sun`);
				assert.deepEqual(flagged(universe).filter((n, i, a) => a.indexOf(n) === i), [SGRA.NAME], `${label}: only the removed Sgr A* (fading out) has it`);
				assert.deepEqual(savedFlags(universe).filter(([, f]) => f !== false), [], `${label}: nothing saved with it`);
				EventBus.clearAll();
			}
			for (const [label, act] of [
				['Binary on a fresh page (the page Sun becomes Sun A)', (u) => deploy(u, 'BINARY_SYSTEM')],
				['Three-Body on a fresh page', (u) => deploy(u, 'THREE_BODY')],
				['Reset', (u) => { u.reset(); u.updateUI(0); }],
				['a Jupiter placed into the empty world', (u) => { u.removeObject(u.objects[0]); u.ObjectPlacer.placeObject('Jupiter', 450, 300, 0, 0); }],
				['a Sgr A* placed into the empty world', (u) => { u.removeObject(u.objects[0]); u.ObjectPlacer.placeObject('SgrAStar', 450, 300, 0, 0); }]
			]) {
				const { universe } = newUniverse();
				act(universe);
				assert.ok(universe.ObjectManager.getWorldCenter(), `input (${label}): a center`);
				assert.deepEqual(flagged(universe), [], `${label}: no body has it`);
				assert.deepEqual(savedFlags(universe).filter(([, f]) => f !== false), [], `${label}: nothing saved with it`);
				EventBus.clearAll();
			}
		});

		it('normal (real path): the flag is saved and loaded: Galactic Center, Clear Selected, save, load, then the Sun or Earth button or Solar System builds the world of a fresh page (Sgr A* replaced), as without the load', () => {
			const g = newUniverse();
			deploy(g.universe, 'GALACTIC_CENTER');
			clearAll(g.universe);
			const file = JSON.parse(JSON.stringify(g.universe.getState()));
			EventBus.clearAll();
			assert.deepEqual(file.objectManager.map((o) => [o.name, o.isWorldCenter, o.isProfileWorldCenter]), [[SGRA.NAME, true, true]], 'input: the file has Sgr A*, the center of the profile');
			const refs = { Sun: freshButton('Sun'), Earth: freshButton('Earth') };
			const freshSS = freshWorld('SOLAR_SYSTEM', 0);
			for (const action of ['Sun', 'Earth', 'SOLAR_SYSTEM']) {
				const l = loadInto(structuredClone(file));
				const loaded = l.universe.ObjectManager.getWorldCenter();
				assert.deepEqual([loaded?.name, loaded?.isProfileWorldCenter], [SGRA.NAME, true], `${action}: loaded with the flag`);
				if (action === 'SOLAR_SYSTEM') { seeded(() => deploy(l.universe, action)); } else { deployButton(l.universe, action); }
				assert.deepEqual(worldOf(l.universe, l.bridge), action === 'SOLAR_SYSTEM' ? freshSS.world : refs[action].world, `${action}: as on a fresh page`);
				assert.deepEqual([loaded.state, l.universe.isPaused], [OBJECT_STATE.REMOVED, false], `${action}: Sgr A* removed, running`);
				assert.deepEqual(l.bridge.ctrl.engine.objects.map((o) => o.id), live(l.universe).map((o) => o.id), `${action}: also in the Worker`);
				EventBus.clearAll();
			}
		});

		it('abnormal: only true in the file marks the role: false, a missing field (a save before §4.14-14, as of Galactic Center on this branch until now), and 1, "true", {}, [true], null are not; that Sgr A* stays the center as one the user placed: the Sun button adds a Sun at the canvas center, the Earth button puts Earth around it (the loaded camera\'s target), Solar System throws (H2-1)', () => {
			const g = newUniverse();
			deploy(g.universe, 'GALACTIC_CENTER');
			clearAll(g.universe);
			const file = JSON.parse(JSON.stringify(g.universe.getState()));
			EventBus.clearAll();
			const refs = { Sun: freshButton('Sun') };
			const sgraParam = presetManager.getObjectParam('SgrAStar');
			for (const [label, value] of [['false', false], ['missing', undefined], ['1', 1], ['"true"', 'true'], ['{}', {}], ['[true]', [true]], ['null', null]]) {
				for (const action of ['Sun', 'Earth', 'SOLAR_SYSTEM']) {
					const state = structuredClone(file);
					const entry = state.objectManager[0];
					if (value === undefined) { delete entry.isProfileWorldCenter; } else { entry.isProfileWorldCenter = value; }
					const l = loadInto(state);
					const user = l.universe.ObjectManager.getWorldCenter();
					const tag = `${label}, ${action}`;
					assert.deepEqual([user?.name, user?.isWorldCenter, user?.isProfileWorldCenter], [SGRA.NAME, true, false], `${tag}: loaded as a center that is not a profile's (strictly false)`);
					const w = { ...l, user, param: sgraParam };
					const before = worldOf(l.universe, l.bridge);
					if (action === 'SOLAR_SYSTEM') {
						assert.throws(() => deploy(l.universe, action), { message: 'Sun object not found in the universe.' }, tag);
						assert.deepEqual(worldOf(l.universe, l.bridge), before, `${tag}: nothing placed`);
					} else if (action === 'Sun') {
						deployButton(l.universe, action);
						assert.deepEqual(worldOf(l.universe, l.bridge), [...before, { ...refs.Sun.world[0], isWorldCenter: false }], `${tag}: Sgr A* kept, the Sun of a fresh page beside it (not the center)`);
					} else {
						assert.equal(l.universe.camera.trackingTarget, user, `input (${tag}): the saved camera target, Sgr A*`);
						const host = { x: user.x, y: user.y, vx: user.vx, vy: user.vy, mass: user.mass };
						deployButton(l.universe, action);
						assert.deepEqual(worldOf(l.universe, l.bridge).slice(0, before.length), before, `${tag}: Sgr A* kept`);
						assert.equal(live(l.universe).length, before.length + 1, `${tag}: Earth only, no Sun`);
						assertAtPerihelion(live(l.universe)[before.length], host, action, tag);
					}
					assertUserKept(w, tag);
					EventBus.clearAll();
				}
			}
		});

		it('boundary: the role is the flag, not the kind: a loaded center of another kind marked as a profile\'s (a Jupiter with true in the file) is replaced by the Sun button as Sgr A* is; with false it stays and the Sun is added beside it', () => {
			const jupiter = presetManager.getObjectParam('Jupiter');
			const file = (flag) => ({
				objectManager: [{
					id: 4, type: OBJECT_TYPES.CELESTIAL, name: jupiter.NAME, x: 450, y: 300, vx: 0, vy: 0, mass: jupiter.MASS, radius: jupiter.RADIUS,
					color: jupiter.COLOR, size: 1, generation: 0, rotationAngle: 0, param: structuredClone(jupiter), isWorldCenter: true, isProfileWorldCenter: flag
				}]
			});
			const ref = freshButton('Sun');
			for (const flag of [true, false]) {
				const l = loadInto(file(flag));
				const center = l.universe.ObjectManager.getWorldCenter();
				assert.deepEqual([center?.name, center?.isProfileWorldCenter], [jupiter.NAME, flag], `input (${flag}): the loaded Jupiter, the center`);
				const before = worldOf(l.universe, l.bridge);
				deployButton(l.universe, 'Sun');
				assert.deepEqual(worldOf(l.universe, l.bridge), flag ? ref.world : [...before, { ...ref.world[0], isWorldCenter: false }],
					flag ? 'true: replaced by the Sun of a fresh page' : 'false: kept, the Sun of a fresh page beside it (not the center)');
				assert.equal(center.state, flag ? OBJECT_STATE.REMOVED : OBJECT_STATE.ACTIVE, `${flag}: Jupiter ${flag ? 'removed' : 'kept'}`);
				EventBus.clearAll();
			}
		});

		it('boundary (audit G3-5-01): a file of the old format (no isWorldCenter on any body): the body with id 0 is the center (§4.13-27) and the flag is read on its own, strictly true: a Jupiter or Sgr A* with its param and no flag stays (the Sun button adds a Sun beside it, Solar System throws, as on main); a Sgr A* with true is a profile\'s center and the Sun button replaces it', () => {
			const ref = freshButton('Sun');
			const legacyFile = (name, flag) => {
				const p = presetManager.getObjectParam(name);
				const entry = {
					id: 0, type: OBJECT_TYPES.CELESTIAL, name: p.NAME, x: 450, y: 300, vx: 0, vy: 0, mass: p.MASS, radius: p.RADIUS,
					color: p.COLOR, size: 1, generation: 0, rotationAngle: 0, param: structuredClone(p)
				};
				if (flag !== undefined) { entry.isProfileWorldCenter = flag; }
				return { objectManager: [entry] };
			};
			for (const [name, flag] of [['Jupiter', undefined], ['SgrAStar', undefined], ['SgrAStar', true]]) {
				const p = presetManager.getObjectParam(name);
				const isProfile = flag === true;
				for (const action of ['Sun', 'SOLAR_SYSTEM']) {
					const tag = `${p.NAME}, flag ${String(flag)}, ${action}`;
					const state = legacyFile(name, flag);
					assert.equal(state.objectManager.some((o) => 'isWorldCenter' in o), false, `input (${tag}): no isWorldCenter in the file`);
					const l = loadInto(state);
					const center = l.universe.ObjectManager.getWorldCenter();
					assert.deepEqual([center?.id, center?.name, center?.isWorldCenter, center?.isProfileWorldCenter], [0, p.NAME, true, isProfile],
						`${tag}: id 0 is the center (the old-format rule); the role only by true in the file`);
					const before = worldOf(l.universe, l.bridge);
					if (action === 'SOLAR_SYSTEM') {
						if (isProfile) {
							seeded(() => deploy(l.universe, action));
							assert.equal(center.state, OBJECT_STATE.REMOVED, `${tag}: the profile's center replaced`);
							assert.equal(l.universe.ObjectManager.getWorldCenter()?.name, presetManager.getObjectParam('Sun').NAME, `${tag}: a Sun is the center`);
						} else {
							assert.throws(() => deploy(l.universe, action), { message: 'Sun object not found in the universe.' }, tag);
							assert.deepEqual(worldOf(l.universe, l.bridge), before, `${tag}: nothing placed, nothing removed`);
							assert.equal(center.state, OBJECT_STATE.ACTIVE, `${tag}: the center kept`);
						}
					} else {
						deployButton(l.universe, action);
						assert.deepEqual(worldOf(l.universe, l.bridge), isProfile ? ref.world : [...before, { ...ref.world[0], isWorldCenter: false }],
							isProfile ? `${tag}: replaced by the Sun of a fresh page` : `${tag}: kept, the Sun of a fresh page beside it (not the center)`);
						assert.equal(center.state, isProfile ? OBJECT_STATE.REMOVED : OBJECT_STATE.ACTIVE, `${tag}: ${isProfile ? 'removed' : 'kept'}`);
					}
					EventBus.clearAll();
				}
			}
		});
	});
});
