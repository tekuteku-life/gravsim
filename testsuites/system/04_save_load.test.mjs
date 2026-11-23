/**
 * System E2E 04 (headless Chrome): Save State (browser download) and Load State (file chooser) round
 * trips through the System tab buttons, plus invalid save files.
 *
 * Expectations come from docs/design/2026-11-20_trajectory_fx_flightplan.md:
 *  - §3.5-1: getState/loadState field lists for CELESTIAL / DEBRIS / ROCKET (restoredRuntimeState: true).
 *  - §4.7: the save waits for the Worker runtime snapshot; runtimeState carries the flight-computer
 *    fields and the CalcRocket fields listed there; after loading, the Worker resumes from them.
 *  - §3.5-3 SaveManager guard: non-JSON, non-object or missing / non-object `universe` -> alert
 *    "Invalid save file." and no state change.
 *  - §3.4-4: the thrust-slider max is re-synchronized in RocketTab.loadState.
 *  - §4.13 / test plan §4.6 (fixed pre-existing defects): the load restores the time-scale and zoom sliders (saved
 *    nested as controlPanel.controlPanel; the flat shape of saves from before the tab split still loads; non-numbers
 *    are ignored and out-of-range values clamped to the index.html slider range), and a rocket loaded after its fairing
 *    separated shows the mass without the fairing before the first Worker frame.
 *  - Design §4.13-10 (fixed pre-existing defect found while fixing those): closing the Rocket tab restores the view
 *    from before it opened.
 *  - Design §4.14-6 (a regression of this branch): after an in-flight load the main thread's flight clock continues at
 *    the saved MET, the relative altitude stays the height above the pad (hostAltM + bottomOffsetM), and the voice
 *    follows the continued Worker MET: no T+ count (LAUNCH_SEQUENCES.LEGACY_QUICK times) and no once-only callout of an
 *    event before the save plays again, while those after it (SECO) do.
 *
 * The prediction period, the STAGE line of a rocket loaded after the SRB separation and the other details of design
 * §4.13-11 onward are in 05_save_load_period_hud_view.test.mjs (split from this file to keep each file within the 60 s
 * guideline of the test plan §1-5; each file runs its own browser session).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	startE2E, bootGravSim, clickTab, deployBody, predictorRequestId, waitPredictionSettled,
	readProfileTable, rocketSnapshot, setRangeByKeys, captureDownload, chooseFileViaClick,
	writeTempFile, unexpectedProblems
} from './cdp_helpers.mjs';

const CELESTIAL_FIELDS = ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'mass', 'radius', 'color', 'generation', 'rotationAngle', 'param'];
const DEBRIS_FIELDS = ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'mass', 'radius', 'color', 'generation', 'debrisSubType', 'colorTheme', 'baseRadiusM'];
// Design §3.5-1 (Rev 6.10): ROCKET entries do not save `mass`; it is recomputed on load from the stage and payload masses.
const ROCKET_FIELDS = ['id', 'type', 'name', 'x', 'y', 'vx', 'vy', 'dryMass', 'fuelMass', 'oxidMass', 'burnTime', 'thrustForce', 'thrustAngle',
	'radius', 'color', 'generation', 'stages', 'payload', 'fairing', 'boosters', 'flightProfile', 'colorTheme', 'hostId', 'hostAngleRad', 'hostAltM',
	'bottomOffsetM', 'baseRadiusM', 'autoControl', 'disableStaging', 'disableOrbitalCutoff', 'targetApogeeKm', 'targetPerigeeKm', 'targetVInfKmS',
	'isHoldDown', 'isIgnited', 'currentStageIndex', 'totalStages', 'isPayloadSeparated', 'isStage2Separated', 'isBoosterBurnout', 'isBoosterSeparated',
	'hasPayloadPropulsion', 'stageState', 'stgTimer', 'mach', 'rcsCw', 'rcsCcw', 'rcsUllage', 'restoredRuntimeState'];
const FLIGHT_COMPUTER_RUNTIME_FIELDS = ['flightTime', 'targetLaunchAngle', 'highestStepIndex', 'triggeredActionIndices', 'pendingActions', 'hasPassedApogee',
	'apogeeTime', 'prevVv', 'maxRecordedQ', 'hasPassedMaxQ', 'maxQConfirmTimer', 'maxQStatusTimer',
	// Rev 6.11 (G3-1-01, design §4.7)
	'currentThrustAngle', 'isAntiStallActive'];
const ROCKET_RUNTIME_FIELDS = ['isBoosterIgnited', 'boosterBurnTimer', 'boosterSepTimer', 'presState', 'presTimer', 'tankPresFuel', 'tankPresOxid',
	'presStartF', 'presStartO', 'postSepRcsTimer', 'ullageRestartTimer',
	// Rev 6.11 (G3-1-01, design §4.7)
	'thrustRatio', 'wasFiring', 'massLossRate', 'thrustForce', 'thrustForceVac', 'ispVac', 'ispSl', 'ofRatio', 'fuelType', 'hostAngleRad',
	'ventStartF', 'ventStartO', 'noiseFiltF', 'noiseFiltO', 'paramName', 'kinematics'];
const TIME_WARP_SLIDER = -5.8;
// index.html #time-scale (min -7.5, max 1, step 0.1) and #zoom-scale (min -2, max 9, step 0.05)
const TIME_SCALE_RANGE = { min: -7.5, max: 1 };
const SAVED_TIME_SCALE = -4;
const SAVED_ZOOM = 2.5;

/** The System-tab view: slider positions, indicators and the values the simulation and the camera use. */
function readView(page) {
	return page.evaluate(() => ({
		time: Number(document.getElementById('time-scale').value),
		timeText: document.getElementById('time-scale-indicator').textContent,
		timeScale: window.universe.timeScale,
		zoom: Number(document.getElementById('zoom-scale').value),
		zoomText: document.getElementById('zoom-scale-indicator').textContent,
		zoomExp: window.universe.camera.targetZoomExp
	}));
}

/** Every object as plain data (identity and kinematics). */
function readObjects(page) {
	return page.evaluate(() => window.universe.objects.map((o) => ({ id: o.id, type: o.type, name: o.name, x: o.x, y: o.y, vx: o.vx, vy: o.vy })));
}

function launcherState(page) {
	return page.evaluate(() => JSON.parse(JSON.stringify(window.universe.RocketLauncher.getState())));
}

function tableValues(rows) {
	return rows.map((r) => r.cells.slice(0, 5).map((c) => c.value));
}

/** Wait until the main-thread state is frozen (simulation paused and the Worker idle). */
async function waitFrozen(page) {
	await page.waitFor(() => window.universe.isPaused === true, { description: 'paused' });
	let previous = JSON.stringify(await readObjects(page));
	for (;;) {
		await page.waitFrames(10);
		const current = JSON.stringify(await readObjects(page));
		if (current === previous) { return; }
		previous = current;
	}
}

/** Click "Pause" / "Resume" until universe.isPaused === wanted. */
async function setPaused(page, wanted) {
	if (await page.evaluate(() => window.universe.isPaused) !== wanted) {
		await page.click('#pause-resume-btn');
	}
	await page.waitFor((w) => window.universe.isPaused === w, { args: [wanted], description: wanted ? 'paused' : 'running' });
}

describe('System E2E 04: save and load', { timeout: 300000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;
	let preLaunchSave = null;
	const cleanups = [];

	before(async () => {
		env = await startE2E({ downloadDir: true });
		page = env.page;
		await bootGravSim(env);
		await deployBody(page, 'put-earth-btn', 'Earth');
	});

	after(async () => {
		for (const cleanup of cleanups) { cleanup(); }
		if (env) { await env.close(); }
	});

	it('normal: a pre-launch save restores the vehicle, the flight-plan table with actions, the host angle and the thrust-slider max', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-rocket');
		let r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'h3_24');
		await page.selectOption('#rl-flight-profile-body tr:nth-child(2) .fp-trigger', 'vel');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(2) .fp-val', '1234');
		await page.selectOption('#rl-flight-profile-body tr:nth-child(3) .fp-action', 'sep_payload');
		await page.click('#rl-add-profile-btn');
		const lastRow = '#rl-flight-profile-body tr:last-child';
		await page.selectOption(`${lastRow} .fp-trigger`, 'time');
		await page.typeInto(`${lastRow} .fp-val`, '777');
		await page.typeInto(`${lastRow} .fp-thrust`, '50');
		await page.typeInto(`${lastRow} .fp-angle`, '-12');
		await page.selectOption(`${lastRow} .fp-action`, 'sep_stage1');
		assert.equal(await setRangeByKeys(page, '#rl-host-angle', 5), 5);
		await waitPredictionSettled(page, r0);

		const expectedLauncher = await launcherState(page);
		const expectedTable = tableValues(await readProfileTable(page));
		assert.equal(expectedLauncher.currentVehicleId, 'h3_24');
		assert.equal(expectedLauncher.hostAngleDeg, 5);
		assert.deepEqual(expectedTable[1], ['vel', '1234', '100', expectedTable[1][3], '']);
		assert.equal(expectedTable[2][4], 'sep_payload');
		assert.deepEqual(expectedTable[expectedTable.length - 1], ['time', '777', '50', '-12', 'sep_stage1']);
		assert.equal(await page.evaluate(() => document.getElementById('rl-launch-thrust').max), '11500');
		const expectedObjects = await readObjects(page);

		await clickTab(page, 'tab-sys');
		await setPaused(page, true);
		await waitFrozen(page);
		// Time scale and zoom to save (design §4.13, fixed: they were not restored)
		assert.equal(await setRangeByKeys(page, '#time-scale', SAVED_TIME_SCALE), SAVED_TIME_SCALE);
		assert.equal(await setRangeByKeys(page, '#zoom-scale', SAVED_ZOOM), SAVED_ZOOM);
		const savedView = await readView(page);
		assert.equal(savedView.timeScale, Math.pow(10, SAVED_TIME_SCALE));
		assert.equal(savedView.zoomExp, SAVED_ZOOM);
		const pausedObjects = await readObjects(page);
		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		assert.match(download.suggestedFilename, /^GravSim_Data_\d{8}_\d{4}\.json$/);
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8'));
		preLaunchSave = { filePath: download.filePath, saved, view: savedView };
		assert.equal(saved.version, 2);
		assert.deepEqual(Object.keys(saved.universe).sort(), ['cameraOffset', 'centerObjectId', 'controlPanel', 'objectManager', 'rocketLauncher']);
		assert.deepEqual(saved.universe.controlPanel, { controlPanel: { timeScaleVal: SAVED_TIME_SCALE, zoomScaleVal: SAVED_ZOOM } });
		assert.deepEqual(saved.universe.rocketLauncher, expectedLauncher, 'the launcher configuration is saved as shown');
		assert.deepEqual(saved.universe.objectManager.map((o) => [o.id, o.type, o.name]), expectedObjects.map((o) => [o.id, o.type, o.name]));
		for (const o of saved.universe.objectManager) {
			assert.deepEqual(CELESTIAL_FIELDS.filter((k) => !(k in o)), [], `${o.name}: every designed CELESTIAL field is saved`);
		}
		assert.deepEqual(saved.universe.objectManager.map((o) => ({ id: o.id, type: o.type, name: o.name, x: o.x, y: o.y, vx: o.vx, vy: o.vy })), pausedObjects,
			'saved kinematics equal the paused state');

		// Change everything that was saved
		await setPaused(page, false);
		await clickTab(page, 'tab-rocket');
		await page.selectOption('#rl-vehicle-select', 'falcon9');
		await page.click('#rl-flight-profile-body tr:first-child .fp-del');
		await page.click('#rl-flight-profile-body tr:first-child .fp-del');
		assert.equal(await setRangeByKeys(page, '#rl-host-angle', -5), -5);
		const mutated = await launcherState(page);
		assert.equal(mutated.currentVehicleId, 'falcon9');
		assert.notDeepEqual(mutated.flightProfile, expectedLauncher.flightProfile);
		assert.equal(await page.evaluate(() => document.getElementById('rl-launch-thrust').max), '10000');

		await clickTab(page, 'tab-sys');
		// Closing the Rocket tab restored the view from before it opened (design §4.13-10, fixed: it used to leave the
		// tab's minimum time scale and its zoom); change it so the load has to restore it
		assert.deepEqual(await readView(page), savedView, 'closing the Rocket tab restores the view from before it opened');
		assert.equal(await setRangeByKeys(page, '#time-scale', SAVED_TIME_SCALE - 2), SAVED_TIME_SCALE - 2);
		assert.equal(await setRangeByKeys(page, '#zoom-scale', SAVED_ZOOM + 1), SAVED_ZOOM + 1);
		const mutatedView = await readView(page);
		assert.notEqual(mutatedView.time, SAVED_TIME_SCALE);
		assert.notEqual(mutatedView.zoomExp, SAVED_ZOOM);
		await chooseFileViaClick(env, '#load-state-btn', download.filePath);
		await page.waitFor(() => window.universe.RocketLauncher.currentVehicleId === 'h3_24', { description: 'state loaded' });
		await page.waitFrames(3);
		assert.deepEqual(await readView(page), savedView, 'the time scale, the zoom and their indicators are restored');

		assert.deepEqual(await launcherState(page), expectedLauncher, 'the launcher configuration is restored');
		assert.deepEqual(tableValues(await readProfileTable(page)), expectedTable, 'the flight-plan table shows the saved rows and actions');
		const restoredUi = await page.evaluate(() => ({
			vehicle: document.getElementById('rl-vehicle-select').value,
			thrust: [document.getElementById('rl-launch-thrust').value, document.getElementById('rl-launch-thrust').max, document.getElementById('rl-launch-thrust-val').textContent],
			hostAngle: [document.getElementById('rl-host-angle').value, document.getElementById('rl-host-angle-val').textContent],
			fileInput: document.getElementById('load-file-input').value
		}));
		assert.deepEqual(restoredUi, { vehicle: 'h3_24', thrust: ['11500', '11500', '11500'], hostAngle: ['5', '5'], fileInput: '' });
		const loadedObjects = await readObjects(page);
		assert.deepEqual(loadedObjects.map((o) => [o.id, o.type, o.name]), saved.universe.objectManager.map((o) => [o.id, o.type, o.name]));
		assert.deepEqual(page.dialogs, [], 'a valid file opens no dialog');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: an in-flight save restores the rocket and the Worker runtime state, and the flight continues from it', async () => {
		const mark = page.mark();
		await setPaused(page, false);
		await clickTab(page, 'tab-rocket');
		let r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'falcon9');
		await page.selectOption('#rl-mission-select', 'iss_rendezvous');
		await waitPredictionSettled(page, r0);
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rollout' });
		await page.click('#rl-ignite-quick-btn');
		await page.waitFor(() => !window.universe.LaunchSequencer.isActive && !document.querySelector('.tab-btn[data-target="tab-sys"]').disabled,
			{ timeoutMs: 30000, description: 'launch sequence end' });
		await clickTab(page, 'tab-sys');
		assert.equal(await setRangeByKeys(page, '#time-scale', TIME_WARP_SLIDER), TIME_WARP_SLIDER);
		await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.currentStageIndex === 1 && r.stageState === 'STG_BURNING' && r.fairing?.isSeparated === true
				&& window.universe.objects.some((o) => o.type === 2);
		}, { timeoutMs: 40000, description: 'second stage burning after the first separation and the fairing jettison' });
		await setPaused(page, true);
		await waitFrozen(page);

		const live = await rocketSnapshot(page);
		const liveObjects = await readObjects(page);
		const liveDebris = await page.evaluate(() => window.universe.objects.filter((o) => o.type === 2).map((o) => ({ id: o.id, subType: o.debrisSubType })));
		assert.equal(live.stageIndex, 1);
		assert.ok(liveDebris.length >= 1, 'stage 1 debris exists');

		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8'));
		const savedRocket = saved.universe.objectManager.find((o) => o.type === 1);
		assert.ok(savedRocket, 'the rocket is saved');
		assert.deepEqual(ROCKET_FIELDS.filter((k) => !(k in savedRocket)), [], 'every designed ROCKET field is saved');
		assert.equal(savedRocket.restoredRuntimeState, true);
		assert.equal(savedRocket.currentStageIndex, 1);
		assert.equal(savedRocket.stageState, 'STG_BURNING');
		assert.equal(savedRocket.isPayloadSeparated, false);
		assert.equal(savedRocket.fairing.isSeparated, true, 'saved after the fairing jettison');
		assert.equal(savedRocket.isHoldDown, false);
		assert.equal(saved.universe.controlPanel.controlPanel.timeScaleVal, TIME_WARP_SLIDER, 'the time warp is saved');
		assert.equal(savedRocket.fuelMass, live.fuelMass);
		assert.equal(savedRocket.oxidMass, live.oxidMass);
		assert.ok(savedRocket.runtimeState && typeof savedRocket.runtimeState === 'object', 'the Worker runtime snapshot is included');
		assert.deepEqual(Object.keys(savedRocket.runtimeState).sort(), ['flightComputer', ...ROCKET_RUNTIME_FIELDS].sort());
		assert.deepEqual(Object.keys(savedRocket.runtimeState.flightComputer).sort(), [...FLIGHT_COMPUTER_RUNTIME_FIELDS].sort());
		assert.equal(savedRocket.runtimeState.flightComputer.flightTime, live.flightTime, 'the snapshot flight time matches the paused telemetry');
		for (const d of saved.universe.objectManager.filter((o) => o.type === 2)) {
			assert.deepEqual(DEBRIS_FIELDS.filter((k) => !(k in d)), [], `${d.name}: every designed DEBRIS field is saved`);
		}
		assert.deepEqual(saved.universe.objectManager.filter((o) => o.type === 2).map((o) => ({ id: o.id, subType: o.debrisSubType })), liveDebris);
		assert.deepEqual(saved.universe.objectManager.map((o) => ({ id: o.id, type: o.type, name: o.name, x: o.x, y: o.y, vx: o.vx, vy: o.vy })), liveObjects);

		// Fly on and clear the debris so the loaded state must replace a different one
		await setPaused(page, false);
		await page.waitFor((t) => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.telemetry.flightTime > t + 60;
		}, { args: [live.flightTime], timeoutMs: 30000, description: 'flight continues 60 s' });
		// Pause first so no new debris (fairing halves, upper stage) can appear while clearing
		await setPaused(page, true);
		await waitFrozen(page);
		assert.equal(await page.evaluate(() => document.getElementById('clear-debris-chk').checked), true, 'Debris is selected for clearing');
		await page.click('#clear-selected-btn');
		await page.waitFor(() => !window.universe.objects.some((o) => o.type === 2), { description: 'debris cleared' });
		await waitFrozen(page);
		assert.notDeepEqual(await readObjects(page), liveObjects);
		assert.equal(await setRangeByKeys(page, '#time-scale', TIME_WARP_SLIDER - 1), TIME_WARP_SLIDER - 1);

		await chooseFileViaClick(env, '#load-state-btn', download.filePath);
		await page.waitFor((ids) => JSON.stringify(window.universe.objects.map((o) => o.id)) === JSON.stringify(ids),
			{ args: [saved.universe.objectManager.map((o) => o.id)], description: 'saved objects loaded' });
		await page.waitFrames(5);
		assert.deepEqual(await readObjects(page), liveObjects, 'every object is restored at its saved position and velocity');
		const loadedView = await readView(page);
		assert.equal(loadedView.time, TIME_WARP_SLIDER, 'the time warp is restored');
		assert.equal(loadedView.timeScale, Math.pow(10, TIME_WARP_SLIDER));
		// Still paused, so no Worker frame yet: the mass is the attached parts of the save, without the jettisoned
		// fairing (payload + the last stage), the same sum as the Worker's updateTotalMass
		// The HUD refreshes every 100 ms (also while paused): read it after a refresh that follows the load
		const t0 = await page.evaluate(() => performance.now());
		await page.waitFor((t) => window.universe.TelemetryPanel.lastUpdateTime > t, { args: [t0], description: 'HUD refresh after the load' });
		const loadedMass = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			return { paused: window.universe.isPaused, mass: r.mass, text: document.getElementById('tm-mass').textContent.trim() };
		});
		const expectedMass = savedRocket.payload.massT + savedRocket.dryMass + savedRocket.fuelMass + savedRocket.oxidMass;
		assert.equal(loadedMass.paused, true);
		assert.ok(Math.abs(loadedMass.mass - expectedMass) < 1e-9, `mass before the first frame ${loadedMass.mass} t = ${expectedMass} t (no fairing)`);
		assert.equal(loadedMass.text, expectedMass.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 'the HUD shows it');
		const restored = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			return {
				stageIndex: r.currentStageIndex, stageState: r.stageState, fuelMass: r.fuelMass, oxidMass: r.oxidMass,
				isPayloadSeparated: r.isPayloadSeparated, isHoldDown: r.isHoldDown, restoredRuntimeState: r.restoredRuntimeState,
				runtimeState: JSON.parse(JSON.stringify(r.runtimeState)), flightProfile: JSON.parse(JSON.stringify(r.flightProfile)),
				debris: window.universe.objects.filter((o) => o.type === 2).map((o) => ({ id: o.id, subType: o.debrisSubType }))
			};
		});
		assert.deepEqual(restored, {
			stageIndex: 1, stageState: 'STG_BURNING', fuelMass: savedRocket.fuelMass, oxidMass: savedRocket.oxidMass,
			isPayloadSeparated: false, isHoldDown: false, restoredRuntimeState: true,
			runtimeState: savedRocket.runtimeState, flightProfile: savedRocket.flightProfile, debris: liveDebris
		});
		assert.deepEqual(await launcherState(page), saved.universe.rocketLauncher);
		// §4.14-6: the main thread's flight clock continues at the saved flight time (it restarted at 0), before any frame
		assert.equal(await page.evaluate(() => window.universe.objects.find((o) => o.type === 1).flightTime), savedRocket.runtimeState.flightComputer.flightTime,
			'the main clock continues at the saved MET');
		// The voice from here on (the app's EventBus: the same module URL as the page's import)
		await page.evaluate(async () => {
			const { EventBus } = await import('/scripts/gravsim_event_bus.js');
			window.__voiceAfterLoad = [];
			EventBus.on('audio:play', (k) => window.__voiceAfterLoad.push(k));
		});

		// Resume: the Worker continues from the saved flight-computer time and stage, not from the pad
		await setPaused(page, false);
		const resumed = await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.telemetry.flightTime > 0 ? { flightTime: r.telemetry.flightTime, altM: r.telemetry.altM, stageIndex: r.currentStageIndex, stageState: r.stageState } : false;
		}, { intervalMs: 10, description: 'first telemetry after loading' });
		assert.ok(resumed.flightTime >= live.flightTime && resumed.flightTime < live.flightTime + 300,
			`flight time continues from the saved ${live.flightTime} s (got ${resumed.flightTime} s)`);
		assert.equal(resumed.stageIndex, 1, 'still on the second stage');
		assert.equal(resumed.stageState, 'STG_BURNING');
		assert.ok(resumed.altM > live.altM * 0.9, `altitude continues from ${live.altM} m (got ${resumed.altM} m)`);
		const rel = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return { rel: r.telemetry.relativeAltM, alt: r.telemetry.altM, pad: r.hostAltM + r.bottomOffsetM };
		});
		assert.equal(rel.rel, Math.max(0, rel.alt - rel.pad), 'the relative altitude is the height above the pad (§4.14-6)');
		assert.ok(rel.rel > live.altM * 0.9, `not re-based at the load (${rel.rel} m)`);

		await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.isPayloadSeparated;
		}, { timeoutMs: 60000, description: 'payload separation after loading' });
		const end = await rocketSnapshot(page);
		assert.ok(end.flightTime > resumed.flightTime, 'the restored flight reached payload separation');
		const voice = await page.evaluate(async () => {
			const { LAUNCH_SEQUENCES } = await import('/scripts/gravsim_const.js');
			return { played: window.__voiceAfterLoad.slice(), times: Object.values(LAUNCH_SEQUENCES.LEGACY_QUICK.audioProfile.times) };
		});
		assert.deepEqual(voice.played.filter((k) => voice.times.includes(k)), [], `no T+ count after the load (${voice.played})`);
		// Saved in the stage-2 burn after the fairing jettison: these callouts are behind the loaded flight
		const behind = ['fl_tower_clear', 'fl_pitch_roll', 'fl_pitch_downrange', 'fl_traj_nominal', 'fl_telemetry_good', 'fl_meco', 'fl_1-stage_sep', 'fl_ses', 'fl_fairing_sep'];
		assert.deepEqual(voice.played.filter((k) => behind.includes(k)), [], 'no callout of an event before the save');
		assert.ok(voice.played.includes('fl_seco'), `SECO after the load is called out (${voice.played})`);
		assert.equal(new Set(voice.played).size, voice.played.length, 'each callout once');
		await setPaused(page, true);
		assert.deepEqual(page.dialogs, []);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('abnormal: invalid save files open the "Invalid save file." alert and leave the state intact; an empty universe object is accepted without changes', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-sys');
		await setPaused(page, true);
		await waitFrozen(page);
		const beforeObjects = await readObjects(page);
		const beforeLauncher = await launcherState(page);

		// [file name, content, JSON.parse fails (the app logs the parse error)]
		const invalid = [
			['not-json.json', 'this is not JSON {', true],
			['empty.json', '', true],
			['truncated.json', '{"version":2,"universe":{"objectManager":[', true],
			['no-universe.json', '{"version":2}', false],
			['universe-null.json', '{"version":2,"universe":null}', false],
			['universe-array.json', '{"version":2,"universe":[]}', false],
			['universe-string.json', '{"version":2,"universe":"x"}', false],
			['top-level-array.json', '[{"universe":{}}]', false],
			['null.json', 'null', false],
			['number.json', '42', false]
		];
		for (const [name, content, parseFails] of invalid) {
			const file = writeTempFile(name, content);
			cleanups.push(file.cleanup);
			const m = page.mark();
			await chooseFileViaClick(env, '#load-state-btn', file.filePath);
			const deadline = Date.now() + 10000;
			while (page.dialogs.length === m.dialogs && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await page.waitFor(() => document.getElementById('load-file-input').value === '', { description: `${name} handled` });
			assert.deepEqual(page.dialogs.slice(m.dialogs), [{ type: 'alert', message: 'Invalid save file.' }], `${name}: exactly one alert`);
			await page.waitFrames(5);
			assert.deepEqual(await readObjects(page), beforeObjects, `${name}: objects unchanged`);
			assert.deepEqual(await launcherState(page), beforeLauncher, `${name}: launcher unchanged`);
			assert.equal(await page.evaluate(() => document.getElementById('load-file-input').value), '', `${name}: the file input is reset`);
			const problems = page.problemsSince(m);
			if (parseFails) {
				assert.equal(problems.length, 1, `${name}: only the parse error is logged (${problems})`);
				assert.match(problems[0], /^\[console\.error page\] Failed to load state: SyntaxError/);
			} else {
				assert.deepEqual(problems, [], `${name}: nothing logged`);
			}
		}

		// Boundary: a structurally valid file with an empty universe object changes nothing and opens no dialog
		const emptyUniverse = writeTempFile('empty-universe.json', '{"version":2,"universe":{}}');
		cleanups.push(emptyUniverse.cleanup);
		const m = page.mark();
		await chooseFileViaClick(env, '#load-state-btn', emptyUniverse.filePath);
		await page.waitFor(() => document.getElementById('load-file-input').value === '', { description: 'file handled' });
		await page.waitFrames(10);
		assert.equal(page.dialogs.length, m.dialogs, 'no alert for an empty universe object');
		assert.deepEqual(await readObjects(page), beforeObjects);
		assert.deepEqual(page.problemsSince(m), []);

		// Time scale / zoom entries (design §4.13, fixed). [file, controlPanel entry, expected view (null = unchanged)]
		const viewCases = [
			// flat shape of the saves written before the tab split
			['legacy-flat.json', { timeScaleVal: -3, zoomScaleVal: 1.5 }, { time: -3, zoom: 1.5 }],
			// beyond the slider range: clamped to it
			['out-of-range.json', { controlPanel: { timeScaleVal: 5, zoomScaleVal: -10 } }, { time: TIME_SCALE_RANGE.max, zoom: -2 }],
			// not numbers: the current values stay
			['not-numbers.json', { controlPanel: { timeScaleVal: 'fast', zoomScaleVal: null } }, null]
		];
		for (const [name, controlPanel, expected] of viewCases) {
			const before = await readView(page);
			const file = writeTempFile(name, JSON.stringify({ version: 2, universe: { ...preLaunchSave.saved.universe, controlPanel } }));
			cleanups.push(file.cleanup);
			const m = page.mark();
			await chooseFileViaClick(env, '#load-state-btn', file.filePath);
			await page.waitFor(() => document.getElementById('load-file-input').value === '', { description: `${name} handled` });
			await page.waitFrames(5);
			const view = await readView(page);
			if (expected) {
				assert.deepEqual({ time: view.time, zoom: view.zoom, zoomExp: view.zoomExp, timeScale: view.timeScale },
					{ time: expected.time, zoom: expected.zoom, zoomExp: expected.zoom, timeScale: Math.pow(10, expected.time) }, name);
			} else {
				assert.deepEqual(view, before, `${name}: unchanged`);
			}
			assert.equal(page.dialogs.length, m.dialogs, `${name}: no dialog`);
			assert.deepEqual(page.problemsSince(m), [], `${name}: nothing logged`);
		}

		// The app still works: a valid file loads, the simulation runs and a planet can be deployed
		await chooseFileViaClick(env, '#load-state-btn', preLaunchSave.filePath);
		await page.waitFor((ids) => JSON.stringify(window.universe.objects.map((o) => o.id)) === JSON.stringify(ids),
			{ args: [preLaunchSave.saved.universe.objectManager.map((o) => o.id)], description: 'valid file loaded after invalid ones' });
		assert.deepEqual(await launcherState(page), preLaunchSave.saved.universe.rocketLauncher);
		// The object ids already matched (the view cases loaded the same objects): wait for this load to finish
		await page.waitFor(() => document.getElementById('load-file-input').value === '', { description: 'valid file handled' });
		await page.waitFrames(5);
		assert.deepEqual(await readView(page), preLaunchSave.view, 'the valid file restores its time scale and zoom');
		await setPaused(page, false);
		const marsId = await deployBody(page, 'put-mars-btn', 'Mars');
		assert.ok(marsId > 1, 'Mars deployed after the invalid loads');
		const t0 = await page.evaluate(() => window.universe.objects.find((o) => o.name === 'Earth').x);
		await page.waitFor((x) => window.universe.objects.find((o) => o.name === 'Earth').x !== x, { args: [t0], description: 'the simulation still runs' });
		assert.deepEqual(unexpectedProblems(page, mark, [/^\[console\.error page\] Failed to load state: SyntaxError/]), []);
	});

	it('the whole session produced only the expected parse-error logs and alerts', () => {
		assert.deepEqual(unexpectedProblems(page, { exceptions: 0, consoleErrors: 0, logErrors: 0, dialogs: 0 }, [/^\[console\.error page\] Failed to load state: SyntaxError/]), []);
		assert.equal(page.consoleErrors.length, 3, 'one parse error per non-JSON file');
		assert.equal(page.dialogs.length, 10, 'one alert per invalid file');
		assert.ok(page.dialogs.every((d) => d.type === 'alert' && d.message === 'Invalid save file.'));
	});
});
