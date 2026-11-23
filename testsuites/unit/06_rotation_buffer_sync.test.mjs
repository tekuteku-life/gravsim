/**
 * Unit Test Suite 06: Rotation SSOT, 51-slot Worker Buffer, Hold-down Sync, Two-Pass Commit,
 * Actual-Flight-Path Recording and Subtraction-first Projection (work unit A).
 *
 * Expected values are derived from the design document, not from the current output:
 *   docs/design/2026-11-20_trajectory_fx_flightplan.md
 *     §3.1.1 (BUFFER_INDEX 47..50, OBJ_ATTR_COUNT 51, ROCKET_FLAG bits 16..19, stage-state codes,
 *             rotationAngle SSOT, hold-down sync, two-pass ObjectManager.updateObjectParams,
 *             Rocket._recordActualFlightPath newest-point retention; Rev 6.10: single spin-rate source
 *             PhysicsEngine._getRotationOmega, held rockets skipped in _updateFinalVelocity,
 *             updateObject omits a non-finite rotationAngle, slot 48 mach fallback order)
 *     §3.1.2 last bullet (subtraction-first projection in TrajectoryPredictor / TrailRenderer)
 *     §3.5-1 (_applyRocketState `!== undefined` / Number.isFinite guards)
 *     §4.8   (PadEffectRenderer follows host.rotationAngle via padRefRotationAngle, G2-09)
 *     §4.10  (actual-flight-path `time` and frame-dependent recording rule, G2-3-03)
 *   docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-A
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

import {
	BUFFER_INDEX, CALC_BUFFER_CONFIG, ROCKET_FLAG, OBJECT_FLAG, STAGE_STATE_TO_CODE, CODE_TO_STAGE_STATE,
	OBJECT_TYPES, OBJECT_STATE, TRAIL_MODE, RENDER, MULTISTAGE_ROCKET
} from '../../scripts/gravsim_const.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { PredictorPhysicsEngine } from '../../scripts/gravsim_calc_predictor.js';
import { CalcCelestialBody, CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { EffectRenderer } from '../../scripts/gravsim_trail_renderer.js';
import { EffectTrail } from '../../scripts/gravsim_effect_trail.js';
import { Universe } from '../../scripts/gravsim_universe.js';

setupMockDOM();

const ATTR = CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;
const TWO_PI = 2 * Math.PI;
const SLOTS_47_50 = ['ROTATION_ANGLE', 'TM_MACH', 'STAGE_STATE_CODE', 'STG_TIMER'];
const MIN_SAMPLE_M = RENDER.PREDICTED_TRAJECTORY.ACTUAL_SAMPLE_MIN_DIST_M;
const MAX_ACTUAL = RENDER.PREDICTED_TRAJECTORY.ACTUAL_MAX_POINTS;

// ---------------------------------------------------------------------------
// Local helpers (kept inside this file on purpose)
// ---------------------------------------------------------------------------

/** Adjacent IEEE-754 double (dir > 0: next up, dir < 0: next down) for finite positive x. */
const nextFloat = (x, dir) => {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, x);
	const bits = view.getBigUint64(0);
	view.setBigUint64(0, dir > 0 ? bits + 1n : bits - 1n);
	return view.getFloat64(0);
};

/** Slot values 47..50 of object index i in a formatted buffer. */
const slots4750 = (buf, i) => SLOTS_47_50.map((k) => buf[i * ATTR + BUFFER_INDEX[k]]);

/** Parse a formatted buffer and return detached copies of every callback record. */
const parseAll = (buf) => {
	const out = [];
	WorkerBridge.parseWorkerToMain(buf.buffer, buf.length, (d) => out.push({ ...d }));
	return out;
};

/** Plain worker-side rocket record (duck-typed like CalcRocket for formatWorkerToMain). */
const workerRocket = (over = {}) => ({
	id: 10, type: OBJECT_TYPES.ROCKET, x: 1000, y: 2000, vx: 3, vy: 4, ax: 0.5, ay: 0.25,
	dryMass: 5, fuelMass: 6, oxidMass: 7, burnTime: 8, _thrustRatio: 0.5, thrustAngle: 0.75, radius: 2,
	currentStageIndex: 0, totalStages: 2, tankPresFuel: 300, tankPresOxid: 310, ambientPresRatio: 0.5,
	currentIsp: 300, mach: 0, stageState: 'PRE_LAUNCH', stgTimer: 0, ...over
});
const workerBody = (over = {}) => ({
	id: 1, type: OBJECT_TYPES.CELESTIAL, x: 11, y: 12, vx: 13, vy: 14, ax: 0, ay: 0,
	mass: 5.972e24, radius: 6.378e6, rotationAngle: 0, ...over
});
const workerDebris = (over = {}) => ({
	id: 20, type: OBJECT_TYPES.DEBRIS, x: 21, y: 22, vx: 23, vy: 24, ax: 0, ay: 0,
	mass: 1.5, radius: 3, debrisSubType: 2, ...over
});

/** Formats one worker object and returns its parsed record. */
const roundTrip = (obj) => {
	WorkerBridge._bufferPool.length = 0;
	return parseAll(WorkerBridge.formatWorkerToMain([obj]))[0];
};

/** Engine body with an explicit param (unknown name, so no preset fallback interferes). */
const addTestBody = (engine, over = {}) => engine.addObject({
	id: 1, name: 'UnitTestBody', type: OBJECT_TYPES.CELESTIAL,
	x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: 6.378e6, ...over
});

/** Hold-down world: optional far perturbing body + rotating host + held rocket. */
const buildHoldDownWorld = ({ period = 86164, hostSpin = null, withPerturber = true, thrustForce = 5e6, hostAltM = 10, bottomOffsetM = 30, theta0 = 0.5, rot0 = 0.3, EngineClass = 'physics' } = {}) => {
	// hostSpin = { param, rotationPeriod } selects where the host's period lives (default: param.ROTATION_PERIOD = period)
	const spin = hostSpin || { param: { ROTATION_PERIOD: period } };
	const hostParam = spin.param;
	if (EngineClass === 'predictor') {
		const bodies = [];
		if (withPerturber) {
			const sun = new CalcCelestialBody(100, 'UnitTestSun', -1.495978707e11, 0, 0, 0, 0, 0, 6.96e8, 0, 1.989e30);
			sun.param = { ROTATION_PERIOD: 0 };
			bodies.push(sun);
		}
		const host = new CalcCelestialBody(2, 'UnitTestHost', 0, 0, 0, 29780, 0, 0, 6.378e6, 0, 5.972e24);
		host.param = hostParam ?? null;
		if (Object.prototype.hasOwnProperty.call(spin, 'rotationPeriod')) { host.rotationPeriod = spin.rotationPeriod; }
		host.rotationAngle = rot0;
		bodies.push(host);
		const rocket = new CalcRocket(3, 'UnitTestRocket', 6.378e6 + bottomOffsetM, 0, 0, 0, 0, 0, bottomOffsetM, 0, 20, 100, 0, {
			thrustForce, burnTime: 100, isHoldDown: true, isIgnited: true, hostId: 2, hostAngleRad: theta0, hostAltM, bottomOffsetM
		});
		const engine = new PredictorPhysicsEngine(bodies, rocket, 2, 3600);
		return { engine, host, rocket, step: (dt) => engine.step(dt) };
	}
	const engine = new PhysicsEngine();
	if (withPerturber) {
		engine.addObject({ id: 100, name: 'UnitTestSun', type: OBJECT_TYPES.CELESTIAL, x: -1.495978707e11, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 6.96e8, param: { ROTATION_PERIOD: 0 } });
	}
	const host = engine.addObject({ id: 2, name: 'UnitTestHost', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 29780, mass: 5.972e24, radius: 6.378e6, param: hostParam, rotationPeriod: spin.rotationPeriod, rotationAngle: rot0 });
	const rocket = engine.addObject({
		id: 3, name: 'UnitTestRocket', type: OBJECT_TYPES.ROCKET, x: 6.378e6 + bottomOffsetM, y: 0, mass: 20, fuelMass: 100, oxidMass: 0,
		thrustForce, burnTime: 100, isHoldDown: true, isIgnited: true, hostId: 2, hostAngleRad: theta0, hostAltM, bottomOffsetM, radius: bottomOffsetM
	});
	return { engine, host, rocket, step: (dt) => engine._moveObjects(dt) };
};

/** Asserts the design hold-down relations: pos = host + r(cosθ, sinθ), v = host.v + ω × r, a = host.a. */
const assertHeldOnHost = (rocket, host, omega, r, msg) => {
	const dx = r * Math.cos(rocket.hostAngleRad);
	const dy = r * Math.sin(rocket.hostAngleRad);
	assert.ok(Math.abs((rocket.x - host.x) - dx) <= 1e-6, `${msg}: x offset`);
	assert.ok(Math.abs((rocket.y - host.y) - dy) <= 1e-6, `${msg}: y offset`);
	assert.ok(Math.abs(rocket.vx - (host.vx - omega * dy)) <= 1e-9, `${msg}: vx = host.vx - ω·dy`);
	assert.ok(Math.abs(rocket.vy - (host.vy + omega * dx)) <= 1e-9, `${msg}: vy = host.vy + ω·dx`);
	assert.equal(rocket.ax, host.ax, `${msg}: ax follows host`);
	assert.equal(rocket.ay, host.ay, `${msg}: ay follows host`);
	assert.equal(rocket.thrustAngle, rocket.hostAngleRad, `${msg}: thrust axis = local zenith`);
	assert.equal(rocket.dominantBody, host, `${msg}: dominant body is the host`);
	assert.equal(rocket.distToDominantM, r, `${msg}: distance to host`);
};

/** Main-thread rocket for history / path tests. */
const makeMainRocket = (id, x, y, over = {}) => {
	const r = new Rocket(id, 'UnitRocket', x, y, 0, 0, 10, 0, 0, '#ffffff', 2, 30, 0);
	r.isHoldDown = false;
	r.isIgnited = true;
	Object.assign(r, over);
	return r;
};
const makeMainBody = (id, x, y, over = {}) => {
	const b = new CelestialBody(id, 'UnitHost', x, y, 0, 0, 5.972e21, '#3366cc', 5, 6.378e6, 0);
	Object.assign(b, over);
	return b;
};

/** Recording 2D context for drawn-coordinate assertions. */
const createRecordingCtx = () => {
	const calls = [];
	const rec = (op) => (...args) => calls.push({ op, args });
	return {
		calls,
		canvas: { width: 2000, height: 2000 },
		save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
		moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quadraticCurveTo'),
		stroke: rec('stroke'), fill: rec('fill'), arc: rec('arc'), fillRect: rec('fillRect'),
		fillText: rec('fillText'), setLineDash: rec('setLineDash'),
		measureText: (t) => ({ width: String(t).length * 6 })
	};
};
const pathVertices = (calls) => calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => ({ x: c.args[0], y: c.args[1] }));

// ===========================================================================
// A-1: buffer layout constants and stage-state code tables (§3.1.1-1)
// ===========================================================================
describe('Unit 06-A1: BUFFER_INDEX / OBJ_ATTR_COUNT / ROCKET_FLAG / stage-state code tables', () => {
	it('defines ROTATION_ANGLE=47, TM_MACH=48, STAGE_STATE_CODE=49, STG_TIMER=50 and OBJ_ATTR_COUNT=51', () => {
		assert.equal(BUFFER_INDEX.ROTATION_ANGLE, 47);
		assert.equal(BUFFER_INDEX.TM_MACH, 48);
		assert.equal(BUFFER_INDEX.STAGE_STATE_CODE, 49);
		assert.equal(BUFFER_INDEX.STG_TIMER, 50);
		assert.equal(CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT, 51);
	});

	it('maps BUFFER_INDEX one-to-one onto 0..50 (boundary: min 0, max OBJ_ATTR_COUNT-1, no gap, no duplicate)', () => {
		const values = Object.values(BUFFER_INDEX);
		assert.equal(values.length, ATTR, 'one index per attribute slot');
		assert.equal(new Set(values).size, ATTR, 'no two attributes share a slot');
		assert.equal(Math.min(...values), 0);
		assert.equal(Math.max(...values), ATTR - 1, 'highest slot is the last one inside a record');
		for (const v of values) { assert.ok(Number.isInteger(v), `slot ${v} is an integer`); }
	});

	it('places RCS_CW/RCS_CCW/RCS_ULLAGE/HAS_PAYLOAD_PROP on bits 16..19, frozen, disjoint, inside positive int32', () => {
		assert.equal(ROCKET_FLAG.RCS_CW, 1 << 16);
		assert.equal(ROCKET_FLAG.RCS_CCW, 1 << 17);
		assert.equal(ROCKET_FLAG.RCS_ULLAGE, 1 << 18);
		assert.equal(ROCKET_FLAG.HAS_PAYLOAD_PROP, 1 << 19);
		assert.ok(Object.isFrozen(ROCKET_FLAG));
		assert.throws(() => { ROCKET_FLAG.RCS_CW = 1; }, TypeError);

		const all = [...Object.values(OBJECT_FLAG), ...Object.values(ROCKET_FLAG)];
		let mask = 0;
		for (const f of all) {
			assert.equal(f & (f - 1), 0, `flag ${f} is a single bit`);
			assert.equal(mask & f, 0, `flag ${f} does not overlap another flag`);
			mask |= f;
		}
		assert.ok(mask > 0 && mask <= 0x7fffffff, 'OR of every flag stays a positive signed 32-bit value');
		assert.equal(mask, (1 << 20) - 1, 'flags fill bits 0..19 with the new bits at the top');
	});

	it('defines frozen, mutually inverse STAGE_STATE_TO_CODE / CODE_TO_STAGE_STATE for the 6 states', () => {
		const expected = ['PRE_LAUNCH', 'STG_BURNING', 'STG_MECO', 'INTERSTAGE_COAST', 'STG_COAST', 'ORBITAL_COAST'];
		assert.deepEqual([...CODE_TO_STAGE_STATE], expected);
		assert.deepEqual({ ...STAGE_STATE_TO_CODE }, { PRE_LAUNCH: 0, STG_BURNING: 1, STG_MECO: 2, INTERSTAGE_COAST: 3, STG_COAST: 4, ORBITAL_COAST: 5 });
		for (let code = 0; code < expected.length; code++) {
			assert.equal(STAGE_STATE_TO_CODE[CODE_TO_STAGE_STATE[code]], code, `code ${code} -> name -> code`);
		}
		for (const name of Object.keys(STAGE_STATE_TO_CODE)) {
			assert.equal(CODE_TO_STAGE_STATE[STAGE_STATE_TO_CODE[name]], name, `${name} -> code -> name`);
		}
		assert.ok(Object.isFrozen(STAGE_STATE_TO_CODE) && Object.isFrozen(CODE_TO_STAGE_STATE));
		assert.throws(() => { STAGE_STATE_TO_CODE.PRE_LAUNCH = 9; }, TypeError);
		assert.throws(() => { CODE_TO_STAGE_STATE[0] = 'X'; }, TypeError);
		assert.throws(() => { CODE_TO_STAGE_STATE.push('X'); }, TypeError);
	});

	it('raw table lookups are undefined for unknown names and for out-of-range / fractional / NaN codes', () => {
		for (const bad of ['UNKNOWN', '', 'pre_launch', 'Orbital_Coast', undefined, null]) {
			assert.equal(STAGE_STATE_TO_CODE[bad], undefined, `name ${String(bad)}`);
			assert.equal(STAGE_STATE_TO_CODE[bad] ?? 0, 0, `fallback code for ${String(bad)}`);
		}
		for (const code of [-1, 6, 7, 1.5, 0.5, 5.000001, NaN, Infinity, -Infinity]) {
			assert.equal(CODE_TO_STAGE_STATE[code], undefined, `raw index ${code}`);
			assert.equal(CODE_TO_STAGE_STATE[code] || 'PRE_LAUNCH', 'PRE_LAUNCH', `fallback for raw index ${code}`);
		}
	});
});

// ===========================================================================
// A-2: WorkerBridge 51-slot format / parse (§3.1.1-1)
// ===========================================================================
describe('Unit 06-A2: WorkerBridge slot 47..50 formatting, pool reuse and parsing', () => {
	beforeEach(() => { WorkerBridge._bufferPool.length = 0; });

	it('celestial: slot 47 carries rotationAngle (negative / large kept, NaN / undefined -> 0), slots 48..50 are 0', () => {
		const cases = [
			{ rot: 1.25, exp: 1.25 }, { rot: -2.5, exp: -2.5 }, { rot: 0, exp: 0 },
			{ rot: 1e6, exp: 1e6 }, { rot: NaN, exp: 0 }, { rot: undefined, exp: 0 }
		];
		const buf = WorkerBridge.formatWorkerToMain(cases.map((c, i) => workerBody({ id: i + 1, rotationAngle: c.rot, mach: 3, stageState: 'ORBITAL_COAST', stgTimer: 9 })));
		assert.equal(buf.length, cases.length * ATTR);
		cases.forEach((c, i) => {
			assert.deepEqual(slots4750(buf, i), [c.exp, 0, 0, 0], `rotationAngle ${c.rot}`);
		});
	});

	it('rocket: slot 47 is 0, slot 48 = mach, slot 49 = stage code (unknown -> 0), slot 50 = stgTimer (NaN / undefined -> 0)', () => {
		const states = Object.keys(STAGE_STATE_TO_CODE);
		const objs = states.map((s, i) => workerRocket({ id: i + 1, stageState: s, mach: 0.25 * i, stgTimer: 1.5 * i, rotationAngle: 4.0 }));
		objs.push(workerRocket({ id: 50, stageState: 'NOT_A_STATE', mach: 0, stgTimer: NaN }));
		objs.push(workerRocket({ id: 51, stageState: undefined, mach: undefined, stgTimer: undefined }));
		objs.push(workerRocket({ id: 52, stageState: 'ORBITAL_COAST', mach: 2.75, stgTimer: -1.25 }));
		const buf = WorkerBridge.formatWorkerToMain(objs);
		states.forEach((s, i) => {
			assert.deepEqual(slots4750(buf, i), [0, 0.25 * i, STAGE_STATE_TO_CODE[s], 1.5 * i], `state ${s}`);
		});
		assert.deepEqual(slots4750(buf, states.length), [0, 0, 0, 0], 'unknown state and NaN timer');
		assert.deepEqual(slots4750(buf, states.length + 1), [0, 0, 0, 0], 'missing mach / state / timer');
		assert.deepEqual(slots4750(buf, states.length + 2), [0, 2.75, 5, -1.25], 'negative timer is passed through (|| 0 only replaces falsy)');
	});

	it('rocket slot 48 fallback order (Rev 6.10): obj.mach, then the flight-computer telemetry mach, then 0', () => {
		const fc = (mach) => ({ getTelemetry: () => ({ mach }) });
		const cases = [
			{ label: 'own mach wins', over: { mach: 1.2, flightComputer: fc(3) }, exp: 1.2 },
			{ label: 'own mach 0 wins (not nullish)', over: { mach: 0, flightComputer: fc(3) }, exp: 0 },
			{ label: 'undefined -> telemetry', over: { mach: undefined, flightComputer: fc(3) }, exp: 3 },
			{ label: 'null -> telemetry', over: { mach: null, flightComputer: fc(2.5) }, exp: 2.5 },
			{ label: 'telemetry 0 kept', over: { mach: undefined, flightComputer: fc(0) }, exp: 0 },
			{ label: 'telemetry without mach -> 0', over: { mach: undefined, flightComputer: fc(undefined) }, exp: 0 },
			{ label: 'no flight computer -> 0', over: { mach: undefined }, exp: 0 },
			{ label: 'main-thread style obj.telemetry is not a source', over: { mach: undefined, telemetry: { mach: 1.7 } }, exp: 0 }
		];
		const buf = WorkerBridge.formatWorkerToMain(cases.map((c, i) => workerRocket({ id: i + 1, ...c.over })));
		const parsed = parseAll(buf);
		cases.forEach((c, i) => {
			assert.equal(buf[i * ATTR + BUFFER_INDEX.TM_MACH], c.exp, c.label);
			assert.equal(parsed[i].mach, c.exp, `${c.label} (parsed)`);
		});
	});

	it('rocket slot 48 with a real CalcRocket: numeric mach is used; without it the FlightComputer telemetry cache is used', () => {
		const cr = new CalcRocket(9, 'UnitTestRocket', 7e6, 0, 0, 7500, 0, 0, 30, 0, 1, 0, 0, { isIgnited: false });
		assert.equal(typeof cr.mach, 'number', 'precondition: CalcRocket always carries a numeric mach');
		cr.mach = 0.65;
		cr.flightComputer.telemetryCache.mach = 0.8;
		assert.equal(WorkerBridge.formatWorkerToMain([cr])[BUFFER_INDEX.TM_MACH], 0.65);
		WorkerBridge._bufferPool.length = 0;
		cr.mach = undefined;
		assert.equal(WorkerBridge.formatWorkerToMain([cr])[BUFFER_INDEX.TM_MACH], 0.8);
	});

	it('rocket: mach 0 is kept as 0 (nullish fallback only for null / undefined)', () => {
		const buf = WorkerBridge.formatWorkerToMain([workerRocket({ mach: 0 }), workerRocket({ id: 11, mach: null })]);
		assert.equal(buf[BUFFER_INDEX.TM_MACH], 0);
		assert.equal(buf[ATTR + BUFFER_INDEX.TM_MACH], 0);
	});

	it('debris: slots 47..50 are always 0 even if the object carries rotation / mach / stage fields; sub type kept', () => {
		const buf = WorkerBridge.formatWorkerToMain([
			workerDebris({ rotationAngle: 2.0, mach: 1.1, stageState: 'STG_MECO', stgTimer: 3, debrisSubType: 3 }),
			workerDebris({ id: 21, debrisSubType: undefined })
		]);
		assert.deepEqual(slots4750(buf, 0), [0, 0, 0, 0]);
		assert.equal(buf[BUFFER_INDEX.DEBRIS_SUB_TYPE], 3);
		assert.equal(buf[ATTR + BUFFER_INDEX.DEBRIS_SUB_TYPE], 0, 'missing sub type -> 0');
	});

	it('pool reuse: a recycled buffer pre-filled with a sentinel has every one of the 51 slots overwritten for each type', () => {
		const SENTINEL = 777.25;
		const pooled = new Float64Array(3 * ATTR).fill(SENTINEL);
		WorkerBridge.recycleBuffer(pooled.buffer);
		const out = WorkerBridge.formatWorkerToMain([workerBody({ rotationAngle: 0.5 }), workerRocket({ stageState: 'STG_MECO', mach: 1.5, stgTimer: 2 }), workerDebris()]);
		assert.equal(out.buffer, pooled.buffer, 'the pooled ArrayBuffer is reused');
		for (let i = 0; i < out.length; i++) {
			assert.notEqual(out[i], SENTINEL, `slot ${i % ATTR} of object ${Math.floor(i / ATTR)} was explicitly written`);
		}
		assert.deepEqual(slots4750(out, 0), [0.5, 0, 0, 0]);
		assert.deepEqual(slots4750(out, 1), [0, 1.5, 2, 2]);
		assert.deepEqual(slots4750(out, 2), [0, 0, 0, 0]);
	});

	it('pool reuse with a different type order leaves no value from the previous frame in slots 47..50', () => {
		const first = WorkerBridge.formatWorkerToMain([
			workerRocket({ id: 1, stageState: 'ORBITAL_COAST', mach: 2.5, stgTimer: 4 }),
			workerBody({ id: 2, rotationAngle: 1.75 })
		]);
		const ab = first.buffer;
		WorkerBridge.recycleBuffer(ab);
		const second = WorkerBridge.formatWorkerToMain([workerBody({ id: 2, rotationAngle: 0.125 }), workerDebris({ id: 1 })]);
		assert.equal(second.buffer, ab, 'same memory reused');
		assert.deepEqual(slots4750(second, 0), [0.125, 0, 0, 0], 'celestial written where the rocket was');
		assert.deepEqual(slots4750(second, 1), [0, 0, 0, 0], 'debris written where the celestial was');
		WorkerBridge.recycleBuffer(ab);
		const third = WorkerBridge.formatWorkerToMain([workerDebris({ id: 9 }), workerRocket({ id: 1, stageState: 'PRE_LAUNCH', mach: 0, stgTimer: 0 })]);
		assert.equal(third.buffer, ab);
		assert.deepEqual(slots4750(third, 0), [0, 0, 0, 0]);
		assert.deepEqual(slots4750(third, 1), [0, 0, 0, 0], 'rocket overwrites the celestial rotation slot with 0');
	});

	it('parse: extracts rotationAngle per type without carrying it over between consecutive records', () => {
		const records = parseAll(WorkerBridge.formatWorkerToMain([
			workerBody({ id: 1, rotationAngle: 1.2 }),
			workerRocket({ id: 2, stageState: 'INTERSTAGE_COAST', mach: 0.9, stgTimer: 1.25 }),
			workerDebris({ id: 3, debrisSubType: 4 }),
			workerBody({ id: 4, rotationAngle: -0.5 })
		]));
		assert.deepEqual(records.map((r) => r.rotationAngle), [1.2, 0, 0, -0.5]);
		assert.equal(records[1].mach, 0.9);
		assert.equal(records[1].stageState, 'INTERSTAGE_COAST');
		assert.equal(records[1].stgTimer, 1.25);
		assert.equal(records[2].debrisSubType, 4);
	});

	it('parse: a debris record decodes rotationAngle 0 wherever it sits (after a celestial, first or alone in a frame, between rockets)', () => {
		// parseWorkerToMain hands every record of every frame the same WorkerBridge._cache object, so a type branch
		// that does not write rotationAngle would leak the previous record's (or the previous frame's) angle (§3.1.1-1).
		const C = OBJECT_TYPES.CELESTIAL;
		const R = OBJECT_TYPES.ROCKET;
		const D = OBJECT_TYPES.DEBRIS;
		const decode = (objs) => parseAll(WorkerBridge.formatWorkerToMain(objs)).map((r) => [r.id, r.type, r.rotationAngle]);
		assert.deepEqual(decode([workerBody({ id: 1, rotationAngle: 1.2 }), workerDebris({ id: 2 })]), [[1, C, 1.2], [2, D, 0]], 'debris right after a celestial');
		assert.deepEqual(decode([
			workerBody({ id: 1, rotationAngle: 1.2 }), workerDebris({ id: 2 }), workerDebris({ id: 3 }),
			workerBody({ id: 4, rotationAngle: -0.5 }), workerDebris({ id: 5 })
		]), [[1, C, 1.2], [2, D, 0], [3, D, 0], [4, C, -0.5], [5, D, 0]], 'consecutive debris and debris after a negative angle');

		decode([workerBody({ id: 1, rotationAngle: 0.75 })]);
		assert.equal(WorkerBridge._cache.rotationAngle, 0.75, 'precondition: the shared cache still holds the last celestial angle');
		assert.deepEqual(decode([workerDebris({ id: 2 }), workerBody({ id: 1, rotationAngle: 0.25 })]), [[2, D, 0], [1, C, 0.25]], 'debris first in the next frame');
		decode([workerBody({ id: 1, rotationAngle: 0.75 })]);
		assert.deepEqual(decode([workerDebris({ id: 2 })]), [[2, D, 0]], 'debris alone in the next frame');

		assert.deepEqual(decode([workerRocket({ id: 1 }), workerDebris({ id: 2 }), workerRocket({ id: 3 })]), [[1, R, 0], [2, D, 0], [3, R, 0]], 'debris between rockets');
		assert.deepEqual(decode([
			workerBody({ id: 1, rotationAngle: 2.0 }), workerRocket({ id: 2 }), workerDebris({ id: 3 }),
			workerBody({ id: 4, rotationAngle: 3.0 }), workerDebris({ id: 5 }), workerRocket({ id: 6 })
		]), [[1, C, 2.0], [2, R, 0], [3, D, 0], [4, C, 3.0], [5, D, 0], [6, R, 0]], 'mixed order');
	});

	it('parse: integer codes 0..5 map to their state; fractional codes are rounded; out-of-range / NaN / Infinity -> PRE_LAUNCH', () => {
		const cases = [
			[0, 'PRE_LAUNCH'], [1, 'STG_BURNING'], [2, 'STG_MECO'], [3, 'INTERSTAGE_COAST'], [4, 'STG_COAST'], [5, 'ORBITAL_COAST'],
			[1.49, 'STG_BURNING'], [1.5, 'STG_MECO'], [4.5, 'ORBITAL_COAST'], [5.49, 'ORBITAL_COAST'],
			[5.5, 'PRE_LAUNCH'], [6, 'PRE_LAUNCH'], [1e9, 'PRE_LAUNCH'], [-0.4, 'PRE_LAUNCH'], [-0.6, 'PRE_LAUNCH'],
			[-1, 'PRE_LAUNCH'], [NaN, 'PRE_LAUNCH'], [Infinity, 'PRE_LAUNCH'], [-Infinity, 'PRE_LAUNCH']
		];
		const buf = WorkerBridge.formatWorkerToMain(cases.map((_, i) => workerRocket({ id: i + 1 })));
		cases.forEach(([code], i) => { buf[i * ATTR + BUFFER_INDEX.STAGE_STATE_CODE] = code; });
		const parsed = parseAll(buf);
		cases.forEach(([code, name], i) => assert.equal(parsed[i].stageState, name, `code ${code}`));
	});

	it('parse: NaN mach / stgTimer slots decode to 0; prototype-key stage names round-trip to PRE_LAUNCH', () => {
		assert.equal(roundTrip(workerRocket({ mach: NaN })).mach, 0);
		assert.equal(roundTrip(workerRocket({ stgTimer: NaN })).stgTimer, 0);
		for (const s of ['toString', 'constructor', '__proto__']) {
			assert.equal(roundTrip(workerRocket({ stageState: s })).stageState, 'PRE_LAUNCH', `stageState ${s}`);
		}
	});

	it('RCS / payload-propulsion flags round-trip for all 16 combinations without disturbing the other rocket flags', () => {
		const objs = [];
		for (let m = 0; m < 16; m++) {
			objs.push(workerRocket({
				id: m + 1, rcsCw: Boolean(m & 1), rcsCcw: Boolean(m & 2), rcsUllage: Boolean(m & 4), hasPayloadPropulsion: Boolean(m & 8),
				isHoldDown: m % 3 === 0, isIgnited: m % 2 === 0, isPayloadSeparated: m >= 8
			}));
		}
		const buf = WorkerBridge.formatWorkerToMain(objs);
		const parsed = parseAll(buf);
		for (let m = 0; m < 16; m++) {
			const f = buf[m * ATTR + BUFFER_INDEX.FLAGS];
			assert.equal((f >> 16) & 0xf, m, `bits 16..19 encode combination ${m}`);
			assert.equal(parsed[m].rcsCw, Boolean(m & 1));
			assert.equal(parsed[m].rcsCcw, Boolean(m & 2));
			assert.equal(parsed[m].rcsUllage, Boolean(m & 4));
			assert.equal(parsed[m].hasPayloadPropulsion, Boolean(m & 8));
			assert.equal(parsed[m].isHoldDown, m % 3 === 0);
			assert.equal(parsed[m].isIgnited, m % 2 === 0);
			assert.equal(parsed[m].isPayloadSeparated, m >= 8);
		}
	});

	it('RCS flags: truthy non-boolean inputs pack as set, falsy inputs (0, "", null, undefined) as clear', () => {
		const truthy = roundTrip(workerRocket({ rcsCw: 1, rcsCcw: 'yes', rcsUllage: {}, hasPayloadPropulsion: 2 }));
		assert.deepEqual([truthy.rcsCw, truthy.rcsCcw, truthy.rcsUllage, truthy.hasPayloadPropulsion], [true, true, true, true]);
		const falsy = roundTrip(workerRocket({ rcsCw: 0, rcsCcw: '', rcsUllage: null, hasPayloadPropulsion: undefined }));
		assert.deepEqual([falsy.rcsCw, falsy.rcsCcw, falsy.rcsUllage, falsy.hasPayloadPropulsion], [false, false, false, false]);
	});

	it('handles empty / single / many-object buffers', () => {
		const empty = WorkerBridge.formatWorkerToMain([]);
		assert.equal(empty.length, 0);
		assert.deepEqual(parseAll(empty), []);

		const single = parseAll(WorkerBridge.formatWorkerToMain([workerBody({ id: 42, rotationAngle: 3.5 })]));
		assert.equal(single.length, 1);
		assert.equal(single[0].id, 42);
		assert.equal(single[0].rotationAngle, 3.5);

		const many = [];
		for (let i = 0; i < 300; i++) {
			const t = i % 3;
			many.push(t === 0 ? workerBody({ id: i, rotationAngle: i * 0.01 }) : (t === 1 ? workerRocket({ id: i, stgTimer: i }) : workerDebris({ id: i })));
		}
		const parsed = parseAll(WorkerBridge.formatWorkerToMain(many));
		assert.equal(parsed.length, 300);
		parsed.forEach((p, i) => {
			assert.equal(p.id, i);
			assert.equal(p.rotationAngle, i % 3 === 0 ? i * 0.01 : 0);
			if (i % 3 === 1) { assert.equal(p.stgTimer, i); }
		});
	});
});

// ===========================================================================
// A-3: rotation-angle SSOT integration and add / update reflection (§3.1.1-2)
// ===========================================================================
describe('Unit 06-A3: celestial rotationAngle integration and add/update reflection', () => {
	const DT = 10;
	const periodCases = [
		{ label: 'positive (Earth sidereal)', P: 86164, delta: (TWO_PI / 86164) * DT },
		{ label: 'negative (retrograde)', P: -86164, delta: -(TWO_PI / 86164) * DT },
		{ label: 'zero', P: 0, delta: 0 },
		{ label: 'NaN', P: NaN, delta: 0 },
		{ label: '+Infinity', P: Infinity, delta: 0 },
		{ label: 'numeric string', P: '86164', delta: 0 },
		{ label: 'just below 1e-6', P: 9.99e-7, delta: 0 },
		{ label: 'exactly 1e-6', P: 1e-6, delta: 0 },
		{ label: 'just above 1e-6', P: 1.000001e-6, delta: (TWO_PI / 1.000001e-6) * DT },
		{ label: 'exactly -1e-6', P: -1e-6, delta: 0 },
		{ label: 'just beyond -1e-6', P: -1.000001e-6, delta: -(TWO_PI / 1.000001e-6) * DT }
	];

	for (const c of periodCases) {
		it(`ROTATION_PERIOD ${c.label}: rotationAngle increases by (2π/P)·dt only for finite |P| > 1e-6`, () => {
			const engine = new PhysicsEngine();
			const body = addTestBody(engine, { param: { ROTATION_PERIOD: c.P }, rotationAngle: 0.4 });
			engine._updatePositionAndHalfVelocity(DT);
			assert.equal(body.rotationAngle, 0.4 + c.delta);
		});
	}

	it('falls back to obj.rotationPeriod when param is absent or its ROTATION_PERIOD is null, but not when it is 0', () => {
		const engine = new PhysicsEngine();
		const noParam = addTestBody(engine, { id: 1, rotationPeriod: 1000, rotationAngle: 0 });
		const nullPeriod = addTestBody(engine, { id: 2, param: { ROTATION_PERIOD: null }, rotationPeriod: 2000, rotationAngle: 0 });
		const zeroPeriod = addTestBody(engine, { id: 3, param: { ROTATION_PERIOD: 0 }, rotationPeriod: 3000, rotationAngle: 0 });
		assert.equal(noParam.param, null, 'unknown name has no preset param');
		engine._updatePositionAndHalfVelocity(DT);
		assert.equal(noParam.rotationAngle, (TWO_PI / 1000) * DT);
		assert.equal(nullPeriod.rotationAngle, (TWO_PI / 2000) * DT);
		assert.equal(zeroPeriod.rotationAngle, 0, 'param.ROTATION_PERIOD = 0 wins over rotationPeriod (nullish fallback only)');
	});

	it('uses the preset ROTATION_PERIOD for a named body without explicit param (Earth 86164 s)', () => {
		const engine = new PhysicsEngine();
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.378e6 });
		assert.equal(earth.param.ROTATION_PERIOD, 86164);
		assert.equal(earth.rotationPeriod, 86164);
		engine._updatePositionAndHalfVelocity(DT);
		assert.equal(earth.rotationAngle, (TWO_PI / 86164) * DT);
	});

	it('recovers a NaN rotationAngle as 0 before adding the increment; dt = 0 leaves the angle unchanged', () => {
		const engine = new PhysicsEngine();
		const body = addTestBody(engine, { param: { ROTATION_PERIOD: 500 } });
		body.rotationAngle = NaN;
		engine._updatePositionAndHalfVelocity(DT);
		assert.equal(body.rotationAngle, (TWO_PI / 500) * DT);
		const before = body.rotationAngle;
		engine._updatePositionAndHalfVelocity(0);
		assert.equal(body.rotationAngle, before);
	});

	it('gives the same total rotation for 1, 7 and 40 sub-steps of _moveObjects (sub-step independence)', () => {
		const T = 120;
		const results = [1, 7, 40].map((n) => {
			const engine = new PhysicsEngine();
			const body = addTestBody(engine, { param: { ROTATION_PERIOD: 86164 }, rotationAngle: 1.0 });
			for (let i = 0; i < n; i++) { engine._moveObjects(T / n); }
			return body.rotationAngle;
		});
		for (const r of results) {
			assert.ok(Math.abs(r - (1.0 + (TWO_PI / 86164) * T)) <= 1e-14, `rotation ${r}`);
		}
	});

	it('never integrates rotationAngle for rockets / debris, nor for collided / shattered bodies', () => {
		const engine = new PhysicsEngine();
		const collided = addTestBody(engine, { id: 1, param: { ROTATION_PERIOD: 100 }, rotationAngle: 0.1 });
		const shattered = addTestBody(engine, { id: 2, x: 1e9, param: { ROTATION_PERIOD: 100 }, rotationAngle: 0.2 });
		collided.collided = true;
		shattered.shattered = true;
		const rocket = engine.addObject({ id: 3, name: 'R', type: OBJECT_TYPES.ROCKET, x: 1e8, y: 0, mass: 1, isIgnited: false });
		const debris = engine.addObject({ id: 4, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 2e8, y: 0, mass: 1, radius: 1 });
		rocket.rotationAngle = 0.3;
		debris.rotationAngle = 0.4;
		engine._updatePositionAndHalfVelocity(DT);
		assert.deepEqual([collided.rotationAngle, shattered.rotationAngle, rocket.rotationAngle, debris.rotationAngle], [0.1, 0.2, 0.3, 0.4]);
	});

	it('PhysicsEngine.addObject: finite rotationAngle is kept, non-finite / missing / non-number becomes 0', () => {
		const engine = new PhysicsEngine();
		const cases = [[1.5, 1.5], [-3, -3], [0, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0], [undefined, 0], [null, 0], ['1.5', 0]];
		cases.forEach(([input, expected], i) => {
			const b = addTestBody(engine, { id: i + 1, x: i * 1e9, rotationAngle: input, param: { ROTATION_PERIOD: 0 } });
			assert.equal(b.rotationAngle, expected, `input ${String(input)}`);
		});
	});

	it('PhysicsEngine.addObject: rotationPeriod = data.rotationPeriod ?? param.ROTATION_PERIOD ?? 0', () => {
		const engine = new PhysicsEngine();
		assert.equal(addTestBody(engine, { id: 1, rotationPeriod: 1234, param: { ROTATION_PERIOD: 99 } }).rotationPeriod, 1234);
		assert.equal(addTestBody(engine, { id: 2, param: { ROTATION_PERIOD: 99 } }).rotationPeriod, 99);
		assert.equal(addTestBody(engine, { id: 3 }).rotationPeriod, 0);
		assert.equal(addTestBody(engine, { id: 4, rotationPeriod: 0, param: { ROTATION_PERIOD: 99 } }).rotationPeriod, 0);
	});

	it('PhysicsEngine.updateObject: applies finite rotationAngle and defined rotationPeriod, ignores the rest, tolerates unknown id', () => {
		const engine = new PhysicsEngine();
		const body = addTestBody(engine, { param: { ROTATION_PERIOD: 0 }, rotationAngle: 0.7, rotationPeriod: 500 });
		const base = { id: 1, x: 5, y: 6, vx: 0, vy: 0 };
		engine.updateObject({ ...base, rotationAngle: 2.25 });
		assert.equal(body.rotationAngle, 2.25);
		for (const bad of [NaN, Infinity, -Infinity, undefined, null, '3']) {
			engine.updateObject({ ...base, rotationAngle: bad });
			assert.equal(body.rotationAngle, 2.25, `ignored rotationAngle ${String(bad)}`);
		}
		engine.updateObject({ ...base, rotationAngle: 0 });
		assert.equal(body.rotationAngle, 0, 'zero is finite and applied');
		engine.updateObject({ ...base });
		assert.equal(body.rotationPeriod, 500, 'undefined rotationPeriod keeps the old value');
		engine.updateObject({ ...base, rotationPeriod: 0 });
		assert.equal(body.rotationPeriod, 0, 'defined rotationPeriod (0) is applied');
		assert.doesNotThrow(() => engine.updateObject({ id: 999, x: 0, y: 0, rotationAngle: 1 }));
		assert.equal(body.rotationAngle, 0);
	});

	it('PredictorPhysicsEngine.step integrates the host rotation with the same formula', () => {
		const host = new CalcCelestialBody(2, 'UnitTestHost', 0, 0, 0, 0, 0, 0, 6.378e6, 0, 5.972e24);
		host.param = { ROTATION_PERIOD: -20996800 };
		host.rotationAngle = 0.9;
		const still = new CalcCelestialBody(5, 'UnitTestStill', 1e12, 0, 0, 0, 0, 0, 1e6, 0, 1e20);
		still.param = { ROTATION_PERIOD: 1e-6 };
		const rocket = new CalcRocket(3, 'UnitTestRocket', 4e7, 0, 0, 3000, 0, 0, 30, 0, 1, 0, 0, { isIgnited: false, hostId: 2 });
		const engine = new PredictorPhysicsEngine([host, still], rocket, 2, 3600);
		engine.step(DT);
		engine.step(DT);
		assert.ok(Math.abs(host.rotationAngle - (0.9 - (TWO_PI / 20996800) * 2 * DT)) <= 1e-15);
		assert.equal(still.rotationAngle, 0, '|P| <= 1e-6 does not rotate in the predictor either');
	});

	it('ObjectManager.addObject sends a finite rotationAngle (else 0) and the param for celestial bodies', () => {
		const sent = [];
		const om = new ObjectManager(null, { postMessage: (m) => sent.push(m) });
		const cases = [[0.625, 0.625], [-1.5, -1.5], [0, 0], [1e6, 1e6], [NaN, 0], [Infinity, 0], [-Infinity, 0], [undefined, 0], [null, 0], ['0.5', 0]];
		cases.forEach(([rot], i) => {
			const body = makeMainBody(i + 1, 0, 0, { param: { ROTATION_PERIOD: 86164 } });
			body.rotationAngle = rot;
			om.addObject(body);
		});
		cases.forEach(([rot, expected], i) => {
			assert.equal(sent[i].cmd, 'add');
			assert.equal(sent[i].rotationAngle, expected, `rotationAngle ${String(rot)}`);
			assert.deepEqual(sent[i].param, { ROTATION_PERIOD: 86164 });
		});
		const bare = makeMainBody(99, 0, 0);
		om.addObject(bare);
		assert.equal(sent[sent.length - 1].param, null, 'missing param is sent as null');
		EventBus.clearAll();
	});

	it('ObjectManager.updateObject sends the finite rotationAngle of a celestial body to the Worker', () => {
		const sent = [];
		const om = new ObjectManager(null, { postMessage: (m) => sent.push(m) });
		const body = makeMainBody(1, 0, 0);
		body.rotationAngle = 2.5;
		om.updateObject(body);
		assert.equal(sent[0].cmd, 'update');
		assert.equal(sent[0].rotationAngle, 2.5);
		body.rotationAngle = 0;
		om.updateObject(body);
		assert.equal(sent[1].rotationAngle, 0, 'zero is finite and sent');
		body.rotationAngle = -1e6;
		om.updateObject(body);
		assert.equal(sent[2].rotationAngle, -1e6, 'large negative finite angle is sent');
		EventBus.clearAll();
	});

	it('ObjectManager.updateObject omits rotationAngle for a non-finite celestial angle and for non-celestial objects (Rev 6.10)', () => {
		const sent = [];
		const om = new ObjectManager(null, { postMessage: (m) => sent.push(m) });
		const body = makeMainBody(1, 0, 0);
		for (const bad of [NaN, Infinity, -Infinity, undefined, null, '1.5']) {
			body.rotationAngle = bad;
			om.updateObject(body);
			const payload = sent[sent.length - 1];
			assert.equal(payload.cmd, 'update');
			assert.equal(Object.prototype.hasOwnProperty.call(payload, 'rotationAngle'), false, `omitted for ${String(bad)}`);
		}
		const rocket = makeMainRocket(2, 0, 0);
		rocket.rotationAngle = 1.25;
		om.updateObject(rocket);
		assert.equal(Object.prototype.hasOwnProperty.call(sent[sent.length - 1], 'rotationAngle'), false, 'rocket: omitted');
		const debris = new Debris(3, 'UnitDebris', 0, 0, 0, 0, 1, '#888888', 1, 2, 1, null, 0, 0);
		debris.rotationAngle = 0.5;
		om.updateObject(debris);
		assert.equal(Object.prototype.hasOwnProperty.call(sent[sent.length - 1], 'rotationAngle'), false, 'debris: omitted');
		EventBus.clearAll();
	});

	it('an omitted rotationAngle leaves the Worker angle unchanged (PhysicsEngine.updateObject keeps the old value)', () => {
		const sent = [];
		const om = new ObjectManager(null, { postMessage: (m) => sent.push(m) });
		const engine = new PhysicsEngine();
		const main = makeMainBody(1, 0, 0, { param: { ROTATION_PERIOD: 0 } });
		main.rotationAngle = 0.8;
		om.addObject(main);
		engine.addObject(sent[0]);
		main.rotationAngle = NaN;
		om.updateObject(main);
		engine.updateObject(sent[1]);
		assert.equal(engine.objects[0].rotationAngle, 0.8);
		EventBus.clearAll();
	});
});

// ===========================================================================
// A-3b: PhysicsEngine._getRotationOmega, the single spin-rate source (§3.1.1-2, Rev 6.10)
// ===========================================================================
describe('Unit 06-A3b: PhysicsEngine._getRotationOmega', () => {
	const omegaOf = (body, engine = new PhysicsEngine()) => engine._getRotationOmega(body);
	const withP = (P) => ({ name: 'UnitTestBody', param: { ROTATION_PERIOD: P } });
	const UP = nextFloat(1e-6, 1);
	const DOWN = nextFloat(1e-6, -1);

	it('normal: ω = 2π / P for positive and negative (retrograde) periods', () => {
		assert.equal(omegaOf(withP(86164)), TWO_PI / 86164);
		assert.equal(omegaOf(withP(-86164)), -TWO_PI / 86164);
		assert.equal(omegaOf(withP(1)), TWO_PI);
		assert.equal(omegaOf(withP(20996800)), TWO_PI / 20996800);
	});

	it('boundary: |P| must be strictly greater than 1e-6 (just below / at / just above, both signs, 0, extremes)', () => {
		const cases = [
			[1e-6, 0], [-1e-6, 0], [DOWN, 0], [-DOWN, 0], [UP, TWO_PI / UP], [-UP, -TWO_PI / UP],
			[0, 0], [-0, 0], [Number.MIN_VALUE, 0], [Number.MAX_VALUE, TWO_PI / Number.MAX_VALUE], [-Number.MAX_VALUE, -TWO_PI / Number.MAX_VALUE]
		];
		for (const [P, expected] of cases) {
			const w = omegaOf(withP(P));
			assert.ok(Object.is(w, expected), `P=${P}: ω=${w}, expected ${expected}`);
		}
		assert.ok(omegaOf(withP(Number.MAX_VALUE)) > 0, 'the largest finite period still rotates (no underflow to 0)');
	});

	it('abnormal: non-finite or non-number periods give ω = 0', () => {
		for (const P of [NaN, Infinity, -Infinity, '86164', '', true, false, {}, [], [86164]]) {
			assert.ok(Object.is(omegaOf(withP(P)), 0), `P=${String(P)}`);
		}
	});

	it('source order: param.ROTATION_PERIOD ?? rotationPeriod ?? preset by name (nullish fallback only)', () => {
		const cases = [
			{ label: 'param wins over rotationPeriod', body: { name: 'UnitTestBody', param: { ROTATION_PERIOD: 100 }, rotationPeriod: 200 }, exp: TWO_PI / 100 },
			{ label: 'param period null -> rotationPeriod', body: { name: 'UnitTestBody', param: { ROTATION_PERIOD: null }, rotationPeriod: 200 }, exp: TWO_PI / 200 },
			{ label: 'param without period -> rotationPeriod', body: { name: 'UnitTestBody', param: {}, rotationPeriod: 200 }, exp: TWO_PI / 200 },
			{ label: 'param null -> rotationPeriod', body: { name: 'UnitTestBody', param: null, rotationPeriod: -300 }, exp: -TWO_PI / 300 },
			{ label: 'param period 0 stops the chain', body: { name: 'Earth', param: { ROTATION_PERIOD: 0 }, rotationPeriod: 200 }, exp: 0 },
			{ label: 'param period NaN stops the chain', body: { name: 'Earth', param: { ROTATION_PERIOD: NaN }, rotationPeriod: 200 }, exp: 0 },
			{ label: 'rotationPeriod 0 stops the chain before the preset', body: { name: 'Earth', rotationPeriod: 0 }, exp: 0 },
			{ label: 'rotationPeriod 1e-6 stops the chain before the preset', body: { name: 'Earth', rotationPeriod: 1e-6 }, exp: 0 },
			{ label: 'nothing on the body -> Earth preset', body: { name: 'Earth' }, exp: TWO_PI / 86164 },
			{ label: 'rotationPeriod null -> Earth preset', body: { name: 'Earth', param: null, rotationPeriod: null }, exp: TWO_PI / 86164 },
			{ label: 'preset without a period (Sun)', body: { name: 'Sun' }, exp: 0 },
			{ label: 'unknown name, nothing set', body: { name: 'NoSuchBody' }, exp: 0 },
			{ label: 'missing name, nothing set', body: {}, exp: 0 }
		];
		for (const c of cases) {
			assert.ok(Object.is(omegaOf(c.body), c.exp), `${c.label}: ${omegaOf(c.body)} vs ${c.exp}`);
		}
	});

	it('uses the celestial parameter table sent by initDefinitions before the preset manager', () => {
		const engine = new PhysicsEngine();
		engine.setCelestialParams({ SpinWorld: { ROTATION_PERIOD: 500 }, Earth: { ROTATION_PERIOD: 1000 } });
		assert.equal(omegaOf({ name: 'SpinWorld' }, engine), TWO_PI / 500);
		assert.equal(omegaOf({ name: 'Earth' }, engine), TWO_PI / 1000, 'table entry overrides the bundled preset');
		assert.equal(omegaOf({ name: 'Mars' }, engine), TWO_PI / 88642, 'names missing from the table fall back to the preset');
	});

	it('is the rate used by the rotation integration for every source', () => {
		const engine = new PhysicsEngine();
		const bodies = [
			addTestBody(engine, { id: 1, param: { ROTATION_PERIOD: 700 } }),
			addTestBody(engine, { id: 2, x: 1e9, rotationPeriod: -900 }),
			addTestBody(engine, { id: 3, x: 2e9, param: { ROTATION_PERIOD: UP } }),
			addTestBody(engine, { id: 4, x: 3e9, param: { ROTATION_PERIOD: '700' } })
		];
		const rates = bodies.map((b) => engine._getRotationOmega(b));
		assert.deepEqual(rates, [TWO_PI / 700, -TWO_PI / 900, TWO_PI / UP, 0]);
		engine._updatePositionAndHalfVelocity(1e-3);
		bodies.forEach((b, i) => assert.equal(b.rotationAngle, rates[i] === 0 ? 0 : rates[i] * 1e-3, `body ${b.id}`));
	});
});

// ===========================================================================
// A-4: hold-down synchronization (§3.1.1-2)
// ===========================================================================
describe('Unit 06-A4: hold-down position / velocity synchronization', () => {
	const R_HOST = 6.378e6;

	for (const kind of ['physics', 'predictor']) {
		it(`[${kind}] after one step: position = host + r(cosθ, sinθ), velocity = host.v(t+dt) + ω×r, θ = θ0 + ω·dt`, () => {
			const P = 86164;
			const omega = TWO_PI / P;
			const w = buildHoldDownWorld({ period: P, EngineClass: kind });
			const vyBefore = w.host.vy;
			w.step(60);
			assert.ok(w.host.vy !== vyBefore || w.host.vx !== 0, 'the perturbing body changes the host velocity during the step');
			assert.ok(Math.abs(w.rocket.hostAngleRad - (0.5 + omega * 60)) <= 1e-15);
			assertHeldOnHost(w.rocket, w.host, omega, R_HOST + 30 + 10, kind);
		});

		it(`[${kind}] _moveObjects calls the hold-down sync right after the position half-step and right after the final velocity`, () => {
			// §3.1.1-2: _updateHoldDownPositions(dt) directly after _updatePositionAndHalfVelocity(dt), and the final
			// re-sync _updateHoldDownPositions(0) directly after _updateFinalVelocity(dt); flight control runs in between.
			const w = buildHoldDownWorld({ EngineClass: kind });
			const calls = [];
			for (const m of ['_updatePositionAndHalfVelocity', '_updateHoldDownPositions', '_updateFlightControl', '_updateFinalVelocity']) {
				const orig = w.engine[m];
				w.engine[m] = function (...args) { calls.push(`${m}(${args[0]})`); return orig.apply(this, args); };
			}
			w.step(60);
			assert.deepEqual(calls, [
				'_updatePositionAndHalfVelocity(60)', '_updateHoldDownPositions(60)', '_updateFlightControl(60)',
				'_updateFinalVelocity(60)', '_updateHoldDownPositions(0)'
			]);
		});

		it(`[${kind}] the held rocket's flight control already sees the synchronized pad: host at its half-step position, θ = θ0 + ω·dt`, () => {
			const P = 86164;
			const omega = TWO_PI / P;
			const dt = 60;
			const r = R_HOST + 30 + 10;
			const w = buildHoldDownWorld({ period: P, EngineClass: kind });
			const h0 = { x: w.host.x, y: w.host.y, vx: w.host.vx, vy: w.host.vy, ax: w.host.ax, ay: w.host.ay };
			const seen = [];
			const flightControl = w.rocket.flightControl;
			w.rocket.flightControl = function (...args) {
				seen.push({ x: this.x, y: this.y, vx: this.vx, vy: this.vy, th: this.hostAngleRad, hx: w.host.x, hy: w.host.y, hvx: w.host.vx, hvy: w.host.vy, rot: w.host.rotationAngle });
				return flightControl.apply(this, args);
			};
			w.step(dt);
			assert.equal(seen.length, 1, 'flight control runs once per step');
			const s = seen[0];
			const th = 0.5 + omega * dt;
			// Velocity Verlet: the host has moved by (v + a·dt/2)·dt and still carries v(t) when flight control runs
			assert.ok(Math.abs(s.hx - (h0.x + (h0.vx + h0.ax * dt / 2) * dt)) <= 1e-6, `${kind}: host x advanced before flight control`);
			assert.ok(Math.abs(s.hy - (h0.y + (h0.vy + h0.ay * dt / 2) * dt)) <= 1e-6, `${kind}: host y advanced before flight control`);
			assert.deepEqual([s.hvx, s.hvy], [h0.vx, h0.vy], `${kind}: host velocity not yet integrated`);
			assert.ok(Math.abs(s.th - th) <= 1e-15, `${kind}: pad angle θ0 + ω·dt`);
			assert.ok(Math.abs((s.rot - 0.3) - omega * dt) <= 1e-15, `${kind}: body rotated in the same half-step`);
			assert.ok(Math.abs((s.x - s.hx) - r * Math.cos(th)) <= 1e-6, `${kind}: x = host.x + r cosθ`);
			assert.ok(Math.abs((s.y - s.hy) - r * Math.sin(th)) <= 1e-6, `${kind}: y = host.y + r sinθ`);
			assert.ok(Math.abs(s.vx - (h0.vx - omega * r * Math.sin(th))) <= 1e-9, `${kind}: vx = host.vx - ω·dy`);
			assert.ok(Math.abs(s.vy - (h0.vy + omega * r * Math.cos(th))) <= 1e-9, `${kind}: vy = host.vy + ω·dx`);
		});

		it(`[${kind}] gives the same pad angle for 1, 2, 7 and 40 sub-steps (no sub-step phase lag)`, () => {
			const P = 86164;
			const omega = TWO_PI / P;
			for (const n of [1, 2, 7, 40]) {
				const w = buildHoldDownWorld({ period: P, EngineClass: kind });
				for (let i = 0; i < n; i++) { w.step(60 / n); }
				assert.ok(Math.abs(w.rocket.hostAngleRad - (0.5 + omega * 60)) <= 1e-14, `n=${n}`);
				assert.ok(Math.abs((w.rocket.hostAngleRad - w.host.rotationAngle) - (0.5 - 0.3)) <= 1e-14, `n=${n}: pad fixed to the rotating surface`);
				assertHeldOnHost(w.rocket, w.host, omega, R_HOST + 30 + 10, `${kind} n=${n}`);
			}
		});
	}

	it('keeps the pad fixed to the host surface for positive, negative, zero and NaN rotation periods', () => {
		for (const P of [86164, -86164, 0, NaN]) {
			const w = buildHoldDownWorld({ period: P });
			for (let i = 0; i < 10; i++) { w.step(30); }
			const omega = (Number.isFinite(P) && P !== 0) ? TWO_PI / P : 0;
			assert.ok(Math.abs((w.rocket.hostAngleRad - w.host.rotationAngle) - 0.2) <= 1e-13, `P=${P}`);
			assertHeldOnHost(w.rocket, w.host, omega, R_HOST + 40, `P=${P}`);
		}
	});

	it('does not move a held rocket radially even when thrust exceeds weight (and with zero thrust)', () => {
		for (const thrust of [5e6, 0]) {
			const w = buildHoldDownWorld({ thrustForce: thrust, withPerturber: false });
			for (let i = 0; i < 20; i++) {
				w.step(1);
				const dist = Math.hypot(w.rocket.x - w.host.x, w.rocket.y - w.host.y);
				assert.ok(Math.abs(dist - (R_HOST + 40)) <= 1e-6, `thrust ${thrust}, step ${i}: dist ${dist}`);
			}
		}
	});

	it('boundary: dt = 0 keeps θ and re-syncs; hostAltM = 0 uses r = R + bottomOffset; missing bottomOffsetM falls back to radius', () => {
		const w = buildHoldDownWorld({ hostAltM: 0 });
		w.step(0);
		assert.equal(w.rocket.hostAngleRad, 0.5);
		assertHeldOnHost(w.rocket, w.host, TWO_PI / 86164, R_HOST + 30, 'dt=0');
		w.rocket.bottomOffsetM = undefined;
		w.rocket.radius = 12;
		w.engine._updateHoldDownPositions(0);
		assert.equal(w.rocket.distToDominantM, R_HOST + 12);
	});

	// Design §4.14-7 (a regression of this branch, fixed): without a host there is no pad, so the held rocket is integrated
	// as on main. This test asserted the frozen rocket before (position and velocity untouched)
	it('abnormal: hold-down with a missing host or hostId null: no pad, the rocket is integrated (no body: it moves by v t, keeps v) and its pad angle is untouched', () => {
		for (const hostId of [999, null]) {
			const engine = new PhysicsEngine();
			const rocket = engine.addObject({ id: 3, name: 'UnitTestRocket', type: OBJECT_TYPES.ROCKET, x: 7e6, y: 1e5, mass: 20, isHoldDown: true, isIgnited: false, hostId, hostAngleRad: 0.5, bottomOffsetM: 30 });
			rocket.vx = 12;
			rocket.vy = -3;
			assert.doesNotThrow(() => { engine._moveObjects(10); engine._moveObjects(10); });
			assert.equal(rocket.x, 7e6 + 12 * 20, 'x moves by vx t');
			assert.equal(rocket.y, 1e5 - 3 * 20, 'y moves by vy t');
			assert.equal(rocket.vx, 12, 'no force: the velocity stays');
			assert.equal(rocket.vy, -3);
			assert.equal(rocket.hostAngleRad, 0.5);
		}
	});

	it('_updateFinalVelocity skips held rockets on their host; released rockets, held rockets without a host (§4.14-7) and held-flagged non-rockets are integrated (Rev 6.10)', () => {
		const engine = new PhysicsEngine();
		// The host the held rocket is pinned to (it was missing here before, which §4.14-7 now integrates: see below)
		engine.addObject({ id: 999, name: 'UnitHost', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 1e18, radius: 6e6 });
		const held = engine.addObject({ id: 3, name: 'R', type: OBJECT_TYPES.ROCKET, x: 7e6, y: 0, mass: 20, isHoldDown: true, isIgnited: false, hostId: 999 });
		const free = engine.addObject({ id: 4, name: 'R2', type: OBJECT_TYPES.ROCKET, x: 8e6, y: 0, mass: 20, isHoldDown: false, isIgnited: false });
		const debris = engine.addObject({ id: 5, name: 'D', type: OBJECT_TYPES.DEBRIS, x: 9e6, y: 0, mass: 1, radius: 1 });
		debris.isHoldDown = true;
		for (const o of [held, free, debris]) {
			Object.assign(o, { vx: 5, vy: -2, _half_vx: 7, _half_vy: 9, ax: 3, ay: 4 });
		}
		engine._updateFinalVelocity(2);
		assert.deepEqual([held.vx, held.vy], [5, -2], 'held rocket: velocity untouched');
		assert.deepEqual([free.vx, free.vy], [7 + 3, 9 + 4], 'free rocket: v = v_half + a·dt/2');
		assert.deepEqual([debris.vx, debris.vy], [10, 13], 'only rockets are pinned by the hold-down flag');
		held.isHoldDown = false;
		engine._updateFinalVelocity(2);
		assert.deepEqual([held.vx, held.vy], [10, 13], 'after release the same call integrates it');
		held.isHoldDown = true;
		held.vx = 1;
		engine._updateFinalVelocity(0);
		assert.equal(held.vx, 1, 'dt = 0 boundary: still untouched');
		held.hostId = 12345;
		Object.assign(held, { _half_vx: 7, _half_vy: 9, ax: 3, ay: 4 });
		engine._updateFinalVelocity(2);
		assert.deepEqual([held.vx, held.vy], [10, 13], 'held, but its host is gone: integrated');
	});

	describe('the pad stays on the rotating surface for every spin source (R3, Rev 6.10)', () => {
		const UP = nextFloat(1e-6, 1);
		const DOWN = nextFloat(1e-6, -1);
		const spinCases = [
			{ label: 'period only in rotationPeriod', spin: { param: undefined, rotationPeriod: 1000 }, omega: TWO_PI / 1000 },
			{ label: 'negative period only in rotationPeriod', spin: { param: undefined, rotationPeriod: -1000 }, omega: -TWO_PI / 1000 },
			{ label: 'param period null, rotationPeriod set', spin: { param: { ROTATION_PERIOD: null }, rotationPeriod: 2000 }, omega: TWO_PI / 2000 },
			{ label: 'param period exactly 1e-6', spin: { param: { ROTATION_PERIOD: 1e-6 } }, omega: 0 },
			{ label: 'param period -1e-6', spin: { param: { ROTATION_PERIOD: -1e-6 } }, omega: 0 },
			{ label: 'param period just below 1e-6', spin: { param: { ROTATION_PERIOD: DOWN } }, omega: 0 },
			{ label: 'rotationPeriod exactly 1e-6', spin: { param: undefined, rotationPeriod: 1e-6 }, omega: 0 },
			{ label: 'numeric-string period', spin: { param: { ROTATION_PERIOD: '86164' } }, omega: 0 },
			{ label: 'empty-string period', spin: { param: { ROTATION_PERIOD: '' } }, omega: 0 },
			{ label: 'NaN rotationPeriod', spin: { param: undefined, rotationPeriod: NaN }, omega: 0 },
			{ label: 'Infinity rotationPeriod', spin: { param: undefined, rotationPeriod: Infinity }, omega: 0 }
		];
		for (const kind of ['physics', 'predictor']) {
			for (const c of spinCases) {
				it(`[${kind}] ${c.label}: body and pad share ω = ${c.omega}`, () => {
					const w = buildHoldDownWorld({ hostSpin: c.spin, EngineClass: kind });
					assert.ok(Object.is(w.engine._getRotationOmega(w.host), c.omega), 'precondition: spin-rate source');
					for (let i = 0; i < 10; i++) { w.step(30); }
					assert.ok(Math.abs((w.host.rotationAngle - 0.3) - c.omega * 300) <= 1e-12, 'body rotation');
					assert.ok(Math.abs((w.rocket.hostAngleRad - 0.5) - c.omega * 300) <= 1e-12, 'pad rotation');
					assert.ok(Math.abs((w.rocket.hostAngleRad - w.host.rotationAngle) - 0.2) <= 1e-12, 'no pad-vs-surface drift');
					assertHeldOnHost(w.rocket, w.host, c.omega, R_HOST + 40, `${kind} ${c.label}`);
				});
			}

			it(`[${kind}] period just above 1e-6 (fast spin): body and pad advance together`, () => {
				const w = buildHoldDownWorld({ hostSpin: { param: { ROTATION_PERIOD: UP } }, EngineClass: kind, withPerturber: false });
				const omega = TWO_PI / UP;
				const dt = 1e-7;
				for (let i = 0; i < 10; i++) { w.step(dt); }
				assert.ok(Math.abs((w.host.rotationAngle - 0.3) - omega * dt * 10) <= 1e-12);
				assert.ok(Math.abs((w.rocket.hostAngleRad - 0.5) - omega * dt * 10) <= 1e-12);
				assert.ok(Math.abs((w.rocket.hostAngleRad - w.host.rotationAngle) - 0.2) <= 1e-12, 'no pad-vs-surface drift');
				const r = R_HOST + 40;
				assert.ok(Math.abs((w.rocket.x - w.host.x) - r * Math.cos(w.rocket.hostAngleRad)) <= 1e-6);
				assert.ok(Math.abs((w.rocket.vy - w.host.vy) - omega * r * Math.cos(w.rocket.hostAngleRad)) <= Math.abs(omega * r) * 1e-12);
			});
		}

		it('preset fallback by name (no param, no rotationPeriod on the body) drives both the body and the pad', () => {
			const engine = new PhysicsEngine();
			const host = engine.addObject({ id: 2, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 5.972e24, radius: 6.378e6, rotationAngle: 0.3 });
			host.param = null;
			host.rotationPeriod = undefined;
			const rocket = engine.addObject({ id: 3, name: 'UnitTestRocket', type: OBJECT_TYPES.ROCKET, x: 6.378e6 + 30, y: 0, mass: 20, isHoldDown: true, isIgnited: false, hostId: 2, hostAngleRad: 0.5, hostAltM: 10, bottomOffsetM: 30 });
			for (let i = 0; i < 10; i++) { engine._moveObjects(30); }
			const omega = TWO_PI / 86164;
			assert.ok(Math.abs((host.rotationAngle - 0.3) - omega * 300) <= 1e-12);
			assert.ok(Math.abs((rocket.hostAngleRad - host.rotationAngle) - 0.2) <= 1e-12);
			assertHeldOnHost(rocket, host, omega, R_HOST + 40, 'preset fallback');
		});

		it('a rotationPeriod changed through updateObject switches the body and the pad together', () => {
			const w = buildHoldDownWorld({ hostSpin: { param: undefined, rotationPeriod: 1000 }, withPerturber: false });
			for (let i = 0; i < 5; i++) { w.step(10); }
			w.engine.updateObject({ id: 2, x: w.host.x, y: w.host.y, vx: w.host.vx, vy: w.host.vy, ax: w.host.ax, ay: w.host.ay, rotationPeriod: 250 });
			for (let i = 0; i < 5; i++) { w.step(10); }
			const expected = (TWO_PI / 1000) * 50 + (TWO_PI / 250) * 50;
			assert.ok(Math.abs((w.host.rotationAngle - 0.3) - expected) <= 1e-12);
			assert.ok(Math.abs((w.rocket.hostAngleRad - 0.5) - expected) <= 1e-12);
			assertHeldOnHost(w.rocket, w.host, TWO_PI / 250, R_HOST + 40, 'after the period change');
		});
	});

	it('_updatePositionAndHalfVelocity skips held rockets (no free propagation of x or half-velocity)', () => {
		const w = buildHoldDownWorld();
		w.step(1);
		const snap = { x: w.rocket.x, y: w.rocket.y, hvx: w.rocket._half_vx, hvy: w.rocket._half_vy };
		w.rocket.ax = 50;
		w.rocket.ay = -50;
		w.engine._updatePositionAndHalfVelocity(10);
		assert.deepEqual({ x: w.rocket.x, y: w.rocket.y, hvx: w.rocket._half_vx, hvy: w.rocket._half_vy }, snap);
	});

	it('after release the next step is the normal velocity-Verlet update and the pad angle stops advancing', () => {
		const w = buildHoldDownWorld({ withPerturber: false });
		w.step(1);
		w.rocket.handleCommand('RELEASE_HOLD_DOWN');
		assert.equal(w.rocket.isHoldDown, false);
		const s0 = { x: w.rocket.x, y: w.rocket.y, vx: w.rocket.vx, vy: w.rocket.vy, ax: w.rocket.ax, ay: w.rocket.ay, th: w.rocket.hostAngleRad };
		const dt = 0.5;
		w.step(dt);
		const hvx = s0.vx + s0.ax * dt / 2;
		const hvy = s0.vy + s0.ay * dt / 2;
		assert.equal(w.rocket.x, s0.x + hvx * dt);
		assert.equal(w.rocket.y, s0.y + hvy * dt);
		assert.equal(w.rocket.vx, hvx + w.rocket.ax * dt / 2);
		assert.equal(w.rocket.vy, hvy + w.rocket.ay * dt / 2);
		assert.equal(w.rocket.hostAngleRad, s0.th);
		for (let i = 0; i < 20; i++) { w.step(0.5); }
		const dist = Math.hypot(w.rocket.x - w.host.x, w.rocket.y - w.host.y);
		assert.ok(dist > R_HOST + 40 + 1, `released rocket climbs under thrust (dist ${dist})`);
	});
});

// ===========================================================================
// A-5: ObjectManager.updateObjectParams two-pass commit (§3.1.1-3)
// ===========================================================================
describe('Unit 06-A5: ObjectManager.updateObjectParams two-pass atomic commit', () => {
	let sent;
	let om;
	let origDebug;

	beforeEach(() => {
		EventBus.clearAll();
		WorkerBridge._bufferPool.length = 0;
		sent = [];
		om = new ObjectManager(null, { postMessage: (m, transfer) => sent.push({ m, transfer }) });
		origDebug = console.debug;
		console.debug = () => {};
	});
	afterEach(() => {
		console.debug = origDebug;
		EventBus.clearAll();
	});

	const frame = (workerObjs) => {
		const buf = WorkerBridge.formatWorkerToMain(workerObjs);
		return { objectsData: buf.buffer, validLength: buf.length };
	};

	const setupFour = () => {
		const A = makeMainBody(1, 0, 0);
		const B = makeMainRocket(2, 0, 0);
		const C = new Debris(3, 'UnitDebris', 0, 0, 0, 0, 1, '#888888', 1, 2, 1, null, 0, 0);
		const D = makeMainBody(4, 0, 0);
		for (const o of [A, B, C, D]) { om.addObject(o, false); }
		const log = [];
		for (const o of [A, B, C, D]) {
			for (const method of ['updateHistory', 'setCollided']) {
				const orig = o[method].bind(o);
				o[method] = (...args) => { log.push(`${o.id}:${method}`); return orig(...args); };
			}
		}
		EventBus.on('object:impacted', (t) => log.push(`impacted:${t.id}`));
		EventBus.on('object:shattered', (t) => log.push(`shattered:${t.id}`));
		return { A, B, C, D, log };
	};

	it('runs every history update (Pass 2A) before any destruction (Pass 2B), whatever the buffer order', () => {
		const { log } = setupFour();
		om.updateObjectParams(frame([
			workerBody({ id: 1, x: 1e9, rotationAngle: 0.5 }),
			workerRocket({ id: 2, collided: true, isImpact: true, impactVx: 111, impactVy: -222 }),
			workerDebris({ id: 3, x: 3e9 }),
			workerBody({ id: 4, x: 4e9, shattered: true })
		]));
		assert.deepEqual(log, ['1:updateHistory', '3:updateHistory', 'impacted:2', '2:setCollided', '4:setCollided', 'shattered:4']);
		assert.deepEqual(sent.map((s) => s.m.cmd), ['returnBuffer', 'remove']);
		assert.equal(sent[1].m.id, 4, 'shattered target removed from the Worker');
	});

	it('Pass 1 commits every object before Pass 2A: an earlier record sees later records already updated (same epoch)', () => {
		const { A, C } = setupFour();
		let seenByA = null;
		const prev = A.updateHistory;
		A.updateHistory = (...args) => { seenByA = { cx: C.x, cy: C.y }; return prev(...args); };
		om.updateObjectParams(frame([workerBody({ id: 1, x: 1e9 }), workerDebris({ id: 3, x: 7.5e10, y: -3e10 })]));
		assert.deepEqual(seenByA, { cx: UnitConvertUtils.m2pix(7.5e10), cy: UnitConvertUtils.m2pix(-3e10) });
	});

	it('copies destruction data instead of keeping the shared WorkerBridge._cache reference', () => {
		setupFour();
		let captured = null;
		EventBus.on('object:impacted', (t, d) => { captured = d; });
		om.updateObjectParams(frame([
			workerRocket({ id: 2, collided: true, isImpact: true, debrisMass: 333, impactVx: 111, impactVy: -222, impactWinnerX: 5, impactWinnerY: 6, impactWinnerRadius: 7 }),
			workerDebris({ id: 3 })
		]));
		assert.notEqual(captured, WorkerBridge._cache);
		// debrisMass included: DestructionManager splits it into the fragments (design §4.13-23)
		assert.deepEqual(captured, { isCollided: true, isImpact: true, isShattered: false, debrisMass: 333, impactVx: 111, impactVy: -222, impactWinnerX: 5, impactWinnerY: 6, impactWinnerRadius: 7 });
		assert.equal(WorkerBridge._cache.id, 3, 'the shared cache was overwritten by the later record');
	});

	it('destroyed targets get no history update; a rocket hit clears its paths; inactive targets emit no events', () => {
		const { B, D, log } = setupFour();
		B.actualFlightPath = [{ relX: 1, relY: 1, r: 1, phiSurf: 0, time: 0 }];
		B.predictedTrajectory = { points: [] };
		om.updateObjectParams(frame([workerRocket({ id: 2, collided: true, isImpact: true })]));
		assert.equal(B.state, OBJECT_STATE.REMOVED);
		assert.equal(B.actualFlightPath, null);
		assert.equal(B.predictedTrajectory, null);
		assert.equal(B.trajectory.count, 0);
		log.length = 0;
		D.state = OBJECT_STATE.REMOVED;
		om.updateObjectParams(frame([workerRocket({ id: 2, collided: true, isImpact: true }), workerBody({ id: 4, shattered: true })]));
		// A removed target takes no frame at all (design §4.13-31; before, its setCollided ran once more, without effect)
		assert.deepEqual(log, [], 'already removed: no setCollided, impacted, shattered or remove');
		assert.equal(sent.filter((s) => s.m.cmd === 'remove').length, 0);
	});

	it('creates new objects only for unknown DEBRIS ids that are neither collided nor shattered', () => {
		const before = om.objects.length;
		om.updateObjectParams(frame([
			workerDebris({ id: 99, x: 1e10, y: 2e10, debrisSubType: 3, mass: 2.5, radius: 4 }),
			workerDebris({ id: 96, collided: true }),
			workerDebris({ id: 95, shattered: true }),
			workerRocket({ id: 98 }),
			workerBody({ id: 97 })
		]));
		assert.equal(om.objects.length, before + 1);
		const deb = om.objects.find((o) => o.id === 99);
		assert.ok(deb instanceof Debris);
		assert.equal(deb.name, MULTISTAGE_ROCKET.DEBRIS_SPECS[3].name);
		assert.equal(deb.debrisSubType, 3);
		assert.equal(deb.x, UnitConvertUtils.m2pix(1e10));
		assert.equal(deb.y, UnitConvertUtils.m2pix(2e10));
		assert.equal(deb.mass, 2.5);
		assert.equal(deb.trajectory.count, 1, 'new debris history recorded in Pass 2A');
		assert.equal(sent.filter((s) => s.m.cmd === 'add').length, 0, 'worker-spawned debris is not re-sent to the Worker');
		assert.ok(!om.objects.some((o) => [95, 96, 97, 98].includes(o.id)));
		om.updateObjectParams(frame([workerDebris({ id: 94, debrisSubType: 0 })]));
		assert.equal(om.objects.find((o) => o.id === 94).name, 'Jettisoned Debris', 'unknown sub type uses the generic spec');
	});

	it('main-thread debris keeps rotationAngle 0 when its record follows a celestial record (existing and Worker-spawned debris)', () => {
		const A = makeMainBody(1, 0, 0);
		const C = new Debris(3, 'UnitDebris', 0, 0, 0, 0, 1, '#888888', 1, 2, 1, null, 0, 0);
		om.addObject(A, false);
		om.addObject(C, false);
		assert.equal(C.rotationAngle, 0, 'precondition');
		om.updateObjectParams(frame([workerBody({ id: 1, rotationAngle: 1.2 }), workerDebris({ id: 3 })]));
		assert.equal(A.rotationAngle, 1.2);
		assert.equal(C.rotationAngle, 0, 'existing debris');
		om.updateObjectParams(frame([workerBody({ id: 1, rotationAngle: 0.9 }), workerDebris({ id: 77 }), workerDebris({ id: 3 })]));
		assert.equal(A.rotationAngle, 0.9);
		assert.equal(om.objects.find((o) => o.id === 77).rotationAngle, 0, 'debris created by Pass 1');
		assert.equal(C.rotationAngle, 0, 'existing debris after a spawned one');
	});

	it('passes one physicsSequence per call and universe.isPaused to every updateHistory, and returns the buffer', () => {
		const { A, C } = setupFour();
		const seen = [];
		for (const o of [A, C]) {
			const prev = o.updateHistory;
			o.updateHistory = (seq, objs, paused) => { seen.push({ id: o.id, seq, objsIsList: objs === om.objects, paused }); return prev(seq, objs, paused); };
		}
		om.universe = { isPaused: true };
		const data = frame([workerBody({ id: 1 }), workerDebris({ id: 3 })]);
		om.updateObjectParams(data);
		const seq1 = om.physicsSequence;
		assert.deepEqual(seen, [{ id: 1, seq: seq1, objsIsList: true, paused: true }, { id: 3, seq: seq1, objsIsList: true, paused: true }]);
		assert.equal(sent[0].m.cmd, 'returnBuffer');
		assert.equal(sent[0].m.buffer, data.objectsData);
		assert.deepEqual(sent[0].transfer, [data.objectsData]);
		om.universe = null;
		om.updateObjectParams(frame([workerBody({ id: 1 })]));
		assert.deepEqual(seen[2], { id: 1, seq: seq1 + 1, objsIsList: true, paused: false }, 'next frame, next sequence');
	});

	it('tolerates null / undefined / empty input and empty buffers; handles many objects in one frame', () => {
		const probe = makeMainBody(77, 0.5, 0.5);
		om.addObject(probe, false);
		for (const bad of [null, undefined, {}, { objectsData: null }]) {
			assert.doesNotThrow(() => om.updateObjectParams(bad));
		}
		assert.deepEqual(sent, [], 'nothing to return to the Worker');
		assert.equal(probe.x, 0.5);
		assert.equal(probe.trajectory.count, 0, 'no history recorded without data');
		om.updateObjectParams(frame([]));
		assert.equal(sent.length, 1, 'empty buffer is still returned');
		const bodies = [];
		for (let i = 0; i < 50; i++) {
			const b = makeMainBody(i + 1, 0, 0);
			om.addObject(b, false);
			bodies.push(b);
		}
		om.updateObjectParams(frame(bodies.map((b, i) => workerBody({ id: b.id, x: i * 1e9, rotationAngle: i * 0.1 }))));
		bodies.forEach((b, i) => {
			assert.equal(b.x, UnitConvertUtils.m2pix(i * 1e9));
			assert.equal(b.rotationAngle, i * 0.1);
			assert.equal(b.trajectory.count, 1);
		});
	});
});

// ===========================================================================
// A-6: _applyBaseState / _applyRocketState guards (§3.1.1-3, §3.5-1)
// ===========================================================================
describe('Unit 06-A6: _applyBaseState / _applyRocketState guards', () => {
	let om;
	beforeEach(() => {
		EventBus.clearAll();
		WorkerBridge._bufferPool.length = 0;
		om = new ObjectManager(null, { postMessage: () => {} });
	});
	afterEach(() => EventBus.clearAll());

	const rocketData = (over = {}) => ({ ...roundTrip(workerRocket({ id: 7, stageState: 'STG_BURNING', mach: 0.5, stgTimer: 1.5, rcsCw: true })), ...over });

	it('rotationAngle: finite values (including 0 and negative) are applied, everything else keeps the current angle', () => {
		const body = makeMainBody(1, 0, 0);
		om.addObject(body, false);
		const base = roundTrip(workerBody({ id: 1 }));
		for (const v of [1.5, 0, -2.75]) {
			om.updateObjectParams({ ...base, rotationAngle: v });
			assert.equal(body.rotationAngle, v);
		}
		for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5', {}]) {
			om.updateObjectParams({ ...base, rotationAngle: bad });
			assert.equal(body.rotationAngle, -2.75, `kept for ${String(bad)}`);
		}
	});

	it('mach and stgTimer: only finite numbers overwrite; telemetry.mach mirrors the kept value', () => {
		const r = makeMainRocket(7, 0, 0);
		om.addObject(r, false);
		om.updateObjectParams(rocketData({ mach: 1.25, stgTimer: 2.5 }));
		assert.equal(r.mach, 1.25);
		assert.equal(r.telemetry.mach, 1.25);
		assert.equal(r.stgTimer, 2.5);
		for (const bad of [NaN, Infinity, -Infinity, undefined, null, '3']) {
			om.updateObjectParams(rocketData({ mach: bad, stgTimer: bad }));
			assert.equal(r.mach, 1.25, `mach kept for ${String(bad)}`);
			assert.equal(r.telemetry.mach, 1.25, `telemetry.mach kept for ${String(bad)}`);
			assert.equal(r.stgTimer, 2.5, `stgTimer kept for ${String(bad)}`);
		}
		om.updateObjectParams(rocketData({ mach: 0, stgTimer: 0 }));
		assert.equal(r.mach, 0, 'zero mach is applied (boundary)');
		assert.equal(r.telemetry.mach, 0);
		assert.equal(r.stgTimer, 0);
	});

	it('stageState / RCS / hasPayloadPropulsion: missing (undefined) keeps the value, defined values are applied as Boolean', () => {
		const r = makeMainRocket(7, 0, 0);
		om.addObject(r, false);
		om.updateObjectParams(rocketData({ stageState: 'INTERSTAGE_COAST', rcsCw: true, rcsCcw: false, rcsUllage: true, hasPayloadPropulsion: true }));
		assert.deepEqual([r.stageState, r.rcsCw, r.rcsCcw, r.rcsUllage, r.hasPayloadPropulsion], ['INTERSTAGE_COAST', true, false, true, true]);
		assert.deepEqual([r.telemetry.rcsCw, r.telemetry.rcsCcw, r.telemetry.rcsUllage], [true, false, true]);
		om.updateObjectParams(rocketData({ stageState: undefined, rcsCw: undefined, rcsCcw: undefined, rcsUllage: undefined, hasPayloadPropulsion: undefined }));
		assert.deepEqual([r.stageState, r.rcsCw, r.rcsCcw, r.rcsUllage, r.hasPayloadPropulsion], ['INTERSTAGE_COAST', true, false, true, true]);
		assert.deepEqual([r.telemetry.rcsCw, r.telemetry.rcsCcw, r.telemetry.rcsUllage], [true, false, true]);
		om.updateObjectParams(rocketData({ stageState: 'ORBITAL_COAST', rcsCw: 0, rcsCcw: 1, rcsUllage: '', hasPayloadPropulsion: 0 }));
		assert.deepEqual([r.stageState, r.rcsCw, r.rcsCcw, r.rcsUllage, r.hasPayloadPropulsion], ['ORBITAL_COAST', false, true, false, false]);
	});

	it('a celestial record never runs the rocket guards (rocket-only fields on a body are ignored)', () => {
		const body = makeMainBody(1, 0, 0);
		om.addObject(body, false);
		om.updateObjectParams({ ...roundTrip(workerBody({ id: 1, rotationAngle: 0.25 })), mach: 3, stageState: 'STG_MECO', rcsCw: true, stgTimer: 9 });
		assert.equal(body.rotationAngle, 0.25);
		assert.equal(body.mach, undefined);
		assert.equal(body.stageState, undefined);
		assert.equal(body.rcsCw, undefined);
		assert.equal(body.stgTimer, undefined);
	});
});

// ===========================================================================
// A-7: Rocket._recordActualFlightPath (§3.1.1-4, §4.10 actual flight path)
// ===========================================================================
describe('Unit 06-A7: Rocket._recordActualFlightPath', () => {
	const m2p = UnitConvertUtils.m2pix;
	const R0 = m2p(6.4e6);

	const recordAt = (rocket, host, x, y, rot, time) => {
		rocket.x = x;
		rocket.y = y;
		host.rotationAngle = rot;
		if (time !== undefined) { rocket.telemetry.flightTime = time; }
		rocket._recordActualFlightPath([host, rocket]);
		return rocket.actualFlightPath;
	};

	it('records the first point with world / host-relative / surface coordinates and the flight time', () => {
		const host = makeMainBody(1, 0.5, -0.25);
		const rocket = makeMainRocket(2, 0, 0, { hostId: 1 });
		const path = recordAt(rocket, host, 0.5 + R0, -0.25 + R0, 0.3, 12.5);
		assert.equal(path.length, 1);
		const p = path[0];
		const relX = (0.5 + R0) - 0.5;
		const relY = (-0.25 + R0) - (-0.25);
		assert.deepEqual(p, { worldX: 0.5 + R0, worldY: -0.25 + R0, relX, relY, r: Math.hypot(relX, relY), phiSurf: Math.atan2(relY, relX) - 0.3, time: 12.5 });
	});

	it('time source precedence: telemetry.flightTime, else rocket.flightTime, else 0', () => {
		const host = makeMainBody(1, 0, 0);
		const a = makeMainRocket(2, 0, 0, { hostId: 1, flightTime: 7 });
		a.telemetry.flightTime = undefined;
		assert.equal(recordAt(a, host, R0, 0, 0)[0].time, 7);
		const b = makeMainRocket(3, 0, 0, { hostId: 1, flightTime: undefined });
		b.telemetry = undefined;
		assert.equal(recordAt(b, host, R0, 0, 0)[0].time, 0);
		const c = makeMainRocket(4, 0, 0, { hostId: 1, flightTime: 7 });
		assert.equal(recordAt(c, host, R0, 0, 0, 3.5)[0].time, 3.5, 'telemetry (Worker) flight time wins');
	});

	it('host-fixed rule (no frame switch): a surface-stationary craft is not re-recorded, radial motion of >= 5 m is', () => {
		const host = makeMainBody(1, 0, 0);
		const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: { frameSwitchTime: null } });
		recordAt(rocket, host, R0 * Math.cos(0.7), R0 * Math.sin(0.7), 0.2, 1);
		const delta = 0.05;
		recordAt(rocket, host, R0 * Math.cos(0.7 + delta), R0 * Math.sin(0.7 + delta), 0.2 + delta, 2);
		assert.equal(rocket.actualFlightPath.length, 1, 'co-rotating with the surface: no host-fixed displacement');
		const R1 = m2p(6.4e6 + 6);
		recordAt(rocket, host, R1 * Math.cos(0.7 + delta), R1 * Math.sin(0.7 + delta), 0.2 + delta, 3);
		assert.equal(rocket.actualFlightPath.length, 2);
		assert.equal(rocket.actualFlightPath[1].time, 3);
	});

	it('host-fixed threshold at realistic radius: 5 m·(1 - 1e-6) is skipped, 5 m·(1 + 1e-6) is recorded', () => {
		const host = makeMainBody(1, 0, 0);
		const below = makeMainRocket(2, 0, 0, { hostId: 1 });
		recordAt(below, host, R0, 0, 0, 0);
		recordAt(below, host, R0 + m2p(MIN_SAMPLE_M * (1 - 1e-6)), 0, 0, 1);
		assert.equal(below.actualFlightPath.length, 1);
		const above = makeMainRocket(3, 0, 0, { hostId: 1 });
		recordAt(above, host, R0, 0, 0, 0);
		recordAt(above, host, R0 + m2p(MIN_SAMPLE_M * (1 + 1e-6)), 0, 0, 1);
		assert.equal(above.actualFlightPath.length, 2);
	});

	for (const frameCase of [{ label: 'host-fixed', switchTime: null, t: 10 }, { label: 'inertial', switchTime: 0, t: 10 }]) {
		it(`${frameCase.label} threshold at float resolution: exactly 5 m is recorded (>=), the next lower double is not`, () => {
			const exact = m2p(MIN_SAMPLE_M);
			assert.equal(UnitConvertUtils.pix2m(exact), MIN_SAMPLE_M, 'precondition: this pixel offset converts to exactly 5 m');
			const lower = nextFloat(exact, -1);
			assert.ok(UnitConvertUtils.pix2m(lower) < MIN_SAMPLE_M);
			for (const [offset, expectedLen] of [[exact, 2], [lower, 1], [nextFloat(exact, 1), 2]]) {
				const host = makeMainBody(1, 0, 0);
				const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: { frameSwitchTime: frameCase.switchTime } });
				recordAt(rocket, host, 0, 0, 0, frameCase.t);
				recordAt(rocket, host, offset, 0, 0, frameCase.t + 1);
				assert.equal(rocket.actualFlightPath.length, expectedLen, `offset ${UnitConvertUtils.pix2m(offset)} m`);
			}
		});
	}

	it('inertial rule after the switch: a surface-stationary (GEO-like) craft keeps being recorded (G2-3-03)', () => {
		const host = makeMainBody(1, 0, 0);
		const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: { frameSwitchTime: 100 } });
		const Rg = m2p(4.2164e7);
		const omega = TWO_PI / 86164;
		for (let k = 0; k < 6; k++) {
			const t = 200 + 60 * k;
			recordAt(rocket, host, Rg * Math.cos(1 + omega * t), Rg * Math.sin(1 + omega * t), omega * t, t);
		}
		assert.equal(rocket.actualFlightPath.length, 6, 'every frame moves ~184 km inertially');
		assert.deepEqual(rocket.actualFlightPath.map((p) => p.time), [200, 260, 320, 380, 440, 500]);
		const phis = rocket.actualFlightPath.map((p) => p.phiSurf);
		for (const phi of phis) { assert.ok(Math.abs(phi - 1) <= 1e-9, 'the craft is fixed over the same surface point'); }
	});

	it('inertial rule: an inertially stationary craft is not recorded even though the host rotates under it', () => {
		const host = makeMainBody(1, 0, 0);
		const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: { frameSwitchTime: 0 } });
		recordAt(rocket, host, R0, 0, 0, 1);
		recordAt(rocket, host, R0, 0, 0.5, 2);
		assert.equal(rocket.actualFlightPath.length, 1, 'host-fixed displacement would be ~3.1e6 m, inertial is 0');
	});

	it('switch boundary: time == frameSwitchTime uses the host-fixed rule, just after it the inertial rule', () => {
		const omega = TWO_PI / 86164;
		const Rg = m2p(4.2164e7);
		const run = (t2) => {
			const host = makeMainBody(1, 0, 0);
			const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: { frameSwitchTime: 500 } });
			recordAt(rocket, host, Rg * Math.cos(1 + omega * 400), Rg * Math.sin(1 + omega * 400), omega * 400, 400);
			recordAt(rocket, host, Rg * Math.cos(1 + omega * 500), Rg * Math.sin(1 + omega * 500), omega * 500, t2);
			return rocket.actualFlightPath.length;
		};
		assert.equal(run(500), 1, 'at the switch time: host-fixed, craft stationary over the surface');
		assert.equal(run(nextFloat(500, 1)), 2, 'just after the switch time: inertial, ~307 km moved');
		assert.equal(run(499.999), 1, 'just before the switch time: host-fixed');
	});

	it('abnormal frameSwitchTime (undefined / NaN / Infinity / string / missing prediction) falls back to the host-fixed rule', () => {
		const omega = TWO_PI / 86164;
		const Rg = m2p(4.2164e7);
		for (const pred of [{ frameSwitchTime: undefined }, { frameSwitchTime: NaN }, { frameSwitchTime: Infinity }, { frameSwitchTime: '0' }, null, undefined]) {
			const host = makeMainBody(1, 0, 0);
			const rocket = makeMainRocket(2, 0, 0, { hostId: 1, predictedTrajectory: pred });
			recordAt(rocket, host, Rg * Math.cos(1), Rg * Math.sin(1), 0, 10);
			recordAt(rocket, host, Rg * Math.cos(1 + omega * 600), Rg * Math.sin(1 + omega * 600), omega * 600, 610);
			assert.equal(rocket.actualFlightPath.length, 1, `prediction ${JSON.stringify(pred)}`);
		}
	});

	it('legacy last point without r / phiSurf is compared through its relX / relY in the host-fixed rule', () => {
		const host = makeMainBody(1, 0, 0);
		const rocket = makeMainRocket(2, 0, 0, { hostId: 1 });
		rocket.actualFlightPath = [{ relX: R0, relY: 0, time: 0 }];
		recordAt(rocket, host, R0 + m2p(4), 0, 0, 1);
		assert.equal(rocket.actualFlightPath.length, 1);
		recordAt(rocket, host, R0 + m2p(6), 0, 0, 2);
		assert.equal(rocket.actualFlightPath.length, 2);
	});

	const fillPath = (n) => Array.from({ length: n }, (_, i) => {
		const rel = R0 + m2p(i * 100);
		return { worldX: rel, worldY: 0, relX: rel, relY: 0, r: rel, phiSurf: 0, time: i };
	});

	it(`thinning above ACTUAL_MAX_POINTS (${MAX_ACTUAL}): even indices plus the newest point survive (odd and even lengths)`, () => {
		// pre-filled length -> length after push -> survivors: even indices 0..(last even) plus the newest index
		const cases = [
			{ pre: MAX_ACTUAL, len: MAX_ACTUAL / 2 + 1, evens: MAX_ACTUAL / 2 },
			{ pre: MAX_ACTUAL + 1, len: MAX_ACTUAL / 2 + 2, evens: MAX_ACTUAL / 2 + 1 },
			{ pre: MAX_ACTUAL + 2, len: MAX_ACTUAL / 2 + 2, evens: MAX_ACTUAL / 2 + 1 }
		];
		for (const c of cases) {
			const host = makeMainBody(1, 0, 0);
			const rocket = makeMainRocket(2, 0, 0, { hostId: 1 });
			rocket.actualFlightPath = fillPath(c.pre);
			const path = recordAt(rocket, host, R0 * 3, 0, 0, 99999);
			assert.equal(path.length, c.len, `pre-filled ${c.pre}`);
			assert.equal(path[path.length - 1].time, 99999, `newest point kept (pre-filled ${c.pre})`);
			assert.equal(path[path.length - 1].relX, R0 * 3);
			for (let k = 0; k < c.evens; k++) {
				assert.equal(path[k].time, 2 * k, `survivor ${k} is original index ${2 * k}`);
			}
		}
	});

	it('thinning boundary: reaching exactly ACTUAL_MAX_POINTS keeps all points; above the cap without a new point keeps the last one', () => {
		const host = makeMainBody(1, 0, 0);
		const atCap = makeMainRocket(2, 0, 0, { hostId: 1 });
		atCap.actualFlightPath = fillPath(MAX_ACTUAL - 1);
		assert.equal(recordAt(atCap, host, R0 * 3, 0, 0, 99999).length, MAX_ACTUAL);
		const noNew = makeMainRocket(3, 0, 0, { hostId: 1 });
		noNew.actualFlightPath = fillPath(MAX_ACTUAL + 1);
		const lastPrev = noNew.actualFlightPath[MAX_ACTUAL];
		const path = recordAt(noNew, host, lastPrev.relX, lastPrev.relY, 0, 99999);
		assert.equal(path.length, MAX_ACTUAL / 2 + 1);
		assert.equal(path[path.length - 1], lastPrev, 'the previous newest point is still the last one');
	});

	it('guards: hold-down, removed state, missing objects or host record nothing; host resolution falls back to prediction then dominant body', () => {
		const host = makeMainBody(1, 0, 0);
		const other = makeMainBody(5, 1, 1);
		const held = makeMainRocket(2, R0, 0, { hostId: 1, isHoldDown: true });
		held._recordActualFlightPath([host, held]);
		assert.equal(held.actualFlightPath.length, 0);
		const removed = makeMainRocket(3, R0, 0, { hostId: 1, state: OBJECT_STATE.REMOVED });
		removed._recordActualFlightPath([host, removed]);
		assert.equal(removed.actualFlightPath.length, 0);
		const noObjs = makeMainRocket(4, R0, 0, { hostId: 1 });
		noObjs._recordActualFlightPath(null);
		noObjs._recordActualFlightPath(undefined);
		assert.equal(noObjs.actualFlightPath.length, 0);
		const noHost = makeMainRocket(6, R0, 0, { hostId: 404 });
		noHost._recordActualFlightPath([host, noHost]);
		assert.equal(noHost.actualFlightPath.length, 0);
		const viaPred = makeMainRocket(7, 1 + R0, 1, { hostId: null, predictedTrajectory: { hostId: 5 }, dominantBodyId: 1 });
		viaPred._recordActualFlightPath([host, other, viaPred]);
		assert.equal(viaPred.actualFlightPath[0].relX, (1 + R0) - 1, 'prediction hostId wins over the dominant body');
		const viaDom = makeMainRocket(8, R0, 0, { hostId: undefined, dominantBodyId: 1 });
		viaDom._recordActualFlightPath([host, other, viaDom]);
		assert.equal(viaDom.actualFlightPath[0].relX, R0);
		const none = makeMainRocket(9, R0, 0, { hostId: null });
		none._recordActualFlightPath([host, other, none]);
		assert.equal(none.actualFlightPath.length, 0, 'dominantBodyId -1 resolves to no host');
		const nulled = makeMainRocket(10, R0, 0, { hostId: 1, actualFlightPath: null });
		nulled._recordActualFlightPath([host, nulled]);
		assert.equal(nulled.actualFlightPath.length, 1, 'a null path is recreated');
	});

	it('updateHistory: paused frames do not record, held-and-unignited rockets record no history at all', () => {
		const host = makeMainBody(1, 0, 0);
		const paused = makeMainRocket(2, R0, 0, { hostId: 1 });
		paused.updateHistory(1, [host, paused], true);
		assert.equal(paused.actualFlightPath.length, 0);
		assert.equal(paused.trajectory.count, 1, 'the ordinary trail is still recorded');
		paused.updateHistory(2, [host, paused], false);
		assert.equal(paused.actualFlightPath.length, 1);
		const parked = makeMainRocket(3, R0, 0, { hostId: 1, isHoldDown: true, isIgnited: false });
		parked.updateHistory(1, [host, parked], false);
		assert.equal(parked.trajectory.count, 0);
		assert.equal(parked.actualFlightPath.length, 0);
	});
});

// ===========================================================================
// A-8: no main-thread rotation integration (§3.1.1-2, §4.8, G2-09)
// ===========================================================================
describe('Unit 06-A8: main thread does not integrate rotation (Universe, PadEffectRenderer)', () => {
	const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const readScript = (name) => stripComments(fs.readFileSync(path.resolve(process.cwd(), 'scripts', name), 'utf8'));

	it('Universe update hooks leave celestial rotationAngle untouched for any dt / time scale', () => {
		EventBus.clearAll();
		const canvas = createMockElement('canvas');
		const universe = new Universe(canvas);
		try {
			universe.ObjectPlacer.placeObject('Earth', 500, 500, 0, 0);
			const earth = universe.objects.find((o) => o.name === 'Earth');
			assert.equal(earth.param.ROTATION_PERIOD, 86164, 'precondition: Earth has a rotation period on the main thread');
			earth.rotationAngle = 0.75;
			universe.timeScale = 1e4;
			for (let i = 0; i < 5; i++) { universe.update(16); }
			EventBus.emitUpdate(1000, 86164);
			assert.equal(earth.rotationAngle, 0.75);
			universe.isPaused = true;
			universe.update(16);
			assert.equal(earth.rotationAngle, 0.75);
		} finally {
			universe.destroy();
			EventBus.clearAll();
		}
	});

	it('gravsim_universe.js and gravsim_pad_effect.js contain no rotation-period integration code', () => {
		for (const name of ['gravsim_universe.js', 'gravsim_pad_effect.js']) {
			const src = readScript(name);
			assert.equal(/ROTATION_PERIOD/.test(src), false, `${name}: no ROTATION_PERIOD lookup`);
			assert.equal(/\brotationAngle\s*(\+|-)?=(?!=)/.test(src), false, `${name}: no assignment to a rotationAngle`);
			assert.equal(/\bomega\b/.test(src), false, `${name}: no angular-rate integration variable`);
		}
		assert.ok(/padRefRotationAngle/.test(readScript('gravsim_pad_effect.js')), 'pad effect tracks padRefRotationAngle');
	});

	describe('PadEffectRenderer follows host.rotationAngle deltas only', () => {
		const ctxOf = (rocket, host) => ({ rocket, host, m2pix: UnitConvertUtils.m2pix, zoomScale: 1 });
		const makePad = () => {
			const pad = new PadEffectRenderer();
			pad.start(2, 1);
			const host = { id: 1, x: 10, y: -4, rotationAngle: 0.4, param: { ROTATION_PERIOD: 86164 } };
			const rocket = { id: 2, x: 10 + 3e-5, y: -4 + 4e-5, thrustAngle: Math.atan2(4, 3), isHoldDown: true, baseRadiusM: 2, radius: 30, bottomOffsetM: 6 };
			pad.update(0.016, ctxOf(rocket, host));
			return { pad, host, rocket };
		};

		it('captures the pad frame while held down', () => {
			const { pad, host, rocket } = makePad();
			assert.equal(pad.startRelPadX, rocket.x - host.x);
			assert.equal(pad.startRelPadY, rocket.y - host.y);
			assert.equal(pad.startLaunchAngle, rocket.thrustAngle);
			assert.equal(pad.padRefRotationAngle, 0.4);
		});

		it('after liftoff a large dt without a host rotation change does not move the pad (no omega·dt)', () => {
			const { pad, host, rocket } = makePad();
			const snap = { x: pad.startRelPadX, y: pad.startRelPadY, a: pad.startLaunchAngle };
			rocket.isHoldDown = false;
			for (const dt of [0.016, 1, 3600, 86164]) { pad.update(dt, ctxOf(rocket, host)); }
			assert.deepEqual({ x: pad.startRelPadX, y: pad.startRelPadY, a: pad.startLaunchAngle }, snap);
			assert.equal(pad.padRefRotationAngle, 0.4);
		});

		it('rotates the pad by exactly the host rotationAngle delta, cumulatively, in either direction', () => {
			const { pad, host, rocket } = makePad();
			const x0 = pad.startRelPadX;
			const y0 = pad.startRelPadY;
			const a0 = pad.startLaunchAngle;
			rocket.isHoldDown = false;
			host.rotationAngle = 0.4 + 0.1;
			pad.update(0.016, ctxOf(rocket, host));
			const d1 = host.rotationAngle - 0.4;
			assert.equal(pad.startRelPadX, x0 * Math.cos(d1) - y0 * Math.sin(d1));
			assert.equal(pad.startRelPadY, x0 * Math.sin(d1) + y0 * Math.cos(d1));
			assert.equal(pad.startLaunchAngle, a0 + d1);
			assert.equal(pad.padRefRotationAngle, host.rotationAngle);
			host.rotationAngle = 0.4 - 0.3;
			pad.update(5, ctxOf(rocket, host));
			const total = -0.3;
			assert.ok(Math.abs(pad.startRelPadX - (x0 * Math.cos(total) - y0 * Math.sin(total))) <= 1e-18);
			assert.ok(Math.abs(pad.startRelPadY - (x0 * Math.sin(total) + y0 * Math.cos(total))) <= 1e-18);
			assert.ok(Math.abs(pad.startLaunchAngle - (a0 + total)) <= 1e-15);
			const abs = pad._getAbsPadPosition(ctxOf(rocket, host));
			assert.equal(abs.x, host.x + pad.startRelPadX);
			assert.equal(abs.y, host.y + pad.startRelPadY);
			assert.equal(abs.angle, pad.startLaunchAngle);
		});

		it('abnormal host angle (NaN / undefined / Infinity) neither rotates the pad nor loses the reference', () => {
			const { pad, host, rocket } = makePad();
			const snap = { x: pad.startRelPadX, y: pad.startRelPadY, a: pad.startLaunchAngle };
			rocket.isHoldDown = false;
			for (const bad of [NaN, undefined, Infinity, '0.9']) {
				host.rotationAngle = bad;
				pad.update(1, ctxOf(rocket, host));
				assert.deepEqual({ x: pad.startRelPadX, y: pad.startRelPadY, a: pad.startLaunchAngle }, snap, `host angle ${String(bad)}`);
				assert.equal(pad.padRefRotationAngle, 0.4);
			}
			host.rotationAngle = 0.6;
			pad.update(1, ctxOf(rocket, host));
			assert.equal(pad.startLaunchAngle, snap.a + (0.6 - 0.4), 'resumes from the last valid reference');
		});

		it('first observation after liftoff only initialises the reference; start() resets it; missing host / inactive do nothing', () => {
			const pad = new PadEffectRenderer();
			pad.start(2, 1);
			assert.equal(pad.padRefRotationAngle, null);
			const host = { id: 1, x: 0, y: 0, rotationAngle: 1.1 };
			const rocket = { id: 2, x: 1e-4, y: 0, thrustAngle: 0, isHoldDown: false, radius: 30 };
			pad.startRelPadX = 1e-4;
			pad.update(1, ctxOf(rocket, host));
			assert.equal(pad.padRefRotationAngle, 1.1);
			assert.equal(pad.startRelPadX, 1e-4, 'no rotation on the initialising frame');
			assert.equal(pad.startLaunchAngle, 0);
			assert.doesNotThrow(() => pad.update(1, ctxOf(rocket, null)));
			assert.equal(pad.padRefRotationAngle, 1.1);
			pad.start(2, 1);
			assert.equal(pad.padRefRotationAngle, null);
			pad.stop();
			host.rotationAngle = 2.0;
			pad.update(1, ctxOf(rocket, host));
			assert.equal(pad.padRefRotationAngle, null, 'inactive renderer ignores updates');
		});
	});
});

// ===========================================================================
// A-9: subtraction-first projection precision (§3.1.2 last bullet)
// ===========================================================================
describe('Unit 06-A9: subtraction-first projection at 1 AU (TrajectoryPredictor, TrailRenderer)', () => {
	// 1 AU = 180 px on the main thread. Dyadic coordinates make every exact result representable:
	// host at 180.125 px, camera basis 500 / 300 px (screen) away, zoom 2^40, local offsets carry a 2^-58 px bit
	// that an add-first evaluation (host.x + local, magnitude 2^7) must round away.
	const Z = 2 ** 40;
	const U = 2 ** -40;
	const TINY = 2 ** -58;
	const host = { id: 7, x: 180.125, y: -90.0625, rotationAngle: 0 };
	const basis = { x: host.x + 500 * U, y: host.y + 300 * U };
	const localX = (j) => 100 * j * U + TINY;
	const localY = (j) => -50 * j * U - TINY;
	const expectX = (j) => -500 + 100 * j + TINY * Z;
	const expectY = (j) => -300 - 50 * j - TINY * Z;
	const naiveX = (j) => ((host.x + localX(j)) - basis.x) * Z;
	const renderContext = () => ({ objectsMap: new Map([[host.id, host]]), basis, zoomScale: Z });

	it('precondition: the inputs are precision-sensitive (an add-first evaluation is off by 2^-18 px)', () => {
		for (let j = 0; j < 5; j++) {
			assert.notEqual(naiveX(j), expectX(j));
			assert.equal(Math.abs(naiveX(j) - expectX(j)), 2 ** -18);
		}
	});

	it('renderTrajectory draws legacy (relX / relY) prediction points at the exact screen coordinates', () => {
		const ctx = createRecordingCtx();
		const points = [0, 1, 2, 3, 4].map((j) => ({ relX: localX(j), relY: localY(j), time: j * 10 }));
		TrajectoryPredictor.renderTrajectory(ctx, renderContext(), { hostId: 7, points, events: [], maxSimTime: 1000 }, { mode: 'preview' });
		const verts = pathVertices(ctx.calls);
		assert.deepEqual(verts, [0, 1, 2, 3, 4].map((j) => ({ x: expectX(j), y: expectY(j) })));
	});

	it('renderTrajectory draws host-fixed (r / phiSurf) points and event markers at the exact screen coordinates', () => {
		const ctx = createRecordingCtx();
		const points = [0, 1, 2, 3, 4].map((j) => ({ r: localX(j), phiSurf: 0, relX: localX(j), relY: 0, time: j * 10 }));
		const events = [{ id: 'meco', name: 'MECO', type: 'meco', relX: localX(2), relY: localY(2), time: 20 }];
		TrajectoryPredictor.renderTrajectory(ctx, renderContext(), { hostId: 7, points, events, maxSimTime: 1000 }, { mode: 'preview' });
		assert.deepEqual(pathVertices(ctx.calls), [0, 1, 2, 3, 4].map((j) => ({ x: expectX(j), y: -300 })), 'only the prediction polyline (markers are arcs)');
		const marker = ctx.calls.find((c) => c.op === 'arc');
		assert.equal(marker.args[0], expectX(2));
		assert.equal(marker.args[1], expectY(2));
	});

	it('renderTrajectory draws the post-switch actual flight path (relX / relY) and the rocket tip at the exact coordinates', () => {
		const ctx = createRecordingCtx();
		const actual = [0, 1, 2, 3].map((j) => ({ relX: localX(j), relY: localY(j), r: 1, phiSurf: 0, time: 1 + j }));
		const rocketX = host.x + 900 * U;
		const rocketY = host.y + 100 * U;
		TrajectoryPredictor.renderTrajectory(ctx, renderContext(), {
			hostId: 7, points: [{ relX: 0, relY: 0, time: 0 }, { relX: U, relY: 0, time: 1 }], events: [], maxSimTime: 1000,
			frameSwitchTime: 0, frameSwitchHostRot: 0, hostOmega: 0
		}, { mode: 'flight', currentFlightTime: 5, actualFlightPath: actual, rocketX, rocketY, showPredictedTrajectory: false });
		const verts = pathVertices(ctx.calls);
		assert.deepEqual(verts, [...[0, 1, 2, 3].map((j) => ({ x: expectX(j), y: expectY(j) })), { x: 400, y: -200 }]);
	});

	it('renderTrajectory draws nothing (and does not throw) for a missing host, a null prediction or fewer than 2 points', () => {
		for (const [rc, pred] of [
			[{ objectsMap: new Map(), basis, zoomScale: Z }, { hostId: 7, points: [{ relX: 0, relY: 0 }, { relX: U, relY: 0 }] }],
			[renderContext(), null],
			[renderContext(), { hostId: 7, points: [] }],
			[renderContext(), { hostId: 7, points: [{ relX: 0, relY: 0 }] }]
		]) {
			const ctx = createRecordingCtx();
			assert.doesNotThrow(() => TrajectoryPredictor.renderTrajectory(ctx, rc, pred, { mode: 'preview' }));
			assert.equal(ctx.calls.length, 0);
		}
	});

	it('EffectRenderer._getPointsToDraw restores reference-relative trail points at the exact screen coordinates', () => {
		const trail = new EffectTrail(1, {});
		for (let j = 0; j < 5; j++) { trail.addPoint(host.id, localX(j), localY(j), j, TRAIL_MODE.NORMAL); }
		const pts = EffectRenderer._getPointsToDraw(trail, renderContext());
		assert.deepEqual(pts.map((p) => ({ x: p.relX, y: p.relY, i: p.logicalIdx })), [4, 3, 2, 1, 0].map((j) => ({ x: expectX(j), y: expectY(j), i: j })));
	});

	it('EffectRenderer: atmosphere points follow the reference rotation; absolute fallback for refId -1, unknown ref or no map', () => {
		const rotHost = { ...host, rotationAngle: Math.PI / 6 };
		const trail = new EffectTrail(1, {});
		trail.addPoint(host.id, localX(3), 0, 0, TRAIL_MODE.ATMOSPHERE);
		const [p] = EffectRenderer._getPointsToDraw(trail, { objectsMap: new Map([[host.id, rotHost]]), basis, zoomScale: Z });
		assert.ok(Math.abs(p.relX - (-500 + localX(3) * Math.cos(Math.PI / 6) * Z)) <= 1e-9);
		assert.ok(Math.abs(p.relY - (-300 + localX(3) * Math.sin(Math.PI / 6) * Z)) <= 1e-9);

		const absX = basis.x + 250 * U;
		const absY = basis.y - 125 * U;
		for (const [refId, map] of [[-1, new Map([[host.id, host]])], [404, new Map([[host.id, host]])], [host.id, undefined]]) {
			const t = new EffectTrail(2, {});
			t.addPoint(refId, absX, absY, 0, TRAIL_MODE.NORMAL);
			const [q] = EffectRenderer._getPointsToDraw(t, { objectsMap: map, basis, zoomScale: Z });
			assert.equal(q.relX, 250, `refId ${refId}`);
			assert.equal(q.relY, -125, `refId ${refId}`);
		}
	});

	it('EffectRenderer boundary: empty trail gives no points, a single point gives one, null basis uses the origin', () => {
		assert.deepEqual(EffectRenderer._getPointsToDraw(new EffectTrail(1, {}), renderContext()), []);
		const one = new EffectTrail(1, {});
		one.addPoint(-1, 2 * U, -3 * U, 0, TRAIL_MODE.NORMAL);
		assert.deepEqual(EffectRenderer._getPointsToDraw(one, { objectsMap: null, basis: null, zoomScale: Z }).map((p) => [p.relX, p.relY]), [[2, -3]]);
	});
});
