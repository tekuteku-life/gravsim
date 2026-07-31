
// gravsim_object.js

import {
	DISTANCE_SCALE, TARGET_TRAIL_LENGTH_AU, HISTORY_LENGTH,
	OBJECT_STATE, METERS_PER_AU
} from './gravsim_const.js';

/*******************************************************************
 * GravSimObject class that represents a celestial object in the universe.
 * @property {string} name - The name of the object.
 * @property {number} x - The x-coordinate of the object in pixels.
 * @property {number} y - The y-coordinate of the object in pixels.
 * @property {number} vx - The x-component of the object's velocity in pix/sec.
 * @property {number} vy - The y-component of the object's velocity in pix/sec.
 * @property {number} ax - The x-component of the object's acceleration in pix/sec^2.
 * @property {number} ay - The y-component of the object's acceleration in pix/sec^2.
 * @property {number} mass - The mass of the object in tons.
 * @property {string} color - The color of the object in hex format.
 * @property {number} size - The size of the object in pixels.
 * @property {number} state - The state of the object (active, removed, etc.).
 * @property {Array} history - The history of the object's positions, stored as an array of objects with x and y properties.
*******************************************************************/
export class GravSimObject {
	constructor(name, x, y, vx, vy, mass, color, size, radius, isDebris = false) {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);

		this.name = name;
		this.id = GravSimObject._idCounter;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = 0;
		this.ay = 0;
		this.mass = mass;       // ton
		this.color = color;
		this.size = size;
		this.radius = radius;	// meters
		this.state = OBJECT_STATE.ACTIVE;
		this.history = [];
		this.isDebris = isDebris;

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
			const basisIdx = basis.history.length - (this.history.length - i);
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
			const basisIdx = basis.history.length - (this.history.length - i);
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

	draw(ctx, basis, scale) {
		if (!basis) { return; }

		// Draw main body and effects
		if (this.state === OBJECT_STATE.ACTIVE) {
			const relX = this.getRelativeX(basis);
			const relY = this.getRelativeY(basis);
			
			// Calculate the optimal drawing radius
			const drawRadius = this._getDrawRadius(scale);

			this._drawBody(ctx, relX, relY, drawRadius);

			if (this.isEscaping) {
				this._drawSparkle(ctx, relX, relY, drawRadius);
			}
		}

		// Draw trail (Skip for center object)
		if (this.id !== basis.id) {
			this._drawTrail(ctx, basis, scale);
		}
	}

	// Calculate switching between fixed size and real physical size
	_getDrawRadius(scale) {
		const zoomScale = 1 / scale;
		// Convert real physical radius (meters) to canvas pixels
		const realRadiusPx = (this.radius / METERS_PER_AU) * DISTANCE_SCALE;
		// Calculate how many pixels it takes on the screen right now
		const screenRadiusPx = realRadiusPx * zoomScale;

		// this.size acts as the minimum visual radius on the screen
		if (screenRadiusPx < this.size) {
			return this.size * scale;	// Keep fixed visible size
		} else {
			return realRadiusPx;		// Use real physical size
		}
	}

	_drawBody(ctx, x, y, drawRadius) {
		ctx.fillStyle = this.color;
		ctx.beginPath();
		ctx.arc(x, y, drawRadius, 0, Math.PI * 2);
		ctx.fill();
	}

	_drawSparkle(ctx, x, y, drawRadius) {
		const now = Date.now();
		const blink = Math.abs(Math.sin(now / 80 + this.id)); 
		
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(now / 500); 
		
		ctx.globalAlpha = blink;
		ctx.fillStyle = "#FFFFFF"; 
		
		const starSize = drawRadius * 3.0; 
		const innerSize = drawRadius * 0.4; 
		
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

	_drawTrail(ctx, basis, scale) {
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
			const t = (i - trailStaIdx) / drawTrailCount; // 0 (oldest) to 1 (newest)
			const alpha = t * 0.4 + 0.2; // fade in (0.2~1.0)
			const width = this.size * (0.2 + 0.8 * t) * scale; 

			ctx.strokeStyle = this._hexToRgba(this.color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(this.getRelativeHistoryX(i - 1, basis), this.getRelativeHistoryY(i - 1, basis));
			ctx.lineTo(this.getRelativeHistoryX(i, basis), this.getRelativeHistoryY(i, basis));
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
