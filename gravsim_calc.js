
// gravsim_calc.js

import { PHYSICS, SIMULATION, ROCHE_LIMIT, DEBRIS,
	CALC_BUFFER_CONFIG, BUFFER_INDEX,
	OBJECT_TYPES, DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js'

import { CalcCelestialBody, CalcRocket, CalcDebris } from './gravsim_calc_object.js'
import { FlightComputer } from './gravsim_flight_computer.js';
import { WorkerBridge } from './gravsim_worker_bridge.js';

// QuadTree Data Structures for Spatial Partitioning
class Rectangle {
	constructor(x, y, w, h) {
		this.x = x;
		this.y = y;
		this.w = w;
		this.h = h;
	}

	contains(obj) {
		return (obj.x >= this.x - this.w &&
				obj.x <= this.x + this.w &&
				obj.y >= this.y - this.h &&
				obj.y <= this.y + this.h);
	}

	intersects(range) {
		return !(range.x - range.w > this.x + this.w ||
				 range.x + range.w < this.x - this.w ||
				 range.y - range.h > this.y + this.h ||
				 range.y + range.h < this.y - this.h);
	}
}

class QuadTree {
	constructor(boundary, capacity) {
		this.boundary = boundary;
		this.capacity = capacity;
		this.objects = [];
		this.divided = false;
	}

	subdivide() {
		const x = this.boundary.x;
		const y = this.boundary.y;
		const w = this.boundary.w / 2;
		const h = this.boundary.h / 2;

		this.ne = new QuadTree(new Rectangle(x + w, y - h, w, h), this.capacity);
		this.nw = new QuadTree(new Rectangle(x - w, y - h, w, h), this.capacity);
		this.se = new QuadTree(new Rectangle(x + w, y + h, w, h), this.capacity);
		this.sw = new QuadTree(new Rectangle(x - w, y + h, w, h), this.capacity);
		this.divided = true;
	}

	insert(obj) {
		if (!this.boundary.contains(obj)) {
			return false;
		}

		if (this.objects.length < this.capacity) {
			this.objects.push(obj);
			return true;
		} else {
			if (!this.divided) {
				this.subdivide();
			}
			if (this.ne.insert(obj)) return true;
			if (this.nw.insert(obj)) return true;
			if (this.se.insert(obj)) return true;
			if (this.sw.insert(obj)) return true;
		}
		return false;
	}

	query(range, found = []) {
		if (!this.boundary.intersects(range)) {
			return found;
		}

		for (let p of this.objects) {
			if (range.contains(p)) {
				found.push(p);
			}
		}

		if (this.divided) {
			this.nw.query(range, found);
			this.ne.query(range, found);
			this.sw.query(range, found);
			this.se.query(range, found);
		}

		return found;
	}
}

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
					launchAngle: data.launchAngle,
					maxGLimit: data.maxGLimit,
					massLossRate: data.massLossRate,
					autoControl: data.autoControl,
					hostId: data.hostId,
					hostAngleRad: data.hostAngleRad,
					hostAltM: data.hostAltM,
					isHoldDown: data.isHoldDown,
					isIgnited: data.isIgnited
				}
			));
		} else if (data.type === OBJECT_TYPES.DEBRIS) {
			this.objects.push(new CalcDebris(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || 1, data.generation || 0,
				data.mass || 1
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
		this._updateHoldDownPositions(dt);
		this._buildQuadTree(dt);
		this._checkCollisions(dt);
		this._checkRocheLimit();
		this._moveObjects(dt);
	}

	_updateHoldDownPositions(dt) {
		for (const obj of this.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isHoldDown && obj.hostId !== null) {
				const host = this.objects.find(o => o.id === obj.hostId);
				if (host) {
					const hostParam = DEFAULT_OBJECT_PARAMS[host.name];
					let omega = 0;
					if (hostParam && hostParam.ROTATION_PERIOD) {
						omega = (2 * Math.PI) / hostParam.ROTATION_PERIOD;
					}
					obj.hostAngleRad += omega * dt;
					
					const r = host.radius + obj.radius + obj.hostAltM;
					const dx = r * Math.cos(obj.hostAngleRad);
					const dy = r * Math.sin(obj.hostAngleRad);
					
					obj.x = host.x + dx;
					obj.y = host.y + dy;
					obj.vx = host.vx - omega * dy;
					obj.vy = host.vy + omega * dx;
					obj.ax = host.ax;
					obj.ay = host.ay;
					obj.dominantBody = host;
					obj.distToDominantM = r;
				}
			}
		}
	}

	_buildQuadTree(dt) {
		if (this.objects.length === 0) {
			this.qtree = null;
			return;
		}

		let minX = Infinity, minY = Infinity;
		let maxX = -Infinity, maxY = -Infinity;

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			
			// Calculate bounds including predicted movement
			const max_v = Math.max(Math.abs(obj.vx), Math.abs(obj.vy)) * dt;
			const margin = obj.radius + max_v;

			if (obj.x - margin < minX) minX = obj.x - margin;
			if (obj.y - margin < minY) minY = obj.y - margin;
			if (obj.x + margin > maxX) maxX = obj.x + margin;
			if (obj.y + margin > maxY) maxY = obj.y + margin;
		}

		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const hw = (maxX - minX) / 2;
		const hh = (maxY - minY) / 2;

		const boundary = new Rectangle(cx, cy, hw, hh);
		this.qtree = new QuadTree(boundary, 4);

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			this.qtree.insert(obj);
		}
	}

	_checkCollisions(dt) {
		if (!this.qtree) { return; }

		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];
			if (obj.collided || obj.shattered) { continue; }

			// Define search range based on maximum possible movement and size
			const max_v = Math.max(Math.abs(obj.vx), Math.abs(obj.vy)) * dt;
			const searchRadius = obj.radius + max_v;
			const searchRange = new Rectangle(obj.x, obj.y, searchRadius * 2, searchRadius * 2);

			const candidates = this.qtree.query(searchRange);

			for (const other of candidates) {
				// Prevent duplicate checks and self-checking (using id comparison)
				if (obj.id >= other.id) { continue; }
				if (other.collided || other.shattered) { continue; }

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
					const escapeVSq = (2 * PHYSICS.G * totalMass) / (winner.radius + loser.radius);

					// Energy ratio (higher value generates more debris)
					const energyRatio = vRelSq / escapeVSq;

					// Mass ratio (the most debris if =1.0)
					const massRatio = loser.mass / winner.mass;

					let debrisRatio = 0;
					const winnerDensity = winner.mass / Math.pow(winner.radius, 3);

					// Debris isn't disrupted
					if (winnerDensity <= ROCHE_LIMIT.UNBREAKABLE_DENSITY && !loser.isDebris) {
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
		if (!this.qtree) { return; }

		for (let i = 0; i < this.objects.length; i++) {
			const massiveObj = this.objects[i];

			if (massiveObj.collided || massiveObj.shattered) { continue; }
			if (massiveObj.mass < ROCHE_LIMIT.MIN_MASS_TO_DESTROY) { continue; }

			// Calculate maximum Roche limit radius for spatial query
			const massiveDensity = massiveObj.mass / Math.pow(massiveObj.radius, 3);
			// Assume worst-case fragile density is 1e3 (approx water/ice) to define the search bounds
			const minFragileDensity = 1e3;
			const maxRocheLimitM = 2.44 * massiveObj.radius * Math.cbrt(massiveDensity / minFragileDensity);

			const searchRange = new Rectangle(massiveObj.x, massiveObj.y, maxRocheLimitM, maxRocheLimitM);
			const candidates = this.qtree.query(searchRange);

			for (const fragileObj of candidates) {
				if (massiveObj.id === fragileObj.id) { continue; }

				if (fragileObj.collided || fragileObj.shattered) { continue; }

				// Decrease calculation cost
				if (massiveObj.mass <= fragileObj.mass) { continue; }
				if (fragileObj.radius < ROCHE_LIMIT.RIGID_BODY_RADIUS) { continue; }
				if (fragileObj.generation >= DEBRIS.MAX_GENERATION) { continue; }
				if (fragileObj.isDebris && fragileObj.mass < DEBRIS.MIN_MASS_TO_SHATTER) { continue; }

				if (fragileObj.isRocheLimit(massiveObj)) {
					fragileObj.shattered = true;
				}
			}
		}
	}

	_updateEscapeStatus() {
		const massiveBodies = this.objects.filter(o => o.type === OBJECT_TYPES.CELESTIAL && !o.collided && !o.shattered);
		if (massiveBodies.length === 0) { return; }
		const sun = massiveBodies.reduce((max, obj) => obj.mass > max.mass ? obj : max, massiveBodies[0]);

		for (const obj of this.objects) {
			if (obj.id === sun.id || obj.collided || obj.shattered) {
				obj.isEscaping = false;
				continue;
			}

			if (obj.dominantBody && obj.distToDominantM > 0) {
				const dvx = obj.vx - obj.dominantBody.vx;
				const dvy = obj.vy - obj.dominantBody.vy;
				const v2 = dvx * dvx + dvy * dvy;

				const totalMassKg = obj.dominantBody.mass + obj.mass;
				const escapeV2 = (2 * PHYSICS.G * totalMassKg) / obj.distToDominantM;

				obj.isEscaping = (v2 >= escapeV2);
			} else {
				obj.isEscaping = false;
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
			obj.clearAerodynamicParameters();
			return;
		}

		// Ignore if don't reach for the object's atmosphere
		const distM = Math.sqrt(minDistSq);
		const refParam = DEFAULT_OBJECT_PARAMS[refBody.name];
		const altM = distM - refBody.radius;

		if (altM > refParam.ATM_LIMIT_ALT) {
			obj.clearAerodynamicParameters();
			return;
		}

		obj.applyAerodynamics(refBody, refParam, altM);
	}

	_moveObjects(dt) {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			if (obj.type === OBJECT_TYPES.ROCKET) {
				obj.flightControl(dt, obj.dominantBody, obj.distToDominantM);
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
			if (v > PHYSICS.C) {
				obj.vx = PHYSICS.C * (obj.vx / v);
				obj.vy = PHYSICS.C * (obj.vy / v);
			}
		}
	}

	_updateGravityFor(obj) {
		obj.ax = 0;
		obj.ay = 0;
		obj.maxGForce = -1;
		obj.dominantBody = null;
		obj.distToDominantM = 0;
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

		setInterval(() => this.update(), 1000 / SIMULATION.CALC_INTERVAL);
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
			case 'setRocketState':
				const rObj = this.engine.objects.find(o => o.id === data.id);
				if (rObj && rObj.type === OBJECT_TYPES.ROCKET) {
					if (data.isIgnited !== undefined) { rObj.isIgnited = data.isIgnited; }
					if (data.isHoldDown !== undefined) { rObj.isHoldDown = data.isHoldDown; }
				}
				break;
			case 'returnBuffer':
				WorkerBridge.recycleBuffer(data.buffer);
				break;
		}
	}

	update() {
		if (this.isPaused) { return; }

		const now = Date.now();
		const elapsed = Math.min(now - this.lastTime, 1e3);

		// Avoidance of div 0
		if (elapsed <= 0) { return; }

		const totalDt = elapsed * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE * this.timeScale;
		this.lastTime = now;

		// Calculate sub-step
		let SUB_STEPS = Math.ceil(SIMULATION.CALC_SUB_STEPS_BASE * this.timeScale);
		SUB_STEPS = Math.max(1, Math.min(SUB_STEPS, SIMULATION.CALC_SUB_STEPS_MAX));
		const dt = totalDt / SUB_STEPS;

		for (let i = 0; i < SUB_STEPS; i++) {
			this.engine.step(dt);
		}

		this.engine._updateEscapeStatus();

		// Return result to main thread (Includes newly shattered objects before removal)
		const buffer = WorkerBridge.formatWorkerToMain(this.engine.objects);
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objectsData: buffer.buffer,
			validLength: buffer.length
		}, [buffer.buffer]);

		this.engine.removeDeadObjects();
	}
}

const calc = new SimulationController();
