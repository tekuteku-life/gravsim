// gravsim_calc.js

import {
	G, C, YEARS_PER_SECOND,
	TIME_SCALE,
	ROCHE_MIN_MASS_TO_DESTROY,
	ROCHE_UNBREAKABLE_DENSITY,
	ROCHE_RIGID_BODY_RADIUS,
	ROCHE_RIGID_DESTROYER_MASS
} from './gravsim_const.js'

const CALC_INTERVAL = 60;

/*******************************************************************
 * Entity Class
*******************************************************************/
class GravSimCalcObject {
	constructor(id, x, y, vx, vy, ax, ay, mass, radius, isDebris) {
		this.id = id;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = ax;
		this.ay = ay;
		this.mass = mass;
		this.radius = radius;
		this.collided = false;
		this.shattered = false;
		this.isDebris = isDebris || false;
	}
	
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

		const force = (G * this.mass * other.mass) / distSq;
		const accel = force / this.mass;

		this.ax += accel * dx / dist;
		this.ay += accel * dy / dist;
	}

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
			const EXPAND_DIV_NUM = 20;
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
}

/*******************************************************************
 * Physics Engine Class
*******************************************************************/
class PhysicsEngine {
	constructor() {
		this.objects = [];
	}

	addObject(data) {
		this.objects.push(new GravSimCalcObject(
			data.id, data.x, data.y,
			data.vx || 0, data.vy || 0,
			data.ax || 0, data.ay || 0,
			data.mass || 1, data.radius || 1,
			data.isDebris || false
		));
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
			if (data.mass !== undefined) obj.mass = data.mass;
			if (data.radius !== undefined) obj.radius = data.radius;
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
					if (obj.mass < other.mass) obj.collided = true;
					else other.collided = true;
				}
			}
		}
	}

	_checkRocheLimit() {
		for (let i = 0; i < this.objects.length; i++) {
			const massiveObj = this.objects[i];

			if (massiveObj.collided || massiveObj.shattered) { continue; }

			// Destructor must be bigger than min-threshold
			if (massiveObj.mass < ROCHE_MIN_MASS_TO_DESTROY) { continue; }

			const massiveDensity = massiveObj.mass / Math.pow(massiveObj.radius, 3);

			for (let j = 0; j < this.objects.length; j++) {
				if (i === j) { continue; }
				const fragileObj = this.objects[j];

				if (fragileObj.collided || fragileObj.shattered || fragileObj.isDebris) { continue; }
				
				// Destructee must be smaller than destructor
				if (massiveObj.mass <= fragileObj.mass) { continue; }

				// Density of destructee must not be too high
				const fragileDensity = fragileObj.mass / Math.pow(fragileObj.radius, 3);
				if (fragileDensity > ROCHE_UNBREAKABLE_DENSITY) { continue; }

				// Destructee must be smaller than radius-threthold
				if (fragileObj.radius < ROCHE_RIGID_BODY_RADIUS) { continue; }

				// Calculate roche-limit
				const rocheLimitM = 2.44 * massiveObj.radius * Math.cbrt(massiveDensity / fragileDensity);

				const dx = fragileObj.x - massiveObj.x;
				const dy = fragileObj.y - massiveObj.y;
				const distSq = dx * dx + dy * dy;

				if (distSq < rocheLimitM * rocheLimitM) {
					fragileObj.shattered = true;
				}
			}
		}
	}

	_moveObjects(dt) {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) continue;

			this._updateGravityFor(obj);
			const half_vx = obj.vx + obj.ax * dt / 2;
			const half_vy = obj.vy + obj.ay * dt / 2;
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;

			this._updateGravityFor(obj);
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
		let SUB_STEPS = Math.ceil(600 * this.timeScale);
		SUB_STEPS = Math.max(1, Math.min(SUB_STEPS, 480));
		const dt = totalDt / SUB_STEPS;

		for (let i = 0; i < SUB_STEPS; i++) {
			this.engine.step(dt);
		}
			
		// Return result to main thread (Includes newly shattered objects before removal)
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objects: this.formatForMessage()
		});

		this.engine.removeDeadObjects();
	}

	formatForMessage() {
		return this.engine.objects.map(obj => ({
			id: obj.id,
			x: obj.x || 0,
			y: obj.y || 0,
			vx: obj.vx || 0,
			vy: obj.vy || 0,
			ax: obj.ax || 0,
			ay: obj.ay || 0,
			mass: obj.mass || 1,
			radius: obj.radius || 1,
			collided: obj.collided || false,
			shattered: obj.shattered || false,
		}));
	}
}

const calc = new SimulationController();
