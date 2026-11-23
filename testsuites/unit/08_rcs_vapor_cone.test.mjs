/**
 * Unit Test Suite 08: Cold-gas RCS, AeroUtils (temperature / speed of sound / Mach),
 * transonic vapor cone, Mach zero-clear and the SoundEffects Mach source.
 *
 * Design:    docs/design/2026-11-20_trajectory_fx_flightplan.md §3.2, §3.3, §4.4
 *            (§4.4 replaces the vapor-cone bell formula of §3.3)
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-C
 *
 * Every expected value below is derived from the design formulas and tables
 * (RCS_CONFIG, the nozzle position / jet-vector table, the AeroUtils equations and the
 * COLD_GAS_RCS / VAPOR_CONE schemas), never from the current implementation output.
 * SoundEffects voice levels come from its own SOUND_FX_CONFIG parameter table.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
const D_VAPOR = Object.freeze({
	PRIMARY_STATION_FRACTION: 0.72,
	SECONDARY_STATION_FRACTION: 0.44,
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
const createRecordingCtx = () => {
	const fills = [];
	const strokes = [];
	const gradients = [];
	const stack = [];
	let path = [];
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
		save() { stack.push({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, globalAlpha: ctx.globalAlpha }); },
		restore() { const s = stack.pop(); if (s) Object.assign(ctx, s); },
		translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {}, clip() {},
		beginPath() { path = []; },
		closePath() { path.push({ op: 'closePath' }); },
		moveTo(x, y) { path.push({ op: 'moveTo', x, y }); },
		lineTo(x, y) { path.push({ op: 'lineTo', x, y }); },
		quadraticCurveTo(cpx, cpy, x, y) { path.push({ op: 'quad', cpx, cpy, x, y }); },
		bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { path.push({ op: 'bezier', x, y }); },
		arc(x, y, r) { path.push({ op: 'arc', x, y, r }); },
		ellipse(x, y, rx, ry) { path.push({ op: 'ellipse', x, y, rx, ry }); },
		rect(x, y, w, h) { path.push({ op: 'rect', x, y, w, h }); },
		roundRect(x, y, w, h) { path.push({ op: 'rect', x, y, w, h }); },
		fill() { fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha, path: path.slice() }); },
		stroke() { strokes.push({ style: ctx.strokeStyle, alpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, path: path.slice() }); },
		fillRect(x, y, w, h) { fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha, path: [{ op: 'rect', x, y, w, h }] }); },
		strokeRect() {}, clearRect() {},
		createLinearGradient(...args) { return makeGradient('linear', args); },
		createRadialGradient(...args) { return makeGradient('radial', args); },
		setLineDash() {}, getLineDash() { return []; },
		measureText(t) { return { width: String(t ?? '').length * 8 }; },
		fillText() {}, strokeText() {}, drawImage() {}
	};
	return ctx;
};

/** Decodes every RCS plume (mist cone) drawn with the COLD_GAS_RCS mist colour. */
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
		return { x: apex.x, y: apex.y, ux, uy, lenA, lenB, spreadA, spreadB };
	});
const extractCorePlumes = (ctx) => extractPlumes(ctx, D_COLD_GAS.CORE_COLOR);

/** Design nozzle table (§3.2-3) evaluated for a layout: L = max(1, xMax - xMin). */
const designNozzles = (layout, flags) => {
	const L = Math.max(1, layout.xMax - layout.xMin);
	const xFwd = layout.xMin + L * 0.84;
	const xAft = layout.xMin + L * 0.14;
	const yWall = layout.halfWidth;
	const out = [];
	if (flags.cw) {
		out.push({ x: xFwd, y: -yWall, ux: 0, uy: -1 });
		out.push({ x: xAft, y: +yWall, ux: 0, uy: +1 });
	}
	if (flags.ccw) {
		out.push({ x: xFwd, y: +yWall, ux: 0, uy: +1 });
		out.push({ x: xAft, y: -yWall, ux: 0, uy: -1 });
	}
	if (flags.ullage) {
		out.push({ x: xAft, y: +yWall, ux: -Math.cos(0.28), uy: +Math.sin(0.28) });
		out.push({ x: xAft, y: -yWall, ux: -Math.cos(0.28), uy: -Math.sin(0.28) });
	}
	return out;
};
const assertPlumesMatch = (actual, expected, msg) => {
	assert.equal(actual.length, expected.length, `${msg}: plume count`);
	const pool = actual.slice();
	for (const e of expected) {
		const idx = pool.findIndex(p => Math.abs(p.x - e.x) < 1e-9 && Math.abs(p.y - e.y) < 1e-9
			&& Math.abs(p.ux - e.ux) < 1e-9 && Math.abs(p.uy - e.uy) < 1e-9);
		assert.ok(idx >= 0, `${msg}: no plume at (${e.x}, ${e.y}) with jet (${e.ux}, ${e.uy}); drawn ${JSON.stringify(pool)}`);
		pool.splice(idx, 1);
	}
};

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
		return { xVertex: m.x, coneLen: m.x - q1.x, halfW: q2.y, halfWTop: -q1.y, stops: f.style.stops };
	});

const VIS = presetManager.getRocketVisual();
const THEME = VIS.THEMES.orange;
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

/** Records the hull primitives drawn by _drawHighDetail (stage bodies, fairing, payload). */
const captureHull = (rocket, R) => {
	const rec = { stages: [], fairings: [], sats: [] };
	const orig = {
		s1: RocketRenderer._drawStage1,
		s2: RocketRenderer._drawStage2,
		f: RocketRenderer._drawFairing,
		p: RocketRenderer._drawPayloadSatellite
	};
	RocketRenderer._drawStage1 = function (ctx, startX, radius, length, ...rest) { rec.stages.push({ startX, radius, length }); return orig.s1.call(this, ctx, startX, radius, length, ...rest); };
	RocketRenderer._drawStage2 = function (ctx, startX, radius, length, ...rest) { rec.stages.push({ startX, radius, length }); return orig.s2.call(this, ctx, startX, radius, length, ...rest); };
	RocketRenderer._drawFairing = function (ctx, startX, radius, length, ...rest) { rec.fairings.push({ startX, radius, length }); return orig.f.call(this, ctx, startX, radius, length, ...rest); };
	RocketRenderer._drawPayloadSatellite = function (ctx, cx, cy, r, deployed) { rec.sats.push({ cx, cy, r, deployed: Boolean(deployed) }); return orig.p.call(this, ctx, cx, cy, r, deployed); };
	try {
		RocketRenderer._drawHighDetail(createRecordingCtx(), rocket, R, 1.0, THEME, 0);
	} finally {
		RocketRenderer._drawStage1 = orig.s1;
		RocketRenderer._drawStage2 = orig.s2;
		RocketRenderer._drawFairing = orig.f;
		RocketRenderer._drawPayloadSatellite = orig.p;
	}
	return rec;
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
describe('Unit 08-4: RocketRenderer._computeVisualLayout', () => {
	const m = VIS.MODULES;

	for (const [totalStages, ratioName] of [[1, 'STAGE1_RADIUS_RATIO'], [2, 'STAGE2_RADIUS_RATIO'], [3, 'STAGE3_RADIUS_RATIO']]) {
		it(`payload-only (${totalStages}-stage vehicle): xMin/xMax = ∓0.70 * payloadR, halfWidth = 0.85 * payloadR`, () => {
			const R = 25;
			const stages = Array.from({ length: totalStages }, () => ({ fuelType: 'liquid' }));
			const rocket = renderRocket({ totalStages, stages, isPayloadSeparated: true, currentStageIndex: totalStages });
			const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
			const payloadR = R * m[ratioName];
			assertNear(layout.xMin, -0.70 * payloadR, 1e-12, 'xMin');
			assertNear(layout.xMax, +0.70 * payloadR, 1e-12, 'xMax');
			assertNear(layout.halfWidth, 0.85 * payloadR, 1e-12, 'halfWidth');
			assert.equal(layout.screenRadius, R);
			const hull = captureHull(rocket, R);
			assert.equal(hull.sats.length, 1);
			assert.equal(hull.sats[0].deployed, true, 'payload-only draws the deployed satellite');
			assertNear(hull.sats[0].r, payloadR, 1e-12, 'drawn satellite uses the same payloadR');
			assert.equal(hull.stages.length, 0);
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
			assertNear(layout.halfWidth, 0.85 * payloadR, 1e-12, 'payload-only halfWidth');
		}
	});

	it('boundary: stageIndex = totalStages - 1 is still a stack; disableStaging never becomes payload-only', () => {
		const R = 20;
		const last = RocketRenderer._computeVisualLayout(renderRocket({ currentStageIndex: 1 }), R, VIS);
		assertNear(last.halfWidth, R * m.STAGE2_RADIUS_RATIO, 1e-12, 'upper stage stack halfWidth');
		assert.ok(last.xMax - last.xMin > 1.4 * R * m.STAGE2_RADIUS_RATIO, 'stack is longer than the bus');
		const sling = RocketRenderer._computeVisualLayout(renderRocket({ disableStaging: true, isPayloadSeparated: true }), R, VIS);
		assertNear(sling.halfWidth, R * m.STAGE1_RADIUS_RATIO, 1e-12, 'disableStaging keeps the full stack');
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
		it(`stack layout is the envelope of the drawn hull: ${c.name}`, () => {
			const R = 25;
			const rocket = renderRocket(c.over);
			const layout = RocketRenderer._computeVisualLayout(rocket, R, VIS);
			const hull = captureHull(rocket, R);
			assert.ok(hull.stages.length >= 1, 'at least one stage body drawn');
			const xMin = Math.min(...hull.stages.map(s => s.startX));
			const halfWidth = Math.max(...hull.stages.map(s => s.radius), ...hull.fairings.map(f => f.radius));
			let xMax;
			if (hull.fairings.length > 0) {
				assert.equal(hull.sats.length, 0);
				xMax = hull.fairings[0].startX + hull.fairings[0].length;
			} else {
				assert.equal(hull.sats.length, 1);
				assert.equal(hull.sats[0].deployed, false, 'stowed payload on top of the stack');
				xMax = hull.sats[0].cx + 0.5 * hull.sats[0].r * m.SATELLITE_BUS_W_RATIO;
			}
			assertNear(layout.xMin, xMin, 1e-9, 'xMin = aft end of the lowest attached stage');
			assertNear(layout.xMax, xMax, 1e-9, 'xMax = nose (fairing tip or bus front)');
			assertNear(layout.halfWidth, halfWidth, 1e-9, 'halfWidth = widest body radius');
			assert.equal(layout.screenRadius, R);
		});
	}

	it('a bare rocket object (no stages, no telemetry) is laid out as a single stage', () => {
		const R = 10;
		const layout = RocketRenderer._computeVisualLayout({ thrustAngle: 0 }, R, VIS);
		assertNear(layout.halfWidth, R * m.STAGE1_RADIUS_RATIO, 1e-12, 'single-stage halfWidth');
		assertNear(layout.xMin, R * VIS.ALIGNMENT.BASE_X_SINGLE_STAGE_RATIO, 1e-12, 'single-stage xMin');
	});
});

describe('Unit 08-5: RocketRenderer.drawColdGasRcs (design nozzle table §3.2-3)', () => {
	const LIT = { xMin: -50, xMax: 70, halfWidth: 10, screenRadius: 30 }; // L = 120 -> xFwd = 50.8, xAft = -33.2
	const draw = (flags, layout = LIT, cfg = VIS, rocketOver = {}) => {
		const ctx = createRecordingCtx();
		RocketRenderer.drawColdGasRcs(ctx, { rcsCw: flags.cw, rcsCcw: flags.ccw, rcsUllage: flags.ullage, ...rocketOver }, layout, cfg);
		return ctx;
	};

	it('CW: nose jet -Y at (xFwd, -yWall), tail jet +Y at (xAft, +yWall) (literal layout)', () => {
		const plumes = extractPlumes(draw({ cw: true }));
		assertPlumesMatch(plumes, [
			{ x: 50.8, y: -10, ux: 0, uy: -1 },
			{ x: -33.2, y: +10, ux: 0, uy: +1 }
		], 'CW');
	});

	it('CCW: nose jet +Y at (xFwd, +yWall), tail jet -Y at (xAft, -yWall) (literal layout)', () => {
		assertPlumesMatch(extractPlumes(draw({ ccw: true })), [
			{ x: 50.8, y: +10, ux: 0, uy: +1 },
			{ x: -33.2, y: -10, ux: 0, uy: -1 }
		], 'CCW');
	});

	it('Ullage: two aft jets canted 0.28 rad rearward (literal layout)', () => {
		assertPlumesMatch(extractPlumes(draw({ ullage: true })), [
			{ x: -33.2, y: +10, ux: -Math.cos(0.28), uy: Math.sin(0.28) },
			{ x: -33.2, y: -10, ux: -Math.cos(0.28), uy: -Math.sin(0.28) }
		], 'ullage');
	});

	it('every combination of the three bits draws exactly the union of the table rows', () => {
		for (let mask = 0; mask < 8; mask++) {
			const flags = { cw: Boolean(mask & 1), ccw: Boolean(mask & 2), ullage: Boolean(mask & 4) };
			const ctx = draw(flags);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(LIT, flags), `mask ${mask}`);
			if (mask === 0) {
				assert.equal(ctx.fills.length, 0, 'no flags -> nothing drawn');
			}
		}
	});

	it('physical effect column: CW / CCW are pure couples, ullage is a pure +X push', () => {
		const effect = (flags) => {
			let fx = 0; let fy = 0; let tz = 0;
			for (const p of extractPlumes(draw(flags))) {
				const Fx = -p.ux; const Fy = -p.uy; // reaction force opposes the jet
				fx += Fx; fy += Fy; tz += p.x * Fy - p.y * Fx;
			}
			return { fx, fy, tz };
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

	it('plume geometry follows the schema: length max(MIN_PLUME_PX, 2.4 * halfWidth), mist half-angle 0.34 rad', () => {
		const all = extractPlumes(draw({ cw: true, ccw: true, ullage: true }));
		assert.equal(all.length, 6, 'CW + CCW + ullage draw six plumes');
		for (const p of all) {
			assertNear(p.lenA, 24, 1e-9, 'plume length 2.4 * 10');
			assertNear(p.lenB, 24, 1e-9, 'plume length 2.4 * 10');
			assertNear(p.spreadA, 0.34, 1e-9, 'mist half-angle');
			assertNear(p.spreadB, 0.34, 1e-9, 'mist half-angle');
		}
		const tiny = { xMin: -5, xMax: 5, halfWidth: 1, screenRadius: 30 };
		const thin = extractPlumes(draw({ cw: true }, tiny));
		assertPlumesMatch(thin, designNozzles(tiny, { cw: true }), 'thin body (halfWidth 1) still draws both CW jets');
		for (const p of thin) {
			assertNear(p.lenA, 4.0, 1e-12, 'floor MIN_PLUME_PX');
			assertNear(p.lenB, 4.0, 1e-12, 'floor MIN_PLUME_PX');
		}
		const core = extractCorePlumes(draw({ cw: true }));
		assert.equal(core.length, 2, 'each nozzle also draws a core jet');
		assertPlumesMatch(core.map(c => ({ ...c })), designNozzles(LIT, { cw: true }), 'core jets share apex and axis');
	});

	it('nozzles on real layouts (2-stage stack and payload-only) follow the table', () => {
		for (const rocket of [renderRocket({ rcsCw: true, rcsUllage: true }), renderRocket({ isPayloadSeparated: true, rcsCcw: true, rcsUllage: true })]) {
			const layout = RocketRenderer._computeVisualLayout(rocket, 30, VIS);
			const ctx = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(ctx, rocket, layout, VIS);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(layout, { cw: rocket.rcsCw, ccw: rocket.rcsCcw, ullage: rocket.rcsUllage }), 'real layout');
		}
	});

	it('flags mirrored only in telemetry are honoured (each of rcsCw / rcsCcw / rcsUllage, every combination)', () => {
		for (let mask = 1; mask < 8; mask++) {
			const flags = { cw: Boolean(mask & 1), ccw: Boolean(mask & 2), ullage: Boolean(mask & 4) };
			const ctx = createRecordingCtx();
			RocketRenderer.drawColdGasRcs(ctx, { telemetry: { rcsCw: flags.cw, rcsCcw: flags.ccw, rcsUllage: flags.ullage } }, LIT, VIS);
			assertPlumesMatch(extractPlumes(ctx), designNozzles(LIT, flags), `telemetry-only mask ${mask}`);
		}
	});

	it('a flag set on either the rocket or its telemetry fires that row (the other source false)', () => {
		for (const key of ['cw', 'ccw', 'ullage']) {
			const field = { cw: 'rcsCw', ccw: 'rcsCcw', ullage: 'rcsUllage' }[key];
			const expected = designNozzles(LIT, { [key]: true });
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

	describe('station length L = max(1, xMax - xMin) (§3.2-3, Rev 6.10)', () => {
		// L only scales the stations; the 1 px floor keeps xAft < xFwd (0.70 L >= 0.70 px apart) for degenerate layouts.
		const cases = [
			{ label: 'raw length 2 (above the floor)', xMax: 12, L: 2 },
			{ label: 'raw length exactly 1', xMax: 11, L: 1 },
			{ label: 'raw length 0.5 (0 < L < 1)', xMax: 10.5, L: 1 },
			{ label: 'raw length 0 (xMax = xMin)', xMax: 10, L: 1 },
			{ label: 'raw length -40 (inverted layout)', xMax: -30, L: 1 }
		];
		for (const c of cases) {
			it(`${c.label}: xFwd = xMin + 0.84 * ${c.L}, xAft = xMin + 0.14 * ${c.L}; CW / CCW keep their couple sign`, () => {
				const layout = { xMin: 10, xMax: c.xMax, halfWidth: 3, screenRadius: 30 };
				const xFwd = 10 + 0.84 * c.L;
				const xAft = 10 + 0.14 * c.L;
				assertPlumesMatch(extractPlumes(draw({ cw: true, ccw: true, ullage: true }, layout)), [
					{ x: xFwd, y: -3, ux: 0, uy: -1 }, { x: xAft, y: +3, ux: 0, uy: +1 },
					{ x: xFwd, y: +3, ux: 0, uy: +1 }, { x: xAft, y: -3, ux: 0, uy: -1 },
					{ x: xAft, y: +3, ux: -Math.cos(0.28), uy: Math.sin(0.28) }, { x: xAft, y: -3, ux: -Math.cos(0.28), uy: -Math.sin(0.28) }
				], c.label);
				const torque = (flags) => extractPlumes(draw(flags, layout)).reduce((tz, p) => tz + p.x * (-p.uy) - p.y * (-p.ux), 0);
				assertNear(torque({ cw: true }), (0.84 - 0.14) * c.L, 1e-12, 'CW couple (+Δθ) = (xFwd - xAft)');
				assertNear(torque({ ccw: true }), -(0.84 - 0.14) * c.L, 1e-12, 'CCW couple (-Δθ)');
			});
		}
	});

	describe('LOD threshold default 10 when the configuration has none (§3.3-1, Rev 6.10)', () => {
		const noLod = { ...VIS };
		delete noLod.LOD_RADIUS_THRESHOLD;
		for (const [label, cfg] of [['key absent', noLod], ['undefined', { ...VIS, LOD_RADIUS_THRESHOLD: undefined }], ['null', { ...VIS, LOD_RADIUS_THRESHOLD: null }]]) {
			it(`${label}: drawn at screenRadius 10, skipped at 10 - 1e-9 and at the configured 4.0`, () => {
				assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 10 }, cfg)), designNozzles(LIT, { cw: true }), 'at 10');
				assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 10 + 1e-9 }, cfg)), designNozzles(LIT, { cw: true }), 'just above 10');
				assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 10 - 1e-9 }, cfg).fills.length, 0, 'just below 10');
				assert.equal(draw({ cw: true }, { ...LIT, screenRadius: 4.0 }, cfg).fills.length, 0, 'the shipped 4.0 is not used');
			});
		}
		it('a configured threshold is used as is, including 0 (only a missing value falls back)', () => {
			const zero = { ...VIS, LOD_RADIUS_THRESHOLD: 0 };
			assertPlumesMatch(extractPlumes(draw({ cw: true }, { ...LIT, screenRadius: 0 }, zero)), designNozzles(LIT, { cw: true }), 'threshold 0, screenRadius 0');
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

	it('abnormal inputs (null rocket / layout, config without COLD_GAS_RCS) draw nothing and do not throw', () => {
		const ctx = createRecordingCtx();
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, null, LIT, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, { rcsCw: true }, null, VIS));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, { rcsCw: true }, LIT, { ...VIS, COLD_GAS_RCS: undefined }));
		assert.doesNotThrow(() => RocketRenderer.drawColdGasRcs(ctx, { rcsCw: true }, LIT, null));
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

	it('at exactly LOD_RADIUS_THRESHOLD the high-detail path draws RCS plumes and the vapor cone', () => {
		const ctx = drawAt(LOD, { rcsCw: true, mach: 1.0, ambientPresRatio: 1.0 });
		assert.equal(extractPlumes(ctx).length, 2);
		assert.equal(extractCones(ctx).length, 2, 'intensity 1 >= 0.55 -> primary + secondary');
		const layout = RocketRenderer._computeVisualLayout(renderRocket(), LOD, VIS);
		assertPlumesMatch(extractPlumes(ctx), designNozzles(layout, { cw: true }), 'nozzles at the LOD boundary');
	});

	it('just below the threshold (and far below) the low-detail path draws neither', () => {
		for (const R of [LOD - 1e-9, 2.0]) {
			const ctx = drawAt(R, { rcsCw: true, rcsCcw: true, rcsUllage: true, mach: 1.0, ambientPresRatio: 1.0 });
			assert.equal(extractPlumes(ctx).length, 0, `R = ${R}`);
			assert.equal(extractCones(ctx).length, 0, `R = ${R}`);
		}
	});

	it('large screen radius draws all six RCS plumes', () => {
		assert.equal(extractPlumes(drawAt(60, { rcsCw: true, rcsCcw: true, rcsUllage: true })).length, 6);
	});
});

describe('Unit 08-7: RocketRenderer.drawVaporCone (§3.3 dimensions, §4.4 intensity)', () => {
	const R = 20;
	const baseRocket = renderRocket();
	const layout = RocketRenderer._computeVisualLayout(baseRocket, R, VIS);
	const L = Math.max(1, layout.xMax - layout.xMin); // §3.3-1 drawVaporCone
	const hw = layout.halfWidth;
	const drawCone = (mach, pres, cfg = VIS, lay = layout, over = {}) => {
		const ctx = createRecordingCtx();
		RocketRenderer.drawVaporCone(ctx, { ...baseRocket, mach, ambientPresRatio: pres, ...over }, lay, cfg);
		return ctx;
	};
	const expectCone = (cone, xVertex, intensity, machAngle, scale, maxMult = 2.8) => {
		assertNear(cone.xVertex, xVertex, 1e-9, 'vertex station');
		assertNear(cone.coneLen, hw * 2.2 * (0.75 + 0.5 * intensity) * scale, 1e-9, 'coneLen');
		const halfW = Math.min(hw * maxMult, hw * (1.1 + 1.35 * intensity * Math.sin(machAngle))) * scale;
		assertNear(cone.halfW, halfW, 1e-9, 'coneHalfW');
		assertNear(cone.halfWTop, halfW, 1e-9, 'symmetric upper edge');
	};

	it('peak intensity (Mach 1.00, pres 1.0): primary at 0.72 L and a 0.78x secondary at 0.44 L', () => {
		const ctx = drawCone(1.0, 1.0);
		const cones = extractCones(ctx);
		assert.equal(cones.length, 2);
		expectCone(cones[0], layout.xMin + 0.72 * L, 1.0, D_MACH_ANGLE_CAP, 1.0);
		expectCone(cones[1], layout.xMin + 0.44 * L, 1.0, D_MACH_ANGLE_CAP, 0.78);
		const rims = ctx.strokes.filter(s => s.style === D_VAPOR.RIM_COLOR);
		assert.equal(rims.length, 2, 'each cone has a rim stroke');
		for (const [i, rim] of rims.entries()) {
			assert.equal(rim.path[0].x, cones[i].xVertex - cones[i].coneLen);
			assert.equal(rim.path[0].y, -cones[i].halfW);
			assert.equal(rim.path[1].y, cones[i].halfW);
		}
		for (const c of cones) {
			assert.deepEqual(c.stops.map(s => s[1]), [D_VAPOR.CORE_COLOR, D_VAPOR.CORE_COLOR, D_VAPOR.EDGE_COLOR]);
		}
	});

	it('Mach 0.91 (machFactor 0.5): primary only, dimensions from intensity 0.5', () => {
		const cones = extractCones(drawCone(0.91, 1.0));
		assert.equal(cones.length, 1);
		expectCone(cones[0], layout.xMin + 0.72 * L, designVapor(0.91, 1.0).intensity, D_MACH_ANGLE_CAP, 1.0);
		assertNear(designVapor(0.91, 1.0).intensity, 0.5, 1e-12, 'oracle sanity');
	});

	it('Mach 1.2 uses the true Mach angle asin(1/1.2) (below the cap)', () => {
		const v = designVapor(1.2, 1.0);
		const cones = extractCones(drawCone(1.2, 1.0));
		assert.equal(cones.length, 1, `intensity ${v.intensity} < 0.55`);
		expectCone(cones[0], layout.xMin + 0.72 * L, v.intensity, Math.asin(1 / 1.2), 1.0);
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

	it('MAX_WIDTH_MULTIPLIER clamps the half width', () => {
		const clamped = { ...VIS, VAPOR_CONE: { ...VIS.VAPOR_CONE, MAX_WIDTH_MULTIPLIER: 1.5 } };
		const cones = extractCones(drawCone(1.0, 1.0, clamped));
		expectCone(cones[0], layout.xMin + 0.72 * L, 1.0, D_MACH_ANGLE_CAP, 1.0, 1.5);
		assertNear(cones[0].halfW, 1.5 * hw, 1e-9, 'clamped to 1.5 * halfWidth');
		assertNear(cones[1].halfW, 1.5 * hw * 0.78, 1e-9, 'secondary clamp is scaled too');
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

	for (const c of [
		{ label: 'raw length 2 (above the floor)', xMax: 12, L: 2 },
		{ label: 'raw length exactly 1', xMax: 11, L: 1 },
		{ label: 'raw length 0.5', xMax: 10.5, L: 1 },
		{ label: 'raw length 0', xMax: 10, L: 1 },
		{ label: 'raw length -40 (inverted)', xMax: -30, L: 1 }
	]) {
		it(`station length L = max(1, xMax - xMin), ${c.label}: primary at xMin + 0.72 L ahead of the secondary at xMin + 0.44 L`, () => {
			const lay = { xMin: 10, xMax: c.xMax, halfWidth: hw, screenRadius: 30 };
			const cones = extractCones(drawCone(1.0, 1.0, VIS, lay));
			assert.equal(cones.length, 2);
			expectCone(cones[0], 10 + 0.72 * c.L, 1.0, D_MACH_ANGLE_CAP, 1.0);
			expectCone(cones[1], 10 + 0.44 * c.L, 1.0, D_MACH_ANGLE_CAP, 0.78);
			assert.ok(cones[0].xVertex > cones[1].xVertex && cones[1].xVertex > lay.xMin, 'xMin < secondary < primary');
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
