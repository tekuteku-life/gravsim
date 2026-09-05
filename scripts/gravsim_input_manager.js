
// gravsim_input_manager.js

import { UI } from './gravsim_const.js';
import { EventBus } from './gravsim_event_bus.js';

export class InputManager {
	constructor(canvas) {
		this.canvas = canvas;

		this.isPanning = false;
		this.hasPanned = false;
		this.lastPanPos = { x: 0, y: 0 };
		this.isDragging = false;

		this.lastTouchDist = null;
		this.lastTouchCenter = null;

		this.lastRightClickTime = 0;
		this.lastTwoFingerTapTime = 0;

		this._bindEvents();
	}

	_isDeployTabActive() {
		const deployTab = document.getElementById('tab-deploy');
		return deployTab && deployTab.classList.contains('active');
	}

	_bindEvents() {
		// --- Events for PC (Mouse) ---
		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.hasPanned = false;
		});

		this.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			EventBus.emit('input:zoom-wheel', e.deltaY < 0 ? 1 : -1);
		});

		this.canvas.addEventListener('mousedown', (e) => {
			if (e.button === 1 || e.button === 2) {
				this.isPanning = true;
				this.hasPanned = false;
				this.lastPanPos = { x: e.clientX, y: e.clientY };
			} else if (e.button === 0) {
				if (this._isDeployTabActive()) {
					this.isDragging = true;
					EventBus.emit('input:drag-start', e.clientX, e.clientY);
				}
			}
		});

		this.canvas.addEventListener('mousemove', (e) => {
			if (this.isPanning) {
				const dx = e.clientX - this.lastPanPos.x;
				const dy = e.clientY - this.lastPanPos.y;
				if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
					this.hasPanned = true;
					EventBus.emit('input:pan', dx, dy);
					this.lastPanPos = { x: e.clientX, y: e.clientY };
				}
			} else if (this.isDragging) {
				EventBus.emit('input:drag-move', e.clientX, e.clientY);
			}
		});

		this.canvas.addEventListener('mouseup', (e) => {
			if (e.button === 1 || e.button === 2) {
				this.isPanning = false;
				if (e.button === 2) {
					const now = Date.now();
					// Only treat as double-tap reset if the user did not drag/pan
					if (!this.hasPanned && (now - this.lastRightClickTime < UI.DOUBLE_TAP_DURATION)) {
						EventBus.emit('input:reset-offset');
						this.lastRightClickTime = 0;
					} else {
						this.lastRightClickTime = this.hasPanned ? 0 : now;
					}
				}
			} else if (e.button === 0) {
				if (this.isDragging) {
					this.isDragging = false;
					EventBus.emit('input:drag-end', e.clientX, e.clientY);
				}
			}
		});

		this.canvas.addEventListener('mouseleave', () => {
			this.isPanning = false;
			if (this.isDragging) {
				this.isDragging = false;
				EventBus.emit('input:drag-cancel');
			}
		});

		// --- Events for smart phone ---
		this.canvas.addEventListener('touchstart', (e) => {
			if (e.touches.length === 2) {
				// Cancel dragging if two fingers
				if (this.isDragging) {
					this.isDragging = false;
					EventBus.emit('input:drag-cancel');
				}
				const now = Date.now();
				if (now - this.lastTwoFingerTapTime < UI.DOUBLE_TAP_DURATION) {
					EventBus.emit('input:reset-offset');
					this.lastTwoFingerTapTime = 0;
				} else {
					this.lastTwoFingerTapTime = now;
				}
			} else if (e.touches.length === 1) {
				if (this._isDeployTabActive()) {
					this.isDragging = true;
					const touch = e.touches[0];
					EventBus.emit('input:drag-start', touch.clientX, touch.clientY);
				}
			}
		}, { passive: false });

		this.canvas.addEventListener('touchmove', (e) => {
			if (e.touches.length === 2) {
				e.preventDefault();
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];

				const dx = touch1.clientX - touch2.clientX;
				const dy = touch1.clientY - touch2.clientY;
				const dist = Math.sqrt(dx * dx + dy * dy);
				const cx = (touch1.clientX + touch2.clientX) / 2;
				const cy = (touch1.clientY + touch2.clientY) / 2;

				if (this.lastTouchDist !== null && this.lastTouchCenter !== null) {
					const delta = dist - this.lastTouchDist;
					EventBus.emit('input:zoom-touch', delta);

					const panX = cx - this.lastTouchCenter.x;
					const panY = cy - this.lastTouchCenter.y;

					if (Math.abs(panX) > 2 || Math.abs(panY) > 2) {
						this.hasPanned = true;
						if (panX !== 0 || panY !== 0) {
							EventBus.emit('input:pan', panX, panY);
						}
					}
				}

				this.lastTouchDist = dist;
				this.lastTouchCenter = { x: cx, y: cy };
			} else if (e.touches.length === 1 && this.isDragging) {
				const touch = e.touches[0];
				EventBus.emit('input:drag-move', touch.clientX, touch.clientY);
			}
		}, { passive: false });

		this.canvas.addEventListener('touchend', (e) => {
			if (e.touches.length < 2) {
				this.lastTouchDist = null;
				this.lastTouchCenter = null;
			}
			if (e.touches.length === 0) {
				if (this.isDragging) {
					this.isDragging = false;
					const touch = e.changedTouches[0];
					EventBus.emit('input:drag-end', touch.clientX, touch.clientY);
				}
			}
		});

		this.canvas.addEventListener('touchcancel', () => {
			this.lastTouchDist = null;
			this.lastTouchCenter = null;
			if (this.isDragging) {
				this.isDragging = false;
				EventBus.emit('input:drag-cancel');
			}
		});
	}
}
