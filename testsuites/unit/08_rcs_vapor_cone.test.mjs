/**
 * Unit Test Suite 08: Cold-gas RCS, AeroUtils (temperature / speed of sound / Mach),
 * transonic vapor cone, Mach zero-clear and the SoundEffects Mach source.
 *
 * Design:    docs/design/2026-11-20_trajectory_fx_flightplan.md §3.2, §3.3, §4.4
 *            (§4.4 replaces the vapor-cone bell formula of §3.3)
 *            docs/design/2026-11-23_vapor_cone_rcs_anchors.md §3.2-§3.6, §3.9 (replaces the RCS nozzle stations and
 *            the vapor-cone stations of 2026-11-20 §3.2-3 / §3.3: the effects are anchored on the drawn geometry)
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-C
 *            docs/design/2026-11-23_vapor_cone_rcs_anchors.md §5.1-3 (geometry), §5.1-4 (anchors), §5.1-5 (vapor cone),
 *            §5.1-6 (RCS), §5.1-10 (VAPOR_CONE schema)
 *
 * Every expected value below is derived from the design formulas and tables
 * (RCS_CONFIG, the nozzle position / jet-vector table, the AeroUtils equations, the
 * COLD_GAS_RCS / VAPOR_CONE schemas, and the 2026-11-23 §3.2 position table, §3.4 anchor table, §3.6 free-wall rule
 * and §1.5 cloud table), never from the current implementation output.
 * SoundEffects voice levels come from its own SOUND_FX_CONFIG parameter table.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMockDOM } from '../test_helpers.mjs';
import { CalcRocket, CalcDebris, CalcCelestialBody } from '../../scripts/gravsim_calc_object.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { AeroUtils } from '../../scripts/gravsim_utils.js';
import { SoundEffects, SOUND_FX_CONFIG } from '../../scripts/gravsim_sound_effects.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PresetManager, presetManager, ROCKET_VISUAL } from '../../scripts/gravsim_preset_manager.js';
import {
	RCS_CONFIG, AERO_DYNAMIC, ROCKET_FLAG, OBJECT_TYPES, MULTISTAGE_ROCKET, FLIGHT_COMPUTER_CONFIG, OBJECT_STATE
} from '../../scripts/gravsim_const.js';

setupMockDOM();

/*******************************************************************
 * Design tables (literal copies of the design document)
 *******************************************************************/
const D_RCS = Object.freeze({
	ATTITUDE_DEADBAND_RAD: 0.015,
	SLEW_CONTINUOUS_RAD: 0.08,
	LOW_AERO_PRES_RATIO: 0.35,
	PULSE_PERIOD_S: 0.45,
	PULSE_DUTY: 0.42,
	POST_SEP_SETTLE_S: 2.5,
	POST_SEP_DAMP_PERIOD_S: 0.35,
	POST_SEP_DAMP_PULSE_S: 0.09,
	ULLAGE_PRE_IGNITION_S: 1.5,
	ULLAGE_POST_COAST_S: 1.2
});
const D_COLD_GAS = Object.freeze({
	FWD_STATION_FRACTION: 0.84,
	AFT_STATION_FRACTION: 0.14,
	PLUME_LEN_WIDTH_RATIO: 2.4,
	MIN_PLUME_PX: 4.0,
	PLUME_SPREAD_RAD: 0.34,
	ULLAGE_CANT_RAD: 0.28,
	CORE_COLOR: 'rgba(235, 248, 255, 0.85)',
	MIST_COLOR: 'rgba(195, 228, 255, 0.28)'
});
// design 2026-11-23 §3.9: VAPOR_CONE without PRIMARY_STATION_FRACTION / SECONDARY_STATION_FRACTION
const D_VAPOR = Object.freeze({
	SECONDARY_INTENSITY_MIN: 0.55,
	CONE_LENGTH_RATIO: 2.2,
	MAX_WIDTH_MULTIPLIER: 2.8,
	CORE_COLOR: 'rgba(240, 248, 255, 0.70)',
	EDGE_COLOR: 'rgba(185, 215, 255, 0.0)',
	RIM_COLOR: 'rgba(255, 255, 255, 0.55)'
});
const D_MACH_ANGLE_CAP = Math.asin(0.96); // design: "max ~73.74 deg"
const EARTH_ATM = Object.freeze({ ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500, ATM_LIMIT_ALT: 100000 });
const UNLIMITED_ATM = Object.freeze({ ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 });

/*******************************************************************
 * Design-formula oracles (§3.3-1 and §4.4)
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
const smoothstep = (u) => u * u * (3 - 2 * u);
const designVapor = (mach, pres) => {
	if (!Number.isFinite(mach) || !Number.isFinite(pres) || mach < 0.82 || mach > 1.22 || pres <= 0.015) {
		return { active: false, intensity: 0, machAngleRad: Math.PI / 2 };
	}
	const span = (mach <= 1.0) ? (1.0 - 0.82) : (1.22 - 1.0);
	const u = Math.max(0, 1 - Math.abs(mach - 1.0) / Math.max(0.01, span));
	const intensity = smoothstep(u) * Math.min(1, Math.max(0, (pres - 0.015) / 0.25));
	return { active: intensity > 0.01, intensity, machAngleRad: Math.asin(Math.min(0.96, 1 / Math.max(1 / 0.96, mach))) };
};
// Post-separation alternating damping (§3.2-2): phase = timer % 0.35; CW < 0.09; CCW in [0.175, 0.265)
const designDamp = (timer) => {
	if (!(timer > 0)) return { cw: false, ccw: false };
	const phase = timer % 0.35;
	return { cw: phase < 0.09, ccw: phase >= 0.175 && phase < 0.175 + 0.09 };
};

const assertNear = (actual, expected, tol, msg) => {
	assert.ok(Number.isFinite(actual), `${msg}: expected a finite number, got ${actual}`);
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
};

/*******************************************************************
 * CalcRocket helpers
 *******************************************************************/
const makeStages = () => ([
	{ stageNumber: 1, dryMassT: 20, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, burnTime: 150, ofRatio: 2, isp: 300, separationDelaySec: 0.5, ignitionDelaySec: 2.0 },
	{ stageNumber: 2, dryMassT: 4, fuelMassT: 30, oxidMassT: 60, thrustKN: 900, burnTime: 300, ofRatio: 2, isp: 340, separationDelaySec: 0.5, ignitionDelaySec: 2.0 }
]);
const makeCalcRocket = (thrustData = {}) => new CalcRocket(
	7, 'RCS Unit Rocket', 0, 0, 0, 0, 0, 0, 10, 0, 20, 100, 200,
	{
		stages: makeStages(),
		payload: { name: 'Unit Sat', massT: 2, radius: 1.5 },
		fairing: { enabled: false, massT: 0 },
		isHoldDown: false,
		isIgnited: true,
		thrustAngle: 0,
		...thrustData
	}
);
/** Puts a rocket into a fully specified RCS input state. */
const primeRcs = (rocket, o = {}) => {
	rocket.isHoldDown = false;
	rocket.collided = false;
	rocket.shattered = false;
	rocket.autoControl = o.autoControl ?? true;
	rocket.ambientPresRatio = o.pres ?? 0;
	rocket.stageState = o.state ?? 'STG_BURNING';
	rocket.stgTimer = o.stgTimer ?? 0;
	rocket.currentStageIndex = o.stageIndex ?? 0;
	rocket._postSepRcsTimer = ('postSep' in o) ? o.postSep : 0;
	rocket._ullageRestartTimer = ('ullageRestart' in o) ? o.ullageRestart : 0;
	if (rocket.flightComputer) {
		rocket.flightComputer.flightTime = ('t' in o) ? o.t : 0;
		rocket.flightComputer.desiredThrustAngleRad = ('desired' in o) ? o.desired : 0;
	}
	return rocket;
};
const runRcs = (o = {}, call = {}) => {
	const rocket = primeRcs(makeCalcRocket(), o);
	rocket._updateRcsState(call.dt ?? 0, call.thrustN ?? 1.0e6, call.pre ?? 0);
	return rocket;
};
const flagsOf = (r) => ({ cw: r.rcsCw, ccw: r.rcsCcw, ullage: r.rcsUllage });
const tmFlagsOf = (r) => ({ cw: r.flightComputer.telemetryCache.rcsCw, ccw: r.flightComputer.telemetryCache.rcsCcw, ullage: r.flightComputer.telemetryCache.rcsUllage });

/*******************************************************************
 * Recording canvas context
 *******************************************************************/
/**
 * Records fills, strokes and gradients. With { track: true } translate() offsets the recorded coordinates (save /
 * restore keep the offset), so parts drawn in their own frame (the payload satellite, the plumes) are recorded in the
 * rocket frame; rotation and scaling are not tracked and throw when used with a non-identity value. Without tracking
 * (the default) coordinates are recorded as passed.
 */
const createRecordingCtx = (opts = {}) => {
	const track = Boolean(opts.track);
	const fills = [];
	const strokes = [];
	const gradients = [];
	const stack = [];
	let path = [];
	let tx = 0;
	let ty = 0;
	const at = (x, y) => (track ? { x: x + tx, y: y + ty } : { x, y });
	const untracked = (what, isIdentity) => {
		if (track && !isIdentity) throw new Error(`recording ctx: ${what} is not tracked`);
	};
	const makeGradient = (kind, args) => {
		const g = { kind, args, stops: [], addColorStop(offset, color) { g.stops.push([offset, color]); } };
		gradients.push(g);
		return g;
	};
	const ctx = {
		fills, strokes, gradients,
		fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
		shadowColor: '', shadowBlur: 0, lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left', textBaseline: 'alphabetic',
		canvas: { width: 800, height: 600 },
		save() { stack.push({ style: { fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, globalAlpha: ctx.globalAlpha }, tx, ty }); },
		restore() { const s = stack.pop(); if (s) { Object.assign(ctx, s.style); tx = s.tx; ty = s.ty; } },
		translate(x, y) { if (track) { tx += x; ty += y; } },
		rotate(a) { untracked('rotate', a === 0); },
		scale(sx, sy) { untracked('scale', sx === 1 && sy === 1); },
		setTransform() { untracked('setTransform', false); },
		transform() { untracked('transform', false); },
		clip() {},
		beginPath() { path = []; },
		closePath() { path.push({ op: 'closePath' }); },
		moveTo(x, y) { path.push({ op: 'moveTo', ...at(x, y) }); },
		lineTo(x, y) { path.push({ op: 'lineTo', ...at(x, y) }); },
		quadraticCurveTo(cpx, cpy, x, y) { const c = at(cpx, cpy); path.push({ op: 'quad', cpx: c.x, cpy: c.y, ...at(x, y) }); },
		bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { path.push({ op: 'bezier', ...at(x, y) }); },
		arc(x, y, r, a0, a1) { path.push({ op: 'arc', ...at(x, y), r, a0, a1 }); },
		ellipse(x, y, rx, ry) { path.push({ op: 'ellipse', ...at(x, y), rx, ry }); },
		rect(x, y, w, h) { path.push({ op: 'rect', ...at(x, y), w, h }); },
		roundRect(x, y, w, h) { path.push({ op: 'rect', ...at(x, y), w, h }); },
		fill() { fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha, path: path.slice() }); },
		stroke() { strokes.push({ style: ctx.strokeStyle, alpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, path: path.slice() }); },
		fillRect(x, y, w, h) { fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha, path: [{ op: 'rect', ...at(x, y), w, h }] }); },
		strokeRect() {}, clearRect() {},
		createLinearGradient(...args) { return makeGradient('linear', args); },
		createRadialGradient(...args) { return makeGradient('radial', args); },
		setLineDash() {}, getLineDash() { return []; },
		measureText(t) { return { width: String(t ?? '').length * 8 }; },
		fillText() {}, strokeText() {}, drawImage() {}
	};
	return ctx;
};

/** Decodes every RCS plume (mist cone) drawn with the COLD_GAS_RCS mist colour; pts is the drawn triangle. */
const extractPlumes = (ctx, mistColor = D_COLD_GAS.MIST_COLOR) => ctx.fills
	.filter(f => f.style === mistColor)
	.map(f => {
		const [apex, a, b] = f.path;
		assert.equal(apex.op, 'moveTo');
		assert.equal(a.op, 'lineTo');
		assert.equal(b.op, 'lineTo');
		const mx = (a.x + b.x) / 2 - apex.x;
		const my = (a.y + b.y) / 2 - apex.y;
		const n = Math.hypot(mx, my);
		const ux = mx / n;
		const uy = my / n;
		const lenA = Math.hypot(a.x - apex.x, a.y - apex.y);
		const lenB = Math.hypot(b.x - apex.x, b.y - apex.y);
		const spreadA = Math.acos(Math.max(-1, Math.min(1, ((a.x - apex.x) * ux + (a.y - apex.y) * uy) / lenA)));
		const spreadB = Math.acos(Math.max(-1, Math.min(1, ((b.x - apex.x) * ux + (b.y - apex.y) * uy) / lenB)));
		return { x: apex.x, y: apex.y, ux, uy, lenA, lenB, spreadA, spreadB, pts: [[apex.x, apex.y], [a.x, a.y], [b.x, b.y]] };
	});
const extractCorePlumes = (ctx) => extractPlumes(ctx, D_COLD_GAS.CORE_COLOR);

/** §3.6.1 nozzle table of a stack: CW / CCW lateral jets from the wall ±h at xFwd / xAft, ullage canted aft at xAft. */
const designStackNozzles = ({ xFwd, xAft, h, plumeLen }) => {
	const c = D_COLD_GAS.ULLAGE_CANT_RAD;
	return {
		plumeLen,
		cw: [{ x: xFwd, y: -h, ux: 0, uy: -1 }, { x: xAft, y: +h, ux: 0, uy: +1 }],
		ccw: [{ x: xFwd, y: +h, ux: 0, uy: +1 }, { x: xAft, y: -h, ux: 0, uy: -1 }],
		ullage: [{ x: xAft, y: +h, ux: -Math.cos(c), uy: +Math.sin(c) }, { x: xAft, y: -h, ux: -Math.cos(c), uy: -Math.sin(c) }]
	};
};
/** §3.6.2 nozzle table of the payload alone: axial jets from the bus corners (±a, ±b). */
const designPayloadNozzles = ({ a, b, plumeLen }) => {
	const c = D_COLD_GAS.ULLAGE_CANT_RAD;
	return {
		plumeLen,
		cw: [{ x: -a, y: -b, ux: -1, uy: 0 }, { x: +a, y: +b, ux: +1, uy: 0 }],
		ccw: [{ x: -a, y: +b, ux: -1, uy: 0 }, { x: +a, y: -b, ux: +1, uy: 0 }],
		ullage: [{ x: -a, y: +b, ux: -Math.cos(c), uy: +Math.sin(c) }, { x: -a, y: -b, ux: -Math.cos(c), uy: -Math.sin(c) }]
	};
};
/** The design rows (of a design nozzle table) that a flag combination fires. */
const designNozzles = (rcs, flags) => [
	...(flags.cw ? rcs.cw : []),
	...(flags.ccw ? rcs.ccw : []),
	...(flags.ullage ? rcs.ullage : [])
];
const assertPlumesMatch = (actual, expected, msg, tol = 1e-9) => {
	assert.equal(actual.length, expected.length, `${msg}: plume count`);
	const pool = actual.slice();
	for (const e of expected) {
		const idx = pool.findIndex(p => Math.abs(p.x - e.x) < tol && Math.abs(p.y - e.y) < tol
			&& Math.abs(p.ux - e.ux) < 1e-9 && Math.abs(p.uy - e.uy) < 1e-9);
		assert.ok(idx >= 0, `${msg}: no plume at (${e.x}, ${e.y}) with jet (${e.ux}, ${e.uy}); drawn ${JSON.stringify(pool.map(p => [p.x, p.y, p.ux, p.uy]))}`);
		pool.splice(idx, 1);
	}
};
/** layout.rcs against a design nozzle table: same keys, plume length and every nozzle in table order. */
const assertRcsNear = (actual, expected, tol, msg) => {
	assert.ok(actual && typeof actual === 'object', `${msg}: rcs present`);
	assert.deepEqual(Object.keys(actual).sort(), ['ccw', 'cw', 'plumeLen', 'ullage'], `${msg}: rcs keys`);
	assertNear(actual.plumeLen, expected.plumeLen, tol, `${msg}: plumeLen`);
	for (const key of ['cw', 'ccw', 'ullage']) {
		assert.equal(actual[key].length, 2, `${msg}: two ${key} nozzles`);
		actual[key].forEach((nz, i) => {
			const e = expected[key][i];
			assert.deepEqual(Object.keys(nz).sort(), ['ux', 'uy', 'x', 'y'], `${msg}: ${key}[${i}] keys`);
			assertNear(nz.x, e.x, tol, `${msg}: ${key}[${i}].x`);
			assertNear(nz.y, e.y, tol, `${msg}: ${key}[${i}].y`);
			assertNear(nz.ux, e.ux, 1e-12, `${msg}: ${key}[${i}].ux`);
			assertNear(nz.uy, e.uy, 1e-12, `${msg}: ${key}[${i}].uy`);
		});
	}
};
/** Canvas torque (+y down, +Δθ = CW): τ = rx Fy - ry Fx, the reaction force opposing the jet. */
const jetTorque = (nozzles) => nozzles.reduce((tz, p) => tz + p.x * (-p.uy) - p.y * (-p.ux), 0);
const jetForce = (nozzles) => nozzles.reduce((f, p) => ({ x: f.x - p.ux, y: f.y - p.uy }), { x: 0, y: 0 });

/** Decodes every vapor cone (radial-gradient fill whose core stop is VAPOR_CONE.CORE_COLOR). */
const extractCones = (ctx) => ctx.fills
	.filter(f => f.style && f.style.kind === 'radial' && f.style.stops.some(s => s[1] === D_VAPOR.CORE_COLOR))
	.map(f => {
		const [m, q1, q2, q3] = f.path;
		assert.equal(m.op, 'moveTo');
		assert.equal(q1.op, 'quad');
		assert.equal(q2.op, 'quad');
		assert.equal(q3.op, 'quad');
		assert.equal(m.y, 0, 'cone vertex lies on the body axis');
		assert.equal(q3.x, m.x, 'cone outline closes at the vertex');
		assert.equal(q1.x, q2.x, 'both trailing edges end at the same back station');
		return { xVertex: m.x, coneLen: m.x - q1.x, halfW: q2.y, halfWTop: -q1.y, stops: f.style.stops, grad: f.style.args, q1, q2, q3 };
	});
const extractRims = (ctx) => ctx.strokes.filter(s => s.style === D_VAPOR.RIM_COLOR);

/** §3.5: every size of a cone follows h = the halfWidth of its own vertex. */
const assertConeAt = (cone, anchor, intensity, machAngle, scale, maxMult = D_VAPOR.MAX_WIDTH_MULTIPLIER, tol = 1e-9) => {
	const h = anchor.halfWidth;
	const coneLen = h * D_VAPOR.CONE_LENGTH_RATIO * (0.75 + 0.5 * intensity) * scale;
	const halfW = Math.min(h * maxMult, h * (1.1 + 1.35 * intensity * Math.sin(machAngle))) * scale;
	const xBack = anchor.x - coneLen;
	assertNear(cone.xVertex, anchor.x, tol, 'vertex station');
	assertNear(cone.coneLen, coneLen, tol, 'coneLen');
	assertNear(cone.halfW, halfW, tol, 'coneHalfW');
	assertNear(cone.halfWTop, halfW, tol, 'symmetric upper edge');
	assertNear(cone.q1.cpx, anchor.x - 0.22 * coneLen, tol, 'leading control x');
	assertNear(cone.q1.cpy, -0.72 * halfW, tol, 'leading control y');
	assertNear(cone.q2.cpx, xBack + 0.22 * coneLen, tol, 'trailing control x');
	assert.equal(cone.q2.cpy, 0);
	const [gx0, gy0, gr0, gx1, gy1, gr1] = cone.grad;
	assertNear(gx0, anchor.x, tol, 'gradient inner centre at the vertex');
	assert.equal(gy0, 0);
	assertNear(gr0, 0.15 * h * scale, tol, 'gradient inner radius 0.15 h s');
	assertNear(gx1, xBack + 0.35 * coneLen, tol, 'gradient outer centre');
	assert.equal(gy1, 0);
	assertNear(gr1, Math.max(coneLen, halfW), tol, 'gradient outer radius');
};
const assertRimAt = (rim, anchor, cone, intensity, scale, tol = 1e-9) => {
	const h = anchor.halfWidth;
	assertNear(rim.path[0].x, cone.xVertex - cone.coneLen, tol, 'rim starts at the back station');
	assertNear(rim.path[0].y, -cone.halfW, tol, 'rim upper end');
	assert.equal(rim.path[1].op, 'quad');
	assertNear(rim.path[1].cpx, anchor.x - 0.25 * h * scale, tol, 'nose rim x = vertex - 0.25 h s');
	assertNear(rim.path[1].y, cone.halfW, tol, 'rim lower end');
	assertNear(rim.lineWidth, Math.max(1, 0.12 * h), 1e-12, 'rim width max(1, 0.12 h)');
	assertNear(rim.alpha, Math.min(1, 0.4 + 0.6 * intensity), 1e-12, 'rim alpha');
};


const VIS = presetManager.getRocketVisual();
const THEME = VIS.THEMES.orange;
const M = VIS.MODULES;
const renderRocket = (over = {}) => ({
	thrustAngle: 0,
	colorTheme: 'orange',
	currentStageIndex: 0,
	totalStages: 2,
	stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }],
	fairing: { enabled: true, isSeparated: false },
	isIgnited: false,
	burnTime: 0,
	thrustRatio: 0,
	disableStaging: false,
	mach: 0,
	ambientPresRatio: 0,
	rcsCw: false,
	rcsCcw: false,
	rcsUllage: false,
	...over
});

/*******************************************************************
 * Renderer spies: every drawing primitive with its arguments and the fills / strokes it produced
 *******************************************************************/
const SPIED_RENDERER_FNS = [
	'_drawHighDetail', '_drawLowDetail', 'drawVaporCone', 'drawColdGasRcs', '_drawFairing', '_drawStage1', '_drawStage2',
	'_drawInterstage', '_drawPayloadSatellite', '_drawBoosters', '_drawPlume', '_drawRcsPlume'
];
const spyRenderer = (ctx, run) => {
	const calls = [];
	const open = [];
	const saved = [];
	for (const name of SPIED_RENDERER_FNS) {
		const orig = RocketRenderer[name];
		if (typeof orig !== 'function') continue;
		saved.push([name, orig]);
		RocketRenderer[name] = function (...args) {
			const rec = { name, args, parent: open.length > 0 ? open[open.length - 1] : null, fill0: ctx.fills.length, fill1: -1, stroke0: ctx.strokes.length, stroke1: -1 };
			calls.push(rec);
			open.push(rec);
			try {
				return orig.apply(this, args);
			} finally {
				open.pop();
				rec.fill1 = ctx.fills.length;
				rec.stroke1 = ctx.strokes.length;
			}
		};
	}
	try {
		run();
	} finally {
		for (const [name, orig] of saved) RocketRenderer[name] = orig;
	}
	return calls;
};

/** The hull primitives drawn by _drawHighDetail (its direct calls), in draw order, with their arguments. */
const hullOf = (calls) => {
	const rec = { order: [], stages: [], interstages: [], fairings: [], sats: [], boosters: [], plumes: [], srbPlumes: [] };
	for (const c of calls) {
		const parent = c.parent ? c.parent.name : null;
		if (c.name === '_drawPlume' && parent === '_drawBoosters') {
			const [, x, y, scale, throttle, fuelType, R, amb] = c.args;
			rec.srbPlumes.push({ x, y, scale, throttle, fuelType, R, amb });
			continue;
		}
		if (parent !== '_drawHighDetail') continue;
		const a = c.args.slice(1);
		let e = null;
		switch (c.name) {
			case '_drawStage1': { const [startX, radius, length, nozzleX, nozzleLen] = a; e = { kind: 'stage1', startX, radius, length, nozzleX, nozzleLen }; rec.stages.push(e); break; }
			case '_drawStage2': { const [startX, radius, length, isExposedNozzle, nozzleX, nozzleLen] = a; e = { kind: 'stage2', startX, radius, length, isExposedNozzle, nozzleX, nozzleLen }; rec.stages.push(e); break; }
			case '_drawInterstage': { const [startX, radius, length] = a; e = { kind: 'interstage', startX, radius, length }; rec.interstages.push(e); break; }
			case '_drawFairing': { const [startX, radius, length] = a; e = { kind: 'fairing', startX, radius, length }; rec.fairings.push(e); break; }
			case '_drawPayloadSatellite': { const [cx, cy, r, deployed] = a; e = { kind: 'sat', cx, cy, r, deployed: Boolean(deployed) }; rec.sats.push(e); break; }
			case '_drawBoosters': { const [, stg1X, r1, l1, nozzle1X, lNozzle1, , isFiring, throttle, R, amb] = a; e = { kind: 'boosters', stg1X, r1, l1, nozzle1X, lNozzle1, isFiring, throttle, R, amb }; rec.boosters.push(e); break; }
			case '_drawPlume': { const [x, y, scale, throttle, fuelType, R, amb] = a; e = { kind: 'plume', x, y, scale, throttle, fuelType, R, amb }; rec.plumes.push(e); break; }
			default: break;
		}
		if (e) {
			Object.defineProperty(e, 'call', { value: c, enumerable: false });
			rec.order.push(e);
		}
	}
	return rec;
};

/** Records the hull primitives drawn by _drawHighDetail (stage bodies, interstages, fairing, payload, SRBs, plumes). */
const captureHull = (rocket, R, opts = {}) => {
	const ctx = createRecordingCtx({ track: true });
	const args = [ctx, rocket, R, 1.0, THEME, opts.ambient ?? 0];
	if (opts.geometry) args.push(opts.geometry);
	const calls = spyRenderer(ctx, () => RocketRenderer._drawHighDetail(...args));
	const hull = hullOf(calls);
	hull.ctx = ctx;
	return hull;
};

/** Draws a rocket through RocketRenderer.draw at the origin (no rotation) with every primitive recorded. */
const recordDraw = (rocket, R) => {
	const ctx = createRecordingCtx({ track: true });
	const calls = spyRenderer(ctx, () => RocketRenderer.draw(ctx, rocket, 0, 0, R, 1.0));
	return { ctx, calls, hull: hullOf(calls) };
};

/*******************************************************************
 * Design oracles of the drawn rocket (design 2026-11-23 §3.1-§3.6)
 *******************************************************************/
const STAGE_FUELS = ['liquid', 'hydro', 'solid'];
const FAIRING_STATES = Object.freeze({
	attached: { enabled: true, isSeparated: false },
	separated: { enabled: true, isSeparated: true },
	none: { enabled: false }
});
const FIRING = Object.freeze({ isIgnited: true, burnTime: 50, thrustRatio: 0.8 });

/** §3.1 boosterCount: floor of a count >= 1 capped at 9, else 2 for a burning configuration, else 0. */
const designBoosterCount = (b) => {
	if (!b) return 0;
	const c = Number(b.count);
	if (Number.isFinite(c) && c >= 1) return Math.min(9, Math.floor(c));
	const t = Number(b.burnTimeSec);
	return (Number.isFinite(t) && t > 0) ? 2 : 0;
};

/**
 * A render rocket for a configuration spec:
 * { stages, idx, fairing: 'attached' | 'separated' | 'none', boosters, boosterSeparated, payloadOnly (isPayloadSeparated;
 *   idx defaults to the stage count then), disableStaging, noStages (no rocket.stages: the telemetry carries the stage
 *   index and count) }.
 */
const specStageIndex = (spec) => spec.idx ?? (spec.payloadOnly ? spec.stages : 0);
const specRocket = (spec, over = {}) => {
	const n = spec.stages;
	const base = {
		totalStages: n,
		stages: Array.from({ length: n }, (_, i) => ({ fuelType: STAGE_FUELS[i] })),
		currentStageIndex: specStageIndex(spec),
		isPayloadSeparated: Boolean(spec.payloadOnly),
		fairing: { ...FAIRING_STATES[spec.fairing || 'attached'] },
		boosters: spec.boosters ? { ...spec.boosters } : null,
		isBoosterSeparated: Boolean(spec.boosterSeparated),
		disableStaging: Boolean(spec.disableStaging)
	};
	if (spec.noStages) {
		base.stages = undefined;
		base.totalStages = undefined;
		base.telemetry = { stageIndex: specStageIndex(spec), totalStages: n };
	}
	return renderRocket({ ...base, ...over });
};

/** §3.3 SRB placement (moved unchanged from the former _drawBoosters). */
const designBoosterLayout = (b, count, stg1X, r1, l1, R) => {
	const rB = R * (b.radiusRatio || 0.26);
	const lB = R * (b.lengthRatio || 1.70);
	const yOffset = r1 + rB * (b.offsetYRatio || 0.95);
	const xBase = stg1X + l1 * (b.attachOffsetXRatio || 0.12);
	let yPositions;
	if (count === 2) {
		yPositions = [-yOffset, yOffset];
	} else if (count === 4) {
		const g = rB * (b.pairSpacingRatio || 0.35);
		yPositions = [-yOffset - g, -yOffset + g, yOffset - g, yOffset + g];
	} else {
		yPositions = Array.from({ length: count }, (_, i) => ((i % 2 === 0) ? -1 : 1) * (yOffset + Math.floor(i / 2) * rB * 0.7));
	}
	return {
		count, rB, lB, yOffset, xBase,
		lNozzleB: R * (b.nozzleLengthRatio || 0.20),
		lNoseB: R * (b.noseConeLengthRatio || 0.35),
		yPositions,
		casingColor: b.casingColor || '#f0f2f5',
		noseConeColor: b.noseConeColor || '#22262c',
		bandColor: b.bandColor || '#c85a1a',
		nozzleColor: b.nozzleColor || '#1c2024',
		plumeFuel: b.plumeFuel || 'solid',
		plumeScale: b.plumeScale || 0.55
	};
};

/**
 * §3.6.1 free wall: the body interval minus every part interval widened by min(e, plumeLen) x tan(spread) on both
 * sides (parts with e <= 0 do not stand out of the wall); only stretches of positive length are free. Written as the
 * complement of the sorted union, independently of the renderer's interval subtraction.
 */
const designFreeIntervals = (body, parts, plumeLen, tanSpread) => {
	const [u0, v0] = body;
	if (!(v0 > u0)) return [];
	const cuts = parts.filter(p => p.e > 0)
		.map(p => { const mg = Math.min(p.e, plumeLen) * tanSpread; return [p.a - mg, p.b + mg]; })
		.sort((p, q) => p[0] - q[0]);
	const free = [];
	let x = u0;
	for (const [lo, hi] of cuts) {
		if (lo > x) free.push([x, Math.min(lo, v0)]);
		x = Math.max(x, hi);
		if (x >= v0) break;
	}
	if (x < v0) free.push([x, v0]);
	return free.filter(([u, v]) => v > u);
};

/**
 * Design oracle of a configuration at screen radius R: the §3.2 geometry (position table, segments nose to tail,
 * fairing / fairingConfig, payload, SRB placement, plume), the §3.4 anchors and the §3.6 RCS nozzles.
 * Positions use the §3.2 formulas in their listed order, so the drawn hull is expected bit-exactly.
 */
const designStack = (spec, R, cfg = VIS, extra = {}) => {
	const m = cfg.MODULES;
	const al = cfg.ALIGNMENT;
	const rc = cfg.COLD_GAS_RCS;
	const n = spec.stages;
	const r1 = R * m.STAGE1_RADIUS_RATIO;
	const l1 = R * m.STAGE1_LENGTH_RATIO;
	const r2 = R * m.STAGE2_RADIUS_RATIO;
	const l2 = R * m.STAGE2_LENGTH_RATIO;
	const r3 = R * (m.STAGE3_RADIUS_RATIO || 0.55);
	const l3 = R * (m.STAGE3_LENGTH_RATIO || 0.9);
	const lInter = R * m.INTERSTAGE_LENGTH_RATIO;
	const lInter2 = R * (m.INTERSTAGE2_LENGTH_RATIO || 0.25);
	const lFairing = R * m.FAIRING_LENGTH_RATIO;
	const lN1 = R * m.NOZZLE1_LENGTH_RATIO;
	const lN2 = R * m.NOZZLE2_LENGTH_RATIO;
	const lN3 = R * (m.NOZZLE3_LENGTH_RATIO || 0.28);
	const fairingState = spec.fairing || 'attached';
	const fairingConfigured = Boolean(spec.disableStaging) || fairingState !== 'none';
	const hasFairing = Boolean(spec.disableStaging) || fairingState === 'attached';
	const isPayloadOnly = Boolean(spec.payloadOnly) && !spec.disableStaging;
	// §3.1 (Rev 22): the index is a whole number in [0, n] (normalizeStageIndex: rounded down, clamped), and out of the
	// payload phase at most the last stage
	const stageIndex = Math.max(0, Math.min(Math.floor(Number(specStageIndex(spec)) || 0), n));
	const curStgIdx = isPayloadOnly ? stageIndex : Math.min(stageIndex, n - 1);
	const state = { curStgIdx, totalStg: n, isPayloadOnly, hasFairing };
	const isFiring = Boolean(extra.firing);
	const busHalf = (r) => ({ a: 0.5 * r * m.SATELLITE_BUS_W_RATIO, b: 0.5 * r * m.SATELLITE_BUS_H_RATIO });

	if (isPayloadOnly) {
		const payloadR = (n === 1) ? r1 : ((n >= 3) ? r3 : r2);
		const busW = payloadR * m.SATELLITE_BUS_W_RATIO;
		const { a, b } = busHalf(payloadR);
		return {
			state,
			payload: { cx: 0, r: payloadR, isDeployed: true },
			fairing: null,
			fairingConfig: null,
			segments: [],
			boosterLayout: null,
			boostersAttached: false,
			plume: { x: -busW * 0.5, scale: al.PAYLOAD_PLUME_SCALE ?? 0.35, fuelType: extra.payloadFuel || 'liquid', isFiring: Boolean(extra.payloadFiring) },
			noseShoulder: { x: a, halfWidth: b },
			interstageShoulder: null,
			bus: { a, b },
			rcs: designPayloadNozzles({ a, b, plumeLen: Math.max(rc.MIN_PLUME_PX, b * rc.PLUME_LEN_WIDTH_RATIO) })
		};
	}

	const st = (stageIndex, startX, radius, length, lNozzle, isExposedNozzle) => ({
		kind: 'stage', stageIndex, startX, radius, length, nozzleX: startX - lNozzle, nozzleLength: lNozzle, isExposedNozzle, hasFins: stageIndex === 0
	});
	const inter = (startX, radius, length) => ({ kind: 'interstage', startX, radius, length });
	let segments;
	let fairingX;
	let fairingR;
	let payloadR;
	let plumeScale;
	if (n === 1) {
		const stg1X = R * (al.BASE_X_SINGLE_STAGE_RATIO ?? -1.5);
		fairingX = stg1X + l1;
		segments = [st(0, stg1X, r1, l1, lN1, false)];
		fairingR = r1;
		payloadR = r1;
		plumeScale = al.MAIN_PLUME_SCALE;
	} else if (n >= 3) {
		fairingR = r2;
		payloadR = r3;
		if (curStgIdx === 0) {
			const stg1X = R * (al.BASE_X_3STG_STAGE1_RATIO ?? -3.1);
			const inter1X = stg1X + l1;
			const stg2X = inter1X + lInter;
			const inter2X = stg2X + l2;
			const stg3X = inter2X + lInter2;
			fairingX = stg3X + l3;
			segments = [st(2, stg3X, r3, l3, lN3, false), inter(inter2X, r2, lInter2), st(1, stg2X, r2, l2, lN2, false), inter(inter1X, r1, lInter), st(0, stg1X, r1, l1, lN1, false)];
			plumeScale = al.MAIN_PLUME_SCALE;
		} else if (curStgIdx === 1) {
			const stg2X = R * (al.BASE_X_3STG_STAGE2_RATIO ?? -1.6);
			const inter2X = stg2X + l2;
			const stg3X = inter2X + lInter2;
			fairingX = stg3X + l3;
			segments = [st(2, stg3X, r3, l3, lN3, false), inter(inter2X, r2, lInter2), st(1, stg2X, r2, l2, lN2, true)];
			plumeScale = al.UPPER_PLUME_SCALE;
		} else {
			const stg3X = R * (al.BASE_X_3STG_STAGE3_RATIO ?? -0.9);
			fairingX = stg3X + l3;
			segments = [st(2, stg3X, r3, l3, lN3, true)];
			plumeScale = al.STAGE3_PLUME_SCALE ?? 0.5;
		}
	} else {
		const hasStage1 = (curStgIdx === 0);
		const stg2X = hasStage1 ? R * al.BASE_X_STAGE1_RATIO : R * al.BASE_X_UPPER_RATIO;
		fairingX = stg2X + l2;
		segments = [st(1, stg2X, r2, l2, lN2, !hasStage1)];
		if (hasStage1) {
			const interX = stg2X - lInter;
			const stg1X = interX - l1;
			segments.push(inter(interX, r1, lInter), st(0, stg1X, r1, l1, lN1, false));
		}
		fairingR = r2;
		payloadR = r2;
		plumeScale = hasStage1 ? al.MAIN_PLUME_SCALE : al.UPPER_PLUME_SCALE;
	}

	const fairingConfig = fairingConfigured ? { startX: fairingX, radius: fairingR, length: lFairing } : null;
	const payload = hasFairing ? null : { cx: fairingX + lFairing * al.PAYLOAD_OFFSET_RATIO, r: payloadR, isDeployed: false };
	const stage1 = segments.find(s => s.kind === 'stage' && s.stageIndex === 0) || null;
	const count = designBoosterCount(spec.boosters);
	const boosterLayout = (stage1 && count > 0) ? designBoosterLayout(spec.boosters, count, stage1.startX, stage1.radius, stage1.length, R) : null;
	const cur = segments[segments.length - 1];
	const stageFuels = spec.noStages ? [] : STAGE_FUELS.slice(0, n);
	const fuelType = stageFuels[curStgIdx] || 'liquid';

	// §3.4 anchors
	let noseShoulder;
	if (hasFairing) {
		noseShoulder = { x: fairingX, halfWidth: fairingR };
	} else {
		const { a, b } = busHalf(payloadR);
		noseShoulder = { x: payload.cx + a, halfWidth: b };
	}
	const iInter = segments.findIndex(s => s.kind === 'interstage');
	const interstageShoulder = (iInter > 0) ? { x: segments[iInter - 1].startX, halfWidth: segments[iInter].radius } : null;

	// §3.6.1 nozzles on the wall of the current stage
	const h = cur.radius;
	const plumeLen = Math.max(rc.MIN_PLUME_PX, h * rc.PLUME_LEN_WIDTH_RATIO);
	const parts = [];
	if (cur.hasFins) parts.push({ what: 'fins', a: cur.startX, b: cur.startX + cur.length * m.FIN_BASE_RATIO, e: cur.radius * m.FIN_SPAN_RATIO });
	if (cur.stageIndex === 0 && boosterLayout) {
		const outer = Math.max(...boosterLayout.yPositions.map(Math.abs)) + boosterLayout.rB;
		parts.push({ what: 'SRB', a: boosterLayout.xBase - boosterLayout.lNozzleB, b: boosterLayout.xBase + boosterLayout.lB + boosterLayout.lNoseB, e: outer - h });
	}
	const above = segments.length >= 2 ? segments[segments.length - 2] : null;
	if (above) {
		parts.push({ what: `neighbour ${above.kind}`, a: above.startX, b: above.startX + above.length, e: above.radius - h });
	} else if (fairingConfig) {
		parts.push({ what: 'fairing', a: fairingConfig.startX, b: fairingConfig.startX + fairingConfig.length, e: fairingConfig.radius - h });
	}
	const body = [cur.startX, cur.startX + cur.length];
	const free = designFreeIntervals(body, parts, plumeLen, Math.tan(rc.PLUME_SPREAD_RAD ?? 0.34));
	let rcs = null;
	let xFwd = NaN;
	let xAft = NaN;
	if (free.length > 0) {
		const [fLo, fHi] = free[free.length - 1];
		const [aLo, aHi] = free[0];
		xFwd = fLo + (fHi - fLo) * rc.FWD_STATION_FRACTION;
		xAft = aLo + (aHi - aLo) * rc.AFT_STATION_FRACTION;
		rcs = designStackNozzles({ xFwd, xAft, h, plumeLen });
	}
	return {
		state,
		payload,
		fairing: hasFairing ? fairingConfig : null,
		fairingConfig,
		segments,
		boosterLayout,
		boostersAttached: Boolean(boosterLayout) && !spec.boosterSeparated,
		plume: { x: cur.nozzleX, scale: plumeScale, fuelType, isFiring },
		noseShoulder,
		interstageShoulder,
		body, h, parts, free, xFwd, xAft, plumeLen, rcs,
		fairingX, lFairing
	};
};

/** A synthetic geometry for _layoutFromGeometry: one current stage under an optional neighbour / fairing / SRBs. */
const synthGeometry = ({ startX, length, radius, stageIndex = 1, hasFins = false, above = null, fairingConfig = null, boosterLayout = null }) => {
	const current = { kind: 'stage', stageIndex, startX, radius, length, nozzleX: startX - 1, nozzleLength: 1, isExposedNozzle: stageIndex > 0, hasFins };
	const fairing = fairingConfig || { startX: startX + length, radius, length: 10 };
	return {
		state: { curStgIdx: stageIndex, totalStg: 2, isPayloadOnly: false, hasFairing: true },
		payload: null,
		fairing,
		fairingConfig,
		segments: above ? [above, current] : [current],
		boosterLayout,
		boostersAttached: Boolean(boosterLayout),
		plume: { x: current.nozzleX, scale: 1, fuelType: 'liquid', isFiring: false }
	};
};

/*******************************************************************
 * Shipped vehicle presets (presets/vehicles/manifest.json)
 *******************************************************************/
const PRESET_IDS = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'presets/vehicles/manifest.json'), 'utf8'));
/** A shipped vehicle as the main thread flies it: its SRB configuration is the preset's boosters over rendering.boosters. */
const presetVehicle = (id) => {
	const v = presetManager.getVehicle(id);
	assert.ok(v, `shipped vehicle ${id} is loaded`);
	const boosters = (v.boosters || v.rendering?.boosters) ? { ...(v.rendering?.boosters || {}), ...(v.boosters || {}) } : null;
	return { id, stages: v.stages.length, boosters, colorTheme: v.rendering?.colorTheme || 'orange' };
};
/** Every stack configuration of a vehicle: each stage in flight x fairing attached / separated / not configured x SRBs attached / separated. */
const presetStackSpecs = (pv) => {
	const out = [];
	for (let idx = 0; idx < pv.stages; idx++) {
		for (const fairing of ['attached', 'separated', 'none']) {
			for (const boosterSeparated of [false, true]) {
				out.push({ stages: pv.stages, idx, fairing, boosters: pv.boosters, boosterSeparated });
			}
		}
	}
	return out;
};
const specLabel = (s) => (s.payloadOnly ? `${s.stages}-stage payload only` : `${s.stages}-stage, stage ${s.idx + 1}, fairing ${s.fairing || 'attached'}${s.boosters ? `, ${designBoosterCount(s.boosters)} SRB${s.boosterSeparated ? ' separated' : ''}` : ''}`);

/*******************************************************************
 * Polygon tools (convex hull, separating-axis overlap)
 *******************************************************************/
/** Points spanning a recorded fill path: vertices, quadratic control points (the curve lies in their hull), rect corners. */
const fillPoints = (fill) => {
	const pts = [];
	for (const op of fill.path) {
		if (op.op === 'moveTo' || op.op === 'lineTo') pts.push([op.x, op.y]);
		else if (op.op === 'quad') pts.push([op.cpx, op.cpy], [op.x, op.y]);
		else if (op.op === 'rect') pts.push([op.x, op.y], [op.x + op.w, op.y], [op.x + op.w, op.y + op.h], [op.x, op.y + op.h]);
		else if (op.op !== 'closePath') throw new Error(`fillPoints: unsupported path op ${op.op}`);
	}
	return pts;
};
const convexHull = (points) => {
	const pts = points.slice().sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
	if (pts.length <= 2) return pts;
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
		upper.push(p);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
};
/**
 * Separating-axis overlap depth of two convex polygons: the smallest projection overlap over the edge normals of both
 * and the coordinate axes. <= 0 when they are disjoint or only touch.
 */
const convexOverlap = (P, Q) => {
	const axes = [[1, 0], [0, 1]];
	for (const poly of [P, Q]) {
		for (let i = 0; i < poly.length; i++) {
			const [x0, y0] = poly[i];
			const [x1, y1] = poly[(i + 1) % poly.length];
			const nx = y0 - y1;
			const ny = x1 - x0;
			const len = Math.hypot(nx, ny);
			if (len > 0) axes.push([nx / len, ny / len]);
		}
	}
	let depth = Infinity;
	for (const [nx, ny] of axes) {
		let p0 = Infinity; let p1 = -Infinity; let q0 = Infinity; let q1 = -Infinity;
		for (const [x, y] of P) { const s = x * nx + y * ny; p0 = Math.min(p0, s); p1 = Math.max(p1, s); }
		for (const [x, y] of Q) { const s = x * nx + y * ny; q0 = Math.min(q0, s); q1 = Math.max(q1, s); }
		depth = Math.min(depth, Math.min(p1, q1) - Math.max(p0, q0));
	}
	return depth;
};
/**
 * The fill polygons (convex hulls) that stand out of the wall the RCS jets fire from (design §3.6, §5.1-6): the fins of
 * the current stage, every SRB fill, every other drawn hull part (the wider neighbour among them) and, for the payload
 * alone, the deployed panels and booms. The current stage's own body, band and nozzle (and the payload bus) are the
 * wall itself and are left out; engine plumes are not parts.
 */
const partPolygons = (rec) => {
	const hd = rec.calls.find(c => c.name === '_drawHighDetail');
	assert.ok(hd, 'the high-detail hull was drawn');
	const children = rec.calls.filter(c => c.parent === hd);
	const stageCalls = children.filter(c => c.name === '_drawStage1' || c.name === '_drawStage2');
	const current = stageCalls.length > 0 ? stageCalls[stageCalls.length - 1] : null;
	const plumeFills = new Set();
	for (const c of rec.calls.filter(k => k.name === '_drawPlume')) {
		for (let i = c.fill0; i < c.fill1; i++) plumeFills.add(i);
	}
	const label = { _drawBoosters: 'SRB', _drawFairing: 'fairing', _drawInterstage: 'interstage', _drawStage1: 'stage', _drawStage2: 'stage', _drawPayloadSatellite: 'payload' };
	const polys = [];
	for (const c of children) {
		if (!label[c.name]) continue;
		for (let i = c.fill0; i < c.fill1; i++) {
			if (plumeFills.has(i)) continue;
			const f = rec.ctx.fills[i];
			if (c === current) {
				// Only the fins of the current stage stand out of its wall: the triangles reaching beyond its radius
				const radius = c.args[2];
				const isTriangle = f.path.length === 4 && f.path[0].op === 'moveTo' && f.path[1].op === 'lineTo' && f.path[2].op === 'lineTo' && f.path[3].op === 'closePath';
				if (isTriangle && f.path.some(p => Math.abs(p.y) > radius + 1e-9)) polys.push({ label: 'fin', pts: convexHull(fillPoints(f)) });
				continue;
			}
			if (c.name === '_drawPayloadSatellite' && c.args[4] && i === c.fill0) continue; // the deployed bus is the wall
			polys.push({ label: c.name === '_drawPayloadSatellite' && c.args[4] ? 'panel' : label[c.name], pts: convexHull(fillPoints(f)) });
		}
	}
	return polys;
};

/*******************************************************************
 * Drawn silhouette and the vapor-cloud exterior point (design 2026-11-23 §1.5)
 *******************************************************************/
/** A point of a quadratic Bézier. */
const quadPoint = (p0, c, p1, t) => [
	(1 - t) * (1 - t) * p0[0] + 2 * t * (1 - t) * c[0] + t * t * p1[0],
	(1 - t) * (1 - t) * p0[1] + 2 * t * (1 - t) * c[1] + t * t * p1[1]
];
/** Half-height of the drawn side view at x: the largest drawn part covering x (stages, interstages, the fairing curve, the stowed bus). */
const drawnSilhouette = (hull) => {
	const parts = [];
	for (const s of [...hull.stages, ...hull.interstages]) parts.push({ a: s.startX, b: s.startX + s.length, r: () => s.radius });
	for (const f of hull.fairings) {
		// The upper half of the drawn fairing fill: moveTo(startX, -radius), quad(control, tip)
		const fill = hull.ctx.fills[f.call.fill0];
		const [m0, q] = fill.path;
		assert.equal(m0.op, 'moveTo');
		assert.equal(q.op, 'quad');
		const p0 = [m0.x, m0.y]; const c = [q.cpx, q.cpy]; const p1 = [q.x, q.y];
		parts.push({ a: p0[0], b: p1[0], r: (x) => {
			let lo = 0; let hi = 1;
			for (let k = 0; k < 80; k++) { const mid = 0.5 * (lo + hi); if (quadPoint(p0, c, p1, mid)[0] < x) lo = mid; else hi = mid; }
			return Math.abs(quadPoint(p0, c, p1, 0.5 * (lo + hi))[1]);
		} });
	}
	for (const s of hull.sats.filter(k => !k.deployed)) {
		const halfW = 0.5 * s.r * M.SATELLITE_BUS_W_RATIO;
		parts.push({ a: s.cx - halfW, b: s.cx + halfW, r: () => 0.5 * s.r * M.SATELLITE_BUS_H_RATIO });
	}
	return (x) => {
		let best = null;
		for (const p of parts) {
			if (x >= p.a && x <= p.b) { const r = p.r(x); if (best === null || r > best) best = r; }
		}
		return best;
	};
};
/** The first station aft of the vertex where the drawn cloud outline leaves the drawn body (§1.5 "機体の外に出る位置"). */
const cloudExteriorX = (cone, silhouette) => {
	const p0 = [cone.xVertex, 0];
	const c = [cone.q1.cpx, cone.q1.cpy];
	const p1 = [cone.q1.x, cone.q1.y];
	const outside = (t) => { const [x, y] = quadPoint(p0, c, p1, t); return Math.abs(y) > (silhouette(x) ?? 0); };
	assert.equal(outside(0), false, 'the vertex lies inside the body');
	let prev = 0;
	for (let t = 1e-4; t <= 1 + 1e-12; t += 1e-4) {
		if (outside(t)) {
			let lo = prev; let hi = t;
			for (let k = 0; k < 60; k++) { const mid = 0.5 * (lo + hi); if (outside(mid)) hi = mid; else lo = mid; }
			return quadPoint(p0, c, p1, hi)[0];
		}
		prev = t;
	}
	return null;
};

/*******************************************************************
 * Recording WebAudio (richer than the shared mock: biquads, AudioParam automation)
 *******************************************************************/
class RecParam {
	constructor(value) { this.value = value; this.events = []; }
	setValueAtTime(v, time) { this.events.push({ kind: 'set', v, time }); this.value = v; }
	setTargetAtTime(v, time, tc) { this.events.push({ kind: 'target', v, time, tc }); }
	linearRampToValueAtTime(v, time) { this.events.push({ kind: 'ramp', v, time }); }
	lastTarget() {
		const ev = this.events.filter(e => e.kind === 'target');
		return ev.length > 0 ? ev[ev.length - 1] : null;
	}
}
class RecNode {
	constructor(kind) { this.kind = kind; this.outputs = []; this.disconnectCount = 0; }
	connect(node) { this.outputs.push(node); return node; }
	disconnect() { this.disconnectCount++; }
}
class RecAudioContext {
	constructor() {
		this.state = RecAudioContext.initialState;
		this.currentTime = 1.5;
		this.sampleRate = 1000;
		this.destination = new RecNode('destination');
		this.resumeCount = 0;
		this.closeCount = 0;
		this.nodes = [];
		RecAudioContext.instances.push(this);
	}
	_track(node) { this.nodes.push(node); return node; }
	_playable(kind, freq) {
		const n = new RecNode(kind);
		n.startCalls = [];
		n.stopCount = 0;
		if (freq !== undefined) { n.type = 'sine'; n.frequency = new RecParam(freq); }
		n.start = (when) => { n.startCalls.push(when); };
		n.stop = () => { n.stopCount++; if (RecAudioContext.throwOnStop) { throw new Error('InvalidStateError'); } };
		return this._track(n);
	}
	createDynamicsCompressor() {
		const n = new RecNode('compressor');
		n.threshold = new RecParam(-24); n.knee = new RecParam(30); n.ratio = new RecParam(12);
		n.attack = new RecParam(0.003); n.release = new RecParam(0.25);
		return this._track(n);
	}
	createBuffer(channels, length, sampleRate) {
		const data = new Float32Array(length);
		return { numberOfChannels: channels, length, sampleRate, getChannelData: () => data };
	}
	createBufferSource() { const n = this._playable('bufferSource'); n.buffer = null; n.loop = false; return n; }
	createOscillator() { return this._playable('oscillator', 440); }
	createBiquadFilter() {
		const n = new RecNode('biquad');
		n.type = 'lowpass'; n.frequency = new RecParam(350); n.Q = new RecParam(1); n.gain = new RecParam(0);
		return this._track(n);
	}
	createGain() { const n = new RecNode('gain'); n.gain = new RecParam(1); return this._track(n); }
	resume() { this.resumeCount++; this.state = 'running'; return Promise.resolve(); }
	close() { this.closeCount++; if (RecAudioContext.throwOnClose) { throw new Error('close failed'); } return Promise.resolve(); }
}
RecAudioContext.instances = [];
RecAudioContext.initialState = 'running';
RecAudioContext.throwOnStop = false;
RecAudioContext.throwOnClose = false;

const windowListeners = [];
const installAudio = () => {
	RecAudioContext.instances = [];
	RecAudioContext.initialState = 'running';
	RecAudioContext.throwOnStop = false;
	RecAudioContext.throwOnClose = false;
	globalThis.window.AudioContext = RecAudioContext;
	delete globalThis.window.webkitAudioContext;
	windowListeners.length = 0;
	globalThis.window.addEventListener = (type, fn, opts) => { windowListeners.push({ type, fn, opts }); };
};

const EARTH_PARAM = presetManager.getObjectParam('Earth');
const makeSoundWorld = (rocketOver = {}, telemetryOver = {}) => {
	const earth = { id: 1, type: OBJECT_TYPES.CELESTIAL, name: 'Earth', param: EARTH_PARAM };
	const rocket = {
		id: 10, type: OBJECT_TYPES.ROCKET, name: 'Sound Rocket',
		isIgnited: true, thrustRatio: 1.0, inAtmosphere: true, isHoldDown: false,
		// A main-thread rocket: alive while ACTIVE and not destroyed (Rocket.setCollided sets both; the Worker's
		// collided / shattered never reach the main thread, design §4.13-23)
		state: OBJECT_STATE.ACTIVE, isDestroyed: false, dominantBodyId: 1,
		...rocketOver,
		telemetry: { altM: 0, relativeAltM: 0, vV: 0, vH: 0, qAxialKpa: 20, mach: 0, ...telemetryOver }
	};
	const universe = { objects: [earth, rocket], LaunchSequencer: { rocketId: 10 }, camera: { trackingTarget: null } };
	return { universe, rocket, earth };
};
const startSound = (universe) => {
	const se = new SoundEffects(universe);
	se._initAudio();
	return se;
};
const whineCfg = SOUND_FX_CONFIG.supersonicWhine;
const expectedWhineFreq = (mach) => whineCfg.baseFreq + Math.min((mach - whineCfg.machMin) / (whineCfg.machMax - whineCfg.machMin), 1.0) * whineCfg.freqRange;

/*******************************************************************
 * 1. Constants & schemas against the design tables
 *******************************************************************/
describe('Unit 08-1: RCS / vapor-cone constants and schemas match the design tables', () => {
	it('RCS_CONFIG equals the design §3.2-1 table and is frozen', () => {
		assert.deepEqual({ ...RCS_CONFIG }, { ...D_RCS });
		assert.ok(Object.isFrozen(RCS_CONFIG));
	});

	it('AERO_DYNAMIC transonic constants equal the design §3.3-1 SSOT values', () => {
		assert.equal(AERO_DYNAMIC.TRANSONIC_MACH_MIN, 0.82);
		assert.equal(AERO_DYNAMIC.TRANSONIC_MACH_MAX, 1.22);
		assert.equal(AERO_DYNAMIC.TRANSONIC_PEAK_MACH, 1.00);
		assert.equal(AERO_DYNAMIC.TRANSONIC_MIN_PRES_RATIO, 0.015);
	});

	it('ROCKET_FLAG RCS bits are 16 / 17 / 18 and do not overlap', () => {
		assert.equal(ROCKET_FLAG.RCS_CW, 1 << 16);
		assert.equal(ROCKET_FLAG.RCS_CCW, 1 << 17);
		assert.equal(ROCKET_FLAG.RCS_ULLAGE, 1 << 18);
		assert.equal(ROCKET_FLAG.RCS_CW & ROCKET_FLAG.RCS_CCW, 0);
		assert.equal((ROCKET_FLAG.RCS_CW | ROCKET_FLAG.RCS_CCW) & ROCKET_FLAG.RCS_ULLAGE, 0);
	});

	it('COLD_GAS_RCS and VAPOR_CONE schemas are identical in rocket.json and in PresetManager._seedFallbacks()', () => {
		const disk = presetManager.getRocketVisual();
		const fallback = new PresetManager({ skipDiskLoad: true }).getRocketVisual();
		assert.deepEqual(disk.COLD_GAS_RCS, { ...D_COLD_GAS });
		assert.deepEqual(disk.VAPOR_CONE, { ...D_VAPOR });
		assert.deepEqual(fallback.COLD_GAS_RCS, { ...D_COLD_GAS });
		assert.deepEqual(fallback.VAPOR_CONE, { ...D_VAPOR });
		assert.equal(ROCKET_VISUAL.LOD_RADIUS_THRESHOLD, 4.0);
		assert.equal(fallback.LOD_RADIUS_THRESHOLD, 4.0);
	});

	it('VAPOR_CONE keys and values equal design 2026-11-23 §3.9 on disk, at run time and in _seedFallbacks(); the station fractions are gone (§5.1-10)', () => {
		const disk = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'presets/visuals/rocket.json'), 'utf8'));
		const fallback = new PresetManager({ skipDiskLoad: true }).getRocketVisual();
		const sources = [
			['presets/visuals/rocket.json', disk.VAPOR_CONE],
			['ROCKET_VISUAL', ROCKET_VISUAL.VAPOR_CONE],
			['presetManager.getRocketVisual()', VIS.VAPOR_CONE],
			['PresetManager._seedFallbacks()', fallback.VAPOR_CONE]
		];
		for (const [label, vc] of sources) {
			assert.ok(vc && typeof vc === 'object', `${label}: VAPOR_CONE present`);
			assert.deepEqual(Object.keys(vc).sort(), ['CONE_LENGTH_RATIO', 'CORE_COLOR', 'EDGE_COLOR', 'MAX_WIDTH_MULTIPLIER', 'RIM_COLOR', 'SECONDARY_INTENSITY_MIN'], `${label}: exactly the six §3.9 keys`);
			assert.deepEqual({ ...vc }, { ...D_VAPOR }, `${label}: the §3.9 values`);
			for (const gone of ['PRIMARY_STATION_FRACTION', 'SECONDARY_STATION_FRACTION']) {
				assert.equal(gone in vc, false, `${label}: ${gone} is deleted`);
			}
		}
		// COLD_GAS_RCS keeps its keys and values (§3.9: only the meaning of the station fractions changes)
		assert.deepEqual(disk.COLD_GAS_RCS, { ...D_COLD_GAS });
		assert.deepEqual({ ...fallback.COLD_GAS_RCS }, { ...D_COLD_GAS });
	});
});

/*******************************************************************
 * 2. CalcRocket._updateRcsState
 *******************************************************************/
describe('Unit 08-2: CalcRocket._updateRcsState', () => {
	describe('stop guards (hold-down / collided / shattered)', () => {
		const firingInputs = { pres: 0, desired: 0.5, state: 'INTERSTAGE_COAST', stageIndex: 1, stgTimer: 1.0, postSep: 1.0, ullageRestart: 1.0 };

		it('without a guard the reference inputs fire CW and ullage (control case)', () => {
			const r = runRcs(firingInputs, { dt: 0.25 });
			assert.deepEqual(flagsOf(r), { cw: true, ccw: false, ullage: true });
			assert.deepEqual(tmFlagsOf(r), { cw: true, ccw: false, ullage: true });
		});

		for (const guard of ['isHoldDown', 'collided', 'shattered']) {
			it(`${guard} forces all flags and the telemetryCache off while both timers still count down`, () => {
				const r = primeRcs(makeCalcRocket(), firingInputs);
				r.rcsCw = true; r.rcsCcw = true; r.rcsUllage = true;
				Object.assign(r.flightComputer.telemetryCache, { rcsCw: true, rcsCcw: true, rcsUllage: true });
				r[guard] = true;
				r._updateRcsState(0.25, 1.0e6, 0);
				assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: false });
				assert.deepEqual(tmFlagsOf(r), { cw: false, ccw: false, ullage: false });
				assert.equal(r._postSepRcsTimer, 0.75, 'post-separation timer is decremented before the guard');
				assert.equal(r._ullageRestartTimer, 0.75, 'restart-ullage timer is decremented before the guard');
			});
		}

		it('a guarded rocket without a flight computer does not throw and stays off', () => {
			const r = primeRcs(makeCalcRocket(), firingInputs);
			r.flightComputer = null;
			r.shattered = true;
			assert.doesNotThrow(() => r._updateRcsState(0.25, 1.0e6, 0));
			assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: false });
		});
	});

	describe('attitude deadband ±0.015 rad (pulse-on phase, RCS allowed by vacuum)', () => {
		const cases = [
			{ err: 0, cw: false, ccw: false },
			{ err: 0.015 - 1e-9, cw: false, ccw: false },
			{ err: 0.015, cw: false, ccw: false },
			{ err: 0.015 + 1e-9, cw: true, ccw: false },
			{ err: -(0.015 - 1e-9), cw: false, ccw: false },
			{ err: -0.015, cw: false, ccw: false },
			{ err: -(0.015 + 1e-9), cw: false, ccw: true }
		];
		for (const c of cases) {
			it(`err = ${c.err} rad -> CW ${c.cw}, CCW ${c.ccw}`, () => {
				const r = runRcs({ pres: 0, t: 0, desired: c.err });
				assert.deepEqual(flagsOf(r), { cw: c.cw, ccw: c.ccw, ullage: false });
			});
		}
	});

	describe('slew threshold 0.08 rad: continuous at or above, pulsed below', () => {
		const pulseOff = 0.3; // 0.3 % 0.45 = 0.3 >= 0.189 -> pulse off
		const cases = [
			{ err: 0.08, t: pulseOff, cw: true, ccw: false, why: 'exactly 0.08 is continuous (>=)' },
			{ err: 0.08 + 1e-9, t: pulseOff, cw: true, ccw: false, why: 'above 0.08 is continuous' },
			{ err: 0.08 - 1e-9, t: pulseOff, cw: false, ccw: false, why: 'below 0.08 follows the pulse (off)' },
			{ err: 0.08 - 1e-9, t: 0, cw: true, ccw: false, why: 'below 0.08 follows the pulse (on)' },
			{ err: -0.08, t: pulseOff, cw: false, ccw: true, why: 'CCW mirror: exactly -0.08 is continuous' },
			{ err: -(0.08 - 1e-9), t: pulseOff, cw: false, ccw: false, why: 'CCW mirror below threshold is pulsed (off)' },
			{ err: -0.5, t: pulseOff, cw: false, ccw: true, why: 'large negative error is continuous CCW' }
		];
		for (const c of cases) {
			it(`${c.why}`, () => {
				const r = runRcs({ pres: 0, t: c.t, desired: c.err });
				assert.deepEqual(flagsOf(r), { cw: c.cw, ccw: c.ccw, ullage: false });
			});
		}
	});

	describe('pulse duty: on while (t mod 0.45) < 0.42 * 0.45 = 0.189', () => {
		const cases = [
			{ t: 0, on: true },
			{ t: 0.1, on: true },
			{ t: 0.18899999999999997, on: true },
			{ t: 0.189, on: false },
			{ t: 0.3, on: false },
			{ t: 0.449, on: false },
			{ t: 0.45, on: true },
			{ t: 0.55, on: true },
			{ t: 0.9, on: true },
			{ t: 1.1, on: false }
		];
		for (const c of cases) {
			it(`flightTime ${c.t} s -> pulse ${c.on ? 'on' : 'off'} for both CW and CCW`, () => {
				assert.equal(runRcs({ pres: 0, t: c.t, desired: 0.03 }).rcsCw, c.on);
				assert.equal(runRcs({ pres: 0, t: c.t, desired: -0.03 }).rcsCcw, c.on);
			});
		}

		it('the on-fraction over many periods equals the 0.42 duty', () => {
			let on = 0;
			const n = 4500;
			for (let i = 0; i < n; i++) {
				if (runRcs({ pres: 0, t: i * 0.001, desired: 0.03 }).rcsCw) on++;
			}
			assertNear(on / n, 0.42, 0.002, 'duty fraction');
		});

		it('a missing or NaN flightTime is treated as t = 0 (pulse on)', () => {
			assert.equal(runRcs({ pres: 0, t: undefined, desired: 0.03 }).rcsCw, true);
			assert.equal(runRcs({ pres: 0, t: NaN, desired: 0.03 }).rcsCw, true);
		});
	});

	describe('allowRcs conditions', () => {
		it('ambient pressure ratio: allowed at or below 0.35, inhibited just above (thrusting, small error)', () => {
			assert.equal(runRcs({ pres: 0.35, t: 0, desired: 0.03 }).rcsCw, true);
			assert.equal(runRcs({ pres: 0.35, t: 0, desired: -0.03 }).rcsCcw, true);
			assert.equal(runRcs({ pres: 0.35 + 1e-9, t: 0, desired: 0.03 }).rcsCw, false);
			assert.equal(runRcs({ pres: 0.35 + 1e-9, t: 0, desired: -0.03 }).rcsCcw, false);
			assert.equal(runRcs({ pres: 0, t: 0, desired: 0.03 }).rcsCw, true);
			assert.equal(runRcs({ pres: 1.0, t: 0, desired: 0.03 }).rcsCw, false);
		});

		it('zero (or negative) thrust allows RCS in dense air; any positive thrust inhibits it', () => {
			assert.equal(runRcs({ pres: 1.0, t: 0, desired: 0.03 }, { thrustN: 0 }).rcsCw, true);
			assert.equal(runRcs({ pres: 1.0, t: 0, desired: 0.03 }, { thrustN: -1 }).rcsCw, true);
			assert.equal(runRcs({ pres: 1.0, t: 0, desired: 0.03 }, { thrustN: 1e-9 }).rcsCw, false);
		});

		it('an attitude error strictly above 0.08 rad allows RCS in dense powered flight', () => {
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0.3, desired: 0.08 })), { cw: false, ccw: false, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0.3, desired: 0.08 + 1e-9 })), { cw: true, ccw: false, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0.3, desired: -(0.08 + 1e-9) })), { cw: false, ccw: true, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0.3, desired: 0.5 })), { cw: true, ccw: false, ullage: false });
		});

		it('a running post-separation timer allows RCS and makes the firing continuous', () => {
			const live = runRcs({ pres: 1.0, t: 0.3, desired: 0.03, postSep: 1.0 }, { dt: 0.25 });
			assert.equal(live._postSepRcsTimer, 0.75);
			assert.deepEqual(flagsOf(live), { cw: true, ccw: false, ullage: false });
			const ccw = runRcs({ pres: 1.0, t: 0.3, desired: -0.03, postSep: 1.0 }, { dt: 0.25 });
			assert.deepEqual(flagsOf(ccw), { cw: false, ccw: true, ullage: false });
			const expired = runRcs({ pres: 1.0, t: 0.3, desired: 0.03, postSep: 0.25 }, { dt: 0.25 });
			assert.equal(expired._postSepRcsTimer, 0);
			assert.deepEqual(flagsOf(expired), { cw: false, ccw: false, ullage: false });
			const barely = runRcs({ pres: 1.0, t: 0.3, desired: 0.03, postSep: 0.25 + 1e-9 }, { dt: 0.25 });
			assert.ok(barely._postSepRcsTimer > 0);
			assert.equal(barely.rcsCw, true);
		});
	});

	describe('post-separation alternating damping inside the deadband', () => {
		const cases = [
			{ timer: 1e-9, cw: true, ccw: false },
			{ timer: 0.0899, cw: true, ccw: false },
			{ timer: 0.09, cw: false, ccw: false },
			{ timer: 0.1749, cw: false, ccw: false },
			{ timer: 0.175, cw: false, ccw: true },
			{ timer: 0.2649, cw: false, ccw: true },
			{ timer: 0.2651, cw: false, ccw: false },
			{ timer: 0.3499, cw: false, ccw: false },
			{ timer: 2.5, cw: true, ccw: false },
			{ timer: 0.55, cw: false, ccw: true },
			{ timer: 1.15, cw: false, ccw: false }
		];
		for (const c of cases) {
			it(`timer ${c.timer} s (phase = timer mod 0.35) -> CW ${c.cw}, CCW ${c.ccw}`, () => {
				const r = runRcs({ pres: 1.0, t: 0, desired: 0, postSep: c.timer });
				assert.deepEqual(flagsOf(r), { cw: c.cw, ccw: c.ccw, ullage: false });
			});
		}

		it('an error inside the deadband (0.01 rad) still yields damping, not attitude firing', () => {
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0.3, desired: 0.01, postSep: 0.2 })), { cw: false, ccw: true, ullage: false });
		});

		it('timer 0 produces no damping pulse', () => {
			assert.deepEqual(flagsOf(runRcs({ pres: 1.0, t: 0, desired: 0, postSep: 0 })), { cw: false, ccw: false, ullage: false });
		});

		it('CW and CCW never fire together and each fires 0.09 / 0.35 of the time over whole damping periods', () => {
			let cw = 0;
			let ccw = 0;
			const n = 4900;
			const span = 7 * 0.35; // seven full periods inside the 2.5 s settle window
			for (let i = 1; i <= n; i++) {
				const timer = i * (span / n);
				const r = runRcs({ pres: 1.0, t: 0, desired: 0, postSep: timer });
				assert.deepEqual({ cw: r.rcsCw, ccw: r.rcsCcw }, designDamp(timer), `timer ${timer}`);
				assert.ok(!(r.rcsCw && r.rcsCcw), `timer ${timer}: both sides firing`);
				if (r.rcsCw) cw++;
				if (r.rcsCcw) ccw++;
			}
			assertNear(cw / n, 0.09 / 0.35, 0.005, 'CW damping fraction');
			assertNear(ccw / n, 0.09 / 0.35, 0.005, 'CCW damping fraction');
		});
	});

	describe('pre-ignition ullage (INTERSTAGE_COAST, ignDelay - stgTimer <= 1.5 s)', () => {
		const withDelay = (delay) => {
			const r = makeCalcRocket();
			r.stages[1].ignitionDelaySec = delay;
			return r;
		};
		const ullage = (rocket, o) => {
			primeRcs(rocket, { pres: 1.0, desired: 0, state: 'INTERSTAGE_COAST', stageIndex: 1, ...o });
			rocket._updateRcsState(0, 0, 0);
			return rocket.rcsUllage;
		};

		it('ignitionDelay 4.0 s: ullage starts exactly when 1.5 s remain', () => {
			assert.equal(ullage(withDelay(4.0), { stgTimer: 2.4999 }), false);
			assert.equal(ullage(withDelay(4.0), { stgTimer: 2.5 }), true);
			assert.equal(ullage(withDelay(4.0), { stgTimer: 2.5001 }), true);
			assert.equal(ullage(withDelay(4.0), { stgTimer: 4.0 }), true);
		});

		it('ignition delays of 1.0 s and 0 s are inside the 1.5 s window from the start of the coast', () => {
			assert.equal(ullage(withDelay(1.0), { stgTimer: 0 }), true);
			assert.equal(ullage(withDelay(0), { stgTimer: 0 }), true);
		});

		it('a stage without ignitionDelaySec falls back to the 2.0 s default', () => {
			assert.equal(MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC, 2.0);
			assert.equal(ullage(withDelay(undefined), { stgTimer: 0.4999 }), false);
			assert.equal(ullage(withDelay(undefined), { stgTimer: 0.5 }), true);
		});

		it('a stage index past the last stage (no next stage) also uses the 2.0 s default', () => {
			assert.equal(ullage(makeCalcRocket(), { stageIndex: 5, stgTimer: 0.4999 }), false);
			assert.equal(ullage(makeCalcRocket(), { stageIndex: 5, stgTimer: 0.5 }), true);
		});

		for (const state of ['STG_MECO', 'STG_BURNING', 'STG_COAST', 'ORBITAL_COAST', 'PRE_LAUNCH']) {
			it(`no pre-ignition ullage outside INTERSTAGE_COAST (${state})`, () => {
				assert.equal(ullage(withDelay(4.0), { state, stgTimer: 3.0 }), false);
			});
		}

		it('ullage is independent of the deadband, pressure and thrust gating', () => {
			const r = withDelay(2.0);
			primeRcs(r, { pres: 1.0, desired: 0, state: 'INTERSTAGE_COAST', stageIndex: 1, stgTimer: 1.0 });
			r._updateRcsState(0, 5.0e6, 0);
			assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: true });
		});
	});

	describe('restart ullage timer (STG_COAST -> STG_BURNING re-ignition)', () => {
		it('a running restart timer keeps ullage on until it reaches 0', () => {
			const live = runRcs({ pres: 1.0, ullageRestart: 1.2 }, { dt: 0.25 });
			assert.equal(live.rcsUllage, true);
			assertNear(live._ullageRestartTimer, 0.95, 1e-12, 'timer after one step');
			const expired = runRcs({ pres: 1.0, ullageRestart: 0.25 }, { dt: 0.25 });
			assert.equal(expired._ullageRestartTimer, 0);
			assert.equal(expired.rcsUllage, false);
		});

		const makeCoasting = (over = {}) => {
			const r = makeCalcRocket(over);
			r._activateStage(1);
			r.stageState = 'STG_COAST';
			r.isIgnited = false;
			r.ambientPresRatio = 0;
			r.flightComputer.flightTime = 100;
			return r;
		};

		it('flightControl re-ignition sets the 1.2 s timer: ullage on for 4 steps of 0.25 s, off on the 5th', () => {
			const r = makeCoasting();
			const seen = [];
			for (let i = 0; i < 6; i++) {
				r.flightControl(0.25, null, 0);
				seen.push(r.rcsUllage);
				if (i === 0) {
					assert.equal(r.stageState, 'STG_BURNING');
					assert.equal(r.isIgnited, true);
					assertNear(r._ullageRestartTimer, 1.2 - 0.25, 1e-12, 'timer right after re-ignition');
				}
			}
			assert.deepEqual(seen, [true, true, true, true, false, false]);
			assert.equal(r._ullageRestartTimer, 0);
		});

		it('no re-ignition (and no restart ullage) without burn time or under manual control', () => {
			const noBurn = makeCoasting();
			noBurn.burnTime = 0;
			noBurn.flightControl(0.25, null, 0);
			assert.equal(noBurn.stageState, 'STG_COAST');
			assert.equal(noBurn._ullageRestartTimer, 0);
			assert.equal(noBurn.rcsUllage, false);

			const manual = makeCoasting({ autoControl: false });
			manual.flightControl(0.25, null, 0);
			assert.equal(manual.stageState, 'STG_COAST');
			assert.equal(manual.rcsUllage, false);
		});
	});

	describe('target angle, telemetry sync and abnormal inputs', () => {
		it('telemetryCache mirrors every flag combination produced by the state machine', () => {
			const scenarios = [
				{ o: { pres: 0, t: 0, desired: 0.5 } },
				{ o: { pres: 0, t: 0, desired: -0.5 } },
				{ o: { pres: 1.0, desired: 0, postSep: 0.2 } },
				{ o: { pres: 1.0, desired: 0, state: 'INTERSTAGE_COAST', stageIndex: 1, stgTimer: 1.0 } },
				{ o: { pres: 1.0, desired: 0 } }
			];
			for (const s of scenarios) {
				const r = runRcs(s.o);
				assert.deepEqual(tmFlagsOf(r), flagsOf(r), JSON.stringify(s.o));
			}
		});

		it('works without a flight computer: target = pre-update angle, pulse time = 0', () => {
			const r = primeRcs(makeCalcRocket(), { pres: 0, postSep: 0.05, state: 'INTERSTAGE_COAST', stageIndex: 1, stgTimer: 1.0 });
			r.flightComputer = null;
			assert.doesNotThrow(() => r._updateRcsState(0, 0, 0.3));
			assert.deepEqual(flagsOf(r), { cw: true, ccw: false, ullage: true }, 'damping phase 0.05 -> CW, ullage on');
		});

		it('manual control ignores the guidance target (err = 0)', () => {
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: 1.0, autoControl: false })), { cw: false, ccw: false, ullage: false });
		});

		it('an undefined desired angle falls back to the pre-update angle', () => {
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: undefined }, { pre: 1.0 })), { cw: false, ccw: false, ullage: false });
		});

		it('a NaN desired angle never fires attitude jets and keeps boolean flags', () => {
			const r = runRcs({ pres: 0, t: 0, desired: NaN });
			assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: false });
		});

		it('the error takes the shortest way across ±π (sign convention: +Δθ = CW)', () => {
			const pre = Math.PI - 0.01;
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: -Math.PI + 0.01 }, { pre })), { cw: true, ccw: false, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: Math.PI - 0.01 }, { pre: -Math.PI + 0.01 })), { cw: false, ccw: true, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: 1.25 }, { pre: 1.0 })), { cw: true, ccw: false, ullage: false });
			assert.deepEqual(flagsOf(runRcs({ pres: 0, t: 0, desired: 0.75 }, { pre: 1.0 })), { cw: false, ccw: true, ullage: false });
		});

		it('undefined / NaN timers are treated as 0 and normalised to 0', () => {
			for (const bad of [undefined, NaN, null]) {
				const r = runRcs({ pres: 1.0, desired: 0, postSep: bad, ullageRestart: bad }, { dt: 0.1 });
				assert.equal(r._postSepRcsTimer, 0, `postSep ${bad}`);
				assert.equal(r._ullageRestartTimer, 0, `ullageRestart ${bad}`);
				assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: false });
			}
		});
	});

	describe('integration with CalcRocket.flightControl', () => {
		it('uses the pre-update thrust angle: a 0.05 rad slew completed within the step still fires CW', () => {
			const r = makeCalcRocket();
			r._activateStage(1);
			r.stageState = 'INTERSTAGE_COAST';
			r.stgTimer = 0;
			r.isIgnited = false;
			r.vx = 1000 * Math.cos(0.05);
			r.vy = 1000 * Math.sin(0.05);
			r.flightControl(0.125, null, 0);
			assertNear(r.thrustAngle, 0.05, 1e-12, 'attitude reached the prograde target inside the step');
			assertNear(r.flightComputer.desiredThrustAngleRad, 0.05, 1e-12, 'INTERSTAGE_COAST target is prograde');
			assert.equal(r.rcsCw, true, 'err = desired - preUpdateAngle = 0.05 > deadband (pulse on at t = 0.125)');
			assert.equal(r.rcsCcw, false);
			assert.equal(r.rcsUllage, false, '2.0 - 0.125 = 1.875 s left > 1.5 s');
		});

		it('MECO -> separation -> interstage coast -> ignition: settle timer, damping and ullage follow the design', () => {
			const r = makeCalcRocket();
			r.stageState = 'STG_MECO';
			r.stgTimer = 0;
			r.burnTime = 0; r.fuelMass = 0; r.oxidMass = 0;
			r.isIgnited = false;
			r.flightComputer.flightTime = 100;
			const log = [];
			for (let i = 0; i < 11; i++) {
				r.flightControl(0.25, null, 0);
				log.push({ state: r.stageState, stg: r.stgTimer, timer: r._postSepRcsTimer, cw: r.rcsCw, ccw: r.rcsCcw, ullage: r.rcsUllage });
			}
			// step 1: still in MECO (0.25 < 0.5 s separation delay)
			assert.deepEqual(log[0], { state: 'STG_MECO', stg: 0.25, timer: 0, cw: false, ccw: false, ullage: false });
			// step 2: separation (timer set to 2.5 and decremented in the same step), coast starts
			assert.equal(log[1].state, 'INTERSTAGE_COAST');
			assert.equal(r.currentStageIndex, 1);
			const expectedUllage = [false, false, false, true, true, true, true, true, true, false, false];
			for (let i = 1; i < 11; i++) {
				const e = log[i];
				assert.equal(e.timer, Math.max(0, 2.5 - 0.25 * i), `step ${i + 1} settle timer`);
				assert.deepEqual({ cw: e.cw, ccw: e.ccw }, designDamp(e.timer), `step ${i + 1} damping (err = 0)`);
				assert.equal(e.ullage, expectedUllage[i], `step ${i + 1} ullage`);
			}
			// steps 2..9 coast, step 10 ignites the second stage (stgTimer reaches the 2.0 s delay)
			for (let i = 1; i <= 8; i++) assert.equal(log[i].state, 'INTERSTAGE_COAST', `step ${i + 1}`);
			assert.equal(log[9].state, 'STG_BURNING');
			assert.equal(log[3].stg, 0.5, 'ullage starts with 1.5 s left');
		});
	});

	describe('every separation arms the post-separation settle timer (§3.2-2: fairing, boosters, stage, payload)', () => {
		const SETTLE = D_RCS.POST_SEP_SETTLE_S;
		const FAIRING = { enabled: true, massT: 1.0, separationAltKm: 110 };
		const BOOSTERS = { count: 2, dryMassT: 10, burnTimeSec: 100, thrustKN: 2000, coreThrustKN: 3000, separationDelaySec: 1.5 };

		it('fairing: armed at the separation altitude (>=) or when forced; not just below it; not re-armed once separated', () => {
			const r = makeCalcRocket({ fairing: { ...FAIRING } });
			r.separateFairing(110000 - 1e-6);
			assert.equal(r.fairing.isSeparated, false, 'just below 110 km');
			assert.equal(r._postSepRcsTimer, 0);
			r.separateFairing(110000);
			assert.equal(r.fairing.isSeparated, true, 'at 110 km');
			assert.equal(r._postSepRcsTimer, SETTLE);
			r._postSepRcsTimer = 0.4;
			r.separateFairing(200000);
			assert.equal(r._postSepRcsTimer, 0.4, 'already separated: no second separation, no re-arm');
			const forced = makeCalcRocket({ fairing: { ...FAIRING } });
			forced.separateFairing(0, true);
			assert.equal(forced.fairing.isSeparated, true);
			assert.equal(forced._postSepRcsTimer, SETTLE, 'forced separation');
			const none = makeCalcRocket();
			none.separateFairing(200000, true);
			assert.equal(none._postSepRcsTimer, 0, 'no fairing: nothing separated, timer untouched');
		});

		it('fairing via flightControl: the step that reaches the altitude separates before the RCS update (timer 2.5 - dt, damping on)', () => {
			const r = makeCalcRocket({ fairing: { ...FAIRING }, autoControl: false });
			const host = { x: 0, y: -(6.378e6 + 110000), vx: 0, vy: 0, radius: 6.378e6, mass: 5.972e24, name: 'UnitHost' };
			r.flightComputer.flightTime = 50;
			r.flightControl(0.05, host, 6.378e6 + 110000 - 1);
			assert.equal(r.fairing.isSeparated, false, 'precondition: 1 m below the separation altitude');
			assert.equal(r._postSepRcsTimer, 0);
			r.flightControl(0.05, host, 6.378e6 + 110000);
			assert.equal(r.fairing.isSeparated, true);
			assertNear(r._postSepRcsTimer, SETTLE - 0.05, 1e-12, 'armed, then decremented by the same step');
			assert.deepEqual({ cw: r.rcsCw, ccw: r.rcsCcw }, designDamp(r._postSepRcsTimer), 'settle damping (manual control: err = 0)');
		});

		it('boosters: separateBoosters arms the timer; no boosters or already separated leave it untouched', () => {
			const r = makeCalcRocket({ boosters: { ...BOOSTERS } });
			assert.equal(r.hasBoosters, true, 'precondition');
			r.separateBoosters();
			assert.equal(r.isBoosterSeparated, true);
			assert.equal(r._postSepRcsTimer, SETTLE);
			r._postSepRcsTimer = 0.4;
			r.separateBoosters();
			assert.equal(r._postSepRcsTimer, 0.4, 'already separated');
			const none = makeCalcRocket();
			none.separateBoosters();
			assert.equal(none.isBoosterSeparated, false);
			assert.equal(none._postSepRcsTimer, 0, 'no boosters');
		});

		it('boosters via flightControl: burnout, then the separation delay, then the timer is armed', () => {
			const r = makeCalcRocket({ boosters: { ...BOOSTERS }, autoControl: false });
			r.isBoosterBurnout = true;
			r.boosterSepTimer = 0;
			for (let i = 0; i < 10 && !r.isBoosterSeparated; i++) { r.flightControl(0.25, null, 0); }
			assert.equal(r.isBoosterSeparated, true, 'separated after the 1.5 s delay');
			assert.ok(r._postSepRcsTimer > 0 && r._postSepRcsTimer <= SETTLE, `settle window open (${r._postSepRcsTimer} s)`);
			r.flightControl(0.25, null, 0);
			assert.ok(r._postSepRcsTimer > 0 && r._postSepRcsTimer < SETTLE, 'and it counts down');
		});

		it('stage: separateCurrentStage arms the timer for an intermediate and for the final stage', () => {
			const r = makeCalcRocket();
			r._postSepRcsTimer = 0.3;
			r.separateCurrentStage();
			assert.equal(r.currentStageIndex, 1);
			assert.equal(r._postSepRcsTimer, SETTLE, 'stage 1 jettisoned');
			r._postSepRcsTimer = 0.3;
			r.separateCurrentStage();
			assert.equal(r.isPayloadSeparated, true);
			assert.equal(r._postSepRcsTimer, SETTLE, 'final stage jettisoned (payload released)');
		});

		it('payload: separatePayload ends with a full settle timer, from either stage and with no stage left to jettison', () => {
			for (const stagesToDrop of [0, 1]) {
				const r = makeCalcRocket();
				for (let k = 0; k < stagesToDrop; k++) { r.separateCurrentStage(); }
				r._postSepRcsTimer = 0.7;
				r.separatePayload();
				assert.equal(r.isPayloadSeparated, true, `from stage index ${stagesToDrop}`);
				assert.equal(r._postSepRcsTimer, SETTLE, `from stage index ${stagesToDrop}`);
			}
			// Stage index already past the last stage while the payload flag is still clear (e.g. an inconsistent restored
			// state): no stage is left for separateCurrentStage, so only separatePayload's own assignment arms the timer.
			const pastLast = makeCalcRocket();
			pastLast.currentStageIndex = pastLast.totalStages;
			assert.equal(pastLast.isPayloadSeparated, false, 'precondition: payload flag clear');
			pastLast.separatePayload();
			assert.equal(pastLast._postSepRcsTimer, SETTLE, 'armed without a stage jettison');
			for (const over of [{ disableStaging: true }, {}]) {
				const noop = makeCalcRocket(over);
				if (!over.disableStaging) { noop.separatePayload(); }
				noop._postSepRcsTimer = 0.4;
				noop.separatePayload();
				assert.equal(noop._postSepRcsTimer, 0.4, over.disableStaging ? 'staging disabled: no-op' : 'already separated: no-op');
			}
		});
	});

	describe('flightControl hands the current thrust to _updateRcsState (§3.2-2 currentThrustN)', () => {
		const spyThrust = (r) => {
			const seen = [];
			const orig = r._updateRcsState;
			r._updateRcsState = function (dt, thrustN, pre) { seen.push(thrustN); return orig.call(this, dt, thrustN, pre); };
			return seen;
		};

		it('burning under manual control (throttle 1): the stage thrust, > 0', () => {
			const r = makeCalcRocket({ autoControl: false });
			const seen = spyThrust(r);
			r.flightControl(0.1, null, 0);
			assert.equal(r.stageState, 'STG_BURNING');
			assert.equal(seen.length, 1);
			assert.ok(seen[0] > 0, 'thrusting');
			assert.equal(seen[0], r.thrustForce, 'thrust x throttle 1');
		});

		it('burning under guidance with a commanded throttle of 0.6: 0.6 x the stage thrust', () => {
			const r = makeCalcRocket();
			const fcUpdate = r.flightComputer.update;
			r.flightComputer.update = function (sensor) { const out = fcUpdate.call(this, sensor); this.currentThrottle = 0.6; return out; };
			const seen = spyThrust(r);
			r.flightControl(0.1, null, 0);
			assert.equal(r.stageState, 'STG_BURNING');
			assert.equal(seen[0], r.thrustForce * 0.6);
		});

		it('engine off with propellant left (burnTime > 0) counts as zero thrust: interstage coast, commanded coast, throttle 0', () => {
			const interstage = makeCalcRocket();
			interstage._activateStage(1);
			interstage.stageState = 'INTERSTAGE_COAST';
			interstage.stgTimer = 0;
			interstage.isIgnited = false;
			const coast = makeCalcRocket({ autoControl: false });
			coast._activateStage(1);
			coast.stageState = 'STG_COAST';
			coast.isIgnited = false;
			const throttledOff = makeCalcRocket();
			const fcUpdate = throttledOff.flightComputer.update;
			throttledOff.flightComputer.update = function (sensor) { const out = fcUpdate.call(this, sensor); this.currentThrottle = 0; return out; };
			for (const [label, r, state] of [['INTERSTAGE_COAST', interstage, 'INTERSTAGE_COAST'], ['STG_COAST (manual)', coast, 'STG_COAST'], ['commanded throttle 0 early in the burn', throttledOff, 'STG_BURNING']]) {
				const seen = spyThrust(r);
				r.flightControl(0.1, null, 0);
				assert.ok(r.burnTime > 0 && r.thrustForce > 0, `${label}: precondition propellant and nominal thrust left`);
				assert.equal(r.stageState, state, `${label}: state`);
				assert.equal(seen[0], 0, `${label}: currentThrustN`);
			}
		});

		it('interstage coast in dense air: zero thrust lets a 0.05 rad error fire pulsed CW (pressure ratio 1.0 > 0.35)', () => {
			const r = makeCalcRocket();
			r._activateStage(1);
			r.stageState = 'INTERSTAGE_COAST';
			r.stgTimer = 0;
			r.isIgnited = false;
			r.ambientPresRatio = 1.0;
			r.vx = 1000 * Math.cos(0.05);
			r.vy = 1000 * Math.sin(0.05);
			r.flightControl(0.125, null, 0);
			assert.ok(r.burnTime > 0, 'precondition: the next stage has propellant');
			assertNear(r.flightComputer.desiredThrustAngleRad, 0.05, 1e-12, 'prograde target, err = 0.05 rad');
			assert.equal(r.rcsCw, true, 'allowRcs by zero thrust; 0.015 < err < 0.08 -> pulse, on at t = 0.125 s');
			assert.equal(r.rcsCcw, false);
		});
	});

	describe('trackRcsVisualState', () => {
		const coastSetup = (over) => {
			const r = makeCalcRocket(over);
			r._activateStage(1);
			r.stageState = 'INTERSTAGE_COAST';
			r.stgTimer = 1.0;
			r.isIgnited = false;
			r.vx = 1000 * Math.cos(0.05);
			r.vy = 1000 * Math.sin(0.05);
			r._postSepRcsTimer = 1.0;
			let calls = 0;
			const orig = r._updateRcsState;
			r._updateRcsState = function (...args) { calls++; return orig.apply(this, args); };
			return { r, calls: () => calls };
		};

		it('defaults to true (undefined) and updates the RCS state every flightControl step', () => {
			const { r, calls } = coastSetup({});
			assert.equal(r.trackRcsVisualState, true);
			r.flightControl(0.125, null, 0);
			r.flightControl(0.125, null, 0);
			assert.equal(calls(), 2);
			assert.equal(r._postSepRcsTimer, 0.75);
			assert.equal(r.rcsUllage, true);
		});

		it('false skips _updateRcsState entirely: flags stay off and timers are not advanced', () => {
			const { r, calls } = coastSetup({ trackRcsVisualState: false });
			assert.equal(r.trackRcsVisualState, false);
			r.flightControl(0.125, null, 0);
			r.flightControl(0.125, null, 0);
			assert.equal(calls(), 0);
			assert.deepEqual(flagsOf(r), { cw: false, ccw: false, ullage: false });
			assert.equal(r._postSepRcsTimer, 1.0);
			assert.equal(r.stgTimer, 1.25, 'physics/staging still advance');
		});
	});
});

/*******************************************************************
 * 3. FlightComputer._computeThrustAngle
 *******************************************************************/
describe('Unit 08-3: FlightComputer._computeThrustAngle (INTERSTAGE_COAST + desiredThrustAngleRad)', () => {
	const guidedFc = () => {
		const fc = new FlightComputer({ thrustAngle: 0 });
		fc.flightTime = 20;
		fc.currentThrustAngle = 0;
		fc.targetLaunchAngle = 1.0;
		fc.telemetryCache.progradeAngle = 0.5;
		fc.telemetryCache.gravityAngle = -Math.PI / 2;
		fc.telemetryCache.altM = 5000;
		return fc;
	};
	const sensor = (o = {}) => ({ dt: 0.5, burnTime: 100, stageState: 'STG_BURNING', isPayloadSeparated: false, isHoldDown: false, x: 0, y: 0, qAxialKpa: 0, qLateralKpa: 0, ...o });

	it('the constructor seeds desiredThrustAngleRad with the initial thrust angle', () => {
		assert.equal(new FlightComputer({ thrustAngle: 0.7 }).desiredThrustAngleRad, 0.7);
		assert.equal(new FlightComputer({}).desiredThrustAngleRad, 0);
	});

	it('STG_BURNING (reference): the guidance target is stored and approached at MAX_TURN_RATE', () => {
		const fc = guidedFc();
		const out = fc._computeThrustAngle(sensor());
		assert.equal(fc.desiredThrustAngleRad, 1.0);
		assertNear(out, FLIGHT_COMPUTER_CONFIG.MAX_TURN_RATE_PER_SEC * 0.5, 1e-12, 'rate-limited guided output');
	});

	it('INTERSTAGE_COAST with propellant in the next stage follows prograde instead of the guidance target', () => {
		const fc = guidedFc();
		const out = fc._computeThrustAngle(sensor({ stageState: 'INTERSTAGE_COAST' }));
		assert.equal(fc.desiredThrustAngleRad, 0.5);
		assert.equal(out, 0.5, '|diff| 0.5 <= coast limit 1.5 rad/s * 0.5 s = 0.75');
	});

	it('the coast turn-rate limit 1.5 rad/s applies at its boundary', () => {
		assert.equal(FLIGHT_COMPUTER_CONFIG.COAST_TURN_RATE_PER_SEC, 1.5);
		const at = guidedFc();
		at.telemetryCache.progradeAngle = 0.75;
		assert.equal(at._computeThrustAngle(sensor({ stageState: 'INTERSTAGE_COAST' })), 0.75, 'exactly the limit reaches the target');
		const over = guidedFc();
		over.telemetryCache.progradeAngle = 0.75 + 1e-9;
		assert.equal(over._computeThrustAngle(sensor({ stageState: 'INTERSTAGE_COAST' })), 0.75, 'just above is clamped to +0.75');
		assert.equal(over.desiredThrustAngleRad, 0.75 + 1e-9);
		const neg = guidedFc();
		neg.telemetryCache.progradeAngle = -2.0;
		assert.equal(neg._computeThrustAngle(sensor({ stageState: 'INTERSTAGE_COAST' })), -0.75);
		assert.equal(neg.desiredThrustAngleRad, -2.0);
	});

	it('coast tracking wraps across ±π the short way', () => {
		const fc = guidedFc();
		fc.currentThrustAngle = 3.0;
		fc.telemetryCache.progradeAngle = -3.0;
		assert.equal(fc._computeThrustAngle(sensor({ stageState: 'INTERSTAGE_COAST' })), -3.0);
		assert.equal(fc.desiredThrustAngleRad, -3.0);
	});

	it('ORBITAL_COAST and burnTime <= 0 also store prograde', () => {
		const a = guidedFc();
		a._computeThrustAngle(sensor({ stageState: 'ORBITAL_COAST' }));
		assert.equal(a.desiredThrustAngleRad, 0.5);
		const b = guidedFc();
		b._computeThrustAngle(sensor({ burnTime: 0 }));
		assert.equal(b.desiredThrustAngleRad, 0.5);
	});

	it('a separated payload points at the Sun only when it is farther than MIN_SUN_DIST_SQ', () => {
		const far = guidedFc();
		far._computeThrustAngle(sensor({ stageState: 'ORBITAL_COAST', isPayloadSeparated: true, sunX: 0, sunY: 10 }));
		assertNear(far.desiredThrustAngleRad, Math.PI / 2, 1e-15, 'sun-pointing target');
		const near = guidedFc();
		near._computeThrustAngle(sensor({ stageState: 'ORBITAL_COAST', isPayloadSeparated: true, sunX: 1, sunY: 0 }));
		assert.equal(near.desiredThrustAngleRad, 0.5, 'dist^2 = 1.0 is not > MIN_SUN_DIST_SQ -> prograde');
	});

	it('hold-down and tower clearance store the local zenith', () => {
		const hold = guidedFc();
		assertNear(hold._computeThrustAngle(sensor({ isHoldDown: true })), Math.PI / 2, 1e-15, 'hold-down output');
		assertNear(hold.desiredThrustAngleRad, Math.PI / 2, 1e-15, 'hold-down target');
		const tower = guidedFc();
		tower.flightTime = 5;
		tower.telemetryCache.altM = 500;
		tower._computeThrustAngle(sensor());
		assertNear(tower.desiredThrustAngleRad, Math.PI / 2, 1e-15, 'tower-clearance target');
	});

	it('update() refreshes desiredThrustAngleRad on every step across phase changes (never stale)', () => {
		const fc = new FlightComputer({ thrustAngle: 0 });
		fc.flightTime = 20;
		const plan = [
			{ stageState: 'STG_BURNING', burnTime: 50, prograde: 0.2, desired: 0 },
			{ stageState: 'INTERSTAGE_COAST', burnTime: 50, prograde: -0.4, desired: -0.4 },
			{ stageState: 'INTERSTAGE_COAST', burnTime: 50, prograde: 1.2, desired: 1.2 },
			{ stageState: 'STG_BURNING', burnTime: 50, prograde: 0.3, desired: 0 },
			{ stageState: 'ORBITAL_COAST', burnTime: 0, prograde: 2.5, desired: 2.5 }
		];
		for (const [i, p] of plan.entries()) {
			fc.update({
				dt: 0.1, isHoldDown: false, refBody: null, distToRefM: 0, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
				mass: 100, fuelMass: 50, thrustForce: 1e6, thrustRatio: 1, massLossRate: 1, burnTime: p.burnTime,
				stageState: p.stageState, qAxialKpa: 0, qLateralKpa: 0, aoaDeg: 0, progradeAngle: p.prograde,
				isPayloadSeparated: false, stages: [], stageIndex: 0
			});
			assertNear(fc.desiredThrustAngleRad, p.desired, 1e-15, `step ${i} (${p.stageState})`);
		}
	});
});

/*******************************************************************
 * 4. RocketRenderer: layout, RCS nozzles, LOD, vapor cone
 *******************************************************************/
const LAYOUT_KEYS = Object.freeze(['interstageShoulder', 'noseShoulder', 'rcs', 'screenRadius']);

describe('Unit 08-4: RocketRenderer._computeVisualLayout (effect anchors, design 2026-11-23 §3.4)', () => {
	const m = VIS.MODULES;
	const busFront = (sat) => ({ x: sat.cx + 0.5 * sat.r * m.SATELLITE_BUS_W_RATIO, halfWidth: 0.5 * sat.r * m.SATELLITE_BUS_H_RATIO });

	for (const [totalStages, ratioName] of [[1, 'STAGE1_RADIUS_RATIO'], [2, 'STAGE2_RADIUS_RATIO'], [3, 'STAGE3_RADIUS_RATIO']]) {
		it(`payload-only (${totalStages}-stage vehicle): noseShoulder = bus front (0.70, 0.85) * payloadR, no interstage, RCS on the bus corners`, () => {
			const R = 25;
			const stages = Array.from({ length: totalStages }, () => ({ fuelType: 'liquid' }));
			const rocket = renderRocket({ totalStages, stages, isPayloadSeparated: true, currentStageIndex: totalStages });
			const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
			const payloadR = R * m[ratioName];
			assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS);
			assert.equal(layout.screenRadius, R);
			assertNear(layout.noseShoulder.x, 0.70 * payloadR, 1e-12, 'bus front = busW / 2 = 0.70 * payloadR');
			assertNear(layout.noseShoulder.halfWidth, 0.85 * payloadR, 1e-12, 'bus half-height = busH / 2 = 0.85 * payloadR');
			assert.equal(layout.interstageShoulder, null, 'the payload alone has no interstage');
			const b = 0.85 * payloadR;
			assertRcsNear(layout.rcs, designPayloadNozzles({ a: 0.70 * payloadR, b, plumeLen: Math.max(4.0, 2.4 * b) }), 1e-12, 'bus corners');
			const hull = captureHull(rocket, R);
			assert.equal(hull.sats.length, 1);
			assert.equal(hull.sats[0].deployed, true, 'payload-only draws the deployed satellite');
			assertNear(hull.sats[0].r, payloadR, 1e-12, 'drawn satellite uses the same payloadR');
			assert.equal(hull.stages.length, 0);
			const front = busFront(hull.sats[0]);
			assertNear(layout.noseShoulder.x, front.x, 1e-12, 'noseShoulder = drawn bus front');
			assertNear(layout.noseShoulder.halfWidth, front.halfWidth, 1e-12, 'noseShoulder halfWidth = drawn bus half-height');
		});
	}

	it('payload-only is entered by any of: isPayloadSeparated, telemetry.isPayloadSeparated, stageIndex >= totalStages', () => {
		const R = 20;
		const payloadR = R * m.STAGE2_RADIUS_RATIO;
		const variants = [
			renderRocket({ isPayloadSeparated: true }),
			renderRocket({ telemetry: { isPayloadSeparated: true, stageIndex: 1, totalStages: 2 } }),
			renderRocket({ currentStageIndex: 2 }),
			renderRocket({ telemetry: { stageIndex: 2, totalStages: 2 } })
		];
		for (const v of variants) {
			const layout = RocketRenderer._computeVisualLayout(v, R, VIS);
			assertNear(layout.noseShoulder.x, 0.70 * payloadR, 1e-12, 'payload-only noseShoulder.x');
			assertNear(layout.noseShoulder.halfWidth, 0.85 * payloadR, 1e-12, 'payload-only noseShoulder.halfWidth');
			assert.equal(layout.interstageShoulder, null);
			assert.equal(layout.rcs.cw[0].uy, 0, 'axial corner jets, not lateral');
		}
	});

	it('boundary: stageIndex = totalStages - 1 is still a stack; disableStaging never becomes payload-only', () => {
		const R = 20;
		const last = RocketRenderer._computeVisualLayout(renderRocket({ currentStageIndex: 1 }), R, VIS);
		assertNear(last.noseShoulder.x, R * 0.6, 1e-12, 'upper stage: noseShoulder at the fairing base -0.6 R + 1.2 R');
		assertNear(last.noseShoulder.halfWidth, R * m.STAGE2_RADIUS_RATIO, 1e-12, 'fairing base radius r2');
		assert.equal(last.interstageShoulder, null, 'no interstage under the upper stage');
		assertNear(Math.abs(last.rcs.cw[0].y), R * m.STAGE2_RADIUS_RATIO, 1e-12, 'lateral jets from the upper-stage wall');
		const sling = RocketRenderer._computeVisualLayout(renderRocket({ disableStaging: true, isPayloadSeparated: true }), R, VIS);
		assertNear(sling.noseShoulder.x, R * 1.6, 1e-12, 'disableStaging keeps the full stack with its fairing (base at 1.6 R)');
		assertNear(sling.interstageShoulder.x, R * 0.4, 1e-12, 'and its interstage (0.4 R)');
		assertNear(sling.interstageShoulder.halfWidth, R * m.STAGE1_RADIUS_RATIO, 1e-12, 'interstage radius r1');
		assertNear(Math.abs(sling.rcs.cw[0].y), R * m.STAGE1_RADIUS_RATIO, 1e-12, 'RCS on the first-stage wall');
	});

	const stackCases = [
		{ name: '1-stage with fairing', over: { totalStages: 1, stages: [{ fuelType: 'liquid' }] } },
		{ name: '1-stage fairing separated', over: { totalStages: 1, stages: [{ fuelType: 'liquid' }], fairing: { enabled: true, isSeparated: true } } },
		{ name: '2-stage, stage 1 attached, fairing', over: {} },
		{ name: '2-stage, stage 1 attached, no fairing', over: { fairing: { enabled: false } } },
		{ name: '2-stage, upper stage, fairing', over: { currentStageIndex: 1, telemetry: { stageIndex: 1, totalStages: 2 } } },
		{ name: '2-stage, upper stage, fairing jettisoned (telemetry)', over: { currentStageIndex: 1, telemetry: { stageIndex: 1, totalStages: 2, isFairingSeparated: true } } },
		{ name: '3-stage, stage 1', over: { totalStages: 3, stages: [{}, {}, {}] } },
		{ name: '3-stage, stage 2, no fairing', over: { totalStages: 3, stages: [{}, {}, {}], currentStageIndex: 1, fairing: { enabled: true, isSeparated: true } } },
		{ name: '3-stage, stage 3, fairing', over: { totalStages: 3, stages: [{}, {}, {}], currentStageIndex: 2 } },
		{ name: '3-stage, stage 3, no fairing', over: { totalStages: 3, stages: [{}, {}, {}], currentStageIndex: 2, fairing: { enabled: false } } },
		{ name: 'slingshot (disableStaging) keeps the fairing', over: { disableStaging: true, fairing: { enabled: false } } }
	];
	for (const c of stackCases) {
		it(`stack anchors sit on the drawn hull: ${c.name}`, () => {
			const R = 25;
			const rocket = renderRocket(c.over);
			const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
			const hull = captureHull(rocket, R);
			assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS, 'exactly the four anchor keys (no xMin / xMax / halfWidth)');
			assert.equal(layout.screenRadius, R);
			assert.ok(hull.stages.length >= 1, 'at least one stage body drawn');
			// noseShoulder: the drawn fairing base, else the front of the drawn stowed payload
			if (hull.fairings.length > 0) {
				assert.equal(hull.sats.length, 0);
				assert.equal(layout.noseShoulder.x, hull.fairings[0].startX, 'noseShoulder.x = drawn fairing base');
				assert.equal(layout.noseShoulder.halfWidth, hull.fairings[0].radius, 'noseShoulder.halfWidth = drawn fairing radius');
			} else {
				assert.equal(hull.sats.length, 1);
				assert.equal(hull.sats[0].deployed, false, 'stowed payload on top of the stack');
				const front = busFront(hull.sats[0]);
				assertNear(layout.noseShoulder.x, front.x, 1e-12, 'noseShoulder.x = drawn bus front');
				assertNear(layout.noseShoulder.halfWidth, front.halfWidth, 1e-12, 'noseShoulder.halfWidth = drawn bus half-height');
			}
			// interstageShoulder: the aft end of the stage drawn just before the uppermost drawn interstage
			const body = hull.order.filter(e => e.kind === 'stage1' || e.kind === 'stage2' || e.kind === 'interstage');
			const iInter = body.findIndex(e => e.kind === 'interstage');
			if (iInter < 0) {
				assert.equal(layout.interstageShoulder, null, 'no drawn interstage');
			} else {
				assert.equal(layout.interstageShoulder.x, body[iInter - 1].startX, 'interstageShoulder.x = startX of the stage above the drawn interstage');
				assert.equal(layout.interstageShoulder.halfWidth, body[iInter].radius, 'interstageShoulder.halfWidth = drawn interstage radius');
			}
			// rcs: on the wall of the last drawn stage, inside its x range
			const current = hull.stages[hull.stages.length - 1];
			for (const nz of [...layout.rcs.cw, ...layout.rcs.ccw, ...layout.rcs.ullage]) {
				assert.equal(Math.abs(nz.y), current.radius, 'nozzle on the current-stage wall');
				assert.ok(nz.x > current.startX && nz.x < current.startX + current.length, `nozzle x ${nz.x} inside the current stage`);
			}
			assert.ok(layout.rcs.cw[0].x > layout.rcs.cw[1].x, 'forward nozzle ahead of the aft nozzle');
		});
	}

	it('a bare rocket object (no stages, no telemetry, no fairing) is laid out as a single stage with its stowed payload', () => {
		const R = 10;
		const layout = RocketRenderer._computeVisualLayout({ thrustAngle: 0 }, R, VIS);
		const want = designStack({ stages: 1, idx: 0, fairing: 'none' }, R);
		assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS);
		assertNear(layout.noseShoulder.x, 2.175 * R, 1e-12, 'stowed bus front (§3.4: 2.175 R)');
		assertNear(layout.noseShoulder.halfWidth, 0.595 * R, 1e-12, 'stowed bus half-height 0.595 R');
		assert.equal(layout.interstageShoulder, null);
		assertRcsNear(layout.rcs, want.rcs, 1e-9, 'single-stage wall');
		assertNear(want.body[0], R * VIS.ALIGNMENT.BASE_X_SINGLE_STAGE_RATIO, 1e-12, 'RCS body starts at the single-stage base');
		assertNear(Math.abs(layout.rcs.cw[0].y), R * m.STAGE1_RADIUS_RATIO, 1e-12, 'single-stage wall r1');
	});

	it('abnormal: an empty object and a null telemetry are laid out as a single stage without throwing', () => {
		for (const rocket of [{}, { telemetry: null }]) {
			const layout = RocketRenderer._computeVisualLayout(rocket, 10, VIS);
			assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS);
			assertNear(layout.noseShoulder.x, 21.75, 1e-12, 'single-stage stowed bus front');
			assert.equal(layout.interstageShoulder, null);
		}
	});
});

describe('Unit 08-5: RocketRenderer.drawColdGasRcs (layout.rcs, design 2026-11-23 §3.6)', () => {
	// A synthetic stack: one 120 px upper-stage body [-50, 70] of radius 10 under a fairing of the same radius, so no
	// part stands out of the wall and the whole body is free: xFwd = -50 + 0.84 * 120 = 50.8, xAft = -50 + 0.14 * 120
	// = -33.2, wall 10, plume max(4, 2.4 * 10) = 24
	const LIT_GEOMETRY = synthGeometry({ startX: -50, length: 120, radius: 10 });
	const LIT_RCS = designStackNozzles({ xFwd: 50.8, xAft: -33.2, h: 10, plumeLen: 24 });
	const LIT = { screenRadius: 30, noseShoulder: { x: 70, halfWidth: 10 }, interstageShoulder: null, rcs: LIT_RCS };
	const draw = (flags, layout = LIT, cfg = VIS, rocketOver = {}) => {
		const ctx = createRecordingCtx();
		RocketRenderer.drawColdGasRcs(ctx, { rcsCw: flags.cw, rcsCcw: flags.ccw, rcsUllage: flags.ullage, ...rocketOver }, layout, cfg);
		return ctx;
	};

	it('the synthetic stack lays its nozzles out by the §3.6.1 table (xFwd 50.8, xAft -33.2, wall 10, plume 24)', () => {
		const layout = RocketRenderer._layoutFromGeometry(LIT_GEOMETRY, 30, VIS);
		assertRcsNear(layout.rcs, LIT_RCS, 1e-9, 'synthetic stack');
	});

	it('CW: nose jet -Y at (xFwd, -h), tail jet +Y at (xAft, +h)', () => {
		const plumes = extractPlumes(draw({ cw: true }));
		assertPlumesMatch(plumes, [
			{ x: 50.8, y: -10, ux: 0, uy: -1 },
			{ x: -33.2, y: +10, ux: 0, uy: +1 }
		], 'CW');
	});

	it('CCW: nose jet +Y at (xFwd, +h), tail jet -Y at (xAft, -h)', () => {
		assertPlumesMatch(extractPlumes(draw({ ccw: true })), [
			{ x: 50.8, y: +10, ux: 0, uy: +1 },
			{ x: -33.2, y: -10, ux: 0, uy: -1 }
		], 'CCW');
	});

	it('Ullage: two aft jets canted 0.28 rad rearward', () => {
		assertPlumesMatch(extractPlumes(draw({ ullage: true })), [
			{ x: -33.2, y: +10, ux: -Math.cos(0.28), uy: Math.sin(0.28) },
			{ x: -33.2, y: -10, ux: -Math.cos(0.28), uy: -Math.sin(0.28) }
		], 'ullage');
	});

	it('every combination of the three bits draws exactly the union of the table rows', () => {
		for (let mask = 0; mask < 8; mask++) {
			const flags = { cw: Boolean(mask & 1), ccw: Boolean(mask & 2), ullage: Boolean(mask & 4) };
			const ctx = draw(flags);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(LIT_RCS, flags), `mask ${mask}`);
			if (mask === 0) {
				assert.equal(ctx.fills.length, 0, 'no flags -> nothing drawn');
			}
		}
	});

	it('physical effect column: CW / CCW are pure couples, ullage is a pure +X push', () => {
		const effect = (flags) => {
			const plumes = extractPlumes(draw(flags));
			const f = jetForce(plumes);
			return { fx: f.x, fy: f.y, tz: jetTorque(plumes) };
		};
		const cw = effect({ cw: true });
		assertNear(cw.fx, 0, 1e-12, 'CW net Fx'); assertNear(cw.fy, 0, 1e-12, 'CW net Fy');
		assertNear(cw.tz, 50.8 - (-33.2), 1e-9, 'CW torque (+Δθ)');
		const ccw = effect({ ccw: true });
		assertNear(ccw.fx, 0, 1e-12, 'CCW net Fx'); assertNear(ccw.fy, 0, 1e-12, 'CCW net Fy');
		assertNear(ccw.tz, -(50.8 - (-33.2)), 1e-9, 'CCW torque (-Δθ)');
		const ull = effect({ ullage: true });
		assertNear(ull.fx, 2 * Math.cos(0.28), 1e-12, 'ullage axial push');
		assertNear(ull.fy, 0, 1e-12, 'ullage lateral'); assertNear(ull.tz, 0, 1e-9, 'ullage torque');
	});

	it('plume geometry follows the schema: length max(MIN_PLUME_PX, 2.4 * h) of the wall radius, mist half-angle 0.34 rad', () => {
		const all = extractPlumes(draw({ cw: true, ccw: true, ullage: true }));
		assert.equal(all.length, 6, 'CW + CCW + ullage draw six plumes');
		for (const p of all) {
			assertNear(p.lenA, 24, 1e-9, 'plume length 2.4 * 10');
			assertNear(p.lenB, 24, 1e-9, 'plume length 2.4 * 10');
			assertNear(p.spreadA, 0.34, 1e-9, 'mist half-angle');
			assertNear(p.spreadB, 0.34, 1e-9, 'mist half-angle');
		}
		// Thin wall (h = 1): 2.4 < MIN_PLUME_PX = 4; boundary h = 4 / 2.4 gives exactly the floor; just above it 2.4 h
		for (const [h, len] of [[1, 4.0], [4.0 / 2.4, 4.0], [4.0 / 2.4 + 1e-6, 2.4 * (4.0 / 2.4 + 1e-6)]]) {
			const layout = RocketRenderer._layoutFromGeometry(synthGeometry({ startX: -5, length: 10, radius: h }), 30, VIS);
			assertNear(layout.rcs.plumeLen, len, 1e-12, `plumeLen for h = ${h}`);
			const thin = extractPlumes(draw({ cw: true }, layout));
			assertPlumesMatch(thin, designNozzles(designStackNozzles({ xFwd: -5 + 0.84 * 10, xAft: -5 + 0.14 * 10, h, plumeLen: len }), { cw: true }), `wall ${h} still draws both CW jets`);
			for (const p of thin) {
				assertNear(p.lenA, len, 1e-9, 'drawn length = rcs.plumeLen');
				assertNear(p.lenB, len, 1e-9, 'drawn length = rcs.plumeLen');
			}
		}
		const core = extractCorePlumes(draw({ cw: true }));
		assert.equal(core.length, 2, 'each nozzle also draws a core jet');
		assertPlumesMatch(core.map(c => ({ ...c })), designNozzles(LIT_RCS, { cw: true }), 'core jets share apex and axis');
		for (const p of core) {
			assertNear(p.lenA, 24 * 0.65, 1e-9, 'core length 0.65 x plumeLen');
			assertNear(p.spreadA, 0.34 * 0.45, 1e-9, 'core half-angle 0.45 x spread');
		}
	});

	it('drawColdGasRcs draws layout.rcs verbatim (it does not recompute the stations)', () => {
		const odd = {
			screenRadius: 30,
			rcs: {
				plumeLen: 13,
				cw: [{ x: 3, y: 7, ux: 0.6, uy: 0.8 }, { x: -9, y: -2, ux: -0.8, uy: 0.6 }],
				ccw: [{ x: 1, y: 1, ux: 1, uy: 0 }, { x: 2, y: 2, ux: 0, uy: 1 }],
				ullage: [{ x: -4, y: 5, ux: -1, uy: 0 }, { x: -4, y: -5, ux: 0, uy: -1 }]
			}
		};
		const plumes = extractPlumes(draw({ cw: true, ccw: true, ullage: true }, odd));
		assertPlumesMatch(plumes, designNozzles(odd.rcs, { cw: true, ccw: true, ullage: true }), 'odd nozzles');
		for (const p of plumes) assertNear(p.lenA, 13, 1e-9, 'rcs.plumeLen');
	});

	it('nozzles on real layouts (2-stage stack and payload-only) follow the design tables', () => {
		const cases = [
			{ rocket: renderRocket({ rcsCw: true, rcsUllage: true }), want: designStack({ stages: 2, idx: 0, fairing: 'attached' }, 30).rcs },
			{ rocket: renderRocket({ isPayloadSeparated: true, rcsCcw: true, rcsUllage: true }), want: designStack({ stages: 2, idx: 0, payloadOnly: true }, 30).rcs }
		];
		for (const { rocket, want } of cases) {
			const layout = RocketRenderer._computeVisualLayout(rocket, 30, VIS);
			const ctx = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(ctx, rocket, layout, VIS);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(want, { cw: rocket.rcsCw, ccw: rocket.rcsCcw, ullage: rocket.rcsUllage }), 'real layout');
		}
	});

	it('flags mirrored only in telemetry are honoured (each of rcsCw / rcsCcw / rcsUllage, every combination)', () => {
		for (let mask = 1; mask < 8; mask++) {
			const flags = { cw: Boolean(mask & 1), ccw: Boolean(mask & 2), ullage: Boolean(mask & 4) };
			const ctx = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(ctx, { telemetry: { rcsCw: flags.cw, rcsCcw: flags.ccw, rcsUllage: flags.ullage } }, LIT, VIS);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(LIT_RCS, flags), `telemetry-only mask ${mask}`);
		}
	});

	it('a flag set on either the rocket or its telemetry fires that row (the other source false)', () => {
		for (const key of ['cw', 'ccw', 'ullage']) {
			const field = { cw: 'rcsCw', ccw: 'rcsCcw', ullage: 'rcsUllage' }[key];
			const expected = designNozzles(LIT_RCS, { [key]: true });
			const onRocket = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(onRocket, { [field]: true, telemetry: { [field]: false } }, LIT, VIS);
			assertPlumesMatch(extractPlumes(onRocket), expected, `${field} on the rocket only`);
			const onTelemetry = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(onTelemetry, { [field]: false, telemetry: { [field]: true } }, LIT, VIS);
			assertPlumesMatch(extractPlumes(onTelemetry), expected, `${field} in telemetry only`);
		}
		const none = createRecordingCtx();
		RocketRenderer.drawColdGasRcs(none, { rcsCw: false, telemetry: { rcsCw: false, rcsCcw: false, rcsUllage: false } }, LIT, VIS);
		assert.equal(none.fills.length, 0, 'all false in both sources -> nothing drawn');
	});

	describe('free-wall length |F| (§3.6.1: the former 1 px floor of L is gone)', () => {
		// A body [10, 10 + len] with nothing standing out of the wall is one free stretch: xFwd = 10 + 0.84 |F|,
		// xAft = 10 + 0.14 |F|, 0.70 |F| apart, for any positive length; a body of length 0 or below has no wall (rcs null).
		for (const c of [
			{ label: 'length 2', len: 2 },
			{ label: 'length exactly 1', len: 1 },
			{ label: 'length 0.5 (0 < |F| < 1, formerly floored to 1)', len: 0.5 },
			{ label: 'length 1e-6', len: 1e-6 }
		]) {
			it(`${c.label}: xFwd = 10 + 0.84 |F|, xAft = 10 + 0.14 |F|; CW / CCW keep their couple sign`, () => {
				const layout = RocketRenderer._layoutFromGeometry(synthGeometry({ startX: 10, length: c.len, radius: 3 }), 30, VIS);
				const xFwd = 10 + 0.84 * c.len;
				const xAft = 10 + 0.14 * c.len;
				assertRcsNear(layout.rcs, designStackNozzles({ xFwd, xAft, h: 3, plumeLen: 7.2 }), 1e-12, c.label);
				assertPlumesMatch(extractPlumes(draw({ cw: true, ccw: true, ullage: true }, layout)), designNozzles(layout.rcs, { cw: true, ccw: true, ullage: true }), c.label, 1e-12);
				assert.ok(xFwd > xAft, 'forward station ahead of the aft station');
				const torque = (flags) => jetTorque(extractPlumes(draw(flags, layout)));
				assertNear(torque({ cw: true }), (0.84 - 0.14) * c.len, 1e-12, 'CW couple (+Δθ) = (xFwd - xAft)');
				assertNear(torque({ ccw: true }), -(0.84 - 0.14) * c.len, 1e-12, 'CCW couple (-Δθ)');
				assert.ok(torque({ cw: true }) > 0 && torque({ ccw: true }) < 0, 'couple signs');
			});
		}
		for (const c of [{ label: 'length 0 (degenerate body)', len: 0 }, { label: 'length -40 (inverted body)', len: -40 }]) {
			it(`${c.label}: no free wall, rcs = null, nothing drawn`, () => {
				const layout = RocketRenderer._layoutFromGeometry(synthGeometry({ startX: 10, length: c.len, radius: 3 }), 30, VIS);
				assert.equal(layout.rcs, null);
				assert.equal(draw({ cw: true, ccw: true, ullage: true }, layout).fills.length, 0);
			});
		}
	});

	describe('LOD threshold default 10 when the configuration has none (§3.3-1, Rev 6.10)', () => {
		const noLod = { ...VIS };
		delete noLod.LOD_RADIUS_THRESHOLD;
		for (const [label, cfg] of [['key absent', noLod], ['undefined', { ...VIS, LOD_RADIUS_THRESHOLD: undefined }], ['null', { ...VIS, LOD_RADIUS_THRESHOLD: null }]]) {
			it(`${label}: drawn at screenRadius 10, skipped at 10 - 1e-9 and at the configured 4.0`, () => {
				assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 10 }, cfg)), designNozzles(LIT_RCS, { cw: true }), 'at 10');
				assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 10 + 1e-9 }, cfg)), designNozzles(LIT_RCS, { cw: true }), 'just above 10');
				assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 10 - 1e-9 }, cfg).fills.length, 0, 'just below 10');
				assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 4.0 }, cfg).fills.length, 0, 'the shipped 4.0 is not used');
			});
		}
		it('a configured threshold is used as is, including 0 (only a missing value falls back)', () => {
			const zero = { ...VIS, LOD_RADIUS_THRESHOLD: 0 };
			assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 0 }, zero)), designNozzles(LIT_RCS, { cw: true }), 'threshold 0, screenRadius 0');
			const twelve = { ...VIS, LOD_RADIUS_THRESHOLD: 12 };
			assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 11 }, twelve).fills.length, 0, 'threshold 12, screenRadius 11');
			assert.equal(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 12 }, twelve)).length, 2, 'threshold 12, screenRadius 12');
		});
	});

	it('LOD threshold: drawn at screenRadius = LOD_RADIUS_THRESHOLD, skipped just below', () => {
		assert.equal(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 4.0 })).length, 2);
		assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 4.0 - 1e-9 }).fills.length, 0);
		assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 0 }).fills.length, 0);
	});

	it('abnormal inputs (null rocket / layout, config without COLD_GAS_RCS, layout without rcs) draw nothing and do not throw', () => {
		const ctx = createRecordingCtx();
		const all = { rcsCw: true, rcsCcw: true, rcsUllage: true };
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, null, LIT, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, null, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, LIT, { ...VIS, COLD_GAS_RCS: undefined }));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, LIT, null));
		const { rcs: _dropped, ...noRcs } = LIT;
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, noRcs, VIS), 'rcs key missing');
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, { ...LIT, rcs: null }, VIS), 'rcs null');
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, all, { xMin: -50, xMax: 70, halfWidth: 10, screenRadius: 30 }, VIS), 'a layout of the former shape');
		assert.equal(ctx.fills.length, 0);
	});
});

describe('Unit 08-6: RocketRenderer.draw LOD boundary for RCS and vapor cone', () => {
	const LOD = 4.0;
	const drawAt = (R, over) => {
		const ctx = createRecordingCtx();
		RocketRenderer.draw(ctx, renderRocket(over), 100, 100, R, 1.0);
		return ctx;
	};

	it('at exactly LOD_RADIUS_THRESHOLD the high-detail path draws RCS plumes and the vapor cone on their anchors', () => {
		const ctx = drawAt(LOD, { rcsCw: true, mach: 1.0, ambientPresRatio: 1.0 });
		const want = designStack({ stages: 2, idx: 0, fairing: 'attached' }, LOD);
		assertPlumesMatch(extractPlumes(ctx), designNozzles(want.rcs, { cw: true }), 'nozzles at the LOD boundary');
		const cones = extractCones(ctx);
		assert.equal(cones.length, 2, 'intensity 1 >= 0.55 and an interstage -> primary + secondary');
		assertNear(cones[0].xVertex, want.noseShoulder.x, 1e-12, 'primary at the fairing base');
		assertNear(cones[1].xVertex, want.interstageShoulder.x, 1e-12, 'secondary at the interstage forward edge');
	});

	it('just below the threshold (and far below) the low-detail path draws neither', () => {
		for (const R of [LOD - 1e-9, 2.0]) {
			const ctx = drawAt(R, { rcsCw: true, rcsCcw: true, rcsUllage: true, mach: 1.0, ambientPresRatio: 1.0 });
			assert.equal(extractPlumes(ctx).length, 0, `R = ${R}`);
			assert.equal(extractCones(ctx).length, 0, `R = ${R}`);
		}
	});

	it('large screen radius draws all six RCS plumes', () => {
		const ctx = drawAt(60, { rcsCw: true, rcsCcw: true, rcsUllage: true });
		assertPlumesMatch(extractPlumes(ctx), designNozzles(designStack({ stages: 2, idx: 0 }, 60).rcs, { cw: true, ccw: true, ullage: true }), 'R = 60');
	});
});

describe('Unit 08-7: RocketRenderer.drawVaporCone (§3.5 dimensions from the vertex radius, 2026-11-20 §4.4 intensity)', () => {
	const R = 20;
	const baseRocket = renderRocket();
	const layout = RocketRenderer._computeVisualLayout(baseRocket, R, VIS);
	// Design anchors of the 2-stage first-stage flight (§3.4): fairing base (1.6 R, r2), interstage edge (0.4 R, r1)
	const P = { x: 1.6 * R, halfWidth: 0.65 * R };
	const S = { x: 0.4 * R, halfWidth: 0.7 * R };
	const drawCone = (mach, pres, cfg = VIS, lay = layout, over = {}) => {
		const ctx = createRecordingCtx();
		RocketRenderer.drawVaporCone(ctx, { ...baseRocket, mach, ambientPresRatio: pres, ...over }, lay, cfg);
		return ctx;
	};
	it('the layout under test carries the design anchors of the 2-stage first-stage flight', () => {
		assertNear(layout.noseShoulder.x, P.x, 1e-12, 'noseShoulder.x');
		assertNear(layout.noseShoulder.halfWidth, P.halfWidth, 1e-12, 'noseShoulder.halfWidth');
		assertNear(layout.interstageShoulder.x, S.x, 1e-12, 'interstageShoulder.x');
		assertNear(layout.interstageShoulder.halfWidth, S.halfWidth, 1e-12, 'interstageShoulder.halfWidth');
	});

	it('peak intensity (Mach 1.00, pres 1.0): primary on noseShoulder and a 0.78x secondary on interstageShoulder, each sized by its own h', () => {
		const ctx = drawCone(1.0, 1.0);
		const cones = extractCones(ctx);
		assert.equal(cones.length, 2);
		assertConeAt(cones[0], P, 1.0, D_MACH_ANGLE_CAP, 1.0);
		assertConeAt(cones[1], S, 1.0, D_MACH_ANGLE_CAP, 0.78);
		const rims = extractRims(ctx);
		assert.equal(rims.length, 2, 'each cone has a rim stroke');
		assertRimAt(rims[0], P, cones[0], 1.0, 1.0);
		assertRimAt(rims[1], S, cones[1], 1.0, 0.78);
		for (const c of cones) {
			assert.deepEqual(c.stops.map(s => s[1]), [D_VAPOR.CORE_COLOR, D_VAPOR.CORE_COLOR, D_VAPOR.EDGE_COLOR]);
		}
	});

	it('Mach 0.91 (machFactor 0.5): primary only, dimensions from intensity 0.5', () => {
		const cones = extractCones(drawCone(0.91, 1.0));
		assert.equal(cones.length, 1);
		assertConeAt(cones[0], P, designVapor(0.91, 1.0).intensity, D_MACH_ANGLE_CAP, 1.0);
		assertNear(designVapor(0.91, 1.0).intensity, 0.5, 1e-12, 'oracle sanity');
	});

	it('Mach 1.2 uses the true Mach angle asin(1/1.2) (below the cap)', () => {
		const v = designVapor(1.2, 1.0);
		const cones = extractCones(drawCone(1.2, 1.0));
		assert.equal(cones.length, 1, `intensity ${v.intensity} < 0.55`);
		assertConeAt(cones[0], P, v.intensity, Math.asin(1 / 1.2), 1.0);
	});

	it('secondary-cone threshold 0.55 (Mach 1, presFactor = intensity): just below / exactly / above', () => {
		assert.equal(extractCones(drawCone(1.0, 0.15249999999999997)).length, 1, 'intensity 0.5499999999999998');
		assert.equal(extractCones(drawCone(1.0, 0.1525)).length, 2, 'intensity exactly 0.55 (>=)');
		assert.equal(extractCones(drawCone(1.0, 0.16)).length, 2, 'intensity 0.58');
		const custom = { ...VIS, VAPOR_CONE: { ...VIS.VAPOR_CONE, SECONDARY_INTENSITY_MIN: designVapor(1.0, 0.2).intensity } };
		assert.equal(extractCones(drawCone(1.0, 0.2, custom)).length, 2, 'equality with a configured threshold');
		const customAbove = { ...VIS, VAPOR_CONE: { ...VIS.VAPOR_CONE, SECONDARY_INTENSITY_MIN: designVapor(1.0, 0.2).intensity + 1e-12 } };
		assert.equal(extractCones(drawCone(1.0, 0.2, customAbove)).length, 1);
	});

	it('MAX_WIDTH_MULTIPLIER clamps the half width of each cone by its own h', () => {
		const clamped = { ...VIS, VAPOR_CONE: { ...VIS.VAPOR_CONE, MAX_WIDTH_MULTIPLIER: 1.5 } };
		const cones = extractCones(drawCone(1.0, 1.0, clamped));
		assertConeAt(cones[0], P, 1.0, D_MACH_ANGLE_CAP, 1.0, 1.5);
		assertConeAt(cones[1], S, 1.0, D_MACH_ANGLE_CAP, 0.78, 1.5);
		assertNear(cones[0].halfW, 1.5 * P.halfWidth, 1e-9, 'clamped to 1.5 * the fairing radius');
		assertNear(cones[1].halfW, 1.5 * S.halfWidth * 0.78, 1e-9, 'secondary clamp: 1.5 * the interstage radius * 0.78');
	});

	it('inactive or too faint vapor draws nothing', () => {
		for (const [mach, pres] of [[0.5, 1.0], [0.8199, 1.0], [0.82, 1.0], [1.22, 1.0], [1.2201, 1.0], [1.0, 0.015], [1.0, 0.0174], [NaN, 1.0], [1.0, NaN]]) {
			const ctx = drawCone(mach, pres);
			assert.equal(ctx.fills.length, 0, `mach ${mach}, pres ${pres}`);
			assert.equal(ctx.strokes.length, 0, `mach ${mach}, pres ${pres}`);
		}
		assert.equal(extractCones(drawCone(1.0, 0.0176)).length, 1, 'intensity 0.0104 > 0.01 is drawn');
	});

	it('Mach source: rocket.mach first, telemetry.mach when rocket.mach is not finite, else 0', () => {
		assert.equal(extractCones(drawCone(undefined, 1.0, VIS, layout, { telemetry: { mach: 1.0 } })).length, 2);
		assert.equal(extractCones(drawCone(NaN, 1.0, VIS, layout, { telemetry: { mach: 1.0 } })).length, 2);
		assert.equal(extractCones(drawCone(0.5, 1.0, VIS, layout, { telemetry: { mach: 1.0 } })).length, 0, 'finite rocket.mach wins');
		assert.equal(extractCones(drawCone(undefined, 1.0, VIS, layout, {})).length, 0);
	});

	it('ambient pressure falls back to telemetry when the rocket field is absent', () => {
		const ctx = createRecordingCtx();
		const rocket = { ...baseRocket, mach: 1.0, telemetry: { ambientPresRatio: 1.0 } };
		delete rocket.ambientPresRatio;
		RocketRenderer.drawVaporCone(ctx, rocket, layout, VIS);
		assert.equal(extractCones(ctx).length, 2);
	});

	it('LOD threshold and abnormal inputs', () => {
		assert.equal(extractCones(drawCone(1.0, 1.0, VIS, { ...layout, screenRadius: 4.0 })).length, 2);
		assert.equal(drawCone(1.0, 1.0, VIS, { ...layout, screenRadius: 4.0 - 1e-9 }).fills.length, 0);
		const ctx = createRecordingCtx();
		assert.doesNotThrow(() => RocketRenderer.drawVaporCone(ctx, null, layout, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawVaporCone(ctx, { mach: 1, ambientPresRatio: 1 }, null, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawVaporCone(ctx, { mach: 1, ambientPresRatio: 1 }, layout, { ...VIS, VAPOR_CONE: undefined }));
		assert.equal(ctx.fills.length, 0);
	});

	it('LOD threshold default 10 when the configuration has none; a configured 0 is used as is', () => {
		const noLod = { ...VIS };
		delete noLod.LOD_RADIUS_THRESHOLD;
		for (const cfg of [noLod, { ...VIS, LOD_RADIUS_THRESHOLD: undefined }, { ...VIS, LOD_RADIUS_THRESHOLD: null }]) {
			assert.equal(extractCones(drawCone(1.0, 1.0, cfg, { ...layout, screenRadius: 10 })).length, 2, 'drawn at 10');
			assert.equal(drawCone(1.0, 1.0, cfg, { ...layout, screenRadius: 10 - 1e-9 }).fills.length, 0, 'skipped just below 10');
			assert.equal(drawCone(1.0, 1.0, cfg, { ...layout, screenRadius: 4.0 }).fills.length, 0, 'the shipped 4.0 is not used');
		}
		assert.equal(extractCones(drawCone(1.0, 1.0, { ...VIS, LOD_RADIUS_THRESHOLD: 0 }, { ...layout, screenRadius: 0 })).length, 2, 'threshold 0');
	});

	// The former "station length L = max(1, xMax - xMin)" cases: the vertex positions now come from the layout anchors
	// alone, whatever the hull length; each cone is sized by its own anchor.
	for (const c of [
		{ label: 'secondary aft of the primary (the stack order)', nose: { x: 12, halfWidth: 6 }, inter: { x: 4, halfWidth: 7 } },
		{ label: 'both vertices at the same station', nose: { x: 10, halfWidth: 6 }, inter: { x: 10, halfWidth: 7 } },
		{ label: 'a secondary ahead of the primary is drawn where the layout puts it', nose: { x: -5, halfWidth: 3 }, inter: { x: 9, halfWidth: 2 } },
		{ label: 'negative stations, thin body (rim width floor 1)', nose: { x: -30, halfWidth: 0.5 }, inter: { x: -40, halfWidth: 0.25 } },
		{ label: 'no interstage', nose: { x: 12, halfWidth: 6 }, inter: null }
	]) {
		it(`hand-built anchors, ${c.label}: each cone sits on its anchor and is sized by its own halfWidth`, () => {
			const lay = { screenRadius: 30, noseShoulder: c.nose, interstageShoulder: c.inter, rcs: null };
			const ctx = drawCone(1.0, 1.0, VIS, lay);
			const cones = extractCones(ctx);
			assert.equal(cones.length, c.inter ? 2 : 1);
			assertConeAt(cones[0], c.nose, 1.0, D_MACH_ANGLE_CAP, 1.0);
			assertRimAt(extractRims(ctx)[0], c.nose, cones[0], 1.0, 1.0);
			if (c.inter) {
				assertConeAt(cones[1], c.inter, 1.0, D_MACH_ANGLE_CAP, 0.78);
				assertRimAt(extractRims(ctx)[1], c.inter, cones[1], 1.0, 0.78);
			}
		});
	}
});
/*******************************************************************
 * 5. AeroUtils
 *******************************************************************/
describe('Unit 08-8: AeroUtils temperature, speed of sound and Mach', () => {
	describe('getAtmosphericTemperatureK', () => {
		const T = (h, p = EARTH_ATM) => AeroUtils.getAtmosphericTemperatureK(h, p);

		it('troposphere lapse 6.5 K/km from 288.15 K and the tropopause at 11 km (Earth, H = 8500 m)', () => {
			assertNear(T(0), 288.15, 1e-12, 'sea level');
			assertNear(T(5000), 255.65, 1e-9, '5 km');
			assertNear(T(10999), 216.6565, 1e-9, 'tropopause - 1 m');
			assertNear(T(11000), 216.65, 1e-9, 'tropopause');
			assertNear(T(11001), 216.651, 1e-9, 'tropopause + 1 m (+1 K/km)');
			assertNear(T(50000), 255.65, 1e-9, '50 km');
			assertNear(T(100000), 305.65, 1e-9, 'at the atmosphere limit (inclusive)');
		});

		it('is continuous at the tropopause', () => {
			assertNear(T(11000 - 1e-6), T(11000 + 1e-6), 1e-8, 'continuity');
		});

		it('negative altitudes clamp to the surface value', () => {
			assert.equal(T(-500), T(0));
			assert.equal(T(-Number.MAX_VALUE), T(0));
		});

		it('scale height rescales the tropopause and lapse rates (H = 17000 m -> ratio 2)', () => {
			const p = { ...EARTH_ATM, ATM_SCALE_HEIGHT: 17000, ATM_LIMIT_ALT: 200000 };
			assertNear(T(11000, p), 252.4, 1e-9, 'half lapse at 11 km');
			assertNear(T(22000, p), 216.65, 1e-9, 'tropopause at 22 km');
			assertNear(T(32000, p), 221.65, 1e-9, 'half stratospheric gradient');
			for (const H of [3000, 8500, 11100, 27000]) {
				const q = { ...UNLIMITED_ATM, ATM_SCALE_HEIGHT: H };
				assertNear(T(0, q), 288.15, 1e-12, `surface for H ${H}`);
				assertNear(T(11000 * H / 8500, q), 216.65, 1e-9, `tropopause for H ${H}`);
				assertNear(T(12345, q), designTemperatureK(12345, H), 1e-12, `oracle for H ${H}`);
			}
		});

		it('upper clamp 350 K (no altitude limit)', () => {
			assertNear(T(144349, UNLIMITED_ATM), 349.999, 1e-9, 'just below the clamp');
			assertNear(T(144350, UNLIMITED_ATM), 350, 1e-9, 'at the clamp');
			assert.equal(T(200000, UNLIMITED_ATM), 350, 'raw 405.65 K clamped');
			assert.equal(T(1e9, UNLIMITED_ATM), 350);
		});

		it('lower clamp 180 K: the result never leaves [180, 350] for any scale height / altitude', () => {
			for (const H of [1, 100, 8500, 1e5, 1e7]) {
				for (const h of [0, 1, 1e3, 1e4, 2e4, 1e5, 1e6, 1e8]) {
					const v = T(h, { ...UNLIMITED_ATM, ATM_SCALE_HEIGHT: H });
					assert.ok(v >= 180 && v <= 350, `H ${H}, h ${h}: ${v}`);
					assertNear(v, designTemperatureK(h, H), 1e-9, `oracle H ${H}, h ${h}`);
				}
			}
		});

		describe('lower clamp 180 K is reachable only through a degenerate scale height (G3-1-04)', () => {
			// With scaleRatio = H / 8500 > 0 but 0.0065 / scaleRatio overflowing to Infinity (H < ~3.07e-307 m), the design
			// formula gives rawT = 288.15 - Infinity * h = -Infinity for 0 < h <= tropopause (11000 * scaleRatio), which the
			// clamp turns into 180 K; at h <= 0 (clAlt = 0) Infinity * 0 = NaN. Values below follow from IEEE-754 arithmetic.
			const H = 1e-310;
			const atm = (scaleH) => ({ ...UNLIMITED_ATM, ATM_SCALE_HEIGHT: scaleH });
			const A_180 = Math.sqrt(1.4 * 287.05 * 180);

			it('precondition: H = 1e-310 m makes the lapse term overflow while the tropopause stays positive', () => {
				assert.ok(H / 8500 > 0, 'scaleRatio is a positive subnormal');
				assert.equal(0.0065 / (H / 8500), Infinity, 'lapse rate overflows');
				assert.ok(11000 * (H / 8500) >= 1.2e-310, 'tropopause above the probed altitudes');
				assert.ok(1.3e-310 > 11000 * (H / 8500), '1.3e-310 m lies above the tropopause');
			});

			it('0 < h <= tropopause: raw -Infinity is clamped to 180 K; speed of sound sqrt(1.4 * 287.05 * 180) = 268.95 m/s', () => {
				for (const h of [Number.MIN_VALUE, 1e-310, 1.2e-310]) {
					assert.equal(AeroUtils.getAtmosphericTemperatureK(h, atm(H)), 180, `h ${h}`);
					assert.equal(designTemperatureK(h, H), 180, `oracle h ${h}`);
					assert.equal(AeroUtils.getSpeedOfSound(h, atm(H)), A_180, `a at h ${h}`);
					assert.equal(AeroUtils.computeMach(300, h, atm(H)), 300 / A_180, `Mach at h ${h}`);
				}
				assertNear(A_180, 268.9546430162529, 1e-12, 'literal speed of sound at 180 K');
				assertNear(300 / A_180, 1.1154297119974652, 1e-12, 'literal Mach of 300 m/s at 180 K');
			});

			it('above that tropopause the stratospheric branch applies (>= 216.65 K, upper clamp 350 K)', () => {
				const justAbove = AeroUtils.getAtmosphericTemperatureK(1.3e-310, atm(H));
				assertNear(justAbove, designTemperatureK(1.3e-310, H), 1e-9, 'oracle just above the tropopause');
				assert.ok(justAbove >= 216.65 && justAbove < 217, `just above the tropopause: ${justAbove}`);
				assert.equal(AeroUtils.getAtmosphericTemperatureK(1e-300, atm(H)), 350);
				assert.equal(AeroUtils.getAtmosphericTemperatureK(1, atm(H)), 350);
			});

			it('h <= 0 gives NaN temperature (Infinity * 0) but speed of sound and Mach 0', () => {
				for (const h of [0, -0, -1, -1e9]) {
					assert.ok(Number.isNaN(AeroUtils.getAtmosphericTemperatureK(h, atm(H))), `T at h ${h}`);
					assert.ok(Number.isNaN(designTemperatureK(h, H)), `oracle T at h ${h}`);
					assert.equal(AeroUtils.getSpeedOfSound(h, atm(H)), 0, `a at h ${h}`);
					assert.equal(AeroUtils.computeMach(300, h, atm(H)), 0, `Mach at h ${h}`);
				}
			});

			it('overflow boundary: the clamp engages on the last overflowing H, not on the next double up', () => {
				const over = 3.073383267063258e-307;
				const finite = 3.0733832670632585e-307;
				assert.equal(0.0065 / (over / 8500), Infinity, 'precondition: overflow');
				assert.ok(Number.isFinite(0.0065 / (finite / 8500)), 'precondition: finite lapse rate');
				assert.equal(AeroUtils.getAtmosphericTemperatureK(1e-308, atm(over)), 180);
				const t = AeroUtils.getAtmosphericTemperatureK(1e-308, atm(finite));
				assertNear(t, designTemperatureK(1e-308, finite), 1e-9, 'finite-lapse oracle');
				assert.ok(t > 216.65 && t < 288.15, `finite lapse: troposphere value ${t}`);
				assertNear(AeroUtils.getAtmosphericTemperatureK(0, atm(finite)), 288.15, 1e-12, 'no NaN at h = 0 with a finite lapse rate');
			});

			it('scaleRatio underflowing to 0 (H = 5e-324): tropopause 0, so h > 0 is clamped to 350 K and only h = 0 is NaN', () => {
				assert.equal(Number.MIN_VALUE / 8500, 0, 'precondition: scaleRatio underflows');
				for (const h of [Number.MIN_VALUE, 1, 1e5]) {
					assert.equal(AeroUtils.getAtmosphericTemperatureK(h, atm(Number.MIN_VALUE)), 350, `h ${h}`);
				}
				assert.ok(Number.isNaN(AeroUtils.getAtmosphericTemperatureK(0, atm(Number.MIN_VALUE))));
				assert.equal(AeroUtils.getSpeedOfSound(0, atm(Number.MIN_VALUE)), 0);
			});

			it('NaN appears only at h <= 0 and only when the lapse term overflows', () => {
				for (const scaleH of [Number.MIN_VALUE, 1e-320, 1e-310, 3e-307, 1e-300, 1, 8500, 1e7]) {
					const overflow = 0.0065 / (scaleH / 8500) === Infinity;
					for (const h of [Number.MIN_VALUE, 1e-310, 1e-300, 1, 1e5, 1e9]) {
						assert.ok(!Number.isNaN(AeroUtils.getAtmosphericTemperatureK(h, atm(scaleH))), `H ${scaleH}, h ${h}`);
					}
					for (const h of [0, -1]) {
						assert.equal(Number.isNaN(AeroUtils.getAtmosphericTemperatureK(h, atm(scaleH))), overflow, `H ${scaleH}, h ${h}`);
					}
				}
			});
		});

		it('returns 0 above the atmosphere limit, for invalid altitudes and without an atmosphere', () => {
			assert.equal(T(100000.001), 0);
			assert.equal(T(NaN), 0);
			assert.equal(T(Infinity), 0);
			assert.equal(T(-Infinity), 0);
			assert.equal(T(undefined), 0);
			assert.equal(T('1000'), 0);
			assert.equal(T(0, null), 0);
			assert.equal(AeroUtils.getAtmosphericTemperatureK(0, undefined), 0);
			assert.equal(AeroUtils.getAtmosphericTemperatureK(0), 0);
			assert.equal(T(0, {}), 0);
			assert.equal(T(0, { ATM_DENSITY_0: 0, ATM_SCALE_HEIGHT: 8500 }), 0);
			assert.equal(T(0, { ATM_DENSITY_0: -1, ATM_SCALE_HEIGHT: 8500 }), 0);
			assert.equal(T(0, { ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 0 }), 0);
			assert.equal(T(0, { ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: -8500 }), 0);
			assert.equal(T(0, { ATM_DENSITY_0: 'abc', ATM_SCALE_HEIGHT: 8500 }), 0);
		});

		it('accepts the lower-case preset keys and numeric strings (Number() reading)', () => {
			const lower = { atmDensity0: 1.225, atmScaleHeight: 8500, atmLimitAlt: 100000 };
			assertNear(T(5000, lower), 255.65, 1e-9, 'lower-case keys');
			assert.equal(T(100001, lower), 0, 'lower-case limit honoured');
			const strings = { atmDensity0: '1.225', atmScaleHeight: '8500', atmLimitAlt: '100000' };
			assertNear(T(5000, strings), 255.65, 1e-9, 'numeric strings');
			assertNear(T(5000, EARTH_PARAM), 255.65, 1e-9, 'normalized Earth preset');
			assert.equal(T(100001, EARTH_PARAM), 0, 'Earth preset limit');
		});
	});

	describe('getSpeedOfSound', () => {
		it('a = sqrt(1.4 * 287.05 * T)', () => {
			assertNear(AeroUtils.getSpeedOfSound(0, EARTH_ATM), designSpeedOfSound(288.15), 1e-12, 'sea level');
			assertNear(AeroUtils.getSpeedOfSound(0, EARTH_ATM), 340.2922868652770, 1e-9, 'sea level literal');
			assertNear(AeroUtils.getSpeedOfSound(11000, EARTH_ATM), designSpeedOfSound(216.65), 1e-9, 'tropopause');
			assertNear(AeroUtils.getSpeedOfSound(200000, UNLIMITED_ATM), designSpeedOfSound(350), 1e-12, 'upper clamp');
		});

		it('0 without an atmosphere, above the limit or with an invalid altitude', () => {
			assert.equal(AeroUtils.getSpeedOfSound(0, null), 0);
			assert.equal(AeroUtils.getSpeedOfSound(100000.001, EARTH_ATM), 0);
			assert.equal(AeroUtils.getSpeedOfSound(NaN, EARTH_ATM), 0);
		});
	});

	describe('computeMach', () => {
		it('Mach = airspeed / a(h)', () => {
			assertNear(AeroUtils.computeMach(designSpeedOfSound(288.15), 0, EARTH_ATM), 1.0, 1e-12, 'Mach 1 at sea level');
			assertNear(AeroUtils.computeMach(designSpeedOfSound(216.65), 11000, EARTH_ATM), 1.0, 1e-9, 'Mach 1 at the tropopause');
			assertNear(AeroUtils.computeMach(1000, 5000, EARTH_ATM), 1000 / designSpeedOfSound(255.65), 1e-9, '1 km/s at 5 km');
			assert.ok(AeroUtils.computeMach(1e-12, 0, EARTH_ATM) > 0, 'tiny positive airspeed');
		});

		it('invalid airspeed -> 0', () => {
			for (const v of [0, -1, -Infinity, Infinity, NaN, undefined, null, '300']) {
				assert.equal(AeroUtils.computeMach(v, 0, EARTH_ATM), 0, `airspeed ${String(v)}`);
			}
		});

		it('no atmosphere -> 0', () => {
			assert.equal(AeroUtils.computeMach(500, 0, null), 0);
			assert.equal(AeroUtils.computeMach(500, 0, { atmDensity0: 0, atmScaleHeight: 0 }), 0);
			assert.equal(AeroUtils.computeMach(500, 0, presetManager.getObjectParam('Moon')), 0);
		});

		it('above the atmosphere limit -> 0; at the limit it is still defined', () => {
			assert.ok(AeroUtils.computeMach(500, 100000, EARTH_ATM) > 0);
			assert.equal(AeroUtils.computeMach(500, 100000.0001, EARTH_ATM), 0);
			assert.equal(AeroUtils.computeMach(500, Infinity, EARTH_ATM), 0);
			assert.equal(AeroUtils.computeMach(500, NaN, EARTH_ATM), 0);
		});
	});
});

describe('Unit 08-9: AeroUtils.computeVaporConeParams (§4.4 asymmetric smoothstep)', () => {
	const V = (mach, pres = 1.0) => AeroUtils.computeVaporConeParams(mach, pres);

	it('the §4.4 boundary table', () => {
		assert.deepEqual(V(0.8199), { active: false, intensity: 0, machAngleRad: Math.PI / 2 });
		const at082 = V(0.82);
		assert.equal(at082.intensity, 0);
		assert.equal(at082.active, false);
		assertNear(V(0.91).intensity, 0.5, 1e-12, 'Mach 0.91');
		assert.equal(V(0.91).active, true);
		assert.equal(V(1.0).intensity, 1);
		assert.equal(V(1.0).active, true);
		assertNear(V(1.11).intensity, 0.5, 1e-12, 'Mach 1.11');
		assert.equal(V(1.22).intensity, 0);
		assert.equal(V(1.22).active, false);
		assert.deepEqual(V(1.2201), { active: false, intensity: 0, machAngleRad: Math.PI / 2 });
	});

	it('uses different spans below (0.18) and above (0.22) the peak', () => {
		assertNear(V(0.91).intensity, smoothstep(0.5), 1e-12, '0.91');
		assertNear(V(1.09).intensity, smoothstep(1 - 0.09 / 0.22), 1e-12, '1.09');
		assert.ok(V(1.09).intensity > V(0.91).intensity, 'the wider supersonic span decays more slowly');
	});

	it('rises monotonically to the peak and falls monotonically after it; continuous at both ends', () => {
		let prev = -1;
		for (let mach = 0.82; mach <= 1.0 + 1e-12; mach += 0.005) {
			const I = V(mach).intensity;
			assert.ok(I >= prev, `rising at ${mach}`);
			prev = I;
		}
		prev = 2;
		for (let mach = 1.0; mach <= 1.22; mach += 0.005) {
			const I = V(mach).intensity;
			assert.ok(I <= prev, `falling at ${mach}`);
			prev = I;
		}
		assert.ok(V(0.82 + 1e-6).intensity < 1e-9);
		assert.ok(V(1.22 - 1e-6).intensity < 1e-9);
	});

	it('pressure factor: 0 at or below 0.015, linear over 0.25, saturates at 1', () => {
		assert.deepEqual(V(1.0, 0.015), { active: false, intensity: 0, machAngleRad: Math.PI / 2 });
		const faint = V(1.0, 0.015 + 1e-9);
		assert.ok(faint.intensity > 0 && faint.intensity < 1e-8);
		assert.equal(faint.active, false, 'active only when intensity > 0.01');
		assert.equal(V(1.0, 0.0174).active, false);
		assert.equal(V(1.0, 0.0176).active, true);
		assertNear(V(1.0, 0.14).intensity, 0.5, 1e-12, 'half pressure factor');
		assert.equal(V(1.0, 0.265).intensity, 1);
		assert.equal(V(1.0, 0.5).intensity, 1);
		assert.equal(V(1.0, 1.0).intensity, 1);
		assertNear(V(0.91, 0.14).intensity, 0.25, 1e-12, 'product of both factors');
	});

	it('Mach angle: capped at asin(0.96) up to Mach 1/0.96, then asin(1/M)', () => {
		assertNear(D_MACH_ANGLE_CAP * 180 / Math.PI, 73.74, 0.005, 'cap in degrees');
		for (const mach of [0.82, 0.9, 1.0, 1.04, 1 / 0.96]) {
			assertNear(V(mach).machAngleRad, D_MACH_ANGLE_CAP, 1e-12, `capped at ${mach}`);
		}
		assertNear(V(1.05).machAngleRad, Math.asin(1 / 1.05), 1e-12, '1.05');
		assertNear(V(1.2).machAngleRad, Math.asin(1 / 1.2), 1e-12, '1.2');
		assertNear(V(1.22).machAngleRad, Math.asin(1 / 1.22), 1e-12, '1.22');
		for (let mach = 0.82; mach <= 1.22; mach += 0.01) {
			assert.ok(V(mach).machAngleRad <= D_MACH_ANGLE_CAP + 1e-15, `never above the cap at ${mach}`);
		}
	});

	it('invalid inputs are inactive', () => {
		for (const [m, p] of [[NaN, 1], [Infinity, 1], [-Infinity, 1], [-1, 1], [0, 1], [undefined, 1], [1, NaN], [1, Infinity], [1, -1], [1, undefined]]) {
			assert.deepEqual(AeroUtils.computeVaporConeParams(m, p), { active: false, intensity: 0, machAngleRad: Math.PI / 2 }, `mach ${m}, pres ${p}`);
		}
		assert.deepEqual(AeroUtils.computeVaporConeParams(), { active: false, intensity: 0, machAngleRad: Math.PI / 2 }, 'no arguments');
		assert.deepEqual(AeroUtils.computeVaporConeParams(1.0, '1.0'), { active: false, intensity: 0, machAngleRad: Math.PI / 2 }, 'string pressure');
	});

	it('matches the design oracle on a dense grid', () => {
		for (let mach = 0.80; mach <= 1.24; mach += 0.0037) {
			for (const pres of [0.01, 0.02, 0.1, 0.2, 0.3, 1]) {
				const got = V(mach, pres);
				const exp = designVapor(mach, pres);
				assert.equal(got.active, exp.active, `active ${mach}/${pres}`);
				assertNear(got.intensity, exp.intensity, 1e-12, `intensity ${mach}/${pres}`);
				assertNear(got.machAngleRad, exp.machAngleRad, 1e-12, `angle ${mach}/${pres}`);
			}
		}
	});
});

/*******************************************************************
 * 6. Mach zero-clear
 *******************************************************************/
describe('Unit 08-10: Mach zero-clear (applyAerodynamics / clearAerodynamicParameters)', () => {
	const R_EARTH = 6378000;
	const ROTATING = { ...EARTH_ATM, ROTATION_PERIOD: 86164 };

	it('base applyAerodynamics: zero relative velocity (non-rotating host) clears a stale Mach and applies no drag', () => {
		const ref = new CalcCelestialBody(1, 'Earth', 0, 0, 120, -40, 0, 0, R_EARTH, 0, 5.972e21);
		const deb = new CalcDebris(2, 'Probe', 0, R_EARTH + 1000, 120, -40, 0, 0, 1, 1, 1.0);
		deb.mach = 4.2;
		deb.applyAerodynamics(ref, EARTH_ATM, 1000);
		assert.equal(deb.mach, 0);
		assert.equal(deb.ax, 0);
		assert.equal(deb.ay, 0);
		assert.equal(deb.inAtmosphere, true);
		assertNear(deb.ambientPresRatio, Math.exp(-1000 / 8500), 1e-15, 'pressure ratio still updated');
	});

	it('base applyAerodynamics: exact co-rotation with a rotating atmosphere also gives Mach 0', () => {
		const ref = new CalcCelestialBody(1, 'Earth', 10, 20, 5, 6, 0, 0, R_EARTH, 0, 5.972e21);
		const deb = new CalcDebris(2, 'Probe', 10, 20 + R_EARTH + 2000, 0, 0, 0, 0, 1, 1, 1.0);
		const omega = (2 * Math.PI) / ROTATING.ROTATION_PERIOD;
		deb.vx = ref.vx + (-omega * (deb.y - ref.y));
		deb.vy = ref.vy + omega * (deb.x - ref.x);
		deb.mach = 2.0;
		deb.applyAerodynamics(ref, ROTATING, 2000);
		assert.equal(deb.mach, 0);
	});

	it('non-zero airspeed gives the design Mach, and returning to zero airspeed clears it again', () => {
		const ref = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, R_EARTH, 0, 5.972e21);
		const deb = new CalcDebris(2, 'Probe', 0, R_EARTH, 2 * designSpeedOfSound(288.15), 0, 0, 0, 1, 1, 1.0);
		deb.applyAerodynamics(ref, EARTH_ATM, 0);
		assertNear(deb.mach, 2.0, 1e-12, 'Mach 2 at sea level');
		deb.vx = 0;
		deb.applyAerodynamics(ref, EARTH_ATM, 0);
		assert.equal(deb.mach, 0);
	});

	it('CalcRocket (inherited applyAerodynamics): Mach at 5 km and zero at zero airspeed', () => {
		const ref = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, R_EARTH, 0, 5.972e21);
		const rocket = makeCalcRocket();
		rocket.x = 0; rocket.y = R_EARTH + 5000; rocket.vx = 300; rocket.vy = 0;
		rocket.applyAerodynamics(ref, EARTH_ATM, 5000);
		assertNear(rocket.mach, 300 / designSpeedOfSound(255.65), 1e-12, 'Mach at 5 km');
		rocket.vx = 0;
		rocket.applyAerodynamics(ref, EARTH_ATM, 5000);
		assert.equal(rocket.mach, 0);
	});

	it('base clearAerodynamicParameters (debris and celestial) zeroes Mach and the aero state', () => {
		for (const obj of [new CalcDebris(2, 'Probe', 0, 0, 0, 0, 0, 0, 1, 1, 1.0), new CalcCelestialBody(3, 'Rock', 0, 0, 0, 0, 0, 0, 10, 0, 1)]) {
			obj.inAtmosphere = true; obj.ambientPresRatio = 0.5; obj._currentQ = 1000; obj.mach = 3;
			obj.clearAerodynamicParameters();
			assert.equal(obj.mach, 0);
			assert.equal(obj.inAtmosphere, false);
			assert.equal(obj.ambientPresRatio, 0);
			assert.equal(obj._currentQ, 0);
		}
	});

	it('CalcRocket.clearAerodynamicParameters zeroes Mach and the axial / lateral q', () => {
		const rocket = makeCalcRocket();
		rocket.inAtmosphere = true; rocket.ambientPresRatio = 0.4; rocket._currentQ = 30000;
		rocket._qAxialKpa = 10; rocket._qLateralKpa = 2; rocket.mach = 1.5;
		rocket.clearAerodynamicParameters();
		assert.equal(rocket.mach, 0);
		assert.equal(rocket._qAxialKpa, 0);
		assert.equal(rocket._qLateralKpa, 0);
		assert.equal(rocket.inAtmosphere, false);
		assert.equal(rocket.ambientPresRatio, 0);
	});

	it('PhysicsEngine: above ATM_LIMIT_ALT (and with no atmospheric body) the stale Mach is cleared', () => {
		const engine = new PhysicsEngine();
		engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: R_EARTH });
		const inside = engine.addObject({ id: 2, name: 'Probe In', type: OBJECT_TYPES.DEBRIS, x: 0, y: R_EARTH + 50000, vx: 1000, vy: 0, mass: 1, radius: 1 });
		const outside = engine.addObject({ id: 3, name: 'Probe Out', type: OBJECT_TYPES.DEBRIS, x: 0, y: R_EARTH + 100001, vx: 1000, vy: 0, mass: 1, radius: 1 });
		outside.mach = 9;
		engine._calculateForces();
		const omega = (2 * Math.PI) / 86164;
		const vRel = 1000 + omega * (R_EARTH + 50000);
		assertNear(inside.mach, vRel / designSpeedOfSound(designTemperatureK(50000, 8500)), 1e-9, 'Mach inside the atmosphere');
		assert.equal(outside.mach, 0);
		assert.equal(outside.inAtmosphere, false);

		const vacuum = new PhysicsEngine();
		vacuum.addObject({ id: 1, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const probe = vacuum.addObject({ id: 2, name: 'Probe', type: OBJECT_TYPES.DEBRIS, x: 1e9, y: 0, vx: 1000, vy: 0, mass: 1, radius: 1 });
		probe.mach = 5;
		vacuum._calculateForces();
		assert.equal(probe.mach, 0);
	});
});

/*******************************************************************
 * 7. SoundEffects
 *******************************************************************/
describe('Unit 08-11: SoundEffects (Mach source and voice synthesis)', () => {
	beforeEach(() => {
		EventBus.clearAll();
		installAudio();
	});
	afterEach(() => {
		EventBus.clearAll();
	});

	describe('supersonic whine Mach source', () => {
		it('telemetry.mach takes precedence over the velocity-derived Mach', () => {
			const { universe } = makeSoundWorld({}, { mach: 2.0, vV: 600, vH: 800, altM: 5000 });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			const whine = se.voices.supersonicWhine;
			assert.equal(whine.isRunning, true);
			assertNear(whine.osc1.frequency.lastTarget().v, expectedWhineFreq(2.0), 1e-9, 'whine frequency from telemetry.mach');
			assertNear(whine.osc2.frequency.lastTarget().v, expectedWhineFreq(2.0) + whineCfg.detuneHz, 1e-9, 'detuned partner');
			assertNear(whine.filter.frequency.lastTarget().v, expectedWhineFreq(2.0), 1e-9, 'tracking band-pass');
			const progress = (2.0 - 1.0) / 2.5;
			assertNear(whine.gainNode.gain.lastTarget().v, whineCfg.baseGain * progress * Math.min(20 / whineCfg.qRatioNorm, 1.2), 1e-12, 'whine gain');
		});

		it('without telemetry.mach it falls back to computeMach(|v|, altM, dominant-body param)', () => {
			const { universe } = makeSoundWorld({}, { mach: undefined, vV: 600, vH: 800, altM: 5000 });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			const mach = 1000 / designSpeedOfSound(designTemperatureK(5000, 8500));
			assertNear(se.voices.supersonicWhine.osc1.frequency.lastTarget().v, expectedWhineFreq(mach), 1e-9, 'fallback Mach');
		});

		it('non-finite telemetry.mach (NaN / Infinity) also falls back', () => {
			for (const bad of [NaN, Infinity, -Infinity, '2.0', null]) {
				EventBus.clearAll();
				const { universe } = makeSoundWorld({}, { mach: bad, vV: 0, vH: 1.5 * designSpeedOfSound(288.15), altM: 0 });
				const se = startSound(universe);
				se.update(0.016, 0.016);
				assertNear(se.voices.supersonicWhine.osc1.frequency.lastTarget().v, expectedWhineFreq(1.5), 1e-9, `fallback for ${String(bad)}`);
			}
		});

		it('a finite telemetry.mach of 0 is used as is (no whine although the velocity is supersonic)', () => {
			const { universe } = makeSoundWorld({}, { mach: 0, vV: 0, vH: 2000, altM: 0 });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			assert.equal(se.voices.supersonicWhine.isRunning, false);
		});

		it('fallback without a matching dominant body or above the atmosphere gives Mach 0', () => {
			const noBody = makeSoundWorld({ dominantBodyId: -1 }, { mach: undefined, vH: 2000 });
			const a = startSound(noBody.universe);
			a.update(0.016, 0.016);
			assert.equal(a.voices.supersonicWhine.isRunning, false);
			EventBus.clearAll();
			const high = makeSoundWorld({}, { mach: undefined, vH: 2000, altM: 150000 });
			const b = startSound(high.universe);
			b.update(0.016, 0.016);
			assert.equal(b.voices.supersonicWhine.isRunning, false);
		});

		it('gate boundaries: Mach must exceed 1.0, q ratio must exceed 0.03, rocket must be in the atmosphere', () => {
			const run = (rocketOver, tm) => {
				EventBus.clearAll();
				const { universe } = makeSoundWorld(rocketOver, tm);
				const se = startSound(universe);
				se.update(0.016, 0.016);
				return se.voices.supersonicWhine;
			};
			assert.equal(run({}, { mach: 1.0 }).isRunning, false, 'Mach 1.0 is not > 1.0');
			const just = run({}, { mach: 1.0 + 1e-9 });
			assert.equal(just.isRunning, true);
			assertNear(just.osc1.frequency.lastTarget().v, whineCfg.baseFreq, 1e-6, 'starts at the base frequency');
			assertNear(run({}, { mach: 3.5 }).osc1.frequency.lastTarget().v, whineCfg.baseFreq + whineCfg.freqRange, 1e-9, 'Mach 3.5 = full range');
			assertNear(run({}, { mach: 9.0 }).osc1.frequency.lastTarget().v, whineCfg.baseFreq + whineCfg.freqRange, 1e-9, 'progress capped at 1');
			assert.equal(run({}, { mach: 2.0, qAxialKpa: 1.0 }).isRunning, false, 'q ratio 0.0286 <= 0.03');
			assert.equal(run({}, { mach: 2.0, qAxialKpa: 1.1 }).isRunning, true, 'q ratio 0.0314 > 0.03');
			assertNear(run({}, { mach: 3.5, qAxialKpa: 100 }).gainNode.gain.lastTarget().v, whineCfg.baseGain * 1.2, 1e-12, 'q ratio capped at 1.2');
			assert.equal(run({ inAtmosphere: false }, { mach: 2.0 }).isRunning, false, 'vacuum');
		});

		it('the whine stops (after its 120 ms release) when the Mach drops below the gate', (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const { universe, rocket } = makeSoundWorld({}, { mach: 2.0 });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			const whine = se.voices.supersonicWhine;
			const osc1 = whine.osc1;
			const gain = whine.gainNode;
			rocket.telemetry.mach = 0.8;
			se.update(0.016, 0.016);
			assert.equal(gain.gain.lastTarget().v, 0.0001, 'release ramp');
			assert.equal(whine.isRunning, true, 'still releasing');
			t.mock.timers.tick(120);
			assert.equal(whine.isRunning, false);
			assert.equal(osc1.stopCount, 1);
			assert.equal(whine.osc1, null);
		});
	});

	describe('engine roar', () => {
		const roarCfg = SOUND_FX_CONFIG.engineRoar;
		const run = (rocketOver, tm = {}) => {
			const { universe } = makeSoundWorld(rocketOver, { mach: 0, ...tm });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			return se.voices.engineRoar;
		};

		it('in the atmosphere the gain follows the barometric envelope and the low-pass tracks throttle', () => {
			const roar = run({ thrustRatio: 0.5 }, { altM: 18000 });
			assert.equal(roar.isRunning, true);
			const env = roarCfg.vacFloorGain + (1 - roarCfg.vacFloorGain) * Math.exp(-1);
			assertNear(roar.gainNode.gain.lastTarget().v, roarCfg.baseGain * env * 0.5, 1e-12, 'roar gain');
			assertNear(roar.f1.frequency.lastTarget().v, roarCfg.throttleFreqBase + 0.5 * roarCfg.throttleFreqRange, 1e-12, 'roar cutoff');
			assert.equal(roar.f1.type, roarCfg.filter1.type);
			assert.equal(roar.f2.type, roarCfg.filter2.type);
			assert.equal(roar.f2.gain.value, roarCfg.filter2.gain, 'peaking boost applied');
			assert.equal(roar.source.loop, true);
		});

		it('in vacuum only the hull-vibration floor remains', () => {
			const roar = run({ inAtmosphere: false }, { altM: 300000 });
			assertNear(roar.gainNode.gain.lastTarget().v, roarCfg.baseGain * roarCfg.vacFloorGain, 1e-12, 'vacuum floor');
		});

		it('throttle boundary 0.01 and over-unity throttle', () => {
			EventBus.clearAll();
			assert.equal(run({ thrustRatio: 0.01 }).isRunning, false, 'throttle 0.01 is not firing');
			EventBus.clearAll();
			assert.equal(run({ thrustRatio: 0.0101 }).isRunning, true);
			EventBus.clearAll();
			const over = run({ thrustRatio: 1.5 });
			assertNear(over.gainNode.gain.lastTarget().v, roarCfg.baseGain, 1e-12, 'gain uses min(throttle, 1)');
			assertNear(over.f1.frequency.lastTarget().v, roarCfg.throttleFreqBase + 1.5 * roarCfg.throttleFreqRange, 1e-12, 'cutoff uses raw throttle');
			EventBus.clearAll();
			assert.equal(run({ isIgnited: false }).isRunning, false, 'not ignited');
			EventBus.clearAll();
			assert.equal(run({ thrustRatio: 'abc' }).isRunning, false, 'non-numeric throttle');
		});

		it('voices stop when the active rocket is destroyed or disappears', (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const { universe, rocket } = makeSoundWorld({}, { mach: 2.0 });
			const se = startSound(universe);
			se.update(0.016, 0.016);
			assert.equal(se.voices.engineRoar.isRunning, true);
			assert.equal(se.voices.supersonicWhine.isRunning, true);
			// Destroyed as Rocket.setCollided() leaves it (the object stays listed while its trail fades)
			rocket.state = OBJECT_STATE.REMOVED;
			rocket.isDestroyed = true;
			se.update(0.016, 0.016);
			t.mock.timers.tick(120);
			assert.equal(se.voices.engineRoar.isRunning, false);
			assert.equal(se.voices.supersonicWhine.isRunning, false);
			rocket.state = OBJECT_STATE.ACTIVE;
			rocket.isDestroyed = false;
			se.update(0.016, 0.016);
			assert.equal(se.voices.engineRoar.isRunning, true, 'restarts on a live rocket');
			universe.objects.splice(universe.objects.indexOf(rocket), 1);
			se.update(0.016, 0.016);
			t.mock.timers.tick(120);
			assert.equal(se.voices.engineRoar.isRunning, false);
		});
	});

	describe('water deluge', () => {
		const delugeCfg = SOUND_FX_CONFIG.waterDeluge;

		it('triggered by the WATER DELUGE sequencer event, full gain while held down', () => {
			const { universe } = makeSoundWorld({ isHoldDown: true, isIgnited: false });
			const se = startSound(universe);
			EventBus.emit('sequencer-event', 'T-00:10 OTHER EVENT');
			assert.equal(se.isDelugeTriggered, false);
			EventBus.emit('sequencer-event', 'T-00:05 WATER DELUGE ON');
			assert.equal(se.isDelugeTriggered, true);
			se.update(0.016, 0.016);
			const deluge = se.voices.waterDeluge;
			assert.equal(deluge.isRunning, true);
			assertNear(deluge.gainNode.gain.lastTarget().v, delugeCfg.baseGain, 1e-15, 'full deluge gain');
			assert.equal(deluge.f2.gain.value, 0, 'no shelf gain configured -> untouched');
		});

		it('after liftoff the gain fades with the relative altitude and stops at tower clearance', (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const { universe, rocket } = makeSoundWorld({ isHoldDown: true, isIgnited: false });
			const se = startSound(universe);
			EventBus.emit('sequencer-event', 'WATER DELUGE');
			EventBus.emit('liftoff');
			assert.equal(se.isLiftoffOccurred, true);
			rocket.telemetry.relativeAltM = 45;
			se.update(0.016, 0.016);
			assertNear(se.voices.waterDeluge.gainNode.gain.lastTarget().v, delugeCfg.baseGain * 0.5, 1e-15, 'half way to tower clearance');
			rocket.telemetry.relativeAltM = 89.5;
			se.update(0.016, 0.016);
			assert.equal(se.isDelugeTriggered, true, 'distFactor 0.0056 > 0.005 keeps spraying');
			rocket.telemetry.relativeAltM = 89.6;
			se.update(0.016, 0.016);
			assert.equal(se.isDelugeTriggered, false, 'distFactor 0.0044 <= 0.005 ends the deluge');
			t.mock.timers.tick(120);
			assert.equal(se.voices.waterDeluge.isRunning, false);
		});

		it('a released rocket counts as lifted off even without the liftoff event; no rocket counts as held', () => {
			const { universe, rocket } = makeSoundWorld({ isHoldDown: false, isIgnited: false });
			const se = startSound(universe);
			EventBus.emit('sequencer-event', 'WATER DELUGE');
			rocket.telemetry.relativeAltM = 9;
			se.update(0.016, 0.016);
			assertNear(se.voices.waterDeluge.gainNode.gain.lastTarget().v, delugeCfg.baseGain * 0.9, 1e-15, 'fading by altitude');
			universe.objects.splice(universe.objects.indexOf(rocket), 1);
			se.update(0.016, 0.016);
			assertNear(se.voices.waterDeluge.gainNode.gain.lastTarget().v, delugeCfg.baseGain, 1e-15, 'no rocket -> treated as held down');
		});
	});

	describe('audio context lifecycle, events and active-rocket selection', () => {
		it('_initAudio builds the master compressor, a 2 s noise buffer and three voices exactly once', () => {
			const { universe } = makeSoundWorld();
			const se = new SoundEffects(universe);
			assert.equal(se.audioCtx, null);
			se.update(0.016, 0.016);
			assert.equal(RecAudioContext.instances.length, 0, 'update before init is a no-op');
			se._initAudio();
			se._initAudio();
			assert.equal(RecAudioContext.instances.length, 1);
			const comp = se.masterBus;
			assert.equal(comp.threshold.value, -6.0);
			assert.equal(comp.knee.value, 8.0);
			assert.equal(comp.ratio.value, 12.0);
			assert.equal(comp.attack.value, 0.003);
			assert.equal(comp.release.value, 0.15);
			assert.deepEqual(comp.outputs, [se.audioCtx.destination]);
			assert.equal(se.sharedNoiseBuf.length, 2 * se.audioCtx.sampleRate);
			const data = se.sharedNoiseBuf.getChannelData(0);
			for (let i = 0; i < data.length; i++) {
				assert.ok(data[i] >= -1 && data[i] < 1, `noise sample ${i} in [-1, 1)`);
			}
			assert.deepEqual(Object.keys(se.voices).sort(), ['engineRoar', 'supersonicWhine', 'waterDeluge']);
		});

		it('a suspended context is resumed; webkitAudioContext is used as a fallback; no WebAudio -> silent no-op', () => {
			RecAudioContext.initialState = 'suspended';
			const a = new SoundEffects(makeSoundWorld().universe);
			a._initAudio();
			assert.equal(a.audioCtx.resumeCount, 1);
			EventBus.clearAll();
			RecAudioContext.initialState = 'running';
			delete globalThis.window.AudioContext;
			globalThis.window.webkitAudioContext = RecAudioContext;
			const b = new SoundEffects(makeSoundWorld().universe);
			b._initAudio();
			assert.ok(b.audioCtx instanceof RecAudioContext);
			EventBus.clearAll();
			delete globalThis.window.webkitAudioContext;
			const c = new SoundEffects(makeSoundWorld().universe);
			assert.doesNotThrow(() => c._initAudio());
			assert.equal(c.audioCtx, null);
			assert.doesNotThrow(() => c.update(0.016, 0.016));
			globalThis.window.AudioContext = RecAudioContext;
		});

		it('user gestures and sequencer events initialise audio; the update loop is driven by EventBus', () => {
			const { universe } = makeSoundWorld({}, { mach: 2.0 });
			const se = new SoundEffects(universe);
			const gestures = windowListeners.filter(l => l.type === 'click' || l.type === 'touchstart');
			assert.equal(gestures.length, 2);
			for (const g of gestures) assert.deepEqual(g.opts, { once: true });
			gestures[0].fn();
			assert.ok(se.audioCtx, 'click initialises audio');
			for (const evt of ['sequencer-start', 'auto-sequence-start', 'simulation:resume']) {
				EventBus.emit(evt);
			}
			assert.equal(RecAudioContext.instances.length, 1, 'later triggers reuse the same context');
			EventBus.emitUpdate(0.016, 0.016);
			assert.equal(se.voices.supersonicWhine.isRunning, true);
			assert.equal(se.voices.engineRoar.isRunning, true);
		});

		// 'audio:stop-all' had no emitter and its listener was removed; 'rocket:destroyed' (emitted by ObjectManager since
		// design §4.13-28) stops the deluge of the sequence's rocket only (next test)
		for (const evt of ['simulation:reset', 'sequencer-abort']) {
			it(`'${evt}' stops every voice and clears the deluge state`, (t) => {
				t.mock.timers.enable({ apis: ['setTimeout'] });
				const { universe } = makeSoundWorld({ isHoldDown: true }, { mach: 2.0 });
				const se = startSound(universe);
				EventBus.emit('sequencer-event', 'WATER DELUGE');
				se.update(0.016, 0.016);
				assert.ok(se.voices.engineRoar.isRunning && se.voices.waterDeluge.isRunning);
				EventBus.emit(evt);
				assert.equal(se.isDelugeTriggered, false);
				assert.equal(se.isLiftoffOccurred, false);
				t.mock.timers.tick(120);
				for (const v of Object.values(se.voices)) assert.equal(v.isRunning, false);
			});
		}

		it(`'rocket:destroyed' of the sequence's rocket stops the deluge and clears its state; another rocket changes nothing`, (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const { universe, rocket } = makeSoundWorld({ isHoldDown: true }, { mach: 2.0 });
			const se = startSound(universe);
			EventBus.emit('sequencer-event', 'WATER DELUGE');
			se.update(0.016, 0.016);
			assert.ok(se.voices.engineRoar.isRunning && se.voices.waterDeluge.isRunning);
			for (const other of [{ id: 11, type: OBJECT_TYPES.ROCKET }, null, undefined]) {
				EventBus.emit('rocket:destroyed', other);
				assert.equal(se.isDelugeTriggered, true, `${JSON.stringify(other)}: not the sequence's rocket`);
			}
			EventBus.emit('rocket:destroyed', rocket);
			assert.equal(se.isDelugeTriggered, false);
			assert.equal(se.isLiftoffOccurred, false);
			t.mock.timers.tick(120);
			assert.equal(se.voices.waterDeluge.isRunning, false, 'the deluge');
			assert.equal(se.voices.engineRoar.isRunning, true, 'the roar follows update() (this rocket still flies in the fixture)');
		});

		it('_getActiveRocket: sequencer rocket, then camera target, then the first rocket', () => {
			// Flying main-thread rockets (the selection skips destroyed ones, design §4.13-30)
			const r1 = { id: 21, type: OBJECT_TYPES.ROCKET, state: OBJECT_STATE.ACTIVE, isDestroyed: false };
			const r2 = { id: 22, type: OBJECT_TYPES.ROCKET, state: OBJECT_STATE.ACTIVE, isDestroyed: false };
			const body = { id: 1, type: OBJECT_TYPES.CELESTIAL };
			const universe = { objects: [body, r1, r2], LaunchSequencer: { rocketId: 22 }, camera: { trackingTarget: { id: 21 } } };
			const se = new SoundEffects(universe);
			assert.equal(se._getActiveRocket(), r2);
			universe.LaunchSequencer.rocketId = null;
			assert.equal(se._getActiveRocket(), r1, 'camera tracking target');
			universe.camera.trackingTarget = { id: 1 };
			assert.equal(se._getActiveRocket(), r1, 'non-rocket target -> first rocket');
			universe.LaunchSequencer.rocketId = 999;
			assert.equal(se._getActiveRocket(), r1, 'unknown id -> first rocket');
			universe.objects = [body];
			assert.equal(se._getActiveRocket(), null);
			se.universe = null;
			assert.equal(se._getActiveRocket(), null);
		});

		it('voice primitives: idempotent start, no-op setters while stopped, filter-2 frequency, stop errors swallowed', (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const se = startSound(makeSoundWorld().universe);
			const roar = se.voices.engineRoar;
			roar.setGain(1.0);
			roar.setFreq(1, 100);
			assert.equal(roar.gainNode, null, 'nothing allocated before start');
			roar.start(se.sharedNoiseBuf);
			const src = roar.source;
			roar.start(se.sharedNoiseBuf);
			assert.equal(roar.source, src, 'second start is ignored');
			assert.deepEqual(src.startCalls, [0]);
			assert.equal(src.buffer, se.sharedNoiseBuf);
			roar.setFreq(2, 77);
			assert.equal(roar.f2.frequency.lastTarget().v, 77);
			assert.equal(roar.f1.frequency.lastTarget(), null);
			assert.deepEqual(src.outputs, [roar.f1]);
			assert.deepEqual(roar.gainNode.outputs, [se.masterBus]);
			RecAudioContext.throwOnStop = true;
			roar.stop();
			roar.stop();
			assert.doesNotThrow(() => t.mock.timers.tick(120));
			assert.equal(roar.isRunning, false);
			assert.equal(src.stopCount, 1, 'second stop during release is ignored');
			assert.ok(src.disconnectCount >= 1);

			const whine = se.voices.supersonicWhine;
			whine.setGain(0.5);
			whine.setFreq(1000);
			assert.equal(whine.osc1, null);
			whine.start();
			assert.equal(whine.osc1.type, whineCfg.waveform);
			assert.equal(whine.osc1.frequency.value, whineCfg.baseFreq);
			assert.equal(whine.osc2.frequency.value, whineCfg.baseFreq + whineCfg.detuneHz);
			assert.equal(whine.filter.type, whineCfg.filter.type);
			assert.equal(whine.filter.Q.value, whineCfg.filter.q);
			const osc1 = whine.osc1;
			whine.start();
			assert.equal(whine.osc1, osc1);
			whine.stop();
			assert.doesNotThrow(() => t.mock.timers.tick(120));
			assert.equal(whine.isRunning, false);
			assert.equal(osc1.stopCount, 1);
			RecAudioContext.throwOnStop = false;
		});

		it('destroy() stops voices, closes the context once and tolerates a failing close()', () => {
			const se = startSound(makeSoundWorld().universe);
			const ctx = se.audioCtx;
			se.destroy();
			assert.equal(ctx.closeCount, 1);
			assert.equal(se.audioCtx, null);
			assert.doesNotThrow(() => se.destroy(), 'second destroy is harmless');
			EventBus.clearAll();
			const se2 = startSound(makeSoundWorld().universe);
			RecAudioContext.throwOnClose = true;
			assert.doesNotThrow(() => se2.destroy());
			assert.equal(se2.audioCtx, null);
		});
	});
});

/*******************************************************************
 * 12-15. Effects anchored on the drawn geometry (design 2026-11-23)
 *******************************************************************/
const STACK_CONFIGS = Object.freeze([
	{ label: '1-stage', stages: 1, idx: 0 },
	{ label: '2-stage, stage 1', stages: 2, idx: 0 },
	{ label: '2-stage, stage 2', stages: 2, idx: 1 },
	{ label: '3-stage, stage 1', stages: 3, idx: 0 },
	{ label: '3-stage, stage 2', stages: 3, idx: 1 },
	{ label: '3-stage, stage 3', stages: 3, idx: 2 }
]);
const PEAK_VAPOR = Object.freeze({ mach: 1.0, ambientPresRatio: 1.0 });
const GEOMETRY_KEYS = Object.freeze(['boosterLayout', 'boostersAttached', 'fairing', 'fairingConfig', 'payload', 'plume', 'segments', 'state']);

/**
 * The §3.4 anchor table (R = 1, literal): noseShoulder, interstageShoulder, the RCS body and the forward / aft / wall
 * of rcs (stack) or the bus corners (payload alone). Rows with a fairing are checked attached and separated: the
 * nose moves, the RCS does not.
 */
const D_ANCHOR_TABLE = Object.freeze([
	{ label: '1-stage', spec: { stages: 1, idx: 0 }, nose: [1.300, 0.700], noseSep: [2.175, 0.595], inter: null, body: [-1.500, 1.300], rcs: [0.967, -0.488, 0.700] },
	{ label: '2-stage, stage 1', spec: { stages: 2, idx: 0 }, nose: [1.600, 0.650], noseSep: [2.440, 0.5525], inter: [0.400, 0.700], body: [-2.750, 0.050], rcs: [-0.283, -1.738, 0.700] },
	{ label: '2-stage, stage 1, 2 SRBs (H3-22)', spec: { stages: 2, idx: 0, preset: 'h3_22' }, nose: [1.600, 0.650], noseSep: [2.440, 0.5525], inter: [0.400, 0.700], body: [-2.750, 0.050], rcs: [0.012, -0.152, 0.700] },
	{ label: '2-stage, stage 1, 4 SRBs (H3-24)', spec: { stages: 2, idx: 0, preset: 'h3_24' }, nose: [1.600, 0.650], noseSep: [2.440, 0.5525], inter: [0.400, 0.700], body: [-2.750, 0.050], rcs: [0.018, -0.124, 0.700] },
	{ label: '2-stage, stage 2', spec: { stages: 2, idx: 1 }, nose: [0.600, 0.650], noseSep: [1.440, 0.5525], inter: null, body: [-0.600, 0.600], rcs: [0.408, -0.432, 0.650] },
	{ label: '3-stage, stage 1', spec: { stages: 3, idx: 0 }, nose: [2.400, 0.650], noseSep: [3.170, 0.4675], inter: [1.500, 0.650], body: [-3.100, -0.300], rcs: [-0.633, -2.088, 0.700] },
	{ label: '3-stage, stage 2', spec: { stages: 3, idx: 1 }, nose: [0.750, 0.650], noseSep: [1.520, 0.4675], inter: [-0.150, 0.650], body: [-1.600, -0.400], rcs: [-0.592, -1.432, 0.650] },
	{ label: '3-stage, stage 3', spec: { stages: 3, idx: 2 }, nose: [0.000, 0.650], noseSep: [0.770, 0.4675], inter: null, body: [-0.900, 0.000], rcs: [-0.174, -0.779, 0.550] },
	{ label: '3-stage, stage 3, no fairing in the configuration', spec: { stages: 3, idx: 2, fairing: 'none' }, nose: [0.770, 0.4675], inter: null, body: [-0.900, 0.000], rcs: [-0.144, -0.774, 0.550] },
	{ label: 'payload only, 1-stage vehicle', spec: { stages: 1, payloadOnly: true }, nose: [0.490, 0.595], inter: null, corners: [0.490, 0.595] },
	{ label: 'payload only, 2-stage vehicle', spec: { stages: 2, payloadOnly: true }, nose: [0.455, 0.5525], inter: null, corners: [0.455, 0.5525] },
	{ label: 'payload only, 3-stage vehicle', spec: { stages: 3, payloadOnly: true }, nose: [0.385, 0.4675], inter: null, corners: [0.385, 0.4675] }
]);
/** The table rows as concrete specs: the fairing attached and (when the row has one) separated. */
const anchorRowSpecs = (row) => {
	const base = { ...row.spec };
	if (base.preset) {
		base.boosters = presetVehicle(base.preset).boosters;
		delete base.preset;
	}
	if (row.corners || base.fairing === 'none') return [{ spec: base, nose: row.nose }];
	return [{ spec: { ...base, fairing: 'attached' }, nose: row.nose }, { spec: { ...base, fairing: 'separated' }, nose: row.noseSep }];
};

describe('Unit 08-12: RocketRenderer._computeStackGeometry and the drawn hull (design 2026-11-23 §3.2, §3.3, §5.1-3)', () => {
	const BOOSTER_CASES = [
		{ label: 'no SRB', boosters: null },
		{ label: '2 SRBs', boosters: { count: 2, burnTimeSec: 100 } },
		{ label: '4 SRBs (H3-24 dimensions)', boosters: presetVehicle('h3_24').boosters },
		{ label: '3 SRBs (generic tiers)', boosters: { count: 3, burnTimeSec: 100 } }
	];

	/** geometry = the §3.2 oracle (bit-exact); the drawn primitives = the geometry, in draw order (with and without passing it). */
	const checkGeometryAndDrawing = (spec, R, over, extra, msg = `${specLabel(spec)}, R ${R}`) => {
		const rocket = specRocket(spec, over);
		const want = designStack(spec, R, VIS, extra);
		const g = RocketRenderer._computeStackGeometry(rocket, R, VIS);
		assert.deepEqual(Object.keys(g).sort(), GEOMETRY_KEYS, `${msg}: geometry keys`);
		assert.deepEqual(g.state, want.state, `${msg}: state`);
		assert.deepEqual(g.segments, want.segments, `${msg}: segments`);
		assert.deepEqual(g.fairingConfig, want.fairingConfig, `${msg}: fairingConfig`);
		assert.deepEqual(g.fairing, want.fairing, `${msg}: fairing`);
		assert.deepEqual(g.payload, want.payload, `${msg}: payload`);
		assert.deepEqual(g.boosterLayout, want.boosterLayout, `${msg}: boosterLayout`);
		assert.equal(g.boostersAttached, want.boostersAttached, `${msg}: boostersAttached`);
		assert.deepEqual(g.plume, want.plume, `${msg}: plume`);

		// §3.2 structure: nose to tail, the last segment is the current stage, own nozzles, exposed only on the lowest upper stage
		if (!g.state.isPayloadOnly) {
			assert.equal(g.segments[g.segments.length - 1].kind, 'stage', `${msg}: the last segment is a stage`);
			g.segments.forEach((s, i) => {
				if (i > 0) assert.ok(g.segments[i - 1].startX > s.startX, `${msg}: segment ${i} lies aft of segment ${i - 1}`);
				if (i > 0) assert.notEqual(g.segments[i - 1].kind, s.kind, `${msg}: stages and interstages alternate`);
				if (s.kind !== 'stage') return;
				assert.equal(s.isExposedNozzle, i === g.segments.length - 1 && s.stageIndex > 0, `${msg}: isExposedNozzle of stage ${s.stageIndex}`);
				assert.equal(s.hasFins, s.stageIndex === 0, `${msg}: hasFins of stage ${s.stageIndex}`);
			});
			const indices = g.segments.filter(s => s.kind === 'stage').map(s => s.stageIndex);
			assert.deepEqual(indices, indices.slice().sort((a, b) => b - a), `${msg}: structural stage indices, nose first`);
		}

		const throttle = rocket.thrustRatio || 1.0;
		const expected = [];
		if (g.state.isPayloadOnly) {
			expected.push({ kind: 'sat', cx: 0, cy: 0, r: g.payload.r, deployed: true });
		} else {
			expected.push(g.fairing ? { kind: 'fairing', ...g.fairing } : { kind: 'sat', cx: g.payload.cx, cy: 0, r: g.payload.r, deployed: false });
			for (const s of g.segments) {
				if (s.kind === 'interstage') {
					expected.push({ kind: 'interstage', startX: s.startX, radius: s.radius, length: s.length });
				} else if (s.stageIndex === 0) {
					expected.push({ kind: 'stage1', startX: s.startX, radius: s.radius, length: s.length, nozzleX: s.nozzleX, nozzleLen: s.nozzleLength });
					expected.push({ kind: 'boosters', stg1X: s.startX, r1: s.radius, l1: s.length, nozzle1X: s.nozzleX, lNozzle1: s.nozzleLength, isFiring: g.plume.isFiring, throttle, R, amb: 0 });
				} else {
					expected.push({ kind: 'stage2', startX: s.startX, radius: s.radius, length: s.length, isExposedNozzle: s.isExposedNozzle, nozzleX: s.nozzleX, nozzleLen: s.nozzleLength });
				}
			}
		}
		if (g.plume.isFiring) {
			expected.push({ kind: 'plume', x: g.plume.x, y: 0, scale: g.plume.scale, throttle, fuelType: g.plume.fuelType, R, amb: 0 });
		}
		for (const [how, hull] of [['geometry passed', captureHull(rocket, R, { geometry: g })], ['default geometry', captureHull(rocket, R)]]) {
			assert.deepEqual(hull.order.map(e => ({ ...e })), expected, `${msg} (${how}): drawn primitives`);
			const bl = g.boosterLayout;
			for (const b of hull.boosters) {
				const fills = hull.ctx.fills.slice(b.call.fill0, b.call.fill1);
				if (!g.boostersAttached) {
					assert.equal(fills.length, 0, `${msg} (${how}): no SRB drawn`);
					continue;
				}
				const bodies = fills.filter(f => f.path[0].op === 'rect' && f.path[0].w === bl.lB);
				assert.deepEqual(bodies.map(f => [f.path[0].x, f.path[0].y, f.path[0].h]), bl.yPositions.map(y => [bl.xBase, y - bl.rB, bl.rB * 2]), `${msg} (${how}): SRB bodies at the layout`);
			}
			const srbFiring = g.boostersAttached && g.plume.isFiring && Boolean(over.isIgnited) && !over.isHoldDown;
			assert.deepEqual(hull.srbPlumes, srbFiring
				? bl.yPositions.map(y => ({ x: bl.xBase - bl.lNozzleB, y, scale: bl.plumeScale, throttle, fuelType: bl.plumeFuel, R, amb: 0 }))
				: [], `${msg} (${how}): SRB plumes`);
		}
		return g;
	};

	for (const st of STACK_CONFIGS) {
		for (const fairing of ['attached', 'separated', 'none']) {
			it(`${st.label}, fairing ${fairing}: geometry = §3.2 table and drawn hull = geometry (SRB 0 / 2 / 4 / 3, attached / separated, R 7.5 / 40)`, () => {
				for (const bc of BOOSTER_CASES) {
					for (const boosterSeparated of [false, true]) {
						for (const R of [7.5, 40]) {
							const spec = { stages: st.stages, idx: st.idx, fairing, boosters: bc.boosters, boosterSeparated };
							const g = checkGeometryAndDrawing(spec, R, FIRING, { firing: true });
							if (fairing === 'none') {
								assert.equal(g.fairingConfig, null, 'no fairing in the configuration');
								assert.equal(g.fairing, null);
								assert.ok(g.payload && g.payload.isDeployed === false, 'stowed payload on the nose');
							} else {
								assert.ok(g.fairingConfig, 'fairingConfig kept from the configuration');
								assert.equal(g.fairing === null, fairing === 'separated', 'fairing only while attached');
								if (g.fairing) assert.deepEqual(g.fairing, g.fairingConfig);
								assert.equal(g.payload === null, fairing === 'attached', 'payload drawn only without the fairing');
							}
							const hasStage1 = g.segments.some(s => s.kind === 'stage' && s.stageIndex === 0);
							assert.equal(Boolean(g.boosterLayout), hasStage1 && bc.boosters !== null, `${bc.label}: SRB layout only beside stage 1, kept after the separation`);
							assert.equal(g.boostersAttached, Boolean(g.boosterLayout) && !boosterSeparated, `${bc.label}: boostersAttached`);
							if (g.boosterLayout) assert.equal(g.boosterLayout.yPositions.length, designBoosterCount(bc.boosters));
						}
					}
				}
			});
		}
	}

	it('R = 1 positions equal the §1.2 table: nozzle end, lowest body start and nose (all stages attached to the current one)', () => {
		const rows = [[1, 0, -1.850, -1.500, 2.400], [2, 0, -3.100, -2.750, 2.700], [2, 1, -0.920, -0.600, 1.700],
			[3, 0, -3.450, -3.100, 3.500], [3, 1, -1.920, -1.600, 1.850], [3, 2, -1.180, -0.900, 1.100]];
		for (const [n, idx, nozzleEnd, bodyStart, nose] of rows) {
			const g = RocketRenderer._computeStackGeometry(specRocket({ stages: n, idx }), 1, VIS);
			const cur = g.segments[g.segments.length - 1];
			assertNear(cur.nozzleX, nozzleEnd, 1e-12, `${n}-stage, stage ${idx + 1}: nozzle end`);
			assertNear(g.plume.x, nozzleEnd, 1e-12, `${n}-stage, stage ${idx + 1}: plume origin`);
			assertNear(cur.startX, bodyStart, 1e-12, `${n}-stage, stage ${idx + 1}: lowest body start`);
			assertNear(g.fairing.startX + g.fairing.length, nose, 1e-12, `${n}-stage, stage ${idx + 1}: nose`);
		}
	});

	it('plume: scale per stage (MAIN / UPPER / STAGE3), fuel of the current stage, isFiring by the engine rule', () => {
		const al = VIS.ALIGNMENT;
		const scales = [[1, 0, al.MAIN_PLUME_SCALE], [2, 0, al.MAIN_PLUME_SCALE], [2, 1, al.UPPER_PLUME_SCALE], [3, 0, al.MAIN_PLUME_SCALE], [3, 1, al.UPPER_PLUME_SCALE], [3, 2, al.STAGE3_PLUME_SCALE]];
		for (const [n, idx, scale] of scales) {
			const g = RocketRenderer._computeStackGeometry(specRocket({ stages: n, idx }, FIRING), 40, VIS);
			assert.equal(g.plume.scale, scale, `${n}-stage, stage ${idx + 1}`);
			assert.equal(g.plume.fuelType, STAGE_FUELS[idx]);
		}
		// fuel: the stage's, else rocket.fuelType, else liquid
		assert.equal(RocketRenderer._computeStackGeometry(renderRocket({ stages: [{}, {}], fuelType: 'solid' }), 40, VIS).plume.fuelType, 'solid');
		assert.equal(RocketRenderer._computeStackGeometry(renderRocket({ stages: [{}, {}] }), 40, VIS).plume.fuelType, 'liquid');
		// isFiring: ignited, burn time left and a throttle (or TWR) above the threshold 0.01
		const firing = (over) => RocketRenderer._computeStackGeometry(renderRocket(over), 40, VIS).plume.isFiring;
		assert.equal(firing(FIRING), true);
		assert.equal(firing({ ...FIRING, isIgnited: false }), false, 'not ignited');
		assert.equal(firing({ ...FIRING, burnTime: 0 }), false, 'no burn time');
		assert.equal(firing({ ...FIRING, thrustRatio: 0.01 }), false, 'throttle exactly at the threshold');
		assert.equal(firing({ ...FIRING, thrustRatio: 0.01 + 1e-12 }), true, 'throttle just above the threshold');
		assert.equal(firing({ ...FIRING, thrustRatio: 0, telemetry: { twr: 0.5 } }), true, 'telemetry TWR above the threshold');
		const quiet = captureHull(renderRocket({ ...FIRING, isIgnited: false }), 40);
		assert.equal(quiet.plumes.length, 0, 'no plume drawn while the engine does not fire');
	});

	for (const [n, idx, like] of [[2, 2, 1], [2, 5, 1], [2, -1, 0], [3, 3, 2], [3, -1, 0], [3, 0.5, 0], [3, 1.5, 1]]) {
		for (const source of ['noStages', 'disableStaging']) {
			it(`stage index ${idx}, out of range or a fraction, on a ${n}-stage vehicle (${source === 'noStages' ? 'no rocket.stages' : 'disableStaging'}): drawn as stage ${like + 1} in flight`, () => {
				const spec = { stages: n, idx, fairing: 'attached', [source]: true };
				const g = checkGeometryAndDrawing(spec, 40, FIRING, { firing: true });
				assert.equal(g.state.isPayloadOnly, false, 'still a stack');
				// Design 2026-11-23 §3.1 (Rev 22): the index is rounded down and clamped to [0, count]; out of the payload
				// phase at most the last stage
				assert.equal(g.state.curStgIdx, like, 'the stage index as normalised');
				assert.deepEqual(g.segments, designStack({ stages: n, idx: like, fairing: 'attached' }, 40).segments, `the segments of stage ${like + 1}`);
				assert.equal(g.plume.fuelType, source === 'noStages' ? 'liquid' : STAGE_FUELS[like], 'the fuel of the stage drawn (the default without stages)');
			});
		}
	}

	for (const n of [1, 2, 3]) {
		it(`payload only, ${n}-stage vehicle: deployed payload of the vehicle's payload radius, no fairing / segments / SRB even when configured, plume behind the bus`, () => {
			for (const fairing of ['attached', 'separated', 'none']) {
				for (const boosters of [null, { count: 2, burnTimeSec: 100 }]) {
					for (const idx of [n, 0]) {
						const spec = { stages: n, idx, payloadOnly: true, fairing, boosters };
						const selfPropelled = { ...FIRING, hasPayloadPropulsion: true, payload: { propulsion: { enabled: true, fuelType: 'hydro' } } };
						const g = checkGeometryAndDrawing(spec, 40, selfPropelled, { payloadFiring: true, payloadFuel: 'hydro' });
						assert.equal(g.state.isPayloadOnly, true);
						assert.equal(g.fairingConfig, null, 'the payload alone has no fairing in its geometry');
						assert.deepEqual(g.segments, []);
						assert.equal(g.boosterLayout, null);
						assert.equal(g.boostersAttached, false);
						checkGeometryAndDrawing(spec, 40, { ...FIRING, payload: { propulsion: { enabled: true } } }, { payloadFiring: true, payloadFuel: 'liquid' });
						checkGeometryAndDrawing(spec, 40, FIRING, { payloadFiring: false }, `${specLabel(spec)}: a passive payload never fires`);
						checkGeometryAndDrawing(spec, 40, { hasPayloadPropulsion: true }, { payloadFiring: false }, `${specLabel(spec)}: engine off`);
					}
				}
			}
		});
	}

	it('disableStaging: always a stack whose fairing is drawn and configured, even when separated, not enabled or payload-separated', () => {
		for (const n of [1, 2, 3]) {
			for (const fairing of ['attached', 'separated', 'none']) {
				const spec = { stages: n, idx: 0, payloadOnly: true, fairing, disableStaging: true };
				const g = checkGeometryAndDrawing(spec, 40, FIRING, { firing: true });
				assert.equal(g.state.isPayloadOnly, false);
				assert.ok(g.fairing, 'fairing drawn');
				assert.deepEqual(g.fairing, g.fairingConfig);
				assert.equal(g.payload, null);
			}
		}
	});

	it('SRB layout follows boosterCount and resolveBoosters: count 0 with a burn time draws 2; rendering / stage-only settings draw none', () => {
		const layoutOf = (over) => RocketRenderer._computeStackGeometry(renderRocket(over), 40, VIS).boosterLayout;
		assert.equal(layoutOf({ boosters: { count: 0, burnTimeSec: 100 } }).count, 2, 'count 0 with a burn time: 2 SRBs');
		assert.equal(layoutOf({ boosters: { burnTimeSec: 100 } }).count, 2, 'no count with a burn time: 2 SRBs');
		assert.equal(layoutOf({ boosters: { count: 0 } }), null, 'count 0 without a burn time');
		assert.equal(layoutOf({ boosters: {} }), null, 'empty configuration');
		assert.equal(layoutOf({ boosters: null, rendering: { boosters: { count: 2 } } }), null, 'rendering.boosters only');
		assert.equal(layoutOf({ boosters: null, stages: [{ boosters: { count: 4 } }, {}] }), null, 'stages[0].boosters only');
		for (const [count, drawn] of [[1, 1], [8, 8], [9, 9], [10, 9], [12, 9], [2.5, 2]]) {
			const l = layoutOf({ boosters: { count } });
			assert.equal(l.count, drawn, `count ${count}`);
			assert.equal(l.yPositions.length, drawn, `count ${count}: positions`);
		}
	});

	it('abnormal: a null / NaN telemetry stage index counts as stage 0; an empty object is a single stage; R = 0 gives a zero-size geometry', () => {
		for (const stageIndex of [null, NaN]) {
			const g = RocketRenderer._computeStackGeometry(renderRocket({ currentStageIndex: 1, telemetry: { stageIndex, totalStages: 2 } }), 40, VIS);
			assert.deepEqual(g.segments, designStack({ stages: 2, idx: 0 }, 40).segments, `telemetry stageIndex ${stageIndex}`);
			assert.equal(g.state.curStgIdx, 0);
		}
		const bare = RocketRenderer._computeStackGeometry({}, 40, VIS);
		const wantBare = designStack({ stages: 1, idx: 0, fairing: 'none' }, 40);
		assert.deepEqual(bare.segments, wantBare.segments);
		assert.deepEqual(bare.payload, wantBare.payload);
		assert.equal(bare.fairingConfig, null);
		assert.deepEqual(bare.plume, { ...wantBare.plume, isFiring: false });
		for (const st of STACK_CONFIGS) {
			const g = RocketRenderer._computeStackGeometry(specRocket(st), 0, VIS);
			assert.deepEqual(g.segments, designStack(st, 0).segments, `${st.label}, R 0`);
			for (const s of g.segments) assert.equal(s.length, 0, 'zero length');
			assert.doesNotThrow(() => captureHull(specRocket(st), 0));
		}
		assert.throws(() => RocketRenderer._computeStackGeometry(null, 40, VIS), TypeError, 'the callers always pass a rocket (§5.1-1)');
	});

	it('boundary: a configuration without the optional ratios falls back to the defaults (equal to the shipped values)', () => {
		const stripped = structuredClone(VIS);
		for (const k of ['STAGE3_RADIUS_RATIO', 'STAGE3_LENGTH_RATIO', 'INTERSTAGE2_LENGTH_RATIO', 'NOZZLE3_LENGTH_RATIO']) delete stripped.MODULES[k];
		for (const k of ['BASE_X_SINGLE_STAGE_RATIO', 'BASE_X_3STG_STAGE1_RATIO', 'BASE_X_3STG_STAGE2_RATIO', 'BASE_X_3STG_STAGE3_RATIO', 'STAGE3_PLUME_SCALE', 'PAYLOAD_PLUME_SCALE']) delete stripped.ALIGNMENT[k];
		for (const spec of [...STACK_CONFIGS, { stages: 3, payloadOnly: true }, { stages: 1, payloadOnly: true }]) {
			const g = RocketRenderer._computeStackGeometry(specRocket(spec), 40, stripped);
			const shipped = RocketRenderer._computeStackGeometry(specRocket(spec), 40, VIS);
			const want = designStack(spec, 40, stripped);
			assert.deepEqual(g.segments, want.segments, `${specLabel(spec)}: defaults`);
			assert.equal(g.plume.scale, want.plume.scale);
			assert.deepEqual(g.payload, want.payload);
			assert.deepEqual(g, shipped, `${specLabel(spec)}: the defaults equal the shipped ratios`);
		}
	});
});

describe('Unit 08-13: effect anchors from the geometry (design 2026-11-23 §3.4, §5.1-4)', () => {
	for (const row of D_ANCHOR_TABLE) {
		it(`§3.4 row: ${row.label}`, () => {
			for (const { spec, nose } of anchorRowSpecs(row)) {
				for (const R of [1, 40]) {
					const msg = `${specLabel(spec)}, R ${R}`;
					const lit = 5e-4 * R + 1e-9; // the table is rounded to the last printed digit
					const tol = 1e-9 * Math.max(1, R);
					const want = designStack(spec, R);
					const layout = RocketRenderer._computeVisualLayout(specRocket(spec), R, VIS);
					assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS, `${msg}: keys`);
					assert.equal(layout.screenRadius, R);
					assertNear(layout.noseShoulder.x, nose[0] * R, lit, `${msg}: noseShoulder.x (table)`);
					assertNear(layout.noseShoulder.halfWidth, nose[1] * R, lit, `${msg}: noseShoulder.halfWidth (table)`);
					assertNear(layout.noseShoulder.x, want.noseShoulder.x, tol, `${msg}: noseShoulder.x (formula)`);
					assertNear(layout.noseShoulder.halfWidth, want.noseShoulder.halfWidth, tol, `${msg}: noseShoulder.halfWidth (formula)`);
					if (row.inter) {
						assertNear(layout.interstageShoulder.x, row.inter[0] * R, lit, `${msg}: interstageShoulder.x (table)`);
						assertNear(layout.interstageShoulder.halfWidth, row.inter[1] * R, lit, `${msg}: interstageShoulder.halfWidth (table)`);
						assertNear(layout.interstageShoulder.x, want.interstageShoulder.x, tol, `${msg}: interstageShoulder.x (formula)`);
					} else {
						assert.equal(layout.interstageShoulder, null, `${msg}: no interstage`);
					}
					assertRcsNear(layout.rcs, want.rcs, tol, `${msg}: rcs (formula)`);
					if (row.corners) {
						const [a, b] = row.corners;
						assertNear(layout.rcs.cw[1].x, a * R, lit, `${msg}: corner x (table)`);
						assertNear(layout.rcs.cw[1].y, b * R, lit, `${msg}: corner y (table)`);
						assertNear(layout.rcs.cw[0].x, -a * R, lit, `${msg}: corner -x (table)`);
						assertNear(layout.rcs.cw[0].y, -b * R, lit, `${msg}: corner -y (table)`);
					} else {
						const g = RocketRenderer._computeStackGeometry(specRocket(spec), R, VIS);
						const cur = g.segments[g.segments.length - 1];
						assertNear(cur.startX, row.body[0] * R, lit, `${msg}: RCS body start (table)`);
						assertNear(cur.startX + cur.length, row.body[1] * R, lit, `${msg}: RCS body end (table)`);
						const [fwd, aft, wall] = row.rcs;
						assertNear(layout.rcs.cw[0].x, fwd * R, lit, `${msg}: forward nozzle (table)`);
						assertNear(layout.rcs.cw[1].x, aft * R, lit, `${msg}: aft nozzle (table)`);
						assertNear(layout.rcs.cw[1].y, wall * R, lit, `${msg}: wall (table)`);
					}
				}
			}
		});
	}

	it('noseShoulder = the drawn fairing base or bus front; interstageShoulder = the stage drawn just before the uppermost interstage', () => {
		const specs = [];
		for (const st of STACK_CONFIGS) for (const fairing of ['attached', 'separated', 'none']) specs.push({ ...st, fairing });
		for (const n of [1, 2, 3]) specs.push({ stages: n, payloadOnly: true });
		for (const spec of specs) {
			for (const R of [4, 12.5, 40]) {
				const msg = `${specLabel(spec)}, R ${R}`;
				const rocket = specRocket(spec);
				const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
				const hull = captureHull(rocket, R);
				if (hull.fairings.length > 0) {
					assert.equal(layout.noseShoulder.x, hull.fairings[0].startX, `${msg}: drawn fairing base`);
					assert.equal(layout.noseShoulder.halfWidth, hull.fairings[0].radius, `${msg}: drawn fairing radius`);
				} else {
					assert.equal(hull.sats.length, 1, `${msg}: one payload drawn`);
					const s = hull.sats[0];
					assertNear(layout.noseShoulder.x, s.cx + 0.5 * s.r * M.SATELLITE_BUS_W_RATIO, 1e-12 * R, `${msg}: drawn bus front`);
					assertNear(layout.noseShoulder.halfWidth, 0.5 * s.r * M.SATELLITE_BUS_H_RATIO, 1e-12 * R, `${msg}: drawn bus half-height`);
					// the bus front as drawn: the right edge of the first (bus) rect of the satellite
					const bus = hull.ctx.fills[s.call.fill0].path[0];
					assertNear(layout.noseShoulder.x, bus.x + bus.w, 1e-12 * R, `${msg}: drawn bus rect right edge`);
					assertNear(layout.noseShoulder.halfWidth, bus.h / 2, 1e-12 * R, `${msg}: drawn bus rect half-height`);
				}
				const body = hull.order.filter(e => e.kind !== 'fairing' && e.kind !== 'sat' && e.kind !== 'boosters' && e.kind !== 'plume');
				const iInter = body.findIndex(e => e.kind === 'interstage');
				if (iInter < 0) {
					assert.equal(layout.interstageShoulder, null, `${msg}: no interstage drawn`);
				} else {
					assert.equal(layout.interstageShoulder.x, body[iInter - 1].startX, `${msg}: startX of the stage above the drawn interstage`);
					assert.equal(layout.interstageShoulder.halfWidth, body[iInter].radius, `${msg}: drawn interstage radius`);
					assertNear(body[iInter].startX + body[iInter].length, layout.interstageShoulder.x, 1e-12 * R, `${msg}: the interstage's forward edge`);
				}
			}
		}
	});

	it('the layout keys are exactly screenRadius, noseShoulder, interstageShoulder, rcs; _computeVisualLayout = _layoutFromGeometry(_computeStackGeometry)', () => {
		const specs = [...STACK_CONFIGS, { stages: 2, payloadOnly: true }, { stages: 2, idx: 0, boosters: presetVehicle('h3_24').boosters }];
		for (const spec of specs) {
			for (const R of [0, 4, 40]) {
				const rocket = specRocket(spec);
				const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
				assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS, `${specLabel(spec)}, R ${R}`);
				for (const gone of ['xMin', 'xMax', 'halfWidth']) assert.equal(gone in layout, false, `${gone} is gone`);
				assert.deepEqual(layout, RocketRenderer._layoutFromGeometry(RocketRenderer._computeStackGeometry(rocket, R, VIS), R, VIS));
				assert.deepEqual(Object.keys(layout.noseShoulder).sort(), ['halfWidth', 'x']);
			}
		}
	});

	it('abnormal / boundary R: R = 0, NaN and negative leave no stack wall (rcs null); the payload alone keeps degenerate corners', () => {
		for (const st of STACK_CONFIGS) {
			for (const R of [0, NaN, -10]) {
				const layout = RocketRenderer._computeVisualLayout(specRocket(st), R, VIS);
				assert.equal(layout.rcs, null, `${st.label}, R ${R}: no wall of positive length (G2-1-01)`);
				assert.deepEqual(Object.keys(layout).sort(), LAYOUT_KEYS);
			}
		}
		for (const n of [1, 2, 3]) {
			const zero = RocketRenderer._computeVisualLayout(specRocket({ stages: n, payloadOnly: true }), 0, VIS).rcs;
			assertRcsNear(zero, designPayloadNozzles({ a: 0, b: 0, plumeLen: D_COLD_GAS.MIN_PLUME_PX }), 0, `${n}-stage payload, R 0: corners at the origin`);
			const nan = RocketRenderer._computeVisualLayout(specRocket({ stages: n, payloadOnly: true }), NaN, VIS).rcs;
			assert.ok(Number.isNaN(nan.plumeLen), 'NaN plume length');
			for (const nz of [...nan.cw, ...nan.ccw, ...nan.ullage]) {
				assert.ok(Number.isNaN(nz.x) && Number.isNaN(nz.y), `${n}-stage payload, R NaN: NaN corners`);
			}
		}
	});
});

describe('Unit 08-14: vapor cone at the effect anchors (design 2026-11-23 §3.5, §1.5, §5.1-5)', () => {
	const PEAK = PEAK_VAPOR;
	const conesOf = (spec, R, over = PEAK) => {
		const rec = recordDraw(specRocket(spec, over), R);
		return { rec, cones: extractCones(rec.ctx), rims: extractRims(rec.ctx) };
	};

	it('peak, every configuration: the primary on noseShoulder, the secondary on interstageShoulder, sizes from each vertex radius', () => {
		const specs = [];
		for (const st of STACK_CONFIGS) for (const fairing of ['attached', 'separated', 'none']) specs.push({ ...st, fairing });
		for (const n of [1, 2, 3]) specs.push({ stages: n, payloadOnly: true });
		for (const spec of specs) {
			for (const R of [4, 40]) {
				const want = designStack(spec, R);
				const { cones, rims } = conesOf(spec, R);
				assert.equal(cones.length, want.interstageShoulder ? 2 : 1, `${specLabel(spec)}, R ${R}: cone count`);
				assertConeAt(cones[0], want.noseShoulder, 1.0, D_MACH_ANGLE_CAP, 1.0);
				assertRimAt(rims[0], want.noseShoulder, cones[0], 1.0, 1.0);
				if (want.interstageShoulder) {
					assertConeAt(cones[1], want.interstageShoulder, 1.0, D_MACH_ANGLE_CAP, 0.78);
					assertRimAt(rims[1], want.interstageShoulder, cones[1], 1.0, 0.78);
				}
			}
		}
	});

	it('§1.5 cloud table (R = 40, fairing attached, peak): vertex -> back end and the station where the cloud leaves the drawn body', () => {
		// [stages, idx, primary [vertex, back, exterior], secondary [vertex, back, exterior] | null], R = 1 units
		const rows = [
			[1, 0, [1.300, -0.625, 0.916], null],
			[2, 0, [1.600, -0.188, 1.244], [0.400, -1.102, -0.036]],
			[2, 1, [0.600, -1.188, 0.244], null],
			[3, 0, [2.400, 0.612, 2.119], [1.500, 0.106, 1.095]],
			[3, 1, [0.750, -1.038, 0.469], [-0.150, -1.544, -0.555]],
			[3, 2, [0.000, -1.788, -0.281], null]
		];
		const R = 40;
		const lit = (5e-4 + 1e-9) * R;
		for (const [n, idx, primary, secondary] of rows) {
			const { rec, cones } = conesOf({ stages: n, idx }, R);
			const silhouette = drawnSilhouette({ ...rec.hull, ctx: rec.ctx });
			const expected = secondary ? [primary, secondary] : [primary];
			assert.equal(cones.length, expected.length, `${n}-stage, stage ${idx + 1}: cone count`);
			expected.forEach(([vertex, back, exterior], i) => {
				const msg = `${n}-stage, stage ${idx + 1}, ${i === 0 ? 'primary' : 'secondary'}`;
				assertNear(cones[i].xVertex, vertex * R, lit, `${msg}: vertex`);
				assertNear(cones[i].xVertex - cones[i].coneLen, back * R, lit, `${msg}: back end`);
				assertNear(cloudExteriorX(cones[i], silhouette), exterior * R, 1e-3 * R, `${msg}: leaves the body`);
			});
		}
	});

	it('regression (2-stage first-stage flight, peak, R = 40): the primary vertex is at 1.600 R (formerly 1.174 R), the secondary at 0.400 R', () => {
		const R = 40;
		const { rec, cones } = conesOf({ stages: 2, idx: 0, fairing: 'attached' }, R);
		assert.equal(cones.length, 2);
		assertNear(cones[0].xVertex, 1.600 * R, 1e-9, 'primary vertex at the fairing base 1.600 R');
		assertNear(cones[1].xVertex, 0.400 * R, 1e-9, 'secondary vertex at the interstage edge 0.400 R');
		assertNear(cones[0].xVertex - 1.174 * R, 17.04, 1e-9, 'the former primary station 1.174 R (0.72 L) was 17 px aft');
		assert.equal(cones[0].xVertex, rec.hull.fairings[0].startX, 'the primary vertex is the drawn fairing base');
		const body = rec.hull.order.filter(e => e.kind === 'stage1' || e.kind === 'stage2' || e.kind === 'interstage');
		assert.equal(cones[1].xVertex, body[body.findIndex(e => e.kind === 'interstage') - 1].startX, 'the secondary vertex is the aft end of the stage above the drawn interstage');
	});

	it('regression (2-stage first-stage flight, peak, R = 40): the primary cloud leaves the drawn body at 1.244 R ± 0.01 R (formerly 0.829 R)', () => {
		const R = 40;
		const { rec, cones } = conesOf({ stages: 2, idx: 0, fairing: 'attached' }, R);
		assert.ok(cones.length >= 1, 'a primary cone is drawn');
		const exterior = cloudExteriorX(cones[0], drawnSilhouette({ ...rec.hull, ctx: rec.ctx }));
		assertNear(exterior, 1.244 * R, 0.01 * R, 'the primary cloud leaves the body at 1.244 R');
		assert.ok(exterior - 0.829 * R > 0.4 * R, `the former cloud left at 0.829 R; now ${exterior / R} R`);
	});

	it('boundary: the secondary cone appears at intensity 0.55 (just below / exactly / above) when there is an interstage', () => {
		for (const [pres, count] of [[0.15249999999999997, 1], [0.1525, 2], [0.16, 2]]) {
			for (const spec of [{ stages: 2, idx: 0 }, { stages: 3, idx: 0 }, { stages: 3, idx: 1 }]) {
				const { cones } = conesOf(spec, 40, { mach: 1.0, ambientPresRatio: pres });
				assert.equal(cones.length, count, `${specLabel(spec)}, pressure ratio ${pres}`);
				const want = designStack(spec, 40);
				const intensity = designVapor(1.0, pres).intensity;
				assertConeAt(cones[0], want.noseShoulder, intensity, D_MACH_ANGLE_CAP, 1.0);
				if (count === 2) assertConeAt(cones[1], want.interstageShoulder, intensity, D_MACH_ANGLE_CAP, 0.78);
			}
		}
	});

	it('boundary: without an interstage (1-stage, 2-stage upper, 3-stage stage 3, payload alone) only the primary is drawn, even at the peak', () => {
		for (const spec of [{ stages: 1, idx: 0 }, { stages: 2, idx: 1 }, { stages: 3, idx: 2 }, { stages: 1, payloadOnly: true }, { stages: 2, payloadOnly: true }, { stages: 3, payloadOnly: true }]) {
			for (const fairing of ['attached', 'separated']) {
				const { cones } = conesOf({ ...spec, fairing }, 40);
				assert.equal(cones.length, 1, `${specLabel({ ...spec, fairing })}`);
				assertConeAt(cones[0], designStack({ ...spec, fairing }, 40).noseShoulder, 1.0, D_MACH_ANGLE_CAP, 1.0);
			}
		}
	});

	it('boundary: the fairing separation moves the primary from the fairing base to the payload front; the secondary stays', () => {
		const R = 40;
		const on = conesOf({ stages: 2, idx: 0, fairing: 'attached' }, R);
		const off = conesOf({ stages: 2, idx: 0, fairing: 'separated' }, R);
		assertNear(on.cones[0].xVertex, 1.600 * R, 1e-9, 'fairing base');
		assertNear(off.cones[0].xVertex, 2.440 * R, 1e-9, 'payload front 2.440 R');
		assertConeAt(off.cones[0], { x: 2.440 * R, halfWidth: 0.5525 * R }, 1.0, D_MACH_ANGLE_CAP, 1.0);
		const sat = off.rec.hull.sats[0];
		assertNear(off.cones[0].xVertex, sat.cx + 0.5 * sat.r * M.SATELLITE_BUS_W_RATIO, 1e-9, 'the drawn bus front');
		assert.equal(on.cones[1].xVertex, off.cones[1].xVertex, 'the secondary does not move');
	});

	it('abnormal: no noseShoulder draws nothing (no throw); a null interstageShoulder draws no secondary; a layout of the former shape draws nothing', () => {
		const rocket = renderRocket(PEAK);
		for (const lay of [
			{ screenRadius: 30, interstageShoulder: { x: 4, halfWidth: 7 }, rcs: null },
			{ screenRadius: 30, noseShoulder: null, interstageShoulder: { x: 4, halfWidth: 7 }, rcs: null },
			{ xMin: -50, xMax: 70, halfWidth: 10, screenRadius: 30 }
		]) {
			const ctx = createRecordingCtx();
			assert.doesNotThrow(() => RocketRenderer.drawVaporCone(ctx, rocket, lay, VIS));
			assert.equal(ctx.fills.length + ctx.strokes.length, 0, JSON.stringify(lay));
		}
		const ctx = createRecordingCtx();
		RocketRenderer.drawVaporCone(ctx, rocket, { screenRadius: 30, noseShoulder: { x: 12, halfWidth: 6 }, interstageShoulder: null, rcs: null }, VIS);
		assert.equal(extractCones(ctx).length, 1, 'primary only');
	});

	it('abnormal: the deleted station fractions in a configuration are ignored', () => {
		const legacy = { ...VIS, VAPOR_CONE: { ...VIS.VAPOR_CONE, PRIMARY_STATION_FRACTION: 0.1, SECONDARY_STATION_FRACTION: 0.9 } };
		const layout = RocketRenderer._computeVisualLayout(renderRocket(), 40, VIS);
		const drawWith = (cfg) => { const ctx = createRecordingCtx(); RocketRenderer.drawVaporCone(ctx, renderRocket(PEAK), layout, cfg); return ctx; };
		assert.deepEqual(extractCones(drawWith(legacy)), extractCones(drawWith(VIS)), 'same cones with and without the stale keys');
		assert.deepEqual(extractRims(drawWith(legacy)), extractRims(drawWith(VIS)), 'same rims');
		assertNear(extractCones(drawWith(legacy))[0].xVertex, 1.6 * 40, 1e-9, 'still at the fairing base');
	});
});

describe('Unit 08-15: RCS nozzles on the drawn hull (design 2026-11-23 §3.6, §5.1-6)', () => {
	const ALL_FLAGS = Object.freeze({ rcsCw: true, rcsCcw: true, rcsUllage: true });
	const drawnPlumes = (spec, R, over = {}) => extractPlumes(recordDraw(specRocket(spec, { ...ALL_FLAGS, ...over }), R).ctx);
	const drawFlag = (spec, R, flag) => {
		const ctx = createRecordingCtx();
		RocketRenderer.draw(ctx, specRocket(spec, { [flag]: true }), 0, 0, R, 1.0);
		return extractPlumes(ctx);
	};

	for (const row of D_ANCHOR_TABLE) {
		it(`§3.4 row ${row.label}: each flag draws its table rows (positions, directions, length, mist angle) and the couples have the design sign`, () => {
			for (const { spec } of anchorRowSpecs(row)) {
				for (const R of [4, 40]) {
					const msg = `${specLabel(spec)}, R ${R}`;
					const want = designStack(spec, R).rcs;
					for (const [flag, key] of [['rcsCw', 'cw'], ['rcsCcw', 'ccw'], ['rcsUllage', 'ullage']]) {
						const plumes = drawFlag(spec, R, flag);
						assertPlumesMatch(plumes, want[key], `${msg}: ${key}`, 1e-9 * R);
						for (const p of plumes) {
							assertNear(p.lenA, want.plumeLen, 1e-9 * R, `${msg}: ${key} length`);
							assertNear(p.spreadA, D_COLD_GAS.PLUME_SPREAD_RAD, 1e-9, `${msg}: ${key} mist half-angle`);
						}
					}
					const cw = jetTorque(drawFlag(spec, R, 'rcsCw'));
					const ccw = jetTorque(drawFlag(spec, R, 'rcsCcw'));
					const ullage = drawFlag(spec, R, 'rcsUllage');
					const couple = row.corners ? 2 * want.cw[1].y : want.cw[0].x - want.cw[1].x; // 2b, or xFwd - xAft
					assert.ok(cw > 0, `${msg}: CW torque ${cw} > 0`);
					assert.ok(ccw < 0, `${msg}: CCW torque ${ccw} < 0`);
					assertNear(cw, couple, 1e-9 * R, `${msg}: CW couple`);
					assertNear(ccw, -couple, 1e-9 * R, `${msg}: CCW couple`);
					assertNear(jetTorque(ullage), 0, 1e-9 * R, `${msg}: ullage torque`);
					assertNear(jetForce(ullage).x, 2 * Math.cos(D_COLD_GAS.ULLAGE_CANT_RAD), 1e-12, `${msg}: ullage pushes +x`);
					assertNear(jetForce(ullage).y, 0, 1e-12, `${msg}: ullage has no side force`);
				}
			}
		});
	}

	for (const id of PRESET_IDS) {
		it(`regression, ${id}: no CW / CCW mist triangle overlaps a fin, an SRB, a wider neighbour or another drawn part (every stage, fairing and SRB state; R 4 / 12 / 40)`, () => {
			const pv = presetVehicle(id);
			let pairs = 0;
			for (const spec of presetStackSpecs(pv)) {
				for (const R of [4, 12, 40]) {
					const msg = `${id}: ${specLabel(spec)}, R ${R}`;
					const rec = recordDraw(specRocket(spec, { ...ALL_FLAGS, colorTheme: pv.colorTheme }), R);
					const lateral = extractPlumes(rec.ctx).filter(p => Math.abs(p.ux) < 1e-12);
					assert.equal(lateral.length, 4, `${msg}: CW and CCW draw four lateral jets`);
					const parts = partPolygons(rec);
					const want = designStack(spec, R);
					// The parts the rule avoids are really drawn in the configurations that have them
					if (spec.idx === 0) assert.ok(parts.some(p => p.label === 'fin'), `${msg}: fins drawn`);
					if (want.boostersAttached && want.segments.some(s => s.stageIndex === 0)) assert.ok(parts.some(p => p.label === 'SRB'), `${msg}: SRBs drawn`);
					if (want.parts.some(p => p.what === 'fairing' && p.e > 0) && spec.fairing === 'attached') assert.ok(parts.some(p => p.label === 'fairing'), `${msg}: the wider fairing is drawn`);
					for (const t of lateral) {
						for (const part of parts) {
							const depth = convexOverlap(t.pts, part.pts);
							assert.ok(depth <= 1e-9, `${msg}: jet at (${t.x}, ${t.y}) overlaps the ${part.label} by ${depth} px`);
							pairs++;
						}
					}
				}
			}
			assert.ok(pairs > 0, 'some jet / part pairs were checked');
		});
	}

	for (const id of PRESET_IDS) {
		it(`regression, ${id}: the payload alone fires from its bus corners clear of the deployed panels (R 4 / 12 / 40)`, () => {
			const pv = presetVehicle(id);
			for (const R of [4, 12, 40]) {
				const spec = { stages: pv.stages, payloadOnly: true, boosters: pv.boosters };
				const rec = recordDraw(specRocket(spec, ALL_FLAGS), R);
				const plumes = extractPlumes(rec.ctx);
				assertPlumesMatch(plumes, designNozzles(designStack(spec, R).rcs, { cw: true, ccw: true, ullage: true }), `${id}, R ${R}`, 1e-9 * R);
				const panels = partPolygons(rec);
				assert.equal(panels.length, 4, 'two booms and two panels stand out of the bus');
				for (const t of plumes) {
					for (const p of panels) {
						const depth = convexOverlap(t.pts, p.pts);
						assert.ok(depth <= 1e-9, `${id}, R ${R}: jet at (${t.x}, ${t.y}) dir (${t.ux}, ${t.uy}) overlaps a ${p.label} by ${depth} px`);
					}
				}
			}
		});
	}

	for (const id of PRESET_IDS) {
		it(`regression, ${id}: the nozzles stay put across the fairing and SRB separation (every stage, R 4 / 40)`, () => {
			const pv = presetVehicle(id);
			for (let idx = 0; idx < pv.stages; idx++) {
				for (const R of [4, 40]) {
					const base = { stages: pv.stages, idx, boosters: pv.boosters };
					const ref = drawnPlumes({ ...base, fairing: 'attached' }, R).map(p => [p.x, p.y, p.ux, p.uy]);
					assert.equal(ref.length, 6, `${id}, stage ${idx + 1}, R ${R}: six jets`);
					const variants = [
						['fairing separated', { ...base, fairing: 'separated' }, {}],
						['fairing separated (telemetry)', { ...base, fairing: 'attached' }, { telemetry: { isFairingSeparated: true } }],
						['SRBs separated', { ...base, fairing: 'attached', boosterSeparated: true }, {}],
						['SRBs separated (telemetry)', { ...base, fairing: 'attached' }, { telemetry: { isBoosterSeparated: true } }],
						['both separated', { ...base, fairing: 'separated', boosterSeparated: true }, {}]
					];
					for (const [label, spec, over] of variants) {
						assert.deepEqual(drawnPlumes(spec, R, over).map(p => [p.x, p.y, p.ux, p.uy]), ref, `${id}, stage ${idx + 1}, R ${R}: ${label}`);
					}
				}
			}
		});
	}

	for (const id of PRESET_IDS) {
		it(`regression, ${id}: no nozzle sits on the configured fairing, attached or separated (every stage, R 4 / 40)`, () => {
			const pv = presetVehicle(id);
			for (let idx = 0; idx < pv.stages; idx++) {
				for (const R of [4, 40]) {
					for (const fairing of ['attached', 'separated']) {
						const spec = { stages: pv.stages, idx, boosters: pv.boosters, fairing };
						const { fairingX, lFairing } = designStack(spec, R);
						const plumes = drawnPlumes(spec, R);
						assert.equal(plumes.length, 6);
						for (const p of plumes) {
							assert.ok(p.x < fairingX || p.x > fairingX + lFairing, `${id}, stage ${idx + 1}, R ${R}, fairing ${fairing}: nozzle x ${p.x} outside the fairing [${fairingX}, ${fairingX + lFairing}]`);
						}
					}
				}
			}
		});
	}

	it('regression: on the 3-stage third stage with its fairing the wall is the stage radius 0.55 R (not the fairing 0.65 R)', () => {
		const pv = presetVehicle('epsilon');
		for (const R of [4, 40]) {
			for (const fairing of ['attached', 'separated']) {
				const plumes = drawnPlumes({ stages: pv.stages, idx: 2, fairing }, R);
				assert.equal(plumes.length, 6);
				for (const p of plumes) assertNear(Math.abs(p.y), 0.55 * R, 1e-12 * R, `R ${R}, fairing ${fairing}: wall`);
				const want = designStack({ stages: 3, idx: 2, fairing }, R);
				assert.ok(want.parts.some(p => p.what === 'fairing' && p.e > 0), 'the configured fairing stands 0.10 R out of the wall');
			}
		}
	});

	it('boundary: one free stretch (fins only) vs two (an SRB in the middle of stage 1): xFwd on the foremost, xAft on the aftmost', () => {
		const R = 10;
		const one = { stages: 2, idx: 0 };
		const wantOne = designStack(one, R);
		assert.equal(wantOne.free.length, 1, 'fins only: one free stretch');
		const [lo, hi] = wantOne.free[0];
		assertNear(wantOne.xFwd - wantOne.xAft, 0.70 * (hi - lo), 1e-12, 'one stretch: 0.70 |F| apart');
		assertRcsNear(RocketRenderer._computeVisualLayout(specRocket(one), R, VIS).rcs, wantOne.rcs, 1e-9, 'one stretch');

		const middle = { count: 2, burnTimeSec: 100, attachOffsetXRatio: 0.4, lengthRatio: 0.6, noseConeLengthRatio: 0.1, nozzleLengthRatio: 0.1 };
		const two = { stages: 2, idx: 0, boosters: middle };
		const wantTwo = designStack(two, R);
		assert.equal(wantTwo.free.length, 2, 'SRB in the middle: two free stretches');
		const [aft, fwd] = wantTwo.free;
		const layout = RocketRenderer._computeVisualLayout(specRocket(two), R, VIS);
		assertRcsNear(layout.rcs, wantTwo.rcs, 1e-9, 'two stretches');
		assertNear(layout.rcs.cw[0].x, fwd[0] + 0.84 * (fwd[1] - fwd[0]), 1e-9, 'xFwd at 0.84 of the forward stretch');
		assertNear(layout.rcs.cw[1].x, aft[0] + 0.14 * (aft[1] - aft[0]), 1e-9, 'xAft at 0.14 of the aft stretch');
		assert.ok(jetTorque(layout.rcs.cw) > 0 && jetTorque(layout.rcs.ccw) < 0, 'couple signs kept');
		// and the drawn lateral jets clear the fins and the SRBs
		const rec = recordDraw(specRocket(two, ALL_FLAGS), R);
		const parts = partPolygons(rec);
		assert.ok(parts.some(p => p.label === 'SRB') && parts.some(p => p.label === 'fin'));
		for (const t of extractPlumes(rec.ctx).filter(p => Math.abs(p.ux) < 1e-12)) {
			for (const part of parts) assert.ok(convexOverlap(t.pts, part.pts) <= 1e-9, `jet at ${t.x} clears the ${part.label}`);
		}
	});

	it('boundary: a part ending exactly at the body end (or starting at its start) leaves no zero-length stretch', () => {
		const noSpread = { ...VIS, COLD_GAS_RCS: { ...VIS.COLD_GAS_RCS, PLUME_SPREAD_RAD: 0 } };
		const srb = (a, b) => ({ xBase: a + 0.5, lNozzleB: 0.5, lB: b - a - 1, lNoseB: 0.5, rB: 1, yPositions: [-2.5, 2.5] });
		const cases = [
			{ label: 'SRB [6, 8] ends at the body end 8', geometry: synthGeometry({ startX: 0, length: 8, radius: 2, stageIndex: 0, boosterLayout: srb(6, 8) }), free: [0, 6] },
			{ label: 'SRB [0, 2] starts at the body start 0', geometry: synthGeometry({ startX: 0, length: 8, radius: 2, stageIndex: 0, boosterLayout: srb(0, 2) }), free: [2, 8] },
			{ label: 'wider fairing starting at the body end 8', geometry: synthGeometry({ startX: 0, length: 8, radius: 2, fairingConfig: { startX: 8, radius: 3, length: 4 } }), free: [0, 8] },
			{ label: 'wider neighbour starting at the body end 8', geometry: synthGeometry({ startX: 0, length: 8, radius: 2, above: { kind: 'interstage', startX: 8, radius: 3, length: 1 } }), free: [0, 8] }
		];
		for (const c of cases) {
			const rcs = RocketRenderer._layoutFromGeometry(c.geometry, 30, noSpread).rcs;
			const [lo, hi] = c.free;
			assertRcsNear(rcs, designStackNozzles({ xFwd: lo + 0.84 * (hi - lo), xAft: lo + 0.14 * (hi - lo), h: 2, plumeLen: 4.8 }), 1e-12, c.label);
		}
		// with the shipped spread the neighbour cuts min(e, plumeLen) tan(0.34) into the body
		const spread = RocketRenderer._layoutFromGeometry(cases[2].geometry, 30, VIS).rcs;
		const hi = 8 - 1 * Math.tan(0.34);
		assertRcsNear(spread, designStackNozzles({ xFwd: 0.84 * hi, xAft: 0.14 * hi, h: 2, plumeLen: 4.8 }), 1e-12, 'margin e tan(spread)');
	});

	it('boundary: a part standing out farther than the jet is cleared by min(e, plumeLen) tan(spread)', () => {
		const R = 10;
		for (const [ratio, label] of [[0.2, 'e > plumeLen'], [0.65, 'e = plumeLen (FIN_SPAN_RATIO)'], [2.4, 'e < plumeLen (shipped)']]) {
			const cfg = { ...VIS, COLD_GAS_RCS: { ...VIS.COLD_GAS_RCS, PLUME_LEN_WIDTH_RATIO: ratio, MIN_PLUME_PX: 0 } };
			const spec = { stages: 1, idx: 0 };
			const want = designStack(spec, R, cfg);
			const h = 0.7 * R;
			assertNear(want.plumeLen, ratio * h, 1e-12, `${label}: plume length`);
			const finsHi = -1.5 * R + 2.8 * R * 0.2 + Math.min(0.65 * h, ratio * h) * Math.tan(0.34);
			assertNear(want.free[0][0], finsHi, 1e-9, `${label}: the fin margin`);
			assertRcsNear(RocketRenderer._computeVisualLayout(specRocket(spec), R, cfg).rcs, want.rcs, 1e-9, label);
		}
	});

	it('boundary: no free wall (an SRB or the fins over the whole stage, 9 SRBs) gives rcs = null and draws no jet; 8 SRBs still leave a wall', () => {
		const R = 40;
		const cover = { count: 2, burnTimeSec: 100, attachOffsetXRatio: 0.01, lengthRatio: 3.2 };
		const h324 = presetVehicle('h3_24').boosters;
		const finsAll = { ...VIS, MODULES: { ...VIS.MODULES, FIN_BASE_RATIO: 1 } };
		const cases = [
			['an SRB over the whole stage', { stages: 2, idx: 0, boosters: cover }, VIS],
			['9 SRBs of the H3-24 size', { stages: 2, idx: 0, boosters: { ...h324, count: 9 } }, VIS],
			['fins over the whole stage', { stages: 1, idx: 0 }, finsAll]
		];
		for (const [label, spec, cfg] of cases) {
			assert.equal(designStack(spec, R, cfg).free.length, 0, `${label}: the design leaves no free wall`);
			assert.equal(RocketRenderer._computeVisualLayout(specRocket(spec), R, cfg).rcs, null, `${label}: rcs = null`);
		}
		for (const [label, spec] of cases.slice(0, 2)) {
			const rec = recordDraw(specRocket(spec, { ...ALL_FLAGS, ...PEAK_VAPOR }), R);
			assert.equal(extractPlumes(rec.ctx).length, 0, `${label}: no jet drawn`);
			assert.equal(extractCones(rec.ctx).length, 2, `${label}: the vapor cones are still drawn`);
		}
		const eight = { stages: 2, idx: 0, boosters: { ...h324, count: 8 } };
		const want8 = designStack(eight, R);
		assert.equal(want8.free.length, 1, '8 SRBs leave one free stretch');
		assertRcsNear(RocketRenderer._computeVisualLayout(specRocket(eight), R, VIS).rcs, want8.rcs, 1e-9, '8 SRBs');
	});

	it('boundary: at the LOD threshold R = 4 the shortest shipped stretch (H3-24 stage 1, 0.81 px) still separates xFwd and xAft', () => {
		const R = VIS.LOD_RADIUS_THRESHOLD;
		assert.equal(R, 4.0);
		const spec = { stages: 2, idx: 0, boosters: presetVehicle('h3_24').boosters };
		const want = designStack(spec, R);
		assert.equal(want.free.length, 1);
		const [lo, hi] = want.free[0];
		assertNear(hi - lo, 0.81, 0.005, 'free stretch 0.202 R = 0.81 px');
		const plumes = drawFlag(spec, R, 'rcsCw');
		assertPlumesMatch(plumes, want.rcs.cw, 'CW at the LOD threshold');
		const xs = plumes.map(p => p.x).sort((a, b) => b - a);
		assertNear(xs[0] - xs[1], 0.70 * (hi - lo), 1e-12, 'xFwd - xAft = 0.70 |F|');
		assert.ok(xs[0] - xs[1] > 0.5, `0.567 px apart (got ${xs[0] - xs[1]})`);
		assert.ok(jetTorque(plumes) > 0, 'CW couple kept');
	});

	it('abnormal: a layout without rcs and a rocket whose wall is gone draw no jet through draw() and do not throw', () => {
		const ctx = createRecordingCtx();
		const rocket = specRocket({ stages: 2, idx: 0, boosters: { count: 2, burnTimeSec: 1, attachOffsetXRatio: 0.01, lengthRatio: 3.2 } }, ALL_FLAGS);
		assert.doesNotThrow(() => RocketRenderer.draw(ctx, rocket, 0, 0, 40, 1.0));
		assert.equal(extractPlumes(ctx).length, 0);
		for (const lay of [{ screenRadius: 40 }, { screenRadius: 40, rcs: null }, { screenRadius: 40, rcs: undefined }]) {
			const c = createRecordingCtx();
			assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(c, rocket, lay, VIS));
			assert.equal(c.fills.length, 0);
		}
	});

	it('draw order: the hull (with its engine and SRB plumes), then the vapor cone, then the RCS jets last; the low detail draws none of them', () => {
		const spec = { stages: 2, idx: 0, boosters: presetVehicle('h3_22').boosters };
		const rec = recordDraw(specRocket(spec, { ...ALL_FLAGS, ...FIRING, ...PEAK_VAPOR }), 40);
		const top = rec.calls.filter(c => c.parent === null).map(c => c.name);
		assert.deepEqual(top, ['_drawHighDetail', 'drawVaporCone', 'drawColdGasRcs']);
		const [hd, cone, rcs] = rec.calls.filter(c => c.parent === null);
		assert.ok(rec.calls.some(c => c.name === '_drawPlume' && c.parent === hd), 'the engine plume is drawn in the hull');
		assert.ok(rec.hull.srbPlumes.length === 2, 'the SRB plumes are drawn in the hull');
		assert.ok(hd.fill1 > hd.fill0 && cone.fill0 === hd.fill1 && cone.fill1 > cone.fill0 && rcs.fill0 === cone.fill1, 'hull, then cone, then RCS');
		assert.equal(rcs.fill1, rec.ctx.fills.length, 'nothing is drawn after the RCS jets');
		assert.equal(extractCones(rec.ctx).length, 2);
		for (const f of rec.ctx.fills.slice(rcs.fill0)) {
			assert.ok(f.style === D_COLD_GAS.MIST_COLOR || f.style === D_COLD_GAS.CORE_COLOR, 'only RCS jets after the cone');
		}
		assert.equal(rec.ctx.fills.slice(rcs.fill0).filter(f => f.style === D_COLD_GAS.MIST_COLOR).length, 6);
		const low = recordDraw(specRocket(spec, { ...ALL_FLAGS, ...FIRING, ...PEAK_VAPOR }), 4.0 - 1e-9);
		assert.deepEqual(low.calls.filter(c => c.parent === null).map(c => c.name), ['_drawLowDetail']);
	});

	describe('payload alone: corner jets and the antenna (§3.6.2)', () => {
		const s = D_COLD_GAS.PLUME_SPREAD_RAD;
		/** §3.6.2: closest approach of the deployed dish's centre line to the inner edge of a forward jet, per R (R = 1 units). */
		const designGap = (payloadRatio) => {
			const W = M.SATELLITE_BUS_W_RATIO * payloadRatio;
			const H = M.SATELLITE_BUS_H_RATIO * payloadRatio;
			const a = W / 2; const b = H / 2;
			const dishX = W * M.SATELLITE_DISH_OFFSET_RATIO;
			const dishR = H * M.SATELLITE_DISH_R_RATIO;
			return b * Math.cos(s) - (dishX - a) * Math.sin(s) - dishR;
		};
		const pointSegmentDistance = ([px, py], [x0, y0], [x1, y1]) => {
			const dx = x1 - x0; const dy = y1 - y0;
			const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)));
			return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
		};
		const pointInTriangle = ([px, py], [[ax, ay], [bx, by], [cx, cy]]) => {
			const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
			const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
			const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
			return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
		};
		/** Measures, on the drawn canvas, the dish arc and the inner edges of the two forward jets. */
		const measureGap = (n, R) => {
			const rec = recordDraw(specRocket({ stages: n, payloadOnly: true }, { rcsCw: true, rcsCcw: true }), R);
			const dish = rec.ctx.strokes.filter(k => k.path.length === 1 && k.path[0].op === 'arc');
			assert.equal(dish.length, 1, 'one dish arc');
			const arc = dish[0].path[0];
			assertNear(arc.a0, -Math.PI / 2, 1e-15, 'arc from -π/2');
			assertNear(arc.a1, Math.PI / 2, 1e-15, 'arc to +π/2');
			const forward = extractPlumes(rec.ctx).filter(p => p.ux > 0.5);
			assert.equal(forward.length, 2, 'two forward jets (CW and CCW)');
			let gap = Infinity;
			let inside = false;
			const N = 4000;
			for (const jet of forward) {
				const [apex, c1, c2] = jet.pts;
				const inner = Math.abs(c1[1]) < Math.abs(c2[1]) ? c1 : c2;
				const dist = (th) => pointSegmentDistance([arc.x + arc.r * Math.cos(th), arc.y + arc.r * Math.sin(th)], apex, inner);
				let best = arc.a0;
				let bestD = Infinity;
				for (let i = 0; i <= N; i++) {
					const th = arc.a0 + (arc.a1 - arc.a0) * i / N;
					const d = dist(th);
					if (d < bestD) { bestD = d; best = th; }
					if (pointInTriangle([arc.x + arc.r * Math.cos(th), arc.y + arc.r * Math.sin(th)], jet.pts)) inside = true;
				}
				// golden-section refinement around the best sample
				let lo = Math.max(arc.a0, best - (arc.a1 - arc.a0) / N);
				let hi = Math.min(arc.a1, best + (arc.a1 - arc.a0) / N);
				for (let k = 0; k < 100; k++) {
					const m1 = lo + (hi - lo) * 0.381966;
					const m2 = hi - (hi - lo) * 0.381966;
					if (dist(m1) < dist(m2)) hi = m2; else lo = m1;
				}
				gap = Math.min(gap, dist(0.5 * (lo + hi)));
			}
			return { gap, inside, halfLine: dish[0].lineWidth / 2 };
		};

		for (const [n, ratio, litGap, litR] of [[1, M.STAGE1_RADIUS_RATIO, 0.095, 6.288], [2, M.STAGE2_RADIUS_RATIO, 0.089, 6.772], [3, M.STAGE3_RADIUS_RATIO, 0.075, 8.003]]) {
			it(`${n}-stage vehicle: the dish centre line stays ${litGap} R inside the forward jets; the 0.6 px line touches them only below R = ${litR} px (< 0.30 px)`, () => {
				const g = designGap(ratio);
				assertNear(g, litGap, 5e-4, '§3.6.2 gap (R = 1)');
				assertNear(0.6 / g, litR, 5e-4, '§3.6.2 threshold R');
				for (const R of [40, 12, 4]) {
					const m = measureGap(n, R);
					assert.equal(m.inside, false, `R ${R}: the dish centre line never enters a jet triangle`);
					assertNear(m.gap, g * R, 1e-9 * R, `R ${R}: drawn gap`);
					assert.equal(m.halfLine, 0.6, 'dish line half-width 0.6 px');
				}
				const Rt = 0.6 / g;
				assert.ok(measureGap(n, Rt * (1 + 1e-6)).gap > 0.6, 'just above the threshold the line clears the mist');
				assert.ok(measureGap(n, Rt * (1 - 1e-6)).gap < 0.6, 'just below the threshold it touches');
				const overlapAtLod = 0.6 - measureGap(n, 4).gap;
				assert.ok(overlapAtLod > 0 && overlapAtLod <= 0.301, `largest overlap (at the LOD threshold) ${overlapAtLod} px is below 0.30 px`);
			});
		}

		it('the largest dish / mist overlap over the payloads is about 0.30 px (3-stage vehicle at R = 4)', () => {
			assertNear(0.6 - designGap(M.STAGE3_RADIUS_RATIO) * 4, 0.300, 0.001, '0.6 - 4 x 0.075');
		});

		it('corner jets: positions, axial directions, plume length max(MIN_PLUME_PX, 2.4 b), couples 2b / -2b, ullage pushes +x', () => {
			for (const n of [1, 2, 3]) {
				const ratio = [M.STAGE1_RADIUS_RATIO, M.STAGE2_RADIUS_RATIO, M.STAGE3_RADIUS_RATIO][n - 1];
				for (const R of [4, 40]) {
					const a = 0.5 * R * ratio * M.SATELLITE_BUS_W_RATIO;
					const b = 0.5 * R * ratio * M.SATELLITE_BUS_H_RATIO;
					const want = designPayloadNozzles({ a, b, plumeLen: Math.max(4, 2.4 * b) });
					const spec = { stages: n, payloadOnly: true };
					assertRcsNear(RocketRenderer._computeVisualLayout(specRocket(spec), R, VIS).rcs, want, 1e-9 * R, `${n}-stage, R ${R}`);
					assertNear(jetTorque(drawFlag(spec, R, 'rcsCw')), 2 * b, 1e-9 * R, 'CW couple 2b');
					assertNear(jetTorque(drawFlag(spec, R, 'rcsCcw')), -2 * b, 1e-9 * R, 'CCW couple -2b');
					const ull = drawFlag(spec, R, 'rcsUllage');
					assertNear(jetTorque(ull), 0, 1e-9 * R, 'ullage torque 0');
					assertNear(jetForce(ull).x, 2 * Math.cos(D_COLD_GAS.ULLAGE_CANT_RAD), 1e-12, 'ullage pushes +x');
				}
				// plume floor boundary: 2.4 b = MIN_PLUME_PX exactly at R = 4 / (2.4 * 0.5 * ratio * BUS_H)
				const Rb = 4 / (2.4 * 0.5 * ratio * M.SATELLITE_BUS_H_RATIO);
				for (const [R, len] of [[Rb * 0.5, 4], [Rb * 2, 2.4 * 0.5 * Rb * 2 * ratio * M.SATELLITE_BUS_H_RATIO]]) {
					assertNear(RocketRenderer._computeVisualLayout(specRocket({ stages: n, payloadOnly: true }), R, VIS).rcs.plumeLen, len, 1e-9, `${n}-stage, R ${R}: plume length`);
				}
			}
		});
	});
});

describe('Unit 08-16: a visual configuration without COLD_GAS_RCS (design 2026-11-23 §3.6, Gate 3 G3-1-03)', () => {
	it('abnormal: _layoutFromGeometry gives rcs = null, keeps the cone anchors, and drawColdGasRcs draws nothing', () => {
		const cfg = { ...VIS };
		delete cfg.COLD_GAS_RCS;
		const rocket = renderRocket({ rcsCw: true, rcsCcw: true, rcsUllage: true });
		const layout = RocketRenderer._computeVisualLayout(rocket, 40, cfg);
		assert.equal(layout.rcs, null, 'no RCS configuration, no nozzles');
		assert.deepEqual(layout.noseShoulder, RocketRenderer._computeVisualLayout(rocket, 40, VIS).noseShoulder, 'the cone anchors are unaffected');
		const ctx = createRecordingCtx();
		RocketRenderer.drawColdGasRcs(ctx, rocket, layout, VIS);
		assert.equal(extractPlumes(ctx).length, 0, 'nothing drawn');
		const alone = renderRocket({ rcsCw: true, isPayloadSeparated: true });
		assert.equal(RocketRenderer._computeVisualLayout(alone, 40, cfg).rcs, null, 'payload alone: null too');
	});

	it('abnormal: COLD_GAS_RCS without PLUME_SPREAD_RAD and ULLAGE_CANT_RAD places the nozzles with the drawn defaults (Gate 3 G3-3-03)', () => {
		// The defaults are the shipped values (0.34, 0.28), the ones _drawRcsPlume draws with when the key is missing, so the
		// margin from a wider neighbour still matches the drawn mist
		const bare = { ...VIS.COLD_GAS_RCS };
		delete bare.PLUME_SPREAD_RAD;
		delete bare.ULLAGE_CANT_RAD;
		const cfg = { ...VIS, COLD_GAS_RCS: bare };
		// A wider fairing from the body end 8 (e = 1 < plumeLen 4.8): the free wall ends at 8 - 1 x tan(0.34)
		const geometry = synthGeometry({ startX: 0, length: 8, radius: 2, fairingConfig: { startX: 8, radius: 3, length: 4 } });
		const hi = 8 - 1 * Math.tan(D_COLD_GAS.PLUME_SPREAD_RAD);
		assertRcsNear(RocketRenderer._layoutFromGeometry(geometry, 30, cfg).rcs,
			designStackNozzles({ xFwd: 0.84 * hi, xAft: 0.14 * hi, h: 2, plumeLen: 4.8 }), 1e-12, 'stage wall: margin and the ullage cant');
		// Payload alone: the ullage pair leaves the aft corners canted by 0.28 towards the tail
		const alone = renderRocket({ rcsUllage: true, isPayloadSeparated: true });
		const ullage = RocketRenderer._computeVisualLayout(alone, 40, cfg).rcs.ullage;
		const c = D_COLD_GAS.ULLAGE_CANT_RAD;
		assert.equal(ullage.length, 2);
		for (const [i, sy] of [[0, 1], [1, -1]]) {
			assertNear(ullage[i].ux, -Math.cos(c), 1e-12, `payload ullage ${i} ux`);
			assertNear(ullage[i].uy, sy * Math.sin(c), 1e-12, `payload ullage ${i} uy`);
		}
		// What is drawn with the bare configuration: the same mist half-angle as the margin used
		const rocket = renderRocket({ rcsUllage: true });
		const layout = RocketRenderer._computeVisualLayout(rocket, 40, cfg);
		const ctx = createRecordingCtx();
		RocketRenderer.drawColdGasRcs(ctx, rocket, layout, cfg);
		const plumes = extractPlumes(ctx);
		assert.equal(plumes.length, 2, 'the ullage pair is drawn');
		for (const p of plumes) assertNear(p.spreadA, D_COLD_GAS.PLUME_SPREAD_RAD, 1e-9, 'drawn mist half-angle');
	});
});
