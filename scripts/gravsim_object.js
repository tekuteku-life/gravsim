
// gravsim_object.js

import {
	PHYSICS, RENDER, OBJECT_STATE, ROCKET_VISUAL,
	DEFAULT_OBJECT_PARAMS, OBJECT_TYPES, TRAIL_MODE, MULTISTAGE_ROCKET,
} from './gravsim_const.js';
import { Trajectory } from './gravsim_trajectory.js';
import { EffectTrail } from './gravsim_effect_trail.js';
import { UnitConvertUtils } from './gravsim_utils.js';
import { RocketRenderer } from './gravsim_rocket_renderer.js';
import { TrajectoryPredictor } from './gravsim_trajectory_predictor.js';

/*******************************************************************
 * GravSimObject class which is base class
 *******************************************************************/
export class GravSimObject {
	constructor(id, name, type, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth) {
		this.id = id;
		this.name = name;
		this.type = type;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = 0;
		this.ay = 0;
		this.color = color;
		this.size = size;
		this.radius = radius; // m
		this.generation = generation || 0;
		this.isDebris = this.generation > 0;
		this.borderColor = borderColor || null;
		this.borderWidth = borderWidth || 0;
		this.state = OBJECT_STATE.ACTIVE;
		this.isEscaping = false;
		this.inAtmosphere = false;

		const rendering_config = {
			color: color,
			baseSize: size
		};
		this.trajectory = new Trajectory(id, rendering_config);
		this.effectTrail = new EffectTrail(id, rendering_config);
	}

	get mass() { return 1; }

	isCenterObject(renderContext) {
		return renderContext && renderContext.centerObjectId === this.id;
	}

	updateHistory(currentFrame, objects) {
		let mode = TRAIL_MODE.NORMAL;
		if (this.inAtmosphere) {
			mode = TRAIL_MODE.ATMOSPHERE;
		} else if (this.isEscaping) {
			mode = TRAIL_MODE.ESCAPE;
		}
		this.trajectory.addPoint(this.x, this.y, currentFrame, mode);

		let refId = -1;
		let refX = 0;
		let refY = 0;
		let refAngle = 0;

		// Find the dominant body to record the effect position as a relative coordinate
		if (this.dominantBodyId !== undefined && this.dominantBodyId !== -1 && objects) {
			const refBody = objects.find(o => o.id === this.dominantBodyId);
			if (refBody) {
				refId = refBody.id;
				refX = refBody.x;
				refY = refBody.y;
				refAngle = refBody.rotationAngle || 0;
			}
		}

		let relX = this.x - refX;
		let relY = this.y - refY;

		// Rotate back to the reference body's local coordinate system (Atmosphere follows rotation)
		if (mode === TRAIL_MODE.ATMOSPHERE && refAngle !== 0) {
			const cosA = Math.cos(-refAngle);
			const sinA = Math.sin(-refAngle);
			const localX = relX * cosA - relY * sinA;
			const localY = relX * sinA + relY * cosA;
			relX = localX;
			relY = localY;
		}

		this.effectTrail.addPoint(refId, relX, relY, currentFrame, mode);
	}

	clearHistory() {
		if (this.trajectory) {
			this.trajectory.clear();
		}
		if (this.effectTrail) {
			this.effectTrail.clear();
		}
	}

	finished() {
		if (this.state === OBJECT_STATE.REMOVED) {
			this.trajectory.shrink(2);
			this.effectTrail.shrink(2);
			return this.trajectory.count <= 0 && this.effectTrail.count <= 0;
		}
		return false;
	}

	setCollided() {
		this.state = OBJECT_STATE.REMOVED;
	}

	setPosition(x, y) {
		this.x = x;
		this.y = y;
	}

	setVelocity(vx, vy) {
		this.vx = vx;
		this.vy = vy;
	}

	resetGravity() {
		this.ax = 0;
		this.ay = 0;
	}

	getRelativeX(basis) { return basis ? this.x - basis.x : this.x; }
	getRelativeY(basis) { return basis ? this.y - basis.y : this.y; }

	draw(renderContext) {
		if (!renderContext) { return; }
		if (!renderContext.basis) { return; }

		// Draw main body and effects (Screen-space calculation)
		if (this.state === OBJECT_STATE.ACTIVE) {
			const basis = renderContext.basis;
			const ctx = renderContext.ctx;
			const zoomScale = renderContext.zoomScale;

			const relX = this.getRelativeX(basis) * zoomScale;
			const relY = this.getRelativeY(basis) * zoomScale;

			const screenRadius = this._getDrawRadius(zoomScale);
			renderContext.bodyScreenRadius = screenRadius

			this._drawBody(ctx, relX, relY, screenRadius);
			this._drawEffects(ctx, relX, relY, screenRadius, zoomScale);
		}

		// Draw trajectory even if state == dead
		this.trajectory.draw(renderContext);
		this.effectTrail.draw(renderContext);
	}

	// Calculate switching between fixed size and real physical size
	_getDrawRadius(zoomScale) {
		const realRadiusPx = (this.radius / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
		const screenRadiusPx = realRadiusPx * zoomScale;

		// this.size acts as the minimum visual radius on the screen
		return screenRadiusPx < this.size ? this.size : screenRadiusPx;
	}

	_drawBody(ctx, x, y, screenRadius) {
		ctx.fillStyle = this.color;
		ctx.beginPath();
		ctx.arc(x, y, screenRadius, 0, Math.PI * 2);
		ctx.fill();

		// Stroke border (if configured)
		if (this.borderColor && this.borderWidth > 0) {
			const screenLineWidthPx = Math.max(1, this.size * this.borderWidth);
			ctx.lineWidth = screenLineWidthPx;

			const innerRadius = Math.max(1e-5, screenRadius - (ctx.lineWidth / 2));

			ctx.strokeStyle = this.borderColor;
			ctx.beginPath();
			ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
			ctx.stroke();

			ctx.lineWidth = 1;
		}
	}
	
	_drawEffects(ctx, x, y, screenRadius, zoomScale) {}
}

GravSimObject._idCounter = 0;

/*******************************************************************
 * CelestialBody class
 *******************************************************************/
export class CelestialBody extends GravSimObject {
	constructor(id, name, x, y, vx, vy, mass, color, size, radius, generation, borderColor, borderWidth) {
		super(id, name, OBJECT_TYPES.CELESTIAL, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth);
		this._mass = mass; // t
		this.rotationAngle = 0; // rad
	}
	get mass() { return this._mass; }
	set mass(val) { this._mass = val; }

	_drawEffects(ctx, x, y, screenRadius, zoomScale) {
		const param = DEFAULT_OBJECT_PARAMS[this.name];
		
		if (param && param.ATM_COLOR && param.ATM_LIMIT_ALT) {
			const atmThicknessPx = (param.ATM_LIMIT_ALT / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
			const screenThicknessPx = atmThicknessPx * zoomScale;

			if (screenThicknessPx >= 1) {
				const outerScreenRadius = screenRadius + screenThicknessPx;

				ctx.save();
				
				const gradient = ctx.createRadialGradient(x, y, screenRadius, x, y, outerScreenRadius);
				gradient.addColorStop(0, param.ATM_COLOR);
				gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

				ctx.fillStyle = gradient;
				ctx.beginPath();
				ctx.arc(x, y, outerScreenRadius, 0, Math.PI * 2);
				ctx.fill();
				
				ctx.restore();
			}
		}
	}
}

/*******************************************************************
 * Rocket class
 *******************************************************************/
export class Rocket extends GravSimObject {
	constructor(id, name, x, y, vx, vy, dryMass, fuelMass, oxidMass, color, size, radius, generation, borderColor, borderWidth, colorTheme = 'orange') {
		super(id, name, OBJECT_TYPES.ROCKET, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth);
		this.dryMass = dryMass; // t
		this.fuelMass = fuelMass; // t
		this.oxidMass = oxidMass; // t
		this.ofRatio = 0;
		this.thrustForce = 0; // N
		this.burnTime = 0;
		this.thrustAngle = 0;
		this.flightProfile = [];
		this.massLossRate = 0; // t/s
		this.maxGLimit = 0;
		this.thrustRatio = 0;
		this.flightTime = 0;
		this.autoControl = true;
		this.colorTheme = colorTheme || 'orange';

		// Launch Sequencer States
		this.hostId = null;
		this.hostAngleRad = 0;
		this.hostAltM = 0;
		this.bottomOffsetM = 0;
		this.baseRadiusM = 0;
		this.isHoldDown = false;
		this.isIgnited = true;
		this.isInternalPower = false;
		this.disableStaging = false;

		this.telemetry = {
			status: 0,
			qAxialKpa: 0, qLateralKpa: 0, structRatio: 0,
			aoaDeg: 0, progradeAngle: 0, gravityAngle: 0,
			remDv: 0, // m/s
			twr: 0, altM: 0,
			vV: 0, vH: 0, // m/s
			aV: 0, aH: 0, // m/s^2
			currentG: 0,
			flightTime: 0, // s
		};

		this.currentStageIndex = 0;
		this.totalStages = 1;
		this.stages = [];
		this.payload = null;
		this.fairing = null;
		this.boosters = null;
		this.isBoosterBurnout = false;
		this.isBoosterSeparated = false;
		this.rendering = null;

		this.predictedTrajectory = null;
		this.passedEventIds = new Set();
		this.isDestroyed = false;
		this.destroyedFlightTime = null;
		this.actualFlightPath = [];
	}

	get mass() {
		if (this.stages && this.stages.length > 0) {
			let total = (this.payload?.massT || 0);
			if (this.fairing?.enabled && !this.telemetry?.isFairingSeparated) {
				total += (this.fairing.massT || 0);
			}
			total += (this.dryMass + this.fuelMass + this.oxidMass);
			for (let i = this.currentStageIndex + 1; i < this.stages.length; i++) {
				const stg = this.stages[i];
				total += (stg.dryMassT + stg.fuelMassT + stg.oxidMassT);
			}
			return total;
		}
		return this.dryMass + this.fuelMass + this.oxidMass;
	}

	set mass(val) {}

	/**
	 * Override _getDrawRadius for Rocket to prevent pixel collapsing
	 * and maintain balanced visual scale across all zoom levels.
	 */
	_getDrawRadius(zoomScale) {
		const baseRadiusM = this.baseRadiusM || DEFAULT_OBJECT_PARAMS['Rocket']?.RADIUS || 63;
		const realRadiusPx = (baseRadiusM / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
		const physicalScreenRadius = realRadiusPx * zoomScale;
		const minSize = ROCKET_VISUAL.MIN_SCREEN_RADIUS || 5.5;

		return Math.max(minSize, physicalScreenRadius);
	}

	setCollided() {
		super.setCollided();
		if (!this.isDestroyed) {
			this.isDestroyed = true;
			this.destroyedFlightTime = this.telemetry?.flightTime || this.flightTime || 0;
			this.predictedTrajectory = null;
			this.actualFlightPath = null;
			if (this.trajectory) {
				this.trajectory.clear();
			}
		}
	}

	// Override updateHistory exclusively for Rocket logic
	updateHistory(currentFrame, objects, isPaused = false) {
		if (this.isHoldDown && !this.isIgnited) {
			return;
		}

		let mode = TRAIL_MODE.NORMAL;
		if (this.inAtmosphere) {
			mode = TRAIL_MODE.ATMOSPHERE;
		} else if (this.isEscaping) {
			mode = TRAIL_MODE.ESCAPE;
		}

		this.trajectory.addPoint(this.x, this.y, currentFrame, mode);
		if (!isPaused) {
			this._recordActualFlightPath(objects);
		}

		const isBurning = this.isIgnited && this.burnTime > 0;

		// Record position for effect when ...
		// * Engine burning
		// * In atmosphere
		// * Escaping
		if (isBurning || this.inAtmosphere || this.isEscaping) {
			let refId = -1;
			let refX = 0;
			let refY = 0;
			let refAngle = 0;

			if (this.dominantBodyId !== undefined && this.dominantBodyId !== -1 && objects) {
				const refBody = objects.find(o => o.id === this.dominantBodyId);
				if (refBody) {
					refId = refBody.id;
					refX = refBody.x;
					refY = refBody.y;
					refAngle = refBody.rotationAngle || 0;
				}
			}

			// Offset to nozzle & flame tip
			const curStgIdx = this.telemetry?.stageIndex !== undefined ? this.telemetry.stageIndex : (this.currentStageIndex || 0);
			const totalStg = this.telemetry?.totalStages || this.stages?.length || 2;
			const align = ROCKET_VISUAL.ALIGNMENT;
			const offsets = align.NOZZLE_BOTTOM_OFFSET;
			let mult = offsets.TWO_STAGE;
			if (totalStg === 1) {
				mult = offsets.SINGLE_STAGE;
			} else if (totalStg >= 3) {
				mult = offsets.THREE_STAGE;
			}

			const baseRadiusM = this.baseRadiusM || (this.bottomOffsetM ? this.bottomOffsetM / mult : (DEFAULT_OBJECT_PARAMS['Rocket']?.RADIUS || 63));

			// Determine nozzle offset ratio and plume scale for current active stage
			let stageNozzleRatio = mult;
			let plumeScale = align.MAIN_PLUME_SCALE ?? 1.0;

			if (totalStg === 1) {
				stageNozzleRatio = offsets.SINGLE_STAGE;
				plumeScale = align.MAIN_PLUME_SCALE ?? 1.0;
			} else if (totalStg === 2) {
				if (curStgIdx === 0) {
					stageNozzleRatio = offsets.TWO_STAGE;
					plumeScale = align.MAIN_PLUME_SCALE ?? 1.0;
				} else {
					stageNozzleRatio = Math.abs(align.BASE_X_UPPER_RATIO - ROCKET_VISUAL.MODULES.NOZZLE2_LENGTH_RATIO);
					plumeScale = align.UPPER_PLUME_SCALE ?? 0.65;
				}
			} else if (totalStg >= 3) {
				if (curStgIdx === 0) {
					stageNozzleRatio = offsets.THREE_STAGE;
					plumeScale = align.MAIN_PLUME_SCALE ?? 1.0;
				} else if (curStgIdx === 1) {
					stageNozzleRatio = Math.abs((align.BASE_X_3STG_STAGE2_RATIO ?? -1.6) - ROCKET_VISUAL.MODULES.NOZZLE2_LENGTH_RATIO);
					plumeScale = align.UPPER_PLUME_SCALE ?? 0.65;
				} else {
					stageNozzleRatio = Math.abs((align.BASE_X_3STG_STAGE3_RATIO ?? -0.9) - (ROCKET_VISUAL.MODULES.NOZZLE3_LENGTH_RATIO || 0.28));
					plumeScale = align.STAGE3_PLUME_SCALE ?? 0.50;
				}
			}

			const nozzleDistM = baseRadiusM * stageNozzleRatio;
			let flameLenM = 0;

			if (isBurning) {
				const curFuel = (this.stages && this.stages[curStgIdx]?.fuelType) || this.fuelType || 'liquid';
				const cfg = ROCKET_VISUAL.PLUMES[curFuel] || ROCKET_VISUAL.PLUMES.liquid;
				const throttle = this.thrustRatio || 1.0;
				flameLenM = baseRadiusM * cfg.lenMult * plumeScale * throttle;
			}

			// Emit smoke directly at the tip of the flame (or nozzle if engine is not firing)
			const tipDistM = nozzleDistM + flameLenM;
			const offsetDistPx = UnitConvertUtils.m2pix(tipDistM);
			const offsetX = -Math.cos(this.thrustAngle) * offsetDistPx;
			const offsetY = -Math.sin(this.thrustAngle) * offsetDistPx;

			let relX = (this.x + offsetX) - refX;
			let relY = (this.y + offsetY) - refY;

			// Follow rotation
			if (mode === TRAIL_MODE.ATMOSPHERE && refAngle !== 0) {
				const cosA = Math.cos(-refAngle);
				const sinA = Math.sin(-refAngle);
				const localX = relX * cosA - relY * sinA;
				const localY = relX * sinA + relY * cosA;
				relX = localX;
				relY = localY;
			}

			this.effectTrail.addPoint(refId, relX, relY, currentFrame, mode);
		}
		else {
			this.effectTrail.clear();
		}
	}

	_drawEffects(ctx, x, y, screenRadius, zoomScale) {}

	_drawBody(ctx, x, y, screenRadius, zoomScale = 1) {
		RocketRenderer.draw(ctx, this, x, y, screenRadius, zoomScale);
	}

	_recordActualFlightPath(objects) {
		const hostId = (this.hostId !== null && this.hostId !== undefined)
			? this.hostId
			: (this.predictedTrajectory?.hostId ?? this.dominantBodyId);

		if (this.isHoldDown || hostId === null || hostId === undefined || !objects || this.state !== OBJECT_STATE.ACTIVE) {
			return;
		}

		const host = objects.find(o => o.id === hostId);
		if (!host) { return; }

		const relX_px = this.x - host.x;
		const relY_px = this.y - host.y;
		const r_px = Math.hypot(relX_px, relY_px);
		const phi_inertial = Math.atan2(relY_px, relX_px);
		const hostRot = host.rotationAngle || 0;
		const phi_surf = phi_inertial - hostRot;

		if (!this.actualFlightPath) {
			this.actualFlightPath = [];
		}

		const len = this.actualFlightPath.length;
		if (len === 0) {
			this.actualFlightPath.push({
				worldX: this.x,
				worldY: this.y,
				relX: relX_px,
				relY: relY_px,
				r: r_px,
				phiSurf: phi_surf
			});
		} else {
			const last = this.actualFlightPath[len - 1];
			const lastSurfX = (last.r !== undefined && last.phiSurf !== undefined)
				? last.r * Math.cos(last.phiSurf)
				: last.relX;
			const lastSurfY = (last.r !== undefined && last.phiSurf !== undefined)
				? last.r * Math.sin(last.phiSurf)
				: last.relY;
			const curSurfX = r_px * Math.cos(phi_surf);
			const curSurfY = r_px * Math.sin(phi_surf);
			const dx_m = UnitConvertUtils.pix2m(curSurfX - lastSurfX);
			const dy_m = UnitConvertUtils.pix2m(curSurfY - lastSurfY);

			// Sample points when moved at least configured threshold relative to host
			const minSampleDistM = RENDER.PREDICTED_TRAJECTORY.ACTUAL_SAMPLE_MIN_DIST_M || 5.0;
			if ((dx_m * dx_m + dy_m * dy_m) >= (minSampleDistM * minSampleDistM)) {
				this.actualFlightPath.push({
					worldX: this.x,
					worldY: this.y,
					relX: relX_px,
					relY: relY_px,
					r: r_px,
					phiSurf: phi_surf
				});
			}
		}

		const maxActualPoints = RENDER.PREDICTED_TRAJECTORY.ACTUAL_MAX_POINTS || 6000;
		if (this.actualFlightPath.length > maxActualPoints) {
			this.actualFlightPath = this.actualFlightPath.filter((_, idx) => idx % 2 === 0 || idx === len - 1);
		}
	}

	draw(renderContext) {
		if (!renderContext || !renderContext.basis) { return; }

		// 1. Draw predicted trajectory path & H3-style event markers in flight mode
		// Only render when rocket is actively flying and NOT destroyed/removed
		if (!this.isHoldDown && this.predictedTrajectory && !this.isDestroyed && this.state === OBJECT_STATE.ACTIVE) {
			if (!this.predictedTrajectory.hostId && this.hostId !== null) {
				this.predictedTrajectory.hostId = this.hostId;
			}

			TrajectoryPredictor.updateRocketFlightEvents(this, renderContext);

			const flightTime = this.telemetry?.flightTime || this.flightTime || 0;
			TrajectoryPredictor.renderTrajectory(renderContext.ctx, renderContext, this.predictedTrajectory, {
				mode: 'flight',
				passedEventIds: this.passedEventIds,
				currentFlightTime: flightTime,
				actualFlightPath: this.actualFlightPath,
				rocketX: this.x,
				rocketY: this.y,
				isDestroyed: false,
				showPredictedTrajectory: renderContext.showPredictedTrajectory !== false,
				showActualPath: renderContext.showActualFlightPath !== false
			});
		}

		// 2. Draw rocket body and flame effects
		if (this.state === OBJECT_STATE.ACTIVE) {
			const basis = renderContext.basis;
			const ctx = renderContext.ctx;
			const zoomScale = renderContext.zoomScale;
			const relX = this.getRelativeX(basis) * zoomScale;
			const relY = this.getRelativeY(basis) * zoomScale;
			const screenRadius = this._getDrawRadius(zoomScale);

			renderContext.bodyScreenRadius = screenRadius;

			this._drawBody(ctx, relX, relY, screenRadius, zoomScale);
			this._drawEffects(ctx, relX, relY, screenRadius, zoomScale);
		}

		// 3. Draw default celestial trajectory
		if (this.state === OBJECT_STATE.ACTIVE) {
			this.trajectory.draw(renderContext);
			this.effectTrail.draw(renderContext);
		}
	}
}

/*******************************************************************
 * Debris class
 *******************************************************************/
export class Debris extends GravSimObject {
	constructor(id, name, x, y, vx, vy, mass, color, size, radius, generation, borderColor, borderWidth, debrisSubType = 0, colorTheme = 'orange') {
		super(id, name, OBJECT_TYPES.DEBRIS, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth);
		this._mass = mass; // t
		this.debrisSubType = debrisSubType; // 0: Rock, 1: Booster, 2: Upper Stage, 3: Fairing
		this.colorTheme = colorTheme || 'orange';
		this.baseRadiusM = radius;
		this.polygonVertices = [];

		if (this.debrisSubType === 0) {
			this._generatePolygonVertices();
		} else {
			const random = () => {
				const x = Math.sin(this.id * 9.123) * 10000;
				return x - Math.floor(x);
			};
			const spec = MULTISTAGE_ROCKET.DEBRIS_SPECS[this.debrisSubType];
			const speedScale = spec?.rotationSpeedRand || RENDER.DEBRIS_HARDWARE.DEFAULT_ROTATION_SPEED;
			this.rotationSpeed = (random() - 0.5) * speedScale;
		}
	}

	get mass() { return this._mass; }
	set mass(val) { this._mass = val; }

	_getDrawRadius(zoomScale) {
		const baseRad = this.baseRadiusM || this.radius;
		const realRadiusPx = (baseRad / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
		const screenRadiusPx = realRadiusPx * zoomScale;

		const minSize = this.debrisSubType > 0 ? Math.max(this.size, 1.0) : this.size;
		return Math.max(minSize, screenRadiusPx);
	}

	_generatePolygonVertices() {
		const conf = RENDER.DEBRIS_RENDER;
		let seed = this.id;
		const random = () => {
			const x = Math.sin(seed++) * 10000;
			return x - Math.floor(x);
		};

		// Set random rotation speed
		this.rotationSpeed = (random() - 0.5) * conf.ROT_SPEED_VAR;

		const vertexCount = conf.MIN_VERTICES + Math.floor(random() * conf.VAR_VERTICES);
		for (let i = 0; i < vertexCount; i++) {
			const baseAngle = (i / vertexCount) * Math.PI * 2;
			const angleOffset = (random() - 0.5) * 0.5;
			const angle = baseAngle + angleOffset;
			const distanceRatio = conf.RAD_RATIO_MIN + random() * conf.RAD_RATIO_VAR;

			this.polygonVertices.push({
				x: Math.cos(angle) * distanceRatio,
				y: Math.sin(angle) * distanceRatio
			});
		}
	}

	_drawBody(ctx, x, y, screenRadius) {
		if (this.debrisSubType > 0) {
			ctx.save();
			ctx.translate(x, y);

			const angle = (Date.now() * this.rotationSpeed) % (Math.PI * 2);
			ctx.rotate(angle);

			const R = screenRadius;
			const hw = RENDER.DEBRIS_HARDWARE;
			const theme = ROCKET_VISUAL.THEMES[this.colorTheme] || ROCKET_VISUAL.THEMES.orange;

			if (R < hw.LOD_RADIUS_THRESHOLD) {
				const len = (this.debrisSubType === 1) ? R * hw.STAGE1_LEN_RATIO : (this.debrisSubType === 2 ? R * hw.STAGE2_LEN_RATIO : (this.debrisSubType === 4 ? R * (hw.BOOSTER_LEN_RATIO || 2.20) : R * hw.FAIRING_LEN_RATIO));
				const w = (this.debrisSubType === 1) ? R * hw.STAGE1_WIDTH_RATIO : (this.debrisSubType === 2 ? R * hw.STAGE2_WIDTH_RATIO : (this.debrisSubType === 4 ? R * (hw.BOOSTER_WIDTH_RATIO || 0.45) : R * hw.FAIRING_WIDTH_RATIO));
				const fill = (this.debrisSubType === 1) ? theme.stg1Grad[1] : (this.debrisSubType === 2 ? theme.stg2Grad[0] : (this.debrisSubType === 4 ? '#f0f2f5' : theme.fairingGrad[0]));
				ctx.fillStyle = fill;
				ctx.beginPath();
				ctx.ellipse(0, 0, len * 0.5, Math.max(1.0, w * 0.5), 0, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
				return;
			}

			if (this.debrisSubType === 1) {
				const len = R * hw.STAGE1_LEN_RATIO;
				const w = R * hw.STAGE1_WIDTH_RATIO;

				const grad = ctx.createLinearGradient(0, -w, 0, w);
				grad.addColorStop(0, theme.stg1Grad[0]);
				grad.addColorStop(0.5, theme.stg1Grad[1]);
				grad.addColorStop(1, theme.stg1Grad[2]);
				ctx.fillStyle = grad;
				ctx.fillRect(-len * 0.5, -w, len, w * 2);

				ctx.fillStyle = theme.nozzle;
				ctx.beginPath();
				ctx.moveTo(-len * 0.5, -w * 0.6);
				ctx.lineTo(-len * 0.5 - R * hw.STAGE1_NOZZLE_RATIO, -w * hw.STAGE1_NOZZLE_WIDTH_RATIO);
				ctx.lineTo(-len * 0.5 - R * hw.STAGE1_NOZZLE_RATIO, w * hw.STAGE1_NOZZLE_WIDTH_RATIO);
				ctx.lineTo(-len * 0.5, w * 0.6);
				ctx.closePath();
				ctx.fill();

				ctx.fillStyle = theme.fins;
				const finSpan = w * hw.STAGE1_FIN_SPAN_RATIO;
				ctx.beginPath();
				ctx.moveTo(-len * 0.5 + R * 0.5, -w);
				ctx.lineTo(-len * 0.5, -w - finSpan);
				ctx.lineTo(-len * 0.5 + R * 0.1, -w);
				ctx.closePath();
				ctx.fill();

				ctx.beginPath();
				ctx.moveTo(-len * 0.5 + R * 0.5, w);
				ctx.lineTo(-len * 0.5, w + finSpan);
				ctx.lineTo(-len * 0.5 + R * 0.1, w);
				ctx.closePath();
				ctx.fill();

				ctx.fillStyle = theme.interstage;
				ctx.fillRect(len * 0.5 - R * 0.25, -w, R * 0.25, w * 2);

			} else if (this.debrisSubType === 2) {
				const len = R * hw.STAGE2_LEN_RATIO;
				const w = R * hw.STAGE2_WIDTH_RATIO;

				const grad = ctx.createLinearGradient(0, -w, 0, w);
				grad.addColorStop(0, theme.stg2Grad[0]);
				grad.addColorStop(0.5, theme.stg2Grad[1]);
				grad.addColorStop(1, theme.stg2Grad[2]);
				ctx.fillStyle = grad;
				ctx.fillRect(-len * 0.5, -w, len, w * 2);

				ctx.fillStyle = theme.nozzle;
				ctx.beginPath();
				ctx.moveTo(-len * 0.5, -w * 0.35);
				ctx.lineTo(-len * 0.5 - R * hw.STAGE2_NOZZLE_RATIO, -w * 0.75);
				ctx.lineTo(-len * 0.5 - R * hw.STAGE2_NOZZLE_RATIO, w * 0.75);
				ctx.lineTo(-len * 0.5, w * 0.35);
				ctx.closePath();
				ctx.fill();

			} else if (this.debrisSubType === 3) {
				const len = R * hw.FAIRING_LEN_RATIO;
				const w = R * hw.FAIRING_WIDTH_RATIO;

				const grad = ctx.createLinearGradient(0, -w, 0, w);
				grad.addColorStop(0, theme.fairingGrad[0]);
				grad.addColorStop(0.5, theme.fairingGrad[1]);
				grad.addColorStop(1, theme.fairingGrad[2]);
				ctx.fillStyle = grad;
				ctx.strokeStyle = '#a0a8b0';
				ctx.lineWidth = 1;

				ctx.beginPath();
				ctx.moveTo(-len * 0.5, 0);
				ctx.quadraticCurveTo(len * 0.2, -w * 1.1, len * 0.5, 0);
				ctx.quadraticCurveTo(len * 0.2, -w * 0.75, -len * 0.5, 0);
				ctx.closePath();
				ctx.fill();
				ctx.stroke();

				ctx.fillStyle = '#33383f';
				ctx.beginPath();
				ctx.moveTo(-len * 0.45, 0);
				ctx.quadraticCurveTo(len * 0.2, -w * 0.7, len * 0.45, 0);
				ctx.lineTo(-len * 0.45, 0);
				ctx.closePath();
				ctx.fill();
			} else if (this.debrisSubType === 4) {
				const len = R * (hw.BOOSTER_LEN_RATIO || 2.20);
				const w = R * (hw.BOOSTER_WIDTH_RATIO || 0.45);
				const lNose = R * (hw.BOOSTER_NOSE_RATIO || 0.40);
				const lNozzle = R * (hw.BOOSTER_NOZZLE_RATIO || 0.25);
				const xBodyStart = -len * 0.5;
				const xBodyEnd = len * 0.5;

				// 1. Cylindrical Casing
				const grad = ctx.createLinearGradient(0, -w, 0, w);
				grad.addColorStop(0, '#ffffff');
				grad.addColorStop(0.5, '#f0f2f5');
				grad.addColorStop(1, '#d8dce2');
				ctx.fillStyle = grad;
				ctx.fillRect(xBodyStart, -w, len, w * 2);

				// 2. Conical Nose Cone (+x direction)
				ctx.fillStyle = '#22262c';
				ctx.beginPath();
				ctx.moveTo(xBodyEnd, -w);
				ctx.lineTo(xBodyEnd + lNose, 0);
				ctx.lineTo(xBodyEnd, w);
				ctx.closePath();
				ctx.fill();

				// 3. Orange Accent Band
				ctx.fillStyle = '#c85a1a';
				const bandW = len * 0.08;
				ctx.fillRect(xBodyEnd - bandW * 1.5, -w, bandW, w * 2);

				// 4. Nozzle (-x direction)
				ctx.fillStyle = '#1c2024';
				ctx.beginPath();
				ctx.moveTo(xBodyStart, -w * 0.7);
				ctx.lineTo(xBodyStart - lNozzle, -w * 1.1);
				ctx.lineTo(xBodyStart - lNozzle, w * 1.1);
				ctx.lineTo(xBodyStart, w * 0.7);
				ctx.closePath();
				ctx.fill();
			}

			ctx.restore();
			return;
		}

		ctx.fillStyle = this.color;
		ctx.beginPath();

		if (this.polygonVertices && this.polygonVertices.length > 0) {
			ctx.save();
			ctx.translate(x, y);

			// Apply continuous rotation based on time
			const angle = (Date.now() * this.rotationSpeed) % (Math.PI * 2);
			ctx.rotate(angle);

			const first = this.polygonVertices[0];
			ctx.moveTo(first.x * screenRadius, first.y * screenRadius);

			for (let i = 1; i < this.polygonVertices.length; i++) {
				const pt = this.polygonVertices[i];
				ctx.lineTo(pt.x * screenRadius, pt.y * screenRadius);
			}

			ctx.closePath();
			ctx.fill();
			ctx.restore();
		} else {
			ctx.arc(x, y, screenRadius, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}
