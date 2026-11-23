/**
 * Regression Suite 15: the last pre-existing defects of design §4.13 (§4.13-19 to -22). All of them also occurred on main.
 *
 *  1. REF BODY of the Navigation & Camera card (§4.13-19). git 9efd5e3 read target.dominantBody, the Worker's object
 *     reference (CalcObject.dominantBody), which never reaches the main thread: the card always read "---". The main
 *     thread has the id the Worker sends in the frame buffer (dominantBodyId, -1 for none); the card resolves it against
 *     the celestial bodies of the universe (NavigationCameraCard.resolveDominantBody). It was the only Worker-only field
 *     the cards and the telemetry panel read.
 *  2. Real time (§4.13-20). Real time is the time-scale exponent log10(1 / (365.25 x 86400)) = -7.4991 (1 simulated s per
 *     s), but the #time-scale slider (min -7.5, step 0.1) rounds a value written to it to the nearest step, -7.5, and the
 *     simulation read its time scale back from the slider: a launch (ignite buttons, LaunchSequencer.start, closing the
 *     Rocket tab with a rocket on the pad) ran at 10^-7.5 x 31,557,600 = 0.998 s per s in a browser. A Node mock slider
 *     does not round, so the defect did not show in Node; this suite gives #time-scale a browser's value sanitization.
 *     A value set by code (real time, a load, the Rocket tab's restore) is now applied exactly and the slider shows the
 *     nearest step; the save holds the applied exponent.
 *  3. One normalisation of the mission status (§4.13-21). The pinned header read a value that is not a status as
 *     PRE-LAUNCH (TelemetryPanel.formatMissionStatus, §4.13-13), but the annunciator took every value other than
 *     PRE_LAUNCH as launched (TWR-C, PITCH, ORBIT, 1-ENG, MECO, 2-ENG, SECO), and the header took a numeric string as its
 *     status ("2" read MAX-Q while no MAX-Q lamp or colour followed). Every reader of the status in the panel now uses
 *     TelemetryPanel.normalizeMissionStatus: a value that is not one of the TELEMETRY.STATUS numbers is PRE_LAUNCH.
 *  4. Status literals (§4.13-22). WorkerBridge wrote TM_STATUS = tm.status || 0, the approach_maxq sound rule compared
 *     the status with 2 and ObjectManager with 3. They use the TELEMETRY.STATUS constants; a missing status in the Worker
 *     (no FlightComputer telemetry, which a CalcRocket always has) is PRE_LAUNCH instead of 0 (LIFTOFF), and every
 *     status the FlightComputer reports is written as is (the real path is bit-identical).
 *
 * Expected values: the dominant body is the celestial body of largest gravity (mass / distance^2) at the rocket (design
 * of PhysicsEngine; computed here from the object positions and masses); real time is 1 simulated second per second,
 * 1 / (365.25 x 86400) years per second (git e02858f); the #time-scale range and step of index.html and the HTML range
 * input value sanitization; TELEMETRY.STATUS / STATUS_MAP and the FlightComputer's initial status; the lamp names
 * (TWR-C tower cleared, PITCH, ORBIT, 1-ENG ... need a launched rocket). Nothing is copied from the output of the code
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
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { NavigationCameraCard } from '../../scripts/gravsim_telemetry_card.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { SoundSequencer } from '../../scripts/gravsim_sound_sequencer.js';
import * as presetModule from '../../scripts/gravsim_preset_manager.js';
import {
	OBJECT_TYPES, TELEMETRY, PHYSICS, SIMULATION, LAUNCH_SEQUENCES, CALC_BUFFER_CONFIG, BUFFER_INDEX
} from '../../scripts/gravsim_const.js';

const { presetManager } = presetModule;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'))
	.map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')]);
const source = (file) => SCRIPTS.find(([f]) => f === file)[1];
/** Source without block and line comments (the comments name the history, e.g. "|| 0"). */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Attributes of a range input in index.html. */
const rangeOf = (id) => {
	const tag = HTML.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0];
	assert.ok(tag, `index.html has #${id}`);
	const attr = (name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
	return { min: attr('min'), max: attr('max'), step: attr('step'), value: attr('value') };
};
const TIME_RANGE = rangeOf('time-scale');
const ZOOM_RANGE = rangeOf('zoom-scale');
const PRED_RANGE = rangeOf('pred-duration');
/** Real time: one simulated second per second, as years per second (the unit of universe.timeScale), and its exponent. */
const SECONDS_PER_YEAR = 365.25 * 86400;
const REAL_TIME_YEARS_PER_S = 1 / SECONDS_PER_YEAR;
const REAL_TIME_EXP = Math.log10(REAL_TIME_YEARS_PER_S);
/** Simulated seconds per wall-clock second at a time scale (Universe.update / SimulationController.update). */
const simSecondsPerSecond = (timeScale) => 1000 /* ms */ * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE * timeScale;

const el = (id) => document.getElementById(id);
/** Reset the shared mock sliders to their index.html attributes (the mock document is shared by every Universe). */
const resetSliders = () => {
	for (const [id, r] of [['time-scale', TIME_RANGE], ['zoom-scale', ZOOM_RANGE], ['pred-duration', PRED_RANGE]]) {
		const s = el(id);
		s.min = r.min;
		s.max = r.max;
		s.step = r.step;
		s.value = r.value;
	}
	for (const id of ['time-scale-indicator', 'tm-mission-status', 'm-hud-stat', 'tm-dominant-body', 'tm-dist-ref']) {
		el(id).textContent = '';
		delete el(id)._cachedText;
	}
};

/**
 * Give a mock range input the value sanitization of a browser's <input type="range"> (HTML, "Range state"): a value that
 * is not a valid floating-point number becomes the default (the middle of the range); the value is clamped to min..max
 * and rounded to the nearest allowed value min + n x step (of two equally near, the one towards +Infinity), not above
 * max. Chromium serializes the result as a decimal: rounding to the step's decimals reproduces that for step 0.1.
 * Returns a function that turns the element back into a plain mock (keeping its value).
 * @param {any} slider
 */
const installBrowserRange = (slider) => {
	let current = '';
	const VALID_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
	const sanitize = (raw) => {
		const min = Number(slider.min);
		const max = Number(slider.max);
		const step = Number(slider.step);
		const s = String(raw);
		let v = VALID_FLOAT.test(s) ? Number(s) : min + (max - min) / 2;
		v = Math.min(max, Math.max(min, v));
		const decimals = (String(slider.step).split('.')[1] || '').length;
		const at = (n) => Number((min + n * step).toFixed(decimals));
		// The number of steps above min, without the binary noise of the division (4.25 / 0.1 = 42.49999999999999: a tie)
		let n = Math.floor(Math.round(((v - min) / step) * 1e9) / 1e9 + 0.5);
		if (at(n) > max) { n -= 1; }
		return String(at(n));
	};
	const initial = slider.value;
	Object.defineProperty(slider, 'value', { configurable: true, enumerable: true, get: () => current, set: (raw) => { current = sanitize(raw); } });
	slider.value = initial;
	return () => {
		const kept = current;
		delete slider.value;
		slider.value = kept;
	};
};

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 14
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
	resetSliders();
	const universe = new Universe(createMockElement('canvas'));
	// The trajectory prediction is not under test here: skip it
	const launcher = universe.RocketLauncher;
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;
	launcher.requestPreviewUpdate = () => {};
	return { universe, bridge: PhysicsWorkerBridge.last };
};
const withEarth = (universe) => universe.ObjectPlacer.placeAtOrbitAroundSun('Earth') || universe.objects.find((o) => o.name === 'Earth');
const tabButton = (target) => {
	const btn = createMockElement('button');
	btn.setAttribute('data-target', target);
	return btn;
};
const openTab = (universe, target) => universe.ControlPanel._tabBtnClick({ target: tabButton(target) });
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
const rocketOf = (universe) => universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
/** Record the payloads of an EventBus event until stop(). */
const record = (event) => {
	const seen = [];
	const listener = (...args) => seen.push(args.length > 1 ? args : args[0]);
	EventBus.on(event, listener);
	seen.stop = () => EventBus.off(event, listener);
	return seen;
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

describe('Regression 15: the last pre-existing defects of design §4.13 (§4.13-19 to -22)', () => {
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

	// ------------------------------------------------------------------
	// 1. REF BODY
	// ------------------------------------------------------------------
	describe('1. the Navigation & Camera card shows the dominant body the Worker reports (its id resolved on the main thread)', () => {
		/** The celestial body of largest gravity at `obj` (mass / distance^2, the rule of PhysicsEngine), from the main-thread objects. */
		const strongestPull = (universe, obj) => {
			let best = null;
			let bestG = -Infinity;
			for (const o of universe.objects) {
				if (o.type !== OBJECT_TYPES.CELESTIAL) { continue; }
				const d2 = (o.x - obj.x) ** 2 + (o.y - obj.y) ** 2;
				const g = o.mass / d2;
				if (g > bestG) { bestG = g; best = o; }
			}
			return best;
		};
		/** A flying Falcon 9 with the telemetry panel open on it. */
		const flying = (frames = 30) => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			stepFrames(bridge, frames);
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			panel.open();
			const card = panel.cards.find((c) => c.id === 'navigation');
			card.isVisible = true;
			return { universe, bridge, rocket, panel, card };
		};
		const refBody = (panel) => { panel.update(); return el('tm-dominant-body').textContent; };

		it('normal (real path): in flight REF BODY names the body of strongest pull (Earth) and DIST REF its distance', () => {
			const { universe, rocket, panel } = flying();
			const expected = strongestPull(universe, rocket);
			assert.equal(expected?.name, 'Earth', 'input: Earth pulls hardest on a rocket climbing from it');
			assert.equal(rocket.dominantBodyId, expected.id, 'the Worker sent the id of that body');
			assert.equal('dominantBody' in rocket, false, 'the Worker object reference does not reach the main thread');
			assert.equal(refBody(panel), 'Earth');
			const km = rocket.distToDominantM / 1000;
			assert.ok(km > 6371 && km < 6371 + 500, `distance from the Earth center (${km} km)`);
			assert.equal(el('tm-dist-ref').textContent, km.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).padStart(10, ' '));
		});

		it('normal: an id of another celestial body names that body (the Sun), whatever its id', () => {
			const { universe, rocket, panel } = flying(3);
			const sun = universe.objects.find((o) => o.name === 'Sun');
			assert.ok(sun && sun.type === OBJECT_TYPES.CELESTIAL);
			rocket.dominantBodyId = sun.id;
			assert.equal(refBody(panel), 'Sun');
			assert.equal(NavigationCameraCard.resolveDominantBody(rocket, universe.objects), sun);
		});

		it('abnormal: no body (-1), a missing / non-numeric id, an id of a rocket or debris, an unknown id, a Worker-only reference: "---"', () => {
			const { universe, rocket, panel, card } = flying(3);
			const earth = universe.objects.find((o) => o.name === 'Earth');
			const maxId = Math.max(...universe.objects.map((o) => o.id));
			const bad = [-1, undefined, null, NaN, Infinity, String(earth.id), [earth.id], { id: earth.id }, true, rocket.id, maxId + 1000, -2, 0.5 + earth.id];
			for (const id of bad) {
				rocket.dominantBodyId = id;
				assert.equal(refBody(panel), '---', `dominantBodyId ${String(id)}`);
			}
			// The Worker's own reference (git 9efd5e3 read it) is not a main-thread input
			rocket.dominantBodyId = -1;
			rocket.dominantBody = earth;
			assert.equal(refBody(panel), '---', 'dominantBody is ignored');
			delete rocket.dominantBody;
			// A card without a universe resolves nothing
			const lone = new NavigationCameraCard('navigation', 'Navigation & Camera', createMockElement('div'), null);
			lone.initElements();
			rocket.dominantBodyId = earth.id;
			lone.update(rocket, rocket.telemetry);
			assert.equal(el('tm-dominant-body').textContent, '---');
			card.update(rocket, rocket.telemetry);
			assert.equal(el('tm-dominant-body').textContent, 'Earth', 'the panel card still resolves it');
		});

		it('boundary: on the pad before the first Worker frame "---", "Earth" from the first frame; id 0 is a body; a removed body is no longer named', () => {
			const { universe, bridge } = newUniverse();
			const earth = withEarth(universe);
			openTab(universe, 'tab-rocket');
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			panel.open();
			assert.equal(rocket.dominantBodyId, -1, 'input: no Worker frame yet (the Rocket tab pauses the simulation)');
			assert.equal(refBody(panel), '---');
			stepFrames(bridge, 1);
			assert.equal(rocket.dominantBodyId, earth.id, 'held on the Earth: the hold-down sets the host as dominant body');
			assert.equal(refBody(panel), 'Earth');
			// Ids start at 0 (ObjectManager.getNextId): 0 is a body, not "none"
			const objects = [{ id: 0, type: OBJECT_TYPES.CELESTIAL, name: 'Zero' }, { id: 1, type: OBJECT_TYPES.ROCKET, name: 'R' }];
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: 0 }, objects)?.name, 'Zero');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: -0 }, objects)?.name, 'Zero');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: 1 }, objects), null, 'a rocket is no dominant body');
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: 0 }, []), null, 'empty universe');
			assert.equal(NavigationCameraCard.resolveDominantBody(null, objects), null);
			assert.equal(NavigationCameraCard.resolveDominantBody({ dominantBodyId: 0 }, undefined), null);
			// A body removed from the universe (its id stays on the rocket until the next frame)
			const mars = universe.ObjectPlacer.placeAtOrbitAroundSun('Mars') || universe.objects.find((o) => o.name === 'Mars');
			rocket.dominantBodyId = mars.id;
			assert.equal(refBody(panel), 'Mars');
			universe.ObjectManager.removeObject(mars);
			universe.ObjectManager.cleanupObjects();
			assert.equal(universe.objects.includes(mars), false);
			assert.equal(refBody(panel), '---');
		});

		it('same pattern: the cards and the telemetry panel read no field that only Worker objects carry', () => {
			/** Fields assigned with `<receiver>.name =` in a source (comments stripped). */
			const assigned = (src, receivers) => new Set([...stripComments(src).matchAll(new RegExp(`\\b(?:${receivers})\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g'))].map((m) => m[1]));
			const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
			// Main-thread objects: their classes, and what the Worker sync, the placer, the loader and the launcher write
			const main = union(
				assigned(source('gravsim_object.js'), 'this'),
				assigned(source('gravsim_object_manager.js'), 'target|obj|base|deb|rocket|o'),
				assigned(source('gravsim_object_placer.js'), 'obj|rocket|o'),
				assigned(source('gravsim_rocket_launcher.js'), 'rocket|obj')
			);
			// Worker objects: CalcObject / CalcRocket and the engine
			const worker = union(assigned(source('gravsim_calc_object.js'), 'this'), assigned(source('gravsim_calc.js'), 'obj|objA|objB|rocket'));
			const workerOnly = new Set([...worker].filter((f) => !main.has(f)));
			assert.ok(workerOnly.has('dominantBody') && !main.has('dominantBody'), 'input: dominantBody exists only on Worker objects');
			assert.ok(main.has('dominantBodyId') && main.has('distToDominantM'), 'input: the main thread has the id and the distance');
			for (const file of ['gravsim_telemetry_card.js', 'gravsim_telemetry_panel.js']) {
				const reads = new Set([...stripComments(source(file)).matchAll(/\b(?:target|targetObj)\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
				assert.deepEqual([...reads].filter((f) => workerOnly.has(f)), [], `${file} reads only main-thread fields`);
			}
		});
	});

	// ------------------------------------------------------------------
	// 2. Real time
	// ------------------------------------------------------------------
	describe('2. real time runs at exactly 1 s per s with a browser slider (step 0.1), and a save keeps it', () => {
		let restoreSlider = null;
		/** A universe whose #time-scale slider rounds its value as a browser does. */
		const browserUniverse = () => {
			const u = newUniverse();
			restoreSlider = installBrowserRange(el('time-scale'));
			return u;
		};
		afterEach(() => {
			if (restoreSlider) { restoreSlider(); restoreSlider = null; }
		});
		const viewOf = (universe) => ({
			slider: el('time-scale').value,
			text: el('time-scale-indicator').textContent,
			timeScale: universe.timeScale
		});
		const setSlider = (value) => {
			el('time-scale').value = value;
			el('time-scale').dispatchEvent({ type: 'input' });
		};
		/** The time-scale view at real time: the slider at its minimum step, the indicator 1 s per s, exact real time. */
		const REAL_TIME_VIEW = () => ({ slider: TIME_RANGE.min, text: '1.00 sec/sec', timeScale: REAL_TIME_YEARS_PER_S });

		it('input: real time is -7.4991, within one step above the slider minimum; a browser slider shows -7.5, which runs at 0.998 s per s', () => {
			assert.equal(Math.pow(10, REAL_TIME_EXP), REAL_TIME_YEARS_PER_S, 'the exponent gives real time back exactly');
			assert.ok(Math.abs(simSecondsPerSecond(REAL_TIME_YEARS_PER_S) - 1) < 1e-15);
			assert.deepEqual([TIME_RANGE.min, TIME_RANGE.max, TIME_RANGE.step], ['-7.5', '1', '0.1'], 'index.html');
			assert.ok(REAL_TIME_EXP > Number(TIME_RANGE.min) && REAL_TIME_EXP - Number(TIME_RANGE.min) < Number(TIME_RANGE.step) / 2);
			// The emulated browser slider (HTML value sanitization)
			const s = createMockElement('input');
			Object.assign(s, { min: TIME_RANGE.min, max: TIME_RANGE.max, step: TIME_RANGE.step, value: '-1' });
			installBrowserRange(s);
			const shown = (v) => { s.value = v; return s.value; };
			assert.deepEqual([REAL_TIME_EXP, -3.2, -3.24, -3.25, -3.26, 1, 1.04, 5, -20, 'x', NaN, ''].map(shown),
				['-7.5', '-3.2', '-3.2', '-3.2', '-3.3', '1', '1', '1', '-7.5', '-3.2', '-3.2', '-3.2']);
			assert.ok(Math.abs(simSecondsPerSecond(Math.pow(10, -7.5)) - 0.998) < 0.0005, 'the slider step runs 0.2 % slow');
		});

		it('normal (real path): the quick-ignite button runs the simulation and the Worker at real time; the slider shows -7.5', () => {
			const { universe, bridge } = browserUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			universe.RocketLauncher.rollout();
			assert.equal(el('time-scale').value, TIME_RANGE.min, 'the tab runs at the minimum');
			assert.equal(universe.timeScale, Math.pow(10, Number(TIME_RANGE.min)));
			universe.ControlPanel.rocketTab.ui.rlIgniteQuickBtn.click();
			assert.deepEqual(viewOf(universe), REAL_TIME_VIEW());
			assert.equal(universe.LaunchSequencer.isActive, true, 'the countdown runs');
			// One second of wall-clock time: the Worker integrates 1 s and the countdown advances 1 s
			const t0 = universe.LaunchSequencer.timer;
			universe.update(1000);
			assert.equal(bridge.ctrl.timeScale, REAL_TIME_YEARS_PER_S, 'the Worker receives real time');
			assert.ok(Math.abs(simSecondsPerSecond(bridge.ctrl.timeScale) - 1) < 1e-15, 'Worker frame: 1 s per s');
			assert.ok(Math.abs(universe.LaunchSequencer.timer - t0 - 1) < 1e-12, `countdown: ${universe.LaunchSequencer.timer - t0} s per s`);
		});

		it('normal: LaunchSequencer.start (the full countdown) and closing the Rocket tab with a rocket on the pad also give exact real time', () => {
			const { universe } = browserUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			universe.LaunchSequencer.start(LAUNCH_SEQUENCES.FULL_COUNTDOWN, rocket.id);
			assert.deepEqual(viewOf(universe), REAL_TIME_VIEW());
			universe.LaunchSequencer.abort();
			EventBus.emit('ui:set-time-scale-min');
			assert.equal(universe.timeScale, Math.pow(10, -7.5), 'back to the slider minimum');
			EventBus.emit('camera:stop-auto-tracking');
			const tab = universe.ControlPanel.rocketTab;
			tab.close();
			assert.equal(tab.isOpened, false);
			assert.deepEqual(viewOf(universe), REAL_TIME_VIEW(), 'closing with a rocket on the pad: the launch view');
		});

		it('normal: a save in real time holds the real-time exponent; loading it runs at real time again (Rocket tab closed, or open and then closed)', async () => {
			const A = browserUniverse();
			withEarth(A.universe);
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			assert.deepEqual(viewOf(A.universe), REAL_TIME_VIEW());
			const file = await saveToJson(A.universe);
			assert.equal(file.universe.controlPanel.controlPanel.timeScaleVal, REAL_TIME_EXP, 'saved as the applied exponent, not the slider step');
			restoreSlider();
			EventBus.clearAll();

			const B = browserUniverse();
			withEarth(B.universe);
			setSlider('-2');
			loadJson(B.universe, file);
			assert.deepEqual(viewOf(B.universe), REAL_TIME_VIEW(), 'loaded with the Rocket tab closed');
			const again = await saveToJson(B.universe);
			assert.equal(again.universe.controlPanel.controlPanel.timeScaleVal, REAL_TIME_EXP, 'and saved again unchanged');

			// Loaded while the Rocket tab is open: the tab keeps its minimum, closing it applies real time
			setSlider('-2');
			openTab(B.universe, 'tab-rocket');
			loadJson(B.universe, file);
			assert.equal(B.universe.timeScale, Math.pow(10, -7.5), 'the tab keeps its minimum while open');
			openTab(B.universe, 'tab-sys');
			assert.deepEqual(viewOf(B.universe), REAL_TIME_VIEW(), 'applied when the tab closes');
		});

		it('normal: the Rocket tab restores the time scale from before it opened exactly (real time, and a slider step whose log10 round trip is inexact)', () => {
			const { universe } = browserUniverse();
			withEarth(universe);
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			openTab(universe, 'tab-rocket');
			assert.equal(universe.timeScale, Math.pow(10, -7.5));
			openTab(universe, 'tab-sys');
			assert.deepEqual(viewOf(universe), REAL_TIME_VIEW(), 'real time back');
			// 0.3: Math.log10(10 ** 0.3) is 0.29999999999999993, whose power differs from 10 ** 0.3 in the last bit
			assert.notEqual(Math.pow(10, Math.log10(Math.pow(10, 0.3))), Math.pow(10, 0.3), 'input: an inexact round trip');
			setSlider('0.3');
			openTab(universe, 'tab-rocket');
			openTab(universe, 'tab-sys');
			assert.equal(el('time-scale').value, '0.3');
			assert.equal(universe.timeScale, Math.pow(10, 0.3), 'the slider value from before, bit for bit');
		});

		it('abnormal: a requested value that is not a finite number changes nothing; beyond the range it is clamped to the range ends', () => {
			const { universe } = browserUniverse();
			setSlider('-2');
			const before = viewOf(universe);
			for (const bad of [NaN, Infinity, -Infinity, undefined, null, '-3', '', true, {}, []]) {
				EventBus.emit('ui:set-time-scale', bad);
				assert.deepEqual(viewOf(universe), before, `ui:set-time-scale ${String(bad)}`);
			}
			EventBus.emit('ui:set-time-scale', 5);
			assert.deepEqual([el('time-scale').value, universe.timeScale], [TIME_RANGE.max, Math.pow(10, Number(TIME_RANGE.max))]);
			EventBus.emit('ui:set-time-scale', -20);
			assert.deepEqual([el('time-scale').value, universe.timeScale], [TIME_RANGE.min, Math.pow(10, Number(TIME_RANGE.min))]);
			// Saved values that are not numbers keep the time scale; out of range they are clamped (design §3.5-1)
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			const rt = viewOf(universe);
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: 'fast', zoomScaleVal: null } }, null);
			assert.deepEqual(viewOf(universe), rt);
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: 99, zoomScaleVal: null } }, null);
			assert.equal(universe.timeScale, Math.pow(10, Number(TIME_RANGE.max)));
		});

		it('boundary: the slider minimum itself, a value just above it, moving the slider after real time (the slider rules again)', () => {
			const { universe } = browserUniverse();
			EventBus.emit('ui:set-time-scale', -7.5);
			assert.deepEqual([el('time-scale').value, universe.timeScale], ['-7.5', Math.pow(10, -7.5)]);
			EventBus.emit('ui:set-time-scale', -7.5 + 1e-9);
			assert.deepEqual([el('time-scale').value, universe.timeScale], ['-7.5', Math.pow(10, -7.5 + 1e-9)], 'off the step grid: exact');
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: -3.25, zoomScaleVal: null } }, null);
			assert.deepEqual([el('time-scale').value, universe.timeScale], ['-3.2', Math.pow(10, -3.25)], 'a saved value between two steps: exact');
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			assert.equal(universe.timeScale, REAL_TIME_YEARS_PER_S);
			setSlider('-7.4');
			assert.equal(universe.timeScale, Math.pow(10, -7.4));
			setSlider('-7.5');
			assert.deepEqual(viewOf(universe), { slider: '-7.5', text: '1.00 sec/sec', timeScale: Math.pow(10, -7.5) }, 'the slider step -7.5, not real time');
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			EventBus.emit('ui:set-time-scale-min');
			assert.equal(universe.timeScale, Math.pow(10, -7.5), 'the minimum request is the slider minimum');
			assert.equal(universe.ControlPanel.getState().controlPanel.timeScaleVal, -7.5);
			// The exact value only stands for the step the slider was given: a slider showing another step (written
			// without an input event, e.g. a form restored by the browser) is read as that step
			EventBus.emit('ui:set-time-scale', REAL_TIME_EXP);
			assert.equal(universe.ControlPanel.getTimeScaleExp(), REAL_TIME_EXP);
			el('time-scale').value = '-3';
			assert.equal(universe.ControlPanel.getTimeScaleExp(), -3);
			assert.equal(universe.ControlPanel.getTimeScale(), Math.pow(10, -3));
			assert.equal(universe.ControlPanel.getState().controlPanel.timeScaleVal, -3);
			el('time-scale').value = '-7.5';
			assert.equal(universe.ControlPanel.getTimeScaleExp(), REAL_TIME_EXP, 'back on the step it was given: the exact value again');
		});
	});

	// ------------------------------------------------------------------
	// 3. One normalisation of the mission status
	// ------------------------------------------------------------------
	describe('3. the pinned header, the minimal HUD and the annunciator read a value that is not a status the same way (PRE_LAUNCH)', () => {
		const PRE_LAUNCH_TEXT = TELEMETRY.STATUS_MAP[new FlightComputer({}).getTelemetry().status];
		/** The lamps that need a launched rocket (TWR-C, PITCH, ORBIT, 1-ENG, MECO, 2-ENG, SECO) and the others. */
		const LAUNCHED_LAMPS = ['twr', 'pitch', 'orbit', '1eng', 'meco', '2eng', 'seco'];
		const BAD = [undefined, null, NaN, Infinity, -Infinity, 6, -2, 99, 0.5, 2.5, -0.5, 5 + 1e-9, '', 'x', 'LIFTOFF', '-1', '0', '1', '2', '3', '4', '5', 'toString', true, false, {}, []];
		/** Lamps and both status texts for a telemetry status on a flying rocket (the panel open, then closed). */
		const showAll = ({ universe, rocket, panel }, status) => {
			rocket.telemetry = { ...rocket.telemetry, status };
			panel.lampTestTimer = 0;
			panel.open();
			panel.update();
			const lamps = Object.fromEntries(Object.entries(panel.lamps).map(([k, l]) => [k, l.classList.contains('on')]));
			const header = el('tm-mission-status').textContent;
			const color = el('tm-mission-status').style.color;
			panel.close();
			panel.update();
			return { header, color, hud: el('m-hud-stat').textContent, alert: el('m-hud-alert').style.display, lamps, universe };
		};
		const strip = ({ universe: _u, ...rest }) => rest;
		/** A Falcon 9 burning its first stage above 1 km (the tower cleared), from the real path. */
		const climbing = () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			assert.ok(stepFrames(bridge, 400, () => rocket.telemetry.altM > 3000), 'climbed above 3 km');
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			return { universe, bridge, rocket, panel };
		};

		it('input: the status numbers are -1..5, their texts, and the FlightComputer starts at PRE_LAUNCH', () => {
			assert.deepEqual(Object.values(TELEMETRY.STATUS), [-1, 0, 1, 2, 3, 4, 5]);
			assert.equal(PRE_LAUNCH_TEXT, 'PRE-LAUNCH');
			for (const code of Object.values(TELEMETRY.STATUS)) { assert.equal(typeof TELEMETRY.STATUS_MAP[code], 'string'); }
		});

		it('normal (real path): a climbing rocket lights the launched lamps for its status, and none of them for PRE_LAUNCH', () => {
			const ctx = climbing();
			const ascent = showAll(ctx, TELEMETRY.STATUS.ASCENT);
			assert.equal(ascent.header, 'ASCENT');
			assert.deepEqual(['twr', 'pitch', '1eng'].map((k) => ascent.lamps[k]), [true, true, true], 'tower cleared, pitch program, stage 1 burning');
			const pre = showAll(ctx, TELEMETRY.STATUS.PRE_LAUNCH);
			assert.equal(pre.header, PRE_LAUNCH_TEXT);
			assert.deepEqual(LAUNCHED_LAMPS.filter((k) => pre.lamps[k]), [], 'not launched');
			assert.equal(pre.lamps.auto, true, 'AUTO does not depend on the status');
		});

		it('abnormal: every value that is not a status reads PRE-LAUNCH and lights exactly the lamps of PRE_LAUNCH (header, minimal HUD, annunciator agree)', () => {
			const ctx = climbing();
			const pre = strip(showAll(ctx, TELEMETRY.STATUS.PRE_LAUNCH));
			for (const status of BAD) {
				assert.deepEqual(strip(showAll(ctx, status)), pre, `status ${typeof status === 'string' ? JSON.stringify(status) : String(status)}`);
				assert.equal(TelemetryPanel.normalizeMissionStatus(status), TELEMETRY.STATUS.PRE_LAUNCH);
				assert.equal(TelemetryPanel.formatMissionStatus(status), PRE_LAUNCH_TEXT);
			}
			// "2" is no MAX-Q: no red header (it read MAX-Q while no lamp, colour or alert followed)
			const maxQ = showAll(ctx, TELEMETRY.STATUS.MAX_Q);
			assert.deepEqual([maxQ.header, maxQ.color, maxQ.lamps.qlim, maxQ.alert], ['MAX-Q', TELEMETRY.STYLE.MISSION_STATUS.MAX_Q_COLOR, true, 'inline']);
			const str = showAll(ctx, '2');
			assert.deepEqual([str.header, str.color, str.lamps.qlim], [PRE_LAUNCH_TEXT, TELEMETRY.STYLE.MISSION_STATUS.NORMAL_COLOR, false]);
			// During an auto sequence such a value reads AUTO-SEQUENCE like PRE_LAUNCH itself, with the AUTO lamp only
			ctx.universe.LaunchSequencer.isAutoSequence = true;
			ctx.universe.LaunchSequencer.isActive = true;
			const autoPre = strip(showAll(ctx, TELEMETRY.STATUS.PRE_LAUNCH));
			assert.deepEqual([autoPre.header, autoPre.hud], ['AUTO-SEQUENCE', 'AUTO-SEQ']);
			for (const status of [6, NaN, undefined, '1']) {
				assert.deepEqual(strip(showAll(ctx, status)), autoPre, `auto sequence, status ${String(status)}`);
			}
			ctx.universe.LaunchSequencer.isAutoSequence = false;
			ctx.universe.LaunchSequencer.isActive = false;
			// The annunciator called without telemetry (target only, no telemetry on it): not launched
			const panel = ctx.panel;
			panel.lampTestTimer = 0;
			panel._updateAnnunciator({ totalStages: 2, currentStageIndex: 0, thrustRatio: 1, fuelMass: 50, burnTime: 100, isIgnited: true });
			assert.deepEqual(LAUNCHED_LAMPS.filter((k) => panel.lamps[k].classList.contains('on')), []);
		});

		it('boundary: LIFTOFF (0, also -0) and TRACKING (5) are launched, -1 and the values next to the range are not', () => {
			const ctx = climbing();
			const launched = (status) => showAll(ctx, status).lamps.twr;
			const cases = [[-2, false], [-1, false], [-0.5, false], [-0, true], [0, true], [0.5, false], [1, true], [4, true], [5, true], [5.5, false], [6, false]];
			for (const [status, expected] of cases) {
				assert.equal(launched(status), expected, `TWR-C with status ${status}`);
			}
			assert.ok(Object.is(TelemetryPanel.normalizeMissionStatus(-0), 0), '-0 is the LIFTOFF code 0');
			for (const code of Object.values(TELEMETRY.STATUS)) {
				assert.equal(TelemetryPanel.normalizeMissionStatus(code), code);
				assert.equal(showAll(ctx, code).header, TELEMETRY.STATUS_MAP[code]);
			}
		});

		it('every reader of the status in the panel goes through normalizeMissionStatus', () => {
			const src = stripComments(source('gravsim_telemetry_panel.js'));
			const reads = src.match(/\btm\??\.status\b/g) ?? [];
			const normalized = src.match(/normalizeMissionStatus\(tm\??\.status\)/g) ?? [];
			assert.ok(reads.length >= 3, 'header, minimal HUD, annunciator');
			assert.equal(normalized.length, reads.length, 'no raw tm.status comparison left');
		});
	});

	// ------------------------------------------------------------------
	// 4. Status literals
	// ------------------------------------------------------------------
	describe('4. the status is compared and written with the TELEMETRY.STATUS constants (behaviour unchanged)', () => {
		it('no script compares or defaults a status with a number literal; the approach_maxq rules use TELEMETRY.STATUS.MAX_Q', () => {
			const patterns = [
				/\b\w*[sS]tatus\w*\s*(?:===|!==|==|!=|>=|<=|>|<)\s*[-+]?\d/g,
				/[-+]?\d\s*(?:===|!==|==|!=|>=|<=|>|<)\s*[\w.]*[sS]tatus\b/g,
				/\b\w*[sS]tatus\w*\s*(?:\|\||\?\?)\s*[-+]?\d/g,
				/type:\s*["']status["'][^}]*\bvalue:\s*[-+]?\d/g
			];
			for (const [file, src] of SCRIPTS) {
				const code = stripComments(src);
				for (const re of patterns) {
					assert.deepEqual(code.match(re) ?? [], [], `${file}: ${re}`);
				}
			}
			const rules = Object.entries(LAUNCH_SEQUENCES).flatMap(([name, seq]) => (seq.audioProfile?.conditions ?? []).filter((c) => c.type === 'status').map((c) => [name, c]));
			assert.ok(rules.length >= 2, `input: status rules (${rules.length})`);
			for (const [name, c] of rules) {
				assert.equal(c.id, 'approach_maxq', name);
				assert.equal(c.value, TELEMETRY.STATUS.MAX_Q, `${name}: the rule waits for MAX-Q`);
			}
			assert.equal((stripComments(source('gravsim_const.js')).match(/id:\s*"approach_maxq"[^}]*value:\s*TELEMETRY\.STATUS\.MAX_Q\b/g) ?? []).length, rules.length);
		});

		it('normal: the approach_maxq callout plays at MAX-Q only', () => {
			for (const [name, seq] of Object.entries(LAUNCH_SEQUENCES)) {
				if (!seq.audioProfile?.conditions?.some((c) => c.id === 'approach_maxq')) { continue; }
				for (const code of Object.values(TELEMETRY.STATUS)) {
					const rocket = { id: 7, telemetry: { status: code } };
					const sound = new SoundSequencer({ objects: [rocket], TelemetryPanel: { targetId: 7 }, LaunchSequencer: null });
					sound.audioProfile = { events: {}, times: {}, conditions: seq.audioProfile.conditions.filter((c) => c.id === 'approach_maxq') };
					const played = record('audio:play');
					sound._checkConditions(30);
					played.stop();
					assert.deepEqual([...played], code === TELEMETRY.STATUS.MAX_Q ? ['fl_approach_maxq'] : [], `${name}, status ${code}`);
					EventBus.clearAll();
				}
			}
		});

		it('normal (real path): every frame of a flight writes the FlightComputer status as is (bit-identical to the old `|| 0`)', () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'iss_rendezvous' });
			const codes = new Set(Object.values(TELEMETRY.STATUS));
			const seen = new Set();
			let frames = 0;
			stepFrames(bridge, 3000, () => rocket.isPayloadSeparated && frames > 0 && seen.has(TELEMETRY.STATUS.MECO), (buf, objects) => {
				objects.forEach((o, i) => {
					if (o.type !== OBJECT_TYPES.ROCKET) { return; }
					const fcStatus = o.flightComputer.getTelemetry().status;
					assert.ok(codes.has(fcStatus), `the FlightComputer reports a status code (${fcStatus})`);
					const written = buf[i * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT + BUFFER_INDEX.TM_STATUS];
					assert.ok(Object.is(written, fcStatus || 0) && Object.is(written, fcStatus), `frame ${frames}: ${written} for ${fcStatus}`);
					seen.add(fcStatus);
				});
				frames++;
			});
			assert.ok(seen.has(TELEMETRY.STATUS.ASCENT) && seen.has(TELEMETRY.STATUS.MECO), `statuses seen: ${[...seen]}`);
		});

		it('abnormal / boundary: a rocket without FlightComputer telemetry is written as PRE_LAUNCH (was 0, LIFTOFF); every code, 0 included, as is', () => {
			const slot = (rocket) => WorkerBridge.formatWorkerToMain([rocket])[BUFFER_INDEX.TM_STATUS];
			const base = { id: 3, type: OBJECT_TYPES.ROCKET, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, radius: 1, dryMass: 1, fuelMass: 0, oxidMass: 0, burnTime: 0, thrustAngle: 0 };
			assert.equal(slot({ ...base }), TELEMETRY.STATUS.PRE_LAUNCH, 'no FlightComputer');
			assert.equal(slot({ ...base, flightComputer: { getTelemetry: () => ({}) } }), TELEMETRY.STATUS.PRE_LAUNCH, 'telemetry without a status');
			for (const missing of [undefined, null, NaN, Infinity, 'x']) {
				assert.equal(slot({ ...base, flightComputer: { getTelemetry: () => ({ status: missing }) } }), TELEMETRY.STATUS.PRE_LAUNCH, `status ${String(missing)}`);
			}
			for (const code of Object.values(TELEMETRY.STATUS)) {
				assert.ok(Object.is(slot({ ...base, flightComputer: { getTelemetry: () => ({ status: code }) } }), code), `code ${code}`);
			}
			assert.ok(Object.is(slot({ ...base, flightComputer: new FlightComputer({}) }), TELEMETRY.STATUS.PRE_LAUNCH), 'a new FlightComputer');
			// The main thread reads it as PRE-LAUNCH (the old 0 read LIFTOFF)
			assert.equal(TelemetryPanel.formatMissionStatus(slot({ ...base })), PRE_LAUNCH_TEXT_OF());
		});

		it('normal / boundary: ObjectManager detects MECO / SECO / PECO at the MECO status only (the other statuses do not); PECO only after the payload\'s own burn (design §4.14-11)', () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			let objData = null;
			stepFrames(bridge, 1, null, (buf) => {
				WorkerBridge.parseWorkerToMain(buf.buffer, buf.length, (d) => { if (d.type === OBJECT_TYPES.ROCKET) { objData = { ...d }; } });
			});
			assert.ok(objData, 'input: a frame of the rocket');
			const om = universe.ObjectManager;
			const tmFor = (fields) => {
				rocket._mecoDetected = false;
				rocket._payloadBurnDetected = false;
				om._applyRocketState(rocket, { ...objData, ...fields });
				return rocket.telemetry;
			};
			// A self-propelled payload released and seen firing (its own burn, design §4.14-11), then the frame under test
			const payloadFrame = { tmStageIndex: 2, isPayloadSeparated: true, hasPayloadPropulsion: true, burnTime: 50 };
			const tmAfterPayloadBurn = (fields) => {
				const firing = tmFor({ ...payloadFrame, tmStatus: TELEMETRY.STATUS.ASCENT, isIgnited: true, thrustRatio: 1 });
				assert.equal(firing.isPes, true, 'input: the payload fires (PES)');
				assert.equal(firing.isPeco, false, 'input: no PECO while it fires');
				om._applyRocketState(rocket, { ...objData, ...payloadFrame, ...fields });
				return rocket.telemetry;
			};
			for (const code of Object.values(TELEMETRY.STATUS)) {
				const isMecoCode = code === TELEMETRY.STATUS.MECO;
				// Stage 1 still firing with propellant: only the MECO status marks the cutoff
				assert.equal(tmFor({ tmStatus: code, tmStageIndex: 0, isIgnited: true, thrustRatio: 1, burnTime: 50, isPayloadSeparated: false }).isMeco, isMecoCode, `MECO, status ${code}`);
				// Stage 2 attached
				assert.equal(tmFor({ tmStatus: code, tmStageIndex: 1, isIgnited: true, thrustRatio: 1, burnTime: 50, isPayloadSeparated: false }).isSeco, isMecoCode, `SECO, status ${code}`);
				// Payload released after its own burn, its engine off with burn time left
				assert.equal(tmAfterPayloadBurn({ tmStatus: code, isIgnited: true, thrustRatio: 0 }).isPeco, isMecoCode, `PECO, status ${code}`);
				// A payload never seen firing has no engine cutoff, at any status (a passive payload's separation, §4.14-11)
				assert.equal(tmFor({ ...payloadFrame, tmStatus: code, isIgnited: true, thrustRatio: 0 }).isPeco, false, `no PECO without a payload burn, status ${code}`);
			}
		});
	});
});

/** The PRE-LAUNCH text (the FlightComputer's initial status). */
function PRE_LAUNCH_TEXT_OF() {
	return TELEMETRY.STATUS_MAP[new FlightComputer({}).getTelemetry().status];
}
