
// gravsim_calc.js

import {
	PHYSICS, SIMULATION, ROCHE_LIMIT,
	COLLISION_CONFIG, DEBRIS, OBJECT_TYPES, AERO_DYNAMIC
} from './gravsim_const.js';
import { presetManager } from './gravsim_preset_manager.js';
import { CalcCelestialBody, CalcRocket, CalcDebris } from './gravsim_calc_object.js';
import { QuadTreePool, Rectangle } from './gravsim_calc_quadtree.js';
import { WorkerProfiler } from './gravsim_profiler.js';
import { WorkerBridge } from './gravsim_worker_bridge.js';

/*******************************************************************
 * Physics Engine Class
 *******************************************************************/
export class PhysicsEngine {
	constructor() {
		this.objects = [];
		this.massiveBodies = []; // Cache for objects with significant mass
		this.tinyBodies = []; // Cache for objects with insignificant mass
		this.atmBodies = []; // Cache for objects with atmosphere
		this.celestialParams = null;
		
		// Pre-allocate objects for spatial query to prevent GC spikes
		this.pool = new QuadTreePool();
		this._searchRange = new Rectangle(0, 0, 0, 0);
		this._queryResult = [];
		// Objects loaded from a save whose saved a(t) / aero cache must survive the force evaluations of the following
		// 'add' messages until the first step (save/load path only; always empty otherwise)
		this._restoredPending = [];
	}

	setCelestialParams(params) {
		this.celestialParams = params;
	}

	getCelestialParam(name) {
		if (this.celestialParams && this.celestialParams[name]) {
			return this.celestialParams[name];
		}
		if (typeof presetManager !== 'undefined') {
			return presetManager.getObjectParam(name);
		}
		return null;
	}

	/**
	 * Parameters a per-step reader only reads: the shared table from the Worker's initialisation, else the preset
	 * manager's shared read-only copy (no copy and no name search per step, design 2026-11-23 §3.11-5).
	 * @param {string} name
	 * @returns {any}
	 */
	peekCelestialParam(name) {
		if (this.celestialParams && this.celestialParams[name]) {
			return this.celestialParams[name];
		}
		if (typeof presetManager !== 'undefined') {
			return presetManager.peekObjectParam(name);
		}
		return null;
	}

	addObject(data) {
		let newObj;
		// Restore contract (§4.1): a rocket restores only with restoredRuntimeState === true; other objects when the save
		// carries their runtime state (exact kinematics, Rev 6.11)
		const runtimeState = (data.runtimeState && typeof data.runtimeState === 'object'
			&& (data.type !== OBJECT_TYPES.ROCKET || data.restoredRuntimeState === true)) ? data.runtimeState : null;
		// A restored rocket keeps the parameter name of the original vehicle (it is renamed to the payload at separation)
		const paramName = (data.type === OBJECT_TYPES.ROCKET && runtimeState && typeof runtimeState.paramName === 'string' && runtimeState.paramName)
			? runtimeState.paramName : data.name;
		const param = data.param || this.getCelestialParam(paramName);
		if (data.type === OBJECT_TYPES.ROCKET) {
			newObj = new CalcRocket(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.bottomOffsetM || data.radius || SIMULATION.DEFAULT_OBJECT_RADIUS, data.generation || 0,
				// Restore branch: the saved dry mass as is (a separated passive payload has exactly 0; its mass is payload.massT)
				(data.restoredRuntimeState === true && Number.isFinite(data.mass) && data.mass >= 0) ? data.mass : (data.mass || SIMULATION.DEFAULT_OBJECT_MASS),
				data.fuelMass || 0, data.oxidMass || 0,
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
					bottomOffsetM: data.bottomOffsetM,
					isHoldDown: data.isHoldDown,
					isIgnited: data.isIgnited,
					stages: data.stages,
					payload: data.payload,
					fairing: data.fairing,
					boosters: data.boosters,
					disableStaging: data.disableStaging,
					disableOrbitalCutoff: data.disableOrbitalCutoff,
					colorTheme: data.colorTheme,
					targetApogeeKm: data.targetApogeeKm,
					targetPerigeeKm: data.targetPerigeeKm,
					targetVInfKmS: data.targetVInfKmS,
					currentStageIndex: data.currentStageIndex,
					isPayloadSeparated: data.isPayloadSeparated,
					isStage2Separated: data.isStage2Separated,
					isBoosterBurnout: data.isBoosterBurnout,
					isBoosterSeparated: data.isBoosterSeparated,
					hasPayloadPropulsion: data.hasPayloadPropulsion,
					stageState: data.stageState,
					stgTimer: data.stgTimer,
					restoredRuntimeState: data.restoredRuntimeState,
					runtimeState: data.runtimeState,
					paramName: paramName,
					objParam: param
				}
			);
		} else if (data.type === OBJECT_TYPES.DEBRIS) {
			newObj = new CalcDebris(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || SIMULATION.DEFAULT_OBJECT_RADIUS, data.generation || 0,
				data.mass || SIMULATION.DEFAULT_OBJECT_MASS,
				// Ids start at 0: the parent rocket id 0 is kept (design §4.13-24)
				data.debrisSubType || 0, data.parentRocketId ?? null
			);
		} else {
			newObj = new CalcCelestialBody(
				data.id, data.name,
				data.x, data.y,
				data.vx || 0, data.vy || 0,
				data.ax || 0, data.ay || 0,
				data.radius || SIMULATION.DEFAULT_OBJECT_RADIUS, data.generation || 0,
				data.mass || SIMULATION.DEFAULT_OBJECT_MASS
			);
			newObj.param = param;
			newObj.rotationAngle = Number.isFinite(data.rotationAngle) ? data.rotationAngle : 0;
			newObj.rotationPeriod = data.rotationPeriod ?? param?.ROTATION_PERIOD ?? 0;
		}
		if (runtimeState && newObj.type !== OBJECT_TYPES.ROCKET && typeof newObj.restoreRuntimeState === 'function') {
			newObj.restoreRuntimeState(runtimeState); // the CalcRocket constructor restores its own state
		}
		newObj._half_vx = newObj.vx;
		newObj._half_vy = newObj.vy;
		this.objects.push(newObj);
		this._categorizeBodies();
		this._calculateForces();
		this._reapplyRestoredForces(newObj);
		return newObj;
	}

	/**
	 * Save/load: _calculateForces() evaluates drag (and the aero cache) with the saved v(t + dt), while the saved flight
	 * evaluated them inside its last step with v(t). Objects loaded with their saved a(t) keep it through the force
	 * evaluations of the following 'add' messages, until the first step. An object without saved forces changes the force
	 * field, so the evaluated forces are kept from then on (behaviour before Rev 6.11).
	 */
	_reapplyRestoredForces(newObj) {
		const pending = this._restoredPending || (this._restoredPending = []);
		if (newObj._restoredForces) {
			pending.push(newObj);
		} else if (pending.length !== 0) {
			this._clearRestoredForces();
		}
		for (const obj of pending) { obj.applyRestoredForces(); }
	}

	_clearRestoredForces() {
		for (const obj of this._restoredPending) { obj._restoredForces = null; }
		this._restoredPending.length = 0;
	}

	removeObject(id) {
		this.objects = this.objects.filter(obj => obj.id !== id);
	}

	/**
	 * Remove every object: the main thread replaces the whole world (System › Reset, load). Objects the main thread
	 * never listed go too (debris spawned in a frame that was still on its way), so none of them outlives the world.
	 */
	clearObjects() {
		this.objects = [];
		if (this._restoredPending?.length) { this._clearRestoredForces(); }
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
			if (Number.isFinite(data.rotationAngle)) { obj.rotationAngle = data.rotationAngle; }
			if (data.rotationPeriod !== undefined) { obj.rotationPeriod = data.rotationPeriod; }
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
			const param = obj.param || this.peekCelestialParam(obj.name);
			if (obj.type === OBJECT_TYPES.CELESTIAL && param && param.ATM_LIMIT_ALT) {
				this.atmBodies.push(obj);
			}
		}

		this.sunBody = this.massiveBodies.find(b => b.name === 'Sun') || (this.massiveBodies.length > 0 ? this.massiveBodies[0] : null);
	}

	/**
	 * Spin rate of a body (rad/s). Single source for the rotation-angle integration and the hold-down sync, so a held
	 * rocket always stays on the rotating surface: period from param, then rotationPeriod, then the preset; only a
	 * finite period with |P| > 1e-6 s rotates.
	 */
	_getRotationOmega(body) {
		const rotPeriod = body.param?.ROTATION_PERIOD ?? body.rotationPeriod ?? this.peekCelestialParam(body.name)?.ROTATION_PERIOD ?? 0;
		return (Number.isFinite(rotPeriod) && Math.abs(rotPeriod) > 1e-6) ? (2 * Math.PI) / rotPeriod : 0;
	}

	/**
	 * The host a rocket in hold-down is pinned to (by _updateHoldDownPositions), or null. A held rocket is not integrated
	 * while it is pinned (design §3.1.1-2); one whose host is gone (removed, or destroyed and cleaned up) has no pad, so
	 * it is a free body again and is integrated as every other object (as on main). Earlier every held rocket was
	 * skipped, so a rocket on the pad of a removed host stood still in space (design §4.14-7).
	 * @param {any} obj
	 * @returns {any | null}
	 */
	_getHoldDownHost(obj) {
		if (obj.type !== OBJECT_TYPES.ROCKET || !obj.isHoldDown || obj.hostId === null) { return null; }
		return this.objects.find(o => o.id === obj.hostId) || null;
	}

	_updateHoldDownPositions(dt) {
		for (const obj of this.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isHoldDown && obj.hostId !== null) {
				const host = this._getHoldDownHost(obj);
				if (host) {
					const omega = this._getRotationOmega(host); // rad/s

					obj.hostAngleRad += omega * dt;

					const bottomOffset = obj.bottomOffsetM !== undefined ? obj.bottomOffsetM : obj.radius;
					const r = host.radius + bottomOffset + obj.hostAltM; // m
					const dx = r * Math.cos(obj.hostAngleRad); // m
					const dy = r * Math.sin(obj.hostAngleRad); // m

					obj.x = host.x + dx;
					obj.y = host.y + dy;
					obj.vx = host.vx - omega * dy;
					obj.vy = host.vy + omega * dx;
					obj.ax = host.ax;
					obj.ay = host.ay;
					obj.thrustAngle = obj.hostAngleRad;
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
		this.qtree = this.pool.getTree(boundary, COLLISION_CONFIG.QUADTREE_MAX_OBJECTS);

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			this.qtree.insert(obj);
		}
	}

	/**
	 * True when `rocket` is held on the pad of `host` (the same condition under which _updateHoldDownPositions pins it).
	 * The per-frame collision check extrapolates each object over the whole frame with its last a(t). A held rocket's
	 * a(t) is its host's only after its first hold-down step; after an addObject() force evaluation (placement, a load
	 * without the Worker runtime state, or any later 'add') it is gravity toward the host, which a long frame
	 * extrapolates into the host's surface. Resting on the pad is therefore never a collision with that host.
	 */
	_isHeldOnHost(rocket, host) {
		return rocket.type === OBJECT_TYPES.ROCKET && Boolean(rocket.isHoldDown) && rocket.hostId !== null && rocket.hostId === host.id;
	}

	_checkCollisions(dt) {
		if (!this.qtree) { return; }

		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			// Define search range based on maximum possible movement and size
			const max_v = Math.max(Math.abs(obj.vx), Math.abs(obj.vy)) * dt; // m
			const isMassive = obj.mass >= SIMULATION.MIN_GRAVITY_CALC_MASS;
			const searchRadius = obj.radius + max_v + (isMassive ? COLLISION_CONFIG.MASSIVE_SEARCH_MARGIN_M : 0); // m

			// Zero-allocation query preparation
			this._searchRange.x = obj.x;
			this._searchRange.y = obj.y;
			this._searchRange.w = searchRadius * 2;
			this._searchRange.h = searchRadius * 2;
			this._queryResult.length = 0;

			const candidates = this.qtree.query(this._searchRange, this._queryResult);

			for (const other of candidates) {
				if (other.collided || other.shattered || obj.id === other.id) {
					continue;
				}

				const otherIsMassive = other.mass >= SIMULATION.MIN_GRAVITY_CALC_MASS;

				// Duplicate check elimination:
				// Between same categories (Massive-Massive or Tiny-Tiny), use ID comparison.
				// Between Massive and Tiny, always perform check on Massive side where query reliably encloses Tiny.
				if (isMassive === otherIsMassive) {
					if (obj.id >= other.id) {
						continue;
					}
				} else if (!isMassive && otherIsMassive) {
					continue;
				}

				// Disable collision between rocket and its newly jettisoned stages / fairings (and between the pieces of
				// one rocket). A parent rocket id is null (or undefined) for none; 0 is a rocket (design §4.13-24)
				if ((obj.type === OBJECT_TYPES.ROCKET && other.parentRocketId === obj.id) ||
				    (other.type === OBJECT_TYPES.ROCKET && obj.parentRocketId === other.id) ||
				    (obj.parentRocketId !== null && obj.parentRocketId !== undefined && obj.parentRocketId === other.parentRocketId)) {
					continue;
				}

				// A held rocket rests on its host's pad: the hold-down sets its pose every step, so it never collides with
				// that host (other bodies can still hit it)
				if (this._isHeldOnHost(obj, other) || this._isHeldOnHost(other, obj)) {
					continue;
				}

				if (!obj.isColliding(other, dt)) {
					continue;
				}

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
						debrisRatio = massRatio * (energyRatio * COLLISION_CONFIG.DEBRIS_ENERGY_FACTOR);
						debrisRatio = Math.max(0.0, Math.min(debrisRatio, COLLISION_CONFIG.MAX_DEBRIS_RATIO));

						// Ignore tiny debris
						if (debrisRatio < COLLISION_CONFIG.MIN_DEBRIS_RATIO) {
							debrisRatio = 0;
						}
					}

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

	_checkRocheLimit() {
		if (!this.qtree) { return; }

		for (const massiveObj of this.objects) {
			if (massiveObj.collided || massiveObj.shattered) { continue; }
			if (massiveObj.mass < ROCHE_LIMIT.MIN_MASS_TO_DESTROY) { continue; }

			// Calculate maximum Roche limit radius for spatial query
			const massiveDensity = massiveObj.mass / Math.pow(massiveObj.radius, 3); // t/m^3

			// Assume worst-case fragile density to define the search bounds
			const minFragileDensity = ROCHE_LIMIT.MIN_FRAGILE_DENSITY; // t/m^3
			const maxRocheLimitM = ROCHE_LIMIT.COEFFICIENT * massiveObj.radius * Math.cbrt(massiveDensity / minFragileDensity); // m

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
		const refParam = refBody.param || this.peekCelestialParam(refBody.name);
		const altM = distM - refBody.radius; // m

		if (altM > refParam.ATM_LIMIT_ALT) {
			obj.clearAerodynamicParameters();
			return;
		}

		obj.applyAerodynamics(refBody, refParam, altM);
	}

	/**
	 * Worker-only runtime state of every live object, keyed by id (answer to 'snapshotRuntime'; the reply keeps the field
	 * name `rockets`). Rockets: CalcRocket.getRuntimeState(). Since Rev 6.11 also celestial bodies and debris: exact
	 * kinematics in metres, the Worker mass of celestial bodies and the parent rocket of debris.
	 * @returns {{ id: number, runtimeState: any }[]}
	 */
	getRocketRuntimeSnapshot() {
		const rockets = [];
		for (const obj of this.objects) {
			if (!obj.collided && !obj.shattered && typeof obj.getRuntimeState === 'function') {
				rockets.push({ id: obj.id, runtimeState: obj.getRuntimeState() });
			}
		}
		return rockets;
	}

	_moveObjects(dt) {
		// Saved forces of a load are a(t) of this first step only
		if (this._restoredPending?.length) { this._clearRestoredForces(); }

		// Update position and half velocity using previous a(t) (including celestial rotationAngle)
		this._updatePositionAndHalfVelocity(dt);

		// Keep held-down rockets synchronized immediately after celestial rotation & position advance
		this._updateHoldDownPositions(dt);

		// Flight control for rockets (updates mass, state, etc. at new position)
		this._updateFlightControl(dt);

		// New forces a(t+dt)
		this._calculateForces();

		// Integrate Step 2: Final velocity
		this._updateFinalVelocity(dt);

		// Re-sync held-down rocket velocities/positions with updated host velocity at t + dt
		this._updateHoldDownPositions(0);
	}

	_updatePositionAndHalfVelocity(dt) {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			if (obj.type === OBJECT_TYPES.CELESTIAL) {
				const omega = this._getRotationOmega(obj);
				if (omega !== 0) {
					obj.rotationAngle = (obj.rotationAngle || 0) + omega * dt;
				}
			}

			// A rocket pinned to its pad moves only with it (_updateHoldDownPositions)
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isHoldDown && this._getHoldDownHost(obj)) {
				continue;
			}

			const half_vx = obj.vx + obj.ax * dt / 2; // m/s
			const half_vy = obj.vy + obj.ay * dt / 2; // m/s
			
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;
			
			// Store half_v temporarily
			obj._half_vx = half_vx;
			obj._half_vy = half_vy;
		}
	}

	_updateFlightControl(dt) {
		const newDebris = [];
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }

			if (obj.type === OBJECT_TYPES.ROCKET) {
				obj.flightControl(dt, obj.dominantBody, obj.distToDominantM, this.sunBody);
				if (obj._pendingDebris && obj._pendingDebris.length > 0) {
					while (obj._pendingDebris.length > 0) {
						newDebris.push(obj._pendingDebris.shift());
					}
				}
			}
		}

		if (newDebris.length > 0) {
			for (const deb of newDebris) {
				const nextId = -Math.floor(Math.random() * DEBRIS.ID_RANDOM_RANGE) - 1;
				this.addObject({
					id: deb.id ?? nextId,
					name: deb.name,
					type: OBJECT_TYPES.DEBRIS,
					debrisSubType: deb.debrisSubType || 0,
					parentRocketId: deb.parentRocketId ?? null,
					x: deb.x,
					y: deb.y,
					vx: deb.vx,
					vy: deb.vy,
					radius: deb.radius || SIMULATION.DEFAULT_OBJECT_RADIUS,
					mass: deb.mass,
					generation: 1
				});
			}
		}
	}

	_updateFinalVelocity(dt) {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			// Held rockets are pinned to the pad: their velocity comes only from _updateHoldDownPositions (a held rocket
			// without a host is a free body, _getHoldDownHost)
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isHoldDown && this._getHoldDownHost(obj)) { continue; }

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
		this._resetForces();
		this._calculateMassiveToMassiveGravity();
		this._calculateMassiveToTinyGravity();
		this._applyAerodynamics();
		this._applyTinyThrust();
	}

	// Reset accelerations and metrics
	_resetForces() {
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
	}

	// Massive vs Massive Gravity
	_calculateMassiveToMassiveGravity() {
		const massiveLen = this.massiveBodies.length;
		for (let i = 0; i < massiveLen; i++) {
			const objA = this.massiveBodies[i];
			const paramA = objA.param || this.peekCelestialParam(objA.name);
			const hasAtmA = paramA && paramA.ATM_LIMIT_ALT;

			for (let j = i + 1; j < massiveLen; j++) {
				const objB = this.massiveBodies[j];

				const dx = objB.x - objA.x; // m
				const dy = objB.y - objA.y; // m
				const radiusSum = objA.radius + objB.radius; // m
				const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum); // m^2
				const dist = Math.sqrt(distSq); // m

				// accelPerDist = G / (dist^3)
				const accelPerDist = PHYSICS.G / (distSq * dist); // m/s^2 / (t*m)

				// aA = (G * mB) / dist^2 = accelPerDist * objB.mass * dx
				objA.ax += accelPerDist * objB.mass * dx;
				objA.ay += accelPerDist * objB.mass * dy;

				objB.ax -= accelPerDist * objA.mass * dx;
				objB.ay -= accelPerDist * objA.mass * dy;

				// Keep the largest gravity object and search atmosphere
				if (objB.type === OBJECT_TYPES.CELESTIAL) {
					const gForceA = objB.mass / distSq; // t/m^2
					if (gForceA > objA.maxGForce) {
						objA.maxGForce = gForceA;
						objA.dominantBody = objB;
						objA.distToDominantM = dist;
					}
					const paramB = objB.param || this.peekCelestialParam(objB.name);
					if (paramB && paramB.ATM_LIMIT_ALT && distSq < objA._minAtmDistSq) {
						objA._minAtmDistSq = distSq;
						objA._nearestAtmBody = objB;
					}
				}
				if (objA.type === OBJECT_TYPES.CELESTIAL) {
					const gForceB = objA.mass / distSq; // t/m^2
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
	}

	// Massive vs Tiny Gravity
	_calculateMassiveToTinyGravity() {
		for (const objA of this.massiveBodies) {
			const hasAtmA = (objA.param || this.peekCelestialParam(objA.name))?.ATM_LIMIT_ALT;

			for (const objB of this.tinyBodies) {
				const dx = objB.x - objA.x; // m
				const dy = objB.y - objA.y; // m
				const radiusSum = objA.radius + objB.radius; // m
				const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum); // m^2
				const dist = Math.sqrt(distSq); // m

				const accelPerDist = PHYSICS.G / (distSq * dist); // m/s^2 / (t*m)

				objA.ax += accelPerDist * objB.mass * dx;
				objA.ay += accelPerDist * objB.mass * dy;

				objB.ax -= accelPerDist * objA.mass * dx;
				objB.ay -= accelPerDist * objA.mass * dy;

				if (objA.type === OBJECT_TYPES.CELESTIAL) {
					const gForceB = objA.mass / distSq; // t/m^2
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
	}

	// Apply Thrust for Tiny
	_applyTinyThrust() {
		for (const obj of this.tinyBodies) {
			obj.applyThrust();
		}
	}

	// Apply aerodynamics after all distances are checked
	_applyAerodynamics() {
		for (const obj of this.objects) {
			if (obj.collided || obj.shattered) { continue; }
			this._applyAerodynamicsFromCache(obj);
		}
	}

	determineOptimalSubSteps(totalDt, timeScale) {
		const cfg = SIMULATION.SUB_STEPS;

		let minAllowedDt = Infinity; // s

		// 1. Check Massive vs Massive
		const massiveLen = this.massiveBodies.length;
		for (let i = 0; i < massiveLen; i++) {
			const objA = this.massiveBodies[i];

			for (let j = i + 1; j < massiveLen; j++) {
				const objB = this.massiveBodies[j];

				const dx = objB.x - objA.x; // m
				const dy = objB.y - objA.y; // m
				const distSq = dx * dx + dy * dy; // m^2
				const dist = Math.sqrt(distSq); // m

				const dvx = objB.vx - objA.vx; // m/s
				const dvy = objB.vy - objA.vy; // m/s
				const vRel = Math.sqrt(dvx * dvx + dvy * dvy); // m/s

				const combinedMass = objA.mass + objB.mass; // t
				const radiusSum = objA.radius + objB.radius; // m
				const surfDist = Math.max(dist - radiusSum, cfg.MIN_SURFACE_DIST); // m

				// Dynamical time scale from gravity: dt <= eta * sqrt(r^3 / (G * M))
				const dynScale = Math.sqrt((distSq * dist) / (PHYSICS.G * combinedMass));
				const dtDyn = cfg.ETA_GRAV * dynScale;

				// Surface approach time: dt <= eta * surfDist / vRel
				const dtSurf = cfg.ETA_SURF * (surfDist / (vRel + cfg.VELOCITY_EPSILON));

				if (dtDyn < minAllowedDt) minAllowedDt = dtDyn;
				if (dtSurf < minAllowedDt) minAllowedDt = dtSurf;
			}
		}

		// 2. Check Tiny Bodies (Rockets, Debris) & External Forces
		const tinyLen = this.tinyBodies.length;
		for (let i = 0; i < tinyLen; i++) {
			const obj = this.tinyBodies[i];
			if (obj.collided || obj.shattered) { continue; }

			const v = obj.getV();
			const a = Math.sqrt(obj.ax * obj.ax + obj.ay * obj.ay);

			// Dominant body proximity and orbital dynamics
			if (obj.dominantBody && obj.distToDominantM > 0) {
				const dom = obj.dominantBody;
				const surfDist = Math.max(obj.distToDominantM - dom.radius - obj.radius, cfg.MIN_SURFACE_DIST);
				const dvx = obj.vx - dom.vx;
				const dvy = obj.vy - dom.vy;
				const vRel = Math.sqrt(dvx * dvx + dvy * dvy);

				const dtSurf = cfg.ETA_SURF * (surfDist / (vRel + cfg.VELOCITY_EPSILON));
				if (dtSurf < minAllowedDt) minAllowedDt = dtSurf;

				const aGrav = (PHYSICS.G * dom.mass) / Math.max(obj.distToDominantM * obj.distToDominantM, dom.radius * dom.radius);
				if (aGrav > cfg.MIN_GRAV_ACCEL) {
					const dtDyn = cfg.ETA_GRAV * Math.sqrt(obj.distToDominantM / aGrav);
					if (dtDyn < minAllowedDt) minAllowedDt = dtDyn;
				}
			}

			// Acceleration limit (thrust / atmospheric drag)
			if (a > cfg.MIN_TINY_ACCEL) {
				const dtAcc = cfg.ETA_ACC * ((v + cfg.ACCEL_VEL_OFFSET) / a);
				if (dtAcc < minAllowedDt) minAllowedDt = dtAcc;
			}

			// Atmosphere entry scale height limit
			if (obj.inAtmosphere && obj._nearestAtmBody) {
				const refParam = obj._nearestAtmBody.param || this.peekCelestialParam(obj._nearestAtmBody.name);
				if (refParam) {
					const H = refParam.ATM_SCALE_HEIGHT || AERO_DYNAMIC.DEFAULT_SCALE_HEIGHT;
					const dtAtm = cfg.ETA_ATM * (H / (v + cfg.ATM_VEL_OFFSET));
					if (dtAtm < minAllowedDt) { minAllowedDt = dtAtm; }
				}
			}

			// Rocket powered flight safeguard
			if (obj.type === OBJECT_TYPES.ROCKET && obj.isIgnited && !obj.isHoldDown) {
				const dtRocket = cfg.ROCKET_POWERED_MAX_DT; // Ensure sub-second resolution for guidance & mass consumption
				if (dtRocket < minAllowedDt) minAllowedDt = dtRocket;
			}
		}

		// Calculate required steps based on the most restrictive constraint
		let steps = Math.ceil(totalDt / minAllowedDt);

		// Baseline minimum steps scaled by timeScale
		const scaledBase = Math.max(cfg.MIN, Math.ceil(cfg.BASE * Math.min(timeScale, cfg.TIME_SCALE_BASE_CAP)));
		steps = Math.max(steps, scaledBase);

		// Performance safeguard: dynamically scale maximum steps based on total body count
		// to maintain high FPS and avoid CPU freezing under massive debris / stress conditions
		const totalBodies = massiveLen + tinyLen;
		let effectiveMax = cfg.MAX;
		if (totalBodies > cfg.BODY_COUNT_THRESHOLD) {
			effectiveMax = Math.max(cfg.MIN * cfg.BODY_COUNT_MIN_MULT, Math.floor(cfg.MAX * (cfg.BODY_COUNT_THRESHOLD / totalBodies)));
		}

		// Clamp to maximum allowed sub-steps
		steps = Math.min(steps, effectiveMax);

		return steps;
	}
}

/*******************************************************************
 * Simulation Controller
 *******************************************************************/
export class SimulationController {
	constructor() {
		this.engine = new PhysicsEngine();
		this.lastTime = Date.now(); // ms
		this.timeScale = 1;
		this.isPaused = false;
		this.profiler = new WorkerProfiler();
		this.currentSubSteps = SIMULATION.SUB_STEPS?.BASE || 40;
		this.timer = null;
		// Sequence number of the last 'remove' / 'clear' handled. Every frame carries it, so the main thread knows which of
		// its removals the frame already reflects and drops the data a frame on its way still has of a removed object or
		// of the world before a Reset / load (ObjectManager, design §4.13-31)
		this.syncSeq = 0;

		if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
			self.onmessage = this.handleMessage.bind(this);
			this.timer = setInterval(() => this.update(), 1000 / SIMULATION.CALC_INTERVAL);
		}
	}

	destroy() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	handleMessage(e) {
		const data = e.data;
		switch (data.cmd) {
			case 'initDefinitions':
				if (data.celestialParams) {
					this.engine.setCelestialParams(data.celestialParams);
				}
				break;
			case 'add':
				this.engine.addObject(data);
				break;
			case 'remove':
				this.engine.removeObject(data.id);
				this._acknowledge(data.seq);
				break;
			case 'clear':
				this.engine.clearObjects();
				this._acknowledge(data.seq);
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
				this.lastTime = Date.now();
				break;
			case 'toggleProfiler':
				this.profiler.enabled = data.value;
				if (!data.value) {
					this.profiler.frames = 0;
					this.profiler.totalSubSteps = 0;
					for (const key in this.profiler.metrics) {
						this.profiler.metrics[key] = 0;
					}
				}
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
			case 'snapshotRuntime':
				self.postMessage({
					cmd: 'runtimeSnapshot',
					requestId: data.requestId,
					rockets: this.engine.getRocketRuntimeSnapshot()
				});
				break;
		}
	}

	/** @param {any} seq the sequence number of a 'remove' / 'clear' message (a message without one leaves it) */
	_acknowledge(seq) {
		if (Number.isFinite(seq) && seq > this.syncSeq) { this.syncSeq = seq; }
	}

	update() {
		if (this.isPaused) {
			this.lastTime = Date.now();
			return;
		}

		const now = Date.now();
		const elapsed = Math.min(now - this.lastTime, SIMULATION.MAX_FRAME_ELAPSED_MS);

		// Avoidance of div 0
		if (elapsed <= 0) { return; }

		const totalDt = elapsed * PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE * this.timeScale; // s
		this.lastTime = now;

		const tUpdate = this.profiler.start();

		// Refresh body categorizations before determining sub-steps & running steps
		this.engine._categorizeBodies();

		// Calculate adaptive sub-steps based on physical constraints
		const cfg = SIMULATION.SUB_STEPS;
		const targetSubSteps = this.engine.determineOptimalSubSteps(totalDt, this.timeScale);

		// Smooth sub-step decrease to prevent frame jitter (Attack-instant, Decay-smoothed)
		const decay = cfg?.SMOOTHING_DECAY ?? 0.90;
		let SUB_STEPS = Math.max(targetSubSteps, Math.floor(this.currentSubSteps * decay));
		SUB_STEPS = Math.max(cfg?.MIN ?? 20, Math.min(SUB_STEPS, cfg?.MAX ?? 1200));
		this.currentSubSteps = SUB_STEPS;

		const dt = totalDt / SUB_STEPS; // s
		this.profiler.recordSubSteps(SUB_STEPS);

		// Optimization: Rebuild QuadTree and check collisions only ONCE per frame 
		// using the total elapsed time, instead of running it every sub-step.
		const tQC = this.profiler.start();
		this.engine._buildQuadTree(totalDt);
		this.engine._checkCollisions(totalDt);
		this.engine._checkRocheLimit();
		this.profiler.end('QuadTreeAndCollisions', tQC);

		// Fast Integration Loop
		const tInt = this.profiler.start();
		for (let i = 0; i < SUB_STEPS; i++) {
			this.engine._moveObjects(dt);
		}
		this.engine._updateEscapeStatus();
		this.profiler.end('Integration', tInt);

		// Return result to main thread (Includes newly shattered objects before removal)
		const tBuf = this.profiler.start();
		const buffer = WorkerBridge.formatWorkerToMain(this.engine.objects);
		this.profiler.end('BufferFormat', tBuf);

		const tPost = this.profiler.start();
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			subSteps: SUB_STEPS,
			objectsData: buffer.buffer,
			validLength: buffer.length,
			syncSeq: this.syncSeq
		}, [buffer.buffer]);
		this.profiler.end('PostMessage', tPost);

		this.engine.removeDeadObjects();

		this.profiler.end('TotalUpdate', tUpdate);
		this.profiler.report();
	}
}

/** URL without its fragment, or null when it is not an absolute URL. */
const scriptUrlKey = (url) => {
	if (typeof url !== 'string') { return null; }
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.href;
	} catch (_err) {
		return null;
	}
};

/**
 * True only when this module is the entry script of the dedicated Worker evaluating it: the physics Worker, which
 * Universe creates with this file (`./scripts/gravsim_calc.js?v=...`). The trajectory predictor Worker imports this
 * module for PhysicsEngine, and its script URL is gravsim_calc_predictor.js, so it starts no simulation loop. The main
 * thread (self.document present) and Node (no worker scope) never start one either.
 * @param {any} [scope] worker global scope (default: self)
 * @param {string} [moduleUrl] URL of this module instance (default: import.meta.url)
 * @returns {boolean}
 */
export function isPhysicsWorkerEntry(scope = (typeof self !== 'undefined' ? self : undefined), moduleUrl = import.meta.url) {
	if (!scope || typeof scope.postMessage !== 'function' || scope.document !== undefined) { return false; }
	const scopeKey = scriptUrlKey(scope.location?.href);
	return scopeKey !== null && scopeKey === scriptUrlKey(moduleUrl);
}

// Instantiate only as the entry script of the physics Worker
if (isPhysicsWorkerEntry()) {
	new SimulationController();
}
