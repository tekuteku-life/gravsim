
// gravsim_flight_computer.js

import { PHYSICS, FLIGHT_COMPUTER_CONFIG, TELEMETRY, SIMULATION } from './gravsim_const.js';
import { MathUtils, UnitConvertUtils } from './gravsim_utils.js';

export class FlightComputer {
	constructor(config = {}) {
		this.config = {
			maxGLimit: config.maxGLimit || Infinity,
			maxQAxialLimit: config.maxQAxialLimit || Infinity, // Pa
			maxQLateralLimit: config.maxQLateralLimit || Infinity, // Pa
		};

		this.currentThrustAngle = config.thrustAngle || 0;
		this.targetLaunchAngle = this.currentThrustAngle;
		this.flightTime = 0;
		// Only object rows with finite value/thrust/angle are steps: a null/primitive row or a row whose numbers are
		// missing or non-finite (e.g. from a corrupted save) must neither throw nor command a NaN throttle/angle in the Worker
		this.flightProfile = Array.isArray(config.flightProfile)
			? config.flightProfile.filter(step => step !== null && typeof step === 'object' && Number.isFinite(step.value) && Number.isFinite(step.thrust) && Number.isFinite(step.angle))
			: [];
		this.hostAngleRad = config.hostAngleRad || 0;

		// Optimization: Retain result output locally to prevent returning objects on hot path
		this.currentThrottle = 1.0;
		this.currentThrustAngleRad = this.currentThrustAngle;
		this._profileState = { throttle: 1.0, relAngleDeg: 0 };

		this.maxRecordedQ = 0; // kPa
		this.hasPassedMaxQ = false;
		this.maxQConfirmTimer = 0; // s
		this.maxQStatusTimer = 0; // s

		this.telemetryCache = {
			status: TELEMETRY.STATUS.PRE_LAUNCH,
			qAxialKpa: 0,
			qLateralKpa: 0,
			structRatio: 0,
			currentG: 0,
			aoaDeg: 0,
			progradeAngle: 0,
			gravityAngle: 0,
			remDv: 0,
			twr: 0,
			altM: 0,
			vV: 0, // m/s
			vH: 0, // m/s
			aV: 0, // G
			aH: 0, // G
			isAntiStallActive: false,
			isQLimitNear: false,
			isGLimitNear: false,
			mach: 0,
			rcsCw: false,
			rcsCcw: false,
			rcsUllage: false,
		};
		this._isAntiStallActive = false;
		this.hasPassedApogee = false;
		this.apogeeTime = null;
		this._prevVv = 0;
		this._highestStepIndex = -1;
		this._triggeredActionIndices = new Set();
		this._pendingActions = [];
		this.desiredThrustAngleRad = this.currentThrustAngle || 0;
		// Orbit targets come from the constructor config (CalcRocket passes them, design §3.4-1); update() refreshes them from the sensor
		this.targetApogeeKm = Number(config.targetApogeeKm) || 0;
		this.targetPerigeeKm = Number(config.targetPerigeeKm) || 0;
		this.disableOrbitalCutoff = Boolean(config.disableOrbitalCutoff);
	}

	/**
	 * Single source of truth for the measured quantity of each flight-profile trigger type.
	 * @param {string} type 'time' | 'alt' | 'vel' | 'apogee'
	 * @returns {number} current value, or NaN for unknown types / apogee not yet passed
	 */
	getTriggerValue(type) {
		if (type === 'time') {
			return this.flightTime;
		} else if (type === 'alt') {
			return this.telemetryCache.altM || 0;
		} else if (type === 'vel') {
			return Math.hypot(this.telemetryCache.vV || 0, this.telemetryCache.vH || 0);
		} else if (type === 'apogee') {
			return this.hasPassedApogee ? (this.flightTime - (this.apogeeTime || 0)) : NaN;
		}
		return NaN;
	}

	_isStepTriggered(step) {
		if (!step) return false;
		const cur = this.getTriggerValue(step.type);
		return Number.isFinite(cur) && cur >= (step.value || 0);
	}

	/**
	 * True when a profile row not yet reached by the sequential latch (_highestStepIndex) still
	 * commands thrust, i.e. the current zero-throttle phase is a coast rather than the final cutoff.
	 * Rows are reached strictly in order, so a later row counts as pending even if its own trigger
	 * condition is already met while an earlier row is still blocking.
	 */
	hasPendingBurnStep() {
		if (!Array.isArray(this.flightProfile)) return false;
		for (let i = Math.max(0, this._highestStepIndex + 1); i < this.flightProfile.length; i++) {
			const step = this.flightProfile[i];
			if (step && step.thrust > 0) return true;
		}
		return false;
	}

	hasScheduledAction(actionName) {
		if (!actionName || !Array.isArray(this.flightProfile)) return false;
		for (let i = 0; i < this.flightProfile.length; i++) {
			if (!this._triggeredActionIndices.has(i) && this.flightProfile[i]?.action === actionName) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Serializable runtime state (save/load). Kinematic telemetry is re-derived on the next update.
	 */
	getRuntimeState() {
		return {
			flightTime: this.flightTime,
			targetLaunchAngle: this.targetLaunchAngle,
			highestStepIndex: this._highestStepIndex,
			triggeredActionIndices: Array.from(this._triggeredActionIndices),
			pendingActions: this._pendingActions.slice(),
			hasPassedApogee: this.hasPassedApogee,
			apogeeTime: this.apogeeTime,
			prevVv: this._prevVv,
			maxRecordedQ: this.maxRecordedQ,
			hasPassedMaxQ: this.hasPassedMaxQ,
			maxQConfirmTimer: this.maxQConfirmTimer,
			maxQStatusTimer: this.maxQStatusTimer,
			// Rev 6.11 (G3-1-01): the rate-limited attitude command (the rocket's thrustAngle is re-synced to the pad during
			// hold-down, so it is not the same value) and the anti-stall flag, which coast phases do not reset
			currentThrustAngle: this.currentThrustAngle,
			isAntiStallActive: this._isAntiStallActive
		};
	}

	/** @param {any} state value previously produced by getRuntimeState() */
	restoreRuntimeState(state) {
		if (!state || typeof state !== 'object') return;
		const maxT = SIMULATION.RUNTIME_RESTORE_MAX_TIME_S;
		const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
		const time = (v) => Math.min(maxT, Math.max(0, num(v, 0)));
		const profile = Array.isArray(this.flightProfile) ? this.flightProfile : [];
		const profileLen = profile.length;
		this.flightTime = time(state.flightTime);
		this.targetLaunchAngle = num(state.targetLaunchAngle, this.targetLaunchAngle);
		this._highestStepIndex = Math.max(-1, Math.min(profileLen - 1, Math.trunc(num(state.highestStepIndex, -1))));
		// Only rows of this profile that carry an action can be latched
		this._triggeredActionIndices = new Set(
			(Array.isArray(state.triggeredActionIndices) ? state.triggeredActionIndices : [])
				.filter(i => Number.isInteger(i) && i >= 0 && i < profileLen && Boolean(profile[i]?.action))
		);
		// A pending (latched but not yet executed) action must belong to a latched row: consume one row per entry
		const latchedActionBudget = new Map();
		for (const i of this._triggeredActionIndices) {
			const a = profile[i].action;
			latchedActionBudget.set(a, (latchedActionBudget.get(a) || 0) + 1);
		}
		this._pendingActions = [];
		for (const a of (Array.isArray(state.pendingActions) ? state.pendingActions : [])) {
			const left = latchedActionBudget.get(a) || 0;
			if (typeof a === 'string' && left > 0) {
				this._pendingActions.push(a);
				latchedActionBudget.set(a, left - 1);
			}
		}
		this.hasPassedApogee = Boolean(state.hasPassedApogee);
		this.apogeeTime = (this.hasPassedApogee && Number.isFinite(state.apogeeTime)) ? time(state.apogeeTime) : null;
		this._prevVv = num(state.prevVv, 0);
		this.maxRecordedQ = Math.max(0, num(state.maxRecordedQ, 0));
		this.hasPassedMaxQ = Boolean(state.hasPassedMaxQ);
		this.maxQConfirmTimer = time(state.maxQConfirmTimer);
		this.maxQStatusTimer = time(state.maxQStatusTimer);
		// Optional (saves before Rev 6.11 keep the constructor's value, i.e. the saved thrustAngle)
		if (Number.isFinite(state.currentThrustAngle)) {
			this.currentThrustAngle = state.currentThrustAngle;
			this.currentThrustAngleRad = state.currentThrustAngle;
		}
		if (typeof state.isAntiStallActive === 'boolean') { this._isAntiStallActive = state.isAntiStallActive; }
	}

	consumePendingActions() {
		if (!this._pendingActions || this._pendingActions.length === 0) return [];
		return this._pendingActions.splice(0, this._pendingActions.length);
	}

	_evaluateProfile(sensor) {
		let baseThrottle = 1.0;
		let relAngleDeg = 0;

		if (!this.flightProfile || this.flightProfile.length === 0) {
			this._profileState.throttle = baseThrottle;
			this._profileState.relAngleDeg = relAngleDeg;
			return;
		}

		let currentIndex = this._highestStepIndex;
		for (let i = Math.max(0, this._highestStepIndex + 1); i < this.flightProfile.length; i++) {
			const step = this.flightProfile[i];
			if (this._isStepTriggered(step)) {
				currentIndex = i;
				this._highestStepIndex = i;
				if (step.action && !this._triggeredActionIndices.has(i)) {
					this._triggeredActionIndices.add(i);
					this._pendingActions.push(step.action);
				}
			} else {
				break;
			}
		}

		// Independent latch: also fire any later explicit action rows whose trigger is already met
		for (let j = Math.max(0, this._highestStepIndex + 1); j < this.flightProfile.length; j++) {
			const laterStep = this.flightProfile[j];
			if (laterStep?.action && !this._triggeredActionIndices.has(j) && this._isStepTriggered(laterStep)) {
				this._triggeredActionIndices.add(j);
				this._pendingActions.push(laterStep.action);
			}
		}

		if (currentIndex <= -1) {
			// Before the first step
			const firstStep = this.flightProfile[0];
			this._profileState.throttle = firstStep.thrust / 100;
			this._profileState.relAngleDeg = firstStep.angle;
			return;
		}

		if (currentIndex >= this.flightProfile.length - 1) {
			// After the last step
			const lastStep = this.flightProfile[this.flightProfile.length - 1];
			this._profileState.throttle = lastStep.thrust / 100;
			this._profileState.relAngleDeg = lastStep.angle;
			return;
		}

		// Interpolate between currentIndex and currentIndex + 1
		const stepA = this.flightProfile[currentIndex];
		const stepB = this.flightProfile[currentIndex + 1];

		if (stepA.type !== stepB.type) {
			this._profileState.throttle = stepA.thrust / 100;
			this._profileState.relAngleDeg = stepA.angle;
			return;
		}

		const rawVal = this.getTriggerValue(stepA.type);
		const currentVal = Number.isFinite(rawVal) ? rawVal : 0;

		const progress = (stepB.value !== stepA.value)
			? Math.max(0, Math.min(1, (currentVal - stepA.value) / (stepB.value - stepA.value)))
			: 1;

		const throttleA = stepA.thrust / 100;
		const throttleB = stepB.thrust / 100;
		const angleA = stepA.angle;
		const angleB = stepB.angle;

		if (stepA.thrust === 0 && stepB.thrust > 0) {
			this._profileState.throttle = 0;
		} else {
			this._profileState.throttle = throttleA + (throttleB - throttleA) * progress;
		}
		this._profileState.relAngleDeg = angleA + (angleB - angleA) * progress;
	}

	update(sensor) {
		if (sensor.targetApogeeKm !== undefined) this.targetApogeeKm = Number(sensor.targetApogeeKm) || 0;
		if (sensor.targetPerigeeKm !== undefined) this.targetPerigeeKm = Number(sensor.targetPerigeeKm) || 0;
		if (sensor.disableOrbitalCutoff !== undefined) this.disableOrbitalCutoff = Boolean(sensor.disableOrbitalCutoff);

		if (!sensor.isHoldDown || this.flightTime > 0) {
			this.flightTime += sensor.dt;
		}

		this._updateTelemetry(sensor);

		// Detect Apogee passage outside atmosphere (independent of remaining propellant)
		if (!sensor.isHoldDown && !this.hasPassedApogee && this.telemetryCache.altM >= FLIGHT_COMPUTER_CONFIG.APOGEE_MIN_ALT_M) {
			if (this._prevVv > 0 && this.telemetryCache.vV <= 0) {
				this.hasPassedApogee = true;
				this.apogeeTime = this.flightTime;
			}
		}
		this._prevVv = this.telemetryCache.vV;

		this._evaluateProfile(sensor);

		// Apply profile state relative to instantaneous local zenith angle (dynamic attitude guidance)
		const localZenithRad = (sensor.refBody && sensor.distToRefM > 0)
			? MathUtils.normalizeAngle(this.telemetryCache.gravityAngle + Math.PI)
			: this.hostAngleRad;
		this.targetLaunchAngle = localZenithRad + UnitConvertUtils.deg2rad(this._profileState.relAngleDeg);

		const thrustAngleRad = this._computeThrustAngle(sensor);
		this.currentThrustAngle = thrustAngleRad;
		let throttle = 0;
		if (sensor.stageState === 'ORBITAL_COAST') {
			this.currentThrottle = 0;
		} else {
			throttle = this._computeThrottle(sensor, this._profileState.throttle);
		}

		// Peak hold and confirmation check for Max-Q pass detection
		if (!sensor.isHoldDown && !this.hasPassedMaxQ) {
			const totalQ = sensor.qAxialKpa + sensor.qLateralKpa; // kPa
			const minQ = FLIGHT_COMPUTER_CONFIG.MAX_Q_MIN_PRESSURE_KPA || 1.0;

			if (totalQ > this.maxRecordedQ) {
				this.maxRecordedQ = totalQ;
				this.maxQConfirmTimer = 0;
			} else if (this.maxRecordedQ >= minQ) {
				const dropRatio = (this.maxRecordedQ - totalQ) / this.maxRecordedQ;
				if (dropRatio >= FLIGHT_COMPUTER_CONFIG.MAX_Q_PEAK_DROP_RATIO) {
					this.maxQConfirmTimer += sensor.dt;
					if (this.maxQConfirmTimer >= FLIGHT_COMPUTER_CONFIG.MAX_Q_CONFIRM_DELAY_SEC) {
						this.hasPassedMaxQ = true;
					}
				}
			}
		}

		// Decide mission status
		let statusInt = TELEMETRY.STATUS.PRE_LAUNCH;
		if (sensor.isHoldDown) {
			statusInt = TELEMETRY.STATUS.PRE_LAUNCH;
		} else if (this.hasPassedMaxQ && this.maxQStatusTimer < FLIGHT_COMPUTER_CONFIG.MAX_Q_KEEP_DURATION_SEC) {
			this.maxQStatusTimer += sensor.dt;
			statusInt = TELEMETRY.STATUS.MAX_Q;
		} else if (sensor.burnTime > 0 && throttle > 0) {
			statusInt = TELEMETRY.STATUS.ASCENT;
		} else if (this.flightTime > 0) {
			if (sensor.burnTime <= 0 || sensor.fuelMass <= 0) {
				statusInt = TELEMETRY.STATUS.MECO;
			} else {
				statusInt = TELEMETRY.STATUS.COASTING;
			}
		}

		this.telemetryCache.status = statusInt;
		this.currentThrottle = throttle;
		this.currentThrustAngleRad = this.currentThrustAngle;

		// Annunciator indicator flags
		const gRatioTh = TELEMETRY.ANNUNCIATOR?.G_LIM_RATIO || 0.85;
		const isGLimitNear = (this.config.maxGLimit > 0 && this.config.maxGLimit !== Infinity)
			&& (this.telemetryCache.currentG >= this.config.maxGLimit * gRatioTh);

		const qLimitTh = TELEMETRY.ANNUNCIATOR?.Q_LIM_TH || 75;
		const isQLimitNear = (this.telemetryCache.structRatio >= qLimitTh)
			|| (statusInt === TELEMETRY.STATUS.MAX_Q);

		this.telemetryCache.isAntiStallActive = this._isAntiStallActive;
		this.telemetryCache.isQLimitNear = isQLimitNear;
		this.telemetryCache.isGLimitNear = isGLimitNear;
	}

	_updateTelemetry(sensor) {
		let altM = 0; // m
		let vV = 0, vH = 0, aV = 0, aH = 0;
		let gravityAngle = 0;
		let localG_ms2 = 0;

		if (sensor.refBody) {
			localG_ms2 = (PHYSICS.G * sensor.refBody.mass) / Math.pow(sensor.distToRefM, 2);
			altM = sensor.distToRefM - sensor.refBody.radius;

			const dx = sensor.x - sensor.refBody.x; // m
			const dy = sensor.y - sensor.refBody.y; // m

			if (sensor.distToRefM > 0) {
				const uRx = dx / sensor.distToRefM;
				const uRy = dy / sensor.distToRefM;
				const uHx = -uRy;
				const uHy = uRx;

				// Calculate surface relative velocity
				let hostVx = sensor.refBody.vx; // m/s
				let hostVy = sensor.refBody.vy; // m/s
				const refParam = sensor.refBody.param || (typeof globalThis !== 'undefined' && globalThis.__presetManager ? globalThis.__presetManager.getObjectParam(sensor.refBody.name) : null);
				if (refParam && refParam.ROTATION_PERIOD) {
					const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD;
					hostVx += -omega * dy;
					hostVy += omega * dx;
				}

				const dvx = sensor.vx - hostVx; // m/s
				const dvy = sensor.vy - hostVy; // m/s

				vV = dvx * uRx + dvy * uRy;
				vH = dvx * uHx + dvy * uHy;
				aV = sensor.ax * uRx + sensor.ay * uRy;
				aH = sensor.ax * uHx + sensor.ay * uHy;
				gravityAngle = Math.atan2(-dy, -dx);
			}
		}

		const totalAccel = Math.sqrt(sensor.ax * sensor.ax + sensor.ay * sensor.ay);
		const currentG = totalAccel / PHYSICS.G0;

		let remDv = 0; // m/s
		const curProp = sensor.fuelMass || 0; // t (contains fuelMass + oxidMass)
		const curBurnoutMass = sensor.mass - curProp; // t

		let ve = FLIGHT_COMPUTER_CONFIG.DEFAULT_ISP * PHYSICS.G0; // m/s
		if (sensor.mass > 0 && curBurnoutMass > 0 && curProp > 0) {
			if (sensor.thrustForce > 0 && sensor.massLossRate > 0) {
				ve = sensor.thrustForce / (sensor.massLossRate * 1000); // massLossRate is in t/s, convert to kg/s
			}
			remDv += ve * Math.log(sensor.mass / curBurnoutMass);
		}

		// If multi-stage, accumulate delta-V of remaining upper stages
		if (sensor.stages && sensor.stages.length > 0 && sensor.stageIndex !== undefined) {
			const curStg = sensor.stages[sensor.stageIndex];
			let nextStageStackMass = curBurnoutMass - (curStg ? (curStg.dryMassT || 0) : 0);

			for (let i = sensor.stageIndex + 1; i < sensor.stages.length; i++) {
				const stg = sensor.stages[i];
				const stgProp = (stg.fuelMassT || 0) + (stg.oxidMassT || 0);
				const stgBurnoutMass = nextStageStackMass - stgProp;

				if (nextStageStackMass > 0 && stgBurnoutMass > 0 && stgProp > 0) {
					const stgVe = (stg.ispVac || stg.isp || FLIGHT_COMPUTER_CONFIG.DEFAULT_ISP) * PHYSICS.G0;
					remDv += stgVe * Math.log(nextStageStackMass / stgBurnoutMass);
				}
				nextStageStackMass = stgBurnoutMass - (stg.dryMassT || 0);
			}
		}

		this.telemetryCache.ambientPresRatio = sensor.ambientPresRatio !== undefined ? sensor.ambientPresRatio : 0;
		this.telemetryCache.currentIsp = sensor.currentIsp !== undefined ? sensor.currentIsp : Math.round(ve / PHYSICS.G0);
		this.telemetryCache.qAxialKpa = sensor.qAxialKpa;
		this.telemetryCache.qLateralKpa = sensor.qLateralKpa;
		this.telemetryCache.aoaDeg = sensor.aoaDeg;

		let structRatio = 0;
		if (this.config.maxQAxialLimit !== Infinity && this.config.maxQLateralLimit !== Infinity) {
			const isTailFirst = Math.cos(UnitConvertUtils.deg2rad(sensor.aoaDeg)) < 0;
			const effectiveAxialLimit = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;
			const axialRatio = UnitConvertUtils.kpa2pa(sensor.qAxialKpa) / effectiveAxialLimit;
			const lateralRatio = UnitConvertUtils.kpa2pa(sensor.qLateralKpa) / this.config.maxQLateralLimit;

			structRatio = Math.max(axialRatio, lateralRatio) * 100;
		}

		this.telemetryCache.structRatio = structRatio;
		this.telemetryCache.altM = altM;
		this.telemetryCache.vV = vV;
		this.telemetryCache.vH = vH;
		this.telemetryCache.aV = aV / PHYSICS.G0;
		this.telemetryCache.aH = aH / PHYSICS.G0;
		this.telemetryCache.progradeAngle = sensor.progradeAngle;
		this.telemetryCache.gravityAngle = gravityAngle;
		this.telemetryCache.remDv = remDv;
		this.telemetryCache.currentG = currentG;

		if (localG_ms2 > 0) {
			const previousThrustN = sensor.thrustForce * sensor.thrustRatio;
			this.telemetryCache.twr = previousThrustN / (UnitConvertUtils.ton2kg(sensor.mass) * localG_ms2);
		} else {
			this.telemetryCache.twr = 0;
		}
	}

	_computeThrottle(sensor, baseThrottle) {
		if (sensor.burnTime <= 0) { return 0.0; }

		let throttle = baseThrottle;

		// Max-G Limiter (Throttle down)
		if (this.config.maxGLimit > 0) {
			const maxAllowedThrust = this.config.maxGLimit * PHYSICS.G0 * UnitConvertUtils.ton2kg(sensor.mass);
			if (sensor.thrustForce > maxAllowedThrust) {
				throttle = Math.min(throttle, maxAllowedThrust / sensor.thrustForce);
			}
		}

		// Max-Q Auto-Throttle (Flight Computer Feedback)
		if (this.config.maxQAxialLimit !== Infinity) {
			const isTailFirst = Math.cos(UnitConvertUtils.deg2rad(this.telemetryCache.aoaDeg)) < 0;
			const effectiveAxialLimitPa = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;
			const qRatio = UnitConvertUtils.kpa2pa(sensor.qAxialKpa) / effectiveAxialLimitPa;

			if (!isTailFirst && qRatio > FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_Q_RATIO) {
				let qThrottle = 1.0 - (qRatio - FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_Q_RATIO) * FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_SENSITIVITY;

				// Anti-stall
				const minThrottle = this.telemetryCache.vV < FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_MIN_Vv
					? FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_MIN_THROTTLE_LOW_VV
					: FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_MIN_THROTTLE_NORMAL;
				qThrottle = Math.max(minThrottle, Math.min(1.0, qThrottle));
				throttle = Math.min(throttle, qThrottle);
			}
		}

		return throttle;
	}

	_computeThrustAngle(sensor) {
		this.currentThrustAngle = MathUtils.normalizeAngle(this.currentThrustAngle);
		const progradeAngle = this.telemetryCache.progradeAngle;
		const zenithAngle = MathUtils.normalizeAngle(this.telemetryCache.gravityAngle + Math.PI);

		// After thrust stops (coasting/interstage/orbital phase)
		if (sensor.burnTime <= 0 || sensor.stageState === 'INTERSTAGE_COAST' || sensor.stageState === 'ORBITAL_COAST') {
			// If payload has separated, orient attitude towards the Sun for solar panel charging
			if (sensor.isPayloadSeparated && sensor.sunX !== undefined && sensor.sunY !== undefined) {
				const dx = sensor.sunX - sensor.x;
				const dy = sensor.sunY - sensor.y;
				if (dx * dx + dy * dy > FLIGHT_COMPUTER_CONFIG.MIN_SUN_DIST_SQ) {
					const sunAngle = Math.atan2(dy, dx);
					this.desiredThrustAngleRad = sunAngle;
					const turnDiff = MathUtils.normalizeAngle(sunAngle - this.currentThrustAngle);
					const sunTurnRate = FLIGHT_COMPUTER_CONFIG.SUN_POINTING_TURN_RATE_PER_SEC;
					const maxTurn = sunTurnRate * sensor.dt;

					if (Math.abs(turnDiff) > maxTurn) {
						return MathUtils.normalizeAngle(this.currentThrustAngle + Math.sign(turnDiff) * maxTurn);
					} else {
						return sunAngle;
					}
				}
			}

			// Otherwise track prograde direction smoothly (rocket coasting)
			this.desiredThrustAngleRad = progradeAngle;
			const turnDiff = MathUtils.normalizeAngle(progradeAngle - this.currentThrustAngle);
			const coastTurnRate = FLIGHT_COMPUTER_CONFIG.COAST_TURN_RATE_PER_SEC;
			const maxTurn = coastTurnRate * sensor.dt;

			if (Math.abs(turnDiff) > maxTurn) {
				return MathUtils.normalizeAngle(this.currentThrustAngle + Math.sign(turnDiff) * maxTurn);
			} else {
				return progradeAngle;
			}
		}

		// Lock zenith angle while holding down
		if (sensor.isHoldDown) {
			this.desiredThrustAngleRad = zenithAngle;
			return zenithAngle;
		}

		const Q = sensor.qAxialKpa + sensor.qLateralKpa; // kPa

		// Tower Clearance: vertical ascent only within first 10s AND under 1000m
		if (this.flightTime < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_TIME
			&& this.telemetryCache.altM < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MAX_ALT) {
			this.desiredThrustAngleRad = zenithAngle;
			let diff = MathUtils.normalizeAngle(zenithAngle - this.currentThrustAngle);
			const maxTurn = FLIGHT_COMPUTER_CONFIG.PITCH_KICK_TURN_RATE * sensor.dt;

			if (Math.abs(diff) > maxTurn) {
				return MathUtils.normalizeAngle(this.currentThrustAngle + Math.sign(diff) * maxTurn);
			}
			return zenithAngle;
		}

		let targetAngle = this.targetLaunchAngle;

		this._isAntiStallActive = false;

		// Load Relief Control
		if (Q > FLIGHT_COMPUTER_CONFIG.ANTI_STALL_MIN_Q_KPA && this.telemetryCache.vV < FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD) {
			const stallFactor = Math.max(0, (FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD - this.telemetryCache.vV) / FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD);
			if (stallFactor > FLIGHT_COMPUTER_CONFIG.ANTI_STALL_FACTOR_THRESHOLD) {
				this._isAntiStallActive = true;
			}
			const maxPitchUp = UnitConvertUtils.deg2rad(FLIGHT_COMPUTER_CONFIG.ANTI_STALL_MAX_PITCH_UP);
			const upAngle = this.telemetryCache.gravityAngle + Math.PI;
			let angleToUp = MathUtils.normalizeAngle(upAngle - targetAngle);

			targetAngle += Math.sign(angleToUp) * Math.min(Math.abs(angleToUp), maxPitchUp) * stallFactor;
		}

		const Q_Pa = UnitConvertUtils.kpa2pa(Q);
		let maxAoA = Math.PI;
		if (Q_Pa > FLIGHT_COMPUTER_CONFIG.LOAD_RELIEF_MIN_Q_PA && this.config.maxQLateralLimit !== Infinity) {
			const safeLateralLimit = this.config.maxQLateralLimit * FLIGHT_COMPUTER_CONFIG.LOAD_RELIEF_SAFE_MARGIN;
			const sinSq = safeLateralLimit / Q_Pa;
			if (sinSq < 1.0) {
				maxAoA = Math.asin(Math.sqrt(sinSq));
			}
		}

		let angleDiff = MathUtils.normalizeAngle(targetAngle - progradeAngle);

		// Clamp angle within safe AoA limit relative to prograde without 180-deg flip
		if (Math.abs(angleDiff) > maxAoA + FLIGHT_COMPUTER_CONFIG.AOA_TOLERANCE_RAD) {
			this._isAntiStallActive = true;
		}
		if (angleDiff > maxAoA) { angleDiff = maxAoA; }
		if (angleDiff < -maxAoA) { angleDiff = -maxAoA; }

		let safeTargetAngle = MathUtils.normalizeAngle(progradeAngle + angleDiff);

		// Inertial ORBIT_ASSIST Closed-Loop Terminal Guidance (Circular / Near-Circular Targets)
		const isCircularTarget = Boolean(this.targetApogeeKm > 0 && this.targetPerigeeKm > 0 && (this.targetApogeeKm / this.targetPerigeeKm) <= 1.5);
		if (isCircularTarget && !this.disableOrbitalCutoff && sensor.stageState === 'STG_BURNING' && sensor.refBody && sensor.refBody.mass > 0) {
			const dx = sensor.x - sensor.refBody.x;
			const dy = sensor.y - sensor.refBody.y;
			const r = Math.hypot(dx, dy);
			if (r > sensor.refBody.radius) {
				const dvx = sensor.vx - sensor.refBody.vx;
				const dvy = sensor.vy - sensor.refBody.vy;
				const uRx = dx / r;
				const uRy = dy / r;
				const vr = dvx * uRx + dvy * uRy;
				const vHx = dvx - vr * uRx;
				const vHy = dvy - vr * uRy;
				const vHMag = Math.hypot(vHx, vHy);
				const altM = r - sensor.refBody.radius;
				const GM = PHYSICS.G * sensor.refBody.mass;
				const vSq = dvx * dvx + dvy * dvy;
				const E = 0.5 * vSq - GM / r;
				const h = dx * dvy - dy * dvx;
				const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
				const apKm = E < 0 ? (((-GM / (2 * E)) * (1 + ecc)) - sensor.refBody.radius) / 1000 : Infinity;

				if (altM >= 140000 && vHMag >= 4200 && (apKm >= this.targetApogeeKm * 0.88 || E >= 0)) {
					const uHx = vHx / vHMag;
					const uHy = vHy / vHMag;
					const rTgt = sensor.refBody.radius + ((this.targetApogeeKm + this.targetPerigeeKm) * 0.5) * 1000;
					const apOver = Number.isFinite(apKm) ? Math.max(0, (apKm - this.targetApogeeKm) * 1000) : Math.max(0, altM);
					const vrTgt = Math.max(-85, Math.min(14, ((rTgt - r) - 1.1 * apOver) / 130));
					const gammaCmd = Math.max(-0.30, Math.min(0.45, (vrTgt - vr) / 650));
					const tx = Math.cos(gammaCmd) * uHx + Math.sin(gammaCmd) * uRx;
					const ty = Math.cos(gammaCmd) * uHy + Math.sin(gammaCmd) * uRy;
					safeTargetAngle = Math.atan2(ty, tx);
				}
			}
		}

		this.desiredThrustAngleRad = safeTargetAngle;

		let turnDiff = MathUtils.normalizeAngle(safeTargetAngle - this.currentThrustAngle);

		// Limit pitch rate
		const maxTurnRatePerSec = FLIGHT_COMPUTER_CONFIG.MAX_TURN_RATE_PER_SEC; 
		const maxTurn = maxTurnRatePerSec * sensor.dt;

		if (Math.abs(turnDiff) > maxTurn) {
			return MathUtils.normalizeAngle(this.currentThrustAngle + Math.sign(turnDiff) * maxTurn);
		} else {
			return safeTargetAngle;
		}
	}

	updateGuidance(dt, sensor, alt) {
		if (sensor) {
			sensor.dt = dt;
			if (sensor.accel !== undefined && sensor.ax === undefined && sensor.ay === undefined) {
				sensor.ax = sensor.accel;
				sensor.ay = 0;
			}
			return this.update(sensor);
		}
	}

	getTelemetry() { return this.telemetryCache; }
}
