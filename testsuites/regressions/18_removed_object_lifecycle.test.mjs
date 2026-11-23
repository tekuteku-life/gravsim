/**
 * Regression Suite 18: objects that are removed or destroyed but still listed are not treated as live (design
 * §4.13-31), and the Galactic Center profile replaces the world center (§4.13-32).
 *
 * A removed object (System › Clear Selected, abort, escape, shatter, Reset, load) or a destroyed one (a collision)
 * stays in universe.objects with state REMOVED until its trail has faded, which takes seconds. The rule of a live object
 * is that of §4.13-23(a): state ACTIVE and not destroyed (isLiveObject of gravsim_utils.js). The instances:
 *
 *  1. A launch sequence ran on after its rocket was gone: the countdown, its callouts and the 'WATER DELUGE' event (the
 *     deluge then played for the empty pad until Reset); the launcher kept the rocket on its pad. LaunchSequencer aborts
 *     and RocketLauncher releases the pad on 'rocket:destroyed' of their rocket.
 *  2. A Worker frame made before a removal still has the removed objects: after Reset (and load) an unknown debris id was
 *     taken for debris the Worker had just spawned and the fragments came back on the main thread as "Jettisoned Debris",
 *     where nothing removed them again. Every 'remove' / 'clear' carries a sequence number; every frame carries the last
 *     one the Worker handled (syncSeq); data of an object removed after the frame was made, and every frame made before a
 *     Reset / load, is dropped; Reset / load clear the Worker's world ('clear'), debris it spawned in a frame still on its
 *     way included. A listed removed object takes no frame data.
 *  3. Saving right after Clear Selected saved the cleared objects (getState took every listed object).
 *  4. The Rocket tab offered debris and removed bodies as launch hosts.
 *  5. (§4.13-32) Deploy › Galactic Center kept the page's Sun at rest beside Sagittarius A* (two "Sun"): the profile's
 *     own center (worldCenter: true) replaces the world center, from a fresh page and after Reset alike.
 *  Sweep (the same pattern): the camera's last fallback, the camera's auto tracking, the trajectory prediction's bodies,
 *  the launcher's host and pad rocket, the System / Navi / telemetry lists, the object count, the reference body of the
 *  Navigation card and the Navi tab, the camera target restored by the Rocket tab, the Sun of the Deploy buttons, the
 *  host of the generators, the clear of Clear Selected and Reset.
 *  R7 (audit G3-2-03, design §4.14-13): sites the scan had allowed as drawing although they record or set a state take
 *  live objects too: the reference body of an effect-trail point, the host of the ORBIT pass of the prediction marks,
 *  the host of the pad effect (the pad stops with its host), the launcher's legacy automatic host on load. The scan also
 *  sees optional calls (`objects?.find?.(`), the length of a list, a `|| []` default and aliases of a list; the actual
 *  flight path, which is recorded for its own drawing only, stays allowed with that reason.
 *
 * Expected values: the rule of a live object (§4.13-23(a)), the launch sequence table (LAUNCH_SEQUENCES), the
 * DebrisGenerator fragment rule, the deploy profiles and the celestial presets (names), the same steps from a fresh page,
 * the Worker's own list of objects (what the main thread must mirror). Nothing is copied from the output of the code
 * under test.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { GravSimObject, CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { NavigationCameraCard } from '../../scripts/gravsim_telemetry_card.js';
import * as presetModule from '../../scripts/gravsim_preset_manager.js';
import * as utils from '../../scripts/gravsim_utils.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import {
	OBJECT_TYPES, OBJECT_STATE, DEPLOY_PROFILES, LAUNCH_SEQUENCES, DEBRIS, PHYSICS, SIMULATION, TRAJECTORY_PREDICTION,
	ROCKET_LAUNCHER_CONFIG
} from '../../scripts/gravsim_const.js';

const { presetManager } = presetModule;
const { UnitConvertUtils } = utils;
/** The rule under test, read through the namespace (a missing export fails only the tests that use it). */
const isLiveObject = (o) => utils.isLiveObject(o);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js')).sort()
	.map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')]);
/** Source without block and line comments, with the same line breaks (the comments name the history). */
const stripComments = (src) => src
	.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
	.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
/** Files that run only in a Worker (physics, predictor, flight computer). */
const WORKER_FILES = ['gravsim_calc.js', 'gravsim_calc_object.js', 'gravsim_calc_predictor.js', 'gravsim_flight_computer.js', 'gravsim_calc_quadtree.js'];
const MAIN_FILES = SCRIPTS.map(([f]) => f).filter((f) => !WORKER_FILES.includes(f));

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 17
// ------------------------------------------------------------------
let activeBridge = null;
class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		/** Main -> Worker messages but the returned buffers: { cmd, id, seq } */
		this.sent = [];
		if (this.isPhysics) { PhysicsWorkerBridge.last = this; }
	}

	postMessage(msg) {
		if (!this.isPhysics || this.terminated) { return; }
		if (msg && msg.cmd !== 'returnBuffer') { this.sent.push({ cmd: msg.cmd, id: msg.id, seq: msg.seq }); }
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

	/**
	 * One frame of the real SimulationController.update() lasting `seconds` of simulation time (a fixed clock: 16 ms of
	 * wall time at the time scale that makes them `seconds`). Its message is on its way: it reaches the main thread at
	 * the next flush(), after whatever the main thread does meanwhile (which the Worker handles first, as a real Worker
	 * handles messages that arrive before its next frame).
	 */
	frame(seconds = 1) {
		const ctrl = this.ctrl;
		const realNow = Date.now;
		const t = realNow();
		Date.now = () => t;
		const prev = activeBridge;
		activeBridge = this;
		const wasPaused = ctrl.isPaused;
		try {
			ctrl.isPaused = false;
			ctrl.lastTime = t - 16;
			// SimulationController.update() takes the elapsed wall time in ms (16): the frame lasted 1000 x `seconds` before
			ctrl.timeScale = seconds / (16 * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE);
			ctrl.update();
		} finally {
			ctrl.isPaused = wasPaused;
			activeBridge = prev;
			Date.now = realNow;
		}
	}

	terminate() { this.terminated = true; }
}
/** Deliver every Worker message on its way. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const DT = 0.1;
const SUB_STEPS = 10;
const FRAME_S = DT * SUB_STEPS;
/** Fixed-step replica of SimulationController.update(), delivering each frame to the main thread synchronously. */
const stepFrames = (bridge, frames, stopWhen = null) => {
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
		if (stopWhen && stopWhen()) { return true; }
	}
	return false;
};

let blobs = [];
/** A page load: the id counter starts at 0 (the Sun of Universe.reset() gets id 0). */
const newUniverse = () => {
	GravSimObject._idCounter = 0;
	const universe = new Universe(createMockElement('canvas'));
	// The trajectory prediction is not under test here (but in R6-3): skip it
	const launcher = universe.RocketLauncher;
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;
	launcher.requestPreviewUpdate = () => {};
	universe.updateUI(0);
	return { universe, bridge: PhysicsWorkerBridge.last };
};
/** System › Reset All (the button emits this event after its confirm dialog). */
const resetAll = (universe) => {
	EventBus.emit('simulation:reset');
	universe.updateUI(0);
};
/** System › Clear Selected with the given check boxes. */
const clearSelected = (universe, { debris = false, rockets = false, celestial = false }) => {
	EventBus.emit('simulation:clear-objects', debris, rockets, celestial);
	universe.updateUI(0);
};
const deploy = (universe, profileId) => {
	EventBus.emit('object:deploy-profile', profileId);
	universe.updateUI(0);
};
const deployPlanet = (universe, name) => {
	EventBus.emit('object:deploy-orbit-sun', name);
	universe.updateUI(0);
	const obj = universe.objects.filter((o) => o.name === name && o.state === OBJECT_STATE.ACTIVE).pop();
	assert.ok(obj, `input: ${name} deployed (presets/celestials loaded from the working directory)`);
	return obj;
};
const live = (universe) => universe.objects.filter((o) => o.state === OBJECT_STATE.ACTIVE && !o.isDestroyed);
const liveNames = (universe) => live(universe).map((o) => o.name).sort();
const workerIds = (bridge) => bridge.ctrl.engine.objects.map((o) => o.id).sort((a, b) => a - b);
const liveIds = (universe) => live(universe).map((o) => o.id).sort((a, b) => a - b);
const tabButton = (target) => {
	const btn = createMockElement('button');
	btn.setAttribute('data-target', target);
	return btn;
};
const openTab = (universe, target) => universe.ControlPanel._tabBtnClick({ target: tabButton(target) });
const optionsOf = (select) => Array.from(select.children).map((o) => o.textContent);
/** Save through SaveManager (with the Worker runtime snapshot) and return the file. */
const saveToJson = async (universe) => {
	blobs = [];
	await universe.SaveManager.save();
	assert.equal(blobs.length, 1, 'one save file written');
	return JSON.parse(await blobs[0].text());
};
const loadJson = (universe, json) => {
	const target = { files: [{ name: 'save.json', content: JSON.stringify(json) }], value: 'x' };
	universe.SaveManager.load({ target });
	assert.equal(target.value, '', 'load handled');
	universe.updateUI(0);
};
/** Rollout through the real RocketLauncher on a host. */
const rollout = (universe, host, { vehicleId = 'h3_22', payloadId = 'htv_x', missionId = 'iss_rendezvous' } = {}) => {
	const launcher = universe.RocketLauncher;
	launcher.hostId = host.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	const before = new Set(universe.objects);
	launcher.rollout();
	const rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
	assert.ok(rocket, 'input: rolled out');
	return rocket;
};
/** The LEGACY_QUICK command order of LaunchSequencer, then the frames of a climb. */
const launch = (universe, bridge, rocket) => {
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
};
/** Main-loop updates of `seconds` at real time (the time scale a launch sequence sets), in steps of `stepMs`. */
const runRealTime = (universe, seconds, stepMs = 500) => {
	const n = Math.round((seconds * 1000) / stepMs);
	for (let i = 0; i < n; i++) { universe.update(stepMs); }
};

// ------------------------------------------------------------------
// Recording Web Audio (the gain targets each voice is driven to), as regressions 16 and 17
// ------------------------------------------------------------------
class RecParam {
	constructor(value) { this.value = value; this.targets = []; }
	setValueAtTime(v) { this.value = v; }
	setTargetAtTime(v) { this.targets.push(v); }
}
class RecNode {
	constructor() { this.frequency = new RecParam(440); this.Q = new RecParam(1); this.gain = new RecParam(1); this.type = ''; }
	connect() {}
	disconnect() {}
	start() {}
	stop() {}
}
class RecAudioContext {
	constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 100; this.destination = new RecNode(); }
	createDynamicsCompressor() { const n = new RecNode(); n.threshold = new RecParam(0); n.knee = new RecParam(0); n.ratio = new RecParam(0); n.attack = new RecParam(0); n.release = new RecParam(0); return n; }
	createBuffer(ch, length) { const d = new Float32Array(length); return { length, getChannelData: () => d }; }
	createBufferSource() { return new RecNode(); }
	createBiquadFilter() { return new RecNode(); }
	createGain() { return new RecNode(); }
	createOscillator() { return new RecNode(); }
	resume() { return Promise.resolve(); }
	close() { return Promise.resolve(); }
}
const withRecordingAudio = (se) => {
	const saved = globalThis.window.AudioContext;
	globalThis.window.AudioContext = RecAudioContext;
	try { se._initAudio(); } finally { globalThis.window.AudioContext = saved; }
	return se;
};
const lastTarget = (param) => (param.targets.length > 0 ? param.targets[param.targets.length - 1] : param.value);
/** A voice is audible while it runs with a gain target above the -80 dB floor stop() ramps to (0.0001). */
const audible = (voice) => Boolean(voice.isRunning && voice.gainNode && lastTarget(voice.gainNode.gain) > 0.001);

/** Record the payloads of an EventBus event until stop(). */
const record = (event) => {
	const seen = [];
	const listener = (...args) => seen.push(args.length > 1 ? args : args[0]);
	EventBus.on(event, listener);
	Object.defineProperty(seen, 'stop', { value: () => EventBus.off(event, listener), enumerable: false });
	return seen;
};

/** DebrisGenerator.generateFromImpact: max(MIN_FRAG, floor(log10(debris mass [t]) x IMPACT_FRAG_MASS_LOG_MULT)). */
const fragmentCount = (debrisMassT) => Math.max(DEBRIS.MIN_FRAG, Math.floor(Math.log10(debrisMassT) * DEBRIS.IMPACT_FRAG_MASS_LOG_MULT));
/**
 * Two asteroids 2 km apart closing at 400 m/s, away from any planet, collided by the Worker: the loser breaks into
 * DebrisGenerator fragments ("Asteroid Debris"), which the main thread places and sends to the Worker.
 */
const collideAsteroids = (universe, bridge) => {
	const sun = universe.objects.find((o) => o.name === 'Sun' && o.state === OBJECT_STATE.ACTIVE);
	const px = UnitConvertUtils.m2pix;
	const x0 = sun.x + px(1.3e11);
	universe.ObjectPlacer.placeObject('Asteroid', x0, sun.y, px(200), 0);
	universe.ObjectPlacer.placeObject('Asteroid', x0 + px(2000), sun.y, px(-200), 0);
	let loser = null;
	const impacted = record('object:impacted');
	assert.ok(stepFrames(bridge, 30, () => impacted.length > 0), 'input: the asteroids collide');
	impacted.stop();
	const [[target, objData]] = impacted;
	loser = target;
	const fragments = universe.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS && o.name === `${loser.name} Debris`);
	assert.equal(fragments.length, fragmentCount(UnitConvertUtils.kg2ton(objData.debrisMass)), 'input: the DebrisGenerator fragments');
	assert.deepEqual(fragments.filter((f) => !bridge.ctrl.engine.objects.some((w) => w.id === f.id)), [], 'input: the Worker has the fragments');
	universe.updateUI(0);
	return { loser, fragments };
};

/** A main-thread rocket with a given id. */
const mainRocket = (id, overrides = {}) => Object.assign(new Rocket(id, `R${id}`, 0, 0, 0, 0, 20, 100, 200, '#ffffff', 5, 10, 0), overrides);

describe('Regression 18: removed or destroyed objects are not treated as live (design §4.13-31, -32)', () => {
	let origWorker;
	let hadSelf;
	let origSelf;
	let origCreate;
	let origRevoke;

	before(() => {
		origWorker = globalThis.Worker;
		hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
		origSelf = globalThis.self;
		globalThis.Worker = PhysicsWorkerBridge;
		globalThis.self = { postMessage: (msg) => { activeBridge.toMain(msg); } };
		origCreate = URL.createObjectURL;
		origRevoke = URL.revokeObjectURL;
		URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
		URL.revokeObjectURL = () => {};
	});

	after(() => {
		globalThis.Worker = origWorker;
		if (hadSelf) { globalThis.self = origSelf; } else { delete globalThis.self; }
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
	});

	afterEach(() => {
		EventBus.clearAll();
		blobs = [];
	});

	it('input: the rule of a live object (§4.13-23(a)): ACTIVE and not destroyed; removed, destroyed, missing are not; a plain record without a state is', () => {
		const r = mainRocket(1);
		assert.equal(isLiveObject(r), true);
		r.setCollided();
		assert.deepEqual([r.state, r.isDestroyed, isLiveObject(r)], [OBJECT_STATE.REMOVED, true, false]);
		const body = new CelestialBody(2, 'B', 0, 0, 0, 0, 1, '#fff', 1, 1, 0);
		body.setCollided();
		assert.equal(isLiveObject(body), false, 'a removed body');
		assert.equal(isLiveObject(Object.assign(mainRocket(3), { isDestroyed: true })), false, 'destroyed');
		for (const v of [null, undefined, 0, '']) { assert.equal(isLiveObject(v), false, String(v)); }
		assert.equal(isLiveObject({ id: 4, state: OBJECT_STATE.HISTORY_DONE }), false, 'any other state');
		assert.equal(isLiveObject({ id: 5 }), true, 'a plain record (no GravSimObject)');
	});

	// ==================================================================
	// R1. The launch sequence of a rocket that is gone (item 1)
	// ==================================================================
	describe('R1. a launch sequence aborts when its rocket is removed or destroyed, and the pad is released', () => {
		const FULL = LAUNCH_SEQUENCES.FULL_COUNTDOWN;
		const QUICK = LAUNCH_SEQUENCES.LEGACY_QUICK;
		const delugeTime = FULL.events.find((e) => e.command === 'WATER_DELUGE').time;
		const liftoffTime = (seq) => seq.events.find((e) => e.command === 'RELEASE_HOLD_DOWN').time;
		/** A rocket rolled out on Earth with recording audio, its sequence started through RocketLauncher.ignite. */
		const counting = (sequenceType = 'FULL_COUNTDOWN') => {
			const w = newUniverse();
			const earth = deployPlanet(w.universe, 'Earth');
			const se = withRecordingAudio(w.universe.SoundEffects);
			const rocket = rollout(w.universe, earth);
			w.universe.RocketLauncher.ignite(sequenceType);
			assert.equal(w.universe.LaunchSequencer.isActive, true, 'input: the sequence runs');
			return { ...w, earth, se, rocket, seq: w.universe.LaunchSequencer, tab: w.universe.ControlPanel.rocketTab };
		};
		const assertPadReleased = ({ universe, tab }, locks) => {
			assert.equal(universe.RocketLauncher.rolloutedRocketId, null, 'the launcher has no rocket on the pad');
			assert.deepEqual([tab.ui.rlRolloutBtn.style.display, tab.ui.rlIgnitionGroup.style.display, tab.ui.rlAbortBtn.style.display], ['block', 'none', 'none'],
				'the Rocket tab is back to Rollout');
			assert.equal(locks.at(-1), false, 'the tabs are unlocked');
		};

		it('normal (real path): System › Clear Selected › rockets at T-30 of the full countdown: the sequence aborts, no later event, callout or deluge', () => {
			const ctx = counting();
			const { universe, se, rocket, seq } = ctx;
			const tRemove = delugeTime - 5;
			runRealTime(universe, tRemove);
			assert.ok(Math.abs(seq.timer - tRemove) < 1e-6, `input: T-${FULL.tMinusOffset - seq.timer} (${seq.timer} s)`);
			assert.equal(se.isDelugeTriggered, false, 'input: no deluge yet');
			const events = record('sequencer-event');
			const plays = record('audio:play');
			const commands = record('worker:send-rocket-command');
			const states = record('rocket:update-state');
			const aborts = record('sequencer-abort');
			const locks = record('ui:set-tabs-locked');
			clearSelected(universe, { rockets: true });
			assert.deepEqual([universe.objects.includes(rocket), rocket.state, rocket.isDestroyed], [true, OBJECT_STATE.REMOVED, true], 'input: removed, still listed');
			assert.equal(seq.isActive, false, 'the sequence aborted (it ran on before)');
			assert.deepEqual(aborts, [{ reason: 'rocket-destroyed', rocketId: rocket.id }]);
			assertPadReleased(ctx, locks);
			// On past LIFTOFF and the completion time of the sequence
			runRealTime(universe, liftoffTime(FULL) - tRemove + LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME + 5);
			assert.deepEqual(events, [], 'no sequence event after the removal (WATER DELUGE, MAIN ENGINE START, LIFTOFF before)');
			assert.deepEqual(plays, [], 'no countdown callout');
			assert.deepEqual([commands, states], [[], []], 'no command for the removed rocket');
			assert.equal(se.isDelugeTriggered, false);
			assert.equal(se.voices.waterDeluge.isRunning, false, 'the deluge never started (it played at full gain until Reset)');
			assert.equal(seq.isActive, false);
		});

		it('normal (real path): the Worker destroys the rocket on the pad while the deluge runs: the deluge stops, the sequence aborts before MAIN ENGINE START', () => {
			const ctx = counting();
			const { universe, bridge, se, rocket, seq } = ctx;
			runRealTime(universe, delugeTime + 5);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), true, 'input: the deluge plays');
			const events = record('sequencer-event');
			const states = record('rocket:update-state');
			const locks = record('ui:set-tabs-locked');
			// The collision check of the Worker marks it (absorbed by a body, no impact fragments)
			const calc = bridge.ctrl.engine.objects.find((o) => o.id === rocket.id);
			calc.collided = true;
			stepFrames(bridge, 1);
			assert.deepEqual([rocket.state, rocket.isDestroyed], [OBJECT_STATE.REMOVED, true], 'input: destroyed by the frame');
			assert.equal(seq.isActive, false);
			assertPadReleased(ctx, locks);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), false, 'the deluge stopped');
			runRealTime(universe, liftoffTime(FULL) - delugeTime + LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME);
			se.update(16, 0.016);
			assert.deepEqual([events, states], [[], []], 'no MAIN ENGINE START / LIFTOFF, no ignition of the destroyed rocket');
			assert.equal(audible(se.voices.waterDeluge), false);
		});

		it('abnormal: other destructions, bad payloads and a second announcement leave the sequence; the user\'s Abort still stops every sound', () => {
			const ctx = counting('LEGACY_QUICK');
			const { universe, earth, rocket, seq } = ctx;
			const aborts = record('sequencer-abort');
			// Another rocket (placed free), a celestial body, a debris
			const other = universe.ObjectPlacer.placeObject('Rocket', earth.x + 1000, earth.y, 0, 0, {});
			universe.removeObject(other);
			const moon = deployPlanet(universe, 'Moon');
			universe.removeObject(moon);
			const deb = new Debris(universe.ObjectManager.getNextId(), 'D', 0, 0, 0, 0, 1, '#fff', 1, 1, 1);
			universe.addObject(deb);
			universe.removeObject(deb);
			for (const payload of [null, undefined, {}, { id: rocket.id + 1000 }, { id: String(rocket.id) }, { id: null }]) {
				EventBus.emit('rocket:destroyed', payload);
			}
			assert.equal(seq.isActive, true, 'the sequence of its own rocket only');
			assert.equal(universe.RocketLauncher.rolloutedRocketId, rocket.id, 'the pad keeps its rocket');
			assert.deepEqual(aborts, []);
			universe.removeObject(rocket);
			universe.removeObject(rocket);
			EventBus.emit('rocket:destroyed', rocket);
			assert.deepEqual(aborts, [{ reason: 'rocket-destroyed', rocketId: rocket.id }], 'aborted once');
			// The user's Abort (Rocket tab) of another countdown: no reason, every sound stops as before
			const ctx2 = counting('LEGACY_QUICK');
			const stops = { n: 0 };
			const orig = ctx2.se.stopAll.bind(ctx2.se);
			ctx2.se.stopAll = () => { stops.n++; return orig(); };
			const aborts2 = record('sequencer-abort');
			ctx2.universe.RocketLauncher.abortRollout();
			assert.deepEqual(aborts2, [undefined]);
			assert.equal(stops.n, 1, 'the user\'s Abort stops every sound');
		});

		it('abnormal: another rocket that still fires keeps its roar when the sequence\'s rocket is destroyed (no stop of every sound)', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const se = withRecordingAudio(universe.SoundEffects);
			const first = rollout(universe, earth);
			launch(universe, bridge, first);
			stepFrames(bridge, 20);
			assert.ok(first.isIgnited && first.thrustRatio > 0.01 && !first.isHoldDown, 'input: the first rocket climbs under thrust');
			const second = rollout(universe, earth);
			universe.RocketLauncher.ignite('LEGACY_QUICK');
			const stops = { n: 0 };
			const orig = se.stopAll.bind(se);
			se.stopAll = () => { stops.n++; return orig(); };
			universe.removeObject(second);
			assert.equal(universe.LaunchSequencer.isActive, false, 'the sequence aborted');
			assert.equal(stops.n, 0, 'no stop of every sound');
			stepFrames(bridge, 1);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'the first rocket roars');
		});

		it('boundary: removed during the completion time after LIFTOFF: aborted, no later callout; after the end: nothing; a rocket with id 0; Reset with a rocket on the pad', () => {
			// LEGACY_QUICK: LIFTOFF at its last event, then LAUNCH_TO_COMPLETION_TIME of callouts
			const ctx = counting('LEGACY_QUICK');
			runRealTime(ctx.universe, liftoffTime(QUICK) + 1);
			assert.equal(ctx.seq.isActive, true, 'input: after LIFTOFF, before the end of the sequence');
			const plays = record('audio:play');
			ctx.universe.removeObject(ctx.rocket);
			assert.equal(ctx.seq.isActive, false);
			runRealTime(ctx.universe, LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME);
			assert.deepEqual(plays, [], 'no callout after the removal');
			plays.stop();
			// After the end of a sequence: its rocket's later destruction emits no abort
			const ctx2 = counting('LEGACY_QUICK');
			runRealTime(ctx2.universe, liftoffTime(QUICK) + LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME + 1);
			assert.equal(ctx2.seq.isActive, false, 'input: the sequence ended');
			const aborts = record('sequencer-abort');
			ctx2.universe.removeObject(ctx2.rocket);
			assert.deepEqual(aborts, []);
			aborts.stop();
			// Ids start at 0 (§4.13-24): a rocket with id 0
			const { universe } = newUniverse();
			universe.ObjectManager.loadState([]);
			GravSimObject._idCounter = 5;
			universe.ObjectPlacer.placeObject('Sun', 0, 0, 0, 0);
			const earth = deployPlanet(universe, 'Earth');
			GravSimObject._idCounter = 0;
			const r0 = rollout(universe, earth);
			assert.equal(r0.id, 0, 'input: id 0');
			universe.RocketLauncher.ignite('LEGACY_QUICK');
			universe.removeObject(r0);
			assert.deepEqual([universe.LaunchSequencer.isActive, universe.RocketLauncher.rolloutedRocketId], [false, null]);
			// Reset (reachable from code only: the tabs are locked while a rocket is on the pad) releases the pad too
			const ctx3 = counting('LEGACY_QUICK');
			const aborts3 = record('sequencer-abort');
			resetAll(ctx3.universe);
			assert.deepEqual(aborts3, [{ reason: 'rocket-destroyed', rocketId: ctx3.rocket.id }]);
			assert.deepEqual([ctx3.seq.isActive, ctx3.universe.RocketLauncher.rolloutedRocketId], [false, null]);
		});
	});

	// ==================================================================
	// R2. Worker frames on their way when objects are removed (item 2)
	// ==================================================================
	describe('R2. a frame made before a removal, a Reset or a load brings nothing back and changes nothing', () => {
		it('normal (real path): two asteroids collide, Reset All with a frame on its way: only the Sun, on both sides, frame after frame', async () => {
			const { universe, bridge } = newUniverse();
			const { fragments } = collideAsteroids(universe, bridge);
			bridge.frame(1);
			assert.ok(fragments.every((f) => bridge.ctrl.engine.objects.some((w) => w.id === f.id)), 'input: the frame on its way has the fragments');
			resetAll(universe);
			const sun = universe.objects[0];
			assert.deepEqual(workerIds(bridge), [sun.id], 'input: the Worker handled the removals after that frame');
			await flush();
			universe.updateUI(0);
			assert.deepEqual(universe.objects.filter((o) => o.type !== OBJECT_TYPES.CELESTIAL).map((o) => `${o.name} (${o.id})`), [],
				'no debris came back (10 "Jettisoned Debris" with the ids of the fragments before)');
			assert.deepEqual(liveNames(universe), ['Sun']);
			assert.equal(document.getElementById('info-count').textContent, '1');
			for (let i = 0; i < 5; i++) {
				bridge.frame(1);
				await flush();
			}
			assert.deepEqual([liveIds(universe), universe.objects.length], [workerIds(bridge), 1], 'the main thread mirrors the Worker');
		});

		it('normal (real path): Reset while the frame of an SRB separation is on its way: the Worker clears the new debris too', async () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_22', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			launch(universe, bridge, rocket);
			let spawned = [];
			for (let i = 0; i < 400 && spawned.length === 0; i++) {
				bridge.frame(1);
				const listed = new Set(universe.objects.map((o) => o.id));
				spawned = bridge.ctrl.engine.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS && !listed.has(o.id));
				if (spawned.length === 0) { await flush(); }
			}
			assert.ok(spawned.length > 0, 'input: the frame on its way has debris the Worker spawned (the main thread never saw them)');
			resetAll(universe);
			const sun = universe.objects[0];
			assert.deepEqual(workerIds(bridge), [sun.id], 'the Worker has only the new Sun (it kept the debris the main thread did not list)');
			await flush();
			assert.deepEqual(universe.objects.map((o) => o.name), ['Sun'], 'nothing of the frame came onto the main thread');
			bridge.frame(1);
			await flush();
			assert.deepEqual(liveIds(universe), workerIds(bridge));
		});

		it('abnormal: a load with a frame on its way whose ids are those of the file: the loaded objects keep the file\'s kinematics', async () => {
			const { universe, bridge } = newUniverse();
			deployPlanet(universe, 'Earth');
			deployPlanet(universe, 'Mars');
			stepFrames(bridge, 3);
			const file = await saveToJson(universe);
			const saved = new Map(file.universe.objectManager.map((o) => [o.id, [o.x, o.y, o.vx, o.vy]]));
			stepFrames(bridge, 200);
			bridge.frame(1);
			const moved = bridge.ctrl.engine.objects.find((o) => o.name === 'Earth');
			assert.notEqual(UnitConvertUtils.m2pix(moved.x), saved.get(moved.id)[0], 'input: the frame on its way has Earth elsewhere, under the same id');
			loadJson(universe, file);
			const loaded = live(universe);
			assert.deepEqual(loaded.map((o) => o.id).sort((a, b) => a - b), [...saved.keys()].sort((a, b) => a - b), 'input: the file\'s ids');
			await flush();
			for (const o of loaded) {
				assert.ok([o.x, o.y, o.vx, o.vy].every((v, i) => Object.is(v, saved.get(o.id)[i])), `${o.name}: as in the file until the first frame of the loaded world`);
				assert.equal(o.trajectory.count, 0, `${o.name}: no trail point from the old world`);
			}
			bridge.frame(1);
			await flush();
			for (const o of loaded) {
				const w = bridge.ctrl.engine.objects.find((c) => c.id === o.id);
				assert.ok(Object.is(o.x, UnitConvertUtils.m2pix(w.x)), `${o.name}: then the Worker's frames`);
			}
		});

		it('abnormal: Clear Selected › debris with a frame on its way, the fragments cleaned up at once (no trail yet): none comes back', async () => {
			const { universe, bridge } = newUniverse();
			const { fragments } = collideAsteroids(universe, bridge);
			assert.ok(fragments.every((f) => f.trajectory.count === 0 && f.effectTrail.count === 0), 'input: placed after the history pass, no trail point yet');
			bridge.frame(1);
			clearSelected(universe, { debris: true });
			universe.ObjectManager.cleanupObjects();
			assert.deepEqual(fragments.filter((f) => universe.objects.includes(f)), [], 'input: nothing to fade, gone from the list');
			await flush();
			assert.deepEqual(universe.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS).map((o) => `${o.name} (${o.id})`), [], 'no fragment came back');
			bridge.frame(1);
			await flush();
			assert.deepEqual(liveIds(universe), workerIds(bridge));
		});

		it('normal (real path): a rocket removed in flight takes nothing of a frame on its way (its position, telemetry and trail stay)', async () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 20);
			bridge.frame(1);
			clearSelected(universe, { rockets: true });
			const snap = { x: rocket.x, y: rocket.y, vx: rocket.vx, telemetry: rocket.telemetry, count: rocket.trajectory.count, name: rocket.name };
			const listChanges = record('object-list-changed');
			await flush();
			assert.deepEqual({ x: rocket.x, y: rocket.y, vx: rocket.vx, telemetry: rocket.telemetry, count: rocket.trajectory.count, name: rocket.name }, snap);
			assert.deepEqual(listChanges, []);
		});

		describe('the sequence numbers (ObjectManager with a recording Worker, frames of WorkerBridge.formatWorkerToMain)', () => {
			const workerDebris = (id) => ({ id, type: OBJECT_TYPES.DEBRIS, x: 1e9, y: 2e9, vx: 0, vy: 0, ax: 0, ay: 0, mass: 1, radius: 1, debrisSubType: 0 });
			const frameOf = (records, syncSeq) => {
				const buf = WorkerBridge.formatWorkerToMain(records);
				const data = { cmd: 'update', objectsData: buf.buffer.slice(0, buf.length * 8), validLength: buf.length };
				if (syncSeq !== undefined) { data.syncSeq = syncSeq; }
				return data;
			};
			const setup = () => {
				const sent = [];
				const om = new ObjectManager(null, { postMessage: (m) => sent.push(m) });
				return { om, sent };
			};

			it('boundary: a removed id comes back only in a frame that reflects its removal (syncSeq = its number), not in one before (number - 1)', () => {
				const { om, sent } = setup();
				const d = new Debris(7, 'D', 0, 0, 0, 0, 1, '#fff', 1, 1, 1);
				om.addObject(d, false);
				om.removeObject(d);
				const seq = sent.find((m) => m.cmd === 'remove' && m.id === 7).seq;
				assert.ok(Number.isInteger(seq) && seq >= 1, `input: the removal carries a sequence number (${seq})`);
				om.cleanupObjects();
				assert.equal(om.objects.includes(d), false, 'input: no trail, gone at once');
				om.updateObjectParams(frameOf([workerDebris(7)], seq - 1));
				assert.equal(om.objects.some((o) => o.id === 7), false, 'made before the removal: dropped');
				om.updateObjectParams(frameOf([workerDebris(7)], seq));
				assert.equal(om.objects.some((o) => o.id === 7 && o !== d), true, 'made after it: a new Worker debris with that id');
				assert.equal(sent.filter((m) => m.cmd === 'returnBuffer').length, 2, 'both buffers returned');
			});

			it('boundary: a frame made before the last clear (Reset / load) is dropped whole, one made after it is applied; Reset sends one clear', () => {
				const { om, sent } = setup();
				om.addObject(new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1, '#fff', 1, 1, 0), false);
				om.destroy();
				const clears = sent.filter((m) => m.cmd === 'clear');
				assert.equal(clears.length, 1);
				const c = clears[0].seq;
				assert.ok(c > sent.find((m) => m.cmd === 'remove').seq, 'after the removals');
				om.updateObjectParams(frameOf([workerDebris(99)], c - 1));
				assert.deepEqual(om.objects, [], 'an id never removed is dropped too: the frame is of the replaced world');
				om.updateObjectParams(frameOf([workerDebris(99)], c));
				assert.deepEqual(om.objects.map((o) => o.id), [99]);
				assert.equal(sent.filter((m) => m.cmd === 'returnBuffer').length, 2);
			});

			it('abnormal: a frame without a sequence number (or not a finite number) is taken as in step; a listed removed object takes no data even then', () => {
				for (const syncSeq of [undefined, NaN, Infinity, '5', null]) {
					const { om } = setup();
					const d = new Debris(7, 'D', 0, 0, 0, 0, 1, '#fff', 1, 1, 1);
					om.addObject(d, false);
					om.removeObject(d);
					om.cleanupObjects();
					om.updateObjectParams(frameOf([workerDebris(7), workerDebris(8)], syncSeq));
					assert.deepEqual(om.objects.map((o) => o.id).sort(), [7, 8], `syncSeq ${String(syncSeq)}`);
				}
				const { om } = setup();
				const listed = new Debris(5, 'L', 3, 4, 0, 0, 1, '#fff', 1, 1, 1);
				om.addObject(listed, false);
				listed.trajectory.addPoint(3, 4, 0, 0);
				listed.trajectory.addPoint(3, 4, 1, 0);
				listed.trajectory.addPoint(3, 4, 2, 0);
				om.removeObject(listed);
				om.updateObjectParams(frameOf([workerDebris(5)]));
				assert.deepEqual([listed.x, listed.y, om.objects.filter((o) => o.id === 5).length], [3, 4, 1], 'no data, no second object while it fades');
			});
		});
	});

	// ==================================================================
	// R3. Saving right after a removal (item 3)
	// ==================================================================
	describe('R3. a save holds the objects in the simulation only', () => {
		it('normal (real path): Clear Selected of everything, then Save at once: the file holds the Sun, the load brings back nothing else', async () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			deployPlanet(universe, 'Mars');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 5);
			collideAsteroids(universe, bridge);
			const before = universe.objects.length;
			clearSelected(universe, { debris: true, rockets: true, celestial: true });
			assert.equal(universe.objects.length, before, 'input: every cleared object is still listed (its trail fades)');
			const sun = universe.ObjectManager.getWorldCenter();
			assert.deepEqual(liveIds(universe), [sun.id], 'input: only the world center is in the simulation');
			const file = await saveToJson(universe);
			assert.deepEqual(file.universe.objectManager.map((o) => [o.id, o.name, o.isWorldCenter]), [[sun.id, 'Sun', true]], 'the cleared objects were saved too');
			const w2 = newUniverse();
			loadJson(w2.universe, file);
			assert.deepEqual(w2.universe.objects.map((o) => o.name), ['Sun']);
			assert.deepEqual(workerIds(w2.bridge), [sun.id]);
		});

		it('abnormal: a rocket destroyed by the Worker and a body removed by the heliosphere escape are not saved; a list of removed objects saves nothing', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 3);
			bridge.ctrl.engine.objects.find((o) => o.id === rocket.id).collided = true;
			stepFrames(bridge, 1);
			assert.equal(rocket.isDestroyed, true, 'input: destroyed by the frame');
			mars.isEscaping = true;
			mars.x = universe.objects[0].x + UnitConvertUtils.au2pix(SIMULATION.REMOVE_DISTANCE_AU * 2);
			universe.ObjectManager._checkEscapeAndRemove();
			assert.equal(mars.state, OBJECT_STATE.REMOVED, 'input: Mars left the heliosphere');
			assert.deepEqual(universe.ObjectManager.getState().map((o) => o.name), ['Sun', 'Earth']);
			const om = new ObjectManager(null, { postMessage() {} });
			const r = mainRocket(3);
			om.addObject(r, false);
			om.removeObject(r);
			assert.deepEqual(om.getState(), []);
		});

		it('boundary: nothing removed: every object is saved in list order; one removed: exactly that one is left out', () => {
			const { universe } = newUniverse();
			const names = ['Earth', 'Mars', 'Venus'].map((n) => deployPlanet(universe, n).name);
			const all = universe.ObjectManager.getState();
			assert.deepEqual(all.map((o) => o.id), universe.objects.map((o) => o.id));
			assert.deepEqual(all.map((o) => o.name), ['Sun', ...names]);
			universe.removeObject(universe.objects.find((o) => o.name === 'Mars'));
			assert.deepEqual(universe.ObjectManager.getState().map((o) => o.name), ['Sun', 'Earth', 'Venus']);
		});
	});

	// ==================================================================
	// R4. The Rocket tab's launch hosts (item 4)
	// ==================================================================
	describe('R4. the Rocket tab offers the celestial bodies in the simulation as launch hosts', () => {
		const hostOptions = (universe) => {
			universe.ControlPanel.rocketTab._updateRocketHostOptions();
			return optionsOf(universe.ControlPanel.rocketTab.ui.rlHostSelect);
		};

		it('normal (real path): with impact fragments, a removed asteroid and a removed Mars listed: only the Sun, Earth and the remaining asteroid', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			const { loser } = collideAsteroids(universe, bridge);
			universe.removeObject(mars);
			const sun = universe.objects[0];
			const winner = live(universe).find((o) => o.name === 'Asteroid');
			assert.ok(winner && winner !== loser && universe.objects.includes(loser) && universe.objects.includes(mars), 'input: the removed bodies are listed');
			assert.ok(universe.objects.some((o) => o.type === OBJECT_TYPES.DEBRIS), 'input: fragments exist');
			assert.deepEqual(hostOptions(universe), [`Sun (ID: ${sun.id})`, `Earth (ID: ${earth.id})`, `Asteroid (ID: ${winner.id})`],
				'debris and removed bodies were offered too');
			// The list follows the object-list change of the next frame
			openTab(universe, 'tab-rocket');
			universe.updateUI(0);
			assert.deepEqual(optionsOf(universe.ControlPanel.rocketTab.ui.rlHostSelect), [`Sun (ID: ${sun.id})`, `Earth (ID: ${earth.id})`, `Asteroid (ID: ${winner.id})`]);
		});

		it('abnormal: the host the user chose is removed: not offered, and opening the tab takes the default host; no body: an empty list and no host', () => {
			const { universe } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			openTab(universe, 'tab-rocket');
			universe.ControlPanel.rocketTab.ui.rlHostSelect.dispatchEvent({ type: 'change', target: { value: String(mars.id) } });
			assert.deepEqual([universe.RocketLauncher.hostId, universe.RocketLauncher.hostAutoSelected], [mars.id, false], 'input: the user chose Mars');
			openTab(universe, 'tab-sys');
			universe.removeObject(mars);
			universe.updateUI(0);
			assert.equal(hostOptions(universe).some((t) => t.startsWith('Mars')), false);
			openTab(universe, 'tab-rocket');
			assert.equal(universe.RocketLauncher.hostId, earth.id, 'the default host (Earth)');
			// Every body removed (the world center too, by code): nothing to launch from
			openTab(universe, 'tab-sys');
			for (const o of live(universe)) { universe.removeObject(o); }
			assert.deepEqual(hostOptions(universe), []);
			assert.equal(universe.ControlPanel.rocketTab._getDefaultHostId(), null);
		});

		it('boundary: only the Sun: it is offered; debris that are the only other objects are never offered; a removed body that has faded is gone as before', () => {
			const { universe } = newUniverse();
			const sun = universe.objects[0];
			assert.deepEqual(hostOptions(universe), [`Sun (ID: ${sun.id})`]);
			const deb = new Debris(universe.ObjectManager.getNextId(), 'Stage 1 Booster', 0, 0, 0, 0, 20, '#fff', 1, 1, 1);
			universe.addObject(deb);
			assert.deepEqual(hostOptions(universe), [`Sun (ID: ${sun.id})`], 'a debris is no host');
			const earth = deployPlanet(universe, 'Earth');
			universe.removeObject(earth);
			for (let i = 0; i < 5000 && universe.objects.includes(earth); i++) { universe.ObjectManager.cleanupObjects(); }
			assert.equal(universe.objects.includes(earth), false, 'input: faded');
			assert.deepEqual(hostOptions(universe), [`Sun (ID: ${sun.id})`]);
		});
	});

	// ==================================================================
	// R5. Deploy › Galactic Center replaces the world center (item 5, §4.13-32)
	// ==================================================================
	describe('R5. Galactic Center builds its world around Sagittarius A* from a fresh page and after Reset alike', () => {
		const GC = DEPLOY_PROFILES.GALACTIC_CENTER;
		const nameOf = (template) => presetManager.getObjectParam(template).NAME;
		const GC_NAMES = GC.staticObjects.map((d) => nameOf(d.template)).sort();
		const CENTER_DEF = GC.staticObjects.find((d) => d.worldCenter === true);
		/** Kinematics of every live object by name after `frames` Worker frames (ids left out). */
		const kinematics = (universe, bridge, frames) => {
			stepFrames(bridge, frames);
			return Object.fromEntries(live(universe).map((o) => [o.name, [o.x, o.y, o.vx, o.vy, o.mass]]));
		};
		const assertGalacticWorld = (universe, bridge, label) => {
			assert.deepEqual(liveNames(universe), GC_NAMES, `${label}: the profile's bodies`);
			assert.equal(liveNames(universe).filter((n) => n === 'Sun').length, 1, `${label}: one Sun (the page's Sun stayed beside Sgr A* before)`);
			const center = universe.ObjectManager.getWorldCenter();
			assert.equal(center?.name, nameOf(CENTER_DEF.template), `${label}: the world center`);
			assert.deepEqual(live(universe).filter((o) => o.isWorldCenter === true), [center], `${label}: the only center`);
			assert.deepEqual([center.x, center.y, center.vx, center.vy], [CENTER_DEF.x, CENTER_DEF.y, 0, 0], `${label}: where the profile puts it, at rest`);
			assert.equal(universe.camera.trackingTarget, center, `${label}: the camera follows it`);
			assert.deepEqual(liveIds(universe), workerIds(bridge), `${label}: the Worker has the same objects`);
			return center;
		};

		it('input: the profile names one world center, its first static object, placed without a host', () => {
			assert.deepEqual(GC.staticObjects.filter((d) => d.worldCenter === true), [GC.staticObjects[0]]);
			assert.equal(CENTER_DEF.host, undefined);
			assert.equal(nameOf(CENTER_DEF.template), 'Sagittarius A*');
			assert.equal(GC_NAMES.filter((n) => n === 'Sun').length, 1, 'one Sun among them, around Sgr A*');
			for (const [id, p] of Object.entries(DEPLOY_PROFILES)) {
				if (id === 'GALACTIC_CENTER') { continue; }
				assert.equal((p.staticObjects || []).some((d) => d.worldCenter), false, `${id} keeps the world center`);
			}
		});

		it('normal (real path): from a fresh page: the profile\'s bodies, Sgr A* the world center, the page\'s Sun removed on both sides', () => {
			const { universe, bridge } = newUniverse();
			const pageSun = universe.objects[0];
			deploy(universe, 'GALACTIC_CENTER');
			assertGalacticWorld(universe, bridge, 'fresh page');
			assert.deepEqual([pageSun.state, pageSun.isWorldCenter], [OBJECT_STATE.REMOVED, true], 'the old center is removed (it fades out)');
			assert.equal(bridge.ctrl.engine.objects.some((o) => o.id === pageSun.id), false);
			// Clear Selected › celestial keeps the new center only
			clearSelected(universe, { celestial: true });
			assert.deepEqual(liveNames(universe), [nameOf(CENTER_DEF.template)]);
		});

		it('normal (real path): after System › Reset the same world, moving bit for bit as from a fresh page (only the ids differ)', () => {
			const fresh = newUniverse();
			deploy(fresh.universe, 'GALACTIC_CENTER');
			const freshKin = kinematics(fresh.universe, fresh.bridge, 20);
			EventBus.clearAll();
			const w = newUniverse();
			deployPlanet(w.universe, 'Earth');
			stepFrames(w.bridge, 3);
			resetAll(w.universe);
			deploy(w.universe, 'GALACTIC_CENTER');
			assertGalacticWorld(w.universe, w.bridge, 'after Reset');
			const kin = kinematics(w.universe, w.bridge, 20);
			assert.deepEqual(Object.keys(kin).sort(), Object.keys(freshKin).sort());
			for (const name of Object.keys(freshKin)) {
				assert.ok(kin[name].every((v, i) => Object.is(v, freshKin[name][i])), `${name}: identical after 20 frames`);
			}
		});

		it('abnormal: deployed twice, after Binary Star System, or with the world center destroyed: the same Galactic world', () => {
			const once = newUniverse();
			deploy(once.universe, 'GALACTIC_CENTER');
			const onceKin = kinematics(once.universe, once.bridge, 10);
			EventBus.clearAll();
			const twice = newUniverse();
			deploy(twice.universe, 'GALACTIC_CENTER');
			stepFrames(twice.bridge, 5);
			const firstCenter = twice.universe.ObjectManager.getWorldCenter();
			deploy(twice.universe, 'GALACTIC_CENTER');
			const second = assertGalacticWorld(twice.universe, twice.bridge, 'twice');
			assert.notEqual(second, firstCenter, 'the moved center of the first deploy was replaced');
			const twiceKin = kinematics(twice.universe, twice.bridge, 10);
			for (const name of Object.keys(onceKin)) {
				assert.ok(twiceKin[name].every((v, i) => Object.is(v, onceKin[name][i])), `${name}: as deployed once`);
			}
			EventBus.clearAll();
			const afterBinary = newUniverse();
			deploy(afterBinary.universe, 'BINARY_SYSTEM');
			assert.equal(afterBinary.universe.ObjectManager.getWorldCenter().name, DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.name, 'input: Sun A is the center');
			deploy(afterBinary.universe, 'GALACTIC_CENTER');
			assertGalacticWorld(afterBinary.universe, afterBinary.bridge, 'after Binary');
			EventBus.clearAll();
			const noCenter = newUniverse();
			noCenter.universe.removeObject(noCenter.universe.objects[0]);
			assert.equal(noCenter.universe.ObjectManager.getWorldCenter(), null, 'input: no world center');
			deploy(noCenter.universe, 'GALACTIC_CENTER');
			assertGalacticWorld(noCenter.universe, noCenter.bridge, 'without a center');
		});

		it('boundary: the profiles without a world center of their own keep it (Solar System, Binary, Three-Body, Stress Test)', () => {
			const solar = newUniverse();
			const sun = solar.universe.objects[0];
			deploy(solar.universe, 'SOLAR_SYSTEM');
			assert.deepEqual([solar.universe.ObjectManager.getWorldCenter(), sun.state], [sun, OBJECT_STATE.ACTIVE]);
			EventBus.clearAll();
			for (const [id, firstStar] of [['BINARY_SYSTEM', DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.name], ['THREE_BODY', DEPLOY_PROFILES.THREE_BODY.generators[0].stars[0].name]]) {
				const w = newUniverse();
				const center = w.universe.objects[0];
				deploy(w.universe, id);
				assert.deepEqual([w.universe.ObjectManager.getWorldCenter(), center.name], [center, firstStar], `${id}: the center became its first star`);
				EventBus.clearAll();
			}
			const stress = newUniverse();
			const sSun = stress.universe.objects[0];
			deploy(stress.universe, 'DEBUG_STRESS_TEST');
			assert.equal(stress.universe.ObjectManager.getWorldCenter(), sSun);
		});
	});

	// ==================================================================
	// R6. The same pattern elsewhere (the sweep of scripts/)
	// ==================================================================
	describe('R6. camera, prediction, launcher, lists, counts, reference body, deploy and clear take live objects only', () => {
		it('camera fallback: the largest object in the simulation, never a removed one; nothing live: no target loop', () => {
			const { universe } = newUniverse();
			const sun = universe.objects[0];
			const earth = deployPlanet(universe, 'Earth');
			const jupiter = deployPlanet(universe, 'Jupiter');
			EventBus.emit('camera:set-tracking-target', jupiter);
			universe.removeObject(jupiter);
			universe.removeObject(sun);
			universe.update(16);
			assert.equal(universe.camera.trackingTarget, earth, 'the largest live object (the removed Sun before)');
			universe.update(16);
			assert.equal(universe.camera.trackingTarget, earth, 'and it stays');
			universe.removeObject(earth);
			const sets = record('camera:set-tracking-target');
			universe.update(16);
			universe.update(16);
			assert.deepEqual(sets, [], 'nothing live: the target is left as it is (a removed object was set at every update before)');
		});

		it('camera auto tracking stops when the tracked rocket is removed: the host is not tracked as the rocket (closest zoom)', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			assert.deepEqual([universe.camera.autoTrackHost, universe.camera.trackingTarget], [earth, rocket], 'input: auto tracking of the rocket');
			launch(universe, bridge, rocket);
			stepFrames(bridge, 10);
			universe.update(16);
			const zoomBefore = universe.camera.targetZoomExp;
			assert.ok(zoomBefore < universe.camera.maxZoomExp, `input: the tracking zoom ${zoomBefore}`);
			// Clear Selected moves the camera to the first remaining object; the tracking was applied to it as to the rocket
			const sets = record('camera:set-tracking-target');
			clearSelected(universe, { rockets: true });
			const next = sets[0];
			assert.ok(next && next.state === OBJECT_STATE.ACTIVE && next !== rocket, 'input: Clear Selected chose a live object');
			for (let i = 0; i < 5; i++) { universe.update(16); }
			assert.equal(universe.camera.autoTrackHost, null, 'stopped');
			assert.equal(universe.camera.trackingTarget, next, 'the camera stays where Clear Selected put it (then fitted to the host)');
			assert.equal(universe.camera.targetZoomExp, zoomBefore, 'the zoom stays');
		});

		it('camera auto tracking stops when the Worker destroys the tracked rocket: the fallback\'s host is not tracked as the rocket; boundary: the host itself', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 10);
			universe.update(16);
			const zoomBefore = universe.camera.targetZoomExp;
			bridge.ctrl.engine.objects.find((o) => o.id === rocket.id).collided = true;
			stepFrames(bridge, 1);
			assert.equal(rocket.isDestroyed, true, 'input: destroyed by the frame');
			for (let i = 0; i < 5; i++) { universe.update(16); }
			assert.deepEqual([universe.camera.autoTrackHost, universe.camera.trackingTarget], [null, earth], 'stopped; the fallback took the host');
			assert.equal(universe.camera.targetZoomExp, zoomBefore, 'the zoom stays (the host was tracked as the rocket: the closest zoom)');
			assert.ok(zoomBefore < universe.camera.maxZoomExp, 'input');
			// Boundary: a tracking target that is the host itself
			universe.camera.setAutoTracking(earth, earth);
			universe.camera.update(0.016);
			assert.equal(universe.camera.autoTrackHost, null);
		});

		it('trajectory prediction: a removed body (still listed) no longer pulls; the same prediction as after it has faded', () => {
			const { universe } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const moon = universe.ObjectPlacer.placeAtOrbitAroundHost('Earth', 'Moon');
			const rl = universe.RocketLauncher;
			const predict = () => {
				const p = Object.getPrototypeOf(rl).updatePredictionSync.call(rl);
				assert.ok(p && p.points.length > 1, 'input: a prediction');
				return JSON.stringify(p.points);
			};
			rl.mode = 'host';
			rl.hostId = earth.id;
			presetManager.applyToLauncher(rl, { vehicleId: 'h3_24', payloadId: 'lunar_orbiter', missionId: 'lunar_insertion' });
			rl.maxSimTimeSec = 3 * 86400;
			const withMoon = predict();
			universe.removeObject(moon);
			const removed = predict();
			for (let i = 0; i < 5000 && universe.objects.includes(moon); i++) { universe.ObjectManager.cleanupObjects(); }
			assert.equal(universe.objects.includes(moon), false, 'input: faded');
			const gone = predict();
			assert.notEqual(withMoon, gone, 'input: the Moon changes the prediction');
			assert.equal(removed, gone, 'the removed Moon pulled until its trail had faded');
		});

		it('launcher: no rollout onto a removed host, no prediction around a removed host or camera target; a live camera target is still the fallback', () => {
			const { universe } = newUniverse();
			const sun = universe.objects[0];
			const earth = deployPlanet(universe, 'Earth');
			const rl = universe.RocketLauncher;
			rl.mode = 'host';
			rl.hostId = earth.id;
			presetManager.applyToLauncher(rl, { vehicleId: 'h3_22', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			universe.removeObject(earth);
			assert.equal(universe.camera.trackingTarget, earth, 'input: the camera is still on the removed Earth (until the next update)');
			const before = universe.objects.length;
			rl.rollout();
			assert.deepEqual([universe.objects.length, rl.rolloutedRocketId], [before, null], 'no rocket on a removed body');
			assert.equal(rl._getPredictionContext(), null, 'no prediction around it');
			EventBus.emit('camera:set-tracking-target', sun);
			assert.equal(rl._getPredictionContext()?.host, sun, 'the live camera target');
		});

		it('lists: System › Center, Navi › Target and the telemetry target offer live objects (the telemetry keeps its shown rocket)', () => {
			const { universe, bridge } = newUniverse();
			const sun = universe.objects[0];
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 3);
			const second = universe.ObjectPlacer.placeObject('Rocket', earth.x + 1000, earth.y, earth.vx, earth.vy, {});
			const { loser, fragments } = collideAsteroids(universe, bridge);
			const winner = live(universe).find((o) => o.name === 'Asteroid');
			universe.TelemetryPanel.targetId = rocket.id;
			universe.removeObject(mars);
			universe.removeObject(rocket);
			universe.removeObject(second);
			universe.updateUI(0);
			assert.ok([mars, rocket, second, loser].every((o) => universe.objects.includes(o)), 'input: the removed objects are listed');
			const sys = optionsOf(universe.ControlPanel.systemTab.ui.centerSelect);
			assert.deepEqual(sys, [sun, earth, winner, ...fragments].map((o) => `${o.name} (ID: ${o.id})`));
			const navi = optionsOf(universe.ControlPanel.naviTab.ui.nvTargetSelect);
			assert.deepEqual(navi, [sun, earth, winner, ...fragments].map((o) => `${o.name.substring(0, 10)} (ID:${o.id})`));
			const tm = optionsOf(universe.TelemetryPanel.ui.targetSelect);
			assert.deepEqual(tm, [rocket, ...fragments].map((o) => `${o.name.substring(0, 10)} (ID:${o.id})`), 'the shown rocket, the live debris');
		});

		it('counts: the object count and the list change follow a removal at once; the elapsed time resets when only the Sun is left', () => {
			const { universe } = newUniverse();
			deployPlanet(universe, 'Earth');
			deployPlanet(universe, 'Mars');
			assert.equal(document.getElementById('info-count').textContent, '3', 'input');
			universe.timeScale = 1;
			universe.update(16);
			assert.ok(universe.InfoPanel.elapsedTime > 0, 'input: the elapsed time runs');
			const counts = record('object-list-changed');
			clearSelected(universe, { celestial: true });
			assert.deepEqual(counts, [1], 'emitted with the live count (nothing before the trails had faded)');
			assert.equal(document.getElementById('info-count').textContent, '1');
			universe.update(16);
			assert.equal(universe.InfoPanel.elapsedTime, 0, 'one object in the simulation: reset');
			// The removed objects leave the list later: the lists are rebuilt once more, with the same count
			for (let i = 0; i < 5000 && universe.objects.length > 1; i++) { universe.ObjectManager.cleanupObjects(); }
			universe.updateUI(0);
			assert.deepEqual(counts, [1, 1]);
		});

		it('reference body: a removed body (listed while its trail fades) is no reference body; live bodies resolve, id 0 too', () => {
			const { universe } = newUniverse();
			const sun = universe.objects[0];
			const earth = deployPlanet(universe, 'Earth');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: earth.id }, universe.objects), earth);
			assert.equal(sun.id, 0, 'input: the Sun of the page has id 0');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: 0 }, universe.objects), sun);
			universe.removeObject(earth);
			assert.equal(universe.objects.includes(earth), true, 'input: listed');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: earth.id }, universe.objects), null);
		});

		it('Rocket tab: closing it does not track again a camera target removed while it was open', () => {
			const { universe } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			assert.equal(universe.camera.trackingTarget, mars, 'input: the camera follows Mars');
			openTab(universe, 'tab-rocket');
			universe.removeObject(mars);
			const sets = record('camera:set-tracking-target');
			openTab(universe, 'tab-sys');
			assert.equal(sets.includes(mars), false, 'the removed Mars was tracked again');
			assert.equal(universe.camera.trackingTarget, earth, 'the camera stays on the launch host');
		});

		it('deploy: a removed Sun (the camera target) is not the Sun of a planet; a removed body is not the host of a generator', () => {
			const { universe } = newUniverse();
			const oldSun = universe.objects[0];
			universe.removeObject(oldSun);
			assert.equal(universe.camera.trackingTarget, oldSun, 'input: the camera is on the removed Sun');
			const earth = deployPlanet(universe, 'Earth');
			const sun = live(universe).find((o) => o.name === 'Sun');
			assert.ok(sun && sun !== oldSun, 'a new Sun was placed (Earth went around the removed one before)');
			const p = presetManager.getObjectParam('Earth');
			const rp = UnitConvertUtils.m2pix(UnitConvertUtils.au2m(p.A) * (1 - p.E));
			assert.ok(Math.abs(Math.hypot(earth.x - sun.x, earth.y - sun.y) / rp - 1) < 1e-9, 'Earth at its perihelion from the new Sun');
			EventBus.clearAll();
			// A loaded world whose first "Sun" is removed (listed first), the world center a second Sun 50 AU away
			const w = newUniverse();
			const AU = UnitConvertUtils.au2pix(1);
			w.universe.ObjectManager.loadState([
				{ id: 5, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, mass: presetManager.getObjectParam('Sun').MASS, radius: 7e8, isWorldCenter: false },
				{ id: 6, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 50 * AU, y: 0, vx: 0, vy: 0, mass: presetManager.getObjectParam('Sun').MASS, radius: 7e8, isWorldCenter: true }
			]);
			w.universe.removeObject(w.universe.objects.find((o) => o.id === 5));
			deploy(w.universe, 'DEBUG_STRESS_TEST');
			const center = w.universe.objects.find((o) => o.id === 6);
			const gen = DEPLOY_PROFILES.DEBUG_STRESS_TEST.generators.find((g) => g.type === 'circular_swarm');
			const swarm = live(w.universe).filter((o) => gen.templates.includes(o.name));
			assert.equal(swarm.length, gen.count, 'input: the swarm');
			const far = swarm.filter((o) => {
				const r = Math.hypot(o.x - center.x, o.y - center.y) / AU;
				return r < gen.radiusAuMin * (1 - 1e-9) || r > gen.radiusAuMax * (1 + 1e-9);
			});
			assert.deepEqual(far.map((o) => o.id), [], 'every swarm body is around the live Sun (around the removed one before)');
		});

		it('clear: Clear Selected twice sends one removal per object; Reset removes the live objects once and clears the Worker', () => {
			const { universe, bridge } = newUniverse();
			const sun = universe.objects[0];
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			bridge.sent.length = 0;
			clearSelected(universe, { celestial: true });
			clearSelected(universe, { celestial: true });
			const removes = () => bridge.sent.filter((m) => m.cmd === 'remove').map((m) => m.id);
			assert.deepEqual(removes(), [earth.id, mars.id], 'the second clear removed them again before');
			resetAll(universe);
			assert.deepEqual(removes(), [earth.id, mars.id, sun.id]);
			const cmds = bridge.sent.map((m) => m.cmd);
			assert.equal(cmds.filter((c) => c === 'clear').length, 1);
			assert.ok(cmds.lastIndexOf('remove') < cmds.indexOf('clear') && cmds.indexOf('clear') < cmds.lastIndexOf('add'), 'removals, clear, then the new Sun');
			const seqs = bridge.sent.filter((m) => m.seq !== undefined).map((m) => m.seq);
			assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'increasing sequence numbers');
			assert.equal(new Set(seqs).size, seqs.length);
		});
	});

	// ==================================================================
	// R7. Records and states the scan had allowed with a wrong reason (G3-2-03): they take live objects only
	// ==================================================================
	describe('R7. the effect-trail reference, the ORBIT pass and the pad host take live objects only; the launcher load too', () => {
		it('effect trail (real path): a frame on its way names the removed Earth as the climbing rocket\'s dominant body: the point is recorded at the rocket, not relative to Earth', async () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			launch(universe, bridge, rocket);
			stepFrames(bridge, 20);
			assert.deepEqual([rocket.dominantBodyId, rocket.isIgnited && rocket.burnTime > 0], [earth.id, true], 'input: burning, Earth dominant');
			const last = () => rocket.effectTrail.getPoint(rocket.effectTrail.count - 1);
			assert.equal(last().refId, earth.id, 'input: recorded relative to the live Earth');
			bridge.frame(1);
			universe.removeObject(earth);
			const before = rocket.effectTrail.count;
			await flush();
			assert.equal(rocket.dominantBodyId, earth.id, 'input: the frame made before the removal names Earth');
			assert.ok(rocket.effectTrail.count > before || rocket.effectTrail.count === rocket.effectTrail.capacity, 'input: a point recorded');
			const pt = last();
			assert.equal(pt.refId, -1, 'not relative to the removed Earth (drawn at its relative coordinates once Earth has faded)');
			assert.ok(Math.hypot(pt.x - rocket.x, pt.y - rocket.y) < UnitConvertUtils.m2pix(1e4), 'absolute, at the rocket (its nozzle offset)');
		});

		it('effect trail: the same point as relative to a live body, shifted by its position (GravSimObject and Rocket); a missing body as removed', () => {
			const px = UnitConvertUtils.m2pix;
			const ref = new CelestialBody(3, 'Earth', px(1.5e11), px(2e10), 0, 0, 5.97e21, '#00f', 3, 6.371e6, 0);
			const record = (obj, objects) => { obj.updateHistory(7, objects, true); return obj.effectTrail.getPoint(obj.effectTrail.count - 1); };
			for (const make of [
				() => Object.assign(new CelestialBody(4, 'Moon', ref.x + px(3.8e8), ref.y, 0, 0, 7.3e19, '#ccc', 2, 1.7e6, 0), { dominantBodyId: 3 }),
				() => mainRocket(4, { x: ref.x + px(7e6), y: ref.y + px(1e5), isIgnited: true, isHoldDown: false, burnTime: 100, dominantBodyId: 3, inAtmosphere: false })
			]) {
				const live = record(make(), [ref]);
				assert.equal(live.refId, 3, 'input: a live reference');
				ref.setCollided();
				const removed = record(make(), [ref]);
				const missing = record(make(), []);
				ref.state = OBJECT_STATE.ACTIVE;
				assert.deepEqual([removed.refId, missing.refId], [-1, -1]);
				assert.ok(Math.abs(removed.x - (live.x + ref.x)) < 1e-6 && Math.abs(removed.y - (live.y + ref.y)) < 1e-6, `${removed.x} ${live.x + ref.x}`);
				assert.deepEqual([removed.x, removed.y], [missing.x, missing.y], 'a removed body is as none');
			}
		});

		it('ORBIT pass: at orbital speed around a live host it passes; around a removed host (listed, frozen) only the time rule passes it', () => {
			const EV = TRAJECTORY_PREDICTION.EVENTS;
			const earthParam = presetManager.getObjectParam('Earth');
			const px = UnitConvertUtils.m2pix;
			const host = new CelestialBody(3, 'Earth', 0, 0, 0, 0, earthParam.MASS, '#00f', 3, earthParam.RADIUS, 0);
			const r = earthParam.RADIUS + 2 * EV.ORBIT_MIN_ALT_M;
			const vCirc = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(earthParam.MASS) / r);
			const flying = (flightTime) => mainRocket(4, {
				x: px(r), y: 0, vx: 0, vy: px(vCirc), hostId: 3,
				telemetry: { altM: 2 * EV.ORBIT_MIN_ALT_M, vV: 0, flightTime },
				predictedTrajectory: { hostId: 3, events: [{ id: 'orbit', type: 'orbit', time: 5000 }] }
			});
			const passed = (rocket) => {
				TrajectoryPredictor.updateRocketFlightEvents(rocket, { objectsMap: new Map([[3, host]]), basis: host });
				return rocket.passedEventIds.has('orbit');
			};
			assert.equal(passed(flying(600)), true, 'input: orbital speed at 600 s around the live host');
			host.setCollided();
			assert.equal(passed(flying(600)), false, 'the removed host does not measure the orbit (the pass state is not set by it)');
			assert.equal(passed(flying(5000)), true, 'the time rule still applies');
			// The camera basis (no host id) likewise
			const noHost = flying(600);
			noHost.hostId = null;
			TrajectoryPredictor.updateRocketFlightEvents(noHost, { objectsMap: new Map(), basis: host });
			assert.equal(noHost.passedEventIds.has('orbit'), false, 'a removed basis');
			host.state = OBJECT_STATE.ACTIVE;
			const noHost2 = flying(600);
			noHost2.hostId = null;
			TrajectoryPredictor.updateRocketFlightEvents(noHost2, { objectsMap: new Map(), basis: host });
			assert.equal(noHost2.passedEventIds.has('orbit'), true, 'a live basis');
		});

		it('pad host (real path): Clear Selected › celestial while the rocket climbs below the stop altitude: the pad effect stops at the next update', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			const vfx = universe.VisualEffectManager;
			launch(universe, bridge, rocket);
			assert.ok(stepFrames(bridge, 60, () => (rocket.telemetry?.relativeAltM ?? 0) > 5), 'input: lifted off');
			vfx.update(0.016);
			assert.ok(rocket.telemetry.altM < ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M, 'input: below the stop altitude');
			assert.deepEqual([vfx.padEffect.isActive, vfx.padEffect.hostId], [true, earth.id], 'input: the pad effect runs on Earth');
			clearSelected(universe, { celestial: true });
			assert.deepEqual([earth.state, isLiveObject(rocket), universe.objects.includes(earth)], [OBJECT_STATE.REMOVED, true, true], 'input: Earth removed (listed), the rocket flies on');
			assert.equal(vfx._buildPadContext(), null, 'no pad context without its host');
			vfx.update(0.016);
			assert.equal(vfx.padEffect.isActive, false, 'stopped (the removed Earth carried the pad before)');
		});

		it('launcher load: a save without hostAutoSelected takes a world-center host as automatic only while it is in the simulation', () => {
			const { universe } = newUniverse();
			const sun = universe.objects[0];
			const rl = universe.RocketLauncher;
			rl.loadState({ hostId: sun.id });
			assert.equal(rl.hostAutoSelected, true, 'input: the rule of a legacy save (§4.13-27)');
			universe.removeObject(sun);
			rl.loadState({ hostId: sun.id });
			assert.equal(rl.hostAutoSelected, false, 'a removed center (still listed) is not taken');
		});
	});

	// ==================================================================
	// S. The pattern: a source scan of the main-thread scripts
	// ==================================================================
	describe('S. every main-thread iteration or lookup of an object list applies the rule of a live object, or is listed with its reason', () => {
		/**
		 * Iterations, lookups and counts of a list of objects held in `list` (universe.objects, a render context's
		 * objects, a variable named so, or an alias of one), and lookups of a map of them held in `map` (objectsMap):
		 * the array methods, called directly or optionally (`objects?.find?.(`), a for-of loop over the list (also with a
		 * `|| []` / `?? []` default), an element at a literal index, the length (a count, or "the list is empty": a
		 * removed object still fading out is counted, design §4.13-27, G3-2-03), and `map.get(` (also `?.get?.(`).
		 */
		const hitPattern = (list, map) => new RegExp([
			`\\b${list}\\b\\s*(?:\\?\\.|\\.)\\s*(?:find|filter|some|every|forEach|map|reduce|findIndex|indexOf|includes)\\s*(?:\\?\\.\\s*)?\\(`,
			`for\\s*\\(\\s*(?:const|let)\\s+\\w+\\s+of\\s+[\\w.?]*\\b${list}\\s*(?:(?:\\|\\||\\?\\?)\\s*\\[\\s*\\]\\s*)?\\)`,
			`\\b${list}\\s*(?:\\?\\.\\s*)?\\[\\s*\\d+\\s*\\]`,
			`\\b${list}\\s*(?:\\?\\.|\\.)\\s*length\\b`,
			`\\b${map}\\s*(?:\\?\\.|\\.)\\s*get\\s*(?:\\?\\.\\s*)?\\(`
		].join('|'), 'g');
		const HIT = hitPattern('objects', 'objectsMap');
		/**
		 * An alias: a variable (declared or assigned) that holds the list or the map itself, with an empty default at most
		 * (`const list = this.universe.objects;`, `x = renderContext.objectsMap || new Map();`). Its hits are scanned
		 * from the assignment to the end of the enclosing block. A variable named `objects` / `objectsMap` is seen by HIT
		 * everywhere already.
		 * Out of scope (the input test below shows they are not seen): destructuring with renaming
		 * (`const { objects: list } = rc`), a list reached through another property or a function's return value
		 * (`const list = this.getObjects()`), a list passed as an argument to a parameter of another name, copies
		 * (`[...objects]`, `Array.from(objects)`, `objects.slice()`), and an element at a computed index (`objects[i]`;
		 * its loop `for (...; i < objects.length; ...)` is a hit through the length). Of these, only the computed index is
		 * in the main-thread scripts at the time of writing: `const obj = objects[i];` of WorkerBridge.formatWorkerToMain
		 * (gravsim_worker_bridge.js), inside the loop over the same list, whose length hits are allowed below with the
		 * reason that covers the element too (the physics Worker's own list, which has no removed objects).
		 */
		const ALIAS = /(?<![\w.$])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?<![=!<>])=(?![=>])\s*[\w.?]*\b(?:objects|objectsMap)\s*(?:(?:\|\||\?\?)\s*(?:\[\s*\]|new\s+Map\s*\(\s*\)))?\s*(?=;|\n|\))/g;
		/** The rule: isLiveObject, a count of live objects (countLive), or the explicit state test (the flying rule of §4.13-23(a) is written so in places). */
		const GUARD = /isLiveObject\(|countLive\(|OBJECT_STATE\.ACTIVE|\.state\s*(?:===|!==)\s*0\b|isFlyingRocket/;
		/** Source with string contents blanked (same length and line breaks): braces in strings do not open blocks. */
		const blankStrings = (src) => src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));
		/** Index of the brace that closes the block around `from` (the end of the text if none). */
		const blockEnd = (code, from) => {
			let depth = 0;
			for (let i = from; i < code.length; i++) {
				if (code[i] === '{') { depth++; } else if (code[i] === '}') { if (depth === 0) { return i; } depth--; }
			}
			return code.length;
		};
		/**
		 * Hits of a source. The rule counts on the hit's line, or, for a loop variable or a variable the hit assigns, in a
		 * test of that variable on the next three lines with code (`isLiveObject(v)`, `v.state`): the loop's or the found
		 * object's test. Each hit says through which name it was found (`via`: objects / objectsMap, or the alias).
		 */
		const scan = (files) => {
			const hits = [];
			for (const [file, src] of files) {
				const text = stripComments(src);
				const code = blankStrings(text);
				const lines = text.split('\n');
				const found = [...text.matchAll(HIT)].map((m) => ({ index: m.index, m0: m[0], via: 'objects' }));
				for (const a of code.matchAll(ALIAS)) {
					const alias = a[1];
					if (alias === 'objects' || alias === 'objectsMap') { continue; }
					const from = a.index + a[0].length;
					const scope = text.slice(from, blockEnd(code, from));
					for (const m of scope.matchAll(hitPattern(alias, alias))) { found.push({ index: from + m.index, m0: m[0], via: alias }); }
				}
				for (const { index, m0, via } of found.sort((x, y) => x.index - y.index)) {
					const ln = text.slice(0, index).split('\n').length;
					const line = lines[ln - 1];
					const name = (m0.match(/^for\s*\(\s*(?:const|let)\s+(\w+)/) || line.match(/(?:^|[\s(])(?:const|let|var)?\s*(\w+)\s*=[^=]/) || [])[1];
					const next = lines.slice(ln).filter((l) => l.trim() !== '').slice(0, 3).join('\n');
					const tested = Boolean(name) && new RegExp(`isLiveObject\\(\\s*${name}\\b|\\b${name}\\.state\\b`).test(next);
					hits.push({ file, line: ln, text: line.trim(), via, guarded: GUARD.test(line) || tested });
				}
			}
			return hits;
		};
		/**
		 * The hits that need no rule: [file, the hit's line (trimmed), how often, why]. Each must still be there, as often,
		 * so the list cannot cover a hit that has changed.
		 */
		const ALLOWED = [
			// Recording, for that drawing only: the path is drawn relative to the same host by renderTrajectory, which draws
			// nothing once the host has left the list; while a removed host is listed it stays where it was removed (it takes
			// no frames), so the points recorded relative to it are the rocket's own positions. Not saved, not sent
			['gravsim_object.js', 'const host = objects.find(o => o.id === hostId);', 1, '_recordActualFlightPath: records the actual flight path relative to the host it is drawn relative to (renderTrajectory draws it only while that host is listed); a removed host is frozen where it was removed, so the recorded points are the rocket positions; neither saved nor sent to the Worker'],
			['gravsim_object_manager.js', 'const target = this.objects.find(t => t.id === id);', 1, 'updateRocketState: the commands of a launch sequence, which aborts with its rocket; the Worker ignores an id it does not have'],
			['gravsim_object_manager.js', 'this.objects = this.objects.filter(obj => !obj.finished());', 1, 'the fade-out itself: a removed object leaves the list when its trail has faded'],
			['gravsim_renderer.js', 'objects.forEach(obj => objectsMap.set(obj.id, obj));', 1, 'drawing: a removed object draws its fading trail only'],
			['gravsim_renderer.js', 'objects.forEach(obj => obj.draw(this.renderContext));', 1, 'drawing: a removed object draws its fading trail only'],
			['gravsim_sound_effects.js', 'const atmParam = this.universe?.objects?.find(o => o.id === rocket.dominantBodyId)?.param ?? null;', 1, 'the atmosphere of the body the Worker named for a flying rocket (Mach fallback)'],
			// One lookup since the MET and the conditions share _getTargetRocket (design §4.14-6)
			['gravsim_sound_sequencer.js', 'return this.universe.objects.find(o => o.id === targetId) || null;', 1, 'the telemetry target, kept destroyed (§4.13-30): its flight time and telemetry are frozen, so no once-only rule fires anew'],
			['gravsim_tab_rocket.js', 'const host = this.universe.objects.find(o => o.id === hostId && o.type === OBJECT_TYPES.CELESTIAL);', 1, '_isReplaceableHost: a removed automatic world center is replaceable too'],
			['gravsim_telemetry_card.js', 'let targetObj = universe.objects.find(o => o.id === targetId);', 1, 'the camera view of the shown rocket, kept destroyed (§4.13-30)'],
			['gravsim_telemetry_panel.js', 'let target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);', 1, 'the shown rocket, kept destroyed (§4.13-30)'],
			['gravsim_telemetry_panel.js', 'target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);', 1, 'the shown rocket, kept destroyed (§4.13-30)'],
			['gravsim_trail_renderer.js', 'const refObj = objectsMap.get(pt.refId);', 1, 'drawing: a trail point relative to its reference body'],
			['gravsim_trajectory_predictor.js', 'hostObj = renderContext.objectsMap.get(hostId);', 1, 'drawing: a prediction line relative to its host'],
			['gravsim_trajectory_predictor.js', 'hostObj = renderContext.objects.find(o => o.id === hostId);', 1, 'drawing: a prediction line relative to its host'],
			['gravsim_universe.js', 'if (!nextCenter && objects.length > 0) {', 1, 'the camera fallback: `objects` is the live list of the line before'],
			['gravsim_universe.js', 'nextCenter = objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, objects[0]);', 2, 'the camera fallback: `objects` is the live list of the line before'],
			['gravsim_universe.js', 'const listedCount = this.ObjectManager.objects.length;', 1, 'updateUI: the listed count on purpose, beside the live count (countLive): the lists are also rebuilt when an object that was fading out leaves the list (§4.13-31)'],
			['gravsim_universe.js', "EventBus.emit('camera:set-tracking-target', this.objects[0]);", 1, 'reset(): the new Sun, the list was just emptied'],
			['gravsim_universe.js', 'const target = this.objects.find(o => o.id === state.centerObjectId);', 1, 'loadState(): the loaded objects, all in the simulation'],
			['gravsim_universe.js', 'const tgt = target || (this.objects.length > 0 ? this.objects[0] : null);', 2, 'loadState(): the loaded objects, all in the simulation (the length and the first of them)'],
			['gravsim_visual_effect_manager.js', 'const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);', 1, 'the pad context: update() stops the effect when its rocket is not flying (the rocket is not otherwise used for a state)'],
			['gravsim_worker_bridge.js', 'const requiredLength = objects.length * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;', 1, 'formatWorkerToMain: the physics Worker\'s own list of its engine (called in gravsim_calc.js only), which has no removed objects'],
			['gravsim_worker_bridge.js', 'for (let i = 0; i < objects.length; i++) {', 1, 'formatWorkerToMain: the physics Worker\'s own list of its engine (called in gravsim_calc.js only), which has no removed objects']
		];
		const key = (file, text) => `${file}|${text}`;

		it('input: the scan finds an unguarded loop and lookup, takes a test on the next lines, and sees objects[0] and objectsMap', () => {
			const hits = scan([['t.js', [
				'for (const obj of this.universe.objects) {',
				'\tlist.push(obj);',
				'}',
				'const a = this.universe.objects.find(o => o.id === id);',
				'const b = this.universe.objects.find(o => o.id === id && isLiveObject(o));',
				'for (const obj of this.universe.objects) {',
				'\t// a comment line',
				'\tif (!isLiveObject(obj)) { continue; }',
				'}',
				'const c = this.objects[0];',
				'const d = renderContext.objectsMap.get(id);',
				'const e = objects.filter(o => o.state === OBJECT_STATE.ACTIVE);'
			].join('\n')]]);
			assert.deepEqual(hits.map((h) => [h.line, h.guarded]), [[1, false], [4, false], [5, true], [6, true], [10, false], [11, false], [12, true]]);
		});

		it('input (G3-2-03): optional calls, the length, a default list, an alias in its block; what is out of scope is not seen', () => {
			const hits = scan([['t.js', [
				'const a = this.universe?.objects?.find?.(o => o.id === id);',
				'const b = this.universe?.objects?.find?.(o => o.id === id && isLiveObject(o));',
				'const c = rc.objectsMap?.get?.(id);',
				'const empty = this.universe.objects.length === 0;',
				'const n = om ? om.countLive() : this.universe.objects.length;',
				'for (const o of this.universe.objects || []) {',
				'\tuse(o);',
				'}',
				'function f() {',
				'\tconst list = this.universe.objects;',
				'\tconst s = "{";',
				'\tobj.isWorldCenter = list.length === 0;',
				'\tconst g = list?.find?.(o => o.id === id);',
				'\tmap = rc.objectsMap || new Map();',
				'\tconst h = map.get(id);',
				'}',
				'const k = list.find(o => o.id === id);',
				'const { objects: renamed } = rc;',
				'const r = renamed.find(o => o.id === id);',
				'const q = this.getObjects().find(o => o.id === id);',
				'const copy = [...this.universe.objects];',
				'const i0 = objects[i];'
			].join('\n')]]);
			assert.deepEqual(hits.map((h) => [h.line, h.via, h.guarded]), [
				[1, 'objects', false], [2, 'objects', true], [3, 'objects', false], [4, 'objects', false], [5, 'objects', true],
				[6, 'objects', false],
				[12, 'list', false], [13, 'list', false], [15, 'map', false]
			], 'line 17 is after the block of the alias; lines 18 to 22 are the stated out-of-scope forms');
		});

		it('every hit in scripts/ (main thread) applies the rule or is allowed; every allowed hit is still there, as often', () => {
			const hits = scan(SCRIPTS.filter(([f]) => MAIN_FILES.includes(f)));
			assert.ok(hits.length > 60, `input: ${hits.length} hits`);
			const allowed = new Map(ALLOWED.map(([f, t, n]) => [key(f, t), n]));
			const counts = new Map();
			const offending = [];
			for (const h of hits) {
				if (h.guarded) { continue; }
				const k = key(h.file, h.text);
				if (allowed.has(k)) {
					counts.set(k, (counts.get(k) || 0) + 1);
				} else {
					offending.push(`${h.file}:${h.line}: ${h.text}`);
				}
			}
			assert.deepEqual(offending, []);
			assert.deepEqual(ALLOWED.filter(([f, t, n]) => counts.get(key(f, t)) !== n).map(([f, t]) => `${f}: ${t}`), [], 'every allowed hit is still there, as often');
			assert.ok(ALLOWED.every(([, , , why]) => typeof why === 'string' && why.length > 20), 'each with its reason');
		});

		it('the Worker side of the removal protocol: the frame carries the sequence number, a remove and a clear set it, the clear empties the world', () => {
			const ctrl = new SimulationController();
			ctrl.engine.addObject({ id: 1, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, radius: 7e8, mass: 2e30, generation: 0 });
			ctrl.engine.addObject({ id: 2, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 1e11, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, radius: 1, mass: 1, generation: 1 });
			assert.equal(ctrl.syncSeq, 0);
			ctrl.handleMessage({ data: { cmd: 'remove', id: 2, seq: 3 } });
			assert.deepEqual([ctrl.syncSeq, ctrl.engine.objects.map((o) => o.id)], [3, [1]]);
			ctrl.handleMessage({ data: { cmd: 'remove', id: 99 } });
			ctrl.handleMessage({ data: { cmd: 'remove', id: 99, seq: 2 } });
			assert.equal(ctrl.syncSeq, 3, 'a message without a number, or an older one, leaves it');
			ctrl.handleMessage({ data: { cmd: 'clear', seq: 4 } });
			assert.deepEqual([ctrl.syncSeq, ctrl.engine.objects], [4, []]);
			const posted = [];
			const prevSelf = globalThis.self;
			globalThis.self = { postMessage: (m) => posted.push(m) };
			try {
				ctrl.lastTime = Date.now() - 16;
				ctrl.update();
			} finally {
				globalThis.self = prevSelf;
			}
			assert.equal(posted.length, 1);
			assert.equal(posted[0].syncSeq, 4, 'the frame says which removals it reflects');
		});
	});
});
