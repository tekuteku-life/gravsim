
// gravsim_object.js

import {
	PHYSICS, RENDER, OBJECT_STATE,
	DEFAULT_OBJECT_PARAMS, OBJECT_TYPES
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

		if (this.isDebris) {
			this._generatePolygonVertices();
		}
	}

	get mass() { return 1; }

	isCenterObject() {
		return window.universe && window.universe.centerObject && this.id === window.universe.centerObject.id;
	}

	updateHistory(currentFrame) {
		this.trajectory.addPoint(this.x, this.y, currentFrame);
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
		let mode = 'normal';
		if (this.isEscaping) {
			mode = 'escape';
		} else if (this.inAtmosphere) {
			mode = 'atmosphere';
		}
		this.trajectory.setVisualMode(mode);
		this.trajectory.draw(renderContext);
	}

	_generatePolygonVertices() {
		this.polygonVertices = [];
		let seed = this.id;
		const random = () => {
			const x = Math.sin(seed++) * 10000;
			return x - Math.floor(x);
		};
		
		const vertexCount = 5 + Math.floor(random() * 4);
		for (let i = 0; i < vertexCount; i++) {
			const baseAngle = (i / vertexCount) * Math.PI * 2;
			const angleOffset = (random() - 0.5) * 0.5;
			const angle = baseAngle + angleOffset;

			const distanceRatio = 0.6 + random() * 0.6;

			this.polygonVertices.push({
				x: Math.cos(angle) * distanceRatio,
				y: Math.sin(angle) * distanceRatio
			});
		}
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

		if (this.isDebris && this.polygonVertices) {
			const first = this.polygonVertices[0];
			ctx.moveTo(x + first.x * screenRadius, y + first.y * screenRadius);
			for (let i = 1; i < this.polygonVertices.length; i++) {
				const pt = this.polygonVertices[i];
				ctx.lineTo(x + pt.x * screenRadius, y + pt.y * screenRadius);
			}
			ctx.closePath();
			ctx.fill();
		}
		else {
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
		if (this.burnTime > 0) {
			this._drawFlame(ctx, x, y, screenRadius);
		}
	}

	_drawFlame(ctx, x, y, screenRadius) {
		const flicker = 0.8 + Math.random() * 0.4;
		const flameLen = screenRadius * 3 * flicker;
		
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(this.thrustAngle); // Pointing forward

		ctx.fillStyle = "rgba(255, 100, 0, 0.8)";
		ctx.beginPath();
		ctx.moveTo(-screenRadius, 0);
		ctx.lineTo(-screenRadius * 0.8, screenRadius * 0.8);
		ctx.lineTo(-screenRadius - flameLen, 0);
		ctx.lineTo(-screenRadius * 0.8, -screenRadius * 0.8);
		ctx.fill();

		ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
		ctx.beginPath();
		ctx.moveTo(-screenRadius, 0);
		ctx.lineTo(-screenRadius * 0.9, screenRadius * 0.4);
		ctx.lineTo(-screenRadius - flameLen * 0.6, 0);
		ctx.lineTo(-screenRadius * 0.9, -screenRadius * 0.4);
		ctx.fill();
		
		ctx.restore();
	}

	_drawBody(ctx, x, y, screenRadius) {
		ctx.fillStyle = this.color;
		ctx.beginPath();
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(this.thrustAngle);
		ctx.ellipse(0, 0, screenRadius * 2.0, screenRadius * 0.7, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}
}
