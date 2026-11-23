/**
 * Regression Suite 14: the last pre-existing defects found while fixing those of design §4.13 (§4.13-13 to -18).
 * All of them also occurred on main.
 *
 *  1. Unknown mission status (§4.13-13). The pinned header and the minimal HUD fell back to TELEMETRY.STATUS_MAP[0] for a
 *     value that is not a status. git 82f8860 wrote that fallback for MISSION_STATUS.PRE_LAUNCH, index 0 at the time;
 *     since git bd61960 renumbered the statuses to -1..5 it read LIFTOFF. Both now use the PRE_LAUNCH status, the
 *     FlightComputer's initial status (TelemetryPanel.formatMissionStatus).
 *  2. Dead separation blink (§4.13-14). The annunciator blinked 1-SEP / 2-SEP while tm.isStgSepActive was set. git
 *     5f0628d fed it from a Worker lamp timer (stgSepLampTimer, buffer slot TM_STG_SEP_ACTIVE); git e49d500 removed the
 *     timer, the slot and the telemetry field but left the reader, so the branch never ran. It cannot be rebuilt from the
 *     data that reaches the main thread (the lamp ran MULTISTAGE_ROCKET.STG_SEP_LAMP_DURATION_SEC = 3.5 s from the
 *     separation; the interstage coast lasts the 2 s ignition delay and the payload separation has none), and the old
 *     expressions flashed 2-SEP at the stage-1 separation (the stage index advances in the step that started the timer).
 *     The branch and the unused constant are removed; the SEP lamps are steady. Two more annunciator inputs had no
 *     producer on the main thread since the panel was added (git c98ddf9) and are removed the same way: the
 *     low-propellant term of WARN read target.maxFuel (never set, so never true; with target.isIgnited missing it was
 *     undefined and the lamp flipped on every update), and the PRESS lamp read target.presState (a Worker-only state).
 *  3. Closing the Rocket tab with a rocket on the pad or a launch sequence running (§4.13-15). The branch assigned real
 *     time and dropped the zoom and camera target (git e02858f / 3734026: "real time for the launch"), but git 5998ab1
 *     moved the restore calls into the else branch, so nothing was applied. It now applies the launch view (real time,
 *     camera and zoom kept, nothing restored later), the helper the ignite buttons use. The tab buttons are locked
 *     while a rocket is on the pad or a sequence runs, so the branch is reachable only programmatically.
 *  4. The camera target restored on close (§4.13-16). restoreCameraTarget tracked the object saved at open() even if a
 *     load (possible only while the tab is open, RocketTab.deferViewState) had replaced it or it had been removed. It now
 *     restores it only if that very object is still in the universe (identity: a load creates new objects with the
 *     saved ids, and an id of the replaced universe may name another object of the loaded one).
 *  5. The mission period (§4.13-17). PresetManager.applyToLauncher assigned any truthy predictionDurationMonths of the
 *     mission. It now applies the rule of RocketLauncher.loadState (finite positive, clamped to the slider range), the
 *     same code (applyPredictionDurationMonths of the preset manager).
 *  6. The range constants (§4.13-18): TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS / MAX_DURATION_MONTHS in gravsim_const.js
 *     (the range was a PREDICTION_DURATION_RANGE_MONTHS export of the launcher with a literal 36), equal to the
 *     #pred-duration slider of index.html.
 *
 * Expected values: the status texts of TELEMETRY.STATUS / STATUS_MAP and the FlightComputer's initial status; the lamp
 * names (1-SEP: stage 1 separated, 2-SEP: stage 2 / payload separated) and the stage counts of the presets; real time
 * (1 s per s = 1 / (365.25 x 86400) years per s) from git e02858f; the objects of the loaded file; the slider range of
 * index.html, the mission periods of presets/missions and the label rule of design §3.4-4. Nothing is copied from the
 * output of the code under test.
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
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import * as launcherModule from '../../scripts/gravsim_rocket_launcher.js';
import * as presetModule from '../../scripts/gravsim_preset_manager.js';
import { OBJECT_TYPES, TELEMETRY, TRAJECTORY_PREDICTION, MULTISTAGE_ROCKET, TANK_PRESSURE_SIM } from '../../scripts/gravsim_const.js';

const { RocketLauncher } = launcherModule;
const { presetManager } = presetModule;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'))
	.map((f) => [f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')]);
/** Source without block and line comments (the comments may name the history, e.g. "STATUS_MAP[0]"). */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Attributes of a range input in index.html. */
const rangeOf = (id) => {
	const tag = HTML.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0];
	assert.ok(tag, `index.html has #${id}`);
	const attr = (name) => Number(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]);
	return { min: attr('min'), max: attr('max'), step: attr('step'), value: attr('value') };
};
const TIME_RANGE = rangeOf('time-scale');
const ZOOM_RANGE = rangeOf('zoom-scale');
const PRED_RANGE = rangeOf('pred-duration');
const preset = (dir, id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', dir, `${id}.json`), 'utf8'));
const MISSIONS = fs.readdirSync(path.join(ROOT, 'presets', 'missions')).filter((f) => f !== 'manifest.json' && f.endsWith('.json'))
	.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'missions', f), 'utf8')));
/** Prediction-slider label rule (design §3.4-4). */
const predictionLabel = (m) => (m < 12 ? `${m} mo (${Math.round(m * 365.25 / 12)} d)` : `${(m / 12).toFixed(1)} yr (${m} mo)`);
/** Seconds of a prediction period as the design writes them: months x 365.25 / 12 days x 86400 s. */
const periodSec = (m) => m * (365.25 / 12) * 86400;
/** Real time: one simulated second per second, as years per second (the unit of universe.timeScale). */
const REAL_TIME_YEARS_PER_S = 1 / (365.25 * 86400);

const el = (id) => document.getElementById(id);
/** Reset the shared mock sliders to their index.html attributes (the mock document is shared by every Universe). */
const resetSliders = () => {
	for (const [id, r] of [['time-scale', TIME_RANGE], ['zoom-scale', ZOOM_RANGE], ['pred-duration', PRED_RANGE]]) {
		const s = el(id);
		s.min = String(r.min);
		s.max = String(r.max);
		s.step = String(r.step);
		s.value = String(r.value);
	}
	for (const id of ['pred-duration-val', 'time-scale-indicator', 'zoom-scale-indicator', 'tm-mission-status', 'm-hud-stat', 'tm-met', 'tm-stage-info']) {
		el(id).textContent = '';
		delete el(id)._cachedText;
	}
};

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 and 13
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

describe('Regression 14: the last pre-existing defects found while fixing those of design §4.13 (§4.13-13 to -18)', () => {
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
	// 1. Unknown mission status
	// ------------------------------------------------------------------
	describe('1. a value that is not a mission status reads PRE-LAUNCH (not LIFTOFF) on the pinned header and the minimal HUD', () => {
		const PRE_LAUNCH_TEXT = TELEMETRY.STATUS_MAP[new FlightComputer({}).getTelemetry().status];
		/** A rocket on the pad (real rollout, paused by the Rocket tab: no Worker frame) and its HUD. */
		const padRocket = () => {
			const { universe } = newUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			return { universe, rocket, panel };
		};
		/** Both status texts for `status`: the pinned header (panel open) and the minimal HUD (panel closed). */
		const shown = ({ rocket, panel }, status) => {
			rocket.telemetry = { ...rocket.telemetry, status };
			panel.open();
			panel.update();
			const header = el('tm-mission-status').textContent;
			panel.close();
			panel.update();
			return { header, hud: el('m-hud-stat').textContent };
		};

		it('input: the fallback is the FlightComputer initial status PRE_LAUNCH (git 82f8860 wrote it for MISSION_STATUS.PRE_LAUNCH, index 0 then)', () => {
			assert.equal(PRE_LAUNCH_TEXT, 'PRE-LAUNCH');
			assert.equal(TELEMETRY.STATUS.PRE_LAUNCH, -1);
			assert.equal(TELEMETRY.STATUS_MAP[0], 'LIFTOFF', 'index 0 is LIFTOFF since git bd61960');
		});

		it('normal (real path): every status the FlightComputer reports shows its own text on both displays', () => {
			const pad = padRocket();
			assert.equal(pad.rocket.telemetry.status, TELEMETRY.STATUS.PRE_LAUNCH);
			for (const [name, code] of Object.entries(TELEMETRY.STATUS)) {
				const text = TELEMETRY.STATUS_MAP[code];
				assert.equal(typeof text, 'string', `${name} has a text`);
				assert.deepEqual(shown(pad, code), { header: text, hud: text }, name);
			}
		});

		it('abnormal: values that are not a status (missing, NaN, out of range, fractions, other types) read PRE-LAUNCH', () => {
			const pad = padRocket();
			const bad = [undefined, null, NaN, Infinity, -Infinity, 6, 7, -2, 99, 1e9, -1e9, 0.5, 2.5, -0.5, '', 'x', 'LIFTOFF', 'toString', '__proto__', 'constructor', true, false, {}, []];
			for (const status of bad) {
				assert.deepEqual(shown(pad, status), { header: PRE_LAUNCH_TEXT, hud: PRE_LAUNCH_TEXT }, `status ${String(status)}`);
				assert.equal(TelemetryPanel.formatMissionStatus(status), PRE_LAUNCH_TEXT, `formatMissionStatus(${String(status)})`);
			}
			// The auto sequence replaces the PRE_LAUNCH status, and a value that is not a status is PRE_LAUNCH for every
			// reader of the panel (one normalisation, TelemetryPanel.normalizeMissionStatus, design §4.13-21)
			pad.universe.LaunchSequencer.isAutoSequence = true;
			assert.deepEqual(shown(pad, TELEMETRY.STATUS.PRE_LAUNCH), { header: 'AUTO-SEQUENCE', hud: 'AUTO-SEQ' });
			assert.deepEqual(shown(pad, 6), { header: 'AUTO-SEQUENCE', hud: 'AUTO-SEQ' });
		});

		it('boundary: around the status range (-1..5): -2 and 6 fall back, -1, 0 and 5 are their own statuses, -0 is LIFTOFF', () => {
			const lo = Math.min(...Object.values(TELEMETRY.STATUS));
			const hi = Math.max(...Object.values(TELEMETRY.STATUS));
			assert.deepEqual([lo, hi], [TELEMETRY.STATUS.PRE_LAUNCH, TELEMETRY.STATUS.TRACKING]);
			const pad = padRocket();
			const cases = [[lo - 1, PRE_LAUNCH_TEXT], [lo, 'PRE-LAUNCH'], [lo + 0.5, PRE_LAUNCH_TEXT], [0, 'LIFTOFF'], [-0, 'LIFTOFF'],
				[hi - 0.5, PRE_LAUNCH_TEXT], [hi, 'TRACKING'], [hi + 1e-9, PRE_LAUNCH_TEXT], [hi + 1, PRE_LAUNCH_TEXT]];
			for (const [status, text] of cases) {
				assert.deepEqual(shown(pad, status), { header: text, hud: text }, `status ${status}`);
			}
		});

		it('no script indexes STATUS_MAP with a number literal in its code (the pattern that broke with the renumbering)', () => {
			for (const [file, src] of SCRIPTS) {
				assert.deepEqual(stripComments(src).match(/STATUS_MAP\s*\[\s*[-+]?\d/g) ?? [], [], file);
			}
		});
	});

	// ------------------------------------------------------------------
	// 2. The separation lamps
	// ------------------------------------------------------------------
	describe('2. the annunciator reads only data that reaches the main thread: steady SEP lamps, WARN and PRESS without the dead inputs', () => {
		const SEP_LAMPS = ['1sep', '2sep', 'psep'];
		const lampsOf = (panel) => Object.fromEntries(SEP_LAMPS.map((k) => [k, { on: panel.lamps[k].classList.contains('on'), blink: panel.lamps[k].classList.contains('blink') }]));
		/** Expected SEP lamps from the lamp names: 1-SEP stage 1 gone, 2-SEP stage 2 gone (or the payload released), P-SEP payload released. */
		const expectedLamps = ({ totalStages, stage, stage2Sep, payloadSep }) => ({
			'1sep': { on: totalStages > 1 && stage >= 1, blink: false },
			'2sep': { on: totalStages > 1 && (stage >= 2 || stage2Sep || payloadSep), blink: false },
			psep: { on: payloadSep, blink: false }
		});

		/** Fly a vehicle with the HUD open and record the SEP lamps after every Worker frame until the payload is released. */
		const flyAndWatch = (ids) => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, ids);
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			panel.open();
			const samples = [];
			let after = 0;
			stepFrames(bridge, 2500, () => {
				panel.lampTestTimer = 0;
				panel.update();
				const tm = rocket.telemetry;
				samples.push({
					stage: tm.stageIndex, stageState: rocket.stageState, totalStages: tm.totalStages,
					stage2Sep: Boolean(rocket.isStage2Separated), payloadSep: Boolean(rocket.isPayloadSeparated || tm.isPayloadSeparated),
					lamps: lampsOf(panel)
				});
				if (rocket.isPayloadSeparated) { after++; }
				return after >= 5;
			});
			return { samples, rocket };
		};

		it('normal (real path): a 2-stage and a 3-stage flight light each SEP lamp from its separation on, never blinking, 2-SEP not at the stage-1 separation', () => {
			for (const [ids, stages] of [[{ vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' }, 2], [{ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km' }, 3]]) {
				assert.equal(preset('vehicles', ids.vehicleId).stages.length, stages, `input: ${ids.vehicleId} has ${stages} stages`);
				EventBus.clearAll();
				const { samples } = flyAndWatch(ids);
				assert.ok(samples.at(-1).payloadSep, `${ids.vehicleId}: the payload is released`);
				for (const [i, s] of samples.entries()) {
					assert.equal(s.totalStages, stages);
					assert.deepEqual(s.lamps, expectedLamps(s), `${ids.vehicleId} frame ${i}: stage index ${s.stage} (${s.stageState})`);
				}
				// Every separation was seen, with the interstage coast that follows it (the window the dead branch blinked in)
				for (let k = 1; k < stages; k++) {
					const coast = samples.filter((s) => s.stage === k && s.stageState === 'INTERSTAGE_COAST');
					assert.ok(coast.length >= 1, `${ids.vehicleId}: coast after the separation of stage ${k}`);
				}
				const atStage1Sep = samples.filter((s) => s.stage === 1 && s.stageState === 'INTERSTAGE_COAST');
				assert.ok(atStage1Sep.every((s) => s.lamps['1sep'].on && !s.lamps['2sep'].on), `${ids.vehicleId}: only 1-SEP at the stage-1 separation`);
			}
		});

		it('abnormal: the removed flag (tm.isStgSepActive) and the removed Worker timer field (stgSepLampTimer) change no lamp', () => {
			const { universe } = newUniverse();
			const panel = universe.TelemetryPanel;
			panel.lampTestTimer = 0;
			for (const totalStages of [2, 3]) {
				for (let stage = 0; stage <= totalStages; stage++) {
					const target = { totalStages, currentStageIndex: stage, stageState: stage === 0 ? 'STG_MECO' : 'INTERSTAGE_COAST', thrustRatio: 0, fuelMass: 0, burnTime: 0, isIgnited: false, isPayloadSeparated: stage >= totalStages };
					const tm = { status: TELEMETRY.STATUS.COASTING, stageIndex: stage, totalStages, altM: 80000, vV: 1000, vH: 2000 };
					panel._updateAnnunciator(target, tm);
					const plain = lampsOf(panel);
					assert.deepEqual(plain, expectedLamps({ totalStages, stage, stage2Sep: false, payloadSep: stage >= totalStages }), `${totalStages} stages, index ${stage}`);
					panel._updateAnnunciator({ ...target, stgSepLampTimer: MULTISTAGE_ROCKET.STG_SEP_LAMP_DURATION_SEC ?? 3.5 }, { ...tm, isStgSepActive: true });
					assert.deepEqual(lampsOf(panel), plain, `${totalStages} stages, index ${stage}: the removed flag is ignored`);
				}
			}
		});

		it('abnormal: missing separation flags clear the lamps on every update (no toggle of an undefined state)', () => {
			const { universe } = newUniverse();
			const panel = universe.TelemetryPanel;
			panel.lampTestTimer = 0;
			const target = { totalStages: 2, currentStageIndex: 1, thrustRatio: 1, fuelMass: 10, burnTime: 100, isIgnited: true };
			const tm = { status: TELEMETRY.STATUS.ASCENT, stageIndex: 1, totalStages: 2, altM: 120000, vV: 500, vH: 4500 };
			for (let n = 0; n < 4; n++) {
				panel._updateAnnunciator(target, tm);
				assert.deepEqual(lampsOf(panel), { '1sep': { on: true, blink: false }, '2sep': { on: false, blink: false }, psep: { on: false, blink: false } }, `update ${n + 1}`);
			}
		});

		it('boundary: one stage lights no SEP lamp at any index; the last index (payload released) lights all three; the flags alone light 2-SEP', () => {
			const { universe } = newUniverse();
			const panel = universe.TelemetryPanel;
			panel.lampTestTimer = 0;
			const tm = (stageIndex, totalStages, extra = {}) => ({ status: TELEMETRY.STATUS.COASTING, stageIndex, totalStages, altM: 200000, vV: 0, vH: 7800, ...extra });
			for (const stage of [0, 1, 2]) {
				panel._updateAnnunciator({ totalStages: 1, isPayloadSeparated: stage >= 1 }, tm(stage, 1));
				assert.deepEqual(lampsOf(panel), { '1sep': { on: false, blink: false }, '2sep': { on: false, blink: false }, psep: { on: stage >= 1, blink: false } }, `1 stage, index ${stage}`);
			}
			panel._updateAnnunciator({ totalStages: 2, isPayloadSeparated: true }, tm(2, 2));
			assert.deepEqual(lampsOf(panel), expectedLamps({ totalStages: 2, stage: 2, stage2Sep: false, payloadSep: true }));
			assert.ok(SEP_LAMPS.every((k) => panel.lamps[k].classList.contains('on')));
			// Stage index 1 with the stage-2 flag of the rocket, or the payload flag of the telemetry only
			panel._updateAnnunciator({ totalStages: 3, isStage2Separated: true }, tm(1, 3));
			assert.deepEqual(lampsOf(panel), expectedLamps({ totalStages: 3, stage: 1, stage2Sep: true, payloadSep: false }));
			panel._updateAnnunciator({ totalStages: 2 }, tm(1, 2, { isPayloadSeparated: true }));
			assert.deepEqual(lampsOf(panel), expectedLamps({ totalStages: 2, stage: 1, stage2Sep: false, payloadSep: true }));
		});

		it('normal (real path): WARN follows Q-LIM, G-LIM and STALL, and PRESS both tank pressures of the telemetry, on every frame of a flight', () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const panel = universe.TelemetryPanel;
			panel.targetId = rocket.id;
			panel.open();
			const on = (k) => panel.lamps[k].classList.contains('on');
			const th = TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA;
			let frames = 0;
			let pressOn = 0;
			let warnOn = 0;
			stepFrames(bridge, 2500, () => {
				panel.lampTestTimer = 0;
				panel.update();
				const tm = rocket.telemetry;
				const warn = on('qlim') || on('glim') || on('stall');
				assert.equal(on('warn'), warn, `frame ${frames}: WARN = Q-LIM | G-LIM | STALL`);
				assert.equal(panel.lamps.warn.classList.contains('blink'), warn, `frame ${frames}: WARN blinks while lit`);
				assert.equal(on('press'), tm.tankPresFuel >= th && tm.tankPresOxid >= th, `frame ${frames}: PRESS (${tm.tankPresFuel}, ${tm.tankPresOxid} kPa)`);
				frames++;
				pressOn += on('press') ? 1 : 0;
				warnOn += on('warn') ? 1 : 0;
				return Boolean(rocket.isPayloadSeparated);
			});
			assert.ok(rocket.isPayloadSeparated, 'flown to the payload separation');
			assert.ok(pressOn > 0 && pressOn < frames, `PRESS lit in some frames only (${pressOn} / ${frames})`);
			assert.ok(warnOn > 0, `WARN lit at max Q (${warnOn} frames)`);
		});

		it('abnormal: the removed inputs change nothing: target.maxFuel (low propellant) and target.presState; no WARN flip without isIgnited', () => {
			const { universe } = newUniverse();
			const panel = universe.TelemetryPanel;
			panel.lampTestTimer = 0;
			const th = TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA;
			const tm = { status: TELEMETRY.STATUS.ASCENT, stageIndex: 0, totalStages: 2, altM: 30000, vV: 800, vH: 600, structRatio: 10, currentG: 1, tankPresFuel: th - 1, tankPresOxid: th - 1 };
			const lamp = (k) => ({ on: panel.lamps[k].classList.contains('on'), blink: panel.lamps[k].classList.contains('blink') });
			// 4 % of a full tank, ignited: the removed low-propellant term was true here
			const target = { totalStages: 2, currentStageIndex: 0, isIgnited: true, thrustRatio: 1, fuelMass: 4, burnTime: 10, maxFuel: 100, maxGLimit: 4, presState: 'NOMINAL' };
			panel._updateAnnunciator(target, tm);
			assert.deepEqual([lamp('warn'), lamp('press')], [{ on: false, blink: false }, { on: false, blink: false }]);
			// The pressures alone light PRESS (threshold included)
			panel._updateAnnunciator(target, { ...tm, tankPresFuel: th, tankPresOxid: th });
			assert.deepEqual(lamp('press'), { on: true, blink: false });
			panel._updateAnnunciator({ ...target, presState: 'UNPRESSURIZED' }, { ...tm, tankPresFuel: th, tankPresOxid: th });
			assert.deepEqual(lamp('press'), { on: true, blink: false });
			// isIgnited missing (a rocket loaded from a save without it, before its first Worker frame): WARN stays off
			const { isIgnited: _omit, ...noIgnited } = target;
			for (let n = 0; n < 4; n++) {
				panel._updateAnnunciator(noIgnited, tm);
				assert.deepEqual(lamp('warn'), { on: false, blink: false }, `update ${n + 1}`);
			}
		});

		it('boundary: one tank at the threshold and the other just below leaves PRESS off; Q-LIM alone lights and blinks WARN', () => {
			const { universe } = newUniverse();
			const panel = universe.TelemetryPanel;
			panel.lampTestTimer = 0;
			const th = TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA;
			const target = { totalStages: 2, currentStageIndex: 0, isIgnited: true, thrustRatio: 1, fuelMass: 50, burnTime: 100, maxGLimit: 4 };
			const tm = { status: TELEMETRY.STATUS.ASCENT, stageIndex: 0, totalStages: 2, altM: 30000, vV: 800, vH: 600, structRatio: 10, currentG: 1 };
			const lamp = (k) => ({ on: panel.lamps[k].classList.contains('on'), blink: panel.lamps[k].classList.contains('blink') });
			for (const [f, o, expected] of [[th, th - 1e-9, false], [th - 1e-9, th, false], [th, th, true], [th + 1, th + 1, true]]) {
				panel._updateAnnunciator(target, { ...tm, tankPresFuel: f, tankPresOxid: o });
				assert.equal(lamp('press').on, expected, `${f} / ${o} kPa`);
			}
			panel._updateAnnunciator(target, { ...tm, status: TELEMETRY.STATUS.MAX_Q });
			assert.deepEqual([lamp('qlim'), lamp('warn')], [{ on: true, blink: true }, { on: true, blink: true }]);
		});

		it('removed: STG_SEP_LAMP_DURATION_SEC, stgSepLampTimer and isStgSepActive appear nowhere in scripts/; the panel reads no target.maxFuel / presState', () => {
			assert.equal(Object.prototype.hasOwnProperty.call(MULTISTAGE_ROCKET, 'STG_SEP_LAMP_DURATION_SEC'), false);
			assert.ok(Object.prototype.hasOwnProperty.call(MULTISTAGE_ROCKET, 'STAGE_SEP_FORWARD_PUSH_M_S'), 'sibling constants kept');
			for (const [file, src] of SCRIPTS) {
				for (const name of ['STG_SEP_LAMP_DURATION_SEC', 'stgSepLampTimer', 'isStgSepActive', 'TM_STG_SEP_ACTIVE', 'tmStgSepActive']) {
					assert.equal(src.includes(name), false, `${file}: ${name}`);
				}
			}
			const panelSrc = stripComments(SCRIPTS.find(([f]) => f === 'gravsim_telemetry_panel.js')[1]);
			assert.deepEqual(panelSrc.match(/target\.(maxFuel|presState)\b/g) ?? [], []);
		});
	});

	// ------------------------------------------------------------------
	// 3. Closing the Rocket tab with a rocket on the pad or a launch sequence running
	// ------------------------------------------------------------------
	describe('3. closing the Rocket tab with a rocket on the pad or a sequence running switches to real time and keeps the camera and zoom', () => {
		const REAL_TIME_SLIDER = Math.log10(REAL_TIME_YEARS_PER_S);
		const viewOf = (universe) => ({
			time: Number(el('time-scale').value),
			timeText: el('time-scale-indicator').textContent,
			timeScale: universe.timeScale,
			zoom: Number(el('zoom-scale').value),
			zoomExp: universe.camera.targetZoomExp,
			tracking: universe.camera.trackingTarget,
			offset: { ...universe.camera.targetOffset }
		});
		const setView = (universe, { time, zoom, target, offset = { x: 0, y: 0 } }) => {
			el('time-scale').value = String(time);
			el('time-scale').dispatchEvent({ type: 'input' });
			el('zoom-scale').value = String(zoom);
			el('zoom-scale').dispatchEvent({ type: 'input', target: { value: String(zoom) } });
			EventBus.emit('camera:set-tracking-target', target);
			universe.camera.setTargetOffset(offset.x, offset.y);
			return viewOf(universe);
		};
		/** Earth placed, a view set before the Rocket tab opens, the tab opened. */
		const openWithView = () => {
			const { universe, bridge } = newUniverse();
			const earth = withEarth(universe);
			const sun = universe.objects.find((o) => o.name === 'Sun');
			const before = setView(universe, { time: -3, zoom: 4.5, target: sun, offset: { x: 12, y: -7 } });
			openTab(universe, 'tab-rocket');
			return { universe, bridge, earth, sun, before, tab: universe.ControlPanel.rocketTab };
		};
		const isRealTime = (universe) => Math.abs(universe.timeScale / REAL_TIME_YEARS_PER_S - 1) < 1e-12;
		/** After the launch view nothing saved at open() is applied any more (a later restore changes nothing). */
		const assertNothingLeftToRestore = (universe, tab) => {
			const now = viewOf(universe);
			tab.restoreTimeScale();
			tab.restoreZoomScale();
			tab.restoreCameraTarget();
			assert.deepEqual(viewOf(universe), now, 'a later restore applies nothing');
		};

		it('input: real time is 1 s per s, the time-scale indicator reads it as "1.00 sec/sec", and it lies on the slider range', () => {
			assert.ok(REAL_TIME_SLIDER >= TIME_RANGE.min && REAL_TIME_SLIDER <= TIME_RANGE.max, `${REAL_TIME_SLIDER}`);
			assert.ok(Math.abs(REAL_TIME_SLIDER - TIME_RANGE.min) < TIME_RANGE.step, 'within one step of the minimum the tab uses');
		});

		it('normal: a rocket on the pad, auto tracking stopped by a pan: real time, the camera stays on the rocket, the zoom stays, nothing restored later', () => {
			const { universe, tab } = openWithView();
			const locks = record('ui:set-tabs-locked');
			universe.RocketLauncher.rollout();
			locks.stop();
			const rocket = rocketOf(universe);
			assert.ok(rocket && universe.RocketLauncher.rolloutedRocketId === rocket.id, 'rolled out');
			assert.equal(locks.at(-1), true, 'the tab buttons are locked: only a programmatic close() reaches this branch');
			assert.equal(universe.camera.trackingTarget, rocket, 'the rollout tracks the rocket');
			EventBus.emit('input:pan', 5, -3); // a pan stops the auto tracking
			assert.equal(universe.camera.autoTrackHost, null);
			const inTab = viewOf(universe);
			assert.equal(inTab.time, TIME_RANGE.min, 'the tab runs at the minimum time scale');

			const sets = record('ui:set-time-scale');
			tab.close();
			sets.stop();
			assert.equal(tab.isOpened, false);
			assert.equal(universe.isPaused, false, 'closing resumes the simulation');
			assert.deepEqual([...sets], [REAL_TIME_SLIDER], 'one switch to real time');
			const v = viewOf(universe);
			assert.ok(isRealTime(universe), `real time: ${v.timeScale}`);
			assert.equal(v.timeText, '1.00 sec/sec');
			assert.equal(v.tracking, rocket, 'the camera stays on the rocket');
			assert.deepEqual({ zoom: v.zoom, zoomExp: v.zoomExp, offset: v.offset }, { zoom: inTab.zoom, zoomExp: inTab.zoomExp, offset: inTab.offset }, 'the zoom and the offset stay');
			assertNothingLeftToRestore(universe, tab);
		});

		it('normal: a launch sequence running after the pad was released (liftoff): the same launch view', () => {
			const { universe, bridge, tab } = openWithView();
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const seq = universe.LaunchSequencer;
			seq.start({ events: [{ time: 0, command: 'RELEASE_HOLD_DOWN', name: 'LIFTOFF' }], tMinusOffset: 0 }, rocket.id);
			seq.update(0.01); // LIFTOFF: the pad is released, the sequence keeps running
			stepFrames(bridge, 1);
			assert.equal(universe.RocketLauncher.rolloutedRocketId, null, 'pad released');
			assert.equal(seq.isActive, true, 'sequence running');
			EventBus.emit('camera:stop-auto-tracking');
			EventBus.emit('ui:set-time-scale-min'); // something else than real time, so that the close must switch
			assert.equal(isRealTime(universe), false);
			const sets = record('ui:set-time-scale');
			tab.close();
			sets.stop();
			assert.deepEqual([...sets], [REAL_TIME_SLIDER]);
			assert.ok(isRealTime(universe));
			assert.equal(universe.camera.trackingTarget, rocket);
			assertNothingLeftToRestore(universe, tab);
		});

		it('normal: the ignite buttons apply the same launch view (real time, camera and zoom kept, nothing restored later)', () => {
			const { universe, tab } = openWithView();
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const inTab = viewOf(universe);
			const sets = record('ui:set-time-scale');
			tab.ui.rlIgniteQuickBtn.click();
			sets.stop();
			assert.ok(sets.length >= 1 && sets.every((v) => v === REAL_TIME_SLIDER), `real time requested: ${sets}`);
			assert.ok(isRealTime(universe));
			assert.equal(universe.camera.trackingTarget, rocket);
			assert.equal(universe.camera.targetZoomExp, inTab.zoomExp);
			assertNothingLeftToRestore(universe, tab);
		});

		it('abnormal: auto tracking still active takes the auto-tracking branch (no time-scale change, the camera fits the host); close() twice changes nothing', () => {
			const { universe, earth, tab } = openWithView();
			universe.RocketLauncher.rollout();
			assert.ok(universe.camera.autoTrackHost, 'auto tracking from the rollout');
			const sets = record('ui:set-time-scale');
			tab.close();
			assert.deepEqual([...sets], [], 'no time-scale change');
			assert.equal(universe.camera.autoTrackHost, null, 'auto tracking stopped');
			assert.equal(universe.camera.trackingTarget, earth, 'fitted to the host');
			const now = viewOf(universe);
			tab.close();
			sets.stop();
			assert.deepEqual(viewOf(universe), now);
			assert.deepEqual([...sets], []);
		});

		it('boundary: with the rollout aborted (no rocket on the pad, no sequence) closing restores the view from before the tab opened', () => {
			const { universe, before, tab } = openWithView();
			universe.RocketLauncher.rollout();
			universe.RocketLauncher.abortRollout();
			universe.ObjectManager.cleanupObjects();
			assert.equal(universe.RocketLauncher.rolloutedRocketId, null);
			assert.equal(universe.LaunchSequencer.isActive, false);
			const sets = record('ui:set-time-scale');
			tab.close();
			sets.stop();
			assert.deepEqual([...sets], [before.time], 'the time scale from before the tab opened');
			assert.deepEqual(viewOf(universe), before);
		});
	});

	// ------------------------------------------------------------------
	// 4. The camera target restored when the Rocket tab closes
	// ------------------------------------------------------------------
	describe('4. closing the Rocket tab restores the camera target only if that object is still in the universe', () => {
		/** A session with Earth and Sun, tracking `which` with an offset when the Rocket tab opens. */
		const session = (which = 'Sun', offset = { x: 12, y: -7 }) => {
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			const sun = universe.objects.find((o) => o.name === 'Sun');
			const target = which === 'Sun' ? sun : earth;
			EventBus.emit('camera:set-tracking-target', target);
			universe.camera.setTargetOffset(offset.x, offset.y);
			return { universe, earth, sun, target };
		};

		it('normal (real path): a save loaded while the tab is open: on close the camera stays on the loaded center object with the loaded offset', async () => {
			// The file: tracking Earth with an offset
			const A = session('Earth', { x: 3, y: 4 });
			const file = await saveToJson(A.universe);
			assert.equal(file.universe.centerObjectId, A.earth.id);
			assert.deepEqual(file.universe.cameraOffset, { x: 3, y: 4 });
			EventBus.clearAll();
			// Another session tracks its Sun when the tab opens, then loads the file while the tab is open
			const B = session('Sun');
			openTab(B.universe, 'tab-rocket');
			loadJson(B.universe, file);
			assert.equal(B.universe.objects.includes(B.sun), false, 'the Sun tracked before opening is replaced');
			openTab(B.universe, 'tab-sys');
			const cam = B.universe.camera;
			assert.ok(B.universe.objects.includes(cam.trackingTarget), 'the camera tracks an object of the universe');
			assert.equal(cam.trackingTarget.id, file.universe.centerObjectId);
			assert.equal(cam.trackingTarget.name, 'Earth');
			assert.deepEqual({ ...cam.targetOffset }, { x: 3, y: 4 }, 'the loaded offset, not the one saved at open()');
			assert.equal(B.universe.ControlPanel.rocketTab.previousCameraTarget, null);
		});

		it('normal (identity, not id): the id of the target saved at open() names another body in the loaded file; that body is not tracked', async () => {
			const B = session('Sun');
			const file = await saveToJson(B.universe);
			// In the file the ids of the Sun and the Earth are swapped; the file tracks its Sun
			const entries = file.universe.objectManager;
			const fSun = entries.find((o) => o.name === 'Sun');
			const fEarth = entries.find((o) => o.name === 'Earth');
			[fSun.id, fEarth.id] = [fEarth.id, fSun.id];
			file.universe.centerObjectId = fSun.id;
			file.universe.rocketLauncher.hostId = fEarth.id;
			assert.equal(fEarth.id, B.sun.id, 'input: the loaded Earth carries the id of the Sun tracked before opening');
			openTab(B.universe, 'tab-rocket');
			loadJson(B.universe, file);
			const loadedSun = B.universe.objects.find((o) => o.name === 'Sun');
			const loadedEarth = B.universe.objects.find((o) => o.name === 'Earth');
			assert.equal(loadedEarth.id, B.sun.id);
			openTab(B.universe, 'tab-sys');
			assert.equal(B.universe.camera.trackingTarget, loadedSun, 'the loaded center object');
			assert.notEqual(B.universe.camera.trackingTarget, loadedEarth, 'not the body that now carries the old id');
		});

		it('abnormal: the target removed while the tab is open is not restored; the camera stays on the host with the tab\'s offset', () => {
			const { universe, earth } = session('Earth');
			const mars = universe.ObjectPlacer.placeAtOrbitAroundSun('Mars') || universe.objects.find((o) => o.name === 'Mars');
			assert.ok(mars, 'Mars placed');
			EventBus.emit('camera:set-tracking-target', mars);
			universe.camera.setTargetOffset(50, 60);
			openTab(universe, 'tab-rocket');
			assert.equal(universe.camera.trackingTarget, earth, 'the tab tracks the host');
			universe.ObjectManager.removeObject(mars);
			universe.ObjectManager.cleanupObjects();
			assert.equal(universe.objects.includes(mars), false, 'Mars removed');
			const offsetInTab = { ...universe.camera.targetOffset };
			openTab(universe, 'tab-sys');
			assert.equal(universe.camera.trackingTarget, earth);
			assert.deepEqual({ ...universe.camera.targetOffset }, offsetInTab, 'the removed target\'s offset is not applied');
			const tab = universe.ControlPanel.rocketTab;
			assert.deepEqual([tab.previousCameraTarget, tab.previousCameraOffset], [null, null], 'dropped');
		});

		it('boundary: a target still in the universe is restored with its offset; no target saved restores nothing', () => {
			const { universe, sun } = session('Sun', { x: -9, y: 8 });
			openTab(universe, 'tab-rocket');
			openTab(universe, 'tab-sys');
			assert.equal(universe.camera.trackingTarget, sun);
			assert.deepEqual({ ...universe.camera.targetOffset }, { x: -9, y: 8 });
			const tab = universe.ControlPanel.rocketTab;
			const seen = record('camera:set-tracking-target');
			tab.previousCameraTarget = null;
			tab.previousCameraOffset = { x: 1, y: 1 };
			tab.restoreCameraTarget();
			seen.stop();
			assert.deepEqual([...seen], []);
			assert.equal(universe.camera.trackingTarget, sun);
		});
	});

	// ------------------------------------------------------------------
	// 5. The mission period
	// ------------------------------------------------------------------
	describe('5. a mission preset period is validated and clamped as a loaded one (the same code)', () => {
		const BASE_MISSION = preset('missions', 'leo_250km');
		/** Apply a temporary mission with `months` through PresetManager.applyToLauncher. */
		const withMission = (months, fn) => {
			const id = 'test_period_mission';
			presetManager.missions.set(id, { ...structuredClone(BASE_MISSION), id, predictionDurationMonths: months });
			try {
				return fn(id);
			} finally {
				presetManager.missions.delete(id);
			}
		};
		const periodOf = (rl) => ({ months: rl.predictionDurationMonths, sec: rl.maxSimTimeSec });

		it('normal (real path): each mission of presets/missions sets its period on the launcher and the System-tab slider and label', () => {
			assert.equal(MISSIONS.length, 7);
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			for (const m of MISSIONS) {
				assert.ok(m.predictionDurationMonths >= PRED_RANGE.min && m.predictionDurationMonths <= PRED_RANGE.max, `input: ${m.id} in range`);
				universe.ControlPanel.rocketTab.applyOrthogonalConfig({ missionId: m.id });
				assert.deepEqual(periodOf(rl), { months: m.predictionDurationMonths, sec: periodSec(m.predictionDurationMonths) }, m.id);
				assert.deepEqual([el('pred-duration').value, el('pred-duration-val').textContent], [String(m.predictionDurationMonths), predictionLabel(m.predictionDurationMonths)], m.id);
			}
		});

		it('abnormal: a mission without a valid period keeps the period in use (launcher, slider and label)', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			const tab = universe.ControlPanel.rocketTab;
			tab.applyOrthogonalConfig({ missionId: 'mars_transfer' });
			const inUse = periodOf(rl);
			assert.deepEqual(inUse, { months: 12, sec: periodSec(12) }, 'input: Mars transfer 12 months');
			for (const bad of [undefined, null, '', '12', '0.5', true, false, {}, [], [12], NaN, Infinity, -Infinity, 0, -0, -1, -1e-300, -36]) {
				withMission(bad, (id) => tab.applyOrthogonalConfig({ missionId: id }));
				assert.deepEqual(periodOf(rl), inUse, `${String(bad)}: launcher`);
				assert.deepEqual([el('pred-duration').value, el('pred-duration-val').textContent], ['12', predictionLabel(12)], `${String(bad)}: shown`);
				assert.equal(rl.currentMissionId, 'test_period_mission', `${String(bad)}: the rest of the mission is applied`);
			}
		});

		it('boundary: the slider ends and the year-format switch apply as is; beyond the range they are clamped to it', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			const { min, max } = PRED_RANGE;
			const cases = [[min, min], [max, max], [11.9, 11.9], [12, 12], [min - 1e-12, min], [max + 1e-12, max], [max - 1e-12, max - 1e-12],
				[0.1, min], [48, max], [1e9, max], [Number.MIN_VALUE, min], [Number.MAX_VALUE, max]];
			for (const [months, expected] of cases) {
				withMission(months, (id) => presetManager.applyToLauncher(rl, { missionId: id }));
				assert.deepEqual(periodOf(rl), { months: expected, sec: periodSec(expected) }, `mission ${months}`);
			}
		});

		it('the same rule as RocketLauncher.loadState for every value (one implementation)', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			const base = JSON.parse(JSON.stringify(rl.getState()));
			const values = [0.2, 36, 5, 0.1, 48, 1e9, Number.MIN_VALUE, 36 + 1e-12, NaN, null, '7', -3, 0, Infinity, true];
			for (const v of values) {
				rl.loadState({ ...base, predictionDurationMonths: 7 });
				rl.loadState({ ...base, predictionDurationMonths: v });
				const loaded = periodOf(rl);
				rl.loadState({ ...base, predictionDurationMonths: 7 });
				withMission(v, (id) => presetManager.applyToLauncher(rl, { missionId: id }));
				const mission = periodOf(rl);
				assert.ok(Object.is(mission.months, loaded.months) && Object.is(mission.sec, loaded.sec), `${String(v)}: ${JSON.stringify(mission)} vs ${JSON.stringify(loaded)}`);
				assert.equal(RocketLauncher.normalizePredictionDurationMonths(v), presetModule.normalizePredictionDurationMonths(v));
			}
		});
	});

	// ------------------------------------------------------------------
	// 6. The range constants
	// ------------------------------------------------------------------
	describe('6. the prediction-period range is TRAJECTORY_PREDICTION.MIN / MAX_DURATION_MONTHS, the #pred-duration slider range', () => {
		it('normal: the constants equal the index.html slider; the default is inside; both ends are on the step grid', () => {
			assert.deepEqual({ min: TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS, max: TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS }, { min: PRED_RANGE.min, max: PRED_RANGE.max });
			assert.equal(PRED_RANGE.value, TRAJECTORY_PREDICTION.DEFAULT_DURATION_MONTHS);
			const steps = (PRED_RANGE.max - PRED_RANGE.min) / PRED_RANGE.step;
			assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${steps} steps`);
		});

		it('abnormal: the launcher no longer exports its own range and no script writes the range as a literal', () => {
			assert.equal('PREDICTION_DURATION_RANGE_MONTHS' in launcherModule, false);
			for (const [file, src] of SCRIPTS) {
				assert.equal(src.includes('PREDICTION_DURATION_RANGE_MONTHS'), false, file);
			}
			const launcherSrc = SCRIPTS.find(([f]) => f === 'gravsim_rocket_launcher.js')[1];
			const presetSrc = SCRIPTS.find(([f]) => f === 'gravsim_preset_manager.js')[1];
			for (const src of [launcherSrc, presetSrc]) {
				assert.equal(/max\s*:\s*36\b|,\s*36\s*\)/.test(src), false, 'no literal 36 for the range');
			}
		});

		it('boundary: the clamp reads the constants (a changed maximum or minimum moves both the load and the mission clamp)', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			const base = JSON.parse(JSON.stringify(rl.getState()));
			const orig = { min: TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS, max: TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS };
			try {
				TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS = 24;
				TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS = 0.5;
				rl.loadState({ ...base, predictionDurationMonths: 30 });
				assert.equal(rl.predictionDurationMonths, 24);
				rl.loadState({ ...base, predictionDurationMonths: 0.3 });
				assert.equal(rl.predictionDurationMonths, 0.5);
				const id = 'test_range_mission';
				presetManager.missions.set(id, { ...structuredClone(preset('missions', 'leo_250km')), id, predictionDurationMonths: 36 });
				try {
					presetManager.applyToLauncher(rl, { missionId: id });
				} finally {
					presetManager.missions.delete(id);
				}
				assert.equal(rl.predictionDurationMonths, 24);
				assert.equal(rl.maxSimTimeSec, periodSec(24));
			} finally {
				TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS = orig.max;
				TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS = orig.min;
			}
		});
	});
});
