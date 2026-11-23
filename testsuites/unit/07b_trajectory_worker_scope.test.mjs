/**
 * Unit Test Suite 07b: Trajectory Predictor Worker Path (worker global scope)
 *
 * Design: docs/design/2026-11-20_trajectory_fx_flightplan.md §4.3 guarantee 2 (maxSimTime on the sync and Worker
 * paths, no_host), §4.10 (switch fields carried over the Worker path), §4.12 (Rev 6.10 budget options).
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-B (Worker path).
 *
 * gravsim_calc_predictor.js registers its Worker handler (self.onmessage) only when `self` exists while the module is
 * evaluated. This file therefore installs the worker global scope and the Worker constructor first, then loads every
 * module with a plain dynamic import(), so the predictor module is evaluated exactly once in this process (node --test
 * runs each test file in its own process) and coverage is attributed to that single instance.
 * The scope gets its postMessage only after the imports. gravsim_calc.js (imported by the predictor) starts its
 * SimulationController loop only as the physics Worker's entry script (its script URL is gravsim_calc.js), so the
 * predictor Worker never runs one (regressions/11_preexisting_worker_fixes); without postMessage during the imports a
 * re-introduced stray loop could not start here either.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Main-thread Worker stand-in that records what the predictor posts. */
class RecordingWorker {
	constructor(url, opts) {
		this.url = String(url);
		this.opts = opts;
		this.posted = [];
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
	}
	postMessage(msg) { this.posted.push(msg); }
	terminate() { this.terminated = true; }
}

/** Worker global scope seen by gravsim_calc_predictor.js. */
const workerScope = { posted: [], onmessage: null };
globalThis.Worker = RecordingWorker;
globalThis.self = workerScope;

const { TrajectoryPredictor } = await import('../../scripts/gravsim_trajectory_predictor.js');
const { PHYSICS, TRAJECTORY_PREDICTION, OBJECT_TYPES } = await import('../../scripts/gravsim_const.js');
const { UnitConvertUtils } = await import('../../scripts/gravsim_utils.js');
workerScope.postMessage = function (msg) { this.posted.push(msg); };

const TP = TRAJECTORY_PREDICTION;
const MONTH_S = (365.25 / 12) * 86400; // RocketLauncher.maxSimTimeSec per month
const RE = 6371e3;
const ME = 5.972e24;
const GM = PHYSICS.G * ME;
const COAST_STAGES = [{ thrustKN: 0, fuelMassT: 0, oxidMassT: 0, burnTime: 0, dryMassT: 1 }];
const vCirc = (r) => Math.sqrt(GM / r);
const m2p = (m) => UnitConvertUtils.m2pix(m);

/** TrajectoryPredictor launch configuration around a synthetic rotating host: unpowered probe in a 400 km circular orbit. */
function predictorConfig({ hostId = 11, maxSimTime = 600 } = {}) {
	const host = {
		id: hostId, name: 'TestHost', type: OBJECT_TYPES.CELESTIAL, x: 0.2, y: -0.1, vx: 0, vy: 0,
		mass: UnitConvertUtils.kg2ton(ME), radius: RE, rotationAngle: 0.4, param: { ROTATION_PERIOD: 86164 }
	};
	const r0 = RE + 400e3;
	const config = {
		host, relX: m2p(r0), relY: 0, relVx: 0, relVy: m2p(vCirc(r0)), maxSimTime, bottomOffsetM: 2,
		stages: COAST_STAGES, dryMassT: 1, fuelMassT: 0, oxidMassT: 0, burnTime: 0
	};
	return { universe: { objects: [host], getObjectParams: () => null }, config };
}

const FIELDS = {
	hostId: 5, points: [{ time: 0 }, { time: 12.5 }], events: [{ id: 'orbit', time: 12.5 }], isOrbital: true, maxSimTime: 1234.5,
	maxAltM: 9, maxQ: 3, endReason: 'step_budget', steps: 120000, frameSwitchTime: 12.5, frameSwitchHostRot: 0.25, hostOmega: 7.29e-5
};
/** Deliver a Worker message to the main-thread predictor with structured-clone semantics. */
const deliver = (predictor, data) => predictor._worker.onmessage({ data: structuredClone(data) });

/** Request through the Worker: main -> real worker handler -> main, all messages structured-cloned. */
function viaWorker(universe, config) {
	const tp = new TrajectoryPredictor(universe);
	let received = null;
	tp.requestPrediction(config, (p) => { received = p; });
	assert.equal(tp._worker.posted.length, 1);
	const request = tp._worker.posted[0];
	assert.equal(request.cmd, 'predict');
	workerScope.posted.length = 0;
	workerScope.onmessage({ data: structuredClone(request) });
	assert.equal(workerScope.posted.length, 1);
	const response = workerScope.posted[0];
	assert.equal(response.cmd, 'predictionResult');
	assert.equal(response.requestId, request.requestId);
	deliver(tp, response);
	return received;
}

describe('Unit 07b: trajectory predictor Worker path (§4.3 guarantee 2, §4.10 switch fields, §4.12)', () => {
	it('evaluating the predictor module in a worker scope registers its message handler on self', () => {
		assert.equal(typeof workerScope.onmessage, 'function');
		assert.equal(workerScope.posted.length, 0, 'nothing is posted before a request arrives');
	});

	it('the predictor spawns the module Worker and passes every result field through unchanged', () => {
		const tp = new TrajectoryPredictor({ objects: [] });
		assert.ok(tp._worker instanceof RecordingWorker);
		assert.ok(tp._worker.url.endsWith('/scripts/gravsim_calc_predictor.js'));
		assert.deepEqual(tp._worker.opts, { type: 'module' });
		let received = null;
		tp._pendingCallbacks.set(1, (p) => { received = p; });
		tp._isBusy = true;
		deliver(tp, { cmd: 'predictionResult', requestId: 1, ...FIELDS });
		assert.deepStrictEqual(tp.prediction, FIELDS);
		assert.equal(received, tp.prediction, 'the request callback receives the prediction');
		assert.equal(tp.isStale, false);
		assert.equal(tp._isBusy, false);
		assert.equal(tp._pendingCallbacks.size, 0);
	});

	it('maxSimTime 0 stays 0; missing or null becomes the 1-year default (Iteration 7 WP4, Iteration 8 WP7)', () => {
		const tp = new TrajectoryPredictor({ objects: [] });
		deliver(tp, { cmd: 'predictionResult', requestId: 1, ...FIELDS, maxSimTime: 0 });
		assert.equal(tp.prediction.maxSimTime, 0);
		const { maxSimTime: _omit, ...withoutMax } = FIELDS;
		deliver(tp, { cmd: 'predictionResult', requestId: 2, ...withoutMax });
		assert.equal(tp.prediction.maxSimTime, TP.MAX_SIM_TIME_SEC);
		deliver(tp, { cmd: 'predictionResult', requestId: 3, ...FIELDS, maxSimTime: null });
		assert.equal(tp.prediction.maxSimTime, TP.MAX_SIM_TIME_SEC);
	});

	it('stale results and other commands do not replace the prediction', () => {
		const tp = new TrajectoryPredictor({ objects: [] });
		deliver(tp, { cmd: 'predictionResult', requestId: 5, ...FIELDS });
		let staleCalled = false;
		tp._pendingCallbacks.set(3, () => { staleCalled = true; });
		deliver(tp, { cmd: 'predictionResult', requestId: 3, ...FIELDS, endReason: 'horizon' });
		assert.equal(tp.prediction.endReason, 'step_budget');
		assert.equal(staleCalled, false);
		assert.equal(tp._pendingCallbacks.has(3), false);
		deliver(tp, { cmd: 'somethingElse', requestId: 9, ...FIELDS, endReason: 'impact' });
		assert.equal(tp.prediction.endReason, 'step_budget');
	});

	it('the Worker path returns the same prediction as calculateSync (all fields, including the switch fields)', () => {
		const { universe, config } = predictorConfig();
		const sync = new TrajectoryPredictor(null).calculateSync(config);
		const viaW = viaWorker(universe, config);
		assert.deepStrictEqual(viaW, sync);
		assert.equal(sync.endReason, 'horizon');
		assert.ok(Number.isFinite(sync.frameSwitchTime));
		assert.equal(sync.frameSwitchHostRot, 0.4 + sync.hostOmega * sync.frameSwitchTime);
	});

	it('no_host gives maxSimTime 0 on both the sync and the Worker path (Iteration 8 WP1)', () => {
		const { universe, config } = predictorConfig({ hostId: NaN }); // a NaN id never matches, so the host is missing
		const sync = new TrajectoryPredictor(null).calculateSync(config);
		assert.equal(sync.endReason, 'no_host');
		assert.equal(sync.maxSimTime, 0);
		const viaW = viaWorker(universe, config);
		assert.equal(viaW.endReason, 'no_host');
		assert.equal(viaW.maxSimTime, 0, 'a 0 result is not replaced by the 1-year default');
		assert.deepStrictEqual(viaW.points, []);
	});

	it('budget options that are not positive numbers are ignored on the Worker path as well (Rev 6.10)', () => {
		const { universe, config } = predictorConfig({ maxSimTime: 0.2 * MONTH_S });
		const reference = new TrajectoryPredictor(null).calculateSync(config);
		assert.equal(reference.steps, 120000);
		const viaW = viaWorker(universe, { ...config, maxSteps: 'abc', maxPoints: {} });
		assert.equal(viaW.endReason, 'step_budget');
		assert.equal(viaW.steps, 120000, "'abc' leaves the normal 0.2-month step budget");
		assert.deepStrictEqual(viaW, reference);
	});

	it('the worker handler ignores commands other than predict', () => {
		workerScope.posted.length = 0;
		workerScope.onmessage({ data: { cmd: 'noop', requestId: 1 } });
		assert.equal(workerScope.posted.length, 0);
	});

	it('requestPrediction without a Worker falls back to calculateSync and calls back synchronously', () => {
		const { config } = predictorConfig();
		const saved = globalThis.Worker;
		delete globalThis.Worker;
		try {
			const tp = new TrajectoryPredictor({ objects: [] });
			assert.equal(tp._worker, null);
			let received = null;
			const id = tp.requestPrediction(config, (p) => { received = p; });
			assert.equal(id, 1);
			assert.deepStrictEqual(received, new TrajectoryPredictor(null).calculateSync(config));
			assert.equal(tp.requestPrediction({}), 0, 'a configuration without host is rejected');
		} finally {
			globalThis.Worker = saved;
		}
	});
});
