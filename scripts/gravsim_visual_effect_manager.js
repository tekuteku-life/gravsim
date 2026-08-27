
// gravsim_visual_effect_manager.js

import { DEBRIS } from './gravsim_const.js';
import { ColorUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * VisualEffectManager Class
 * Manages the lifecycle and rendering of standalone visual effects
 * such as shockwaves and launch pad effects.
 *******************************************************************/
export class VisualEffectManager {
	constructor(universe) {
		this.universe = universe;
		this.shockwaves = [];

		this._bindEvents();
	}

	destroy() {
		this.shockwaves = [];
	}

	_bindEvents() {
		// --- Shockwave Events ---
		EventBus.on('effect:shockwave', (x, y, color) => {
			this.shockwaves.push({
				x: x,
				y: y,
				color: color,
				startTime: Date.now(),
				duration: DEBRIS.SHOCKWAVE_TIME
			});
		});

		EventBus.on('draw:after', (ctx, rc) => {
			this.drawShockwaves(ctx, rc);
		});
	}

	drawShockwaves(ctx, renderContext) {
		const now = Date.now();
		const basis = renderContext.basis;
		const zoomScale = renderContext.zoomScale;
		
		if (!basis) { return; }

		this.shockwaves = this.shockwaves.filter(eff => {
			const progress = (now - eff.startTime) / eff.duration;

			if (progress >= 1) { return false; }

			const radius = (progress * DEBRIS.SHOCKWAVE_RADIUS) * zoomScale;
			const alpha = 1.0 - progress;

			ctx.save();
			const relX = (eff.x - basis.x) * zoomScale;
			const relY = (eff.y - basis.y) * zoomScale;
			
			ctx.strokeStyle = ColorUtils.hexToRgba(eff.color, alpha);
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(relX, relY, radius, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();

			return true;
		});
	}
}
