import {
	G, REMOVE_DISTANCE_AU, DEBRIS_MIN_FRAG,
	DEBRIS_FRAG_DECAY_RATE, OBJECT_STATE,
	DEBRIS_IMPACT_SCATTER_BASE, DEBRIS_IMPACT_SCATTER_VAR,
	DEBRIS_SHATTER_SCATTER_BASE, DEBRIS_SHATTER_SCATTER_VAR,
	DEBRIS_MASS_VAR_BASE, DEBRIS_MASS_VAR_RANGE,
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
			thrustForce: obj.thrustForce || 0,
			burnTime: obj.burnTime || 0,
			thrustAngle: obj.thrustAngle || 0,
			emptyMass: (obj.emptyMass || 0) * 1e3,
			massLossRate: (obj.massLossRate || 0) * 1e3,
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
		const buffer = new Float64Array(data.objectsData);
		const OBJ_ATTR_COUNT = 19;
		const objCount = buffer.length / OBJ_ATTR_COUNT;

		for (let i = 0; i < objCount; i++) {
			const offset = i * OBJ_ATTR_COUNT;
			const id = buffer[offset + 0];

			const target = this.objects.find(t => t.id === id);
			if (target) {
				target.x = this.renderer.m2pix(buffer[offset + 1]);
				target.y = this.renderer.m2pix(buffer[offset + 2]);
				target.vx = this.renderer.m2pix(buffer[offset + 3]);
				target.vy = this.renderer.m2pix(buffer[offset + 4]);
				target.ax = this.renderer.m2pix(buffer[offset + 5]);
				target.ay = this.renderer.m2pix(buffer[offset + 6]);
				target.mass = buffer[offset + 7] / 1e3;
				target.radius = buffer[offset + 8];
				target.burnTime = buffer[offset + 9];
				target.addHistory();

				const flags = buffer[offset + 10];
				const isCollided = (flags & 1) !== 0;
				const isShattered = (flags & 2) !== 0;
				const isImpact = (flags & 4) !== 0;

				if (isCollided) {
					if (isImpact && target.state === OBJECT_STATE.ACTIVE) {
						this._generateImpactDebris(
							target, 
							buffer[offset + 11] / 1e3,
							this.renderer.m2pix(buffer[offset + 12]), 
							this.renderer.m2pix(buffer[offset + 13]),
							this.renderer.m2pix(buffer[offset + 14]),
							this.renderer.m2pix(buffer[offset + 15]),
							this.renderer.m2pix(buffer[offset + 16])
						);
					}

					target.setCollided();
				}

				// Handle object shattered by tidal force in the worker
				if (isShattered && target.state === OBJECT_STATE.ACTIVE) {
					this._shatterObject(target);
				}
			}
		}
	}

	cleanupObjects() {
		this._checkEscapeAndRemove();
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	_spawnDebrisParticles(sourceObj, fragmentCount, baseMass, debrisColor, nextGen,
		baseVx, baseVy, centerX, centerY, scatterBaseM, scatterVarM, impactData = null) {
		for (let i = 0; i < fragmentCount; i++) {
			const massVariation = DEBRIS_MASS_VAR_BASE + (Math.random() * DEBRIS_MASS_VAR_RANGE);
			const fragMass = baseMass * massVariation;
			const fragRadius = sourceObj.radius * Math.cbrt(fragMass / sourceObj.mass);

			let angle, fragX, fragY;
			if (impactData) {
				const marginPx = this.renderer.m2pix(fragRadius * 2);
				const spawnRadiusPx = impactData.winnerRadiusPx + Math.max(marginPx, 2);
				const spreadAngle = (Math.random() - 0.5) * Math.PI;
				angle = impactData.baseAngle + spreadAngle;
				fragX = centerX + impactData.nx * spawnRadiusPx + Math.cos(angle) * (Math.random() * 5);
				fragY = centerY + impactData.ny * spawnRadiusPx + Math.sin(angle) * (Math.random() * 5);
			} else {
				const spreadPx = this.renderer.m2pix(sourceObj.radius * 2);
				angle = (i / fragmentCount) * Math.PI * 2;
				fragX = centerX + Math.cos(angle) * spreadPx;
				fragY = centerY + Math.sin(angle) * spreadPx;
			}

			const scatterPx = this.renderer.m2pix(scatterBaseM + (Math.random() * scatterVarM));
			const fragVx = baseVx + (Math.cos(angle) * scatterPx);
			const fragVy = baseVy + (Math.sin(angle) * scatterPx);

			const fragName = sourceObj.name.endsWith(' Debris') ? sourceObj.name : `${sourceObj.name} Debris`;

			const fragment = new GravSimObject(
				fragName, fragX, fragY, fragVx, fragVy, fragMass, debrisColor, 
				Math.log10(fragRadius * 8) / 2.5, fragRadius, nextGen
			);
			this.addObject(fragment);
		}
	}

	_generateImpactDebris(loserObj, totalDebrisMass, baseVx, baseVy, winnerX, winnerY, winnerRadiusPx) {
		this.renderer.addShockwave(loserObj.x, loserObj.y, loserObj.color);

		if (totalDebrisMass <= 0) { return; }

		const fragmentCount = Math.max(DEBRIS_MIN_FRAG, Math.floor(Math.log10(totalDebrisMass) * 1.5));
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

		this._spawnDebrisParticles(
			loserObj, fragmentCount, baseMass, debrisColor, 1,
			baseVx, baseVy, winnerX, winnerY,
			DEBRIS_IMPACT_SCATTER_BASE, DEBRIS_IMPACT_SCATTER_VAR,
			{ nx, ny, baseAngle, winnerRadiusPx }
		);
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
		this._spawnDebrisParticles(
			obj, fragmentCount, baseMass, debrisColor, nextGen,
			obj.vx, obj.vy, obj.x, obj.y,
			DEBRIS_SHATTER_SCATTER_BASE, DEBRIS_SHATTER_SCATTER_VAR,
			null
		);
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
