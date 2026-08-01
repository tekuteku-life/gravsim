import {
	G, REMOVE_DISTANCE_AU, DEBRIS_MIN_FRAG,
	DEBRIS_FRAG_DECAY_RATE, OBJECT_STATE
} from './gravsim_const.js';
import { GravSimObject } from './gravsim_object.js';

/*******************************************************************
 * ObjectManager Class
*******************************************************************/
export class ObjectManager {
	constructor(renderer, workerManager) {
		this.renderer = renderer;
		this.workerManager = workerManager;
		this.objects = [];
		this.centerObject = null;
	}

	ensureCenterObject() {
		if (this.centerObject && this.centerObject.state !== OBJECT_STATE.ACTIVE) {
			const maxMassObj = this.objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, this.objects[0]);
			this.centerObject = maxMassObj;
			return true;
		}
		return false;
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		this.objects.push(obj);
		this.workerManager.postMessage({
			cmd: 'add',
			id: obj.id,
			x: this.renderer.pix2m(obj.x), y: this.renderer.pix2m(obj.y),
			vx: this.renderer.pix2m(obj.vx), vy: this.renderer.pix2m(obj.vy),
			ax: this.renderer.pix2m(obj.ax), ay: this.renderer.pix2m(obj.ay),
			mass: obj.mass * 1e3,
			radius: obj.radius,
			generation: obj.generation,
		});
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		obj.setCollided();
		this.workerManager.postMessage({ cmd: 'remove', id: obj.id });
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		this.workerManager.postMessage({
			cmd: 'update',
			id: obj.id,
			x: this.renderer.pix2m(obj.x), y: this.renderer.pix2m(obj.y),
			vx: this.renderer.pix2m(obj.vx), vy: this.renderer.pix2m(obj.vy),
			ax: this.renderer.pix2m(obj.ax), ay: this.renderer.pix2m(obj.ay),
			mass: obj.mass * 1e3,
			radius: obj.radius,
			generation: obj.generation,
		});
	}

	updateObjectParams(data) {
		data.objects.forEach(workerObj => {
			const target = this.objects.find(t => t.id === workerObj.id);
			if (target) {
				target.x = this.renderer.m2pix(workerObj.x);
				target.y = this.renderer.m2pix(workerObj.y);
				target.vx = this.renderer.m2pix(workerObj.vx);
				target.vy = this.renderer.m2pix(workerObj.vy);
				target.ax = this.renderer.m2pix(workerObj.ax);
				target.ay = this.renderer.m2pix(workerObj.ay);
				target.mass = workerObj.mass / 1e3;
				target.radius = workerObj.radius;
				target.addHistory();
				
				if (workerObj.collided) {
					if (workerObj.isImpact && target.state === OBJECT_STATE.ACTIVE) {
						this._generateImpactDebris(
							target, 
							workerObj.debrisMass / 1e3,
							this.renderer.m2pix(workerObj.impactVx), 
							this.renderer.m2pix(workerObj.impactVy),
							this.renderer.m2pix(workerObj.impactWinnerX),
							this.renderer.m2pix(workerObj.impactWinnerY),
							this.renderer.m2pix(workerObj.impactWinnerRadius)
						);
					}

					target.setCollided();
				}
				
				// Handle object shattered by tidal force in the worker
				if (workerObj.shattered && target.state === OBJECT_STATE.ACTIVE) {
					this._shatterObject(target);
				}
			}
		});
	}

	cleanupObjects() {
		this._checkEscapeAndRemove();
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	_generateImpactDebris(loserObj, totalDebrisMass, baseVx, baseVy, winnerX, winnerY, winnerRadiusPx) {
		this.renderer.addShockwave(loserObj.x, loserObj.y, loserObj.color);

		if (totalDebrisMass <= 0) { return; }

		const fragmentCount = Math.max(3, Math.floor(Math.log10(totalDebrisMass) * 1.5));
		const baseMass = totalDebrisMass / fragmentCount;
		const debrisColor = this._mixWithGray(loserObj.color, 0.4);

		// Calculate winner -> loser vector
		let dx = loserObj.x - winnerX;
		let dy = loserObj.y - winnerY;
		let dist = Math.sqrt(dx * dx + dy * dy);
		if (dist === 0) { dx = 1; dy = 0; dist = 1; }
		const nx = dx / dist;
		const ny = dy / dist;
		const baseAngle = Math.atan2(ny, nx);

		for (let i = 0; i < fragmentCount; i++) {
			const massVariation = 0.8 + (Math.random() * 0.4); 
			const fragMass = baseMass * massVariation;
			const fragRadius = loserObj.radius * Math.cbrt(fragMass / loserObj.mass);
			
			// Shift spawn position to avoid re-collision
			const marginPx = this.renderer.m2pix(fragRadius * 2);
			const spawnRadiusPx = winnerRadiusPx + Math.max(marginPx, 2); 
			
			// Scatter along normals
			const spreadAngle = (Math.random() - 0.5) * Math.PI;
			const angle = baseAngle + spreadAngle;
			
			const fragX = winnerX + nx * spawnRadiusPx + Math.cos(angle) * (Math.random() * 5);
			const fragY = winnerY + ny * spawnRadiusPx + Math.sin(angle) * (Math.random() * 5);
			
			const scatterPx = this.renderer.m2pix(2000 + (Math.random() * 3000));
			const fragVx = baseVx + (Math.cos(angle) * scatterPx);
			const fragVy = baseVy + (Math.sin(angle) * scatterPx);

			const fragName = loserObj.name.endsWith(' Debris') ? loserObj.name : `${loserObj.name} Debris`;

			const fragment = new GravSimObject(
				fragName,
				fragX, fragY,
				fragVx, fragVy,
				fragMass,
				debrisColor,
				Math.log10(fragRadius * 8) / 2.5,
				fragRadius,
				1
			);
			this.addObject(fragment);
		}
	}

	// Vanish target object and create debris
	_shatterObject(obj) {
		console.debug(`${obj.name} (id:${obj.id}) shattered by tidal force.`);

		// Vanish object & add shock-wave
		this.removeObject(obj);
		this.renderer.addShockwave(obj.x, obj.y, obj.color);

		const nextGen = obj.generation + 1;

		// Calculate the base number of debris by its mass
		const baseCount = Math.floor(Math.log10(obj.mass));

		// Apply decrease ratio according to generation
		const decay = Math.pow(DEBRIS_FRAG_DECAY_RATE, nextGen - 1);

		// Calculate the number of fragment according to the base count & decrease ratio
		const fragmentCount = Math.max(DEBRIS_MIN_FRAG, Math.floor(baseCount / decay));

		const baseMass = obj.mass / fragmentCount;

		// Generate the color of debris
		const debrisColor = this._mixWithGray(obj.color, 0.6);

		// Generate debris
		for (let i = 0; i < fragmentCount; i++) {
			// Decide the mass by random (ignore the accuracy)
			const massVariation = 0.8 + (Math.random() * 0.4); 
			const fragMass = baseMass * massVariation;

			// Calculate the radius based on the mass (r ∝ M^(1/3))
			const fragRadius = obj.radius * Math.cbrt(fragMass / obj.mass);
			
			// Append random coordinates to original coordinates
			const angle = (i / fragmentCount) * Math.PI * 2;
			const spreadPx = this.renderer.m2pix(obj.radius * 2);
			const fragX = obj.x + Math.cos(angle) * spreadPx;
			const fragY = obj.y + Math.sin(angle) * spreadPx;
			
			// Append random velocity to original velocity (almost 1km/s = 1000m/s)
			const scatterPx = this.renderer.m2pix(1000 + (Math.random() * 2000));
			const fragVx = obj.vx + (Math.cos(angle) * scatterPx);
			const fragVy = obj.vy + (Math.sin(angle) * scatterPx);

			// Deploy debris objects
			const fragName = obj.name.endsWith(' Debris') ? obj.name : `${obj.name} Debris`;

			// Deploy debris objects
			const fragment = new GravSimObject(
				fragName,
				fragX, fragY,
				fragVx, fragVy,
				fragMass,
				debrisColor,
				Math.log10(fragRadius * 8) / 2.5,
				fragRadius,
				nextGen
			);
			this.addObject(fragment);
		}
	}

	// Mix with gray (#808080)
	_mixWithGray(hexColor, grayRatio) {
		let c = hexColor.replace('#', '');
		if (c.length === 3) c = c.split('').map(x => x + x).join('');
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;

		const gray = 128; // #808080
		const mixR = Math.round(r * (1 - grayRatio) + gray * grayRatio);
		const mixG = Math.round(g * (1 - grayRatio) + gray * grayRatio);
		const mixB = Math.round(b * (1 - grayRatio) + gray * grayRatio);

		return '#' + ((1 << 24) + (mixR << 16) + (mixG << 8) + mixB).toString(16).slice(1).toUpperCase();
	}

	_checkEscapeAndRemove() {
		if (!this.centerObject) { return; }

		for (const obj of this.objects) {
			if (obj.id === this.centerObject.id || obj.state !== OBJECT_STATE.ACTIVE) {
				obj.isEscaping = false;
				continue;
			}

			const dx = obj.x - this.centerObject.x;
			const dy = obj.y - this.centerObject.y;
			const distPx = Math.sqrt(dx * dx + dy * dy);

			const r = this.renderer.pix2m(distPx);
			if (r === 0) { continue; }

			const dvx = this.renderer.pix2m(obj.vx - this.centerObject.vx);
			const dvy = this.renderer.pix2m(obj.vy - this.centerObject.vy);

			// Relative velocity squared
			const v2 = dvx * dvx + dvy * dvy;

			const totalMass = (this.centerObject.mass + obj.mass) * 1e3;
			const escapeV2 = (2 * G * totalMass) / r; // Escape velocity squared (v_e^2 = 2GM / r)

			// Check if the object is escaping the center object's gravity
			obj.isEscaping = (v2 >= escapeV2);

			// Remove the object if it is escaping and far enough
			if (obj.isEscaping && this.renderer.pix2au(distPx) > REMOVE_DISTANCE_AU) {
				this.removeObject(obj);
				console.debug(`${obj.name} (id:${obj.id}) got out from heliosphere`);
			}
		}
	}

	destroy() {
		this.objects.forEach(obj => this.removeObject(obj));
		this.objects = [];
	}
}
