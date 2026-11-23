
// gravsim_calc_object.js

import {
	PHYSICS, ROCHE_LIMIT, AERO_DYNAMIC,
	TANK_PRESSURE_SIM, TANK_PRESSURE_STATES,
	OBJECT_TYPES, SIMULATION,
	MULTISTAGE_ROCKET,
	TRAJECTORY_PREDICTION,
	RCS_CONFIG
} from './gravsim_const.js';
import { presetManager, ROCKET_FUELS } from './gravsim_preset_manager.js';
import { FlightComputer } from './gravsim_flight_computer.js';
import { MathUtils, UnitConvertUtils, normalizeRocketConfig, AeroUtils } from './gravsim_utils.js';

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
		this.mach = 0;
		/** @type {any} */
		this.param = null;

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
		const objParam = this.param || (typeof presetManager !== 'undefined' ? presetManager.getObjectParam(this.name) : null);
		const maxQ = objParam?.MAX_DYNAMIC_PRESSURE || Infinity; // Pa
		if (q > maxQ) {
			this.shattered = true;
		}
	}

	applyAerodynamics(refBody, refParam, altM) {
		this.inAtmosphere = true;

		// Calculate Atmospheric Density
		const rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / refParam.ATM_SCALE_HEIGHT); // kg/m^3
		this.ambientPresRatio = Math.max(0, rho / (refParam.ATM_DENSITY_0 || 1.225));

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
		this.mach = 0;
		if (vRelSq === 0) {
			return;
		}

		const vRel = Math.sqrt(vRelSq); // m/s
		this.mach = AeroUtils.computeMach(vRel, altM, refParam);

		// Dynamic Pressure & Drag Force
		const q = 0.5 * rho * vRelSq; // Pa
		this._currentQ = q;

		this._checkAerodynamicDestruction(q);

		if (this.shattered) {
			if (this.id !== TRAJECTORY_PREDICTION.DUMMY_ROCKET_ID) {
				console.info(this.name + "(ID:" + this.id + ") was destructed by dynamic pressure");
			}
			return;
		}

		const dragForce = q * aeroDynamicParam.cd * aeroDynamicParam.area; // N

		// Division by mass in kg (invMass is 1/t)
		const accelDrag = dragForce * (this.invMass / 1000); // m/s^2

		this.ax -= (vRelX / vRel) * accelDrag;
		this.ay -= (vRelY / vRel) * accelDrag;
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this.ambientPresRatio = 0.0;
		this._currentQ = 0;
		this.mach = 0;
		if (this._qAxialKpa !== undefined) { this._qAxialKpa = 0; }
		if (this._qLateralKpa !== undefined) { this._qLateralKpa = 0; }
	}

	/**
	 * Exact integrator state for save/load (m, m/s, m/s^2; the main thread keeps pixels, whose round trip is not exact).
	 * ax/ay is a(t) of the velocity-Verlet step and the aero cache belongs to the same force evaluation. Inside a step
	 * both are evaluated with the velocity of the previous step, so a reload cannot re-derive them from the saved
	 * velocity: PhysicsEngine.addObject re-applies them after its force evaluation (applyRestoredForces).
	 */
	getKinematicState() {
		return { x: this.x, y: this.y, vx: this.vx, vy: this.vy, ax: this.ax, ay: this.ay, aero: this._getAeroCache() };
	}

	/** Velocity-dependent aerodynamic cache of the last force evaluation (position-only values are re-derived). */
	_getAeroCache() {
		return { currentQ: this._currentQ || 0, mach: this.mach || 0 };
	}

	/** @param {any} aero validated subset of _getAeroCache() */
	_applyAeroCache(aero) {
		if (aero.currentQ !== undefined) { this._currentQ = aero.currentQ; }
		if (aero.mach !== undefined) { this.mach = aero.mach; }
	}

	/**
	 * Validate and apply a getKinematicState() value: the position and velocity at once, the acceleration and the aero
	 * cache are kept in _restoredForces for applyRestoredForces(). Partial or non-finite kinematics are ignored as a whole.
	 * @param {any} k
	 * @returns {boolean} true when applied
	 */
	restoreKinematicState(k) {
		if (!k || typeof k !== 'object') { return false; }
		const keys = ['x', 'y', 'vx', 'vy', 'ax', 'ay'];
		if (!keys.every(key => Number.isFinite(k[key]))) { return false; }
		this.x = k.x;
		this.y = k.y;
		this.vx = k.vx;
		this.vy = k.vy;
		const aero = {};
		const src = (k.aero && typeof k.aero === 'object') ? k.aero : {};
		const nonNeg = (v) => Number.isFinite(v) && v >= 0;
		if (nonNeg(src.currentQ)) { aero.currentQ = src.currentQ; }
		if (nonNeg(src.mach)) { aero.mach = src.mach; }
		if (nonNeg(src.qAxialKpa)) { aero.qAxialKpa = src.qAxialKpa; }
		if (nonNeg(src.qLateralKpa)) { aero.qLateralKpa = src.qLateralKpa; }
		if (nonNeg(src.aoaDeg) && src.aoaDeg <= 180) { aero.aoaDeg = src.aoaDeg; }
		if (Number.isFinite(src.progradeAngle)) { aero.progradeAngle = src.progradeAngle; }
		this._restoredForces = { ax: k.ax, ay: k.ay, aero };
		this.applyRestoredForces();
		return true;
	}

	/** Re-apply the saved a(t) and aero cache (until the first step after a load, see PhysicsEngine._restoredPending). */
	applyRestoredForces() {
		const f = this._restoredForces;
		if (!f) { return; }
		this.ax = f.ax;
		this.ay = f.ay;
		this._applyAeroCache(f.aero);
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
		this.rotationAngle = 0;
		this.rotationPeriod = 0;
	}

	/** Worker-only state for save/load: exact kinematics and the mass in Worker units (no t <-> kg round trip). */
	getRuntimeState() {
		return { kinematics: this.getKinematicState(), mass: this.mass };
	}

	/** @param {any} state value previously produced by getRuntimeState() */
	restoreRuntimeState(state) {
		if (!state || typeof state !== 'object') return;
		this.restoreKinematicState(state.kinematics);
		if (Number.isFinite(state.mass) && state.mass > 0) {
			this.mass = state.mass;
			this.invMass = 1.0 / state.mass;
		}
	}
}

/*******************************************************************
 * Calculation Object Class for Rocket
 *******************************************************************/
export class CalcRocket extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, dryMass, fuelMass, oxidMass, thrustData) {
		super(id, name, OBJECT_TYPES.ROCKET, x, y, vx, vy, ax, ay, radius, generation);

		// Multi-stage setup & configuration normalization
		const normConfig = normalizeRocketConfig({
			stages: thrustData?.stages,
			payload: thrustData?.payload,
			fairing: thrustData?.fairing,
			boosters: thrustData?.boosters,
			dryMassT: dryMass,
			fuelMassT: fuelMass,
			oxidMassT: oxidMass,
			thrustKN: thrustData?.thrustForce ? thrustData.thrustForce / 1000 : undefined,
			burnTime: thrustData?.burnTime,
			ofRatio: thrustData?.ofRatio,
			radius: radius,
			colorTheme: thrustData?.colorTheme
		});

		this.stages = normConfig.stages;
		this.boosters = normConfig.boosters || thrustData?.boosters || thrustData?.rendering?.boosters || (normConfig.stages && normConfig.stages[0]?.boosters) || null;
		this.hasBoosters = !!(this.boosters && ((this.boosters.count > 0) || (this.boosters.burnTimeSec > 0)));
		this.isBoosterBurnout = false;
		this.isBoosterSeparated = false;
		this.isBoosterIgnited = false;
		this.boosterBurnTimer = 0;
		this.boosterSepTimer = 0;
		this.bottomOffsetM = thrustData?.bottomOffsetM !== undefined ? thrustData.bottomOffsetM : (radius > 10 ? radius : 31.5);
		this.baseRadiusM = thrustData?.baseRadiusM || (normConfig.stages ? (this.bottomOffsetM ? this.bottomOffsetM / 3.10 : 63) : 63);
		this.radius = this.bottomOffsetM;
		this.payload = normConfig.payload;
		this.fairing = {
			enabled: !!normConfig.fairing?.enabled,
			massT: normConfig.fairing?.massT || 0,
			separationAltKm: normConfig.fairing?.separationAltKm || MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM,
			isSeparated: !!normConfig.fairing?.isSeparated
		};
		this.currentStageIndex = 0;
		this.totalStages = this.stages.length;
		this.isHoldDown = thrustData?.isHoldDown || false;
		this.isIgnited = thrustData?.isIgnited !== undefined ? thrustData.isIgnited : true;
		this.stageState = this.isHoldDown ? 'PRE_LAUNCH' : 'STG_BURNING';
		this.stgTimer = 0;
		this.isPayloadSeparated = false;
		this.isStage2Separated = false;
		this._pendingDebris = [];

		this.thrustAngle = thrustData?.thrustAngle || 0; // rad
		this.flightProfile = thrustData?.flightProfile || [];
		this.maxGLimit = thrustData?.maxGLimit || 0; // G
		this.autoControl = thrustData?.autoControl !== undefined ? thrustData.autoControl : true;
		this.disableStaging = thrustData?.disableStaging || false;
		this.disableOrbitalCutoff = thrustData?.disableOrbitalCutoff || false;
		this.targetApogeeKm = thrustData?.targetApogeeKm || 0;
		this.targetPerigeeKm = thrustData?.targetPerigeeKm || 0;
		this.targetVInfKmS = Number(thrustData?.targetVInfKmS) || 0;
		this.hostId = thrustData?.hostId !== undefined ? thrustData.hostId : null;
		this.hostAngleRad = thrustData?.hostAngleRad || 0; // rad
		this.hostAltM = thrustData?.hostAltM || 0; // m
		this.colorTheme = normConfig.colorTheme || thrustData?.colorTheme || 'orange';

		this._thrustRatio = 0;
		this._qAxialKpa = 0; // kPa
		this._qLateralKpa = 0; // kPa
		this._aoaDeg = 0; // deg
		this._progradeAngle = this.thrustAngle; // rad (aligned with initial thrust angle)
		this._lastDominantBody = null;
		this.rcsCw = false;
		this.rcsCcw = false;
		this.rcsUllage = false;
		this._postSepRcsTimer = 0;
		this._ullageRestartTimer = 0;
		// RCS thruster flags/timers are render-only (renderer + worker bridge flags). The trajectory predictor
		// disables them to keep its per-step cost down; physics never reads them.
		this.trackRcsVisualState = thrustData?.trackRcsVisualState !== false;

		this.ambientPresRatio = this.isHoldDown ? 1.0 : (thrustData?.ambientPresRatio !== undefined ? thrustData.ambientPresRatio : 0.0);
		this.currentIsp = 0;

		if (this.hasBoosters) {
			const srbFuel = ROCKET_FUELS[this.boosters.plumeFuel || 'solid'] || ROCKET_FUELS['solid'] || { isp: 280, ispVac: 280, ispSl: 250 };
			this.boosterIspVac = this.boosters.ispVac || this.boosters.isp || srbFuel.ispVac || srbFuel.isp || 280;
			this.boosterIspSl = this.boosters.ispSl !== undefined ? this.boosters.ispSl : (srbFuel.ispSl !== undefined ? srbFuel.ispSl : Math.round(this.boosterIspVac * 0.89));
			this.boosterThrustVac = UnitConvertUtils.kn2n(this.boosters.thrustKN || 4310);
			this.coreThrustVac = UnitConvertUtils.kn2n(this.boosters.coreThrustKN || 2940);
		}

		// Restore branch is taken only on explicit save/load contract (never inferred from transient fields)
		const hasRestoredRuntime = thrustData?.restoredRuntimeState === true;

		if (hasRestoredRuntime) {
			this.currentStageIndex = Math.max(0, Math.min(Number(thrustData?.currentStageIndex) || 0, this.totalStages));
			this.isPayloadSeparated = Boolean(thrustData?.isPayloadSeparated);
			this.isStage2Separated = Boolean(
				thrustData?.isStage2Separated ||
				this.currentStageIndex >= 2 ||
				(this.isPayloadSeparated && this.totalStages <= 2)
			);
			this.isBoosterBurnout = Boolean(thrustData?.isBoosterBurnout);
			this.isBoosterSeparated = Boolean(thrustData?.isBoosterSeparated);
			this.isBoosterIgnited = Boolean(this.hasBoosters && this.currentStageIndex === 0 && !this.isBoosterBurnout && !this.isBoosterSeparated && !this.isHoldDown && this.isIgnited);
			this.hasPayloadPropulsion = Boolean(thrustData?.hasPayloadPropulsion || (this.isPayloadSeparated && this.payload?.propulsion?.enabled));
			this.stageState = thrustData?.stageState || (this.isHoldDown ? 'PRE_LAUNCH' : 'STG_BURNING');
			this.stgTimer = Number.isFinite(thrustData?.stgTimer) ? thrustData.stgTimer : 0;

			if (this.isPayloadSeparated && this.hasPayloadPropulsion && this.payload?.propulsion) {
				const prop = this.payload.propulsion;
				const fuel = ROCKET_FUELS[prop.fuelType] || ROCKET_FUELS['liquid'] || { isp: 320, ispVac: 320, ispSl: 282, ofRatio: 2.5 };
				this.fuelType = prop.fuelType || 'liquid';
				this.thrustForceVac = ((prop.thrustKN ?? prop.thrustKn ?? 0)) * 1000;
				this.ispVac = prop.ispVac || prop.isp || fuel.ispVac || fuel.isp || 320;
				this.ispSl = prop.ispSl !== undefined ? prop.ispSl : (fuel.ispSl !== undefined ? fuel.ispSl : Math.round(this.ispVac * 0.88));
				this.ofRatio = prop.ofRatio !== undefined ? prop.ofRatio : (fuel.ofRatio || 0);
				if (this.payload?.radius) { this.radius = this.payload.radius; }
			} else if (this.isPayloadSeparated) {
				this.fuelType = 'liquid';
				this.thrustForceVac = 0;
				this.ispVac = 320;
				this.ispSl = 320;
				this.ofRatio = 0;
				if (this.payload?.radius) { this.radius = this.payload.radius; }
			} else {
				const stg = this.stages[Math.min(this.currentStageIndex, this.stages.length - 1)] || this.stages[0];
				const fuel = ROCKET_FUELS[stg.fuelType] || ROCKET_FUELS['liquid'] || { isp: 300, ispVac: 300, ispSl: 260, ofRatio: 2.5 };
				this.fuelType = stg.fuelType || 'liquid';
				const nomThrustKN = (this.currentStageIndex === 0 && this.hasBoosters && this.isBoosterBurnout && this.boosters?.coreThrustKN)
					? this.boosters.coreThrustKN
					: stg.thrustKN;
				this.thrustForceVac = UnitConvertUtils.kn2n(nomThrustKN || 0);
				this.ispVac = stg.ispVac || stg.isp || fuel.ispVac || fuel.isp || 300;
				this.ispSl = stg.ispSl !== undefined ? stg.ispSl : (fuel.ispSl !== undefined ? fuel.ispSl : Math.round(this.ispVac * 0.88));
				this.ofRatio = stg.ofRatio !== undefined ? stg.ofRatio : (fuel.ofRatio || 0);
				// separateBoosters() removed the casings' dry mass from stages[0] in the Worker only (the saved stages are the
				// main-thread copy): repeat it so the later stage-1 debris and the upper-stage mass sum match the saved flight
				if (this.currentStageIndex === 0 && this.hasBoosters && this.isBoosterSeparated && this.stages[0]) {
					const boosterDryMass = this.boosters.dryMassT || (this.boosters.count === 4 ? 40.0 : 20.0);
					this.stages[0].dryMassT = Math.max(0, (this.stages[0].dryMassT || 0) - boosterDryMass);
				}
			}

			this.dryMass = Number.isFinite(dryMass) ? dryMass : (thrustData?.dryMass || 0);
			this.fuelMass = Math.max(0, Number.isFinite(fuelMass) ? fuelMass : 0);
			this.oxidMass = Math.max(0, Number.isFinite(oxidMass) ? oxidMass : 0);
			this.burnTime = Math.max(0, Number.isFinite(thrustData?.burnTime) ? thrustData.burnTime : 0);
			this.massLossRate = this.burnTime > 0 ? ((this.fuelMass + this.oxidMass) / this.burnTime) : 0;
			this.thrustForce = (this.stageState === 'ORBITAL_COAST' || (this.isPayloadSeparated && !this.hasPayloadPropulsion)) ? 0 : this.thrustForceVac;
			this.currentIsp = this.getEffectiveIsp(this.ambientPresRatio);
			this.updateTotalMass();
		} else {
			// Activate initial stage
			this._activateStage(0);
		}

		// Name the aero/structure parameters were resolved from. It is kept across saves because the rocket is renamed to
		// the payload at separation (PhysicsEngine.addObject resolves a restored rocket's objParam from it).
		this._paramName = (typeof thrustData?.paramName === 'string' && thrustData.paramName) ? thrustData.paramName : name;
		this.objParam = thrustData?.objParam || (typeof presetManager !== 'undefined' ? presetManager.getObjectParam(this._paramName) : null);

		this.flightComputer = new FlightComputer({
			maxGLimit: this.maxGLimit,
			maxQAxialLimit: this.objParam?.MAX_Q_AXIAL || Infinity,
			maxQLateralLimit: this.objParam?.MAX_Q_LATERAL || Infinity,
			thrustAngle: this.thrustAngle,
			flightProfile: this.flightProfile,
			hostAngleRad: this.hostAngleRad,
			disableOrbitalCutoff: this.disableOrbitalCutoff,
			targetApogeeKm: this.targetApogeeKm,
			targetPerigeeKm: this.targetPerigeeKm
		});

		// Pressure simulation parameters
		this.tankPresFuel = 0; // kPa
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
			distToRefM: 0, isHoldDown: false, isIgnited: false, stageState: this.stageState,
			targetApogeeKm: this.targetApogeeKm, targetPerigeeKm: this.targetPerigeeKm,
			disableOrbitalCutoff: this.disableOrbitalCutoff
		};

		if (hasRestoredRuntime && thrustData?.runtimeState) {
			this.restoreRuntimeState(thrustData.runtimeState);
		}
	}

	/**
	 * Worker-only runtime state that is not carried by the per-frame buffer (save/load snapshot).
	 */
	getRuntimeState() {
		return {
			flightComputer: this.flightComputer ? this.flightComputer.getRuntimeState() : null,
			isBoosterIgnited: Boolean(this.isBoosterIgnited),
			boosterBurnTimer: this.boosterBurnTimer || 0,
			boosterSepTimer: this.boosterSepTimer || 0,
			presState: this.presState,
			presTimer: this.presTimer || 0,
			tankPresFuel: this.tankPresFuel || 0,
			tankPresOxid: this.tankPresOxid || 0,
			presStartF: this._presStartF || 0,
			presStartO: this._presStartO || 0,
			postSepRcsTimer: this._postSepRcsTimer || 0,
			ullageRestartTimer: this._ullageRestartTimer || 0,
			// Rev 6.11 (G3-1-01): the remaining Worker-only state that the next step reads before rewriting it
			thrustRatio: this._thrustRatio || 0,
			wasFiring: Boolean(this._wasFiring),
			massLossRate: this.massLossRate || 0,
			thrustForce: this.thrustForce || 0,
			thrustForceVac: this.thrustForceVac || 0,
			ispVac: this.ispVac || 0,
			ispSl: this.ispSl || 0,
			ofRatio: this.ofRatio || 0,
			fuelType: typeof this.fuelType === 'string' ? this.fuelType : null,
			hostAngleRad: this.hostAngleRad || 0,
			ventStartF: Number.isFinite(this._ventStartF) ? this._ventStartF : null,
			ventStartO: Number.isFinite(this._ventStartO) ? this._ventStartO : null,
			noiseFiltF: this._noiseFiltF || 0,
			noiseFiltO: this._noiseFiltO || 0,
			paramName: this._paramName || null,
			kinematics: this.getKinematicState()
		};
	}

	_getAeroCache() {
		return {
			currentQ: this._currentQ || 0,
			mach: this.mach || 0,
			qAxialKpa: this._qAxialKpa || 0,
			qLateralKpa: this._qLateralKpa || 0,
			aoaDeg: this._aoaDeg || 0,
			progradeAngle: this._progradeAngle || 0
		};
	}

	/** @param {any} aero */
	_applyAeroCache(aero) {
		super._applyAeroCache(aero);
		if (aero.qAxialKpa !== undefined) { this._qAxialKpa = aero.qAxialKpa; }
		if (aero.qLateralKpa !== undefined) { this._qLateralKpa = aero.qLateralKpa; }
		if (aero.aoaDeg !== undefined) { this._aoaDeg = aero.aoaDeg; }
		if (aero.progradeAngle !== undefined) { this._progradeAngle = aero.progradeAngle; }
	}

	/** @param {any} state value previously produced by getRuntimeState() */
	restoreRuntimeState(state) {
		if (!state || typeof state !== 'object') return;
		const maxT = SIMULATION.RUNTIME_RESTORE_MAX_TIME_S;
		const num = (v) => (Number.isFinite(v) ? Math.min(maxT, Math.max(0, v)) : 0);
		const kpa = (v) => (Number.isFinite(v) ? Math.min(TANK_PRESSURE_SIM.MAX_SCALE_KPA * 2, Math.max(0, v)) : 0);
		if (this.flightComputer && state.flightComputer) {
			this.flightComputer.restoreRuntimeState(state.flightComputer);
		}
		if (this.hasBoosters && this.currentStageIndex === 0 && !this.isBoosterBurnout && !this.isBoosterSeparated) {
			this.isBoosterIgnited = Boolean(state.isBoosterIgnited) && !this.isHoldDown && this.isIgnited;
		} else if (this.hasBoosters && (this.isBoosterBurnout || this.currentStageIndex >= 1) && typeof state.isBoosterIgnited === 'boolean') {
			// Rev 6.11: after burnout (or on an upper stage) the flag no longer selects the thrust model; keep the saved
			// value so that the restored state equals the saved one
			this.isBoosterIgnited = state.isBoosterIgnited;
		}
		this.boosterBurnTimer = num(state.boosterBurnTimer);
		this.boosterSepTimer = num(state.boosterSepTimer);
		if (TANK_PRESSURE_STATES.includes(state.presState)) {
			this.presState = state.presState;
		}
		this.presTimer = num(state.presTimer);
		this.tankPresFuel = kpa(state.tankPresFuel);
		this.tankPresOxid = kpa(state.tankPresOxid);
		this._presStartF = kpa(state.presStartF);
		this._presStartO = kpa(state.presStartO);
		this._postSepRcsTimer = num(state.postSepRcsTimer);
		this._ullageRestartTimer = num(state.ullageRestartTimer);

		// Rev 6.11 (G3-1-01). Each entry is optional (saves before Rev 6.11 keep the values derived by the constructor).
		// Thrust state of the last step: applyThrust() and the engine-start detection of updatePressure() read it first
		if (Number.isFinite(state.thrustRatio)) { this._thrustRatio = Math.min(1, Math.max(0, state.thrustRatio)); }
		if (typeof state.wasFiring === 'boolean') { this._wasFiring = state.wasFiring; }
		// Constant within a burn (not (fuel + oxid) / burnTime of the reduced values); hold-down and SRB phases set the forces
		const nonNeg = (v) => Number.isFinite(v) && v >= 0;
		if (nonNeg(state.massLossRate)) { this.massLossRate = state.massLossRate; }
		if (nonNeg(state.thrustForce)) { this.thrustForce = state.thrustForce; }
		if (nonNeg(state.thrustForceVac)) { this.thrustForceVac = state.thrustForceVac; }
		// Engine specs of the active stage / payload (a passive payload keeps those of the jettisoned upper stage)
		if (nonNeg(state.ispVac)) { this.ispVac = state.ispVac; }
		if (nonNeg(state.ispSl)) { this.ispSl = state.ispSl; }
		if (nonNeg(state.ofRatio)) { this.ofRatio = state.ofRatio; }
		if (typeof state.fuelType === 'string' && (state.fuelType in ROCKET_FUELS)) { this.fuelType = state.fuelType; }
		// The pad angle advances with the host's rotation during hold-down (the main thread keeps the rollout angle)
		if (Number.isFinite(state.hostAngleRad)) { this.hostAngleRad = state.hostAngleRad; }
		if (Number.isFinite(state.ventStartF)) { this._ventStartF = kpa(state.ventStartF); }
		if (Number.isFinite(state.ventStartO)) { this._ventStartO = kpa(state.ventStartO); }
		// Low-pass state of the sensor noise, in [-1, 1] by construction
		const unit = (v) => Math.min(1, Math.max(-1, v));
		if (Number.isFinite(state.noiseFiltF)) { this._noiseFiltF = unit(state.noiseFiltF); }
		if (Number.isFinite(state.noiseFiltO)) { this._noiseFiltO = unit(state.noiseFiltO); }
		this.restoreKinematicState(state.kinematics);
	}

	_activateStage(stageIdx) {
		const stage = this.stages[stageIdx];
		if (!stage) { return; }
		this.currentStageIndex = stageIdx;
		this.fuelType = stage.fuelType;
		this.thrustForce = UnitConvertUtils.kn2n(stage.thrustKN); // N
		this.thrustForceVac = this.thrustForce;
		this.burnTime = stage.burnTime; // s
		this.ofRatio = stage.ofRatio;

		this.dryMass = stage.dryMassT;
		this.fuelMass = stage.fuelMassT;
		this.oxidMass = stage.oxidMassT;

		const fuel = ROCKET_FUELS[this.fuelType] || ROCKET_FUELS['liquid'] || { isp: 320, ispVac: 320, ispSl: 282 };
		this.ispVac = stage.ispVac || stage.isp || fuel.ispVac || fuel.isp || 320;
		this.ispSl = stage.ispSl !== undefined ? stage.ispSl : (fuel.ispSl !== undefined ? fuel.ispSl : Math.round(this.ispVac * 0.88));

		const totalPropT = stage.fuelMassT + stage.oxidMassT;
		if (!this.burnTime || this.burnTime <= 0) {
			const totalPropKg = totalPropT * 1000;
			if (this.thrustForce > 0 && totalPropKg > 0) {
				this.burnTime = (totalPropKg * this.ispVac * PHYSICS.G0) / this.thrustForce;
			}
		}
		this.massLossRate = this.burnTime > 0 ? (totalPropT / this.burnTime) : 0; // t/s
		this.currentIsp = this.getEffectiveIsp(this.ambientPresRatio);

		this.updateTotalMass();
	}

	getEffectiveIsp(ambientPresRatio = this.ambientPresRatio || 0) {
		const p = Math.max(0, ambientPresRatio);
		if (this.hasBoosters && this.isBoosterIgnited && !this.isBoosterBurnout && this.currentStageIndex === 0) {
			const ispCore = Math.max(0, this.ispVac - (this.ispVac - this.ispSl) * p);
			const ispSrb = Math.max(0, this.boosterIspVac - (this.boosterIspVac - this.boosterIspSl) * p);
			const fCore = this.coreThrustVac * (this.ispVac > 0 ? (ispCore / this.ispVac) : 0);
			const fSrb = this.boosterThrustVac * (this.boosterIspVac > 0 ? (ispSrb / this.boosterIspVac) : 0);
			const totalF = fCore + fSrb;
			const mDot = (this.coreThrustVac / (Math.max(1, this.ispVac) * PHYSICS.G0)) + (this.boosterThrustVac / (Math.max(1, this.boosterIspVac) * PHYSICS.G0));
			return mDot > 0 ? (totalF / (mDot * PHYSICS.G0)) : ispCore;
		}
		return Math.max(0, this.ispVac - (this.ispVac - this.ispSl) * p);
	}

	getEffectiveThrustForce(ambientPresRatio = this.ambientPresRatio || 0) {
		const p = Math.max(0, ambientPresRatio);
		if (this.hasBoosters && this.isBoosterIgnited && !this.isBoosterBurnout && this.currentStageIndex === 0) {
			const ispCore = Math.max(0, this.ispVac - (this.ispVac - this.ispSl) * p);
			const ispSrb = Math.max(0, this.boosterIspVac - (this.boosterIspVac - this.boosterIspSl) * p);
			const fCore = this.coreThrustVac * (this.ispVac > 0 ? (ispCore / this.ispVac) : 0);
			const fSrb = this.boosterThrustVac * (this.boosterIspVac > 0 ? (ispSrb / this.boosterIspVac) : 0);
			return fCore + fSrb;
		}
		if (this.ispVac > 0) {
			const effIsp = Math.max(0, this.ispVac - (this.ispVac - this.ispSl) * p);
			const vacThrust = this.thrustForceVac || this.thrustForce;
			return vacThrust * (effIsp / this.ispVac);
		}
		return this.thrustForce;
	}

	updateTotalMass() {
		if (this.isPayloadSeparated) {
			if (this.hasPayloadPropulsion) {
				this.mass = (this.dryMass || 0) + (this.fuelMass || 0) + (this.oxidMass || 0);
			} else {
				this.mass = (this.payload?.massT || 0);
			}
			this.invMass = this.mass > 0 ? 1.0 / this.mass : 0;
			this.invMassKg = this.mass > 0 ? 1.0 / (this.mass * 1000) : 0;
			return this.mass;
		}

		let total = (this.payload?.massT || 0);
		if (this.fairing?.enabled && !this.fairing.isSeparated) {
			total += (this.fairing.massT || 0);
		}
		// Active stage
		total += (this.dryMass + this.fuelMass + this.oxidMass);

		// Upper stages not yet activated
		for (let i = this.currentStageIndex + 1; i < this.stages.length; i++) {
			const stg = this.stages[i];
			total += (stg.dryMassT + stg.fuelMassT + stg.oxidMassT);
		}

		this.mass = total;
		this.invMass = this.mass > 0 ? 1.0 / this.mass : 0;
		this.invMassKg = this.mass > 0 ? 1.0 / (this.mass * 1000) : 0;
		return this.mass;
	}

	separateCurrentStage() {
		if (this.disableStaging) { return; }
		const stage = this.stages[this.currentStageIndex];
		if (!stage) { return; }

		this._postSepRcsTimer = RCS_CONFIG.POST_SEP_SETTLE_S;

		// 1. Calculate jettison velocity & position
		const sepAngle = this.thrustAngle + Math.PI; // Backward
		const sepSpeedM = stage.jettisonSpeedM_S || MULTISTAGE_ROCKET.DEFAULT_JETTISON_SPEED_M_S;
		let sepVx = this.vx + Math.cos(sepAngle) * sepSpeedM;
		let sepVy = this.vy + Math.sin(sepAngle) * sepSpeedM;

		const isFinalStage = (this.currentStageIndex + 1 >= this.totalStages);

		// If final stage (Upper stage releasing payload), apply automated deorbit burn to upper stage debris
		if (isFinalStage && MULTISTAGE_ROCKET.STAGE2_DEORBIT_BURN_ENABLED) {
			let ref = this._lastDominantBody;
			if ((!ref || ref.name === 'Sun') && this.dominantBody && this.dominantBody.name !== 'Sun') {
				ref = this.dominantBody;
			}
			const domVx = ref ? (ref.vx || 0) : 0;
			const domVy = ref ? (ref.vy || 0) : 0;
			const relVx = this.vx - domVx;
			const relVy = this.vy - domVy;
			const currentRelSpeed = Math.hypot(relVx, relVy);
			if (currentRelSpeed > 0) {
				const deorbitAngle = Math.atan2(relVy, relVx) + Math.PI; // retrograde relative to dominant celestial body
				const deorbitDv = MULTISTAGE_ROCKET.STAGE2_DEORBIT_DELTA_V_M_S || 180.0;
				sepVx += Math.cos(deorbitAngle) * deorbitDv;
				sepVy += Math.sin(deorbitAngle) * deorbitDv;
			}
		}

		// Scale physical radius with rocket base body radius to unify zoom magnification (1:1 with rocket)
		const baseRad = this.baseRadiusM || (this.radius > 100 ? this.radius / 3.10 : this.radius);
		const debrisRadius = isFinalStage
			? (baseRad * (MULTISTAGE_ROCKET.STAGE2_RADIUS_RATIO || 1.0))
			: (baseRad * (MULTISTAGE_ROCKET.STAGE1_RADIUS_RATIO || 1.0));

		const sepOffsetDist = baseRad * 1.5 + 20.0;

		// 2. Queue spent stage debris with parentRocketId to ignore self-collision
		this._pendingDebris.push({
			name: isFinalStage ? `${this.name} - Stage ${stage.stageNumber} Upper Stage` : `${this.name} - Stage ${stage.stageNumber} Booster`,
			debrisSubType: isFinalStage ? 2 : 1,
			x: this.x - Math.cos(this.thrustAngle) * sepOffsetDist,
			y: this.y - Math.sin(this.thrustAngle) * sepOffsetDist,
			vx: sepVx,
			vy: sepVy,
			mass: stage.dryMassT,
			radius: debrisRadius,
			color: '#d0d8e0',
			parentRocketId: this.id
		});

		// 3. Positive forward push impulse to upper craft
		const forwardPush = MULTISTAGE_ROCKET.STAGE_SEP_FORWARD_PUSH_M_S;
		this.vx += Math.cos(this.thrustAngle) * forwardPush;
		this.vy += Math.sin(this.thrustAngle) * forwardPush;

		// If fairing is still attached when the final stage is jettisoned (payload release),
		// force fairing separation to ensure the payload satellite is never trapped inside the fairing.
		if (isFinalStage && this.fairing?.enabled && !this.fairing.isSeparated) {
			let curAltM = Infinity;
			if (this._lastDominantBody && this._lastDistToRefM !== undefined) {
				curAltM = this._lastDistToRefM - this._lastDominantBody.radius;
			} else if (this._lastDominantBody) {
				curAltM = Math.hypot(this.x - this._lastDominantBody.x, this.y - this._lastDominantBody.y) - this._lastDominantBody.radius;
			}
			this.separateFairing(curAltM, true);
		}

		// If boosters were not yet separated from Stage 1, mark separated to prevent orphan booster separation later
		if (this.hasBoosters && !this.isBoosterSeparated) {
			this.isBoosterSeparated = true;
		}

		// 4. Advance to next stage or finish with payload separation
		if (!isFinalStage) {
			this.currentStageIndex++;
			if (this.currentStageIndex >= 2) {
				this.isStage2Separated = true;
			}
			this._activateStage(this.currentStageIndex);
			this.isIgnited = false;
			this.stageState = 'INTERSTAGE_COAST';
			this.stgTimer = 0;
			this.presState = 'POST_MECO_HOLD';
			this.presTimer = 0;
		} else {
			// Final stage jettisoned: The remaining craft is the payload
			this.currentStageIndex = this.totalStages;
			this.isPayloadSeparated = true;
			this.isStage2Separated = Boolean(this.isStage2Separated || this.totalStages <= 2 || this.currentStageIndex >= 2);
			if (this.payload?.radius) {
				this.radius = this.payload.radius;
			}
			if (this.payload?.name) {
				this.name = this.payload.name;
			}

			if (this.payload?.propulsion?.enabled) {
				this.hasPayloadPropulsion = true;
				const prop = this.payload.propulsion;
				this.dryMass = prop.dryMassT || 0;
				this.fuelMass = prop.fuelMassT || 0;
				this.oxidMass = prop.oxidMassT || 0;
				this.thrustForce = ((prop.thrustKN ?? prop.thrustKn ?? 0)) * 1000; // N
				this.thrustForceVac = this.thrustForce;
				const fuel = ROCKET_FUELS[prop.fuelType] || ROCKET_FUELS['liquid'] || { isp: 320, ispVac: 320, ispSl: 282 };
				this.ispVac = prop.ispVac || prop.isp || fuel.ispVac || fuel.isp || 320;
				this.ispSl = prop.ispSl !== undefined ? prop.ispSl : (fuel.ispSl !== undefined ? fuel.ispSl : Math.round(this.ispVac * 0.88));
				this.ofRatio = prop.ofRatio || 0;
				const totalPropT = this.fuelMass + this.oxidMass;
				const totalPropKg = totalPropT * 1000;
				if (prop.burnTime && prop.burnTime > 0) {
					this.burnTime = prop.burnTime;
				} else if (this.thrustForce > 0 && totalPropKg > 0) {
					this.burnTime = (totalPropKg * this.ispVac * PHYSICS.G0) / this.thrustForce;
				} else {
					this.burnTime = 0;
				}
				this.massLossRate = this.burnTime > 0 ? (totalPropT / this.burnTime) : 0;
				this.currentIsp = this.getEffectiveIsp(this.ambientPresRatio);
				this.updateTotalMass();

				this.stageState = 'STG_COAST';
				this.isIgnited = false;
				this.presState = 'POST_MECO_HOLD';
				this.presTimer = 0;
			} else {
				this.hasPayloadPropulsion = false;
				this.dryMass = 0;
				this.fuelMass = 0;
				this.oxidMass = 0;
				this.burnTime = 0;
				this.thrustForce = 0;
				this.massLossRate = 0;
				this.updateTotalMass();

				this.stageState = 'ORBITAL_COAST';
				this.isIgnited = false;
				this.presState = 'POST_MECO_VENT';
				this.presTimer = 0;
			}
		}
	}

	separateFairing(curAltM, force = false) {
		if (this.disableStaging || !this.fairing.enabled || this.fairing.isSeparated) { return; }

		const sepAltM = (this.fairing.separationAltKm || MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM) * 1000;
		if (force || curAltM >= sepAltM) {
			this.fairing.isSeparated = true;
			this._postSepRcsTimer = RCS_CONFIG.POST_SEP_SETTLE_S;
			this.updateTotalMass();

			const latAngle1 = this.thrustAngle + Math.PI / 2;
			const latAngle2 = this.thrustAngle - Math.PI / 2;
			const sepSpeedLat = MULTISTAGE_ROCKET.FAIRING_SEP_LATERAL_SPEED_M_S;
			const sepSpeedBack = MULTISTAGE_ROCKET.FAIRING_SEP_BACKWARD_SPEED_M_S;

			const halfMass = this.fairing.massT / 2;
			const baseRad = this.baseRadiusM || (this.radius > 100 ? this.radius / 3.10 : this.radius);
			const offset = baseRad * 1.2 + 15.0;
			const fairingRadius = baseRad * (MULTISTAGE_ROCKET.FAIRING_RADIUS_RATIO || 1.0);

			const vx1 = this.vx + Math.cos(latAngle1) * sepSpeedLat + Math.cos(this.thrustAngle) * sepSpeedBack;
			const vy1 = this.vy + Math.sin(latAngle1) * sepSpeedLat + Math.sin(this.thrustAngle) * sepSpeedBack;

			const vx2 = this.vx + Math.cos(latAngle2) * sepSpeedLat + Math.cos(this.thrustAngle) * sepSpeedBack;
			const vy2 = this.vy + Math.sin(latAngle2) * sepSpeedLat + Math.sin(this.thrustAngle) * sepSpeedBack;

			this._pendingDebris.push({
				name: `${this.name} - Fairing Half A`,
				debrisSubType: 3,
				x: this.x + Math.cos(latAngle1) * offset,
				y: this.y + Math.sin(latAngle1) * offset,
				vx: vx1,
				vy: vy1,
				mass: halfMass,
				radius: fairingRadius,
				color: '#e0e0e0',
				parentRocketId: this.id
			});

			this._pendingDebris.push({
				name: `${this.name} - Fairing Half B`,
				debrisSubType: 3,
				x: this.x + Math.cos(latAngle2) * offset,
				y: this.y + Math.sin(latAngle2) * offset,
				vx: vx2,
				vy: vy2,
				mass: halfMass,
				radius: fairingRadius,
				color: '#e0e0e0',
				parentRocketId: this.id
			});
		}
	}

	separateBoosters() {
		if (this.disableStaging || this.isBoosterSeparated || !this.hasBoosters) { return; }

		this.isBoosterSeparated = true;
		this._postSepRcsTimer = RCS_CONFIG.POST_SEP_SETTLE_S;
		const boosterDryMass = this.boosters.dryMassT || (this.boosters.count === 4 ? 40.0 : 20.0);

		if (this.stages && this.stages[0]) {
			this.stages[0].dryMassT = Math.max(0, (this.stages[0].dryMassT || 0) - boosterDryMass);
			this.dryMass = Math.max(0, this.dryMass - boosterDryMass);
			this.updateTotalMass();
		}

		const count = this.boosters.count || 2;
		const baseRad = this.baseRadiusM || (this.radius > 100 ? this.radius / 3.10 : this.radius);
		const boosterRadius = baseRad;
		const massPerBooster = boosterDryMass / count;
		const sepSpeedLat = this.boosters.jettisonSpeedM_S || MULTISTAGE_ROCKET.BOOSTER_SEP_LATERAL_SPEED_M_S || 12.0;
		const sepSpeedBack = MULTISTAGE_ROCKET.BOOSTER_SEP_BACKWARD_SPEED_M_S || -1.0;
		const offsetDist = baseRad * 1.5 + 8.0;

		const latAngle1 = this.thrustAngle + Math.PI / 2;
		const latAngle2 = this.thrustAngle - Math.PI / 2;

		// Calculate mounting geometry (lateral angle and optional axial offset) for each booster
		const boosterSlots = [];
		if (count === 2) {
			boosterSlots.push({ latAngle: latAngle1, axialOffset: 0 });
			boosterSlots.push({ latAngle: latAngle2, axialOffset: 0 });
		} else if (count === 4) {
			const axialOffset = baseRad * 0.4;
			boosterSlots.push({ latAngle: latAngle1, axialOffset: axialOffset });
			boosterSlots.push({ latAngle: latAngle1, axialOffset: -axialOffset });
			boosterSlots.push({ latAngle: latAngle2, axialOffset: axialOffset });
			boosterSlots.push({ latAngle: latAngle2, axialOffset: -axialOffset });
		} else {
			for (let i = 0; i < count; i++) {
				boosterSlots.push({
					latAngle: (i % 2 === 0) ? latAngle1 : latAngle2,
					axialOffset: 0
				});
			}
		}

		// Single unified loop to spawn booster debris
		for (let i = 0; i < boosterSlots.length; i++) {
			const slot = boosterSlots[i];
			const backImpulse = sepSpeedBack + (slot.axialOffset !== 0 ? (slot.axialOffset > 0 ? 0.5 : -0.5) : 0);
			const vx = this.vx + Math.cos(slot.latAngle) * sepSpeedLat + Math.cos(this.thrustAngle) * backImpulse;
			const vy = this.vy + Math.sin(slot.latAngle) * sepSpeedLat + Math.sin(this.thrustAngle) * backImpulse;

			const posX = this.x + Math.cos(slot.latAngle) * offsetDist + Math.cos(this.thrustAngle) * slot.axialOffset;
			const posY = this.y + Math.sin(slot.latAngle) * offsetDist + Math.sin(this.thrustAngle) * slot.axialOffset;

			this._pendingDebris.push({
				name: `${this.name} - ${this.boosters.name || 'SRB'} Booster ${i + 1}`,
				debrisSubType: 4,
				x: posX,
				y: posY,
				vx: vx,
				vy: vy,
				mass: massPerBooster,
				radius: boosterRadius,
				color: this.boosters.casingColor || '#f0f2f5',
				parentRocketId: this.id
			});
		}
	}

	_isCurrentStageSepDeferred() {
		const fc = this.flightComputer;
		if (!fc || this.isPayloadSeparated) return false;
		const cur = this.currentStageIndex || 0;
		const total = this.totalStages || 1;
		if (cur === 0 && total >= 2) {
			return fc.hasScheduledAction('sep_stage1');
		}
		if (cur === 1 && total >= 3) {
			return fc.hasScheduledAction('sep_stage2');
		}
		if (cur === total - 1) {
			return fc.hasScheduledAction('sep_payload') || (total === 2 && cur === 1 && fc.hasScheduledAction('sep_stage2'));
		}
		return false;
	}

	_isPayloadSepDeferred() {
		const fc = this.flightComputer;
		if (!fc || this.isPayloadSeparated) return false;
		if (fc.hasScheduledAction('sep_payload')) return true;
		return Boolean((this.totalStages || 1) === 2 && (this.currentStageIndex || 0) === 1 && fc.hasScheduledAction('sep_stage2'));
	}

	separatePayload() {
		if (this.disableStaging || this.isPayloadSeparated) { return; }

		if (this.fairing?.enabled && !this.fairing.isSeparated) {
			let curAltM = Infinity;
			if (this._lastDominantBody && this._lastDistToRefM !== undefined) {
				curAltM = this._lastDistToRefM - this._lastDominantBody.radius;
			} else if (this._lastDominantBody) {
				curAltM = Math.hypot(this.x - this._lastDominantBody.x, this.y - this._lastDominantBody.y) - this._lastDominantBody.radius;
			}
			this.separateFairing(curAltM, true);
		}

		let guard = 0;
		const maxGuard = (this.totalStages || 1) + 2;
		while (!this.isPayloadSeparated && this.currentStageIndex < this.totalStages && guard < maxGuard) {
			guard++;
			this.fuelMass = 0;
			this.oxidMass = 0;
			this.burnTime = 0;
			this.isIgnited = false;
			this._thrustRatio = 0;
			this.separateCurrentStage();
		}
		this._postSepRcsTimer = RCS_CONFIG.POST_SEP_SETTLE_S;
	}

	executeProfileAction(action) {
		if (this.disableStaging || !action) { return; }

		if (action === 'sep_stage1') {
			if (!this.isPayloadSeparated && this.currentStageIndex === 0 && this.totalStages >= 2) {
				this.fuelMass = 0;
				this.oxidMass = 0;
				this.burnTime = 0;
				this.isIgnited = false;
				this._thrustRatio = 0;
				this.separateCurrentStage();
			}
		} else if (action === 'sep_stage2') {
			if (!this.isPayloadSeparated && this.currentStageIndex === 1) {
				this.fuelMass = 0;
				this.oxidMass = 0;
				this.burnTime = 0;
				this.isIgnited = false;
				this._thrustRatio = 0;
				this.separateCurrentStage();
			}
		} else if (action === 'sep_payload') {
			this.separatePayload();
		}
	}

	_updateRcsState(dt, currentThrustN, preUpdateAngle) {
		this._postSepRcsTimer = Math.max(0, (this._postSepRcsTimer || 0) - dt);
		this._ullageRestartTimer = Math.max(0, (this._ullageRestartTimer || 0) - dt);

		if (this.isHoldDown || this.collided || this.shattered) {
			this.rcsCw = false;
			this.rcsCcw = false;
			this.rcsUllage = false;
			if (this.flightComputer?.telemetryCache) {
				this.flightComputer.telemetryCache.rcsCw = false;
				this.flightComputer.telemetryCache.rcsCcw = false;
				this.flightComputer.telemetryCache.rcsUllage = false;
			}
			return;
		}

		const targetAngle = this.autoControl
			? (this.flightComputer?.desiredThrustAngleRad ?? preUpdateAngle)
			: preUpdateAngle;
		const err = MathUtils.normalizeAngle(targetAngle - preUpdateAngle);

		const allowRcs = (this.ambientPresRatio <= RCS_CONFIG.LOW_AERO_PRES_RATIO)
			|| (currentThrustN <= 0)
			|| (Math.abs(err) > RCS_CONFIG.SLEW_CONTINUOUS_RAD)
			|| (this._postSepRcsTimer > 0);

		const tPulse = this.flightComputer?.flightTime || 0;
		const pulseOn = (tPulse % RCS_CONFIG.PULSE_PERIOD_S) < (RCS_CONFIG.PULSE_PERIOD_S * RCS_CONFIG.PULSE_DUTY);

		let rcsCw = false;
		let rcsCcw = false;
		if (allowRcs) {
			if (err > RCS_CONFIG.ATTITUDE_DEADBAND_RAD) {
				rcsCw = (err >= RCS_CONFIG.SLEW_CONTINUOUS_RAD || this._postSepRcsTimer > 0) ? true : pulseOn;
			} else if (err < -RCS_CONFIG.ATTITUDE_DEADBAND_RAD) {
				rcsCcw = (-err >= RCS_CONFIG.SLEW_CONTINUOUS_RAD || this._postSepRcsTimer > 0) ? true : pulseOn;
			} else if (this._postSepRcsTimer > 0) {
				const period = RCS_CONFIG.POST_SEP_DAMP_PERIOD_S;
				const pulseW = RCS_CONFIG.POST_SEP_DAMP_PULSE_S;
				const phase = this._postSepRcsTimer % period;
				rcsCw = phase < pulseW;
				rcsCcw = (phase >= period * 0.5) && (phase < period * 0.5 + pulseW);
			}
		}

		const nextStage = this.stages[this.currentStageIndex];
		const ignDelay = nextStage?.ignitionDelaySec ?? MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC;
		const isPreIgnUllage = (this.stageState === 'INTERSTAGE_COAST') && ((ignDelay - this.stgTimer) <= RCS_CONFIG.ULLAGE_PRE_IGNITION_S);
		const rcsUllage = isPreIgnUllage || (this._ullageRestartTimer > 0);

		this.rcsCw = rcsCw;
		this.rcsCcw = rcsCcw;
		this.rcsUllage = rcsUllage;
		if (this.flightComputer?.telemetryCache) {
			this.flightComputer.telemetryCache.rcsCw = rcsCw;
			this.flightComputer.telemetryCache.rcsCcw = rcsCcw;
			this.flightComputer.telemetryCache.rcsUllage = rcsUllage;
		}
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
		} else if (cmd === 'RELEASE_HOLD_DOWN') {
			this.isHoldDown = false;
			if (this.stageState === 'PRE_LAUNCH') {
				this.stageState = 'STG_BURNING';
				this.stgTimer = 0;
			}
		}
	}

	_determinDynamicParam(vRelY, vRelX, vRelSq, rho) {
		let area = 0; // m^2
		let cd = AERO_DYNAMIC.ROCKET_DEFAULT_CD;

		const objParam = this.objParam || (typeof presetManager !== 'undefined' ? presetManager.getObjectParam(this.name) : null);
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
		const objParam = this.objParam || (typeof presetManager !== 'undefined' ? presetManager.getObjectParam(this.name) : null);
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

	flightControl(dt, refBody, distToRefM, sunBody = null) {
		let actualDt = 0; // s
		let throttle = 1.0;

		// Calculate true prograde angle (relative to dominant body if available, else world)
		let progVx = this.vx;
		let progVy = this.vy;
		if (refBody) {
			progVx -= refBody.vx;
			progVy -= refBody.vy;
		}
		const trueProgradeAngle = (progVx * progVx + progVy * progVy > 1e-4) ? Math.atan2(progVy, progVx) : this.thrustAngle;
		if (!this.inAtmosphere || this._progradeAngle === undefined) {
			this._progradeAngle = trueProgradeAngle;
		}

		// Record last known dominant body and distance for staging altitude checks
		this._lastDominantBody = refBody;
		this._lastDistToRefM = distToRefM;

		// Fallback sun finding if sunBody not explicitly provided
		const effectiveSun = sunBody || (refBody?.name === 'Sun' ? refBody : null);

		this.currentIsp = this.getEffectiveIsp(this.ambientPresRatio);
		const effThrustForce = this.getEffectiveThrustForce(this.ambientPresRatio);

		// Populate cached sensor object (Zero-allocation design) to prevent GC spike
		this._sensorData.dt = dt;
		this._sensorData.mass = this.mass;
		this._sensorData.dryMass = this.dryMass;
		this._sensorData.fuelMass = this.fuelMass + this.oxidMass;
		this._sensorData.thrustForce = effThrustForce;
		this._sensorData.thrustRatio = this._thrustRatio;
		this._sensorData.burnTime = this.burnTime;
		this._sensorData.massLossRate = this.massLossRate;
		this._sensorData.currentIsp = this.currentIsp;
		this._sensorData.ambientPresRatio = this.ambientPresRatio;
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
		this._sensorData.stageState = this.stageState;
		this._sensorData.stageIndex = this.currentStageIndex !== undefined ? this.currentStageIndex : 0;
		this._sensorData.stages = this.stages;
		this._sensorData.isPayloadSeparated = this.isPayloadSeparated;
		this._sensorData.targetApogeeKm = this.targetApogeeKm;
		this._sensorData.targetPerigeeKm = this.targetPerigeeKm;
		this._sensorData.disableOrbitalCutoff = this.disableOrbitalCutoff;
		this._sensorData.sunX = effectiveSun ? effectiveSun.x : undefined;
		this._sensorData.sunY = effectiveSun ? effectiveSun.y : undefined;

		const preUpdateAngle = this.thrustAngle;
		this.flightComputer.update(this._sensorData);
		this.flightComputer.telemetryCache.mach = this.mach || 0;

		if (this.autoControl) {
			throttle = this.flightComputer.currentThrottle;
			this.thrustAngle = this.flightComputer.currentThrustAngleRad;
		} else {
			throttle = 1.0;
		}

		// Execute discrete separation actions triggered by flight profile (independent latch), in a flight step only
		// (design §3.4-1): the MET stays 0 on the pad, so a row at time 0 (or alt / vel below the pad's) latches while
		// the rocket is held down, and its action waits there until the first step after the release. An evaluation
		// that advances no time (dt = 0: the predictor's evaluation at liftoff, which stands for the pad) waits too
		if (!this.isHoldDown && dt > 0) {
			const pendingActions = this.flightComputer.consumePendingActions();
			for (let i = 0; i < pendingActions.length; i++) {
				this.executeProfileAction(pendingActions[i]);
			}
		}

		// Check fairing separation
		if (!this.disableStaging && distToRefM && refBody) {
			const curAltM = distToRefM - refBody.radius;
			this.separateFairing(curAltM);
		}

		// Check Orbital Insertion Cutoff (SECO) or commanded throttle cutoff when autoControl is active
		if (this.autoControl && !this.disableStaging) {
			const isFinalStage = (this.currentStageIndex + 1 >= this.totalStages);

			const hasPendingProfileBurns = Boolean(this.flightComputer?.hasPendingBurnStep());

			// 1. Autonomous orbital insertion cutoff outside dense atmosphere
			const isPayloadBurning = (this.isPayloadSeparated && this.hasPayloadPropulsion && this.stageState === 'STG_BURNING');
			if (((!this.isPayloadSeparated && isFinalStage && (this.totalStages === 1 || this.currentStageIndex >= 1)) || isPayloadBurning) && this.stageState === 'STG_BURNING' && refBody && distToRefM > 0) {
				const curAltM = distToRefM - refBody.radius;
				if (curAltM >= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_MIN_ALT_M) {
					const GM = PHYSICS.G * refBody.mass;
					const r = distToRefM;
					const dvx = this.vx - refBody.vx;
					const dvy = this.vy - refBody.vy;
					const v = Math.hypot(dvx, dvy);
					const E = 0.5 * v * v - GM / r;

					if (E < 0) {
						const dx = this.x - refBody.x;
						const dy = this.y - refBody.y;
						const h = dx * dvy - dy * dvx;
						const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
						const a = -GM / (2 * E);
						const peKm = (a * (1 - ecc) - refBody.radius) / 1000;
						const apKm = (a * (1 + ecc) - refBody.radius) / 1000;

						// Cutoff when:
						// 1. Target Apogee is reached outside atmosphere (e.g. GTO at 35,786 km, Lunar at 384,400 km, or circular rendezvous at 400 km)
						const isCircularTarget = Boolean(this.targetApogeeKm > 0 && this.targetPerigeeKm > 0 && (this.targetApogeeKm / this.targetPerigeeKm) <= 1.5);
						const isTargetApogeeReached = isCircularTarget
							? (apKm >= this.targetApogeeKm * 0.95 && (peKm >= this.targetPerigeeKm * 0.95 || (ecc <= 0.04 && peKm >= 140)))
							: (this.targetApogeeKm > 0 && apKm >= this.targetApogeeKm && peKm >= 100);
						// 2. Standard safe perigee / circularization cutoff (LEO, ISS)
						const isStandardCutoff = (!this.targetApogeeKm && !this.disableOrbitalCutoff && !this.flightComputer?.disableOrbitalCutoff && (peKm >= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_SAFE_PE_KM || (ecc <= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_MAX_ECC && peKm >= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_CIRCULAR_MIN_PE_KM)));

						if (isTargetApogeeReached || isStandardCutoff) {
							this.burnTime = 0;
							this.fuelMass = 0;
							this.oxidMass = 0;
							this.thrustForce = 0;
							this.isIgnited = false;
							if (this.isPayloadSeparated || this._isPayloadSepDeferred()) {
								this.stageState = 'ORBITAL_COAST';
								this.presState = 'POST_MECO_VENT';
							} else {
								this.stageState = 'STG_MECO';
								this.stgTimer = 0;
								if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
									this.presState = 'MECO_TRANSIENT';
									this.presTimer = 0;
								}
							}
							this.updateTotalMass();
						}
					} else if (!this.isPayloadSeparated && (this.disableOrbitalCutoff || this.targetVInfKmS > 0) && E >= 0 && this.targetVInfKmS > 0) {
						const vInfKmS = Math.sqrt(2 * E) / 1000;
						if (vInfKmS >= this.targetVInfKmS) {
							this.burnTime = 0;
							this.fuelMass = 0;
							this.oxidMass = 0;
							this.thrustForce = 0;
							this.isIgnited = false;
							if (this._isPayloadSepDeferred()) {
								this.stageState = 'ORBITAL_COAST';
								this.presState = 'POST_MECO_VENT';
							} else {
								this.stageState = 'STG_MECO';
								this.stgTimer = 0;
								if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
									this.presState = 'MECO_TRANSIENT';
									this.presTimer = 0;
								}
							}
							this.updateTotalMass();
						}
					}
				}
			}

			// 2. Commanded Coast (throttle <= 0 while burning) vs Re-ignition (throttle > 0 while coasting)
			if (this.stageState === 'STG_BURNING' && throttle <= 0 && (this.flightComputer?.flightTime || 0) > MULTISTAGE_ROCKET.COMMANDED_CUTOFF_MIN_FLIGHT_TIME_SEC && this.burnTime > 0) {
				let orbitComplete = false;
				if (!this.isPayloadSeparated && isFinalStage && refBody && distToRefM > 0) {
					const GM = PHYSICS.G * refBody.mass;
					const dvx = this.vx - refBody.vx;
					const dvy = this.vy - refBody.vy;
					const v = Math.hypot(dvx, dvy);
					const E = 0.5 * v * v - GM / distToRefM;
					if (E < 0) {
						const dx = this.x - refBody.x;
						const dy = this.y - refBody.y;
						const h = dx * dvy - dy * dvx;
						const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
						const a = -GM / (2 * E);
						const peKm = (a * (1 - ecc) - refBody.radius) / 1000;
						if (peKm >= MULTISTAGE_ROCKET.ORBITAL_CUTOFF_CIRCULAR_MIN_PE_KM) {
							orbitComplete = true;
						}
					}
				}

				if (orbitComplete && !hasPendingProfileBurns) {
					this.burnTime = 0;
					this.stageState = 'STG_MECO';
					this.stgTimer = 0;
					if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
						this.presState = 'MECO_TRANSIENT';
						this.presTimer = 0;
					}
					this.updateTotalMass();
				} else {
					// Coast mode: hold fuel and stage, extinguish engine
					this.stageState = 'STG_COAST';
					this.isIgnited = false;
					this._thrustRatio = 0.0;
					this.presState = 'POST_MECO_HOLD';
					this.presTimer = 0;
				}
			} else if (this.stageState === 'STG_COAST' && throttle > 0 && this.burnTime > 0) {
				// Re-ignite engine from Coast mode!
				this.stageState = 'STG_BURNING';
				this.isIgnited = true;
				this._ullageRestartTimer = RCS_CONFIG.ULLAGE_POST_COAST_S;
				this.presState = 'IGNITION_TRANSIENT';
				this.presTimer = 0;
			}
		}

		// Handle Staging State Machine
		if (!this.disableStaging) {
			const curStage = this.stages[this.currentStageIndex];
			if (this.stageState === 'PRE_LAUNCH') {
				if (this.isIgnited && !this.isHoldDown) {
					this.stageState = 'STG_BURNING';
					this.stgTimer = 0;
				}
			} else if (this.stageState === 'STG_MECO') {
				this.stgTimer += dt;
				const sepDelay = curStage ? curStage.separationDelaySec : MULTISTAGE_ROCKET.DEFAULT_SEPARATION_DELAY_SEC;
				if (!this._isCurrentStageSepDeferred() && this.stgTimer >= sepDelay) {
					this.separateCurrentStage();
				}
			} else if (this.stageState === 'INTERSTAGE_COAST') {
				this.stgTimer += dt;
				const nextStage = this.stages[this.currentStageIndex];
				const ignDelay = nextStage ? nextStage.ignitionDelaySec : MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC;
				if (this.stgTimer >= ignDelay) {
					this.isIgnited = true;
					this.stageState = 'STG_BURNING';
					this.stgTimer = 0;
					this.presState = 'IGNITION_TRANSIENT';
					this.presTimer = 0;
				}
			}
		}

		// Force cut throttle before ignition or during coast
		if (!this.isIgnited || this.stageState === 'INTERSTAGE_COAST' || this.stageState === 'STG_MECO' || this.stageState === 'STG_COAST' || this.stageState === 'ORBITAL_COAST') {
			throttle = 0;
		}

		const currentThrustN = (this.burnTime > 0 && throttle > 0) ? (this.thrustForce || 0) * throttle : 0;
		if (this.trackRcsVisualState) this._updateRcsState(dt, currentThrustN, preUpdateAngle);

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

			// Refresh mass and inverse mass automatically using multi-stage logic
			this.updateTotalMass();

			if (this.burnTime <= 0 || this.fuelMass <= 0 || (this.ofRatio > 0 && this.oxidMass <= 0)) {
				if (this.presState === 'NOMINAL' || this.presState === 'IGNITION_TRANSIENT') {
					this.presState = 'MECO_TRANSIENT';
					this.presTimer = 0;
				}
				this.fuelMass = 0;
				this.oxidMass = 0;
				this.burnTime = 0;
				this.isIgnited = false;
				this._thrustRatio = 0.0;
				this.updateTotalMass();

				if (this.stageState === 'STG_BURNING') {
					if (this.isPayloadSeparated) {
						this.stageState = 'ORBITAL_COAST';
						this.thrustForce = 0;
					} else {
						this.stageState = 'STG_MECO';
						this.stgTimer = 0;
					}
				}
			}
		}

		// Booster Burnout and Separation State Machine
		if (this.hasBoosters && !this.isBoosterSeparated && this.currentStageIndex === 0) {
			if (!this.isBoosterBurnout) {
				if (!this.isHoldDown && this.isIgnited) {
					// Liftoff achieved: ignite SRB solid boosters!
					if (!this.isBoosterIgnited) {
						this.isBoosterIgnited = true;
						const fullKN = this.stages?.[0]?.thrustKN || ((this.boosters.thrustKN || 4310) + (this.boosters.coreThrustKN || 2940));
						this.thrustForce = UnitConvertUtils.kn2n(fullKN);
					}
					this.boosterBurnTimer += dt;
					const boosterBurnTime = this.boosters.burnTimeSec || 105.0;
					const flightTime = this.flightComputer?.flightTime ?? this.boosterBurnTimer;
					if (this.boosterBurnTimer >= boosterBurnTime || flightTime >= boosterBurnTime) {
						this.isBoosterBurnout = true;
						const coreKN = this.boosters.coreThrustKN || 2940.0;
						this.thrustForce = UnitConvertUtils.kn2n(coreKN);
						this.thrustForceVac = this.thrustForce;
						if (this.burnTime > 0) {
							const remPropT = this.fuelMass + this.oxidMass;
							this.massLossRate = remPropT / this.burnTime;
						}
					}
				} else if (this.isHoldDown && this.isIgnited) {
					// Hold-down active: core engines firing, boosters on standby
					this.isBoosterIgnited = false;
					const coreKN = this.boosters.coreThrustKN || 2940.0;
					this.thrustForce = UnitConvertUtils.kn2n(coreKN);
					this.thrustForceVac = this.thrustForce;
				}
			} else {
				this.boosterSepTimer += dt;
				const sepDelay = this.boosters.separationDelaySec !== undefined ? this.boosters.separationDelaySec : 1.5;
				if (this.boosterSepTimer >= sepDelay) {
					this.separateBoosters();
				}
			}
		}

		this.updatePressure(dt, this.flightComputer.getTelemetry().structRatio);
		this._thrustRatio = dt > 0 ? (actualDt / dt) : 0;
	}

	applyThrust() {
		if (this._thrustRatio > 0 && this.mass > 0) {
			const effThrustForce = this.getEffectiveThrustForce(this.ambientPresRatio);
			const invM_kg = this.invMassKg || (this.invMass / 1000);
			const thrustAx = (effThrustForce * Math.cos(this.thrustAngle)) * invM_kg; // m/s^2
			const thrustAy = (effThrustForce * Math.sin(this.thrustAngle)) * invM_kg; // m/s^2

			this.ax += thrustAx * this._thrustRatio;
			this.ay += thrustAy * this._thrustRatio;
		}
	}

	clearAerodynamicParameters() {
		this.inAtmosphere = false;
		this.ambientPresRatio = 0.0;
		this._currentQ = 0;
		this._qAxialKpa = 0;
		this._qLateralKpa = 0;
		this.mach = 0;
	}
}

/*******************************************************************
 * Calculation Object Class for Debris
 *******************************************************************/
export class CalcDebris extends GravSimCalcObject {
	constructor(id, name, x, y, vx, vy, ax, ay, radius, generation, mass, debrisSubType = 0, parentRocketId = null) {
		super(id, name, OBJECT_TYPES.DEBRIS, x, y, vx, vy, ax, ay, radius, generation);
		this.mass = mass; // t
		this.invMass = mass > 0 ? 1.0 / mass : 0; // 1/t
		this.debrisSubType = debrisSubType;
		this.parentRocketId = parentRocketId;
	}

	/** Worker-only state for save/load: exact kinematics and the parent rocket (no self-collision after a reload). */
	getRuntimeState() {
		return { kinematics: this.getKinematicState(), parentRocketId: this.parentRocketId ?? null };
	}

	/** @param {any} state value previously produced by getRuntimeState() */
	restoreRuntimeState(state) {
		if (!state || typeof state !== 'object') return;
		this.restoreKinematicState(state.kinematics);
		if (Number.isFinite(state.parentRocketId)) {
			this.parentRocketId = state.parentRocketId;
		}
	}
}
