
// gravsim_object.js

import {
	DISTANCE_SCALE, TARGET_TRAIL_LENGTH_AU, HISTORY_LENGTH,
	OBJECT_STATE, METERS_PER_AU,
	SPARKLE_ANIM_SPEED, SPARKLE_ROTATE_SPEED,
	SPARKLE_STAR_SIZE_RATIO, SPARKLE_STAR_INNER_SIZE_RATIO, SPARKLE_MAX_SIZE_PX,
	DEFAULT_OBJECT_PARAMS, OBJECT_TYPES
} from './gravsim_const.js';

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
		this.history = [];
		this.deadFrames = 0;
	}

	get mass() { return 1; }

	isCenterObject() {
		return window.universe && window.universe.centerObject && this.id === window.universe.centerObject.id;
	}

	addHistory() {
		if (this.state !== OBJECT_STATE.ACTIVE) {
			return;
		}

		if (this.history.length >= HISTORY_LENGTH) {
			this.history.shift();
		}
		this.history.push({ x: this.x, y: this.y });
	}

	updateHistory() {
		if (this.state === OBJECT_STATE.ACTIVE) {
			return;
		}

		this.deadFrames = this.deadFrames + 1;

		if (this.history.length > 0) {
			this.history.shift();
		}
	}

	clearHistory() {
		this.history = [];
	}

	finished() { return this.state === OBJECT_STATE.REMOVED && this.history.length === 0; }

	setCollided() {
		this.state = OBJECT_STATE.REMOVED;
		this.deadFrames = 0;
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

	getRelativeHistoryX(i, basis) {
		if( basis ) {
			const deadOffset = this.deadFrames;
			const basisIdx = basis.history.length - (this.history.length - i) - deadOffset;
			if (basisIdx >= 0 && basisIdx < basis.history.length) {
				return this.history[i].x - basis.history[basisIdx].x;
			}
			else {
				return this.history[i].x - basis.x;
			}
		} else {
			return this.history[i].x;
		}
	}
	getRelativeHistoryY(i, basis) {
		if( basis ) {
			const deadOffset = this.deadFrames;
			const basisIdx = basis.history.length - (this.history.length - i) - deadOffset;
			if (basisIdx >= 0 && basisIdx < basis.history.length) {
				return this.history[i].y - basis.history[basisIdx].y;
			}
			else {
				return this.history[i].y - basis.y;
			}
		} else {
			return this.history[i].y;
		}
	}

	draw(ctx, basis, zoomScale) {
		if (!basis) { return; }

		// Draw main body and effects (Screen-space calculation)
		if (this.state === OBJECT_STATE.ACTIVE) {
			const relX = this.getRelativeX(basis) * zoomScale;
			const relY = this.getRelativeY(basis) * zoomScale;

			const screenRadius = this._getDrawRadius(zoomScale);

			this._drawBody(ctx, relX, relY, screenRadius);
			this._drawEffects(ctx, relX, relY, screenRadius, zoomScale);
		}

		// Draw trail (Skip for center object)
		if (this.id !== basis.id) {
			this._drawTrail(ctx, basis, zoomScale);
		}
	}

	// Calculate switching between fixed size and real physical size
	_getDrawRadius(zoomScale) {
		const realRadiusPx = (this.radius / METERS_PER_AU) * DISTANCE_SCALE;
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

	_drawEscapeSparkle(ctx, x, y, screenRadius) {
		const now = Date.now();
		const blink = Math.abs(Math.sin(now / SPARKLE_ANIM_SPEED + this.id)); 

		const rawStarSize = screenRadius * SPARKLE_STAR_SIZE_RATIO; 
		const starSize = Math.min(rawStarSize, SPARKLE_MAX_SIZE_PX);
		const innerSize = starSize * (SPARKLE_STAR_INNER_SIZE_RATIO / SPARKLE_STAR_SIZE_RATIO); 

		// Shift in the direction opposite to the direction of travel 
		const vAngle = Math.atan2(this.vy, this.vx);
		const offsetDist = screenRadius + starSize * 0.8; // Space them out a little so they don't overlap.
		const offsetX = x - Math.cos(vAngle) * offsetDist;
		const offsetY = y - Math.sin(vAngle) * offsetDist;

		ctx.save();
		ctx.translate(offsetX, offsetY);
		ctx.rotate(now / SPARKLE_ROTATE_SPEED); 

		ctx.globalAlpha = blink;
		ctx.fillStyle = "#FFFFFF"; 

		ctx.beginPath();
		ctx.moveTo(0, -starSize);
		ctx.lineTo(innerSize, -innerSize);
		ctx.lineTo(starSize, 0);
		ctx.lineTo(innerSize, innerSize);
		ctx.lineTo(0, starSize);
		ctx.lineTo(-innerSize, innerSize);
		ctx.lineTo(-starSize, 0);
		ctx.lineTo(-innerSize, -innerSize);
		ctx.fill();

		ctx.restore();
	}

	_drawTrail(ctx, basis, zoomScale) {
		const targetLength = TARGET_TRAIL_LENGTH_AU * DISTANCE_SCALE;
		let drawTrailCount = this.history.length;

		if (this.history.length >= 2) {
			const lastIdx = this.history.length - 1;
			const dx = this.history[lastIdx].x - this.history[lastIdx - 1].x;
			const dy = this.history[lastIdx].y - this.history[lastIdx - 1].y;
			
			const distPerFrame = Math.sqrt(dx * dx + dy * dy);

			if (distPerFrame > 0.0001) {
				drawTrailCount = Math.floor(targetLength / distPerFrame);
			}
		}

		drawTrailCount = Math.min(Math.max(drawTrailCount, 2), this.history.length);

		let trailStaIdx = this.history.length - drawTrailCount;
		if (trailStaIdx < 0) trailStaIdx = 0;

		// Draw history with fading color and thinning line
		for (let i = trailStaIdx + 1; i < this.history.length; i++) {
			const t = (i - trailStaIdx) / drawTrailCount;
			const alpha = t * 0.4 + 0.2;
			const width = this.size * (0.2 + 0.8 * t); // screen pixels

			ctx.strokeStyle = this._hexToRgba(this.color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(this.getRelativeHistoryX(i - 1, basis) * zoomScale, this.getRelativeHistoryY(i - 1, basis) * zoomScale);
			ctx.lineTo(this.getRelativeHistoryX(i, basis) * zoomScale, this.getRelativeHistoryY(i, basis) * zoomScale);
			ctx.stroke();
		}
		ctx.lineWidth = 1;
	}

	// convert hex color to rgba
	_hexToRgba(hex, alpha) {
		let c = hex.replace('#', '');
		if (c.length === 3) c = c.split('').map(x => x + x).join('');
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;
		return `rgba(${r},${g},${b},${alpha})`;
	}
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
			const atmThicknessPx = (param.ATM_LIMIT_ALT / METERS_PER_AU) * DISTANCE_SCALE;
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

		if (this.isEscaping) {
			this._drawEscapeSparkle(ctx, x, y, screenRadius);
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

		if (this.isEscaping) {
			this._drawEscapeSparkle(ctx, x, y, screenRadius);
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
