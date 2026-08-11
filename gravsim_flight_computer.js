
// gravsim_flight_computer.js

import { G, G0 } from './gravsim_const.js';

export class FlightComputer {
	constructor(config = {}) {
		this.config = {
			maxGLimit: config.maxGLimit || Infinity,
			maxQAxialLimit: config.maxQAxialLimit || Infinity, // Pa
			maxQLateralLimit: config.maxQLateralLimit || 5000.0, // Pa
		};

		this.currentThrustAngle = config.thrustAngle || 0;
		this.initialThrustAngle = this.currentThrustAngle;
		this.flightTime = 0;
		
		this.telemetryCache = {
			status: 0, // 0:PRE_LAUNCH, 1:LIFTOFF, 2:ASCENT, 3:MAX_Q, 4:MECO, 5:COASTING, 6:TRACKING
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
		if (sensor.burnTime > 0 || this.flightTime > 0) {
			this.flightTime += sensor.dt;
		}

		this._updateTelemetry(sensor);

		const thrustAngleRad = this._computeThrustAngle(sensor);
		this.currentThrustAngle = thrustAngleRad;

		const throttle = this._computeThrottle(sensor);

		// Decide mission status
		let statusInt = 0; // PRE_LAUNCH
		if (sensor.burnTime > 0) {
			if (this.telemetryCache.structRatio > 80) {
				statusInt = 3; // MAX_Q
			} else {
				statusInt = 2; // ASCENT
			}
		} else if (this.flightTime > 0) {
			if (sensor.massLossRate > 0 && sensor.fuelMass <= 0) {
				statusInt = 4; // MECO
			} else {
				statusInt = 5; // COASTING
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
			localG_ms2 = (G * sensor.refBody.mass) / Math.pow(sensor.distToRefM, 2);
			altM = sensor.distToRefM - sensor.refBody.radius;

			const dx = sensor.x - sensor.refBody.x;
			const dy = sensor.y - sensor.refBody.y;

			if (sensor.distToRefM > 0) {
				const uRx = dx / sensor.distToRefM;
				const uRy = dy / sensor.distToRefM;
				const uHx = -uRy;
				const uHy = uRx;

				const dvx = sensor.vx - sensor.refBody.vx;
				const dvy = sensor.vy - sensor.refBody.vy;
				vV = dvx * uRx + dvy * uRy;
				vH = dvx * uHx + dvy * uHy;

				aV = sensor.ax * uRx + sensor.ay * uRy;
				aH = sensor.ax * uHx + sensor.ay * uHy;
				
				gravityAngle = Math.atan2(-dy, -dx);
			}
		}

		const totalAccel = Math.sqrt(sensor.ax * sensor.ax + sensor.ay * sensor.ay);
		const currentG = totalAccel / G0;

		let remDv = 0;
		if (sensor.dryMass > 0) {
			let ve = 320 * G0; 
			if (sensor.thrustForce > 0 && sensor.massLossRate > 0) {
				ve = sensor.thrustForce / sensor.massLossRate;
			}
			remDv = (ve * Math.log(sensor.mass / sensor.dryMass));
		}

		this.telemetryCache.qAxialKpa = sensor.qAxialKpa;
		this.telemetryCache.qLateralKpa = sensor.qLateralKpa;
		this.telemetryCache.aoaDeg = sensor.aoaDeg;
		
		let structRatio = 0;
		if (this.config.maxQAxialLimit !== Infinity) {
			const currentQPa = (sensor.qAxialKpa + sensor.qLateralKpa) * 1000;
			structRatio = (currentQPa / this.config.maxQAxialLimit) * 100;
		}
		this.telemetryCache.structRatio = structRatio;
		
		this.telemetryCache.altM = altM;
		this.telemetryCache.vV = vV;
		this.telemetryCache.vH = vH;
		this.telemetryCache.aV = aV / G0;
		this.telemetryCache.aH = aH / G0;
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
			const maxAllowedThrust = this.config.maxGLimit * G0 * sensor.mass;
			if (sensor.thrustForce > maxAllowedThrust) {
				throttle = Math.min(throttle, maxAllowedThrust / sensor.thrustForce);
			}
		}

		// Max-Q Auto-Throttle (Flight Computer Feedback)
		if (this.config.maxQAxialLimit !== Infinity) {
			const maxQAxialKpa = this.config.maxQAxialLimit / 1000;
			const qRatio = sensor.qAxialKpa / maxQAxialKpa;
			
			if (qRatio > 0.65) {
				let qThrottle = 1.0 - (qRatio - 0.65) * 4.0;
				
				// Anti-stall
				const minThrottle = this.telemetryCache.vV < 0 ? 0.7 : 0.1;
				qThrottle = Math.max(minThrottle, Math.min(1.0, qThrottle));
				throttle = Math.min(throttle, qThrottle);
			}
		}

		return throttle;
	}

	_computeThrustAngle(sensor) {
		let currentAngle = this.currentThrustAngle;
		while (currentAngle > Math.PI) currentAngle -= 2 * Math.PI;
		while (currentAngle < -Math.PI) currentAngle += 2 * Math.PI;
		this.currentThrustAngle = currentAngle;

		const Q = sensor.qAxialKpa + sensor.qLateralKpa;

		// Tower Clearance
		if (this.flightTime < 3.0 || (Q < 0.1 && this.telemetryCache.altM < 1000)) {
			let diff = this.initialThrustAngle - this.currentThrustAngle;
			while (diff > Math.PI) diff -= 2 * Math.PI;
			while (diff < -Math.PI) diff += 2 * Math.PI;
			
			const maxTurn = 0.5 * sensor.dt;
			if (Math.abs(diff) > maxTurn) {
				return this.currentThrustAngle + Math.sign(diff) * maxTurn;
			}
			return this.initialThrustAngle;
		}

		let targetAngle = this.initialThrustAngle;

		// Load Relief Control
		let maxAoA = Math.PI;
		if (Q > 0.1 && this.config.maxQLateralLimit !== Infinity) {
			const safeLateralLimit = this.config.maxQLateralLimit * 0.85; // Safety margin 15%
			const sinSq = (safeLateralLimit / 1e3) / Q;
			if (sinSq < 1.0) {
				maxAoA = Math.asin(Math.sqrt(sinSq));
			}
		}

		let angleDiff = targetAngle - sensor.progradeAngle;
		while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
		while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

		// Clamp angle to max AoA
		if (angleDiff > maxAoA) { angleDiff = maxAoA; }
		if (angleDiff < -maxAoA) { angleDiff = -maxAoA; }

		const safeTargetAngle = sensor.progradeAngle + angleDiff;

		let turnDiff = safeTargetAngle - this.currentThrustAngle;
		while (turnDiff > Math.PI) { turnDiff -= 2 * Math.PI; }
		while (turnDiff < -Math.PI) { turnDiff += 2 * Math.PI; }

		// Limit pitch rate
		const maxTurnRatePerSec = 0.1;
		const maxTurn = maxTurnRatePerSec * sensor.dt;

		if (Math.abs(turnDiff) > maxTurn) {
			return this.currentThrustAngle + Math.sign(turnDiff) * maxTurn;
		} else {
			return safeTargetAngle;
		}
	}

	getTelemetry() { return this.telemetryCache; }
}
