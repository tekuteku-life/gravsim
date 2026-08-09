
// gravsim_control_panel.js

import {
	DEFAULT_OBJECT_PARAMS, ROCKET_FUELS, DISTANCE_SCALE,
	METERS_PER_AU, TIME_SCALE, G, G0,
	UI_NAVI_UPDATE_UPDATE_INTERVAL,
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

		this._updateNaviStats();
		this._updateNaviTargetOptions();
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

			mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
			ctrlPanel: document.getElementById('ctrl-panel'),
			tabBtns: document.querySelectorAll('.tab-btn'),
			tabContents: document.querySelectorAll('.tab-content'),

			rlModeSelect: document.getElementById('rl-mode-select'),
			rlHostOptions: document.getElementById('rl-host-options'),
			rlHostSelect: document.getElementById('rl-host-select'),

			rlHostAngle: document.getElementById('rl-host-angle'),
			rlHostAngleVal: document.getElementById('rl-host-angle-val'),
			rlHostAlt: document.getElementById('rl-host-alt'),
			rlHostAltVal: document.getElementById('rl-host-alt-val'),

			rlLaunchAngle: document.getElementById('rl-launch-angle'),
			rlLaunchAngleVal: document.getElementById('rl-launch-angle-val'),
			rlLaunchMass: document.getElementById('rl-launch-mass'),
			rlLaunchMassVal: document.getElementById('rl-launch-mass-val'),
			rlFuelType: document.getElementById('rl-fuel-type'),
			rlFuelAmount: document.getElementById('rl-fuel-amount'),
			rlFuelAmountVal: document.getElementById('rl-fuel-amount-val'),
			rlLaunchThrust: document.getElementById('rl-launch-thrust'),
			rlLaunchThrustVal: document.getElementById('rl-launch-thrust-val'),
			
			rlLaunchMaxG: document.getElementById('rl-launch-maxg'),
			rlLaunchMaxGVal: document.getElementById('rl-launch-maxg-val'),

			rlStatDv: document.getElementById('rl-stat-dv'),
			rlStatHostName: document.getElementById('rl-stat-host-name'),
			rlStatTwrY: document.getElementById('rl-stat-twr-y'),
			rlStatTwrX: document.getElementById('rl-stat-twr-x'),
			rlStatFuelType: document.getElementById('rl-stat-fuel-type'),
			rlStatFuelAmount: document.getElementById('rl-stat-fuel-amount'),
			rlStatFuelIsp: document.getElementById('rl-stat-fuel-isp'),
			rlStatFuelMaxBurn: document.getElementById('rl-stat-fuel-max-burn'),

			rlExecuteBtn: document.getElementById('rl-execute-btn'),
			
			// Navi Tab
			nvTargetSelect: document.getElementById('nv-target-select'),
			nvMass: document.getElementById('nv-mass'),
			nvRadius: document.getElementById('nv-radius'),
			nvSurfaceG: document.getElementById('nv-surface-g'),
			nvEscapeV: document.getElementById('nv-escape-v'),
			nvRefBody: document.getElementById('nv-ref-body'),
			nvAlt: document.getElementById('nv-alt'),
			nvVel: document.getElementById('nv-vel'),
			nvAtmAlt: document.getElementById('nv-atm-alt'),
			nvAtmRho: document.getElementById('nv-atm-rho'),
			nvAtmScale: document.getElementById('nv-atm-scale'),
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

		// --- Mobile Menu Toggle ---
		if (this.ui.mobileMenuToggle) {
			this.ui.mobileMenuToggle.addEventListener('click', () => {
				this.ui.ctrlPanel.classList.toggle('open');
			});
		}

		// --- Tab Navigation Events ---
		if (this.ui.tabBtns) {
			this.ui.tabBtns.forEach(btn => {
				btn.addEventListener('click', (e) => {
					// Remove active class from all tabs
					this.ui.tabBtns.forEach(b => b.classList.remove('active'));
					this.ui.tabContents.forEach(c => c.classList.remove('active'));

					// Add active class to clicked tab
					const targetId = e.target.getAttribute('data-target');
					e.target.classList.add('active');
					document.getElementById(targetId).classList.add('active');

					// Special process for Rocket Launch tab opend
					if (targetId === 'tab-rocket') {
						this.universe.RocketLauncher.togglePreview(true);
						
						let targetHostId = this.universe.RocketLauncher.hostId;
						if (targetHostId === null || targetHostId === 0) { 
							const nonSunObjects = this.universe.objects.filter(o => o.id !== 0);
							if (nonSunObjects.length > 0) {
								targetHostId = Math.max(...nonSunObjects.map(o => o.id));
							} else {
								targetHostId = 0;
							}
							this.universe.RocketLauncher.hostId = targetHostId;
						}
						this._updateRocketHostOptions();
						this._setupLaunchEnvironment(targetHostId);
						this._updateRocketStats();
					} else {
						// Close tab except for Rocket tab
						this.universe.RocketLauncher.togglePreview(false);
					}
				});
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

		if (this.ui.rlFuelType) {
			this.ui.rlFuelType.addEventListener('change', (e) => {
				this.universe.RocketLauncher.fuelType = e.target.value;
				this._updateRocketStats();
			});
		}
		if (this.ui.rlHostSelect) {
			this.ui.rlHostSelect.addEventListener('change', (e) => {
				const newHostId = parseInt(e.target.value, 10);
				this.universe.RocketLauncher.hostId = newHostId;
				this._setupLaunchEnvironment(newHostId);
				this._updateRocketStats();
			});
			this.ui.rlHostSelect.addEventListener('focus', () => {
				this._updateRocketHostOptions();
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
		bindSlider('rlLaunchMass', 'rlLaunchMassVal', 'dryMassT');
		bindSlider('rlFuelAmount', 'rlFuelAmountVal', 'fuelAmountT');
		bindSlider('rlLaunchThrust', 'rlLaunchThrustVal', 'thrustKN');
		bindSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', 'maxGLimit', true);

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

		
		if (this.ui.nvTargetSelect) {
			this.ui.nvTargetSelect.addEventListener('change', (e) => {
				this.naviTargetId = parseInt(e.target.value, 10);
				this._updateNaviStats();
			});
			this.ui.nvTargetSelect.addEventListener('focus', () => {
				this._updateNaviTargetOptions();
			});
		}

		// Update Navi stats periodically if active
		setInterval(() => {
			const naviTab = document.getElementById('tab-navi');
			if (naviTab && naviTab.classList.contains('active')) {
				this._updateNaviStats();
			}
		}, UI_NAVI_UPDATE_UPDATE_INTERVAL);

		document.addEventListener('rocket-preview-updated', () => {
			this._updateRocketStats();
		});

		if (this.ui.rlExecuteBtn) {
			this.ui.rlExecuteBtn.addEventListener('click', () => {
				this.universe.RocketLauncher.executeLaunch();

				const sysTabBtn = document.querySelector('.tab-btn[data-target="tab-sys"]');
				if (sysTabBtn) {
					sysTabBtn.click();
				}
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

	updateNaviTab() {
		this._updateNaviStats();
		this._updateNaviTargetOptions();
	}

	_updateNaviTargetOptions() {
		if (!this.ui.nvTargetSelect) { return; }

		const currentId = this.naviTargetId;
		this.ui.nvTargetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			if (obj.id === currentId || (currentId === undefined && this.universe.centerObject && obj.id === this.universe.centerObject.id)) {
				option.selected = true;
				this.naviTargetId = obj.id;
			}
			this.ui.nvTargetSelect.appendChild(option);
		}
	}

	_updateNaviStats() {
		let target = this.universe.objects.find(o => o.id === this.naviTargetId);
		if (!target) {
			target = this.universe.centerObject;
			if(target) this.naviTargetId = target.id;
			else return;
		}

		this.ui.nvMass.innerText = target.mass.toExponential(2) + " t";
		this.ui.nvRadius.innerText = (target.radius/1000).toLocaleString('en-US') + " km";

		const surfaceG_ms2 = (G * (target.mass*1e3)) / (target.radius * target.radius);
		this.ui.nvSurfaceG.innerText = (surfaceG_ms2 / G0).toFixed(2) + " G (" + surfaceG_ms2.toFixed(2) + " m/s²)";

		const escapeV = Math.sqrt(2 * G * (target.mass*1e3) / target.radius);
		this.ui.nvEscapeV.innerText = (escapeV/1000).toFixed(2) + " km/s";

		let refBody = null;
		let maxG = -1;
		let distToRefM = 0;
		for (const obj of this.universe.objects) {
			if (obj.id === target.id) { continue; }
			const dx = target.x - obj.x;
			const dy = target.y - obj.y;
			const distSqPx = dx * dx + dy * dy;
			const distSqM = Math.pow(this.universe.pix2m(Math.sqrt(distSqPx)), 2);
			if (distSqM === 0) { continue; }
			const gForce = obj.mass / distSqM;
			if (gForce > maxG) {
				maxG = gForce;
				refBody = obj;
				distToRefM = Math.sqrt(distSqM);
			}
		}

		if (refBody) {
			this.ui.nvRefBody.innerText = refBody.name;
			this.ui.nvAlt.innerText = ((distToRefM - refBody.radius)/1000).toLocaleString('en-US', {maximumFractionDigits:0}) + " km";
			const vx = this.universe.pix2m(target.vx - refBody.vx);
			const vy = this.universe.pix2m(target.vy - refBody.vy);
			this.ui.nvVel.innerText = (Math.sqrt(vx*vx + vy*vy)/1000).toFixed(2) + " km/s";
		} else {
			this.ui.nvRefBody.innerText = "NONE";
			this.ui.nvAlt.innerText = "--- km";
			this.ui.nvVel.innerText = "--- km/s";
		}

		const param = DEFAULT_OBJECT_PARAMS[target.name];
		if (param && param.ATM_LIMIT_ALT) {
			this.ui.nvAtmAlt.innerText = (param.ATM_LIMIT_ALT/1000).toLocaleString() + " km";
			this.ui.nvAtmRho.innerText = param.ATM_DENSITY_0.toLocaleString() + " kg/m³";
			this.ui.nvAtmScale.innerText = param.ATM_SCALE_HEIGHT.toLocaleString() + " m";
		} else {
			this.ui.nvAtmAlt.innerText = "--- km";
			this.ui.nvAtmRho.innerText = "--- kg/m³";
			this.ui.nvAtmScale.innerText = "--- m";
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
		const objName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		
		const fuel = ROCKET_FUELS[rl.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * G0;
		const m0 = (rl.dryMassT + rl.fuelAmountT) * 1e3;
		const mf = rl.dryMassT * 1e3;
		
		const massFlowRateKgS = (rl.thrustKN * 1e3) / ve;
		const maxBurnTime = massFlowRateKgS > 0 ? (rl.fuelAmountT * 1e3) / massFlowRateKgS : 0;
		
		let dvKmS = 0;
		if (maxBurnTime > 0 && rl.thrustKN > 0) {
			dvKmS = (ve * Math.log(m0 / mf)) / 1000;
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
			const weightN = (rl.dryMassT + rl.fuelAmountT) * 1e3 * localG;
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

		if (rl.fuelAmountT > 0 && fuel) {
			this.ui.rlStatFuelType.textContent = fuel.name;
			this.ui.rlStatFuelAmount.textContent = rl.fuelAmountT.toLocaleString();
			this.ui.rlStatFuelIsp.textContent = fuel.isp;
			this.ui.rlStatFuelMaxBurn.textContent = maxBurnTime.toFixed(1);
		}
	}

	_setupLaunchEnvironment(hostId) {
		const host = this.universe.objects.find(o => o.id === hostId);
		if (!host) return;

		this.universe.centerObject = host;
		this.updateCenterOptions();

		if (this.ui.timeScale) {
			this.ui.timeScale.value = this.ui.timeScale.min;
			this.updateTimeScaleIndicator(this.getTimeScale());
		}

		if (this.ui.zoomScale) {
			// Adjust zoom-level which the radius of the host is specific value
			const realRadiusPx = (host.radius / METERS_PER_AU) * DISTANCE_SCALE;
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / 2.2;
			let idealExp = Math.log10(targetSize / realRadiusPx);

			const maxZoom = parseFloat(this.ui.zoomScale.max);
			const minZoom = parseFloat(this.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));

			this.ui.zoomScale.value = idealExp.toFixed(2);
			this.updateZoomScaleIndicator(this.getZoomScale());
			this.universe.updateZoomScale();
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
		this.universe.InfoPanel.updateZoomScale(text);
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

	getState() {
		return {
			timeScaleVal: this.ui.timeScale ? parseFloat(this.ui.timeScale.value) : -1,
			zoomScaleVal: this.ui.zoomScale ? parseFloat(this.ui.zoomScale.value) : 0,
		};
	}

	loadState(cpState, rlState) {
		if (!cpState) return;

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

		if (rlState) {
			if (rlState.mode && this.ui.rlModeSelect) {
				this.ui.rlModeSelect.value = rlState.mode;
				this.ui.rlHostOptions.style.display = rlState.mode === 'host' ? 'block' : 'none';
			}
			
			this._updateRocketHostOptions(); 

			const updateSlider = (sliderId, valId, val) => {
				if (val === undefined || val === null) return;
				if (this.ui[sliderId]) this.ui[sliderId].value = val;
				if (this.ui[valId]) this.ui[valId].textContent = val;
			};

			updateSlider('rlHostAngle', 'rlHostAngleVal', rlState.hostAngleDeg);
			updateSlider('rlHostAlt', 'rlHostAltVal', rlState.hostAltitudeM);
			updateSlider('rlLaunchAngle', 'rlLaunchAngleVal', rlState.launchAngleDeg);
			updateSlider('rlLaunchMass', 'rlLaunchMassVal', rlState.dryMassT);
			updateSlider('rlLaunchThrust', 'rlLaunchThrustVal', rlState.thrustKN);
			updateSlider('rlFuelAmount', 'rlFuelAmountVal', rlState.fuelAmountT);
			if (this.ui.rlFuelType && rlState.fuelType) { this.ui.rlFuelType.value = rlState.fuelType; }
			updateSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', rlState.maxGLimit);

			this._updateRocketStats();
		}
	}
}
