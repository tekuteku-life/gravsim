
// gravsim_trajectory.js

import { RENDER } from './gravsim_const.js';
import { TrailRenderer } from './gravsim_trail_renderer.js';

export class Trajectory {
	constructor(id, config) {
		this.id = id;
		this.rendering_config = config || {};

		// Ring buffer
		this.capacity = RENDER.TRAIL_HISTORY_LENGTH || 1500;
		this.x = new Float64Array(this.capacity);
		this.y = new Float64Array(this.capacity);
		this.frame = new Float64Array(this.capacity);
		this.mode = new Uint8Array(this.capacity);
		
		this.head = 0;
		this.count = 0;
	}

	addPoint(x, y, frameNum, mode = 0) {
		this.x[this.head] = x;
		this.y[this.head] = y;
		this.frame[this.head] = frameNum;
		this.mode[this.head] = mode;
		
		this.head = (this.head + 1) % this.capacity;
		if (this.count < this.capacity) { this.count++; }
	}

	shrink(atten = 1) {
		if (Math.floor(this.count) > 0) {
			this.count *= (1.0 - Math.min(99, atten)/100);
		}
		else {
			this.count = 0;
		}
	}

	clear() {
		this.head = 0;
		this.count = 0;
	}

	// Get point data by logical index (0 = oldest, count-1 = new)
	getPoint(logicalIndex) {
		if (logicalIndex < 0 || logicalIndex >= this.count) { return null; }
		const idx = (this.head - this.count + logicalIndex + this.capacity) % this.capacity;
		return { x: this.x[idx], y: this.y[idx], frame: this.frame[idx], mode: this.mode[idx] };
	}

	// Get point by specified target frame
	getInterpolatedPos(targetFrame) {
		if (this.count === 0) { return null; }
		
		let low = 0;
		let high = this.count - 1;
		
		const oldest = this.getPoint(low);
		const newest = this.getPoint(high);
		
		if (!oldest || !newest) { return null; }
		if (targetFrame <= oldest.frame) return { x: oldest.x, y: oldest.y };
		if (targetFrame >= newest.frame) return { x: newest.x, y: newest.y };

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const pt = this.getPoint(mid);

			if (pt.frame === targetFrame) {
				return { x: pt.x, y: pt.y };
			} else if (pt.frame < targetFrame) {
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		const p1 = this.getPoint(high); // High is oldest because inversed (high < low)
		const p2 = this.getPoint(low);
		if (!p1 || !p2) { return null; }
		if (p2.frame - p1.frame === 0) { return { x: p1.x, y: p1.y }; }

		const t = (targetFrame - p1.frame) / (p2.frame - p1.frame);
		return {
			x: p1.x + (p2.x - p1.x) * t,
			y: p1.y + (p2.y - p1.y) * t
		};
	}

	draw(renderContext) {
		if (this.count < 2) { return; }
		TrailRenderer.draw(this, renderContext);
	}
}
