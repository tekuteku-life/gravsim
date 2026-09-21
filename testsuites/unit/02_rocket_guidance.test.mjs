import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockRocket, createMockElement, createFalcon9Config, assertClose } from '../test_helpers.mjs';

// Setup DOM and global mocks before imports
setupMockDOM();

import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { LaunchSequencer } from '../../scripts/gravsim_launch_sequencer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { DebrisGenerator } from '../../scripts/gravsim_debris_generator.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import { Rocket, Debris } from '../../scripts/gravsim_object.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { PropulsionCard } from '../../scripts/gravsim_telemetry_card.js';
import { UnitConvertUtils, normalizeRocketConfig } from '../../scripts/gravsim_utils.js';
import { PHYSICS, TELEMETRY, MULTISTAGE_PRESETS, OBJECT_TYPES, OBJECT_STATE, ROCKET_VISUAL, RENDER, DEFAULT_OBJECT_PARAMS, PAD_EFFECT } from '../../scripts/gravsim_const.js';

test('FlightComputer - Initialization and default telemetry cache', () => {
	const fc = new FlightComputer({
		maxGLimit: 4.5,
		maxQAxialLimit: 40000,
		maxQLateralLimit: 8000,
		thrustAngle: 0
	});

	assert.equal(fc.config.maxGLimit, 4.5);
	assert.equal(fc.config.maxQAxialLimit, 40000);
	assert.equal(fc.config.maxQLateralLimit, 8000);
	assert.equal(fc.flightTime, 0);

	const telem = fc.getTelemetry();
	assert.equal(telem.status, TELEMETRY.STATUS.PRE_LAUNCH);
	assert.equal(telem.remDv, 0);
	assert.equal(telem.twr, 0);
});

test('FlightComputer - Flight Profile Interpolation (_evaluateProfile)', () => {
	const fc = new FlightComputer({
		flightProfile: [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 20000, thrust: 80, angle: 45 },
			{ type: 'alt', value: 80000, thrust: 60, angle: 90 }
		]
	});

	// At alt = 0
	fc.telemetryCache.altM = 0;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 1.0);
	assert.equal(fc._profileState.relAngleDeg, 0);

	// At alt = 10000 (midpoint between 0 and 20000)
	fc.telemetryCache.altM = 10000;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 0.9); // (100 + 80)/2 / 100
	assert.equal(fc._profileState.relAngleDeg, 22.5); // (0 + 45)/2

	// At alt = 80000
	fc.telemetryCache.altM = 80000;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 0.6);
	assert.equal(fc._profileState.relAngleDeg, 90);

	// At alt > 80000 (after last step)
	fc.telemetryCache.altM = 100000;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 0.6);
	assert.equal(fc._profileState.relAngleDeg, 90);
});

test('FlightComputer - Apogee Trigger Detection and Profile Evaluation', () => {
	const fc = new FlightComputer({
		flightProfile: [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'time', value: 100, thrust: 0, angle: 90 },
			{ type: 'apogee', value: 0, thrust: 80, angle: 90 },
			{ type: 'apogee', value: 30, thrust: 50, angle: 90 }
		]
	});

	// Phase 1: Ascent before time 100
	fc.telemetryCache.altM = 50000;
	fc.flightTime = 50;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 1.0);

	// Phase 2: Coasting at time >= 100 before apogee (vV > 0 climbing)
	fc.flightTime = 120;
	const refBody = { radius: 6371000, mass: 5.972e24, x: 0, y: 0, vx: 0, vy: 0 };
	fc.update({
		dt: 1, x: 0, y: -6521000, vx: 0, vy: -500,
		altM: 150000, isHoldDown: false, distToRefM: 6521000, refBody
	});
	assert.equal(fc.hasPassedApogee, false);
	assert.equal(fc._profileState.throttle, 0.0, 'Thrust must be 0 during coast before apogee');

	// Phase 3: Passing apogee (vV transitions <= 0 outside atmosphere)
	fc.flightTime = 300;
	fc.update({
		dt: 1, x: 0, y: -6621000, vx: 0, vy: 50,
		altM: 250000, isHoldDown: false, distToRefM: 6621000, refBody
	});
	assert.equal(fc.hasPassedApogee, true);
	assert.equal(fc.apogeeTime, 301);
	assert.equal(fc._profileState.throttle, 0.8, 'Thrust must be 80% at apogee trigger');

	// Phase 4: Interpolation between apogee steps (at apogeeTime + 15s)
	fc.flightTime = 316;
	fc._evaluateProfile({ dt: 1 });
	assert.equal(fc._profileState.throttle, 0.65, 'Thrust should interpolate between 80% and 50%');
});

test('FlightComputer - Max-G limiting throttle computation', () => {
	const fc = new FlightComputer({
		maxGLimit: 3.0 // 3 G
	});

	// Rocket mass = 100 t -> 100,000 kg. Max force = 3 * 9.80665 * 100,000 ~= 2,941,995 N
	const mass = 100;
	const thrustForce = 6000000; // 6000 kN -> would be ~6.1 G, exceeds 3 G
	const throttle = fc._computeThrottle({
		burnTime: 10,
		mass: mass,
		thrustForce: thrustForce,
		qAxialKpa: 0
	}, 1.0);

	const maxAllowedThrust = 3.0 * PHYSICS.G0 * 100000;
	const expectedThrottle = maxAllowedThrust / thrustForce;
	assert.ok(Math.abs(throttle - expectedThrottle) < 1e-4, `Throttle ${throttle} should be clamped to ${expectedThrottle}`);
	assert.ok(throttle < 1.0);
});

test('FlightComputer - Max-Q Peak Hold and Status Transitions', () => {
	const fc = new FlightComputer({
		maxGLimit: 5.0,
		maxQAxialLimit: 40000,
		maxQLateralLimit: 8000
	});

	const earth = createMockCelestialBody({ name: 'Earth', x: 0, y: 0, mass: 5.972e24, radius: 6371000 });

	// Simulate rising Q
	let sensor = {
		dt: 0.5,
		isHoldDown: false,
		burnTime: 100,
		mass: 500,
		fuelMass: 400,
		massLossRate: 2,
		thrustForce: 7600000,
		thrustRatio: 1.0,
		x: 0,
		y: -6371000 - 10000,
		vx: 100,
		vy: -500,
		ax: 10,
		ay: -20,
		refBody: earth,
		distToRefM: 6371000 + 10000,
		qAxialKpa: 35, // 35 kPa
		qLateralKpa: 2,
		aoaDeg: 1.0,
		progradeAngle: -Math.PI / 2
	};

	fc.update(sensor);
	assert.equal(fc.maxRecordedQ, 37);
	assert.equal(fc.hasPassedMaxQ, false);
	assert.equal(fc.telemetryCache.status, TELEMETRY.STATUS.ASCENT);

	// Simulate Q dropping significantly past peak
	sensor.qAxialKpa = 20; // dropped by (37 - 22)/37 = 40% > MAX_Q_PEAK_DROP_RATIO (0.12)
	sensor.qLateralKpa = 2;

	// Accumulate confirm timer
	for (let i = 0; i < 6; i++) {
		fc.update(sensor);
	}
	assert.equal(fc.hasPassedMaxQ, true, 'Max-Q should be confirmed passed');
	assert.equal(fc.telemetryCache.status, TELEMETRY.STATUS.MAX_Q, 'Status should be MAX_Q during keep duration');
});

test('FlightComputer - Telemetry calculation (velocity components & multi-stage remDv)', () => {
	const fc = new FlightComputer();
	const earth = createMockCelestialBody({ name: 'Earth', x: 0, y: 0, mass: 5.972e24, radius: 6371000 });

	const sensor = {
		dt: 1.0,
		isHoldDown: false,
		burnTime: 100,
		mass: 550, // total 550 t
		fuelMass: 400, // active stage propellant: 400 t
		massLossRate: 2.5,
		thrustForce: 7600000,
		thrustRatio: 1.0,
		x: 0,
		y: -(6371000 + 50000), // 50 km alt
		vx: 500,
		vy: -1000,
		ax: 0,
		ay: -9.8,
		refBody: earth,
		distToRefM: 6371000 + 50000,
		qAxialKpa: 5,
		qLateralKpa: 0,
		aoaDeg: 0,
		progradeAngle: -Math.PI / 2,
		stageIndex: 0,
		stages: [
			{ dryMassT: 30, fuelMassT: 300, oxidMassT: 100, isp: 300 }, // Stg 1
			{ dryMassT: 5, fuelMassT: 90, oxidMassT: 25, isp: 348 }     // Stg 2
		]
	};

	fc.update(sensor);
	const telem = fc.getTelemetry();

	assert.ok(telem.altM >= 49999 && telem.altM <= 50001, 'Altitude should be ~50,000m');
	assert.ok(telem.vV > 900, 'Vertical velocity should be positive upwards (~1000 m/s)');
	assert.ok(telem.remDv > 3000, 'Remaining Delta-V should include both stage 1 and stage 2');
});

test('LaunchSequencer - Lifecycle and Event dispatching', () => {
	const sequencer = new LaunchSequencer();
	assert.equal(sequencer.isActive, false);

	const dispatchedEvents = [];
	const testSequence = {
		tMinusOffset: 10,
		events: [
			{ time: 0, command: 'START_COUNTDOWN', name: 'COUNTDOWN START' },
			{ time: 5, command: 'AUTO_SEQUENCE_START', name: 'AUTO SEQUENCE' },
			{ time: 8, command: 'IGNITE_ENGINE', name: 'MAIN ENGINE START' },
			{ time: 10, command: 'RELEASE_HOLD_DOWN', name: 'LIFTOFF' }
		]
	};

	const onStart = (seq) => dispatchedEvents.push('start');
	const onAuto = () => dispatchedEvents.push('auto-start');
	const onLiftoff = () => dispatchedEvents.push('liftoff');
	const onAbort = () => dispatchedEvents.push('abort');

	EventBus.on('sequencer-start', onStart);
	EventBus.on('auto-sequence-start', onAuto);
	EventBus.on('liftoff', onLiftoff);
	EventBus.on('sequencer-abort', onAbort);

	sequencer.start(testSequence, 42);
	assert.equal(sequencer.isActive, true);
	assert.equal(sequencer.rocketId, 42);

	// Step forward by 1s (T- 9s) -> triggers START_COUNTDOWN at t=0
	sequencer.update(1.0);
	assert.equal(sequencer.eventIndex, 1);

	// Step forward to t=6s (T- 4s) -> triggers AUTO_SEQUENCE_START at t=5
	sequencer.update(5.0);
	assert.equal(sequencer.eventIndex, 2);
	assert.equal(sequencer.isAutoSequence, true);

	// Abort test
	sequencer.abort();
	assert.equal(sequencer.isActive, false);
	assert.ok(dispatchedEvents.includes('abort'));

	// Cleanup listeners
	EventBus.off('sequencer-start', onStart);
	EventBus.off('auto-sequence-start', onAuto);
	EventBus.off('liftoff', onLiftoff);
	EventBus.off('sequencer-abort', onAbort);
});

test('RocketLauncher - Preset loading and transform calculation', () => {
	const universe = createMockUniverse();
	const earth = createMockCelestialBody({
		id: 1,
		name: 'Earth',
		x: 0,
		y: 0,
		mass: 5.972e24,
		radius: 6371000,
		vx: 0,
		vy: 0
	});
	universe.objects.push(earth);

	const launcher = new RocketLauncher(universe);
	launcher.mode = 'host';
	launcher.hostId = earth.id;
	launcher.hostAngleDeg = 0; // Top of Earth
	launcher.hostAltitudeM = 10;

	// Check preset loading
	launcher.loadPreset('FALCON9');
	assert.equal(launcher.currentPresetId, 'FALCON9');
	assert.equal(launcher.stages.length, 2);
	assert.equal(launcher.payload.name, 'Satellite Payload');

	// Check transform
	const transform = launcher._calculateTransform();
	assert.ok(transform, 'Transform should be calculated');
	assert.ok(Math.abs(transform.x) < 1e-10, 'Launcher x should be ~0');
	// Radius in meters converted to pixels
	assert.ok(transform.y < 0, 'Launcher y should be at zenith (negative y in canvas coords)');

	// Toggle preview
	launcher.togglePreview(true);
	assert.equal(launcher.isActive, true);
	launcher.togglePreview(false);
	assert.equal(launcher.isActive, false);
});

test('RocketLauncher - Rollout places vehicle on launch pad with hold-down state', () => {
	const universe = createMockUniverse();
	const earth = createMockCelestialBody({
		id: 1,
		name: 'Earth',
		x: 0,
		y: 0,
		mass: 5.972e24,
		radius: 6371000
	});
	universe.objects.push(earth);

	let nextObjId = 500;
	universe.ObjectManager = {
		getNextId() { return nextObjId++; },
		addObject(obj) { universe.objects.push(obj); }
	};
	universe.ObjectPlacer = {
		placeObject(name, x, y, vx, vy, options) {
			const obj = {
				id: nextObjId++,
				name: name,
				x, y, vx, vy,
				isHoldDown: options?.isHoldDown !== undefined ? options.isHoldDown : true,
				stages: options?.stages || [],
				payload: options?.payload || {}
			};
			universe.objects.push(obj);
			return obj;
		}
	};

	const launcher = new RocketLauncher(universe);
	launcher.mode = 'host';
	launcher.hostId = earth.id;
	launcher.hostAngleDeg = 0;
	launcher.hostAltitudeM = 10;

	launcher.rollout();
	assert.ok(launcher.rolloutedRocketId !== null, 'Rocket ID should be assigned upon rollout');

	const placedRocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
	assert.ok(placedRocket, 'Placed rocket should exist in universe');
	assert.equal(placedRocket.isHoldDown, true, 'Vehicle on pad must be in hold-down state');

	// Draw target marker on canvas context
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	launcher.rolloutedRocketId = null; // enable marker drawing
	launcher.drawTargetMarker(ctx, earth, 1.0);
});

test('TrajectoryPredictor - Geometric rotation and rendering pipeline', () => {
	const dummyPrediction = {
		hostId: 1,
		isOrbital: false,
		points: [
			{ relX: 0, relY: -6371000, altM: 0, time: 0 },
			{ relX: 1000, relY: -6400000, altM: 29000, time: 10 }
		],
		events: [
			{ time: 5, name: 'MECO-1', type: 'MECO', relX: 500, relY: -6385000 }
		],
		baseHostAngleRad: 0
	};

	// Rotate prediction by 90 degrees (Math.PI / 2)
	const rotAngle = Math.PI / 2;
	const rotated = TrajectoryPredictor.rotatePrediction(dummyPrediction, rotAngle);
	assert.ok(rotated, 'Rotated prediction must be generated');
	assert.equal(rotated.points.length, 2);
	// Point (0, -R) rotated by 90 deg -> (R, 0)
	assert.ok(rotated.points[0].relX > 6000000, 'Rotated relX should be near +R');
	assert.ok(Math.abs(rotated.points[0].relY) < 100, 'Rotated relY should be near 0');

	// Render prediction with TrajectoryPredictor
	const universe = createMockUniverse();
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	universe.objects.push(earth);

	const predictor = new TrajectoryPredictor(universe);
	predictor.prediction = rotated;

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const renderContext = {
		name: 'main',
		ctx: ctx,
		basis: earth,
		zoomScale: 0.0001,
		trailLengthAU: 1.0
	};

	predictor.render(ctx, renderContext, { mode: 'preview' });
});

test('TrajectoryPredictor - Synchronous calculation, event tracking and parameter building', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, mass: 5.972e24, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const predictor = new TrajectoryPredictor(universe);

	const config = {
		host: earth,
		fuelType: 'liquid',
		thrustKN: 7600,
		fuelMassT: 140,
		oxidMassT: 280,
		stages: [
			{ dryMassT: 25, fuelMassT: 140, oxidMassT: 280, thrustKN: 7600, burnTime: 160, ispSec: 300 }
		],
		flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }],
		hostAngleRad: -Math.PI / 2,
		hostAltitudeM: 0
	};

	const result = predictor.calculateSync(config);
	assert.ok(result, 'Prediction result must be calculated synchronously');
	assert.ok(result.points.length > 0, 'Trajectory points must be generated');

	// Event tracking against flying rocket
	const mockFlyingRocket = createMockRocket({
		id: 101,
		flightTime: 50,
		telemetry: { altM: 35000, stageIndex: 0, isIgnited: true },
		predictedTrajectory: result,
		passedEventIds: new Set()
	});
	TrajectoryPredictor.updateRocketFlightEvents(mockFlyingRocket);
});

test('RocketLauncher - Free placement mode, custom stages, and preview drawing', () => {
	const universe = createMockUniverse();
	const launcher = new RocketLauncher(universe);

	// Test free mode
	launcher.mode = 'free';
	launcher.freeX = 100;
	launcher.freeY = 200;
	launcher.freeVx = 10;
	launcher.freeVy = -20;
	const tf = launcher._calculateTransform();
	assert.equal(tf.x, 100);
	assert.equal(tf.y, 200);
	assert.equal(tf.vx, 0);
	assert.equal(tf.vy, 0);

	// Test adding custom stage
	launcher.stages.push({
		stageNumber: 3,
		dryMassT: 2.0,
		fuelMassT: 10.0,
		oxidMassT: 20.0,
		thrustKN: 200,
		burnTime: 300,
		ispSec: 350
	});
	assert.equal(launcher.stages.length, 3);

	// Preview draw
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	launcher.drawPreview(ctx, { x: 0, y: 0 }, 1.0, {});
});

test('TrajectoryPredictor - Worker response handling, request coalescing, event detection, and onscreen markers', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const predictor = new TrajectoryPredictor(universe);

	// 1. Worker message handling & Pending callbacks
	let receivedResult = null;
	predictor._pendingCallbacks.set(1, (res) => { receivedResult = res; });
	predictor._latestProcessedId = 0;
	predictor._isBusy = true;

	const dummyPredictionData = {
		cmd: 'predictionResult',
		requestId: 1,
		hostId: 1,
		points: [
			{ relX: 0, relY: 0, time: 0, altM: 0 },
			{ relX: 100, relY: 100, time: 100, altM: 29000 },
			{ relX: 200, relY: 200, time: 200, altM: 50000 }
		],
		events: [
			{ id: 'liftoff', name: 'LIFTOFF', relX: 10, relY: 10, time: 0, type: 'liftoff', passed: true },
			{ id: 'meco', name: 'MECO', relX: 50, relY: 50, time: 80, type: 'meco', passed: false },
			{ id: 'impact', name: 'IMPACT', relX: 100, relY: 100, time: 200, type: 'impact', passed: false }
		],
		isOrbital: false,
		maxAltM: 50000,
		maxQ: 35000
	};

	// Next pending request queue
	const config = {
		host: earth,
		dryMassT: 20,
		fuelMassT: 100,
		oxidMassT: 200,
		thrustKN: 5000
	};
	predictor._nextPendingRequest = { config, callback: () => {} };

	// Invoke Worker onmessage handler directly
	if (predictor._worker && predictor._worker.onmessage) {
		predictor._worker.onmessage({ data: dummyPredictionData });
		assert.equal(receivedResult?.hostId, 1);
	} else {
		predictor.prediction = dummyPredictionData;
	}

	// Invoke Worker onerror handler
	if (predictor._worker && predictor._worker.onerror) {
		const origWarn = console.warn;
		console.warn = () => {};
		predictor._worker.onerror(new Error('simulated worker error'));
		console.warn = origWarn;
		assert.equal(predictor._isBusy, false);
	}

	// 2. Request prediction when busy -> coalescing
	predictor._isBusy = true;
	predictor.requestPrediction(config);
	assert.ok(predictor._nextPendingRequest !== null);
	predictor._isBusy = false;

	// 3. calculate() invocation
	const calcRes = predictor.calculate(config);
	assert.ok(calcRes);

	// 4. Update all flight event types against rocket telemetry
	const comprehensiveEvents = [
		{ id: 'liftoff', type: 'liftoff', time: 0 },
		{ id: 'pitch', type: 'pitch', time: 5, altM: 500 },
		{ id: 'maxq', type: 'maxq', altM: 10000 },
		{ id: 'meco', type: 'meco', time: 100 },
		{ id: 'stg_meco', type: 'stg_meco', time: 120 },
		{ id: 'staging', type: 'staging', time: 125 },
		{ id: 'ignition', type: 'ignition', time: 130 },
		{ id: 'fairing', type: 'fairing', time: 140 },
		{ id: 'alt_evt', type: 'alt', value: 20000 },
		{ id: 'time_evt', type: 'time', value: 150 },
		{ id: 'apoapsis', type: 'apoapsis' },
		{ id: 'orbit', type: 'orbit', time: 500 }
	];

	const rocketForEvents = createMockRocket({
		id: 777,
		hostId: 1,
		isHoldDown: false,
		isIgnited: true,
		currentStageIndex: 1,
		totalStages: 2,
		fuelMass: 0,
		burnTime: 0,
		flightTime: 200,
		telemetry: {
			status: 5,
			altM: 25000,
			vV: -10,
			isFairingSeparated: true,
			flightTime: 200
		},
		predictedTrajectory: { events: comprehensiveEvents, hostId: 1 },
		passedEventIds: new Set()
	});

	const renderContextEvents = {
		basis: earth,
		objectsMap: new Map([[1, earth]])
	};
	TrajectoryPredictor.updateRocketFlightEvents(rocketForEvents, renderContextEvents);
	assert.ok(rocketForEvents.passedEventIds.size > 0, 'Multiple events should be marked as passed');

	// 5. Render trajectory with onscreen coordinates to hit all drawing paths
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const renderContext = {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0,
		objects: [earth],
		objectsMap: new Map([[earth.id, earth]])
	};

	TrajectoryPredictor.renderTrajectory(ctx, renderContext, dummyPredictionData, {
		mode: 'flight',
		passedEventIds: new Set(['liftoff']),
		currentFlightTime: 50,
		showPredictedTrajectory: true,
		actualFlightPath: [{ relX: 0, relY: 0 }, { relX: 50, relY: 50 }],
		rocketX: 50,
		rocketY: 50,
		rotationOffset: 0.1
	});

	// Call instance render() method
	predictor.prediction = dummyPredictionData;
	predictor.render(ctx, renderContext);

	// Rotate prediction
	const rotated = TrajectoryPredictor.rotatePrediction(dummyPredictionData, Math.PI / 4);
	assert.ok(rotated.points.length > 0);

	predictor.destroy();
});

test('RocketLauncher - State serialization (getState, loadState), abort rollout, and ignition', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);

	// Rollout
	launcher.hostId = earth.id;
	launcher.rollout();
	assert.ok(launcher.rolloutedRocketId !== null);

	// Test draw while rollouted with cached prediction
	launcher.currentPrediction = {
		baseHostAngleRad: 0,
		points: [{ relX: 0, relY: -6371000, time: 0, altM: 0 }],
		events: []
	};
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	launcher.drawPreview(ctx, earth, 1.0, { ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 } });

	// Ignite
	launcher.ignite('LEGACY_QUICK');

	// Abort Rollout
	launcher.abortRollout();
	assert.equal(launcher.rolloutedRocketId, null);

	// State serialization
	const state = launcher.getState();
	assert.equal(state.mode, 'host');
	assert.ok(Array.isArray(state.stages));

	// Load state
	launcher.loadState({
		...state,
		hostAngleDeg: 45,
		hostAltitudeM: 500,
		thrustKN: 8000
	});
	assert.equal(launcher.hostAngleDeg, 45);
	assert.equal(launcher.hostAltitudeM, 500);
	assert.equal(launcher.thrustKN, 8000);
});

test('normalizeRocketConfig - Multi-stage and legacy config conversions and fallbacks', () => {
	// 1. null config
	assert.equal(normalizeRocketConfig(null), null);

	// 2. Multi-stage with explicit values
	const explicitMS = {
		stages: [{
			stageNumber: 1,
			name: 'First Stage',
			fuelType: 'solid',
			thrustKN: 5000,
			dryMassT: 15,
			fuelMassT: 60,
			oxidMassT: 120,
			burnTime: 140,
			ofRatio: 2.0,
			radius: 2.2,
			separationDelaySec: 3,
			ignitionDelaySec: 1.5,
			jettisonSpeedM_S: 8
		}],
		payload: { name: 'Dragon', massT: 6, radius: 1.8 },
		fairing: { enabled: true, massT: 1.5, separationAltKm: 105 }
	};
	const normMS = normalizeRocketConfig(explicitMS);
	assert.equal(normMS.stages[0].name, 'First Stage');
	assert.equal(normMS.stages[0].fuelType, 'solid');
	assert.equal(normMS.stages[0].thrustKN, 5000);
	assert.equal(normMS.payload.name, 'Dragon');
	assert.equal(normMS.fairing.enabled, true);

	// 3. Multi-stage with missing stage attributes & missing payload/fairing
	const sparseMS = {
		stages: [{}]
	};
	const normSparse = normalizeRocketConfig(sparseMS);
	assert.equal(normSparse.stages[0].stageNumber, 1);
	assert.equal(normSparse.stages[0].name, 'Stage 1');
	assert.equal(normSparse.stages[0].thrustKN, 7600);
	assert.equal(normSparse.stages[0].dryMassT, 7);
	assert.equal(normSparse.stages[0].fuelMassT, 88);
	assert.equal(normSparse.stages[0].oxidMassT, 220);
	assert.equal(normSparse.stages[0].burnTime, 160);
	assert.equal(normSparse.payload.name, 'Payload');
	assert.equal(normSparse.fairing.enabled, false);

	// 4. Legacy config with modern property names
	const leg1 = {
		dryMassT: 10,
		fuelMassT: 50,
		oxidMassT: 110,
		thrustKN: 3500,
		burnTime: 130,
		ofRatio: 2.2,
		radius: 2.0,
		fuelType: 'kerolox'
	};
	const normLeg1 = normalizeRocketConfig(leg1);
	assert.equal(normLeg1.stages.length, 1);
	assert.equal(normLeg1.stages[0].dryMassT, 10);
	assert.equal(normLeg1.stages[0].thrustKN, 3500);
	assert.equal(normLeg1.stages[0].fuelType, 'kerolox');

	// 5. Legacy config with older property names (emptyMass, thrustForce, time)
	const leg2 = {
		emptyMass: 8,
		fuelMass: 40,
		oxidMass: 90,
		thrustForce: 2500000,
		time: 100
	};
	const normLeg2 = normalizeRocketConfig(leg2);
	assert.equal(normLeg2.stages[0].dryMassT, 8);
	assert.equal(normLeg2.stages[0].thrustKN, 2500);
	assert.equal(normLeg2.stages[0].burnTime, 100);

	// 6. Legacy empty config
	const normEmpty = normalizeRocketConfig({});
	assert.equal(normEmpty.stages[0].dryMassT, 7);
	assert.equal(normEmpty.stages[0].thrustKN, 7600);
});

test('DebrisGenerator - Zero mass, coincident impact point, and naming branches', () => {
	const m2pix = (m) => m / 1000;
	let idCounter = 100;
	const getNextId = () => idCounter++;

	const loser = {
		id: 1,
		name: 'Satellite Debris', // already ends with ' Debris'
		x: 500,
		y: 500,
		radius: 5,
		mass: 200,
		color: '#ff8800',
		generation: 0,
		vx: 10,
		vy: 20
	};

	// 1. totalDebrisMass <= 0 branch
	const resZero = DebrisGenerator.generateFromImpact(loser, 0, 10, 20, 500, 500, 10, m2pix, getNextId);
	assert.equal(resZero.debrisList.length, 0);

	// 2. Coincident impact point (dist === 0)
	const resCoincident = DebrisGenerator.generateFromImpact(loser, 50, 10, 20, 500, 500, 10, m2pix, getNextId);
	assert.ok(resCoincident.debrisList.length > 0);
	assert.equal(resCoincident.debrisList[0].name, 'Satellite Debris');

	// 3. Shatter generation
	const asteroid = {
		id: 2,
		name: 'Asteroid',
		x: 1000,
		y: 1000,
		radius: 50,
		mass: 50000,
		color: '#aaaaaa',
		generation: 0,
		vx: 5,
		vy: -5
	};
	const resShatter = DebrisGenerator.generateFromShatter(asteroid, m2pix, getNextId);
	assert.ok(resShatter.debrisList.length > 0);
	assert.ok(resShatter.debrisList[0].name.includes('Asteroid Debris'));
});

test('RocketLauncher - Event hooks, free mode position, prediction throttle, and preview rendering', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, mass: 5.972e24 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;

	// 1. Rollout rocket and test EventBus hooks
	launcher.rollout();
	assert.ok(launcher.rolloutedRocketId !== null);
	const rolloutedRocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
	rolloutedRocket.telemetry = { flightTime: 10 };

	// Internal power sequencer-event
	EventBus.emit('sequencer-event', 'SWITCH TO INTERNAL POWER');
	assert.equal(rolloutedRocket.isInternalPower, true);

	// Sequencer start and abort events
	EventBus.emit('sequencer-start');
	EventBus.emit('sequencer-abort');

	// Liftoff event with cached prediction
	launcher.currentPrediction = {
		baseHostAngleRad: 0,
		points: [{ relX: 0, relY: -6371000, time: 0, altM: 0 }],
		events: []
	};
	EventBus.emit('liftoff');
	assert.equal(launcher.rolloutedRocketId, null);
	assert.equal(rolloutedRocket.isInternalPower, false);

	// 2. Free mode transform and preview
	launcher.mode = 'free';
	launcher.setFreePosition(500, -800);
	assert.equal(launcher.freeX, 500);
	assert.equal(launcher.freeY, -800);
	const tf = launcher._calculateTransform();
	assert.equal(tf.x, 500);
	assert.equal(tf.y, -800);

	// Toggle preview
	launcher.togglePreview(true);
	assert.equal(launcher.isActive, true);
	launcher.togglePreview(false);
	assert.equal(launcher.isActive, false);

	// 3. Prediction updates: sync and cached throttle
	launcher.mode = 'host';
	launcher.hostId = earth.id;
	const syncPred = launcher.updatePredictionSync();
	assert.ok(syncPred !== null);

	// Repeated prediction without force (triggers throttle branch)
	const throttledPred = launcher.updatePrediction(false);
	assert.ok(throttledPred !== null);

	// Force update
	const forcedPred = launcher.updatePrediction(true);
	assert.ok(forcedPred !== null);

	// 4. drawPreview in free mode and suppression with flying rocket
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const rc = { ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 } };

	launcher.mode = 'free';
	launcher.isActive = true;
	launcher.drawPreview(ctx, earth, 1.0, rc);

	// Active flying rocket suppression branch
	const flyingRocket = createMockRocket({
		id: 888,
		state: OBJECT_STATE.ACTIVE,
		isHoldDown: false,
		predictedTrajectory: { points: [] }
	});
	universe.objects.push(flyingRocket);
	launcher.drawPreview(ctx, earth, 1.0, rc); // should return early safely

	// 5. Rollout rocket prediction context and requestPreviewUpdate suppression
	const fIdx = universe.objects.findIndex(o => o.id === 888);
	if (fIdx >= 0) universe.objects.splice(fIdx, 1);
	launcher.mode = 'host';
	launcher.rollout();
	launcher.requestPreviewUpdate(100); // early return branch when rolloutedRocketId !== null
	const rolloutPred = launcher.updatePredictionSync(); // exercises lines 301-311
	assert.ok(rolloutPred !== null);
	launcher.abortRollout();

	// updatePredictionSync with invalid hostId to trigger null branch
	launcher.hostId = 99999;
	const nullPred = launcher.updatePredictionSync();
	assert.equal(nullPred, null);
	launcher.hostId = earth.id;

	// drawPreview in host mode without rollouted rocket (lines 446-449)
	launcher.mode = 'host';
	launcher.isActive = true;
	launcher.currentPrediction = {
		hostId: earth.id,
		points: [{ relX: 0, relY: -6371000, time: 0, altM: 0 }, { relX: 0, relY: -6372000, time: 10, altM: 1000 }],
		events: []
	};
	launcher.drawPreview(ctx, earth, 1.0, rc);

	// EventBus onDrawAfter hook
	EventBus.emitDrawAfter(ctx, { name: 'main', basis: earth, zoomScale: 1.0 });

	// Debounced requestPreviewUpdate
	launcher.requestPreviewUpdate(50);

	// Prediction callback
	launcher.updatePrediction(false, (res) => {});
});

test('TrajectoryPredictor - Edge cases, render culling, and event status detection', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, mass: 5.972e24 });
	const universe = createMockUniverse({ objects: [earth] });
	const predictor = new TrajectoryPredictor(universe);

	// 1. calculate() with existing prediction vs fallback
	predictor.prediction = { points: [{ relX: 0, relY: 0, time: 0, altM: 0 }] };
	const resCached = predictor.calculate({});
	assert.equal(resCached, predictor.prediction);

	// 2. render() early return on missing prediction
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const rc = { ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, showPredictedTrajectory: false };
	predictor.prediction = null;
	predictor.render(ctx, rc); // should return early safely

	// 3. Static renderTrajectory edge cases:
	// Missing points
	TrajectoryPredictor.renderTrajectory(ctx, rc, { hostId: 1, points: [] });
	// Unknown host
	TrajectoryPredictor.renderTrajectory(ctx, rc, { hostId: 999, points: [{ relX: 0, relY: 0 }, { relX: 1, relY: 1 }] });
	// Flight time expired culling
	const predValid = {
		hostId: 1,
		maxSimTime: 100,
		points: [{ relX: 0, relY: -6371000, time: 0, altM: 0 }, { relX: 10, relY: -6371100, time: 100, altM: 100 }],
		events: []
	};
	TrajectoryPredictor.renderTrajectory(ctx, rc, predValid, {
		mode: 'flight',
		currentFlightTime: 150
	});

	// 4. updateRocketFlightEvents: orbit and impact events
	const mockRocket = createMockRocket({
		id: 777,
		x: 0,
		y: -6371000 - 200000,
		vx: 7800,
		vy: 0,
		state: OBJECT_STATE.ACTIVE,
		isDestroyed: false,
		flightTime: 500,
		passedEventIds: new Set(),
		telemetry: {
			status: 2,
			altM: 250000,
			vV: 50,
			flightTime: 500
		}
	});
	const predEvents = {
		hostId: 1,
		events: [
			{ id: 'orbit_1', type: 'orbit', time: 400, passed: false },
			{ id: 'impact_1', type: 'impact', time: 600, passed: false }
		]
	};
	mockRocket.predictedTrajectory = predEvents;
	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objects: [earth] });
	assert.ok(mockRocket.passedEventIds.has('orbit_1'), 'Orbit event should pass at orbital altitude & speed');

	mockRocket.isDestroyed = true;
	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { basis: earth, objects: [earth] });
	assert.ok(mockRocket.passedEventIds.has('impact_1'), 'Impact event should pass when rocket is destroyed');

	// 5. rotatePrediction edge cases
	assert.equal(TrajectoryPredictor.rotatePrediction(null, 0.5), null);
	const unrotated = TrajectoryPredictor.rotatePrediction(predValid, 0);
	assert.equal(unrotated.points.length, predValid.points.length);

	// 6. _buildSimulationParams with relative velocities
	const simParamsRelV = predictor._buildSimulationParams({
		host: earth,
		relVx: 100,
		relVy: 200,
		x: 0,
		y: -6371000
	});
	assert.ok(simParamsRelV !== null);

	// 7. calculate fallback when prediction is null
	predictor.prediction = null;
	const syncCalculated = predictor.calculate({ host: earth, x: 0, y: -6371000 });
	assert.ok(syncCalculated !== null);

	// 8. Instance render() with valid prediction
	predictor.prediction = predValid;
	predictor.render(ctx, { ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, objects: [earth] });

	// 9. Full renderTrajectory with actualFlightPath and onscreen/offscreen events
	const richPrediction = {
		hostId: 1,
		maxSimTime: 500,
		points: [
			{ relX: 0, relY: -6371000, time: 0, altM: 0 },
			{ relX: 100, relY: -6380000, time: 50, altM: 9000 },
			{ relX: 1000000, relY: -7000000, time: 100, altM: 700000 }, // out of screen
			{ relX: 200, relY: -6390000, time: 150, altM: 19000 }
		],
		events: [
			{ id: 'ev_impact', type: 'impact', relX: 0, relY: -6371000, label: 'IMPACT', time: 0 },
			{ id: 'ev_meco', type: 'meco', relX: 50, relY: -6375000, label: 'MECO', time: 50 },
			{ id: 'ev_far', type: 'orbit', relX: 1e9, relY: 1e9, label: 'FAR', time: 200 } // offscreen event
		]
	};

	// Flight time expired branch (lines 452-454)
	TrajectoryPredictor.renderTrajectory(ctx, {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		objects: [earth]
	}, richPrediction, {
		mode: 'flight',
		currentFlightTime: 600 // > maxSimTime (500)
	});

	// Normal flight trajectory rendering with tip replacement (lines 591-592)
	TrajectoryPredictor.renderTrajectory(ctx, {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		objects: [earth]
	}, richPrediction, {
		mode: 'flight',
		currentFlightTime: 100,
		actualFlightPath: [
			{ relX: 0, relY: -6371000 },
			{ relX: 50, relY: -6375000 },
			{ relX: 100, relY: -6380000 }
		],
		rocketX: earth.x + 100,
		rocketY: earth.y - 6380000 // exact tip match without rotation
	});

	// 10. Direct requestPrediction synchronous fallback with callback (lines 243-248)
	let reqPredInvoked = false;
	const testCfg = {
		host: earth,
		x: 0,
		y: -6371000,
		vx: 0,
		vy: 0,
		thrustKN: 7600,
		dryMassT: 25,
		fuelMassT: 88,
		oxidMassT: 220
	};
	const origWorker = predictor._worker;
	predictor._worker = null;
	predictor._isBusy = false;
	predictor.requestPrediction(testCfg, (res) => {
		reqPredInvoked = true;
	});
	assert.equal(reqPredInvoked, true);
	predictor._worker = origWorker;

	// 11. render with renderContext having false flags
	predictor.render(ctx, {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		objects: [earth],
		showPredictedTrajectory: false,
		showActualFlightPath: false
	});

	predictor.destroy();
});

test('RocketLauncher - drawTargetMarker blueprint render, rollout preview, and async requestPrediction callback', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, vx: 0, vy: 0 });
	const customHost = createMockCelestialBody({ id: 2, name: 'Asteroid', x: 1000, y: 1000, radius: 500, vx: 0, vy: 0 });
	const universe = createMockUniverse({ objects: [earth, customHost] });
	const launcher = new RocketLauncher(universe);

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	// 1. drawTargetMarker blueprint box & launch angle vector
	launcher.mode = 'host';
	launcher.hostId = earth.id;
	launcher.rolloutedRocketId = null;
	launcher.flightProfile = [{ angle: 45, thrust: 100, type: 'time', value: 10 }];
	launcher.drawTargetMarker(ctx, earth, 1.0);

	// 2. _calculateTransform branches: zero thrust, and host without rotation period
	launcher.thrustKN = 0;
	launcher._calculateTransform();
	launcher.thrustKN = 7600;

	launcher.hostId = customHost.id;
	launcher._calculateTransform(); // Asteroid has no ROTATION_PERIOD
	launcher.hostId = earth.id;

	// 3. requestPreviewUpdate branches (delayMs <= 0 vs delayMs > 0, isActive false)
	launcher.requestPreviewUpdate(0);
	launcher.requestPreviewUpdate(50);
	launcher.isActive = false;
	launcher.requestPreviewUpdate(10);
	launcher.isActive = true;

	// 4. togglePreview and mode branches
	launcher.togglePreview(true);
	launcher.togglePreview(false);
	launcher.mode = 'free';
	launcher.mode = 'host';

	// Early return checks
	launcher.mode = 'free';
	launcher.drawTargetMarker(ctx, earth, 1.0); // mode !== 'host'
	launcher.mode = 'host';
	launcher.rolloutedRocketId = 999;
	launcher.drawTargetMarker(ctx, earth, 1.0); // rolloutedRocketId !== null
	launcher.rolloutedRocketId = null;
	launcher.hostId = 9999;
	launcher.drawTargetMarker(ctx, earth, 1.0); // unknown host

	// 5. drawPreview when rocket is rollouted on pad
	const rolloutRocket = createMockRocket({ id: 555, isHoldDown: true, x: 0, y: -6371000 });
	universe.objects.push(rolloutRocket);
	launcher.hostId = earth.id;
	launcher.rolloutedRocketId = 555;
	launcher.currentPrediction = {
		hostId: earth.id,
		baseHostAngleRad: 0,
		points: [{ relX: 0, relY: 0 }, { relX: 10, relY: 10 }]
	};
	launcher.drawPreview(ctx, earth, 1.0, { basis: earth, zoomScale: 1.0, objects: [earth, rolloutRocket] });

	// 6. updatePrediction async callback execution (lines 392-402)
	launcher.rolloutedRocketId = null;
	launcher._lastPredictKey = '';
	launcher._lastPredictTime = 0;
	const overlayEl = createMockElement('div');
	overlayEl.id = 'prediction-processing-overlay';
	document.body.appendChild(overlayEl);

	const origRequest = launcher.predictor.requestPrediction;
	let callbackInvoked = false;
	launcher.predictor.requestPrediction = (cfg, cb) => {
		cb({ hostId: earth.id, points: [] });
	};

	launcher.updatePrediction(false, (pred) => {
		callbackInvoked = true;
	});
	assert.equal(callbackInvoked, true);

	// Test without prediction (null prediction branch) and without onComplete
	launcher._lastPredictKey = '';
	launcher._lastPredictTime = 0;
	launcher.predictor.requestPrediction = (cfg, cb) => {
		cb(null);
	};
	launcher.updatePrediction(false);

	// Test with overlay missing
	document.body.removeChild(overlayEl);
	launcher._lastPredictKey = '';
	launcher._lastPredictTime = 0;
	launcher.updatePrediction(false);

	// Test prediction fallback when predictor.prediction exists
	launcher.predictor.prediction = { points: [] };
	launcher._lastPredictKey = '';
	launcher._lastPredictTime = 0;
	launcher.updatePrediction(false);

	launcher.predictor.requestPrediction = origRequest;

	// 7. ignite edge cases: no rollouted rocket, and invalid sequence
	launcher.rolloutedRocketId = null;
	launcher.ignite('AUTO_COUNTDOWN'); // returns early
	launcher.rolloutedRocketId = 555;
	launcher.ignite('INVALID_SEQUENCE_KEY'); // sequence not found returns early

	// 8. abortRollout when rocket is already gone from objects
	launcher.rolloutedRocketId = 999999;
	launcher.abortRollout();

	// 9. loadState null or partial
	launcher.loadState(null);
	launcher.loadState({ mode: 'free', stages: null, payload: null, fairing: null });
});

test('FlightComputer - Sun-pointing attitude orientation after payload separation', () => {
	const fc = new FlightComputer({ maxGLimit: 3.5 });

	// Sun at (1e11, 0)
	const sunX = 1e11;
	const sunY = 0;
	const rocketX = 0;
	const rocketY = 0;
	const expectedAngleToSun = 0.0;

	// 1. Before payload separation, coasting: tracks progradeAngle (Math.PI / 2)
	const coastSensor = {
		burnTime: 0,
		isHoldDown: false,
		isIgnited: false,
		isPayloadSeparated: false,
		dt: 1.0,
		x: rocketX,
		y: rocketY,
		progradeAngle: Math.PI / 2,
		gravityAngle: -Math.PI / 2,
		qAxialKpa: 0,
		qLateralKpa: 0,
		aoaDeg: 0,
		altM: 200000,
		vV: 0,
		vH: 7800,
		mass: 50,
		dryMass: 50,
		fuelMass: 0,
		thrustForce: 0,
		thrustRatio: 0,
		massLossRate: 0,
		sunX,
		sunY
	};

	fc.update(coastSensor);
	assertClose(fc.currentThrustAngleRad, Math.PI / 2, 0.2);

	// 2. After payload separation: smoothly rotates to face the Sun (0.0 rad)
	const payloadSensor = {
		...coastSensor,
		isPayloadSeparated: true
	};

	for (let i = 0; i < 15; i++) {
		fc.update(payloadSensor);
	}

	assertClose(fc.currentThrustAngleRad, expectedAngleToSun, 1e-3);
});

test('Slingshot Rocket - Preserves fairing and prevents stage separation', () => {
	const engine = new PhysicsEngine();
	const f9 = createFalcon9Config();

	engine.addObject({
		id: 1,
		name: 'Earth',
		type: OBJECT_TYPES.CELESTIAL,
		x: 0, y: 0, vx: 0, vy: 0,
		mass: 5.972e24, radius: 6371000
	});

	// Slingshot rocket with disableStaging: true
	const slingshotRocket = engine.addObject({
		id: 700,
		name: 'Slingshot-F9',
		type: OBJECT_TYPES.ROCKET,
		x: 0, y: 6371000 + 150000, // 150 km altitude (above 100km separation threshold)
		vx: 5000, vy: 0,
		mass: f9.totalMassT, radius: 1.85,
		fuelMass: 0, oxidMass: 0,
		thrustForce: 0, burnTime: 0,
		stages: f9.stages, payload: f9.payload, fairing: f9.fairing,
		isHoldDown: false, isIgnited: false,
		disableStaging: true
	});

	for (let i = 0; i < 20; i++) {
		engine._calculateForces();
		engine._updateFlightControl(0.1);
	}

	const debris = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS);
	assert.equal(debris.length, 0, 'Slingshot rocket must never generate stage or fairing debris');
	assert.equal(slingshotRocket.fairing.isSeparated, false, 'Fairing must remain attached');
	assert.equal(slingshotRocket.currentStageIndex, 0, 'Stage index must remain 0');
	assert.equal(slingshotRocket.isPayloadSeparated, false, 'Payload must not separate');
});

test('RocketLauncher - Nozzle bottom offset calculation on rollout and transform', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	const offsets = ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET;

	// Falcon 9 (70m baseRadius -> 70 * 3.10 = 217m offset)
	launcher.currentPresetId = 'FALCON9';
	assert.equal(launcher.getBaseRadiusM(), 70.0);
	assert.equal(launcher.getBottomOffsetM(), 70.0 * offsets.TWO_STAGE);

	// H3 (63m baseRadius -> 63 * 3.10 = 195.3m offset)
	launcher.currentPresetId = 'H3';
	assert.equal(launcher.getBaseRadiusM(), 63.0);
	assert.equal(launcher.getBottomOffsetM(), 63.0 * offsets.TWO_STAGE);

	// Epsilon (26m baseRadius -> 26 * 3.45 = 89.7m offset)
	launcher.currentPresetId = 'EPSILON';
	assert.equal(launcher.getBaseRadiusM(), 26.0);
	assert.equal(launcher.getBottomOffsetM(), 26.0 * offsets.THREE_STAGE);

	// SSTO (50m baseRadius -> 50 * 1.85 = 92.5m offset)
	launcher.currentPresetId = 'SSTO';
	assert.equal(launcher.getBaseRadiusM(), 50.0);
	assert.equal(launcher.getBottomOffsetM(), 50.0 * offsets.SINGLE_STAGE);

	// Transform distance includes bottomOffsetM + hostAltitudeM
	launcher.hostId = earth.id;
	launcher.hostAltitudeM = 15;
	const tf = launcher._calculateTransform();
	assert.ok(tf);
	const distM = UnitConvertUtils.pix2m(Math.hypot(tf.x - earth.x, tf.y - earth.y));
	assertClose(distM, earth.radius + launcher.getBottomOffsetM() + 15, 1e-3);
});

test('RocketLauncher - Falcon 9 stage burn time preservation and rollout synchronization', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.loadPreset('FALCON9');

	launcher.hostId = earth.id;
	assert.equal(launcher.stages[0].burnTime, 162.0, 'Preset burn time should be 162.0s');

	launcher.rollout();
	assert.equal(launcher.stages[0].burnTime, 162.0, 'Rollout should preserve 162.0s burn time without Isp overwrite');
	assert.equal(launcher.calculatedBurnTime, 162.0, 'Calculated burn time should match stage 0 burn time');
	assert.ok(launcher.currentPrediction, 'Prediction should be generated during rollout');
});

test('TrajectoryPredictor - Smooth Bezier polyline and surface-relative coordinate rendering', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	earth.rotationAngle = 0.5;

	const dummyPrediction = {
		hostId: earth.id,
		points: [
			{ r: 100, phiSurf: 0, altM: 0, time: 0 },
			{ r: 110, phiSurf: 0.05, altM: 1000, time: 10 },
			{ r: 120, phiSurf: 0.12, altM: 5000, time: 20 },
			{ r: 130, phiSurf: 0.20, altM: 12000, time: 30 }
		],
		events: [
			{ id: 'liftoff', name: 'LIFTOFF', type: 'liftoff', r: 100, phiSurf: 0, time: 0 },
			{ id: 'maxq', name: 'MAX-Q', type: 'maxq', r: 115, phiSurf: 0.08, time: 15 }
		],
		isOrbital: false,
		maxSimTime: 100
	};

	const quadCalls = [];
	const lineCalls = [];
	const mockCtx = {
		save() {},
		restore() {},
		beginPath() {},
		stroke() {},
		fill() {},
		moveTo(x, y) {},
		lineTo(x, y) { lineCalls.push({ x, y }); },
		quadraticCurveTo(cx, cy, x, y) { quadCalls.push({ cx, cy, x, y }); },
		arc() {},
		fillRect() {},
		fillText() {},
		measureText() { return { width: 40 }; },
		setLineDash() {},
		canvas: { width: 1000, height: 1000 }
	};

	const renderContext = {
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		objectsMap: new Map([[earth.id, earth]]),
		objects: [earth],
		showPredictedTrajectory: true,
		showActualFlightPath: true
	};

	TrajectoryPredictor.renderTrajectory(mockCtx, renderContext, dummyPrediction, {
		mode: 'flight',
		actualFlightPath: [
			{ r: 100, phiSurf: 0 },
			{ r: 105, phiSurf: 0.02 },
			{ r: 110, phiSurf: 0.05 },
			{ r: 115, phiSurf: 0.08 }
		],
		rocketX: 115 * Math.cos(0.58),
		rocketY: 115 * Math.sin(0.58)
	});

	assert.ok(lineCalls.length > 0, 'Standard polyline interpolation must call lineTo');

	// Also verify smooth mode explicitly if enabled
	const prevSmooth = RENDER.PREDICTED_TRAJECTORY.SMOOTH_CURVE_ENABLED;
	try {
		RENDER.PREDICTED_TRAJECTORY.SMOOTH_CURVE_ENABLED = true;
		TrajectoryPredictor.renderTrajectory(mockCtx, renderContext, dummyPrediction, {
			mode: 'flight',
			actualFlightPath: [
				{ r: 100, phiSurf: 0 },
				{ r: 105, phiSurf: 0.02 },
				{ r: 110, phiSurf: 0.05 },
				{ r: 115, phiSurf: 0.08 }
			],
			rocketX: 115 * Math.cos(0.58),
			rocketY: 115 * Math.sin(0.58)
		});
		assert.ok(quadCalls.length > 0, 'Smooth curve interpolation must call quadraticCurveTo when enabled');
	} finally {
		RENDER.PREDICTED_TRAJECTORY.SMOOTH_CURVE_ENABLED = prevSmooth;
	}
});

test('PadEffectRenderer - Bilateral water deluge spray emission', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const rocket = createMockRocket({ id: 101, isHoldDown: true, thrustAngle: -Math.PI / 2, radius: 2.0 });
	const pad = new PadEffectRenderer();
	pad.start(101, 1);
	pad.rocketRadius = 2.0;
	pad.startLaunchAngle = -Math.PI / 2;

	const mockContext = {
		rocket: rocket,
		host: earth,
		m2pix: (m) => m * 10,
		zoomScale: 1.0,
		padX_px: 0,
		padY_px: 0,
		isHoldDown: true
	};

	pad.handleEvent('T-15s WATER DELUGE');
	pad.update(0.05, mockContext);

	const delugeParticles = pad.particles.filter(p => p.type === 'deluge');
	assert.ok(delugeParticles.length > 0, 'Deluge particles should be emitted');

	// Verify bilateral emission: particles exist on both sides (x < 0 and x > 0 relative to thrust axis)
	const hasNegativeX = delugeParticles.some(p => p.x < 0);
	const hasPositiveX = delugeParticles.some(p => p.x > 0);
	assert.ok(hasNegativeX, 'Should have left manifold deluge particles');
	assert.ok(hasPositiveX, 'Should have right manifold deluge particles');
});

test('PhysicsEngine - Rocket launch collision safeguard and impact detection', () => {
	const engine = new PhysicsEngine();
	const earth = {
		id: 1,
		name: 'Earth',
		type: OBJECT_TYPES.CELESTIAL,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		ax: 0,
		ay: 0,
		radius: 6371000,
		mass: 5.972e21 // t
	};
	engine.addObject(earth);

	// Falcon 9 style rocket on pad with altitude = 0
	const rocketLength = MULTISTAGE_PRESETS.FALCON9?.lengthM || 70.0;
	const offsets = ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET;
	const bottomOffset = rocketLength * offsets.TWO_STAGE; // 217.0 m
	const initialR = earth.radius + bottomOffset; // rocket nozzle sits exactly at pad level

	const rocket = {
		id: 101,
		name: 'Falcon 9',
		type: OBJECT_TYPES.ROCKET,
		x: 0,
		y: -initialR,
		vx: 0,
		vy: -10, // Ascending upwards (canvas -Y is zenith)
		ax: 0,
		ay: -5,
		radius: bottomOffset,
		bottomOffsetM: bottomOffset,
		hostId: earth.id,
		isHoldDown: false,
		isIgnited: true,
		dryMass: 25,
		fuelMass: 140,
		oxidMass: 280,
		mass: 445
	};
	engine.addObject(rocket);

	// Build quadtree and check collisions
	engine._buildQuadTree(0.016);
	engine._checkCollisions(0.016);

	const rocketInEngine = engine.objects.find(o => o.id === 101);
	assert.ok(rocketInEngine, 'Rocket should exist in engine');
	assert.equal(rocketInEngine.collided, false, 'Ascending rocket at pad level must NOT collide with Earth');

	// Now simulate descending rocket penetrating surface: y falls below initialR
	rocketInEngine.vy = 20; // Falling back towards Earth
	rocketInEngine.y = -initialR + 1.0; // Sunk 1m below pad level
	engine._buildQuadTree(0.016);
	engine._checkCollisions(0.016);

	assert.equal(rocketInEngine.collided, true, 'Descending rocket penetrating below pad must collide with Earth');
});

test('Rocket - Smoke emission originates precisely from flame tip during burn and nozzle during cutoff', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, rotationAngle: 0 });
	const objects = [earth];

	// Create H3 style 2-stage rocket firing vertical (zenith: -PI/2)
	const baseRadiusM = 63.0;
	const offsets = ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET;
	const bottomOffset = baseRadiusM * offsets.TWO_STAGE;
	const rocket = new Rocket(201, 'H3', 0, -6371100, 0, -100, 25, 34, 206, '#fff', 5, bottomOffset, 0, null, 0, 'orange');
	rocket.stages = [
		{ stageNumber: 1, fuelType: 'hydro', thrustKN: 4500, burnTime: 235 },
		{ stageNumber: 2, fuelType: 'hydro', thrustKN: 200, burnTime: 618 }
	];
	rocket.baseRadiusM = baseRadiusM;
	rocket.bottomOffsetM = bottomOffset;
	rocket.thrustAngle = -Math.PI / 2; // Pointing upwards (-Y)
	rocket.dominantBodyId = earth.id;
	rocket.inAtmosphere = true;
	rocket.isHoldDown = false;
	rocket.isIgnited = true;
	rocket.burnTime = 100;
	rocket.thrustRatio = 1.0;

	// 1. Update history while burning: smoke point added to effectTrail
	rocket.updateHistory(1, objects);
	assert.ok(rocket.effectTrail.count > 0, 'EffectTrail should record points while firing');

	const burningPt = rocket.effectTrail.getPoint(rocket.effectTrail.count - 1);
	const distFromCenterM = UnitConvertUtils.pix2m(burningPt.y - rocket.y);
	const expectedNozzleDistM = baseRadiusM * offsets.TWO_STAGE;
	const expectedFlameLenM = baseRadiusM * ROCKET_VISUAL.PLUMES.hydro.lenMult * 1.0 * 1.0;
	const expectedTipDistM = expectedNozzleDistM + expectedFlameLenM;

	assertClose(distFromCenterM, expectedTipDistM, 1e-2);

	// 2. When engine cuts off (burnTime = 0, isBurning = false)
	rocket.burnTime = 0;
	rocket.updateHistory(2, objects);
	const cutoffPt = rocket.effectTrail.getPoint(rocket.effectTrail.count - 1);
	const cutoffDistM = UnitConvertUtils.pix2m(cutoffPt.y - rocket.y);
	assertClose(cutoffDistM, expectedNozzleDistM, 1e-2);
});

test('Rocket & Pad - Visual scale and proportions between rocket and pad structure', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, rotationAngle: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.currentPresetId = 'H3';
	launcher.rollout();

	const rocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
	assert.ok(rocket, 'Rocket should be placed after rollout');

	// Verify rocket visual base radius is maintained (prevent shrinking to ~10m)
	assert.ok(rocket.baseRadiusM >= 50, `Rocket baseRadiusM (${rocket.baseRadiusM}) must be at least 50m to preserve clear visibility`);
	assert.equal(rocket.baseRadiusM, 63.0, 'H3 baseRadiusM should equal 63m');

	// Verify PadEffectRenderer scale matches rocket draw radius exactly
	const pad = new PadEffectRenderer();
	pad.start(rocket.id, earth.id);
	const zoomScale = 1.5;
	const mockContext = {
		rocket: rocket,
		host: earth,
		m2pix: (m) => UnitConvertUtils.m2pix(m),
		zoomScale: zoomScale
	};
	pad.update(0.016, mockContext);

	assert.equal(pad.rocketRadius, rocket.baseRadiusM, 'Pad rocketRadius must match rocket baseRadiusM');

	// Verify ratio between pad structure coordinate base and rocket nozzle position
	const offsets = ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET;
	assertClose(rocket.bottomOffsetM, rocket.baseRadiusM * offsets.TWO_STAGE, 1e-3);
});

test('PadEffectRenderer - Launch pad towers are grounded on the pad base without floating', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0, vx: 0, vy: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.mode = 'host';

	const presetsToTest = [
		{ id: 'H3', expectedLen: 63, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE },
		{ id: 'FALCON9', expectedLen: 70, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE },
		{ id: 'EPSILON', expectedLen: 26, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.THREE_STAGE },
		{ id: 'SSTO', expectedLen: 50, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.SINGLE_STAGE }
	];

	for (const preset of presetsToTest) {
		launcher.currentPresetId = preset.id;
		launcher.rollout();
		const rocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
		assert.ok(rocket, `Rocket for preset ${preset.id} should be rolled out`);

		const pad = new PadEffectRenderer();
		pad.start(rocket.id, earth.id);
		const mockContext = {
			rocket: rocket,
			host: earth,
			m2pix: (m) => UnitConvertUtils.m2pix(m),
			zoomScale: 1.0
		};
		pad.update(0.016, mockContext);

		const layout = pad.getTowerLayout(mockContext);
		const expectedGroundXM = -preset.expectedLen * preset.mult;

		// 1. Verify ground level matches nozzle bottom offset
		assertClose(layout.groundXM, expectedGroundXM, 1e-3,
			`[${preset.id}] groundXM (${layout.groundXM}) must equal -bottomOffsetM (${expectedGroundXM})`);

		// 2. Tower 1 (Main Strongback) must be anchored at ground level
		assertClose(layout.strongback.baseXM, layout.groundXM, 1e-3,
			`[${preset.id}] Strongback baseXM (${layout.strongback.baseXM}) must reach groundXM (${layout.groundXM}), not float in mid-air`);
		assert.ok(layout.strongback.isGrounded, `[${preset.id}] Strongback must be flagged as grounded`);
		assert.ok(layout.strongback.heightM >= preset.expectedLen * 3.0,
			`[${preset.id}] Strongback height (${layout.strongback.heightM}m) must span from ground to upper body`);

		// 3. Tower 2 (Umbilical Tower) must be anchored at ground level
		assertClose(layout.umbilicalTower.baseXM, layout.groundXM, 1e-3,
			`[${preset.id}] Umbilical tower baseXM (${layout.umbilicalTower.baseXM}) must reach groundXM (${layout.groundXM}), not float in mid-air`);
		assert.ok(layout.umbilicalTower.isGrounded, `[${preset.id}] Umbilical tower must be flagged as grounded`);
		assert.ok(layout.umbilicalTower.heightM >= preset.expectedLen * 1.5,
			`[${preset.id}] Umbilical tower height (${layout.umbilicalTower.heightM}m) must span from ground to umbilical swing arm`);

		// 4. Regression check: ensure towers are NOT floating at old rocket-center offsets (-1.5 * rM or -0.6 * rM)
		const oldFloatingStrongbackXM = -1.5 * preset.expectedLen;
		const oldFloatingUmbilicalXM = -0.6 * preset.expectedLen;
		assert.notEqual(layout.strongback.baseXM, oldFloatingStrongbackXM,
			`[${preset.id}] Strongback must not float at old offset ${oldFloatingStrongbackXM}`);
		assert.notEqual(layout.umbilicalTower.baseXM, oldFloatingUmbilicalXM,
			`[${preset.id}] Umbilical tower must not float at old offset ${oldFloatingUmbilicalXM}`);

		// 5. Verify drawing execution with grounded coordinates
		const rectCalls = [];
		const mockCtx = {
			save: () => {},
			restore: () => {},
			translate: () => {},
			rotate: () => {},
			beginPath: () => {},
			stroke: () => {},
			fillRect: (x, y, w, h) => rectCalls.push({ x, y, w, h }),
			moveTo: () => {},
			lineTo: () => {}
		};
		const mockRc = {
			zoomScale: 1.0,
			basis: earth,
			cameraOffset: { x: 0, y: 0 }
		};
		pad.drawBackground(mockCtx, mockRc, mockContext);
		assert.ok(rectCalls.length >= 3, `[${preset.id}] drawBackground must render base, strongback, and umbilical tower`);

		launcher.abortRollout();
	}
});

test('RocketLauncher - Initial velocity includes planetary surface rotation speed in m/s', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0, vx: 0, vy: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.mode = 'host';
	launcher.hostAngleDeg = 0; // Launch from North pole / zenith -90deg canvas (dx=0, dy=-R)

	const t = launcher._calculateTransform();
	assert.ok(t, 'Transform should be computed');

	// Earth rotation period is 86164s. At radius ~6371200m, tangential velocity = omega * r approx 464.6 m/s
	const hostParam = DEFAULT_OBJECT_PARAMS['Earth'];
	const omega = (2 * Math.PI) / hostParam.ROTATION_PERIOD;
	const expectedSpeedMps = omega * (earth.radius + launcher.getBottomOffsetM() + launcher.hostAltitudeM);

	// In main thread coordinates, velocity is in px/s. pix2m(t.vx) gives m/s.
	const vxMps = UnitConvertUtils.pix2m(t.vx);
	assertClose(vxMps, expectedSpeedMps, 1.0);
	assert.ok(vxMps > 400, `t.vx in m/s (${vxMps} m/s) must include planetary rotation speed (~464.6 m/s)`);
});

test('Trajectory - Predicted line and actual flight path align with Earth rotation', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0, vx: 0, vy: 0, rotationAngle: 0.5 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.mode = 'host';
	launcher.hostAngleDeg = 0;
	launcher.currentPresetId = 'FALCON9';

	// Compute prediction at rollout
	const prediction = launcher.updatePredictionSync();
	assert.ok(prediction && prediction.points.length > 0, 'Prediction should have points');

	// Verify that at liftoff (simTime = 0), predicted point starts at the launch pad position
	const p0 = prediction.points[0];
	assert.equal(p0.time, 0);
	const expectedR = UnitConvertUtils.m2pix(earth.radius + launcher.getBottomOffsetM());
	assertClose(p0.r, expectedR, 1e-2);

	// Verify that prediction points include surface-relative coordinates (phiSurf)
	assert.ok(p0.phiSurf !== undefined, 'Prediction points must store phiSurf for surface-relative alignment');

	// Verify that prediction initial tangential velocity in host-relative frame includes planetary rotation
	const p1 = prediction.points[1];
	assert.ok(p1, 'Should have point 1');
	// In inertial frame, dx_m should advance by eastward motion due to Earth rotation
	const dx_m = UnitConvertUtils.pix2m(p1.relX - p0.relX);
	assert.ok(dx_m > 0, 'Rocket must move eastward in inertial frame due to Earth rotation');

	// Verify pad-relative alignment: roll out rocket and test that actual path origin matches prediction origin
	launcher.rollout();
	const rocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
	assert.ok(rocket, 'Rocket should be placed on pad');

	// When liftoff occurs, rocket adopts prediction
	EventBus.emit('liftoff');
	assert.ok(rocket.predictedTrajectory, 'Rocket should receive predicted trajectory');
	assert.equal(rocket.predictedTrajectory.points[0].phiSurf, prediction.points[0].phiSurf, 'Surface angle must match without double-offset');

	// Release hold-down and simulate first flight step with real Rocket to record actual flight path
	const realRocket = new Rocket(rocket.id, rocket.name, rocket.x, rocket.y, rocket.vx, rocket.vy, 30, 400, 0, '#fff', 5, rocket.radius);
	realRocket.hostId = earth.id;
	realRocket.predictedTrajectory = rocket.predictedTrajectory;
	realRocket.isHoldDown = false;
	realRocket._recordActualFlightPath(universe.objects);
	assert.ok(realRocket.actualFlightPath && realRocket.actualFlightPath.length > 0, 'Actual flight path must be recorded');
	const a0 = realRocket.actualFlightPath[0];
	assertClose(a0.phiSurf, p0.phiSurf, 1e-4);
	assertClose(a0.r, p0.r, 1e-2);
});

test('StageDebris - Separated booster, fairing, and upper stage debris maintain 1:1 scale with rocket body', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0, vx: 0, vy: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.mode = 'host';

	const presetsToTest = [
		{ id: 'FALCON9', name: 'Falcon 9', expectedBaseM: 70, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE },
		{ id: 'H3', name: 'H3', expectedBaseM: 63, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE },
		{ id: 'EPSILON', name: 'Epsilon', expectedBaseM: 26, mult: ROCKET_VISUAL.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.THREE_STAGE }
	];

	for (const p of presetsToTest) {
		launcher.currentPresetId = p.id;
		const baseRadiusM = launcher.getBaseRadiusM();
		const bottomOffsetM = launcher.getBottomOffsetM();
		assert.equal(baseRadiusM, p.expectedBaseM, `[${p.id}] Base radius must be ${p.expectedBaseM}m`);
		assertClose(bottomOffsetM, p.expectedBaseM * p.mult, 1e-3, `[${p.id}] Bottom offset must equal baseRadiusM * mult`);

		// Instantiate CalcRocket simulating physics worker
		const calcRocket = new CalcRocket(
			100, p.name, 0, -6371000 - bottomOffsetM, 0, 0, 0, 0,
			bottomOffsetM, 0, 25, 140, 280,
			{
				stages: launcher.stages,
				payload: launcher.payload,
				fairing: launcher.fairing,
				baseRadiusM: baseRadiusM,
				bottomOffsetM: bottomOffsetM,
				thrustAngle: -Math.PI / 2,
				isHoldDown: false,
				isIgnited: true
			}
		);

		assert.equal(calcRocket.baseRadiusM, p.expectedBaseM, `[${p.id}] CalcRocket baseRadiusM must be preserved`);
		assert.equal(calcRocket.bottomOffsetM, bottomOffsetM, `[${p.id}] CalcRocket bottomOffsetM must be preserved`);

		// 1. Separate Stage 1 (Booster)
		calcRocket.separateCurrentStage();
		const boosterData = calcRocket._pendingDebris.find(d => d.debrisSubType === 1);
		assert.ok(boosterData, `[${p.id}] Booster debris must be queued upon stage 1 separation`);

		// CRITICAL SCALE CHECK: Booster radius must match base body radius (1:1), NOT inflated to bottomOffsetM
		assertClose(boosterData.radius, p.expectedBaseM, 1e-3,
			`[${p.id}] Booster debris radius (${boosterData.radius}m) must equal rocket baseRadiusM (${p.expectedBaseM}m)`);
		assert.notEqual(boosterData.radius, bottomOffsetM,
			`[${p.id}] Booster debris radius must NOT be inflated to bottomOffsetM (${bottomOffsetM}m)`);
		assert.ok(boosterData.radius < bottomOffsetM * 0.8,
			`[${p.id}] Booster debris radius must be strictly less than bottomOffsetM`);

		// 2. Separate Fairing
		calcRocket.separateFairing(120000);
		const fairingPieces = calcRocket._pendingDebris.filter(d => d.debrisSubType === 3);
		assert.equal(fairingPieces.length, 2, `[${p.id}] Exactly 2 fairing halves must be queued`);
		for (const fairingData of fairingPieces) {
			assertClose(fairingData.radius, p.expectedBaseM, 1e-3,
				`[${p.id}] Fairing debris radius (${fairingData.radius}m) must equal rocket baseRadiusM (${p.expectedBaseM}m)`);
			assert.notEqual(fairingData.radius, bottomOffsetM,
				`[${p.id}] Fairing debris radius must NOT be inflated to bottomOffsetM (${bottomOffsetM}m)`);
		}

		// 3. Separate Stage 2 (Upper Stage / Payload Release)
		calcRocket.currentStageIndex = 1;
		calcRocket.separateCurrentStage();
		const upperStageData = calcRocket._pendingDebris.find(d => d.debrisSubType === 2);
		assert.ok(upperStageData, `[${p.id}] Upper stage debris must be queued`);
		assertClose(upperStageData.radius, p.expectedBaseM, 1e-3,
			`[${p.id}] Upper stage debris radius (${upperStageData.radius}m) must equal rocket baseRadiusM (${p.expectedBaseM}m)`);
		assert.notEqual(upperStageData.radius, bottomOffsetM,
			`[${p.id}] Upper stage debris radius must NOT be inflated to bottomOffsetM (${bottomOffsetM}m)`);

		// 4. Main-thread visual scale verification (1:1 ratio between rocket and debris)
		const rocket = new Rocket(100, p.name, 0, 0, 0, 0, 25, 140, 280, '#fff', 5, bottomOffsetM);
		rocket.baseRadiusM = baseRadiusM;
		rocket.bottomOffsetM = bottomOffsetM;

		const boosterDebris = new Debris(
			201, `${p.name} - Stage 1 Booster`, 0, 0, 0, 0,
			25, '#c85a1a', 1.8, boosterData.radius, 1, '#00ffcc', 0, 1
		);

		// At physical scale zoom levels, screen radius must match exactly
		const testZoomLevels = [1.0, 50.0, 500.0, 2000.0];
		for (const zoom of testZoomLevels) {
			const rocketDrawR = rocket._getDrawRadius(zoom);
			const debrisDrawR = boosterDebris._getDrawRadius(zoom);
			if (rocketDrawR > 5.5) {
				assertClose(debrisDrawR, rocketDrawR, 1e-3,
					`[${p.id} @ zoom=${zoom}] Debris draw radius (${debrisDrawR}) must equal rocket draw radius (${rocketDrawR})`);
			}
		}

		// Verify geometric ratios: Booster debris vs Rocket stage 1
		const m = ROCKET_VISUAL.MODULES;
		const hw = RENDER.DEBRIS_HARDWARE;
		assert.equal(hw.STAGE1_LEN_RATIO, m.STAGE1_LENGTH_RATIO,
			'Debris booster length ratio must match rocket stage 1 length ratio');
		assert.equal(hw.STAGE1_WIDTH_RATIO, m.STAGE1_RADIUS_RATIO,
			'Debris booster width ratio must match rocket stage 1 radius ratio');
		assert.equal(hw.FAIRING_WIDTH_RATIO, m.STAGE2_RADIUS_RATIO,
			'Debris fairing width ratio must match rocket fairing/stage2 radius ratio');
		assert.equal(hw.STAGE2_WIDTH_RATIO, m.STAGE2_RADIUS_RATIO,
			'Debris upper stage width ratio must match rocket stage 2 radius ratio');
	}
});

test('PadEffectRenderer - Umbilical tower hinges at ground level, does not bend mid-tower, and umbilical cable attaches naturally to tower arm', () => {
	const renderer = new PadEffectRenderer();
	const rPx = 100;
	const layout = renderer.getTowerLayout(rPx);

	// 1. Both towers grounded firmly at ground base
	assert.ok(layout.strongback.isGrounded, 'Strongback must be grounded');
	assert.ok(layout.umbilicalTower.isGrounded, 'Umbilical tower must be grounded');
	assertClose(layout.strongback.baseXM, layout.groundXM, 1e-4, 'Strongback base must be at ground');
	assertClose(layout.umbilicalTower.baseXM, layout.groundXM, 1e-4, 'Umbilical tower base must be at ground');

	// 2. Umbilical tower hinge must be at the base on the ground (no midpoint bending)
	assertClose(layout.umbilicalTower.hingeXM, layout.groundXM, 1e-4,
		'Umbilical tower hinge must be rooted at ground level, not bent mid-tower');

	// 3. Proportions: Tower width vs Umbilical cable width
	const conf = PAD_EFFECT.STRUCTURE;
	assert.ok(conf.UMBILICAL_H_MULT >= 0.4, 'Umbilical tower width multiplier must be substantial (>= 0.4)');
	assert.ok(conf.CABLE_WIDTH_MULT >= 0.08 && conf.CABLE_WIDTH_MULT <= 0.15, 'Umbilical cable width must be thick and substantial (0.08 - 0.15)');
	assert.ok(conf.UMBILICAL_H_MULT / conf.CABLE_WIDTH_MULT >= 3.0,
		'Umbilical tower must be thicker than the umbilical cable');

	// 4. Umbilical cable attachment position attaches to tower arm and rocket port without floating in air
	const cable = renderer.umbilicalCable;
	const attachPos = cable.getAttachPos(conf, renderer.umbilicalAngle, 3.10);

	// Tower arm tip attachment should be at high elevation near tower top
	assert.ok(attachPos.x > 0, 'Tower attachment X must be elevated near tower top');
	assert.ok(attachPos.y < 0, 'Tower attachment Y must be on umbilical side (< 0)');

	// Cable nodes must stretch smoothly between the tower arm and rocket port (no floating in empty air)
	cable.update(0.016, conf, renderer.umbilicalAngle, true, 3.10);
	const firstNode = cable.nodes[0];
	const lastNode = cable.nodes[cable.nodes.length - 1];
	assertClose(firstNode.x, attachPos.x, 1e-3, 'Cable start node must match tower arm position');
	assertClose(firstNode.y, attachPos.y, 1e-3, 'Cable start node must match tower arm position');
	const expectedConnX = conf.CABLE_CONN_X_MULT !== undefined ? conf.CABLE_CONN_X_MULT : 0.8;
	const expectedConnY = conf.CABLE_CONN_Y_MULT !== undefined ? conf.CABLE_CONN_Y_MULT : -0.7;
	assertClose(lastNode.x, expectedConnX, 1e-3, 'Cable end node must match rocket port position');
	assertClose(lastNode.y, expectedConnY, 1e-3, 'Cable end node must match rocket port position');

	// 5. Cable length and sag: cable must have significant length and droop (slack)
	const totalRestLen = cable.restLengths.reduce((sum, len) => sum + len, 0);
	assert.ok(totalRestLen > 1.2, `Cable rest length should be long with realistic sag, got ${totalRestLen}`);
	const midNode = cable.nodes[Math.floor(cable.nodes.length / 2)];
	assert.ok(midNode.x < Math.min(firstNode.x, lastNode.x), 'Cable mid node must droop downward below attachments');
});

test('Telemetry & Predictor - Stage 2 burn telemetry remaining fuel reaches 0% at SECO and SECO-1 / 2-STG-SEP do not prematurely trigger passed', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0, vx: 0, vy: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;
	launcher.mode = 'host';
	launcher.currentPresetId = 'FALCON9';

	const preset = MULTISTAGE_PRESETS.FALCON9;
	const mockRocket = new Rocket(100, 'Falcon 9', 0, 0, 0, 0, 25, 140, 280, '#fff', 5, 2.5);
	mockRocket.stages = JSON.parse(JSON.stringify(preset.stages));
	mockRocket.totalStages = preset.stages.length;
	mockRocket.currentStageIndex = 0;
	mockRocket.stageState = 'STG_BURNING';
	mockRocket.fuelMass = 140.0;
	mockRocket.oxidMass = 280.0;
	mockRocket.burnTime = 162.0;
	mockRocket.thrustRatio = 1.0;

	// Set predicted trajectory events
	mockRocket.predictedTrajectory = {
		events: [
			{ id: 'liftoff', name: 'LIFTOFF', type: 'liftoff', time: 0, passed: true },
			{ id: 'meco_1', name: 'MECO-1', type: 'stg_meco', time: 162, passed: false },
			{ id: 'stg_sep_1', name: 'STG-1 SEP', type: 'staging', time: 165, passed: false },
			{ id: 'ses_1', name: 'SES-1', type: 'ignition', time: 167, passed: false },
			{ id: 'seco_1', name: 'SECO-1', type: 'meco', time: 480, passed: false },
			{ id: 'stg_sep_2', name: '2-STG-SEP', type: 'staging', time: 483, passed: false },
			{ id: 'payload_sep', name: 'PAYLOAD SEP', type: 'staging', time: 483, passed: false }
		]
	};

	// Mock UI container for PropulsionCard
	const cardEl = document.createElement('div');
	cardEl.innerHTML = `
		<div class="tm-section-header"></div>
		<div id="tm-rem-dv"></div><div id="tm-twr"></div><div id="tm-thrtl"></div>
		<div id="tm-fuel-mass"></div><div id="tm-oxid-mass"></div>
		<div id="tm-tank-pres-fuel"></div><div id="tm-tank-pres-oxid"></div>
		<div id="tm-fuel-bar"></div><div id="tm-oxid-bar"></div>
		<div id="tm-pres-fuel-bar"></div><div id="tm-pres-oxid-bar"></div>
	`;
	const propCard = new PropulsionCard('propulsion', 'Propulsion & Tanks', cardEl);
	propCard.initElements();

	// 1. PHASE 1: STAGE 1 MECO (t = 162s)
	mockRocket.flightTime = 162;
	mockRocket.stageState = 'STG_MECO';
	mockRocket.fuelMass = 0;
	mockRocket.oxidMass = 0;
	mockRocket.burnTime = 0;
	mockRocket.thrustRatio = 0;
	mockRocket.telemetry = {
		status: TELEMETRY.STATUS.MECO,
		flightTime: 162,
		stageIndex: 0,
		totalStages: 2
	};

	// Detect passed events at Stage 1 MECO
	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objectsMap: new Map([[1, earth]]) });

	// MECO-1 should be passed
	assert.ok(mockRocket.passedEventIds.has('meco_1'), 'MECO-1 must be passed at stage 1 cutoff');

	// CRITICAL CHECK: SECO-1 and 2-STG-SEP must NOT be passed at Stage 1 MECO!
	assert.equal(mockRocket.passedEventIds.has('seco_1'), false,
		'SECO-1 must NOT be marked passed (●) prematurely during Stage 1 MECO!');
	assert.equal(mockRocket.passedEventIds.has('stg_sep_2'), false,
		'2-STG-SEP must NOT be marked passed (●) prematurely during Stage 1 MECO!');

	// 2. PHASE 2: STAGE 1 SEPARATION (t = 165s)
	mockRocket.flightTime = 165;
	mockRocket.currentStageIndex = 1;
	mockRocket.stageState = 'INTERSTAGE_COAST';
	mockRocket.fuelMass = 32.0;
	mockRocket.oxidMass = 64.0;
	mockRocket.burnTime = 390.0;
	mockRocket.telemetry.stageIndex = 1;
	mockRocket.telemetry.flightTime = 165;

	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objectsMap: new Map([[1, earth]]) });

	// STG-1 SEP should be passed
	assert.ok(mockRocket.passedEventIds.has('stg_sep_1'), 'STG-1 SEP must be passed upon stage 1 separation');

	// CRITICAL CHECK: SECO-1 and 2-STG-SEP must NOT be passed upon Stage 1 Separation!
	assert.equal(mockRocket.passedEventIds.has('seco_1'), false,
		'SECO-1 must NOT be marked passed (●) prematurely when Stage 1 separates!');
	assert.equal(mockRocket.passedEventIds.has('stg_sep_2'), false,
		'2-STG-SEP must NOT be marked passed (●) prematurely when Stage 1 separates!');

	// 3. PHASE 3: STAGE 2 BURNING (t = 300s, midway through burn)
	mockRocket.flightTime = 300;
	mockRocket.stageState = 'STG_BURNING';
	mockRocket.thrustRatio = 1.0;
	mockRocket.fuelMass = 20.0;
	mockRocket.oxidMass = 40.0;
	mockRocket.burnTime = 250.0;
	mockRocket.telemetry.flightTime = 300;
	mockRocket.telemetry.status = TELEMETRY.STATUS.ASCENT;

	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objectsMap: new Map([[1, earth]]) });
	assert.equal(mockRocket.passedEventIds.has('seco_1'), false, 'SECO-1 must still be unpassed (○) during stage 2 burn');
	assert.equal(mockRocket.passedEventIds.has('stg_sep_2'), false, '2-STG-SEP must still be unpassed (○) during stage 2 burn');

	// Update telemetry card during Stage 2 burn
	propCard.update(mockRocket, mockRocket.telemetry);
	const fuelPctDuring = parseFloat(propCard.ui.fuelBar.style.width);
	assertClose(fuelPctDuring, (20.0 / 32.0) * 100, 1.0, 'Fuel bar must reflect remaining stage 2 fuel');

	// 4. PHASE 4: STAGE 2 REACHES SECO (t = 480s, orbital cutoff)
	mockRocket.flightTime = 480;
	mockRocket.stageState = 'STG_MECO';
	mockRocket.thrustRatio = 0.0;
	mockRocket.burnTime = 0.0;
	mockRocket.fuelMass = 0.0;
	mockRocket.oxidMass = 0.0;
	mockRocket.telemetry.flightTime = 480;
	mockRocket.telemetry.status = TELEMETRY.STATUS.MECO;

	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objectsMap: new Map([[1, earth]]) });

	// SECO-1 must NOW be marked passed
	assert.ok(mockRocket.passedEventIds.has('seco_1'), 'SECO-1 must be marked passed (●) when stage 2 cuts off');

	// 2-STG-SEP must NOT yet be passed (until separation timer expires)
	assert.equal(mockRocket.passedEventIds.has('stg_sep_2'), false,
		'2-STG-SEP must not pass until upper stage physically separates');

	// CRITICAL CHECK: Telemetry PropulsionCard remaining fuel at SECO must be 0%, NOT 20%!
	propCard.update(mockRocket, mockRocket.telemetry);
	const fuelMassText = propCard.ui.fuelMass.textContent.trim();
	const oxidMassText = propCard.ui.oxidMass.textContent.trim();
	const fuelBarWidth = parseFloat(propCard.ui.fuelBar.style.width);
	const oxidBarWidth = parseFloat(propCard.ui.oxidBar.style.width);

	assertClose(parseFloat(fuelMassText), 0.0, 0.01,
		`Fuel mass display at SECO (${fuelMassText}t) must be 0.00t, not ~6.2t (20%)`);
	assertClose(parseFloat(oxidMassText), 0.0, 0.01,
		`Oxidizer mass display at SECO (${oxidMassText}t) must be 0.00t, not ~12.5t (20%)`);
	assertClose(fuelBarWidth, 0.0, 0.1,
		`Fuel bar at SECO (${fuelBarWidth}%) must display 0% remaining, NOT 20%`);
	assertClose(oxidBarWidth, 0.0, 0.1,
		`Oxidizer bar at SECO (${oxidBarWidth}%) must display 0% remaining, NOT 20%`);

	// 5. PHASE 5: STAGE 2 SEPARATION (t = 483s, payload release)
	mockRocket.flightTime = 483;
	mockRocket.currentStageIndex = 2;
	mockRocket.stageState = 'ORBITAL_COAST';
	mockRocket.isPayloadSeparated = true;
	mockRocket.telemetry.stageIndex = 2;
	mockRocket.telemetry.flightTime = 483;
	mockRocket.telemetry.isPayloadSeparated = true;

	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, { objectsMap: new Map([[1, earth]]) });

	// 2-STG-SEP and PAYLOAD SEP must NOW be marked passed
	assert.ok(mockRocket.passedEventIds.has('stg_sep_2'), '2-STG-SEP must be marked passed (●) upon stage 2 separation');
	assert.ok(mockRocket.passedEventIds.has('payload_sep'), 'PAYLOAD SEP must be marked passed (●) upon stage 2 separation');
});

