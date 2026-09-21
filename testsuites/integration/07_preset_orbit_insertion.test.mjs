/**
 * Integration Test Suite 07: Preset Orbit Insertion & Dynamic Sizing Verification
 * 
 * Verifies User Requirements:
 * 1. Separation of Concerns: Vehicle presets must NOT contain flightProfile or payload.
 * 2. Dynamic Sizing: Vehicle A + Payload B + Orbit C dynamically calculates:
 *    - Rocket A fuel/oxidizer and burn times
 *    - Payload B propulsion fuel/oxidizer and burn time (if self-propelled)
 * 3. Orbit Insertion Verification: ALL 6 vehicles (H3-30, H3-22, H3-24, Falcon 9, Epsilon, SSTO)
 *    achieve stable Earth orbit without crashing when launched with target mission presets.
 * 4. RocketTab UI Parameter Synchronization.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { OBJECT_TYPES, PHYSICS, MULTISTAGE_ROCKET } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createMockUniverse, logDebug } from '../test_helpers.mjs';

describe('Integration 07: Comprehensive Preset Orbit Insertion & Dynamic Sizing', () => {
	let cleanupDOM;
	let universe;

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
		universe = createMockUniverse();
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	describe('1. Separation of Concerns in Preset JSONs', () => {
		it('should verify NO vehicle preset JSON contains flightProfile or payload', () => {
			const vehiclesDir = path.resolve(process.cwd(), 'presets/vehicles');
			const manifestPath = path.join(vehiclesDir, 'manifest.json');
			assert.ok(fs.existsSync(manifestPath), 'Vehicle manifest.json must exist');
			const vehicleIds = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

			for (const vid of vehicleIds) {
				const filePath = path.join(vehiclesDir, `${vid}.json`);
				assert.ok(fs.existsSync(filePath), `Vehicle file ${vid}.json must exist`);
				const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

				assert.strictEqual(
					data.flightProfile,
					undefined,
					`Vehicle preset ${vid}.json must NOT contain flightProfile`
				);
				assert.strictEqual(
					data.payload,
					undefined,
					`Vehicle preset ${vid}.json must NOT contain payload`
				);
				assert.ok(Array.isArray(data.stages), `Vehicle preset ${vid}.json must define hardware stages`);
				assert.ok(data.stages.length >= 1, `Vehicle preset ${vid}.json must have at least 1 stage`);
			}
		});

		it('should verify all mission presets define flightProfile and targetDeltaVM_S without vehicle-specific fuel loads', () => {
			const missionsDir = path.resolve(process.cwd(), 'presets/missions');
			const manifestPath = path.join(missionsDir, 'manifest.json');
			assert.ok(fs.existsSync(manifestPath), 'Mission manifest.json must exist');
			const missionIds = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

			for (const mid of missionIds) {
				const filePath = path.join(missionsDir, `${mid}.json`);
				assert.ok(fs.existsSync(filePath), `Mission file ${mid}.json must exist`);
				const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

				assert.ok(Array.isArray(data.flightProfile), `Mission ${mid}.json must have flightProfile array`);
				assert.ok(data.flightProfile.length >= 3, `Mission ${mid}.json flightProfile must have profile steps`);
				assert.ok(data.targetDeltaVM_S > 0, `Mission ${mid}.json must define targetDeltaVM_S`);
				assert.strictEqual(
					data.propellantLoads,
					undefined,
					`Mission ${mid}.json must NOT contain hardcoded propellantLoads`
				);
			}
		});
	});

	describe('2. Dynamic Fuel & Thrust Calculation Engine', () => {
		it('should dynamically calculate rocket propellant and payload propellant based on mission requirements', () => {
			const pm = new PresetManager();
			const vehicle = pm.getVehicle('h3_30');
			const selfPropelledPayload = pm.getPayload('htv_x');
			const passivePayload = pm.getPayload('asnaro_2');
			const leoMission = pm.getMission('leo_250km');
			const issMission = pm.getMission('iss_rendezvous');

			// Case A: Self-propelled payload on ISS mission (requires payload delta-V)
			const planA = pm.calculateMissionFlightPlan({
				vehicle,
				payload: selfPropelledPayload,
				mission: issMission
			});

			assert.ok(planA.payload.propulsion, 'Payload propulsion object must exist');
			assert.ok(planA.payload.propulsion.fuelMassT > 0, 'HTV-X must receive calculated fuel mass');
			assert.ok(planA.payload.propulsion.oxidMassT > 0, 'HTV-X must receive calculated oxidizer mass');
			assert.ok(planA.payload.propulsion.burnTime > 0, 'HTV-X must have non-zero burn time');

			// Case B: Passive payload on LEO mission (no propulsion)
			const planB = pm.calculateMissionFlightPlan({
				vehicle,
				payload: passivePayload,
				mission: leoMission
			});

			assert.ok(!planB.payload.propulsion || !planB.payload.propulsion.enabled, 'Passive payload must have null or disabled propulsion');
			assert.equal(planB.payload.massT, 0.6, 'Passive payload mass must match design mass');

			// Verify rocket core burn time and propellant
			assert.equal(planB.stages.length, 2, 'H3-30 must have 2 stages');
			assert.ok(planB.stages[0].burnTime > 200, 'Stage 1 burn time must be physically sized');
			assert.ok(planB.stages[1].burnTime > 400, 'Stage 2 burn time must be physically sized');
		});

		it('should accurately calculate core burn time for booster configurations (H3-22, H3-24)', () => {
			const pm = new PresetManager();
			const h3_22 = pm.getVehicle('h3_22');
			const h3_24 = pm.getVehicle('h3_24');
			const mission = pm.getMission('leo_250km');

			const plan22 = pm.calculateMissionFlightPlan({ vehicle: h3_22, mission });
			const plan24 = pm.calculateMissionFlightPlan({ vehicle: h3_24, mission });

			// With coreThrustKN = 2940 kN and ~238-252t propellant, core burn time is ~290-360s
			assert.ok(plan22.stages[0].burnTime >= 280, 'H3-22 Stage 1 core burn time must account for core LE-9 thrust');
			assert.ok(plan24.stages[0].burnTime >= 280, 'H3-24 Stage 1 core burn time must account for core LE-9 thrust');
			assert.equal(plan22.boosters.count, 2, 'H3-22 must have 2 SRBs');
			assert.equal(plan24.boosters.count, 4, 'H3-24 must have 4 SRBs');
		});
	});

	describe('3. Orbital Insertion Physics Simulation across ALL Vehicles', () => {
		const AU = 149597870700;
		const earthRadius = 6371000;
		const earthOrbitSpeed = 29780;
		const omega = (2 * Math.PI) / 86400;
		const dy = -(earthRadius + 10);
		const rotVx = -omega * dy;

		const vehicleTestConfigs = [
			{ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km', name: 'H3-30 (LE-9x3 Core)' },
			{ vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km', name: 'H3-22 (2x SRB-3 + 2x LE-9)' },
			{ vehicleId: 'h3_24', payloadId: 'earth_obs', missionId: 'leo_250km', name: 'H3-24 (4x SRB-3 + 2x LE-9)' },
			{ vehicleId: 'falcon9', payloadId: 'earth_obs', missionId: 'leo_250km', name: 'Falcon 9' },
			{ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', name: 'Epsilon S (All-Solid)' },
			{ vehicleId: 'ssto', payloadId: 'earth_obs', missionId: 'leo_250km', name: 'Single Stage to Orbit (SSTO)' }
		];

		for (const config of vehicleTestConfigs) {
			it(`should achieve stable Earth orbit for vehicle preset: ${config.name} (${config.vehicleId})`, () => {
				const pm = new PresetManager();
				const vehicle = pm.getVehicle(config.vehicleId);
				const payload = pm.getPayload(config.payloadId);
				const mission = pm.getMission(config.missionId);

				assert.ok(vehicle, `Vehicle ${config.vehicleId} must be loaded`);
				assert.ok(payload, `Payload ${config.payloadId} must be loaded`);
				assert.ok(mission, `Mission ${config.missionId} must be loaded`);

				const plan = pm.calculateMissionFlightPlan({ vehicle, payload, mission });
				assert.ok(plan, 'Flight plan must be successfully generated');

				const engine = new PhysicsEngine();
				engine.addObject({ id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
				const earth = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: earthOrbitSpeed, mass: 5.972e24, radius: earthRadius });

				const rocket = engine.addObject({
					id: 300,
					name: vehicle.name,
					type: OBJECT_TYPES.ROCKET,
					x: AU,
					y: dy,
					vx: earth.vx + rotVx,
					vy: earth.vy,
					radius: plan.stages[0].radius || 2.0,
					dryMass: plan.stages[0].dryMassT,
					fuelMass: plan.stages[0].fuelMassT,
					oxidMass: plan.stages[0].oxidMassT,
					burnTime: plan.stages[0].burnTime,
					ofRatio: plan.stages[0].ofRatio,
					massLossRate: (plan.stages[0].fuelMassT + plan.stages[0].oxidMassT) / plan.stages[0].burnTime,
					thrustForce: plan.stages[0].thrustKN * 1000,
					thrustAngle: -Math.PI / 2,
					maxGLimit: 4.0,
					isIgnited: true,
					isHoldDown: false,
					stages: plan.stages,
					payload: plan.payload,
					fairing: plan.fairing,
					boosters: plan.boosters,
					flightProfile: plan.flightProfile,
					disableOrbitalCutoff: plan.disableOrbitalCutoff
				});

				engine._categorizeBodies();

				let minAltKm = Infinity;
				let maxAltKm = -Infinity;
				let orbitAchieved = false;

				for (let step = 0; step < 850; step++) {
					engine._moveObjects(1.0);

					const curDist = Math.hypot(rocket.x - earth.x, rocket.y - earth.y);
					const curAltKm = (curDist - earthRadius) / 1000;
					if (curAltKm < minAltKm) minAltKm = curAltKm;
					if (curAltKm > maxAltKm) maxAltKm = curAltKm;

					// Safety check: Rocket must not crash into Earth during powered ascent
					assert.ok(curAltKm >= -0.1, `Rocket ${config.vehicleId} must not crash into Earth (alt=${curAltKm.toFixed(1)} km at step ${step})`);

					if (rocket.stageState === 'ORBITAL_COAST' && rocket.isPayloadSeparated) {
						orbitAchieved = true;
						break;
					}
				}

				assert.ok(orbitAchieved, `Vehicle ${config.vehicleId} must complete all stages and achieve ORBITAL_COAST with payload separated`);

				// Calculate orbital elements relative to Earth
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
				const peKm = (a * (1 - ecc) - earthRadius) / 1000;
				const apKm = (a * (1 + ecc) - earthRadius) / 1000;

				logDebug(`Preset [${config.vehicleId}] Result: Alt=${((r - earthRadius)/1000).toFixed(1)}km, Pe=${peKm.toFixed(1)}km, Ap=${apKm.toFixed(1)}km, Ecc=${ecc.toFixed(3)}, E=${energy.toExponential(2)}`);

				// Orbital assertions
				assert.ok(energy < 0, `Vehicle ${config.vehicleId} must achieve negative orbital energy (bound to Earth)`);
				assert.ok(ecc < 1.0, `Vehicle ${config.vehicleId} must achieve closed elliptical/circular orbit (ecc=${ecc.toFixed(3)})`);
				assert.ok(peKm >= 150, `Vehicle ${config.vehicleId} perigee must be >= 150 km to avoid atmospheric reentry (actual: ${peKm.toFixed(1)} km)`);
				assert.equal(rocket.isPayloadSeparated, true, `Vehicle ${config.vehicleId} payload must be separated`);
			});
		}
	});

	describe('4. UI Synchronization with RocketTab', () => {
		it('should apply dynamic flight plan to RocketLauncher and synchronize RocketTab UI elements', () => {
			const launcher = universe.RocketLauncher;
			const pm = presetManager;

			// Select vehicle, payload, and mission
			pm.applyToLauncher(launcher, {
				vehicleId: 'h3_22',
				payloadId: 'htv_x',
				missionId: 'iss_rendezvous'
			});

			assert.equal(launcher.currentVehicleId, 'h3_22', 'Launcher vehicle ID must be h3_22');
			assert.equal(launcher.currentPayloadId, 'htv_x', 'Launcher payload ID must be htv_x');
			assert.equal(launcher.currentMissionId, 'iss_rendezvous', 'Launcher mission ID must be iss_rendezvous');
			assert.ok(launcher.stages.length === 2, 'Launcher must have 2 stages');
			assert.ok(launcher.boosters && launcher.boosters.count === 2, 'Launcher must have 2 SRBs');
			assert.ok(launcher.payload && launcher.payload.propulsion, 'HTV-X must retain calculated on-board propulsion');

			const rocketTab = new RocketTab(universe);

			// Switch to payload tab
			rocketTab.selectTab('payload');
			const propPanel = document.getElementById('rl-payload-propulsion-panel');
			assert.ok(propPanel, 'Payload propulsion panel element must exist');
			assert.equal(propPanel.style.display, 'block', 'Propulsion panel must be visible for HTV-X');

			// Switch to passive payload (asnaro_2)
			pm.applyToLauncher(launcher, {
				vehicleId: 'epsilon',
				payloadId: 'asnaro_2',
				missionId: 'leo_250km'
			});
			rocketTab.selectTab('payload');
			assert.equal(propPanel.style.display, 'none', 'Propulsion panel must be hidden for passive payload');
		});
	});
});

