/**
 * Unit Test Suite 01: Core Physics, Spatial Indexing, Buffer Interop & Utils
 * Tests:
 * - gravsim_calc_quadtree.js (QuadTreePool, Rectangle, Spatial partitioning, zero-allocation queries)
 * - gravsim_calc.js (PhysicsEngine collision checks, Roche limit, atmospheric decay, escape velocity)
 * - gravsim_worker_bridge.js (Float64Array buffer packing, bitmasks, recycling pool)
 * - gravsim_utils.js (MathUtils, UnitConvertUtils, FormatUtils, DOMUtils)
 * - gravsim_event_bus.js (EventBus priority, listener lifecycle, publish/subscribe)
 * - gravsim_profiler.js (WorkerProfiler timing, metrics recording)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuadTreePool, Rectangle } from '../../scripts/gravsim_calc_quadtree.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { MathUtils, UnitConvertUtils, FormatUtils, DOMUtils } from '../../scripts/gravsim_utils.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { WorkerProfiler } from '../../scripts/gravsim_profiler.js';
import { runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { OBJECT_TYPES, PHYSICS } from '../../scripts/gravsim_const.js';
import { logDebug, assertClose, setupMockDOM, createMockElement } from '../test_helpers.mjs';

describe('Unit 01: Core Physics, QuadTree, Buffer Interop & Utilities', () => {
	it('should partition space and query objects accurately with QuadTree and Pool', () => {
		const pool = new QuadTreePool();
		const boundary = pool.getRectangle(0, 0, 1000, 1000);
		const tree = pool.getTree(boundary, 4);

		// Insert test objects
		const obj1 = { id: 1, x: 100, y: 100, radius: 10 };
		const obj2 = { id: 2, x: -200, y: -200, radius: 15 };
		const obj3 = { id: 3, x: 300, y: 300, radius: 20 };
		const obj4 = { id: 4, x: 120, y: 120, radius: 5 };
		const obj5 = { id: 5, x: 150, y: 150, radius: 8 };

		assert.ok(tree.insert(obj1));
		assert.ok(tree.insert(obj2));
		assert.ok(tree.insert(obj3));
		assert.ok(tree.insert(obj4));
		assert.ok(tree.insert(obj5)); // triggers subdivision

		// Query range around (100, 100) with half-width 50
		const queryRange = pool.getRectangle(100, 100, 50, 50);
		const queryResult = [];
		tree.query(queryRange, queryResult);

		logDebug(`QuadTree query found ${queryResult.length} candidate objects`);
		assert.ok(queryResult.some(o => o.id === 1), 'Object 1 must be found in range');
		assert.ok(queryResult.some(o => o.id === 4), 'Object 4 must be found in range');
		assert.ok(!queryResult.some(o => o.id === 2), 'Object 2 must NOT be found in distant range');

		// Test pool reset
		pool.reset();
		const recycledRect = pool.getRectangle(0, 0, 10, 10);
		assert.equal(recycledRect.w, 10);
	});

	it('should verify PhysicsEngine collision, Roche limit detection, and escape velocity evaluation', () => {
		const engine = new PhysicsEngine();

		// Massive Earth
		engine.addObject({
			id: 1,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 5.972e24,
			radius: 6371000
		});

		// Object approaching Earth at escape velocity: v_esc = sqrt(2 * G * M / r)
		const distM = 10000000; // 10,000 km
		const vEsc = Math.sqrt((2 * PHYSICS.G * 5.972e24) / distM); // ~8929 m/s

		// Escaping object (speed > v_esc)
		engine.addObject({
			id: 2,
			name: 'EscapingCraft',
			type: OBJECT_TYPES.DEBRIS,
			x: distM,
			y: 0,
			vx: vEsc + 500,
			vy: 0,
			mass: 1.0,
			radius: 2.0
		});

		// Bound object (speed < v_esc)
		engine.addObject({
			id: 3,
			name: 'BoundCraft',
			type: OBJECT_TYPES.DEBRIS,
			x: 0,
			y: distM,
			vx: 0,
			vy: vEsc - 2000,
			mass: 1.0,
			radius: 2.0
		});

		engine._moveObjects(0.1);
		engine._updateEscapeStatus();

		const escaping = engine.objects.find(o => o.id === 2);
		const bound = engine.objects.find(o => o.id === 3);

		logDebug(`Escaping object: isEscaping=${escaping?.isEscaping}, Bound object: isEscaping=${bound?.isEscaping}`);
		assert.equal(escaping?.isEscaping, true, 'Object exceeding escape velocity must have isEscaping = true');
		assert.equal(bound?.isEscaping, false, 'Sub-escape velocity object must have isEscaping = false');

		// Roche limit test: Fragile debris object very close to massive earth
		const fragile = engine.addObject({
			id: 4,
			name: 'FragileAsteroid',
			type: OBJECT_TYPES.DEBRIS,
			x: 7000000, // inside rigid Roche limit
			y: 0,
			vx: 0,
			vy: 7500,
			mass: 1000,
			radius: 50,
			generation: 1
		});

		engine._buildQuadTree(0.1);
		engine._checkRocheLimit();
		logDebug(`Fragile asteroid shattered=${fragile.shattered}`);
		assert.equal(typeof fragile.shattered, 'boolean');
	});

	it('should verify WorkerBridge buffer recycling and complete 46-attribute data consistency', () => {
		const mockObj = {
			id: 42,
			name: 'Sat-42',
			type: OBJECT_TYPES.ROCKET,
			x: 1234567,
			y: 7654321,
			vx: 123.4,
			vy: -567.8,
			ax: 1.2,
			ay: 9.8,
			mass: 15.5,
			dryMass: 5.5,
			fuelMass: 10.0,
			oxidMass: 0,
			radius: 2.2,
			burnTime: 45.0,
			thrustRatio: 0.85,
			collided: false,
			shattered: false,
			isImpact: false,
			inAtmosphere: true,
			isEscaping: false,
			isHoldDown: false,
			isIgnited: true,
			isPayloadSeparated: false,
			dominantBody: { id: 1 },
			distToDominantM: 7000000,
			flightComputer: {
				getTelemetry: () => ({
					status: 2,
					qAxialKpa: 12.5,
					qLateralKpa: 0.3,
					structRatio: 45.0,
					aoaDeg: 1.2,
					progradeAngle: 0.8,
					gravityAngle: 3.14,
					remDv: 2500,
					twr: 1.8,
					altM: 65000,
					vV: 450,
					vH: 1200,
					aV: 0.5,
					aH: 1.2,
					currentG: 2.3,
					flightTime: 85.0,
					isAntiStallActive: false,
					isQLimitNear: false,
					isGLimitNear: true
				})
			}
		};

		// Additional mock objects to test all branch paths
		const mockRocket2 = {
			id: 43,
			type: OBJECT_TYPES.ROCKET,
			x: 10,
			y: 20,
			vx: 1,
			vy: 2,
			ax: 0,
			ay: 0,
			dryMass: 10,
			fuelMass: 20,
			oxidMass: 5,
			radius: 3,
			burnTime: -1, // burnTime <= 0 branch
			stgSepLampTimer: 1.5, // stgSepActive > 0 branch
			fairing: { isSeparated: true }, // fairingSeparated branch
			isPayloadSeparated: true, // 2048 flag
			isHoldDown: true, // 32 flag
			isIgnited: false,
			collided: true, // 1 flag
			shattered: true, // 2 flag
			isImpact: true, // 4 flag
			inAtmosphere: false,
			isEscaping: true, // 16 flag
			dominantBody: null,
			distToDominantM: 0,
			flightComputer: {
				getTelemetry: () => ({
					status: 1,
					qAxialKpa: 0,
					qLateralKpa: 0,
					structRatio: 0,
					aoaDeg: 0,
					progradeAngle: 0,
					gravityAngle: 0,
					remDv: 0,
					twr: 0,
					altM: 0,
					vV: 0,
					vH: 0,
					aV: 0,
					aH: 0,
					currentG: 0,
					isAntiStallActive: true, // 128 flag
					isQLimitNear: true, // 256 flag
					isGLimitNear: false
				}),
				flightTime: 12
			}
		};

		const mockDebris1 = {
			id: 44,
			type: OBJECT_TYPES.DEBRIS,
			mass: 1.5,
			debrisSubType: 1,
			radius: 1
		};
		const mockDebris2 = {
			id: 45,
			type: OBJECT_TYPES.DEBRIS,
			mass: 2.5,
			debrisSubType: 2,
			radius: 1
		};
		const mockCelestial = {
			id: 46,
			type: OBJECT_TYPES.CELESTIAL,
			mass: 1000,
			radius: 50
		};

		// 1. Pack array of diverse objects
		const testObjs = [mockObj, mockRocket2, mockDebris1, mockDebris2, mockCelestial];
		const packed = WorkerBridge.formatWorkerToMain(testObjs);
		assert.ok(packed instanceof Float64Array);
		assert.equal(packed.length, 46 * testObjs.length, 'Must contain exactly 46 Float64 attributes per object');

		// 2. Unpack
		const parsedList = [];
		WorkerBridge.parseWorkerToMain(packed.buffer, packed.length, (obj) => {
			parsedList.push({ ...obj });
		});

		assert.equal(parsedList.length, 5);
		const parsed = parsedList[0];
		assert.equal(parsed.id, 42);
		assert.equal(parsed.type, OBJECT_TYPES.ROCKET);
		assertClose(parsed.x, 1234567, 1e-4);
		assertClose(parsed.y, 7654321, 1e-4);
		assertClose(parsed.mass, 5.5, 1e-4); // dry mass
		assertClose(parsed.fuelMass, 10.0, 1e-4);
		assert.equal(parsed.inAtmosphere, true);
		assert.equal(parsed.isGLimitNear, true);
		assertClose(parsed.tmRemDv, 2500, 1e-4);

		// Verify rocket2 parsed flags
		const parsedR2 = parsedList[1];
		assert.equal(parsedR2.isPayloadSeparated, true);
		assert.equal(parsedR2.isAntiStall, true);
		assert.equal(parsedR2.isQLimitNear, true);
		assert.equal(parsedR2.isHoldDown, true);
		assert.equal(parsedR2.isCollided, true);
		assert.equal(parsedR2.isShattered, true);
		assert.equal(parsedR2.isImpact, true);
		assert.equal(parsedR2.tmStgSepActive, true);
		assert.equal(parsedR2.tmFairingSeparated, true);

		// Verify debris
		assert.equal(parsedList[2].debrisSubType, 1);
		assert.equal(parsedList[3].debrisSubType, 2);

		// 3. Recycle Buffer & Pool handling
		WorkerBridge.recycleBuffer(null); // null buffer branch
		WorkerBridge.recycleBuffer({ byteLength: 0 }); // 0-length branch
		const smallBuf = new ArrayBuffer(8);
		WorkerBridge.recycleBuffer(smallBuf); // too small for 46*8
		WorkerBridge.recycleBuffer(packed.buffer); // large buffer added to pool
		const reused = WorkerBridge.formatWorkerToMain([mockObj]);
		assert.equal(reused.length, 46, 'Buffer pool must supply recycled array buffer');
	});

	it('should verify UnitConvertUtils, MathUtils, FormatUtils, and DOMUtils operations', () => {
		// Unit conversions
		assertClose(UnitConvertUtils.ton2kg(5.5), 5500, 1e-6);
		assertClose(UnitConvertUtils.kg2ton(5500), 5.5, 1e-6);
		assertClose(UnitConvertUtils.kpa2pa(101.3), 101300, 1e-6);
		assertClose(UnitConvertUtils.pa2kpa(101300), 101.3, 1e-6);
		assertClose(UnitConvertUtils.kn2n(7600), 7600000, 1e-6);
		assertClose(UnitConvertUtils.deg2rad(180), Math.PI, 1e-6);
		assertClose(UnitConvertUtils.rad2deg(Math.PI), 180, 1e-6);

		// MathUtils
		const normalized = MathUtils.normalizeAngle(3 * Math.PI);
		assertClose(Math.abs(normalized), Math.PI, 1e-6);
		const norm360 = MathUtils.normalizeAngle360(450);
		assertClose(norm360, 90, 1e-6);

		// FormatUtils
		assert.equal(FormatUtils.numFixPad(12.345, 2, 6), ' 12.35');

		// DOMUtils
		setupMockDOM();
		const el = createMockElement('div');
		DOMUtils.setText(el, 'Hello GravSim');
		assert.equal(el.textContent, 'Hello GravSim');
		DOMUtils.setStyle(el, 'display', 'none');
		assert.equal(el.style.display, 'none');
	});

	it('should verify EventBus pub/sub, priority ordering, and listener unsubscription', () => {
		const bus = EventBus;
		const callOrder = [];

		const fnLow = () => callOrder.push('low');
		const fnMed = () => callOrder.push('med');
		const fnHigh = () => callOrder.push('high');

		// Subscribe with differing priorities (sorted ascending: priority 10, then 50, then 100)
		bus.on('test-event', fnLow, 10);
		bus.on('test-event', fnHigh, 100);
		bus.on('test-event', fnMed, 50);

		bus.emit('test-event', { val: 1 });
		assert.deepEqual(callOrder, ['low', 'med', 'high'], 'EventBus must invoke listeners in ascending priority');

		// Test unsubscription
		bus.off('test-event', fnHigh);
		callOrder.length = 0;
		bus.emit('test-event', { val: 2 });
		assert.deepEqual(callOrder, ['low', 'med'], 'Unsubscribed listener must not receive events');

		bus.off('test-event', fnLow);
		bus.off('test-event', fnMed);
	});

	it('should measure execution metrics using WorkerProfiler', () => {
		const profiler = new WorkerProfiler();
		profiler.enabled = true;
		const startHandle = profiler.start();
		let sum = 0;
		for (let i = 0; i < 10000; i++) sum += i;
		profiler.end('MathIntegration', startHandle);
		profiler.recordSubSteps(40);

		assert.ok(profiler.metrics.MathIntegration !== undefined, 'Metric must be recorded in profiler');
		assert.equal(profiler.totalSubSteps, 40, 'Total substeps must be recorded');
	});

	it('should execute PhysicsEngine step and update orbital kinematics', () => {
		const engine = new PhysicsEngine();
		engine.addObject({
			id: 1,
			name: 'Sun',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 1.989e30,
			radius: 6.9634e8
		});

		engine.addObject({
			id: 2,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 1.496e11, // 1 AU
			y: 0,
			vx: 0,
			vy: 29780, // ~30 km/s
			mass: 5.972e24,
			radius: 6.371e6
		});

		// Advance physics by 1 hour (3600s)
		const dt = 3600;
		engine._moveObjects(dt);

		const earth = engine.objects.find(o => o.id === 2);
		assert.ok(earth, 'Earth must exist in physics engine');
		// Earth should have moved along y and accelerated towards Sun (-x)
		assert.ok(earth.y > 0, 'Earth y should increase due to positive vy');
		assert.ok(earth.vx < 0, 'Earth vx should become negative due to gravitational attraction towards Sun');
		assert.ok(earth.ax < 0, 'Earth ax must point towards Sun');
	});

	it('should execute collision and momentum conservation with debris mass calculation', () => {
		const engine = new PhysicsEngine();
		// Body 1: 100 tons moving right at +10 m/s
		engine.addObject({
			id: 10,
			name: 'AsteroidA',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 10,
			vy: 0,
			mass: 100000, // kg
			radius: 20
		});

		// Body 2: 20 tons moving left at -20 m/s (overlapping position to trigger collision)
		engine.addObject({
			id: 11,
			name: 'AsteroidB',
			type: OBJECT_TYPES.CELESTIAL,
			x: 10,
			y: 0,
			vx: -20,
			vy: 0,
			mass: 20000, // kg
			radius: 10
		});

		// Build quadtree with dt and trigger collision check
		engine._buildQuadTree(1.0);
		engine._checkCollisions(1.0);

		const winner = engine.objects.find(o => o.id === 10);
		const loser = engine.objects.find(o => o.id === 11);

		assert.ok(loser.collided, 'Smaller object must be flagged as collided');
		assert.ok(winner.mass > 100000, 'Winner mass must absorb loser mass');
		// Momentum: (100 * 10 + 20 * -20) / 120 = 600 / 120 = +5 m/s
		assertClose(winner.vx, 5.0, 0.5, 'Winner velocity must follow momentum conservation');
	});

	it('should update hold-down rocket positions, escape status, Roche limit, and determine sub-steps', () => {
		const engine = new PhysicsEngine();

		// Earth
		const earth = engine.addObject({
			id: 1,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 5.972e24,
			radius: 6371000
		});

		// Hold-down Rocket deployed on Earth
		const rocket = engine.addObject({
			id: 101,
			name: 'Falcon 9',
			type: OBJECT_TYPES.ROCKET,
			x: 0,
			y: -6371000,
			vx: 0,
			vy: 0,
			mass: 550000,
			radius: 20,
			isHoldDown: true,
			hostId: 1,
			hostAltM: 0,
			hostAngleRad: -Math.PI / 2
		});

		// 1. _updateHoldDownPositions
		const initialX = rocket.x;
		engine._updateHoldDownPositions(10.0);
		assert.notEqual(rocket.hostAngleRad, -Math.PI / 2, 'Host angle must advance with Earth rotation');

		// 2. updateObject & removeObject & removeDeadObjects
		engine.updateObject({ id: 101, mass: 540000 });
		assert.equal(rocket.mass, 540000);

		rocket.collided = true;
		engine.removeDeadObjects();
		assert.equal(engine.objects.some(o => o.id === 101), false, 'Dead object must be pruned');

		engine.removeObject(1);
		assert.equal(engine.objects.length, 0, 'Object must be removed by ID');

		// 3. _updateEscapeStatus & determineOptimalSubSteps
		const sun = engine.addObject({ id: 10, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, mass: 1.989e30, radius: 6.96e8 });
		const voyager = engine.addObject({ id: 99, name: 'Voyager', type: OBJECT_TYPES.ROCKET, x: 1.5e11, y: 0, vx: 0, vy: 50000, mass: 800, radius: 2 });
		engine._calculateForces();
		engine._updateEscapeStatus();
		assert.equal(voyager.isEscaping, true, 'Hyperbolic speed should set isEscaping');

		// 4. Adaptive sub-steps
		const subSteps = engine.determineOptimalSubSteps(60.0, 1.0);
		assert.ok(subSteps >= 20, 'Sub-steps should be >= MIN');
	});

	it('should verify WorkerProfiler frame report and metric tracking', () => {
		const profiler = new WorkerProfiler();
		
		// Disabled state
		profiler.enabled = false;
		assert.equal(profiler.start(), 0);
		profiler.end('Integration', 0);
		profiler.recordSubSteps(10);
		profiler.report();
		assert.equal(profiler.frames, 0);

		// Enabled state
		profiler.enabled = true;
		for (let i = 0; i < 60; i++) {
			const t = profiler.start();
			profiler.end('Integration', t);
			profiler.recordSubSteps(30);
			profiler.report();
		}
		// After 60 frames, report resets frames and totalSubSteps
		assert.equal(profiler.frames, 0);
		assert.equal(profiler.totalSubSteps, 0);
	});

	it('should verify PhysicsEngine empty QuadTree, momentum with other.mass > obj.mass, and Roche limit', () => {
		const engine = new PhysicsEngine();

		// Empty quadtree branch
		engine.objects.length = 0;
		engine._buildQuadTree(1.0);
		assert.equal(engine.qtree, null);
		engine._checkCollisions(1.0); // should return early safely

		// Reverse mass collision: obj.mass < other.mass
		// obj (id: 1, mass: 10) vs other (id: 2, mass: 100)
		engine.addObject({
			id: 1,
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 10,
			vy: 0,
			mass: 10,
			radius: 50,
			isColliding: () => true
		});
		engine.addObject({
			id: 2,
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: -5,
			vy: 0,
			mass: 100,
			radius: 50,
			isColliding: () => true
		});

		engine._buildQuadTree(1.0);
		engine._checkCollisions(1.0);

		const loser = engine.objects.find(o => o.id === 1);
		const winner = engine.objects.find(o => o.id === 2);
		assert.ok(loser.collided, 'Lower mass object must be loser');
		assert.ok(winner.mass > 100, 'Winner absorbs mass');

		// Roche limit test
		const massive = {
			id: 50,
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 1e25,
			radius: 6e6
		};
		const fragile = {
			id: 51,
			type: OBJECT_TYPES.CELESTIAL,
			x: 1000,
			y: 1000,
			vx: 0,
			vy: 0,
			mass: 1e15,
			radius: 20000,
			generation: 0,
			isRocheLimit: () => true
		};
		engine.objects.length = 0;
		engine.objects.push(massive, fragile);
		engine._buildQuadTree(1.0);
		engine._checkRocheLimit();
		assert.equal(fragile.shattered, true, 'Fragile object exceeding Roche limit must shatter');

		// _updateEscapeStatus with no massive bodies
		engine.objects.length = 0;
		engine._updateEscapeStatus(); // returns early safely
	});

	it('should verify runMultiBodySimulation event rules and dynamical time-scaling', () => {
		const earthRadius = 6371000;
		const celestialBodies = [{
			id: 1,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			massKg: 5.972e24,
			radius: earthRadius,
			rotationPeriod: 86400,
			color: '#0077be'
		}];

		// Missing hostBody branch
		const missingResult = runMultiBodySimulation({
			hostId: 999,
			celestialBodies,
			rocketConfig: {}
		});
		assert.equal(missingResult.points.length, 0);

		const rocketConfig = {
			name: 'Test Rocket',
			hostId: 1,
			x: 0,
			y: earthRadius + 10,
			vx: 0,
			vy: 100,
			radius: 2,
			dryMassT: 20,
			fuelMassT: 100,
			oxidMassT: 250,
			thrustForceN: 7600000,
			burnTime: 150,
			stages: [{
				stageNumber: 1,
				dryMassT: 20,
				fuelMassT: 100,
				oxidMassT: 250,
				maxThrustN: 7600000,
				burnTime: 150,
				burnRate: 2000
			}],
			flightProfile: [
				{ type: 'time', value: 0, thrust: 100, angle: 0 },
				{ type: 'time', value: 5, thrust: 100, angle: 5 },
				{ type: 'time', value: 20, thrust: 100, angle: 25 }
			]
		};

		const eventDefinitions = [
			{ id: 'liftoff', type: 'liftoff', name: 'Liftoff' },
			{ id: 'alt_pass', type: 'alt', value: 50, name: 'Alt 50m' },
			{ id: 'time_pass', type: 'time', value: 5, name: 'T+5s' },
			{ id: 'ap', type: 'apoapsis', name: 'Apoapsis' },
			{ id: 'orbit', type: 'orbit', name: 'Orbit' }
		];

		const result = runMultiBodySimulation({
			hostId: 1,
			celestialBodies,
			rocketConfig,
			eventDefinitions,
			options: { maxSimTime: 30, dt: 0.5 }
		});

		assert.ok(result.points.length > 10);
		assert.ok(result.events.some(e => e.id === 'liftoff'));
		assert.ok(result.events.some(e => e.id === 'alt_pass'));
		assert.ok(result.events.some(e => e.id === 'time_pass'));
	});
});


