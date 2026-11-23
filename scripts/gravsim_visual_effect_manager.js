
// gravsim_visual_effect_manager.js

import { DEBRIS, ROCKET_LAUNCHER_CONFIG, EVENT_PRIORITY, OBJECT_STATE } from './gravsim_const.js';
import { ColorUtils, UnitConvertUtils, isLiveObject } from './gravsim_utils.js';
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
			// The pad stands on its host: without the host in the simulation (removed or destroyed, listed while its trail
			// fades) the pad is gone. Earlier only the rocket was checked, so while the rocket flew below the stop altitude
			// the effect went on at the removed host (design §4.13-31)
			if (!context) {
				this.padEffect.stop();
				return;
			}
			this.padEffect.update(dt, context);

			// Ids start at 0: a rocket with id 0 is a target too (design §4.13-24)
			const targetRocketId = this.padEffect.targetRocketId;
			if (targetRocketId !== null && targetRocketId !== undefined) {
				const rocket = this.universe.objects.find(o => o.id === targetRocketId);
				// Stop pad effect if rocket exceeds a certain altitude or is destroyed. Destroyed: gone from the list, or
				// still listed while its trail fades (state REMOVED / isDestroyed); only the gone case was caught, so the
				// pad kept steaming for a destroyed rocket (design §4.13-30, the rule of SoundEffects)
				const isFlying = Boolean(rocket && rocket.state === OBJECT_STATE.ACTIVE && !rocket.isDestroyed);
				if (isFlying && rocket.telemetry && rocket.telemetry.altM > ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M) {
					this.padEffect.stop();
				} else if (!isFlying) {
					this.padEffect.stop();
				}
			}
		}
	}

	/**
	 * The pad's rocket and host. Null when the pad has a host (a rollout always gives one) that is not in the simulation:
	 * the pad is gone with it. A pad without a host id has no host to follow, as before.
	 */
	_buildPadContext(renderContext = null) {
		const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);
		const hostId = this.padEffect.hostId;
		const hasHost = hostId !== null && hostId !== undefined;
		const host = hasHost ? this.universe.objects.find(o => o.id === hostId && isLiveObject(o)) : undefined;
		if (hasHost && !host) { return null; }
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
