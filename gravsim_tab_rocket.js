
// gravsim_tab_rocket.js

import { PHYSICS, RENDER, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS, ROCKET_FUELS } from './gravsim_const.js';
import { DOMUtils } from './gravsim_utils.js';

export class RocketTab {
	constructor(universe, systemTab) {
		this.universe = universe;
		this.systemTab = systemTab;
		this.previousTimeScaleVal = null;
		this.previousZoomScaleVal = null;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
		this._initElements();
		this._bindEvents();
		this.isOpened = false;

		// Subscribe to object list changes
		this.universe.on('object-list-changed', () => {
			this._updateRocketHostOptions();
		});
	}

	_initElements() {
		this.ui = {
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
			rlAutoControl: document.getElementById('rl-auto-control'),
			rlStatDv: document.getElementById('rl-stat-dv'),
			rlStatHostName: document.getElementById('rl-stat-host-name'),
			rlStatTwrY: document.getElementById('rl-stat-twr-y'),
			rlStatTwrX: document.getElementById('rl-stat-twr-x'),
			rlStatFuelType: document.getElementById('rl-stat-fuel-type'),
			rlStatFuelAmount: document.getElementById('rl-stat-fuel-amount'),
			rlStatFuelIsp: document.getElementById('rl-stat-fuel-isp'),
			rlStatFuelMaxBurn: document.getElementById('rl-stat-fuel-max-burn'),
			massSelect: document.getElementById('mass-select'),
			rlRolloutBtn: document.getElementById('rl-rollout-btn'),
			rlIgnitionGroup: document.getElementById('rl-ignition-group'),
			rlIgniteQuickBtn: document.getElementById('rl-ignite-quick-btn'),
			rlIgniteFullBtn: document.getElementById('rl-ignite-full-btn'),
			rlAbortBtn: document.getElementById('rl-abort-btn'),
		};
		DOMUtils.verifyElements(this.ui, 'RocketTab');
	}

	_bindEvents() {
		this.ui.rlModeSelect.addEventListener('change', (e) => {
			this.universe.RocketLauncher.mode = e.target.value;
			this.ui.rlHostOptions.style.display = e.target.value === 'host' ? 'block' : 'none';
			this._updateRocketStats();
		});
		this.ui.rlFuelType.addEventListener('change', (e) => {
			this.universe.RocketLauncher.fuelType = e.target.value;
			this._updateRocketStats();
		});
		this.ui.rlHostSelect.addEventListener('change', (e) => {
			const newHostId = parseInt(e.target.value, 10);
			this.universe.RocketLauncher.hostId = newHostId;
			this._setupLaunchEnvironment(newHostId);
			this._updateRocketStats();
		});
		this.ui.rlHostSelect.addEventListener('focus', () => {
			this._updateRocketStats();
		});
		this.ui.rlAutoControl.addEventListener('change', (e) => {
			this.universe.RocketLauncher.autoControl = e.target.checked;
		});
		if (this.ui.rlRolloutBtn) {
			this.ui.rlRolloutBtn.addEventListener('click', () => this.universe.RocketLauncher.rollout());
		}
		
		const triggerIgnite = (sequenceType) => {
			// Resume simulation to ensure physics worker runs during sequence
			this.universe.resumeSimulation();

			// Change system setting
			this.previousCameraTarget = null;
			this.previousTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
			this.previousZoomScaleVal = null;

			// Restore time & zoom scale & camera target
			this.restoreTimeScale();
			this.restoreZoomScale();
			this.restoreCameraTarget();

			this.universe.RocketLauncher.ignite(sequenceType);
		};

		if (this.ui.rlIgniteQuickBtn) {
			this.ui.rlIgniteQuickBtn.addEventListener('click', () => triggerIgnite('LEGACY_QUICK'));
		}
		if (this.ui.rlIgniteFullBtn) {
			this.ui.rlIgniteFullBtn.addEventListener('click', () => triggerIgnite('FULL_COUNTDOWN'));
		}
		if (this.ui.rlAbortBtn) {
			this.ui.rlAbortBtn.addEventListener('click', () => this.universe.RocketLauncher.abortRollout());
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

		this.ui.massSelect.addEventListener('change', () => this._updateRocketStats());

		document.addEventListener('rocket-preview-updated', () => {
			this._updateRocketStats();
		});
	}

	_updateRocketHostOptions() {
		const currentHostId = this.universe.RocketLauncher.hostId;
		this.ui.rlHostSelect.innerHTML = '';

		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			if (obj.id === currentHostId || (currentHostId === null && this.universe.centerObject && obj.id === this.universe.centerObject.id)) {
				option.selected = true;
				this.universe.RocketLauncher.hostId = obj.id;
			}
			this.ui.rlHostSelect.appendChild(option);
		}
	}

	_updateRocketStats() {
		const rl = this.universe.RocketLauncher;
		const objName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		
		const fuel = ROCKET_FUELS[rl.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * PHYSICS.G0;
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
			const localG = (PHYSICS.G * hostMassKg) / (rMeters * rMeters);
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

		this.universe.ObjectManager.centerObject = host;
		this.universe.cameraOffset = { x: 0, y: 0 };
		this.systemTab.updateCenterOptions();
		this.universe.InfoPanel.updateCamera(host.name);

		if (this.systemTab.ui.timeScale) {
			this.systemTab.ui.timeScale.value = this.systemTab.ui.timeScale.min;
			this.systemTab.updateTimeScaleIndicator(this.systemTab.getTimeScale());
		}

		if (this.systemTab.ui.zoomScale) {
			// Adjust zoom-level which the radius of the host is specific value
			const realRadiusPx = (host.radius / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / 2.2;
			let idealExp = Math.log10(targetSize / realRadiusPx);

			const maxZoom = parseFloat(this.systemTab.ui.zoomScale.max);
			const minZoom = parseFloat(this.systemTab.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));

			this.systemTab.ui.zoomScale.value = idealExp.toFixed(2);
			this.systemTab.updateZoomScaleIndicator(this.systemTab.getZoomScale());
			this.universe.updateZoomScale();
		}
	}

	open() {
		this.isOpened = true;

		// Pause simulation while setting up rocket
		this.universe.pauseSimulation();

		this.universe.RocketLauncher.togglePreview(true);

		// Save time & zoom scale & camera target
		this.saveTimeScale();
		this.saveZoomScale();
		this.saveCameraTarget();

		let targetHostId = this.universe.RocketLauncher.hostId;
		if (targetHostId === null || targetHostId === 0) { 
			const nonSunObjects = this.universe.objects.filter(o => o.id !== 0 && o.type === OBJECT_TYPES.CELESTIAL);
			if (nonSunObjects.length > 0) {
				targetHostId = Math.max(...nonSunObjects.map(o => o.id));
			} else {
				targetHostId = 0;
			}
			this.universe.RocketLauncher.hostId = targetHostId;
		}
		this._setupLaunchEnvironment(targetHostId);
		this._updateRocketStats();
	}

	close() {
		if (!this.isOpened) { return; }

		// Resume simulation when leaving rocket tab
		this.universe.resumeSimulation();

		this.universe.RocketLauncher.togglePreview(false);

		if (this.universe.RocketLauncher.rolloutedRocketId !== null || this.universe.LaunchSequencer.isActive) {
			this.previousCameraTarget = null;
			this.previousTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
			this.previousZoomScaleVal = null;
		}

		// Restore time & zoom scale & camera target
		this.restoreTimeScale();
		this.restoreZoomScale();
		this.restoreCameraTarget();

		this.isOpened = false;
	}

	saveTimeScale() {
		if (this.systemTab.ui.timeScale) {
			this.previousTimeScaleVal = this.systemTab.ui.timeScale.value;
		}
	}

	saveZoomScale() {
		if (this.systemTab.ui.zoomScale) {
			this.previousZoomScaleVal = this.systemTab.ui.zoomScale.value;
		}
	}

	saveCameraTarget() {
		if (this.universe.centerObject !== null) {
			this.previousCameraTarget = this.universe.centerObject;
			this.previousCameraOffset = { ...this.universe.cameraOffset };
		}
	}

	restoreTimeScale() {
		if (this.previousTimeScaleVal !== null && this.systemTab.ui.timeScale) {
			this.systemTab.ui.timeScale.value = this.previousTimeScaleVal;
			this.systemTab.updateTimeScaleIndicator(this.systemTab.getTimeScale());
			this.previousTimeScaleVal = null;
		}
	}

	restoreZoomScale() {
		if (this.previousZoomScaleVal !== null && this.systemTab.ui.zoomScale) {
			this.systemTab.ui.zoomScale.value = this.previousZoomScaleVal;
			this.systemTab.updateZoomScaleIndicator(this.systemTab.getZoomScale());
			this.universe.updateZoomScale();
			this.previousZoomScaleVal = null;
		}
	}

	restoreCameraTarget() {
		if (this.previousCameraTarget !== null) {
			// By pass setter to reset offset, unintentionally
			this.universe.ObjectManager.centerObject = this.previousCameraTarget;
			this.universe.cameraOffset = { ...this.previousCameraOffset };
			this.universe.ControlPanel.systemTab.updateCenterOptions();
			this.universe.InfoPanel.updateCamera(this.previousCameraTarget.name);

			this.previousCameraTarget = null;
			this.previousCameraOffset = null;
		}
	}

	setRolloutState(isRollouted) {
		const sliders = this.ui.rlModeSelect.closest('.tab-content').querySelectorAll('input[type="range"]');

		if (isRollouted) {
			if (this.ui.rlRolloutBtn) this.ui.rlRolloutBtn.style.display = 'none';
			if (this.ui.rlIgnitionGroup) this.ui.rlIgnitionGroup.style.display = 'flex';
			if (this.ui.rlAbortBtn) this.ui.rlAbortBtn.style.display = 'block';
			sliders.forEach(slider => slider.disabled = true);
			this.ui.rlModeSelect.disabled = true;
			this.ui.rlFuelType.disabled = true;
			this.ui.rlHostSelect.disabled = true;
			this.ui.rlAutoControl.disabled = true;
		} else {
			if (this.ui.rlRolloutBtn) this.ui.rlRolloutBtn.style.display = 'block';
			if (this.ui.rlIgnitionGroup) this.ui.rlIgnitionGroup.style.display = 'none';
			if (this.ui.rlAbortBtn) this.ui.rlAbortBtn.style.display = 'none';
			sliders.forEach(slider => slider.disabled = false);
			this.ui.rlModeSelect.disabled = false;
			this.ui.rlFuelType.disabled = false;
			this.ui.rlHostSelect.disabled = false;
			this.ui.rlAutoControl.disabled = false;
		}
	}

	loadState(rlState) {
		if (!rlState) { return; }
		if (rlState.mode) {
			this.ui.rlModeSelect.value = rlState.mode;
			this.ui.rlHostOptions.style.display = rlState.mode === 'host' ? 'block' : 'none';
		}
		
		this._updateRocketHostOptions(); 

		const updateSlider = (sliderId, valId, val) => {
			if (val === undefined || val === null) { return; }
			if (this.ui[sliderId]) { this.ui[sliderId].value = val; }
			if (this.ui[valId]) { this.ui[valId].textContent = val; }
		};

		updateSlider('rlHostAngle', 'rlHostAngleVal', rlState.hostAngleDeg);
		updateSlider('rlHostAlt', 'rlHostAltVal', rlState.hostAltitudeM);
		updateSlider('rlLaunchAngle', 'rlLaunchAngleVal', rlState.launchAngleDeg);
		updateSlider('rlLaunchMass', 'rlLaunchMassVal', rlState.dryMassT);
		updateSlider('rlLaunchThrust', 'rlLaunchThrustVal', rlState.thrustKN);
		updateSlider('rlFuelAmount', 'rlFuelAmountVal', rlState.fuelAmountT);
		if (rlState.fuelType) { this.ui.rlFuelType.value = rlState.fuelType; }
		updateSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', rlState.maxGLimit);

		if (rlState.autoControl !== undefined) {
			this.ui.rlAutoControl.checked = rlState.autoControl;
			this.universe.RocketLauncher.autoControl = rlState.autoControl;
		}

		this._updateRocketStats();
	}
}
