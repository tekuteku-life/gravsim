
// gravsim_flight_computer.js

import { PHYSICS, FLIGHT_COMPUTER_CONFIG, TELEMETRY, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
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
		this.flightProfile = config.flightProfile || [];
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
		};
	}

	_evaluateProfile(sensor) {
		let baseThrottle = 1.0;
		let relAngleDeg = 0;

		if (this.flightProfile.length === 0) {
			this._profileState.throttle = baseThrottle;
			this._profileState.relAngleDeg = relAngleDeg;
			return;
		}

		let currentIndex = -1;
		for (let i = 0; i < this.flightProfile.length; i++) {
			const step = this.flightProfile[i];
			const currentVal = step.type === 'time' ? this.flightTime : this.telemetryCache.altM;

			if (currentVal >= step.value) {
				currentIndex = i;
			} else {
				break;
			}
		}

		if (currentIndex === -1) {
			// Before the first step
			const firstStep = this.flightProfile[0];
			this._profileState.throttle = firstStep.thrust / 100;
			this._profileState.relAngleDeg = firstStep.angle;
			return;
		}

		if (currentIndex === this.flightProfile.length - 1) {
			// After the last step
			const lastStep = this.flightProfile[currentIndex];
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

		const currentVal = stepA.type === 'time' ? this.flightTime : this.telemetryCache.altM;
		const progress = Math.max(0, Math.min(1, (currentVal - stepA.value) / (stepB.value - stepA.value)));

		const throttleA = stepA.thrust / 100;
		const throttleB = stepB.thrust / 100;
		const angleA = stepA.angle;
		const angleB = stepB.angle;

		this._profileState.throttle = throttleA + (throttleB - throttleA) * progress;
		this._profileState.relAngleDeg = angleA + (angleB - angleA) * progress;
	}

	update(sensor) {
		if (!sensor.isHoldDown || this.flightTime > 0) {
			this.flightTime += sensor.dt;
		}

		this._updateTelemetry(sensor);
		this._evaluateProfile(sensor);

		// Apply profile state (Convert from relative to absolute angle for physics target)
		this.targetLaunchAngle = this.hostAngleRad + UnitConvertUtils.deg2rad(this._profileState.relAngleDeg);

		const thrustAngleRad = this._computeThrustAngle(sensor);
		this.currentThrustAngle = thrustAngleRad;
		const throttle = this._computeThrottle(sensor, this._profileState.throttle);

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
			if (sensor.massLossRate > 0 && sensor.fuelMass <= 0) {
				statusInt = TELEMETRY.STATUS.MECO;
			} else {
				statusInt = TELEMETRY.STATUS.COASTING;
			}
		}

		this.telemetryCache.status = statusInt;
		this.currentThrottle = throttle;
		this.currentThrustAngleRad = this.currentThrustAngle;
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
				const refParam = DEFAULT_OBJECT_PARAMS[sensor.refBody.name];
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
		if (sensor.dryMass > 0) {
			let ve = 320 * PHYSICS.G0; // m/s
			if (sensor.thrustForce > 0 && sensor.massLossRate > 0) {
				ve = sensor.thrustForce / sensor.massLossRate;
			}
			remDv = (ve * Math.log(sensor.mass / sensor.dryMass));
		}

		const refParam = sensor.refBody ? DEFAULT_OBJECT_PARAMS[sensor.refBody.name] : null;
		const isOutsideAtm = refParam && refParam.ATM_LIMIT_ALT ? altM >= refParam.ATM_LIMIT_ALT : false;

		const qAxialKpa = isOutsideAtm ? 0 : sensor.qAxialKpa;
		const qLateralKpa = isOutsideAtm ? 0 : sensor.qLateralKpa;

		this.telemetryCache.qAxialKpa = qAxialKpa;
		this.telemetryCache.qLateralKpa = qLateralKpa;
		this.telemetryCache.aoaDeg = sensor.aoaDeg;

		let structRatio = 0;
		if (!isOutsideAtm && this.config.maxQAxialLimit !== Infinity && this.config.maxQLateralLimit !== Infinity) {
			const isTailFirst = Math.cos(UnitConvertUtils.deg2rad(sensor.aoaDeg)) < 0;
			const effectiveAxialLimit = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;
			const axialRatio = UnitConvertUtils.kpa2pa(qAxialKpa) / effectiveAxialLimit;
			const lateralRatio = UnitConvertUtils.kpa2pa(qLateralKpa) / this.config.maxQLateralLimit;

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
			this.telemetryCache.twr = previousThrustN / (sensor.mass * localG_ms2);
		} else {
			this.telemetryCache.twr = 0;
		}
	}

	_computeThrottle(sensor, baseThrottle) {
		if (sensor.burnTime <= 0) { return 0.0; }

		let throttle = baseThrottle;

		// Max-G Limiter (Throttle down)
		if (this.config.maxGLimit > 0) {
			const maxAllowedThrust = this.config.maxGLimit * PHYSICS.G0 * sensor.mass;
			if (sensor.thrustForce > maxAllowedThrust) {
				throttle = Math.min(throttle, maxAllowedThrust / sensor.thrustForce);
			}
		}

		// Max-Q Auto-Throttle (Flight Computer Feedback)
		const refParam = sensor.refBody ? DEFAULT_OBJECT_PARAMS[sensor.refBody.name] : null;
		const isOutsideAtm = refParam && refParam.ATM_LIMIT_ALT ? this.telemetryCache.altM >= refParam.ATM_LIMIT_ALT : false;
		if (!isOutsideAtm && this.config.maxQAxialLimit !== Infinity) {
			const isTailFirst = Math.cos(UnitConvertUtils.deg2rad(this.telemetryCache.aoaDeg)) < 0;
			const effectiveAxialLimitPa = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;
			const qRatio = UnitConvertUtils.kpa2pa(sensor.qAxialKpa) / effectiveAxialLimitPa;

			if (!isTailFirst && qRatio > FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_Q_RATIO) {
				let qThrottle = 1.0 - (qRatio - FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_Q_RATIO) * 5.0;

				// Anti-stall
				const minThrottle = this.telemetryCache.vV < FLIGHT_COMPUTER_CONFIG.THROTTLE_DOWN_MIN_Vv ? 0.8 : 0.1;
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

		// Track prograde direction after thrust stops
		if (sensor.burnTime <= 0) {
			const turnDiff = MathUtils.normalizeAngle(progradeAngle - this.currentThrustAngle);
			const maxTurn = FLIGHT_COMPUTER_CONFIG.MAX_TURN_RATE_PER_SEC * sensor.dt;

			if (Math.abs(turnDiff) > maxTurn) {
				return this.currentThrustAngle + Math.sign(turnDiff) * maxTurn;
			} else {
				return progradeAngle;
			}
		}

		// Lock zenith angle while holding down
		if (sensor.isHoldDown) {
			return zenithAngle;
		}

		const Q = sensor.qAxialKpa + sensor.qLateralKpa; // kPa

		// Tower Clearance
		if (this.flightTime < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_TIME
			|| (Q < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MIN_Q
				&& this.telemetryCache.altM < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MAX_ALT)) {
			let diff = MathUtils.normalizeAngle(zenithAngle - this.currentThrustAngle);
			const maxTurn = FLIGHT_COMPUTER_CONFIG.PITCH_KICK_TURN_RATE * sensor.dt;

			if (Math.abs(diff) > maxTurn) {
				return this.currentThrustAngle + Math.sign(diff) * maxTurn;
			}
			return zenithAngle;
		}

		let targetAngle = this.targetLaunchAngle;

		// Load Relief Control
		if (Q > 0.05 && this.telemetryCache.vV < FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD) {
			const stallFactor = Math.max(0, (FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD - this.telemetryCache.vV) / FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD);
			const maxPitchUp = UnitConvertUtils.deg2rad(FLIGHT_COMPUTER_CONFIG.ANTI_STALL_MAX_PITCH_UP);
			const upAngle = this.telemetryCache.gravityAngle + Math.PI;
			let angleToUp = MathUtils.normalizeAngle(upAngle - targetAngle);

			targetAngle += Math.sign(angleToUp) * Math.min(Math.abs(angleToUp), maxPitchUp) * stallFactor;
		}

		const Q_Pa = UnitConvertUtils.kpa2pa(Q);
		let maxAoA = Math.PI;
		if (Q_Pa > 100 && this.config.maxQLateralLimit !== Infinity) {
			const safeLateralLimit = this.config.maxQLateralLimit * FLIGHT_COMPUTER_CONFIG.LOAD_RELIEF_SAFE_MARGIN;
			const sinSq = safeLateralLimit / Q_Pa;
			if (sinSq < 1.0) {
				maxAoA = Math.asin(Math.sqrt(sinSq));
			}
		}

		let angleDiff = MathUtils.normalizeAngle(targetAngle - progradeAngle);
		const isRetrogradeIntent = Math.abs(angleDiff) > Math.PI / 2;
		let safeTargetAngle;

		if (isRetrogradeIntent) {
			let retroDiff = angleDiff > 0 ? angleDiff - Math.PI : angleDiff + Math.PI;
			if (retroDiff > maxAoA) retroDiff = maxAoA;
			if (retroDiff < -maxAoA) retroDiff = -maxAoA;
			safeTargetAngle = progradeAngle + Math.PI + retroDiff;
		} else {
			// Clamp angle to max AoA
			if (angleDiff > maxAoA) { angleDiff = maxAoA; }
			if (angleDiff < -maxAoA) { angleDiff = -maxAoA; }

			safeTargetAngle = progradeAngle + angleDiff;
		}

		let turnDiff = MathUtils.normalizeAngle(safeTargetAngle - this.currentThrustAngle);

		// Limit pitch rate
		const maxTurnRatePerSec = FLIGHT_COMPUTER_CONFIG.MAX_TURN_RATE_PER_SEC; 
		const maxTurn = maxTurnRatePerSec * sensor.dt;

		if (Math.abs(turnDiff) > maxTurn) {
			return this.currentThrustAngle + Math.sign(turnDiff) * maxTurn;
		} else {
			return safeTargetAngle;
		}
	}

	getTelemetry() { return this.telemetryCache; }
}
