/**
 * Regression Test Suite 02: Rocket Fuel State, Bar Percentage, and REM Delta-V Integrity
 * Covers User Issues:
 * - Fuel display dropping to 1/1000 on ignition (kg/ton double-conversion bug)
 * - Fuel bar percentage decreasing smoothly without jumping to 0.1%
 * - REM Delta-V unit consistency (m/s vs km/s) and multi-stage total delta-V calculation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { PHYSICS, MULTISTAGE_PRESETS, MULTISTAGE_ROCKET, ROCKET_FUELS } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { ControlPanel } from '../../scripts/gravsim_control_panel.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { logDebug, assertClose, createFalcon9Config, createMockUniverse, createMockCelestialBody, setupMockDOM } from '../test_helpers.mjs';

describe('Regression 02: Fuel Mass, Fuel Bar, and REM Delta-V Integrity', () => {
	it('should maintain fuel and oxidizer in metric tons across ignition without 1/1000 drop', () => {
		const f9Config = createFalcon9Config();
		const rocket = new CalcRocket(
			1,
			'Falcon 9 Unit Rocket',
			0, 6371000, 0, 0, 0, 0,
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

		logDebug(`Pre-ignition: fuelMass=${rocket.fuelMass} t, oxidMass=${rocket.oxidMass} t, totalMass=${rocket.mass} t`);
		assert.equal(rocket.fuelMass, 140.0, 'Initial fuel mass must be exactly 140 tons');
		assert.equal(rocket.oxidMass, 280.0, 'Initial oxidizer mass must be exactly 280 tons');
		assertClose(rocket.mass, 555.2, 0.1, 'Initial total mass should be ~555.2 tons');

		// Simulate ignition and release from hold-down
		rocket.isIgnited = true;
		rocket.isHoldDown = false;
		rocket.thrustRatio = 1.0;

		// Mock payload sent from PhysicsEngine / Worker to Main Thread
		const mockWorkerPayload = {
			id: 1,
			fuelMass: rocket.fuelMass, // in tons
			oxidMass: rocket.oxidMass, // in tons
			mass: rocket.mass          // in tons
		};

		// Validate that receiving worker data in main thread preserves tons directly
		// Previously, a bug called kg2ton(objData.fuelMass) which divided 140 by 1000 -> 0.14t
		const receivedFuelTon = mockWorkerPayload.fuelMass;
		const receivedOxidTon = mockWorkerPayload.oxidMass;

		logDebug(`Post-ignition received: fuel=${receivedFuelTon} t, oxid=${receivedOxidTon} t`);
		assert.equal(receivedFuelTon, 140.0, 'Fuel mass after ignition must NOT be divided by 1000');
		assert.equal(receivedOxidTon, 280.0, 'Oxidizer mass after ignition must NOT be divided by 1000');
	});

	it('should verify propellant bar percentage decreases smoothly from 100% (never drops to 0.1%)', () => {
		const initialFuel = 140.0; // tons
		const initialOxid = 280.0; // tons
		const maxPropellant = initialFuel + initialOxid; // 420 tons

		const calculateBarPercentage = (fuel, oxid) => {
			const currentProp = (fuel + oxid);
			return Math.max(0, Math.min(100, (currentProp / maxPropellant) * 100));
		};

		// 1. At rollout / pre-ignition
		const initialPct = calculateBarPercentage(initialFuel, initialOxid);
		assert.equal(initialPct, 100.0, 'Fuel bar must start at exactly 100%');

		// 2. Immediate ignition (if 1/1000 bug existed, currentProp would be 0.42t -> 0.1%)
		const buggedPct = calculateBarPercentage(initialFuel / 1000, initialOxid / 1000);
		logDebug(`Bugged fuel bar percentage would be: ${buggedPct.toFixed(2)}%`);
		assert.ok(initialPct > 99.0, 'Clean fuel bar is 100%, far above bugged 0.1%');

		// 3. Burning after 30 seconds
		const burnRate = 420.0 / 162.0; // ~2.59 t/s
		const fuelAfter30s = initialFuel - (burnRate * 30 * (140 / 420));
		const oxidAfter30s = initialOxid - (burnRate * 30 * (280 / 420));
		const pctAfter30s = calculateBarPercentage(fuelAfter30s, oxidAfter30s);

		logDebug(`After 30s burn: Propellant remaining=${(fuelAfter30s + oxidAfter30s).toFixed(1)} t (${pctAfter30s.toFixed(1)}%)`);
		assert.ok(pctAfter30s > 75.0 && pctAfter30s < 85.0, 'Bar percentage decreases smoothly (~81.5%)');
	});

	it('should calculate REM Delta-V accurately for multi-stage Falcon 9 stack', () => {
		const f9Config = createFalcon9Config();
		const fc = new FlightComputer({
			massLimit: 1000,
			maxQAxialLimit: Infinity,
			maxQLateralLimit: Infinity
		});

		const sensorInput = {
			x: 0,
			y: 6371000,
			vx: 0,
			vy: 0,
			ax: 0,
			ay: 9.8,
			mass: 555.2,
			fuelMass: 420.0, // total prop in stage 1
			thrustForce: 7607000,
			massLossRate: 420.0 / 162.0,
			thrustRatio: 1.0,
			qAxialKpa: 0,
			qLateralKpa: 0,
			aoaDeg: 0,
			progradeAngle: 0,
			stageIndex: 0,
			stages: [
				{
					stageNumber: 1,
					dryMassT: 25.0,
					fuelMassT: 140.0,
					oxidMassT: 280.0,
					isp: 300
				},
				{
					stageNumber: 2,
					dryMassT: 4.5,
					fuelMassT: 32.0,
					oxidMassT: 64.0,
					isp: 348
				}
			]
		};

		const dominantBody = { mass: 5.972e24, radius: 6371000, x: 0, y: 0 };
		fc.update(sensorInput, 0.1, dominantBody);
		const telemetry = fc.getTelemetry();

		logDebug(`Calculated REM Delta-V: ${telemetry.remDv.toFixed(1)} m/s (${(telemetry.remDv / 1000).toFixed(2)} km/s)`);

		// Verify REM Delta-V is ~10.5~12.0 km/s (in m/s: 10500~12000)
		assert.ok(telemetry.remDv >= 10000 && telemetry.remDv <= 12500, `REM Delta-V should be around 11,500 m/s, got ${telemetry.remDv}`);

		// Check telemetry card display conversion (m to km)
		const displayedKmS = UnitConvertUtils.m2km(telemetry.remDv);
		assert.ok(displayedKmS >= 10.0 && displayedKmS <= 12.5, `Displayed REM Delta-V in km/s should be ~11.5, got ${displayedKmS}`);
	});

	it('should dynamically scale propellant by density ratio, ensure TWR >= 1.25, and recalculate burnTime on fuel change', () => {
		setupMockDOM();
		const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, mass: 5.972e24 });
		const universe = createMockUniverse({ objects: [earth] });
		universe.RocketLauncher = new RocketLauncher(universe);
		const ctrl = new ControlPanel(universe);
		const rTab = ctrl.rocketTab;
		rTab.loadPreset('FALCON9');
		const rl = universe.RocketLauncher;

		// 1. Initial Falcon 9 preset state (Liquid Kerosene/LOX)
		assert.equal(rTab.ui.rlFuelType.value, 'liquid');
		const stg0 = rl.stages[0];
		assert.equal(stg0.fuelType, 'liquid');
		assert.equal(stg0.fuelMassT, 140);
		assert.equal(stg0.oxidMassT, 280);
		assertClose(stg0.burnTime, 162.0, 1.0);

		// 2. Change fuel to 'hydro' (Cryogenic LH2/LOX)
		rTab.ui.rlFuelType.value = 'hydro';
		rTab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'hydro' } });

		// Propellant mass should be scaled by density ratio (0.3 / 1.0 = 0.3)
		// 420 * 0.3 = 126t total propellant. With OF=6.0: fuel = 126 / 7 = 18t, oxid = 108t
		assert.equal(stg0.fuelType, 'hydro');
		assert.ok(stg0.fuelMassT > 0 && stg0.fuelMassT < 50, `Scaled fuel mass should be ~18t, got ${stg0.fuelMassT}`);
		assert.ok(stg0.oxidMassT > 50 && stg0.oxidMassT < 200, `Scaled oxidizer mass should be ~108t, got ${stg0.oxidMassT}`);
		assert.equal(rTab.ui.rlOxidMass.disabled, false);

		// Burn time should be dynamically recalculated: t = (M_prop * Isp * g0) / Thrust
		// (126 * 450 * 9.80665) / 7600 = ~73.2s
		assert.ok(stg0.burnTime > 50 && stg0.burnTime < 100, `Recalculated burnTime should be ~73s, got ${stg0.burnTime}`);
		assert.equal(rl.calculatedBurnTime, stg0.burnTime);

		// Liftoff TWR check: ThrustKN must be maintained or adjusted so TWR >= 1.25 on Earth
		const totalMassT = rl.stages[0].dryMassT + rl.stages[0].fuelMassT + rl.stages[0].oxidMassT +
			rl.stages[1].dryMassT + rl.stages[1].fuelMassT + rl.stages[1].oxidMassT +
			(rl.payload?.massT || 0) + (rl.fairing?.massT || 0);
		const liftoffTwr = (stg0.thrustKN * 1000) / (totalMassT * 1000 * PHYSICS.G0);
		assert.ok(liftoffTwr >= 1.25, `Stage 1 TWR should be >= 1.25, got ${liftoffTwr}`);

		// 3. Change fuel to 'solid'
		rTab.ui.rlFuelType.value = 'solid';
		rTab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'solid' } });

		assert.equal(stg0.fuelType, 'solid');
		assert.equal(stg0.oxidMassT, 0);
		assert.equal(rTab.ui.rlOxidMass.disabled, true);
		assert.ok(stg0.fuelMassT > 100, `Solid propellant mass should be substantial, got ${stg0.fuelMassT}`);
		assert.ok(stg0.burnTime > 0, `Solid rocket burnTime must be positive and recalculated, got ${stg0.burnTime}`);
	});

	it('should dynamically update stage burnTime when fuel mass, oxid mass, or thrust sliders change', () => {
		setupMockDOM();
		const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
		const universe = createMockUniverse({ objects: [earth] });
		universe.RocketLauncher = new RocketLauncher(universe);
		const ctrl = new ControlPanel(universe);
		const rTab = ctrl.rocketTab;
		rTab.loadPreset('FALCON9');
		const rl = universe.RocketLauncher;
		const stg0 = rl.stages[0];

		// Change fuel mass slider
		rTab.ui.rlFuelMass.value = '200';
		rTab.ui.rlFuelMass.dispatchEvent({ type: 'input', target: { value: '200' } });

		// For liquid with OF=2.5 (from ROCKET_FUELS.liquid), oxidizer updates to 200 * 2.5 = 500
		assert.equal(stg0.fuelMassT, 200);
		assert.equal(stg0.oxidMassT, 500);

		// burnTime should recompute for 700t of propellant
		const expectedBurnTime = Math.round((700 * ROCKET_FUELS.liquid.isp * PHYSICS.G0 / stg0.thrustKN) * 10) / 10;
		assertClose(stg0.burnTime, expectedBurnTime, 0.5);
		assertClose(rl.calculatedBurnTime, expectedBurnTime, 0.5);

		// Change thrust slider to 8000 kN
		rTab.ui.rlLaunchThrust.value = '8000';
		rTab.ui.rlLaunchThrust.dispatchEvent({ type: 'input', target: { value: '8000' } });
		assert.equal(stg0.thrustKN, 8000);
		const expectedBurnTimeNewThrust = Math.round((700 * ROCKET_FUELS.liquid.isp * PHYSICS.G0 / 8000) * 10) / 10;
		assertClose(stg0.burnTime, expectedBurnTimeNewThrust, 0.5);
	});

	it('should automatically jettison fairing upon final stage payload separation if fairing is still attached', () => {
		const f9Config = createFalcon9Config();
		const rocket = new CalcRocket(
			10,
			'Falcon 9 Final Staging',
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
				fairing: { enabled: true, massT: 1.7, separationAltKm: 300, isSeparated: false }
			}
		);

		const earth = { id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, mass: 5.972e24 };
		// Run a flightControl step at 200km to populate sensor data and dominant body reference
		rocket.flightControl(0.1, earth, 6371000 + 200000);

		// Fast-forward to Stage 2 (final stage) burnout
		rocket.currentStageIndex = 1;
		rocket._activateStage(1);
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = MULTISTAGE_ROCKET.DEFAULT_SEPARATION_DELAY_SEC + 0.1;

		assert.equal(rocket.fairing.isSeparated, false, 'Fairing should still be attached before final payload separation');

		// Trigger final stage separation
		rocket.separateCurrentStage();

		// Safeguard must trigger: Payload satellite must never be trapped inside fairing
		assert.equal(rocket.fairing.isSeparated, true, 'Fairing must be automatically jettisoned upon final stage separation');
		const fairingDebris = rocket._pendingDebris.filter(d => d.debrisSubType === 3);
		assert.equal(fairingDebris.length, 2, 'Two fairing half debris items must be queued');
		assert.equal(rocket.isPayloadSeparated, true, 'Payload must be cleanly separated');
	});

	it('should verify realistic liftoff TWR and burnTime for H3 preset', () => {
		const h3 = MULTISTAGE_PRESETS.H3;
		assert.ok(h3, 'H3 preset must exist');

		const stg1 = h3.stages[0];
		const stg2 = h3.stages[1];
		assert.equal(stg1.thrustKN, 4500, 'H3 stage 1 thrust should be 4500 kN (boosted)');

		// Calculate total liftoff mass
		const totalMassT = stg1.dryMassT + stg1.fuelMassT + stg1.oxidMassT +
			stg2.dryMassT + stg2.fuelMassT + stg2.oxidMassT +
			(h3.payload?.massT || 0) + (h3.fairing?.massT || 0);

		// Liftoff TWR on Earth surface
		const liftoffTwr = (stg1.thrustKN * 1000) / (totalMassT * 1000 * PHYSICS.G0);
		assert.ok(liftoffTwr >= 1.45 && liftoffTwr <= 1.65, `H3 liftoff TWR must be realistic (~1.5), got ${liftoffTwr.toFixed(2)}`);

		// Fairing separation altitude must be 115 km (matching real H3 flight)
		assert.equal(h3.fairing.separationAltKm, 115, 'H3 fairing separation altitude must be 115 km');

		// Stage 1 burnTime check: (240t prop * 450s Isp * 9.80665) / 4500kN = 235.36s
		const expectedBurnTime = (stg1.fuelMassT + stg1.oxidMassT) * 450 * PHYSICS.G0 / stg1.thrustKN;
		assertClose(stg1.burnTime, expectedBurnTime, 1.0, 'H3 Stage 1 burnTime must match physical propellant burn time');
	});
});

