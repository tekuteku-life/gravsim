/**
 * Regression Suite 16: a sweep of four classes of pre-existing defects (design §4.13-23 to -26). The previous rounds
 * (regressions 11 to 15) found these one at a time; this suite covers every occurrence of each class in scripts/ and
 * pins the class with a source scan (explicit allow-list for the harmless hits), so that it cannot come back silently.
 *
 *  A. Main-thread code reading a field that only the Worker objects set (§4.13-23). The main thread has its own
 *     objects (gravsim_object.js), synced from the frame buffer; a field only CalcRocket / CalcObject / FlightComputer
 *     assign is undefined there.
 *     A1. SoundEffects guarded the engine roar and the supersonic whine with !rocket.collided && !rocket.shattered (git
 *         0dbb27e): Worker names. A destroyed or removed rocket stays in universe.objects until its trail has faded
 *         (state REMOVED, isDestroyed), so its roar kept playing. It reads the main-thread state now.
 *     A2. The impact record ObjectManager passes to DestructionManager (the two-pass commit of this branch, §4.10)
 *         left out debrisMass (BUFFER_INDEX.DEBRIS_MASS): kg2ton(undefined) is NaN and no impact debris was ever
 *         made. A regression of this branch (main emitted the whole parsed record). The record carries it now.
 *     A3. RocketRenderer read rocket.isBoosterIgnited (CalcRocket only, git 760e804) and always fell back to
 *         !isHoldDown && isIgnited, the Worker's own rule; harmless, the dead read is replaced by the rule.
 *  B. Object id 0 taken as "none" (§4.13-24). Ids start at 0 (ObjectManager.getNextId; a load keeps the file's ids
 *     and an empty save restarts the counter at 0).
 *     B1. SoundEffects._getActiveRocket: LaunchSequencer.rocketId || camera target (git 0dbb27e).
 *     B2. VisualEffectManager.update: if (padEffect.targetRocketId) (git 2d957b5): the pad effect of a rocket with id
 *         0 never stopped above ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M.
 *     B3. The Worker: data.parentRocketId || null, deb.parentRocketId || null and the sibling test
 *         obj.parentRocketId && other.parentRocketId (git e4dd777): the stage and fairing halves of a rocket with id 0
 *         had no parent and hit it at the separation (the rocket absorbed them). Bit-identical for other ids.
 *     B4. RocketTab._getDefaultHostId returned 0 for "no celestial body", an id that may name another object.
 *     B5. Rocket.draw: !predictedTrajectory.hostId (git 43acd7c); harmless (the rocket's host is the same id).
 *  C. Raw mission-status comparisons outside TelemetryPanel (§4.13-25): TrajectoryPredictor.updateRocketFlightEvents
 *     (status >= MAX_Q / MECO on the raw value: "3", 6, 2.5, Infinity passed the events while the header read
 *     PRE-LAUNCH), the SoundSequencer status rules, ObjectManager's MECO detection. All use the shared
 *     normalizeMissionStatus (gravsim_utils.js; TelemetryPanel.normalizeMissionStatus is the same function). Worker
 *     statuses are written and carried as is.
 *  D. A distance shown without its reference body (§4.13-26): the Navigation & Camera card showed DIST REF while REF
 *     BODY read "---" (the dominant body's id names no body of the universe, e.g. one removed while paused); the Navi
 *     tab kept REF BODY, ALT and VEL of the last body (and named any object, a rocket too). Both resolve the body with
 *     NavigationCameraCard.resolveDominantBody and show none without it.
 *
 * Expected values: the Worker's own values and rules (CalcRocket: the SRBs ignite at the hold-down release;
 * PhysicsEngine: the dominant body is a celestial body; COLLISION_CONFIG.MAX_DEBRIS_RATIO for an impact of equal
 * masses far above the escape speed), DebrisGenerator's fragment count rule (DEBRIS.MIN_FRAG,
 * IMPACT_FRAG_MASS_LOG_MULT), ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M, TELEMETRY.STATUS and its order, the shipped
 * sound rules, and the same flight with a non-zero rocket id. Nothing is copied from the output of the code under test.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { CalcRocket, CalcDebris, CalcCelestialBody } from '../../scripts/gravsim_calc_object.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { GravSimObject, Rocket, CelestialBody } from '../../scripts/gravsim_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { SoundSequencer } from '../../scripts/gravsim_sound_sequencer.js';
import { SoundEffects } from '../../scripts/gravsim_sound_effects.js';
import { VisualEffectManager } from '../../scripts/gravsim_visual_effect_manager.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import * as utils from '../../scripts/gravsim_utils.js';
import * as presetModule from '../../scripts/gravsim_preset_manager.js';
import {
	OBJECT_TYPES, OBJECT_STATE, TELEMETRY, DEBRIS, COLLISION_CONFIG, ROCKET_LAUNCHER_CONFIG, LAUNCH_SEQUENCES
} from '../../scripts/gravsim_const.js';

const { presetManager } = presetModule;
const { UnitConvertUtils } = utils;
/** The shared status rule (read through the namespace: a missing export fails only the tests that use it). */
const normalizeMissionStatus = (v) => utils.normalizeMissionStatus(v);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js')).sort()
	.map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')]);
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
/** The body of a static method of WorkerBridge (formatWorkerToMain runs in the Worker). */
const methodRange = (text, name) => {
	const start = text.search(new RegExp(`\\bstatic\\s+${name}\\s*\\(`));
	let depth = 0;
	let i = text.indexOf('{', start);
	for (; i < text.length; i++) {
		if (text[i] === '{') { depth++; } else if (text[i] === '}' && --depth === 0) { break; }
	}
	return [start, i + 1];
};

const el = (id) => document.getElementById(id);
const resetTexts = () => {
	for (const id of ['tm-dominant-body', 'tm-dist-ref', 'nv-ref-body', 'nv-alt', 'nv-vel', 'tm-mission-status', 'm-hud-stat']) {
		el(id).textContent = '';
		delete el(id)._cachedText;
	}
};

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 15
// ------------------------------------------------------------------
let activeBridge = null;
class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		if (this.isPhysics) { PhysicsWorkerBridge.last = this; }
	}

	postMessage(msg) {
		if (!this.isPhysics || this.terminated) { return; }
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
const newUniverse = () => {
	resetTexts();
	// As at a page load: the ids start at 0 (the Sun of Universe.reset() gets id 0)
	GravSimObject._idCounter = 0;
	const universe = new Universe(createMockElement('canvas'));
	// The trajectory prediction is not under test here: skip it
	const launcher = universe.RocketLauncher;
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;
	launcher.requestPreviewUpdate = () => {};
	return { universe, bridge: PhysicsWorkerBridge.last };
};
const withEarth = (universe) => universe.ObjectPlacer.placeAtOrbitAroundSun('Earth') || universe.objects.find((o) => o.name === 'Earth');
const rocketOf = (universe) => universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
const tabButton = (target) => {
	const btn = createMockElement('button');
	btn.setAttribute('data-target', target);
	return btn;
};
const openTab = (universe, target) => universe.ControlPanel._tabBtnClick({ target: tabButton(target) });
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
};

/** Rollout through the real RocketLauncher, then the LEGACY_QUICK command order of LaunchSequencer.executeCommand. */
const rolloutAndLaunch = (universe, bridge, { vehicleId, payloadId, missionId }) => {
	const earth = withEarth(universe);
	const launcher = universe.RocketLauncher;
	launcher.hostId = earth.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	launcher.rollout();
	const rocket = rocketOf(universe);
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
	return rocket;
};

// ------------------------------------------------------------------
// Recording Web Audio (the gain targets each voice is driven to), as integration 12
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
/** Start the audio of a SoundEffects with the recording context. */
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
	seen.stop = () => EventBus.off(event, listener);
	return seen;
};

describe('Regression 16: pattern sweep of the pre-existing defect classes (design §4.13-23 to -26)', () => {
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
	// A. Fields only the Worker objects set (§4.13-23)
	// ==================================================================
	describe('A1. the engine roar and the supersonic whine stop when the rocket is destroyed (Web Audio mock)', () => {
		/** A Falcon 9 climbing with its first stage burning, the audio started. */
		const climbing = (until = (r) => r.telemetry.altM > 2000) => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			assert.ok(stepFrames(bridge, 400, () => until(rocket)), 'climbed');
			const se = withRecordingAudio(universe.SoundEffects);
			se.update(16, 0.016);
			return { universe, bridge, rocket, se };
		};

		it('normal (real path): "Clear Selected" with rockets removes the burning rocket; the roar stops while the rocket is still in universe.objects', async () => {
			const { universe, bridge, rocket, se } = climbing();
			assert.ok(rocket.isIgnited && rocket.thrustRatio > 0.01, 'input: the engine fires');
			assert.equal(audible(se.voices.engineRoar), true, 'the roar plays');
			// System tab "Clear Selected" with only the rocket box checked
			EventBus.emit('simulation:clear-objects', false, true, false);
			assert.deepEqual([rocket.state, rocket.isDestroyed], [OBJECT_STATE.REMOVED, true]);
			stepFrames(bridge, 1);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'the roar stops at the first update');
			// The removed rocket stays in universe.objects while its trail fades: the roar never restarts meanwhile
			assert.ok(universe.objects.includes(rocket), 'input: still in universe.objects');
			for (let i = 0; i < 5; i++) {
				stepFrames(bridge, 1);
				se.update(16, 0.016);
				assert.equal(audible(se.voices.engineRoar), false, `update ${i + 2} after the removal`);
			}
			await afterTeardown();
			assert.equal(se.voices.engineRoar.isRunning, false, 'the voice is torn down');
			se.update(16, 0.016);
			assert.equal(se.voices.engineRoar.isRunning, false, 'and not started again');
			assert.ok(universe.objects.includes(rocket), 'the destroyed rocket was still listed throughout');
		});

		it('normal (real path): a body hits the rocket at Mach > 1; the roar and the whine stop', async () => {
			const { universe, bridge, rocket, se } = climbing((r) => r.telemetry.mach > 1.3 && r.telemetry.qAxialKpa > 5 && r.inAtmosphere);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'the roar plays');
			assert.equal(audible(se.voices.supersonicWhine), true, 'the whine plays (supersonic, in the atmosphere)');
			// An asteroid 3 km ahead on the flight path, closing at 1 km/s
			const v = Math.hypot(rocket.vx, rocket.vy);
			const ux = rocket.vx / v;
			const uy = rocket.vy / v;
			const ast = universe.ObjectPlacer.placeObject('Asteroid', rocket.x + ux * UnitConvertUtils.m2pix(3000), rocket.y + uy * UnitConvertUtils.m2pix(3000),
				rocket.vx - ux * UnitConvertUtils.m2pix(1000), rocket.vy - uy * UnitConvertUtils.m2pix(1000));
			assert.ok(ast, 'input: the asteroid is placed');
			const impacted = record('object:impacted');
			assert.ok(stepFrames(bridge, 10, () => rocket.isDestroyed), 'the rocket is destroyed by the collision');
			impacted.stop();
			assert.equal(impacted.some(([t]) => t === rocket), true, 'by the Worker collision (impact)');
			assert.equal(rocket.state, OBJECT_STATE.REMOVED);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'roar');
			assert.equal(audible(se.voices.supersonicWhine), false, 'whine');
			await afterTeardown();
			se.update(16, 0.016);
			assert.deepEqual([se.voices.engineRoar.isRunning, se.voices.supersonicWhine.isRunning], [false, false]);
		});

		it('abnormal: the Worker names on a main object change nothing; a destroyed or removed state silences either way; no rocket', () => {
			const { universe, rocket, se } = climbing();
			// collided / shattered are not main-thread inputs: a flying rocket that carries them still plays
			rocket.collided = true;
			rocket.shattered = true;
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'the Worker-only names are ignored');
			delete rocket.collided;
			delete rocket.shattered;
			// Inconsistent states (not produced by the app): either mark silences
			rocket.isDestroyed = true;
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'isDestroyed with state ACTIVE');
			rocket.isDestroyed = false;
			rocket.state = OBJECT_STATE.REMOVED;
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'state REMOVED without isDestroyed');
			rocket.state = undefined;
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'no state');
			// No rocket at all
			const lone = withRecordingAudio(new SoundEffects({ objects: [], LaunchSequencer: null, camera: {} }));
			lone.update(16, 0.016);
			assert.deepEqual([lone.voices.engineRoar.isRunning, lone.voices.supersonicWhine.isRunning], [false, false]);
			assert.ok(universe);
		});

		it('boundary: audible on the last update before the destruction, silent on the first after; a new rocket plays again', async () => {
			const { universe, bridge, rocket, se } = climbing();
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'last update before');
			universe.ObjectManager.removeObject(rocket);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), false, 'first update after (no Worker frame in between)');
			await afterTeardown();
			// Clean the destroyed rocket up, then a second launch: its roar plays (the guard is per rocket)
			stepFrames(bridge, 1);
			for (let i = 0; i < 2000 && universe.objects.includes(rocket); i++) { universe.ObjectManager.cleanupObjects(); }
			assert.equal(universe.objects.includes(rocket), false, 'input: the destroyed rocket is gone');
			const launcher = universe.RocketLauncher;
			launcher.rolloutedRocketId = null;
			launcher.rollout();
			const second = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && o !== rocket);
			assert.ok(second && second.id !== rocket.id, 'input: a second rocket');
			const seq = universe.LaunchSequencer;
			seq.rocketId = second.id;
			seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
			stepFrames(bridge, 3);
			se.update(16, 0.016);
			assert.equal(audible(se.voices.engineRoar), true, 'the second rocket roars');
		});
	});

	describe('A2. an impact makes debris: the impact record carries the debris mass of the frame buffer', () => {
		/** Two asteroids of equal mass 2 km apart closing at 400 m/s (far above their escape speed), away from any planet. */
		const collidingAsteroids = () => {
			const { universe, bridge } = newUniverse();
			const sun = universe.objects.find((o) => o.name === 'Sun');
			const P = universe.ObjectPlacer;
			const px = UnitConvertUtils.m2pix;
			const x0 = sun.x + px(1.3e11);
			const a = P.placeObject('Asteroid', x0, sun.y, px(200), 0);
			const b = P.placeObject('Asteroid', x0 + px(2000), sun.y, px(-200), 0);
			return { universe, bridge, a, b };
		};
		/** DebrisGenerator.generateFromImpact: max(MIN_FRAG, floor(log10(debris mass [t]) x IMPACT_FRAG_MASS_LOG_MULT)). */
		const fragmentCount = (debrisMassT) => Math.max(DEBRIS.MIN_FRAG, Math.floor(Math.log10(debrisMassT) * DEBRIS.IMPACT_FRAG_MASS_LOG_MULT));

		it('normal (real path): the loser of a collision of two asteroids breaks into DebrisGenerator fragments of the Worker debris mass', () => {
			const { universe, bridge, a, b } = collidingAsteroids();
			const impacted = record('object:impacted');
			let workerLoser = null;
			const hit = stepFrames(bridge, 30, () => impacted.length > 0, (buf, objects) => {
				const l = objects.find((o) => o.isImpact);
				if (l && !workerLoser) { workerLoser = { id: l.id, debrisMass: l.debrisMass, mass: l.mass }; }
			});
			impacted.stop();
			assert.ok(hit && workerLoser, 'the asteroids collide (impact)');
			// Equal masses far above the escape speed: the debris ratio is clamped to MAX_DEBRIS_RATIO
			assert.ok(Math.abs(workerLoser.debrisMass / workerLoser.mass - COLLISION_CONFIG.MAX_DEBRIS_RATIO) < 1e-12, `input: debris ratio ${workerLoser.debrisMass / workerLoser.mass}`);
			const [[target, objData]] = impacted;
			assert.equal(target.id, workerLoser.id);
			assert.ok(Object.is(objData.debrisMass, workerLoser.debrisMass), `the record carries the Worker debris mass (${objData.debrisMass})`);
			const loser = target === a ? a : b;
			const fragments = universe.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS && o.name === `${loser.name} Debris`);
			const totalT = UnitConvertUtils.kg2ton(workerLoser.debrisMass);
			assert.equal(fragments.length, fragmentCount(totalT), `${fragments.length} fragments of ${totalT} t`);
			assert.ok(fragments.length >= DEBRIS.MIN_FRAG);
			for (const f of fragments) {
				assert.ok(f.mass >= (totalT / fragments.length) * DEBRIS.MASS_VAR_BASE * (1 - 1e-12)
					&& f.mass <= (totalT / fragments.length) * (DEBRIS.MASS_VAR_BASE + DEBRIS.MASS_VAR_RANGE) * (1 + 1e-12), `fragment mass ${f.mass}`);
				assert.equal(f.generation, 1);
			}
			// The fragments are real objects: the Worker has them too
			const workerIds = new Set(bridge.ctrl.engine.objects.map((o) => o.id));
			assert.deepEqual(fragments.filter((f) => !workerIds.has(f.id)), []);
		});

		/** One frame buffer of a Worker body that lost an impact with a given debris mass, applied by ObjectManager. */
		const applyImpact = (debrisMass) => {
			EventBus.clearAll();
			const om = new ObjectManager(null, { postMessage() {} });
			const body = new CelestialBody(4, 'Rock', 0, 0, 0, 0, 1e6, '#888888', 2, 50, 0);
			om.addObject(body, false);
			const w = new CalcCelestialBody(4, 'Rock', 0, 0, 0, 0, 0, 0, 50, 0, 1e9);
			w.collided = true;
			w.isImpact = true;
			w.debrisMass = debrisMass;
			w.impactWinnerX = 1000;
			w.impactWinnerY = 0;
			w.impactWinnerRadius = 40;
			const seen = record('object:impacted');
			const made = [];
			// DestructionManager's split, as Universe wires it (its fragments counted, not added to a Worker)
			EventBus.on('object:impacted', (target, objData) => {
				const totalT = UnitConvertUtils.kg2ton(objData.debrisMass);
				made.push(totalT > 0 ? fragmentCount(totalT) : 0);
			});
			const buf = WorkerBridge.formatWorkerToMain([w]);
			om.updateObjectParams({ objectsData: buf.buffer, validLength: buf.length });
			seen.stop();
			return { record: seen[0]?.[1], state: body.state, made };
		};

		it('abnormal: a record without debris mass (0, NaN, undefined, negative in the buffer) makes no fragment and throws nothing', () => {
			for (const m of [0, NaN, undefined, null, -5e9]) {
				const { record: rec, state } = applyImpact(m);
				assert.ok(rec, `impact reported (${m})`);
				const carried = (m === undefined || m === null || Number.isNaN(m)) ? 0 : m; // formatWorkerToMain writes obj.debrisMass || 0
				assert.ok(Object.is(rec.debrisMass, carried), `debrisMass ${m} carried as ${rec.debrisMass}`);
				assert.equal(state, OBJECT_STATE.REMOVED);
			}
			// The real DestructionManager on such a record: no fragment
			const { universe } = newUniverse();
			const before = universe.objects.length;
			const rock = universe.objects[0];
			for (const m of [0, -1, NaN]) {
				universe.DestructionManager._handleImpact(rock, { debrisMass: m, impactVx: 0, impactVy: 0, impactWinnerX: 1, impactWinnerY: 0, impactWinnerRadius: 1 });
			}
			assert.equal(universe.objects.length, before);
		});

		it('boundary: the smallest masses make MIN_FRAG fragments, a mass whose log is an integer the formula count; the value is carried bit for bit', () => {
			const cases = [[1e-300, DEBRIS.MIN_FRAG], [1, DEBRIS.MIN_FRAG], [1e3, DEBRIS.MIN_FRAG], [1e9, Math.floor(6 * DEBRIS.IMPACT_FRAG_MASS_LOG_MULT)], [9e9, fragmentCount(9e6)]];
			for (const [kg, n] of cases) {
				const { record: rec, made } = applyImpact(kg);
				assert.ok(Object.is(rec.debrisMass, kg), `${kg} kg carried exactly`);
				assert.deepEqual(made, [n], `${kg} kg -> ${n} fragments`);
			}
			// The real split of the smallest positive record
			const { universe } = newUniverse();
			const before = universe.objects.length;
			universe.DestructionManager._handleImpact(universe.objects[0], { debrisMass: 1e-300, impactVx: 0, impactVy: 0, impactWinnerX: 1, impactWinnerY: 0, impactWinnerRadius: 1 });
			assert.equal(universe.objects.length - before, DEBRIS.MIN_FRAG);
		});

		it('same pattern: the impact record has every field DestructionManager reads from it', () => {
			const reads = new Set([...code('gravsim_destruction_manager.js').matchAll(/\bobjData\.(\w+)/g)].map((m) => m[1]));
			assert.ok(reads.has('debrisMass') && reads.size >= 6, `input: ${[...reads]}`);
			const om = code('gravsim_object_manager.js');
			const rec = om.slice(om.indexOf('pendingDestructions.push('), om.indexOf('historyTargets.push(target)'));
			const keys = new Set([...rec.matchAll(/\b(\w+):\s*(?:Boolean\()?objData\.\w+/g)].map((m) => m[1]));
			assert.deepEqual([...reads].filter((k) => !keys.has(k)), [], 'fields DestructionManager reads that the record leaves out');
		});
	});

	describe('A3. the SRB plume follows the Worker rule (ignited at the hold-down release) without the Worker-only isBoosterIgnited', () => {
		/** SRB plumes RocketRenderer._drawBoosters draws for a rocket (calls of _drawPlume). */
		const srbPlumes = (rocket) => {
			const orig = RocketRenderer._drawPlume;
			let n = 0;
			RocketRenderer._drawPlume = () => { n++; };
			const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k.startsWith('create') ? () => ({ addColorStop() {} }) : () => {})), set: (t, k, v) => { t[k] = v; return true; } });
			try {
				RocketRenderer._drawBoosters(ctx, rocket, 0, 10, 40, -20, 5, presetManager.getRocketVisual().THEMES.classic, true, 1.0, 10, 1.0);
			} finally {
				RocketRenderer._drawPlume = orig;
			}
			return n;
		};
		const h3 = () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			return { universe, bridge, rocket };
		};

		it('normal (real path): over an H3-22 flight from the hold-down to the SRB burnout, the drawn rule equals the Worker flag every frame', () => {
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			const launcher = universe.RocketLauncher;
			launcher.hostId = earth.id;
			presetManager.applyToLauncher(launcher, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			launcher.rollout();
			const rocket = rocketOf(universe);
			const bridge = PhysicsWorkerBridge.last;
			const seq = universe.LaunchSequencer;
			seq.rocketId = rocket.id;
			const compared = { held: 0, burning: 0, burnout: 0 };
			const check = (buf, objects) => {
				const w = objects.find((o) => o.id === rocket.id);
				if (!w || w.isBoosterSeparated) { return; }
				compared[w.isBoosterBurnout ? 'burnout' : (w.isHoldDown ? 'held' : 'burning')]++;
				rocket._workerSrb = Boolean(w.isBoosterIgnited && !w.isBoosterBurnout && w.currentStageIndex === 0);
			};
			const drawnRule = () => Boolean(!rocket.isHoldDown && rocket.isIgnited && !rocket.isBoosterBurnout && rocket.currentStageIndex === 0);
			const run = (frames) => stepFrames(bridge, frames, () => {
				assert.equal(drawnRule(), rocket._workerSrb, `frame at T+${rocket.telemetry.flightTime}`);
				return rocket.isBoosterSeparated;
			}, check);
			seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
			run(3);
			seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
			run(200);
			assert.ok(compared.held >= 3 && compared.burning > 50 && compared.burnout > 0, `frames compared ${JSON.stringify(compared)}`);
			// And the drawing after the burnout: no SRB plume
			delete rocket._workerSrb;
			assert.equal(rocket.isBoosterBurnout, true, 'input: after the SRB burnout');
			assert.equal(srbPlumes(rocket), 0, 'no SRB plume after the burnout');
		});

		it('abnormal: the Worker-only isBoosterIgnited on a main object changes no plume (held: none, released: one per SRB)', () => {
			const { rocket } = h3();
			const srbCount = rocket.boosters.count;
			assert.equal(srbCount, 2, 'input: the H3-22 has two SRBs');
			assert.equal(srbPlumes(rocket), srbCount, 'released and firing');
			rocket.isBoosterIgnited = false;
			assert.equal(srbPlumes(rocket), srbCount, 'a stray false changes nothing');
			rocket.isHoldDown = true;
			rocket.isBoosterIgnited = true;
			assert.equal(srbPlumes(rocket), 0, 'a stray true does not light the SRBs on the pad');
		});

		it('boundary: ignited and held (core engine on the pad) no SRB plume; released but not ignited none; released and ignited all', () => {
			const { rocket } = h3();
			for (const [isHoldDown, isIgnited, n] of [[true, true, 0], [false, false, 0], [true, false, 0], [false, true, rocket.boosters.count]]) {
				rocket.isHoldDown = isHoldDown;
				rocket.isIgnited = isIgnited;
				assert.equal(srbPlumes(rocket), n, `held ${isHoldDown}, ignited ${isIgnited}`);
			}
		});
	});

	describe('A (scan). main-thread code reads no field that only the Worker objects assign', () => {
		/** Fields assigned with `<receiver>.name =` (also += etc.) in a source. */
		const assigned = (src, receivers) => new Set([...stripComments(src).matchAll(new RegExp(`\\b(?:${receivers})\\.([A-Za-z_$][\\w$]*)\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|\\|\\|=|\\?\\?=|&&=|\\+\\+|--)`, 'g'))].map((m) => m[1]));
		const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
		const objectSource = stripComments(source('gravsim_object.js'));
		// Main-thread objects: their classes (fields, getters, methods), the Worker sync, the placer and the launcher
		const MAIN = union(
			assigned(source('gravsim_object.js'), 'this'),
			new Set([...objectSource.matchAll(/^\s*(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
			new Set([...objectSource.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)].map((m) => m[1])),
			assigned(source('gravsim_object_manager.js'), 'target|obj|base|deb|rocket|o'),
			assigned(source('gravsim_object_placer.js'), 'obj|rocket|o'),
			assigned(source('gravsim_rocket_launcher.js'), 'rocket|obj')
		);
		// Worker objects: CalcObject and its subclasses, the FlightComputer, and what the engine writes on them
		const WORKER = union(
			assigned(source('gravsim_calc_object.js'), 'this'),
			assigned(source('gravsim_flight_computer.js'), 'this'),
			assigned(source('gravsim_calc.js'), 'obj|objA|objB|rocket|loser|winner|newObj|o|target')
		);
		const WORKER_ONLY = new Set([...WORKER].filter((f) => !MAIN.has(f)));
		/**
		 * Reads of a Worker-only field in main-thread code that are not on a main-thread object (receiver.field per file).
		 * The parsed frame-buffer record (objData) carries the impact fields; preset definitions name their Isp ispVac /
		 * ispSl (the Worker copies them); the rest are own fields of non-object classes.
		 */
		const ALLOWED = new Set([
			// The impact record of the frame buffer (BUFFER_INDEX.DEBRIS_MASS, IMPACT_*, OBJECT_FLAG.IMPACT)
			...['debrisMass', 'impactVx', 'impactVy', 'impactWinnerX', 'impactWinnerY', 'impactWinnerRadius'].map((f) => `gravsim_destruction_manager.js|objData.${f}`),
			...['debrisMass', 'isImpact', 'impactVx', 'impactVy', 'impactWinnerX', 'impactWinnerY', 'impactWinnerRadius'].map((f) => `gravsim_object_manager.js|objData.${f}`),
			// Preset definitions (stages, payload propulsion, fuels, celestial parameters)
			'gravsim_preset_manager.js|d.rotationPeriod',
			...['prop', 'fuelDef', 'stg', 'last', 'lastFuelDef', 's', 'f', 'stages[0]', 'stg0FuelDef'].map((r) => `gravsim_preset_manager.js|${r}.ispVac`),
			...['stg', 'fuelDef', 'prop', 'fuel'].map((r) => `gravsim_tab_rocket.js|${r}.ispVac`),
			'gravsim_utils.js|stg.ispVac', 'gravsim_utils.js|stg.ispSl', 'gravsim_utils.js|config.ispVac', 'gravsim_utils.js|config.ispSl',
			// Own fields of classes that are not simulation objects
			'gravsim_rocket_launcher.js|ctx.config', 'gravsim_sound_effects.js|this.config', 'gravsim_telemetry_card.js|this.ui.dominantBody',
			'gravsim_trajectory_predictor.js|{config}', // the queued prediction request { config, callback }
			// The saved Worker runtime state of a loaded rocket (a record of the save file, design §4.7): its FlightComputer
			// part gives the main thread's flight clock the restored flight time (design §4.14-6)
			'gravsim_object_manager.js|obj.runtimeState.flightComputer'
		]);
		/** Every read `<receiver>.<field>` of a Worker-only field in the main-thread code (writes excluded). */
		const reads = () => {
			const hits = [];
			for (const file of MAIN_FILES) {
				let text = stripComments(source(file));
				if (file === 'gravsim_worker_bridge.js') {
					// formatWorkerToMain runs in the Worker (it reads the Worker objects)
					const [a, b] = methodRange(text, 'formatWorkerToMain');
					text = text.slice(0, a) + text.slice(a, b).replace(/[^\n]/g, ' ') + text.slice(b);
				}
				text = stripStrings(text);
				// Every member of every chain a.b?.c[i].d: each segment after the first is a read of that field of the
				// chain before it, except the last one when the chain is assigned to
				for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*|[)\]])((?:\[[^\]\n]*\])*(?:\??\.[A-Za-z_$][\w$]*(?:\[[^\]\n]*\])*)+)/g)) {
					const segments = [...m[2].matchAll(/(\??\.)([A-Za-z_$][\w$]*)((?:\[[^\]\n]*\])*)/g)];
					let receiver = m[1] + m[2].slice(0, segments[0].index);
					segments.forEach((seg, i) => {
						const isLast = i === segments.length - 1;
						const isWrite = isLast && /^\s*=(?!=)/.test(text.slice(m.index + m[0].length));
						if (WORKER_ONLY.has(seg[2]) && !isWrite) {
							hits.push({ key: `${file}|${receiver.replace(/\?$/, '')}.${seg[2]}`, line: lineOf(text, m.index) });
						}
						receiver += seg[0];
					});
				}
				// Destructuring of a Worker-only field
				for (const m of text.matchAll(/\{([^{}]*)\}\s*=[^=>]/g)) {
					for (const name of m[1].split(',').map((s) => s.trim().split(/[\s:=]/)[0])) {
						if (WORKER_ONLY.has(name)) { hits.push({ key: `${file}|{${name}}`, line: lineOf(text, m.index) }); }
					}
				}
			}
			return hits;
		};

		it('input: the mechanical lists hold the known Worker-only fields (collided, shattered, isBoosterIgnited, dominantBody) and the main equivalents', () => {
			for (const f of ['collided', 'shattered', 'isBoosterIgnited', 'dominantBody', 'flightComputer', 'presState', 'debrisMass', 'isImpact', 'parentRocketId']) {
				assert.ok(WORKER_ONLY.has(f), `${f} is Worker-only`);
			}
			for (const f of ['state', 'isDestroyed', 'isHoldDown', 'isIgnited', 'dominantBodyId', 'distToDominantM', 'telemetry', 'isBoosterBurnout', 'mass']) {
				assert.ok(MAIN.has(f), `${f} is a main-thread field`);
			}
			// Design §4.13-23 lists 75 Worker-only fields: an extraction that lost one (a regressed pattern or receiver list)
			// would let reads of it pass the scan below. A new Worker-only field changes the count: review its main-thread
			// reads and the design's count together
			assert.equal(WORKER_ONLY.size, 75, `design §4.13-23: 75 Worker-only fields (got ${WORKER_ONLY.size}: ${[...WORKER_ONLY].sort().join(', ')})`);
		});

		it('every read of a Worker-only field in main-thread code is an allowed non-object read (and every allowed entry still exists)', () => {
			const hits = reads();
			const offending = hits.filter((h) => !ALLOWED.has(h.key)).map((h) => `${h.key} (line ${h.line})`);
			assert.deepEqual(offending, [], 'reads of Worker-only fields on main-thread objects');
			const found = new Set(hits.map((h) => h.key));
			assert.deepEqual([...ALLOWED].filter((k) => !found.has(k)), [], 'allow-list entries without a read (remove them)');
		});

		it('the known sites read the main-thread equivalents (SoundEffects: state / isDestroyed; RocketRenderer: isHoldDown / isIgnited)', () => {
			const se = code('gravsim_sound_effects.js');
			assert.match(se, /rocket\.state === OBJECT_STATE\.ACTIVE && !rocket\.isDestroyed/);
			assert.doesNotMatch(se, /\.(collided|shattered)\b/);
			assert.doesNotMatch(code('gravsim_rocket_renderer.js'), /\.isBoosterIgnited\b/);
			assert.match(code('gravsim_rocket_renderer.js'), /const isBoosterIgnited = !rocket\.isHoldDown && rocket\.isIgnited;/);
		});
	});

	// ==================================================================
	// B. Object id 0 (§4.13-24)
	// ==================================================================
	/** A main-thread Falcon 9 object with a given id (a placeholder telemetry of the main thread). */
	const mainRocket = (id, overrides = {}) => Object.assign(new Rocket(id, `R${id}`, 0, 0, 0, 0, 20, 100, 200, '#ffffff', 5, 10, 0), overrides);

	describe('B1. SoundEffects follows the sequencer rocket with id 0', () => {
		const firing = (id) => mainRocket(id, { isIgnited: true, thrustRatio: 1, inAtmosphere: true, telemetry: { altM: 1000, mach: 0.5, qAxialKpa: 10, vV: 100, vH: 0 } });
		const coasting = (id) => mainRocket(id, { isIgnited: false, thrustRatio: 0, inAtmosphere: false, telemetry: { altM: 300000, mach: 0, qAxialKpa: 0 } });
		const roarFor = (universe) => {
			const se = withRecordingAudio(new SoundEffects(universe));
			se.update(16, 0.016);
			return audible(se.voices.engineRoar);
		};

		it('normal: the sequencer rocket id 0 (firing) is the active rocket, not the camera target (coasting); its roar plays', () => {
			const r0 = firing(0);
			const r5 = coasting(5);
			const universe = { objects: [r5, r0], LaunchSequencer: { rocketId: 0 }, camera: { trackingTarget: r5 } };
			assert.equal(new SoundEffects(universe)._getActiveRocket(), r0);
			assert.equal(roarFor(universe), true);
			// The same with ids 7 / 5: unchanged
			const r7 = firing(7);
			assert.equal(new SoundEffects({ objects: [r5, r7], LaunchSequencer: { rocketId: 7 }, camera: { trackingTarget: r5 } })._getActiveRocket(), r7);
		});

		it('abnormal: no sequencer rocket (null / undefined / no sequencer) -> the camera target; an id naming no rocket -> the camera target, then the first rocket', () => {
			const r0 = firing(0);
			const r5 = coasting(5);
			for (const LaunchSequencer of [{ rocketId: null }, { rocketId: undefined }, {}, null, undefined]) {
				assert.equal(new SoundEffects({ objects: [r0, r5], LaunchSequencer, camera: { trackingTarget: r5 } })._getActiveRocket(), r5, `${JSON.stringify(LaunchSequencer)}`);
			}
			const earth = new CelestialBody(3, 'Earth', 0, 0, 0, 0, 1, '#00f', 1, 1, 0);
			assert.equal(new SoundEffects({ objects: [earth, r5, r0], LaunchSequencer: { rocketId: 99 }, camera: { trackingTarget: earth } })._getActiveRocket(), r5, 'unknown id, camera on a body: the first rocket');
			assert.equal(new SoundEffects({ objects: [earth, r5], LaunchSequencer: { rocketId: 3 }, camera: { trackingTarget: null } })._getActiveRocket(), r5, 'the id of a body: the first rocket');
			assert.equal(new SoundEffects({ objects: [earth], LaunchSequencer: { rocketId: 0 }, camera: {} })._getActiveRocket(), null, 'no rocket');
		});

		it('boundary: rocket ids 0, -0 and 1 select their rocket; camera target id 0 selects it when no sequencer rocket', () => {
			const r0 = firing(0);
			const r1 = coasting(1);
			const r2 = coasting(2);
			const objects = [r2, r1, r0];
			assert.equal(new SoundEffects({ objects, LaunchSequencer: { rocketId: 0 }, camera: { trackingTarget: r2 } })._getActiveRocket(), r0);
			assert.equal(new SoundEffects({ objects, LaunchSequencer: { rocketId: -0 }, camera: { trackingTarget: r2 } })._getActiveRocket(), r0);
			assert.equal(new SoundEffects({ objects, LaunchSequencer: { rocketId: 1 }, camera: { trackingTarget: r2 } })._getActiveRocket(), r1);
			assert.equal(new SoundEffects({ objects, LaunchSequencer: { rocketId: null }, camera: { trackingTarget: r0 } })._getActiveRocket(), r0);
		});
	});

	describe('B2. the pad effect of a rocket with id 0 stops above EFFECT_STOP_ALT_M (and when the rocket is gone)', () => {
		const STOP = ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M;
		/** VisualEffectManager of a universe holding the rocket and its host; the pad effect started for them. */
		const padFor = (rocketId, altM, { listed = true } = {}) => {
			EventBus.clearAll();
			const host = new CelestialBody(rocketId === 0 ? 9 : 0, 'Earth', 0, 0, 0, 0, 5.97e21, '#00f', 3, 6.371e6, 0);
			const rocket = mainRocket(rocketId, { telemetry: { altM } });
			const universe = { objects: listed ? [host, rocket] : [host], camera: { getRenderState: () => ({ zoomScale: 1 }) } };
			const vfx = new VisualEffectManager(universe);
			vfx.padEffect.start(rocketId, host.id);
			vfx.update(0.016);
			return vfx.padEffect.isActive;
		};

		it('normal: rocket id 0 below the stop altitude keeps the pad effect, above it stops it (as any other id)', () => {
			assert.equal(STOP, 3000, 'input: ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M');
			assert.equal(padFor(0, 100), true);
			assert.equal(padFor(0, 5000), false, 'rocket 0 above 3 km');
			assert.equal(padFor(7, 5000), false, 'rocket 7 above 3 km');
		});

		it('abnormal: rocket id 0 no longer listed stops it; a non-numeric altitude keeps it; no target rocket keeps it', () => {
			assert.equal(padFor(0, 100, { listed: false }), false, 'rocket 0 gone');
			assert.equal(padFor(0, NaN), true);
			assert.equal(padFor(0, undefined), true);
			for (const id of [null, undefined]) {
				EventBus.clearAll();
				const vfx = new VisualEffectManager({ objects: [mainRocket(0, { telemetry: { altM: 9000 } })], camera: { getRenderState: () => ({ zoomScale: 1 }) } });
				vfx.padEffect.start(id, null);
				vfx.update(0.016);
				assert.equal(vfx.padEffect.isActive, true, `target ${id}: nothing to follow`);
			}
		});

		it('boundary: exactly the stop altitude keeps it, just above stops it (ids 0 and 7 alike)', () => {
			for (const id of [0, 7]) {
				assert.equal(padFor(id, STOP), true, `${id} at ${STOP} m`);
				assert.equal(padFor(id, STOP + 1e-6), false, `${id} just above`);
			}
		});
	});

	describe('B3. the Worker keeps the parent rocket id 0: a rocket with id 0 never hits its own stage or fairing', () => {
		/**
		 * A Falcon 9 flight saved 20 s after liftoff, its file rewritten so the rocket has `newId` (swapped with the
		 * object that had it: a file the app writes after loading an empty save, whose id counter restarts at 0), loaded,
		 * and flown through the stage 1 separation, the fairing jettison and the payload separation.
		 */
		const flyWithRocketId = async (newId) => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			stepFrames(bridge, 20);
			const json = await saveToJson(universe);
			const objs = json.universe.objectManager;
			const r = objs.find((o) => o.id === rocket.id);
			const other = objs.find((o) => o.id === newId);
			const oldId = r.id;
			if (other) { other.id = oldId; }
			r.id = newId;
			const swap = (v) => (v === newId ? oldId : (v === oldId ? newId : v));
			for (const o of objs) { if (o !== r && o.hostId !== undefined && o.hostId !== null) { o.hostId = swap(o.hostId); } }
			if (r.hostId !== null && r.hostId !== undefined && r.hostId === newId) { r.hostId = oldId; }
			json.universe.centerObjectId = swap(json.universe.centerObjectId);
			json.universe.rocketLauncher.hostId = swap(json.universe.rocketLauncher.hostId);
			loadJson(universe, json);
			const loaded = rocketOf(universe);
			const collided = [];
			stepFrames(bridge, 700, () => loaded.isPayloadSeparated && loaded.fairing?.isSeparated && loaded.telemetry.flightTime > 600, (buf, objects) => {
				for (const o of objects) { if (o.collided) { collided.push(`${o.id} ${o.name}`); } }
			});
			const workerDebris = bridge.ctrl.engine.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS);
			return {
				universe, loaded, collided, workerDebris,
				mainDebris: universe.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS && o.state === OBJECT_STATE.ACTIVE),
				final: { x: loaded.x, y: loaded.y, vx: loaded.vx, vy: loaded.vy, dryMass: loaded.dryMass, fuelMass: loaded.fuelMass, stage: loaded.currentStageIndex }
			};
		};
		let zero = null;
		let fifty = null;

		it('normal (real path): the loaded rocket id 0 jettisons stage 1, both fairing halves and stage 2 as debris of parent 0; nothing collides', async () => {
			zero = await flyWithRocketId(0);
			assert.equal(zero.loaded.id, 0, 'input: the rocket has id 0');
			assert.deepEqual([zero.loaded.isPayloadSeparated, zero.loaded.fairing.isSeparated, zero.loaded.state], [true, true, OBJECT_STATE.ACTIVE]);
			assert.deepEqual(zero.collided, [], 'no Worker collision');
			assert.deepEqual(zero.workerDebris.map((d) => d.debrisSubType).sort(), [1, 2, 3, 3], 'stage 1, stage 2 and two fairing halves');
			assert.deepEqual(zero.workerDebris.map((d) => d.parentRocketId), [0, 0, 0, 0], 'their parent is rocket 0');
			assert.deepEqual(zero.mainDebris.map((d) => d.debrisSubType).sort(), [1, 2, 3, 3], 'and the main thread shows them');
		});

		it('normal: the flight is the same as with the rocket id 50 (bit for bit): the id changes no physics', async () => {
			fifty = await flyWithRocketId(50);
			zero = zero ?? await flyWithRocketId(0);
			assert.equal(fifty.loaded.id, 50);
			assert.deepEqual(fifty.workerDebris.map((d) => d.parentRocketId), [50, 50, 50, 50]);
			for (const [k, v] of Object.entries(fifty.final)) {
				assert.ok(Object.is(zero.final[k], v), `${k}: ${zero.final[k]} (id 0) vs ${v} (id 50)`);
			}
		});

		/** A Worker engine with two overlapping objects; whether the pair collides in one frame. */
		const collides = (a, b) => {
			const ctrl = new SimulationController();
			const e = ctrl.engine;
			e.objects.push(a, b);
			e._categorizeBodies();
			e._buildQuadTree(FRAME_S);
			e._checkCollisions(FRAME_S);
			return Boolean(a.collided || b.collided);
		};
		const deb = (id, parent, x = 0) => new CalcDebris(id, `D${id}`, x, 0, 0, 0, 0, 0, 5, 1, 2, 3, parent);
		const calcRocket = (id) => new CalcRocket(id, 'R', 3, 0, 0, 0, 0, 0, 5, 0, 20, 0, 0, { stages: [] });

		it('abnormal: debris without a parent (null / undefined) collides with rocket 0 and with each other, as before', () => {
			assert.equal(collides(calcRocket(0), deb(-11, null)), true, 'rocket 0 and an unrelated piece');
			assert.equal(collides(deb(-12, null), deb(-13, null)), true, 'two pieces without a parent');
			assert.equal(collides(deb(-14, undefined), deb(-15, undefined)), true);
			assert.equal(collides(deb(-16, null), deb(-17, 0)), true, 'no parent vs parent 0');
			// The 'add' message keeps a parent id 0 (main sends none for its own debris: null)
			const ctrl = new SimulationController();
			for (const [parentRocketId, want] of [[0, 0], [null, null], [undefined, null], [4, 4]]) {
				ctrl.handleMessage({ data: { cmd: 'add', id: -20, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 0, y: 0, vx: 0, vy: 0, radius: 2, mass: 1, debrisSubType: 1, parentRocketId } });
				const added = ctrl.engine.objects.find((o) => o.id === -20);
				assert.equal(added.parentRocketId, want, `parentRocketId ${parentRocketId}`);
				ctrl.handleMessage({ data: { cmd: 'remove', id: -20 } });
				ctrl.engine.removeDeadObjects();
			}
		});

		it('boundary: parent 0 and its rocket 0, and two pieces of parent 0, are exempt; parent 1 and rocket 1 as before', () => {
			assert.equal(collides(calcRocket(0), deb(-21, 0)), false, 'rocket 0 and its piece');
			assert.equal(collides(deb(-22, 0), deb(-23, 0)), false, 'two pieces of rocket 0');
			assert.equal(collides(deb(-24, 0), deb(-25, -0)), false, '0 and -0 are the same rocket');
			assert.equal(collides(calcRocket(1), deb(-26, 1)), false, 'rocket 1 and its piece');
			assert.equal(collides(deb(-27, 1), deb(-28, 1)), false);
			assert.equal(collides(calcRocket(1), deb(-29, 0)), true, 'a piece of rocket 0 hits rocket 1');
		});
	});

	describe('B4/B5. no host is null, not the id 0; a prediction host id 0 is kept', () => {
		it('normal: the default host is Earth, else a body; the startup Sun (id 0) is a body', () => {
			const { universe } = newUniverse();
			const tab = universe.ControlPanel.rocketTab;
			const sun = universe.objects.find((o) => o.name === 'Sun');
			assert.equal(tab._getDefaultHostId(), sun.id, 'only the Sun');
			const earth = withEarth(universe);
			assert.equal(tab._getDefaultHostId(), earth.id);
		});

		it('abnormal (real path): with no celestial body (a loaded save of a free-flying rocket with id 0) there is no host; the Rocket tab does not take the rocket', () => {
			const { universe } = newUniverse();
			const r = mainRocket(0);
			universe.ObjectManager.loadState([]);
			universe.ObjectManager.addObject(r, false);
			const tab = universe.ControlPanel.rocketTab;
			assert.equal(tab._getDefaultHostId(), null, 'no host');
			const tracked = record('camera:set-tracking-target');
			const fitted = record('camera:fit-to-target');
			universe.RocketLauncher.hostId = null;
			openTab(universe, 'tab-rocket');
			tracked.stop();
			fitted.stop();
			assert.equal(universe.RocketLauncher.hostId, null, 'the launcher keeps no host');
			assert.deepEqual([tracked.includes(r), fitted.includes(r)], [false, false], 'the rocket 0 is not set up as the launch host');
		});

		it('boundary (B5): a predicted trajectory with host id 0 keeps it; one without a host id takes the rocket host', () => {
			const ctx = { save() {}, restore() {} };
			const rc = { basis: { x: 0, y: 0 }, ctx, zoomScale: 1, objectsMap: new Map(), objects: [] };
			const draw = (predHostId, rocketHostId) => {
				const r = mainRocket(3, { hostId: rocketHostId, isHoldDown: false });
				r.predictedTrajectory = { hostId: predHostId, points: [], events: [] };
				r._drawBody = () => {};
				r.draw(rc);
				return r.predictedTrajectory.hostId;
			};
			assert.equal(draw(0, 0), 0);
			assert.equal(draw(0, 5), 0, 'id 0 is a host id');
			assert.equal(draw(undefined, 5), 5);
			assert.equal(draw(null, 0), 0);
			assert.equal(draw(4, 5), 4);
		});
	});

	describe('B (scan). no truthiness test on an object id in scripts/', () => {
		/** Names that hold an object id (the rest of the *Id names hold preset, event, request or DOM ids). */
		const NON_OBJECT_IDS = new Set(['eventId', 'requestId', '_requestId', 'payloadId', 'vehicleId', 'missionId', 'presetId', 'btnId', 'valId', 'sliderId',
			'profileId', 'ruleId', 'recommendedMissionId', 'preferredId', 'impactId', '_latestProcessedId', '_nextRuntimeRequestId', 'currentVehicleId',
			'currentPayloadId', 'currentMissionId', 'currentPresetId', 'effectiveVehicleId', 'effectivePayloadId', 'effectiveMissionId', 'pId', 'vId', 'getElementById']);
		const OPERAND = String.raw`(?<![\w$.])((?:[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.)?(?:id|[A-Za-z_$][\w$]*Id))\b(?!\s*\()(?!\s*\??\.)`;
		const CMP = String.raw`(?<!(?:===|!==|==|!=|<=|>=|<|>|\?\?)\s*)`;
		const PATTERNS = [
			new RegExp(`${CMP}${OPERAND}\\s*(\\|\\||&&|\\?(?![.?]))`, 'g'), // id || / id && / id ? a : b
			new RegExp(`(!+)\\s*${OPERAND}(?!\\s*(?:===|!==|==|!=))`, 'g'), // !id
			new RegExp(`\\b(?:if|while)\\s*\\(\\s*${OPERAND}\\s*\\)`, 'g'), // if (id)
			new RegExp(`(?:&&|\\|\\|)\\s*${OPERAND}\\s*(?=\\)\\s*(?:\\{|return|continue|break)|\\?(?![.?])|&&|\\|\\|)`, 'g'), // ... && id) {
			new RegExp(`\\bBoolean\\(\\s*${OPERAND}\\s*\\)`, 'g')
		];
		/** Harmless hits: ids of presets, events and themes (strings), and a select value (a string, "0" is true). */
		const ALLOWED = new Set([
			'gravsim_preset_manager.js|v.id', 'gravsim_preset_manager.js|id',
			'gravsim_rocket_launcher.js|defaultVehicle?.id', 'gravsim_rocket_launcher.js|defaultPayload?.id', 'gravsim_rocket_launcher.js|defaultMission?.id',
			'gravsim_trajectory_predictor.js|ev.id',
			'gravsim_tab_system.js|targetId'
		]);
		const truthinessHits = () => {
			const hits = [];
			for (const [file] of SCRIPTS) {
				const text = code(file);
				for (const re of PATTERNS) {
					for (const m of text.matchAll(re)) {
						const operand = m.slice(1).find((g) => g && /(?:^|[.?])(?:id|[A-Za-z_$][\w$]*Id)$/.test(g));
						const name = operand.split(/\??\./).pop();
						if (NON_OBJECT_IDS.has(name)) { continue; }
						hits.push({ key: `${file}|${operand}`, line: lineOf(text, m.index), text: m[0].trim() });
					}
				}
			}
			return hits;
		};

		it('input: the scan finds the patterns the sweep fixed when they are put back', () => {
			const scan = (snippet) => PATTERNS.some((re) => [...snippet.matchAll(re)].length > 0);
			for (const s of ['const t = seq.rocketId || cam.id;', 'if (this.padEffect.targetRocketId) {', 'x = data.parentRocketId || null;',
				'if (!this.predictedTrajectory.hostId && y) {', '(a.parentRocketId && b.parentRocketId && a.parentRocketId === b.parentRocketId)', 'z = obj.id ? 1 : 2;',
				'const ok = Boolean(hostId);']) {
				assert.equal(scan(s), true, s);
			}
			for (const s of ['if (a.id === b.id || c) {', 'x = data.parentRocketId ?? null;', 'if (id !== null && id !== undefined) {', 'o.id === hostId && o.ok',
				'const ok = (id === 0);', 'f(getNextId())', 'ev.id.startsWith("x")']) {
				assert.equal(scan(s), false, s);
			}
		});

		it('no script tests an object id for truthiness (allow-list: preset / event ids and a select value)', () => {
			const hits = truthinessHits();
			assert.deepEqual(hits.filter((h) => !ALLOWED.has(h.key)).map((h) => `${h.key} line ${h.line}: ${h.text}`), []);
			const found = new Set(hits.map((h) => h.key));
			assert.deepEqual([...ALLOWED].filter((k) => !found.has(k)), [], 'allow-list entries without a hit');
		});

		it('the comparisons of an object id with the literal 0 are only the migration of saves without the world center (the "Sun is id 0" sites are fixed, §4.13-27)', () => {
			const hits = [];
			for (const [file] of SCRIPTS) {
				const text = code(file);
				for (const m of text.matchAll(/(?<![\w$])((?:[\w$]+\??\.)*(?:id|[A-Za-z_$][\w$]*Id))\s*(?:===|!==|==|!=)\s*0(?![\w.])/g)) {
					hits.push(`${file}|${m[1]}`);
				}
			}
			// The six "the Sun is id 0" sites reported here before (tab_rocket currentHostId / hostId / o.id / targetHostId,
			// universe o.id / obj.id) use the world center and the automatic host now; regression 17 scans every literal
			assert.deepEqual(hits.sort(), ['gravsim_object_manager.js|c.id']);
		});
	});

	// ==================================================================
	// C. Mission status (§4.13-25)
	// ==================================================================
	const BAD = [undefined, null, NaN, Infinity, -Infinity, 6, -2, 99, 0.5, 2.5, 3.5, 5 + 1e-9, '', 'x', 'MAX-Q', '-1', '0', '2', '3', '5', true, false, {}, [], [3]];
	const CODES = Object.values(TELEMETRY.STATUS);

	describe('C1. the flight events of the prediction read the status as the telemetry panel does', () => {
		/** A flying rocket whose events only the status can pass (low, early, propellant left, first stage). */
		const passedBy = (status, totalStages = 2) => {
			const rocket = mainRocket(3, { isHoldDown: false, totalStages, currentStageIndex: 0, burnTime: 100, fuelMass: 50 });
			rocket.telemetry = { status, altM: 10, vV: 50, flightTime: 0.5 };
			rocket.predictedTrajectory = {
				hostId: null,
				events: [{ id: 'maxq', type: 'maxq', altM: 1e9 }, { id: 'meco_1', type: 'meco', name: 'MECO' }]
			};
			TrajectoryPredictor.updateRocketFlightEvents(rocket, null);
			return [...rocket.passedEventIds].sort();
		};
		/** The expectation: an event the status passes once the (normalised) status reached it, in the order of TELEMETRY.STATUS. */
		const expected = (status) => {
			const s = TelemetryPanel.normalizeMissionStatus(status);
			return [...(s >= TELEMETRY.STATUS.MAX_Q ? ['maxq'] : []), ...(s >= TELEMETRY.STATUS.MECO ? ['meco_1'] : [])].sort();
		};

		it('normal: every status code passes MAX-Q from MAX_Q on and MECO from MECO on (single and multi stage)', () => {
			assert.deepEqual(passedBy(TELEMETRY.STATUS.ASCENT), []);
			assert.deepEqual(passedBy(TELEMETRY.STATUS.MAX_Q), ['maxq']);
			assert.deepEqual(passedBy(TELEMETRY.STATUS.MECO), ['maxq', 'meco_1']);
			for (const code of CODES) {
				assert.deepEqual(passedBy(code), expected(code), `status ${code}`);
				assert.deepEqual(passedBy(code, 1), expected(code), `single stage, status ${code}`);
			}
		});

		it('abnormal: a value that is not a status passes no event by the status (the header reads PRE-LAUNCH for it)', () => {
			for (const status of BAD) {
				const label = typeof status === 'string' ? JSON.stringify(status) : String(status);
				assert.deepEqual(passedBy(status), [], `status ${label}`);
				assert.deepEqual(passedBy(status, 1), [], `single stage, status ${label}`);
				assert.equal(TelemetryPanel.formatMissionStatus(status), TELEMETRY.STATUS_MAP[TELEMETRY.STATUS.PRE_LAUNCH]);
			}
			// No telemetry at all
			const rocket = mainRocket(4, { isHoldDown: false, totalStages: 2, burnTime: 100, fuelMass: 50 });
			rocket.telemetry = undefined;
			rocket.predictedTrajectory = { events: [{ id: 'maxq', type: 'maxq', altM: 1e9 }] };
			TrajectoryPredictor.updateRocketFlightEvents(rocket, null);
			assert.deepEqual([...rocket.passedEventIds], []);
		});

		it('boundary: PRE_LAUNCH, LIFTOFF (0 and -0) and ASCENT pass nothing, MAX_Q exactly the first, TRACKING both', () => {
			for (const [status, want] of [[-1, []], [0, []], [-0, []], [1, []], [2, ['maxq']], [3, ['maxq', 'meco_1']], [5, ['maxq', 'meco_1']]]) {
				assert.deepEqual(passedBy(status), want, `status ${Object.is(status, -0) ? '-0' : status}`);
			}
		});
	});

	describe('C2/C3. the sound rules and the MECO detection read the normalised status; the Worker status is carried as is', () => {
		/** Whether a status rule plays for a telemetry status. */
		const plays = (rule, status) => {
			EventBus.clearAll();
			const rocket = { id: 7, telemetry: { status } };
			const sound = new SoundSequencer({ objects: [rocket], TelemetryPanel: { targetId: 7 }, LaunchSequencer: null });
			sound.audioProfile = { events: {}, times: {}, conditions: [{ id: 'r', type: 'status', audio: 'snd', once: false, ...rule }] };
			const played = record('audio:play');
			sound._checkConditions(30);
			played.stop();
			return played.length > 0;
		};
		const AT_LEAST_MAX_Q = { operator: '>=', value: TELEMETRY.STATUS.MAX_Q };

		it('normal: a ">= MAX_Q" rule plays from MAX_Q on; the shipped "== MAX_Q" rules play at MAX_Q only', () => {
			for (const code of CODES) {
				assert.equal(plays(AT_LEAST_MAX_Q, code), code >= TELEMETRY.STATUS.MAX_Q, `>= MAX_Q, status ${code}`);
			}
			const shipped = Object.values(LAUNCH_SEQUENCES).flatMap((s) => (s.audioProfile?.conditions ?? []).filter((c) => c.type === 'status'));
			assert.ok(shipped.length >= 2, 'input: shipped status rules');
			for (const rule of shipped) {
				for (const code of CODES) {
					assert.equal(plays({ operator: rule.operator, value: rule.value }, code), code === TELEMETRY.STATUS.MAX_Q, `${rule.id}, status ${code}`);
				}
			}
		});

		it('abnormal: a value that is not a status is PRE_LAUNCH for every rule (">= MAX_Q" silent, "< MAX_Q" and "== PRE_LAUNCH" play)', () => {
			for (const status of BAD) {
				const label = typeof status === 'string' ? JSON.stringify(status) : String(status);
				assert.equal(plays(AT_LEAST_MAX_Q, status), false, `>= MAX_Q, ${label}`);
				assert.equal(plays({ operator: '<', value: TELEMETRY.STATUS.MAX_Q }, status), true, `< MAX_Q, ${label}`);
				assert.equal(plays({ operator: '==', value: TELEMETRY.STATUS.PRE_LAUNCH }, status), true, `== PRE_LAUNCH, ${label}`);
				for (const rule of [{ operator: '==', value: TELEMETRY.STATUS.MAX_Q }, { operator: '!=', value: TELEMETRY.STATUS.PRE_LAUNCH }]) {
					assert.equal(plays(rule, status), false, `${rule.operator} ${rule.value}, ${label}`);
				}
			}
		});

		it('boundary (C3): MECO / SECO / PECO only at the MECO code; telemetry.status keeps every Worker value as is', () => {
			const om = new ObjectManager(null, { postMessage() {} });
			const rocket = mainRocket(5);
			om.addObject(rocket, false);
			const apply = (tmStatus, fields) => {
				rocket._mecoDetected = false;
				rocket._payloadBurnDetected = false;
				om._applyRocketState(rocket, { mass: 20, fuelMass: 10, oxidMass: 20, burnTime: 50, thrustRatio: 1, isIgnited: true, tmAltM: 0, tmStatus, tmStageIndex: 0, tmTotalStages: 2, ...fields });
				return rocket.telemetry;
			};
			// PECO is the stop of a payload seen firing after its separation (design §4.14-11): that frame, then the status
			const peco = (tmStatus) => {
				apply(TELEMETRY.STATUS.ASCENT, { tmStageIndex: 2, isPayloadSeparated: true });
				om._applyRocketState(rocket, { mass: 20, fuelMass: 10, oxidMass: 20, burnTime: 50, thrustRatio: 0, isIgnited: true, tmAltM: 0, tmStatus, tmStageIndex: 2, tmTotalStages: 2, isPayloadSeparated: true });
				return rocket.telemetry.isPeco;
			};
			for (const status of [...CODES, ...BAD.filter((v) => typeof v === 'number')]) {
				const isMeco = status === TELEMETRY.STATUS.MECO;
				assert.equal(apply(status, {}).isMeco, isMeco, `MECO, ${status}`);
				assert.equal(apply(status, { tmStageIndex: 1 }).isSeco, isMeco, `SECO, ${status}`);
				assert.equal(peco(status), isMeco, `PECO, ${status}`);
				assert.ok(Object.is(apply(status, {}).status, status), `telemetry.status carries ${status} as is`);
			}
			assert.ok(Object.is(apply(-0, {}).status, -0), '-0 as is');
		});
	});

	describe('C (scan). every read of a mission status goes through normalizeMissionStatus', () => {
		it('one implementation: TelemetryPanel.normalizeMissionStatus is the shared function of gravsim_utils.js', () => {
			for (const v of [...CODES, ...BAD, -0]) {
				assert.ok(Object.is(TelemetryPanel.normalizeMissionStatus(v), normalizeMissionStatus(v)), String(v));
			}
			assert.ok(Object.is(normalizeMissionStatus(-0), 0));
			const impls = SCRIPTS.filter(([f]) => /Object\.values\(TELEMETRY\.STATUS\)\.find/.test(code(f))).map(([f]) => f);
			assert.deepEqual(impls, ['gravsim_utils.js']);
		});

		it('reads of a status (.status, tmStatus) outside its producer and carrier sites are arguments of normalizeMissionStatus', () => {
			/** Producer and carrier lines that keep the Worker value as is (bit-identical statuses), with their read counts. */
			const RAW = [
				// The Worker writes the FlightComputer status into TM_STATUS
				{ file: 'gravsim_worker_bridge.js', line: /BUFFER_INDEX\.TM_STATUS\] = Number\.isFinite\(tm\.status\) \? tm\.status : TELEMETRY\.STATUS\.PRE_LAUNCH;/, reads: 2 },
				// The main telemetry keeps the Worker value (telemetry.status)
				{ file: 'gravsim_object_manager.js', line: /^\s*status: objData\.tmStatus,$/, reads: 1 }
			];
			const hits = [];
			for (const [file] of SCRIPTS) {
				if (file === 'gravsim_flight_computer.js') { continue; } // the producer (telemetryCache.status)
				const text = code(file);
				const lines = stripComments(source(file)).split('\n');
				for (const m of text.matchAll(/((?:[\w$]+\??\.)*[\w$]+)\??\.(status|tmStatus)\b/g)) {
					if (/^\s*=(?!=)/.test(text.slice(m.index + m[0].length))) { continue; } // a write
					const before = text.slice(Math.max(0, m.index - 'normalizeMissionStatus('.length), m.index);
					if (before === 'normalizeMissionStatus(') { continue; }
					const line = lineOf(text, m.index);
					hits.push({ file, key: `${file}|${m[1]}.${m[2]}`, line, raw: RAW.find((r) => r.file === file && r.line.test(lines[line - 1])) });
				}
			}
			assert.deepEqual(hits.filter((h) => !h.raw).map((h) => `${h.key} line ${h.line}`), []);
			assert.deepEqual(RAW.map((r) => hits.filter((h) => h.raw === r).length), RAW.map((r) => r.reads), 'the producer and carrier reads');
			// The generic telemetry lookup of the sound rules resolves the status first
			assert.match(stripComments(source('gravsim_sound_sequencer.js')), /cond\.type === 'status'\) \{\s*valueToCompare = normalizeMissionStatus\(rocket\.telemetry\.status\);/);
		});
	});

	// ==================================================================
	// D. DIST REF / ALT / VEL without their reference body (§4.13-26)
	// ==================================================================
	describe('D. the reference body and the values relative to it are shown together, or none of them', () => {
		/** A flying Falcon 9 with the telemetry panel open on it and the Navi tab targeting it. */
		const flying = () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			stepFrames(bridge, 30);
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			panel.open();
			panel.cards.find((c) => c.id === 'navigation').isVisible = true;
			const navi = universe.ControlPanel.naviTab;
			navi.naviTargetId = rocket.id;
			return { universe, bridge, rocket, panel, navi };
		};
		const view = ({ panel, navi }) => {
			panel.update();
			navi._updateNaviStats();
			return {
				ref: el('tm-dominant-body').textContent, dist: el('tm-dist-ref').textContent.trim(),
				nvRef: el('nv-ref-body').textContent, nvAlt: el('nv-alt').textContent, nvVel: el('nv-vel').textContent
			};
		};
		const NONE = { ref: '---', dist: '---', nvRef: 'NONE', nvAlt: '--- km', nvVel: '--- km/s' };

		it('normal (real path): in flight both name Earth and show its distance / altitude / speed; paused, Earth removed: none of them', () => {
			const ctx = flying();
			const { universe, rocket } = ctx;
			const earth = universe.objects.find((o) => o.name === 'Earth');
			const live = view(ctx);
			assert.equal(live.ref, 'Earth');
			const km = rocket.distToDominantM / 1000;
			assert.equal(live.dist, km.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
			assert.equal(live.nvRef, 'Earth');
			assert.equal(live.nvAlt, `${UnitConvertUtils.m2km(rocket.distToDominantM - earth.radius).toLocaleString('en-US', { maximumFractionDigits: 0 })} km`);
			assert.match(live.nvVel, /^\d+\.\d\d km\/s$/);
			// Paused (no Worker frame): Earth is removed and its trail fades out of universe.objects
			EventBus.emit('simulation:pause');
			universe.ObjectManager.removeObject(earth);
			for (let i = 0; i < 5000 && universe.objects.includes(earth); i++) { universe.ObjectManager.cleanupObjects(); }
			assert.equal(universe.objects.includes(earth), false, 'input: Earth is gone');
			assert.ok(rocket.dominantBodyId === earth.id && rocket.distToDominantM > 0, 'input: the rocket still holds the last frame');
			assert.deepEqual(view(ctx), NONE);
		});

		it('abnormal: no body (-1) with a distance, an id naming a rocket or nothing, a non-numeric id: none of them', () => {
			const ctx = flying();
			const { rocket } = ctx;
			const d = rocket.distToDominantM;
			for (const id of [-1, rocket.id, 9999, undefined, NaN, '1']) {
				rocket.dominantBodyId = id;
				rocket.distToDominantM = d;
				resetTexts(); // nothing carried over from the previous case
				assert.deepEqual(view(ctx), NONE, `dominantBodyId ${String(id)}`);
			}
		});

		it('boundary: a body with id 0 resolves; a resolved body with distance 0 shows the name and no DIST REF', () => {
			const ctx = flying();
			const { universe, rocket } = ctx;
			const sun = universe.objects.find((o) => o.name === 'Sun');
			assert.equal(sun.id, 0, 'input: the startup Sun has id 0');
			rocket.dominantBodyId = 0;
			const atSun = view(ctx);
			assert.deepEqual([atSun.ref, atSun.nvRef], ['Sun', 'Sun']);
			assert.notEqual(atSun.dist, '---');
			rocket.distToDominantM = 0;
			const zero = view(ctx);
			assert.deepEqual([zero.ref, zero.dist, zero.nvRef], ['Sun', '---', 'Sun']);
		});

		it('same pattern: the display modules resolve the reference body with NavigationCameraCard.resolveDominantBody only', () => {
			for (const file of ['gravsim_telemetry_card.js', 'gravsim_tab_navi.js']) {
				const text = code(file);
				assert.match(text, /NavigationCameraCard\.resolveDominantBody\(target, this\.universe\??\.objects\)/, file);
				assert.doesNotMatch(text, /find\([^)]*=>\s*\w+\.id === target\.dominantBodyId/, `${file} looks the body up itself`);
			}
			// DIST REF is computed only with the resolved body
			assert.match(code('gravsim_telemetry_card.js'), /\(dominantBody && target\.distToDominantM > 0\)/);
		});
	});
});
