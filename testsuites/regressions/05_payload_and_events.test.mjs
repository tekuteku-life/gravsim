/**
 * Regression Test Suite 05: Stage 2 Upper Stage Separation & Payload Separation Events
 * Covers User Issues:
 * - Missing flight event for Stage 2 engine jettison and payload separation
 * - Final state transition to payload-only mass (8.0t) in ORBITAL_COAST
 * - Trajectory predictor detection of 2-STG-SEP and PAYLOAD SEP events
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { OBJECT_TYPES, MULTISTAGE_ROCKET } from '../../scripts/gravsim_const.js';
import { logDebug, assertClose, createFalcon9Config } from '../test_helpers.mjs';

describe('Regression 05: Stage 2 Separation & Payload Separation Events', () => {
	it('should cleanly transition rocket to payload (8.0t) upon Stage 2 separation', () => {
		const f9Config = createFalcon9Config();
		const rocket = new CalcRocket(
			1,
			'Falcon 9 Mission',
			0, 6371000 + 200000, 7800, 0, 0, 0,
			1.85, 0,
			f9Config.stages[0].dryMassT,
			f9Config.stages[0].fuelMassT,
			f9Config.stages[0].oxidMassT,
			{
				thrustForce: f9Config.stages[0].maxThrustN,
				burnTime: 162,
				stages: f9Config.stages,
				payload: f9Config.payload,
				fairing: f9Config.fairing
			}
		);

		// Fast-forward rocket to Stage 2 SECO (Stage index = 1, burnTime = 0, fuel = 0)
		rocket.currentStageIndex = 1;
		rocket._activateStage(1);
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = MULTISTAGE_ROCKET.DEFAULT_SEPARATION_DELAY_SEC + 0.1;

		logDebug(`Pre-separation mass on Stage 2: ${rocket.mass} t, State: ${rocket.stageState}`);

		// Trigger separation of final stage
		rocket.separateCurrentStage();

		logDebug(`Post-separation mass: ${rocket.mass} t, State: ${rocket.stageState}, isPayloadSeparated: ${rocket.isPayloadSeparated}`);

		// 1. Validate payload flags and state
		assert.equal(rocket.isPayloadSeparated, true, 'isPayloadSeparated must be true');
		assert.equal(rocket.stageState, 'ORBITAL_COAST', 'Stage state must be ORBITAL_COAST');
		assert.equal(rocket.currentStageIndex, 2, 'Stage index must be totalStages (2)');

		// 2. Validate mass is strictly the payload mass (8.0t)
		assert.equal(rocket.dryMass, 0, 'Stage dry mass must be 0 after jettison');
		assert.equal(rocket.fuelMass, 0, 'Fuel mass must be 0');
		assert.equal(rocket.thrustForce, 0, 'Thrust force must be 0');
		assertClose(rocket.mass, 8.0, 0.01, 'Rocket mass must be exactly payload mass (8.0t)');

		// 3. Validate that calling updateTotalMass preserves payload mass without double-adding empty stages
		rocket.updateTotalMass();
		assertClose(rocket.mass, 8.0, 0.01, 'updateTotalMass must keep payload mass (8.0t)');

		// 4. Validate queued debris item for Stage 2 upper booster
		assert.equal(rocket._pendingDebris.length, 1, 'Exactly 1 upper stage debris must be queued');
		const deb = rocket._pendingDebris[0];
		assert.equal(deb.debrisSubType, 2, 'Debris subtype must be 2 (Stage 2 Upper Stage)');
		assertClose(deb.mass, 4.5, 0.01, 'Debris mass must match Stage 2 dry mass (4.5t)');
	});

	it('should encode and decode isPayloadSeparated bit flag in WorkerBridge', () => {
		const mockRocket = {
			id: 1,
			name: 'Orbital Satellite',
			type: OBJECT_TYPES.ROCKET,
			x: 0,
			y: 6500000,
			vx: 7800,
			vy: 0,
			ax: 0,
			ay: 0,
			mass: 8.0,
			dryMass: 8.0,
			radius: 1.5,
			fuelMass: 0,
			oxidMass: 0,
			isPayloadSeparated: true, // Target flag
			isIgnited: false,
			isHoldDown: false,
			flightComputer: {
				getTelemetry: () => ({
					status: 0,
					qAxialKpa: 0,
					qLateralKpa: 0,
					structRatio: 0,
					aoaDeg: 0,
					progradeAngle: 0,
					gravityAngle: 0,
					remDv: 0,
					twr: 0,
					altM: 200000,
					vV: 0,
					vH: 7800,
					aV: 0,
					aH: 0,
					currentG: 1.0,
					flightTime: 600,
					isAntiStallActive: false,
					isQLimitNear: false,
					isGLimitNear: false
				})
			}
		};

		// Format worker buffer
		const buffer = WorkerBridge.formatWorkerToMain([mockRocket]);

		// Parse worker buffer
		let decodedRocket = null;
		WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (item) => {
			decodedRocket = { ...item };
		});

		assert.ok(decodedRocket, 'Decoded rocket must exist');
		logDebug(`Decoded rocket isPayloadSeparated: ${decodedRocket.isPayloadSeparated}`);
		assert.equal(decodedRocket.isPayloadSeparated, true, 'isPayloadSeparated flag must decode as true');
	});

	it('should detect 2-STG-SEP and PAYLOAD SEP events in trajectory prediction simulation', () => {
		const f9Config = createFalcon9Config();

		// Earth at origin
		const earthRadius = 6371000;
		const celestialBodies = [
			{
				id: 1,
				name: 'Earth',
				type: OBJECT_TYPES.CELESTIAL,
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				massKg: 5.972e24,
				radius: earthRadius
			}
		];

		const rocketConfig = {
			name: 'Falcon 9 Simulation',
			hostId: 1,
			x: 0,
			y: earthRadius + 10,
			vx: 0,
			vy: 0,
			radius: 1.85,
			dryMassT: f9Config.stages[0].dryMassT,
			fuelMassT: f9Config.stages[0].fuelMassT,
			oxidMassT: f9Config.stages[0].oxidMassT,
			thrustForceN: f9Config.stages[0].maxThrustN,
			burnTime: f9Config.stages[0].burnTime,
			stages: f9Config.stages,
			payload: f9Config.payload,
			fairing: f9Config.fairing,
			flightProfile: [
				{ type: 'time', value: 0, thrust: 100, angle: 0 },
				{ type: 'time', value: 10, thrust: 100, angle: 5 },
				{ type: 'time', value: 60, thrust: 100, angle: 25 },
				{ type: 'time', value: 150, thrust: 100, angle: 60 },
				{ type: 'time', value: 300, thrust: 100, angle: 80 },
				{ type: 'time', value: 500, thrust: 100, angle: 90 }
			]
		};

		const result = runMultiBodySimulation({
			hostId: 1,
			celestialBodies,
			rocketConfig,
			options: { maxSimTime: 1200, dt: 0.5 }
		});

		logDebug(`Simulation generated ${result.points.length} trajectory points, ${result.events.length} flight events`);

		const eventNames = result.events.map(e => e.name);
		logDebug(`Detected Events: ${eventNames.join(' -> ')}`);

		// Verify 2-STG-SEP and PAYLOAD SEP are both detected
		const stage2SepEvent = result.events.find(e => e.id === 'stg_sep_2' || e.name === '2-STG-SEP');
		const payloadSepEvent = result.events.find(e => e.id === 'payload_sep' || e.name === 'PAYLOAD SEP');

		assert.ok(stage2SepEvent, '2-STG-SEP event marker must be present in predicted trajectory');
		assert.ok(payloadSepEvent, 'PAYLOAD SEP event marker must be present in predicted trajectory');

		logDebug(`2-STG-SEP at t = ${stage2SepEvent.time.toFixed(1)}s, alt = ${(stage2SepEvent.altM / 1000).toFixed(1)}km`);
		logDebug(`PAYLOAD SEP at t = ${payloadSepEvent.time.toFixed(1)}s, alt = ${(payloadSepEvent.altM / 1000).toFixed(1)}km`);

		assert.ok(stage2SepEvent.time > 0, '2-STG-SEP time must be positive');
		assert.ok(payloadSepEvent.time >= stage2SepEvent.time, 'PAYLOAD SEP must occur after or concurrently with 2-STG-SEP');
	});
});

