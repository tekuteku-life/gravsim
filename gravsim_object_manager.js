
// gravsim_object_manager.js

import {
	PHYSICS, SIMULATION, DEBRIS,
	OBJECT_STATE, OBJECT_TYPES,
	CALC_BUFFER_CONFIG, BUFFER_INDEX
} from './gravsim_const.js';
import { GravSimObject, CelestialBody, Rocket, Debris } from './gravsim_object.js';
import { ColorUtils } from './gravsim_utils.js';
import { WorkerBridge } from './gravsim_worker_bridge.js';
import { DebrisGenerator } from './gravsim_debris_generator.js';

export class ObjectManager {
	constructor(renderer, workerManager) {
		this.renderer = renderer;
		this.workerManager = workerManager;
		this.objects = [];
		this.centerObject = null;
		this.physicsSequence = 0;
	}

	destroy() {
		this.objects.forEach(obj => this.removeObject(obj));
		this.objects = [];
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
		this.physicsSequence++;

		WorkerBridge.parseWorkerToMain(data.objectsData, (objData) => {
			const target = this.objects.find(t => t.id === objData.id);
			if (target) {
				target.x = this.renderer.m2pix(objData.x);
				target.y = this.renderer.m2pix(objData.y);
				target.vx = this.renderer.m2pix(objData.vx);
				target.vy = this.renderer.m2pix(objData.vy);
				target.ax = this.renderer.m2pix(objData.ax);
				target.ay = this.renderer.m2pix(objData.ay);

				if (objData.type === OBJECT_TYPES.ROCKET) {
					target.dryMass = objData.mass / 1e3;
					target.fuelMass = objData.fuelMass / 1e3;
					target.burnTime = objData.burnTime;
					target.thrustRatio = objData.thrustRatio;

					target.telemetry = {
						status: objData.tmStatus,
						qAxialKpa: objData.tmQAxial,
						qLateralKpa: objData.tmQLateral,
						structRatio: objData.tmStructRatio,
						aoaDeg: objData.tmAoaDeg,
						progradeAngle: objData.tmProgradeAngle,
						gravityAngle: objData.tmGravityAngle,
						remDv: objData.tmRemDv,
						twr: objData.tmTwr,
						altM: objData.tmAltM,
						vV: objData.tmVv,
						vH: objData.tmVh,
						aV: objData.tmAv,
						aH: objData.tmAh,
						currentG: objData.tmCurrentG,
						flightTime: objData.tmFlightTime,
					};
					target.thrustAngle = objData.thrustAngle;
				} else {
					target.mass = objData.mass / 1e3;
				}
				
				target.radius = objData.radius;
				target.updateHistory(this.physicsSequence);

				target.inAtmosphere = objData.inAtmosphere;
				target.isEscaping = objData.isEscaping;
				target.dominantBodyId = objData.dominantBodyId;
				target.distToDominantM = objData.distToDominantM;

				if (objData.isCollided) {
					if (objData.isImpact && target.state === OBJECT_STATE.ACTIVE) {
						// Generate debris and effects via DebrisGenerator
						const debrisData = DebrisGenerator.generateFromImpact(
							target,
							objData.debrisMass / 1e3,
							this.renderer.m2pix(objData.impactVx),
							this.renderer.m2pix(objData.impactVy),
							this.renderer.m2pix(objData.impactWinnerX),
							this.renderer.m2pix(objData.impactWinnerY),
							this.renderer.m2pix(objData.impactWinnerRadius),
							(m) => this.renderer.m2pix(m),
							() => this.getNextId()
						);

						if (debrisData.shockwave) {
							this.renderer.addShockwave(debrisData.shockwave.x, debrisData.shockwave.y, debrisData.shockwave.color);
						}
						debrisData.debrisList.forEach(debris => this.addObject(debris));
					}
					target.setCollided();
				}

				// Handle object shattered by tidal force or Max-Q in the worker
				if (objData.isShattered && target.state === OBJECT_STATE.ACTIVE) {
					console.debug(`${target.name} (id:${target.id}) shattered.`);
					this.removeObject(target);

					// Generate debris and effects via DebrisGenerator
					const debrisData = DebrisGenerator.generateFromShatter(
						target,
						(m) => this.renderer.m2pix(m),
						() => this.getNextId()
					);

					if (debrisData.shockwave) {
						this.renderer.addShockwave(debrisData.shockwave.x, debrisData.shockwave.y, debrisData.shockwave.color);
					}
					debrisData.debrisList.forEach(debris => this.addObject(debris));
				}
			}
		});
	}

	cleanupObjects() {
		this._checkEscapeAndRemove();
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	_checkEscapeAndRemove() {
		const massiveBodies = this.objects.filter(o => o.type === OBJECT_TYPES.CELESTIAL && o.state === OBJECT_STATE.ACTIVE);
		if (massiveBodies.length === 0) { return; }
		const sun = massiveBodies.reduce((max, obj) => obj.mass > max.mass ? obj : max, massiveBodies[0]);

		for (const obj of this.objects) {
			if (obj.id === sun.id || obj.state !== OBJECT_STATE.ACTIVE) {
				continue;
			}

			// Remove the object if it is escaping and far enough
			if (obj.isEscaping) {
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
				} else if (o.type === OBJECT_TYPES.DEBRIS) {
					obj = new Debris(
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.mass, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
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
}
