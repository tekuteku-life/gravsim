/**
 * Regression Test Suite 03: Solar System Planetary Gravity & Orbital Stability
 * Covers User Issues:
 * - Planetary escape / stars flying out when deploying solar system
 * - Planetary mass scaling (tons vs kg) between Main Thread and Physics Worker
 * - Numerical orbital integration stability (Keplerian orbits over 30 days)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { CalcCelestialBody } from '../../scripts/gravsim_calc_object.js';
import { PHYSICS, DEFAULT_OBJECT_PARAMS } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { logDebug, assertClose } from '../test_helpers.mjs';

describe('Regression 03: Solar System Gravity & Orbital Stability', () => {
	it('should verify correct mass unit scaling (ton <-> kg) between threads', () => {
		// Sun mass in tons (as stored in DEFAULT_OBJECT_PARAMS)
		const sunParam = DEFAULT_OBJECT_PARAMS.Sun;
		const sunMassTon = sunParam.MASS; // 1.9891e27 t

		// Main thread converts to kg when transmitting to PhysicsEngine worker
		const sunMassKgToWorker = UnitConvertUtils.ton2kg(sunMassTon);
		logDebug(`Sun mass: Main=${sunMassTon.toExponential(4)} t, WorkerPayload=${sunMassKgToWorker.toExponential(4)} kg`);

		assertClose(sunMassKgToWorker, 1.9891e30, 1e26, 'Sun mass sent to worker must be ~1.9891e30 kg');

		// Worker receives kg and stores in CalcCelestialBody
		const sunObj = new CalcCelestialBody(
			1, 'Sun', 0, 0, 0, 0, 0, 0, 6.9634e8, 0, sunMassKgToWorker
		);
		assert.equal(sunObj.mass, sunMassKgToWorker, 'CalcCelestialBody mass must be in kg');

		// Worker returns data to main thread; main thread converts kg back to tons
		const receivedTonInMain = UnitConvertUtils.kg2ton(sunObj.mass);
		assertClose(receivedTonInMain, sunMassTon, 1e23, 'Main thread must recover original mass in tons');
	});

	it('should accurately calculate theoretical gravitational acceleration for Earth at 1 AU', () => {
		const engine = new PhysicsEngine();
		const sunMassKg = 1.9891e30; // kg
		const earthMassKg = 5.972e24; // kg
		const auM = 1.495978707e11; // 1 AU in meters

		// Register Sun at origin
		engine.addObject({
			id: 1,
			name: 'Sun',
			type: 'celestial',
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: sunMassKg,
			radius: 6.9634e8
		});

		// Register Earth at (1 AU, 0)
		engine.addObject({
			id: 2,
			name: 'Earth',
			type: 'celestial',
			x: auM,
			y: 0,
			vx: 0,
			vy: 29780, // ~29.78 km/s
			mass: earthMassKg,
			radius: 6.371e6
		});

		// Calculate 1 step
		engine._moveObjects(0.1);

		const earth = engine.objects.find(o => o.id === 2);
		assert.ok(earth, 'Earth must exist in engine');

		// Theoretical acceleration: a = G * M_sun / r^2
		const theoreticalAx = -(PHYSICS.G * sunMassKg) / (auM * auM); // ~ -0.005932 m/s^2
		logDebug(`Gravitational ax: Calculated=${earth.ax.toExponential(6)} m/s^2, Theoretical=${theoreticalAx.toExponential(6)} m/s^2`);

		assertClose(earth.ax, theoreticalAx, 1e-6, 'Earth gravitational acceleration must match Keplerian theory');
		assertClose(earth.ay, 0.0, 1e-6, 'Earth tangential acceleration should be 0 at (1 AU, 0)');
	});

	it('should maintain stable circular orbit over 30 days without planetary ejection', () => {
		const engine = new PhysicsEngine();
		const sunMassKg = 1.9891e30;
		const earthMassKg = 5.972e24;
		const auM = 1.495978707e11;
		const vOrbit = Math.sqrt((PHYSICS.G * sunMassKg) / auM); // exact circular speed ~ 29784.7 m/s

		engine.addObject({
			id: 1,
			name: 'Sun',
			type: 'celestial',
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: sunMassKg,
			radius: 6.9634e8
		});

		engine.addObject({
			id: 2,
			name: 'Earth',
			type: 'celestial',
			x: auM,
			y: 0,
			vx: 0,
			vy: vOrbit,
			mass: earthMassKg,
			radius: 6.371e6
		});

		// Simulate 30 days of orbital motion
		// 30 days = 30 * 24 * 3600 = 2,592,000 seconds
		const dt = 60.0; // 1 minute steps
		const totalSteps = (30 * 24 * 3600) / dt; // 43,200 steps

		logDebug(`Simulating 30 days of orbit (${totalSteps} steps at dt=${dt}s)...`);
		for (let s = 0; s < totalSteps; s++) {
			engine._moveObjects(dt);
		}

		const sun = engine.objects.find(o => o.id === 1);
		const earth = engine.objects.find(o => o.id === 2);

		const dx = earth.x - sun.x;
		const dy = earth.y - sun.y;
		const finalDistanceM = Math.sqrt(dx * dx + dy * dy);
		const relativeDeviation = Math.abs(finalDistanceM - auM) / auM;

		logDebug(`After 30 days: Final Distance = ${(finalDistanceM / 1e9).toFixed(3)} million km (Deviation: ${(relativeDeviation * 100).toFixed(4)}%)`);

		// Earth must NOT fly away (deviation within 0.1% for 30 days with 60s leapfrog/verlet)
		assert.ok(
			relativeDeviation < 0.001,
			`Orbit deviated by ${(relativeDeviation * 100).toFixed(3)}% (expected < 0.1%) - planetary ejection prevented!`
		);
	});
});

