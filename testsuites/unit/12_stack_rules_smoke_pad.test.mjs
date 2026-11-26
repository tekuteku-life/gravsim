/**
 * Unit Test Suite 12: the single stack-state and SRB rules (RocketStackUtils) and their agreement across the renderer,
 * the HUD and the Worker; the smoke / spark emission point; the pad umbilical anchors and the pad scale; the
 * NOZZLE_BOTTOM_OFFSET pin.
 *
 * Design:    docs/design/2026-11-23_vapor_cone_rcs_anchors.md (Rev 22) §1.4.1 (c)-(f), §3.1, §3.7, §3.8
 * Test plan: the same document §5.1-1, §5.1-2, §5.1-7, §5.1-8, §5.1-9
 *
 * Expected values come from the design tables and formulas: the hull positions of §1.2 / §1.4.1 (a) / §3.4 (R = 1), the
 * §3.8 pad table, the §3.1 count rule, the §3.7 plume-length formula and PLUME_VACUUM_STRETCH table. The preset inputs
 * they use (fuel plume lengths, PAD_EFFECT, the Rocket parameter radius, the low-detail ratios) are copied below and
 * pinned to the live configuration in Unit 12-0, so a preset change fails there once. Nothing is copied from the output
 * of the code under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setupMockDOM, createMockElement, createMockUniverse } from '../test_helpers.mjs';

setupMockDOM();

import { Rocket } from '../../scripts/gravsim_object.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { PropulsionCard } from '../../scripts/gravsim_telemetry_card.js';
import { PresetManager, presetManager, ROCKET_VISUAL } from '../../scripts/gravsim_preset_manager.js';
import { PAD_EFFECT, PHYSICS, TELEMETRY, TRAIL_MODE, OBJECT_STATE } from '../../scripts/gravsim_const.js';
// Namespace import: RocketStackUtils is new in this branch (design §3.1); a tree without it fails per test, not at load
import * as GravsimUtils from '../../scripts/gravsim_utils.js';

const { RocketStackUtils, UnitConvertUtils } = GravsimUtils;

/*******************************************************************
 * Design tables and preset inputs
 *******************************************************************/
/** Hull of the full stack (stage index 0) at R = 1: design §1.2, §1.4.1 (a) and §3.4 tables (formulas of §3.2). */
const D_HULL = Object.freeze({
	1: { bodies: [{ a: -1.5, b: 1.3, r: 0.7 }], fairingX: 1.3, fairingR: 0.7, payloadR: 0.7 },
	2: {
		bodies: [{ a: -2.75, b: 0.05, r: 0.7 }, { a: 0.05, b: 0.4, r: 0.7 }, { a: 0.4, b: 1.6, r: 0.65 }],
		fairingX: 1.6, fairingR: 0.65, payloadR: 0.65
	},
	3: {
		bodies: [
			{ a: -3.1, b: -0.3, r: 0.7 }, { a: -0.3, b: 0.05, r: 0.7 }, { a: 0.05, b: 1.25, r: 0.65 },
			{ a: 1.25, b: 1.5, r: 0.65 }, { a: 1.5, b: 2.4, r: 0.55 }
		],
		fairingX: 2.4, fairingR: 0.65, payloadR: 0.55
	}
});
const D_FAIRING = Object.freeze({ LENGTH: 1.1, CURVE_X: 0.7, CURVE_Y: 0.9, PAYLOAD_OFFSET: 0.35 });
const D_BUS = Object.freeze({ W: 1.40, H: 1.70 });
/** Nozzle exit (plume origin) of the current stage, R = 1: the aft ends of the §1.2 "機体の範囲" column. */
const D_NOZZLE_X = Object.freeze({ 1: [-1.85], 2: [-3.1, -0.92], 3: [-3.45, -1.92, -1.18] });
/** Plume scale of the current stage (§3.2: MAIN / UPPER / STAGE3_PLUME_SCALE) and of the payload (§3.2 payload only). */
const D_PLUME_SCALE = Object.freeze({ 1: [1.0], 2: [1.0, 0.65], 3: [1.0, 0.65, 0.5] });
const D_PAYLOAD_PLUME_SCALE = 0.35;
/** Aft face of the deployed payload bus, R = 1 (§3.4 table: -busW / 2). */
const D_PAYLOAD_AFT_X = Object.freeze({ 1: -0.49, 2: -0.455, 3: -0.385 });
/** Plume length multipliers (fuel presets, inputs) and the vacuum stretch of §3.7 (unknown fuels draw as liquid). */
const D_PLUME_LEN_MULT = Object.freeze({ liquid: 8, hydro: 9, solid: 9.5, ion: 4 });
const D_VACUUM_STRETCH = Object.freeze({ hydro: 0.15, solid: 0.12, ion: 0, liquid: 0.15 });
const D_THRUST_THRESHOLD = 0.01;
/** Rocket parameter radius (presets/celestials/rocket.json), the drawing scale when baseRadiusM is missing (§3.7). */
const D_ROCKET_PARAM_RADIUS = 63;
const D_MIN_SCREEN_RADIUS = 3.5;
const D_LOD_RADIUS_THRESHOLD = 4;
const D_NOZZLE_BOTTOM_OFFSET = Object.freeze({ SINGLE_STAGE: 1.85, TWO_STAGE: 3.10, THREE_STAGE: 3.45 });
const D_NOZZLE_BOTTOM_BY_STAGES = Object.freeze({ 1: 1.85, 2: 3.10, 3: 3.45 });
/** Low-detail ellipse (LOW_DETAIL) and its SRB width multipliers (2 -> 1.35, 4 or more -> 1.65, unchanged rule). */
const D_LOW = Object.freeze({ STAGE1_LEN_RATIO: 4.2, STAGE2_LEN_RATIO: 2.2, WIDTH_RATIO: 0.9, SATELLITE_BUS_COLOR: '#d4af37' });
const lowWidthMult = (count) => (count === 2 ? 1.35 : (count >= 4 ? 1.65 : 1.0));
/** PAD_EFFECT inputs of §3.8. */
const D_PAD = Object.freeze({
	CABLE_CONN_X_MULT: 0.8, CABLE_CONN_Y_MULT: -0.7, UMBILICAL_ARM_LEN_MULT: 0.7, UMBILICAL_OFFSET_Y: -1.4,
	UMBILICAL_TOP_X_MULT: 1.6, UMBILICAL_H_MULT: 0.5, UMBILICAL_ARM_THICK_MULT: 0.65, MIN_VISUAL_RADIUS_PX: 2,
	NOZZLE_OFFSET_MULT: 3.1
});
const D_ARM_THICK = D_PAD.UMBILICAL_H_MULT * D_PAD.UMBILICAL_ARM_THICK_MULT; // 0.325: end face 1.275 .. 1.600
/** §3.8 table (3 decimals): connector y at x = 0.8 and arm length to the silhouette at x = 1.6. */
const D_PAD_TABLE = Object.freeze([
	{ n: 1, fairing: true, connY: -0.700, armLen: 0.753 },
	{ n: 1, fairing: false, connY: -0.700, armLen: 0.805 },
	{ n: 2, fairing: true, connY: -0.650, armLen: 0.750 },
	{ n: 2, fairing: false, connY: -0.650, armLen: 0.750 },
	{ n: 3, fairing: true, connY: -0.650, armLen: 0.850 },
	{ n: 3, fairing: false, connY: -0.650, armLen: 0.850 }
]);
const D_MAX_BOOSTERS = 9;
const STATE_KEYS = ['curStgIdx', 'hasFairing', 'isPayloadOnly', 'totalStg'];

/*******************************************************************
 * Design oracles
 *******************************************************************/
const assertNear = (actual, expected, tol, msg) => {
	assert.ok(Number.isFinite(actual), `${msg}: expected a finite number, got ${actual}`);
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
};
const clamp01 = (p) => Math.max(0, Math.min(1, p));
const designFuel = (fuel) => (Object.prototype.hasOwnProperty.call(D_PLUME_LEN_MULT, fuel) ? fuel : 'liquid');
/** §3.7 nominal flame length in R: lenMult x scale x throttle x (1 + (1 - p) k). */
const designFlameR = (fuel, scale, throttle, p) => {
	const f = designFuel(fuel);
	return D_PLUME_LEN_MULT[f] * scale * throttle * (1 + (1 - clamp01(p)) * D_VACUUM_STRETCH[f]);
};
/** Half-height of _drawFairing's quadratic Bézier at x (x(t) is increasing on [0, 1]; solved by bisection). */
const fairingCurveAt = (fx, fr, x) => {
	const cx = fx + D_FAIRING.LENGTH * D_FAIRING.CURVE_X;
	const cy = fr * D_FAIRING.CURVE_Y;
	const ex = fx + D_FAIRING.LENGTH;
	const xt = (t) => (1 - t) * (1 - t) * fx + 2 * t * (1 - t) * cx + t * t * ex;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = 0.5 * (lo + hi);
		if (xt(mid) < x) lo = mid; else hi = mid;
	}
	const t = 0.5 * (lo + hi);
	return (1 - t) * (1 - t) * fr + 2 * t * (1 - t) * cy;
};
/** Side-view silhouette (largest radius of the drawn parts covering x) of the held-down full stack (§3.8-1). */
const designSilhouette = (n, fairingOn) => {
	const h = D_HULL[n];
	const parts = h.bodies.map(b => ({ a: b.a, b: b.b, at: () => b.r }));
	if (fairingOn) {
		parts.push({ a: h.fairingX, b: h.fairingX + D_FAIRING.LENGTH, at: (x) => fairingCurveAt(h.fairingX, h.fairingR, x) });
	} else {
		const cx = h.fairingX + D_FAIRING.LENGTH * D_FAIRING.PAYLOAD_OFFSET;
		const hw = 0.5 * h.payloadR * D_BUS.W;
		parts.push({ a: cx - hw, b: cx + hw, at: () => 0.5 * h.payloadR * D_BUS.H });
	}
	return (x) => {
		let best = null;
		for (const p of parts) {
			if (x >= p.a && x <= p.b) {
				const r = p.at(x);
				if (best === null || r > best) best = r;
			}
		}
		return best;
	};
};
/** n named stages (S1, S2, ...) without other fields. */
const stagesOf = (n) => Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}` }));

/*******************************************************************
 * Recording canvas
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
		fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, shadowColor: '', shadowBlur: 0,
		lineCap: 'butt', lineJoin: 'miter',
		save() { stack.push({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, globalAlpha: ctx.globalAlpha }); },
		restore() { const s = stack.pop(); if (s) Object.assign(ctx, s); },
		translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {},
		beginPath() { path = []; },
		closePath() { path.push({ op: 'closePath' }); },
		moveTo(x, y) { path.push({ op: 'moveTo', x, y }); },
		lineTo(x, y) { path.push({ op: 'lineTo', x, y }); },
		quadraticCurveTo(cpx, cpy, x, y) { path.push({ op: 'quad', cpx, cpy, x, y }); },
		arc(x, y, r) { path.push({ op: 'arc', x, y, r }); },
		ellipse(x, y, rx, ry) { path.push({ op: 'ellipse', x, y, rx, ry }); },
		rect(x, y, w, h) { path.push({ op: 'rect', x, y, w, h }); },
		fill() { fills.push({ style: ctx.fillStyle, path: path.slice() }); },
		stroke() { strokes.push({ style: ctx.strokeStyle, path: path.slice() }); },
		fillRect(x, y, w, h) { fills.push({ style: ctx.fillStyle, path: [{ op: 'rect', x, y, w, h }] }); },
		strokeRect() {}, clearRect() {},
		createLinearGradient(...args) { return makeGradient('linear', args); },
		createRadialGradient(...args) { return makeGradient('radial', args); },
		setLineDash() {}, fillText() {}, strokeText() {}, drawImage() {},
		measureText(t) { return { width: String(t ?? '').length * 8 }; }
	};
	return ctx;
};
/** An SRB casing of _drawBoosters: a rect filled with its body gradient (#ffffff, casing colour, #8c95a0). */
const isBoosterCasing = (f) => f.path[0]?.op === 'rect' && f.style?.kind === 'linear' && f.style.stops.length === 3
	&& f.style.stops[0][1] === '#ffffff' && f.style.stops[2][1] === '#8c95a0';

/** Stops the plume flicker: sin(0) = 0 for liquid / hydro / ion, (0.5 - 0.5) = 0 for solid. */
const withZeroFlicker = (fn) => {
	const random = Math.random;
	const hadOwnNow = Object.prototype.hasOwnProperty.call(performance, 'now');
	const now = performance.now;
	Math.random = () => 0.5;
	performance.now = () => 0;
	try {
		return fn();
	} finally {
		Math.random = random;
		if (hadOwnNow) performance.now = now; else delete performance.now;
	}
};

/*******************************************************************
 * Renderer / HUD / Worker probes
 *******************************************************************/
const LD_R = 3; // below LOD_RADIUS_THRESHOLD (4): _drawLowDetail
const HD_R = 40;

/** A main-thread rocket object as the renderer and the HUD read it (2 stages, stage 1, fairing on, engine off). */
const stackRocket = (over = {}) => ({
	id: 1, thrustAngle: 0, colorTheme: 'orange', currentStageIndex: 0, totalStages: 2,
	stages: [{ name: 'S1', fuelType: 'liquid' }, { name: 'S2', fuelType: 'liquid' }],
	fairing: { enabled: true, isSeparated: false }, isIgnited: false, burnTime: 0, thrustRatio: 0,
	disableStaging: false, mach: 0, ambientPresRatio: 1, boosters: null, payload: { name: 'SAT' },
	...over
});

/** Low detail through draw(): payload icon or the stack ellipse (rx = length / 2, ry = width / 2). */
const lowDetailOf = (rocket) => {
	const ctx = createRecordingCtx();
	RocketRenderer.draw(ctx, rocket, 0, 0, LD_R, 1);
	const ellipses = ctx.fills.flatMap(f => f.path.filter(p => p.op === 'ellipse'));
	const bus = ctx.fills.filter(f => f.style === D_LOW.SATELLITE_BUS_COLOR && f.path[0]?.op === 'rect');
	return {
		isPayloadOnly: bus.length === 1 && ellipses.length === 0,
		hasStage1: ellipses.length === 1 && ellipses[0].rx === LD_R * D_LOW.STAGE1_LEN_RATIO * 0.5,
		widthMult: ellipses.length === 1 ? ellipses[0].ry / (LD_R * D_LOW.WIDTH_RATIO * 0.5) : null
	};
};

/** High detail through draw(): the hull draw calls and the SRB casings drawn. */
const highDetailOf = (rocket) => {
	const rec = { stage1: 0, upper: 0, sats: [] };
	const orig = { s1: RocketRenderer._drawStage1, s2: RocketRenderer._drawStage2, p: RocketRenderer._drawPayloadSatellite };
	RocketRenderer._drawStage1 = function (...args) { rec.stage1++; return orig.s1.apply(this, args); };
	RocketRenderer._drawStage2 = function (...args) { rec.upper++; return orig.s2.apply(this, args); };
	RocketRenderer._drawPayloadSatellite = function (ctx, cx, cy, r, deployed) { rec.sats.push(Boolean(deployed)); return orig.p.call(this, ctx, cx, cy, r, deployed); };
	const ctx = createRecordingCtx();
	try {
		RocketRenderer.draw(ctx, rocket, 0, 0, HD_R, 1);
	} finally {
		RocketRenderer._drawStage1 = orig.s1;
		RocketRenderer._drawStage2 = orig.s2;
		RocketRenderer._drawPayloadSatellite = orig.p;
	}
	return {
		isPayloadOnly: rec.sats.length === 1 && rec.sats[0] === true && rec.stage1 + rec.upper === 0,
		hasStage1: rec.stage1 === 1,
		casings: ctx.fills.filter(isBoosterCasing).length
	};
};

/** HUD: the STAGE line and the propulsion card header for the telemetry shown. */
const hudOf = (rocket, tm) => {
	const card = new PropulsionCard(3, 'Propulsion', createMockElement('div'));
	card.initElements();
	card.update(rocket, tm);
	return { label: TelemetryPanel.formatStageInfo(rocket, tm), header: card.ui.header.textContent, maxFuel: card.maxFuel[rocket.id] };
};

const calcStages = () => ([
	{ stageNumber: 1, dryMassT: 60, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, burnTime: 150, ofRatio: 2, isp: 300, separationDelaySec: 0.5, ignitionDelaySec: 2.0 },
	{ stageNumber: 2, dryMassT: 4, fuelMassT: 30, oxidMassT: 60, thrustKN: 900, burnTime: 300, ofRatio: 2, isp: 340, separationDelaySec: 0.5, ignitionDelaySec: 2.0 }
]);
const makeCalcRocket = (thrustData = {}) => new CalcRocket(
	7, 'SRB Unit Rocket', 0, 0, 0, 0, 0, 0, 10, 0, 20, 100, 200,
	{
		stages: calcStages(),
		payload: { name: 'Unit Sat', massT: 2, radius: 1.5 },
		fairing: { enabled: false, massT: 0 },
		isHoldDown: false,
		isIgnited: true,
		thrustAngle: 0,
		...thrustData
	}
);
/** The Worker's SRB separation: debris made by separateBoosters and the dry mass it removed from stage 1. */
const workerSeparation = (cfg) => {
	const rocket = makeCalcRocket({ boosters: cfg });
	const dry0 = rocket.stages[0].dryMassT;
	rocket.separateBoosters();
	const srb = rocket._pendingDebris.filter(d => d.debrisSubType === 4);
	return { rocket, hasBoosters: rocket.hasBoosters, count: srb.length, masses: srb.map(d => d.mass), massSum: srb.reduce((s, d) => s + d.mass, 0), dryDrop: dry0 - rocket.stages[0].dryMassT };
};

/** The propellant sizing's hasSrbBoosters, observed through the stage-1 burn time (core thrust only with SRBs). */
const planHasSrb = (cfg) => {
	const vehicle = {
		stages: [
			{ fuelType: 'liquid', fuelMassT: 30, oxidMassT: 70, thrustKN: 2000, isp: 300 },
			{ fuelType: 'liquid', fuelMassT: 10, oxidMassT: 20, thrustKN: 100, isp: 340, burnTime: 300 }
		],
		boosters: (cfg === null) ? null : { ...cfg, coreThrustKN: 1000 }
	};
	const plan = presetManager.calculateMissionFlightPlan({ vehicle });
	const s0 = plan.stages[0];
	const propT = s0.fuelMassT + s0.oxidMassT;
	// Flight-plan burn time: propellant x Isp x g0 / thrust, to 0.1 s (core thrust 1000 kN with SRBs, else 2000 kN)
	const withCore = Math.round(((propT * 1000 * 300 * PHYSICS.G0) / (1000 * 1000)) * 10) / 10;
	const withStage = Math.round(((propT * 1000 * 300 * PHYSICS.G0) / (2000 * 1000)) * 10) / 10;
	assert.ok(s0.burnTime === withCore || s0.burnTime === withStage, `stage-1 burn time ${s0.burnTime} is ${withCore} or ${withStage}`);
	return s0.burnTime === withCore;
};

/*******************************************************************
 * Child processes (a hang or an out-of-memory loop fails the test instead of stopping the run)
 *******************************************************************/
const SCRIPTS_URL = new URL('../../scripts/', import.meta.url).href;
const HELPERS_URL = new URL('../test_helpers.mjs', import.meta.url).href;
const RESULT_MARK = '@@RESULT@@';
const CHILD_TIMEOUT_MS = 30000;
const runChild = (body) => {
	const code = `const SCRIPTS = ${JSON.stringify(SCRIPTS_URL)};\nconst HELPERS = ${JSON.stringify(HELPERS_URL)};\n`
		+ `const RESULT = ${JSON.stringify(RESULT_MARK)};\n${body}`;
	// A small heap makes a runaway loop end in an out-of-memory exit within seconds; no coverage from the child
	const r = spawnSync(process.execPath, ['--max-old-space-size=192', '--input-type=module', '-e', code], {
		encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, NODE_V8_COVERAGE: '' }
	});
	assert.equal(r.error, undefined, `the child finishes within ${CHILD_TIMEOUT_MS} ms (${r.error?.code})`);
	assert.equal(r.status, 0, `child exit status ${r.status}, signal ${r.signal}: ${String(r.stderr).slice(-600)}`);
	const at = r.stdout.lastIndexOf(RESULT_MARK);
	assert.ok(at >= 0, `child result: ${r.stdout.slice(-300)}`);
	return JSON.parse(r.stdout.slice(at + RESULT_MARK.length));
};
const CHILD_WORKER_HUGE_COUNT = `
const { CalcRocket } = await import(SCRIPTS + 'gravsim_calc_object.js');
const stages = [
	{ stageNumber: 1, dryMassT: 200, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, burnTime: 150, ofRatio: 2, isp: 300 },
	{ stageNumber: 2, dryMassT: 4, fuelMassT: 30, oxidMassT: 60, thrustKN: 900, burnTime: 300, ofRatio: 2, isp: 340 }
];
const rocket = new CalcRocket(7, 'Huge SRB count', 0, 0, 0, 0, 0, 0, 10, 0, 20, 100, 200, {
	stages, payload: { name: 'Sat', massT: 2, radius: 1.5 }, fairing: { enabled: false, massT: 0 },
	isHoldDown: false, isIgnited: true, thrustAngle: 0, boosters: { count: 1e9, dryMassT: 90 }
});
const dry0 = rocket.stages[0].dryMassT;
rocket.separateBoosters();
const srb = rocket._pendingDebris.filter((d) => d.debrisSubType === 4);
console.log(RESULT + JSON.stringify({ hasBoosters: rocket.hasBoosters, count: srb.length,
	massSum: srb.reduce((s, d) => s + d.mass, 0), dryDrop: dry0 - rocket.stages[0].dryMassT }));
`;
const CHILD_RENDER_HUGE_COUNT = `
const { setupMockDOM } = await import(HELPERS);
setupMockDOM();
const { RocketRenderer } = await import(SCRIPTS + 'gravsim_rocket_renderer.js');
const { TelemetryPanel } = await import(SCRIPTS + 'gravsim_telemetry_panel.js');
const makeCtx = () => {
	const rec = { casings: 0, ellipses: [] };
	let path = [];
	const impl = {
		rec, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, shadowBlur: 0, shadowColor: '',
		createLinearGradient: () => { const g = { stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; },
		createRadialGradient: () => ({ addColorStop() {} }),
		beginPath: () => { path = []; },
		ellipse: (x, y, rx, ry) => { path.push({ rx, ry }); },
		fill: () => { for (const p of path) { rec.ellipses.push(p); } },
		fillRect: () => {
			const s = impl.fillStyle;
			if (s && s.stops && s.stops.length === 3 && s.stops[0][1] === '#ffffff' && s.stops[2][1] === '#8c95a0') { rec.casings++; }
		}
	};
	return new Proxy(impl, {
		get: (t, p) => (p in t ? t[p] : () => {}),
		set: (t, p, v) => { t[p] = v; return true; }
	});
};
const CONFIGS = [{ count: 1e9 }, { count: 1e9, burnTimeSec: 100 }, { count: Infinity, burnTimeSec: 100 }, { count: -Infinity, burnTimeSec: 100 }];
const results = [];
for (const boosters of CONFIGS) {
	const rocket = { id: 1, thrustAngle: 0, colorTheme: 'orange', currentStageIndex: 0, totalStages: 2,
		stages: [{ name: 'S1' }, { name: 'S2' }], fairing: { enabled: true }, isIgnited: false, burnTime: 0, thrustRatio: 0,
		mach: 0, ambientPresRatio: 1, boosters };
	const high = makeCtx();
	RocketRenderer.draw(high, rocket, 0, 0, 40, 1);
	const low = makeCtx();
	RocketRenderer.draw(low, rocket, 0, 0, 3, 1);
	const label = TelemetryPanel.formatStageInfo(rocket, { stageIndex: 0, totalStages: 2 });
	const geometry = RocketRenderer._computeStackGeometry(rocket, 1);
	results.push({ casings: high.rec.casings, lowRy: low.rec.ellipses[0].ry, label,
		layoutCount: geometry.boosterLayout.count, layoutSlots: geometry.boosterLayout.yPositions.length });
}
console.log(RESULT + JSON.stringify(results));
`;
/** Expected SRB count of each CHILD_RENDER_HUGE_COUNT configuration (§3.1: cap 9; a non-finite count is invalid). */
const CHILD_RENDER_EXPECTED = [D_MAX_BOOSTERS, D_MAX_BOOSTERS, 2, 2];

/*******************************************************************
 * 0. Design inputs against the live configuration
 *******************************************************************/
describe('Unit 12-0: the design inputs used by the expected values equal the live configuration', () => {
	it('hull ratios, plume scales, plume lengths, low detail, Rocket radius and PAD_EFFECT', () => {
		const m = ROCKET_VISUAL.MODULES;
		const a = ROCKET_VISUAL.ALIGNMENT;
		assert.deepEqual(
			[m.STAGE1_RADIUS_RATIO, m.STAGE1_LENGTH_RATIO, m.STAGE2_RADIUS_RATIO, m.STAGE2_LENGTH_RATIO, m.STAGE3_RADIUS_RATIO, m.STAGE3_LENGTH_RATIO],
			[0.7, 2.8, 0.65, 1.2, 0.55, 0.9]);
		assert.deepEqual([m.INTERSTAGE_LENGTH_RATIO, m.INTERSTAGE2_LENGTH_RATIO, m.NOZZLE1_LENGTH_RATIO, m.NOZZLE2_LENGTH_RATIO, m.NOZZLE3_LENGTH_RATIO],
			[0.35, 0.25, 0.35, 0.32, 0.28]);
		assert.deepEqual([m.FAIRING_LENGTH_RATIO, m.FAIRING_CURVE_X_RATIO, m.FAIRING_CURVE_Y_RATIO, a.PAYLOAD_OFFSET_RATIO],
			[D_FAIRING.LENGTH, D_FAIRING.CURVE_X, D_FAIRING.CURVE_Y, D_FAIRING.PAYLOAD_OFFSET]);
		assert.deepEqual([m.SATELLITE_BUS_W_RATIO, m.SATELLITE_BUS_H_RATIO], [D_BUS.W, D_BUS.H]);
		assert.deepEqual(
			[a.BASE_X_STAGE1_RATIO, a.BASE_X_UPPER_RATIO, a.BASE_X_SINGLE_STAGE_RATIO, a.BASE_X_3STG_STAGE1_RATIO, a.BASE_X_3STG_STAGE2_RATIO, a.BASE_X_3STG_STAGE3_RATIO],
			[0.4, -0.6, -1.5, -3.1, -1.6, -0.9]);
		assert.deepEqual([a.MAIN_PLUME_SCALE, a.UPPER_PLUME_SCALE, a.STAGE3_PLUME_SCALE, a.PAYLOAD_PLUME_SCALE], [1.0, 0.65, 0.5, D_PAYLOAD_PLUME_SCALE]);
		for (const [fuel, lenMult] of Object.entries(D_PLUME_LEN_MULT)) {
			assert.equal(ROCKET_VISUAL.PLUMES[fuel].lenMult, lenMult, `${fuel} lenMult`);
		}
		assert.equal(ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD, D_THRUST_THRESHOLD);
		assert.equal(ROCKET_VISUAL.MIN_SCREEN_RADIUS, D_MIN_SCREEN_RADIUS);
		assert.equal(ROCKET_VISUAL.LOD_RADIUS_THRESHOLD, D_LOD_RADIUS_THRESHOLD);
		const low = ROCKET_VISUAL.LOW_DETAIL;
		assert.deepEqual([low.STAGE1_LEN_RATIO, low.STAGE2_LEN_RATIO, low.WIDTH_RATIO, low.SATELLITE_BUS_COLOR],
			[D_LOW.STAGE1_LEN_RATIO, D_LOW.STAGE2_LEN_RATIO, D_LOW.WIDTH_RATIO, D_LOW.SATELLITE_BUS_COLOR]);
		assert.equal(presetManager.getObjectParam('Rocket').RADIUS, D_ROCKET_PARAM_RADIUS);
		const s = PAD_EFFECT.STRUCTURE;
		assert.deepEqual(
			[s.CABLE_CONN_X_MULT, s.CABLE_CONN_Y_MULT, s.UMBILICAL_ARM_LEN_MULT, s.UMBILICAL_OFFSET_Y, s.UMBILICAL_TOP_X_MULT, s.UMBILICAL_H_MULT, s.UMBILICAL_ARM_THICK_MULT],
			[D_PAD.CABLE_CONN_X_MULT, D_PAD.CABLE_CONN_Y_MULT, D_PAD.UMBILICAL_ARM_LEN_MULT, D_PAD.UMBILICAL_OFFSET_Y, D_PAD.UMBILICAL_TOP_X_MULT, D_PAD.UMBILICAL_H_MULT, D_PAD.UMBILICAL_ARM_THICK_MULT]);
		assert.equal(PAD_EFFECT.PHYSICS.MIN_VISUAL_RADIUS_PX, D_PAD.MIN_VISUAL_RADIUS_PX);
		assert.equal(PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT, D_PAD.NOZZLE_OFFSET_MULT);
	});

	it('the R = 1 hull of the full stack is the design hull (the pad and smoke oracles build on it)', () => {
		for (const n of [1, 2, 3]) {
			const g = RocketRenderer._computeStackGeometry({ stages: stagesOf(n), currentStageIndex: 0, fairing: { enabled: true } }, 1);
			const bodies = g.segments.slice().reverse();
			assert.equal(bodies.length, D_HULL[n].bodies.length, `${n}-stage body count`);
			bodies.forEach((seg, i) => {
				const d = D_HULL[n].bodies[i];
				assertNear(seg.startX, d.a, 1e-12, `${n}-stage body ${i} aft end`);
				assertNear(seg.startX + seg.length, d.b, 1e-12, `${n}-stage body ${i} forward end`);
				assert.equal(seg.radius, d.r, `${n}-stage body ${i} radius`);
			});
			assertNear(g.fairing.startX, D_HULL[n].fairingX, 1e-12, `${n}-stage fairing base`);
			assert.equal(g.fairing.radius, D_HULL[n].fairingR);
			assertNear(g.plume.x, D_NOZZLE_X[n][0], 1e-12, `${n}-stage nozzle`);
		}
	});
});

/*******************************************************************
 * 1. RocketStackUtils (§5.1-1)
 *******************************************************************/
describe('Unit 12-1: RocketStackUtils (design §3.1, test plan §5.1-1)', () => {
	const S = (curStgIdx, totalStg, isPayloadOnly, hasFairing) => ({ curStgIdx, totalStg, isPayloadOnly, hasFairing });
	const two = () => [{}, {}];
	const three = () => [{}, {}, {}];
	/** [name, rocket, telemetry argument ('omit' to leave it out), expected state] */
	const check = (cases) => {
		for (const [name, rocket, tm, expected] of cases) {
			const got = (tm === 'omit') ? RocketStackUtils.resolveStackState(rocket) : RocketStackUtils.resolveStackState(rocket, tm);
			assert.deepEqual(got, expected, name);
		}
	};

	describe('resolveStackState', () => {
		it('normal: each configuration (stage index, stage count, payload only, fairing) from the rocket telemetry', () => {
			check([
				['2-stage, stage 1, fairing on', { stages: two(), fairing: { enabled: true }, telemetry: { stageIndex: 0, totalStages: 2 } }, 'omit', S(0, 2, false, true)],
				['2-stage, stage 2, fairing separated (telemetry)', { stages: two(), fairing: { enabled: true }, telemetry: { stageIndex: 1, totalStages: 2, isFairingSeparated: true } }, 'omit', S(1, 2, false, false)],
				['2-stage, fairing separated (rocket)', { stages: two(), fairing: { enabled: true, isSeparated: true }, telemetry: { stageIndex: 0, totalStages: 2 } }, 'omit', S(0, 2, false, false)],
				['fairing not configured', { stages: two(), fairing: { enabled: false }, telemetry: { stageIndex: 0, totalStages: 2 } }, 'omit', S(0, 2, false, false)],
				['fairing null', { stages: two(), fairing: null, telemetry: { stageIndex: 0, totalStages: 2 } }, 'omit', S(0, 2, false, false)],
				['3-stage, stage 3', { stages: three(), fairing: { enabled: true }, telemetry: { stageIndex: 2, totalStages: 3 } }, 'omit', S(2, 3, false, true)],
				['1-stage', { stages: [{}], fairing: { enabled: true }, telemetry: { stageIndex: 0, totalStages: 1 } }, 'omit', S(0, 1, false, true)],
				['payload separated (rocket flag)', { stages: two(), isPayloadSeparated: true, telemetry: { stageIndex: 2, totalStages: 2 } }, 'omit', S(2, 2, true, false)],
				['payload separated (telemetry flag, stale index)', { stages: two(), telemetry: { stageIndex: 1, totalStages: 2, isPayloadSeparated: true } }, 'omit', S(1, 2, true, false)]
			]);
		});

		it('boundary: stageIndex = totalStages - 1 is a stack, = totalStages and beyond is the payload alone', () => {
			check([
				['index = count - 1 (2)', { stages: two(), telemetry: { stageIndex: 1, totalStages: 2 } }, 'omit', S(1, 2, false, false)],
				['index = count (2)', { stages: two(), telemetry: { stageIndex: 2, totalStages: 2 } }, 'omit', S(2, 2, true, false)],
				['index = count + 3 (2): the payload phase, the index clamped to the count', { stages: two(), telemetry: { stageIndex: 5, totalStages: 2 } }, 'omit', S(2, 2, true, false)],
				['index = count - 1 (3)', { stages: three(), telemetry: { stageIndex: 2, totalStages: 3 } }, 'omit', S(2, 3, false, false)],
				['index = count (3)', { stages: three(), telemetry: { stageIndex: 3, totalStages: 3 } }, 'omit', S(3, 3, true, false)],
				['index = count (1)', { stages: [{}], telemetry: { stageIndex: 1, totalStages: 1 } }, 'omit', S(1, 1, true, false)],
				['no telemetry: currentStageIndex = stages.length', { stages: two(), currentStageIndex: 2 }, 'omit', S(2, 2, true, false)],
				['no telemetry: currentStageIndex = stages.length - 1', { stages: two(), currentStageIndex: 1 }, 'omit', S(1, 2, false, false)]
			]);
		});

		it('boundary: the stage count falls back from telemetry.totalStages to stages.length to 1', () => {
			check([
				['telemetry count wins over stages.length', { stages: two(), telemetry: { stageIndex: 2, totalStages: 3 } }, 'omit', S(2, 3, false, false)],
				['telemetry count 0 -> stages.length', { stages: three(), telemetry: { stageIndex: 0, totalStages: 0 } }, 'omit', S(0, 3, false, false)],
				['telemetry count null -> stages.length', { stages: three(), telemetry: { stageIndex: 0, totalStages: null } }, 'omit', S(0, 3, false, false)],
				['telemetry count NaN -> stages.length', { stages: three(), telemetry: { stageIndex: 0, totalStages: NaN } }, 'omit', S(0, 3, false, false)],
				['no stages array: count 1, never payload by index, the index reads as its one stage', { currentStageIndex: 5 }, 'omit', S(0, 1, false, false)],
				['empty stages: count 1, index 0 is a stack', { stages: [], currentStageIndex: 0 }, 'omit', S(0, 1, false, false)],
				['empty stages: count 1, index 1 is the payload alone', { stages: [], currentStageIndex: 1 }, 'omit', S(1, 1, true, false)]
			]);
		});

		it('abnormal: a null / NaN telemetry stage index reads as 0 (no fallback); undefined falls back to currentStageIndex', () => {
			check([
				['telemetry index null', { stages: two(), currentStageIndex: 1, telemetry: { stageIndex: null, totalStages: 2 } }, 'omit', S(0, 2, false, false)],
				['telemetry index NaN', { stages: two(), currentStageIndex: 1, telemetry: { stageIndex: NaN, totalStages: 2 } }, 'omit', S(0, 2, false, false)],
				['telemetry index undefined (present)', { stages: two(), currentStageIndex: 1, telemetry: { stageIndex: undefined, totalStages: 2 } }, 'omit', S(1, 2, false, false)],
				['telemetry index absent', { stages: two(), currentStageIndex: 2, telemetry: { totalStages: 2 } }, 'omit', S(2, 2, true, false)],
				['rocket index null', { stages: two(), currentStageIndex: null }, 'omit', S(0, 2, false, false)],
				['rocket index NaN', { stages: two(), currentStageIndex: NaN }, 'omit', S(0, 2, false, false)],
				['rocket index undefined', { stages: two() }, 'omit', S(0, 2, false, false)]
			]);
		});

		it('abnormal: disableStaging never flies the payload alone and always keeps the fairing', () => {
			check([
				['separated flags and index = count: the index reads as the last stage', { stages: two(), disableStaging: true, isPayloadSeparated: true, fairing: { enabled: true, isSeparated: true }, telemetry: { stageIndex: 2, totalStages: 2, isPayloadSeparated: true, isFairingSeparated: true } }, 'omit', S(1, 2, false, true)],
				['single stage at index 1: its stage 1', { stages: [{}], disableStaging: true, currentStageIndex: 1 }, 'omit', S(0, 1, false, true)],
				['no fairing configured', { stages: [{}], disableStaging: true, fairing: null }, 'omit', S(0, 1, false, true)]
			]);
		});

		it('boundary: the index is a whole number in [0, count] (normalizeStageIndex), at most the last stage out of the payload phase (design §3.1)', () => {
			check([
				['index -1 (2 stages): the first stage', { stages: two(), currentStageIndex: -1 }, 'omit', S(0, 2, false, false)],
				['index -1 (3 stages): the first stage', { stages: three(), currentStageIndex: -1 }, 'omit', S(0, 3, false, false)],
				['index -1 (no stages): its one stage', { currentStageIndex: -1 }, 'omit', S(0, 1, false, false)],
				['index 0.5 (2 stages): rounded down to the first stage', { stages: two(), currentStageIndex: 0.5 }, 'omit', S(0, 2, false, false)],
				['index 1.5 (3 stages): rounded down to stage 2', { stages: three(), currentStageIndex: 1.5 }, 'omit', S(1, 3, false, false)],
				['index 1.999 (2 stages): rounded down to stage 2, not the payload phase', { stages: two(), currentStageIndex: 1.999 }, 'omit', S(1, 2, false, false)],
				['index 0 (3 stages): kept', { stages: three(), currentStageIndex: 0 }, 'omit', S(0, 3, false, false)],
				['index 1 (3 stages): kept', { stages: three(), currentStageIndex: 1 }, 'omit', S(1, 3, false, false)],
				['index "2" (3 stages): the number', { stages: three(), currentStageIndex: '2' }, 'omit', S(2, 3, false, false)],
				['disableStaging, index = count - 1 (3): kept', { stages: three(), disableStaging: true, currentStageIndex: 2 }, 'omit', S(2, 3, false, true)],
				['disableStaging, index = count (3): the last stage', { stages: three(), disableStaging: true, currentStageIndex: 3 }, 'omit', S(2, 3, false, true)],
				['disableStaging, index Infinity (2): the last stage', { stages: two(), disableStaging: true, currentStageIndex: Infinity }, 'omit', S(1, 2, false, true)],
				['no stages, telemetry index 1 of 1: its one stage', { telemetry: { stageIndex: 1, totalStages: 1 } }, 'omit', S(0, 1, false, false)],
				['the payload phase by the index: clamped to the count (count + 1)', { stages: two(), currentStageIndex: 3 }, 'omit', S(2, 2, true, false)],
				['the payload phase by the flag keeps index 0', { stages: two(), currentStageIndex: 0, isPayloadSeparated: true }, 'omit', S(0, 2, true, false)]
			]);
		});

		it('normalizeStageIndex: whole number, rounded down, clamped to [0, count]; a disableStaging vehicle at most its last stage', () => {
			const N = RocketStackUtils.normalizeStageIndex;
			const cases = [
				// [value, count, disableStaging, expected]
				[0, 2, false, 0], [1, 2, false, 1], [2, 2, false, 2], [3, 2, false, 2], [Infinity, 2, false, 2],
				[-1, 2, false, 0], [-Infinity, 2, false, 0], [-0.5, 2, false, 0], [0.5, 2, false, 0], [1.9, 2, false, 1], [2.5, 2, false, 2],
				[NaN, 2, false, 0], [null, 2, false, 0], [undefined, 2, false, 0], ['1', 2, false, 1], ['1.5', 2, false, 1], ['', 2, false, 0],
				['abc', 2, false, 0], [true, 2, false, 1], [false, 2, false, 0], [[1], 2, false, 1], [{}, 2, false, 0],
				[2, 2, true, 1], [5, 3, true, 2], [Infinity, 2, true, 1], [1, 2, true, 1], [0, 1, true, 0], [1, 1, true, 0],
				[0, 0, false, 0], [3, 0, false, 0], [3, 0, true, 0]
			];
			for (const [value, count, ds, expected] of cases) {
				assert.ok(Object.is(N(value, count, ds), expected), `${String(value)} of ${count}${ds ? ', disableStaging' : ''}: ${N(value, count, ds)} vs ${expected}`);
			}
			assert.equal(N(5, 3), 3, 'disableStaging defaults to false');
		});

		it('abnormal: a null / undefined rocket does not throw and gives the default state', () => {
			check([
				['null', null, 'omit', S(0, 1, false, false)],
				['undefined', undefined, 'omit', S(0, 1, false, false)],
				['null with null telemetry', null, null, S(0, 1, false, false)],
				['null rocket, telemetry at index = count: no stages, so still a stack, at its last stage', null, { stageIndex: 2, totalStages: 2 }, S(1, 2, false, false)],
				['null rocket, telemetry payload flag', undefined, { stageIndex: 0, totalStages: 1, isPayloadSeparated: true }, S(0, 1, true, false)],
				['null rocket, telemetry fairing flag', null, { isFairingSeparated: true }, S(0, 1, false, false)]
			]);
		});

		it('the telemetry argument: omitted or undefined uses rocket.telemetry; explicit values replace it; null means none', () => {
			const rocket = { stages: two(), currentStageIndex: 1, fairing: { enabled: true }, telemetry: { stageIndex: 0, totalStages: 2 } };
			check([
				['omitted', rocket, 'omit', S(0, 2, false, true)],
				['undefined (default parameter)', rocket, undefined, S(0, 2, false, true)],
				['explicit other telemetry', rocket, { stageIndex: 2, totalStages: 2 }, S(2, 2, true, true)],
				['explicit telemetry with the fairing flag', rocket, { stageIndex: 1, totalStages: 2, isFairingSeparated: true }, S(1, 2, false, false)],
				['explicit null: the rocket fields alone', rocket, null, S(1, 2, false, true)],
				['explicit {}: the rocket fields alone', rocket, {}, S(1, 2, false, true)],
				['rocket.telemetry null, omitted', { ...rocket, telemetry: null }, 'omit', S(1, 2, false, true)]
			]);
		});

		it('returns exactly the four fields, with boolean flags', () => {
			for (const rocket of [null, {}, { stages: two(), fairing: { enabled: 1 }, isPayloadSeparated: 1 }, { stages: two(), disableStaging: 1 }]) {
				const s = RocketStackUtils.resolveStackState(rocket);
				assert.deepEqual(Object.keys(s).sort(), STATE_KEYS);
				assert.equal(typeof s.isPayloadOnly, 'boolean');
				assert.equal(typeof s.hasFairing, 'boolean');
			}
		});
	});

	describe('resolveBoosters', () => {
		it('reads rocket.boosters only (the configuration ObjectManager sends to the Worker)', () => {
			const boosters = { count: 2, burnTimeSec: 100 };
			assert.equal(RocketStackUtils.resolveBoosters({ boosters }), boosters, 'the same object');
			const zero = { count: 0 };
			assert.equal(RocketStackUtils.resolveBoosters({ boosters: zero }), zero, 'a zero-count configuration is still the configuration');
			assert.equal(RocketStackUtils.resolveBoosters({ boosters, rendering: { boosters: { count: 4 } }, stages: [{ boosters: { count: 4 } }] }), boosters);
			assert.equal(RocketStackUtils.resolveBoosters({ rendering: { boosters: { count: 2 } } }), null, 'rendering.boosters alone');
			assert.equal(RocketStackUtils.resolveBoosters({ stages: [{ boosters: { count: 4 } }] }), null, 'stages[0].boosters alone');
			assert.equal(RocketStackUtils.resolveBoosters({ boosters: null, rendering: { boosters: { count: 2 } }, stages: [{ boosters: { count: 4 } }] }), null);
		});

		it('abnormal: a missing or falsy configuration and a null / undefined rocket give null', () => {
			for (const value of [undefined, null, 0, false, '']) {
				assert.equal(RocketStackUtils.resolveBoosters({ boosters: value }), null, String(value));
			}
			assert.equal(RocketStackUtils.resolveBoosters({}), null);
			assert.equal(RocketStackUtils.resolveBoosters(null), null);
			assert.equal(RocketStackUtils.resolveBoosters(undefined), null);
		});
	});

	describe('boosterCount', () => {
		// Counts that are a finite number >= 1 after Number(): rounded down, capped at 9; the burn time does not matter
		const VALID = [
			[1, 1], [2, 2], [3, 3], [4, 4], [8, 8], [9, 9], [10, 9], [12, 9], [1e9, 9], [Number.MAX_VALUE, 9],
			[1.0, 1], [1.999, 1], [2.5, 2], [4.9, 4], [9.99, 9], ['4', 4], [' 4 ', 4], ['4.7', 4], ['1e9', 9], ['12', 9],
			[[4], 4], [['4'], 4], [true, 1]
		];
		// Counts that are not: 0, missing, NaN, null, negative, below 1, strings / values that are not a count, infinite
		const INVALID = [0, -0, undefined, null, NaN, -1, -4, -1e9, 0.5, 0.999999, '0', '', ' ', 'abc', '-4', [], [4, 5], {}, Infinity, -Infinity, false];
		// Burn times: a finite positive number (after Number()) gives the 2 SRBs of a burning configuration, else 0
		const BURNS = [[105, 2], ['105', 2], [1e-9, 2], [1e9, 2], [0, 0], [-5, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0], [null, 0], [undefined, 0], ['abc', 0], [[], 0]];

		it('normal: a count of at least 1 is used, rounded down and capped at 9 (with and without a burn time)', () => {
			for (const [count, expected] of VALID) {
				for (const burn of [undefined, 0, 105, Infinity]) {
					assert.equal(RocketStackUtils.boosterCount({ count, burnTimeSec: burn }), expected, `count ${JSON.stringify(count)} (${String(count)}), burn ${burn}`);
				}
			}
		});

		it('boundary: the cap is 9 at 9, 10, 12 and 1e9; fractions 2.5 -> 2 and 0.5 -> the burn-time rule', () => {
			assert.equal(RocketStackUtils.boosterCount({ count: 9 }), D_MAX_BOOSTERS);
			assert.equal(RocketStackUtils.boosterCount({ count: 10 }), D_MAX_BOOSTERS);
			assert.equal(RocketStackUtils.boosterCount({ count: 12 }), D_MAX_BOOSTERS);
			assert.equal(RocketStackUtils.boosterCount({ count: 1e9 }), D_MAX_BOOSTERS);
			assert.equal(RocketStackUtils.boosterCount({ count: 2.5 }), 2);
			assert.equal(RocketStackUtils.boosterCount({ count: 2.5, burnTimeSec: 100 }), 2);
			assert.equal(RocketStackUtils.boosterCount({ count: 0.5 }), 0);
			assert.equal(RocketStackUtils.boosterCount({ count: 0.5, burnTimeSec: 100 }), 2);
			assert.equal(RocketStackUtils.boosterCount({ count: 1 }), 1, 'exactly 1');
			assert.equal(RocketStackUtils.boosterCount({ count: 1 - Number.EPSILON / 2 }), 0, 'just below 1');
		});

		it('abnormal: an invalid count (0, missing, NaN, null, negative, string, not finite) falls back to the burn time', () => {
			for (const count of INVALID) {
				for (const [burn, expected] of BURNS) {
					assert.equal(RocketStackUtils.boosterCount({ count, burnTimeSec: burn }), expected, `count ${String(count)}, burn ${String(burn)}`);
				}
				assert.equal(RocketStackUtils.boosterCount({ count }), 0, `count ${String(count)} without a burn time`);
			}
		});

		it('abnormal: a missing configuration is 0', () => {
			for (const cfg of [null, undefined, 0, false, '', {}]) {
				assert.equal(RocketStackUtils.boosterCount(cfg), 0, String(cfg));
			}
		});

		it('the JSON copy the Worker receives gives the same count (non-finite values become null there)', () => {
			const configs = [];
			for (const [count] of VALID) configs.push({ count }, { count, burnTimeSec: 105 });
			for (const count of INVALID) for (const [burnTimeSec] of BURNS) configs.push({ count, burnTimeSec });
			for (const cfg of configs) {
				const copy = JSON.parse(JSON.stringify(cfg));
				assert.equal(RocketStackUtils.boosterCount(copy), RocketStackUtils.boosterCount(cfg), `${String(cfg.count)} / ${String(cfg.burnTimeSec)}`);
				// CalcRocket gets it through normalizeRocketConfig's JSON copy
				const calc = makeCalcRocket({ boosters: cfg });
				assert.equal(RocketStackUtils.boosterCount(calc.boosters), RocketStackUtils.boosterCount(cfg), `CalcRocket copy ${String(cfg.count)} / ${String(cfg.burnTimeSec)}`);
			}
		});
	});

	describe('boosterCount(...) > 0 is the Worker hasBoosters and the propellant sizing hasSrbBoosters', () => {
		const CONFIGS = [
			null, {}, { count: 2 }, { count: 4 }, { count: 0 }, { count: 0, burnTimeSec: 105 }, { burnTimeSec: 105 },
			{ count: NaN, burnTimeSec: 105 }, { count: null }, { count: -1 }, { count: -1, burnTimeSec: 105 }, { count: '0' },
			{ count: '4' }, { count: [4] }, { count: 0.5 }, { count: 0.5, burnTimeSec: 105 }, { count: 12 }, { count: 2.5 },
			{ count: Infinity }, { count: Infinity, burnTimeSec: 105 }, { burnTimeSec: Infinity }, { burnTimeSec: '105' }
		];

		it('CalcRocket.hasBoosters', () => {
			for (const cfg of CONFIGS) {
				const expected = RocketStackUtils.boosterCount(cfg) > 0;
				assert.equal(makeCalcRocket({ boosters: cfg }).hasBoosters, expected, JSON.stringify(cfg) + ` (${String(cfg?.count)})`);
			}
		});

		it('PresetManager.calculateMissionFlightPlan (core thrust for the stage-1 burn only with SRBs)', () => {
			for (const cfg of CONFIGS) {
				const expected = RocketStackUtils.boosterCount(cfg) > 0;
				assert.equal(planHasSrb(cfg), expected, JSON.stringify(cfg) + ` (${String(cfg?.count)})`);
			}
		});

		it('the Worker sees no SRB in rendering.boosters or stages[0].boosters alone', () => {
			const stages = calcStages();
			stages[0].boosters = { count: 4, burnTimeSec: 105 };
			const rocket = makeCalcRocket({ stages, rendering: { boosters: { count: 2, burnTimeSec: 105 } } });
			assert.equal(rocket.boosters, null);
			assert.equal(rocket.hasBoosters, false);
		});
	});

	describe('Worker separation (separateBoosters) with the count rule', () => {
		it('normal / boundary: at the cap and with a floored count it makes that many casings summing to the dry mass', () => {
			const cases = [
				[{ count: 9, dryMassT: 36 }, 9, 36],
				[{ count: 10, dryMassT: 36 }, 9, 36],
				[{ count: 12, dryMassT: 36 }, 9, 36],
				[{ count: 2.5, dryMassT: 30 }, 2, 30],
				[{ count: 4.9, dryMassT: 32 }, 4, 32],
				[{ count: 3 }, 3, 20], // dry mass default 20 t unless 4 SRBs
				[{ count: 4 }, 4, 40], // 40 t for 4 SRBs
				[{ count: 4.9 }, 4, 40], // the default follows the floored count
				[{ count: '4' }, 4, 40], // and the count as a number
				[{ count: [4] }, 4, 40],
				[{ count: 12 }, 9, 20],
				[{ count: 0, burnTimeSec: 105 }, 2, 20],
				[{ count: -1, burnTimeSec: 105, dryMassT: 18 }, 2, 18],
				[{ count: '0', burnTimeSec: 105 }, 2, 20]
			];
			for (const [cfg, count, dryT] of cases) {
				const sep = workerSeparation(cfg);
				const name = `${JSON.stringify(cfg)} (count ${String(cfg.count)})`;
				assert.equal(sep.hasBoosters, true, name);
				assert.equal(sep.count, count, `${name}: casings`);
				assertNear(sep.massSum, dryT, 1e-9, `${name}: casing mass sum`);
				for (const m of sep.masses) assertNear(m, dryT / count, 1e-12, `${name}: equal casings`);
				assertNear(sep.dryDrop, dryT, 1e-9, `${name}: stage-1 dry mass removed`);
				assert.equal(sep.rocket.isBoosterSeparated, true);
				// A second call adds nothing
				sep.rocket.separateBoosters();
				assert.equal(sep.rocket._pendingDebris.filter(d => d.debrisSubType === 4).length, count, `${name}: once`);
			}
		});

		it('abnormal: no SRB (count 0 without a burn time, or no configuration) separates nothing', () => {
			for (const cfg of [{ count: 0 }, { count: -2 }, { count: 0.5 }, null]) {
				const sep = workerSeparation(cfg);
				assert.equal(sep.hasBoosters, false, JSON.stringify(cfg));
				assert.equal(sep.count, 0);
				assert.equal(sep.dryDrop, 0);
				assert.equal(sep.rocket.isBoosterSeparated, false);
			}
		});

		it('regression (§1.4.1 (f)): a count of 1e9 makes 9 casings and finishes (child process with a time and heap limit)', () => {
			const out = runChild(CHILD_WORKER_HUGE_COUNT);
			assert.equal(out.hasBoosters, true);
			assert.equal(out.count, D_MAX_BOOSTERS);
			assertNear(out.massSum, 90, 1e-9, 'casing mass sum');
			assertNear(out.dryDrop, 90, 1e-9, 'stage-1 dry mass removed');
		});
	});
});

/*******************************************************************
 * 2. Rule agreement (§5.1-2)
 *******************************************************************/
describe('Unit 12-2: one rule for the renderer (both LODs), the HUD and the Worker (test plan §5.1-2)', () => {
	describe('payload phase and stage on mismatched telemetry / rocket inputs', () => {
		const PAYLOAD_WITH_TANKS = Object.freeze({ name: 'SAT', propulsion: Object.freeze({ enabled: true, fuelMassT: 7, oxidMassT: 3 }) });
		const CASES = [
			{ name: '§5.4 row 1: telemetry stage 2 of 2, rocket.currentStageIndex 1', over: { currentStageIndex: 1, telemetry: { stageIndex: 2, totalStages: 2 } }, payload: true },
			{ name: '§5.4 row 2: no telemetry, currentStageIndex 2, no totalStages, 2 stages', over: { currentStageIndex: 2, totalStages: undefined, telemetry: undefined }, payload: true },
			{ name: 'rocket.isPayloadSeparated with a stale stage-2 telemetry', over: { currentStageIndex: 1, isPayloadSeparated: true, telemetry: { stageIndex: 1, totalStages: 2 } }, payload: true },
			{ name: 'telemetry stage 2 of 2 (index 1), rocket.currentStageIndex 2 = totalStages', over: { currentStageIndex: 2, totalStages: 2, telemetry: { stageIndex: 1, totalStages: 2 } }, payload: false, stage1: false, label: '2 / 2 (S2)', header: '[ PROPULSION: S2 ]' },
			{ name: 'telemetry stage index null, rocket.currentStageIndex 1', over: { currentStageIndex: 1, telemetry: { stageIndex: null, totalStages: 2 } }, payload: false, stage1: true, label: '1 / 2 (S1)', header: '[ PROPULSION: S1 ]' },
			{ name: 'telemetry stage index NaN, rocket.currentStageIndex 1', over: { currentStageIndex: 1, telemetry: { stageIndex: NaN, totalStages: 2 } }, payload: false, stage1: true, label: '1 / 2 (S1)', header: '[ PROPULSION: S1 ]' },
			// Design §3.1: disableStaging never flies the payload alone, whatever the separation flags say (Gate 3 Iteration 2 watchpoint 5)
			{ name: 'disableStaging with the payload-separated flags on the rocket and the telemetry, stage 2 of 2', over: { disableStaging: true, currentStageIndex: 1, isPayloadSeparated: true, telemetry: { stageIndex: 1, totalStages: 2, isPayloadSeparated: true } }, payload: false, stage1: false, label: '2 / 2 (S2)', header: '[ PROPULSION: S2 ]' },
			// Design §3.1 and §1.4.1 (c): an object without stages is one stage; its index never makes the payload phase, its flag does.
			// The propulsion card shows its tank header for a vehicle without several stages
			// The card shows no stage in its header there, so its payload phase is seen in the tank maximum it starts from: the
			// payload's own tanks (7 t of fuel here) in the payload phase only
			{ name: 'no stages, no telemetry: one stage (CORE)', over: { stages: undefined, totalStages: undefined, currentStageIndex: 0, telemetry: undefined, payload: PAYLOAD_WITH_TANKS }, payload: false, stage1: true, label: '1 / 1 (CORE)', header: '[ PROPULSION & TANKS ]', payloadTanks: false },
			{ name: 'no stages at stage index 1: its one stage everywhere (stage 1 in both LODs and the HUD), never the payload phase by the index', over: { stages: undefined, totalStages: undefined, currentStageIndex: 1, telemetry: undefined, payload: PAYLOAD_WITH_TANKS }, payload: false, stage1: true, label: '1 / 1 (CORE)', header: '[ PROPULSION & TANKS ]', payloadTanks: false },
			{ name: 'no stages, telemetry stage index 1: the same', over: { stages: undefined, totalStages: undefined, currentStageIndex: 0, telemetry: { stageIndex: 1 }, payload: PAYLOAD_WITH_TANKS }, payload: false, stage1: true, label: '1 / 1 (CORE)', header: '[ PROPULSION & TANKS ]', payloadTanks: false },
			{ name: 'no stages with rocket.isPayloadSeparated: the payload phase', over: { stages: undefined, totalStages: undefined, currentStageIndex: 0, isPayloadSeparated: true, telemetry: undefined, payload: PAYLOAD_WITH_TANKS }, payload: true, header: '[ PROPULSION & TANKS ]', payloadTanks: true }
		];

		for (const c of CASES) {
			it(c.name, () => {
				const rocket = stackRocket(c.over);
				// The HUD shows the rocket's telemetry (TelemetryPanel passes target.telemetry), {} when it has none
				const tm = rocket.telemetry || {};
				const low = lowDetailOf(rocket);
				const high = highDetailOf(rocket);
				const hud = hudOf(rocket, tm);
				assert.equal(low.isPayloadOnly, c.payload, 'low detail');
				assert.equal(high.isPayloadOnly, c.payload, 'high detail');
				if (c.payload) {
					assert.equal(hud.label, 'PAYLOAD (SAT)', 'STAGE line');
					assert.equal(hud.header, c.header ?? '[ PROPULSION: PAYLOAD ]', 'propulsion card');
				} else {
					assert.equal(low.hasStage1, c.stage1, 'low detail stage 1');
					assert.equal(high.hasStage1, c.stage1, 'high detail stage 1');
					assert.equal(hud.label, c.label, 'STAGE line');
					assert.equal(hud.header, c.header, 'propulsion card');
				}
				if (c.payloadTanks !== undefined) {
					assert.equal(hud.maxFuel === PAYLOAD_WITH_TANKS.propulsion.fuelMassT, c.payloadTanks, `propulsion card: tank maximum ${hud.maxFuel}`);
				}
				// One rule: the HUD (with the telemetry it shows) and the renderer (the rocket's own) resolve the same state
				const state = RocketStackUtils.resolveStackState(rocket, tm);
				assert.deepEqual(state, RocketStackUtils.resolveStackState(rocket), 'the HUD and the renderer resolve the same state');
				assert.equal(state.isPayloadOnly, c.payload, 'rule');
			});
		}
	});

	describe('the current stage of every stack state is the same for the renderer (both LODs, the geometry, the plume) and the HUD (Gate 3 G3-4-01, G3-4-02)', () => {
		// Design §3.1: the index as a whole number in [0, count] (rounded down, clamped), the payload phase as before, and
		// out of it at most the last stage
		const STAGE_FUELS = ['solid', 'liquid', 'hydro'];
		const STAGE_FUEL_T = [100, 40, 10];
		const designStage = (n, idx, disableStaging, hasStages) => {
			const index = Math.max(0, Math.min(Math.floor(idx), n));
			const payload = !disableStaging && hasStages && index >= n;
			const cur = payload ? index : Math.min(index, n - 1);
			return { payload, cur, stage1: !payload && cur === 0 };
		};
		const inputs = [];
		for (const n of [1, 2, 3]) {
			for (const idx of [...new Set([-1, 0, 0.5, 1, 2, n, n + 1])]) {
				for (const disableStaging of [false, true]) inputs.push({ n, idx, disableStaging, hasStages: true });
			}
		}
		// Objects without stages: one stage (no telemetry), or the stage count of the telemetry
		for (const idx of [-1, 0, 0.5, 1, 2]) inputs.push({ n: 1, idx, disableStaging: false, hasStages: false });
		for (const n of [2, 3]) {
			for (const idx of [...new Set([-1, 0, 0.5, 1, 2, n, n + 1])]) inputs.push({ n, idx, disableStaging: false, hasStages: false, viaTelemetry: true });
		}

		for (const c of inputs) {
			it(`${c.hasStages ? `${c.n} stage(s)` : `no stages${c.viaTelemetry ? `, telemetry count ${c.n}` : ''}`}, index ${c.idx}${c.disableStaging ? ', disableStaging' : ''}`, () => {
				const stages = c.hasStages ? Array.from({ length: c.n }, (_, i) => ({ name: `S${i + 1}`, fuelType: STAGE_FUELS[i], fuelMassT: STAGE_FUEL_T[i] })) : undefined;
				const telemetry = c.viaTelemetry ? { stageIndex: c.idx, totalStages: c.n } : undefined;
				const rocket = stackRocket({
					stages, totalStages: c.hasStages ? c.n : undefined, currentStageIndex: c.viaTelemetry ? 0 : c.idx, telemetry,
					disableStaging: c.disableStaging, boosters: { count: 2, burnTimeSec: 100 }, isIgnited: true, thrustRatio: 1, burnTime: 50
				});
				const want = designStage(c.n, c.idx, c.disableStaging, c.hasStages);
				const low = lowDetailOf(rocket);
				const high = highDetailOf(rocket);
				const g = RocketRenderer._computeStackGeometry(rocket, 1);
				// The HUD shows the rocket's telemetry ({} without one), as TelemetryPanel passes target.telemetry
				const hud = hudOf(rocket, rocket.telemetry || {});
				assert.equal(low.isPayloadOnly, want.payload, 'low detail: payload alone');
				assert.equal(high.isPayloadOnly, want.payload, 'high detail: payload alone');
				if (want.payload) {
					assert.equal(hud.label, 'PAYLOAD (SAT)', 'STAGE line');
					return;
				}
				// Stage 1 (with its SRBs) in both LODs, the geometry and the HUD's SRB tag
				assert.equal(low.hasStage1, want.stage1, 'low detail: stage 1');
				assert.equal(low.widthMult === 1.35, want.stage1, `low detail: the SRB width (${low.widthMult})`);
				assert.equal(high.hasStage1, want.stage1, 'high detail: stage 1');
				assert.equal(high.casings > 0, want.stage1, `high detail: SRB casings (${high.casings})`);
				assert.equal(g.segments.some(seg => seg.kind === 'stage' && seg.stageIndex === 0), want.stage1, 'geometry: stage 1');
				assert.equal(hud.label.endsWith(' [+SRB]'), want.stage1, `STAGE line SRB tag (${hud.label})`);
				// The stage flown: the STAGE line (the stage name, else the label's names for a vehicle without stages), the
				// card header and tank maximum, and the plume's fuel all read the same stage
				const name = stages ? stages[want.cur].name : (c.n > 1 ? (want.cur === 0 ? 'BOOSTER' : 'UPPER') : 'CORE');
				assert.ok(hud.label.startsWith(`${want.cur + 1} / ${c.n} (${name})`), `STAGE line (${hud.label})`);
				if (stages && c.n > 1) assert.equal(hud.header, `[ PROPULSION: ${name} ]`, 'propulsion card');
				if (stages) assert.equal(hud.maxFuel, stages[want.cur].fuelMassT, 'propulsion card: the tank maximum of the stage flown');
				assert.equal(g.plume.fuelType, stages ? stages[want.cur].fuelType : 'liquid', 'plume fuel of the stage flown');
				// The drawn current stage is the one of that index: the last segment of the geometry
				const body = g.segments[g.segments.length - 1];
				assert.deepEqual([body.kind, body.stageIndex], ['stage', want.cur], 'geometry: the current stage');
			});
		}
	});

	describe('SRB count', () => {
		const AGREEMENT = [
			[{ count: 2 }, 2], [{ count: 4 }, 4], [{ count: 3 }, 3],
			[{ count: 0, burnTimeSec: 100 }, 2], [{ burnTimeSec: 100 }, 2], [{ count: NaN, burnTimeSec: 100 }, 2], [{ count: null, burnTimeSec: 100 }, 2],
			[{ count: -1, burnTimeSec: 100 }, 2], [{ count: '0', burnTimeSec: 100 }, 2], [{ count: '4' }, 4], [{ count: [4] }, 4],
			[{ count: 9 }, 9], [{ count: 10 }, 9], [{ count: 12 }, 9], [{ count: 2.5 }, 2],
			[{ count: 0 }, 0], [{ count: -1 }, 0], [null, 0]
			// 1e9 and the non-finite counts are drawn in a child process below: a count rule that let them through would
			// loop without end in _drawBoosters
		];

		for (const [cfg, n] of AGREEMENT) {
			it(`${JSON.stringify(cfg)} (count ${String(cfg?.count)}) -> ${n} SRBs everywhere`, () => {
				const rocket = stackRocket({ boosters: cfg });
				assertNear(lowDetailOf(rocket).widthMult, lowWidthMult(n), 1e-12, 'low-detail width multiplier');
				assert.equal(highDetailOf(rocket).casings, n, 'high-detail casings');
				assert.equal(hudOf(rocket, { stageIndex: 0, totalStages: 2 }).label, `1 / 2 (S1)${n > 0 ? ' [+SRB]' : ''}`, 'HUD tag');
				const sep = workerSeparation(cfg);
				assert.equal(sep.hasBoosters, n > 0, 'Worker hasBoosters');
				assert.equal(sep.count, n, 'Worker separation casings');
				assert.equal(RocketStackUtils.boosterCount(cfg), n, 'the §3.1 rule');
			});
		}

		it('1e9 (capped at 9) and ±Infinity with a burn time (2): both LODs, the HUD tag and the geometry agree (child process)', () => {
			const out = runChild(CHILD_RENDER_HUGE_COUNT);
			assert.equal(out.length, CHILD_RENDER_EXPECTED.length);
			out.forEach((r, i) => {
				const n = CHILD_RENDER_EXPECTED[i];
				assert.equal(r.casings, n, `config ${i}: high-detail casings`);
				assertNear(r.lowRy / (LD_R * D_LOW.WIDTH_RATIO * 0.5), lowWidthMult(n), 1e-12, `config ${i}: low-detail width multiplier`);
				assert.equal(r.label, '1 / 2 (S1) [+SRB]', `config ${i}: HUD tag`);
				assert.equal(r.layoutCount, n, `config ${i}: geometry count`);
				assert.equal(r.layoutSlots, n, `config ${i}: geometry slots`);
			});
			// The Worker receives the JSON copy, where ±Infinity is null: the same 2 SRBs
			for (const count of [Infinity, -Infinity]) {
				const sep = workerSeparation({ count, burnTimeSec: 100 });
				assert.equal(sep.count, 2, `Worker separation, count ${count}`);
			}
		});

		it('a configuration only in rendering.boosters or stages[0].boosters is no SRB in both LODs, the HUD and the Worker', () => {
			const variants = [
				{ name: 'rendering.boosters only', over: { rendering: { boosters: { count: 2, burnTimeSec: 100 } } }, thrust: { rendering: { boosters: { count: 2, burnTimeSec: 100 } } } },
				{ name: 'stages[0].boosters only', over: { stages: [{ name: 'S1', boosters: { count: 4 } }, { name: 'S2' }] }, thrust: { stages: [{ ...calcStages()[0], boosters: { count: 4 } }, calcStages()[1]] } },
				{ name: 'boosters count 0 with rendering.boosters 2', over: { boosters: { count: 0 }, rendering: { boosters: { count: 2 } } }, thrust: { boosters: { count: 0 }, rendering: { boosters: { count: 2 } } } }
			];
			for (const v of variants) {
				const rocket = stackRocket(v.over);
				assert.equal(lowDetailOf(rocket).widthMult, 1.0, `${v.name}: low detail`);
				assert.equal(highDetailOf(rocket).casings, 0, `${v.name}: high detail`);
				assert.equal(hudOf(rocket, { stageIndex: 0, totalStages: 2 }).label, '1 / 2 (S1)', `${v.name}: HUD`);
				assert.equal(makeCalcRocket(v.thrust).hasBoosters, false, `${v.name}: Worker`);
			}
		});

		it('the SRBs are shown on stage 1 only and not after their separation (both LODs and the HUD)', () => {
			const separated = stackRocket({ boosters: { count: 4 }, isBoosterSeparated: true });
			assert.equal(lowDetailOf(separated).widthMult, 1.0);
			assert.equal(highDetailOf(separated).casings, 0);
			assert.equal(hudOf(separated, { stageIndex: 0, totalStages: 2 }).label, '1 / 2 (S1) [SRB SEP]');
			const upper = stackRocket({ boosters: { count: 4 }, currentStageIndex: 1 });
			assert.equal(lowDetailOf(upper).widthMult, 1.0);
			assert.equal(highDetailOf(upper).casings, 0);
			assert.equal(hudOf(upper, { stageIndex: 1, totalStages: 2 }).label, '2 / 2 (S2)');
		});
	});

	describe('the annunciator uses the same stage index and stage count', () => {
		const panel = new TelemetryPanel(createMockUniverse({ LaunchSequencer: { isActive: false, isAutoSequence: false }, objects: [] }));
		const lamp = (key) => panel.lamps[key].classList.contains('on');
		const thrusting = { thrustRatio: 1, fuelMass: 50, burnTime: 100, isIgnited: true, totalStages: 1 };
		const CASES = [
			{ name: 'telemetry index null (rocket index 1): stage 1 of 2', target: { stages: stagesOf(2), currentStageIndex: 1 }, tm: { stageIndex: null, totalStages: 2 }, cur: 0, total: 2, label: '1 / 2 (S1)' },
			{ name: 'telemetry index NaN (rocket index 1): stage 1 of 2', target: { stages: stagesOf(2), currentStageIndex: 1 }, tm: { stageIndex: NaN, totalStages: 2 }, cur: 0, total: 2, label: '1 / 2 (S1)' },
			{ name: 'no telemetry index or count: rocket index 1, count from stages (not totalStages 1)', target: { stages: stagesOf(2), currentStageIndex: 1 }, tm: {}, cur: 1, total: 2, label: '2 / 2 (S2)' },
			{ name: 'telemetry count 0 -> stages.length', target: { stages: stagesOf(2), currentStageIndex: 0 }, tm: { stageIndex: 0, totalStages: 0 }, cur: 0, total: 2, label: '1 / 2 (S1)' },
			{ name: 'stage 3 of 3', target: { stages: stagesOf(3), currentStageIndex: 0 }, tm: { stageIndex: 2, totalStages: 3 }, cur: 2, total: 3, label: '3 / 3 (S3)' },
			{ name: 'single stage', target: { stages: stagesOf(1), currentStageIndex: 0 }, tm: { stageIndex: 0, totalStages: 1 }, cur: 0, total: 1, label: '1 / 1 (S1)' },
			// Design §3.1: the index as normalizeStageIndex reads it, at most the last stage out of the payload phase (Gate 3 G3-4-02, G3-5-02)
			{ name: 'disableStaging single stage at index 1: stage 1 of 1 (1-ENG, no MECO)', target: { stages: stagesOf(1), currentStageIndex: 1, disableStaging: true }, tm: { stageIndex: 1, totalStages: 1 }, cur: 0, total: 1, label: '1 / 1 (S1)' },
			{ name: 'disableStaging two stages at index 2: stage 2 of 2 (2-ENG, MECO, 1-SEP, no SECO)', target: { stages: stagesOf(2), currentStageIndex: 2, disableStaging: true }, tm: { stageIndex: 2, totalStages: 2 }, cur: 1, total: 2, label: '2 / 2 (S2)' },
			{ name: 'disableStaging three stages at index 5: stage 3 of 3 (MECO, SECO, both SEP)', target: { stages: stagesOf(3), currentStageIndex: 5, disableStaging: true }, tm: { stageIndex: 5, totalStages: 3 }, cur: 2, total: 3, label: '3 / 3 (S3)' },
			{ name: 'telemetry index -1 (2 stages): stage 1 of 2 (1-ENG, no MECO, no 1-SEP)', target: { stages: stagesOf(2), currentStageIndex: 0 }, tm: { stageIndex: -1, totalStages: 2 }, cur: 0, total: 2, label: '1 / 2 (S1)' },
			{ name: 'telemetry index 1.5 (3 stages): stage 2 of 3 (2-ENG, MECO, 1-SEP, no SECO)', target: { stages: stagesOf(3), currentStageIndex: 0 }, tm: { stageIndex: 1.5, totalStages: 3 }, cur: 1, total: 3, label: '2 / 3 (S2)' },
			{ name: 'telemetry index 0.5 (2 stages): stage 1 of 2', target: { stages: stagesOf(2), currentStageIndex: 0 }, tm: { stageIndex: 0.5, totalStages: 2 }, cur: 0, total: 2, label: '1 / 2 (S1)' }
		];
		for (const c of CASES) {
			it(c.name, () => {
				const target = { ...thrusting, ...c.target };
				const tm = { status: TELEMETRY.STATUS.ASCENT, altM: 5000, flightTime: 30, ...c.tm };
				assert.equal(TelemetryPanel.formatStageInfo(target, tm), c.label, 'STAGE line');
				panel._updateAnnunciator(target, tm);
				assert.equal(lamp('1eng'), c.cur === 0, '1-ENG: stage index 0');
				assert.equal(lamp('1sep'), c.total > 1 && c.cur >= 1, '1-SEP: count > 1 and index >= 1');
				assert.equal(lamp('2eng'), c.total > 1 && c.cur === 1, '2-ENG: count > 1 and index 1');
				assert.equal(lamp('2sep'), c.total > 1 && c.cur >= 2, '2-SEP: count > 1 and index >= 2');
				// With the engine thrusting: MECO once past stage 1, SECO once past stage 2
				assert.equal(lamp('meco'), c.cur > 0, 'MECO: index > 0 (thrusting)');
				assert.equal(lamp('seco'), c.total > 1 && c.cur > 1, 'SECO: count > 1 and index > 1 (thrusting)');
				const state = RocketStackUtils.resolveStackState(target, tm);
				assert.equal(state.curStgIdx, c.cur);
				assert.equal(state.totalStg, c.total);
			});
		}
	});
});

/*******************************************************************
 * 3. Smoke and spark emission (§5.1-7)
 *******************************************************************/
describe('Unit 12-3: smoke / spark emission point (design §3.7, test plan §5.1-7)', () => {
	const SCALE_M = 50;
	const STAGE_FUELS = ['solid', 'hydro', 'liquid'];
	const FIRE = Object.freeze({ isIgnited: true, burnTime: 100, thrustRatio: 0.8 });
	const OFF = Object.freeze({ isIgnited: false, burnTime: 0, thrustRatio: 0 });
	const smokeRocket = (n, cur, over = {}) => {
		const r = new Rocket(901, 'Smoke Rocket', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 25, 0, null, 0);
		r.stages = STAGE_FUELS.slice(0, n).map((fuelType, i) => ({ name: `S${i + 1}`, fuelType }));
		r.totalStages = n;
		r.currentStageIndex = cur;
		r.fairing = { enabled: true, isSeparated: false };
		r.baseRadiusM = SCALE_M;
		r.thrustAngle = 0;
		r.inAtmosphere = true;
		r.ambientPresRatio = 1;
		Object.assign(r, OFF);
		return Object.assign(r, over);
	};
	/** Calls updateHistory and returns what reached the effect trail. */
	const emission = (rocket, objects = []) => {
		const added = [];
		let cleared = 0;
		let trajectoryPoints = 0;
		rocket.effectTrail.addPoint = (refId, relX, relY, frame, mode) => { added.push({ refId, relX, relY, frame, mode }); };
		rocket.effectTrail.clear = () => { cleared++; };
		const addTrajectoryPoint = rocket.trajectory.addPoint.bind(rocket.trajectory);
		rocket.trajectory.addPoint = (...args) => { trajectoryPoints++; return addTrajectoryPoint(...args); };
		rocket.updateHistory(7, objects, true);
		return { added, cleared, trajectoryPoints };
	};
	/** Distance [m] behind the rocket centre of the single recorded point (thrust angle 0, no reference body). */
	const tipM = (rocket) => {
		const e = emission(rocket);
		assert.equal(e.added.length, 1, 'one point recorded');
		const p = e.added[0];
		assert.equal(p.refId, -1);
		assert.equal(Math.abs(p.relY), 0, 'on the axis');
		assert.ok(p.relX <= 0, 'behind the rocket');
		return UnitConvertUtils.pix2m(-p.relX);
	};
	const TOL_M = 1e-9;

	it('every stack state, engine off (recorded in the atmosphere): the nozzle exit of the current stage', () => {
		for (const n of [1, 2, 3]) {
			for (let cur = 0; cur < n; cur++) {
				assertNear(tipM(smokeRocket(n, cur)), SCALE_M * -D_NOZZLE_X[n][cur], TOL_M, `${n}-stage, stage ${cur + 1}`);
			}
		}
	});

	it('every stack state firing at sea level and in vacuum: the nominal flame tip of the stage fuel and plume scale', () => {
		for (const n of [1, 2, 3]) {
			for (let cur = 0; cur < n; cur++) {
				for (const [p, atm] of [[1, true], [0.5, true], [0, false]]) {
					const rocket = smokeRocket(n, cur, { ...FIRE, ambientPresRatio: p, inAtmosphere: atm });
					const flame = designFlameR(STAGE_FUELS[cur], D_PLUME_SCALE[n][cur], FIRE.thrustRatio, p);
					assertNear(tipM(rocket), SCALE_M * -D_NOZZLE_X[n][cur] + SCALE_M * flame, TOL_M, `${n}-stage, stage ${cur + 1}, p ${p}`);
				}
			}
		}
	});

	it('the telemetry stage index chooses the stage (null reads as stage 1, as in the renderer)', () => {
		assertNear(tipM(smokeRocket(2, 0, { telemetry: { stageIndex: 1, totalStages: 2 } })), SCALE_M * 0.92, TOL_M, 'telemetry stage 2');
		assertNear(tipM(smokeRocket(2, 1, { telemetry: { stageIndex: null, totalStages: 2 } })), SCALE_M * 3.1, TOL_M, 'telemetry index null');
		assertNear(tipM(smokeRocket(3, 0, { telemetry: { stageIndex: 2, totalStages: 3 } })), SCALE_M * 1.18, TOL_M, 'telemetry stage 3');
	});

	it('payload only, each fuel firing at p 0 / 0.5 / 1: the payload plume (scale 0.35) from the bus aft face', () => {
		for (const n of [1, 2, 3]) {
			for (const fuel of ['liquid', 'hydro', 'solid', 'ion', 'xenon', undefined]) {
				for (const p of [0, 0.5, 1]) {
					const rocket = smokeRocket(n, n, {
						...FIRE, isPayloadSeparated: true, ambientPresRatio: p, inAtmosphere: p > 0,
						payload: { name: 'SAT', propulsion: { enabled: true, fuelType: fuel } }
					});
					const flame = designFlameR(fuel ?? 'liquid', D_PAYLOAD_PLUME_SCALE, FIRE.thrustRatio, p);
					assertNear(tipM(rocket), SCALE_M * -D_PAYLOAD_AFT_X[n] + SCALE_M * flame, TOL_M, `${n}-stage payload, ${fuel}, p ${p}`);
				}
			}
		}
		// hasPayloadPropulsion alone also makes the payload self-propelled
		const flagged = smokeRocket(2, 2, { ...FIRE, isPayloadSeparated: true, hasPayloadPropulsion: true, payload: { name: 'SAT', propulsion: { fuelType: 'hydro' } } });
		assertNear(tipM(flagged), SCALE_M * 0.455 + SCALE_M * designFlameR('hydro', D_PAYLOAD_PLUME_SCALE, FIRE.thrustRatio, 1), TOL_M, 'hasPayloadPropulsion');
	});

	it('payload only, not firing: the bus aft face (passive payload with burn flags, self-propelled with the engine off)', () => {
		for (const n of [1, 2, 3]) {
			const passive = smokeRocket(n, n, { ...FIRE, isPayloadSeparated: true, payload: { name: 'SAT', propulsion: null } });
			assertNear(tipM(passive), SCALE_M * -D_PAYLOAD_AFT_X[n], TOL_M, `${n}-stage passive payload (recorded: isIgnited && burnTime)`);
			const coasting = smokeRocket(n, n, { isPayloadSeparated: true, isIgnited: true, burnTime: 50, thrustRatio: 0, payload: { name: 'SAT', propulsion: { enabled: true, fuelType: 'hydro' } } });
			assertNear(tipM(coasting), SCALE_M * -D_PAYLOAD_AFT_X[n], TOL_M, `${n}-stage self-propelled, engine off`);
			const byIndex = smokeRocket(n, n, { inAtmosphere: false, isEscaping: true });
			assertNear(tipM(byIndex), SCALE_M * -D_PAYLOAD_AFT_X[n], TOL_M, `${n}-stage payload by stage index, escaping`);
		}
	});

	it('regression (§1.4.1 (c) table): the payload burn of a 2-stage rocket emits at 3.605 R (sea level) / 4.0775 R (vacuum)', () => {
		const payload = { name: 'SAT', propulsion: { enabled: true, fuelType: 'hydro' } };
		const seaLevel = tipM(smokeRocket(2, 2, { ...FIRE, thrustRatio: 1, isPayloadSeparated: true, ambientPresRatio: 1, payload }));
		const vacuum = tipM(smokeRocket(2, 2, { ...FIRE, thrustRatio: 1, isPayloadSeparated: true, ambientPresRatio: 0, inAtmosphere: false, payload }));
		assertNear(seaLevel / SCALE_M, 3.605, 1e-12, 'sea level (was 6.120 R)');
		assertNear(vacuum / SCALE_M, 4.0775, 1e-12, 'vacuum (design 4.078)');
		assertNear(tipM(smokeRocket(2, 2, { isPayloadSeparated: true, payload: { name: 'SAT' } })) / SCALE_M, 0.455, 1e-12, 'engine off (was 0.920 R)');
	});

	it('regression (§1.4.1 (c) table): no stages and no telemetry is drawn and emits as a single stage (1.85 R, was 3.10 R)', () => {
		for (const telemetry of [null, undefined]) {
			const bare = smokeRocket(1, 0, { stages: [], totalStages: 1, telemetry });
			assertNear(tipM(bare), SCALE_M * 1.85, TOL_M, `telemetry ${telemetry}`);
			const firing = smokeRocket(1, 0, { stages: [], totalStages: 1, telemetry, ...FIRE, fuelType: 'hydro' });
			assertNear(tipM(firing), SCALE_M * 1.85 + SCALE_M * designFlameR('hydro', 1.0, FIRE.thrustRatio, 1), TOL_M, `firing, telemetry ${telemetry}`);
		}
	});

	it('the fuel is the stage fuel, else rocket.fuelType, else liquid', () => {
		const noStageFuel = smokeRocket(2, 0, { ...FIRE, stages: [{ name: 'S1' }, { name: 'S2' }], fuelType: 'solid' });
		assertNear(tipM(noStageFuel), SCALE_M * 3.1 + SCALE_M * designFlameR('solid', 1.0, FIRE.thrustRatio, 1), TOL_M, 'rocket.fuelType');
		const none = smokeRocket(2, 0, { ...FIRE, stages: [{ name: 'S1' }, { name: 'S2' }], fuelType: undefined });
		assertNear(tipM(none), SCALE_M * 3.1 + SCALE_M * designFlameR('liquid', 1.0, FIRE.thrustRatio, 1), TOL_M, 'liquid');
	});

	it('boundary: the flame follows the renderer firing rule (thrust above 0.01 or telemetry TWR; throttle 1 when 0)', () => {
		assertNear(tipM(smokeRocket(2, 1, { ...FIRE, thrustRatio: D_THRUST_THRESHOLD })), SCALE_M * 0.92, TOL_M, 'throttle at the threshold: nozzle');
		const above = 0.0101;
		assertNear(tipM(smokeRocket(2, 1, { ...FIRE, thrustRatio: above })), SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, above, 1), TOL_M, 'just above');
		const twrOnly = smokeRocket(2, 1, { ...FIRE, thrustRatio: 0, telemetry: { twr: 1.2 } });
		assertNear(tipM(twrOnly), SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, 1.0, 1), TOL_M, 'telemetry TWR, throttle 1');
	});

	it('the ambient pressure is the renderer source (rocket, then telemetry ratio, then telemetry altitude)', () => {
		const viaTelemetry = smokeRocket(2, 1, { ...FIRE, telemetry: { ambientPresRatio: 0.25 } });
		delete viaTelemetry.ambientPresRatio;
		assertNear(tipM(viaTelemetry), SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, FIRE.thrustRatio, 0.25), TOL_M, 'telemetry ratio');
		const viaAltitude = smokeRocket(2, 1, { ...FIRE, telemetry: { altM: 8500 } });
		delete viaAltitude.ambientPresRatio;
		assertNear(tipM(viaAltitude), SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, FIRE.thrustRatio, Math.exp(-1)), TOL_M, 'altitude 8500 m');
		const aboveAtmosphere = smokeRocket(2, 1, { ...FIRE, inAtmosphere: false, telemetry: { altM: 150000 } });
		delete aboveAtmosphere.ambientPresRatio;
		assertNear(tipM(aboveAtmosphere), SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, FIRE.thrustRatio, 0), TOL_M, 'vacuum above 100 km');
	});

	it('baseRadiusM 0: the drawing scale of _getDrawRadius (param.RADIUS, else the Rocket parameter 63), not bottomOffsetM', () => {
		const zoom = 1e9; // large enough that the physical radius exceeds MIN_SCREEN_RADIUS
		const scaleOf = (rocket) => (rocket._getDrawRadius(zoom) / zoom) * PHYSICS.METERS_PER_AU / UnitConvertUtils.m2pix(PHYSICS.METERS_PER_AU);
		const withParam = smokeRocket(2, 0, { baseRadiusM: 0, param: { RADIUS: 40 }, bottomOffsetM: 310 });
		assertNear(scaleOf(withParam), 40, 1e-9, 'drawing scale with param');
		assertNear(tipM(withParam), 40 * 3.1, TOL_M, 'param.RADIUS');
		const withoutParam = smokeRocket(2, 0, { baseRadiusM: 0, param: null, bottomOffsetM: 310 });
		assertNear(scaleOf(withoutParam), D_ROCKET_PARAM_RADIUS, 1e-9, 'drawing scale without param');
		assertNear(tipM(withoutParam), D_ROCKET_PARAM_RADIUS * 3.1, TOL_M, 'Rocket parameter (was 310 / 3.10 = 100 m)');
		const firing = smokeRocket(3, 2, { ...FIRE, baseRadiusM: 0, param: null, bottomOffsetM: 345 });
		assertNear(tipM(firing), D_ROCKET_PARAM_RADIUS * 1.18 + D_ROCKET_PARAM_RADIUS * designFlameR('liquid', 0.5, FIRE.thrustRatio, 1), TOL_M, 'flame at the same scale');
	});

	it('record conditions are unchanged: burning, in the atmosphere or escaping; nothing while held down unignited', () => {
		const cases = [
			{ name: 'held down, not ignited', over: { isHoldDown: true, isIgnited: false, burnTime: 100, inAtmosphere: true }, added: 0, cleared: 0, trajectory: 0 },
			{ name: 'held down, ignited and burning', over: { isHoldDown: true, isIgnited: true, burnTime: 100, inAtmosphere: false }, added: 1, mode: TRAIL_MODE.NORMAL },
			{ name: 'burning in vacuum', over: { isIgnited: true, burnTime: 1, inAtmosphere: false }, added: 1, mode: TRAIL_MODE.NORMAL },
			{ name: 'in the atmosphere only', over: { inAtmosphere: true }, added: 1, mode: TRAIL_MODE.ATMOSPHERE },
			{ name: 'escaping only', over: { inAtmosphere: false, isEscaping: true }, added: 1, mode: TRAIL_MODE.ESCAPE },
			{ name: 'atmosphere and escaping', over: { inAtmosphere: true, isEscaping: true }, added: 1, mode: TRAIL_MODE.ATMOSPHERE },
			{ name: 'ignited without burn time in vacuum', over: { isIgnited: true, burnTime: 0, inAtmosphere: false }, added: 0, cleared: 1 },
			{ name: 'burn time without ignition in vacuum', over: { isIgnited: false, burnTime: 100, inAtmosphere: false }, added: 0, cleared: 1 },
			{ name: 'nothing', over: { inAtmosphere: false }, added: 0, cleared: 1 }
		];
		for (const c of cases) {
			const e = emission(smokeRocket(2, 0, c.over));
			assert.equal(e.added.length, c.added, `${c.name}: points`);
			if (c.added) {
				assert.equal(e.added[0].mode, c.mode, `${c.name}: mode`);
				assert.equal(e.added[0].frame, 7, `${c.name}: frame`);
				assert.equal(e.cleared, 0, `${c.name}: not cleared`);
			} else {
				assert.equal(e.cleared, c.cleared, `${c.name}: cleared`);
			}
			assert.equal(e.trajectoryPoints, c.trajectory ?? 1, `${c.name}: trajectory point`);
		}
	});

	it('the point is in the reference body frame along the thrust axis, rotated with the body in the atmosphere', () => {
		const angle = 0.7;
		const ref = { id: 3, x: 1e-3, y: -2e-3, rotationAngle: 0.3, state: OBJECT_STATE.ACTIVE };
		const rocket = smokeRocket(2, 1, { ...FIRE, x: 4e-3, y: 5e-3, thrustAngle: angle, dominantBodyId: 3 });
		const e = emission(rocket, [ref]);
		const px = UnitConvertUtils.m2pix(SCALE_M * 0.92 + SCALE_M * designFlameR('hydro', 0.65, FIRE.thrustRatio, 1));
		const relX = (rocket.x - Math.cos(angle) * px) - ref.x;
		const relY = (rocket.y - Math.sin(angle) * px) - ref.y;
		const c = Math.cos(-ref.rotationAngle);
		const s = Math.sin(-ref.rotationAngle);
		assert.equal(e.added[0].refId, 3);
		assertNear(e.added[0].relX, relX * c - relY * s, 1e-15, 'x in the body frame');
		assertNear(e.added[0].relY, relX * s + relY * c, 1e-15, 'y in the body frame');
		// Outside the atmosphere the point is not rotated
		const free = emission(smokeRocket(2, 1, { ...FIRE, inAtmosphere: false, x: 4e-3, y: 5e-3, thrustAngle: angle, dominantBodyId: 3 }), [ref]);
		assertNear(free.added[0].relX, relX, 1e-15, 'x unrotated');
		assertNear(free.added[0].relY, relY, 1e-15, 'y unrotated');
	});

	describe('_drawPlume (zero flicker) draws nominalPlumeLength', () => {
		it('PLUME_VACUUM_STRETCH is the §3.7 table and is frozen', () => {
			assert.deepEqual({ ...RocketRenderer.PLUME_VACUUM_STRETCH }, D_VACUUM_STRETCH);
			assert.equal(Object.isFrozen(RocketRenderer.PLUME_VACUUM_STRETCH), true);
		});

		it('each fuel at pressure ratios 0, 0.5 and 1 (and the clamped -0.5 / 1.5)', () => {
			const R = 40;
			const scale = 0.65;
			const throttle = 0.8;
			for (const fuel of ['liquid', 'hydro', 'solid', 'ion', 'xenon']) {
				for (const p of [0, 0.5, 1, -0.5, 1.5]) {
					const ctx = createRecordingCtx();
					withZeroFlicker(() => RocketRenderer._drawPlume(ctx, -12, 0, scale, throttle, fuel, R, p));
					const drawnLen = -ctx.gradients[0].args[2];
					const outlineTip = Math.min(...ctx.fills[0].path.filter(q => q.y === 0 && q.x !== undefined).map(q => q.x));
					assert.equal(outlineTip, -drawnLen, `${fuel} p ${p}: outline tip at the gradient end`);
					const nominal = RocketRenderer.nominalPlumeLength(R, scale, throttle, fuel, p);
					assert.equal(drawnLen, nominal, `${fuel} p ${p}: drawn = nominal`);
					assertNear(nominal, R * designFlameR(fuel, scale, throttle, p), 1e-12, `${fuel} p ${p}: §3.7 formula`);
				}
			}
		});

		it('the default pressure ratio is 1 (sea level, no stretch)', () => {
			for (const fuel of ['liquid', 'hydro', 'solid', 'ion']) {
				assert.equal(RocketRenderer.nominalPlumeLength(10, 1, 1, fuel), RocketRenderer.nominalPlumeLength(10, 1, 1, fuel, 1));
				assertNear(RocketRenderer.nominalPlumeLength(10, 1, 1, fuel), 10 * D_PLUME_LEN_MULT[fuel], 1e-12, fuel);
			}
		});
	});
});

/*******************************************************************
 * 4. Pad umbilical and scale (§5.1-8)
 *******************************************************************/
describe('Unit 12-4: pad umbilical anchors and scale (design §3.8, test plan §5.1-8)', () => {
	const PAD_HOST = { id: 2, x: 0, y: 0, rotationAngle: 0 };
	const zoomFor = (radiusPx, baseRadiusM = D_ROCKET_PARAM_RADIUS) => radiusPx / UnitConvertUtils.m2pix(baseRadiusM);
	const ZOOM_40PX = zoomFor(40);
	const padRocket = (n, fairingOn, over = {}) => {
		const r = new Rocket(950, 'Pad Rocket', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 25, 0, null, 0);
		r.stages = stagesOf(n);
		r.totalStages = n;
		r.currentStageIndex = 0;
		r.fairing = { enabled: fairingOn, isSeparated: false };
		r.isHoldDown = true;
		r.isIgnited = false;
		r.baseRadiusM = D_ROCKET_PARAM_RADIUS;
		r.bottomOffsetM = D_ROCKET_PARAM_RADIUS * D_NOZZLE_BOTTOM_BY_STAGES[n];
		r.thrustAngle = 0;
		r.x = 0;
		r.y = 0;
		return Object.assign(r, over);
	};
	const padContext = (rocket, zoomScale = ZOOM_40PX) => ({ rocket, host: PAD_HOST, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale });
	const startedPad = () => {
		const pad = new PadEffectRenderer();
		pad.start(950, 2);
		return pad;
	};
	/** drawBackground: the screen radius (from the arm width), the arm length and the cable end, in rocket radii. */
	const drawnPad = (pad, context) => {
		const ctx = createRecordingCtx();
		pad.drawBackground(ctx, { zoomScale: context.zoomScale, basis: { x: 0, y: 0 } }, context);
		const arms = ctx.fills.filter(f => f.style === PAD_EFFECT.STRUCTURE.TRUSS_COLOR && f.path[0].op === 'rect' && f.path[0].y === 0);
		assert.equal(arms.length, 1, 'one service arm');
		const arm = arms[0].path[0];
		const rPx = arm.w / D_ARM_THICK;
		const cable = ctx.strokes.find(s => s.style === PAD_EFFECT.STRUCTURE.CABLE_BASE_COLOR);
		const end = cable ? cable.path[cable.path.length - 1] : null;
		return { ctx, rPx, armLen: arm.h / rPx, conn: end ? { x: end.x / rPx, y: end.y / rPx } : null };
	};
	const CONFIG = Object.freeze({ connY: D_PAD.CABLE_CONN_Y_MULT, armLen: D_PAD.UMBILICAL_ARM_LEN_MULT });
	const expectedAnchors = (n, fairingOn) => {
		const silhouette = designSilhouette(n, fairingOn);
		return { connY: -silhouette(D_PAD.CABLE_CONN_X_MULT), armLen: Math.abs(D_PAD.UMBILICAL_OFFSET_Y) - silhouette(D_PAD.UMBILICAL_TOP_X_MULT) };
	};

	for (const row of D_PAD_TABLE) {
		const name = `${row.n}-stage, fairing ${row.fairing ? 'on' : 'off'}`;
		it(`regression (§3.8 table): ${name}: connector y ${row.connY.toFixed(3)} and arm ${row.armLen.toFixed(3)} on the silhouette (update, drawBackground)`, () => {
			const exp = expectedAnchors(row.n, row.fairing);
			assertNear(exp.connY, row.connY, 5e-4, `${name}: design table connector`);
			assertNear(exp.armLen, row.armLen, 5e-4, `${name}: design table arm`);
			const rocket = padRocket(row.n, row.fairing);
			const context = padContext(rocket);
			const pad = startedPad();
			pad.update(1 / 60, context);
			const nodes = pad.umbilicalCable.nodes;
			assertNear(nodes[nodes.length - 1].x, D_PAD.CABLE_CONN_X_MULT, 1e-12, `${name}: connector x`);
			assertNear(nodes[nodes.length - 1].y, exp.connY, 1e-12, `${name}: connector y (was -0.700)`);
			assertNear(nodes[0].x, D_PAD.UMBILICAL_TOP_X_MULT, 1e-12, `${name}: arm tip x`);
			assertNear(nodes[0].y, D_PAD.UMBILICAL_OFFSET_Y + exp.armLen, 1e-12, `${name}: arm tip y (was -0.700)`);
			const drawn = drawnPad(pad, context);
			assertNear(drawn.armLen, exp.armLen, 1e-12, `${name}: drawn arm length`);
			assertNear(drawn.conn.x, D_PAD.CABLE_CONN_X_MULT, 1e-12, `${name}: drawn cable end x`);
			assertNear(drawn.conn.y, exp.connY, 1e-12, `${name}: drawn cable end y`);
			assert.deepEqual(Object.keys(pad._padAnchors(context)).sort(), ['armLen', 'connY']);
			assertNear(pad._padAnchors(context).connY, exp.connY, 1e-12, `${name}: _padAnchors connY`);
			assertNear(pad._padAnchors(context).armLen, exp.armLen, 1e-12, `${name}: _padAnchors armLen`);
		});
	}

	it('no visible gap: over the whole end face [1.275, 1.600] the arm end meets or overlaps the silhouette', () => {
		const x0 = D_PAD.UMBILICAL_TOP_X_MULT - D_ARM_THICK;
		const x1 = D_PAD.UMBILICAL_TOP_X_MULT;
		assertNear(x0, 1.275, 1e-12, 'end face start');
		for (const row of D_PAD_TABLE) {
			const name = `${row.n}-stage, fairing ${row.fairing ? 'on' : 'off'}`;
			const silhouette = designSilhouette(row.n, row.fairing);
			const pad = startedPad();
			const context = padContext(padRocket(row.n, row.fairing));
			pad.update(1 / 60, context);
			const armEndY = D_PAD.UMBILICAL_OFFSET_Y + drawnPad(pad, context).armLen;
			const xs = [];
			for (let i = 0; i <= 3250; i++) xs.push(x0 + (x1 - x0) * (i / 3250));
			for (const b of [1.3, 1.5, 1.53]) xs.push(b - 1e-9, b, b + 1e-9);
			let minGap = Infinity;
			for (const x of xs.filter(v => v >= x0 && v <= x1)) {
				const r = silhouette(x);
				assert.notEqual(r, null, `${name}: silhouette at ${x}`);
				// The end face (y = armEndY) must reach the body edge (y = -r): no gap above it
				assert.ok(armEndY >= -r - 1e-12, `${name}: gap at x = ${x} (arm end ${armEndY}, body edge ${-r})`);
				minGap = Math.min(minGap, armEndY + r);
			}
			assertNear(minGap, 0, 1e-12, `${name}: the end face touches the narrowest silhouette`);
		}
	});

	describe('bodyRadiusAt / minBodyRadiusOver', () => {
		const geometryOf = (n, fairingOn, over = {}) => RocketRenderer._computeStackGeometry({ stages: stagesOf(n), currentStageIndex: 0, fairing: { enabled: fairingOn }, ...over }, 1);

		it('normal: stages, interstages, the fairing curve and the stowed payload away from boundaries', () => {
			for (const n of [1, 2, 3]) {
				for (const fairingOn of [true, false]) {
					const g = geometryOf(n, fairingOn);
					const silhouette = designSilhouette(n, fairingOn);
					const h = D_HULL[n];
					const xMin = h.bodies[0].a;
					const xMax = h.fairingX + D_FAIRING.LENGTH;
					// Part boundaries (the design literals and the computed hull can differ in the last bit there; tested below)
					const payloadCx = h.fairingX + D_FAIRING.LENGTH * D_FAIRING.PAYLOAD_OFFSET;
					const boundaries = [
						...h.bodies.flatMap(b => [b.a, b.b]), h.fairingX, h.fairingX + D_FAIRING.LENGTH,
						payloadCx - 0.5 * h.payloadR * D_BUS.W, payloadCx + 0.5 * h.payloadR * D_BUS.W
					];
					for (let i = 0; i <= 400; i++) {
						const x = xMin + (xMax - xMin) * (i / 400);
						if (boundaries.some(b => Math.abs(x - b) < 1e-6)) continue;
						const expected = silhouette(x);
						const got = RocketRenderer.bodyRadiusAt(g, x);
						if (expected === null) {
							assert.equal(got, null, `${n}-stage fairing ${fairingOn} at ${x}`);
						} else {
							assertNear(got, expected, 1e-12, `${n}-stage fairing ${fairingOn} at ${x}`);
						}
					}
				}
			}
		});

		it('the fairing radius follows the Bézier _drawFairing draws', () => {
			for (const n of [1, 2, 3]) {
				const g = geometryOf(n, true);
				const ctx = createRecordingCtx();
				const f = g.fairing;
				RocketRenderer._drawFairing(ctx, f.startX, f.radius, f.length, ROCKET_VISUAL.THEMES.orange);
				const [m0, q1] = ctx.fills[0].path;
				assert.equal(m0.op, 'moveTo');
				assert.equal(q1.op, 'quad');
				for (let i = 0; i <= 20; i++) {
					const t = i / 20;
					const bx = (1 - t) * (1 - t) * m0.x + 2 * t * (1 - t) * q1.cpx + t * t * q1.x;
					const by = (1 - t) * (1 - t) * m0.y + 2 * t * (1 - t) * q1.cpy + t * t * q1.y;
					assertNear(RocketRenderer.bodyRadiusAt(g, bx), -by, 1e-9, `${n}-stage fairing at t = ${t}`);
				}
			}
		});

		it('boundary: part boundaries and overlaps take the largest radius; the nose tip is 0', () => {
			const g2 = geometryOf(2, true);
			const [stage2, inter, stage1] = g2.segments;
			assert.equal(RocketRenderer.bodyRadiusAt(g2, stage1.startX), 0.7, 'stage-1 aft end');
			assert.equal(RocketRenderer.bodyRadiusAt(g2, inter.startX), 0.7, 'stage 1 / interstage');
			assert.equal(RocketRenderer.bodyRadiusAt(g2, stage2.startX), 0.7, 'interstage 0.7 / stage 2 0.65');
			assertNear(RocketRenderer.bodyRadiusAt(g2, g2.fairing.startX), 0.65, 1e-15, 'stage 2 / fairing base');
			assertNear(RocketRenderer.bodyRadiusAt(g2, g2.fairing.startX + g2.fairing.length), 0, 1e-15, 'nose tip');
			const g3 = geometryOf(3, true);
			assert.equal(RocketRenderer.bodyRadiusAt(g3, g3.segments[0].startX), 0.65, 'interstage 2 0.65 / stage 3 0.55');
			assertNear(RocketRenderer.bodyRadiusAt(g3, g3.fairing.startX), 0.65, 1e-15, 'stage 3 0.55 / fairing 0.65');
			const g1 = geometryOf(1, false);
			const s1 = g1.segments[0];
			assert.equal(RocketRenderer.bodyRadiusAt(g1, s1.startX + s1.length), 0.7, 'stage 1 0.7 over the stowed payload 0.595');
			const busHalfW = 0.5 * g1.payload.r * D_BUS.W;
			assertNear(RocketRenderer.bodyRadiusAt(g1, g1.payload.cx + busHalfW), 0.595, 1e-15, 'payload front');
		});

		it('the silhouette has no hole at the 2-stage stage-1 / interstage joint (both 0.7 R, design §3.2 / §3.8-1)', () => {
			// The design hull abuts stage 1 [-2.75, 0.05] and the interstage [0.05, 0.4]. The geometry builds stage 1 downwards
			// (stg1X = interX - l1), so stg1X + l1 can fall short of interX by an ulp; the outline must still be 0.7 R there
			for (const R of [1, D_LOD_RADIUS_THRESHOLD, HD_R]) {
				const g = RocketRenderer._computeStackGeometry({ stages: stagesOf(2), currentStageIndex: 0, fairing: { enabled: true } }, R);
				const [, inter, stage1] = g.segments;
				const joint = 0.5 * (stage1.startX + stage1.length + inter.startX);
				assert.equal(RocketRenderer.bodyRadiusAt(g, 0.05 * R), 0.7 * R, `R = ${R}: at the design joint x = 0.05 R`);
				assert.equal(RocketRenderer.bodyRadiusAt(g, joint), 0.7 * R, `R = ${R}: at the computed joint ${joint}`);
				assert.equal(RocketRenderer.minBodyRadiusOver(g, -1.0 * R, 0.3 * R), 0.7 * R, `R = ${R}: over stage 1 and the interstage`);
			}
		});

		it('abnormal: outside the hull (nozzle, past the nose / payload) and the deployed payload are null', () => {
			const g2 = geometryOf(2, true);
			const stage1 = g2.segments[2];
			assert.equal(RocketRenderer.bodyRadiusAt(g2, stage1.startX - 1e-9), null, 'the nozzle is not part of the silhouette');
			assert.equal(RocketRenderer.bodyRadiusAt(g2, g2.fairing.startX + g2.fairing.length + 1e-9), null, 'past the nose');
			const g1 = geometryOf(1, false);
			assert.equal(RocketRenderer.bodyRadiusAt(g1, g1.payload.cx + 0.5 * g1.payload.r * D_BUS.W + 1e-9), null, 'past the payload');
			const alone = RocketRenderer._computeStackGeometry({ stages: stagesOf(2), isPayloadSeparated: true }, 1);
			assert.equal(RocketRenderer.bodyRadiusAt(alone, 0), null, 'deployed payload');
			assert.equal(RocketRenderer.minBodyRadiusOver(alone, -0.1, 0.1), null, 'deployed payload range');
		});

		it('minBodyRadiusOver: the narrowest silhouette over a range, null when part of it is uncovered', () => {
			for (const row of D_PAD_TABLE) {
				const g = geometryOf(row.n, row.fairing);
				const expected = designSilhouette(row.n, row.fairing)(D_PAD.UMBILICAL_TOP_X_MULT);
				assertNear(RocketRenderer.minBodyRadiusOver(g, 1.275, 1.6), expected, 1e-12, `${row.n}-stage fairing ${row.fairing}: end face`);
			}
			const g2 = geometryOf(2, true);
			assertNear(RocketRenderer.minBodyRadiusOver(g2, 1.8, 2.2), fairingCurveAt(1.6, 0.65, 2.2), 1e-12, 'inside the fairing: its forward end');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, -1.0, 0.0), 0.7, 'inside stage 1');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, 0.1, 0.3), 0.7, 'inside the interstage');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, 0.3, 1.0), 0.65, 'interstage and stage 2');
			const g3 = geometryOf(3, true);
			assert.equal(RocketRenderer.minBodyRadiusOver(g3, -1.0, 1.0), 0.65, '3-stage: stage 1, interstage 1 and stage 2');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, 1.0, 1.0), 0.65, 'empty range: the radius at the point');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, 2.5, 2.8), null, 'past the nose');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, -2.9, -2.6), null, 'over the nozzle');
			assert.equal(RocketRenderer.minBodyRadiusOver(g2, 5, 5), null, 'empty range outside');
		});

		it('minBodyRadiusOver: a reversed range gives the same minimum as the ordered one (design §3.8-1, Rev 16)', () => {
			for (const row of D_PAD_TABLE) {
				const g = geometryOf(row.n, row.fairing);
				assert.equal(RocketRenderer.minBodyRadiusOver(g, 1.6, 1.275), RocketRenderer.minBodyRadiusOver(g, 1.275, 1.6),
					`${row.n}-stage fairing ${row.fairing}: (1.6, 1.275) = (1.275, 1.6)`);
			}
			// The case that went wrong before the fix: the 3-stage end face narrows to stage 3 at x = 1.6
			assert.equal(RocketRenderer.minBodyRadiusOver(geometryOf(3, true), 1.6, 1.275), 0.55, '3-stage reversed: stage 3, not stage 2');
			assert.equal(RocketRenderer.minBodyRadiusOver(geometryOf(2, true), 0.3, -1.0), 0.7, '2-stage reversed: stage 1 and the interstage');
		});
	});

	describe('_padAnchors: computed while held down, kept after the release, cleared by start()', () => {
		it('the configured values until a held-down rocket is seen (no rocket, a free rocket, no context)', () => {
			const pad = startedPad();
			assert.deepEqual(pad._padAnchors({ m2pix: UnitConvertUtils.m2pix }), CONFIG, 'no rocket');
			assert.deepEqual(pad._padAnchors(padContext(padRocket(3, true, { isHoldDown: false }))), CONFIG, 'free rocket');
			assert.deepEqual(pad._padAnchors(undefined), CONFIG, 'no context');
			assert.deepEqual(pad._padAnchors({}), CONFIG, 'empty context');
		});

		it('values follow the held rocket, stay through the release and the separations, and are used without a rocket', () => {
			const pad = startedPad();
			const rocket = padRocket(1, true);
			const context = padContext(rocket);
			const one = expectedAnchors(1, true);
			assertNear(pad._padAnchors(context).armLen, one.armLen, 1e-12, 'held 1-stage with fairing');
			rocket.fairing = { enabled: false };
			const bare = expectedAnchors(1, false);
			assertNear(pad._padAnchors(context).armLen, bare.armLen, 1e-12, 'still held: recomputed after the fairing change');
			const three = padRocket(3, true);
			const exp3 = expectedAnchors(3, true);
			const held = pad._padAnchors(padContext(three));
			assertNear(held.connY, exp3.connY, 1e-12);
			assertNear(held.armLen, exp3.armLen, 1e-12);
			// Release, then stages and the fairing separate while the pad effect still runs
			three.isHoldDown = false;
			three.currentStageIndex = 2;
			three.fairing = { enabled: true, isSeparated: true };
			three.telemetry = { stageIndex: 2, totalStages: 3, isFairingSeparated: true };
			assert.deepEqual(pad._padAnchors(padContext(three)), held, 'kept after the release');
			assert.deepEqual(pad._padAnchors({ m2pix: UnitConvertUtils.m2pix }), held, 'kept without a rocket');
			assert.deepEqual(pad._padAnchors(undefined), held, 'kept without a context');
			// The cable keeps them too
			const ctxNoRocket = { rocket: null, host: PAD_HOST, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: ZOOM_40PX };
			pad.rocketRadius = D_ROCKET_PARAM_RADIUS;
			const drawn = drawnPad(pad, ctxNoRocket);
			assertNear(drawn.armLen, exp3.armLen, 1e-12, 'drawn arm without a rocket');
			// start() clears them
			pad.start(950, 2);
			assert.deepEqual(pad._padAnchors({ m2pix: UnitConvertUtils.m2pix }), CONFIG, 'cleared by start()');
			assert.deepEqual(pad._padAnchors(padContext(three)), CONFIG, 'a released rocket after start()');
		});

		it('through update(): the cable keeps the held values after the release while the rocket stages', () => {
			const pad = startedPad();
			const rocket = padRocket(2, true);
			const context = padContext(rocket);
			const exp = expectedAnchors(2, true);
			for (let i = 0; i < 3; i++) pad.update(1 / 60, context);
			rocket.isHoldDown = false;
			rocket.currentStageIndex = 1;
			rocket.fairing = { enabled: true, isSeparated: true };
			pad.update(1 / 60, context);
			const anchors = pad._padAnchors(context);
			assertNear(anchors.connY, exp.connY, 1e-12, 'connector kept');
			assertNear(anchors.armLen, exp.armLen, 1e-12, 'arm kept');
			// The arm tip still moves with the tower (umbilical angle) at the kept length
			const tip = pad.umbilicalCable.getAttachPos({ ...PAD_EFFECT.STRUCTURE, UMBILICAL_ARM_LEN_MULT: exp.armLen }, pad.umbilicalAngle, D_ROCKET_PARAM_RADIUS * 3.1 / D_ROCKET_PARAM_RADIUS);
			assertNear(pad.umbilicalCable.nodes[0].x, tip.x, 1e-12, 'arm tip x');
			assertNear(pad.umbilicalCable.nodes[0].y, tip.y, 1e-12, 'arm tip y');
			assertNear(drawnPad(pad, context).armLen, exp.armLen, 1e-12, 'drawn arm after the release');
		});

		it('drawBackground without update(): configured length for a free rocket, computed for a held one', () => {
			const free = startedPad();
			assertNear(drawnPad(free, padContext(padRocket(2, true, { isHoldDown: false }))).armLen, D_PAD.UMBILICAL_ARM_LEN_MULT, 1e-12, 'free rocket');
			const held = startedPad();
			assertNear(drawnPad(held, padContext(padRocket(3, false))).armLen, expectedAnchors(3, false).armLen, 1e-12, 'held rocket');
		});

		it('abnormal: a held rocket with no silhouette at the anchors (payload alone) uses the configured values', () => {
			const pad = startedPad();
			const alone = padRocket(2, true, { isPayloadSeparated: true });
			assert.deepEqual(pad._padAnchors(padContext(alone)), CONFIG);
			const drawn = drawnPad(pad, padContext(alone));
			assertNear(drawn.armLen, D_PAD.UMBILICAL_ARM_LEN_MULT, 1e-12, 'drawn arm');
		});
	});

	describe('_visualScreenRadius: the pad is drawn at the rocket drawing radius', () => {
		const ZOOM_25 = zoomFor(2.5); // physical radius 2.5 px: between the pad minimum 2 and the rocket minimum 3.5
		const heldPad = (zoomScale) => {
			const pad = startedPad();
			const rocket = padRocket(2, true);
			const context = padContext(rocket, zoomScale);
			pad.update(1 / 60, context);
			return { pad, rocket, context };
		};

		it('physical radius 2.5 px: structures, particle positions and particle sizes use 3.5 px (the rocket minimum)', () => {
			const { pad, rocket, context } = heldPad(ZOOM_25);
			assertNear(context.m2pix(pad.rocketRadius) * ZOOM_25, 2.5, 1e-12, 'physical radius');
			assert.equal(pad._visualScreenRadius(context, ZOOM_25), rocket._getDrawRadius(ZOOM_25));
			assertNear(pad._visualScreenRadius(context, ZOOM_25), D_MIN_SCREEN_RADIUS, 1e-12, 'drawing radius');
			assertNear(pad._getVisualMultiplier(context), D_MIN_SCREEN_RADIUS / 2.5, 1e-12, 'particle multiplier (was 1.0)');
			// Structures
			assertNear(drawnPad(pad, context).rPx, D_MIN_SCREEN_RADIUS, 1e-12, 'structure radius');
			// Particle positions: the purge sparks start at the nozzle of the drawn rocket (screen px = world px x zoom)
			const random = Math.random;
			try {
				Math.random = () => 0.5;
				pad.particles = [];
				pad._spawnPurgeSpark(context);
			} finally {
				Math.random = random;
			}
			const nozzleMult = rocket.bottomOffsetM / rocket.baseRadiusM;
			assert.ok(pad.particles.length > 0);
			for (const p of pad.particles) {
				assertNear(p.x * ZOOM_25, -D_MIN_SCREEN_RADIUS * nozzleMult, 1e-9, 'spark x on screen (was -2.5 x 3.1)');
				assertNear(p.y * ZOOM_25, 0, 1e-12, 'spark y on screen');
			}
			// Particle sizes
			pad.particles = [{ type: 'smoke_white', x: 0, y: 0, vx: 0, vy: 0, life: 1, maxLife: 1, size: 4 }];
			const ctx = createRecordingCtx();
			pad.drawForeground(ctx, { zoomScale: ZOOM_25, basis: { x: 0, y: 0 } }, context);
			const arcs = ctx.fills.flatMap(f => f.path.filter(q => q.op === 'arc'));
			assert.equal(arcs.length, 1);
			assertNear(arcs[0].r, D_MIN_SCREEN_RADIUS * 4 * PAD_EFFECT.PARTICLES.smoke_white.SIZE_MULT, 1e-12, 'particle size (was 2.5 px)');
		});

		it('boundary: physical radius 1 px, exactly 3.5 px and 5 px with a rocket', () => {
			for (const [phys, expected] of [[1, D_MIN_SCREEN_RADIUS], [D_MIN_SCREEN_RADIUS, D_MIN_SCREEN_RADIUS], [5, 5]]) {
				const z = zoomFor(phys);
				const { pad, context } = heldPad(z);
				assertNear(pad._visualScreenRadius(context, z), expected, 1e-12, `physical ${phys} px`);
				assertNear(pad._getVisualMultiplier(context), expected / phys, 1e-12, `multiplier at ${phys} px`);
			}
		});

		it('without a rocket the former formula max(2 px, physical radius) is kept', () => {
			const pad = startedPad();
			pad.rocketRadius = D_ROCKET_PARAM_RADIUS;
			for (const [phys, expected] of [[1, D_PAD.MIN_VISUAL_RADIUS_PX], [2, 2], [2.5, 2.5], [5, 5]]) {
				const z = zoomFor(phys);
				const context = { rocket: null, host: PAD_HOST, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: z };
				assertNear(pad._visualScreenRadius(context, z), expected, 1e-12, `no rocket, physical ${phys} px`);
				assertNear(pad._getVisualMultiplier(context), expected / phys, 1e-12, `no rocket multiplier, ${phys} px`);
				assertNear(drawnPad(pad, context).rPx, expected, 1e-12, `no rocket structures, ${phys} px`);
				// A rocket object without _getDrawRadius is treated the same way
				const plain = { ...context, rocket: { isHoldDown: false } };
				assertNear(pad._visualScreenRadius(plain, z), expected, 1e-12, `plain rocket object, ${phys} px`);
			}
			// The multiplier is 1 without a physical radius or zoom (unchanged)
			pad.rocketRadius = 0;
			assert.equal(pad._getVisualMultiplier({ rocket: null, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: 1 }), 1.0);
			pad.rocketRadius = D_ROCKET_PARAM_RADIUS;
			assert.equal(pad._getVisualMultiplier({ rocket: null, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: 0 }), 1.0);
		});
	});
});

/*******************************************************************
 * 5. NOZZLE_BOTTOM_OFFSET pin (§5.1-9)
 *******************************************************************/
describe('Unit 12-5: NOZZLE_BOTTOM_OFFSET equals the geometry nozzle exit (design §1.4.2, test plan §5.1-9)', () => {
	const KEYS = [[1, 'SINGLE_STAGE'], [2, 'TWO_STAGE'], [3, 'THREE_STAGE']];

	it('each value equals -geometry.plume.x of the full stack at R = 1, bit for bit (rocket.json, the live and seeded settings)', () => {
		const json = JSON.parse(fs.readFileSync(new URL('../../presets/visuals/rocket.json', import.meta.url), 'utf8')).ALIGNMENT.NOZZLE_BOTTOM_OFFSET;
		const seeded = new PresetManager({ skipDiskLoad: true }).getRocketVisual();
		for (const [n, key] of KEYS) {
			const rocket = { stages: stagesOf(n), currentStageIndex: 0, fairing: { enabled: true } };
			const nozzle = -RocketRenderer._computeStackGeometry(rocket, 1).plume.x;
			assert.ok(Object.is(nozzle, D_NOZZLE_BOTTOM_OFFSET[key]), `${key}: ${nozzle} vs design ${D_NOZZLE_BOTTOM_OFFSET[key]}`);
			assert.ok(Object.is(nozzle, ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET[key]), `${key}: live setting`);
			assert.ok(Object.is(nozzle, json[key]), `${key}: rocket.json`);
			const seededNozzle = -RocketRenderer._computeStackGeometry(rocket, 1, seeded).plume.x;
			assert.ok(Object.is(seededNozzle, seeded.ALIGNMENT.NOZZLE_BOTTOM_OFFSET[key]), `${key}: _seedFallbacks (${seededNozzle})`);
		}
	});

	it('the full-stack nozzle does not depend on the fairing, the SRBs or disableStaging', () => {
		for (const [n, key] of KEYS) {
			for (const over of [{ fairing: { enabled: false } }, { fairing: null }, { boosters: { count: 4 } }, { disableStaging: true }, { telemetry: { stageIndex: 0, totalStages: n } }]) {
				const rocket = { stages: stagesOf(n), currentStageIndex: 0, fairing: { enabled: true }, ...over };
				const nozzle = -RocketRenderer._computeStackGeometry(rocket, 1).plume.x;
				assert.ok(Object.is(nozzle, ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET[key]), `${key} with ${JSON.stringify(over)}`);
			}
		}
	});
});

/*******************************************************************
 * Unit 12-6: the minimum over a range and the arm length rule (Gate 3 G3-1-01, G3-1-03)
 *******************************************************************/
describe('Unit 12-6: silhouette minimum inside a range, the arm length rule and the fairing curve (design §3.8-1/-2)', () => {
	const stagesOf3 = () => Array.from({ length: 3 }, () => ({ fuelType: 'liquid' }));

	it('minBodyRadiusOver: the minimum lies on an interior part, narrower than both ends (3-stage: stage 3 between interstage 2 and the fairing)', () => {
		const g = RocketRenderer._computeStackGeometry({ stages: stagesOf3(), currentStageIndex: 0, fairing: { enabled: true } }, 1);
		// Design §3.2: interstage 2 [1.25, 1.5] radius 0.65, stage 3 [1.5, 2.4] radius 0.55, fairing from 2.4 (radius 0.65 at its base)
		const atStart = RocketRenderer.bodyRadiusAt(g, 1.4);
		const atEnd = RocketRenderer.bodyRadiusAt(g, 2.5);
		assert.equal(atStart, 0.65, 'x = 1.4 is on interstage 2');
		assert.ok(atEnd > 0.6 && atEnd < 0.65, `x = 2.5 is on the fairing curve near its base (${atEnd})`);
		assert.equal(RocketRenderer.minBodyRadiusOver(g, 1.4, 2.5), 0.55, 'the narrowest part inside the range is stage 3');
		assert.equal(RocketRenderer.minBodyRadiusOver(g, 2.5, 1.4), 0.55, 'the same for the reversed range');
	});

	it('the arm reaches the narrowest silhouette under its end face, not the silhouette at x = UMBILICAL_TOP_X_MULT', () => {
		// Shift the 3-stage stack 0.9 R aft (BASE_X_3STG_STAGE1_RATIO -4.0): stage 3 [0.6, 1.5] radius 0.55, the fairing from
		// 1.5 (radius 0.65). Under the end face [1.275, 1.6] the narrowest silhouette is stage 3; at x = 1.6 it is the fairing.
		const stored = presetManager.visuals.get('rocket');
		const shifted = JSON.parse(JSON.stringify(stored));
		shifted.ALIGNMENT.BASE_X_3STG_STAGE1_RATIO = -4.0;
		presetManager.visuals.set('rocket', shifted);
		try {
			const pad = new PadEffectRenderer();
			pad.start(950, 2);
			const rocket = new Rocket(950, 'Pad Rocket', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 25, 0, null, 0);
			Object.assign(rocket, { stages: stagesOf3(), totalStages: 3, currentStageIndex: 0, fairing: { enabled: true, isSeparated: false },
				isHoldDown: true, isIgnited: false, baseRadiusM: 50, bottomOffsetM: 50 * 3.45, thrustAngle: 0, x: 0, y: 0 });
			const g = RocketRenderer._computeStackGeometry(rocket, 1);
			assertNear(g.fairing.startX, 1.5, 1e-12, 'precondition: the fairing base is inside the end face');
			const atTop = RocketRenderer.bodyRadiusAt(g, 1.6);
			assert.ok(atTop > 0.6 && atTop < 0.65, `precondition: the fairing curve 0.1 R past its base at x = 1.6 (${atTop})`);
			const anchors = pad._padAnchors({ rocket, host: { id: 2, x: 0, y: 0, rotationAngle: 0 }, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: 1 });
			// Design §3.8-2: |UMBILICAL_OFFSET_Y| (1.4) minus the narrowest silhouette over [1.275, 1.6] (stage 3, 0.55)
			assertNear(anchors.armLen, 1.4 - 0.55, 1e-12, 'arm length to stage 3');
			assert.ok(Math.abs(anchors.armLen - (1.4 - atTop)) > 0.05, `not the length to the silhouette at x = 1.6 (${1.4 - atTop})`);
		} finally {
			presetManager.visuals.set('rocket', stored);
		}
	});

	describe('the arm length rule at the aft end of the end face (Gate 3 G3-2-01)', () => {
		// Shift the 3-stage stack aft so that the forward end of stage 3 (2.4 at the shipped BASE_X_3STG_STAGE1_RATIO -3.1),
		// where the fairing starts, falls inside, just inside, just outside or short of the end face
		// [UMBILICAL_TOP_X_MULT - armThick, UMBILICAL_TOP_X_MULT] = [1.275, 1.6] (design §3.8-2)
		const h = D_HULL[3];
		const stage3 = h.bodies[4];
		const AFT_END = D_PAD.UMBILICAL_TOP_X_MULT - D_ARM_THICK;
		const NOMINAL_RATIO = -3.1;
		const armWithStage3Front = (front) => {
			const stored = presetManager.visuals.get('rocket');
			const shifted = JSON.parse(JSON.stringify(stored));
			shifted.ALIGNMENT.BASE_X_3STG_STAGE1_RATIO = NOMINAL_RATIO + (front - h.fairingX);
			presetManager.visuals.set('rocket', shifted);
			try {
				const pad = new PadEffectRenderer();
				pad.start(951, 2);
				const rocket = new Rocket(951, 'Pad Rocket', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 25, 0, null, 0);
				Object.assign(rocket, { stages: stagesOf3(), totalStages: 3, currentStageIndex: 0, fairing: { enabled: true, isSeparated: false },
					isHoldDown: true, isIgnited: false, baseRadiusM: 50, bottomOffsetM: 50 * 3.45, thrustAngle: 0, x: 0, y: 0 });
				const g = RocketRenderer._computeStackGeometry(rocket, 1);
				const anchors = pad._padAnchors({ rocket, host: { id: 2, x: 0, y: 0, rotationAngle: 0 }, m2pix: (m) => UnitConvertUtils.m2pix(m), zoomScale: 1 });
				return { g, armLen: anchors.armLen };
			} finally {
				presetManager.visuals.set('rocket', stored);
			}
		};
		// [name, stage-3 front, whether stage 3 reaches into the end face]
		const CASES = [
			['stage 3 reaches 0.075 R into the end face (front 1.35): a halved end face [1.4375, 1.6] would miss it', 1.35, true],
			['the fairing covers the whole end face (front 1.2): a doubled end face [0.95, 1.6], or one without UMBILICAL_H_MULT, would reach stage 3', 1.2, false],
			['stage 3 ends just inside the aft end (front 1.275 + 1e-6)', AFT_END + 1e-6, true],
			['stage 3 ends just outside the aft end (front 1.275 - 1e-6)', AFT_END - 1e-6, false]
		];
		for (const [name, front, reaches] of CASES) {
			it(name, () => {
				const { g, armLen } = armWithStage3Front(front);
				const s3 = g.segments.find(s => s.kind === 'stage' && s.stageIndex === 2);
				assertNear(s3.startX + s3.length, front, 1e-12, 'precondition: the stage-3 front');
				assertNear(g.fairing.startX, front, 1e-12, 'precondition: the fairing base');
				// The silhouette over the end face: stage 3 where it reaches into it, else the fairing curve, which narrows
				// towards the nose and so is narrowest at x = UMBILICAL_TOP_X_MULT
				const toStage3 = Math.abs(D_PAD.UMBILICAL_OFFSET_Y) - stage3.r;
				const toFairingTop = Math.abs(D_PAD.UMBILICAL_OFFSET_Y) - fairingCurveAt(front, h.fairingR, D_PAD.UMBILICAL_TOP_X_MULT);
				assert.ok(Math.abs(toStage3 - toFairingTop) > 0.01, `precondition: the two lengths differ (${toStage3}, ${toFairingTop})`);
				assertNear(armLen, reaches ? toStage3 : toFairingTop, 1e-12, 'arm length');
			});
		}
	});

	it('_fairingRadiusAt: no cancellation next to the linear case, near x = startX, or with the control point before the start', () => {
		// Bisection on the drawn quadratic Bezier: it converges to the t where x(t) stops being below x. For a ratio in
		// [0, 1] that is the only root in [0, 1]. Where x(t) = x has two roots in [0, 1] it is the one _fairingRadiusAt
		// takes too ((-qb + root) / (2 qa)): at x = startX with a negative ratio, the root after the curve's dip aft of the
		// base (not t = 0); at x = startX + length with ratio 1.2, t = 5/7, where the curve first reaches the tip's x
		// before bulging past it (not t = 1)
		const bisect = (f, x, X, Y) => {
			const cx = f.startX + f.length * X;
			const ex = f.startX + f.length;
			const xt = (t) => (1 - t) * (1 - t) * f.startX + 2 * t * (1 - t) * cx + t * t * ex;
			let lo = 0;
			let hi = 1;
			for (let i = 0; i < 200; i++) {
				const mid = 0.5 * (lo + hi);
				if (xt(mid) < x) lo = mid; else hi = mid;
			}
			const t = 0.5 * (lo + hi);
			return (1 - t) * (1 - t) * f.radius + 2 * t * (1 - t) * f.radius * Y;
		};
		const f = { startX: 1, radius: 0.6, length: 2 };
		for (const X of [0.5 - 1e-9, 0.5 - 1e-11, 0.5 - 1e-12, 0.5 + 1e-13, 0.5 + 1e-12, 0.5 + 1e-11, 0.5 + 1e-9, 0.7, 1.2, -0.1, -0.5]) {
			const cfg = { MODULES: { FAIRING_CURVE_X_RATIO: X, FAIRING_CURVE_Y_RATIO: 0.9 } };
			for (const x of [1, 1 + 1e-9, 1 + 1e-6, 1.3, 2, 2.9, 3]) {
				assertNear(RocketRenderer._fairingRadiusAt(f, x, cfg), bisect(f, x, X, 0.9), 1e-12, `ratio 0.5 ${X >= 0.5 ? '+' : '-'} ${Math.abs(X - 0.5)}, x = ${x}`);
			}
		}
	});

	it('_fairingRadiusAt: ratio 0 and ratio 1 (closed forms) and a fairing of length 0 (Gate 3 G3-3-01)', () => {
		const f = { startX: 1, radius: 0.6, length: 2 };
		const Y = 0.9;
		const yAt = (t) => (1 - t) * (1 - t) * f.radius + 2 * t * (1 - t) * f.radius * Y;
		const cfg = (X) => ({ MODULES: { FAIRING_CURVE_X_RATIO: X, FAIRING_CURVE_Y_RATIO: Y } });
		for (const x of [1, 1 + 1e-9, 1 + 1e-6, 1.3, 2, 2.9, 3]) {
			const u = (x - f.startX) / f.length;
			// Ratio 0 (control point above the base, qb = 0): x(t) = startX + t^2 length
			assertNear(RocketRenderer._fairingRadiusAt(f, x, cfg(0)), yAt(Math.sqrt(u)), 1e-12, `ratio 0, x = ${x}`);
			// Ratio 1 (control point above the tip): x(t) = startX + (2t - t^2) length
			assertNear(RocketRenderer._fairingRadiusAt(f, x, cfg(1)), yAt(1 - Math.sqrt(1 - u)), 1e-12, `ratio 1, x = ${x}`);
		}
		// A fairing of length 0: its only point is the base (qa = qb = qc = 0)
		for (const X of [0, 0.5, 0.7, 1]) {
			assert.equal(RocketRenderer._fairingRadiusAt({ startX: 1, radius: 0.6, length: 0 }, 1, cfg(X)), 0.6, `length 0, ratio ${X}`);
		}
	});

	it('_fairingRadiusAt: the linear case (control point at the middle of the fairing) follows the drawn Bezier', () => {
		// With FAIRING_CURVE_X_RATIO = 0.5 the x of the quadratic Bezier is linear in t: x = startX + t * length
		const cfg = { MODULES: { FAIRING_CURVE_X_RATIO: 0.5, FAIRING_CURVE_Y_RATIO: 0.9 } };
		const f = { startX: 1, radius: 0.6, length: 2 };
		for (const t of [0, 0.25, 0.5, 0.9, 1]) {
			const expected = (1 - t) * (1 - t) * 0.6 + 2 * t * (1 - t) * 0.6 * 0.9;
			assertNear(RocketRenderer._fairingRadiusAt(f, 1 + 2 * t, cfg), expected, 1e-12, `t = ${t}`);
		}
	});
});
