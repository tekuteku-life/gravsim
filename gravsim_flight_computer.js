
// gravsim_flight_computer.js

import { PHYSICS, FLIGHT_COMPUTER_CONFIG, TELEMETRY, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
import { MathUtils } from './gravsim_utils.js';

export class FlightComputer {
	constructor(config = {}) {
		this.config = {
			maxGLimit: config.maxGLimit || Infinity,
			maxQAxialLimit: config.maxQAxialLimit || Infinity, // Pa
			maxQLateralLimit: config.maxQLateralLimit || Infinity, // Pa
		};

		this.currentThrustAngle = config.thrustAngle || 0;
		this.initialThrustAngle = this.currentThrustAngle;
		this.flightTime = 0;
		
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

	update(sensor) {
		if (!sensor.isHoldDown || this.flightTime > 0) {
			this.flightTime += sensor.dt;
		}

		this._updateTelemetry(sensor);

		const thrustAngleRad = this._computeThrustAngle(sensor);
		this.currentThrustAngle = thrustAngleRad;

		const throttle = this._computeThrottle(sensor);

		// Decide mission status
		let statusInt = TELEMETRY.STATUS.PRE_LAUNCH;
		if (sensor.isHoldDown) {
			statusInt = TELEMETRY.STATUS.PRE_LAUNCH;
		} else if (sensor.burnTime > 0) {
			if (this.telemetryCache.structRatio > TELEMETRY.MAX_Q_TH) {
				statusInt = TELEMETRY.STATUS.MAX_Q;
			} else {
				statusInt = TELEMETRY.STATUS.ASCENT;
			}
		} else if (this.flightTime > 0) {
			if (sensor.massLossRate > 0 && sensor.fuelMass <= 0) {
				statusInt = TELEMETRY.STATUS.MECO;
			} else {
				statusInt = TELEMETRY.STATUS.COASTING;
			}
		}
		this.telemetryCache.status = statusInt;

		return {
			throttle: throttle,
			thrustAngleRad: this.currentThrustAngle,
		};
	}

	_updateTelemetry(sensor) {
		let altM = 0;
		let vV = 0, vH = 0, aV = 0, aH = 0;
		let gravityAngle = 0;
		let localG_ms2 = 0;

		if (sensor.refBody) {
			localG_ms2 = (PHYSICS.G * sensor.refBody.mass) / Math.pow(sensor.distToRefM, 2);
			altM = sensor.distToRefM - sensor.refBody.radius;

			const dx = sensor.x - sensor.refBody.x;
			const dy = sensor.y - sensor.refBody.y;

			if (sensor.distToRefM > 0) {
				const uRx = dx / sensor.distToRefM;
				const uRy = dy / sensor.distToRefM;
				const uHx = -uRy;
				const uHy = uRx;

				// Calculate surface relative velocity
				let hostVx = sensor.refBody.vx;
				let hostVy = sensor.refBody.vy;
				const refParam = DEFAULT_OBJECT_PARAMS[sensor.refBody.name];
				if (refParam && refParam.ROTATION_PERIOD) {
					const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD;
					hostVx += -omega * dy;
					hostVy += omega * dx;
				}

				const dvx = sensor.vx - hostVx;
				const dvy = sensor.vy - hostVy;
				vV = dvx * uRx + dvy * uRy;
				vH = dvx * uHx + dvy * uHy;

				aV = sensor.ax * uRx + sensor.ay * uRy;
				aH = sensor.ax * uHx + sensor.ay * uHy;
				
				gravityAngle = Math.atan2(-dy, -dx);
			}
		}

		const totalAccel = Math.sqrt(sensor.ax * sensor.ax + sensor.ay * sensor.ay);
		const currentG = totalAccel / PHYSICS.G0;

		let remDv = 0;
		if (sensor.dryMass > 0) {
			let ve = 320 * PHYSICS.G0; 
			if (sensor.thrustForce > 0 && sensor.massLossRate > 0) {
				ve = sensor.thrustForce / sensor.massLossRate;
			}
			remDv = (ve * Math.log(sensor.mass / sensor.dryMass));
		}

		this.telemetryCache.qAxialKpa = sensor.qAxialKpa;
		this.telemetryCache.qLateralKpa = sensor.qLateralKpa;
		this.telemetryCache.aoaDeg = sensor.aoaDeg;
		
		let structRatio = 0;
		if (this.config.maxQAxialLimit !== Infinity && this.config.maxQLateralLimit !== Infinity) {
			const isTailFirst = Math.cos(sensor.aoaDeg * Math.PI / 180) < 0;
			const effectiveAxialLimit = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;

			const axialRatio = (sensor.qAxialKpa * 1000) / effectiveAxialLimit;
			const lateralRatio = (sensor.qLateralKpa * 1000) / this.config.maxQLateralLimit;
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

	_computeThrottle(sensor) {
		if (sensor.burnTime <= 0) { return 0.0; }
		let throttle = 1.0;

		// Max-G Limiter (Throttle down)
		if (this.config.maxGLimit > 0) {
			const maxAllowedThrust = this.config.maxGLimit * PHYSICS.G0 * sensor.mass;
			if (sensor.thrustForce > maxAllowedThrust) {
				throttle = Math.min(throttle, maxAllowedThrust / sensor.thrustForce);
			}
		}

		// Max-Q Auto-Throttle (Flight Computer Feedback)
		if (this.config.maxQAxialLimit !== Infinity) {
			const isTailFirst = Math.cos(sensor.aoaDeg * Math.PI / 180) < 0;
			const effectiveAxialLimitPa = isTailFirst ? this.config.maxQLateralLimit : this.config.maxQAxialLimit;
			const qRatio = (sensor.qAxialKpa * 1000) / effectiveAxialLimitPa;
			
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

		// Track prograde direction after thrust stops
		if (sensor.burnTime <= 0) {
			const turnDiff = MathUtils.normalizeAngle(sensor.progradeAngle - this.currentThrustAngle);
			const maxTurn = FLIGHT_COMPUTER_CONFIG.MAX_TURN_RATE_PER_SEC * sensor.dt;

			if (Math.abs(turnDiff) > maxTurn) {
				return this.currentThrustAngle + Math.sign(turnDiff) * maxTurn;
			} else {
				return sensor.progradeAngle;
			}
		}

		const Q = sensor.qAxialKpa + sensor.qLateralKpa;

		// Tower Clearance
		if (this.flightTime < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_TIME || (Q < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MIN_Q && this.telemetryCache.altM < FLIGHT_COMPUTER_CONFIG.TOWER_CLEARANCE_MAX_ALT)) {
			let diff = MathUtils.normalizeAngle(this.initialThrustAngle - this.currentThrustAngle);
			
			const maxTurn = FLIGHT_COMPUTER_CONFIG.PITCH_KICK_TURN_RATE * sensor.dt;
			if (Math.abs(diff) > maxTurn) {
				return this.currentThrustAngle + Math.sign(diff) * maxTurn;
			}
			return this.initialThrustAngle;
		}

		let targetAngle = this.initialThrustAngle;

		// Load Relief Control
		if (Q > 0.05 && this.telemetryCache.vV < FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD) {
			const stallFactor = Math.max(0, (FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD - this.telemetryCache.vV) / FLIGHT_COMPUTER_CONFIG.ANTI_STALL_Vv_THRESHOLD);
			const maxPitchUp = FLIGHT_COMPUTER_CONFIG.ANTI_STALL_MAX_PITCH_UP * (Math.PI / 180);
			
			const upAngle = this.telemetryCache.gravityAngle + Math.PI;
			let angleToUp = MathUtils.normalizeAngle(upAngle - targetAngle);

			targetAngle += Math.sign(angleToUp) * Math.min(Math.abs(angleToUp), maxPitchUp) * stallFactor;
		}

		const Q_Pa = Q * 1000;
		let maxAoA = Math.PI;
		if (Q_Pa > 100 && this.config.maxQLateralLimit !== Infinity) {
			const safeLateralLimit = this.config.maxQLateralLimit * FLIGHT_COMPUTER_CONFIG.LOAD_RELIEF_SAFE_MARGIN;
			const sinSq = safeLateralLimit / Q_Pa;
			if (sinSq < 1.0) {
				maxAoA = Math.asin(Math.sqrt(sinSq));
			}
		}

		let angleDiff = MathUtils.normalizeAngle(targetAngle - sensor.progradeAngle);

		const isRetrogradeIntent = Math.abs(angleDiff) > Math.PI / 2;

		let safeTargetAngle;
		if (isRetrogradeIntent) {
			let retroDiff = angleDiff > 0 ? angleDiff - Math.PI : angleDiff + Math.PI;
			if (retroDiff > maxAoA) retroDiff = maxAoA;
			if (retroDiff < -maxAoA) retroDiff = -maxAoA;
			safeTargetAngle = sensor.progradeAngle + Math.PI + retroDiff;
		} else {
			// Clamp angle to max AoA
			if (angleDiff > maxAoA) { angleDiff = maxAoA; }
			if (angleDiff < -maxAoA) { angleDiff = -maxAoA; }

			safeTargetAngle = sensor.progradeAngle + angleDiff;
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
