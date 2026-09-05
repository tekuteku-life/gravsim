// gravsim_calc_predictor.js
// Trajectory Predictor Worker: High-Performance Multi-Body Physics Simulation (Inertial Frame)
// Inherits and reuses PhysicsEngine to ensure 100% consistent physics behavior without duplicate code.

import {
	PHYSICS, SIMULATION, OBJECT_TYPES,
	DEFAULT_OBJECT_PARAMS, DEFAULT_FLIGHT_EVENTS,
	ROCKET_FUELS, TRAJECTORY_PREDICTION
} from './gravsim_const.js';
import { PhysicsEngine } from './gravsim_calc.js';
import { CalcCelestialBody, CalcRocket } from './gravsim_calc_object.js';
import { UnitConvertUtils, MathUtils } from './gravsim_utils.js';

/*******************************************************************
 * Predictor Physics Engine Subclass
 * Inherits PhysicsEngine to reuse identical force calculation,
 * flight control updates, and Velocity-Verlet integration.
 *******************************************************************/
export class PredictorPhysicsEngine extends PhysicsEngine {
	constructor(bodies, rocket, hostId, maxSimTime = TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC) {
		super();
		this.objects = [...bodies, rocket];
		this.rocket = rocket;
		this.hostId = hostId;
		this.hostBody = bodies.find(b => b.id === hostId);
		this.maxSimTime = maxSimTime;
		this.mecoTime = -1;
		this._categorizeBodies();
		this._calculateForces();
	}

	getMinSurfaceDist() {
		let minDist = Infinity;
		let closest = null;
		const rx = this.rocket.x;
		const ry = this.rocket.y;
		const rRadius = this.rocket.radius;

		for (let i = 0; i < this.massiveBodies.length; i++) {
			const b = this.massiveBodies[i];
			const dx = b.x - rx;
			const dy = b.y - ry;
			const dist = Math.hypot(dx, dy) - b.radius - rRadius;
			if (dist < minDist) {
				minDist = dist;
				closest = b;
			}
		}
		return { minSurfaceDist: minDist, closestBody: closest };
	}

	getAdaptiveDt(simTime, minSurfaceDist, distHostM) {
		const isBurning = (this.rocket.burnTime > 0 && this.rocket.isIgnited);
		const inAtmosphere = this.rocket.inAtmosphere;
		const dtCfg = TRAJECTORY_PREDICTION.DT;
		const distCfg = TRAJECTORY_PREDICTION.DIST_THRESHOLDS_M;

		if (!isBurning && this.mecoTime < 0) {
			this.mecoTime = simTime;
		}

		let dt;
		if (isBurning || (inAtmosphere && simTime < TRAJECTORY_PREDICTION.SYNC.POWERED_CUTOFF_S)) {
			dt = dtCfg.POWERED_OR_ATM;
		} else if (this.mecoTime >= 0 && (simTime - this.mecoTime) < (dtCfg.POST_BURNOUT_DURATION_S || 120.0)) {
			// Immediate post-burnout cooldown phase: keep fine steps for high accuracy
			dt = dtCfg.POST_BURNOUT_COOL || 0.1;
		} else if (minSurfaceDist < distCfg.CLOSE) {
			dt = dtCfg.SURFACE_CLOSE; // 0.1s
		} else if (minSurfaceDist < distCfg.MEDIUM) {
			dt = dtCfg.SURFACE_MEDIUM; // 0.25s
		} else if (minSurfaceDist < distCfg.FAR) {
			dt = dtCfg.SURFACE_FAR; // 0.5s
		} else if (distHostM < distCfg.MOON_ORBIT) {
			// Inside lunar orbit: scale moderately with maxSimTime up to 5.0s
			const moonDtMax = Math.min(5.0, Math.max(dtCfg.INSIDE_MOON, this.maxSimTime / 100000));
			dt = moonDtMax;
		} else {
			// Deep space (beyond Moon): dynamically scale with maxSimTime up to DEEP_SPACE_MAX_CAP
			const deepSpaceCap = dtCfg.DEEP_SPACE_MAX_CAP || 1800.0;
			const scaledDeepSpaceDt = Math.min(deepSpaceCap, Math.max(dtCfg.DEEP_SPACE, this.maxSimTime / 50000));
			dt = scaledDeepSpaceDt;
		}

		// Dynamical time scale constraint to prevent orbital energy drift:
		// dt <= eta * sqrt(r^3 / (G * M))
		const dom = this.rocket.dominantBody || this.hostBody;
		if (dom && this.rocket.distToDominantM > 0) {
			const r = this.rocket.distToDominantM;
			const gm = PHYSICS.G * dom.mass;
			if (gm > 0) {
				const eta = dtCfg.DYN_SCALE_ETA || 0.04;
				const dynDt = eta * Math.sqrt((r * r * r) / gm);
				if (dynDt < dt) {
					dt = Math.max(0.05, dynDt);
				}
			}
		}

		return dt;
	}

	step(dt) {
		this._moveObjects(dt);
	}
}

/*******************************************************************
 * Worker Message Handler
 * Runs fast-forward multi-body trajectory simulation in inertial frame
 * and projects trajectory relative to the launch host body.
 *******************************************************************/
self.onmessage = function (e) {
	const data = e.data;
	if (data.cmd !== 'predict') { return; }

	const {
		requestId,
		hostId,
		celestialBodies = [],
		rocketConfig,
		eventDefinitions = DEFAULT_FLIGHT_EVENTS,
		options = {}
	} = data;

	const result = runMultiBodySimulation({
		hostId,
		celestialBodies,
		rocketConfig,
		eventDefinitions,
		options
	});

	self.postMessage({
		cmd: 'predictionResult',
		requestId: requestId,
		...result
	});
};

/**
 * Perform high-precision fast-forward simulation of all bodies in inertial frame.
 * Reuses PhysicsEngine via PredictorPhysicsEngine for unified physical fidelity.
 * @param {Object} param
 */
export function runMultiBodySimulation({ hostId, celestialBodies = [], rocketConfig, eventDefinitions, options }) {
	const maxSimTime = options.maxSimTime || TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC;
	const maxPoints = options.maxPoints || TRAJECTORY_PREDICTION.MAX_POINTS;
	const defaultMaxSteps = TRAJECTORY_PREDICTION.MAX_STEPS || 100000;
	const computedMaxSteps = Math.max(defaultMaxSteps, Math.ceil(maxSimTime / 5));
	const maxSteps = options.maxSteps ? Math.max(options.maxSteps, computedMaxSteps) : computedMaxSteps;

	// Adaptive sampling intervals:
	// Automatically scale coast sampling interval so points fit well within maxPoints across long durations
	const baseCoastSampleTime = TRAJECTORY_PREDICTION.SAMPLING.TIME_COAST_S || 1800.0;
	const scaledCoastSampleTime = Math.max(baseCoastSampleTime, maxSimTime / (maxPoints * 0.7));
	const angleTimeThreshold = Math.max(TRAJECTORY_PREDICTION.SAMPLING.TIME_ANGLE_S || 10.0, Math.min(scaledCoastSampleTime / 20, 600.0));
	const nearBodyTimeThreshold = Math.max(TRAJECTORY_PREDICTION.SAMPLING.TIME_NEAR_BODY_S || 30.0, Math.min(scaledCoastSampleTime / 10, 1800.0));

	// Instantiate celestial body objects in world coordinates
	const bodies = celestialBodies.map(b => new CalcCelestialBody(
		b.id, b.name,
		b.x, b.y,
		b.vx, b.vy,
		0, 0,
		b.radius, 0,
		b.massKg
	));

	const hostBody = bodies.find(b => b.id === hostId);
	if (!hostBody) {
		return { hostId, points: [], events: [], isOrbital: false, maxSimTime: 0, maxAltM: 0, maxQ: 0 };
	}

	// Instantiate rocket in world coordinates
	const rocket = new CalcRocket(
		TRAJECTORY_PREDICTION.DUMMY_ROCKET_ID, rocketConfig.name || 'Rocket',
		rocketConfig.x, rocketConfig.y,
		rocketConfig.vx, rocketConfig.vy,
		0, 0,
		rocketConfig.radius || 1, 0,
		rocketConfig.dryMassKg, rocketConfig.fuelMassKg, rocketConfig.oxidMassKg,
		{
			ofRatio: rocketConfig.ofRatio || 0,
			thrustForce: rocketConfig.thrustForceN || 0,
			burnTime: rocketConfig.burnTime || 0,
			thrustAngle: rocketConfig.thrustAngle || 0,
			flightProfile: rocketConfig.flightProfile || [],
			maxGLimit: rocketConfig.maxGLimit || TRAJECTORY_PREDICTION.DEFAULT_MAX_G,
			massLossRate: rocketConfig.massLossRateKg || 0,
			autoControl: true,
			hostId: hostId,
			hostAngleRad: rocketConfig.hostAngleRad || 0,
			hostAltM: rocketConfig.hostAltM || 0,
			isHoldDown: false,
			isIgnited: true
		}
	);

	const initRelX_m = rocket.x - hostBody.x;
	const initRelY_m = rocket.y - hostBody.y;
	const initDistHostM = Math.hypot(initRelX_m, initRelY_m);
	const initialZenith = Math.atan2(initRelY_m, initRelX_m);
	rocket.thrustAngle = initialZenith;
	if (rocket.flightComputer) {
		rocket.flightComputer.currentThrustAngle = initialZenith;
		rocket.flightComputer.currentThrustAngleRad = initialZenith;
		rocket.flightComputer.targetLaunchAngle = initialZenith;
	}
	rocket.flightControl(0, hostBody, initDistHostM);
	rocket._thrustRatio = 1.0;

	// Create predictor engine inheriting PhysicsEngine
	const engine = new PredictorPhysicsEngine(bodies, rocket, hostId, maxSimTime);

	const eventRules = eventDefinitions.filter(e => e.enabled !== false);
	const points = [];
	const detectedEventsMap = new Map();

	let maxQPa = 0;
	let maxQSnapshot = null;
	let prevVv = 0;
	let maxAltM = 0;
	let isOrbital = false;
	let hasPitched = false;
	let hasReachedMeco = false;
	let mecoSimTime = -1;
	let lastSampleTime = -999;
	let lastSampleAngle = null;

	// Initial Liftoff Event
	const liftoffRule = eventRules.find(r => r.type === 'liftoff');
	if (liftoffRule) {
		detectedEventsMap.set(liftoffRule.id, {
			id: liftoffRule.id,
			name: liftoffRule.name,
			type: liftoffRule.type,
			worldX: UnitConvertUtils.m2pix(rocket.x),
			worldY: UnitConvertUtils.m2pix(rocket.y),
			relX: UnitConvertUtils.m2pix(initRelX_m),
			relY: UnitConvertUtils.m2pix(initRelY_m),
			time: 0,
			altM: initDistHostM - hostBody.radius,
			passed: false
		});
	}

	let simTime = 0;
	let stepCount = 0;

	// Initial sample point
	points.push({
		worldX: UnitConvertUtils.m2pix(rocket.x),
		worldY: UnitConvertUtils.m2pix(rocket.y),
		relX: UnitConvertUtils.m2pix(initRelX_m),
		relY: UnitConvertUtils.m2pix(initRelY_m),
		altM: initDistHostM - hostBody.radius,
		time: 0,
		domId: hostBody.id
	});
	lastSampleTime = 0;
	lastSampleAngle = initialZenith;

	// Main Fast-Forward Simulation Loop
	while (simTime < maxSimTime && stepCount < maxSteps && points.length < maxPoints) {
		stepCount++;

		const relX_m = rocket.x - hostBody.x;
		const relY_m = rocket.y - hostBody.y;
		const distHostM = Math.hypot(relX_m, relY_m);
		const altM = distHostM - hostBody.radius;
		if (altM > maxAltM) maxAltM = altM;

		const { minSurfaceDist, closestBody } = engine.getMinSurfaceDist();

		// Determine adaptive dt
		let dt = engine.getAdaptiveDt(simTime, minSurfaceDist, distHostM);
		if (simTime + dt > maxSimTime) {
			dt = maxSimTime - simTime;
			if (dt <= 0.01) break;
		}

		// Perform one full integration step via inherited PhysicsEngine
		engine.step(dt);
		simTime += dt;

		// Recompute host-relative position after step
		const curRelX_m = rocket.x - hostBody.x;
		const curRelY_m = rocket.y - hostBody.y;
		const curDistHostM = Math.hypot(curRelX_m, curRelY_m);
		const curAltM = curDistHostM - hostBody.radius;

		// Unit radial and horizontal vectors relative to host
		const uRx = curDistHostM > 0 ? curRelX_m / curDistHostM : 0;
		const uRy = curDistHostM > 0 ? curRelY_m / curDistHostM : 1;
		const uHx = -uRy;
		const uHy = uRx;

		const curRelVx = rocket.vx - hostBody.vx;
		const curRelVy = rocket.vy - hostBody.vy;
		const vV = curRelVx * uRx + curRelVy * uRy;
		const vH = curRelVx * uHx + curRelVy * uHy;

		// 1. Check Impact with any celestial body
		if (simTime > TRAJECTORY_PREDICTION.EVENTS.IMPACT_MIN_TIME_S && minSurfaceDist <= 0) {
			const isHostImpact = (closestBody && closestBody.id === hostBody.id) || curAltM <= 0;
			const impactName = isHostImpact ? 'IMPACT' : `IMPACT: ${closestBody?.name || 'Moon'}`;
			const impactRule = eventRules.find(r => r.type === 'impact');
			const impactId = isHostImpact ? (impactRule ? impactRule.id : 'impact') : `impact_${closestBody?.id}`;

			if (!detectedEventsMap.has(impactId)) {
				detectedEventsMap.set(impactId, {
					id: impactId,
					name: impactName,
					type: 'impact',
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: Math.max(0, curAltM),
					passed: false
				});
			}

			points.push({
				worldX: UnitConvertUtils.m2pix(rocket.x),
				worldY: UnitConvertUtils.m2pix(rocket.y),
				relX: UnitConvertUtils.m2pix(curRelX_m),
				relY: UnitConvertUtils.m2pix(curRelY_m),
				altM: Math.max(0, curAltM),
				time: simTime,
				domId: closestBody ? closestBody.id : hostBody.id
			});
			break;
		}

		// 2. Pitch Event detection (Synchronized with flight computer & tower clearance)
		if (!hasPitched && simTime > TRAJECTORY_PREDICTION.EVENTS.PITCH_MIN_TIME_S) {
			const pitchRule = eventRules.find(r => r.type === 'pitch');
			const currentAngle = rocket.thrustAngle;
			const angleDiff = Math.abs(MathUtils.normalizeAngle(currentAngle - initialZenith));

			if (angleDiff > TRAJECTORY_PREDICTION.EVENTS.PITCH_ANGLE_RAD || (pitchRule && (pitchRule.minAngleDeg ? UnitConvertUtils.rad2deg(angleDiff) >= pitchRule.minAngleDeg : curAltM >= TRAJECTORY_PREDICTION.EVENTS.PITCH_MIN_ALT_M))) {
				hasPitched = true;
				if (pitchRule && !detectedEventsMap.has(pitchRule.id)) {
					detectedEventsMap.set(pitchRule.id, {
						id: pitchRule.id,
						name: pitchRule.name,
						type: pitchRule.type,
						worldX: UnitConvertUtils.m2pix(rocket.x),
						worldY: UnitConvertUtils.m2pix(rocket.y),
						relX: UnitConvertUtils.m2pix(curRelX_m),
						relY: UnitConvertUtils.m2pix(curRelY_m),
						time: simTime,
						altM: curAltM,
						passed: false
					});
				}
			}
		}

		// 3. Max-Q Event tracking
		const currentQ = rocket._currentQ || (UnitConvertUtils.kpa2pa((rocket._qAxialKpa || 0) + (rocket._qLateralKpa || 0)));
		if (currentQ > maxQPa) {
			maxQPa = currentQ;
			const maxqRule = eventRules.find(r => r.type === 'maxq');
			if (maxqRule) {
				maxQSnapshot = {
					id: maxqRule.id,
					name: maxqRule.name,
					type: maxqRule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				};
			}
		}

		// 4. MECO Event detection
		if (!hasReachedMeco && (rocket.burnTime <= 0 || (rocket.fuelMass <= 0 && rocket.oxidMass <= 0))) {
			hasReachedMeco = true;
			mecoSimTime = simTime;
			const mecoRule = eventRules.find(r => r.type === 'meco');
			if (mecoRule && !detectedEventsMap.has(mecoRule.id)) {
				detectedEventsMap.set(mecoRule.id, {
					id: mecoRule.id,
					name: mecoRule.name,
					type: mecoRule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				});
			}
		}

		// 5. Apoapsis (AP) Event detection
		if (simTime > TRAJECTORY_PREDICTION.EVENTS.APOAPSIS_MIN_TIME_S && prevVv >= 0 && vV < 0 && curAltM > TRAJECTORY_PREDICTION.EVENTS.APOAPSIS_MIN_ALT_M) {
			const apRule = eventRules.find(r => r.type === 'apoapsis' || r.type === 'ap');
			if (apRule && !detectedEventsMap.has(apRule.id)) {
				detectedEventsMap.set(apRule.id, {
					id: apRule.id,
					name: apRule.name,
					type: apRule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				});
			}
		}
		prevVv = vV;

		// 6. Generic Table-Driven Events (Altitude & Time triggers)
		for (const rule of eventRules) {
			if (detectedEventsMap.has(rule.id)) { continue; }
			const targetAlt = rule.value !== undefined ? rule.value : rule.altM;
			const targetTime = rule.value !== undefined ? rule.value : rule.time;

			if (rule.type === 'alt' && targetAlt !== undefined && curAltM >= targetAlt) {
				detectedEventsMap.set(rule.id, {
					id: rule.id,
					name: rule.name,
					type: rule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				});
			} else if (rule.type === 'time' && targetTime !== undefined && simTime >= targetTime) {
				detectedEventsMap.set(rule.id, {
					id: rule.id,
					name: rule.name,
					type: rule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				});
			}
		}

		// 7. Orbit Entry detection (Inertial tangential velocity against circular velocity)
		const mu = PHYSICS.G * hostBody.mass;
		const vTangential = Math.abs(vH);
		const vCirc = Math.sqrt(mu / curDistHostM);

		if (!isOrbital && curAltM > TRAJECTORY_PREDICTION.EVENTS.ORBIT_MIN_ALT_M && vTangential >= vCirc * TRAJECTORY_PREDICTION.EVENTS.ORBIT_CIRC_RATIO && vV > TRAJECTORY_PREDICTION.EVENTS.ORBIT_RADIAL_VEL_MIN) {
			isOrbital = true;
			const orbitRule = eventRules.find(r => r.type === 'orbit');
			if (orbitRule && !detectedEventsMap.has(orbitRule.id)) {
				detectedEventsMap.set(orbitRule.id, {
					id: orbitRule.id,
					name: orbitRule.name,
					type: orbitRule.type,
					worldX: UnitConvertUtils.m2pix(rocket.x),
					worldY: UnitConvertUtils.m2pix(rocket.y),
					relX: UnitConvertUtils.m2pix(curRelX_m),
					relY: UnitConvertUtils.m2pix(curRelY_m),
					time: simTime,
					altM: curAltM,
					passed: false
				});
			}
		}

		// Intelligent Sampling: Sample based on time, angular delta, and flight phase
		const currentAngle = Math.atan2(curRelY_m, curRelX_m);
		let angleDiff = lastSampleAngle !== null ? Math.abs(MathUtils.normalizeAngle(currentAngle - lastSampleAngle)) : 999;

		const isBurning = (rocket.burnTime > 0 && rocket.isIgnited);
		const isLiftoffPhase = (simTime < (TRAJECTORY_PREDICTION.SAMPLING.LIFTOFF_PHASE_TIME_S || 15.0)) ||
			(curAltM < (TRAJECTORY_PREDICTION.SAMPLING.LIFTOFF_PHASE_ALT_M || 10000));
		const isPostBurnoutPhase = hasReachedMeco && (simTime - mecoSimTime < (TRAJECTORY_PREDICTION.SAMPLING.POST_BURNOUT_DURATION_S || 120.0));

		const minSampleTime = isLiftoffPhase
			? (TRAJECTORY_PREDICTION.SAMPLING.TIME_LIFTOFF_S || 0.1)
			: (isBurning
				? TRAJECTORY_PREDICTION.SAMPLING.TIME_POWERED_S
				: (isPostBurnoutPhase ? (TRAJECTORY_PREDICTION.SAMPLING.TIME_POST_BURNOUT_S || 1.0) : scaledCoastSampleTime));
		const sampleByTime = (simTime - lastSampleTime >= minSampleTime);
		const sampleByAngle = !isBurning && (angleDiff >= (TRAJECTORY_PREDICTION.SAMPLING.ANGLE_DELTA_RAD || 0.02) && (simTime - lastSampleTime >= (TRAJECTORY_PREDICTION.SAMPLING.TIME_ANGLE_S || 5.0)));
		const sampleNearBody = (minSurfaceDist < TRAJECTORY_PREDICTION.SAMPLING.NEAR_BODY_DIST_M && (simTime - lastSampleTime >= nearBodyTimeThreshold));

		if (sampleByTime || sampleByAngle || sampleNearBody) {
			points.push({
				worldX: UnitConvertUtils.m2pix(rocket.x),
				worldY: UnitConvertUtils.m2pix(rocket.y),
				relX: UnitConvertUtils.m2pix(curRelX_m),
				relY: UnitConvertUtils.m2pix(curRelY_m),
				altM: curAltM,
				time: simTime,
				domId: rocket.dominantBody ? rocket.dominantBody.id : hostBody.id
			});
			lastSampleTime = simTime;
			lastSampleAngle = currentAngle;
		}
	}

	// Always ensure the final position is included
	const finalRelX_m = rocket.x - hostBody.x;
	const finalRelY_m = rocket.y - hostBody.y;
	points.push({
		worldX: UnitConvertUtils.m2pix(rocket.x),
		worldY: UnitConvertUtils.m2pix(rocket.y),
		relX: UnitConvertUtils.m2pix(finalRelX_m),
		relY: UnitConvertUtils.m2pix(finalRelY_m),
		altM: Math.hypot(finalRelX_m, finalRelY_m) - hostBody.radius,
		time: simTime,
		domId: rocket.dominantBody ? rocket.dominantBody.id : hostBody.id
	});

	// Register Max-Q event
	if (maxQSnapshot && !detectedEventsMap.has(maxQSnapshot.id)) {
		detectedEventsMap.set(maxQSnapshot.id, maxQSnapshot);
	}

	// Suppress false impact event if in stable orbit
	if (isOrbital) {
		const impactRule = eventRules.find(r => r.type === 'impact');
		if (impactRule) detectedEventsMap.delete(impactRule.id);
	}

	const events = Array.from(detectedEventsMap.values()).sort((a, b) => a.time - b.time);

	return {
		hostId: hostId,
		points: points,
		events: events,
		isOrbital: isOrbital,
		maxSimTime: points[points.length - 1]?.time || simTime,
		maxAltM: maxAltM,
		maxQ: maxQPa
	};
}
