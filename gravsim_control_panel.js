
// gravsim_control_panel.js

import { DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

/*******************************************************************
 * ControlPanel class that manages the simulation control panel UI.
 * 
 * @property {HTMLInputElement} timeScaleInput - The input element for adjusting the simulation time scale.
 * @property {HTMLElement} timeScaleIndicator - The element displaying the current time scale value.
 * @property {HTMLSelectElement} massSelect - The select element for choosing the type of object to place.
*******************************************************************/
export class ControlPanel {
	constructor(universe) {
		this.universe = universe;

		this.timeScaleInput = document.getElementById('time-scale');
		this.timeScaleIndicator = document.getElementById('time-scale-indicator');
		this.zoomScaleInput = document.getElementById('zoom-scale');
		this.zoomScaleIndicator = document.getElementById('zoom-scale-indicator');
		this.massSelect = document.getElementById('mass-select');

		this.generateMassSelect();
	
		this.timeScaleInput.addEventListener('input', function(e) {
			this.updateTimeScaleIndicator(this.getTimeScale());
		}.bind(this));
	
		this.zoomScaleInput.addEventListener('input', function(e) {
			this.updateZoomScaleIndicator(this.getZoomScale());
		}.bind(this));

		this.universe.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			let step = this.getZoomStep();
			step = (e.deltaY < 0) ? step : -step;
			this.setZoomScaleByStep(step);
		});

		this.lastTouchDist = null;
		this.universe.canvas.addEventListener('touchmove', (e) => {
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
		});
		this.universe.canvas.addEventListener('touchend', (e) => {
			if (e.touches.length < 2) {
				this.lastTouchDist = null;
			}
		});
		this.universe.canvas.addEventListener('touchcancel', () => {
			this.lastTouchDist = null;
		});
		
		document.getElementById('put-saturn-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Saturn");
		}.bind(this));
		document.getElementById('put-jupiter-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Jupiter");
		}.bind(this));
		document.getElementById('put-earth-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Earth");
		}.bind(this));
		document.getElementById('put-venus-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Venus");
		}.bind(this));
		document.getElementById('put-mars-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Mars");
		}.bind(this));
		document.getElementById('put-mercury-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Mercury");
		}.bind(this));
	}

	setZoomScaleByStep(step) {
		let val = this.getZoomScale();
		const max = this.zoomScaleInput.max;
		const min = this.zoomScaleInput.min;
		val += step;
		if( val > max ) { val = max *1.0; }
		else if( val < min ) { val = min *1.0; }
		this.zoomScaleInput.value = val.toFixed(2);
		this.updateZoomScaleIndicator(val);
		this.universe.updateZoomScale();
	}

	updateTimeScaleIndicator(val) {
		if (this.timeScaleIndicator) {
			this.timeScaleIndicator.textContent = parseFloat(val).toFixed(2);
		}
	}

	updateZoomScaleIndicator(val) {
		if (this.zoomScaleIndicator) {
			this.zoomScaleIndicator.textContent = parseFloat(val).toFixed(2);
		}
	}

	generateMassSelect() {
		if(!this.massSelect) {
			return;
		}

		this.massSelect.innerHTML = '';
		for (const key in DEFAULT_OBJECT_PARAMS) {
			const param = DEFAULT_OBJECT_PARAMS[key];
			const option = document.createElement('option');
			option.value = key;
			option.textContent = `${param.NAME} (mass: ${param.MASS.toExponential(2)} t)`;
			this.massSelect.appendChild(option);

			if (param.NAME === "Rocket") {
				option.selected = true;
			}
		}
	}

	getTimeScale() {
		if (this.timeScaleInput) {
			return parseFloat(this.timeScaleInput.value);
		}
		return 0.1; // Default time scale
	}

	getZoomScale() {
		if (this.zoomScaleInput) {
			return parseFloat(this.zoomScaleInput.value);
		}
		return 1; // Default zoom scale
	}

	getZoomStep() {
		return parseFloat(this.zoomScaleInput.step) || 0.1;
	}
}
