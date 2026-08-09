
// gravsim_tab_system.js

import { DISTANCE_SCALE, METERS_PER_AU, TIME_SCALE } from './gravsim_const.js';

export class SystemTab {
	constructor(universe) {
		this.universe = universe;
		this._initElements();
		this._bindEvents();

		this.updateTimeScaleIndicator(this.getTimeScale());
		this.updateZoomScaleIndicator(this.getZoomScale());
	}

	_initElements() {
		this.ui = {
			timeScale: document.getElementById('time-scale'),
			timeIndicator: document.getElementById('time-scale-indicator'),
			zoomScale: document.getElementById('zoom-scale'),
			zoomIndicator: document.getElementById('zoom-scale-indicator'),
			centerSelect: document.getElementById('center-select')
		};
	}

	_bindEvents() {
		if (this.ui.timeScale) {
			this.ui.timeScale.addEventListener('input', () => this.updateTimeScaleIndicator(this.getTimeScale()));
		}
		if (this.ui.zoomScale) {
			this.ui.zoomScale.addEventListener('input', () => this.updateZoomScaleIndicator(this.getZoomScale()));
		}
		if (this.ui.centerSelect) {
			this.ui.centerSelect.addEventListener('focus', () => this.updateCenterOptions());
			this.ui.centerSelect.addEventListener('change', (e) => this._onCenterChanged(e));
			setTimeout(() => this.updateCenterOptions(), 100);
		}
	}

	_onCenterChanged(e) {
		const targetId = parseInt(e.target.value, 10);
		const targetObj = this.universe.objects.find(obj => obj.id === targetId);
		if (targetObj) {
			this.universe.centerObject = targetObj;
		}
	}

	updateCenterOptions() {
		if (!this.ui.centerSelect || !this.universe.centerObject) { return; }

		this.ui.centerSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			if (obj.id === this.universe.centerObject.id) {
				option.selected = true;
			}
			this.ui.centerSelect.appendChild(option);
		}
	}

	setZoomScaleByStep(step) {
		let currentExp = parseFloat(this.ui.zoomScale.value);
		const max = parseFloat(this.ui.zoomScale.max);
		const min = parseFloat(this.ui.zoomScale.min);

		currentExp += step;
		if (currentExp > max) { currentExp = max; }
		else if (currentExp < min) { currentExp = min; }

		this.ui.zoomScale.value = currentExp.toFixed(2);

		const realZoom = Math.pow(10, currentExp);
		this.updateZoomScaleIndicator(realZoom);
		this.universe.updateZoomScale();
	}

	updateTimeScaleIndicator(val) {
		if (!this.ui.timeIndicator) { return; }

		const yearsPerSec = (1000 / TIME_SCALE) * val;
		let text = "";

		if (yearsPerSec >= 1) {
			text = `${yearsPerSec >= 10 ? Math.round(yearsPerSec).toLocaleString('en-US') : yearsPerSec.toFixed(2)} year/sec`;
		} else if (yearsPerSec * 12 >= 1) {
			text = `${(yearsPerSec * 12).toFixed(2)} mon/sec`;
		} else if (yearsPerSec * 365.25 >= 1) {
			text = `${(yearsPerSec * 365.25).toFixed(2)} day/sec`;
		} else if (yearsPerSec * 365.25 * 24 >= 1) {
			text = `${(yearsPerSec * 365.25 * 24).toFixed(2)} hr/sec`;
		} else if (yearsPerSec * 365.25 * 24 * 60 >= 1) {
			text = `${(yearsPerSec * 365.25 * 24 * 60).toFixed(2)} min/sec`;
		} else {
			const secPerSec = yearsPerSec * 365.25 * 24 * 60 * 60;
			text = `${secPerSec >= 10 ? Math.round(secPerSec).toLocaleString('en-US') : secPerSec.toFixed(2)} sec/sec`;
		}

		this.ui.timeIndicator.textContent = text;
		this.universe.InfoPanel.updateTimeScale(text);
	}

	updateZoomScaleIndicator(val) {
		if (!this.ui.zoomIndicator) { return; }

		const auPer100Px = 100 / (val * DISTANCE_SCALE);
		const kmPer100Px = auPer100Px * (METERS_PER_AU / 1000);
		let text = "";

		if (auPer100Px >= 0.1) {
			text = `${auPer100Px >= 10 ? Math.round(auPer100Px).toLocaleString('en-US') : auPer100Px.toFixed(2)} AU/100px`;
		} else if (kmPer100Px >= 1) {
			text = `${kmPer100Px >= 10 ? Math.round(kmPer100Px).toLocaleString('en-US') : kmPer100Px.toFixed(2)} km/100px`;
		} else {
			const mPer100Px = kmPer100Px * 1000;
			text = `${mPer100Px >= 10 ? Math.round(mPer100Px).toLocaleString('en-US') : mPer100Px.toFixed(2)} m/100px`;
		}

		this.ui.zoomIndicator.textContent = text;
		this.universe.InfoPanel.updateZoomScale(text);
	}

	getTimeScale() {
		if (this.ui.timeScale) {
			const exp = parseFloat(this.ui.timeScale.value);
			return Math.pow(10, exp);
		}
		return 0.1;
	}

	getZoomScale() {
		if (this.ui.zoomScale) {
			const exp = parseFloat(this.ui.zoomScale.value);
			return Math.pow(10, exp);
		}
		return 1;
	}

	getZoomStep() {
		return parseFloat(this.ui.zoomScale.step) || 0.1;
	}

	getState() {
		return {
			timeScaleVal: this.ui.timeScale ? parseFloat(this.ui.timeScale.value) : -1,
			zoomScaleVal: this.ui.zoomScale ? parseFloat(this.ui.zoomScale.value) : 0,
		};
	}

	loadState(cpState) {
		if (!cpState) { return; }

		if (cpState.timeScaleVal !== undefined && this.ui.timeScale) {
			this.ui.timeScale.value = cpState.timeScaleVal;
			this.updateTimeScaleIndicator(this.getTimeScale());
		}
		if (cpState.zoomScaleVal !== undefined && this.ui.zoomScale) {
			this.ui.zoomScale.value = cpState.zoomScaleVal;
			this.updateZoomScaleIndicator(this.getZoomScale());
			this.universe.updateZoomScale();
		}
		this.updateCenterOptions();
	}
}
