/**
 * Regression Suite 12: the pre-existing UI / main-thread defects of design §4.13 that were brought into scope
 * (test plan §4.6). All of them also occurred on main.
 *
 *  1. Time scale and zoom are restored on load. ControlPanel.getState() nests the System-tab state
 *     ({ controlPanel: { timeScaleVal, zoomScaleVal } }); saves written before the tab split (git 53d6e87..0adb139,
 *     also `version: 2`) keep the two values at the top level. Both shapes load; only finite numbers are applied, clamped
 *     to the slider range (index.html). While the Rocket tab is open it keeps its minimum time scale and its zoom, and the
 *     loaded values become the values it restores when it closes.
 *  2. Applying a mission / vehicle / payload in the Rocket tab shows the launcher's prediction period on the System-tab
 *     slider and label (display only; the launcher value is not re-applied).
 *  3. After the payload separation the STAGE line reads "PAYLOAD (<payload name>)" (the Worker sets the stage index to
 *     the stage count, one past the last stage) and the propulsion card shows the payload's own tanks.
 *  4. A rocket shows the FlightComputer's initial status PRE_LAUNCH until the first Worker frame (none arrives while the
 *     Rocket tab pauses the simulation); the FlightComputer never reports LIFTOFF (0).
 *  5. Rocket.mass is the sum of the attached parts over the separation state the object holds and saves, the same sum as
 *     the Worker's CalcRocket.updateTotalMass(): payload + fairing (unless fairing.isSeparated) + current stage + upper
 *     stages; after the payload separation the payload alone (dry + propellant when self-propelled).
 *
 * Expected values: slider ranges from index.html, prediction periods from presets/missions (inputs), the label format
 * rule of the prediction slider, masses as sums of the preset part masses, and the Worker's own mass (the physics) on the
 * real save -> load path. Nothing is copied from the output of the code under test.
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
import { ControlPanel } from '../../scripts/gravsim_control_panel.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { PropulsionCard } from '../../scripts/gravsim_telemetry_card.js';
import { RocketStackUtils } from '../../scripts/gravsim_utils.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { Rocket } from '../../scripts/gravsim_object.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { OBJECT_TYPES, TELEMETRY } from '../../scripts/gravsim_const.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
	el('pred-duration-val').textContent = '';
	el('time-scale-indicator').textContent = '';
	el('zoom-scale-indicator').textContent = '';
};

// Prediction-slider label rule (SystemTab): below 12 months "<m> mo (<round(m * 365.25 / 12)> d)", else "<m / 12 to 1 decimal> yr (<m> mo)"
const MISSION_MONTHS = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'presets', 'missions'))
	.filter((f) => f !== 'manifest.json' && f.endsWith('.json'))
	.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'missions', f), 'utf8')))
	.map((m) => [m.id, m.predictionDurationMonths]));
const EXPECTED_LABEL = {
	0.2: '0.2 mo (6 d)', // 0.2 x 30.4375 = 6.09 d
	0.3: '0.3 mo (9 d)', // 9.13 d
	0.5: '0.5 mo (15 d)', // 15.22 d
	1: '1 mo (30 d)', // 30.44 d
	11.9: '11.9 mo (362 d)', // 362.21 d, the last value below the year format
	12: '1.0 yr (12 mo)',
	36: '3.0 yr (36 mo)',
	48: '4.0 yr (48 mo)'
};

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous)
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
	// The trajectory prediction is not under test here: skip it (it is synchronous in rollout() / RocketTab.open() and
	// debounced on every configuration change, and would only add run time)
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
/** Slider positions (as numbers: the browser holds strings, the mock holds what was assigned) and the applied values. */
const viewOf = (universe) => ({
	time: Number(el('time-scale').value),
	timeScale: universe.timeScale,
	zoom: Number(el('zoom-scale').value),
	zoomExp: universe.camera.targetZoomExp
});

/** Rollout through the real RocketLauncher, then the LEGACY_QUICK command order of LaunchSequencer.executeCommand. */
const rolloutAndLaunch = (universe, bridge, { vehicleId, payloadId, missionId }) => {
	const earth = withEarth(universe);
	const launcher = universe.RocketLauncher;
	launcher.hostId = earth.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	launcher.rollout();
	const rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
	return rocket;
};
const workerObj = (bridge, id) => bridge.ctrl.engine.objects.find((o) => o.id === id);

/** Sum of the attached parts of a saved ROCKET entry (masses in t). */
const attachedMassOf = (entry) => {
	if (entry.isPayloadSeparated) {
		const selfPropelled = entry.hasPayloadPropulsion || Boolean(entry.payload?.propulsion?.enabled);
		return selfPropelled ? entry.dryMass + entry.fuelMass + entry.oxidMass : entry.payload.massT;
	}
	let m = entry.payload.massT;
	if (entry.fairing?.enabled && !entry.fairing.isSeparated) { m += entry.fairing.massT; }
	m += entry.dryMass + entry.fuelMass + entry.oxidMass;
	for (let i = entry.currentStageIndex + 1; i < entry.stages.length; i++) {
		const s = entry.stages[i];
		m += s.dryMassT + s.fuelMassT + s.oxidMassT;
	}
	return m;
};

describe('Regression 12: pre-existing UI / main-thread fixes (design §4.13, test plan §4.6)', () => {
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
	// 1. Time scale and zoom on load
	// ------------------------------------------------------------------
	describe('1. time scale and zoom are restored on load', () => {
		it('normal: Save State -> Load State restores the time-scale slider, its indicator, the simulation time scale and the zoom', async () => {
			const { universe } = newUniverse();
			withEarth(universe);
			// Distinct on-grid values set through the sliders' own handlers
			el('time-scale').value = '-3.2';
			el('time-scale').dispatchEvent({ type: 'input' });
			el('zoom-scale').value = '4.5';
			el('zoom-scale').dispatchEvent({ type: 'input', target: { value: '4.5' } });
			const indicator = el('time-scale-indicator').textContent;
			const zoomIndicator = el('zoom-scale-indicator').textContent;
			const save = await saveToJson(universe);
			// The saved shape is unchanged (nested under controlPanel)
			assert.deepEqual(save.universe.controlPanel, { controlPanel: { timeScaleVal: -3.2, zoomScaleVal: 4.5 } });

			el('time-scale').value = '-6';
			el('time-scale').dispatchEvent({ type: 'input' });
			el('zoom-scale').value = '1';
			el('zoom-scale').dispatchEvent({ type: 'input', target: { value: '1' } });
			assert.equal(universe.timeScale, Math.pow(10, -6));

			loadJson(universe, save);
			assert.deepEqual(viewOf(universe), { time: -3.2, timeScale: Math.pow(10, -3.2), zoom: 4.5, zoomExp: 4.5 });
			assert.equal(el('time-scale-indicator').textContent, indicator, 'the time-scale indicator shows the loaded value');
			assert.equal(el('zoom-scale-indicator').textContent, zoomIndicator, 'the zoom indicator shows the loaded value');
		});

		it('normal: a save written before the tab split (flat { timeScaleVal, zoomScaleVal }) still loads', () => {
			const { universe } = newUniverse();
			universe.loadState({ controlPanel: { timeScaleVal: -2.5, zoomScaleVal: 3 } });
			assert.deepEqual(viewOf(universe), { time: -2.5, timeScale: Math.pow(10, -2.5), zoom: 3, zoomExp: 3 });
		});

		it('normal: resolveSystemTabState picks the nested object, else the flat one, else nothing', () => {
			const nested = { timeScaleVal: -1, zoomScaleVal: 2 };
			assert.equal(ControlPanel.resolveSystemTabState({ controlPanel: nested }), nested);
			const flat = { timeScaleVal: -4, zoomScaleVal: 1 };
			assert.equal(ControlPanel.resolveSystemTabState(flat), flat);
			// A nested value that is not an object falls back to the entry itself (which then has no values)
			for (const bad of [null, [], 'x', 3]) {
				const entry = { controlPanel: bad };
				assert.equal(ControlPanel.resolveSystemTabState(entry), entry, `controlPanel: ${JSON.stringify(bad)}`);
			}
			for (const bad of [null, undefined, 'cp', 7, true, [1, 2]]) {
				assert.equal(ControlPanel.resolveSystemTabState(bad), null, `entry ${JSON.stringify(bad)}`);
			}
		});

		it('abnormal: non-finite or non-number values keep the current value and do not block the other one', () => {
			const { universe } = newUniverse();
			for (const bad of [null, 'abc', '-2', true, [], {}, undefined]) {
				el('time-scale').value = '-1';
				universe.timeScale = 0.1;
				el('zoom-scale').value = '0';
				universe.camera.targetZoomExp = 0;
				universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: bad, zoomScaleVal: 2.5 } } });
				assert.deepEqual(viewOf(universe), { time: -1, timeScale: 0.1, zoom: 2.5, zoomExp: 2.5 }, `timeScaleVal ${JSON.stringify(bad)}`);
				universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: -2, zoomScaleVal: bad } } });
				assert.deepEqual(viewOf(universe), { time: -2, timeScale: Math.pow(10, -2), zoom: 2.5, zoomExp: 2.5 }, `zoomScaleVal ${JSON.stringify(bad)}`);
			}
			// NaN / Infinity cannot come from JSON (they serialize as null) but are rejected too
			for (const bad of [NaN, Infinity, -Infinity]) {
				universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: bad, zoomScaleVal: bad } }, null);
				assert.deepEqual(viewOf(universe), { time: -2, timeScale: Math.pow(10, -2), zoom: 2.5, zoomExp: 2.5 }, String(bad));
			}
		});

		it('abnormal: a controlPanel entry that is not an object changes nothing and the Rocket-tab state still loads', () => {
			const { universe } = newUniverse();
			el('time-scale').value = '-1';
			universe.timeScale = 0.1;
			for (const bad of ['cp', 42, true, [1]]) {
				assert.doesNotThrow(() => universe.loadState({ controlPanel: bad, rocketLauncher: { hostAngleDeg: 30 } }));
				assert.deepEqual(viewOf(universe), { time: -1, timeScale: 0.1, zoom: ZOOM_RANGE.value, zoomExp: universe.camera.targetZoomExp });
				assert.equal(el('rl-host-angle').value, 30, `${JSON.stringify(bad)}: the Rocket tab state is still applied`);
				el('rl-host-angle').value = 0;
			}
		});

		it('boundary: values at the slider bounds are applied as saved; values beyond them are clamped to the bounds', () => {
			const { universe } = newUniverse();
			const cases = [
				[TIME_RANGE.min, ZOOM_RANGE.min, TIME_RANGE.min, ZOOM_RANGE.min],
				[TIME_RANGE.max, ZOOM_RANGE.max, TIME_RANGE.max, ZOOM_RANGE.max],
				[TIME_RANGE.min - 0.1, ZOOM_RANGE.min - 0.05, TIME_RANGE.min, ZOOM_RANGE.min],
				[TIME_RANGE.max + 0.1, ZOOM_RANGE.max + 0.05, TIME_RANGE.max, ZOOM_RANGE.max],
				[1e9, -1e9, TIME_RANGE.max, ZOOM_RANGE.min],
				[0, 0, 0, 0]
			];
			for (const [t, z, et, ez] of cases) {
				universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: t, zoomScaleVal: z } } });
				assert.deepEqual(viewOf(universe), { time: et, timeScale: Math.pow(10, et), zoom: ez, zoomExp: ez }, `saved ${t} / ${z}`);
			}
		});

		it('Rocket-tab rule: a load while the Rocket tab is open keeps its minimum time scale; closing the tab applies the loaded view', () => {
			const { universe } = newUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			assert.equal(universe.ControlPanel.rocketTab.isOpened, true);
			assert.equal(Number(el('time-scale').value), TIME_RANGE.min, 'the Rocket tab sets the minimum time scale');
			const tabZoom = universe.camera.targetZoomExp;
			const tabZoomSlider = Number(el('zoom-scale').value);

			universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: -2.2, zoomScaleVal: 5.5 } } });
			assert.deepEqual(viewOf(universe), { time: TIME_RANGE.min, timeScale: Math.pow(10, TIME_RANGE.min), zoom: tabZoomSlider, zoomExp: tabZoom },
				'while the Rocket tab is open its minimum time scale and its zoom stay');

			openTab(universe, 'tab-sys');
			assert.equal(universe.ControlPanel.rocketTab.isOpened, false);
			assert.equal(Number(el('time-scale').value), -2.2, 'closing the tab applies the loaded time scale');
			assert.equal(universe.timeScale, Math.pow(10, -2.2));
			assert.equal(universe.camera.targetZoomExp, 5.5, 'closing the tab applies the loaded zoom');

			// The rule itself is unchanged: opening the tab again sets the minimum
			openTab(universe, 'tab-rocket');
			assert.equal(Number(el('time-scale').value), TIME_RANGE.min);
			assert.equal(universe.timeScale, Math.pow(10, TIME_RANGE.min));
		});

		it('Rocket-tab rule (abnormal): an invalid loaded value while the tab is open leaves the value restored on close unchanged', () => {
			const { universe } = newUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			const tab = universe.ControlPanel.rocketTab;
			const before = { t: tab.previousTimeScaleVal, z: tab.previousZoomScaleVal };
			universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: 'fast', zoomScaleVal: null } } });
			assert.deepEqual({ t: tab.previousTimeScaleVal, z: tab.previousZoomScaleVal }, before);
			// Out-of-range values are deferred clamped, like an immediate load
			universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: 99, zoomScaleVal: -99 } } });
			assert.deepEqual({ t: tab.previousTimeScaleVal, z: tab.previousZoomScaleVal }, { t: TIME_RANGE.max, z: ZOOM_RANGE.min });
			assert.equal(Number(el('time-scale').value), TIME_RANGE.min, 'still the minimum while open');
		});
	});

	// ------------------------------------------------------------------
	// 2. Prediction period on mission change
	// ------------------------------------------------------------------
	describe('2. the prediction-period slider follows the mission', () => {
		it('normal: choosing each mission in the Rocket tab shows its prediction period on the slider and the label', () => {
			const { universe } = newUniverse();
			withEarth(universe);
			const tab = universe.ControlPanel.rocketTab;
			assert.equal(Object.keys(MISSION_MONTHS).length, 7, 'seven missions');
			for (const [id, months] of Object.entries(MISSION_MONTHS)) {
				tab.ui.rlMissionSelect.value = id;
				tab.ui.rlMissionSelect.dispatchEvent({ type: 'change', target: { value: id } });
				assert.equal(universe.RocketLauncher.currentMissionId, id);
				assert.equal(universe.RocketLauncher.predictionDurationMonths, months, `${id}: the launcher uses the mission period`);
				assert.equal(universe.RocketLauncher.maxSimTimeSec, months * (365.25 / 12) * 86400);
				assert.equal(el('pred-duration').value, String(months), `${id}: slider`);
				assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[months], `${id}: label`);
			}
		});

		it('normal: a payload change (its recommended mission) and a vehicle change also sync the slider', () => {
			const { universe } = newUniverse();
			withEarth(universe);
			const tab = universe.ControlPanel.rocketTab;
			tab.ui.rlPayloadSelect.dispatchEvent({ type: 'change', target: { value: 'mmx' } });
			assert.equal(universe.RocketLauncher.currentMissionId, presetManager.getRecommendedMissionForPayload('mmx'));
			const months = MISSION_MONTHS[universe.RocketLauncher.currentMissionId];
			assert.equal(el('pred-duration').value, String(months));
			assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[months]);

			// A manual slider value is replaced by the mission's period when the vehicle is re-applied (applyToLauncher)
			el('pred-duration').value = '5';
			el('pred-duration').dispatchEvent({ type: 'input', target: { value: '5' } });
			assert.equal(universe.RocketLauncher.predictionDurationMonths, 5);
			assert.equal(el('pred-duration-val').textContent, '5 mo (152 d)'); // 5 x 30.4375 = 152.19 d
			tab.ui.rlVehicleSelect.dispatchEvent({ type: 'change', target: { value: 'falcon9' } });
			assert.equal(universe.RocketLauncher.predictionDurationMonths, months);
			assert.equal(el('pred-duration').value, String(months));
			assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[months]);
		});

		it('abnormal: invalid periods sent to the System tab leave the slider and the label unchanged', () => {
			const { universe } = newUniverse();
			universe.ControlPanel.systemTab.syncPredictionDuration(0.5);
			for (const bad of [NaN, Infinity, -Infinity, -1, 0, '12', null, true, {}]) {
				EventBus.emit('ui:sync-prediction-duration', bad);
				assert.equal(el('pred-duration').value, '0.5', `${String(bad)}: slider`);
				assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[0.5], `${String(bad)}: label`);
			}
			// No value: the launcher's period in use
			universe.RocketLauncher.predictionDurationMonths = 12;
			EventBus.emit('ui:sync-prediction-duration');
			assert.equal(el('pred-duration').value, '12');
			assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[12]);
		});

		it('boundary: the range ends, the year-format switch at 12 months, and a period beyond the slider range (display only)', () => {
			const { universe } = newUniverse();
			const sys = universe.ControlPanel.systemTab;
			for (const m of [PRED_RANGE.min, 11.9, 12, PRED_RANGE.max]) {
				sys.syncPredictionDuration(m);
				assert.equal(el('pred-duration').value, String(m));
				assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[m], `${m} months`);
			}
			// Beyond the slider: the slider stops at its end, the label shows the period in use, the launcher is not changed
			universe.RocketLauncher.predictionDurationMonths = 48;
			sys.syncPredictionDuration();
			assert.equal(el('pred-duration').value, String(PRED_RANGE.max));
			assert.equal(el('pred-duration-val').textContent, EXPECTED_LABEL[48]);
			assert.equal(universe.RocketLauncher.predictionDurationMonths, 48);
			sys.syncPredictionDuration(0.1);
			assert.equal(el('pred-duration').value, String(PRED_RANGE.min));
			assert.equal(el('pred-duration-val').textContent, '0.1 mo (3 d)'); // 3.04 d
		});
	});

	// ------------------------------------------------------------------
	// 3. Stage label after the payload separation
	// ------------------------------------------------------------------
	describe('3. the STAGE line after the payload separation', () => {
		const stages2 = [{ name: '1st Stage (Booster)' }, { name: '2nd Stage (Upper)' }];
		const stages3 = [{ name: 'S1' }, { name: 'S2' }, { name: 'S3' }];
		const label = (over, tm = {}) => TelemetryPanel.formatStageInfo({ stages: stages2, payload: { name: 'HTV-X' }, ...over }, tm);

		it('normal: stages count "N / M (name)", and after the separation the payload shows "PAYLOAD (name)" (2-, 3- and 1-stage)', () => {
			assert.equal(label({}, { stageIndex: 0, totalStages: 2 }), '1 / 2 (1st Stage (Booster))');
			assert.equal(label({}, { stageIndex: 1, totalStages: 2 }), '2 / 2 (2nd Stage (Upper))');
			assert.equal(label({ isPayloadSeparated: true }, { stageIndex: 2, totalStages: 2, isPayloadSeparated: true }), 'PAYLOAD (HTV-X)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages: stages3, payload: { name: 'ASNARO-2' } }, { stageIndex: 2, totalStages: 3 }), '3 / 3 (S3)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages: stages3, payload: { name: 'ASNARO-2' }, isPayloadSeparated: true }, { stageIndex: 3, totalStages: 3 }), 'PAYLOAD (ASNARO-2)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages: [{ name: 'Core Stage' }], payload: { name: 'P' }, isPayloadSeparated: true }, { stageIndex: 1, totalStages: 1 }), 'PAYLOAD (P)');
		});

		it('normal: a real flight (Worker) never shows a stage number above the stage count and ends with "PAYLOAD (<name>)"', () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const panel = universe.TelemetryPanel;
			panel.open();
			const seen = new Set();
			const separated = stepFrames(bridge, 1500, () => {
				panel.update();
				seen.add(el('tm-stage-info').textContent);
				return rocket.isPayloadSeparated;
			});
			assert.equal(separated, true, 'the payload separated');
			panel.update();
			assert.equal(rocket.currentStageIndex, 2, 'the Worker reports the stage count as the index');
			assert.equal(el('tm-stage-info').textContent, `PAYLOAD (${rocket.payload.name})`);
			const counters = [...seen].map((t) => t.match(/^(\d+) \/ (\d+) /)).filter(Boolean);
			assert.ok(counters.length > 0);
			assert.ok(counters.every(([, n, m]) => Number(n) <= Number(m)), `no stage number above the count: ${[...seen]}`);
			assert.deepEqual([...new Set(counters.map(([, n, m]) => `${n}/${m}`))], ['1/2', '2/2']);
		});

		it('abnormal: no payload name, inconsistent flags or an index beyond the count still read as the payload phase', () => {
			assert.equal(label({ payload: { massT: 1 }, isPayloadSeparated: true }, { stageIndex: 2, totalStages: 2 }), 'PAYLOAD');
			assert.equal(label({ payload: null }, { stageIndex: 2, totalStages: 2 }), 'PAYLOAD');
			assert.equal(label({ payload: { name: '' } }, { stageIndex: 2, totalStages: 2 }), 'PAYLOAD');
			// Separated flag with a stale index (corrupted save, or only the telemetry flag)
			assert.equal(label({ isPayloadSeparated: true }, { stageIndex: 1, totalStages: 2 }), 'PAYLOAD (HTV-X)');
			assert.equal(label({}, { stageIndex: 1, totalStages: 2, isPayloadSeparated: true }), 'PAYLOAD (HTV-X)');
			assert.equal(label({}, { stageIndex: 5, totalStages: 2 }), 'PAYLOAD (HTV-X)');
			// No telemetry index yet: the object's index is used
			assert.equal(label({ currentStageIndex: 2 }, {}), 'PAYLOAD (HTV-X)');
			assert.equal(label({ currentStageIndex: 1 }, {}), '2 / 2 (2nd Stage (Upper))');
			// The HUD's payload-phase rule is RocketStackUtils.resolveStackState (design 2026-11-23 §3.1, which replaced
			// isPayloadPhase): a missing rocket or telemetry does not throw and reads as the default stack state (stage 0 of
			// 1, no fairing)
			const defaults = { curStgIdx: 0, totalStg: 1, isPayloadOnly: false, hasFairing: false };
			assert.deepEqual(RocketStackUtils.resolveStackState(null, null), defaults);
			assert.deepEqual(RocketStackUtils.resolveStackState(undefined, undefined), defaults);
			// Index = count is the payload phase for a rocket with stages; the rule adds the renderer's `stages &&` term, so
			// the index alone (no rocket object) stays a stack (design §3.1: no production caller passes one without stages)
			assert.equal(RocketStackUtils.resolveStackState({ stages: [{}] }, { stageIndex: 1, totalStages: 1 }).isPayloadOnly, true);
			assert.equal(RocketStackUtils.resolveStackState({ stages: [{}] }, { stageIndex: 0, totalStages: 1 }).isPayloadOnly, false);
			// (the index is a whole number in [0, count] and, out of the payload phase, at most the last stage: design §3.1 Rev 22)
			assert.deepEqual(RocketStackUtils.resolveStackState(undefined, { stageIndex: 1, totalStages: 1 }),
				{ curStgIdx: 0, totalStg: 1, isPayloadOnly: false, hasFairing: false });
			// The separated flag of either source is the payload phase whatever the index
			assert.equal(RocketStackUtils.resolveStackState(undefined, { stageIndex: 0, totalStages: 1, isPayloadSeparated: true }).isPayloadOnly, true);
		});

		it('boundary: last stage index -> stage label, index = count -> payload; SRB tags stay on the first stage only', () => {
			const boosters = { count: 2, burnTimeSec: 105 };
			assert.equal(label({ boosters }, { stageIndex: 0, totalStages: 2 }), '1 / 2 (1st Stage (Booster)) [+SRB]');
			assert.equal(label({ boosters }, { stageIndex: 0, totalStages: 2, isBoosterBurnout: true }), '1 / 2 (1st Stage (Booster)) [SRB BURNOUT]');
			assert.equal(label({ boosters }, { stageIndex: 0, totalStages: 2, isBoosterSeparated: true }), '1 / 2 (1st Stage (Booster)) [SRB SEP]');
			assert.equal(label({ boosters }, { stageIndex: 1, totalStages: 2 }), '2 / 2 (2nd Stage (Upper))');
			assert.equal(label({ boosters }, { stageIndex: 2, totalStages: 2, isBoosterSeparated: true }), 'PAYLOAD (HTV-X)');
			// Unnamed stages keep the role fallbacks
			assert.equal(TelemetryPanel.formatStageInfo({ stages: [{}, {}] }, { stageIndex: 1, totalStages: 2 }), '2 / 2 (UPPER)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages: [{}, {}] }, { stageIndex: 0, totalStages: 2 }), '1 / 2 (BOOSTER)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages: [{}] }, { stageIndex: 0, totalStages: 1 }), '1 / 1 (CORE)');
		});

		it('propulsion card: the header names the payload and the bars use the payload tanks (self-propelled) or show empty (passive)', () => {
			const card = new PropulsionCard(3, 'Propulsion', createMockElement('div'));
			card.initElements();
			const prop = { enabled: true, fuelMassT: 0.8, oxidMassT: 1.4 };
			const base = { id: 7, stages: [{ name: 'S1', fuelMassT: 100, oxidMassT: 200 }, { name: 'S2', fuelMassT: 20, oxidMassT: 40 }], thrustRatio: 0, burnTime: 100 };
			card.update({ ...base, currentStageIndex: 1, fuelMass: 10, oxidMass: 20, stageState: 'STG_BURNING' }, { stageIndex: 1, totalStages: 2 });
			assert.equal(card.ui.header.textContent, '[ PROPULSION: S2 ]');
			// Self-propelled payload with full tanks: 100 % of its own propellant
			const payloadRocket = { ...base, currentStageIndex: 2, isPayloadSeparated: true, payload: { name: 'MMX', propulsion: prop }, fuelMass: 0.8, oxidMass: 1.4, stageState: 'STG_COAST' };
			card.update(payloadRocket, { stageIndex: 2, totalStages: 2, isPayloadSeparated: true });
			assert.equal(card.ui.header.textContent, '[ PROPULSION: PAYLOAD ]');
			assert.equal(card.maxFuel[7], 0.8);
			assert.equal(card.maxOxid[7], 1.4);
			assert.equal(card.ui.fuelBar.style.width, '100%');
			// Half burnt
			card.update({ ...payloadRocket, fuelMass: 0.4, oxidMass: 0.7 }, { stageIndex: 2, totalStages: 2, isPayloadSeparated: true });
			assert.equal(card.ui.fuelBar.style.width, '50%');
			// Passive payload: no tanks
			const passive = new PropulsionCard(3, 'Propulsion', createMockElement('div'));
			passive.initElements();
			passive.update({ ...base, id: 8, currentStageIndex: 1, fuelMass: 10, oxidMass: 20, stageState: 'STG_BURNING' }, { stageIndex: 1, totalStages: 2 });
			passive.update({ ...base, id: 8, currentStageIndex: 2, isPayloadSeparated: true, payload: { name: 'SAT', propulsion: null }, fuelMass: 0, oxidMass: 0, burnTime: 0, stageState: 'ORBITAL_COAST' },
				{ stageIndex: 2, totalStages: 2, isPayloadSeparated: true });
			assert.equal(passive.ui.header.textContent, '[ PROPULSION: PAYLOAD ]');
			assert.equal(passive.maxFuel[8], 0);
			assert.equal(passive.ui.fuelBar.style.width, '0%');
		});
	});

	// ------------------------------------------------------------------
	// 4. Pre-launch status on the pad
	// ------------------------------------------------------------------
	describe('4. the HUD shows PRE-LAUNCH on the pad', () => {
		const LAUNCH_LAMPS = ['twr', 'pitch', 'orbit', '1eng', 'meco', '1sep', '2eng', 'seco', '2sep', 'psep'];
		const litLamps = (panel) => Object.entries(panel.lamps).filter(([, l]) => l.classList.contains('on')).map(([k]) => k);

		it('normal: a rocket rolled out while the Rocket tab pauses the simulation reads PRE-LAUNCH with no launch lamp lit', () => {
			const { universe } = newUniverse();
			withEarth(universe);
			openTab(universe, 'tab-rocket');
			assert.equal(universe.isPaused, true, 'the Rocket tab pauses the simulation');
			universe.RocketLauncher.rollout();
			const rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.equal(rocket.isHoldDown, true);
			assert.equal(rocket.telemetry.status, TELEMETRY.STATUS.PRE_LAUNCH);
			const panel = universe.TelemetryPanel;
			assert.equal(panel.isOpen, true, 'the rollout opens the HUD');
			panel.update();
			assert.equal(el('tm-mission-status').textContent, 'PRE-LAUNCH');
			assert.deepEqual(litLamps(panel).filter((k) => LAUNCH_LAMPS.includes(k)), [], 'no launch lamp on the pad');
			panel.close();
			panel.update();
			assert.equal(el('m-hud-stat').textContent, 'PRE-LAUNCH', 'the minimal HUD reads PRE-LAUNCH too');
		});

		it('normal: the Worker status replaces the placeholder (PRE-LAUNCH in hold-down, ASCENT after the release)', () => {
			const { universe, bridge } = newUniverse();
			const rocket = rolloutAndLaunch(universe, bridge, { vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const panel = universe.TelemetryPanel;
			panel.open();
			stepFrames(bridge, 3);
			panel.update();
			assert.equal(rocket.telemetry.status, TELEMETRY.STATUS.ASCENT);
			assert.equal(el('tm-mission-status').textContent, 'ASCENT');
		});

		it('normal: with the auto sequence running the pad reads AUTO-SEQUENCE / AUTO-SEQ before the first Worker frame', () => {
			const { universe } = newUniverse();
			universe.RocketLauncher.hostId = withEarth(universe).id;
			EventBus.emit('simulation:pause');
			universe.RocketLauncher.rollout();
			assert.ok(universe.objects.some((o) => o.type === OBJECT_TYPES.ROCKET), 'rolled out');
			universe.LaunchSequencer.isAutoSequence = true;
			const panel = universe.TelemetryPanel;
			panel.open();
			panel.update();
			assert.equal(el('tm-mission-status').textContent, 'AUTO-SEQUENCE');
			panel.close();
			panel.update();
			assert.equal(el('m-hud-stat').textContent, 'AUTO-SEQ');
		});

		it('boundary: the placeholder equals the FlightComputer initial status, which is never LIFTOFF', () => {
			const fcInitial = new FlightComputer({}).getTelemetry().status;
			assert.equal(fcInitial, TELEMETRY.STATUS.PRE_LAUNCH);
			const r = new Rocket(1, 'Rocket', 0, 0, 0, 0, 1, 1, 1, '#fff', 1, 1, 0, null, 0);
			assert.equal(r.telemetry.status, fcInitial);
			assert.notEqual(r.telemetry.status, TELEMETRY.STATUS.LIFTOFF);
			assert.equal(TELEMETRY.STATUS_MAP[r.telemetry.status], 'PRE-LAUNCH');
		});
	});

	// ------------------------------------------------------------------
	// 5. Mass recompute
	// ------------------------------------------------------------------
	describe('5. Rocket.mass sums the attached parts from the object state', () => {
		const STAGES = [
			{ dryMassT: 20, fuelMassT: 100, oxidMassT: 200 },
			{ dryMassT: 4, fuelMassT: 10, oxidMassT: 20 },
			{ dryMassT: 1, fuelMassT: 2, oxidMassT: 3 }
		];
		const make = (over = {}) => {
			const r = new Rocket(1, 'Rocket', 0, 0, 0, 0, 20, 100, 200, '#fff', 1, 1, 0, null, 0);
			r.stages = JSON.parse(JSON.stringify(STAGES));
			r.payload = { name: 'SAT', massT: 5 };
			r.fairing = { enabled: true, massT: 2 };
			return Object.assign(r, over);
		};

		it('normal: each separation state (stages, fairing, payload passive / self-propelled)', () => {
			// Pad: payload 5 + fairing 2 + stage 1 (320) + stages 2 and 3 (34 + 6)
			assert.equal(make().mass, 5 + 2 + 320 + 34 + 6);
			// Stage 2 active, fairing attached: dry/fuel/oxid are the Worker's current-stage values
			assert.equal(make({ currentStageIndex: 1, dryMass: 4, fuelMass: 5, oxidMass: 10 }).mass, 5 + 2 + 19 + 6);
			// Fairing jettisoned (object state, as saved)
			assert.equal(make({ currentStageIndex: 1, dryMass: 4, fuelMass: 5, oxidMass: 10, fairing: { enabled: true, massT: 2, isSeparated: true } }).mass, 5 + 19 + 6);
			// Last stage
			assert.equal(make({ currentStageIndex: 2, dryMass: 1, fuelMass: 2, oxidMass: 3, fairing: { enabled: true, massT: 2, isSeparated: true } }).mass, 5 + 6);
			// Payload separated, passive: the payload alone (dry mass 0 after the separation)
			assert.equal(make({ currentStageIndex: 3, isPayloadSeparated: true, dryMass: 0, fuelMass: 0, oxidMass: 0 }).mass, 5);
			// Payload separated, self-propelled: its dry mass and propellant (payload.massT is their sum before the burn)
			const prop = { enabled: true, dryMassT: 1.8, fuelMassT: 0.8, oxidMassT: 1.4 };
			assert.equal(make({ currentStageIndex: 3, isPayloadSeparated: true, hasPayloadPropulsion: true, payload: { massT: 4, propulsion: prop }, dryMass: 1.8, fuelMass: 0.8, oxidMass: 1.4 }).mass, 1.8 + 0.8 + 1.4);
			// SRB separated on stage 1: the Worker's dry mass already excludes the SRB dry mass
			assert.equal(make({ dryMass: 20 - 15, isBoosterSeparated: true }).mass, 5 + 2 + (5 + 100 + 200) + 34 + 6);
		});

		it('normal: the object state wins over the per-frame telemetry placeholder (the load case) and over stale telemetry', () => {
			const jettisoned = make({ currentStageIndex: 1, dryMass: 4, fuelMass: 5, oxidMass: 10, fairing: { enabled: true, massT: 2, isSeparated: true } });
			assert.equal(jettisoned.telemetry.isFairingSeparated, undefined, 'a new object has no telemetry flag yet');
			assert.equal(jettisoned.mass, 5 + 19 + 6, 'no fairing mass before the first frame');
			const attached = make({ currentStageIndex: 1, dryMass: 4, fuelMass: 5, oxidMass: 10 });
			attached.telemetry = { ...attached.telemetry, isFairingSeparated: true };
			assert.equal(attached.mass, 5 + 2 + 19 + 6, 'the fairing counts until the object says it separated');
		});

		it('normal (real path): a save loaded after each separation shows the Worker mass before the first frame', async () => {
			const scenarios = [
				// [vehicle, payload, mission, save condition, label]
				['h3_22', 'earth_obs', 'leo_250km', (w) => w.isBoosterSeparated && w.currentStageIndex === 0, 'SRBs jettisoned, stage 1 burning'],
				['falcon9', 'htv_x', 'iss_rendezvous', (w) => w.currentStageIndex === 1 && !w.fairing.isSeparated && !w.isPayloadSeparated, 'stage 2, fairing attached'],
				['falcon9', 'htv_x', 'iss_rendezvous', (w) => w.fairing.isSeparated && !w.isPayloadSeparated, 'fairing jettisoned'],
				['falcon9', 'htv_x', 'iss_rendezvous', (w) => w.isPayloadSeparated, 'self-propelled payload separated'],
				['falcon9', 'earth_obs', 'leo_250km', (w) => w.isPayloadSeparated, 'passive payload separated'],
				['epsilon', 'asnaro_2', 'leo_250km', (w) => w.currentStageIndex === 2 && !w.isPayloadSeparated, '3-stage, stage 3']
			];
			for (const [vehicleId, payloadId, missionId, cond, what] of scenarios) {
				EventBus.clearAll();
				const A = newUniverse();
				const rocket = rolloutAndLaunch(A.universe, A.bridge, { vehicleId, payloadId, missionId });
				const reached = stepFrames(A.bridge, 1500, () => cond(workerObj(A.bridge, rocket.id)));
				assert.equal(reached, true, `${what}: reached`);
				assert.equal(rocket.mass, workerObj(A.bridge, rocket.id).mass, `${what}: in flight the main-thread mass equals the Worker mass`);
				const save = await saveToJson(A.universe);
				const entry = save.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);

				EventBus.clearAll();
				const B = newUniverse();
				loadJson(B.universe, save);
				const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				const w = workerObj(B.bridge, loaded.id);
				assert.ok(Object.is(loaded.mass, w.mass), `${what}: before the first frame ${loaded.mass} t vs Worker ${w.mass} t`);
				assert.ok(Math.abs(loaded.mass - attachedMassOf(entry)) < 1e-9, `${what}: the sum of the attached parts (${attachedMassOf(entry)} t)`);
				stepFrames(B.bridge, 1);
				assert.ok(Object.is(loaded.mass, workerObj(B.bridge, loaded.id).mass), `${what}: after the first frame`);
			}
		});

		it('abnormal: missing parts and a non-number / out-of-range stage index are normalized like the CalcRocket restore', () => {
			assert.equal(make({ fairing: null }).mass, 5 + 320 + 34 + 6);
			assert.equal(make({ fairing: { enabled: false, massT: 2 } }).mass, 5 + 320 + 34 + 6);
			assert.equal(make({ payload: null }).mass, 2 + 320 + 34 + 6);
			// Index -> RocketStackUtils.normalizeStageIndex (whole number in [0, stages.length]; design 2026-11-23 §3.1)
			assert.equal(make({ currentStageIndex: NaN }).mass, 5 + 2 + 320 + 34 + 6);
			assert.equal(make({ currentStageIndex: undefined }).mass, 5 + 2 + 320 + 34 + 6);
			assert.equal(make({ currentStageIndex: -3 }).mass, 5 + 2 + 320 + 34 + 6);
			assert.equal(make({ currentStageIndex: '1', dryMass: 4, fuelMass: 5, oxidMass: 10 }).mass, 5 + 2 + 19 + 6);
			assert.equal(make({ currentStageIndex: 9, dryMass: 0, fuelMass: 0, oxidMass: 0 }).mass, 5 + 2);
			// A fraction is rounded down (it threw a TypeError reading stages[i + 0.5] on main); a disableStaging vehicle is
			// at most on its last stage (Gate 3 G3-5-01)
			assert.equal(make({ currentStageIndex: 0.5 }).mass, 5 + 2 + 320 + 34 + 6);
			assert.equal(make({ currentStageIndex: 1.5, dryMass: 4, fuelMass: 5, oxidMass: 10 }).mass, 5 + 2 + 19 + 6);
			assert.equal(make({ currentStageIndex: 3, disableStaging: true, dryMass: 1, fuelMass: 2, oxidMass: 3 }).mass, 5 + 2 + 6);
			// Separated payload without a stored flag (save without hasPayloadPropulsion): self-propelled when its propulsion is enabled
			const prop = { enabled: true, dryMassT: 1.8, fuelMassT: 0.8, oxidMassT: 1.4 };
			assert.equal(make({ isPayloadSeparated: true, payload: { massT: 4, propulsion: prop }, dryMass: 1.8, fuelMass: 0.5, oxidMass: 1 }).mass, 1.8 + 0.5 + 1);
			assert.equal(make({ isPayloadSeparated: true, payload: { massT: 4, propulsion: { ...prop, enabled: false } }, dryMass: 0, fuelMass: 0, oxidMass: 0 }).mass, 4);
			assert.equal(make({ isPayloadSeparated: true, payload: null, dryMass: 0, fuelMass: 0, oxidMass: 0 }).mass, 0);
			assert.equal(make({ isPayloadSeparated: true, hasPayloadPropulsion: true, dryMass: undefined, fuelMass: NaN, oxidMass: 1 }).mass, 1);
		});

		it('abnormal (real path): an edited save with a fraction, a negative index or a disableStaging index past its stages loads, and the main thread, the Worker and the HUD fly the same stage (design 2026-11-23 §3.1, Gate 3 G3-5-01)', async () => {
			EventBus.clearAll();
			const A = newUniverse();
			const rocket = rolloutAndLaunch(A.universe, A.bridge, { vehicleId: 'falcon9', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			const reached = stepFrames(A.bridge, 1500, () => workerObj(A.bridge, rocket.id).currentStageIndex === 1 && !workerObj(A.bridge, rocket.id).isPayloadSeparated);
			assert.equal(reached, true, 'stage 2 reached');
			const save = await saveToJson(A.universe);
			// [edit of the saved rocket, the index the whole session flies]: design §3.1, whole number in [0, 2] (Falcon 9 has
			// 2 stages), a value that is not a number 0, a disableStaging vehicle at most its last stage (Gate 3 G3-5-01, G3-7-01)
			const EDITS = [
				[{ currentStageIndex: 0.5 }, 0],
				[{ currentStageIndex: 1.5 }, 1],
				[{ currentStageIndex: -1 }, 0],
				[{ currentStageIndex: 3 }, 2],
				[{ currentStageIndex: 5 }, 2],
				[{ currentStageIndex: '1' }, 1],
				[{ currentStageIndex: true }, 1],
				[{ currentStageIndex: null }, 0],
				[{ currentStageIndex: 2, disableStaging: true }, 1]
			];
			for (const [edit, expected] of EDITS) {
				const json = JSON.parse(JSON.stringify(save));
				Object.assign(json.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET), edit);
				EventBus.clearAll();
				const B = newUniverse();
				loadJson(B.universe, json);
				const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				assert.ok(loaded, `${JSON.stringify(edit)}: the rocket is loaded`);
				const w = workerObj(B.bridge, loaded.id);
				assert.ok(w, `${JSON.stringify(edit)}: the Worker has the rocket (the load did not stop half way)`);
				assert.equal(loaded.currentStageIndex, expected, `${JSON.stringify(edit)}: main-thread index`);
				assert.equal(w.currentStageIndex, expected, `${JSON.stringify(edit)}: Worker index`);
				assert.equal(RocketStackUtils.resolveStackState(loaded).curStgIdx, expected, `${JSON.stringify(edit)}: the stage drawn and shown`);
				assert.ok(Number.isFinite(loaded.mass) && Object.is(loaded.mass, w.mass), `${JSON.stringify(edit)}: mass ${loaded.mass} t vs Worker ${w.mass} t`);
				stepFrames(B.bridge, 1);
				assert.equal(loaded.currentStageIndex, expected, `${JSON.stringify(edit)}: after the first frame`);
				assert.ok(Object.is(loaded.mass, workerObj(B.bridge, loaded.id).mass), `${JSON.stringify(edit)}: mass after the first frame`);
			}
			// The saved stage count is not read: the load counts the stages as the Worker does (2 for Falcon 9), whatever the
			// save says, when it has no count, and when it has no stage index either (the count does not depend on the index),
			// so the main thread shows the Worker's count before the first frame (design §3.1, Gate 4 Iteration 1 watchpoint 5,
			// Iteration 2 G4-2-01). [label, keys to delete, keys to set, the stage index of the main thread and the Worker]:
			// the saved index (1), or the Rocket default 0 when the save has none
			const COUNT_EDITS = [
				['totalStages 5', [], { totalStages: 5 }, 1],
				['totalStages 0', [], { totalStages: 0 }, 1],
				['totalStages -1', [], { totalStages: -1 }, 1],
				['totalStages "7"', [], { totalStages: '7' }, 1],
				['totalStages null', [], { totalStages: null }, 1],
				['totalStages 1', [], { totalStages: 1 }, 1],
				['no totalStages', ['totalStages'], {}, 1],
				['no currentStageIndex', ['currentStageIndex'], {}, 0],
				['no currentStageIndex, totalStages 7', ['currentStageIndex'], { totalStages: 7 }, 0],
				['neither key', ['currentStageIndex', 'totalStages'], {}, 0]
			];
			for (const [what, removed, set, index] of COUNT_EDITS) {
				const json = JSON.parse(JSON.stringify(save));
				const entry = json.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
				for (const key of removed) delete entry[key];
				Object.assign(entry, set);
				EventBus.clearAll();
				const B = newUniverse();
				loadJson(B.universe, json);
				const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				const w = workerObj(B.bridge, loaded.id);
				assert.ok(w, `${what}: the Worker has the rocket`);
				assert.equal(w.totalStages, 2, `${what}: the Worker counts the stages`);
				assert.equal(loaded.totalStages, 2, `${what}: the main thread counts them as the Worker does`);
				assert.equal(loaded.currentStageIndex, index, `${what}: main-thread stage index`);
				assert.equal(w.currentStageIndex, index, `${what}: Worker stage index`);
				assert.equal(RocketStackUtils.resolveStackState(loaded).curStgIdx, index, `${what}: the stage drawn and shown`);
			}
		});

		it('normal (real path): a rocket without stages (the stress-test swarm) saved in its payload phase loads at the same stage index (Gate 3 G3-6-01)', async () => {
			// The swarm rocket has no stages on the main thread; the Worker flies it as one stage (normalizeRocketConfig) and
			// separates its payload within a few frames, so its saved index is 1 = the stage count. The load counts the
			// stages as the Worker does (1, not 0), so the index and the separation state survive the save -> load
			EventBus.clearAll();
			const A = newUniverse();
			const sun = A.universe.objects.find((o) => o.name === 'Sun');
			assert.ok(sun, 'the default world has the Sun');
			A.universe.ObjectPlacer._deployEllipticalSwarm(sun, { template: 'Rocket', count: 1, perihelionAuMin: 1, perihelionAuMax: 1, aphelionAuMin: 2, aphelionAuMax: 2, options: { autoControl: true, isIgnited: false } });
			const rocket = A.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.deepEqual(rocket.stages, [], 'precondition: no stages on the main thread');
			assert.equal(workerObj(A.bridge, rocket.id).totalStages, 1, 'precondition: the Worker flies one stage');
			const reached = stepFrames(A.bridge, 200, () => workerObj(A.bridge, rocket.id)?.isPayloadSeparated);
			assert.equal(reached, true, 'the payload separated');
			await new Promise((r) => setImmediate(r));
			const save = await saveToJson(A.universe);
			const entry = save.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.equal(entry.currentStageIndex, 1, 'precondition: saved at index 1 = the stage count');
			assert.equal(entry.isPayloadSeparated, true, 'precondition: saved as separated');

			EventBus.clearAll();
			const B = newUniverse();
			loadJson(B.universe, save);
			const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			const w = workerObj(B.bridge, loaded.id);
			assert.ok(w, 'the Worker has the rocket');
			assert.equal(loaded.currentStageIndex, 1, 'main-thread index kept');
			assert.equal(w.currentStageIndex, 1, 'Worker index kept');
			assert.equal(w.isPayloadSeparated, true, 'Worker separation state kept');
			assert.equal(RocketStackUtils.resolveStackState(loaded).isPayloadOnly, true, 'drawn and shown as the payload alone');
			stepFrames(B.bridge, 2);
			await new Promise((r) => setImmediate(r));
			assert.equal(loaded.currentStageIndex, 1, 'index after the first frames');
			assert.equal(loaded.telemetry.stageIndex, 1, 'telemetry index after the first frames');
		});

		it('abnormal (real path): an edited save of a rocket without stages loads at the index the Worker flies, counting one stage (design §3.1, Gate 3 G3-7-01)', async () => {
			EventBus.clearAll();
			const A = newUniverse();
			const sun = A.universe.objects.find((o) => o.name === 'Sun');
			A.universe.ObjectPlacer._deployEllipticalSwarm(sun, { template: 'Rocket', count: 1, perihelionAuMin: 1, perihelionAuMax: 1, aphelionAuMin: 2, aphelionAuMax: 2, options: { autoControl: true, isIgnited: false } });
			const rocket = A.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			const onPad = await saveToJson(A.universe);
			const padEntry = onPad.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.deepEqual([padEntry.currentStageIndex, Boolean(padEntry.isPayloadSeparated), padEntry.stages ?? []], [0, false, []], 'precondition: saved at index 0, not separated, no stages');
			assert.equal(stepFrames(A.bridge, 200, () => workerObj(A.bridge, rocket.id)?.isPayloadSeparated), true, 'the payload separated');
			await new Promise((r) => setImmediate(r));
			const separated = await saveToJson(A.universe);
			// [save, edit of the saved rocket, the index of the main thread and the Worker]: one stage, so a whole number in
			// [0, 1] (1 = the payload phase), and a disableStaging vehicle at most its last stage, 0
			const CASES = [
				[onPad, { currentStageIndex: 0 }, 0],
				[onPad, { currentStageIndex: 1 }, 1],
				[onPad, { currentStageIndex: 2 }, 1],
				[onPad, { currentStageIndex: 5 }, 1],
				[onPad, { currentStageIndex: -1 }, 0],
				[onPad, { currentStageIndex: 0.5 }, 0],
				[onPad, { currentStageIndex: 1, disableStaging: true }, 0],
				[onPad, { totalStages: 3 }, 0],
				[separated, { currentStageIndex: 2 }, 1],
				[separated, { totalStages: 4 }, 1]
			];
			for (const [save, edit, expected] of CASES) {
				const what = `${save === onPad ? 'on the pad' : 'separated'}, ${JSON.stringify(edit)}`;
				const json = JSON.parse(JSON.stringify(save));
				Object.assign(json.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET), edit);
				EventBus.clearAll();
				const B = newUniverse();
				loadJson(B.universe, json);
				const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				const w = workerObj(B.bridge, loaded.id);
				assert.ok(w, `${what}: the Worker has the rocket`);
				assert.equal(w.totalStages, 1, `${what}: the Worker flies one stage`);
				assert.equal(loaded.totalStages, 1, `${what}: the main thread counts one stage too`);
				assert.equal(loaded.currentStageIndex, expected, `${what}: main-thread index`);
				assert.equal(w.currentStageIndex, expected, `${what}: Worker index (the same before the first frame)`);
			}
		});

		it('boundary: stage index at 0, at the last stage and at the stage count; no stages', () => {
			assert.equal(make({ currentStageIndex: 0 }).mass, 5 + 2 + 320 + 34 + 6);
			assert.equal(make({ currentStageIndex: 2, dryMass: 1, fuelMass: 2, oxidMass: 3 }).mass, 5 + 2 + 6);
			assert.equal(make({ currentStageIndex: 3, dryMass: 0, fuelMass: 0, oxidMass: 0 }).mass, 5 + 2, 'index = count without the separated flag: no stage left');
			const bare = make({ stages: [], dryMass: 1, fuelMass: 2, oxidMass: 3 });
			assert.equal(bare.mass, 6, 'without stages: dry + propellant');
		});
	});
});
