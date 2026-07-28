
// gravsim_control_panel.js

import { DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

/*******************************************************************
 * ControlPanel class that manages the simulation control panel UI.
 *******************************************************************/
export class ControlPanel {
	constructor(universe) {
		this.universe = universe;
		this.lastTouchDist = null;

		this._initElements();
		this._bindEvents();
		
		this.generateMassSelect();
	}

	// Initialize and cache DOM elements
	_initElements() {
		this.ui = {
			timeScale: document.getElementById('time-scale'),
			timeIndicator: document.getElementById('time-scale-indicator'),
			zoomScale: document.getElementById('zoom-scale'),
			zoomIndicator: document.getElementById('zoom-scale-indicator'),
			massSelect: document.getElementById('mass-select'),
			centerSelect: document.getElementById('center-select'),
			moonBtn: document.getElementById('put-moon-btn')
		};

		// Map for dynamic button bindings
		this.deployButtons = {
			'put-saturn-btn': 'Saturn',
			'put-jupiter-btn': 'Jupiter',
			'put-mars-btn': 'Mars',
			'put-earth-btn': 'Earth',
			'put-venus-btn': 'Venus',
			'put-mercury-btn': 'Mercury'
		};
	}

	// Bind all event listeners
	_bindEvents() {
		// UI Controls
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

		// Orbital deploy buttons (Loop instead of repeating code)
		for (const [btnId, objName] of Object.entries(this.deployButtons)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => this.universe.ObjectPlacer.placeAtOrbitAroundSun(objName));
			}
		}
		if (this.ui.moonBtn) {
			this.ui.moonBtn.addEventListener('click', () => this._deployMoon());
		}

		// Canvas Zoom Events (Wheel & Touch)
		const canvas = this.universe.canvas;
		canvas.addEventListener('wheel', (e) => this._handleWheelZoom(e));
		canvas.addEventListener('touchmove', (e) => this._handleTouchZoom(e));
		canvas.addEventListener('touchend', (e) => this._resetTouchDist(e));
		canvas.addEventListener('touchcancel', () => this._resetTouchDist(null));
	}


	// ==========================================
	// Event Handlers (Private logic)
	// ==========================================

	_onCenterChanged(e) {
		const targetId = parseInt(e.target.value, 10);
		const targetObj = this.universe.objects.find(obj => obj.id === targetId);
		if (targetObj) {
			this.universe.centerObject = targetObj;
		}
	}

	_deployMoon() {
		try {
			this.universe.ObjectPlacer.placeAtOrbitAroundHost("Earth", "Moon");
		} catch (err) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Earth");
			this.universe.ObjectPlacer.placeAtOrbitAroundHost("Earth", "Moon");
		}
	}

	_handleWheelZoom(e) {
		e.preventDefault();
		let step = this.getZoomStep();
		step = (e.deltaY < 0) ? step : -step;
		this.setZoomScaleByStep(step);
	}

	_handleTouchZoom(e) {
		if (e.touches.length === 2) {
			e.preventDefault();
			const dx = e.touches[0].clientX - e.touches[1].clientX;
			const dy = e.touches[0].clientY - e.touches[1].clientY;
			const dist = Math.sqrt(dx * dx + dy * dy);

			if (this.lastTouchDist !== null) {
				const delta = dist - this.lastTouchDist;
				let step = this.getZoomStep() || 0.1;
				step = (delta > 0 ? step : -step) * Math.abs(delta) * 0.05;
				this.setZoomScaleByStep(step);
			}
			this.lastTouchDist = dist;
		}
	}

	_resetTouchDist(e) {
		if (!e || e.touches.length < 2) {
			this.lastTouchDist = null;
		}
	}


	// ==========================================
	// Public UI Update Methods
	// ==========================================

	updateCenterOptions() {
		if (!this.ui.centerSelect || !this.universe.centerObject) return;
		
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
		if (this.ui.timeIndicator) {
			if (val < 0.01) {
				this.ui.timeIndicator.textContent = val.toExponential(2);
			} else {
				this.ui.timeIndicator.textContent = val.toFixed(3);
			}
		}
	}

	updateZoomScaleIndicator(val) {
		if (this.ui.zoomIndicator) {
			if (val < 0.1 || val > 1000) {
				this.ui.zoomIndicator.textContent = val.toExponential(2);
			} else {
				this.ui.zoomIndicator.textContent = val.toFixed(2);
			}
		}
	}

	generateMassSelect() {
		if(!this.ui.massSelect) { return; }

		this.ui.massSelect.innerHTML = '';
		for (const key in DEFAULT_OBJECT_PARAMS) {
			const param = DEFAULT_OBJECT_PARAMS[key];
			const option = document.createElement('option');
			option.value = key;
			option.textContent = `${param.NAME} (mass: ${param.MASS.toExponential(2)} t)`;
			this.ui.massSelect.appendChild(option);

			if (param.NAME === "Rocket") {
				option.selected = true;
			}
		}
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
}
