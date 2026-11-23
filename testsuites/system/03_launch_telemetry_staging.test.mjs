/**
 * System E2E 03 (headless Chrome): rollout, quick-ignition countdown, liftoff, live telemetry
 * (altitude, speed, Mach) and multi-stage separation of a Falcon 9 on the default ISS plan, driven
 * through the Rocket and System tabs (the time warp is set with the time-scale slider keys).
 *
 * Expectations:
 *  - LAUNCH_SEQUENCES.LEGACY_QUICK (T-3 s countdown, MAIN ENGINE START, LIFTOFF) and the HUD
 *    formatting of #tm-alt (km, 1 decimal) and #tm-vel-v / #tm-vel-h (km/s, 2 decimals).
 *  - Design test plan C / §4.4: Mach is synchronized from the Worker (rocket.mach === telemetry.mach)
 *    and is exactly 0 above the atmosphere limit (Earth atmLimitAlt = 100 km).
 *  - Staging: stage index 0 -> 1, MECO / 1-SEP / 2-ENG / SECO / 2-SEP / P-SEP lamps, debris of the
 *    designed sub types (1 = Stage 1 Booster, 3 = Fairing Half x2, 2 = Stage 2 Upper Stage).
 *  - Design §4.13-20 (fixed): the ignite button runs the simulation at real time exactly, 1 s per s = 1 / (365.25 x
 *    86400) years per s (git e02858f), while the #time-scale slider (step 0.1) shows the nearest step -7.5 (it read the
 *    time scale back from the slider: 10^-7.5, 0.998 s per s).
 *  - Design §4.13-19 (fixed): REF BODY of the Navigation & Camera card names the body of strongest pull (mass /
 *    distance^2 at the rocket, the Worker's rule), Earth, and DIST REF the distance the Worker reports (it read "---").
 *  - Design §4.13 / test plan §4.6 (fixed pre-existing defects): on the pad, before the first Worker frame (the
 *    Rocket tab pauses the simulation), the HUD reads the FlightComputer's initial status PRE-LAUNCH; after the
 *    payload separation the STAGE line reads "PAYLOAD (<payload name>)" (never "3 / 2"), the propulsion card header
 *    "[ PROPULSION: PAYLOAD ]", and the mass is the payload's own (dry + propellant for a self-propelled payload,
 *    the same sum as the Worker's CalcRocket.updateTotalMass).
 * The physics noise (Math.random) only perturbs tank pressure, so only threshold and ordering
 * properties are asserted, never exact flight numbers.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	startE2E, bootGravSim, clickTab, deployBody, predictorRequestId, waitPredictionSettled,
	rocketSnapshot, setRangeByKeys, unexpectedProblems
} from './cdp_helpers.mjs';

const EARTH_ATM_LIMIT_M = 100000; // presets/celestials/earth.json atmLimitAlt
const TIME_WARP_SLIDER = -5.8; // 10^-5.8 * 31,557,600 s/yr / 1000 ~= 50 s per second

/** Sample the flying rocket together with the HUD state. */
function sampleFlight(page) {
	return page.evaluate(() => {
		const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
		if (!r) { return null; }
		const tm = r.telemetry || {};
		return {
			flightTime: tm.flightTime,
			altM: tm.altM,
			speed: Math.hypot(tm.vV || 0, tm.vH || 0),
			mach: r.mach,
			tmMach: tm.mach,
			stageIndex: r.currentStageIndex,
			stageState: r.stageState,
			isPayloadSeparated: Boolean(r.isPayloadSeparated),
			stageInfo: document.getElementById('tm-stage-info').textContent,
			status: document.getElementById('tm-mission-status').textContent,
			propulsionHeader: document.querySelector('#tm-card-propulsion .tm-section-header').textContent,
			payloadName: r.payload?.name,
			lamps: [...document.querySelectorAll('.tm-lamp.on')].map((l) => l.textContent),
			lampTest: window.universe.TelemetryPanel.lampTestTimer > 0,
			debris: window.universe.objects.filter((o) => o.type === 2).map((o) => ({ id: o.id, name: o.name, subType: o.debrisSubType }))
		};
	});
}

describe('System E2E 03: launch, telemetry and staging', { timeout: 240000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;
	let earthId = null;
	let pausedSample = null;

	before(async () => {
		env = await startE2E();
		page = env.page;
		await bootGravSim(env);
		earthId = await deployBody(page, 'put-earth-btn', 'Earth');
		await clickTab(page, 'tab-rocket');
		const r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'falcon9');
		await waitPredictionSettled(page, r0);
	});

	after(async () => {
		if (env) { await env.close(); }
	});

	it('normal: rollout puts the 2-stage rocket on the pad in hold-down and locks the launch controls', async () => {
		const mark = page.mark();
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rocket rolled out' });
		const rocket = await rocketSnapshot(page);
		assert.equal(rocket.isHoldDown, true);
		assert.equal(rocket.stageState, 'PRE_LAUNCH');
		assert.equal(rocket.stageIndex, 0);
		assert.equal(await page.evaluate(() => window.universe.objects.find((o) => o.type === 1).stages.length), 2, 'two stages');

		// The simulation is paused while the Rocket tab is open, so no Worker frame arrives before ignition: the HUD
		// shows the FlightComputer's initial status PRE-LAUNCH (design §4.13, fixed; it used to read "LIFTOFF")
		assert.equal(await page.evaluate(() => window.universe.isPaused), true, 'the Rocket tab pauses the simulation');
		await page.waitFrames(5);
		const pad = await page.evaluate(() => ({
			status: document.getElementById('tm-mission-status').textContent,
			tmStatus: window.universe.objects.find((o) => o.type === 1).telemetry.status,
			lamps: [...document.querySelectorAll('.tm-lamp.on')].map((l) => l.textContent)
		}));
		assert.deepEqual(pad, { status: 'PRE-LAUNCH', tmStatus: -1, lamps: ['AUTO'] }, 'pre-launch HUD: only the AUTO lamp is lit');

		const ui = await page.evaluate(() => {
			const tab = document.getElementById('tab-rocket');
			return {
				ignition: getComputedStyle(document.getElementById('rl-ignition-group')).display,
				abort: getComputedStyle(document.getElementById('rl-abort-btn')).display,
				rollout: getComputedStyle(document.getElementById('rl-rollout-btn')).display,
				igniteEnabled: !document.getElementById('rl-ignite-quick-btn').disabled && !document.getElementById('rl-ignite-full-btn').disabled,
				tabsLocked: [...document.querySelectorAll('.tab-btn')].every((b) => b.disabled),
				slidersLocked: [...tab.querySelectorAll('input[type="range"]')].every((s) => s.disabled),
				profileLocked: [...document.querySelectorAll('#rl-flight-profile-body input, #rl-flight-profile-body select, #rl-flight-profile-body button')].every((el) => el.disabled),
				addLocked: document.getElementById('rl-add-profile-btn').disabled,
				fuelLocked: document.getElementById('rl-fuel-type').disabled,
				hudOpen: document.getElementById('telemetry-panel').classList.contains('open'),
				stageInfo: document.getElementById('tm-stage-info').textContent,
				rocketPoints: window.universe.objects.find((o) => o.type === 1).predictedTrajectory?.points?.length,
				launcherPoints: window.universe.RocketLauncher.currentPrediction?.points?.length,
				hostId: window.universe.objects.find((o) => o.type === 1).hostId
			};
		});
		const { stageInfo, rocketPoints, launcherPoints, ...controls } = ui;
		assert.deepEqual(controls, {
			ignition: 'flex', abort: 'block', rollout: 'none', igniteEnabled: true, tabsLocked: true, slidersLocked: true,
			profileLocked: true, addLocked: true, fuelLocked: true, hudOpen: true, hostId: earthId
		});
		assert.match(stageInfo, /^1 \/ 2 \(.+\)$/);
		assert.ok(rocketPoints >= 2 && rocketPoints === launcherPoints, 'the pad rocket carries the preview prediction');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: quick ignition counts down to liftoff, then altitude, speed and Mach telemetry update', async () => {
		const mark = page.mark();
		await page.click('#rl-ignite-quick-btn');
		// Real time exactly (design §4.13-20); the slider shows its nearest step
		const launchTime = await page.evaluate(() => ({
			timeScale: window.universe.timeScale,
			slider: document.getElementById('time-scale').value,
			text: document.getElementById('time-scale-indicator').textContent
		}));
		assert.deepEqual(launchTime, { timeScale: 1 / (365.25 * 86400), slider: '-7.5', text: '1.00 sec/sec' }, 'real time for the launch');

		// Countdown: T- ticks with the sequence events, then liftoff releases the hold-down
		const seen = { minus: false, plus: false, events: new Set(), holdStatuses: new Set() };
		const deadline = Date.now() + 20000;
		let lifted = false;
		while (Date.now() < deadline && !lifted) {
			const cd = await page.evaluate(() => ({
				shown: document.getElementById('countdown-display').style.display,
				time: document.getElementById('cd-time').textContent,
				event: document.getElementById('cd-event').textContent,
				status: document.getElementById('tm-mission-status').textContent,
				hold: window.universe.objects.find((o) => o.type === 1)?.isHoldDown,
				state: window.universe.objects.find((o) => o.type === 1)?.stageState
			}));
			// index.html shows the placeholder "T - 00:00:00.0" until the first sequencer tick
			if (cd.shown === 'block' && cd.time !== 'T - 00:00:00.0') {
				assert.match(cd.time, /^T [-+] \d{2}:\d{2}\.\d$/, `countdown text "${cd.time}"`);
				if (cd.time.startsWith('T -')) { seen.minus = true; }
				if (cd.time.startsWith('T +')) { seen.plus = true; }
				seen.events.add(cd.event);
			}
			if (cd.hold === true) { seen.holdStatuses.add(cd.status); }
			lifted = cd.hold === false && cd.state === 'STG_BURNING';
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(lifted, true, 'liftoff: hold-down released and stage 1 burning');
		assert.equal(seen.minus, true, 'the countdown showed T- time');
		assert.ok(seen.holdStatuses.has('PRE-LAUNCH'), `the HUD reads PRE-LAUNCH during the countdown (${[...seen.holdStatuses]})`);
		assert.ok(!seen.holdStatuses.has('ASCENT'), 'no ASCENT status while held down');
		assert.ok(!seen.holdStatuses.has('LIFTOFF'), 'no LIFTOFF placeholder while held down');
		assert.ok(seen.events.has('MAIN ENGINE START') || seen.events.has('TANK PRESSURIZATION'), `countdown events: ${[...seen.events]}`);

		await page.waitFor(() => document.getElementById('tm-mission-status').textContent === 'ASCENT', { description: 'ASCENT status' });
		const released = await page.evaluate(() => ({
			padFree: window.universe.RocketLauncher.rolloutedRocketId === null,
			predicted: window.universe.objects.find((o) => o.type === 1).predictedTrajectory?.points?.length || 0
		}));
		assert.equal(released.padFree, true, 'the pad is released at liftoff');
		assert.ok(released.predicted >= 2, 'the flying rocket keeps its predicted trajectory');

		// The sequencer ends 10 s after liftoff and unlocks the tabs; warp time from the System tab
		await page.waitFor(() => !window.universe.LaunchSequencer.isActive && !document.querySelector('.tab-btn[data-target="tab-sys"]').disabled,
			{ timeoutMs: 30000, description: 'launch sequence end' });
		await clickTab(page, 'tab-sys');
		assert.equal(await setRangeByKeys(page, '#time-scale', TIME_WARP_SLIDER), TIME_WARP_SLIDER);
		const warp = await page.evaluate(() => ({ ts: window.universe.timeScale, text: document.getElementById('time-scale-indicator').textContent }));
		assert.equal(warp.ts, Math.pow(10, TIME_WARP_SLIDER));
		assert.equal(warp.text, '50 sec/sec');

		// Supersonic inside the atmosphere: pause and compare the HUD with the synchronized telemetry
		await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.mach > 1.2 && r.telemetry.altM < 60000;
		}, { timeoutMs: 30000, intervalMs: 20, description: 'supersonic below 60 km' });
		await page.click('#pause-resume-btn');
		await page.waitFor(() => window.universe.isPaused === true, { description: 'paused' });
		let previous = await rocketSnapshot(page);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const current = await rocketSnapshot(page);
			if (current.flightTime === previous.flightTime && current.altM === previous.altM) { break; }
			previous = current;
		}
		const hud = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			const tm = r.telemetry;
			return {
				alt: document.getElementById('tm-alt').textContent.trim(),
				velV: document.getElementById('tm-vel-v').textContent.trim(),
				velH: document.getElementById('tm-vel-h').textContent.trim(),
				expectedAlt: (tm.altM / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
				expectedVelV: (tm.vV / 1000).toFixed(2),
				expectedVelH: (tm.vH / 1000).toFixed(2),
				mHudHidden: document.getElementById('minimal-hud-bar').style.display
			};
		});
		assert.equal(hud.alt, hud.expectedAlt, 'ALTITUDE shows the telemetry altitude in km');
		// REF BODY / DIST REF (design §4.13-19): the celestial body of strongest pull at the rocket, from the main-thread objects
		const nav = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			const bodies = window.universe.objects.filter((o) => o.type === 0);
			const pull = (b) => b.mass / ((b.x - r.x) ** 2 + (b.y - r.y) ** 2);
			const strongest = bodies.reduce((a, b) => (pull(b) > pull(a) ? b : a));
			return {
				refBody: document.getElementById('tm-dominant-body').textContent,
				distRef: document.getElementById('tm-dist-ref').textContent.trim(),
				strongest: strongest.name,
				idMatches: r.dominantBodyId === strongest.id,
				expectedDist: (r.distToDominantM / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
			};
		});
		assert.equal(nav.strongest, 'Earth', 'input: Earth pulls hardest');
		assert.equal(nav.idMatches, true, 'the Worker reports it as the dominant body');
		assert.deepEqual({ refBody: nav.refBody, distRef: nav.distRef }, { refBody: 'Earth', distRef: nav.expectedDist }, 'REF BODY and DIST REF');
		assert.equal(hud.velV, hud.expectedVelV, 'VEL (V) shows the telemetry vertical speed in km/s');
		assert.equal(hud.velH, hud.expectedVelH, 'VEL (H) shows the telemetry horizontal speed in km/s');
		pausedSample = await rocketSnapshot(page);
		assert.equal(pausedSample.mach, pausedSample.tmMach, 'Mach is synchronized from the Worker telemetry');
		assert.ok(pausedSample.mach > 1.2 && pausedSample.mach < 10, `supersonic Mach ${pausedSample.mach}`);
		assert.ok(pausedSample.altM > 1000 && pausedSample.altM < EARTH_ATM_LIMIT_M, `inside the atmosphere (${pausedSample.altM} m)`);

		await page.click('#pause-resume-btn');
		await page.waitFor(() => window.universe.isPaused === false, { description: 'resumed' });

		// Climb above the atmosphere: Mach becomes exactly 0 above the 100 km limit
		const samples = [];
		const climbDeadline = Date.now() + 40000;
		while (Date.now() < climbDeadline) {
			const s = await sampleFlight(page);
			samples.push(s);
			if (s.altM > 130000) { break; }
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
		const last = samples[samples.length - 1];
		assert.ok(last.altM > 130000, `climbed above 130 km (${last.altM} m)`);
		for (let i = 1; i < samples.length; i++) {
			assert.ok(samples[i].flightTime >= samples[i - 1].flightTime, 'flight time never goes back');
		}
		assert.ok(last.flightTime > pausedSample.flightTime, 'flight time advanced after resuming');
		assert.ok(last.speed > Math.hypot(pausedSample.vV, pausedSample.vH), 'the vehicle accelerated');
		const above = samples.filter((s) => s.altM > EARTH_ATM_LIMIT_M);
		// The telemetry altitude is the FlightComputer's reading at the start of the last sub-step, while Mach comes from the
		// aerodynamics evaluated after that sub-step's move, so within one frame's climb (tens of metres) below the limit the
		// two can straddle it (backlog H1-14). Samples in the 1 km band below the limit are therefore not used as "inside".
		const ATM_BOUNDARY_BAND_M = 1000;
		const inside = samples.filter((s) => s.altM > 1000 && s.altM < EARTH_ATM_LIMIT_M - ATM_BOUNDARY_BAND_M);
		assert.ok(above.length > 0 && inside.length > 0, 'samples on both sides of the atmosphere limit');
		for (const s of above) {
			assert.equal(s.mach, 0, `Mach is 0 above the atmosphere (alt ${s.altM} m)`);
			assert.equal(s.tmMach, 0);
		}
		for (const s of inside) {
			assert.ok(Number.isFinite(s.mach) && s.mach > 0, `Mach is positive inside the atmosphere (alt ${s.altM} m, Mach ${s.mach})`);
			assert.equal(s.mach, s.tmMach);
		}
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: staging progresses through MECO, stage 1 separation, fairing jettison, SECO and payload separation', async () => {
		const mark = page.mark();
		const samples = [];
		const debrisSeen = new Map();
		const deadline = Date.now() + 90000;
		while (Date.now() < deadline) {
			const s = await sampleFlight(page);
			assert.ok(s, 'the rocket stays alive');
			samples.push(s);
			for (const d of s.debris) {
				if (!debrisSeen.has(d.id)) { debrisSeen.set(d.id, { ...d, stageIndexWhenSeen: s.stageIndex, payloadSeparatedWhenSeen: s.isPayloadSeparated }); }
			}
			if (s.isPayloadSeparated && s.lamps.includes('P-SEP')) { break; }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const last = samples[samples.length - 1];
		assert.equal(last.isPayloadSeparated, true, 'the payload separated');

		for (let i = 1; i < samples.length; i++) {
			assert.ok(samples[i].stageIndex >= samples[i - 1].stageIndex, 'the stage index never decreases');
		}
		// STAGE line (design §4.13, fixed): "N / 2 (...)" with N <= 2 while a stage is attached, "PAYLOAD (<name>)" after.
		// The HUD refreshes every 100 ms; a sample whose P-SEP lamp is lit comes from a refresh after the separation.
		for (const s of samples) {
			const m = s.stageInfo.match(/^(\d+) \/ (\d+) \(/);
			if (s.isPayloadSeparated && !s.lampTest && s.lamps.includes('P-SEP')) {
				assert.equal(s.stageInfo, `PAYLOAD (${s.payloadName})`, `stage info after the payload separation: "${s.stageInfo}"`);
				assert.equal(s.propulsionHeader, '[ PROPULSION: PAYLOAD ]');
			} else if (m) {
				assert.ok(Number(m[1]) <= Number(m[2]), `stage number within the stage count: "${s.stageInfo}"`);
			}
		}
		assert.equal(last.stageIndex, 2, 'the Worker reports the stage count as the index after the separation');
		assert.equal(last.stageInfo, `PAYLOAD (${last.payloadName})`);
		const lit = (s, lamp) => !s.lampTest && s.lamps.includes(lamp);
		const stage2Burning = samples.filter((s) => s.stageIndex === 1 && s.stageState === 'STG_BURNING' && !s.isPayloadSeparated);
		assert.ok(stage2Burning.length > 0, 'the second stage burned');
		for (const s of stage2Burning) {
			assert.match(s.stageInfo, /^2 \/ 2 \(.+\)$/, `stage info while stage 2 burns: "${s.stageInfo}"`);
			assert.ok(lit(s, 'MECO') && lit(s, '1-SEP') && lit(s, '2-ENG'), `MECO, 1-SEP and 2-ENG lit during the stage 2 burn (${s.lamps})`);
			assert.ok(!lit(s, '1-ENG'), 'the stage 1 engine lamp is off');
		}
		const stage1Burning = samples.filter((s) => s.stageIndex === 0 && s.stageState === 'STG_BURNING');
		for (const s of stage1Burning) {
			assert.ok(lit(s, '1-ENG') && !lit(s, '1-SEP') && !lit(s, 'P-SEP'), `1-ENG lit, 1-SEP / P-SEP off during the stage 1 burn (${s.lamps})`);
		}
		assert.ok(lit(last, 'SECO') && lit(last, '2-SEP') && lit(last, 'P-SEP'), `SECO, 2-SEP and P-SEP lit after payload separation (${last.lamps})`);

		const debris = [...debrisSeen.values()];
		const ofType = (t) => debris.filter((d) => d.subType === t);
		assert.equal(ofType(1).length, 1, 'one Stage 1 Booster debris');
		assert.equal(ofType(1)[0].name, 'Stage 1 Booster');
		assert.equal(ofType(1)[0].stageIndexWhenSeen, 1, 'the booster appears with the stage 1 separation');
		assert.equal(ofType(3).length, 2, 'two fairing halves');
		assert.ok(ofType(3).every((d) => d.name === 'Fairing Half'));
		assert.equal(ofType(2).length, 1, 'one Stage 2 Upper Stage debris');
		assert.equal(ofType(2)[0].name, 'Stage 2 Upper Stage');
		assert.equal(ofType(2)[0].payloadSeparatedWhenSeen, true, 'the upper stage is jettisoned with the payload separation');
		assert.deepEqual(debris.filter((d) => ![1, 2, 3].includes(d.subType)), [], 'no other debris type on a vehicle without SRBs');

		// Mass after the separation (design §4.13, fixed): the self-propelled HTV-X alone, its dry mass plus the propellant
		// left (the payload mass was counted on top of it); paused so the HUD and the object show the same frame
		await page.click('#pause-resume-btn');
		await page.waitFor(() => window.universe.isPaused === true, { description: 'paused' });
		await page.waitFrames(10);
		const mass = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return {
				selfPropelled: Boolean(r.hasPayloadPropulsion && r.payload?.propulsion?.enabled),
				mass: r.mass,
				parts: r.dryMass + r.fuelMass + r.oxidMass,
				payloadMassT: r.payload.massT,
				text: document.getElementById('tm-mass').textContent.trim()
			};
		});
		assert.equal(mass.selfPropelled, true, 'the default ISS payload (HTV-X) has its own propulsion');
		assert.equal(mass.mass, mass.parts, 'mass = dry + propellant of the payload');
		assert.ok(mass.mass <= mass.payloadMassT, `no more than the payload's launch mass (${mass.mass} <= ${mass.payloadMassT} t)`);
		assert.equal(mass.text, mass.parts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 'the HUD shows it');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: paused, the dominant body cleared: REF BODY / DIST REF and the Navi tab ref body / altitude / velocity all read none (§4.13-26)', async () => {
		const mark = page.mark();
		assert.equal(await page.evaluate(() => window.universe.isPaused), true, 'input: still paused after the staging test');
		// The card shows the rocket (telemetry target); the Navi tab lists no rocket: it shows the Sun, whose strongest
		// pull is Earth's (the only other body)
		const ids = await page.evaluate(() => ({
			rocket: window.universe.objects.find((o) => o.type === 1 && o.state === 0).id,
			sun: window.universe.objects.find((o) => o.name === 'Sun').id
		}));
		const readRef = async () => {
			const t0 = await page.evaluate(() => performance.now());
			await page.waitFor((t) => window.universe.TelemetryPanel.lastUpdateTime > t, { args: [t0], description: 'HUD refresh' });
			// A change of the Navi target refreshes the Navi stats at once
			await page.selectOption('#nv-target-select', String(ids.sun));
			return page.evaluate(() => ({
				ref: document.getElementById('tm-dominant-body').textContent,
				dist: document.getElementById('tm-dist-ref').textContent.trim(),
				nvRef: document.getElementById('nv-ref-body').textContent,
				nvAlt: document.getElementById('nv-alt').textContent,
				nvVel: document.getElementById('nv-vel').textContent
			}));
		};
		await clickTab(page, 'tab-navi');
		const live = await readRef();
		const input = await page.evaluate(({ rocket, sun }) => {
			const o = (id) => window.universe.objects.find((x) => x.id === id);
			return {
				rocketRef: o(rocket).dominantBodyId, sunRef: o(sun).dominantBodyId,
				dist: (o(rocket).distToDominantM / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
			};
		}, ids);
		assert.deepEqual([input.rocketRef, input.sunRef], [earthId, earthId], 'input: Earth is the dominant body of the rocket and of the Sun');
		assert.deepEqual([live.ref, live.dist, live.nvRef], ['Earth', input.dist, 'Earth'], 'REF BODY and DIST REF of the rocket, Ref Body of the Sun');
		assert.match(live.nvAlt, /^[\d,]+ km$/);
		assert.match(live.nvVel, /^\d+\.\d\d km\/s$/);

		// System tab "Clear Selected" with only the celestial bodies (the Sun, id 0, is kept): Earth fades out of the list
		await clickTab(page, 'tab-sys');
		for (const [id, wanted] of [['clear-debris-chk', false], ['clear-rocket-chk', false], ['clear-celestial-chk', true]]) {
			if (await page.evaluate((i) => document.getElementById(i).checked, id) !== wanted) { await page.click(`#${id}`); }
		}
		await page.click('#clear-selected-btn');
		await page.waitFor((e) => !window.universe.objects.some((o) => o.id === e), { args: [earthId], timeoutMs: 30000, description: 'Earth removed' });
		const held = await page.evaluate(({ rocket, sun }) => {
			const o = (id) => window.universe.objects.find((x) => x.id === id);
			return { refs: [o(rocket).dominantBodyId, o(sun).dominantBodyId], dist: o(rocket).distToDominantM, paused: window.universe.isPaused };
		}, ids);
		assert.ok(held.paused && held.refs[0] === earthId && held.refs[1] === earthId && held.dist > 0, 'input: no Worker frame since, the objects hold the last one');
		await clickTab(page, 'tab-navi');
		assert.deepEqual(await readRef(), { ref: '---', dist: '---', nvRef: 'NONE', nvAlt: '--- km', nvVel: '--- km/s' }, 'no distance, altitude or speed without the body');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('the whole session produced no exceptions, console errors or dialogs', () => {
		assert.deepEqual(page.problems(), []);
		assert.deepEqual(page.dialogs, []);
	});
});
