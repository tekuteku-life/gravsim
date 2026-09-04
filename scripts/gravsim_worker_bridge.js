
// gravsim_worker_bridge.js

import { CALC_BUFFER_CONFIG, BUFFER_INDEX, OBJECT_TYPES } from './gravsim_const.js';

export class WorkerBridge {
	static _cache = {};
	static _bufferPool = [];
	
	// Reusable buffer pool

	// Get an ArrayBuffer from the pool or create a new one
	static _getBuffer(requiredLength) {
		const byteLength = requiredLength * 8; // Float64 uses 8 bytes per element
		for (let i = 0; i < this._bufferPool.length; i++) {
			if (this._bufferPool[i].byteLength >= byteLength) {
				const arrayBuffer = this._bufferPool.splice(i, 1)[0];
				return new Float64Array(arrayBuffer, 0, requiredLength);
			}
		}
		return new Float64Array(requiredLength);
	}

	// Recycle buffer back to the pool
	static recycleBuffer(buffer) {
		if (buffer && buffer.byteLength > 0) {
			this._bufferPool.push(buffer);
		}
	}

	// Generate buffer Worker -> Main
	static formatWorkerToMain(objects) {
		const requiredLength = objects.length * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;
		const buffer = this._getBuffer(requiredLength);

		for (let i = 0; i < objects.length; i++) {
			const obj = objects[i];
			const offset = i * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;

			buffer[offset + BUFFER_INDEX.ID] = obj.id;
			buffer[offset + BUFFER_INDEX.TYPE] = obj.type;
			buffer[offset + BUFFER_INDEX.X] = obj.x || 0;
			buffer[offset + BUFFER_INDEX.Y] = obj.y || 0;
			buffer[offset + BUFFER_INDEX.VX] = obj.vx || 0;
			buffer[offset + BUFFER_INDEX.VY] = obj.vy || 0;
			buffer[offset + BUFFER_INDEX.AX] = obj.ax || 0;
			buffer[offset + BUFFER_INDEX.AY] = obj.ay || 0;

			if (obj.type === OBJECT_TYPES.ROCKET) {
				buffer[offset + BUFFER_INDEX.MASS] = obj.dryMass;
				buffer[offset + BUFFER_INDEX.FUEL_MASS] = obj.fuelMass;
				buffer[offset + BUFFER_INDEX.OXID_MASS] = obj.oxidMass;
				buffer[offset + BUFFER_INDEX.BURN_TIME] = obj.burnTime > 0 ? obj.burnTime : 0;
				buffer[offset + BUFFER_INDEX.THRUST_RATIO] = obj._thrustRatio || 0;

				const tm = obj.flightComputer.getTelemetry();
				buffer[offset + BUFFER_INDEX.TM_STATUS] = tm.status;
				buffer[offset + BUFFER_INDEX.TM_Q_AXIAL] = tm.qAxialKpa;
				buffer[offset + BUFFER_INDEX.TM_Q_LATERAL] = tm.qLateralKpa;
				buffer[offset + BUFFER_INDEX.TM_STRUCT_RATIO] = tm.structRatio;
				buffer[offset + BUFFER_INDEX.TM_AOA_DEG] = tm.aoaDeg;
				buffer[offset + BUFFER_INDEX.TM_PROGRADE_ANGLE] = tm.progradeAngle;
				buffer[offset + BUFFER_INDEX.TM_GRAVITY_ANGLE] = tm.gravityAngle;
				buffer[offset + BUFFER_INDEX.TM_REM_DV] = tm.remDv;
				buffer[offset + BUFFER_INDEX.TM_TWR] = tm.twr;
				buffer[offset + BUFFER_INDEX.TM_ALT_M] = tm.altM;
				buffer[offset + BUFFER_INDEX.TM_VV] = tm.vV;
				buffer[offset + BUFFER_INDEX.TM_VH] = tm.vH;
				buffer[offset + BUFFER_INDEX.TM_AV] = tm.aV;
				buffer[offset + BUFFER_INDEX.TM_AH] = tm.aH;
				buffer[offset + BUFFER_INDEX.TM_CURRENT_G] = tm.currentG;
				buffer[offset + BUFFER_INDEX.TM_FLIGHT_TIME] = obj.flightComputer.flightTime;
				buffer[offset + BUFFER_INDEX.THRUST_ANGLE] = obj.thrustAngle;
				buffer[offset + BUFFER_INDEX.TM_TANK_PRES_FUEL] = obj.tankPresFuel || 0;
				buffer[offset + BUFFER_INDEX.TM_TANK_PRES_OXID] = obj.tankPresOxid || 0;
			} else {
				buffer[offset + BUFFER_INDEX.MASS] = obj.mass;
				buffer[offset + BUFFER_INDEX.FUEL_MASS] = 0;
				buffer[offset + BUFFER_INDEX.OXID_MASS] = 0;
				buffer[offset + BUFFER_INDEX.BURN_TIME] = 0;
				buffer[offset + BUFFER_INDEX.THRUST_RATIO] = 0;
				buffer[offset + BUFFER_INDEX.TM_TANK_PRES_FUEL] = 0;
				buffer[offset + BUFFER_INDEX.TM_TANK_PRES_OXID] = 0;
			}
			buffer[offset + BUFFER_INDEX.RADIUS] = obj.radius || 1;
			
			let flags = (obj.collided ? 1 : 0) | (obj.shattered ? 2 : 0)
				| (obj.isImpact ? 4 : 0) | (obj.inAtmosphere ? 8 : 0)
				| (obj.isEscaping ? 16 : 0) | (obj.isHoldDown ? 32 : 0) | (obj.isIgnited ? 64 : 0);
			if (obj.type === OBJECT_TYPES.ROCKET && obj.flightComputer) {
				const tm = obj.flightComputer.getTelemetry();
				if (tm.isAntiStallActive) flags |= 128;
				if (tm.isQLimitNear) flags |= 256;
				if (tm.isGLimitNear) flags |= 512;
			}
			buffer[offset + BUFFER_INDEX.FLAGS] = flags;
			
			buffer[offset + BUFFER_INDEX.DEBRIS_MASS] = obj.debrisMass || 0;
			buffer[offset + BUFFER_INDEX.IMPACT_VX] = obj.impactVx || 0;
			buffer[offset + BUFFER_INDEX.IMPACT_VY] = obj.impactVy || 0;
			buffer[offset + BUFFER_INDEX.IMPACT_WINNER_X] = obj.impactWinnerX || 0;
			buffer[offset + BUFFER_INDEX.IMPACT_WINNER_Y] = obj.impactWinnerY || 0;
			buffer[offset + BUFFER_INDEX.IMPACT_WINNER_RADIUS] = obj.impactWinnerRadius || 0;
			
			buffer[offset + BUFFER_INDEX.DOMINANT_BODY_ID] = obj.dominantBody ? obj.dominantBody.id : -1;
			buffer[offset + BUFFER_INDEX.DIST_TO_DOMINANT] = obj.distToDominantM || 0;
		}
		return buffer;
	}

	// Parse received buffer at main-side
	static parseWorkerToMain(bufferData, validLength, callback) {
		const buffer = new Float64Array(bufferData, 0, validLength);
		const objCount = buffer.length / CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;

		for (let i = 0; i < objCount; i++) {
			const offset = i * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;
			const flags = buffer[offset + BUFFER_INDEX.FLAGS];

			this._cache.id = buffer[offset + BUFFER_INDEX.ID];
			this._cache.type = buffer[offset + BUFFER_INDEX.TYPE];
			this._cache.x = buffer[offset + BUFFER_INDEX.X];
			this._cache.y = buffer[offset + BUFFER_INDEX.Y];
			this._cache.vx = buffer[offset + BUFFER_INDEX.VX];
			this._cache.vy = buffer[offset + BUFFER_INDEX.VY];
			this._cache.ax = buffer[offset + BUFFER_INDEX.AX];
			this._cache.ay = buffer[offset + BUFFER_INDEX.AY];
			
			this._cache.mass = buffer[offset + BUFFER_INDEX.MASS];
			this._cache.fuelMass = buffer[offset + BUFFER_INDEX.FUEL_MASS];
			this._cache.oxidMass = buffer[offset + BUFFER_INDEX.OXID_MASS];
			this._cache.radius = buffer[offset + BUFFER_INDEX.RADIUS];
			this._cache.burnTime = buffer[offset + BUFFER_INDEX.BURN_TIME];
			this._cache.thrustRatio = buffer[offset + BUFFER_INDEX.THRUST_RATIO];

			this._cache.isCollided = (flags & 1) !== 0;
			this._cache.isShattered = (flags & 2) !== 0;
			this._cache.isImpact = (flags & 4) !== 0;
			this._cache.inAtmosphere = (flags & 8) !== 0;
			this._cache.isEscaping = (flags & 16) !== 0;
			this._cache.isHoldDown = (flags & 32) !== 0;
			this._cache.isIgnited = (flags & 64) !== 0;
			this._cache.isAntiStall = (flags & 128) !== 0;
			this._cache.isQLimitNear = (flags & 256) !== 0;
			this._cache.isGLimitNear = (flags & 512) !== 0;

			this._cache.debrisMass = buffer[offset + BUFFER_INDEX.DEBRIS_MASS];
			this._cache.impactVx = buffer[offset + BUFFER_INDEX.IMPACT_VX];
			this._cache.impactVy = buffer[offset + BUFFER_INDEX.IMPACT_VY];
			this._cache.impactWinnerX = buffer[offset + BUFFER_INDEX.IMPACT_WINNER_X];
			this._cache.impactWinnerY = buffer[offset + BUFFER_INDEX.IMPACT_WINNER_Y];
			this._cache.impactWinnerRadius = buffer[offset + BUFFER_INDEX.IMPACT_WINNER_RADIUS];

			this._cache.dominantBodyId = buffer[offset + BUFFER_INDEX.DOMINANT_BODY_ID];
			this._cache.distToDominantM = buffer[offset + BUFFER_INDEX.DIST_TO_DOMINANT];

			if (this._cache.type === OBJECT_TYPES.ROCKET) {
				this._cache.tmStatus = buffer[offset + BUFFER_INDEX.TM_STATUS];
				this._cache.tmQAxial = buffer[offset + BUFFER_INDEX.TM_Q_AXIAL];
				this._cache.tmQLateral = buffer[offset + BUFFER_INDEX.TM_Q_LATERAL];
				this._cache.tmStructRatio = buffer[offset + BUFFER_INDEX.TM_STRUCT_RATIO];
				this._cache.tmAoaDeg = buffer[offset + BUFFER_INDEX.TM_AOA_DEG];
				this._cache.tmProgradeAngle = buffer[offset + BUFFER_INDEX.TM_PROGRADE_ANGLE];
				this._cache.tmGravityAngle = buffer[offset + BUFFER_INDEX.TM_GRAVITY_ANGLE];
				this._cache.tmRemDv = buffer[offset + BUFFER_INDEX.TM_REM_DV];
				this._cache.tmTwr = buffer[offset + BUFFER_INDEX.TM_TWR];
				this._cache.tmAltM = buffer[offset + BUFFER_INDEX.TM_ALT_M];
				this._cache.tmVv = buffer[offset + BUFFER_INDEX.TM_VV];
				this._cache.tmVh = buffer[offset + BUFFER_INDEX.TM_VH];
				this._cache.tmAv = buffer[offset + BUFFER_INDEX.TM_AV];
				this._cache.tmAh = buffer[offset + BUFFER_INDEX.TM_AH];
				this._cache.tmCurrentG = buffer[offset + BUFFER_INDEX.TM_CURRENT_G];
				this._cache.tmFlightTime = buffer[offset + BUFFER_INDEX.TM_FLIGHT_TIME];
				this._cache.thrustAngle = buffer[offset + BUFFER_INDEX.THRUST_ANGLE];
				this._cache.tmTankPresFuel = buffer[offset + BUFFER_INDEX.TM_TANK_PRES_FUEL];
				this._cache.tmTankPresOxid = buffer[offset + BUFFER_INDEX.TM_TANK_PRES_OXID];
			}

			callback(this._cache);
		}
	}
}
