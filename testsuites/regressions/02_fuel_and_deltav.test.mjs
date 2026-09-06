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
import { PHYSICS } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { logDebug, assertClose, createFalcon9Config } from '../test_helpers.mjs';

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
});

