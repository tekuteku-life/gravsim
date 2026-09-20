/**
 * Regression Test Suite 05: Stage 2 Upper Stage Separation & Payload Separation Events
 * Covers User Issues:
 * - Missing flight event for Stage 2 engine jettison and payload separation
 * - Final state transition to payload-only mass (8.0t) in ORBITAL_COAST
 * - Trajectory predictor detection of 2-STG-SEP and PAYLOAD SEP events
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { runMultiBodySimulation } from '../../scripts/gravsim_calc_predictor.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { OBJECT_TYPES, MULTISTAGE_ROCKET, MULTISTAGE_PRESETS, PHYSICS } from '../../scripts/gravsim_const.js';
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
		rocket.fairing.isSeparated = true;
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

	it('should verify enhanced Stage 1 separation speed and Stage 2 automated deorbit burn', () => {
		const f9Config = createFalcon9Config();
		const rocket = new CalcRocket(
			1,
			'Falcon 9 Separation Dynamics',
			0, 6371000 + 70000, 2000, 0, 0, 0,
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

		// 1. Test Stage 1 separation
		rocket.thrustAngle = 0; // facing +X
		rocket.vx = 2000;
		rocket.vy = 0;
		rocket.stageState = 'STG_MECO';
		rocket.separateCurrentStage();

		assert.equal(rocket._pendingDebris.length, 1);
		const booster = rocket._pendingDebris[0];
		assert.equal(booster.debrisSubType, 1);
		// Relative velocity between rocket (+1.5 m/s push) and booster (-18 m/s retro kick)
		// rocket.vx = 2001.5, booster.vx = 2000 - 18 = 1982
		assertClose(booster.vx, 1982, 0.1, 'Booster must receive 18 m/s retrograde separation impulse');
		assertClose(rocket.vx, 2001.5, 0.1, 'Upper stage must receive 1.5 m/s forward separation push');
		const relBoosterSpeed = rocket.vx - booster.vx;
		assertClose(relBoosterSpeed, 19.5, 0.1, 'Relative separation speed must be 19.5 m/s');

		// Clear pending debris
		rocket._pendingDebris.length = 0;

		// 2. Fast forward to Stage 2 MECO at orbital altitude (200km, 7800 m/s)
		rocket.thrustAngle = 0;
		rocket.vx = 7800;
		rocket.vy = 0;
		rocket.y = 6371000 + 200000;
		rocket.currentStageIndex = 1;
		rocket.fairing.isSeparated = true;
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.separateCurrentStage();

		const upperStage = rocket._pendingDebris.find(d => d.debrisSubType === 2);
		assert.ok(upperStage, 'Upper stage debris must be present');

		// Expected: rocket.vx = 7800 + 1.5 = 7801.5 m/s (forward push)
		// Upper stage: 7800 - 1.5 (stage sep speed) - 180.0 (deorbit burn) = 7618.5 m/s
		assertClose(upperStage.vx, 7618.5, 0.1, 'Upper stage must receive deorbit delta-v (-180 m/s)');
		assertClose(rocket.vx, 7801.5, 0.1, 'Payload must receive forward push (+1.5 m/s)');
		const relUpperSpeed = rocket.vx - upperStage.vx;
		assertClose(relUpperSpeed, 183.0, 0.1, 'Relative speed after deorbit burn must be ~183.0 m/s');
	});

	it('should insert payload into stable Earth orbit (LEO) and deorbit upper stage with default Falcon 9 launch settings', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS.FALCON9));
		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

		const defaultProfile = [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 2000, thrust: 100, angle: 10 },
			{ type: 'alt', value: 15000, thrust: 100, angle: 25 },
			{ type: 'alt', value: 40000, thrust: 100, angle: 45 },
			{ type: 'alt', value: 80000, thrust: 100, angle: 65 },
			{ type: 'alt', value: 150000, thrust: 100, angle: 78 },
			{ type: 'alt', value: 220000, thrust: 100, angle: 86 },
			{ type: 'alt', value: 280000, thrust: 100, angle: 90 }
		];

		const rocket = engine.addObject({
			id: 100, name: 'Falcon 9', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
			radius: 1.85,
			dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
			burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
			massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
			thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
			isIgnited: true, isHoldDown: false,
			stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
			flightProfile: defaultProfile
		});

		engine._categorizeBodies();

		for (let step = 0; step < 700; step++) {
			engine._moveObjects(1.0);
			if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
				break;
			}
		}

		// 1. Verify SECO occurred and payload cleanly separated
		assert.equal(rocket.isPayloadSeparated, true, 'Payload must be separated after SECO');
		assert.equal(rocket.stageState, 'ORBITAL_COAST', 'Rocket state must be ORBITAL_COAST');
		assertClose(rocket.mass, 8.0, 0.01, 'Remaining rocket mass must be payload mass (8.0t)');

		// 2. Compute Earth-relative orbital elements for payload
		const GM_E = PHYSICS.G * earth.mass;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const r = Math.hypot(relX, relY);
		const altKm = (r - earthRadius) / 1000;
		const relVx = rocket.vx - earth.vx;
		const relVy = rocket.vy - earth.vy;
		const v = Math.hypot(relVx, relVy);
		const energy = (v * v) / 2 - GM_E / r;
		const a = -GM_E / (2 * energy);
		const h = relX * relVy - relY * relVx;
		const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
		const rP_km = (a * (1 - ecc) - earthRadius) / 1000;
		const rA_km = (a * (1 + ecc) - earthRadius) / 1000;

		logDebug(`Falcon 9 LEO Injection: Alt=${altKm.toFixed(1)}km, Speed=${v.toFixed(1)}m/s, Energy=${energy.toExponential(2)} J/kg, Ecc=${ecc.toFixed(3)}, Pe=${rP_km.toFixed(1)}km, Ap=${rA_km.toFixed(1)}km`);

		assert.ok(energy < 0, 'Payload orbital energy must be negative (bound to Earth)');
		assert.ok(ecc <= 0.05, `Orbital eccentricity must be near-circular (actual: ${ecc.toFixed(3)})`);
		assert.ok(rP_km >= 200, `Perigee must be well outside atmosphere (actual: ${rP_km.toFixed(1)} km)`);
		assert.ok(rA_km <= 500, `Apogee must be within LEO range (actual: ${rA_km.toFixed(1)} km)`);

		// 3. Verify Stage 2 Upper Stage debris deorbit
		const stage2Debris = engine.objects.find(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 2);
		assert.ok(stage2Debris, 'Stage 2 upper stage debris must be present in simulation');

		const debRelX = stage2Debris.x - earth.x;
		const debRelY = stage2Debris.y - earth.y;
		const debR = Math.hypot(debRelX, debRelY);
		const debRelVx = stage2Debris.vx - earth.vx;
		const debRelVy = stage2Debris.vy - earth.vy;
		const debV = Math.hypot(debRelVx, debRelVy);
		const debEnergy = (debV * debV) / 2 - GM_E / debR;
		const debA = -GM_E / (2 * debEnergy);
		const debH = debRelX * debRelVy - debRelY * debRelVx;
		const debEcc = Math.sqrt(Math.max(0, 1 + (2 * debEnergy * debH * debH) / (GM_E * GM_E)));
		const debPe_km = (debA * (1 - debEcc) - earthRadius) / 1000;

		logDebug(`Stage 2 Debris Deorbit: Pe=${debPe_km.toFixed(1)}km, Ecc=${debEcc.toFixed(3)}`);
		assert.ok(debPe_km < 80, `Stage 2 debris perigee must dip into atmosphere to ensure disposal (actual: ${debPe_km.toFixed(1)} km)`);
	});

	it('should insert payload into stable orbit without crashing using default H3 launch settings', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS.H3));
		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

		const rocket = engine.addObject({
			id: 100, name: 'H3', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
			radius: 2.6,
			dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
			burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
			massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
			thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
			isIgnited: true, isHoldDown: false,
			stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
			flightProfile: preset.flightProfile
		});

		engine._categorizeBodies();

		for (let step = 0; step < 800; step++) {
			engine._moveObjects(1.0);
			if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
				break;
			}
		}

		assert.equal(rocket.isPayloadSeparated, true, 'H3 payload must be separated after SECO');
		assert.equal(rocket.stageState, 'ORBITAL_COAST', 'Rocket state must be ORBITAL_COAST');

		const GM_E = PHYSICS.G * earth.mass;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const r = Math.hypot(relX, relY);
		const relVx = rocket.vx - earth.vx;
		const relVy = rocket.vy - earth.vy;
		const v = Math.hypot(relVx, relVy);
		const energy = (v * v) / 2 - GM_E / r;
		const a = -GM_E / (2 * energy);
		const h = relX * relVy - relY * relVx;
		const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
		const rP_km = (a * (1 - ecc) - earthRadius) / 1000;
		const rA_km = (a * (1 + ecc) - earthRadius) / 1000;

		logDebug(`H3 Injection: Speed=${v.toFixed(1)}m/s, Energy=${energy.toExponential(2)} J/kg, Ecc=${ecc.toFixed(3)}, Pe=${rP_km.toFixed(1)}km, Ap=${rA_km.toFixed(1)}km`);

		assert.ok(energy < 0, 'H3 payload orbital energy must be negative (bound to Earth)');
		assert.ok(rP_km >= 150, `H3 perigee must be safely outside atmosphere (actual: ${rP_km.toFixed(1)} km)`);
		assert.ok(rA_km >= 600, `H3 apogee must form an elliptical orbit (actual: ${rA_km.toFixed(1)} km)`);

		// Stage 2 debris must be deorbited
		const stage2Debris = engine.objects.find(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 2);
		assert.ok(stage2Debris, 'H3 Stage 2 upper stage debris must be present');
		const debRelX = stage2Debris.x - earth.x;
		const debRelY = stage2Debris.y - earth.y;
		const debR = Math.hypot(debRelX, debRelY);
		const debRelVx = stage2Debris.vx - earth.vx;
		const debRelVy = stage2Debris.vy - earth.vy;
		const debV = Math.hypot(debRelVx, debRelVy);
		const debEnergy = (debV * debV) / 2 - GM_E / debR;
		const debA = -GM_E / (2 * debEnergy);
		const debH = debRelX * debRelVy - debRelY * debRelVx;
		const debEcc = Math.sqrt(Math.max(0, 1 + (2 * debEnergy * debH * debH) / (GM_E * GM_E)));
		const debPe_km = (debA * (1 - debEcc) - earthRadius) / 1000;
		assert.ok(debPe_km < 80, `H3 Stage 2 debris perigee must dip into atmosphere (actual: ${debPe_km.toFixed(1)} km)`);
	});

	it('should execute multi-burn stage 2 coast and apogee reignition for circularization', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS.H3));
		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const multiBurnProfile = [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 2000, thrust: 100, angle: 10 },
			{ type: 'alt', value: 15000, thrust: 100, angle: 25 },
			{ type: 'alt', value: 40000, thrust: 100, angle: 45 },
			{ type: 'alt', value: 75000, thrust: 100, angle: 65 },
			{ type: 'alt', value: 120000, thrust: 100, angle: 80 },
			{ type: 'alt', value: 180000, thrust: 100, angle: 88 },
			{ type: 'time', value: 340, thrust: 0, angle: 90 },
			{ type: 'apogee', value: 0, thrust: 100, angle: 90 }
		];

		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

		const rocket = engine.addObject({
			id: 100, name: 'H3 MultiBurn', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
			radius: 2.6,
			dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
			burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
			massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
			thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
			isIgnited: true, isHoldDown: false,
			stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
			flightProfile: multiBurnProfile
		});

		engine._categorizeBodies();

		let enteredCoast = false;
		let reignitedAtApogee = false;

		for (let step = 0; step < 2000; step++) {
			engine._moveObjects(1.0);
			if (rocket.stageState === 'STG_COAST') {
				enteredCoast = true;
			}
			if (enteredCoast && rocket.stageState === 'STG_BURNING') {
				reignitedAtApogee = true;
			}
			if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
				break;
			}
		}

		assert.ok(enteredCoast, 'Rocket must have entered STG_COAST mode after first burn cutoff');
		assert.ok(reignitedAtApogee, 'Rocket must have reignited at apogee');
		assert.equal(rocket.isPayloadSeparated, true, 'Payload must separate upon final orbital cutoff');

		const GM_E = PHYSICS.G * earth.mass;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const r = Math.hypot(relX, relY);
		const relVx = rocket.vx - earth.vx;
		const relVy = rocket.vy - earth.vy;
		const v = Math.hypot(relVx, relVy);
		const energy = (v * v) / 2 - GM_E / r;
		const a = -GM_E / (2 * energy);
		const h = relX * relVy - relY * relVx;
		const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
		const rP_km = (a * (1 - ecc) - earthRadius) / 1000;

		assert.ok(energy < 0, 'Orbit must be bound to Earth');
		assert.ok(rP_km >= 150, `Perigee after circularization burn must be >= 150 km (actual: ${rP_km.toFixed(1)} km)`);
	});

	it('should launch Epsilon 3-stage solid rocket and insert ASNARO-2 payload into stable orbit', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS.EPSILON));
		assert.equal(preset.stages.length, 3, 'Epsilon must have 3 stages');
		assert.equal(preset.stages[0].fuelType, 'solid', 'Stage 1 must be solid fuel');
		assert.equal(preset.stages[1].fuelType, 'solid', 'Stage 2 must be solid fuel');
		assert.equal(preset.stages[2].fuelType, 'solid', 'Stage 3 must be solid fuel');

		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

		const rocket = engine.addObject({
			id: 105, name: 'Epsilon Rocket', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
			radius: 1.3,
			dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
			burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
			massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
			thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
			isIgnited: true, isHoldDown: false,
			stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
			flightProfile: preset.flightProfile
		});

		engine._categorizeBodies();

		let reachedStage1 = false;
		let reachedStage2 = false;
		let fairingSeparated = false;

		for (let step = 0; step < 700; step++) {
			engine._moveObjects(1.0);

			if (rocket.currentStageIndex === 1) reachedStage1 = true;
			if (rocket.currentStageIndex === 2) reachedStage2 = true;
			if (rocket.fairing.isSeparated) fairingSeparated = true;

			if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
				break;
			}
		}

		assert.ok(reachedStage1, 'Rocket must advance to Stage 2');
		assert.ok(reachedStage2, 'Rocket must advance to Stage 3');
		assert.ok(fairingSeparated, 'Payload fairing must separate');
		assert.equal(rocket.isPayloadSeparated, true, 'ASNARO-2 payload must separate upon SECO');
		assert.equal(rocket.name, 'ASNARO-2', 'Rocket name must transition to ASNARO-2 payload');

		const GM_E = PHYSICS.G * earth.mass;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const r = Math.hypot(relX, relY);
		const relVx = rocket.vx - earth.vx;
		const relVy = rocket.vy - earth.vy;
		const v = Math.hypot(relVx, relVy);
		const energy = (v * v) / 2 - GM_E / r;
		const a = -GM_E / (2 * energy);
		const h = relX * relVy - relY * relVx;
		const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
		const rP_km = (a * (1 - ecc) - earthRadius) / 1000;
		const rA_km = (a * (1 + ecc) - earthRadius) / 1000;

		logDebug(`Epsilon Final Orbit: Energy=${energy.toExponential(2)}, Ecc=${ecc.toFixed(3)}, Pe=${rP_km.toFixed(1)}km, Ap=${rA_km.toFixed(1)}km`);

		assert.ok(energy < 0, 'ASNARO-2 orbit must be bound to Earth');
		assert.ok(rP_km >= 170, `Perigee must be outside dense atmosphere (actual: ${rP_km.toFixed(1)} km)`);
		assert.ok(rA_km >= 500, `Apogee must be orbit height (actual: ${rA_km.toFixed(1)} km)`);
	});

	it('should launch SSTO single-stage rocket and insert Orbital Capsule into stable orbit', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS.SSTO));
		assert.equal(preset.stages.length, 1, 'SSTO must have exactly 1 stage');
		assert.equal(preset.fairing.enabled, true, 'SSTO fairing must be enabled');

		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const engine = new PhysicsEngine();
		engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
		const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

		const rocket = engine.addObject({
			id: 106, name: 'SSTO Craft', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
			radius: 2.5,
			dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
			burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
			massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
			thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
			maxGLimit: 4.0,
			isIgnited: true, isHoldDown: false,
			stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
			flightProfile: preset.flightProfile
		});

		engine._categorizeBodies();

		for (let step = 0; step < 700; step++) {
			engine._moveObjects(1.0);
			if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
				break;
			}
		}

		assert.equal(rocket.isPayloadSeparated, true, 'SSTO payload must separate upon SECO');
		assert.equal(rocket.name, 'Orbital Capsule', 'Rocket name must transition to Orbital Capsule payload');

		const GM_E = PHYSICS.G * earth.mass;
		const relX = rocket.x - earth.x;
		const relY = rocket.y - earth.y;
		const r = Math.hypot(relX, relY);
		const relVx = rocket.vx - earth.vx;
		const relVy = rocket.vy - earth.vy;
		const v = Math.hypot(relVx, relVy);
		const energy = (v * v) / 2 - GM_E / r;
		const a = -GM_E / (2 * energy);
		const h = relX * relVy - relY * relVx;
		const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
		const rP_km = (a * (1 - ecc) - earthRadius) / 1000;
		const rA_km = (a * (1 + ecc) - earthRadius) / 1000;

		logDebug(`SSTO Final Orbit: Energy=${energy.toExponential(2)}, Ecc=${ecc.toFixed(3)}, Pe=${rP_km.toFixed(1)}km, Ap=${rA_km.toFixed(1)}km`);

		assert.ok(energy < 0, 'Orbital Capsule orbit must be bound to Earth');
		assert.ok(rP_km >= 160, `Perigee must be outside dense atmosphere (actual: ${rP_km.toFixed(1)} km)`);
	});

	it('should verify ALL MULTISTAGE_PRESETS (FALCON9, H3, EPSILON, SSTO) can achieve stable Earth orbit', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const presetKeys = Object.keys(MULTISTAGE_PRESETS);
		assert.ok(presetKeys.length >= 4, 'Must have at least 4 presets (FALCON9, H3, EPSILON, SSTO)');

		for (const key of presetKeys) {
			const preset = JSON.parse(JSON.stringify(MULTISTAGE_PRESETS[key]));
			const engine = new PhysicsEngine();
			engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
			const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

			const rocket = engine.addObject({
				id: 200, name: preset.name, type: OBJECT_TYPES.ROCKET,
				x: AU, y: dy, vx: earth.vx + rotVx, vy: earth.vy,
				radius: preset.stages[0].radius || 2.0,
				dryMass: preset.stages[0].dryMassT, fuelMass: preset.stages[0].fuelMassT, oxidMass: preset.stages[0].oxidMassT,
				burnTime: preset.stages[0].burnTime, ofRatio: preset.stages[0].ofRatio,
				massLossRate: (preset.stages[0].fuelMassT + preset.stages[0].oxidMassT) / preset.stages[0].burnTime,
				thrustForce: preset.stages[0].thrustKN * 1000, thrustAngle: -Math.PI / 2,
				maxGLimit: 4.0,
				isIgnited: true, isHoldDown: false,
				stages: preset.stages, payload: preset.payload, fairing: preset.fairing,
				flightProfile: preset.flightProfile
			});

			engine._categorizeBodies();

			for (let step = 0; step < 800; step++) {
				engine._moveObjects(1.0);
				if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
					break;
				}
			}

			const GM_E = PHYSICS.G * earth.mass;
			const relX = rocket.x - earth.x;
			const relY = rocket.y - earth.y;
			const r = Math.hypot(relX, relY);
			const relVx = rocket.vx - earth.vx;
			const relVy = rocket.vy - earth.vy;
			const v = Math.hypot(relVx, relVy);
			const energy = (v * v) / 2 - GM_E / r;
			const a = -GM_E / (2 * energy);
			const h = relX * relVy - relY * relVx;
			const ecc = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (GM_E * GM_E)));
			const rP_km = (a * (1 - ecc) - earthRadius) / 1000;
			const rA_km = (a * (1 + ecc) - earthRadius) / 1000;

			logDebug(`Preset [${key}]: Energy=${energy.toExponential(2)}, Ecc=${ecc.toFixed(3)}, Pe=${rP_km.toFixed(1)}km, Ap=${rA_km.toFixed(1)}km, Sep=${rocket.isPayloadSeparated}`);

			assert.ok(energy < 0, `Preset ${key} must achieve negative orbital energy (bound to Earth)`);
			assert.ok(rP_km >= 150, `Preset ${key} perigee must be >= 150 km to avoid atmospheric reentry (actual: ${rP_km.toFixed(1)} km)`);
			assert.equal(rocket.isPayloadSeparated, true, `Preset ${key} payload must be separated`);
			assert.equal(rocket.stageState, 'ORBITAL_COAST', `Preset ${key} state must be ORBITAL_COAST`);
		}
	});
});

