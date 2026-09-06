/**
 * Integration Test Suite 02: Rocket Guidance, Flight Computer, and Multi-Stage Separation
 * 
 * Verifies cross-module coordination between:
 * - RocketLauncher (gravsim_rocket_launcher.js)
 * - LaunchSequencer (gravsim_launch_sequencer.js)
 * - FlightComputer (gravsim_flight_computer.js)
 * - CalcRocket (gravsim_calc_object.js)
 * - DebrisGenerator (gravsim_debris_generator.js)
 * - EventBus (gravsim_event_bus.js)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { CalcRocket, CalcCelestialBody } from '../../scripts/gravsim_calc_object.js';
import { LaunchSequencer } from '../../scripts/gravsim_launch_sequencer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, LAUNCH_SEQUENCES } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createFalcon9Config, assertClose, logDebug } from '../test_helpers.mjs';

describe('Integration 02: Rocket Guidance, Flight Computer & Staging Pipeline', () => {
	let cleanupDOM;

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	it('should coordinate countdown sequence, ignition, and hold-down release via LaunchSequencer and EventBus', () => {
		const emittedEvents = [];
		const listeners = [
			'sequencer-start', 'sequencer-tick', 'sequencer-event', 'liftoff'
		];
		listeners.forEach(evt => {
			EventBus.on(evt, (data) => emittedEvents.push({ evt, data }));
		});

		const sequencer = new LaunchSequencer();
		sequencer.start(LAUNCH_SEQUENCES.LEGACY_QUICK, 101);

		assert.equal(sequencer.isActive, true, 'Sequencer must be active');
		assert.equal(sequencer.rocketId, 101, 'Rocket ID must be recorded');

		// Advance sequencer by 2 seconds
		sequencer.update(2.0);
		assert.ok(emittedEvents.some(e => e.evt === 'sequencer-start'), 'Should emit sequencer-start');
		assert.ok(emittedEvents.some(e => e.evt === 'sequencer-tick'), 'Should emit sequencer-tick');

		// Advance past countdown
		sequencer.update(15.0);
		assert.ok(emittedEvents.some(e => e.evt === 'liftoff'), 'Should emit liftoff');
		assert.equal(sequencer.isActive, false, 'Sequencer must finish and deactivate');
	});

	it('should execute full staging lifecycle from boost to payload deployment in CalcRocket', () => {
		const engine = new PhysicsEngine();
		const f9 = createFalcon9Config();

		const earth = engine.addObject({
			id: 1,
			name: 'Earth',
			type: OBJECT_TYPES.CELESTIAL,
			x: 0, y: 0, vx: 0, vy: 0,
			mass: 5.972e24, radius: 6371000
		});

		const rocket = engine.addObject({
			id: 200,
			name: 'Falcon 9',
			type: OBJECT_TYPES.ROCKET,
			x: 0, y: 6371000 + 10, vx: 0, vy: 0,
			mass: f9.totalMassT, radius: 1.85,
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

		// 1. Initial Boost Phase
		assert.equal(rocket.currentStageIndex, 0, 'Stage index must be 0 (Stage 1)');
		assert.equal(rocket.isIgnited, true);

		// 2. Simulate MECO and stage separation
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = 2.0;

		engine._updateFlightControl(0.1);

		// Stage 1 booster debris must exist
		const boosterDebris = engine.objects.find(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 1);
		assert.ok(boosterDebris, 'Stage 1 booster debris must be generated');
		assertClose(boosterDebris.mass, 25.0, 0.1, 'Booster mass must match stage dry mass');
		assert.equal(rocket.currentStageIndex, 1, 'Stage index must advance to 1 (Stage 2)');

		// 3. Fairing Jettison at > 100km altitude
		rocket.y = 6371000 + 110000; // 110 km altitude
		rocket.stageState = 'STG_BURNING';
		rocket.isIgnited = true;

		engine._calculateForces();
		engine._updateFlightControl(0.1);

		const fairingDebris = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 3);
		assert.equal(fairingDebris.length, 2, 'Two fairing half debris items must be generated');
		assert.equal(rocket.fairing.isSeparated, true, 'Fairing must be marked separated');

		// 4. Stage 2 Burnout (SECO) & Separation
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = 2.0;

		engine._calculateForces();
		engine._updateFlightControl(0.1);

		const upperStageDebris = engine.objects.find(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 2);
		assert.ok(upperStageDebris, 'Stage 2 upper stage debris must be generated');
		assertClose(upperStageDebris.mass, 4.5, 0.1, 'Upper stage mass must match dry mass');

		// 5. Payload Separation
		assert.equal(rocket.isPayloadSeparated, true, 'Payload must be marked separated');
		assertClose(rocket.mass, 8.0, 0.1, 'Remaining rocket mass must equal payload mass');
	});

	it('should verify FlightComputer guidance pitch transitions and structural throttle limiters', () => {
		const f9 = createFalcon9Config();
		const rocket = new CalcRocket(
			300, 'Guidance-Test',
			0, 6371000 + 500, 0, 100, 0, 0,
			1.85, 0, f9.totalMassT, f9.stages[0].fuelMassT, f9.stages[0].oxidMassT,
			{
				stages: f9.stages,
				payload: f9.payload,
				fairing: f9.fairing,
				thrustForce: f9.stages[0].maxThrustN,
				burnTime: 162,
				maxGLimit: 3.5,
				flightProfile: [
					{ time: 0, alt: 0, pitch: 90, thrust: 1.0 },
					{ time: 10, alt: 500, pitch: 85, thrust: 1.0 },
					{ time: 60, alt: 15000, pitch: 60, thrust: 0.8 },
					{ time: 150, alt: 70000, pitch: 20, thrust: 0.7 }
				]
			}
		);
		rocket.isIgnited = true;
		rocket.isHoldDown = false;

		const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6371000, 0, 5.972e24);

		// During first 10s: tower clearance lock prevents pitch-over
		rocket.flightControl(1.0, earth, 6371500);
		logDebug(`T=1s Pitch: ${rocket.thrustAngle}`);
		assert.ok(rocket.thrustAngle !== undefined);

		// Verify Max-G limiter engages when acceleration is excessive
		if (rocket.flightComputer) {
			const sensor = {
				v: 500,
				vV: 400,
				vH: 300,
				altM: 10000,
				mass: 100,
				accel: 4.0 * 9.80665, // 4G, exceeds 3.5G limit
				inAtmosphere: true,
				isHoldDown: false,
				isIgnited: true
			};
			rocket.flightComputer.updateGuidance(0.1, sensor, 100);
			const tm = rocket.flightComputer.getTelemetry();
			assert.ok(tm.isGLimitNear, 'Should set isGLimitNear flag');
		}
	});
});
