import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockRocket, createMockElement, assertClose } from '../test_helpers.mjs';

// Setup DOM and global mocks before imports
setupMockDOM();

import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { LaunchSequencer } from '../../scripts/gravsim_launch_sequencer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { DebrisGenerator } from '../../scripts/gravsim_debris_generator.js';
import { PHYSICS, TELEMETRY, MULTISTAGE_PRESETS, normalizeRocketConfig, OBJECT_TYPES, OBJECT_STATE } from '../../scripts/gravsim_const.js';

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


