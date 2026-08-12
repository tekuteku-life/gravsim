
// gravsim_object_manager.js

import {
	PHYSICS, SIMULATION, DEBRIS,
	OBJECT_STATE, OBJECT_TYPES,
	CALC_BUFFER_CONFIG, BUFFER_INDEX
} from './gravsim_const.js';
import { GravSimObject, CelestialBody, Rocket } from './gravsim_object.js';

export class ObjectManager {
	constructor(renderer, workerManager) {
		this.renderer = renderer;
		this.workerManager = workerManager;
		this.objects = [];
		this.centerObject = null;
	}

	ensureCenterObject(currentOffset = {x: 0, y: 0}) {
		if (this.centerObject && this.centerObject.state !== OBJECT_STATE.ACTIVE) {
			const oldCenter = this.centerObject;
			let nextCenter = null;

			// Tracking debris
			const debrisName = oldCenter.name.endsWith(' Debris') ? oldCenter.name : `${oldCenter.name} Debris`;
			const debrisList = this.objects.filter(o => o.name === debrisName && o.state === OBJECT_STATE.ACTIVE);
			if (debrisList.length > 0) {
				nextCenter = debrisList.reduce((max, obj) => obj.mass > max.mass ? obj : max, debrisList[0]);
			}

			// Select lergest object
			if (!nextCenter && this.objects.length > 0) {
				nextCenter = this.objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, this.objects[0]);
			}

			if (nextCenter) {
				// Keep camera position
				const newOffset = {
					x: currentOffset.x + (oldCenter.x - nextCenter.x),
					y: currentOffset.y + (oldCenter.y - nextCenter.y)
				};
				this.centerObject = nextCenter;
				return { changed: true, newOffset, newCenter: nextCenter };
			}
		}
		return { changed: false };
	}

	getNextId() {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);
		const id = GravSimObject._idCounter;
		GravSimObject._idCounter++;
		return id;
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		this.objects.push(obj);
		const isRocket = obj.type === OBJECT_TYPES.ROCKET;
		this.workerManager.postMessage({
			cmd: 'add',
			id: obj.id,
			name: obj.name,
			type: obj.type,
			x: this.renderer.pix2m(obj.x), y: this.renderer.pix2m(obj.y),
			vx: this.renderer.pix2m(obj.vx), vy: this.renderer.pix2m(obj.vy),
			ax: this.renderer.pix2m(obj.ax), ay: this.renderer.pix2m(obj.ay),
			mass: isRocket ? obj.dryMass * 1e3 : obj.mass * 1e3,
			fuelMass: isRocket ? obj.fuelMass * 1e3 : 0,
			radius: obj.radius,
			generation: obj.generation,
			thrustForce: obj.thrustForce || 0,
			burnTime: obj.burnTime || 0,
			thrustAngle: obj.thrustAngle || 0,
			massLossRate: (obj.massLossRate || 0) * 1e3,
			maxGLimit: obj.maxGLimit || 0,
			autoControl: isRocket ? obj.autoControl : true,
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
		const objCount = buffer.length / CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;

		for (let i = 0; i < objCount; i++) {
			const offset = i * CALC_BUFFER_CONFIG.OBJ_ATTR_COUNT;
			const id = buffer[offset + BUFFER_INDEX.ID];

			const target = this.objects.find(t => t.id === id);
			if (target) {
				const type = buffer[offset + BUFFER_INDEX.TYPE];
				target.x = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.X]);
				target.y = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.Y]);
				target.vx = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.VX]);
				target.vy = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.VY]);
				target.ax = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.AX]);
				target.ay = this.renderer.m2pix(buffer[offset + BUFFER_INDEX.AY]);

				if (type === OBJECT_TYPES.ROCKET) {
					target.dryMass = buffer[offset + BUFFER_INDEX.MASS] / 1e3;
					target.fuelMass = buffer[offset + BUFFER_INDEX.FUEL_MASS] / 1e3;
					target.burnTime = buffer[offset + BUFFER_INDEX.BURN_TIME];
					target.thrustRatio = buffer[offset + BUFFER_INDEX.THRUST_RATIO];

					target.telemetry = {
						status: buffer[offset + BUFFER_INDEX.TM_STATUS],
						qAxialKpa: buffer[offset + BUFFER_INDEX.TM_Q_AXIAL],
						qLateralKpa: buffer[offset + BUFFER_INDEX.TM_Q_LATERAL],
						structRatio: buffer[offset + BUFFER_INDEX.TM_STRUCT_RATIO],
						aoaDeg: buffer[offset + BUFFER_INDEX.TM_AOA_DEG],
						progradeAngle: buffer[offset + BUFFER_INDEX.TM_PROGRADE_ANGLE],
						gravityAngle: buffer[offset + BUFFER_INDEX.TM_GRAVITY_ANGLE],
						remDv: buffer[offset + BUFFER_INDEX.TM_REM_DV],
						twr: buffer[offset + BUFFER_INDEX.TM_TWR],
						altM: buffer[offset + BUFFER_INDEX.TM_ALT_M],
						vV: buffer[offset + BUFFER_INDEX.TM_VV],
						vH: buffer[offset + BUFFER_INDEX.TM_VH],
						aV: buffer[offset + BUFFER_INDEX.TM_AV],
						aH: buffer[offset + BUFFER_INDEX.TM_AH],
						currentG: buffer[offset + BUFFER_INDEX.TM_CURRENT_G],
						flightTime: buffer[offset + BUFFER_INDEX.TM_FLIGHT_TIME],
					};
					target.thrustAngle = buffer[offset + BUFFER_INDEX.THRUST_ANGLE];
				} else {
					target.mass = buffer[offset + BUFFER_INDEX.MASS] / 1e3;
				}
				target.radius = buffer[offset + BUFFER_INDEX.RADIUS];
				target.addHistory();

				const flags = buffer[offset + BUFFER_INDEX.FLAGS];
				const isCollided = (flags & 1) !== 0;
				const isShattered = (flags & 2) !== 0;
				const isImpact = (flags & 4) !== 0;

				if (isCollided) {
					if (isImpact && target.state === OBJECT_STATE.ACTIVE) {
						this._generateImpactDebris(
							target, 
							buffer[offset + BUFFER_INDEX.DEBRIS_MASS] / 1e3,
							this.renderer.m2pix(buffer[offset + BUFFER_INDEX.IMPACT_VX]), 
							this.renderer.m2pix(buffer[offset + BUFFER_INDEX.IMPACT_VY]),
							this.renderer.m2pix(buffer[offset + BUFFER_INDEX.IMPACT_WINNER_X]),
							this.renderer.m2pix(buffer[offset + BUFFER_INDEX.IMPACT_WINNER_Y]),
							this.renderer.m2pix(buffer[offset + BUFFER_INDEX.IMPACT_WINNER_RADIUS])
						);
					}
					target.setCollided();
				}

				// Handle object shattered by tidal force or Max-Q in the worker
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
			const massVariation = DEBRIS.MASS_VAR_BASE + (Math.random() * DEBRIS.MASS_VAR_RANGE);
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

			const nextId = this.getNextId();
			const fragment = new CelestialBody(
				nextId, fragName, fragX, fragY, fragVx, fragVy, fragMass, debrisColor, 
				Math.log10(fragRadius * 8) / 2.5, fragRadius, nextGen, null, 0
			);
			this.addObject(fragment);
		}
	}

	_generateImpactDebris(loserObj, totalDebrisMass, baseVx, baseVy, winnerX, winnerY, winnerRadiusPx) {
		this.renderer.addShockwave(loserObj.x, loserObj.y, loserObj.color);

		if (totalDebrisMass <= 0) { return; }

		const fragmentCount = Math.max(DEBRIS.MIN_FRAG, Math.floor(Math.log10(totalDebrisMass) * 1.5));
		const baseMass = totalDebrisMass / fragmentCount;
		const debrisColor = this._mixWithGray(loserObj.color, DEBRIS.GRAY_MIX_RATIO);

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
			DEBRIS.IMPACT_SCATTER_BASE, DEBRIS.IMPACT_SCATTER_VAR,
			{ nx, ny, baseAngle, winnerRadiusPx }
		);
	}

	// Vanish target object and create debris
	_shatterObject(obj) {
		console.debug(`${obj.name} (id:${obj.id}) shattered.`);

		this.removeObject(obj);
		this.renderer.addShockwave(obj.x, obj.y, obj.color);

		const nextGen = obj.generation + 1;
		const baseCount = Math.floor(Math.log10(obj.mass));
		const decay = Math.pow(DEBRIS.FRAG_DECAY_RATE, nextGen - 1);
		const fragmentCount = Math.max(DEBRIS.MIN_FRAG, Math.floor(baseCount / decay));
		const baseMass = obj.mass / fragmentCount;
		const debrisColor = this._mixWithGray(obj.color, DEBRIS.GRAY_MIX_RATIO);

		// Generate debris
		this._spawnDebrisParticles(
			obj, fragmentCount, baseMass, debrisColor, nextGen,
			obj.vx, obj.vy, obj.x, obj.y,
			DEBRIS.SHATTER_SCATTER_BASE, DEBRIS.SHATTER_SCATTER_VAR,
			null
		);
	}

	// Mix with gray
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
		const massiveBodies = this.objects.filter(o => o.type === OBJECT_TYPES.CELESTIAL && o.state === OBJECT_STATE.ACTIVE);
		if (massiveBodies.length === 0) { return; }
		const sun = massiveBodies.reduce((max, obj) => obj.mass > max.mass ? obj : max, massiveBodies[0]);

		for (const obj of this.objects) {
			if (obj.id === sun.id || obj.state !== OBJECT_STATE.ACTIVE) {
				obj.isEscaping = false;
				continue;
			}

			let dominantBody = null;
			let maxG = -1;
			let distToDominantM = 0;

			for (const mBody of massiveBodies) {
				if (obj.id === mBody.id) { continue; }
				const dx = obj.x - mBody.x;
				const dy = obj.y - mBody.y;
				const distSqPx = dx * dx + dy * dy;
				const distSqM = Math.pow(this.renderer.pix2m(Math.sqrt(distSqPx)), 2);
				if (distSqM === 0) { continue; }
				
				const gForce = mBody.mass / distSqM;
				if (gForce > maxG) {
					maxG = gForce;
					dominantBody = mBody;
					distToDominantM = Math.sqrt(distSqM);
				}
			}

			if (dominantBody && distToDominantM > 0) {
				const dvx = this.renderer.pix2m(obj.vx - dominantBody.vx);
				const dvy = this.renderer.pix2m(obj.vy - dominantBody.vy);
				const v2 = dvx * dvx + dvy * dvy;
				
				const totalMassKg = (dominantBody.mass + obj.mass) * 1e3;
				const escapeV2 = (2 * PHYSICS.G * totalMassKg) / distToDominantM;

				// Check if the object is escaping the center object's gravity
				obj.isEscaping = (v2 >= escapeV2);
			} else {
				obj.isEscaping = false;
			}

			// Remove the object if it is escaping and far enough
			if (obj.isEscaping && dominantBody && dominantBody.id === sun.id) {
				const cx = obj.x - sun.x;
				const cy = obj.y - sun.y;
				if (this.renderer.pix2au(Math.sqrt(cx*cx + cy*cy)) > SIMULATION.REMOVE_DISTANCE_AU) {
					this.removeObject(obj);
					console.debug(`${obj.name} (id:${obj.id}) got out from heliosphere`);
				}
			}
		}
	}

	getState() {
		return this.objects.map(obj => {
			const base = {
				id: obj.id, type: obj.type, name: obj.name,
				x: obj.x, y: obj.y, vx: obj.vx, vy: obj.vy,
				color: obj.color, size: obj.size, radius: obj.radius,
				generation: obj.generation, borderColor: obj.borderColor, borderWidth: obj.borderWidth
			};
			if (obj.type === OBJECT_TYPES.ROCKET) {
				base.dryMass = obj.dryMass;
				base.fuelMass = obj.fuelMass;
				base.thrustForce = obj.thrustForce;
				base.burnTime = obj.burnTime;
				base.thrustAngle = obj.thrustAngle;
				base.massLossRate = obj.massLossRate;
				base.maxGLimit = obj.maxGLimit;
			} else {
				base.mass = obj.mass;
			}
			return base;
		});
	}

	loadState(stateArray) {
		this.destroy();
		let maxId = -1;

		if (Array.isArray(stateArray)) {
			stateArray.forEach(o => {
				let obj;
				if (o.type === OBJECT_TYPES.ROCKET) {
					obj = new Rocket(
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.dryMass, o.fuelMass, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
					obj.thrustForce = o.thrustForce || 0;
					obj.burnTime = o.burnTime || 0;
					obj.thrustAngle = o.thrustAngle || 0;
					obj.massLossRate = o.massLossRate || 0;
					obj.maxGLimit = o.maxGLimit || 0;
				} else {
					obj = new CelestialBody(
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.mass, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
				}
				this.addObject(obj);
				if (o.id > maxId) maxId = o.id;
			});
			GravSimObject._idCounter = maxId + 1;
		}
	}

	destroy() {
		this.objects.forEach(obj => this.removeObject(obj));
		this.objects = [];
	}
}
