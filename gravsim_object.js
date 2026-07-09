
// gravsim_object.js

import {
	DISTANCE_SCALE, TARGET_TRAIL_LENGTH_AU, HISTORY_LENGTH,
	OBJECT_STATE
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
	constructor(name, x, y, vx, vy, mass, color, size, radius) {
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

		GravSimObject._idCounter++;
	}

	isCenterObject() {
		return window.universe && window.universe.centerObject && this.id === window.universe.centerObject.id;
	}

	addHistory() {
		if (this.state !== OBJECT_STATE.ACTIVE) {
			return;
		}

		if( this.isCenterObject() ) {
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

		if( this.isCenterObject() ) {
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
		if( this.isCenterObject() ) {
			return;
		}

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

	shiftPosition(dx, dy) {
		this.x += dx;
		this.y += dy;
		for (let i = 0; i < this.history.length; i++) {
			this.history[i].x += dx;
			this.history[i].y += dy;
		}
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

	getRelativeHistryX(i, basis) {
		if( basis ) {
			return this.history[i].x - basis.x;
		} else {
			return this.history[i].x;
		}
	}
	getRelativeHistryY(i, basis) {
		if( basis ) {
			return this.history[i].y - basis.y;
		} else {
			return this.history[i].y;
		}
	}

	transformRelativeCordinate(basis) {
		if( this.state != OBJECT_STATE.ACTIVE || basis.state != OBJECT_STATE.ACTIVE ) {
			return;
		}

		this.x += basis.vx;
		this.y += basis.vy;

		for (let i = 0; i < this.history.length; i++) {
			this.history[i].x += basis.vx;
			this.history[i].y += basis.vy;
		}
	}

	draw(ctx, basis, scale) {
		ctx.fillStyle = this.color;

		if( this.state === OBJECT_STATE.ACTIVE) {
			ctx.beginPath();
			ctx.arc(this.getRelativeX(basis), this.getRelativeY(basis), this.size *scale, 0, Math.PI * 2);
			ctx.fill();
		}

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
			const width = this.size * (0.2 + 0.8 * t) *scale; // thin to thick

			ctx.strokeStyle = hexToRgba(this.color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(this.getRelativeHistryX(i - 1, basis), this.getRelativeHistryY(i - 1, basis));
			ctx.lineTo(this.getRelativeHistryX(i, basis), this.getRelativeHistryY(i, basis));
			ctx.stroke();
		}
		ctx.lineWidth = 1;

		// Helper: convert hex color to rgba
		function hexToRgba(hex, alpha) {
			let c = hex.replace('#', '');
			if (c.length === 3) c = c.split('').map(x => x + x).join('');
			const num = parseInt(c, 16);
			const r = (num >> 16) & 255;
			const g = (num >> 8) & 255;
			const b = num & 255;
			return `rgba(${r},${g},${b},${alpha})`;
		}
		ctx.stroke();
	}
}
