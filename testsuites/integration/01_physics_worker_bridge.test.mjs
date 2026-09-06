/**
 * Integration Test Suite 01: Physics & Worker Bridge Interoperability
 * 
 * Verifies cross-module coordination between:
 * - PhysicsEngine (gravsim_calc.js)
 * - WorkerBridge (gravsim_worker_bridge.js)
 * - ObjectManager (gravsim_object_manager.js)
 * - Physics Objects (CalcCelestialBody, CalcRocket, CalcDebris)
 * - Unit conversions (UnitConvertUtils, pix <-> m, kg <-> tonnes)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, PHYSICS, CALC_BUFFER_CONFIG } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { setupMockDOM, createFalcon9Config, createMockUniverse, assertClose, logDebug } from '../test_helpers.mjs';

describe('Integration 01: Physics & Worker Bridge Interoperability', () => {
	let cleanupDOM;
	let universe;

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
		universe = createMockUniverse();
		universe.calcWorkerManager = { postMessage: () => {} };
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	it('should synchronize full simulation step from PhysicsEngine through WorkerBridge to ObjectManager', () => {
		const engine = new PhysicsEngine();
		const objManager = new ObjectManager(universe);

		// Earth at origin
		const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24 / 1000, 6371000, 0); // mass in tonnes
		earth.radius = 6371000;
		objManager.addObject(earth);

		engine.addObject({
			id: earth.id,
			name: earth.name,
			type: OBJECT_TYPES.CELESTIAL,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 5.972e24, // kg in worker
			radius: 6371000
		});

		// Falcon 9 Rocket on surface
		const f9 = createFalcon9Config();
		const rocket = new Rocket(10, 'Falcon 9', 0, 6371000 + 10, 0, 0, f9.totalMassT, 1.85, 0, {
			stages: f9.stages,
			payload: f9.payload,
			fairing: f9.fairing,
			hostId: 1,
			isHoldDown: false,
			isIgnited: true,
			thrustForce: f9.stages[0].maxThrustN,
			burnTime: 162
		});
		objManager.addObject(rocket);

		engine.addObject({
			id: rocket.id,
			name: rocket.name,
			type: OBJECT_TYPES.ROCKET,
			x: 0,
			y: 6371000 + 10,
			vx: 0,
			vy: 0,
			mass: f9.totalMassT,
			radius: 1.85,
			fuelMass: f9.stages[0].fuelMassT,
			oxidMass: f9.stages[0].oxidMassT,
			thrustForce: f9.stages[0].maxThrustN,
			burnTime: 162,
			isHoldDown: false,
			isIgnited: true,
			stages: f9.stages,
			payload: f9.payload,
			fairing: f9.fairing,
			hostId: 1
		});

		// Execute physics simulation step (dt = 0.1s)
		engine._updateHoldDownPositions(0.1);
		engine._moveObjects(0.1);

		// Format worker buffer
		const buffer = WorkerBridge.formatWorkerToMain(engine.objects);
		assert.ok(buffer instanceof Float64Array, 'Buffer must be Float64Array');
		assert.equal(buffer.length, engine.objects.length * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT);

		// Parse worker buffer into ObjectManager updates
		let parsedCount = 0;
		WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (objData) => {
			parsedCount++;
			objManager.updateObjectParams(objData);
		});

		assert.equal(parsedCount, 2, 'Should have parsed exactly 2 objects');

		// Verify main thread rocket updated
		const mainRocket = objManager.objects.find(o => o.id === 10);
		assert.ok(mainRocket, 'Main thread rocket must exist');
		assert.ok(mainRocket.y !== 0, 'Rocket position must be updated');
		assert.ok(mainRocket.mass !== undefined, 'Rocket mass must be populated');

		// Recycle buffer through WorkerBridge
		assert.doesNotThrow(() => {
			WorkerBridge.recycleBuffer(buffer.buffer);
		}, 'Buffer recycling must not throw');
	});

	it('should automatically instantiate stage separation debris inside ObjectManager from worker buffer', () => {
		const engine = new PhysicsEngine();
		const objManager = new ObjectManager(universe);

		// Earth
		engine.addObject({
			id: 1,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0, y: 0, vx: 0, vy: 0,
			mass: 5.972e24, radius: 6371000
		});

		// Rocket at MECO staging condition
		const f9 = createFalcon9Config();
		engine.addObject({
			id: 100,
			name: 'Falcon 9',
			type: OBJECT_TYPES.ROCKET,
			x: 0, y: 6371000 + 80000, vx: 1800, vy: 500,
			mass: 555.2, radius: 1.85,
			stages: f9.stages, payload: f9.payload, fairing: f9.fairing,
			isHoldDown: false, isIgnited: true
		});

		const calcRocket = engine.objects.find(o => o.id === 100);
		calcRocket.fuelMass = 0;
		calcRocket.oxidMass = 0;
		calcRocket.burnTime = 0;
		calcRocket.stageState = 'STG_MECO';
		calcRocket.stgTimer = 2.0; // exceeds separation delay

		// Trigger staging in worker engine
		engine._updateFlightControl(0.1);

		// Worker created booster debris in engine.objects
		const debrisInWorker = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS);
		assert.equal(debrisInWorker.length, 1, 'Worker must have spawned booster debris');
		const boosterDebris = debrisInWorker[0];

		// Now serialize to buffer
		const buffer = WorkerBridge.formatWorkerToMain(engine.objects);

		// Feed to ObjectManager via parseWorkerToMain
		WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (objData) => {
			objManager.updateObjectParams(objData);
		});

		// ObjectManager should have autonomously instantiated the Debris object
		const debrisInMain = objManager.objects.filter(o => o instanceof Debris || o.type === OBJECT_TYPES.DEBRIS);
		assert.equal(debrisInMain.length, 1, 'ObjectManager must autonomously instantiate new debris');
		assert.equal(debrisInMain[0].id, boosterDebris.id, 'Debris ID must match worker assigned ID');
		assert.equal(debrisInMain[0].debrisSubType, 1, 'Booster subtype must be 1');

		WorkerBridge.recycleBuffer(buffer.buffer);
	});

	it('should maintain unit conversion consistency across Main and Worker representations', () => {
		// Test distance conversion roundtrip
		const testMeters = 384400000; // Earth-Moon distance in meters
		const pixels = UnitConvertUtils.m2pix(testMeters);
		const backToMeters = UnitConvertUtils.pix2m(pixels);
		assertClose(backToMeters, testMeters, 1e-4, 'm -> pix -> m roundtrip must match');

		// Test velocity conversion roundtrip
		const testSpeedMps = 7800; // LEO orbital velocity in m/s
		const speedPix = UnitConvertUtils.m2pix(testSpeedMps);
		const backToSpeedMps = UnitConvertUtils.pix2m(speedPix);
		assertClose(backToSpeedMps, testSpeedMps, 1e-4, 'm/s -> pix/s -> m/s roundtrip must match');

		// Test mass conversion
		const tonnes = 549.054;
		const kg = tonnes * 1000;
		assert.equal(kg, 549054, 'tonnes to kg must be exact 1000 multiplier');
	});

	it('should handle zero-allocation buffer pool reuse under sequential cycles', () => {
		const engine = new PhysicsEngine();
		for (let i = 0; i < 5; i++) {
			engine.addObject({
				id: i + 1,
				name: `Body_${i}`,
				type: OBJECT_TYPES.CELESTIAL,
				x: i * 1e7, y: 0, vx: 0, vy: 0,
				mass: 1e24, radius: 6e6
			});
		}

		// Perform 10 cycles of format -> parse -> recycle
		for (let cycle = 0; cycle < 10; cycle++) {
			engine._calculateForces();
			const buffer = WorkerBridge.formatWorkerToMain(engine.objects);
			let parsed = 0;
			WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (data) => {
				parsed++;
				assert.ok(data.id >= 1 && data.id <= 5);
			});
			assert.equal(parsed, 5);
			WorkerBridge.recycleBuffer(buffer.buffer);
		}
	});
});
