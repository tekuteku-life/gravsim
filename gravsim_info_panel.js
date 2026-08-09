
// gravsim_info_panel.js

import {
	YEARS_PER_SECOND,
	UI_INFO_PANEL_UPDATA_INTERVAL,
} from './gravsim_const.js';

/*******************************************************************
 * InfoPanel class that manages the information panel.
*******************************************************************/
export class InfoPanel {
	constructor() {
		this.panel = document.getElementById('info-panel');
		if (!this.panel) {
			throw new Error("Info panel element with id 'info-panel' not found.");
		}

		this.ui = {
			elapsed: document.getElementById('elapsed-time'),
			count: document.getElementById('object-count'),
			fps: document.getElementById('fps')
		};

		this.elapsedTime = 0; // in years
		this.lastTime = new Date();
		this.fpsCount = 0;
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		this.elapsedTime += dt / YEARS_PER_SECOND;
		if (this.ui.elapsed) {
			const y = Math.floor(this.elapsedTime);
			const d = Math.floor((this.elapsedTime - y) * 365.25);
			this.ui.elapsed.textContent = `${y} yr, ${String(d).padStart(3, '0')} d`;
		}
	}

	updateObjectCount(counts) {
		if (this.ui.count) {
			this.ui.count.textContent = `${counts}`;
		}
	}

	updateFPS() {
		if (!this.ui.fps) {
			console.error("FPS element with id 'fps' not found.");
			return;
		}

		const now = new Date();
		const elapsed = now - this.lastTime;

		this.fpsCount++;
		if (elapsed >= UI_INFO_PANEL_UPDATA_INTERVAL) {
			const fps = (this.fpsCount / (elapsed / 1e3)).toFixed(1);
			this.ui.fps.textContent = `${fps}`;

			this.lastTime = now;
			this.fpsCount = 0;
		}
	}
}
