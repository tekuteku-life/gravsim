
// gravsim_object.js

import {
	DISTANCE_SCALE, TARGET_TRAIL_LENGTH_AU, HISTORY_LENGTH,
	OBJECT_STATE, METERS_PER_AU,
	SPARKLE_ANIM_SPEED, SPARKLE_ROTATE_SPEED,
	SPARKLE_STAR_SIZE_RATIO, SPARKLE_STAR_INNER_SIZE_RATIO,
	DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js';

/*******************************************************************
 * GravSimObject class that represents a celestial object in the universe.
 *******************************************************************/
export class GravSimObject {
	constructor(name, x, y, vx, vy, mass, color, size, radius,
		generation = 0, borderColor = null, borderWidth = 0) {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);

		this.name = name;
		this.id = GravSimObject._idCounter;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = 0;
		this.ay = 0;
		this.mass = mass;		// ton
		this.color = color;
		this.size = size;
		this.radius = radius;	// meters

		this.thrustForce = 0;
		this.burnTime = 0;
		this.thrustAngle = 0;
		this.emptyMass = 0;
		this.massLossRate = 0;
		this.maxGLimit = 0;
		this.thrustRatio = 0;

		this.borderColor = borderColor;
		this.borderWidth = borderWidth;

		this.state = OBJECT_STATE.ACTIVE;
		this.history = [];
		this.deadFrames = 0;
		this.generation = generation;
		this.isDebris = this.generation > 0;

		GravSimObject._idCounter++;
	}

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

	finished() {
		if( this.state === OBJECT_STATE.REMOVED
			&& this.history.length === 0
		) {
			return true;
		}
		return false;
	}

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

	getRelativeX(basis) {
		if( basis ) {
			return this.x - basis.x;
		} else {
			return this.x;
		}
	}
	getRelativeY(basis) {
		if( basis ) {
			return this.y - basis.y;
		} else {
			return this.y;
		}
	}

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
			this._drawAtmosphere(ctx, relX, relY, screenRadius, zoomScale);

			if (this.burnTime > 0) {
				this._drawFlame(ctx, relX, relY, screenRadius);
			}

			if (this.isEscaping) {
				this._drawSparkle(ctx, relX, relY, screenRadius);
			}
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
		if (screenRadiusPx < this.size) {
			return this.size;
		} else {
			return screenRadiusPx;
		}
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
	
	_drawAtmosphere(ctx, x, y, screenRadius, zoomScale) {
		const param = DEFAULT_OBJECT_PARAMS[this.name];
		if (!param || !param.ATM_COLOR || !param.ATM_LIMIT_ALT) return;

		const atmThicknessPx = (param.ATM_LIMIT_ALT / METERS_PER_AU) * DISTANCE_SCALE;
		const screenThicknessPx = atmThicknessPx * zoomScale;

		if (screenThicknessPx < 1) return;

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

	_drawSparkle(ctx, x, y, screenRadius) {
		const now = Date.now();
		const blink = Math.abs(Math.sin(now / SPARKLE_ANIM_SPEED + this.id)); 

		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(now / SPARKLE_ROTATE_SPEED); 

		ctx.globalAlpha = blink;
		ctx.fillStyle = "#FFFFFF"; 

		const starSize = screenRadius * SPARKLE_STAR_SIZE_RATIO; 
		const innerSize = screenRadius * SPARKLE_STAR_INNER_SIZE_RATIO; 

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
