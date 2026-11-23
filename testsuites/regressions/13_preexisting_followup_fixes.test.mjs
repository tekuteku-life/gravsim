/**
 * Regression Suite 13: pre-existing defects found while fixing those of design §4.13 (Rev 6.12, §4.13-9 onward).
 * All of them also occurred on main.
 *
 *  1. Separation state before the first Worker frame (§4.13-9). Until the first frame (none arrives while the simulation
 *     is paused, e.g. right after a load) the rocket's telemetry is a placeholder without the separation flags. The
 *     STAGE line read the SRB tag from the telemetry only, so an H3 loaded after the SRB burnout / separation read
 *     "[+SRB]" until the first frame. It now uses the state the rocket holds and saves (isBoosterSeparated /
 *     isBoosterBurnout), with the telemetry flag as the fallback, like RocketRenderer. The renderer itself already used
 *     the held state (fairing.isSeparated, isPayloadSeparated, isBoosterSeparated, currentStageIndex) with the
 *     telemetry as the fallback; its drawing before the first frame is pinned here on the real save -> load path.
 *  2. The Rocket tab restores the view from before it opened (§4.13-10). RocketTab.open() saved the time scale, zoom and
 *     camera target after its own launch setup (git 1bd9842), so closing the tab restored the minimum time scale, the
 *     zoom fitted to the host and the host. open() now saves them first, only when the tab was closed (a click on the
 *     open tab runs open() again), and the zoom restore also moves the System-tab slider (camera:zoom-changed, as
 *     camera.fitToTarget). A load while the tab is open still replaces the values restored on close (deferViewState).
 *  3. The prediction period is saved (§4.13-11): RocketLauncher.getState() writes predictionDurationMonths (not the
 *     derived maxSimTimeSec); loadState() applies a finite positive number clamped to the #pred-duration slider range of
 *     index.html (0.2 to 36 months), derives maxSimTimeSec (months x 365.25 / 12 days x 86400 s) and shows it on the
 *     slider and label (ui:sync-prediction-duration). A save without it (written before) or with an invalid value keeps
 *     the period in use.
 *  4. The pinned header without rocket telemetry reads TRACKING (§4.13-12): it wrote TELEMETRY.STATUS_MAP[6], undefined
 *     since the statuses were renumbered to -1..5 (git bd61960; 82f8860 had written index 6 = TRACKING).
 *
 * Expected values: slider ranges from index.html, prediction periods and labels from the label rule of design §3.4-4,
 * stage names and booster counts from the presets (inputs), and the drawing of the same rocket after its first Worker
 * frame. Nothing is copied from the output of the code under test.
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
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { Rocket } from '../../scripts/gravsim_object.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { OBJECT_TYPES, TELEMETRY, TRAJECTORY_PREDICTION } from '../../scripts/gravsim_const.js';

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
const preset = (dir, id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', dir, `${id}.json`), 'utf8'));
/** Prediction-slider label rule (design §3.4-4): below 12 months "<m> mo (<round(m * 365.25 / 12)> d)", else "<m / 12, 1 decimal> yr (<m> mo)". */
const predictionLabel = (m) => (m < 12 ? `${m} mo (${Math.round(m * 365.25 / 12)} d)` : `${(m / 12).toFixed(1)} yr (${m} mo)`);
/** Seconds of a prediction period as the design writes them: months x 365.25 / 12 days x 86400 s. */
const periodSec = (m) => m * (365.25 / 12) * 86400;

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
	for (const id of ['pred-duration-val', 'time-scale-indicator', 'zoom-scale-indicator', 'tm-mission-status', 'tm-met', 'tm-stage-info']) {
		el(id).textContent = '';
		delete el(id)._cachedText;
	}
};

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regression 12
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
	// The trajectory prediction is not under test here: skip it (synchronous in rollout() / RocketTab.open(), debounced
	// on every configuration change)
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
const workerObj = (bridge, id) => bridge.ctrl.engine.objects.find((o) => o.id === id);
const rocketOf = (universe) => universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);

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

/**
 * Fly a vehicle until `cond(workerRocket)`, save, and load the save into a new universe (paused: no Worker frame).
 * @returns {Promise<{ live: any, loaded: any, B: { universe: any, bridge: any }, entry: any }>}
 */
const flySaveLoad = async (ids, cond, what) => {
	EventBus.clearAll();
	const A = newUniverse();
	const live = rolloutAndLaunch(A.universe, A.bridge, ids);
	assert.equal(stepFrames(A.bridge, 1500, () => cond(workerObj(A.bridge, live.id))), true, `${what}: reached`);
	const save = await saveToJson(A.universe);
	const entry = save.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
	EventBus.clearAll();
	const B = newUniverse();
	loadJson(B.universe, save);
	const loaded = rocketOf(B.universe);
	assert.ok(loaded, `${what}: the rocket is loaded`);
	return { live, loaded, B, entry };
};

/** Recording 2D context: counts every method call by name (no drawing). */
const recordingCtx = () => {
	const calls = [];
	const gradient = { addColorStop: () => {} };
	const target = { calls };
	return new Proxy(target, {
		get(t, key) {
			if (key in t) { return t[key]; }
			if (key === 'createLinearGradient' || key === 'createRadialGradient') { return () => { calls.push(key); return gradient; }; }
			if (key === 'measureText') { return () => ({ width: 0 }); }
			return () => { calls.push(key); };
		},
		set(t, key, value) { t[key] = value; return true; }
	});
};

/**
 * What RocketRenderer.draw() draws for `rocket` (high detail): fairings, satellites (deployed or stowed), whether SRB
 * bodies are drawn (_drawBoosters paints their casings with linear gradients) and the layout used by the RCS / vapor cone.
 */
const drawnParts = (rocket, R = 30) => {
	const rec = { fairings: 0, sats: [], boostersDrawn: false };
	const orig = { f: RocketRenderer._drawFairing, p: RocketRenderer._drawPayloadSatellite, b: RocketRenderer._drawBoosters };
	RocketRenderer._drawFairing = function (...args) { rec.fairings++; return orig.f.apply(this, args); };
	RocketRenderer._drawPayloadSatellite = function (ctx, cx, cy, r, deployed) { rec.sats.push(Boolean(deployed)); return orig.p.call(this, ctx, cx, cy, r, deployed); };
	RocketRenderer._drawBoosters = function (ctx, ...args) {
		const before = ctx.calls.filter((c) => c === 'createLinearGradient').length;
		const out = orig.b.call(this, ctx, ...args);
		rec.boostersDrawn = rec.boostersDrawn || ctx.calls.filter((c) => c === 'createLinearGradient').length > before;
		return out;
	};
	try {
		RocketRenderer.draw(recordingCtx(), rocket, 0, 0, R, 1);
	} finally {
		RocketRenderer._drawFairing = orig.f;
		RocketRenderer._drawPayloadSatellite = orig.p;
		RocketRenderer._drawBoosters = orig.b;
	}
	rec.layout = RocketRenderer._computeVisualLayout(rocket, R);
	return rec;
};

describe('Regression 13: pre-existing defects found while fixing those of design §4.13 (§4.13-9 onward)', () => {
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
	// 1. Separation state before the first Worker frame
	// ------------------------------------------------------------------
	describe('1. the STAGE line and the drawing use the held separation state before the first Worker frame', () => {
		const H3_22 = preset('vehicles', 'h3_22');
		const STAGE1 = H3_22.stages[0].name;

		it('normal (real path): an H3-22 loaded after the SRB burnout / separation reads "[SRB BURNOUT]" / "[SRB SEP]" before the first frame', async () => {
			assert.equal(H3_22.boosters.count, 2, 'input: two SRBs');
			const ids = { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' };
			const cases = [
				[(w) => w.isBoosterBurnout && !w.isBoosterSeparated && w.currentStageIndex === 0, 'SRB BURNOUT'],
				[(w) => w.isBoosterSeparated && w.currentStageIndex === 0, 'SRB SEP']
			];
			for (const [cond, tag] of cases) {
				const { live, loaded, B, entry } = await flySaveLoad(ids, cond, tag);
				assert.equal(entry.currentStageIndex, 0);
				const expected = `1 / ${H3_22.stages.length} (${STAGE1}) [${tag}]`;
				assert.equal(TelemetryPanel.formatStageInfo(live, live.telemetry), expected, `${tag}: in flight (Worker telemetry)`);
				// No Worker frame yet: the telemetry is the placeholder without the flags
				assert.equal(loaded.telemetry.isBoosterSeparated, undefined, `${tag}: placeholder`);
				assert.equal(loaded.telemetry.isBoosterBurnout, undefined, `${tag}: placeholder`);
				assert.equal(TelemetryPanel.formatStageInfo(loaded, loaded.telemetry), expected, `${tag}: before the first frame`);
				// The real HUD (paused, as after a load in the app)
				const panel = B.universe.TelemetryPanel;
				panel.targetId = loaded.id;
				panel.open();
				panel.update();
				assert.equal(el('tm-stage-info').textContent, expected, `${tag}: the HUD before the first frame`);
				// After the first frame the text follows the Worker state (the SRBs may separate in that frame)
				stepFrames(B.bridge, 1);
				const w = workerObj(B.bridge, loaded.id);
				const tagAfter = w.isBoosterSeparated ? 'SRB SEP' : 'SRB BURNOUT';
				assert.equal(TelemetryPanel.formatStageInfo(loaded, loaded.telemetry), `1 / ${H3_22.stages.length} (${STAGE1}) [${tagAfter}]`, `${tag}: after the first frame`);
			}
		});

		it('normal (real path, renderer): before the first frame the loaded rocket is drawn as the saved one in flight (fairing, SRBs, payload)', async () => {
			const scenarios = [
				[{ vehicleId: 'falcon9', payloadId: 'htv_x', missionId: 'iss_rendezvous' }, (w) => w.currentStageIndex === 1 && !w.fairing.isSeparated, 'stage 2, fairing attached',
					{ fairings: 1, sats: [], boostersDrawn: false }],
				[{ vehicleId: 'falcon9', payloadId: 'htv_x', missionId: 'iss_rendezvous' }, (w) => w.fairing.isSeparated && !w.isPayloadSeparated, 'fairing jettisoned',
					{ fairings: 0, sats: [false], boostersDrawn: false }],
				[{ vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km' }, (w) => w.isPayloadSeparated, 'payload separated',
					{ fairings: 0, sats: [true], boostersDrawn: false }],
				[{ vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' }, (w) => w.isBoosterBurnout && !w.isBoosterSeparated && w.currentStageIndex === 0, 'SRB burnout (attached)',
					{ fairings: 1, sats: [], boostersDrawn: true }],
				[{ vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' }, (w) => w.isBoosterSeparated && w.currentStageIndex === 0, 'SRBs separated',
					{ fairings: 1, sats: [], boostersDrawn: false }]
			];
			for (const [ids, cond, what, expected] of scenarios) {
				const { live, loaded } = await flySaveLoad(ids, cond, what);
				// The saved rocket in flight (Worker telemetry of the saved frame) draws the expected parts
				assert.ok(live.telemetry.stageIndex !== undefined, `${what}: the live rocket has Worker telemetry`);
				const inFlight = drawnParts(live);
				const { layout: _layout, ...liveParts } = inFlight;
				assert.deepEqual(liveParts, expected, `${what}: drawn in flight`);
				// The loaded rocket before its first frame (placeholder telemetry) draws the same parts with the same layout
				assert.equal(loaded.telemetry.stageIndex, undefined, `${what}: no Worker frame yet`);
				assert.deepEqual(drawnParts(loaded), inFlight, `${what}: drawn before the first frame as in flight`);
			}
		});

		it('abnormal: the held flag or the telemetry flag alone selects the tag; no boosters or not stage 1 -> no tag', () => {
			const stages = [{ name: 'S1' }, { name: 'S2' }];
			const boosters = { count: 2, burnTimeSec: 105 };
			const label = (over, tm) => TelemetryPanel.formatStageInfo({ stages, boosters, ...over }, tm);
			// Held state only (placeholder telemetry, as right after a load)
			assert.equal(label({ isBoosterSeparated: true }, {}), '1 / 2 (S1) [SRB SEP]');
			assert.equal(label({ isBoosterBurnout: true }, {}), '1 / 2 (S1) [SRB BURNOUT]');
			// Telemetry only (the established fallback, as the renderer)
			assert.equal(label({}, { stageIndex: 0, isBoosterSeparated: true }), '1 / 2 (S1) [SRB SEP]');
			assert.equal(label({}, { stageIndex: 0, isBoosterBurnout: true }), '1 / 2 (S1) [SRB BURNOUT]');
			// Neither (or falsy values of any kind)
			assert.equal(label({ isBoosterSeparated: false, isBoosterBurnout: 0 }, { isBoosterSeparated: null, isBoosterBurnout: undefined }), '1 / 2 (S1) [+SRB]');
			// No boosters / boosters without count and burn time / not on stage 1: no tag whatever the flags
			assert.equal(TelemetryPanel.formatStageInfo({ stages, isBoosterSeparated: true }, {}), '1 / 2 (S1)');
			assert.equal(TelemetryPanel.formatStageInfo({ stages, boosters: { count: 0 }, isBoosterSeparated: true }, {}), '1 / 2 (S1)');
			assert.equal(label({ isBoosterSeparated: true, currentStageIndex: 1 }, {}), '2 / 2 (S2)');
			// A loaded rocket object (Rocket constructor placeholder telemetry)
			const r = new Rocket(1, 'Rocket', 0, 0, 0, 0, 1, 1, 1, '#fff', 1, 1, 0, null, 0);
			Object.assign(r, { stages, boosters, isBoosterSeparated: true, isBoosterBurnout: true });
			assert.equal(TelemetryPanel.formatStageInfo(r, r.telemetry), '1 / 2 (S1) [SRB SEP]');
		});

		it('boundary: separation wins over burnout from either source; stage index 0 is the last with a tag', () => {
			const stages = [{ name: 'S1' }, { name: 'S2' }];
			const boosters = { count: 0, burnTimeSec: 105 };
			const label = (over, tm) => TelemetryPanel.formatStageInfo({ stages, boosters, ...over }, tm);
			assert.equal(label({ isBoosterBurnout: true }, { isBoosterSeparated: true }), '1 / 2 (S1) [SRB SEP]');
			assert.equal(label({ isBoosterSeparated: true }, { isBoosterBurnout: true }), '1 / 2 (S1) [SRB SEP]');
			assert.equal(label({ isBoosterSeparated: true, isBoosterBurnout: true }, {}), '1 / 2 (S1) [SRB SEP]');
			// Burn time only (count 0) still has boosters; index 0 tagged, index 1 not
			assert.equal(label({ currentStageIndex: 0, isBoosterBurnout: true }, {}), '1 / 2 (S1) [SRB BURNOUT]');
			assert.equal(label({ currentStageIndex: 1, isBoosterBurnout: true }, {}), '2 / 2 (S2)');
		});
	});

	// ------------------------------------------------------------------
	// 2. The Rocket tab restores the view from before it opened
	// ------------------------------------------------------------------
	describe('2. closing the Rocket tab restores the time scale, the zoom and the camera target from before it opened', () => {
		/** System-tab view and camera (the slider positions as numbers: the mock holds what was assigned). */
		const viewOf = (universe) => ({
			time: Number(el('time-scale').value),
			timeText: el('time-scale-indicator').textContent,
			timeScale: universe.timeScale,
			zoom: Number(el('zoom-scale').value),
			zoomText: el('zoom-scale-indicator').textContent,
			zoomExp: universe.camera.targetZoomExp,
			tracking: universe.camera.trackingTarget?.name ?? null,
			offset: { ...universe.camera.targetOffset }
		});
		/** Set the time-scale and zoom sliders through their own handlers and track `target` with an offset. */
		const setView = (universe, { time, zoom, target, offset = { x: 0, y: 0 } }) => {
			el('time-scale').value = String(time);
			el('time-scale').dispatchEvent({ type: 'input' });
			el('zoom-scale').value = String(zoom);
			el('zoom-scale').dispatchEvent({ type: 'input', target: { value: String(zoom) } });
			EventBus.emit('camera:set-tracking-target', target);
			universe.camera.setTargetOffset(offset.x, offset.y);
			return viewOf(universe);
		};
		const setup = () => {
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			const sun = universe.objects.find((o) => o.name === 'Sun');
			assert.ok(earth && sun);
			return { universe, earth, sun };
		};

		it('normal: open sets the tab\'s own view; close restores the one from before (time scale, zoom with its slider, camera target and offset)', () => {
			const { universe, sun } = setup();
			const before = setView(universe, { time: -3, zoom: 4.5, target: sun, offset: { x: 12, y: -7 } });
			assert.deepEqual({ time: before.time, timeScale: before.timeScale, zoom: before.zoom, zoomExp: before.zoomExp, tracking: before.tracking },
				{ time: -3, timeScale: Math.pow(10, -3), zoom: 4.5, zoomExp: 4.5, tracking: 'Sun' });

			openTab(universe, 'tab-rocket');
			const inTab = viewOf(universe);
			assert.equal(inTab.time, TIME_RANGE.min, 'the tab sets the minimum time scale');
			assert.equal(inTab.timeScale, Math.pow(10, TIME_RANGE.min));
			assert.equal(inTab.tracking, 'Earth', 'the tab tracks the host');
			assert.notEqual(inTab.zoomExp, before.zoomExp, 'the tab fits the zoom to the host');
			assert.equal(universe.isPaused, true);

			openTab(universe, 'tab-sys');
			assert.equal(universe.ControlPanel.rocketTab.isOpened, false);
			assert.deepEqual(viewOf(universe), before, 'the view from before the tab opened');
		});

		it('normal: a second open() while the tab is open keeps the values to restore; each opening restores its own', () => {
			const { universe, sun, earth } = setup();
			const first = setView(universe, { time: -2, zoom: 3, target: sun });
			openTab(universe, 'tab-rocket');
			openTab(universe, 'tab-rocket'); // a click on the already open tab
			universe.ControlPanel.rocketTab.open();
			openTab(universe, 'tab-sys');
			assert.deepEqual(viewOf(universe), first, 'still the view from before the first opening');

			const second = setView(universe, { time: -5, zoom: 6, target: earth, offset: { x: -3, y: 4 } });
			openTab(universe, 'tab-rocket');
			openTab(universe, 'tab-deploy'); // any other tab closes it
			assert.deepEqual(viewOf(universe), second, 'the second opening restores the view from before it');
		});

		it('normal: a load while the tab is open replaces the values restored on close, and the zoom slider follows the camera', () => {
			const { universe, sun } = setup();
			setView(universe, { time: -3, zoom: 4.5, target: sun });
			openTab(universe, 'tab-rocket');
			const tabZoomSlider = Number(el('zoom-scale').value);
			universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: -2.2, zoomScaleVal: 5.5 } } });
			assert.equal(Number(el('time-scale').value), TIME_RANGE.min, 'while open the minimum stays');
			assert.equal(Number(el('zoom-scale').value), tabZoomSlider);
			openTab(universe, 'tab-sys');
			const v = viewOf(universe);
			assert.deepEqual({ time: v.time, timeScale: v.timeScale, zoom: v.zoom, zoomExp: v.zoomExp }, { time: -2.2, timeScale: Math.pow(10, -2.2), zoom: 5.5, zoomExp: 5.5 });
			// Only one of the two in the file: the other is the value from before the tab opened
			setView(universe, { time: -4, zoom: 2, target: sun });
			openTab(universe, 'tab-rocket');
			universe.loadState({ controlPanel: { controlPanel: { timeScaleVal: -1.5, zoomScaleVal: 'x' } } });
			openTab(universe, 'tab-sys');
			const w = viewOf(universe);
			assert.deepEqual({ time: w.time, zoom: w.zoom, zoomExp: w.zoomExp }, { time: -1.5, zoom: 2, zoomExp: 2 });
		});

		it('abnormal: no tracked object before opening, or a target left from an earlier opening, restores no camera target', () => {
			const { universe, sun } = setup();
			const tab = universe.ControlPanel.rocketTab;
			setView(universe, { time: -3, zoom: 4.5, target: sun });
			universe.camera.trackingTarget = null;
			tab.previousCameraTarget = sun; // as left by an earlier opening whose close kept the auto tracking
			tab.previousCameraOffset = { x: 99, y: 99 };
			openTab(universe, 'tab-rocket');
			assert.equal(tab.previousCameraTarget, null, 'nothing to restore');
			assert.equal(tab.previousCameraOffset, null);
			openTab(universe, 'tab-sys');
			const v = viewOf(universe);
			assert.equal(v.tracking, 'Earth', 'the camera stays on the host the tab tracked');
			assert.deepEqual({ time: v.time, zoomExp: v.zoomExp, zoom: v.zoom }, { time: -3, zoomExp: 4.5, zoom: 4.5 }, 'the time scale and zoom are still restored');
			// close() without a preceding open() changes nothing
			const now = viewOf(universe);
			tab.close();
			assert.deepEqual(viewOf(universe), now);
		});

		it('boundary: a view at the slider ends before opening is restored as is', () => {
			const { universe, sun } = setup();
			for (const [time, zoom] of [[TIME_RANGE.min, ZOOM_RANGE.min], [TIME_RANGE.max, ZOOM_RANGE.max], [TIME_RANGE.min + TIME_RANGE.step, 0]]) {
				const before = setView(universe, { time, zoom, target: sun });
				openTab(universe, 'tab-rocket');
				openTab(universe, 'tab-sys');
				const v = viewOf(universe);
				assert.ok(Math.abs(v.time - time) < 1e-12, `time ${time}: ${v.time}`);
				assert.deepEqual({ ...v, time }, before, `time ${time}, zoom ${zoom}`);
			}
		});
	});

	// ------------------------------------------------------------------
	// 3. The prediction period is saved
	// ------------------------------------------------------------------
	describe('3. the prediction period is saved and restored', () => {
		const readPeriod = (universe) => ({
			months: universe.RocketLauncher.predictionDurationMonths,
			sec: universe.RocketLauncher.maxSimTimeSec,
			slider: el('pred-duration').value,
			label: el('pred-duration-val').textContent
		});
		const periodView = (m) => ({ months: m, sec: periodSec(m), slider: String(m), label: predictionLabel(m) });
		const setPeriodSlider = (m) => {
			el('pred-duration').value = String(m);
			el('pred-duration').dispatchEvent({ type: 'input', target: { value: String(m) } });
		};
		/** Record the ui:sync-prediction-duration events until stop() (the System tab keeps its own listener). */
		const countSyncs = () => {
			const seen = [];
			const listener = (m) => seen.push(m);
			EventBus.on('ui:sync-prediction-duration', listener);
			seen.stop = () => EventBus.off('ui:sync-prediction-duration', listener);
			return seen;
		};

		it('input: the clamp range is the #pred-duration slider range of index.html (TRAJECTORY_PREDICTION.MIN / MAX_DURATION_MONTHS)', () => {
			// The range constants live in gravsim_const.js (design §4.13-18); regression 14 checks them in more detail
			assert.deepEqual({ min: TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS, max: TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS }, { min: PRED_RANGE.min, max: PRED_RANGE.max });
		});

		it('normal (real path): Save State -> Load State restores a period set with the slider on the launcher, the slider and the label', async () => {
			const A = newUniverse();
			withEarth(A.universe);
			setPeriodSlider(5);
			assert.deepEqual(readPeriod(A.universe), periodView(5));
			const save = await saveToJson(A.universe);
			assert.equal(save.universe.rocketLauncher.predictionDurationMonths, 5, 'saved with the launcher state');
			assert.equal('maxSimTimeSec' in save.universe.rocketLauncher, false, 'the derived seconds are not saved');

			EventBus.clearAll();
			const B = newUniverse();
			const earth = withEarth(B.universe);
			assert.notEqual(B.universe.RocketLauncher.predictionDurationMonths, 5, 'a new session has another period');
			loadJson(B.universe, save);
			assert.deepEqual(readPeriod(B.universe), periodView(5), 'the loaded period is used and shown');
			// The prediction request uses it
			B.universe.RocketLauncher.hostId = earth.id;
			assert.equal(B.universe.RocketLauncher._getPredictionContext().config.maxSimTime, periodSec(5));
		});

		it('normal: a mission period is saved and restored too (each mission of presets/missions)', () => {
			const missions = fs.readdirSync(path.join(ROOT, 'presets', 'missions')).filter((f) => f !== 'manifest.json' && f.endsWith('.json'))
				.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'missions', f), 'utf8')));
			assert.equal(missions.length, 7);
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			for (const m of missions) {
				presetManager.applyToLauncher(rl, { missionId: m.id });
				const state = JSON.parse(JSON.stringify(rl.getState()));
				assert.equal(state.predictionDurationMonths, m.predictionDurationMonths, m.id);
				setPeriodSlider(m.predictionDurationMonths === 7 ? 8 : 7);
				rl.loadState(state);
				assert.deepEqual(readPeriod(universe), periodView(m.predictionDurationMonths), `${m.id}: restored`);
			}
		});

		it('abnormal: a missing (older save) or invalid period keeps the period in use and sends no sync', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			setPeriodSlider(7.5);
			const base = JSON.parse(JSON.stringify(rl.getState()));
			const seen = countSyncs();
			const { predictionDurationMonths: _omit, ...legacy } = base;
			rl.loadState(legacy);
			assert.deepEqual(readPeriod(universe), periodView(7.5), 'missing');
			for (const bad of [undefined, null, '12', '', true, false, {}, [], [12], NaN, Infinity, -Infinity, 0, -0, -1, -1e-300, -36]) {
				rl.loadState({ ...base, predictionDurationMonths: bad });
				assert.deepEqual(readPeriod(universe), periodView(7.5), `${String(bad)}`);
			}
			seen.stop();
			assert.deepEqual([...seen], [], 'no sync for an ignored period');
			for (const bad of [undefined, null, '12', true, {}, NaN, Infinity, -Infinity, 0, -1]) {
				assert.equal(RocketLauncher.normalizePredictionDurationMonths(bad), null, String(bad));
			}
			// The rest of the state still loads with an invalid period
			rl.loadState({ ...base, hostAngleDeg: 33, predictionDurationMonths: 'x' });
			assert.equal(rl.hostAngleDeg, 33);
			// A save file whose launcher entry has an invalid period loads through the app path as well
			loadJson(universe, { version: 2, universe: { rocketLauncher: { ...base, predictionDurationMonths: null } } });
			assert.deepEqual(readPeriod(universe), periodView(7.5));
		});

		it('boundary: the slider ends and the year-format switch load as saved; values beyond the range are clamped; one sync each', () => {
			const { universe } = newUniverse();
			const rl = universe.RocketLauncher;
			const base = JSON.parse(JSON.stringify(rl.getState()));
			const { min, max } = PRED_RANGE;
			const cases = [
				[min, min], [max, max], [11.9, 11.9], [12, 12], [min + 0.1, min + 0.1],
				[min - 1e-12, min], [min + 1e-12, min + 1e-12], [max - 1e-12, max - 1e-12], [max + 1e-12, max],
				[0.1, min], [48, max], [1e9, max], [Number.MIN_VALUE, min], [Number.MAX_VALUE, max]
			];
			for (const [saved, expected] of cases) {
				setPeriodSlider(saved === 7 ? 8 : 7);
				const seen = countSyncs();
				rl.loadState({ ...base, predictionDurationMonths: saved });
				seen.stop();
				assert.equal(rl.predictionDurationMonths, expected, `saved ${saved}: months`);
				assert.equal(rl.maxSimTimeSec, periodSec(expected), `saved ${saved}: seconds`);
				assert.deepEqual([...seen], [expected], `saved ${saved}: one sync with the value in use`);
				assert.equal(RocketLauncher.normalizePredictionDurationMonths(saved), expected);
			}
			// On the slider and the label (clamped values on the grid)
			for (const [saved, expected] of [[min, min], [max, max], [11.9, 11.9], [12, 12], [0.1, min], [48, max]]) {
				rl.loadState({ ...base, predictionDurationMonths: saved });
				assert.deepEqual(readPeriod(universe), periodView(expected), `saved ${saved}: shown`);
			}
		});
	});

	// ------------------------------------------------------------------
	// 4. The pinned header without rocket telemetry
	// ------------------------------------------------------------------
	describe('4. the pinned header reads TRACKING without rocket telemetry', () => {
		const header = () => ({ status: el('tm-mission-status').textContent, time: el('tm-met').textContent, stage: el('tm-stage-info').textContent });
		const RESET = { status: 'TRACKING', time: 'T+ ---y ---d --:--:--', stage: '---' };

		it('normal: no rocket at all, and a rocket removed after being shown (abort), reset the header to TRACKING', () => {
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			const panel = universe.TelemetryPanel;
			panel.open();
			panel.update();
			assert.deepEqual(header(), RESET, 'no rocket');

			universe.RocketLauncher.hostId = earth.id;
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			panel.targetId = rocket.id;
			panel.update();
			assert.equal(el('tm-mission-status').textContent, 'PRE-LAUNCH', 'the rocket on the pad');
			universe.RocketLauncher.abortRollout();
			universe.ObjectManager.cleanupObjects(); // the update loop's cleanup (EVENT_PRIORITY.CLEANUP)
			assert.equal(rocketOf(universe), undefined, 'the rocket is gone');
			panel.update();
			assert.deepEqual(header(), RESET, 'after the rocket was removed');
		});

		it('abnormal: a rocket target without telemetry resets the header too', () => {
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			universe.RocketLauncher.hostId = earth.id;
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const panel = universe.TelemetryPanel;
			panel.open();
			panel.targetId = rocket.id;
			panel.update();
			assert.equal(el('tm-mission-status').textContent, 'PRE-LAUNCH');
			rocket.telemetry = null;
			panel.update();
			assert.deepEqual(header(), RESET);
		});

		it('boundary: the highest status code (TRACKING) from a rocket, then the reset in the next update, both read TRACKING', () => {
			// Input: TRACKING is the highest status code; the old index 6 is past it and no status
			assert.equal(TELEMETRY.STATUS.TRACKING, Math.max(...Object.values(TELEMETRY.STATUS)));
			assert.equal(TELEMETRY.STATUS_MAP[TELEMETRY.STATUS.TRACKING], 'TRACKING');
			assert.equal(TELEMETRY.STATUS_MAP[TELEMETRY.STATUS.TRACKING + 1], undefined);
			const { universe } = newUniverse();
			const earth = withEarth(universe);
			universe.RocketLauncher.hostId = earth.id;
			universe.RocketLauncher.rollout();
			const rocket = rocketOf(universe);
			const panel = universe.TelemetryPanel;
			panel.open();
			panel.targetId = rocket.id;
			rocket.telemetry = { ...rocket.telemetry, status: TELEMETRY.STATUS.TRACKING };
			panel.update();
			assert.equal(el('tm-mission-status').textContent, 'TRACKING', 'the rocket status');
			assert.notEqual(el('tm-stage-info').textContent, '---');
			rocket.telemetry = undefined;
			panel.update();
			assert.deepEqual(header(), RESET, 'the reset header');
		});
	});
});
