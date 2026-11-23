/**
 * System E2E 05 (headless Chrome): save / load details of the pre-existing defects fixed in this branch, and the HUD,
 * camera and slider behaviour around them. Split from 04_save_load.test.mjs (the test plan §1-5 keeps each file within
 * 60 s); this file runs its own browser session through cdp_helpers like every system test.
 *
 * Expectations come from docs/design/2026-11-20_trajectory_fx_flightplan.md:
 *  - §4.13-16: a save loaded while the Rocket tab is open replaces every object; closing the tab then keeps the camera
 *    on the loaded center object and does not restore the object tracked before the tab opened (it is gone).
 *  - §4.13-11: the prediction period is saved (rocketLauncher.predictionDurationMonths, not the seconds), restored on
 *    the slider and label, clamped to the slider range (0.2 to 36 months), and a missing or invalid value keeps the
 *    period in use. Label rule of §3.4-4.
 *  - §4.13-9: a rocket loaded after the SRB separation reads "[SRB SEP]" on the STAGE line before the first Worker frame.
 *  - §4.13-13 / -14: a status value the FlightComputer never reports reads PRE-LAUNCH (its initial status) on the
 *    pinned header and the minimal HUD, not LIFTOFF; the separation flag the Worker stopped sending in git e49d500
 *    lights and blinks no lamp (the SEP lamps follow the stage index, steady); WARN and PRESS ignore the inputs nothing
 *    sets on the main thread (target.maxFuel, target.presState) and PRESS follows the tank pressures (threshold 300 kPa,
 *    TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA).
 *  - §4.13-18: the #pred-duration slider range is TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS / MAX_DURATION_MONTHS.
 *  - §4.13-20: real time (1 s per s = 1 / (365.25 x 86400) years per s, exponent log10 of it = -7.4991) is saved as that
 *    exponent and loaded exactly, while the #time-scale slider (step 0.1) shows -7.5 (it ran at 10^-7.5, 0.998 s per s).
 *  - §4.13-21: the annunciator reads a value that is not a status as the header does (PRE_LAUNCH: not launched), so
 *    TWR-C and PITCH stay off for it.
 *  - §4.13-31: a save holds the objects in the simulation only: those cleared just before (still listed while their
 *    trails fade) are not saved, so a load does not bring them back.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
	startE2E, bootGravSim, clickTab, deployBody, predictorRequestId, waitPredictionSettled,
	setRangeByKeys, captureDownload, chooseFileViaClick, writeTempFile, unexpectedProblems
} from './cdp_helpers.mjs';

const TIME_WARP_SLIDER = -5.8;

/** Every object as plain data (identity and kinematics). */
function readObjects(page) {
	return page.evaluate(() => window.universe.objects.map((o) => ({ id: o.id, type: o.type, name: o.name, x: o.x, y: o.y, vx: o.vx, vy: o.vy })));
}

function launcherState(page) {
	return page.evaluate(() => JSON.parse(JSON.stringify(window.universe.RocketLauncher.getState())));
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

/** Wait for a telemetry-panel refresh (every 100 ms, also while paused) that starts after this call. */
async function waitHudRefresh(page) {
	const t0 = await page.evaluate(() => performance.now());
	await page.waitFor((t) => window.universe.TelemetryPanel.lastUpdateTime > t, { args: [t0], description: 'HUD refresh' });
}

/** Prediction-period label rule (design §3.4-4): "<m> mo (<days> d)" below 12 months, else "<m / 12, 1 decimal> yr (<m> mo)". */
const predictionLabel = (m) => (m < 12 ? `${m} mo (${Math.round(m * 365.25 / 12)} d)` : `${(m / 12).toFixed(1)} yr (${m} mo)`);

/** The prediction period in use (launcher) and shown (System-tab slider and label). */
function readPeriod(page) {
	return page.evaluate(() => ({
		value: document.getElementById('pred-duration').value,
		label: document.getElementById('pred-duration-val').textContent,
		months: window.universe.RocketLauncher.predictionDurationMonths,
		sec: window.universe.RocketLauncher.maxSimTimeSec
	}));
}
/** readPeriod() for a period of `m` months on the slider grid. */
// The seconds as the design writes them: months x 365.25 / 12 days x 86400 s
const periodView = (m) => ({ value: String(m), label: predictionLabel(m), months: m, sec: m * (365.25 / 12) * 86400 });

/** Load a save file through the System-tab button and wait until the app has handled it (no dialog expected). */
async function loadFile(env, filePath, name) {
	const page = env.page;
	await chooseFileViaClick(env, '#load-state-btn', filePath);
	await page.waitFor(() => document.getElementById('load-file-input').value === '', { description: `${name} handled` });
	await page.waitFrames(3);
}

/**
 * Put `filePath` into a file input without its button (DOM.setFileInputFiles fires its change event). The Load button is
 * on the System tab, so this is how a load reaches the app while the Rocket tab is open (RocketTab.deferViewState).
 */
async function setFileInput(page, selector, filePath) {
	const { root } = await page.send('DOM.getDocument', { depth: 0 });
	const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
	assert.ok(nodeId, `${selector} exists`);
	await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
}

describe('System E2E 05: save / load of the period, the STAGE line, the HUD fallbacks and the camera target', { timeout: 300000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;
	const cleanups = [];
	/** The H3-22 flight saved after its SRB separation (stage 1 still burning), reused by the id-0 test. */
	let srbSavePath = null;

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

	it('normal / abnormal: a save loaded while the Rocket tab is open: closing the tab keeps the camera on the loaded center object, not the replaced one', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-sys');
		const ids = await page.evaluate(() => ({
			sun: window.universe.objects.find((o) => o.name === 'Sun')?.id,
			earth: window.universe.objects.find((o) => o.name === 'Earth')?.id
		}));
		assert.ok(Number.isInteger(ids.sun) && Number.isInteger(ids.earth), `Sun and Earth exist: ${JSON.stringify(ids)}`);
		const trackById = async (id) => {
			await page.selectOption('#center-select', String(id));
			await page.waitFor((i) => window.universe.camera.trackingTarget?.id === i, { args: [id], description: `tracking ${id}` });
		};
		// The file tracks the Earth
		await trackById(ids.earth);
		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8'));
		assert.equal(saved.universe.centerObjectId, ids.earth, 'the file tracks the Earth');

		// The session tracks its Sun when the Rocket tab opens (the tab saves it as the target to restore on close)
		await trackById(ids.sun);
		await page.evaluate(() => { window.__trackedBeforeTab = window.universe.camera.trackingTarget; });
		await clickTab(page, 'tab-rocket');
		assert.equal(await page.evaluate(() => window.universe.ControlPanel.rocketTab.isOpened), true);
		await setFileInput(page, '#load-file-input', download.filePath);
		await page.waitFor(() => document.getElementById('load-file-input').value === ''
			&& !window.universe.objects.includes(window.__trackedBeforeTab), { description: 'loaded while the Rocket tab is open' });
		assert.equal(await page.evaluate(() => window.universe.ControlPanel.rocketTab.isOpened), true, 'still open');

		await clickTab(page, 'tab-sys');
		await page.waitFrames(3);
		const cam = await page.evaluate(() => {
			const t = window.universe.camera.trackingTarget;
			return { inUniverse: window.universe.objects.includes(t), id: t?.id, name: t?.name, stale: t === window.__trackedBeforeTab };
		});
		assert.deepEqual(cam, { inUniverse: true, id: saved.universe.centerObjectId, name: 'Earth', stale: false },
			'the camera tracks the loaded Earth (design §4.13-16, fixed: it went back to the replaced Sun)');
		// The tracked object is live: it moves with the simulation and the view follows it
		const x0 = await page.evaluate(() => window.universe.camera.trackingTarget.x);
		await page.waitFor((x) => window.universe.camera.trackingTarget.x !== x, { args: [x0], description: 'the tracked Earth moves' });
		await page.evaluate(() => { delete window.__trackedBeforeTab; });
		assert.deepEqual(page.dialogs.slice(mark.dialogs), []);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal / abnormal / boundary: the prediction period is saved, restored on the System-tab slider and label, validated and clamped', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-sys');
		await setPaused(page, true);
		// A period no mission uses, set with the slider (index.html #pred-duration: min 0.2, max 36, step 0.1)
		assert.equal(await setRangeByKeys(page, '#pred-duration', 5), 5);
		assert.deepEqual(await readPeriod(page), periodView(5));
		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8'));
		assert.equal(saved.universe.rocketLauncher.predictionDurationMonths, 5, 'the period is saved with the launcher state');
		assert.equal('maxSimTimeSec' in saved.universe.rocketLauncher, false, 'the derived seconds are not saved');

		// A mission sets its own period (Jupiter transfer: 36 months, presets/missions)
		await clickTab(page, 'tab-rocket');
		const r0 = await predictorRequestId(page);
		await page.selectOption('#rl-mission-select', 'jupiter_transfer');
		await waitPredictionSettled(page, r0);
		await clickTab(page, 'tab-sys');
		assert.deepEqual(await readPeriod(page), periodView(36));

		// Load: the saved period is in use and shown (design §4.13-11, fixed: the mission default stayed)
		await loadFile(env, download.filePath, 'saved file');
		assert.deepEqual(await readPeriod(page), periodView(5), 'the loaded period is on the launcher, the slider and the label');
		assert.deepEqual(await launcherState(page), saved.universe.rocketLauncher);

		// Another period in use, then files with the field missing (saves written before it was saved) or invalid:
		// the period in use stays
		assert.equal(await setRangeByKeys(page, '#pred-duration', 7.5), 7.5);
		const base = saved.universe;
		const withPeriod = (v) => ({ version: 2, universe: { ...base, rocketLauncher: { ...base.rocketLauncher, predictionDurationMonths: v } } });
		const { predictionDurationMonths: _omit, ...legacyLauncher } = base.rocketLauncher;
		const keep = [
			['legacy-no-period.json', { version: 2, universe: { ...base, rocketLauncher: legacyLauncher } }],
			['period-null.json', withPeriod(null)],
			['period-string.json', withPeriod('12')],
			['period-zero.json', withPeriod(0)],
			['period-negative.json', withPeriod(-3)],
			['period-bool.json', withPeriod(true)],
			['period-object.json', withPeriod({ months: 12 })]
		];
		for (const [name, content] of keep) {
			const file = writeTempFile(name, JSON.stringify(content));
			cleanups.push(file.cleanup);
			await loadFile(env, file.filePath, name);
			assert.deepEqual(await readPeriod(page), periodView(7.5), `${name}: the period in use stays`);
		}

		// Boundary: the slider ends and the year-format switch load as saved; beyond the range they are clamped to it
		const cases = [[0.2, 0.2], [36, 36], [11.9, 11.9], [12, 12], [0.1, 0.2], [0.19, 0.2], [36.1, 36], [48, 36], [1e9, 36]];
		for (const [savedMonths, expected] of cases) {
			const file = writeTempFile(`period-${savedMonths}.json`, JSON.stringify(withPeriod(savedMonths)));
			cleanups.push(file.cleanup);
			await loadFile(env, file.filePath, `period ${savedMonths}`);
			assert.deepEqual(await readPeriod(page), periodView(expected), `saved ${savedMonths} months`);
		}
		// Real time (design §4.13-20): a file at real time loads it exactly (the slider shows its nearest step) and a save
		// writes the exponent back unchanged
		const REAL_TIME_EXP = Math.log10(1 / (365.25 * 86400));
		const readTime = () => page.evaluate(() => ({
			timeScale: window.universe.timeScale,
			slider: document.getElementById('time-scale').value,
			text: document.getElementById('time-scale-indicator').textContent
		}));
		const realTimeFile = writeTempFile('real-time.json', JSON.stringify({ version: 2, universe: { ...base, controlPanel: { controlPanel: { ...base.controlPanel.controlPanel, timeScaleVal: REAL_TIME_EXP } } } }));
		cleanups.push(realTimeFile.cleanup);
		await loadFile(env, realTimeFile.filePath, 'real-time file');
		assert.deepEqual(await readTime(), { timeScale: 1 / (365.25 * 86400), slider: '-7.5', text: '1.00 sec/sec' }, 'loaded at real time');
		const realTimeSave = await captureDownload(env, () => page.click('#save-state-btn'));
		assert.equal(JSON.parse(fs.readFileSync(realTimeSave.filePath, 'utf8')).universe.controlPanel.controlPanel.timeScaleVal, REAL_TIME_EXP, 'saved as the exponent');
		assert.equal(page.dialogs.length, mark.dialogs, 'no dialog');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: a rocket loaded after the SRB separation reads "[SRB SEP]" on the STAGE line before the first Worker frame', async () => {
		const mark = page.mark();
		await setPaused(page, false);
		await clickTab(page, 'tab-rocket');
		const r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'h3_22');
		await page.selectOption('#rl-mission-select', 'leo_250km');
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
			return r && r.isBoosterSeparated === true && r.currentStageIndex === 0;
		}, { timeoutMs: 40000, description: 'SRBs separated, stage 1 still burning' });
		await setPaused(page, true);
		await waitFrozen(page);
		const readStage = () => page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			return { text: document.getElementById('tm-stage-info').textContent, stageName: r.stages[0].name, tmFlag: r.telemetry.isBoosterSeparated };
		});
		const live = await readStage();
		assert.equal(live.text, `1 / 2 (${live.stageName}) [SRB SEP]`, 'in flight');
		assert.equal(live.tmFlag, true);

		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8'));
		const savedRocket = saved.universe.objectManager.find((o) => o.type === 1);
		assert.deepEqual([savedRocket.isBoosterSeparated, savedRocket.currentStageIndex, savedRocket.boosters?.count], [true, 0, 2]);
		srbSavePath = download.filePath;

		await loadFile(env, download.filePath, 'SRB-separated save');
		// Still paused, so no Worker frame: the telemetry is the placeholder (no flags) and the STAGE line uses the
		// separation state the rocket holds and saves (design §4.13-9, fixed: it read "[+SRB]" until the first frame)
		await waitHudRefresh(page);
		const loaded = await readStage();
		assert.equal(await page.evaluate(() => window.universe.isPaused), true);
		assert.equal(loaded.tmFlag, undefined, 'no Worker frame yet');
		assert.equal(loaded.text, `1 / 2 (${live.stageName}) [SRB SEP]`, 'before the first frame');
		assert.deepEqual(page.dialogs.slice(mark.dialogs), []);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('abnormal: values the Worker never sends: an unknown status reads PRE-LAUNCH (header and minimal HUD), the removed annunciator inputs light no lamp', async () => {
		const mark = page.mark();
		// The rocket loaded by the previous test, paused before its first Worker frame: nothing replaces its telemetry
		const pre = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			window.__tmBackup = r ? { ...r.telemetry } : null;
			return { rocket: Boolean(r), paused: window.universe.isPaused, open: window.universe.TelemetryPanel.isOpen };
		});
		assert.deepEqual(pre, { rocket: true, paused: true, open: true });
		/** Set fields of the rocket telemetry in the page (`expr` is evaluated there, so NaN / undefined survive) and wait for a refresh. */
		const setTelemetry = async (expr) => {
			await page.evaluate(`(() => { const r = window.universe.objects.find((o) => o.type === 1); r.telemetry = { ...r.telemetry, ...(${expr}) }; })()`);
			await waitHudRefresh(page);
		};
		const text = (id) => page.evaluate((i) => document.getElementById(i).textContent, id);

		// A real status still reads its own text (boundary: 0 is LIFTOFF, the highest code is TRACKING)
		for (const [expr, expected] of [['{ status: 1 }', 'ASCENT'], ['{ status: 0 }', 'LIFTOFF'], ['{ status: 5 }', 'TRACKING']]) {
			await setTelemetry(expr);
			assert.equal(await text('tm-mission-status'), expected, expr);
		}
		// Values that are not a status: the FlightComputer initial status (design §4.13-13, fixed: they read LIFTOFF)
		for (const expr of ['{ status: 6 }', '{ status: -2 }', '{ status: 2.5 }', '{ status: NaN }', '{ status: undefined }', '{ status: null }']) {
			await setTelemetry(expr);
			assert.equal(await text('tm-mission-status'), 'PRE-LAUNCH', `pinned header, ${expr}`);
		}
		// The minimal HUD (telemetry panel closed)
		await page.click('#telemetry-toggle-btn');
		await page.waitFor(() => !window.universe.TelemetryPanel.isOpen, { description: 'telemetry panel closed' });
		for (const expr of ['{ status: 6 }', '{ status: undefined }']) {
			await setTelemetry(expr);
			assert.equal(await text('m-hud-stat'), 'PRE-LAUNCH', `minimal HUD, ${expr}`);
		}
		await page.click('#telemetry-toggle-btn');
		await page.waitFor(() => window.universe.TelemetryPanel.isOpen, { description: 'telemetry panel open' });

		// The annunciator reads such a value as the header does (design §4.13-21): not launched, so the tower-cleared and
		// pitch-program lamps stay off; a real status above the tower lights them
		const launchLamps = async () => page.evaluate(() => ({
			status: document.getElementById('tm-mission-status').textContent,
			...Object.fromEntries(['twr', 'pitch'].map((k) => [k, document.getElementById(`tm-lamp-${k}`).classList.contains('on')]))
		}));
		await page.evaluate(() => { window.universe.TelemetryPanel.lampTestTimer = 0; });
		await setTelemetry('{ status: 1, altM: 5000, flightTime: 30 }');
		assert.deepEqual(await launchLamps(), { status: 'ASCENT', twr: true, pitch: true }, 'ASCENT above the tower');
		for (const expr of ['{ status: 6 }', '{ status: NaN }', '{ status: "1" }']) {
			await setTelemetry(expr);
			assert.deepEqual(await launchLamps(), { status: 'PRE-LAUNCH', twr: false, pitch: false }, `annunciator, ${expr}`);
		}

		// The separation flag of git 5f0628d (no longer sent since e49d500) with the stage index after the stage-1
		// separation: 1-SEP steady, 2-SEP off (design §4.13-14; the removed branch lit and blinked both)
		await setTelemetry('{ status: 4, stageIndex: 1, isStgSepActive: true }');
		const lamps = await page.evaluate(() => Object.fromEntries(['1sep', '2sep'].map((k) => {
			const c = document.getElementById(`tm-lamp-${k}`).classList;
			return [k, { on: c.contains('on'), blink: c.contains('blink') }];
		})));
		assert.deepEqual(lamps, { '1sep': { on: true, blink: false }, '2sep': { on: false, blink: false } });

		// The other inputs nothing sets on the main thread (design §4.13-14): a low-propellant reference (target.maxFuel,
		// 4 % left) and a tank-pressure state (target.presState) light neither WARN nor PRESS; the tank pressures do
		await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			r.maxFuel = r.fuelMass * 25;
			r.presState = 'NOMINAL';
		});
		const warnPress = async () => page.evaluate(() => Object.fromEntries(['warn', 'press'].map((k) => {
			const c = document.getElementById(`tm-lamp-${k}`).classList;
			return [k, { on: c.contains('on'), blink: c.contains('blink') }];
		})));
		assert.equal(await page.evaluate(() => window.universe.objects.find((o) => o.type === 1).isIgnited), true, 'input: an ignited rocket');
		await setTelemetry('{ status: 1, stageIndex: 0, structRatio: 0, isQLimitNear: false, isGLimitNear: false, isAntiStallActive: false, currentG: 1, tankPresFuel: 0, tankPresOxid: 0 }');
		assert.deepEqual(await warnPress(), { warn: { on: false, blink: false }, press: { on: false, blink: false } });
		await setTelemetry('{ tankPresFuel: 300, tankPresOxid: 300 }');
		assert.deepEqual(await warnPress(), { warn: { on: false, blink: false }, press: { on: true, blink: false } }, 'PRESS from the pressures (threshold 300 kPa)');

		await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			delete r.maxFuel;
			delete r.presState;
			r.telemetry = window.__tmBackup;
			delete window.__tmBackup;
		});
		assert.deepEqual(page.dialogs.slice(mark.dialogs), []);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('boundary: the #pred-duration slider range is TRAJECTORY_PREDICTION.MIN / MAX_DURATION_MONTHS of the loaded constants', async () => {
		const r = await page.evaluate(async () => {
			const { TRAJECTORY_PREDICTION } = await import('./scripts/gravsim_const.js');
			const s = document.getElementById('pred-duration');
			return { slider: [Number(s.min), Number(s.max)], constants: [TRAJECTORY_PREDICTION.MIN_DURATION_MONTHS, TRAJECTORY_PREDICTION.MAX_DURATION_MONTHS] };
		});
		assert.deepEqual(r.constants, r.slider);
		assert.deepEqual(r.slider, [0.2, 36], 'index.html');
	});

	it('normal: a saved flight whose rocket has id 0 jettisons its stage 1 and both fairing halves as debris that do not hit it (§4.13-24)', async () => {
		const mark = page.mark();
		assert.ok(srbSavePath, 'input: the SRB-separated H3-22 save of the earlier test');
		// The same file with the rocket's id swapped with the id 0 of the Sun (ids start at 0: an app that loaded an empty
		// save numbers its next objects from 0); every numeric id reference (hosts, parents, center) follows the swap
		const json = JSON.parse(fs.readFileSync(srbSavePath, 'utf8'));
		const rocket = json.universe.objectManager.find((o) => o.type === 1);
		const oldId = rocket.id;
		assert.notEqual(oldId, 0, 'input: the rocket was not id 0');
		const swap = (v) => (v === 0 ? oldId : (v === oldId ? 0 : v));
		const walk = (v) => {
			if (Array.isArray(v)) { v.forEach(walk); return; }
			if (!v || typeof v !== 'object') { return; }
			for (const [k, x] of Object.entries(v)) {
				if ((k === 'id' || /Id$/.test(k)) && typeof x === 'number') { v[k] = swap(x); } else { walk(x); }
			}
		};
		walk(json.universe);
		const file = writeTempFile('rocket-id-0.json', JSON.stringify(json));
		cleanups.push(file.cleanup);
		await clickTab(page, 'tab-sys');
		await loadFile(env, file.filePath, 'rocket id 0 save');
		const loaded = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			return { id: r.id, host: window.universe.objects.find((o) => o.id === r.hostId)?.name, stage: r.currentStageIndex, fairing: r.fairing?.isSeparated };
		});
		assert.deepEqual(loaded, { id: 0, host: 'Earth', stage: 0, fairing: false }, 'the loaded rocket has id 0, before its stage 1 separation');
		await setPaused(page, false);
		await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.id === 0);
			return r && r.currentStageIndex >= 1 && r.fairing?.isSeparated === true;
		}, { timeoutMs: 40000, description: 'stage 1 separated and fairing jettisoned' });
		await page.waitFrames(30);
		await setPaused(page, true);
		const after = await page.evaluate(() => ({
			rocket: window.universe.objects.find((o) => o.type === 1 && o.id === 0)?.state,
			debris: window.universe.objects.filter((o) => o.type === 2 && [1, 3].includes(o.debrisSubType))
				.map((o) => ({ subType: o.debrisSubType, state: o.state }))
		}));
		assert.equal(after.rocket, 0, 'the rocket flies on');
		assert.deepEqual(after.debris.filter((d) => d.state === 0).map((d) => d.subType).sort(), [1, 3, 3], 'stage 1 and two fairing halves fly as debris');
		assert.deepEqual(after.debris.filter((d) => d.state !== 0), [], 'none of them was destroyed (absorbed by the rocket)');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal (§4.13-31): Clear Selected › debris and rockets, then Save at once: the file holds the bodies only, and loading it brings no cleared object back', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-sys');
		await setPaused(page, true);
		const before = await page.evaluate(() => window.universe.objects.filter((o) => o.state === 0).map((o) => ({ id: o.id, type: o.type })));
		assert.ok(before.some((o) => o.type === 1) && before.some((o) => o.type === 2), 'input: a rocket and debris fly (the id-0 flight)');
		for (const [id, wanted] of [['clear-debris-chk', true], ['clear-rocket-chk', true], ['clear-celestial-chk', false]]) {
			if (await page.evaluate((i) => document.getElementById(i).checked, id) !== wanted) { await page.click(`#${id}`); }
		}
		await page.click('#clear-selected-btn');
		const download = await captureDownload(env, () => page.click('#save-state-btn'));
		const listed = await page.evaluate(() => window.universe.objects.filter((o) => o.type !== 0 && o.state !== 0).length);
		assert.ok(listed > 0, `input: cleared objects were still listed (fading out) when the file was written (${listed})`);
		const saved = JSON.parse(fs.readFileSync(download.filePath, 'utf8')).universe.objectManager;
		const bodies = before.filter((o) => o.type === 0).map((o) => o.id);
		assert.deepEqual(saved.map((o) => o.id), bodies, 'the cleared rocket and debris were saved too');
		await loadFile(env, download.filePath, 'save after Clear Selected');
		assert.deepEqual(await page.evaluate(() => window.universe.objects.map((o) => o.id)), bodies, 'the load brings no cleared object back');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('the whole session produced no error, exception or dialog', () => {
		assert.deepEqual(unexpectedProblems(page, { exceptions: 0, consoleErrors: 0, logErrors: 0, dialogs: 0 }), []);
		assert.equal(page.dialogs.length, 0);
	});
});
