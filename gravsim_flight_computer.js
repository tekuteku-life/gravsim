
// gravsim_flight_computer.js

import { G, G0 } from './gravsim_const.js';

export class FlightComputer {
	constructor(config = {}) {
		this.config = {
			maxGLimit: config.maxGLimit || Infinity,
			maxQAxialLimit: config.maxQAxialLimit || Infinity,
		};

		this.currentThrustAngle = config.thrustAngle || 0;
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
			const currentQPa = (sensor.qAxialKpa + sensor.qLateralKpa) * 1000;
			const qRatio = currentQPa / this.config.maxQAxialLimit;
			if (qRatio > 0.7) {
				let qThrottle = 1.0 - (qRatio - 0.7) * 5.0;
				qThrottle = Math.max(0.2, Math.min(1.0, qThrottle));
				throttle = Math.min(throttle, qThrottle);
			}
		}

		return throttle;
	}

	getTelemetry() { return this.telemetryCache; }
}
