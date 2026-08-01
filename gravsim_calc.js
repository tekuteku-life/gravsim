// gravsim_calc.js

import {
	G, C, YEARS_PER_SECOND,
	TIME_SCALE,
	ROCHE_MIN_MASS_TO_DESTROY,
	ROCHE_UNBREAKABLE_DENSITY,
	ROCHE_RIGID_BODY_RADIUS,
	ROCHE_RIGID_DESTROYER_MASS,
	DEBRIS_MAX_GENERATION,
	DEBRIS_MIN_MASS_TO_SHATTER,
} from './gravsim_const.js'

const CALC_INTERVAL = 60;

/*******************************************************************
 * Entity Class
*******************************************************************/
class GravSimCalcObject {
	constructor(id, x, y, vx, vy, ax, ay, mass, radius, generation) {
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
		this.generation = generation || 0;
		this.isDebris = this.generation > 0;
		this.isImpact = false;
		this.debrisMass = 0;
		this.impactVx = 0;
		this.impactVy = 0;
		this.impactWinnerX = 0;
		this.impactWinnerY = 0;
		this.impactWinnerRadius = 0;
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
			data.generation || 0
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
					// Winner is bigger one, loser is smaller one
					let winner, loser;
					if (obj.mass >= other.mass) { winner = obj; loser = other; }
					else { winner = other; loser = obj; }

					// Calculate velocity according to the law of conservation of momentum
					const totalMass = winner.mass + loser.mass;
					const newVx = (winner.mass * winner.vx + loser.mass * loser.vx) / totalMass;
					const newVy = (winner.mass * winner.vy + loser.mass * loser.vy) / totalMass;
					
					// 相対速度の2乗
					const dvx = winner.vx - loser.vx;
					const dvy = winner.vy - loser.vy;
					const vRelSq = dvx * dvx + dvy * dvy;

					// 衝突時の合成天体の脱出速度の2乗 (v_esc^2 = 2GM / R)
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
					// 修正: デブリ質量がゼロの場合でも、元がデブリでなければ衝撃波は発生させる[cite: 11]
					if (debrisMass > 0 || !loser.isDebris) {
						loser.isImpact = true;
					}
					loser.debrisMass = debrisMass;
					loser.impactVx = newVx;
					loser.impactVy = newVy;
					// 追加: 勝者の情報を記録[cite: 11]
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

			// Destructor must be bigger than min-threshold
			if (massiveObj.mass < ROCHE_MIN_MASS_TO_DESTROY) { continue; }

			const massiveDensity = massiveObj.mass / Math.pow(massiveObj.radius, 3);

			for (let j = 0; j < this.objects.length; j++) {
				if (i === j) { continue; }
				const fragileObj = this.objects[j];

				if (fragileObj.collided || fragileObj.shattered) { continue; }

				// Destructee must be smaller than destructor
				if (massiveObj.mass <= fragileObj.mass) { continue; }

				// Density of destructee must not be too high
				const fragileDensity = fragileObj.mass / Math.pow(fragileObj.radius, 3);
				if (fragileDensity > ROCHE_UNBREAKABLE_DENSITY) { continue; }

				// Destructee must be smaller than radius-threshold
				if (fragileObj.radius < ROCHE_RIGID_BODY_RADIUS) { continue; }

				// Limit the generation of debris
				if (fragileObj.generation >= DEBRIS_MAX_GENERATION) { continue; }

				// Destructee debris must be larger than threshold
				if (fragileObj.isDebris && fragileObj.mass < DEBRIS_MIN_MASS_TO_SHATTER) { continue; }

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
		const buffer = this.formatForMessage();
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objectsData: buffer.buffer 
		}, [buffer.buffer]);

		this.engine.removeDeadObjects();
	}

	formatForMessage() {
		const OBJ_ATTR_COUNT = 18;
		const buffer = new Float64Array(this.engine.objects.length * OBJ_ATTR_COUNT);

		for (let i = 0; i < this.engine.objects.length; i++) {
			const obj = this.engine.objects[i];
			const offset = i * OBJ_ATTR_COUNT;

			buffer[offset + 0] = obj.id;
			buffer[offset + 1] = obj.x || 0;
			buffer[offset + 2] = obj.y || 0;
			buffer[offset + 3] = obj.vx || 0;
			buffer[offset + 4] = obj.vy || 0;
			buffer[offset + 5] = obj.ax || 0;
			buffer[offset + 6] = obj.ay || 0;
			buffer[offset + 7] = obj.mass || 1;
			buffer[offset + 8] = obj.radius || 1;
			buffer[offset + 9] = (obj.collided ? 1 : 0) | (obj.shattered ? 2 : 0) | (obj.isImpact ? 4 : 0);
			buffer[offset + 10] = obj.debrisMass || 0;
			buffer[offset + 11] = obj.impactVx || 0;
			buffer[offset + 12] = obj.impactVy || 0;
			buffer[offset + 13] = obj.impactWinnerX || 0;
			buffer[offset + 14] = obj.impactWinnerY || 0;
			buffer[offset + 15] = obj.impactWinnerRadius || 0;
		}
		return buffer;
	}
}

const calc = new SimulationController();
