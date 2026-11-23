
// gravsim_tab_system.js

import { PHYSICS, RENDER, SIMULATION, UI } from './gravsim_const.js';
import { DOMUtils, isLiveObject } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class SystemTab {
	constructor(universe) {
		this.universe = universe;
		this.isDebugModeEnabled = false;
		/**
		 * The time-scale exponent last applied by code and the slider step it showed then (getTimeScaleExp).
		 * @type {{ exp: number, sliderValue: string } | null}
		 */
		this._exactTimeScale = null;
		this._initElements();
		this._bindEvents();

		// Subscribe to object list changes
		EventBus.on('object-list-changed', () => {
			this.updateCenterOptions();
		});

		// Subscribe to camera tracking changes to update dropdown UI
		const onTargetUpdated = (targetObj) => {
			if (targetObj) {
				this.ui.centerSelect.value = String(targetObj.id);

				this.updateTimeScaleIndicator(this.getTimeScale());

				// Setup initial zoom indicator based on camera target
				this.updateZoomScaleIndicator(Math.pow(10, this.universe.camera.targetZoomExp));
			}
		};
		EventBus.on('camera:set-tracking-target', onTargetUpdated);
		EventBus.on('camera:target-changed', onTargetUpdated);
		EventBus.on('camera:set-auto-tracking', (target) => onTargetUpdated(target));
	}

	_initElements() {
		/** @type {Record<string, any>} */
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
			predDuration: document.getElementById('pred-duration'),
			predDurationVal: document.getElementById('pred-duration-val'),
			showPredictedPathChk: document.getElementById('show-predicted-path-chk'),
			showActualPathChk: document.getElementById('show-actual-path-chk'),
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
			// The user moved the slider: its value is the time scale again
			this._exactTimeScale = null;
			const val = this.getTimeScale();
			EventBus.emit('simulation:set-time-scale', val);
			this.updateTimeScaleIndicator(val);
		});

		this.ui.zoomScale.addEventListener('input', (/** @type {any} */ e) => {
			const exp = parseFloat(e.target.value);
			EventBus.emit('camera:set-target-zoom-exp', exp);
			this.updateZoomScaleIndicator(Math.pow(10, exp));
		});

		this.ui.centerSelect.addEventListener('change', (/** @type {any} */ e) => this._onCenterChanged(e));

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
		this.ui.trailLength.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			DOMUtils.setText(this.ui.trailLengthVal, val.toFixed(1));
			this.universe.trailLengthAU = val;
		});

		this.ui.predDuration.addEventListener('input', (/** @type {any} */ e) => {
			const months = parseFloat(e.target.value);
			const sec = months * (365.25 / 12) * 86400;
			this.universe.RocketLauncher.predictionDurationMonths = months;
			this.universe.RocketLauncher.maxSimTimeSec = sec;
			if (this.universe.RocketLauncher.requestPreviewUpdate) {
				this.universe.RocketLauncher.requestPreviewUpdate();
			}

			this._showPredictionDurationLabel(months);
		});

		// The prediction period changed elsewhere (a mission / vehicle / payload applied in the Rocket tab):
		// show the launcher's value without re-applying it
		EventBus.on('ui:sync-prediction-duration', (months) => this.syncPredictionDuration(months));

		this.ui.showLabelsChk.addEventListener('change', (/** @type {any} */ e) => {
			EventBus.emit('render:set-labels-visible', e.target.checked);
		});

		this.ui.showPredictedPathChk.addEventListener('change', (/** @type {any} */ e) => {
			EventBus.emit('render:set-show-predicted-path', e.target.checked);
		});

		this.ui.showActualPathChk.addEventListener('change', (/** @type {any} */ e) => {
			EventBus.emit('render:set-show-actual-path', e.target.checked);
		});

		// Synchronize checkboxes if toggled externally (e.g. from Telemetry HUD)
		EventBus.on('render:set-show-predicted-path', (visible) => {
			if (this.ui.showPredictedPathChk.checked !== visible) {
				this.ui.showPredictedPathChk.checked = visible;
			}
		});

		EventBus.on('render:set-show-actual-path', (visible) => {
			if (this.ui.showActualPathChk.checked !== visible) {
				this.ui.showActualPathChk.checked = visible;
			}
		});

		this.ui.showDebugChk.addEventListener('change', (/** @type {any} */ e) => {
			EventBus.emit('render:set-debug-visible', e.target.checked);
		});

		// Bind Audio Selection
		this.ui.audioVoiceSelect.addEventListener('change', (/** @type {any} */ e) => {
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

		// A time-scale exponent set by code (real time for a launch, the Rocket tab's restore): applied exactly, the
		// slider shows the nearest step (design §4.13-20). A value that is not a finite number changes nothing.
		EventBus.on('ui:set-time-scale', (val) => {
			if (!SystemTab.isFiniteNumber(val)) { return; }
			this.applyTimeScaleExp(this._clampToSlider(this.ui.timeScale, val));
		});

		EventBus.on('ui:set-time-scale-min', () => {
			this._exactTimeScale = null;
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

		this.ui.enableMainProfilerChk.addEventListener('change', async (/** @type {any} */ e) => {
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
		this.ui.enableWorkerProfilerChk.addEventListener('change', async (/** @type {any} */ e) => {
			const isEnabled = e.target.checked;
			EventBus.emit('debug:toggle-profiler', isEnabled);
		});
	}

	/** @param {any} e */
	_onCenterChanged(e) {
		const targetId = parseInt(e.target.value, 10);
		const targetObj = this.universe.objects.find(obj => obj.id === targetId && isLiveObject(obj));
		if (targetObj) {
			EventBus.emit('camera:set-tracking-target', targetObj);
		}
	}

	updateCenterOptions() {
		const targetId = (this.universe.camera && this.universe.camera.trackingTarget)
			? this.universe.camera.trackingTarget.id.toString()
			: this.ui.centerSelect.value;
		this.ui.centerSelect.innerHTML = '';

		// The objects in the simulation: a removed one stays listed until its trail has faded, and the camera leaves it at
		// once (design §4.13-31)
		for (const obj of this.universe.objects) {
			if (!isLiveObject(obj)) { continue; }
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			// Select active tracking target or fallback
			if (obj.id.toString() === targetId) {
				option.selected = true;
			}
			this.ui.centerSelect.appendChild(option);
		}

		if (targetId) {
			this.ui.centerSelect.value = targetId;
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

	/**
	 * The time-scale exponent the simulation runs at (log10 of the simulated years per second, the unit of the
	 * #time-scale slider). The slider has a 0.1 step, and a browser rounds a value written to a range input to the
	 * nearest step, so the slider cannot hold real time (log10(1 / (365.25 x 86400)) = -7.4991..., which it shows as
	 * -7.5, 0.998 s per s). A value applied by code (applyTimeScaleExp) is therefore kept here and is the time scale as
	 * long as the slider still shows the step it was given; moving the slider (or writing another value to it) makes the
	 * slider's value the time scale again (design §4.13-20).
	 * @returns {number}
	 */
	getTimeScaleExp() {
		const exact = this._exactTimeScale;
		if (exact && exact.sliderValue === String(this.ui.timeScale.value)) { return exact.exp; }
		return parseFloat(this.ui.timeScale.value);
	}

	getTimeScale() {
		return Math.pow(10, this.getTimeScaleExp());
	}

	/**
	 * Run the simulation at the time-scale exponent `exp` exactly (a finite number within the slider range): the slider
	 * shows the nearest step, the indicator the exact value.
	 * @param {number} exp
	 */
	applyTimeScaleExp(exp) {
		this.ui.timeScale.value = String(exp);
		this._exactTimeScale = { exp, sliderValue: String(this.ui.timeScale.value) };
		const val = Math.pow(10, exp);
		EventBus.emit('simulation:set-time-scale', val);
		this.updateTimeScaleIndicator(val);
	}

	getZoomScale() {
		const exp = parseFloat(this.ui.zoomScale.value);
		return Math.pow(10, exp);
	}

	getZoomStep() {
		return parseFloat(this.ui.zoomScale.step) || 0.1;
	}

	/**
	 * Label of the prediction-period slider.
	 * @param {number} months
	 * @returns {string}
	 */
	static formatSimDuration(months) {
		if (months < 12) {
			const days = Math.round(months * (365.25 / 12));
			return `${months} mo (${days} d)`;
		} else {
			const yrs = (months / 12).toFixed(1);
			return `${yrs} yr (${months} mo)`;
		}
	}

	/**
	 * Show the prediction period in use (RocketLauncher.predictionDurationMonths) on the slider and its label. Display
	 * only: the launcher value is not changed (the slider clamps its own position to its range, the label shows the value).
	 * @param {number} [months] defaults to the launcher's value
	 */
	syncPredictionDuration(months = this.universe?.RocketLauncher?.predictionDurationMonths) {
		if (typeof months !== 'number' || !Number.isFinite(months) || months <= 0) { return; }
		this._setSliderValue(this.ui.predDuration, months);
		this._showPredictionDurationLabel(months);
	}

	/**
	 * The one writer of the prediction-period label (the slider handler and syncPredictionDuration).
	 * @param {number} months
	 */
	_showPredictionDurationLabel(months) {
		this.ui.predDurationVal.textContent = SystemTab.formatSimDuration(months);
	}

	/**
	 * `value` clamped to the min / max of a range input (a bound that is not a number is ignored).
	 * @param {any} slider
	 * @param {number} value
	 * @returns {number}
	 */
	_clampToSlider(slider, value) {
		const min = parseFloat(slider.min);
		const max = parseFloat(slider.max);
		let v = value;
		if (Number.isFinite(min)) { v = Math.max(min, v); }
		if (Number.isFinite(max)) { v = Math.min(max, v); }
		return v;
	}

	/**
	 * Set a range input to `value` clamped to its min / max and return the value it holds afterwards.
	 * @param {any} slider
	 * @param {number} value
	 * @returns {number}
	 */
	_setSliderValue(slider, value) {
		const v = this._clampToSlider(slider, value);
		slider.value = String(v);
		const applied = parseFloat(slider.value);
		return Number.isFinite(applied) ? applied : v;
	}

	getState() {
		return {
			// The exponent the simulation runs at (real time is saved as itself, not as the slider step it shows)
			timeScaleVal: this.getTimeScaleExp(),
			zoomScaleVal: parseFloat(this.ui.zoomScale.value),
		};
	}

	/**
	 * Validate a saved view state (getState()): only finite numbers are kept (a corrupted or missing value is null,
	 * which keeps the current one) and they are clamped to the slider ranges.
	 * @param {{ timeScaleVal?: any, zoomScaleVal?: any } | null | undefined} cpState
	 * @returns {{ timeScaleVal: number | null, zoomScaleVal: number | null }}
	 */
	normalizeViewState(cpState) {
		const src = (cpState && typeof cpState === 'object') ? cpState : {};
		return {
			timeScaleVal: SystemTab.isFiniteNumber(src.timeScaleVal) ? this._clampToSlider(this.ui.timeScale, src.timeScaleVal) : null,
			zoomScaleVal: SystemTab.isFiniteNumber(src.zoomScaleVal) ? this._clampToSlider(this.ui.zoomScale, src.zoomScaleVal) : null
		};
	}

	/**
	 * Apply a view state from normalizeViewState(): the simulation runs at the saved time scale exactly (the slider shows
	 * the nearest step, as for real time); the camera receives the zoom the slider holds.
	 * @param {{ timeScaleVal: number | null, zoomScaleVal: number | null }} view
	 */
	applyViewState(view) {
		if (view.timeScaleVal !== null) {
			this.applyTimeScaleExp(this._clampToSlider(this.ui.timeScale, view.timeScaleVal));
		}
		if (view.zoomScaleVal !== null) {
			const exp = this._setSliderValue(this.ui.zoomScale, view.zoomScaleVal);
			EventBus.emit('camera:set-target-zoom-exp', exp);
			this.updateZoomScaleIndicator(Math.pow(10, exp));
		}
	}

	/**
	 * @param {any} v
	 * @returns {v is number}
	 */
	static isFiniteNumber(v) {
		return typeof v === 'number' && Number.isFinite(v);
	}
}
