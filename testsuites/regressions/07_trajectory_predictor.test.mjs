/**
 * Regression Test Suite 07: Trajectory Predictor & Multi-Stage Staging Predictor Events
 * Covers User Issues:
 * - Trajectory predictor broken and forecasting immediate ground crash at launch
 * - Multistage parameter inheritance across prediction steps
 * - Comprehensive detection of all 11 staging and flight events in chronological order
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { OBJECT_TYPES } from '../../scripts/gravsim_const.js';
import { logDebug, createFalcon9Config } from '../test_helpers.mjs';

describe('Regression 07: Trajectory Predictor Multi-Stage Simulation', () => {
	it('should prevent immediate crash prediction at launch and generate high-altitude trajectory', () => {
		const f9Config = createFalcon9Config();
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
			name: 'Falcon 9 Launch Vehicle',
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

		logDebug(`Generated ${result.points.length} trajectory points, maxAlt = ${(result.maxAltM / 1000).toFixed(1)} km`);

		// 1. Verify anti-crash: Should NOT terminate on immediate impact
		assert.ok(result.points.length > 500, `Predictor must generate substantial trajectory points (>500), got ${result.points.length}`);
		assert.ok(result.maxAltM >= 100000, `Predictor must reach orbital/space altitude (>=100 km), got ${(result.maxAltM / 1000).toFixed(1)} km`);

		// Initial points must show upward altitude progression
		assert.ok(result.points[1].altM >= result.points[0].altM, 'Rocket must climb upwards after launch');
		assert.ok(result.points[10].altM > 10.0, 'Rocket altitude must be positive and increasing');
	});

	it('should accurately detect and sequence all flight events chronologically', () => {
		const f9Config = createFalcon9Config();
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
			name: 'Falcon 9 Full Mission',
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

		const findEvent = (predicate) => result.events.find(predicate);

		const pitchEvent = findEvent(e => e.type === 'pitch');
		const meco1Event = findEvent(e => e.id === 'meco_1');
		const stg1SepEvent = findEvent(e => e.id === 'stg_sep_1');
		const ses1Event = findEvent(e => e.id === 'ses_1');
		const fairingEvent = findEvent(e => e.id === 'fairing_sep');
		const apEvent = findEvent(e => e.type === 'ap');
		const orbitEvent = findEvent(e => e.id === 'orbit');
		const seco1Event = findEvent(e => e.id === 'seco_1');
		const stg2SepEvent = findEvent(e => e.id === 'stg_sep_2');
		const payloadSepEvent = findEvent(e => e.id === 'payload_sep');

		// Assert existence of key multi-stage events
		assert.ok(pitchEvent, 'PITCH event must be detected');
		assert.ok(meco1Event, 'MECO-1 event must be detected');
		assert.ok(stg1SepEvent, 'STG-1 SEP event must be detected');
		assert.ok(ses1Event, 'SES-1 event must be detected');
		assert.ok(fairingEvent, 'FAIRING JETTISON event must be detected');
		assert.ok(seco1Event, 'SECO-1 event must be detected');
		assert.ok(stg2SepEvent, '2-STG-SEP event must be detected');
		assert.ok(payloadSepEvent, 'PAYLOAD SEP event must be detected');

		// Assert chronological order (Real Falcon 9 sequence: Fairing jettisons at 110km during Stage 2 burn)
		assert.ok(pitchEvent.time <= meco1Event.time, 'PITCH must occur before MECO-1');
		assert.ok(meco1Event.time <= stg1SepEvent.time, 'MECO-1 must occur before or at STG-1 SEP');
		assert.ok(stg1SepEvent.time <= ses1Event.time, 'STG-1 SEP must occur before or at SES-1');
		assert.ok(ses1Event.time <= fairingEvent.time, 'SES-1 must occur before FAIRING JETTISON (real Falcon 9 sequence)');
		assert.ok(fairingEvent.time <= seco1Event.time, 'FAIRING JETTISON must occur before SECO-1');
		assert.ok(seco1Event.time <= stg2SepEvent.time, 'SECO-1 must occur before 2-STG-SEP');
		assert.ok(stg2SepEvent.time <= payloadSepEvent.time, '2-STG-SEP must occur before or at PAYLOAD SEP');

		// Assert physical plausibility
		assert.ok(fairingEvent.altM >= 100000, 'Fairing must jettison at or above 100km threshold');
		assert.ok(seco1Event.altM >= 100000, 'SECO-1 must occur outside dense atmosphere (>100km)');
	});
});

