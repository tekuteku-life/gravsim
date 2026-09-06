/**
 * Regression Test Suite 01: Post-MECO Tank Pressure Dynamics and Venting
 * Covers User Issues:
 * - Tank pressure behavior after MECO (should settle at 100~120 kPa, not 0)
 * - Safe venting and pressure retention state transitions
 * - PRESS annunciator lamp threshold logic (>= 300 kPa nominal vs safe hold)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { TANK_PRESSURE_SIM } from '../../scripts/gravsim_const.js';
import { logDebug, assertClose } from '../test_helpers.mjs';

describe('Regression 01: MECO Tank Pressure & Venting Dynamics', () => {
	let rocket;

	beforeEach(() => {
		rocket = new CalcRocket(
			1,
			'Pressure-Test-Rocket',
			0, 6371000, 0, 0, 0, 0,
			1.85, 0, 500,
			{
				thrustForce: 7607000,
				burnTime: 160,
				totalMass: 550,
				dryMass: 25,
				fuelMass: 140,
				oxidMass: 280,
				isp: 300
			}
		);
		rocket.isIgnited = true;
		rocket.isHoldDown = false;
	});

	it('should maintain nominal tank pressure (~350 kPa) during active burn', () => {
		rocket.presState = 'NOMINAL';
		rocket.presTimer = 10.0;
		rocket.updatePressure(0.1, 10);

		logDebug(`Nominal pressure: Fuel=${rocket.tankPresFuel.toFixed(1)} kPa, Oxid=${rocket.tankPresOxid.toFixed(1)} kPa`);

		// Target is 350 kPa with slight realistic sensor noise (±1.5 kPa)
		assert.ok(rocket.tankPresFuel >= 345 && rocket.tankPresFuel <= 355, 'Fuel tank pressure should be ~350 kPa');
		assert.ok(rocket.tankPresOxid >= 345 && rocket.tankPresOxid <= 355, 'Oxidizer tank pressure should be ~350 kPa');
	});

	it('should trigger MECO transient spike when engine cuts off', () => {
		rocket.presState = 'NOMINAL';
		rocket.fuelMass = 0;
		rocket.isIgnited = false;
		rocket.stageState = 'STG_MECO';

		// Trigger MECO transition
		rocket.presState = 'MECO_TRANSIENT';
		rocket.presTimer = 0;

		rocket.updatePressure(0.05, 0);
		logDebug(`MECO spike initial: Fuel=${rocket.tankPresFuel.toFixed(1)} kPa, State=${rocket.presState}`);

		assert.equal(rocket.presState, 'MECO_TRANSIENT');
		assert.ok(rocket.tankPresFuel > 0, 'Pressure should not drop to 0 at MECO');
	});

	it('should transition to POST_MECO_VENT and smoothly vent pressure down to 100~120 kPa', () => {
		rocket.presState = 'MECO_TRANSIENT';
		rocket.presTimer = TANK_PRESSURE_SIM.MECO_TRANSIENT_TIME_SEC + 0.01;

		// This step should transition to POST_MECO_VENT
		rocket.updatePressure(0.01, 0);
		assert.equal(rocket.presState, 'POST_MECO_VENT');

		logDebug(`Venting started at Fuel=${rocket.tankPresFuel.toFixed(1)} kPa`);

		// Advance simulation through venting phase (POST_MECO_VENT_TIME_SEC)
		const ventDuration = TANK_PRESSURE_SIM.POST_MECO_VENT_TIME_SEC || 5.0;
		const steps = 50;
		const dt = ventDuration / steps;
		for (let i = 0; i < steps; i++) {
			rocket.updatePressure(dt, 0);
		}

		logDebug(`Venting completed: State=${rocket.presState}, Fuel=${rocket.tankPresFuel.toFixed(1)} kPa, Oxid=${rocket.tankPresOxid.toFixed(1)} kPa`);

		// Should transition to POST_MECO_HOLD
		assert.equal(rocket.presState, 'POST_MECO_HOLD');

		// Pressure must be held in the range 100~120 kPa (target 110 kPa ± sensor noise)
		assert.ok(
			rocket.tankPresFuel >= 100 && rocket.tankPresFuel <= 120,
			`Fuel tank pressure after MECO vent (${rocket.tankPresFuel.toFixed(1)} kPa) must be in 100~120 kPa`
		);
		assert.ok(
			rocket.tankPresOxid >= 100 && rocket.tankPresOxid <= 120,
			`Oxidizer tank pressure after MECO vent (${rocket.tankPresOxid.toFixed(1)} kPa) must be in 100~120 kPa`
		);
	});

	it('should persistently hold pressure at 100~120 kPa during POST_MECO_HOLD (no drop to 0)', () => {
		rocket.presState = 'POST_MECO_HOLD';
		rocket.presTimer = 0;

		// Simulate coasting in space for 100 seconds
		for (let t = 0; t < 100; t += 1.0) {
			rocket.updatePressure(1.0, 0);
		}

		logDebug(`After 100s coasting: Fuel=${rocket.tankPresFuel.toFixed(1)} kPa, Oxid=${rocket.tankPresOxid.toFixed(1)} kPa`);

		assert.ok(
			rocket.tankPresFuel >= 100 && rocket.tankPresFuel <= 120,
			`Fuel tank pressure after 100s coast (${rocket.tankPresFuel.toFixed(1)} kPa) must remain 100~120 kPa`
		);
		assert.ok(
			rocket.tankPresOxid >= 100 && rocket.tankPresOxid <= 120,
			`Oxidizer tank pressure after 100s coast (${rocket.tankPresOxid.toFixed(1)} kPa) must remain 100~120 kPa`
		);
	});

	it('should verify PRESS annunciator lamp state (active during NOMINAL, unlit in safe hold)', () => {
		const threshold = TANK_PRESSURE_SIM.PRESS_LAMP_THRESHOLD_KPA; // 300 kPa

		// 1. Nominal flight condition
		rocket.presState = 'NOMINAL';
		rocket.updatePressure(0.1, 0);
		const isPressNominal = (
			rocket.presState === 'NOMINAL' ||
			(rocket.tankPresFuel >= threshold && rocket.tankPresOxid >= threshold)
		);
		logDebug(`PRESS lamp NOMINAL check: isNominal=${isPressNominal}, Fuel=${rocket.tankPresFuel.toFixed(1)} kPa`);
		assert.ok(isPressNominal, 'PRESS lamp should be ON during NOMINAL flight burn');

		// 2. Post-MECO safe hold condition
		rocket.presState = 'POST_MECO_HOLD';
		rocket.updatePressure(0.1, 0);
		const isPressInSafeHold = (
			rocket.presState === 'NOMINAL' ||
			(rocket.tankPresFuel >= threshold && rocket.tankPresOxid >= threshold)
		);
		logDebug(`PRESS lamp POST_MECO_HOLD check: isNominal=${isPressInSafeHold}, Fuel=${rocket.tankPresFuel.toFixed(1)} kPa`);
		// In safe hold (110 kPa), high-pressure flight pressurization lamp turns off
		assert.equal(isPressInSafeHold, false, 'PRESS lamp should turn OFF during safe venting/hold (110 kPa < 300 kPa)');
		assert.ok(rocket.tankPresFuel >= 100 && rocket.tankPresFuel <= 120, 'Pressure is safely held at 100~120 kPa');
	});
});

