
// gravsim_calc.js

import { PHYSICS, SIMULATION, ROCHE_LIMIT, DEBRIS, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js'
import { CalcCelestialBody, CalcRocket, CalcDebris } from './gravsim_calc_object.js'
import { WorkerBridge } from './gravsim_worker_bridge.js';

// QuadTree Data Structures for Spatial Partitioning
class Rectangle {
	constructor(x, y, w, h) {
		this.x = x; // m
		this.y = y; // m
		this.w = w; // m
		this.h = h; // m
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

// Zero-allocation Object Pool for QuadTree
class QuadTreePool {
	constructor() {
		this.rects = [];
		this.rectsUsed = 0;
		this.trees = [];
		this.treesUsed = 0;
	}

	getRectangle(x, y, w, h) {
		if (this.rectsUsed >= this.rects.length) {
			this.rects.push(new Rectangle(x, y, w, h));
		}
		const r = this.rects[this.rectsUsed++];
		r.x = x; r.y = y; r.w = w; r.h = h;
		return r;
	}

	getTree(boundary, capacity) {
		if (this.treesUsed >= this.trees.length) {
			this.trees.push(new QuadTree(boundary, capacity, this));
		}
		const t = this.trees[this.treesUsed++];
		t.boundary = boundary;
		t.capacity = capacity;
		t.pool = this;
		t.objects.length = 0;
		t.divided = false;
		t.ne = null; t.nw = null; t.se = null; t.sw = null;
		return t;
	}

	reset() {
		this.rectsUsed = 0;
		this.treesUsed = 0;
	}
}

class QuadTree {
	constructor(boundary, capacity, pool) {
		this.boundary = boundary;
		this.capacity = capacity;
		this.pool = pool;
		this.objects = [];
		this.divided = false;
	}

	subdivide() {
		const x = this.boundary.x;
		const y = this.boundary.y;
		const w = this.boundary.w / 2;
		const h = this.boundary.h / 2;
		this.ne = this.pool.getTree(this.pool.getRectangle(x + w, y - h, w, h), this.capacity);
		this.nw = this.pool.getTree(this.pool.getRectangle(x - w, y - h, w, h), this.capacity);
		this.se = this.pool.getTree(this.pool.getRectangle(x + w, y + h, w, h), this.capacity);
		this.sw = this.pool.getTree(this.pool.getRectangle(x - w, y + h, w, h), this.capacity);
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
			if (this.ne.insert(obj)) { return true; }
			if (this.nw.insert(obj)) { return true; }
			if (this.se.insert(obj)) { return true; }
			if (this.sw.insert(obj)) { return true; }
			return false;
		}
	}

	query(range, found) {
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
		this.massiveBodies = []; // Cache for objects with significant mass
		this.tinyBodies = []; // Cache for objects with insignificant mass
		this.atmBodies = []; // Cache for objects with atmosphere
		
		// Pre-allocate objects for spatial query to prevent GC spikes
		this.pool = new QuadTreePool();
		this._searchRange = new Rectangle(0, 0, 0, 0);
		this._queryResult = [];
	}

	addObject(data) {
		if (data.type === OBJECT_TYPES.ROCKET) {
			this.objects.push(new CalcRocket(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || 1, data.generation || 0,
				data.mass || 1, data.fuelMass || 0, data.oxidMass || 0,
				{
					ofRatio: data.ofRatio || 0,
					thrustForce: data.thrustForce,
					burnTime: data.burnTime,
					thrustAngle: data.thrustAngle,
					flightProfile: data.flightProfile,
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

	_categorizeBodies() {
		this.massiveBodies.length = 0;
		this.tinyBodies.length = 0;
		this.atmBodies.length = 0;

		const len = this.objects.length;
		for (let i = 0; i < len; i++) {
			const obj = this.objects[i];
			if (obj.collided || obj.shattered) { continue; }

			// Distinguish bodies by mass for optimized gravity calculation
			if (obj.mass >= SIMULATION.MIN_GRAVITY_CALC_MASS) {
				this.massiveBodies.push(obj);
			} else {
				this.tinyBodies.push(obj);
			}

			// Distinguish bodies by atmosphere parameter
			const param = DEFAULT_OBJECT_PARAMS[obj.name];
			if (obj.type === OBJECT_TYPES.CELESTIAL && param && param.ATM_LIMIT_ALT) {
				this.atmBodies.push(obj);
			}
		}
	}

	_updateHoldDownPositions(dt) {
		for (const obj of this.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isHoldDown && obj.hostId !== null) {
				const host = this.objects.find(o => o.id === obj.hostId);
				if (host) {
					const hostParam = DEFAULT_OBJECT_PARAMS[host.name];
					let omega = 0; // rad/s
					if (hostParam && hostParam.ROTATION_PERIOD) {
						omega = (2 * Math.PI) / hostParam.ROTATION_PERIOD;
					}

					obj.hostAngleRad += omega * dt;

					const r = host.radius + obj.radius + obj.hostAltM; // m
					const dx = r * Math.cos(obj.hostAngleRad); // m
					const dy = r * Math.sin(obj.hostAngleRad); // m

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

		let minX = Infinity; // m
		let minY = Infinity; // m
		let maxX = -Infinity; // m
		let maxY = -Infinity; // m

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			// Calculate bounds including predicted movement
			const max_v = Math.max(Math.abs(obj.vx), Math.abs(obj.vy)) * dt; // m
			const margin = obj.radius + max_v; // m

			if (obj.x - margin < minX) minX = obj.x - margin;
			if (obj.y - margin < minY) minY = obj.y - margin;
			if (obj.x + margin > maxX) maxX = obj.x + margin;
			if (obj.y + margin > maxY) maxY = obj.y + margin;
		}

		const cx = (minX + maxX) / 2; // m
		const cy = (minY + maxY) / 2; // m
		const hw = (maxX - minX) / 2; // m
		const hh = (maxY - minY) / 2; // m

		this.pool.reset();
		const boundary = this.pool.getRectangle(cx, cy, hw, hh);
		this.qtree = this.pool.getTree(boundary, 4);

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			this.qtree.insert(obj);
		}
	}

	_checkCollisions(dt) {
		if (!this.qtree) { return; }

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			// Define search range based on maximum possible movement and size
			const max_v = Math.max(Math.abs(obj.vx), Math.abs(obj.vy)) * dt; // m
			const searchRadius = obj.radius + max_v; // m

			// Zero-allocation query preparation
			this._searchRange.x = obj.x;
			this._searchRange.y = obj.y;
			this._searchRange.w = searchRadius * 2;
			this._searchRange.h = searchRadius * 2;
			this._queryResult.length = 0;

			const candidates = this.qtree.query(this._searchRange, this._queryResult);

			for (const other of candidates) {
				// Prevent duplicate checks and self-checking (using id comparison)
				if (obj.id >= other.id) { continue; }
				if (other.collided || other.shattered) { continue; }

				if (obj.isColliding(other, dt)) {
					// Winner is bigger one, loser is smaller one
					let winner, loser;
					if (obj.mass >= other.mass) {
						winner = obj;
						loser = other;
					} else {
						winner = other;
						loser = obj;
					}

					// Calculate velocity according to the law of conservation of momentum
					const totalMass = winner.mass + loser.mass; // t
					const newVx = (winner.mass * winner.vx + loser.mass * loser.vx) / totalMass; // m/s
					const newVy = (winner.mass * winner.vy + loser.mass * loser.vy) / totalMass; // m/s

					const dvx = winner.vx - loser.vx; // m/s
					const dvy = winner.vy - loser.vy; // m/s
					const vRelSq = dvx * dvx + dvy * dvy; // (m/s)^2

					// The square of escape speed (v_esc^2 = 2GM / R)
					const escapeVSq = (2 * PHYSICS.G * totalMass) / (winner.radius + loser.radius); // (m/s)^2

					// Energy ratio (higher value generates more debris)
					const energyRatio = vRelSq / escapeVSq;

					// Mass ratio (the most debris if =1.0)
					const massRatio = loser.mass / winner.mass;

					let debrisRatio = 0;
					const winnerDensity = winner.mass / Math.pow(winner.radius, 3); // t/m^3

					// Debris isn't disrupted
					if (winnerDensity <= ROCHE_LIMIT.UNBREAKABLE_DENSITY && !loser.isDebris) {
						debrisRatio = massRatio * (energyRatio * 0.5);
						debrisRatio = Math.max(0.0, Math.min(debrisRatio, 0.9));
					}

					// Ignore tiny debris
					if (debrisRatio < 1e-4) { debrisRatio = 0; }

					const debrisMass = loser.mass * debrisRatio; // t
					const absorbedMass = loser.mass - debrisMass; // t
					const oldWinnerMass = winner.mass; // t

					winner.mass += absorbedMass;
					winner.radius = winner.radius * Math.cbrt(winner.mass / oldWinnerMass);
					winner.vx = newVx;
					winner.vy = newVy;
					loser.collided = true;

					if (debrisMass > 0 || !loser.isDebris) {
						loser.isImpact = true;
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
	}

	_checkRocheLimit() {
		if (!this.qtree) { return; }

		for (const massiveObj of this.objects) {
			if (massiveObj.collided || massiveObj.shattered) { continue; }
			if (massiveObj.mass < ROCHE_LIMIT.MIN_MASS_TO_DESTROY) { continue; }

			// Calculate maximum Roche limit radius for spatial query
			const massiveDensity = massiveObj.mass / Math.pow(massiveObj.radius, 3); // t/m^3

			// Assume worst-case fragile density is 1e3 (approx water/ice) to define the search bounds
			const minFragileDensity = 1e3; // t/m^3
			const maxRocheLimitM = 2.44 * massiveObj.radius * Math.cbrt(massiveDensity / minFragileDensity); // m

			// Zero-allocation query preparation
			this._searchRange.x = massiveObj.x;
			this._searchRange.y = massiveObj.y;
			this._searchRange.w = maxRocheLimitM;
			this._searchRange.h = maxRocheLimitM;
			this._queryResult.length = 0;

			const candidates = this.qtree.query(this._searchRange, this._queryResult);

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
				const dvx = obj.vx - obj.dominantBody.vx; // m/s
				const dvy = obj.vy - obj.dominantBody.vy; // m/s
				const v2 = dvx * dvx + dvy * dvy; // (m/s)^2

				const totalMassKg = obj.dominantBody.mass + obj.mass; // t
				const escapeV2 = (2 * PHYSICS.G * totalMassKg) / obj.distToDominantM; // (m/s)^2

				obj.isEscaping = (v2 >= escapeV2);
			} else {
				obj.isEscaping = false;
			}
		}
	}

	_applyAerodynamicsFromCache(obj) {
		const refBody = obj._nearestAtmBody;
		if (!refBody) {
			obj.clearAerodynamicParameters();
			return;
		}

		// Ignore if don't reach for the object's atmosphere
		const distM = Math.sqrt(obj._minAtmDistSq); // m
		const refParam = DEFAULT_OBJECT_PARAMS[refBody.name];
		const altM = distM - refBody.radius; // m

		if (altM > refParam.ATM_LIMIT_ALT) {
			obj.clearAerodynamicParameters();
			return;
		}

		obj.applyAerodynamics(refBody, refParam, altM);
	}

	_moveObjects(dt) {
		const len = this.objects.length;

		// Update position and half velocity using previous a(t)
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			const half_vx = obj.vx + obj.ax * dt / 2; // m/s
			const half_vy = obj.vy + obj.ay * dt / 2; // m/s
			
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;
			
			// Store half_v temporarily
			obj._half_vx = half_vx;
			obj._half_vy = half_vy;
		}

		// Flight control for rockets (updates mass, state, etc. at new position)
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			if (obj.type === OBJECT_TYPES.ROCKET) {
				obj.flightControl(dt, obj.dominantBody, obj.distToDominantM);
			}
		}

		// New forces a(t+dt)
		this._calculateForces();

		// Final velocity
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			obj.vx = obj._half_vx + obj.ax * dt / 2;
			obj.vy = obj._half_vy + obj.ay * dt / 2;

			// Limit to C
			const v = obj.getV(); // m/s
			if (v > PHYSICS.C) {
				obj.vx = PHYSICS.C * (obj.vx / v);
				obj.vy = PHYSICS.C * (obj.vy / v);
			}
		}
	}

	_calculateForces() {
		// Reset accelerations and metrics for all active objects
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			obj.ax = 0;
			obj.ay = 0;
			obj.maxGForce = -1;
			obj.dominantBody = null;
			obj.distToDominantM = 0;
			// Cache for aerodynamics to eliminate redundant loops
			obj._nearestAtmBody = null;
			obj._minAtmDistSq = Infinity; // m^2
		}

		// Massive vs Massive
		const massiveLen = this.massiveBodies.length;
		for (let i = 0; i < massiveLen; i++) {
			const objA = this.massiveBodies[i];
			const paramA = DEFAULT_OBJECT_PARAMS[objA.name];
			const hasAtmA = paramA && paramA.ATM_LIMIT_ALT;

			for (let j = i + 1; j < massiveLen; j++) {
				const objB = this.massiveBodies[j];

				const dx = objB.x - objA.x; // m
				const dy = objB.y - objA.y; // m
				const radiusSum = objA.radius + objB.radius; // m
				const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum); // m^2
				const dist = Math.sqrt(distSq); // m

				// accelPerDist = G / (dist^3)
				const accelPerDist = PHYSICS.G / (distSq * dist);

				// aA = (G * mB) / dist^2 = accelPerDist * objB.mass * dx
				objA.ax += accelPerDist * objB.mass * dx;
				objA.ay += accelPerDist * objB.mass * dy;

				objB.ax -= accelPerDist * objA.mass * dx;
				objB.ay -= accelPerDist * objA.mass * dy;

				// Keep the largest gravity object and search atmosphere
				if (objB.type === OBJECT_TYPES.CELESTIAL) {
					const gForceA = objB.mass / distSq;
					if (gForceA > objA.maxGForce) {
						objA.maxGForce = gForceA;
						objA.dominantBody = objB;
						objA.distToDominantM = dist;
					}
					const paramB = DEFAULT_OBJECT_PARAMS[objB.name];
					if (paramB && paramB.ATM_LIMIT_ALT && distSq < objA._minAtmDistSq) {
						objA._minAtmDistSq = distSq;
						objA._nearestAtmBody = objB;
					}
				}
				if (objA.type === OBJECT_TYPES.CELESTIAL) {
					const gForceB = objA.mass / distSq;
					if (gForceB > objB.maxGForce) {
						objB.maxGForce = gForceB;
						objB.dominantBody = objA;
						objB.distToDominantM = dist;
					}
					if (hasAtmA && distSq < objB._minAtmDistSq) {
						objB._minAtmDistSq = distSq;
						objB._nearestAtmBody = objA;
					}
				}
			}

			// Apply Thrust
			objA.applyThrust();
		}

		// Massive vs Tiny
		for (const objA of this.massiveBodies) {
			const hasAtmA = DEFAULT_OBJECT_PARAMS[objA.name]?.ATM_LIMIT_ALT;

			for (const objB of this.tinyBodies) {
				const dx = objB.x - objA.x; // m
				const dy = objB.y - objA.y; // m
				const radiusSum = objA.radius + objB.radius; // m
				const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum); // m^2
				const dist = Math.sqrt(distSq); // m

				const accelPerDist = PHYSICS.G / (distSq * dist);

				objA.ax += accelPerDist * objB.mass * dx;
				objA.ay += accelPerDist * objB.mass * dy;

				objB.ax -= accelPerDist * objA.mass * dx;
				objB.ay -= accelPerDist * objA.mass * dy;

				if (objA.type === OBJECT_TYPES.CELESTIAL) {
					const gForceB = objA.mass / distSq;
					if (gForceB > objB.maxGForce) {
						objB.maxGForce = gForceB;
						objB.dominantBody = objA;
						objB.distToDominantM = dist;
					}
					if (hasAtmA && distSq < objB._minAtmDistSq) {
						objB._minAtmDistSq = distSq;
						objB._nearestAtmBody = objA;
					}
				}
			}
		}

		// Apply Thrust for Tiny
		for (const obj of this.tinyBodies) {
			obj.applyThrust();
		}

		// Apply aerodynamics after all distances are checked
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			this._applyAerodynamicsFromCache(obj);
		}
	}
}

/*******************************************************************
 * Simulation Controller
 *******************************************************************/
class SimulationController {
	constructor() {
		this.engine = new PhysicsEngine();
		this.lastTime = Date.now(); // ms
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
			case 'rocketCommand': {
				const targetRocket = this.engine.objects.find(o => o.id === data.id);
				if (targetRocket && targetRocket.type === OBJECT_TYPES.ROCKET) {
					if (targetRocket.handleCommand) {
						targetRocket.handleCommand(data.command);
					}
				}
				break;
			}
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

		const totalDt = elapsed * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE * this.timeScale; // s
		this.lastTime = now;

		// Calculate sub-step
		let SUB_STEPS = Math.ceil(SIMULATION.CALC_SUB_STEPS_BASE * this.timeScale);
		SUB_STEPS = Math.max(1, Math.min(SUB_STEPS, SIMULATION.CALC_SUB_STEPS_MAX));
		const dt = totalDt / SUB_STEPS; // s

		// Refresh body categorizations before running steps
		this.engine._categorizeBodies();

		// Optimization: Rebuild QuadTree and check collisions only ONCE per frame 
		// using the total elapsed time, instead of running it every sub-step.
		this.engine._buildQuadTree(totalDt);
		this.engine._checkCollisions(totalDt);
		this.engine._checkRocheLimit();

		// Fast Integration Loop
		for (let i = 0; i < SUB_STEPS; i++) {
			this.engine._updateHoldDownPositions(dt);
			this.engine._moveObjects(dt);
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
