
// gravsim_tab_system.js

import { PHYSICS, RENDER, SIMULATION } from './gravsim_const.js';
import { DOMUtils } from './gravsim_utils.js';

export class SystemTab {
	constructor(universe) {
		this.universe = universe;
		this._initElements();
		this._bindEvents();

		// Subscribe to object list changes
		this.universe.on('object-list-changed', () => {
			this.updateCenterOptions();
		});

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
		DOMUtils.verifyElements(this.ui, 'SystemTab');
	}

	_bindEvents() {
		this.ui.timeScale.addEventListener('input', () => this.updateTimeScaleIndicator(this.getTimeScale()));
		this.ui.zoomScale.addEventListener('input', () => this.updateZoomScaleIndicator(this.getZoomScale()));
		this.ui.centerSelect.addEventListener('change', (e) => this._onCenterChanged(e));
	}

	_onCenterChanged(e) {
		const targetId = parseInt(e.target.value, 10);
		const targetObj = this.universe.objects.find(obj => obj.id === targetId);
		if (targetObj) {
			this.universe.centerObject = targetObj;
		}
	}

	updateCenterOptions() {
		if (!this.universe.centerObject) { return; }

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
		const yearsPerSec = (1000 / SIMULATION.TIME_SCALE) * val;
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

		DOMUtils.setText(this.ui.timeIndicator, text);
		this.universe.InfoPanel.updateTimeScale(text);
	}

	updateZoomScaleIndicator(val) {
		const auPer100Px = 100 / (val * RENDER.DISTANCE_SCALE);
		const kmPer100Px = auPer100Px * (PHYSICS.METERS_PER_AU / 1000);
		let text = "";

		if (auPer100Px >= 0.1) {
			text = `${auPer100Px >= 10 ? Math.round(auPer100Px).toLocaleString('en-US') : auPer100Px.toFixed(2)} AU/100px`;
		} else if (kmPer100Px >= 1) {
			text = `${kmPer100Px >= 10 ? Math.round(kmPer100Px).toLocaleString('en-US') : kmPer100Px.toFixed(2)} km/100px`;
		} else {
			const mPer100Px = kmPer100Px * 1000;
			text = `${mPer100Px >= 10 ? Math.round(mPer100Px).toLocaleString('en-US') : mPer100Px.toFixed(2)} m/100px`;
		}

		DOMUtils.setText(this.ui.zoomIndicator, text);
		this.universe.InfoPanel.updateZoomScale(text);
	}

	getTimeScale() {
		const exp = parseFloat(this.ui.timeScale.value);
		return Math.pow(10, exp);
	}

	getZoomScale() {
		const exp = parseFloat(this.ui.zoomScale.value);
		return Math.pow(10, exp);
	}

	getZoomStep() {
		return parseFloat(this.ui.zoomScale.step) || 0.1;
	}

	getState() {
		return {
			timeScaleVal: parseFloat(this.ui.timeScale.value),
			zoomScaleVal: parseFloat(this.ui.zoomScale.value),
		};
	}

	loadState(cpState) {
		if (!cpState) { return; }

		if (cpState.timeScaleVal !== undefined) {
			this.ui.timeScale.value = cpState.timeScaleVal;
			this.updateTimeScaleIndicator(this.getTimeScale());
		}
		if (cpState.zoomScaleVal !== undefined) {
			this.ui.zoomScale.value = cpState.zoomScaleVal;
			this.updateZoomScaleIndicator(this.getZoomScale());
			this.universe.updateZoomScale();
		}
		this.updateCenterOptions();
	}
}
