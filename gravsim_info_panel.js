
// gravsim_info_panel.js

import { PHYSICS, UI } from './gravsim_const.js';
import { DOMUtils } from './gravsim_utils.js';

/*******************************************************************
 * InfoPanel class that manages the information panel.
*******************************************************************/
export class InfoPanel {
	constructor(universe) {
		this.universe = universe;
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
		DOMUtils.verifyElements(this.ui, 'InfoPanel');

		// Subscribe to object list changes
		this.universe.on('object-list-changed', (count) => {
			this.updateObjectCount(count);
		});
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		this.elapsedTime += dt / PHYSICS.YEARS_PER_SECOND;
		const y = Math.floor(this.elapsedTime);
		const d = Math.floor((this.elapsedTime - y) * 365.25);
		DOMUtils.setText(this.ui.elapsed, `${y} yr, ${String(d).padStart(3, '0')} d`);
	}

	updateTimeScale(text) {
		DOMUtils.setText(this.ui.time, text);
	}
	updateZoomScale(text) {
		DOMUtils.setText(this.ui.zoom, text);
	}
	updateCamera(name) {
		DOMUtils.setText(this.ui.camera, name);
	}
	updateObjectCount(counts) {
		DOMUtils.setText(this.ui.count, counts.toString());
	}

	updateFPS() {
		const now = new Date();
		const elapsed = now - this.lastTime;
		this.fpsCount++;
		// Keep local interval check because frame counting is required
		if (elapsed >= UI.UPDATE_INTERVAL.INFO_PANEL) {
			const fps = (this.fpsCount / (elapsed / 1e3)).toFixed(1);
			DOMUtils.setText(this.ui.fps, fps);
			this.lastTime = now;
			this.fpsCount = 0;
		}
	}
}
