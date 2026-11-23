// gravsim_calc_predictor.js
// Trajectory Predictor Worker: High-Performance Multi-Body Physics Simulation (Inertial Frame)
// Inherits and reuses PhysicsEngine to ensure 100% consistent physics behavior without duplicate code.

import {
	PHYSICS, DEFAULT_FLIGHT_EVENTS, TRAJECTORY_PREDICTION
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

	_updateFlightControl(dt) {
		if (this.rocket && !this.rocket.collided && !this.rocket.shattered) {
			this.rocket.flightControl(dt, this.rocket.dominantBody, this.rocket.distToDominantM, this.sunBody);
			if (this.rocket._pendingDebris) {
				this.rocket._pendingDebris.length = 0;
			}
		}
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
if (typeof self !== 'undefined') {
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
}

/**
 * Perform high-precision fast-forward simulation of all bodies in inertial frame.
 * Reuses PhysicsEngine via PredictorPhysicsEngine for unified physical fidelity.
 * @param {Object} param
 */
export function runMultiBodySimulation({ hostId, celestialBodies = [], rocketConfig, eventDefinitions = DEFAULT_FLIGHT_EVENTS, options = {} }) {
	const maxSimTime = options.maxSimTime || TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC;
	// MAX_POINTS is a hard bound like MAX_STEPS_CAP: a positive options.maxPoints can only lower it; any other value
	// (missing, 0, negative, NaN, non-numeric) is ignored.
	const optMaxPoints = Number(options.maxPoints);
	const maxPoints = Math.min(TRAJECTORY_PREDICTION.MAX_POINTS, optMaxPoints > 0 ? optMaxPoints : TRAJECTORY_PREDICTION.MAX_POINTS);
	const defaultMaxSteps = TRAJECTORY_PREDICTION.MAX_STEPS || 120000;
	const maxStepsCap = TRAJECTORY_PREDICTION.MAX_STEPS_CAP || 340000;
	const computedMaxSteps = Math.min(maxStepsCap, Math.max(defaultMaxSteps, Math.ceil(maxSimTime / 5)));
	// MAX_STEPS_CAP is a hard, deterministic bound for every caller: a positive options.maxSteps can only raise the
	// floor; any other value (missing, 0, negative, NaN, non-numeric) is ignored.
	const optMaxSteps = Number(options.maxSteps);
	const maxSteps = Math.min(maxStepsCap, optMaxSteps > 0 ? Math.max(optMaxSteps, computedMaxSteps) : computedMaxSteps);

	// Adaptive sampling intervals:
	// Dynamically scale coast intervals while preventing excessive polygon bends or early point exhaustion
	const baseCoastSampleTime = TRAJECTORY_PREDICTION.SAMPLING.TIME_COAST_S || 1800.0;
	const scaledCoastSampleTime = Math.max(baseCoastSampleTime, maxSimTime / (maxPoints * 0.45));
	const angleTimeThreshold = Math.max(TRAJECTORY_PREDICTION.SAMPLING.TIME_ANGLE_S || 5.0, Math.min(scaledCoastSampleTime / 20, 600.0));
	const nearBodyTimeThreshold = TRAJECTORY_PREDICTION.SAMPLING.TIME_NEAR_BODY_S || 15.0;
	const baseNearBodyDt = (maxSimTime > 86400 * 3)
		? Math.max(nearBodyTimeThreshold, maxSimTime / (maxPoints * 0.65))
		: nearBodyTimeThreshold;

	// Instantiate celestial body objects in world coordinates
	const bodies = celestialBodies.map(b => {
		const cb = new CalcCelestialBody(
			b.id, b.name,
			b.x, b.y,
			b.vx, b.vy,
			0, 0,
			b.radius, 0,
			b.massKg !== undefined ? b.massKg : UnitConvertUtils.ton2kg(b.mass || 0)
		);
		cb.rotationAngle = b.rotationAngle || 0;
		cb.param = b.param || null;
		cb.rotationPeriod = b.rotationPeriod || b.param?.ROTATION_PERIOD || 0;
		return cb;
	});

	const hostBody = bodies.find(b => b.id === hostId);
	if (!hostBody) {
		return {
			hostId, points: [], events: [], isOrbital: false, maxSimTime: 0, maxAltM: 0, maxQ: 0,
			endReason: 'no_host', steps: 0, frameSwitchTime: null, frameSwitchHostRot: null, hostOmega: 0
		};
	}

	// Instantiate rocket in world coordinates
	const dryMassT = rocketConfig.dryMassT !== undefined ? rocketConfig.dryMassT : (rocketConfig.dryMassKg ? UnitConvertUtils.kg2ton(rocketConfig.dryMassKg) : 7);
	const fuelMassT = rocketConfig.fuelMassT !== undefined ? rocketConfig.fuelMassT : (rocketConfig.fuelMassKg ? UnitConvertUtils.kg2ton(rocketConfig.fuelMassKg) : 88);
	const oxidMassT = rocketConfig.oxidMassT !== undefined ? rocketConfig.oxidMassT : (rocketConfig.oxidMassKg ? UnitConvertUtils.kg2ton(rocketConfig.oxidMassKg) : 220);

	const rocket = new CalcRocket(
		TRAJECTORY_PREDICTION.DUMMY_ROCKET_ID, rocketConfig.name || 'Rocket',
		rocketConfig.x, rocketConfig.y,
		rocketConfig.vx, rocketConfig.vy,
		0, 0,
		rocketConfig.bottomOffsetM || rocketConfig.radius || 31.5, 0,
		dryMassT, fuelMassT, oxidMassT,
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
			bottomOffsetM: rocketConfig.bottomOffsetM || 31.5,
			hostAngleRad: rocketConfig.hostAngleRad || 0,
			hostAltM: rocketConfig.hostAltM || 0,
			isHoldDown: false,
			isIgnited: true,
			stages: rocketConfig.stages,
			payload: rocketConfig.payload,
			fairing: rocketConfig.fairing,
			boosters: rocketConfig.boosters,
			baseRadiusM: rocketConfig.baseRadiusM,
			disableOrbitalCutoff: Boolean(rocketConfig.disableOrbitalCutoff),
			targetApogeeKm: rocketConfig.targetApogeeKm || 0,
			targetPerigeeKm: rocketConfig.targetPerigeeKm || 0,
			targetVInfKmS: rocketConfig.targetVInfKmS || 0,
			disableStaging: Boolean(rocketConfig.disableStaging),
			trackRcsVisualState: false
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
	let lastSampleVelAngle = null;
	let lastSampleRelX_m = initRelX_m;
	let lastSampleRelY_m = initRelY_m;
	let prevSampledBurning = (rocket.burnTime > 0 && rocket.isIgnited);
	let prevStageIndex = rocket.currentStageIndex || 0;
	let prevStg2Sep = Boolean(rocket.isStage2Separated);
	let prevPayloadSep = Boolean(rocket.isPayloadSeparated);

	let lastStageState = rocket.stageState;
	let hasSeparatedFairing = false;
	let hasBoosterBurnout = false;
	let hasBoosterSep = false;
	const recordedStageMeco = new Set();
	const recordedStageSep = new Set();
	const recordedStageSes = new Set();
	const hostParam = hostBody.param || (typeof globalThis !== 'undefined' && globalThis.__presetManager ? globalThis.__presetManager.getObjectParam(hostBody.name) : null);
	const hostRotationPeriod = hostParam?.ROTATION_PERIOD || hostBody.rotationPeriod || 0;
	const hostOmega = hostRotationPeriod ? (2 * Math.PI) / hostRotationPeriod : 0;
	const hostInitRot = hostBody.rotationAngle || 0;
	const initDistHostPx = UnitConvertUtils.m2pix(initDistHostM);

	let curRelX_m = initRelX_m;
	let curRelY_m = initRelY_m;
	let curDistHostM = initDistHostM;
	let curDistHostPx = initDistHostPx;
	let curRotAngle = 0;
	let curInertialPhi = initialZenith;
	let curPhiSurf = initialZenith - hostInitRot;
	let simTime = 0;
	let stepCount = 0;

	const makeEvent = (ruleId, ruleName, ruleType, alt) => ({
		id: ruleId,
		name: ruleName,
		type: ruleType,
		worldX: UnitConvertUtils.m2pix(rocket.x),
		worldY: UnitConvertUtils.m2pix(rocket.y),
		relX: UnitConvertUtils.m2pix(curRelX_m),
		relY: UnitConvertUtils.m2pix(curRelY_m),
		r: curDistHostPx,
		phiSurf: curPhiSurf,
		time: simTime,
		altM: alt,
		passed: false
	});
	/** The cutoff of stage index stgIdx: MECO-N, SECO-1 for the last stage of a multistage vehicle, MECO for a single stage. */
	const recordStageCutoff = (stgIdx, alt) => {
		const isFinalStage = stgIdx + 1 >= rocket.totalStages;
		const eventId = isFinalStage ? (rocket.totalStages > 1 ? 'seco_1' : 'meco') : `meco_${stgIdx + 1}`;
		const eventName = isFinalStage ? (rocket.totalStages > 1 ? 'SECO-1' : 'MECO') : `MECO-${stgIdx + 1}`;
		if (!detectedEventsMap.has(eventId)) {
			detectedEventsMap.set(eventId, makeEvent(eventId, eventName, isFinalStage ? 'meco' : 'stg_meco', alt));
		}
	};

	// Initial Liftoff Event
	const liftoffRule = eventRules.find(r => r.type === 'liftoff');
	if (liftoffRule) {
		detectedEventsMap.set(liftoffRule.id, makeEvent(liftoffRule.id, liftoffRule.name, liftoffRule.type, initDistHostM - hostBody.radius));
	}

	// Initial sample point
	points.push({
		worldX: UnitConvertUtils.m2pix(rocket.x),
		worldY: UnitConvertUtils.m2pix(rocket.y),
		relX: UnitConvertUtils.m2pix(initRelX_m),
		relY: UnitConvertUtils.m2pix(initRelY_m),
		r: initDistHostPx,
		phiSurf: curPhiSurf,
		altM: initDistHostM - hostBody.radius,
		time: 0,
		domId: hostBody.id
	});
	lastSampleTime = 0;
	lastSampleAngle = initialZenith;
	lastSampleRelX_m = initRelX_m;
	lastSampleRelY_m = initRelY_m;

	// Drawn-frame bookkeeping: points up to frameSwitchTime are drawn host-fixed (phiSurf), later points
	// host-centred inertial (relX/relY). The switch happens at the first sample after the vehicle leaves the
	// host-fixed regime (orbit insertion, or above the atmosphere while escaping / beyond MAX_HOST_FIXED_ALT_M).
	let frameSwitchTime = null;
	let frameSwitchHostRot = null;
	let lastSamplePhiSurf = curPhiSurf;
	let lastSampleHostRot = hostInitRot;
	let endReason = null;
	const hostAtmLimitAltM = Math.max(0, Number(hostParam?.ATM_LIMIT_ALT ?? hostParam?.atmLimitAlt ?? 0)) || TRAJECTORY_PREDICTION.EVENTS.ORBIT_MIN_ALT_M;
	const frameSwitchMaxHostFixedAltM = TRAJECTORY_PREDICTION.FRAME_SWITCH?.MAX_HOST_FIXED_ALT_M || TRAJECTORY_PREDICTION.DIST_THRESHOLDS_M.FAR;
	{
		const initVelMag = Math.hypot(rocket.vx - hostBody.vx, rocket.vy - hostBody.vy);
		lastSampleVelAngle = initVelMag > 1.0 ? Math.atan2(rocket.vy - hostBody.vy, rocket.vx - hostBody.vx) : initialZenith;
	}

	// Loop-invariant sampling constants (hoisted: the loop runs up to MAX_STEPS_CAP times on the main thread)
	const sampling = TRAJECTORY_PREDICTION.SAMPLING;
	const liftoffPhaseTimeS = sampling.LIFTOFF_PHASE_TIME_S || 15.0;
	const liftoffPhaseAltM = sampling.LIFTOFF_PHASE_ALT_M || 10000;
	const postBurnoutDurationS = sampling.POST_BURNOUT_DURATION_S || 120.0;
	const timeLiftoffS = sampling.TIME_LIFTOFF_S || 0.1;
	const timePoweredS = sampling.TIME_POWERED_S;
	const timePostBurnoutS = sampling.TIME_POST_BURNOUT_S || 1.0;
	const softBudgetPoints = maxPoints * (sampling.BUDGET_SOFT_THRESHOLD_RATIO || 0.55);
	const angleDeltaRad = sampling.ANGLE_DELTA_RAD || 0.02;
	const minHeadingSpeedMS = sampling.MIN_HEADING_SPEED_M_S || 5.0;
	const headingDeltaRad = sampling.HEADING_DELTA_RAD || 0.035;
	const timeHeadingCoastS = sampling.TIME_HEADING_COAST_S || 2.5;
	const timeApsidalCoastS = sampling.TIME_APSIDAL_COAST_S || 2.0;
	const nearBodyDistM = sampling.NEAR_BODY_DIST_M;
	const minSampleDt = sampling.MIN_SAMPLE_DT_S || 0.05;
	const maxAngleStep = sampling.MAX_ANGLE_STEP_RAD || 0.12;
	const hasVelRules = eventRules.some(r => r.type === 'vel');
	// Only alt/time/vel rules can fire in the generic table-driven check below
	const genericRules = eventRules.filter(r => r.type === 'alt' || r.type === 'time' || r.type === 'vel');
	const evCfg = TRAJECTORY_PREDICTION.EVENTS;
	const impactMinTimeS = evCfg.IMPACT_MIN_TIME_S;
	const pitchMinTimeS = evCfg.PITCH_MIN_TIME_S;
	const apoapsisMinTimeS = evCfg.APOAPSIS_MIN_TIME_S;
	const apoapsisMinAltM = evCfg.APOAPSIS_MIN_ALT_M;
	const orbitMinAltM = evCfg.ORBIT_MIN_ALT_M;
	const orbitCircRatio = evCfg.ORBIT_CIRC_RATIO;
	const orbitRadialVelMin = evCfg.ORBIT_RADIAL_VEL_MIN;
	const mu = PHYSICS.G * hostBody.mass; // host mass is constant during a prediction
	const minHeadingSpeedSq = minHeadingSpeedMS * minHeadingSpeedMS;

	// Structural breakup before the first step (e.g. over its load limit at t = 0, §4.11): the condition holds at t = 0,
	// so the run ends there with the initial point only and no integration step.
	const destroyedAtStart = rocket.collided || rocket.shattered;
	if (destroyedAtStart) {
		const initAltM = initDistHostM - hostBody.radius;
		if (initAltM > maxAltM) maxAltM = initAltM;
		detectedEventsMap.set('breakup', makeEvent('breakup', 'BREAKUP', 'impact', Math.max(0, initAltM)));
		endReason = 'breakup';
	}

	// Main Fast-Forward Simulation Loop
	while (!destroyedAtStart && simTime < maxSimTime && stepCount < maxSteps && points.length < maxPoints) {
		// Positions only change inside engine.step(), so the post-step distance of the previous iteration
		// (initially initDistHostM) is the current pre-step distance.
		const distHostM = curDistHostM;
		const altM = distHostM - hostBody.radius;
		if (altM > maxAltM) maxAltM = altM;

		const { minSurfaceDist, closestBody } = engine.getMinSurfaceDist();

		// Determine adaptive dt
		let dt = engine.getAdaptiveDt(simTime, minSurfaceDist, distHostM);
		if (simTime + dt > maxSimTime) {
			dt = maxSimTime - simTime;
			if (dt <= 0.01) break; // the remainder is not integrated (and not counted in steps)
		}

		// Perform one full integration step via inherited PhysicsEngine
		engine.step(dt);
		simTime += dt;
		stepCount++; // steps = integration steps actually taken

		// Recompute host-relative position after step
		curRelX_m = rocket.x - hostBody.x;
		curRelY_m = rocket.y - hostBody.y;
		curDistHostM = Math.hypot(curRelX_m, curRelY_m);
		curDistHostPx = UnitConvertUtils.m2pix(curDistHostM);
		curRotAngle = hostOmega * simTime;
		curInertialPhi = Math.atan2(curRelY_m, curRelX_m);
		curPhiSurf = curInertialPhi - (hostInitRot + curRotAngle);
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

		// 1. Check Impact with any celestial body (sample point emitted once post-loop in meter check)
		if (simTime > impactMinTimeS && minSurfaceDist <= 0) {
			const isHostImpact = (closestBody && closestBody.id === hostBody.id) || curAltM <= 0;
			const impactName = isHostImpact ? 'IMPACT' : `IMPACT: ${closestBody?.name || 'Moon'}`;
			const impactRule = eventRules.find(r => r.type === 'impact');
			const impactId = isHostImpact ? (impactRule ? impactRule.id : 'impact') : `impact_${closestBody?.id}`;

			if (!detectedEventsMap.has(impactId)) {
				detectedEventsMap.set(impactId, makeEvent(impactId, impactName, 'impact', Math.max(0, curAltM)));
			}

			endReason = 'impact';
			break;
		}

		// 1b. Structural breakup (dynamic pressure / G-limit): the integrator freezes destroyed objects,
		// so continuing would emit a straight line of a motionless wreck. Terminate at the breakup point.
		if (rocket.collided || rocket.shattered) {
			if (!detectedEventsMap.has('breakup')) {
				detectedEventsMap.set('breakup', makeEvent('breakup', 'BREAKUP', 'impact', Math.max(0, curAltM)));
			}
			endReason = 'breakup';
			break;
		}

		// 2. Pitch Event detection (Synchronized with flight computer & tower clearance)
		if (!hasPitched && simTime > pitchMinTimeS) {
			const pitchRule = eventRules.find(r => r.type === 'pitch');
			const currentAngle = rocket.thrustAngle;
			const angleDiff = Math.abs(MathUtils.normalizeAngle(currentAngle - initialZenith));

			if (angleDiff > TRAJECTORY_PREDICTION.EVENTS.PITCH_ANGLE_RAD || (pitchRule && (pitchRule.minAngleDeg ? UnitConvertUtils.rad2deg(angleDiff) >= pitchRule.minAngleDeg : curAltM >= TRAJECTORY_PREDICTION.EVENTS.PITCH_MIN_ALT_M))) {
				hasPitched = true;
				if (pitchRule && !detectedEventsMap.has(pitchRule.id)) {
					detectedEventsMap.set(pitchRule.id, makeEvent(pitchRule.id, pitchRule.name, pitchRule.type, curAltM));
				}
			}
		}

		// 3. Max-Q Event tracking
		const currentQ = rocket._currentQ || (UnitConvertUtils.kpa2pa((rocket._qAxialKpa || 0) + (rocket._qLateralKpa || 0)));
		if (currentQ > maxQPa) {
			maxQPa = currentQ;
			const maxqRule = eventRules.find(r => r.type === 'maxq');
			if (maxqRule) {
				maxQSnapshot = makeEvent(maxqRule.id, maxqRule.name, maxqRule.type, curAltM);
			}
		}

		// 4. Multi-Stage Event Detection
		// (a) MECO detection for each stage
		if (rocket.stageState === 'STG_MECO' || rocket.stageState === 'ORBITAL_COAST') {
			const stgIdx = rocket.currentStageIndex;
			if (!recordedStageMeco.has(stgIdx)) {
				recordedStageMeco.add(stgIdx);
				hasReachedMeco = true;
				mecoSimTime = simTime;
				// After the payload separation the index is totalStages and the state is the payload's: its engine stop is
				// PAYLOAD CUTOFF (c2), and a passive payload never burned. The last stage's cutoff is its own state or (b)
				if (stgIdx < rocket.totalStages) {
					recordStageCutoff(stgIdx, curAltM);
				}
			}
		}

		// (b) Stage & Payload Separation detection via state deltas (handles direct BURNING/ORBITAL_COAST separation & multi-stage skip)
		// Whether the payload was already separated when this step began: only then was a burn of the previous step
		// the payload's own (read by (c2) below, before prevPayloadSep moves on to this step)
		const wasPayloadSeparated = prevPayloadSep;
		const curStageIdxNow = rocket.currentStageIndex || 0;
		// A separation of the stage that was burning when the step began ends its burn there: a flight-plan row with a
		// sep_* action (design §3.4-1) zeroes its propellant and jettisons it in the same step, so its cutoff (never seen
		// as STG_MECO) is recorded with the separation, before it. A stage jettisoned before its ignition (in
		// INTERSTAGE_COAST, or a later stage that sep_payload drops with it) had no burn and has no cutoff
		if (curStageIdxNow > prevStageIndex && lastStageState === 'STG_BURNING' && !wasPayloadSeparated && !recordedStageMeco.has(prevStageIndex)) {
			recordedStageMeco.add(prevStageIndex);
			hasReachedMeco = true;
			mecoSimTime = simTime;
			recordStageCutoff(prevStageIndex, curAltM);
		}
		const maxStageSep = Math.min(curStageIdxNow, rocket.totalStages || curStageIdxNow);
		for (let s = prevStageIndex + 1; s <= maxStageSep; s++) {
			if (!recordedStageSep.has(s)) {
				recordedStageSep.add(s);
				const isFinalSep = s >= (rocket.totalStages || 1);
				const eventId = `stg_sep_${s}`;
				const eventName = isFinalSep ? `${s}-STG-SEP` : `STG-${s} SEP`;
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, eventName, 'staging', curAltM));
				}
			}
		}
		// 2-STG-SEP only for vehicles that have a second stage (design §4.14-10): a single-stage vehicle sets isStage2Separated
		// at the payload separation (CalcRocket, totalStages <= 2), which is not a second-stage separation
		if (!prevStg2Sep && rocket.isStage2Separated && rocket.totalStages >= 2 && !recordedStageSep.has(2)) {
			recordedStageSep.add(2);
			if (!detectedEventsMap.has('stg_sep_2')) {
				detectedEventsMap.set('stg_sep_2', makeEvent('stg_sep_2', '2-STG-SEP', 'staging', curAltM));
			}
		}
		if (!prevPayloadSep && rocket.isPayloadSeparated) {
			if (!detectedEventsMap.has('payload_sep')) {
				detectedEventsMap.set('payload_sep', makeEvent('payload_sep', 'PAYLOAD SEP', 'staging', curAltM));
			}
		}
		prevStageIndex = curStageIdxNow;
		prevStg2Sep = Boolean(rocket.isStage2Separated);
		prevPayloadSep = Boolean(rocket.isPayloadSeparated);

		// (c) Second / Upper Engine Start (SES) or Reignition / Payload Start
		if (!wasPayloadSeparated && rocket.isPayloadSeparated && rocket.stageState === 'STG_BURNING') {
			// The payload separated and lit its own engine in this step, from whatever the stage was doing: a sep_* row
			// leaves a self-propelled payload in STG_COAST and the same flight-control step re-ignites it on a commanded
			// throttle (design §3.4-1). The default staging separates it in STG_MECO and re-ignites it in a later step
			const eventId = 'payload_start';
			if (!detectedEventsMap.has(eventId)) {
				detectedEventsMap.set(eventId, makeEvent(eventId, 'PAYLOAD START', 'ignition', curAltM));
			}
		} else if (lastStageState === 'INTERSTAGE_COAST' && rocket.stageState === 'STG_BURNING') {
			const stgNum = rocket.currentStageIndex + 1;
			if (!recordedStageSes.has(stgNum)) {
				recordedStageSes.add(stgNum);
				const eventId = `ses_${stgNum - 1}`;
				const eventName = `SES-${stgNum - 1}`;
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, eventName, 'ignition', curAltM));
				}
			}
		} else if (lastStageState === 'STG_COAST' && rocket.stageState === 'STG_BURNING') {
			if (rocket.isPayloadSeparated) {
				const eventId = 'payload_start';
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, 'PAYLOAD START', 'ignition', curAltM));
				}
			} else {
				const eventId = `reignition_${rocket.currentStageIndex + 1}`;
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, 'REIGNITION', 'ignition', curAltM));
				}
			}
		}

		// (c2) Payload Cutoff: the payload's own engine stops. The burn of the previous step must be the payload's, i.e.
		// the payload was separated before this step. A separation during the upper-stage burn (a flight-plan row with
		// action sep_payload, design §3.4-1) also ends in ORBITAL_COAST for a passive payload, which has no engine, and
		// is the end of the upper stage's burn, not a PAYLOAD CUTOFF
		if (lastStageState === 'STG_BURNING' && wasPayloadSeparated && rocket.isPayloadSeparated && (rocket.stageState === 'ORBITAL_COAST' || rocket.burnTime <= 0)) {
			const eventId = 'payload_cutoff';
			if (!detectedEventsMap.has(eventId)) {
				detectedEventsMap.set(eventId, makeEvent(eventId, 'PAYLOAD CUTOFF', 'meco', curAltM));
			}
		}

		// (d) Fairing Separation detection
		if (!hasSeparatedFairing && rocket.fairing && rocket.fairing.isSeparated) {
			hasSeparatedFairing = true;
			const eventId = 'fairing_sep';
			if (!detectedEventsMap.has(eventId)) {
				detectedEventsMap.set(eventId, makeEvent(eventId, 'FAIRING JETTISON', 'fairing', curAltM));
			}
		}

		// (e) Booster Burnout & Separation detection
		if (rocket.hasBoosters) {
			if (!hasBoosterBurnout && rocket.isBoosterBurnout) {
				hasBoosterBurnout = true;
				const eventId = 'booster_burnout';
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, 'BOOSTER BURNOUT', 'meco', curAltM));
				}
			}
			if (!hasBoosterSep && rocket.isBoosterSeparated) {
				hasBoosterSep = true;
				const eventId = 'booster_sep';
				if (!detectedEventsMap.has(eventId)) {
					detectedEventsMap.set(eventId, makeEvent(eventId, 'BOOSTER SEP', 'staging', curAltM));
				}
			}
		}

		lastStageState = rocket.stageState;

		// 5. Apoapsis (AP) Event detection
		if (simTime > apoapsisMinTimeS && prevVv >= 0 && vV < 0 && curAltM > apoapsisMinAltM) {
			const apRule = eventRules.find(r => r.type === 'apoapsis' || r.type === 'ap');
			if (apRule && !detectedEventsMap.has(apRule.id)) {
				detectedEventsMap.set(apRule.id, makeEvent(apRule.id, apRule.name, apRule.type, curAltM));
			}
		}

		// 6. Generic Table-Driven Events (Altitude, Time & Velocity triggers)
		let curEventVel = 0;
		if (hasVelRules) {
			const fcTm = rocket.flightComputer?.telemetryCache;
			curEventVel = fcTm ? Math.hypot(fcTm.vV || 0, fcTm.vH || 0) : Math.hypot(vV, vH);
		}
		for (const rule of genericRules) {
			if (detectedEventsMap.has(rule.id)) { continue; }
			const targetAlt = rule.value !== undefined ? rule.value : rule.altM;
			const targetTime = rule.value !== undefined ? rule.value : rule.time;
			const targetVel = rule.value !== undefined ? rule.value : rule.vel;

			if (rule.type === 'alt' && targetAlt !== undefined && curAltM >= targetAlt) {
				detectedEventsMap.set(rule.id, makeEvent(rule.id, rule.name, rule.type, curAltM));
			} else if (rule.type === 'time' && targetTime !== undefined && simTime >= targetTime) {
				detectedEventsMap.set(rule.id, makeEvent(rule.id, rule.name, rule.type, curAltM));
			} else if (rule.type === 'vel' && targetVel !== undefined && curEventVel >= targetVel) {
				detectedEventsMap.set(rule.id, makeEvent(rule.id, rule.name, rule.type, curAltM));
			}
		}

		// 7. Orbit Entry detection (Inertial tangential velocity against circular velocity)
		if (!isOrbital && curAltM > orbitMinAltM && Math.abs(vH) >= Math.sqrt(mu / curDistHostM) * orbitCircRatio && vV > orbitRadialVelMin) {
			isOrbital = true;
			const orbitRule = eventRules.find(r => r.type === 'orbit');
			if (orbitRule && !detectedEventsMap.has(orbitRule.id)) {
				detectedEventsMap.set(orbitRule.id, makeEvent(orbitRule.id, orbitRule.name, orbitRule.type, curAltM));
			}
		}

		// Intelligent Curvature + Budget-Aware Sampling
		const currentAngle = curInertialPhi;
		const angleDiff = lastSampleAngle !== null ? Math.abs(MathUtils.normalizeAngle(currentAngle - lastSampleAngle)) : 999;

		const speedSq = curRelVx * curRelVx + curRelVy * curRelVy;
		const hasVelHeading = speedSq > 0.01; // |v| > 0.1 m/s
		const curVelAngle = hasVelHeading ? Math.atan2(curRelVy, curRelVx) : (lastSampleVelAngle ?? currentAngle);
		const headingDiff = lastSampleVelAngle !== null ? Math.abs(MathUtils.normalizeAngle(curVelAngle - lastSampleVelAngle)) : 999;

		const isBurning = (rocket.burnTime > 0 && rocket.isIgnited);
		const isLiftoffPhase = (simTime < liftoffPhaseTimeS) || (curAltM < liftoffPhaseAltM);
		const isPostBurnoutPhase = hasReachedMeco && (simTime - mecoSimTime < postBurnoutDurationS);

		const minSampleTime = isLiftoffPhase
			? timeLiftoffS
			: (isBurning
				? timePoweredS
				: (isPostBurnoutPhase ? timePostBurnoutS : scaledCoastSampleTime));

		const hardBudgetFloorDt = (points.length > softBudgetPoints)
			? ((maxSimTime - simTime) / Math.max(1, maxPoints - points.length - 1)) * 0.85
			: 0;
		const dtSample = simTime - lastSampleTime;

		const sampleByTime = (dtSample >= Math.max(minSampleTime, isBurning ? 0 : hardBudgetFloorDt));
		const sampleByAngle = !isBurning && (angleDiff >= angleDeltaRad) && (dtSample >= Math.max(angleTimeThreshold, hardBudgetFloorDt));
		const sampleByHeading = speedSq > minHeadingSpeedSq
			&& (headingDiff >= headingDeltaRad)
			&& (dtSample >= Math.max(isBurning ? 0.5 : timeHeadingCoastS, isBurning ? 0 : hardBudgetFloorDt));
		// Apsis passage: strict sign crossing of radial velocity (excludes the degenerate 0 -> 0 case)
		const isApsidalCrossing = (prevVv > 0 && vV <= 0) || (prevVv < 0 && vV >= 0);
		const sampleByApsidal = !isBurning
			&& isApsidalCrossing
			&& (dtSample >= Math.max(timeApsidalCoastS, hardBudgetFloorDt));
		const sampleNearBody = (minSurfaceDist < nearBodyDistM) && (dtSample >= Math.max(baseNearBodyDt, isBurning ? 0 : hardBudgetFloorDt));
		const sampleByPhaseEdge = (isBurning !== prevSampledBurning) && (dtSample >= minSampleDt);
		// Hard smoothness guarantee (overrides budget thinning): the budget floor assumes the run reaches
		// maxSimTime, but near-body closed orbits are cut by the step budget long before that, so thinning
		// alone would alias a revolution into a few chords (zig-zag). Running out of points is preferable.
		// The cap is evaluated in the drawn frame: host-fixed before the frame switch, inertial after it.
		const drawnAngleDiff = (frameSwitchTime === null)
			? Math.max(angleDiff, Math.abs(MathUtils.normalizeAngle(curPhiSurf - lastSamplePhiSurf)))
			: angleDiff;
		const sampleByAngleCap = (dtSample >= minSampleDt)
			&& ((drawnAngleDiff >= maxAngleStep)
				|| (speedSq > minHeadingSpeedSq && headingDiff >= maxAngleStep));
		// Leave the host-fixed frame on orbit insertion, or once above the atmosphere while escaping (E >= 0)
		// or beyond MAX_HOST_FIXED_ALT_M (direct-ascent departures may never satisfy the orbit criterion).
		const needsFrameSwitch = frameSwitchTime === null && (isOrbital
			|| (curAltM > hostAtmLimitAltM
				&& ((0.5 * speedSq - mu / curDistHostM) >= 0 || curAltM >= frameSwitchMaxHostFixedAltM)));
		const sampleByFrameSwitch = needsFrameSwitch && (dtSample >= minSampleDt);
		if (needsFrameSwitch && !sampleByFrameSwitch) {
			// A sample was emitted less than MIN_SAMPLE_DT_S ago: use it as the switch point
			frameSwitchTime = lastSampleTime;
			frameSwitchHostRot = lastSampleHostRot;
		}

		if (sampleByTime || sampleByAngle || sampleByHeading || sampleByApsidal || sampleNearBody || sampleByPhaseEdge || sampleByAngleCap || sampleByFrameSwitch) {
			points.push({
				worldX: UnitConvertUtils.m2pix(rocket.x),
				worldY: UnitConvertUtils.m2pix(rocket.y),
				relX: UnitConvertUtils.m2pix(curRelX_m),
				relY: UnitConvertUtils.m2pix(curRelY_m),
				r: curDistHostPx,
				phiSurf: curPhiSurf,
				altM: curAltM,
				time: simTime,
				domId: rocket.dominantBody ? rocket.dominantBody.id : hostBody.id
			});
			lastSampleTime = simTime;
			lastSampleAngle = currentAngle;
			if (hasVelHeading) lastSampleVelAngle = curVelAngle;
			lastSampleRelX_m = curRelX_m;
			lastSampleRelY_m = curRelY_m;
			lastSamplePhiSurf = curPhiSurf;
			lastSampleHostRot = hostInitRot + curRotAngle;
			prevSampledBurning = isBurning;
			if (sampleByFrameSwitch) {
				frameSwitchTime = simTime;
				frameSwitchHostRot = lastSampleHostRot;
			}
		}
		// Single end-of-step update: AP detection and apsidal sampling both compare against the previous step
		prevVv = vV;
	}

	if (endReason === null) {
		if (simTime >= maxSimTime - 0.01) endReason = 'horizon';
		else if (points.length >= maxPoints) endReason = 'point_budget';
		else endReason = 'step_budget';
	}

	// Append final position strictly once if displaced in meters and later than last emitted sample
	const finalRelX_m = rocket.x - hostBody.x;
	const finalRelY_m = rocket.y - hostBody.y;
	const finalDispM2 = (finalRelX_m - lastSampleRelX_m) ** 2 + (finalRelY_m - lastSampleRelY_m) ** 2;
	const minDispM2 = TRAJECTORY_PREDICTION.SAMPLING.MIN_SAMPLE_DISPLACEMENT_M_SQ || 1e-4;
	if (simTime > lastSampleTime + 1e-6 && finalDispM2 >= minDispM2) {
		const finalDistHostM = Math.hypot(finalRelX_m, finalRelY_m);
		const finalDistHostPx = UnitConvertUtils.m2pix(finalDistHostM);
		const finalRotAngle = hostOmega * simTime;
		const finalInertialPhi = Math.atan2(finalRelY_m, finalRelX_m);
		const finalPhiSurf = finalInertialPhi - (hostInitRot + finalRotAngle);
		points.push({
			worldX: UnitConvertUtils.m2pix(rocket.x),
			worldY: UnitConvertUtils.m2pix(rocket.y),
			relX: UnitConvertUtils.m2pix(finalRelX_m),
			relY: UnitConvertUtils.m2pix(finalRelY_m),
			r: finalDistHostPx,
			phiSurf: finalPhiSurf,
			altM: finalDistHostM - hostBody.radius,
			time: simTime,
			domId: rocket.dominantBody ? rocket.dominantBody.id : hostBody.id
		});
	}

	// Register Max-Q event
	if (maxQSnapshot && !detectedEventsMap.has(maxQSnapshot.id)) {
		detectedEventsMap.set(maxQSnapshot.id, maxQSnapshot);
	}


	const events = Array.from(detectedEventsMap.values()).sort((a, b) => a.time - b.time);

	return {
		hostId: hostId,
		points: points,
		events: events,
		isOrbital: isOrbital,
		// The line is valid only over what was actually integrated (no extrapolated validity)
		maxSimTime: points[points.length - 1]?.time ?? simTime,
		maxAltM: maxAltM,
		maxQ: maxQPa,
		endReason: endReason,
		steps: stepCount,
		frameSwitchTime: frameSwitchTime,
		frameSwitchHostRot: frameSwitchHostRot,
		hostOmega: hostOmega
	};
}
