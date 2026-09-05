
// gravsim_camera.js

import { MathUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';
import { ROCKET_LAUNCHER_CONFIG } from './gravsim_const.js';

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

		this._bindEvents();
	}

	_bindEvents() {
		EventBus.on('input:pan', (dx, dy) => this.addPan(dx, dy));
		EventBus.on('input:reset-offset', () => this.setTargetOffset(0, 0));

		EventBus.on('camera:set-tracking-target', (target) => this.setTrackingTarget(target));
		EventBus.on('camera:set-target-zoom-exp', (exp) => this.setTargetZoomExp(exp));
		EventBus.on('camera:set-target-offset', (x, y) => this.setTargetOffset(x, y));
		EventBus.on('camera:set-auto-tracking', (target, host) => this.setAutoTracking(target, host));
		EventBus.on('camera:stop-auto-tracking', (fallbackHost) => this.stopAutoTracking(fallbackHost));
		EventBus.on('camera:fit-to-target', (target) => this.fitToTarget(target));
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
		// Stop auto tracking when user manually pans the camera
		if (this.autoTrackHost) {
			this.stopAutoTracking();
		}

		const currentZoom = Math.pow(10, this.currentZoomExp);

		// Renderer applies ctx.rotate(currentRotation) before translating,
		// so use -currentRotation to map screen-space pan vector back to camera local space
		const angle = -this.currentRotation;
		const cosA = Math.cos(angle);
		const sinA = Math.sin(angle);

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
	}

	fitToTarget(target) {
		if (!target) { return; }
		this.setTrackingTarget(target);
		this.setTargetRotation(0);

		// Calculate zoom to fit host gracefully
		const radiusPx = UnitConvertUtils.m2pix(target.radius);
		const targetSize = Math.min(window.innerWidth, window.innerHeight) / 2.2;
		let idealExp = Math.log10(targetSize / radiusPx);
		idealExp = Math.max(this.minZoomExp, Math.min(this.maxZoomExp, idealExp));

		this.setTargetZoomExp(idealExp);

		// Sync UI slider
		EventBus.emit('camera:zoom-changed', idealExp);
	}

	_autoTracking() {
		if (!this.autoTrackHost || !this.trackingTarget) { return; }

		const rocket = this.trackingTarget;
		const host = this.autoTrackHost;

		const dx = rocket.x - host.x;
		const dy = rocket.y - host.y;

		const distM = UnitConvertUtils.pix2m(Math.sqrt(dx * dx + dy * dy));
		const altM = distM - host.radius;
		const canvasHeight = window.innerHeight;

		// Tracking phases configurations
		const ALT_PHASE1 = ROCKET_LAUNCHER_CONFIG.TRACKING.ALT_PHASE1; // m
		const ALT_PHASE2 = ROCKET_LAUNCHER_CONFIG.TRACKING.ALT_PHASE2; // m
		const ALT_PHASE3 = ROCKET_LAUNCHER_CONFIG.TRACKING.ALT_PHASE3; // m

		const groundScreenDistY = canvasHeight * ROCKET_LAUNCHER_CONFIG.TRACKING.GROUND_HEIGHT_RATIO;
		const maxOffsetY_px = canvasHeight * ROCKET_LAUNCHER_CONFIG.TRACKING.MAX_HEIGHT_RATIO;

		let targetZoom = 1;
		let targetOffsetY_px = 0;

		// Base angle (ground is at the bottom)
		const groundLockAngle = -Math.atan2(dy, dx) - Math.PI / 2;
		let targetRotation = groundLockAngle;

		if (altM <= ALT_PHASE1) {
			// Phase 1: Lift-off
			// Keep center, keep zoom, keep ground lock
			targetOffsetY_px = 0;
			targetZoom = groundScreenDistY / UnitConvertUtils.m2pix(ALT_PHASE1);
		} else if (altM <= ALT_PHASE2) {
			// Phase 2: Ascending
			// Shift offset upwards, zoom out slightly to keep ground
			const progress = (altM - ALT_PHASE1) / (ALT_PHASE2 - ALT_PHASE1);
			targetOffsetY_px = maxOffsetY_px * progress;
			targetZoom = (targetOffsetY_px + groundScreenDistY) / UnitConvertUtils.m2pix(altM);
		} else if (altM <= ALT_PHASE3) {
			// Phase 3: Transition to Orbit
			// Shift offset back to center, blend rotation to 0
			const progress = (altM - ALT_PHASE2) / (ALT_PHASE3 - ALT_PHASE2);
			targetOffsetY_px = maxOffsetY_px * (1.0 - progress);

			const normGroundAngle = MathUtils.normalizeAngle(groundLockAngle);
			targetRotation = normGroundAngle * (1.0 - progress);

			targetZoom = (targetOffsetY_px + groundScreenDistY) / UnitConvertUtils.m2pix(altM);
		} else {
			// Phase 4: Deep space
			// Keep center, keep absolute rotation, lock zoom to Phase 3 boundary
			targetOffsetY_px = 0;
			targetRotation = 0;
			targetZoom = groundScreenDistY / UnitConvertUtils.m2pix(ALT_PHASE3);
		}

		// Restrict zoom limits
		const minZoomScale = Math.pow(10, this.minZoomExp);
		const maxZoomScale = Math.pow(10, this.maxZoomExp);
		targetZoom = Math.max(minZoomScale, Math.min(maxZoomScale, targetZoom));

		const targetExp = Math.log10(targetZoom);
		this.setTargetZoomExp(targetExp);

		// Apply offset (Convert screen pixels to world scale relative to zoom)
		// Positive Y offset means camera focuses below the rocket, so rocket appears higher on screen
		this.setTargetOffset(0, targetOffsetY_px / targetZoom);
		this.setTargetRotation(targetRotation);

		// Sync UI slider during tracking
		EventBus.emit('camera:zoom-changed', targetExp);

		// Reached max altitude limit, stop tracking
		if (altM > host.radius * ROCKET_LAUNCHER_CONFIG.TRACKING.TRACKING_ATL_LIMIT_RATIO) {
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
