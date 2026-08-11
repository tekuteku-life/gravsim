
// gravsim_calc.js

import {
	G, C, G0, YEARS_PER_SECOND,
	TIME_SCALE, OBJECT_TYPES,
	ROCHE_MIN_MASS_TO_DESTROY, ROCHE_UNBREAKABLE_DENSITY,
	ROCHE_RIGID_BODY_RADIUS, ROCHE_RIGID_DESTROYER_MASS,
	DEBRIS_MAX_GENERATION, DEBRIS_MIN_MASS_TO_SHATTER,
	CALC_EXPAND_DIV_NUM, CALC_SUB_STEPS_BASE, CALC_SUB_STEPS_MAX,
	DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js'

import { CalcCelestialBody, CalcRocket } from './gravsim_calc_object.js'
import { FlightComputer } from './gravsim_flight_computer.js';

const CALC_INTERVAL = 60;

/*******************************************************************
 * Physics Engine Class
*******************************************************************/
class PhysicsEngine {
	constructor() {
		this.objects = [];
	}

	addObject(data) {
		if (data.type === OBJECT_TYPES.ROCKET) {
			this.objects.push(new CalcRocket(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || 1, data.generation || 0,
				data.mass || 1, data.fuelMass || 0,
				{
					thrustForce: data.thrustForce,
					burnTime: data.burnTime,
					thrustAngle: data.thrustAngle,
					maxGLimit: data.maxGLimit,
					massLossRate: data.massLossRate,
					autoControl: data.autoControl
				}
			));
		} else {
			this.objects.push(new CalcCelestialBody(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || 1, data.generation || 0,
				data.mass || 1
			));
		}
	}

	removeObject(id) {
		this.objects = this.objects.filter(obj => obj.id !== id);
	}

	updateObject(data) {
		const obj = this.objects.find(o => o.id === data.id);
		if (obj) {
			obj.x = data.x;
			obj.y = data.y;
			obj.vx = data.vx || 0;
			obj.vy = data.vy || 0;
			obj.ax = data.ax || 0;
			obj.ay = data.ay || 0;
			if (data.mass !== undefined) { obj.mass = data.mass; }
			if (data.radius !== undefined) { obj.radius = data.radius; }
		}
	}

	removeDeadObjects() {
		this.objects = this.objects.filter(obj => !obj.collided && !obj.shattered);
	}

	step(dt) {
		this._checkCollisions(dt);
		this._checkRocheLimit();
		this._moveObjects(dt);
	}

	_checkCollisions(dt) {
		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];
			if (obj.collided || obj.shattered) continue;

			for (let j = i + 1; j < this.objects.length; j++) {
				const other = this.objects[j];
				if (other.collided || other.shattered) continue;

				if (obj.isColliding(other, dt)) {
					// Winner is bigger one, loser is smaller one
					let winner, loser;
					if (obj.mass >= other.mass) { winner = obj; loser = other; }
					else { winner = other; loser = obj; }

					// Calculate velocity according to the law of conservation of momentum
					const totalMass = winner.mass + loser.mass;
					const newVx = (winner.mass * winner.vx + loser.mass * loser.vx) / totalMass;
					const newVy = (winner.mass * winner.vy + loser.mass * loser.vy) / totalMass;
					
					const dvx = winner.vx - loser.vx;
					const dvy = winner.vy - loser.vy;
					const vRelSq = dvx * dvx + dvy * dvy;

					// The square of escape speed (v_esc^2 = 2GM / R)
					const escapeVSq = (2 * G * totalMass) / (winner.radius + loser.radius);

					// Energy ratio (higher value generates more debris)
					const energyRatio = vRelSq / escapeVSq;

					// Mass ratio (the most debris if =1.0)
					const massRatio = loser.mass / winner.mass;

					let debrisRatio = 0;
					const winnerDensity = winner.mass / Math.pow(winner.radius, 3);

					// Debris isn't disrupted
					if (winnerDensity <= ROCHE_UNBREAKABLE_DENSITY && !loser.isDebris) {
						debrisRatio = massRatio * (energyRatio * 0.5);
						debrisRatio = Math.max(0.0, Math.min(debrisRatio, 0.9));

						// Ignore tiny debris
						if (debrisRatio < 1e-4) {
							debrisRatio = 0;
						}
					}

					const debrisMass = loser.mass * debrisRatio;
					const absorbedMass = loser.mass - debrisMass;

					const oldWinnerMass = winner.mass;
					winner.mass += absorbedMass;
					winner.radius = winner.radius * Math.cbrt(winner.mass / oldWinnerMass);
					
					winner.vx = newVx;
					winner.vy = newVy;

					loser.collided = true;
					if (debrisMass > 0 || !loser.isDebris) {
						loser.isImpact = true;
					}
					loser.debrisMass = debrisMass;
					loser.impactVx = newVx;
					loser.impactVy = newVy;

					// Keep winner position to generate impact debris
					loser.impactWinnerX = winner.x;
					loser.impactWinnerY = winner.y;
					loser.impactWinnerRadius = winner.radius;
				}
			}
		}
	}

	_checkRocheLimit() {
		for (let i = 0; i < this.objects.length; i++) {
			const massiveObj = this.objects[i];

			if (massiveObj.collided || massiveObj.shattered) { continue; }
			if (massiveObj.mass < ROCHE_MIN_MASS_TO_DESTROY) { continue; }

			for (let j = 0; j < this.objects.length; j++) {
				if (i === j) { continue; }
				const fragileObj = this.objects[j];

				if (fragileObj.collided || fragileObj.shattered) { continue; }

				// Decrease calculation cost
				if (massiveObj.mass <= fragileObj.mass) { continue; }
				if (fragileObj.radius < ROCHE_RIGID_BODY_RADIUS) { continue; }
				if (fragileObj.generation >= DEBRIS_MAX_GENERATION) { continue; }
				if (fragileObj.isDebris && fragileObj.mass < DEBRIS_MIN_MASS_TO_SHATTER) { continue; }

				if (fragileObj.isRocheLimit(massiveObj)) {
					fragileObj.shattered = true;
				}
			}
		}
	}

	_updateAerodynamicsFor(obj) {
		if (obj.collided || obj.shattered) { return; }

		let refBody = null;
		let minDistSq = Infinity;

		// Select the most near object
		for (const p of this.objects) {
			if (p.id === obj.id || p.collided || p.shattered) { continue; }
			const param = DEFAULT_OBJECT_PARAMS[p.name];
			if (!param || !param.ATM_LIMIT_ALT) { continue; }
			
			const dx = obj.x - p.x;
			const dy = obj.y - p.y;
			const distSq = dx * dx + dy * dy;
			if (distSq < minDistSq) {
				minDistSq = distSq;
				refBody = p;
			}
		}

		if (!refBody) {
			if (obj.type === OBJECT_TYPES.ROCKET) {
				obj.clearAerodynamicParameters();
			}
			return;
		}

		// Ignore if don't reach for the object's atmosphere
		const distM = Math.sqrt(minDistSq);
		const refParam = DEFAULT_OBJECT_PARAMS[refBody.name];
		const altM = distM - refBody.radius;

		if (altM > refParam.ATM_LIMIT_ALT) {
			if (obj.type === OBJECT_TYPES.ROCKET) {
				obj.clearAerodynamicParameters();
			}
			return;
		}

		obj.applyAerodynamics(refBody, refParam, altM);
	}

	_moveObjects(dt) {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			if (obj.type === OBJECT_TYPES.ROCKET) {
				let refBody = null;
				let maxG = -1;
				let distToRefM = 0;
				for (const p of this.objects) {
					if (p.id === obj.id || p.collided || p.shattered || p.type === OBJECT_TYPES.ROCKET) { continue; }
					const dx = obj.x - p.x;
					const dy = obj.y - p.y;
					const distSq = dx * dx + dy * dy;
					if (distSq === 0) continue;
					
					const gForce = p.mass / distSq;
					if (gForce > maxG) {
						maxG = gForce;
						refBody = p;
						distToRefM = Math.sqrt(distSq);
					}
				}

				obj.flightControl(dt, refBody, distToRefM);
			}

			// Apply gravity, aerodynamics and thrust (Velocity Verlet integration Step 1)
			this._updateGravityFor(obj);
			this._updateAerodynamicsFor(obj);
			if (obj.shattered) { continue; }

			const half_vx = obj.vx + obj.ax * dt / 2;
			const half_vy = obj.vy + obj.ay * dt / 2;
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;

			// Apply gravity, aerodynamics and thrust (Velocity Verlet integration Step 2)
			this._updateGravityFor(obj);
			this._updateAerodynamicsFor(obj);
			if (obj.shattered) { continue; }

			obj.vx = half_vx + obj.ax * dt / 2;
			obj.vy = half_vy + obj.ay * dt / 2;

			// Limit to C
			const v = obj.getV();
			if (v > C) {
				obj.vx = C * (obj.vx / v);
				obj.vy = C * (obj.vy / v);
			}
		}
	}

	_updateGravityFor(obj) {
		obj.ax = 0;
		obj.ay = 0;
		for (const other of this.objects) {
			if (obj.id !== other.id && !other.collided && !other.shattered) {
				obj.applyGravity(other);
			}
		}

		obj.applyThrust();
	}
}

/*******************************************************************
 * Simulation Controller
*******************************************************************/
class SimulationController {
	constructor() {
		this.engine = new PhysicsEngine();
		this.lastTime = Date.now();
		this.timeScale = 1;
		this.isPaused = false;

		self.onmessage = this.handleMessage.bind(this);

		setInterval(() => this.update(), 1000 / CALC_INTERVAL);
	}

	handleMessage(e) {
		const data = e.data;
		switch (data.cmd) {
			case 'add':
				this.engine.addObject(data);
				break;
			case 'remove':
				this.engine.removeObject(data.id);
				break;
			case 'update':
				this.engine.updateObject(data);
				break;
			case 'setTimeScale':
				if (typeof data.timeScale === 'number' && data.timeScale > 0) {
					this.timeScale = data.timeScale;
				}
				break;
			case 'pause':
				this.isPaused = data.value;
				if (!this.isPaused) this.lastTime = Date.now();
				break;
		}
	}

	update() {
		if (this.isPaused) { return; }

		const now = Date.now();
		const elapsed = Math.min(now - this.lastTime, 1e3);

		// Avoidance of div 0
		if (elapsed <= 0) { return; }

		const totalDt = elapsed * YEARS_PER_SECOND / TIME_SCALE * this.timeScale;
		this.lastTime = now;

		// Calculate sub-step
		let SUB_STEPS = Math.ceil(CALC_SUB_STEPS_BASE * this.timeScale);
		SUB_STEPS = Math.max(1, Math.min(SUB_STEPS, CALC_SUB_STEPS_MAX));
		const dt = totalDt / SUB_STEPS;

		for (let i = 0; i < SUB_STEPS; i++) {
			this.engine.step(dt);
		}

		// Return result to main thread (Includes newly shattered objects before removal)
		const buffer = this.formatForMessage();
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objectsData: buffer.buffer 
		}, [buffer.buffer]);

		this.engine.removeDeadObjects();
	}

	formatForMessage() {
		const OBJ_ATTR_COUNT = 37;
		const buffer = new Float64Array(this.engine.objects.length * OBJ_ATTR_COUNT);

		for (let i = 0; i < this.engine.objects.length; i++) {
			const obj = this.engine.objects[i];
			const offset = i * OBJ_ATTR_COUNT;

			buffer[offset + 0] = obj.id;
			buffer[offset + 1] = obj.type;
			buffer[offset + 2] = obj.x || 0;
			buffer[offset + 3] = obj.y || 0;
			buffer[offset + 4] = obj.vx || 0;
			buffer[offset + 5] = obj.vy || 0;
			buffer[offset + 6] = obj.ax || 0;
			buffer[offset + 7] = obj.ay || 0;
			
			if (obj.type === OBJECT_TYPES.ROCKET) {
				buffer[offset + 8] = obj.dryMass;
				buffer[offset + 9] = obj.fuelMass;
				buffer[offset + 11] = obj.burnTime > 0 ? obj.burnTime : 0;
				buffer[offset + 12] = obj._thrustRatio || 0;
				
				const tm = obj.flightComputer.getTelemetry();
				buffer[offset + 20] = tm.status;
				buffer[offset + 21] = tm.qAxialKpa;
				buffer[offset + 22] = tm.qLateralKpa;
				buffer[offset + 23] = tm.structRatio;
				buffer[offset + 24] = tm.aoaDeg;
				buffer[offset + 25] = tm.progradeAngle;
				buffer[offset + 26] = tm.gravityAngle;
				buffer[offset + 27] = tm.remDv;
				buffer[offset + 28] = tm.twr;
				buffer[offset + 29] = tm.altM;
				buffer[offset + 30] = tm.vV;
				buffer[offset + 31] = tm.vH;
				buffer[offset + 32] = tm.aV;
				buffer[offset + 33] = tm.aH;
				buffer[offset + 34] = tm.currentG;
				buffer[offset + 35] = obj.flightComputer.flightTime;
				buffer[offset + 36] = obj.thrustAngle;
			} else {
				buffer[offset + 8] = obj.mass;
				buffer[offset + 9] = 0;
				buffer[offset + 11] = 0;
				buffer[offset + 12] = 0;
			}
			buffer[offset + 10] = obj.radius || 1;
			buffer[offset + 13] = (obj.collided ? 1 : 0) | (obj.shattered ? 2 : 0) | (obj.isImpact ? 4 : 0);
			buffer[offset + 14] = obj.debrisMass || 0;
			buffer[offset + 15] = obj.impactVx || 0;
			buffer[offset + 16] = obj.impactVy || 0;
			buffer[offset + 17] = obj.impactWinnerX || 0;
			buffer[offset + 18] = obj.impactWinnerY || 0;
			buffer[offset + 19] = obj.impactWinnerRadius || 0;
		}
		return buffer;
	}
}

const calc = new SimulationController();
