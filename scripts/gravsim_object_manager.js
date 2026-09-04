
// gravsim_object_manager.js

import {
	PHYSICS, SIMULATION, RENDER,
	OBJECT_STATE, OBJECT_TYPES,
	CALC_BUFFER_CONFIG, BUFFER_INDEX
} from './gravsim_const.js';
import { GravSimObject, CelestialBody, Rocket, Debris } from './gravsim_object.js';
import { UnitConvertUtils } from './gravsim_utils.js';
import { WorkerBridge } from './gravsim_worker_bridge.js';
import { EventBus } from './gravsim_event_bus.js';

export class ObjectManager {
	constructor(renderer, workerManager) {
		this.renderer = renderer;
		this.workerManager = workerManager;
		this.objects = [];
		this.physicsSequence = 0;

		EventBus.on('rocket:update-state', (id, isIgnited, isHoldDown) => {
			this.updateRocketState(id, isIgnited, isHoldDown);
		});
	}

	destroy() {
		this.objects.forEach(obj => this.removeObject(obj));
		this.objects = [];
	}

	getNextId() {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);
		const id = GravSimObject._idCounter;
		GravSimObject._idCounter++;
		return id;
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		this.objects.push(obj);

		const payload = {
			cmd: 'add',
			id: obj.id,
			name: obj.name,
			type: obj.type,
			x: UnitConvertUtils.pix2m(obj.x), y: UnitConvertUtils.pix2m(obj.y),
			vx: UnitConvertUtils.pix2m(obj.vx), vy: UnitConvertUtils.pix2m(obj.vy),
			ax: UnitConvertUtils.pix2m(obj.ax), ay: UnitConvertUtils.pix2m(obj.ay),
			radius: obj.radius,
			generation: obj.generation
		};

		if (obj.type === OBJECT_TYPES.ROCKET) {
			Object.assign(payload, this._buildRocketPayload(obj));
		} else {
			payload.mass = UnitConvertUtils.ton2kg(obj.mass);
			payload.fuelMass = 0;
		}

		this.workerManager.postMessage(payload);
	}

	_buildRocketPayload(obj) {
		return {
			mass: UnitConvertUtils.ton2kg(obj.dryMass),
			fuelMass: UnitConvertUtils.ton2kg(obj.fuelMass),
			oxidMass: UnitConvertUtils.ton2kg(obj.oxidMass),
			ofRatio: obj.ofRatio || 0,
			thrustForce: obj.thrustForce || 0,
			burnTime: obj.burnTime || 0,
			thrustAngle: obj.thrustAngle || 0,
			flightProfile: obj.flightProfile || [],
			massLossRate: UnitConvertUtils.ton2kg(obj.massLossRate || 0),
			maxGLimit: obj.maxGLimit || 0,
			autoControl: obj.autoControl !== undefined ? obj.autoControl : true,
			hostId: obj.hostId !== undefined ? obj.hostId : null,
			hostAngleRad: obj.hostAngleRad || 0,
			hostAltM: obj.hostAltM || 0,
			isHoldDown: obj.isHoldDown || false,
			isIgnited: obj.isIgnited !== undefined ? obj.isIgnited : true
		};
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		obj.setCollided();
		this.workerManager.postMessage({ cmd: 'remove', id: obj.id });
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		this.workerManager.postMessage({
			cmd: 'update',
			id: obj.id,
			x: UnitConvertUtils.pix2m(obj.x), y: UnitConvertUtils.pix2m(obj.y),
			vx: UnitConvertUtils.pix2m(obj.vx), vy: UnitConvertUtils.pix2m(obj.vy),
			ax: UnitConvertUtils.pix2m(obj.ax), ay: UnitConvertUtils.pix2m(obj.ay),
			mass: UnitConvertUtils.ton2kg(obj.mass),
			radius: obj.radius,
			generation: obj.generation,
		});
	}

	updateRocketState(id, isIgnited, isHoldDown) {
		const payload = { cmd: 'setRocketState', id: id };
		if (isIgnited !== undefined) { payload.isIgnited = isIgnited; }
		if (isHoldDown !== undefined) { payload.isHoldDown = isHoldDown; }
		this.workerManager.postMessage(payload);
	}

	updateObjectParams(data) {
		this.physicsSequence++;

		WorkerBridge.parseWorkerToMain(data.objectsData, data.validLength, (objData) => {
			const target = this.objects.find(t => t.id === objData.id);
			if (target) {
				this._applyBaseState(target, objData);

				if (objData.type === OBJECT_TYPES.ROCKET) {
					this._applyRocketState(target, objData);
				}

				target.updateHistory(this.physicsSequence, this.objects);

				if (objData.isCollided) {
					if (objData.isImpact && target.state === OBJECT_STATE.ACTIVE) {
						console.debug(`${target.name} (id:${target.id}) impacted.`);
						// Emit event to DestructionManager
						EventBus.emit('object:impacted', target, objData);
					}
					target.setCollided();
				}

				// Handle object shattered by tidal force or Max-Q in the worker
				if (objData.isShattered && target.state === OBJECT_STATE.ACTIVE) {
					console.debug(`${target.name} (id:${target.id}) shattered.`);
					this.removeObject(target);
					// Emit event to DestructionManager
					EventBus.emit('object:shattered', target);
				}
			}
		});

		// Return the buffer to the worker using Transferable Objects
		this.workerManager.postMessage(
			{ cmd: 'returnBuffer', buffer: data.objectsData },
			[data.objectsData]
		);
	}

	_applyBaseState(target, objData) {
		target.x = UnitConvertUtils.m2pix(objData.x);
		target.y = UnitConvertUtils.m2pix(objData.y);
		target.vx = UnitConvertUtils.m2pix(objData.vx);
		target.vy = UnitConvertUtils.m2pix(objData.vy);
		target.ax = UnitConvertUtils.m2pix(objData.ax);
		target.ay = UnitConvertUtils.m2pix(objData.ay);

		if (objData.type !== OBJECT_TYPES.ROCKET) {
			target.mass = UnitConvertUtils.kg2ton(objData.mass);
		}
		
		target.radius = objData.radius;
		target.inAtmosphere = objData.inAtmosphere;
		target.isEscaping = objData.isEscaping;
		target.dominantBodyId = objData.dominantBodyId;
		target.distToDominantM = objData.distToDominantM;
	}

	_applyRocketState(target, objData) {
		target.dryMass = UnitConvertUtils.kg2ton(objData.mass);
		target.fuelMass = UnitConvertUtils.kg2ton(objData.fuelMass);
		target.oxidMass = UnitConvertUtils.kg2ton(objData.oxidMass);
		target.burnTime = objData.burnTime;
		target.thrustRatio = objData.thrustRatio;
		target.isHoldDown = objData.isHoldDown;
		target.isIgnited = objData.isIgnited;

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
			isAntiStallActive: objData.isAntiStall,
			isQLimitNear: objData.isQLimitNear,
			isGLimitNear: objData.isGLimitNear,
		};
		target.thrustAngle = objData.thrustAngle;
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
				if (UnitConvertUtils.pix2au(Math.sqrt(cx*cx + cy*cy)) > SIMULATION.REMOVE_DISTANCE_AU) {
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
				base.oxidMass = obj.oxidMass;
				base.ofRatio = obj.ofRatio;
				base.thrustForce = obj.thrustForce;
				base.burnTime = obj.burnTime;
				base.thrustAngle = obj.thrustAngle;
				base.flightProfile = obj.flightProfile;
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
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.dryMass, o.fuelMass, o.oxidMass || 0, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
					obj.ofRatio = o.ofRatio || 0;
					obj.thrustForce = o.thrustForce || 0;
					obj.burnTime = o.burnTime || 0;
					obj.thrustAngle = o.thrustAngle || 0;

					if (o.flightProfile !== undefined) {
						obj.flightProfile = o.flightProfile;
					} else {
						obj.flightProfile = [];
					}

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
