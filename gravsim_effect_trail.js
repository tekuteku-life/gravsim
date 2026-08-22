
// gravsim_effect_trail.js

import { RENDER } from './gravsim_const.js';
import { EffectRenderer } from './gravsim_trail_renderer.js';

export class EffectTrail {
	constructor(id, config) {
		this.id = id;
		this.rendering_config = config || {};

		// Ring buffer
		this.capacity = RENDER.EFFECT_HISTORY_LENGTH || 400;
		this.refId = new Int32Array(this.capacity);
		this.x = new Float64Array(this.capacity);
		this.y = new Float64Array(this.capacity);
		this.frame = new Float64Array(this.capacity);
		this.mode = new Uint8Array(this.capacity);
		
		this.head = 0;
		this.count = 0;
	}

	addPoint(refId, relX, relY, frameNum, mode = 0) {
		this.refId[this.head] = refId;
		this.x[this.head] = relX;
		this.y[this.head] = relY;
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
		return { refId: this.refId[idx], x: this.x[idx], y: this.y[idx], frame: this.frame[idx], mode: this.mode[idx] };
	}

	draw(renderContext) {
		if (this.count < 2) { return; }
		EffectRenderer.draw(this, renderContext);
	}
}
