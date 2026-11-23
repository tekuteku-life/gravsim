/**
 * Regression Suite 17: the four pre-existing defects that remained after the pattern sweep of regression 16, each with
 * the same pattern elsewhere in scripts/ (design §4.13-27 to -30).
 *
 *  W. "The Sun is id 0" (§4.13-27). Universe.clearObjects kept the object with id 0, the camera fallback and
 *     RocketTab._getDefaultHostId preferred a body whose id is not 0, and RocketTab replaced a host with id 0 by the
 *     default host (abort, object-list change, open). Only the Sun of the first world of a page has id 0: System ›
 *     Reset does not restart the id counter, so after a Reset the clear of Deploy › Binary Star System removed the new
 *     Sun and the generator turned the removed object into "Sun A" (only "Sun B" existed); the Rocket tab kept the
 *     automatically chosen Sun as host when Earth was deployed; and a deliberately chosen "Sun (ID: 0)" was replaced by
 *     Earth at the next object-list change. The explicit concepts now: CelestialBody.isWorldCenter (the first body
 *     placed into an empty world, saved; a save without it takes the body with id 0, as those versions did; empty: no
 *     object in the simulation, so the outcome does not depend on a removed center still fading, audit G3-2-03) and
 *     RocketLauncher.hostAutoSelected (the host is the Rocket tab's automatic choice; saved; a save without it takes a
 *     world-center host as automatic). The id counter keeps counting across Reset (ids are references held outside the
 *     list), and the physics of a world does not depend on the ids.
 *  E. 'rocket:destroyed' was listened for (SoundEffects, git 0dbb27e) and never emitted (§4.13-28): ObjectManager emits
 *     it once per rocket at its main-thread destruction; the listener stops the water deluge of the sequence's rocket,
 *     which nothing else stopped. 'audio:stop-all' (same commit) had no emitter either: its listener was removed.
 *  P. The low-detail drawing widened the plume for the SRBs whenever they were not burnt out, so on the pad after MAIN
 *     ENGINE START it showed them firing (§4.13-29). Both levels of detail use RocketRenderer.isBoosterFiring.
 *  S. SoundEffects._getActiveRocket chose the sequencer's rocket (or the camera target, or the first rocket) even
 *     destroyed, so another rocket that still fires stayed silent until the destroyed one was cleaned up (§4.13-30).
 *     The same pattern: the pad effect of a destroyed rocket, the theme of Worker debris, the default launch host.
 *
 * Expected values: the deploy profiles of gravsim_const.js (names of the stars and planets), the startup behaviour
 * (the same steps from a fresh page), the save-file versions (a file without the new fields), the Worker rule of the
 * SRB ignition (CalcRocket: !isHoldDown && isIgnited on the first stage) and the drawing of the high detail, the
 * main-thread rule of a flying object (state ACTIVE and not destroyed, §4.13-23), the shipped deluge rule. Nothing is
 * copied from the output of the code under test.
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
import { GravSimObject, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { SoundEffects } from '../../scripts/gravsim_sound_effects.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import * as presetModule from '../../scripts/gravsim_preset_manager.js';
import * as utils from '../../scripts/gravsim_utils.js';
import { OBJECT_TYPES, OBJECT_STATE, DEPLOY_PROFILES } from '../../scripts/gravsim_const.js';

const { presetManager } = presetModule;
const { UnitConvertUtils } = utils;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js')).sort()
	.map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')]);
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const source = (file) => SCRIPTS.find(([f]) => f === file)[1];
/** Source without block and line comments, with the same line breaks (the comments name the history). */
const stripComments = (src) => src
	.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
	.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
/** ... and without string literals (keeps the quotes, blanks the content). */
const stripStrings = (src) => src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, (m) => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`);
const code = (file) => stripStrings(stripComments(source(file)));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
/** Files that run only in a Worker (physics, predictor, flight computer). */
const WORKER_FILES = ['gravsim_calc.js', 'gravsim_calc_object.js', 'gravsim_calc_predictor.js', 'gravsim_flight_computer.js', 'gravsim_calc_quadtree.js'];
const MAIN_FILES = SCRIPTS.map(([f]) => f).filter((f) => !WORKER_FILES.includes(f));

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 16
// ------------------------------------------------------------------
let activeBridge = null;
class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
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
const stepFrames = (bridge, frames, stopWhen = null, onBuffer = null) => {
	const e = bridge.ctrl.engine;
	for (let f = 0; f < frames; f++) {
		e._categorizeBodies();
		e._buildQuadTree(FRAME_S);
		e._checkCollisions(FRAME_S);
		e._checkRocheLimit();
		for (let i = 0; i < SUB_STEPS; i++) { e._moveObjects(DT); }
		e._updateEscapeStatus();
		const buf = WorkerBridge.formatWorkerToMain(e.objects);
		if (onBuffer) { onBuffer(buf, e.objects); }
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
	// The trajectory prediction is not under test here: skip it
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
/** Deploy › a profile button (Binary Star, Three-Body, Galactic Center). */
const deploy = (universe, profileId) => {
	EventBus.emit('object:deploy-profile', profileId);
	universe.updateUI(0);
};
/** Deploy › a planet button (object:deploy-orbit-sun), then the object-list change of the next frame. */
const deployPlanet = (universe, name) => {
	EventBus.emit('object:deploy-orbit-sun', name);
	universe.updateUI(0);
	const obj = universe.objects.filter((o) => o.name === name && o.state === OBJECT_STATE.ACTIVE).pop();
	assert.ok(obj, `input: ${name} deployed (presets/celestials loaded from the working directory)`);
	return obj;
};
const active = (universe) => universe.objects.filter((o) => o.state === OBJECT_STATE.ACTIVE);
const activeNames = (universe) => active(universe).map((o) => o.name).sort();
const tabButton = (target) => {
	const btn = createMockElement('button');
	btn.setAttribute('data-target', target);
	return btn;
};
const openTab = (universe, target) => universe.ControlPanel._tabBtnClick({ target: tabButton(target) });
/** The user picks a host in the Rocket tab's host list. */
const chooseHost = (universe, id) => {
	universe.ControlPanel.rocketTab.ui.rlHostSelect.dispatchEvent({ type: 'change', target: { value: String(id) } });
};
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

/** Rollout through the real RocketLauncher on a host, then the LEGACY_QUICK command order of LaunchSequencer. */
const rollout = (universe, host, { vehicleId, payloadId, missionId }) => {
	const launcher = universe.RocketLauncher;
	launcher.hostId = host.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	const before = new Set(universe.objects);
	launcher.rollout();
	const rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
	assert.ok(rocket, 'input: rolled out');
	return rocket;
};
const launch = (universe, bridge, rocket, { deluge = false } = {}) => {
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	if (deluge) { seq.executeCommand('WATER_DELUGE', 'WATER DELUGE'); }
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
};

// ------------------------------------------------------------------
// Recording Web Audio (the gain targets each voice is driven to), as regression 16
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
/** Wait for the voices' delayed teardown (stop() frees the nodes after 120 ms). */
const afterTeardown = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Record the payloads of an EventBus event until stop(). */
const record = (event) => {
	const seen = [];
	const listener = (...args) => seen.push(args.length > 1 ? args : args[0]);
	EventBus.on(event, listener);
	Object.defineProperty(seen, 'stop', { value: () => EventBus.off(event, listener), enumerable: false });
	return seen;
};

/** Names of the binary profile: the two stars, its planets and the Moon of the planet that has one. */
const BINARY_NAMES_OF = (profiles) => {
	const g = profiles.BINARY_SYSTEM.generators[0];
	return [g.primary.name, g.secondary.name, ...g.planets.map((p) => p.template), ...g.planets.filter((p) => p.hasMoon).map(() => 'Moon')].sort();
};

/** A main-thread Falcon 9 object with a given id. */
const mainRocket = (id, overrides = {}) => Object.assign(new Rocket(id, `R${id}`, 0, 0, 0, 0, 20, 100, 200, '#ffffff', 5, 10, 0), overrides);

describe('Regression 17: the remaining pre-existing defects and their patterns (design §4.13-27 to -30)', () => {
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

	// ==================================================================
	// W. The world center and the automatic launch host (§4.13-27)
	// ==================================================================
	describe('W1. after System › Reset the deploy profiles build the same world as from a fresh page', () => {
		const BINARY_NAMES = BINARY_NAMES_OF(DEPLOY_PROFILES);
		/** Kinematics of every active object by name after `frames` Worker frames (ids left out). */
		const kinematics = (universe, bridge, frames) => {
			stepFrames(bridge, frames);
			return Object.fromEntries(active(universe).map((o) => [o.name, [o.x, o.y, o.vx, o.vy, o.mass]]));
		};
		/** A fresh page that deploys Earth, runs, and resets (the ids keep counting). */
		const afterReset = () => {
			const w = newUniverse();
			deployPlanet(w.universe, 'Earth');
			deployPlanet(w.universe, 'Mars');
			stepFrames(w.bridge, 5);
			const maxIdBefore = Math.max(...w.universe.objects.map((o) => o.id));
			resetAll(w.universe);
			return { ...w, maxIdBefore };
		};

		it('normal (real path): Binary Star System after Reset has Sun A and Sun B and moves bit for bit as from a fresh page (only the ids differ)', () => {
			assert.deepEqual(BINARY_NAMES, ['Earth', 'Jupiter', 'Moon', 'Sun A', 'Sun B'], 'input: the profile');
			const fresh = newUniverse();
			deploy(fresh.universe, 'BINARY_SYSTEM');
			assert.deepEqual(activeNames(fresh.universe), BINARY_NAMES, 'fresh page');
			const freshIds = active(fresh.universe).map((o) => [o.name, o.id]);
			const freshKin = kinematics(fresh.universe, fresh.bridge, 30);
			EventBus.clearAll();

			const w = afterReset();
			assert.deepEqual(activeNames(w.universe), ['Sun'], 'input: Reset leaves the Sun');
			assert.ok(w.universe.objects[0].id > w.maxIdBefore, 'the counter keeps counting across Reset (decision of §4.13-27)');
			deploy(w.universe, 'BINARY_SYSTEM');
			assert.deepEqual(activeNames(w.universe), BINARY_NAMES, 'after Reset: both stars (the defect left only Sun B)');
			const sunA = active(w.universe).find((o) => o.name === 'Sun A');
			assert.equal(sunA.isWorldCenter, true, 'the Sun of the Reset became Sun A');
			// The same objects in the same order: the ids are shifted, their order (which the Worker's collision pairing
			// reads) is the same
			const ids = active(w.universe).map((o) => [o.name, o.id]);
			assert.deepEqual(ids.map(([n]) => n), freshIds.map(([n]) => n), 'same creation order');
			assert.ok(ids.every(([, id], i) => id !== freshIds[i][1]), 'every id differs from the fresh page');
			const kin = kinematics(w.universe, w.bridge, 30);
			for (const name of BINARY_NAMES) {
				assert.ok(kin[name].every((v, i) => Object.is(v, freshKin[name][i])), `${name}: identical after 30 frames`);
			}
		});

		it('normal (real path): Three-Body and Galactic Center after Reset have the objects of a fresh page; "Clear Selected" keeps the new Sun', () => {
			const namesFresh = {};
			for (const id of ['THREE_BODY', 'GALACTIC_CENTER']) {
				const fresh = newUniverse();
				deploy(fresh.universe, id);
				namesFresh[id] = activeNames(fresh.universe);
				EventBus.clearAll();
			}
			assert.deepEqual(namesFresh.THREE_BODY, [...DEPLOY_PROFILES.THREE_BODY.generators[0].stars.map((s) => s.name), 'Earth (Trisolaris)'].sort(), 'input: the fresh three-body');
			// Since §4.13-32 the profile replaces the world center (this assertion expected 2 Suns before: the page's Sun
			// was kept beside Sgr A*); regression 18 checks the profile's world in full
			assert.equal(namesFresh.GALACTIC_CENTER.filter((n) => n === 'Sun').length, 1, 'input: a fresh Galactic Center has the one Sun of the profile, around Sgr A*');
			for (const id of ['THREE_BODY', 'GALACTIC_CENTER']) {
				const w = afterReset();
				deploy(w.universe, id);
				assert.deepEqual(activeNames(w.universe), namesFresh[id], `${id} after Reset`);
				EventBus.clearAll();
			}
			// System › Clear Selected with celestial bodies only
			const w = afterReset();
			deployPlanet(w.universe, 'Earth');
			EventBus.emit('simulation:clear-objects', false, false, true);
			assert.deepEqual(activeNames(w.universe), ['Sun'], 'the Sun of the Reset is kept, Earth removed');
		});

		it('abnormal: without a world center (it was destroyed, and stays listed while its trail fades) the generators place new stars, never revive the removed one; the same world during and after the fade', () => {
			const PRIMARY = DEPLOY_PROFILES.BINARY_SYSTEM.generators[0].primary.name;
			const THREE_NAMES = [...DEPLOY_PROFILES.THREE_BODY.generators[0].stars.map((st) => st.name), 'Earth (Trisolaris)'].sort();
			/** A fresh page whose Sun is removed: still listed while its trail fades, or faded out of the list. */
			const withoutCenter = (faded) => {
				const w = newUniverse();
				const sun = w.universe.objects[0];
				w.universe.removeObject(sun);
				for (let i = 0; faded && i < 5000 && w.universe.objects.includes(sun); i++) { w.universe.ObjectManager.cleanupObjects(); }
				assert.deepEqual([w.universe.objects.includes(sun), sun.state], [!faded, OBJECT_STATE.REMOVED], `input: removed, ${faded ? 'faded out' : 'listed'}`);
				return { ...w, sun };
			};
			/** The world without ids: every active object in list order, with its role and motion. */
			const worldOf = (universe) => active(universe).map((o) => [o.name, o.isWorldCenter === true, o.x, o.y, o.vx, o.vy, o.mass, o.radius]);
			const seen = {};
			for (const faded of [false, true]) {
				const { universe, bridge, sun } = withoutCenter(faded);
				bridge.sent.length = 0;
				deploy(universe, 'BINARY_SYSTEM');
				const label = faded ? 'after the fade' : 'during the fade';
				assert.deepEqual(activeNames(universe), BINARY_NAMES, `${label}: both stars exist (the defect made the removed object "Sun A")`);
				assert.equal(bridge.sent.some((m) => m.cmd === 'update' && m.id === sun.id), false, `${label}: no update for the removed body`);
				assert.equal(sun.name, 'Sun', `${label}: the removed body is untouched`);
				// The first body of a world without objects in the simulation is its center (design §4.13-27, G3-2-03):
				// the length of the list counted the removed Sun while it faded, so Sun A was no center then
				const center = universe.ObjectManager.getWorldCenter();
				assert.equal(center?.name, PRIMARY, `${label}: the new primary is the world center`);
				assert.deepEqual(active(universe).filter((o) => o.isWorldCenter === true), [center], `${label}: the only one`);
				const world = worldOf(universe);
				EventBus.emit('simulation:clear-objects', false, false, true);
				assert.deepEqual(activeNames(universe), [PRIMARY], `${label}: Clear Selected keeps the center (the defect removed every body during the fade)`);
				seen[label] = { world, kept: activeNames(universe) };
				EventBus.clearAll();
			}
			assert.deepEqual(seen['during the fade'], seen['after the fade'], 'the same world whether the removed Sun still fades or not');
			// The three-body generator likewise: a removed body (here the binary's Sun A, the center destroyed, listed while
			// its trail fades) is not turned into its first star, and its new first star is the center
			const { universe } = withoutCenter(false);
			deploy(universe, 'BINARY_SYSTEM');
			const sunA = universe.ObjectManager.getWorldCenter();
			universe.removeObject(sunA);
			assert.deepEqual([universe.objects.includes(sunA), universe.ObjectManager.getWorldCenter()], [true, null], 'input: the center removed, listed');
			deploy(universe, 'THREE_BODY');
			assert.deepEqual(activeNames(universe), THREE_NAMES, 'all three stars');
			assert.equal(sunA.name, PRIMARY, 'the removed body is untouched');
			assert.equal(universe.ObjectManager.getWorldCenter()?.name, THREE_NAMES.find((n) => n.includes('Trisolaris 1')), 'its first star is the center');
			// Rockets and debris are never the world center
			const om = new ObjectManager(null, { postMessage() {} });
			om.objects = [mainRocket(0, { isWorldCenter: true }), Object.assign(new Debris(1, 'D', 0, 0, 0, 0, 1, '#fff', 1, 1, 0), { isWorldCenter: true })];
			assert.equal(om.getWorldCenter(), null);
		});

		it('boundary: the first body placed into an empty world is the center whatever its id (0, 1, 57); the second is not; a body with id 0 that is not the center is cleared', () => {
			for (const start of [0, 1, 57]) {
				const { universe } = newUniverse();
				universe.ObjectManager.loadState([]);
				GravSimObject._idCounter = start;
				const first = universe.ObjectPlacer.placeObject('Sun', 0, 0, 0, 0);
				const second = universe.ObjectPlacer.placeObject('Sun', 100, 0, 0, 0);
				assert.deepEqual([first.id, first.isWorldCenter, second.isWorldCenter], [start, true, false], `ids from ${start}`);
				EventBus.emit('simulation:clear-objects', false, false, true);
				assert.deepEqual(active(universe), [first], `ids from ${start}: the clear keeps the first`);
				EventBus.clearAll();
			}
			// A loaded world whose id-0 body is not the center (the file says so): the clear removes it, keeps the center
			const { universe } = newUniverse();
			universe.ObjectManager.loadState([
				{ id: 0, type: OBJECT_TYPES.CELESTIAL, name: 'Mars', x: 10, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: false },
				{ id: 5, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: true }
			]);
			EventBus.emit('simulation:clear-objects', false, false, true);
			assert.deepEqual(activeNames(universe), ['Sun']);
			assert.equal(universe.ObjectPlacer._getWorldCenter().id, 5);
			// The default launch host is any body but the center, even when the center is listed last
			universe.ObjectManager.loadState([
				{ id: 1, type: OBJECT_TYPES.CELESTIAL, name: 'Mars', x: 10, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: false },
				{ id: 5, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: true }
			]);
			assert.equal(universe.ControlPanel.rocketTab._getDefaultHostId(), 1, 'Mars, not the center listed after it');
		});
	});

	describe('W2. the camera fallback prefers a body that is not the world center (after Reset as on a fresh page)', () => {
		/** A tracked rocket on Earth: Earth and the rocket are removed; the camera picks the next target. */
		const fallback = (doReset) => {
			const { universe } = newUniverse();
			if (doReset) { deployPlanet(universe, 'Venus'); resetAll(universe); }
			const mars = deployPlanet(universe, 'Mars');
			const earth = deployPlanet(universe, 'Earth');
			const rocket = universe.ObjectPlacer.placeObject('Rocket', earth.x, earth.y, 0, 0, { hostId: earth.id });
			universe.camera.setTrackingTarget(rocket);
			universe.removeObject(earth);
			universe.removeObject(rocket);
			universe.update(16);
			return { target: universe.camera.trackingTarget, mars, sun: universe.objects.find((o) => o.name === 'Sun') };
		};

		it('normal: the host and Earth gone, the camera tracks Mars, not the Sun (fresh page and after Reset alike)', () => {
			for (const doReset of [false, true]) {
				const { target, mars, sun } = fallback(doReset);
				assert.equal(sun.isWorldCenter, true, 'input: the Sun is the world center');
				assert.equal(target, mars, `reset ${doReset}`);
				EventBus.clearAll();
			}
		});
	});

	describe('W3. the automatic launch host is replaced when a body appears; a host the user chose is kept', () => {
		/** Rocket tab with only the Sun, closed again; then Earth is deployed. */
		const hostAfterEarth = (doReset) => {
			const { universe } = newUniverse();
			if (doReset) {
				deployPlanet(universe, 'Mars');
				openTab(universe, 'tab-rocket');
				openTab(universe, 'tab-sys');
				resetAll(universe);
			}
			openTab(universe, 'tab-rocket');
			const sun = universe.objects.find((o) => o.name === 'Sun' && o.state === OBJECT_STATE.ACTIVE);
			const hostWithSun = universe.RocketLauncher.hostId;
			openTab(universe, 'tab-sys');
			const earth = deployPlanet(universe, 'Earth');
			return { universe, sun, earth, hostWithSun };
		};

		it('normal (real path, repro b): after Reset the automatically chosen Sun gives way to Earth when Earth is deployed, as at startup', () => {
			for (const doReset of [false, true]) {
				const { universe, sun, earth, hostWithSun } = hostAfterEarth(doReset);
				assert.equal(hostWithSun, sun.id, `reset ${doReset}: the Sun is the automatic host`);
				assert.equal(universe.RocketLauncher.hostId, earth.id, `reset ${doReset}: Earth after the deploy`);
				assert.equal(universe.ControlPanel.rocketTab.ui.rlHostSelect.value, String(earth.id), 'the host list shows it');
				EventBus.clearAll();
			}
		});

		it('normal (real path, repro c): "Sun (ID: 0)" chosen by the user stays the host when Earth is deployed, the tab reopened or the rollout aborted', () => {
			const { universe } = newUniverse();
			openTab(universe, 'tab-rocket');
			const sun = universe.objects[0];
			assert.equal(sun.id, 0, 'input: the Sun of the page has id 0');
			chooseHost(universe, sun.id);
			assert.equal(universe.RocketLauncher.hostAutoSelected, false);
			openTab(universe, 'tab-sys');
			deployPlanet(universe, 'Earth');
			assert.equal(universe.RocketLauncher.hostId, sun.id, 'kept at the object-list change (the defect switched to Earth)');
			openTab(universe, 'tab-rocket');
			assert.equal(universe.RocketLauncher.hostId, sun.id, 'kept when the tab opens');
			universe.ControlPanel.rocketTab.ui.rlAbortBtn.click();
			assert.equal(universe.RocketLauncher.hostId, sun.id, 'kept by the abort button');
		});

		it('abnormal: no host (null / undefined), a host that names nothing or a rocket, an automatic host that is not the world center', () => {
			const { universe } = newUniverse();
			const tab = universe.ControlPanel.rocketTab;
			const rl = universe.RocketLauncher;
			const sun = universe.objects[0];
			for (const none of [null, undefined]) {
				rl.hostId = none;
				universe.updateUI(0);
				EventBus.emit('object-list-changed', universe.objects.length);
				assert.equal(rl.hostId, sun.id, `${none}: the default host`);
				assert.equal(rl.hostAutoSelected, true);
			}
			const mercury = deployPlanet(universe, 'Mercury');
			assert.equal(rl.hostId, mercury.id, 'the automatic Sun gives way to the first planet');
			deployPlanet(universe, 'Earth');
			assert.equal(rl.hostId, mercury.id, 'an automatic host that is not the world center is kept (as before)');
			const rocket = universe.ObjectPlacer.placeObject('Rocket', 0, 0, 0, 0);
			for (const id of [rocket.id, 9999, 'x', NaN]) {
				rl.hostId = id;
				rl.hostAutoSelected = true;
				EventBus.emit('object-list-changed', universe.objects.length);
				assert.equal(Object.is(rl.hostId, id), true, `${String(id)}: not the automatic world center, kept by the list change`);
			}
			openTab(universe, 'tab-rocket');
			assert.equal(rl.hostId, universe.objects.find((o) => o.name === 'Earth').id, 'open() replaces a host that is no body');
			assert.equal(tab._isReplaceableHost(null), true);
		});

		it('boundary: re-choosing the automatic Sun makes it the user\'s; a world-center host with the flag true / false; the world center at id 1 or 57', () => {
			for (const start of [1, 57]) {
				const { universe } = newUniverse();
				universe.ObjectManager.loadState([]);
				GravSimObject._idCounter = start;
				const sun = universe.ObjectPlacer.placeObject('Sun', 0, 0, 0, 0);
				universe.updateUI(0);
				const rl = universe.RocketLauncher;
				rl.hostId = null;
				openTab(universe, 'tab-rocket');
				assert.deepEqual([rl.hostId, rl.hostAutoSelected], [sun.id, true], `id ${start}`);
				chooseHost(universe, sun.id);
				openTab(universe, 'tab-sys');
				deployPlanet(universe, 'Earth');
				assert.equal(rl.hostId, sun.id, `id ${start}: re-chosen by the user, kept`);
				rl.hostAutoSelected = true;
				EventBus.emit('object-list-changed', universe.objects.length);
				assert.equal(rl.hostId, universe.objects.find((o) => o.name === 'Earth').id, `id ${start}: automatic, replaced`);
				EventBus.clearAll();
			}
		});
	});

	describe('W4. the world center and the automatic host are saved; saves without them read as those versions did', () => {
		const objectsOf = (json) => json.universe.objectManager;

		it('normal (real path): save -> load keeps the center (the Sun only), the automatic or chosen host, and their behaviour after the load', async () => {
			const { universe } = newUniverse();
			deployPlanet(universe, 'Mars');
			openTab(universe, 'tab-rocket');
			const sun = universe.objects[0];
			chooseHost(universe, sun.id);
			openTab(universe, 'tab-sys');
			const json = await saveToJson(universe);
			assert.deepEqual(objectsOf(json).map((o) => [o.name, o.isWorldCenter]), [['Sun', true], ['Mars', false]]);
			assert.deepEqual([json.universe.rocketLauncher.hostId, json.universe.rocketLauncher.hostAutoSelected], [sun.id, false]);
			// Load into a page after Reset (other objects, other ids)
			deployPlanet(universe, 'Venus');
			resetAll(universe);
			loadJson(universe, json);
			const loadedSun = universe.objects.find((o) => o.name === 'Sun');
			assert.deepEqual([loadedSun.id, loadedSun.isWorldCenter, universe.objects.find((o) => o.name === 'Mars').isWorldCenter], [sun.id, true, false]);
			assert.deepEqual([universe.RocketLauncher.hostId, universe.RocketLauncher.hostAutoSelected], [sun.id, false]);
			deployPlanet(universe, 'Earth');
			assert.equal(universe.RocketLauncher.hostId, sun.id, 'the chosen Sun stays after the load');
			// The automatic one: saved true, replaced after the load
			universe.RocketLauncher.hostAutoSelected = true;
			const json2 = await saveToJson(universe);
			assert.equal(json2.universe.rocketLauncher.hostAutoSelected, true);
			json2.universe.objectManager = json2.universe.objectManager.filter((o) => o.name === 'Sun');
			loadJson(universe, json2);
			deployPlanet(universe, 'Earth');
			assert.equal(universe.RocketLauncher.hostId, universe.objects.find((o) => o.name === 'Earth').id, 'the automatic Sun gives way after the load');
			EventBus.emit('simulation:clear-objects', false, false, true);
			assert.deepEqual(activeNames(universe), ['Sun'], 'the loaded center is kept by the clear');
		});

		it('abnormal: a save without the fields takes the body with id 0 as the center and a center host as automatic; non-boolean values count as missing', async () => {
			const { universe } = newUniverse();
			deployPlanet(universe, 'Mars');
			openTab(universe, 'tab-rocket');
			openTab(universe, 'tab-sys');
			const base = await saveToJson(universe);
			for (const bad of [undefined, null, 1, 0, 'true', 'false', {}, []]) {
				const json = JSON.parse(JSON.stringify(base));
				for (const o of objectsOf(json)) { if (bad === undefined) { delete o.isWorldCenter; } else { o.isWorldCenter = bad; } }
				if (bad === undefined) { delete json.universe.rocketLauncher.hostAutoSelected; } else { json.universe.rocketLauncher.hostAutoSelected = bad; }
				json.universe.rocketLauncher.hostId = 0;
				loadJson(universe, json);
				assert.deepEqual(universe.objects.map((o) => [o.id, o.isWorldCenter]), [[0, true], [1, false]], `${JSON.stringify(bad)}: id 0 is the center`);
				assert.equal(universe.RocketLauncher.hostAutoSelected, true, `${JSON.stringify(bad)}: the center host is automatic`);
				// A non-center host from such a save is the user's
				json.universe.rocketLauncher.hostId = 1;
				loadJson(universe, json);
				assert.equal(universe.RocketLauncher.hostAutoSelected, false, `${JSON.stringify(bad)}: a planet host is kept`);
			}
			// A save without the field and without an id-0 body: no center
			const json = JSON.parse(JSON.stringify(base));
			for (const o of objectsOf(json)) { delete o.isWorldCenter; o.id += 10; }
			loadJson(universe, json);
			assert.deepEqual(universe.objects.map((o) => o.isWorldCenter), [false, false]);
		});

		it('boundary: a file naming two centers: the clear keeps both, the generator takes the first; an empty save restarts the counter at 0 with no center', () => {
			const { universe } = newUniverse();
			const twoCenters = [
				{ id: 3, type: OBJECT_TYPES.CELESTIAL, name: 'A', x: 0, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: true },
				{ id: 0, type: OBJECT_TYPES.CELESTIAL, name: 'B', x: 50, y: 0, vx: 0, vy: 0, mass: 1, radius: 1, isWorldCenter: true }
			];
			universe.ObjectManager.loadState(twoCenters);
			assert.equal(GravSimObject._idCounter, 4, 'max id + 1 (unchanged rule)');
			deploy(universe, 'BINARY_SYSTEM');
			assert.deepEqual(activeNames(universe), [...BINARY_NAMES_OF(DEPLOY_PROFILES), 'B'].sort(), 'A became Sun A, B kept');
			assert.equal(universe.objects.find((o) => o.id === 3).name, 'Sun A');
			universe.ObjectManager.loadState(twoCenters);
			universe.removeObject(universe.objects[0]);
			assert.equal(universe.ObjectManager.getWorldCenter().name, 'B', 'A removed: the next active one');
			universe.ObjectManager.loadState([]);
			assert.deepEqual([GravSimObject._idCounter, universe.ObjectManager.getWorldCenter()], [0, null]);
		});
	});

	describe('W (scan). no object id is compared with a numeric literal; the first object is not taken for the world center', () => {
		const OPERAND = String.raw`((?:[A-Za-z_$][\w$]*\??\.)*(?:id|[A-Za-z_$][\w$]*Id))`;
		const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
		const PATTERNS = [
			new RegExp(String.raw`(?<![\w$.])${OPERAND}\s*(===|!==|==|!=|<=|>=|<|>)\s*(${NUM})(?![\w$.])`, 'g'),
			new RegExp(String.raw`(?<![\w$.])(${NUM})\s*(===|!==|==|!=|<=|>=|<|>)\s*${OPERAND}(?![\w$(])`, 'g'),
			new RegExp(String.raw`\bswitch\s*\(\s*${OPERAND}\s*\)`, 'g')
		];
		/** Sentinels and the save migration (each with its reason). */
		const ALLOWED = new Map([
			['gravsim_object.js|this.dominantBodyId|-1', 2], // the frame buffer's "no dominant body" (BUFFER_INDEX.DOMINANT_BODY_ID)
			['gravsim_trail_renderer.js|pt.refId|-1', 1], // a trail point without a reference body
			['gravsim_object_manager.js|c.id|0', 1] // a save without isWorldCenter: those versions took the id-0 body (§4.13-27)
		]);
		const scan = (text) => {
			const hits = [];
			for (const re of PATTERNS) {
				for (const m of text.matchAll(re)) {
					const groups = m.slice(1).filter((g) => g !== undefined);
					const operand = groups.find((g) => /(?:^|\.)(?:id|[A-Za-z_$][\w$]*Id)$/.test(g));
					const literal = groups.find((g) => new RegExp(`^${NUM}$`).test(g)) ?? 'switch';
					hits.push({ key: `${operand}|${literal}`, index: m.index });
				}
			}
			return hits;
		};

		it('input: the scan finds the fixed patterns and their variants when they are put back', () => {
			for (const s of ['if (obj.id !== 0) {', 'o => o.id !== 0 && x', 'if (hostId === null || hostId === 0) {', '0 === o.id', 'a.parentRocketId == 1',
				'x.id > -1', 'switch (rocket.id) {', 'targetHostId === 0 ||', 'o.id !== 0.0', 'this.hostId >= 1e3']) {
				assert.equal(scan(s).length, 1, s);
			}
			for (const s of ['o.id === hostId', 'id !== null', 'f(o.id) === 0', 'o.idx === 0', 'getElementById(1)', 'o.id === other.id', 'arr[0].id', 'x.id0 === 1']) {
				assert.equal(scan(s).length, 0, s);
			}
		});

		it('every comparison of an id with a numeric literal in scripts/ is an allowed sentinel or the save migration', () => {
			const counts = new Map();
			const offending = [];
			for (const [file] of SCRIPTS) {
				const text = code(file);
				for (const h of scan(text)) {
					const key = `${file}|${h.key}`;
					counts.set(key, (counts.get(key) || 0) + 1);
					if (!ALLOWED.has(key)) { offending.push(`${key} line ${lineOf(text, h.index)}`); }
				}
			}
			assert.deepEqual(offending, []);
			assert.deepEqual([...ALLOWED].filter(([k, n]) => counts.get(k) !== n), [], 'every allowed hit is still there, as often');
			// index.html has no inline script that compares ids
			assert.equal(scan(INDEX_HTML).length, 0);
		});

		it('objects[0] is read only where the list is known: the Sun of reset(), the load fallback target, the seed of a largest-mass search', () => {
			const hits = [];
			for (const [file] of SCRIPTS) {
				const text = code(file);
				for (const m of text.matchAll(/\bobjects\[\s*0\s*\]/g)) { hits.push(`${file}:${lineOf(text, m.index)}`); }
			}
			const lines = stripComments(source('gravsim_universe.js')).split('\n');
			assert.equal(hits.every((h) => h.startsWith('gravsim_universe.js:')), true, `only gravsim_universe.js: ${hits}`);
			const kinds = hits.map((h) => lines[Number(h.split(':')[1]) - 1].trim());
			assert.deepEqual(kinds.map((l) => (/reduce\(/.test(l) ? 'reduce seed' : (/camera:set-tracking-target/.test(l) ? 'reset' : (/objects\.length > 0/.test(l) ? 'load fallback' : l)))).sort(),
				['load fallback', 'reduce seed', 'reset']);
			assert.doesNotMatch(code('gravsim_object_placer.js'), /\bobjects\[/, 'the generators take the world center');
		});
	});

	// ==================================================================
	// E. 'rocket:destroyed' (§4.13-28)
	// ==================================================================
	describe('E1. the destruction of the sequence\'s rocket stops its water deluge (Web Audio mock)', () => {
		/** An H3-30 on Earth with the deluge of its countdown, climbing below the tower clearance. */
		const climbingWithDeluge = () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const se = withRecordingAudio(universe.SoundEffects);
			launch(universe, bridge, rocket, { deluge: true });
			assert.ok(stepFrames(bridge, 60, () => (rocket.telemetry?.relativeAltM ?? 0) > 5), 'input: lifted off');
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), true, 'input: the deluge plays');
			assert.ok(rocket.telemetry.relativeAltM < SOUND_TOWER_M, 'input: below the tower clearance');
			return { universe, bridge, rocket, se };
		};
		const SOUND_TOWER_M = 90; // SOUND_FX_CONFIG.waterDeluge.towerClearAltM: the deluge fades out up to it

		it('normal (real path): "Clear Selected" with rockets below the tower: the deluge stops and never plays again after the rocket is gone', async () => {
			const { universe, bridge, rocket, se } = climbingWithDeluge();
			const destroyed = record('rocket:destroyed');
			EventBus.emit('simulation:clear-objects', false, true, false);
			destroyed.stop();
			assert.deepEqual(destroyed, [rocket], 'emitted once with the rocket');
			assert.deepEqual([se.isDelugeTriggered, se.isLiftoffOccurred], [false, false]);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), false, 'silent at once (the defect: full gain once the rocket was cleaned up)');
			await afterTeardown();
			for (let i = 0; i < 3000 && universe.objects.includes(rocket); i++) { universe.ObjectManager.cleanupObjects(); }
			assert.equal(universe.objects.includes(rocket), false, 'input: cleaned up');
			stepFrames(bridge, 1);
			se.update(16, 0.016);
			assert.equal(se.voices.waterDeluge.isRunning, false, 'not restarted');
		});

		it('normal (real path): a body hits the rocket: one event at the collision of the frame buffer, the deluge stops', () => {
			const { universe, bridge, rocket, se } = climbingWithDeluge();
			const host = universe.objects.find((o) => o.name === 'Earth');
			const ux = (rocket.x - host.x) / Math.hypot(rocket.x - host.x, rocket.y - host.y);
			const uy = (rocket.y - host.y) / Math.hypot(rocket.x - host.x, rocket.y - host.y);
			const asteroid = universe.ObjectPlacer.placeObject('Asteroid', rocket.x + ux * UnitConvertUtils.m2pix(400), rocket.y + uy * UnitConvertUtils.m2pix(400),
				rocket.vx - ux * UnitConvertUtils.m2pix(500), rocket.vy - uy * UnitConvertUtils.m2pix(500));
			// The asteroid 400 m above the rocket falls onto it at 500 m/s relative (on its way, 0.8 s), so the collision
			// is that of the next frames
			const relM = [UnitConvertUtils.pix2m(asteroid.x - rocket.x), UnitConvertUtils.pix2m(asteroid.y - rocket.y)];
			const relVM = [UnitConvertUtils.pix2m(asteroid.vx - rocket.vx), UnitConvertUtils.pix2m(asteroid.vy - rocket.vy)];
			assert.ok(Math.abs(Math.hypot(...relM) - 400) < 1e-3 && Math.abs(Math.hypot(...relVM) - 500) < 1e-3, `input: 400 m away at 500 m/s (to 1 mm at 1 AU from the Sun) (${Math.hypot(...relM)} m, ${Math.hypot(...relVM)} m/s)`);
			assert.ok(Math.abs((relM[0] * relVM[0] + relM[1] * relVM[1]) / (Math.hypot(...relM) * Math.hypot(...relVM)) + 1) < 1e-9, 'input: straight towards the rocket');
			const destroyed = record('rocket:destroyed');
			assert.ok(stepFrames(bridge, 10, () => rocket.isDestroyed), 'the rocket is destroyed by the collision');
			stepFrames(bridge, 2);
			destroyed.stop();
			assert.deepEqual(destroyed, [rocket], 'once');
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), false);
		});

		it('abnormal: another rocket, a body or debris, a second removal, no rocket: nothing stops; the deluge of the sequence plays on', () => {
			const { universe, rocket, se } = climbingWithDeluge();
			const other = universe.ObjectPlacer.placeObject('Rocket', rocket.x + 1000, rocket.y, 0, 0);
			const destroyed = record('rocket:destroyed');
			universe.removeObject(other);
			universe.removeObject(other);
			universe.removeObject(universe.objects.find((o) => o.name === 'Sun'));
			const deb = new Debris(9001, 'Debris', 0, 0, 0, 0, 1, '#fff', 1, 1, 0);
			universe.ObjectManager.addObject(deb, false);
			universe.removeObject(deb);
			EventBus.emit('rocket:destroyed');
			EventBus.emit('rocket:destroyed', { id: rocket.id + 1, type: OBJECT_TYPES.ROCKET });
			destroyed.stop();
			assert.equal(destroyed.filter((r) => r === other).length, 1, 'the other rocket once');
			assert.equal(destroyed.includes(rocket), false);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.waterDeluge), true, 'the sequence\'s deluge plays on');
		});

		it('boundary: a sequence rocket with id 0 stops it (id 0 is a rocket); Reset emits once per flying rocket, none for one already destroyed', () => {
			const { universe } = newUniverse();
			const se = withRecordingAudio(universe.SoundEffects);
			const r0 = mainRocket(0);
			const r1 = mainRocket(1);
			universe.ObjectManager.addObject(r0, false);
			universe.ObjectManager.addObject(r1, false);
			universe.LaunchSequencer.rocketId = 0;
			EventBus.emit('sequencer-event', 'WATER DELUGE');
			universe.ObjectManager.removeObject(r1);
			assert.equal(se.isDelugeTriggered, true, 'rocket 1 is not the sequence\'s');
			const destroyed = record('rocket:destroyed');
			resetAll(universe);
			destroyed.stop();
			assert.deepEqual(destroyed, [r0], 'once, for the rocket still flying');
			assert.equal(se.isDelugeTriggered, false);
			EventBus.emit('sequencer-event', 'WATER DELUGE');
			universe.LaunchSequencer.rocketId = -0;
			EventBus.emit('rocket:destroyed', mainRocket(0));
			assert.equal(se.isDelugeTriggered, false, '-0 is the rocket 0');
		});
	});

	describe('E (scan). every EventBus event listened for in scripts/ is emitted there, and every emitted one is listened for', () => {
		/** EventBus.on / emit with a literal name (whole-file match: the name may be on the next line). */
		const events = (files) => {
			const on = new Map();
			const emit = new Map();
			const dynamic = [];
			for (const [file, text] of files) {
				for (const m of text.matchAll(/EventBus\s*\.\s*(on|emit)\s*\(\s*(?:(['"`])([^'"`$]+)\2|([^\s)]))/g)) {
					if (m[3] === undefined) { dynamic.push(`${file}:${lineOf(text, m.index)}`); continue; }
					const map = m[1] === 'on' ? on : emit;
					if (!map.has(m[3])) { map.set(m[3], []); }
					map.get(m[3]).push(`${file}:${lineOf(text, m.index)}`);
				}
			}
			return { on, emit, dynamic };
		};
		/** Allowed: none (listened-only and emitted-only names would be listed here with their reason). */
		const LISTENED_ONLY = new Set([]);
		const EMITTED_ONLY = new Set([]);
		const all = () => events([...SCRIPTS.map(([f]) => [f, stripComments(source(f))]), ['index.html', INDEX_HTML]]);

		it('input: the scan finds a listener without an emitter, an emitter without a listener and a name on the next line', () => {
			const r = events([['a.js', "EventBus.on('x:a', f);\nEventBus.emit(\n\t'x:b', 1);\nEventBus.on(\"x:b\", g);\nEventBus.emit('x:c');"]]);
			assert.deepEqual([...r.on.keys()].filter((k) => !r.emit.has(k)), ['x:a']);
			assert.deepEqual([...r.emit.keys()].filter((k) => !r.on.has(k)), ['x:c']);
			assert.deepEqual(events([['b.js', 'EventBus.on(name, f);']]).dynamic, ['b.js:1']);
		});

		it('no listened-for event without an emitter, no emitted event without a listener, no computed names', () => {
			const { on, emit, dynamic } = all();
			// The count of design §4.13-28 (63 names, each listened for and emitted): a regression of the extraction that
			// drops names fails here, as does a new name the design does not count
			assert.deepEqual([on.size, emit.size], [63, 63], 'listened, emitted names (design §4.13-28)');
			assert.deepEqual([...on].filter(([k]) => !emit.has(k) && !LISTENED_ONLY.has(k)).map(([k, v]) => `${k} (${v})`), []);
			assert.deepEqual([...emit].filter(([k]) => !on.has(k) && !EMITTED_ONLY.has(k)).map(([k, v]) => `${k} (${v})`), []);
			assert.deepEqual(dynamic, []);
			// Listened for by SoundEffects (the deluge), and since §4.13-31 by LaunchSequencer (the sequence of the rocket
			// aborts) and RocketLauncher (the pad is released); this assertion named SoundEffects only before
			const listenerAt = (file) => `${file}:${lineOf(stripComments(source(file)), stripComments(source(file)).indexOf("EventBus.on('rocket:destroyed'"))}`;
			assert.deepEqual([...on.get('rocket:destroyed')].sort(), ['gravsim_launch_sequencer.js', 'gravsim_rocket_launcher.js', 'gravsim_sound_effects.js'].map(listenerAt));
			assert.equal(emit.get('rocket:destroyed').every((s) => s.startsWith('gravsim_object_manager.js:')), true, 'emitted by ObjectManager');
			assert.equal(on.has('audio:stop-all') || emit.has('audio:stop-all'), false, 'the dead listener is gone');
		});
	});

	// ==================================================================
	// P. The SRB plume in the low detail (§4.13-29)
	// ==================================================================
	describe('P. the low detail widens the plume for the SRBs only while the high detail draws SRB plumes', () => {
		const LOD = presetManager.getRocketVisual().LOW_DETAIL;
		const THEME = presetManager.getRocketVisual().THEMES.classic;
		/** Calls of a 2D context, with the fill style at each call. */
		const recordingCtx = () => {
			const calls = [];
			let fillStyle = null;
			const ctx = new Proxy({}, {
				get: (t, k) => {
					if (k === 'fillStyle') { return fillStyle; }
					if (k in t) { return t[k]; }
					if (typeof k === 'string' && k.startsWith('create')) { return () => ({ addColorStop() {} }); }
					return (...args) => { calls.push({ fn: k, args, fillStyle }); };
				},
				set: (t, k, v) => { if (k === 'fillStyle') { fillStyle = v; } else { t[k] = v; } return true; }
			});
			return { ctx, calls };
		};
		/**
		 * The low-detail drawing through RocketRenderer.draw below the LOD radius: the SRB factor of the plume width
		 * (half width / (body width x PLUME_WIDTH_RATIO), at sea-level pressure), or null without a plume.
		 */
		const lowDetailSrbFactor = (rocket) => {
			const r = Object.assign(Object.create(Object.getPrototypeOf(rocket)), rocket, { ambientPresRatio: 1.0 });
			const { ctx, calls } = recordingCtx();
			RocketRenderer.draw(ctx, r, 0, 0, presetManager.getRocketVisual().LOD_RADIUS_THRESHOLD * 0.5, 1);
			const bodyEllipse = calls.find((c) => c.fn === 'ellipse');
			const plume = calls.find((c) => c.fn === 'moveTo' && c.fillStyle === LOD.PLUME_COLOR);
			if (!plume) { return null; }
			const width = 2 * bodyEllipse.args[3];
			return Math.abs(plume.args[1]) / (width * LOD.PLUME_WIDTH_RATIO);
		};
		/** SRB plumes of the high detail (calls of _drawPlume from _drawBoosters). */
		const highDetailSrbPlumes = (rocket) => {
			const orig = RocketRenderer._drawPlume;
			let n = 0;
			RocketRenderer._drawPlume = () => { n++; };
			try {
				RocketRenderer._drawBoosters(recordingCtx().ctx, rocket, 0, 10, 40, -20, 5, THEME, true, 1.0, 10, 1.0);
			} finally {
				RocketRenderer._drawPlume = orig;
			}
			return n;
		};
		const near = (a, b) => Math.abs(a - b) < 1e-12;

		it('normal (real path): an H3-22 from MAIN ENGINE START on the pad to the SRB separation: widened exactly in the frames the high detail draws SRB plumes', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const seq = universe.LaunchSequencer;
			seq.rocketId = rocket.id;
			seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
			const seen = { heldNarrow: 0, wide: 0, burnoutNarrow: 0 };
			const check = () => {
				if (rocket.isBoosterSeparated) { return true; }
				const factor = lowDetailSrbFactor(rocket);
				const plumes = highDetailSrbPlumes(rocket);
				assert.notEqual(factor, null, 'the core fires: a plume');
				assert.equal(factor > 1, plumes > 0, `T+${rocket.telemetry?.flightTime} held ${rocket.isHoldDown} burnout ${rocket.isBoosterBurnout}: factor ${factor}, SRB plumes ${plumes}`);
				if (rocket.isHoldDown) { assert.ok(near(factor, 1), 'on the pad: the core plume only'); seen.heldNarrow++; } else if (plumes > 0) { seen.wide++; } else { seen.burnoutNarrow++; }
				return false;
			};
			stepFrames(bridge, 3, check);
			assert.equal(rocket.isHoldDown && rocket.isIgnited, true, 'input: held with the core engine on');
			seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
			stepFrames(bridge, 400, check);
			// Every phase of the range of the test plan (§4.6-29, MAIN ENGINE START to the SRB separation) is passed: held
			// on the pad, the SRBs firing, and burnt out before their separation (narrow again)
			assert.ok(seen.heldNarrow >= 3 && seen.wide > 50 && seen.burnoutNarrow >= 1, `frames ${JSON.stringify(seen)}`);
			assert.equal(rocket.isBoosterSeparated, true, 'input: ran to the SRB separation');
		});

		it('abnormal: the Worker-only isBoosterIgnited, telemetry-only burnout / separation flags and missing boosters never widen it; not ignited: no plume', () => {
			const h3 = (over = {}) => mainRocket(4, { isIgnited: true, isHoldDown: false, burnTime: 100, thrustRatio: 1, boosters: { count: 2 }, ...over });
			assert.ok(lowDetailSrbFactor(h3()) > 1, 'input: released and ignited, widened');
			assert.ok(near(lowDetailSrbFactor(h3({ isHoldDown: true, isBoosterIgnited: true })), 1), 'a stray Worker flag on the pad');
			assert.ok(near(lowDetailSrbFactor(h3({ telemetry: { isBoosterBurnout: true } })), 1), 'burnout in the telemetry only');
			assert.ok(near(lowDetailSrbFactor(h3({ telemetry: { isBoosterSeparated: true } })), 1), 'separated in the telemetry only');
			for (const boosters of [null, undefined, { count: 0 }]) {
				assert.ok(near(lowDetailSrbFactor(h3({ boosters, rendering: null })), 1), `boosters ${JSON.stringify(boosters)}`);
			}
			assert.equal(lowDetailSrbFactor(h3({ isIgnited: false })), null);
			assert.equal(RocketRenderer.isBoosterFiring({}), false);
			// The predicate on its own (the callers also skip separated SRBs): separated or burnt out never fire
			const released = { isIgnited: true, isHoldDown: false };
			assert.deepEqual([{}, { isBoosterSeparated: true }, { telemetry: { isBoosterSeparated: true } }, { isBoosterBurnout: true }, { telemetry: { isBoosterBurnout: true } }, { isHoldDown: true }]
				.map((o) => RocketRenderer.isBoosterFiring({ ...released, ...o })), [true, false, false, false, false, false]);
		});

		it('boundary: held + ignited 1, released + ignited widened, released not ignited none, burnout 1, separated 1; 4 SRBs (H3-24) the same', () => {
			for (const count of [2, 4]) {
				const r = (over) => mainRocket(4, { isIgnited: true, isHoldDown: false, burnTime: 100, thrustRatio: 1, boosters: { count }, ...over });
				const cases = [
					[{ isHoldDown: true }, 'narrow'], [{}, 'wide'], [{ isIgnited: false }, 'none'],
					[{ isBoosterBurnout: true }, 'narrow'], [{ isBoosterSeparated: true }, 'narrow']
				];
				for (const [over, want] of cases) {
					const f = lowDetailSrbFactor(r(over));
					const got = f === null ? 'none' : (near(f, 1) ? 'narrow' : (f > 1 ? 'wide' : `factor ${f}`));
					assert.equal(got, want, `${count} SRBs ${JSON.stringify(over)}`);
					assert.equal(got === 'wide', highDetailSrbPlumes(r(over)) > 0, `${count} SRBs ${JSON.stringify(over)}: the same as the high detail`);
				}
			}
			// One rule for both levels of detail
			const renderer = code('gravsim_rocket_renderer.js');
			assert.equal((renderer.match(/!rocket\.isHoldDown && rocket\.isIgnited/g) || []).length, 1, 'the ignition rule is written once');
			assert.equal((renderer.match(/this\.isBoosterFiring\(rocket\)/g) || []).length, 2, 'used by the low and the high detail');
		});
	});

	// ==================================================================
	// S. The rocket the sounds follow, and the same pattern (§4.13-30)
	// ==================================================================
	describe('S1. a destroyed rocket is not the active rocket: another rocket that fires plays at once (Web Audio mock)', () => {
		/** Rocket A launched and climbing (the sequence's rocket), rocket B ignited on the pad (the camera's target). */
		const twoRockets = () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const a = rollout(universe, earth, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			launch(universe, bridge, a);
			assert.ok(stepFrames(bridge, 200, () => a.telemetry.altM > 2000), 'input: A climbs');
			universe.RocketLauncher.hostAngleDeg = 90;
			const b = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
			universe.ObjectManager.updateRocketState(b.id, true, true);
			stepFrames(bridge, 3);
			universe.LaunchSequencer.rocketId = a.id;
			universe.camera.setTrackingTarget(b);
			const se = withRecordingAudio(universe.SoundEffects);
			assert.ok(a.isIgnited && a.thrustRatio > 0.01 && b.isIgnited && b.thrustRatio > 0.01, 'input: both fire');
			return { universe, bridge, a, b, se };
		};

		it('normal (real path): A is removed while still listed: the next update plays B (the defect kept the sound on A, silent)', async () => {
			const { universe, a, b, se } = twoRockets();
			se.update(16, 0.016);
			assert.equal(se._getActiveRocket(), a, 'the sequence\'s rocket while it flies');
			universe.ObjectManager.removeObject(a);
			assert.equal(universe.objects.includes(a), true, 'input: A still listed');
			assert.equal(se._getActiveRocket(), b, 'the camera target next');
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'B roars');
			// The destruction of the sequence's rocket stops its deluge only: B's roar is not cut (a stop of every
			// voice would tear it down 120 ms later)
			await afterTeardown();
			assert.equal(se.voices.engineRoar.isRunning, true, 'B\'s roar kept running');
		});

		it('abnormal: every rocket destroyed -> none and silent; the sequence names a body or nothing; objects without the state rule are not rockets in flight', () => {
			const { universe, a, b, se } = twoRockets();
			universe.ObjectManager.removeObject(a);
			universe.ObjectManager.removeObject(b);
			assert.equal(se._getActiveRocket(), null);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false);
			const flying = mainRocket(7, { isIgnited: true, thrustRatio: 1 });
			const earth = universe.objects.find((o) => o.name === 'Earth');
			for (const rocketId of [earth.id, 99999, null, undefined, 'x']) {
				const s = new SoundEffects({ objects: [b, a, earth, flying], LaunchSequencer: { rocketId }, camera: { trackingTarget: earth } });
				assert.equal(s._getActiveRocket(), flying, `sequencer ${String(rocketId)}: the first flying rocket`);
			}
			const plain = { id: 8, type: OBJECT_TYPES.ROCKET };
			assert.equal(new SoundEffects({ objects: [plain], LaunchSequencer: { rocketId: 8 }, camera: {} })._getActiveRocket(), null, 'no state: not flying');
			assert.equal(new SoundEffects({ objects: [mainRocket(9, { state: OBJECT_STATE.ACTIVE, isDestroyed: true })], LaunchSequencer: null })._getActiveRocket(), null, 'destroyed with state ACTIVE');
		});

		it('boundary: the last update before the destruction follows A, the first after follows B, and still B once A is cleaned up; ids 0 and -0', () => {
			const r0 = mainRocket(0, { isIgnited: true, thrustRatio: 1 });
			const r1 = mainRocket(1, { isIgnited: true, thrustRatio: 1 });
			const universe = { objects: [r0, r1], LaunchSequencer: { rocketId: -0 }, camera: { trackingTarget: r1 } };
			const se = new SoundEffects(universe);
			assert.equal(se._getActiveRocket(), r0, 'before: the sequence\'s rocket 0 (-0)');
			r0.setCollided();
			assert.equal(se._getActiveRocket(), r1, 'first after');
			universe.objects = [r1];
			assert.equal(se._getActiveRocket(), r1, 'cleaned up');
			universe.camera.trackingTarget = null;
			r1.setCollided();
			assert.equal(se._getActiveRocket(), null);
		});
	});

	describe('S2. the same pattern: the pad effect, the theme of Worker debris and the default launch host skip destroyed objects', () => {
		it('pad effect (real path): a rocket removed on the pad stops the pad effect at the next update while it is still listed', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const vfx = universe.VisualEffectManager;
			stepFrames(bridge, 1);
			vfx.update(0.016);
			assert.deepEqual([vfx.padEffect.isActive, vfx.padEffect.targetRocketId], [true, rocket.id], 'input: the pad effect runs');
			universe.removeObject(rocket);
			assert.equal(universe.objects.includes(rocket), true, 'input: still listed');
			vfx.update(0.016);
			assert.equal(vfx.padEffect.isActive, false, 'stopped (the defect kept it until the rocket was cleaned up)');
		});

		it('debris theme: Worker debris takes the theme of the first flying rocket, not of a destroyed one listed first', () => {
			const om = new ObjectManager(null, { postMessage() {} });
			om.universe = null;
			const dead = mainRocket(1, { colorTheme: 'classic' });
			dead.setCollided();
			const flying = mainRocket(2, { colorTheme: 'orange' });
			om.objects = [dead, flying];
			om.updateObjectParams({ id: -5, type: OBJECT_TYPES.DEBRIS, debrisSubType: 3, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, mass: 1, radius: 2, generation: 1 });
			const deb = om.objects.find((o) => o.id === -5);
			assert.ok(deb, 'input: the debris is made');
			assert.equal(deb.colorTheme, 'orange');
			// Only destroyed rockets: the default theme
			const om2 = new ObjectManager(null, { postMessage() {} });
			om2.objects = [dead];
			om2.updateObjectParams({ id: -6, type: OBJECT_TYPES.DEBRIS, debrisSubType: 3, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, mass: 1, radius: 2, generation: 1 });
			assert.equal(om2.objects.find((o) => o.id === -6).colorTheme, 'classic', 'no flying rocket: the default classic theme');
		});

		it('default launch host: a cleared body (still listed while its trail fades) is not chosen; open() replaces a cleared host', () => {
			const { universe } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const mars = deployPlanet(universe, 'Mars');
			const tab = universe.ControlPanel.rocketTab;
			chooseHost(universe, earth.id);
			universe.removeObject(earth);
			assert.equal(universe.objects.includes(earth), true, 'input: Earth still listed');
			assert.equal(tab._getDefaultHostId(), mars.id, 'not the removed Earth');
			openTab(universe, 'tab-rocket');
			assert.equal(universe.RocketLauncher.hostId, mars.id, 'the cleared host is replaced');
			universe.removeObject(mars);
			assert.equal(tab._getDefaultHostId(), universe.objects[0].id, 'then the world center');
			universe.removeObject(universe.objects[0]);
			assert.equal(tab._getDefaultHostId(), null, 'no body in the simulation');
		});
	});

	describe('S (scan). main-thread choices of a rocket apply the flying rule', () => {
		it('every find / filter / some on a rocket type in main-thread scripts also tests the state (allow-list: the telemetry panel shows its chosen rocket)', () => {
			const ALLOWED = new Map([['gravsim_telemetry_panel.js', 2]]);
			const counts = new Map();
			for (const file of MAIN_FILES) {
				const text = code(file);
				for (const m of text.matchAll(/\.(?:find|filter|some|findIndex)\(\s*\(?\s*\w+\s*\)?\s*=>[^\n]*?OBJECT_TYPES\.ROCKET[^\n]*/g)) {
					if (/OBJECT_STATE\.ACTIVE/.test(m[0])) { continue; }
					counts.set(file, (counts.get(file) || 0) + 1);
				}
			}
			assert.deepEqual([...counts], [...ALLOWED]);
			assert.match(code('gravsim_sound_effects.js'), /o\.type === OBJECT_TYPES\.ROCKET && o\.state === OBJECT_STATE\.ACTIVE && !o\.isDestroyed/);
			assert.match(code('gravsim_visual_effect_manager.js'), /rocket\.state === OBJECT_STATE\.ACTIVE && !rocket\.isDestroyed/);
		});
	});

	// Keep the RocketLauncher import used for the type of the saved launcher (hostAutoSelected defaults to false)
	it('RocketLauncher: a new launcher has no automatic host; getState / loadState carry hostAutoSelected as a boolean', () => {
		const rl = new RocketLauncher({ objects: [] }, { presetManager });
		assert.deepEqual([rl.hostId, rl.hostAutoSelected], [null, false]);
		rl.hostAutoSelected = 'yes';
		assert.equal(rl.getState().hostAutoSelected, false, 'only true is saved as true');
		rl.loadState({ hostId: 3, hostAutoSelected: true });
		assert.deepEqual([rl.hostId, rl.hostAutoSelected], [3, true]);
		rl.loadState({ mode: 'host' });
		assert.deepEqual([rl.hostId, rl.hostAutoSelected], [3, true], 'no hostId in the state: both unchanged');
	});
});
