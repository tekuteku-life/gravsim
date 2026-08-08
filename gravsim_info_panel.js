// gravsim_info_panel.js

import { YEARS_PER_SECOND } from './gravsim_const.js';

/*******************************************************************
 * InfoPanel class that manages the information panel.
 * @property {HTMLElement} panel - The HTML element for the info panel.
 * @property {number} elapsedTime - The elapsed time in years.
*******************************************************************/
export class InfoPanel {
	constructor() {
		this.panel = document.getElementById('info-panel');
		if (!this.panel) {
			throw new Error("Info panel element with id 'info-panel' not found.");
		}

		this.elapsedTime = 0; // in years
		this.lastTime = new Date();
		this.fpsCount = 0;
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		const elapsedTimeSpan = document.getElementById('elapsed-time');
		this.elapsedTime += dt / YEARS_PER_SECOND;
		if (elapsedTimeSpan) {
			const y = Math.floor(this.elapsedTime);
			const d = Math.floor((this.elapsedTime - y) * 365.25);
			elapsedTimeSpan.textContent = `${y} yr, ${String(d).padStart(3, '0')} d`;
		}
	}

	updateObjectCount(counts) {
		const objectCountSpan = document.getElementById('object-count');
		if( objectCountSpan ) {
			objectCountSpan.textContent = `${counts}`;
		}
	}

	updateFPS() {
		const fpsSpan = document.getElementById('fps');
		if (!fpsSpan) {
			console.error("FPS element with id 'fps' not found.");
			return;
		}

		const now = new Date();
		const elapsed = now - this.lastTime;

		this.fpsCount++;
		if( elapsed >= 500 ) {
			const fps = (this.fpsCount / (elapsed / 1e3)).toFixed(1);
			fpsSpan.textContent = `${fps}`;
			
			this.lastTime = now;
			this.fpsCount = 0;
		}
	}
}
