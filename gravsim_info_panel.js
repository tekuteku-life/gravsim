
// gravsim_info_panel.js

import { PHYSICS, UI } from './gravsim_const.js';

/*******************************************************************
 * InfoPanel class that manages the information panel.
*******************************************************************/
export class InfoPanel {
	constructor() {
		this.panel = document.getElementById('info-panel');
		if (!this.panel) {
			throw new Error("Info panel element not found.");
		}

		this.elapsedTime = 0; // in years
		this.lastTime = new Date();
		this.fpsCount = 0;

		this.ui = {
			elapsed: document.getElementById('info-elapsed'),
			time: document.getElementById('info-time'),
			zoom: document.getElementById('info-zoom'),
			camera: document.getElementById('info-camera'),
			fps: document.getElementById('info-fps'),
			count: document.getElementById('info-count')
		};
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		this.elapsedTime += dt / PHYSICS.YEARS_PER_SECOND;
		if (this.ui.elapsed) {
			const y = Math.floor(this.elapsedTime);
			const d = Math.floor((this.elapsedTime - y) * 365.25);
			this.ui.elapsed.textContent = `${y} yr, ${String(d).padStart(3, '0')} d`;
		}
	}

	updateTimeScale(text) {
		if (this.ui.time) { this.ui.time.textContent = text; }
	}
	updateZoomScale(text) {
		if (this.ui.zoom) { this.ui.zoom.textContent = text; }
	}
	updateCamera(name) {
		if (this.ui.camera) { this.ui.camera.textContent = name; }
	}
	updateObjectCount(counts) {
		if (this.ui.count) { this.ui.count.textContent = counts; }
	}

	updateFPS() {
		const now = new Date();
		const elapsed = now - this.lastTime;
		this.fpsCount++;
		if (elapsed >= UI.UPDATE_INTERVAL.INFO_PANEL) {
			const fps = (this.fpsCount / (elapsed / 1e3)).toFixed(1);
			if (this.ui.fps) {
				this.ui.fps.textContent = fps;
			}
			this.lastTime = now;
			this.fpsCount = 0;
		}
	}
}
