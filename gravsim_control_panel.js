
// gravsim_control_panel.js

import {
	DEFAULT_OBJECT_PARAMS, DISTANCE_SCALE,
	METERS_PER_AU, TIME_SCALE, G,
} from './gravsim_const.js';

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
		this.updateTimeScaleIndicator(this.getTimeScale());
		this.updateZoomScaleIndicator(this.getZoomScale());
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
			moonBtn: document.getElementById('put-moon-btn'),

			rlToggleBtn: document.getElementById('rl-toggle-btn'),
			rlSettings: document.getElementById('rl-settings'),
			rlModeSelect: document.getElementById('rl-mode-select'),
			rlHostOptions: document.getElementById('rl-host-options'),
			rlHostSelect: document.getElementById('rl-host-select'),

			rlHostAngle: document.getElementById('rl-host-angle'),
			rlHostAngleVal: document.getElementById('rl-host-angle-val'),
			rlHostAlt: document.getElementById('rl-host-alt'),
			rlHostAltVal: document.getElementById('rl-host-alt-val'),

			rlLaunchAngle: document.getElementById('rl-launch-angle'),
			rlLaunchAngleVal: document.getElementById('rl-launch-angle-val'),
			rlLaunchThrust: document.getElementById('rl-launch-thrust'),
			rlLaunchThrustVal: document.getElementById('rl-launch-thrust-val'),
			rlLaunchBurn: document.getElementById('rl-launch-burn'),
			rlLaunchBurnVal: document.getElementById('rl-launch-burn-val'),
			rlLaunchPayload: document.getElementById('rl-launch-payload'),
			rlLaunchPayloadVal: document.getElementById('rl-launch-payload-val'),

			rlStatDv: document.getElementById('rl-stat-dv'),
			rlStatHostName: document.getElementById('rl-stat-host-name'),
			rlStatTwrY: document.getElementById('rl-stat-twr-y'),
			rlStatTwrX: document.getElementById('rl-stat-twr-x'),

			rlExecuteBtn: document.getElementById('rl-execute-btn'),
		};

		// Map for dynamic button bindings
		this.deployButtons = {
			'put-neptune-btn': 'Neptune',
			'put-uranus-btn': 'Uranus',
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

		// Orbital deploy buttons
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

		// --- Rocket Launcher Events ---
		if (this.ui.rlToggleBtn) {
			this.ui.rlToggleBtn.addEventListener('click', () => {
				const rl = this.universe.RocketLauncher;
				rl.togglePreview();
				this.ui.rlSettings.style.display = rl.isActive ? 'block' : 'none';
				this.ui.rlToggleBtn.textContent = rl.isActive ? 'Disable Preview' : 'Enable Preview';
				if (rl.isActive) {
					this._updateRocketHostOptions();
					this._updateRocketStats();
				}
			});
		}

		if (this.ui.rlModeSelect) {
			this.ui.rlModeSelect.addEventListener('change', (e) => {
				this.universe.RocketLauncher.mode = e.target.value;
				this.ui.rlHostOptions.style.display = e.target.value === 'host' ? 'block' : 'none';
				if (e.target.value === 'host') { this._updateRocketHostOptions(); }
				this._updateRocketStats();
			});
		}

		// Helper to bind range inputs to RocketLauncher properties
		const bindSlider = (sliderId, valId, propName, isFloat = false) => {
			if (this.ui[sliderId]) {
				this.ui[sliderId].addEventListener('input', (e) => {
					const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
					this.universe.RocketLauncher[propName] = val;
					if (this.ui[valId]) {
						this.ui[valId].textContent = val;
					}
					this._updateRocketStats();
				});
			}
		};

		// Bind all Rocket Launcher sliders
		bindSlider('rlHostAngle', 'rlHostAngleVal', 'hostAngleDeg');
		bindSlider('rlHostAlt', 'rlHostAltVal', 'hostAltitudeM', true);
		bindSlider('rlLaunchAngle', 'rlLaunchAngleVal', 'launchAngleDeg');
		bindSlider('rlLaunchThrust', 'rlLaunchThrustVal', 'thrustKN');
		bindSlider('rlLaunchBurn', 'rlLaunchBurnVal', 'burnTime');
		bindSlider('rlLaunchPayload', 'rlLaunchPayloadVal', 'payloadRatio');

		if (this.ui.rlHostSelect) {
			this.ui.rlHostSelect.addEventListener('change', (e) => {
				this.universe.RocketLauncher.hostId = parseInt(e.target.value, 10);
				this._updateRocketStats();
			});
			this.ui.rlHostSelect.addEventListener('focus', () => {
				this._updateRocketHostOptions();
				this._updateRocketStats();
			});
		}

		const massSelect = document.getElementById('mass-select');
		if (massSelect) {
			massSelect.addEventListener('change', () => this._updateRocketStats());
		}

		document.addEventListener('rocket-preview-updated', () => {
			this._updateRocketStats();
		});

		if (this.ui.rlExecuteBtn) {
			this.ui.rlExecuteBtn.addEventListener('click', () => {
				this.universe.RocketLauncher.executeLaunch();
				this.ui.rlSettings.style.display = 'none';
				this.ui.rlToggleBtn.textContent = 'Enable Preview';
			});
		}
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

	_updateRocketHostOptions() {
		if (!this.ui.rlHostSelect) return;

		const currentHostId = this.universe.RocketLauncher.hostId;
		this.ui.rlHostSelect.innerHTML = '';

		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			if (obj.id === currentHostId || (currentHostId === null && obj.id === this.universe.centerObject.id)) {
				option.selected = true;
				this.universe.RocketLauncher.hostId = obj.id;
			}
			this.ui.rlHostSelect.appendChild(option);
		}
	}

	_updateRocketStats() {
		if (!this.ui.rlStatDv || !this.ui.rlStatTwrY) { return; }

		const rl = this.universe.RocketLauncher;
		const massName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[massName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		
		const m0 = param.MASS * 1e3; // Initial mass in kg
		const mf = m0 * (rl.payloadRatio / 100);
		
		// Calculate Delta-v using Tsiolkovsky rocket equation
		let dvKmS = 0;
		if (rl.burnTime > 0 && rl.payloadRatio < 100 && rl.thrustKN > 0) {
			const mDot = (m0 - mf) / rl.burnTime;
			const F = rl.thrustKN * 1e3;
			dvKmS = ((F / mDot) * Math.log(m0 / mf)) / 1000;
		} else if (rl.thrustKN > 0 && rl.payloadRatio === 100) {
			dvKmS = ((rl.thrustKN * 1e3 / m0) * rl.burnTime) / 1000;
		}

		// Calculate Local Gravity and Direction
		let host;
		let upAngleRad = 0;
		let rMeters = 0;

		if (rl.mode === 'host') {
			host = this.universe.objects.find(o => o.id === rl.hostId) || this.universe.centerObject;
			if (host) {
				upAngleRad = rl.hostAngleDeg * (Math.PI / 180);
				rMeters = host.radius + (param.RADIUS || 1) + rl.hostAltitudeM;
			}
		} else {
			// Center Object is regarded as host
			host = this.universe.centerObject;
			if (host) {
				const dx = rl.freeX - host.x;
				const dy = rl.freeY - host.y;
				upAngleRad = Math.atan2(dy, dx);
				const distPx = Math.sqrt(dx * dx + dy * dy);
				rMeters = this.universe.pix2m(distPx);
			}
		}

		let twrY = 0;
		let twrX = 0;
		let hostName = "Unknown";

		// Calculate Vector TWR
		if (host && rMeters > 0) {
			hostName = host.name;
			const hostMassKg = host.mass * 1e3;
			
			// Calculate local gravity (g = GM / r^2)
			const localG = (G * hostMassKg) / (rMeters * rMeters);
			const weightN = m0 * localG;
			const thrustN = rl.thrustKN * 1e3;

			// Transform thrust vector to relative degree
			const thrustAngleRad = rl.launchAngleDeg * (Math.PI / 180);
			const relAngleRad = thrustAngleRad - upAngleRad;

			const thrustY = thrustN * Math.cos(relAngleRad);
			const thrustX = thrustN * Math.sin(relAngleRad);

			twrY = thrustY / weightN;
			twrX = thrustX / weightN;
		}

		this.ui.rlStatDv.textContent = dvKmS.toFixed(2);
		this.ui.rlStatHostName.textContent = hostName;
		this.ui.rlStatTwrY.textContent = twrY.toFixed(2);
		this.ui.rlStatTwrX.textContent = twrX.toFixed(2);
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
	}

	updateZoomScaleIndicator(val) {
		if (!this.ui.zoomIndicator) return;

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
