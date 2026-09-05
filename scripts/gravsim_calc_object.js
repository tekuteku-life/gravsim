
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
		this.mass = SIMULATION.DEFAULT_OBJECT_MASS; // t
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

		const rocheLimitM = ROCHE_LIMIT.COEFFICIENT * other.radius * Math.cbrt(massiveDensity / fragileDensity); // m
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

	applyAerodynamics(refBody, refParam, altM) {
		this.inAtmosphere = true;

		// Calculate Atmospheric Density
		const rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / refParam.ATM_SCALE_HEIGHT); // kg/m^3

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
		if (this._qAxialKpa !== undefined) { this._qAxialKpa = 0; }
		if (this._qLateralKpa !== undefined) { this._qLateralKpa = 0; }
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
		this._progradeAngle = this.thrustAngle; // rad (aligned with initial thrust angle)
		this._lastDominantBody = null;

		this.flightComputer = new FlightComputer({
			maxGLimit: this.maxGLimit,
			maxQAxialLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_AXIAL || Infinity,
			maxQLateralLimit: DEFAULT_OBJECT_PARAMS[name]?.MAX_Q_LATERAL || Infinity,
			thrustAngle: this.thrustAngle,
			flightProfile: this.flightProfile,
			hostAngleRad: this.hostAngleRad
		});

		// Pressure simulation parameters
		this.tankPresFuel = 0; // kPa (Starts at 0 on rollout, then smoothly fills)
		this.tankPresOxid = 0; // kPa
		this.presState = 'ROLLOUT_FILL';
		this.presTimer = 0; // s
		this._wasFiring = false;
		this._noiseFiltF = 0;
		this._noiseFiltO = 0;

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
			if (this.presState === 'ROLLOUT_FILL' || this.presState === 'UNPRESSURIZED') {
				this._presStartF = this.tankPresFuel;
				this._presStartO = this.tankPresOxid;
				this.presState = 'PRESSURIZING';
				this.presTimer = 0;
			}
		} else if (cmd === 'IGNITE_ENGINE') {
			if (this.presState === 'NOMINAL' || this.presState === 'PRESSURIZING') {
				this.presState = 'IGNITION_TRANSIENT';
				this.presTimer = 0;
			} else if (this.presState === 'ROLLOUT_FILL' || this.presState === 'UNPRESSURIZED') {
				// Rapid pressurization failsafe if engine ignited directly without pressurization
				this.tankPresFuel = TANK_PRESSURE_SIM.TARGET_KPA * TANK_PRESSURE_SIM.IGNITION_DROP_RATIO;
				this.tankPresOxid = TANK_PRESSURE_SIM.TARGET_KPA * TANK_PRESSURE_SIM.IGNITION_DROP_RATIO;
				this.presState = 'IGNITION_TRANSIENT';
				this.presTimer = 0;
			}
		}
	}

	_determinDynamicParam(vRelY, vRelX, vRelSq, rho) {
		let area = 0; // m^2
		let cd = AERO_DYNAMIC.ROCKET_DEFAULT_CD;

		const objParam = DEFAULT_OBJECT_PARAMS[this.name];
		if (objParam && objParam.DRAG_COEF) {
			cd = objParam.DRAG_COEF;
		}

		let velAngle;

		// Handle extremely low relative velocity (e.g. hold down on pad)
		if (vRelSq < AERO_DYNAMIC.LOW_VELOCITY_SQ) {
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
		// Detect engine firing state transition automatically
		const currentlyFiring = this.isIgnited && (this._thrustRatio > TANK_PRESSURE_SIM.FIRING_DETECT_THROTTLE) && (this.fuelMass > 0 || this.oxidMass > 0);
		if (currentlyFiring && !this._wasFiring) {
			// Engine start detected
			if (this.presState === 'NOMINAL' || this.presState === 'PRESSURIZING' || this.presState === 'UNPRESSURIZED') {
				this.presState = 'IGNITION_TRANSIENT';
				this.presTimer = 0;
			}
		} else if (!currentlyFiring && this._wasFiring) {
			// MECO / engine cutoff detected
			if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
				this.presState = 'MECO_TRANSIENT';
				this.presTimer = 0;
			}
		}
		this._wasFiring = currentlyFiring;

		// Depletion check
		if (this.fuelMass <= 0 && this.oxidMass <= 0 && this.presState !== 'UNPRESSURIZED' && this.presState !== 'ROLLOUT_FILL') {
			this.presState = 'DEPLETED';
		}

		// Calculate sensor noise and dynamic pressure vibration
		const rawNoiseF = (Math.random() - 0.5) * 2;
		const rawNoiseO = (Math.random() - 0.5) * 2;
		const lpf = TANK_PRESSURE_SIM.NOISE_LPF_ALPHA;
		this._noiseFiltF = this._noiseFiltF * lpf + rawNoiseF * (1 - lpf);
		this._noiseFiltO = this._noiseFiltO * lpf + rawNoiseO * (1 - lpf);

		const qFactor = Math.min((this._qAxialKpa || 0) / TANK_PRESSURE_SIM.Q_NORMALIZATION_KPA, TANK_PRESSURE_SIM.Q_FACTOR_MAX) + (structRatio / 100);
		const dynJitterAmp = TANK_PRESSURE_SIM.TARGET_KPA * TANK_PRESSURE_SIM.Q_NOISE_RATIO * qFactor;
		const baseNoiseAmp = TANK_PRESSURE_SIM.BASE_NOISE_KPA;

		const timeSec = this.flightComputer ? this.flightComputer.flightTime : this.presTimer;
		const resonanceF = Math.sin(timeSec * TANK_PRESSURE_SIM.RESONANCE_FREQ_F) * (dynJitterAmp * TANK_PRESSURE_SIM.RESONANCE_AMP_RATIO);
		const resonanceO = Math.sin(timeSec * TANK_PRESSURE_SIM.RESONANCE_FREQ_O + TANK_PRESSURE_SIM.RESONANCE_PHASE_O) * (dynJitterAmp * TANK_PRESSURE_SIM.RESONANCE_AMP_RATIO);

		const totalNoiseF = (this._noiseFiltF * baseNoiseAmp) + (rawNoiseF * dynJitterAmp * TANK_PRESSURE_SIM.RAW_NOISE_AMP_RATIO) + resonanceF;
		const totalNoiseO = (this._noiseFiltO * baseNoiseAmp) + (rawNoiseO * dynJitterAmp * TANK_PRESSURE_SIM.RAW_NOISE_AMP_RATIO) + resonanceO;

		let basePresF = (this.presState === 'UNPRESSURIZED' || this.presState === 'ROLLOUT_FILL') ? TANK_PRESSURE_SIM.GROUND_KPA : TANK_PRESSURE_SIM.TARGET_KPA;
		let basePresO = (this.presState === 'UNPRESSURIZED' || this.presState === 'ROLLOUT_FILL') ? TANK_PRESSURE_SIM.GROUND_KPA : TANK_PRESSURE_SIM.TARGET_KPA;

		switch (this.presState) {
			case 'ROLLOUT_FILL': {
				this.presTimer += dt;
				const tRatio = Math.min(this.presTimer / TANK_PRESSURE_SIM.ROLLOUT_FILL_TIME_SEC, 1.0);
				// Smoothstep easing: 3t^2 - 2t^3
				const smoothP = tRatio * tRatio * (3 - 2 * tRatio);
				basePresF = smoothP * TANK_PRESSURE_SIM.GROUND_KPA;
				basePresO = smoothP * TANK_PRESSURE_SIM.GROUND_KPA;
				if (tRatio >= 1.0) {
					this.presState = 'UNPRESSURIZED';
				}
				break;
			}
			case 'UNPRESSURIZED': {
				basePresF = TANK_PRESSURE_SIM.GROUND_KPA;
				basePresO = TANK_PRESSURE_SIM.GROUND_KPA;
				break;
			}
			case 'PRESSURIZING': {
				this.presTimer += dt;
				const pRatio = Math.min(this.presTimer / TANK_PRESSURE_SIM.PRESSURIZE_TIME_SEC, 1.0);
				const smoothP = pRatio * pRatio * (3 - 2 * pRatio);
				const startF = this._presStartF !== undefined ? this._presStartF : TANK_PRESSURE_SIM.GROUND_KPA;
				const startO = this._presStartO !== undefined ? this._presStartO : TANK_PRESSURE_SIM.GROUND_KPA;
				basePresF = startF + (TANK_PRESSURE_SIM.TARGET_KPA - startF) * smoothP;
				basePresO = startO + (TANK_PRESSURE_SIM.TARGET_KPA - startO) * smoothP;
				if (pRatio >= 1.0) {
					this.presState = 'NOMINAL';
				}
				break;
			}
			case 'NOMINAL': {
				basePresF = TANK_PRESSURE_SIM.TARGET_KPA;
				basePresO = TANK_PRESSURE_SIM.TARGET_KPA;
				break;
			}
			case 'IGNITION_TRANSIENT': {
				this.presTimer += dt;
				const dur = TANK_PRESSURE_SIM.IGNITION_TRANSIENT_TIME_SEC;
				const tau = this.presTimer / dur;
				let transientMod = 0;
				const p1 = TANK_PRESSURE_SIM.IGNITION_DROP_PHASE;
				const p2 = TANK_PRESSURE_SIM.IGNITION_OVERSHOOT_PHASE;
				const dropRatio = TANK_PRESSURE_SIM.IGNITION_DROP_RATIO;
				const ovRatio = TANK_PRESSURE_SIM.IGNITION_OVERSHOOT_RATIO;

				if (tau < p1) {
					transientMod = -(1.0 - dropRatio) * (tau / p1);
				} else if (tau < p2) {
					const tSub = (tau - p1) / (p2 - p1);
					transientMod = -(1.0 - dropRatio) * (1 - tSub) + ovRatio * tSub;
				} else if (tau < 1.0) {
					const tSub = (tau - p2) / (1.0 - p2);
					transientMod = ovRatio * (1 - tSub);
				} else {
					this.presState = 'NOMINAL';
				}
				basePresF = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod);
				basePresO = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod * TANK_PRESSURE_SIM.OXIDIZER_OVERSHOOT_FACTOR);
				break;
			}
			case 'MECO_SPIKE':
			case 'MECO_TRANSIENT': {
				this.presTimer += dt;
				const dur = TANK_PRESSURE_SIM.MECO_TRANSIENT_TIME_SEC;
				const tau = this.presTimer / dur;
				let transientMod = 0;
				const p1 = TANK_PRESSURE_SIM.MECO_SPIKE_PHASE;
				const spikeRatio = TANK_PRESSURE_SIM.MECO_SPIKE_RATIO;

				if (tau < p1) {
					transientMod = (spikeRatio - 1.0) * (tau / p1);
					basePresF = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod);
					basePresO = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod * TANK_PRESSURE_SIM.OXIDIZER_MECO_FACTOR);
				} else if (tau < 1.0) {
					const tSub = (tau - p1) / (1.0 - p1);
					transientMod = (spikeRatio - 1.0) * Math.exp(-TANK_PRESSURE_SIM.MECO_DECAY_RATE * tSub);
					basePresF = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod);
					basePresO = TANK_PRESSURE_SIM.TARGET_KPA * (1.0 + transientMod * TANK_PRESSURE_SIM.OXIDIZER_MECO_FACTOR);
				} else {
					// Spike finished -> Safeing Venting starts (smoothly venting down to 100~120 kPa)
					this.presState = 'POST_MECO_VENT';
					this.presTimer = 0;
					this._ventStartF = this.tankPresFuel;
					this._ventStartO = this.tankPresOxid;
					basePresF = this._ventStartF;
					basePresO = this._ventStartO;
				}
				break;
			}
			case 'POST_MECO_VENT': {
				this.presTimer += dt;
				const vRatio = Math.min(this.presTimer / TANK_PRESSURE_SIM.POST_MECO_VENT_TIME_SEC, 1.0);
				// Smoothstep easing from target flight pressure down to safe hold pressure (110 kPa)
				const smoothV = vRatio * vRatio * (3 - 2 * vRatio);
				const startF = this._ventStartF !== undefined ? this._ventStartF : TANK_PRESSURE_SIM.TARGET_KPA;
				const startO = this._ventStartO !== undefined ? this._ventStartO : TANK_PRESSURE_SIM.TARGET_KPA;
				basePresF = startF + (TANK_PRESSURE_SIM.POST_MECO_SAFE_KPA - startF) * smoothV;
				basePresO = startO + (TANK_PRESSURE_SIM.POST_MECO_SAFE_KPA - startO) * smoothV;
				if (vRatio >= 1.0) {
					this.presState = 'POST_MECO_HOLD';
				}
				break;
			}
			case 'POST_MECO_HOLD': {
				basePresF = TANK_PRESSURE_SIM.POST_MECO_SAFE_KPA;
				basePresO = TANK_PRESSURE_SIM.POST_MECO_SAFE_KPA;
				break;
			}
			case 'DEPLETED': {
				basePresF = Math.max(0, this.tankPresFuel - TANK_PRESSURE_SIM.DEPLETION_DROP_RATE * dt);
				basePresO = Math.max(0, this.tankPresOxid - TANK_PRESSURE_SIM.DEPLETION_DROP_RATE * dt);
				break;
			}
		}

		let noiseScale = 1.0;
		if (this.presState === 'ROLLOUT_FILL') {
			noiseScale = Math.min(this.presTimer / TANK_PRESSURE_SIM.ROLLOUT_FILL_TIME_SEC, 1.0);
		} else if (this.presState === 'DEPLETED') {
			noiseScale = Math.min(basePresF / TANK_PRESSURE_SIM.TARGET_KPA, 1.0);
		}
		this.tankPresFuel = Math.max(0, basePresF + totalNoiseF * noiseScale);
		this.tankPresOxid = Math.max(0, basePresO + totalNoiseO * noiseScale);
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
		this._sensorData.qAxialKpa = this._qAxialKpa || 0;
		this._sensorData.qLateralKpa = this._qLateralKpa || 0;
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
				if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
					this.presState = 'MECO_TRANSIENT';
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
			this._lastDominantBody = this.dominantBody;
		}
		const refBody = this.dominantBody || this._lastDominantBody;

		if (refBody) {
			const dvx = this.vx - refBody.vx; // m/s
			const dvy = this.vy - refBody.vy; // m/s
			const vSq = dvx * dvx + dvy * dvy; // m^2/s^2

			if (vSq < AERO_DYNAMIC.LOW_VELOCITY_SQ) {
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
