
// gravsim_camera.js

import { MathUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * Camera Class
 * Manages the viewport state independently from physical objects,
 * providing seamless transitions (Lerp) and dynamic auto-tracking.
 *******************************************************************/
export class Camera {
	constructor() {
		this.trackingTarget = null;
		this.autoTrackHost = null;

		// Zoom limits
		this.minZoomExp = -2;
		this.maxZoomExp = 9;

		// Current values (used for rendering)
		this.currentOffset = { x: 0, y: 0 };
		this.currentZoomExp = 0;
		this.currentRotation = 0;

		// Target values (used for input and logic)
		this.targetOffset = { x: 0, y: 0 };
		this.targetZoomExp = 0;
		this.targetRotation = 0;

		// Interpolation factor per second
		this.lerpFactor = 8.0;
	}

	setTrackingTarget(newTarget) {
		if (this.trackingTarget && newTarget && this.trackingTarget.id !== newTarget.id) {
			// Calculate current absolute view center to prevent screen jump (warping)
			const curAbsX = this.trackingTarget.x + this.currentOffset.x;
			const curAbsY = this.trackingTarget.y + this.currentOffset.y;
			
			// Set new target and calculate reverse offset from the new target
			this.trackingTarget = newTarget;
			this.currentOffset.x = curAbsX - newTarget.x;
			this.currentOffset.y = curAbsY - newTarget.y;
		} else {
			this.trackingTarget = newTarget;
		}
		
		// Reset target offset so the camera smoothly pans to the center of the new target
		this.targetOffset = { x: 0, y: 0 };
	}

	addPan(dxPx, dyPx) {
		const currentZoom = Math.pow(10, this.currentZoomExp);
		
		// Rotate the pan vector back to world space to align with mouse movement
		const cosA = Math.cos(this.currentRotation);
		const sinA = Math.sin(this.currentRotation);
		
		const wDx = (dxPx * cosA - dyPx * sinA) / currentZoom;
		const wDy = (dxPx * sinA + dyPx * cosA) / currentZoom;
		
		this.targetOffset.x -= wDx;
		this.targetOffset.y -= wDy;
	}

	addZoom(deltaExp) {
		this.targetZoomExp += deltaExp;
	}

	setTargetOffset(x, y) {
		this.targetOffset.x = x;
		this.targetOffset.y = y;
	}

	setTargetZoomExp(exp) {
		this.targetZoomExp = exp;
	}

	setTargetRotation(rad) {
		this.targetRotation = rad;
	}

	setAutoTracking(target, host) {
		this.autoTrackHost = host;
		this.setTrackingTarget(target);
		this.setTargetOffset(0, 0);
	}

	stopAutoTracking(fallbackHost = null) {
		this.autoTrackHost = null;
		
		if (fallbackHost) {
			this.setTrackingTarget(fallbackHost);
			this.setTargetRotation(0);
			
			// Calculate zoom to fit host gracefully
			const hostRadiusPx = UnitConvertUtils.m2pix(fallbackHost.radius);
			const targetSize = Math.min(window.innerWidth, window.innerHeight) / 2.2;
			let idealExp = Math.log10(targetSize / hostRadiusPx);

			idealExp = Math.max(this.minZoomExp, Math.min(this.maxZoomExp, idealExp));
			this.setTargetZoomExp(idealExp);
			
			// Sync UI slider during fallback
			EventBus.emit('camera:zoom-changed', idealExp);
		}
	}

	_autoTracking() {
		if (!this.autoTrackHost || !this.trackingTarget) { return; }

		const rocket = this.trackingTarget;
		const host = this.autoTrackHost;
		
		const dx = rocket.x - host.x;
		const dy = rocket.y - host.y;
		
		// Apply rotation to keep the earth at the bottom of the screen
		const angle = Math.atan2(dy, dx);
		this.setTargetRotation(-angle - Math.PI / 2);

		// Calculate zoom to keep ground around the bottom 10%
		const altM = UnitConvertUtils.pix2m(Math.sqrt(dx * dx + dy * dy)) - host.radius;
		const canvasHeight = window.innerHeight;
		const minAltM = 200; // clamp minimum virtual altitude for zoom
		const clampedAltM = Math.max(minAltM, altM);
		const clampedDistPx = UnitConvertUtils.m2pix(clampedAltM);
		
		let targetZoom = (canvasHeight * 0.4) / clampedDistPx;

		// Restrict zoom out limit
		const minZoomScale = Math.pow(10, this.minZoomExp);
		const maxZoomScale = Math.pow(10, this.maxZoomExp);
		targetZoom = Math.max(minZoomScale, Math.min(maxZoomScale, targetZoom));
		
		const targetExp = Math.log10(targetZoom);
		this.setTargetZoomExp(targetExp);
		
		// Sync UI slider during tracking
		EventBus.emit('camera:zoom-changed', targetExp);

		// Reached max altitude limit, stop tracking
		if (altM > host.radius * 0.2) {
			this.stopAutoTracking(host);
		}
	}

	update(dtSec) {
		// Process auto tracking logic before interpolation
		this._autoTracking();

		// Smoothly interpolate current values towards target values
		// Use Math.min to prevent overshoot if dt is too large
		const f = Math.min(1.0, this.lerpFactor * dtSec);

		this.currentOffset.x += (this.targetOffset.x - this.currentOffset.x) * f;
		this.currentOffset.y += (this.targetOffset.y - this.currentOffset.y) * f;
		this.currentZoomExp += (this.targetZoomExp - this.currentZoomExp) * f;

		// Handle angular interpolation
		const rotDiff = MathUtils.normalizeAngle(this.targetRotation - this.currentRotation);
		this.currentRotation += rotDiff * f;
		this.currentRotation = MathUtils.normalizeAngle(this.currentRotation);
	}

	getRenderState() {
		return {
			basis: this.trackingTarget,
			cameraOffset: this.currentOffset,
			zoomScale: Math.pow(10, this.currentZoomExp),
			zoomExp: this.currentZoomExp,
			rotation: this.currentRotation
		};
	}
}
