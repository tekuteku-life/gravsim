
// gravsim_calc_object.js

import {
	PHYSICS, ROCHE_LIMIT, DEFAULT_OBJECT_PARAMS,
	OBJECT_TYPES, SIMULATION
} from './gravsim_const.js';
import { FlightComputer } from './gravsim_flight_computer.js';
import { MathUtils } from './gravsim_utils.js';

/*******************************************************************
 * Entity Class
*******************************************************************/
class GravSimCalcObject {
	constructor(id, name, type, x, y, vx, vy, ax, ay, radius, generation) {
		this.id = id;
		this.name = name;
		this.type = type;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = ax;
		this.ay = ay;
		this.radius = radius;
		this._currentQ = 0;
		this.collided = false;
		this.shattered = false;
		this.generation = generation || 0;
		this.isDebris = this.generation > 0;
		this.isImpact = false;
		this.debrisMass = 0; // kg
		this.impactVx = 0;
		this.impactVy = 0;
		this.impactWinnerX = 0;
		this.impactWinnerY = 0;
		this.impactWinnerRadius = 0;
		this.inAtmosphere = false;
		this.isEscaping = false;
		this.maxGForce = -1;
		this.dominantBody = null;
		this.distToDominantM = 0;
	}
	get mass() { return 1; }
	
	getXt(dt) { return this.x + this.vx * dt + 1/2 * this.ax * dt * dt; }
	getYt(dt) { return this.y + this.vy * dt + 1/2 * this.ay * dt * dt; }
	getVXt(dt) { return this.vx + this.ax * dt; }
	getVYt(dt) { return this.vy + this.ay * dt; }
	getV() { return Math.sqrt(this.vx * this.vx + this.vy * this.vy); }
	
	applyGravity(other) {
		const dx = other.x - this.x;
		const dy = other.y - this.y;
		const radiusSum = this.radius + other.radius;
		const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum);
		const dist = Math.sqrt(distSq);

		const force = (PHYSICS.G * this.mass * other.mass) / distSq;
		const accel = force / this.mass;

		this.ax += accel * dx / dist;
		this.ay += accel * dy / dist;

		// Keep the largest gravity object
		if (other.type === OBJECT_TYPES.CELESTIAL) {
			const gForce = other.mass / distSq;
			if (gForce > this.maxGForce) {
				this.maxGForce = gForce;
				this.dominantBody = other;
				this.distToDominantM = dist;
			}
		}
	}
	
	applyThrust() {}

	isColliding(other, dt) {
		const dx = other.x - this.x;
		const dy = other.y - this.y;
		const distSq = dx * dx + dy * dy;
		const radiusSum = this.radius + other.radius;

		if (distSq < radiusSum * radiusSum) { return true; }

		const max_v1 = Math.max(Math.abs(this.getVXt(dt)), Math.abs(this.getVYt(dt)));
		const max_v2 = Math.max(Math.abs(other.getVXt(dt)), Math.abs(other.getVYt(dt)));
		const expandRadiusSum = radiusSum + (max_v1 + max_v2) * dt;
		
		if (distSq < expandRadiusSum * expandRadiusSum) {
			const EXPAND_DIV_NUM = SIMULATION.CALC_EXPAND_DIV_NUM;
			for( let i = 1; i < EXPAND_DIV_NUM; i++ ) {
				const dts = dt / EXPAND_DIV_NUM * i;
				const dxs = other.getXt(dts) - this.getXt(dts);
				const dys = other.getYt(dts) - this.getYt(dts);
				const distSqs = dxs * dxs + dys * dys;
				
				if (distSqs < radiusSum * radiusSum) {
					return true;
				}
			}
		}

		return false;
	}

	isRocheLimit(other) {
		const fragileDensity = this.mass / Math.pow(this.radius, 3);
		const massiveDensity = other.mass / Math.pow(other.radius, 3);

		// Decrease calculation cost
		if (fragileDensity > ROCHE_LIMIT.UNBREAKABLE_DENSITY) { return false; }

		const rocheLimitM = 2.44 * other.radius * Math.cbrt(massiveDensity / fragileDensity);
		const dx = this.x - other.x;
		const dy = this.y - other.y;
		const distSq = dx * dx + dy * dy;

		return distSq < rocheLimitM * rocheLimitM;
	}

	applyAerodynamics(refBody, refParam, altM) {
		this.inAtmosphere = true;

		// Calculate Atmospheric Density
		const rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / refParam.ATM_SCALE_HEIGHT);

		// Calculate local atmosphere velocity
		let vAtmM_x = refBody.vx;
		let vAtmM_y = refBody.vy;

		if (refParam.ROTATION_PERIOD) {
			const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD;
			const dxRef = this.x - refBody.x;
			const dyRef = this.y - refBody.y;
			vAtmM_x += -omega * dyRef;
			vAtmM_y += omega * dxRef;
		}

		// Relative Velocity
		const vRelX = this.vx - vAtmM_x;
		const vRelY = this.vy - vAtmM_y;
		const vRelSq = vRelX * vRelX + vRelY * vRelY;

		if (vRelSq === 0) { return; }
		const vRel = Math.sqrt(vRelSq);

		// Determine Area and Cd
		let area = Math.PI * this.radius * this.radius;
		let cd = 0.47;

		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		if (objParam && objParam.AERO_AREA_FRONT) {
			cd = objParam.DRAG_COEF || 0.2;
			const velAngle = Math.atan2(vRelY, vRelX);
			const angleDiff = Math.abs(MathUtils.normalizeAngle(this.thrustAngle - velAngle));
			
			const aoa = Math.min(angleDiff, Math.PI - angleDiff);
			const sinAoA = Math.sin(aoa);
			area = objParam.AERO_AREA_FRONT * (1 - sinAoA) + objParam.AERO_AREA_SIDE * sinAoA;

			if (this.type === OBJECT_TYPES.ROCKET) {
				this._aoaDeg = angleDiff * (180 / Math.PI);
				const q = 0.5 * rho * vRelSq;
				this._qAxialKpa = (q * Math.pow(Math.cos(angleDiff), 2)) / 1000;
				this._qLateralKpa = (q * Math.pow(Math.sin(angleDiff), 2)) / 1000;
				this._progradeAngle = velAngle;
			}
		} else {
			if (this.type === OBJECT_TYPES.ROCKET) {
				this._progradeAngle = Math.atan2(vRelY, vRelX);
			}
		}

		// Dynamic Pressure & Drag Force
		const q = 0.5 * rho * vRelSq;
		this._currentQ = q;

		this._checkAerodynamicDestruction(q);
		if (this.shattered) {
			console.info(this.name + "(ID:" + this.id + ") was destructed by dynamic pressure");
			return;
		}

		const dragForce = q * cd * area;
		const accelDrag = dragForce / this.mass;
		
		this.ax -= (vRelX / vRel) * accelDrag;
		this.ay -= (vRelY / vRel) * accelDrag;
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this._currentQ = 0;
	}

	_checkAerodynamicDestruction(q) {
		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		const maxQ = objParam?.MAX_DYNAMIC_PRESSURE || Infinity;
		if (q > maxQ) {
			this.shattered = true;
		}
	}
}

export class CalcCelestialBody extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, mass) {
		super(id, name, OBJECT_TYPES.CELESTIAL, x, y, vx, vy, ax, ay, radius, generation);
		this._mass = mass; // kg
	}
	get mass() { return this._mass; }
	set mass(val) { this._mass = val; }
}

export class CalcRocket extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, dryMass, fuelMass, thrustData) {
		super(id, name, OBJECT_TYPES.ROCKET, x, y, vx, vy, ax, ay, radius, generation);
		this.dryMass = dryMass; // kg
		this.fuelMass = fuelMass; // kg
		this.thrustForce = thrustData?.thrustForce || 0;
		this.burnTime = thrustData?.burnTime || 0;
		this.thrustAngle = thrustData?.thrustAngle || 0;
		this.massLossRate = thrustData?.massLossRate || 0;
		this.maxGLimit = thrustData?.maxGLimit || 0;
		this.autoControl = thrustData?.autoControl !== undefined ? thrustData.autoControl : true;
		this._thrustRatio = 0;
		
		this._qAxialKpa = 0;
		this._qLateralKpa = 0;
		this._aoaDeg = 0;
		this._progradeAngle = 0;

		this.flightComputer = new FlightComputer({
			maxGLimit: this.maxGLimit,
			maxQAxialLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_AXIAL || Infinity,
			maxQLateralLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_LATERAL || Infinity,
			thrustAngle: this.thrustAngle
		});
	}

	get mass() { return this.dryMass + this.fuelMass; }
	set mass(val) {}

	_checkAerodynamicDestruction(q) {
		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		const maxQAxial = objParam?.MAX_Q_AXIAL || Infinity;
		const maxQLateral = objParam?.MAX_Q_LATERAL || Infinity;

		const isTailFirst = Math.cos(this._aoaDeg * Math.PI / 180) < 0;
		const effectiveMaxQAxial = isTailFirst ? maxQLateral : maxQAxial;

		const currentQAxialPa = this._qAxialKpa * 1000;
		const currentQLateralPa = this._qLateralKpa * 1000;

		if (currentQAxialPa > effectiveMaxQAxial || currentQLateralPa > maxQLateral) {
			this.shattered = true;
		}
	}

	flightControl(dt, refBody, distToRefM) {
		let actualDt = 0;
		let throttle = 1.0;

		const sensorData = {
			dt: dt,
			mass: this.mass, dryMass: this.dryMass, fuelMass: this.fuelMass,
			thrustForce: this.thrustForce, thrustRatio: this._thrustRatio,
			burnTime: this.burnTime, massLossRate: this.massLossRate,
			x: this.x, y: this.y, vx: this.vx, vy: this.vy, ax: this.ax, ay: this.ay,
			qAxialKpa: this._qAxialKpa || 0,
			qLateralKpa: this._qLateralKpa || 0,
			aoaDeg: this._aoaDeg || 0,
			progradeAngle: this._progradeAngle || 0,
			refBody: refBody,
			distToRefM: distToRefM,
		};

		const command = this.flightComputer.update(sensorData);
		
		if (this.autoControl) {
			throttle = command.throttle;
			this.thrustAngle = command.thrustAngleRad;
		} else {
			throttle = 1.0;
		}

		if (this.burnTime > 0) {
			// The time consumed is proportional to the throttle
			const consumedTime = dt * throttle;
			actualDt = Math.min(consumedTime, this.burnTime);

			this.fuelMass -= this.massLossRate * actualDt;
			this.burnTime -= actualDt;

			if (this.burnTime <= 0 || this.fuelMass <= 0) {
				this.fuelMass = 0;
				this.burnTime = 0;
			}
		}

		this._thrustRatio = dt > 0 ? (actualDt / dt) : 0;
	}

	applyThrust() {
		if (this._thrustRatio > 0 && this.mass > 0) {
			const thrustAx = (this.thrustForce * Math.cos(this.thrustAngle)) / this.mass;
			const thrustAy = (this.thrustForce * Math.sin(this.thrustAngle)) / this.mass;

			this.ax += thrustAx * this._thrustRatio;
			this.ay += thrustAy * this._thrustRatio;
		}
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this._currentQ = 0;
		this._qAxialKpa = 0;
		this._qLateralKpa = 0;
		this._aoaDeg = 0;
		this._progradeAngle = Math.atan2(this.vy, this.vx);
	}
}
