
// gravsim_object.js

import {
	PHYSICS, RENDER, OBJECT_STATE,
	DEFAULT_OBJECT_PARAMS, OBJECT_TYPES, TRAIL_MODE, PAD_EFFECT
} from './gravsim_const.js';
import { Trajectory } from './gravsim_trajectory.js';
import { ColorUtils } from './gravsim_utils.js';

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
	}

	get mass() { return 1; }

	isCenterObject(renderContext) {
		return renderContext && renderContext.centerObjectId === this.id;
	}

	updateHistory(currentFrame) {
		let mode = TRAIL_MODE.NORMAL;
		if (this.inAtmosphere) {
			mode = TRAIL_MODE.ATMOSPHERE;
		} else if (this.isEscaping) {
			mode = TRAIL_MODE.ESCAPE;
		}
		this.trajectory.addPoint(this.x, this.y, currentFrame, mode);
	}

	clearHistory() {
		if (this.trajectory) {
			this.trajectory.clear();
		}
	}

	finished() {
		if (this.state === OBJECT_STATE.REMOVED) {
			this.trajectory.shrink(2);
			return this.trajectory.count <= 0;
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
	constructor(id, name, x, y, vx, vy, dryMass, fuelMass, color, size, radius, generation, borderColor, borderWidth) {
		super(id, name, OBJECT_TYPES.ROCKET, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth);
		this.dryMass = dryMass; // t
		this.fuelMass = fuelMass; // t
		this.thrustForce = 0; // N
		this.burnTime = 0;
		this.thrustAngle = 0;
		this.massLossRate = 0; // t/s
		this.maxGLimit = 0;
		this.thrustRatio = 0;
		this.flightTime = 0;
		this.autoControl = true;
		
		// Launch Sequencer States
		this.hostId = null;
		this.hostAngleRad = 0;
		this.hostAltM = 0;
		this.isHoldDown = false;
		this.isIgnited = true;
		this.isInternalPower = false;

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
	}
	get mass() { return this.dryMass + this.fuelMass; }
	set mass(val) {}

	_drawEffects(ctx, x, y, screenRadius, zoomScale) {
		if (this.isIgnited && this.burnTime > 0) {
			this._drawFlame(ctx, x, y, screenRadius);
		}
	}

	_drawFlame(ctx, x, y, screenRadius) {
		const conf = RENDER.ROCKET;
		const range = conf.FLAME_FLICKER_MAX - conf.FLAME_FLICKER_MIN;
		const flicker = conf.FLAME_FLICKER_MIN + Math.random() * range;
		const flameLen = screenRadius * conf.FLAME_LEN_MULT * flicker;
		
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(this.thrustAngle); // Pointing forward

		ctx.fillStyle = conf.FLAME_OUTER_COLOR;
		ctx.beginPath();
		ctx.moveTo(-screenRadius, 0);
		ctx.lineTo(-screenRadius * conf.FLAME_OUTER_W_MULT, screenRadius * conf.FLAME_OUTER_W_MULT);
		ctx.lineTo(-screenRadius - flameLen, 0);
		ctx.lineTo(-screenRadius * conf.FLAME_OUTER_W_MULT, -screenRadius * conf.FLAME_OUTER_W_MULT);
		ctx.fill();

		ctx.fillStyle = conf.FLAME_INNER_COLOR;
		ctx.beginPath();
		ctx.moveTo(-screenRadius, 0);
		ctx.lineTo(-screenRadius * conf.FLAME_INNER_W_MULT, screenRadius * conf.FLAME_INNER_Y_MULT);
		ctx.lineTo(-screenRadius - flameLen * conf.FLAME_INNER_H_MULT, 0);
		ctx.lineTo(-screenRadius * conf.FLAME_INNER_W_MULT, -screenRadius * conf.FLAME_INNER_Y_MULT);
		ctx.fill();
		
		ctx.restore();
	}

	_drawBody(ctx, x, y, screenRadius) {
		const conf = RENDER.ROCKET;
		ctx.fillStyle = this.color;
		ctx.beginPath();
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(this.thrustAngle);

		if (this.isInternalPower) {
			ctx.shadowColor = PAD_EFFECT.STRUCTURE.GLOW_COLOR;
			ctx.shadowBlur = Math.max(10, screenRadius * PAD_EFFECT.STRUCTURE.GLOW_BLUR_MULT);
		}

		ctx.ellipse(0, 0, screenRadius * conf.BODY_LENGTH_MULT, screenRadius * conf.BODY_WIDTH_MULT, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}
}

/*******************************************************************
 * Debris class
 *******************************************************************/
export class Debris extends GravSimObject {
	constructor(id, name, x, y, vx, vy, mass, color, size, radius, generation, borderColor, borderWidth) {
		super(id, name, OBJECT_TYPES.DEBRIS, x, y, vx, vy, color, size, radius, generation, borderColor, borderWidth);
		this._mass = mass; // t
		this.polygonVertices = [];

		this._generatePolygonVertices();
	}
	get mass() { return this._mass; }
	set mass(val) { this._mass = val; }

	_generatePolygonVertices() {
		const conf = RENDER.DEBRIS_RENDER;
		let seed = this.id;
		const random = () => {
			const x = Math.sin(seed++) * 10000;
			return x - Math.floor(x);
		};

		// Set random rotation speed (-0.0025 to 0.0025 rad/ms)
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
		ctx.fillStyle = this.color;
		ctx.beginPath();

		if (this.polygonVertices) {
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
