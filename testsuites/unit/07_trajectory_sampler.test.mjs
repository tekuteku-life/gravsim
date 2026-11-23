/**
 * Unit Test Suite 07: Trajectory Predictor Sampler, End Reasons, Budgets, Frame Switch & Rendering
 *
 * Design: docs/design/2026-11-20_trajectory_fx_flightplan.md
 *   §3.1.2 (sampling, single final point), §4.3 (apsis crossing, MAX_ANGLE_STEP_RAD in the drawn frame, end reasons,
 *   guarantees 1-2), §4.10 (drawn frame switch, renderTrajectory projection), §4.11 (breakup), §4.12 (step budget,
 *   trackRcsVisualState).
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-B.
 * The Worker message path (worker handler and main-thread passthrough) is in 07b_trajectory_worker_scope.test.mjs,
 * because the predictor module must be evaluated with a worker global scope (once per process).
 *
 * The direct runMultiBodySimulation tests use synthetic worlds whose motion is known in closed form (a coasting
 * probe with zero thrust, a massless host for exactly zero relative motion, radial escape at a chosen multiple of
 * the escape speed), so every expectation follows from the design formulas rather than from recorded output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { PHYSICS, TRAJECTORY_PREDICTION, DEFAULT_FLIGHT_EVENTS, OBJECT_TYPES, RENDER, RCS_CONFIG } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { createFalcon9Config } from '../test_helpers.mjs';

const TP = TRAJECTORY_PREDICTION;
const SP = TP.SAMPLING;
const MONTH_S = (365.25 / 12) * 86400; // RocketLauncher.maxSimTimeSec per month
const RE = 6371e3;
const ME = 5.972e24;
const GM = PHYSICS.G * ME;
const END_REASONS = new Set(['horizon', 'impact', 'breakup', 'point_budget', 'step_budget', 'no_host']);
const COAST_STAGES = [{ thrustKN: 0, fuelMassT: 0, oxidMassT: 0, burnTime: 0, dryMassT: 1 }];
const EARTH_LIKE_ATM = { ROTATION_PERIOD: 0, ATM_LIMIT_ALT: 100000, ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 };
const PREDICTED_DASHES = new Set([RENDER.PREDICTED_TRAJECTORY.LINE_DASH_PRE, RENDER.PREDICTED_TRAJECTORY.LINE_DASH_FLIGHT].map(d => d.join(',')));

const vCirc = (r) => Math.sqrt(GM / r);
const vEsc = (r) => Math.sqrt(2 * GM / r);
const m2p = (m) => UnitConvertUtils.m2pix(m);
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const inertialAngle = (p) => Math.atan2(p.relY, p.relX);
const stepBudget = (maxSimTime) => Math.min(TP.MAX_STEPS_CAP, Math.max(TP.MAX_STEPS, Math.ceil(maxSimTime / 5)));

/** Run the predictor on a synthetic world: host id 1 at the origin plus optional extra bodies. */
function simulate({ host = {}, rocket = {}, options = {}, extraBodies = [], hostId = 1, eventDefinitions } = {}) {
	const hostBody = {
		id: 1, name: 'TestHost', x: 0, y: 0, vx: 0, vy: 0, massKg: ME, radius: RE, param: { ROTATION_PERIOD: 0 },
		...host
	};
	const args = {
		hostId,
		celestialBodies: [hostBody, ...extraBodies],
		rocketConfig: {
			name: 'Probe', x: RE + 400e3, y: 0, vx: 0, vy: 0, radius: 2, bottomOffsetM: 2,
			dryMassT: 1, fuelMassT: 0, oxidMassT: 0, thrustForceN: 0, burnTime: 0, flightProfile: [], stages: COAST_STAGES,
			...rocket
		},
		options
	};
	if (eventDefinitions) { args.eventDefinitions = eventDefinitions; }
	return runMultiBodySimulation(args);
}

/** Circular coast at 400 km around an airless, non-rotating host. */
const coast = (options) => {
	const r0 = RE + 400e3;
	return simulate({ rocket: { x: r0, vy: vCirc(r0) }, options });
};

/** Long low-thrust burn in orbit: one sample per TIME_POWERED_S while burning, so it reaches 3,000 points. */
const longBurn = (options) => {
	const r0 = RE + 400e3;
	const stages = [{ thrustKN: 1, fuelMassT: 0.5, oxidMassT: 0.5, burnTime: 5000, dryMassT: 1, ispVac: 300 }];
	return simulate({
		rocket: { x: r0, vy: vCirc(r0), stages, burnTime: 5000, fuelMassT: 0.5, oxidMassT: 0.5, thrustForceN: 1000, disableOrbitalCutoff: true },
		options: { maxSimTime: 20000, ...options }
	});
};

/** TrajectoryPredictor launch configuration around a synthetic rotating host (circular 400 km orbit). */
function predictorConfig({ hostId = 11, maxSimTime = 600, burn = false } = {}) {
	const host = {
		id: hostId, name: 'TestHost', type: OBJECT_TYPES.CELESTIAL, x: 0.2, y: -0.1, vx: 0, vy: 0,
		mass: UnitConvertUtils.kg2ton(ME), radius: RE, rotationAngle: 0.4, param: { ROTATION_PERIOD: 86164 }
	};
	const r0 = RE + 400e3;
	const config = { host, relX: m2p(r0), relY: 0, relVx: 0, relVy: m2p(vCirc(r0)), maxSimTime, bottomOffsetM: 2, dryMassT: 1 };
	if (burn) {
		Object.assign(config, {
			stages: [{ thrustKN: 1, fuelMassT: 0.5, oxidMassT: 0.5, burnTime: 5000, dryMassT: 1, ispVac: 300 }],
			fuelMassT: 0.5, oxidMassT: 0.5, thrustKN: 1, burnTime: 5000, disableOrbitalCutoff: true
		});
	} else {
		Object.assign(config, { stages: COAST_STAGES, fuelMassT: 0, oxidMassT: 0, burnTime: 0 });
	}
	return { universe: { objects: [host], getObjectParams: () => null }, config };
}

/**
 * Budget option values that are not plain positive numbers (design §4.12, Rev 6.10): Number(value) is used only when it
 * is > 0 (Infinity included); anything else counts as not given. Columns: label, value, step budget for a 0.2-month
 * request (floor 120,000, cap 340,000), point budget (MAX_POINTS 3,000).
 */
const ABNORMAL_BUDGET_OPTIONS = [
	["'abc'", 'abc', 120000, 3000],
	["''", '', 120000, 3000],
	["'  '", '  ', 120000, 3000],
	["'500'", '500', 120000, 500],
	["'5000'", '5000', 120000, 3000],
	["'Infinity'", 'Infinity', 340000, 3000],
	['-1', -1, 120000, 3000],
	['-0', -0, 120000, 3000],
	['0', 0, 120000, 3000],
	['true', true, 120000, 1],
	['false', false, 120000, 3000],
	['[]', [], 120000, 3000],
	['{}', {}, 120000, 3000],
	['NaN', NaN, 120000, 3000],
	['Infinity', Infinity, 340000, 3000]
];
/** The Rev 6.10 rule written out, used to cross-check the literal table above. */
const ruleStepBudget = (value, maxSimTime) => {
	const n = Number(value);
	return Math.min(TP.MAX_STEPS_CAP, n > 0 ? Math.max(n, stepBudget(maxSimTime)) : stepBudget(maxSimTime));
};
const rulePointBudget = (value) => {
	const n = Number(value);
	return Math.min(TP.MAX_POINTS, n > 0 ? n : TP.MAX_POINTS);
};

const impactEvents = (res) => res.events.filter(e => e.type === 'impact' && e.id !== 'breakup');
const breakupEvents = (res) => res.events.filter(e => e.id === 'breakup');

/** Guarantee 2 and the §4.3 end-reason table, applicable to every prediction. */
function assertResultContract(res, label) {
	assert.ok(END_REASONS.has(res.endReason), `${label}: endReason ${res.endReason} must be one of the §4.3 table`);
	assert.ok(res.points.length <= TP.MAX_POINTS, `${label}: ${res.points.length} points must not exceed MAX_POINTS`);
	assert.ok(res.steps <= TP.MAX_STEPS_CAP, `${label}: ${res.steps} steps must not exceed MAX_STEPS_CAP`);
	for (let i = 1; i < res.points.length; i++) {
		assert.ok(res.points[i].time > res.points[i - 1].time, `${label}: point times must increase strictly (index ${i})`);
	}
	const last = res.points[res.points.length - 1];
	assert.equal(res.maxSimTime, last ? last.time : 0, `${label}: maxSimTime must be the final point's time`);
	assert.equal(impactEvents(res).length > 0, res.endReason === 'impact', `${label}: impact event exists only for endReason impact`);
	assert.equal(breakupEvents(res).length > 0, res.endReason === 'breakup', `${label}: breakup event exists only for endReason breakup`);
	assert.ok(impactEvents(res).length <= 1 && breakupEvents(res).length <= 1, `${label}: at most one terminal event`);
}

/** Canvas 2D context that records the drawn geometry of renderTrajectory (canvas large enough to avoid culling at zoom 1e9). */
class RecordingContext {
	constructor(size = 1e13) {
		this.canvas = { width: size, height: size };
		this.strokes = [];
		this.arcs = [];
		this.saves = 0;
		this._path = [];
		this._sub = null;
		this._dash = [];
		this.strokeStyle = '';
		this.fillStyle = '';
		this.lineWidth = 1;
		this.font = '';
		this.textBaseline = '';
	}
	save() { this.saves++; }
	restore() {}
	beginPath() { this._path = []; this._sub = null; }
	moveTo(x, y) { this._sub = [[x, y]]; this._path.push(this._sub); }
	lineTo(x, y) {
		if (!this._sub) { this.moveTo(x, y); return; }
		this._sub.push([x, y]);
	}
	quadraticCurveTo(cx, cy) { this.lineTo(cx, cy); }
	arc(x, y, r) { this.arcs.push({ x, y, r }); }
	stroke() { this.strokes.push({ dash: this._dash.slice(), subpaths: this._path }); }
	fill() {}
	fillRect() {}
	fillText() {}
	setLineDash(d) { this._dash = Array.isArray(d) ? d.slice() : []; }
	measureText(t) { return { width: String(t).length * 6 }; }
	/** Subpaths of the predicted line (the only stroke drawn with the configured predicted-line dash). */
	predictedSubpaths() {
		return this.strokes.filter(s => s.dash.length > 0 && PREDICTED_DASHES.has(s.dash.join(','))).flatMap(s => s.subpaths);
	}
	/** Vertices of the dashed predicted line. */
	predictedVertices() {
		return this.predictedSubpaths().flat();
	}
	/** Vertices of the solid stroke that starts with a polyline (the actual flight path). */
	solidPathVertices() {
		const s = this.strokes.find(st => st.dash.length === 0 && st.subpaths.length > 0);
		return s ? s.subpaths.flat() : [];
	}
}

function render(prediction, host, options, { basis = { x: host.x, y: host.y }, zoom = 1 } = {}) {
	const ctx = new RecordingContext();
	const rc = { objects: [host], basis, zoomScale: zoom, cameraOffset: { x: 0, y: 0 } };
	TrajectoryPredictor.renderTrajectory(ctx, rc, prediction, options);
	return ctx;
}

function assertVertex(actual, expected, label) {
	assert.ok(actual, `${label}: vertex must be drawn`);
	const d = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
	assert.ok(d <= 1e-9 * Math.max(1, Math.hypot(expected[0], expected[1])), `${label}: drawn ${actual} vs expected ${expected} (|d|=${d})`);
}

/** Largest angle between adjacent drawn vertices around the host (the host is drawn at the screen origin). */
function maxDrawnStep(ctx) {
	const subpaths = ctx.predictedSubpaths();
	assert.equal(subpaths.length, 1, 'the whole predicted line is one unculled polyline');
	const v = subpaths[0];
	let m = 0;
	for (let i = 1; i < v.length; i++) {
		m = Math.max(m, Math.abs(normAngle(Math.atan2(v[i][1], v[i][0]) - Math.atan2(v[i - 1][1], v[i - 1][0]))));
	}
	return m;
}

const F9_PROFILE = [
	{ type: 'time', value: 0, thrust: 100, angle: 0 },
	{ type: 'time', value: 10, thrust: 100, angle: 5 },
	{ type: 'time', value: 60, thrust: 100, angle: 25 },
	{ type: 'time', value: 150, thrust: 100, angle: 60 },
	{ type: 'time', value: 300, thrust: 100, angle: 80 },
	{ type: 'time', value: 500, thrust: 100, angle: 90 }
];

/** Falcon 9 ascent from a rotating Earth (preset parameters) to orbit within 1,200 s. */
function falconAscentArgs(hostRot = 0.7) {
	const f9 = createFalcon9Config();
	const earthParam = presetManager.getObjectParam('Earth');
	const omega = 2 * Math.PI / earthParam.ROTATION_PERIOD;
	return {
		hostId: 1,
		celestialBodies: [{ id: 1, name: 'Earth', x: 0, y: 0, vx: 0, vy: 0, massKg: ME, radius: RE, param: earthParam, rotationAngle: hostRot }],
		rocketConfig: {
			name: 'Falcon 9', x: 0, y: RE + 10, vx: -omega * (RE + 10), vy: 0, radius: 1.85,
			dryMassT: f9.stages[0].dryMassT, fuelMassT: f9.stages[0].fuelMassT, oxidMassT: f9.stages[0].oxidMassT,
			thrustForceN: f9.stages[0].maxThrustN, burnTime: f9.stages[0].burnTime,
			stages: f9.stages, payload: f9.payload, fairing: f9.fairing, flightProfile: F9_PROFILE
		},
		options: { maxSimTime: 1200 }
	};
}

describe('Unit 07: trajectory predictor sampler, end reasons, budgets, frame switch, rendering', () => {

	describe('End reasons (§4.3 table) and their exact conditions', () => {
		it('horizon: the requested period is integrated and the final point is at maxSimTime', () => {
			const res = coast({ maxSimTime: 600 });
			assertResultContract(res, 'horizon');
			assert.equal(res.endReason, 'horizon');
			const last = res.points.at(-1);
			assert.ok(Math.abs(last.time - 600) <= 0.01, `final point ${last.time} must be at the requested 600 s`);
			assert.ok(res.steps < TP.MAX_STEPS, 'horizon must be reached before the step budget');
			assert.ok(res.points.length < TP.MAX_POINTS, 'horizon must be reached before the point budget');
		});

		it('horizon boundary: a remaining step of 0.01 s or less is not integrated, just above it is', () => {
			const none = coast({ maxSimTime: 0.01 });
			assert.equal(none.endReason, 'horizon');
			assert.equal(none.points.length, 1, 'only the initial point exists');
			assert.equal(none.maxSimTime, 0);
			assert.equal(none.steps, 0, 'steps counts integration steps only: the 0.01 s remainder is not one');

			const one = coast({ maxSimTime: 0.0101 });
			assertResultContract(one, 'horizon 0.0101');
			assert.equal(one.endReason, 'horizon');
			assert.equal(one.points.length, 2);
			assert.equal(one.points[1].time, 0.0101);
			assert.equal(one.maxSimTime, 0.0101);
			assert.equal(one.steps, 1);
		});

		it('impact on the host: terminates at the surface with one IMPACT event at the final point', () => {
			const res = simulate({ rocket: { x: RE + 100e3 }, options: { maxSimTime: 3600 } });
			assertResultContract(res, 'impact');
			assert.equal(res.endReason, 'impact');
			const ev = impactEvents(res);
			assert.equal(ev.length, 1);
			const impactRule = DEFAULT_FLIGHT_EVENTS.find(r => r.type === 'impact');
			assert.equal(ev[0].id, impactRule.id);
			assert.equal(ev[0].name, 'IMPACT');
			const last = res.points.at(-1);
			assert.equal(ev[0].time, last.time, 'impact event and the single final point share the time');
			assert.equal(ev[0].relX, last.relX);
			assert.equal(ev[0].relY, last.relY);
			assert.ok(last.altM <= 2, `final point (alt ${last.altM} m) must be at or below the surface plus the probe radius`);
			assert.ok(res.maxSimTime < 3600, 'the line ends at the impact, not at the requested period');
		});

		it('impact uses the rule id of a custom impact event definition', () => {
			const defs = [{ id: 'splash', name: 'SPLASH', type: 'impact', enabled: true }];
			const res = simulate({ rocket: { x: RE + 100e3 }, options: { maxSimTime: 3600 }, eventDefinitions: defs });
			assert.equal(res.endReason, 'impact');
			assert.deepEqual(res.events.map(e => e.id), ['splash']);
			assert.equal(res.events[0].name, 'IMPACT');
		});

		it('impact boundary: a surface crossing is not declared until simTime exceeds IMPACT_MIN_TIME_S', () => {
			// Dropped from 10 m the probe is below the surface after ~1.4 s, but impact may only end the run after 5 s.
			const res = simulate({ rocket: { x: RE + 10 }, options: { maxSimTime: 600 } });
			assert.equal(res.endReason, 'impact');
			const ev = impactEvents(res)[0];
			assert.ok(ev.time > TP.EVENTS.IMPACT_MIN_TIME_S, `impact at ${ev.time} s must be after IMPACT_MIN_TIME_S`);
			assert.ok(ev.time <= TP.EVENTS.IMPACT_MIN_TIME_S + TP.DT.SURFACE_CLOSE + 1e-9, `impact at ${ev.time} s must be the first step after IMPACT_MIN_TIME_S`);
		});

		it('impact on another body: event id impact_<id> and name IMPACT: <name>', () => {
			const rock = { id: 2, name: 'Rock', x: 1e8, y: 0, vx: 0, vy: 0, massKg: 7.35e22, radius: 1737e3, param: {} };
			const res = simulate({ host: { massKg: 0 }, rocket: { x: 1e8 + 1737e3 + 100e3 }, extraBodies: [rock], options: { maxSimTime: 3600 } });
			assertResultContract(res, 'impact other');
			assert.equal(res.endReason, 'impact');
			const ev = impactEvents(res);
			assert.equal(ev.length, 1);
			assert.equal(ev[0].id, 'impact_2');
			assert.equal(ev[0].name, 'IMPACT: Rock');
		});

		it('impact after orbit insertion is reported (the orbit-time impact suppression is removed, §4.11)', () => {
			const r0 = RE + 400e3;
			const res = simulate({ rocket: { x: r0, vy: 0.96 * vCirc(r0) }, options: { maxSimTime: 20000 } });
			assertResultContract(res, 'orbit then impact');
			assert.equal(res.isOrbital, true, 'the orbit criterion is met at the first step');
			assert.ok(res.events.some(e => e.id === 'orbit'));
			assert.equal(res.endReason, 'impact');
			assert.equal(impactEvents(res).length, 1);
		});

		it('breakup: terminates at the destruction point with one BREAKUP event and one final point there (§4.11)', () => {
			const stages = [{ ...COAST_STAGES[0], dryMassT: 20 }];
			const res = simulate({
				host: { param: EARTH_LIKE_ATM },
				rocket: { name: 'Rocket', x: RE + 120e3, vx: -200, vy: 7800, dryMassT: 20, stages },
				options: { maxSimTime: 3600 }
			});
			assertResultContract(res, 'breakup');
			assert.equal(res.endReason, 'breakup');
			const ev = breakupEvents(res);
			assert.equal(ev.length, 1);
			assert.equal(ev[0].name, 'BREAKUP');
			assert.equal(ev[0].type, 'impact');
			const last = res.points.at(-1);
			assert.equal(last.time, ev[0].time, 'final point is emitted at the breakup time');
			assert.equal(last.relX, ev[0].relX);
			assert.equal(last.relY, ev[0].relY);
			assert.equal(res.points.filter(p => p.relX === last.relX && p.relY === last.relY).length, 1, 'the breakup position is emitted exactly once');
			assert.ok(last.altM > 0 && last.altM < EARTH_LIKE_ATM.ATM_LIMIT_ALT, 'breakup happens inside the atmosphere');
		});

		it('breakup boundary: a vehicle already over its load limit at t=0 yields a single point and maxSimTime 0', () => {
			const res = simulate({
				host: { param: EARTH_LIKE_ATM },
				rocket: { name: 'Rocket', x: RE + 20e3, vy: 3000 },
				options: { maxSimTime: 3600 }
			});
			assert.equal(res.endReason, 'breakup');
			assert.equal(res.points.length, 1);
			assert.equal(res.maxSimTime, 0);
			assert.equal(breakupEvents(res).length, 1);
			// The condition holds at t = 0: the event is at the initial point and no integration step is taken
			const ev = breakupEvents(res)[0];
			assert.equal(ev.time, 0, 'breakup at the time the condition held');
			assert.equal(ev.relX, res.points[0].relX);
			assert.equal(ev.relY, res.points[0].relY);
			assert.equal(res.steps, 0);
			const host = { id: 1, x: 0, y: 0, rotationAngle: 0 };
			assert.equal(render(res, host, { mode: 'preview' }).saves, 0, 'a single point is never drawn');
		});

		it('point_budget: the run stops at exactly maxPoints points', () => {
			const res = coast({ maxSimTime: 0.2 * MONTH_S, maxPoints: 50 });
			assertResultContract(res, 'point_budget');
			assert.equal(res.endReason, 'point_budget');
			assert.equal(res.points.length, 50);
			assert.ok(res.maxSimTime < 0.2 * MONTH_S);
		});

		it('step_budget: the run stops at exactly the step budget', () => {
			const res = coast({ maxSimTime: 0.2 * MONTH_S });
			assertResultContract(res, 'step_budget');
			assert.equal(res.endReason, 'step_budget');
			assert.equal(res.steps, TP.MAX_STEPS);
			assert.ok(res.maxSimTime < 0.2 * MONTH_S, 'validity is claimed only up to the integrated time');
		});

		it('no_host: zero points, maxSimTime 0, steps 0 for every way the host can be missing', () => {
			const body = { id: 1, name: 'TestHost', x: 0, y: 0, vx: 0, vy: 0, massKg: ME, radius: RE };
			const expected = (hostId) => ({
				hostId, points: [], events: [], isOrbital: false, maxSimTime: 0, maxAltM: 0, maxQ: 0,
				endReason: 'no_host', steps: 0, frameSwitchTime: null, frameSwitchHostRot: null, hostOmega: 0
			});
			const cases = [
				['unknown id', { hostId: 42, celestialBodies: [body] }, 42],
				['empty body list', { hostId: 1, celestialBodies: [] }, 1],
				['body list omitted', { hostId: 1 }, 1],
				['undefined id', { hostId: undefined, celestialBodies: [body] }, undefined],
				['null id', { hostId: null, celestialBodies: [body] }, null],
				['NaN id', { hostId: NaN, celestialBodies: [body] }, NaN]
			];
			for (const [label, args, hostId] of cases) {
				const res = runMultiBodySimulation({ ...args, rocketConfig: undefined, options: { maxSimTime: 600 } });
				assert.deepStrictEqual(res, expected(hostId), label);
			}
		});
	});

	describe('maxSimTime is always the final point time (§4.3, G2-4-01/G2-6-01)', () => {
		it('horizon with no displacement after the last sample: maxSimTime stays at the last sample, not the request', () => {
			// Massless host: the probe never moves, so no final point is appended and the run claims only what was sampled.
			const res = simulate({ host: { massKg: 0 }, rocket: { x: 2e7 }, options: { maxSimTime: 7200 } });
			assertResultContract(res, 'static');
			assert.equal(res.endReason, 'horizon');
			assert.ok(res.maxSimTime < 7200 && res.maxSimTime > 7200 - SP.TIME_COAST_S, `maxSimTime ${res.maxSimTime} is the last coast sample before the request`);
			assert.equal(res.maxSimTime, res.points.at(-1).time);
		});

		it('every end reason fixture reports maxSimTime equal to its final point time', () => {
			const fixtures = [
				coast({ maxSimTime: 600 }),
				coast({ maxSimTime: 0.2 * MONTH_S, maxPoints: 80 }),
				coast({ maxSimTime: 0.2 * MONTH_S }),
				simulate({ rocket: { x: RE + 100e3 }, options: { maxSimTime: 3600 } })
			];
			for (const res of fixtures) {
				assertResultContract(res, res.endReason);
				assert.equal(res.maxSimTime, res.points.at(-1).time);
			}
		});
	});

	describe('Budgets (§4.3 table, §4.12)', () => {
		it('step budget formula: 0.2 months -> 120,000, 0.3 months -> 157,788, 1 month and longer -> 340,000', () => {
			const cases = [
				['0.2 months', 0.2 * MONTH_S, 120000],
				['0.3 months', 0.3 * MONTH_S, 157788],
				['1 month', MONTH_S, 340000],
				['36 months', 36 * MONTH_S, 340000]
			];
			for (const [label, maxSimTime, expected] of cases) {
				assert.equal(stepBudget(maxSimTime), expected, `${label}: design formula`);
				const res = coast({ maxSimTime });
				assert.equal(res.endReason, 'step_budget', label);
				assert.equal(res.steps, expected, label);
			}
		});

		it('step budget boundaries: MAX_STEPS floor (600,000 s) and MAX_STEPS_CAP (1,700,000 s)', () => {
			const cases = [[600000, 120000], [600005, 120001], [1699995, 339999], [1700000, 340000], [1700005, 340000]];
			for (const [maxSimTime, expected] of cases) {
				assert.equal(stepBudget(maxSimTime), expected);
				const res = coast({ maxSimTime });
				assert.equal(res.endReason, 'step_budget', `${maxSimTime} s`);
				assert.equal(res.steps, expected, `${maxSimTime} s`);
			}
		});

		it('requested period 0 or missing falls back to the 1-year default (Gate 2 Iteration 8 Watchpoint 6)', () => {
			for (const options of [{ maxSimTime: 0 }, {}]) {
				const res = coast(options);
				assert.equal(res.endReason, 'step_budget');
				assert.equal(res.steps, stepBudget(TP.MAX_SIM_TIME_SEC));
			}
		});

		it('options.maxSteps only raises the floor and never exceeds MAX_STEPS_CAP (normal, abnormal, boundary)', () => {
			const T = 0.2 * MONTH_S; // computed budget 120,000
			const cases = [
				[undefined, 120000], [null, 120000],
				[119999, 120000], [120001, 120001], [339999, 339999], [340000, 340000], [340001, 340000], [1e9, 340000]
			];
			for (const [maxSteps, expected] of cases) {
				const res = coast({ maxSimTime: T, maxSteps });
				assertResultContract(res, `maxSteps ${maxSteps}`);
				assert.equal(res.steps, expected, `maxSteps ${maxSteps}`);
				assert.equal(res.endReason, 'step_budget', `maxSteps ${maxSteps}`);
			}
		});

		it('options.maxSteps: Number(value) is used only when > 0, anything else is ignored (Rev 6.10, direct call)', () => {
			const T = 0.2 * MONTH_S;
			const reference = coast({ maxSimTime: T });
			assert.equal(reference.steps, 120000);
			for (const [label, value, steps] of ABNORMAL_BUDGET_OPTIONS) {
				assert.equal(ruleStepBudget(value, T), steps, `${label}: table follows the §4.12 rule`);
				const res = coast({ maxSimTime: T, maxSteps: value });
				assertResultContract(res, `maxSteps ${label}`);
				assert.equal(res.endReason, 'step_budget', `maxSteps ${label}`);
				assert.equal(res.steps, steps, `maxSteps ${label}`);
				if (steps === reference.steps) {
					assert.deepStrictEqual(res, reference, `maxSteps ${label}: the normal budget results`);
				}
			}
			// Numeric strings above the floor raise it, never beyond the cap
			assert.equal(coast({ maxSimTime: T, maxSteps: '200000' }).steps, 200000);
			assert.equal(coast({ maxSimTime: T, maxSteps: '340001' }).steps, TP.MAX_STEPS_CAP);
		});

		it('options.maxPoints only lowers MAX_POINTS (normal, abnormal, boundary; G2-8-01)', () => {
			const natural = longBurn({});
			assertResultContract(natural, 'long burn');
			assert.equal(natural.endReason, 'point_budget');
			assert.equal(natural.points.length, TP.MAX_POINTS, 'the fixture naturally reaches MAX_POINTS');

			const cases = [
				[undefined, 3000], [null, 3000], [1e9, 3000], [3001, 3000], [3000, 3000], [2999, 2999], [2, 2], [1, 1]
			];
			for (const [maxPoints, expected] of cases) {
				const res = longBurn({ maxPoints });
				assertResultContract(res, `maxPoints ${maxPoints}`);
				assert.equal(res.endReason, 'point_budget', `maxPoints ${maxPoints}`);
				assert.equal(res.points.length, expected, `maxPoints ${maxPoints}`);
			}
			assert.equal(longBurn({ maxPoints: 1 }).steps, 0, 'a single-point budget is spent by the initial point');
		});

		it('options.maxPoints: Number(value) is used only when > 0, anything else is ignored (Rev 6.10, direct call)', () => {
			const reference = longBurn({});
			for (const [label, value, , points] of ABNORMAL_BUDGET_OPTIONS) {
				assert.equal(rulePointBudget(value), points, `${label}: table follows the §4.12 rule`);
				const res = longBurn({ maxPoints: value });
				assertResultContract(res, `maxPoints ${label}`);
				assert.equal(res.endReason, 'point_budget', `maxPoints ${label}`);
				assert.equal(res.points.length, points, `maxPoints ${label}`);
				if (points === TP.MAX_POINTS) {
					assert.deepStrictEqual(res, reference, `maxPoints ${label}: the normal budget results`);
				}
			}
			assert.equal(longBurn({ maxPoints: true }).steps, 0, 'true counts as 1: the initial point spends the budget');
		});

		it('both options follow the same rule through TrajectoryPredictor.calculateSync (Rev 6.10)', () => {
			const tp = new TrajectoryPredictor(null);
			const T = 0.2 * MONTH_S;
			const coastCfg = predictorConfig({ maxSimTime: T }).config;
			const burnCfg = predictorConfig({ maxSimTime: 20000, burn: true }).config;
			const coastRef = tp.calculateSync(coastCfg);
			const burnRef = tp.calculateSync(burnCfg);
			assert.equal(coastRef.steps, 120000);
			assert.equal(burnRef.points.length, TP.MAX_POINTS);
			for (const [label, value, steps, points] of ABNORMAL_BUDGET_OPTIONS) {
				const s1 = tp.calculateSync({ ...coastCfg, maxSteps: value });
				assertResultContract(s1, `calculateSync maxSteps ${label}`);
				assert.equal(s1.endReason, 'step_budget', `calculateSync maxSteps ${label}`);
				assert.equal(s1.steps, steps, `calculateSync maxSteps ${label}`);
				if (steps === coastRef.steps) { assert.deepStrictEqual(s1, coastRef, `calculateSync maxSteps ${label}`); }
				const s2 = tp.calculateSync({ ...burnCfg, maxPoints: value });
				assertResultContract(s2, `calculateSync maxPoints ${label}`);
				assert.equal(s2.endReason, 'point_budget', `calculateSync maxPoints ${label}`);
				assert.equal(s2.points.length, points, `calculateSync maxPoints ${label}`);
				if (points === TP.MAX_POINTS) { assert.deepStrictEqual(s2, burnRef, `calculateSync maxPoints ${label}`); }
			}
		});
	});

	describe('Apsis passage is a strict sign crossing of the radial velocity (§4.3)', () => {
		it('0 -> 0 does not sample: with exactly zero radial velocity only the coast timer emits samples', () => {
			const res = simulate({ host: { massKg: 0 }, rocket: { x: 2e7 }, options: { maxSimTime: 7200 } });
			assertResultContract(res, 'static');
			const relX0 = res.points[0].relX;
			assert.ok(res.points.every(p => p.relX === relX0 && p.relY === 0), 'the probe is at rest relative to the host');
			const coastPts = res.points.filter(p => p.time > SP.LIFTOFF_PHASE_TIME_S);
			const lastLiftoff = res.points.filter(p => p.time <= SP.LIFTOFF_PHASE_TIME_S).at(-1);
			assert.equal(coastPts.length, Math.floor((7200 - lastLiftoff.time) / SP.TIME_COAST_S), 'one sample per TIME_COAST_S');
			let prev = lastLiftoff.time;
			for (const p of coastPts) {
				assert.ok(p.time - prev >= SP.TIME_COAST_S, `gap ${p.time - prev} s: no apsidal sample every ${SP.TIME_APSIDAL_COAST_S} s`);
				prev = p.time;
			}
			assert.ok(!res.events.some(e => e.id === 'ap'), 'no apoapsis event without a crossing');
		});

		it('a real apoapsis crossing is sampled between the regular near-body samples', () => {
			const r0 = RE + 400e3;
			const res = simulate({ rocket: { x: r0, vy: 1.15 * vCirc(r0) }, options: { maxSimTime: 40000 } });
			const ap = res.events.find(e => e.id === 'ap');
			assert.ok(ap, 'the eccentric orbit passes apoapsis');
			const idx = res.points.findIndex(p => p.time === ap.time);
			assert.ok(idx > 0, 'a sample is emitted at the crossing step');
			const gap = ap.time - res.points[idx - 1].time;
			assert.ok(gap >= SP.TIME_APSIDAL_COAST_S && gap < SP.TIME_NEAR_BODY_S, `apsidal sample ${gap} s after the previous one`);
		});
	});

	describe('MAX_ANGLE_STEP_RAD is enforced in the drawn frame (§4.3)', () => {
		const rotatingHost = { massKg: 0, param: { ROTATION_PERIOD: 3600 } };

		it('before the switch the host-fixed angle is capped although the inertial angle never changes', () => {
			const res = simulate({ host: rotatingHost, rocket: { x: RE + 50e3 }, options: { maxSimTime: 20000 } });
			assertResultContract(res, 'host-fixed cap');
			assert.equal(res.frameSwitchTime, null, 'below the atmosphere limit the line stays host-fixed');
			assert.equal(new Set(res.points.map(inertialAngle)).size, 1, 'inertial angle is constant');
			const post = res.points.filter(p => p.time > SP.LIFTOFF_PHASE_TIME_S);
			assert.ok(post.length > 100);
			for (let i = 1; i < post.length; i++) {
				const d = Math.abs(normAngle(post[i].phiSurf - post[i - 1].phiSurf));
				assert.ok(d >= SP.MAX_ANGLE_STEP_RAD && d <= 0.15, `host-fixed step ${d} rad must be sampled at the cap`);
			}
			const host = { id: 1, x: 0, y: 0, rotationAngle: 0.3 };
			const drawn = maxDrawnStep(render(res, host, { mode: 'preview' }, { zoom: 1e9 }));
			assert.ok(drawn >= SP.MAX_ANGLE_STEP_RAD && drawn <= 0.15, `drawn step ${drawn} rad stays within the guarantee 1 threshold`);
		});

		it('the cap overrides budget thinning: the point budget runs out instead of aliasing into chords', () => {
			const res = simulate({ host: rotatingHost, rocket: { x: RE + 50e3 }, options: { maxSimTime: 20000, maxPoints: 200 } });
			assertResultContract(res, 'cap vs budget');
			assert.equal(res.endReason, 'point_budget');
			assert.equal(res.points.length, 200);
			const post = res.points.filter(p => p.time > SP.LIFTOFF_PHASE_TIME_S);
			for (let i = 1; i < post.length; i++) {
				const d = Math.abs(normAngle(post[i].phiSurf - post[i - 1].phiSurf));
				assert.ok(d >= SP.MAX_ANGLE_STEP_RAD && d <= 0.15, `step ${d} rad stays at the cap while thinning is active`);
			}
		});

		it('after the switch only the inertial angle counts: host-fixed jumps no longer force samples', () => {
			const res = simulate({ host: rotatingHost, rocket: { x: RE + 200e3 }, options: { maxSimTime: 20000 } });
			assertResultContract(res, 'inertial cap');
			assert.equal(res.frameSwitchTime, res.points[1].time, 'switch at the first sample (above the atmosphere and unbound from the massless host)');
			const post = res.points.filter(p => p.time > SP.LIFTOFF_PHASE_TIME_S);
			assert.ok(post.length >= 2);
			for (let i = 1; i < post.length; i++) {
				assert.ok(post[i].time - post[i - 1].time >= SP.TIME_COAST_S, 'only the coast timer samples');
				assert.ok(Math.abs(normAngle(post[i].phiSurf - post[i - 1].phiSurf)) > SP.MAX_ANGLE_STEP_RAD, 'host-fixed angle is not capped');
				assert.equal(inertialAngle(post[i]), inertialAngle(post[i - 1]), 'inertial (drawn) angle is unchanged');
			}
		});
	});

	describe('Burn boundary sampling (§3.1.2)', () => {
		it('the step where the burn ends is sampled off the TIME_POWERED_S grid', () => {
			const r0 = RE + 400e3;
			const stages = [{ thrustKN: 1, fuelMassT: 0.5, oxidMassT: 0.5, burnTime: 30.03, dryMassT: 1, ispVac: 300 }];
			const res = simulate({
				rocket: { x: r0, vy: vCirc(r0), stages, burnTime: 30.03, fuelMassT: 0.5, oxidMassT: 0.5, thrustForceN: 1000, disableOrbitalCutoff: true },
				options: { maxSimTime: 300 }
			});
			assertResultContract(res, 'burn edge');
			const meco = res.events.find(e => e.id === 'meco');
			assert.ok(meco && meco.time > SP.LIFTOFF_PHASE_TIME_S, 'the burn ends after the liftoff phase');
			const idx = res.points.findIndex(p => p.time === meco.time);
			assert.ok(idx > 0, 'a sample is emitted at the burn end');
			const gap = meco.time - res.points[idx - 1].time;
			assert.ok(gap >= SP.MIN_SAMPLE_DT_S && gap < SP.TIME_POWERED_S, `burn-edge sample ${gap} s after the previous powered sample`);
		});
	});

	describe('Single final point and its dedupe (§3.1.2)', () => {
		// Massless host and a radially moving probe: one 0.03 s step (below MIN_SAMPLE_DT_S, so no regular sample),
		// then the final point is appended only if it moved at least sqrt(1e-4 m^2) = 1 cm.
		const finalOnly = (dispM) => simulate({ host: { massKg: 0 }, rocket: { x: RE + 200e3, vx: dispM / 0.03 }, options: { maxSimTime: 0.03 } });

		it('displacement boundary 1e-4 m^2: 0 m and 0.99 cm are dropped, 1.01 cm is appended', () => {
			assert.equal(SP.MIN_SAMPLE_DISPLACEMENT_M_SQ, 1e-4);
			for (const d of [0, 0.0099]) {
				const res = finalOnly(d);
				assert.equal(res.endReason, 'horizon');
				assert.equal(res.points.length, 1, `displacement ${d} m`);
				assert.equal(res.maxSimTime, 0);
			}
			const res = finalOnly(0.0101);
			assert.equal(res.points.length, 2);
			assert.equal(res.points[1].time, 0.03);
			const dispM = UnitConvertUtils.pix2m(res.points[1].relX - res.points[0].relX);
			assert.ok(Math.abs(dispM - 0.0101) < 1e-6, `appended point moved ${dispM} m`);
		});

		it('time boundary: a run that ends on an emitted sample appends no duplicate', () => {
			const budget = coast({ maxSimTime: 0.2 * MONTH_S, maxPoints: 30 });
			assert.equal(budget.points.length, 30);
			assert.ok(budget.points.at(-1).time > budget.points.at(-2).time);
			const sw = simulate({ host: { param: { ROTATION_PERIOD: 86164 } }, rocket: { x: RE + 200e3, vx: 1.2 * vEsc(RE + 200e3) }, options: { maxSimTime: 0.05 } });
			assert.deepEqual(sw.points.map(p => p.time), [0, 0.05], 'the switch sample at the last step is the final point');
		});
	});

	describe('Frame switch conditions (§4.10)', () => {
		const escape = (startAltM, factor, extra = {}) => simulate({
			...extra,
			rocket: { x: RE + startAltM, vx: factor * vEsc(RE + startAltM) },
			options: { maxSimTime: 30000, ...(extra.options || {}) }
		});

		it('orbit insertion: the switch is the sample at the orbit event step and carries the host rotation', () => {
			const args = falconAscentArgs(0.7);
			const res = runMultiBodySimulation(args);
			assertResultContract(res, 'falcon ascent');
			const orbit = res.events.find(e => e.id === 'orbit');
			assert.ok(orbit, 'the ascent reaches orbit');
			const prev = res.points.filter(p => p.time < orbit.time).at(-1);
			const expectedSwitch = (orbit.time - prev.time >= SP.MIN_SAMPLE_DT_S) ? orbit.time : prev.time;
			assert.equal(res.frameSwitchTime, expectedSwitch);
			assert.ok(res.points.some(p => p.time === res.frameSwitchTime), 'the switch time is a sample time');
			const omega = 2 * Math.PI / args.celestialBodies[0].param.ROTATION_PERIOD;
			assert.equal(res.hostOmega, omega);
			assert.equal(res.frameSwitchHostRot, 0.7 + omega * res.frameSwitchTime);
		});

		it('escaping above the default atmosphere limit (ORBIT_MIN_ALT_M) switches without orbit insertion', () => {
			const res = escape(50e3, 1.2);
			assertResultContract(res, 'escape from 50 km');
			assert.ok(!res.events.some(e => e.id === 'orbit'), 'radial escape never meets the orbit criterion');
			const limit = TP.EVENTS.ORBIT_MIN_ALT_M;
			const first = res.points.find(p => p.altM > limit);
			assert.equal(res.frameSwitchTime, first.time);
			assert.ok(res.points.filter(p => p.time < first.time).every(p => p.altM <= limit), 'no switch below the limit');
		});

		it('the host ATM_LIMIT_ALT replaces the default limit', () => {
			const atm300 = { ...EARTH_LIKE_ATM, ATM_LIMIT_ALT: 300000 };
			const res = escape(200e3, 1.2, { host: { param: atm300 }, options: { maxSimTime: 600 } });
			assertResultContract(res, 'escape with ATM 300 km');
			const first = res.points.find(p => p.altM > 300000);
			assert.equal(res.frameSwitchTime, first.time);
			assert.ok(res.points.filter(p => p.time < first.time).every(p => p.altM <= 300000));
		});

		it('E >= 0 boundary: just above escape speed switches at once, just below waits for MAX_HOST_FIXED_ALT_M', () => {
			const above = escape(200e3, 1.0005);
			assert.equal(above.frameSwitchTime, above.points[1].time, 'E > 0 above the limit switches at the first sample');
			const below = escape(200e3, 0.9995);
			assertResultContract(below, 'E < 0');
			const maxAlt = TP.FRAME_SWITCH.MAX_HOST_FIXED_ALT_M;
			const i = below.points.findIndex(p => p.altM >= maxAlt);
			assert.ok(i > 0, 'the bound trajectory climbs past MAX_HOST_FIXED_ALT_M');
			assert.equal(below.frameSwitchTime, below.points[i].time);
			assert.ok(below.points[i - 1].altM < maxAlt);
		});

		it('MAX_HOST_FIXED_ALT_M switches a bound trajectory; one that stays below never switches', () => {
			const high = escape(200e3, 0.995, { options: { maxSimTime: 86400 } });
			const maxAlt = TP.FRAME_SWITCH.MAX_HOST_FIXED_ALT_M;
			const i = high.points.findIndex(p => p.altM >= maxAlt);
			assert.equal(high.frameSwitchTime, high.points[i].time);
			assert.ok(high.points[i - 1].altM < maxAlt);

			const low = escape(200e3, 0.9, { options: { maxSimTime: 86400 } });
			assertResultContract(low, 'apex below 50,000 km');
			assert.ok(low.maxAltM < maxAlt);
			assert.equal(low.frameSwitchTime, null);
			assert.equal(low.frameSwitchHostRot, null);
			assert.equal(low.endReason, 'impact');
		});

		it('MIN_SAMPLE_DT_S fallback: a sample less than 0.05 s old becomes the switch point (boundary 0.0499/0.05/0.0501)', () => {
			const run = (maxSimTime) => escape(200e3, 1.2, { host: { rotationAngle: 1.234, param: { ROTATION_PERIOD: 86164 } }, options: { maxSimTime } });
			const omega = 2 * Math.PI / 86164;
			for (const T of [0.03, 0.0499]) {
				const res = run(T);
				assertResultContract(res, `fallback ${T}`);
				assert.equal(res.frameSwitchTime, 0, `${T} s: the initial sample is the switch point`);
				assert.equal(res.frameSwitchHostRot, 1.234);
				assert.deepEqual(res.points.map(p => p.time), [0, T], 'the final point is drawn after the switch');
			}
			for (const T of [0.05, 0.0501]) {
				const res = run(T);
				assert.equal(res.frameSwitchTime, T, `${T} s: a new sample is emitted as the switch point`);
				assert.equal(res.frameSwitchHostRot, 1.234 + omega * T);
			}
		});

		it('hostOmega comes from the host parameter, else the body rotationPeriod, else 0', () => {
			const r0 = RE + 400e3;
			const base = { rocket: { x: r0, vy: vCirc(r0) }, options: { maxSimTime: 60 } };
			assert.equal(simulate({ ...base, host: { param: { ROTATION_PERIOD: 3600 } } }).hostOmega, 2 * Math.PI / 3600);
			assert.equal(simulate({ ...base, host: { param: null, rotationPeriod: 7200 } }).hostOmega, 2 * Math.PI / 7200);
			assert.equal(simulate({ ...base, host: { param: { ROTATION_PERIOD: 0 } } }).hostOmega, 0);
		});
	});

	describe('renderTrajectory projection (§4.10)', () => {
		const HOST = { id: 7, x: 5, y: -3, rotationAngle: 0.9 };
		const BASIS = { x: 4, y: -1 };
		const ZOOM = 50;
		const POINTS = [
			{ time: 0, r: 2.0, phiSurf: 0.10, relX: 9, relY: 9, altM: 0 },
			{ time: 10, r: 2.2, phiSurf: 0.25, relX: 9, relY: 9, altM: 1 },
			{ time: 20, r: 2.5, phiSurf: 0.40, relX: 9, relY: 9, altM: 2 },
			{ time: 30, r: 3.0, phiSurf: 9, relX: 1.0, relY: 2.5, altM: 3 },
			{ time: 40, r: 3.5, phiSurf: 9, relX: -1.2, relY: 3.1, altM: 4 }
		];
		const pred = (over = {}) => ({
			hostId: 7, points: POINTS, events: [], maxSimTime: 40,
			frameSwitchTime: 20, frameSwitchHostRot: 0.6, hostOmega: 0.01, ...over
		});
		const toScreen = (x, y, host = HOST) => [((host.x - BASIS.x) + x) * ZOOM, ((host.y - BASIS.y) + y) * ZOOM];
		const hostFixed = (p, ref, host) => toScreen(p.r * Math.cos(p.phiSurf + ref), p.r * Math.sin(p.phiSurf + ref), host);
		const inertial = (p, off, host) => toScreen(p.relX * Math.cos(off) - p.relY * Math.sin(off), p.relX * Math.sin(off) + p.relY * Math.cos(off), host);
		const draw = (prediction, options, host = HOST) => render(prediction, host, options, { basis: BASIS, zoom: ZOOM });

		function expectProjection(prediction, options, frameRefRot, label, host = HOST) {
			const v = draw(prediction, options, host).predictedVertices();
			assert.equal(v.length, POINTS.length, `${label}: every point is drawn`);
			const tsw = Number.isFinite(prediction.frameSwitchTime) ? prediction.frameSwitchTime : Infinity;
			POINTS.forEach((p, i) => {
				const exp = p.time > tsw
					? inertial(p, frameRefRot - (prediction.frameSwitchHostRot || 0), host)
					: hostFixed(p, frameRefRot, host);
				assertVertex(v[i], exp, `${label} point ${i}`);
			});
		}

		it('preview: host-fixed up to and including the switch point, inertial rotated by host rot - frameSwitchHostRot after it', () => {
			expectProjection(pred(), { mode: 'preview' }, HOST.rotationAngle, 'preview');
		});

		it('flight after the switch: the reference rotation is frozen at host rot - omega * (t - frameSwitchTime)', () => {
			expectProjection(pred(), { mode: 'flight', currentFlightTime: 25 }, 0.9 - 0.01 * 5, 'flight 25 s');
		});

		it('flight before the switch: the whole line rotates rigidly with the host (max(0, t - tsw) = 0)', () => {
			expectProjection(pred(), { mode: 'flight', currentFlightTime: 10 }, 0.9, 'flight 10 s');
		});

		it('flight after the switch stays fixed in space while the host keeps rotating', () => {
			const at = (t) => draw(pred(), { mode: 'flight', currentFlightTime: t }, { ...HOST, rotationAngle: 0.9 + 0.01 * (t - 25) }).predictedVertices();
			const a = at(25);
			const b = at(38);
			a.forEach((pt, i) => assertVertex(b[i], pt, `frozen vertex ${i}`));
		});

		it('no switch (null, undefined, NaN, Infinity): every point is host-fixed, also in flight', () => {
			for (const frameSwitchTime of [null, undefined, NaN, Infinity]) {
				expectProjection(pred({ frameSwitchTime }), { mode: 'flight', currentFlightTime: 30 }, HOST.rotationAngle, `switch ${frameSwitchTime}`);
			}
		});

		it('abnormal hostOmega (NaN, undefined) is treated as 0 and a missing frameSwitchHostRot as 0', () => {
			for (const hostOmega of [NaN, undefined]) {
				expectProjection(pred({ hostOmega }), { mode: 'flight', currentFlightTime: 30 }, HOST.rotationAngle, `omega ${hostOmega}`);
			}
			expectProjection(pred({ frameSwitchHostRot: null }), { mode: 'preview' }, HOST.rotationAngle, 'null switch rotation');
		});

		it('legacy points without r/phiSurf rotate by options.rotationOffset', () => {
			const legacy = { hostId: 7, points: [{ relX: 1, relY: 0, time: 0 }, { relX: 0, relY: 2, time: 10 }], events: [], maxSimTime: 10 };
			const v0 = draw(legacy, { mode: 'preview' }).predictedVertices();
			assertVertex(v0[0], toScreen(1, 0), 'no offset');
			assertVertex(v0[1], toScreen(0, 2), 'no offset');
			const v1 = draw(legacy, { mode: 'preview', rotationOffset: Math.PI / 2 }).predictedVertices();
			assertVertex(v1[0], toScreen(0, 1), 'offset pi/2');
			assertVertex(v1[1], toScreen(-2, 0), 'offset pi/2');
		});

		it('event markers follow the same rule by ev.time', () => {
			const events = [
				{ id: 'pitch', name: 'PITCH', type: 'pitch', time: 10, r: 2.2, phiSurf: 0.25, relX: 9, relY: 9 },
				{ id: 'orbit', name: 'ORBIT', type: 'orbit', time: 30, r: 3.0, phiSurf: 9, relX: 1.0, relY: 2.5 }
			];
			const ctx = draw(pred({ events }), { mode: 'flight', currentFlightTime: 25 });
			const markers = ctx.arcs.filter(a => a.r === RENDER.PREDICTED_TRAJECTORY.EVENT_RADIUS);
			assert.equal(markers.length, 2);
			assertVertex([markers[0].x, markers[0].y], hostFixed(events[0], 0.85), 'pre-switch marker');
			assertVertex([markers[1].x, markers[1].y], inertial(events[1], 0.85 - 0.6), 'post-switch marker');
		});

		it('actual flight path: points recorded after the switch are drawn at their raw inertial offset', () => {
			const actual = [
				{ time: 5, r: 2.1, phiSurf: 0.2, relX: 9, relY: 9 },
				{ time: 30, r: 9, phiSurf: 9, relX: 1.5, relY: 2.0 }
			];
			const ctx = draw(pred(), { mode: 'flight', currentFlightTime: 25, actualFlightPath: actual, rocketX: HOST.x + 1.6, rocketY: HOST.y + 2.1 });
			const v = ctx.solidPathVertices();
			assertVertex(v[0], hostFixed(actual[0], 0.85), 'pre-switch actual point');
			assertVertex(v[1], toScreen(1.5, 2.0), 'post-switch actual point is not rotated');
			assertVertex(v[2], toScreen(1.6, 2.1), 'the rocket position closes the actual path');
		});

		it('nothing is drawn for a missing prediction, fewer than two points or an unknown host', () => {
			assert.equal(draw(null, { mode: 'preview' }).saves, 0);
			assert.equal(draw({ ...pred(), points: [] }, { mode: 'preview' }).saves, 0);
			assert.equal(draw({ ...pred(), points: POINTS.slice(0, 1) }, { mode: 'preview' }).saves, 0);
			assert.equal(draw({ ...pred(), hostId: 99 }, { mode: 'preview' }).saves, 0);
		});

		it('a real prediction is continuous at the switch point and has the same drawn shape in preview and flight', () => {
			const res = runMultiBodySimulation(falconAscentArgs(0.7));
			const sw = res.points.find(p => p.time === res.frameSwitchTime);
			for (const ref of [0.7, 2.1, -1.3]) {
				const a = [sw.r * Math.cos(sw.phiSurf + ref), sw.r * Math.sin(sw.phiSurf + ref)];
				const off = ref - res.frameSwitchHostRot;
				const b = [sw.relX * Math.cos(off) - sw.relY * Math.sin(off), sw.relX * Math.sin(off) + sw.relY * Math.cos(off)];
				assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9 * sw.r, `host-fixed and inertial forms coincide at the switch (ref ${ref})`);
			}
			const host = { id: 1, x: 0, y: 0, rotationAngle: 0.7 };
			const preview = render(res, host, { mode: 'preview' }, { zoom: 1e9 });
			const t = res.frameSwitchTime + 100;
			const flight = render(res, { ...host, rotationAngle: 0.7 + res.hostOmega * (37 + t) }, { mode: 'flight', currentFlightTime: t, showActualPath: false }, { zoom: 1e9 });
			assert.equal(flight.predictedVertices().length, preview.predictedVertices().length);
			assert.ok(Math.abs(maxDrawnStep(flight) - maxDrawnStep(preview)) <= 1e-9, 'flight is a rigid rotation of the preview');
			assert.ok(maxDrawnStep(preview) <= 0.15);
		});
	});

	describe('In-flight erase at the final point time (§4.3 guarantee 2)', () => {
		const host = { id: 7, x: 0, y: 0, rotationAngle: 0 };
		const prediction = {
			hostId: 7, events: [], maxSimTime: 40, frameSwitchTime: null, frameSwitchHostRot: null, hostOmega: 0,
			points: [0, 10, 20, 30, 40].map((t, i) => ({ time: t, r: 1 + i, phiSurf: 0.1 * i, relX: 1 + i, relY: 0, altM: i }))
		};
		const drawnCount = (pr, opts) => render(pr, host, opts, { zoom: 100 }).predictedVertices().length;

		it('drawn just before the final point time, erased at it and just after it', () => {
			assert.equal(drawnCount(prediction, { mode: 'flight', currentFlightTime: 39.999 }), 5);
			assert.equal(drawnCount(prediction, { mode: 'flight', currentFlightTime: 40 }), 0);
			assert.equal(drawnCount(prediction, { mode: 'flight', currentFlightTime: 40.001 }), 0);
			assert.equal(render(prediction, host, { mode: 'flight', currentFlightTime: 41 }).saves, 0, 'markers are not drawn either');
		});

		it('preview and flight without a flight time are never erased', () => {
			assert.equal(drawnCount(prediction, { mode: 'preview', currentFlightTime: 1e9 }), 5);
			assert.equal(drawnCount(prediction, { mode: 'flight' }), 5);
		});

		it('a missing maxSimTime falls back to the final point time', () => {
			const legacy = { ...prediction, maxSimTime: undefined };
			assert.equal(drawnCount(legacy, { mode: 'flight', currentFlightTime: 39.999 }), 5);
			assert.equal(drawnCount(legacy, { mode: 'flight', currentFlightTime: 40.001 }), 0);
		});

		it('a step-budget prediction is erased right after its last integrated point, long before the request', () => {
			const res = coast({ maxSimTime: 0.2 * MONTH_S });
			const h = { id: 1, x: 0, y: 0, rotationAngle: 0 };
			const before = render(res, h, { mode: 'flight', currentFlightTime: res.maxSimTime - 0.001 }, { zoom: 1e9 }).predictedVertices();
			const afterLast = render(res, h, { mode: 'flight', currentFlightTime: res.maxSimTime + 0.001 }, { zoom: 1e9 }).predictedVertices();
			assert.ok(before.length > 2);
			assert.equal(afterLast.length, 0);
			assert.ok(res.maxSimTime < 0.2 * MONTH_S / 10);
		});
	});

	describe('Predictor rocket does not track the RCS visual state (§4.12, trackRcsVisualState: false)', () => {
		it('the predictor rocket is built with trackRcsVisualState false and never updates the RCS flags', () => {
			const origRcs = CalcRocket.prototype._updateRcsState;
			const origFc = CalcRocket.prototype.flightControl;
			let rcsCalls = 0;
			const seen = new Set();
			CalcRocket.prototype._updateRcsState = function (...a) { rcsCalls++; return origRcs.apply(this, a); };
			CalcRocket.prototype.flightControl = function (...a) { seen.add(this); return origFc.apply(this, a); };
			try {
				const res = runMultiBodySimulation(falconAscentArgs(0.7));
				assert.ok(res.events.some(e => e.id === 'stg_sep_1'), 'the ascent passes the staging phases that drive the RCS');
			} finally {
				CalcRocket.prototype._updateRcsState = origRcs;
				CalcRocket.prototype.flightControl = origFc;
			}
			assert.equal(seen.size, 1);
			const rocket = [...seen][0];
			assert.equal(rocket.id, TP.DUMMY_ROCKET_ID);
			assert.equal(rocket.trackRcsVisualState, false);
			assert.equal(rcsCalls, 0, '_updateRcsState is never called');
			assert.equal(rocket.rcsCw, false);
			assert.equal(rocket.rcsCcw, false);
			assert.equal(rocket.rcsUllage, false);
			// §4.12: separation and restart may set these timers, but only _updateRcsState advances them and it never runs.
			assert.ok([0, RCS_CONFIG.POST_SEP_SETTLE_S].includes(rocket._postSepRcsTimer), `post-separation timer ${rocket._postSepRcsTimer} is never advanced`);
			assert.ok([0, RCS_CONFIG.ULLAGE_POST_COAST_S].includes(rocket._ullageRestartTimer), `ullage timer ${rocket._ullageRestartTimer} is never advanced`);
		});

		it('regular CalcRocket instances keep tracking by default; only an explicit false disables it', () => {
			const make = (thrustData) => new CalcRocket(1, 'R', 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, thrustData);
			assert.equal(make(undefined).trackRcsVisualState, true);
			assert.equal(make({}).trackRcsVisualState, true);
			assert.equal(make({ trackRcsVisualState: undefined }).trackRcsVisualState, true);
			assert.equal(make({ trackRcsVisualState: true }).trackRcsVisualState, true);
			assert.equal(make({ trackRcsVisualState: false }).trackRcsVisualState, false);
		});

		it('tracking the RCS state would not change the prediction (it is render-only)', () => {
			const base = runMultiBodySimulation(falconAscentArgs(0.7));
			const origRcs = CalcRocket.prototype._updateRcsState;
			const origFc = CalcRocket.prototype.flightControl;
			let rcsCalls = 0;
			let anyActive = false;
			CalcRocket.prototype._updateRcsState = function (...a) {
				rcsCalls++;
				const r = origRcs.apply(this, a);
				if (this.rcsCw || this.rcsCcw || this.rcsUllage) { anyActive = true; }
				return r;
			};
			CalcRocket.prototype.flightControl = function (...a) { this.trackRcsVisualState = true; return origFc.apply(this, a); };
			let forced;
			try {
				forced = runMultiBodySimulation(falconAscentArgs(0.7));
			} finally {
				CalcRocket.prototype._updateRcsState = origRcs;
				CalcRocket.prototype.flightControl = origFc;
			}
			assert.ok(rcsCalls > 0 && anyActive, 'with tracking forced on, the RCS state machine is active');
			assert.deepStrictEqual(forced, base);
		});
	});
	describe('Flight-plan separation events (§3.4-1 sep_* actions, §4.14-8/9): closed-form stage timeline', () => {
		// A synthetic vehicle coasting on a circular 400 km orbit of an airless, non-rotating host, with the orbital cutoff
		// off: every stage burns its whole burn time at full throttle, so the timeline follows from the configuration alone.
		// Stage k burns B[k] s; a burnt-out stage separates SEP_DELAY s after its cutoff and the next one ignites
		// IGN_DELAY s after that (separationDelaySec / ignitionDelaySec); a self-propelled payload burns PAY_BURN s.
		// A row's action runs in the first flight step at or after its time (design §3.4-1). Steps are at most
		// DT.POST_BURNOUT_COOL here (DT.POWERED_OR_ATM while burning), so an event is expected within that many steps.
		const STEP = TP.DT.POST_BURNOUT_COOL;
		const EPS = 1e-6;
		const B = [10, 30, 20];
		const SEP_DELAY = 1;
		const IGN_DELAY = 1;
		const PAY_BURN = 5;
		const stage = (k) => ({
			stageNumber: k + 1, thrustKN: 10, fuelMassT: 1, oxidMassT: 0, ofRatio: 0, burnTime: B[k], dryMassT: 1, ispVac: 300,
			separationDelaySec: SEP_DELAY, ignitionDelaySec: IGN_DELAY
		});
		const OWN = { name: 'Bus', massT: 1, propulsion: { enabled: true, fuelType: 'liquid', thrustKN: 1, dryMassT: 0.5, fuelMassT: 0.1, oxidMassT: 0, burnTime: PAY_BURN, ofRatio: 0 } };
		const PASSIVE = { name: 'Sat', massT: 1, propulsion: { enabled: false } };
		const sepRow = (t, action) => ({ type: 'time', value: t, thrust: 100, angle: 90, action });
		/** The staging events of the prediction (the stg_sep_N of a stage index beyond the vehicle are a separate finding). */
		const STAGING = /^(meco(_\d+)?|seco_1|stg_sep_\d+|payload_sep|payload_start|payload_cutoff|ses_\d+|reignition_\d+)$/;
		const predictPlan = ({ stages = 2, payload = OWN, rows = [], disableStaging = false } = {}) => {
			const r0 = RE + 400e3;
			const st = B.slice(0, stages).map((_, k) => stage(k));
			const res = simulate({
				rocket: {
					x: r0, vy: vCirc(r0), stages: st, payload, fairing: { enabled: false }, disableOrbitalCutoff: true, disableStaging,
					fuelMassT: 1, thrustForceN: 10000, burnTime: B[0], flightProfile: [{ type: 'time', value: 0, thrust: 100, angle: 90, action: '' }, ...rows]
				},
				options: { maxSimTime: 120 }
			});
			assert.equal(res.endReason, 'horizon', 'input: the vehicle stays in orbit for the whole run');
			return res.events.filter(e => STAGING.test(e.id) && !(/^stg_sep_/.test(e.id) && Number(e.id.slice(8)) > stages));
		};
		/** Window [t, t + n steps]: the first step at or after t (n = 1), or after n chained waits. */
		const win = (t, n = 1) => [t - EPS, t + n * STEP + EPS];
		/** Times of the stages that burn out by themselves: cutoff k, separation k + 1, ignition k + 1 (nominal, n steps late at most). */
		const meco1 = win(B[0]);
		const sep1 = win(B[0] + SEP_DELAY, 2);
		const ses1 = win(B[0] + SEP_DELAY + IGN_DELAY, 3);
		/** Compare with the expected events: the same ids, in this order (time, then the order the step passes them), each in its window. */
		const assertEvents = (events, expected, label) => {
			assert.deepEqual(events.map(e => e.id), expected.map(([id]) => id), `${label}: events in flight order`);
			for (const [id, [lo, hi]] of expected) {
				const t = events.find(e => e.id === id).time;
				assert.ok(t >= lo && t <= hi, `${label}: ${id} at ${t} s, expected within [${lo}, ${hi}]`);
			}
		};

		it('input: the default plan (no action) burns, stages and separates the payload on the configured timeline', () => {
			const events = predictPlan();
			const ses = events.find(e => e.id === 'ses_1').time;
			const seco = ses + B[1];
			assertEvents(events, [
				['meco_1', meco1], ['stg_sep_1', sep1], ['ses_1', ses1],
				['seco_1', [seco - STEP - EPS, seco + STEP + EPS]], ['stg_sep_2', win(seco + SEP_DELAY, 2)], ['payload_sep', win(seco + SEP_DELAY, 2)],
				['payload_start', win(seco + SEP_DELAY, 3)], ['payload_cutoff', win(seco + SEP_DELAY + PAY_BURN, 4)]
			], 'default');
		});

		it('normal: sep_payload during the upper-stage burn of a self-propelled payload: SECO-1, 2-STG-SEP, PAYLOAD SEP and PAYLOAD START at the row, PAYLOAD CUTOFF a payload burn later', () => {
			const T = 20;
			assertEvents(predictPlan({ rows: [sepRow(T, 'sep_payload')] }), [
				['meco_1', meco1], ['stg_sep_1', sep1], ['ses_1', ses1],
				['seco_1', win(T)], ['stg_sep_2', win(T)], ['payload_sep', win(T)], ['payload_start', win(T)],
				['payload_cutoff', [T + PAY_BURN - STEP - EPS, T + PAY_BURN + STEP + EPS]]
			], 'self-propelled at 20 s');
		});

		it('normal: sep_stage2 of a two-stage vehicle during the upper-stage burn is the payload separation (§3.4-1): the same events', () => {
			const T = 20;
			const viaStage2 = predictPlan({ rows: [sepRow(T, 'sep_stage2')] });
			assert.deepEqual(viaStage2, predictPlan({ rows: [sepRow(T, 'sep_payload')] }));
		});

		it('normal: a passive payload separated during the upper-stage burn: SECO-1 and the separations at the row, no PAYLOAD START or CUTOFF', () => {
			const T = 20;
			assertEvents(predictPlan({ payload: PASSIVE, rows: [sepRow(T, 'sep_payload')] }), [
				['meco_1', meco1], ['stg_sep_1', sep1], ['ses_1', ses1], ['seco_1', win(T)], ['stg_sep_2', win(T)], ['payload_sep', win(T)]
			], 'passive at 20 s');
		});

		it('normal: sep_stage1 during the first-stage burn: MECO-1 and STG-1 SEP at the row, SES-1 the ignition delay later', () => {
			const T = 5;
			const events = predictPlan({ rows: [sepRow(T, 'sep_stage1')] });
			const ses = events.find(e => e.id === 'ses_1').time;
			assertEvents(events.slice(0, 3), [['meco_1', win(T)], ['stg_sep_1', win(T)], ['ses_1', win(T + IGN_DELAY, 2)]], 'sep_stage1 at 5 s');
			assert.ok(Math.abs(events.find(e => e.id === 'seco_1').time - (ses + B[1])) <= STEP + EPS, 'the upper stage then burns its whole burn time');
		});

		it('normal (3 stages): sep_stage2 during the second-stage burn: MECO-2 and STG-2 SEP at the row, SES-2 the ignition delay later; sep_payload during the third-stage burn: SECO-1 at the row', () => {
			const T2 = 20;
			const s2 = predictPlan({ stages: 3, payload: PASSIVE, rows: [sepRow(T2, 'sep_stage2')] });
			assertEvents(s2.slice(0, 6), [
				['meco_1', meco1], ['stg_sep_1', sep1], ['ses_1', ses1], ['meco_2', win(T2)], ['stg_sep_2', win(T2)], ['ses_2', win(T2 + IGN_DELAY, 2)]
			], '3 stages, sep_stage2 at 20 s');
			const T3 = 50;
			const s3 = predictPlan({ stages: 3, rows: [sepRow(T3, 'sep_payload')] });
			const at = s3.slice(s3.findIndex(e => e.id === 'ses_2') + 1);
			assertEvents(at, [
				['seco_1', win(T3)], ['stg_sep_3', win(T3)], ['payload_sep', win(T3)], ['payload_start', win(T3)],
				['payload_cutoff', [T3 + PAY_BURN - STEP - EPS, T3 + PAY_BURN + STEP + EPS]]
			], '3 stages, sep_payload at 50 s');
		});

		it('boundary: sep_payload during the first-stage burn jettisons the unlit upper stages with it: MECO-1 only, no SES or SECO-1 (2 and 3 stages)', () => {
			const T = 5;
			for (const stages of [2, 3]) {
				const seps = Array.from({ length: stages }, (_, k) => [`stg_sep_${k + 1}`, win(T)]);
				assertEvents(predictPlan({ stages, rows: [sepRow(T, 'sep_payload')] }), [
					['meco_1', win(T)], ...seps, ['payload_sep', win(T)], ['payload_start', win(T)],
					['payload_cutoff', [T + PAY_BURN - STEP - EPS, T + PAY_BURN + STEP + EPS]]
				], `${stages} stages at 5 s`);
			}
		});

		it('boundary: single stage: sep_payload during its burn gives MECO at the row, then the payload\'s own START and CUTOFF', () => {
			const T = 5;
			assertEvents(predictPlan({ stages: 1, rows: [sepRow(T, 'sep_payload')] }), [
				['meco', win(T)], ['stg_sep_1', win(T)], ['payload_sep', win(T)], ['payload_start', win(T)],
				['payload_cutoff', [T + PAY_BURN - STEP - EPS, T + PAY_BURN + STEP + EPS]]
			], 'single stage at 5 s');
			assertEvents(predictPlan({ stages: 1, payload: PASSIVE, rows: [sepRow(T, 'sep_payload')] }), [
				['meco', win(T)], ['stg_sep_1', win(T)], ['payload_sep', win(T)]
			], 'single stage, passive');
		});

		it('boundary: during the first stage\'s cutoff wait (STG_MECO) and during the interstage coast: no SES or SECO-1 for the unlit upper stage; the payload starts in the same step from the coast, one step later from STG_MECO (a burnt-out stage commands no throttle)', () => {
			const inMeco = B[0] + SEP_DELAY / 2;
			assertEvents(predictPlan({ rows: [sepRow(inMeco, 'sep_payload')] }), [
				['meco_1', meco1], ['stg_sep_1', win(inMeco)], ['stg_sep_2', win(inMeco)], ['payload_sep', win(inMeco)], ['payload_start', win(inMeco, 2)],
				['payload_cutoff', [inMeco + PAY_BURN - STEP - EPS, inMeco + PAY_BURN + 2 * STEP + EPS]]
			], 'in STG_MECO');
			const inCoast = B[0] + SEP_DELAY + IGN_DELAY / 2 + STEP; // after the separation step, before the ignition
			assertEvents(predictPlan({ rows: [sepRow(inCoast, 'sep_payload')] }), [
				['meco_1', meco1], ['stg_sep_1', sep1], ['stg_sep_2', win(inCoast)], ['payload_sep', win(inCoast)], ['payload_start', win(inCoast)],
				['payload_cutoff', [inCoast + PAY_BURN - STEP - EPS, inCoast + PAY_BURN + STEP + EPS]]
			], 'in the interstage coast');
		});

		it('boundary: after SECO (the burnt-out upper stage held in STG_MECO for the row): SECO-1 at its burnout, the separation at the row, PAYLOAD START one step later', () => {
			const T = 60;
			const events = predictPlan({ rows: [sepRow(T, 'sep_payload')] });
			const seco = events.find(e => e.id === 'ses_1').time + B[1];
			assertEvents(events, [
				['meco_1', meco1], ['stg_sep_1', sep1], ['ses_1', ses1], ['seco_1', [seco - STEP - EPS, seco + STEP + EPS]],
				['stg_sep_2', win(T)], ['payload_sep', win(T)], ['payload_start', win(T, 2)], ['payload_cutoff', win(T + PAY_BURN, 2)]
			], 'after SECO');
		});

		it('boundary: a row at t = 0 and at the first step (§4.14-9): the action runs in the first step (not in the evaluation at liftoff), with the cutoff of the burning first stage and no event of the unlit stages', () => {
			const first = TP.DT.POWERED_OR_ATM;
			for (const T of [0, first]) {
				assertEvents(predictPlan({ rows: [sepRow(T, 'sep_payload')] }), [
					['meco_1', win(first)], ['stg_sep_1', win(first)], ['stg_sep_2', win(first)], ['payload_sep', win(first)], ['payload_start', win(first)],
					['payload_cutoff', [first + PAY_BURN - STEP - EPS, first + PAY_BURN + STEP + EPS]]
				], `sep_payload at ${T} s`);
				const s1 = predictPlan({ rows: [sepRow(T, 'sep_stage1')] });
				assertEvents(s1.slice(0, 3), [['meco_1', win(first)], ['stg_sep_1', win(first)], ['ses_1', win(first + IGN_DELAY, 2)]], `sep_stage1 at ${T} s`);
			}
		});

		it('boundary: sep_stage1 after the first stage\'s burnout holds it in STG_MECO (§3.4-1 deferred staging): MECO-1 at the burnout, STG-1 SEP at the row, SES-1 the ignition delay later', () => {
			const T = 20;
			const events = predictPlan({ rows: [sepRow(T, 'sep_stage1')] });
			assertEvents(events.slice(0, 3), [['meco_1', meco1], ['stg_sep_1', win(T)], ['ses_1', win(T + IGN_DELAY, 2)]], 'sep_stage1 at 20 s');
		});

		it('abnormal: an action that does not apply (sep_stage2 while the first stage burns, an unknown action, a second sep_stage1 after the first stage is gone) or disableStaging changes nothing', () => {
			const base = predictPlan();
			assert.deepEqual(predictPlan({ rows: [sepRow(5, 'sep_stage2')] }), base, 'sep_stage2 before the second stage');
			assert.deepEqual(predictPlan({ rows: [sepRow(5, 'sep_stage9')] }), base, 'unknown action');
			assert.deepEqual(predictPlan({ rows: [sepRow(5, 'sep_stage1'), sepRow(20, 'sep_stage1')] }), predictPlan({ rows: [sepRow(5, 'sep_stage1')] }),
				'a second sep_stage1 during the second stage');
			const frozen = predictPlan({ rows: [sepRow(5, 'sep_payload')], disableStaging: true });
			assert.deepEqual(frozen.map(e => e.id), ['meco_1'], 'disableStaging: the first stage burns out and nothing separates');
			assert.ok(frozen[0].time >= B[0] - EPS && frozen[0].time <= B[0] + STEP + EPS);
		});
	});
});
