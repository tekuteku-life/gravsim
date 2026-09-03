
// gravsim_calc_object.js

import {
	PHYSICS, ROCHE_LIMIT, AERO_DYNAMIC,
	DEFAULT_OBJECT_PARAMS, TANK_PRESSURE_SIM,
	OBJECT_TYPES, SIMULATION
} from './gravsim_const.js';
import { FlightComputer } from './gravsim_flight_computer.js';
import { MathUtils, UnitConvertUtils } from './gravsim_utils.js';

/*******************************************************************
 * Calculation Object Class for Base
 *******************************************************************/
class GravSimCalcObject {
	constructor(id, name, type, x, y, vx, vy, ax, ay, radius, generation) {
		this.id = id;
		this.name = name;
		this.type = type;
		this.x = x; // m
		this.y = y; // m
		this.vx = vx; // m/s
		this.vy = vy; // m/s
		this.ax = ax; // m/s^2
		this.ay = ay; // m/s^2
		this.radius = radius; // m
		this._currentQ = 0; // Pa
		this.collided = false;
		this.shattered = false;
		this.generation = generation || 0;
		this.isDebris = this.generation > 0;
		this.isImpact = false;
		this.debrisMass = 0; // kg
		this.impactVx = 0; // m/s
		this.impactVy = 0; // m/s
		this.impactWinnerX = 0; // m
		this.impactWinnerY = 0; // m
		this.impactWinnerRadius = 0; // m

		this.inAtmosphere = false;
		this.isEscaping = false;

		this.maxGForce = -1;
		this.dominantBody = null;
		this.distToDominantM = 0; // m

		// Avoid using Getter for mass. Raw property is significantly faster.
		this.mass = 1; // t
		// Cache inverse mass to convert division into multiplication
		this.invMass = 1.0; // 1/t
	}

	getXt(dt) { return this.x + this.vx * dt + 1/2 * this.ax * dt * dt; }
	getYt(dt) { return this.y + this.vy * dt + 1/2 * this.ay * dt * dt; }
	getVXt(dt) { return this.vx + this.ax * dt; }
	getVYt(dt) { return this.vy + this.ay * dt; }
	getV() { return Math.sqrt(this.vx * this.vx + this.vy * this.vy); }

	applyGravity(other) {
		const dx = other.x - this.x; // m
		const dy = other.y - this.y; // m
		const radiusSum = this.radius + other.radius; // m
		const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum); // m^2
		const dist = Math.sqrt(distSq); // m

		// Optimize gravity calculation:
		// F = G * m1 * m2 / r^2
		// a1 = F / m1 = G * m2 / r^2
		// accel is directly calculated without using this.mass to save operations
		const accelPerDist = (PHYSICS.G * other.mass) / (distSq * dist); // m/s^2 / (t*m)

		this.ax += accelPerDist * dx;
		this.ay += accelPerDist * dy;

		// Keep the largest gravity object
		if (other.type === OBJECT_TYPES.CELESTIAL) {
			const gForce = other.mass / distSq; // t/m^2
			if (gForce > this.maxGForce) {
				this.maxGForce = gForce;
				this.dominantBody = other;
				this.distToDominantM = dist;
			}
		}
	}

	applyThrust() {}

	isColliding(other, dt) {
		const dx = other.x - this.x; // m
		const dy = other.y - this.y; // m
		const distSq = dx * dx + dy * dy; // m^2
		const radiusSum = this.radius + other.radius; // m

		if (distSq < radiusSum * radiusSum) { return true; }

		const max_v1 = Math.max(Math.abs(this.getVXt(dt)), Math.abs(this.getVYt(dt))); // m/s
		const max_v2 = Math.max(Math.abs(other.getVXt(dt)), Math.abs(other.getVYt(dt))); // m/s
		const expandRadiusSum = radiusSum + (max_v1 + max_v2) * dt; // m

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
		const fragileDensity = this.mass / Math.pow(this.radius, 3); // t/m^3
		const massiveDensity = other.mass / Math.pow(other.radius, 3); // t/m^3

		// Decrease calculation cost
		if (fragileDensity > ROCHE_LIMIT.UNBREAKABLE_DENSITY) { return false; }

		const rocheLimitM = 2.44 * other.radius * Math.cbrt(massiveDensity / fragileDensity); // m
		const dx = this.x - other.x; // m
		const dy = this.y - other.y; // m
		const distSq = dx * dx + dy * dy; // m^2

		return distSq < rocheLimitM * rocheLimitM;
	}

	_determinDynamicParam(vRelY, vRelX, vRelSq, rho) {
		let area = Math.PI * this.radius * this.radius; // m^2
		let cd = AERO_DYNAMIC.DEFAULT_CD;

		return {area: area, cd: cd};
	}

	_checkAerodynamicDestruction(q) {
		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		const maxQ = objParam?.MAX_DYNAMIC_PRESSURE || Infinity; // Pa
		if (q > maxQ) {
			this.shattered = true;
		}
	}

	_calculateAtmosphericDensity(refBody, refParam, altM) {
		if (!refParam || altM >= refParam.ATM_LIMIT_ALT) {
			return 0;
		}
		if (altM <= 0) {
			return refParam.ATM_DENSITY_0 || 0;
		}

		let rho = refParam.ATM_DENSITY_0;
		const layers = refParam.ATM_LAYERS;

		if (layers && layers.length > 0) {
			let prevAlt = 0;
			let currentRho = refParam.ATM_DENSITY_0;

			for (let i = 0; i < layers.length; i++) {
				const layer = layers[i];
				const hTop = layer.topAlt;
				const H = layer.scaleHeight;

				if (altM < hTop || i === layers.length - 1) {
					currentRho *= Math.exp(-(altM - prevAlt) / H);
					rho = currentRho;
					break;
				} else {
					currentRho *= Math.exp(-(hTop - prevAlt) / H);
					prevAlt = hTop;
				}
			}
		} else {
			const H = refParam.ATM_SCALE_HEIGHT || 8500;
			rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / H);
		}

		// Smooth Cosine Fade-out to Karman boundary
		const fadeStart = refParam.ATM_FADE_START_ALT || (refParam.ATM_LIMIT_ALT * 0.8);
		if (altM > fadeStart && refParam.ATM_LIMIT_ALT > fadeStart) {
			const fade = 0.5 * (1 + Math.cos(Math.PI * (altM - fadeStart) / (refParam.ATM_LIMIT_ALT - fadeStart)));
			rho *= fade;
		}

		return rho;
	}

	applyAerodynamics(refBody, refParam, altM) {
		if (altM >= refParam.ATM_LIMIT_ALT || altM < 0) {
			this.clearAerodynamicParameters();
			return;
		}

		// Calculate Atmospheric Density
		const rho = this._calculateAtmosphericDensity(refBody, refParam, altM);
		if (rho <= 0) {
			this.clearAerodynamicParameters();
			return;
		}

		this.inAtmosphere = true;

		// Calculate local atmosphere velocity
		let vAtmM_x = refBody.vx; // m/s
		let vAtmM_y = refBody.vy; // m/s

		if (refParam.ROTATION_PERIOD) {
			const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD; // rad/s
			const dxRef = this.x - refBody.x; // m
			const dyRef = this.y - refBody.y; // m
			vAtmM_x += -omega * dyRef;
			vAtmM_y += omega * dxRef;
		}

		// Relative Velocity
		const vRelX = this.vx - vAtmM_x; // m/s
		const vRelY = this.vy - vAtmM_y; // m/s
		const vRelSq = vRelX * vRelX + vRelY * vRelY; // m^2/s^2

		// Determine Area and Cd
		const aeroDynamicParam = this._determinDynamicParam(vRelY, vRelX, vRelSq, rho);

		if (vRelSq === 0) { return; }
		const vRel = Math.sqrt(vRelSq); // m/s

		// Dynamic Pressure & Drag Force
		const q = 0.5 * rho * vRelSq; // Pa
		this._currentQ = q;

		this._checkAerodynamicDestruction(q);

		if (this.shattered) {
			console.info(this.name + "(ID:" + this.id + ") was destructed by dynamic pressure");
			return;
		}

		const dragForce = q * aeroDynamicParam.cd * aeroDynamicParam.area; // N

		// Division by mass is replaced with multiplication by invMass
		const accelDrag = dragForce * this.invMass; // m/s^2

		this.ax -= (vRelX / vRel) * accelDrag;
		this.ay -= (vRelY / vRel) * accelDrag;
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this._currentQ = 0;
	}
}

/*******************************************************************
 * Calculation Object Class for Celestial
 *******************************************************************/
export class CalcCelestialBody extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, mass) {
		super(id, name, OBJECT_TYPES.CELESTIAL, x, y, vx, vy, ax, ay, radius, generation);
		this.mass = mass; // t
		this.invMass = mass > 0 ? 1.0 / mass : 0; // 1/t
	}
}

/*******************************************************************
 * Calculation Object Class for Rocket
 *******************************************************************/
export class CalcRocket extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, dryMass, fuelMass, oxidMass, thrustData) {
		super(id, name, OBJECT_TYPES.ROCKET, x, y, vx, vy, ax, ay, radius, generation);

		this.dryMass = dryMass; // t
		this.fuelMass = fuelMass; // t
		this.oxidMass = oxidMass; // t
		this.mass = this.dryMass + this.fuelMass + this.oxidMass; // t
		this.invMass = this.mass > 0 ? 1.0 / this.mass : 0; // 1/t

		this.ofRatio = thrustData?.ofRatio || 0;
		this.thrustForce = thrustData?.thrustForce || 0; // N
		this.burnTime = thrustData?.burnTime || 0; // s
		this.thrustAngle = thrustData?.thrustAngle || 0; // rad
		this.flightProfile = thrustData?.flightProfile || [];
		this.massLossRate = thrustData?.massLossRate || 0; // t/s
		this.maxGLimit = thrustData?.maxGLimit || 0; // G
		this.autoControl = thrustData?.autoControl !== undefined ? thrustData.autoControl : true;
		this.hostId = thrustData?.hostId !== undefined ? thrustData.hostId : null;
		this.hostAngleRad = thrustData?.hostAngleRad || 0; // rad
		this.hostAltM = thrustData?.hostAltM || 0; // m
		this.isHoldDown = thrustData?.isHoldDown || false;
		this.isIgnited = thrustData?.isIgnited !== undefined ? thrustData.isIgnited : true;
		this._thrustRatio = 0;
		this._qAxialKpa = 0; // kPa
		this._qLateralKpa = 0; // kPa
		this._aoaDeg = 0; // deg
		this._progradeAngle = 0; // rad

		this.flightComputer = new FlightComputer({
			maxGLimit: this.maxGLimit,
			maxQAxialLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_AXIAL || Infinity,
			maxQLateralLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_LATERAL || Infinity,
			thrustAngle: this.thrustAngle,
			flightProfile: this.flightProfile,
			hostAngleRad: this.hostAngleRad
		});

		// Pressure simulation parameters
		this.tankPresFuel = TANK_PRESSURE_SIM.UNPRESSURIZED_KPA; // kPa
		this.tankPresOxid = TANK_PRESSURE_SIM.UNPRESSURIZED_KPA; // kPa
		this.presState = 'UNPRESSURIZED';
		this.presTimer = 0; // s

		// Zero-allocation: Cache sensor data object for FlightComputer updates
		this._sensorData = {
			dt: 0, mass: 0, dryMass: 0, fuelMass: 0, thrustForce: 0, thrustRatio: 0,
			burnTime: 0, massLossRate: 0, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
			qAxialKpa: 0, qLateralKpa: 0, aoaDeg: 0, progradeAngle: 0, refBody: null,
			distToRefM: 0, isHoldDown: false, isIgnited: false
		};
	}

	handleCommand(cmd) {
		if (cmd === 'PRESSURIZE_TANK') {
			this.presState = 'PRESSURIZING';
			this.presTimer = 0;
		} else if (cmd === 'IGNITE_ENGINE') {
			if (this.presState === 'NOMINAL' || this.presState === 'PRESSURIZING') {
				this.presState = 'IGNITION_DROP';
				this.presTimer = 0;
			}
		}
	}

	_determinDynamicParam(vRelY, vRelX, vRelSq, rho) {
		let area = 0; // m^2
		let cd = 0.2;

		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		if (objParam && objParam.DRAG_COEF) {
			cd = objParam.DRAG_COEF;
		}

		let velAngle;

		// Handle extremely low relative velocity (e.g. hold down on pad)
		if (vRelSq < 0.01) {
			velAngle = this.thrustAngle;
		} else {
			velAngle = Math.atan2(vRelY, vRelX);
		}

		if (objParam && objParam.AERO_AREA_FRONT) {
			const angleDiff = Math.abs(MathUtils.normalizeAngle(this.thrustAngle - velAngle)); // rad
			const aoa = Math.min(angleDiff, Math.PI - angleDiff); // rad
			const sinAoA = Math.sin(aoa);

			area = objParam.AERO_AREA_FRONT * (1 - sinAoA) + objParam.AERO_AREA_SIDE * sinAoA;

			this._aoaDeg = UnitConvertUtils.rad2deg(angleDiff);

			const q = 0.5 * rho * vRelSq; // Pa
			this._qAxialKpa = UnitConvertUtils.pa2kpa(q * Math.pow(Math.cos(angleDiff), 2));
			this._qLateralKpa = UnitConvertUtils.pa2kpa(q * Math.pow(Math.sin(angleDiff), 2));
			this._progradeAngle = velAngle;
		} else {
			this._progradeAngle = velAngle;
		}

		return {area: area, cd: cd};
	}

	_checkAerodynamicDestruction(q) {
		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		const maxQAxial = objParam?.MAX_Q_AXIAL || Infinity; // Pa
		const maxQLateral = objParam?.MAX_Q_LATERAL || Infinity; // Pa

		const isTailFirst = Math.cos(UnitConvertUtils.deg2rad(this._aoaDeg)) < 0;
		const effectiveMaxQAxial = isTailFirst ? maxQLateral : maxQAxial; // Pa

		const currentQAxialPa = UnitConvertUtils.kpa2pa(this._qAxialKpa);
		const currentQLateralPa = UnitConvertUtils.kpa2pa(this._qLateralKpa);

		if (currentQAxialPa > effectiveMaxQAxial || currentQLateralPa > maxQLateral) {
			this.shattered = true;
		}
	}

	updatePressure(dt, structRatio) {
		if (this.fuelMass <= 0 && this.oxidMass <= 0 && this.presState !== 'UNPRESSURIZED') {
			this.presState = 'DEPLETED';
		}

		const targetPres = TANK_PRESSURE_SIM.TARGET_KPA; // kPa
		const unpres = TANK_PRESSURE_SIM.UNPRESSURIZED_KPA; // kPa

		const noiseF = (Math.random() - 0.5) * 2;
		const noiseO = (Math.random() - 0.5) * 2;
		const baseNoiseAmp = targetPres * TANK_PRESSURE_SIM.BASE_NOISE_RATIO;
		const qNoiseAmp = targetPres * TANK_PRESSURE_SIM.Q_NOISE_RATIO * (structRatio / 100);
		const totalNoiseAmp = baseNoiseAmp + qNoiseAmp; // kPa

		switch (this.presState) {
			case 'UNPRESSURIZED':
				this.tankPresFuel = unpres;
				this.tankPresOxid = unpres;
				break;
			case 'PRESSURIZING':
				this.presTimer += dt;
				let pRatio = Math.min(this.presTimer / TANK_PRESSURE_SIM.PRESSURIZE_TIME_SEC, 1.0);
				this.tankPresFuel = unpres + (targetPres - unpres) * pRatio;
				this.tankPresOxid = unpres + (targetPres - unpres) * pRatio;
				if (pRatio >= 1.0) this.presState = 'NOMINAL';
				break;
			case 'NOMINAL':
				this.tankPresFuel = targetPres + noiseF * totalNoiseAmp;
				this.tankPresOxid = targetPres + noiseO * totalNoiseAmp;
				break;
			case 'IGNITION_DROP':
				this.presTimer += dt;
				let dropF = targetPres * TANK_PRESSURE_SIM.IGNITION_DROP_RATIO;
				this.tankPresFuel = dropF + noiseF * totalNoiseAmp;
				this.tankPresOxid = dropF + noiseO * totalNoiseAmp;
				if (this.presTimer > TANK_PRESSURE_SIM.IGNITION_DROP_TIME_SEC) this.presState = 'NOMINAL';
				break;
			case 'MECO_SPIKE':
				this.presTimer += dt;
				let spikeF = targetPres * TANK_PRESSURE_SIM.MECO_SPIKE_RATIO;
				this.tankPresFuel = spikeF + noiseF * totalNoiseAmp;
				this.tankPresOxid = spikeF + noiseO * totalNoiseAmp;
				if (this.presTimer > TANK_PRESSURE_SIM.MECO_SPIKE_TIME_SEC) this.presState = 'NOMINAL';
				break;
			case 'DEPLETED':
				this.tankPresFuel = Math.max(unpres, this.tankPresFuel - TANK_PRESSURE_SIM.DEPLETION_DROP_RATE * dt);
				this.tankPresOxid = Math.max(unpres, this.tankPresOxid - TANK_PRESSURE_SIM.DEPLETION_DROP_RATE * dt);
				break;
		}
	}

	flightControl(dt, refBody, distToRefM) {
		let actualDt = 0; // s
		let throttle = 1.0;

		// Populate cached sensor object (Zero-allocation design) to prevent GC spike
		this._sensorData.dt = dt;
		this._sensorData.mass = this.mass;
		this._sensorData.dryMass = this.dryMass;
		this._sensorData.fuelMass = this.fuelMass + this.oxidMass;
		this._sensorData.thrustForce = this.thrustForce;
		this._sensorData.thrustRatio = this._thrustRatio;
		this._sensorData.burnTime = this.burnTime;
		this._sensorData.massLossRate = this.massLossRate;
		this._sensorData.x = this.x;
		this._sensorData.y = this.y;
		this._sensorData.vx = this.vx;
		this._sensorData.vy = this.vy;
		this._sensorData.ax = this.ax;
		this._sensorData.ay = this.ay;
		this._sensorData.qAxialKpa = this.inAtmosphere ? (this._qAxialKpa || 0) : 0;
		this._sensorData.qLateralKpa = this.inAtmosphere ? (this._qLateralKpa || 0) : 0;
		this._sensorData.aoaDeg = this._aoaDeg || 0;
		this._sensorData.progradeAngle = this._progradeAngle || 0;
		this._sensorData.refBody = refBody;
		this._sensorData.distToRefM = distToRefM;
		this._sensorData.isHoldDown = this.isHoldDown;
		this._sensorData.isIgnited = this.isIgnited;

		this.flightComputer.update(this._sensorData);

		if (this.autoControl) {
			throttle = this.flightComputer.currentThrottle;
			this.thrustAngle = this.flightComputer.currentThrustAngleRad;
		} else {
			throttle = 1.0;
		}

		// Force cut throttle before ignition
		if (!this.isIgnited) {
			throttle = 0;
		}

		if (this.burnTime > 0 && throttle > 0) {
			// The time consumed is proportional to the throttle
			const consumedTime = dt * throttle; // s
			actualDt = Math.min(consumedTime, this.burnTime);

			let fuelRatio = 1.0;
			let oxidRatio = 0.0;
			if (this.ofRatio > 0) {
				oxidRatio = this.ofRatio / (1.0 + this.ofRatio);
				fuelRatio = 1.0 / (1.0 + this.ofRatio);
			}

			let dmTotal = this.massLossRate * actualDt; // t
			let dmFuel = dmTotal * fuelRatio; // t
			let dmOxid = dmTotal * oxidRatio; // t

			if (this.fuelMass < dmFuel || (this.ofRatio > 0 && this.oxidMass < dmOxid)) {
				let maxDtFuel = dmFuel > 0 ? (this.fuelMass / dmFuel) * actualDt : Infinity; // s
				let maxDtOxid = dmOxid > 0 ? (this.oxidMass / dmOxid) * actualDt : Infinity; // s
				actualDt = Math.min(actualDt, maxDtFuel, maxDtOxid);

				dmFuel = this.massLossRate * actualDt * fuelRatio;
				dmOxid = this.massLossRate * actualDt * oxidRatio;
			}

			this.fuelMass -= dmFuel;
			this.oxidMass -= dmOxid;
			this.burnTime -= actualDt;

			// Refresh mass and inverse mass automatically
			this.mass = this.dryMass + this.fuelMass + this.oxidMass;
			this.invMass = this.mass > 0 ? 1.0 / this.mass : 0;

			if (this.burnTime <= 0 || this.fuelMass <= 0 || (this.ofRatio > 0 && this.oxidMass <= 0)) {
				if (this.presState === 'NOMINAL') {
					this.presState = 'MECO_SPIKE';
					this.presTimer = 0;
				}
				if (this.fuelMass < 0) { this.fuelMass = 0; }
				if (this.oxidMass < 0) { this.oxidMass = 0; }

				this.mass = this.dryMass + this.fuelMass + this.oxidMass;
				this.invMass = this.mass > 0 ? 1.0 / this.mass : 0;
				this.burnTime = 0;
			}
		}

		this.updatePressure(dt, this.flightComputer.getTelemetry().structRatio);
		this._thrustRatio = dt > 0 ? (actualDt / dt) : 0;
	}

	applyThrust() {
		if (this._thrustRatio > 0 && this.mass > 0) {
			// Division by mass is replaced with multiplication by invMass
			const thrustAx = (this.thrustForce * Math.cos(this.thrustAngle)) * this.invMass; // m/s^2
			const thrustAy = (this.thrustForce * Math.sin(this.thrustAngle)) * this.invMass; // m/s^2

			this.ax += thrustAx * this._thrustRatio;
			this.ay += thrustAy * this._thrustRatio;
		}
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this._currentQ = 0;
		this._qAxialKpa = 0;
		this._qLateralKpa = 0;

		let velAngle;
		if (this.dominantBody) {
			const dvx = this.vx - this.dominantBody.vx; // m/s
			const dvy = this.vy - this.dominantBody.vy; // m/s
			const vSq = dvx * dvx + dvy * dvy; // m^2/s^2

			if (vSq < 0.01) {
				velAngle = this.thrustAngle;
			} else {
				velAngle = Math.atan2(dvy, dvx);
			}
		} else {
			velAngle = Math.atan2(this.vy, this.vx);
		}

		this._progradeAngle = velAngle;
		const angleDiff = Math.abs(MathUtils.normalizeAngle(this.thrustAngle - velAngle)); // rad
		this._aoaDeg = UnitConvertUtils.rad2deg(angleDiff);
	}
}

/*******************************************************************
 * Calculation Object Class for Debris
 *******************************************************************/
export class CalcDebris extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, mass) {
		super(id, name, OBJECT_TYPES.DEBRIS, x, y, vx, vy, ax, ay, radius, generation);
		this.mass = mass; // t
		this.invMass = mass > 0 ? 1.0 / mass : 0; // 1/t
	}
}
