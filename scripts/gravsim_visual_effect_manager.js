
// gravsim_visual_effect_manager.js

import { DEBRIS, ROCKET_LAUNCHER_CONFIG, EVENT_PRIORITY } from './gravsim_const.js';
import { ColorUtils, UnitConvertUtils } from './gravsim_utils.js';
import { PadEffectRenderer } from './gravsim_pad_effect.js';
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
		this.padEffect = new PadEffectRenderer();

		this._bindEvents();
	}

	destroy() {
		this.shockwaves = [];
		this.padEffect.stop();
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

		// --- Pad Effect Events ---
		EventBus.on('effect:pad-start', (rocketId, hostId) => {
			this.padEffect.start(rocketId, hostId);
		});

		EventBus.on('effect:pad-stop', () => {
			this.padEffect.stop();
		});

		EventBus.on('sequencer-event', (eventName) => {
			if (this.padEffect.isActive) {
				this.padEffect.handleEvent(eventName);
			}
		});

		EventBus.on('liftoff', () => {
			if (this.padEffect.isActive) {
				this.padEffect.handleLiftoff();
			}
		});

		// --- Update and Draw Hooks ---
		EventBus.onUpdate((dt, scaledDt) => this.update(scaledDt), EVENT_PRIORITY.LOGIC);

		EventBus.onDrawBefore((ctx, rc) => {
			if (rc.name !== 'main') { return; }
			if (this.padEffect.isActive) {
				const context = this._buildPadContext(rc);
				if (context) { this.padEffect.drawBackground(ctx, rc, context); }
			}
		}, EVENT_PRIORITY.DRAW_WORLD_FX);

		EventBus.onDrawAfter((ctx, rc) => {
			if (rc.name !== 'main') { return; }
			if (this.padEffect.isActive) {
				const context = this._buildPadContext(rc);
				if (context) { this.padEffect.drawForeground(ctx, rc, context); }
			}
			this.drawShockwaves(ctx, rc);
		}, EVENT_PRIORITY.DRAW_WORLD_FX);
	}

	update(dt) {
		if (this.padEffect && this.padEffect.isActive) {
			const context = this._buildPadContext();
			if (context) { this.padEffect.update(dt, context); }
			
			if (this.padEffect.targetRocketId) {
				const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);
				// Stop pad effect if rocket exceeds a certain altitude or is destroyed
				if (rocket && rocket.telemetry && rocket.telemetry.altM > ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M) {
					this.padEffect.stop();
				} else if (!rocket) {
					this.padEffect.stop();
				}
			}
		}
	}

	_buildPadContext(renderContext = null) {
		const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);
		const host = this.universe.objects.find(o => o.id === this.padEffect.hostId);
		const zoomScale = renderContext ? renderContext.zoomScale : this.universe.camera.getRenderState().zoomScale;
		
		return {
			rocket: rocket,
			host: host,
			m2pix: (m) => UnitConvertUtils.m2pix(m),
			zoomScale: zoomScale
		};
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
