
// gravsim_object_manager.js

import {
	SIMULATION, OBJECT_STATE, OBJECT_TYPES,
	MULTISTAGE_ROCKET, TELEMETRY
} from './gravsim_const.js';
import { ROCKET_VISUAL } from './gravsim_preset_manager.js';
import { GravSimObject, CelestialBody, Rocket, Debris } from './gravsim_object.js';
import { UnitConvertUtils, normalizeMissionStatus, isLiveObject, RocketStackUtils } from './gravsim_utils.js';
import { WorkerBridge } from './gravsim_worker_bridge.js';
import { EventBus } from './gravsim_event_bus.js';

export class ObjectManager {
	constructor(renderer, workerManager) {
		if (renderer && !workerManager && (renderer.calcWorkerManager || renderer.workerManager)) {
			this.renderer = renderer.renderer || null;
			this.workerManager = renderer.calcWorkerManager || renderer.workerManager;
		} else {
			this.renderer = renderer;
			this.workerManager = workerManager;
		}
		this.objects = [];
		this.physicsSequence = 0;
		/** @type {any} */
		this.universe = null;
		// Removals and frames in flight (design §4.13-31). Each 'remove' / 'clear' carries the next sequence number, and
		// every Worker frame the number of the last one the Worker had handled when it made the frame (syncSeq). A frame
		// made before a removal still has the removed object: its data is dropped (an unknown debris id would otherwise
		// be taken for debris the Worker just spawned and come back on the main thread, where nothing removes it again).
		this._syncSeq = 0;
		/** Sequence number of the last 'clear' (Reset / load): a frame made before it belongs to the replaced world. */
		this._clearSeq = 0;
		/** @type {Map<number, number>} id -> sequence number of its removal, until a frame reflects it */
		this._removedIds = new Map();

		EventBus.on('rocket:update-state', (id, isIgnited, isHoldDown) => {
			this.updateRocketState(id, isIgnited, isHoldDown);
		});
	}

	/**
	 * Remove every object (Reset, load). The objects in the simulation are removed one by one (state REMOVED, and a
	 * destroyed rocket is announced); those already removed were announced then. Then the Worker clears its whole world,
	 * debris it spawned in a frame still on its way included, and the frames it made before that are dropped.
	 */
	destroy() {
		this.objects.filter(obj => isLiveObject(obj)).forEach(obj => this.removeObject(obj));
		this.objects = [];
		const seq = this._nextSyncSeq();
		this._clearSeq = seq;
		this._removedIds.clear();
		if (this.workerManager) { this.workerManager.postMessage({ cmd: 'clear', seq }); }
	}

	_nextSyncSeq() {
		this._syncSeq++;
		return this._syncSeq;
	}

	/** Number of the objects in the simulation (isLiveObject), without those that are only fading out. */
	countLive() {
		let n = 0;
		for (const obj of this.objects) { if (isLiveObject(obj)) { n++; } }
		return n;
	}

	getNextId() {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);
		const id = GravSimObject._idCounter;
		GravSimObject._idCounter++;
		return id;
	}

	/**
	 * The world center (CelestialBody.isWorldCenter) while it is in the simulation, else null.
	 * @returns {GravSimObject | null}
	 */
	getWorldCenter() {
		return this.objects.find(o => o.type === OBJECT_TYPES.CELESTIAL && o.isWorldCenter === true && o.state === OBJECT_STATE.ACTIVE) || null;
	}

	/**
	 * @param {GravSimObject} obj
	 * @param {boolean} [syncToWorker]
	 * @param {any} [runtimeState] Worker runtime state of a celestial body / debris from a save (loadState only; rockets
	 *   carry theirs in obj.runtimeState under the restoredRuntimeState contract)
	 */
	addObject(obj, syncToWorker = true, runtimeState = null) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		this.objects.push(obj);

		if (!syncToWorker) {
			return;
		}

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
		} else if (obj.type === OBJECT_TYPES.CELESTIAL) {
			payload.mass = UnitConvertUtils.ton2kg(obj.mass);
			payload.fuelMass = 0;
			payload.rotationAngle = Number.isFinite(obj.rotationAngle) ? obj.rotationAngle : 0;
			payload.param = obj.param || null;
		} else {
			payload.mass = obj.mass;
			payload.fuelMass = 0;
			if (obj.type === OBJECT_TYPES.DEBRIS) {
				payload.debrisSubType = /** @type {any} */ (obj).debrisSubType || 0;
			}
		}
		if (obj.type !== OBJECT_TYPES.ROCKET && runtimeState && typeof runtimeState === 'object') {
			payload.runtimeState = runtimeState;
		}

		this.workerManager.postMessage(payload);
	}

	_buildRocketPayload(obj) {
		return {
			mass: obj.dryMass,
			fuelMass: obj.fuelMass,
			oxidMass: obj.oxidMass,
			ofRatio: obj.ofRatio || 0,
			thrustForce: obj.thrustForce || 0,
			burnTime: obj.burnTime || 0,
			thrustAngle: obj.thrustAngle || 0,
			flightProfile: obj.flightProfile || [],
			massLossRate: obj.massLossRate || 0,
			maxGLimit: obj.maxGLimit || 0,
			autoControl: obj.autoControl !== undefined ? obj.autoControl : true,
			hostId: obj.hostId !== undefined ? obj.hostId : null,
			hostAngleRad: obj.hostAngleRad || 0,
			hostAltM: obj.hostAltM || 0,
			bottomOffsetM: obj.bottomOffsetM || 0,
			baseRadiusM: obj.baseRadiusM || 0,
			isHoldDown: obj.isHoldDown || false,
			isIgnited: obj.isIgnited !== undefined ? obj.isIgnited : true,
			stages: obj.stages,
			payload: obj.payload,
			fairing: obj.fairing,
			boosters: obj.boosters ? JSON.parse(JSON.stringify(obj.boosters)) : null,
			disableStaging: !!obj.disableStaging,
			disableOrbitalCutoff: !!obj.disableOrbitalCutoff,
			targetApogeeKm: obj.targetApogeeKm || 0,
			targetPerigeeKm: obj.targetPerigeeKm || 0,
			targetVInfKmS: obj.targetVInfKmS || 0,
			currentStageIndex: obj.currentStageIndex || 0,
			isPayloadSeparated: !!obj.isPayloadSeparated,
			isStage2Separated: !!obj.isStage2Separated,
			isBoosterBurnout: !!obj.isBoosterBurnout,
			isBoosterSeparated: !!obj.isBoosterSeparated,
			hasPayloadPropulsion: !!obj.hasPayloadPropulsion,
			stageState: obj.stageState,
			stgTimer: obj.stgTimer || 0,
			restoredRuntimeState: obj.restoredRuntimeState === true,
			runtimeState: (obj.restoredRuntimeState === true && obj.runtimeState) ? obj.runtimeState : null,
			colorTheme: obj.colorTheme || 'orange'
		};
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		const announce = this._isFlyingRocket(obj);
		obj.setCollided();
		const seq = this._nextSyncSeq();
		this._removedIds.set(obj.id, seq);
		this.workerManager.postMessage({ cmd: 'remove', id: obj.id, seq });
		if (announce) { EventBus.emit('rocket:destroyed', obj); }
	}

	/**
	 * A rocket not yet destroyed on the main thread. Its destruction (removeObject, or a collision of the frame buffer
	 * in updateObjectParams) emits 'rocket:destroyed' once with the rocket, which SoundEffects listens to (git 0dbb27e
	 * added the listener and no emitter, design §4.13-28).
	 * @param {any} obj
	 */
	_isFlyingRocket(obj) {
		return Boolean(obj && obj.type === OBJECT_TYPES.ROCKET && !obj.isDestroyed);
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) { throw new Error("Invalid object type."); }
		const massVal = (obj.type === OBJECT_TYPES.CELESTIAL) ? UnitConvertUtils.ton2kg(obj.mass) : obj.mass;
		const payload = {
			cmd: 'update',
			id: obj.id,
			x: UnitConvertUtils.pix2m(obj.x), y: UnitConvertUtils.pix2m(obj.y),
			vx: UnitConvertUtils.pix2m(obj.vx), vy: UnitConvertUtils.pix2m(obj.vy),
			ax: UnitConvertUtils.pix2m(obj.ax), ay: UnitConvertUtils.pix2m(obj.ay),
			mass: massVal,
			radius: obj.radius,
			generation: obj.generation
		};
		if (obj.type === OBJECT_TYPES.CELESTIAL && Number.isFinite(obj.rotationAngle)) {
			payload.rotationAngle = obj.rotationAngle;
		}
		this.workerManager.postMessage(payload);
	}

	updateRocketState(id, isIgnited, isHoldDown) {
		const target = this.objects.find(t => t.id === id);
		if (target && target.type === OBJECT_TYPES.ROCKET) {
			if (isIgnited !== undefined) { target.isIgnited = isIgnited; }
			if (isHoldDown !== undefined) { target.isHoldDown = isHoldDown; }
		}

		const payload = { cmd: 'setRocketState', id: id };
		if (isIgnited !== undefined) { payload.isIgnited = isIgnited; }
		if (isHoldDown !== undefined) { payload.isHoldDown = isHoldDown; }
		this.workerManager.postMessage(payload);
	}

	updateObjectParams(data) {
		this.physicsSequence++;

		const isPaused = Boolean(this.universe && this.universe.isPaused);
		const historyTargets = [];
		const pendingDestructions = [];
		// The last removal the frame reflects. A frame without the number (not from the physics Worker: tests and tools
		// that deliver each frame at once) is taken as in step with every message sent
		const ackSeq = (data && Number.isFinite(data.syncSeq)) ? data.syncSeq : this._syncSeq;
		// A frame made before the last Reset / load: everything in it belongs to the replaced world (design §4.13-31)
		const isStaleWorld = ackSeq < this._clearSeq;

		const applyOneObject = (objData) => {
			if (isStaleWorld) { return; }
			// An object the main thread removed after the Worker made this frame: its data is out of date
			const removedSeq = this._removedIds.get(objData.id);
			if (removedSeq !== undefined && removedSeq > ackSeq) { return; }
			const target = this.objects.find(t => t.id === objData.id);
			if (target) {
				// Removed or destroyed, listed only while its trail fades: it takes no more frames (design §4.13-31)
				if (!isLiveObject(target)) { return; }
				this._applyBaseState(target, objData);

				if (objData.type === OBJECT_TYPES.ROCKET) {
					this._applyRocketState(target, objData);
				}

				if (objData.isCollided || objData.isShattered) {
					pendingDestructions.push({
						target,
						objData: {
							isCollided: Boolean(objData.isCollided),
							isImpact: Boolean(objData.isImpact),
							isShattered: Boolean(objData.isShattered),
							// The debris mass of the impact [kg] (BUFFER_INDEX.DEBRIS_MASS), which DestructionManager splits
							// into fragments (design §4.13-23; the two-pass copy had left it out, so no fragment was made)
							debrisMass: objData.debrisMass,
							impactVx: objData.impactVx,
							impactVy: objData.impactVy,
							impactWinnerX: objData.impactWinnerX,
							impactWinnerY: objData.impactWinnerY,
							impactWinnerRadius: objData.impactWinnerRadius
						}
					});
				} else {
					historyTargets.push(target);
				}
			} else if (objData.type === OBJECT_TYPES.DEBRIS && !objData.isCollided && !objData.isShattered) {
				// Autonomously spawned debris in worker (e.g. stage separation or fairing jettison)
				const x = UnitConvertUtils.m2pix(objData.x);
				const y = UnitConvertUtils.m2pix(objData.y);
				const vx = UnitConvertUtils.m2pix(objData.vx);
				const vy = UnitConvertUtils.m2pix(objData.vy);
				const massT = objData.mass;

				const spec = MULTISTAGE_ROCKET.DEBRIS_SPECS[objData.debrisSubType] || {
					name: 'Jettisoned Debris',
					color: '#c8d0d8',
					size: 5.0
				};

				// A rocket still flying (the parent of Worker debris is): a destroyed one stays listed until its trail has
				// faded and would lend its theme to the debris of another rocket (design §4.13-30)
				const activeRocket = this.objects.find(o => o.type === OBJECT_TYPES.ROCKET && o.state === OBJECT_STATE.ACTIVE && !o.isDestroyed);
				const currentTheme = activeRocket?.colorTheme || 'classic';
				const theme = ROCKET_VISUAL.THEMES[currentTheme] || ROCKET_VISUAL.THEMES.classic;

				let debColor = spec.color;
				if (objData.debrisSubType === 1) {
					debColor = theme.stg1Grad[1] || theme.accentBand;
				} else if (objData.debrisSubType === 2) {
					debColor = theme.stg2Grad[0] || theme.accentBand;
				} else if (objData.debrisSubType === 3) {
					debColor = theme.fairingGrad[0] || '#e8ebed';
				} else if (objData.debrisSubType === 4) {
					debColor = '#f0f2f5';
				}

				const debRadius = objData.radius || activeRocket?.baseRadiusM || MULTISTAGE_ROCKET.DEFAULT_STAGE_RADIUS_M;

				const deb = new Debris(
					objData.id,
					spec.name,
					x, y, vx, vy,
					massT,
					debColor,
					spec.size,
					debRadius,
					objData.generation || 1,
					'#00ffcc',
					0,
					objData.debrisSubType || 0,
					currentTheme
				);

				this.addObject(deb, false);
				this._applyBaseState(deb, objData);
				historyTargets.push(deb);
			}
		};

		if (data && data.objectsData) {
			WorkerBridge.parseWorkerToMain(data.objectsData, data.validLength, applyOneObject);
			if (this.workerManager) {
				// Return the buffer to the worker using Transferable Objects
				this.workerManager.postMessage(
					{ cmd: 'returnBuffer', buffer: data.objectsData },
					[data.objectsData]
				);
			}
		} else if (data && data.id !== undefined) {
			applyOneObject(data);
		}
		// Removals the Worker has handled: none of its later frames has those objects
		for (const [id, seq] of this._removedIds) {
			if (seq <= ackSeq) { this._removedIds.delete(id); }
		}

		// Pass 2A: Record history atomically once all hosts and child bodies share the exact same epoch
		for (let i = 0; i < historyTargets.length; i++) {
			historyTargets[i].updateHistory(this.physicsSequence, this.objects, isPaused);
		}

		// Pass 2B: Apply destruction / impact side-effects so cleared paths are never re-populated
		for (let i = 0; i < pendingDestructions.length; i++) {
			const { target, objData } = pendingDestructions[i];
			if (objData.isCollided) {
				if (objData.isImpact && target.state === OBJECT_STATE.ACTIVE) {
					console.debug(`${target.name} (id:${target.id}) impacted.`);
					EventBus.emit('object:impacted', target, objData);
				}
				const announce = this._isFlyingRocket(target);
				target.setCollided();
				if (announce) { EventBus.emit('rocket:destroyed', target); }
			}
			if (objData.isShattered && target.state === OBJECT_STATE.ACTIVE) {
				console.debug(`${target.name} (id:${target.id}) shattered.`);
				this.removeObject(target);
				EventBus.emit('object:shattered', target);
			}
		}
	}

	_applyBaseState(target, objData) {
		target.x = UnitConvertUtils.m2pix(objData.x);
		target.y = UnitConvertUtils.m2pix(objData.y);
		target.vx = UnitConvertUtils.m2pix(objData.vx);
		target.vy = UnitConvertUtils.m2pix(objData.vy);
		target.ax = UnitConvertUtils.m2pix(objData.ax);
		target.ay = UnitConvertUtils.m2pix(objData.ay);

		if (objData.type === OBJECT_TYPES.CELESTIAL) {
			target.mass = UnitConvertUtils.kg2ton(objData.mass);
		} else if (objData.type !== OBJECT_TYPES.ROCKET) {
			target.mass = objData.mass;
		}
		
		target.radius = objData.radius;
		if (objData.type === OBJECT_TYPES.DEBRIS) {
			target.baseRadiusM = objData.radius;
		}
		target.inAtmosphere = objData.inAtmosphere;
		target.isEscaping = objData.isEscaping;
		target.dominantBodyId = objData.dominantBodyId;
		target.distToDominantM = objData.distToDominantM;
		if (Number.isFinite(objData.rotationAngle)) {
			target.rotationAngle = objData.rotationAngle;
		}
	}

	_applyRocketState(target, objData) {
		target.dryMass = objData.mass;
		target.fuelMass = objData.fuelMass;
		target.oxidMass = objData.oxidMass;
		target.burnTime = objData.burnTime;
		target.thrustRatio = objData.thrustRatio;
		target.isHoldDown = objData.isHoldDown;
		target.isIgnited = objData.isIgnited;
		target.isPayloadSeparated = !!objData.isPayloadSeparated;
		target.isBoosterBurnout = !!objData.isBoosterBurnout;
		target.isBoosterSeparated = !!objData.isBoosterSeparated;
		if (target.fairing && objData.tmFairingSeparated !== undefined) {
			target.fairing.isSeparated = Boolean(objData.tmFairingSeparated);
		}
		if (objData.stageState !== undefined) { target.stageState = objData.stageState; }
		if (Number.isFinite(objData.stgTimer)) { target.stgTimer = objData.stgTimer; }
		if (objData.hasPayloadPropulsion !== undefined) { target.hasPayloadPropulsion = Boolean(objData.hasPayloadPropulsion); }
		if (objData.rcsCw !== undefined) { target.rcsCw = Boolean(objData.rcsCw); }
		if (objData.rcsCcw !== undefined) { target.rcsCcw = Boolean(objData.rcsCcw); }
		if (objData.rcsUllage !== undefined) { target.rcsUllage = Boolean(objData.rcsUllage); }
		if (Number.isFinite(objData.mach)) { target.mach = objData.mach; }

		target.radius = objData.radius;
		target.tankPresFuel = objData.tmTankPresFuel;
		target.tankPresOxid = objData.tmTankPresOxid;
		target.ambientPresRatio = objData.tmAmbientPresRatio !== undefined ? objData.tmAmbientPresRatio : 0;
		target.currentIsp = objData.tmCurrentIsp !== undefined ? objData.tmCurrentIsp : 0;

		// Update name from 'Rocket' to payload name upon separation
		if (target.isPayloadSeparated && target.payload?.name) {
			if (target.name !== target.payload.name) {
				target.name = target.payload.name;
				EventBus.emit('object-list-changed', this.countLive());
			}
		}

		// The relative altitude is the height above the launch pad. Its zero is the altitude the Worker holds the rocket at
		// on the pad (ObjectManager.padAltitudeM), which a loaded rocket also carries: earlier it was the altitude of the
		// first frame after the rocket was added, so a rocket loaded in flight restarted at 0 (design §4.14-6). A rocket
		// without a pad keeps the altitude of its first frame
		if (target._initialAltM === undefined) {
			const padAltM = ObjectManager.padAltitudeM(target);
			target._initialAltM = padAltM !== null ? padAltM : objData.tmAltM;
		}
		const relativeAltM = Math.max(0, objData.tmAltM - target._initialAltM);

		// Compared as the telemetry panel reads it (design §4.13-25); telemetry.status below keeps the Worker value as is
		const curStatus = normalizeMissionStatus(objData.tmStatus);
		const curStg = objData.tmStageIndex !== undefined ? objData.tmStageIndex : 0;
		const isPayloadSep = Boolean(objData.isPayloadSeparated);
		const isIgnited = Boolean(objData.isIgnited);
		const isFiring = isIgnited && (Number(objData.thrustRatio) > 0);
		const totalStages = objData.tmTotalStages !== undefined ? objData.tmTotalStages : 1;

		// The flight-event flags the voice callouts read (design §4.14-11). The stage events are those of the stages, the
		// payload events those of the payload's own engine, with the prediction's rules (§4.14-1, §4.14-8, §4.14-10).
		// After the payload separation the stage index is totalStages (1 on a single-stage vehicle)
		const isStage1Separated = (curStg >= 1);
		// The rocket keeps the Worker's flag (the save and the restore use it), which a single-stage vehicle also sets at its
		// payload separation (CalcRocket, totalStages <= 2). The second-stage separation is only that of a vehicle with a
		// second stage, as the prediction's 2-STG-SEP (§4.14-10)
		const isStage2SepFlag = objData.isStage2Separated !== undefined ? Boolean(objData.isStage2Separated) : (curStg >= 2 || isPayloadSep);
		target.isStage2Separated = isStage2SepFlag;
		const isStage2Separated = isStage2SepFlag && totalStages >= 2;

		if (!target._mecoDetected) {
			const isFirstStageBurntOut = (curStg === 0 && (curStatus === TELEMETRY.STATUS.MECO || (!isFiring && objData.burnTime <= 0)));
			if (isFirstStageBurntOut || curStg >= 1) {
				target._mecoDetected = true;
			}
		}
		const isMeco = Boolean(target._mecoDetected);
		// The second stage (index 1) fires. A single-stage vehicle's index 1 is its separated payload, whose burn is PES
		const isSes = (curStg === 1 && !isPayloadSep && isFiring);
		// The second stage's burn has ended: its MECO status, or the second stage is gone (a later stage or the payload).
		// A sep_* row of the flight plan (§3.4-1) jettisons it while it burns (its cutoff is the separation, as §4.14-8 (b)),
		// and a flight loaded after it marks it passed (§4.14-6 (c)) instead of calling it at the payload separation
		const isSeco = isPayloadSep || curStg >= 2 || (curStg === 1 && curStatus === TELEMETRY.STATUS.MECO);
		const isPes = (isPayloadSep && isFiring);
		if (isPes) { target._payloadBurnDetected = true; }
		// The payload's own engine stops: only after the separated payload has been seen firing (§4.14-1). A passive
		// payload never fires: its separation (burn time 0, MECO status) is not a cutoff, nor is that of a self-propelled
		// payload never seen firing. The mark is not saved: a loaded flight sets it from its first frame
		const isPeco = Boolean(target._payloadBurnDetected) && isPayloadSep && !isFiring && (curStatus === TELEMETRY.STATUS.MECO || (objData.burnTime !== undefined && objData.burnTime <= 0));

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
			relativeAltM: relativeAltM,
			vV: objData.tmVv,
			vH: objData.tmVh,
			aV: objData.tmAv,
			aH: objData.tmAh,
			currentG: objData.tmCurrentG,
			flightTime: objData.tmFlightTime,
			isAntiStallActive: objData.isAntiStall,
			isQLimitNear: objData.isQLimitNear,
			isGLimitNear: objData.isGLimitNear,
			ambientPresRatio: objData.tmAmbientPresRatio !== undefined ? objData.tmAmbientPresRatio : 0,
			currentIsp: objData.tmCurrentIsp !== undefined ? objData.tmCurrentIsp : 0,
			tankPresFuel: objData.tmTankPresFuel,
			tankPresOxid: objData.tmTankPresOxid,
			stageIndex: curStg,
			totalStages: totalStages,
			isFairingSeparated: !!objData.tmFairingSeparated,
			isPayloadSeparated: isPayloadSep,
			isBoosterBurnout: !!objData.isBoosterBurnout,
			isBoosterSeparated: !!objData.isBoosterSeparated,
			isStage1Separated: isStage1Separated,
			isStage2Separated: isStage2Separated,
			isMeco: isMeco,
			isSes: isSes,
			isSeco: isSeco,
			isPes: isPes,
			isPeco: isPeco,
			mach: Number.isFinite(objData.mach) ? objData.mach : (target.mach || 0),
			rcsCw: Boolean(target.rcsCw),
			rcsCcw: Boolean(target.rcsCcw),
			rcsUllage: Boolean(target.rcsUllage)
		};

		target.currentStageIndex = target.telemetry.stageIndex;
		target.totalStages = target.telemetry.totalStages;
		target.thrustAngle = objData.thrustAngle;
	}

	/**
	 * The altitude of a rocket on its launch pad as the Worker reports it during the hold-down: _updateHoldDownPositions
	 * holds it at host.radius + bottomOffsetM + hostAltM from the host's center, so the altitude above the host is
	 * hostAltM + bottomOffsetM (the first frame on the pad reads it within 1e-9 m). null for a rocket without a pad
	 * (no host, or a pad that is not finite numbers).
	 * @param {any} rocket
	 * @returns {number | null}
	 */
	static padAltitudeM(rocket) {
		if (!rocket || rocket.hostId === null || rocket.hostId === undefined) { return null; }
		const hostAltM = rocket.hostAltM;
		const bottomOffsetM = rocket.bottomOffsetM;
		if (typeof hostAltM !== 'number' || !Number.isFinite(hostAltM) || typeof bottomOffsetM !== 'number' || !Number.isFinite(bottomOffsetM)) {
			return null;
		}
		return hostAltM + bottomOffsetM;
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

	/**
	 * @param {Map<number, any> | null} [runtimeSnapshot] Worker runtime state per rocket id (see Universe.captureRuntimeSnapshot)
	 */
	getState(runtimeSnapshot = null) {
		// The objects in the simulation only: a removed or destroyed one is listed until its trail has faded, and saved
		// it came back on load (design §4.13-31)
		return this.objects.filter(obj => isLiveObject(obj)).map(obj => {
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
				base.flightProfile = obj.flightProfile ? JSON.parse(JSON.stringify(obj.flightProfile)) : [];
				base.massLossRate = obj.massLossRate;
				base.maxGLimit = obj.maxGLimit;
				base.stages = obj.stages ? JSON.parse(JSON.stringify(obj.stages)) : null;
				base.payload = obj.payload ? JSON.parse(JSON.stringify(obj.payload)) : null;
				base.fairing = obj.fairing ? JSON.parse(JSON.stringify(obj.fairing)) : null;
				base.boosters = obj.boosters ? JSON.parse(JSON.stringify(obj.boosters)) : null;
				base.colorTheme = obj.colorTheme || 'orange';
				base.hostId = obj.hostId !== undefined ? obj.hostId : null;
				base.hostAngleRad = obj.hostAngleRad || 0;
				base.hostAltM = obj.hostAltM || 0;
				base.bottomOffsetM = obj.bottomOffsetM;
				base.baseRadiusM = obj.baseRadiusM;
				base.autoControl = obj.autoControl !== undefined ? obj.autoControl : true;
				base.disableStaging = !!obj.disableStaging;
				base.disableOrbitalCutoff = !!obj.disableOrbitalCutoff;
				base.targetApogeeKm = obj.targetApogeeKm || 0;
				base.targetPerigeeKm = obj.targetPerigeeKm || 0;
				base.targetVInfKmS = obj.targetVInfKmS || 0;
				base.isHoldDown = !!obj.isHoldDown;
				base.isIgnited = obj.isIgnited !== undefined ? obj.isIgnited : true;
				base.currentStageIndex = obj.currentStageIndex || 0;
				base.totalStages = obj.totalStages || (obj.stages?.length || 1);
				base.isPayloadSeparated = !!obj.isPayloadSeparated;
				base.isStage2Separated = !!obj.isStage2Separated;
				base.isBoosterBurnout = !!obj.isBoosterBurnout;
				base.isBoosterSeparated = !!obj.isBoosterSeparated;
				base.hasPayloadPropulsion = !!obj.hasPayloadPropulsion;
				base.stageState = obj.stageState || (obj.isHoldDown ? 'PRE_LAUNCH' : 'STG_BURNING');
				base.stgTimer = obj.stgTimer || 0;
				base.mach = obj.mach || 0;
				base.rcsCw = !!obj.rcsCw;
				base.rcsCcw = !!obj.rcsCcw;
				base.rcsUllage = !!obj.rcsUllage;
				base.restoredRuntimeState = true;
				const runtimeState = runtimeSnapshot?.get?.(obj.id);
				base.runtimeState = runtimeState ? JSON.parse(JSON.stringify(runtimeState)) : null;
			} else if (obj.type === OBJECT_TYPES.DEBRIS) {
				base.mass = obj.mass;
				base.debrisSubType = obj.debrisSubType || 0;
				base.colorTheme = obj.colorTheme || null;
				base.baseRadiusM = obj.baseRadiusM;
			} else {
				base.mass = obj.mass;
				base.rotationAngle = obj.rotationAngle || 0;
				base.param = obj.param ? JSON.parse(JSON.stringify(obj.param)) : null;
				base.isWorldCenter = obj.isWorldCenter === true;
				// The world center a profile placed (Galactic Center's Sgr A*): the Deploy buttons and Solar System replace
				// it after a load as before the save (design §4.14-14, §3.5-1)
				base.isProfileWorldCenter = obj.isProfileWorldCenter === true;
			}
			if (obj.type !== OBJECT_TYPES.ROCKET) {
				// Rev 6.11: exact Worker kinematics (and mass / parent rocket) when the snapshot has them
				const runtimeState = runtimeSnapshot?.get?.(obj.id);
				if (runtimeState && typeof runtimeState === 'object') {
					base.runtimeState = JSON.parse(JSON.stringify(runtimeState));
				}
			}
			return base;
		});
	}

	loadState(stateArray) {
		this.destroy();
		let maxId = -1;

		if (Array.isArray(stateArray)) {
			/** Celestial bodies of the file, and whether any of them says if it is the world center */
			const celestials = [];
			let hasCenterFlag = false;
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
					if (o.stages) obj.stages = o.stages;
					if (o.payload !== undefined) obj.payload = o.payload;
					if (o.fairing !== undefined) obj.fairing = o.fairing;
					if (o.boosters !== undefined) obj.boosters = o.boosters;
					if (o.colorTheme !== undefined) obj.colorTheme = o.colorTheme;
					if (o.hostId !== undefined) obj.hostId = o.hostId;
					if (o.hostAngleRad !== undefined) obj.hostAngleRad = o.hostAngleRad;
					if (o.hostAltM !== undefined) obj.hostAltM = o.hostAltM;
					if (o.bottomOffsetM !== undefined) obj.bottomOffsetM = o.bottomOffsetM;
					if (o.baseRadiusM !== undefined) obj.baseRadiusM = o.baseRadiusM;
					if (o.autoControl !== undefined) obj.autoControl = o.autoControl;
					if (o.disableStaging !== undefined) obj.disableStaging = Boolean(o.disableStaging);
					if (o.disableOrbitalCutoff !== undefined) obj.disableOrbitalCutoff = Boolean(o.disableOrbitalCutoff);
					if (o.targetApogeeKm !== undefined) obj.targetApogeeKm = o.targetApogeeKm;
					if (o.targetPerigeeKm !== undefined) obj.targetPerigeeKm = o.targetPerigeeKm;
					if (o.targetVInfKmS !== undefined) obj.targetVInfKmS = o.targetVInfKmS;
					if (o.isHoldDown !== undefined) obj.isHoldDown = Boolean(o.isHoldDown);
					if (o.isIgnited !== undefined) obj.isIgnited = Boolean(o.isIgnited);
					// The stage count and index the Worker restores (design 2026-11-23 §3.1). The count is the Worker's, the stages
					// of the configuration: a rocket without stages (the stress-test swarm) flies one stage (normalizeRocketConfig),
					// as resolveStackState counts it. The saved totalStages is not read: a save made after the first Worker frame
					// holds the same count, but one made before it (rolled out while paused) holds the constructor's 1, and an edited
					// one any value; either put that count on the main thread until the first Worker frame (and into a save then).
					// The count is set whether or not the save has a stage index. The index is normalised
					// as the Worker restore does it: an edited save with a fraction or a negative index loads, and the main thread
					// and the Worker fly the same stage
					const stageCount = (Array.isArray(obj.stages) && obj.stages.length > 0) ? obj.stages.length : 1;
					obj.totalStages = stageCount;
					if (o.currentStageIndex !== undefined) {
						obj.currentStageIndex = RocketStackUtils.normalizeStageIndex(o.currentStageIndex, stageCount, obj.disableStaging);
					}
					if (o.isPayloadSeparated !== undefined) obj.isPayloadSeparated = Boolean(o.isPayloadSeparated);
					if (o.isStage2Separated !== undefined) obj.isStage2Separated = Boolean(o.isStage2Separated);
					if (o.isBoosterBurnout !== undefined) obj.isBoosterBurnout = Boolean(o.isBoosterBurnout);
					if (o.isBoosterSeparated !== undefined) obj.isBoosterSeparated = Boolean(o.isBoosterSeparated);
					if (o.hasPayloadPropulsion !== undefined) obj.hasPayloadPropulsion = Boolean(o.hasPayloadPropulsion);
					if (o.stageState !== undefined) obj.stageState = o.stageState;
					if (o.stgTimer !== undefined) obj.stgTimer = o.stgTimer;
					if (o.mach !== undefined) obj.mach = o.mach;
					if (o.rcsCw !== undefined) obj.rcsCw = Boolean(o.rcsCw);
					if (o.rcsCcw !== undefined) obj.rcsCcw = Boolean(o.rcsCcw);
					if (o.rcsUllage !== undefined) obj.rcsUllage = Boolean(o.rcsUllage);
					obj.restoredRuntimeState = o.restoredRuntimeState === true;
					obj.runtimeState = (o.runtimeState && typeof o.runtimeState === 'object') ? o.runtimeState : null;
					// The main thread's flight clock continues where the Worker's does: the FlightComputer restores its
					// flight time from the same runtime state, with the same validation (design §4.7, §4.14-6)
					const fcState = obj.restoredRuntimeState ? obj.runtimeState?.flightComputer : null;
					if (fcState && typeof fcState === 'object') {
						const savedMet = fcState.flightTime;
						obj.flightTime = Math.min(SIMULATION.RUNTIME_RESTORE_MAX_TIME_S, Math.max(0, Number.isFinite(savedMet) ? savedMet : 0));
					}
				} else if (o.type === OBJECT_TYPES.DEBRIS) {
					obj = new Debris(
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.mass, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
					if (o.debrisSubType !== undefined) obj.debrisSubType = o.debrisSubType;
					if (o.colorTheme !== undefined) obj.colorTheme = o.colorTheme;
					if (o.baseRadiusM !== undefined) obj.baseRadiusM = o.baseRadiusM;
				} else {
					obj = new CelestialBody(
						o.id, o.name, o.x, o.y, o.vx, o.vy, o.mass, o.color, o.size, o.radius,
						o.generation, o.borderColor, o.borderWidth
					);
					if (Number.isFinite(o.rotationAngle)) obj.rotationAngle = o.rotationAngle;
					if (o.param) obj.param = o.param;
					if (typeof o.isWorldCenter === 'boolean') {
						obj.isWorldCenter = o.isWorldCenter;
						hasCenterFlag = true;
					}
					// Only true marks a profile's world center; a file without it (every save before §4.14-14, also of
					// main) has none, so the placements that add to the world keep its center (design §4.14-14, §3.5-1)
					obj.isProfileWorldCenter = o.isProfileWorldCenter === true;
					celestials.push(obj);
				}
				// Celestial bodies / debris: the Worker runtime state goes to the 'add' message only (not kept on obj)
				const runtimeState = (o.type !== OBJECT_TYPES.ROCKET && o.runtimeState && typeof o.runtimeState === 'object') ? o.runtimeState : null;
				this.addObject(obj, true, runtimeState);
				if (o.id > maxId) maxId = o.id;
			});
			// A save written before the world center was saved (no celestial body says true or false): those versions
			// took the body with id 0 for it (the Sun of the first world of the page), so the same body is the center
			// (design §4.13-27). A file that names it keeps exactly the bodies it names.
			if (!hasCenterFlag) {
				const legacyCenter = celestials.find(c => c.id === 0);
				if (legacyCenter) { legacyCenter.isWorldCenter = true; }
			}
			GravSimObject._idCounter = maxId + 1;
		}
	}
}
