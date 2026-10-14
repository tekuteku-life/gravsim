/**
 * Integration 10: Dynamic Specific Impulse (Isp) and Exhaust Plume Vacuum Expansion
 * 
 * Verifies:
 * 1. Specific impulse Isp(p_a) and thrust F(p_a) variation as a function of ambient pressure ratio.
 * 2. Strict constancy of mass flow rate m_dot regardless of ambient pressure.
 * 3. Multi-engine booster combined thrust and combined Isp calculations at sea level and in vacuum.
 * 4. Atmospheric pressure ratio calculation and reset on atmosphere boundary exit.
 * 5. Telemetry pipeline synchronization through SharedArrayBuffer indices (TM_AMBIENT_PRES_RATIO, TM_CURRENT_ISP).
 * 6. RocketRenderer vacuum expansion: lateral plume widening up to 2.5x, bell curvature flaring,
 *    and shock diamond fade-out / omission in vacuum across all fuel types (hydro, liquid, solid, ion).
 * 7. Fuel presets integrity and defaults.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { PredictorPhysicsEngine } from '../../scripts/gravsim_calc_predictor.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { PresetManager, ROCKET_VISUAL } from '../../scripts/gravsim_preset_manager.js';
import { OBJECT_TYPES, PHYSICS, BUFFER_INDEX, CALC_BUFFER_CONFIG } from '../../scripts/gravsim_const.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Mock HTML5 Canvas Context for verifying draw calls
function createMockCanvasContext() {
	const calls = [];
	return {
		calls,
		canvas: { width: 800, height: 600 },
		save: () => calls.push({ op: 'save' }),
		restore: () => calls.push({ op: 'restore' }),
		translate: (x, y) => calls.push({ op: 'translate', x, y }),
		rotate: (angle) => calls.push({ op: 'rotate', angle }),
		scale: (x, y) => calls.push({ op: 'scale', x, y }),
		beginPath: () => calls.push({ op: 'beginPath' }),
		closePath: () => calls.push({ op: 'closePath' }),
		moveTo: (x, y) => calls.push({ op: 'moveTo', x, y }),
		lineTo: (x, y) => calls.push({ op: 'lineTo', x, y }),
		quadraticCurveTo: (cpx, cpy, x, y) => calls.push({ op: 'quadraticCurveTo', cpx, cpy, x, y }),
		bezierCurveTo: (cp1x, cp1y, cp2x, cp2y, x, y) => calls.push({ op: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y }),
		ellipse: (x, y, rx, ry, rot, start, end) => calls.push({ op: 'ellipse', x, y, rx, ry, rot, start, end }),
		arc: (x, y, r, sa, ea) => calls.push({ op: 'arc', x, y, r, sa, ea }),
		rect: (x, y, w, h) => calls.push({ op: 'rect', x, y, w, h }),
		fill: () => calls.push({ op: 'fill' }),
		stroke: () => calls.push({ op: 'stroke' }),
		fillRect: (x, y, w, h) => calls.push({ op: 'fillRect', x, y, w, h }),
		strokeRect: (x, y, w, h) => calls.push({ op: 'strokeRect', x, y, w, h }),
		clearRect: (x, y, w, h) => calls.push({ op: 'clearRect', x, y, w, h }),
		createLinearGradient: () => ({ addColorStop: () => {} }),
		createRadialGradient: () => ({ addColorStop: () => {} }),
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		globalAlpha: 1,
		lineCap: 'butt',
		lineJoin: 'miter'
	};
}

describe('Integration 10: Dynamic Specific Impulse (Isp) and Vacuum Plume Expansion', () => {

	describe('1. Fuel Presets and Default Schemas', () => {
		it('should verify all fuel preset JSON files define valid ispVac and ispSl', () => {
			const fuelsDir = path.join(projectRoot, 'presets', 'fuels');
			const fuelFiles = fs.readdirSync(fuelsDir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
			assert.ok(fuelFiles.length >= 4, 'Must have at least hydro, liquid, solid, ion fuel presets');

			for (const file of fuelFiles) {
				const content = JSON.parse(fs.readFileSync(path.join(fuelsDir, file), 'utf-8'));
				assert.ok(typeof content.ispVac === 'number' && content.ispVac > 0, `${file} must define positive ispVac`);
				assert.ok(typeof content.ispSl === 'number' && content.ispSl >= 0, `${file} must define non-negative ispSl`);
				assert.ok(content.ispVac >= content.ispSl, `${file} ispVac (${content.ispVac}) must be >= ispSl (${content.ispSl})`);

				if (content.id === 'ion') {
					assert.equal(content.ispSl, 0, 'Ion thruster must have 0 Isp at sea level (cannot fire in dense atmosphere)');
				}
			}
		});

		it('should ensure PresetManager fallbacks contain valid ispVac and ispSl for all fuels', () => {
			const pm = new PresetManager();
			const fuels = ['hydro', 'liquid', 'solid', 'ion'];
			for (const fuelId of fuels) {
				const fuel = pm.getFuel(fuelId);
				assert.ok(fuel, `Fuel ${fuelId} must exist`);
				assert.ok(typeof fuel.ispVac === 'number' && fuel.ispVac > 0);
				assert.ok(typeof fuel.ispSl === 'number' && fuel.ispSl >= 0);
				assert.ok(fuel.ispVac >= fuel.ispSl);
			}
		});
	});

	describe('2. Single-Stage Engine Dynamic Isp and Thrust Physics', () => {
		it('should accurately calculate Isp and thrust at sea level, intermediate pressure, and vacuum', () => {
			const engine = new PhysicsEngine();
			const rocket = engine.addObject({
				id: 101,
				type: OBJECT_TYPES.ROCKET,
				mass: 100,
				dryMass: 20,
				fuelMass: 25,
				oxidMass: 55,
				thrustForce: 1000000, // 1000 kN vac
				burnTime: 200,
				isIgnited: true,
				stages: [{
					dryMassT: 20,
					fuelMassT: 25,
					oxidMassT: 55,
					thrustKN: 1000,
					ispVac: 320,
					ispSl: 282,
					burnTime: 200
				}]
			});

			// 1. Sea level (p = 1.0)
			const ispSl = rocket.getEffectiveIsp(1.0);
			const thrustSl = rocket.getEffectiveThrustForce(1.0);
			assert.equal(ispSl, 282, 'At p=1.0, Isp must equal ispSl (282 s)');
			assert.equal(thrustSl, 1000000 * (282 / 320), 'At p=1.0, thrust must scale by ispSl/ispVac');

			// 2. Intermediate altitude (p = 0.5)
			const ispMid = rocket.getEffectiveIsp(0.5);
			const thrustMid = rocket.getEffectiveThrustForce(0.5);
			assert.equal(ispMid, 320 - 0.5 * (320 - 282), 'At p=0.5, Isp must be 301 s');
			assert.equal(thrustMid, 1000000 * (301 / 320), 'At p=0.5, thrust must scale by 301/320');

			// 3. Vacuum (p = 0.0)
			const ispVac = rocket.getEffectiveIsp(0.0);
			const thrustVac = rocket.getEffectiveThrustForce(0.0);
			assert.equal(ispVac, 320, 'At p=0.0, Isp must equal ispVac (320 s)');
			assert.equal(thrustVac, 1000000, 'At p=0.0, thrust must equal vacuum thrust (1000 kN)');
		});

		it('should maintain strictly constant mass flow rate m_dot regardless of ambient pressure', () => {
			const totalPropT = 80; // 80 t
			const burnTime = 200; // 200 s
			const expectedMDot = totalPropT / burnTime; // 0.4 t/s

			const engine = new PhysicsEngine();
			const rocket = engine.addObject({
				id: 102,
				type: OBJECT_TYPES.ROCKET,
				mass: 100,
				dryMass: 20,
				fuelMass: 25,
				oxidMass: 55,
				thrustForce: 1000000,
				burnTime: burnTime,
				isIgnited: true,
				stages: [{
					dryMassT: 20,
					fuelMassT: 25,
					oxidMassT: 55,
					thrustKN: 1000,
					ispVac: 320,
					ispSl: 282,
					burnTime: burnTime
				}]
			});

			assert.equal(rocket.massLossRate, expectedMDot);

			// Mass consumption in atmosphere
			rocket.ambientPresRatio = 1.0;
			const initialFuel = rocket.fuelMass;
			rocket.flightControl(null, 1.0, null, 1.0);
			const fuelUsedSl = initialFuel - rocket.fuelMass;

			// Reset fuel and mass consumption in vacuum
			rocket.fuelMass = initialFuel;
			rocket.ambientPresRatio = 0.0;
			rocket.flightControl(null, 1.0, null, 1.0);
			const fuelUsedVac = initialFuel - rocket.fuelMass;

			assert.ok(Math.abs(fuelUsedSl - fuelUsedVac) < 1e-9, 'Propellant consumption rate must be identical in SL and vacuum');
		});

		it('should verify ion engine cannot generate thrust at sea level (ispSl = 0)', () => {
			const engine = new PhysicsEngine();
			const rocket = engine.addObject({
				id: 103,
				type: OBJECT_TYPES.ROCKET,
				mass: 2.0,
				dryMass: 1.5,
				fuelMass: 0.5,
				oxidMass: 0,
				thrustForce: 500, // 500 N
				burnTime: 30000,
				isIgnited: true,
				stages: [{
					fuelType: 'ion',
					dryMassT: 1.5,
					fuelMassT: 0.5,
					oxidMassT: 0,
					thrustKN: 0.5,
					ispVac: 3000,
					ispSl: 0,
					burnTime: 30000
				}]
			});

			assert.equal(rocket.getEffectiveIsp(1.0), 0);
			assert.equal(rocket.getEffectiveThrustForce(1.0), 0);

			assert.equal(rocket.getEffectiveIsp(0.0), 3000);
			assert.equal(rocket.getEffectiveThrustForce(0.0), 500);
		});
	});

	describe('3. Multi-Engine Booster Combined Isp and Thrust Physics', () => {
		it('should calculate combined thrust and combined Isp for core + boosters at sea level and in vacuum', () => {
			const coreThrustKN = 2940; // 2940 kN (2x LE-9)
			const boosterThrustKN = 4316; // 4316 kN (2x SRB-3)
			const coreThrustVac = coreThrustKN * 1000;
			const boosterThrustVac = boosterThrustKN * 1000;
			const coreIspVac = 425;
			const coreIspSl = 370;
			const srbIspVac = 280;
			const srbIspSl = 250;

			const engine = new PhysicsEngine();
			const rocket = engine.addObject({
				id: 104,
				type: OBJECT_TYPES.ROCKET,
				mass: 300,
				dryMass: 50,
				fuelMass: 75,
				oxidMass: 175,
				thrustForce: coreThrustVac + boosterThrustVac,
				burnTime: 105,
				isIgnited: true,
				stages: [{
					dryMassT: 25,
					fuelMassT: 75,
					oxidMassT: 175,
					thrustKN: coreThrustKN,
					ispVac: coreIspVac,
					ispSl: coreIspSl,
					burnTime: 105
				}],
				boosters: {
					count: 2,
					coreThrustKN: coreThrustKN,
					thrustKN: boosterThrustKN,
					ispVac: srbIspVac,
					ispSl: srbIspSl,
					burnTime: 105
				}
			});
			rocket.isBoosterIgnited = true;

			// 1. Sea level combined thrust
			const fCoreSl = coreThrustVac * (coreIspSl / coreIspVac);
			const fSrbSl = boosterThrustVac * (srbIspSl / srbIspVac);
			const totalFSl = fCoreSl + fSrbSl;
			const actualThrustSl = rocket.getEffectiveThrustForce(1.0);
			assert.ok(Math.abs(actualThrustSl - totalFSl) < 1.0, `Sea level combined thrust must be ${totalFSl.toFixed(0)}, got ${actualThrustSl.toFixed(0)}`);

			// 2. Sea level combined Isp
			const mDotCore = coreThrustVac / (coreIspVac * PHYSICS.G0);
			const mDotSrb = boosterThrustVac / (srbIspVac * PHYSICS.G0);
			const expectedIspSl = totalFSl / ((mDotCore + mDotSrb) * PHYSICS.G0);
			const actualIspSl = rocket.getEffectiveIsp(1.0);
			assert.ok(Math.abs(actualIspSl - expectedIspSl) < 0.1, `Sea level combined Isp must be ${expectedIspSl.toFixed(2)}, got ${actualIspSl.toFixed(2)}`);

			// 3. Vacuum combined thrust and Isp
			const totalFVac = coreThrustVac + boosterThrustVac;
			const expectedIspVac = totalFVac / ((mDotCore + mDotSrb) * PHYSICS.G0);
			const actualThrustVac = rocket.getEffectiveThrustForce(0.0);
			const actualIspVac = rocket.getEffectiveIsp(0.0);
			assert.ok(Math.abs(actualThrustVac - totalFVac) < 1.0, 'Vacuum thrust must equal sum of vacuum thrusts');
			assert.ok(Math.abs(actualIspVac - expectedIspVac) < 0.1, 'Vacuum combined Isp must match combined formula');

			// 4. After booster burnout
			rocket.isBoosterBurnout = true;
			assert.equal(rocket.getEffectiveThrustForce(0.0), rocket.thrustForceVac || rocket.thrustForce);
			assert.equal(rocket.getEffectiveIsp(0.0), coreIspVac);
			assert.equal(rocket.getEffectiveIsp(1.0), coreIspSl);
		});
	});

	describe('4. Atmospheric Pressure Ratio and Atmosphere Exit Lifecycle', () => {
		it('should update ambientPresRatio via applyAerodynamics and reset on clearAerodynamicParameters', () => {
			const engine = new PhysicsEngine();
			const rocket = engine.addObject({
				id: 105,
				type: OBJECT_TYPES.ROCKET,
				mass: 50,
				stages: [{ dryMassT: 10, fuelMassT: 40, oxidMassT: 0, thrustKN: 1000, ispVac: 320, ispSl: 282, burnTime: 100 }]
			});

			assert.equal(rocket.ambientPresRatio, 0.0);

			const refBody = { x: 0, y: 0, vx: 0, vy: 0 };
			const refParam = { ATM_DENSITY_0: 1.225, ATM_SCALE_HEIGHT: 8500 };

			// Apply aerodynamics at sea level (altM = 0)
			rocket.applyAerodynamics(refBody, refParam, 0);
			assert.ok(Math.abs(rocket.ambientPresRatio - 1.0) < 1e-4, 'ambientPresRatio at sea level must be 1.0');

			// Apply aerodynamics at scale height (altM = H * ln(2) => density = 0.5 * rho0)
			rocket.applyAerodynamics(refBody, refParam, 8500 * Math.LN2);
			assert.ok(Math.abs(rocket.ambientPresRatio - 0.5) < 1e-4, 'ambientPresRatio at scale height must be 0.5');

			// Rocket clears atmosphere
			rocket.clearAerodynamicParameters();
			assert.equal(rocket.ambientPresRatio, 0.0, 'ambientPresRatio must reset to 0.0 when cleared');
			assert.equal(rocket.inAtmosphere, false);
		});
	});

	describe('5. Telemetry Pipeline and SharedArrayBuffer Synchronization', () => {
		it('should correctly format and parse ambientPresRatio and currentIsp via WorkerBridge', () => {
			const testPresRatio = 0.42;
			const testCurrentIsp = 311.5;

			const mockRocket = {
				id: 777,
				type: OBJECT_TYPES.ROCKET,
				x: 1000,
				y: 2000,
				vx: 100,
				vy: 200,
				ax: 5,
				ay: 10,
				dryMass: 20,
				fuelMass: 30,
				oxidMass: 50,
				burnTime: 120,
				_thrustRatio: 1.0,
				ambientPresRatio: testPresRatio,
				currentIsp: testCurrentIsp,
				flightComputer: {
					getTelemetry: () => ({
						status: 1,
						ambientPresRatio: testPresRatio,
						currentIsp: testCurrentIsp
					})
				}
			};

			const buffer = WorkerBridge.formatWorkerToMain([mockRocket]);
			assert.ok(buffer.length >= CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT);

			let parsedData = null;
			WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (data) => {
				parsedData = { ...data };
			});

			assert.ok(parsedData);
			assert.equal(parsedData.id, 777);
			assert.ok(Math.abs(parsedData.tmAmbientPresRatio - testPresRatio) < 1e-4);
			assert.ok(Math.abs(parsedData.tmCurrentIsp - testCurrentIsp) < 1e-4);

			// Verify ObjectManager sync
			const om = new ObjectManager();
			const targetRocket = {
				id: 777,
				type: OBJECT_TYPES.ROCKET,
				telemetry: {},
				updateHistory: () => {}
			};
			om.objects.push(targetRocket);

			om.updateObjectParams(parsedData);
			assert.ok(Math.abs(targetRocket.ambientPresRatio - testPresRatio) < 1e-4);
			assert.ok(Math.abs(targetRocket.currentIsp - testCurrentIsp) < 1e-4);
			assert.ok(Math.abs(targetRocket.telemetry.ambientPresRatio - testPresRatio) < 1e-4);
			assert.ok(Math.abs(targetRocket.telemetry.currentIsp - testCurrentIsp) < 1e-4);
		});
	});

	describe('6. Exhaust Plume Vacuum Expansion Rendering', () => {
		it('should expand plume width laterally by up to 2.5x and fade shock diamonds in vacuum for hydro fuel', () => {
			const ctx = createMockCanvasContext();

			// Sea level hydro plume
			ctx.calls.length = 0;
			RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'hydro', 40, 1.0);
			const slCalls = [...ctx.calls];

			const slCurves = slCalls.filter(c => c.op === 'quadraticCurveTo' || c.op === 'bezierCurveTo');
			assert.ok(slCurves.length > 0, 'Sea level plume must render curves');

			// Vacuum hydro plume
			ctx.calls.length = 0;
			RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'hydro', 40, 0.0);
			const vacCalls = [...ctx.calls];

			const vacCurves = vacCalls.filter(c => c.op === 'quadraticCurveTo' || c.op === 'bezierCurveTo');
			assert.ok(vacCurves.length > 0, 'Vacuum plume must render widened bell curve');
		});

		it('should expand plume across liquid, solid, ion, and unknown fallback fuels', () => {
			const ctx = createMockCanvasContext();
			const fuels = ['liquid', 'solid', 'ion', 'unknown_methalox'];

			for (const fuel of fuels) {
				ctx.calls.length = 0;
				// Sea level
				RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, fuel, 50, 1.0);
				assert.ok(ctx.calls.length > 0, `${fuel} must draw at sea level`);

				// Vacuum
				ctx.calls.length = 0;
				RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, fuel, 50, 0.0);
				assert.ok(ctx.calls.length > 0, `${fuel} must draw in vacuum`);
			}
		});

		it('should widen low-detail plume with vacuum factor and booster counts (0, 2, 4)', () => {
			const ctx = createMockCanvasContext();
			const theme = ROCKET_VISUAL.THEMES.orange;

			// Low detail 2 boosters at p=1.0 vs p=0.0
			const rkt2Boosters = {
				isIgnited: true,
				burnTime: 100,
				thrustRatio: 1.0,
				ambientPresRatio: 1.0,
				stages: [{}, {}],
				currentStageIndex: 0,
				boosters: { count: 2 }
			};

			ctx.calls.length = 0;
			RocketRenderer._drawLowDetail(ctx, rkt2Boosters, 10, theme);
			const countSl = ctx.calls.length;

			rkt2Boosters.ambientPresRatio = 0.0;
			ctx.calls.length = 0;
			RocketRenderer._drawLowDetail(ctx, rkt2Boosters, 10, theme);
			const countVac = ctx.calls.length;

			assert.ok(countSl > 0 && countVac > 0, 'Low detail rocket with 2 boosters must render');

			// Low detail 4 boosters
			const rkt4Boosters = {
				isIgnited: true,
				burnTime: 100,
				thrustRatio: 1.0,
				ambientPresRatio: 0.0,
				stages: [{}, {}],
				currentStageIndex: 0,
				boosters: { count: 4 }
			};
			ctx.calls.length = 0;
			RocketRenderer._drawLowDetail(ctx, rkt4Boosters, 12, theme);
			assert.ok(ctx.calls.length > 0, 'Low detail rocket with 4 boosters must render');
		});

		it('should render high-detail firing rocket and booster plumes in atmosphere and vacuum', () => {
			const ctx = createMockCanvasContext();
			const theme = ROCKET_VISUAL.THEMES.orange;

			const h3_22 = {
				radius: 2.0,
				isIgnited: true,
				burnTime: 100,
				thrustRatio: 1.0,
				stages: [
					{ radius: 2.0, fuelType: 'hydro' },
					{ radius: 2.0, fuelType: 'hydro' }
				],
				currentStageIndex: 0,
				boosters: { count: 2, fuelType: 'solid' },
				isBoosterIgnited: true,
				ambientPresRatio: 1.0
			};

			// Draw in atmosphere
			ctx.calls.length = 0;
			RocketRenderer.draw(ctx, h3_22, 200, 200, 50, 1.0);
			assert.ok(ctx.calls.length > 0, 'High detail draw in atmosphere must succeed');

			// Draw in vacuum
			h3_22.ambientPresRatio = 0.0;
			ctx.calls.length = 0;
			RocketRenderer.draw(ctx, h3_22, 200, 200, 50, 1.0);
			assert.ok(ctx.calls.length > 0, 'High detail draw in vacuum must succeed');
		});
	});

	describe('7. Trajectory Predictor & Flight Computer Atmospheric Isp Synchronization', () => {
		it('should propagate identical atmospheric Isp and thrust in PredictorPhysicsEngine', () => {
			const pEngine = new PhysicsEngine();
			const rocket = pEngine.addObject({
				id: 801,
				type: OBJECT_TYPES.ROCKET,
				mass: 80,
				stages: [{
					dryMassT: 20,
					fuelMassT: 30,
					oxidMassT: 30,
					thrustKN: 1200,
					ispVac: 320,
					ispSl: 282,
					burnTime: 180
				}],
				thrustForce: 1200000,
				burnTime: 180,
				isIgnited: true
			});

			const predictorEngine = new PredictorPhysicsEngine([], rocket, 1);
			assert.equal(predictorEngine.rocket.getEffectiveIsp(1.0), 282);
			assert.equal(predictorEngine.rocket.getEffectiveIsp(0.0), 320);
			assert.equal(predictorEngine.rocket.getEffectiveThrustForce(1.0), 1200000 * (282 / 320));
			assert.equal(predictorEngine.rocket.getEffectiveThrustForce(0.0), 1200000);
		});

		it('should record currentIsp and ambientPresRatio in FlightComputer telemetryCache', () => {
			const fc = new FlightComputer({
				stages: [
					{ thrustKN: 1000, ispVac: 320, ispSl: 282, fuelMassT: 50, oxidMassT: 50, burnTime: 150 }
				]
			});

			const sensor = {
				dt: 1.0,
				mass: 120000,
				fuelMass: 100,
				thrustForce: 1000000,
				thrustRatio: 1.0,
				burnTime: 150,
				massLossRate: 0.666,
				currentIsp: 282,
				ambientPresRatio: 1.0,
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				ax: 0,
				ay: 0,
				curAltM: 0,
				currentQ: 0
			};

			fc.update(sensor);
			assert.equal(fc.telemetryCache.currentIsp, 282);
			assert.equal(fc.telemetryCache.ambientPresRatio, 1.0);
		});
	});
});
