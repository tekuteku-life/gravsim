/**
 * System E2E 01 (headless Chrome): infrastructure, boot, body / launch-pad placement through the UI,
 * and the predicted trajectory (computed by the Worker and drawn on the canvas), including the
 * prediction-duration slider boundaries.
 *
 * Expectations come from docs/design/2026-11-20_trajectory_fx_flightplan.md:
 *  - §4.3 end reasons, guarantees 1 (drawn angle step <= 0.15 rad), 2 (<= MAX_POINTS, strictly
 *    increasing time, maxSimTime = last point time), 3 (LEO/ISS/GTO presets: step_budget and >= 1
 *    drawn revolution after the frame switch even at 0.2 months) and 4(a) (deep-space presets in the
 *    Sun+Earth world: horizon/point_budget with reach >= 99.5 %).
 *  - §4.10 drawn frame (surface-fixed until frameSwitchTime, host-centred inertial after it).
 *  - index.html slider #pred-duration: min 0.2, max 36 months (months * 365.25 / 12 days).
 *  - Design §4.13-12 (fixed pre-existing defect): without a rocket (before the first rollout, after an abort) the HUD
 *    header reads TRACKING, "T+ ---y ---d --:--:--" and "---".
 *  - Design §4.13-27: after System › Reset All (the id counter keeps counting) the Sun is the world center: the Rocket
 *    tab takes it as the automatic host and replaces it by a deployed Earth, and Deploy › Binary Star System keeps it
 *    as "Sun A" next to "Sun B" (the stars and planets of DEPLOY_PROFILES.BINARY_SYSTEM), as on a fresh page.
 *  - Design §4.13-31 (removed objects are not live): the Rocket tab offers the celestial bodies in the simulation as
 *    hosts (no impact fragment, no removed asteroid); after Reset no object of the old world comes back with a Worker
 *    frame that was on its way (the impact fragments of the collision test did, as "Jettisoned Debris").
 *  - Design §4.13-32: Deploy › Galactic Center replaces the world center by Sagittarius A* (one Sun, around it).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	startE2E, bootGravSim, launchChrome, rawGet, mimeTypeFor, makeTempDir, PageSession,
	clickTab, deployBody, predictorRequestId, waitPredictionSettled, predictionSummary,
	setRangeByKeys, rocketSnapshot, unexpectedProblems,
	PREDICTION_END_REASONS, MAX_PREDICTION_POINTS, MAX_DRAWN_ANGLE_STEP_RAD, SECONDS_PER_MONTH, PROJECT_ROOT
} from './cdp_helpers.mjs';

/** Prediction period of the Mars-transfer mission (input: presets/missions/mars_transfer.json). */
const MARS_MONTHS = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'presets', 'missions', 'mars_transfer.json'), 'utf8')).predictionDurationMonths;
/** Label rule of the prediction slider (design §3.4-4): "<m> mo (<days> d)" below 12 months, else "<m / 12, 1 decimal> yr (<m> mo)". */
const predictionLabel = (m) => (m < 12 ? `${m} mo (${Math.round(m * 365.25 / 12)} d)` : `${(m / 12).toFixed(1)} yr (${m} mo)`);

/** Guarantees 1 and 2 of design §4.3 for any prediction produced by the app. */
function assertPredictionInvariants(summary, label) {
	assert.ok(summary, `${label}: a prediction exists`);
	assert.ok(PREDICTION_END_REASONS.includes(summary.endReason), `${label}: endReason ${summary.endReason} is one of ${PREDICTION_END_REASONS}`);
	assert.ok(summary.points >= 2, `${label}: at least 2 points (got ${summary.points})`);
	assert.ok(summary.points <= MAX_PREDICTION_POINTS, `${label}: points ${summary.points} <= ${MAX_PREDICTION_POINTS}`);
	assert.equal(summary.strictlyIncreasing, true, `${label}: point times strictly increase`);
	assert.equal(summary.allFinite, true, `${label}: all point coordinates are finite`);
	assert.equal(summary.maxSimTime, summary.lastTime, `${label}: maxSimTime equals the last point time`);
	assert.ok(summary.maxSimTime <= summary.requestedSec, `${label}: maxSimTime ${summary.maxSimTime} does not exceed the requested ${summary.requestedSec}`);
	assert.equal(summary.hasPhiSurf, true, `${label}: points carry r/phiSurf for the drawn frame`);
	assert.ok(summary.maxDrawnStep <= MAX_DRAWN_ANGLE_STEP_RAD, `${label}: max drawn angle step ${summary.maxDrawnStep} <= ${MAX_DRAWN_ANGLE_STEP_RAD} rad`);
	assert.equal(summary.hostId, summary.launcherHostId, `${label}: prediction host is the launcher host`);
	assert.equal(summary.impactEvents > 0, summary.endReason === 'impact', `${label}: an impact event exists only when endReason is impact`);
}

/**
 * With the canvas settled, hide the predicted trajectory with the HUD "PRED" toggle and show it again:
 * the teal prediction pixels must disappear while hidden and the same image must come back.
 * The telemetry panel must already be open.
 * @param {import('./cdp_helpers.mjs').PageSession} page
 * @param {string} label
 */
async function assertPredictionToggleRedraws(page, label) {
	const shown = await page.waitCanvasStable();
	assert.ok(shown.predictionPixels > 0, `${label}: predicted line pixels are drawn (${shown.predictionPixels})`);
	await page.click('#tm-show-pred-chk');
	await page.waitFor(() => window.universe.showPredictedTrajectory === false, { description: 'PRED hidden' });
	assert.equal(await page.evaluate(() => document.getElementById('show-predicted-path-chk').checked), false,
		`${label}: the System tab checkbox follows the HUD toggle`);
	await page.waitFrames(3);
	const hidden = await page.canvasSummary();
	assert.equal(hidden.predictionPixels, 0, `${label}: no prediction pixels while hidden`);
	assert.notEqual(hidden.hash, shown.hash, `${label}: hiding the prediction changes the image`);
	await page.click('#tm-show-pred-chk');
	await page.waitFor(() => window.universe.showPredictedTrajectory === true, { description: 'PRED shown' });
	await page.waitFrames(3);
	const reshown = await page.canvasSummary();
	assert.equal(reshown.hash, shown.hash, `${label}: showing PRED again redraws exactly the same image`);
	return shown;
}

/** Guarantee 3 of design §4.3 (LEO / ISS / GTO presets). */
function assertClosedOrbitGuarantee(summary, label) {
	assertPredictionInvariants(summary, label);
	assert.equal(summary.endReason, 'step_budget', `${label}: closed host orbit ends by step_budget`);
	assert.ok(summary.frameSwitchTime !== null && summary.frameSwitchTime > 0, `${label}: the drawn frame switches to inertial (frameSwitchTime=${summary.frameSwitchTime})`);
	assert.ok(summary.revolutionsAfterSwitch >= 1, `${label}: >= 1 drawn revolution after the frame switch (got ${summary.revolutionsAfterSwitch})`);
	assert.ok(summary.lastTime < summary.requestedSec, `${label}: the step budget ends before the requested duration`);
}

/** Guarantee 4(a) of design §4.3 (deep-space presets, Sun+Earth world). */
function assertDeepSpaceGuarantee(summary, label) {
	assertPredictionInvariants(summary, label);
	assert.ok(['horizon', 'point_budget'].includes(summary.endReason), `${label}: endReason ${summary.endReason} is horizon or point_budget`);
	const reach = summary.lastTime / summary.requestedSec;
	assert.ok(reach >= 0.995, `${label}: reach ${reach} >= 99.5 %`);
	if (summary.endReason === 'horizon') {
		assert.equal(summary.lastTime, summary.requestedSec, `${label}: horizon ends exactly at the requested duration`);
	}
}

describe('System E2E 01: boot, placement and trajectory prediction', { timeout: 240000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;
	let earthId = null;

	before(async () => {
		env = await startE2E();
		page = env.page;
	});

	after(async () => {
		if (env) { await env.close(); }
	});

	it('infrastructure: the static server serves the repository with correct MIME types and refuses path traversal', async () => {
		const port = env.server.port;
		assert.equal(env.server.origin, `http://127.0.0.1:${port}`);
		assert.ok(port > 0, 'listen(0) assigned an ephemeral port');

		const cases = [
			['/index.html', 'text/html; charset=utf-8'],
			['/', 'text/html; charset=utf-8'],
			['/scripts/gravsim.js', 'text/javascript; charset=utf-8'],
			['/scripts/gravsim_calc.js?v=123', 'text/javascript; charset=utf-8'],
			['/presets/missions/manifest.json', 'application/json; charset=utf-8'],
			['/style.css', 'text/css; charset=utf-8'],
			['/icons/icon.svg', 'image/svg+xml'],
			['/manifest.json', 'application/json; charset=utf-8']
		];
		for (const [url, type] of cases) {
			const res = await rawGet(port, url);
			assert.equal(res.status, 200, `${url} is served`);
			assert.equal(res.contentType, type, `${url} has MIME type ${type}`);
		}
		assert.ok((await rawGet(port, '/index.html')).body.includes('<canvas id="gravsim-canvas">'));
		assert.deepEqual(JSON.parse((await rawGet(port, '/presets/missions/manifest.json')).body),
			JSON.parse(fs.readFileSync(new URL('../../presets/missions/manifest.json', import.meta.url), 'utf8')));
		assert.equal(mimeTypeFor('app.webmanifest'), 'application/manifest+json');
		assert.equal(mimeTypeFor('module.mjs'), 'text/javascript; charset=utf-8');
		assert.equal(mimeTypeFor('README'), 'application/octet-stream');

		assert.equal((await rawGet(port, '/does-not-exist.js')).status, 404);
		for (const traversal of ['/../package.json', '/scripts/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd',
			'/scripts/..%2f..%2f..%2fetc%2fpasswd', '/%5c..%5c..%5cetc%5cpasswd']) {
			const res = await rawGet(port, traversal);
			assert.equal(res.status, 403, `${traversal} is refused`);
			assert.equal(res.body, 'Forbidden', `${traversal} leaks no file content`);
		}
		assert.equal((await rawGet(port, '/index.html%00.js')).status, 400, 'NUL bytes are rejected');
		assert.equal((await rawGet(port, '/%E0%A4%A')).status, 400, 'malformed percent-encoding is rejected');
	});

	it('infrastructure: a missing Chromium binary fails loudly instead of skipping', async () => {
		// Count profile creations in this process (other system test files run in parallel processes
		// and create their own temporary directories, so a /tmp listing would race with them).
		const originalMkdtemp = fs.mkdtempSync;
		const created = [];
		fs.mkdtempSync = (...args) => {
			const dir = originalMkdtemp(...args);
			created.push(dir);
			return dir;
		};
		let controlDirs;
		try {
			// Positive control: the spy sees the helper module's own mkdtempSync calls
			const control = makeTempDir('gravsim-e2e-spy-');
			controlDirs = [...created];
			control.remove();
			created.length = 0;
			await assert.rejects(launchChrome({ chromePath: '/nonexistent/chromium-for-gravsim-e2e' }),
				/Chromium is not available at "\/nonexistent\/chromium-for-gravsim-e2e".*CHROME_PATH/);
		} finally {
			fs.mkdtempSync = originalMkdtemp;
		}
		assert.equal(controlDirs.length, 1, 'the mkdtempSync spy observes the helpers');
		assert.deepEqual(created, [], 'no temporary profile is created for a missing binary');
	});

	it('infrastructure: the collectors catch page and Web Worker exceptions, console errors and alerts (no false negatives)', async () => {
		// A separate probe tab on the test server's origin, so the app session stays clean
		const { targetId } = await env.conn.send('Target.createTarget', { url: 'about:blank' });
		const { sessionId } = await env.conn.send('Target.attachToTarget', { targetId, flatten: true });
		const probe = new PageSession(env.conn, sessionId, targetId);
		try {
			await probe.installCollectors();
			const loaded = probe.waitForEvent('Page.loadEventFired');
			await probe.send('Page.navigate', { url: `${env.server.origin}/manifest.json` });
			await loaded;
			await probe.evaluate(() => {
				console.error('e2e-probe console error');
				setTimeout(() => { throw new Error('e2e-probe page exception'); }, 0);
				const src = "console.error('e2e-probe worker console'); throw new Error('e2e-probe worker exception');";
				// Keep a reference so the Worker is not collected before it runs
				window.__e2eProbeWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
				return true;
			});
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline && !(probe.exceptions.some((e) => e.source.startsWith('worker:'))
				&& probe.exceptions.some((e) => e.source === 'page') && probe.consoleErrors.length >= 2)) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(probe.exceptions.some((e) => e.source === 'page' && e.text.includes('e2e-probe page exception')), `page exception caught: ${JSON.stringify(probe.exceptions)}`);
			assert.ok(probe.exceptions.some((e) => e.source.startsWith('worker:blob:') && e.text.includes('e2e-probe worker exception')), `worker exception caught: ${JSON.stringify(probe.exceptions)}`);
			assert.ok(probe.consoleErrors.some((e) => e.source === 'page' && e.text === 'e2e-probe console error'), 'page console.error caught');
			assert.ok(probe.consoleErrors.some((e) => e.source.startsWith('worker:') && e.text === 'e2e-probe worker console'), 'worker console.error caught');

			await probe.evaluate(() => { setTimeout(() => alert('e2e-probe alert'), 0); return true; });
			const dialogDeadline = Date.now() + 10000;
			while (probe.dialogs.length === 0 && Date.now() < dialogDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.deepEqual(probe.dialogs, [{ type: 'alert', message: 'e2e-probe alert' }]);
			assert.equal(await probe.evaluate(() => 1 + 1), 2, 'the page is responsive after the alert was accepted');
		} finally {
			probe.dispose();
			await env.conn.send('Target.closeTarget', { targetId });
		}
		assert.deepEqual(page.problems(), [], 'the app tab saw none of the probe errors');
		assert.deepEqual(page.dialogs, []);
	});

	it('normal: the app boots with both Workers, no console errors and no uncaught exceptions', async () => {
		const mark = page.mark();
		const firstRequest = env.server.requests.length;
		await bootGravSim(env);
		await page.waitFrames(30);
		await page.waitFor(() => document.getElementById('info-count').textContent.trim() === '1',
			{ description: 'info panel object count' });

		assert.deepEqual(page.problems(), [], 'no exceptions, console errors or log errors during boot');
		assert.deepEqual(unexpectedProblems(page, mark), []);
		assert.deepEqual(page.dialogs, [], 'no dialog opened');
		const appRequests = env.server.requests.slice(firstRequest);
		assert.ok(appRequests.some((r) => r.url === '/index.html'), 'the page was served by the test server');
		assert.deepEqual(appRequests.filter((r) => r.status !== 200), [], 'every file the app requested exists');

		const workerUrls = [...page.workers.values()];
		assert.equal(workerUrls.length, 2, 'physics and predictor Workers are running');
		assert.ok(workerUrls.some((u) => /\/scripts\/gravsim_calc\.js\?v=\d+$/.test(u)), 'physics Worker attached');
		assert.ok(workerUrls.some((u) => /\/scripts\/gravsim_calc_predictor\.js$/.test(u)), 'predictor Worker attached');

		const state = await page.evaluate(() => ({
			objects: window.universe.objects.map((o) => ({ id: o.id, name: o.name, type: o.type })),
			loaderDisplay: document.getElementById('bootstrap-loader').style.display,
			vehicles: window.presetManager.getVehicles().map((v) => v.id).sort(),
			missions: window.presetManager.getMissions().map((m) => m.id).sort(),
			sidebarWidth: document.getElementById('ctrl-panel').offsetWidth,
			activeTab: document.querySelector('.tab-btn.active').dataset.target
		}));
		assert.deepEqual(state.objects, [{ id: 0, name: 'Sun', type: 0 }]);
		assert.equal(state.loaderDisplay, 'none');
		assert.deepEqual(state.vehicles, ['epsilon', 'falcon9', 'h3_22', 'h3_24', 'h3_30', 'ssto']);
		assert.deepEqual(state.missions, JSON.parse(fs.readFileSync(new URL('../../presets/missions/manifest.json', import.meta.url), 'utf8')).sort(),
			'every mission preset from presets/missions/manifest.json is loaded');
		assert.equal(state.sidebarWidth, 320, 'the sidebar is 320 px wide');
		assert.equal(state.activeTab, 'tab-sys');
		const canvas = await page.canvasSummary();
		assert.deepEqual([canvas.width, canvas.height], [1400, 900], 'canvas fills the 1400x900 viewport');
		assert.ok(canvas.litPixels > 0, 'the scene is drawn');
	});

	it('normal: Earth is placed from the Deploy tab and the Rocket tab sets up the launch pad with a drawn prediction', async () => {
		const mark = page.mark();
		earthId = await deployBody(page, 'put-earth-btn', 'Earth');
		assert.equal(earthId, 1);
		const placed = await page.evaluate(() => ({
			names: window.universe.objects.map((o) => o.name),
			tracking: window.universe.camera.trackingTarget?.name
		}));
		assert.deepEqual(placed.names, ['Sun', 'Earth']);
		assert.equal(placed.tracking, 'Earth', 'the camera follows the deployed planet');

		const r0 = await predictorRequestId(page);
		await clickTab(page, 'tab-rocket');
		const pad = await page.evaluate(() => {
			const rl = window.universe.RocketLauncher;
			const sel = document.getElementById('rl-host-select');
			return {
				paused: window.universe.isPaused,
				previewActive: rl.isActive,
				hostId: rl.hostId,
				hostSelectValue: sel.value,
				hostSelectText: sel.options[sel.selectedIndex]?.textContent,
				statHost: document.getElementById('rl-stat-host-name').textContent,
				mode: document.getElementById('rl-mode-select').value
			};
		});
		assert.deepEqual(pad, {
			paused: true, previewActive: true, hostId: earthId, hostSelectValue: String(earthId),
			hostSelectText: `Earth (ID: ${earthId})`, statHost: 'Earth', mode: 'host'
		});

		// open() computes a synchronous prediction immediately, then the Worker result replaces it
		assertPredictionInvariants(await predictionSummary(page), 'sync preview');
		await waitPredictionSettled(page, r0);
		const summary = await predictionSummary(page);
		assertPredictionInvariants(summary, 'Worker preview');

		// Drawn on the canvas: teal prediction pixels exist only while PRED is shown
		await page.click('#telemetry-toggle-btn');
		await page.waitFor(() => document.getElementById('telemetry-panel').classList.contains('open'), { description: 'telemetry panel open' });
		// No rocket yet: the pinned header shows the tracking placeholder (design §4.13-12, fixed: the status was
		// TELEMETRY.STATUS_MAP[6], undefined, so index.html's "PRE-LAUNCH" stayed). Read it after a HUD refresh.
		const tOpen = await page.evaluate(() => performance.now());
		await page.waitFor((t) => window.universe.TelemetryPanel.lastUpdateTime > t, { args: [tOpen], description: 'HUD refresh after opening' });
		assert.deepEqual(await page.evaluate(() => ({
			status: document.getElementById('tm-mission-status').textContent,
			time: document.getElementById('tm-met').textContent,
			stage: document.getElementById('tm-stage-info').textContent
		})), { status: 'TRACKING', time: 'T+ ---y ---d --:--:--', stage: '---' }, 'header without a rocket');
		const shown = await assertPredictionToggleRedraws(page, 'preview');
		assert.ok(shown.predictionPixels > 1000, `the whole preview line is on screen (${shown.predictionPixels} px)`);
		await page.click('#telemetry-toggle-btn');
		await page.waitFor(() => !document.getElementById('telemetry-panel').classList.contains('open'), { description: 'telemetry panel closed' });

		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('boundary: prediction duration slider at 0.2 and 36 months (ISS on H3-22, closed host orbit)', async () => {
		const mark = page.mark();
		let r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'h3_22');
		await page.selectOption('#rl-mission-select', 'iss_rendezvous');
		await waitPredictionSettled(page, r0);
		assertClosedOrbitGuarantee(await predictionSummary(page), 'ISS mission default duration');

		await clickTab(page, 'tab-sys');
		await page.focus('#pred-duration');
		r0 = await predictorRequestId(page);
		await page.pressKey('Home');
		await waitPredictionSettled(page, r0);
		const atMin = await page.evaluate(() => ({
			value: document.getElementById('pred-duration').value,
			min: document.getElementById('pred-duration').min,
			label: document.getElementById('pred-duration-val').textContent,
			months: window.universe.RocketLauncher.predictionDurationMonths,
			sec: window.universe.RocketLauncher.maxSimTimeSec
		}));
		assert.deepEqual(atMin, { value: '0.2', min: '0.2', label: '0.2 mo (6 d)', months: 0.2, sec: 0.2 * SECONDS_PER_MONTH });
		const issMin = await predictionSummary(page);
		assert.equal(issMin.requestedSec, 0.2 * SECONDS_PER_MONTH);
		assertClosedOrbitGuarantee(issMin, 'ISS 0.2 months');

		// Below the minimum: the slider stays at 0.2 and no new prediction is requested
		const rMin = await predictorRequestId(page);
		await page.pressKey('ArrowLeft');
		await page.waitFrames(20);
		assert.equal(await page.evaluate(() => document.getElementById('pred-duration').value), '0.2');
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.maxSimTimeSec), 0.2 * SECONDS_PER_MONTH);
		assert.equal(await predictorRequestId(page), rMin, 'no prediction request below the minimum');

		// Just above the minimum
		r0 = await predictorRequestId(page);
		await page.pressKey('ArrowRight');
		await waitPredictionSettled(page, r0);
		assert.equal(await page.evaluate(() => document.getElementById('pred-duration').value), '0.3');
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.maxSimTimeSec), 0.3 * SECONDS_PER_MONTH);
		assertClosedOrbitGuarantee(await predictionSummary(page), 'ISS 0.3 months');

		r0 = await predictorRequestId(page);
		await page.pressKey('End');
		await waitPredictionSettled(page, r0);
		const atMax = await page.evaluate(() => ({
			value: document.getElementById('pred-duration').value,
			max: document.getElementById('pred-duration').max,
			label: document.getElementById('pred-duration-val').textContent,
			months: window.universe.RocketLauncher.predictionDurationMonths,
			sec: window.universe.RocketLauncher.maxSimTimeSec
		}));
		assert.deepEqual(atMax, { value: '36', max: '36', label: '3.0 yr (36 mo)', months: 36, sec: 36 * SECONDS_PER_MONTH });
		assertClosedOrbitGuarantee(await predictionSummary(page), 'ISS 36 months');

		// Above the maximum: unchanged, no new request
		const rMax = await predictorRequestId(page);
		await page.pressKey('ArrowRight');
		await page.waitFrames(20);
		assert.equal(await page.evaluate(() => document.getElementById('pred-duration').value), '36');
		assert.equal(await predictorRequestId(page), rMax, 'no prediction request above the maximum');

		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('boundary: prediction duration slider at 36 and 0.2 months (Mars transfer on H3-30, host-escape orbit)', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-rocket');
		let r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'h3_30');
		await page.selectOption('#rl-mission-select', 'mars_transfer');
		await waitPredictionSettled(page, r0);
		assertDeepSpaceGuarantee(await predictionSummary(page), 'Mars mission default duration');

		// Choosing the mission set its period (12 months) on the launcher and the System-tab slider, whatever the previous
		// test left there (36); End then moves the slider to 36 months, a change, so the launcher receives it
		await clickTab(page, 'tab-sys');
		assert.deepEqual(await page.evaluate(() => ({
			value: document.getElementById('pred-duration').value,
			label: document.getElementById('pred-duration-val').textContent,
			months: window.universe.RocketLauncher.predictionDurationMonths
		})), { value: String(MARS_MONTHS), label: predictionLabel(MARS_MONTHS), months: MARS_MONTHS }, 'the mission period is on the slider');
		await page.focus('#pred-duration');
		r0 = await predictorRequestId(page);
		await page.pressKey('End');
		await waitPredictionSettled(page, r0);
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.maxSimTimeSec), 36 * SECONDS_PER_MONTH);
		assertDeepSpaceGuarantee(await predictionSummary(page), 'Mars 36 months');

		r0 = await predictorRequestId(page);
		await page.pressKey('Home');
		await waitPredictionSettled(page, r0);
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.maxSimTimeSec), 0.2 * SECONDS_PER_MONTH);
		assertDeepSpaceGuarantee(await predictionSummary(page), 'Mars 0.2 months');

		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: with the Moon added, a rocket rolled out to the pad sits on Earth at the chosen angle and abort clears it', async () => {
		const mark = page.mark();
		const moonId = await deployBody(page, 'put-moon-btn', 'Moon');
		assert.deepEqual(await page.evaluate(() => window.universe.objects.map((o) => o.name)), ['Sun', 'Earth', 'Moon']);

		await clickTab(page, 'tab-rocket');
		const hosts = await page.evaluate(() => {
			const sel = document.getElementById('rl-host-select');
			return { value: sel.value, options: [...sel.options].map((o) => o.textContent) };
		});
		assert.deepEqual(hosts, { value: String(earthId), options: ['Sun (ID: 0)', `Earth (ID: ${earthId})`, `Moon (ID: ${moonId})`] },
			'Earth stays the default host; every celestial body is selectable');

		assert.equal(await setRangeByKeys(page, '#rl-host-angle', 30), 30);
		assert.deepEqual(await page.evaluate(() => [window.universe.RocketLauncher.hostAngleDeg, document.getElementById('rl-host-angle-val').textContent]), [30, '30']);

		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.objects.some((o) => o.type === 1), { description: 'rocket placed' });
		const geometry = await page.evaluate(async () => {
			const { UnitConvertUtils } = await import('/scripts/gravsim_utils.js');
			const rl = window.universe.RocketLauncher;
			const rocket = window.universe.objects.find((o) => o.type === 1);
			const host = window.universe.objects.find((o) => o.id === rl.hostId);
			return {
				distM: UnitConvertUtils.pix2m(Math.hypot(rocket.x - host.x, rocket.y - host.y)),
				expectedDistM: host.radius + rl.getBottomOffsetM() + rl.hostAltitudeM,
				angleRad: Math.atan2(rocket.y - host.y, rocket.x - host.x),
				hostId: rocket.hostId,
				rolloutedId: rl.rolloutedRocketId,
				rocketId: rocket.id,
				predictedPoints: rocket.predictedTrajectory?.points?.length,
				launcherPoints: rl.currentPrediction?.points?.length,
				ignitionShown: getComputedStyle(document.getElementById('rl-ignition-group')).display,
				rolloutShown: getComputedStyle(document.getElementById('rl-rollout-btn')).display,
				tabsLocked: [...document.querySelectorAll('.tab-btn')].every((b) => b.disabled)
			};
		});
		assert.ok(Math.abs(geometry.distM - geometry.expectedDistM) < 1, `rocket stands on the pad: ${geometry.distM} m vs ${geometry.expectedDistM} m from Earth's centre`);
		assert.ok(Math.abs(geometry.angleRad - (30 - 90) * Math.PI / 180) < 1e-6, `pad at host angle 30 deg (canvas ${geometry.angleRad} rad)`);
		assert.equal(geometry.hostId, earthId);
		assert.equal(geometry.rolloutedId, geometry.rocketId);
		assert.equal(geometry.predictedPoints, geometry.launcherPoints, 'the rolled-out rocket carries the launcher prediction');
		assert.equal(geometry.ignitionShown, 'flex');
		assert.equal(geometry.rolloutShown, 'none');
		assert.equal(geometry.tabsLocked, true, 'tabs are locked while the rocket is on the pad');
		const onPad = await rocketSnapshot(page);
		assert.equal(onPad.isHoldDown, true);
		assert.equal(onPad.stageState, 'PRE_LAUNCH');

		assert.equal(await page.evaluate(() => document.getElementById('telemetry-panel').classList.contains('open')), true,
			'rollout opens the telemetry HUD');
		await assertPredictionToggleRedraws(page, 'rocket on the pad');

		await page.click('#rl-abort-btn');
		await page.waitFor(() => !window.universe.objects.some((o) => o.type === 1) && window.universe.RocketLauncher.rolloutedRocketId === null,
			{ description: 'rocket removed after abort' });
		const aborted = await page.evaluate(() => ({
			names: window.universe.objects.map((o) => o.name),
			rolloutShown: getComputedStyle(document.getElementById('rl-rollout-btn')).display,
			ignitionShown: getComputedStyle(document.getElementById('rl-ignition-group')).display,
			tabsLocked: [...document.querySelectorAll('.tab-btn')].some((b) => b.disabled)
		}));
		assert.deepEqual(aborted, { names: ['Sun', 'Earth', 'Moon'], rolloutShown: 'block', ignitionShown: 'none', tabsLocked: false });
		assertPredictionInvariants(await predictionSummary(page), 'preview after abort');
		// The HUD stays open with no rocket left: its header returns to the tracking placeholder (design §4.13-12, fixed:
		// the status line went blank after showing the rocket's PRE-LAUNCH)
		const tAbort = await page.evaluate(() => performance.now());
		await page.waitFor((t) => window.universe.TelemetryPanel.lastUpdateTime > t, { args: [tAbort], description: 'HUD refresh after the abort' });
		assert.deepEqual(await page.evaluate(() => ({
			open: document.getElementById('telemetry-panel').classList.contains('open'),
			status: document.getElementById('tm-mission-status').textContent,
			time: document.getElementById('tm-met').textContent,
			stage: document.getElementById('tm-stage-info').textContent
		})), { open: true, status: 'TRACKING', time: 'T+ ---y ---d --:--:--', stage: '---' }, 'header after the abort');

		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: clearing a burning rocket ("Clear Selected", rockets only) silences its engine roar at once, while it is still listed (§4.13-23)', async () => {
		const mark = page.mark();
		// The Rocket tab is open after the abort of the previous test
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rollout' });
		await page.click('#rl-ignite-quick-btn');
		await page.waitFor(() => !window.universe.LaunchSequencer.isActive && !document.querySelector('.tab-btn[data-target="tab-sys"]').disabled,
			{ timeoutMs: 30000, description: 'launch sequence end' });
		const before = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			const se = window.universe.SoundEffects;
			return { id: r.id, firing: Boolean(r.isIgnited && r.thrustRatio > 0.01 && !r.isHoldDown), audio: se.audioCtx?.state, roar: se.voices.engineRoar?.isRunning };
		});
		assert.deepEqual({ firing: before.firing, audio: before.audio, roar: before.roar }, { firing: true, audio: 'running', roar: true }, 'input: the engine fires and roars');

		await clickTab(page, 'tab-sys');
		for (const [id, wanted] of [['clear-debris-chk', false], ['clear-rocket-chk', true], ['clear-celestial-chk', false]]) {
			if (await page.evaluate((i) => document.getElementById(i).checked, id) !== wanted) { await page.click(`#${id}`); }
		}
		await page.click('#clear-selected-btn');
		// The roar stops within its 120 ms release; a destroyed rocket stays listed while its trail fades (several seconds)
		await page.waitFor(() => window.universe.SoundEffects.voices.engineRoar.isRunning === false, { timeoutMs: 2000, description: 'the roar stopped' });
		const after = await page.evaluate((id) => {
			const r = window.universe.objects.find((o) => o.id === id);
			return { listed: Boolean(r), state: r?.state, isDestroyed: r?.isDestroyed };
		}, before.id);
		assert.deepEqual(after, { listed: true, state: 1, isDestroyed: true }, 'the roar stopped while the destroyed rocket was still listed');
		await page.waitFor((id) => !window.universe.objects.some((o) => o.id === id), { args: [before.id], timeoutMs: 30000, description: 'the destroyed rocket is cleaned up' });
		assert.equal(await page.evaluate(() => window.universe.SoundEffects.voices.engineRoar.isRunning), false, 'and it never played again');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: two asteroids that collide make the DebrisGenerator fragments of the Worker debris mass (§4.13-23)', async () => {
		const mark = page.mark();
		const asteroidT = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'presets', 'celestials', 'asteroid.json'), 'utf8')).mass;
		const result = await page.evaluate(async () => {
			const { UnitConvertUtils } = await import('/scripts/gravsim_utils.js');
			const C = await import('/scripts/gravsim_const.js');
			const u = window.universe;
			const sun = u.objects.find((o) => o.name === 'Sun');
			const px = UnitConvertUtils.m2pix;
			const x0 = sun.x + px(1.3e11);
			// 300 m apart, closing at 400 m/s: far above their escape speed
			u.ObjectPlacer.placeObject('Asteroid', x0, sun.y, px(200), 0);
			u.ObjectPlacer.placeObject('Asteroid', x0 + px(300), sun.y, px(-200), 0);
			return { minFrag: C.DEBRIS.MIN_FRAG, mult: C.DEBRIS.IMPACT_FRAG_MASS_LOG_MULT, maxRatio: C.COLLISION_CONFIG.MAX_DEBRIS_RATIO };
		});
		// Equal masses: the debris ratio is clamped to MAX_DEBRIS_RATIO; DebrisGenerator: max(MIN_FRAG, floor(log10(t) x MULT))
		const debrisT = asteroidT * result.maxRatio;
		const expected = Math.max(result.minFrag, Math.floor(Math.log10(debrisT) * result.mult));
		const fragments = await page.waitFor((n) => {
			const list = window.universe.objects.filter((o) => o.type === 2 && o.name === 'Asteroid Debris');
			return list.length >= n ? list.map((o) => o.mass) : false;
		}, { args: [expected], timeoutMs: 15000, description: `${expected} impact fragments` });
		assert.equal(fragments.length, expected, `${expected} fragments of ${debrisT} t`);
		const sum = fragments.reduce((a, b) => a + b, 0);
		assert.ok(sum >= debrisT * 0.8 && sum <= debrisT * 1.2, `fragment mass ${sum} t of ${debrisT} t (each 0.8 to 1.2 x the mean)`);

		// §4.13-31: the launch hosts are the celestial bodies in the simulation: the Sun, Earth, the Moon and the asteroid
		// that won the impact; not the fragments, nor the loser (listed while its trail fades)
		await page.waitFor(() => window.universe.objects.some((o) => o.name === 'Asteroid' && o.state !== 0), { description: 'input: the loser is listed, removed' });
		await clickTab(page, 'tab-rocket');
		const hosts = await page.evaluate(() => Array.from(document.getElementById('rl-host-select').options).map((o) => {
			const obj = window.universe.objects.find((x) => String(x.id) === o.value);
			return { text: o.textContent, name: obj?.name, state: obj?.state };
		}));
		assert.deepEqual(hosts.map((h) => h.name).sort(), ['Asteroid', 'Earth', 'Moon', 'Sun'], `hosts: ${hosts.map((h) => h.text).join(', ')}`);
		assert.deepEqual(hosts.filter((h) => h.state !== 0), [], 'none removed');
		await clickTab(page, 'tab-sys');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal (§4.13-27, -31): after System › Reset All only the Sun is left (no object comes back), the Rocket tab\'s automatic Sun gives way to Earth, and Binary Star System has Sun A and Sun B as on a fresh page', async () => {
		const mark = page.mark();
		const maxIdBefore = await page.evaluate(() => Math.max(...window.universe.objects.map((o) => o.id)));
		assert.ok(await page.evaluate(() => window.universe.objects.some((o) => o.type === 2 && o.state === 0)), 'input: the impact fragments fly');
		await clickTab(page, 'tab-sys');
		// Hold the main thread for 150 ms when the button is clicked, before its handler runs: the Worker frames made
		// meanwhile (before the Worker gets the removals of the Reset) are on their way when the Reset has run, every time
		// (a busy page does the same; without it the race depends on the timing of the confirm dialog)
		await page.evaluate(() => {
			document.addEventListener('click', (e) => {
				if (e.target?.id !== 'reset-all-btn') { return; }
				const t0 = performance.now();
				while (performance.now() - t0 < 150) { /* frames queue up */ }
			}, { capture: true, once: true });
		});
		// The confirm dialog of the button is accepted by the session (checked in the last test)
		await page.click('#reset-all-btn');
		const sun = await page.waitFor(() => {
			const list = window.universe.objects.filter((o) => o.state === 0 && o.type === 0);
			return (list.length === 1 && list[0].name === 'Sun') ? { id: list[0].id, isWorldCenter: list[0].isWorldCenter } : false;
		}, { description: 'only the Sun after Reset' });
		// The Worker frames that were on their way when Reset removed every object bring nothing back (§4.13-31: they
		// brought the impact fragments back as "Jettisoned Debris", which then stayed); this test checked the bodies only
		await page.waitFrames(30);
		const after = await page.evaluate(() => ({
			listed: window.universe.objects.map((o) => `${o.name} (${o.id})`),
			count: document.getElementById('info-count').textContent.trim()
		}));
		assert.deepEqual(after, { listed: [`Sun (${sun.id})`], count: '1' }, 'nothing of the old world on the main thread');
		assert.ok(sun.id > maxIdBefore, `the id counter keeps counting across Reset (${sun.id} > ${maxIdBefore})`);

		// Repro (b): the Rocket tab with only the Sun takes it as the automatic host; a deployed Earth replaces it
		await clickTab(page, 'tab-rocket');
		assert.deepEqual(await page.evaluate(() => [window.universe.RocketLauncher.hostId, document.getElementById('rl-host-select').value]),
			[sun.id, String(sun.id)]);
		const earthId = await deployBody(page, 'put-earth-btn', 'Earth');
		await page.waitFor((id) => window.universe.RocketLauncher.hostId === id, { args: [earthId], description: 'Earth becomes the launch host' });
		// The frames of the world after Reset are applied (none of them is taken for one of the replaced world)
		const x0 = await page.evaluate((id) => window.universe.objects.find((o) => o.id === id).x, earthId);
		await page.waitFor((id, x) => window.universe.objects.find((o) => o.id === id).x !== x, { args: [earthId, x0], description: 'Earth moves with the Worker frames' });

		// Repro (a): the profile's stars and planets (gravsim_const.js DEPLOY_PROFILES.BINARY_SYSTEM), as from a fresh page
		const expected = await page.evaluate(async () => {
			const { DEPLOY_PROFILES } = await import('/scripts/gravsim_const.js');
			const g = DEPLOY_PROFILES.BINARY_SYSTEM.generators[0];
			return [g.primary.name, g.secondary.name, ...g.planets.map((p) => p.template), ...g.planets.filter((p) => p.hasMoon).map(() => 'Moon')].sort();
		});
		assert.deepEqual(expected, ['Earth', 'Jupiter', 'Moon', 'Sun A', 'Sun B'], 'input: the profile');
		await page.click('#put-binary-star-btn');
		const names = await page.waitFor((n) => {
			const list = window.universe.objects.filter((o) => o.state === 0 && o.type === 0).map((o) => o.name).sort();
			return list.length === n ? list : false;
		}, { args: [expected.length], description: 'the binary system' });
		assert.deepEqual(names, expected, 'both stars (the defect left only Sun B)');
		const sunA = await page.evaluate(() => {
			const s = window.universe.objects.find((o) => o.name === 'Sun A' && o.state === 0);
			return { id: s.id, isWorldCenter: s.isWorldCenter };
		});
		assert.deepEqual(sunA, { id: sun.id, isWorldCenter: true }, 'the Sun of the Reset became Sun A');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal (§4.13-32): Deploy › Galactic Center replaces the world center: Sagittarius A* at the center, one Sun (around it), the stars of the profile', async () => {
		const mark = page.mark();
		// Input: the profile (gravsim_const.js DEPLOY_PROFILES.GALACTIC_CENTER) and the names of its templates (presets)
		const expected = await page.evaluate(async () => {
			const { DEPLOY_PROFILES, RENDER } = await import('/scripts/gravsim_const.js');
			const defs = DEPLOY_PROFILES.GALACTIC_CENTER.staticObjects;
			const nameOf = (t) => window.presetManager.getObjectParam(t).NAME;
			// Its center: the static object placed without a host, at the profile's coordinates
			const def = defs.find((d) => !d.host);
			return { names: defs.map((d) => nameOf(d.template)).sort(), center: nameOf(def.template), def: { x: def.x, y: def.y }, pxPerAu: RENDER.DISTANCE_SCALE };
		});
		assert.equal(expected.center, 'Sagittarius A*', 'input');
		const oldCenter = await page.evaluate(() => window.universe.ObjectManager.getWorldCenter().id);
		await clickTab(page, 'tab-deploy');
		await page.click('#put-galactic-center-btn');
		// The profile is placed in one task: once its center is there, so is the rest
		const world = await page.waitFor((name, def) => {
			const live = window.universe.objects.filter((o) => o.state === 0);
			if (!live.some((o) => o.name === name)) { return false; }
			const center = window.universe.ObjectManager.getWorldCenter();
			return {
				names: live.map((o) => o.name).sort(),
				centers: live.filter((o) => o.isWorldCenter).map((o) => o.name),
				// Distance from the profile's place in px: the frames since the deploy move it by far less than 0.01 AU
				center: center && { name: center.name, offPx: Math.hypot(center.x - def.x, center.y - def.y) },
				tracking: window.universe.camera.trackingTarget?.name
			};
		}, { args: [expected.center, expected.def], description: 'the Galactic Center world' });
		assert.deepEqual(world.names, expected.names, 'the profile\'s bodies only (the old world center, here the binary\'s Sun A, stayed beside Sgr A* before)');
		assert.equal(world.names.filter((n) => n === 'Sun').length, 1, 'one Sun');
		assert.deepEqual(world.centers, [expected.center]);
		assert.equal(world.center.name, expected.center);
		assert.ok(world.center.offPx / expected.pxPerAu < 0.01, `at the profile's place (${world.center.offPx / expected.pxPerAu} AU from it; the page's Sun was 4.6 AU away)`);
		assert.equal(world.tracking, expected.center, 'the camera follows it');
		const old = await page.evaluate((id) => window.universe.objects.find((o) => o.id === id)?.state ?? 'gone', oldCenter);
		assert.ok(old === 1 || old === 'gone', `the old center (Sun A) was removed (${old})`);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('the whole session produced no exceptions, console errors or dialogs (but the confirm of Reset All)', () => {
		assert.deepEqual(page.problems(), []);
		assert.deepEqual(page.dialogs, [{ type: 'confirm', message: 'Are you sure you want to reset the universe?' }]);
	});
});
