/**
 * Integration Test Suite 03: Trajectory Predictor & Physics Simulation Engine Consistency
 * 
 * Verifies cross-module coordination between:
 * - PredictorPhysicsEngine & runMultiBodySimulation (gravsim_calc_predictor.js)
 * - PhysicsEngine (gravsim_calc.js)
 * - TrajectoryPredictor (gravsim_trajectory_predictor.js)
 * - Trajectory geometry and planetary rotation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { PredictorPhysicsEngine, runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { CalcCelestialBody, CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, DEFAULT_FLIGHT_EVENTS } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createFalcon9Config, assertClose, logDebug } from '../test_helpers.mjs';

describe('Integration 03: Trajectory Predictor & Physics Engine Consistency', () => {
	let cleanupDOM;

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	it('should maintain consistent gravitational trajectory integration between PhysicsEngine and PredictorPhysicsEngine', () => {
		// Earth and an orbital satellite
		const earthParams = {
			id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL,
			x: 0, y: 0, vx: 0, vy: 0,
			mass: 5.972e24, radius: 6371000
		};

		// 300km circular orbit: r = 6,671,000 m, v = sqrt(GM/r) ~ 7726 m/s
		const orbitR = 6671000;
		const orbitV = Math.sqrt((6.6743e-11 * 5.972e24) / orbitR);

		const satParams = {
			id: 10, name: 'Satellite', type: OBJECT_TYPES.ROCKET,
			x: orbitR, y: 0, vx: 0, vy: orbitV,
			mass: 1000, radius: 2.0,
			fuelMass: 0, oxidMass: 0, thrustForce: 0, burnTime: 0,
			isHoldDown: false, isIgnited: false
		};

		// 1. Run live PhysicsEngine for 100 steps (dt = 1.0s)
		const liveEngine = new PhysicsEngine();
		liveEngine.addObject(earthParams);
		liveEngine.addObject(satParams);

		for (let s = 0; s < 100; s++) {
			liveEngine._moveObjects(1.0);
		}
		const liveSat = liveEngine.objects.find(o => o.id === 10);

		// 2. Run PredictorPhysicsEngine for same 100 steps (dt = 1.0s)
		const earthPredictor = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6371000, 0, 5.972e24);
		const satPredictor = new CalcRocket(10, 'Satellite', orbitR, 0, 0, orbitV, 0, 0, 2.0, 0, 1.0, 0, 0, {
			stages: [], isHoldDown: false, isIgnited: false
		});

		const predictorEngine = new PredictorPhysicsEngine([earthPredictor], satPredictor, 1, 3600);
		for (let s = 0; s < 100; s++) {
			predictorEngine._moveObjects(1.0);
		}

		// Trajectory positions should match to very high precision (numerical tolerance < 1.0m over 770km travel)
		const deltaX = Math.abs(liveSat.x - satPredictor.x);
		const deltaY = Math.abs(liveSat.y - satPredictor.y);
		logDebug(`Pos difference after 100s: deltaX=${deltaX.toFixed(4)}m, deltaY=${deltaY.toFixed(4)}m`);
		assert.ok(deltaX < 1.0, `X position difference must be < 1.0m (was ${deltaX})`);
		assert.ok(deltaY < 1.0, `Y position difference must be < 1.0m (was ${deltaY})`);
	});

	it('should execute runMultiBodySimulation and detect trajectory points and orbital milestones', () => {
		const f9 = createFalcon9Config();

		// Earth at origin
		const celestialBodies = [
			{
				id: 1, name: 'Earth', x: 0, y: 0, vx: 0, vy: 0,
				massKg: 5.972e24, radius: 6371000
			}
		];

		// Suborbital rocket ascending from Cape Canaveral at 100km altitude
		const rocketConfig = {
			id: 50, name: 'Falcon 9',
			x: 0, y: 6371000 + 100000, vx: 3000, vy: 1200,
			radius: 1.85, mass: f9.totalMassT,
			fuelMassT: f9.stages[0].fuelMassT, oxidMassT: f9.stages[0].oxidMassT,
			thrustForceN: f9.stages[0].maxThrustN, burnTime: 60,
			stages: f9.stages, payload: f9.payload, fairing: f9.fairing,
			isHoldDown: false, isIgnited: true,
			flightProfile: [
				{ time: 0, alt: 100000, pitch: 45, thrust: 1.0 },
				{ time: 60, alt: 150000, pitch: 15, thrust: 1.0 }
			]
		};

		const result = runMultiBodySimulation({
			hostId: 1,
			celestialBodies,
			rocketConfig,
			eventDefinitions: DEFAULT_FLIGHT_EVENTS,
			options: { maxSimTime: 1800 }
		});

		assert.ok(result, 'Simulation result must exist');
		assert.ok(result.points && result.points.length > 0, 'Should generate trajectory points');
		assert.ok(Array.isArray(result.events), 'Should produce events array');
		logDebug(`Generated ${result.points.length} trajectory points and ${result.events.length} events`);

		// Verify trajectory points structure
		const firstPoint = result.points[0];
		assert.ok(typeof firstPoint.relX === 'number', 'Point must have relX');
		assert.ok(typeof firstPoint.relY === 'number', 'Point must have relY');
		assert.ok(typeof firstPoint.time === 'number', 'Point must have time');
	});

	it('should correctly rotate trajectory prediction according to host planetary rotation angle', () => {
		const sourcePrediction = {
			points: [
				{ relX: 100, relY: 0, altM: 0, time: 0 },
				{ relX: 0, relY: 100, altM: 0, time: 10 },
				{ relX: -100, relY: 0, altM: 0, time: 20 }
			],
			events: [
				{ type: 'MECO', relX: 100, relY: 0, time: 5 }
			]
		};

		// Rotate by 90 degrees (Math.PI / 2)
		const angleRad = Math.PI / 2;
		const rotated = TrajectoryPredictor.rotatePrediction(sourcePrediction, angleRad);

		assert.ok(rotated, 'Rotated result must exist');
		assert.equal(rotated.points.length, 3);
		// Point (100, 0) rotated 90 deg counter-clockwise -> (0, 100)
		assertClose(rotated.points[0].relX, 0, 1e-4, 'Rotated point relX should be ~0');
		assertClose(rotated.points[0].relY, 100, 1e-4, 'Rotated point relY should be ~100');

		// Event point rotated 90 deg -> (0, 100)
		assertClose(rotated.events[0].relX, 0, 1e-4);
		assertClose(rotated.events[0].relY, 100, 1e-4);
	});
});
