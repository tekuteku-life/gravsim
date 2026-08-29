
// gravsim_tab_system.js

import { PHYSICS, RENDER, SIMULATION, UI } from './gravsim_const.js';
import { DOMUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class SystemTab {
	constructor(universe) {
		this.universe = universe;
		this.isDebugModeEnabled = false;
		this._initElements();
		this._bindEvents();

		// Subscribe to object list changes
		EventBus.on('object-list-changed', () => {
			this.updateCenterOptions();
		});

		// Subscribe to camera tracking changes to update dropdown UI
		EventBus.on('camera:set-tracking-target', (targetObj) => {
			if (targetObj) {
				this.ui.centerSelect.value = targetObj.id;

				this.updateTimeScaleIndicator(this.getTimeScale());

				// Setup initial zoom indicator based on camera target
				this.updateZoomScaleIndicator(Math.pow(10, this.universe.camera.targetZoomExp));
			}
		});
	}

	_initElements() {
		this.ui = {
			timeScale: document.getElementById('time-scale'),
			timeIndicator: document.getElementById('time-scale-indicator'),
			zoomScale: document.getElementById('zoom-scale'),
			zoomIndicator: document.getElementById('zoom-scale-indicator'),
			centerSelect: document.getElementById('center-select'),
			
			pauseResumeBtn: document.getElementById('pause-resume-btn'),
			resetAllBtn: document.getElementById('reset-all-btn'),
			
			trailLength: document.getElementById('trail-length'),
			trailLengthVal: document.getElementById('trail-length-val'),
			showLabelsChk: document.getElementById('show-labels-chk'),
			showDebugChk: document.getElementById('show-debug-chk'),
			
			audioVoiceSelect: document.getElementById('audio-voice-select'),
			audioLoadingOverlay: document.getElementById('audio-loading-overlay'),
			
			clearDebrisChk: document.getElementById('clear-debris-chk'),
			clearRocketChk: document.getElementById('clear-rocket-chk'),
			clearCelestialChk: document.getElementById('clear-celestial-chk'),
			clearSelectedBtn: document.getElementById('clear-selected-btn'),

			debugSection: document.getElementById('debug-section'),
			enableMainProfilerChk: document.getElementById('enable-main-profiler-chk'),
			enableWorkerProfilerChk: document.getElementById('enable-worker-profiler-chk'),
		};
		DOMUtils.verifyElements(this.ui, 'SystemTab');
	}

	_bindEvents() {
		this.ui.timeScale.addEventListener('input', () => {
			const val = this.getTimeScale();
			EventBus.emit('simulation:set-time-scale', val);
			this.updateTimeScaleIndicator(val);
		});

		this.ui.zoomScale.addEventListener('input', (e) => {
			const exp = parseFloat(e.target.value);
			EventBus.emit('camera:set-target-zoom-exp', exp);
			this.updateZoomScaleIndicator(Math.pow(10, exp));
		});

		this.ui.centerSelect.addEventListener('change', (e) => this._onCenterChanged(e));

		// Simulation Control
		this.ui.pauseResumeBtn.addEventListener('click', () => {
			if (!this.universe.isPaused) {
				EventBus.emit('simulation:pause');
				DOMUtils.setText(this.ui.pauseResumeBtn, "Resume");
				this.ui.pauseResumeBtn.style.color = UI.BUTTON_COLOR.ACTIVE;
			} else {
				EventBus.emit('simulation:resume');
				DOMUtils.setText(this.ui.pauseResumeBtn, "Pause");
				this.ui.pauseResumeBtn.style.color = UI.BUTTON_COLOR.DEFAULT;
			}
		});

		this.ui.resetAllBtn.addEventListener('click', () => {
			if (confirm("Are you sure you want to reset the universe?")) {
				EventBus.emit('simulation:reset');
			}
		});

		// Display Options
		this.ui.trailLength.addEventListener('input', (e) => {
			const val = parseFloat(e.target.value);
			DOMUtils.setText(this.ui.trailLengthVal, val.toFixed(1));
			this.universe.trailLengthAU = val;
		});

		this.ui.showLabelsChk.addEventListener('change', (e) => {
			EventBus.emit('render:set-labels-visible', e.target.checked);
		});

		this.ui.showDebugChk.addEventListener('change', (e) => {
			EventBus.emit('render:set-debug-visible', e.target.checked);
		});

		// Bind Audio Selection
		this.ui.audioVoiceSelect.addEventListener('change', (e) => {
			const val = e.target.value;
			if (val === 'none') {
				EventBus.emit('audio:unload');
			} else {
				EventBus.emit('audio:load', val);
			}
		});

		// Clear Objects
		this.ui.clearSelectedBtn.addEventListener('click', () => {
			EventBus.emit('simulation:clear-objects', 
				this.ui.clearDebrisChk.checked,
				this.ui.clearRocketChk.checked,
				this.ui.clearCelestialChk.checked
			);
		});

		EventBus.on('input:zoom-wheel', (dir) => {
			let step = this.getZoomStep();
			step = (dir > 0) ? step : -step;
			this.setZoomScaleByStep(step);
		});

		EventBus.on('input:zoom-touch', (delta) => {
			let step = this.getZoomStep() || 0.1;
			step = (delta > 0 ? step : -step) * Math.abs(delta) * 0.05;
			this.setZoomScaleByStep(step);
		});

		EventBus.on('ui:set-controls-locked', (isLocked) => {
			this.ui.timeScale.disabled = isLocked;
			this.ui.pauseResumeBtn.disabled = isLocked;
			this.ui.resetAllBtn.disabled = isLocked;
		});

		EventBus.on('ui:set-time-scale', (val) => {
			this.ui.timeScale.value = val;
			const timeScaleVal = this.getTimeScale();
			EventBus.emit('simulation:set-time-scale', timeScaleVal);
			this.updateTimeScaleIndicator(timeScaleVal);
		});

		EventBus.on('ui:set-time-scale-min', () => {
			this.ui.timeScale.value = this.ui.timeScale.min;
			const val = this.getTimeScale();
			EventBus.emit('simulation:set-time-scale', val);
			this.updateTimeScaleIndicator(val);
		});

		EventBus.on('ui:set-loading-overlay', (isVisible) => {
			if (this.ui.audioLoadingOverlay) {
				this.ui.audioLoadingOverlay.style.display = isVisible ? 'flex' : 'none';
			}
		});

		// Synchronize UI from external camera zoom changes
		EventBus.on('camera:zoom-changed', (exp) => {
			const currentVal = parseFloat(this.ui.zoomScale.value);
			if (Math.abs(currentVal - exp) > 0.001) {
				this.ui.zoomScale.value = exp.toFixed(2);
				this.updateZoomScaleIndicator(Math.pow(10, exp));
			}
		});

		// Secret Developer Mode (7 clicks on System tab)
		const sysTabBtn = document.querySelector('.tab-btn[data-target="tab-sys"]');
		if (sysTabBtn) {
			let clickCount = 0; // count
			let lastClickTime = 0; // ms
			sysTabBtn.addEventListener('click', () => {
				const now = Date.now(); // ms
				if (now - lastClickTime > 500) {
					clickCount = 0;
				}
				clickCount++;
				lastClickTime = now;
				
				if (clickCount === 7) {
					this._enableDebugMode();
				}
			});
		}
	}

	_enableDebugMode() {
		if (this.isDebugModeEnabled) { return; }
		this.isDebugModeEnabled = true;

		EventBus.emit('debug:mode-on');
		console.info("Developer Debug Mode Enabled.");

		this.ui.debugSection.classList.add('active');

		let profilerInstance = null;

		this.ui.enableMainProfilerChk.addEventListener('change', async (e) => {
			const isEnabled = e.target.checked;
			if (isEnabled) {
				// Lazy load the profiler script only when enabled
				const module = await import('./gravsim_profiler.js');
				profilerInstance = new module.MainProfiler();
			} else {
				if (profilerInstance) {
					profilerInstance.destroy();
					profilerInstance = null;
				}
			}
		});
		this.ui.enableWorkerProfilerChk.addEventListener('change', async (e) => {
			const isEnabled = e.target.checked;
			EventBus.emit('debug:toggle-profiler', isEnabled);
		});
	}

	_onCenterChanged(e) {
		const targetId = parseInt(e.target.value, 10);
		const targetObj = this.universe.objects.find(obj => obj.id === targetId);
		if (targetObj) {
			EventBus.emit('camera:set-tracking-target', targetObj);
		}
	}

	updateCenterOptions() {
		const currentCenterId = this.ui.centerSelect.value;
		this.ui.centerSelect.innerHTML = '';

		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			// Keep existing selection if possible
			if (obj.id.toString() === currentCenterId) {
				option.selected = true;
			}
			this.ui.centerSelect.appendChild(option);
		}
	}

	setZoomScaleByStep(step) {
		let currentExp = this.universe.camera.targetZoomExp;
		const max = parseFloat(this.ui.zoomScale.max);
		const min = parseFloat(this.ui.zoomScale.min);

		currentExp += step;
		if (currentExp > max) { currentExp = max; }
		else if (currentExp < min) { currentExp = min; }

		EventBus.emit('camera:set-target-zoom-exp', currentExp);
		this.ui.zoomScale.value = currentExp.toFixed(2);
		this.updateZoomScaleIndicator(Math.pow(10, currentExp));
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
		EventBus.emit('simulation:set-time-scale-text', text);
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
		EventBus.emit('camera:set-zoom-text', text);
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
			const val = this.getTimeScale();
			EventBus.emit('simulation:set-time-scale', val);
			this.updateTimeScaleIndicator(val);
		}
		if (cpState.zoomScaleVal !== undefined) {
			this.ui.zoomScale.value = cpState.zoomScaleVal;
			EventBus.emit('camera:set-target-zoom-exp', cpState.zoomScaleVal);
			this.updateZoomScaleIndicator(Math.pow(10, cpState.zoomScaleVal));
		}
		this.updateCenterOptions();
	}
}
