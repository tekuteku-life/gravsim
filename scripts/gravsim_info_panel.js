
// gravsim_info_panel.js

import { UI, EVENT_PRIORITY } from './gravsim_const.js';
import { DOMUtils, FormatUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

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
		this.physFpsCount = 0;

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
		EventBus.on('object-list-changed', (count) => {
			this.updateObjectCount(count);
		});

		// Subscribe to Physics updates to measure worker FPS
		EventBus.on('physics-updated', () => {
			this.physFpsCount++;
		});

		// Subscribe to camera and system UI updates
		EventBus.on('camera:set-tracking-target', (target) => {
			this.updateCamera(target ? target.name : 'None');
		});
		EventBus.on('simulation:set-time-scale-text', (text) => this.updateTimeScale(text));
		EventBus.on('camera:set-zoom-text', (text) => this.updateZoomScale(text));

		// Register to the main logic update loop
		EventBus.onUpdate((dt, scaledDt) => {
			if (this.universe.objects.length === 1) {
				this.resetElapsedTime();
			} else {
				this.updateElapsedTime(scaledDt);
			}
			this.updateFPS();
		}, EVENT_PRIORITY.UI);
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		this.elapsedTime += UnitConvertUtils.sec2year(dt);
		DOMUtils.setText(this.ui.elapsed, FormatUtils.timeYearsDays(this.elapsedTime));
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
			const physFps = (this.physFpsCount / (elapsed / 1e3)).toFixed(1);

			DOMUtils.setText(this.ui.fps, `${fps} / ${physFps}`);

			this.lastTime = now;
			this.fpsCount = 0;
			this.physFpsCount = 0;
		}
	}
}
