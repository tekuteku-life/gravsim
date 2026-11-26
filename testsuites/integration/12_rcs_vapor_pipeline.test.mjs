/**
 * Integration Test Suite 12: RCS / vapor-cone / Mach pipeline
 *
 * CalcRocket (Worker) -> WorkerBridge (ROCKET_FLAG RCS bits, TM_MACH slot)
 *   -> ObjectManager._applyRocketState (guards for missing / non-finite values)
 *   -> Rocket / telemetry -> RocketRenderer drawing (and the SoundEffects Mach source),
 * plus a short real flight through PhysicsEngine (Falcon 9 / LEO preset) in which the
 * vehicle goes transonic and RCS / ullage flags appear around staging.
 *
 * Design:    docs/design/2026-11-20_trajectory_fx_flightplan.md §3.2, §3.3, §4.4; the nozzle and cone positions and sizes
 *            of docs/design/2026-11-23_vapor_cone_rcs_anchors.md §3.4-§3.6 (they replace the fractions of the stack length)
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-C; 2026-11-23 design §5.2
 * Expected values come from the design formulas and tables, not from implementation output.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM } from '../test_helpers.mjs';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { CalcRocket, CalcCelestialBody, CalcDebris } from '../../scripts/gravsim_calc_object.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody, Rocket } from '../../scripts/gravsim_object.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { SoundEffects, SOUND_FX_CONFIG } from '../../scripts/gravsim_sound_effects.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { MathUtils } from '../../scripts/gravsim_utils.js';
import { OBJECT_TYPES, BUFFER_INDEX, CALC_BUFFER_CONFIG, ROCKET_FLAG } from '../../scripts/gravsim_const.js';

setupMockDOM();

/*******************************************************************
 * Design oracles (§3.2-2, §3.2-3, §3.3-1, §4.4)
 *******************************************************************/
const designTemperatureK = (altM, scaleH) => {
	const clAlt = Math.max(0, altM);
	const scaleRatio = scaleH / 8500;
	const tropopauseM = 11000 * scaleRatio;
	const rawT = (clAlt <= tropopauseM)
		? (288.15 - (0.0065 / scaleRatio) * clAlt)
		: (216.65 + 0.001 * ((clAlt - tropopauseM) / scaleRatio));
	return Math.max(180, Math.min(350, rawT));
};
const designSpeedOfSound = (tempK) => Math.sqrt(1.4 * 287.05 * tempK);
const designVapor = (mach, pres) => {
	if (!Number.isFinite(mach) || !Number.isFinite(pres) || mach < 0.82 || mach > 1.22 || pres <= 0.015) {
		return { active: false, intensity: 0, machAngleRad: Math.PI / 2 };
	}
	const span = (mach <= 1.0) ? (1.0 - 0.82) : (1.22 - 1.0);
	const u = Math.max(0, 1 - Math.abs(mach - 1.0) / Math.max(0.01, span));
	const intensity = u * u * (3 - 2 * u) * Math.min(1, Math.max(0, (pres - 0.015) / 0.25));
	return { active: intensity > 0.01, intensity, machAngleRad: Math.asin(Math.min(0.96, 1 / Math.max(1 / 0.96, mach))) };
};
/** Full design decision of _updateRcsState for CW / CCW. */
const designAttitudeJets = ({ err, pres, thrusting, timer, tPulse }) => {
	const allow = (pres <= 0.35) || !thrusting || (Math.abs(err) > 0.08) || (timer > 0);
	const pulseOn = (tPulse % 0.45) < (0.45 * 0.42);
	let cw = false;
	let ccw = false;
	if (allow) {
		if (err > 0.015) {
			cw = (err >= 0.08 || timer > 0) ? true : pulseOn;
		} else if (err < -0.015) {
			ccw = (-err >= 0.08 || timer > 0) ? true : pulseOn;
		} else if (timer > 0) {
			const phase = timer % 0.35;
			cw = phase < 0.09;
			ccw = phase >= 0.175 && phase < 0.175 + 0.09;
		}
	}
	return { cw, ccw, allow };
};
/**
 * The jets of the set flags: the union of the table rows of layout.rcs (2026-11-23 §3.6, the nozzles drawColdGasRcs
 * draws). layout.rcs itself is checked against the design by assertLayoutDesign; designF9 has the same shape, so the
 * drawn jets are also compared with the design nozzles directly.
 */
const designNozzles = (layout, flags) => {
	const rcs = layout.rcs;
	if (!rcs) return [];
	return [...(flags.cw ? rcs.cw : []), ...(flags.ccw ? rcs.ccw : []), ...(flags.ullage ? rcs.ullage : [])];
};
const assertNear = (actual, expected, tol, msg) => {
	assert.ok(Number.isFinite(actual), `${msg}: expected a finite number, got ${actual}`);
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
};
/**
 * 2026-11-23 §3.2 / §3.4 / §3.6 for the 2-stage Falcon 9 stack (no SRB) at screen radius R: the nose shoulder (fairing base,
 * else the front of the exposed payload), the interstage shoulder (forward edge of the interstage, first-stage flight only)
 * and the lateral RCS nozzles on the wall of the current (lowest drawn) stage.
 */
const designF9 = (stageIndex, fairingAttached, R) => {
	const m = VIS.MODULES;
	const al = VIS.ALIGNMENT;
	const c = VIS.COLD_GAS_RCS;
	const r1 = R * m.STAGE1_RADIUS_RATIO;
	const l1 = R * m.STAGE1_LENGTH_RATIO;
	const r2 = R * m.STAGE2_RADIUS_RATIO;
	const l2 = R * m.STAGE2_LENGTH_RATIO;
	const lInter = R * m.INTERSTAGE_LENGTH_RATIO;
	const lFairing = R * m.FAIRING_LENGTH_RATIO;
	const stg2X = stageIndex === 0 ? R * al.BASE_X_STAGE1_RATIO : R * al.BASE_X_UPPER_RATIO;
	const fairingX = stg2X + l2;
	const body = stageIndex === 0 ? { x0: (stg2X - lInter) - l1, len: l1, r: r1, fins: true } : { x0: stg2X, len: l2, r: r2, fins: false };
	const h = body.r;
	const plumeLen = Math.max(c.MIN_PLUME_PX, h * c.PLUME_LEN_WIDTH_RATIO);
	// Free wall: the stage minus its fins (they stand out by r * FIN_SPAN_RATIO), widened by min(e, plumeLen) tan(spread).
	// The neighbour forward of the wall (interstage r1 on stage 1, fairing r2 on stage 2) is not wider than the wall.
	const lo = body.fins
		? body.x0 + body.len * m.FIN_BASE_RATIO + Math.min(body.r * m.FIN_SPAN_RATIO, plumeLen) * Math.tan(c.PLUME_SPREAD_RAD)
		: body.x0;
	const hi = body.x0 + body.len;
	const xFwd = lo + (hi - lo) * c.FWD_STATION_FRACTION;
	const xAft = lo + (hi - lo) * c.AFT_STATION_FRACTION;
	const ull = (sign) => ({ ux: -Math.cos(c.ULLAGE_CANT_RAD), uy: sign * Math.sin(c.ULLAGE_CANT_RAD) });
	const busW = r2 * m.SATELLITE_BUS_W_RATIO;
	const busH = r2 * m.SATELLITE_BUS_H_RATIO;
	return {
		noseShoulder: fairingAttached ? { x: fairingX, halfWidth: r2 } : { x: fairingX + lFairing * al.PAYLOAD_OFFSET_RATIO + busW / 2, halfWidth: busH / 2 },
		interstageShoulder: stageIndex === 0 ? { x: stg2X, halfWidth: r1 } : null,
		rcs: {
			plumeLen,
			cw: [{ x: xFwd, y: -h, ux: 0, uy: -1 }, { x: xAft, y: h, ux: 0, uy: 1 }],
			ccw: [{ x: xFwd, y: h, ux: 0, uy: 1 }, { x: xAft, y: -h, ux: 0, uy: -1 }],
			ullage: [{ x: xAft, y: h, ...ull(1) }, { x: xAft, y: -h, ...ull(-1) }]
		}
	};
};
/** The drawn layout's anchors equal the design ones (to 1e-9 px). */
const assertLayoutDesign = (layout, stageIndex, fairingAttached, R, msg) => {
	const d = designF9(stageIndex, fairingAttached, R);
	for (const k of ['noseShoulder', 'interstageShoulder']) {
		if (d[k] === null) {
			assert.equal(layout[k], null, `${msg}: ${k} is null`);
			continue;
		}
		assert.ok(layout[k], `${msg}: layout.${k}`);
		assertNear(layout[k].x, d[k].x, 1e-9, `${msg}: ${k}.x`);
		assertNear(layout[k].halfWidth, d[k].halfWidth, 1e-9, `${msg}: ${k}.halfWidth`);
	}
	assert.ok(layout.rcs, `${msg}: layout.rcs`);
	assertNear(layout.rcs.plumeLen, d.rcs.plumeLen, 1e-9, `${msg}: rcs.plumeLen`);
	for (const k of ['cw', 'ccw', 'ullage']) {
		assert.equal(layout.rcs[k].length, 2, `${msg}: rcs.${k}`);
		for (const [i, n] of d.rcs[k].entries()) {
			for (const f of ['x', 'y', 'ux', 'uy']) assertNear(layout.rcs[k][i][f], n[f], 1e-9, `${msg}: rcs.${k}[${i}].${f}`);
		}
	}
};

/*******************************************************************
 * Recording canvas context + decoders
 *******************************************************************/
const MIST_COLOR = 'rgba(195, 228, 255, 0.28)';
const VAPOR_CORE_COLOR = 'rgba(240, 248, 255, 0.70)';
const createRecordingCtx = () => {
	const fills = [];
	const stack = [];
	let path = [];
	const ctx = {
		fills,
		fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, shadowColor: '', shadowBlur: 0,
		save() { stack.push({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha }); },
		restore() { const s = stack.pop(); if (s) Object.assign(ctx, s); },
		translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {}, clip() {},
		beginPath() { path = []; },
		closePath() { path.push({ op: 'closePath' }); },
		moveTo(x, y) { path.push({ op: 'moveTo', x, y }); },
		lineTo(x, y) { path.push({ op: 'lineTo', x, y }); },
		quadraticCurveTo(cpx, cpy, x, y) { path.push({ op: 'quad', cpx, cpy, x, y }); },
		bezierCurveTo(a, b, c, d, x, y) { path.push({ op: 'bezier', x, y }); },
		arc() {}, ellipse() {}, rect() {}, roundRect() {},
		fill() { fills.push({ style: ctx.fillStyle, path: path.slice() }); },
		stroke() {},
		fillRect(x, y, w, h) { fills.push({ style: ctx.fillStyle, path: [{ op: 'rect', x, y, w, h }] }); },
		strokeRect() {}, clearRect() {},
		createLinearGradient() { return { kind: 'linear', stops: [], addColorStop() {} }; },
		createRadialGradient() { const g = { kind: 'radial', stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; },
		setLineDash() {}, getLineDash() { return []; }, measureText(t) { return { width: String(t ?? '').length * 8 }; },
		fillText() {}, strokeText() {}, drawImage() {}
	};
	return ctx;
};
const extractPlumes = (ctx) => ctx.fills.filter(f => f.style === MIST_COLOR).map(f => {
	const [apex, a, b] = f.path;
	const mx = (a.x + b.x) / 2 - apex.x;
	const my = (a.y + b.y) / 2 - apex.y;
	const n = Math.hypot(mx, my);
	return { x: apex.x, y: apex.y, ux: mx / n, uy: my / n };
});
const extractCones = (ctx) => ctx.fills
	.filter(f => f.style && f.style.kind === 'radial' && f.style.stops.some(s => s[1] === VAPOR_CORE_COLOR))
	.map(f => ({ xVertex: f.path[0].x, coneLen: f.path[0].x - f.path[1].x, halfW: f.path[2].y }));
const assertPlumesMatch = (actual, expected, msg) => {
	assert.equal(actual.length, expected.length, `${msg}: plume count`);
	const pool = actual.slice();
	for (const e of expected) {
		const idx = pool.findIndex(p => Math.abs(p.x - e.x) < 1e-9 && Math.abs(p.y - e.y) < 1e-9
			&& Math.abs(p.ux - e.ux) < 1e-9 && Math.abs(p.uy - e.uy) < 1e-9);
		assert.ok(idx >= 0, `${msg}: missing plume at (${e.x}, ${e.y}) jet (${e.ux}, ${e.uy})`);
		pool.splice(idx, 1);
	}
};
/**
 * 2026-11-23 §3.5: the primary cone opens at layout.noseShoulder, the secondary (intensity >= 0.55) at
 * layout.interstageShoulder when the stack has an interstage; each is sized by the radius h at its vertex.
 */
const assertConesMatch = (cones, layout, mach, pres, msg) => {
	const v = designVapor(mach, pres);
	if (!v.active) {
		assert.equal(cones.length, 0, `${msg}: inactive vapor draws nothing`);
		return;
	}
	assert.ok(layout.noseShoulder, `${msg}: layout.noseShoulder`);
	const expected = [{ anchor: layout.noseShoulder, scale: 1.0 }];
	if (v.intensity >= 0.55 && layout.interstageShoulder) expected.push({ anchor: layout.interstageShoulder, scale: 0.78 });
	assert.equal(cones.length, expected.length, `${msg}: cone count (intensity ${v.intensity})`);
	for (const [i, e] of expected.entries()) {
		const hw = e.anchor.halfWidth;
		assertNear(cones[i].xVertex, e.anchor.x, 1e-9, `${msg}: cone ${i} station`);
		assertNear(cones[i].coneLen, hw * 2.2 * (0.75 + 0.5 * v.intensity) * e.scale, 1e-9, `${msg}: cone ${i} length`);
		assertNear(cones[i].halfW, Math.min(hw * 2.8, hw * (1.1 + 1.35 * v.intensity * Math.sin(v.machAngleRad))) * e.scale, 1e-9, `${msg}: cone ${i} half width`);
	}
};

/*******************************************************************
 * Minimal recording WebAudio for the SoundEffects end of the Mach pipeline
 *******************************************************************/
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

/*******************************************************************
 * Shared fixtures
 *******************************************************************/
const PM = new PresetManager();
const PLAN = PM.calculateMissionFlightPlan({ vehicle: PM.getVehicle('falcon9'), payload: PM.getPayload('earth_obs'), mission: PM.getMission('leo_250km') });
const EARTH_PARAM = presetManager.getObjectParam('Earth');
const R_E = EARTH_PARAM.RADIUS;
const OMEGA_E = (2 * Math.PI) / EARTH_PARAM.ROTATION_PERIOD;
const VIS = presetManager.getRocketVisual();
const ROCKET_ID = 300;
const clone = (v) => JSON.parse(JSON.stringify(v));

const makeMainWorld = (bodies) => {
	const om = new ObjectManager(null, { postMessage() {} });
	for (const b of bodies) {
		const body = new CelestialBody(b.id, b.name, 0, 0, 0, 0, b.massT, '#1E90FF', 10, b.radius, 0);
		body.param = presetManager.getObjectParam(b.name);
		om.addObject(body, false);
	}
	const rocket = new Rocket(ROCKET_ID, 'Falcon 9 Style (2-Stage)', 0, 0, 0, 0,
		PLAN.stages[0].dryMassT, PLAN.stages[0].fuelMassT, PLAN.stages[0].oxidMassT, '#ffffff', 5, 10, 0, null, 0, 'classic');
	rocket.stages = clone(PLAN.stages);
	rocket.payload = clone(PLAN.payload);
	rocket.fairing = clone(PLAN.fairing);
	rocket.totalStages = PLAN.stages.length;
	om.addObject(rocket, false);
	return { om, main: rocket };
};
const transfer = (om, workerObjects) => {
	const buffer = WorkerBridge.formatWorkerToMain(workerObjects);
	om.updateObjectParams({ objectsData: buffer.buffer, validLength: buffer.length });
	return buffer;
};
const slotOf = (buffer, id) => {
	for (let off = 0; off < buffer.length; off += CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT) {
		if (buffer[off + BUFFER_INDEX.ID] === id) return off;
	}
	return -1;
};
const rcsBits = (flags) => ({
	cw: (flags & ROCKET_FLAG.RCS_CW) !== 0,
	ccw: (flags & ROCKET_FLAG.RCS_CCW) !== 0,
	ullage: (flags & ROCKET_FLAG.RCS_ULLAGE) !== 0
});
const mainFlags = (r) => ({ cw: r.rcsCw, ccw: r.rcsCcw, ullage: r.rcsUllage });
const mainTmFlags = (r) => ({ cw: r.telemetry.rcsCw, ccw: r.telemetry.rcsCcw, ullage: r.telemetry.rcsUllage });

/** Worker-side Earth + Falcon 9 at 7 km, flying at a chosen Mach through the rotating atmosphere. */
const makeWorkerPair = (mach = 0.95, altM = 7000) => {
	const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, R_E, 0, 5.972e21);
	earth.param = EARTH_PARAM;
	const rocket = new CalcRocket(ROCKET_ID, 'Falcon 9 Style (2-Stage)', 0, R_E + altM, 0, 0, 0, 0, 10, 0,
		PLAN.stages[0].dryMassT, PLAN.stages[0].fuelMassT, PLAN.stages[0].oxidMassT,
		{ stages: clone(PLAN.stages), payload: clone(PLAN.payload), fairing: clone(PLAN.fairing), isHoldDown: false, isIgnited: true, thrustAngle: Math.PI / 2 });
	const a = designSpeedOfSound(designTemperatureK(altM, EARTH_PARAM.ATM_SCALE_HEIGHT));
	rocket.vx = -OMEGA_E * (R_E + altM) + mach * a; // airspeed along +X relative to the co-rotating air
	rocket.vy = 0;
	rocket.dominantBody = earth;
	rocket.distToDominantM = R_E + altM;
	rocket.applyAerodynamics(earth, EARTH_PARAM, altM);
	return { earth, rocket };
};

/*******************************************************************
 * 1. Synthetic pipeline driven by the real worker methods
 *******************************************************************/
describe('Integration 12-1: CalcRocket -> WorkerBridge -> ObjectManager -> Rocket -> RocketRenderer', () => {
	beforeEach(() => EventBus.clearAll());
	afterEach(() => EventBus.clearAll());

	it('interstage coast at Mach 0.95 / 7 km: RCS bits, TM_MACH, telemetry and the drawn jets and cones agree with the design', () => {
		const { earth, rocket } = makeWorkerPair(0.95, 7000);
		assertNear(rocket.mach, 0.95, 1e-9, 'worker Mach from the design speed of sound');
		assertNear(rocket.ambientPresRatio, Math.exp(-7000 / 8500), 1e-15, 'worker pressure ratio');

		// The first-stage flight at the same Mach: the stack has an interstage, so intensity ~0.81 >= 0.55 adds the
		// secondary cone at its forward edge (2026-11-23 §3.5, R2)
		const { om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		transfer(om, [earth, rocket]);
		assert.equal(main.telemetry.stageIndex, 0, 'input: first-stage flight');
		const R = 30;
		const ctx0 = createRecordingCtx();
		RocketRenderer.draw(ctx0, main, 0, 0, R, 1.0);
		const cones0 = extractCones(ctx0);
		assert.equal(cones0.length, 2, 'intensity ~0.81 >= 0.55 with an interstage -> secondary cone');
		assertNear(cones0[0].xVertex, 1.6 * R, 1e-9, 'primary cone at the fairing base (2026-11-23 §3.4: 1.600 R)');
		assertNear(cones0[1].xVertex, 0.4 * R, 1e-9, 'secondary cone at the interstage forward edge (0.400 R)');
		const layout0 = RocketRenderer._computeVisualLayout(main, R, VIS);
		assertLayoutDesign(layout0, 0, true, R, 'first-stage layout');
		assertConesMatch(cones0, layout0, main.mach, main.ambientPresRatio, 'first-stage vapor cones');

		rocket._activateStage(1);
		rocket.stageState = 'INTERSTAGE_COAST';
		rocket.stgTimer = 1.0;
		rocket.isIgnited = false;
		rocket.flightComputer.desiredThrustAngleRad = rocket.thrustAngle + 0.5;
		rocket._updateRcsState(0.1, 0, rocket.thrustAngle);
		assert.deepEqual({ cw: rocket.rcsCw, ccw: rocket.rcsCcw, ullage: rocket.rcsUllage }, { cw: true, ccw: false, ullage: true },
			'err 0.5 rad (continuous CW, zero thrust allows RCS), 2.0 - 1.0 s <= 1.5 s (ullage)');

		const buffer = transfer(om, [earth, rocket]);
		const off = slotOf(buffer, ROCKET_ID);
		assert.ok(off >= 0);
		assert.deepEqual(rcsBits(buffer[off + BUFFER_INDEX.FLAGS]), { cw: true, ccw: false, ullage: true }, 'ROCKET_FLAG RCS bits');
		assert.equal(buffer[off + BUFFER_INDEX.TM_MACH], rocket.mach, 'TM_MACH slot carries the worker Mach');
		assert.equal(buffer[slotOf(buffer, 1) + BUFFER_INDEX.TM_MACH], 0, 'celestial TM_MACH is 0');

		assert.deepEqual(mainFlags(main), { cw: true, ccw: false, ullage: true });
		assert.deepEqual(mainTmFlags(main), { cw: true, ccw: false, ullage: true });
		assert.equal(main.mach, rocket.mach);
		assert.equal(main.telemetry.mach, rocket.mach);
		assert.equal(main.stageState, 'INTERSTAGE_COAST');
		assert.equal(main.telemetry.stageIndex, 1);

		const ctx = createRecordingCtx();
		RocketRenderer.draw(ctx, main, 0, 0, R, 1.0);
		assertPlumesMatch(extractPlumes(ctx), designNozzles(designF9(1, true, R), { cw: true, ccw: false, ullage: true }), 'drawn RCS jets at the design nozzles');
		const layout = RocketRenderer._computeVisualLayout(main, R, VIS);
		assertLayoutDesign(layout, 1, true, R, 'interstage-coast layout (second stage, fairing on)');
		assertPlumesMatch(extractPlumes(ctx), designNozzles(layout, { cw: true, ccw: false, ullage: true }), 'drawn RCS jets');
		const cones = extractCones(ctx);
		assertConesMatch(cones, layout, main.mach, main.ambientPresRatio, 'drawn vapor cones');
		assert.equal(cones.length, 1, 'the second-stage stack has no interstage: the primary cone only, even at intensity ~0.81 (2026-11-23 R2)');
		assertNear(cones[0].xVertex, 0.6 * R, 1e-9, 'primary cone at the fairing base of the second-stage stack (0.600 R)');
	});

	it('design oracle: the Falcon 9 anchors reproduce the 2026-11-23 §3.4 table, and the main-thread layout follows it (R = 1)', () => {
		// [stage index, fairing on, noseShoulder, interstageShoulder, RCS forward / aft / wall] (table values, 3 decimals)
		const rows = [
			[0, true, [1.600, 0.650], [0.400, 0.700], [-0.283, -1.738, 0.700]],
			[0, false, [2.440, 0.5525], [0.400, 0.700], [-0.283, -1.738, 0.700]],
			[1, true, [0.600, 0.650], null, [0.408, -0.432, 0.650]],
			[1, false, [1.440, 0.5525], null, [0.408, -0.432, 0.650]]
		];
		for (const [stg, fairing, nose, inter, rcs] of rows) {
			const d = designF9(stg, fairing, 1);
			const label = `stage ${stg}, fairing ${fairing}`;
			assertNear(d.noseShoulder.x, nose[0], 5e-4, `${label}: noseShoulder.x`);
			assertNear(d.noseShoulder.halfWidth, nose[1], 5e-5, `${label}: noseShoulder.halfWidth`);
			if (inter) {
				assertNear(d.interstageShoulder.x, inter[0], 5e-4, `${label}: interstageShoulder.x`);
				assertNear(d.interstageShoulder.halfWidth, inter[1], 5e-4, `${label}: interstageShoulder.halfWidth`);
			} else {
				assert.equal(d.interstageShoulder, null, `${label}: no interstage`);
			}
			assertNear(d.rcs.cw[0].x, rcs[0], 5e-4, `${label}: forward nozzle`);
			assertNear(d.rcs.cw[1].x, rcs[1], 5e-4, `${label}: aft nozzle`);
			assertNear(d.rcs.cw[1].y, rcs[2], 5e-4, `${label}: wall`);
		}
		// The main-thread rocket of the fixtures (first stage, fairing on) has exactly these anchors
		const { main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		assertLayoutDesign(RocketRenderer._computeVisualLayout(main, 1, VIS), 0, true, 1, 'fixture rocket at R = 1');
	});

	it('every RCS bit combination survives the round trip and is drawn as the union of the table rows', () => {
		const { earth, rocket } = makeWorkerPair(0.5, 7000);
		const { om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		for (let mask = 0; mask < 8; mask++) {
			const flags = { cw: Boolean(mask & 1), ccw: Boolean(mask & 2), ullage: Boolean(mask & 4) };
			rocket.rcsCw = flags.cw; rocket.rcsCcw = flags.ccw; rocket.rcsUllage = flags.ullage;
			const buffer = transfer(om, [earth, rocket]);
			assert.deepEqual(rcsBits(buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.FLAGS]), flags, `bits for mask ${mask}`);
			assert.deepEqual(mainFlags(main), flags, `main flags for mask ${mask}`);
			assert.deepEqual(mainTmFlags(main), flags, `telemetry flags for mask ${mask}`);
			const ctx = createRecordingCtx();
			RocketRenderer.draw(ctx, main, 0, 0, 25, 1.0);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(designF9(0, true, 25), flags), `drawn mask ${mask} at the design nozzles`);
			const layout = RocketRenderer._computeVisualLayout(main, 25, VIS);
			assertLayoutDesign(layout, 0, true, 25, `layout for mask ${mask}`);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(layout, flags), `drawn mask ${mask}`);
			assert.equal(extractCones(ctx).length, 0, 'Mach 0.5 -> no vapor');
		}
	});

	it('hold-down guard: a held rocket never publishes RCS bits even with a live restart-ullage timer', () => {
		const { earth, rocket } = makeWorkerPair(0.0, 0);
		rocket.isHoldDown = true;
		rocket._ullageRestartTimer = 1.0;
		rocket.rcsCw = true;
		rocket._updateRcsState(0.1, 0, rocket.thrustAngle);
		const { om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		const buffer = transfer(om, [earth, rocket]);
		const flags = buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.FLAGS];
		assert.ok((flags & ROCKET_FLAG.HOLD_DOWN) !== 0);
		assert.deepEqual(rcsBits(flags), { cw: false, ccw: false, ullage: false });
		assert.deepEqual(mainFlags(main), { cw: false, ccw: false, ullage: false });
		assert.equal(main.mach, 0);
	});

	it('TM_MACH: worker Mach first, flight-computer telemetry as fallback, non-finite never reaches the main thread', () => {
		const { earth, rocket } = makeWorkerPair(1.1, 7000);
		const { om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		transfer(om, [earth, rocket]);
		assertNear(main.mach, 1.1, 1e-9, 'worker Mach');
		rocket.mach = undefined;
		rocket.flightComputer.telemetryCache.mach = 0.9;
		let buffer = transfer(om, [earth, rocket]);
		assert.equal(buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.TM_MACH], 0.9);
		assert.equal(main.mach, 0.9);
		assert.equal(main.telemetry.mach, 0.9);
		rocket.mach = NaN;
		buffer = transfer(om, [earth, rocket]);
		assert.ok(Number.isFinite(main.mach), 'main Mach stays finite');
		assert.equal(main.mach, 0);
		assert.equal(main.telemetry.mach, 0);
	});

	it('non-rocket objects never carry RCS bits or a Mach number', () => {
		const { earth, rocket } = makeWorkerPair(1.0, 7000);
		const deb = new CalcDebris(-5, 'Stray', 0, R_E + 7000, 0, 0, 0, 0, 1, 1, 1.0, 1, ROCKET_ID);
		deb.rcsCw = true; deb.rcsCcw = true; deb.rcsUllage = true; deb.mach = 3.3;
		earth.rcsCw = true; earth.mach = 2.2;
		const buffer = WorkerBridge.formatWorkerToMain([earth, deb, rocket]);
		for (const id of [1, -5]) {
			const off = slotOf(buffer, id);
			assert.deepEqual(rcsBits(buffer[off + BUFFER_INDEX.FLAGS]), { cw: false, ccw: false, ullage: false }, `id ${id}`);
			assert.equal(buffer[off + BUFFER_INDEX.TM_MACH], 0, `id ${id}`);
		}
		assertNear(buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.TM_MACH], 1.0, 1e-9, 'rocket Mach unaffected by neighbours');
	});
});

/*******************************************************************
 * 2. ObjectManager._applyRocketState guards
 *******************************************************************/
describe('Integration 12-2: ObjectManager._applyRocketState guards for RCS and Mach', () => {
	let om;
	let main;
	let base;

	beforeEach(() => {
		EventBus.clearAll();
		({ om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]));
		// A complete record exactly as WorkerBridge.parseWorkerToMain produces it
		const { earth, rocket } = makeWorkerPair(1.05, 7000);
		rocket.rcsCw = true; rocket.rcsCcw = false; rocket.rcsUllage = true;
		const buffer = WorkerBridge.formatWorkerToMain([earth, rocket]);
		WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (d) => { if (d.id === ROCKET_ID) base = { ...d }; });
		om.updateObjectParams({ ...base });
	});
	afterEach(() => EventBus.clearAll());

	it('the reference record sets flags and Mach on the rocket and its telemetry', () => {
		assert.deepEqual(mainFlags(main), { cw: true, ccw: false, ullage: true });
		assert.deepEqual(mainTmFlags(main), { cw: true, ccw: false, ullage: true });
		assertNear(main.mach, 1.05, 1e-9, 'Mach');
		assert.equal(main.telemetry.mach, main.mach);
	});

	it('missing RCS fields keep the previous flags (and telemetry mirrors them)', () => {
		const rec = { ...base };
		delete rec.rcsCw; delete rec.rcsCcw; delete rec.rcsUllage;
		om.updateObjectParams(rec);
		assert.deepEqual(mainFlags(main), { cw: true, ccw: false, ullage: true });
		assert.deepEqual(mainTmFlags(main), { cw: true, ccw: false, ullage: true });
	});

	it('present RCS fields are coerced with Boolean()', () => {
		om.updateObjectParams({ ...base, rcsCw: 0, rcsCcw: 1, rcsUllage: null });
		assert.deepEqual(mainFlags(main), { cw: false, ccw: true, ullage: false });
		assert.deepEqual(mainTmFlags(main), { cw: false, ccw: true, ullage: false });
		om.updateObjectParams({ ...base, rcsCw: 'yes', rcsCcw: '', rcsUllage: false });
		assert.deepEqual(mainFlags(main), { cw: true, ccw: false, ullage: false });
	});

	for (const bad of [undefined, null, NaN, Infinity, -Infinity, '0.5']) {
		it(`a non-finite / non-numeric Mach (${String(bad)}) keeps the previous value on the rocket and in telemetry`, () => {
			const before = main.mach;
			om.updateObjectParams({ ...base, mach: bad });
			assert.equal(main.mach, before);
			assert.equal(main.telemetry.mach, before);
		});
	}

	it('a finite Mach of 0 (boundary) is applied', () => {
		om.updateObjectParams({ ...base, mach: 0 });
		assert.equal(main.mach, 0);
		assert.equal(main.telemetry.mach, 0);
		om.updateObjectParams({ ...base, mach: 1.2 });
		assert.equal(main.mach, 1.2);
		assert.equal(main.telemetry.mach, 1.2);
	});

	it('an unknown rocket id is ignored without side effects', () => {
		assert.doesNotThrow(() => om.updateObjectParams({ ...base, id: 4242, rcsCw: false, mach: 0.3 }));
		assert.equal(main.rcsCw, true);
		assertNear(main.mach, 1.05, 1e-9, 'unchanged');
	});
});

/*******************************************************************
 * 3. Real flight through PhysicsEngine
 *******************************************************************/
describe('Integration 12-3: real Falcon 9 / LEO flight through PhysicsEngine', () => {
	const DT = 0.25;
	const MAX_T = 200;
	let flight;

	const seededRandom = (seed) => {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s / 4294967296;
		};
	};

	const fly = () => {
		EventBus.clearAll();
		const AU = 149597870700;
		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: 29780, mass: 5.972e24, radius: R_E });
		const dy = -(R_E + 10);
		const st = PLAN.stages[0];
		const rocket = engine.addObject({
			id: ROCKET_ID, name: 'Falcon 9 Style (2-Stage)', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx - OMEGA_E * dy, vy: earth.vy,
			radius: st.radius || 2.0, mass: st.dryMassT, fuelMass: st.fuelMassT, oxidMass: st.oxidMassT,
			burnTime: st.burnTime, ofRatio: st.ofRatio, thrustForce: st.thrustKN * 1000, thrustAngle: -Math.PI / 2,
			maxGLimit: 4.0, isIgnited: true, isHoldDown: false,
			stages: clone(PLAN.stages), payload: clone(PLAN.payload), fairing: clone(PLAN.fairing), boosters: PLAN.boosters,
			flightProfile: clone(PLAN.flightProfile), disableOrbitalCutoff: PLAN.disableOrbitalCutoff,
			targetApogeeKm: PLAN.targetApogeeKm, targetPerigeeKm: PLAN.targetPerigeeKm
		});
		engine._categorizeBodies();
		const { om, main } = makeMainWorld([
			{ id: 0, name: 'Sun', massT: 1.989e27, radius: 696340000 },
			{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }
		]);

		const steps = [];
		const origRandom = Math.random;
		Math.random = seededRandom(12345);
		try {
			for (let i = 0; i < MAX_T / DT; i++) {
				const pre = rocket.thrustAngle;
				const presBefore = rocket.ambientPresRatio;
				const vBefore = { x: rocket.vx, y: rocket.vy };
				const earthVBefore = { x: earth.vx, y: earth.vy };
				const stageBefore = rocket.currentStageIndex;
				engine._moveObjects(DT);
				const buffer = transfer(om, engine.objects);
				const flags = buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.FLAGS];
				const alt = Math.hypot(rocket.x - earth.x, rocket.y - earth.y) - R_E;
				// Draw the live main-thread Rocket whenever an effect is (or should be) visible
				let drawn = null;
				if (main.rcsCw || main.rcsCcw || main.rcsUllage || designVapor(main.mach, main.ambientPresRatio).active || i % 40 === 0) {
					const ctx = createRecordingCtx();
					RocketRenderer.draw(ctx, main, 0, 0, 30, 1.0);
					drawn = { plumes: extractPlumes(ctx), cones: extractCones(ctx), layout: RocketRenderer._computeVisualLayout(main, 30, VIS) };
				}
				steps.push({
					drawn,
					i, t: (i + 1) * DT, pre, presBefore, vBefore, earthVBefore, separated: rocket.currentStageIndex !== stageBefore,
					alt, rx: rocket.x - earth.x, ry: rocket.y - earth.y,
					mach: rocket.mach, pres: rocket.ambientPresRatio, inAtm: rocket.inAtmosphere,
					state: rocket.stageState, stageIndex: rocket.currentStageIndex, stgTimer: rocket.stgTimer,
					timer: rocket._postSepRcsTimer, restart: rocket._ullageRestartTimer, thrustRatio: rocket._thrustRatio,
					desired: rocket.flightComputer.desiredThrustAngleRad, tPulse: rocket.flightComputer.flightTime,
					ignDelay: rocket.stages[rocket.currentStageIndex]?.ignitionDelaySec ?? 2.0,
					worker: { cw: rocket.rcsCw, ccw: rocket.rcsCcw, ullage: rocket.rcsUllage },
					bits: rcsBits(flags), bufMach: buffer[slotOf(buffer, ROCKET_ID) + BUFFER_INDEX.TM_MACH],
					main: mainFlags(main), mainTm: mainTmFlags(main), mainMach: main.mach, mainTmMach: main.telemetry.mach,
					mainPres: main.ambientPresRatio, mainState: main.stageState,
					fairingSep: Boolean(rocket.fairing?.isSeparated)
				});
			}
		} finally {
			Math.random = origRandom;
		}
		return { steps, om, main, rocket };
	};

	const getFlight = () => {
		if (!flight) flight = fly();
		return flight;
	};

	it('the flight goes transonic in dense air and reaches the second-stage burn above the atmosphere', () => {
		const { steps } = getFlight();
		const transonic = steps.filter(s => designVapor(s.mach, s.pres).active);
		assert.ok(transonic.length >= 10, `transonic vapor active on ${transonic.length} steps`);
		assert.ok(transonic.some(s => designVapor(s.mach, s.pres).intensity >= 0.55), 'secondary-cone intensity reached');
		for (const s of transonic) {
			assert.ok(s.alt < 20000 && s.inAtm, `vapor only low in the atmosphere (t ${s.t}, alt ${s.alt})`);
		}
		assert.ok(steps.some(s => s.alt > 100000), 'climbs above ATM_LIMIT_ALT');
		const sep = steps.find(s => s.separated);
		assert.ok(sep, 'stage separation happened');
		assert.ok(steps.some(s => s.t > sep.t && s.state === 'STG_BURNING' && s.stageIndex === 1), 'second stage ignited');
	});

	it('each step: worker Mach follows the design formula; exactly 0 above the atmosphere limit', () => {
		const { steps } = getFlight();
		let checked = 0;
		for (const s of steps) {
			if (s.alt > EARTH_PARAM.ATM_LIMIT_ALT) {
				assert.equal(s.mach, 0, `t ${s.t}: above the atmosphere`);
				assert.equal(s.inAtm, false);
				continue;
			}
			if (s.separated) continue; // the separation push changes the airspeed inside the step
			// Near the pad the engine's body distance is floored at (R_E + rocket radius) by the gravity
			// soft-radius, so the Mach altitude there is not the geometric one; compare above 1 km only.
			if (s.alt < 1000) continue;
			const vAtmX = s.earthVBefore.x - OMEGA_E * s.ry;
			const vAtmY = s.earthVBefore.y + OMEGA_E * s.rx;
			const airspeed = Math.hypot(s.vBefore.x - vAtmX, s.vBefore.y - vAtmY);
			const expected = airspeed / designSpeedOfSound(designTemperatureK(s.alt, EARTH_PARAM.ATM_SCALE_HEIGHT));
			assertNear(s.mach, expected, 1e-6 * Math.max(1, expected), `t ${s.t}: Mach`);
			checked++;
		}
		assert.ok(checked > 300, `${checked} in-atmosphere steps checked`);
	});

	it('each step: RCS flags and Mach reach the main-thread Rocket and its telemetry unchanged', () => {
		const { steps } = getFlight();
		for (const s of steps) {
			assert.deepEqual(s.bits, s.worker, `t ${s.t}: ROCKET_FLAG bits`);
			assert.deepEqual(s.main, s.worker, `t ${s.t}: Rocket flags`);
			assert.deepEqual(s.mainTm, s.worker, `t ${s.t}: telemetry flags`);
			assert.equal(s.bufMach, s.mach, `t ${s.t}: TM_MACH`);
			assert.equal(s.mainMach, s.mach, `t ${s.t}: Rocket.mach`);
			assert.equal(s.mainTmMach, s.mach, `t ${s.t}: telemetry.mach`);
			assert.equal(s.mainPres, s.pres, `t ${s.t}: ambient pressure ratio`);
			assert.equal(s.mainState, s.state, `t ${s.t}: stage state`);
		}
	});

	it('each step: the settle timer follows the separations (2.5 s at stage / fairing separation, then -dt per step)', () => {
		const { steps } = getFlight();
		// Oracle from the design (§3.2-2): every separation sets POST_SEP_SETTLE_S, and _updateRcsState, which runs after the
		// separation logic of the same flightControl, subtracts dt and floors at 0.
		let timer = 0;
		let fairingAttached = Boolean(PLAN.fairing?.enabled) && !PLAN.fairing?.isSeparated;
		const events = { stage: 0, fairing: 0 };
		for (const s of steps) {
			const fairingSep = fairingAttached && s.fairingSep;
			if (fairingSep) { fairingAttached = false; events.fairing++; }
			if (s.separated) events.stage++;
			timer = (s.separated || fairingSep) ? 2.5 - DT : Math.max(0, timer - DT);
			assert.equal(s.timer, timer, `t ${s.t}: settle timer (stage sep ${s.separated}, fairing sep ${fairingSep})`);
		}
		assert.deepEqual(events, { stage: 1, fairing: 1 }, 'the flight covers one stage and one fairing separation');
	});

	it('each step: worker CW / CCW / ullage equal the design decision of §3.2-2', () => {
		const { steps } = getFlight();
		const seen = { cw: 0, ccw: 0, ullage: 0, damping: 0, pulsedOff: 0, denseInhibited: 0 };
		let timer = 0;
		let fairingAttached = Boolean(PLAN.fairing?.enabled) && !PLAN.fairing?.isSeparated;
		for (const s of steps) {
			const err = MathUtils.normalizeAngle(s.desired - s.pre);
			const thrusting = s.thrustRatio > 0;
			// settle timer from the separation events (oracle of the previous test), not from the worker state
			const fairingSep = fairingAttached && s.fairingSep;
			if (fairingSep) fairingAttached = false;
			timer = (s.separated || fairingSep) ? 2.5 - DT : Math.max(0, timer - DT);
			const exp = designAttitudeJets({ err, pres: s.presBefore, thrusting, timer, tPulse: s.tPulse });
			assert.deepEqual({ cw: s.worker.cw, ccw: s.worker.ccw }, { cw: exp.cw, ccw: exp.ccw },
				`t ${s.t}: err ${err}, pres ${s.presBefore}, thrusting ${thrusting}, timer ${s.timer}, tPulse ${s.tPulse}`);
			const ullage = (s.state === 'INTERSTAGE_COAST' && (s.ignDelay - s.stgTimer) <= 1.5) || s.restart > 0;
			assert.equal(s.worker.ullage, ullage, `t ${s.t}: ullage`);
			if (s.worker.cw) seen.cw++;
			if (s.worker.ccw) seen.ccw++;
			if (s.worker.ullage) seen.ullage++;
			if (timer > 0 && Math.abs(err) <= 0.015 && (s.worker.cw || s.worker.ccw)) seen.damping++;
			if (exp.allow && Math.abs(err) > 0.015 && Math.abs(err) < 0.08 && timer === 0 && !s.worker.cw && !s.worker.ccw) seen.pulsedOff++;
			if (!exp.allow) seen.denseInhibited++; // dense powered ascent: RCS inhibited (oracle asserted above)
		}
		for (const [k, v] of Object.entries(seen)) {
			assert.ok(v > 0, `flight exercises "${k}" (${v} steps)`);
		}
	});

	it('around staging: settle timer starts at separation, ullage covers the last 1.5 s of the coast and ends at ignition', () => {
		const { steps } = getFlight();
		const sepIdx = steps.findIndex(s => s.separated);
		const sep = steps[sepIdx];
		assert.equal(sep.state, 'INTERSTAGE_COAST');
		assert.equal(sep.timer, 2.5 - DT, 'POST_SEP_SETTLE_S minus the separation step');
		assert.equal(sep.stgTimer, 0);
		const ignIdx = steps.findIndex((s, k) => k > sepIdx && s.state === 'STG_BURNING');
		const ignDelay = PLAN.stages[1].ignitionDelaySec ?? 2.0;
		assert.equal(ignIdx - sepIdx, ignDelay / DT, 'ignition after the configured delay');
		for (let k = sepIdx; k < ignIdx; k++) {
			const s = steps[k];
			assert.equal(s.state, 'INTERSTAGE_COAST');
			assert.equal(s.worker.ullage, (ignDelay - s.stgTimer) <= 1.5, `coast step ${k - sepIdx}: ullage`);
		}
		const firstUllage = steps.findIndex((s, k) => k >= sepIdx && s.worker.ullage);
		assertNear(steps[firstUllage].stgTimer, ignDelay - 1.5, 1e-12, 'ullage starts with 1.5 s left');
		assert.equal(steps[ignIdx].worker.ullage, false, 'no ullage once the engine burns');
		assert.equal(steps[ignIdx - 1].worker.ullage, true, 'ullage right up to ignition');
		const settleEnd = steps.findIndex((s, k) => k > sepIdx && s.timer === 0);
		assert.equal(settleEnd - sepIdx, 2.5 / DT - 1, 'settle window lasts POST_SEP_SETTLE_S');
	});

	it('the live main-thread Rocket is drawn with the design jets and cones on every effect step', () => {
		const { steps } = getFlight();
		const drawnSteps = steps.filter(s => s.drawn);
		let jetSteps = 0;
		let ullageSteps = 0;
		let coneSteps = 0;
		let doubleConeSteps = 0;
		for (const s of drawnSteps) {
			assertPlumesMatch(s.drawn.plumes, designNozzles(designF9(s.stageIndex, !s.fairingSep, 30), s.worker), `t ${s.t}: jets at the design nozzles`);
			assertLayoutDesign(s.drawn.layout, s.stageIndex, !s.fairingSep, 30, `t ${s.t}: layout (stage ${s.stageIndex}, fairing separated ${s.fairingSep})`);
			assertPlumesMatch(s.drawn.plumes, designNozzles(s.drawn.layout, s.worker), `t ${s.t}: jets`);
			assertConesMatch(s.drawn.cones, s.drawn.layout, s.mach, s.pres, `t ${s.t}: cones`);
			if (s.drawn.plumes.length > 0) jetSteps++;
			if (s.worker.ullage) ullageSteps++;
			if (s.drawn.cones.length > 0) coneSteps++;
			if (s.drawn.cones.length === 2) doubleConeSteps++;
		}
		assert.ok(jetSteps > 0 && ullageSteps > 0, `jets drawn on ${jetSteps} steps (${ullageSteps} with ullage)`);
		assert.ok(coneSteps >= 10 && doubleConeSteps > 0, `cones drawn on ${coneSteps} steps (${doubleConeSteps} with the secondary)`);
		const ullStep = drawnSteps.find(s => s.worker.ullage && s.state === 'INTERSTAGE_COAST');
		assert.ok(ullStep, 'ullage drawn during the interstage coast');
		// The jets leave the wall of the second stage (its radius), not the widest radius of the stack
		const wall = 30 * VIS.MODULES.STAGE2_RADIUS_RATIO;
		const nozzles = designNozzles(ullStep.drawn.layout, { cw: true, ccw: true, ullage: true });
		assert.equal(nozzles.length, 6, 'every nozzle of layout.rcs');
		for (const n of nozzles) {
			assert.equal(Math.abs(n.y), wall, 'upper-stage layout after separation: the layout.rcs wall is the stage-2 radius');
		}
	});

	it('the live main-thread rocket after the flight (vacuum) draws no vapor cone and reports Mach 0', () => {
		const { main, rocket } = getFlight();
		assert.equal(rocket.mach, 0);
		assert.equal(main.mach, 0);
		assert.equal(main.telemetry.mach, 0);
		const ctx = createRecordingCtx();
		RocketRenderer.draw(ctx, main, 0, 0, 30, 1.0);
		assert.equal(extractCones(ctx).length, 0);
		assertPlumesMatch(extractPlumes(ctx), designNozzles(designF9(rocket.currentStageIndex, !rocket.fairing?.isSeparated, 30), mainFlags(main)), 'final jets at the design nozzles');
		const layout = RocketRenderer._computeVisualLayout(main, 30, VIS);
		assertLayoutDesign(layout, rocket.currentStageIndex, !rocket.fairing?.isSeparated, 30, 'final layout');
		assertPlumesMatch(extractPlumes(ctx), designNozzles(layout, mainFlags(main)), 'final jets');
	});

	it('SoundEffects reads the synchronised telemetry.mach of the live rocket (TM_MACH -> telemetry -> whine)', () => {
		const { om, main } = makeMainWorld([{ id: 1, name: 'Earth', massT: 5.972e21, radius: R_E }]);
		const { earth, rocket } = makeWorkerPair(1.6, 9000);
		rocket._qAxialKpa = 20;
		rocket.flightComputer.telemetryCache.qAxialKpa = 20;
		rocket._thrustRatio = 1.0;
		transfer(om, [earth, rocket]);
		assertNear(main.telemetry.mach, 1.6, 1e-9, 'synchronised Mach');
		assert.equal(main.inAtmosphere, true);
		EventBus.clearAll();
		const savedCtx = globalThis.window.AudioContext;
		globalThis.window.AudioContext = RecAudioContext;
		try {
			const se = new SoundEffects({ objects: om.objects, LaunchSequencer: { rocketId: ROCKET_ID }, camera: {} });
			se._initAudio();
			se.update(0.016, 0.016);
			const cfg = SOUND_FX_CONFIG.supersonicWhine;
			const whine = se.voices.supersonicWhine;
			assert.equal(whine.isRunning, true);
			const expected = cfg.baseFreq + Math.min((1.6 - cfg.machMin) / (cfg.machMax - cfg.machMin), 1) * cfg.freqRange;
			const got = whine.osc1.frequency.targets[whine.osc1.frequency.targets.length - 1];
			assertNear(got, expected, 1e-6, 'whine frequency from the synchronised Mach');
			whine.stop();
			se.voices.engineRoar.stop();
		} finally {
			globalThis.window.AudioContext = savedCtx;
			EventBus.clearAll();
		}
	});
});
