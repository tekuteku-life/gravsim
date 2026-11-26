/**
 * System E2E 06 (headless Chrome): the vapor cone and the cold-gas RCS jets of a real Falcon 9 flight (default ISS
 * plan) come from the drawn hull (design docs/design/2026-11-23_vapor_cone_rcs_anchors.md, §5.3).
 *
 * The flight is driven through the real UI (Earth, Falcon 9, Rollout, Quick ignition, the System-tab time warp and the
 * pause button). The transonic window is short (intensity >= 0.55 from T+57.5 s to T+63.2 s, 114 ms of wall time at
 * 50x), so the flight is paused well before it and the time scale is changed while paused.
 *
 * Expectations:
 *  - §3.4 / §3.5: the primary cone's vertex is the drawn fairing base (noseShoulder, (1.600, 0.650) R in stage-1
 *    flight) and the secondary cone's vertex the drawn interstage's forward edge, i.e. the start of stage 2
 *    (interstageShoulder, (0.400, 0.700) R); the cone sizes follow the body radius at each vertex.
 *  - §1.5 / §5.3: the cloud (pixels that differ from the same rocket drawn at Mach 0, outside the hull + 1 px) starts
 *    where the primary cone's outline first leaves the hull (±2 px), and nothing differs ahead of the fairing base + 1 px.
 *  - §3.6.1: after the stage-1 separation (fairing still attached) the RCS jets start on the stage-2 wall (±r2) within
 *    [startX, startX + length] of stage 2, outside the drawn fairing, at the nozzles of layout.rcs (table §3.4:
 *    forward 0.408 R, aft -0.432 R, wall 0.650 R). Each drawn jet also has the role of its flag in the §3.6.1 table,
 *    built here and not read from layout.rcs (§5.3 item 7): cw fires forward from -h towards -y and aft from +h
 *    towards +y, ccw the mirror, the ullage pair aft canted by ULLAGE_CANT_RAD, so swapping cw and ccw or the forward
 *    and aft stations fails. Which flag is set when the flight pauses varies between runs (it is logged).
 *  - §3.11: the frozen preset snapshots raise no TypeError; the whole session has no exception, console error or dialog.
 * The drawn copy has thrustAngle 0 (axis along +x, so the cloud is judged column by column); performance.now and
 * Math.random are fixed while drawing so that the engine plume is the same in both images.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	startE2E, bootGravSim, clickTab, deployBody, predictorRequestId, waitPredictionSettled,
	setRangeByKeys, unexpectedProblems
} from './cdp_helpers.mjs';

const SLIDER_50X = -5.8; // 10^-5.8 years per second ~= 50 s per s
const SLIDER_10X = -6.5; // 10^-6.5 years per second ~= 9.98 s per s
const SLIDER_REAL_TIME = -7.5; // the slider's step nearest to real time (0.998 s per s), see system/03
const PROBE = Object.freeze({ R: 60, width: 800, height: 400, ox: 560, oy: 200 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Click "Pause" / "Resume" until universe.isPaused === wanted. */
async function setPaused(page, wanted) {
	if (await page.evaluate(() => window.universe.isPaused) !== wanted) {
		await page.click('#pause-resume-btn');
	}
	await page.waitFor((w) => window.universe.isPaused === w, { args: [wanted], description: wanted ? 'paused' : 'running' });
}

/** The flying rocket's synchronized state, with the vapor-cone parameters the renderer derives from it. */
function readFlight(page) {
	return page.evaluate(async () => {
		const { AeroUtils } = await import('/scripts/gravsim_utils.js');
		const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
		if (!r) { return null; }
		const tm = r.telemetry || {};
		const vapor = AeroUtils.computeVaporConeParams(r.mach, r.ambientPresRatio);
		return {
			flightTime: tm.flightTime,
			altM: tm.altM,
			mach: r.mach,
			ambientPresRatio: r.ambientPresRatio,
			intensity: vapor.intensity,
			stageIndex: r.currentStageIndex,
			tmStageIndex: tm.stageIndex,
			stageState: r.stageState,
			stgTimer: r.stgTimer,
			fairingAttached: Boolean(r.fairing?.enabled && !r.fairing?.isSeparated && !tm.isFairingSeparated),
			rcsCw: Boolean(r.rcsCw),
			rcsCcw: Boolean(r.rcsCcw),
			rcsUllage: Boolean(r.rcsUllage),
			timeScale: window.universe.timeScale,
			isPaused: window.universe.isPaused
		};
	});
}

/** Pause with the button and wait until the main-thread rocket no longer changes (no Worker frame in flight). */
async function pauseFrozen(page) {
	await setPaused(page, true);
	let previous = JSON.stringify(await readFlight(page));
	for (let i = 0; i < 40; i++) {
		await sleep(300);
		const current = JSON.stringify(await readFlight(page));
		if (current === previous) { return readFlight(page); }
		previous = current;
	}
	throw new Error('the rocket kept changing after the pause');
}

/** Move the System-tab time-scale slider with the keyboard and check the time scale it sets. */
async function setTimeWarp(page, sliderValue) {
	assert.equal(await setRangeByKeys(page, '#time-scale', sliderValue), sliderValue);
	assert.equal(await page.evaluate(() => window.universe.timeScale), Math.pow(10, sliderValue), `time scale 10^${sliderValue}`);
}

/**
 * Draw a copy of the live rocket (thrustAngle 0) with RocketRenderer.draw on an offscreen canvas at R = PROBE.R, with
 * performance.now and Math.random fixed, recording the arguments of _drawFairing / _drawInterstage / _drawStage1 /
 * _drawStage2 / _drawRcsPlume and the moveTo calls the canvas receives inside drawVaporCone. With `withReference`,
 * the same copy at Mach 0 is drawn too and the differing pixels are classified against the hull
 * (RocketRenderer._computeStackGeometry / bodyRadiusAt): the frontmost column with a differing pixel more than
 * (hull radius + 1 px) from the axis, and the frontmost column with any differing pixel. The expected exterior start
 * of the primary cone comes from the formulas of §3.5 (outline: quadratic Bézier from the vertex through
 * (x - 0.22 coneLen, 0.72 coneHalfW) to (x - coneLen, coneHalfW)) with the drawn fairing base as the vertex.
 * @param {import('./cdp_helpers.mjs').PageSession} page
 * @param {boolean} withReference
 */
function drawProbe(page, withReference) {
	return page.evaluate(async (opts) => {
		const { RocketRenderer: RR } = await import('/scripts/gravsim_rocket_renderer.js');
		const { AeroUtils } = await import('/scripts/gravsim_utils.js');
		const { ROCKET_VISUAL } = await import('/scripts/gravsim_preset_manager.js');
		const { R, width, height, ox, oy } = opts;
		const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
		const proto = Object.getPrototypeOf(r);
		const copy = Object.assign(Object.create(proto), r, { thrustAngle: 0 });
		const reference = Object.assign(Object.create(proto), r, { thrustAngle: 0, mach: 0, telemetry: { ...r.telemetry, mach: 0 } });

		const rec = { fairing: [], interstage: [], stage1: [], stage2: [], vaporMoveTo: [], rcsPlumes: [] };
		let recording = false;
		let inVapor = false;
		const originals = {};
		const wrap = (name, record) => {
			const orig = RR[name];
			originals[name] = orig;
			RR[name] = function (...args) {
				if (recording) { record(args); }
				return orig.apply(this, args);
			};
		};
		const part = (a) => ({ startX: a[1], radius: a[2], length: a[3] });
		const random = Math.random;
		const hadOwnNow = Object.prototype.hasOwnProperty.call(performance, 'now');
		const ownNow = performance.now;
		let image = null;
		let refImage = null;
		try {
			wrap('_drawFairing', (a) => rec.fairing.push(part(a)));
			wrap('_drawInterstage', (a) => rec.interstage.push(part(a)));
			wrap('_drawStage1', (a) => rec.stage1.push(part(a)));
			wrap('_drawStage2', (a) => rec.stage2.push(part(a)));
			wrap('_drawRcsPlume', (a) => rec.rcsPlumes.push({ x: a[1], y: a[2], ux: a[3], uy: a[4], plumeLen: a[5] }));
			const vaporCone = RR.drawVaporCone;
			originals.drawVaporCone = vaporCone;
			RR.drawVaporCone = function (...args) {
				inVapor = true;
				try { return vaporCone.apply(this, args); } finally { inVapor = false; }
			};
			Math.random = () => 0.5;
			performance.now = () => 123456.789;
			const render = (rocket, record) => {
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				const moveTo = ctx.moveTo;
				ctx.moveTo = function (x, y) {
					if (recording && inVapor) { rec.vaporMoveTo.push({ x, y }); }
					return moveTo.call(this, x, y);
				};
				recording = record;
				try {
					RR.draw(ctx, rocket, ox, oy, R, 1);
				} finally {
					recording = false;
				}
				return ctx.getImageData(0, 0, width, height).data;
			};
			image = render(copy, true);
			if (opts.withReference) { refImage = render(reference, false); }
		} finally {
			Math.random = random;
			if (hadOwnNow) { performance.now = ownNow; } else { delete performance.now; }
			for (const [name, fn] of Object.entries(originals)) { RR[name] = fn; }
		}
		const restored = Math.random === random && !Object.prototype.hasOwnProperty.call(performance, 'now') === !hadOwnNow
			&& Object.entries(originals).every(([name, fn]) => RR[name] === fn);

		const geometry = RR._computeStackGeometry(copy, R);
		const hullAt = (x) => RR.bodyRadiusAt(geometry, x);
		const layout = RR._computeVisualLayout(copy, R);
		const mach = Number.isFinite(r.mach) ? r.mach : r.telemetry.mach;
		const vapor = AeroUtils.computeVaporConeParams(mach, r.ambientPresRatio);
		const vc = ROCKET_VISUAL.VAPOR_CONE;
		// §3.5: the cone of vertex (x, h) and scale s
		const coneDims = (h, s) => ({
			len: h * vc.CONE_LENGTH_RATIO * (0.75 + 0.5 * vapor.intensity) * s,
			halfW: Math.min(h * vc.MAX_WIDTH_MULTIPLIER, h * (1.1 + 1.35 * vapor.intensity * Math.sin(vapor.machAngleRad))) * s
		});
		// First x aft of the vertex where the outline is more than `margin` outside the hull
		const exteriorStart = (xV, h, s, margin) => {
			const { len, halfW } = coneDims(h, s);
			const n = 20000;
			for (let k = 1; k <= n; k++) {
				const t = k / n;
				const x = xV - 0.44 * len * t * (1 - t) - len * t * t;
				const y = 1.44 * halfW * t * (1 - t) + halfW * t * t;
				if (y > (hullAt(x) ?? 0) + margin) { return x; }
			}
			return null;
		};
		const fairing = rec.fairing[0] || null;
		const expected = fairing ? {
			primary: coneDims(fairing.radius, 1.0),
			secondary: rec.interstage[0] ? coneDims(rec.interstage[0].radius, 0.78) : null,
			exteriorStart: exteriorStart(fairing.startX, fairing.radius, 1.0, 0),
			exteriorStart1px: exteriorStart(fairing.startX, fairing.radius, 1.0, 1)
		} : null;

		let pixels = null;
		if (refImage) {
			const hullCol = [];
			for (let c = 0; c < width; c++) { hullCol.push(hullAt(c + 0.5 - ox) ?? 0); }
			let diffCount = 0;
			let outsideCount = 0;
			let frontAnyColumn = null;
			let frontOutsideColumn = null;
			for (let row = 0; row < height; row++) {
				const yAbs = Math.abs(row + 0.5 - oy);
				for (let c = 0; c < width; c++) {
					const i = (row * width + c) * 4;
					if (image[i] === refImage[i] && image[i + 1] === refImage[i + 1] && image[i + 2] === refImage[i + 2] && image[i + 3] === refImage[i + 3]) {
						continue;
					}
					diffCount++;
					if (frontAnyColumn === null || c > frontAnyColumn) { frontAnyColumn = c; }
					if (yAbs > hullCol[c] + 1) {
						outsideCount++;
						if (frontOutsideColumn === null || c > frontOutsideColumn) { frontOutsideColumn = c; }
					}
				}
			}
			pixels = { diffCount, outsideCount, frontAnyColumn, frontOutsideColumn };
		}

		const body = geometry.segments[geometry.segments.length - 1];
		return {
			restored,
			rec,
			mach,
			ambientPresRatio: r.ambientPresRatio,
			vapor,
			secondaryIntensityMin: vc.SECONDARY_INTENSITY_MIN,
			flags: { cw: Boolean(r.rcsCw || r.telemetry?.rcsCw), ccw: Boolean(r.rcsCcw || r.telemetry?.rcsCcw), ullage: Boolean(r.rcsUllage || r.telemetry?.rcsUllage) },
			body: body ? { kind: body.kind, stageIndex: body.stageIndex, startX: body.startX, radius: body.radius, length: body.length } : null,
			layout: { noseShoulder: layout.noseShoulder, interstageShoulder: layout.interstageShoulder, rcs: layout.rcs ?? null },
			expected,
			pixels
		};
	}, { ...PROBE, withReference });
}

/** |a - b| <= tol */
function near(actual, wanted, tol, message) {
	assert.ok(Number.isFinite(actual) && Math.abs(actual - wanted) <= tol, `${message}: ${actual} vs ${wanted} (±${tol})`);
}

describe('System E2E 06: vapor cone and RCS anchors on the drawn Falcon 9', { timeout: 300000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;

	before(async () => {
		env = await startE2E();
		page = env.page;
		await bootGravSim(env);
		await deployBody(page, 'put-earth-btn', 'Earth');
		await clickTab(page, 'tab-rocket');
		const r0 = await predictorRequestId(page);
		await page.selectOption('#rl-vehicle-select', 'falcon9');
		await waitPredictionSettled(page, r0);
	});

	after(async () => {
		if (env) { await env.close(); }
	});

	it('setup: Falcon 9 rolled out, launched with quick ignition, then 50x from the System tab', async () => {
		const mark = page.mark();
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rocket rolled out' });
		const pad = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.type === 1);
			return { stages: r.stages.length, fairing: Boolean(r.fairing?.enabled), srbCount: Number(r.boosters?.count || 0) };
		});
		assert.deepEqual(pad, { stages: 2, fairing: true, srbCount: 0 }, 'input: two stages with a fairing and no SRB');
		await page.click('#rl-ignite-quick-btn');
		await page.waitFor(() => {
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return r && r.isHoldDown === false && r.stageState === 'STG_BURNING';
		}, { timeoutMs: 20000, description: 'liftoff' });
		await page.waitFor(() => !window.universe.LaunchSequencer.isActive && !document.querySelector('.tab-btn[data-target="tab-sys"]').disabled,
			{ timeoutMs: 30000, description: 'launch sequence end' });
		await clickTab(page, 'tab-sys');
		await setTimeWarp(page, SLIDER_50X);
		assert.equal(await page.evaluate(() => document.getElementById('time-scale-indicator').textContent), '50 sec/sec');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('transonic: paused before the window, real time set while paused, then paused inside it (intensity >= 0.55)', async (t) => {
		const mark = page.mark();
		await page.waitFor(() => (window.universe.objects.find((o) => o.type === 1 && o.state === 0)?.telemetry?.flightTime ?? 0) >= 40,
			{ timeoutMs: 30000, intervalMs: 10, description: 'flight time >= 40 s' });
		const early = await pauseFrozen(page);
		await setTimeWarp(page, SLIDER_REAL_TIME);
		t.diagnostic(`paused before the window: T+${early.flightTime.toFixed(2)} s, Mach ${early.mach.toFixed(3)}, alt ${early.altM.toFixed(0)} m`);
		assert.ok(early.flightTime >= 40, `input: flight time ${early.flightTime} s`);
		assert.ok(early.mach < 0.9, `precondition failed: Mach ${early.mach} >= 0.9 at T+${early.flightTime} s (the window was not ahead)`);
		assert.equal(early.stageIndex, 0, 'input: stage 1 flight');

		await setPaused(page, false);
		await page.waitFor(async () => {
			const { AeroUtils } = await import('/scripts/gravsim_utils.js');
			const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
			return Boolean(r) && AeroUtils.computeVaporConeParams(r.mach, r.ambientPresRatio).intensity >= 0.6;
		}, { timeoutMs: 45000, intervalMs: 20, description: 'vapor-cone intensity >= 0.6' });
		const s = await pauseFrozen(page);
		t.diagnostic(`paused in the window: T+${s.flightTime.toFixed(2)} s, Mach ${s.mach.toFixed(4)}, pressure ratio ${s.ambientPresRatio.toFixed(4)}, intensity ${s.intensity.toFixed(4)}`);
		assert.ok(s.intensity >= 0.55, `intensity ${s.intensity} >= 0.55 while paused (Mach ${s.mach}, pressure ratio ${s.ambientPresRatio})`);
		assert.deepEqual([s.stageIndex, s.tmStageIndex, s.fairingAttached], [0, 0, true], 'stage 1 flight with the fairing attached');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('vapor cone: vertices on the drawn fairing base and stage-2 start, the cloud leaves the hull where §3.5 says', async (t) => {
		const mark = page.mark();
		const p = await drawProbe(page, true);
		const R = PROBE.R;
		assert.equal(p.restored, true, 'the stubs and wrappers are restored');
		assert.ok(p.vapor.active && p.vapor.intensity >= p.secondaryIntensityMin, `input: both cones drawn (intensity ${p.vapor.intensity})`);

		// The drawn hull (design §3.4 table, stage-1 flight with the fairing)
		assert.equal(p.rec.fairing.length, 1, 'the fairing is drawn');
		assert.equal(p.rec.interstage.length, 1, 'one interstage');
		assert.equal(p.rec.stage2.length, 1, 'stage 2 is drawn');
		const F = p.rec.fairing[0];
		const I = p.rec.interstage[0];
		const S2 = p.rec.stage2[0];
		near(F.startX, 1.6 * R, 1e-9, 'drawn fairing base');
		near(F.radius, 0.65 * R, 1e-9, 'drawn fairing radius');
		near(S2.startX, 0.4 * R, 1e-9, 'drawn stage-2 start');
		near(I.startX + I.length, S2.startX, 1e-9, 'the interstage ends at the stage-2 start');
		near(I.radius, 0.7 * R, 1e-9, 'drawn interstage radius');

		// Positions: moveTo(vertex, 0) then moveTo(xBack, -coneHalfW) for each cone, primary first
		const m = p.rec.vaporMoveTo;
		t.diagnostic(`drawVaporCone moveTo: ${JSON.stringify(m)}; fairing ${JSON.stringify(F)}, interstage ${JSON.stringify(I)}, stage 2 ${JSON.stringify(S2)}`);
		assert.equal(m.length, 4, 'two cones, two moveTo each');
		assert.deepEqual([m[0].y, m[2].y], [0, 0], 'the vertices are on the axis');
		assert.equal(m[0].x, F.startX, 'primary vertex = drawn fairing base');
		assert.equal(m[2].x, S2.startX, 'secondary vertex = drawn stage-2 start (the interstage forward edge)');
		near(m[1].x, F.startX - p.expected.primary.len, 1e-9, 'primary cone length (h = fairing radius)');
		near(m[1].y, -p.expected.primary.halfW, 1e-9, 'primary cone half width');
		near(m[3].x, S2.startX - p.expected.secondary.len, 1e-9, 'secondary cone length (h = interstage radius, scale 0.78)');
		near(m[3].y, -p.expected.secondary.halfW, 1e-9, 'secondary cone half width');

		// Pixels: the cloud outside the hull starts where the outline leaves it; nothing changes ahead of the fairing base
		const px = p.pixels;
		const frontOutsideX = px.frontOutsideColumn + 0.5 - PROBE.ox;
		const frontAnyLeftX = px.frontAnyColumn - PROBE.ox;
		t.diagnostic(`pixels: ${px.diffCount} differ, ${px.outsideCount} outside the hull + 1 px; frontmost outside column centre x = ${frontOutsideX} `
			+ `(${(frontOutsideX / R).toFixed(4)} R), expected exterior start ${p.expected.exteriorStart.toFixed(3)} (${(p.expected.exteriorStart / R).toFixed(4)} R; `
			+ `+1 px: ${p.expected.exteriorStart1px.toFixed(3)}); frontmost differing column left edge x = ${frontAnyLeftX}, fairing base ${F.startX}`);
		assert.ok(px.outsideCount > 0, 'the cloud stands out of the hull');
		near(frontOutsideX, p.expected.exteriorStart, 2, 'frontmost cloud column outside the hull vs the primary cone exterior start (px)');
		assert.ok(frontAnyLeftX < F.startX + 1, `no differing pixel ahead of the fairing base + 1 px (column at x = ${frontAnyLeftX}, base ${F.startX})`);

		// The layout the renderer used
		assert.deepEqual(p.layout.noseShoulder, { x: F.startX, halfWidth: F.radius }, 'noseShoulder');
		assert.deepEqual(p.layout.interstageShoulder, { x: S2.startX, halfWidth: I.radius }, 'interstageShoulder');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('RCS: after the stage-1 separation the jets start on the stage-2 wall, outside the attached fairing', async (t) => {
		const mark = page.mark();
		await setTimeWarp(page, SLIDER_10X);
		await setPaused(page, false);
		await page.waitFor(() => (window.universe.objects.find((o) => o.type === 1 && o.state === 0)?.telemetry?.flightTime ?? 0) >= 150,
			{ timeoutMs: 60000, intervalMs: 10, description: 'flight time >= 150 s' });
		const coast = await pauseFrozen(page);
		t.diagnostic(`paused before the separation: T+${coast.flightTime.toFixed(2)} s, stage ${coast.stageIndex}`);
		assert.equal(coast.stageIndex, 0, `input: stage 1 still attached at T+${coast.flightTime} s`);
		await setTimeWarp(page, SLIDER_REAL_TIME);
		await setPaused(page, false);

		let s = null;
		let attempts = 0;
		for (; attempts < 10; attempts++) {
			await page.waitFor(() => {
				const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
				return Boolean(r) && r.currentStageIndex === 1 && Boolean(r.rcsUllage || r.rcsCw || r.rcsCcw);
			}, { timeoutMs: 45000, intervalMs: 10, description: 'stage 2 with an RCS flag set' });
			s = await pauseFrozen(page);
			if (s.rcsUllage || s.rcsCw || s.rcsCcw) { break; }
			await setPaused(page, false);
		}
		assert.ok(s && (s.rcsUllage || s.rcsCw || s.rcsCcw), `an RCS flag is set while paused (${attempts + 1} attempts)`);
		t.diagnostic(`paused with RCS: T+${s.flightTime.toFixed(2)} s, state ${s.stageState} (stage timer ${s.stgTimer} s), cw ${s.rcsCw}, ccw ${s.rcsCcw}, ullage ${s.rcsUllage}, attempts ${attempts + 1}`);
		assert.deepEqual([s.stageIndex, s.tmStageIndex, s.fairingAttached], [1, 1, true], 'stage 2 flight with the fairing still attached');

		const p = await drawProbe(page, false);
		const R = PROBE.R;
		assert.equal(p.restored, true, 'the stubs and wrappers are restored');
		assert.equal(p.rec.fairing.length, 1, 'the fairing is drawn');
		const F = p.rec.fairing[0];
		assert.deepEqual([p.body.kind, p.body.stageIndex], ['stage', 1], 'the current body is stage 2');
		const { startX, length, radius: r2 } = p.body;
		near(startX, -0.6 * R, 1e-9, 'stage-2 start (design §3.4 table)');
		near(r2, 0.65 * R, 1e-9, 'stage-2 radius');

		const plumes = p.rec.rcsPlumes;
		t.diagnostic(`_drawRcsPlume: ${JSON.stringify(plumes)}; stage 2 [${startX}, ${startX + length}] r2 ${r2}; fairing [${F.startX}, ${F.startX + F.length}]; layout.rcs ${JSON.stringify(p.layout.rcs)}`);
		assert.ok(plumes.length >= 2, `jets drawn (${plumes.length})`);
		for (const n of plumes) {
			assert.ok(n.x >= startX && n.x <= startX + length, `jet at x = ${n.x} within stage 2 [${startX}, ${startX + length}]`);
			near(Math.abs(n.y), r2, 1e-9, `jet at y = ${n.y} on the wall ±r2`);
			assert.ok(!(n.x >= F.startX && n.x <= F.startX + F.length), `jet at x = ${n.x} outside the fairing [${F.startX}, ${F.startX + F.length}]`);
			assert.ok(n.uy * n.y > 0, `jet (${n.ux}, ${n.uy}) points away from the wall at y = ${n.y}`);
		}

		// The nozzles of layout.rcs for the set flags, in the drawing order (cw, ccw, ullage)
		assert.ok(p.layout.rcs, 'layout.rcs exists');
		const wanted = [
			...(p.flags.cw ? p.layout.rcs.cw : []),
			...(p.flags.ccw ? p.layout.rcs.ccw : []),
			...(p.flags.ullage ? p.layout.rcs.ullage : [])
		].map((n) => ({ ...n, plumeLen: p.layout.rcs.plumeLen }));
		assert.deepEqual(plumes, wanted, 'the drawn jets are the nozzles of layout.rcs');
		// The role of each drawn jet, from the design §3.6.1 table and not from layout.rcs (R = 1, 3 decimals): cw fires
		// forward from -h towards -y and aft from +h towards +y, ccw the mirror, the ullage pair aft canted by
		// ULLAGE_CANT_RAD (0.28, presets/visuals/rocket.json) towards the tail; drawn in the order cw, ccw, ullage
		const xF = 0.408 * R;
		const xA = -0.432 * R;
		const h = 0.65 * R;
		const cant = 0.28;
		const ROLE = {
			cw: [[xF, -h, 0, -1], [xA, h, 0, 1]],
			ccw: [[xF, h, 0, 1], [xA, -h, 0, -1]],
			ullage: [[xA, h, -Math.cos(cant), Math.sin(cant)], [xA, -h, -Math.cos(cant), -Math.sin(cant)]]
		};
		const designJets = ['cw', 'ccw', 'ullage'].flatMap((k) => (p.flags[k] ? ROLE[k].map((j) => [k, ...j]) : []));
		assert.equal(plumes.length, designJets.length, `two jets per set flag (${JSON.stringify(p.flags)})`);
		plumes.forEach((n, i) => {
			const [role, x, y, ux, uy] = designJets[i];
			near(n.x, x, 0.0005 * R, `${role} jet ${i} x`);
			near(n.y, y, 1e-9 * R, `${role} jet ${i} y`);
			near(n.ux, ux, 1e-9, `${role} jet ${i} direction x`);
			near(n.uy, uy, 1e-9, `${role} jet ${i} direction y`);
		});
		// Design §3.4 table (R = 1, 3 decimals): forward 0.408, aft -0.432, wall 0.650
		for (const n of [...p.layout.rcs.cw, ...p.layout.rcs.ccw, ...p.layout.rcs.ullage]) {
			const fwd = n.x > 0;
			near(n.x / R, fwd ? 0.408 : -0.432, 0.0005, `${fwd ? 'forward' : 'aft'} nozzle x / R`);
			near(Math.abs(n.y) / R, 0.65, 1e-9, 'nozzle wall / R');
		}
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('the whole session produced no exceptions, console errors or dialogs (no TypeError from frozen preset snapshots)', () => {
		const problems = page.problems();
		assert.deepEqual(problems.filter((text) => /TypeError/.test(text)), [], 'no TypeError');
		assert.deepEqual(problems, []);
		assert.deepEqual(page.dialogs, []);
	});
});
